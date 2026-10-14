'use strict';
/* STOPPING A TURN'S NATIVE WORK WITHOUT ENDING THE SESSION.
 *
 * MEASURED on the native build (evidence grok-final-stop-report.json): the
 * provider Stop cancelled the model turn and the host.exec child it had asked
 * for -- an owned sixty-second command, pid 874779 -- REMAINED ALIVE until
 * root killed that exact pid by hand. The engine's cancellation authority sits
 * on the connection, and the only verbs that reached it (revokeSession,
 * close) retire the binding, so the one way to cancel that command was to
 * take the session's tools away for good.
 *
 * A provider's cancel does not wait either: the ACP adapter writes
 * session/cancel and returns, so a stop has to hold this session's admission
 * until the app resumes it, not merely abort what was already running.
 *
 * These cases drive the real owner host over a real socket, with the same
 * fixture shape owner-host-cancellation-cleanup.test.js uses for revoke.
 */
require('./lib/isolated-environment').activate('owner-host-session-cancel');
const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const ownerHost = require('../src/owner-host');

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('fixture deadline')), 5000);
  })]).finally(() => clearTimeout(timer));
}

// A socket data event is a chunk, not a response boundary. The preceding
// command's reply can arrive separately from the refusal we are waiting for.
function responseFor(socket, id) {
  let pending = '';
  let onData;
  const response = new Promise((resolve, reject) => {
    onData = chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.id === id) { resolve(entry); return; }
        } catch (error) { reject(error); return; }
      }
    };
    socket.on('data', onData);
  });
  return bounded(response).finally(() => socket.off('data', onData));
}

function fixture() {
  const seen = new Map();
  const pipeName = `\\\\.\\pipe\\ToolsEnabledSessionCancel-${process.pid}-${randomUUID()}`;
  const host = ownerHost.createOwnerHost({
    allowTestPaths: true, platform: 'test', pipeName, token: randomBytes(32),
    capabilityFile: path.join(process.env.TOOLSENABLED_TEST_ROOT, `${randomUUID()}.capability.json`),
    controlCapabilityFile: path.join(process.env.TOOLSENABLED_TEST_ROOT, `${randomUUID()}.control.json`),
    principals: { ownerPrincipal: 'TESTHOST\\cancel', clientPrincipal: 'TESTHOST\\cancel' },
    credentialHygiene() {}, sessionRetirementObserver() {}, authorizeAgentBinding: () => true,
    readInstalledOrg: principal => ({ roleRecord: { revision: 1, definition: { id: principal.roleId } } }),
    broker: {
      MAX_MESSAGE_BYTES: 1024 * 1024, resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }),
      createLineDispatcher: () => async (line, write, context, lane) => {
        const request = JSON.parse(line);
        const cleanup = deferred();
        const aborted = deferred();
        context.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        seen.get(`${lane}:${request.id}`)?.resolve({ context, cleanup, aborted });
        const code = await cleanup.promise;
        write({ jsonrpc: '2.0', id: request.id, result: typeof code === 'object'
          ? { structuredContent: code } : { isError: true, structuredContent: { error: { code } } } });
      }
    }
  });
  async function session(label, { provider = 'claude' } = {}) {
    const principal = { sessionId: `session-${label}`, agentId: `agent-${label}`, provider,
      roleId: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 };
    const bound = await host.bindSession(principal);
    const socket = net.connect({ path: pipeName });
    socket.on('error', () => {});
    await bounded(new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }));
    const authorized = bounded(new Promise(resolve => socket.once('data', resolve)));
    socket.write(`${JSON.stringify({ type: 'authorize-session', credential: bound.credential })}\n`);
    await authorized;
    const call = async (id, name = 'host.exec') => {
      const entered = deferred();
      seen.set(`${principal.sessionId}:${id}`, entered);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })}\n`);
      return bounded(entered.promise);
    };
    const identity = { ...principal, credential: bound.credential };
    return {
      socket, call, principal, credential: bound.credential,
      cancel: () => host.cancelSessionWork(identity),
      resume: () => host.resumeSessionWork(identity),
      revoke: () => host.revokeSession(identity),
      assert: () => host.assertSession(identity),
    };
  }
  return { host, session };
}

test('a session cancel aborts only its own in-flight command and waits for it to settle', async () => {
  const { host, session } = fixture();
  await host.listen();
  const mine = await session('mine');
  const other = await session('other');
  const running = await mine.call('exec-1');
  const elsewhere = await other.call('exec-1');
  try {
    let answered = false;
    const pending = mine.cancel().then(result => { answered = true; return result; });
    await bounded(running.aborted.promise);
    await tick();
    assert.equal(answered, false, 'the cancel must not answer before the command settles');
    assert.equal(elsewhere.context.signal.aborted, false, 'another session keeps working');
    running.cleanup.resolve('ABORT_ERR');
    const result = await bounded(pending);
    assert.equal(result.cancelled, 1);
    assert.equal(result.awaited, 1);
    assert.equal(result.reusable, true, 'the session is still bound after its work was stopped');
    assert.equal(elsewhere.context.signal.aborted, false);
  } finally {
    running.cleanup.resolve('ABORT_ERR');
    elsewhere.cleanup.resolve('ABORT_ERR');
    mine.socket.destroy();
    other.socket.destroy();
    await bounded(host.close());
  }
});

test('a stopped session runs again only after the app resumes it', async () => {
  const { host, session } = fixture();
  await host.listen();
  const mine = await session('reuse');
  const first = await mine.call('exec-1');
  try {
    const stopped = mine.cancel();
    await bounded(first.aborted.promise);
    first.cleanup.resolve('ABORT_ERR');
    const result = await bounded(stopped);
    assert.equal(result.reusable, true);
    assert.equal(result.held, true, 'a stop leaves the session held, not open for more work');
    assert.deepEqual(mine.assert(), { valid: true, mode: 'app-owned-owner-host' },
      'the credential still belongs to this exact session');

    // A provider whose cancel did not wait tries again straight away.
    const refusedAnswer = responseFor(mine.socket, 'late');
    mine.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'late', method: 'tools/call', params: { name: 'host.exec', arguments: {} } })}\n`);
    const refused = await refusedAnswer;
    assert.ok(refused, 'the late call must be answered');
    assert.equal(refused.error.data.code, 'OWNER_HOST_SESSION_WORK_REFUSED');
    assert.equal(refused.error.data.retryable, false, 'the agent must not retry a held session by itself');

    assert.deepEqual(await bounded(mine.resume()), { resumed: true, mode: 'app-owned-owner-host' });
    const next = await mine.call('exec-2');
    assert.equal(next.context.signal.aborted, false,
      'a stopped turn must not leave the connection unable to run anything');
    const answered = responseFor(mine.socket, 'exec-2');
    next.cleanup.resolve({ ok: true });
    await answered;
    assert.equal((await bounded(mine.cancel())).cancelled, 0, 'nothing is in flight once it answered');
  } finally {
    mine.socket.destroy();
    await bounded(host.close());
  }
});

