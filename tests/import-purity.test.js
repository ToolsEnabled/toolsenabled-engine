'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function fresh(relative) {
  const file = path.join(ROOT, relative);
  delete require.cache[require.resolve(file)];
  return require(file);
}

test('repo-files provider does not canonicalize the checkout when imported', () => {
  // Stub the provider's heavyweight dependencies so this test measures the
  // provider import itself rather than initializing audit storage or policy.
  const stubs = new Map([
    ['src/lib/policy.js', { assertActive() {} }],
    ['src/lib/audit.js', { record() {}, requireRecord() {} }],
    ['src/lib/canonical-path.js', { canonicalizeForContainment: value => value }]
  ]);
  const saved = [];
  for (const [relative, exports] of stubs) {
    const file = path.join(ROOT, relative);
    saved.push([file, require.cache[file]]);
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  }

  const original = fs.realpathSync.native;
  let canonicalizations = 0;
  fs.realpathSync.native = function countedRealpath(...args) {
    canonicalizations += 1;
    return Reflect.apply(original, this, args);
  };
  try {
    const provider = fresh('src/lib/providers/repo-files.js');
    assert.equal(provider.ROOT, ROOT);
    assert.equal(canonicalizations, 0);
  } finally {
    fs.realpathSync.native = original;
    for (const [file, cached] of saved) {
      if (cached) require.cache[file] = cached;
      else delete require.cache[file];
    }
  }
});

test('repo write distinguishes an absent target from a filesystem that did not answer', () => {
  const stubs = new Map([
    ['src/lib/policy.js', { assertActive() {} }],
    ['src/lib/audit.js', { record() {}, requireRecord() {} }],
    ['src/lib/canonical-path.js', { canonicalizeForContainment: value => value }],
    ['src/lib/shared-write-guard.js', { withSharedWrite(_target, operation) { return operation(); } }]
  ]);
  const saved = [];
  for (const [relative, exports] of stubs) {
    const file = path.join(ROOT, relative);
    saved.push([file, require.cache[file]]);
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  }

  const originals = {
    lstatSync: fs.lstatSync,
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    renameSync: fs.renameSync,
    realpathNative: fs.realpathSync.native
  };
  let lstatErrorCode = 'EMFILE';
  let writes = 0;
  let canonicalizations = 0;
  fs.lstatSync = () => { const error = new Error(lstatErrorCode); error.code = lstatErrorCode; throw error; };
  fs.mkdirSync = () => {};
  fs.writeFileSync = () => { writes += 1; };
  fs.renameSync = () => {};
  fs.realpathSync.native = (...args) => {
    canonicalizations += 1;
    return Reflect.apply(originals.realpathNative, fs.realpathSync, args);
  };

  try {
    const provider = fresh('src/lib/providers/repo-files.js');
    for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
      lstatErrorCode = code;
      assert.throws(
        () => provider.writeFile({ path: 'busy-target.txt', content: 'new' }),
        error => error.code === 'REPO_FILE_EXISTENCE_UNKNOWN'
          && /not a claim that it is absent/.test(error.message)
      );
    }
    assert.equal(writes, 0);

    // CONTROL: genuine absence still permits the write, while the canonical
    // repository root retains its established process-local cache.
    lstatErrorCode = 'ENOENT';
    provider.writeFile({ path: 'absent-target.txt', content: 'first' });
    provider.writeFile({ path: 'another-absent-target.txt', content: 'second' });
    assert.equal(writes, 2);
    assert.equal(canonicalizations, 1);
  } finally {
    Object.assign(fs, {
      lstatSync: originals.lstatSync,
      mkdirSync: originals.mkdirSync,
      writeFileSync: originals.writeFileSync,
      renameSync: originals.renameSync
    });
    fs.realpathSync.native = originals.realpathNative;
    for (const [file, cached] of saved) {
      if (cached) require.cache[file] = cached;
      else delete require.cache[file];
    }
  }
});
