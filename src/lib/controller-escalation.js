'use strict';

// Q22 root-owned escalation handoff contract.  This module is deliberately a
// narrow, value-free controller store: it validates the inert delegation
// EscalationPacket vocabulary, binds a packet to one signed-audit head fence,
// and never accepts work on behalf of the broker.  A request stays
// UNACCEPTED until the authoritative broker/Codex path performs its own
// acceptance.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { rootPath } = require('./runtime');
const delegation = require('./delegation-contracts');

const SCHEMA_VERSION = 1;
const PACKET_VERSION = 'controller-escalation-handoff-v1';
const CAPABILITY_VERSION = 'controller-escalation-capability-v1';
const STATE_SCHEMA_VERSION = 1;
const FRESHNESS_MS = 5 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;
const AUDIT_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const HANDOFF_REF = /^hnd_[A-Za-z0-9_-]{16,96}$/;
const LIFECYCLE = Object.freeze(['UNACCEPTED']);
const REQUEST_STATES = Object.freeze(['UNACCEPTED']);
const STAGED_KEYS = Object.freeze(['packet', 'packetContractHash', 'auditFence', 'handoffRef', 'observedAtMs', 'expiresAtMs', 'lifecycleState', 'requestedDecision']);
const REQUEST_KEYS = Object.freeze(['handoffRef', 'lifecycleState', 'requestedDecision', 'expiresAtMs']);
const DEFAULT_STATE_FILE = rootPath('state', 'controller-escalation.json');

class ControllerEscalationError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'ControllerEscalationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode = 409) {
  throw new ControllerEscalationError(code, message, statusCode);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, keys, label) {
  if (!plain(value)) fail('CONTROLLER_ESCALATION_INVALID', `${label} must be a closed object.`, 400);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('CONTROLLER_ESCALATION_INVALID', `${label} has unsupported fields.`, 400);
  }
  return value;
}

function safeAuditFence(value, label) {
  const fence = exact(value, ['headSequence', 'headHash', 'headKeyId'], label);
  if (!Number.isSafeInteger(fence.headSequence) || fence.headSequence < 0) {
    fail('CONTROLLER_ESCALATION_INVALID', `${label}.headSequence is invalid.`, 400);
  }
  if (typeof fence.headHash !== 'string' || !SHA256.test(fence.headHash)) {
    fail('CONTROLLER_ESCALATION_INVALID', `${label}.headHash is invalid.`, 400);
  }
  if (typeof fence.headKeyId !== 'string' || !AUDIT_KEY_ID.test(fence.headKeyId)) {
    fail('CONTROLLER_ESCALATION_INVALID', `${label}.headKeyId is invalid.`, 400);
  }
  return Object.freeze({ headSequence: fence.headSequence, headHash: fence.headHash, headKeyId: fence.headKeyId });
}

function safeTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('CONTROLLER_ESCALATION_INVALID', `${label} is invalid.`, 400);
  return value;
}

function validatePacket(packet) {
  try {
    return delegation.validateEscalationPacket(packet);
  } catch (error) {
    if (error && error.code === 'DELEGATION_CONTRACT_VERSION_UNSUPPORTED') {
      fail('CONTROLLER_ESCALATION_VERSION_UNSUPPORTED',
        'EscalationPacket is invalid or contains unsupported content.', 400);
    }
    if (error && error.code === 'DELEGATION_CONTRACT_INVALID') {
      fail('CONTROLLER_ESCALATION_INVALID',
        'EscalationPacket is invalid or contains unsupported content.', 400);
    }
    fail('CONTROLLER_ESCALATION_VALIDATION_UNAVAILABLE',
      'EscalationPacket could not be validated safely.', 503);
  }
}

function packetWire(packet) {
  const { contractHash, ...wire } = packet;
  return wire;
}

function randomRef() {
  return `hnd_${crypto.randomBytes(18).toString('base64url')}`;
}

