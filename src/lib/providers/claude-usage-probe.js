'use strict';
// A LIVE, ZERO-TOKEN READ OF HOW MUCH OF A CLAUDE ACCOUNT IS LEFT.
//
// WHY THIS EXISTS BESIDE THE CACHE READ. ../multi-account/claude-allowance.js
// reads the usage figures Claude Code last cached in `.claude.json`. That is
// free, but it is only as fresh as the last time THAT account's CLI fetched
// usage, and an idle account's cache is exactly the one that is old. The only
// other surface that reports a figure used to be a real `--print` turn, which
// spends allowance to learn how much allowance is left. This module is the
// third way: the CLI's own stream-json CONTROL PROTOCOL answers a `get_usage`
// request from its signed-in session without a model turn, and the read
// refreshes the cache above as a side effect, so the two routes then agree.
//
// It is the same call the Claude Agent SDK makes for its experimental usage
// read. The CLI's own description of the request, verbatim from the 2.1.258
// binary: "Requests the structured /usage data: session cost/usage totals plus
// claude.ai plan rate-limit utilization when available. Experimental -- the
// response shape may change." That last clause is why every field below is
// read defensively and why an unreadable reply is UNKNOWN, never a guess.
//
// MEASURED 2026-09-02 against Claude Code 2.1.258 (both the npm-global
// claude.exe that executableFor() resolves and the .local\bin copy answered
// identically). The spawn is exactly:
//
//     claude -p --input-format stream-json --output-format stream-json --verbose
//
// with the same scrubbed environment the auth probe uses, CLAUDE_CONFIG_DIR
// pointed at the account's home, CLAUDECODE removed (the CLI refuses to nest
// inside another Claude Code session), and cwd an empty scratch directory.
// One line on stdin:
//
//     {"type":"control_request","request_id":"usage-1",
//      "request":{"subtype":"get_usage"}}
//
// THE WORKING SEQUENCE IS THAT ONE LINE. No `initialize` control request is
// needed first (sending one works too and is answered separately), and no user
// message is needed: the reply arrived 0.9-1.7 s after the request, before
// any prompt, with `session.total_cost_usd: 0`. The CLI stays alive waiting for
// input afterwards and exits about 300 ms after stdin is closed. This module
// closes stdin after the reply and confirms owned tree and pipe closure.
//
// The signed-in reply, trimmed. THE SHAPE AND THE KEY SET ARE AS MEASURED;
// every figure, timestamp, plan name and model name below is invented, so
// nothing here describes a real account:
//
//     {"type":"control_response","response":{"subtype":"success",
//       "request_id":"usage-1","response":{
//         "session":{"total_cost_usd":0,...},
//         "subscription_type":"sample-plan",
//         "rate_limits_available":true,
//         "rate_limits":{
//           "five_hour":{"utilization":11,"resets_at":"2031-01-01T01:00:00.000000+00:00",...},
//           "seven_day":{"utilization":22,"resets_at":"2031-01-07T07:00:00.000000+00:00",...},
//           "seven_day_oauth_apps":null,"seven_day_opus":null,"seven_day_sonnet":null,
//           ...other named buckets, most null...
//           "limits":[
//             {"kind":"session","group":"session","percent":11,"severity":"normal",
//              "resets_at":"...","scope":null,"is_active":false},
//             {"kind":"weekly_all","group":"weekly","percent":22,...,"is_active":false},
//             {"kind":"weekly_scoped","group":"weekly","percent":44,...,
//              "scope":{"model":{"id":null,"display_name":"Example Model"},"surface":null},
//              "is_active":true}],
//           "model_scoped":[{"display_name":"Example Model","utilization":44,"resets_at":"..."}],
//           ...},
//         "behaviors":{...}}}}
//
// The reply from an EMPTY config directory (nothing signed in), and from a
// directory that does not exist -- the CLI creates it, with a fresh
// `.claude.json`, `.last-cleanup`, `backups/` and `sessions/` inside, so the
// caller must hand this module a resolved, real account home and never a
// guess:
//
//     {"type":"control_response","response":{"subtype":"success",
//       "request_id":"usage-1","response":{"session":{...},
//       "subscription_type":null,"rate_limits_available":false,
//       "rate_limits":null,"behaviors":null}}}
//
// The CLI's own schema says `rate_limits_available` is "False when plan rate
// limits do not apply (API key, Bedrock, Vertex, or missing profile scope) --
// rate_limits will be null." That is answered here as UNKNOWN with a reason,
// because "no limits apply" is not "plenty of room": it is a session that is
// not on the subscription at all.
//
// THE SHAPE THIS RETURNS IS THE CACHE ADAPTER'S SHAPE, on purpose. The brief
// for this module expected the reply to carry no `is_active` flag and asked
// for "active" to mean the highest-utilization window. The measurement found
// otherwise: `rate_limits.limits[]` is byte-for-byte the array Claude Code
// writes into `.claude.json` as `cachedUsageUtilization.utilization.limits`,
// with the provider's own `is_active` on each entry. So when that array is
// present and well-formed it is normalised exactly the way
// ../usage/adapters/claude-cached-utilization.js normalises the cache (kind,
// group, applicability, percent, resetsAt, model, isActive, index), and
// ../multi-account/usage-windows.js reads both routes with one function. Only
// when the array is absent or unreadable does this fall back to the named
// windows (`five_hour`, `seven_day`, `seven_day_*`), with group and model null
// and the highest-utilization measured window marked active -- the rule the
// brief asked for, kept for the case the brief described.
//
// WHAT THIS NEVER DOES. It writes no user message, so it spends no tokens. It
// reads no file: the CLI fetches usage with its own stored session, and this
// module sees only the figures. It contains no file-reading verb at all (the
// scratch directory is created and removed, never read), and
// tests/providers/claude-usage-probe.test.js holds its source to that. It
// returns UNKNOWN for unavailable usage. Unproved process cleanup is different:
// it throws the shared lifecycle error with its retained retryCleanup operation,
// so another check cannot start while the previous provider may still be live.

