// EXECUTABLE CHANGE
'use strict';

// config/packages.json has exactly ONE writer: a person editing it by hand.
//
// The decision, and why it went this way rather than the other:
//
//   A package claim is a JUDGEMENT, not a fact derivable from the tree. The
//   entry.setup case is the proof -- the same seven files were legal or
//   illegal depending only on the id they were filed under, because the layer
//   is derived from the id's root segment. A generator would have to guess
//   that judgement, and a generator's guess silently overwriting a person's
//   judgement is precisely the failure this file exists to prevent. So the
//   manifest is authoritative and hand-maintained, and no program may write
//   it. In particular tools/package-check.js must stay a READER: a checker
//   that repairs what it checks can never report a violation.
//
// What went wrong without this guard, measured rather than theorised: the same
// two-line manifest change was lost twice in twenty minutes -- once from the
// working tree, and once between verification and commit, so 52ed785 recorded
// packages/entry.setup/PACKAGE.md and a matching tests/package-charters.js
// edit while its config/packages.json edit vanished. The commit message
// described a rename that the commit did not contain. Nothing local
// disagreed; the loss surfaced only when a remote gate contradicted a local
// run. d34ea99 re-applied it.
//
// So this file asserts the two properties that make that loss loud:
//
//   1. The checker never writes the manifest (behaviourally, then statically).
//   2. The manifest's package-id set and the packages/<id>/PACKAGE.md charter
//      set are in exact bijection, minus a short list of named exemptions. A
//      lost manifest write breaks that agreement, because a package is
//      recorded in two places that no single careless write touches at once.
//      Run against 52ed785 this fails twice over: `setup` in the manifest with
//      no charter, and `entry.setup` chartered with no manifest entry.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { EXIT_CODES } = require('../../tools/package-check');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'config', 'packages.json');
const CHECKER = path.join(ROOT, 'tools', 'package-check.js');
const CHARTER_ROOT = path.join(ROOT, 'packages');

// Every refusal below ends with this. A guard that only says "no" sends the
// next reader looking for a tool that does not exist.
const REMEDY = [
  'config/packages.json is hand-maintained and authoritative: edit it directly,',
  'then commit it with an explicit pathspec (`git commit -- config/packages.json ...`)',
  'in the SAME commit as the charter or code change it describes. Do not generate it,',
  'and do not add a tool that rewrites it -- a lost write here is invisible at the',
  'moment it happens. See docs/design/SHIPMENT-PLAN.md B20.'
].join('\n  ');

// ---------------------------------------------------------------------------
// 1. The checker is a reader. Behaviour, not a promise in a comment.
// ---------------------------------------------------------------------------
const before = fs.readFileSync(MANIFEST);
const run = spawnSync(process.execPath, [CHECKER], { cwd: ROOT, encoding: 'utf8' });
const after = fs.readFileSync(MANIFEST);

assert.equal(run.error, undefined, `tools/package-check.js could not be spawned: ${run.error && run.error.message}`);
assert.match(
  run.stdout,
  /^Package boundary report \(report-only\)\r?\nmanifest: (?:valid|INVALID)\r?\nclaims: \d+; repository files: \d+; require edges: \d+$/m,
  `tools/package-check.js did not emit its own report header and scan counts; an allowed exit status alone does not prove the checker loaded.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`
);
assert.ok(
  Object.values(EXIT_CODES).includes(run.status),
  `tools/package-check.js exited ${run.status}, which is outside its own contract (${Object.values(EXIT_CODES).join('/')})`
);
assert.ok(
  before.equals(after),
  `tools/package-check.js CHANGED config/packages.json during a plain run.\n  ${REMEDY}\n`
  + '  (If you are sure the checker did not write it, another lane edited the manifest '
  + 'inside this test\'s ~1s window -- re-run before believing this.)'
);

// ---------------------------------------------------------------------------
// 2. ... and statically so, which does not depend on catching it in the act.
//
// Scoped to one small file we own, so this is exact rather than heuristic:
// enumerate every filesystem-write call site in tools/package-check.js and pin
// the whole list. The single legitimate write is the baseline ratchet, behind
// an explicit --write-baseline flag. Adding any other write fails here with a
// diff naming it.
// ---------------------------------------------------------------------------
const WRITE_APIS = [
  'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream',
  'copyFileSync', 'copyFile', 'renameSync', 'rename', 'rmSync', 'rm', 'rmdirSync', 'rmdir',
  'unlinkSync', 'unlink', 'truncateSync', 'truncate', 'mkdirSync', 'mkdir', 'openSync', 'open'
];
const checkerSource = fs.readFileSync(CHECKER, 'utf8');
const writeSitePattern = new RegExp(String.raw`\bfs(?:\.promises)?\.(${WRITE_APIS.join('|')})\s*\(\s*([^,)\r\n]+)`, 'g');
const writeSites = [...checkerSource.matchAll(writeSitePattern)].map(match => `${match[1]}(${match[2].trim()}`);

assert.deepEqual(
  writeSites,
  ['writeFileSync(baselinePath'],
  `tools/package-check.js gained a filesystem write it did not have.\n  Sites now: ${JSON.stringify(writeSites)}\n  ${REMEDY}\n`
);

