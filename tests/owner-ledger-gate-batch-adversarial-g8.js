// EXECUTABLE CHANGE
//
// Discrimination report (owner-ledger-gate-batch-adversarial-g8):
// - VACUOUS-COLLECTION FOUND: the Object.isFrozen(entryObj) assertion loop could
//   execute zero times. Mutation: for the gate-a/gate-b request only, the code
//   under test returned Object.freeze([]) instead of Object.freeze(selected).
//   Before strengthening, the complete file stayed green:
//     owner-ledger-gate-batch-adversarial-g8 tests passed (5 checks).
//   After strengthening, the same mutant was RED:
//     AssertionError [ERR_ASSERTION]: Selected page must contain its requested entry
//     0 !== 1
// - EXIT-STATUS-ONLY NOT-FOUND: this in-process test does not spawn a process or
//   assert on an exit status/truthy process return.
// - SWALLOWED-FAILURE NOT-FOUND: no try/catch or optional chain occurs in this
//   test; assert.throws validates both TypeError and the product error code.
// - SUBJECT-MOCK NOT-FOUND: selectGateBatch is imported directly from the
//   product module and none of its dependencies or outputs are mocked.
// - SKIP/PRECONDITION-GUARD NOT-FOUND: the file has no skip or platform guard.
// - SAME-CODE-EXPECTED-VALUE NOT-FOUND: expected values are literal invariants,
//   independent hostile-object flags, and native reflection results rather than
//   values computed by selectGateBatch.
// - RESTORATION: src/lib/owner-ledger-gate-batch.js was restored byte-for-byte
//   (SHA-256 d3b08560cafca42c20595cf9537688e41bc3bd85627fdfa037a277b9dbe1dbad).
//   The restored final run was green:
//     owner-ledger-gate-batch-adversarial-g8 tests passed (5 checks).
// - UNMET-PRECONDITIONS: none.

'use strict';

const assert = require('node:assert/strict');
const { MAX_BATCH_COUNT, MAX_ENTRIES, selectGateBatch } = require('../src/lib/owner-ledger-gate-batch');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
}

function entry(gateId, overrides = {}) {
  return {
    gateId,
    requestId: 'R100',
    requestStatus: 'open',
    gateIndex: 0,
    ...overrides
  };
}

function request(entries, cursor = null, count = 25) {
  return { entries, cursor, count };
}

function expectRejected(fn, code) {
  assert.throws(fn, error => {
    return error instanceof TypeError && error.message.includes(code);
  });
}

