#!/usr/bin/env node
'use strict';

// Read-only onboarding probe for the two registered-machine layers.
//
// tunnel = the authenticated 8787 message relay (the agent-to-agent chat
// channel). bridge = the authenticated 8788 native MCP surface. They are
// intentionally reported separately: either one can be disabled while the
// other remains useful. The bridge probe uses the existing fail-closed proxy,
// so the token is read in-process and never appears in output, argv, logs, or
// the relay.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { getSecret } = require('../src/lib/runtime');
const {
  ServiceRegistryError,
  assertSanctionedMachineAddress,
  machineAddressPolicy,
  peerMachineForAddress
} = require('../src/lib/service-registry');
const { RemoteAgentMcpProxy } = require('./remote-agent-mcp-proxy');
const { probeLinkBus: probeLinkBusHealth } = require('./tunnel-bridge-health');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
// A SLOW REMOTE LANE IS NOT A DEAD ONE, AND THIS FILE USED TO SAY IT WAS.
//
// `initialize` and `tools/list` are answered by the peer's dispatcher without
// executing anything, so 10s is a generous budget for them. The liveness probe
// is a real `tools/call`, and a tool call on the peer pays the shared audit
// ledger's single-writer path. Measured on 2026-08-11 against the live peer:
// initialize 443-1237ms and tools/list 53-69ms, but the SAME
// system.kill_switch_status call cost 7,546 / 7,861 / 7,874ms -- under the 10s
// budget only by a margin narrower than the noise. Locally, with the ledger
// contended by the agent fleet, one call measured 11,193-61,630ms, of which a
// CPU profile attributed 72,168ms of 88,057 sampled to audit-store.js's
// SQLITE_BUSY retry loop. Nothing was hung; every one of those calls returned a
// correct result.
//
// So the old single 10s budget reported REMOTE_BRIDGE_RESPONSE_TIMEOUT and
// DEGRADED for a bridge that was working, and exited 1. That reading is worse
// than useless to a supervisor: the documented response to DEGRADED is to
// restart the lane, which would tear down a healthy authenticated session
// because a tool call took eight seconds. Two budgets, and a state that says
// SLOW out loud, so recovery machinery reacts to failure and not to latency.
const DEFAULT_LIVENESS_TIMEOUT_MS = 45_000;
const MAX_LIVENESS_TIMEOUT_MS = 120_000;
const DEFAULT_LIVENESS_SLOW_MS = 5_000;
const DEFAULT_LINK_BUS_PORT = 8787;
const DEFAULT_BRIDGE_PORT = 8788;
const MAX_BODY_BYTES = 16 * 1024;
const FORBIDDEN_REMOTE_TOOLS = Object.freeze([
  'host.exec',
  'clipboard.read',
  'ocr.read'
]);

function safeErrorCode(error) {
  const candidate = error && (error.code || (error.name && error.name !== 'Error' ? error.name : null));
  return typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)
    ? candidate
    : 'probe_error';
}

// This module's own refusals were plain `new Error(identifier)`, so the
// identifier lived only in .message. safeErrorCode() above reads .code (and
// falls back to .name), never .message, so every one of these was reported as
// the opaque 'probe_error' -- a refusal that could not say what failed. Giving
// each one a real .code here fixes the masking at its source; teaching
// safeErrorCode to sniff .message for a bounded set of known identifiers was
// the alternative, but that would be a second list of these strings to keep
// in sync with this one.
function bridgeStatusError(code) {
  return Object.assign(new Error(code), { code });
}

function safeRpcError(response) {
  const data = response && response.error && response.error.data;
  const candidate = data && (data.code || data.errorCode);
  return typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)
    ? candidate
    : 'remote_rpc_error';
}