// ---------------------------------------------------------------------------
// 3. Manifest ids and charter directories are in bijection.
//
// Each exemption is named with its reason, so extending this list is a
// deliberate, reviewable act rather than a way to make a red test green.
// ---------------------------------------------------------------------------
const CHARTERED_WITHOUT_MANIFEST_ENTRY = new Map([
  ['memory', 'reserved boundary with no current file claims: the charter exists so a future grab-bag memory implementation cannot silently become a dependency of owner.digest or coordinator.core'],
  ['owner.render', 'reserved boundary with no current file claims, same reason as `memory`'],
  ['internal-vcs', 'implementation lives under packages/internal-vcs/src, which package-check does not scan (its roots are src/, tools/, sidecars/), so it has no claimable files']
]);
const DIRECTORIES_WITHOUT_A_CHARTER = new Map([
  ['servercontrol', 'a deployed PowerShell payload staged under packages/, not a JavaScript package boundary']
]);

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const manifestIds = new Set(manifest.packages.map(entry => entry.id));
const directories = fs.readdirSync(CHARTER_ROOT, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name);
const chartered = new Set(directories.filter(name => fs.existsSync(path.join(CHARTER_ROOT, name, 'PACKAGE.md'))));

const uncharteredDirectories = directories.filter(name => !chartered.has(name) && !DIRECTORIES_WITHOUT_A_CHARTER.has(name));
assert.deepEqual(
  uncharteredDirectories,
  [],
  `packages/ directories have no PACKAGE.md and are not on the exemption list: ${uncharteredDirectories.join(', ')}.\n`
  + `  Either write the charter, or add it to DIRECTORIES_WITHOUT_A_CHARTER here WITH a reason.\n  ${REMEDY}\n`
);

const manifestWithoutCharter = [...manifestIds].filter(id => !chartered.has(id)).sort();
assert.deepEqual(
  manifestWithoutCharter,
  [],
  `config/packages.json claims package ids with no packages/<id>/PACKAGE.md charter: ${manifestWithoutCharter.join(', ')}.\n`
  + '  The manifest and the charter tree record the same package in two places; they disagree, so one of the two writes was lost.\n'
  + `  ${REMEDY}\n`
);

const charterWithoutManifest = [...chartered].filter(id => !manifestIds.has(id) && !CHARTERED_WITHOUT_MANIFEST_ENTRY.has(id)).sort();
assert.deepEqual(
  charterWithoutManifest,
  [],
  `packages/<id>/PACKAGE.md charters exist with no config/packages.json entry: ${charterWithoutManifest.join(', ')}.\n`
  + '  This is the exact shape of the lost write in 52ed785: the charter landed, the manifest edit did not.\n'
  + `  Add the package to config/packages.json, or -- if it is deliberately a reserved boundary with no file claims --\n`
  + `  add it to CHARTERED_WITHOUT_MANIFEST_ENTRY here WITH a reason.\n  ${REMEDY}\n`
);

// A reserved exemption must stay reserved. If one of them acquires file claims
// it is no longer an empty boundary, and its absence from the manifest would
// then be a real lost write hiding behind an exemption.
for (const [id, reason] of CHARTERED_WITHOUT_MANIFEST_ENTRY) {
  assert.ok(chartered.has(id), `${id} is exempted here but has no packages/${id}/PACKAGE.md; drop the stale exemption (${reason})`);
  assert.ok(!manifestIds.has(id), `${id} now has a config/packages.json entry, so its exemption is stale -- remove it from CHARTERED_WITHOUT_MANIFEST_ENTRY`);
}

console.log(`config/packages.json single-writer guard passed (checker is read-only; ${manifestIds.size} manifest ids in bijection with ${chartered.size} charters, ${CHARTERED_WITHOUT_MANIFEST_ENTRY.size} named exemptions).`);

// Test-can-fail report (testcanfail-tests-pkg-tree-packages-manifest-writer-js):
// - Strengthened assertion: the spawned checker must identify its report and
//   report numeric scan counts, rather than merely return one of its own exit
//   codes. Mutation: inserted `process.exit(1)` at the start of
//   tools/package-check.js. Before this assertion the test stayed green;
//   afterward it went red with:
//     AssertionError [ERR_ASSERTION]: tools/package-check.js did not emit its
//     own report header and scan counts; an allowed exit status alone does not
//     prove the checker loaded.
//     stdout:
//
//     stderr:
// - NOT-FOUND (1): no vacuous assertion loop. The sole assertion loop ranges
//   over a three-entry literal exemption map; it executes on this tree.
// - NOT-FOUND (3): no try/catch or optional chain swallows an asserted failure.
// - NOT-FOUND (4): no assertion measures a mock of its subject.
// - NOT-FOUND (5): no skip or platform precondition guard exists.
// - NOT-FOUND (6): no expected value is computed by the code under test.
// - Preconditions: all met. The temporary product mutation was restored
//   byte-for-byte. The restored run was green with:
//     config/packages.json single-writer guard passed (checker is read-only;
//     51 manifest ids in bijection with 54 charters, 3 named exemptions).
