#!/usr/bin/env node
'use strict';

// Always-on FRA outbound liveness heartbeat.
//
// One bounded, real secure round trip per invocation: the same
// challenge/response handshake and transport-binding validation every other
// FRA client uses (via RemoteAgentMcpProxy / createFullRemoteAccessProxy --
// this file adds no cryptography of its own), followed by MCP `initialize`,
// `tools/list`, and one tiny read-only `tools/call`. Its only job is to keep
// RemoteAgentMcpProxy._connect() firing on a schedule well inside the
// 600-second peer-receipt/liveness freshness bound enforced by
// tools/full-remote-access-control.ps1, so
// state/full-remote-access-peer-liveness.json never goes stale. It is meant
// to be invoked repeatedly (every couple of minutes) by
// tools/full-remote-access-lifecycle.ps1's Reconcile loop, not run as a
// long-lived process.
//
// Every result is an allowlisted projection: no token, response body,
// receipt content, or filesystem path is ever printed. Exits 0 on a
// verified round trip, 1 otherwise -- the caller is expected to apply its
// own backoff on repeated failure rather than treat this as a hard gate.
//
// RELIABILITY LAYER (2026-08-04). Real production A<->B probes tonight (two
// independent measuring agents, cross-checked, plus a 100-handshake
// statistical sample from A's own inbound server log) measured successful
// round trips of 77-211s, and isolated FOUR failures: two hit the OLD
// ~240s TOTAL_TIMEOUT_MS outright, and two were independent connection-
// closed failures at ~53s and ~149.6s. The 149.6s failure was correlated
// against B's own state/full-remote-access.log for that exact window: the
// server logged "session authorization audit failed ... reason=
// AUDIT_UNAVAILABLE" immediately followed by "session closed ...
// reason=FRA_AUDIT_UNAVAILABLE" -- i.e. the client-visible generic
// CONNECTION_CLOSED's real root cause was the SERVER's own required
// audit-admission write (src/full-remote-access-bridge.js) failing and the
// server deliberately closing the session -- NOT a network blip. Preserve
// that distinction in any telemetry/log text touching this class of
// failure; see RETRYABLE_TRANSPORT_CODES below for why it is still
// transport-retry-eligible from THIS client's vantage point regardless.
//
// The slowness itself is caused by audit.js's flushInternal() doing a full
// O(N) re-parse/re-projection over the ~28,000+-event ledger, synchronously,
// on every audit.record call -- and the FRA handshake calls it twice before
// the client even reaches MCP. That is OUT OF SCOPE here and is not touched
// by this file (audit.js is untouched). This layer only adapts the
// heartbeat's OWN timeouts, retry, and telemetry to tolerate that reality.

const { performance } = require('node:perf_hooks');
const { getSecret, rootPath } = require('../src/lib/runtime');
const { declaredPort, directionalMachinePair, loadRegistry } = require('../src/lib/service-registry');
const {
  FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY,
  createFullRemoteAccessProxy,
  loadFraCapabilityProfile
} = require('./remote-agent-mcp-proxy');

