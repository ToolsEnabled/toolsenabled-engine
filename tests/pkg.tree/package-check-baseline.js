// NOTHING FOUND
//
// Discrimination audit (2026-08-26): no assertion needed strengthening.
// Mutation: removed packageCheckVerdict's `baseline.state === 'missing'`
// branch from a temporary copy of tools/package-check.js. This test went RED:
//
//   AssertionError [ERR_ASSERTION]: a vanished baseline must never exit CLEAN
//   1 !== 2
//   at tests/pkg.tree/package-check-baseline.js:129:10
//
// The product file was then restored byte-for-byte (SHA-256 before and after:
// 9972c357355cba1a8d44a0dc514d7e26ff4bf528f79abf41bd8845df30e20514),
// and `node tests/pkg.tree/package-check-baseline.js` was GREEN:
//
//   packageCheckVerdict baseline-ratchet tests passed (present/absent/missing/unreadable, regression/stale/clean).
//   readBaseline tests passed (absent/missing/unreadable/present against real git repos, plus the live repository baseline).
//
// NOT-FOUND (1): no assertion body is guarded by an empty-capable collection.
// Both loops have inline, non-empty literal inputs; readBaseline also validates
// all baseline count keys before the live-repository loop can be reached.
// NOT-FOUND (2): no product claim relies merely on non-zero exit or a truthy
// process result. The only subprocess-status assertion requires git status 0
// while arranging a fixture and includes stderr when setup fails.
// NOT-FOUND (3): try/finally blocks only clean up temporary directories; there
// is no catch or optional chain that can swallow an assertion failure.
// NOT-FOUND (4): readBaseline exercises real git repositories, not a mock of
// git or of the package-check functions under test.
// NOT-FOUND (5): there is no skip or platform precondition guard. Preconditions
// met: Node.js, git, and writable OS temporary storage were available.
// NOT-FOUND (6): expected verdicts and parsed baseline fields are explicit
// fixture values. Derived debt counts are independently pinned immediately
// above by exact unmapped-file and layering-violation assertions.

'use strict';

// Coverage for the baseline ratchet in tools/package-check.js: readBaseline
// and the baseline branches of packageCheckVerdict. Neither had any test
// coverage before this file -- tests/pkg.tree/package-check.js and
// package-check-adversarial-g8.js only exercise checkPackageManifest.
//
// Deliberately a separate file from tests/pkg.tree/package-check.js: that
// file has a pre-existing, unrelated failing assertion (runPackageCheck()
// against the live tree currently has ~210 unmapped files -- the exact debt
// this ratchet exists to track, see config/package-check-baseline.json and
// docs' Q100S2-REPORT.md). These are plain top-to-bottom scripts with no test
// framework, so one uncaught assertion aborts every assertion after it in the
// same file; coupling this file's fate to that pre-existing red would hide
// these assertions behind an unrelated failure instead of proving they run.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BASELINE_FILENAME,
  EXIT_CODES,
  checkPackageManifest,
  packageCheckVerdict,
  runPackageCheck,
  readBaseline
} = require('../../tools/package-check');

function fixtureManifest() {
  return {
    schemaVersion: 1,
    packages: [
      { id: 'kernel.audit', files: ['src/lib/audit.js'] },
      { id: 'surface.registry', files: ['src/lib/tool-registry.js'] },
      { id: 'providers.mail', files: ['sidecars/mail/index.js'] },
      { id: 'owner.inbox', files: ['tools/owner-inbox.js'] }
    ]
  };
}

// 1 unmapped file, 1 layering violation, everything else zero.
const debtReport = checkPackageManifest(fixtureManifest(), {
  repositoryFiles: ['tools/unmapped.js', 'src/lib/audit.js', 'tools/owner-inbox.js', 'sidecars/mail/index.js', 'src/lib/tool-registry.js'],
  requireEdges: [{ from: 'sidecars/mail/index.js', to: 'tools/owner-inbox.js' }]
});
assert.equal(debtReport.manifestValid, true);
assert.deepEqual(debtReport.unmappedFiles, ['tools/unmapped.js']);
assert.equal(debtReport.layeringViolations.length, 1);

const cleanReport = checkPackageManifest(fixtureManifest(), {
  repositoryFiles: ['src/lib/audit.js', 'tools/owner-inbox.js', 'sidecars/mail/index.js', 'src/lib/tool-registry.js'],
  requireEdges: []
});
assert.deepEqual(cleanReport.unmappedFiles, [], 'fixture for the clean-verdict cases must actually be clean');
assert.deepEqual(cleanReport.layeringViolations, [], 'fixture for the clean-verdict cases must actually be clean');

