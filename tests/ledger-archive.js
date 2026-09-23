// EXECUTABLE CHANGE
// report: testcanfail-tests-ledger-archive-js
//
// Strengthened assertion: the persisted veto audit at the assertion below must
// name V1, V2, V3, V4, and V5, rather than merely containing five entries.
// Mutation: in a temporary edit to tools/ledger-archive.js, changed the
// non-firing V5 audit id to VX. Before strengthening, the suite stayed green:
//   ledger-archive: 112 checks passed in 750 ms
// After strengthening, the mutation produced RED output:
//   ERR_ASSERTION: AssertionError [ERR_ASSERTION]: the event records the identity of every required veto check
//   + actual - expected
//     [ 'V1', 'V2', 'V3', 'V4', + 'VX' - 'V5' ]
// The product file was then restored byte-for-byte (matching SHA-256
// 74a0c659fb1c6d8bea9f6173ecd0f1febfb06b5090199c400ddb4e271f81404a),
// and the strengthened suite returned GREEN:
//   ledger-archive: 113 checks passed in 637 ms
//
// Shape census: (1) NOT-FOUND -- loops iterate test-owned, non-empty literals;
// derived collections also have exact cardinality assertions before iteration.
// (2) NOT-FOUND -- no exit-status or truthy process-return assertion. (3)
// NOT-FOUND -- the only try/finally cleans fixtures and does not swallow errors;
// optional chaining in the throws helper only inspects a required error code.
// (4) NOT-FOUND -- injected bridge dependencies record ancillary audit/policy
// behavior, while assertions under review exercise the real archive core. (5)
// NOT-FOUND after repair -- the suite has no skip; the bridge formerly failed
// before its assertions when the private declared-org file was unavailable, so
// it now explicitly supplies the same normalized org fixture used to select its
// actor. (6) NOT-FOUND -- expected values are fixed fixture outcomes, not
// calculated by archive code.
// Named preconditions: the default Node 20.20.2 lacks node:sqlite; mutation and
// verification runs therefore used installed Node 24.15.0. The missing private
// config/agent-org.json precondition is removed by the explicit neutral fixture.

'use strict';

require('./helpers/isolated-state-root'); // FINDING 1, REPORT-ledger-kinds-tools-20260907.md: redirect TOOLSENABLED_STATE_ROOT off the live root before anything below can resolve it.

// WHAT THIS SUITE IS FOR.
//
// tools/ledger-archive.js used to retire an owner request by DELETING it from
// reports/OWNER-REQUEST-LEDGER.json and bumping the revision. It was complete,
// owner-gated and tested, and it had retired zero entries ever, because its
// first act was removing the owner's record. The single most important check
// below is therefore the dullest one: after every single operation, including
// the ones that retire, the ledger file's sha256 is BYTE-IDENTICAL to what it
// was before. If that assertion ever fails, the defect is back.
//
// The fixtures are built here rather than read from the tree: the real ledger
// was reset to revision 1 with zero requests at owner direction on 2026-08-12,
// and the archived old record is off limits.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const archiveTool = require('../tools/ledger-archive');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

let checks = 0;
function equal(actual, expected, message) { checks += 1; assert.deepEqual(actual, expected, message); }
function ok(value, message) { checks += 1; assert.ok(value, message); }
function throws(work, code, message) { checks += 1; assert.throws(work, error => error?.code === code, `${message} (expected ${code})`); }

function request(id, status, gates, extra = {}) {
  return { id, request: `${id} interpretation`, verbatim: `${id} exact owner words`, status, ...(gates === undefined ? {} : { gates }), ...extra };
}
function metGate(instruction, evidence) { return { instruction, met: true, evidence }; }
function rule({ id, requestId, key, issuedAt }) {
  return { schemaVersion: 1, ruleId: id, ruleKey: key, scopeKind: 'global', threadId: null, sourceRequestId: requestId, issuedAt, expiresAt: null, decisionSummary: `${requestId} ${key}`, evidenceRefs: [], ownerVerbatim: `${requestId} verbatim` };
}
function target(requestId, ruleKey) { return ruleKey === undefined ? { targetKind: 'request', requestId } : { targetKind: 'rule', requestId, ruleKey }; }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex'); }

