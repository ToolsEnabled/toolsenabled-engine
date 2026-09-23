'use strict';

const assert = require('node:assert/strict');
const {
  EMPTY_MIGRATION_POLICY,
  normalizePolicy,
  buildLegacyDottedDisposition
} = require('../../src/lib/request-version/legacy-dotted-disposition');
const {
  TEST_MIGRATION_POLICY,
  buildLegacyDottedLedgerFixture
} = require('../fixtures/legacy-dotted-ledger');

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
};
const expectCode = (fn, expected) => assert.throws(fn, error => error && error.code === expected);

const ledger = buildLegacyDottedLedgerFixture();
const rawBefore = JSON.stringify(ledger.requests);

check('the neutral product policy declares no numeric-id semantics', () => {
  assert.deepEqual(EMPTY_MIGRATION_POLICY.continuationIds, []);
  assert.deepEqual(EMPTY_MIGRATION_POLICY.duplicatePairs, []);
  const neutral = buildLegacyDottedDisposition(ledger.requests);
  assert.deepEqual(neutral.continuations, []);
  assert.deepEqual(neutral.duplicateVersionMerges, []);
  assert.deepEqual(neutral.policy, EMPTY_MIGRATION_POLICY);
});

check('an arbitrary reused dotted id receives no treatment without explicit policy', () => {
  const requests = [{
    id: 'R3001.1', request: 'Fresh customer request.', verbatim: 'Fresh customer request.',
    status: 'done', gates: [{ instruction: 'ordinary gate', met: true, evidence: 'fixture' }]
  }];
  const disposition = buildLegacyDottedDisposition(requests);
  assert.equal(disposition.continuations.length, 0);
  assert.equal(disposition.duplicateVersionMerges.length, 0);
});

const disposition = buildLegacyDottedDisposition(ledger.requests, TEST_MIGRATION_POLICY);

check('the explicit policy is normalized, frozen, and non-overlapping', () => {
  const policy = normalizePolicy(TEST_MIGRATION_POLICY);
  const all = [...policy.continuationIds, ...policy.duplicatePairs.flat()];
  assert.equal(new Set(all).size, all.length);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.duplicatePairs[0]), true);
});

check('the disposition is read-only and does not mutate its ledger input', () => {
  assert.equal(JSON.stringify(ledger.requests), rawBefore);
  assert.equal(disposition.appliesChanges, false);
  assert.equal(disposition.preservesVerbatim, true);
  assert.equal(Object.isFrozen(disposition), true);
});

check('policy-declared continuations remain independent records', () => {
  assert.deepEqual(disposition.continuations.map(item => item.id), TEST_MIGRATION_POLICY.continuationIds);
  for (const item of disposition.continuations) {
    assert.equal(item.type, 'legacy-continuation');
    assert.equal(item.policyDeclared, true);
    assert.equal(item.participatesInVersionLineage, false);
    assert.equal(item.ledgerNote, TEST_MIGRATION_POLICY.continuationNote);
    assert.equal(item.provenanceBasis, TEST_MIGRATION_POLICY.provenanceBasis);
    assert.equal(item.source.verbatim, ledger.requests.find(entry => entry.id === item.id).verbatim);
  }
});

check('policy-declared duplicate pairs merge without renumbering', () => {
  assert.deepEqual(disposition.duplicateVersionMerges.map(item => [item.rootId, item.activeId]), TEST_MIGRATION_POLICY.duplicatePairs);
  for (const item of disposition.duplicateVersionMerges) {
    assert.equal(item.type, 'legacy-duplicate-version-merge');
    assert.deepEqual(item.lineage, [item.rootId, item.activeId]);
    assert.deepEqual(item.supersededIds, [item.rootId]);
    assert.deepEqual(item.sources.map(source => source.id), [item.rootId, item.activeId]);
    assert.equal(item.provenanceBasis, TEST_MIGRATION_POLICY.provenanceBasis);
  }
});