check('Snapshot binding: modifying any fields invalidates the snapshot', () => {
  const original = [
    entry('gate-a', { instruction: 'do task A' }),
    entry('gate-b'),
    entry('gate-c')
  ];

  // Get a cursor pointing to page 2 (after gate-a)
  const firstPage = selectGateBatch(request(original, null, 1));
  const validCursor = firstPage.nextCursor;
  assert.equal(typeof validCursor, 'string');

  // Verify that the exact same entries array succeeds on pagination
  const secondPage = selectGateBatch(request(original, validCursor, 1));
  assert.equal(secondPage.entries[0].gateId, 'gate-b');

  // 1. Modifying gateId of gate-a
  const modGateId = [
    entry('gate-a-altered', { instruction: 'do task A' }),
    entry('gate-b'),
    entry('gate-c')
  ];
  expectRejected(() => selectGateBatch(request(modGateId, validCursor, 1)), 'CURSOR_SNAPSHOT_MISMATCH');

  // 2. Modifying requestId
  const modRequestId = [
    entry('gate-a', { instruction: 'do task A', requestId: 'R200' }),
    entry('gate-b'),
    entry('gate-c')
  ];
  expectRejected(() => selectGateBatch(request(modRequestId, validCursor, 1)), 'CURSOR_SNAPSHOT_MISMATCH');

  // 3. Modifying requestStatus
  const modRequestStatus = [
    entry('gate-a', { instruction: 'do task A' }),
    entry('gate-b', { requestStatus: 'closed' }),
    entry('gate-c')
  ];
  expectRejected(() => selectGateBatch(request(modRequestStatus, validCursor, 1)), 'CURSOR_SNAPSHOT_MISMATCH');

  // 4. Modifying gateIndex
  const modGateIndex = [
    entry('gate-a', { instruction: 'do task A' }),
    entry('gate-b'),
    entry('gate-c', { gateIndex: 5 })
  ];
  expectRejected(() => selectGateBatch(request(modGateIndex, validCursor, 1)), 'CURSOR_SNAPSHOT_MISMATCH');

  // 5. Changing instruction value
  const modInstructionValue = [
    entry('gate-a', { instruction: 'do task A modified' }),
    entry('gate-b'),
    entry('gate-c')
  ];
  expectRejected(() => selectGateBatch(request(modInstructionValue, validCursor, 1)), 'CURSOR_SNAPSHOT_MISMATCH');

  // 6. Adding instruction where it was absent
  const modAddInstruction = [
    entry('gate-a', { instruction: 'do task A' }),
    entry('gate-b', { instruction: 'now has instruction' }),
    entry('gate-c')
  ];
  expectRejected(() => selectGateBatch(request(modAddInstruction, validCursor, 1)), 'CURSOR_SNAPSHOT_MISMATCH');

  // 7. Removing instruction where it was present
  const modRemoveInstruction = [
    entry('gate-a'),
    entry('gate-b'),
    entry('gate-c')
  ];
  expectRejected(() => selectGateBatch(request(modRemoveInstruction, validCursor, 1)), 'CURSOR_SNAPSHOT_MISMATCH');

  // 8. Removing an entry entirely
  const modRemoveEntry = [
    entry('gate-a', { instruction: 'do task A' }),
    entry('gate-b')
  ];
  expectRejected(() => selectGateBatch(request(modRemoveEntry, validCursor, 1)), 'CURSOR_SNAPSHOT_MISMATCH');

  // 9. Adding an extra entry
  const modAddEntry = [
    entry('gate-a', { instruction: 'do task A' }),
    entry('gate-b'),
    entry('gate-c'),
    entry('gate-d')
  ];
  expectRejected(() => selectGateBatch(request(modAddEntry, validCursor, 1)), 'CURSOR_SNAPSHOT_MISMATCH');
});

check('Hostile objects and accessors: getters are not executed and fail closed', () => {
  // A request object with an accessor (getter) property must be rejected
  // without the getter ever being executed.
  let requestAccessorExecuted = false;
  const hostileRequest = {};
  Object.defineProperty(hostileRequest, 'entries', {
    enumerable: true,
    get() {
      requestAccessorExecuted = true;
      return [entry('gate-a')];
    }
  });
  Object.defineProperty(hostileRequest, 'cursor', { enumerable: true, value: null });
  Object.defineProperty(hostileRequest, 'count', { enumerable: true, value: 1 });

  expectRejected(() => selectGateBatch(hostileRequest), 'REQUEST_ACCESSOR');
  assert.equal(requestAccessorExecuted, false, 'Accessor getter on request must not be executed');

  // An entry object with an accessor (getter) property must be rejected
  // without the getter ever being executed.
  let entryAccessorExecuted = false;
  const hostileEntry = {
    requestId: 'R100',
    requestStatus: 'open',
    gateIndex: 0
  };
  Object.defineProperty(hostileEntry, 'gateId', {
    enumerable: true,
    get() {
      entryAccessorExecuted = true;
      return 'gate-a';
    }
  });

  expectRejected(() => selectGateBatch(request([hostileEntry])), 'ENTRY_0_ACCESSOR');
  assert.equal(entryAccessorExecuted, false, 'Accessor getter on entry must not be executed');

  // Hostile Proxy wrapping the Request object that throws in a trap
  let requestProxyTrapCalled = false;
  const hostileRequestProxy = new Proxy(request([entry('gate-a')]), {
    getPrototypeOf(target) {
      requestProxyTrapCalled = true;
      throw new Error('Hostile request proxy trap triggered');
    }
  });
  expectRejected(() => selectGateBatch(hostileRequestProxy), 'REQUEST_UNSAFE_OBJECT');
  assert.equal(requestProxyTrapCalled, true, 'Proxy getPrototypeOf trap should be triggered');

  // Hostile Proxy wrapping the Entries array that throws in a trap
  let entriesProxyTrapCalled = false;
  const hostileEntriesProxy = new Proxy([entry('gate-a')], {
    ownKeys(target) {
      entriesProxyTrapCalled = true;
      throw new Error('Hostile entries proxy trap triggered');
    }
  });
  expectRejected(() => selectGateBatch(request(hostileEntriesProxy)), 'ENTRIES_UNSAFE_ARRAY');
  assert.equal(entriesProxyTrapCalled, true, 'Proxy ownKeys trap should be triggered');

  // Hostile Proxy wrapping an Entry object that throws in a trap
  let entryProxyTrapCalled = false;
  const hostileEntryProxy = new Proxy(entry('gate-a'), {
    ownKeys(target) {
      entryProxyTrapCalled = true;
      throw new Error('Hostile entry proxy trap triggered');
    }
  });
  expectRejected(() => selectGateBatch(request([hostileEntryProxy])), 'ENTRY_0_UNSAFE_OBJECT');
  assert.equal(entryProxyTrapCalled, true, 'Proxy ownKeys trap should be triggered');
});

