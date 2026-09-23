// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-ledger-merge-js):
// - Strengthened the three bare non-zero CLI exit assertions below with the
//   tool's own diagnostic codes. Mutation: in a scratch copy of the tool,
//   replace LEDGER_MERGE_USAGE and LEDGER_MERGE_OUTPUT_REFUSED with
//   MUTATED_DIAGNOSTIC while preserving their exit statuses. RED output:
//   "AssertionError [ERR_ASSERTION]: The input did not match the regular
//   expression /LEDGER_MERGE_USAGE/. Input: 'MUTATED_DIAGNOSTIC: Usage: ...'"
//   and "AssertionError [ERR_ASSERTION]: The input did not match the regular
//   expression /LEDGER_MERGE_OUTPUT_REFUSED/. Input:
//   'MUTATED_DIAGNOSTIC: Output already exists: ...'". The source was restored
//   byte-for-byte; `node tests/ledger-merge.js` then reported
//   "ledger-merge: 20 checks passed".
// - NOT-FOUND (1): unanchored empty fixture loops. The platform-dependent real
//   data loops are guarded by explicit non-vacuity anchors when that data exists;
//   the deliberately possibly-empty divergence loop has focused fixture tests.
// - NOT-FOUND (3): try/catch or optional chaining that swallows the target failure.
// - NOT-FOUND (4): assertions against a mock of the subject under test.
// - NOT-FOUND (5): a guard that makes the whole file a no-op. Only the optional
//   real-ledger block is skipped, explicitly; the other 20 checks still execute.
// - NOT-FOUND (6): expected values computed by the implementation under test.
// - Unmet precondition: Machine A's retired LIVE ledger is not present at
//   /root/Desktop/ToolsEnabled/reports/OWNER-REQUEST-LEDGER.json, so its optional
//   cross-checks could not be mutation-tested on this host.

'use strict';

// Tests for tools/ledger-merge.js — the durable union-merge for diverged
// copies of reports/OWNER-REQUEST-LEDGER.json.
//
// Every fixture-writing test operates in a fresh temp directory under
// os.tmpdir(), never on a real ledger. The one test that reads the REAL
// ledgers (this checkout's, and Machine A's retired LIVE tree when that path
// exists) reads them strictly read-only and writes its merge output to a temp
// file only after the loss gate passes.
//
// The load-bearing test here is the REFUSAL: a merged document that would
// lose even one owner verbatim (or gate instruction) must cause the writer to
// refuse before any byte reaches disk. The merge that motivated this tool was
// done once by a throwaway script; the refusal is what makes the durable
// version trustworthy on the day the inputs are worse than today's.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { acquireLock } = require('../src/lib/agent-digest/lock');

const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'tools', 'ledger-merge.js');

const {
  LedgerMergeError,
  readLedgerDocument,
  deepEqual,
  contains,
  entrySupersedes,
  contentEquivalent,
  collectProtectedStrings,
  assertNoProtectedLoss,
  mergeLedgerDocuments,
  writeMergedDocument
} = require('../tools/ledger-merge');

const check = (label, fn) => test(label, fn);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-merge-test-'));
}

