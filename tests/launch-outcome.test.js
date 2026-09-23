/* Mutation check:
 * Changed the digest domain from `toolsenabled.launch-terminal.v${SCHEMA_VERSION}`
 * to `toolsenabled.launch-terminal.mutated.v${SCHEMA_VERSION}` in the module.
 * The edit landed: yes. This test file went red: yes (exit code 1).
 */
'use strict';

// Behaviour tests for the public launch-outcome value contract. These call the
// module's exports directly: accepted values are normalized into immutable,
// canonically hashed receipts, while malformed and mismatched values refuse
// with the module's named errors.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const outcome = require('../src/lib/launch-outcome');

const launchId = 'launch_0123456789abcdef';
const launchRecordHash = 'a'.repeat(64);
const terminalAt = '2026-08-27T12:34:56.789Z';

function errorCode(expected) {
  return error => error instanceof outcome.LaunchOutcomeError && error.code === expected;
}

function expectedReceiptHash(body) {
  const stableBody = {
    ...(body.failureReason === undefined ? {} : { failureReason: body.failureReason }),
    launchId: body.launchId,
    launchRecordHash: body.launchRecordHash,
    schemaVersion: body.schemaVersion,
    terminalAt: body.terminalAt,
    terminalState: body.terminalState
  };
  return crypto.createHash('sha256')
    .update(`toolsenabled.launch-terminal.v1\0${JSON.stringify(stableBody)}`)
    .digest('hex');
}

assert.equal(outcome.SCHEMA_VERSION, 1);
assert.equal(outcome.TERMINAL_ACTION, 'controller.agent.launch.terminal');
assert.deepEqual(outcome.TERMINAL_STATES, ['completed', 'failed', 'cancelled']);
assert.equal(Object.isFrozen(outcome.TERMINAL_STATES), true);

for (const terminalState of outcome.TERMINAL_STATES) {
  const request = outcome.normalizeTerminalRequest({ launchId, terminalState });
  assert.deepEqual(request, { launchId, terminalState });
  assert.equal(Object.isFrozen(request), true);
}

assert.throws(
  () => outcome.normalizeTerminalRequest({ launchId, terminalState: 'pending' }),
  errorCode('LAUNCH_TERMINAL_INVALID')
);
assert.throws(
  () => outcome.normalizeTerminalRequest({ launchId, terminalState: 'completed', prompt: 'smuggled' }),
  errorCode('LAUNCH_TERMINAL_INVALID')
);

const failureReason = "VERDICT: Claude provider refused the lane: You're out of usage credits.";
assert.deepEqual(
  outcome.normalizeTerminalRequest({ launchId, terminalState: 'failed', failureReason }),
  { launchId, terminalState: 'failed', failureReason }
);
assert.throws(
  () => outcome.normalizeTerminalRequest({ launchId, terminalState: 'completed', failureReason }),
  errorCode('LAUNCH_TERMINAL_INVALID')
);
assert.throws(
  () => outcome.normalizeTerminalRequest({ launchId, terminalState: 'failed', failureReason: 'line one\nline two' }),
  errorCode('LAUNCH_TERMINAL_INVALID')
);
assert.throws(
  () => outcome.normalizeTerminalRequest({ launchId, terminalState: 'failed', failureReason: `VERDICT: ${'x'.repeat(992)}` }),
  errorCode('LAUNCH_TERMINAL_INVALID')
);
assert.throws(
  () => outcome.normalizeTerminalRequest({ launchId, terminalState: 'failed', failureReason: 'VERDICT: Bearer abcdefghijklmnopqrstuvwxyz123456' }),
  errorCode('LAUNCH_TERMINAL_INVALID')
);

const body = { schemaVersion: 1, launchId, launchRecordHash, terminalState: 'failed', terminalAt };
const receipt = outcome.normalizeReceipt({
  terminalAt: '2026-08-27T12:34:56.789+00:00',
  terminalState: 'failed',
  launchRecordHash,
  launchId,
  schemaVersion: 1
});
assert.deepEqual(receipt, { ...body, receiptHash: expectedReceiptHash(body) });
assert.equal(Object.isFrozen(receipt), true);

const compact = outcome.compactReceipt(receipt);
assert.deepEqual(compact, body);
assert.equal(Object.hasOwn(compact, 'receiptHash'), false);
assert.equal(Object.isFrozen(compact), true);
assert.deepEqual(outcome.terminalPayload(receipt), { schemaVersion: 1, receipt: body });
assert.equal(Object.isFrozen(outcome.terminalPayload(receipt)), true);

const failedBody = { ...body, failureReason };
const failedReceipt = outcome.normalizeReceipt(failedBody);
assert.deepEqual(failedReceipt, { ...failedBody, receiptHash: expectedReceiptHash(failedBody) });
assert.deepEqual(outcome.compactReceipt(failedReceipt), failedBody);
assert.deepEqual(outcome.terminalPayload(failedReceipt), { schemaVersion: 1, receipt: failedBody });

assert.throws(
  () => outcome.normalizeReceipt({ ...body, schemaVersion: 2 }),
  errorCode('LAUNCH_TERMINAL_VERSION_UNSUPPORTED')
);
assert.throws(
  () => outcome.normalizeReceipt({ ...body, launchRecordHash: 'not-a-sha256' }),
  errorCode('LAUNCH_TERMINAL_INVALID')
);

const event = {
  action: outcome.TERMINAL_ACTION,
  target: launchId,
  details: outcome.terminalPayload(receipt)
};
assert.deepEqual(outcome.terminalReceiptFromAuditEvent(event), receipt);
assert.deepEqual(outcome.terminalReceiptFromAuditEvent({ event }), receipt);
assert.equal(outcome.terminalReceiptFromAuditEvent({ ...event, action: 'unrelated.action' }), null);
assert.throws(
  () => outcome.terminalReceiptFromAuditEvent({ ...event, target: 'launch_fedcba9876543210' }),
  errorCode('LAUNCH_TERMINAL_MISMATCH')
);

assert.throws(
  () => outcome.recordTerminal({ launchId, terminalState: 'completed' }, { audit: {} }),
  errorCode('LAUNCH_TERMINAL_AUDIT_UNAVAILABLE')
);

process.stdout.write('launch-outcome public value behaviour passed\n');
