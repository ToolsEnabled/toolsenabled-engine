// EXECUTABLE CHANGE
/*
 * Mutation report: the decision and refusal-code assertions previously used
 * DECISION and REFUSAL values exported by the subject. Mutating all eight
 * exported strings made the unmodified test stay green with "11 checks
 * passed". Those expected values were therefore computed by the same code
 * they checked. The assertions below now use the contract's literal wire
 * values instead.
 *
 * Strengthened assertions and mutations:
 * - Every `result.decision` assertion (all eleven checks): mutated REFUSED to
 *   MUTATED_REFUSED and PERMITTED to MUTATED_PERMITTED. The RED output was
 *   "actual: 'MUTATED_REFUSED', expected: 'REFUSED'" and
 *   "actual: 'MUTATED_PERMITTED', expected: 'PERMITTED'".
 * - `result.reason` in the no-authorization check: mutated
 *   CUTOVER_OWNER_AUTHORIZATION_ABSENT. RED: "actual:
 *   'MUTATED_NO_AUTHORIZATION', expected:
 *   'CUTOVER_OWNER_AUTHORIZATION_ABSENT'".
 * - `result.reason` in the coordinator, missing-verifier, and throwing-verifier
 *   checks: mutated CUTOVER_AUTHORIZATION_UNVERIFIED. RED: "actual:
 *   'MUTATED_UNVERIFIED', expected: 'CUTOVER_AUTHORIZATION_UNVERIFIED'".
 * - `result.reason` in the agent-authored check: mutated
 *   CUTOVER_AUTHORIZATION_NOT_FROM_OWNER. RED: "actual: 'MUTATED_NOT_OWNER',
 *   expected: 'CUTOVER_AUTHORIZATION_NOT_FROM_OWNER'".
 * - `result.reason` in the wrong-version check: mutated
 *   CUTOVER_AUTHORIZATION_FOR_DIFFERENT_MIGRATION. RED: "actual:
 *   'MUTATED_WRONG_MIGRATION', expected:
 *   'CUTOVER_AUTHORIZATION_FOR_DIFFERENT_MIGRATION'".
 * - `result.reason` in both unknown-survey checks: mutated
 *   CUTOVER_LEGACY_READERS_UNSURVEYED. RED: "actual:
 *   'MUTATED_READERS_UNKNOWN', expected:
 *   'CUTOVER_LEGACY_READERS_UNSURVEYED'".
 * - `result.reason` in the live-readers check: mutated
 *   CUTOVER_LEGACY_READERS_STILL_ACTIVE. RED: "actual:
 *   'MUTATED_READERS_LIVE', expected:
 *   'CUTOVER_LEGACY_READERS_STILL_ACTIVE'".
 * Every mutation exited 1 with ERR_ASSERTION. The subject was then restored
 * byte-for-byte; the final green run ended with "11 checks passed".
 *
 * NOT-FOUND (1): no assertion is inside a loop/forEach over a possibly empty
 * collection. NOT-FOUND (2): no exit-status or truthy-return assertion.
 * NOT-FOUND (3): no test-side try/catch or optional chain swallowing failure.
 * NOT-FOUND (4): no assertion measures a mock of evaluateCutover; injected
 * verifier doubles supply inputs at the documented boundary, while assertions
 * inspect the real gate. NOT-FOUND (5): no skip or platform precondition guard.
 * Shape (6) was found and fixed as listed above. Unmet preconditions: none.
 */
'use strict';

const assert = require('node:assert/strict');
const { evaluateCutover } = require('../src/lib/agent-comms/cutover-gate');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}

const MIGRATION = 'q90-fabric-1';
const ownerVerifier = (auth) => ({
  verified: auth.token === 'owner-signed',
  actorKind: auth.token === 'owner-signed' ? 'owner' : 'agent',
  migrationVersion: auth.migrationVersion,
  acknowledgedStrandedReaders: auth.acknowledgedStrandedReaders === true
});

const surveyed = (activeReaders = []) => ({ surveyed: true, activeReaders });

console.log('agent-comms cutover gate');

check('refuses by default, with no authorization at all', () => {
  const result = evaluateCutover({ migrationVersion: MIGRATION });
  assert.equal(result.decision, 'REFUSED');
  assert.equal(result.reason, 'CUTOVER_OWNER_AUTHORIZATION_ABSENT');
});

check('coordinator judgement is not an input the gate accepts', () => {
  const result = evaluateCutover({
    migrationVersion: MIGRATION,
    authorization: { token: 'coordinator-decided', migrationVersion: MIGRATION },
    legacyReaderSurvey: surveyed(),
    verifyOwnerAuthorization: ownerVerifier
  });
  assert.equal(result.decision, 'REFUSED');
  assert.equal(result.reason, 'CUTOVER_AUTHORIZATION_UNVERIFIED');
});

