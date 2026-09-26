'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildScopeProposal,
  materializeProposalRules,
  proposalHash,
  requiredSpotCheckSize,
  validateReviewReceipt,
  validateScopeProposal,
  renderScopeProposalReport,
  sha256
} = require('../src/lib/owner-request-scope-proposal');
const scopeStore = require('../src/lib/owner-request-scope-store');
const {
  APPLY_CONFIRMATION,
  generateProposal,
  applyReviewedProposal,
  verifySourceSnapshots
} = require('../tools/owner-scope-proposal');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const EVALUATED_AT = '2026-01-10T00:00:00.000Z';

function ownerRequest(id, verbatim, extra = {}) {
  return {
    id,
    status: 'open',
    verbatim,
    provenance: {
      class: 'owner-stated',
      source: `fixture-message/${id}`,
      recordedBy: 'scope-proposal-test',
      recordedAt: '2026-01-01T00:00:00.000Z'
    },
    gates: [],
    ...extra
  };
}

function scopeRule(ruleId, ruleKey, sourceRequestId, issuedAt, ownerVerbatim, extra = {}) {
  return {
    schemaVersion: 1,
    ruleId,
    ruleKey,
    scopeKind: extra.scopeKind || 'global',
    threadId: extra.threadId || null,
    sourceRequestId,
    issuedAt,
    expiresAt: null,
    decisionSummary: 'Current customer scope decision.',
    evidenceRefs: extra.evidenceRefs === undefined ? [`fixture/scope/${ruleId}`] : extra.evidenceRefs,
    ownerVerbatim
  };
}

function ledger(requests, revision = 1) {
  return { schemaVersion: 1, revision, updatedAt: '2026-01-09', requests };
}

function proposalInput(currentLedger, rules, snapshot = null) {
  const raw = JSON.stringify(currentLedger, null, 2);
  return {
    ledger: currentLedger,
    ledgerRaw: raw,
    scopeRules: rules,
    scopeStoreSnapshot: snapshot || {
      exists: rules.length > 0,
      revision: rules.length > 0 ? 3 : 0,
      sha256: sha256(rules.length > 0 ? JSON.stringify({ rules }) : 'absent')
    },
    evaluatedAt: EVALUATED_AT
  };
}

let checks = 0;
function check(work) {
  work();
  checks += 1;
}

const requestA = ownerRequest('R10', 'Keep the current delivery mode until a newer approved rule replaces it.');
const requestB = ownerRequest('R11', 'Use the newly approved delivery mode.');
const requestC = {
  id: 'R12',
  status: 'open',
  verbatim: 'This text has no established current owner provenance.',
  provenance: { class: 'agent-inferred', recordedBy: 'fixture', recordedAt: '2026-01-01T00:00:00.000Z' },
  gates: []
};
const currentLedger = ledger([requestA, requestB, requestC], 7);
const rules = [
  scopeRule('rule_delivery_old', 'delivery.mode', 'R10', '2026-01-02T00:00:00.000Z', requestA.verbatim),
  scopeRule('rule_delivery_new', 'delivery.mode', 'R11', '2026-01-03T00:00:00.000Z', requestB.verbatim),
  scopeRule('rule_uncited_request', 'delivery.audit', 'R12', '2026-01-04T00:00:00.000Z', requestC.verbatim)
];
const proposal = buildScopeProposal(proposalInput(currentLedger, rules));

check(() => assert.equal(validateScopeProposal(proposal).proposal, proposal));
check(() => assert.deepEqual(materializeProposalRules(proposal).map(rule => rule.ruleId), [
  'rule_delivery_new',
  'rule_delivery_old'
]));
check(() => assert.deepEqual(proposal.entries.map(entry => [entry.sourceRequestId, entry.classification]), [
  ['R10', 'classified-from-current-scope'],
  ['R11', 'classified-from-current-scope'],
  ['R12', 'unresolved-no-current-provenance']
]));
check(() => assert.deepEqual(proposal.entries[2].unresolvedReasons, ['request-provenance-not-currently-citable']));
check(() => assert.deepEqual(proposal.resolution.fullySupersededRequests.map(item => ({
  sourceRequestId: item.sourceRequestId,
  supersedingRequestIds: item.supersedingRequestIds
})), [{ sourceRequestId: 'R10', supersedingRequestIds: ['R11'] }]));
check(() => assert.deepEqual(proposal.counts, {
  entryCount: 3,
  currentScopeRuleCount: 3,
  eligibleRuleCount: 2,
  rejectedScopeRuleCount: 1,
  unresolvedEntryCount: 1,
  orphanedScopeRuleCount: 0,
  fullySupersededRequestCount: 1
}));
check(() => assert.equal(proposal.policy.requestIdSemantics, 'opaque-identity-only'));
check(() => assert.equal(requiredSpotCheckSize(proposal), 3));
check(() => assert.equal(proposal.proposalSha256, proposalHash(proposal)));

const report = renderScopeProposalReport(proposal);
check(() => assert.match(report, /Request identifiers are opaque identities/));
check(() => assert.equal(report.includes(requestA.verbatim), false));

