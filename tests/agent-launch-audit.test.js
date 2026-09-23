/* Refusal mutation checks:
 * Changed each covered refusal code to a MUTATED variant in turn. Both edits
 * landed, and this isolated test went red with exit code 1 for each mutation.
 * After each run the module was restored to its original sha256.
 */
'use strict';

const assert = require('node:assert/strict');

const {
  AgentLaunchAuditError,
  LAUNCH_ACTION,
  eventIdForRun,
  recordAgentSessionLaunch
} = require('../src/lib/agent-launch-audit');

function auditFixture(prior = []) {
  const calls = [];
  return {
    calls,
    conditionalRecord(request, dependencies) {
      calls.push({ request, dependencies });
      const decision = request.decide({ findEvents: () => prior });
      if (decision.kind === 'refused') return { recorded: false, refusal: decision.refusal };
      calls[0].decision = decision;
      return { recorded: true, sequence: 41 };
    }
  };
}

(() => {
  assert.equal(LAUNCH_ACTION, 'agent.session.launched');
  assert.equal(
    eventIdForRun('run-alpha-123'),
    'agent-session-launch-5fe94c13260a3ef27693724a12ee15e8',
    'event identity is a stable, run-derived value'
  );
  assert.notEqual(eventIdForRun('run-alpha-123'), eventIdForRun('run-bravo-123'));

  const audit = auditFixture();
  const dependencies = { audit, clock: () => 1234 };
  assert.throws(() => recordAgentSessionLaunch({
    runId: '  run-alpha-123  ',
    role: 17
  }, dependencies), error => error instanceof AgentLaunchAuditError
    && error.code === 'LAUNCH_AUDIT_INVALID_FIELD'
    && error.message === 'role must be a string.',
  'invalid optional identifier fields are rejected with the exported typed error');
  assert.equal(audit.calls.length, 0, 'field validation happens before calling the ledger');

  delete dependencies.clock;
  const successfulAudit = auditFixture();
  const success = recordAgentSessionLaunch({
    runId: '  run-alpha-123  ',
    agentId: ' agent\nseven ',
    kind: ' harness\0child ',
    provider: 'codex',
    pid: 4321,
    prompt: 'must never enter the ledger'
  }, { audit: successfulAudit });

  assert.deepEqual(success, {
    ok: true,
    recorded: true,
    runId: 'run-alpha-123',
    sequence: 41,
    eventId: eventIdForRun('run-alpha-123')
  });
  assert.equal(successfulAudit.calls.length, 1);
  assert.equal(successfulAudit.calls[0].request.action, LAUNCH_ACTION);
  assert.equal(successfulAudit.calls[0].request.target, 'agent seven');
  assert.equal(successfulAudit.calls[0].request.eventId, eventIdForRun('run-alpha-123'));
  assert.deepEqual(successfulAudit.calls[0].decision.details, {
    gated: false,
    observedAfterStart: true,
    runId: 'run-alpha-123',
    agentId: 'agent seven',
    kind: 'harness child',
    provider: 'codex',
    pid: 4321
  }, 'the signed details identify an observed, non-gated start and exclude prompt text');

  const duplicateAudit = auditFixture([{
    event: { details: { runId: 'run-alpha-123' } }
  }]);
  assert.deepEqual(
    recordAgentSessionLaunch({ runId: 'run-alpha-123', agentId: 'agent-seven' }, { audit: duplicateAudit }),
    { ok: true, recorded: false, reason: 'duplicate', runId: 'run-alpha-123' },
    'the same run is refused under the writer lock rather than appended twice'
  );

  assert.deepEqual(recordAgentSessionLaunch({ runId: 'short' }, { audit: auditFixture() }), {
    ok: false,
    recorded: false,
    code: 'LAUNCH_AUDIT_NO_RUN_ID',
    reason: 'the session carried no usable run id'
  });
  assert.deepEqual(recordAgentSessionLaunch({ runId: 'valid-run-123' }, { audit: {} }), {
    ok: false,
    recorded: false,
    code: 'LAUNCH_AUDIT_WRITER_ABSENT',
    reason: 'the canonical audit writer is unavailable'
  });

  let unexpectedWrites = 0;
  let unexpectedSpawns = 0;
  const unexpectedOutcome = recordAgentSessionLaunch({ runId: 'unexpected-run-123' }, {
    audit: {
      conditionalRecord() {
        // A writer response that proves neither durability nor a duplicate is
        // an indeterminate outcome, not success.
        return { recorded: false, refusal: 'not-a-duplicate' };
      }
    },
    write: () => { unexpectedWrites += 1; },
    spawn: () => { unexpectedSpawns += 1; }
  });
  assert.deepEqual(unexpectedOutcome, {
    ok: false,
    recorded: false,
    runId: 'unexpected-run-123',
    code: 'LAUNCH_AUDIT_UNEXPECTED_OUTCOME',
    reason: 'The canonical audit writer returned no definite durable record or duplicate refusal.'
  }, 'an indeterminate writer outcome is returned as a typed refusal');
  assert.equal(unexpectedWrites, 0, 'an unexpected outcome does not invoke any injected write');
  assert.equal(unexpectedSpawns, 0, 'an unexpected outcome does not invoke any injected spawn');

  let failedWrites = 0;
  let failedSpawns = 0;
  const failed = recordAgentSessionLaunch({ runId: 'failed-run-123' }, {
    audit: {
      conditionalRecord() {
        throw new Error('ledger storage is offline');
      }
    },
    write: () => { failedWrites += 1; },
    spawn: () => { failedSpawns += 1; }
  });
  assert.deepEqual(failed, {
    ok: false,
    recorded: false,
    runId: 'failed-run-123',
    code: 'LAUNCH_AUDIT_FAILED',
    reason: 'ledger storage is offline'
  }, 'an untyped writer exception is returned as the generic launch-audit refusal');
  assert.equal(failedWrites, 0, 'a failed writer does not invoke any injected write');
  assert.equal(failedSpawns, 0, 'a failed writer does not invoke any injected spawn');

  const error = new AgentLaunchAuditError('EXAMPLE', 'example failure');
  assert.equal(error.name, 'AgentLaunchAuditError');
  assert.equal(error.code, 'EXAMPLE');
  assert.equal(error.message, 'example failure');

  console.log('agent-launch-audit: all behavioral assertions passed');
})();
