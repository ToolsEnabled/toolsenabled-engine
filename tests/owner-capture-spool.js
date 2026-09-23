// EXECUTABLE CHANGE
//
// CAN-FAIL REPORT (testcanfail-tests-owner-capture-spool-js)
//
// Strengthened assertions and observed mutations:
// - The R7001, R7003, and R7004 capture failures now require the documented
//   exit status 1 rather than accepting every non-zero launcher/tool failure.
//   Mutation: made owner-capture's final handler return 2 for each target in
//   turn. RED: "a capture that did not reach the ledger must use the capture
//   failure status"; "a broken ledger must use the capture failure status";
//   "an agent-authored brief must use the capture refusal status".
// - The fleet test now consumes all ten child statuses, requires ten results,
//   and rejects signal/null/foreign exits. Mutation: after durably completing
//   each R80xx capture, sent SIGTERM to that capture process. RED: "every
//   concurrent capture must finish normally with success or the documented
//   contention failure".
// - The fleet drain's previously ignored result now must exit 0. Mutation:
//   made a successful reconcile of a fleet ledger exit 2 after doing its work.
//   RED: "the ten-lane spool drain must succeed".
//
// Shape census:
// - EMPTY LOOP/FOREACH: NOT-FOUND. The sole assertion loop has a literal total
//   of ten; the new result-count assertion independently pins that precondition.
// - EXIT STATUS WITHOUT SUBJECT OUTPUT: fixed above. The status checks are also
//   coupled to spool, ledger, and diagnostic observations made by the subject.
// - SWALLOWED FAILURE (try/catch or optional chain): NOT-FOUND. The two catches
//   in holdLock are cleanup-only and cannot swallow an assertion or test action.
// - MOCK OF SUBJECT: NOT-FOUND. Captures and reconciles are real child processes
//   and all ledger/spool observations use real temporary files.
// - SKIP/PRECONDITION NO-OP: NOT-FOUND. The file has no skip or platform guard.
// - EXPECTED VALUE FROM SUBJECT CODE: NOT-FOUND. Expected ids, words, statuses,
//   counts, and paths are independently constructed by the test.
//
// Restoration/preconditions: no precondition was unmet. After every mutation,
// the product file was restored byte-for-byte (SHA-256 matched its saved copy).
// The restored run was GREEN: "Owner-capture spool tests passed (39 checks;
// every ledger touched was a temp copy, and a contended, broken or
// ten-way-contended capture lost zero of the owner's words)."
'use strict';

// THE OWNER'S WORDS SURVIVE A CONTENDED, CRASHING, TEN-LANE LEDGER.
//
// These tests assert BEHAVIOUR -- they run the real tools as real processes
// against real temp ledgers and then look at what is on disk. None of them
// assert on source text, because the failure being fixed was not a missing line
// of code: owner-capture.js already had an atomic write, a backup and a lock,
// and STILL lost a directive on 2026-08-11, because the one thing it did on
// contention was refuse and exit with the words only in its argv.
//
// Every ledger touched here is a temp copy. Nothing writes to the real one.

const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CAPTURE = path.join(ROOT, 'tools', 'owner-capture.js');
const RECONCILE = path.join(ROOT, 'tools', 'owner-capture-reconcile.js');
const spool = require('../src/lib/owner-capture-spool');

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function workspace(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `owner-capture-spool-${name}-`));
  const ledger = path.join(directory, 'LEDGER.json');
  fs.writeFileSync(ledger, JSON.stringify({ revision: 1, updatedAt: '2026-08-11', requests: [] }, null, 2));
  return { directory, ledger };
}

function runCapture(ledger, extra) {
  return spawnSync(process.execPath, [CAPTURE, '--ledger', ledger, ...extra], { encoding: 'utf8' });
}

function runReconcile(ledger, extra = []) {
  return spawnSync(process.execPath, [RECONCILE, '--ledger', ledger, ...extra], { encoding: 'utf8' });
}

function ledgerEntry(ledger, id) {
  const data = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  return data.requests.find((entry) => entry.id === id) || null;
}