function debtCounts() {
  return {
    duplicateClaims: 0,
    duplicateRepositoryFiles: 0,
    unmappedFiles: debtReport.unmappedFiles.length,
    orphanedClaims: 0,
    unmappedEdges: 0,
    layeringViolations: debtReport.layeringViolations.length
  };
}

// --- packageCheckVerdict: the baseline ratchet ------------------------------

{
  const findings = Object.fromEntries(Object.keys(debtCounts()).map(key => [key, debtReport[key]]));
  const baseline = { state: 'present', counts: debtCounts(), findings };
  assert.equal(packageCheckVerdict(debtReport, baseline).status, 'clean');
  for (const replacement of [
    { ...debtReport, unmappedFiles: ['tools/new-regression.js'] },
    { ...debtReport, layeringViolations: [{ ...debtReport.layeringViolations[0],
      from: 'tools/owner-inbox.js', fromPackage: 'owner.inbox',
      to: 'sidecars/mail/index.js', toPackage: 'providers.mail' }] },
  ]) {
    const verdict = packageCheckVerdict(replacement, baseline);
    assert.equal(verdict.status, 'regression', 'replacing an old finding must fail even when every count is unchanged');
    assert.equal(verdict.exitCode, EXIT_CODES.VIOLATIONS);
  }
  const smallerButNew = { ...debtReport, unmappedFiles: [], layeringViolations: [{ ...debtReport.layeringViolations[0], to: 'tools/new-regression.js' }] };
  assert.equal(packageCheckVerdict(smallerButNew, baseline).status, 'regression',
    'an improved total cannot authorize a different new violation');
  assert.equal(packageCheckVerdict(cleanReport, baseline).status, 'baseline-stale',
    'removing recorded findings still asks for a reviewed lower baseline');
}

{
  // No baseline at all (null) and an explicit `absent` object behave
  // identically: report the raw count, not a regression claim.
  for (const baseline of [null, { state: 'absent', path: '/nowhere' }]) {
    const verdict = packageCheckVerdict(debtReport, baseline);
    assert.equal(verdict.exitCode, EXIT_CODES.VIOLATIONS);
    assert.equal(verdict.status, 'violations');
    assert.match(verdict.reason, /no config[/\\]package-check-baseline\.json on this branch/);
  }
  const verdict = packageCheckVerdict(cleanReport, null);
  assert.equal(verdict.exitCode, EXIT_CODES.CLEAN);
  assert.equal(verdict.status, 'clean');
}

{
  const verdict = packageCheckVerdict(debtReport, { state: 'present', path: '/x', counts: debtCounts() });
  assert.equal(verdict.exitCode, EXIT_CODES.CLEAN, 'matching baseline is clean even though raw debt is nonzero');
  assert.equal(verdict.status, 'clean');
  assert.match(verdict.reason, /known debt unchanged/);
}

{
  const lower = debtCounts();
  lower.unmappedFiles -= 1;
  const verdict = packageCheckVerdict(debtReport, { state: 'present', path: '/x', counts: lower });
  assert.equal(verdict.exitCode, EXIT_CODES.VIOLATIONS);
  assert.equal(verdict.status, 'regression', 'a count above baseline is a regression, never silently accepted');
  assert.match(verdict.reason, /package debt GREW/);
}

{
  const higher = debtCounts();
  higher.layeringViolations += 3;
  const verdict = packageCheckVerdict(debtReport, { state: 'present', path: '/x', counts: higher });
  assert.equal(verdict.exitCode, EXIT_CODES.VIOLATIONS);
  assert.equal(verdict.status, 'baseline-stale', 'improvement must be re-pinned, not silently absorbed');
  assert.match(verdict.reason, /commit the new lower baseline/);
}

{
  // A malformed baseline file is a broken instrument, not a green light.
  const verdict = packageCheckVerdict(debtReport, { state: 'unreadable', path: '/x', detail: 'not valid JSON (boom)' });
  assert.equal(verdict.exitCode, EXIT_CODES.INDETERMINATE);
  assert.equal(verdict.status, 'indeterminate');
  assert.match(verdict.reason, /could not be read/);
  assert.match(verdict.reason, /boom/);
}

