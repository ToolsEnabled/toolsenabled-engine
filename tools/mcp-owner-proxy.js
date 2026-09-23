#!/usr/bin/env node
'use strict';

// Stdio-to-owner-session MCP transport.
//
// The capability file is deliberately the only discovery mechanism.  When it
// is absent, an anonymous/provider-only same-account invocation may serve the
// broker in-process.  A declared agent id or a session credential can never
// take that fallback: without the owner host neither value has an authoritative
// server-side binding.  When a route is present, malformed data, denied read,
// failed connection, or a bad handshake fails closed instead of silently
// switching to a different Windows account's vault.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const linuxAuthority = require('../src/lib/owner-host-linux');

const ROOT = path.resolve(__dirname, '..');
const PIPE_PREFIX = '\\\\.\\pipe\\ToolsEnabled.OwnerHost.V2.';
const CAPABILITY_FILE_NAME = 'owner-host-capability.json';
const MAX_CAPABILITY_BYTES = 4096;
const MAX_HANDSHAKE_BYTES = 4096;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PIPE_RE = /^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,180}$/;
const AGENT_ACTORS = new Set(['codex', 'claude', 'gemini']);
const DECLARED_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REFUSAL = 'REFUSING TO SERVE: cannot reach this ToolsEnabled app instance. Close and reopen ToolsEnabled normally, then start the agent again.';

/* WHAT A RUNNING SESSION IS TOLD WHEN ITS TOOL HOST GOES AWAY, and why it is
 * told at all.
 *
 * MEASURED, twice, and filed as T159. Activating a runtime generation is
 * pointer-only, but the app restart that follows it ends every agent session
 * in the app (tooling/live/supervisor.mjs says so in its own header). The
 * agent CLI processes outlive that restart. Before this, their proxy saw the
 * socket close, wrote one line to STDERR -- which an MCP client does not show
 * anybody -- and exited, so:
 *   - the tool call that was RUNNING at that moment was never answered at all;
 *   - the agent read a transport-level "MCP server disconnected" with no
 *     product reason and no recovery;
 *   - the owner read nothing.
 * 2026-09-16 08:15:26Z and 2026-09-18 09:30:24Z: lanes "worked on then idled
 * unreachable"; 2026-09-19 01:50Z the Controller could still only say "MCP is
 * still down".
 *
 * So a lost transport is now ANSWERED IN THE PROTOCOL, with a named reason the
 * agent reads as a tool result in its own transcript. The three reasons are
 * told apart by EVIDENCE -- the capability record the app publishes -- never
 * guessed:
 *   record gone            -> the app is not running.
 *   record names ANOTHER   -> this app instance was replaced (the restart that
 *   generation                follows a runtime-generation activation).
 *   record names THE SAME  -> the app is still running and ended this session.
 * A same-generation loss is the only one worth reconnecting through, and that
 * reconnect cannot resurrect anything: the host still has to authorize the
 * credential, so a deliberate revoke stays a revoke. */
const TRANSPORT_LOST_CODES = Object.freeze({
  SUPERSEDED: 'OWNER_HOST_GENERATION_SUPERSEDED',
  UNAVAILABLE: 'OWNER_HOST_UNAVAILABLE',
  SESSION_ENDED: 'OWNER_HOST_SESSION_ENDED',
  /* NOT a lost transport: the connection came back on the SAME app instance.
     Only the one call that was running across the drop is unanswerable, and
     telling the agent that ToolsEnabled ended its tool access and it should be
     resumed from the app, while the session is serving again, is false in the
     expensive direction -- the agent stops working and the owner is asked to
     resume a session that never needed it. */
  CALL_INTERRUPTED: 'OWNER_HOST_CALL_INTERRUPTED'
});
const TRANSPORT_LOST_MESSAGES = Object.freeze({
  [TRANSPORT_LOST_CODES.SUPERSEDED]: 'ToolsEnabled restarted into a newer runtime while this session was running, so this session\'s tools belong to an app instance that no longer exists. Nothing here is lost: resume this agent from the app to get a working toolkit again.',
  [TRANSPORT_LOST_CODES.UNAVAILABLE]: 'ToolsEnabled is not running, so this session has no toolkit to call. Open ToolsEnabled and resume this agent to get one again.',
  [TRANSPORT_LOST_CODES.SESSION_ENDED]: 'ToolsEnabled ended this session\'s tool access. Resume this agent from the app to get a working toolkit again.',
  [TRANSPORT_LOST_CODES.CALL_INTERRUPTED]: 'ToolsEnabled dropped this session\'s tool connection while this call was running, and the connection is back: the toolkit is working again and the next call will be served normally.'
});
/* A call that was IN FLIGHT when the transport dropped is a different answer
 * from a call made after it, and conflating them would be a lie in the one
 * direction that costs the most. The proxy cannot know whether the host
 * finished that work before it went away, so it says exactly that, and it
 * never re-sends the request: host.exec, a purchase and a credential write all
 * ride this transport, and replaying one of those to "recover" would be worse
 * than the outage. */
