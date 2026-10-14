'use strict';

// ROTATION IS THE PROGRAM'S JOB, NOT AN OPERATOR'S.
//
// There are two separate things that can change about a peer link, and conflating
// them is how rotation schemes break.
//
//   1. THE EPOCH -- the live secret advances on a clock. This needs no watcher,
//      no vault read, no network round trip, and no human: both machines compute
//      the same value from `linkSecretFor` whenever they need it. See
//      `src/lib/peer-enrollment.js`. Nothing in this file is required for it to
//      work, which is exactly why it cannot fail.
//
//   2. THE IDENTITY KEY -- this installation's long-term X25519 private key,
//      held in the DPAPI vault. If it is replaced (a restore, a deliberate
//      re-key, a corrupted write), every peer link changes at once. THAT is what
//      this file watches, and it is dangerous in precisely the way the FRA bridge
//      already learned the hard way.
//
// THE TORN-READ RULE, INHERITED RATHER THAN REINVENTED.
//
// `src/full-remote-access-bridge.js` (~line 1348) established the discipline
// after a real incident, and `src/remote-agent-bridge.js` follows it. This file
// is the fourth implementation and deliberately looks like the first three:
//
//   * A vault FINGERPRINT (an mtime+size stat) gates the expensive read. The
//     default identity read shells out to powershell.exe to decrypt DPAPI; at a
//     2s poll that is ~43,000 process creations per day on an idle machine,
//     which was measured on the owner's machine as a standing CPU cost.
//   * A NULL fingerprint means "I could not look", NEVER "nothing changed", and
//     always falls through to a real read.
//   * TWO CONSECUTIVE AGREEING READS are required before any rotation is
//     committed. A single differing read -- a torn decrypt, a concurrent
//     legitimate write, a file lock -- must not tear down every live peer.
//   * An ERROR CLEARS THE CANDIDATE, so a A -> error -> A sequence cannot be
//     mistaken for two agreeing reads.
//   * While a candidate is pending the fingerprint gate is bypassed, so the
//     confirming read actually happens on the next tick.
//
// AND ONE RULE THE OTHERS DID NOT NEED: ABSENCE COSTS NOTHING.
//
// A machine with no paired computers does not start a timer, does not read the
// vault, and does not spawn anything -- ever. The single-machine install, which
// is the common case, pays exactly zero for a feature it is not using, and sees
// no prompt and no error. `start()` on a peerless registry returns a valid,
// inert watcher that reports `watching: false`. That is a normal state, not a
// failure to configure something.

const DEFAULT_POLL_INTERVAL_MS = 2000;

const { hasEnrolledPeers } = require('./peer-enrollment');

/**
 * @param {object} options
 * @param {() => object} options.loadRegistry        re-read the peer registry
 * @param {() => string} options.readIdentityKey     read the identity private key (wire form)
 * @param {() => (string|null)} [options.vaultFingerprint] cheap change detector; null = "could not look"
 * @param {(event: object) => void} [options.onRotated]   called once per COMMITTED identity change
 * @param {(event: object) => void} [options.onRefused]   called when a read fails or is refused
 */
