'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const workerPath = path.resolve(__dirname, '../sidecars/local-coder/src/overnight-advisory-worker.js');
const tasksPath = require.resolve('../src/lib/providers/tasks');
const advisoryPath = require.resolve('../src/lib/providers/overnight-advisory');
const hermesPath = require.resolve('../src/lib/providers/research-hermes');
const strongPath = require.resolve('../src/lib/providers/research-strong');
const saved = new Map([tasksPath, advisoryPath, hermesPath, strongPath, workerPath].map(file => [file, require.cache[file]]));

let metadataImpl = () => ({ prompt: 'review this', acceptanceChecklist: ['be accurate'], maxOutputTokens: 256, allowStrong: false });
let behavior;
const calls = [];
const tasks = {
  internalOvernightAdvisoryState: state => state,
  start: async input => { calls.push(['start', input]); return { checkpointRevision: 0 }; },
  checkpoint: async input => { calls.push(['checkpoint', input]); return { revision: (input.expectedRevision || 0) + 1 }; },
  heartbeat: async input => { calls.push(['heartbeat', input]); return {}; },
  fail: async input => { calls.push(['fail', input]); if (behavior.failError) throw behavior.failError; return {}; },
  complete: async input => { calls.push(['complete', input]); return {}; }
};

function install(file, exports) { require.cache[file] = { id: file, filename: file, loaded: true, exports }; }
install(tasksPath, tasks);
install(advisoryPath, {
  QUEUE: 'overnight', TYPE: 'overnight_advisory',
  OvernightAdvisoryControl: class { constructor() { this.state = {}; } },
  OvernightAdvisoryError: class extends Error {}, containsProhibitedMaterial: () => false,
  metadata: value => metadataImpl(value)
});
install(hermesPath, { complete: async input => behavior.hermes(input), containsSensitiveMaterial: () => false });
install(strongPath, { complete: async input => behavior.strong(input), status: async () => behavior.tiers });
delete require.cache[workerPath];
const { OvernightAdvisoryWorker } = require(workerPath);

function reset(overrides = {}) {
  calls.length = 0;
  metadataImpl = () => ({ prompt: 'review this', acceptanceChecklist: ['be accurate'], maxOutputTokens: 256, allowStrong: false });
  behavior = {
    tiers: { onBattery: false, gpuTemperatureC: 40, freeRamMiB: 16384, freeVramMiB: 4096, fast: { ready: true }, strong: { ready: true } },
    pressure: { pageInsPerSecond: 0, foregroundProcess: 'node' },
    hermes: async () => ({ output: 'Hermes answer' }), strong: async () => ({ output: 'Strong answer' }), failError: null,
    ...overrides
  };
  const modelCalls = { hermes: 0, strong: 0 };
  const events = [];
  const worker = new OvernightAdvisoryWorker({
    control: { state: {} }, tierStatus: async () => behavior.tiers,
    pressureProbe: () => behavior.pressure,
    hermesComplete: async input => { modelCalls.hermes++; return behavior.hermes(input); },
    strongComplete: async input => { modelCalls.strong++; return behavior.strong(input); },
    onEvent: event => events.push(event), heartbeatIntervalMs: 100000
  });
  return { worker, modelCalls, events };
}

function claim(payload = {}) { return { handle: { taskId: 'task-1', leaseToken: 'lease' }, task: { payload, checkpointRevision: 0 } }; }
function failures() { return calls.filter(([name]) => name === 'fail').map(([, input]) => input); }
function completions() { return calls.filter(([name]) => name === 'complete'); }

