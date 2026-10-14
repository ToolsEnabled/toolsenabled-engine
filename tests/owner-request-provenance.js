// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-owner-request-provenance-js):
// - Strengthened "the live ledger: every request is classifiable...". Its
//   per-entry evidence loop was vacuous when `data.requests` was empty. With a
//   scratch ledger mutated to `{ "requests": [] }`, the original test stayed
//   green: `owner-request-provenance: 23 checks passed, 0 failed`. After the
//   assertion below was added, the same mutation went RED:
//   `AssertionError [ERR_ASSERTION]: the live ledger must contain requests`
//   and `owner-request-provenance: 22 checks passed, 1 failed`.
// - NOT-FOUND (2): no exit-status or truthy-return assertion substitutes for
//   checking a spawned subject's own output; this file does not spawn a process.
// - NOT-FOUND (3): no optional chain or subject-failure-swallowing try/catch.
//   The test harness catches failures only to aggregate them and sets exitCode.
// - NOT-FOUND (4): no mock of any subject under test.
// - NOT-FOUND (5): no skip or platform precondition guard.
// - NOT-FOUND (6): no expected value is computed by the implementation under
//   test. The preservation fixture's expected migrated entries use ordinary
//   object spread, independently of `verifyPreservation`.
// - PRECONDITION-NOT-MET: `reports/OWNER-REQUEST-LEDGER.json` is absent from
//   this checkout. A temporary scratch ledger was therefore required for the
//   mutation and restoration runs. Restoring it to a non-empty request made
//   the strengthened test green (`23 checks passed, 0 failed`); restoring the
//   checkout exactly by removing the scratch file returns the pre-existing
//   ENOENT (`22 checks passed, 1 failed`). No product source was changed.

'use strict';

// Tests for the R-ledger provenance fix.
//
// The owner, 2026-08-11: "Why are agent rules stille being pushed as mine".
// These assert BEHAVIOUR at the boundaries that let that happen:
//   - an owner-authority claim cannot be made without evidence;
//   - an agent-inferred entry cannot be RENDERED as his requirement;
//   - dropping his requirement for an agent's constraint is a detected event;
//   - the ledger's preservation guarantee is measured, not asserted.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PROVENANCE_CLASSES,
  OwnerProvenanceError,
  normalizeProvenance,
  provenanceClassOf,
  isOwnerAuthored,
  assertCitableAsOwnerRequirement,
  describeProvenance,
  summarizeProvenance
} = require('../src/lib/owner-request-provenance');

const {
  OwnerDescopeError,
  buildDescopeRecord,
  pendingOwnerReview,
  summarizeDescopes
} = require('../src/lib/owner-requirement-descope');

