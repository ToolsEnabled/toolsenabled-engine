'use strict';

// Read-only projection for installation-declared dotted-request migrations.
// The product carries no request-number exceptions. A caller must provide the
// exact continuation ids and duplicate pairs that belong to its own ledger.

const { isRequestId } = require('../request-id');

class LegacyDottedDispositionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LegacyDottedDispositionError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new LegacyDottedDispositionError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  if (!plain(value)) return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) result[key] = cloneAndFreeze(item);
  return Object.freeze(result);
}

function normalizePolicy(policy) {
  if (!plain(policy)) fail('LEGACY_DOTTED_POLICY_INVALID', 'Migration policy must be an object.');
  const required = ['schemaVersion', 'continuationIds', 'duplicatePairs', 'continuationNote', 'provenanceBasis'];
  if (Reflect.ownKeys(policy).some(key => !required.includes(key))
      || required.some(key => !Object.hasOwn(policy, key))
      || policy.schemaVersion !== 1
      || !Array.isArray(policy.continuationIds) || policy.continuationIds.length > 10_000
      || !Array.isArray(policy.duplicatePairs) || policy.duplicatePairs.length > 5_000
      || typeof policy.continuationNote !== 'string' || policy.continuationNote.length === 0 || policy.continuationNote.length > 500
      || typeof policy.provenanceBasis !== 'string' || policy.provenanceBasis.length === 0 || policy.provenanceBasis.length > 500) {
    fail('LEGACY_DOTTED_POLICY_INVALID', 'Migration policy has an invalid shape.');
  }
  const continuationIds = policy.continuationIds.map(id => {
    if (!isRequestId(id, { family: 'R' }) || !id.includes('.')) {
      fail('LEGACY_DOTTED_POLICY_INVALID', 'Every continuation id must be a dotted request id.', { id });
    }
    return id;
  });
  const duplicatePairs = policy.duplicatePairs.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      fail('LEGACY_DOTTED_POLICY_INVALID', 'Every duplicate pair must contain root and active request ids.');
    }
    const [rootId, activeId] = pair;
    if (!isRequestId(rootId, { family: 'R' }) || !isRequestId(activeId, { family: 'R' })
        || !activeId.startsWith(`${rootId}.`)) {
      fail('LEGACY_DOTTED_POLICY_INVALID', 'Every duplicate active id must be a dotted child of its root.', { rootId, activeId });
    }
    return Object.freeze([rootId, activeId]);
  });
  const allIds = [...continuationIds, ...duplicatePairs.flat()];
  if (new Set(allIds).size !== allIds.length) {
    fail('LEGACY_DOTTED_POLICY_INVALID', 'Migration policy request ids must be unique.');
  }
  return Object.freeze({
    schemaVersion: 1,
    continuationIds: Object.freeze(continuationIds),
    duplicatePairs: Object.freeze(duplicatePairs),
    continuationNote: policy.continuationNote,
    provenanceBasis: policy.provenanceBasis
  });
}

const EMPTY_MIGRATION_POLICY = normalizePolicy({
  schemaVersion: 1,
  continuationIds: [],
  duplicatePairs: [],
  continuationNote: 'No continuation metadata is declared for this installation.',
  provenanceBasis: 'explicit installation migration policy'
});

function sourceRecord(entry) {
  const hasVerbatim = Object.hasOwn(entry, 'verbatim');
  const hasStatus = Object.hasOwn(entry, 'status');
  if (hasStatus && (typeof entry.status !== 'string' || entry.status.length === 0)) {
    fail('LEGACY_DOTTED_STATUS_INVALID', `${entry.id} status is invalid.`, { id: entry.id });
  }
  if (hasVerbatim && entry.verbatimAvailable === false) {
    fail('LEGACY_DOTTED_VERBATIM_CONTRADICTORY', `${entry.id} has verbatim marked unavailable.`, { id: entry.id });
  }
  if (hasVerbatim && (typeof entry.verbatim !== 'string' || entry.verbatim.length === 0)) {
    fail('LEGACY_DOTTED_VERBATIM_INVALID', `${entry.id} verbatim is invalid.`, { id: entry.id });
  }
  if (!hasVerbatim && entry.verbatimAvailable !== false) {
    fail('LEGACY_DOTTED_VERBATIM_UNMARKED', `${entry.id} has no verbatim and is not marked unavailable.`, { id: entry.id });
  }
  if (entry.gates !== undefined && !Array.isArray(entry.gates)) {
    fail('LEGACY_DOTTED_GATES_INVALID', `${entry.id} gates are invalid.`, { id: entry.id });
  }
  return Object.freeze({
    id: entry.id,
    status: hasStatus ? entry.status : null,
    verbatimAvailable: hasVerbatim,
    ...(hasVerbatim ? { verbatim: entry.verbatim } : {}),
    gates: cloneAndFreeze(entry.gates || [])
  });
}

