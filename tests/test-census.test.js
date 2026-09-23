// EXECUTABLE CHANGE
/*
 *
 * Discrimination report (testcanfail-tests-test-census-test-js):
 * - Same-code expected value: the original count partition assertion remained
 *   green when buildCensus() was mutated to add one to both `candidates` and
 *   `reachable`. The independent array-length checks below reject that lie.
 *   RED: "AssertionError [ERR_ASSERTION]: candidate count must describe the
 *   candidate file list\n\n787 !== 786".
 * - Classification overlap: buildCensus() was mutated to also put its first
 *   orphan in `reachable` while removing one genuinely reachable file, keeping
 *   all three reported counts unchanged. The identity partition below rejects
 *   that substitution. RED: "AssertionError [ERR_ASSERTION]: reachable and
 *   orphaned test classifications must not overlap".
 * - NOT-FOUND empty iteration: both assertion loops iterate non-empty array
 *   literals; the dynamically empty adversarial selection is asserted as a
 *   collection rather than used to control whether an assertion executes.
 * - NOT-FOUND exit-status/truthiness-only evidence: this file spawns no process
 *   and makes no exit-status or generic truthy-return assertion.
 * - NOT-FOUND swallowed failure: there is no try/catch or optional chain.
 * - NOT-FOUND mock-of-subject: buildCensus() is loaded from the real module and
 *   no dependency or census result is mocked.
 * - NOT-FOUND skip/platform guard: this file has no skip or precondition guard.
 * - UNMET PRECONDITION (restored-source green): the unmodified census currently
 *   reports 16 orphans against the pre-existing ceiling of 3, before reaching
 *   any strengthened assertion. Restored run RED: "Test orphan count increased
 *   from the R1162 baseline ceiling (3) to 16." Product checks were not changed
 *   to conceal that pre-existing failure. tools/test-census.js was nevertheless
 *   restored byte-for-byte after each mutation (SHA-256
 *   bd5d780cbf97a81941e391c6631dfce37b5ab7de82ae59ffb0236d1ca269ae28).
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildCensus } = require('../tools/test-census');
const { readSuiteList, suiteListReferences } = require('./lib/suite-list');

function buildVmCensus() {
  const root = path.resolve(__dirname, '..');
  const toolsDirectory = path.join(root, 'tools');
  const censusPath = path.join(toolsDirectory, 'test-census.js');
  const fakeFiles = new Map();
  const directories = new Set([root]);
  const children = new Map();

  const ensureDirectory = (directory) => {
    directories.add(directory);
    if (!children.has(directory)) children.set(directory, new Set());
  };

  const files = {
    'package.json': JSON.stringify({
      scripts: {
        test: 'node tests/invoked/run.js && node tests/outer/run.js'
      }
    }),
    'tests/invoked/run.js': "const suites = ['tests/invoked/reachable.js'];",
    'tests/invoked/reachable.js': "'use strict';",
    'tests/outer/run.js': "const suites = ['tests/inner/run.js'];",
    'tests/inner/run.js': "const suites = ['tests/inner/deep.js'];",
    'tests/inner/deep.js': "'use strict';",
    'tests/uninvoked/run.js': "const suites = ['tests/uninvoked/orphan.js'];",
    'tests/uninvoked/orphan.js': "'use strict';"
  };

  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fakeFiles.set(absolutePath, source);
    let child = absolutePath;
    while (child !== root) {
      const parent = path.dirname(child);
      ensureDirectory(parent);
      children.get(parent).add(path.basename(child));
      child = parent;
    }
  }

  const fakeFs = {
    readFileSync(filePath) {
      if (!fakeFiles.has(filePath)) throw new Error('fixture file was not declared: ' + filePath);
      return fakeFiles.get(filePath);
    },
    readdirSync(directory) {
      if (!directories.has(directory)) throw new Error('fixture directory was not declared: ' + directory);
      return [...(children.get(directory) || [])].sort().map((name) => ({
        name,
        isDirectory: () => directories.has(path.join(directory, name)),
        isFile: () => fakeFiles.has(path.join(directory, name))
      }));
    },
    existsSync(filePath) {
      return fakeFiles.has(filePath);
    }
  };

  const censusSource = fs.readFileSync(censusPath, 'utf8').replace(/^#![^\n]*\n/, '');
  const censusModule = { exports: {} };
  const localRequire = (request) => {
    if (request === 'node:fs') return fakeFs;
    if (request === 'node:path') return path;
    if (request === './invocation-graph') return require('../tools/invocation-graph');
    if (request === '../tests/lib/suite-list') return { suiteListReferences: () => [] };
    throw new Error('unexpected VM dependency: ' + request);
  };
  const wrapped = '(function (require, module, exports, __dirname, __filename) {\n'
    + censusSource + '\n})';
  const loader = vm.runInNewContext(wrapped, {});
  loader(localRequire, censusModule, censusModule.exports, toolsDirectory, censusPath);
  return censusModule.exports.buildCensus();
}

// This ceiling is intentionally one-way: coverage work may reduce the orphan
// count, but adding a test without wiring it into an aggregate must fail here.
// KEEP THIS PINNED TO THE MEASURED COUNT. The ceiling only has teeth at the
// current value: it sat at the R1162 baseline (226) while the real count fell
// to 210, which meant 16 new unwired tests could have been added without this
// assertion noticing. When coverage work lowers the measured count, lower
// this number in the same commit.
// 2026-08-11: wiring the twelve orphaned adversarial suites (tests/adversarial/run.js)
// and the ratchet's own suite took the measured count 208 -> 195. It was pinned at
// 197 and not 195 because two test files landed unwired from a concurrent lane
// during the 36-minute full-tree measurement:
//   tests/codex-cloud-environments.test.js
//   tests/mission-bridge-cloud-binding.test.js
// Those two are OWED wiring by whoever added them; when they are wired, lower this
// to 195 in the same commit. Raising a ceiling to cover someone else's unwired test
// is the one move this assertion exists to make expensive, so it is named here in
// full rather than absorbed into a number.
//
// 2026-08-12: BOTH owed files are now wired (codex-cloud-environments into
// `npm run test:cloud-agent` beside its siblings, mission-bridge-cloud-binding
// into `npm run test:red-gates-orphans` beside the other mission-bridge suites),
// and the debt above is paid. The count then moved 204 -> 176 for two reasons
// that are worth keeping apart:
//
//   * 2 of the 28 were never orphaned at all. tools/test-census.js only
//     recognised `path.join(__dirname, 'x.js')` with exactly one segment, so
//     tests/lane-scope.test.js and tests/lane-territory-check.test.js -- both
//     named by tests/surface.registry/run.js as
//     `path.join(__dirname, '..', 'x.js')` -- were counted as unrun while they
//     were running. That extractor now accepts any number of segments. A census
//     that calls a running test unrun is worse than one that misses a test,
//     because the remedy it invites is to wire the same file twice.
//   * the other 26 were genuinely unreachable and are now wired into the package
//     runner they belong to, each PROVEN to exit 0 on this tree first (a runner
//     that goes red on arrival teaches everyone to stop adding to it).
//
// Ceiling lowered to the measured value in the same commit, per the rule above.
// 2026-08-13: 155 orphaned files were wired into 27 named chain steps and the
// real count fell 164 -> 9. This file's own doctrine is to lower the ceiling in
// the same change that lowers the count, so a ratchet that only ever ratchets
// one way keeps meaning something -- a ceiling of 176 against a true 9 would
// have let 167 tests silently fall out of the suite again.
//
// The remaining 9 are named and understood, not residue: 3 are genuinely red
// (two charter-drift suites and one that costs real Codex tokens AND needs a
// ledger request the owner's reset removed), 4 are compat aliases whose target
// already runs in the root chain (wiring them buys a duplicate run, not
// coverage -- they should be deleted, taking this to 5), and 2 are unsafe to
// wire: one hardcodes a single node.exe path, the other plants defects into a
// source file on disk for 98 s, where a crash mid-run leaves the defect behind.
// 2026-08-23: the count had drifted 9 -> 17 as other lanes landed tests without
// wiring them. Each of the 17 was RUN first; 13 were green and are now wired as
// the named chain step `orphans-wired-0823`, proven to exit 0 as a batch before
// being added -- a runner that goes red on arrival teaches everyone to stop
// adding to it. The count fell 17 -> 4 and the ceiling follows it down in this
// same change, per this file's own doctrine above.
//
// Two of the thirteen are worth naming, because nothing was running the gates
// that exist to catch this product's two most expensive defect classes:
// `every-module-parses.test.js`, born from a shipped provider that carried a
// syntax error and could never be loaded by anything while onboarding declared
// it to every agent as a capability; and `loads-on-a-customer-registry.test.js`,
// born from four modules that could not be loaded at all on a customer's
// machine. Both were orphaned. Both are green. Both now run.
//
// 2026-08-23 follow-up: provider-charters.js became green after the current
// provider dependency declarations were corrected, so it is now part of the
// same named batch above and the ceiling follows 4 -> 3. The survivors are not
// silently green: intent-fidelity-live.js needs the absent live R44 corpus and
// spends real tokens, no-blocking-prompt-registration.test.js is red until the
// owner applies the write-protected Claude settings file, and
// online-fra-relay-client.edge.js requires the private paid-relay sibling and
// deliberately refuses rather than passing when that checkout is absent.
// 2026-09-01: the final 332 previously unwired candidates are now named by
// tests/suites/orphans-wired-0901.txt and were exercised in twelve bounded
// ToolsEnabled-Dev batches. The three historical exceptions above are no
// longer a reason to tolerate any unreachable shipped test. The native-agent
// hostile install regression added during final source review is wired into
// the root suite rather than reopening the ceiling.
const MAXIMUM_ORPHANS = 0; // exact buildCensus() baseline on 2026-09-01

/* OWNER-HELD ORPHANS. NAMED, DATED, AND PRINTED ON EVERY RUN.
 *
 * The ceiling above stays 0. It is not raised here and it must never be: a
 * ceiling of 4 would let the next four unwired tests arrive for free, which is
 * precisely the substitution the comment above spends fifty lines refusing.
 *
 * What this list does instead is subtract EXACT NAMED PATHS from the count and
 * say out loud, in every run's output, that they are unwired and why. The four
 * below are the engine side of the Research page, landed 2026-09-20 in
 * 28173bbd ("committed as found"), and the owner placed the Research page on
 * hold on 2026-09-21: no merging, editing, refining or wiring of Research work
 * until the owner releases it. Wiring these four into an aggregate is exactly
 * the change the hold forbids, so the honest state is "unwired, on hold,
 * counted separately" rather than either a silently larger ceiling or a
 * quietly broken gate.
 *
 * THE HOLD LIST MAY ONLY SHRINK, and it is checked in both directions:
 *   - a held file that is no longer orphaned fails here, so releasing the hold
 *     and wiring one of these forces its removal from this list in the same
 *     change (the same ratchet rule the ceiling has);
 *   - a held file that no longer exists fails here, so a deletion cannot leave
 *     a stale name behind;
 *   - anything NOT on this list is still measured against 0, so a new unwired
 *     test cannot hide behind the hold.
 */
