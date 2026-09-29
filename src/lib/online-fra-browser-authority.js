'use strict';

const { performance } = require('node:perf_hooks');
const { peerPublicKeyFromWire } = require('./online-fra-device-identity');

// This grant is independent of both the relay's admission and the crypto lease.
// Machine polling never counts as browser activity at the account service.
const MAX_AUTHORITY_AGE_MS = 30_000;
const AUTHORITY_TIMEOUT_MS = 5_000;
const MAX_INTRODUCTION_BYTES = 16 * 1024;
const MAX_TRANSPORT_REMAINING_MS = 15 * 60_000;
// The signed E2E hello protocol already requires clocks within this tolerance.
const MAX_ACCOUNT_CLOCK_SKEW_MS = 5_000;
// Internal-only hook. No tunnel field or forwarded header can create it.
const BROWSER_DISPATCH_GUARD = Symbol('browser dispatch authorization');

async function readIntroduction(response, signal) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        if (signal.aborted) throw new Error('cancelled');
        const next = await reader.read();
        if (signal.aborted) throw new Error('cancelled');
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_INTRODUCTION_BYTES) { cancel(); throw new Error('too large'); }
        chunks.push(Buffer.from(next.value));
      }
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } finally {
      signal.removeEventListener('abort', cancel);
      try { reader.releaseLock(); } catch {}
    }
  }
  // Response-like injected test adapters may expose only json(). Their return
  // value still must fit the same wire bound; production uses the stream above.
  const body = await response.json();
  if (signal.aborted || Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_INTRODUCTION_BYTES) throw new Error('invalid body');
  return body;
}

