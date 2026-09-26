/*
 * Mutation check: changed `verdict.actorKind !== 'owner'` to `=== 'owner'`
 * in src/lib/agent-comms/cutover-gate.js.
 * The edit landed, and this isolated test file went red (exit code 1).
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DECISION, REFUSAL, evaluateCutover } = require('../../src/lib/agent-comms/cutover-gate');

const migrationVersion = 'fabric-v3';
const authorization = Object.freeze({ signedStatement: 'owner-approved-cutover' });
const surveyedWithNoReaders = Object.freeze({ surveyed: true, activeReaders: [] });

function verifiedOwner(overrides = {}) {
  return () => ({
    verified: true,
    actorKind: 'owner',
    migrationVersion,
    acknowledgedStrandedReaders: false,
    ...overrides
  });
}

function evaluate(overrides = {}) {
  return evaluateCutover({
    authorization,
    migrationVersion,
    legacyReaderSurvey: surveyedWithNoReaders,
    verifyOwnerAuthorization: verifiedOwner(),
    ...overrides
  });
}

test('the gate refuses invalid authorization and incomplete reader evidence with specific reasons', () => {
  const cases = [
    ['a migration version is required', { migrationVersion: '' }, REFUSAL.WRONG_MIGRATION],
    ['authorization is required', { authorization: null }, REFUSAL.NO_AUTHORIZATION],
    ['a verifier is required', { verifyOwnerAuthorization: null }, REFUSAL.UNVERIFIED],
    ['the verifier must affirm the record', { verifyOwnerAuthorization: () => ({ verified: false }) }, REFUSAL.UNVERIFIED],
    ['only an owner may authorize', { verifyOwnerAuthorization: verifiedOwner({ actorKind: 'coordinator' }) }, REFUSAL.NOT_OWNER],
    ['authorization must name this migration', { verifyOwnerAuthorization: verifiedOwner({ migrationVersion: 'fabric-v2' }) }, REFUSAL.WRONG_MIGRATION],
    ['a reader survey is required', { legacyReaderSurvey: null }, REFUSAL.READERS_UNKNOWN],
    ['the reader survey must complete', { legacyReaderSurvey: { surveyed: false, activeReaders: [] } }, REFUSAL.READERS_UNKNOWN],
    ['the reader survey must include a list', { legacyReaderSurvey: { surveyed: true } }, REFUSAL.READERS_UNKNOWN]
  ];

  for (const [label, overrides, reason] of cases) {
    const result = evaluate(overrides);
    assert.equal(result.decision, DECISION.REFUSED, label);
    assert.equal(result.reason, reason, label);
    assert.equal(Object.isFrozen(result), true, `${label}: decisions are immutable`);
  }
});

test('a verifier exception is converted into an unverified refusal', () => {
  const result = evaluate({
    verifyOwnerAuthorization() {
      throw new Error('signature service unavailable');
    }
  });

  assert.equal(result.decision, DECISION.REFUSED);
  assert.equal(result.reason, REFUSAL.UNVERIFIED);
  assert.match(result.detail, /signature service unavailable/);
});

test('live legacy readers require explicit acknowledgement and are reported without aliasing input', () => {
  const activeReaders = ['agent-7'];
  const result = evaluate({ legacyReaderSurvey: { surveyed: true, activeReaders } });

  assert.equal(result.decision, DECISION.REFUSED);
  assert.equal(result.reason, REFUSAL.READERS_LIVE);
  assert.deepEqual(result.activeReaders, ['agent-7']);
  assert.equal(Object.isFrozen(result.activeReaders), true);
  activeReaders.push('agent-8');
  assert.deepEqual(result.activeReaders, ['agent-7']);
});

test('verified owner authorization permits the named migration and snapshots acknowledged readers', () => {
  const activeReaders = ['agent-7', 'agent-9'];
  const result = evaluate({
    legacyReaderSurvey: { surveyed: true, activeReaders },
    verifyOwnerAuthorization: verifiedOwner({ acknowledgedStrandedReaders: true })
  });

  assert.deepEqual(result, {
    decision: DECISION.PERMITTED,
    migrationVersion,
    authorizedBy: 'owner',
    strandedReaders: ['agent-7', 'agent-9']
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.strandedReaders), true);
  activeReaders.push('agent-11');
  assert.deepEqual(result.strandedReaders, ['agent-7', 'agent-9']);
});

test('exported decision and refusal vocabularies are immutable', () => {
  assert.deepEqual(DECISION, { PERMITTED: 'PERMITTED', REFUSED: 'REFUSED' });
  assert.equal(Object.isFrozen(DECISION), true);
  assert.equal(Object.isFrozen(REFUSAL), true);
});
