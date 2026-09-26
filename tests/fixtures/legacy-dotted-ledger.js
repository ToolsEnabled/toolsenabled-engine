'use strict';

// Synthetic customer-local policy and ledger. The ids have no product meaning;
// every migration semantic comes from TEST_MIGRATION_POLICY supplied by tests.

const TEST_MIGRATION_POLICY = Object.freeze({
  schemaVersion: 1,
  continuationIds: Object.freeze(['R3001.1', 'R3002.1']),
  duplicatePairs: Object.freeze([
    Object.freeze(['R3010', 'R3010.1']),
    Object.freeze(['R3011', 'R3011.1']),
    Object.freeze(['R3012', 'R3012.1'])
  ]),
  continuationNote: 'Declared continuation retained outside version lineage.',
  provenanceBasis: 'synthetic installation migration policy'
});

const FIXTURE_REVISION = 100;

const gate = (instruction, met) => ({
  instruction,
  met,
  evidence: met ? `fixture evidence for: ${instruction}` : ''
});

function continuationRecord(id) {
  return {
    id,
    request: `Fixture continuation ${id}.`,
    verbatim: `Fixture verbatim text recorded for ${id}.`,
    status: 'done',
    evidence: `fixture evidence for ${id}`,
    gates: [gate(`${id} continuation gate`, true)]
  };
}

function unavailablePair(rootId, activeId) {
  return [
    {
      id: rootId,
      request: `Fixture interpretation of ${rootId}; no verbatim was recorded.`,
      verbatimAvailable: false,
      status: 'in-progress',
      gates: []
    },
    {
      id: activeId,
      request: `Fixture interpretation of ${activeId}; no verbatim was recorded.`,
      verbatimAvailable: false,
      status: 'done',
      evidence: `fixture evidence for ${activeId}`,
      gates: []
    }
  ];
}

function conflictingPair(rootId, activeId) {
  const instructions = [`${rootId} gate one`, `${rootId} gate two`, `${rootId} gate three`];
  const verbatim = `Fixture verbatim text captured twice as ${rootId} and ${activeId}.`;
  return [
    {
      id: rootId,
      request: `Fixture request ${rootId}.`,
      verbatim,
      status: 'in-progress',
      gates: instructions.map(instruction => gate(instruction, false))
    },
    {
      id: activeId,
      request: `Fixture request ${activeId}.`,
      verbatim,
      status: 'done',
      evidence: `fixture evidence for ${activeId}`,
      gates: instructions.map(instruction => gate(instruction, true))
    }
  ];
}

function agreeingPair(rootId, activeId) {
  const verbatim = `Fixture verbatim text captured twice as ${rootId} and ${activeId}.`;
  const gates = [gate(`${rootId} shared gate`, true)];
  const shared = { verbatim, status: 'done', evidence: `fixture evidence for ${rootId}` };
  return [
    { id: rootId, request: `Fixture request ${rootId}.`, ...shared, gates: structuredClone(gates) },
    { id: activeId, request: `Fixture request ${activeId}.`, ...shared, gates: structuredClone(gates) }
  ];
}

const PAIR_BUILDERS = new Map([
  ['R3010', unavailablePair],
  ['R3011', conflictingPair]
]);

function buildLegacyDottedLedgerFixture() {
  const requests = [];
  for (const id of TEST_MIGRATION_POLICY.continuationIds) requests.push(continuationRecord(id));
  for (const [rootId, activeId] of TEST_MIGRATION_POLICY.duplicatePairs) {
    const build = PAIR_BUILDERS.get(rootId) || agreeingPair;
    requests.push(...build(rootId, activeId));
  }
  return {
    $comment: 'Synthetic migration fixture.',
    schemaVersion: 1,
    revision: FIXTURE_REVISION,
    updatedAt: '2026-08-07',
    statusVocabulary: { done: 'fixture status', 'in-progress': 'fixture status' },
    requests
  };
}

function hasEveryPolicySource(requests, policy = TEST_MIGRATION_POLICY) {
  if (!Array.isArray(requests)) return false;
  const ids = new Set(requests.map(entry => entry && entry.id));
  const required = [...policy.continuationIds, ...policy.duplicatePairs.flat()];
  return required.every(id => ids.has(id));
}

module.exports = Object.freeze({
  FIXTURE_REVISION,
  TEST_MIGRATION_POLICY,
  buildLegacyDottedLedgerFixture,
  hasEveryPolicySource
});