{
  // THE defect this task exists to close: a baseline git still tracks at
  // HEAD but that is absent from the working tree must fail loudly, not
  // silently pass and not silently regenerate itself.
  const missingBaseline = {
    state: 'missing',
    path: '/repo/config/package-check-baseline.json',
    detail: 'git tracks this path at the current commit but the working tree does not have it'
  };
  const verdictOnDebt = packageCheckVerdict(debtReport, missingBaseline);
  assert.equal(verdictOnDebt.exitCode, EXIT_CODES.INDETERMINATE, 'a vanished baseline must never exit CLEAN');
  assert.equal(verdictOnDebt.status, 'indeterminate');
  assert.match(verdictOnDebt.reason, /is committed on this branch but missing from the working tree/);
  assert.match(verdictOnDebt.reason, /git checkout --/);
  assert.match(verdictOnDebt.reason, /--write-baseline/);

  // The dangerous case: raw counts happen to be clean at the exact moment the
  // baseline vanished. Without the `missing` branch this would reach the
  // bottom "no baseline on this branch" fallback and exit 0 -- the vacuous
  // pass this whole change exists to prevent.
  const verdictOnClean = packageCheckVerdict(cleanReport, missingBaseline);
  assert.equal(verdictOnClean.exitCode, EXIT_CODES.INDETERMINATE, 'a vanished baseline must fail loudly even when raw counts look clean');
  assert.notEqual(verdictOnClean.exitCode, EXIT_CODES.CLEAN);
}

{
  // Guard ordering: earlier guards (invalid manifest, unscanned tree) must
  // still win even with a healthy, present, matching baseline -- the new
  // `missing` branch does not need to catch what they already catch.
  assert.equal(packageCheckVerdict({ manifestValid: false }, { state: 'present', path: '/x', counts: debtCounts() }).status, 'indeterminate');
  const unscanned = checkPackageManifest(fixtureManifest(), {});
  assert.equal(unscanned.repositoryFilesProvided, false);
  assert.equal(
    packageCheckVerdict(unscanned, { state: 'present', path: '/x', counts: debtCounts() }).status,
    'indeterminate',
    'an unscanned tree must not read as clean even with a present, matching baseline'
  );
}

{
  // Supplying empty observation arrays is not proof that a scan ran. Without
  // a non-zero floor, all six finding counts are zero and a zero baseline can
  // turn a zero-item scan into a clean verdict.
  const emptyScan = checkPackageManifest(fixtureManifest(), {
    repositoryFiles: [],
    requireEdges: []
  });
  const verdict = packageCheckVerdict(emptyScan, null);
  assert.equal(verdict.exitCode, EXIT_CODES.INDETERMINATE);
  assert.equal(verdict.status, 'indeterminate');
  assert.match(verdict.reason, /observed zero files/);
}

console.log('packageCheckVerdict baseline-ratchet tests passed (present/absent/missing/unreadable, regression/stale/clean).');

// --- readBaseline: the file-vs-git-tracking distinction ---------------------
// readBaseline shells out to git, so these run against real temporary git
// repositories rather than mocks -- the tracked/untracked distinction is
// exactly what `git ls-files` decides, and a mock could assert the wrong
// thing about that decision without anyone noticing.

function makeTempGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-check-baseline-readbaseline-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result;
  };
  git('init', '-q');
  git('config', 'user.email', 'probe@example.invalid');
  git('config', 'user.name', 'package-check-baseline-test');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  return { root, git };
}

