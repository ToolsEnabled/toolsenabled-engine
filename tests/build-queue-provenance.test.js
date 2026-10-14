// EXECUTABLE CHANGE
// testcanfail-tests-build-queue-provenance-test-js
//
// DISCRIMINATING MUTATION REPORT
// Suspect: the live-corpus `for (const rid of result.phantomRids)` assertion
// was vacuous whenever `phantomRids` was empty. Mutation: in a temporary edit
// of src/lib/build-queue-provenance.js, return `phantomRids: []` while retaining
// PHANTOM_RID findings. The strengthened summary assertion went RED:
//   FAIL the phantom-id summary cannot omit phantom findings: AssertionError
//   [ERR_ASSERTION]: phantomRids must exactly summarize the phantom findings
//   at assertPhantomSummary
// After restoring the source byte-for-byte, that focused check was GREEN:
//   ok  the phantom-id summary cannot omit phantom findings
// The complete file cannot currently finish green because this checkout lacks
// BUILD-QUEUE.md and reports/OWNER-REQUEST-LEDGER.json; the named precondition
// failure is quoted below under the live-corpus check.
//
// NOT-FOUND (1, elsewhere): all other collection assertions use fixed,
// non-empty literals or first assert their cardinality/content.
// NOT-FOUND (2): no exit-status or truthy process-return assertion exists.
// NOT-FOUND (3): `check` records caught failures and the footer makes them set
// a failing exit code; no optional chain swallows a subject failure.
// NOT-FOUND (4): the provenance module under test is not mocked.
// NOT-FOUND (5): there is no skip or platform precondition guard. The live
// check instead fails explicitly when its required repository data is absent:
//   FAIL the live BUILD-QUEUE corpus parses and the tool is honest about it:
//   Error: Could not read the queue corpus at /workspace/engine/BUILD-QUEUE.md:
//   The root queue could not be read.
// NOT-FOUND (6): expectations are literal contract values or independently
// derived cross-field invariants, not computed by the subject implementation.

'use strict';

require('./helpers/isolated-state-root'); // FINDING 1, REPORT-ledger-kinds-tools-20260907.md: redirect TOOLSENABLED_STATE_ROOT off the live root before anything below can resolve it.

// A queue item may not assert authority that does not exist. The writer checks
// citation shape; these tests independently check that each referent exists in
// the supplied ledger and that actionable ledger entries reach the queue.
//
// THE ABSENCE CASE IS TESTED FIRST-CLASS. This codebase's signature defect is
// absence-read-as-consent. A checker that answered "clean" because the ledger
// was missing, empty, or id-less would be the same bug in a new place, so each
// of those must raise rather than pass.

const assert = require('node:assert');

const provenance = require('../src/lib/build-queue-provenance');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`  FAIL ${name}: ${error.stack || error.message}`); }
}

function ledgerOf(requests, extra = {}) {
  return { schemaVersion: 4, revision: 1, requests, ...extra };
}
const LEDGER = ledgerOf([
  { id: 'R100', status: 'open' },
  { id: 'R101', status: 'done' },
  { id: 'R102', status: 'open' },
  { id: 'R103', status: 'in-progress' }
]);

function phase({ id = 'Q1', title = 'Thing', status = 'OPEN', authority = null, body = '' } = {}) {
  const lines = [`## ${id} — ${title}`, '', `**Status:** ${status}`, ''];
  if (authority) lines.push(`**Authority:** ${authority}`, '');
  if (body) lines.push(body, '');
  return lines.join('\n');
}
function audit(markdown, ledger = LEDGER) {
  return provenance.auditQueueProvenance({ sources: [{ file: 'BUILD-QUEUE.md', markdown }], ledger });
}
function codes(result) { return result.findings.map(f => f.code); }
function assertPhantomSummary(result) {
  const findingRids = [...new Set(result.findings
    .filter(f => f.code === 'PHANTOM_RID' || f.code === 'PHANTOM_DECISION_DOC')
    .map(f => f.rid))];
  assert.deepEqual(result.phantomRids, findingRids,
    'phantomRids must exactly summarize the phantom findings');
}
// The error CODE is the contract callers branch on; the message is prose that
// may be reworded. Assert on the code.
function throwsCode(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error.name, 'BuildQueueProvenanceError', `expected a BuildQueueProvenanceError, got ${error.name}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}`);
    return true;
  });
}

// ---------------------------------------------------------------- the defect

check('a phase citing an R-id absent from the ledger is an error', () => {
  const result = audit(phase({ id: 'Q10', title: 'Shipment (owner request R104)' }));
  assert.deepEqual(result.phantomRids, ['R104']);
  assert.equal(result.errorCount, 1);
  assert.equal(result.clean, false);
  assert.equal(codes(result)[0], 'PHANTOM_RID');
});

