// EXECUTABLE CHANGE — mutation-proven discriminators for empty-ledger rules.
// Ledger contract test — B4 of the R53 hardening fleet.
//
// This is the "compliance is queryable, not just readable" gate for
// reports/OWNER-REQUEST-LEDGER.json: the durable record STANDING-ORDERS.md
// class RECORD calls "the master record". The ledger is read here, never
// written — this file has no business mutating the owner's request history.
//
// What is checked, and why each one maps back to a real incident:
//   - the file parses and every request id is unique and R-numbered
//   - every status is a declared member of statusVocabulary (never a status
//     the dashboard/owner can't interpret)
//   - every gates[] entry has {instruction, met, evidence}, and met:true
//     always carries non-empty evidence — an unmet gate with fabricated
//     evidence is exactly the "outcome summary substituting for verification"
//     failure mode RECORD rule 2 exists to prevent
//   - every entry either carries recorded verbatim or explicitly records
//     verbatimAvailable:false (P9), so historical controller interpretations
//     can never be presented as quotations of the owner
//   - no credential-shaped string appears anywhere in the file, reusing
//     src/lib/audit.js's own exported, already-battle-tested scrubText()
//     redaction rather than inventing a second secret-detector to drift
//     out of sync with the one every audited action already goes through.
//   - config/agent-org.json — the declared org the dashboard serves — still
//     passes src/lib/agent-org.js normalizeOrg(), so the org file cannot
//     silently rot out from under the dashboard's Control tab.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const audit = require('../src/lib/audit');
const agentOrg = require('../src/lib/agent-org');
const { isRequestId, parseRequestId } = require('../src/lib/request-id');

const startedAt = Date.now();
let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-ledger-contract-'));
const LEDGER_PATH = path.join(fixtureRoot, 'OWNER-REQUEST-LEDGER.json');
const ORG_PATH = path.join(__dirname, '..', 'config', 'agent-org.example.json');
fs.writeFileSync(LEDGER_PATH, `${JSON.stringify({
  schemaVersion: 1,
  revision: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  // The three statuses only src/lib/owner-request-store.js writes -- an
  // agent-filed row waiting for the person, one the person declined, one the
  // person deleted -- are part of the declared vocabulary like every other.
  statusVocabulary: { proposed: 'Proposed', open: 'Open', done: 'Done', declined: 'Declined', removed: 'Removed' },
  requests: []
}, null, 2)}\n`, 'utf8');
process.once('exit', () => { try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch {} });

const numericId = (id) => parseRequestId(id).rootNumber;

const invalidRequestIds = (list) => list
  .filter((request) => !isRequestId(request.id, { family: 'R' }))
  .map((request) => request.id);

const duplicateRequestIds = (list) => {
  const seen = new Set();
  const duplicates = [];
  for (const request of list) {
    if (seen.has(request.id)) duplicates.push(request.id);
    seen.add(request.id);
  }
  return duplicates;
};

const undeclaredStatuses = (list, declaredVocabulary) => list
  .filter((request) => !Object.prototype.hasOwnProperty.call(declaredVocabulary, request.status))
  .map((request) => `${request.id}:${request.status}`);

const malformedGates = (list) => {
  const violations = [];
  for (const request of list) {
    if (request.gates === undefined) continue;
    if (!Array.isArray(request.gates)) {
      violations.push(`${request.id}: gates must be an array`);
      continue;
    }
    request.gates.forEach((gate, index) => {
      const where = `${request.id}.gates[${index}]`;
      if (typeof gate.instruction !== 'string' || gate.instruction.trim() === '') {
        violations.push(`${where}: instruction must be a non-empty string`);
      }
      if (typeof gate.met !== 'boolean') violations.push(`${where}: met must be a boolean`);
      if (typeof gate.evidence !== 'string') violations.push(`${where}: evidence must be a string`);
    });
  }
  return violations;
};