const OWNER_HELD_ORPHANS = Object.freeze({
  heldOn: '2026-09-21',
  reason: 'owner hold on the Research page: no Research work may be wired until the owner releases it',
  files: Object.freeze([
    'tests/research-access-owner-host-transport.test.js',
    'tests/research-access-t605.test.js',
    'tests/research-delegation.test.js',
    'tests/research-scoped-byte-mediation.test.js'
  ])
});

const census = buildCensus();

const vmCensus = buildVmCensus();
assert.ok(vmCensus.reachable.includes('tests/invoked/reachable.js'),
  'an invoked package runner must make its suite reachable');
assert.ok(vmCensus.reachable.includes('tests/inner/deep.js'),
  'a runner reached through another invoked runner must expand to a fixed point');
assert.ok(vmCensus.orphaned.includes('tests/uninvoked/orphan.js'),
  'a suite owned only by an uninvoked runner must remain orphaned');

/* NO FILE UNDER tests/ MAY SIMPLY VANISH FROM THIS REPORT.
 *
 * These run FIRST, ahead of the orphan ceiling, because they assert the census
 * is WELL-FORMED. Every assertion below the ceiling reads a list; if a list can
 * quietly omit files, none of those assertions mean what they say -- an orphan
 * ceiling of 3 is satisfied just as well by wiring a test as by making the
 * census stop seeing it.
 *
 * MEASURED 2026-08-25, and this is the defect being pinned. The census dropped
 * every non-candidate on the floor: 856 JavaScript files under tests/, 785
 * candidates, and 71 files that appeared in NEITHER `reachable` NOR `orphaned`.
 * `tools/test-run.js --all` runs exactly `[...reachable, ...orphaned]`, the set
 * tools/test-ratchet.mjs's header calls "the ENTIRE tree", so those 71 were
 * invisible to the runner AND to the orphan count that exists to catch an
 * unrun test. The only trace was `counts.excluded`, a bare integer computed by
 * SUBTRACTION -- right by construction, and therefore incapable of being wrong
 * in a way anyone could notice.
 *
 * Three of the 71 were genuine assertion suites, not runners: they matched the
 * `run-` prefix rule rather than any of the three exact runner names. That is a
 * fair heuristic with false positives, and the fix is that a false positive is
 * now NAMED where somebody can see it, not that the heuristic is deleted.
 */