check('a phase citing a real R-id is clean', () => {
  const result = audit(phase({ id: 'Q11', title: 'Fused plane (owner request R100)' }));
  assert.deepEqual(result.phantomRids, []);
  assert.equal(result.errorCount, 0);
  assert.equal(result.clean, true);
});

check('known ids resolve while absent synthetic ids do not', () => {
  const good = audit(phase({ title: 'x (owner request R102)' }));
  assert.equal(good.errorCount, 0);
  for (const rid of ['R104', 'R105']) {
    const bad = audit(phase({ title: `x (owner request ${rid})` }));
    assert.deepEqual(bad.phantomRids, [rid], `${rid} must not resolve`);
  }
});

check('a decision document whose FILENAME asserts a phantom R-id is an error', () => {
  const result = audit(phase({
    id: 'Q10',
    title: 'Shipment programme',
    body: 'RELATED: `docs/design/SYNTHETIC-DECISION-R104.md`.'
  }));
  assert.equal(result.errorCount, 1);
  assert.equal(codes(result)[0], 'PHANTOM_DECISION_DOC');
  assert.equal(result.findings[0].doc, 'SYNTHETIC-DECISION-R104.md');
  assert.deepEqual(result.phantomRids, ['R104']);
});

check('a decision document naming a real R-id is accepted', () => {
  const result = audit(phase({ body: 'See `docs/design/SYNTHETIC-DECISION-R102.md`.' }));
  assert.equal(result.errorCount, 0);
});

check('the phantom-id summary cannot omit phantom findings', () => {
  const result = audit([
    phase({ id: 'Q10', title: 'x (owner request R104)' }),
    phase({ id: 'Q11', title: 'x (owner request R105)' })
  ].join('\n'));
  assertPhantomSummary(result);
});

// ------------------------------------------------- no provenance whatsoever

check('a pending phase claiming owner authority with no R-id is an error', () => {
  const result = audit(phase({ id: 'Q12', title: 'A second project interface (owner request)' }));
  assert.equal(codes(result)[0], 'UNVERIFIABLE_OWNER_CLAIM');
  assert.equal(result.errorCount, 1);
});

check('a pending phase with no provenance of any kind is reported', () => {
  const result = audit(phase({ id: 'Q7', title: 'Freshness automation', status: 'BLOCKED' }));
  assert.deepEqual(codes(result), ['NO_PROVENANCE']);
  assert.equal(result.warnCount, 1);
});

check('a DONE phase with no provenance is history, not a finding', () => {
  const result = audit(phase({ id: 'Q9', title: 'Measure the savings', status: 'DONE' }));
  assert.deepEqual(result.findings, []);
  assert.equal(result.clean, true);
});

// ------------------------------------------------------- the reverse link

check('an unfinished ledger directive that no phase names is reported', () => {
  const result = audit(phase({ title: 'x (owner request R100)' }));
  const orphans = result.orphanDirectives.map(o => o.rid);
  assert.ok(orphans.includes('R102'), 'R102 is open and uncited');
  assert.ok(orphans.includes('R103'), 'R103 is in-progress and uncited');
  assert.ok(!orphans.includes('R100'), 'R100 is cited by the phase');
  assert.ok(!orphans.includes('R101'), 'R101 is done, so it is not owed a queue phase');
  assert.equal(result.orphanDirectiveCount, 2);
});

check('citing a directive anywhere in the corpus clears it as an orphan', () => {
  const result = audit([
    phase({ id: 'Q1', title: 'a (owner request R100)' }),
    phase({ id: 'Q2', title: 'b (owner request R102)' }),
    phase({ id: 'Q3', title: 'c (owner request R103)' })
  ].join('\n'));
  assert.equal(result.orphanDirectiveCount, 0);
});

// -------------------------------------------------- no crying wolf on prose

check('illustrative R-ids in phase BODY prose are not citations', () => {
  // Version-like and tier-like R tokens in body prose are not citations.
  const result = audit(phase({
    id: 'Q13',
    title: 'Lifecycle and versioning (owner request R100)',
    body: 'A version chain: `R40` supersede-> `R40.1`, and a merge produces `R40.2.3`.\nDeep-research tiers R0, R1, R2, R3 and R6 are unrelated labels.'
  }));
  assert.equal(result.errorCount, 0, 'design prose must not be read as authority');
  assert.equal(result.clean, true);
});