function classifyFailure(code) {
  if (typeof code !== 'string') return 'UNKNOWN';
  // A step that ran out of ITS budget is not an unknown condition -- the socket
  // connected and the peer simply did not answer in time. That is a reachable
  // peer failing to serve, which is DEGRADED and actionable. Left to the
  // generic tail below it fell through to UNKNOWN, which reads as "the checker
  // could not tell" and hides a measured fact. Placed before the UNKNOWN
  // prefixes so it cannot be captured by them.
  if (code === 'BRIDGE_STATUS_STEP_BUDGET_EXCEEDED') return 'DEGRADED';
  if (/^(?:REMOTE_BRIDGE_(?:TARGET_INVALID|PORT_INVALID|LOCAL_IDENTITY_INVALID|TOKEN_|HANDSHAKE_INVALID|ROOT_MISMATCH|DISABLED|GATE_UNAVAILABLE)|INVALID_ARGUMENT|TOKEN_)/.test(code)) {
    return 'UNKNOWN';
  }
  if (/TIMEOUT|REFUSED|CONNECT|RESET|SOCKET|CONNECTION|UNAVAILABLE|FAILED/.test(code)) {
    return 'DOWN';
  }
  return 'UNKNOWN';
}

function classifyTunnel({ listener, authenticated }) {
  if (listener && listener.ok === true && authenticated && authenticated.ok === true) return 'UP';
  if (listener && listener.ok === true) return 'DEGRADED';
  return classifyFailure(listener && listener.error);
}

// SLOW is reachable only when the remote call actually SUCCEEDED. A liveness
// failure of any kind is still DEGRADED -- this widens what the checker can
// say, never what it forgives.
function classifyBridge({ initialize, tools, liveness }) {
  if (!initialize || initialize.ok !== true) return classifyFailure(initialize && initialize.error);
  if (!tools || tools.ok !== true || !liveness || liveness.ok !== true) return 'DEGRADED';
  return liveness.slow === true ? 'SLOW' : 'UP';
}

// Ordered worst-first. SLOW ranks below every real fault and above UP, so a
// slow-but-working lane can never mask a genuinely broken one in the rollup.
const STATE_SEVERITY = Object.freeze(['DEGRADED', 'DOWN', 'UNKNOWN', 'SLOW', 'UP']);

function rollUpState(states) {
  for (const candidate of STATE_SEVERITY) {
    if (states.includes(candidate)) return candidate;
  }
  return 'UNKNOWN';
}

// The exit code answers one question: is the lane usable right now. A lane that
// answered correctly, only slowly, is usable, and must not exit non-zero.
//
// Who actually reads this, checked rather than assumed: CLAUDE.md's "Direct-link
// check" sends every onboarding session here, so the reader is a human or an
// agent deciding whether the cross-machine lane works. No PowerShell supervisor
// branches on it -- tools/bridge-session-supervisor.ps1 probes
// tools/tunnel-bridge-health.js instead, and the only .ps1 mention of this file
// is an instruction string in tools/scope-node-firewall-rules.ps1. An earlier
// draft of this comment claimed the supervisors branched on this exit code;
// they do not, and the claim is corrected here rather than left standing.
function exitCodeForState(state) {
  return state === 'UP' || state === 'SLOW' ? 0 : 1;
}

// The guarded tier this transport is supposed to run under, expressed as the
// question that actually matters: which effects may cross the hop. Read from
// the policy module rather than restated here, so a tier change cannot leave a
// second, quietly disagreeing copy behind -- the exact failure this file is
// about. Required lazily: the registry graph is large and only this check needs
// it.
function localGuardedEffects() {
  const { TOOL_REGISTRY } = require('../src/lib/tool-registry');
  const permissionTierPolicy = require('../src/lib/permission-tier-policy');
  const effectByName = new Map(TOOL_REGISTRY.map(entry => [entry.name, entry.effect]));
  return { effectByName, guarded: new Set(permissionTierPolicy.guardedToolNames(TOOL_REGISTRY)) };
}

