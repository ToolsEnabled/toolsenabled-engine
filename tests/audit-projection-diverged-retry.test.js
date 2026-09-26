'use strict';

// A RACE THAT REFUSED A LAUNCH, AND A REFUSAL THAT WOULD NOT SAY WHY.
//
// AUDIT_PROJECTION_DIVERGED refused agent spawns and restarts on this machine.
// validateProjectionState() runs OUTSIDE the writer lock on purpose (the full
// chain walk is O(N) and must not be held under BEGIN IMMEDIATE), so it reads a
// projection file another process is in the middle of writing. Every other kind
// of outside-the-lock race in that function is already routed back through
// admissionRetry -- a moved archive boundary, a changed external witness, a
// lost trusted-fingerprint comparison. A projection divergence was the one that
// was thrown straight at the caller and never retried, even when it was the
// same class of race.
//
// TWO HALVES, AND THE SECOND CANNOT BE BUILT WITHOUT THE FIRST.
//
// projectionDivergenceReason() computes exactly which check refused --
// 'cursor-range', 'behind-cursor', 'not-a-continuation' or 'overhang-too-long'
// -- and that value was used only to decide whether to memoize, then DISCARDED.
// It never reached the thrown details, so neither an operator reading the
// ledger nor the admission path itself could tell a race from real loss. Any
// retry that cannot tell those apart is a retry that papers over data loss, so
// carrying the reason is a prerequisite, not a nicety.
//
// WHAT MAY BE RETRIED IS DECIDED BY A LIST THAT ALREADY EXISTS.
// PROJECTION_DIVERGENCE_MEMOIZABLE is the argued set of reasons that CANNOT
// stop being true for the same file, cursor, boundary and event count -- which
// is precisely why remembering them is sound. Its complement is the reason that
// can stop being true. Retrying only that is not a new judgement about what is
// safe; it is the same judgement the memo set already makes, read the other way
// round.
//
// Nothing here widens what counts as non-divergent. No admission ever proceeds
// on a projection that is still diverged: every retry re-runs the entire
// fail-closed check, the retry count is bounded, and when the bound runs out
// the ORIGINAL divergence is what surfaces.
//
//   node tests\run-isolated.js tests/audit-projection-diverged-retry.test.js

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

// src/lib/audit.js MAX_UNCOMMITTED_PROJECTION_OVERHANG is 1024; one more row
// than that is what makes the overhang "merely too long" rather than forged.
const OVERHANG_ROWS = 1025;