const { spawnHidden } = require('../proc/hidden-spawn');
const { createStartupCleanup, DEFAULT_CLEANUP_TIMEOUT_MS } = require('../agent-engine/codex-startup-cleanup');
const { probeLifecycleOf, withProbeLifecycle } = require('../multi-account/probe-lifecycle');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const { executableFor } = require('./cli-provider-gateway.js');
const { safeLaunchEnvironment } = require('./subscription-launch-env.js');

// Measured: the reply takes under two seconds on this machine. Twenty seconds
// is the same order of patience the auth probe's status call gets.
const DEFAULT_USAGE_TIMEOUT_MS = 20000;

// HOW THE CLI IS LET GO, and why it is not simply killed. Measured: the CLI
// exits about 300 ms after its stdin is closed. Killing it the instant the
// reply arrives left its scratch cwd locked for a moment, so the folder could
// not be removed and was left behind. So stdin is closed first and the exit
// is awaited; only a CLI that outstays this grace is terminated, and even
// then the shared process owner must prove that the whole tree has ended.
const DEFAULT_EXIT_GRACE_MS = 3000;

const PROBE_ARGS = Object.freeze(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
const CONTROL_SUBTYPE = 'get_usage';
const SOURCE = 'claude-get-usage';

// The named windows the CLI's schema documents, in the order they are named
// there. Used only when the `limits` array is not usable.
const NAMED_WINDOWS = Object.freeze(['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet']);

// A reply is one line. Bound the combined UTF-8 bytes of stdout and stderr;
// stderr is counted but never retained. Keep the exported name for callers.
const MAX_STDOUT_CHARS = 1024 * 1024;

const APPLICABILITY = Object.freeze({
  MEASURED: 'MEASURED',
  NOT_APPLICABLE: 'NOT_APPLICABLE'
});

const UNKNOWN_REASON = Object.freeze({
  CONFIG_DIR_INVALID: 'CLAUDE_USAGE_CONFIG_DIR_INVALID',
  ENVIRONMENT_REFUSED: 'CLAUDE_USAGE_ENVIRONMENT_REFUSED',
  SCRATCH_UNAVAILABLE: 'CLAUDE_USAGE_SCRATCH_UNAVAILABLE',
  SPAWN_FAILED: 'CLAUDE_USAGE_SPAWN_FAILED',
  TIMEOUT: 'CLAUDE_USAGE_TIMEOUT',
  NO_REPLY: 'CLAUDE_USAGE_NO_REPLY',
  CONTROL_ERROR: 'CLAUDE_USAGE_CONTROL_ERROR',
  MALFORMED: 'CLAUDE_USAGE_MALFORMED',
  RATE_LIMITS_UNAVAILABLE: 'CLAUDE_USAGE_RATE_LIMITS_UNAVAILABLE',
  FETCH_UNAVAILABLE: 'CLAUDE_USAGE_FETCH_UNAVAILABLE',
  NO_MEASURED_WINDOW: 'CLAUDE_USAGE_NO_MEASURED_WINDOW',
  FAULT: 'CLAUDE_USAGE_FAULT'
});

let requestCounter = 0;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unknown(reason, detail) {
  return Object.freeze({ status: 'UNKNOWN', reason, detail: detail || null });
}

function codeOf(error) {
  if (!error) return 'unknown fault';
  if (typeof error.code === 'string' && error.code) return error.code;
  if (typeof error.message === 'string' && error.message) return error.message;
  return 'unknown fault';
}

/* One entry of `rate_limits.limits[]`, held to the same rules the cache
   adapter applies to the same array: a null percent is a window that does not
   apply, and a missing `is_active` is drift, not false. */
function normalizeLimit(raw, index) {
  if (!plainObject(raw) || typeof raw.kind !== 'string') return null;
  if (raw.percent !== null && !Number.isFinite(raw.percent)) return null;
  if (typeof raw.is_active !== 'boolean') return null;
  const model =
    plainObject(raw.scope) && plainObject(raw.scope.model) && typeof raw.scope.model.display_name === 'string'
      ? raw.scope.model.display_name
      : null;
  return Object.freeze({
    kind: raw.kind,
    group: typeof raw.group === 'string' ? raw.group : null,
    applicability: raw.percent === null ? APPLICABILITY.NOT_APPLICABLE : APPLICABILITY.MEASURED,
    percent: raw.percent === null ? null : raw.percent,
    resetsAt: typeof raw.resets_at === 'string' ? raw.resets_at : null,
    model,
    isActive: raw.is_active,
    index
  });
}

/* The provider's own array, or null when it is absent or any entry has
   drifted -- in which case the named windows below are the fallback rather
   than a partial array presented as the whole. */
function limitsFromArray(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const limits = raw.map(normalizeLimit);
  if (limits.some(limit => limit === null)) return null;
  return Object.freeze(limits);
}

/* The named windows, for a build whose reply carries no `limits` array. A
   null window is one that does not apply to the plan; an object with a finite
   `utilization` is measured; anything else is left out. With no `is_active`
   from the provider, the single most-used measured window is marked active --
   the ceiling the account is nearest to is the one constraining it. Ties go
   to the first in the schema's order, so the answer is stable. */
function limitsFromNamedWindows(rateLimits) {
  const limits = [];
  for (const field of NAMED_WINDOWS) {
    const raw = rateLimits[field];
    const measured = plainObject(raw) && Number.isFinite(raw.utilization);
    const inapplicable = raw === null || (plainObject(raw) && raw.utilization === null);
    if (!measured && !inapplicable) continue;
    limits.push({
      kind: field,
      group: null,
      applicability: measured ? APPLICABILITY.MEASURED : APPLICABILITY.NOT_APPLICABLE,
      percent: measured ? raw.utilization : null,
      resetsAt: plainObject(raw) && typeof raw.resets_at === 'string' ? raw.resets_at : null,
      model: null,
      isActive: false,
      index: limits.length
    });
  }
  let worst = null;
  for (const limit of limits) {
    if (limit.applicability !== APPLICABILITY.MEASURED) continue;
    if (worst === null || limit.percent > worst.percent) worst = limit;
  }
  if (worst) worst.isActive = true;
  return Object.freeze(limits.map(limit => Object.freeze(limit)));
}

/**
 * Pure. The `response.response` object of a successful `get_usage` control
 * reply, normalised to the cache adapter's MEASURED shape, or UNKNOWN with a
 * reason. `now` stamps `fetchedAtMs`; a live read is zero milliseconds old.
 */
function normalizeUsageReply(reply, { now = () => Date.now() } = {}) {
  if (!plainObject(reply)) return unknown(UNKNOWN_REASON.MALFORMED, 'The usage reply was not an object.');
  if (reply.rate_limits_available !== true) {
    const plan = typeof reply.subscription_type === 'string' && reply.subscription_type ? reply.subscription_type : null;
    return unknown(UNKNOWN_REASON.RATE_LIMITS_UNAVAILABLE, plan
      ? `No plan rate limits were reported for this ${plan} sign-in.`
      : 'No plan rate limits apply to this sign-in. It may be signed out or billing a metered key.');
  }
  const rateLimits = reply.rate_limits;
  // In Claude Code 2.1.259 availability means plan eligibility. The handler
  // still returns null when its fetch is empty or unavailable; no percentage
  // or sign-out follows from that valid reply.
  if (rateLimits === null) {
    return unknown(UNKNOWN_REASON.FETCH_UNAVAILABLE, 'Claude could not retrieve this plan’s allowance just now.');
  }
  if (!plainObject(rateLimits)) {
    return unknown(UNKNOWN_REASON.MALFORMED, 'rate_limits_available was true but rate_limits was not an object.');
  }
  const limits = limitsFromArray(rateLimits.limits) || limitsFromNamedWindows(rateLimits);
  const measured = limits.filter(limit => limit.applicability === APPLICABILITY.MEASURED);
  if (measured.length === 0) {
    return unknown(UNKNOWN_REASON.NO_MEASURED_WINDOW, 'The usage reply named no window with a measured percentage.');
  }
  const active = measured.filter(limit => limit.isActive);
  const fetchedAtMs = now();
  return Object.freeze({
    status: 'MEASURED',
    source: SOURCE,
    fetchedAtMs: Number.isFinite(fetchedAtMs) ? fetchedAtMs : Date.now(),
    ageMs: 0,
    accountUuid: null,
    subscriptionType: typeof reply.subscription_type === 'string' ? reply.subscription_type : null,
    limits,
    // One number, when the provider named exactly one active ceiling; null
    // otherwise, said plainly rather than substituting the largest.
    bindingLimit: active.length === 1 ? active[0] : null,
    activeLimits: Object.freeze(active)
  });
}

/* A stdout line, judged. Null when it is not the reply to this request (the
   CLI emits other lines on this channel and may answer other requests); an
   UNKNOWN record when it is the reply and says error; otherwise the payload. */
function matchReply(line, requestId) {
  if (typeof line !== 'string' || line.trim() === '') return null;
  let parsed;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!plainObject(parsed) || parsed.type !== 'control_response' || !plainObject(parsed.response)) return null;
  const response = parsed.response;
  if (response.request_id !== requestId) return null;
  if (response.subtype !== 'success') {
    // The CLI's own error text is not forwarded: a result reaches the menu
    // and the logs, and provider text is the one place a value could echo.
    return { failure: unknown(UNKNOWN_REASON.CONTROL_ERROR, 'The Claude CLI refused the usage request.') };
  }
  return { reply: response.response };
}