// A NAME FILTER IS NOT A PERMISSION TIER, AND ON 2026-08-11 THE LIVE PEER WAS
// ENFORCING ONLY THE NAME FILTER.
//
// Measured against the real peer that day: the bridge advertised 294 tools, of
// which 140 carried a write effect (75 local-write, 65 external-write) --
// including host.write_file, repo.write_file, http.request and
// system.kill_switch_activate. host.write_file was then CALLED over the hop and
// the file landed on the peer's disk, confirmed by reading it back. The same
// machine's own policy refuses every one of those: guardedToolNames() returns
// 114 tools, all local-read/external-read, and assertToolAllowed refuses
// host.write_file with PERMISSION_EFFECT_REFUSED. The code was right; the
// running listener was not applying it, narrowing only by
// TOOLSENABLED_TOOL_ALLOWLIST. The two mechanisms disagreed in BOTH directions
// -- that allowlist also refused clipboard.read, which the tier permits.
//
// Enumeration parity is therefore not a nicety. It is the only signal this
// product has that the ceiling the owner chose is the ceiling the far end
// enforces, and a hardcoded three-name FORBIDDEN list could never have seen
// this: host.write_file was not on it.
function summarizeTools(response, { guardedEffects = localGuardedEffects } = {}) {
  const tools = response && response.result && Array.isArray(response.result.tools)
    ? response.result.tools
    : null;
  if (!tools) {
    const code = response && response.error && response.error.data && response.error.data.code;
    return { ok: false, toolCount: null, error: typeof code === 'string' ? code : 'tools_list_invalid' };
  }
  const names = tools.map(tool => tool && typeof tool.name === 'string' ? tool.name : '');
  const forbidden = names.filter(name => FORBIDDEN_REMOTE_TOOLS.includes(name) || name.startsWith('screen.'));
  let widened = [];
  let unknownLocally = 0;
  let effectParityChecked = false;
  try {
    const { effectByName, guarded } = guardedEffects();
    effectParityChecked = true;
    for (const name of names) {
      const effect = effectByName.get(name);
      if (effect === undefined) { unknownLocally += 1; continue; }
      if (!guarded.has(name)) widened.push(name);
    }
  } catch {
    // Unreadable policy is reported as unchecked, never as parity.
    widened = [];
  }
  // A name absent from the local registry has no locally established effect or
  // tier membership. Counting that skew while still returning ok:true turned
  // "could not classify this advertised tool" into a passing parity answer.
  // Refuse parity until every advertised name can actually be classified.
  const ok = forbidden.length === 0
    && effectParityChecked
    && unknownLocally === 0
    && widened.length === 0;
  return {
    ok,
    toolCount: tools.length,
    forbiddenExcluded: forbidden.length === 0,
    effectParityChecked,
    surfaceWidenedBy: widened.length,
    ...(widened.length ? { widenedSample: widened.slice(0, 10) } : {}),
    ...(unknownLocally ? { advertisedButUnknownLocally: unknownLocally } : {}),
    ...(forbidden.length ? { error: 'forbidden_tool_exposed' }
      : !effectParityChecked ? { error: 'remote_surface_parity_unchecked' }
        : unknownLocally ? { error: 'remote_surface_contains_unknown_tools' }
        : widened.length ? { error: 'remote_surface_wider_than_local_tier' } : {})
  };
}

function requestHttp({ host, port, pathName, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, readBody = false } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.request({ host, port, path: pathName, method: 'GET', headers, timeout: timeoutMs }, response => {
      let body = '';
      let bytes = 0;
      response.on('data', chunk => {
        if (!readBody) return;
        bytes += chunk.length;
        if (bytes <= MAX_BODY_BYTES) body += chunk.toString('utf8');
      });
      response.on('end', () => finish({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        ...(readBody ? { body: body.slice(0, MAX_BODY_BYTES) } : {})
      }));
    });
    request.once('timeout', () => {
      request.destroy();
      finish({ ok: false, error: 'timeout' });
    });
    request.once('error', error => finish({ ok: false, error: safeErrorCode(error) }));
    request.end();
  });
}