const IN_FLIGHT_SUFFIX = ' One tool call was already running when this happened; whether it finished is not known here, so do not assume either way and do not repeat it blindly.';
const TRANSPORT_LOST_RPC_CODE = -32001;
/* Bounds, declared.
 *
 * RESOLVE_WINDOW_MS is the one that matters, and it exists because "the record
 * is gone" and "the record is not back yet" are different answers. An app that
 * is restarting removes its capability record on the way out and publishes the
 * next one on the way in; measured 2026-09-18, that gap was 12 seconds. Reading
 * the absence once and calling the app gone would convict a restart in
 * progress, so an absent record is polled to a deadline before it is allowed to
 * mean anything. A record that names ANOTHER generation is not polled: it is
 * already a complete answer.
 *
 * RECONNECT_* covers a connection the still-live app dropped, not a restart:
 * the host destroys a socket for an oversized line, a handshake that never
 * completed, or an orphaned transport, and none of those ends the binding.
 * Each retry waits longer than the last (reconnectDelayFor: the base delay
 * doubled per attempt, capped at RECONNECT_MAX_DELAY_MS), so a host that is
 * busy is not hammered and a host that is back is found within one delay.
 * The same schedule paces the absent-record poll, and it resets the moment a
 * connection is authorized. DEGRADED_LINGER_MS keeps a NAMED surface in front
 * of the agent instead of a dead pipe, then stops costing a process. */
const RESOLVE_WINDOW_MS = 60_000;
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5_000;
const DEGRADED_LINGER_MS = 15 * 60_000;
/* THE STATE BETWEEN A DROPPED CONNECTION AND THE VERDICT ON IT. Named so the
 * process log (which MCP clients keep) says what this proxy is doing instead
 * of nothing: the client's requests are held, not refused, and are forwarded
 * the moment the same app instance authorizes the credential again. */
const TRANSPORT_RECOVERING_CODE = 'OWNER_HOST_RECONNECTING';
const TRANSPORT_RECOVERING_MESSAGE = 'ToolsEnabled dropped this session\'s tool connection; reconnecting to the same app instance. Tool calls made now are held and answered once the connection is back.';
// Only the FRONT of a JSON-RPC line is scanned for its `id`, so a 40 MB
// screenshot result costs one indexOf and no retained copy. Both hosts write
// `{"jsonrpc":"2.0","id":...` as the first two keys (src/mcp-server.js
// errorResponse/write, src/owner-host.js), so this prefix is generous.
const RPC_ID_SCAN_BYTES = 1024;
const MAX_TRACKED_REQUESTS = 64;

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/* HOW LONG TO WAIT BEFORE RETRY NUMBER `attempt` (0-based): the base delay,
 * doubled per attempt, never above the cap. Pure, so the schedule is a fact a
 * test can read by values rather than by racing a clock. */
function reconnectDelayFor(attempt, { baseMs = RECONNECT_DELAY_MS, maxMs = RECONNECT_MAX_DELAY_MS } = {}) {
  const step = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
  const base = Number.isSafeInteger(baseMs) && baseMs > 0 ? baseMs : RECONNECT_DELAY_MS;
  const cap = Number.isSafeInteger(maxMs) && maxMs >= base ? maxMs : base;
  // 2 ** step overflows to Infinity long before any realistic attempt count;
  // Math.min keeps that at the cap rather than at an unschedulable timer.
  return Math.min(cap, base * (2 ** Math.min(step, 30)));
}

function canonicalToken(value) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) return null;
  let bytes;
  try { bytes = Buffer.from(value, 'base64url'); } catch { return null; }
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) {
    bytes.fill(0);
    return null;
  }
  return bytes;
}