assert.ok(Array.isArray(census.excluded), 'the census must report its excluded files as a list, not only as a count');
for (const entry of census.excluded) {
  assert.equal(typeof entry.file, 'string', 'every excluded entry names a file');
  assert.ok(entry.file.startsWith('tests/'), `excluded entry ${entry.file} must be a repository-relative tests/ path`);
  assert.ok(entry.reason && typeof entry.reason === 'string', `${entry.file} is excluded with no reason given`);
}
// The count must be DERIVED FROM THE NAMES, so it can never disagree with them.
assert.equal(census.counts.excluded, census.excluded.length, 'counts.excluded must be the length of the named excluded list');
assert.equal(new Set(census.excluded.map((entry) => entry.file)).size, census.excluded.length, 'excluded files must be deduplicated');
// The whole tree, partitioned: discovered = candidates + excluded. This is the
// assertion that makes "we ran less than the whole tree" impossible to mistake
// for "the whole tree passed" -- the shortfall is always exactly counts.excluded.
assert.equal(
  census.counts.javascriptFiles,
  census.counts.candidates + census.counts.excluded,
  'census counts must partition every discovered file under tests/ into candidates and excluded'
);
// An excluded file is excluded from the RUN, so it must not also be claimed as
// covered. Overlap here would mean a file is reported both ways.
const measured = new Set([...census.candidates, ...census.reachable, ...census.orphaned]);
const overlapping = census.excluded.map((entry) => entry.file).filter((file) => measured.has(file));
assert.deepEqual(overlapping, [], `files are reported as both excluded and measured: ${overlapping.join(', ')}`);

