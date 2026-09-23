'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const {
  CouncilError,
  TIE_RULE,
  correctPremise,
  sealSlate
} = require('../src/lib/council/slate');

const sideEffects = [];
const restorers = [];

function observe(object, method, kind) {
  const original = object[method];
  object[method] = function observedSideEffect(...args) {
    sideEffects.push({ kind, method, args });
    return original.apply(this, args);
  };
  restorers.push(() => {
    object[method] = original;
  });
}

for (const method of ['appendFile', 'appendFileSync', 'createWriteStream', 'writeFile', 'writeFileSync']) {
  observe(fs, method, 'write');
}
for (const method of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {
  observe(childProcess, method, 'spawn');
}

const validInput = (overrides = {}) => ({
  slateId: 'release-council',
  convenedUnder: 'change-control',
  tieRule: TIE_RULE.TIE_FAILS,
  inviolableConstraints: ['Do not publish without owner approval.'],
  items: [{
    id: 'release',
    title: 'Release the change',
    caseFor: 'The acceptance checks pass.',
    caseAgainst: 'A rollback could still be required.'
  }],
  seats: [
    { seatId: 'evidence', lens: 'premise verification' },
    { seatId: 'operator', lens: 'operational safety' }
  ],
  ...overrides
});

function expectRefusal(code, invoke, expectedDetails) {
  const effectsBefore = sideEffects.length;
  assert.throws(invoke, (error) => {
    assert.ok(error instanceof CouncilError);
    assert.equal(error.code, code);
    assert.deepEqual(error.details, expectedDetails);
    return true;
  });
  assert.equal(sideEffects.length, effectsBefore, `${code} must not write or spawn`);
}

try {
  const invalidIdentifierInput = validInput({ slateId: '../release' });
  const identifierSnapshot = structuredClone(invalidIdentifierInput);
  expectRefusal(
    'COUNCIL_INVALID_IDENTIFIER',
    () => sealSlate(invalidIdentifierInput),
    { field: 'slateId' }
  );
  assert.deepEqual(invalidIdentifierInput, identifierSnapshot, 'identifier refusal must leave input untouched');

  const invalidTieRuleInput = validInput({ tieRule: 'CHAIR_DECIDES_AFTER_VOTE' });
  const tieRuleSnapshot = structuredClone(invalidTieRuleInput);
  expectRefusal(
    'COUNCIL_INVALID_TIE_RULE',
    () => sealSlate(invalidTieRuleInput),
    { tieRule: 'CHAIR_DECIDES_AFTER_VOTE' }
  );
  assert.deepEqual(invalidTieRuleInput, tieRuleSnapshot, 'tie-rule refusal must leave input untouched');

  const emptySlateInput = validInput({ items: [] });
  const slateSnapshot = structuredClone(emptySlateInput);
  expectRefusal(
    'COUNCIL_INVALID_SLATE',
    () => sealSlate(emptySlateInput),
    {}
  );
  assert.deepEqual(emptySlateInput, slateSnapshot, 'empty-slate refusal must leave input untouched');

  const correction = {
    itemId: 'release',
    supersedes: 'Old premise.',
    correction: 'Correct premise.',
    correctedBy: 'evidence'
  };
  expectRefusal(
    'COUNCIL_INVALID_SLATE',
    () => correctPremise({ items: [] }, correction),
    {}
  );
} finally {
  for (const restore of restorers.reverse()) restore();
}

console.log('council slate refusals: ok');
