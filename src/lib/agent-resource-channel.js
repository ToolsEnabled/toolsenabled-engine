'use strict';

// Only the exact child retained by the desktop shell owns this inherited IPC
// endpoint. No port, environment bearer, editable settings file, or request
// body can manufacture that relationship. This is service-to-app transport,
// not a provider tool and not a replacement for session authorization.
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const CHANNEL = 'toolsenabled.resource.v1';
// A Windows wrapper may compile before it opens its OWNER pipe. This transport
// ceiling never extends the original measurement/advice lifetime supplied by
// the app, and that same deadline is checked again at the OWNER boundary.
const GRANT_MS = 5000;
const REQUEST_MS = 3000;
const ROOT_CHECK_MS = 500; // Below the Windows wrapper's unchanged 1s OWNER timeout.
const MAX_PENDING = 1024;
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function unknown() { return failure('AGENT_RESOURCE_UNKNOWN', 'The application resource authority is unavailable. This work lane was not started.'); }
function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) { return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function principalValid(value) {
  if (exact(value, ['kind']) && value.kind === 'owner-ui') return true;
  return exact(value, ['kind', 'sessionId', 'agentId', 'provider', 'roleId', 'expectedOrgRevision', 'expectedRoleRevision'])
    && value.kind === 'agent-session'
    && ['sessionId', 'agentId', 'provider', 'roleId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 200)
    && Number.isSafeInteger(value.expectedOrgRevision) && Number.isSafeInteger(value.expectedRoleRevision);
}
function send(peer, message, onError = () => {}) {
  if (!peer || peer.connected !== true || typeof peer.send !== 'function') { onError(unknown()); return false; }
  try { peer.send(message, error => { if (error) onError(error); }); return true; }
  catch (error) { onError(error); return false; }
}

function attachResourceAuthority(child, { reserveLane, onUnavailable, now = Date.now, bootId = randomUUID() } = {}) {
  if (!child || typeof child.on !== 'function' || typeof child.send !== 'function' || typeof reserveLane !== 'function') throw unknown();
  let live = true;
  let highestSequence = 0;
  let introduced = false;
  const leases = new Map();
  let unsubscribe = () => {};
  const reply = (sequence, value) => send(child, { channel: CHANNEL, type: 'reply', sequence, ...value });
  function closed() {
    if (!live) return;
    // Revoke in-flight grants on this exact inherited connection if the host
    // deliberately stops its monitor while the service process remains alive.
    send(child, { channel: CHANNEL, type: 'unavailable', bootId });
    live = false;
    unsubscribe();
    // An IPC disconnect/parent bookkeeping failure says nothing about a lane
    // job's lifetime. In particular, do NOT release outstanding reservations.
  }
  function message(value) {
    if (value?.channel !== CHANNEL) return;
    if (!live || child.connected !== true) return;
    const sequence = value.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) return;
    if (sequence <= highestSequence) {
      reply(sequence, { ok: false, code: 'RESOURCE_CHANNEL_REPLAY', message: 'This resource request was already consumed.' });
      return;
    }
    highestSequence = sequence;
    try {
      if (value.type !== 'request' || typeof value.op !== 'string') throw unknown();
      if (value.op === 'hello') {
        if (introduced || !exact(value, ['channel', 'type', 'sequence', 'op'])) throw unknown();
        introduced = true;
        reply(sequence, { ok: true, bootId });
        return;
      }
      if (!introduced || value.bootId !== bootId) throw unknown();
      if (value.op === 'reserve') {
        if (!exact(value, ['channel', 'type', 'sequence', 'op', 'bootId', 'provider', 'principal'])
          || !['claude', 'codex', 'local'].includes(value.provider) || !principalValid(value.principal)) {
          throw failure('RESOURCE_LAUNCH_CALLER_REQUIRED', 'A work-lane reservation needs its transport-bound principal and one supported program.');
        }
        // This callback is deliberately synchronous: all tree, in-process and
        // service starts spend the same governor atomically on the main thread.
        const requestedAtMs = now();
        const lease = reserveLane({ provider: value.provider }, Object.freeze({ ...value.principal }));
        if (!lease || typeof lease.release !== 'function' || typeof lease.ready !== 'function'
          || typeof lease.revalidate !== 'function' || typeof lease.then === 'function') throw unknown();
        const grantId = randomUUID();
        const issuedAtMs = now();
        // A grant must not extend the lifetime of its sampled measurement or
        // finite controller advice. The app computes this remaining interval;
        // the service cannot declare it. Deduct even the callback's latency.
        const lifetime = Math.min(GRANT_MS, lease.admission?.validForMs) - Math.max(0, issuedAtMs - requestedAtMs);
        if (!Number.isFinite(lifetime) || lifetime <= 0) { lease.release(); throw unknown(); }
        leases.set(grantId, { lease, state: 'reserved', expiresAtMs: issuedAtMs + lifetime, rootChecked: false });
        reply(sequence, { ok: true, bootId, grantId, issuedAtMs, expiresAtMs: issuedAtMs + lifetime, admission: lease.admission });
        return;
      }
      if (!exact(value, ['channel', 'type', 'sequence', 'op', 'bootId', 'grantId'])) throw unknown();
      const entry = leases.get(value.grantId);
      if (!entry) throw failure('RESOURCE_CHANNEL_GRANT_UNKNOWN', 'This work-lane grant is not active on this channel.');
      if (value.op === 'revalidate') {
        if (entry.rootChecked || !['reserved', 'spawned'].includes(entry.state)) throw failure('RESOURCE_CHANNEL_GRANT_USED', 'This reservation already checked its provider root.');
        if (now() >= entry.expiresAtMs) throw failure('AGENT_RESOURCE_GRANT_EXPIRED', 'The original resource permission expired while its wrapper prepared.');
        // Recheck the latest sample/advice and the exact live principal in the
        // app. This consumes the existing reservation, never a second budget.
        const checkedAtMs = now();
        const admission = entry.lease.revalidate();
        if (!Number.isFinite(admission?.validForMs) || admission.validForMs <= 0) throw unknown();
        entry.expiresAtMs = Math.min(entry.expiresAtMs, checkedAtMs + admission.validForMs);
        entry.rootChecked = true;
        if (now() >= entry.expiresAtMs) throw failure('AGENT_RESOURCE_GRANT_EXPIRED', 'The resource permission expired during its final check.');
        reply(sequence, { ok: true, bootId, expiresAtMs: entry.expiresAtMs });
        return;
      }
      if (value.op === 'spawned' && entry.state === 'reserved') entry.state = 'spawned';
      else if (value.op === 'ready' && entry.state === 'spawned') { entry.state = 'ready'; entry.lease.ready(); }
      else if (value.op === 'cancel' && entry.state === 'reserved') { leases.delete(value.grantId); entry.lease.release(); }
      else if (value.op === 'closed' && ['spawned', 'ready'].includes(entry.state)) { leases.delete(value.grantId); entry.lease.release(); }
      else throw failure('RESOURCE_CHANNEL_LIFECYCLE_INVALID', 'This resource grant cannot make that lifecycle transition.');
      reply(sequence, { ok: true, bootId });
    } catch (error) {
      reply(sequence, { ok: false, code: typeof error?.code === 'string' ? error.code : 'AGENT_RESOURCE_UNKNOWN', message: String(error?.message || unknown().message).slice(0, 500) });
    }
  }
  child.on('message', message);
  child.once('disconnect', closed);
  child.once('exit', closed);
  if (onUnavailable) unsubscribe = onUnavailable(closed);
  return Object.freeze({
    close() { closed(); child.off('message', message); },
    snapshot() { return { live, active: leases.size, bootId }; },
  });
}

function createResourceClient({ peer = process, monotonic = () => performance.now(), requestMs = REQUEST_MS,
  schedule = setTimeout, unschedule = clearTimeout } = {}) {
  let live = true;
  let sequence = 0;
  let bootId = null;
  let connecting = null;
  const pending = new Map();
  const expiredReservations = new Set();
  function expireReservation(id) {
    expiredReservations.add(id);
    if (expiredReservations.size > MAX_PENDING) expiredReservations.delete(expiredReservations.values().next().value);
  }
  function cancelLateReservation(value) {
    if (expiredReservations.delete(value.sequence) && value.ok === true && value.bootId === bootId
      && typeof value.grantId === 'string') void request('cancel', { grantId: value.grantId }).catch(() => {});
  }
  function closed() {
    if (!live) return;
    live = false;
    for (const call of pending.values()) { unschedule(call.timer); call.reject(unknown()); }
    pending.clear();
  }
  function message(value) {
    if (value?.channel === CHANNEL && value.type === 'unavailable' && value.bootId === bootId) { closed(); return; }
    if (value?.channel !== CHANNEL || value.type !== 'reply') return;
    const call = pending.get(value.sequence);
    if (!call) {
      // A reply that missed its request deadline never becomes launchable. If
      // this still-live channel finally delivers its unused grant, cancel that
      // exact reservation; disconnection itself is never proof of non-launch.
      cancelLateReservation(value);
      return;
    }
    pending.delete(value.sequence); unschedule(call.timer);
    if (!live || peer.connected !== true) { call.reject(unknown()); return; }
    // A busy event loop can deliver IPC before an already-due timer callback.
    // The timer bounds waiting; elapsed time independently bounds acceptance.
    const elapsed = monotonic() - call.started;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= call.timeoutMs) {
      call.reject(unknown());
      if (call.op === 'reserve') { expireReservation(value.sequence); cancelLateReservation(value); }
      return;
    }
    if (value.ok !== true) { call.reject(failure(value.code || 'AGENT_RESOURCE_UNKNOWN', value.message || unknown().message)); return; }
    call.resolve(value);
  }
  peer.on('message', message);
  peer.once('disconnect', closed);
  function request(op, fields = {}, timeoutMs = requestMs) {
    if (!live || peer.connected !== true || typeof peer.send !== 'function') return Promise.reject(unknown());
    if (['reserve', 'hello'].includes(op) && pending.size >= MAX_PENDING) return Promise.reject(failure('RESOURCE_CHANNEL_BUSY', 'The resource channel has too much work in flight. Retry this lane shortly.'));
    const started = monotonic();
    if (!Number.isFinite(started) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(unknown());
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = schedule(() => {
        pending.delete(id);
        if (op === 'reserve') expireReservation(id);
        reject(unknown());
      }, timeoutMs);
      timer?.unref?.();
      pending.set(id, { resolve, reject, timer, op, started, timeoutMs });
      send(peer, { channel: CHANNEL, type: 'request', sequence: id, op, ...(bootId ? { bootId } : {}), ...fields }, () => {
        const call = pending.get(id);
        if (call) { pending.delete(id); unschedule(timer); reject(unknown()); }
        closed();
      });
    });
  }
  function connect() {
    if (!connecting) connecting = request('hello').then(value => {
      if (typeof value.bootId !== 'string' || value.bootId.length < 1 || value.bootId.length > 100) throw unknown();
      bootId = value.bootId;
      return Object.freeze({ bootId });
    });
    return connecting;
  }
  async function reserveLane(requested, principal) {
    if (!exact(requested, ['provider']) || !principalValid(principal)) throw failure('RESOURCE_LAUNCH_CALLER_REQUIRED', 'The work-lane caller was not authenticated.');
    await connect();
    // Authority epoch timestamps are comparable only with each other, not the
    // service's wall clock. Charge the entire request round trip against its
    // bounded lifetime, conservatively starting before the app receives it.
    const requestedAtMono = monotonic();
    if (!Number.isFinite(requestedAtMono)) throw unknown();
    const grant = await request('reserve', { provider: requested.provider, principal });
    if (grant.bootId !== bootId || typeof grant.grantId !== 'string' || !Number.isFinite(grant.issuedAtMs)
      || !Number.isFinite(grant.expiresAtMs) || grant.expiresAtMs <= grant.issuedAtMs
      || grant.expiresAtMs - grant.issuedAtMs > GRANT_MS) throw unknown();
    let state = 'reserved';
    let child = null;
    let childClosed = false;
    let jobEmpty = true;
    let releaseRequested = false;
    let rootChecked = false;
    let rootPreparing = false;
    let rootPrepared = false;
    let expiresAtMs = grant.expiresAtMs;
    const notify = op => { void request(op, { grantId: grant.grantId }).catch(() => {}); };
    function cancel() {
      if (state !== 'reserved' && state !== 'consumed') return;
      state = 'released'; notify('cancel');
    }
    function release() {
      if (state === 'released') return;
      if (!child) { cancel(); return; }
      releaseRequested = true;
      if (!childClosed || !jobEmpty) return;
      state = 'released'; notify('closed');
    }
    function assertCurrent() {
      const elapsed = monotonic() - requestedAtMono;
      if (!live || peer.connected !== true || !Number.isFinite(elapsed) || elapsed < 0
        || elapsed >= Math.min(GRANT_MS, expiresAtMs - grant.issuedAtMs)) {
        throw failure('AGENT_RESOURCE_GRANT_EXPIRED', 'The resource grant expired or its application disconnected before this lane could start. Retry with a fresh measurement.');
      }
    }
    return Object.freeze({
      admission: Object.freeze({ ...grant.admission }),
      beforeSpawn() {
        if (state !== 'reserved') throw failure('RESOURCE_CHANNEL_GRANT_USED', 'This work-lane reservation was already consumed.');
        try { assertCurrent(); } catch (error) { cancel(); throw error; }
        state = 'consumed';
      },
      async prepareRootSpawn() {
        // A direct (non-Windows) root prepares before its one synchronous
        // consumption. Windows prepares after its wrapper was consumed/spawned.
        // Either order still needs beforeSpawn followed by beforeRootSpawn;
        // preparation alone never makes a reserved grant a launched process.
        if (rootPreparing || rootChecked || !['reserved', 'consumed', 'spawned'].includes(state)) throw failure('RESOURCE_CHANNEL_GRANT_USED', 'This work-lane reservation cannot authorize another provider root.');
        rootPreparing = true;
        assertCurrent();
        const checked = await request('revalidate', { grantId: grant.grantId }, Math.min(requestMs, ROOT_CHECK_MS));
        if (checked.bootId !== bootId || !Number.isFinite(checked.expiresAtMs) || checked.expiresAtMs > expiresAtMs) throw unknown();
        expiresAtMs = checked.expiresAtMs;
        assertCurrent();
        rootPrepared = true;
      },
      beforeRootSpawn() {
        if (rootChecked || !['consumed', 'spawned'].includes(state)) throw failure('RESOURCE_CHANNEL_GRANT_USED', 'This work-lane reservation cannot authorize another provider root.');
        if (!rootPrepared) throw failure('AGENT_RESOURCE_PREPARATION_REQUIRED', 'The provider root needs its final application resource check.');
        // No second debit and no fresh deadline: a living wrapper is not proof
        // that the original grant still permits its provider root to begin.
        // Refusal here must wait for observed wrapper/job cleanup to release.
        assertCurrent();
        rootChecked = true;
      },
      spawned(value) {
        if (state !== 'consumed' || child || !value || typeof value.once !== 'function') throw unknown();
        child = value; state = 'spawned'; notify('spawned');
        // A Windows wrapper close with an unproven job outcome is NOT a
        // receipt that the provider and descendants reached zero processes.
        if (child.jobOutcome && typeof child.jobOutcome.then === 'function') {
          jobEmpty = false;
          Promise.resolve(child.jobOutcome).then(outcome => {
            jobEmpty = outcome?.activeProcesses === 0;
            if (releaseRequested) release();
          }, () => {});
        }
        child.once('close', () => { childClosed = true; release(); });
      },
      ready() { if (state === 'spawned') { state = 'ready'; notify('ready'); } },
      release,
    });
  }
  return Object.freeze({ connect, reserveLane, close() {
    closed();
    peer.off('message', message);
    peer.off('disconnect', closed);
    // Other protocols can share this peer. Only the process owner may close
    // the underlying IPC descriptor; releasing this client is not that proof.
  } });
}

module.exports = Object.freeze({ CHANNEL, GRANT_MS, REQUEST_MS, ROOT_CHECK_MS, attachResourceAuthority, createResourceClient });