/* THE EXCLUSION REASONS, BY NAME.
 *
 * A free-text reason field decays into "excluded: yes" within a month. Pinning
 * the vocabulary means a NEW exclusion rule cannot be added without a reader
 * deciding it belongs here -- which is the review this defect went without.
 */
const KNOWN_EXCLUSION_REASONS = new Set([
  'lib-directory', 'fixtures-directory', 'helpers-directory', 'workers-directory',
  'runner-directory', 'package-runner', 'run-prefixed-name', 'worker-helper',
  'unsupported-extension'
]);
for (const entry of census.excluded) {
  assert.ok(KNOWN_EXCLUSION_REASONS.has(entry.reason), `${entry.file} is excluded for an unreviewed reason: ${entry.reason}`);
}

/* THE THREE SUITES THE PREFIX RULE CATCHES, BY NAME AND NOT BY COUNT.
 *
 * Same doctrine as the adversarial list further down: a count lets a newly
 * hidden suite hide behind a newly revealed one. These three are real suites
 * that the `run-` prefix classifies as runners, and each is named so that its
 * status is a decision somebody made rather than a side effect of a filename.
 *
 * Measured with the chain's own instrument, `node tests/run-isolated.js <file>`:
 *   - tests/run-isolated-config-integrity.js  exit 0, status pass, 6.3 s.
 *     WIRED into `npm test` as the chain step `config-integrity-guard`; see
 *     tests/suites/config-integrity-guard.txt, and the pin below.
 *   - tests/tools.misc/run-vertex-report-wave.js  exit 1,
 *     GEMINI_REPORT_CONTRACT_DOCUMENT_UNAVAILABLE. It loads
 *     docs/GEMINI-FLEET-REPORT-CONTRACT.md, and `git log --all` on that path
 *     returns nothing: the document has never existed in this repository. Not
 *     wired, because a runner that goes red on arrival teaches everyone to stop
 *     adding to it.
 *   - tests/run-vertex-report-wave.js  a 5-line compatibility shim that
 *     `require`s the file above, so it is red for the same single reason.
 */