// A lock held by a genuinely live OS process. A fabricated pid is reclaimed as
// stale by design, so a test that invented one would prove nothing.
function holdLock(ledger) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  fs.writeFileSync(`${ledger}.lock`, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
  return {
    release: () => {
      try { child.kill(); } catch { /* already gone */ }
      try { fs.unlinkSync(`${ledger}.lock`); } catch { /* already gone */ }
    }
  };
}

// 1. THE ORIGINAL LOSS. Contended ledger: the capture must refuse, and the words
//    must still exist on disk afterwards.
function contendedCaptureKeepsTheWords() {
  const { ledger } = workspace('contended');
  const held = holdLock(ledger);
  try {
    const words = 'DO THE TRADEMARK FILING, I already told you this';
    const result = runCapture(ledger, [
      '--new-id', 'R7001', '--interpretation', 'file the trademark', '--actor', 'coordinator', '--text', words
    ]);

    check(result.status === 1, 'a capture that did not reach the ledger must use the capture failure status');
    check(/NOT IN THE LEDGER/.test(result.stderr), 'the failure must say the words are not in the ledger');
    check(/owner-capture-reconcile/.test(result.stderr), 'the failure must name the recovery command');
    check(ledgerEntry(ledger, 'R7001') === null, 'the contended ledger must be untouched');

    const pending = spool.listPending(ledger);
    check(pending.length === 1, 'the words must be spooled exactly once');
    check(pending[0].text === words, 'the spooled text must be the owner\'s words, byte for byte');
    check(pending[0].id === 'R7001' && pending[0].mode === 'new', 'the spool must carry enough to replay the capture');
    // The path printed to the operator has to be the path that actually holds
    // the words, or the loud failure is a loud lie.
    check(result.stderr.includes(pending[0].name), 'the failure must name the file that holds the words');
  } finally {
    held.release();
  }
}

// 2. THE RECOVERY. --check is red while a directive is outstanding, and the
//    drain puts the exact words in the ledger.
function reconcileReplaysTheDirective() {
  const { ledger } = workspace('reconcile');
  const words = 'And again who put a $100 day cap? Literally not something I did';
  const held = holdLock(ledger);
  try {
    runCapture(ledger, ['--new-id', 'R7002', '--interpretation', 'no agent-set caps', '--actor', 'coordinator', '--text', words]);
  } finally {
    held.release();
  }

  const red = runReconcile(ledger, ['--check']);
  check(red.status === 1, '--check must FAIL while an owner directive is outstanding');
  check(red.stdout.includes(words), '--check must show the owner his actual words, not just a count');

  const drained = runReconcile(ledger);
  check(drained.status === 0, 'the drain must succeed once the ledger is free');

  const entry = ledgerEntry(ledger, 'R7002');
  check(entry !== null, 'the replayed directive must be in the ledger');
  check(entry.verbatim === words, 'the replayed verbatim must be unchanged by the round trip');
  check(entry.status === 'open', 'a replayed capture is still open; capture is not verification');

  check(spool.listPending(ledger).length === 0, 'nothing may remain pending after a clean drain');
  const kept = fs.readdirSync(spool.reconciledDirectory(ledger));
  check(kept.length === 1, 'the reconciled record must be KEPT, not deleted -- losing work is the defect');
  const green = runReconcile(ledger, ['--check']);
  check(green.status === 0, '--check must be green once nothing is outstanding');
}

// 3. A FAILURE AFTER THE LOCK IS TAKEN. This is the killed-process case in
//    observable form: the words must already be durable by the time the ledger
//    transaction begins, so a mid-transaction death cannot take them.
function midTransactionFailureKeepsTheWords() {
  const { ledger } = workspace('midtx');
  fs.writeFileSync(ledger, JSON.stringify({ revision: 1, notRequests: [] }, null, 2));
  const words = 'this must survive a ledger that blows up after the lock is taken';
  const result = runCapture(ledger, [
    '--new-id', 'R7003', '--interpretation', 'mid-transaction failure', '--actor', 'coordinator', '--text', words
  ]);
  check(result.status === 1, 'a broken ledger must use the capture failure status');
  const pending = spool.listPending(ledger);
  check(pending.length === 1 && pending[0].text === words, 'the words must be durable before the ledger transaction starts');
  check(pending[0].lastAttemptError && /SHAPE/.test(String(pending[0].lastAttemptError.code)), 'the pending record must record why it is stuck');
}

