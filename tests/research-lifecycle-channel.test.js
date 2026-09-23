'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { fork } = require('node:child_process');
const test = require('node:test');
const { performance } = require('node:perf_hooks');
const { createResearchWorkerSupervisor } = require('../src/lib/research/worker-supervisor');
const { CHANNEL, attachResearchLifecycle, installResearchLifecycle,
  readResearchQuiescenceObservation } = require('../src/lib/research/lifecycle-channel');
const { parseArgs } = require('../tools/mission-bridge');

function peers(transform = value => value) {
  const parent = new EventEmitter(); const child = new EventEmitter();
  parent.connected = child.connected = true;
  for (const [from, to] of [[parent, child], [child, parent]]) {
    from.send = (value, callback) => queueMicrotask(() => {
      const delivered = from === child ? transform(structuredClone(value)) : structuredClone(value);
      callback?.(null);
      if (delivered) to.emit('message', delivered);
    });
  }
  return { parent, child };
}
function fixture(transform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-lifecycle-channel-'));
  const host = createResearchWorkerSupervisor({ stateFile: path.join(dir, 'state.sqlite3'), runtimeDir: path.join(dir, 'runtime') });
  const pair = peers(transform);
  const server = installResearchLifecycle({ peer: pair.child, host, terminalTimeoutMs: 50 });
  const client = attachResearchLifecycle(pair.parent, { bootId: crypto.randomUUID(), generation: crypto.randomUUID(), graceMs: 50, cleanupMs: 50 });
  return { ...pair, dir, host, client, server,
    close() { client.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('private inherited flag is exact and does not alter the resource channel', () => {
  assert.deepEqual(parseArgs(['--research-lifecycle-channel', 'inherited', '--resource-channel', 'inherited']),
    { origins: [], roots: {}, port: null, researchLifecycleChannel: true, resourceChannel: true });
  assert.throws(() => parseArgs(['--research-lifecycle-channel', 'http']), /must be inherited/);
});

test('hello pins independently derived host scope, and real different host/client observations cannot cross facades', async () => {
  const first = fixture(); const second = fixture();
  try {
    const observed = await first.client.quiesceOwned({ requestId: 'connection-first' });
    const other = await second.client.quiesceOwned({ requestId: 'connection-second' });
    const hostValue = await first.host.quiesceOwned();
    assert.equal(observed.status, 'not-started-in-epoch', JSON.stringify(observed));
    assert.equal(observed.scope.hostEpoch, first.host.scope.hostEpoch);
    assert.equal(observed.scope.stateIdentity, first.host.scope.stateIdentity);
    assert.equal(readResearchQuiescenceObservation(observed, first.client), observed);
    assert.equal(readResearchQuiescenceObservation(other, first.client), null);
    assert.equal(readResearchQuiescenceObservation(hostValue, first.client), null);
    assert.equal(readResearchQuiescenceObservation(observed, first.host), null);
    assert.equal(readResearchQuiescenceObservation(hostValue, first.host), hostValue);
    assert.equal(readResearchQuiescenceObservation({ ...observed }, first.client), null);
    assert.equal(await first.client.quiesceOwned({ requestId: 'later-caller' }), observed, 'one sealed epoch keeps its original request');
    assert.equal(first.host.sealed, true);
    assert.equal(fs.existsSync(first.host.stateFile), false);
  } finally { first.close(); second.close(); }
});

for (const [name, mutate] of [
  ['request', value => { value.requestId = 'different-request'; }],
  ['host epoch', value => { value.scope.hostEpoch = crypto.randomUUID(); }],
  ['connection generation', value => { value.scope.generation = crypto.randomUUID(); }],
  ['state path scope', value => { value.scope.stateIdentity = '0'.repeat(64); }],
  ['DB-close false', value => { value.workerDbClosed = false; }],
  ['native cleanup mismatch', value => { value.nativeCleanup = 'EMPTY'; }]
]) {
  test(`a reply with a wrong ${name} is UNKNOWN, never a positive transport observation`, async () => {
    const item = fixture(message => { if (message.op === 'quiesce') mutate(message.result); return message; });
    try {
      const observed = await item.client.quiesceOwned();
      assert.equal(observed.status, 'unknown');
      assert.equal(observed.reasonCode, 'RESEARCH_LIFECYCLE_OBSERVATION_INVALID');
      assert.equal(readResearchQuiescenceObservation(observed, item.client), observed);
      assert.equal(item.host.sealed, true);
    } finally { item.close(); }
  });
}

test('lost reply, disconnected child and malformed hello never substitute an absent-root observation', async () => {
  for (const mode of ['drop', 'exit', 'bad-hello']) {
    const item = fixture(message => {
      if (mode === 'drop' && message.op === 'quiesce') return null;
      if (mode === 'bad-hello' && message.op === 'hello') message.result.stateIdentity = 'not-a-state-identity';
      return message;
    });
    try {
      const pending = item.client.quiesceOwned({ graceMs: 10, cleanupMs: 10 });
      if (mode === 'exit') item.parent.emit('exit', 0, null);
      const observed = await pending;
      assert.equal(observed.status, 'unknown');
      assert.equal(observed.nativeCleanup, 'UNKNOWN'); assert.equal(observed.workerDbClosed, false);
      assert.equal(observed.admissionSealed, false, 'the local latch is not a remote ACK');
    } finally { item.close(); }
  }
});

test('caller-shaped host proof is not relayed as a real observation', async () => {
  const pair = peers();
  const scope = { hostEpoch: crypto.randomUUID(), stateIdentity: '1'.repeat(64), generation: 'local-runtime' };
  const fakeHost = { snapshot: () => ({ scope }), sealAdmission() {}, quiesceOwned: async input => ({
    version: 1, requestId: input?.requestId, scope: { ...scope, runtimeInstanceId: null }, admissionSealed: true,
    workerDbClosed: true, nativeCleanup: 'NOT_STARTED', status: 'not-started-in-epoch', reasonCode: null
  }) };
  const server = installResearchLifecycle({ peer: pair.child, host: fakeHost });
  const client = attachResearchLifecycle(pair.parent, { bootId: crypto.randomUUID(), generation: crypto.randomUUID(), graceMs: 10, cleanupMs: 10 });
  try { assert.equal((await client.quiesceOwned()).status, 'unknown'); }
  finally { client.close(); server.close(); }
});

test('disposing this namespace preserves the resource IPC descriptor and other listeners', async () => {
  const item = fixture(); let resourceMessages = 0; let disconnectCalls = 0;
  const resourceListener = message => { if (message?.channel === 'toolsenabled.resource.v1') resourceMessages += 1; };
  item.parent.on('message', resourceListener);
  item.parent.disconnect = () => { disconnectCalls += 1; };
  try {
    await item.client.quiesceOwned(); item.client.close();
    item.parent.emit('message', { channel: 'toolsenabled.resource.v1' });
    assert.equal(resourceMessages, 1); assert.equal(disconnectCalls, 0);
    assert.equal(item.parent.connected, true);
    assert.equal(item.parent.listeners('message').includes(resourceListener), true);
  } finally { item.parent.off('message', resourceListener); item.close(); }
});

async function publishTerminal(item) {
  // Let the original hello pin both independently derived scope values first.
  await new Promise(resolve => setImmediate(resolve));
  const observed = await item.host.quiesceOwned({ requestId: 'startup-failure-cleanup' });
  return item.server.publishQuiescence(observed);
}

test('a real host terminal observation is retained after disconnect without opening its database', async () => {
  const item = fixture();
  try {
    assert.equal(await publishTerminal(item), true);
    item.server.close(); item.parent.emit('disconnect');
    const observed = await item.client.quiesceOwned();
    assert.equal(observed.status, 'not-started-in-epoch');
    assert.equal(observed.requestId, 'startup-failure-cleanup');
    assert.equal(readResearchQuiescenceObservation(observed, item.client), observed);
    assert.equal(readResearchQuiescenceObservation({ ...observed }, item.client), null);
    assert.equal(fs.existsSync(item.host.stateFile), false);
  } finally { item.close(); }
});

test('terminal publication refuses copied, forged and foreign real supervisor results', async () => {
  const first = fixture(), second = fixture();
  try {
    const own = await first.host.quiesceOwned();
    const foreign = await second.host.quiesceOwned();
    for (const value of [{ ...own }, { status: 'not-started-in-epoch' }, foreign]) {
      await assert.rejects(first.server.publishQuiescence(value), { code: 'RESEARCH_LIFECYCLE_OBSERVATION_INVALID' });
    }
    first.parent.emit('disconnect');
    assert.equal((await first.client.quiesceOwned()).status, 'unknown');
  } finally { first.close(); second.close(); }
});

for (const [name, mutate] of [
  ['boot identity', value => { value.bootId = crypto.randomUUID(); }],
  ['stale connection generation', value => { value.generation = crypto.randomUUID(); }],
  ['foreign host epoch', value => { value.result.scope.hostEpoch = crypto.randomUUID(); }],
  ['foreign state identity', value => { value.result.scope.stateIdentity = '0'.repeat(64); }],
  ['replayed sequence', value => { value.sequence -= 1; }],
  ['future sequence', value => { value.sequence += 1; }],
  ['unsealed result', value => { value.result.admissionSealed = false; }],
  ['unclosed worker database', value => { value.result.workerDbClosed = false; }],
]) test(`a terminal receipt with ${name} stays UNKNOWN`, async () => {
  const item = fixture(message => { if (message.type === 'terminal') mutate(message); return message; });
  try {
    await assert.rejects(publishTerminal(item), { code: 'RESEARCH_LIFECYCLE_TIMEOUT' });
    item.parent.emit('disconnect');
    assert.equal((await item.client.quiesceOwned()).status, 'unknown');
  } finally { item.close(); }
});

test('a replayed terminal frame invalidates its earlier retained reader receipt', async () => {
  let delivered;
  const item = fixture(message => { if (message.type === 'terminal') delivered = structuredClone(message); return message; });
  try {
    await publishTerminal(item);
    const observed = await item.client.quiesceOwned();
    assert.equal(readResearchQuiescenceObservation(observed, item.client), observed);
    item.parent.emit('message', delivered);
    assert.equal(readResearchQuiescenceObservation(observed, item.client), null);
    assert.equal((await item.client.quiesceOwned()).status, 'unknown');
  } finally { item.close(); }
});

test('a lost terminal frame followed by disconnect never becomes absence proof', async () => {
  const item = fixture(message => message.type === 'terminal' ? null : message);
  try {
    await assert.rejects(publishTerminal(item), { code: 'RESEARCH_LIFECYCLE_TIMEOUT' });
    item.parent.emit('disconnect');
    assert.equal((await item.client.quiesceOwned()).status, 'unknown');
  } finally { item.close(); }
});

for (const [name, mutate] of [
  ['foreign handshake', value => { value.bootId = crypto.randomUUID(); }],
  ['foreign scope', value => { value.hostEpoch = crypto.randomUUID(); }],
  ['stale sequence', value => { value.sequence -= 1; }],
  ['different receipt', value => { value.requestId = 'a-different-terminal-receipt'; }],
]) test(`terminal publication rejects an ACK with ${name}`, async () => {
  const item = fixture();
  const original = item.parent.send;
  item.parent.send = (value, callback) => {
    if (value.op === 'terminal-ack') { value = structuredClone(value); mutate(value); }
    original(value, callback);
  };
  try { await assert.rejects(publishTerminal(item), { code: 'RESEARCH_LIFECYCLE_DISCONNECTED' }); }
  finally { item.close(); }
});

test('a duplicate ACK cannot substitute for a terminal send that has not completed', async () => {
  const item = fixture();
  let completeSend, ack;
  const sendChild = item.child.send, sendParent = item.parent.send;
  item.child.send = (value, callback) => sendChild(value, value.type === 'terminal' ? () => { completeSend = callback; } : callback);
  item.parent.send = (value, callback) => { if (value.op === 'terminal-ack') ack = structuredClone(value); sendParent(value, callback); };
  try {
    const publishing = publishTerminal(item);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(ack); assert.equal(typeof completeSend, 'function');
    item.child.emit('message', ack);
    await assert.rejects(publishing, { code: 'RESEARCH_LIFECYCLE_DISCONNECTED' });
    completeSend(null);
  } finally { item.close(); }
});

test('a terminal send timeout and late delivery cannot rewrite an already-refused quiesce', async () => {
  const item = fixture();
  try {
    await new Promise(resolve => setImmediate(resolve));
    let frame, callback;
    const original = item.child.send;
    item.child.send = (value, done) => {
      if (value.type === 'terminal') { frame = value; callback = done; }
      else original(value, done);
    };
    await assert.rejects(publishTerminal(item), { code: 'RESEARCH_LIFECYCLE_TIMEOUT' });
    item.parent.emit('disconnect');
    const refused = await item.client.quiesceOwned();
    assert.equal(refused.status, 'unknown');
    callback(null); item.parent.emit('message', frame);
    assert.equal(await item.client.quiesceOwned(), refused);
  } finally { item.close(); }
});

test('a real response received after its monotonic deadline is UNKNOWN even before the timer callback runs', async () => {
  const originalClock = Object.getOwnPropertyDescriptor(performance, 'now');
  let observedNow = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => observedNow });
  const item = fixture(message => {
    if (message.op === 'quiesce') observedNow = 101; // A promise turn wins before the real100ms timer turn.
    return message;
  });
  try {
    const observed = await item.client.quiesceOwned();
    assert.equal(observed.status, 'unknown');
    assert.equal(observed.reasonCode, 'RESEARCH_LIFECYCLE_TIMEOUT');
    assert.equal(observed.workerDbClosed, false);
  } finally {
    item.close();
    if (originalClock) Object.defineProperty(performance, 'now', originalClock);
    else delete performance.now;
  }
});

test('actual finite inherited IPC child uses the shared hello/quiesce protocol without opening a database', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-lifecycle-channel-'));
  // This transport fixture has no descendants or research launch. Its finite
  // self-deadline bounds even a broken protocol, and we retain close directly.
  const child = fork(path.join(__dirname, 'fixtures', 'research-lifecycle-peer.js'), [], {
    env: { ...process.env, TOOLSENABLED_RESEARCH_CHANNEL_FIXTURE: dir },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
  });
  const closed = once(child, 'close');
  assert.equal(child.stdout, null, 'stdout is explicitly ignored, not an undrained pipe');
  const actualEvents = [];
  child.on('exit', (code, signal) => actualEvents.push({ type: 'exit', code, signal }));
  child.on('close', (code, signal) => actualEvents.push({ type: 'close', code, signal }));
  child.on('disconnect', () => actualEvents.push({ type: 'disconnect' }));
  child.stderr.on('end', () => actualEvents.push({ type: 'stderr-end' }));
  child.stderr.on('close', () => actualEvents.push({ type: 'stderr-close' }));
  child.stderr.on('data', () => {});
  const client = attachResearchLifecycle(child, { bootId: crypto.randomUUID(), generation: crypto.randomUUID(), graceMs: 1000, cleanupMs: 1000 });
  try {
    const observed = await client.quiesceOwned({ requestId: 'actual-inherited-ipc' });
    assert.equal(observed.status, 'not-started-in-epoch', JSON.stringify(observed));
    assert.equal(readResearchQuiescenceObservation(observed, client), observed);
    assert.equal(fs.existsSync(path.join(dir, 'state.sqlite3')), false);
  } finally {
    client.close();
    // Let the finite child close its endpoint. On the pinned Node build,
    // parent-initiated disconnect closes the IPC handle without the EOF path
    // that increments ChildProcess close accounting; never synthesize close.
    if (child.connected) child.send({ channel: 'toolsenabled.test.fixture', type: 'finish' }, () => {});
    let closureTimer;
    const closureDeadline = new Promise((resolve, reject) => {
      closureTimer = setTimeout(() => reject(new Error(`Finite IPC fixture did not close: ${JSON.stringify(actualEvents)}`)), 6000);
    });
    let code;
    try { [code] = await Promise.race([closed, closureDeadline]); }
    finally { clearTimeout(closureTimer); t.diagnostic(JSON.stringify(actualEvents)); }
    assert.equal(code, 0, 'the actual finite fixture closed normally');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const parentPauseMs of [0, 350]) test(`actual finite inherited IPC child flushes its authentic terminal observation before exit (parent pause ${parentPauseMs} ms)`, { timeout: 8000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-lifecycle-channel-'));
  const child = fork(path.join(__dirname, 'fixtures', 'research-lifecycle-peer.js'), [], {
    env: { ...process.env, TOOLSENABLED_RESEARCH_CHANNEL_FIXTURE: dir },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  const closed = once(child, 'close');
  child.stderr.on('data', () => {});
  const client = attachResearchLifecycle(child, { bootId: crypto.randomUUID(), generation: crypto.randomUUID(), graceMs: 1000, cleanupMs: 1000 });
  let timer;
  const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Terminal fixture did not actually exit.')), 6000); });
  try {
    child.send({ channel: 'toolsenabled.test.fixture', type: 'terminal' });
    // Native IPC may queue hello+terminal together while the shell is busy.
    // Their authenticity cannot depend on a Promise callback running between
    // consecutive message events; this pause remains inside the real deadline.
    if (parentPauseMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, parentPauseMs);
    const [code, signal] = await Promise.race([closed, deadline]);
    assert.equal(code, 0); assert.equal(signal, null);
    const observed = await client.quiesceOwned();
    assert.equal(observed.status, 'not-started-in-epoch', JSON.stringify(observed));
    assert.equal(observed.requestId, 'actual-terminal-cleanup');
    assert.equal(readResearchQuiescenceObservation(observed, client), observed);
    assert.equal(fs.existsSync(path.join(dir, 'state.sqlite3')), false);
    t.diagnostic(JSON.stringify({ exitCode: child.exitCode, signalCode: child.signalCode, retainedTerminal: observed.status }));
  } finally {
    clearTimeout(timer); client.close();
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ channel: 'toolsenabled.test.fixture', type: 'finish' }, () => {});
      await closed;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
