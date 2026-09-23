// EXECUTABLE CHANGE
// testcanfail-tests-source-freeze-js
// Strengthened: status reports an EMFILE existence probe as could-not-tell,
// while the CONTROL preserves ENOENT as the definite, uncached absent answer.
// Mutation: restored existsSync(activePath). RED: "Missing expected exception:
// EMFILE is could-not-tell and must not be reported as an absent active freeze."
// NOT-FOUND (1): no assertion iterates a possibly empty collection.
// NOT-FOUND (2): no product claim relies only on exit status/truthy return; the
// child overwrite check also verifies the source's exact bytes.
// NOT-FOUND (3): no other catch or optional chain swallows the tested failure.
// NOT-FOUND (4): injected fs faults drive rollback branches, but assertions
// measure resulting modes, journals, and error metadata rather than the faults.
// NOT-FOUND (5): no other skip or precondition guard can make a test a no-op.
// NOT-FOUND (6): expected results are literals or independently stated contract
// calculations, not values produced by the production helper being checked.
// Preconditions: symlink creation and read-only enforcement were met when run as
// an unprivileged user; root bypasses the latter and cannot run this file green.
// RESTORED: src/lib/source-freeze.js was restored byte-for-byte after mutation.
// GREEN: "Source-freeze tests passed (17 checks; temp files only, no services or credentials)."

'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  LOCK_DIRECTORY_NAME,
  freezeSources,
  verifySources,
  thawSources,
  sourceFreezeStatus,
  sha256Bytes
} = require('../src/lib/source-freeze');
const { parse } = require('../tools/source-freeze');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  void label;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-freeze-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'artifacts'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = 2;\n');
  return { root, manifest: path.join(root, 'artifacts', 'freeze.json') };
}

function clean(root) {
  for (const file of [
    'src/a.js', 'src/a.old', 'src/b.js', 'src/linked.js',
    'artifacts/freeze.json', 'artifacts/freeze-2.json', 'artifacts/replayed.json',
    'artifacts/freeze.json.released', 'artifacts/freeze.json.recovery',
    'artifacts/freeze.json.release-recovery', 'artifacts/source-freeze-active.json'
  ]) {
    const target = path.join(root, ...file.split('/'));
    if (fs.existsSync(target)) {
      try { fs.chmodSync(target, 0o666); } catch { /* best-effort disposable cleanup */ }
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

check('freeze pins both files and verify accepts the unchanged snapshot', () => {
  const { root, manifest } = fixture();
  try {
    const frozen = freezeSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', paths: ['src/a.js', 'src/b.js'] });
    assert.equal(frozen.fileCount, 2);
    assert.match(frozen.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(path.join(root, 'src', 'a.js')).mode & 0o222, 0);
    assert.equal(fs.statSync(manifest).mode & 0o222, 0);
    assert.deepEqual(verifySources({ repoRoot: root, manifestPath: manifest, manifestSha256: frozen.manifestSha256 }), frozen);
    const status = sourceFreezeStatus({ repoRoot: root });
    assert.equal(status.operationLock, null);
    assert.equal(status.activeFreeze.manifestSha256, frozen.manifestSha256);
    assert.equal(status.activeFreeze.fileCount, 2);
    assert.equal(fs.existsSync(`${manifest}.recovery`), false, 'successful publication removes its recovery journal');
  } finally { clean(root); }
});

check('ordinary child-process overwrite fails while a source set is frozen', () => {
  const { root, manifest } = fixture();
  try {
    freezeSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', paths: ['src/a.js'] });
    const result = childProcess.spawnSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], 'changed')", path.join(root, 'src', 'a.js')], {
      encoding: 'utf8', windowsHide: true, shell: false
    });
    if (process.platform === 'win32') assert.notEqual(result.status, 0, 'Windows read-only bit must refuse an ordinary overwrite');
    assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'module.exports = 1;\n');
  } finally { clean(root); }
});

