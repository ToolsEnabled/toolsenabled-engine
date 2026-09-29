'use strict';

// Q21/AGW-06. Deterministic provider-free lifecycle fixtures. These adapters
// hold only ephemeral in-memory fixture state: they do not import or mutate the
// canonical task service, provider controls, audit, browser, vault, or broker.
// Read-only binding qualification, including its live clock and expiry checks,
// is intentionally outside this provider-free fixture adapter's boundary.
const crypto = require('node:crypto');
const adapterContracts = require('./delegation-adapter-contracts');

const ADAPTER_ID = 'agw-fake-adapter';
const ADAPTER_VERSION = '1.0.0';
const HANDLE_ID = /^[a-z][a-z0-9._-]{2,119}$/;
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+|\b(?:api[_-]?key|token|password|cookie|otp|mfa|secret)\b|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;
const SCRIPT_IDS = Object.freeze([
  'fake.approval_required',
  'fake.blocked',
  'fake.crash',
  'fake.input_required',
  'fake.late_completion',
  'fake.looping',
  'fake.malformed_output',
  'fake.rate_limited',
  'fake.success'
]);

const MANIFEST = Object.freeze({
  schemaVersion: 1,
  adapterId: ADAPTER_ID,
  adapterVersion: ADAPTER_VERSION,
  supportedRoles: Object.freeze(['deterministic_verification', 'disposable_edit', 'read_only_review']),
  transport: 'local',
  parser: Object.freeze({ id: 'fixture-parser', version: '1.0.0' }),
  probe: Object.freeze({ protocol: 'provider-health/v1', maxAgeMs: 60_000 }),
  process: Object.freeze({ environment: 'sanitized', ownership: 'adapter_owned_process_tree', cleanup: 'owned_process_tree_only' }),
  output: Object.freeze({ eventSchema: 'agent-event/v1', resultContract: 'delegation-contracts/v1', eventKinds: Object.freeze(['complete', 'error', 'input_required', 'progress']) })
});

class DelegationFakeAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DelegationFakeAdapterError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DelegationFakeAdapterError(code, message);
}

function hash(kind, value) {
  return crypto.createHash('sha256').update(`toolsenabled.fake-adapter.v1\0${kind}\0${JSON.stringify(value)}`).digest('hex');
}

function plain(value, label) {
  let valid = false;
  try {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      valid = prototype === Object.prototype || prototype === null;
    }
  } catch {
    valid = false;
  }
  if (!valid) {
    fail('FAKE_ADAPTER_INVALID', `${label} is invalid.`);
  }
  return value;
}

function exact(value, fields, required, label) {
  const source = plain(value, label);
  let keys;
  try { keys = Reflect.ownKeys(source); } catch {
    fail('FAKE_ADAPTER_INVALID', `${label} is invalid.`);
  }
  if (keys.some(key => typeof key !== 'string' || !fields.includes(key))
      || required.some(key => !keys.includes(key))) {
    fail('FAKE_ADAPTER_INVALID', `${label} has unsupported or missing fields.`);
  }
  const snapshot = {};
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(source, key); } catch {
      fail('FAKE_ADAPTER_INVALID', `${label} must contain only data fields.`);
    }
    if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('FAKE_ADAPTER_INVALID', `${label} must contain only enumerable data fields.`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function handleId(value, label) {
  if (typeof value !== 'string' || !HANDLE_ID.test(value) || SENSITIVE.test(value)) {
    fail('FAKE_ADAPTER_INVALID', `${label} is invalid.`);
  }
  return value;
}

function limit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
    fail('FAKE_ADAPTER_INVALID', 'collectionLimit is invalid.');
  }
  return value;
}

function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

function scriptedItems(scriptId) {
  switch (scriptId) {
    case 'fake.success': return [{ id: 'start', kind: 'progress' }, { id: 'verify', kind: 'progress' }, { id: 'complete', kind: 'complete' }];
    case 'fake.blocked': return [{ id: 'blocked', kind: 'error', terminalState: 'blocked', blockerCode: 'fixture-blocked' }];
    case 'fake.input_required': return [{ id: 'input', kind: 'input_required' }];
    case 'fake.approval_required': return [{ id: 'approval', kind: 'error', terminalState: 'blocked', blockerCode: 'approval-required' }];
    case 'fake.rate_limited': return [{ id: 'rate-limit', kind: 'error', terminalState: 'failed' }];
    case 'fake.crash': return [{ id: 'crash', kind: 'error', terminalState: 'failed' }];
    case 'fake.late_completion': return [{ id: 'start', kind: 'progress' }, { id: 'late-complete', kind: 'complete' }];
    case 'fake.malformed_output': return [{ id: 'malformed', kind: 'malformed' }];
    case 'fake.looping': return Array.from({ length: 32 }, (_, index) => ({ id: `loop-${index}`, kind: 'progress' }));
    default: fail('FAKE_ADAPTER_SCRIPT_DENIED', 'scriptId is not supported.');
  }
}

