'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const entitlement = require('../src/lib/entitlement');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`);
  }
}

function verified(overrides = {}) {
  return {
    valid: true,
    active: true,
    product: 'toolsenabled.operator-cloud.v1',
    licenseId: 'lic_refusal_test',
    licensee: 'Test holder',
    ...overrides
  };
}

test('inactive verified entitlement is refused by both gate APIs without I/O', () => {
  const io = {
    readFileSync() { throw new Error('unexpected read'); },
    mkdirSync() { throw new Error('unexpected mkdir'); },
    writeFileSync() { throw new Error('unexpected write'); },
    renameSync() { throw new Error('unexpected rename'); },
    unlinkSync() { throw new Error('unexpected unlink'); }
  };
  const state = entitlement.resolveEntitlement(
    { root: '/unused', licenseKey: 'signed-key' },
    { fs: io, verifyKey: () => verified({ active: false, reason: 'suspended' }) }
  );
  const verdict = entitlement.decide('hosted-relay', state);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'ENTITLEMENT_INACTIVE');
  assert.equal(verdict.entitlement, state);
  assert.throws(
    () => entitlement.requireCapability('hosted-relay', { entitlement: state }, { fs: io }),
    error => error.code === 'ENTITLEMENT_INACTIVE'
      && error.verdict.allowed === false
      && error.verdict.entitlement === state
  );
});

test('invalid key input throws before creating or writing the profile', () => {
  const calls = [];
  const io = new Proxy({}, { get(_target, property) { return (...args) => calls.push([property, ...args]); } });
  assert.throws(
    () => entitlement.writeInstalledLicense('/must-not-be-touched', { licenseKey: '   ' }, { fs: io }),
    error => error.code === 'ENTITLEMENT_LICENSE_KEY_INVALID'
  );
  assert.deepEqual(calls, []);
});

test('invalid test-state input throws instead of minting an entitlement', () => {
  for (const value of [null, [], 'paid', 1]) {
    assert.throws(
      () => entitlement.sealEntitlementForTest(value),
      error => error.code === 'ENTITLEMENT_STATE_INVALID'
    );
  }
});

test('audit load failure uses LOAD_FAILED fallback and remains fail-open', () => {
  const files = new Map();
  const io = {
    mkdirSync() {},
    writeFileSync(file, contents) { files.set(file, contents); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync(file) { files.delete(file); }
  };
  const warnings = [];
  const originalLoad = Module._load;
  const originalWarning = process.emitWarning;
  Module._load = function (request, parent, isMain) {
    if (request === './audit' && parent && /entitlement\.js$/.test(parent.filename)) {
      throw new Error('simulated loader failure');
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  process.emitWarning = (message, name) => warnings.push({ message, name });
  try {
    const result = entitlement.activate(
      { root: '/virtual-root', licenseKey: 'signed-key' },
      { fs: io, now: () => 0, verifyKey: () => verified() }
    );
    assert.equal(result.entitlement.active, true);
    assert.equal(files.has(entitlement.profilePath('/virtual-root')), true);
  } finally {
    Module._load = originalLoad;
    process.emitWarning = originalWarning;
  }
  assert.deepEqual(warnings.map(item => item.name), ['EntitlementAuditWriteFailed']);
  assert.match(warnings[0].message, /audit module failed to load \(LOAD_FAILED\)/);
  assert.match(warnings[0].message, /entitlement itself is unaffected/);
});

if (failures) process.exitCode = 1;