function agentActor(environment = process.env) {
  const actor = String(environment.TOOLSENABLED_AGENT_ACTOR || '').trim().toLowerCase();
  if (!AGENT_ACTORS.has(actor)) {
    const error = new Error('The MCP transport has no valid bound agent actor.');
    error.code = 'OWNER_PROXY_ACTOR_INVALID';
    throw error;
  }
  return actor;
}

function agentIdentity(environment = process.env) {
  const value = environment.TOOLSENABLED_AGENT_ID;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DECLARED_AGENT_ID.test(value)) {
    const error = new Error('The MCP transport has an invalid declared agent identity.');
    error.code = 'OWNER_PROXY_AGENT_ID_INVALID';
    throw error;
  }
  return value;
}

function agentSessionCredential(environment = process.env) {
  const value = environment.TOOLSENABLED_AGENT_SESSION_CREDENTIAL;
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) {
    const error = new Error('The MCP transport has no valid opaque session credential.');
    error.code = 'OWNER_PROXY_SESSION_CREDENTIAL_INVALID';
    throw error;
  }
  let bytes;
  try { bytes = Buffer.from(value, 'base64url'); } catch { bytes = null; }
  if (!bytes || bytes.length !== 32 || bytes.toString('base64url') !== value) {
    if (bytes) bytes.fill(0);
    const error = new Error('The MCP transport has no valid opaque session credential.');
    error.code = 'OWNER_PROXY_SESSION_CREDENTIAL_INVALID';
    throw error;
  }
  bytes.fill(0);
  return value;
}

function isolatedCapabilityPath(environment = process.env) {
  if (environment.TOOLSENABLED_TEST_ISOLATED !== '1') return null;
  const raw = String(environment.TOOLSENABLED_TEST_ROOT || '').trim();
  if (!raw || !path.isAbsolute(raw)) {
    const error = new Error('The isolated owner-host test root is invalid.');
    error.code = 'OWNER_PROXY_TEST_ROOT_INVALID';
    throw error;
  }
  // Test isolation is not an escape hatch around the Windows account fence.
  // Lifecycle fixtures live under the installation account's Temp directory.
  const boundary = require('../src/lib/account-profile-boundary.js');
  const fenced = boundary.assertAccountProfilePath(raw, {
    field: 'isolated owner-host root',
    profileRoot: boundary.installationProfileRoot(),
    requireOwnedProfile: process.platform === 'win32'
  });
  return path.join(fenced, CAPABILITY_FILE_NAME);
}

function capabilityPath(environment = process.env) {
  const isolated = isolatedCapabilityPath(environment);
  if (isolated) return isolated;
  const runtimeState = require('../src/lib/runtime-state-root.js');
  return runtimeState.statePath('state', CAPABILITY_FILE_NAME);
}

function readCapability(file, environment = process.env) {
  let handle;
  try {
    const linux = process.platform === 'linux';
    let parsed;
    if (linux) parsed = linuxAuthority.readPrivateRecord(file, MAX_CAPABILITY_BYTES);
    else {
      handle = fs.openSync(file, 'r');
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CAPABILITY_BYTES) {
        const error = new Error('The owner-host capability record is invalid.');
        error.code = 'OWNER_PROXY_CAPABILITY_INVALID';
        throw error;
      }
      parsed = JSON.parse(fs.readFileSync(handle, 'utf8'));
    }
    if (!plain(parsed)
        || Reflect.ownKeys(parsed).some(key => !['version', 'pipeName', 'generation'].includes(key))
        || Reflect.ownKeys(parsed).length !== 3
        || parsed.version !== 2
        || typeof parsed.pipeName !== 'string'
        || !(linux ? linuxAuthority.validSocketPath(parsed.pipeName) : PIPE_RE.test(parsed.pipeName))
        || typeof parsed.generation !== 'string'
        || !/^[a-f0-9-]{36}$/.test(parsed.generation)) {
      const error = new Error('The owner-host capability record is invalid.');
      error.code = 'OWNER_PROXY_CAPABILITY_INVALID';
      throw error;
    }
    const isolated = environment.TOOLSENABLED_TEST_ISOLATED === '1';
    const expectedPipe = isolated ? String(environment.TOOLSENABLED_TEST_OWNER_HOST_PIPE || '') : null;
    if ((isolated && (!expectedPipe || parsed.pipeName !== expectedPipe))
        || (!isolated && !(linux
          ? linuxAuthority.validEndpoint(parsed.pipeName, parsed.generation)
          : parsed.pipeName.startsWith(PIPE_PREFIX)))) {
      const error = new Error('The owner-host capability record names an unexpected endpoint.');
      error.code = 'OWNER_PROXY_CAPABILITY_INVALID';
      throw error;
    }
    return Object.freeze({ version: 2, pipeName: parsed.pipeName, generation: parsed.generation });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    if (error && String(error.code || '').startsWith('OWNER_PROXY_')) throw error;
    const wrapped = new Error('The owner-host capability record could not be trusted.');
    wrapped.code = 'OWNER_PROXY_CAPABILITY_INVALID';
    throw wrapped;
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* the refusal path remains closed */ }
    }
  }
}

