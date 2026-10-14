// EXECUTABLE CHANGE
'use strict';

// TEST-CAN-FAIL REPORT (2026-08-26)
// Strengthened assertion: "the archive plan only ever mints codes the mission
// bridge will accept" now reads the production validator's literal allowlist
// instead of asserting against a test-owned copy. Mutation: removed `completed` from the
// validator allowlist in src/lib/mission-bridge/actions.js. RED (exit 1):
//   AssertionError [ERR_ASSERTION]: the planner offered "completed", which
//   src/lib/mission-bridge/actions.js would refuse as unknown
// Restored that source byte-for-byte; the run ended GREEN:
//   ledger-cold-storage-boot-lists: 15 checks passed
// NOT-FOUND: an unguarded empty loop/forEach; exit-status/truthy-return-only
// evidence; swallowed failures via try/catch or optional chaining; assertions
// against a mock of their subject; whole-file skip/precondition guards; expected
// values computed by the same product code they check.
// Preconditions: Node 20 cannot load the whole mission bridge because this
// checkout's state store requires node:sqlite, so the check reads only the
// validator expression without importing or executing that unrelated store.

// DOES A RETIREMENT ACTUALLY REMOVE ANYTHING FROM WHAT AGENTS READ AT BOOT?
//
// WHY THIS EXISTS (2026-08-12). Cold storage was reported delivered as
// "retired now means hidden from the lists agents read at boot". MEASURED
// FALSE: tools/ledger-archive.js appends its dispositions to
// state/owner-request-disposition-events.jsonl, tools/ledger-query.js read
// retirements out of reports/OWNER-REQUEST-LEDGER-ARCHIVE.json, and
// partitionRetired() -- the function ledger-archive.js publishes for exactly
// this reader -- was exported and imported by nothing. The two halves were
// wired to different files, so a retirement made that day still rendered as an
// open gate in reports/OPEN-GATES.md.
//
// Both halves had tests. Neither suite crossed the seam, which is how a gap
// this size stayed green. So this suite deliberately does the opposite of a
// unit test: it makes the retirement with the REAL writer
// (tools/ledger-archive.js archiveLedger), reads it back with the REAL reader
// (tools/ledger-query.js buildOpenGatesProjection -- the same function the CLI
// calls), renders the REAL digest, and looks for the entry in the published
// markdown. Anything less would prove its own copy of the wiring works and say
// nothing about the wiring that ships.
//
// Fixtures only. This suite never reads or writes the live
// reports/OWNER-REQUEST-LEDGER.json, reports/OPEN-GATES.md, or
// state/owner-request-disposition-events.jsonl; every path below is inside a
// fresh temp directory that is removed at the end.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ledgerQuery = require(path.join(ROOT, 'tools', 'ledger-query.js'));
const ledgerArchive = require(path.join(ROOT, 'tools', 'ledger-archive.js'));
const scopeStore = require(path.join(ROOT, 'src', 'lib', 'owner-request-scope-store.js'));
const digestContract = require(path.join(ROOT, 'src', 'lib', 'open-gates-digest-contract.js'));

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${label}\n`); };
const checkAsync = async (label, fn) => { await fn(); checks += 1; process.stdout.write(`  ok  ${label}\n`); };

// --------------------------------------------------------------------------
// Fixtures. Built here rather than copied from the live record: the ledger is
// empty in this tree, and a test that depends on production content is a test
// that goes red for reasons that have nothing to do with it.
// --------------------------------------------------------------------------

const LEDGER_REVISION = 7;
const LEDGER_UPDATED_AT = '2026-08-12';

function gate(instruction, met, extra = {}) {
  return { instruction, met, evidence: '', ...extra };
}

function fixtureLedger() {
  return {
    schemaVersion: 1,
    revision: LEDGER_REVISION,
    updatedAt: LEDGER_UPDATED_AT,
    requests: [
      // A plain unmet gate that must survive every retirement below untouched.
      // Without a control the assertion "R904 left the active list" cannot tell
      // a working filter from a projection that lost everything.
      {
        id: 'R900',
        status: 'open',
        verbatim: 'keep the launcher window titled the same way on every start',
        gates: [gate('title every launcher window identically', false)]
      },
      // The permissions corpus. None of these is a task; all of them must be
      // visible in the digest whatever happens to the work around them.
      {
        id: 'R901',
        status: 'done',
        verbatim: 'yes go ahead and rewrite the packaging script, you do not need to ask again',
        gates: [
          gate('rewrite the packaging script without asking each time', true, {
            clauseKind: 'grant',
            authorization: { permits: 'rewrite the packaging script without a fresh approval', scope: 'any lane in this checkout' }
          })
        ]
      },
      {
        id: 'R902',
        status: 'open',
        verbatim: 'never send anything outward under my name without asking me first',
        gates: [
          gate('do not send anything outward under the owner identity unprompted', true, {
            clauseKind: 'prohibition',
            authorization: { forbids: 'sending anything outward under the owner identity', scope: 'all lanes, all machines' }
          })
        ]
      },
      // A withdrawal. Proves the revoked half of the section renders, so a
      // reader can see a permission existed and was taken back.
      {
        id: 'R903',
        status: 'open',
        verbatim: 'actually stop, ask me before packaging changes from now on',
        gates: [
          gate('packaging changes need a fresh approval again', true, {
            clauseKind: 'grant',
            authorization: {
              permits: 'packaging changes, but only after a fresh approval',
              scope: 'all lanes',
              revokes: ['R901#1']
            }
          })
        ]
      },
      // The rule-level retirement target: two unmet gates, both classified
      // active, one of which gets retired. One entry, two clauses, so the
      // measurement can show exactly one of them leaving.
      {
        id: 'R904',
        status: 'open',
        verbatim: 'fix the tray icon and also make the update check quieter',
        gates: [
          gate('make the update check quieter', false),
          gate('fix the tray icon', false)
        ]
      },
      // The request-level retirement target. It is a complete, schema-valid
      // request with command evidence; an independent fixture judgement below
      // supplies the second signal family required for retirement.
      {
        id: 'R905',
        status: 'done',
        verbatim: 'verify the obsolete request no longer leaves work in the active boot list',
        gatesCoverVerbatim: true,
        gates: [gate('verify the obsolete request has no remaining action', true, {
          clauseKind: 'work',
          evidence: 'node tests/ledger-cold-storage-boot-lists.js passed'
        })]
      }
    ]
  };
}

function fixtureScopeStore() {
  const rule = (ruleId, ruleKey, sourceRequestId, summary) => ({
    schemaVersion: 1,
    ruleId,
    ruleKey,
    scopeKind: 'global',
    threadId: null,
    sourceRequestId,
    issuedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: null,
    decisionSummary: summary,
    evidenceRefs: [],
    ownerVerbatim: summary
  });
  return {
    schemaVersion: 1,
    revision: 3,
    rules: [
      rule('rule_r900_gate_001', 'request.r900.gate.001', 'R900', 'launcher window titles are in scope'),
      rule('rule_r904_gate_001', 'request.r904.gate.001', 'R904', 'the update check clause is in scope'),
      rule('rule_r904_gate_002', 'request.r904.gate.002', 'R904', 'the tray icon clause is in scope')
    ]
  };
}

function emptyArchiveFile() {
  return {
    $comment: ['fixture archive; empty on purpose'],
    schemaVersion: 2,
    revision: 0,
    updatedAt: null,
    maintainedBy: 'tools/ledger-archive.js',
    requests: [],
    retirements: []
  };
}

function makeRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cold-storage-${name}-`));
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  const files = {
    root,
    ledgerFile: path.join(root, 'reports', 'OWNER-REQUEST-LEDGER.json'),
    archiveFile: path.join(root, 'reports', 'OWNER-REQUEST-LEDGER-ARCHIVE.json'),
    scopeStoreFile: path.join(root, 'state', 'owner-request-scope-store.json'),
    overlayFile: path.join(root, 'state', 'owner-request-disposition-events.jsonl'),
    precedentFile: path.join(root, 'no-precedent.md')
  };
  fs.writeFileSync(files.ledgerFile, JSON.stringify(fixtureLedger(), null, 2), 'utf8');
  fs.writeFileSync(files.archiveFile, JSON.stringify(emptyArchiveFile(), null, 2), 'utf8');
  fs.writeFileSync(files.scopeStoreFile, JSON.stringify(fixtureScopeStore(), null, 2), 'utf8');
  // Empty precedent corpus: veto V3 retires nothing here because the fixture
  // ids are cited nowhere. Pointing at the real STANDING-ORDERS.md would make
  // this suite's result depend on that file's contents.
  fs.writeFileSync(files.precedentFile, '# no precedent cited\n', 'utf8');
  return files;
}