// 4. THE FLEET CASE. Ten lanes capturing at once against one ledger must lose
//    ZERO words. This is the claim that matters for the product: more agents
//    must not mean more lost input.
function tenConcurrentLanesLoseNothing() {
  const { ledger } = workspace('fleet');
  const total = 10;
  const words = (index) => `concurrent directive ${index} that must not be lost`;

  const children = [];
  for (let index = 0; index < total; index += 1) {
    children.push(new Promise((resolve) => {
      const child = spawn(process.execPath, [
        CAPTURE, '--ledger', ledger, '--new-id', `R80${String(index).padStart(2, '0')}`,
        '--interpretation', `concurrent ${index}`, '--actor', 'coordinator', '--text', words(index)
      ], { stdio: 'ignore' });
      child.on('close', (code) => resolve(code));
    }));
  }

  return Promise.all(children).then((statuses) => {
    check(statuses.length === total, 'all ten capture processes must report an exit status');
    check(statuses.every((status) => status === 0 || status === 1),
      'every concurrent capture must finish normally with success or the documented contention failure');
    const reconciled = runReconcile(ledger);
    check(reconciled.status === 0, 'the ten-lane spool drain must succeed');
    const data = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    const inLedger = new Set(data.requests.map((entry) => entry.verbatim));
    for (let index = 0; index < total; index += 1) {
      check(inLedger.has(words(index)), `directive ${index} must survive ten-way contention and reach the ledger`);
    }
    check(spool.listPending(ledger).length === 0, 'no capture may be left outstanding after the drain');
  });
}

// 5. THE SAFETY NET IS NOT A BACKDOOR. An actor refused as an agent-authored
//    brief must not get a durable slot in the owner's queue by way of the spool.
function refusedAgentTextIsNotSpooled() {
  const { ledger } = workspace('refused');
  const result = runCapture(ledger, [
    '--new-id', 'R7004', '--interpretation', 'a build lane brief', '--actor', 'build-lane-s10',
    '--text', 'an agent-authored brief wearing the owner\'s name'
  ]);
  check(result.status === 1, 'an agent-authored brief must use the capture refusal status');
  check(/OWNER_CAPTURE_AGENT_TEXT_REFUSED/.test(result.stderr), 'it must be refused for the right reason');
  check(spool.listPending(ledger).length === 0, 'a refused actor must NOT reach the durable owner queue');
}

// 6. The spool belongs to the ledger it protects, so a --ledger override can
//    never queue words against a file they were not meant for.
function spoolFollowsItsLedger() {
  const a = workspace('iso-a');
  const b = workspace('iso-b');
  const held = holdLock(a.ledger);
  try {
    runCapture(a.ledger, ['--new-id', 'R7005', '--interpretation', 'isolation', '--actor', 'coordinator', '--text', 'belongs to ledger A']);
  } finally {
    held.release();
  }
  check(spool.listPending(a.ledger).length === 1, 'the words must queue against the ledger they targeted');
  check(spool.listPending(b.ledger).length === 0, 'an unrelated ledger must not inherit another ledger\'s queue');
}

function expectSpoolRefusal(code, action) {
  let thrown = null;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  check(thrown instanceof spool.OwnerCaptureSpoolError, `${code} must throw the spool's public error type`);
  check(thrown && thrown.code === code, `${code} must be the refusal code returned to the caller`);
}