// Single source of truth for cross-machine addresses/roots (R1212): read
// through src/lib/service-registry.js. Lower-address coordinator and
// higher-address recipient are stable protocol directions independent of the
// customer-selected machine ids. HOST_A/HOST_B remain compatibility aliases.
//
// Resolve on use, not require(). A fresh customer install deliberately ships
// with only its local machine; requiring the heartbeat from the keeper must not
// make that otherwise-valid one-machine state crash before enrollment can add
// the sole peer. The actual probe/CLI still fails closed unless exactly two
// validated machines exist.
function resolveHeartbeatTopology(serviceRegistryOptions = {}) {
  const registry = loadRegistry(serviceRegistryOptions);
  const pair = directionalMachinePair({ registry });
  return Object.freeze({
    machineA: pair.coordinatorMachine,
    machineB: pair.recipientMachine,
    hostA: pair.coordinatorMachine.address,
    hostB: pair.recipientMachine.address,
    // Declared in the same successfully loaded snapshot; 8790 is only the
    // compatibility fallback when that valid registry omits the service port.
    fraPort: declaredPort('full-remote-access', 8790, { registry })
  });
}
const SAFE_CODE = /^[A-Z0-9_.-]{1,100}$/;
// system.status was measured under real production audit load and hung
// past 300s before being killed. system.kill_switch_status is cheap,
// read-only, present in both hosts' FRA allowlists
// (config/fra-capability-manifest.<machine-id>.json, one per machine declared
// in config/service-registry.json), and was measured
// reliably completing in 15-32s across multiple samples under the same
// load -- it exercises the bound request/response envelope without
// touching desktop, filesystem, or process state.
const READ_ONLY_TOOL = 'system.kill_switch_status';
// This is applied PER FRAME/REQUEST (see the comment below), which includes
// waiting for the FRA server's `fra.authorized` frame -- sent only after the
// server's own synchronous, anchor-verifying required audit-admission write
// completes (src/full-remote-access-bridge.js's FRA_HANDSHAKE_DEADLINE_MS,
// 120s -- UNCHANGED by tonight's recalibration: the 100-handshake sample's
// p90/max on both measured server-side gaps, 32.3s/72.1s authorization-audit
// and 25.2s/60.4s binding, stay well under it even at the tail, and B's one
// real production failure, ~79.3s, was also still under it; nothing in the
// new stage-level client telemetry below shows a single frame genuinely
// needing more). This client-side wait MUST exceed that server deadline with
// real margin, or this client gives up with a generic REMOTE_BRIDGE_HANDSHAKE_
// TIMEOUT before the server's own, more specific FRA_HANDSHAKE_TIMEOUT
// decision is even made -- the innermost, most-specific timeout must fire
// first. 135s is FRA_HANDSHAKE_DEADLINE_MS with the same +12.5% margin as
// before -- also UNCHANGED tonight: it already has real margin over (a) and
// nothing in the measured data justifies moving it.
const DEFAULT_TIMEOUT_MS = 135_000;
// timeoutMs above is applied PER FRAME/REQUEST by RemoteAgentMcpProxy, not
// cumulatively -- the multi-frame secure handshake plus initialize, tools/list,
// and the read-only call could otherwise each wait up to timeoutMs and
// collectively approach the 600s/10min freshness bound this heartbeat exists
// to protect. TOTAL_TIMEOUT_MS bounds the ENTIRE probe -- now BOTH attempts
// combined (original + the one retry; see RETRYABLE_TRANSPORT_CODES /
// heartbeat() below), not just one -- with a single deadline, independent of
// how many frames it takes.
//
// RAISED tonight from 240s to 420s, peer-reviewed against the measured data
// above: worst-case first-attempt transient close observed in production
// (149.6s) + worst observed SUCCESSFUL retry attempt (211s) = 360.6s,
// leaving ~59s of real margin inside 420s. This number changed because it
// now has to cover two attempts, not because any single frame got slower.
//
// Freshness-bound check: a scheduled successful probe begins within roughly
// 120s of the prior one, per the lifecycle's own 2-minute reconcile cadence
// (tools/full-remote-access-lifecycle.ps1). 120s (worst-case next-cycle
// start delay) + 420s (this cycle's own worst-case whole-probe budget) =
// 540s, which stays under the 600-second peer-receipt/liveness freshness
// bound (tools/full-remote-access-control.ps1 / this file's own header
// comment above) with 60s of real margin.
//
// Still comfortably above DEFAULT_TIMEOUT_MS above, which remains the
// largest single wait either attempt can hit. Raising DEFAULT_TIMEOUT_MS
// without checking this relationship is exactly the kind of inversion that
// made Invoke-PeerHeartbeat's own outer kill deadline race this file's total
// deadline before it was fixed (see the drain-timeout-fix commit this stack
// builds on) -- if DEFAULT_TIMEOUT_MS ever changes, re-check
// tools/full-remote-access-lifecycle.ps1's Invoke-PeerHeartbeat wrapper
// deadline (450s as of tonight, see that file) too; it must still
// comfortably exceed this.
const TOTAL_TIMEOUT_MS = 420_000;

// Small fixed allowlist for the new `stage` telemetry field (required
// change 1): exactly the real steps a single attempt takes, in order.
// Tracked with a variable updated immediately before each awaited step (see
// runHeartbeatAttempt below) -- never a response body, path, credential, or
// session id.
const STAGES = Object.freeze(['connect', 'initialize', 'tools_list', 'read_only_call', 'liveness_write']);
const STAGE_SET = new Set(STAGES);

