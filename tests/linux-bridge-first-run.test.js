'use strict';

// Actual Linux, fresh default mission-bridge credential paths, and real loopback
// HTTP. No injected bearer/proof, Windows principal, ACL mock, action dispatch,
// owner profile, hosted account, or external provider. This is not a filesystem
// confinement or complete process-tree custody test.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { configure } = require('./lib/isolated-environment');

const CASES = ['absent', 'empty', 'hostile'];
const ORIGIN = 'http://127.0.0.2:4600';
let stage = 'preconditions';

function privatePath(file, directory = false) {
  const record = fs.lstatSync(file);
  assert.equal(record.isSymbolicLink(), false);
  assert.equal(directory ? record.isDirectory() : record.isFile(), true);
  assert.equal(record.uid, process.getuid());
  assert.equal(record.mode & 0o777, directory ? 0o700 : 0o600);
  if (!directory) assert.equal(record.nlink, 1);
}

function request(baseUrl, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const connection = http.get(`${baseUrl}${route}`, {
      agent: false,
      headers: { origin: ORIGIN, connection: 'close', ...headers },
      signal: AbortSignal.timeout(3000)
    }, response => {
      let bytes = 0;
      const chunks = [];
      response.on('error', reject);
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 128 * 1024) {
          connection.destroy(new Error('fixture response exceeded its byte limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
    });
    connection.on('error', reject);
  });
}

