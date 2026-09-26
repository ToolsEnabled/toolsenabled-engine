'use strict';

const assert = require('node:assert/strict');
const {
  PackageManifestError,
  normalizePackageId,
  normalizeRepoRelativePath,
  normalizePackageManifest
} = require('../../src/lib/package-manifest-contract');

function fixture() {
  return {
    schemaVersion: 1,
    packages: [
      { id: 'providers.chrome-web-store', files: ['sidecars/local-coder/bin/server.js'] },
      { id: 'tools.pkg', files: ['tools/package-check.js'] },
      { id: 'kernel.audit', files: ['src/lib/audit.js', 'src/lib/audit-store.js'] }
    ]
  };
}

function rejects(operation, code) {
  assert.throws(operation, error => error instanceof PackageManifestError && error.code === code);
}

for (const mutate of [
  value => Object.defineProperty(value, 'schemaVersion', { enumerable: true, get() { throw new Error('getter must not run'); } }),
  value => { value[Symbol('injected')] = true; },
  value => Object.setPrototypeOf(value, { injected: true }),
  value => { value.packages[0][Symbol('injected')] = true; },
  value => Object.defineProperty(value.packages[0].files, '0', { enumerable: true, get() { throw new Error('getter must not run'); } })
]) {
  const input = fixture();
  mutate(input);
  rejects(() => normalizePackageManifest(input), 'PACKAGE_MANIFEST_UNSAFE_OBJECT');
}

for (const id of ['__proto__', 'kernel.constructor', 'prototype.tools', 'Kernel.audit', 'kernel..audit']) {
  rejects(() => normalizePackageId(id), id.includes('proto') || id.includes('constructor') || id.includes('prototype')
    ? 'PACKAGE_MANIFEST_UNSAFE_OBJECT' : 'PACKAGE_MANIFEST_INVALID_ID');
}

for (const value of [
  '../src/lib/index.js', 'src/../lib/index.js', '/src/lib/index.js', 'C:/src/lib/index.js',
  'C:\\src\\lib\\index.js', 'src\\lib\\index.js', 'src/lib/index.ts', 'node_modules/pkg/index.js'
]) {
  rejects(() => normalizeRepoRelativePath(value, 'path'), 'PACKAGE_MANIFEST_INVALID_PATH');
}

{
  const duplicate = fixture();
  duplicate.packages[1].files.push('src/lib/audit.js');
  rejects(() => normalizePackageManifest(duplicate), 'PACKAGE_MANIFEST_DUPLICATE_CLAIM');
}

{
  const duplicate = fixture();
  duplicate.packages.push({ id: 'kernel.audit', files: ['src/lib/other.js'] });
  rejects(() => normalizePackageManifest(duplicate), 'PACKAGE_MANIFEST_DUPLICATE_PACKAGE');
}

for (const packages of [
  [{ id: 'tools.pkg', files: ['tools/package-check.js'] }, { id: 'kernel.audit', files: ['src/lib/audit.js'] }],
  [{ id: 'providers.chrome-web-store', files: ['sidecars/local-coder/bin/server.js'] }, { id: 'tools.pkg', files: ['tools/package-check.js'] }],
  [{ id: 'providers.chrome-web-store', files: ['sidecars/local-coder/bin/server.js'] }, { id: 'kernel.audit', files: ['src/lib/audit.js'] }]
]) {
  rejects(() => normalizePackageManifest({ schemaVersion: 1, packages }), 'PACKAGE_MANIFEST_MISSING_SOURCE_CATEGORY');
}

const normalized = normalizePackageManifest(fixture());
assert.equal(Object.isFrozen(normalized), true);
assert.equal(Object.isFrozen(normalized.packages), true);
assert.equal(Object.isFrozen(normalized.packages[0]), true);
assert.equal(Object.isFrozen(normalized.packages[0].files), true);
assert.equal(Object.isFrozen(normalized.claims), true);
assert.equal(Object.isFrozen(normalized.claims[0]), true);
assert.throws(() => { normalized.packages[0].files.push('src/lib/new.js'); }, TypeError);

const reordered = fixture();
reordered.packages.reverse();
reordered.packages[0].files.reverse();
assert.deepEqual(normalizePackageManifest(reordered), normalized);

process.stdout.write('Package manifest adversarial tests passed.\n');
