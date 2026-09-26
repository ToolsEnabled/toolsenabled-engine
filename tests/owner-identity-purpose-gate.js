// EXECUTABLE CHANGE
// Discrimination report (testcanfail-tests-owner-identity-purpose-gate-js):
// - SAME-CODE EXPECTED VALUE: `valid` obtained both contract values from the
//   module under test, so the positive classification/access assertions stayed
//   green when both source constants were changed to `mutated_owner_*`.
//   Strengthening: the two literal contract assertions below make that mutation
//   fail with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
//   + actual - expected
//   + 'mutated_owner_vault'
//   - 'owner_legal_identity_v1'`.
// - NOT-FOUND empty loop/forEach: every loop iterates an in-file non-empty literal.
// - NOT-FOUND exit-status/truthy-process evidence: this test spawns no process.
// - NOT-FOUND swallowed failure: no try/catch; optional chaining occurs only in
//   assert.throws validators, where a false result fails the assertion.
// - NOT-FOUND mock of subject: the real module is required and no mock is used.
// - NOT-FOUND skip/precondition guard: all assertions execute unconditionally.
// - RESTORE: source SHA-256 before/after mutation was
//   29a0526bee89b48828accbabf13efba9db9250ad0a13d22f0e1a6d3107302b9a.
//   Restored run: `Owner identity purpose gate tests passed.`
'use strict';

const assert = require('node:assert/strict');
const gate = require('../src/lib/owner-identity-purpose-gate');

assert.equal(gate.OWNER_LEGAL_IDENTITY_VAULT_KEY, 'owner_legal_identity_v1');
assert.equal(gate.OWNER_LEGAL_IDENTITY_PURPOSE, 'owner_legal_identity');

const valid = {
  vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY,
  purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE
};

assert.deepEqual(
  gate.declaredToolAccess('owner_identity.profile_status', valid),
  { accessSurface: 'owner-legal-identity', capabilityClass: 'identity-value-presence-read' },
  'a valid own declared tool key retains its redacted access classification'
);

assert.deepEqual(gate.classifyOwnerIdentityPurpose(valid), {
  classification: 'owner-legal-identity',
  purposeRecognized: true
});
assert.equal(Object.isFrozen(gate.classifyOwnerIdentityPurpose(valid)), true);
assert.deepEqual(gate.classifyOwnerIdentityPurpose(Object.freeze({ ...valid })), {
  classification: 'owner-legal-identity',
  purposeRecognized: true
});

for (const input of [
  { vaultKey: 'other_vault_key', purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE },
  { vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY, purpose: 'other_purpose' },
  { vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY },
  { vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY, purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE, extra: true },
  Object.assign(Object.create({ purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE }), { vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY }),
  null,
  [],
  'owner_legal_identity_v1'
]) {
  assert.deepEqual(gate.classifyOwnerIdentityPurpose(input), {
    classification: 'not-owner-legal-identity',
    purposeRecognized: false
  });
}

let getterRead = false;
const accessor = { purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE };
Object.defineProperty(accessor, 'vaultKey', {
  enumerable: true,
  configurable: true,
  get() { getterRead = true; return gate.OWNER_LEGAL_IDENTITY_VAULT_KEY; }
});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(accessor), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});
assert.equal(getterRead, false, 'accessor input must be rejected without reading it');

const symbolInput = { ...valid };
symbolInput[Symbol('extra')] = true;
assert.deepEqual(gate.classifyOwnerIdentityPurpose(symbolInput), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

for (const toolName of ['toString', 'constructor', '__proto__', Symbol('tool')]) {
  assert.throws(
    () => gate.declaredToolAccess(toolName, valid),
    error => error?.code === 'OWNER_IDENTITY_ACCESS_REFUSED'
      && error.message === 'This tool is not allowed to access the owner legal-identity vault record.',
    'only own string keys in the declared tool allowlist may receive identity access'
  );
}

for (const toolName of [
  Object.create(null),
  { toString() { throw new Error('tool-name coercion must not run'); } }
]) {
  assert.throws(
    () => gate.declaredToolAccess(toolName, valid),
    error => error?.code === 'OWNER_IDENTITY_ACCESS_REFUSED',
    'non-string tool names must fail with the typed refusal without coercion'
  );
}

for (const binding of [
  Object.assign(Object.create(null), valid),
  Object.assign(Object.create({ inherited: true }), valid),
  new Proxy({}, { getPrototypeOf() { throw new Error('private prototype failure'); } }),
  new Proxy({}, { ownKeys() { throw new Error('private ownKeys failure'); } }),
  new Proxy(valid, { getOwnPropertyDescriptor() { throw new Error('private descriptor failure'); } })
]) {
  assert.deepEqual(gate.classifyOwnerIdentityPurpose(binding), {
    classification: 'not-owner-legal-identity',
    purposeRecognized: false
  }, 'reflection failures and unusual prototypes must collapse to the fixed denied result');
  assert.throws(
    () => gate.declaredToolAccess('owner_identity.profile_status', binding),
    error => error?.code === 'OWNER_IDENTITY_ACCESS_REFUSED'
      && !/private|prototype|ownKeys|descriptor|read/.test(error.message),
    'reflection failures must produce a typed non-leaking refusal'
  );
}

for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
  const unavailableBinding = new Proxy(valid, {
    getPrototypeOf() {
      const error = new Error(`private ${code} reflection failure`);
      error.code = code;
      throw error;
    }
  });
  assert.throws(
    () => gate.classifyOwnerIdentityPurpose(unavailableBinding),
    error => error?.code === 'OWNER_IDENTITY_PURPOSE_UNDETERMINED'
      && error.message === 'The owner identity purpose could not be determined; this is NOT claiming the binding is absent.'
      && error.cause?.code === code,
    `${code} must be reported as indeterminate rather than as a definite denial`
  );
}

const cachedDenial = gate.classifyOwnerIdentityPurpose({ vaultKey: 'other', purpose: 'other' });
assert.strictEqual(
  gate.classifyOwnerIdentityPurpose({ vaultKey: 'still-other', purpose: 'still-other' }),
  cachedDenial,
  'ordinary definite denials retain the pre-existing cached result'
);

let proxyGetCount = 0;
const descriptorOnlyProxy = new Proxy(valid, {
  get(target, property, receiver) {
    proxyGetCount += 1;
    return Reflect.get(target, property, receiver);
  }
});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(descriptorOnlyProxy), {
  classification: 'owner-legal-identity',
  purposeRecognized: true
});
assert.equal(proxyGetCount, 0, 'validated data descriptor values must be used without executing proxy get traps');

process.stdout.write('Owner identity purpose gate tests passed.\n');
