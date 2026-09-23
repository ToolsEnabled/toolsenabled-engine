'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  allowlistCovers,
  buildFileManifest,
  validateManifestEntry,
  validateSafeMode,
  validateSafePath,
} = require('../src/cloud/file-manifest');
const { ALLOWED_FILE_MODES, FILE_MANIFEST_SCHEMA } = require('../src/cloud/constants');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const ALLOWLIST = Object.freeze(['docs/readme.md', 'src/*']);

function entry(path, overrides = {}) {
  return { path, mode: '100644', blobHash: HASH_A, byteLength: 10, ...overrides };
}

test('file manifests derive one manifestId regardless of entry and allowlist order', () => {
  const first = buildFileManifest(
    [entry('src/alpha.js'), entry('docs/readme.md', { blobHash: HASH_B, byteLength: 3 })],
    { allowlist: ['docs/readme.md', 'src/*'] },
  );
  const second = buildFileManifest(
    [entry('docs/readme.md', { blobHash: HASH_B, byteLength: 3 }), entry('src/alpha.js')],
    { allowlist: ['src/*', 'docs/readme.md', 'src/*'] },
  );
  assert.equal(first.manifestId, second.manifestId);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, FILE_MANIFEST_SCHEMA);
  assert.deepEqual(first.entries.map((item) => item.path), ['docs/readme.md', 'src/alpha.js']);
  assert.deepEqual(first.allowlist, ['docs/readme.md', 'src/*']);
  assert.equal(first.totalBytes, 13);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.entries));
  assert.ok(Object.isFrozen(first.entries[0]));
});

test('manifest entries sort by code units so ids are stable across locales', () => {
  const paths = ['B-upper.txt', 'a-lower.txt', 'a_underscore.txt'];
  const manifest = buildFileManifest(
    paths.map((path) => entry(path)),
    { allowlist: paths },
  );
  assert.deepEqual(manifest.entries.map((item) => item.path), [...paths].sort());
  assert.equal(manifest.entries[0].path, 'B-upper.txt');
});

test('path traversal, absolute, and non-POSIX paths are refused', () => {
  const unsafe = [
    '../escape.txt',
    'src/../escape.txt',
    'src/..',
    '/etc/passwd',
    '~/secrets.txt',
    'src\\windows.txt',
    'C:/windows.txt',
    'C:\\windows.txt',
    'src//double.txt',
    'src/./current.txt',
    'src/nul\u0000.txt',
    'src/bell\u0007.txt',
    '',
  ];
  for (const path of unsafe) {
    assert.throws(() => validateSafePath(path), { code: 'CLOUD_UNSAFE_PATH' }, `expected refusal: ${JSON.stringify(path)}`);
    assert.throws(
      () => buildFileManifest([entry(path)], { allowlist: ALLOWLIST }),
      { code: 'CLOUD_UNSAFE_PATH' },
    );
  }
  assert.throws(() => validateSafePath(42), { code: 'CLOUD_UNSAFE_PATH' });
  assert.equal(validateSafePath('src/nested/ok.txt'), 'src/nested/ok.txt');
});

test('symlink, gitlink, and tree modes are refused', () => {
  assert.deepEqual(ALLOWED_FILE_MODES, ['100644', '100755']);
  for (const mode of ['120000', '160000', '040000', '100600', '0644']) {
    assert.throws(() => validateSafeMode(mode), { code: 'CLOUD_UNSAFE_MODE' }, `expected refusal: ${mode}`);
    assert.throws(
      () => buildFileManifest([entry('src/alpha.js', { mode })], { allowlist: ALLOWLIST }),
      { code: 'CLOUD_UNSAFE_MODE' },
    );
  }
  // Empty and non-string modes fail the closed non-empty-string precheck.
  assert.throws(() => validateSafeMode(''), { code: 'CLOUD_UNSAFE_PATH' });
  assert.throws(() => validateSafeMode(0o100644), { code: 'CLOUD_UNSAFE_PATH' });
  const executable = buildFileManifest([entry('src/run.sh', { mode: '100755' })], { allowlist: ALLOWLIST });
  assert.equal(executable.entries[0].mode, '100755');
});

test('allowlist territory is enforced and the recorded allowlist is closed', () => {
  assert.ok(allowlistCovers(['src/*'], 'src/deep/nested.js'));
  assert.ok(!allowlistCovers(['src/*'], 'srcx/escape.js'));
  assert.ok(allowlistCovers(['docs/readme.md'], 'docs/readme.md'));
  assert.ok(!allowlistCovers(['docs/readme.md'], 'docs/readme.md.bak'));
  assert.throws(
    () => buildFileManifest([entry('outside/file.txt')], { allowlist: ALLOWLIST }),
    { code: 'CLOUD_ALLOWLIST_VIOLATION' },
  );
  for (const allowlist of [undefined, [], ['src/*', ''], ['src/*', 42], 'src/*']) {
    assert.throws(
      () => buildFileManifest([entry('src/alpha.js')], { allowlist }),
      { code: 'CLOUD_ALLOWLIST_VIOLATION' },
    );
  }
});