// Verified 2026-08-04 by grepping tools/remote-agent-mcp-proxy.js directly:
// all six of these exist there VERBATIM as the codes a TRANSPORT-layer
// failure -- a dead socket, a refused/reset connection, or the connection
// simply closing -- can surface --
//   REMOTE_BRIDGE_CONNECT_TIMEOUT    connectTcp()'s own connect timer
//   REMOTE_BRIDGE_CONNECT_FAILED     connectTcp()'s 'error' handler, non-ECONNREFUSED
//   REMOTE_BRIDGE_REFUSED            connectTcp()'s 'error' handler, ECONNREFUSED
//   REMOTE_BRIDGE_RESET              the live socket's 'error' handler, ECONNRESET
//   REMOTE_BRIDGE_SOCKET_ERROR       the live socket's 'error' handler, anything else
//   REMOTE_BRIDGE_CONNECTION_CLOSED  the socket's 'close' handler, and _finishWaiters()'s own default
// No mapping was needed -- the owner-specified six names matched the real
// defined codes exactly.
//
// WHAT THIS SET GENUINELY MEANS -- CORRECTED 2026-08-04. An earlier version
// of this comment claimed these six codes are "never an authenticated-but-
// rejected session" and that retrying them "never masks a genuine
// application/policy rejection." That claim was false, and this file's own
// header comment above proves it: the measured 149.6s production failure
// surfaced to this client as REMOTE_BRIDGE_CONNECTION_CLOSED, and
// correlating B's own state/full-remote-access.log for that exact window
// showed the real cause was the SERVER's required audit-admission write
// failing and the server deliberately closing the session in response -- a
// genuine server-side rejection decision, not a transport-layer accident,
// wearing a generic transport-close code.
//
// The honest position: the underlying cause of a generic transport close is
// FUNDAMENTALLY UNKNOWABLE to this client. Every one of these six codes
// could mean an ordinary network blip (a dropped packet, a busy NIC, a
// mid-handshake hiccup), or it could mean a server-side rejection or
// failure that merely PRESENTS as a closed socket -- exactly like the
// production case above. This client only ever sees a dead socket, never
// the server's internal reason. Retrying once cannot make that diagnosis
// any worse than it already is: it either recovers a session that was
// really just contending with a slow-but-inside-budget server, or it fails
// again and the client reports the same class of failure it always would
// have.
//
// What IS excluded, and therefore truly never retried, are codes the
// client CAN affirmatively identify as an explicit authenticated rejection
// or a specific application-level answer -- those are distinguishable
// precisely because the server DID respond with a specific decision,
// rather than just dropping the connection:
//
// NEVER retryable, by deliberate exclusion from this set:
//   - any authentication/authorization/binding/policy/capability-manifest-
//     rejection code (e.g. REMOTE_BRIDGE_TOKEN_INVALID,
//     REMOTE_BRIDGE_PEER_MISMATCH, REMOTE_BRIDGE_CAPABILITY_MISMATCH,
//     REMOTE_BRIDGE_DEVICE_CONTINUITY_MISMATCH) -- a rejection is a real
//     decision, not a transient transport hiccup; retrying it would just
//     repeat the same rejection while burning budget.
//   - any application-level MCP failure -- FRA_HEARTBEAT_INITIALIZE_FAILED/
//     _INVALID, FRA_HEARTBEAT_TOOLS_LIST_FAILED,
//     FRA_HEARTBEAT_READ_ONLY_TOOL_UNAVAILABLE,
//     FRA_HEARTBEAT_READ_ONLY_CALL_FAILED -- the transport worked, the
//     server actually answered, and the answer itself was bad; retrying
//     cannot fix that.
//   - FRA_HEARTBEAT_TIMEOUT, the whole-probe deadline itself (see the
//     remaining-budget heuristic in heartbeat() below) -- a real timeout
//     means the budget is already gone, so retrying cannot help and only
//     obscures the failure.
const RETRYABLE_TRANSPORT_CODES = new Set([
  'REMOTE_BRIDGE_CONNECTION_CLOSED',
  'REMOTE_BRIDGE_CONNECT_TIMEOUT',
  'REMOTE_BRIDGE_CONNECT_FAILED',
  'REMOTE_BRIDGE_REFUSED',
  'REMOTE_BRIDGE_RESET',
  'REMOTE_BRIDGE_SOCKET_ERROR'
]);

// Remaining-budget heuristic for the single retry (required change 3). The
// fastest FULLY SUCCESSFUL round trip measured in production tonight was
// 77s; below that, a retry attempt has essentially no realistic chance of
// completing a genuine round trip before the shared TOTAL_TIMEOUT_MS
// deadline (change 2c) cuts it off anyway, so attempting it would only
// guarantee an FRA_HEARTBEAT_TIMEOUT instead of promptly surfacing the real
// first-attempt failure code. 90s keeps a small margin above that
// fastest-observed-success floor while staying well under the
// worst-observed-success ceiling (211s), so a retry is skipped only when it
// would very likely be pointless, not merely slow. Exposed as an injectable
// heartbeat() option (same pattern as timeoutMs/totalTimeoutMs below) so it
// can be scaled down in tests without changing production behaviour.
const MIN_RETRY_REMAINING_MS = 90_000;

