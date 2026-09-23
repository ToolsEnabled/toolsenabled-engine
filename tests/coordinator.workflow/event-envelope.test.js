/*
 * Mutation check: event payload artifact ID canonicalization.
 * Exact mutation: `artifactIds: artifactIds.sort(),` -> `artifactIds: artifactIds,`.
 * The module edit landed: yes.
 * This isolated test went red: yes (artifact IDs remained in input order).
 */
'use strict';

const assert = require('node:assert/strict');
const {
  DELIVERY_STATES,
  EVENT_TYPES,
  SCHEMA_VERSION,
  createOutboxRecord,
  validateEventEnvelope
} = require('../../src/lib/coordinator-workflow/event-envelope');

function event(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: 'event-001',
    missionId: 'mission-001',
    missionHash: 'a'.repeat(64),
    type: 'verification_completed',
    occurredAt: '2026-08-27T10:11:12.000Z',
    payload: {
      summary: 'Verification completed.',
      artifactIds: ['artifact-z', 'artifact-a'],
      criterionIds: ['criterion-z', 'criterion-a'],
      code: 'verification.complete'
    },
    ...overrides
  };
}

function expectCode(action, code) {
  assert.throws(action, error => error?.code === code);
}

assert.equal(SCHEMA_VERSION, 1);
assert.ok(EVENT_TYPES.includes('completed'));
assert.ok(EVENT_TYPES.includes('approval_required'));
assert.deepEqual(DELIVERY_STATES, ['pending', 'delivered']);
assert.ok(Object.isFrozen(EVENT_TYPES));
assert.ok(Object.isFrozen(DELIVERY_STATES));

const input = event();
const validated = validateEventEnvelope(input);
assert.notStrictEqual(validated, input, 'validation returns a defensive copy');
assert.notStrictEqual(validated.payload, input.payload, 'the payload is also copied');
assert.deepEqual(validated.payload.artifactIds, ['artifact-a', 'artifact-z'], 'artifact IDs are canonicalized');
assert.deepEqual(validated.payload.criterionIds, ['criterion-a', 'criterion-z'], 'criterion IDs are canonicalized');
input.payload.summary = 'mutated after validation';
assert.equal(validated.payload.summary, 'Verification completed.');

expectCode(() => validateEventEnvelope(event({ schemaVersion: 2 })), 'COORDINATOR_WORKFLOW_VERSION_INVALID');
expectCode(() => validateEventEnvelope(event({ type: 'invented_event' })), 'COORDINATOR_WORKFLOW_EVENT_INVALID');
expectCode(() => validateEventEnvelope(event({ payload: { ...event().payload, artifactIds: ['duplicate', 'duplicate'] } })), 'COORDINATOR_WORKFLOW_DUPLICATE');

const outbox = createOutboxRecord({
  outboxId: 'outbox-001',
  createdAt: '2026-08-27T10:12:00.000Z',
  deliveryState: 'pending',
  event: event()
});
assert.equal(outbox.deliveryState, 'pending');
assert.match(outbox.eventHash, /^[a-f0-9]{64}$/);
assert.equal(createOutboxRecord({
  outboxId: 'outbox-002',
  createdAt: '2026-08-27T10:13:00.000Z',
  deliveryState: 'delivered',
  event: event()
}).eventHash, outbox.eventHash, 'the event hash depends on the canonical event, not outbox metadata');
expectCode(() => createOutboxRecord({
  outboxId: 'outbox-003',
  createdAt: '2026-08-27T10:14:00.000Z',
  deliveryState: 'shipping',
  event: event()
}), 'COORDINATOR_WORKFLOW_EVENT_INVALID');

console.log('event-envelope tests passed');