const gatesMissingEvidence = (list) => {
  const violations = [];
  for (const request of list) {
    if (!Array.isArray(request.gates)) continue;
    request.gates.forEach((gate, index) => {
      if (gate.met === true && (typeof gate.evidence !== 'string' || gate.evidence.trim() === '')) {
        violations.push(`${request.id}.gates[${index}]: met:true with no evidence`);
      }
    });
  }
  return violations;
};

// Read once, up front. Every assertion below operates on this in-memory
// snapshot — nothing in this file calls fs.writeFileSync on either path.
const ledgerRawBefore = fs.readFileSync(LEDGER_PATH, 'utf8');

// --- parses clean -------------------------------------------------------

let ledger;
check('the ledger file parses as JSON', () => {
  ledger = JSON.parse(ledgerRawBefore);
  assert.equal(typeof ledger, 'object');
  assert.ok(ledger, 'ledger must not be null');
});

// A ZERO-REQUEST LEDGER IS WELL FORMED. This contract checks that the record
// obeys its own rules, and a record with nothing in it obeys them vacuously.
// `requests.length > 0` used to be asserted here; the owner reset the ledger to
// zero on 2026-08-12 and this test failed on its second check, reporting a
// "broken contract" for what is in fact the normal state of a fresh install.
// Every rule below is written as "no entry violates X", which is the form that
// survives an empty record without weakening on a full one.
check('the ledger carries a requests array and a statusVocabulary object', () => {
  assert.ok(Array.isArray(ledger.requests), 'requests must be an array');
  assert.equal(typeof ledger.statusVocabulary, 'object');
  assert.ok(ledger.statusVocabulary, 'statusVocabulary must not be null');
  assert.ok(Object.keys(ledger.statusVocabulary).length > 0,
    'the declared status vocabulary is part of the schema, not of the data, so it is never empty');
});

const requests = ledger.requests;
const vocabulary = ledger.statusVocabulary;

// --- request ids: unique and R-numbered ----------------------------------

check('every request id is R-numbered', () => {
  assert.deepEqual(invalidRequestIds(requests), [], 'every id must match the canonical R request-id grammar');
});

check('numeric root handling preserves zero-padded and dotted historical ids', () => {
  assert.equal(numericId('R01'), 1);
  assert.equal(numericId('R25.1'), 25);
  assert.equal(numericId('R1162'), 1162);
});

check('every request id is unique', () => {
  const duplicates = duplicateRequestIds(requests);
  assert.deepEqual(duplicates, [], `duplicate request ids: ${duplicates.join(', ')}`);
});

// --- status must be a declared vocabulary member -------------------------

check('every request status is a member of statusVocabulary', () => {
  const violators = undeclaredStatuses(requests, vocabulary);
  assert.deepEqual(violators, [], `requests with an undeclared status: ${violators.join(', ')}`);
});

// --- gates[] shape ---------------------------------------------------------

check('every gates[] entry has a well-formed {instruction, met, evidence}', () => {
  const violations = malformedGates(requests);
  assert.deepEqual(violations, [], violations.join('; '));
});

check('met:true gates always carry non-empty evidence (no unmet gate can pass silently)', () => {
  const violations = gatesMissingEvidence(requests);
  assert.deepEqual(violations, [], violations.join('; '));
});

