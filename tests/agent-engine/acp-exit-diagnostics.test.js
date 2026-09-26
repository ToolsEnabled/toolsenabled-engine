'use strict';
// Exercise the actual process transport: a child exit must preserve the
// available status, signal and bounded stderr when rejecting pending work.
// These controlled failures do not reproduce the intermittent native Grok exit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AcpAdapter } = require('../../src/lib/agent-engine/acp-adapter');
const { createCodexProcessTransport } = require('../../src/lib/agent-engine/codex-process');

const REPORTER = path.join(__dirname, '..', 'fixtures', 'acp-exit-reporter.cjs');

async function waitFor(predicate, label, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function reporter(t, { mode = 'code', status = 7, complaint = '', command = process.execPath, args = [REPORTER] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-acp-exit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, 'agent.pid');
  const transport = createCodexProcessTransport({
    command, args, cwd: directory,
    env: { ...process.env, ACP_EXIT_MODE: mode, ACP_EXIT_STATUS: String(status),
      ACP_EXIT_COMPLAINT: complaint, ACP_EXIT_PID_FILE: pidFile },
  });
  const adapter = new AcpAdapter({ transport, defaultCwd: directory, mcpServers: [] });
  t.after(() => { try { adapter.close(); } finally { transport.close(); } });
  const pid = async () => {
    await waitFor(() => fs.existsSync(pidFile), 'the fixture agent records its pid');
    return Number(fs.readFileSync(pidFile, 'utf8').trim());
  };
  return { adapter, transport, pid, directory };
}

async function ready(session) {
  await session.adapter.initialize();
  const { threadId } = await session.adapter.startThread({ cwd: session.directory });
  return threadId;
}

test('a child that dies with a status and a complaint reports both to the pending turn', async t => {
  const session = reporter(t, { status: 7, complaint: 'grok: fatal runtime error while reloading skills' });
  const threadId = await ready(session);

  const error = await session.adapter.sendTurn({ threadId, text: 'anything' }).then(
    () => assert.fail('the turn cannot succeed when the program underneath it exits'),
    failure => failure);

  assert.equal(error.code, 'ACP_PROCESS_EXITED', 'the classified code is unchanged');
  assert.match(error.message, /exit code 7/, 'the status the child actually returned');
  assert.match(error.message, /fatal runtime error while reloading skills/,
    'what the child said on its way out');
  assert.notEqual(error.message, 'The ACP program exited.',
    'the generic sentence must not replace available exit information');
  assert.deepEqual({ code: error.exit.code, signal: error.exit.signal, spawnError: error.exit.spawnError },
    { code: 7, signal: null, spawnError: null }, 'structured, not only prose');
  assert.match(error.exit.stderr, /fatal runtime error/);
});

test('a killed child reports its signal instead of inventing an exit status', async t => {
  const session = reporter(t, { mode: 'signal' });
  const threadId = await ready(session);
  const pid = await session.pid();

  const turn = session.adapter.sendTurn({ threadId, text: 'anything' }).then(
    () => assert.fail('the turn cannot succeed when the program is killed'),
    failure => failure);
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }

  const error = await turn;
  assert.equal(error.code, 'ACP_PROCESS_EXITED');
  // MEASURED, and the reason this case allows two shapes: killing a child
  // breaks its stdin pipe and ends the process, and the transport reports
  // whichever the kernel delivers first. Both are real, and this ran both ways
  // across repeated runs. What must never happen is a fabricated status or the
  // bare sentence that told the owner nothing.
  assert.match(error.message, /signal SIGKILL|could not be run or reached/,
    'the death names itself, in whichever form arrived');
  assert.doesNotMatch(error.message, /exit code/, 'a killed process has no exit status to report');
  assert.equal(error.exit.code, null, 'no status is invented for a process that returned none');
  if (error.exit.signal === null) {
    assert.equal(typeof error.exit.spawnError, 'string', 'then the broken pipe is what is reported');
  } else {
    assert.equal(error.exit.signal, 'SIGKILL');
  }
});

test('a program that cannot be started at all reports the spawn failure', async t => {
  const session = reporter(t, { command: path.join(os.tmpdir(), 'toolsenabled-no-such-acp-program') });

  const error = await session.adapter.initialize().then(
    () => assert.fail('initialize cannot succeed when nothing was started'),
    failure => failure);

  assert.equal(error.code, 'ACP_PROCESS_EXITED');
  assert.match(error.message, /could not be run or reached:/, 'a missing program is not a mysterious exit');
  assert.equal(error.exit.code, null);
  assert.equal(typeof error.exit.spawnError, 'string');
});

test('the reported detail is bounded, and keeps the end of what the child said', async t => {
  const session = reporter(t, { mode: 'flood', status: 3, complaint: 'last words' });
  const threadId = await ready(session);

  const error = await session.adapter.sendTurn({ threadId, text: 'anything' }).then(
    () => assert.fail('the turn cannot succeed when the program underneath it exits'),
    failure => failure);

  assert.equal(error.code, 'ACP_PROCESS_EXITED');
  assert.match(error.message, /exit code 3/);
  assert.ok(error.exit.stderr.length <= 2_000,
    `the kept detail stays bounded, saw ${error.exit.stderr.length}`);
  assert.match(error.exit.stderr, /TAIL last words/,
    'the tail is what a dying program says last, so that is what is kept');
  assert.ok(error.message.length < 4_000, `the message stays bounded, saw ${error.message.length}`);
});

test('every later call on that session repeats the same account of the death', async t => {
  const session = reporter(t, { status: 9, complaint: 'grok: exiting' });
  const threadId = await ready(session);
  await assert.rejects(session.adapter.sendTurn({ threadId, text: 'first' }), { code: 'ACP_PROCESS_EXITED' });

  for (const call of [
    () => session.adapter.sendTurn({ threadId, text: 'again' }),
    () => session.adapter.resumeThread(threadId),
    () => session.adapter.interrupt({ threadId, turnId: 'acp-turn-anything-1' }),
  ]) {
    const error = await call().then(() => assert.fail('a dead session cannot accept work'), failure => failure);
    assert.equal(error.code, 'ACP_PROCESS_EXITED');
    assert.match(error.message, /exit code 9/, 'the reason is not lost on the second telling');
  }
});

test('an exit the transport cannot describe still fails closed, without inventing a cause', async t => {
  // A transport may report an exit with nothing in it. That is honest ignorance
  // and must read as such, not as a fabricated status.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-acp-exit-bare-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let listener = null;
  const transport = {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write(line) {
      const request = JSON.parse(line);
      if (request.method === 'initialize') {
        queueMicrotask(() => listener?.(`${JSON.stringify({ jsonrpc: '2.0', id: request.id,
          result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })}\n`));
      }
    },
    close() {}, closeForProtocolFailure() {}, closeForStartupFailure() {}
  };
  const adapter = new AcpAdapter({ transport, defaultCwd: directory, mcpServers: [] });
  await adapter.initialize();
  listener(null, {});

  const error = await adapter.startThread({ cwd: directory }).then(
    () => assert.fail('a closed adapter cannot start a thread'), failure => failure);
  assert.equal(error.code, 'ACP_PROCESS_EXITED');
  assert.match(error.message, /no exit status reported/, 'unknown is stated, not guessed');
  assert.deepEqual({ ...error.exit }, { code: null, signal: null, spawnError: null, stderr: '' });
});
