'use strict';

// Real CLI subprocesses and real loopback HTTP, with synthetic server replies
// and a file-backed test vault. This proves the command/library boundary, not
// real account enrollment, DPAPI storage, or an online relay session.
const isolated = require('./lib/isolated-environment').activate('claim-cli');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { configure, within } = require('./lib/isolated-environment');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'online-fra-claim-cli.js');
const PRELOAD = path.join(__dirname, 'helpers', 'online-fra-claim-cli-vault.cjs');
const DEVICE_KEY = 'custom.online_fra_device_credential_v1';
const IDENTITY_KEY = 'custom.online_fra_device_identity_v1';
const STATUS_PATH = '/v1/devices/claim-code/status';
const EMAIL = '<img src=x onerror="claim()">@example.invalid';
const TOKEN = '--' + 'a'.repeat(41); // A legal base64url token may start with dashes.
const DEVICE = { pairId: 'fixture-pair', deviceId: 'fixture-device', name: 'Fixture PC' };
const GRANT = {
  state: 'granted',
  device: { ...DEVICE, extraPrivateField: 'fixture-do-not-project' },
  deviceToken: 'fixture-device-token-never-issued',
  credential: { certificatePem: 'fixture-certificate', privateKeyPem: 'fixture-private-key-never-issued' }
};
const reserved = { state: 'reserved', account: { email: EMAIL, extra: 'not-public' }, intervalSeconds: 5 };
const queue = [];
const requests = [];
const serverFailures = [];
let origin;
let vaultCount = 0;
let passed = 0;
const failures = [];

