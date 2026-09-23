'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { activate } = require('./lib/isolated-environment');
const isolated = activate('session-workspace-ceiling');
const { captureWorkspaceCeiling, intersectWorkspaceCeiling } = require('../src/lib/session-workspace-ceiling');

function isUnavailable(err) {
  return err instanceof Error && err.code === 'SESSION_WORKSPACE_UNAVAILABLE';
}

function makeTempDir(prefix = 'session-workspace-ceiling-') {
  return fs.mkdtempSync(path.join(isolated.root, prefix));
}

test('capture and intersect: empty roots stay empty', () => {
  const snapshot = captureWorkspaceCeiling([]);
  assert.deepEqual(snapshot, []);

  const allowed = intersectWorkspaceCeiling(snapshot, []);
  assert.deepEqual(allowed, []);
});

test('intersect: same root as captured yields the same canonical root', () => {
  const root = makeTempDir();
  try {
    const snapshot = captureWorkspaceCeiling([root]);
    const allowed = intersectWorkspaceCeiling(snapshot, [root]);
    assert.deepEqual(allowed, [fs.realpathSync(root)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('intersect: a subdirectory of the captured root narrows the allowed set', () => {
  const root = makeTempDir();
  try {
    const sub = fs.mkdtempSync(path.join(root, 'child-'));
    const snapshot = captureWorkspaceCeiling([root]);
    const allowed = intersectWorkspaceCeiling(snapshot, [sub]);
    assert.deepEqual(allowed, [fs.realpathSync(sub)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('intersect: a lexically-prefixed sibling directory is filtered out, not treated as nested', () => {
  const base = makeTempDir();
  try {
    const root = path.join(base, 'root');
    // Shares the string "root" as a prefix but is a SIBLING, not a child.
    const sibling = path.join(base, 'root-sibling');
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);

    const snapshot = captureWorkspaceCeiling([root]);
    const allowed = intersectWorkspaceCeiling(snapshot, [sibling]);
    assert.deepEqual(allowed, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('intersect: a current root that is an ancestor of the captured root retains the captured (narrower) root', () => {
  // An owner broadening a machine-level setting to an ancestor directory
  // must not expand the effective grant to that ancestor, and must not
  // wipe out the already-narrower captured root either.
  const root = makeTempDir();
  try {
    const child = fs.mkdtempSync(path.join(root, 'child-'));
    const snapshot = captureWorkspaceCeiling([child]);
    const allowed = intersectWorkspaceCeiling(snapshot, [root]);
    assert.deepEqual(allowed, [fs.realpathSync(child)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('intersect: the filesystem root as a current ancestor still retains the captured (narrower) root', () => {
  const root = makeTempDir();
  try {
    const snapshot = captureWorkspaceCeiling([root]);
    const allowed = intersectWorkspaceCeiling(snapshot, [path.parse(root).root]);
    assert.deepEqual(allowed, [fs.realpathSync(root)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('intersect: results are deduplicated', () => {
  const root = makeTempDir();
  try {
    const child = fs.mkdtempSync(path.join(root, 'child-'));
    // Two ceiling roots and two current roots that all resolve, pairwise,
    // to the same narrower directory must collapse to one entry.
    const snapshot = captureWorkspaceCeiling([child, child]);
    const allowed = intersectWorkspaceCeiling(snapshot, [child, root]);
    assert.deepEqual(allowed, [fs.realpathSync(child)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('intersect: an unrelated directory outside the ceiling is filtered out', () => {
  const rootA = makeTempDir('session-workspace-ceiling-a-');
  const rootB = makeTempDir('session-workspace-ceiling-b-');
  try {
    const snapshot = captureWorkspaceCeiling([rootA]);
    const allowed = intersectWorkspaceCeiling(snapshot, [rootB]);
    assert.deepEqual(allowed, []);
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test('intersect: mixed allowed and outside current roots keep the allowed one and drop the other', () => {
  const root = makeTempDir();
  const outside = makeTempDir('session-workspace-ceiling-outside-');
  try {
    const sub = fs.mkdtempSync(path.join(root, 'child-'));
    const snapshot = captureWorkspaceCeiling([root]);
    const allowed = intersectWorkspaceCeiling(snapshot, [sub, outside]);
    assert.deepEqual(allowed, [fs.realpathSync(sub)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('intersect: nonempty current roots against an empty ceiling all get filtered out, not thrown', () => {
  const root = makeTempDir();
  try {
    const snapshot = captureWorkspaceCeiling([]);
    const allowed = intersectWorkspaceCeiling(snapshot, [root]);
    assert.deepEqual(allowed, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('intersect: filesystem-root containment is not broken by the "//" double-separator bug', () => {
  // Regression test for a naive `root + path.sep` prefix check: when root
  // is "/", that becomes "//", which fails to match real descendants like
  // "/tmp". path.relative()-based containment must not have this bug.
  const snapshot = captureWorkspaceCeiling([path.parse(isolated.root).root]);
  const real = makeTempDir();
  try {
    const allowed = intersectWorkspaceCeiling(snapshot, [real]);
    assert.deepEqual(allowed, [fs.realpathSync(real)]);
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test('intersect: a removed original root fails closed for the whole call', () => {
  const root = makeTempDir();
  const snapshot = captureWorkspaceCeiling([root]);
  fs.rmSync(root, { recursive: true, force: true });

  assert.throws(() => intersectWorkspaceCeiling(snapshot, [root]), isUnavailable);
});

test('intersect: a directory removed and recreated at the same path fails closed via dev/ino mismatch', () => {
  const base = makeTempDir();
  try {
    const root = path.join(base, 'root');
    fs.mkdirSync(root);
    const snapshot = captureWorkspaceCeiling([root]);
    const before = fs.statSync(root);

    // Rename the original aside within the same disposable tempdir instead
    // of deleting it outright, so its inode stays allocated (referenced
    // under the new name) at the moment the replacement mkdir runs below.
    // This rules out a delete+recreate race reusing the identical inode on
    // filesystems that might otherwise do so, which would make this test
    // flaky rather than actually exercising the mismatch path.
    const asideName = path.join(base, 'root-original-aside');
    fs.renameSync(root, asideName);
    fs.mkdirSync(root);
    const after = fs.statSync(root);

    assert.notEqual(before.ino, after.ino);

    assert.throws(() => intersectWorkspaceCeiling(snapshot, [root]), isUnavailable);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('intersect: a retargeted symlink at the original lexical root fails closed', () => {
  const base = makeTempDir();
  try {
    const dirA = path.join(base, 'a');
    const dirB = path.join(base, 'b');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    const link = path.join(base, 'link');
    fs.symlinkSync(dirA, link, process.platform === 'win32' ? 'junction' : 'dir');

    const snapshot = captureWorkspaceCeiling([link]);
    assert.equal(snapshot[0].canonical, fs.realpathSync(dirA));

    // Retarget the same lexical path to point somewhere else entirely.
    fs.unlinkSync(link);
    fs.symlinkSync(dirB, link, process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(() => intersectWorkspaceCeiling(snapshot, [link]), isUnavailable);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('capture rejects relative paths and non-array inputs', () => {
  const root = makeTempDir();
  try {
    assert.throws(() => captureWorkspaceCeiling('not-an-array'), isUnavailable);
    assert.throws(() => captureWorkspaceCeiling(['relative/path']), isUnavailable);
    assert.throws(() => captureWorkspaceCeiling([root, '']), isUnavailable);
    assert.throws(() => captureWorkspaceCeiling([root, 42]), isUnavailable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('intersect refuses the whole call for a malformed or unreadable current root, not just that entry', () => {
  const root = makeTempDir();
  try {
    const snapshot = captureWorkspaceCeiling([root]);
    assert.throws(() => intersectWorkspaceCeiling(snapshot, 'not-an-array'), isUnavailable);
    assert.throws(() => intersectWorkspaceCeiling(snapshot, ['relative/path']), isUnavailable);
    assert.throws(() => intersectWorkspaceCeiling(snapshot, [root, '']), isUnavailable);
    assert.throws(() => intersectWorkspaceCeiling(snapshot, [path.join(root, 'does-not-exist')]), isUnavailable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('intersect rejects a malformed snapshot', () => {
  assert.throws(() => intersectWorkspaceCeiling('not-an-array', []), isUnavailable);
  assert.throws(() => intersectWorkspaceCeiling([{ lexical: '/x' }], []), isUnavailable);
  assert.throws(() => intersectWorkspaceCeiling([{ lexical: 'relative', canonical: '/x', dev: 1, ino: 1 }], []), isUnavailable);
  assert.throws(() => intersectWorkspaceCeiling([{ lexical: '/x', canonical: '/x' }], []), isUnavailable);
});

test('capture rejects a path that exists but is not a directory', () => {
  const root = makeTempDir();
  try {
    const filePath = path.join(root, 'file.txt');
    fs.writeFileSync(filePath, 'x');
    assert.throws(() => captureWorkspaceCeiling([filePath]), isUnavailable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture rejects a nonexistent directory', () => {
  const root = makeTempDir();
  try {
    const missing = path.join(root, 'does-not-exist');
    assert.throws(() => captureWorkspaceCeiling([missing]), isUnavailable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture and intersect reject sparse arrays', () => {
  const dirA = makeTempDir('session-workspace-ceiling-sparse-a-');
  const dirB = makeTempDir('session-workspace-ceiling-sparse-b-');
  try {
    const sparseRoots = [dirA];
    sparseRoots[2] = dirB; // leaves a hole at index 1
    assert.equal(sparseRoots.length, 3);
    assert.throws(() => captureWorkspaceCeiling(sparseRoots), isUnavailable);

    const snapshot = captureWorkspaceCeiling([dirA]);
    const sparseCurrent = [dirA];
    sparseCurrent[2] = dirA;
    assert.throws(() => intersectWorkspaceCeiling(snapshot, sparseCurrent), isUnavailable);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('captured snapshot and intersection result are deeply frozen', () => {
  const root = makeTempDir();
  try {
    const snapshot = captureWorkspaceCeiling([root]);
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot[0]));

    assert.throws(() => {
      'use strict';
      snapshot.push({ lexical: '/x', canonical: '/x', dev: 1, ino: 1 });
    }, TypeError);
    assert.throws(() => {
      'use strict';
      snapshot[0].lexical = '/tampered';
    }, TypeError);

    const allowed = intersectWorkspaceCeiling(snapshot, [root]);
    assert.ok(Object.isFrozen(allowed));
    assert.throws(() => {
      'use strict';
      allowed.push('/y');
    }, TypeError);
    assert.throws(() => {
      'use strict';
      allowed[0] = '/tampered';
    }, TypeError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mutating the input array after capture does not affect the stored snapshot', () => {
  const root = makeTempDir();
  try {
    const roots = [root];
    const snapshot = captureWorkspaceCeiling(roots);
    roots.push('/tmp/should-not-appear');
    roots[0] = '/tmp/also-should-not-appear';

    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].lexical, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an enumerable extra property cannot disguise a sparse array', () => {
  const sparse = new Array(1); sparse.extra = isolated.root;
  assert.equal(Object.keys(sparse).length, sparse.length);
  assert.throws(() => captureWorkspaceCeiling(sparse), isUnavailable);
  assert.throws(() => intersectWorkspaceCeiling([], sparse), isUnavailable);
});

test('directory identities retain exact bigint stat values as serializable strings', () => {
  const root = makeTempDir();
  try {
    const snapshot = captureWorkspaceCeiling([root]);
    const stat = fs.statSync(root, { bigint: true });
    assert.equal(snapshot[0].dev, stat.dev.toString());
    assert.equal(snapshot[0].ino, stat.ino.toString());
    assert.doesNotThrow(() => JSON.stringify(snapshot));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
