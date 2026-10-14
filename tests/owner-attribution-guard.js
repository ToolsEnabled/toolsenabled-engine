// EXECUTABLE CHANGE
'use strict';

// DISCRIMINATION REPORT (testcanfail-tests-owner-attribution-guard-js)
// MUTATION: changed the guard's scan banner while preserving its exit statuses.
// RED: "a bare OWNER-STATED marker must not make an unsourced claim pass: the
// guard must prove that it loaded and scanned the fixture". The shared helper
// also covers the bare-verbatim, inline-marker, fake-id, and real-id results.
// MUTATION: changed only the successful clean verdict, preserving exit 0.
// RED: "a claim carrying the owner's actual quoted words must pass: the guard's
// own clean verdict is required".
// MUTATION: changed only the missing-path diagnostic, preserving exit 2.
// RED: "a guard that scanned nothing must emit its own specific guard-error
// diagnostic".
// RESTORE: tools/check-owner-attribution.js SHA-256 before and after mutations:
// f44a8f77cfdace66bd01dcca177b44f414be324f1a4630e82234eaca36cc7d22.
// GREEN: "Owner-attribution guard tests passed (19 checks; the $100-cap claim
// shape is refused, and a bare OWNER-STATED or \"verbatim\" no longer launders
// a claim that cites nothing)."
// PRECONDITION-NOT-MET: reports/OWNER-REQUEST-LEDGER.json is absent, so the
// real owner-stated-id acceptance assertion cannot execute in this checkout;
// the test now names that omission rather than silently hiding it.
// NOT-FOUND: empty loop/forEach assertion bodies; swallowed subject failures;
// mocks of the guard; whole-file platform skips; expected values computed by
// the guard code. The ledger lookup's optional assertion was the only guard.

// THE GUARD MUST CATCH THE CASE IT WAS BUILT FOR, AND MUST NOT BE DEFEATABLE BY
// TYPING A MAGIC WORD.
//
// tools/check-owner-attribution.js exists because `defaultDailySpendUsd: 100`
// -- authored by an agent in the initial commit, never chosen by any human --
// was described back to the owner as "his own $100/day cap", and that invented
// constraint was then used to drop a $350 trademark filing he had personally
// asked for. The owner, 2026-08-11: "And again who put a $100 day cap?
// Literally not something I did" / "Why are agent rules stille being pushed as
// mine".
//
// These tests run the guard as a real process against real fixture files and
// assert on its EXIT CODE, because that is what a caller acts on. The guard is
// fail-closed: an unsourced attribution is exit 1, not a warning.
//
// The bypass tests are here because the guard shipped with one, verified
// behaviourally: a bare "OWNER-STATED" or "verbatim" anywhere on the line or the
// line above made any claim pass with no evidence at all. It was reachable by
// COMPLIANCE -- the guard's own remediation text tells the reader to "cite an
// OWNER-STATED ledger entry" -- so the most likely way to produce a false green
// was to follow the instructions.

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'tools', 'check-owner-attribution.js');
const LEDGER = path.join(ROOT, 'reports', 'OWNER-REQUEST-LEDGER.json');

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-attribution-guard-'));