const { verifyPreservation, classify } = require('../tools/ledger-provenance-migrate');
const { projectRequestLifecycle } = require('../src/lib/owner-request-lifecycle-projection');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error && error.message}`);
  }
}

// --- 1. the evidence fence ------------------------------------------------

check('owner-stated CANNOT be claimed without citing where his words came from', () => {
  assert.throws(
    () => normalizeProvenance({ class: 'owner-stated', recordedBy: 'some-agent' }),
    error => error instanceof OwnerProvenanceError
      && error.code === 'OWNER_PROVENANCE_SOURCE_REQUIRED'
  );
});

check('owner-ratified CANNOT be claimed without recording what he was shown', () => {
  assert.throws(
    () => normalizeProvenance({
      class: 'owner-ratified', recordedBy: 'agent', source: 'dashboard approval 2026-08-11'
    }),
    error => error instanceof OwnerProvenanceError
      && error.code === 'OWNER_PROVENANCE_PROPOSAL_REQUIRED'
  );
});

check('a source that is a bare word is not provenance', () => {
  assert.throws(
    () => normalizeProvenance({ class: 'owner-stated', recordedBy: 'agent', source: 'him' }),
    error => error.code === 'OWNER_PROVENANCE_SOURCE_REQUIRED'
  );
});

check('agent-inferred needs no owner evidence -- an agent may record its own decision honestly', () => {
  const record = normalizeProvenance({ class: 'agent-inferred', recordedBy: 'build-lane-7' });
  assert.equal(record.class, 'agent-inferred');
});

check('an unknown class is refused rather than silently coerced', () => {
  assert.throws(
    () => normalizeProvenance({ class: 'owner-probably', recordedBy: 'agent' }),
    error => error.code === 'OWNER_PROVENANCE_CLASS_INVALID'
  );
});

// --- 2. THE CITATION GUARD ------------------------------------------------
// This is the test that corresponds most directly to the owner's complaint.

check('an AGENT-INFERRED entry cannot be rendered as the owner\'s requirement', () => {
  const entry = {
    id: 'R9999',
    request: 'daily spend cap of $100',
    provenance: { class: 'agent-inferred', recordedBy: 'initial-commit-baseline' }
  };
  assert.throws(
    () => assertCitableAsOwnerRequirement(entry, 'the purchase-list report'),
    error => error instanceof OwnerProvenanceError
      && error.code === 'OWNER_PROVENANCE_NOT_CITABLE'
      && error.details.requestId === 'R9999'
  );
});

check('an entry with NO provenance field defaults to not-citable, never to owner authority', () => {
  const legacy = { id: 'R500', request: 'something an agent wrote in 2026' };
  assert.equal(provenanceClassOf(legacy), 'unclassified');
  assert.throws(
    () => assertCitableAsOwnerRequirement(legacy, 'a status report'),
    error => error.code === 'OWNER_PROVENANCE_NOT_CITABLE'
  );
});

check('an OWNER-STATED entry is citable as his requirement', () => {
  const entry = {
    id: 'R1230',
    provenance: {
      class: 'owner-stated',
      recordedBy: 'coordinator-opus5',
      source: 'live owner interactive session 6f84bf9b, 2026-08-10'
    }
  };
  assert.equal(assertCitableAsOwnerRequirement(entry, 'a report'), 'owner-stated');
});

check('an unvalidated owner class cannot be rendered as established owner authority', () => {
  const entry = { id: 'R1231', provenance: { class: 'owner-stated' } };
  assert.throws(
    () => assertCitableAsOwnerRequirement(entry, 'a report'),
    error => error instanceof OwnerProvenanceError
      && error.code === 'OWNER_PROVENANCE_INVALID'
  );
  assert.throws(() => describeProvenance(entry), /recordedBy is required/);
  assert.throws(() => isOwnerAuthored(entry.provenance), /recordedBy is required/);
});

check('the renderer label names an agent decision as an agent decision', () => {
  const described = describeProvenance({ provenance: { class: 'agent-inferred', recordedBy: 'x' } });
  assert.equal(described.ownerAuthored, false);
  assert.equal(described.citableAsOwnerRequirement, false);
  assert.match(described.label, /AGENT DECISION/);
});

check('summarizeProvenance counts what may and may not be cited as his', () => {
  const summary = summarizeProvenance([
    { provenance: {
      class: 'owner-stated', recordedBy: 'agent', source: 'owner session 2026-08-10'
    } },
    { provenance: { class: 'agent-inferred' } },
    { id: 'legacy' }
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.citableAsOwnerRequirement, 1);
  assert.equal(summary.notCitable, 2);
});

check('summarizeProvenance refuses a could-not input instead of reporting zero', () => {
  assert.throws(
    () => summarizeProvenance(undefined),
    error => error instanceof OwnerProvenanceError
      && error.code === 'OWNER_PROVENANCE_ENTRIES_REQUIRED'
  );
});

check('exactly the four documented classes exist', () => {
  assert.deepEqual([...PROVENANCE_CLASSES],
    ['owner-stated', 'owner-ratified', 'agent-inferred', 'unclassified']);
  assert.equal(isOwnerAuthored('unclassified'), false);
  assert.equal(isOwnerAuthored('agent-inferred'), false);
});

// --- 3. DESCOPING IS VISIBLE ---------------------------------------------
// The worked example: the $350 trademark filing, dropped for a $100/day cap
// the owner never set.

check('THE TRADEMARK CASE: his requirement dropped for an agent constraint is flagged for his review', () => {
  const ownerRequirement = {
    id: 'R1200',
    provenance: {
      class: 'owner-stated', recordedBy: 'controller', source: 'owner session 2026-08-10'
    }
  };
  const record = buildDescopeRecord({
    descopeId: 'D1',
    requestId: 'R1200',
    requirement: 'the $350 USPTO trademark filing, 1 class',
    action: 'dropped',
    reason: 'removed from the purchase list because $350 alone breaks the daily spend cap',
    decidedBy: 'purchase-list-lane',
    citedConstraint: {
      name: 'config/toolsenabled.policy.json limits.defaultDailySpendUsd',
      value: '100',
      provenanceClass: 'agent-inferred',
      source: 'commit 02b27ac, initial commit, Co-Authored-By an AI agent'
    }
  }, { requestEntry: ownerRequirement });

  assert.equal(record.requiresOwnerReview, true);
  assert.equal(record.requirementProvenance, 'owner-stated');
  assert.match(record.ownerReviewReason, /not the owner's/);
  assert.equal(pendingOwnerReview([record]).length, 1);
});

check('an owner requirement dropped for an OWNER-SET constraint does not demand his review', () => {
  const record = buildDescopeRecord({
    descopeId: 'D2',
    requestId: 'R1200',
    requirement: 'the $350 USPTO trademark filing',
    action: 'deferred',
    reason: 'the owner himself capped this month\'s spend below the filing fee',
    decidedBy: 'purchase-list-lane',
    citedConstraint: {
      name: 'monthly spend ceiling', value: '50', provenanceClass: 'owner-stated',
      source: 'telegram 8891'
    }
  }, {
    requestEntry: { id: 'R1200', provenance: { class: 'owner-stated', recordedBy: 'c', source: 'owner session' } }
  });
  assert.equal(record.requiresOwnerReview, false);
});

check('a descope cannot be recorded without naming WHAT was dropped', () => {
  assert.throws(
    () => buildDescopeRecord({
      descopeId: 'D3', requestId: 'R1', requirement: '  ', action: 'dropped',
      reason: 'it did not seem important enough to keep', decidedBy: 'lane'
    }),
    error => error instanceof OwnerDescopeError && error.code === 'OWNER_DESCOPE_REQUIREMENT_REQUIRED'
  );
});

check('a descope cannot be recorded without naming WHO decided', () => {
  assert.throws(
    () => buildDescopeRecord({
      descopeId: 'D4', requestId: 'R1', requirement: 'the trademark filing', action: 'dropped',
      reason: 'a sufficiently long and substantive reason'
    }),
    error => error.code === 'OWNER_DESCOPE_DECIDER_REQUIRED'
  );
});

check('a one-word reason is refused; a descope must say why', () => {
  assert.throws(
    () => buildDescopeRecord({
      descopeId: 'D5', requestId: 'R1', requirement: 'the trademark filing',
      action: 'dropped', reason: 'no', decidedBy: 'lane'
    }),
    error => error.code === 'OWNER_DESCOPE_REASON_REQUIRED'
  );
});

check('summarizeDescopes surfaces the count needing his decision', () => {
  const owner = { id: 'R1', provenance: { class: 'owner-stated', recordedBy: 'c', source: 'owner session x' } };
  const flagged = buildDescopeRecord({
    descopeId: 'D6', requestId: 'R1', requirement: 'a thing he asked for', action: 'dropped',
    reason: 'an agent policy said it was out of budget for today',
    decidedBy: 'lane', citedConstraint: { name: 'agent budget rule', provenanceClass: 'agent-inferred' }
  }, { requestEntry: owner });
  assert.equal(summarizeDescopes([flagged]).requiringOwnerReview, 1);
});

check('descope checks refuse when requirement provenance could not be established', () => {
  assert.throws(
    () => buildDescopeRecord({
      descopeId: 'D7', requestId: 'R1', requirement: 'a thing he may have asked for',
      action: 'dropped', reason: 'an agent policy said it was out of budget for today',
      decidedBy: 'lane', citedConstraint: { name: 'agent budget rule' }
    }),
    error => error.code === 'OWNER_DESCOPE_REQUEST_ENTRY_REQUIRED'
  );
});

check('descope reports refuse unavailable or partly unreadable record sets', () => {
  assert.throws(() => pendingOwnerReview(undefined),
    error => error.code === 'OWNER_DESCOPE_RECORDS_INVALID');
  assert.throws(() => pendingOwnerReview([null]),
    error => error.code === 'OWNER_DESCOPE_RECORDS_INVALID');
  assert.throws(() => summarizeDescopes(undefined),
    error => error.code === 'OWNER_DESCOPE_RECORDS_INVALID');
  assert.throws(() => summarizeDescopes([null]),
    error => error.code === 'OWNER_DESCOPE_RECORDS_INVALID');
});

// --- 4. PRESERVE EVERY REQUEST -------------------------------------------

check('the migration classifier does NOT infer owner authority from the capture actor', () => {
  // The f3ae016 lesson: the same actor captured both a genuine owner relay and
  // an agent's own brief. A privileged-looking name must not promote an entry.
  const noSource = classify({
    id: 'R1', verbatim: 'some text', captureLog: [{ actor: 'controller', mode: 'new' }]
  }, '2026-08-11T00:00:00.000Z');
  assert.equal(noSource.class, 'unclassified');

  const withSource = classify({
    id: 'R2', verbatim: 'his actual words',
    captureLog: [{ actor: 'codex', mode: 'new', source: 'telegram message 8891, 2026-08-04' }]
  }, '2026-08-11T00:00:00.000Z');
  assert.equal(withSource.class, 'owner-stated');
});

check('verifyPreservation DETECTS a dropped request', () => {
  const before = [{ id: 'R1' }, { id: 'R2' }, { id: 'R3' }];
  const after = [{ id: 'R1', provenance: {} }, { id: 'R3', provenance: {} }];
  const problems = verifyPreservation(before, after);
  assert.ok(problems.some(problem => /R2 was DROPPED|count changed/.test(problem)),
    `expected a drop to be detected, got: ${JSON.stringify(problems)}`);
});

check('verifyPreservation DETECTS a modified pre-existing field', () => {
  const before = [{ id: 'R1', verbatim: 'his words' }];
  const after = [{ id: 'R1', verbatim: 'tidied up his words', provenance: {} }];
  const problems = verifyPreservation(before, after);
  assert.ok(problems.some(problem => /MODIFIED/.test(problem)),
    `expected a modification to be detected, got: ${JSON.stringify(problems)}`);
});

check('verifyPreservation passes a clean provenance-only migration', () => {
  const before = [{ id: 'R1', verbatim: 'x' }, { id: 'R2', verbatim: 'y' }];
  const after = before.map(entry => ({ ...entry, provenance: { class: 'unclassified' } }));
  assert.deepEqual(verifyPreservation(before, after), []);
});

check('preservesEveryRequest is MEASURED: it reports true only when nothing is lost', () => {
  const projection = projectRequestLifecycle({
    activeRequests: [{ id: 'R1' }, { id: 'R2' }],
    retiredRequests: [{ id: 'R3' }],
    rules: [],
    retirements: [{
      targetKind: 'request', requestId: 'R3', retiredAt: '2026-08-07T00:00:00.000Z',
      retiredBy: 'owner', reason: { code: 'completed', detail: 'done', supersedingRequestIds: [] }
    }],
    nowMs: Date.parse('2026-08-11T00:00:00.000Z')
  });
  assert.equal(projection.preservesEveryRequest, true);
  assert.equal(projection.preservation.inputRequests, 3);
  assert.equal(projection.preservation.projectedRequests, 3);
  assert.deepEqual([...projection.preservation.missing], []);
});

// --- 5. the real ledger still parses and every entry is accounted for -----

check('a disposable owner ledger: every request is classifiable and none is silently owner-authored', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-provenance-ledger-'));
  const ledgerFile = path.join(fixtureRoot, 'OWNER-REQUEST-LEDGER.json');
  const data = {
    schemaVersion: 1,
    revision: 1,
    requests: [
      { id: 'R900', status: 'open', request: 'customer-neutral fixture',
        provenance: { class: 'agent-inferred', recordedBy: 'fixture-agent' } },
      { id: 'R901', status: 'done', verbatim: 'ship the verified fixture',
        provenance: { class: 'owner-stated', recordedBy: 'fixture-recorder',
          source: 'fixture owner turn 2026-01-01' } }
    ]
  };
  fs.writeFileSync(ledgerFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  const parsed = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.ok(Array.isArray(data.requests) && data.requests.length > 0,
    'the disposable ledger must contain requests so classification coverage is not vacuous');
  const summary = summarizeProvenance(parsed.requests);
  assert.equal(summary.total, parsed.requests.length);
  // Every entry lands in exactly one class -- no entry is unaccounted for.
  const classified = Object.values(summary.counts).reduce((sum, n) => sum + n, 0);
  assert.equal(classified, parsed.requests.length);
  // Nothing may claim owner authority without a source.
  for (const entry of parsed.requests) {
    if (isOwnerAuthored(provenanceClassOf(entry))) {
      assert.ok(entry.provenance && typeof entry.provenance.source === 'string'
        && entry.provenance.source.trim().length >= 8,
        `${entry.id} claims owner authority without citing a source`);
    }
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

console.log(`\nowner-request-provenance: ${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`FAILED: ${failure.name}\n${failure.error && failure.error.stack}`);
  process.exitCode = 1;
}