(async () => {
  // Malformed durable input reaches the worker's fallback code before any checkpoint or model process.
  {
    const { worker, modelCalls } = reset();
    metadataImpl = () => { throw new Error('malformed fixture'); };
    await worker._execute(claim());
    assert.equal(failures().at(-1).code, 'OVERNIGHT_ADVISORY_TASK_INVALID');
    assert.equal(failures().at(-1).disposition, 'failed');
    assert.deepEqual(modelCalls, { hermes: 0, strong: 0 });
    assert.equal(calls.some(([name]) => name === 'checkpoint' || name === 'complete'), false);
  }

  // An exception from the injected machine-status probe is uncertainty, not a tier fact.
  {
    const { worker, modelCalls } = reset();
    worker.tierStatus = async () => { throw new Error('probe unavailable'); };
    await worker._execute(claim());
    assert.equal(failures().at(-1).code, 'LOCAL_ADVISORY_STATUS_UNAVAILABLE');
    assert.equal(failures().at(-1).disposition, 'retry');
    assert.deepEqual(modelCalls, { hermes: 0, strong: 0 });
    assert.equal(completions().length, 0);
  }

  // A definite, non-retryable fast-tier refusal does not invoke either model or complete.
  {
    const { worker, modelCalls } = reset({ tiers: { onBattery: false, gpuTemperatureC: 40, freeRamMiB: 16384, freeVramMiB: 4096, fast: { ready: false, reason: 'not_installed' } } });
    await worker._execute(claim());
    assert.equal(failures().at(-1).code, 'LOCAL_ADVISORY_FAST_TIER_UNAVAILABLE');
    assert.match(failures().at(-1).message, /not_installed/);
    assert.deepEqual(modelCalls, { hermes: 0, strong: 0 });
    assert.equal(completions().length, 0);
  }

  // Opting into strong performs Hermes, then refuses/retries rather than spawning strong while Hermes is resident.
  {
    const { worker, modelCalls } = reset();
    metadataImpl = () => ({ prompt: 'review this', acceptanceChecklist: ['be accurate'], maxOutputTokens: 256, allowStrong: true });
    await worker._execute(claim());
    assert.equal(failures().at(-1).code, 'LOCAL_ADVISORY_AWAITING_STRONG_RESIDENCY');
    assert.equal(failures().at(-1).disposition, 'retry');
    assert.deepEqual(modelCalls, { hermes: 1, strong: 0 });
    assert.equal(completions().length, 0);
  }

  // Provider resource contention preserves its named retry code and creates no completion.
  {
    const busy = Object.assign(new Error('model is occupied'), { code: 'MODEL_RESOURCE_BUSY' });
    const { worker, modelCalls } = reset({ hermes: async () => { throw busy; } });
    await worker._execute(claim());
    assert.equal(failures().at(-1).code, 'MODEL_RESOURCE_BUSY');
    assert.equal(failures().at(-1).disposition, 'retry');
    assert.deepEqual(modelCalls, { hermes: 1, strong: 0 });
    assert.equal(completions().length, 0);
  }

  // An unclassified provider exception reaches the generic failure fallback.
  {
    const { worker, modelCalls } = reset({ hermes: async () => { throw new Error('unexpected inference failure'); } });
    await worker._execute(claim());
    assert.equal(failures().at(-1).code, 'LOCAL_ADVISORY_FAILED');
    assert.equal(failures().at(-1).disposition, 'failed');
    assert.deepEqual(modelCalls, { hermes: 1, strong: 0 });
    assert.equal(completions().length, 0);
  }

  // If recording that generic failure also fails, the worker emits the final observable refusal.
  {
    const recordError = new Error('state store unavailable');
    const { worker, events } = reset({ hermes: async () => { throw new Error('inference failed'); }, failError: recordError });
    await worker._execute(claim());
    assert.equal(completions().length, 0);
    assert.deepEqual(events.find(event => event.type === 'failure_record_error'), {
      type: 'failure_record_error', taskId: 'task-1', code: 'FAILURE_RECORD_FAILED'
    });
  }

  // A rejected lease heartbeat is observable and prevents completion after the in-flight model returns.
  {
    const { worker, modelCalls, events } = reset({
      hermes: async () => { await new Promise(resolve => setTimeout(resolve, 35)); return { output: 'late answer' }; }
    });
    worker.heartbeatIntervalMs = 5;
    tasks.heartbeat = async input => {
      calls.push(['heartbeat', input]);
      throw new Error('lease store unavailable');
    };
    await worker._execute(claim());
    assert.deepEqual(events.find(event => event.type === 'heartbeat_error'), {
      type: 'heartbeat_error', taskId: 'task-1', code: 'HEARTBEAT_FAILED'
    });
    assert.equal(failures().at(-1).code, 'CANCELLED');
    assert.deepEqual(modelCalls, { hermes: 1, strong: 0 });
    assert.equal(completions().length, 0);
  }

  console.log('overnight advisory worker driven refusal tests passed');
})().finally(() => {
  for (const [file, entry] of saved) {
    if (entry === undefined) delete require.cache[file];
    else require.cache[file] = entry;
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
