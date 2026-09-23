'use strict';
// A PROTOCOL-POISONED ACP SESSION MUST END, NOT LINGER LOOKING READY.
//
// Owner hand test, LIVE engine 2759700d: the first resumed Grok host session
// c15acc36-4711-4097-91d1-76f90bf53a5e refused every send with
// ACP_PROTOCOL_INVALID, stayed registered in the host's sessionAccounts, and
// its native CLI (pid 800547) kept running with no further events. Only an
// explicit mcAgent.close recovered it.
//
// _failClosed unsubscribed its reader, rejected pending work and cleared its
// maps -- and stopped there. The child it owned was never closed, so the host,
// which learns a session is over by observing that process actually complete
// (the app's observeEngineExit subscribes the same transport.onData seam used
// below), was never told anything at all.
//
// The fixture child here answers ACP correctly and then returns a response
// carrying an id nobody requested. Strict response matching refuses it, which
// is deliberately left exactly as it was: this file proves the TERMINAL
// behaviour after that refusal, never that malformed traffic is acceptable.
// /evidence/grok-resume-wire-metadata.json is too limited to name the original
// unknown response, so nothing here claims to reproduce that exact wire.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AcpAdapter } = require('../../src/lib/agent-engine/acp-adapter');
const { createCodexProcessTransport } = require('../../src/lib/agent-engine/codex-process');

const POISON_AGENT = path.join(__dirname, '..', 'fixtures', 'acp-protocol-poison.cjs');

async function waitFor(predicate, label, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const running = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

function poisonedSession(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-acp-poison-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, 'agent.pid');
  const transport = createCodexProcessTransport({
    command: process.execPath, args: [POISON_AGENT], cwd: directory,
    env: { ...process.env, ACP_POISON_PID_FILE: pidFile },
  });
  // The host's own observer, subscribed the way the app subscribes it.
  const exits = [];
  transport.onData((_chunk, exitInfo) => { if (exitInfo) exits.push(exitInfo); });
  const adapter = new AcpAdapter({ transport, defaultCwd: directory, mcpServers: [] });
  t.after(() => { try { adapter.close(); } finally { transport.close(); } });
  const pid = async () => {
    await waitFor(() => fs.existsSync(pidFile), 'the fixture agent records its pid');
    return Number(fs.readFileSync(pidFile, 'utf8').trim());
  };
  return { adapter, transport, exits, pid, directory };
}

test('malformed protocol from a real child closes the process, and the host sees it complete', async t => {
  const session = poisonedSession(t);
  await session.adapter.initialize();
  const { threadId } = await session.adapter.startThread({ cwd: session.directory });
  const pid = await session.pid();
  assert.equal(running(pid), true, 'the fixture agent is alive before the poisoned turn');

  await assert.rejects(session.adapter.sendTurn({ threadId, text: 'anything' }),
    error => error.code === 'ACP_PROTOCOL_INVALID');

  await waitFor(() => !running(pid), 'the process the poisoned session owned has exited');
  await waitFor(() => session.exits.length === 1, 'the transport reports that exit to the host observer');
  assert.equal(session.exits.length, 1, 'completion is reported once, not repeatedly');
});

test('nothing usable is left behind: the session refuses every later call', async t => {
  const session = poisonedSession(t);
  await session.adapter.initialize();
  const { threadId } = await session.adapter.startThread({ cwd: session.directory });
  const pid = await session.pid();
  await assert.rejects(session.adapter.sendTurn({ threadId, text: 'first' }),
    error => error.code === 'ACP_PROTOCOL_INVALID');
  await waitFor(() => !running(pid), 'the owned process has exited');

  for (const call of [
    () => session.adapter.sendTurn({ threadId, text: 'again' }),
    () => session.adapter.resumeThread(threadId),
    () => session.adapter.interrupt({ threadId, turnId: 'acp-turn-anything-1' }),
  ]) await assert.rejects(call(), error => error.code === 'ACP_PROTOCOL_INVALID');
  assert.equal(running(pid), false, 'no stranded process remains for a session that refuses everything');
});

