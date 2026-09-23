// EXECUTABLE CHANGE
/*
 *
 * Assertion audit (testcanfail-tests-owner-identity-reader-audit-adversarial-g9-js):
 * - Strengthened the Group 4 redaction loop with an exact, non-empty set of
 *   projected tool IDs. Mutation: on audit call 28, return EMPTY_MAP instead
 *   of frozenRedactedMap(accepted). RED: "AssertionError [ERR_ASSERTION]:
 *   Expected values to be strictly deep-equal: + actual - expected
 *   + [] - [ 'owner_identity.bootstrap_from_publisher_evidence',
 *   -   'owner_identity.profile_status' ]".
 * - Strengthened the Group 5 nested-immutability loop with the same exact,
 *   non-empty key assertion. Mutation: on audit call 29, return EMPTY_MAP.
 *   RED: "AssertionError [ERR_ASSERTION]: Expected values to be strictly
 *   deep-equal: + actual - expected + [] - [
 *   -   'owner_identity.bootstrap_from_publisher_evidence',
 *   -   'owner_identity.profile_status' ]".
 * - NOT-FOUND (1): all other loops consume non-empty local literals, or have
 *   an independently asserted exact/non-zero collection size before looping.
 * - NOT-FOUND (2): no exit-status or generic truthy-return assertions.
 * - NOT-FOUND (3): no failure-swallowing catch or optional chain; the sole
 *   try/finally guarantees prototype cleanup without catching an assertion.
 * - NOT-FOUND (4): no mocks.
 * - NOT-FOUND (5): no skips or platform precondition guards.
 * - NOT-FOUND (6): no expected value computed by the implementation under test.
 * - Preconditions: all met. Mutated source was restored byte-for-byte (SHA-256
 *   checked). Restored GREEN: "Adversarial owner identity reader audit tests
 *   passed successfully."
 */
'use strict';

const assert = require('node:assert/strict');
const audit = require('../src/lib/owner-identity-reader-audit');

// Baseline valid data for cloning or modifying within test cases
const VALID_ENTRY_BOOTSTRAP = {
  toolId: 'owner_identity.bootstrap_from_publisher_evidence',
  actorId: 'tool-registry',
  capabilityClass: 'identity-profile-bootstrap',
  identityBinding: {
    vaultKey: 'owner_legal_identity_v1',
    purpose: 'owner_legal_identity'
  }
};

const VALID_ENTRY_STATUS = {
  toolId: 'owner_identity.profile_status',
  actorId: 'tool-registry',
  capabilityClass: 'identity-existence-read',
  identityBinding: {
    vaultKey: 'owner_legal_identity_v1',
    purpose: 'owner_legal_identity'
  }
};

function makeSnapshot(entries, extra = {}) {
  return JSON.stringify({
    schemaVersion: audit.SCHEMA_VERSION,
    entries,
    ...extra
  });
}

// ============================================================================
// Group 1: Unsafe Selectors & Prototype Pollution Resistance
// ============================================================================

// Verify that polluting global prototypes does not hijack the audit engine's logic.
{
  const pollutedKeys = [
    'schemaVersion', 'entries', 'actorId', 'capabilityClass', 'toolId', 'identityBinding', 'vaultKey', 'purpose', 'extra'
  ];

  for (const key of pollutedKeys) {
    Object.defineProperty(Object.prototype, key, {
      value: 'POLLUTED',
      configurable: true,
      enumerable: true,
      writable: true
    });
  }

  Object.defineProperty(Array.prototype, '0', {
    value: 'POLLUTED_ARRAY_ELEMENT',
    configurable: true,
    enumerable: true,
    writable: true
  });

  try {
    const result = audit.auditOwnerIdentityReaderSurface(makeSnapshot([VALID_ENTRY_BOOTSTRAP, VALID_ENTRY_STATUS]));
    assert.equal(Object.getPrototypeOf(result), null);
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(Object.keys(result).sort(), [
      'owner_identity.bootstrap_from_publisher_evidence',
      'owner_identity.profile_status'
    ].sort());
  } finally {
    for (const key of pollutedKeys) {
      delete Object.prototype[key];
    }
    delete Array.prototype['0'];
  }
}

