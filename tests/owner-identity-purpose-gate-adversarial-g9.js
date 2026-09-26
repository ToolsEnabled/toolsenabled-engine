// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-owner-identity-purpose-gate-adversarial-g9-js):
// - SAME-CODE EXPECTED VALUE: the fixtures obtained both contract identifiers
//   from the module under test. Mutating both exported identifiers therefore
//   left the original suite green. The assertions below independently pin the
//   public protocol strings. With that mutation retained, the strengthened
//   suite went red with:
//     AssertionError [ERR_ASSERTION]: vault key is a fixed public protocol identifier
//     + actual - expected
//     + 'mutated_owner_identity_v999'
//     - 'owner_legal_identity_v1'
// - Mutation: changed OWNER_LEGAL_IDENTITY_VAULT_KEY to
//   "mutated_owner_identity_v999" and OWNER_LEGAL_IDENTITY_PURPOSE to
//   "mutated_owner_identity_purpose" in the source temporarily.
// - EMPTY-ITERATION: NOT-FOUND. Both iterated case tables are non-empty local
//   array literals; their bodies cannot be bypassed by runtime data.
// - EXIT-STATUS/TRUTHY-RETURN: NOT-FOUND. This file spawns no process and makes
//   no assertion solely on truthiness.
// - SWALLOWED FAILURE: NOT-FOUND. There is no test-side try/catch or optional
//   chain.
// - MOCK-SUBJECT: NOT-FOUND. The subject is required directly and not mocked.
// - SKIP/PRECONDITION GUARD: NOT-FOUND. The file has no skip or platform guard.
// - Preconditions unmet: none.
// - Restoration: the source SHA-256 was
//   29a0526bee89b48828accbabf13efba9db9250ad0a13d22f0e1a6d3107302b9a
//   both before mutation and after restoration. The restored run was green:
//     Adversarial owner identity purpose gate tests completed successfully.

'use strict';

const assert = require('node:assert/strict');
const gate = require('../src/lib/owner-identity-purpose-gate');

assert.equal(
  gate.OWNER_LEGAL_IDENTITY_VAULT_KEY,
  'owner_legal_identity_v1',
  'vault key is a fixed public protocol identifier'
);
assert.equal(
  gate.OWNER_LEGAL_IDENTITY_PURPOSE,
  'owner_legal_identity',
  'purpose is a fixed public protocol identifier'
);

// Base valid reference
const valid = {
  vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY,
  purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE
};

// -----------------------------------------------------------------------------
// 1. Unknown Purposes Tests
// -----------------------------------------------------------------------------
const unknownPurposes = [
  '',
  ' ',
  '\t\n\r',
  'OWNER_LEGAL_IDENTITY',
  'owner_legal_identity_v2',
  'owner-legal-identity',
  'legal_name',
  'vault_key',
  'admin',
  'root',
  'undefined',
  'null',
  '0',
  '1',
  'true',
  'false',
  'owner_legal_identity_v1', // vaultKey used as purpose
  'x'.repeat(1000)
];

for (const purpose of unknownPurposes) {
  const input = {
    vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY,
    purpose: purpose
  };
  assert.deepEqual(gate.classifyOwnerIdentityPurpose(input), {
    classification: 'not-owner-legal-identity',
    purposeRecognized: false
  });
}

// -----------------------------------------------------------------------------
// 2. Malformed Contexts Tests
// -----------------------------------------------------------------------------
const malformedInputs = [
  undefined,
  null,
  0,
  1,
  -1,
  NaN,
  Infinity,
  -Infinity,
  true,
  false,
  'string',
  Symbol('symbol'),
  [],
  [gate.OWNER_LEGAL_IDENTITY_VAULT_KEY, gate.OWNER_LEGAL_IDENTITY_PURPOSE],
  () => {},
  async function() {},
  /regex/,
  new Date(),
  new Map(),
  new Set(),
  Object.create({}),
  Object.create(Array.prototype),
  Object.create(null) // missing keys
];

for (const input of malformedInputs) {
  assert.deepEqual(gate.classifyOwnerIdentityPurpose(input), {
    classification: 'not-owner-legal-identity',
    purposeRecognized: false
  });
}

