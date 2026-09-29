'use strict';

// Shell-only inherited IPC. This channel is not a bridge action, tool, bearer
// grant, migration permit or persisted certificate. The exact retained child
// and its connection epoch are the authority; paths/proof booleans are not.
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { readResearchQuiescenceObservation: readOwned, DEFAULT_GRACE_MS,
  DEFAULT_CLEANUP_MS } = require('./worker-supervisor');

const CHANNEL = 'toolsenabled.research-lifecycle.v1';
const observations = new WeakMap();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,99}$/;
const MAX_FRAME_BYTES = 8192;
function failure(code) { return Object.assign(new Error('The private research shutdown channel is unavailable or could not be verified.'), { code }); }
function exact(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function budget(value, fallback) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > 60000) throw failure('RESEARCH_LIFECYCLE_BUDGET_INVALID');
  return result;
}
function validFrame(value) {
  try { return value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= MAX_FRAME_BYTES; }
  catch { return false; }
}
function send(peer, value) {
  return new Promise((resolve, reject) => {
    try {
      if (peer.connected === false || typeof peer.send !== 'function') throw failure('RESEARCH_LIFECYCLE_DISCONNECTED');
      peer.send(value, error => error ? reject(failure('RESEARCH_LIFECYCLE_DISCONNECTED')) : resolve());
    } catch { reject(failure('RESEARCH_LIFECYCLE_DISCONNECTED')); }
  });
}
function readResearchQuiescenceObservation(value, expectedFacade) {
  if (!value || typeof value !== 'object' || !expectedFacade) return null;
  const issued = observations.get(value);
  return issued?.facade === expectedFacade
    ? (!issued.valid || issued.valid() ? issued.value : null)
    : readOwned(value, expectedFacade);
}

