'use strict';
// Real Claude account state, measured from the provider -- never inferred
// from a credential file.
//
// WHY NOT A FILE CHECK. The sibling lane measured the trap on the Codex side
// on 2026-08-10 and it applies identically here. `codex login status` is a
// file read: it answered "Logged in using ChatGPT" while the id_token in
// ~/.codex/auth.json had expired the day before. The INVERSE is equally
// wrong, which is why "just read the expiry" is not the fix either: the .edu
// Codex home, whose id_token had expired, served a live request anyway
// because the CLI silently refreshed off its refresh_token. Reading a token
// file can say alive-when-dead OR dead-when-alive. So this module reads no
// token, no expiry, and no credential of any kind. It asks the provider.
//
// TWO SURFACES, AND ONLY ONE OF THEM PROVES ANYTHING.
//
//   Tier 1  `claude auth status --json`  -- free, no tokens.
//           Measured 2026-08-10, signed in and scrubbed:
//             {"loggedIn":true,"authMethod":"claude.ai",
//              "apiProvider":"firstParty","email":"...",
//              "subscriptionType":"max"}                        exit 0
//           Measured signed out (isolated empty CLAUDE_CONFIG_DIR):
//             {"loggedIn":false,"authMethod":"none",
//              "apiProvider":"firstParty"}                      exit 1
//           This proves IDENTITY and the BILLING ROUTE. It does not prove the
//           account can serve a request, so it can never on its own produce
//           `authenticated` here.
//
//   Tier 2  a minimal `--print` request -- costs a little allowance, and is
//           the ONLY thing that proves the account actually works.
//
// THE BILLING TELL. Measured 2026-08-10 with the machine-wide
// ANTHROPIC_API_KEY present (it is persisted in HKCU:\Environment on this
// machine), tier 1 reports:
//     loggedIn: true, authMethod: "claude.ai", subscriptionType: "max",
//     apiKeySource: "ANTHROPIC_API_KEY"
// Every field a health check would look at is green, and the session is
// billing per token instead of using the Max subscription. `apiKeySource` is
// the field that gives it away. It names a VARIABLE, never a value, so it is
// safe to read and safe to report. This module reports billingSource as
// 'subscription' | 'api_key' and never touches the key itself.
//
// A TRAP IN THE TIER 2 ENVELOPE. The signed-out `--print` response carries
// `"subtype":"success"` alongside `"is_error":true`. Keying on `subtype`
// would turn a hard auth failure into a green. Classification below uses
// `is_error` and the exit code, never `subtype`.
//
// NEVER `--bare`. Its own help states: "Anthropic auth is strictly
// ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are
// never read)". Probing with --bare would bill the API and would say nothing
// about the subscription login this module exists to measure.

const { spawnHidden } = require('../proc/hidden-spawn');
const { createStartupCleanup, DEFAULT_CLEANUP_TIMEOUT_MS } = require('../agent-engine/codex-startup-cleanup');
const { probeLifecycleOf, withProbeLifecycle } = require('../multi-account/probe-lifecycle');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const { executableFor } = require('./cli-provider-gateway.js');
const { safeLaunchEnvironment } = require('./subscription-launch-env.js');

const DEFAULT_STATUS_TIMEOUT_MS = 30000;
const DEFAULT_CAPABILITY_TIMEOUT_MS = 120000;
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;

// The probe prompt. Deliberately trivial: the answer is irrelevant, only the
// fact that the provider served it at all is the measurement.
const CAPABILITY_PROMPT = 'Reply with the single word: ok';

const STATE = Object.freeze({
  AUTHENTICATED: 'authenticated',
  EXPIRED: 'expired',
  SIGNED_OUT: 'signed_out',
  RATE_LIMITED: 'rate_limited',
  INDETERMINATE: 'indeterminate'
});

// Which states are evidence about the ACCOUNT, and so may drive a failover.
// `indeterminate` is deliberately excluded: a spawn failure, a timeout or an
// unparseable envelope is evidence about the transport, not the account.
// Failing over on it would abandon a healthy account and spend a second one
// for nothing -- the exact harm the multi-account lane exists to prevent.
const FAILOVER_STATES = Object.freeze(new Set([STATE.EXPIRED, STATE.SIGNED_OUT, STATE.RATE_LIMITED]));

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const parsed = JSON.parse(text);
    return plainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Patterns are matched against the provider's own error text. They never