async function probeTunnel({
  peerHost,
  linkBusPort = DEFAULT_LINK_BUS_PORT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tokenLoader = getSecret,
  healthProbe = probeLinkBusHealth,
  httpProbe = requestHttp
} = {}) {
  const listener = await healthProbe({ host: peerHost, port: linkBusPort, timeoutMs });
  let authenticated = { ok: false, error: 'token_unchecked' };
  try {
    const token = tokenLoader('custom.link_bus_bridge_token', { prompt: false });
    if (typeof token !== 'string' || token.length < 16) {
      authenticated = { ok: false, error: 'LINK_BUS_TOKEN_INVALID' };
    } else {
      // THIS PROBE ACCUSED A VALID CREDENTIAL. Two independent defects, both
      // fixed here, found 2026-08-10 while the tunnel was the last red lane.
      //
      // 1. IT ASKED AN INVALID QUESTION. The path omitted `cursor`, but the
      //    store requires one (sidecars/link-bus/store.js, LINK_BUS_CURSOR_-
      //    REQUIRED -- "a read may not silently begin at the oldest retained
      //    message"). The request was rejected 400 by query validation, which
      //    runs AFTER the auth gate.
      // 2. IT MISLABELLED EVERY NON-200 AS AN AUTH FAILURE. `response.error` is
      //    only populated for TRANSPORT errors, so the `||` fell through to
      //    LINK_BUS_AUTH_FAILED for any HTTP status at all.
      //
      // The server's contract is explicit that 401 means credentials and
      // nothing else (sidecars/link-bus/server.js). Proven three ways: with a
      // cursor -> 200; without -> 400 LINK_BUS_CURSOR_REQUIRED; with no
      // credential -> 401. The token was valid the entire time.
      //
      // CLAUDE.md sends every onboarding session to this check, so a phantom
      // credential failure here is inherited by every session while the real
      // fault -- a malformed probe -- stays invisible.
      const response = await httpProbe({
        host: peerHost,
        port: linkBusPort,
        pathName: '/v1/messages?channel=team&cursor=0&limit=1',
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs,
        readBody: true
      });
      if (response.ok && response.status === 200) {
        authenticated = { ok: true, status: response.status };
      } else {
        // Report what the peer ACTUALLY said. Only a 401 is an auth failure.
        let reported = response.error || null;
        if (!reported && typeof response.body === 'string' && response.body) {
          try {
            const parsed = JSON.parse(response.body);
            if (parsed && typeof parsed.error === 'string') reported = parsed.error;
          } catch { /* a non-JSON body stays unreported rather than guessed at */ }
        }
        authenticated = {
          ok: false,
          status: response.status,
          error: reported || (response.status === 401 ? 'LINK_BUS_AUTH_FAILED' : 'LINK_BUS_PROBE_FAILED')
        };
      }
    }
  } catch (error) {
    authenticated = { ok: false, error: safeErrorCode(error) };
  }
  return {
    state: classifyTunnel({ listener, authenticated }),
    peerHost,
    port: linkBusPort,
    listener,
    authenticated,
    purpose: 'authenticated message relay'
  };
}