// Fresh-customer collision regression. The same syntactically valid request id
// appears in two independent customer inputs. Its outcome follows only the
// current provenance and scope data supplied with that input.
const collisionId = 'R25';
const customerOneRequest = ownerRequest(collisionId, 'Use the customer one review policy.');
const customerOne = buildScopeProposal(proposalInput(
  ledger([customerOneRequest]),
  [scopeRule('rule_customer_one', 'review.policy', collisionId, '2026-01-02T00:00:00.000Z', customerOneRequest.verbatim)]
));
const customerTwo = buildScopeProposal(proposalInput(
  ledger([ownerRequest(collisionId, 'Use the customer two review policy.')]),
  []
));
check(() => assert.equal(customerOne.entries[0].classification, 'classified-from-current-scope'));
check(() => assert.equal(customerTwo.entries[0].classification, 'unresolved-no-current-provenance'));
check(() => assert.equal(materializeProposalRules(customerTwo).length, 0));

const mismatchedRequest = ownerRequest('R30', 'Current wording only.');
const mismatch = buildScopeProposal(proposalInput(
  ledger([mismatchedRequest]),
  [scopeRule('rule_stale_text', 'wording.policy', 'R30', '2026-01-02T00:00:00.000Z', 'Earlier wording.')]
));
check(() => assert.deepEqual(mismatch.entries[0].unresolvedReasons, ['scope-verbatim-not-in-current-ledger']));
check(() => assert.equal(mismatch.rules.length, 0));

const missingEvidenceRequest = ownerRequest('R31', 'Require a cited current scope decision.');
const missingEvidence = buildScopeProposal(proposalInput(
  ledger([missingEvidenceRequest]),
  [scopeRule('rule_missing_evidence', 'evidence.policy', 'R31', '2026-01-02T00:00:00.000Z', missingEvidenceRequest.verbatim, { evidenceRefs: [] })]
));
check(() => assert.deepEqual(missingEvidence.entries[0].unresolvedReasons, ['current-scope-evidence-missing']));
check(() => assert.equal(missingEvidence.rules.length, 0));

const receipt = {
  schemaVersion: 1,
  proposalSha256: proposal.proposalSha256,
  ledgerRevision: proposal.sourceLedger.revision,
  ledgerSha256: proposal.sourceLedger.sha256,
  scopeStoreRevision: proposal.sourceScopeStore.revision,
  scopeStoreSha256: proposal.sourceScopeStore.sha256,
  reviewedAt: '2026-01-10T01:00:00.000Z',
  reviewedBy: 'customer-reviewer',
  decision: 'approve',
  reviewedRequestIds: proposal.entries.map(entry => entry.sourceRequestId)
};
check(() => assert.equal(validateReviewReceipt(receipt, proposal).decision, 'approve'));

const temporary = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'scope-proposal-neutral-'));
try {
  const ledgerFile = path.join(temporary, 'ledger.json');
  const scopeFile = path.join(temporary, 'scope.json');
  const proposalFile = path.join(temporary, 'proposal.json');
  const reportFile = path.join(temporary, 'proposal.md');
  const receiptFile = path.join(temporary, 'receipt.json');
  const toolLedger = ledger([requestA, requestB], 9);
  fs.writeFileSync(ledgerFile, `${JSON.stringify(toolLedger, null, 2)}\n`, 'utf8');
  fs.writeFileSync(scopeFile, `${JSON.stringify(scopeStore.normalizeStore({
    schemaVersion: 1,
    revision: 2,
    rules: rules.slice(0, 2)
  }), null, 2)}\n`, 'utf8');
  const generated = generateProposal({ ledger: ledgerFile, scopeStore: scopeFile, proposal: proposalFile, report: reportFile });
  const generatedProposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
  check(() => assert.equal(generated.ok, true));
  check(() => assert.equal(verifySourceSnapshots(generatedProposal, { ledger: ledgerFile, scopeStore: scopeFile }), true));
  const toolReceipt = {
    schemaVersion: 1,
    proposalSha256: generatedProposal.proposalSha256,
    ledgerRevision: generatedProposal.sourceLedger.revision,
    ledgerSha256: generatedProposal.sourceLedger.sha256,
    scopeStoreRevision: generatedProposal.sourceScopeStore.revision,
    scopeStoreSha256: generatedProposal.sourceScopeStore.sha256,
    reviewedAt: '2026-01-10T02:00:00.000Z',
    reviewedBy: 'customer-reviewer',
    decision: 'approve',
    reviewedRequestIds: generatedProposal.entries.map(entry => entry.sourceRequestId)
  };
  fs.writeFileSync(receiptFile, `${JSON.stringify(toolReceipt, null, 2)}\n`, 'utf8');
  const applied = applyReviewedProposal({
    ledger: ledgerFile,
    scopeStore: scopeFile,
    proposal: proposalFile,
    reviewReceipt: receiptFile,
    expectedProposalSha256: generatedProposal.proposalSha256,
    confirmation: APPLY_CONFIRMATION
  });
  check(() => assert.equal(applied.durable, true));
  const stored = scopeStore.readScopeStore({ file: scopeFile });
  check(() => assert.deepEqual(stored.reviewedRequestIds, ['R10', 'R11']));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`owner request scope proposal tests passed (${checks} checks)`);