function stateShape(value) {
  if (!plain(value)) fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state is invalid; refusing to guess or reset it.', 503);
  try {
    return normalizeStoredState(value);
  } catch (error) {
    if (error instanceof ControllerEscalationError && error.code === 'CONTROLLER_ESCALATION_STATE_INVALID') throw error;
    fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state is invalid; refusing to guess or reset it.', 503);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// The route is a read model, not a mutable capability grant.  Freezing the
// returned graph prevents a same-process consumer from accidentally changing
// its displayed packet and then treating that local mutation as controller
// state.  The persisted state is still independently revalidated on every
// read, so this is a caller-boundary guarantee rather than a substitute for
// validation.
function immutable(value) {
  if (Array.isArray(value)) {
    for (const item of value) immutable(item);
  } else if (plain(value)) {
    for (const item of Object.values(value)) immutable(item);
  }
  return Object.freeze(value);
}

function normalizeStoredState(value) {
  exact(value, ['schemaVersion', 'staged', 'requests'], 'escalation state');
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) {
    fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state schema is unsupported.', 503);
  }
  if (!Array.isArray(value.requests) || value.requests.length > 256) {
    fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state request history is invalid.', 503);
  }
  const requests = value.requests.map((item, index) => {
    exact(item, REQUEST_KEYS, `escalation state request ${index}`);
    if (typeof item.handoffRef !== 'string' || !HANDOFF_REF.test(item.handoffRef)) {
      fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state contains an invalid handoff reference.', 503);
    }
    if (item.lifecycleState !== 'UNACCEPTED') {
      fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state contains an unsupported lifecycle state.', 503);
    }
    if (!delegation.REQUESTED_DECISIONS.includes(item.requestedDecision)) {
      fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state contains an invalid requested decision.', 503);
    }
    safeTimestamp(item.expiresAtMs, `escalation state request ${index}.expiresAtMs`);
    return {
      handoffRef: item.handoffRef,
      lifecycleState: 'UNACCEPTED',
      requestedDecision: item.requestedDecision,
      expiresAtMs: item.expiresAtMs
    };
  });
  if (value.staged === null) return { schemaVersion: STATE_SCHEMA_VERSION, staged: null, requests };

  exact(value.staged, STAGED_KEYS, 'escalation state staged record');
  const normalizedPacket = validatePacket(value.staged.packet);
  if (normalizedPacket.contractHash !== value.staged.packetContractHash) {
    fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state packet digest does not match its packet.', 503);
  }
  const auditFence = safeAuditFence(value.staged.auditFence, 'escalation state staged auditFence');
  if (typeof value.staged.handoffRef !== 'string' || !HANDOFF_REF.test(value.staged.handoffRef)) {
    fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state staged handoff reference is invalid.', 503);
  }
  const observedAtMs = safeTimestamp(value.staged.observedAtMs, 'escalation state staged observedAtMs');
  const expiresAtMs = safeTimestamp(value.staged.expiresAtMs, 'escalation state staged expiresAtMs');
  if (expiresAtMs <= observedAtMs || expiresAtMs - observedAtMs > 60 * 60 * 1000) {
    fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state staged freshness window is invalid.', 503);
  }
  if (value.staged.lifecycleState !== 'UNACCEPTED') {
    fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state staged lifecycle is unsupported.', 503);
  }
  if (value.staged.requestedDecision !== null
    && (!delegation.REQUESTED_DECISIONS.includes(value.staged.requestedDecision)
      || value.staged.requestedDecision !== normalizedPacket.requestedDecision)) {
    fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state staged decision is invalid.', 503);
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    staged: {
      packet: packetWire(normalizedPacket),
      packetContractHash: normalizedPacket.contractHash,
      auditFence,
      handoffRef: value.staged.handoffRef,
      observedAtMs,
      expiresAtMs,
      lifecycleState: 'UNACCEPTED',
      requestedDecision: value.staged.requestedDecision
    },
    requests
  };
}

function writeAtomic(file, value, fsModule = fs) {
  fsModule.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const descriptor = fsModule.openSync(temporary, 'wx', 0o600);
    try {
      fsModule.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fsModule.fsyncSync(descriptor);
    } finally {
      fsModule.closeSync(descriptor);
    }
    fsModule.renameSync(temporary, file);
  } catch (error) {
    try { fsModule.rmSync(temporary, { force: true }); } catch { /* preserve original error */ }
    throw error;
  }
}

