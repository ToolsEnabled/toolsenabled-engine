'use strict';

const assert = require('node:assert/strict');
const {
  REPORT_MODE,
  checkPackageManifest,
  formatPackageCheckReport,
  runPackageCheck
} = require('../../tools/package-check');

function fixtureManifest() {
  return {
    schemaVersion: 1,
    packages: [
      { id: 'kernel.audit', files: ['src/lib/audit.js'] },
      { id: 'surface.registry', files: ['src/lib/tool-registry.js'] },
      { id: 'providers.mail', files: ['sidecars/mail/index.js'] },
      { id: 'repo-protocol', files: [] },
      { id: 'owner.inbox', files: ['tools/owner-inbox.js'] }
    ]
  };
}

function fixtureRecords() {
  return {
    repositoryFiles: [
      'tools/unmapped.js',
      'src/lib/audit.js',
      'tools/owner-inbox.js',
      'sidecars/mail/index.js',
      'src/lib/tool-registry.js'
    ],
    requireEdges: [
      { from: 'src/lib/audit.js', to: 'src/lib/tool-registry.js' },
      { from: 'sidecars/mail/index.js', to: 'tools/owner-inbox.js' },
      { from: 'src/lib/tool-registry.js', to: 'src/lib/audit.js' },
      { from: 'sidecars/mail/index.js', to: 'src/lib/tool-registry.js' }
    ]
  };
}

{
  const report = checkPackageManifest(fixtureManifest(), fixtureRecords());
  assert.equal(report.mode, REPORT_MODE);
  assert.equal(report.manifestValid, true);
  assert.equal(report.repositoryFilesProvided, true);
  assert.equal(report.requireEdgesProvided, true);
  assert.deepEqual(report.summary, { claimCount: 4, repositoryFileCount: 5, requireEdgeCount: 4 });
  assert.deepEqual(report.invalidClaims, []);
  assert.deepEqual(report.duplicateClaims, []);
  assert.deepEqual(report.unmappedFiles, ['tools/unmapped.js']);
  assert.deepEqual(report.orphanedClaims, []);
  assert.deepEqual(report.layeringViolations, [
    {
      code: 'SIDEWAYS_DOMAIN_IMPORT',
      from: 'sidecars/mail/index.js',
      fromPackage: 'providers.mail',
      to: 'tools/owner-inbox.js',
      toPackage: 'owner.inbox'
    },
    {
      code: 'KERNEL_IMPORTS_UP',
      from: 'src/lib/audit.js',
      fromPackage: 'kernel.audit',
      to: 'src/lib/tool-registry.js',
      toPackage: 'surface.registry'
    }
  ]);
  assert.match(formatPackageCheckReport(report), /Package boundary report \(report-only\)/);
  assert.match(formatPackageCheckReport(report), /SIDEWAYS_DOMAIN_IMPORT/);
  assert.equal(Object.isFrozen(report), true);
  assert.deepEqual(report.packageMetrics, [
    { id: 'kernel.audit', fileCount: 1, loc: 0, fanIn: 1, fanOut: 1 },
    { id: 'owner.inbox', fileCount: 1, loc: 0, fanIn: 1, fanOut: 0 },
    { id: 'providers.mail', fileCount: 1, loc: 0, fanIn: 0, fanOut: 2 },
    { id: 'repo-protocol', fileCount: 0, loc: 0, fanIn: 0, fanOut: 0 },
    { id: 'surface.registry', fileCount: 1, loc: 0, fanIn: 2, fanOut: 1 }
  ]);
}

{
  const report = runPackageCheck();
  assert.equal(report.mode, REPORT_MODE);
  assert.equal(report.manifestValid, true, 'the checked-in manifest must parse');
  assert.equal(report.invalidRecords.length, 0, 'tree inspection must yield usable records');
  assert.deepEqual(report.unmappedFiles, [], 'every current source file must be claimed');
  assert.deepEqual(report.orphanedClaims, [], 'every claim must exist in the current source tree');
  assert.ok(report.summary.repositoryFileCount >= 294);
  assert.ok(report.summary.requireEdgeCount > 0);
  assert.ok(report.packageMetrics.some(metric => metric.id === 'pkg.tree' && metric.fileCount >= 2));
  assert.deepEqual(
    report.packageMetrics.find(metric => metric.id === 'repo-protocol'),
    { id: 'repo-protocol', fileCount: 0, loc: 0, fanIn: 0, fanOut: 0 },
    'the protocol-only package remains visible without claiming application source'
  );
}

