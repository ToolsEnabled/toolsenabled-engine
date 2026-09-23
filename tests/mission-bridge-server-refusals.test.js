'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The server imports the default action graph eagerly, although every fixture
// below injects its own actions. Avoid initializing that unrelated SQLite graph
// on the older Node used by the isolated-test runner.
const actionsFilename = require.resolve('../src/lib/mission-bridge/actions');
const terminationFilename = require.resolve('../src/lib/mission-bridge/termination');
require.cache[actionsFilename] = {
  id: actionsFilename, filename: actionsFilename, loaded: true,
  exports: { createMissionActions: () => ({}) }, children: [], paths: []
};
require.cache[terminationFilename] = {
  id: terminationFilename, filename: terminationFilename, loaded: true,
  exports: { REQUEST_BODY_SHA256: Symbol('requestBodySha256') }, children: [], paths: []
};
const {
  BOOTSTRAP_PROOF_FILE,
  TOKEN_FILE,
  createMissionBridgeServer,
  writeRuntimeDiscovery
} = require('../src/lib/mission-bridge/server');
delete require.cache[actionsFilename];
delete require.cache[terminationFilename];

const ALLOWED_ORIGIN = 'http://127.0.0.1:4600';
let assertions = 0;
function check(condition, message) {
  assertions += 1;
  assert.ok(condition, message);
}
function refusal(code, operation) {
  assertions += 1;
  assert.throws(operation, error => error?.code === code, `expected ${code}`);
}

function baseOptions(overrides = {}) {
  return {
    allowedOrigins: [ALLOWED_ORIGIN],
    token: crypto.randomBytes(32),
    bootstrapProof: crypto.randomBytes(32),
    actions: {},
    ...overrides
  };
}

function productionMintRefusal(code, productionFile, options) {
  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  const originalWrite = fs.writeFileSync;
  let writes = 0;
  fs.renameSync = file => {
    check(path.resolve(file) === productionFile, 'rotation only examines the expected production credential');
    const error = new Error('fixture: credential absent');
    error.code = 'ENOENT';
    throw error;
  };
  fs.unlinkSync = () => {};
  fs.writeFileSync = () => { writes += 1; };
  try {
    refusal(code, () => createMissionBridgeServer(options));
    check(writes === 0, `${code} writes no credential data`);
  } finally {
    fs.renameSync = originalRename;
    fs.unlinkSync = originalUnlink;
    fs.writeFileSync = originalWrite;
  }
}

