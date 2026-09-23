// EXECUTABLE CHANGE -- testcanfail-tests-ide-session-consent-writer-js
//
// Discrimination audit:
// - STRENGTHENED: the two readConsentState/loadSessionConsent symmetry
//   assertions below formerly derived their expected values from the same
//   loadSessionConsent implementation as their subject. Mutation: changed
//   loadSessionConsent's successful importedSurfaces result to
//   ['mutation-sentinel']. Before strengthening, the isolated check stayed
//   green: "ok  readConsentState after a write matches loadSessionConsent
//   exactly" and "1 checks passed". With the independent on-disk and literal
//   result anchors below, the mutation went RED with:
//   "AssertionError [ERR_ASSERTION]: readConsentState must report the surface
//   independently known to have been written" and
//   "actual: [ 'mutation-sentinel' ], expected: [ 'claude-vscode' ]".
// - NOT-FOUND (1): no assertion body is guarded solely by iteration over a
//   possibly-empty collection. The every() assertion is preceded by a
//   non-empty assertion in the same synchronous check.
// - NOT-FOUND (2): this file neither spawns a process nor treats a non-zero
//   exit status/truthy process return as evidence.
// - NOT-FOUND (3): no try/catch or optional chain swallows the failure under
//   test. throws() fails when no exception occurs and validates type and code;
//   cleanup finally blocks do not suppress assertions.
// - NOT-FOUND (4): injected I/O and callbacks only create failure/race
//   conditions; assertions inspect the real persisted file and public result,
//   rather than asserting against those injections.
// - NOT-FOUND (5): there are no skips or platform precondition guards.
// - NOT-FOUND (6), apart from the strengthened symmetry check: expected
//   values elsewhere are literals or independently captured pre-write bytes.
// - RESTORATION: the mutated source was restored byte-for-byte (cmp passed).
//   After restoration, `node tests/ide-session-consent-writer.js` was green:
//   "21 checks passed". No audit precondition was unmet.

'use strict';

// Behavioural coverage for the IDE session consent WRITE path
// (src/lib/ide-session-consent-writer.js). The read-side gate
// (src/lib/ide-session-consent.js, tests/ide-session-consent.js) already
// proves discovered sessions are never auto-adopted. This suite proves the
// other half the owner asked for actually works: a person can write a
// choice, that choice is exactly what lands (no more, no less), and neither
// a lock-contended writer nor an interrupted/racing one can corrupt the file
// or silently drop a choice.
//
// Weighted, like the read-side suite, toward the cases that matter most:
//   - with no choice made, nothing is imported, AND the offered list is
//     still non-empty when sessions exist (both halves, integrated end to
//     end through the real partition function, not just the writer alone).
//   - a concurrent/interrupted write cannot leave the file corrupt or
//     silently drop a choice.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const consentModule = require('../src/lib/ide-session-consent.js');
const {
  IdeSessionConsentWriteError,
  importSurface,
  removeSurface,
  setImportPolicy,
  readConsentState,
  observeConsentSettings,
  atomicReplaceConsent,
  withConsentUpdate,
  adoptLegacyConsent
} = require('../src/lib/ide-session-consent-writer.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function throws(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof IdeSessionConsentWriteError, `expected an IdeSessionConsentWriteError, got ${error && error.constructor && error.constructor.name}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected ${code} to be thrown, but nothing was`);
}

function scratchRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ide-consent-writer-'));
}

function rawFile(root) {
  return consentModule.consentFilePath(root);
}

process.stdout.write('ide-session-consent-writer\n');

// --- writing lands exactly what was asked, nothing else -----------------------

check('importing a surface from a fresh machine creates the file with exactly that surface', () => {
  const root = scratchRoot();
  const result = importSurface(root, 'claude-vscode');
  assert.equal(result.ok, true);
  assert.equal(result.source, 'file');
  assert.deepEqual([...result.importedSurfaces], ['claude-vscode']);
  assert.ok(fs.existsSync(rawFile(root)), 'the consent file must actually exist on disk after a write');
});

