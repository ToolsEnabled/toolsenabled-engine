'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGitShadowImporter } = require('../src/m2/git-shadow-import');
const { createProcessRunner } = require('../src/m2/process-runner');
const { validateRevisionManifest } = require('../src/m2/revision-manifest');

const REQUIRED_NAMESPACES = Object.freeze([
  'refs/heads/main',
  'refs/notes/*',
  'refs/tags/*',
  'refs/toolsenabled/*',
]);

function runGit(cwd, argv) {
  const result = childProcess.spawnSync('git', argv, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`git ${argv.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

function initializeRepository(root) {
  fs.mkdirSync(root, { recursive: true });
  runGit(root, ['init', '-b', 'main']);
  runGit(root, ['config', 'user.name', 'Internal VCS Fixture']);
  runGit(root, ['config', 'user.email', 'fixture@example.invalid']);
}

function writeFile(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function buildFixture(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-vcs-m2-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const childRoot = path.join(fixtureRoot, 'child');
  const repositoryRoot = path.join(fixtureRoot, 'parent');
  initializeRepository(childRoot);
  writeFile(path.join(childRoot, 'child.txt'), 'submodule content\n');
  runGit(childRoot, ['add', 'child.txt']);
  runGit(childRoot, ['commit', '-m', 'child fixture']);

  initializeRepository(repositoryRoot);
  writeFile(path.join(repositoryRoot, 'README.md'), '# shadow import fixture\n');
  runGit(repositoryRoot, ['add', 'README.md']);
  runGit(repositoryRoot, ['commit', '-m', 'initial fixture']);
  runGit(repositoryRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'add', childRoot, 'deps/child']);

  const lfsContent = Buffer.from('fixture binary payload\0with deterministic bytes', 'utf8');
  const lfsOid = crypto.createHash('sha256').update(lfsContent).digest('hex');
  const lfsPointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${lfsOid}\nsize ${lfsContent.length}\n`;
  writeFile(path.join(repositoryRoot, 'assets', 'fixture.bin'), lfsPointer);
  runGit(repositoryRoot, ['add', '.gitmodules', 'deps/child', 'assets/fixture.bin']);
  runGit(repositoryRoot, ['commit', '-m', 'add LFS and submodule fixtures']);
  runGit(repositoryRoot, ['tag', 'fixture-v1']);
  runGit(repositoryRoot, ['notes', '--ref=notes/q100', 'add', '-m', 'fixture note', 'HEAD']);
  runGit(repositoryRoot, ['update-ref', 'refs/toolsenabled/accepted', 'HEAD']);

  const lfsObjectPath = path.join(
    repositoryRoot,
    '.git',
    'lfs',
    'objects',
    lfsOid.slice(0, 2),
    lfsOid.slice(2, 4),
    lfsOid,
  );
  writeFile(lfsObjectPath, lfsContent);
  return { repositoryRoot, lfsObjectPath, submodulePath: path.join(repositoryRoot, 'deps', 'child') };
}

function importer() {
  return createGitShadowImporter({
    runner: createProcessRunner({ defaultTimeoutMs: 20_000, defaultMaxOutputBytes: 8 * 1024 * 1024 }),
    gitExecutable: 'git',
    evidenceTtlMs: 60_000,
    timeoutMs: 20_000,
    maxOutputBytes: 8 * 1024 * 1024,
    clock: () => '2026-08-06T12:00:00.000Z',
  });
}

function importFixture(repositoryRoot, requiredNamespaceIds = REQUIRED_NAMESPACES) {
  return importer().importRevision({
    repositoryLocator: repositoryRoot,
    requiredNamespaceIds,
    policyRevisionId: 'policy:q100-shadow-v1',
    intendedConsumerIds: ['shadow-observer'],
  });
}

function gitState(repositoryRoot) {
  const indexPath = path.join(repositoryRoot, '.git', 'index');
  return {
    head: runGit(repositoryRoot, ['rev-parse', 'HEAD']),
    refs: runGit(repositoryRoot, ['for-each-ref', '--format=%(refname)%09%(objectname)']),
    status: runGit(repositoryRoot, ['status', '--porcelain=v2', '--branch']),
    indexDigest: crypto.createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex'),
  };
}

test('shadow import covers Git, LFS, submodule, note, tag, and custom-ref fixtures without mutation', (t) => {
  const { repositoryRoot } = buildFixture(t);
  const before = gitState(repositoryRoot);
  const result = importFixture(repositoryRoot);
  const after = gitState(repositoryRoot);
  assert.deepEqual(after, before);
  assert.equal(result.observation.mode, 'SHADOW_READ_ONLY');
  assert.equal(result.observation.completeness.state, 'SAFE');
  assert.equal(result.manifest.completeness.state, 'SAFE');
  assert.deepEqual(result.manifest.requiredNamespaceIds, [...REQUIRED_NAMESPACES].sort());
  assert.ok(result.manifest.artifacts.some(artifact => artifact.kind === 'git-lfs-object'));
  assert.ok(result.manifest.artifacts.some(artifact => artifact.kind === 'git-submodule'));
  assert.ok(result.manifest.artifacts.some(artifact => artifact.authorityId === 'refs/notes/q100'));
  assert.ok(result.manifest.artifacts.some(artifact => artifact.authorityId === 'refs/toolsenabled/accepted'));
  assert.deepEqual(validateRevisionManifest(result.manifest), result.manifest);
});

test('missing LFS content yields UNKNOWN with the exact missing artifact', (t) => {
  const { repositoryRoot, lfsObjectPath } = buildFixture(t);
  fs.rmSync(lfsObjectPath);
  const result = importFixture(repositoryRoot);
  const lfsArtifact = result.manifest.artifacts.find(artifact => artifact.kind === 'git-lfs-object');
  assert.equal(result.manifest.completeness.state, 'UNKNOWN');
  assert.ok(result.manifest.completeness.missingArtifactIds.includes(lfsArtifact.artifactId));
});

test('an unavailable submodule commit yields UNKNOWN instead of an optimistic checkout', (t) => {
  const { repositoryRoot, submodulePath } = buildFixture(t);
  fs.renameSync(submodulePath, `${submodulePath}.offline`);
  const result = importFixture(repositoryRoot);
  const submoduleArtifact = result.manifest.artifacts.find(artifact => artifact.kind === 'git-submodule');
  assert.equal(result.manifest.completeness.state, 'UNKNOWN');
  assert.ok(result.manifest.completeness.missingArtifactIds.includes(submoduleArtifact.artifactId));
});

test('missing required custom namespace yields UNKNOWN and names its requirement', (t) => {
  const { repositoryRoot } = buildFixture(t);
  const missingNamespace = 'refs/toolsenabled/not-present';
  const result = importFixture(repositoryRoot, [...REQUIRED_NAMESPACES, missingNamespace]);
  const placeholder = result.manifest.artifacts.find(artifact => artifact.authorityId === missingNamespace);
  assert.equal(result.manifest.completeness.state, 'UNKNOWN');
  assert.equal(placeholder.kind, 'git-namespace-requirement');
  assert.ok(result.manifest.completeness.missingArtifactIds.includes(placeholder.artifactId));
});

test('revision manifests reject canonical content drift', (t) => {
  const { repositoryRoot } = buildFixture(t);
  const { manifest } = importFixture(repositoryRoot);
  const tamperedArtifacts = manifest.artifacts.map((artifact, index) => index === 0
    ? { ...artifact, authorityId: `${artifact.authorityId}:tampered` }
    : artifact);
  assert.throws(
    () => validateRevisionManifest({ ...manifest, artifacts: tamperedArtifacts }),
    { code: 'VCS_INTEGRITY_FAILURE' },
  );
});