check('an authorization an agent wrote itself is refused as not from the owner', () => {
  const result = evaluateCutover({
    migrationVersion: MIGRATION,
    authorization: { token: 'agent-written', migrationVersion: MIGRATION },
    legacyReaderSurvey: surveyed(),
    verifyOwnerAuthorization: (auth) => ({ verified: true, actorKind: 'agent', migrationVersion: auth.migrationVersion })
  });
  assert.equal(result.decision, 'REFUSED');
  assert.equal(result.reason, 'CUTOVER_AUTHORIZATION_NOT_FROM_OWNER');
});

check('a well-formed authorization with no verifier injected is still refused', () => {
  const result = evaluateCutover({
    migrationVersion: MIGRATION,
    authorization: { token: 'owner-signed', migrationVersion: MIGRATION },
    legacyReaderSurvey: surveyed()
  });
  assert.equal(result.decision, 'REFUSED');
  assert.equal(result.reason, 'CUTOVER_AUTHORIZATION_UNVERIFIED');
});

check('a verifier that throws refuses rather than opening the gate', () => {
  const result = evaluateCutover({
    migrationVersion: MIGRATION,
    authorization: { token: 'owner-signed', migrationVersion: MIGRATION },
    legacyReaderSurvey: surveyed(),
    verifyOwnerAuthorization: () => { throw new Error('vault unreachable'); }
  });
  assert.equal(result.decision, 'REFUSED');
  assert.equal(result.reason, 'CUTOVER_AUTHORIZATION_UNVERIFIED');
  assert.match(result.detail, /vault unreachable/);
});

check('an authorization for a different migration version does not carry over', () => {
  const result = evaluateCutover({
    migrationVersion: MIGRATION,
    authorization: { token: 'owner-signed', migrationVersion: 'q90-fabric-0' },
    legacyReaderSurvey: surveyed(),
    verifyOwnerAuthorization: ownerVerifier
  });
  assert.equal(result.decision, 'REFUSED');
  assert.equal(result.reason, 'CUTOVER_AUTHORIZATION_FOR_DIFFERENT_MIGRATION');
});

check('an unsurveyed fleet is refused: nobody can consent to an unknown blast radius', () => {
  const result = evaluateCutover({
    migrationVersion: MIGRATION,
    authorization: { token: 'owner-signed', migrationVersion: MIGRATION },
    verifyOwnerAuthorization: ownerVerifier
  });
  assert.equal(result.decision, 'REFUSED');
  assert.equal(result.reason, 'CUTOVER_LEGACY_READERS_UNSURVEYED');
});

check('an incomplete survey is refused', () => {
  const result = evaluateCutover({
    migrationVersion: MIGRATION,
    authorization: { token: 'owner-signed', migrationVersion: MIGRATION },
    legacyReaderSurvey: { surveyed: false, activeReaders: [] },
    verifyOwnerAuthorization: ownerVerifier
  });
  assert.equal(result.decision, 'REFUSED');
  assert.equal(result.reason, 'CUTOVER_LEGACY_READERS_UNSURVEYED');
});

check('live legacy readers are refused unless the authorization acknowledges stranding them', () => {
  const result = evaluateCutover({
    migrationVersion: MIGRATION,
    authorization: { token: 'owner-signed', migrationVersion: MIGRATION },
    legacyReaderSurvey: surveyed(['luna-3', 'terra-1']),
    verifyOwnerAuthorization: ownerVerifier
  });
  assert.equal(result.decision, 'REFUSED');
  assert.equal(result.reason, 'CUTOVER_LEGACY_READERS_STILL_ACTIVE');
  assert.deepEqual([...result.activeReaders], ['luna-3', 'terra-1']);
});

check('the owner may authorize stranding named readers explicitly', () => {
  const result = evaluateCutover({
    migrationVersion: MIGRATION,
    authorization: { token: 'owner-signed', migrationVersion: MIGRATION, acknowledgedStrandedReaders: true },
    legacyReaderSurvey: surveyed(['luna-3']),
    verifyOwnerAuthorization: ownerVerifier
  });
  assert.equal(result.decision, 'PERMITTED');
  assert.deepEqual([...result.strandedReaders], ['luna-3']);
});

check('a verified owner authorization over an empty, surveyed fleet permits the cutover', () => {
  const result = evaluateCutover({
    migrationVersion: MIGRATION,
    authorization: { token: 'owner-signed', migrationVersion: MIGRATION },
    legacyReaderSurvey: surveyed(),
    verifyOwnerAuthorization: ownerVerifier
  });
  assert.equal(result.decision, 'PERMITTED');
  assert.equal(result.authorizedBy, 'owner');
});

console.log(`\n${checks} checks passed`);