check('importing is idempotent: importing an already-imported surface changes nothing observable', () => {
  const root = scratchRoot();
  importSurface(root, 'claude-vscode');
  const before = fs.readFileSync(rawFile(root));
  const beforeStat = fs.statSync(rawFile(root), { bigint: true });
  const again = importSurface(root, 'claude-vscode');
  assert.deepEqual([...again.importedSurfaces], ['claude-vscode']);
  assert.deepEqual(fs.readFileSync(rawFile(root)), before);
  const afterStat = fs.statSync(rawFile(root), { bigint: true });
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs);
});

check('importing a second surface keeps the first', () => {
  const root = scratchRoot();
  importSurface(root, 'claude-vscode');
  const result = importSurface(root, 'codex-desktop');
  assert.deepEqual([...result.importedSurfaces], ['claude-vscode', 'codex-desktop']);
});

check('removing a surface removes exactly that one and leaves the others', () => {
  const root = scratchRoot();
  importSurface(root, 'claude-vscode');
  importSurface(root, 'codex-desktop');
  const result = removeSurface(root, 'claude-vscode');
  assert.deepEqual([...result.importedSurfaces], ['codex-desktop'],
    'removing one surface must not touch a different, unrelated surface');
});

check('an explicit removal records exclusion, and repeating that choice preserves saved bytes', () => {
  const root = scratchRoot();
  importSurface(root, 'claude-vscode');
  removeSurface(root, 'jetbrains-plugin');
  assert.deepEqual([...readConsentState(root).excludedSurfaces], ['jetbrains-plugin']);
  const before = fs.readFileSync(rawFile(root));
  const beforeStat = fs.statSync(rawFile(root), { bigint: true });
  const result = removeSurface(root, 'jetbrains-plugin');
  assert.deepEqual([...result.importedSurfaces], ['claude-vscode']);
  assert.deepEqual(fs.readFileSync(rawFile(root)), before);
  const afterStat = fs.statSync(rawFile(root), { bigint: true });
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs);
});

check('an explicit remove on first run records an empty choice', () => {
  const root = scratchRoot();
  const result = removeSurface(root, 'codex_vscode');
  assert.equal(result.source, 'empty');
  assert.deepEqual(JSON.parse(fs.readFileSync(rawFile(root))).importedSurfaces, []);
});

check('an unchanged choice still refuses a concurrent edit without overwriting it', () => {
  const root = scratchRoot();
  importSurface(root, 'codex_vscode');
  const external = JSON.stringify({ schemaVersion: 1, importedSurfaces: ['sdk-cli'] });
  throws(() => importSurface(root, 'codex_vscode', {
    beforeReplace: () => fs.writeFileSync(rawFile(root), external)
  }), 'IDE_CONSENT_CONCURRENT_EDIT');
  assert.equal(fs.readFileSync(rawFile(root), 'utf8'), external);
});

check('removing the only imported surface returns to nothing imported, not to absence', () => {
  const root = scratchRoot();
  importSurface(root, 'claude-vscode');
  const result = removeSurface(root, 'claude-vscode');
  assert.deepEqual([...result.importedSurfaces], []);
  assert.equal(result.source, 'empty', 'an explicit remove-to-nothing is a recorded choice of nothing, distinct from never having chosen');
});

// --- input validation: only real surface slugs are writable -------------------

check('importing a non-slug value is refused and writes nothing', () => {
  const root = scratchRoot();
  throws(() => importSurface(root, '../../etc'), 'IDE_CONSENT_SURFACE_INVALID');
  throws(() => importSurface(root, '*'), 'IDE_CONSENT_SURFACE_INVALID');
  throws(() => importSurface(root, 42), 'IDE_CONSENT_SURFACE_INVALID');
  assert.ok(!fs.existsSync(rawFile(root)), 'a rejected import must not create a file at all');
});

check('removing a non-slug value is refused rather than silently matching nothing', () => {
  const root = scratchRoot();
  importSurface(root, 'claude-vscode');
  throws(() => removeSurface(root, '*'), 'IDE_CONSENT_SURFACE_INVALID');
  const state = readConsentState(root);
  assert.deepEqual([...state.importedSurfaces], ['claude-vscode'], 'a refused remove must not alter existing state');
});

// --- malformed existing state: refuse by default, not silently repair --------