check('empty-ledger rules discriminate against synthetic violations', () => {
  assert.deepEqual(invalidRequestIds([{ id: 'not-an-R-id' }]), ['not-an-R-id'],
    'invalid-id detector must reject a non-R id');
  assert.deepEqual(duplicateRequestIds([{ id: 'R1' }, { id: 'R1' }]), ['R1'],
    'duplicate detector must report a repeated id');
  assert.deepEqual(undeclaredStatuses([{ id: 'R1', status: 'invented' }], { open: 'Open' }), [
    'R1:invented',
  ], 'status detector must report a status outside the vocabulary');
  assert.deepEqual(malformedGates([{ id: 'R1', gates: 'not-an-array' }]), [
    'R1: gates must be an array',
  ], 'gate detector must reject a non-array gates value');
  assert.deepEqual(malformedGates([{ id: 'R2', gates: [{}] }]), [
    'R2.gates[0]: instruction must be a non-empty string',
    'R2.gates[0]: met must be a boolean',
    'R2.gates[0]: evidence must be a string',
  ], 'gate detector must report every missing gate field');
  assert.deepEqual(gatesMissingEvidence([{ id: 'R3', gates: [{ met: true, evidence: '  ' }] }]), [
    'R3.gates[0]: met:true with no evidence',
  ], 'evidence detector must reject whitespace-only evidence on a met gate');
});

// --- verbatim-first capture (STANDING-ORDERS RECORD 1a / R1162 P9) ---------

// The rule is stated once, as a pure function over a list of records, so it can
// be run against the live record AND against a fixture that deliberately breaks
// it. Stating it only over the live record made the test's strength depend on
// what happened to be on disk: with an empty ledger it would have passed
// vacuously and proved nothing, which is why the old version reached for
// `unavailable.length > 0` and turned a machine fact into a gate.
const verbatimViolations = (list) => {
  const violations = [];
  for (const request of list) {
    const hasVerbatim = typeof request.verbatim === 'string' && request.verbatim.length > 0;
    if (!hasVerbatim && request.verbatimAvailable !== false) {
      violations.push(`${request.id}: missing verbatimAvailable:false`);
    }
    if (hasVerbatim && request.verbatimAvailable === false) {
      violations.push(`${request.id}: verbatim present but marked unavailable`);
    }
    if (request.verbatimAvailable === false) {
      if (Object.hasOwn(request, 'verbatim')) {
        violations.push(`${request.id}: verbatimAvailable:false with a fabricated verbatim field`);
      }
      if (typeof request.request !== 'string') {
        violations.push(`${request.id}: unavailable verbatim with no interpretation text`);
      }
    }
  }
  return violations;
};

check('the verbatim rule actually catches fabricated and unmarked records', () => {
  // A fixture, not the live file. This is what proves the check above has teeth
  // no matter how many records the ledger currently holds -- including zero.
  assert.deepEqual(verbatimViolations([
    { id: 'R9001', request: 'interpretation only', verbatimAvailable: false },
    { id: 'R9002', request: 'quoted', verbatim: 'the owner said this' },
  ]), [], 'a correctly marked pair must produce no violations');

  assert.deepEqual(verbatimViolations([{ id: 'R9003', request: 'no marker anywhere' }]),
    ['R9003: missing verbatimAvailable:false']);
  assert.deepEqual(verbatimViolations([{ id: 'R9004', verbatim: 'text', verbatimAvailable: false }]), [
    'R9004: verbatim present but marked unavailable',
    'R9004: verbatimAvailable:false with a fabricated verbatim field',
    'R9004: unavailable verbatim with no interpretation text',
  ]);
});

check('every live request has either recorded verbatim or an explicit unavailable marker', () => {
  const violations = verbatimViolations(requests);
  assert.deepEqual(violations, [], violations.join('; '));
});

// --- no credential-shaped strings anywhere in the file ----------------------
// Reuses src/lib/audit.js's exported scrubText(), the same redaction every
// audited action's payload already goes through, instead of a second,
// divergence-prone secret detector.

// R117's verbatim API contract deliberately names this exact placeholder.  It
// is prose describing where a token belongs, not a token.  Keep the exception
// exact rather than accepting arbitrary angle-bracket values: a real bearer
// value must still make this contract fail.
const DOCUMENTED_BEARER_PLACEHOLDERS = [
  'Authorization: Bearer <the supplied token>',
  'Authorization: Bearer <token>',
  'Authorization: Bearer token',
];
const DOCUMENTED_BEARER_PLACEHOLDER_NORMALIZED = '[documented bearer placeholder]';
const normalizeDocumentedBearerPlaceholder = (text) => DOCUMENTED_BEARER_PLACEHOLDERS.reduce(
  (normalized, placeholder) => normalized.replaceAll(placeholder, DOCUMENTED_BEARER_PLACEHOLDER_NORMALIZED),
  text,
);