async function worker(kind) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), process.geteuid());
  assert.notEqual(process.getuid(), 0, 'native first-run evidence requires an ordinary account');
  assert.equal(CASES.includes(kind), true);
  assert.equal(process.env.TOOLSENABLED_TEST_ISOLATED, '1');
  const root = process.env.TOOLSENABLED_TEST_ROOT;
  assert.equal(path.isAbsolute(root), true);
  privatePath(root, true);
  if (kind === 'absent') {
    assert.equal(Object.keys(process.env).some(key => /^(USERNAME|USERDOMAIN)$/i.test(key)), false);
  } else if (kind === 'empty') {
    assert.equal(process.env.USERNAME, '');
    assert.equal(process.env.USERDOMAIN, '');
  } else {
    assert.equal(process.env.USERNAME, 'invalid:(F)|principal');
    assert.equal(process.env.USERDOMAIN, 'invalid:domain');
  }
  const oldUmask = process.umask(0o002);
  try {
    stage = 'unseeded-state-root';
    assert.equal(fs.existsSync(process.env.TOOLSENABLED_STATE_ROOT), false, 'the fixture did not pre-create the product state root');
    stage = 'production-import';
    // Import only after the separate worker's entire environment is isolated.
    const bridgeModule = require('../src/lib/mission-bridge/server');
    const uac = require('../src/lib/uac-delegation');
    const { stateRoot } = require('../src/lib/runtime-state-root');
    const { TOKEN_FILE, BOOTSTRAP_PROOF_FILE, RUNTIME_FILE, API_CONTRACT } = bridgeModule;
    const stateDirectory = path.dirname(TOKEN_FILE);
    stage = 'windows-policy-unchanged';
    assert.equal(path.relative(root, stateRoot()).startsWith('..'), false);
    // Linux token minting must not weaken the independent Windows argv policy.
    assert.throws(() => uac.ownerPrincipal(), error => error.code === 'UAC_OWNER_PRINCIPAL_INVALID');
    assert.equal(uac.ownerPrincipal({ ownerPrincipal: 'WORKGROUP\\Owner' }), 'WORKGROUP\\Owner');
    let previous = null;
    let requests = 0;
    for (let cycle = 0; cycle < 2; cycle += 1) {
      stage = `mint-${cycle}`;
      for (const file of [TOKEN_FILE, BOOTSTRAP_PROOF_FILE, RUNTIME_FILE]) {
        assert.equal(fs.existsSync(file), false, 'no pre-seeded or retained credential/discovery record');
      }
      // All credential, runtime, port selection, and action-factory paths are
      // production defaults. The normal CLI declares an origin and a root;
      // this root is the empty private fixture, never an owner's worktree.
      const bridge = bridgeModule.createMissionBridgeServer({
        allowedOrigins: [ORIGIN], actionOptions: { roots: { main: root } }
      });
      const sockets = new Set();
      bridge.server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      try {
        stage = `listen-${cycle}`;
        const address = await bridge.listen();
        assert.equal(address.host, '127.0.0.1');
        assert.equal(address.port >= 4610 && address.port <= 4619, true);
        for (const directory of [stateRoot(), stateDirectory]) privatePath(directory, true);
        for (const file of [TOKEN_FILE, BOOTSTRAP_PROOF_FILE, RUNTIME_FILE]) privatePath(file);
        const token = uac.readToken({ tokenFile: TOKEN_FILE });
        const proof = uac.readToken({ tokenFile: BOOTSTRAP_PROOF_FILE });
        assert.equal(token.length, 32);
        assert.equal(proof.length, 32);
        assert.equal(token.equals(proof), false, 'bootstrap proof is distinct from its bearer');
        if (previous) {
          assert.equal(token.equals(previous.token), false, 'restart rotates the bearer');
          assert.equal(proof.equals(previous.proof), false, 'restart rotates the proof');
        }
        const call = async (route, headers) => {
          requests += 1;
          return request(address.baseUrl, route, headers);
        };
        const refusesWithoutSecrets = (response, status) => {
          assert.equal(response.status, status);
          const body = JSON.stringify(response.body);
          assert.equal(body.includes(token.toString('base64url')), false);
          assert.equal(body.includes(proof.toString('base64url')), false);
        };
        stage = `http-${cycle}`;
        refusesWithoutSecrets(await call('/v1/bootstrap'), 401);
        refusesWithoutSecrets(await call(`/v1/bootstrap?proof=${crypto.randomBytes(32).toString('base64url')}`), 401);
        refusesWithoutSecrets(await call(`/v1/bootstrap?proof=${proof.toString('base64url')}`, { origin: 'http://foreign.invalid' }), 403);
        refusesWithoutSecrets(await call('/v1/contract'), 401);
        refusesWithoutSecrets(await call('/v1/contract', { authorization: `Bearer ${proof.toString('base64url')}` }), 401);
        refusesWithoutSecrets(await call('/v1/contract', { authorization: `Bearer ${token.toString('base64url')}`, origin: 'http://foreign.invalid' }), 403);
        if (previous) {
          refusesWithoutSecrets(await call(`/v1/bootstrap?proof=${previous.proof.toString('base64url')}`), 401);
          refusesWithoutSecrets(await call('/v1/contract', { authorization: `Bearer ${previous.token.toString('base64url')}` }), 401);
        }
        const issued = await call(`/v1/bootstrap?proof=${proof.toString('base64url')}`);
        assert.equal(issued.status, 200);
        assert.equal(issued.body.ok, true);
        assert.equal(typeof issued.body.token === 'string' && issued.body.token === token.toString('base64url'), true);
        const contract = await call('/v1/contract', { authorization: `Bearer ${issued.body.token}` });
        assert.equal(contract.status, 200);
        assert.equal(contract.body.ok, true);
        assert.deepEqual(contract.body.contract, API_CONTRACT);
        const runtime = await call('/v1/runtime');
        assert.equal(runtime.status, 200);
        assert.deepEqual(Object.keys(runtime.body).sort(), ['baseUrl', 'ok', 'pid', 'port', 'startedAt']);
        assert.equal(runtime.body.pid, process.pid);
        assert.equal(runtime.body.baseUrl, address.baseUrl);
        previous = { token, proof };
      } finally {
        // A failed listen is a test failure; close only a server that actually
        // listened. The parent owns the whole disposable filesystem fixture.
        if (bridge.server.listening) await bridge.close();
      }
      stage = `closed-${cycle}`;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(bridge.server.listening, false);
      assert.equal(sockets.size, 0, 'all observed native HTTP connections closed');
      for (const file of [TOKEN_FILE, BOOTSTRAP_PROOF_FILE, RUNTIME_FILE]) {
        assert.equal(fs.existsSync(file), false, 'normal shutdown removes its matching credential/discovery record');
      }
      assert.deepEqual(fs.readdirSync(stateDirectory), [], 'no credential temporary or previous files remain');
    }
    stage = 'failed-listen-cleanup';
    const occupied = http.createServer();
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    try {
      const refused = bridgeModule.createMissionBridgeServer({
        allowedOrigins: [ORIGIN], actionOptions: { roots: { main: root } }
      });
      await assert.rejects(refused.listen(occupied.address().port), { code: 'BRIDGE_PORT_UNAVAILABLE' });
      await refused.close();
      await refused.close();
      for (const file of [TOKEN_FILE, BOOTSTRAP_PROOF_FILE, RUNTIME_FILE]) assert.equal(fs.existsSync(file), false);

      stage = 'replacement-credentials-preserved';
      const older = bridgeModule.createMissionBridgeServer({ allowedOrigins: [ORIGIN], actionOptions: { roots: { main: root } } });
      const newer = bridgeModule.createMissionBridgeServer({ allowedOrigins: [ORIGIN], actionOptions: { roots: { main: root } } });
      const replacement = [TOKEN_FILE, BOOTSTRAP_PROOF_FILE].map(file => fs.readFileSync(file));
      await older.close();
      for (const [index, file] of [TOKEN_FILE, BOOTSTRAP_PROOF_FILE].entries()) assert.deepEqual(fs.readFileSync(file), replacement[index]);
      await newer.close();

      stage = 'cleanup-failure-remains-visible';
      const damaged = bridgeModule.createMissionBridgeServer({ allowedOrigins: [ORIGIN], actionOptions: { roots: { main: root } } });
      const original = fs.readFileSync(TOKEN_FILE);
      fs.writeFileSync(TOKEN_FILE, '{');
      await assert.rejects(damaged.close(), SyntaxError);
      assert.equal(fs.readFileSync(TOKEN_FILE, 'utf8'), '{');
      assert.equal(fs.existsSync(BOOTSTRAP_PROOF_FILE), false, 'one failure must not skip other cleanup');
      fs.writeFileSync(TOKEN_FILE, original);
      await damaged.close();
      assert.equal(fs.existsSync(TOKEN_FILE), false, 'a cleanup failure remains retryable');

      stage = 'runtime-cleanup-retry';
      const stale = bridgeModule.createMissionBridgeServer({ allowedOrigins: [ORIGIN], actionOptions: { roots: { main: root } } });
      await stale.listen();
      const discovery = fs.readFileSync(RUNTIME_FILE);
      fs.writeFileSync(RUNTIME_FILE, '{');
      await assert.rejects(stale.close(), SyntaxError);
      assert.equal(fs.readFileSync(RUNTIME_FILE, 'utf8'), '{');
      for (const file of [TOKEN_FILE, BOOTSTRAP_PROOF_FILE]) assert.equal(fs.existsSync(file), false);
      fs.writeFileSync(RUNTIME_FILE, discovery);
      await stale.close();
      assert.equal(fs.existsSync(RUNTIME_FILE), false, 'failed discovery removal retains its exact expected record for retry');

      stage = 'failed-cli-exit';
      const { attachResourceAuthority } = require('../src/lib/agent-resource-channel');
      const { attachResearchLifecycle, readResearchQuiescenceObservation } = require('../src/lib/research/lifecycle-channel');
      const importFailure = path.join(root, 'bridge-import-failure.cjs');
      fs.writeFileSync(importFailure, `const Module = require('node:module'); const load = Module._load;
Module._load = function(request, parent, ...args) {
  if (request === '../src/lib/mission-bridge/server' && parent?.filename.endsWith('mission-bridge.js')) {
    throw Object.assign(new Error('Fixture damaged custody during server import'), { code: 'AUDIT_SIGNING_KEY_UNAVAILABLE' });
  }
  return load.call(this, request, parent, ...args);
};\n`);
      for (const [origin, code, preload] of [['http://foreign.invalid', 'BRIDGE_ORIGIN_INVALID'], [ORIGIN, 'BRIDGE_PORT_UNAVAILABLE'], [ORIGIN, 'AUDIT_SIGNING_KEY_UNAVAILABLE', importFailure]]) {
        const child = spawn(process.execPath, [...(preload ? ['--require', preload] : []), path.resolve(__dirname, '../tools/mission-bridge.js'),
          '--origin', origin, '--root', `main=${root}`, '--port', String(occupied.address().port),
          '--resource-channel', 'inherited', '--research-lifecycle-channel', 'inherited'], {
          env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], shell: false
        });
        const research = attachResearchLifecycle(child, { bootId: crypto.randomUUID(), generation: crypto.randomUUID() });
        const authority = attachResourceAuthority(child, { reserveLane() { throw new Error('No provider starts in this fixture'); } });
        let stderr = ''; let stdout = ''; let timedOut = false;
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdout.on('data', chunk => { stdout += chunk; });
        // Failed startup admits no work. Retain the exact ChildProcess; on a
        // regression disconnect only its private fixture IPC, never signal a PID.
        const timer = setTimeout(() => { timedOut = true; if (child.connected) child.disconnect(); }, 3000);
        const result = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (status, signal) => resolve({ status, signal }));
        }).finally(() => { clearTimeout(timer); authority.close(); });
        assert.equal(timedOut, false, 'startup failure must exit without fixture intervention');
        assert.deepEqual(result, { status: 1, signal: null });
        assert.equal(stdout, '');
        const observed = await research.quiesceOwned();
        assert.equal(observed.status, 'not-started-in-epoch', JSON.stringify(observed));
        assert.equal(readResearchQuiescenceObservation(observed, research), observed);
        research.close();
        const records = stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
        assert.equal(records.some(record => record.ok === false && record.code === code), true);
        for (const file of [TOKEN_FILE, BOOTSTRAP_PROOF_FILE, RUNTIME_FILE]) assert.equal(fs.existsSync(file), false);
      }
    } finally { await new Promise(resolve => occupied.close(resolve)); }
    return { ok: true, kind, starts: 3, failedCliStarts: 3, cleanupCases: 5, requests, uid: process.getuid(), umask: '0002', openSockets: 0 };
  } finally { process.umask(oldUmask); }
}