function removeTempDir(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

{
  // Exercise the public writer, not just the verdict helper: it used to bypass
  // the ratchet and turn newly introduced debt into an accepted baseline.
  const { root, git } = makeTempGitRepo();
  try {
    fs.mkdirSync(path.join(root, 'tools'));
    fs.mkdirSync(path.join(root, 'sidecars'));
    fs.mkdirSync(path.join(root, 'src/lib'), { recursive: true });
    for (const file of ['tools/package-check.js', 'src/lib/package-manifest-contract.js']) {
      fs.copyFileSync(path.resolve(__dirname, '../..', file), path.join(root, file));
    }
    fs.writeFileSync(path.join(root, 'src/a.js'), "require('./b');\n");
    fs.writeFileSync(path.join(root, 'src/b.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(root, 'src/c.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(root, 'sidecars/fixture.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(root, 'config/packages.json'), JSON.stringify({ schemaVersion: 1, packages: [
      { id: 'entry.cli', files: ['tools/package-check.js', 'sidecars/fixture.js'] },
      { id: 'kernel.contract', files: ['src/lib/package-manifest-contract.js'] },
      { id: 'kernel.audit', files: ['src/a.js'] }, { id: 'surface.policy', files: ['src/b.js', 'src/c.js'] }
    ] }));
    const baselinePath = path.join(root, BASELINE_FILENAME);
    const counts = { ...debtCounts(), unmappedFiles: 0, layeringViolations: 0 };
    fs.writeFileSync(baselinePath, JSON.stringify({ counts }));
    git('add', '.'); git('commit', '-q', '-m', 'Reviewed empty baseline');
    const invoke = () => spawnSync(process.execPath, ['tools/package-check.js', '--write-baseline'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000
    });
    const before = fs.readFileSync(baselinePath);
    const regression = invoke();
    assert.equal(regression.status, EXIT_CODES.VIOLATIONS, regression.stdout + regression.stderr);
    assert.match(regression.stdout, /REGRESSION/);
    assert.deepEqual(fs.readFileSync(baselinePath), before, 'the writer cannot raise a reviewed baseline');
    const historical = runPackageCheck({ rootDirectory: root });
    fs.writeFileSync(baselinePath, JSON.stringify({ schemaVersion: 2,
      counts: { ...counts, layeringViolations: 1 },
      findings: Object.fromEntries(Object.keys(counts).map(key => [key, historical[key]])) }));
    git('add', BASELINE_FILENAME); git('commit', '-q', '-m', 'Historical fixture debt');
    const exactBefore = fs.readFileSync(baselinePath);
    fs.writeFileSync(path.join(root, 'src/a.js'), "require('./c');\n");
    const substitution = invoke();
    assert.equal(substitution.status, EXIT_CODES.VIOLATIONS, substitution.stdout + substitution.stderr);
    assert.match(substitution.stdout, /REGRESSION/);
    assert.deepEqual(fs.readFileSync(baselinePath), exactBefore, 'the writer cannot replace an old violation with a new one');
    fs.writeFileSync(path.join(root, 'src/a.js'), '// debt repaired\n');
    const improvement = invoke();
    assert.equal(improvement.status, EXIT_CODES.CLEAN, improvement.stdout + improvement.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(baselinePath, 'utf8')).counts, counts);
    assert.equal(readBaseline(root).state, 'present');
    assert.deepEqual(readBaseline(root).findings.layeringViolations, []);
  } finally { removeTempDir(root); }
}

{
  // Never tracked at HEAD: the "~30 live worktrees predate the ratchet" case.
  // Absent, not an error.
  const { root } = makeTempGitRepo();
  try {
    const result = readBaseline(root);
    assert.equal(result.state, 'absent');
    assert.equal(result.path, path.join(root, BASELINE_FILENAME));
  } finally {
    removeTempDir(root);
  }
}

{
  // Committed, then the working-tree copy vanishes without a matching commit
  // -- reproduces the incident this task investigates (a fresh
  // --write-baseline write colliding with tests/run-isolated.js's
  // config-integrity guard, which fs.rmSync's any untracked file it did not
  // expect to see on disk -- see the comment above isBaselineTrackedAtHead in
  // tools/package-check.js). Must read `missing`, never `absent`.
  const { root, git } = makeTempGitRepo();
  try {
    const baselinePath = path.join(root, BASELINE_FILENAME);
    fs.writeFileSync(baselinePath, JSON.stringify({
      counts: { duplicateClaims: 0, duplicateRepositoryFiles: 0, unmappedFiles: 1, orphanedClaims: 0, unmappedEdges: 0, layeringViolations: 2 }
    }), 'utf8');
    git('add', BASELINE_FILENAME);
    git('commit', '-q', '-m', 'add baseline');
    fs.rmSync(baselinePath, { force: true });

    const result = readBaseline(root);
    assert.equal(result.state, 'missing', 'a baseline git still tracks at HEAD must never read as `absent`');
    assert.match(result.detail, /git tracks this path/);

    const verdict = packageCheckVerdict(debtReport, result);
    assert.equal(verdict.exitCode, EXIT_CODES.INDETERMINATE, 'readBaseline output must drive packageCheckVerdict to fail loudly end to end');
  } finally {
    removeTempDir(root);
  }
}

{
  // Present but not valid JSON.
  const { root } = makeTempGitRepo();
  try {
    fs.writeFileSync(path.join(root, BASELINE_FILENAME), '{not json', 'utf8');
    const result = readBaseline(root);
    assert.equal(result.state, 'unreadable');
    assert.match(result.detail, /not valid JSON/);
  } finally {
    removeTempDir(root);
  }
}