const excludedByFile = new Map(census.excluded.map((entry) => [entry.file, entry.reason]));
for (const namedSuite of [
  'tests/run-isolated-config-integrity.js',
  'tests/run-vertex-report-wave.js',
  'tests/tools.misc/run-vertex-report-wave.js'
]) {
  assert.equal(
    excludedByFile.get(namedSuite),
    'run-prefixed-name',
    `${namedSuite} must stay NAMED in the census's excluded list. It is a real suite that the run- prefix classifies as a runner; if it is renamed or deleted, update this list in the same change.`
  );
}

/* THE ONE EXCLUDED SUITE THAT IS WIRED ANYWAY.
 *
 * tests/run-isolated-config-integrity.js can never appear in `reachable`: that
 * list is drawn from candidates, and it is not one. So the census cannot prove
 * it runs, and nothing else would notice it falling out of the chain. This pins
 * the wiring at its source -- the checked-in suite list npm actually reads.
 *
 * It matters more than most: it is the ONLY coverage of run-isolated's
 * config-integrity guard, the mechanism that stops a test mutating tracked
 * config from going unnoticed across the whole tree. An untested guard reads as
 * protection while asserting nothing.
 */
const packageScripts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts || {};
const wiredThroughSuiteLists = new Set(Object.values(packageScripts).flatMap((command) => suiteListReferences(String(command))));
assert.ok(
  wiredThroughSuiteLists.has('tests/run-isolated-config-integrity.js'),
  'tests/run-isolated-config-integrity.js must stay named by a tests/suites/*.txt list that an npm script reads (tests/suites/config-integrity-guard.txt)'
);

// These source additions were selected by the App qualifier but absent from
// the Engine's default lifecycle. Check the actual owning commands as well as
// reachability: a test path mentioned by an assertion is not runner membership.
for (const [alias, lifecycle, names] of [
  ['test:role-library', 'test', ['blank-tree-role.test.js', 'empty-role-directions.test.js']],
  ['test:agent-engine', 'pretest', [
    'blank-role-continuation.test.js',
    'provider-autonomy-regressions.test.js',
    'agent-engine/acp-mode-selection-races-review.test.js',
    'agent-engine/acp-mode-selection.test.js',
    'agent-engine/acp-shared-selection.test.js',
    'agent-engine/claude-native-mode-launch.test.js',
    'agent-engine/claude-native-modes.test.js',
    'agent-engine/codex-collaboration-modes.test.js',
    'agent-engine/codex-native-mode-launch.test.js',
    'agent-engine/codex-native-mode-selection.test.js',
    'agent-engine/codex-thread-settings-shape.test.js'
  ]],
  ['test:research-subsystem', 'pretest', ['research-generated-result-digests.test.js', 'research-run-pages.test.js']]
]) {
  const command = packageScripts[alias].split(/\s+/);
  assert.deepEqual(command.slice(0, 2), ['node', 'tests/run-isolated.js'], `${alias} must retain its real isolated runner`);
  const tokens = packageScripts[lifecycle].split(/\s+/);
  assert.equal(tokens.filter((token, index) => token === alias && tokens[index - 1] === 'run' && tokens[index - 2] === 'npm').length,
    1, `${alias} must execute exactly once in ${lifecycle}`);
  for (const name of names) {
    const file = 'tests/' + name;
    assert.equal(command.filter(token => token === file).length, 1, `${file} must execute exactly once through ${alias}`);
    assert.ok(census.reachable.includes(file), `${file} must remain reachable`);
  }
}

