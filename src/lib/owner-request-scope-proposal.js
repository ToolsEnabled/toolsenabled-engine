'use strict';

// Read-only proposal projection for CURRENT customer scope data.
//
// Request identifiers are opaque identities. They never imply a scope,
// classification, supersession, product decision, or migration rule. A rule is
// eligible only when the supplied current ledger establishes owner authority,
// the supplied current scope record cites evidence, and its verbatim text is
// still present in that ledger entry. Anything else remains unresolved.

const crypto = require('node:crypto');
const {
  normalizeScopeRule,
  resolveScopeRules,
  resolveFullySupersededRequests
} = require('./owner-request-scope');
const { isRequestId } = require('./request-id');
const { assertCitableAsOwnerRequirement } = require('./owner-request-provenance');

const PROPOSAL_VERSION = 1;
const REVIEW_VERSION = 1;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_RULES = 4096;

class OwnerRequestScopeProposalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OwnerRequestScopeProposalError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new OwnerRequestScopeProposalError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, allowed, required, label) {
  if (!plain(value)) fail('OWNER_SCOPE_PROPOSAL_INVALID', `${label} must be an object.`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    fail('OWNER_SCOPE_PROPOSAL_INVALID', `${label} fields are invalid.`, { unknown, missing });
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!plain(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function proposalHash(value) {
  if (!plain(value)) fail('OWNER_SCOPE_PROPOSAL_INVALID', 'Proposal must be an object.');
  const { proposalSha256, ...core } = value;
  return sha256(canonicalJson(core));
}

function isoTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('OWNER_SCOPE_PROPOSAL_INVALID', `${field} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function normalizeSnapshot(value) {
  exact(value, ['exists', 'revision', 'sha256'], ['exists', 'revision', 'sha256'], 'scope store snapshot');
  if (typeof value.exists !== 'boolean'
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)) {
    fail('OWNER_SCOPE_PROPOSAL_SCOPE_STORE_INVALID', 'Scope store snapshot is invalid.');
  }
  if (!value.exists && value.revision !== 0) {
    fail('OWNER_SCOPE_PROPOSAL_SCOPE_STORE_INVALID', 'An absent scope store must have revision zero.');
  }
  return Object.freeze({ exists: value.exists, revision: value.revision, sha256: value.sha256 });
}

function normalizeLedger(ledger, ledgerRaw) {
  if (!plain(ledger) || !Number.isSafeInteger(ledger.revision) || ledger.revision < 0
      || !Array.isArray(ledger.requests) || typeof ledgerRaw !== 'string') {
    fail('OWNER_SCOPE_PROPOSAL_LEDGER_INVALID', 'Current ledger input is invalid.');
  }
  let parsed;
  try { parsed = JSON.parse(ledgerRaw); }
  catch { fail('OWNER_SCOPE_PROPOSAL_LEDGER_INVALID', 'Current ledger bytes are not valid JSON.'); }
  if (canonicalJson(parsed) !== canonicalJson(ledger)) {
    fail('OWNER_SCOPE_PROPOSAL_LEDGER_INVALID', 'Current ledger bytes do not match the supplied ledger value.');
  }
  const seen = new Set();
  const requests = ledger.requests.map((request, index) => {
    if (!plain(request) || !isRequestId(request.id, { family: 'R' })) {
      fail('OWNER_SCOPE_PROPOSAL_LEDGER_INVALID', `Ledger request at index ${index} is invalid.`);
    }
    if (seen.has(request.id)) {
      fail('OWNER_SCOPE_PROPOSAL_LEDGER_INVALID', `Ledger request id ${request.id} is duplicated.`);
    }
    seen.add(request.id);
    if (Object.hasOwn(request, 'verbatim') && (typeof request.verbatim !== 'string' || request.verbatim.length === 0)) {
      fail('OWNER_SCOPE_PROPOSAL_LEDGER_INVALID', `Ledger request ${request.id} has invalid verbatim text.`);
    }
    let authorityClass = null;
    try { authorityClass = assertCitableAsOwnerRequirement(request, 'current scope proposal'); }
    catch { authorityClass = null; }
    return Object.freeze({
      id: request.id,
      verbatim: typeof request.verbatim === 'string' ? request.verbatim : null,
      authorityClass
    });
  });
  return Object.freeze({
    revision: ledger.revision,
    sha256: sha256(ledgerRaw),
    requests: Object.freeze(requests)
  });
}

function normalizeCurrentRules(value) {
  if (!Array.isArray(value) || value.length > MAX_RULES) {
    fail('OWNER_SCOPE_PROPOSAL_SCOPE_RULES_INVALID', `Current scope rules must be an array of at most ${MAX_RULES} entries.`);
  }
  const rules = value.map(normalizeScopeRule);
  const ids = rules.map(rule => rule.ruleId);
  if (new Set(ids).size !== ids.length) {
    fail('OWNER_SCOPE_PROPOSAL_SCOPE_RULES_INVALID', 'Current scope rules contain duplicate rule ids.');
  }
  return Object.freeze(rules);
}

function assessRule(rule, request) {
  if (!request) return Object.freeze({ eligible: false, reason: 'source-request-not-current' });
  if (request.authorityClass === null) {
    return Object.freeze({ eligible: false, reason: 'request-provenance-not-currently-citable' });
  }
  if (request.verbatim === null) return Object.freeze({ eligible: false, reason: 'current-owner-verbatim-unavailable' });
  if (rule.evidenceRefs.length === 0) return Object.freeze({ eligible: false, reason: 'current-scope-evidence-missing' });
  if (!request.verbatim.includes(rule.ownerVerbatim)) {
    return Object.freeze({ eligible: false, reason: 'scope-verbatim-not-in-current-ledger' });
  }
  return Object.freeze({ eligible: true, reason: null });
}

function resolutionFor(rules, evaluatedAt) {
  const nowMs = Date.parse(evaluatedAt);
  const contexts = [null, ...new Set(rules.filter(rule => rule.scopeKind === 'thread').map(rule => rule.threadId))];
  const activeRuleIds = new Set();
  const conflicts = new Map();
  for (const threadId of contexts) {
    const resolution = resolveScopeRules(rules, { threadId, nowMs });
    for (const ruleId of resolution.appliedRuleIds) activeRuleIds.add(ruleId);
    for (const conflict of resolution.conflicts) conflicts.set(canonicalJson(conflict), conflict);
  }
  const fullySupersededRequests = resolveFullySupersededRequests(rules, { nowMs });
  return Object.freeze({
    evaluatedAt,
    activeRuleIds: Object.freeze([...activeRuleIds].sort()),
    conflicts: Object.freeze([...conflicts.values()].sort((left, right) => left.ruleKey.localeCompare(right.ruleKey, 'en'))),
    fullySupersededRequests
  });
}

function buildScopeProposal(input) {
  exact(input,
    ['ledger', 'ledgerRaw', 'scopeRules', 'scopeStoreSnapshot', 'evaluatedAt'],
    ['ledger', 'ledgerRaw', 'scopeRules', 'scopeStoreSnapshot', 'evaluatedAt'],
    'proposal input');
  const ledger = normalizeLedger(input.ledger, input.ledgerRaw);
  const sourceScopeStore = normalizeSnapshot(input.scopeStoreSnapshot);
  const evaluatedAt = isoTimestamp(input.evaluatedAt, 'evaluatedAt');
  const currentRules = normalizeCurrentRules(input.scopeRules);
  if (!sourceScopeStore.exists && currentRules.length > 0) {
    fail('OWNER_SCOPE_PROPOSAL_SCOPE_STORE_INVALID', 'An absent scope store cannot supply current scope rules.');
  }

  const requestsById = new Map(ledger.requests.map(request => [request.id, request]));
  const assessments = currentRules.map(rule => Object.freeze({
    rule,
    ...assessRule(rule, requestsById.get(rule.sourceRequestId))
  }));
  const eligibleRules = [];
  const entries = ledger.requests.map(request => {
    const attached = assessments.filter(item => item.rule.sourceRequestId === request.id);
    const rejected = attached.filter(item => !item.eligible);
    const accepted = rejected.length === 0 ? attached.filter(item => item.eligible) : [];
    eligibleRules.push(...accepted.map(item => item.rule));
    const reasons = rejected.length > 0
      ? [...new Set(rejected.map(item => item.reason))].sort()
      : (accepted.length === 0 ? ['no-current-scope-provenance'] : []);
    const classification = accepted.length > 0
      ? 'classified-from-current-scope'
      : (request.verbatim === null ? 'unresolved-no-current-verbatim' : 'unresolved-no-current-provenance');
    return Object.freeze({
      sourceRequestId: request.id,
      verbatimAvailable: request.verbatim !== null,
      authorityClass: request.authorityClass,
      classification,
      ruleIds: Object.freeze(attached.map(item => item.rule.ruleId).sort()),
      eligibleRuleIds: Object.freeze(accepted.map(item => item.rule.ruleId).sort()),
      unresolvedReasons: Object.freeze(reasons)
    });
  });

  const orphanedScopeRules = assessments
    .filter(item => !requestsById.has(item.rule.sourceRequestId))
    .map(item => Object.freeze({
      ruleId: item.rule.ruleId,
      sourceRequestId: item.rule.sourceRequestId,
      reason: item.reason
    }))
    .sort((left, right) => left.ruleId.localeCompare(right.ruleId, 'en'));
  const unresolvedEntries = entries
    .filter(entry => entry.classification.startsWith('unresolved-'))
    .map(entry => Object.freeze({
      sourceRequestId: entry.sourceRequestId,
      reasons: entry.unresolvedReasons
    }));
  const rules = Object.freeze([...eligibleRules].sort((left, right) => left.ruleId.localeCompare(right.ruleId, 'en')));
  const resolution = resolutionFor(rules, evaluatedAt);
  const counts = Object.freeze({
    entryCount: entries.length,
    currentScopeRuleCount: currentRules.length,
    eligibleRuleCount: rules.length,
    rejectedScopeRuleCount: currentRules.length - rules.length,
    unresolvedEntryCount: unresolvedEntries.length,
    orphanedScopeRuleCount: orphanedScopeRules.length,
    fullySupersededRequestCount: resolution.fullySupersededRequests.length
  });
  const core = {
    schemaVersion: PROPOSAL_VERSION,
    kind: 'owner-request-scope-proposal',
    generatedAt: evaluatedAt,
    sourceLedger: Object.freeze({ revision: ledger.revision, sha256: ledger.sha256 }),
    sourceScopeStore,
    policy: Object.freeze({
      authority: 'supplied-current-ledger-and-scope-only',
      requestIdSemantics: 'opaque-identity-only',
      missingProvenance: 'unresolved-fail-closed'
    }),
    entries: Object.freeze(entries),
    rules,
    rulesSha256: sha256(canonicalJson(rules)),
    resolution,
    unresolvedEntries: Object.freeze(unresolvedEntries),
    orphanedScopeRules: Object.freeze(orphanedScopeRules),
    counts,
    applyState: orphanedScopeRules.length > 0 ? 'blocked-unresolved-scope-rules' : 'review-required'
  };
  return Object.freeze({ ...core, proposalSha256: proposalHash(core) });
}

function validateScopeProposal(proposal) {
  exact(proposal, [
    'schemaVersion', 'kind', 'generatedAt', 'sourceLedger', 'sourceScopeStore', 'policy',
    'entries', 'rules', 'rulesSha256', 'resolution', 'unresolvedEntries',
    'orphanedScopeRules', 'counts', 'applyState', 'proposalSha256'
  ], [
    'schemaVersion', 'kind', 'generatedAt', 'sourceLedger', 'sourceScopeStore', 'policy',
    'entries', 'rules', 'rulesSha256', 'resolution', 'unresolvedEntries',
    'orphanedScopeRules', 'counts', 'applyState', 'proposalSha256'
  ], 'scope proposal');
  if (proposal.schemaVersion !== PROPOSAL_VERSION || proposal.kind !== 'owner-request-scope-proposal') {
    fail('OWNER_SCOPE_PROPOSAL_VERSION_UNSUPPORTED', 'Scope proposal version or kind is unsupported.');
  }
  const generatedAt = isoTimestamp(proposal.generatedAt, 'generatedAt');
  exact(proposal.sourceLedger, ['revision', 'sha256'], ['revision', 'sha256'], 'source ledger');
  if (!Number.isSafeInteger(proposal.sourceLedger.revision) || proposal.sourceLedger.revision < 0
      || !SHA256_RE.test(proposal.sourceLedger.sha256 || '')) {
    fail('OWNER_SCOPE_PROPOSAL_INVALID', 'Source ledger descriptor is invalid.');
  }
  normalizeSnapshot(proposal.sourceScopeStore);
  if (canonicalJson(proposal.policy) !== canonicalJson({
    authority: 'supplied-current-ledger-and-scope-only',
    requestIdSemantics: 'opaque-identity-only',
    missingProvenance: 'unresolved-fail-closed'
  }) || !['review-required', 'blocked-unresolved-scope-rules'].includes(proposal.applyState)) {
    fail('OWNER_SCOPE_PROPOSAL_INVALID', 'Scope proposal policy is invalid.');
  }
  if (!Array.isArray(proposal.entries) || !Array.isArray(proposal.rules)
      || !Array.isArray(proposal.unresolvedEntries) || !Array.isArray(proposal.orphanedScopeRules)) {
    fail('OWNER_SCOPE_PROPOSAL_INVALID', 'Scope proposal collections are invalid.');
  }
  const entryIds = new Set();
  const entries = proposal.entries.map(entry => {
    exact(entry, [
      'sourceRequestId', 'verbatimAvailable', 'authorityClass', 'classification',
      'ruleIds', 'eligibleRuleIds', 'unresolvedReasons'
    ], [
      'sourceRequestId', 'verbatimAvailable', 'authorityClass', 'classification',
      'ruleIds', 'eligibleRuleIds', 'unresolvedReasons'
    ], 'proposal entry');
    const stringListsValid = [entry.ruleIds, entry.eligibleRuleIds, entry.unresolvedReasons]
      .every(list => Array.isArray(list) && list.every(item => typeof item === 'string')
        && new Set(list).size === list.length);
    if (!isRequestId(entry.sourceRequestId, { family: 'R' }) || entryIds.has(entry.sourceRequestId)
        || typeof entry.verbatimAvailable !== 'boolean'
        || ![null, 'owner-stated', 'owner-ratified'].includes(entry.authorityClass)
        || !['classified-from-current-scope', 'unresolved-no-current-verbatim', 'unresolved-no-current-provenance'].includes(entry.classification)
        || !stringListsValid
        || entry.eligibleRuleIds.some(ruleId => !entry.ruleIds.includes(ruleId))
        || (entry.classification === 'classified-from-current-scope'
          ? entry.eligibleRuleIds.length === 0 || entry.unresolvedReasons.length !== 0
          : entry.eligibleRuleIds.length !== 0 || entry.unresolvedReasons.length === 0)) {
      fail('OWNER_SCOPE_PROPOSAL_INVALID', 'Proposal entry is invalid.');
    }
    entryIds.add(entry.sourceRequestId);
    return entry;
  });
  const rules = normalizeCurrentRules(proposal.rules);
  for (const rule of rules) {
    if (!entryIds.has(rule.sourceRequestId) || rule.evidenceRefs.length === 0) {
      fail('OWNER_SCOPE_PROPOSAL_PROVENANCE_REQUIRED', 'Every proposed rule needs a current request and explicit evidence.');
    }
    const entry = entries.find(item => item.sourceRequestId === rule.sourceRequestId);
    if (entry.classification !== 'classified-from-current-scope'
        || !entry.eligibleRuleIds.includes(rule.ruleId)) {
      fail('OWNER_SCOPE_PROPOSAL_INVALID', 'Proposed rule and entry classification disagree.');
    }
  }
  const eligibleIds = [...rules.map(rule => rule.ruleId)].sort();
  const entryEligibleIds = [...entries.flatMap(entry => entry.eligibleRuleIds)].sort();
  if (canonicalJson(eligibleIds) !== canonicalJson(entryEligibleIds)
      || proposal.rulesSha256 !== sha256(canonicalJson(rules))) {
    fail('OWNER_SCOPE_PROPOSAL_HASH_MISMATCH', 'Proposal rule identities or hash do not match.');
  }
  const resolution = resolutionFor(rules, generatedAt);
  if (canonicalJson(proposal.resolution) !== canonicalJson(resolution)) {
    fail('OWNER_SCOPE_PROPOSAL_RESOLUTION_INVALID', 'Proposal resolution is not derived from its supplied current rules.');
  }
  const unresolvedEntries = entries
    .filter(entry => entry.classification.startsWith('unresolved-'))
    .map(entry => ({ sourceRequestId: entry.sourceRequestId, reasons: entry.unresolvedReasons }));
  if (canonicalJson(proposal.unresolvedEntries) !== canonicalJson(unresolvedEntries)) {
    fail('OWNER_SCOPE_PROPOSAL_INVALID', 'Unresolved entry projection is inconsistent.');
  }
  const orphanedScopeRules = proposal.orphanedScopeRules.map(item => {
    exact(item, ['ruleId', 'sourceRequestId', 'reason'], ['ruleId', 'sourceRequestId', 'reason'], 'orphaned scope rule');
    if (typeof item.ruleId !== 'string' || !isRequestId(item.sourceRequestId, { family: 'R' })
        || item.reason !== 'source-request-not-current' || entryIds.has(item.sourceRequestId)) {
      fail('OWNER_SCOPE_PROPOSAL_INVALID', 'Orphaned scope rule projection is invalid.');
    }
    return item;
  });
  const allCurrentRuleIds = [...entries.flatMap(entry => entry.ruleIds), ...orphanedScopeRules.map(item => item.ruleId)];
  if (new Set(allCurrentRuleIds).size !== allCurrentRuleIds.length) {
    fail('OWNER_SCOPE_PROPOSAL_INVALID', 'Current scope rule identities are duplicated.');
  }
  exact(proposal.counts, [
    'entryCount', 'currentScopeRuleCount', 'eligibleRuleCount', 'rejectedScopeRuleCount',
    'unresolvedEntryCount', 'orphanedScopeRuleCount', 'fullySupersededRequestCount'
  ], [
    'entryCount', 'currentScopeRuleCount', 'eligibleRuleCount', 'rejectedScopeRuleCount',
    'unresolvedEntryCount', 'orphanedScopeRuleCount', 'fullySupersededRequestCount'
  ], 'proposal counts');
  const expectedCounts = {
    entryCount: entries.length,
    currentScopeRuleCount: allCurrentRuleIds.length,
    eligibleRuleCount: rules.length,
    rejectedScopeRuleCount: allCurrentRuleIds.length - rules.length,
    unresolvedEntryCount: unresolvedEntries.length,
    orphanedScopeRuleCount: proposal.orphanedScopeRules.length,
    fullySupersededRequestCount: resolution.fullySupersededRequests.length
  };
  if (Object.values(proposal.counts).some(value => !Number.isSafeInteger(value) || value < 0)
      || canonicalJson(proposal.counts) !== canonicalJson(expectedCounts)
      || proposal.applyState !== (orphanedScopeRules.length > 0 ? 'blocked-unresolved-scope-rules' : 'review-required')) {
    fail('OWNER_SCOPE_PROPOSAL_INVALID', 'Proposal counts are inconsistent.');
  }
  if (!SHA256_RE.test(proposal.proposalSha256 || '') || proposalHash(proposal) !== proposal.proposalSha256) {
    fail('OWNER_SCOPE_PROPOSAL_HASH_MISMATCH', 'Proposal SHA-256 does not match its content.');
  }
  return Object.freeze({ proposal, rules: Object.freeze(rules) });
}

function materializeProposalRules(proposal) {
  return validateScopeProposal(proposal).rules;
}

function requiredSpotCheckSize(proposal) {
  validateScopeProposal(proposal);
  return proposal.entries.length;
}

function validateReviewReceipt(receipt, proposal) {
  validateScopeProposal(proposal);
  if (proposal.applyState !== 'review-required') {
    fail('OWNER_SCOPE_PROPOSAL_REVIEW_BLOCKED', 'Review cannot approve while current scope rules have no current ledger source.');
  }
  exact(receipt, [
    'schemaVersion', 'proposalSha256', 'ledgerRevision', 'ledgerSha256',
    'scopeStoreRevision', 'scopeStoreSha256', 'reviewedAt', 'reviewedBy',
    'decision', 'reviewedRequestIds'
  ], [
    'schemaVersion', 'proposalSha256', 'ledgerRevision', 'ledgerSha256',
    'scopeStoreRevision', 'scopeStoreSha256', 'reviewedAt', 'reviewedBy',
    'decision', 'reviewedRequestIds'
  ], 'review receipt');
  if (receipt.schemaVersion !== REVIEW_VERSION || receipt.decision !== 'approve'
      || receipt.proposalSha256 !== proposal.proposalSha256
      || receipt.ledgerRevision !== proposal.sourceLedger.revision
      || receipt.ledgerSha256 !== proposal.sourceLedger.sha256
      || receipt.scopeStoreRevision !== proposal.sourceScopeStore.revision
      || receipt.scopeStoreSha256 !== proposal.sourceScopeStore.sha256
      || typeof receipt.reviewedBy !== 'string' || receipt.reviewedBy.trim().length < 2) {
    fail('OWNER_SCOPE_PROPOSAL_REVIEW_INVALID', 'Review receipt does not approve this exact proposal and source snapshots.');
  }
  isoTimestamp(receipt.reviewedAt, 'reviewedAt');
  if (!Array.isArray(receipt.reviewedRequestIds)
      || canonicalJson(receipt.reviewedRequestIds) !== canonicalJson(proposal.entries.map(entry => entry.sourceRequestId))) {
    fail('OWNER_SCOPE_PROPOSAL_REVIEW_INCOMPLETE', 'Review receipt must cover every current ledger request in proposal order.');
  }
  return Object.freeze({ ...receipt, reviewedBy: receipt.reviewedBy.trim() });
}

function renderScopeProposalReport(proposal) {
  validateScopeProposal(proposal);
  const lines = [
    '# Owner request scope proposal',
    '',
    `Proposal SHA-256: \`${proposal.proposalSha256}\``,
    `Ledger revision: ${proposal.sourceLedger.revision}`,
    `Current scope rules supplied: ${proposal.counts.currentScopeRuleCount}`,
    `Rules eligible from current provenance: ${proposal.counts.eligibleRuleCount}`,
    `Unresolved current requests: ${proposal.counts.unresolvedEntryCount}`,
    '',
    'Request identifiers are opaque identities and carry no classification or supersession semantics.',
    'Missing or non-current provenance is preserved as unresolved and produces no applicable rule.',
    '',
    '## Entries',
    '',
    '| Request | Classification | Eligible rules | Unresolved reasons |',
    '|---|---|---:|---|'
  ];
  for (const entry of proposal.entries) {
    lines.push(`| ${entry.sourceRequestId} | ${entry.classification} | ${entry.eligibleRuleIds.length} | ${entry.unresolvedReasons.join(', ') || 'none'} |`);
  }
  lines.push('', '## Supersession derived from current rules', '');
  if (proposal.resolution.fullySupersededRequests.length === 0) lines.push('None.');
  for (const item of proposal.resolution.fullySupersededRequests) {
    lines.push(`- ${item.sourceRequestId} is superseded by ${item.supersedingRequestIds.join(', ')} through shared current rule keys and issuance time.`);
  }
  return lines.join('\n');
}

module.exports = Object.freeze({
  OwnerRequestScopeProposalError,
  PROPOSAL_VERSION,
  REVIEW_VERSION,
  canonicalJson,
  sha256,
  proposalHash,
  buildScopeProposal,
  materializeProposalRules,
  validateScopeProposal,
  requiredSpotCheckSize,
  validateReviewReceipt,
  renderScopeProposalReport
});