check('writing on top of a malformed consent file refuses by default', () => {
  const root = scratchRoot();
  fs.mkdirSync(path.dirname(rawFile(root)), { recursive: true });
  fs.writeFileSync(rawFile(root), '{ not json', 'utf8');
  const error = throws(() => importSurface(root, 'claude-vscode'), 'IDE_CONSENT_FILE_MALFORMED');
  assert.match(error.message, /malformed|could not be read/);
  assert.equal(fs.readFileSync(rawFile(root), 'utf8'), '{ not json', 'a refused write must leave the malformed file byte-for-byte untouched');
});

check('an explicit requireMalformedAck replaces a malformed file with a clean one', () => {
  const root = scratchRoot();
  fs.mkdirSync(path.dirname(rawFile(root)), { recursive: true });
  fs.writeFileSync(rawFile(root), '{ not json', 'utf8');
  const result = importSurface(root, 'claude-vscode', { requireMalformedAck: true });
  assert.equal(result.ok, true);
  assert.deepEqual([...result.importedSurfaces], ['claude-vscode']);
});

check('a transient consent re-read failure is unavailable, never empty, and is not latched', () => {
  const root = scratchRoot();
  fs.mkdirSync(path.dirname(rawFile(root)), { recursive: true });
  fs.writeFileSync(rawFile(root), JSON.stringify({ schemaVersion: 1, importedSurfaces: ['codex-desktop'] }), 'utf8');
  let reads = 0;
  const busyOnceIo = {
    ...fs,
    readFileSync(...args) {
      reads += 1;
      if (reads === 2) {
        const error = new Error('simulated busy disk');
        error.code = 'EIO';
        throw error;
      }
      return fs.readFileSync(...args);
    }
  };

  const error = throws(
    () => importSurface(root, 'claude-vscode', { io: busyOnceIo, requireMalformedAck: true }),
    'IDE_CONSENT_READ_UNAVAILABLE'
  );
  assert.match(error.message, /NOT claiming.*absent or empty/);
  assert.deepEqual(JSON.parse(fs.readFileSync(rawFile(root), 'utf8')).importedSurfaces, ['codex-desktop'],
    'could-not-tell must not overwrite the previously recorded choice');

  const retry = importSurface(root, 'claude-vscode', { io: busyOnceIo, requireMalformedAck: true });
  assert.deepEqual([...retry.importedSurfaces], ['claude-vscode', 'codex-desktop'],
    'a later successful read must be attempted and retain the old choice (the failure is not latched)');
});

// --- concurrency: a lost race must be LOUD, never silent ----------------------

check('a second writer contending the same lock is refused, not silently dropped', () => {
  const root = scratchRoot();
  importSurface(root, 'claude-vscode');
  const { acquireLock } = require('../src/lib/agent-digest/lock');
  const lockFile = `${rawFile(root)}.lock`;
  const held = acquireLock(lockFile);
  try {
    throws(() => importSurface(root, 'codex-desktop'), 'IDE_CONSENT_LOCKED');
  } finally {
    held.release();
  }
  const state = readConsentState(root);
  assert.deepEqual([...state.importedSurfaces], ['claude-vscode'],
    'the surface the losing writer tried to add must NOT silently appear, and the winner\'s prior state must be intact');
});

check('after a lock is released, a previously-blocked writer can proceed normally', () => {
  const root = scratchRoot();
  const { acquireLock } = require('../src/lib/agent-digest/lock');
  const lockFile = `${rawFile(root)}.lock`;
  const held = acquireLock(lockFile);
  throws(() => importSurface(root, 'claude-vscode'), 'IDE_CONSENT_LOCKED');
  held.release();
  const result = importSurface(root, 'claude-vscode');
  assert.deepEqual([...result.importedSurfaces], ['claude-vscode']);
});

// --- concurrency: a racing writer that does NOT hold the lock (a hand edit,
// or a second implementation) is still caught by the compare-and-swap -------

