'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const review = require('../src/lib/fleet-supervisor/review.js');

function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

function acceptedText(effect) {
  return [
    'VERDICT: ACCEPTED',
    'SCORE: 1.0',
    'REASON: exercised the changed artifact',
    'RAN-COMMAND: node artifact.js',
    'RAN-OUTPUT: wrote one record',
    `EFFECT: ${effect}`,
    'SHAPE-CHECKED: producer.js:12',
    'FAILURE-MODES: imagined-schema=pass, unreachable-code=pass, authority-inversion=pass, fabricated-numbers=pass, scope=pass'
  ].join('\n');
}

function testMissingModelReceiptRefusesWithoutSideEffects() {
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'review-receipt-refusal-'));
  try {
    fs.writeFileSync(path.join(sentinel, 'sentinel'), 'unchanged');
    const before = snapshot(sentinel);
    const claim = Object.freeze({ laneId: 'lane-without-receipt' });

    const refusal = review.modelReceiptRefusal(claim);

    assert.equal(refusal.code, 'MISSING_MODEL_RECEIPT');
    assert.equal(refusal.receipt, null);
    assert.match(refusal.reason, /served-model evidence is UNKNOWN or untrusted/);
    assert.deepEqual(snapshot(sentinel), before, 'a receipt refusal must not write anything');
    assert.equal(fs.readFileSync(path.join(sentinel, 'sentinel'), 'utf8'), 'unchanged');
  } finally {
    fs.rmSync(sentinel, { recursive: true, force: true });
  }
}

function testTrivialEffectRefusesAcceptance() {
  const parsed = review.parseVerdict(acceptedText('no effect'));

  assert.equal(parsed.verdict, null, 'a hollow effect must discard, rather than accept, the review');
  assert.equal(parsed.inconclusive, true);
  assert.equal(parsed.effect.present, true);
  assert.equal(parsed.effect.trivial, true);
  assert.match(parsed.reason, /^reviewer-accepted-without-a-real-EFFECT:/);
  assert.equal(parsed.evidence, null, 'discarded acceptance must expose no executable evidence');
}

testMissingModelReceiptRefusesWithoutSideEffects();
testTrivialEffectRefusesAcceptance();
console.log('fleet supervisor review refusal tests passed');
