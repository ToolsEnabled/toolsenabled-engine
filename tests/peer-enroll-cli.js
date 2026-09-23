'use strict';

// THE LISTENER'S LIFECYCLE IS PART OF FAILING CLOSED, AND UNIT TESTS CANNOT SEE IT.
//
// `tests/peer-enrollment.js` proves the protocol refuses a replayed, expired, or
// guessed code. That is necessary and not sufficient: a listener that keeps
// accepting connections after its offer is dead would leave the refusals correct
// and the product still wrong. These tests drive the real CLI as real processes
// and assert on the SOCKET, not just the return value:
//
//   * a successful pairing closes the listener, so the code cannot be spent twice;
//   * a voided offer closes the listener, so guessing cannot continue;
//   * an expired offer closes the listener on its own with nobody watching.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'tools', 'peer-enroll.js');

// Fixed high ports, distinct per test, so a failure names which test held one.
const PORTS = { success: 8871, void: 8872, expiry: 8873 };

function tempRoot(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `peer-cli-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: REPO });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

/** Start `invite` and resolve once it has printed a usable code. */
function startInvite(t, { root, port, minutes }) {
  return new Promise((resolve, reject) => {
    const args = ['invite', '--root', root, '--port', String(port)];
    if (minutes !== undefined) args.push('--minutes', String(minutes));
    const child = spawn(process.execPath, [CLI, ...args], { cwd: REPO });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const closed = new Promise(done => child.on('close', code => done({ code, stdout, stderr })));
    t.after(() => { if (!child.killed) child.kill(); });

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/--address (\S+) --code (\S+)/);
      if (match && !resolved) {
        resolved = true;
        resolve({ address: match[1], code: match[2], closed });
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', () => { if (!resolved) reject(new Error(`invite exited early: ${stdout}${stderr}`)); });
  });
}

/** Is anything accepting connections on this port? */
function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(3000, () => settle(false));
  });
}

test('a successful pairing CLOSES the listener, so the code cannot be spent twice', async (t) => {
  const offerRoot = tempRoot(t, 'ok-a');
  const joinRoot = tempRoot(t, 'ok-b');
  const invite = await startInvite(t, { root: offerRoot, port: PORTS.success });
  assert.equal(await isListening(PORTS.success), true, 'the listener must be up while a code is live');

  const joined = await runCli(['join', '--address', invite.address, '--code', invite.code, '--root', joinRoot]);
  assert.equal(joined.code, 0, `join should succeed: ${joined.stderr}`);

  const inviteResult = await invite.closed;
  assert.equal(inviteResult.code, 0);
  assert.equal(await isListening(PORTS.success), false, 'a spent offer must not keep listening');

  // And the second attempt cannot even reach a socket, let alone redeem.
  const replay = await runCli(['join', '--address', invite.address, '--code', invite.code, '--root', joinRoot]);
  assert.notEqual(replay.code, 0, 'a replayed code must not succeed');
});

test('a VOIDED offer closes the listener, so guessing cannot continue', async (t) => {
  const offerRoot = tempRoot(t, 'void-a');
  const joinRoot = tempRoot(t, 'void-b');
  const invite = await startInvite(t, { root: offerRoot, port: PORTS.void });

  // Three wrong codes exhaust the attempt budget; the fourth finds the offer void.
  const wrongCodes = ['TE-AAAA-BBBB', 'TE-CCCC-DDDD', 'TE-EEEE-FFFF', 'TE-GGGG-HHHH'];
  const outcomes = [];
  for (const wrong of wrongCodes) {
    const attempt = await runCli(['join', '--address', invite.address, '--code', wrong, '--root', joinRoot]);
    outcomes.push(attempt.code);
  }
  assert.ok(outcomes.every(code => code !== 0), 'no wrong code may ever succeed');

  const inviteResult = await invite.closed;
  assert.notEqual(inviteResult.code, 0, 'a voided pairing must not report success');
  assert.equal(await isListening(PORTS.void), false, 'a voided offer must stop listening');

  // Even the genuinely correct code is now useless, which is the point.
  const honest = await runCli(['join', '--address', invite.address, '--code', invite.code, '--root', joinRoot]);
  assert.notEqual(honest.code, 0);
});

test('an EXPIRED offer closes its own listener with nobody watching', async (t) => {
  const offerRoot = tempRoot(t, 'exp-a');
  // 0 minutes clamps to the module's 1s floor, so this expires promptly.
  const invite = await startInvite(t, { root: offerRoot, port: PORTS.expiry, minutes: 0 });
  const inviteResult = await invite.closed;
  assert.notEqual(inviteResult.code, 0, 'an expired pairing must not report success');
  assert.match(inviteResult.stdout, /expired/i, 'the person must be told why it stopped');
  assert.equal(await isListening(PORTS.expiry), false, 'an expired offer must stop listening on its own');
});

test('status on a machine that has paired with nobody is calm, silent, and successful', async (t) => {
  const root = tempRoot(t, 'absent');
  const result = await runCli(['status', '--root', root]);
  assert.equal(result.code, 0, 'having one computer is not an error');
  assert.equal(result.stderr, '', 'having one computer must produce no error output');
  assert.doesNotMatch(result.stdout, /error|fail|missing|not configured|warning/i);
  assert.match(result.stdout, /working on its own/i);
});