function doc(requests, extra = {}) {
  return {
    $comment: ['TEST FIXTURE — not the real ledger.'],
    schemaVersion: 1,
    revision: extra.revision === undefined ? 1 : extra.revision,
    sessionLabel: 'ledger-merge test fixture',
    updatedAt: '2020-01-01',
    maintainedBy: 'test-harness',
    statusVocabulary: { done: 'done', open: 'open' },
    requests,
    controllerNotes: extra.controllerNotes || []
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// --- structural helpers ------------------------------------------------------

check('contains: string append growth', () => {
  assert.equal(contains('abc def', 'abc'), true);
  assert.equal(contains('abc', 'abc def'), false);
});

check('contains: arrays are ordered subsequences', () => {
  assert.equal(contains([1, 2, 3], [1, 3]), true);
  assert.equal(contains([1, 2, 3], [3, 1]), false);
  assert.equal(contains([{ a: 'xy' }], [{ a: 'x' }]), true);
});

check('contains: a status flip is NOT containment', () => {
  assert.equal(contains({ status: 'done' }, { status: 'open' }), false);
});

check('entrySupersedes: append-grown entry contains the shorter one', () => {
  const short = { id: 'R1', verbatim: 'do the thing', status: 'open', evidence: 'started' };
  const long = { id: 'R1', verbatim: 'do the thing', status: 'open', evidence: 'started; then finished step 2', captureLog: ['a'] };
  assert.equal(entrySupersedes(long, short), true);
  assert.equal(entrySupersedes(short, long), false);
});

// --- union and containment merging -------------------------------------------

check('union: disjoint ids are all preserved, ours first', () => {
  const ours = doc([{ id: 'R1', verbatim: 'one', status: 'open' }]);
  const theirs = doc([{ id: 'R2', verbatim: 'two', status: 'open' }]);
  const { doc: merged, report } = mergeLedgerDocuments(ours, theirs);
  assert.deepEqual(merged.requests.map((r) => r.id), ['R1', 'R2']);
  assert.equal(report.appendedNew, 1);
  assert.equal(report.changed, true);
});

check('identical shared id collapses to one copy and does not mark change', () => {
  const entry = { id: 'R1', verbatim: 'same words', status: 'open' };
  const { doc: merged, report } = mergeLedgerDocuments(doc([clone(entry)]), doc([clone(entry)]));
  assert.equal(merged.requests.length, 1);
  assert.equal(report.identical, 1);
  assert.equal(report.changed, false);
});

check('containment: the longer side wins in either direction, id and position kept', () => {
  const short = { id: 'R1', verbatim: 'v', status: 'open', evidence: 'e' };
  const long = { id: 'R1', verbatim: 'v', status: 'open', evidence: 'e plus appended detail' };
  const a = mergeLedgerDocuments(doc([clone(short)]), doc([clone(long)]));
  assert.equal(a.doc.requests[0].evidence, 'e plus appended detail');
  assert.equal(a.report.oursSuperseded, 1);
  const b = mergeLedgerDocuments(doc([clone(long)]), doc([clone(short)]));
  assert.equal(b.doc.requests[0].evidence, 'e plus appended detail');
  assert.equal(b.report.theirsSuperseded, 1);
  assert.equal(b.report.changed, false);
});

// --- conflicts ---------------------------------------------------------------

check('conflict: both survive; theirs re-filed under the next dotted id with provenance', () => {
  const oursEntry = { id: 'R133', verbatim: 'trunk words', status: 'open' };
  const theirsEntry = { id: 'R133', verbatim: 'machine A words, entirely different', status: 'done' };
  const { doc: merged, report } = mergeLedgerDocuments(doc([clone(oursEntry)]), doc([clone(theirsEntry)]), {
    oursLabel: 'trunk', theirsLabel: 'machine-a', today: '2026-08-03'
  });
  assert.equal(merged.requests.length, 2);
  assert.deepEqual(merged.requests[0], oursEntry); // ours untouched
  const refiled = merged.requests[1];
  assert.equal(refiled.id, 'R133.1');
  assert.equal(refiled.verbatim, theirsEntry.verbatim); // owner words byte-identical
  assert.equal(refiled.status, theirsEntry.status);     // status never softened
  assert.match(refiled.mergeNote, /Re-filed from R133 on 2026-08-03/);
  assert.deepEqual(report.refiled, [{ from: 'R133', to: 'R133.1' }]);
});

check('conflict: a bare status flip keeps both versions rather than adjudicating', () => {
  const oursEntry = { id: 'R7', verbatim: 'words', status: 'open', evidence: '' };
  const theirsEntry = { id: 'R7', verbatim: 'words', status: 'done', evidence: 'claimed done' };
  const { doc: merged } = mergeLedgerDocuments(doc([clone(oursEntry)]), doc([clone(theirsEntry)]));
  assert.equal(merged.requests.length, 2);
  assert.equal(merged.requests[0].status, 'open');
  assert.equal(merged.requests[1].status, 'done');
});

check('dotted allocation skips suffixes that are already taken', () => {
  const ours = doc([
    { id: 'R133', verbatim: 'trunk words', status: 'open' },
    { id: 'R133.1', verbatim: 'an unrelated earlier re-file', status: 'open' }
  ]);
  const theirs = doc([{ id: 'R133', verbatim: 'third, different words', status: 'open' }]);
  const { doc: merged, report } = mergeLedgerDocuments(ours, theirs);
  assert.deepEqual(report.refiled, [{ from: 'R133', to: 'R133.2' }]);
  assert.equal(merged.requests.length, 3);
});

check('re-merge is idempotent: a previously re-filed conflict is recognized, not duplicated', () => {
  const ours = doc([{ id: 'R133', verbatim: 'trunk words', status: 'open' }]);
  const theirs = doc([{ id: 'R133', verbatim: 'machine A words, entirely different', status: 'done' }]);
  const first = mergeLedgerDocuments(clone(ours), clone(theirs), { today: '2026-08-03' });
  const second = mergeLedgerDocuments(first.doc, clone(theirs), { today: '2026-08-04' });
  assert.equal(second.doc.requests.length, first.doc.requests.length);
  assert.equal(second.report.alreadyPresent, 1);
  assert.equal(second.report.refiled.length, 0);
  assert.equal(second.report.changed, false);
});

check('duplicate id inside ONE input is refused as ambiguous, exit-coded 3', () => {
  const bad = doc([{ id: 'R1', verbatim: 'a', status: 'open' }, { id: 'R1', verbatim: 'b', status: 'open' }]);
  const dir = tempDir();
  const badPath = path.join(dir, 'bad.json');
  fs.writeFileSync(badPath, JSON.stringify(bad), 'utf8');
  assert.throws(() => readLedgerDocument(badPath), (e) => e instanceof LedgerMergeError && e.exitCode === 3 && e.code === 'LEDGER_MERGE_DUPLICATE_ID');
});

check('malformed controllerNotes is refused instead of being collapsed to an empty list', () => {
  const bad = doc([{ id: 'R1', verbatim: 'a', status: 'open' }]);
  bad.controllerNotes = { unreadableAsNotes: true };
  const dir = tempDir();
  const badPath = path.join(dir, 'bad-notes.json');
  fs.writeFileSync(badPath, JSON.stringify(bad), 'utf8');
  assert.throws(
    () => readLedgerDocument(badPath),
    (e) => e instanceof LedgerMergeError && e.exitCode === 3 && e.code === 'LEDGER_MERGE_INPUT_SHAPE' && /controllerNotes/.test(e.message)
  );
});

// --- the refusal: verbatim loss must abort the write entirely ----------------

check('REFUSAL: a merged doc missing a verbatim is never written; no file, no tmp residue', () => {
  const ours = doc([{ id: 'R1', verbatim: 'the owner said this exactly', status: 'open' }]);
  const theirs = doc([{ id: 'R2', verbatim: 'and separately said this', status: 'open' }]);
  const { doc: merged } = mergeLedgerDocuments(clone(ours), clone(theirs));
  const poisoned = clone(merged);
  poisoned.requests[0].verbatim = 'the owner said'; // truncation = rewrite of his words
  const dir = tempDir();
  const outPath = path.join(dir, 'merged.json');
  assert.throws(
    () => writeMergedDocument(outPath, poisoned, [ours, theirs]),
    (e) => e instanceof LedgerMergeError && e.code === 'LEDGER_MERGE_VERBATIM_LOSS' && e.exitCode === 5
  );
  assert.equal(fs.existsSync(outPath), false, 'refusal must leave no output file');
  assert.deepEqual(fs.readdirSync(dir), [], 'refusal must leave no tmp residue');
});

check('REFUSAL: a dropped gate instruction is also a loss', () => {
  const ours = doc([{
    id: 'R51', verbatim: 'v', status: 'open',
    gates: [{ instruction: 'check the destination record first', met: false, evidence: '' }]
  }]);
  const theirs = doc([]);
  const { doc: merged } = mergeLedgerDocuments(clone(ours), theirs);
  const poisoned = clone(merged);
  delete poisoned.requests[0].gates;
  const dir = tempDir();
  const outPath = path.join(dir, 'merged.json');
  assert.throws(
    () => writeMergedDocument(outPath, poisoned, [ours, theirs]),
    (e) => e.code === 'LEDGER_MERGE_VERBATIM_LOSS' && e.exitCode === 5
  );
  assert.equal(fs.existsSync(outPath), false);
});

check('a verbatim surviving as a substring of a longer capture is NOT a loss', () => {
  const ours = doc([{ id: 'R1', verbatim: 'do the thing', status: 'open' }]);
  const theirs = doc([{ id: 'R1', verbatim: 'do the thing, and also the second thing', status: 'open' }]);
  const { doc: merged } = mergeLedgerDocuments(clone(ours), clone(theirs));
  assert.doesNotThrow(() => assertNoProtectedLoss([ours, theirs], merged));
  assert.equal(merged.requests[0].verbatim, 'do the thing, and also the second thing');
});

// --- CLI ---------------------------------------------------------------------

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8', windowsHide: true, ...opts });
}

check('CLI: merges two fixtures, writes output, exits 0', () => {
  const dir = tempDir();
  const oursPath = path.join(dir, 'ours.json');
  const theirsPath = path.join(dir, 'theirs.json');
  const outPath = path.join(dir, 'merged.json');
  fs.writeFileSync(oursPath, JSON.stringify(doc([{ id: 'R1', verbatim: 'one', status: 'open' }]), null, 2), 'utf8');
  fs.writeFileSync(theirsPath, JSON.stringify(doc([{ id: 'R2', verbatim: 'two', status: 'open' }]), null, 2), 'utf8');
  const result = runCli(['--ours', oursPath, '--theirs', theirsPath, '--out', outPath]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const merged = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.deepEqual(merged.requests.map((r) => r.id), ['R1', 'R2']);
});

check('CLI: missing arguments exit 2; existing output without --force exits 4; --dry-run writes nothing', () => {
  const dir = tempDir();
  const oursPath = path.join(dir, 'ours.json');
  const theirsPath = path.join(dir, 'theirs.json');
  fs.writeFileSync(oursPath, JSON.stringify(doc([{ id: 'R1', verbatim: 'one', status: 'open' }])), 'utf8');
  fs.writeFileSync(theirsPath, JSON.stringify(doc([{ id: 'R2', verbatim: 'two', status: 'open' }])), 'utf8');

  const missingArguments = runCli(['--ours', oursPath]);
  assert.equal(missingArguments.status, 2);
  assert.match(missingArguments.stderr, /LEDGER_MERGE_USAGE/,
    'exit 2 must come from the merge CLI argument check');

  const occupied = path.join(dir, 'occupied.json');
  fs.writeFileSync(occupied, '{"already":"here"}', 'utf8');
  const occupiedResult = runCli(['--ours', oursPath, '--theirs', theirsPath, '--out', occupied]);
  assert.equal(occupiedResult.status, 4);
  assert.match(occupiedResult.stderr, /LEDGER_MERGE_OUTPUT_REFUSED/,
    'exit 4 must come from the merge CLI output-safety check');
  assert.equal(fs.readFileSync(occupied, 'utf8'), '{"already":"here"}', 'a refused write must not touch the file');

  const dryOut = path.join(dir, 'never-written.json');
  const dry = runCli(['--ours', oursPath, '--theirs', theirsPath, '--out', dryOut, '--dry-run']);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /\[dry-run\]/);
  assert.equal(fs.existsSync(dryOut), false);
});

check('CLI: refuses to overwrite --theirs even with --force', () => {
  const dir = tempDir();
  const oursPath = path.join(dir, 'ours.json');
  const theirsPath = path.join(dir, 'theirs.json');
  fs.writeFileSync(oursPath, JSON.stringify(doc([{ id: 'R1', verbatim: 'one', status: 'open' }])), 'utf8');
  fs.writeFileSync(theirsPath, JSON.stringify(doc([{ id: 'R2', verbatim: 'two', status: 'open' }])), 'utf8');
  const result = runCli(['--ours', oursPath, '--theirs', theirsPath, '--out', theirsPath, '--force']);
  assert.equal(result.status, 4);
  assert.match(result.stderr, /LEDGER_MERGE_OUTPUT_REFUSED/,
    'exit 4 must come from the merge CLI output-safety check');
});

check('CLI: --in-place refuses while owner capture holds the ledger lock', () => {
  const dir = tempDir();
  const oursPath = path.join(dir, 'ours.json');
  const theirsPath = path.join(dir, 'theirs.json');
  const oursRaw = JSON.stringify(doc([{ id: 'R1', verbatim: 'one', status: 'open' }]));
  fs.writeFileSync(oursPath, oursRaw, 'utf8');
  fs.writeFileSync(theirsPath, JSON.stringify(doc([{ id: 'R2', verbatim: 'two', status: 'open' }])), 'utf8');

  const lock = acquireLock(`${oursPath}.lock`);
  try {
    const result = runCli(['--ours', oursPath, '--theirs', theirsPath, '--out', oursPath, '--in-place']);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /LEDGER_MERGE_LOCKED/);
    assert.equal(fs.readFileSync(oursPath, 'utf8'), oursRaw, 'a locked merge must not touch the ledger');
  } finally {
    lock.release();
  }
});