function fail(code) { throw Object.assign(new Error(code), { code }); }

// Strict, allowlisted success check shared by every call in the probe: a
// JSON-RPC top-level error, OR a well-formed MCP tool result with
// isError:true, both mean this call did not actually succeed -- only a
// response with neither counts. Applied uniformly to initialize, tools/list,
// and the read-only tools/call so a partially-broken application layer can
// never read as a clean heartbeat merely because the transport connected.
function isCleanResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  if (response.error !== undefined) return false;
  const result = response.result;
  if (result && typeof result === 'object' && !Array.isArray(result) && result.isError === true) return false;
  return true;
}

function peerForHost(host, serviceRegistryOptions = {}) {
  const topology = resolveHeartbeatTopology(serviceRegistryOptions);
  if (host === topology.hostB) return topology.hostA;
  if (host === topology.hostA) return topology.hostB;
  fail('FRA_HEARTBEAT_HOST_INVALID');
}

function expectedRootForHost(host, serviceRegistryOptions = {}) {
  const topology = resolveHeartbeatTopology(serviceRegistryOptions);
  if (host === topology.hostB) return topology.machineB.root;
  if (host === topology.hostA) return topology.machineA.root;
  fail('FRA_HEARTBEAT_HOST_INVALID');
}

function safeCode(error, fallback = 'FRA_HEARTBEAT_FAILED') {
  const value = error && typeof error.code === 'string' ? error.code : '';
  return SAFE_CODE.test(value) ? value : fallback;
}

// Allowlisted projection of the `stage` telemetry field: only a value from
// the fixed STAGES enum above is ever returned; anything else (there should
// never be anything else -- this is defense in depth, matching the same
// discipline safeCode() already applies to `code`) collapses to null rather
// than leaking an unexpected value.
function safeStage(value) {
  return STAGE_SET.has(value) ? value : null;
}

// Allowlisted projection of the `attempt` telemetry field: exactly 1 or 2
// (this file retries at most once -- required change 3), never anything else.
function safeAttempt(value) {
  return value === 1 || value === 2 ? value : null;
}

// Allowlisted projection of the `elapsedMs` telemetry field: a plain
// non-negative integer millisecond count, never anything else.
function safeElapsedMs(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// Allowlisted projection of a single entry of the `attemptsHistory` telemetry
// field (correction D, 2026-08-04 review round 2): reuses the exact same
// safeAttempt/safeStage/safeCode/safeElapsedMs sanitizers as every other
// field on this result -- never a second, drifting allowlist -- and returns
// EXACTLY these five keys, deep-frozen, so nothing unsafe/unexpected on the
// input entry can ever be retained.
function safeAttemptEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const ok = entry.ok === true;
  return Object.freeze({
    attempt: safeAttempt(entry.attempt),
    stage: safeStage(entry.stage),
    code: ok ? null : safeCode(entry),
    elapsedMs: safeElapsedMs(entry.elapsedMs),
    ok
  });
}

// Allowlisted, bounded (max 2, matching "at most one retry") projection of
// the whole `attemptsHistory` array: a non-array or malformed input collapses
// to an empty frozen array rather than being echoed through unsanitized.
function safeAttemptsHistory(value) {
  const sanitized = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (sanitized.length >= 2) break;
      const clean = safeAttemptEntry(entry);
      if (clean) sanitized.push(clean);
    }
  }
  return Object.freeze(sanitized);
}

// Strict, five-field allowlisted projection of a heartbeat() result, shared
// by every UNATTENDED consumer of that result (required change 3):
// tools/fra-keeper.js's own log uses this directly; PowerShell cannot
// require() it, so tools/full-remote-access-lifecycle.ps1's
// Get-SanitizedHeartbeatTelemetry is a deliberately parallel implementation
// of this exact same allowlist for its own (PowerShell) unattended path --
// see that function's own comment for why a literal shared module across
// the JS/PowerShell boundary was not practical.
//
// Reuses the same safeCode/safeStage/safeAttempt/safeElapsedMs/
// safeAttemptsHistory sanitizers heartbeat() itself already applies to build
// its own `ok:false` result -- never a second, drifting copy of the
// allowlist logic -- and returns EXACTLY these five keys (code/stage/
// attempt/elapsedMs, plus attemptsHistory as of correction D). Any other
// property on `result` (an existing field like `toolCount`/`peer`, a future
// addition, or a smuggled/unexpected one) is never read and therefore can
// never reach an unattended log or persisted state through this helper.
function sanitizeHeartbeatTelemetry(result) {
  const ok = !!(result && result.ok === true);
  return Object.freeze({
    code: ok ? null : safeCode(result || {}),
    stage: safeStage(result && result.stage),
    attempt: safeAttempt(result && result.attempt),
    elapsedMs: safeElapsedMs(result && result.elapsedMs),
    attemptsHistory: safeAttemptsHistory(result && result.attemptsHistory)
  });
}