check('Oversized and sparse arrays: validated carefully and fail closed', () => {
  // 1. Oversized array (exactly MAX_ENTRIES + 1)
  const oversizedArray = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => {
    return entry(`gate-${i}`);
  });
  expectRejected(() => selectGateBatch(request(oversizedArray, null, 1)), 'ENTRIES_INVALID_LENGTH');

  // 2. Sparse array (using index assignments leaving a hole)
  const sparseArray1 = [entry('gate-a')];
  sparseArray1[2] = entry('gate-b'); // index 1 is empty slot/hole
  expectRejected(() => selectGateBatch(request(sparseArray1, null, 1)), 'ENTRIES_EXTRA_OR_SPARSE_FIELDS');

  // 3. Sparse array via new Array(length)
  const sparseArray2 = new Array(3);
  expectRejected(() => selectGateBatch(request(sparseArray2, null, 1)), 'ENTRIES_EXTRA_OR_SPARSE_FIELDS');

  // 4. Array with extra custom property
  const extraPropArray = [entry('gate-a'), entry('gate-b')];
  extraPropArray.customProperty = 'malicious';
  expectRejected(() => selectGateBatch(request(extraPropArray, null, 1)), 'ENTRIES_EXTRA_OR_SPARSE_FIELDS');

  // 5. Redefined non-integer length via Proxy.
  // Note: Attempting to spoof the non-configurable 'length' property of an array
  // violates JS Proxy invariants, causing the JS engine to throw a TypeError
  // during Object.getOwnPropertyDescriptors. The selector catches this and
  // correctly fails closed with ENTRIES_UNSAFE_ARRAY.
  const invalidLengthProxy = new Proxy([entry('gate-a')], {
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'length') {
        return { value: 1.5, writable: true, enumerable: false, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    }
  });
  expectRejected(() => selectGateBatch(request(invalidLengthProxy, null, 1)), 'ENTRIES_UNSAFE_ARRAY');

  // 6. Redefined negative length via Proxy.
  // Note: Similarly, this violates Proxy invariants and fails closed with ENTRIES_UNSAFE_ARRAY.
  const negativeLengthProxy = new Proxy([entry('gate-a')], {
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'length') {
        return { value: -1, writable: true, enumerable: false, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    }
  });
  expectRejected(() => selectGateBatch(request(negativeLengthProxy, null, 1)), 'ENTRIES_UNSAFE_ARRAY');
});