check('a multi-line Authority block is read whole', () => {
  const markdown = [
    '## Q11 — Fused management plane',
    '',
    '**Status:** BLOCKED',
    '',
    '**Authority:** Owner, quoted verbatim from the active session, read',
    'together with R100 and a later appendix.',
    '',
    '**Latest delta:** unrelated text mentioning R9999.',
    ''
  ].join('\n');
  const result = audit(markdown);
  assert.equal(result.errorCount, 0, 'R100 on the Authority continuation line must count');
  const q = provenance.parsePhases(markdown, 'BUILD-QUEUE.md')[0];
  assert.ok(q.rids.includes('R100'));
  assert.ok(!q.rids.includes('R9999'), 'the block ends at the next bolded field');
});

// ------------------------------------------------------- THE ABSENCE CASES

check('ABSENCE: a ledger with no requests array raises, never reports clean', () => {
  throwsCode(() => audit(phase({ title: 'x (owner request R104)' }), { revision: 1 }),
    'QUEUE_PROVENANCE_LEDGER_INVALID');
});

check('ABSENCE: an EMPTY ledger raises rather than calling every citation phantom', () => {
  // An empty ledger is confidently wrong in both directions at once: every
  // citation looks fake and every directive looks satisfied.
  throwsCode(() => audit(phase({ title: 'x (owner request R100)' }), ledgerOf([])),
    'QUEUE_PROVENANCE_LEDGER_EMPTY');
});

check('ABSENCE: a ledger whose entries carry no ids raises', () => {
  throwsCode(() => audit(phase({ title: 'x (owner request R100)' }), ledgerOf([{ status: 'open' }, { status: 'done' }])),
    'QUEUE_PROVENANCE_LEDGER_ENTRY_INVALID');
});

check('ABSENCE: one malformed ledger entry refuses instead of being dropped from definite counts', () => {
  // A valid id with no status is tested separately; an explicitly empty status
  // remains malformed.
  for (const malformed of [null, {}, { id: '' }, { id: '', status: 'open' }, { id: 'R106', status: '' }]) {
    throwsCode(() => audit(phase({ title: 'x (owner request R100)' }), ledgerOf([
      { id: 'R100', status: 'open' },
      malformed
    ])), 'QUEUE_PROVENANCE_LEDGER_ENTRY_INVALID');
  }
});

check('a real id with NO status is a valid non-actionable entry, not a malformed one', () => {
  // A real id with no status resolves but is not counted actionable.
  const result = audit(phase({ title: 'x (owner request R106)' }), ledgerOf([
    { id: 'R100', status: 'open' },
    { id: 'R106' }
  ]));
  assert.equal(result.errorCount, 0, 'a status-less real id must resolve, never read as phantom');
  assert.ok(!result.phantomRids.includes('R106'));
});

check('ABSENCE: null and non-object ledgers raise', () => {
  // Called through auditQueueProvenance directly: routing `undefined` via the
  // helper would silently pick up its default ledger, which is the same
  // absence-becomes-a-value mistake these checks exist to catch.
  const sources = [{ file: 'BUILD-QUEUE.md', markdown: phase({ title: 'x (owner request R100)' }) }];
  for (const bad of [null, undefined, 'R100', 42, [], true]) {
    throwsCode(() => provenance.auditQueueProvenance({ sources, ledger: bad }), 'QUEUE_PROVENANCE_LEDGER_INVALID');
  }
  // ...and with the ledger key absent from the options object entirely.
  throwsCode(() => provenance.auditQueueProvenance({ sources }), 'QUEUE_PROVENANCE_LEDGER_INVALID');
});

check('ABSENCE: an empty queue source set raises rather than passing vacuously', () => {
  throwsCode(() => provenance.auditQueueProvenance({ sources: [], ledger: LEDGER }),
    'QUEUE_PROVENANCE_SOURCES_INVALID');
});

check('ABSENCE: a queue with no phases refuses rather than returning a zero-scan clean report', () => {
  throwsCode(() => audit('# BUILD-QUEUE\n\nProtocol prose only.\n'), 'QUEUE_PROVENANCE_PHASES_EMPTY');
});

check('ABSENCE: malformed CLI filters refuse instead of hiding or miscounting findings', () => {
  const cli = require('../tools/build-queue-provenance.js');
  for (const argv of [['--since', 'not-an-rid'], ['--since', 'R100garbage'], ['--limit', 'many'], ['--limit', '-1']]) {
    assert.throws(() => cli.main(argv), error => error instanceof cli.CliError && error.exitCode === 2,
      `${argv.join(' ')} must refuse as usage, not produce a definite report`);
  }
});

// --------------------------------------------- the ledger now carries T/A/P too

check('an open T (task) or P (purchase) record produces no phantom finding, no orphan finding, and does not satisfy an R citation', () => {
  const result = audit(phase({ title: 'x (owner request R100)' }), ledgerOf([
    { id: 'R100', status: 'open' },
    { id: 'T1', kind: 'T', status: 'open' },
    { id: 'P1', kind: 'P', status: 'proposed' }
  ]));
  assert.equal(result.errorCount, 0);
  assert.deepEqual(result.orphanDirectives.map(o => o.rid), [],
    'an open T/P record is not a directive any queue phase could structurally cite; it must never be reported queued nowhere');
  assert.equal(result.actionableDirectiveCount, 1, 'T1 and P1 are not R directives and must not inflate this count');
});