check('thaw requires both the recorded owner and exact manifest digest', () => {
  const { root, manifest } = fixture();
  try {
    const frozen = freezeSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', paths: ['src/a.js'] });
    assert.throws(() => thawSources({ repoRoot: root, manifestPath: manifest, owner: 'someone-else', manifestSha256: frozen.manifestSha256 }),
      (error) => error.code === 'SOURCE_FREEZE_OWNER_MISMATCH');
    assert.throws(() => thawSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', manifestSha256: '0'.repeat(64) }),
      (error) => error.code === 'SOURCE_FREEZE_DIGEST_MISMATCH');
    const thawed = thawSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', manifestSha256: frozen.manifestSha256 });
    assert.equal(fs.existsSync(manifest), false);
    assert.equal(fs.existsSync(thawed.releasedManifestPath), true);
    assert.equal(fs.existsSync(path.join(root, 'artifacts', 'source-freeze-active.json')), false);
    assert.equal(fs.existsSync(`${manifest}.release-recovery`), false);
    assert.notEqual(fs.statSync(path.join(root, 'src', 'a.js')).mode & 0o200, 0);
    assert.equal(sourceFreezeStatus({ repoRoot: root }).activeFreeze, null);
  } finally { clean(root); }
});

check('one repo-global active set blocks sequential overlap and released replay', () => {
  const { root, manifest } = fixture();
  try {
    const first = freezeSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', paths: ['src/a.js'] });
    assert.throws(() => freezeSources({
      repoRoot: root,
      manifestPath: path.join(root, 'artifacts', 'freeze-2.json'),
      owner: 'controller-r211',
      paths: ['src/b.js']
    }), (error) => error.code === 'SOURCE_FREEZE_ALREADY_ACTIVE');
    thawSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', manifestSha256: first.manifestSha256 });
    const replay = path.join(root, 'artifacts', 'replayed.json');
    fs.copyFileSync(`${manifest}.released`, replay);
    fs.chmodSync(replay, 0o444);
    assert.throws(() => verifySources({ repoRoot: root, manifestPath: replay, manifestSha256: first.manifestSha256 }),
      (error) => error.code === 'SOURCE_FREEZE_ACTIVE_RECORD_MISSING');
  } finally { clean(root); }
});

check('manifest destinations are confined to artifacts and read limits apply before allocation', () => {
  const { root } = fixture();
  try {
    assert.throws(() => freezeSources({
      repoRoot: root,
      manifestPath: path.join(root, 'src', 'freeze.json'),
      owner: 'controller-r211',
      paths: ['src/a.js']
    }), (error) => error.code === 'SOURCE_FREEZE_MANIFEST_PATH_REFUSED');
    assert.throws(() => require('../src/lib/source-freeze')._testing.openPinnedFile(root, 'src/a.js', { maxBytes: 0 }),
      (error) => error.code === 'SOURCE_FREEZE_FILE_TOO_LARGE');
  } finally { clean(root); }
});

check('content tampering is detected before a thaw can restore write access', () => {
  const { root, manifest } = fixture();
  try {
    const frozen = freezeSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', paths: ['src/a.js'] });
    const target = path.join(root, 'src', 'a.js');
    fs.chmodSync(target, 0o666);
    fs.writeFileSync(target, 'tampered\n');
    fs.chmodSync(target, 0o444);
    assert.throws(() => verifySources({ repoRoot: root, manifestPath: manifest, manifestSha256: frozen.manifestSha256 }),
      (error) => error.code === 'SOURCE_FREEZE_CONTENT_DRIFT');
    assert.throws(() => thawSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', manifestSha256: frozen.manifestSha256 }),
      (error) => error.code === 'SOURCE_FREEZE_CONTENT_DRIFT');
    assert.equal(fs.statSync(target).mode & 0o222, 0);
  } finally { clean(root); }
});

check('a repo-wide operation lock refuses overlap before any mode change', () => {
  const { root, manifest } = fixture();
  const lock = path.join(root, LOCK_DIRECTORY_NAME);
  try {
    fs.mkdirSync(lock);
    assert.throws(() => freezeSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', paths: ['src/a.js'] }),
      (error) => error.code === 'SOURCE_FREEZE_OPERATION_LOCKED');
    assert.notEqual(fs.statSync(path.join(root, 'src', 'a.js')).mode & 0o200, 0);
  } finally {
    if (fs.existsSync(lock)) fs.rmdirSync(lock);
    clean(root);
  }
});