check('a file that changed on disk between read and rename is detected, not overwritten', () => {
  const root = scratchRoot();
  importSurface(root, 'claude-vscode');
  let raced = false;
  throws(() => {
    withConsentUpdate(root, current => [...current, 'codex-desktop'], {
      beforeReplace: () => {
        if (raced) return;
        raced = true;
        // Simulate a writer that is NOT going through this module's lock --
        // for example a hand edit, or code written before this module
        // existed -- landing between this call's read and its rename.
        fs.writeFileSync(rawFile(root), JSON.stringify({ schemaVersion: 1, importedSurfaces: ['sdk-cli'] }, null, 2), 'utf8');
      }
    });
  }, 'IDE_CONSENT_CONCURRENT_EDIT');
  const state = readConsentState(root);
  assert.deepEqual([...state.importedSurfaces], ['sdk-cli'],
    'the racing writer\'s content must survive untouched -- the losing write must not have landed at all');
});

// --- atomicity: an interrupted write must never leave a partial file ---------

check('a write that fails mid-flight leaves the previous file exactly as it was', () => {
  const root = scratchRoot();
  importSurface(root, 'claude-vscode');
  const before = fs.readFileSync(rawFile(root), 'utf8');

  const flakyIo = {
    ...fs,
    writeFileSync(target, ...rest) {
      if (typeof target === 'number') throw new Error('simulated crash mid-write');
      return fs.writeFileSync(target, ...rest);
    }
  };

  assert.throws(() => {
    withConsentUpdate(root, current => [...current, 'codex-desktop'], { io: flakyIo });
  }, /simulated crash mid-write/);

  assert.equal(fs.readFileSync(rawFile(root), 'utf8'), before, 'a failed write must not touch the previously-persisted file at all');
  const leftovers = fs.readdirSync(path.dirname(rawFile(root))).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'a failed write must not leave a temp file behind');
});

check('a write that fails after the temp file is staged still leaves the real file untouched and cleans up', () => {
  const root = scratchRoot();
  importSurface(root, 'claude-vscode');
  const before = fs.readFileSync(rawFile(root), 'utf8');

  assert.throws(() => {
    atomicReplaceConsent(rawFile(root), before, `${before}garbage`, {
      beforeReplace: () => {
        throw new Error('simulated crash after fsync, before rename');
      }
    });
  }, /simulated crash after fsync, before rename/);

  assert.equal(fs.readFileSync(rawFile(root), 'utf8'), before, 'the real file must be untouched by a write that crashed before rename');
  const leftovers = fs.readdirSync(path.dirname(rawFile(root))).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'the staged temp file must be cleaned up even when the write is aborted');
});

// --- read/write symmetry: readConsentState is exactly what a write produced ---

check('readConsentState after a write matches loadSessionConsent exactly', () => {
  const root = scratchRoot();
  importSurface(root, 'claude-vscode');
  const viaWriter = readConsentState(root);
  const viaReader = consentModule.loadSessionConsent(root);
  const persisted = JSON.parse(fs.readFileSync(rawFile(root), 'utf8'));
  assert.deepEqual(persisted.importedSurfaces, ['claude-vscode'],
    'the independently parsed file must contain the surface the test wrote');
  assert.deepEqual([...viaWriter.importedSurfaces], ['claude-vscode'],
    'readConsentState must report the surface independently known to have been written');
  assert.equal(viaWriter.source, 'file',
    'readConsentState must independently identify a populated consent file');
  assert.deepEqual([...viaWriter.importedSurfaces], [...viaReader.importedSurfaces]);
  assert.equal(viaWriter.source, viaReader.source);
});

check('a root with no consent file yet reads back as absent, same as the read-side module reports', () => {
  const root = scratchRoot();
  const state = readConsentState(root);
  assert.equal(state.source, 'absent');
  assert.deepEqual([...state.importedSurfaces], []);
});

// --- the acceptance criterion, end to end: BOTH halves through the real
// partition function, not asserted separately ---------------------------------

const SESSIONS = Object.freeze([
  { sessionId: 's1', provider: 'claude', surface: 'claude-vscode' },
  { sessionId: 's2', provider: 'codex', surface: 'codex-desktop' },
  { sessionId: 's3', provider: 'codex', surface: 'codex-desktop' }
]);