function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyId: `audit-ed25519-${crypto.createHash('sha256').update(der).digest('hex')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

/* REPRODUCING A CONCURRENT WRITER'S FILE, WITHOUT ACCIDENTALLY REPRODUCING A
 * DIFFERENT RACE INSTEAD.
 *
 * The obvious instrument -- swap the file's content for the first N reads --
 * is WRONG here, and quietly produces a passing test against unfixed code. One
 * admission pass reads this file three times: verificationExternal() digests it
 * before the chain walk, validateProjectionState() parses it, and
 * verificationExternal() digests it again to confirm nothing moved. Healing
 * between any two of those makes the two digests disagree, `externalStable`
 * goes false, and the admission is retried by the EXISTING
 * 'outside-lock-verification' guard -- which has nothing to do with the change
 * under test. Measured: with a naive read-counting proxy the transient test
 * passed before the fix existed.
 *
 * The real incident is the opposite shape. From the overhang suite's own
 * header: the racing content sits there STABLY, "long enough that the retry
 * guards (fresh external digest, trustedVerificationMatches) see nothing move
 * and let the refusal through." So the content must be identical to every read
 * WITHIN a pass, and may only change BETWEEN passes.
 *
 * The pass boundary is taken from the anchor, not from the file. Each pass
 * reads the anchor twice (initialAnchor before the chain walk, confirmedAnchor
 * after it), so the SECOND anchor read after the first projection parse is the
 * next pass's initialAnchor -- which happens before any of that pass's file
 * reads. `parses` is the instrument the bound assertions use: one parse of the
 * jsonl projection is exactly one admission pass that reached the projection
 * check.
 */
function racingProjection(target, racingContent, { healsAfterPasses = null } = {}) {
  const resolved = path.resolve(target);
  // healsAfterPasses null means the divergence NEVER resolves; the racing
  // content is what every read sees, for as long as the admission keeps
  // looking. Starting `healed` true for that case would serve the real file
  // and quietly test nothing -- measured, it made four of these five tests
  // pass against unfixed code.
  const state = { parses: 0, healed: false, anchorReadsSinceParse: 0 };
  const io = new Proxy(fs, {
    get(actual, property) {
      const value = Reflect.get(actual, property);
      if (property !== 'readFileSync' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(actual) : value;
      }
      return (file, ...rest) => {
        if (path.resolve(String(file)) !== resolved) return actual.readFileSync(file, ...rest);
        const asText = rest[0] === 'utf8' || (rest[0] && rest[0].encoding === 'utf8');
        if (asText) {
          state.parses += 1;
          state.anchorReadsSinceParse = 0;
        }
        if (state.healed) return actual.readFileSync(file, ...rest);
        // Racing content is served as the same bytes a real read would give:
        // text to the parser, a Buffer to the digest, so both agree.
        return asText ? racingContent : Buffer.from(racingContent, 'utf8');
      };
    }
  });
  // Called by the harness's anchorStore.get, which is what readAnchor() reads.
  const observeAnchorRead = () => {
    if (healsAfterPasses === null || state.healed || state.parses < 1) return;
    state.anchorReadsSinceParse += 1;
    if (state.parses >= healsAfterPasses && state.anchorReadsSinceParse >= 2) state.healed = true;
  };
  return { fs: io, state, observeAnchorRead };
}

function createHarness(label, { projectionRetryLimit } = {}) {
  audit.resetForTests();
  audit.resetProjectionVerifyCache();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `audit-diverged-retry-${label}-`));
  const files = {
    jsonl: path.join(directory, 'actions.jsonl'),
    text: path.join(directory, 'actions.log'),
    emergency: path.join(directory, 'emergency.jsonl')
  };
  const store = createAuditStore({ file: path.join(directory, 'audit.sqlite3') });
  let anchor = null;
  let eventNumber = 0;
  let now = 1_700_000_000_000;
  let onAnchorRead = () => {};
  const dependencies = {
    store,
    signer: testSigner(),
    anchorStore: { get: () => { onAnchorRead(); return anchor; }, set: value => { anchor = value; } },
    loadPolicy: () => ({
      audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' }
    }),
    loadSettings: () => ({ values: {}, rejected: [] }),
    rootPath: (...parts) => path.join(directory, ...parts),
    env: {},
    clock: () => now++,
    eventIdFactory: () => `audit-diverged-retry-${label}-${String(++eventNumber).padStart(5, '0')}`,
    reportError: () => {}
  };
  if (projectionRetryLimit !== undefined) {
    dependencies.auditProjectionDivergenceRetryLimit = projectionRetryLimit;
  }
  const lines = sink => {
    const content = fs.readFileSync(files[sink], 'utf8');
    return content.length ? content.slice(0, -1).split('\n') : [];
  };
  return {
    dependencies, directory, files, store, lines,
    seed(count = 4) {
      for (let index = 0; index < count; index += 1) {
        const status = audit.record('probe.seed', label, { index }, dependencies);
        assert.equal(status.ok, true, `seeding must succeed: ${JSON.stringify(status.errors)}`);
      }
    },
    record(action = 'probe.write') {
      return audit.record(action, label, { n: eventNumber }, dependencies);
    },
    /* The racing content: the real file plus a sequence-contiguous tail longer
       than one in-flight append can produce. Contiguous on purpose -- a tail
       that jumped or repeated would be 'not-a-continuation', which is a
       different (and fatal) reason. */
    overlongOverhang() {
      const rows = lines('jsonl');
      const last = JSON.parse(rows[rows.length - 1]);
      const extra = [];
      for (let step = 1; step <= OVERHANG_ROWS; step += 1) {
        extra.push(JSON.stringify({ ...last, sequence: last.sequence + step }));
      }
      return `${rows.concat(extra).join('\n')}\n`;
    },
    /* A projection BEHIND its own cursor: durable content the database
       believes exists and the file does not. Real loss, never a race. */
    truncatedByOne() {
      const rows = lines('jsonl');
      return `${rows.slice(0, rows.length - 1).join('\n')}\n`;
    },
    useRacingProjection(racing) {
      dependencies.fs = racing.fs;
      onAnchorRead = racing.observeAnchorRead;
      return racing.state;
    },
    cleanup() {
      try { store.close(); } catch { /* already closed */ }
      audit.resetForTests();
      audit.resetProjectionVerifyCache();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

function firstError(status) { return (status.errors || [])[0] || {}; }

test('a projection divergence says WHICH check refused it', () => {
  const harness = createHarness('reason');
  try {
    harness.seed();
    const state = harness.useRacingProjection(
      racingProjection(harness.files.jsonl, harness.truncatedByOne()));

    const status = harness.record('probe.behind_cursor');
    assert.equal(status.ok, false, 'a projection behind its cursor must still refuse');
    assert.equal(firstError(status).code, 'AUDIT_PROJECTION_DIVERGED');
    assert.equal((firstError(status).details || {}).reason, 'behind-cursor',
      'the reason projectionDivergenceReason() computed must reach the caller; without it neither an operator '
      + `nor the admission path can tell a race from real loss. Measured: ${JSON.stringify(firstError(status).details)}`);
    assert.ok(state.parses >= 1, 'set-up: the racing projection must actually have been parsed');
  } finally { harness.cleanup(); }
});

test('a divergence that is only a race is retried, and the admission then completes', () => {
  const harness = createHarness('transient');
  try {
    harness.seed();
    // One pass sees the racing file -- consistently, digest and parse alike --
    // and the writer has finished by the next pass. This is the shape that
    // refused spawns: nothing was wrong, the reader simply looked mid-write.
    const state = harness.useRacingProjection(
      racingProjection(harness.files.jsonl, harness.overlongOverhang(), { healsAfterPasses: 1 }));

    const status = harness.record('probe.after_transient_overhang');
    assert.equal(status.ok, true,
      'a projection divergence that had already resolved by the next pass must not refuse the admission; '
      + `measured ${JSON.stringify(status.errors)}`);
    assert.notEqual(firstError(status).code, 'AUDIT_PROJECTION_DIVERGED');
    assert.ok(state.parses > 1,
      `the admission must have looked again rather than deciding on one pass; measured ${state.parses} parses`);
  } finally { harness.cleanup(); }
});

test('a divergence that does NOT resolve still refuses, as a divergence, within a bound', () => {
  const harness = createHarness('stable', { projectionRetryLimit: 3 });
  try {
    harness.seed();
    const state = harness.useRacingProjection(
      racingProjection(harness.files.jsonl, harness.overlongOverhang()));

    const status = harness.record('probe.after_stable_overhang');
    assert.equal(status.ok, false,
      'a projection that is still diverged after every retry must NOT be admitted -- retrying may never become '
      + `a way through; measured ${JSON.stringify(status.errors)}`);
    assert.equal(firstError(status).code, 'AUDIT_PROJECTION_DIVERGED',
      'and the refusal the operator sees must be the divergence itself, not a generic contention error that '
      + `hides which check refused: ${JSON.stringify(status.errors)}`);
    assert.equal((firstError(status).details || {}).reason, 'overhang-too-long');

    // The bound is real, and it is the configured one: one first look plus
    // exactly three retries.
    assert.equal(state.parses, 4,
      `the retry must be bounded by the configured limit, not open-ended; measured ${state.parses} parses`);
  } finally { harness.cleanup(); }
});

test('a divergence that means real loss is refused on the first look, never retried', () => {
  /* THE SAFETY PROPERTY OF THIS WHOLE CHANGE. 'behind-cursor' is durable
     content the file no longer holds. It is in PROJECTION_DIVERGENCE_MEMOIZABLE
     because it cannot stop being true, and it must not buy a single extra
     look: retrying real loss is how a retry turns into papering over it. */
  const harness = createHarness('fatal', { projectionRetryLimit: 3 });
  try {
    harness.seed();
    const state = harness.useRacingProjection(
      racingProjection(harness.files.jsonl, harness.truncatedByOne()));

    const status = harness.record('probe.behind_cursor_not_retried');
    assert.equal(status.ok, false, 'lost durable content must refuse');
    assert.equal(firstError(status).code, 'AUDIT_PROJECTION_DIVERGED');
    assert.equal(state.parses, 1,
      'a fatal divergence must be decided on the first pass. Any retry here would be the admission path '
      + `treating real loss as a race; measured ${state.parses} parses`);
  } finally { harness.cleanup(); }
});

test('a forged tail is refused on the first look too, and names itself', () => {
  /* 'not-a-continuation' is the other fatal reason a racing file could be
     confused with: a tail that jumps, repeats or renumbers is somebody's
     appended line, not a writer mid-transaction. */
  const harness = createHarness('forged', { projectionRetryLimit: 3 });
  try {
    harness.seed();
    const rows = harness.lines('jsonl');
    const last = JSON.parse(rows[rows.length - 1]);
    const forged = `${rows.concat([JSON.stringify({ ...last, sequence: last.sequence + 50 })]).join('\n')}\n`;
    const state = harness.useRacingProjection(racingProjection(harness.files.jsonl, forged));

    const status = harness.record('probe.forged_tail_not_retried');
    assert.equal(status.ok, false, 'a stray appended line must refuse');
    assert.equal(firstError(status).code, 'AUDIT_PROJECTION_DIVERGED');
    assert.equal((firstError(status).details || {}).reason, 'not-a-continuation');
    assert.equal(state.parses, 1, `a forged tail must not be retried either; measured ${state.parses} parses`);
  } finally { harness.cleanup(); }
});