// These tests need their own root-suite invocation; helper source references
// from another test do not execute their assertion bodies.
const rootSuiteSteps = String(packageScripts.test).split(/\s+--then\s+/)
  .map(step => step.trim().split(/\s+/))
  .filter(tokens => tokens.includes('tests/suites/root-suite.txt'));
assert.deepEqual(rootSuiteSteps, [[
  '--id', 'root-suite', 'node', 'tests/run-isolated.js', '--from', 'tests/suites/root-suite.txt'
]], 'the default test lifecycle must execute the root suite exactly once through its isolated runner');
const rootSuiteFiles = readSuiteList('tests/suites/root-suite.txt');
for (const file of [
  'tests/agent-slot-functions.test.js',
  'tests/host-control-product-source-writes.test.js',
  'tests/local-fleet-identity.test.js',
  'tests/process-cpu-sample.test.js',
  'tests/vault-access-policy-dispatch.test.js',
  'tests/vault-access-policy-enforced.test.js',
  'tests/windows-job-host-settlement-review-W16.test.js',
  'tests/windows-job-owner-handshake.test.js',
  'tests/windows-job-pre-ready-settlement.test.js'
]) {
  assert.equal(rootSuiteFiles.filter(entry => entry === file).length, 1,
    `${file} must execute exactly once in the root suite`);
  assert.ok(census.reachable.includes(file), `${file} must remain reachable`);
}

// The hold is reported before it is applied, so a reader of any run's output
// sees the four unwired files by name even when everything passes.
for (const file of OWNER_HELD_ORPHANS.files) {
  process.stdout.write(`# ON HOLD, NOT WIRED since ${OWNER_HELD_ORPHANS.heldOn}: ${file} -- ${OWNER_HELD_ORPHANS.reason}\n`);
  assert.ok(fs.existsSync(path.join(__dirname, '..', file)), `${file} is on the ${OWNER_HELD_ORPHANS.heldOn} hold list but no longer exists; remove its exact entry`);
  assert.ok(census.orphaned.includes(file),
    `${file} is on the ${OWNER_HELD_ORPHANS.heldOn} hold list but is no longer an orphan; remove its exact entry in the change that wired it`);
}
const heldOrphans = new Set(OWNER_HELD_ORPHANS.files);
const countedOrphans = census.orphaned.filter(file => !heldOrphans.has(file));
assert.ok(
  countedOrphans.length <= MAXIMUM_ORPHANS,
  `Test orphan count increased from the R1162 baseline ceiling (${MAXIMUM_ORPHANS}) to ${countedOrphans.length}. Wire each new test into an aggregate. Unwired and not on the ${OWNER_HELD_ORPHANS.heldOn} hold list: ${countedOrphans.join(', ')}`
);
assert.equal(census.counts.candidates, census.counts.reachable + census.counts.orphaned, 'census counts must partition candidate test files');
assert.equal(census.counts.candidates, census.candidates.length, 'candidate count must describe the candidate file list');
assert.equal(census.counts.reachable, census.reachable.length, 'reachable count must describe the reachable file list');
assert.equal(census.counts.orphaned, census.orphaned.length, 'orphaned count must describe the orphaned file list');
const classified = [...census.reachable, ...census.orphaned];
assert.equal(new Set(classified).size, classified.length, 'reachable and orphaned test classifications must not overlap');
assert.deepEqual([...classified].sort(), census.candidates, 'reachable and orphaned identities must partition candidate test files');
assert.equal(new Set(census.orphaned).size, census.orphaned.length, 'orphaned tests must be deduplicated');
/* NAMED FILES THAT MUST BE REACHED THROUGH A WRAPPER RATHER THAN LISTED.
 * Historical suites whose source directories were removed are not listed: an
 * assertion over an absent file tests stale inventory rather than reachability. */
