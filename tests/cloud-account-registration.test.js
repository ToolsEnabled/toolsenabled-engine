'use strict';

// The cloud account panel needs a real registration on-ramp, not a filename
// and a request to author JSON.  Exercise the registered handlers against an
// isolated installed-state root; no provider CLI, browser, sign-in, or real
// account registry participates.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { activate } = require('./lib/isolated-environment');
// Activate before loading the registry: executeTool records local outcomes and
// its audit module must therefore bind the isolated ledger, never this
// installation's canonical one.
const isolated = activate('cloud-account-registration');
const { TOOL_REGISTRY, executeTool } = require('../src/lib/tool-registry');
const { accountHomesRoot } = require('../src/lib/multi-account/registry-location');

const root = process.env.TOOLSENABLED_STATE_ROOT;

function route(name) {
  const found = TOOL_REGISTRY.find(entry => entry.name === name);
  assert.ok(found, `${name} must be registered`);
  return found;
}

async function run() {
  try {
  const add = route('cloud.account_add');
  const remove = route('cloud.account_remove');

  assert.equal(add.effect, 'local-write');
  assert.equal(add.provider, null, 'registration does not call a cloud provider');
  assert.equal(add.approvalEligible, true, 'registration changes the account routing set and remains owner-approved');
  assert.equal(add.annotations.destructiveHint, false);
  assert.equal(remove.effect, 'local-write');
  assert.equal(remove.provider, null);
  assert.equal(remove.approvalEligible, true);
  assert.equal(remove.annotations.destructiveHint, true);
  assert.equal(add.baseInputSchema.required.includes('name'), true);
  assert.equal(remove.baseInputSchema.required.includes('name'), true);

  const context = { permissionSession: { origin: 'local', tier: 'full' } };
  const added = await executeTool('cloud.account_add', { name: 'cloud-alpha' }, context);
  assert.deepEqual(added, {
    account: 'cloud-alpha', provider: 'codex', priority: 1,
    registered: true, signInRequired: true
  });
  assert.equal(Object.prototype.hasOwnProperty.call(added, 'home'), false, 'a tool receipt must not expose the profile path');

  const registry = path.join(root, 'config', 'accounts.json');
  const home = path.join(accountHomesRoot('codex'), 'cloud-alpha');
  assert.equal(fs.statSync(home).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(home), [], 'registration must create no sign-in material');
  assert.equal(JSON.parse(fs.readFileSync(registry, 'utf8')).accounts[0].name, 'cloud-alpha');

  const removed = await executeTool('cloud.account_remove', { name: 'cloud-alpha' }, context);
  assert.deepEqual(removed, {
    account: 'cloud-alpha', provider: 'codex', registered: false,
    remainingAccountCount: 0, profilePreserved: true, credentialDestroyed: true
  });
  assert.equal(fs.existsSync(registry), false, 'removing the final registration returns to the missing-registry state');
  assert.equal(fs.statSync(home).isDirectory(), true, 'unregistering must never delete the provider profile directory');

  await assert.rejects(
    () => executeTool('cloud.account_add', { name: 'aux' }, context),
    error => error && error.code === 'ACCOUNTS_ENTRY_INVALID'
  );
  process.stdout.write('cloud account registration: 18 checks passed\n');
  } finally { /* isolated-environment owns cleanup of the entire test root */ }
}

run().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