// A monotonic fake clock. Real time would make the recorded `at` stamps
// unreproducible and gives nothing: nothing in the cold-storage rule reads a
// clock to make a decision (ledger-archive.js header, "THE BOUNDARY IS NOT
// TIME-BASED").
function fixedClock(startMs = Date.parse('2026-08-12T09:00:00.000Z')) {
  let tick = 0;
  return () => startMs + (tick += 1000);
}

function dependenciesFor(files, clock) {
  return {
    ledgerFile: files.ledgerFile,
    archiveFile: files.archiveFile,
    scopeStoreFile: files.scopeStoreFile,
    overlayFile: files.overlayFile,
    precedentFiles: [files.precedentFile],
    clock
  };
}

/** Drive a target all the way to COLD through the real writer: cool it, expose
 *  it to the quorum of distinct sessions, then retire it. */
function retireToCold(files, clock, target, actor, { judgementQuote = null } = {}) {
  const deps = () => dependenciesFor(files, clock);
  if (judgementQuote) {
    ledgerArchive.archiveLedger({
      operation: 'judge',
      dryRun: false,
      target,
      actor: `${actor}-judge`,
      sessionId: `${actor}-judge-session`,
      quote: judgementQuote,
      why: 'independently re-ran the fixture command and confirmed the quoted requirement'
    }, deps());
  }
  const preview = ledgerArchive.archiveLedger({ operation: 'archive', dryRun: true }, deps());
  ledgerArchive.archiveLedger({
    operation: 'archive',
    dryRun: false,
    target,
    expectedPlanSha256: preview.planSha256,
    actor,
    sessionId: `${actor}-open`,
    evidence: ['node tests/ledger-cold-storage-boot-lists.js -- fixture retirement']
  }, deps());
  for (const session of ['watcher-one', 'watcher-two', 'watcher-three']) {
    ledgerArchive.archiveLedger({
      operation: 'observe',
      dryRun: false,
      target,
      actor,
      sessionId: session,
      why: `shown in the cooling line of ${session}`
    }, deps());
  }
  const second = ledgerArchive.archiveLedger({ operation: 'archive', dryRun: true }, deps());
  return ledgerArchive.archiveLedger({
    operation: 'archive',
    dryRun: false,
    target,
    expectedPlanSha256: second.planSha256,
    actor,
    sessionId: `${actor}-close`
  }, deps());
}

