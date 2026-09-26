'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { MissionBridgeError } = require('../src/lib/mission-bridge/errors');
const {
  effectiveRequestSha256,
  validateInput
} = require('../src/lib/mission-bridge/termination');

const VALID_INPUT = {
  idempotencyKey: 'terminate/request-42',
  agentId: 'worker-7',
  expectedRunId: '11111111-1111-4111-8111-111111111111',
  expectedPid: 4242
};

function expectedDigest(bodyDigest, actor) {
  return crypto.createHash('sha256').update(`${bodyDigest}\n${actor}`, 'utf8').digest('hex');
}

function assertInvalid(input) {
  assert.throws(
    () => validateInput(input),
    error => error instanceof MissionBridgeError
      && error.code === 'BRIDGE_TERMINATE_INPUT_INVALID'
      && error.status === 400
  );
}

function main() {
  const normalized = validateInput({ ...VALID_INPUT });
  assert.deepEqual(normalized, VALID_INPUT);
  assert.equal(Object.isFrozen(normalized), true, 'validated input is immutable');

  assertInvalid({ ...VALID_INPUT, expectedPid: 0 });
  assertInvalid({ ...VALID_INPUT, unexpected: true });

  const bodyDigest = 'ab'.repeat(32);
  const controllerDigest = effectiveRequestSha256(bodyDigest, 'controller');
  assert.equal(controllerDigest, expectedDigest(bodyDigest, 'controller'));
  assert.notEqual(
    effectiveRequestSha256(bodyDigest, 'other-controller'),
    controllerDigest,
    'the effective request identity is bound to its actor'
  );

  console.log('firsttest-mission-bridge-termination: 6 assertions passed');
}

main();