test('a command that cannot prove its cleanup refuses the stop and keeps the session', async () => {
  const { host, session } = fixture();
  await host.listen();
  const mine = await session('unproven');
  const running = await mine.call('exec-1');
  try {
    const refused = assert.rejects(mine.cancel(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });
    await bounded(running.aborted.promise);
    running.cleanup.resolve('HOST_EXEC_TERMINATION_FAILED');
    await bounded(refused);
    assert.deepEqual(mine.assert(), { valid: true, mode: 'app-owned-owner-host' },
      'an unproven kill is reported, and does not retire the session by itself');
  } finally {
    mine.socket.destroy();
    await bounded(host.close()).catch(() => {});
  }
});

test('a credential that is not that session cannot stop its work', async () => {
  const { host, session } = fixture();
  await host.listen();
  const mine = await session('owned');
  const other = await session('intruder');
  const running = await mine.call('exec-1');
  try {
    await assert.rejects(host.cancelSessionWork({ ...mine.principal, credential: other.credential }),
      { code: 'OWNER_HOST_SESSION_REFUSED' });
    await assert.rejects(host.cancelSessionWork({ ...other.principal, credential: mine.credential }),
      { code: 'OWNER_HOST_SESSION_REFUSED' });
    await tick();
    assert.equal(running.context.signal.aborted, false, 'a refused stop must not abort anything');
  } finally {
    running.cleanup.resolve('ABORT_ERR');
    mine.socket.destroy();
    other.socket.destroy();
    await bounded(host.close());
  }
});

