'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { adjudicateLaneModelReceipt } = require('../src/lib/fleet-supervisor/supervisor.js');

// Drive the public adjudication boundary with evidence that is only valid for
// direct Vertex while the lane is configured for the CLI subscription backend.
// This is deliberately not a source-text assertion: the refusal must be the
// value returned to the caller.
const evidence = {
  providerCallEvent: { forged: 'the backend check must run before inspecting this' },
  rawResponse: { modelVersion: 'gemini-2.5-pro', responseId: 'response-1' }
};
const before = structuredClone(evidence);
let writes = 0;
let spawns = 0;
const originalWriteFileSync = fs.writeFileSync;
const originalAppendFileSync = fs.appendFileSync;
const originalSpawn = childProcess.spawn;
fs.writeFileSync = (...args) => { writes += 1; return originalWriteFileSync(...args); };
fs.appendFileSync = (...args) => { writes += 1; return originalAppendFileSync(...args); };
childProcess.spawn = (...args) => { spawns += 1; return originalSpawn(...args); };

try {
  const receipt = adjudicateLaneModelReceipt({
    laneId: 'refusal-lane',
    attemptNumber: 2,
    artifactProduced: true,
    backend: 'subscription',
    configuredModel: 'gemini-2.5-pro',
    directVertexEvidence: evidence
  });

  assert.equal(receipt.verdict, 'quarantined', 'backend-confused evidence is quarantined');
  assert.equal(receipt.code, 'DIRECT_VERTEX_BACKEND_MISMATCH', 'the public boundary returns the typed refusal');
  assert.equal(receipt.servedModel, null, 'untrusted evidence cannot establish a served model');
  assert.equal(receipt.responseId, null, 'untrusted evidence cannot establish a response identity');
  assert.deepEqual(evidence, before, 'refusal does not alter caller-owned evidence');
  assert.equal(writes, 0, 'receipt refusal writes no files');
  assert.equal(spawns, 0, 'receipt refusal spawns no processes');
} finally {
  fs.writeFileSync = originalWriteFileSync;
  fs.appendFileSync = originalAppendFileSync;
  childProcess.spawn = originalSpawn;
}

console.log('fleet supervisor refusal coverage: PASS');
