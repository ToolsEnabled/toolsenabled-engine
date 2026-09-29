'use strict';

const {
  clone,
  exactKeys,
  fail,
  hashCanonical,
  identifier,
  isoTime,
  plainObject,
  safeText,
  sha256,
  unique
} = require('./common');

const SCHEMA_VERSION = 1;
const EVENT_TYPES = new Set(['mission_submitted', 'preflight_completed', 'worker_started', 'verification_completed', 'review_required', 'completed', 'failed', 'help_requested', 'approval_required', 'budget_warning', 'cancelled']);
const DELIVERY_STATES = new Set(['pending', 'delivered']);

function payload(value) {
  const source = plainObject(value, 'event payload');
  exactKeys(source, ['summary', 'artifactIds', 'criterionIds', 'code'], 'event payload');
  if (!Array.isArray(source.artifactIds) || source.artifactIds.length > 100 || !Array.isArray(source.criterionIds) || source.criterionIds.length > 32) {
    fail('COORDINATOR_WORKFLOW_EVENT_INVALID', 'Event payload artifactIds or criterionIds exceed their bounded limits.', { field: 'event payload' });
  }
  const artifactIds = source.artifactIds.map((entry, index) => identifier(entry, `event payload.artifactIds[${index}]`));
  const criterionIds = source.criterionIds.map((entry, index) => identifier(entry, `event payload.criterionIds[${index}]`));
  unique(artifactIds, 'event payload.artifactIds');
  unique(criterionIds, 'event payload.criterionIds');
  return {
    summary: safeText(source.summary, 'event payload.summary', { min: 1, max: 500 }),
    artifactIds: artifactIds.sort(),
    criterionIds: criterionIds.sort(),
    code: safeText(source.code, 'event payload.code', { min: 1, max: 100, pattern: /^[A-Za-z0-9_.:-]+$/ })
  };
}

function validateEventEnvelope(value) {
  const source = plainObject(value, 'event envelope');
  exactKeys(source, ['schemaVersion', 'eventId', 'missionId', 'missionHash', 'type', 'occurredAt', 'payload'], 'event envelope');
  if (source.schemaVersion !== SCHEMA_VERSION) fail('COORDINATOR_WORKFLOW_VERSION_INVALID', `event envelope schemaVersion must be ${SCHEMA_VERSION}.`, { field: 'schemaVersion' });
  const type = safeText(source.type, 'type', { min: 4, max: 40, pattern: /^[a-z_]+$/ });
  if (!EVENT_TYPES.has(type)) fail('COORDINATOR_WORKFLOW_EVENT_INVALID', 'event envelope type is unsupported.', { field: 'type' });
  return clone({
    schemaVersion: SCHEMA_VERSION,
    eventId: identifier(source.eventId, 'eventId'),
    missionId: identifier(source.missionId, 'missionId'),
    missionHash: sha256(source.missionHash, 'missionHash'),
    type,
    occurredAt: isoTime(source.occurredAt, 'occurredAt'),
    payload: payload(source.payload)
  });
}

function createOutboxRecord(value) {
  const source = plainObject(value, 'outbox record');
  exactKeys(source, ['outboxId', 'createdAt', 'deliveryState', 'event'], 'outbox record');
  const deliveryState = safeText(source.deliveryState, 'deliveryState', { min: 7, max: 9, pattern: /^[a-z]+$/ });
  if (!DELIVERY_STATES.has(deliveryState)) fail('COORDINATOR_WORKFLOW_EVENT_INVALID', 'outbox deliveryState is invalid.', { field: 'deliveryState' });
  const event = validateEventEnvelope(source.event);
  return {
    outboxId: identifier(source.outboxId, 'outboxId'),
    createdAt: isoTime(source.createdAt, 'createdAt'),
    deliveryState,
    event,
    eventHash: hashCanonical(event)
  };
}

module.exports = {
  DELIVERY_STATES: Object.freeze([...DELIVERY_STATES]),
  EVENT_TYPES: Object.freeze([...EVENT_TYPES]),
  SCHEMA_VERSION,
  createOutboxRecord,
  validateEventEnvelope
};