check('status distinguishes absent records from records whose existence could not be established', () => {
  const { root } = fixture();
  const lock = path.join(root, LOCK_DIRECTORY_NAME);
  const active = path.join(root, 'artifacts', 'source-freeze-active.json');
  const originalReadFileSync = fs.readFileSync;
  const originalLstatSync = fs.lstatSync;
  try {
    assert.deepEqual(sourceFreezeStatus({ repoRoot: root }), {
      ok: true,
      repoRoot: fs.realpathSync.native(root),
      operationLock: null,
      activeFreeze: null
    }, 'CONTROL: ENOENT remains a definite negative for both records');
    fs.lstatSync = function busyExistenceProbe(candidate, ...args) {
      if (path.resolve(String(candidate)) === active) {
        const error = new Error('injected busy filesystem');
        error.code = 'EMFILE';
        throw error;
      }
      return originalLstatSync.call(fs, candidate, ...args);
    };
    assert.throws(() => sourceFreezeStatus({ repoRoot: root }),
      (error) => error.code === 'SOURCE_FREEZE_ACTIVE_RECORD_UNAVAILABLE'
        && /could not be inspected; this does not mean it is absent: EMFILE/.test(error.message),
      'EMFILE is could-not-tell and must not be reported as an absent active freeze');
    fs.lstatSync = originalLstatSync;
    fs.mkdirSync(lock);
    fs.readFileSync = function unreadableLockRecord(candidate, ...args) {
      if (path.resolve(String(candidate)) === path.join(lock, 'record.json')) {
        const error = new Error('injected unreadable lock record');
        error.code = 'EACCES';
        throw error;
      }
      return originalReadFileSync.call(fs, candidate, ...args);
    };
    assert.throws(() => sourceFreezeStatus({ repoRoot: root }),
      (error) => error.code === 'SOURCE_FREEZE_LOCK_INVALID',
      'an unreadable record is unknown, not an absent lock');
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.lstatSync = originalLstatSync;
    if (fs.existsSync(lock)) fs.rmSync(lock, { recursive: true, force: true });
    clean(root);
  }
});

check('same-content pathname replacement is detected by persisted file identity', () => {
  const { root, manifest } = fixture();
  try {
    const frozen = freezeSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', paths: ['src/a.js'] });
    const target = path.join(root, 'src', 'a.js');
    const displaced = path.join(root, 'src', 'a.old');
    fs.renameSync(target, displaced);
    fs.writeFileSync(target, 'module.exports = 1;\n');
    fs.chmodSync(target, 0o444);
    assert.throws(() => verifySources({ repoRoot: root, manifestPath: manifest, manifestSha256: frozen.manifestSha256 }),
      (error) => error.code === 'SOURCE_FREEZE_CONTENT_DRIFT');
  } finally { clean(root); }
});

check('manifest write-bit changes and exact-schema additions fail closed', () => {
  const first = fixture();
  try {
    const frozen = freezeSources({ repoRoot: first.root, manifestPath: first.manifest, owner: 'controller-r211', paths: ['src/a.js'] });
    fs.chmodSync(first.manifest, 0o666);
    assert.throws(() => verifySources({ repoRoot: first.root, manifestPath: first.manifest, manifestSha256: frozen.manifestSha256 }),
      (error) => error.code === 'SOURCE_FREEZE_NOT_READ_ONLY');
  } finally { clean(first.root); }

  const second = fixture();
  try {
    freezeSources({ repoRoot: second.root, manifestPath: second.manifest, owner: 'controller-r211', paths: ['src/a.js'] });
    fs.chmodSync(second.manifest, 0o666);
    const document = JSON.parse(fs.readFileSync(second.manifest, 'utf8'));
    document.unexpected = true;
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    fs.writeFileSync(second.manifest, bytes);
    fs.chmodSync(second.manifest, 0o444);
    assert.throws(() => verifySources({ repoRoot: second.root, manifestPath: second.manifest, manifestSha256: sha256Bytes(bytes) }),
      (error) => error.code === 'SOURCE_FREEZE_MANIFEST_INVALID');
  } finally { clean(second.root); }
});

check('release collision preserves the sentinel and rolls source modes back to read-only', () => {
  const { root, manifest } = fixture();
  try {
    fs.chmodSync(path.join(root, 'src', 'a.js'), 0o755);
    const originalMode = fs.statSync(path.join(root, 'src', 'a.js')).mode & 0o777;
    const expectedFrozenMode = originalMode & ~0o222;
    const frozen = freezeSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', paths: ['src/a.js', 'src/b.js'] });
    assert.equal(fs.statSync(path.join(root, 'src', 'a.js')).mode & 0o777, expectedFrozenMode);
    fs.writeFileSync(`${manifest}.released`, 'sentinel');
    assert.throws(() => thawSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', manifestSha256: frozen.manifestSha256 }),
      (error) => error.code === 'SOURCE_FREEZE_RELEASE_EXISTS');
    assert.equal(fs.readFileSync(`${manifest}.released`, 'utf8'), 'sentinel');
    assert.equal(fs.statSync(path.join(root, 'src', 'a.js')).mode & 0o777, expectedFrozenMode,
      'failed thaw restores the exact platform frozen mode rather than hard-coding 0444');
    assert.equal(require('../src/lib/source-freeze')._testing.frozenModeFor(0o755), 0o555,
      'the cross-platform executable-mode contract remains 0755 -> 0555');
  } finally { clean(root); }
});

