'use strict';
const { activate } = require('./lib/isolated-environment');
const isolated = activate('owner-root-assertion');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { createOwnerHost } = require('../src/owner-host');
const principal = Object.freeze({ sessionId: 'root-boundary-session', agentId: 'root-boundary-agent', provider: 'claude',
  roleId: 'worker', expectedOrgRevision: 3, expectedRoleRevision: 1 });

test('root assertion is synchronous, exact, live and read-only; it cannot rebind a revoked credential', async t => {
  let reading = 'valid'; let orgRevision = 3; let roleRevision = 1;
  const retired = [];
  const host = createOwnerHost({ allowTestPaths: true, platform: 'test',
    pipeName: process.platform === 'win32' ? `\\\\.\\pipe\\RootAssertion-${crypto.randomUUID()}` : path.join(isolated.root, 'owner.sock'),
    capabilityFile: path.join(isolated.root, 'owner.json'), controlCapabilityFile: path.join(isolated.root, 'control.json'),
    principals: { ownerPrincipal: 'TESTHOST\\root-assertion', clientPrincipal: 'TESTHOST\\root-assertion' },
    sessionRetirementObserver: value => retired.push(value),
    broker: { MAX_MESSAGE_BYTES: 1024, processLine() {}, resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }) },
    readInstalledOrg() {
      if (reading === 'unknown') throw new Error('synthetic unreadable role store');
      return { org: { revision: orgRevision, agents: [{ id: principal.agentId, role: 'worker', provider: 'claude', enabled: reading !== 'disabled' }] },
        roleRecord: { definition: { id: 'worker' }, revision: roleRevision } };
    },
  });
  t.after(() => host.close());
  await host.listen();
  const bound = await host.bindSession(principal);
  const retained = { ...principal, credential: bound.credential };
  assert.deepEqual(host.assertSession(retained), { valid: true, mode: 'app-owned-owner-host' });
  assert.throws(() => host.assertSession({ ...retained, sessionId: 'other' }), { code: 'OWNER_HOST_SESSION_REFUSED' });
  assert.throws(() => host.assertSession({ ...retained, extra: true }), { code: 'OWNER_HOST_SESSION_BINDING_INVALID' });
  reading = 'unknown';
  assert.throws(() => host.assertSession(retained), { code: 'OWNER_HOST_SESSION_UNKNOWN' });
  assert.equal(host.sessionBindings.size, 1); assert.equal(retired.length, 0);
  reading = 'disabled';
  assert.throws(() => host.assertSession(retained), { code: 'OWNER_HOST_SESSION_REFUSED' });
  assert.equal(host.sessionBindings.size, 1, 'assertion does not itself mutate bindings');
  reading = 'valid'; orgRevision++;
  assert.equal(host.assertSession(retained).valid, true, 'unrelated new seats do not revoke this retained identity');
  // A role edited since the bind is a rebind on the session's next line, not
  // a refusal (2026-09-19: six running controller/manager sessions were ended
  // per-line-recheck by a Role library save). The retained identity stays
  // valid, and this read-only check neither rebinds nor mints anything.
  roleRevision++;
  assert.equal(host.assertSession(retained).valid, true, 'a moved role revision does not refuse a retained identity');
  assert.equal(host.sessionBindings.get(bound.credential).principal.expectedRoleRevision, principal.expectedRoleRevision,
    'assertion is read-only: it does not rebind the session to the moved revision');
  roleRevision--;
  await host.revokeSession(retained);
  assert.throws(() => host.assertSession(retained), { code: 'OWNER_HOST_SESSION_REFUSED' });
  assert.equal(host.sessionBindings.size, 0, 'verification never mints a replacement credential');
  assert.equal(retired.length, 1);
  const anonymous = { sessionId: 'owner-session', agentId: null, provider: 'claude', roleId: null,
    expectedOrgRevision: null, expectedRoleRevision: null, credential: null };
  assert.deepEqual(host.assertSession(anonymous), { valid: true, mode: 'in-process' });
  await new Promise(resolve => host.server.close(resolve));
  assert.throws(() => host.assertSession(anonymous), { code: 'OWNER_HOST_NOT_READY' });
  await host.close();
  assert.throws(() => host.assertSession(anonymous), { code: 'OWNER_HOST_NOT_READY' });
});
