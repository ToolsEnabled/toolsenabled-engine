'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vcs = require('../src');

test('public surface exposes frozen contract vocabulary', () => {
  assert.equal(typeof vcs.VcsError, 'function');
  assert.equal(vcs.VCS_ERROR_CODES.NOT_IMPLEMENTED, 'VCS_NOT_IMPLEMENTED');
  assert.deepEqual(vcs.TRUTH_STATES, ['SAFE', 'UNSAFE', 'UNKNOWN']);
  assert.ok(vcs.CONFLICT_KINDS.includes('SEMANTIC'));
  assert.ok(vcs.REVISION_STATES.includes('OBSERVED_RUNNING'));
  assert.ok(Object.isFrozen(vcs.TRUTH_STATES));
});

test('public surface exposes eight service contracts', () => {
  assert.deepEqual(Object.keys(vcs.services).sort(), [
    'backups',
    'claims',
    'conflicts',
    'governance',
    'lifecycle',
    'operations',
    'publication',
    'revisions',
  ]);
});

test('public surface exposes twelve adapter contracts', () => {
  assert.equal(Object.keys(vcs.adapters).length, 12);
  for (const adapter of Object.values(vcs.adapters)) {
    assert.equal(adapter.implemented, false);
    assert.ok(Object.isFrozen(adapter));
    assert.ok(Object.isFrozen(adapter.methodContracts));
  }
});
