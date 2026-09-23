'use strict';

const isolated = require('../lib/isolated-environment').activate('credential-removal');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const vaultPath = process.env.TOOLSENABLED_VAULT_PATH;
const sentinel = `removal-fixture-${crypto.randomBytes(24).toString('hex')}`;
const { mutate, inventory, history } = require('../../src/lib/secret-store');
const desktop = require('../../src/lib/desktop');
const { getTool, executeTool } = require('../helpers/dispatch');

mutate('add', 'ordinary_remove_key', sentinel, {
  reason: 'isolated removal setup', vaultPath
});

const tool = getTool('system.credential_remove');
assert.ok(tool, 'the product registry has no credential-removal path');
assert.equal(tool.effect, 'local-write');
assert.equal(tool.approvalEligible, true);
assert.equal(tool.annotations.destructiveHint, true);
assert.equal(tool.annotations.openWorldHint, false);
assert.equal(typeof tool.handler, 'undefined');

async function approvedRemoval(argumentsValue) {
  const originalAsk = desktop.ask;
  desktop.ask = async () => ({ answer: 'yes' });
  try {
    const grant = await executeTool('system.ask', { action: 'system.credential_remove', arguments: argumentsValue });
    return executeTool('system.credential_remove', { ...argumentsValue, approvalToken: grant.approvalToken });
  } finally {
    desktop.ask = originalAsk;
  }
}

// Upgrade residue from the old File.Replace backup name. It is a complete
// encrypted vault generation in production; the fixture need only prove the
// exact orphan name is removed before this deletion reports success.
const vaultDirectory = path.dirname(vaultPath);
const legacyBackup = path.join(
  vaultDirectory,
  `.${path.basename(vaultPath)}.1234.${'a'.repeat(32)}.tmp.bak`
);
fs.writeFileSync(legacyBackup, 'legacy encrypted vault generation', 'utf8');

;(async () => {
const removed = await approvedRemoval({ vaultKey: 'ordinary_remove_key', reason: 'legacy_cleanup' });
assert.equal(removed.operation, 'remove');
assert.equal(removed.name, 'ordinary_remove_key');
assert.equal(JSON.stringify(removed).includes(sentinel), false);

const item = inventory({ vaultPath }).secrets.find(candidate => candidate.name === 'ordinary_remove_key');
assert.equal(item.present, false);
assert.equal(item.state, 'removed');
assert.equal(JSON.stringify(item).includes(sentinel), false);
assert.equal(JSON.stringify(history('ordinary_remove_key', { vaultPath })).includes(sentinel), false);

assert.deepEqual(
  fs.readdirSync(vaultDirectory).filter(name => /\.bak$/i.test(name)),
  [],
  'successful removal left a pre-removal vault backup'
);
assert.equal(fs.readFileSync(vaultPath, 'utf8').includes(sentinel), false);

await assert.rejects(
  approvedRemoval({ vaultKey: 'custom.online_fra_device_credential_v1', reason: 'account_changed' }),
  error => error && error.code === 'SECRET_REMOVAL_DEDICATED_PATH'
);
await assert.rejects(
  approvedRemoval({ vaultKey: 'toolsenabled_audit_signing_key_v1', reason: 'no_longer_needed' }),
  error => error && error.code === 'SECRET_REMOVAL_NOT_SUPPORTED'
);

const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'toolsenabled.policy.json'), 'utf8'));
assert.ok(policy.approvals.actions.includes('system.credential_remove'));

process.stdout.write(`credential removal tests passed in ${isolated.owner ? 'owned' : 'inherited'} isolated vault\n`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