function fixture(name, contents) {
  const file = path.join(workspace, name);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

function runGuard(target) {
  return spawnSync(process.execPath, [GUARD, target], { encoding: 'utf8' });
}

function checkFinding(result, message) {
  check(result.status === 1, message);
  check(/Owner-attribution guard: scanned 1 file\(s\)\./.test(result.stdout),
    `${message}: the guard must prove that it loaded and scanned the fixture`);
  check(/UNSOURCED ATTRIBUTION/.test(result.stdout),
    `${message}: the guard's own finding, rather than an arbitrary non-zero exit, is required`);
}

function checkClean(result, message) {
  check(result.status === 0, message);
  check(/Owner-attribution guard: scanned 1 file\(s\)\./.test(result.stdout),
    `${message}: the guard must prove that it loaded and scanned the fixture`);
  check(/Clean: every claim that a decision was the owner's cites evidence\./.test(result.stdout),
    `${message}: the guard's own clean verdict is required`);
}

// An id the guard will actually accept, taken from the live ledger rather than
// hardcoded, so this test tracks the ledger instead of rotting against it.
function someOwnerStatedId() {
  if (!fs.existsSync(LEDGER)) return null;
  const parsed = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : (parsed.requests || []);
  const entry = entries.find((e) => e && typeof e.verbatim === 'string' && e.verbatim.trim());
  return entry ? entry.id : null;
}

// 1. THE KNOWN CASE. The exact claim shape that cost the owner his trademark
//    filing must be refused.
function theHundredDollarCapCaseIsCaught() {
  const file = fixture('cap.md',
    'The daily spend limit is $100. This is his own cap, so the $350 trademark\nfiling breaks it and was removed from the list.\n');
  const result = runGuard(file);
  check(result.status === 1, 'an unsourced claim that the $100 cap was the owner\'s must FAIL, not warn');
  check(/UNSOURCED ATTRIBUTION/.test(result.stdout), 'the guard must name what it found');
}

// 2 & 3. THE BYPASS. A magic word with nothing behind it is not evidence.
function bareMarkersDoNotLaunderAClaim() {
  const ownerStated = fixture('bare-owner-stated.md', 'OWNER-STATED\nThe owner decided the daily cap should be $100.\n');
  checkFinding(runGuard(ownerStated), 'a bare OWNER-STATED marker must not make an unsourced claim pass');

  const verbatimWord = fixture('bare-verbatim.md', 'The $100/day cap is his own cap (verbatim record kept elsewhere).\n');
  checkFinding(runGuard(verbatimWord), 'the bare word "verbatim" must not make an unsourced claim pass');

  const sameLine = fixture('bare-owner-stated-inline.md', 'This was the owner decided value. See OWNER-STATED notes.\n');
  checkFinding(runGuard(sameLine), 'a bare marker on the same line must not make an unsourced claim pass');
}

// 4. THE THING IT MUST NOT BREAK. A directive quoted with the owner's own words
//    IS primary evidence; flagging it would be the noise that gets a guard
//    routed around and ignored.
function quotedOwnerWordsAreAccepted() {
  const file = fixture('quoted.md',
    'Owner directive 2026-08-09, verbatim: "i dont think your codex workers are doing anything" -- he decided this.\n');
  checkClean(runGuard(file), 'a claim carrying the owner\'s actual quoted words must pass');
}

// 5 & 6. Ids are checked against real evidence, not merely pattern-matched.
function idsAreResolvedNotJustMatched() {
  const real = someOwnerStatedId();
  if (real) {
    const good = fixture('real-id.md', `Per ${real} the owner decided the cap.\n`);
    checkClean(runGuard(good), 'a claim citing a real owner-stated ledger id must pass');
  } else {
    process.stdout.write(`PRECONDITION-NOT-MET: ${LEDGER} has no owner-stated entry; real-id acceptance was not run.\n`);
  }
  const fake = fixture('fake-id.md', 'Per R9999 the owner decided the daily cap should be $100.\n');
  checkFinding(runGuard(fake), 'an id that resolves to no evidence must NOT count as a citation');
}

// 7. Scanning nothing must not read as a pass. A clean report produced by
//    looking at zero files is the most dangerous output this program has.
function scanningNothingIsAnError() {
  const result = spawnSync(process.execPath, [GUARD, path.join(workspace, 'does-not-exist')], { encoding: 'utf8' });
  check(result.status === 2, 'a guard that scanned nothing must report a guard error, not success');
  check(/Owner-attribution guard error: nothing to check: none of the requested paths exist\./.test(result.stderr),
    'a guard that scanned nothing must emit its own specific guard-error diagnostic');
}

function run() {
  theHundredDollarCapCaseIsCaught();
  bareMarkersDoNotLaunderAClaim();
  quotedOwnerWordsAreAccepted();
  idsAreResolvedNotJustMatched();
  scanningNothingIsAnError();
  process.stdout.write(`Owner-attribution guard tests passed (${checks} checks; the $100-cap claim shape is refused, `
    + 'and a bare OWNER-STATED or "verbatim" no longer launders a claim that cites nothing).\n');
}

try {
  run();
} catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}
