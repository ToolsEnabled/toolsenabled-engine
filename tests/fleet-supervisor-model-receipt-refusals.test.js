'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');

let writes = 0;
let spawns = 0;
const originalWriteFileSync = fs.writeFileSync;
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;
fs.writeFileSync = (...args) => { writes += 1; return originalWriteFileSync(...args); };
childProcess.spawn = (...args) => { spawns += 1; return originalSpawn(...args); };
childProcess.spawnSync = (...args) => { spawns += 1; return originalSpawnSync(...args); };

const { assessModelReceipt } = require('../src/lib/fleet-supervisor/model-receipt.js');

const valid = (overrides = {}) => ({
  laneId: 'lane-receipt-refusals',
  callId: 'call-1',
  callRole: 'primary',
  transport: 'direct-vertex',
  backend: 'vertex',
  configuredModel: 'gemini-2.5-pro',
  actualRequestModel: 'gemini-2.5-pro',
  servedModel: 'gemini-2.5-pro',
  modelEvidence: 'vertex-modelVersion',
  artifactProduced: true,
  ...overrides
});

function refusal(input, code, expectedVerdict = 'quarantined') {
  const before = { writes, spawns };
  const receipt = assessModelReceipt(input);
  assert.equal(receipt.code, code);
  assert.equal(receipt.verdict, expectedVerdict);
  assert.deepEqual({ writes, spawns }, before, `${code} must not write or spawn`);
  return receipt;
}

assert.match(
  refusal(valid({ laneId: null }), 'INVALID_MODEL_RECEIPT').reason,
  /requires a laneId/
);

assert.match(
  refusal(valid({ modelEvidence: 'provider-rumour' }), 'MODEL_EVIDENCE_UNKNOWN').reason,
  /Unknown model evidence kind/
);

assert.equal(
  refusal(valid({ modelEvidence: 'absent', servedModel: null, servedModelAmbiguity: 'two provider events disagree' }),
    'AMBIGUOUS_SERVED_MODEL_EVIDENCE').observed,
  false
);

assert.equal(
  refusal(valid({ modelEvidence: 'inferred' }), 'INFERRED_MODEL_EVIDENCE').observed,
  false
);

assert.match(
  refusal(valid({
    callRole: 'subagent',
    servedModel: 'gemini-2.5-flash',
    artifactProduced: true,
    materialOutputUsed: null
  }), 'SUBAGENT_MATERIALITY_UNKNOWN').reason,
  /materially used is not established/
);

assert.match(
  refusal(valid({
    callRole: 'subagent',
    servedModel: 'gemini-2.5-flash',
    artifactProduced: true,
    materialOutputUsed: true
  }), 'SUBAGENT_SERVED_MODEL_BELOW_FLOOR', 'refused').reason,
  /materially used subagent call/
);

assert.equal(writes, 0);
assert.equal(spawns, 0);
console.log('model receipt driven refusal tests passed');
