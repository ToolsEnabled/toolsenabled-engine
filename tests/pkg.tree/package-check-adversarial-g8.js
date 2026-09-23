'use strict';

const assert = require('node:assert/strict');
const {
  REPORT_MODE,
  checkPackageManifest,
  formatPackageCheckReport
} = require('../../tools/package-check');

function makeValidManifest() {
  return {
    schemaVersion: 1,
    packages: [
      { id: 'kernel.core', files: ['src/lib/kernel.js'] },
      { id: 'surface.ui', files: ['tools/entry.js'] },
      { id: 'domain.mail', files: ['sidecars/mail/index.js'] }
    ]
  };
}

function makeLayeredManifest() {
  return {
    schemaVersion: 1,
    packages: [
      { id: 'entry.main', files: ['tools/main.js'] },
      { id: 'kernel.core', files: ['src/lib/kernel.js'] },
      { id: 'surface.ui', files: ['tools/entry.js'] },
      { id: 'domain.mail', files: ['sidecars/mail/index.js'] },
      { id: 'domain.calendar', files: ['sidecars/calendar/index.js'] }
    ]
  };
}

// -----------------------------------------------------------------------------
// 1. Malformed Manifests
// -----------------------------------------------------------------------------
console.log('Running Malformed Manifests checks...');

{
  const report = checkPackageManifest(null);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_INVALID');
}

{
  const report = checkPackageManifest('invalid-string');
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_INVALID');
}