// capture, and the matched text is never returned or logged -- only the state
// it implies.
const AUTH_FAILURE_PATTERN = /not logged in|please run \/login|invalid api key|authentication[_ ]error|unauthorized|401|oauth token (?:has )?expired|refresh token|session (?:has )?expired|credentials? (?:are )?(?:invalid|expired)/i;
const RATE_LIMIT_PATTERN = /rate[_ ]?limit|usage limit|too many requests|429|quota exceeded|overloaded|capacity/i;

function billingSourceOf(status) {
  if (!plainObject(status)) return null;
  // apiKeySource names the VARIABLE the CLI chose to authenticate with. Its
  // presence is the whole signal; its value is never read.
  if (typeof status.apiKeySource === 'string' && status.apiKeySource.trim() !== '') return 'api_key';
  if (status.loggedIn === true) return 'subscription';
  return null;
}

// Pure. Every branch is reachable from a real captured response; the fixtures
// in tests/claude-auth-probe.test.js are transcripts of the installed CLI on
// this machine, except the rate-limit branch (see that test's note -- a real
// 429 cannot be produced on demand, so it is driven from the documented
// error surface rather than claimed as a live capture).
function classifyClaudeAuth({
  statusExit = null,
  statusStdout = '',
  statusTransportError = null,
  capabilityRan = false,
  capabilityExit = null,
  capabilityStdout = '',
  capabilityStderr = '',
  capabilityTransportError = null
} = {}) {
  const base = { account: null, plan: null, authMethod: null, billingSource: null, capabilityRan: capabilityRan === true };

  // Fail closed: the account surface itself did not answer.
  if (statusTransportError) {
    return Object.freeze({
      ...base,
      state: STATE.INDETERMINATE,
      usable: false,
      canFailover: false,
      reason: `The Claude account surface could not be reached (${statusTransportError}). This is not evidence about the account, so it is not treated as a sign-out.`
    });
  }

  const status = parseJson(statusStdout);
  if (!status || typeof status.loggedIn !== 'boolean') {
    return Object.freeze({
      ...base,
      state: STATE.INDETERMINATE,
      usable: false,
      canFailover: false,
      reason: 'The Claude account surface returned an unreadable response; auth state is unknown and is therefore treated as not usable.'
    });
  }

  const identity = {
    account: typeof status.email === 'string' && status.email.trim() !== '' ? status.email.trim() : null,
    plan: typeof status.subscriptionType === 'string' ? status.subscriptionType : null,
    authMethod: typeof status.authMethod === 'string' ? status.authMethod : null,
    billingSource: billingSourceOf(status),
    // Whether a live request was actually made. Rotation reads this to tell
    // "signed in, not yet proven" (selectable) from "a live request failed for
    // no attributable reason" (not selectable) -- both are INDETERMINATE.
    capabilityRan: capabilityRan === true
  };

  // Measured signed-out shape: {"loggedIn":false,"authMethod":"none"}, exit 1.
  if (status.loggedIn === false) {
    return Object.freeze({
      ...identity,
      state: STATE.SIGNED_OUT,
      usable: false,
      canFailover: true,
      reason: 'This Claude CLI has no signed-in account. Run `claude auth login` for it.'
    });
  }

  // Signed in per the account surface. That is NOT proof it can serve a
  // request -- the whole lesson of this file. Without a capability result we
  // report indeterminate and fail closed rather than inheriting the old
  // exit-0 green.
  if (!capabilityRan) {
    return Object.freeze({
      ...identity,
      state: STATE.INDETERMINATE,
      usable: false,
      canFailover: false,
      reason: 'The account surface reports a signed-in session, but no request was made, so it is not proven able to serve one. Re-run with capability checking enabled to resolve this.'
    });
  }

  if (capabilityTransportError) {
    return Object.freeze({
      ...identity,
      state: STATE.INDETERMINATE,
      usable: false,
      canFailover: false,
      reason: `Signed in, but the capability request could not be completed (${capabilityTransportError}). That is a transport fault, not evidence the account is spent or signed out.`
    });
  }

  const envelope = parseJson(capabilityStdout);
  // Deliberately NOT `subtype`: the measured signed-out envelope carries
  // "subtype":"success" together with "is_error":true.
  const failed = capabilityExit !== 0 || (plainObject(envelope) && envelope.is_error === true);

  if (!failed && plainObject(envelope) && envelope.is_error === false) {
    return Object.freeze({
      ...identity,
      state: STATE.AUTHENTICATED,
      usable: true,
      canFailover: false,
      reason: identity.billingSource === 'api_key'
        ? 'Served a live request, but the CLI authenticated from an API key variable rather than the subscription login. This bills per token.'
        : 'Served a live request on the subscription login.'
    });
  }

  const errorText = [
    plainObject(envelope) && typeof envelope.result === 'string' ? envelope.result : '',
    plainObject(envelope) && envelope.api_error_status != null ? String(envelope.api_error_status) : '',
    typeof capabilityStderr === 'string' ? capabilityStderr : ''
  ].join(' ');

  if (RATE_LIMIT_PATTERN.test(errorText)) {
    return Object.freeze({
      ...identity,
      state: STATE.RATE_LIMITED,
      usable: false,
      canFailover: true,
      reason: 'The account is signed in but the provider refused the request for allowance reasons. This is time-bounded: back off or rotate, but the account is not broken.'
    });
  }

  if (AUTH_FAILURE_PATTERN.test(errorText)) {
    // "expired" is measured here and ONLY here: the stored session exists but
    // no longer serves. It is never derived from a token file's expiry, which
    // would call a silently-refreshable account dead.
    return Object.freeze({
      ...identity,
      state: STATE.EXPIRED,
      usable: false,
      canFailover: true,
      reason: 'The account surface reports a signed-in session, but the provider rejected a live request as unauthenticated. The stored session no longer works; sign in again.'
    });
  }

  // Failed for a reason we cannot attribute. Fail closed, and do NOT let a
  // switcher rotate accounts on an unexplained failure.
  return Object.freeze({
    ...identity,
    state: STATE.INDETERMINATE,
    usable: false,
    canFailover: false,
    reason: 'Signed in, but a live request failed for a reason that could not be attributed to the account. Treated as not usable, and not as grounds to switch accounts.'
  });
}

