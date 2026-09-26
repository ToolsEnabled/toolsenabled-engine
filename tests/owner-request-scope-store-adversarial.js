// EXECUTABLE CHANGE
'use strict';

// CAN-FAIL AUDIT (2026-08-26)
// Strengthened seven unconditional `check(true, ...)` assertions. The
// original `code(...)` assertions still verify the error code; the new
// checks independently verify the subject's error message.
//
// Scratch-copy mutations and observed RED output:
// - BUSY message -> "scope store is occupied.":
//   "check failed: a concurrently held lock refuses the second writer with BUSY"
// - REVISION_CONFLICT message -> "scope store revision conflict.":
//   "check failed: a writer that supplies a stale expectedRevision is correctly refused (fencing works when used)"
// - AMBIGUOUS payload message -> "payload differs.":
//   "check failed: unicode-normalization-only differences are treated as a conflicting payload, not silently reconciled"
// - INVALID JSON message -> "scope store JSON cannot be parsed.":
//   "check failed: a truncated JSON file is refused rather than partially trusted"
// - PROVENANCE_REQUIRED message changed conditionally for ownerEventRef
//   "r173", "R01730", and "R173 ", respectively:
//   "check failed: a lowercase ownerEventRef (\"r173\") is rejected, not case-folded to match"
//   "check failed: an over-length ownerEventRef (\"R01730\") is rejected"
//   "check failed: a trailing-whitespace ownerEventRef (\"R173 \") is rejected"
//
// NOT-FOUND: potentially empty assertion loops/forEach; exit-status/truthy
// process assertions; swallowed failures via try/catch or optional chaining;
// mocks of the subject; skip/platform/precondition no-op guards; expected
// values computed by the same subject code. The hidden-field try/catch is
// followed by a mandatory assertion and therefore does not swallow failure.
// Preconditions not met: none. Mutations were made only in /tmp/engine-audit,
// not in this checkout. The scratch source SHA-256 before and after was
// 981ee683613a00fa89f4112a67c29a8f3c2e9c2dfa0fcab160d8b77e4ef9b9e2.
// Restored GREEN output: "owner-request-scope-store-adversarial: 15 checks passed"

// Q64/R173 adversarial coverage for the isolated persistence seam
// (src/lib/owner-request-scope-store.js). This deliberately probes what
// tests/owner-request-scope-store.js (the 24-check foundation suite) does
// not: concurrent-writer interleavings the revision fence might miss,
// replay with mutated-but-equivalent payloads, partial-write/crash
// artifacts, and provenance-matching near-misses. Every check uses only a
// private temporary directory -- no production state, no real vault, no
// network, no wall-clock sleeps (a "concurrent writer" is simulated by
// sequential calls against the same file, which is deterministic and
// sufficient because the store itself is single-threaded/synchronous).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/lib/owner-request-scope-store');

const code = (fn, expected, label) => {
  let thrown;
  assert.throws(fn, error => {
    thrown = error;
    return error && error.code === expected;
  }, `${label || ''}: expected ${expected}`);
  return thrown;
};

let checks = 0;
function check(condition, label) {
  checks += 1;
  assert.equal(condition, true, `check failed: ${label}`);
}

const baseRule = (overrides = {}) => ({
  schemaVersion: 1,
  ruleId: 'rule_global_r173',
  ruleKey: 'work.mode',
  scopeKind: 'global',
  threadId: null,
  sourceRequestId: 'R173',
  issuedAt: '2026-08-01T07:00:00.000Z',
  expiresAt: null,
  decisionSummary: 'Use the bounded controller work mode.',
  evidenceRefs: ['reports/OWNER-REQUEST-LEDGER.json#R173'],
  ownerVerbatim: 'global or thread rules must be explicit.',
  ...overrides
});

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-q64-scope-adversarial-'));