// 7. Refusals are executable contracts, not merely strings in the module. Each
//    case below drives the public API into the refusal and pins the no-write
//    behavior that makes validation safe for callers.
function directlyDrivenSpoolRefusals() {
  const target = workspace('refusal-target');
  const targetEntriesBefore = fs.readdirSync(target.directory);
  expectSpoolRefusal('OWNER_CAPTURE_SPOOL_TARGET_INVALID', () => spool.spoolDirectory('   '));
  check(JSON.stringify(fs.readdirSync(target.directory)) === JSON.stringify(targetEntriesBefore),
    'an invalid target must not write anything while refusing');

  const empty = workspace('refusal-empty');
  expectSpoolRefusal('OWNER_CAPTURE_SPOOL_EMPTY', () => spool.writeAhead(empty.ledger, {
    mode: 'new', id: 'R-refusal-empty', text: ' \t\n', actor: 'coordinator'
  }));
  check(!fs.existsSync(spool.spoolDirectory(empty.ledger)),
    'an empty capture must refuse before creating a spool directory or record');

  const discarded = workspace('refusal-discard');
  const handle = spool.writeAhead(discarded.ledger, {
    mode: 'new', id: 'R-refusal-discard', text: 'words that must remain pending', actor: 'coordinator'
  });
  const pendingBefore = fs.readFileSync(handle.file, 'utf8');
  expectSpoolRefusal('OWNER_CAPTURE_SPOOL_DISCARD_REASON_REQUIRED', () => spool.markDiscarded(handle, { reason: '  ' }));
  check(fs.readFileSync(handle.file, 'utf8') === pendingBefore,
    'a reasonless discard must leave the pending record byte-for-byte unchanged');
  check(!fs.existsSync(spool.reconciledDirectory(discarded.ledger)),
    'a reasonless discard must not write a reconciled record');

  const invalid = workspace('refusal-record');
  const pendingDirectory = spool.pendingDirectory(invalid.ledger);
  fs.mkdirSync(pendingDirectory, { recursive: true });
  const invalidFile = path.join(pendingDirectory, 'invalid.json');
  const invalidBytes = '["not", "a", "record"]\n';
  fs.writeFileSync(invalidFile, invalidBytes);
  expectSpoolRefusal('OWNER_CAPTURE_SPOOL_RECORD_INVALID', () => spool.listPending(invalid.ledger));
  check(fs.readFileSync(invalidFile, 'utf8') === invalidBytes,
    'listing an invalid record must not rewrite or remove the rejected bytes');
  check(fs.readdirSync(pendingDirectory).length === 1,
    'listing an invalid record must not create any additional files');
}

// 8. AN AGENT'S SILENCE IS NOT THE PERSON'S VERDICT.
//
//    Measured 2026-09-03 on the owner's live spool: 228 of 231 settled records
//    read ledgerOutcome 'discarded' with the reason "agent read it and filed
//    nothing" and an agent's name, while the canonical ledger held one request.
//    Those bytes were kept and out of listPending, so the review tool and the
//    reconciler -- the only ways back -- could no longer reach a single one.
//
//    Driven through the public API against real files: a discard nobody
//    person-signed must refuse and leave the words exactly where they were, a
//    turn that filed nothing must stay in the queue carrying that note, and the
//    person's own discard must still settle.
function anAgentsSilenceCannotDiscardTheOwnersWords() {
  const w = workspace('unfiled');
  const words = 'the words a person typed that an agent then read and did nothing about';
  const handle = spool.writeAhead(w.ledger, { mode: 'ingress', id: null, text: words, actor: 'claude' });
  const spooledBytes = fs.readFileSync(handle.file, 'utf8');

  expectSpoolRefusal('OWNER_CAPTURE_SPOOL_DISCARD_NOT_A_PERSON',
    () => spool.markDiscarded(handle, { reason: 'agent read it and filed nothing', actor: 'claude' }));
  check(fs.readFileSync(handle.file, 'utf8') === spooledBytes,
    'a refused discard must leave the pending record byte-for-byte unchanged');
  check(!fs.existsSync(spool.reconciledDirectory(w.ledger)),
    'a refused discard must not write a reconciled record');
  check(spool.listPending(w.ledger).length === 1,
    'a refused discard must leave the words in the queue that can still reach them');

  let refusal = null;
  try { spool.markDiscarded(handle, { reason: 'agent read it and filed nothing', actor: 'claude' }); }
  catch (error) { refusal = error; }
  check(refusal && refusal.message.includes('markUnfiled'),
    'the refusal must name the call that keeps an unfiled turn, not merely say no');

  expectSpoolRefusal('OWNER_CAPTURE_SPOOL_UNFILED_REASON_REQUIRED', () => spool.markUnfiled(handle, { reason: ' ' }));
  check(fs.readFileSync(handle.file, 'utf8') === spooledBytes,
    'a reasonless unfiled note must leave the pending record byte-for-byte unchanged');

  const marked = spool.markUnfiled(handle, { reason: 'agent read it and filed nothing', actor: 'claude' });
  check(marked.marked === true, 'the unfiled note must report that it reached the disk');
  const stillPending = spool.listPending(w.ledger);
  check(stillPending.length === 1, 'a turn that filed nothing must stay in the pending queue');
  check(stillPending[0].name === handle.name, 'it must be the same record, annotated where it stands');
  check(stillPending[0].text === words, 'the words must be untouched by the note');
  check(stillPending[0].ledgerOutcome === 'unfiled', 'the record must say a turn ended over it with nothing filed');
  check(stillPending[0].unfiledBy === 'claude', 'the record must name who was reading when nothing was filed');
  check(typeof stillPending[0].unfiledAt === 'string' && stillPending[0].unfiledAt.length > 0,
    'the record must say when the turn ended over it');
  check(!fs.existsSync(spool.reconciledDirectory(w.ledger)),
    'an unfiled turn must not be settled into reconciled/');

  // The person's own hand still settles it, and settling still keeps the bytes.
  const settled = spool.markDiscarded(
    { name: handle.name, file: handle.file, record: stillPending[0] },
    { reason: 'I did not mean that as a rule', actor: 'owner-spool-review', decidedBy: spool.DISCARD_DECIDED_BY }
  );
  check(spool.listPending(w.ledger).length === 0, 'the person\'s discard must still leave the pending queue');
  const kept = JSON.parse(fs.readFileSync(settled.file, 'utf8'));
  check(kept.ledgerOutcome === 'discarded', 'the person\'s discard must be recorded as the classification it is');
  check(kept.text === words, 'a discard must keep the bytes it always kept');
  check(kept.discardReason === 'I did not mean that as a rule', 'the person\'s reason must be retained');
}