check('thaw registers rollback before its post-mutation identity assertion', () => {
  const { root, manifest } = fixture();
  const target = path.join(root, 'src', 'a.js');
  const originalLstatSync = fs.lstatSync;
  let injected = false;
  try {
    const originalMode = fs.statSync(target).mode & 0o777;
    const expectedFrozenMode = originalMode & ~0o222;
    const frozen = freezeSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', paths: ['src/a.js'] });
    fs.lstatSync = function faultAfterWritableMutation(candidate, options) {
      const stat = originalLstatSync.call(fs, candidate, options);
      if (!injected && options && options.bigint === true
          && path.resolve(String(candidate)) === target
          && (Number(stat.mode & 0o777n) & 0o222) !== 0) {
        injected = true;
        const error = new Error('injected identity assertion failure');
        error.code = 'SOURCE_FREEZE_TEST_ASSERTION_FAULT';
        throw error;
      }
      return stat;
    };
    assert.throws(() => thawSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', manifestSha256: frozen.manifestSha256 }),
      (error) => error.code === 'SOURCE_FREEZE_PATH_REPLACED');
    assert.equal(injected, true);
    assert.equal(fs.statSync(target).mode & 0o777, expectedFrozenMode,
      'the just-mutated handle is included in read-only rollback');
    assert.equal(fs.existsSync(`${manifest}.release-recovery`), false,
      'a complete rollback may remove its release-recovery journal');
  } finally {
    fs.lstatSync = originalLstatSync;
    clean(root);
  }
});

check('incomplete thaw rollback retains exact recovery evidence', () => {
  const { root, manifest } = fixture();
  const target = path.join(root, 'src', 'a.js');
  const originalLstatSync = fs.lstatSync;
  const originalFchmodSync = fs.fchmodSync;
  let writableMutationSeen = false;
  let assertionFaultInjected = false;
  let rollbackFaultInjected = false;
  try {
    const frozen = freezeSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', paths: ['src/a.js'] });
    fs.fchmodSync = function failReadOnlyRollback(fd, mode) {
      if (writableMutationSeen && (mode & 0o222) === 0) {
        rollbackFaultInjected = true;
        const error = new Error('injected rollback chmod failure');
        error.code = 'SOURCE_FREEZE_TEST_ROLLBACK_FAULT';
        throw error;
      }
      const result = originalFchmodSync.call(fs, fd, mode);
      if ((mode & 0o222) !== 0) writableMutationSeen = true;
      return result;
    };
    fs.lstatSync = function faultAfterWritableMutation(candidate, options) {
      const stat = originalLstatSync.call(fs, candidate, options);
      if (writableMutationSeen && !assertionFaultInjected && options && options.bigint === true
          && path.resolve(String(candidate)) === target) {
        assertionFaultInjected = true;
        const error = new Error('injected identity assertion failure');
        error.code = 'SOURCE_FREEZE_TEST_ASSERTION_FAULT';
        throw error;
      }
      return stat;
    };
    let caught;
    try {
      thawSources({ repoRoot: root, manifestPath: manifest, owner: 'controller-r211', manifestSha256: frozen.manifestSha256 });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught && caught.code, 'SOURCE_FREEZE_THAW_ROLLBACK_FAILED');
    assert.equal(assertionFaultInjected, true);
    assert.equal(rollbackFaultInjected, true);
    assert.equal(caught.releaseRecoveryPath, `${manifest}.release-recovery`);
    assert.match(caught.releaseRecoverySha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(caught.releaseRecoveryPath), true);
    assert.equal(sha256Bytes(fs.readFileSync(caught.releaseRecoveryPath)), caught.releaseRecoverySha256,
      'the retained journal matches the digest reported for manual recovery');
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.fchmodSync = originalFchmodSync;
    clean(root);
  }
});