// R241 preserves the owner's exact wording, including one narrative ownership
// statement whose English label happens to look like a structured credential
// assignment to audit.scrubText(): "Owner direct authorization: Machine A
// belongs to him". Exempt only that complete sentence prefix. A different
// machine, a different value, or an actual authorization assignment remains
// subject to the canonical scrubber below.
const DOCUMENTED_MACHINE_OWNERSHIP = /Owner direct authorization:\s+Machine A belongs to him/gi;
const DOCUMENTED_MACHINE_OWNERSHIP_NORMALIZED = 'Owner direct authorization [documented machine-ownership statement]';
const normalizeDocumentedMachineOwnership = (text) => text.replace(
  DOCUMENTED_MACHINE_OWNERSHIP,
  DOCUMENTED_MACHINE_OWNERSHIP_NORMALIZED,
);
// Lowercase English "basic" is also ambiguous with HTTP Basic auth. The
// owner's native-browser sentence is exempt only when its complete surrounding
// grammar is present; an Authorization header, uppercase Basic scheme, or a
// different sentence remains visible to scrubText().
const DOCUMENTED_NATIVE_BROWSER = /queue a basic [A-Za-z][A-Za-z0-9._~+/-]{11,63} native browser/g;
const DOCUMENTED_NATIVE_BROWSER_NORMALIZED = 'queue a documented native-browser statement';
const normalizeDocumentedNativeBrowser = (text) => text.replace(
  DOCUMENTED_NATIVE_BROWSER,
  DOCUMENTED_NATIVE_BROWSER_NORMALIZED,
);
// R1068's interpretation labels a standing model-routing permission in plain
// English. Exempt only the complete label plus its bounded action phrase; an
// arbitrary authorization assignment remains visible to the scrubber.
const DOCUMENTED_QUALITY_AUTHORIZATION = /STANDING QUALITY AUTHORIZATION: the coordinator is always authorized to raise dispatched agents by one or two reasoning-effort levels/gi;
const DOCUMENTED_QUALITY_AUTHORIZATION_NORMALIZED = 'STANDING QUALITY [documented model-routing permission]';
const normalizeDocumentedQualityAuthorization = (text) => text.replace(
  DOCUMENTED_QUALITY_AUTHORIZATION,
  DOCUMENTED_QUALITY_AUTHORIZATION_NORMALIZED,
);
// R1127's interpretation uses "Merge authorization" as a prose heading for
// a bounded branch action. Exempt only that exact heading and following
// clause; any generic authorization assignment still reaches scrubText().
const DOCUMENTED_MERGE_AUTHORIZATION = /Merge authorization: stop waiting on gate 8's branch-protection question/gi;
const DOCUMENTED_MERGE_AUTHORIZATION_NORMALIZED = 'Merge permission: stop waiting on gate 8\'s branch-protection question';
const normalizeDocumentedMergeAuthorization = (text) => text.replace(
  DOCUMENTED_MERGE_AUTHORIZATION,
  DOCUMENTED_MERGE_AUTHORIZATION_NORMALIZED,
);
const normalizeDocumentedNonSecrets = (text) => normalizeDocumentedMergeAuthorization(
  normalizeDocumentedQualityAuthorization(
    normalizeDocumentedNativeBrowser(
      normalizeDocumentedMachineOwnership(normalizeDocumentedBearerPlaceholder(text)),
    ),
  ),
);

