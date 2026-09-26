'use strict';
require('./lib/isolated-environment').activate('mission-owner-prompt-http');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMissionBridgeServer } = require('../src/lib/mission-bridge/server');
const prompts = require('../src/lib/mission-bridge/owner-prompts');

// Native HTTP and the real default action factory are both required here:
// a synchronous injected snapshot hides the Promise returned by every action.
test('owner-prompt HTTP waits for the real snapshot and shapes rejected snapshots', async t => {
  const root = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'owner-prompt-http-'));
  const stateFile = path.join(root, 'prompts.json');
  const token = crypto.randomBytes(32);
  const bridge = createMissionBridgeServer({
    token, bootstrapProof: crypto.randomBytes(32),
    allowedOrigins: ['http://127.0.0.1:4608'],
    allowTestPortZero: true, allowTestRuntimeFile: true,
    runtimeFile: path.join(root, 'runtime.json'),
    actionOptions: { roots: { fixture: root }, ownerPromptDependencies: { stateFile } }
  });
  t.after(async () => { await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const prompt = prompts.enqueue({kind: 'notice', title: 'HTTP pending notice',
    message: 'This known notice must survive the asynchronous action wrapper.', ttlMs: null}, { stateFile });
  const address = await bridge.listen(0);
  const preflight = await fetch(`${address.baseUrl}/v1/owner-prompts`, {
    method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:4608', 'access-control-request-method': 'GET' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4608');
  assert.equal(preflight.headers.has('content-length'), false);
  assert.equal(await preflight.text(), '');
  const get = () => fetch(`${address.baseUrl}/v1/owner-prompts`, {
    headers: { origin: 'http://127.0.0.1:4608', authorization: `Bearer ${token.toString('base64url')}` }
  });
  const response = await get();
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.prompts.length, 1);
  assert.equal(snapshot.prompts[0].id, prompt.promptId);
  assert.equal(snapshot.prompts[0].title, 'HTTP pending notice');

  fs.writeFileSync(stateFile, '{invalid snapshot');
  const refused = await get();
  assert.equal(refused.status, 503);
  const failure = await refused.json();
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'OWNER_PROMPT_STORE_CORRUPT');
  assert.equal(typeof failure.error.requestId, 'string');
});
