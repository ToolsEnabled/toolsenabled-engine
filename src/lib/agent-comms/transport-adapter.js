'use strict';

const CONTRACT_ID = 'agent-comms.transport-adapter';
const CONTRACT_VERSION = 1;
const REQUIRED_CAPABILITIES = Object.freeze([
  'authenticatedIdentity',
  'confidentiality',
  'durableRetry',
  'keyRotation',
  'replayRefusal',
  'tamperRefusal'
]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

class TransportAdapterContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TransportAdapterContractError';
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.outcome = details.outcome || 'FAILED';
    this.retryable = details.retryable === true;
  }
}

function fail(code, message, details) {
  throw new TransportAdapterContractError(code, message, details);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('TRANSPORT_ADAPTER_ARGUMENT_INVALID', `${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('TRANSPORT_ADAPTER_ARGUMENT_INVALID', `${label} must be a plain object.`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    fail('TRANSPORT_ADAPTER_ARGUMENT_INVALID', `${label} is invalid.`, { field: label });
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('TRANSPORT_ADAPTER_ARGUMENT_INVALID', `${label} must be a positive safe integer.`, { field: label });
  }
  return value;
}

function identity(value, label) {
  const source = plainObject(value, label);
  return Object.freeze({
    agentId: identifier(source.agentId, `${label}.agentId`),
    machineId: identifier(source.machineId, `${label}.machineId`)
  });
}

function sameIdentity(left, right) {
  return left.agentId === right.agentId && left.machineId === right.machineId;
}

function validateDescriptor(input) {
  const descriptor = plainObject(input, 'adapter descriptor');
  const contract = plainObject(descriptor.contract, 'adapter descriptor.contract');
  if (contract.id !== CONTRACT_ID || contract.version !== CONTRACT_VERSION) {
    fail('TRANSPORT_ADAPTER_CONTRACT_MISMATCH', 'Adapter contract id/version does not match this runtime.', {
      expectedId: CONTRACT_ID,
      expectedVersion: CONTRACT_VERSION
    });
  }
  const capabilities = plainObject(descriptor.capabilities, 'adapter descriptor.capabilities');
  for (const capability of REQUIRED_CAPABILITIES) {
    if (capabilities[capability] !== true) {
      fail('TRANSPORT_ADAPTER_CAPABILITY_MISSING', `Adapter must attest capability ${capability}.`, { capability });
    }
  }
  identifier(descriptor.adapterId, 'adapter descriptor.adapterId');
  if (typeof descriptor.implementationLabel !== 'string'
    || descriptor.implementationLabel.length < 1
    || descriptor.implementationLabel.length > 240) {
    fail('TRANSPORT_ADAPTER_DESCRIPTOR_INVALID', 'Adapter implementationLabel is invalid.');
  }
  return Object.freeze({
    adapterId: descriptor.adapterId,
    capabilities: Object.freeze(Object.fromEntries(REQUIRED_CAPABILITIES.map(name => [name, true]))),
    contract: Object.freeze({ id: CONTRACT_ID, version: CONTRACT_VERSION }),
    implementationLabel: descriptor.implementationLabel
  });
}

function validateAdapter(input) {
  const adapter = plainObject(input, 'adapter');
  const requiredMethods = ['close', 'deliver', 'describe', 'health', 'provision', 'rotate'];
  for (const method of requiredMethods) {
    if (typeof adapter[method] !== 'function') {
      fail('TRANSPORT_ADAPTER_METHOD_MISSING', `Adapter must expose ${method}().`, { method });
    }
  }
  return validateDescriptor(adapter.describe());
}

function validateDeliveryAttempt(input) {
  const attempt = plainObject(input, 'delivery attempt');
  const messageId = identifier(attempt.messageId, 'delivery attempt.messageId');
  if (attempt.idempotencyKey !== messageId) {
    fail('TRANSPORT_ADAPTER_IDEMPOTENCY_KEY_INVALID', 'idempotencyKey must equal messageId.', { messageId });
  }
  const recipientSource = plainObject(attempt.recipient, 'delivery attempt.recipient');
  const recipient = identity(recipientSource, 'delivery attempt.recipient');
  const message = plainObject(attempt.message, 'delivery attempt.message');
  const sender = identity(message.sender, 'delivery attempt.message.sender');
  const sequence = positiveInteger(attempt.sequence, 'delivery attempt.sequence');
  return Object.freeze({
    idempotencyKey: messageId,
    message,
    messageId,
    recipient,
    route: attempt.route,
    sender,
    sequence
  });
}

function validateDeliveryReceipt(input, attempt, descriptor) {
  const receipt = plainObject(input, 'delivery receipt');
  if (receipt.delivered !== true || receipt.messageId !== attempt.messageId) {
    fail('TRANSPORT_ADAPTER_RECEIPT_INVALID', 'Adapter did not confirm the exact message id.', {
      messageId: attempt.messageId,
      outcome: 'UNCERTAIN'
    });
  }
  const authenticatedSender = identity(receipt.authenticatedSender, 'delivery receipt.authenticatedSender');
  const authenticatedRecipient = identity(receipt.authenticatedRecipient, 'delivery receipt.authenticatedRecipient');
  if (!sameIdentity(authenticatedSender, attempt.sender)) {
    fail('TRANSPORT_ADAPTER_SENDER_MISMATCH', 'Adapter authenticated a different sender identity.', {
      messageId: attempt.messageId
    });
  }
  if (!sameIdentity(authenticatedRecipient, attempt.recipient)) {
    fail('TRANSPORT_ADAPTER_RECIPIENT_MISMATCH', 'Adapter authenticated a different recipient identity.', {
      messageId: attempt.messageId
    });
  }
  if (receipt.deliverySequence !== attempt.sequence || receipt.idempotencyKey !== attempt.idempotencyKey) {
    fail('TRANSPORT_ADAPTER_ORDERING_RECEIPT_INVALID', 'Adapter receipt does not preserve sequence/idempotency.', {
      messageId: attempt.messageId,
      outcome: 'UNCERTAIN'
    });
  }
  const evidence = plainObject(receipt.evidence, 'delivery receipt.evidence');
  if (evidence.adapterId !== descriptor.adapterId) {
    fail('TRANSPORT_ADAPTER_RECEIPT_INVALID', 'Adapter receipt names a different adapter.', {
      messageId: attempt.messageId,
      outcome: 'UNCERTAIN'
    });
  }
  return Object.freeze({
    ...receipt,
    authenticatedRecipient,
    authenticatedSender,
    evidence: Object.freeze({ ...evidence })
  });
}

function validateProvisionResult(input, identities) {
  const result = plainObject(input, 'provision result');
  if (!Array.isArray(result.identities)) {
    fail('TRANSPORT_ADAPTER_PROVISION_RESULT_INVALID', 'Provision result must list identities.');
  }
  const expected = [...new Set(identities)].sort();
  const actual = result.identities.map(item => identifier(item.identityId, 'provision result.identityId')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)
    || result.identities.some(item => item.ready !== true)) {
    fail('TRANSPORT_ADAPTER_PROVISION_RESULT_INVALID', 'Provision result is incomplete.');
  }
  return Object.freeze({
    ...result,
    identities: Object.freeze(result.identities.map(item => Object.freeze({ ...item })))
  });
}

function validateRotationResult(input, identityId) {
  const result = plainObject(input, 'rotation result');
  if (result.rotated !== true || result.identityId !== identityId) {
    fail('TRANSPORT_ADAPTER_ROTATION_RESULT_INVALID', 'Rotation did not confirm the requested identity.');
  }
  return Object.freeze({ ...result });
}

function createGuardedTransportAdapter(adapter) {
  const descriptor = validateAdapter(adapter);
  return Object.freeze({
    async close() {
      await adapter.close();
    },
    async deliver(input) {
      const attempt = validateDeliveryAttempt(input);
      let receipt;
      try {
        receipt = await adapter.deliver(attempt);
      } catch (error) {
        if (error && typeof error === 'object' && typeof error.code === 'string') throw error;
        fail('TRANSPORT_ADAPTER_DELIVERY_FAILED', 'Adapter delivery failed without a typed outcome.', {
          messageId: attempt.messageId,
          outcome: 'UNCERTAIN',
          retryable: true
        });
      }
      return validateDeliveryReceipt(receipt, attempt, descriptor);
    },
    describe() {
      return descriptor;
    },
    async health() {
      const result = plainObject(await adapter.health(), 'health result');
      return Object.freeze({ ...result, adapterId: descriptor.adapterId });
    },
    async provision(input) {
      const source = plainObject(input, 'provision input');
      if (!Array.isArray(source.identities) || source.identities.length < 1) {
        fail('TRANSPORT_ADAPTER_ARGUMENT_INVALID', 'provision identities must be a non-empty array.');
      }
      const identities = [...new Set(source.identities.map((value, index) => identifier(value, `identities[${index}]`)))];
      return validateProvisionResult(await adapter.provision({ identities }), identities);
    },
    async rotate(input) {
      const source = plainObject(input, 'rotation input');
      const identityId = identifier(source.identityId, 'rotation input.identityId');
      if (typeof source.reason !== 'string' || source.reason.length < 1 || source.reason.length > 500) {
        fail('TRANSPORT_ADAPTER_ARGUMENT_INVALID', 'rotation reason is invalid.');
      }
      return validateRotationResult(await adapter.rotate({ identityId, reason: source.reason }), identityId);
    }
  });
}

module.exports = Object.freeze({
  CONTRACT_ID,
  CONTRACT_VERSION,
  REQUIRED_CAPABILITIES,
  TransportAdapterContractError,
  createGuardedTransportAdapter,
  sameIdentity,
  validateAdapter,
  validateDeliveryAttempt,
  validateDeliveryReceipt,
  validateDescriptor
});