/** Everything the digest reader needs, assembled the way the CLI assembles it. */
async function readBootLists(files) {
  const rules = scopeStore.readScopeStore({ file: files.scopeStoreFile }).rules;
  const projection = await ledgerQuery.buildOpenGatesProjection({
    ledgerPath: files.ledgerFile,
    archivePath: files.archiveFile,
    overlayPath: files.overlayFile,
    scopeRules: rules
  });
  const markdown = ledgerQuery.renderOpenGatesDigest(projection, {
    revision: LEDGER_REVISION,
    updatedAt: LEDGER_UPDATED_AT
  });
  return { projection, markdown };
}

/** The text between one contract heading and the next. "Absent from the active
 *  list" has to be measured inside the active section: an id that merely moved
 *  to the retired section is still present in the file, and a whole-file
 *  substring search would call that a pass. */
function sectionBody(markdown, sectionId) {
  const headings = digestContract.OPEN_GATES_SECTIONS.map(section => section.heading);
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => line.startsWith(digestContract.heading(sectionId)));
  assert.notEqual(start, -1, `digest is missing the ${sectionId} section`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (headings.some(head => lines[i].startsWith(head))) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

function activeGateRefs(projection) {
  return projection.active.map(item => `${item.requestId}#${item.gateIndex + 1}`).sort();
}

const roots = [];

async function run() {
  // ========================================================================
  // 1. BEFORE. The unretired baseline, so every later count has something to
  //    be measured against.
  // ========================================================================
  const files = makeRoot('writer');
  roots.push(files.root);
  const clock = fixedClock();

  const before = await readBootLists(files);

  await checkAsync('BEFORE: both R904 clauses and the control gate are live in "## Active gates"', () => {
    assert.deepEqual(activeGateRefs(before.projection), ['R900#1', 'R904#1', 'R904#2']);
    const active = sectionBody(before.markdown, 'active');
    assert.match(active, /make the update check quieter/);
    assert.match(active, /fix the tray icon/);
    assert.equal(before.projection.retiredClauses.length, 0);
    assert.equal(before.projection.retired.length, 0);
  });

  // ========================================================================
  // 2. A CLAUSE RETIREMENT, MADE BY THE REAL WRITER.
  //
  //    This is the case the "still shows as an open gate" defect was really
  //    about. At REQUEST level the writer cannot cool anything that has an
  //    unmet gate -- every request-level signal (M1 needs every gate met, M2
  //    needs full supersession, M3 needs no gates at all) excludes it -- so a
  //    request-level retirement can never remove a row from "## Active gates".
  //    A RULE target can and does: signal O1, an explicit per-clause
  //    retirement, is sufficient on its own and says nothing about `met`.
  // ========================================================================
  const clauseTarget = { targetKind: 'rule', requestId: 'R904', ruleKey: 'request.r904.gate.001' };
  const clauseReceipt = retireToCold(files, clock, clauseTarget, 'cold-storage-test');

  check('the writer recorded the clause retirement as one append, and never touched the ledger', () => {
    assert.equal(clauseReceipt.changedCount, 1);
    assert.deepEqual({ ...clauseReceipt.appliedTarget }, clauseTarget);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(files.ledgerFile, 'utf8')),
      fixtureLedger(),
      'retirement must never rewrite the owner ledger'
    );
    const events = fs.readFileSync(files.overlayFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.disposition),
      ['cooling', 'observe', 'observe', 'observe', 'cold']);
    assert.equal(events.at(-1).reasonCode, 'owner-confirmed');
  });

  const afterClause = await readBootLists(files);

  await checkAsync('AFTER: the retired clause is GONE from "## Active gates" and only that clause moved', () => {
    assert.deepEqual(activeGateRefs(afterClause.projection), ['R900#1', 'R904#2'],
      'exactly the retired clause leaves the active list; its sibling and the control stay');
    const active = sectionBody(afterClause.markdown, 'active');
    assert.doesNotMatch(active, /make the update check quieter/,
      'the retired instruction must not appear anywhere in the active section');
    assert.match(active, /fix the tray icon/, 'the sibling clause is untouched');
    assert.match(active, /title every launcher window identically/, 'the control gate is untouched');
  });

  await checkAsync('AFTER: it is preserved, not deleted -- it renders under "## Retired clause gates"', () => {
    const retired = sectionBody(afterClause.markdown, 'retired-clauses');
    assert.match(retired, /make the update check quieter/);
    // The reason code that reaches the renderer is the LEGACY vocabulary the
    // lifecycle projection accepts. This is the mapping in question: the
    // overlay minted `owner-confirmed`, and that code survives the downgrade
    // unchanged, so RETIREMENT_REASON_CODES needs no widening for it.
    assert.match(retired, /Retirement: owner-confirmed/);
    assert.equal(afterClause.projection.retiredClauses.length, 1);
    assert.equal(afterClause.projection.retiredClauses[0].retirement.reason.code, 'owner-confirmed');
  });

  // ========================================================================
  // 3. A WHOLE-REQUEST RETIREMENT, also by the real writer.
  // ========================================================================
  const requestTarget = { targetKind: 'request', requestId: 'R905' };
  retireToCold(files, clock, requestTarget, 'cold-storage-test', {
    judgementQuote: 'verify the obsolete request no longer leaves work in the active boot list'
  });
  const afterRequest = await readBootLists(files);

  await checkAsync('a cold REQUEST is withheld from the active corpus and carries its retirement', async () => {
    const cold = await ledgerQuery.readColdStorage(
      await ledgerQuery.readLedger(files.ledgerFile),
      { archivePath: files.archiveFile, overlayPath: files.overlayFile }
    );
    assert.ok(!cold.active.some(request => request.id === 'R905'),
      'R905 must not reach the projection as an active request');
    assert.deepEqual(cold.retiredRequests.map(request => request.id), ['R905']);
    const retirement = cold.retirements.find(item => item.requestId === 'R905' && item.targetKind === 'request');
    assert.ok(retirement, 'a withheld request must carry a retirement record');
    // Mechanical evidence plus an independent judgement retires this request
    // as settled. The lifecycle reader maps that to completed while carrying
    // the sharper reason at the front of the detail.
    assert.equal(retirement.reason.code, 'completed');
    assert.match(retirement.reason.detail, /^settled — /);
  });

  await checkAsync('a lookup by id is never cold, even when every list has withheld the entry', async () => {
    const full = await ledgerQuery.readLedger(files.ledgerFile);
    const record = ledgerQuery.processGet('R905', full);
    assert.equal(record.id, 'R905');
    assert.equal(record.status, 'done');
  });

  await checkAsync('the digest still renders complete after both retirements', () => {
    const shape = digestContract.checkDigestSections(afterRequest.markdown);
    assert.deepEqual(shape.missing, []);
    assert.deepEqual(shape.outOfOrder, []);
    assert.ok(shape.complete);
  });

  // ========================================================================
  // 4. THE AUTHORIZATIONS SECTION -- the other half of today's report.
  // ========================================================================
  check('permissions render ABOVE the task list, which is the whole point of the section', () => {
    const markdown = afterRequest.markdown;
    const permissions = markdown.indexOf(digestContract.heading('authorizations'));
    const tasks = markdown.indexOf(digestContract.heading('active'));
    assert.ok(permissions > 0, 'the authorizations section must exist');
    assert.ok(permissions < tasks,
      'an agent that stops reading at the first task list must already have passed "am I allowed to do this"');
  });

  check('a grant, a prohibition and a revoked grant are each rendered, with their authority labelled', () => {
    const body = sectionBody(afterClause.markdown, 'authorizations');
    assert.match(body, /R902#1 FORBIDDEN: sending anything outward under the owner identity/);
    assert.match(body, /R903#1 AUTHORIZED: packaging changes, but only after a fresh approval/);
    assert.match(body, /R901#1 AUTHORIZED: rewrite the packaging script without a fresh approval[^\n]*REVOKED by R903#1/);
    // Authority is labelled on every line: these fixtures have no recorded
    // provenance, so none of them may be described back as the owner's word.
    assert.doesNotMatch(body, /\[owner-stated\]/);
    assert.match(body, /NOT SHOWN TO BE THE OWNER'S/);
  });

  check('a permission is NOT withdrawn by the lifecycle -- only by an explicit revocation', () => {
    const counts = afterRequest.projection.authorizations.counts;
    // R903 grant + R902 prohibition are in force; R901's grant is revoked by
    // R903, not by anything that happened to the work it covered. Two
    // retirements landed between the two reads and moved neither number.
    assert.equal(counts.grants, 1);
    assert.equal(counts.prohibitions, 1);
    assert.equal(counts.revoked, 1);
    assert.deepEqual(
      { ...before.projection.authorizations.counts },
      { ...afterRequest.projection.authorizations.counts },
      'retiring work must not change what is permitted'
    );
  });

  check('the header states the permission counts, so a reader who skims is still told they exist', () => {
    // The undeclared count is published alongside the totals on purpose. R900
    // and R904's two clauses declare no `clauseKind`, so "1 grant" here means
    // "one clause has been classified as a permission", not "one thing is
    // permitted in this corpus" -- and a reader can tell the two apart only
    // because the third number is on the line.
    assert.match(afterRequest.markdown, /^Authorizations in force: 1 grant, 1 prohibition \(3 clauses undeclared\)$/m);
  });

  // ========================================================================
  // 5. THE LEGACY ARCHIVE PATH. A request the OLD delete path removed from the
  //    ledger lives only in reports/OWNER-REQUEST-LEDGER-ARCHIVE.json. Its
  //    permissions must still be readable -- the projection reads the active
  //    set, so a withheld entry's grants have to be unioned back in or
  //    retirement silently becomes revocation.
  // ========================================================================
  const legacy = makeRoot('legacy');
  roots.push(legacy.root);
  const legacyArchive = emptyArchiveFile();
  legacyArchive.requests = [{
    id: 'R906',
    status: 'done',
    verbatim: 'you can restart the bridge yourself whenever it wedges, no need to ask',
    gates: [gate('restart the bridge without asking', true, {
      clauseKind: 'grant',
      authorization: { permits: 'restarting the mission bridge without a fresh approval', scope: 'any lane' }
    })]
  }];
  legacyArchive.retirements = [{
    targetKind: 'request',
    requestId: 'R906',
    retiredAt: '2026-08-01T00:00:00.000Z',
    retiredBy: 'legacy-controller',
    reason: { code: 'completed', detail: 'retired by the pre-overlay delete path', supersedingRequestIds: [] }
  }];
  fs.writeFileSync(legacy.archiveFile, JSON.stringify(legacyArchive, null, 2), 'utf8');

  await checkAsync('a permission on a retired entry survives, and the active set alone would have lost it', async () => {
    const { projection, markdown } = await readBootLists(legacy);
    assert.ok(projection.authorizations.inForce.some(record => record.ref === 'R906#1'),
      'the grant on the retired R906 must still be in force');
    assert.match(sectionBody(markdown, 'authorizations'),
      /R906#1 AUTHORIZED: restarting the mission bridge without a fresh approval/);
    // The counter-measurement. Reading only the active set -- what this file
    // did before the union was added -- drops the grant entirely, which is the
    // difference between "he never permitted it" and "the permission is filed
    // under a finished task".
    const cold = await ledgerQuery.readColdStorage(
      await ledgerQuery.readLedger(legacy.ledgerFile),
      { archivePath: legacy.archiveFile, overlayPath: legacy.overlayFile }
    );
    const activeOnly = ledgerQuery.projectAuthorizations(cold.active);
    assert.ok(!activeOnly.inForce.some(record => record.ref === 'R906#1'),
      'this is the measurement that makes the union above load-bearing rather than incidental');
  });

  // ========================================================================
  // 6. THE TWO REASON-CODE ALLOWLISTS EITHER SIDE OF THIS SEAM.
  //
  //    Reported as unaddressed: src/lib/mission-bridge/actions.js:192 still
  //    allows only [completed, fully-superseded], and
  //    src/lib/owner-request-lifecycle-projection.js's
  //    RETIREMENT_REASON_CODES still allows only [completed,
  //    fully-superseded, owner-confirmed], while the overlay mints five
  //    sharper codes. Neither is a defect -- but "it looks consistent" is not
  //    evidence, so both are measured here instead of read. What makes an
  //    allowlist safe is that everything its producer can emit is on it, and
  //    that is a fact a test can hold still.
  // ========================================================================
  check('every reason code the overlay can mint survives the downgrade the boot lists accept', () => {
    // The lifecycle projection's private RETIREMENT_REASON_CODES. Restated
    // here on purpose: if that list is narrowed, this suite goes red naming
    // the code that stopped being representable, rather than a caller
    // discovering it at retirement time.
    const accepted = ['completed', 'fully-superseded', 'owner-confirmed'];
    const sharpCodes = ['settled', 'superseded', 'unadjudicable', 'absorbed', 'owner-confirmed'];
    const requests = sharpCodes.map((code, index) => ({
      id: `R91${index}`,
      status: 'open',
      verbatim: `fixture entry retired under ${code}`,
      gates: [gate(`unmet clause retired under ${code}`, false)]
    }));
    const events = sharpCodes.map((code, index) => ({
      disposition: 'cold',
      targetKind: 'request',
      requestId: `R91${index}`,
      reasonCode: code,
      detail: `fixture retirement under ${code}`,
      at: '2026-08-12T10:00:00.000Z',
      actor: 'fixture-actor',
      supersedingRequestIds: code === 'superseded' ? ['R999'] : []
    }));
    const partition = ledgerArchive.partitionRetired(
      requests,
      ledgerArchive.projectOverlay(events),
      { legacyReasonCodes: true }
    );
    assert.equal(partition.active.length, 0);
    assert.equal(partition.retirements.length, sharpCodes.length);
    for (const retirement of partition.retirements) {
      assert.ok(accepted.includes(retirement.reason.code),
        `${retirement.requestId} downgraded to "${retirement.reason.code}", which the boot lists would refuse`);
    }
    // A code that changed must say so in its own detail; a code that did not
    // must be left alone rather than decorated.
    const detailOf = id => partition.retirements.find(item => item.requestId === id).reason.detail;
    assert.match(detailOf('R912'), /^unadjudicable — /, 'the sharp code leads the detail so the downgrade cannot lie');
    assert.match(detailOf('R913'), /^absorbed — /);
    assert.doesNotMatch(detailOf('R914'), /^owner-confirmed — owner-confirmed/, 'an unchanged code is not restated');

    // And the reader accepts all five without throwing -- the measurement that
    // makes the list above load-bearing rather than decorative.
    const projection = ledgerQuery.processOpenGates(partition.active, {
      retiredRequests: partition.retiredRequests,
      retirements: partition.retirements
    });
    assert.equal(projection.counts.active, 0, 'every one of them is withheld from the active list');
    assert.equal(projection.counts.retired, sharpCodes.length, 'and every one is preserved in the retired list');
  });

  await checkAsync('the archive plan only ever mints codes the mission bridge will accept', async () => {
    // src/lib/mission-bridge/actions.js:192 refuses any candidate whose reason
    // code is outside [completed, fully-superseded] with a 503. The only
    // producer of those codes is candidateFor() in tools/ledger-archive.js, so
    // this pins the agreement from the producer's side: widen the planner's
    // vocabulary without widening the bridge and this goes red here, instead
    // of the bridge 503-ing a live retirement.
    const bridgeSource = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'mission-bridge', 'actions.js'), 'utf8');
    const bridgeAllowlistMatch = bridgeSource.match(
      /!\[(?<codes>(?:'[^']+'(?:, )?)+)\]\.includes\(candidate\.reason\.code\)/
    );
    assert.ok(bridgeAllowlistMatch, 'the mission bridge candidate reason-code validator must remain explicit');
    const bridgeAccepts = [...bridgeAllowlistMatch.groups.codes.matchAll(/'([^']+)'/g)].map(match => match[1]);
    const plan = ledgerArchive.archiveLedger(
      { operation: 'archive', dryRun: true },
      dependenciesFor(files, fixedClock())
    );
    assert.ok(plan.candidates.length > 0, 'the fixture must offer at least one candidate to measure');
    for (const candidate of plan.candidates) {
      assert.ok(bridgeAccepts.includes(candidate.reason.code),
        `the planner offered "${candidate.reason.code}", which src/lib/mission-bridge/actions.js would refuse as unknown`);
      assert.equal(candidate.reason.code === 'fully-superseded', candidate.reason.supersedingRequestIds.length > 0,
        'the bridge also pins this exact correspondence; a mismatch is a 503 there');
    }
  });

  await checkAsync('an unreadable legacy retirement reason is refused, never guessed into "completed"', async () => {
    const broken = makeRoot('broken');
    roots.push(broken.root);
    const archive = emptyArchiveFile();
    archive.retirements = [{
      targetKind: 'request',
      requestId: 'R907',
      retiredAt: '2026-08-01T00:00:00.000Z',
      retiredBy: 'legacy-controller',
      reason: { code: 'no-longer-relevant', detail: 'a code nothing in this tree defines', supersedingRequestIds: [] }
    }];
    fs.writeFileSync(broken.archiveFile, JSON.stringify(archive, null, 2), 'utf8');
    await assert.rejects(
      () => ledgerQuery.readColdStorage([], { archivePath: broken.archiveFile, overlayPath: broken.overlayFile }),
      /unreadable reason code/
    );
  });
}

run().then(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  assert.ok(checks >= 15, `expected at least 15 checks to run, ran ${checks}`);
  console.log(`ledger-cold-storage-boot-lists: ${checks} checks passed`);
}).catch(error => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