function makeWorkerResult(session, terminalState, blockerCode = null) {
  const suffix = hash('result-id', { handleId: session.handleId, eventCount: session.nextSequence }).slice(0, 32);
  const result = {
    schemaVersion: 1,
    workerResultId: `wrk_${suffix}`,
    delegationId: `dlg_${hash('delegation-id', session.handleId).slice(0, 32)}`,
    attempt: 1,
    terminalState,
    baseSnapshot: { rootId: 'fixture-root', commitSha1: 'a'.repeat(40), treeSha256: 'b'.repeat(64) },
    capabilityProfileHash: 'c'.repeat(64),
    artifacts: [],
    verification: { state: terminalState === 'complete' ? 'passed' : 'not_run', criterionIds: terminalState === 'complete' ? ['fixture-complete'] : [], evidenceRefs: [] },
    blockerCode,
    usage: { modelTokens: 0, toolCalls: 0, wallMs: 0, usageRecordRefs: [] },
    brokerAcceptanceState: 'UNACCEPTED'
  };
  return result;
}

function makeEvent(session, item) {
  const event = {
    schemaVersion: 'agent-event/v1',
    adapterId: ADAPTER_ID,
    kind: item.kind,
    sequence: session.nextSequence,
    // This is intentionally derived from fixed script metadata, never from an
    // owner input or raw provider content.
    payloadHash: hash('event', { scriptId: session.scriptId, itemId: item.id, sequence: session.nextSequence })
  };
  const validated = adapterContracts.validateEventEnvelope(MANIFEST, event);
  session.nextSequence += 1;
  return frozen(validated);
}

function makeResultEnvelope(session, terminalState, blockerCode) {
  const result = {
    schemaVersion: 'agent-adapter-result/v1',
    adapterId: ADAPTER_ID,
    eventCursor: hash('cursor', { handleId: session.handleId, fence: session.fence, eventIds: [...session.deliveredIds].sort() }),
    workerResult: makeWorkerResult(session, terminalState, blockerCode)
  };
  return adapterContracts.validateResultEnvelope(MANIFEST, result);
}

function emptyBatch(session) {
  return frozen({ adapterId: ADAPTER_ID, events: [], result: null, fence: session ? session.fence : 0 });
}

