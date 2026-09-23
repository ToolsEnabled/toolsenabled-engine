'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
      { id: 'repo-protocol', files: [] },
      { id: 'tools.pkg', files: ['tools/package-check.js'] },
      { id: 'kernel.audit', files: ['src/lib/audit.js', 'src/lib/audit-store.js'] }
    ]
  };
}

function assertCode(operation, code) {
  assert.throws(operation, error => error instanceof PackageManifestError && error.code === code);
}

{
  const normalized = normalizePackageManifest(fixture());
  assert.deepEqual(normalized, {
    schemaVersion: 1,
    packages: [
      { id: 'kernel.audit', files: ['src/lib/audit-store.js', 'src/lib/audit.js'] },
      { id: 'providers.chrome-web-store', files: ['sidecars/local-coder/bin/server.js'] },
      { id: 'repo-protocol', files: [] },
      { id: 'tools.pkg', files: ['tools/package-check.js'] }
    ],
    claims: [
      { file: 'sidecars/local-coder/bin/server.js', packageId: 'providers.chrome-web-store' },
      { file: 'src/lib/audit-store.js', packageId: 'kernel.audit' },
      { file: 'src/lib/audit.js', packageId: 'kernel.audit' },
      { file: 'tools/package-check.js', packageId: 'tools.pkg' }
    ],
    sourceCategories: ['sidecars', 'src', 'tools']
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.packages), true);
  assert.equal(Object.isFrozen(normalized.packages[0]), true);
  assert.equal(Object.isFrozen(normalized.packages[0].files), true);
  assert.equal(Object.isFrozen(normalized.claims[0]), true);
}

assert.equal(normalizePackageId('kernel.runtime'), 'kernel.runtime');
assert.equal(normalizePackageId('repo-protocol'), 'repo-protocol');
assertCode(() => normalizePackageId('Kernel.runtime'), 'PACKAGE_MANIFEST_INVALID_ID');
assertCode(() => normalizePackageId('kernel.__proto__'), 'PACKAGE_MANIFEST_UNSAFE_OBJECT');
assert.equal(normalizeRepoRelativePath('src/lib/index.js'), 'src/lib/index.js');
for (const value of ['../src/lib/index.js', 'src/../lib/index.js', '/src/lib/index.js', 'C:\\src\\lib\\index.js', 'src\\lib\\index.js', 'config/packages.json', 'src/lib/index.ts']) {
  assertCode(() => normalizeRepoRelativePath(value, 'fixture.path'), 'PACKAGE_MANIFEST_INVALID_PATH');
}

{
  const duplicatePackage = fixture();
  duplicatePackage.packages.push({ id: 'kernel.audit', files: ['src/lib/runtime.js'] });
  assertCode(() => normalizePackageManifest(duplicatePackage), 'PACKAGE_MANIFEST_DUPLICATE_PACKAGE');
  const duplicateClaim = fixture();
  duplicateClaim.packages[1].files.push('src/lib/audit.js');
  assertCode(() => normalizePackageManifest(duplicateClaim), 'PACKAGE_MANIFEST_DUPLICATE_CLAIM');
  const missingCategory = fixture();
  missingCategory.packages = missingCategory.packages.filter(entry => entry.id !== 'providers.chrome-web-store');
  assertCode(() => normalizePackageManifest(missingCategory), 'PACKAGE_MANIFEST_MISSING_SOURCE_CATEGORY');
}

{
  assertCode(() => normalizePackageManifest({ ...fixture(), extra: true }), 'PACKAGE_MANIFEST_UNKNOWN_FIELD');
  const unknownEntry = fixture();
  unknownEntry.packages[0].extra = true;
  assertCode(() => normalizePackageManifest(unknownEntry), 'PACKAGE_MANIFEST_UNKNOWN_FIELD');

  const inherited = Object.create({ schemaVersion: 1, packages: fixture().packages });
  assertCode(() => normalizePackageManifest(inherited), 'PACKAGE_MANIFEST_UNSAFE_OBJECT');
  const prototypeField = JSON.parse('{"schemaVersion":1,"packages":[],"__proto__":{}}');
  assertCode(() => normalizePackageManifest(prototypeField), 'PACKAGE_MANIFEST_UNSAFE_OBJECT');

  let accessorCalls = 0;
  const accessor = { schemaVersion: 1 };
  Object.defineProperty(accessor, 'packages', { enumerable: true, get() { accessorCalls += 1; throw new Error('must not run'); } });
  assertCode(() => normalizePackageManifest(accessor), 'PACKAGE_MANIFEST_UNSAFE_OBJECT');
  assert.equal(accessorCalls, 0, 'manifest accessors must be rejected without invocation');

  const arrayAccessor = fixture();
  Object.defineProperty(arrayAccessor.packages, '0', { enumerable: true, get() { accessorCalls += 1; throw new Error('must not run'); } });
  assertCode(() => normalizePackageManifest(arrayAccessor), 'PACKAGE_MANIFEST_UNSAFE_OBJECT');
  assert.equal(accessorCalls, 0, 'array accessors must be rejected without invocation');
}

{
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'lib', 'package-manifest-contract.js'), 'utf8');
  assert.doesNotMatch(source, /node:(?:fs|path|child_process)|\b(?:readdir|readFile|writeFile|rmSync|execFile)\b/,
    'the contract must not acquire filesystem or process authority');
}

console.log('Package manifest contract tests passed (pure validation; no filesystem access).');
