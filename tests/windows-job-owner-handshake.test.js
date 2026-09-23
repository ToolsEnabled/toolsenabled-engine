'use strict';
// Preparation only: fake child, socket, filesystem and clock. No process launch.
// Exercises public lifecycle promises and observable connection/write effects.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const jobs = require('../src/lib/windows-job-control');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(hooks = {}) {
  let clock = 0;
  let finishPreparation;
  let rejectPreparation;
  const preparation = new Promise((resolve, reject) => { finishPreparation = resolve; rejectPreparation = reject; });
  const files = new Map();
  const timers = new Map();
  const effects = { connects: [], writes: [], kills: 0, checks: 0 };
  const native = new EventEmitter();
  native.pid = 4242;
  native.kill = () => { effects.kills++; return true; }; // Close is independent.
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = value => { effects.writes.push(value.split(' ')[0]); return true; };
  const child = jobs.spawnInJob('inert-fixture', [], { cwd: path.resolve(__dirname), env: {} }, {
    platform: 'win32', spawnImpl: () => native,
    safeLaunchEnvironment: value => value,
    recordDirectory: path.resolve(__dirname, 'in-memory-only'),
    assemblyCacheDirectory: null,
    fsImpl: {
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      mkdirSync: () => {},
      writeFileSync: (file, value) => files.set(file, value),
      renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); hooks.persisted?.(); },
      unlinkSync: file => files.delete(file),
      readFileSync: file => { if (files.has(file)) return files.get(file); throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }
    },
    handshakeTimeoutMs: 2000,
    now: () => clock,
    setTimeoutImpl: (fn, delay) => { const handle = { unref() {} }; timers.set(handle, { fn, due: clock + delay }); return handle; },
    clearTimeoutImpl: handle => timers.delete(handle),
    prepareRootSpawn: () => preparation,
    beforeRootSpawn: () => { effects.checks++; hooks.before?.(); },
    connectPipeImpl: async (_name, options) => { effects.connects.push(options.timeoutMs); return hooks.connect ? hooks.connect(socket) : socket; }
  });
  child.on('error', () => {});
  let outcome;
  child.jobOutcome.then(value => { outcome = { value }; }, error => { outcome = { error }; });
  return {
    child, native, socket, effects, finishPreparation, rejectPreparation,
    outcome: () => outcome,
    persistedCount: () => [...files.keys()].filter(file => file.endsWith('.json')).length,
    elapseWithoutCallbacks(ms) { clock += ms; },
    advance(ms) {
      clock += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.due <= clock) { timers.delete(handle); timer.fn(); }
      }
    }
  };
}

test('preparation finishes before connection and consumes the original budget', async () => {
  const h = harness();
  h.native.emit('spawn');
  await flush();
  assert.deepEqual(h.effects.connects, [], 'no connection while preparation is pending');
  h.advance(1500);
  h.finishPreparation();
  await flush();
  assert.equal(h.effects.connects.length, 1);
  assert.ok(h.effects.connects[0] > 0 && h.effects.connects[0] <= 500,
    'connection receives only remaining budget, never a restarted full budget');
  assert.equal(h.effects.checks, 1);
  assert.deepEqual(h.effects.writes, ['OWNER']);
  // An error plus actual close settles without a fabricated READY/identity.
  h.socket.emit('data', 'ERROR WINDOWS_JOB_WRAPPER_FAILED ' + Buffer.from('inert fixture ends before launch').toString('base64') + '\n');
  h.native.emit('close', 125, null);
  await flush();
  assert.ok(h.outcome().error instanceof Error);
  assert.equal(h.child.jobIdentity, null);
});

test('cancelled preparation cannot connect or authorize when it later completes', async () => {
  const h = harness();
  h.native.emit('spawn');
  await flush();
  const cancellation = h.child.terminateJob();
  await flush();
  assert.equal(h.outcome(), undefined, 'kill request is not actual close evidence');
  h.finishPreparation();
  await flush();
  assert.deepEqual(h.effects.connects, []);
  assert.deepEqual(h.effects.writes, []);
  h.native.emit('close', 125, null);
  const result = await cancellation;
  assert.equal(result.type, 'not-started');
  assert.equal(result.activeProcesses, 0);
  assert.equal(h.child.jobIdentity, null);
});

test('expired preparation settles only after close and late completion has no launch effects', async () => {
  const h = harness();
  h.native.emit('spawn');
  await flush();
  h.advance(2001);
  await flush();
  assert.ok(h.effects.kills > 0, 'expired preparation requests its retained wrapper to stop');
  assert.equal(h.outcome(), undefined, 'deadline is not actual close evidence');
  h.finishPreparation();
  await flush();
  assert.deepEqual(h.effects.connects, []);
  assert.deepEqual(h.effects.writes, []);
  h.native.emit('close', 125, null);
  await flush();
  assert.equal(h.outcome().error.code, 'WINDOWS_JOB_HANDSHAKE_DEADLINE');
  assert.equal(h.child.jobIdentity, null);
});

test('preparation rejection preserves refusal and waits for retained close', async () => {
  const h = harness();
  h.native.emit('spawn');
  h.rejectPreparation(Object.assign(new Error('fixture refusal'), { code: 'AGENT_RESOURCE_REFUSED' }));
  await flush();
  assert.equal(h.outcome(), undefined);
  assert.deepEqual(h.effects.connects, []);
  h.native.emit('close', 125, null);
  await flush();
  assert.equal(h.outcome().value.type, 'not-started');
  assert.equal(h.outcome().value.reasonCode, 'AGENT_RESOURCE_REFUSED');
  assert.equal(h.child.jobIdentity, null);
});