async function probeBridge({
  peerHost,
  localHost,
  expectedRoot,
  bridgePort = DEFAULT_BRIDGE_PORT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  livenessTimeoutMs = DEFAULT_LIVENESS_TIMEOUT_MS,
  livenessSlowMs = DEFAULT_LIVENESS_SLOW_MS,
  enabledValue = '1',
  tokenLoader = getSecret,
  proxyFactory = options => new RemoteAgentMcpProxy(options)
} = {}) {
  // The proxy applies one timeout to every request it carries, so it is given
  // the LARGER budget and the handshake/enumeration steps are bounded
  // separately below. Handing it the smaller budget instead is what capped the
  // liveness call at 10s.
  const proxy = proxyFactory({
    host: peerHost,
    port: bridgePort,
    localHost,
    expectedRoot,
    timeoutMs: Math.max(timeoutMs, livenessTimeoutMs),
    enabledValue,
    tokenLoader: tokenLoader === getSecret
      ? () => tokenLoader('custom.remote_agent_bridge_token', { prompt: false })
      : tokenLoader
  });
  const timedRequest = async request => {
    const started = Date.now();
    try {
      const response = await proxy.request(request);
      const responseError = response && response.error ? safeRpcError(response) : null;
      return {
        ok: !responseError,
        latencyMs: Date.now() - started,
        response,
        ...(responseError ? { error: responseError } : {})
      };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: safeErrorCode(error) };
    }
  };
  // timedRequest never rejects, so racing it against a budget cannot orphan a
  // rejection. The losing request stays pending until the socket is dropped at
  // the end of the probe, which is where every other pending request ends too.
  const withBudget = async (request, budgetMs) => {
    const started = Date.now();
    let timer = null;
    const budget = new Promise(resolve => {
      timer = setTimeout(() => resolve({ ok: false, latencyMs: Date.now() - started, error: 'BRIDGE_STATUS_STEP_BUDGET_EXCEEDED' }), budgetMs);
    });
    const outcome = await Promise.race([request, budget]);
    clearTimeout(timer);
    return outcome;
  };
  let initialize = await withBudget(timedRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'toolsenabled-bridge-status', version: '1.0.0' }
    }
  }), timeoutMs);
  let tools = { ok: false, toolCount: null, error: 'initialize_not_complete' };
  let liveness = { ok: false, error: 'initialize_not_complete' };
  if (initialize.ok) {
    try { await proxy.request({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }); }
    catch (error) { initialize = { ...initialize, ok: false, error: safeErrorCode(error) }; }
  }
  if (initialize.ok) {
    const listed = await withBudget(timedRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), timeoutMs);
    tools = { ...(listed.ok ? summarizeTools(listed.response) : { ok: false, toolCount: null, error: listed.error }), latencyMs: listed.latencyMs };
  }
  if (initialize.ok && tools.ok) {
    const checked = await withBudget(timedRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'system.kill_switch_status', arguments: {} }
    }), livenessTimeoutMs);
    liveness = checked.ok
      ? {
          ok: true,
          latencyMs: checked.latencyMs,
          budgetMs: livenessTimeoutMs,
          slow: checked.latencyMs > livenessSlowMs,
          slowThresholdMs: livenessSlowMs,
          killSwitchActive: checked.response.result && checked.response.result.structuredContent
            ? checked.response.result.structuredContent.active === true
            : null
        }
      : { ok: false, latencyMs: checked.latencyMs, budgetMs: livenessTimeoutMs, error: checked.error || 'remote_liveness_failed' };
  }
  const result = {
    state: classifyBridge({ initialize, tools, liveness }),
    peerHost,
    localHost,
    port: bridgePort,
    expectedRoot,
    initialize: { ok: initialize.ok, latencyMs: initialize.latencyMs, ...(initialize.error ? { error: initialize.error } : {}) },
    tools,
    liveness,
    purpose: 'bounded authenticated remote MCP access'
  };
  proxy.closed = true;
  if (typeof proxy._dropSocket === 'function') proxy._dropSocket(Object.assign(new Error('status probe complete'), { code: 'STATUS_PROBE_COMPLETE' }));
  return result;
}

// Always ask the central live policy rather than retaining a module-load copy.
// If the registry disappears or becomes malformed after a successful call,
// the next status probe therefore refuses with SERVICE_REGISTRY_*, exactly as
// the bridge authorization paths do.
function knownMachineAddresses() {
  return machineAddressPolicy().addresses;
}

function assertPeerPair(localHost, peerHost) {
  const expectedPeer = peerMachineForAddress(localHost);
  assertSanctionedMachineAddress(peerHost);
  if (expectedPeer.address !== peerHost) {
    throw new ServiceRegistryError(
      'BRIDGE_STATUS_HOST_PAIR_INVALID',
      'Bridge status local and peer addresses must name the two distinct registered machines.'
    );
  }
  return expectedPeer;
}

