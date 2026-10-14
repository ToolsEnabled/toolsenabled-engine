'use strict';

// THE POLICY-DECISION EVENT LEAVES THE MAIN THREAD.
//
// MEASURED 2026-09-04 in the owner's Live main process: coordinator
// audit write() ran a full synchronous admission per tool call on the main
// thread (thirty a minute with seventeen circles), 5.4 s of PowerShell
// execFileSync per minute among the stalls. writeAsync submits the identical
// event to the group-commit queue: same action, same subject, same
// content-derived event id and time, anchor required exactly when the sync
// write would have used requireRecord, and the same three refusals.

const assert = require('node:assert/strict');
const test = require('node:test');
const audit = require('../src/lib/audit');
const coordinatorAuditCore = require('../src/lib/coordinator-audit-events');
// This existing suite exercises explicitly enabled asynchronous auditing.
const coordinatorAudit = { ...coordinatorAuditCore, writeAsync: (event, options) => coordinatorAuditCore.writeAsync(event, {
  loadSettings: () => ({ values: { 'audit.enabled': true }, provenance: { 'audit.enabled': { source: 'user' } } }), ...options
}) };

function decision() {
  return coordinatorAudit.policyDecision({
    action: 'host.exec', effect: 'external-write', approvalRequired: false, standingAuthorizationId: undefined,
    profileHash: 'a'.repeat(64), outcome: undefined
  });
}

function fakeQueue(reply) {
  const submitted = [];
  return { submitted, submit: item => { submitted.push(item); return Promise.resolve(typeof reply === 'function' ? reply(item) : reply); } };
}

function durableStatus(extra = {}) {
  return {
    ok: true, durable: true, projected: true, recorded: true, partial: false, anchored: true, protectedSequence: 7,
    disabled: false, eventId: 'x', sequence: 7, eventHash: 'b'.repeat(64), sinks: { jsonl: true, text: true }, pending: 0, errors: [], ...extra
  };
}

test('writeAsync submits the same event write() would record, with its own id and time, anchored when required', async () => {
  const event = decision();
  const queue = fakeQueue(durableStatus());
  const status = await coordinatorAudit.writeAsync(event, { required: true, admissionQueue: queue });
  assert.equal(queue.submitted.length, 1);
  const item = queue.submitted[0];
  assert.equal(item.action, 'coordinator.audit.policy.decision');
  assert.equal(item.target, event.subject.opaqueId);
  assert.deepEqual(item.details, coordinatorAudit.eventDetails(event));
  assert.equal(item.eventId, coordinatorAudit.eventId(event), 'the content-derived event id is what write() would have used');
  assert.equal(item.occurredAtMs, event.occurredAtMs);
  assert.equal(item.anchorRequired, true, 'a required event asks for the anchor, as requireRecord does');
  assert.equal(status.durable, true);
  assert.equal(status.anchored, true);
});

test('an unrequired event is submitted without the anchor and its status is returned as-is', async () => {
  const queue = fakeQueue(durableStatus({ anchored: false, protectedSequence: 3 }));
  const status = await coordinatorAudit.writeAsync(decision(), { required: false, admissionQueue: queue });
  assert.equal(queue.submitted[0].anchorRequired, false);
  assert.equal(status.durable, true);
});

test('a required event the queue could not make durable is refused exactly as requireRecord refuses it', async () => {
  const notDurable = fakeQueue(durableStatus({ ok: false, durable: false, anchored: false, sequence: null, eventHash: null, errors: [{ sink: 'canonical', code: 'AUDIT_UNAVAILABLE', message: 'no' }] }));
  await assert.rejects(coordinatorAudit.writeAsync(decision(), { required: true, admissionQueue: notDurable }),
    error => error instanceof audit.AuditRequiredError && /could not be recorded/.test(error.message));
  const notAnchored = fakeQueue(durableStatus({ anchored: false }));
  await assert.rejects(coordinatorAudit.writeAsync(decision(), { required: true, admissionQueue: notAnchored }),
    error => error instanceof audit.AuditRequiredError && /monotonic head anchor/.test(error.message));
});

test('a queue that throws becomes the same fail-closed coordinator error write() raises', async () => {
  const broken = { submit: () => Promise.reject(new Error('worker gone')) };
  await assert.rejects(coordinatorAudit.writeAsync(decision(), { required: true, admissionQueue: broken }),
    error => error instanceof coordinatorAudit.CoordinatorAuditEventError && error.code === 'COORDINATOR_AUDIT_UNAVAILABLE');
});