/* ---------- owned shutdown, and the custody of an unproven kill ---------- */

// A wire transport that answers the few methods these cases need. Each fake
// records whether the adapter reached for the protocol kill, which is the one
// door an explicit close must not use.
function wire({ protocolFailure = null } = {}) {
  let listener = null;
  const calls = { close: 0, protocolFailure: 0 };
  const transport = {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write(line) {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      queueMicrotask(() => {
        if (!listener) return;
        const reply = result => listener(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
        if (request.method === 'initialize') {
          reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
        } else if (request.method === 'session/new') reply({ sessionId: 'wire-session' });
        else if (request.method === 'session/load') reply({});
        else if (request.method === 'session/prompt') {
          listener(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: request.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WORDS' } },
          } })}\n`);
          reply({ stopReason: 'end_turn' });
        } else reply({});
      });
    },
    close() { calls.close += 1; },
    poison() { listener?.(`${JSON.stringify({ jsonrpc: '2.0', id: 999_001, result: {} })}\n`); },
  };
  if (protocolFailure) {
    transport.closeForProtocolFailure = () => {
      calls.protocolFailure += 1;
      return protocolFailure(calls.protocolFailure);
    };
  }
  return { transport, calls };
}

async function ready(transport, options = {}) {
  const adapter = new AcpAdapter({ transport, defaultCwd: '/workspace', mcpServers: [], ...options });
  await adapter.initialize();
  const { threadId } = await adapter.startThread({ cwd: '/workspace' });
  return { adapter, threadId };
}

test('an explicit close owns its own shutdown and never reaches for the protocol kill', async () => {
  const { transport, calls } = wire({ protocolFailure: () => Promise.resolve() });
  const { adapter } = await ready(transport);
  adapter.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.protocolFailure, 0, 'close() must leave the transport to its owner');
  assert.equal(calls.close, 0, 'the adapter does not close a transport it was handed');
  assert.throws(() => adapter.onEvent(() => {}), error => error.code === 'ACP_ADAPTER_CLOSED');
});

test('a protocol failure closes the transport exactly once and refuses pending work with the same error', async () => {
  const { transport, calls } = wire({ protocolFailure: () => Promise.resolve() });
  const { adapter, threadId } = await ready(transport);
  const turn = adapter.sendTurn({ threadId, text: 'hello' });
  transport.poison();
  await assert.rejects(turn, error => error.code === 'ACP_PROTOCOL_INVALID');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.protocolFailure, 1);
  adapter.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.protocolFailure, 1, 'a proven closure is not requested again');
});

test('a wire transport with no child fails closed without inventing a closure', async () => {
  const { transport, calls } = wire();
  const { adapter, threadId } = await ready(transport);
  const turn = adapter.sendTurn({ threadId, text: 'hello' });
  transport.poison();
  await assert.rejects(turn, error => error.code === 'ACP_PROTOCOL_INVALID');
  assert.equal(calls.close, 0);
  assert.doesNotThrow(() => adapter.close());
});

test('an unproven kill keeps its retry handle, and a later close uses that same handle', async () => {
  const { transport, calls } = wire({
    protocolFailure: attempt => attempt === 1
      ? Promise.reject(Object.assign(new Error('cleanup unproven'), { code: 'CODEX_PROCESS_CLEANUP_UNPROVEN' }))
      : Promise.resolve(),
  });
  const { adapter, threadId } = await ready(transport);
  const turn = adapter.sendTurn({ threadId, text: 'hello' });
  transport.poison();
  const failure = await turn.then(() => null, error => error);
  assert.equal(failure.code, 'ACP_PROTOCOL_INVALID');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.protocolFailure, 1);
  assert.equal(typeof failure.retryCleanup, 'function', 'an unproven closure retains its retry handle');
  adapter.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.protocolFailure, 2, 'close retried the retained handle instead of giving up');
  adapter.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.protocolFailure, 2, 'once proven, it is not requested again');
});