// --- the REAL ledgers --------------------------------------------------------
//
// This asserts the property the whole tool exists for, against real data rather
// than fixtures: nothing is lost in either direction, at real scale (253
// requests, ~450KB, real owner prose with its own quoting and line breaks).
//
// These are no longer "the two diverged files" this block was written against.
// Trunk was reset to zero requests on 2026-08-12 (commit 4cae519, owner
// directive), so the retired tree is the only side still carrying data and the
// merge is a pure union rather than a reconciliation. The no-loss property is
// what the tool exists for and it is exercised exactly as hard either way; the
// re-file-on-divergence property no longer has real inputs here and is covered
// by the fixture tests above instead. Machine A's LIVE tree only exists on
// Machine A; elsewhere this block reports SKIPPED and the rest of the suite
// still runs.

const CURRENT_LEDGER = path.join(ROOT, 'reports', 'OWNER-REQUEST-LEDGER.json');
// Machine A's retired LIVE tree lives on the operator's own Desktop (same
  // the installed runtime-tree convention
// constant) -- never a literal username, so this still finds the tree on
// whichever machine happens to have it, and still reports SKIPPED elsewhere.
const LIVE_LEDGER = process.env.LEDGER_MERGE_LIVE_PATH ||
  path.join(os.homedir(), 'Desktop', 'ToolsEnabled', 'reports', 'OWNER-REQUEST-LEDGER.json');

