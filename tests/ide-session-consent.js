// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-ide-session-consent-js):
// - FOUND (shapes 1 and 6): the final `for ... of` assertion below could run
//   zero times, and its expected regex was the module's own exported SURFACE_RE.
//   It therefore did not independently establish either that an entry was
//   checked or that the product's validator had the intended boundary.
// - MUTATION: in a temporary edit, changed the product's SURFACE_RE from the
//   intended slug regex to `/^.*$/`. Before and after restoration, the product
//   file's SHA-256 was
//   9ddad20386d6da2db0d1820957d0d180bfe5319683a7395dfe30da03400ec5e2.
// - RED (node tests/ide-session-consent.js, exit 1):
//   "AssertionError [ERR_ASSERTION]: The input did not match the regular
//   expression /^[a-z0-9][a-z0-9._-]{0,63}$/. Input: '../../etc'"
// - RESTORED GREEN (node tests/ide-session-consent.js, exit 0):
//   "11 checks passed"
// - NOT-FOUND (shape 2): no exit-status-only or truthy-process assertion.
// - NOT-FOUND (shape 3): no try/catch or optional chain swallowing a failure.
// - NOT-FOUND (shape 4): no mock of the consent implementation under test.
// - NOT-FOUND (shape 5): no skip or platform precondition guard.
// - PRECONDITIONS: all met; the test and mutation ran on this host.
'use strict';

// Behavioural coverage for the IDE session consent gate.
//
// The load-bearing assertions here are the NEGATIVE ones: that a discovered
// session does NOT reach the imported list without an explicit choice. A consent
// gate that cannot withhold is not a gate, and this repo has already shipped one
// control that could never say no and one that could never say yes -- both passed
// suites that only ever read the source instead of exercising it. So every case
// below calls the real functions and checks what they actually return.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const consentModule = require('../src/lib/ide-session-consent.js');
const {
  loadSessionConsent,
  partitionObservedSessions,
  consentFilePath,
  SURFACE_RE
} = consentModule;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

process.stdout.write('ide-session-consent\n');

function scratchRoot(contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-consent-'));
  if (contents !== undefined) {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(consentFilePath(root), contents, 'utf8');
  }
  return root;
}

const SESSIONS = Object.freeze([
  { sessionId: 's1', provider: 'claude', surface: 'claude-vscode' },
  { sessionId: 's2', provider: 'claude', surface: 'claude-vscode' },
  { sessionId: 's3', provider: 'codex', surface: 'codex-desktop' },
  { sessionId: 's4', provider: 'codex', surface: null }
]);

// --- the default must be: nothing imported -----------------------------------

check('no consent file -> NOTHING is imported, and every session is still offered', () => {
  const root = scratchRoot(undefined);
  const consent = loadSessionConsent(root);
  assert.equal(consent.ok, true, 'a first run is not an error');
  assert.equal(consent.source, 'absent');
  assert.deepEqual([...consent.importedSurfaces], []);

  const split = partitionObservedSessions(SESSIONS, consent);
  assert.equal(split.importedCount, 0, 'auto-adoption is the defect this gate exists to prevent');
  assert.equal(split.availableCount, 4);
  assert.equal(split.discoveredTotal, 4,
    'the total must survive the split, or a caller can render "no sessions imported" as "no sessions exist"');
});

check('absence is reported as absence, never as an empty choice', () => {
  const absent = loadSessionConsent(scratchRoot(undefined));
  const empty = loadSessionConsent(scratchRoot(JSON.stringify({ importedSurfaces: [] })));
  assert.equal(absent.source, 'absent');
  assert.equal(empty.source, 'empty');
  assert.notEqual(absent.source, empty.source,
    '"you have not chosen yet" and "you chose nothing" must not collapse into one state');
});

// --- an explicit choice, and ONLY that choice, is honoured -------------------

check('importing one surface imports exactly that surface and no other', () => {
  const root = scratchRoot(JSON.stringify({ schemaVersion: 1, importedSurfaces: ['claude-vscode'] }));
  const split = partitionObservedSessions(SESSIONS, loadSessionConsent(root));
  assert.equal(split.importedCount, 2);
  assert.deepEqual(split.imported.map(s => s.sessionId), ['s1', 's2']);
  assert.equal(split.availableCount, 2, 'codex-desktop was never chosen and must stay unimported');
  assert.ok(split.available.every(s => s.consentState === 'not-imported'));
});

check('a session with no identifiable surface is NOT auto-adopted', () => {
  const root = scratchRoot(JSON.stringify({ importedSurfaces: ['claude-vscode', 'codex-desktop'] }));
  const split = partitionObservedSessions(SESSIONS, loadSessionConsent(root));
  const unknown = split.available.find(s => s.sessionId === 's4');
  assert.ok(unknown, 'the unidentifiable session must remain in available, fail-closed');
  assert.match(unknown.consentReason, /no identifiable surface/);
  assert.ok(!split.imported.some(s => s.sessionId === 's4'));
});