// Null-prototype objects are outside the exact ordinary-object binding contract.
const validNullProto = Object.create(null);
validNullProto.vaultKey = gate.OWNER_LEGAL_IDENTITY_VAULT_KEY;
validNullProto.purpose = gate.OWNER_LEGAL_IDENTITY_PURPOSE;
assert.deepEqual(gate.classifyOwnerIdentityPurpose(validNullProto), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

// Null-prototype object but with incorrect values
const invalidNullProto = Object.create(null);
invalidNullProto.vaultKey = 'invalid_key';
invalidNullProto.purpose = gate.OWNER_LEGAL_IDENTITY_PURPOSE;
assert.deepEqual(gate.classifyOwnerIdentityPurpose(invalidNullProto), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

// Null-prototype object with extra keys
const extraNullProto = Object.create(null);
extraNullProto.vaultKey = gate.OWNER_LEGAL_IDENTITY_VAULT_KEY;
extraNullProto.purpose = gate.OWNER_LEGAL_IDENTITY_PURPOSE;
extraNullProto.extra = 'value';
assert.deepEqual(gate.classifyOwnerIdentityPurpose(extraNullProto), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

// -----------------------------------------------------------------------------
// 3. Missing Approvals Tests
// -----------------------------------------------------------------------------
const missingApprovals = [
  {},
  { vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY },
  { purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE },
  { vaultKey: undefined, purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE },
  { vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY, purpose: undefined },
  { vaultKey: null, purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE },
  { vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY, purpose: null },
  { vaultKey: '', purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE },
  { vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY, purpose: '' },
];

for (const input of missingApprovals) {
  assert.deepEqual(gate.classifyOwnerIdentityPurpose(input), {
    classification: 'not-owner-legal-identity',
    purposeRecognized: false
  });
}

// -----------------------------------------------------------------------------
// 4. Symbols, Accessors, and Proxies Tests
// -----------------------------------------------------------------------------

// -- Symbols --
const inputWithSymbol = {
  vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY,
  purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE,
  [Symbol('extra')]: 'value'
};
assert.deepEqual(gate.classifyOwnerIdentityPurpose(inputWithSymbol), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

const inputSymbolKeys = {
  [Symbol('vaultKey')]: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY,
  [Symbol('purpose')]: gate.OWNER_LEGAL_IDENTITY_PURPOSE
};
assert.deepEqual(gate.classifyOwnerIdentityPurpose(inputSymbolKeys), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

// -- Accessors --
let getterCalled = false;
const accessorInput = {
  purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE
};
Object.defineProperty(accessorInput, 'vaultKey', {
  enumerable: true,
  configurable: true,
  get() {
    getterCalled = true;
    return gate.OWNER_LEGAL_IDENTITY_VAULT_KEY;
  }
});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(accessorInput), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});
assert.equal(getterCalled, false, 'Accessor getter must not be called; rejected early via descriptor analysis');

const setterInput = {
  purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE
};
Object.defineProperty(setterInput, 'vaultKey', {
  enumerable: true,
  configurable: true,
  set(v) {}
});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(setterInput), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

const nonEnumerableInput = {};
Object.defineProperty(nonEnumerableInput, 'vaultKey', {
  value: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY,
  enumerable: false,
  writable: true,
  configurable: true
});
Object.defineProperty(nonEnumerableInput, 'purpose', {
  value: gate.OWNER_LEGAL_IDENTITY_PURPOSE,
  enumerable: true,
  writable: true,
  configurable: true
});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(nonEnumerableInput), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

const noValueInput = {};
Object.defineProperty(noValueInput, 'vaultKey', {
  enumerable: true,
  configurable: true
});
Object.defineProperty(noValueInput, 'purpose', {
  value: gate.OWNER_LEGAL_IDENTITY_PURPOSE,
  enumerable: true,
  writable: true,
  configurable: true
});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(noValueInput), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

// Non-writable, non-configurable but enumerable and value-possessing are valid!
const nonWritableConfigurableInput = {};
Object.defineProperty(nonWritableConfigurableInput, 'vaultKey', {
  value: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY,
  enumerable: true,
  writable: false,
  configurable: false
});
Object.defineProperty(nonWritableConfigurableInput, 'purpose', {
  value: gate.OWNER_LEGAL_IDENTITY_PURPOSE,
  enumerable: true,
  writable: false,
  configurable: false
});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(nonWritableConfigurableInput), {
  classification: 'owner-legal-identity',
  purposeRecognized: true
});

// -- Proxies --
const transparentProxy = new Proxy(valid, {});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(transparentProxy), {
  classification: 'owner-legal-identity',
  purposeRecognized: true
});

const invalidTransparentProxy = new Proxy({ vaultKey: 'wrong_key', purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE }, {});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(invalidTransparentProxy), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

// Dynamic proxy that returns a value on getter-access but has no 'value' field in getOwnPropertyDescriptor
const descriptorLyingProxy = new Proxy({}, {
  getPrototypeOf() {
    return Object.prototype;
  },
  ownKeys() {
    return ['vaultKey', 'purpose'];
  },
  getOwnPropertyDescriptor(target, prop) {
    if (prop === 'vaultKey' || prop === 'purpose') {
      return {
        get() {
          return prop === 'vaultKey' ? gate.OWNER_LEGAL_IDENTITY_VAULT_KEY : gate.OWNER_LEGAL_IDENTITY_PURPOSE;
        },
        enumerable: true,
        configurable: true
      };
    }
    return undefined;
  },
  get(target, prop) {
    return prop === 'vaultKey' ? gate.OWNER_LEGAL_IDENTITY_VAULT_KEY : gate.OWNER_LEGAL_IDENTITY_PURPOSE;
  }
});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(descriptorLyingProxy), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

// Classification is deliberately descriptor-only after shape validation. A
// Proxy get trap must never execute, even if it would return a different value.
let valueLyingGetCount = 0;
const valueLyingProxy = new Proxy({}, {
  getPrototypeOf() {
    return Object.prototype;
  },
  ownKeys() {
    return ['vaultKey', 'purpose'];
  },
  getOwnPropertyDescriptor(target, prop) {
    if (prop === 'vaultKey') {
      return {
        value: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY,
        writable: true,
        enumerable: true,
        configurable: true
      };
    }
    if (prop === 'purpose') {
      return {
        value: gate.OWNER_LEGAL_IDENTITY_PURPOSE,
        writable: true,
        enumerable: true,
        configurable: true
      };
    }
    return undefined;
  },
  get(target, prop) {
    valueLyingGetCount += 1;
    if (prop === 'vaultKey') {
      return 'malicious_dynamic_vault_key';
    }
    if (prop === 'purpose') {
      return gate.OWNER_LEGAL_IDENTITY_PURPOSE;
    }
    return undefined;
  }
});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(valueLyingProxy), {
  classification: 'owner-legal-identity',
  purposeRecognized: true
});
assert.equal(valueLyingGetCount, 0, 'Proxy get traps must not execute during descriptor-only classification');

