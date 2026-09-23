'use strict';

// Mutation check:
// - Module edit: changed tokenHash's createHash('sha256') to createHash('sha1').
// - The edit landed: yes (the mutated source line was found before the run).
// - This isolated test went red: yes (exit 1 at the tokenHash digest assertion).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

// These process-owned adapters are outside the exported pure behavior under
// test. Avoid opening durable state merely by loading the module.
const originalLoad = Module._load;
Module._load = function loadWithoutProcessState(request, parent, isMain) {
  if (request === './state-store' && parent.filename.endsWith('/src/lib/scoped-approvals.js')) {
    return { getStateStore: () => assert.fail('state must not be reached') };
  }
  return Reflect.apply(originalLoad, this, [request, parent, isMain]);
};
const scopedApprovals = require('../src/lib/scoped-approvals');
Module._load = originalLoad;

const token = `${'A'.repeat(42)}_`;
const action = {
  approvalId: 'approval-123',
  action: 'host.exec',
  target: 'workstation',
  parameters: { command: 'printf scoped' },
  subject: { taskId: 'task-123' },
  previewHash: 'f'.repeat(64),
  expiresAtMs: 2_000_000_000_000,
  status: 'pending',
  controllerOnly: 'must not reach the prompt'
};

assert.equal(Object.isFrozen(scopedApprovals), true);
assert.deepEqual(Object.keys(scopedApprovals).sort(), [
  'TOKEN', 'consumeForDispatch', 'error', 'tokenHash', 'uiContract'
]);

assert.equal(scopedApprovals.TOKEN.test(token), true);
assert.equal(scopedApprovals.TOKEN.test(`${'A'.repeat(42)}=`), false);
assert.equal(
  scopedApprovals.tokenHash(token),
  crypto.createHash('sha256').update(token, 'utf8').digest('hex')
);
assert.throws(
  () => scopedApprovals.tokenHash('too-short'),
  error => error.name === 'ScopedApprovalError' && error.code === 'APPROVAL_TOKEN_INVALID'
);

const contract = scopedApprovals.uiContract(action);
assert.deepEqual(contract, {
  schemaVersion: '1.0.0',
  approvalId: 'approval-123',
  action: 'host.exec',
  target: 'workstation',
  parameters: { command: 'printf scoped' },
  subject: { taskId: 'task-123' },
  previewHash: 'f'.repeat(64),
  expiresAtMs: 2_000_000_000_000,
  singleUse: true,
  revocable: true
});
assert.equal(Object.isFrozen(contract), true);
assert.equal(Object.hasOwn(contract, 'status'), false);
assert.equal(Object.hasOwn(contract, 'controllerOnly'), false);
assert.throws(
  () => scopedApprovals.uiContract(null),
  error => error.code === 'SCOPED_APPROVAL_NOT_FOUND'
);

const constructed = scopedApprovals.error('TEST_CODE', 'test message', { field: 'approvalId' });
assert.equal(constructed.name, 'ScopedApprovalError');
assert.equal(constructed.code, 'TEST_CODE');
assert.equal(constructed.message, 'test message');
assert.deepEqual(constructed.details, { field: 'approvalId' });

assert.throws(
  () => scopedApprovals.consumeForDispatch({}, { injectedState: true }),
  error => error.code === 'SCOPED_APPROVAL_DEPENDENCY_INJECTION_FORBIDDEN'
);

process.stdout.write('scoped-approvals: exported behavior checks passed\n');