{
  // Present, valid JSON, but no counts object.
  const { root } = makeTempGitRepo();
  try {
    fs.writeFileSync(path.join(root, BASELINE_FILENAME), JSON.stringify({ comment: 'no counts here' }), 'utf8');
    const result = readBaseline(root);
    assert.equal(result.state, 'unreadable');
    assert.match(result.detail, /"counts" object/);
  } finally {
    removeTempDir(root);
  }
}

{
  // Present, has counts, but one key is not a non-negative integer.
  const { root } = makeTempGitRepo();
  try {
    fs.writeFileSync(path.join(root, BASELINE_FILENAME), JSON.stringify({
      counts: { duplicateClaims: 0, duplicateRepositoryFiles: 0, unmappedFiles: -1, orphanedClaims: 0, unmappedEdges: 0, layeringViolations: 0 }
    }), 'utf8');
    const result = readBaseline(root);
    assert.equal(result.state, 'unreadable');
    assert.match(result.detail, /counts\.unmappedFiles/);
  } finally {
    removeTempDir(root);
  }
}

{
  // Present and valid: normal ratchet operation, unaffected by this change.
  const { root, git } = makeTempGitRepo();
  try {
    const counts = { duplicateClaims: 1, duplicateRepositoryFiles: 2, unmappedFiles: 3, orphanedClaims: 4, unmappedEdges: 5, layeringViolations: 6 };
    fs.writeFileSync(path.join(root, BASELINE_FILENAME), JSON.stringify({ counts }), 'utf8');
    git('add', BASELINE_FILENAME);
    git('commit', '-q', '-m', 'add baseline');
    const result = readBaseline(root);
    assert.equal(result.state, 'present');
    assert.deepEqual(result.counts, counts);
  } finally {
    removeTempDir(root);
  }
}

{
  // Not a git repository at all: git cannot answer tracked-vs-untracked, so
  // this fails closed as unreadable rather than defaulting to the lenient
  // `absent` path.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-check-baseline-nogit-'));
  try {
    const result = readBaseline(root);
    assert.equal(result.state, 'unreadable', 'git being unusable must not be treated as "definitely untracked"');
    assert.match(result.detail, /git could not say whether it should exist/);
  } finally {
    removeTempDir(root);
  }
}

{
  // Live smoke test against the actual repository: the real committed
  // baseline must currently read as `present` with well-formed counts. If
  // this ever reads `missing` here, the incident this task investigates has
  // recurred for real.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const result = readBaseline(repoRoot);
  assert.equal(result.state, 'present', `the repository's own committed ${BASELINE_FILENAME} must be present and well-formed`);
  for (const key of ['duplicateClaims', 'duplicateRepositoryFiles', 'unmappedFiles', 'orphanedClaims', 'unmappedEdges', 'layeringViolations']) {
    assert.ok(Number.isInteger(result.counts[key]) && result.counts[key] >= 0, `baseline.counts.${key} must be a non-negative integer`);
  }
}

console.log('readBaseline tests passed (absent/missing/unreadable/present against real git repos, plus the live repository baseline).');

{
  const { root } = makeTempGitRepo();
  try {
    const file = path.join(root, BASELINE_FILENAME);
    const valid = { schemaVersion: 2, counts: debtCounts(),
      findings: Object.fromEntries(Object.keys(debtCounts()).map(key => [key, debtReport[key]])) };
    fs.writeFileSync(file, JSON.stringify(valid));
    assert.equal(readBaseline(root).state, 'present');
    for (const malformed of [
      { schemaVersion: 2, counts: debtCounts() },
      { ...valid, schemaVersion: 3 },
      { ...valid, findings: { ...valid.findings, layeringViolations: [] } },
      { ...valid, counts: { ...valid.counts, layeringViolations: 2 },
        findings: { ...valid.findings, layeringViolations: [...debtReport.layeringViolations, ...debtReport.layeringViolations] } },
    ]) {
      fs.writeFileSync(file, JSON.stringify(malformed));
      assert.equal(readBaseline(root).state, 'unreadable', 'a missing or ambiguous exact baseline must never become count-only');
    }
  } finally { removeTempDir(root); }
}
console.log('Exact package finding identities refuse substitutions, malformed baselines and CLI baseline replacement.');