// Proxy that throws on proto access
const throwingProxy = new Proxy({}, {
  getPrototypeOf() {
    throw new Error('Forced prototype check failure');
  }
});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(throwingProxy), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
}, 'reflection failures must fail closed without leaking their exception');

// Proxy that lies about own property names
const keyLyingProxy = new Proxy({ vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY, purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE }, {
  ownKeys() {
    return ['vaultKey', 'purpose', 'extraKey'];
  }
});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(keyLyingProxy), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

// Proxy that returns symbols
const symbolLyingTarget = {
  vaultKey: gate.OWNER_LEGAL_IDENTITY_VAULT_KEY,
  purpose: gate.OWNER_LEGAL_IDENTITY_PURPOSE,
  [Symbol('extra')]: 'value'
};
const symbolLyingProxy = new Proxy(symbolLyingTarget, {
  ownKeys(target) {
    return Reflect.ownKeys(target);
  }
});
assert.deepEqual(gate.classifyOwnerIdentityPurpose(symbolLyingProxy), {
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

// -----------------------------------------------------------------------------
// 5. Immutability Checks
// -----------------------------------------------------------------------------

// Module exports must be frozen
assert.equal(Object.isFrozen(gate), true, 'The module exports must be frozen');

// Outputs must be frozen
const resValid = gate.classifyOwnerIdentityPurpose(valid);
assert.equal(Object.isFrozen(resValid), true, 'Successful classification result must be frozen');

const resInvalid = gate.classifyOwnerIdentityPurpose({ vaultKey: 'bad', purpose: 'bad' });
assert.equal(Object.isFrozen(resInvalid), true, 'Denied classification result must be frozen');

// Attempting to modify properties should fail (throws in strict mode)
assert.throws(() => {
  resValid.classification = 'hacked';
}, TypeError);

assert.throws(() => {
  resInvalid.classification = 'hacked';
}, TypeError);

assert.throws(() => {
  resValid.newProp = 42;
}, TypeError);

assert.throws(() => {
  resInvalid.newProp = 42;
}, TypeError);

console.log('Adversarial owner identity purpose gate tests completed successfully.');