/* A reply is not a completed check until the owned process tree has closed.
   The same cleanup API backs account probes and agent startup on both OSes. */
async function exchange(command, args, { env, cwd, timeoutMs, exitGraceMs, spawnImpl, requestId }) {
  let child = null;
  let cleanup = null;
  let closed = false;
  let onClosed;
  const closedPromise = new Promise(resolve => { onClosed = resolve; });
  let timer;
  const answer = await new Promise(resolve => {
    let settled = false;
    let buffered = '';
    let seen = 0;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      finish({ failure: unknown(UNKNOWN_REASON.TIMEOUT, `The Claude CLI gave no usage reply within ${timeoutMs} ms.`) });
    }, timeoutMs);

    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        windowsHide: true,
        containProcessTree: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      child = null;
      return finish({ failure: unknown(UNKNOWN_REASON.SPAWN_FAILED, `The Claude CLI could not be started (${codeOf(error)}).`) });
    }
    if (!child || typeof child.on !== 'function' || typeof child.once !== 'function' || !child.stdin || typeof child.stdin.write !== 'function') {
      child = null;
      return finish({ failure: unknown(UNKNOWN_REASON.SPAWN_FAILED, 'The spawn seam returned no usable child process.') });
    }
    cleanup = createStartupCleanup(child);

    child.on('error', error => {
      finish({ failure: unknown(UNKNOWN_REASON.SPAWN_FAILED, `The Claude CLI could not be started (${codeOf(error)}).`) });
    });
    child.on('close', code => {
      closed = true;
      onClosed();
      finish({ failure: unknown(UNKNOWN_REASON.NO_REPLY, `The Claude CLI exited (code ${code}) before answering the usage request.`) });
    });
    const withinOutputBudget = chunk => {
      if (settled) return false;
      seen += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
      if (seen <= MAX_STDOUT_CHARS) return true;
      finish({ failure: unknown(UNKNOWN_REASON.MALFORMED, 'The Claude CLI wrote a great deal of output but no usage reply.') });
      return false;
    };
    // Count stderr without retaining it. Both streams share a bounded budget.
    child.stderr?.on('data', chunk => { withinOutputBudget(chunk); });
    child.stdin.on?.('error', error => {
      finish({ failure: unknown(UNKNOWN_REASON.SPAWN_FAILED, `The usage request could not be written (${codeOf(error)}).`) });
    });
    /* THE STREAM IS DECODED ONCE, NOT ONCE PER CHUNK.
     *
     * `chunk.toString('utf8')` decodes each chunk on its own, so a character
     * whose bytes straddle a chunk boundary is torn in half and both halves
     * come back as U+FFFD. The reply this reads carries provider-written text
     * -- the model display name in `limits[].scope.model.display_name`, which
     * ../multi-account/usage-windows.js puts straight into a window's `label`
     * and the accounts menu shows -- so the corruption lands on a screen a
     * person reads. A StringDecoder holds the partial sequence back until the
     * next chunk completes it, which is the same decode the whole stream would
     * have got had it arrived in one piece. Chunking is not hypothetical: the
     * measured reply is ~4 KB and the suite beside this one already splits it.
     *
     * The string branch stays: the injected spawn seam may hand text straight
     * through, and StringDecoder.write() takes bytes only. */
    const decoder = new StringDecoder('utf8');
    child.stdout?.on('data', chunk => {
      if (!withinOutputBudget(chunk)) return;
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      buffered += text;
      let index;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        const answer = matchReply(line, requestId);
        if (answer) return finish(answer);
      }
    });

    const request = JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: CONTROL_SUBTYPE }
    });
    try {
      child.stdin.write(`${request}\n`);
    } catch (error) {
      finish({ failure: unknown(UNKNOWN_REASON.SPAWN_FAILED, `The usage request could not be written (${codeOf(error)}).`) });
    }
  });
  if (!cleanup) return answer;
  try { child.stdin.end(); } catch { /* closure is confirmed below */ }
  if (!closed) {
    let graceTimer;
    try {
      await Promise.race([closedPromise, new Promise(resolve => { graceTimer = setTimeout(resolve, exitGraceMs); })]);
    } finally { clearTimeout(graceTimer); }
  }
  const receipt = await cleanup.confirmClosed(DEFAULT_CLEANUP_TIMEOUT_MS);
  return withProbeLifecycle(answer, receipt.type === 'not-started' ? 'not-started' : 'closed');
}