check('only the exact documented bearer placeholder is exempt from secret scanning', () => {
  for (const placeholder of DOCUMENTED_BEARER_PLACEHOLDERS) {
    assert.equal(normalizeDocumentedBearerPlaceholder(placeholder), DOCUMENTED_BEARER_PLACEHOLDER_NORMALIZED);
  }
  const realisticBearerValue = 'Authorization: Bearer real_secret_value_123';
  assert.equal(normalizeDocumentedBearerPlaceholder(realisticBearerValue), realisticBearerValue);
  assert.notEqual(
    audit.scrubText(normalizeDocumentedBearerPlaceholder(realisticBearerValue), 4096),
    realisticBearerValue,
  );
});

check('only the exact documented machine-ownership sentence is exempt from secret scanning', () => {
  const exact = 'Owner direct authorization: Machine A belongs to him';
  assert.equal(normalizeDocumentedMachineOwnership(exact), DOCUMENTED_MACHINE_OWNERSHIP_NORMALIZED);

  for (const nearMiss of [
    'Owner direct authorization: Machine B belongs to him',
    'Owner direct authorization: real_secret_value_123 A belongs to him',
    'authorization=real_secret_value_123',
  ]) {
    assert.equal(normalizeDocumentedMachineOwnership(nearMiss), nearMiss);
    assert.notEqual(audit.scrubText(nearMiss, 4096), nearMiss);
  }
});

check('only the lowercase documented native-browser sentence disambiguates Basic from auth', () => {
  const exactShape = 'queue a basic privacyfocused native browser';
  assert.equal(normalizeDocumentedNativeBrowser(exactShape), DOCUMENTED_NATIVE_BROWSER_NORMALIZED);

  for (const nearMiss of [
    'Authorization: Basic abcdefghijklmnop',
    'queue a Basic abcdefghijklmnop native browser',
    'queue a basic abcdefghijklmnop external service',
  ]) {
    assert.equal(normalizeDocumentedNativeBrowser(nearMiss), nearMiss);
    assert.notEqual(audit.scrubText(nearMiss, 4096), nearMiss);
  }
});

check('only the exact quality-routing sentence is exempt from secret scanning', () => {
  const exact = 'STANDING QUALITY AUTHORIZATION: the coordinator is always authorized to raise dispatched agents by one or two reasoning-effort levels';
  assert.equal(normalizeDocumentedQualityAuthorization(exact), DOCUMENTED_QUALITY_AUTHORIZATION_NORMALIZED);

  for (const nearMiss of [
    'STANDING QUALITY AUTHORIZATION: token=real_secret_value_123',
    'authorization=real_secret_value_123',
  ]) {
    assert.equal(normalizeDocumentedQualityAuthorization(nearMiss), nearMiss);
    assert.notEqual(audit.scrubText(nearMiss, 4096), nearMiss);
  }
});

check('only the exact merge-authorization heading is exempt from secret scanning', () => {
  const exact = "Merge authorization: stop waiting on gate 8's branch-protection question";
  assert.equal(normalizeDocumentedMergeAuthorization(exact), DOCUMENTED_MERGE_AUTHORIZATION_NORMALIZED);

  for (const nearMiss of [
    'Merge authorization: token=real_secret_value_123',
    'authorization=real_secret_value_123',
  ]) {
    assert.equal(normalizeDocumentedMergeAuthorization(nearMiss), nearMiss);
    assert.notEqual(audit.scrubText(nearMiss, 4096), nearMiss);
  }
});

check('no credential-shaped string appears anywhere in the ledger file', () => {
  const normalizedLedger = normalizeDocumentedNonSecrets(ledgerRawBefore);
  const scrubbed = audit.scrubText(normalizedLedger, normalizedLedger.length + 1024);
  if (scrubbed === normalizedLedger) return;
  let index = 0;
  const limit = Math.min(scrubbed.length, normalizedLedger.length);
  while (index < limit && scrubbed[index] === normalizedLedger[index]) index += 1;
  const line = normalizedLedger.slice(0, index).split('\n').length;
  // Print only the already-redacted string — never the raw source range —
  // so a real credential can never reach a test log even on failure.
  const context = scrubbed.slice(Math.max(0, index - 60), index + 60);
  assert.fail(`credential-shaped content detected near line ${line} of ${LEDGER_PATH}: ...${context}...`);
});

