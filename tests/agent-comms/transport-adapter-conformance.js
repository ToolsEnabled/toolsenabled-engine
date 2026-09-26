'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CONTRACT_ID,
  CONTRACT_VERSION,
  REQUIRED_CAPABILITIES,
  TransportAdapterContractError,
  createGuardedTransportAdapter
} = require('../../src/lib/agent-comms/transport-adapter');

function canonical(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function fingerprint(attempt) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonical({
      idempotencyKey: attempt.idempotencyKey,
      message: attempt.message,
      messageId: attempt.messageId,
      recipient: attempt.recipient,
      sequence: attempt.sequence
    })), 'utf8')
    .digest('hex');
}

function attempt({ body = 'contract proof', messageId = 'message-contract-1', sequence = 1 } = {}) {
  return Object.freeze({
    idempotencyKey: messageId,
    message: Object.freeze({
      id: messageId,
      sender: Object.freeze({ agentId: 'sender-agent', machineId: 'machine-a' }),
      body
    }),
    messageId,
    recipient: Object.freeze({
      agentId: 'recipient-agent',
      machineId: 'machine-a',
      sessionId: 'recipient-session'
    }),
    route: 'LOCAL',
    sequence
  });
}

function createReferenceAdapter() {
  const deliveries = new Map();
  const provisioned = new Set();
  return {
    async close() {},
    async deliver(input) {
      const digest = fingerprint(input);
      const prior = deliveries.get(input.messageId);
      if (prior && prior.digest !== digest) {
        throw new TransportAdapterContractError(
          'TRANSPORT_ADAPTER_MESSAGE_ID_CONFLICT',
          'message id was reused with different content.'
        );
      }
      if (prior) return prior.receipt;
      const receipt = Object.freeze({
        authenticatedRecipient: input.recipient,
        authenticatedSender: input.sender,
        delivered: true,
        deliverySequence: input.sequence,
        evidence: Object.freeze({ adapterId: 'reference-adapter' }),
        idempotencyKey: input.idempotencyKey,
        messageId: input.messageId
      });
      deliveries.set(input.messageId, { digest, receipt });
      return receipt;
    },
    describe() {
      return Object.freeze({
        adapterId: 'reference-adapter',
        capabilities: Object.freeze({
          authenticatedIdentity: true,
          confidentiality: true,
          durableRetry: true,
          keyRotation: true,
          replayRefusal: true,
          tamperRefusal: true
        }),
        contract: Object.freeze({ id: CONTRACT_ID, version: CONTRACT_VERSION }),
        implementationLabel: 'reference conformance adapter'
      });
    },
    async health() {
      return Object.freeze({ ready: true });
    },
    async provision({ identities }) {
      for (const identityId of identities) provisioned.add(identityId);
      return Object.freeze({
        identities: Object.freeze(identities.map(identityId => Object.freeze({ identityId, ready: true })))
      });
    },
    async rotate({ identityId }) {
      if (!provisioned.has(identityId)) throw new Error('identity not provisioned');
      return Object.freeze({ identityId, rotated: true });
    }
  };
}

function registerTransportAdapterConformance(name, factory) {
  test(`${name}: descriptor is versioned and capability-complete`, async t => {
    const adapter = createGuardedTransportAdapter(await factory());
    t.after(() => adapter.close());
    const descriptor = adapter.describe();
    assert.equal(descriptor.contract.id, CONTRACT_ID);
    assert.equal(descriptor.contract.version, CONTRACT_VERSION);
    assert.equal(Object.values(descriptor.capabilities).every(Boolean), true);
  });

  test(`${name}: provision and rotation return exact identity evidence`, async t => {
    const adapter = createGuardedTransportAdapter(await factory());
    t.after(() => adapter.close());
    const provisioned = await adapter.provision({ identities: ['recipient-agent', 'sender-agent'] });
    assert.deepEqual(provisioned.identities.map(item => item.identityId).sort(), ['recipient-agent', 'sender-agent']);
    const rotated = await adapter.rotate({ identityId: 'sender-agent', reason: 'conformance-test' });
    assert.equal(rotated.rotated, true);
  });

  test(`${name}: delivery receipt preserves identity, ordering, and idempotency`, async t => {
    const adapter = createGuardedTransportAdapter(await factory());
    t.after(() => adapter.close());
    await adapter.provision({ identities: ['recipient-agent', 'sender-agent'] });
    const input = attempt();
    const first = await adapter.deliver(input);
    const second = await adapter.deliver(input);
    assert.deepEqual(first, second);
    assert.deepEqual(first.authenticatedSender, input.message.sender);
    assert.deepEqual(first.authenticatedRecipient, {
      agentId: input.recipient.agentId,
      machineId: input.recipient.machineId
    });
    assert.equal(first.deliverySequence, input.sequence);
    assert.equal(first.idempotencyKey, input.messageId);
  });

  test(`${name}: reuse of one message id with different content is refused`, async t => {
    const adapter = createGuardedTransportAdapter(await factory());
    t.after(() => adapter.close());
    await adapter.provision({ identities: ['recipient-agent', 'sender-agent'] });
    await adapter.deliver(attempt());
    await assert.rejects(
      adapter.deliver(attempt({ body: 'different content' })),
      error => error && error.code === 'TRANSPORT_ADAPTER_MESSAGE_ID_CONFLICT'
    );
  });
}

test('the tracked source contract is exact and implementation-neutral', () => {
  const root = path.resolve(__dirname, '..', '..');
  const source = fs.readFileSync(path.join(root, 'src', 'lib', 'agent-comms', 'transport-adapter.js'), 'utf8');
  assert.equal(CONTRACT_ID, 'agent-comms.transport-adapter');
  assert.equal(CONTRACT_VERSION, 1);
  assert.deepEqual(REQUIRED_CAPABILITIES, [
    'authenticatedIdentity',
    'confidentiality',
    'durableRetry',
    'keyRotation',
    'replayRefusal',
    'tamperRefusal'
  ]);
  assert.doesNotMatch(source, /libsignal|secureagentchannel/i);
});

test('untyped delivery failures preserve an uncertain outcome', async () => {
  const underlying = createReferenceAdapter();
  underlying.deliver = async () => {
    throw new Error('connection ended before a receipt arrived');
  };
  const adapter = createGuardedTransportAdapter(underlying);
  await assert.rejects(
    adapter.deliver(attempt()),
    error => error instanceof TransportAdapterContractError
      && error.code === 'TRANSPORT_ADAPTER_DELIVERY_FAILED'
      && error.outcome === 'UNCERTAIN'
      && error.retryable === true
  );
});

if (require.main === module) {
  registerTransportAdapterConformance('reference transport adapter', async () => createReferenceAdapter());
}

module.exports = Object.freeze({
  attempt,
  createReferenceAdapter,
  registerTransportAdapterConformance
});