function attachResearchLifecycle(child, options = {}) {
  if (!child || typeof child.on !== 'function' || typeof child.send !== 'function'
      || !UUID.test(options.bootId) || !UUID.test(options.generation)
      || (options.stateIdentity !== undefined && !HASH.test(options.stateIdentity))) throw failure('RESEARCH_LIFECYCLE_BINDING_INVALID');
  const bootId = options.bootId;
  const generation = options.generation;
  const graceMs = budget(options.graceMs, DEFAULT_GRACE_MS);
  const cleanupMs = budget(options.cleanupMs, DEFAULT_CLEANUP_MS);
  let sequence = 0;
  let closed = false;
  let sealed = false;
  let scope = null;
  let firstFailure = null;
  let quiescence = null;
  let terminalObservation = null;
  const pending = new Map();
  let facade;

  const fail = error => {
    firstFailure = firstFailure || error;
    if (error.code !== 'RESEARCH_LIFECYCLE_DISCONNECTED') terminalObservation = null;
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(firstFailure); }
    pending.clear();
  };
  const reply = message => {
    if (message?.channel !== CHANNEL || closed) return;
    try {
      if (message.type === 'terminal') {
        if (!validFrame(message) || !exact(message, ['channel', 'type', 'bootId', 'generation', 'sequence', 'result'])
            || message.bootId !== bootId || message.generation !== generation || !scope
            || message.sequence !== sequence || terminalObservation
            || typeof message.result?.requestId !== 'string' || !message.result.requestId.length
            || message.result.requestId.length > 200) throw failure('RESEARCH_LIFECYCLE_REPLY_INVALID');
        // The child has sealed and drained its real retained host before a
        // failed startup exits. This is a separate terminal observation, never
        // a replacement for a pending or already-refused quiesce request.
        terminalObservation = validate(message.result, message.result.requestId);
        const received = terminalObservation;
        observations.set(received, { facade, value: received, valid: () => terminalObservation === received });
        sealed = true;
        // A send callback alone does not mean the receiver consumed the frame
        // before native child exit (notably on Windows). Acknowledge only this
        // validated receipt, on the next sequence of the original handshake.
        void send(child, { channel: CHANNEL, type: 'request', bootId, generation,
          sequence: ++sequence, op: 'terminal-ack', hostEpoch: scope.hostEpoch,
          stateIdentity: scope.stateIdentity, requestId: received.requestId }).catch(fail);
        return;
      }
      if (!validFrame(message) || message.type !== 'reply' || message.bootId !== bootId
          || message.generation !== generation || !Number.isSafeInteger(message.sequence)) throw failure('RESEARCH_LIFECYCLE_REPLY_INVALID');
      const item = pending.get(message.sequence);
      if (!item || message.op !== item.op) throw failure('RESEARCH_LIFECYCLE_REPLY_REPLAY');
      if (performance.now() >= item.deadline) throw failure('RESEARCH_LIFECYCLE_TIMEOUT');
      if (!exact(message, ['channel', 'type', 'bootId', 'generation', 'sequence', 'op', 'result'])) throw failure('RESEARCH_LIFECYCLE_REPLY_INVALID');
      if (item.op === 'hello') {
        const value = message.result;
        if (!exact(value, ['hostEpoch', 'stateIdentity']) || !UUID.test(value.hostEpoch) || !HASH.test(value.stateIdentity)
            || (options.stateIdentity && value.stateIdentity !== options.stateIdentity)) throw failure('RESEARCH_LIFECYCLE_SCOPE_MISMATCH');
        // IPC can drain a queued hello and terminal frame before running the
        // promise continuation. Bind the authenticated hello in this handler.
        scope = Object.freeze({ hostEpoch: value.hostEpoch, stateIdentity: value.stateIdentity, generation });
      }
      pending.delete(message.sequence); clearTimeout(item.timer); item.resolve(message.result);
    } catch (error) { fail(error); }
  };
  const disconnected = () => fail(failure('RESEARCH_LIFECYCLE_DISCONNECTED'));
  child.on('message', reply);
  child.on('disconnect', disconnected);
  child.on('exit', disconnected);
  child.on('error', disconnected);
  const request = (op, fields, timeoutMs) => {
    if (closed) return Promise.reject(firstFailure || failure('RESEARCH_LIFECYCLE_DISCONNECTED'));
    const id = ++sequence;
    const promise = new Promise((resolve, reject) => {
      const deadline = performance.now() + timeoutMs;
      const timer = setTimeout(() => { pending.delete(id); reject(failure('RESEARCH_LIFECYCLE_TIMEOUT')); }, timeoutMs);
      pending.set(id, { op, resolve, reject, timer, deadline });
      void send(child, { channel: CHANNEL, type: 'request', bootId, generation, sequence: id, op, ...fields }).catch(fail);
    });
    promise.catch(() => {});
    return promise;
  };
  const hello = request('hello', {}, graceMs + cleanupMs).then(() => scope);
  hello.catch(fail);
  const unknown = (requestId, reasonCode) => Object.freeze({ version: 1, requestId,
    scope: Object.freeze({ ...(scope || { hostEpoch: null, stateIdentity: null, generation }), runtimeInstanceId: null }),
    status: 'unknown', admissionSealed: false, workerDbClosed: false, nativeCleanup: 'UNKNOWN', reasonCode });
  const validate = (value, requestId) => {
    if (!exact(value, ['version', 'requestId', 'scope', 'status', 'admissionSealed', 'workerDbClosed', 'nativeCleanup', 'reasonCode'])
        || value.version !== 1 || value.requestId !== requestId
        || !exact(value.scope, ['hostEpoch', 'stateIdentity', 'generation', 'runtimeInstanceId'])
        || value.scope.hostEpoch !== scope.hostEpoch || value.scope.stateIdentity !== scope.stateIdentity
        || value.scope.generation !== generation || !(value.scope.runtimeInstanceId === null || UUID.test(value.scope.runtimeInstanceId))
        || typeof value.admissionSealed !== 'boolean' || typeof value.workerDbClosed !== 'boolean'
        || !['owned-empty', 'not-started-in-epoch', 'unknown'].includes(value.status)
        || !['EMPTY', 'NOT_STARTED', 'UNKNOWN'].includes(value.nativeCleanup)
        || !(value.reasonCode === null || CODE.test(value.reasonCode))) throw failure('RESEARCH_LIFECYCLE_OBSERVATION_INVALID');
    if (value.status !== 'unknown' && (!value.admissionSealed || !value.workerDbClosed || value.reasonCode !== null
        || (value.status === 'owned-empty' && (value.nativeCleanup !== 'EMPTY' || !value.scope.runtimeInstanceId))
        || (value.status === 'not-started-in-epoch' && value.nativeCleanup !== 'NOT_STARTED'))) throw failure('RESEARCH_LIFECYCLE_OBSERVATION_INVALID');
    return Object.freeze({ ...value, scope: Object.freeze({ ...value.scope }) });
  };
  const sealAdmission = () => {
    if (!sealed) {
      sealed = true;
      void hello.then(() => request('seal', { ...scope }, graceMs + cleanupMs)).then(value => {
        if (!exact(value, ['admissionSealed']) || value.admissionSealed !== true) throw failure('RESEARCH_LIFECYCLE_REPLY_INVALID');
      }).catch(fail);
    }
    return Object.freeze({ admissionSealed: true, scope }); // Local latch, not a remote ACK.
  };
  facade = Object.freeze({
    sealAdmission,
    quiesceOwned(input = {}) {
      if (quiescence) return quiescence;
      if (terminalObservation) return Promise.resolve(terminalObservation);
      sealAdmission();
      const requestId = typeof input.requestId === 'string' && input.requestId.length > 0 && input.requestId.length <= 200
        ? input.requestId : crypto.randomUUID();
      quiescence = (async () => {
        try {
          const grace = budget(input.graceMs, graceMs);
          const cleanup = budget(input.cleanupMs, cleanupMs);
          await hello;
          return validate(await request('quiesce', { ...scope, requestId, graceMs: grace, cleanupMs: cleanup }, grace + cleanup), requestId);
        } catch (error) { return unknown(requestId, error.code || 'RESEARCH_LIFECYCLE_FAILED'); }
      })().then(value => { observations.set(value, { facade, value }); return value; });
      return quiescence;
    },
    snapshot() { return Object.freeze({ scope, admissionSealed: sealed, connected: !closed, reasonCode: firstFailure?.code || null }); },
    close() {
      fail(failure('RESEARCH_LIFECYCLE_DISCONNECTED'));
      child.off('message', reply); child.off('disconnect', disconnected); child.off('exit', disconnected); child.off('error', disconnected);
    }
  });
  return facade;
}

