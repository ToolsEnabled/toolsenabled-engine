'use strict';
require('./lib/isolated-environment').activate('owner-host-cancellation-cleanup');
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
function fixture() {
  const seen = new Map();
  const pipeName = `\\\\.\\pipe\\ToolsEnabledCancellationCleanup-${process.pid}-${randomUUID()}`;
  const host = ownerHost.createOwnerHost({
    allowTestPaths: true, platform: 'test', pipeName, token: randomBytes(32),
    capabilityFile: path.join(process.env.TOOLSENABLED_TEST_ROOT, `${randomUUID()}.capability.json`),
    controlCapabilityFile: path.join(process.env.TOOLSENABLED_TEST_ROOT, `${randomUUID()}.control.json`),
    principals: { ownerPrincipal: 'TESTHOST\\cleanup', clientPrincipal: 'TESTHOST\\cleanup' },
    credentialHygiene() {}, sessionRetirementObserver() {}, authorizeAgentBinding: () => true,
    readInstalledOrg: principal => ({ roleRecord: { revision: 1, definition: { id: principal.roleId } } }),
    broker: {
      MAX_MESSAGE_BYTES: 1024 * 1024, resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }),
      createLineDispatcher: () => async (line, write, context, lane) => {
        const request = JSON.parse(line);
        const cleanup = deferred();
        const aborted = deferred();
        context.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        seen.get(lane).resolve({ context, cleanup, aborted });
        const code = await cleanup.promise;
        write({ jsonrpc: '2.0', id: request.id, result: typeof code === 'object'
          ? { structuredContent: code } : { isError: true, structuredContent: { error: { code } } } });
      }
    }
  });
  async function start(label) {
    const principal = { sessionId: `session-${label}`, agentId: `agent-${label}`, provider: 'claude',
      roleId: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 };
    const bound = await host.bindSession(principal);
    const socket = net.connect({ path: pipeName });
    socket.on('error', () => {});
    await bounded(new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }));
    const authorized = bounded(new Promise(resolve => socket.once('data', resolve)));
    socket.write(`${JSON.stringify({ type: 'authorize-session', credential: bound.credential })}\n`);
    await authorized;
    const entered = deferred();
    seen.set(principal.sessionId, entered);
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: label, method: 'tools/call', params: { name: 'host.exec', arguments: {} } })}\n`);
    const invocation = await bounded(entered.promise);
    return { ...invocation, socket, revoke: () => host.revokeSession({ ...principal, credential: bound.credential }) };
  }
  return { host, start };
}

test('session revoke awaits cancelled native-command settlement and leaves another binding live', async () => {
  const { host, start } = fixture();
  await host.listen();
  const first = await start('first');
  const other = await start('other');
  try {
    let acknowledged = false;
    const pending = first.revoke().then(result => { acknowledged = true; return result; });
    await bounded(first.aborted.promise);
    await tick();
    assert.equal(acknowledged, false);
    assert.equal(other.context.signal.aborted, false);
    first.cleanup.resolve('ABORT_ERR');
    assert.equal((await bounded(pending)).revoked, true);
  } finally {
    first.cleanup.resolve('ABORT_ERR');
    other.cleanup.resolve('ABORT_ERR');
    first.socket.destroy();
    other.socket.destroy();
    await bounded(host.close());
  }
});

test('cleanup failure remains a refusal on revoke retries and repeated host close', async () => {
  const { host, start } = fixture();
  await host.listen();
  const running = await start('failure');
  const pending = running.revoke();
  const refusal = assert.rejects(pending, { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });
  await bounded(running.aborted.promise);
  running.cleanup.resolve('HOST_EXEC_TERMINATION_FAILED');
  await bounded(refusal);
  await assert.rejects(running.revoke(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });
  await assert.rejects(host.close(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });
  await assert.rejects(host.close(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });
  running.socket.destroy();
});

test('a disconnected connection aborts its command before later revoke drains it', async () => {
  const { host, start } = fixture();
  await host.listen();
  const running = await start('disconnect');
  running.socket.destroy();
  await bounded(running.aborted.promise);
  let acknowledged = false;
  const pending = running.revoke().then(result => { acknowledged = true; return result; });
  await tick();
  assert.equal(acknowledged, false);
  running.cleanup.resolve('ABORT_ERR');
  assert.equal((await bounded(pending)).revoked, true);
  await host.close();
});

test('an earlier timeout cleanup failure cannot turn into success when the session later closes', async () => {
  const { host, start } = fixture();
  await host.listen();
  const running = await start('earlier-timeout');
  const answered = bounded(new Promise(resolve => running.socket.once('data', resolve)));
  running.cleanup.resolve({ ok: false, timedOut: true, terminationFailure: { code: 'WINDOWS_JOB_CONTROL_UNAVAILABLE' } });
  await answered;
  await assert.rejects(running.revoke(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });
  await assert.rejects(host.close(), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' });
  running.socket.destroy();
});