test('an allowlist with index getters cannot smuggle unvalidated rules', () => {
  const tricky = ['src/*'];
  let reads = 0;
  Object.defineProperty(tricky, 1, {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? 'docs/readme.md' : '';
    },
  });
  tricky.length = 2;
  const manifest = buildFileManifest([entry('src/alpha.js')], { allowlist: tricky });
  assert.deepEqual(manifest.allowlist, ['docs/readme.md', 'src/*']);
});

test('duplicate manifest paths are refused, identical or conflicting', () => {
  assert.throws(
    () => buildFileManifest([entry('src/alpha.js'), entry('src/alpha.js')], { allowlist: ALLOWLIST }),
    { code: 'CLOUD_DUPLICATE_PATH' },
  );
  assert.throws(
    () => buildFileManifest(
      [entry('src/alpha.js'), entry('src/alpha.js', { blobHash: HASH_B, byteLength: 99 })],
      { allowlist: ALLOWLIST },
    ),
    { code: 'CLOUD_DUPLICATE_PATH' },
  );
});

test('byte budgets refuse oversized files, oversized totals, and non-integer lengths', () => {
  assert.throws(
    () => buildFileManifest([entry('src/alpha.js', { byteLength: 11 })], { allowlist: ALLOWLIST, maxFileBytes: 10 }),
    { code: 'CLOUD_SIZE_BUDGET_EXCEEDED' },
  );
  assert.throws(
    () => buildFileManifest(
      [entry('src/alpha.js', { byteLength: 6 }), entry('src/beta.js', { byteLength: 5 })],
      { allowlist: ALLOWLIST, maxTotalBytes: 10 },
    ),
    { code: 'CLOUD_SIZE_BUDGET_EXCEEDED' },
  );
  for (const byteLength of [-1, 1.5, Number.NaN, '10', 2 ** 53]) {
    assert.throws(
      () => buildFileManifest([entry('src/alpha.js', { byteLength })], { allowlist: ALLOWLIST }),
      { code: 'CLOUD_SIZE_BUDGET_EXCEEDED' },
    );
  }
  const within = buildFileManifest(
    [entry('src/alpha.js', { byteLength: 6 }), entry('src/beta.js', { byteLength: 4 })],
    { allowlist: ALLOWLIST, maxFileBytes: 6, maxTotalBytes: 10 },
  );
  assert.equal(within.totalBytes, 10);
});

test('manifest entries are closed objects: extra fields, missing fields, and accessors are refused', () => {
  assert.throws(
    () => validateManifestEntry({ ...entry('src/alpha.js'), note: 'extra' }),
    { code: 'CLOUD_UNSAFE_PATH' },
  );
  const missing = entry('src/alpha.js');
  delete missing.blobHash;
  assert.throws(() => validateManifestEntry(missing), { code: 'CLOUD_UNSAFE_PATH' });
  assert.throws(() => validateManifestEntry(null), { code: 'CLOUD_UNSAFE_PATH' });
  assert.throws(() => validateManifestEntry([entry('src/alpha.js')]), { code: 'CLOUD_UNSAFE_PATH' });
  assert.throws(() => buildFileManifest([], { allowlist: ALLOWLIST }), { code: 'CLOUD_UNSAFE_PATH' });
  assert.throws(() => buildFileManifest('src/alpha.js', { allowlist: ALLOWLIST }), { code: 'CLOUD_UNSAFE_PATH' });

  const trick = { path: 'src/alpha.js', mode: '100644', byteLength: 1 };
  let reads = 0;
  Object.defineProperty(trick, 'blobHash', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? HASH_A : 'unqualified-swap';
    },
  });
  assert.throws(() => validateManifestEntry(trick), { code: 'CLOUD_UNSAFE_PATH' });
});

test('blob hashes must be algorithm-qualified', () => {
  assert.throws(
    () => validateManifestEntry(entry('src/alpha.js', { blobHash: 'a'.repeat(64) })),
    { code: 'VCS_CONTRACT_VIOLATION' },
  );
  assert.throws(
    () => validateManifestEntry(entry('src/alpha.js', { blobHash: 'sha256:short' })),
    { code: 'VCS_CONTRACT_VIOLATION' },
  );
  const gitBlob = validateManifestEntry(entry('src/alpha.js', { blobHash: `git-sha1:${'c'.repeat(40)}` }));
  assert.equal(gitBlob.blobHash, `git-sha1:${'c'.repeat(40)}`);
});