// Verify that serialized snapshots containing prototype pollution or unexpected keys fail closed.
{
  const payloads = [
    JSON.stringify({
      schemaVersion: audit.SCHEMA_VERSION,
      entries: [],
      ['__proto__']: { polluted: true }
    }),
    JSON.stringify({
      schemaVersion: audit.SCHEMA_VERSION,
      entries: [],
      constructor: {}
    }),
    JSON.stringify({
      schemaVersion: audit.SCHEMA_VERSION,
      entries: [],
      prototype: {}
    }),
    makeSnapshot([{
      ...VALID_ENTRY_BOOTSTRAP,
      ['__proto__']: { polluted: true }
    }]),
    makeSnapshot([{
      ...VALID_ENTRY_BOOTSTRAP,
      constructor: {}
    }]),
    makeSnapshot([{
      ...VALID_ENTRY_BOOTSTRAP,
      identityBinding: {
        vaultKey: 'owner_legal_identity_v1',
        purpose: 'owner_legal_identity',
        ['__proto__']: { polluted: true }
      }
    }]),
    makeSnapshot([{
      ...VALID_ENTRY_BOOTSTRAP,
      identityBinding: {
        vaultKey: 'owner_legal_identity_v1',
        purpose: 'owner_legal_identity',
        toString: {}
      }
    }])
  ];

  for (const payload of payloads) {
    const result = audit.auditOwnerIdentityReaderSurface(payload);
    assert.deepEqual(result, Object.create(null));
    assert.equal(Object.keys(result).length, 0);
  }
}

// ============================================================================
// Group 2: Symbol, Accessor, and Proxy Bounds
// ============================================================================

// Verify that Proxy wrappers mimicking strings are rejected immediately without reads.
{
  let trapTriggered = false;
  const proxyString = new Proxy(new String(makeSnapshot([VALID_ENTRY_BOOTSTRAP])), {
    get(target, prop, receiver) {
      trapTriggered = true;
      if (prop === 'length') return 1000;
      return Reflect.get(target, prop, receiver);
    }
  });

  const result = audit.auditOwnerIdentityReaderSurface(proxyString);
  assert.deepEqual(result, Object.create(null));
  assert.equal(trapTriggered, false, 'Proxy object must be rejected before any property reads');
}

// Verify that passing any non-string primitive or non-string object types fails closed.
{
  const inputs = [
    undefined,
    null,
    12345,
    true,
    Symbol('hostile_symbol'),
    [],
    {},
    () => {},
    BigInt(9007199254740991)
  ];

  for (const input of inputs) {
    const result = audit.auditOwnerIdentityReaderSurface(input);
    assert.deepEqual(result, Object.create(null));
  }
}

// ============================================================================
// Group 3: Purpose Mismatches and Validation Gates
// ============================================================================

// Verify that unauthorized metadata combinations or duplicate tool IDs fail closed.
{
  const invalidSnapshots = [
    // Duplicate tool IDs in the registry
    makeSnapshot([VALID_ENTRY_BOOTSTRAP, VALID_ENTRY_BOOTSTRAP]),

    // Mismatched actor ID
    makeSnapshot([{
      ...VALID_ENTRY_BOOTSTRAP,
      actorId: 'attacker-registry'
    }]),

    // Mismatched capability class
    makeSnapshot([{
      ...VALID_ENTRY_BOOTSTRAP,
      capabilityClass: 'identity-existence-read'
    }]),

    // Mismatched vaultKey in binding
    makeSnapshot([{
      ...VALID_ENTRY_BOOTSTRAP,
      identityBinding: {
        vaultKey: 'wrong_key_v1',
        purpose: 'owner_legal_identity'
      }
    }]),

    // Mismatched purpose in binding
    makeSnapshot([{
      ...VALID_ENTRY_BOOTSTRAP,
      identityBinding: {
        vaultKey: 'owner_legal_identity_v1',
        purpose: 'wrong_purpose'
      }
    }]),

    // Completely unlisted tool ID
    makeSnapshot([{
      ...VALID_ENTRY_BOOTSTRAP,
      toolId: 'owner_identity.unlisted_reader'
    }]),

    // Binding with extra properties
    makeSnapshot([{
      ...VALID_ENTRY_BOOTSTRAP,
      identityBinding: {
        vaultKey: 'owner_legal_identity_v1',
        purpose: 'owner_legal_identity',
        extra: 'property'
      }
    }]),

    // Entry with extra properties
    makeSnapshot([{
      ...VALID_ENTRY_BOOTSTRAP,
      extra: 'property'
    }]),

    // Snapshot with more entries than the total number of declared surfaces
    makeSnapshot([
      VALID_ENTRY_BOOTSTRAP,
      VALID_ENTRY_STATUS,
      {
        toolId: 'owner_identity.profile_status',
        actorId: 'tool-registry',
        capabilityClass: 'identity-existence-read',
        identityBinding: {
          vaultKey: 'owner_legal_identity_v1',
          purpose: 'owner_legal_identity'
        }
      }
    ])
  ];

  for (const invalid of invalidSnapshots) {
    const result = audit.auditOwnerIdentityReaderSurface(invalid);
    assert.deepEqual(result, Object.create(null));
    assert.equal(Object.keys(result).length, 0);
  }
}