check('gate disagreements resolve to the policy-declared active version and preserve both histories', () => {
  const [rootId, activeId] = TEST_MIGRATION_POLICY.duplicatePairs[1];
  const merge = disposition.duplicateVersionMerges.find(item => item.rootId === rootId);
  assert.equal(merge.gateState, 'resolved-to-active-version');
  assert.equal(merge.conflictingGateCount, 3);
  assert.equal(merge.gates.length, 3);
  for (const gate of merge.gates) {
    assert.equal(gate.met, true);
    assert.equal(gate.sourceConflict, true);
    assert.equal(gate.effectiveSource.requestId, activeId);
    assert.equal(gate.copies[0].gate.met, false);
    assert.equal(gate.copies[1].gate.met, true);
  }
});

check('available duplicate verbatim is retained byte-for-byte', () => {
  for (const merge of disposition.duplicateVersionMerges) {
    for (const source of merge.sources) {
      const original = ledger.requests.find(entry => entry.id === source.id);
      if (typeof original.verbatim !== 'string') continue;
      assert.equal(source.verbatim, original.verbatim);
      assert.equal(source.verbatimAvailable, true);
    }
  }
});

check('explicit no-verbatim markers remain unavailable without fabrication', () => {
  const [rootId] = TEST_MIGRATION_POLICY.duplicatePairs[0];
  const merge = disposition.duplicateVersionMerges.find(item => item.rootId === rootId);
  assert.equal(merge.contentComparison, 'unavailable-no-verbatim');
  assert.equal(merge.sources.every(source => source.verbatimAvailable === false), true);
  assert.equal(merge.sources.every(source => !Object.hasOwn(source, 'verbatim')), true);
});

check('an explicit policy fails closed on a missing source', () => {
  const missingId = TEST_MIGRATION_POLICY.continuationIds[0];
  expectCode(
    () => buildLegacyDottedDisposition(ledger.requests.filter(entry => entry.id !== missingId), TEST_MIGRATION_POLICY),
    'LEGACY_DOTTED_SOURCE_MISSING'
  );
});

check('declared sources refuse missing or contradictory verbatim availability', () => {
  const [rootId, activeId] = TEST_MIGRATION_POLICY.duplicatePairs[0];
  const missing = structuredClone(ledger.requests);
  delete missing.find(entry => entry.id === activeId).verbatimAvailable;
  expectCode(() => buildLegacyDottedDisposition(missing, TEST_MIGRATION_POLICY), 'LEGACY_DOTTED_VERBATIM_UNMARKED');

  const contradictory = structuredClone(ledger.requests);
  const availableActiveId = TEST_MIGRATION_POLICY.duplicatePairs[1][1];
  contradictory.find(entry => entry.id === availableActiveId).verbatimAvailable = false;
  expectCode(() => buildLegacyDottedDisposition(contradictory, TEST_MIGRATION_POLICY), 'LEGACY_DOTTED_VERBATIM_CONTRADICTORY');
  assert.ok(rootId);
});

check('declared duplicate pairs refuse mismatched content and gate shapes', () => {
  const activeId = TEST_MIGRATION_POLICY.duplicatePairs[1][1];
  const content = structuredClone(ledger.requests);
  content.find(entry => entry.id === activeId).verbatim += 'changed';
  expectCode(() => buildLegacyDottedDisposition(content, TEST_MIGRATION_POLICY), 'LEGACY_DOTTED_CONTENT_MISMATCH');

  const gates = structuredClone(ledger.requests);
  gates.find(entry => entry.id === activeId).gates[0].instruction += 'changed';
  expectCode(() => buildLegacyDottedDisposition(gates, TEST_MIGRATION_POLICY), 'LEGACY_DOTTED_GATE_SHAPE_MISMATCH');
});

check('missing status remains unavailable while invalid status refuses', () => {
  const [rootId, activeId] = TEST_MIGRATION_POLICY.duplicatePairs[2];
  const missing = structuredClone(ledger.requests);
  delete missing.find(entry => entry.id === rootId).status;
  const merge = buildLegacyDottedDisposition(missing, TEST_MIGRATION_POLICY)
    .duplicateVersionMerges.find(item => item.rootId === rootId);
  assert.equal(merge.activeStatus, 'done');
  assert.equal(merge.statusState, 'unavailable');

  const invalid = structuredClone(ledger.requests);
  invalid.find(entry => entry.id === activeId).status = null;
  expectCode(() => buildLegacyDottedDisposition(invalid, TEST_MIGRATION_POLICY), 'LEGACY_DOTTED_STATUS_INVALID');
});

console.log(`request-version/legacy-dotted-disposition: ${checks} checks passed`);