function equalFence(a, b) {
  return a && b && a.headSequence === b.headSequence && a.headHash === b.headHash && a.headKeyId === b.headKeyId;
}

function currentFence(value) {
  return safeAuditFence(value, 'currentAuditFence');
}

class ControllerEscalationStore {
  constructor({ stateFile = DEFAULT_STATE_FILE, clock = () => Date.now(), fsModule = fs, freshnessMs = FRESHNESS_MS } = {}) {
    this.stateFile = stateFile;
    this.clock = clock;
    this.fs = fsModule;
    if (!Number.isSafeInteger(freshnessMs) || freshnessMs < 1_000 || freshnessMs > 60 * 60 * 1000) {
      throw new TypeError('freshnessMs must be between one second and one hour.');
    }
    this.freshnessMs = freshnessMs;
  }

  _read() {
    try { return stateShape(JSON.parse(this.fs.readFileSync(this.stateFile, 'utf8'))); }
    catch (error) {
      if (error && error.code === 'ENOENT') return { schemaVersion: STATE_SCHEMA_VERSION, staged: null, requests: [] };
      if (error instanceof ControllerEscalationError) throw error;
      fail('CONTROLLER_ESCALATION_STATE_INVALID', 'Escalation state could not be read safely.', 503);
    }
  }

  _write(state) { writeAtomic(this.stateFile, state, this.fs); }

  _fresh(staged, fence, now = this.clock()) {
    return Boolean(staged && staged.lifecycleState === 'UNACCEPTED' && staged.expiresAtMs > now && equalFence(staged.auditFence, fence));
  }

  stage({ packet, auditFence, observedAtMs = this.clock() } = {}) {
    const normalized = validatePacket(packet);
    const fence = safeAuditFence(auditFence, 'auditFence');
    const observed = safeTimestamp(observedAtMs, 'observedAtMs');
    const now = this.clock();
    if (observed > now + 30_000 || now - observed > this.freshnessMs) {
      fail('CONTROLLER_ESCALATION_STALE_PACKET', 'EscalationPacket is outside the freshness window.', 409);
    }
    const state = this._read();
    const handoffRef = randomRef();
    state.staged = {
      packet: packetWire(normalized),
      packetContractHash: normalized.contractHash,
      auditFence: fence,
      handoffRef,
      observedAtMs: observed,
      expiresAtMs: observed + this.freshnessMs,
      lifecycleState: 'UNACCEPTED',
      requestedDecision: null
    };
    state.requests = state.requests.filter(item => item && item.lifecycleState === 'UNACCEPTED' && item.expiresAtMs > now).slice(-32);
    this._write(state);
    return this.preview(fence);
  }

  capability(auditFence, now = this.clock()) {
    const fence = currentFence(auditFence);
    const state = this._read();
    const staged = state.staged;
    const fresh = this._fresh(staged, fence, now);
    if (!fresh) {
      return immutable({
        schemaVersion: CAPABILITY_VERSION,
        state: 'unavailable',
        requestRoute: '/api/controller/escalation',
        statusRoute: '/api/controller/escalation/status',
        cancelRoute: null,
        packetVersion: PACKET_VERSION,
        lifecycleState: null,
        freshness: staged ? (staged.expiresAtMs <= now ? 'expired' : 'fence-mismatch') : 'unavailable',
        observedAtMs: staged ? staged.observedAtMs : null,
        expiresAtMs: staged ? staged.expiresAtMs : null,
        handoffRef: null,
        packet: null
      });
    }
    return immutable({
      schemaVersion: CAPABILITY_VERSION,
      state: 'available',
      requestRoute: '/api/controller/escalation',
      statusRoute: '/api/controller/escalation/status',
      cancelRoute: null,
      packetVersion: PACKET_VERSION,
      lifecycleState: 'UNACCEPTED',
      freshness: 'fresh',
      observedAtMs: staged.observedAtMs,
      expiresAtMs: staged.expiresAtMs,
      handoffRef: staged.handoffRef,
      packet: clone(staged.packet)
    });
  }