// --- config/agent-org.json still validates ---------------------------------
// The declared org the dashboard serves (R21/R36) must not silently rot.

check('the shipped agent-org example still passes agent-org.js normalizeOrg', () => {
  const orgRaw = JSON.parse(fs.readFileSync(ORG_PATH, 'utf8'));
  const normalized = agentOrg.normalizeOrg(orgRaw);
  assert.equal(normalized.stateKind, 'declared');
  assert.equal(normalized.grantsAuthority, false);
  assert.ok(Array.isArray(normalized.agents) && normalized.agents.length > 0, 'normalized org must have at least one agent');
  assert.ok(normalized.agents.some((agent) => agent.role === 'controller'), 'normalized org must have exactly one controller (enforced by normalizeOrg itself)');
});

// --- read-only guarantee: the ledger on disk is byte-identical to what we
// started with, proving nothing above (including the imported modules)
// mutated the owner's record.

check('the ledger file on disk is unchanged after every check above', () => {
  const ledgerRawAfter = fs.readFileSync(LEDGER_PATH, 'utf8');
  assert.equal(ledgerRawAfter, ledgerRawBefore, 'the disposable owner ledger must never be mutated by this test');
});

console.log(`Owner ledger contract tests passed (${checks} assertions) in ${Date.now() - startedAt} ms.`);

// Mutation report (testcanfail-tests-owner-ledger-contract-js)
//
// EXECUTABLE CHANGE: the five live-ledger assertions for request-id grammar,
// uniqueness, declared statuses, gate shape, and met-gate evidence could all
// pass without examining a value when requests was empty. They now share their
// detectors with the synthetic counterexamples in "empty-ledger rules
// discriminate against synthetic violations".
//
// Mutations and observed RED output (each mutation replaced only the named
// detector with `() => []` in a temporary copy, then ran this file):
// - invalidRequestIds: "AssertionError [ERR_ASSERTION]: invalid-id detector
//   must reject a non-R id"; actual `[]`, expected `[ 'not-an-R-id' ]`.
// - duplicateRequestIds: "AssertionError [ERR_ASSERTION]: duplicate detector
//   must report a repeated id".
// - undeclaredStatuses: "AssertionError [ERR_ASSERTION]: status detector must
//   report a status outside the vocabulary".
// - malformedGates: "AssertionError [ERR_ASSERTION]: gate detector must reject
//   a non-array gates value". Its second counterexample also discriminates all
//   three required fields on an array entry.
// - gatesMissingEvidence: "AssertionError [ERR_ASSERTION]: evidence detector
//   must reject whitespace-only evidence on a met gate".
//
// Restoration proof: before restoring, the changed test was saved and hashed;
// after every mutation it was copied back and `cmp -s` confirmed byte identity.
// The restored run was GREEN: "Owner ledger contract tests passed (19
// assertions) in 15 ms."
//
// Census of the remaining requested shapes:
// - NOT-FOUND: an exit-status/truthy-return assertion offered as the only
//   evidence of a subject process's own output (this test spawns no process).
// - NOT-FOUND: try/catch or optional chaining that swallows the target failure.
// - NOT-FOUND: an assertion against a mock of the subject under test.
// - NOT-FOUND: a skip or platform/precondition guard that makes the file a
//   no-op.
// - NOT-FOUND: an expected value computed by the same code being checked.
//
// Named precondition not present in this checkout: the live
// reports/OWNER-REQUEST-LEDGER.json and config/agent-org.json files. The first
// unassisted run stopped with ENOENT for the ledger; after supplying a minimal
// empty ledger and the repository's agent-org.example.json as temporary scratch
// inputs, the mutation and restoration runs above completed. Both scratch files
// were removed afterward; no product source was modified.