check('a phase citing an R-shaped token is not satisfied by a T/A/P record sharing the same number', () => {
  // RID_TOKEN only ever matches R\d{2,}, so a T1 record in the ledger must
  // not silently satisfy an R1 citation.
  const result = audit(phase({ title: 'x (owner request R10)' }), ledgerOf([
    { id: 'R100', status: 'open' },
    { id: 'T10', kind: 'T', status: 'open' }
  ]));
  assert.deepEqual(result.phantomRids, ['R10'], 'R10 must be phantom: only a T10 record exists, not an R10 one');
});

check('indexLedger, auditQueueProvenance and assertAuthorityResolves all treat an open T and an open P record the same way: invisible to citation resolution, never a phantom, never an orphan, never a resolved authority', () => {
  const mixedLedger = ledgerOf([
    { id: 'R100', status: 'open' },
    { id: 'T1', kind: 'T', status: 'open' },
    { id: 'P1', kind: 'P', status: 'proposed' }
  ]);

  // 1. indexLedger directly.
  const index = provenance.indexLedger(mixedLedger, { source: 'fixture' });
  assert.equal(index.ids.has('R100'), true, 'R100 is indexed');
  assert.equal(index.ids.has('T1'), false, 'T1 must never enter the R-referent id set');
  assert.equal(index.ids.has('P1'), false, 'P1 must never enter the R-referent id set');
  assert.deepEqual(index.actionable.map(a => a.id), ['R100'], 'only R100 is an actionable directive');

  // 2. auditQueueProvenance: no phantom finding, no orphan finding, for T1/P1.
  const result = audit(phase({ title: 'x (owner request R100)' }), mixedLedger);
  assert.equal(result.errorCount, 0);
  assert.deepEqual(result.orphanDirectives, [], 'T1 (open) and P1 (proposed) are not queue-citable directives and must never be reported queued nowhere');

  // 3. assertAuthorityResolves: an R100 citation still resolves with T1/P1 present,
  // and a genuinely phantom R-id is still refused -- T1/P1 change neither answer.
  assert.deepEqual(provenance.assertAuthorityResolves('Owner R100 (directiveId: d-1)', mixedLedger), ['R100']);
  throwsCode(() => provenance.assertAuthorityResolves('Owner R999 (directiveId: d-1)', mixedLedger), 'QUEUE_PROVENANCE_AUTHORITY_PHANTOM');
});

check('ABSENCE: a ledger holding only T/A/P records raises QUEUE_PROVENANCE_LEDGER_EMPTY rather than reporting clean', () => {
  throwsCode(() => audit(phase({ title: 'x (owner request R100)' }), ledgerOf([
    { id: 'T1', kind: 'T', status: 'open' },
    { id: 'A1', kind: 'A', status: 'open' }
  ])), 'QUEUE_PROVENANCE_LEDGER_EMPTY');
});

// ------------------------------------------------- the writer-side assertion

check('assertAuthorityResolves refuses a phantom id', () => {
  throwsCode(
    () => provenance.assertAuthorityResolves('Owner R104 (directiveId: d-1)', LEDGER),
    'QUEUE_PROVENANCE_AUTHORITY_PHANTOM'
  );
});

check('assertAuthorityResolves accepts a real id and returns it', () => {
  assert.deepEqual(provenance.assertAuthorityResolves('Owner R100 (directiveId: d-1)', LEDGER), ['R100']);
});

check('assertAuthorityResolves refuses an authority citing no id at all', () => {
  throwsCode(
    () => provenance.assertAuthorityResolves('Owner request in the active session', LEDGER),
    'QUEUE_PROVENANCE_AUTHORITY_UNCITED'
  );
});

check('assertAuthorityResolves refuses empty authority', () => {
  for (const bad of ['', '   ', null, undefined, 7]) {
    throwsCode(() => provenance.assertAuthorityResolves(bad, LEDGER), 'QUEUE_PROVENANCE_AUTHORITY_INVALID');
  }
});

// -------------------------------------------------------- the live machine
//
// The live-corpus check moved to tests/build-queue-provenance-live.test.js so
// its per-installation input (the untracked BUILD-QUEUE.md corpus) can refuse
// with a NAMED NON-ZERO SKIP on checkouts that lack it, without taking these
// unit checks down with it. test:finished-queue runs both files.

console.log(`\nbuild-queue-provenance: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`FAILED: ${failures.join(', ')}`);
  process.exitCode = 1;
}
