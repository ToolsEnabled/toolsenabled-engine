// EXECUTABLE CHANGE
'use strict';

const assert = require('node:assert/strict');
const {
  ChannelContractError,
  createChannelContract,
  formatDirectAddress
} = require('../../src/lib/agent-comms/channel-contract');

const alice = Object.freeze({ agentId: 'alice', machineId: 'workstation' });
const bob = Object.freeze({ agentId: 'bob', machineId: 'workstation' });
const unknown = Object.freeze({ agentId: 'unknown', machineId: 'workstation' });
const now = () => 1_800_000_000_000;
const verifier = Object.freeze({
  verify({ authentication }) {
    return { authenticated: true, integrityChecked: true, sender: authentication.sender };
  }
});

function expectCode(code, operation) {
  assert.throws(operation, error => {
    assert.ok(error instanceof ChannelContractError);
    assert.equal(error.code, code);
    return true;
  });
}

function submission(overrides = {}) {
  return {
    sender: alice,
    audience: { type: 'direct', agent: bob },
    causalParent: null,
    kind: 'notice',
    body: 'hello',
    issuedAt: now(),
    ...overrides
  };
}

// Invalid addresses fail before a formatted address can be returned.
expectCode('AGENT_ADDRESS_INVALID', () => formatDirectAddress({ agentId: 'bad/id', machineId: 'workstation' }));

// Constructor validation refuses before a contract (and therefore any state)
// exists. Exercise both dependency and bounds validation paths.
expectCode('AGENT_COMMS_CONFIGURATION_INVALID', () => createChannelContract({ now: 42 }));
expectCode('AGENT_COMMS_CONFIGURATION_INVALID', () => createChannelContract({ maxRefusals: 0 }));

const contract = createChannelContract({ knownAgents: [alice, bob], verifier, now });
assert.deepEqual(contract.listChannels(), []);

// Invalid registration must neither add the agent nor alter channel state.
expectCode('AGENT_IDENTITY_INVALID', () => contract.registerAgent({ agentId: 'bad/id', machineId: 'workstation' }));
assert.deepEqual(contract.listChannels(), []);

contract.createChannel({ name: 'ops' });
const channelsBeforeMembershipRefusals = contract.listChannels();
expectCode('AGENT_CHANNEL_UNKNOWN', () => contract.joinChannel({ channel: 'missing', agent: alice }));
expectCode('AGENT_CHANNEL_AGENT_UNKNOWN', () => contract.joinChannel({ channel: 'ops', agent: unknown }));
assert.deepEqual(contract.listChannels(), channelsBeforeMembershipRefusals,
  'membership refusals must not add a channel or member');

expectCode('AGENT_CHANNEL_EXISTS', () => contract.createChannel({ name: 'ops' }));
assert.deepEqual(contract.listChannels(), channelsBeforeMembershipRefusals,
  'duplicate creation must not replace or mutate the existing channel');

// The clock is consulted while recording a post refusal. An invalid clock must
// throw, must not append even a partial refusal, and must not invoke downstream
// authentication or message-id dependencies.
let verifierCalls = 0;
let idFactoryCalls = 0;
const brokenClock = createChannelContract({
  knownAgents: [alice, bob],
  now: () => -1,
  verifier: { verify() { verifierCalls += 1; return { authenticated: true, integrityChecked: true, sender: alice }; } },
  messageIdFactory() { idFactoryCalls += 1; return 'should-not-exist'; }
});
expectCode('AGENT_COMMS_CLOCK_INVALID', () => brokenClock.post(null, { sender: alice }));
assert.deepEqual(brokenClock.getRefusals(), []);
assert.equal(verifierCalls, 0);
assert.equal(idFactoryCalls, 0);

// getMessage validates the lookup key before touching history.
expectCode('AGENT_MESSAGE_ID_INVALID', () => contract.getMessage(null));
assert.equal(contract.getMessage('never-written'), null);

// A successful driven post is the only route to AGENT_MESSAGE_ACCEPTED here;
// assert both the result and the corresponding history write.
const accepted = contract.post(submission(), { sender: alice });
assert.equal(accepted.accepted, true);
assert.equal(accepted.code, 'AGENT_MESSAGE_ACCEPTED');
assert.strictEqual(contract.getMessage(accepted.message.id), accepted.message);

// AGENT_MESSAGE_AGENT_UNKNOWN is the default requireKnownAgent code, but every
// current caller overrides it with a more specific channel/message code. The
// public API therefore cannot drive that default branch.