check('mixed original modes are restored exactly and runtime paths are refused', () => {
  const first = fixture();
  try {
    fs.chmodSync(path.join(first.root, 'src', 'b.js'), 0o444);
    const frozen = freezeSources({ repoRoot: first.root, manifestPath: first.manifest, owner: 'controller-r211', paths: ['src/a.js', 'src/b.js'] });
    thawSources({ repoRoot: first.root, manifestPath: first.manifest, owner: 'controller-r211', manifestSha256: frozen.manifestSha256 });
    assert.notEqual(fs.statSync(path.join(first.root, 'src', 'a.js')).mode & 0o200, 0);
    assert.equal(fs.statSync(path.join(first.root, 'src', 'b.js')).mode & 0o222, 0);
  } finally { clean(first.root); }

  const second = fixture();
  try {
    fs.mkdirSync(path.join(second.root, 'config', 'vault'), { recursive: true });
    fs.writeFileSync(path.join(second.root, 'config', 'vault', 'runtime.js'), 'secret-shaped runtime\n');
    assert.throws(() => freezeSources({ repoRoot: second.root, manifestPath: second.manifest, owner: 'controller-r211', paths: ['config/vault/runtime.js'] }),
      (error) => error.code === 'SOURCE_FREEZE_RUNTIME_PATH_REFUSED');
  } finally { clean(second.root); }
});

check('CLI parsing is action-specific and rejects duplicate single-value flags', () => {
  assert.throws(() => parse(['verify', '--repo', 'x', '--repo', 'y', '--manifest', 'm', '--manifest-sha256', '0'.repeat(64)]), /Duplicate option/);
  assert.throws(() => parse(['verify', '--repo', 'x', '--manifest', 'm']), /Usage:/);
  assert.throws(() => parse(['thaw', '--repo', 'x', '--manifest', 'm', '--owner', 'o', '--manifest-sha256', '0'.repeat(64), '--path', 'src/a.js']), /--path is valid only/);
  assert.equal(parse(['verify', '--repo', 'x', '--manifest', 'm', '--manifest-sha256', '0'.repeat(64)]).action, 'verify');
  assert.equal(parse(['status', '--repo', 'x']).action, 'status');
  assert.throws(() => parse(['status', '--repo', 'x', '--manifest', 'm']), /status accepts only/);
});

check('traversal, duplicates, and hard links are refused', () => {
  const first = fixture();
  try {
    assert.throws(() => freezeSources({ repoRoot: first.root, manifestPath: first.manifest, owner: 'controller-r211', paths: ['../escape'] }),
      (error) => error.code === 'SOURCE_FREEZE_PATH_TRAVERSAL');
    assert.throws(() => freezeSources({ repoRoot: first.root, manifestPath: first.manifest, owner: 'controller-r211', paths: ['src/a.js', 'src\\a.js'] }),
      (error) => error.code === 'SOURCE_FREEZE_DUPLICATE_PATH');
    fs.linkSync(path.join(first.root, 'src', 'a.js'), path.join(first.root, 'src', 'linked.js'));
    assert.throws(() => freezeSources({ repoRoot: first.root, manifestPath: first.manifest, owner: 'controller-r211', paths: ['src/a.js'] }),
      (error) => error.code === 'SOURCE_FREEZE_HARDLINK_REFUSED');
  } finally { clean(first.root); }
});

check('a linked parent and a pre-existing manifest fail closed', () => {
  const first = fixture();
  try {
    fs.writeFileSync(first.manifest, 'do not overwrite');
    assert.throws(() => freezeSources({ repoRoot: first.root, manifestPath: first.manifest, owner: 'controller-r211', paths: ['src/a.js'] }),
      (error) => error.code === 'SOURCE_FREEZE_MANIFEST_EXISTS');
    assert.equal(fs.readFileSync(first.manifest, 'utf8'), 'do not overwrite');
  } finally { clean(first.root); }

  const second = fixture();
  const real = path.join(second.root, 'artifacts', 'real-parent');
  const linked = path.join(second.root, 'artifacts', 'linked-parent');
  try {
    fs.mkdirSync(real);
    try {
      fs.symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      throw new Error(`linked-parent precondition failed (${error.code || 'NO_CODE'}): symlink creation is required`, { cause: error });
    }
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true, 'linked-parent precondition must create a symbolic link');
    assert.throws(() => freezeSources({ repoRoot: second.root, manifestPath: path.join(linked, 'freeze.json'), owner: 'controller-r211', paths: ['src/a.js'] }),
      (error) => error.code === 'SOURCE_FREEZE_REPARSE_REFUSED');
  } finally { clean(second.root); }
});

console.log(`Source-freeze tests passed (${checks} checks; temp files only, no services or credentials).`);