{
  const report = checkPackageManifest(fixtureManifest(), {
    repositoryFiles: ['src/lib/audit.js', 'src/lib/tool-registry.js', 'sidecars/mail/index.js', 'tools/unmapped.js']
  });
  assert.deepEqual(report.unmappedFiles, ['tools/unmapped.js']);
  assert.deepEqual(report.orphanedClaims, ['tools/owner-inbox.js']);
  assert.deepEqual(report.layeringViolations, []);
}

{
  const ordered = checkPackageManifest(fixtureManifest(), fixtureRecords());
  const manifest = fixtureManifest();
  manifest.packages.reverse();
  const records = fixtureRecords();
  records.repositoryFiles.reverse();
  records.requireEdges.reverse();
  const reordered = checkPackageManifest(manifest, records);
  assert.deepEqual(reordered, ordered, 'ordering of injected parsed records must not change the report');
  assert.equal(formatPackageCheckReport(reordered), formatPackageCheckReport(ordered));
}

{
  const duplicateClaim = fixtureManifest();
  duplicateClaim.packages[1].files.push('src/lib/audit.js');
  let recordsRead = false;
  const records = {};
  Object.defineProperty(records, 'repositoryFiles', {
    enumerable: true,
    get() {
      recordsRead = true;
      throw new Error('records must not be inspected after invalid manifest');
    }
  });
  const report = checkPackageManifest(duplicateClaim, records);
  assert.equal(recordsRead, false, 'malformed manifests fail closed before injected records are read');
  assert.equal(report.manifestValid, false);
  assert.deepEqual(report.invalidClaims.map(entry => entry.code), ['PACKAGE_MANIFEST_DUPLICATE_CLAIM']);
  assert.deepEqual(report.duplicateClaims, ['src/lib/audit.js']);
  assert.deepEqual(report.unmappedFiles, []);
  assert.deepEqual(report.layeringViolations, []);
}

{
  const invalidClaim = fixtureManifest();
  invalidClaim.packages[0].files[0] = 'config/packages.json';
  const report = checkPackageManifest(invalidClaim, fixtureRecords());
  assert.equal(report.manifestValid, false);
  assert.deepEqual(report.invalidClaims.map(entry => entry.code), ['PACKAGE_MANIFEST_INVALID_PATH']);
  assert.equal(report.summary.requireEdgeCount, 0, 'invalid manifests must not produce edge analysis');
}

{
  const report = checkPackageManifest(fixtureManifest(), {
    repositoryFiles: ['src/lib/audit.js', 'src/lib/audit.js', 'src/lib/tool-registry.js', 'sidecars/mail/index.js', 'tools/owner-inbox.js'],
    requireEdges: [{ from: 'src/lib/audit.js', to: 'not-a-repository-path' }]
  });
  assert.deepEqual(report.duplicateRepositoryFiles, ['src/lib/audit.js']);
  assert.deepEqual(report.invalidRecords.map(entry => entry.code), ['PACKAGE_MANIFEST_INVALID_PATH']);
  assert.equal(report.summary.requireEdgeCount, 0);
}

{
  const hostileRecords = new Proxy({}, {
    ownKeys() { throw new Error('records proxy must not escape the boundary'); }
  });
  const report = checkPackageManifest(fixtureManifest(), hostileRecords);
  assert.equal(report.manifestValid, true);
  assert.equal(report.invalidRecords.length, 1);
  assert.equal(report.invalidRecords[0].code, 'PACKAGE_CHECK_INVALID_RECORDS');
}

{
  const hostileFiles = new Proxy([], {
    getPrototypeOf() { throw new Error('array proxy must not escape the boundary'); }
  });
  const report = checkPackageManifest(fixtureManifest(), { repositoryFiles: hostileFiles });
  assert.equal(report.manifestValid, true);
  assert.equal(report.repositoryFilesProvided, true);
  assert.equal(report.invalidRecords.length, 1);
  assert.equal(report.invalidRecords[0].code, 'PACKAGE_CHECK_INVALID_RECORDS');
}

console.log('Package checker tests passed (injected boundary cases plus checked-in tree scan).');