function reply(status, body) { queue.push({ status, body }); }
function noGrant(vault) { assert.equal(Object.hasOwn(vault.read(), DEVICE_KEY), false); }
function noWireSecrets(answer) {
  const text = JSON.stringify(answer);
  for (const secret of [TOKEN, GRANT.deviceToken, GRANT.credential.privateKeyPem, 'fixture-do-not-project']) {
    assert.equal(text.includes(secret), false, 'the CLI projects public connection fields only');
  }
}
function newVault() {
  const root = path.join(isolated.root, `claim-cli-fixture-${++vaultCount}`);
  assert.ok(within(isolated.root, root));
  fs.mkdirSync(root);
  const filename = path.join(root, 'fixture-vault.json');
  const trace = path.join(root, 'fixture-vault-operations.jsonl');
  fs.writeFileSync(filename, '{}\n');
  return {
    root,
    read: () => JSON.parse(fs.readFileSync(filename, 'utf8')),
    operations: () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : []
  };
}
async function invoke(vault, args) {
  // Preserve only platform process lookup, then explicitly isolate all test
  // state and profile destinations. No credential-bearing ambient variables.
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  configure(isolated.root, env);
  Object.assign(env, {
    TEMP: isolated.root,
    TMP: isolated.root,
    HOME: isolated.root,
    USERPROFILE: isolated.root,
    APPDATA: path.join(isolated.root, 'roaming-app-data'),
    TOOLSENABLED_CLAIM_FIXTURE_ROOT: vault.root,
    TOOLSENABLED_ACCOUNT_ORIGIN: origin
  });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', PRELOAD, CLI, ...args], {
      cwd: ROOT, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 64 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 64 * 1024) child.kill('SIGKILL'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || signal) reject(new Error('The CLI did not terminate normally.'));
      else resolve({ code, stdout, stderr });
    });
  });
  assert.equal(result.stdout.trim().split('\n').length, 1, 'exactly one machine-readable answer');
  return { ...result, answer: JSON.parse(result.stdout) };
}
async function check(name, run) {
  try {
    assert.equal(queue.length, 0, 'the previous scenario consumed its fixture replies');
    await run();
    assert.equal(queue.length, 0, 'the CLI made every expected request');
    assert.deepEqual(serverFailures, [], 'no unexpected HTTP traffic');
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.message}`);
    queue.length = 0;
  }
}
function lastBody() { return requests.at(-1).body; }

const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.ok(req.url === STATUS_PATH || req.url === '/v1/devices/claim-code');
    assert.equal(req.headers.origin, origin);
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers.authorization, undefined, 'no account credential is needed by this machine');
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push({ path: req.url, body: JSON.parse(text) });
    const next = queue.shift();
    assert.ok(next, 'unscripted network request');
    if (next.lost) { req.socket.destroy(); return; }
    res.writeHead(next.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(next.body));
  } catch (error) {
    serverFailures.push(error.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'FIXTURE_REFUSED' } }));
  }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  await check('injected account response errors keep the actual CLI projection closed and uncertainty honest', async () => {
    // This one projection test injects a client error into the complete CLI.
    // The remaining groups below retain real subprocesses and loopback HTTP.
    const before = requests.length;
    const realRequire = createRequire(CLI);
    for (const [code, requestOutcome, expected] of [
      ['DEVICE_CLAIM_RESPONSE_INVALID', 'NOT_ATTEMPTED', 'UNCERTAIN'],
      ['DEVICE_CLAIM_RESPONSE_INVALID', undefined, 'UNCERTAIN'],
      ['DEVICE_CLAIM_UNREACHABLE', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED'],
      ['DEVICE_CLAIM_UNREACHABLE', 'FUTURE', 'UNCERTAIN'],
    ]) {
      let calls = 0;
      const answer = await new Promise((resolve, reject) => {
        const fixtureProcess = {
          argv: [process.execPath, CLI, 'open', '--name', 'Fixture PC'],
          env: { TOOLSENABLED_ACCOUNT_ORIGIN: origin },
          stdout: { write: data => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } } },
          stderr: { write: () => {} },
        };
        const injectedRequire = name => {
          if (name === '../src/lib/runtime') return {};
          if (name === '../src/lib/online-fra-device-claim') return {
            createDeviceClaimClient: () => ({ openClaim: async () => {
              calls += 1;
              throw Object.assign(new Error('private response bytes'), { code, requestOutcome });
            } }),
          };
          return realRequire(name);
        };
        try {
          new vm.Script(fs.readFileSync(CLI, 'utf8'), { filename: CLI })
            .runInNewContext({ process: fixtureProcess, require: injectedRequire }, { timeout: 1000 });
        } catch (error) { reject(error); }
      });
      assert.equal(answer.error.code, code);
      assert.equal(answer.error.requestOutcome, expected);
      assert.equal(Object.hasOwn(answer.error, 'mutationOutcome'), false);
      assert.equal(JSON.stringify(answer).includes('private response'), false);
      assert.equal(calls, 1);
    }
    assert.equal(requests.length, before, 'this projection fixture does not claim HTTP coverage');
  });

  await check('malformed invocations fail before runtime loading or HTTP', async () => {
    const vault = newVault();
    const before = requests.length;
    const invalid = [
      [], ['unknown'], ['__proto__'], ['constructor'], ['status', 'trailing'],
      ['status', '--accept', 'true'], ['disconnect', '--accept', 'false'],
      ['open'], ['open', '--name'], ['open', '--name', ''],
      ['open', '--name', 'PC', '--accept', 'true'],
      ['poll'], ['poll', '--token'], ['poll', '--accept', 'true'],
      ['poll', '--token', TOKEN, '--accept'], ['poll', '--token', '--accept', 'true'],
      ['poll', '--token', TOKEN, '--accept=true'], ['poll', '--token', TOKEN, '--unknown', 'true'],
      ['poll', '--token', TOKEN, '--token', 'other'], ['poll', '--token', TOKEN, '--accept', 'true', '--accept', 'false'],
      ['poll', '--token', TOKEN, 'false'], ['wait', '--token', TOKEN, '--accept', 'true'],
      ['wait', '--token', TOKEN, '--deadline-ms'],
      ...['TRUE', 'False', '1', '0', 'yes', 'null', 'undefined', '', ' true', 'false '].map(value => ['poll', '--token', TOKEN, '--accept', value]),
      ...['0', '-1', 'Infinity', 'NaN', '1.5', '1e3', '0x10', '9007199254740992'].map(value => ['wait', '--token', TOKEN, '--deadline-ms', value])
    ];
    for (const args of invalid) {
      const result = await invoke(vault, args);
      assert.equal(result.code, 2);
      assert.equal(result.answer.error.code, 'CLI_USAGE');
      assert.equal(result.stderr, '');
      assert.equal(result.stdout.includes(TOKEN), false, 'usage errors do not echo the poll token');
    }
    assert.equal(requests.length, before);
    assert.deepEqual(vault.operations(), [], 'invalid arguments do not even load runtime');
    assert.deepEqual(vault.read(), {});
  });

  await check('open preserves the code contract and mints only an isolated identity', async () => {
    const vault = newVault();
    const claim = { code: 'TC-FIXT-URES', pollToken: TOKEN, expiresAtMs: Date.now() + 600_000, intervalSeconds: 5 };
    reply(201, { claim });
    const result = await invoke(vault, ['open', '--name', 'Fixture PC']);
    assert.equal(result.code, 0);
    assert.deepEqual(result.answer, claim);
    assert.equal(lastBody().name, 'Fixture PC');
    assert.equal(typeof lastBody().ed25519PublicKey, 'string');
    assert.equal(Object.hasOwn(vault.read(), IDENTITY_KEY), true);
    noGrant(vault);
    assert.equal(result.stderr.includes(TOKEN), false);
  });

  await check('ordinary pending and reserved polls never send a decision', async () => {
    const vault = newVault();
    reply(200, { state: 'pending', intervalSeconds: 5 });
    let result = await invoke(vault, ['poll', '--token', TOKEN]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.answer, { state: 'pending', intervalSeconds: 5 });
    assert.deepEqual(lastBody(), { pollToken: TOKEN });
    reply(200, reserved);
    result = await invoke(vault, ['poll', '--token', TOKEN]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.answer, { state: 'reserved', account: { email: EMAIL }, intervalSeconds: 5 });
    assert.deepEqual(lastBody(), { pollToken: TOKEN });
    assert.equal(result.stderr, '', 'untrusted email is not printed as human prose');
    noWireSecrets(result.answer);
    noGrant(vault);
    assert.deepEqual(vault.operations().filter(row => row.operation !== 'load'), []);
  });

  await check('explicit acceptance parks the grant; only a later poll stores and reports it', async () => {
    const vault = newVault();
    const before = requests.length;
    reply(202, { state: 'accepted' });
    const accepted = await invoke(vault, ['poll', '--accept', 'true', '--token', TOKEN]);
    assert.equal(accepted.code, 0);
    assert.deepEqual(accepted.answer, { state: 'accepted' });
    assert.deepEqual(lastBody(), { pollToken: TOKEN, accept: true });
    assert.equal(requests.length, before + 1);
    noGrant(vault);
    reply(200, GRANT);
    const connected = await invoke(vault, ['poll', '--token', TOKEN]);
    assert.equal(connected.code, 0);
    assert.deepEqual(connected.answer, { state: 'connected', ...DEVICE });
    assert.deepEqual(lastBody(), { pollToken: TOKEN });
    noWireSecrets(connected.answer);
    const stored = JSON.parse(vault.read()[DEVICE_KEY]);
    assert.equal(stored.deviceToken, GRANT.deviceToken);
    assert.equal(stored.privateKeyPem, GRANT.credential.privateKeyPem);
    assert.equal(Number.isFinite(stored.claimedAtMs), true);
    const status = await invoke(vault, ['status']);
    assert.equal(status.code, 0);
    assert.deepEqual(status.answer, { connected: true, ...DEVICE, claimedAtMs: stored.claimedAtMs });
    noWireSecrets(status.answer);
    reply(404, { error: { code: 'CLAIM_UNKNOWN' } });
    const replay = await invoke(vault, ['poll', '--token', TOKEN]);
    assert.equal(replay.code, 1);
    assert.equal(replay.answer.error.code, 'DEVICE_CLAIM_GONE');
  });

  await check('explicit decline consumes the reservation without creating a credential', async () => {
    const vault = newVault();
    reply(200, { state: 'rejected' });
    const result = await invoke(vault, ['poll', '--token', TOKEN, '--accept', 'false']);
    assert.equal(result.code, 0);
    assert.deepEqual(result.answer, { state: 'rejected' });
    assert.deepEqual(lastBody(), { pollToken: TOKEN, accept: false });
    reply(404, { error: { code: 'CLAIM_UNKNOWN' } });
    const after = await invoke(vault, ['poll', '--token', TOKEN]);
    assert.equal(after.code, 1);
    assert.equal(after.answer.error.code, 'DEVICE_CLAIM_GONE');
    noGrant(vault);
  });

  await check('wait returns the reserved account immediately for a local decision', async () => {
    const vault = newVault();
    const before = requests.length;
    reply(200, { state: 'pending', intervalSeconds: 0.005 });
    reply(200, reserved);
    const result = await invoke(vault, ['wait', '--token', TOKEN, '--deadline-ms', '1000']);
    assert.equal(result.code, 0);
    assert.deepEqual(result.answer, { state: 'reserved', account: { email: EMAIL }, intervalSeconds: 5 });
    assert.deepEqual(requests.slice(before).map(row => row.body), [{ pollToken: TOKEN }, { pollToken: TOKEN }]);
    noGrant(vault);
  });

  await check('a lost acceptance response is recovered without resending acceptance', async () => {
    const vault = newVault();
    const before = requests.length;
    queue.push({ lost: true });
    const result = await invoke(vault, ['poll', '--token', TOKEN, '--accept', 'true']);
    assert.equal(result.code, 1);
    assert.equal(result.answer.error.code, 'DEVICE_CLAIM_UNREACHABLE');
    assert.equal(result.answer.error.requestOutcome, 'UNCERTAIN');
    assert.match(result.answer.error.message, /may have reached/);
    assert.equal(Object.hasOwn(result.answer.error, 'mutationOutcome'), false);
    assert.equal(requests.length, before + 1, 'the CLI must not resend the lost decision');
    noWireSecrets(result.answer);
    assert.deepEqual(lastBody(), { pollToken: TOKEN, accept: true });
    noGrant(vault);
    reply(200, GRANT);
    const recovered = await invoke(vault, ['poll', '--token', TOKEN]);
    assert.equal(recovered.code, 0);
    assert.deepEqual(recovered.answer, { state: 'connected', ...DEVICE });
    assert.deepEqual(lastBody(), { pollToken: TOKEN });
  });

  await check('decision refusals and malformed replies cannot report acceptance or store a grant', async () => {
    const vault = newVault();
    for (const [status, body, code] of [
      [202, reserved, 'DEVICE_CLAIM_RESPONSE_INVALID'],
      [200, GRANT, 'DEVICE_CLAIM_REFUSED'],
      [409, { error: { code: 'CLAIM_ACCOUNT_MISMATCH', message: 'This account cannot claim the computer.' } }, 'CLAIM_ACCOUNT_MISMATCH'],
      [404, { error: { code: 'CLAIM_UNKNOWN' } }, 'DEVICE_CLAIM_GONE']
    ]) {
      reply(status, body);
      const result = await invoke(vault, ['poll', '--token', TOKEN, '--accept', 'true']);
      assert.equal(result.code, 1);
      assert.equal(result.answer.error.code, code);
      noGrant(vault);
    }
  });

  await check('a grant is never reported connected when vault persistence fails', async () => {
    const vault = newVault();
    fs.writeFileSync(path.join(vault.root, 'refuse-write'), 'fixture only\n');
    reply(200, GRANT);
    const result = await invoke(vault, ['poll', '--token', TOKEN]);
    assert.equal(result.code, 1);
    assert.equal(result.answer.error.code, 'FIXTURE_WRITE_REFUSED');
    noGrant(vault);
    noWireSecrets(result.answer);
  });

  await check('wait refuses unusable polling intervals instead of spinning', async () => {
    const vault = newVault();
    for (const intervalSeconds of [0, -1, null, '5']) {
      reply(200, { state: 'pending', intervalSeconds });
      const result = await invoke(vault, ['wait', '--token', TOKEN, '--deadline-ms', '1000']);
      assert.equal(result.code, 1);
      assert.equal(result.answer.error.code, 'DEVICE_CLAIM_INTERVAL_INVALID');
    }
    noGrant(vault);
  });

  console.log(`online-fra-claim-cli: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