  preview(auditFence, now = this.clock()) { return this.capability(auditFence, now); }

  request(input = {}) {
    const source = exact(input, ['packetVersion', 'packet', 'requestedDecision', 'auditFence'], 'escalation request');
    const { packetVersion, packet, requestedDecision, auditFence } = source;
    const body = exact({ packetVersion, packet, requestedDecision }, ['packetVersion', 'packet', 'requestedDecision'], 'escalation request body');
    if (body.packetVersion !== PACKET_VERSION) fail('CONTROLLER_ESCALATION_VERSION_UNSUPPORTED', 'Escalation request version is unsupported.', 400);
    const normalized = validatePacket(body.packet);
    if (normalized.requestedDecision !== body.requestedDecision) fail('CONTROLLER_ESCALATION_INVALID', 'Requested decision does not match the validated packet.', 400);
    const fence = currentFence(auditFence);
    const state = this._read();
    const now = this.clock();
    const staged = state.staged;
    if (!this._fresh(staged, fence, now) || staged.packetContractHash !== normalized.contractHash) {
      fail('CONTROLLER_ESCALATION_STALE_PACKET', 'EscalationPacket is stale or no longer matches the signed controller head.', 409);
    }
    if (staged.requestedDecision && staged.requestedDecision !== body.requestedDecision) {
      fail('CONTROLLER_ESCALATION_REPLAY_MISMATCH', 'The handoff reference was already requested with a different decision.', 409);
    }
    const result = immutable({
      // This store records an inert request only.  It must never imply that a
      // provider, broker, worker, or owner accepted work merely because the
      // local request was syntactically valid and persisted.
      accepted: false,
      requestRecorded: true,
      handoffRef: staged.handoffRef,
      lifecycleState: 'UNACCEPTED',
      requestState: 'UNACCEPTED',
      packetVersion: PACKET_VERSION
    });
    if (staged.requestedDecision === body.requestedDecision) return result;
    staged.requestedDecision = body.requestedDecision;
    state.requests.push({ handoffRef: staged.handoffRef, lifecycleState: 'UNACCEPTED', requestedDecision: body.requestedDecision, expiresAtMs: staged.expiresAtMs });
    this._write(state);
    return result;
  }

  status({ handoffRef, auditFence } = {}) {
    if (typeof handoffRef !== 'string' || !HANDOFF_REF.test(handoffRef)) fail('CONTROLLER_ESCALATION_INVALID', 'handoffRef is invalid.', 400);
    const fence = currentFence(auditFence);
    const state = this._read();
    const staged = state.staged;
    if (!staged || staged.handoffRef !== handoffRef || !this._fresh(staged, fence)) {
      // Do not turn an unknown, replayed, mismatched, or expired opaque ref
      // into a fabricated UNACCEPTED lifecycle.  The caller has no evidence
      // of a live packet in that case, so the only honest state is unavailable.
      return immutable({ handoffRef, lifecycleState: null, freshness: 'unavailable', requestState: null });
    }
    return immutable({ handoffRef, lifecycleState: 'UNACCEPTED', freshness: 'fresh', requestState: staged.requestedDecision ? 'UNACCEPTED' : null });
  }
}

module.exports = Object.freeze({
  CAPABILITY_VERSION, ControllerEscalationError, ControllerEscalationStore,
  FRESHNESS_MS, LIFECYCLE, PACKET_VERSION, REQUEST_STATES, SCHEMA_VERSION
});