// Simulates a record already reconciled by the bug section 8 closed: a
// markDiscarded call made before decidedBy was required and persisted. The
// current markDiscarded cannot produce this shape any more (it refuses
// without decidedBy, and now writes it when it has it) -- that gap between
// "cannot happen going forward" and "already happened 228 times" is exactly
// the defect this section covers, so it is written straight to disk rather
// than produced by calling the guarded function.
function simulateMisdiscardedRecord(ledger, { name, text, actor = 'claude', now = new Date() }) {
  const directory = spool.reconciledDirectory(ledger);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  const record = {
    version: 1,
    name,
    spooledAt: now.toISOString(),
    spooledByPid: process.pid,
    ledgerFile: path.resolve(ledger),
    mode: 'ingress',
    id: null,
    text,
    interpretation: null,
    actor,
    source: 'product/sendTurn',
    gates: [],
    status: 'unclassified',
    scope: 'session',
    threadId: 'fixture-thread',
    provenanceClass: 'owner-ingress',
    proposal: null,
    ledgerOutcome: 'discarded',
    discardedAt: now.toISOString(),
    discardedBy: actor,
    discardReason: 'agent read it and filed nothing'
    // Deliberately no decidedBy: this is the exact pre-guard shape measured
    // live, not a hypothetical one.
  };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return { file, name, record };
}