function parent() {
  assert.equal(process.platform, 'linux', 'this native acceptance suite must run on Linux');
  const results = [];
  for (const kind of CASES) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-bridge-first-run-'));
    try {
      const environment = {
        PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ELECTRON_RUN_AS_NODE: '1',
        HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'),
        XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
        XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'xdg-state')
      };
      configure(root, environment);
      if (kind === 'empty') Object.assign(environment, { USERNAME: '', USERDOMAIN: '' });
      if (kind === 'hostile') Object.assign(environment, { USERNAME: 'invalid:(F)|principal', USERDOMAIN: 'invalid:domain' });
      const result = spawnSync(process.execPath, [__filename, '--worker', kind], {
        cwd: path.resolve(__dirname, '..'), env: environment, encoding: 'utf8',
        timeout: 20000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: false
      });
      let detail = null;
      try { detail = JSON.parse(result.stdout); } catch { /* report closed metadata below, never raw output */ }
      results.push({ kind, status: result.status, signal: result.signal, code: result.error?.code || null, detail });
    } finally {
      // Exact mkdtemp owned above; only this fixture is removed, after the
      // synchronous worker handle is terminal. No owner state is imported.
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  process.stdout.write(`${JSON.stringify({ suite: 'linux-bridge-first-run', cases: results })}\n`);
  assert.equal(results.every(result => result.status === 0 && !result.signal && !result.code && result.detail?.ok === true), true,
    'every fresh Linux default bridge worker must pass without a Windows identity');
}

if (process.argv[2] === '--worker') {
  worker(process.argv[3]).then(result => process.stdout.write(`${JSON.stringify(result)}\n`), error => {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'TEST_FAILURE';
    process.stdout.write(`${JSON.stringify({ ok: false, stage, code })}\n`);
    process.exitCode = 1;
  });
} else {
  try { parent(); }
  catch { process.stderr.write('linux-bridge-first-run: native acceptance failed\n'); process.exitCode = 1; }
}
