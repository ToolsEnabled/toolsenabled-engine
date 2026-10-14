'use strict';

require('./helpers/isolated-state-root'); // FINDING 1, REPORT-ledger-kinds-tools-20260907.md: redirect TOOLSENABLED_STATE_ROOT off the live root before anything below can resolve it.

const assert = require('node:assert/strict');
const {
  REQUEST_ID_RE,
  parseRequestId,
  isRequestId,
  compareRequestIds
} = require('../src/lib/request-id');

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
};

check('the exported grammar is canonical', () => {
  assert.equal(REQUEST_ID_RE.source, '^(R|Q)(0\\d|[1-9]\\d{0,3})(\\.[1-9]\\d*)*$');
});

check('zero-padded R01-R09 ids are accepted and preserved', () => {
  for (let value = 1; value <= 9; value += 1) {
    const id = `R0${value}`;
    const parsed = parseRequestId(id);
    assert.equal(parsed.id, id);
    assert.equal(parsed.root, id);
    assert.equal(parsed.rootNumber, value);
    assert.deepEqual(parsed.segments, []);
  }
  // The approved grammar's 0\d branch also admits 00; keep the implementation
  // exact rather than silently substituting a stricter policy.
  assert.equal(isRequestId('R00'), true);
});

check('R/Q roots and arbitrarily nested positive dotted segments are accepted', () => {
  for (const id of ['R1', 'R9999', 'Q01', 'Q9', 'Q9999', 'R133.1', 'R01.1', 'Q40.2.3', 'R1.99999.2']) {
    assert.equal(isRequestId(id), true, id);
  }
  assert.deepEqual(parseRequestId('Q40.2.3'), {
    id: 'Q40.2.3', family: 'Q', root: 'Q40', rootNumber: 40, segments: [2, 3]
  });
});

check('family and root-only constraints are explicit without changing the grammar', () => {
  assert.equal(isRequestId('R01', { family: 'R', rootOnly: true }), true);
  assert.equal(isRequestId('R01.1', { family: 'R', rootOnly: true }), false);
  assert.equal(isRequestId('Q01', { family: 'R' }), false);
  assert.equal(isRequestId('Q01.1', { family: 'Q' }), true);
});

check('malformed, zero, overlong-root, and normalized-away ids are rejected', () => {
  for (const value of [
    null, '', 'R', 'r1', 'R000', 'R001', 'R10000', 'Q10000',
    'R1.0', 'R1.01', 'R1.', 'R1..1', 'R-1', ' R1', 'R1 ', 'R+1'
  ]) {
    assert.equal(isRequestId(value), false, String(value));
    assert.equal(parseRequestId(value), null, String(value));
  }
});

check('request id ordering is numeric by root and dotted segment', () => {
  const ids = ['R10', 'R01.2', 'R2', 'R01', 'R01.10', 'R01.1'];
  assert.deepEqual(ids.sort(compareRequestIds), ['R01', 'R01.1', 'R01.2', 'R01.10', 'R2', 'R10']);
});

check('unrepresentable dotted segments are refused instead of compared as rounded numbers', () => {
  assert.throws(() => parseRequestId('R1.9007199254740993'), RangeError);
  assert.throws(() => isRequestId('R1.9007199254740993'), RangeError);
  assert.throws(
    () => compareRequestIds('R1.9007199254740992', 'R1.9007199254740993'),
    RangeError
  );
});

check('T/A/P tokens (the owner-request ledger\'s other three record kinds) are not R or Q ids, so a T/A/P id sitting in the ledger or its hash chain cannot move the R (or Q) counter -- src/lib/owner-request-store.js\'s nextRootNumber and highestRootNumber rely on exactly this to stay safe without parsing kind at all', () => {
  for (const id of ['T1', 'A1', 'P1', 'T9999', 'A01', 'P100.1']) {
    assert.equal(isRequestId(id), false, `${id} must not be a request id at all`);
    assert.equal(isRequestId(id, { family: 'R' }), false, `${id} must not resolve to family R`);
    assert.equal(parseRequestId(id), null, `${id} must not parse; highestRootNumber's chain scan (parseRequestId(id).rootNumber) must see nothing here`);
  }
});

console.log(`request-id: ${checks} checks passed`);