async function runUsageProbe({
  configDir, timeoutMs, exitGraceMs, baseEnvironment, spawnImpl, executable, cwd, fsImpl, now
}) {
  if (typeof configDir !== 'string' || configDir.trim() === '') {
    return unknown(UNKNOWN_REASON.CONFIG_DIR_INVALID, 'No account home was named, so there is nothing to read usage for.');
  }
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_USAGE_TIMEOUT_MS;
  const grace = Number.isFinite(exitGraceMs) && exitGraceMs >= 0 ? exitGraceMs : DEFAULT_EXIT_GRACE_MS;

  // The same scrub the auth probe and every launch use: ambient billing
  // credentials are removed so the CLI answers for the subscription login and
  // not for a metered key. The scrub can refuse outright, and that refusal is
  // a stated nothing here rather than an exception.
  let env;
  try {
    env = safeLaunchEnvironment(baseEnvironment, { context: 'claude usage probe' });
    env = require('../provider-session-isolation').providerSessionEnvironment(env,
      { provider: 'claude', home: configDir, requireHome: true });
  } catch (error) {
    return unknown(UNKNOWN_REASON.ENVIRONMENT_REFUSED, `The launch environment was refused (${codeOf(error)}).`);
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  // The CLI refuses to start inside another Claude Code session, and this
  // product may well be running inside one. The variable is only a marker.
  delete env.CLAUDECODE;

  const exe = require('../provider-session-isolation').resolvePrivateProviderExecutable('claude', baseEnvironment)
    || executable || executableFor('claude', { environment: baseEnvironment });
  Object.assign(env, exe.env || {});

  // An empty scratch cwd keeps the CLI from loading any project context; a
  // probe whose cwd is a repository would read that repository's CLAUDE.md for
  // nothing. Without the scratch the probe does not run at all rather than
  // falling back to the caller's cwd.
  let scratch = cwd;
  let createdScratch = false;
  if (!scratch) {
    try {
      scratch = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-probe-'));
      createdScratch = true;
    } catch (error) {
      return unknown(UNKNOWN_REASON.SCRATCH_UNAVAILABLE, `An empty working folder could not be created (${codeOf(error)}).`);
    }
  }

  requestCounter += 1;
  const requestId = `usage-${process.pid}-${requestCounter}`;
  try {
    const answer = await exchange(exe.command, [...(exe.prefixArgs || []), ...PROBE_ARGS], {
      env, cwd: scratch, timeoutMs: budget, exitGraceMs: grace, spawnImpl, requestId
    });
    const reading = answer.failure || normalizeUsageReply(answer.reply, { now }), lifecycle = probeLifecycleOf(answer);
    return lifecycle ? withProbeLifecycle(reading, lifecycle) : reading;
  } finally {
    if (createdScratch && scratch) {
      try { fsImpl.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Read one Claude account's plan usage from its own signed-in CLI, spending
 * nothing. `configDir` is that account's home (CLAUDE_CONFIG_DIR), already
 * resolved to a real directory by the caller.
 *
 * Resolves to the cache adapter's MEASURED shape with `source:
 * 'claude-get-usage'`, or to `{ status: 'UNKNOWN', reason, detail }`. Never
 * returns unavailable usage as UNKNOWN. It returns a measurement only after
 * owned closure; cleanup failure rejects with the retained retry operation.
 */
async function claudeUsageProbe({
  configDir = null,
  timeoutMs = DEFAULT_USAGE_TIMEOUT_MS,
  exitGraceMs = DEFAULT_EXIT_GRACE_MS,
  baseEnvironment = process.env,
  spawnImpl = spawnHidden,
  executable = null,
  cwd = null,
  fsImpl = fs,
  now = () => Date.now()
} = {}) {
  try {
    return await runUsageProbe({ configDir, timeoutMs, exitGraceMs, baseEnvironment, spawnImpl, executable, cwd, fsImpl, now });
  } catch (error) {
    if (error?.code === 'CODEX_PROCESS_CLEANUP_UNPROVEN') throw error;
    return unknown(UNKNOWN_REASON.FAULT, `The usage read failed before it could answer (${codeOf(error)}).`);
  }
}

module.exports = Object.freeze({
  APPLICABILITY,
  CONTROL_SUBTYPE,
  DEFAULT_EXIT_GRACE_MS,
  DEFAULT_USAGE_TIMEOUT_MS,
  MAX_STDOUT_CHARS,
  NAMED_WINDOWS,
  PROBE_ARGS,
  SOURCE,
  UNKNOWN_REASON,
  claudeUsageProbe,
  normalizeUsageReply
});