// Bare-run identity: which known machine address is actually
// bound to an interface on THIS host. Zero or two matches is undetectable --
// refused later by the caller, never guessed, per the same fail-closed
// pattern as src/lib/service-registry.js's detectLocalMachineId.
function detectLocalHost(networkInterfaces = os.networkInterfaces) {
  const policy = machineAddressPolicy();
  let interfaceMap;
  try { interfaceMap = networkInterfaces() || {}; }
  catch { return null; }
  const matches = new Set();
  for (const entries of Object.values(interfaceMap)) {
    for (const entry of entries || []) {
      if (entry && entry.family === 'IPv4' && policy.has(entry.address)) {
        matches.add(entry.address);
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function defaultPeerConfig(environment = process.env, networkInterfaces = os.networkInterfaces) {
  let localHost = environment.REMOTE_AGENT_PROXY_LOCAL_HOST || null;
  let peerHost = environment.REMOTE_AGENT_PROXY_HOST || null;
  if (localHost) assertSanctionedMachineAddress(localHost);
  if (peerHost) assertSanctionedMachineAddress(peerHost);
  if (!localHost && peerHost) localHost = peerMachineForAddress(peerHost).address;
  if (!localHost) localHost = detectLocalHost(networkInterfaces);
  if (!peerHost && localHost) peerHost = peerMachineForAddress(localHost).address;
  const peerMachine = localHost && peerHost ? assertPeerPair(localHost, peerHost) : null;
  // Derive the expected root from the validated peer record. No machine name,
  // address, or installation path is a product default.
  const expectedRoot = environment.REMOTE_AGENT_EXPECTED_ROOT
    || (peerMachine ? peerMachine.root : undefined);
  return { peerHost, localHost, expectedRoot };
}

function parseArgs(argv = process.argv.slice(2), environment = process.env, networkInterfaces = os.networkInterfaces) {
  // --help is pure usage output. It must work with no host, no network, and no
  // registry match -- this host has no direct-link connection at all right now,
  // and that is a correct, expected condition, not a reason usage text should
  // be unreachable. So --help is resolved from argv alone, before
  // defaultPeerConfig() below runs host detection or anything validates a
  // host/peer pair.
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const defaults = defaultPeerConfig(environment, networkInterfaces);
  const result = {
    ...defaults,
    timeoutMs: Number(environment.BRIDGE_STATUS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    livenessTimeoutMs: Number(environment.BRIDGE_STATUS_LIVENESS_TIMEOUT_MS || DEFAULT_LIVENESS_TIMEOUT_MS),
    livenessSlowMs: Number(environment.BRIDGE_STATUS_LIVENESS_SLOW_MS || DEFAULT_LIVENESS_SLOW_MS),
    linkBusPort: DEFAULT_LINK_BUS_PORT,
    bridgePort: DEFAULT_BRIDGE_PORT,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') { result.help = true; continue; }
    const next = argv[index + 1];
    if (!next) throw bridgeStatusError('BRIDGE_STATUS_ARGUMENT_MISSING');
    if (flag === '--peer') result.peerHost = next;
    else if (flag === '--local') result.localHost = next;
    else if (flag === '--expected-root') result.expectedRoot = next;
    else if (flag === '--timeout-ms') result.timeoutMs = Number(next);
    else if (flag === '--liveness-timeout-ms') result.livenessTimeoutMs = Number(next);
    else if (flag === '--liveness-slow-ms') result.livenessSlowMs = Number(next);
    else if (flag === '--link-bus-port') result.linkBusPort = Number(next);
    else if (flag === '--bridge-port') result.bridgePort = Number(next);
    else throw bridgeStatusError('BRIDGE_STATUS_ARGUMENT_INVALID');
    index += 1;
  }
  if (!result.localHost) {
    throw bridgeStatusError('BRIDGE_STATUS_LOCAL_HOST_UNDETECTABLE');
  }
  if (!result.peerHost) {
    throw bridgeStatusError('BRIDGE_STATUS_PEER_HOST_UNDETECTABLE');
  }
  // CLI overrides are untrusted input and are applied after the defaults.
  // Revalidate them before either the authenticated tunnel probe or the bridge
  // proxy can make a network request.
  const peerMachine = assertPeerPair(result.localHost, result.peerHost);
  if (!result.expectedRoot) result.expectedRoot = peerMachine.root;
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1000 || result.timeoutMs > MAX_TIMEOUT_MS) {
    throw bridgeStatusError('BRIDGE_STATUS_TIMEOUT_INVALID');
  }
  if (!Number.isSafeInteger(result.livenessTimeoutMs)
      || result.livenessTimeoutMs < 1000 || result.livenessTimeoutMs > MAX_LIVENESS_TIMEOUT_MS) {
    throw bridgeStatusError('BRIDGE_STATUS_LIVENESS_TIMEOUT_INVALID');
  }
  // A slow threshold at or above the budget could never fire, which would
  // silently restore the old "any latency is fine until it is fatal" reading.
  if (!Number.isSafeInteger(result.livenessSlowMs)
      || result.livenessSlowMs < 1 || result.livenessSlowMs >= result.livenessTimeoutMs) {
    throw bridgeStatusError('BRIDGE_STATUS_LIVENESS_SLOW_INVALID');
  }
  if (!Number.isInteger(result.linkBusPort) || !Number.isInteger(result.bridgePort)) {
    throw bridgeStatusError('BRIDGE_STATUS_PORT_INVALID');
  }
  return result;
}

async function probeAll(options = {}) {
  const config = { ...defaultPeerConfig(), ...options };
  // existsSync collapses every filesystem error into false. That would report
  // rootExists:false as a measured fact when permission or I/O failure meant
  // the root could not be checked. statSync deliberately carries that failure
  // to main(), which emits UNKNOWN and exits non-zero.
  const rootExists = fs.statSync(ROOT).isDirectory();
  const [tunnel, bridge] = await Promise.all([
    probeTunnel(config),
    probeBridge(config)
  ]);
  const overallState = rollUpState([tunnel.state, bridge.state]);
  return {
    schemaVersion: 'bridge-status.v1',
    checkedAt: new Date().toISOString(),
    root: ROOT,
    rootExists,
    overallState,
    tunnel,
    bridge,
    controls: {
      tunnel: 'powershell -NoProfile -File tools/tunnel-bridge-control.ps1 -Component Tunnel -Action Status',
      bridge: 'powershell -NoProfile -File tools/tunnel-bridge-control.ps1 -Component Bridge -Action Status'
    },
    secretValuesEmitted: false
  };
}

function usage() {
  return [
    'Read-only registered-machine status checker.',
    'Reports tunnel (authenticated 8787 message relay) and bridge (authenticated 8788 MCP) separately.',
    '',
    'A liveness call that SUCCEEDS but exceeds --liveness-slow-ms reports SLOW and exits 0;',
    'only a liveness failure reports DEGRADED.',
    '',
    'node tools/bridge-status.js [--peer IP] [--local IP] [--expected-root PATH]',
    '                            [--timeout-ms N] [--liveness-timeout-ms N] [--liveness-slow-ms N]'
  ].join('\n');
}

async function main(argv = process.argv.slice(2), environment = process.env) {
  const args = parseArgs(argv, environment);
  if (args.help) { process.stdout.write(`${usage()}\n`); return 0; }
  const result = await probeAll(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return exitCodeForState(result.overallState);
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 'bridge-status.v1',
      overallState: 'UNKNOWN',
      error: safeErrorCode(error),
      secretValuesEmitted: false
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_LIVENESS_TIMEOUT_MS,
  MAX_LIVENESS_TIMEOUT_MS,
  DEFAULT_LIVENESS_SLOW_MS,
  STATE_SEVERITY,
  classifyBridge,
  classifyFailure,
  classifyTunnel,
  exitCodeForState,
  rollUpState,
  defaultPeerConfig,
  detectLocalHost,
  knownMachineAddresses,
  main,
  parseArgs,
  probeAll,
  probeBridge,
  probeTunnel,
  requestHttp,
  safeErrorCode,
  summarizeTools
});