/* THE `id` OF EACH JSON-RPC LINE, WITHOUT HOLDING THE LINE.
 *
 * Both directions are forwarded byte for byte first and scanned second, so
 * nothing here can corrupt, delay or drop the stream: the worst a scan failure
 * costs is one request that is not tracked, which reads as one answer this
 * proxy does not get to write. Only the front of a line is kept
 * (RPC_ID_SCAN_BYTES), so a large tool result -- a screenshot is megabytes of
 * base64 -- costs one indexOf and no retained copy.
 *
 * Chunks are decoded latin1 on purpose rather than utf8: every byte of a UTF-8
 * continuation sequence is >= 0x80, so no multi-byte character can ever be
 * mistaken for one of the ASCII delimiters this looks for, and a character
 * split across two chunks cannot desynchronise a decoder that never existed. */
function createRpcIdScanner(onId) {
  let prefix = '';
  return chunk => {
    let rest = Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
    while (rest.length > 0) {
      const end = rest.indexOf('\n');
      const piece = end < 0 ? rest : rest.slice(0, end);
      if (prefix.length < RPC_ID_SCAN_BYTES) prefix += piece.slice(0, RPC_ID_SCAN_BYTES - prefix.length);
      if (end < 0) return;
      const line = prefix;
      prefix = '';
      rest = rest.slice(end + 1);
      const match = /"id"\s*:\s*(-?\d{1,19}|"(?:[^"\\]|\\.){0,256}")/.exec(line);
      if (!match) continue;
      let id;
      try { id = JSON.parse(match[1]); } catch { continue; }
      try { onId(id); } catch { /* tracking is diagnostic; never fail the stream */ }
    }
  };
}

function startInProcess(actor, agentId = null) {
  // Keep this exact in-process require boundary visible to the quiet-desktop
  // regression test.  Spawning src/mcp-server.js here would create a second
  // console-capable broker for every MCP connection.
  const broker = require('../src/mcp-server.js');
  broker.start({ agentActor: actor, ...(agentId ? { agentId } : {}) });
}

/* WHY THE TRANSPORT WENT AWAY, ANSWERED FROM THE RECORD THE APP PUBLISHES.
 *
 * The capability record is already this proxy's only discovery mechanism and
 * it already carries the app instance's `generation`. Re-reading it at the
 * moment of loss is therefore evidence, not inference: a record that now names
 * a different generation is a different app instance, which is exactly what a
 * runtime-generation activation's restart produces. `previous` is the record
 * this session actually authorized against; when it carries no generation
 * (a direct caller with a hand-made capability) nothing can be claimed about
 * instance identity and the conservative answer is given instead. */
function classifyTransportLoss(previous, readRecord) {
  let record = null;
  try { record = readRecord(); } catch { record = null; }
  if (!record) return Object.freeze({ code: TRANSPORT_LOST_CODES.UNAVAILABLE, sameInstance: false, record: null });
  if (typeof previous?.generation !== 'string' || typeof record.generation !== 'string') {
    return Object.freeze({ code: TRANSPORT_LOST_CODES.SESSION_ENDED, sameInstance: false, record });
  }
  if (record.generation !== previous.generation) {
    return Object.freeze({ code: TRANSPORT_LOST_CODES.SUPERSEDED, sameInstance: false, record });
  }
  return Object.freeze({ code: TRANSPORT_LOST_CODES.SESSION_ENDED, sameInstance: true, record });
}