test('a stopped session can still be revoked, and revoke still drains its work', async () => {
  const { host, session } = fixture();
  await host.listen();
  const mine = await session('then-revoked');
  const first = await mine.call('exec-1');
  try {
    const stopped = mine.cancel();
    await bounded(first.aborted.promise);
    first.cleanup.resolve('ABORT_ERR');
    await bounded(stopped);
    await bounded(mine.resume());
    const second = await mine.call('exec-2');
    let revoked = false;
    const pending = mine.revoke().then(result => { revoked = true; return result; });
    await bounded(second.aborted.promise);
    await tick();
    assert.equal(revoked, false, 'revoke still waits for the command it aborted');
    second.cleanup.resolve('ABORT_ERR');
    assert.equal((await bounded(pending)).revoked, true);
    assert.throws(() => mine.assert(), { code: 'OWNER_HOST_SESSION_REFUSED' });
  } finally {
    mine.socket.destroy();
    await bounded(host.close());
  }
});

test('a line already queued behind the stopped command is refused, not started', async () => {
  const { host, session } = fixture();
  await host.listen();
  const mine = await session('queued');
  const running = await mine.call('exec-1');
  try {
    /* The second line waits on the serial chain, so it reaches admission only
       after the stop has latched. Nothing must start it. */
    const answers = [];
    mine.socket.on('data', chunk => {
      for (const entry of String(chunk).split('\n').filter(Boolean)) answers.push(JSON.parse(entry));
    });
    mine.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'queued', method: 'tools/call', params: { name: 'host.exec', arguments: {} } })}\n`);
    const stopped = mine.cancel();
    await bounded(running.aborted.promise);
    running.cleanup.resolve('ABORT_ERR');
    await bounded(stopped);
    for (let round = 0; round < 200 && !answers.some(entry => entry.id === 'queued'); round += 1) await tick();
    const refused = answers.find(entry => entry.id === 'queued');
    assert.ok(refused, 'the queued line must be answered');
    assert.equal(refused.error.data.code, 'OWNER_HOST_SESSION_WORK_REFUSED',
      'a queued command must not run behind a stop');
  } finally {
    mine.socket.destroy();
    await bounded(host.close());
  }
});

test('an unproven cleanup refuses the resume too, and the session stays held', async () => {
  const { host, session } = fixture();
  await host.listen();
  const mine = await session('no-resume');
  const running = await mine.call('exec-1');
  try {
    const refusedStop = assert.rejects(mine.cancel(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });
    await bounded(running.aborted.promise);
    running.cleanup.resolve('HOST_EXEC_TERMINATION_FAILED');
    await bounded(refusedStop);

    /* The engine cannot retry that kill: the handle died with the call that
       reported it. So the failure keeps refusing rather than being cleared. */
    await assert.rejects(mine.resume(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });
    await assert.rejects(mine.resume(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });
    await assert.rejects(mine.cancel(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });

    const answer = responseFor(mine.socket, 'after');
    mine.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'after', method: 'tools/call', params: { name: 'host.exec', arguments: {} } })}\n`);
    const refused = await answer;
    assert.equal(refused.error.data.code, 'OWNER_HOST_SESSION_WORK_REFUSED',
      'a refused resume must leave the session held');
  } finally {
    mine.socket.destroy();
    await bounded(host.close()).catch(() => {});
  }
});

