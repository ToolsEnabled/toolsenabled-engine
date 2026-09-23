'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

// These guards make the absence of side effects part of the refusal contract,
// rather than merely assuming that classification is pure. Install them before
// loading the module so a future eager side effect is caught too.
const calls = [];
const restorations = [];
function forbid(object, name) {
  const original = object[name];
  object[name] = (...args) => {
    calls.push({ name, args });
    throw new Error(`error taxonomy attempted forbidden side effect: ${name}`);
  };
  restorations.push(() => { object[name] = original; });
}

for (const name of ['appendFile', 'appendFileSync', 'createWriteStream', 'writeFile', 'writeFileSync']) forbid(fs, name);
for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) forbid(childProcess, name);

let errorTaxonomy;
try {
  errorTaxonomy = require('../src/lib/error-taxonomy');

  const cases = Object.freeze([
    ['ACCOUNT_INVALID', 'AUTH_EXPIRED', 'retry-after-input', 'blocked'],
    ['ADAPTER_FAILED', 'UNAVAILABLE', 'retry-after-time', 'retry'],
    ['ALLOWLIST', 'POLICY_DENIED', 'terminal', 'failed'],
    ['APPROVAL', 'APPROVAL_REQUIRED', 'retry-after-input', 'blocked'],
    ['BILLING_REQUIRED', 'QUOTA_EXHAUSTED', 'retry-after-time', 'retry'],
    ['CAPTURE_IN_PROGRESS', 'INPUT_REQUIRED', 'retry-after-input', 'blocked'],
    ['CLOSED', 'UNAVAILABLE', 'retry-after-time', 'retry'],
    ['CONFIRMATION', 'APPROVAL_REQUIRED', 'retry-after-input', 'blocked'],
    ['CONTAINER_ESCAPE', 'SANDBOX_VIOLATION', 'terminal', 'failed'],
    ['CREDENTIALS_UNAVAILABLE', 'AUTH_EXPIRED', 'retry-after-input', 'blocked'],
    ['DENIED', 'POLICY_DENIED', 'terminal', 'failed'],
    ['ENOMEM', 'RESOURCE_PRESSURE', 'retry-after-time', 'retry'],
    ['ENOSPC', 'RESOURCE_PRESSURE', 'retry-after-time', 'retry'],
  ]);

  assert.equal(cases.length, 13, 'the fixture must not silently lose a driven refusal');
  for (const [sourceCode, expectedCode, classification, disposition] of cases) {
    const source = { code: sourceCode, message: 'provider prose must not control classification' };
    const adapted = errorTaxonomy.adaptProviderError(source);
    assert.equal(adapted.code, expectedCode, `${sourceCode}: adapted code`);
    assert.equal(adapted.classification, classification, `${sourceCode}: adapted classification`);

    const failure = errorTaxonomy.publicFailure(adapted);
    assert.equal(failure.code, expectedCode, `${sourceCode}: public code`);
    assert.equal(failure.classification, classification, `${sourceCode}: public classification`);
    assert.equal(Object.isFrozen(failure), true, `${sourceCode}: public refusal is immutable`);
    assert.deepEqual(
      Object.keys(failure).sort(),
      (classification === 'retry-after-time'
        ? ['classification', 'code', 'retryAfterMs', 'retryable', 'safeSummary', 'schemaVersion']
        : ['classification', 'code', 'retryable', 'safeSummary', 'schemaVersion']).sort(),
      `${sourceCode}: public refusal exposes only the closed envelope`,
    );

    const decision = errorTaxonomy.decideRetry(failure, { attempt: 1, effect: 'local-read' });
    assert.equal(decision.code, expectedCode, `${sourceCode}: decision code`);
    assert.equal(decision.disposition, disposition, `${sourceCode}: caller behavior`);
  }

  assert.deepEqual(calls, [], 'classifying refusals must neither write nor spawn');
} finally {
  for (const restore of restorations.reverse()) restore();
}

console.log('ok: 13 structured source refusals drive closed behavior without writes or spawns');
