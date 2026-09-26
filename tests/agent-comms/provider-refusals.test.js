'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const harness = require('./helpers/comms-harness');

const restoreRegistry = harness.installFixtureRegistry();
let agentComms;
try {
  agentComms = require('../../src/lib/providers/agent-comms');
} finally {
  restoreRegistry();
}

const TOKEN = harness.TEST_RELAY_TOKEN;

function providerOptions(t, overrides = {}) {
  const directory = harness.workspace(t, 'agent-comms-provider-refusals-');
  return {
    localMachine: { address: '127.0.0.1', machineId: 'machine-a' },
    tokenLoader: () => TOKEN,
    stateStore: harness.memoryStateStore(),
    stateFile: path.join(directory, 'broker.json'),
    ...overrides
  };
}

test('malformed relay envelopes reach the named refusal and disclose no message', () => {
  assert.throws(
    () => agentComms.openMessage(Buffer.from(TOKEN), '{not-json'),
    error => {
      assert.equal(error.code, 'AGENT_COMMS_RELAY_ENVELOPE_INVALID');
      assert.equal(error.name, 'AgentCommsToolError');
      assert.equal(Object.hasOwn(error, 'message'), true);
      return true;
    }
  );
});

test('a non-registry relay host is refused before a request or durable write', async t => {
  let requests = 0;
  const stateStore = harness.memoryStateStore();
  const provider = agentComms.createAgentCommsProvider(providerOptions(t, {
    relayHost: '192.0.2.99',
    relayPort: 8787,
    stateStore,
    requestImpl() { requests += 1; throw new Error('must not create a request'); }
  }));

  await assert.rejects(
    () => provider.read({ cursor: 0 }, { agentActor: 'codex' }),
    error => {
      assert.equal(error.code, 'AGENT_COMMS_RELAY_HOST_REFUSED');
      return true;
    }
  );
  assert.equal(requests, 0, 'host policy runs before node:http is invoked');
  assert.equal(stateStore.dump(), '[]', 'refusal happens before relay or fabric state is initialized');
});

for (const errno of ['ECONNABORTED', 'ENOTFOUND']) {
  test(`${errno} is treated as an unanswered relay while the local inbox remains readable`, async t => {
    let attempts = 0;
    const provider = agentComms.createAgentCommsProvider(providerOptions(t, {
      requestPort: async () => {
        attempts += 1;
        throw Object.assign(new Error('socket did not reach a relay'), { code: errno });
      }
    }));

    const result = await provider.read({ cursor: 0 }, { agentActor: 'codex' });
    assert.equal(result.inbound.drained, false);
    assert.equal(result.inbound.reason, 'TRANSPORT_RELAY_REQUEST_FAILED');
    assert.equal(result.outbound.drained, true);
    assert.equal(result.outbound.attempted, 0);
    assert.equal(result.outbound.delivered, 0);
    assert.deepEqual(result.page.records, [], 'the successful result is the real local inbox page');
    assert.equal(attempts, 1, 'only the inbound drain touched the injected port; an empty spool performed no write');
  });
}
