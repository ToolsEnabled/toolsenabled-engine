'use strict';

const assert = require('node:assert/strict');
const { GiB, pickFastModel, pickModel } = require('../../src/lib/model-picker');

function probe(overrides = {}) {
  return {
    ollamaReachable: true,
    installedModels: ['gpt-oss:20b', 'qwen3.5:9b', 'qwen3.5:4b'],
    residentModels: [],
    freeRamBytes: 25 * GiB,
    freeVramBytes: 8 * GiB,
    onBattery: false,
    ...overrides
  };
}

(() => {
  assert.deepEqual(pickModel(probe(), { allowSlowTier: true, batch: true }), {
    available: true, tier: 'slow-batch', model: 'gpt-oss:20b'
  });

  // A caller must explicitly opt into the slow, batch-only role. Merely having
  // the model installed is never enough to select it.
  assert.deepEqual(pickModel(probe(), { allowSlowTier: true, batch: false }), {
    available: true, tier: 'high-capacity', model: 'qwen3.5:9b'
  });
  assert.deepEqual(pickModel(probe({ residentModels: ['qwen3.5:9b'] }), { allowSlowTier: true, batch: true }), {
    available: true, tier: 'high-capacity', model: 'qwen3.5:9b'
  }, 'A different resident model prevents loading the slow batch role beside it.');
  assert.deepEqual(pickModel(probe({ residentModels: ['gpt-oss:20b'], freeRamBytes: 13 * GiB, freeVramBytes: 2.1 * GiB }), { allowSlowTier: true, batch: true }), {
    available: true, tier: 'slow-batch', model: 'gpt-oss:20b'
  }, 'A safely resident model can be reused without pretending its allocated RAM and VRAM are still free.');
  assert.deepEqual(pickModel(probe({
    installedModels: ['gpt-oss:20b'], residentModels: ['gpt-oss:20b'],
    freeRamBytes: 13 * GiB, freeVramBytes: 1.9 * GiB
  }), { allowSlowTier: true, batch: true }), {
    available: false, code: 'MODEL_UNAVAILABLE', reason: 'no_eligible_local_model'
  }, 'A resident slow model below the explicit 2 GiB VRAM reserve is paused.');

  // Battery is a cap, not a preference: the 9B/20B roles cannot be selected.
  assert.deepEqual(pickModel(probe({ onBattery: true }), { allowSlowTier: true, batch: true }), {
    available: true, tier: 'workhorse', model: 'qwen3.5:4b'
  });
  const unknownBatteryProbe = probe();
  delete unknownBatteryProbe.onBattery;
  assert.deepEqual(pickModel(unknownBatteryProbe, { allowSlowTier: true, batch: true }), {
    available: true, tier: 'workhorse', model: 'qwen3.5:4b'
  }, 'An unmeasured battery state cannot be treated as AC power for a larger role.');
  assert.deepEqual(pickModel({
    ...unknownBatteryProbe, installedModels: ['qwen3.5:9b']
  }), {
    available: false, code: 'MODEL_UNAVAILABLE', reason: 'battery_status_unknown'
  }, 'A battery probe failure remains distinguishable when no battery-safe role is eligible.');

  // VRAM pressure degrades to the workhorse, then to an honest unavailable
  // result instead of a cloud or deterministic free-form fallback.
  assert.deepEqual(pickModel(probe({ freeVramBytes: 5 * GiB }), {}), {
    available: true, tier: 'workhorse', model: 'qwen3.5:4b'
  });
  assert.deepEqual(pickModel(probe({ freeVramBytes: 4 * GiB }), {}), {
    available: false, code: 'MODEL_UNAVAILABLE', reason: 'no_eligible_local_model'
  });
  assert.deepEqual(pickModel(probe({ residentModels: ['qwen3.5:4b'], freeVramBytes: 1 * GiB }), {}), {
    available: true, tier: 'workhorse', model: 'qwen3.5:4b'
  });

  assert.deepEqual(pickModel(probe({ ollamaReachable: false }), {}), {
    available: false, code: 'MODEL_UNAVAILABLE', reason: 'ollama_unreachable'
  });
  assert.deepEqual(pickModel(probe({ installedModels: ['gpt-oss:20b-cloud'] }), {}), {
    available: false, code: 'MODEL_UNAVAILABLE', reason: 'no_eligible_local_model'
  }, 'Only the three fixed local tags are eligible; a cloud-tagged model cannot be selected.');

  assert.deepEqual(pickFastModel(probe()), {
    available: true, tier: 'workhorse', model: 'qwen3.5:4b'
  }, 'The fast picker never promotes a quick operation to a larger local tier.');
  assert.deepEqual(pickFastModel(probe({ freeVramBytes: 4 * GiB })), {
    available: false, code: 'MODEL_UNAVAILABLE', reason: 'no_eligible_fast_local_model'
  }, 'Fast work uses the existing 4.2 GiB workhorse headroom floor.');
  assert.deepEqual(pickFastModel(probe({
    residentModels: ['qwen3.5:4b'], freeVramBytes: 1 * GiB
  })), {
    available: true, tier: 'workhorse', model: 'qwen3.5:4b'
  }, 'A resident fast model may be reused without pretending its allocated VRAM is free.');

  console.log('Model picker tests passed.');
})();
