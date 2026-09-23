'use strict';
// A unix socket path binds into sun_path, which is 108 bytes on Linux INCLUDING
// the terminator. libuv does not fail an over-long path -- it TRUNCATES it. The
// consequence is measured, not theoretical: listen() fires its success callback,
// reports no error, creates nothing at the requested path, and leaves a socket at
// the 108-byte truncation instead. Two different logical paths that share their
// first 108 bytes then collide, and the second bind fails EADDRINUSE against a
// socket its own process created under a name it never asked for.
//
// That is what broke tests/owner-host-start-admission.test.js subtest 8: this
// runner nested its per-file root deeply enough that the test's socket path
// reached 158 bytes, every socket in that directory truncated to one name, and
// the subtest's second host collided with its first. The forge / transfer /
// retarget assertions below that bind never executed at all.
//
// So this asserts the runner's own output, by BEHAVIOUR: take the per-file
// isolated root the runner actually hands a test, and (1) check a conventional
// socket leaf still fits the budget, and (2) actually bind there and require the
// socket to exist at the path that was asked for. (2) is the one that matters --
// it fails on a truncating path even if the arithmetic in (1) is ever wrong.
const { activate } = require('./lib/isolated-environment');
activate('sockbudget');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// Below the 108-byte kernel limit with margin, so an ordinary leaf name change
// does not silently spend the last free byte.
const SOCKET_PATH_BUDGET = 100;
// The shape these suites actually use: "/<uuid>.sock".
const CONVENTIONAL_LEAF = `/${crypto.randomUUID()}.sock`;

function runnerPerFileRoot() {
  // Ask the real runner, through its real entry point, for the root it gives a
  // test file. Reading the constant out of the source instead would pin a
  // spelling and keep passing after the runner changed.
  //
  // The probe has to live inside the repository: the runner refuses to run a
  // test outside it, which is a guard worth keeping, so this works with it
  // rather than around it. The report lands outside, so the runner's own
  // cleanup of its scratch root cannot take it.
  const probe = path.join(ROOT, 'tests', `socket-budget-probe-${crypto.randomUUID()}.js`);
  const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sockprobe-'));
  const report = path.join(reportDirectory, 'root.txt');
  fs.writeFileSync(probe, [
    "'use strict';",
    "const { activate } = require('./lib/isolated-environment');",
    'const isolated = activate("probe");',
    'require("node:fs").writeFileSync(' + JSON.stringify(report) + ', isolated.root);',
  ].join('\n'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tests/run-isolated.js'), probe], {
      cwd: ROOT, stdio: 'pipe', timeout: 120000, windowsHide: true,
    });
    return fs.readFileSync(report, 'utf8').trim();
  } finally {
    fs.rmSync(probe, { force: true });
    fs.rmSync(reportDirectory, { recursive: true, force: true });
  }
}

test('a socket path under the runner per-file root fits the unix sun_path budget', {
  skip: process.platform === 'win32' ? 'Windows uses named pipes; the native address and connection are tested below' : false
}, () => {
  const root = runnerPerFileRoot();
  assert.ok(root.length > 0, 'the runner must report a per-file isolated root');
  const socketPath = root + CONVENTIONAL_LEAF;
  assert.ok(Buffer.byteLength(socketPath, 'utf8') < SOCKET_PATH_BUDGET,
    `runner-produced socket path is ${Buffer.byteLength(socketPath, 'utf8')} bytes, `
    + `which is not under the ${SOCKET_PATH_BUDGET}-byte budget. Root: ${root}`);
});

test('the runner fixture binds and connects through its exact native socket address', { timeout: 10000 }, async () => {
  const root = runnerPerFileRoot();
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\te-sock-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 16)}-${crypto.randomUUID()}`
    : root + CONVENTIONAL_LEAF;
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const marker = crypto.randomUUID();
  const server = net.createServer(socket => socket.end(marker));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    assert.equal(server.address(), socketPath, 'the native listener retains the requested address');
    if (process.platform !== 'win32') assert.ok(fs.existsSync(socketPath),
      'listen() reported success but produced no socket at the requested path -- '
      + `the path was truncated into sun_path. ${Buffer.byteLength(socketPath, 'utf8')} bytes: ${socketPath}`);
    const received = await new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath);
      let output = '';
      client.setEncoding('utf8');
      client.once('error', reject);
      client.on('data', chunk => { output += chunk; });
      client.once('end', () => resolve(output));
    });
    assert.equal(received, marker, 'the exact requested address reaches this retained listener');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