// This case exists because wiring the gate into the projection exposed the bug it
// covers: keying consent solely on a real surface made surfaceless sessions
// permanently unimportable -- never adopted, but also never offerable, so they
// would disappear from the product entirely with no way to opt in. Invisible is
// as wrong as invasive; both halves have to hold.
check('a session with no identifiable surface is still OFFERABLE, and importable', () => {
  const offered = partitionObservedSessions(SESSIONS, loadSessionConsent(scratchRoot(undefined)));
  const synthetic = offered.offeredSurfaces.find(entry => entry.synthetic);
  assert.ok(synthetic, 'a surfaceless session must appear as a choice, or nobody can ever import it');
  assert.equal(synthetic.surface, 'codex.unidentified');
  assert.equal(synthetic.imported, false);

  const chosen = partitionObservedSessions(
    SESSIONS,
    loadSessionConsent(scratchRoot(JSON.stringify({ importedSurfaces: ['codex.unidentified'] })))
  );
  assert.deepEqual(chosen.imported.map(s => s.sessionId), ['s4'],
    'choosing the synthetic key must actually import the session it stands for');
});

// --- the settings screen must have something to render -----------------------

check('offeredSurfaces lists UNCHOSEN surfaces, or there is nothing to choose from', () => {
  const root = scratchRoot(JSON.stringify({ importedSurfaces: ['claude-vscode'] }));
  const split = partitionObservedSessions(SESSIONS, loadSessionConsent(root));
  const byName = new Map(split.offeredSurfaces.map(entry => [entry.surface, entry]));
  assert.equal(byName.get('claude-vscode').imported, true);
  assert.equal(byName.get('codex-desktop').imported, false,
    'an unimported surface must still be offered, or the user can never import it');
  assert.equal(byName.get('claude-vscode').sessionCount, 2);
});

check('a chosen surface that is not currently running is still remembered', () => {
  const root = scratchRoot(JSON.stringify({ importedSurfaces: ['claude-vscode', 'jetbrains-plugin'] }));
  const split = partitionObservedSessions(SESSIONS, loadSessionConsent(root));
  assert.deepEqual([...split.importedButNotPresent], ['jetbrains-plugin'],
    'a closed editor must not look like a withdrawn choice');
});

// --- unreadable choices must not silently become "no choices" ----------------

check('malformed consent is reported as malformed, not downgraded to empty', () => {
  const broken = loadSessionConsent(scratchRoot('{ not json'));
  assert.equal(broken.ok, false);
  assert.equal(broken.source, 'malformed');
  assert.match(broken.reason, /not valid JSON/);

  const wrongShape = loadSessionConsent(scratchRoot(JSON.stringify({ surfaces: ['claude-vscode'] })));
  assert.equal(wrongShape.ok, false);
  assert.equal(wrongShape.source, 'malformed');
});

check('malformed consent grants nothing', () => {
  const broken = loadSessionConsent(scratchRoot('{ not json'));
  const split = partitionObservedSessions(SESSIONS, broken);
  assert.equal(split.importedCount, 0,
    'unreadable choices must fail closed: an unparseable file cannot grant consent');
  assert.equal(split.consentOk, false, 'the caller must be able to tell the choices were unreadable');
  assert.equal(split.discoveredTotal, 4);
});

check('a non-slug entry cannot grant consent to anything', () => {
  const root = scratchRoot(JSON.stringify({ importedSurfaces: ['../../etc', '*', 'claude-vscode', 42] }));
  const consent = loadSessionConsent(root);
  const independentlyValidSurface = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  assert.ok(consent.importedSurfaces.length > 0,
    'exercise the entry assertions rather than passing vacuously on an empty accepted set');
  for (const entry of consent.importedSurfaces) assert.match(entry, independentlyValidSurface);
  assert.deepEqual([...consent.importedSurfaces], ['claude-vscode']);
  assert.equal(consent.rejectedEntries.length, 3);
  for (const entry of consent.importedSurfaces) assert.match(entry, SURFACE_RE);
});

// --- the emptiness trap, stated directly -------------------------------------

check('zero discovered sessions is distinguishable from zero imported sessions', () => {
  const root = scratchRoot(JSON.stringify({ importedSurfaces: ['claude-vscode'] }));
  const consent = loadSessionConsent(root);
  const nothingFound = partitionObservedSessions([], consent);
  const nothingChosen = partitionObservedSessions(SESSIONS, loadSessionConsent(scratchRoot(undefined)));

  assert.equal(nothingFound.importedCount, 0);
  assert.equal(nothingChosen.importedCount, 0);
  assert.notEqual(nothingFound.discoveredTotal, nothingChosen.discoveredTotal,
    'both show zero imported; only discoveredTotal separates "found nothing" from "chose nothing"');
  assert.equal(nothingFound.discoveredTotal, 0);
  assert.equal(nothingChosen.discoveredTotal, 4);
});

check('a failed or malformed discovery cannot masquerade as zero discovered sessions', () => {
  const consent = loadSessionConsent(scratchRoot(undefined));
  for (const unmeasured of [undefined, null, { sessions: [] }]) {
    assert.throws(
      () => partitionObservedSessions(unmeasured, consent),
      /sessions must be an array produced by a successful discovery/
    );
  }
});

process.stdout.write(`\n${passed} checks passed\n`);