test('synchronous hook cannot authorize after exhausting the budget', async () => {
  const h = harness({ before: () => h.elapseWithoutCallbacks(2001) });
  h.finishPreparation();
  h.native.emit('spawn');
  await flush();
  assert.deepEqual(h.effects.writes, []);
  h.native.emit('close', 125, null);
  await flush();
  assert.equal(h.outcome().error.code, 'WINDOWS_JOB_HANDSHAKE_DEADLINE');
});

test('synchronous hook cancellation cannot write OWNER', async () => {
  let cancellation;
  const h = harness({ before: () => { cancellation = h.child.terminateJob(); } });
  h.finishPreparation();
  h.native.emit('spawn');
  await flush();
  assert.deepEqual(h.effects.writes, []);
  assert.equal(h.outcome(), undefined);
  h.native.emit('close', 125, null);
  assert.equal((await cancellation).type, 'not-started');
});

for (const kind of ['expiry', 'cancellation']) {
  test('late connection after ' + kind + ' is closed without OWNER', async () => {
    let finishConnect;
    const connection = new Promise(resolve => { finishConnect = resolve; });
    const h = harness({ connect: () => connection });
    h.finishPreparation();
    h.native.emit('spawn');
    await flush();
    assert.equal(h.effects.connects.length, 1);
    let cancellation;
    if (kind === 'expiry') h.advance(2001);
    else cancellation = h.child.terminateJob();
    await flush();
    finishConnect(h.socket);
    await flush();
    assert.equal(h.socket.destroyed, true);
    assert.deepEqual(h.effects.writes, []);
    assert.equal(h.outcome(), undefined);
    h.native.emit('close', 125, null);
    await flush();
    if (cancellation) assert.equal((await cancellation).type, 'not-started');
    else assert.equal(h.outcome().error.code, 'WINDOWS_JOB_HANDSHAKE_DEADLINE');
  });
}

test('remaining sub100 milliseconds refuses instead of expanding connect budget', async () => {
  const h = harness();
  h.native.emit('spawn');
  await flush();
  h.advance(1950);
  h.finishPreparation();
  await flush();
  assert.deepEqual(h.effects.connects, []);
  h.native.emit('close', 125, null);
  await flush();
  assert.equal(h.outcome().error.code, 'WINDOWS_JOB_HANDSHAKE_DEADLINE');
});

test('READY after deadline cannot invent identity or no-start success after OWNER', async () => {
  const h = harness();
  h.finishPreparation();
  h.native.emit('spawn');
  await flush();
  assert.deepEqual(h.effects.writes, ['OWNER']);
  h.advance(2001);
  h.socket.emit('data', 'READY 4242 1234 4343 5678\n');
  h.native.emit('close', 125, null);
  await flush();
  assert.equal(h.child.jobIdentity, null);
  assert.equal(h.outcome().error.code, 'WINDOWS_JOB_HANDSHAKE_DEADLINE');
});

test('late preparation rejection after expiry stays observed and cannot connect', async () => {
  const h = harness();
  h.native.emit('spawn');
  await flush();
  h.advance(2001);
  h.rejectPreparation(new Error('late rejection'));
  await flush();
  assert.deepEqual(h.effects.connects, []);
  h.native.emit('close', 125, null);
  await flush();
  assert.equal(h.outcome().error.code, 'WINDOWS_JOB_HANDSHAKE_DEADLINE');
});

test('READY within original deadline clears handshake timer', async () => {
  const h = harness();
  h.finishPreparation();
  h.native.emit('spawn');
  await flush();
  h.socket.emit('data', 'READY 4242 1234 4343 5678\n');
  await h.child.jobReady;
  h.advance(4000);
  assert.equal(h.effects.kills, 0);
  h.socket.emit('data', 'EXIT 0 0\n');
  h.native.emit('close', 0, null);
  await flush();
  assert.equal(h.outcome().value.type, 'exit');
});

test('actual close during preparation prevents later connection', async () => {
  const h = harness();
  h.native.emit('spawn');
  await flush();
  h.native.emit('close', 125, null);
  h.finishPreparation();
  await flush();
  assert.deepEqual(h.effects.connects, []);
  assert.deepEqual(h.effects.writes, []);
  assert.ok(h.outcome().error instanceof Error);
  assert.equal(h.child.jobIdentity, null);
});

test('destroyed connection after synchronous policy hook cannot receive OWNER', async () => {
  const h = harness({ before: () => h.socket.destroy() });
  h.finishPreparation();
  h.native.emit('spawn');
  await flush();
  assert.deepEqual(h.effects.writes, []);
  h.native.emit('close', 125, null);
  await flush();
  assert.ok(h.outcome().error instanceof Error);
});

test('identity persistence crossing deadline cannot publish READY and retires exact record on close', async () => {
  const h = harness({ persisted: () => h.elapseWithoutCallbacks(2001) });
  let spawned = false;
  let ready;
  h.child.on('spawn', () => { spawned = true; });
  h.child.jobReady.then(value => { ready = { value }; }, error => { ready = { error }; });
  h.finishPreparation();
  h.native.emit('spawn');
  await flush();
  h.socket.emit('data', 'READY 4242 1234 4343 5678\n');
  await flush();
  assert.equal(ready.error.code, 'WINDOWS_JOB_HANDSHAKE_DEADLINE');
  assert.equal(spawned, false);
  assert.equal(h.child.jobIdentity, null);
  assert.equal(h.persistedCount(), 1, 'keep exact unpublished registration until actual close');
  assert.equal(h.outcome(), undefined, 'persistence expiry is not actual close evidence');
  h.native.emit('close', 125, null);
  await flush();
  assert.equal(h.outcome().error.code, 'WINDOWS_JOB_HANDSHAKE_DEADLINE');
  assert.equal(h.persistedCount(), 0, 'actual close retires its exact unpublished registration');
});