// ============================================================================
// Group 4: Redaction and Data Exfiltration Prevention
// ============================================================================

// Verify that the output map contains only public routing projections and no secret metadata.
{
  const result = audit.auditOwnerIdentityReaderSurface(makeSnapshot([VALID_ENTRY_BOOTSTRAP, VALID_ENTRY_STATUS]));

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('owner_legal_identity_v1'), false);
  assert.equal(serialized.includes('owner_legal_identity'), false);
  assert.equal(serialized.includes('vaultKey'), false);
  assert.equal(serialized.includes('purpose'), false);
  assert.equal(serialized.includes('identityBinding'), false);

  assert.deepEqual(Object.keys(result).sort(), [
    'owner_identity.bootstrap_from_publisher_evidence',
    'owner_identity.profile_status'
  ]);

  for (const key of Object.keys(result)) {
    const record = result[key];
    const recordKeys = Object.keys(record);
    assert.deepEqual(recordKeys.sort(), ['actorIds', 'capabilityClasses'].sort());
  }
}

// ============================================================================
// Group 5: Frozen Deterministic Output & Immutability
// ============================================================================

// Verify that the returned projection map, nested elements, and arrays are completely frozen.
{
  const result = audit.auditOwnerIdentityReaderSurface(makeSnapshot([VALID_ENTRY_BOOTSTRAP, VALID_ENTRY_STATUS]));

  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Object.keys(result).sort(), [
    'owner_identity.bootstrap_from_publisher_evidence',
    'owner_identity.profile_status'
  ]);

  assert.throws(() => {
    result.newKey = 'test';
  }, TypeError);

  assert.throws(() => {
    delete result['owner_identity.profile_status'];
  }, TypeError);

  for (const key of Object.keys(result)) {
    const record = result[key];
    assert.equal(Object.isFrozen(record), true);

    assert.throws(() => {
      record.actorIds = [];
    }, TypeError);

    assert.throws(() => {
      record.newProp = 123;
    }, TypeError);

    assert.equal(Object.isFrozen(record.actorIds), true);
    assert.equal(Object.isFrozen(record.capabilityClasses), true);

    assert.throws(() => {
      record.actorIds.push('extra-actor');
    }, TypeError);

    assert.throws(() => {
      record.capabilityClasses[0] = 'escalated-class';
    }, TypeError);
  }
}

// Verify that the returned EMPTY_MAP for rejected/invalid inputs is also completely frozen.
{
  const result = audit.auditOwnerIdentityReaderSurface("invalid-json-payload");
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.keys(result).length, 0);

  assert.throws(() => {
    result.anyProp = 'malicious';
  }, TypeError);
}

// Verify size boundary enforcement.
{
  const exactLimit = 32 * 1024;

  const overLimitString = ' '.repeat(exactLimit + 1);
  assert.deepEqual(audit.auditOwnerIdentityReaderSurface(overLimitString), Object.create(null));

  const withinLimitWhitespace = ' '.repeat(exactLimit);
  assert.deepEqual(audit.auditOwnerIdentityReaderSurface(withinLimitWhitespace), Object.create(null));
}

process.stdout.write('Adversarial owner identity reader audit tests passed successfully.\n');
