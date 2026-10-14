'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const acceptance = require('../src/lib/dependency-acceptance');
const { installDependency } = require('../tools/dependency-acceptance');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  void label;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-acceptance-'));
const registryFile = path.join(scratch, 'dependency-acceptance.json');
const packageFile = path.join(scratch, 'package.json');

function writeRegistry(records = []) {
  fs.writeFileSync(registryFile, JSON.stringify({
    schemaVersion: acceptance.SCHEMA_VERSION,
    baselineDependencies: [{ name: 'playwright', reason: 'fixture baseline' }],
    records
  }, null, 2));
}

function writePackage(dependencies) {
  fs.writeFileSync(packageFile, JSON.stringify({ private: true, dependencies }, null, 2));
}

function refusingFs(files = {}) {
  const calls = { read: [], mkdir: 0, write: 0, rename: 0, unlink: 0 };
  return {
    calls,
    readFileSync(file) {
      calls.read.push(file);
      if (!Object.hasOwn(files, file)) {
        const error = new Error(`fixture refuses to read ${file}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files[file];
    },
    mkdirSync() { calls.mkdir += 1; },
    writeFileSync() { calls.write += 1; },
    renameSync() { calls.rename += 1; },
    unlinkSync() { calls.unlink += 1; }
  };
}

function assertNoWrites(fsApi) {
  assert.deepEqual(
    { mkdir: fsApi.calls.mkdir, write: fsApi.calls.write, rename: fsApi.calls.rename, unlink: fsApi.calls.unlink },
    { mkdir: 0, write: 0, rename: 0, unlink: 0 }
  );
}

try {
  writeRegistry();
  writePackage({ playwright: '^1.62.0' });

  check('capture refuses a baseline dependency without writing the registry', () => {
    const virtualRegistry = '/virtual/registry.json';
    const fsApi = refusingFs({
      [virtualRegistry]: JSON.stringify({
        schemaVersion: acceptance.SCHEMA_VERSION,
        baselineDependencies: [{ name: 'playwright', reason: 'fixture baseline' }],
        records: []
      })
    });
    assert.throws(
      () => acceptance.captureDependency(
        { name: 'playwright', kind: 'other' },
        { registryFile: virtualRegistry, fsApi, capturedAt: '2026-08-27T00:00:00.000Z' }
      ),
      (error) => error.code === 'DEPENDENCY_ACCEPTANCE_BASELINE_CONFLICT'
    );
    assert.deepEqual(fsApi.calls.read, [virtualRegistry]);
    assertNoWrites(fsApi);
  });

  check('an invalid event refuses before reading or writing any dependency files', () => {
    const fsApi = refusingFs();
    assert.throws(
      () => acceptance.assertEventAllowed({ event: 'publication', fsApi }),
      (error) => error.code === 'DEPENDENCY_ACCEPTANCE_EVENT_INVALID' && error.event === 'publication'
    );
    assert.deepEqual(fsApi.calls.read, []);
    assertNoWrites(fsApi);
  });

  check('an invalid package dependency map refuses after registry read and performs no writes', () => {
    const virtualRegistry = '/virtual/registry.json';
    const virtualPackage = '/virtual/package.json';
    const fsApi = refusingFs({
      [virtualRegistry]: JSON.stringify({
        schemaVersion: acceptance.SCHEMA_VERSION,
        baselineDependencies: [],
        records: []
      }),
      [virtualPackage]: JSON.stringify({ dependencies: [] })
    });
    assert.throws(
      () => acceptance.assertEventAllowed({
        event: 'shipping', registryFile: virtualRegistry, packageFile: virtualPackage, fsApi
      }),
      (error) => error.code === 'DEPENDENCY_ACCEPTANCE_PACKAGE_INVALID'
    );
    assert.deepEqual(fsApi.calls.read, [virtualRegistry, virtualPackage]);
    assertNoWrites(fsApi);
  });

  check('an invalid registry refuses before package inspection and performs no writes', () => {
    const virtualRegistry = '/virtual/registry.json';
    const virtualPackage = '/virtual/package.json';
    const fsApi = refusingFs({
      [virtualRegistry]: JSON.stringify({ schemaVersion: 'wrong-version', baselineDependencies: [], records: [] }),
      [virtualPackage]: JSON.stringify({ dependencies: {} })
    });
    assert.throws(
      () => acceptance.assertEventAllowed({
        event: 'distribution', registryFile: virtualRegistry, packageFile: virtualPackage, fsApi
      }),
      (error) => error.code === 'DEPENDENCY_ACCEPTANCE_REGISTRY_INVALID'
    );
    assert.deepEqual(fsApi.calls.read, [virtualRegistry]);
    assertNoWrites(fsApi);
  });

  check('an unavailable registry preserves the read failure as cause and performs no writes', () => {
    const virtualRegistry = '/virtual/missing-registry.json';
    const fsApi = refusingFs();
    assert.throws(
      () => acceptance.captureDependency(
        { name: 'new-package', kind: 'other' },
        { registryFile: virtualRegistry, fsApi, capturedAt: '2026-08-27T00:00:00.000Z' }
      ),
      (error) => error.code === 'DEPENDENCY_ACCEPTANCE_REGISTRY_UNAVAILABLE'
        && error.cause && error.cause.code === 'ENOENT'
    );
    assert.deepEqual(fsApi.calls.read, [virtualRegistry]);
    assertNoWrites(fsApi);
  });

  check('capture-now records name, license, and reuse type for crypto dependencies', () => {
    const record = acceptance.captureDependency({
      name: 'tweetnacl',
      kind: 'crypto',
      license: 'Unlicense',
      reuseType: 'generic-primitive'
    }, { registryFile, capturedAt: '2026-08-07T12:00:00.000Z' });
    assert.deepEqual(record, {
      name: 'tweetnacl',
      kind: 'crypto',
      license: 'Unlicense',
      reuseType: 'generic-primitive',
      capturedAt: '2026-08-07T12:00:00.000Z'
    });
    const stored = JSON.parse(fs.readFileSync(registryFile, 'utf8')).records[0];
    assert.equal(stored.name, 'tweetnacl');
    assert.equal(stored.license, 'Unlicense');
    assert.equal(stored.reuseType, 'generic-primitive');
  });

  check('capture-now refuses incomplete crypto/protocol metadata without changing the registry', () => {
    const before = fs.readFileSync(registryFile, 'utf8');
    assert.throws(
      () => acceptance.captureDependency({ name: 'libsignal', kind: 'protocol', license: 'AGPL-3.0-only' }, { registryFile }),
      (error) => error.code === 'DEPENDENCY_ACCEPTANCE_INVALID' && error.field === 'reuseType'
    );
    assert.equal(fs.readFileSync(registryFile, 'utf8'), before);
  });

  check('block-later allows captured crypto dependencies at distribution and third-party boundaries', () => {
    writePackage({ playwright: '^1.62.0', tweetnacl: '^1.0.3' });
    for (const event of acceptance.BLOCKING_EVENTS) {
      const result = acceptance.assertEventAllowed({ event, registryFile, packageFile });
      assert.equal(result.event, event);
      assert.deepEqual(result.sensitive.map((entry) => entry.name), ['tweetnacl']);
    }
  });

  check('block-later hard-stops an unclassified new dependency only at a boundary', () => {
    writePackage({ playwright: '^1.62.0', tweetnacl: '^1.0.3', 'new-protocol': '^2.0.0' });
    for (const event of acceptance.BLOCKING_EVENTS) {
      assert.throws(
        () => acceptance.assertEventAllowed({ event, registryFile, packageFile }),
        (error) => error.code === 'DEPENDENCY_ACCEPTANCE_REQUIRED'
          && error.event === event
          && error.unclassified.includes('new-protocol')
      );
    }
  });

  // The w20 sweep pinned the opposite here -- refuse whenever zero dependencies
  // are found -- and its source half was adversarially REFUTED and reverted in
  // 5060413 (verify-w20-151): the reader already throws for an unreadable or
  // malformed package, so `{}` is a SUCCESSFUL scan that measured zero, not a
  // scan that failed to happen. This check pins that distinction from both
  // sides, which is what the refuted version could not distinguish.
  check('block-later accepts a measured zero, and refuses only when the scan itself cannot happen', () => {
    writePackage({});
    const result = acceptance.assertEventAllowed({ event: 'distribution', registryFile, packageFile });
    assert.equal(result.event, 'distribution');
    assert.equal(result.dependencyCount, 0, 'zero must be reported as the measured count, not an error');
    fs.writeFileSync(packageFile, '{ not json', 'utf8');
    assert.throws(
      () => acceptance.assertEventAllowed({ event: 'distribution', registryFile, packageFile }),
      (error) => error.code === 'DEPENDENCY_ACCEPTANCE_PACKAGE_UNAVAILABLE'
    );
  });

  check('the install path captures only after a successful hidden npm execution', () => {
    writePackage({ playwright: '^1.62.0', tweetnacl: '^1.0.3' });
    const calls = [];
    const record = installDependency({ name: 'wire-protocol', kind: 'protocol', license: 'MIT', reuseType: 'protocol-implementation' }, {
      registryFile,
      capturedAt: '2026-08-07T13:00:00.000Z',
      packageSpec: 'wire-protocol@1.2.3',
      run(command, args) { calls.push({ command, args }); return { status: 0 }; }
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].command, /^npm(?:\.cmd)?$/);
    assert.deepEqual(calls[0].args, ['install', 'wire-protocol@1.2.3']);
    assert.equal(record.name, 'wire-protocol');

    const before = fs.readFileSync(registryFile, 'utf8');
    assert.throws(
      () => installDependency({ name: 'failed-protocol', kind: 'protocol', license: 'MIT', reuseType: 'protocol-implementation' }, {
        registryFile,
        run() { return { status: 7 }; }
      }),
      (error) => error.code === 'DEPENDENCY_INSTALL_FAILED' && error.status === 7
    );
    assert.equal(fs.readFileSync(registryFile, 'utf8'), before);
  });

  console.log(`Dependency acceptance tests passed (${checks} checks).`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