function connectOwnerHost(capability, credential, dependencies = {}) {
  const connect = dependencies.connect || net.connect;
  const input = dependencies.input || process.stdin;
  const output = dependencies.output || process.stdout;
  const errorOutput = dependencies.errorOutput || process.stderr;
  const environment = dependencies.environment || process.env;
  const readRecord = dependencies.readCapabilityRecord
    || (() => readCapability(capabilityPath(environment), environment));
  const reconnectAttempts = Number.isInteger(dependencies.reconnectAttempts)
    ? dependencies.reconnectAttempts : RECONNECT_ATTEMPTS;
  const reconnectDelayMs = Number.isInteger(dependencies.reconnectDelayMs)
    ? dependencies.reconnectDelayMs : RECONNECT_DELAY_MS;
  const reconnectMaxDelayMs = Number.isInteger(dependencies.reconnectMaxDelayMs)
    ? dependencies.reconnectMaxDelayMs : Math.max(reconnectDelayMs, RECONNECT_MAX_DELAY_MS);
  const lingerMs = Number.isInteger(dependencies.lingerMs) ? dependencies.lingerMs : DEGRADED_LINGER_MS;
  const resolveWindowMs = Number.isInteger(dependencies.resolveWindowMs)
    ? dependencies.resolveWindowMs : RESOLVE_WINDOW_MS;
  const now = dependencies.now || (() => Date.now());
  const sessionCredential = agentSessionCredential({ TOOLSENABLED_AGENT_SESSION_CREDENTIAL: credential });

  let route = capability;
  let settled = false;
  let degraded = null;
  let socket = null;
  let clientWired = false;
  let lingerTimer = null;
  let reconnectTimer = null;
  const inFlight = new Set();

  const trackRequest = id => {
    if (inFlight.has(id)) return;
    // Bounded: an id this proxy can no longer name is one answer it cannot
    // write, which is the same cost as a scan that missed. Unbounded growth
    // over a long session would be a worse bug than the one being fixed.
    if (inFlight.size >= MAX_TRACKED_REQUESTS) inFlight.delete(inFlight.values().next().value);
    inFlight.add(id);
  };
  const scanFromClient = createRpcIdScanner(trackRequest);
  const scanFromHost = createRpcIdScanner(id => inFlight.delete(id));

  const answer = (id, code, { inFlightCall = false } = {}) => {
    const message = `${TRANSPORT_LOST_MESSAGES[code]}${inFlightCall ? IN_FLIGHT_SUFFIX : ''}`;
    output.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: TRANSPORT_LOST_RPC_CODE, message, data: { code } }
    })}\n`);
  };

  function onClientData(chunk) {
    if (settled) return;
    if (degraded) {
      const pending = [];
      createRpcIdScanner(id => pending.push(id))(chunk);
      for (const id of pending) answer(id, degraded);
      return;
    }
    scanFromClient(chunk);
    if (!socket || socket.destroyed) return;
    if (socket.write(chunk) === false) {
      input.pause();
      socket.once('drain', () => { if (!settled && !degraded && clientWired) input.resume(); });
    }
  }

  const detachClient = () => {
    if (!clientWired) return;
    clientWired = false;
    if (typeof input.off === 'function') input.off('data', onClientData);
    else if (typeof input.removeListener === 'function') input.removeListener('data', onClientData);
    input.pause();
  };

  /* Wires the client once, and RESUMES it every time. A reconnect pauses
   * stdin (onTransportLost) while the listener from the first connection
   * stays attached; resuming only on the first attach left every byte the
   * client wrote during the outage sitting in a paused stream forever, so a
   * "recovered" session answered nothing. */
  const attachClient = () => {
    if (!clientWired) {
      clientWired = true;
      input.on('data', onClientData);
    }
    input.resume();
  };

  const finish = (code, message = null) => {
    if (settled) return;
    settled = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
    detachClient();
    if (socket && !socket.destroyed) socket.destroy();
    socket = null;
    if (message) errorOutput.write(`${message}\n`);
    process.exitCode = code;
    // An MCP client commonly leaves stdin open forever. Destroying it is what
    // lets an owner-host closure actually terminate this proxy.
    if (typeof input.destroy === 'function' && input === process.stdin) input.destroy();
  };

  /* THE DEGRADED STATE: NAMED, VISIBLE, AND STILL ANSWERING.
   *
   * Exiting here is what made T159 invisible. The process stays, the client's
   * stdin stays open, and every request -- the one that was in flight and
   * every one after it -- is answered with the named reason, so the agent
   * reads a product sentence in its own transcript instead of a dead pipe.
   * It is bounded: after `lingerMs` with the client still asking, this stops
   * costing a process and exits non-zero with the same named reason. */
  const enterDegraded = code => {
    if (settled || degraded) return;
    degraded = code;
    if (socket && !socket.destroyed) socket.destroy();
    socket = null;
    for (const id of inFlight) answer(id, code, { inFlightCall: true });
    inFlight.clear();
    const line = `${code}: ${TRANSPORT_LOST_MESSAGES[code]}`;
    errorOutput.write(`${line}\n`);
    if (!clientWired) { finish(1, null); return; }
    input.resume();
    lingerTimer = setTimeout(() => finish(1, line), lingerMs);
  };

  const onTransportLost = () => {
    if (settled || degraded) return;
    input.pause();
    let remaining = reconnectAttempts;
    // Every wait in this recovery -- polls for an absent record and retries
    // against a present one -- walks the same backoff schedule. It restarts
    // from the base only when a connection is authorized again.
    let waits = 0;
    const deadline = now() + resolveWindowMs;
    errorOutput.write(`${TRANSPORT_RECOVERING_CODE}: ${TRANSPORT_RECOVERING_MESSAGE}\n`);
    const later = () => {
      const delay = reconnectDelayFor(waits, { baseMs: reconnectDelayMs, maxMs: reconnectMaxDelayMs });
      waits += 1;
      reconnectTimer = setTimeout(tryAgain, delay);
    };
    function tryAgain() {
      if (settled || degraded) return;
      const verdict = classifyTransportLoss(route, readRecord);
      /* NOT BACK YET IS NOT GONE. A restarting app has removed its record and
         has not published the next one; concluding from that single read that
         the app is gone would convict the restart that is in progress. Poll to
         the deadline first. A record naming another generation is a complete
         answer and is never polled. */
      if (verdict.code === TRANSPORT_LOST_CODES.UNAVAILABLE && now() < deadline) { later(); return; }
      // Only a still-published SAME instance is worth another handshake, and
      // that handshake proves nothing on its own: the host re-checks the
      // credential, so a session it deliberately retired stays retired.
      if (!verdict.sameInstance || remaining <= 0) { enterDegraded(verdict.code); return; }
      remaining -= 1;
      route = verdict.record;
      errorOutput.write(`${TRANSPORT_RECOVERING_CODE}: reconnect attempt ${reconnectAttempts - remaining} of ${reconnectAttempts}\n`);
      attempt(verdict.record, () => {
        // Back in service on the same app instance. The call that was running
        // when the transport dropped is still unanswerable, so it is answered
        // now rather than left to hang behind a working connection -- but it is
        // answered as an INTERRUPTED CALL, not an ended session: this session
        // is serving, and saying otherwise would send a working agent away.
        // Calls the client made while the connection was down were held, and
        // flow now.
        for (const id of inFlight) answer(id, TRANSPORT_LOST_CODES.CALL_INTERRUPTED, { inFlightCall: true });
        inFlight.clear();
        errorOutput.write(`${TRANSPORT_RECOVERING_CODE}: reconnected; this session's tools are serving again\n`);
        attachClient();
      }, () => {
        if (settled || degraded) return;
        later();
      });
    }
    tryAgain();
  };

  /* ONE ATTEMPT AT THE ROUTE THE RECORD NAMES. `onReady` runs only after the
   * host has authorized; `onRefused` carries every other outcome, so the first
   * connection still fails closed exactly as it always did while a reconnect
   * feeds the same outcome back into the retry loop. */
  function attempt(cap, onReady, onRefused) {
    let authorized = false;
    let done = false;
    let buffer = '';
    let timer = null;
    let peerVerified = process.platform !== 'linux';
    let active;
    const refuse = () => {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (active && !active.destroyed) active.destroy();
      if (socket === active) socket = null;
      onRefused();
    };
    try {
      if (!peerVerified) linuxAuthority.assertSocket(cap.pipeName);
      active = connect({ path: cap.pipeName });
      active.setEncoding('utf8');
    } catch { refuse(); return; }
    socket = active;
    timer = setTimeout(refuse, HANDSHAKE_TIMEOUT_MS);
    if (typeof timer?.unref === 'function') timer.unref();
    const sendHandshake = () => {
      if (done || active.destroyed) return;
      active.write(`${JSON.stringify({ type: 'authorize-session', credential: sessionCredential })}\n`);
    };
    active.once('connect', () => {
      if (peerVerified) { sendHandshake(); return; }
      active.pause();
      linuxAuthority.assertPeer(active).then(() => {
        if (done || active.destroyed) return;
        peerVerified = true;
        sendHandshake();
        active.resume();
      }, refuse);
    });
    active.on('data', chunk => {
      if (settled) return;
      if (!peerVerified) { refuse(); return; }
      if (authorized) {
        output.write(chunk);
        scanFromHost(chunk);
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_HANDSHAKE_BYTES) { refuse(); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const line = buffer.slice(0, end).replace(/\r$/, '');
      const remainder = buffer.slice(end + 1);
      let response;
      try { response = JSON.parse(line); } catch { refuse(); return; }
      if (!plain(response) || response.type !== 'authorized' || response.protocolVersion !== 2) {
        refuse();
        return;
      }
      authorized = true;
      done = true;
      buffer = '';
      clearTimeout(timer);
      timer = null;
      if (remainder) { output.write(remainder); scanFromHost(remainder); }
      onReady();
    });
    /* Before authorization either endpoint ending is a refusal: the app never
     * accepted this connection. After authorization, stdin ending first is the
     * client choosing to stop -- an ordinary, silent shutdown -- while the
     * socket going away means the app's tool host left a running agent, which
     * is the case this proxy now names instead of dying quietly. */
    const ended = () => {
      if (!authorized) { refuse(); return; }
      if (settled || socket !== active) return;
      socket = null;
      onTransportLost();
    };
    active.once('close', ended);
    active.once('error', ended);
  }

  // Do not consume even one JSON-RPC byte until the host authenticates. Node's
  // stdio stream is paused initially in most clients, but making it explicit
  // prevents a fast caller from racing the authorization exchange.
  input.pause();
  input.once('end', () => finish(degraded ? 1 : 0, null));
  input.once('error', () => finish(degraded ? 1 : 0, null));
  attempt(capability, attachClient, () => finish(1, REFUSAL));
  return socket;
}
function main(environment = process.env) {
  let capability;
  try {
    capability = readCapability(capabilityPath(environment), environment);
  } catch {
    process.stderr.write(`${REFUSAL}\n`);
    process.exitCode = 1;
    return null;
  }
  if (!capability) {
    // A generated named-agent config always carries both of these values.  Do
    // not let an absent owner host turn that authenticated route into the old
    // caller-chosen environment route.  This check deliberately happens before
    // parsing the provider actor: no environment combination can opt back in.
    if (environment.TOOLSENABLED_AGENT_SESSION_CREDENTIAL !== undefined
        || environment.TOOLSENABLED_AGENT_ID !== undefined) {
      process.stderr.write(`${REFUSAL}\n`);
      process.exitCode = 1;
      return null;
    }
    let actor;
    try {
      actor = agentActor(environment);
    } catch {
      process.stderr.write(`${REFUSAL}\n`);
      process.exitCode = 1;
      return null;
    }
    startInProcess(actor, null);
    return null;
  }
  let credential;
  try { credential = agentSessionCredential(environment); }
  catch {
    process.stderr.write(`${REFUSAL}\n`);
    process.exitCode = 1;
    return null;
  }
  return connectOwnerHost(capability, credential);
}

if (require.main === module) main();

module.exports = Object.freeze({
  AGENT_ACTORS,
  CAPABILITY_FILE_NAME,
  HANDSHAKE_TIMEOUT_MS,
  PIPE_PREFIX,
  REFUSAL,
  DEGRADED_LINGER_MS,
  IN_FLIGHT_SUFFIX,
  RECONNECT_ATTEMPTS,
  RECONNECT_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RESOLVE_WINDOW_MS,
  TRANSPORT_LOST_CODES,
  TRANSPORT_LOST_MESSAGES,
  TRANSPORT_LOST_RPC_CODE,
  TRANSPORT_RECOVERING_CODE,
  TRANSPORT_RECOVERING_MESSAGE,
  agentActor,
  agentIdentity,
  agentSessionCredential,
  canonicalToken,
  capabilityPath,
  classifyTransportLoss,
  connectOwnerHost,
  createRpcIdScanner,
  main,
  readCapability,
  reconnectDelayFor,
  startInProcess
});
