'use strict';
const { activate } = require('./lib/isolated-environment');
const isolated = activate('bridge-session-lifecycle');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createOwnerHost } = require('../src/owner-host');
const { resolveAgentSessionCredential } = require('../src/lib/agent-session-credential');
const { createMissionBridgeServer } = require('../src/lib/mission-bridge/server');
const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

test('a session revoked while its HTTP body is pending cannot dispatch a write', { timeout: 15000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(isolated.root, 'http-'));
  const routeFile = path.join(scratch, 'host.json');
  const principal = { sessionId: 'http-session', agentId: 'http-controller', provider: 'codex',
    roleId: 'controller', expectedOrgRevision: 1, expectedRoleRevision: 1 };
  const org = { revision: 1, agents: [{ id: principal.agentId, displayName: 'Fixture controller',
    role: 'controller', provider: 'codex', enabled: true }], relationships: [] };
  // The host's binding/revocation and public credential resolver are real.
  // The fixture supplies its own installed role and does not read owner data.
  const host = createOwnerHost({ allowTestPaths: true, platform: 'test',
    pipeName: process.platform === 'win32' ? `\\\\.\\pipe\\HttpSession-${crypto.randomUUID()}` : path.join(scratch, 'host.sock'),
    capabilityFile: routeFile,
    principals: { ownerPrincipal: 'TESTHOST\\http', clientPrincipal: 'TESTHOST\\http' },
    credentialHygiene() {}, sessionRetirementObserver() {}, authorizeAgentBinding: () => true,
    readInstalledOrg: () => ({ org, roleRecord: { revision: 1, definition: { id: 'controller' } } }),
    broker: { MAX_MESSAGE_BYTES: 4096, resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }), processLine() {} },
  });
  t.after(async () => { await host.close(); });
  await host.listen();
  if (process.platform === 'linux') { fs.chmodSync(host.pipeName, 0o600); fs.chmodSync(routeFile, 0o600); }
  const bound = await host.bindSession(principal);
  assert.equal((await resolveAgentSessionCredential(bound.credential, { routeFile })).sessionId, principal.sessionId);
  let started = deferred();
  const effects = [];
  const bridge = createMissionBridgeServer({ token: crypto.randomBytes(32), bootstrapProof: crypto.randomBytes(32),
    allowTestPortZero: true, runtimeFile: path.join(scratch, 'bridge.json'), allowTestRuntimeFile: true,
    runtimeDependencies: { platform: 'test' }, allowedOrigins: ['http://127.0.0.1:4600'], actions: {},
    resolveAgentSessionCredential: credential => resolveAgentSessionCredential(credential, { routeFile }),
    actionsForPrincipal(value) {
      started.resolve();
      return createMissionActions({ principal: value, roots: { fixture: scratch }, agentOrg: org,
        permissionSession: { origin: 'local', tier: 'full' }, policy: { assertActive() {} },
        executeTool: async (tool, args) => { effects.push({ tool, args }); return { taskId: 'fixture-task', status: 'queued' }; },
      });
    },
  });
  t.after(async () => { await bridge.close(); });
  const address = await bridge.listen(0);
  const url = `${address.baseUrl}/v1/actions/task-submit`;
  const input = { queue: 'fixture', type: 'fixture', idempotencyKey: 'fixture', payload: {}, expiryPolicy: 'uncertain', maxAttempts: 1 };
  const headers = { authorization: `Session ${bound.credential}`, 'content-type': 'application/json' };
  const control = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(control.status, 200, JSON.stringify(await control.json()));
  assert.equal(effects.length, 1);
  started = deferred();
  const bytes = Buffer.from(JSON.stringify({ ...input, idempotencyKey: 'revoked' }));
  let request;
  const pending = new Promise((resolve, reject) => {
    request = http.request(url, { method: 'POST', headers: { ...headers, 'content-length': bytes.length } }, response => {
      let data = ''; response.setEncoding('utf8'); response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
      response.on('error', reject);
    });
    request.on('error', reject); request.flushHeaders();
  });
  t.after(() => request.destroy());
  await started.promise;
  await host.revokeSession({ ...principal, credential: bound.credential });
  await assert.rejects(resolveAgentSessionCredential(bound.credential, { routeFile }), { code: 'AGENT_SESSION_CREDENTIAL_REFUSED' });
  request.end(bytes);
  const result = await pending;
  assert.equal(result.status, 401, 'the completed body must not retain a revoked session admission');
  assert.equal(result.body.error.code, 'BRIDGE_UNAUTHORIZED');
  assert.equal(effects.length, 1, 'no write dispatch after credential revocation');
});
