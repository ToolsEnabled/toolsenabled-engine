'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const coordinatorAudit = require('../src/lib/coordinator-audit-events');

const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const providerEvent = coordinatorAudit.providerOperation({
  provider: 'codex',
  operation: 'complete',
  outcome: 'succeeded',
  durationMs: 17,
  promptBytes: 120,
  outputBytes: 345,
  hashes: { request: sha256('request'), result: sha256('result') },
  occurredAtMs: 1_700_000_000_000
});

assert.deepEqual(providerEvent.summary, {
  operation: 'complete',
  code: 'provider-operation',
  durationMs: 17,
  promptBytes: 120,
  outputBytes: 345
}, 'providerOperation must preserve bounded transport byte measurements');
assert.equal(providerEvent.kind, 'provider.operation');
assert.equal(providerEvent.subject.type, 'provider');
assert.equal(providerEvent.subject.opaqueId, coordinatorAudit.opaqueReference('provider', 'codex'));
assert.equal(providerEvent.occurredAtMs, 1_700_000_000_000);
assert.equal(Object.isFrozen(providerEvent), true);
assert.equal(Object.isFrozen(providerEvent.summary), true);

const startEvent = coordinatorAudit.providerOperation({
  provider: 'codex', operation: 'start', outcome: 'started', occurredAtMs: 42
});
assert.equal(startEvent.kind, 'provider.start');

assert.throws(
  () => coordinatorAudit.providerOperation({
    provider: 'codex', operation: 'complete', outcome: 'succeeded', outputBytes: -1
  }),
  error => error instanceof coordinatorAudit.CoordinatorAuditEventError &&
    error.code === 'COORDINATOR_AUDIT_EVENT_INVALID' &&
    error.details.field === 'outputBytes',
  'providerOperation must reject negative output byte measurements'
);

const firstId = coordinatorAudit.eventId(providerEvent);
const secondId = coordinatorAudit.eventId(coordinatorAudit.validateEvent(providerEvent));
assert.match(firstId, /^coordinator-audit-[a-f0-9]{64}$/);
assert.equal(secondId, firstId, 'validated identical events must retain deterministic IDs');

function unavailable(run, message) {
  assert.throws(run, error => {
    assert.equal(error instanceof coordinatorAudit.CoordinatorAuditEventError, true);
    assert.equal(error.code, 'COORDINATOR_AUDIT_UNAVAILABLE');
    assert.equal(error.message, message);
    assert.deepEqual(error.details, {});
    return true;
  });
}

// Drive the writer boundary with an adapter that fails before it can persist or
// spawn anything. The semantic adapter must replace the downstream error rather
// than accidentally returning a false-success status or leaking its message.
let writeAttempts = 0;
let writes = 0;
let spawns = 0;
unavailable(() => coordinatorAudit.write(providerEvent, {
  loadSettings: () => ({ values: { 'audit.enabled': true }, provenance: { 'audit.enabled': { source: 'user' } } }),
  auditRecord() {
    writeAttempts += 1;
    throw new Error('provider path and credential must not escape');
  },
  auditDependencies: {
    write() { writes += 1; },
    spawn() { spawns += 1; }
  }
}), 'The canonical audit event could not be recorded.');
assert.equal(writeAttempts, 1, 'the injected audit adapter must be driven');
assert.equal(writes, 0, 'a refused audit write must not persist through injected dependencies');
assert.equal(spawns, 0, 'a refused audit write must not spawn through injected dependencies');

function measurementDependencies(overrides = {}) {
  const calls = { verify: 0, status: 0, writes: 0, spawns: 0 };
  return {
    calls,
    dependencies: {
      verify() { calls.verify += 1; return { valid: true, entries: 1 }; },
      status() {
        calls.status += 1;
        return {
          headSequence: 1,
          pendingEmergency: 0,
          quarantinedEmergencyFiles: 0,
          sinks: {
            jsonl: { backlog: 0, aheadOfHead: false },
            text: { backlog: 0, aheadOfHead: false }
          }
        };
      },
      auditDependencies: {
        write() { calls.writes += 1; },
        spawn() { calls.spawns += 1; }
      },
      ...overrides
    }
  };
}

// Use closures for the remaining overrides so call counts prove the dependency
// was executed, not merely that validation happened elsewhere in the module.
{
  const fixture = measurementDependencies();
  fixture.dependencies.verify = () => {
    fixture.calls.verify += 1;
    return null;
  };
  unavailable(() => coordinatorAudit.boundedVerification(fixture.dependencies),
    'Canonical audit verification did not return a measurement.');
  assert.deepEqual(fixture.calls, { verify: 1, status: 0, writes: 0, spawns: 0 });
}

{
  const fixture = measurementDependencies();
  fixture.dependencies.verify = () => {
    fixture.calls.verify += 1;
    return { valid: true };
  };
  unavailable(() => coordinatorAudit.boundedVerification(fixture.dependencies),
    'Canonical audit verification did not report its measured entry count.');
  assert.deepEqual(fixture.calls, { verify: 1, status: 0, writes: 0, spawns: 0 });
}

for (const [mutateStatus, message] of [
  [() => null, 'Canonical audit status did not return a measurement.'],
  [status => ({ ...status, headSequence: null }), 'Canonical audit status did not measure head sequence.'],
  [status => ({ ...status, sinks: { ...status.sinks, jsonl: null } }), 'Canonical audit status did not measure the jsonl sink.']
]) {
  const fixture = measurementDependencies();
  const healthyStatus = fixture.dependencies.status;
  fixture.dependencies.status = () => {
    fixture.calls.status += 1;
    return mutateStatus(healthyStatus());
  };
  unavailable(() => coordinatorAudit.boundedStatus(fixture.dependencies), message);
  assert.equal(fixture.calls.verify, 1, 'status refusal must still use bounded verification');
  assert.equal(fixture.calls.writes, 0, 'status refusal must not write');
  assert.equal(fixture.calls.spawns, 0, 'status refusal must not spawn');
}

console.log('coordinator-audit-events behavior tests passed');