check('Cursor canonicality: reject non-canonical base64url or hex casing or oversized cursors', () => {
  const original = [entry('a'), entry('b')];
  const firstPage = selectGateBatch(request(original, null, 1));
  const validCursor = firstPage.nextCursor;
  assert.equal(typeof validCursor, 'string');

  // A valid cursor looks like: olgb1.<64-hex>.<base64url-gateId>
  // Since original has 'a' and 'b', and count=1, the cursor points to gate 'a'.
  // The gateId 'a' is base64url-encoded as 'YQ'.
  assert.ok(validCursor.endsWith('.YQ'), `Valid cursor should end with .YQ, got: ${validCursor}`);

  // 1. Non-canonical base64url representation: 'YR' instead of 'YQ'
  // Decodes to the exact same gateId 'a' but its encoded form is not canonical.
  const nonCanonicalCursor = validCursor.slice(0, -2) + 'YR';
  expectRejected(() => selectGateBatch(request(original, nonCanonicalCursor, 1)), 'MALFORMED_CURSOR');

  // 2. Uppercase hex casing in snapshot hash
  const uppercaseHexCursor = validCursor.replace(/[a-f]/g, m => m.toUpperCase());
  // Make sure we actually changed something to uppercase
  assert.notEqual(uppercaseHexCursor, validCursor);
  expectRejected(() => selectGateBatch(request(original, uppercaseHexCursor, 1)), 'MALFORMED_CURSOR');

  // 3. Oversized cursor string
  // Let's create a cursor string with valid format but pushing length past 512
  // We can construct a very long gateId (e.g. 250 'x' characters).
  const longGateId = 'x'.repeat(250);
  const longOriginal = [entry(longGateId), entry('y')];
  const longFirstPage = selectGateBatch(request(longOriginal, null, 1));
  const longValidCursor = longFirstPage.nextCursor;
  assert.ok(longValidCursor.length <= 512, `Cursor length should be under limit, got: ${longValidCursor.length}`);

  // Now make it over 512 by padding the end of the base64url with characters
  const oversizedCursor = longValidCursor + 'A'.repeat(200);
  assert.ok(oversizedCursor.length > 512, `Cursor length should be over limit, got: ${oversizedCursor.length}`);
  expectRejected(() => selectGateBatch(request(longOriginal, oversizedCursor, 1)), 'MALFORMED_CURSOR');

  // 4. Cursor with invalid characters (e.g. trailing space, newline, or non-base64url characters)
  expectRejected(() => selectGateBatch(request(original, validCursor + ' ', 1)), 'MALFORMED_CURSOR');
  expectRejected(() => selectGateBatch(request(original, validCursor + '\n', 1)), 'MALFORMED_CURSOR');
  expectRejected(() => selectGateBatch(request(original, validCursor + '=', 1)), 'MALFORMED_CURSOR');
  expectRejected(() => selectGateBatch(request(original, validCursor + '+', 1)), 'MALFORMED_CURSOR');
  expectRejected(() => selectGateBatch(request(original, validCursor + '/', 1)), 'MALFORMED_CURSOR');
});

check('Output immutability: results and entries are deeply frozen and immutable', () => {
  const original = [entry('gate-a'), entry('gate-b')];
  const result = selectGateBatch(request(original, null, 1));

  // Verify objects are frozen
  assert.ok(Object.isFrozen(result), 'Result object must be frozen');
  assert.ok(Object.isFrozen(result.entries), 'Entries array in result must be frozen');
  assert.equal(result.entries.length, 1, 'Selected page must contain its requested entry');
  for (const entryObj of result.entries) {
    assert.ok(Object.isFrozen(entryObj), 'Each returned entry must be frozen');
  }

  // Verify that mutation attempts throw TypeErrors in strict mode
  assert.throws(() => { result.total = 999; }, TypeError);
  assert.throws(() => { result.entries[0] = null; }, TypeError);
  assert.throws(() => { result.entries.push(entry('gate-c')); }, TypeError);
  assert.throws(() => { result.entries[0].gateId = 'altered'; }, TypeError);
  assert.throws(() => { result.newProperty = 'malicious'; }, TypeError);
  assert.throws(() => { delete result.total; }, TypeError);
  assert.throws(() => { delete result.entries[0].gateId; }, TypeError);
});

console.log(`owner-ledger-gate-batch-adversarial-g8 tests passed (${checks} checks).`);