async function main() {
  const started = Date.now();
  const root = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'ledger-archive-test-'));
  const ledgerFile = path.join(root, 'OWNER-REQUEST-LEDGER.json');
  const archiveFile = path.join(root, 'OWNER-REQUEST-LEDGER-ARCHIVE.json');
  const scopeStoreFile = path.join(root, 'owner-request-scope-rules.json');
  const overlayFile = path.join(root, 'state', 'owner-request-disposition-events.jsonl');
  const precedentFile = path.join(root, 'STANDING-ORDERS.md');
  const nowMs = Date.parse('2026-08-07T12:00:00.000Z');

  // R1  done, gates met, each with run-record evidence      -> M1 + M1+ (mechanical only)
  // R2  done, one gate unmet                                -> inconsistency, never a candidate
  // R3  open, fully superseded by live R4 which names R3    -> M2, sufficient
  // R4  the superseding entry, live and naming R3
  // R5  open, holds a clause used for rule-target retirement
  // R6  no verbatim, no gates, provenance unclassified      -> M3, sufficient (unadjudicable)
  // R7  done + gates met, but restated later by R8          -> veto V2 (recurrence)
  // R8  the later restatement of R7
  // R9  done + gates met, carries a grant clause            -> veto V1
  // R10 done + gates met, but cited by STANDING-ORDERS.md   -> veto V3
  // R11 blocked-external                                    -> veto V4
  // R12 done + gates met, gatesCoverVerbatim attested false -> veto V5
  // These are ordinary fresh-customer request ids with no built-in protection.
  const r1 = request('R1', 'done', [metGate('verified', 'npm run test:owner.ledger -> exit 0, 2,607 ms, 41 checks passed')], { nested: { untouched: true }, verbatim: 'R1 must never rewrite the append only owner record while retiring anything' });
  const r2 = request('R2', 'done', [{ instruction: 'not verified', met: false, evidence: '' }]);
  const r3 = request('R3', 'open');
  const r4 = { ...request('R4', 'open'), request: 'R4 replaces R3 outright' };
  const r5 = request('R5', 'open');
  const r6 = { id: 'R6', request: '', verbatim: '', status: 'open' };
  const r7 = request('R7', 'done', [metGate('done', 'node tests/smoke.js exit 0')], { verbatim: 'stop rewriting the owner ledger when you retire something please' });
  const r8 = request('R8', 'open', undefined, { verbatim: 'stop rewriting the owner ledger when you retire something please, I mean it' });
  const r9 = request('R9', 'done', [{ ...metGate('authorized', 'node tests/smoke.js exit 0'), clauseKind: 'grant' }]);
  const r10 = request('R10', 'done', [metGate('done', 'node tests/smoke.js exit 0')]);
  const r11 = request('R11', 'blocked-external', [metGate('done', 'node tests/smoke.js exit 0')]);
  const r12 = request('R12', 'done', [metGate('done', 'node tests/smoke.js exit 0')], { gatesCoverVerbatim: false });
  const r44 = request('R44', 'done');
  const r51 = request('R51', 'done');
  const r70 = request('R70', 'done');
  const r241 = request('R241', 'done');
  const ledger = {
    schemaVersion: 1, revision: 9, updatedAt: '2026-08-06',
    requests: [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r44, r51, r70, r241],
    controllerNotes: ['fixture metadata survives']
  };
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2), 'utf8');
  fs.writeFileSync(scopeStoreFile, JSON.stringify({ schemaVersion: 1, revision: 1, rules: [
    rule({ id: 'rule_r3_old', requestId: 'R3', key: 'fixture.same-key', issuedAt: '2026-08-01T00:00:00.000Z' }),
    rule({ id: 'rule_r4_new', requestId: 'R4', key: 'fixture.same-key', issuedAt: '2026-08-02T00:00:00.000Z' }),
    rule({ id: 'rule_r5_clause', requestId: 'R5', key: 'fixture.partial-clause', issuedAt: '2026-08-01T00:00:00.000Z' })
  ] }, null, 2), 'utf8');
  fs.writeFileSync(precedentFile, '# Standing orders\n\nR10 is quoted here as live precedent.\n', 'utf8');

  const deps = { ledgerFile, archiveFile, scopeStoreFile, overlayFile, precedentFiles: [precedentFile], clock: () => nowMs };
  const LEDGER_SHA = sha256File(ledgerFile);
  function ledgerUnchanged(message) { checks += 1; assert.equal(sha256File(ledgerFile), LEDGER_SHA, message); }
  function preview() { return archiveTool.archiveLedger({ operation: 'archive', dryRun: true }, deps); }
  function retire(id, extra = {}) {
    return archiveTool.archiveLedger({ operation: 'archive', dryRun: false, expectedPlanSha256: preview().planSha256, target: target(id), retiredBy: 'coordinator-sol', ...extra }, deps);
  }
  function overlayEvents() {
    return fs.readFileSync(overlayFile, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  }

  try {
    // ---- initialization -------------------------------------------------
    equal(archiveTool.DEFAULT_PRECEDENT_FILES, Object.freeze([]), 'a neutral installation inherits no prior owner precedent files');
    const initialized = archiveTool.initializeOverlay({ overlayFile });
    equal(initialized.initialized, true, 'initialization creates the append-only overlay');
    equal(archiveTool.initializeOverlay({ overlayFile }).initialized, false, 'initialization is idempotent');
    equal(fs.readFileSync(overlayFile, 'utf8'), '', 'a fresh overlay holds no events');

    // ---- the planner is unchanged ---------------------------------------
    const first = preview();
    equal(first.candidates.map(item => item.requestId), ['R1', 'R3', 'R7', 'R9', 'R10', 'R12', 'R44', 'R51', 'R70', 'R241'], 'the planner offers completed and fully-superseded candidates, including ids with no current precedent');
    equal(first.candidates.find(item => item.requestId === 'R3').reason.code, 'fully-superseded', 'supersession remains a candidate reason rather than an automatic move');
    equal(first.inconsistencies.map(item => item.id), ['R2'], 'a done request with an unmet gate stays active and is reported');
    equal(first.candidates.filter(item => ['R44', 'R51', 'R70', 'R241'].includes(item.requestId)).map(item => item.requestId),
      ['R44', 'R51', 'R70', 'R241'], 'historical request numbers have no built-in retention authority');
    equal(first.activeCount, ledger.requests.length, 'activeCount is the ledger length');
    equal(first.archiveCount, 0, 'nothing is held out of the active set yet');
    ledgerUnchanged('a preview does not touch the ledger');
    throws(() => archiveTool.archiveLedger({ operation: 'archive', dryRun: true }, {
      ...deps,
      precedentFiles: [path.join(root, 'missing-precedent.md')]
    }), 'LEDGER_ARCHIVE_READ_FAILED', 'an unreadable precedent source refuses retirement rather than reporting zero citations');

    // ---- THE FIX: retiring appends, it does not delete -------------------
    const cooled = retire('R3');
    equal(cooled.appliedTarget, target('R3'), 'execution changes one exact target');
    equal(cooled.changedCount, 1, 'execution reports exactly one lifecycle change');
    ledgerUnchanged('THE FIX: a confirmed retirement leaves reports/OWNER-REQUEST-LEDGER.json byte-identical');
    const afterR3 = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    equal(afterR3.requests.map(item => item.id), ledger.requests.map(item => item.id), 'every request is still in the ledger, including the retired one');
    equal(afterR3.revision, 9, 'the ledger revision is not bumped by a retirement');
    equal(fs.existsSync(archiveFile), false, 'no second copy of the owner record is created');

    const events = overlayEvents();
    equal(events.length, 1, 'a retirement is exactly one appended event');
    equal(events[0].disposition, 'cooling', 'the first retirement step is COOLING, never COLD (owner decision D3)');
    equal(events[0].reasonCode, 'superseded', 'the reason code names its own evidence class');
    equal(events[0].points.map(point => point.id), ['M2'], 'the event records the points that scored it');
    ok(events[0].vetoesChecked.length >= 5, 'the event records every veto that was checked, not just the ones that fired');
    equal(events[0].vetoesChecked.map(veto => veto.id), ['V1', 'V2', 'V3', 'V4', 'V5'], 'the event records the identity of every required veto check');
    equal(events[0].supersedingRequestIds, ['R4'], 'superseding provenance survives into the overlay');
    equal(events[0].ledgerSha256, LEDGER_SHA, 'the event records which ledger bytes the decision was made against');
    ok(/^[a-f0-9]{64}$/.test(events[0].eventSha256), 'every event is hash-chained');

    // ---- it is still visible, and lookups are never cold -----------------
    const explained = archiveTool.explainTarget(target('R3'), deps);
    equal(explained.disposition, 'cooling', 'an agent can see the disposition of any id');
    equal(explained.score.sufficientSignal, 'M2', 'an agent can see WHY it was retired');
    equal(explained.observations, [], 'a freshly cooling entry has been seen by nobody');
    equal(explained.quorum, archiveTool.COLD_EXPOSURE_QUORUM, 'the exposure quorum is printed, not hidden');

    // ---- COOLING is not COLD: only cold is withheld from the lists -------
    const cooling = archiveTool.partitionRetired(afterR3.requests, archiveTool.readDispositions(deps).byTarget);
    equal(cooling.retiredRequests, [], 'a cooling entry is still rendered: exposure is what earns the retirement');

    // ---- THE BOUNDARY IS NOT TIME-BASED ---------------------------------
    const farFuture = { ...deps, clock: () => Date.parse('2099-01-01T00:00:00.000Z') };
    throws(() => archiveTool.archiveLedger({ operation: 'archive', dryRun: false, expectedPlanSha256: archiveTool.archiveLedger({ operation: 'archive', dryRun: true }, farFuture).planSha256, target: target('R3'), retiredBy: 'coordinator-sol' }, farFuture),
      'LEDGER_ARCHIVE_EXPOSURE_INSUFFICIENT', 'seventy-three years of silence do not make an entry cold');

    archiveTool.archiveLedger({ operation: 'observe', dryRun: false, target: target('R3'), actor: 'lane-a', sessionId: 'session-one' }, deps);
    archiveTool.archiveLedger({ operation: 'observe', dryRun: false, target: target('R3'), actor: 'lane-b', sessionId: 'session-two' }, deps);
    throws(() => archiveTool.archiveLedger({ operation: 'observe', dryRun: false, target: target('R3'), actor: 'lane-b', sessionId: 'session-two' }, deps),
      'LEDGER_ARCHIVE_ALREADY_OBSERVED', 'the quorum counts distinct sessions, so one session cannot vote twice');
    throws(() => retire('R3'), 'LEDGER_ARCHIVE_EXPOSURE_INSUFFICIENT', 'two of three exposures is not cold');
    archiveTool.archiveLedger({ operation: 'observe', dryRun: false, target: target('R3'), actor: 'lane-c', sessionId: 'session-three' }, deps);
    const cold = retire('R3');
    equal(cold.appliedTarget, target('R3'), 'the third uncontested exposure earns COLD');
    equal(overlayEvents().at(-1).disposition, 'cold', 'COLD is reached by watchers, never by age');
    ledgerUnchanged('going cold leaves the ledger byte-identical');

    // ---- cold is erased from the lists, never from the record -----------
    const partitioned = archiveTool.partitionRetired(afterR3.requests, archiveTool.readDispositions(deps).byTarget);
    equal(partitioned.retiredRequests.map(item => item.id), ['R3'], 'cold entries are withheld from the prominent set agents read');
    equal(partitioned.active.some(item => item.id === 'R3'), false, 'a cold entry is out of the active list');
    equal(partitioned.retirements[0].reason.code, 'superseded', 'the sharp reason code is the default');
    equal(archiveTool.partitionRetired(afterR3.requests, archiveTool.readDispositions(deps).byTarget, { legacyReasonCodes: true }).retirements[0].reason.code, 'fully-superseded', 'the legacy vocabulary is available for the projection that still needs it');
    equal(archiveTool.explainTarget(target('R3'), deps).disposition, 'cold', 'a lookup by id always answers, so cold affects lists and never lookups');

    // ---- reversal costs one append, by anybody --------------------------
    const beforeContest = overlayEvents().length;
    archiveTool.archiveLedger({ operation: 'contest', dryRun: false, target: target('R3'), actor: 'any-lane', sessionId: 'session-four', why: 'R4 does not actually cover the second clause' }, deps);
    equal(overlayEvents().length, beforeContest + 1, 'contesting costs exactly one append');
    equal(archiveTool.explainTarget(target('R3'), deps).disposition, 'active', 'one contest by anybody returns a cold entry to active, with no approval and no undelete');
    equal(archiveTool.explainTarget(target('R3'), deps).history.length, 6, 'the whole disposition history is retained, contest included');
    ledgerUnchanged('reversal leaves the ledger byte-identical too');
    equal(archiveTool.partitionRetired(afterR3.requests, archiveTool.readDispositions(deps).byTarget).retiredRequests, [], 'a contested entry is back in the list agents read');

    // ---- a contest costs the retirement its whole exposure window --------
    retire('R3');
    archiveTool.archiveLedger({ operation: 'observe', dryRun: false, target: target('R3'), actor: 'lane-a', sessionId: 'window-one' }, deps);
    archiveTool.archiveLedger({ operation: 'observe', dryRun: false, target: target('R3'), actor: 'lane-b', sessionId: 'window-two' }, deps);
    archiveTool.archiveLedger({ operation: 'contest', dryRun: false, target: target('R3'), actor: 'lane-c', why: 'still live, second clause is untouched' }, deps);
    retire('R3');
    equal(archiveTool.explainTarget(target('R3'), deps).observations, [], 'a contest costs the retirement every exposure it had banked');
    throws(() => retire('R3'), 'LEDGER_ARCHIVE_EXPOSURE_INSUFFICIENT', 'and the new window has to be earned from zero');
    ok(archiveTool.explainTarget(target('R3'), deps).history.some(entry => entry.disposition === 'contest'), 'while the contest itself stays in the permanent history');
    archiveTool.archiveLedger({ operation: 'contest', dryRun: false, target: target('R3'), actor: 'lane-c', why: 'still live, second clause is untouched' }, deps);

    // ---- the sharpened rule: "all gates met" alone can never retire ------
    const r1Score = archiveTool.explainTarget(target('R1'), deps).score;
    equal(r1Score.points.map(point => point.id), ['M1', 'M1+'], 'gate evidence that names a command and its result scores M1+');
    equal(r1Score.totalPoints, 2, 'M1 and M1+ do reach the point threshold');
    equal(r1Score.families, ['mechanical'], 'but they are one signal family');
    equal(r1Score.decision, 'hold', 'so "status done and every gate met" alone never retires anything');
    throws(() => retire('R1'), 'LEDGER_ARCHIVE_TARGET_INELIGIBLE', 'an admitted candidate is still refused when the rule is not met');

    // ---- one independent, verbatim-quoting judgement closes the gap ------
    throws(() => archiveTool.archiveLedger({ operation: 'judge', dryRun: false, target: target('R1'), actor: 'judge-lane', sessionId: 'session-judge', quote: 'words that were never his' }, deps),
      'LEDGER_ARCHIVE_JUDGEMENT_UNQUOTED', 'a judgement that does not quote the verbatim is refused');
    archiveTool.archiveLedger({ operation: 'judge', dryRun: false, target: target('R1'), actor: 'judge-lane', sessionId: 'session-judge', quote: 'must never rewrite the append only owner record', why: 'independently re-ran the named test' }, deps);
    equal(archiveTool.explainTarget(target('R1'), { ...deps, sessionId: 'session-judge' }).score.decision, 'hold', 'the judging session cannot then use its own judgement to retire the entry');
    const r1WithJudgement = archiveTool.explainTarget(target('R1'), { ...deps, sessionId: 'session-other' }).score;
    equal(r1WithJudgement.families, ['judged', 'mechanical'], 'an independent judgement supplies the second family');
    equal(r1WithJudgement.decision, 'cool', 'mechanical evidence plus an independent judgement reaches the cooling threshold');
    retire('R1', { sessionId: 'session-other' });
    equal(overlayEvents().at(-1).reasonCode, 'settled', 'a completed entry is retired as settled, not as unadjudicable');
    ledgerUnchanged('the ledger is untouched by the judgement path too');

    // ---- unadjudicable is its own reason code ---------------------------
    const r6Score = archiveTool.explainTarget(target('R6'), deps).score;
    equal(r6Score.sufficientSignal, 'M3', 'no verbatim, no gates and unclassified provenance is mechanically sufficient');
    equal(r6Score.reasonCode, 'unadjudicable', 'and it is never labelled settled: nobody can tell what was asked');

    // ---- every veto blocks independently --------------------------------
    for (const [id, veto, why] of [
      ['R7', 'V2', 'a later entry restating it means it is recurring, not finished'],
      ['R9', 'V1', 'a grant clause never cools'],
      ['R10', 'V3', 'an id cited by STANDING-ORDERS.md is live precedent'],
      ['R12', 'V5', 'gates attested not to cover the verbatim cannot retire it']
    ]) {
      const score = archiveTool.explainTarget(target(id), deps).score;
      equal(score.vetoes.map(item => item.id), [veto], `${id}: ${why}`);
      equal(score.decision, 'veto', `${id} is refused at any point count`);
      throws(() => retire(id), 'LEDGER_ARCHIVE_VETOED', `${id} cannot be retired while ${veto} holds`);
    }
    equal(archiveTool.explainTarget(target('R11'), deps).score.vetoes.map(item => item.id), ['V4'], 'blocked-external with no recorded clearing is vetoed');
    ok(!archiveTool.explainTarget(target('R8'), deps).score.vetoes.some(item => item.id === 'V2'), 'recurrence pins the earlier entry, not the later restatement');

    // ---- the editorial-banner false positive stays fixed -----------------
    const bannerRoot = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'ledger-archive-banner-'));
    const bannerLedger = path.join(bannerRoot, 'OWNER-REQUEST-LEDGER.json');
    const banner = '[RECOVERED by the R1239 audit lanes from session transcripts; never captured at utterance time]';
    fs.writeFileSync(bannerLedger, JSON.stringify({ schemaVersion: 1, revision: 1, requests: [
      request('R100', 'done', [metGate('done', 'node tests/smoke.js exit 0')], { verbatim: `${banner} first unrelated instruction` }),
      request('R101', 'open', undefined, { verbatim: `${banner} second unrelated instruction` })
    ] }, null, 2), 'utf8');
    const bannerDeps = { ...deps, ledgerFile: bannerLedger, overlayFile: path.join(bannerRoot, 'events.jsonl'), scopeStoreFile: path.join(bannerRoot, 'missing.json') };
    equal(archiveTool.explainTarget(target('R100'), bannerDeps).score.vetoes.map(item => item.id), [], 'a shared editorial banner is not the owner restating himself');
    fs.rmSync(bannerRoot, { recursive: true, force: true });

    // ---- the owner-gated confirm protocol is unchanged -------------------
    throws(() => archiveTool.archiveLedger({ operation: 'archive', dryRun: false, target: target('R6'), retiredBy: 'coordinator-sol' }, deps), 'LEDGER_ARCHIVE_CONFIRMATION_REQUIRED', 'retirement without a preview hash is refused');
    const stale = preview().planSha256;
    archiveTool.archiveLedger({ operation: 'archive', dryRun: false, expectedPlanSha256: stale, target: target('R6'), retiredBy: 'coordinator-sol' }, deps);
    throws(() => archiveTool.archiveLedger({ operation: 'archive', dryRun: false, expectedPlanSha256: stale, target: target('R5'), retiredBy: 'coordinator-sol' }, deps), 'LEDGER_ARCHIVE_PLAN_CHANGED', 'a stale preview hash refuses a second target');
    const fresh = preview();
    equal(Object.hasOwn(archiveTool, 'PROTECTED_REQUEST_IDS'), false, 'the customer runtime exports no historical protected-id list');
    throws(() => archiveTool.archiveLedger({ operation: 'archive', dryRun: false, expectedPlanSha256: fresh.planSha256, target: { targetKind: 'request', requestId: 'R5', ids: ['R5', 'R44'] }, retiredBy: 'coordinator-sol' }, deps), 'LEDGER_ARCHIVE_INPUT_INVALID', 'bulk-shaped confirmation input is refused');
    throws(() => archiveTool.archiveLedger({ operation: 'archive', dryRun: false, expectedPlanSha256: fresh.planSha256, target: target('R5'), retiredBy: 'Attacker Name' }, deps), 'LEDGER_ARCHIVE_TRUSTED_ACTOR_REQUIRED', 'an untrusted actor id is refused');
    ledgerUnchanged('every refusal path leaves the ledger byte-identical');

    // ---- a single clause retires without touching its request -----------
    const clausePreview = preview();
    const clauseTarget = target('R5', 'fixture.partial-clause');
    const clauseMoved = archiveTool.archiveLedger({ operation: 'archive', dryRun: false, expectedPlanSha256: clausePreview.planSha256, target: clauseTarget, retiredBy: 'coordinator-sol' }, deps);
    equal(clauseMoved.appliedTarget, clauseTarget, 'a ruleKey target is retired independently');
    equal(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).requests.some(item => item.id === 'R5'), true, 'clause retirement leaves request/verbatim live');
    equal(archiveTool.explainTarget(target('R5'), deps).disposition, 'active', 'retiring one clause does not retire its request');
    throws(() => archiveTool.archiveLedger({ operation: 'archive', dryRun: false, expectedPlanSha256: preview().planSha256, target: target('R5', 'fixture.not-a-rule'), retiredBy: 'coordinator-sol' }, deps), 'LEDGER_ARCHIVE_TARGET_INELIGIBLE', 'a clause absent from the reconciled corpus cannot be retired');

    // ---- restore is enumerated and reversible ---------------------------
    const restorePreview = archiveTool.archiveLedger({ operation: 'restore', dryRun: true }, deps);
    equal(restorePreview.restorables, [target('R1'), target('R6'), clauseTarget], 'restore enumerates every reversible target, requests and clauses alike');
    archiveTool.archiveLedger({ operation: 'restore', dryRun: false, expectedPlanSha256: restorePreview.planSha256, target: clauseTarget, retiredBy: 'coordinator-sol', why: 'the clause is still live' }, deps);
    equal(archiveTool.archiveLedger({ operation: 'restore', dryRun: true }, deps).restorables, [target('R1'), target('R6')], 'restoring removes only its own target');
    throws(() => archiveTool.archiveLedger({ operation: 'restore', dryRun: false, expectedPlanSha256: preview().planSha256, target: target('R2'), retiredBy: 'coordinator-sol' }, deps), 'LEDGER_ARCHIVE_NOT_RETIRED', 'restoring something that was never retired is refused');
    ledgerUnchanged('restore leaves the ledger byte-identical');

    // ---- the overlay is append-only and tamper-evident -------------------
    const beforeTamper = fs.readFileSync(overlayFile, 'utf8');
    const lines = beforeTamper.split('\n').filter(line => line.trim());
    const forged = JSON.parse(lines[0]); forged.detail = 'a reason he never gave';
    fs.writeFileSync(overlayFile, [JSON.stringify(forged), ...lines.slice(1)].join('\n') + '\n', 'utf8');
    throws(() => archiveTool.readDispositions(deps), 'LEDGER_ARCHIVE_OVERLAY_CHAIN_BROKEN', 'editing a past disposition in place is detected, not accepted');
    fs.writeFileSync(overlayFile, beforeTamper, 'utf8');
    equal(archiveTool.readOverlay(overlayFile).events.length, lines.length, 'the untampered chain verifies end to end');

    // ---- a pre-overlay deletion is refused loudly, never ignored ---------
    fs.writeFileSync(archiveFile, JSON.stringify({ ...archiveTool.emptyArchive(), requests: [request('R900', 'done')], retirements: [{ targetKind: 'request', requestId: 'R900', retiredAt: '2026-08-06T12:00:00.000Z', retiredBy: 'coordinator-sol', reason: { code: 'completed', detail: 'historical fixture retirement', supersedingRequestIds: [] } }] }, null, 2), 'utf8');
    throws(() => preview(), 'LEDGER_ARCHIVE_LEGACY_PAYLOAD_PRESENT', 'a request the old delete path removed from the ledger stops the tool until a human repairs it');
    fs.rmSync(archiveFile);

    // ---- the CLI reaches the reversal path without the bridge -----------
    const out = []; const err = [];
    const stdout = { write: line => out.push(line) }; const stderr = { write: line => err.push(line) };
    await archiveTool.main(['explain', 'R6'], { stdout, stderr, archiveDependencies: deps });
    ok(out.join('').includes('M3'), 'explain prints the signal that scored the target');
    ok(out.join('').includes('unadjudicable'), 'explain prints the reason code');
    out.length = 0;
    await archiveTool.main(['contest', 'R6', '--why', 'this one is adjudicable after all', '--actor', 'any-lane'], { stdout, stderr, archiveDependencies: deps });
    equal(archiveTool.explainTarget(target('R6'), deps).disposition, 'active', 'one CLI contest, by anybody, is the whole reversal');
    equal(archiveTool.parseArgs(['--dry-run']).command, 'preview', '--dry-run still means preview');
    equal(archiveTool.parseArgs(['observe', 'R7', '--session', 'abc']), { command: 'observe', requestId: 'R7', ruleKey: null, sessionId: 'abc', actor: null, why: null, quote: null, help: false }, 'the CLI parses the exposure command');
    throws(() => archiveTool.parseArgs(['--nope']), 'LEDGER_ARCHIVE_ARGUMENT_INVALID', 'unknown arguments are refused');

    // ---- the whole owner-gated path, end to end, on the real core -------
    // The old tool was never run in anger. This drives the real mission-bridge
    // preview/confirm protocol into the real commit path and checks that the
    // owner's file survives it.
    const { createMissionActions } = require('../src/lib/mission-bridge/actions');
    const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
    const bridgeOrg = declaredOrg();
    const bridgeActor = enabledControllerId(bridgeOrg);
    const auditEvents = [];
    const actions = createMissionActions({
      roots: { primary: root },
      actor: bridgeActor,
      agentOrg: bridgeOrg,
      audit: { requireRecord(action, auditTarget, details) { auditEvents.push({ action, target: auditTarget, details }); return { durable: true, anchored: true, sequence: auditEvents.length, eventHash: crypto.createHash('sha256').update(action).digest('hex') }; } },
      policy: { assertActive() {} },
      archiveLedger: input => archiveTool.archiveLedger(input, deps)
    });
    const bridgePreview = await actions.ledgerArchive({ operation: 'archive', dryRun: true, target: target('R5') });
    equal(bridgePreview.receipt.candidates.some(item => item.requestId === 'R5'), false, 'R5 is not a candidate, so the bridge will not admit it');
    const bridgeTarget = target('R3');
    await actions.ledgerArchive({ operation: 'archive', dryRun: true, target: bridgeTarget });
    const bridgeMoved = await actions.ledgerArchive({ operation: 'archive', dryRun: false, target: bridgeTarget });
    equal(bridgeMoved.receipt.appliedTarget, bridgeTarget, 'the owner-gated bridge path retires one exact target');
    equal(bridgeMoved.receipt.changedCount, 1, 'and reports exactly one change');
    equal(auditEvents.at(-1).action, 'owner.request.ledger.archive', 'the retirement is durably audited exactly as before');
    equal(archiveTool.explainTarget(bridgeTarget, deps).disposition, 'cooling', 'the bridge path lands in COOLING');
    ledgerUnchanged('the full mission-bridge retirement leaves the owner ledger byte-identical');

    // COLD must be reachable through the same owner-gated path, not only from
    // a module call: a cooling target therefore stays on the candidate list.
    for (const session of ['bridge-one', 'bridge-two', 'bridge-three']) {
      archiveTool.archiveLedger({ operation: 'observe', dryRun: false, target: bridgeTarget, actor: 'lane-a', sessionId: session }, deps);
    }
    await actions.ledgerArchive({ operation: 'archive', dryRun: true, target: bridgeTarget });
    await actions.ledgerArchive({ operation: 'archive', dryRun: false, target: bridgeTarget });
    equal(archiveTool.explainTarget(bridgeTarget, deps).disposition, 'cold', 'the whole lifecycle, cooling and cold, is reachable through the owner-gated bridge');
    throws(() => archiveTool.archiveLedger({ operation: 'archive', dryRun: false, expectedPlanSha256: preview().planSha256, target: target('R999'), retiredBy: 'coordinator-sol' }, deps), 'LEDGER_ARCHIVE_TARGET_INELIGIBLE', 'an id that is not in the ledger is a typo, not an unadjudicable entry');
    ledgerUnchanged('going cold through the bridge leaves the owner ledger byte-identical');

    ledgerUnchanged('FINAL: after every operation in this suite the owner ledger is byte-identical');
    process.stdout.write(`ledger-archive: ${checks} checks passed in ${Date.now() - started} ms\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// The owner-request ledger now also carries T (task), A (ask) and P
// (purchase) records in the same requests[] array. This tool was built for
// R (rule/request) retirement only: it must never refuse the whole document
// because a T/A/P row exists, and it must never treat a T/A/P row as an
// archive candidate -- candidate selection stays R-only in this build, a
// named limitation (see the report), not a silent one.
async function testForeignKinds() {
  const before = checks;
  const root = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'ledger-archive-foreign-kind-test-'));
  const ledgerFile = path.join(root, 'OWNER-REQUEST-LEDGER.json');
  const archiveFile = path.join(root, 'OWNER-REQUEST-LEDGER-ARCHIVE.json');
  const scopeStoreFile = path.join(root, 'owner-request-scope-rules.json');
  const overlayFile = path.join(root, 'state', 'owner-request-disposition-events.jsonl');
  try {
    // R1: done + gates met -> appears in plan.candidates (candidateFor only
    // checks status/gates), but M1 alone is not sufficient to actually
    // retire it -- that insufficiency is not what this test is about.
    const r1 = request('R1', 'done', [metGate('verified', 'node tests/smoke.js exit 0')]);
    // R2: shaped like the main fixture's R6 -- no verbatim, no gates,
    // provenance unclassified -> M3, sufficient on its own, so one archive
    // call retires it directly without needing a second signal family.
    const r2 = { id: 'R2', request: '', verbatim: '', status: 'open' };
    // T1 is ALSO 'done', exactly like R1 -- candidateFor's own status check
    // cannot tell R1 and T1 apart. If it ever ran on T1, T1 would appear in
    // plan.candidates beside R1.
    const t1 = { id: 'T1', kind: 'T', status: 'done', recurrence: null, completedAt: '2026-08-07T00:00:00.000Z', completedBy: 'codex' };
    const a1 = { id: 'A1', kind: 'A', status: 'open', answer: null };
    const p1 = { id: 'P1', kind: 'P', status: 'proposed', purchase: { requestId: null, lines: [], decision: null, recordedCharge: null } };
    const mixedLedger = { schemaVersion: 1, revision: 3, updatedAt: '2026-09-06', requests: [r1, r2, t1, a1, p1] };
    fs.writeFileSync(ledgerFile, JSON.stringify(mixedLedger, null, 2), 'utf8');
    const MIXED_SHA = sha256File(ledgerFile);
    const deps = { ledgerFile, archiveFile, scopeStoreFile, overlayFile, precedentFiles: [], clock: () => Date.parse('2026-09-06T00:00:00.000Z') };

    const plan = archiveTool.archiveLedger({ operation: 'archive', dryRun: true }, deps);
    checks += 1; assert.deepEqual(plan.candidates.map(item => item.requestId), ['R1'],
      'T1 is done too, but a T record must never become an archive candidate: candidate selection stays R-only');
    checks += 1; assert.equal(plan.activeCount, 2,
      'activeCount is the R-only active set this tool manages (R1, R2), not every row in the file');
    checks += 1; assert.equal(sha256File(ledgerFile), MIXED_SHA, 'a preview over a mixed-kind ledger never touches the file, and does not refuse the document because T/A/P rows exist');

    // Retiring R2 (sufficient on its own, via the score path rather than the
    // planner's candidate list) works exactly as it does with an R-only
    // ledger, proving the T/A/P rows are inert to this tool rather than
    // merely untested.
    const retired = archiveTool.archiveLedger({ operation: 'archive', dryRun: false, expectedPlanSha256: plan.planSha256, target: target('R2'), retiredBy: 'coordinator-sol' }, deps);
    checks += 1; assert.equal(retired.appliedTarget.requestId, 'R2');
    checks += 1; assert.equal(sha256File(ledgerFile), MIXED_SHA, 'retirement in the presence of T/A/P rows still never rewrites the ledger');

    process.stdout.write(`ledger-archive foreign-kind rows: ${checks - before} checks passed\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

main().then(testForeignKinds)
  .catch(error => { process.stderr.write(`${error?.code || 'ERROR'}: ${error.stack || error}\n`); process.exitCode = 1; });