function installResearchLifecycle({ peer = process, host, generation: expectedGeneration, stateIdentity: expectedState,
  terminalTimeoutMs = DEFAULT_GRACE_MS } = {}) {
  if (!peer || typeof peer.on !== 'function' || typeof peer.send !== 'function' || !host
      || typeof host.sealAdmission !== 'function' || typeof host.quiesceOwned !== 'function' || typeof host.snapshot !== 'function') throw failure('RESEARCH_LIFECYCLE_BINDING_INVALID');
  const ownScope = host.snapshot().scope;
  if (!UUID.test(ownScope?.hostEpoch) || !HASH.test(ownScope?.stateIdentity)
      || (expectedState && ownScope.stateIdentity !== expectedState)) throw failure('RESEARCH_LIFECYCLE_BINDING_INVALID');
  let connection = null;
  let sequence = 0;
  let closed = false;
  let terminalFlight = null;
  let terminalPending = null;
  const terminalWait = budget(terminalTimeoutMs, DEFAULT_GRACE_MS);
  const disconnect = () => {
    if (closed) return;
    closed = true;
    terminalPending?.finish(failure('RESEARCH_LIFECYCLE_DISCONNECTED'));
    host.sealAdmission();
    void host.quiesceOwned().catch(() => {}); // Exact owned cleanup continues; disconnect is not proof.
  };
  const receive = message => {
    if (message?.channel !== CHANNEL || closed) return;
    try {
      if (!validFrame(message) || message.type !== 'request' || !UUID.test(message.bootId) || !UUID.test(message.generation)
          || !Number.isSafeInteger(message.sequence) || message.sequence !== sequence + 1) throw failure('RESEARCH_LIFECYCLE_REQUEST_INVALID');
      const common = ['channel', 'type', 'bootId', 'generation', 'sequence', 'op'];
      if (!connection) {
        if (message.op !== 'hello' || !exact(message, common) || (expectedGeneration && expectedGeneration !== message.generation)) throw failure('RESEARCH_LIFECYCLE_BINDING_INVALID');
        connection = Object.freeze({ bootId: message.bootId, generation: message.generation });
      } else if (message.bootId !== connection.bootId || message.generation !== connection.generation || message.op === 'hello'
          || message.hostEpoch !== ownScope.hostEpoch || message.stateIdentity !== ownScope.stateIdentity) throw failure('RESEARCH_LIFECYCLE_SCOPE_MISMATCH');
      sequence = message.sequence;
      const respond = result => send(peer, { channel: CHANNEL, type: 'reply', ...connection,
        sequence: message.sequence, op: message.op, result });
      if (message.op === 'hello') { void respond({ hostEpoch: ownScope.hostEpoch, stateIdentity: ownScope.stateIdentity }).catch(disconnect); return; }
      const scoped = [...common, 'hostEpoch', 'stateIdentity'];
      if (message.op === 'terminal-ack' && exact(message, [...scoped, 'requestId'])
          && terminalPending && message.sequence === terminalPending.sequence
          && message.requestId === terminalPending.requestId) {
        terminalPending.acknowledged = true;
        terminalPending.finish();
        return;
      }
      if (message.op === 'seal' && exact(message, scoped)) {
        host.sealAdmission(); void respond({ admissionSealed: true }).catch(disconnect); return;
      }
      if (message.op !== 'quiesce' || !exact(message, [...scoped, 'requestId', 'graceMs', 'cleanupMs'])
          || typeof message.requestId !== 'string' || !message.requestId.length || message.requestId.length > 200) throw failure('RESEARCH_LIFECYCLE_REQUEST_INVALID');
      const graceMs = budget(message.graceMs, DEFAULT_GRACE_MS);
      const cleanupMs = budget(message.cleanupMs, DEFAULT_CLEANUP_MS);
      host.sealAdmission();
      void host.quiesceOwned({ requestId: message.requestId, graceMs, cleanupMs }).then(value => {
        const observed = readOwned(value, host);
        if (!observed || observed.requestId !== message.requestId || observed.scope.hostEpoch !== ownScope.hostEpoch
            || observed.scope.stateIdentity !== ownScope.stateIdentity) throw failure('RESEARCH_LIFECYCLE_OBSERVATION_INVALID');
        return respond({ ...observed, scope: { ...observed.scope, generation: connection.generation } });
      }).catch(disconnect);
    } catch { disconnect(); }
  };
  const publishQuiescence = value => {
    if (terminalFlight) return terminalFlight;
    // Callers cannot supply a structural success. Only this exact supervisor's
    // branded result can cross its original private channel and host epoch.
    const observed = readOwned(value, host);
    if (!observed || observed.scope.hostEpoch !== ownScope.hostEpoch
        || observed.scope.stateIdentity !== ownScope.stateIdentity) return Promise.reject(failure('RESEARCH_LIFECYCLE_OBSERVATION_INVALID'));
    if (closed || !connection) return Promise.resolve(false);
    const frame = { channel: CHANNEL, type: 'terminal', ...connection, sequence,
      result: { ...observed, scope: { ...observed.scope, generation: connection.generation } } };
    const deadline = performance.now() + terminalWait;
    terminalFlight = new Promise((resolve, reject) => {
      let settled = false;
      const waiter = { sequence: sequence + 1, requestId: observed.requestId, sent: false, acknowledged: false,
        finish(error) {
          if (settled) return;
          if (!error && performance.now() >= deadline) error = failure('RESEARCH_LIFECYCLE_TIMEOUT');
          if (!error && (!waiter.sent || !waiter.acknowledged)) return;
          settled = true; clearTimeout(timer);
          if (terminalPending === waiter) terminalPending = null;
          if (error) reject(error); else resolve(true);
        }
      };
      // Install before send: a real or queued peer may ACK before its send
      // callback's Promise continuation. Both completions share one deadline.
      terminalPending = waiter;
      const timer = setTimeout(() => waiter.finish(failure('RESEARCH_LIFECYCLE_TIMEOUT')), terminalWait);
      send(peer, frame).then(() => { waiter.sent = true; waiter.finish(); }, error => waiter.finish(error));
    });
    return terminalFlight;
  };
  peer.on('message', receive); peer.on('disconnect', disconnect);
  return Object.freeze({ publishQuiescence,
    close() { disconnect(); peer.off('message', receive); peer.off('disconnect', disconnect); } });
}

module.exports = Object.freeze({ CHANNEL, attachResearchLifecycle, installResearchLifecycle, readResearchQuiescenceObservation });