async function runOnce(command, args, { env, cwd, timeoutMs, spawnImpl }) {
  let cleanup = null;
  const answer = await new Promise(resolve => {
    let child;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let transportError = null;
    let seenBytes = 0;

    const finish = exitCode => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, transportError });
    };

    const timer = setTimeout(() => {
      transportError = `timed out after ${timeoutMs}ms`;
      finish(null);
    }, timeoutMs);

    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        windowsHide: true,
        containProcessTree: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      transportError = error.code || error.message || 'spawn failed';
      return finish(null);
    }
    cleanup = createStartupCleanup(child);

    child.on('error', error => {
      transportError = error.code || error.message || 'spawn failed';
      finish(null);
    });
    /* DECODED ONCE ACROSS THE WHOLE STREAM, not once per chunk: a character
       whose bytes straddle a chunk boundary comes back as two U+FFFD from
       chunk.toString(), and this stdout carries the account's e-mail address,
       which the accounts menu prints. The decoder holds a partial sequence
       until the next chunk finishes it. One decoder per stream, because each
       keeps its own carry-over. */
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const append = (kind, chunk, decoder) => {
      if (settled) return;
      seenBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
      if (seenBytes > MAX_PROBE_OUTPUT_BYTES) {
        stdout = ''; stderr = '';
        transportError = 'provider output exceeded the bounded status limit';
        finish(null);
        return;
      }
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (kind === 'stdout') stdout += text; else stderr += text;
    };
    child.stdout?.on('data', chunk => append('stdout', chunk, outDecoder));
    child.stderr?.on('data', chunk => append('stderr', chunk, errDecoder));
    child.on('close', code => finish(code));
  });
  // A token refresh can still be writing after the direct CLI exits. Release
  // neither identity nor a subsequent capability request until owned closure.
  // Cleanup failures keep the shared retained retryCleanup operation intact.
  const receipt = cleanup ? await cleanup.confirmClosed(DEFAULT_CLEANUP_TIMEOUT_MS) : null;
  return receipt ? withProbeLifecycle(answer, receipt.type === 'not-started' ? 'not-started' : 'closed') : answer;
}