{
  const badProtoManifest = Object.create({ extra: 1 });
  badProtoManifest.schemaVersion = 1;
  badProtoManifest.packages = [];
  const report = checkPackageManifest(badProtoManifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_UNSAFE_OBJECT');
}

{
  const symbolKeyManifest = {
    schemaVersion: 1,
    packages: [],
    [Symbol('hostile')]: 'value'
  };
  const report = checkPackageManifest(symbolKeyManifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_UNSAFE_OBJECT');
}

{
  const nonEnumManifest = {};
  Object.defineProperty(nonEnumManifest, 'schemaVersion', { value: 1, enumerable: false });
  Object.defineProperty(nonEnumManifest, 'packages', { value: [], enumerable: true });
  const report = checkPackageManifest(nonEnumManifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_UNSAFE_OBJECT');
}

{
  const reservedManifest = {
    schemaVersion: 1,
    packages: [],
    prototype: 'unsafe'
  };
  const report = checkPackageManifest(reservedManifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_UNSAFE_OBJECT');
}

{
  const manifest = makeValidManifest();
  manifest.schemaVersion = 2;
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_INVALID');
}

{
  const manifest = { schemaVersion: 1 };
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_UNKNOWN_FIELD');
}

{
  const manifest = { schemaVersion: 1, packages: [], unknownField: true };
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_UNKNOWN_FIELD');
}

{
  const manifest = { schemaVersion: 1, packages: {} };
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_INVALID');
}

{
  const manifest = { schemaVersion: 1, packages: Object.setPrototypeOf([], { custom: true }) };
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_INVALID');
}

{
  const manifest = makeValidManifest();
  manifest.packages[0].id = 'Kernel.core';
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_INVALID_ID');
}

{
  const manifest = makeValidManifest();
  manifest.packages[0].id = 'kernel..core';
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_INVALID_ID');
}

{
  const manifest = makeValidManifest();
  manifest.packages[0].id = 'kernel.prototype';
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_UNSAFE_OBJECT');
}

{
  const manifest = makeValidManifest();
  manifest.packages[0].id = '1kernel.core';
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_INVALID_ID');
}

{
  const manifest = makeValidManifest();
  manifest.packages.push({ id: 'kernel.core', files: ['src/lib/another.js'] });
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_DUPLICATE_PACKAGE');
}

{
  const manifest = makeValidManifest();
  manifest.packages[0].files = [];
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_MISSING_SOURCE_CATEGORY');
}

{
  const manifest = makeValidManifest();
  manifest.packages[0].files[0] = 'src/lib/kernel\\backslashes.js';
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_INVALID_PATH');
}

{
  const manifest = makeValidManifest();
  manifest.packages[0].files[0] = '/src/lib/absolute.js';
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_INVALID_PATH');
}

{
  const manifest = makeValidManifest();
  manifest.packages[0].files[0] = 'src/lib/kernel.txt';
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_INVALID_PATH');
}

{
  const manifest = makeValidManifest();
  manifest.packages[0].files[0] = 'outside/lib/kernel.js';
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_INVALID_PATH');
}

{
  const manifest = makeValidManifest();
  manifest.packages[0].files.push('src/lib/kernel.js');
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_DUPLICATE_CLAIM');
  assert.deepEqual(report.duplicateClaims, ['src/lib/kernel.js']);
}

{
  const manifest = makeValidManifest();
  manifest.packages[1].files.push('src/lib/kernel.js');
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_DUPLICATE_CLAIM');
  assert.deepEqual(report.duplicateClaims, ['src/lib/kernel.js']);
}

{
  const manifest = {
    schemaVersion: 1,
    packages: [
      { id: 'kernel.core', files: ['src/lib/kernel.js'] },
      { id: 'surface.ui', files: ['tools/entry.js'] }
    ]
  };
  const report = checkPackageManifest(manifest);
  assert.equal(report.manifestValid, false);
  assert.equal(report.invalidClaims[0].code, 'PACKAGE_MANIFEST_MISSING_SOURCE_CATEGORY');
}

// -----------------------------------------------------------------------------
// 2. Hostile Proxy Records
// -----------------------------------------------------------------------------
console.log('Running Hostile Proxy Records checks...');

{
  const hostileProxy = new Proxy({}, {
    getPrototypeOf() {
      return { custom: 'proto' };
    }
  });
  const report = checkPackageManifest(makeValidManifest(), hostileProxy);
  assert.equal(report.manifestValid, true);
  assert.equal(report.repositoryFilesProvided, false);
  assert.equal(report.requireEdgesProvided, false);
  assert.equal(report.invalidRecords[0].code, 'PACKAGE_CHECK_INVALID_RECORDS');
  assert.match(report.invalidRecords[0].message, /must not inherit a custom prototype/);
}

{
  const hostileProxy = new Proxy({}, {
    getPrototypeOf() { return Object.prototype; },
    ownKeys() {
      return [Symbol('hostile'), 'repositoryFiles'];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'symbol') {
        return { enumerable: true, configurable: true, value: 'symbol-val' };
      }
      if (prop === 'repositoryFiles') {
        return { enumerable: true, configurable: true, value: ['src/lib/kernel.js', 'tools/entry.js', 'sidecars/mail/index.js'] };
      }
      return undefined;
    },
    get(target, prop) {
      if (prop === 'repositoryFiles') {
        return ['src/lib/kernel.js', 'tools/entry.js', 'sidecars/mail/index.js'];
      }
      return undefined;
    }
  });
  const report = checkPackageManifest(makeValidManifest(), hostileProxy);
  assert.equal(report.manifestValid, true);
  assert.equal(report.invalidRecords[0].code, 'PACKAGE_CHECK_INVALID_RECORDS');
  assert.match(report.invalidRecords[0].message, /must not contain symbol fields/);
}

{
  const proxyArray = new Proxy([], {
    ownKeys() {
      return ['length', '0', '1', '2', 'extraField'];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'length') return { value: 3, enumerable: false, configurable: false, writable: true };
      if (prop === '0') return { value: 'src/lib/kernel.js', enumerable: true, configurable: true, writable: true };
      if (prop === '1') return { value: 'tools/entry.js', enumerable: true, configurable: true, writable: true };
      if (prop === '2') return { value: 'sidecars/mail/index.js', enumerable: true, configurable: true, writable: true };
      if (prop === 'extraField') return { value: 'hostile', enumerable: true, configurable: true, writable: true };
      return undefined;
    },
    get(target, prop) {
      if (prop === 'length') return 3;
      if (prop === '0') return 'src/lib/kernel.js';
      if (prop === '1') return 'tools/entry.js';
      if (prop === '2') return 'sidecars/mail/index.js';
      if (prop === 'extraField') return 'hostile';
      return undefined;
    }
  });
  const report = checkPackageManifest(makeValidManifest(), {
    repositoryFiles: proxyArray
  });
  assert.equal(report.manifestValid, true);
  assert.equal(report.invalidRecords[0].code, 'PACKAGE_CHECK_INVALID_RECORDS');
  assert.match(report.invalidRecords[0].message, /must not contain extra fields/);
}

{
  const proxyArray = new Proxy([], {
    ownKeys() {
      return ['length', '0'];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'length') return { value: 1, enumerable: false, configurable: false, writable: true };
      if (prop === '0') return { value: 'src/lib/kernel.js', enumerable: false, configurable: true, writable: true };
    },
    get(target, prop) {
      if (prop === 'length') return 1;
      if (prop === '0') return 'src/lib/kernel.js';
    }
  });
  const report = checkPackageManifest(makeValidManifest(), {
    repositoryFiles: proxyArray
  });
  assert.equal(report.manifestValid, true);
  assert.equal(report.invalidRecords[0].code, 'PACKAGE_CHECK_INVALID_RECORDS');
  assert.match(report.invalidRecords[0].message, /must be an enumerable data value/);
}

{
  const hostileEdge = new Proxy({}, {
    getPrototypeOf() { return Object.prototype; },
    ownKeys() { return ['from', 'to', 'extraProperty']; },
    getOwnPropertyDescriptor(target, prop) {
      return { enumerable: true, configurable: true, value: 'some-value' };
    },
    get(target, prop) {
      if (prop === 'from') return 'src/lib/kernel.js';
      if (prop === 'to') return 'tools/entry.js';
      return 'hostile';
    }
  });
  const report = checkPackageManifest(makeValidManifest(), {
    requireEdges: [hostileEdge]
  });
  assert.equal(report.manifestValid, true);
  assert.equal(report.invalidRecords[0].code, 'PACKAGE_CHECK_INVALID_EDGE');
  assert.match(report.invalidRecords[0].message, /must contain exactly from and to paths/);
}

{
  let getCount = 0;
  const compliantProxyEdge = new Proxy({}, {
    getPrototypeOf() { return Object.prototype; },
    ownKeys() { return ['from', 'to']; },
    getOwnPropertyDescriptor(target, prop) {
      return { enumerable: true, configurable: true, value: prop === 'from' ? 'src/lib/kernel.js' : 'tools/entry.js' };
    },
    get(target, prop) {
      if (prop === 'from') { getCount++; return 'src/lib/kernel.js'; }
      if (prop === 'to') { getCount++; return 'tools/entry.js'; }
    }
  });
  const report = checkPackageManifest(makeValidManifest(), {
    requireEdges: [compliantProxyEdge]
  });
  assert.equal(report.manifestValid, true);
  assert.equal(report.invalidRecords.length, 0);
  assert.equal(report.summary.requireEdgeCount, 1);
  assert.ok(getCount <= 2);
}

// -----------------------------------------------------------------------------
// 3. Duplicate and Orphan Claims
// -----------------------------------------------------------------------------
console.log('Running Duplicate and Orphan Claims checks...');

{
  const manifest = makeValidManifest();
  const records = {
    repositoryFiles: [
      'src/lib/kernel.js',
      'src/lib/kernel.js',
      'tools/entry.js',
      'sidecars/mail/index.js',
      'tools/unmapped.js'
    ]
  };
  const report = checkPackageManifest(manifest, records);
  assert.equal(report.manifestValid, true);
  assert.deepEqual(report.duplicateRepositoryFiles, ['src/lib/kernel.js']);
  assert.deepEqual(report.unmappedFiles, ['tools/unmapped.js']);
  assert.deepEqual(report.orphanedClaims, []);
}

{
  const manifest = makeValidManifest();
  const records = {
    repositoryFiles: [
      'src/lib/kernel.js'
    ]
  };
  const report = checkPackageManifest(manifest, records);
  assert.equal(report.manifestValid, true);
  assert.deepEqual(report.orphanedClaims, ['sidecars/mail/index.js', 'tools/entry.js']);
}

// -----------------------------------------------------------------------------
// 4. Unmapped Require Edges
// -----------------------------------------------------------------------------
console.log('Running Unmapped Require Edges checks...');

{
  const manifest = makeValidManifest();
  const records = {
    requireEdges: [
      { from: 'tools/unmapped.js', to: 'src/lib/kernel.js' },
      { from: 'src/lib/kernel.js', to: 'tools/another-unmapped.js' },
      { from: 'sidecars/unmapped-one.js', to: 'sidecars/unmapped-two.js' }
    ]
  };
  const report = checkPackageManifest(manifest, records);
  assert.equal(report.manifestValid, true);
  assert.equal(report.unmappedEdges.length, 3);

  assert.deepEqual(report.unmappedEdges[0], {
    from: 'sidecars/unmapped-one.js',
    to: 'sidecars/unmapped-two.js',
    missing: ['from', 'to']
  });
  assert.deepEqual(report.unmappedEdges[1], {
    from: 'src/lib/kernel.js',
    to: 'tools/another-unmapped.js',
    missing: ['to']
  });
  assert.deepEqual(report.unmappedEdges[2], {
    from: 'tools/unmapped.js',
    to: 'src/lib/kernel.js',
    missing: ['from']
  });
}

// -----------------------------------------------------------------------------
// 5. Layering Violations
// -----------------------------------------------------------------------------
console.log('Running Layering Violations checks...');

{
  const manifest = makeLayeredManifest();
  const requireEdges = [
    { from: 'tools/main.js', to: 'src/lib/kernel.js' },
    { from: 'tools/main.js', to: 'tools/entry.js' },
    { from: 'tools/main.js', to: 'sidecars/mail/index.js' },

    { from: 'src/lib/kernel.js', to: 'tools/main.js' },
    { from: 'src/lib/kernel.js', to: 'tools/entry.js' },
    { from: 'src/lib/kernel.js', to: 'sidecars/mail/index.js' },

    { from: 'tools/entry.js', to: 'tools/main.js' },
    { from: 'tools/entry.js', to: 'src/lib/kernel.js' },
    { from: 'tools/entry.js', to: 'sidecars/mail/index.js' },

    { from: 'sidecars/mail/index.js', to: 'tools/main.js' },
    { from: 'sidecars/mail/index.js', to: 'src/lib/kernel.js' },
    { from: 'sidecars/mail/index.js', to: 'tools/entry.js' },
    { from: 'sidecars/mail/index.js', to: 'sidecars/calendar/index.js' }
  ];

  const report = checkPackageManifest(manifest, { requireEdges });
  assert.equal(report.manifestValid, true);

  const violationsMap = {};
  for (const v of report.layeringViolations) {
    violationsMap[`${v.from}->${v.to}`] = v.code;
  }

  // The keyed assertions below prove each expected classification, while the
  // count prevents duplicate findings from being hidden by map overwrites.
  assert.equal(report.layeringViolations.length, 7);

  assert.equal(violationsMap['tools/main.js->src/lib/kernel.js'], undefined);
  assert.equal(violationsMap['tools/main.js->tools/entry.js'], undefined);
  assert.equal(violationsMap['tools/main.js->sidecars/mail/index.js'], undefined);

  assert.equal(violationsMap['src/lib/kernel.js->tools/main.js'], 'IMPORTS_ENTRYPOINT');
  assert.equal(violationsMap['src/lib/kernel.js->tools/entry.js'], 'KERNEL_IMPORTS_UP');
  assert.equal(violationsMap['src/lib/kernel.js->sidecars/mail/index.js'], 'KERNEL_IMPORTS_UP');

  assert.equal(violationsMap['tools/entry.js->tools/main.js'], 'IMPORTS_ENTRYPOINT');
  assert.equal(violationsMap['tools/entry.js->src/lib/kernel.js'], undefined);
  assert.equal(violationsMap['tools/entry.js->sidecars/mail/index.js'], 'SURFACE_IMPORTS_DOMAIN');

  assert.equal(violationsMap['sidecars/mail/index.js->tools/main.js'], 'IMPORTS_ENTRYPOINT');
  assert.equal(violationsMap['sidecars/mail/index.js->src/lib/kernel.js'], undefined);
  assert.equal(violationsMap['sidecars/mail/index.js->tools/entry.js'], undefined);
  assert.equal(violationsMap['sidecars/mail/index.js->sidecars/calendar/index.js'], 'SIDEWAYS_DOMAIN_IMPORT');

  const formatted = formatPackageCheckReport(report);
  assert.match(formatted, /IMPORTS_ENTRYPOINT/);
  assert.match(formatted, /KERNEL_IMPORTS_UP/);
  assert.match(formatted, /SURFACE_IMPORTS_DOMAIN/);
  assert.match(formatted, /SIDEWAYS_DOMAIN_IMPORT/);
}

console.log('Adversarial package check boundary tests passed successfully.');