function createFakeAdapter() {
  const sessions = new Map();

  const adapter = {
    probe() {
      return Promise.resolve(frozen({ adapterId: ADAPTER_ID, available: true, healthProtocol: 'provider-health/v1' }));
    },

    start(request) {
      const source = exact(request, ['handleId', 'scriptId', 'collectionLimit', 'injectDuplicateFirstEvent'], ['handleId', 'scriptId'], 'startRequest');
      const id = handleId(source.handleId, 'startRequest.handleId');
      if (sessions.has(id)) fail('FAKE_ADAPTER_DUPLICATE_HANDLE', 'handleId is already active.');
      if (!SCRIPT_IDS.includes(source.scriptId)) fail('FAKE_ADAPTER_SCRIPT_DENIED', 'scriptId is not supported.');
      const collectionLimit = Object.hasOwn(source, 'collectionLimit') ? limit(source.collectionLimit) : 8;
      if (Object.hasOwn(source, 'injectDuplicateFirstEvent') && source.injectDuplicateFirstEvent !== true && source.injectDuplicateFirstEvent !== false) {
        fail('FAKE_ADAPTER_INVALID', 'injectDuplicateFirstEvent is invalid.');
      }
      const items = scriptedItems(source.scriptId);
      if (source.injectDuplicateFirstEvent === true) items.splice(1, 0, { ...items[0] });
      const session = { handleId: id, scriptId: source.scriptId, items, collectionLimit, nextSequence: 0, fence: 0, deliveredIds: new Set(), terminal: false, inputAcknowledged: false, syntheticProcessOwned: source.scriptId === 'fake.crash', loopTerminalEmitted: false };
      sessions.set(id, session);
      return Promise.resolve(frozen({ adapterId: ADAPTER_ID, handleId: id, fence: session.fence }));
    },

    collect(handle) {
      const source = exact(handle, ['handleId', 'fence'], ['handleId', 'fence'], 'collectHandle');
      const id = handleId(source.handleId, 'collectHandle.handleId');
      const session = sessions.get(id);
      if (!session || source.fence !== session.fence || session.terminal) return Promise.resolve(emptyBatch(session));

      if (session.nextSequence >= session.collectionLimit && session.scriptId === 'fake.looping') {
        session.terminal = true;
        if (!session.loopTerminalEmitted) {
          session.loopTerminalEmitted = true;
          const item = { id: 'loop-limit', kind: 'error', terminalState: 'failed' };
          const event = makeEvent(session, item);
          session.deliveredIds.add(item.id);
          return Promise.resolve(frozen({ adapterId: ADAPTER_ID, events: [event], result: makeResultEnvelope(session, 'failed'), fence: session.fence }));
        }
        return Promise.resolve(emptyBatch(session));
      }

      while (session.items.length) {
        const item = session.items.shift();
        if (session.deliveredIds.has(item.id)) continue;
        session.deliveredIds.add(item.id);
        if (item.kind === 'malformed') {
          session.terminal = true;
          fail('FAKE_ADAPTER_MALFORMED_OUTPUT', 'script produced malformed output.');
        }
        const event = makeEvent(session, item);
        if (item.kind === 'complete' || item.kind === 'error') {
          session.terminal = true;
          return Promise.resolve(frozen({ adapterId: ADAPTER_ID, events: [event], result: makeResultEnvelope(session, item.terminalState || (item.kind === 'complete' ? 'complete' : 'failed'), item.blockerCode || null), fence: session.fence }));
        }
        return Promise.resolve(frozen({ adapterId: ADAPTER_ID, events: [event], result: null, fence: session.fence }));
      }
      return Promise.resolve(emptyBatch(session));
    },

    provideInput(handle, input) {
      const source = exact(handle, ['handleId', 'fence'], ['handleId', 'fence'], 'inputHandle');
      const id = handleId(source.handleId, 'inputHandle.handleId');
      const session = sessions.get(id);
      if (!session || source.fence !== session.fence || session.terminal) return Promise.resolve(frozen({ acknowledged: false, fence: session ? session.fence : 0 }));
      if (typeof input !== 'string' || input.length < 1 || input.length > 256 || SENSITIVE.test(input)) {
        fail('FAKE_ADAPTER_INPUT_DENIED', 'input is invalid or sensitive.');
      }
      if (session.scriptId === 'fake.input_required' && !session.inputAcknowledged) {
        // Never retain, transform, interpolate, or hash the caller input.
        session.inputAcknowledged = true;
        session.items.push({ id: 'input-ack', kind: 'progress' }, { id: 'input-complete', kind: 'complete' });
      }
      return Promise.resolve(frozen({ acknowledged: true, fence: session.fence }));
    },

    cancel(handle) {
      const source = exact(handle, ['handleId', 'fence'], ['handleId', 'fence'], 'cancelHandle');
      const id = handleId(source.handleId, 'cancelHandle.handleId');
      const session = sessions.get(id);
      if (!session || source.fence !== session.fence) return Promise.resolve(frozen({ cancelled: false, fence: session ? session.fence : 0 }));
      session.fence += 1;
      session.items = [];
      session.terminal = true;
      return Promise.resolve(frozen({ cancelled: true, fence: session.fence }));
    },

    cleanup(handle) {
      const source = exact(handle, ['handleId', 'fence'], ['handleId', 'fence'], 'cleanupHandle');
      const id = handleId(source.handleId, 'cleanupHandle.handleId');
      const session = sessions.get(id);
      if (!session || source.fence !== session.fence) return Promise.resolve(frozen({ adapterId: ADAPTER_ID, handleId: id, releasedSyntheticOwnership: false, fence: session ? session.fence : 0 }));
      const releasedSyntheticOwnership = session.syntheticProcessOwned;
      session.syntheticProcessOwned = false;
      sessions.delete(id);
      return Promise.resolve(frozen({ adapterId: ADAPTER_ID, handleId: id, releasedSyntheticOwnership, fence: source.fence }));
    }
  };
  Object.defineProperty(adapter, 'descriptorId', { value: ADAPTER_ID, enumerable: true, writable: false, configurable: false });
  return Object.freeze(adapter);
}

function registerFakeAdapter() {
  return adapterContracts.validateAdapterRegistration(MANIFEST, createFakeAdapter());
}

module.exports = Object.freeze({
  ADAPTER_ID,
  ADAPTER_VERSION,
  DelegationFakeAdapterError,
  MANIFEST,
  SCRIPT_IDS,
  createFakeAdapter,
  registerFakeAdapter
});