// Runs ONE full attempt of the probe (connect through liveness-write) over a
// freshly created proxy, tracking `stage` with a variable updated
// immediately before each awaited step so a failure can report precisely
// which real step it happened at. `elapsedMs` on both the success and
// failure results below is MONOTONIC milliseconds (performance.now(), never
// Date.now() -- see the clock-source note on MIN_RETRY_REMAINING_MS's
// sibling `heartbeat()` below for why) from the START OF THIS ATTEMPT
// specifically (not the whole probe) -- a retried second attempt's
// elapsedMs describes only its own duration, matching how `attempt` scopes
// the rest of this telemetry to one specific try. performance.now() returns
// a fractional millisecond count, so every delta below is rounded to the
// nearest whole millisecond before being reported -- safeElapsedMs only
// ever accepts a plain integer.
//
// `tracker`, when supplied, is a small mutable object living in heartbeat()'s
// own scope (OUTSIDE this function's closure) that this function keeps in
// sync with its own local `stage`/`attemptNumber`/`attemptStartMs` at the
// exact same points -- required change 2: it is how the shared whole-probe
// deadline race in heartbeat() can report a real in-flight stage/attempt/
// elapsedMs on an FRA_HEARTBEAT_TIMEOUT result too, instead of always null.
async function runHeartbeatAttempt({ attemptNumber, proxy, host, peer, tracker = null }) {
  const attemptStartMs = performance.now();
  let stage = 'connect';
  const setStage = next => {
    stage = next;
    if (tracker) tracker.stage = next;
  };
  if (tracker) {
    tracker.attempt = attemptNumber;
    tracker.attemptStartMs = attemptStartMs;
    tracker.stage = stage;
  }
  let id = 1;
  try {
    await proxy.ensureConnected();
    setStage('initialize');
    const initialized = await proxy.request({
      jsonrpc: '2.0', id: id++, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {
        name: 'fra-peer-heartbeat', version: '1.0'
      } }
    });
    if (!isCleanResponse(initialized)) fail('FRA_HEARTBEAT_INITIALIZE_FAILED');
    if (initialized?.result?.serverInfo?.name !== 'toolsenabled') fail('FRA_HEARTBEAT_INITIALIZE_INVALID');
    setStage('tools_list');
    const listed = await proxy.request({ jsonrpc: '2.0', id: id++, method: 'tools/list', params: {} });
    if (!isCleanResponse(listed)) fail('FRA_HEARTBEAT_TOOLS_LIST_FAILED');
    const names = Array.isArray(listed?.result?.tools) ? listed.result.tools.map(tool => tool.name) : [];
    if (names.length === 0 || !names.includes(READ_ONLY_TOOL)) fail('FRA_HEARTBEAT_READ_ONLY_TOOL_UNAVAILABLE');
    setStage('read_only_call');
    const called = await proxy.request({
      jsonrpc: '2.0', id: id++, method: 'tools/call',
      params: { name: READ_ONLY_TOOL, arguments: {} }
    });
    if (!isCleanResponse(called)
      || !called.result || typeof called.result !== 'object' || Array.isArray(called.result)) {
      fail('FRA_HEARTBEAT_READ_ONLY_CALL_FAILED');
    }
    // The full probe (connect + initialize + tools/list + the read-only
    // call) has now completed with zero errors across all three
    // application-layer calls -- only now is it safe to advance the
    // outbound liveness artifact. This is intentionally NOT done inside
    // RemoteAgentMcpProxy._connect() itself: liveness must reflect a
    // genuinely successful application-layer round trip, not merely a
    // completed transport handshake (see remote-agent-mcp-proxy.js's
    // _writeFraPeerLiveness comment). confirmFraPeerLiveness() returns
    // whether the write actually committed -- a heartbeat that could not
    // durably advance liveness must not report ok:true, or Task Scheduler
    // could stay green forever while operational readiness stays stale.
    setStage('liveness_write');
    if (!proxy.confirmFraPeerLiveness()) fail('FRA_HEARTBEAT_LIVENESS_WRITE_FAILED');
    return Object.freeze({
      ok: true, host, peer,
      toolCount: names.length,
      readOnlyToolVerified: READ_ONLY_TOOL,
      stage, attempt: attemptNumber, elapsedMs: Math.round(performance.now() - attemptStartMs),
      secretValuesEmitted: false
    });
  } catch (error) {
    const code = safeCode(error);
    throw Object.assign(new Error(code), {
      code, stage, attempt: attemptNumber, elapsedMs: Math.round(performance.now() - attemptStartMs)
    });
  }
}