async function requestRefusals() {
  let actionCalls = 0;
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-refusals-'));
  const runtimeFile = path.join(runtimeDir, 'runtime.json');
  const token = crypto.randomBytes(32);
  const bridge = createMissionBridgeServer(baseOptions({
    token,
    allowTestPortZero: true,
    allowTestRuntimeFile: true,
    runtimeFile,
    actions: {
      async dispatch() {
        actionCalls += 1;
        return { ok: false };
      }
    }
  }));
  try {
    const { baseUrl } = await bridge.listen(0);
    const before = fs.readFileSync(runtimeFile, 'utf8');
    const headers = { authorization: `Bearer ${token.toString('base64url')}` };

    const cases = [
      ['BRIDGE_CONTENT_TYPE_REQUIRED', '', {}],
      ['BRIDGE_JSON_INVALID', '{not json', { 'content-type': 'application/json' }],
      ['BRIDGE_DEPENDENCY_UNKNOWN', '{}', { 'content-type': 'application/json' }]
    ];
    for (const [code, body, extraHeaders] of cases) {
      const response = await fetch(`${baseUrl}/v1/actions/dispatch`, {
        method: 'POST', headers: { ...headers, ...extraHeaders }, body
      });
      const payload = await response.json();
      check(payload?.error?.code === code, `POST drives ${code}`);
      check(response.status === (code === 'BRIDGE_CONTENT_TYPE_REQUIRED' ? 415 : code === 'BRIDGE_DEPENDENCY_UNKNOWN' ? 503 : 400), `${code} has its typed status`);
    }
    check(actionCalls === 1, 'content-type and JSON refusals do not invoke the action');

    const optionsResponse = await fetch(`${baseUrl}/v1/actions/dispatch`, {
      method: 'OPTIONS', headers: { origin: ALLOWED_ORIGIN }
    });
    check(optionsResponse.status === 204, 'OPTIONS is handled without authentication or dispatch');
    check(actionCalls === 1, 'OPTIONS does not invoke the action');
    check(fs.readFileSync(runtimeFile, 'utf8') === before, 'request refusals do not rewrite runtime discovery');
  } finally {
    await bridge.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

async function utf8RequestBodies() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-utf8-'));
  const token = crypto.randomBytes(32);
  const received = [];
  const bridge = createMissionBridgeServer(baseOptions({
    token, allowTestPortZero: true, allowTestRuntimeFile: true,
    runtimeFile: path.join(runtimeDir, 'runtime.json'),
    actions: { async dispatch(input) {
      received.push(input.text);
      return { ok: true, receipt: { text: input.text } };
    } }
  }));
  try {
    const { baseUrl } = await bridge.listen(0);
    const post = body => fetch(`${baseUrl}/v1/actions/dispatch`, {
      method: 'POST', body,
      headers: { authorization: `Bearer ${token.toString('base64url')}`, 'content-type': 'application/json' }
    });
    // Buffer.toString silently replaces these bytes with U+FFFD. Accepting
    // them would dispatch a different task from the bytes the client sent.
    for (const invalid of [[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80]]) {
      const response = await post(Buffer.concat([
        Buffer.from('{"text":"'), Buffer.from(invalid), Buffer.from('"}')
      ]));
      const payload = await response.json();
      check(response.status === 400, 'malformed UTF-8 is refused before action dispatch');
      check(payload.error?.code === 'BRIDGE_JSON_INVALID', 'encoding errors use the JSON input refusal');
    }
    check(received.length === 0, 'invalid byte sequences never reach the action');
    const text = 'café — 日本語 — 😀 — \uFFFD';
    const response = await post(Buffer.from(JSON.stringify({ text }), 'utf8'));
    check(response.status === 200, 'valid Unicode, including a literal replacement character, is accepted');
    check((await response.json()).receipt.text === text, 'valid Unicode arrives unchanged');
    check(received.length === 1 && received[0] === text, 'only the valid request is dispatched');
  } finally {
    await bridge.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

async function main() {
  const custodyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-runtime-custody-'));
  try {
    const runtimeFile = path.join(custodyDir, 'runtime.json');
    const previous = 'previous-runtime-record\n';
    fs.writeFileSync(runtimeFile, previous);
    const record = { baseUrl: 'http://127.0.0.1:4600', port: 4600,
      pid: process.pid, startedAt: '2026-09-08T00:00:00.000Z' };
    let attempts = 0;
    refusal('BRIDGE_RUNTIME_DISCOVERY_UNAVAILABLE', () => writeRuntimeDiscovery(record, {
      runtimeFile, allowTestRuntimeFile: true, platform: 'win32', ownerPrincipal: 'HOST\\owner',
      spawnSyncImpl(executable, args) {
        attempts += 1;
        check(executable === '\\\\.\\GLOBALROOT\\SystemRoot\\System32\\icacls.exe', 'runtime ACL uses the fixed Windows binary');
        check(args[0] === path.toNamespacedPath(path.resolve(args[0])), 'runtime ACL uses a native extended path');
        check(args[0] !== runtimeFile && fs.existsSync(args[0]), 'runtime ACL runs before publication');
        check(fs.readFileSync(runtimeFile, 'utf8') === previous, 'the previous runtime survives until custody succeeds');
        return { status: 1 };
      }
    }));
    check(attempts === 1, 'runtime publication attempted the ACL');
    check(fs.readFileSync(runtimeFile, 'utf8') === previous, 'ACL failure preserves prior runtime bytes');
    check(fs.readdirSync(custodyDir).join(',') === 'runtime.json', 'failed runtime publication removes its temporary file');
  } finally { fs.rmSync(custodyDir, { recursive: true, force: true }); }

  refusal('BRIDGE_BIND_REFUSED', () => createMissionBridgeServer(baseOptions({ host: '0.0.0.0' })));
  refusal('BRIDGE_ORIGIN_REQUIRED', () => createMissionBridgeServer(baseOptions({ allowedOrigins: [] })));
  refusal('BRIDGE_TOKEN_INVALID', () => createMissionBridgeServer(baseOptions({ token: Buffer.alloc(31) })));
  refusal('BRIDGE_TOKEN_PATH_REFUSED', () => createMissionBridgeServer(baseOptions({ token: undefined, tokenFile: path.join(os.tmpdir(), 'forbidden-token.json') })));

  productionMintRefusal('BRIDGE_TOKEN_PRODUCTION_MINT_REFUSED', TOKEN_FILE, baseOptions({
    token: undefined,
    allowTestPortZero: true
  }));
  productionMintRefusal('BRIDGE_BOOTSTRAP_PROOF_PRODUCTION_MINT_REFUSED', BOOTSTRAP_PROOF_FILE, baseOptions({
    bootstrapProof: undefined,
    allowTestPortZero: true
  }));

  let runtimeWrites = 0;
  const bridge = createMissionBridgeServer(baseOptions({
    allowTestPortZero: true,
    runtimeFile: path.join(os.tmpdir(), 'forbidden-runtime.json'),
    runtimeDependencies: { fs: { writeFileSync() { runtimeWrites += 1; } } }
  }));
  await assert.rejects(() => bridge.listen(0), error => error?.code === 'BRIDGE_RUNTIME_DISCOVERY_PATH_REFUSED');
  assertions += 1;
  check(runtimeWrites === 0, 'runtime path refusal happens before any write');

  await requestRefusals();
  await utf8RequestBodies();
  console.log(`mission-bridge-server-refusals: ${assertions} assertions passed`);
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
