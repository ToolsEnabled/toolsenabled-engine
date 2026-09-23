'use strict';
const { activate } = require('./lib/isolated-environment');
const isolated = activate('owner-start-admission');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { createOwnerHost } = require('../src/owner-host');
const principal = Object.freeze({ sessionId: 'starting-child', agentId: 'child-one', provider: 'claude',
  roleId: 'worker', expectedOrgRevision: 3, expectedRoleRevision: 1 });

async function fixture(t) {
  const state = { revision: 3, roleRevision: 1, enabled: true, provider: 'claude', role: 'worker', missing: false, unknown: false };
  const id = crypto.randomUUID();
  const host = createOwnerHost({ allowTestPaths: true, platform: 'test',
    pipeName: process.platform === 'win32' ? `\\\\.\\pipe\\StartAdmission-${id}` : path.join(isolated.root, `${id}.sock`),
    capabilityFile: path.join(isolated.root, `${id}.json`), controlCapabilityFile: path.join(isolated.root, `${id}-control.json`),
    principals: { ownerPrincipal: 'TESTHOST\\start-admission', clientPrincipal: 'TESTHOST\\start-admission' },
    sessionRetirementObserver() {},
    broker: { MAX_MESSAGE_BYTES: 1024, processLine() {}, resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }) },
    readInstalledOrg() {
      if (state.unknown) throw new Error('synthetic unreadable organisation');
      return { org: { revision: state.revision, agents: state.missing ? [] : [{ id: 'child-one', enabled: state.enabled, provider: state.provider, role: state.role }] },
        roleRecord: { definition: { id: 'worker' }, revision: state.roleRevision } };
    },
  });
  t.after(() => host.close());
  await host.listen();
  return { host, state };
}

test('fresh admission survives unrelated sibling writes without issuing a credential early', async t => {
  const { host, state } = await fixture(t);
  const admission = host.admitSession(principal);
  assert.equal(host.admissionVersion, 1);
  assert.equal(host.sessionBindings.size, 0);
  assert.deepEqual(Reflect.ownKeys(admission), []);
  assert.ok(Object.isFrozen(admission));
  state.revision++;
  await assert.rejects(host.bindSession(principal), { code: 'OWNER_HOST_SESSION_REFUSED' }, 'ordinary fresh bind remains strict');
  const bound = await host.bindSession(principal, {}, admission);
  assert.equal(host.sessionBindings.size, 1);
  assert.equal(host.assertSession({ ...principal, credential: bound.credential }).valid, true);
  await assert.rejects(host.bindSession(principal, {}, admission), { code: 'OWNER_HOST_SESSION_BINDING_INVALID' });
});

for (const [name, change, code] of [
  ['disabled seat', s => { s.enabled = false; }, 'OWNER_HOST_SESSION_REFUSED'],
  ['removed seat', s => { s.missing = true; }, 'OWNER_HOST_SESSION_REFUSED'],
  ['changed provider', s => { s.provider = 'codex'; }, 'OWNER_HOST_SESSION_REFUSED'],
  ['changed role assignment', s => { s.role = 'builder'; }, 'OWNER_HOST_SESSION_REFUSED'],
  ['changed role directions', s => { s.roleRevision++; }, 'OWNER_HOST_SESSION_REFUSED'],
  ['unreadable authority', s => { s.unknown = true; }, 'OWNER_HOST_SESSION_UNKNOWN'],
]) {
  test(`admission cannot bypass ${name} during account preparation`, async t => {
    const { host, state } = await fixture(t);
    const admission = host.admitSession(principal);
    change(state);
    await assert.rejects(host.bindSession(principal, {}, admission), { code });
    assert.equal(host.sessionBindings.size, 0);
    await assert.rejects(host.bindSession(principal, {}, admission), { code: 'OWNER_HOST_SESSION_BINDING_INVALID' }, 'failed admission is consumed');
  });
}

test('stale screens cannot capture admission and tickets cannot be forged, transferred or retargeted', async t => {
  const { host, state } = await fixture(t);
  state.revision++;
  assert.throws(() => host.admitSession(principal), { code: 'OWNER_HOST_SESSION_REFUSED' });
  state.revision--;
  await assert.rejects(host.bindSession(principal, {}, Object.freeze({})), { code: 'OWNER_HOST_SESSION_BINDING_INVALID' });
  const admission = host.admitSession(principal);
  const other = await fixture(t);
  await assert.rejects(other.host.bindSession(principal, {}, admission), { code: 'OWNER_HOST_SESSION_BINDING_INVALID' });
  await assert.rejects(host.bindSession({ ...principal, sessionId: 'different-child' }, {}, admission), { code: 'OWNER_HOST_SESSION_BINDING_INVALID' });
  assert.equal(host.sessionBindings.size, 0);
});

test('closing the owner host prevents both admission and delayed binding', async t => {
  const { host } = await fixture(t);
  const admission = host.admitSession(principal);
  await host.close();
  assert.throws(() => host.admitSession(principal), { code: 'OWNER_HOST_NOT_READY' });
  await assert.rejects(host.bindSession(principal, {}, admission), { code: 'OWNER_HOST_NOT_READY' });
});