async function heartbeat({
  host, timeoutMs = DEFAULT_TIMEOUT_MS, totalTimeoutMs = TOTAL_TIMEOUT_MS,
  minRetryRemainingMs = MIN_RETRY_REMAINING_MS,
  createProxy = createFullRemoteAccessProxy,
  loadProfile = loadFraCapabilityProfile,
  loadToken = () => getSecret(FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY, { prompt: false }),
  serviceRegistryOptions = {}
} = {}) {
  const topology = resolveHeartbeatTopology(serviceRegistryOptions);
  if (host !== topology.hostA && host !== topology.hostB) fail('FRA_HEARTBEAT_HOST_INVALID');
  // Derive every field from this one validated snapshot. Re-loading between
  // host, peer, root and port would allow a concurrently replaced registry to
  // produce a mixed identity even though each individual lookup validated.
  const peer = host === topology.hostB ? topology.hostA : topology.hostB;
  const expectedPeerRoot = peer === topology.hostB ? topology.machineB.root : topology.machineA.root;
  const profile = loadProfile(peer);
  const token = loadToken();

  // ONE shared whole-probe deadline across BOTH attempts (required changes
  // 2c/3): it must bound the entire probe, not reset per attempt, or a slow
  // first attempt followed by a retry could together run past
  // totalTimeoutMs. probeStartMs (and the remaining-budget check below that
  // uses it) is MONOTONIC -- performance.now(), not Date.now() -- because
  // Date.now() can jump backward mid-probe -- CORRECTED 2026-08-04 (review
  // round 2): an earlier version of this comment named DST as a cause; that
  // was wrong. A daylight-saving transition only changes how a timestamp is
  // FORMATTED/displayed in local time -- it never moves the underlying
  // UTC-based epoch milliseconds Date.now() returns. The genuine risks are
  // an NTP correction or a manual clock change: a backward jump against a
  // wall-clock-based budget check could make minRetryRemainingMs see MORE
  // budget than genuinely remains, or a live process could see
  // totalTimeoutMs appear to have already elapsed when it has not.
  // performance.now() is monotonic within this process for exactly this
  // reason.
  const probeStartMs = performance.now();
  let deadlineTimer = null;

  // The "current attempt" tracker (required change 2): a small mutable
  // object living OUTSIDE any individual attempt's own closure, kept in
  // sync by runHeartbeatAttempt (via the `tracker` param above) at the same
  // points its own local `stage` is updated. This is what lets the shared
  // deadline race below -- the exact full-budget-exhaustion failure this
  // whole telemetry effort exists to diagnose -- report a real in-flight
  // stage/attempt/elapsedMs on an FRA_HEARTBEAT_TIMEOUT result, instead of
  // always null.
  const tracker = { attempt: null, stage: null, attemptStartMs: null };
  const deadline = new Promise((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      const elapsedMs = tracker.attemptStartMs === null
        ? null
        : Math.round(performance.now() - tracker.attemptStartMs);
      reject(Object.assign(new Error('FRA_HEARTBEAT_TIMEOUT'), {
        code: 'FRA_HEARTBEAT_TIMEOUT',
        stage: tracker.stage,
        attempt: tracker.attempt,
        elapsedMs
      }));
    }, totalTimeoutMs);
  });

  // Every proxy instance created across every attempt, so the finally block
  // below can guarantee teardown of ALL of them (required change 4)
  // regardless of which attempt (if either) actually succeeds, or how the
  // shared deadline lands relative to either attempt. This remains true
  // even after required change 7 below adds an EARLIER, explicit teardown
  // of the first attempt's proxy -- this array/loop is unconditional
  // defense in depth, not the only place teardown happens.
  const proxies = [];
  function freshProxy() {
    const created = createProxy({
      secureProfile: true,
      host: peer,
      port: topology.fraPort,
      localHost: host,
      expectedRoot: expectedPeerRoot,
      enabledValue: '1',
      timeoutMs,
      fraCapabilityProfile: profile,
      tokenLoader: () => token
    });
    proxies.push(created);
    return created;
  }

  // Refuse to call teardown successful when either teardown operation could
  // not be established. Previously both exceptions were swallowed, so a
  // proxy whose `closed` setter or `_dropSocket()` threw could still produce
  // an ok:true heartbeat and the claimed "guaranteed teardown" was only an
  // assumption. Attempt both operations, then surface a fixed, allowlisted
  // failure code without exposing the underlying exception.
  function dropProxy(proxy, code) {
    let failed = false;
    try { proxy.closed = true; } catch { failed = true; }
    try { proxy._dropSocket(Object.assign(new Error(code), { code })); } catch { failed = true; }
    if (failed) fail('FRA_HEARTBEAT_TEARDOWN_FAILED');
  }

  // Always constructs a genuinely fresh proxy via freshProxy() above -- the
  // previous attempt's proxy is dead after a transport close and is never
  // reused, satisfying required change 3's "brand-new proxy" constraint by
  // construction rather than by convention.
  //
  // Correction B (2026-08-04 review, round 2): the tracker must be primed --
  // attempt number, stage:'connect', and a monotonic start time -- BEFORE
  // createProxy() is even called, not only once runHeartbeatAttempt begins.
  // createProxy() can throw SYNCHRONOUSLY (a real, eager construction-time
  // failure -- e.g. REMOTE_BRIDGE_CONNECT_FAILED -- not merely a rejected
  // promise). Before this fix, that throw happened inside freshProxy(),
  // before ANY tracker/attempt bookkeeping existed and before
  // runHeartbeatAttempt's own try/catch (which is what normally attaches
  // stage/attempt/elapsedMs to a failure) ever ran, so the resulting failure
  // result reported attempt:null, stage:null, elapsedMs:null instead of the
  // real attempt number, stage:'connect', and a real (small) elapsed time.
  async function runAttempt(attemptNumber) {
    const attemptStartMs = performance.now();
    tracker.attempt = attemptNumber;
    tracker.attemptStartMs = attemptStartMs;
    tracker.stage = 'connect';
    let proxy;
    try {
      proxy = freshProxy();
    } catch (error) {
      const code = safeCode(error);
      throw Object.assign(new Error(code), {
        code,
        stage: 'connect',
        attempt: attemptNumber,
        elapsedMs: Math.round(performance.now() - attemptStartMs)
      });
    }
    return runHeartbeatAttempt({ attemptNumber, proxy, host, peer, tracker });
  }

  // Correction D (2026-08-04 review, round 2): a bounded, sanitized,
  // deep-frozen per-attempt summary -- max 2 entries, one per attempt this
  // probe actually made -- so a retry that RECOVERS the probe (attempt 1
  // fails, attempt 2 succeeds) does not silently erase attempt 1's own
  // failure code/stage/elapsedMs from the returned/logged telemetry. Before
  // this fix, a recovered attempt-2 success only ever reported attempt:2 at
  // the top level, so a production recovery hid whether attempt-1 failures
  // (and the underlying audit-close frequency they can indicate) were still
  // happening at all. Reuses the exact same safeAttempt/safeStage/safeCode/
  // safeElapsedMs sanitizers the rest of this file already applies -- never
  // a second, drifting allowlist -- so nothing unsafe/unexpected can enter
  // this array whatever the underlying success/failure value looked like.
  const attemptsHistory = [];
  function recordAttempt({ attempt, stage, code, elapsedMs, ok }) {
    if (attemptsHistory.length >= 2) return;
    attemptsHistory.push(Object.freeze({
      attempt: safeAttempt(attempt),
      stage: safeStage(stage),
      code: ok === true ? null : safeCode({ code }),
      elapsedMs: safeElapsedMs(elapsedMs),
      ok: ok === true
    }));
  }
  function recordAttemptSuccess(result) {
    recordAttempt({ attempt: result.attempt, stage: result.stage, code: null, elapsedMs: result.elapsedMs, ok: true });
  }
  function recordAttemptFailure(error) {
    recordAttempt({
      attempt: error && error.attempt, stage: error && error.stage,
      code: error && error.code, elapsedMs: error && error.elapsedMs, ok: false
    });
  }

  let retried = false;
  let outcome;
  try {
    let result;
    try {
      result = await Promise.race([runAttempt(1), deadline]);
      recordAttemptSuccess(result);
    } catch (firstError) {
      recordAttemptFailure(firstError);
      const firstCode = firstError && typeof firstError.code === 'string' ? firstError.code : null;
      const remainingMs = totalTimeoutMs - (performance.now() - probeStartMs);
      // Retry classification (required change 3): exactly the six-code
      // transient-transport allowlist above, AND never the whole-probe
      // deadline itself, AND only when a reasonable fraction of the total
      // budget genuinely remains (minRetryRemainingMs heuristic above).
      const retryEligible = firstCode !== 'FRA_HEARTBEAT_TIMEOUT'
        && RETRYABLE_TRANSPORT_CODES.has(firstCode)
        && remainingMs >= minRetryRemainingMs;
      if (!retryEligible) throw firstError;
      retried = true;
      // Required change 7: tear down the FIRST attempt's now-dead proxy
      // explicitly, right here, BEFORE constructing the second attempt's
      // fresh proxy -- not only in the outer finally block's unconditional
      // sweep below, which still remains as defense in depth. proxies[0] is
      // guaranteed to be the first attempt's proxy: freshProxy() is called
      // exactly once per attempt, synchronously, at the top of runAttempt(),
      // and this branch only runs after runAttempt(1) has already returned
      // (rejected), so its proxy is the only one in the array so far.
      dropProxy(proxies[0], 'FRA_HEARTBEAT_RETRY_TEARDOWN');
      // The retry runs inside the SAME shared `deadline` raced above, so
      // both attempts combined can never exceed totalTimeoutMs.
      result = await Promise.race([runAttempt(2), deadline]);
      recordAttemptSuccess(result);
    }
    outcome = Object.freeze({ ...result, attemptsHistory: Object.freeze(attemptsHistory.slice()) });
  } catch (error) {
    // Only record here when the retry actually ran: a non-retried attempt-1
    // failure was already recorded above, right before being rethrown as
    // `firstError` -- recording it again here would duplicate that same
    // entry. A retried attempt-2 failure, by contrast, is never caught
    // locally (there is no inner try around the second race), so this is
    // the only place it can be recorded.
    if (retried) recordAttemptFailure(error);
    outcome = Object.freeze({
      ok: false, host, peer,
      code: safeCode(error),
      stage: safeStage(error && error.stage),
      attempt: safeAttempt(error && error.attempt),
      elapsedMs: safeElapsedMs(error && error.elapsedMs),
      secretValuesEmitted: false,
      attemptsHistory: Object.freeze(attemptsHistory.slice())
    });
  } finally {
    clearTimeout(deadlineTimer);
    // Guaranteed teardown of EVERY proxy created (required change 4), even
    // when only one attempt's proxy is the one that actually mattered. Safe
    // to run again on a proxy required change 7 above already dropped --
    // dropProxy()/RemoteAgentMcpProxy._dropSocket() are both idempotent.
    let teardownError = null;
    for (const proxy of proxies) {
      try {
        dropProxy(proxy, 'FRA_HEARTBEAT_COMPLETE');
      } catch (error) {
        teardownError = teardownError || error;
      }
    }
    if (teardownError) {
      outcome = Object.freeze({
        ok: false, host, peer,
        code: safeCode(teardownError),
        stage: safeStage(tracker.stage),
        attempt: safeAttempt(tracker.attempt),
        elapsedMs: tracker.attemptStartMs === null
          ? null
          : safeElapsedMs(Math.round(performance.now() - tracker.attemptStartMs)),
        secretValuesEmitted: false,
        attemptsHistory: Object.freeze(attemptsHistory.slice())
      });
    }
  }
  return outcome;
}