// Probe the Claude CLI's auth state.
//
// `capability: true` makes a real minimal request. That is the only setting
// that can return `authenticated`, and it spends a small amount of allowance.
//
// `configDir` points the probe at a specific CLI home, so a caller can measure
// one account at a time rather than only the ambient one. It is for probing
// the OWNER'S OWN local CLI installs.
//
// It is NOT a step towards per-account Claude sessions in the product, and
// nobody should read it as one. src/lib/agent-engine/claude-process.js uses
// CLAUDE_CONFIG_DIR for the opposite purpose: createSessionEnvironment() points
// it at a per-session EMPTY temp dir and strips the OAuth token, specifically
// so a product session can never reach the owner's subscription. That is a
// licence fence, guarded by
// tests/agent-engine/claude-subscription-credential-fence.test.js. Aiming the
// same variable at persistent, signed-in, per-account homes inverts that
// fence. If that is ever wanted it is a licensing decision for the owner, not
// a refactor -- flagged by multi-account-build, who was right to catch the
// ambiguity in how this was first described.
async function probeClaudeAuth({
  capability = true,
  configDir = null,
  statusTimeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
  capabilityTimeoutMs = DEFAULT_CAPABILITY_TIMEOUT_MS,
  baseEnvironment = process.env,
  spawnImpl = spawnHidden,
  executable = null,
  cwd = null,
  fsImpl = fs
} = {}) {
  const exe = require('../provider-session-isolation').resolvePrivateProviderExecutable('claude', baseEnvironment)
    || executable || executableFor('claude', { environment: baseEnvironment });
  // The probe runs under exactly the environment a real launch would use.
  // Probing under a different environment would make the answer inapplicable
  // to the launch -- and probing under the ambient one would measure the API
  // key instead of the subscription.
  const env = require('../provider-session-isolation').providerSessionEnvironment(
    safeLaunchEnvironment(baseEnvironment, { context: 'claude auth probe' }),
    { provider: 'claude', home: configDir, requireHome: true });
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  Object.assign(env, exe.env || {});
  // Match the usage probe: an inherited session marker is not credentials
  // and must not prevent a separate account-status child from answering.
  delete env.CLAUDECODE;

  // A scratch cwd keeps the probe from loading the repository's CLAUDE.md and
  // project context, which is pure cost for a request whose content is
  // irrelevant.
  let scratch = cwd;
  let createdScratch = false;
  if (!scratch) {
    try {
      scratch = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-probe-'));
      createdScratch = true;
    } catch {
      // Running without the scratch directory would silently fall back to the
      // caller's cwd. The CLI could then load repository context and produce a
      // definite account answer even though the isolated probe was never run.
      return classifyClaudeAuth({
        statusTransportError: 'isolated scratch workspace could not be created'
      });
    }
  }

  try {
    const status = await runOnce(exe.command, [...(exe.prefixArgs || []), 'auth', 'status', '--json'], {
      env, cwd: scratch, timeoutMs: statusTimeoutMs, spawnImpl
    });

    const observed = {
      statusExit: status.exitCode,
      statusStdout: status.stdout,
      statusTransportError: status.transportError
    };

    // Only spend allowance when the free surface says there is a session to
    // test. Signed out is already conclusive.
    const statusJson = parseJson(status.stdout);
    const shouldRunCapability = capability
      && !status.transportError
      && plainObject(statusJson)
      && statusJson.loggedIn === true;

    if (!shouldRunCapability) {
      const reading = classifyClaudeAuth(observed), lifecycle = probeLifecycleOf(status);
      return lifecycle ? withProbeLifecycle(reading, lifecycle) : reading;
    }

    const probe = await runOnce(exe.command, [
      ...(exe.prefixArgs || []),
      '--print', CAPABILITY_PROMPT,
      '--output-format', 'json',
      '--no-session-persistence',
      '--allowedTools', ''
    ], { env, cwd: scratch, timeoutMs: capabilityTimeoutMs, spawnImpl });

    const reading = classifyClaudeAuth({
      ...observed,
      capabilityRan: true,
      capabilityExit: probe.exitCode,
      capabilityStdout: probe.stdout,
      capabilityStderr: probe.stderr,
      capabilityTransportError: probe.transportError
    });
    return probeLifecycleOf(status) === 'closed' && probeLifecycleOf(probe) === 'closed'
      ? withProbeLifecycle(reading, 'closed') : reading;
  } finally {
    if (createdScratch && scratch) {
      try { fsImpl.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

module.exports = Object.freeze({
  CAPABILITY_PROMPT,
  DEFAULT_CAPABILITY_TIMEOUT_MS,
  DEFAULT_STATUS_TIMEOUT_MS,
  FAILOVER_STATES,
  STATE,
  classifyClaudeAuth,
  probeClaudeAuth
});