function createBrowserAuthority({ load, clock = () => Date.now(), monotonicClock = () => performance.now(),
  maxAgeMs = MAX_AUTHORITY_AGE_MS, timeoutMs = AUTHORITY_TIMEOUT_MS, retryMs = 5_000,
  onInvalidated = () => {}, onRefused = () => {} } = {}) {
  if (typeof load !== 'function' || typeof clock !== 'function' || typeof monotonicClock !== 'function'
    || typeof onInvalidated !== 'function' || typeof onRefused !== 'function'
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > MAX_AUTHORITY_AGE_MS
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AUTHORITY_TIMEOUT_MS
    || !Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 30_000) throw new TypeError('Invalid browser authority options.');
  let peer = null;
  let grant = null;
  let epoch = 0;
  let closed = false;
  let flight = null;
  let controller = null;
  let refusal = null;
  let refusedAt = null;
  let observation = null;

  function sample() {
    const wall = clock(); const mono = monotonicClock();
    return Number.isSafeInteger(wall) && wall > 0 && Number.isFinite(mono) && mono >= 0 ? { wall, mono } : null;
  }
  function elapsed(start) {
    const at = sample();
    // A monotonic rollback is invalid. A wall rollback cannot extend authority;
    // a forward wall jump also counts, including time spent suspended.
    return at && at.mono >= start.mono ? Math.max(at.mono - start.mono, at.wall - start.wall) : Infinity;
  }
  function fresh() { return !closed && peer !== null && grant !== null && elapsed(grant.start) < grant.budget; }
  function same(identity) {
    return !closed && identity && peer && identity.epoch === epoch
      && identity.webDeviceId === peer.webDeviceId && identity.ed25519PublicKey === peer.ed25519PublicKey;
  }
  function check(identity) { return Boolean(same(identity) && fresh()); }
  function capture(webDeviceId) {
    return fresh() && peer.webDeviceId === webDeviceId
      ? Object.freeze({ epoch, webDeviceId: peer.webDeviceId, ed25519PublicKey: peer.ed25519PublicKey }) : null;
  }
  function invalidate(reason) {
    const previous = peer && Object.freeze({ epoch, webDeviceId: peer.webDeviceId, ed25519PublicKey: peer.ed25519PublicKey });
    peer = null; grant = null; epoch += 1;
    if (previous) onInvalidated(previous, reason);
  }
  function refuse(reason, status = null) {
    refusedAt = sample(); refusal = reason;
    onRefused(reason, status);
    return { webPeer: null, reason };
  }
  function parse(body, start) {
    const value = body && body.webPeer;
    if (!value || typeof value.webDeviceId !== 'string' || !/^web-[A-Za-z0-9_-]{1,128}$/.test(value.webDeviceId)) return null;
    const { expiresAtMs, authorizationExpiresAtMs, authorizationCheckedAtMs } = value;
    const received = sample();
    if (!received || ![expiresAtMs, authorizationExpiresAtMs, authorizationCheckedAtMs].every(n => Number.isSafeInteger(n) && n > 0)
      || authorizationExpiresAtMs > expiresAtMs || authorizationExpiresAtMs <= authorizationCheckedAtMs
      || authorizationExpiresAtMs <= received.wall
      || authorizationCheckedAtMs < start.wall - MAX_ACCOUNT_CLOCK_SKEW_MS
      || authorizationCheckedAtMs > received.wall + MAX_ACCOUNT_CLOCK_SKEW_MS
      || expiresAtMs - authorizationCheckedAtMs > MAX_TRANSPORT_REMAINING_MS) return null;
    let peerPublicKey;
    try { peerPublicKey = peerPublicKeyFromWire(value.ed25519PublicKey); } catch { return null; }
    // Count the oldest plausible age of the server's observation. Re-reading
    // an old body, even inside the skew tolerance, must not move its deadline.
    // Synchronized clocks therefore normally refresh at about 25 seconds;
    // thirty seconds is the worst allowed bound, not a promised cache lifetime.
    if (observation && authorizationCheckedAtMs < observation.checkedAtMs) return null;
    const priorElapsed = observation
      ? start.mono >= observation.start.mono
        ? Math.max(start.mono - observation.start.mono, start.wall - observation.start.wall) : Infinity
      : 0;
    // Keep the server observation anchored even when the wall clock rolls back
    // between refreshes. Equal/older bodies cannot create a new monotonic lease;
    // a slightly newer timestamp earns only that much progress, not a reset.
    const anchoredAge = observation
      ? observation.ageAtStart + priorElapsed - (authorizationCheckedAtMs - observation.checkedAtMs) : 0;
    const observedAge = Math.max(0, start.wall - authorizationCheckedAtMs + MAX_ACCOUNT_CLOCK_SKEW_MS, anchoredAge);
    const budget = Math.min(maxAgeMs, authorizationExpiresAtMs - authorizationCheckedAtMs) - observedAge;
    if (elapsed(start) >= budget) return null;
    return { peer: Object.freeze({ webDeviceId: value.webDeviceId, ed25519PublicKey: value.ed25519PublicKey,
      peerPublicKey, expiresAtMs, authorizationExpiresAtMs, authorizationCheckedAtMs }), grant: { start, budget },
      observation: { checkedAtMs: authorizationCheckedAtMs, start, ageAtStart: observedAge } };
  }
  async function refresh() {
    const start = sample();
    if (!start) { invalidate('web-peer-malformed'); return refuse('web-peer-malformed'); }
    const aborter = new AbortController(); controller = aborter;
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => { aborter.abort(); reject(new Error('timeout')); }, timeoutMs);
      if (timer.unref) timer.unref();
    });
    try {
      // No authority changes occur inside this async operation. A loader that
      // ignores abort and resolves after the race has ended cannot revive it.
      const result = await Promise.race([(async () => {
        const response = await load(aborter.signal);
        if (aborter.signal.aborted) throw new Error('cancelled');
        if (!response || response.status !== 200) return { response, body: null };
        let body;
        try { body = await readIntroduction(response, aborter.signal); }
        catch { return { response, body: null }; }
        return { response, body };
      })(), deadline]);
      if (closed || aborter.signal.aborted) return { webPeer: null, reason: 'web-peer-unavailable' };
      if (!result.response || result.response.status !== 200) {
        invalidate('web-not-introduced');
        return refuse('web-not-introduced', Number.isInteger(result.response?.status) ? result.response.status : null);
      }
      const parsed = parse(result.body, start);
      if (!parsed) { invalidate('web-peer-malformed'); return refuse('web-peer-malformed'); }
      if (peer && (peer.webDeviceId !== parsed.peer.webDeviceId || peer.ed25519PublicKey !== parsed.peer.ed25519PublicKey)) invalidate('web-peer-changed');
      peer = parsed.peer; grant = parsed.grant; observation = parsed.observation; refusal = null; refusedAt = null;
      return { webPeer: peer };
    } catch {
      if (!closed) { invalidate('web-peer-unavailable'); return refuse('web-peer-unavailable'); }
      return { webPeer: null, reason: 'web-peer-unavailable' };
    } finally {
      clearTimeout(timer);
      if (controller === aborter) controller = null;
    }
  }
  async function resolve(webDeviceId) {
    if (closed) return { webPeer: null, reason: 'web-peer-unavailable' };
    if (fresh() && peer.webDeviceId === webDeviceId) return { webPeer: peer };
    if (!flight && refusedAt && elapsed(refusedAt) < retryMs) return { webPeer: null, reason: refusal || 'web-peer-cooldown' };
    if (!flight) flight = refresh().finally(() => { flight = null; });
    const result = await flight;
    if (!result.webPeer) return result;
    if (!fresh()) return refuse('web-peer-malformed');
    if (peer.webDeviceId !== webDeviceId) return refuse('web-peer-mismatch');
    return { webPeer: peer };
  }
  async function ensure(identity) {
    if (!same(identity)) return false;
    if (!fresh()) await resolve(identity.webDeviceId);
    return check(identity);
  }
  function close() {
    if (closed) return;
    closed = true;
    if (controller) controller.abort();
    invalidate('web-peer-unavailable');
  }
  return Object.freeze({ resolve, capture, check, same: identity => Boolean(same(identity)), ensure, close });
}

module.exports = Object.freeze({ createBrowserAuthority, BROWSER_DISPATCH_GUARD,
  MAX_AUTHORITY_AGE_MS, AUTHORITY_TIMEOUT_MS, MAX_INTRODUCTION_BYTES });