if (process.env.LEDGER_MERGE_REAL_TEST !== '1' || process.env.TOOLSENABLED_TEST_STRICT === '1') {
  test('real owner-ledger cross-check', {
    skip: 'requires LEDGER_MERGE_REAL_TEST=1 outside the strict unattended suite; synthetic no-loss cases still run'
  }, () => assert.fail('unattended tests must not consume owner ledgers'));
} else {
  assert.ok(fs.existsSync(LIVE_LEDGER), 'the explicitly selected real ledger must exist');
  const cur = readLedgerDocument(CURRENT_LEDGER);
  const live = readLedgerDocument(LIVE_LEDGER);

  // The name used to end "and is a no-op (reconciliation already landed)". The
  // body stopped asserting no-op two corrections ago, and the reconciliation it
  // named was discarded by the 2026-08-12 reset, so the name was advertising a
  // guarantee this check does not make.
  check('REAL: merging LIVE into CURRENT loses nothing and represents every LIVE request', () => {
    const { doc: merged, report } = mergeLedgerDocuments(cur, live, {
      oursLabel: 'trunk', theirsLabel: 'machine-a-live'
    });
    assert.doesNotThrow(() => assertNoProtectedLoss([cur, live], merged));
    // This asked whether the id was in CURRENT -- the INPUT -- so for the whole
    // union case it was checking the wrong document, and a merge that dropped
    // every LIVE-only request would have passed. It stayed green only while
    // every LIVE id happened to also exist in CURRENT. The first id that did
    // not (R1164, then R1165, recorded on the retired tree on 2026-08-10) made
    // it red while the merge tool was doing exactly the right thing: both were
    // present in the OUTPUT under their own ids.
    //
    // The property is about the merge result, so ask the merge result: every
    // LIVE request survives, either under its own id or re-filed under a dotted
    // one when it genuinely diverged.
    const mergedIds = new Set(merged.requests.map((m) => m.id));
    for (const r of live.requests) {
      assert.equal(
        mergedIds.has(r.id) || merged.requests.some((m) => m.id.startsWith(`${r.id}.`)),
        true,
        `LIVE id ${r.id} must be represented in the merge`
      );
    }
    // This used to assert the merge was a no-op, on the reasoning that the
    // reconciliation had already landed so CURRENT dominated LIVE. That was a
    // snapshot relationship between two INDEPENDENTLY MUTATING trees, and it
    // stopped holding as soon as either side moved -- which is a property of
    // the world, not of this code, so pinning it made the suite go red for
    // reasons unrelated to the merge.
    //
    // Measured 2026-08-04: R133, R135, R137, R138 and R139 still carried
    // DIFFERENT verbatim on LIVE than on CURRENT, with neither containing the
    // other. Re-measured 2026-08-13: the divergent set is EMPTY, because the
    // 2026-08-12 reset left CURRENT with no requests, so no id is shared and
    // nothing can diverge. The loop below is therefore a no-op today and is kept
    // as a live measurement rather than deleted -- it costs nothing and starts
    // asserting again the moment trunk records its first request that the retired
    // tree also holds. Real-data coverage of re-filing is gone with the shared
    // ids; the fixture tests above cover that behaviour deliberately.
    //
    // What must hold regardless of how either tree drifts:
    //   1. nothing is lost (asserted above, and again below after re-parse)
    //   2. a genuine divergence is RE-FILED under a dotted id, never overwritten
    const divergent = live.requests.filter((r) => {
      const c = cur.requests.find((x) => x.id === r.id);
      if (!c) return false;
      const lv = String(r.verbatim || '');
      const cv = String(c.verbatim || '');
      return lv !== cv && !lv.includes(cv) && !cv.includes(lv);
    });
    for (const r of divergent) {
      const kept = merged.requests.find((m) => m.id === r.id);
      const refiled = merged.requests.filter((m) => m.id.startsWith(`${r.id}.`));
      assert.equal(Boolean(kept), true, `divergent ${r.id} must still exist under its own id`);
      assert.equal(refiled.length >= 1, true,
        `divergent ${r.id} must be re-filed under a dotted id, not overwritten`);
    }
    // changed is now a measurement, not a constant: it must be true exactly when
    // the two trees actually differ.
    const identical = deepEqual(merged.requests, cur.requests);
    assert.equal(report.changed, !identical,
      'report.changed must reflect whether the merge actually altered anything');
  });

  check('REAL: merging CURRENT into LIVE (reverse direction) also loses nothing from either side', () => {
    const { doc: merged } = mergeLedgerDocuments(live, cur, {
      oursLabel: 'machine-a-live', theirsLabel: 'trunk', today: '2026-08-03'
    });
    assert.doesNotThrow(() => assertNoProtectedLoss([live, cur], merged));
    const mergedIds = new Set(merged.requests.map((r) => r.id));
    for (const r of live.requests) assert.equal(mergedIds.has(r.id), true, `LIVE id ${r.id} kept its id`);
    // Every protected string from both real files must appear in the merge.
    for (const inputDoc of [live, cur]) {
      const survivors = collectProtectedStrings(merged, [], '(root)');
      for (const p of collectProtectedStrings(inputDoc, [], '(root)')) {
        assert.equal(
          survivors.some((s) => s.kind === p.kind && (s.value === p.value || s.value.includes(p.value))),
          true,
          `protected ${p.kind} at ${p.where} must survive the reverse merge`
        );
      }
    }
  });

  check('REAL: the real merged output passes the write gate and lands on disk intact', () => {
    const dir = tempDir();
    const outPath = path.join(dir, 'real-merged.json');
    const { doc: merged } = mergeLedgerDocuments(cur, live, { oursLabel: 'trunk', theirsLabel: 'machine-a-live' });
    writeMergedDocument(outPath, merged, [cur, live]);
    const reread = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    // Was `=== cur.requests.length`, which assumed the merge adds nothing --
    // true only while CURRENT dominated LIVE. It does not: five ids still carry
    // genuinely divergent verbatim between the trees, so the merge correctly
    // re-files them under dotted ids and the output is LARGER than CURRENT.
    // What must hold is that the round-trip through disk changes nothing and
    // loses nothing, which is what this test is actually for.
    assert.equal(reread.requests.length, merged.requests.length,
      'the document on disk must have exactly the entries the merge produced');
    assert.equal(reread.requests.length >= cur.requests.length, true,
      'a merge may add re-filed entries but must never drop any');
    assert.doesNotThrow(() => assertNoProtectedLoss([cur, live], reread));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Sanity anchors so a quietly-swapped fixture cannot fake this test out.
  //
  // These used to pin the 2026-08-03 reconciliation snapshot: LIVE must not have
  // grown past trunk, and trunk must carry that reconciliation's dotted re-files.
  // Commit 4cae519 (2026-08-12, owner directive) reset trunk to zero requests and
  // archived the previous 721-request record, so BOTH became permanently false --
  // trunk has no requests at all, dotted or otherwise.
  //
  // The first one's FAILURE TEXT was the real hazard. It read an empty trunk as
  // "LIVE has grown past trunk, the divergence is live again and needs a real
  // merge run". LIVE did not grow: it is frozen at 2026-08-08 and untouched since.
  // Trunk shrank, on purpose. Following that instruction would merge 253 retired
  // requests back into the ledger the owner had just deliberately emptied, and the
  // merge tool -- correctly, since nothing may be lost -- would append every one of
  // them. A red test that tells the next agent to undo an owner directive is worse
  // than no test, so the wrong reading does not survive here in any form.
  //
  // A relationship between two independently mutating trees is a property of the
  // world, not of the merge tool: the same mistake this file already corrected
  // twice above. What these anchors are actually FOR is vacuity. The retired tree
  // is now the only side carrying data, so if it were swapped for an empty or
  // verbatim-less document every no-loss assertion above would pass while proving
  // nothing. That is the property pinned now, and it cannot rot as either tree
  // moves.
  check('REAL: the inputs are real ledger documents, so the no-loss checks are not vacuous', () => {
    assert.equal(live.requests.length > 0, true,
      'LIVE must carry requests, or every no-loss assertion above is vacuous');
    const withVerbatim = live.requests.filter((r) => String(r.verbatim || '').trim().length > 0);
    assert.equal(withVerbatim.length > 0, true,
      'LIVE must carry owner verbatims, or the loss gate has nothing to protect');
    assert.equal(collectProtectedStrings(live, [], '(root)').length >= withVerbatim.length, true,
      'every LIVE verbatim must be visible to collectProtectedStrings');
    assert.equal(Array.isArray(cur.requests), true, 'CURRENT must parse as a ledger document');
  });
}

// contentEquivalent is what makes idempotence work against the real data; pin it.
check('contentEquivalent ignores only id and mergeNote', () => {
  const a = { id: 'R133', verbatim: 'w', status: 'open' };
  const b = { id: 'R133.1', verbatim: 'w', status: 'open', mergeNote: 'Re-filed from R133 …' };
  assert.equal(contentEquivalent(a, b), true);
  assert.equal(contentEquivalent(a, { ...b, status: 'done' }), false);
});