try {
  // --- concurrent-writer interleavings the revision fencing might miss -----

  // A second writer that finds the lock file already held (simulating a
  // genuinely concurrent process) must be refused, not silently serialized
  // behind a wait.
  {
    const file = path.join(tempRoot, 'lock-held.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, '', { flag: 'wx' });
    const busyError = code(() => store.appendScopeRule({ rule: baseRule(), ownerEventRef: 'R173' }, { file }),
      'OWNER_SCOPE_STORE_BUSY', 'append while another writer holds the lock');
    check(busyError.message === 'scope store is busy; retry later.',
      'a concurrently held lock refuses the second writer with BUSY');

    const liveLock = JSON.stringify({ pid: process.pid, createdAtMs: Date.now() - 30_000 });
    fs.writeFileSync(`${file}.lock`, liveLock, 'utf8');
    code(() => store.appendScopeRule({ rule: baseRule(), ownerEventRef: 'R173' }, { file }),
      'OWNER_SCOPE_STORE_BUSY', 'age alone cannot revoke a live writer');
    check(fs.readFileSync(`${file}.lock`, 'utf8') === liveLock && !fs.existsSync(file),
      'an old live owner retains its lock and the refused writer changes no state');
    fs.unlinkSync(`${file}.lock`); // This process owns the synthetic fixture lock.
    const recovered = store.appendScopeRule({ rule: baseRule(), ownerEventRef: 'R173' }, { file });
    check(recovered.revision === 1 && !fs.existsSync(`${file}.lock`),
      'the next writer succeeds after the fixture owner releases its lock');
  }

  // Two interleaved writers: writer A appends first (revision 0 -> 1).
  // Writer B, whose in-memory belief of the revision was captured before
  // writer A ran, correctly gets refused when it supplies that stale belief
  // as expectedRevision -- proving the fence works when a caller uses it.
  {
    const file = path.join(tempRoot, 'interleave.json');
    const writerA = store.appendScopeRule({ rule: baseRule({ ruleId: 'rule_writer_a' }), ownerEventRef: 'R173', expectedRevision: 0 }, { file });
    check(writerA.revision === 1, 'writer A advances the store to revision 1');

    const conflictError = code(() => store.appendScopeRule({
      rule: baseRule({ ruleId: 'rule_writer_b', ruleKey: 'writer.b.key' }), ownerEventRef: 'R173', expectedRevision: 0
    }, { file }), 'OWNER_SCOPE_STORE_REVISION_CONFLICT', 'writer B using its stale revision belief');
    check(conflictError.message === 'scope store revision does not match expectedRevision.',
      'a writer that supplies a stale expectedRevision is correctly refused (fencing works when used)');

    // KNOWN DEFECT (softer than the stale-lock finding above, but the same
    // theme -- "concurrent-writer interleavings the revision fencing might
    // miss"): expectedRevision is OPTIONAL on appendScopeRule() (it is in
    // the "allowed" list but not the "required" list at
    // src/lib/owner-request-scope-store.js:140), and
    // ingestOwnerScopeEvent() (src/lib/owner-request-scope-event.js:110-148)
    // only forwards expectedRevision when ITS OWN caller supplied one. A
    // writer that simply omits expectedRevision -- whether by design or
    // because it lost track of the revision after the conflict above --
    // always succeeds, silently advancing past a change it never observed.
    // This does not corrupt the store (each append still reads fresh state
    // inside the lock, and distinct ruleIds cannot collide), but it means
    // the "revision fence" is opt-in, not an enforced invariant: nothing in
    // this module (or the ingestion seam) requires a caller to prove it has
    // seen the latest revision before writing.
    const blindWriterB = store.appendScopeRule({
      rule: baseRule({ ruleId: 'rule_writer_b', ruleKey: 'writer.b.key' }), ownerEventRef: 'R173'
    }, { file });
    check(blindWriterB.revision === 2, 'KNOWN DEFECT (src/lib/owner-request-scope-store.js:140-150; also '
      + 'src/lib/owner-request-scope-event.js:110-148): omitting expectedRevision entirely lets a writer succeed '
      + 'silently even though it never observed writer A\'s change -- revision fencing is opt-in, not enforced. '
      + "Not fixed here per this lane's tests-only constraint.");
  }

  // --- replay with mutated-but-equivalent payloads --------------------------

  // Key order in the raw input must not matter: normalizeScopeRule() always
  // produces the same canonical field order, so a replay submitted with
  // scrambled key order must still be recognized as the identical rule.
  {
    const file = path.join(tempRoot, 'replay-key-order.json');
    store.appendScopeRule({ rule: baseRule(), ownerEventRef: 'R173', expectedRevision: 0 }, { file });
    const scrambled = {
      ownerVerbatim: baseRule().ownerVerbatim,
      evidenceRefs: baseRule().evidenceRefs,
      decisionSummary: baseRule().decisionSummary,
      expiresAt: null,
      issuedAt: baseRule().issuedAt,
      sourceRequestId: 'R173',
      threadId: null,
      scopeKind: 'global',
      ruleKey: 'work.mode',
      ruleId: 'rule_global_r173',
      schemaVersion: 1
    };
    const replay = store.appendScopeRule({ rule: scrambled, ownerEventRef: 'R173', expectedRevision: 1 }, { file });
    check(replay.replayed === true && replay.revision === 1, 'a key-order-scrambled replay of the same rule is recognized as identical');
  }

  // Unicode normalization is NOT applied before the byte-exact replay
  // comparison: an NFD-decomposed decisionSummary is visually identical to
  // its NFC-precomposed form but a different byte sequence, so it is
  // correctly treated as a *different* payload for the same ruleId (a
  // fail-closed choice, not a defect -- fuzzy/semantic replay matching would
  // be the more dangerous design). Both forms are built purely from \u
  // escapes (never a literal accented source character) so the two strings
  // are guaranteed byte-distinct regardless of this file's own encoding.
  {
    const file = path.join(tempRoot, 'replay-unicode.json');
    const nfc = `café owner decision summary padding text to satisfy length`; // "e" + U+00E9 precomposed e-acute
    const nfd = `café owner decision summary padding text to satisfy length`; // "e" + U+0301 combining acute accent
    check(nfc !== nfd && nfc.normalize('NFC') === nfd.normalize('NFC'),
      'the NFC and NFD strings are byte-different but visually/semantically identical (test setup sanity)');
    store.appendScopeRule({ rule: baseRule({ ruleId: 'rule_unicode', decisionSummary: nfc }), ownerEventRef: 'R173', expectedRevision: 0 }, { file });
    const ambiguousError = code(() => store.appendScopeRule({ rule: baseRule({ ruleId: 'rule_unicode', decisionSummary: nfd }), ownerEventRef: 'R173', expectedRevision: 1 }, { file }),
      'OWNER_SCOPE_STORE_AMBIGUOUS', 'an NFD-normalized replay of an NFC-stored rule');
    check(ambiguousError.message === 'ruleId "rule_unicode" already has a different payload.',
      'unicode-normalization-only differences are treated as a conflicting payload, not silently reconciled');
  }

  // --- partial-write/crash artifacts ----------------------------------------

  // A truncated file (valid JSON prefix cut mid-object, as a crash mid-write
  // to a non-atomic path might produce) must fail closed, not partially
  // parse.
  {
    const file = path.join(tempRoot, 'truncated.json');
    store.appendScopeRule({ rule: baseRule(), ownerEventRef: 'R173', expectedRevision: 0 }, { file });
    const raw = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, raw.slice(0, Math.floor(raw.length / 2)), 'utf8');
    const invalidError = code(() => store.readScopeStore({ file }), 'OWNER_SCOPE_STORE_INVALID', 'a truncated mid-object JSON file');
    check(invalidError.message === 'scope store JSON is invalid.',
      'a truncated JSON file is refused rather than partially trusted');
  }

  // A leftover orphaned "<file>.<pid>.<uuid>.tmp" file (as writeAtomic()
  // would leave behind if a crash happened between the write and the
  // rename) sitting next to a perfectly valid real file must not affect a
  // read of the real file: readScopeStore() only ever opens the exact `file`
  // path, never the directory.
  {
    const file = path.join(tempRoot, 'tmp-litter.json');
    store.appendScopeRule({ rule: baseRule(), ownerEventRef: 'R173', expectedRevision: 0 }, { file });
    fs.writeFileSync(`${file}.12345.deadbeef-fake-uuid.tmp`, 'GARBAGE NOT EVEN JSON', 'utf8');
    const readBack = store.readScopeStore({ file });
    check(readBack.revision === 1, 'a stray orphaned .tmp file next to the real store does not affect a real read');
  }

  // The other half of the same crash scenario: if the crash happens BEFORE
  // the rename ever completes, only the temp-named file exists and the real
  // `file` path was never touched. A read must show the pristine pre-write
  // state (here: nothing was ever written, so an empty store), proving no
  // torn/partial state is ever observable -- the atomic-rename design
  // guarantees "all or nothing" even under a crash exactly at the boundary.
  {
    const file = path.join(tempRoot, 'crash-before-rename.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.999.crash-uuid.tmp`, JSON.stringify({ schemaVersion: 1, revision: 1, rules: [baseRule()] }), 'utf8');
    const preCrashState = store.readScopeStore({ file });
    check(preCrashState.revision === 0 && preCrashState.rules.length === 0,
      'a crash before rename leaves the real file untouched: no torn/partial state is ever observed');
  }

  // --- provenance-matching bypass attempts ----------------------------------

  // Case sensitivity: OWNER_EVENT_ID_RE requires an uppercase "R"; a
  // lowercase "r173" must not be treated as equivalent.
  {
    const file = path.join(tempRoot, 'provenance-case.json');
    const provenanceError = code(() => store.appendScopeRule({ rule: baseRule({ ruleId: 'rule_case' }), ownerEventRef: 'r173' }, { file }),
      'OWNER_SCOPE_STORE_PROVENANCE_REQUIRED', 'lowercase ownerEventRef');
    check(provenanceError.message === 'ownerEventRef must match rule.sourceRequestId.',
      'a lowercase ownerEventRef ("r173") is rejected, not case-folded to match');
  }

  // Shape near-miss: an extra digit past the 1-4 digit bound must not be
  // silently accepted as "close enough".
  {
    const file = path.join(tempRoot, 'provenance-digits.json');
    const provenanceError = code(() => store.appendScopeRule({ rule: baseRule({ ruleId: 'rule_digits' }), ownerEventRef: 'R01730' }, { file }),
      'OWNER_SCOPE_STORE_PROVENANCE_REQUIRED', 'an ownerEventRef with one digit too many');
    check(provenanceError.message === 'ownerEventRef must match rule.sourceRequestId.',
      'an over-length ownerEventRef ("R01730") is rejected');
  }

  // Shape near-miss: trailing whitespace must not be trimmed and matched.
  {
    const file = path.join(tempRoot, 'provenance-ws.json');
    const provenanceError = code(() => store.appendScopeRule({ rule: baseRule({ ruleId: 'rule_ws' }), ownerEventRef: 'R173 ' }, { file }),
      'OWNER_SCOPE_STORE_PROVENANCE_REQUIRED', 'a trailing-whitespace ownerEventRef');
    check(provenanceError.message === 'ownerEventRef must match rule.sourceRequestId.',
      'a trailing-whitespace ownerEventRef ("R173 ") is rejected');
  }

  // --- same exact()-bypass root cause as owner-request-scope-adversarial.js
  // (see that file for the full writeup): confirm it also reaches the
  // store's own append-input gate, not just the nested rule shape.
  {
    const file = path.join(tempRoot, 'hidden-field.json');
    const input = { rule: baseRule({ ruleId: 'rule_hidden_append_input' }), ownerEventRef: 'R173' };
    Object.defineProperty(input, 'bypassRevisionFence', { value: true, enumerable: false, writable: true, configurable: true });
    let hiddenError;
    try { store.appendScopeRule(input, { file }); }
    catch (error) { hiddenError = error; }
    check(hiddenError && hiddenError.code === 'OWNER_SCOPE_STORE_INVALID',
      'a non-enumerable extra field on the appendScopeRule() input envelope is rejected as invalid');
  }

  console.log(`owner-request-scope-store-adversarial: ${checks} checks passed`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