check('the imported and available settings share one consent/discovery observation', () => {
  const root = scratchRoot();
  importSurface(root, 'codex-desktop');
  const values = observeConsentSettings(root, { observation: { coverage: 'complete', sessions: SESSIONS } });

  assert.deepEqual([...values['ide.imported_surfaces']], ['codex-desktop']);
  assert.deepEqual(values['ide.available_surfaces'].map(entry => ({ ...entry })), [
    { surface: 'claude-vscode', imported: false, synthetic: false, sessionCount: 1 },
    { surface: 'codex-desktop', imported: true, synthetic: false, sessionCount: 2 }
  ]);
  assert.ok(Object.isFrozen(values));
});

check('an incomplete discovery refuses rather than reporting its partial surface list as definite', () => {
  const root = scratchRoot();
  const error = throws(() => observeConsentSettings(root, {
    observation: {
      coverage: 'partial',
      coverageNotes: ['codex: a session file could not be read'],
      sessions: SESSIONS.slice(0, 1)
    }
  }), 'IDE_CONSENT_OBSERVATION_INCOMPLETE');
  assert.equal(error.details.coverage, 'partial');
});

check('an unreadable consent file refuses rather than reporting no imported surfaces', () => {
  const root = scratchRoot();
  fs.mkdirSync(path.dirname(rawFile(root)), { recursive: true });
  fs.writeFileSync(rawFile(root), '{ not json', 'utf8');
  throws(() => observeConsentSettings(root, {
    observation: { coverage: 'complete', sessions: SESSIONS }
  }), 'IDE_CONSENT_READ_FAILED');
});

check('with no choice made, nothing is imported AND the offered list is non-empty when sessions exist', () => {
  const root = scratchRoot();
  const consent = readConsentState(root);
  const split = consentModule.partitionObservedSessions(SESSIONS, consent);
  assert.equal(split.importedCount, 0, 'the default must be nothing imported');
  assert.equal(split.discoveredTotal, 3);
  assert.ok(split.offeredSurfaces.length > 0, 'the offered list must not be empty when sessions actually exist');
  assert.deepEqual(split.offeredSurfaces.map(entry => entry.surface).sort(), ['claude-vscode', 'codex-desktop']);
  assert.ok(split.offeredSurfaces.every(entry => entry.imported === false));
});

check('after importing exactly one surface, only that surface\'s sessions are imported', () => {
  const root = scratchRoot();
  importSurface(root, 'codex-desktop');
  const consent = readConsentState(root);
  const split = consentModule.partitionObservedSessions(SESSIONS, consent);
  assert.equal(split.importedCount, 2, 'both codex-desktop sessions should now be imported');
  assert.deepEqual(split.imported.map(session => session.sessionId).sort(), ['s2', 's3']);
  assert.equal(split.availableCount, 1, 'the claude-vscode session must remain merely offered');
  assert.equal(split.available[0].sessionId, 's1');
  const byName = new Map(split.offeredSurfaces.map(entry => [entry.surface, entry]));
  assert.equal(byName.get('codex-desktop').imported, true);
  assert.equal(byName.get('claude-vscode').imported, false);
});

check('after importing then removing, the projection returns to nothing imported', () => {
  const root = scratchRoot();
  importSurface(root, 'codex-desktop');
  removeSurface(root, 'codex-desktop');
  const consent = readConsentState(root);
  const split = consentModule.partitionObservedSessions(SESSIONS, consent);
  assert.equal(split.importedCount, 0);
  assert.equal(split.discoveredTotal, 3, 'the total must still be visible -- removal is a choice, not a return to unmeasured');
});

// --- adoption: a choice made while the file lived in the program root is kept ---
//
// The tools now write under the per-user state root. A customer who imported a
// surface before that change has a file in <program>/config/; adopting it once
// is what stops their choice from silently reading as "first run".

