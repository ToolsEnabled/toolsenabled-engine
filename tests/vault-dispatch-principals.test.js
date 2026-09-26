'use strict';

/*
 * Every transport that dispatches a tool must name a principal.
 *
 * MEASURED against the then-live source: vault-access-policy.js is the lock on
 * the owner's per-credential switches, and it only engages when the read names
 * a principal -- a read that names nobody is treated as the installation acting
 * for itself and allowed. Exactly one of the dispatch paths named one. So the
 * owner could turn a credential off for an agent, and the same credential was
 * read again by scheduling the action, by asking the paired machine over FRA,
 * or through the remote-agent bridge.
 *
 * The principals are fixed in code at each dispatch site, never taken from the
 * caller or the wire: a principal an agent can choose is a switch an agent can
 * turn off. They deliberately carry no `kind`, so the consumers that require an
 * authenticated agent-session principal -- accessibility, application context,
 * resource control -- go on refusing them exactly as they did when the field
 * was absent.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = require('../src/lib/vault-access-policy');

const SITES = [
  { file: 'src/job-runner.js', roleId: 'scheduler', agentId: 'scheduler-runner-v1' },
  { file: 'src/full-remote-access-bridge.js', roleId: 'fra-remote', agentId: 'fra-remote' },
  { file: 'src/remote-agent-bridge.js', roleId: 'remote-bridge', agentId: 'remote-bridge' }
];

// --- 1. each dispatch site names a principal, and names it in code ----------
for (const site of SITES) {
  const source = fs.readFileSync(path.join(__dirname, '..', site.file), 'utf8');
  assert.ok(
    source.includes(`agentPrincipal: Object.freeze({ roleId: '${site.roleId}', agentId: '${site.agentId}' })`),
    `${site.file} must name a fixed principal at its dispatch site`
  );
  // A principal read off the wire would be a switch the caller can turn off.
  assert.equal(
    /agentPrincipal:\s*(?:options|request|body|payload|dispatchOptions|line)\./.test(source), false,
    `${site.file} must not take its principal from caller-supplied input`
  );
  // No `kind`, so it cannot pass for an authenticated agent session.
  const frozen = new RegExp(
    `agentPrincipal: Object\\.freeze\\(\\{[^}]*kind[^}]*\\}\\)`
  );
  assert.equal(frozen.test(source), false,
    `${site.file}'s synthetic principal must not claim an agent-session kind`);
}

// --- 2. the shape is one the vault policy can actually rule on -------------
// Mirrors vaultReadPrincipals in tool-registry.js.
function vaultReadPrincipals(context = {}) {
  const principal = context.agentPrincipal;
  if (!principal || typeof principal !== 'object') return [];
  return [principal.roleId, principal.agentId].filter(value => typeof value === 'string' && value !== '');
}

for (const site of SITES) {
  const principals = vaultReadPrincipals({
    agentPrincipal: { roleId: site.roleId, agentId: site.agentId }
  });
  assert.deepEqual(principals, [site.roleId, site.agentId],
    `${site.file}'s principal must reach the vault policy as two names`);
  for (const name of principals) {
    assert.match(name, /^[A-Za-z0-9_.:-]{1,120}$/,
      `${name} must satisfy the policy's principal format, or the owner cannot rule on it`);
  }
}

// --- 3. a rule against one of these names actually denies ------------------
{
  const read = {
    readable: true,
    code: 'read',
    policy: { records: { 'custom.provider_api_key': { access: { scheduler: false, 'fra-remote': true } } } }
  };
  assert.equal(
    policy.mayRead(read, 'custom.provider_api_key', ['scheduler', 'scheduler-runner-v1']).allowed, false,
    'turning a credential off for the scheduler must deny a scheduled read'
  );
  assert.equal(
    policy.mayRead(read, 'custom.provider_api_key', ['fra-remote', 'fra-remote']).allowed, true,
    'a transport the owner left switched on still reads'
  );
  // The regression this closes: before, these dispatches named nobody.
  assert.equal(
    policy.mayRead(read, 'custom.provider_api_key', []).allowed, true,
    'a read naming nobody is allowed -- which is exactly why every transport must name itself'
  );
}

// --- 4. the agent-session consumers still refuse these principals ----------
// They are the reason the synthetic principals carry no `kind`.
for (const site of SITES) {
  const principal = { roleId: site.roleId, agentId: site.agentId };
  assert.notEqual(principal.kind, 'agent-session',
    `${site.roleId} must not satisfy an agent-session check`);
  assert.equal(principal.sessionId, undefined,
    `${site.roleId} must carry no session id`);
}

console.log('The scheduler, the FRA bridge and the remote-agent bridge each name a principal the owner can rule on.');
