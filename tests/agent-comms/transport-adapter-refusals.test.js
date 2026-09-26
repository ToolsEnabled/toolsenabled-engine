'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONTRACT_ID,
  CONTRACT_VERSION,
  createGuardedTransportAdapter
} = require('../../src/lib/agent-comms/transport-adapter');

const CAPABILITIES = Object.freeze({
  authenticatedIdentity: true,
  confidentiality: true,
  durableRetry: true,
  keyRotation: true,
  replayRefusal: true,
  tamperRefusal: true
});

function descriptor(overrides = {}) {
  return {
    adapterId: 'test-adapter',
    capabilities: { ...CAPABILITIES },
    contract: { id: CONTRACT_ID, version: CONTRACT_VERSION },
    implementationLabel: 'refusal test adapter',
    ...overrides
  };
}

function adapterFixture({ describe = descriptor(), receipt, provisionResult, rotationResult } = {}) {
  const calls = { close: 0, deliver: 0, health: 0, provision: 0, rotate: 0 };
  const adapter = {
    async close() { calls.close += 1; },
    async deliver(input) {
      calls.deliver += 1;
      return receipt === undefined ? validReceipt(input) : receipt;
    },
    describe() { return describe; },
    async health() { calls.health += 1; return { ready: true }; },
    async provision({ identities }) {
      calls.provision += 1;
      return provisionResult === undefined
        ? { identities: identities.map(identityId => ({ identityId, ready: true })) }
        : provisionResult;
    },
    async rotate({ identityId }) {
      calls.rotate += 1;
      return rotationResult === undefined ? { identityId, rotated: true } : rotationResult;
    }
  };
  return { adapter, calls };
}

function attempt(overrides = {}) {
  return {
    idempotencyKey: 'message-1',
    messageId: 'message-1',
    message: { sender: { agentId: 'sender', machineId: 'machine-a' } },
    recipient: { agentId: 'recipient', machineId: 'machine-b' },
    sequence: 1,
    ...overrides
  };
}

function validReceipt(input = attempt()) {
  return {
    authenticatedRecipient: input.recipient,
    authenticatedSender: input.message.sender,
    delivered: true,
    deliverySequence: input.sequence,
    evidence: { adapterId: 'test-adapter' },
    idempotencyKey: input.idempotencyKey,
    messageId: input.messageId
  };
}

function assertOnly(calls, method, count) {
  assert.deepEqual(calls, {
    close: 0,
    deliver: method === 'deliver' ? count : 0,
    health: 0,
    provision: method === 'provision' ? count : 0,
    rotate: method === 'rotate' ? count : 0
  });
}

function isCode(code) {
  return error => error && error.code === code && error.name === 'TransportAdapterContractError';
}

test('refuses an invalid adapter argument before invoking adapter code', () => {
  assert.throws(() => createGuardedTransportAdapter(null), isCode('TRANSPORT_ADAPTER_ARGUMENT_INVALID'));
});

test('refuses a mismatched contract before invoking operational methods', () => {
  const fixture = adapterFixture({ describe: descriptor({ contract: { id: 'wrong', version: 1 } }) });
  assert.throws(() => createGuardedTransportAdapter(fixture.adapter), isCode('TRANSPORT_ADAPTER_CONTRACT_MISMATCH'));
  assertOnly(fixture.calls, null, 0);
});

test('refuses a missing capability before invoking operational methods', () => {
  const capabilities = { ...CAPABILITIES, durableRetry: false };
  const fixture = adapterFixture({ describe: descriptor({ capabilities }) });
  assert.throws(() => createGuardedTransportAdapter(fixture.adapter), isCode('TRANSPORT_ADAPTER_CAPABILITY_MISSING'));
  assertOnly(fixture.calls, null, 0);
});

test('refuses an invalid descriptor before invoking operational methods', () => {
  const fixture = adapterFixture({ describe: descriptor({ implementationLabel: '' }) });
  assert.throws(() => createGuardedTransportAdapter(fixture.adapter), isCode('TRANSPORT_ADAPTER_DESCRIPTOR_INVALID'));
  assertOnly(fixture.calls, null, 0);
});

test('refuses a missing adapter method before calling describe or operational methods', () => {
  const fixture = adapterFixture();
  delete fixture.adapter.rotate;
  assert.throws(() => createGuardedTransportAdapter(fixture.adapter), isCode('TRANSPORT_ADAPTER_METHOD_MISSING'));
  assertOnly(fixture.calls, null, 0);
});

test('refuses a mismatched idempotency key without delivering', async () => {
  const fixture = adapterFixture();
  const guarded = createGuardedTransportAdapter(fixture.adapter);
  await assert.rejects(guarded.deliver(attempt({ idempotencyKey: 'different' })), isCode('TRANSPORT_ADAPTER_IDEMPOTENCY_KEY_INVALID'));
  assertOnly(fixture.calls, null, 0);
});

const deliveryRefusals = [
  ['TRANSPORT_ADAPTER_RECEIPT_INVALID', receipt => { receipt.delivered = false; }],
  ['TRANSPORT_ADAPTER_SENDER_MISMATCH', receipt => { receipt.authenticatedSender.agentId = 'impostor'; }],
  ['TRANSPORT_ADAPTER_RECIPIENT_MISMATCH', receipt => { receipt.authenticatedRecipient.machineId = 'wrong-machine'; }],
  ['TRANSPORT_ADAPTER_ORDERING_RECEIPT_INVALID', receipt => { receipt.deliverySequence = 2; }]
];

for (const [code, corrupt] of deliveryRefusals) {
  test(`refuses corrupt delivery evidence with ${code} and performs no follow-up operation`, async () => {
    const receipt = validReceipt();
    corrupt(receipt);
    const fixture = adapterFixture({ receipt });
    const guarded = createGuardedTransportAdapter(fixture.adapter);
    await assert.rejects(guarded.deliver(attempt()), isCode(code));
    assertOnly(fixture.calls, 'deliver', 1);
  });
}

test('refuses an incomplete provision result after exactly one provision call', async () => {
  const fixture = adapterFixture({ provisionResult: { identities: [] } });
  const guarded = createGuardedTransportAdapter(fixture.adapter);
  await assert.rejects(guarded.provision({ identities: ['sender'] }), isCode('TRANSPORT_ADAPTER_PROVISION_RESULT_INVALID'));
  assertOnly(fixture.calls, 'provision', 1);
});

test('refuses a mismatched rotation result after exactly one rotation call', async () => {
  const fixture = adapterFixture({ rotationResult: { identityId: 'other', rotated: true } });
  const guarded = createGuardedTransportAdapter(fixture.adapter);
  await assert.rejects(
    guarded.rotate({ identityId: 'sender', reason: 'routine test rotation' }),
    isCode('TRANSPORT_ADAPTER_ROTATION_RESULT_INVALID')
  );
  assertOnly(fixture.calls, 'rotate', 1);
});
