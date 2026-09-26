'use strict';

const assert = require('node:assert/strict');
const {
  OwnerRequestScopeProposalError,
  buildScopeProposal,
  proposalHash,
  sha256,
  validateReviewReceipt,
  validateScopeProposal
} = require('../src/lib/owner-request-scope-proposal');

const AT = '2026-02-01T00:00:00.000Z';

function request(id, text = 'Use the explicitly reviewed current setting.') {
  return {
    id,
    status: 'open',
    verbatim: text,
    provenance: {
      class: 'owner-stated',
      source: `fixture-message/${id}`,
      recordedBy: 'scope-refusal-test',
      recordedAt: '2026-01-01T00:00:00.000Z'
    },
    gates: []
  };
}

function rule(id, sourceRequestId, text, extra = {}) {
  return {
    schemaVersion: 1,
    ruleId: id,
    ruleKey: extra.ruleKey || 'setting.mode',
    scopeKind: 'global',
    threadId: null,
    sourceRequestId,
    issuedAt: extra.issuedAt || '2026-01-02T00:00:00.000Z',
    expiresAt: null,
    decisionSummary: 'Current reviewed setting.',
    evidenceRefs: extra.evidenceRefs === undefined ? [`fixture/scope/${id}`] : extra.evidenceRefs,
    ownerVerbatim: text
  };
}

function input(requests, rules = []) {
  const currentLedger = { schemaVersion: 1, revision: 1, updatedAt: '2026-01-31', requests };
  return {
    ledger: currentLedger,
    ledgerRaw: JSON.stringify(currentLedger),
    scopeRules: rules,
    scopeStoreSnapshot: {
      exists: rules.length > 0,
      revision: rules.length > 0 ? 1 : 0,
      sha256: sha256(rules.length > 0 ? JSON.stringify({ rules }) : 'absent')
    },
    evaluatedAt: AT
  };
}

let checks = 0;
function refusal(expectedCode, work) {
  assert.throws(work, error => error instanceof OwnerRequestScopeProposalError && error.code === expectedCode);
  checks += 1;
}

const currentRequest = request('R40');
const currentRule = rule('rule_current_setting', 'R40', currentRequest.verbatim);
const base = buildScopeProposal(input([currentRequest], [currentRule]));

refusal('OWNER_SCOPE_PROPOSAL_INVALID', () => buildScopeProposal({ ...input([], []), unexpected: true }));
refusal('OWNER_SCOPE_PROPOSAL_LEDGER_INVALID', () => buildScopeProposal({
  ...input([currentRequest], [currentRule]),
  ledgerRaw: JSON.stringify({ revision: 1, requests: [] })
}));
refusal('OWNER_SCOPE_PROPOSAL_LEDGER_INVALID', () => buildScopeProposal(input([currentRequest, currentRequest], [])));
refusal('OWNER_SCOPE_PROPOSAL_SCOPE_RULES_INVALID', () => buildScopeProposal(input(
  [currentRequest],
  [currentRule, currentRule]
)));
refusal('OWNER_SCOPE_PROPOSAL_SCOPE_STORE_INVALID', () => buildScopeProposal({
  ...input([currentRequest], [currentRule]),
  scopeStoreSnapshot: { exists: false, revision: 0, sha256: sha256('absent') }
}));
refusal('OWNER_SCOPE_PROPOSAL_INVALID', () => buildScopeProposal({
  ...input([currentRequest], [currentRule]),
  evaluatedAt: 'not-a-time'
}));

const noProvenance = buildScopeProposal(input([{
  id: 'R41',
  status: 'open',
  verbatim: 'This request lacks current provenance.',
  gates: []
}], [rule('rule_no_request_provenance', 'R41', 'This request lacks current provenance.') ]));
assert.equal(noProvenance.rules.length, 0);
assert.equal(noProvenance.entries[0].classification, 'unresolved-no-current-provenance');
checks += 2;

const missingEvidence = buildScopeProposal(input(
  [request('R42')],
  [rule('rule_no_scope_evidence', 'R42', request('R42').verbatim, { evidenceRefs: [] })]
));
assert.equal(missingEvidence.rules.length, 0);
assert.deepEqual(missingEvidence.entries[0].unresolvedReasons, ['current-scope-evidence-missing']);
checks += 2;

const orphanedScope = buildScopeProposal(input(
  [request('R43')],
  [rule('rule_orphaned_source', 'R44', 'A request that is not in the current ledger.')]
));
assert.equal(orphanedScope.applyState, 'blocked-unresolved-scope-rules');
assert.deepEqual(orphanedScope.orphanedScopeRules, [{
  ruleId: 'rule_orphaned_source',
  sourceRequestId: 'R44',
  reason: 'source-request-not-current'
}]);
checks += 2;

const tamperedPolicy = structuredClone(base);
tamperedPolicy.policy.requestIdSemantics = 'numeric-priority';
tamperedPolicy.proposalSha256 = proposalHash(tamperedPolicy);
refusal('OWNER_SCOPE_PROPOSAL_INVALID', () => validateScopeProposal(tamperedPolicy));

const tamperedResolution = structuredClone(base);
tamperedResolution.resolution.activeRuleIds = [];
tamperedResolution.proposalSha256 = proposalHash(tamperedResolution);
refusal('OWNER_SCOPE_PROPOSAL_RESOLUTION_INVALID', () => validateScopeProposal(tamperedResolution));

const tamperedRuleHash = structuredClone(base);
tamperedRuleHash.rulesSha256 = '0'.repeat(64);
tamperedRuleHash.proposalSha256 = proposalHash(tamperedRuleHash);
refusal('OWNER_SCOPE_PROPOSAL_HASH_MISMATCH', () => validateScopeProposal(tamperedRuleHash));

const receipt = {
  schemaVersion: 1,
  proposalSha256: base.proposalSha256,
  ledgerRevision: base.sourceLedger.revision,
  ledgerSha256: base.sourceLedger.sha256,
  scopeStoreRevision: base.sourceScopeStore.revision,
  scopeStoreSha256: base.sourceScopeStore.sha256,
  reviewedAt: '2026-02-01T01:00:00.000Z',
  reviewedBy: 'customer-reviewer',
  decision: 'approve',
  reviewedRequestIds: []
};
refusal('OWNER_SCOPE_PROPOSAL_REVIEW_INCOMPLETE', () => validateReviewReceipt(receipt, base));
refusal('OWNER_SCOPE_PROPOSAL_REVIEW_INVALID', () => validateReviewReceipt({
  ...receipt,
  reviewedRequestIds: ['R40'],
  proposalSha256: '0'.repeat(64)
}, base));
refusal('OWNER_SCOPE_PROPOSAL_REVIEW_BLOCKED', () => validateReviewReceipt({
  ...receipt,
  proposalSha256: orphanedScope.proposalSha256,
  ledgerRevision: orphanedScope.sourceLedger.revision,
  ledgerSha256: orphanedScope.sourceLedger.sha256,
  scopeStoreRevision: orphanedScope.sourceScopeStore.revision,
  scopeStoreSha256: orphanedScope.sourceScopeStore.sha256,
  reviewedRequestIds: ['R43']
}, orphanedScope));

console.log(`owner request scope proposal refusal tests passed (${checks} checks)`);