test('only that exact session credential can resume its work', async () => {
  const { host, session } = fixture();
  await host.listen();
  const mine = await session('resume-guard');
  const other = await session('resume-intruder');
  const running = await mine.call('exec-1');
  try {
    const stopped = mine.cancel();
    await bounded(running.aborted.promise);
    running.cleanup.resolve('ABORT_ERR');
    await bounded(stopped);
    await assert.rejects(host.resumeSessionWork({ ...mine.principal, credential: other.credential }),
      { code: 'OWNER_HOST_SESSION_REFUSED' });
    await assert.rejects(host.resumeSessionWork({ ...other.principal, credential: mine.credential }),
      { code: 'OWNER_HOST_SESSION_REFUSED' });
    const answer = responseFor(mine.socket, 'still-held');
    mine.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'still-held', method: 'tools/call', params: { name: 'host.exec', arguments: {} } })}\n`);
    const refused = await answer;
    assert.equal(refused.error.data.code, 'OWNER_HOST_SESSION_WORK_REFUSED',
      'a refused resume from another credential must not lift the latch');
  } finally {
    mine.socket.destroy();
    other.socket.destroy();
    await bounded(host.close());
  }
});

/* ---------- the spelling the failing provider actually sends ----------
 *
 * Grok 1.0.25 does not discover dotted tool names, so mcp-server advertises
 * that actor a mechanical host.exec -> host_exec alias and canonicalizes it
 * after this barrier. A stop that recognises only the dotted name aborts
 * Grok's signal and then proves nothing about its child. */

test('a Grok wire-alias command is awaited by the stop, not merely aborted', async () => {
  const { host, session } = fixture();
  await host.listen();
  const mine = await session('grok-alias', { provider: 'grok' });
  const running = await mine.call('exec-1', 'host_exec');
  try {
    let answered = false;
    const pending = mine.cancel().then(result => { answered = true; return result; });
    await bounded(running.aborted.promise);
    await tick();
    assert.equal(answered, false, 'host_exec is a native command and must be waited for');
    running.cleanup.resolve('ABORT_ERR');
    const result = await bounded(pending);
    assert.equal(result.cancelled, 1);
    assert.equal(result.awaited, 1, 'the aliased command must be counted as drained');
  } finally {
    running.cleanup.resolve('ABORT_ERR');
    mine.socket.destroy();
    await bounded(host.close());
  }
});

test('a Grok wire-alias command that cannot prove its cleanup refuses the stop and the resume', async () => {
  const { host, session } = fixture();
  await host.listen();
  const mine = await session('grok-unproven', { provider: 'grok' });
  const running = await mine.call('exec-1', 'host_exec');
  try {
    const refused = assert.rejects(mine.cancel(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });
    await bounded(running.aborted.promise);
    running.cleanup.resolve('HOST_EXEC_TERMINATION_FAILED');
    await bounded(refused);
    await assert.rejects(mine.resume(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' },
      'an unproven aliased command must not be resumed away');
  } finally {
    mine.socket.destroy();
    await bounded(host.close()).catch(() => {});
  }
});

test('revoke drains and reports a Grok wire-alias command through the same tracker', async () => {
  const { host, session } = fixture();
  await host.listen();
  let draining, first, failing, second;
  try {
    draining = await session('grok-revoke', { provider: 'grok' });
    first = await draining.call('exec-1', 'host_exec');
    let acknowledged = false;
    const pending = draining.revoke().then(result => { acknowledged = true; return result; });
    await bounded(first.aborted.promise);
    await tick();
    assert.equal(acknowledged, false, 'revoke must wait for the aliased command too');
    first.cleanup.resolve('ABORT_ERR');
    assert.equal((await bounded(pending)).revoked, true);

    failing = await session('grok-revoke-failed', { provider: 'grok' });
    second = await failing.call('exec-1', 'host_exec');
    const refused = assert.rejects(failing.revoke(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });
    await bounded(second.aborted.promise);
    second.cleanup.resolve('HOST_EXEC_TERMINATION_FAILED');
    await bounded(refused);
  } finally {
    // Failed assertions must also release this real socket fixture. Otherwise
    // removing alias tracking catches the regression but leaves the test open.
    first?.cleanup.resolve('ABORT_ERR');
    second?.cleanup.resolve('ABORT_ERR');
    draining?.socket.destroy();
    failing?.socket.destroy();
    await bounded(host.close()).catch(() => {});
  }
});

test('no other tool name becomes a native-command barrier', async () => {
  const { host, session } = fixture();
  await host.listen();
  const grok = await session('grok-other-tool', { provider: 'grok' });
  const claude = await session('claude-alias', { provider: 'claude' });
  const reading = await grok.call('read-1', 'host_read_file');
  const misspelled = await claude.call('exec-1', 'host_exec');
  try {
    /* Both are aborted, because every call is cancellable. Neither is waited
       for: one is not a command, and the other is a name this actor was never
       advertised, which the dispatcher refuses on its own. */
    const grokStop = await bounded(grok.cancel());
    assert.equal(grokStop.cancelled, 1);
    assert.equal(grokStop.awaited, 0, 'a read must not be treated as a native command');
    assert.equal(reading.context.signal.aborted, true, 'it is still cancelled');

    const claudeStop = await bounded(claude.cancel());
    assert.equal(claudeStop.cancelled, 1);
    assert.equal(claudeStop.awaited, 0, 'the alias belongs to the Grok actor alone');
    assert.equal(misspelled.context.signal.aborted, true);
  } finally {
    reading.cleanup.resolve('ABORT_ERR');
    misspelled.cleanup.resolve('ABORT_ERR');
    grok.socket.destroy();
    claude.socket.destroy();
    await bounded(host.close());
  }
});
