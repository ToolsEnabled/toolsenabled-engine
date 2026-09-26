#!/usr/bin/env node
'use strict';

// Only the owned native controller launches this Linux administrative boundary.
// Requests use a private bounded pipe; stdout contains no grant or private key.
const path = require('node:path');
const crypto = require('node:crypto');
const { createAdministrativeEnrollment, validatedContext, IDENTITY_KEY, safeFailure } = require('../src/lib/online-fra-admin-enrollment');
async function main() {
  if (process.platform !== 'linux') throw Object.assign(new Error(), { code: 'ADMIN_PLATFORM_UNSUPPORTED' });
  if (process.argv.length !== 2) throw Object.assign(new Error(), { code: 'ADMIN_INPUT_INVALID' });
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw Object.assign(new Error(), { code: 'ADMIN_INPUT_INVALID' });
    chunks.push(chunk);
  }
  let input;
  try {
    const raw = Buffer.concat(chunks).toString('utf8').trim(); input = JSON.parse(raw);
    if (JSON.stringify(input) !== raw) throw new Error();
  }
  catch { throw Object.assign(new Error(), { code: 'ADMIN_INPUT_INVALID' }); }
  const actions = { identity: ['version', 'action', 'context'], prepare: ['version', 'action', 'context'], import: ['version', 'action', 'context', 'reply'],
    finalize: ['version', 'action', 'context', 'reply'], resume: ['version', 'action', 'context'],
    cancel: ['version', 'action', 'context'], 'pair-request': ['version', 'action', 'context', 'webDriveEnabled', 'capabilityDigest'] };
  if (input?.version !== 1 || !Object.hasOwn(actions, input.action)
      || Object.keys(input).sort().join(',') !== actions[input.action].sort().join(',')) throw Object.assign(new Error(), { code: 'ADMIN_INPUT_INVALID' });
  const stateRoot = process.env.TOOLSENABLED_STATE_ROOT;
  // Both sides of this comparison now come from src/lib/vault-location.js: the
  // left is where this process is pointed, the right is where THIS installation
  // keeps its vault (vaultReaderContext pins the state root and ignores an
  // ambient override). Building the right side by hand repeated the authority's
  // layout rule in a second place, which is the drift this boundary cannot
  // afford. stateRoot is already known non-empty and absolute by the two
  // clauses before it, which is what vaultReaderContext requires.
  const vaultLocation = require('../src/lib/vault-location');
  if (!stateRoot || !path.isAbsolute(stateRoot)
      || vaultLocation.vaultPath() !== vaultLocation.vaultReaderContext(path.resolve(stateRoot)).location.file) {
    throw Object.assign(new Error(), { code: 'ADMIN_CONTEXT_MISMATCH' });
  }
  const linux = require('../src/lib/vault-linux');
  if (input.action === 'identity') {
    if (input.context?.publicKey !== null) throw Object.assign(new Error(), { code: 'ADMIN_INPUT_INVALID' });
    const key = crypto.createPrivateKey(linux.get(IDENTITY_KEY));
    if (key.asymmetricKeyType !== 'ed25519') throw Object.assign(new Error(), { code: 'ADMIN_IDENTITY_MISMATCH' });
    const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64url');
    validatedContext({ ...input.context, publicKey }, stateRoot);
    return { ok: true, stage: 'identity', publicKey };
  }
  const admin = createAdministrativeEnrollment({ context: input.context, stateRoot,
    vault: { getIdentity: key => linux.get(key), operation: fields => linux.adminDeviceOperation(fields) } });
  const answer = input.action === 'import' ? admin.importGrant(input.reply)
    : input.action === 'finalize' ? admin.finalize(input.reply)
      : input.action === 'pair-request' ? admin.pairRequest(input) : admin[input.action]();
  return answer;
}
main().then(async answer => {
  try { await require('../src/lib/linux-vault-host-client').close(); }
  catch { throw Object.assign(new Error(), { code: 'ADMIN_VAULT_FAILED', mutationOutcome: 'UNCERTAIN' }); }
  process.stdout.write(JSON.stringify(answer) + '\n');
}).catch(async error => {
  try { await require('../src/lib/linux-vault-host-client').close(); }
  catch { error = Object.assign(new Error(), { code: 'ADMIN_VAULT_FAILED', mutationOutcome: 'UNCERTAIN' }); }
  process.stdout.write(JSON.stringify(safeFailure(error)) + '\n'); process.exitCode = 1;
});
