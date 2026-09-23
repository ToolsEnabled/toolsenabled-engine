/* Mutation check:
 * Replaced `Boolean(requirementIsOwners && citedConstraint && !constraintIsOwners)`
 * with `false` for `requiresOwnerReview` in the required module.
 * The mutation landed, and this isolated test went red with exit code 1.
 */
'use strict';

// Behavioural coverage for owner-requirement-descope. These tests use the
// public exports only: they do not duplicate or reach into its implementation.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const descope = require('../src/lib/owner-requirement-descope');

// Refusals in this pure builder must throw before a caller could mistake a
// partial record for success. Guard the important negative side effects too:
// none of the invalid inputs may write a file or launch another process.
let writes = 0;
let spawns = 0;
const originalWriteFileSync = fs.writeFileSync;
const originalAppendFileSync = fs.appendFileSync;
const originalSpawnSync = childProcess.spawnSync;
const originalSpawn = childProcess.spawn;
fs.writeFileSync = (...args) => { writes += 1; return originalWriteFileSync(...args); };
fs.appendFileSync = (...args) => { writes += 1; return originalAppendFileSync(...args); };
childProcess.spawnSync = (...args) => { spawns += 1; return originalSpawnSync(...args); };
childProcess.spawn = (...args) => { spawns += 1; return originalSpawn(...args); };

const ownerRequest = {
  id: 'R1200',
  provenance: {
    class: 'owner-stated',
    recordedBy: 'controller',
    source: 'owner session 2026-08-10'
  }
};

function input(overrides = {}) {
  return {
    descopeId: 'D1',
    requestId: 'R1200',
    requirement: 'the $350 USPTO trademark filing, 1 class',
    action: 'dropped',
    reason: 'the filing exceeds a daily spending limit set by an agent',
    citedConstraint: {
      name: 'limits.defaultDailySpendUsd',
      value: '100',
      provenanceClass: 'agent-inferred',
      source: 'initial agent-authored policy'
    },
    decidedBy: 'purchase-list-lane',
    decidedAt: '2026-08-12T10:00:00.000Z',
    restoreCondition: 'restore after the owner decides which rule wins',
    ...overrides
  };
}

// The central contract: an owner's requirement must not quietly lose to an
// agent-authored constraint. The returned record makes that conflict visible.
const flagged = descope.buildDescopeRecord(input(), { requestEntry: ownerRequest });
assert.equal(flagged.requiresOwnerReview, true);
assert.equal(flagged.requirementProvenance, 'owner-stated');
assert.match(flagged.ownerReviewReason, /not the owner's/);
assert.equal(flagged.restoreCondition, 'restore after the owner decides which rule wins');
assert.ok(Object.isFrozen(flagged));

// A constraint genuinely attributable to the owner does not create the same
// conflict, while the cited constraint is normalized to trimmed public data.
const ownerConstraint = descope.normalizeCitedConstraint({
  name: '  owner-approved August budget  ',
  provenanceClass: 'owner-stated'
});
const unflagged = descope.buildDescopeRecord(input({
  descopeId: 'D2',
  action: 'deferred',
  citedConstraint: ownerConstraint,
  decidedAt: '2026-08-13T10:00:00.000Z'
}), { requestEntry: ownerRequest });
assert.deepEqual(ownerConstraint, {
  name: 'owner-approved August budget',
  provenanceClass: 'owner-stated'
});
assert.equal(unflagged.requiresOwnerReview, false);
assert.equal('ownerReviewReason' in unflagged, false);

// Review projection filters unrelated records and orders the remaining work
// newest-first without modifying the input array.
const laterFlagged = descope.buildDescopeRecord(input({
  descopeId: 'D3',
  decidedAt: '2026-08-14T10:00:00.000Z'
}), { requestEntry: ownerRequest });
const records = [flagged, unflagged, laterFlagged];
const pending = descope.pendingOwnerReview(records);
assert.deepEqual(pending.map(record => record.descopeId), ['D3', 'D1']);
assert.deepEqual(records.map(record => record.descopeId), ['D1', 'D2', 'D3']);
assert.ok(Object.isFrozen(pending));

const summary = descope.summarizeDescopes(records);
assert.deepEqual(summary, {
  total: 3,
  byAction: { dropped: 2, deferred: 1, narrowed: 0, replaced: 0 },
  requiringOwnerReview: 2
});
assert.ok(Object.isFrozen(summary));
assert.ok(Object.isFrozen(summary.byAction));

// Invalid calls fail with the module's typed, coded public error rather than
// producing a record which can silently omit the decision or its rationale.
assert.throws(
  () => descope.buildDescopeRecord(input({ reason: 'too short' }), { requestEntry: ownerRequest }),
  error => error instanceof descope.OwnerDescopeError
    && error.code === 'OWNER_DESCOPE_REASON_REQUIRED'
);
assert.throws(
  () => descope.normalizeCitedConstraint({ name: 'known', surprise: true }),
  error => error instanceof descope.OwnerDescopeError
    && error.code === 'OWNER_DESCOPE_CONSTRAINT_INVALID'
);

const invalidDescopes = [
  {
    name: 'requires a plain input object',
    value: null,
    message: 'A descope record input object is required.'
  },
  {
    name: 'rejects unknown top-level fields',
    value: input({ surprise: true }),
    message: 'Unknown field(s): surprise.'
  },
  {
    name: 'rejects a malformed descope id',
    value: input({ descopeId: 'descope-1' }),
    message: 'descopeId must match /^D[0-9]{1,6}$/ (e.g. "D1"); got "descope-1".'
  },
  {
    name: 'requires the linked request id',
    value: input({ requestId: '  ' }),
    message: 'requestId is required: which ledger request is being descoped.'
  },
  {
    name: 'rejects an unsupported action',
    value: input({ action: 'hidden' }),
    message: 'action must be one of dropped, deferred, narrowed, replaced; got "hidden".'
  },
  {
    name: 'rejects an invalid decision timestamp',
    value: input({ decidedAt: 'not-a-date' }),
    message: 'decidedAt is not a valid ISO timestamp: "not-a-date".'
  }
];

for (const refusal of invalidDescopes) {
  const before = { writes, spawns };
  assert.throws(
    () => descope.buildDescopeRecord(refusal.value, { requestEntry: ownerRequest }),
    error => {
      assert.ok(error instanceof descope.OwnerDescopeError, refusal.name);
      assert.equal(error.code, 'OWNER_DESCOPE_INVALID', refusal.name);
      assert.equal(error.message, refusal.message, refusal.name);
      assert.equal(error.details, undefined, refusal.name);
      return true;
    }
  );
  assert.deepEqual({ writes, spawns }, before, `${refusal.name}: no write or spawn`);
}

fs.writeFileSync = originalWriteFileSync;
fs.appendFileSync = originalAppendFileSync;
childProcess.spawnSync = originalSpawnSync;
childProcess.spawn = originalSpawn;

// Exercise the remaining exported values as public contracts.
assert.equal(descope.DESCOPE_VERSION, 1);
assert.deepEqual([...descope.DESCOPE_ACTIONS], ['dropped', 'deferred', 'narrowed', 'replaced']);
assert.equal(descope.DESCOPE_ID_RE.test('D999'), true);
assert.equal(descope.DESCOPE_ID_RE.test('descope-999'), false);
assert.equal(descope.normalizeProvenance({
  class: 'agent-inferred', recordedBy: 'test-agent'
}).class, 'agent-inferred');

console.log('owner-requirement-descope: behavioural contract passed');