// 9. A DISCARD FROM BEFORE THE GUARD IS NOT A SETTLEMENT EITHER.
//
//    MEASURED 2026-09-03 on the owner's live spool: 228 records already sit in
//    reconciled/ in exactly the shape section 8's guard now refuses to create
//    -- ledgerOutcome 'discarded', an agent's name, no decidedBy. The guard
//    stops new ones; by itself it does nothing for the ones already on disk,
//    so those 228 stayed exactly as unreachable as before the guard existed --
//    a live `owner-spool-review.js --json` run answers "clean" for the very
//    turns this section exists to find.
function preGuardDiscardsAreRecoveredNotResurrectedForRealDeclines() {
  const w = workspace('misdiscarded');

  const stuck = simulateMisdiscardedRecord(w.ledger, {
    name: 'stuck-turn.json',
    text: 'this account is supposed to be separate -- an example of words that went missing'
  });
  check(spool.isMisdiscarded(stuck.record) === true, 'a discard with no decidedBy must read as misdiscarded');
  check(spool.listMisdiscarded(w.ledger).length === 1, 'listMisdiscarded must find the stuck record');
  check(spool.listPending(w.ledger).length === 0, 'the stuck record must not already be pending');

  const recovered = spool.recoverMisdiscarded(w.ledger);
  check(recovered.length === 1, 'recoverMisdiscarded must report the one record it moved');
  check(!fs.existsSync(stuck.file), 'the misdiscarded copy in reconciled/ must be gone once recovered');

  const pending = spool.listPending(w.ledger);
  check(pending.length === 1, 'the recovered record must now be in the pending queue');
  check(pending[0].name === 'stuck-turn.json', 'recovery must keep the record\'s own name');
  check(pending[0].text === stuck.record.text, 'recovery must not alter the owner\'s words by one byte');
  check(pending[0].ledgerOutcome === 'unfiled', 'a recovered record must read exactly like any other unfiled turn');
  check(pending[0].unfiledBy === 'claude', 'recovery must keep who was reading when nothing was filed');
  check(pending[0].discardedBy === 'claude' && pending[0].discardReason === 'agent read it and filed nothing',
    'recovery must keep the mistaken discard on the record, not erase what happened');
  check(typeof pending[0].recoveredAt === 'string' && pending[0].recoveredAt.length > 0,
    'recovery must say when the correction happened');

  // Idempotent: nothing is left in reconciled/ in the misdiscarded shape, so a
  // second pass -- exactly what every CLI run makes -- finds nothing to do.
  check(spool.listMisdiscarded(w.ledger).length === 0, 'a recovered record must no longer read as misdiscarded');
  const again = spool.recoverMisdiscarded(w.ledger);
  check(again.length === 0, 'a second recovery pass must move nothing new');
  check(spool.listPending(w.ledger).length === 1, 'a second pass must not duplicate the recovered record');

  // THE GUARD RAIL: a real person's decline, made through the current, guarded
  // markDiscarded, must never be treated as the bug's residue and put back in
  // front of anyone as though it were still open.
  const declined = spool.writeAhead(w.ledger, {
    mode: 'ingress', id: null, text: 'a turn the person genuinely declined', actor: 'claude'
  });
  const settled = spool.markDiscarded(declined, {
    reason: 'the person pressed Decline', actor: 'person', decidedBy: spool.DISCARD_DECIDED_BY
  });
  const settledRecord = JSON.parse(fs.readFileSync(settled.file, 'utf8'));
  check(settledRecord.decidedBy === spool.DISCARD_DECIDED_BY, 'a real discard must persist proof a person decided it');
  check(spool.isMisdiscarded(settledRecord) === false, 'a person\'s own discard must never read as misdiscarded');
  check(spool.listMisdiscarded(w.ledger).length === 0, 'a person\'s real decline must not be found by listMisdiscarded');

  const recoveredAgain = spool.recoverMisdiscarded(w.ledger);
  check(recoveredAgain.length === 0, 'recovery must not touch a real, person-decided discard');
  check(fs.existsSync(settled.file), 'a real discard must remain exactly where it was settled');
  check(spool.listPending(w.ledger).length === 1, 'recovery must not resurrect a real decline into the pending queue');
}

async function run() {
  contendedCaptureKeepsTheWords();
  reconcileReplaysTheDirective();
  midTransactionFailureKeepsTheWords();
  await tenConcurrentLanesLoseNothing();
  refusedAgentTextIsNotSpooled();
  spoolFollowsItsLedger();
  directlyDrivenSpoolRefusals();
  anAgentsSilenceCannotDiscardTheOwnersWords();
  preGuardDiscardsAreRecoveredNotResurrectedForRealDeclines();
  process.stdout.write(`Owner-capture spool tests passed (${checks} checks; every ledger touched was a temp copy, `
    + 'and a contended, broken or ten-way-contended capture lost zero of the owner\'s words).\n');
}

run().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
