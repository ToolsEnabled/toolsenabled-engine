/* Mutation check:
 * Changed canAdvance's `&&` to `||` in src/lib/cloud-agent/state-machine.js.
 * The mutation landed and was confirmed in the module before the test ran.
 * This isolated test went red (exit code 1), so it guards the behaviour.
 * The module was restored to its original SHA-256 afterward.
 */
'use strict';

// Focused behavioural contract for src/lib/cloud-agent/state-machine.js.
// Run alone with: node tests/cloud-agent-state-machine.test.js

const assert = require('node:assert/strict');

const {
  afterBind,
  afterSubmit,
  afterObserve,
  canAdvance
} = require('../src/lib/cloud-agent/state-machine');
const { CloudAgentError } = require('../src/lib/cloud-agent/errors');

let checks = 0;

function check(label, assertion) {
  assertion();
  checks += 1;
  void label;
}

function expectCode(operation, expectedCode, messagePattern) {
  assert.throws(operation, error => {
    assert.ok(error instanceof CloudAgentError, 'invalid transitions must use CloudAgentError');
    assert.equal(error.code, expectedCode);
    assert.match(error.message, messagePattern);
    return true;
  });
}

check('binding accepts the sole UNBOUND to READY transition', () => {
  assert.equal(afterBind('UNBOUND'), 'READY');
});

check('binding rejects a session that is already READY', () => {
  expectCode(
    () => afterBind('READY'),
    'CLOUD_AGENT_ILLEGAL_TRANSITION',
    /bindEnvironment may not move state from READY to READY/
  );
});

for (const reported of ['SUBMITTED', 'UNKNOWN']) {
  check(`submission accepts READY to ${reported}`, () => {
    assert.equal(afterSubmit('READY', reported), reported);
  });
}

check('submission fails closed instead of accepting an immediate success', () => {
  expectCode(
    () => afterSubmit('READY', 'SUCCEEDED'),
    'CLOUD_AGENT_ILLEGAL_TRANSITION',
    /submit may not move state from READY to SUCCEEDED/
  );
});

const observableTransitions = {
  SUBMITTED: ['SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
  RUNNING: ['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
  SUCCEEDED: ['SUCCEEDED'],
  FAILED: ['FAILED'],
  CANCELLED: ['CANCELLED'],
  UNKNOWN: ['SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']
};

for (const [current, reportedStates] of Object.entries(observableTransitions)) {
  check(`observation accepts every documented transition from ${current}`, () => {
    for (const reported of reportedStates) {
      assert.equal(afterObserve(current, reported), reported);
    }
  });
}

check('terminal success is a fixed point', () => {
  expectCode(
    () => afterObserve('SUCCEEDED', 'RUNNING'),
    'CLOUD_AGENT_ILLEGAL_TRANSITION',
    /inspect may not move state from SUCCEEDED to RUNNING/
  );
});

check('observation includes the caller operation in an illegal-transition error', () => {
  expectCode(
    () => afterObserve('FAILED', 'RUNNING', 'reconcile'),
    'CLOUD_AGENT_ILLEGAL_TRANSITION',
    /reconcile may not move state from FAILED to RUNNING/
  );
});

check('unknown input states are distinguished from illegal known transitions', () => {
  expectCode(
    () => afterObserve('TYPO', 'RUNNING'),
    'CLOUD_AGENT_STATE_UNKNOWN',
    /current state "TYPO" is not a recognized cloud-agent state/
  );
  expectCode(
    () => afterObserve('RUNNING', 'TYPO'),
    'CLOUD_AGENT_STATE_UNKNOWN',
    /reported state "TYPO" is not a recognized cloud-agent state/
  );
});

check('only independently reconciled success can advance', () => {
  assert.equal(canAdvance({ state: 'SUCCEEDED', reconciled: true }), true);
  assert.equal(canAdvance({ state: 'SUCCEEDED', reconciled: false }), false);
  assert.equal(canAdvance({ state: 'RUNNING', reconciled: true }), false);
  assert.equal(canAdvance({ state: 'FAILED', reconciled: true }), false);
});

for (const invalid of [null, 'SUCCEEDED', [], 1]) {
  check('canAdvance rejects a non-snapshot value', () => {
    expectCode(
      () => canAdvance(invalid),
      'CLOUD_AGENT_SESSION_INVALID',
      /canAdvance requires a session snapshot object/
    );
  });
}

check('canAdvance requires an explicit boolean reconciliation result', () => {
  expectCode(
    () => canAdvance({ state: 'SUCCEEDED', reconciled: 1 }),
    'CLOUD_AGENT_SESSION_INVALID',
    /canAdvance requires a boolean reconciled result/
  );
});

console.log(`cloud-agent state-machine tests passed (${checks} behavioural checks)`);