function createPeerLinkRotator(options = {}) {
  const loadRegistry = typeof options.loadRegistry === 'function' ? options.loadRegistry : null;
  const readIdentityKey = typeof options.readIdentityKey === 'function' ? options.readIdentityKey : null;
  if (loadRegistry === null || readIdentityKey === null) {
    throw new Error('A peer link rotator needs loadRegistry and readIdentityKey.');
  }
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0
    ? options.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;
  const onRotated = typeof options.onRotated === 'function' ? options.onRotated : () => {};
  const onRefused = typeof options.onRefused === 'function' ? options.onRefused : () => {};
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;

  // Lazily resolved so a peerless installation never loads the vault module at
  // all, and so tests can drive the detector deterministically instead of racing
  // a real file's mtime granularity.
  const fingerprintOf = typeof options.vaultFingerprint === 'function'
    ? options.vaultFingerprint
    // eslint-disable-next-line global-require
    : () => require('./runtime').vaultFingerprint();

  const state = {
    watching: false,
    generation: 0,
    reads: 0,
    skippedByFingerprint: 0,
    candidatePending: false,
    refusals: 0,
    lastRefusalCode: null,
    lastRotatedAtMs: null,
    // Null means the registry has not been measured (or its latest read failed).
    // Do not report a definite zero when peer presence could not be established.
    peerCount: null
  };

  let timer = null;
  let currentKey = null;
  let candidate = null;
  let lastFingerprint = null;

  const clearCandidate = () => {
    candidate = null;
    state.candidatePending = false;
  };

  const refuse = (code, detail) => {
    state.refusals += 1;
    state.lastRefusalCode = code;
    // Any failed read breaks consecutiveness. Keeping the prior candidate here
    // would let A -> error -> A commit a rotation off a single real read.
    clearCandidate();
    onRefused({ code, detail: detail || null });
  };

  function tick(nowMs = Date.now()) {
    let registry;
    try {
      registry = loadRegistry();
    } catch (error) {
      state.peerCount = null;
      refuse('PEER_LINK_REGISTRY_UNREADABLE', error && error.code);
      return;
    }
    if (!registry || !Array.isArray(registry.peers)) {
      state.peerCount = null;
      refuse('PEER_LINK_REGISTRY_UNREADABLE', 'invalid');
      return;
    }
    state.peerCount = registry.peers.filter(peer => peer.revoked !== true).length;
    // Every peer may have been revoked since the last tick. With nobody left to
    // protect there is nothing to rotate, and reading the vault would be pure
    // cost -- so stop reading, but keep the watcher alive so a later enrollment
    // resumes without a restart.
    if (!hasEnrolledPeers(registry)) {
      clearCandidate();
      return;
    }

    if (typeof fingerprintOf === 'function') {
      let fingerprint = null;
      try {
        fingerprint = fingerprintOf();
      } catch {
        fingerprint = null; // "could not look" -- fall through to a real read.
      }
      // The `!candidate` clause is load-bearing: once a change has been seen the
      // gate must stop suppressing reads, or the confirming second read would
      // never happen and a genuine rotation would hang pending forever.
      if (fingerprint !== null && fingerprint === lastFingerprint && !candidate) {
        state.skippedByFingerprint += 1;
        return;
      }
      lastFingerprint = fingerprint;
    }

    let latest;
    try {
      latest = readIdentityKey();
    } catch (error) {
      refuse('PEER_LINK_IDENTITY_UNAVAILABLE', error && error.code);
      return;
    }
    // An unreadable vault must refuse, never be read as "the key is now empty".
    // Treating absence as a value here would rotate every peer onto a key that
    // does not exist.
    if (typeof latest !== 'string' || latest === '') {
      refuse('PEER_LINK_IDENTITY_UNAVAILABLE', 'empty');
      return;
    }
    state.reads += 1;

    if (currentKey === null) {
      // First successful read establishes the baseline; it is not a rotation.
      currentKey = latest;
      clearCandidate();
      return;
    }
    if (latest === currentKey) {
      clearCandidate();
      return;
    }
    if (candidate === null || candidate !== latest) {
      candidate = latest;
      state.candidatePending = true;
      return;
    }

    // Two consecutive reads agreed on the same replacement. Commit.
    const previous = currentKey;
    currentKey = candidate;
    clearCandidate();
    state.generation += 1;
    state.lastRotatedAtMs = nowMs;
    onRotated({
      generation: state.generation,
      atMs: nowMs,
      // Never the key values themselves -- only that they differed.
      changed: previous !== currentKey,
      peerCount: state.peerCount
    });
  }

  function start() {
    if (timer !== null) return api;
    let registry;
    try {
      registry = loadRegistry();
    } catch (error) {
      state.peerCount = null;
      refuse('PEER_LINK_REGISTRY_UNREADABLE', error && error.code);
      return api;
    }
    if (!registry || !Array.isArray(registry.peers)) {
      state.peerCount = null;
      refuse('PEER_LINK_REGISTRY_UNREADABLE', 'invalid');
      return api;
    }
    state.peerCount = registry.peers.filter(peer => peer.revoked !== true).length;
    // THE SINGLE-MACHINE PATH. No peers means no timer, no vault read, no
    // process spawn, and no prompt -- not now and not on any later tick. This is
    // the common case and it must cost nothing at all.
    if (!hasEnrolledPeers(registry)) {
      state.watching = false;
      return api;
    }
    state.watching = true;
    timer = setIntervalFn(() => tick(), pollIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return api;
  }

  function stop() {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
    state.watching = false;
    clearCandidate();
    currentKey = null;
    return api;
  }

  const api = Object.freeze({
    start,
    stop,
    tick,
    status: () => Object.freeze({ ...state, pollIntervalMs })
  });
  return api;
}

module.exports = Object.freeze({ createPeerLinkRotator, DEFAULT_POLL_INTERVAL_MS });