function mergeGates(root, dotted) {
  if (root.gates.length !== dotted.gates.length) {
    fail('LEGACY_DOTTED_GATE_SHAPE_MISMATCH', `${root.id}/${dotted.id} gate counts differ.`, {
      rootId: root.id,
      dottedId: dotted.id
    });
  }
  return Object.freeze(root.gates.map((rootGate, index) => {
    const dottedGate = dotted.gates[index];
    if (!plain(rootGate) || !plain(dottedGate)
        || typeof rootGate.instruction !== 'string'
        || rootGate.instruction !== dottedGate.instruction
        || typeof rootGate.met !== 'boolean' || typeof dottedGate.met !== 'boolean'
        || typeof rootGate.evidence !== 'string' || typeof dottedGate.evidence !== 'string') {
      fail('LEGACY_DOTTED_GATE_SHAPE_MISMATCH', `${root.id}/${dotted.id} gate ${index} cannot be aligned.`, {
        rootId: root.id,
        dottedId: dotted.id,
        gateIndex: index
      });
    }
    const stateConflict = rootGate.met !== dottedGate.met;
    const evidenceConflict = rootGate.evidence !== dottedGate.evidence;
    return Object.freeze({
      instruction: dottedGate.instruction,
      state: dottedGate.met ? 'met' : 'unmet',
      met: dottedGate.met,
      evidence: dottedGate.evidence,
      sourceConflict: stateConflict,
      evidenceState: evidenceConflict ? 'divergent' : 'identical',
      effectiveSource: Object.freeze({ requestId: dotted.id, gateIndex: index }),
      copies: Object.freeze([
        Object.freeze({ requestId: root.id, gateIndex: index, gate: cloneAndFreeze(rootGate) }),
        Object.freeze({ requestId: dotted.id, gateIndex: index, gate: cloneAndFreeze(dottedGate) })
      ])
    });
  }));
}

function buildLegacyDottedDisposition(requests, policy = EMPTY_MIGRATION_POLICY) {
  if (!Array.isArray(requests) || requests.length > 10_000) {
    fail('LEGACY_DOTTED_INPUT_INVALID', 'Ledger requests must be an array of at most 10,000 entries.');
  }
  const migrationPolicy = normalizePolicy(policy);
  const byId = new Map();
  for (const entry of requests) {
    if (!plain(entry) || !isRequestId(entry.id, { family: 'R' })) {
      fail('LEGACY_DOTTED_INPUT_INVALID', 'Every ledger request must have a valid R id.');
    }
    if (byId.has(entry.id)) fail('LEGACY_DOTTED_ID_DUPLICATE', `Duplicate request id ${entry.id}.`, { id: entry.id });
    byId.set(entry.id, entry);
  }
  const requireSource = id => {
    const entry = byId.get(id);
    if (!entry) fail('LEGACY_DOTTED_SOURCE_MISSING', `Required migration source ${id} is missing.`, { id });
    return sourceRecord(entry);
  };

  const continuations = Object.freeze(migrationPolicy.continuationIds.map(id => Object.freeze({
    type: 'legacy-continuation',
    id,
    policyDeclared: true,
    participatesInVersionLineage: false,
    ledgerNote: migrationPolicy.continuationNote,
    provenanceBasis: migrationPolicy.provenanceBasis,
    source: requireSource(id)
  })));

  const duplicateVersionMerges = Object.freeze(migrationPolicy.duplicatePairs.map(([rootId, dottedId]) => {
    const root = requireSource(rootId);
    const dotted = requireSource(dottedId);
    if (root.verbatimAvailable && dotted.verbatimAvailable && root.verbatim !== dotted.verbatim) {
      fail('LEGACY_DOTTED_CONTENT_MISMATCH', `${rootId}/${dottedId} verbatim records differ.`, { rootId, dottedId });
    }
    const gates = mergeGates(root, dotted);
    const conflictingGateCount = gates.filter(gate => gate.sourceConflict).length;
    return Object.freeze({
      type: 'legacy-duplicate-version-merge',
      rootId,
      activeId: dottedId,
      lineage: Object.freeze([rootId, dottedId]),
      supersededIds: Object.freeze([rootId]),
      provenanceBasis: migrationPolicy.provenanceBasis,
      contentComparison: root.verbatimAvailable && dotted.verbatimAvailable
        ? 'byte-identical-verbatim'
        : 'unavailable-no-verbatim',
      activeStatus: dotted.status,
      statusState: root.status === null || dotted.status === null
        ? 'unavailable'
        : root.status === dotted.status ? 'agreed' : 'resolved-to-active-version',
      gateState: conflictingGateCount > 0 ? 'resolved-to-active-version' : 'agreed',
      conflictingGateCount,
      gates,
      sources: Object.freeze([root, dotted])
    });
  }));

  return Object.freeze({
    schemaVersion: 1,
    appliesChanges: false,
    preservesVerbatim: true,
    policy: migrationPolicy,
    continuations,
    duplicateVersionMerges
  });
}

function buildLegacyDottedMetadataById(requests, policy = EMPTY_MIGRATION_POLICY) {
  const disposition = buildLegacyDottedDisposition(requests, policy);
  const metadata = {};
  for (const continuation of disposition.continuations) {
    metadata[continuation.id] = Object.freeze({
      versioningNote: continuation.ledgerNote,
      versioningDisposition: Object.freeze({
        schemaVersion: 1,
        kind: continuation.type,
        policyDeclared: true,
        participatesInVersionLineage: false,
        provenanceBasis: continuation.provenanceBasis
      })
    });
  }
  for (const merge of disposition.duplicateVersionMerges) {
    metadata[merge.activeId] = Object.freeze({
      versioningDisposition: Object.freeze({
        schemaVersion: 1,
        kind: merge.type,
        provenanceBasis: merge.provenanceBasis,
        rootId: merge.rootId,
        activeId: merge.activeId,
        sourceIds: merge.lineage,
        supersededIds: merge.supersededIds,
        contentComparison: merge.contentComparison,
        activeStatus: merge.activeStatus,
        statusState: merge.statusState,
        gateState: merge.gateState,
        conflictingGateCount: merge.conflictingGateCount,
        gateHistories: Object.freeze(merge.sources.map(source => Object.freeze({
          requestId: source.id,
          gates: source.gates
        }))),
        mergedGates: merge.gates
      })
    });
  }
  return Object.freeze(metadata);
}

module.exports = Object.freeze({
  LegacyDottedDispositionError,
  EMPTY_MIGRATION_POLICY,
  normalizePolicy,
  buildLegacyDottedDisposition,
  buildLegacyDottedMetadataById
});
