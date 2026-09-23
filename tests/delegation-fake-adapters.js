'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../src/lib/delegation-fake-adapters');

function handle(handleId, fence = 0) { return { handleId, fence }; }

async function start(adapter, handleId, scriptId, options = {}) {
  return adapter.start({ handleId, scriptId, ...options });
}

async function next(adapter, current) {
  return adapter.collect({ handleId: current.handleId, fence: current.fence });
}

async function cleanup(adapter, current) {
  return adapter.cleanup({ handleId: current.handleId, fence: current.fence });
}

async function collectUntilTerminal(adapter, current, maximum = 16) {
  const batches = [];
  for (let index = 0; index < maximum; index += 1) {
    const batch = await next(adapter, current);
    batches.push(batch);
    if (batch.result || batch.events.length === 0) return batches;
  }
  throw new Error('fixture did not terminate within its deterministic bound');
}

(async () => {
  const expectedScripts = [
    'fake.approval_required', 'fake.blocked', 'fake.crash', 'fake.input_required',
    'fake.late_completion', 'fake.looping', 'fake.malformed_output',
    'fake.rate_limited', 'fake.success'
  ];
  assert.deepEqual(fixtures.SCRIPT_IDS, expectedScripts);

  const adapter = fixtures.createFakeAdapter();
  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(adapter.descriptorId, fixtures.ADAPTER_ID);
  assert.deepEqual(Object.keys(adapter).sort(), ['cancel', 'cleanup', 'collect', 'descriptorId', 'probe', 'provideInput', 'start']);
  const registration = fixtures.registerFakeAdapter();
  assert.equal(registration.grantsAuthority, false);
  assert.equal(registration.acceptanceState, 'UNACCEPTED');
  assert.deepEqual(registration.interfaceMethods, ['probe', 'start', 'collect', 'provideInput', 'cancel', 'cleanup']);
  assert.equal((await adapter.probe()).available, true);

  const hiddenStart = { handleId: 'fixture-hidden', scriptId: 'fake.success' };
  Object.defineProperty(hiddenStart, 'ambientAuthority', { value: true, enumerable: false });
  assert.throws(() => adapter.start(hiddenStart), error => error.code === 'FAKE_ADAPTER_INVALID');

  const symbolStart = { handleId: 'fixture-symbol', scriptId: 'fake.success' };
  symbolStart[Symbol('hidden-script')] = 'fake.blocked';
  assert.throws(() => adapter.start(symbolStart), error => error.code === 'FAKE_ADAPTER_INVALID');

  let startGetterCalls = 0;
  const accessorStart = { handleId: 'fixture-accessor' };
  Object.defineProperty(accessorStart, 'scriptId', {
    enumerable: true,
    get() { startGetterCalls += 1; return 'fake.success'; }
  });
  assert.throws(() => adapter.start(accessorStart), error => error.code === 'FAKE_ADAPTER_INVALID');
  assert.equal(startGetterCalls, 0, 'start request getters must not run');

  let startProxyGets = 0;
  const proxyStart = new Proxy({ handleId: 'fixture-proxy', scriptId: 'fake.success' }, {
    get() { startProxyGets += 1; throw new Error('start get trap must not run'); }
  });
  const proxySession = await adapter.start(proxyStart);
  assert.equal(proxySession.handleId, 'fixture-proxy');
  assert.equal(startProxyGets, 0, 'valid start proxies must be read from descriptors');
  await cleanup(adapter, proxySession);

  assert.throws(() => adapter.start(new Proxy({ handleId: 'fixture-prototype', scriptId: 'fake.success' }, {
    getPrototypeOf() { throw new Error('Bearer prototype trap'); }
  })), error => error.code === 'FAKE_ADAPTER_INVALID');
  assert.throws(() => adapter.start(new Proxy({ handleId: 'fixture-ownkeys', scriptId: 'fake.success' }, {
    ownKeys() { throw new Error('OTP ownKeys trap'); }
  })), error => error.code === 'FAKE_ADAPTER_INVALID');

  let handleGetterCalls = 0;
  const accessorHandle = { handleId: 'fixture-absent' };
  Object.defineProperty(accessorHandle, 'fence', {
    enumerable: true,
    get() { handleGetterCalls += 1; return 0; }
  });
  assert.throws(() => adapter.collect(accessorHandle), error => error.code === 'FAKE_ADAPTER_INVALID');
  assert.equal(handleGetterCalls, 0, 'handle getters must not run');

  let handleProxyGets = 0;
  const proxyHandle = new Proxy({ handleId: 'fixture-absent', fence: 0 }, {
    get() { handleProxyGets += 1; throw new Error('handle get trap must not run'); }
  });
  assert.equal((await adapter.collect(proxyHandle)).events.length, 0);
  assert.equal(handleProxyGets, 0, 'valid handle proxies must be read from descriptors');

  // Success emits three normalized, value-free events then a separately
  // normalized, explicitly unaccepted WorkerResult envelope.
  const success = await start(adapter, 'fixture-success', 'fake.success');
  const successBatches = await collectUntilTerminal(adapter, success);
  const successEvents = successBatches.flatMap(batch => batch.events);
  assert.deepEqual(successEvents.map(event => event.kind), ['progress', 'progress', 'complete']);
  assert.deepEqual(successEvents.map(event => event.sequence), [0, 1, 2]);
  assert.equal(successBatches.at(-1).result.brokerAcceptanceState, 'UNACCEPTED');
  assert.equal(JSON.stringify(successBatches).includes('Success'), false);
  assert.equal((await cleanup(adapter, success)).releasedSyntheticOwnership, false);

  // Duplicate scripted delivery is deduplicated by stable item identity, not a
  // cursor accident, so it still creates exactly the normal success sequence.
  const dedup = await start(adapter, 'fixture-dedup', 'fake.success', { injectDuplicateFirstEvent: true });
  const dedupEvents = (await collectUntilTerminal(adapter, dedup)).flatMap(batch => batch.events);
  assert.deepEqual(dedupEvents.map(event => event.sequence), [0, 1, 2]);
  await cleanup(adapter, dedup);

  for (const [scriptId, expectedState] of [
    ['fake.blocked', 'UNACCEPTED'],
    ['fake.approval_required', 'UNACCEPTED'],
    ['fake.rate_limited', 'UNACCEPTED']
  ]) {
    const active = await start(adapter, `fixture-${scriptId.slice(5).replace(/_/g, '-')}`, scriptId);
    const batch = await next(adapter, active);
    assert.equal(batch.events.length, 1, `${scriptId} must emit one terminal event`);
    assert.equal(batch.events[0].kind, 'error');
    assert.equal(batch.result.brokerAcceptanceState, expectedState);
    await cleanup(adapter, active);
  }

  // Input is never retained, interpolated, or hashed. Only a static outcome is
  // emitted after a non-sensitive acknowledgement; secret-shaped input is a
  // local typed rejection before it reaches fixture state.
  const input = await start(adapter, 'fixture-input', 'fake.input_required');
  const requested = await next(adapter, input);
  assert.equal(requested.events[0].kind, 'input_required');
  assert.throws(() => adapter.provideInput(handle('fixture-input'), 'Bearer sample-secret'), error => error.code === 'FAKE_ADAPTER_INPUT_DENIED');
  const acknowledgement = await adapter.provideInput(handle('fixture-input'), 'okay');
  assert.equal(acknowledgement.acknowledged, true);
  const afterInput = await collectUntilTerminal(adapter, input);
  assert.deepEqual(afterInput.flatMap(batch => batch.events).map(event => event.kind), ['progress', 'complete']);
  assert.equal(JSON.stringify(afterInput).includes('okay'), false);
  await cleanup(adapter, input);

  // The late-completion script first makes progress. A cancel advances its
  // fence, clears remaining work, and prevents the old or new handle from
  // returning its queued terminal event.
  const late = await start(adapter, 'fixture-late', 'fake.late_completion');
  assert.equal((await next(adapter, late)).events[0].kind, 'progress');
  const cancellation = await adapter.cancel(handle('fixture-late'));
  assert.equal(cancellation.fence, 1);
  assert.equal((await next(adapter, late)).events.length, 0, 'stale fence must not receive a late completion');
  assert.equal((await next(adapter, handle('fixture-late', 1))).events.length, 0, 'cancelled current fence must not receive a late completion');
  await cleanup(adapter, handle('fixture-late', 1));

  const crash = await start(adapter, 'fixture-crash', 'fake.crash');
  const crashBatch = await next(adapter, crash);
  assert.equal(crashBatch.events[0].kind, 'error');
  const crashCleanup = await cleanup(adapter, crash);
  assert.equal(crashCleanup.releasedSyntheticOwnership, true, 'crash cleanup must prove synthetic process ownership release');
  assert.equal((await cleanup(adapter, crash)).releasedSyntheticOwnership, false);

  const loop = await start(adapter, 'fixture-loop', 'fake.looping', { collectionLimit: 2 });
  const loopBatches = await collectUntilTerminal(adapter, loop);
  assert.deepEqual(loopBatches.flatMap(batch => batch.events).map(event => event.kind), ['progress', 'progress', 'error']);
  assert.equal(loopBatches.at(-1).result.brokerAcceptanceState, 'UNACCEPTED');
  await cleanup(adapter, loop);

  const malformed = await start(adapter, 'fixture-malformed', 'fake.malformed_output');
  assert.throws(() => adapter.collect(handle('fixture-malformed')), error => error.code === 'FAKE_ADAPTER_MALFORMED_OUTPUT');
  await cleanup(adapter, malformed);

  // The fake fixture must remain provider-free and deterministic. Its source
  // cannot acquire task state or import a live transport/runtime.
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/delegation-fake-adapters.js'), 'utf8');
  assert.equal(/\b(?:Date\.now|Math\.random|setTimeout|setInterval)\b/.test(source), false);
  for (const forbidden of ['providers/tasks', 'task-store', 'cli-provider-gateway', 'browser-owner', 'credential-metadata', 'audit-store']) {
    assert.equal(new RegExp(`require\\(['\"](?:\\./)?${forbidden.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}['\"]\\)`).test(source), false, `unexpected runtime import: ${forbidden}`);
  }

  console.log('delegation fake adapters: all tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
