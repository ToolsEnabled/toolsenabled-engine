/* Mutation check:
 * Changed `return normalized || 'this-machine'` to `return normalized` in
 * src/lib/agent-comms/local-runtime.js.
 * The edit landed, and this isolated test went red (exit 1).
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LocalAgentCommsRuntimeError,
  configuredMachineId,
  normalizeAgentId
} = require('../../src/lib/agent-comms/local-runtime');

test('configured machine identities normalize input and keep non-ASCII hosts usable', () => {
  assert.equal(
    configuredMachineId({ env: { TOOLSENABLED_MACHINE_ID: '  Studio Mac.example  ' } }),
    'studio-mac-example'
  );
  assert.equal(configuredMachineId({ env: {}, hostname: () => 'Ноутбук' }), 'this-machine');
  assert.throws(
    () => configuredMachineId({ env: { TOOLSENABLED_MACHINE_ID: '日本語' } }),
    error => {
      assert.equal(error instanceof LocalAgentCommsRuntimeError, true);
      assert.equal(error.code, 'AGENT_COMMS_MACHINE_ID_UNAVAILABLE');
      return true;
    }
  );
});

test('agent identities accept the durable ID grammar and reject invalid values', () => {
  assert.equal(normalizeAgentId('agent_7-prod'), 'agent_7-prod');
  for (const value of ['Agent-7', 'agent 7', '', null]) {
    assert.throws(
      () => normalizeAgentId(value, 'senderId'),
      error => {
        assert.equal(error instanceof LocalAgentCommsRuntimeError, true);
        assert.equal(error.code, 'AGENT_COMMS_AGENT_ID_INVALID');
        assert.deepEqual(error.details, { field: 'senderId' });
        return true;
      }
    );
  }
});