function parseCli(argv, serviceRegistryOptions = {}) {
  let host = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--host' && argv[index + 1]) host = argv[++index];
    else if (value === '--timeout-ms' && argv[index + 1]) timeoutMs = Number(argv[++index]);
    else fail('FRA_HEARTBEAT_ARGUMENT_INVALID');
  }
  const topology = resolveHeartbeatTopology(serviceRegistryOptions);
  if (host !== topology.hostA && host !== topology.hostB) fail('FRA_HEARTBEAT_ARGUMENT_INVALID');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 240_000) fail('FRA_HEARTBEAT_ARGUMENT_INVALID');
  return { host, timeoutMs };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const result = await heartbeat(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.ok === false) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  process.stdout.write(`${JSON.stringify({ ok: false, code: safeCode(error), secretValuesEmitted: false })}\n`);
  process.exitCode = 1;
});

module.exports = Object.freeze({
  get HOST_A() { return resolveHeartbeatTopology().hostA; },
  get HOST_B() { return resolveHeartbeatTopology().hostB; },
  get FRA_PORT() { return resolveHeartbeatTopology().fraPort; },
  READ_ONLY_TOOL,
  DEFAULT_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS,
  MIN_RETRY_REMAINING_MS,
  STAGES,
  RETRYABLE_TRANSPORT_CODES,
  resolveHeartbeatTopology,
  peerForHost,
  expectedRootForHost,
  safeCode,
  safeStage,
  safeAttempt,
  safeElapsedMs,
  safeAttemptsHistory,
  sanitizeHeartbeatTelemetry,
  isCleanResponse,
  heartbeat,
  parseCli
});