for (const transitivelyInvoked of [
  'tests/coordinator.workflow/token-savings-benchmark.test.js'
]) {
  assert.ok(census.reachable.includes(transitivelyInvoked), `${transitivelyInvoked} is invoked by a reachable test wrapper`);
}

// The adversarial suites, BY NAME and not by count.
//
// The ceiling above is a count, and a count lets a newly orphaned suite hide
// behind a newly wired one -- the same substitution that makes a count-based
// test ratchet useless. Measured 2026-08-11: twelve of the tree's fifteen
// "adversarial"-named suites were orphaned, which is the worst distribution the
// orphan problem could have, because these are the suites written to attack a
// mechanism from the outside. They are now aggregated by tests/adversarial/run.js
// and each one is pinned here so that unwiring any single one fails loudly
// instead of being absorbed by the ceiling.
for (const adversarial of [
  'tests/controller-launch-scope-adversarial.js',
  'tests/coordinator-backup-age-status-adversarial.test.js',
  'tests/coordinator-backup-observer-adversarial.test.js',
  'tests/coordinator-backup-test-writer-adversarial.test.js',
  'tests/owner-identity-purpose-gate-adversarial-g9.js',
  'tests/owner-identity-reader-audit-adversarial-g9.js',
  'tests/owner-ledger-gate-batch-adversarial-g8.js',
  'tests/owner-request-scope-adversarial.js',
  'tests/owner-request-scope-store-adversarial.js',
  'tests/package-check-adversarial-g8.js',
  'tests/package-manifest-contract-adversarial.js'
  /* telegram-reliability-observation-adversarial-g8.js came off this pinned
     list on 2026-08-23, and the removal is recorded rather than done quietly
     because unpinning a suite is exactly what this list exists to prevent.
     It is not unwired -- THE FILE IS ABSENT, along with every other telegram
     test in the tree, as Telegram is taken out of the product under the
     owner's ruling. Its entry in tests/adversarial/run.js was removed in the
     same change, so nothing now names a path that is not there. Restore both
     entries together if a telegram suite ever returns. */
]) {
  assert.ok(census.reachable.includes(adversarial), `${adversarial} must stay wired into an aggregate (tests/adversarial/run.js)`);
}

// No adversarial suite may be orphaned, including ones added after this file
// was written. The pinned list above cannot see a suite that does not exist
// yet, and "we listed the ones we knew about" is how the twelve got there.
const orphanedAdversarial = census.orphaned.filter((testPath) => /adversarial/i.test(testPath));
assert.deepEqual(
  orphanedAdversarial,
  [],
  `adversarial suites are orphaned: ${orphanedAdversarial.join(', ')}. Add them to tests/adversarial/run.js.`
);

// The gate's own regression suite. An unrun ratchet is worse than no ratchet:
// it reads as protection while asserting nothing.
assert.ok(census.reachable.includes('tests/test-ratchet.test.js'), 'tests/test-ratchet.test.js must stay wired (tests/repo-protocol/run.js)');
assert.ok(census.reachable.includes('tests/naming-ratchet.test.js'), 'tests/naming-ratchet.test.js must stay wired (tests/repo-protocol/run.js)');

process.stdout.write(`test-census: ${census.counts.orphaned}/${census.counts.candidates} orphaned candidate tests\n`);