check('adoptLegacyConsent copies a program-root choice into the new root exactly once', () => {
  const legacyRoot = scratchRoot();
  const root = scratchRoot();
  importSurface(legacyRoot, 'claude-vscode');
  const legacyBytes = fs.readFileSync(consentModule.consentFilePath(legacyRoot), 'utf8');

  const first = adoptLegacyConsent({ legacyRoot, root });
  assert.equal(first.adopted, true, 'a legacy file with no counterpart must be adopted');
  assert.equal(fs.readFileSync(consentModule.consentFilePath(root), 'utf8'), legacyBytes, 'adoption must copy the exact bytes');
  assert.deepEqual([...readConsentState(root).importedSurfaces], ['claude-vscode'], 'the adopted choice must read back through the normal gate');
  assert.equal(fs.existsSync(consentModule.consentFilePath(legacyRoot)), true, 'the legacy file is left in place, never deleted from the program root');

  const second = adoptLegacyConsent({ legacyRoot, root });
  assert.equal(second.adopted, false, 'a second adoption must be a no-op once the new root holds a file');
});

check('adoptLegacyConsent never overwrites a choice already made in the new root', () => {
  const legacyRoot = scratchRoot();
  const root = scratchRoot();
  importSurface(legacyRoot, 'claude-vscode');
  importSurface(root, 'codex-desktop');
  const result = adoptLegacyConsent({ legacyRoot, root });
  assert.equal(result.adopted, false);
  assert.deepEqual([...readConsentState(root).importedSurfaces], ['codex-desktop'], 'the newer choice wins; the legacy one is not merged over it');
});

check('adoptLegacyConsent is a no-op with no legacy file, or with the same root on both sides', () => {
  const root = scratchRoot();
  assert.equal(adoptLegacyConsent({ legacyRoot: scratchRoot(), root }).adopted, false);
  assert.equal(adoptLegacyConsent({ legacyRoot: root, root }).adopted, false);
  assert.equal(readConsentState(root).source, 'absent', 'nothing may have been written');
  throws(() => adoptLegacyConsent({ legacyRoot: scratchRoot(), root: '' }), 'IDE_CONSENT_ROOT_INVALID');
});

check('saved automatic imports include discovered surfaces and preserve explicit removals across reload', () => {
  const root = scratchRoot();
  const sessions = [{ provider: 'claude', surface: 'claude-vscode' }, { provider: 'codex', surface: 'codex_vscode' }];
  setImportPolicy(root, 'all-detected');
  assert.equal(consentModule.partitionObservedSessions(sessions, readConsentState(root)).importedCount, 2);
  removeSurface(root, 'claude-vscode');
  let split = consentModule.partitionObservedSessions(sessions, readConsentState(root));
  assert.deepEqual(split.imported.map(row => row.surface), ['codex_vscode']);
  setImportPolicy(root, 'none');
  importSurface(root, 'codex_vscode');
  split = consentModule.partitionObservedSessions(sessions, readConsentState(root));
  assert.deepEqual(split.imported.map(row => row.surface), ['codex_vscode'], 'explicit imports survive a more restrictive default');
  assert.equal(split.offeringEnabled, false);
  setImportPolicy(root, 'ask');
  split = consentModule.partitionObservedSessions(sessions, readConsentState(root));
  assert.equal(split.offeringEnabled, true);
  assert.deepEqual(split.imported.map(row => row.surface), ['codex_vscode']);
  setImportPolicy(root, 'all-detected');
  split = consentModule.partitionObservedSessions(sessions, readConsentState(root));
  assert.deepEqual(split.imported.map(row => row.surface), ['codex_vscode'], 'explicit removals survive returning to automatic import');
  importSurface(root, 'claude-vscode');
  assert.equal(consentModule.partitionObservedSessions(sessions, readConsentState(root)).importedCount, 2);
});

check('invalid import policy writes and malformed saved policy never enable automatic imports', () => {
  const root = scratchRoot();
  setImportPolicy(root, 'none');
  const before = fs.readFileSync(rawFile(root), 'utf8');
  throws(() => setImportPolicy(root, 'automatic-ish'), 'IDE_IMPORT_POLICY_INVALID');
  assert.equal(fs.readFileSync(rawFile(root), 'utf8'), before);
  fs.writeFileSync(rawFile(root), JSON.stringify({ importedSurfaces: [], importPolicy: true }));
  const saved = readConsentState(root);
  assert.equal(saved.ok, false);
  assert.equal(consentModule.partitionObservedSessions([{ provider: 'claude', surface: 'claude-vscode' }], saved).importedCount, 0);
});

process.stdout.write(`\n${passed} checks passed\n`);
