'use strict';

// Account selection is explicit: the agent request or a stored manual choice
// names its only account. Usage limits, rankings and retry preferences never
// select another subscription account or API credential. The official CLI
// owns sign-in in that account's existing provider home.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { DEFAULT_PROBE_TIMEOUT_MS, STATUS, identityVerdict } = require('./health.js');
const { PROVIDER_IDS, accountsFor, loadRegistry, providerSpec, resolveProfileDir } = require('./registry.js');

// Account exhaustion follows the provider’s own ceiling.
const PROVIDER_CEILING_THRESHOLDS = Object.freeze({
  exhaustedAtPercent: 100, exhaustedAtPercentHourly: 100, exhaustedAtPercentWeekly: 100
});



const { accountRegistryPath } = require('./registry-location.js');
const providerIsolation = require('../provider-session-isolation');
const { probeLifecycleOf, withProbeLifecycle } = require('./probe-lifecycle');
const { activeFor, automaticSwitchingRefusal, commitLaunchSelection, readState, resolveForLaunch, selectAccount } = require('./switcher.js');
const { NO_WINDOWS, bindingWindow, claudeWindows, headroomPercent, spentWindow, windowLimits } = require('./usage-windows.js');
const NO_CLAUDE_ALLOWANCE = Object.freeze({
  windows: NO_WINDOWS, usedPercent: null, readAt: null, resetsAt: null,
  exhausted: false, thresholdInvalid: false, note: null
});

// The rotation record lives beside machine.json in the per-machine services
// root. The account registry does not: registry-location.js resolves the one
// identity-bearing capability registry that the installed product writes.
const STATE_LEAF = 'multi-account-state.json';

// Retained for callers of the standalone cache diagnostic. Account selection
// no longer adopts that cache without evidence matching its account identity.
const CLAUDE_CACHE_FRESHNESS_BUDGET_MS = 6 * 60 * 60 * 1000;

/* THE LIVE CLAUDE USAGE SURFACE, ASKED FIRST AND OPTIONAL BY CONSTRUCTION.
 *
 * ../providers/claude-usage-probe.js asks the official Claude program for the
 * same figures its /usage panel shows, without spending a turn. It is loaded
 * lazily inside a try, so a build without that module reports unknown usage
 * rather than failing to load this file -- and a start must never be
 * blocked by an optional reading. The probe's answer is either MEASURED, in
 * the normalized allowance shape, or UNKNOWN with a reason. Only a live
 * MEASURED answer can supply figures to this account's selection decision.
 *
 * THE PATH IS WRITTEN OUT IN THE require() ITSELF, ON PURPOSE. The app's
 * packer (tools/pack-capability-layer.mjs in the app tree) walks require()
 * calls statically and REFUSES any computed one it has not been told about,
 * because a computed path is a dependency it can see exists but cannot stage.
 * The first draft held this path in a named constant; the pack of this tree
 * stopped at that line (MEASURED 2026-09-02, exit 1, "computed require()
 * expressions that a pack-time walk cannot follow"), and had the walk been
 * lenient instead, the payload would have shipped without the probe and this
 * try would have hidden that on every customer's machine. Optional means the
 * require may fail at run time; it does not mean its target may be hidden
 * from the walk that decides what ships. */
const CLAUDE_USAGE_PROBE_TIMEOUT_MS = DEFAULT_PROBE_TIMEOUT_MS;

function defaultClaudeUsageProbe() {
  try {
    const loaded = require('../providers/claude-usage-probe.js');
    return loaded && typeof loaded.claudeUsageProbe === 'function' ? loaded.claudeUsageProbe : null;
  } catch {
    return null;
  }
}

/* A MEASURED reading turned into the allowance shape the Claude probe below
 * consumes: the same windows, headroom, binding window and threshold test
 * ./claude-allowance.js applies to the cache, applied to a live answer. It is
 * pure -- the reading is already in hand -- which is why it may live in this
 * file while the cache read may not. */
function claudeAllowanceFromReading(reading, {
  model = null,
  exhaustedAtPercent,
  exhaustedAtPercentHourly = null,
  exhaustedAtPercentWeekly = null
} = {}) {
  if (!plainObject(reading) || reading.status !== 'MEASURED') return null;
  const windows = claudeWindows(reading, { model });
  const room = headroomPercent(windows);
  if (room === null) return null;
  const binding = bindingWindow(windows);
  const usedPercent = 100 - room;
  /* The same validity rule ./claude-allowance.js applies to the cache. An
     invalid threshold is REPORTED rather than compared against, and the probe
     below turns the report into TRANSIENT: a measured figure judged against
     nothing must not pass as healthy. */
  const thresholdValid = Number.isFinite(exhaustedAtPercent)
    && exhaustedAtPercent >= 0 && exhaustedAtPercent <= 100;
  /* One limit per window, the same rule ./claude-allowance.js applies to the
     cache. These two must agree: a live reading and a cached one that
     disagreed about the same account would be a coin toss on probe timing. */
  const exhausted = thresholdValid && spentWindow(windows, windowLimits({
    exhaustedAtPercent, exhaustedAtPercentHourly, exhaustedAtPercentWeekly
  })) !== null;
  const readTime = Number.isFinite(reading.fetchedAtMs) ? new Date(reading.fetchedAtMs) : null;
  return Object.freeze({
    windows,
    usedPercent,
    readAt: readTime && Number.isFinite(readTime.getTime()) ? readTime.toISOString() : null,
    resetsAt: binding ? binding.resetsAt : null,
    exhausted,
    thresholdInvalid: !thresholdValid,
    /* NO RESET TIMESTAMP IN THE NOTE, the same rule ./claude-allowance.js
       already states for the cache route -- and the reason "these two must
       agree" is written above. It was true of the cache and not of this,
       so a live reading put the machine value back on the menu: MEASURED
       2026-09-03, the installed copy's accounts-usage-cache.json carried
       "92% of its weekly allowance is used; resets
       2026-09-03T17:00:00.309845+00:00." under a row whose own line already
       read the time in words. `resetsAt` above and each window still carry
       it for any surface that wants to say it its own way. */
    note: `${Math.round(usedPercent)}% of its ${binding && binding.kind === 'weekly' ? 'weekly' : 'hourly'} allowance is used.`
  });
}

const CODE = Object.freeze({
  NOT_CONFIGURED: 'ACCOUNTS_NOT_CONFIGURED',
  UNREADABLE: 'ACCOUNTS_REGISTRY_UNREADABLE',
  STATE_UNREADABLE: 'ACCOUNT_STATE_UNREADABLE',
  NONE_FOR_PROVIDER: 'ACCOUNTS_NONE_FOR_PROVIDER',
  SELECTED: 'ACCOUNT_SELECTED',
  SELECTED_SOLE: 'ACCOUNT_SELECTED_SOLE',
  EXHAUSTED_MANUAL: 'ACCOUNT_EXHAUSTED_MANUAL',
  NONE_USABLE: 'ACCOUNT_NONE_USABLE'
});

function statePathFor(servicesRoot) { return path.join(servicesRoot, STATE_LEAF); }



function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function notRotated(code, reason, extra = {}) {
  return Object.freeze({
    rotated: false,
    blocked: false,
    switched: false,
    account: null,
    env: null,
    attempts: Object.freeze([]),
    nextStep: null,


    code,
    reason,
    ...extra,
    ...(providerIsolation.isolationRequested() ? { blocked: true,
      reason: 'This isolated session requires an available private named account. No default sign-in was used.',
      nextStep: 'Add or sign in to a private account in this session, then retry.' } : {})
  });
}

/* Read the registry WITHOUT the loud refusals loadRegistry() is right to make.
 *
 * The asymmetry is the point and it is not a softening. A builder invoking the
 * account CLI is asking a direct question about that file and must be told when
 * it is corrupt. A customer pressing Start is asking to run an agent, and a
 * malformed optional file must not be the reason they cannot. So the refusal
 * survives at its own call site and is converted to "no rotation" at this one --
 * with the code preserved, so the surface that lists accounts can still explain
 * why none are shown. */
function readRegistryQuietly(configPath, { fsImpl = fs } = {}) {
  try {
    return { registry: loadRegistry({ configPath, fsImpl }), code: null };
  } catch (error) {
    const code = error && error.code === 'ACCOUNTS_REGISTRY_MISSING'
      ? CODE.NOT_CONFIGURED
      : CODE.UNREADABLE;
    return { registry: null, code, detail: (error && error.code) || null };
  }
}

/* The Codex probe, wired to the real one.
 *
 * environmentFor is launch.js's launchEnvironment: it scrubs every billing
 * credential and pins CODEX_HOME to this account's home, so the probe measures
 * the account under exactly the environment a launch would use. Probing under a
 * different one would make the answer inapplicable to the launch it informs. */
function codexProbeFactory({
  homeDir, exhaustedAtPercent, exhaustedAtPercentHourly = null, exhaustedAtPercentWeekly = null, fsImpl, timeoutMs
}) {
  const { probeAccount } = require('./health.js');
  const { codexExecutable, launchEnvironment } = require('./launch.js');
  const executable = codexExecutable();
  return account => probeAccount(account, {
    homeDir,
    environmentFor: (entry, options) => launchEnvironment(entry, { ...options, homeDir }),
    executable,
    exhaustedAtPercent,
    exhaustedAtPercentHourly,
    exhaustedAtPercentWeekly,
    fsImpl,
    timeoutMs
  });
}

/* The Claude probe, and what it can and cannot prove today.
 *
 * `capability: false` is deliberate and is the whole reason this is affordable
 * to run before a start: it asks only the FREE surface, `claude auth status
 * --json`, which spends no allowance. The paid tier-2 probe -- a real `--print`
 * turn -- is the only thing that proves an account can serve, and spending a
 * turn on every start to learn that would cost the person the very allowance
 * this feature exists to conserve.
 *
 * The auth surface reports identity and billing route; the separate live
 * get_usage control supplies allowance figures. Without a live measurement,
 * the current auth verdict stands and allowance stays unknown.
 *
 * BILLING IS A HARD GATE, NOT A WARNING. A home whose `apiKeySource` is set is
 * authenticating with a metered key rather than the subscription. Selecting it
 * would spend money silently while every other signal reads green -- the exact
 * harm that kept Claude out of this registry until now -- so it is treated as
 * unusable and rotation moves past it. */
/* A provider cache can survive a different account signing into this folder.
 * Its account UUID is not matched by the current auth contract, so age and
 * folder identity cannot authorize its use for exhaustion or ranking. Keep
 * the standalone cache reader available for diagnostics; this probe accepts
 * only the live usage surface. No live figure leaves auth unchanged, not
 * signed out, spent, or assigned an old account's percentage. */
function cleanupUnproven(error) {
  return typeof error?.code === 'string' && error.code.endsWith('_CLEANUP_UNPROVEN')
    && typeof error.retryCleanup === 'function';
}

function joinClaudeCleanupFailures(errors) {
  const { cleanupFailure } = require('../agent-engine/codex-startup-cleanup');
  const retryCleanup = async () => {
    const outcomes = await Promise.allSettled(errors.map(error => error.retryCleanup()));
    const failed = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
    if (failed.length) throw cleanupFailure('CLAUDE_ACCOUNT_CLEANUP_UNPROVEN', errors[0], failed, retryCleanup);
  };
  return cleanupFailure('CLAUDE_ACCOUNT_CLEANUP_UNPROVEN', errors[0], errors, retryCleanup);
}

/* A DEFINITIVE CLAUDE READING IS REUSED FOR A SHORT WHILE, PER ACCOUNT HOME.
 *
 * Every Claude account check starts TWO Claude programs (auth status and the
 * usage control request), and a usage-ranked mode checks EVERY listed account
 * before each start. MEASURED on the owner's computer, 2026-09-18/19: the
 * usage probe alone left 1150 `claude-usage-probe-*` cache folders, 67 of them
 * in one hour, and the tree resume after the 02:42Z relaunch started eight
 * sessions in four minutes, each one re-reading every account it had just
 * read. The owner saw it as "one of your agents trying to sign into claude 40
 * times", and asked why. A figure read seconds ago is the figure: the window
 * it describes is measured in hours, and a start that is refused anyway is
 * still refused by the provider's own answer and handed on. So a reading that
 * both children attested closed, and that is definite (signed in and serving,
 * or spent), is kept here by account home for CLAUDE_READING_REUSE_MS and
 * answered again, marked `reused` with its age, instead of starting the two
 * programs again. A transient, signed-out or mismatched reading is never
 * reused: those are exactly the ones a person is about to fix. Only the real
 * program path reuses; a factory handed an injected probe measures every time
 * unless it asks for reuse by name, so a test can count its own calls. */
const CLAUDE_READING_REUSE_MS = 45_000;
const recentClaudeReadings = new Map();
function forgetRecentClaudeReadings() { recentClaudeReadings.clear(); }
function claudeReadingKey(configDir, { model, exhaustedAtPercent, exhaustedAtPercentHourly, exhaustedAtPercentWeekly }) {
  return JSON.stringify([configDir, model, exhaustedAtPercent, exhaustedAtPercentHourly, exhaustedAtPercentWeekly]);
}

function claudeProbeFactory({
  homeDir, fsImpl, exhaustedAtPercent, exhaustedAtPercentHourly = null, exhaustedAtPercentWeekly = null,
  usageProbe, authProbe = null, model = null, reuseWithinMs = undefined, now = Date.now
}) {
  const { probeClaudeAuth, STATE } = require('../providers/claude-auth-probe.js');
  const liveProbe = usageProbe === undefined ? defaultClaudeUsageProbe() : usageProbe;
  // Both provider boundaries are injectable without running the Claude program.
  const askAuth = typeof authProbe === 'function' ? authProbe : probeClaudeAuth;
  const realProgram = usageProbe === undefined && typeof authProbe !== 'function';
  const reuseMs = Number.isFinite(reuseWithinMs) && reuseWithinMs >= 0
    ? reuseWithinMs : (realProgram ? CLAUDE_READING_REUSE_MS : 0);
  const thresholds = { model, exhaustedAtPercent, exhaustedAtPercentHourly, exhaustedAtPercentWeekly };
  return async account => {
    let configDir = null;
    try {
      configDir = resolveProfileDir(account, { homeDir });
    } catch {
      return Object.freeze({
        account: account.name, email: null, usedPercent: null, resetsAt: null, planType: null,
        windows: NO_WINDOWS,
        status: STATUS.NOT_PROVISIONED, canServe: false,
        reason: `The folder for "${account.name}" could not be worked out, so it was skipped.`
      });
    }
    const memoKey = reuseMs > 0 ? claudeReadingKey(configDir, thresholds) : null;
    if (memoKey) {
      const kept = recentClaudeReadings.get(memoKey);
      const age = kept ? now() - kept.atMs : Infinity;
      if (kept && age >= 0 && age <= reuseMs) {
        return withProbeLifecycle(Object.freeze({ ...kept.reading, account: account.name, reused: true, reusedAfterMs: age }), 'closed');
      }
      if (kept) recentClaudeReadings.delete(memoKey);
    }
    /* THE TWO CHILD PROCESSES START TOGETHER, AND NOTHING ELSE MOVES.
     *
     * Both of these spawn the Claude program: the auth probe runs
     * `claude auth status --json`, the usage probe runs the CLI's control
     * protocol for `get_usage`. Neither reads any part of the other's answer --
     * both take only `configDir` -- so the `await` between them was buying
     * nothing but the first program's start-up time twice over.
     *
     * MEASURED 2026-09-03 on this machine (claude.CMD, an empty scratch
     * CLAUDE_CONFIG_DIR so no sign-in of the owner's is touched, five rounds,
     * medians): auth 481.2 ms, usage 1282.9 ms, one after the other 1736.6 ms,
     * together 1482.4 ms -- 254.2 ms off every Claude account this walk reads.
     * A usage-ranked mode reads EVERY listed account, so the saving is per
     * account, and it sits directly in front of pressing Start.
     *
     * The usage probe runs unconditionally and spends nothing (a get_usage
     * control request, not a turn). Its failure cannot authorize an unrelated
     * cached account's figures.
     *
     * A REJECTION IS CAUGHT WHERE IT WAS BEFORE. The usage promise carries its
     * own catch from the moment it exists, so an auth probe that throws cannot
     * turn this into an unhandled rejection; the throw still leaves this
     * function exactly as it did, and cachedProbe() above still records it as a
     * transient reading, after the started usage check has been drained. */
    let liveCleanupFailure = null;
    const livePromise = typeof liveProbe === 'function'
      ? Promise.resolve()
        .then(() => liveProbe({ configDir, timeoutMs: CLAUDE_USAGE_PROBE_TIMEOUT_MS }))
        // A fault means no usage was measured; it is not an auth verdict.
        .catch(error => {
          // Attach the handler immediately while auth is still in flight.
          // Retain lifecycle failure separately from ordinary unknown usage.
          if (cleanupUnproven(error)) liveCleanupFailure = error;
          return { status: 'UNKNOWN', reason: 'CLAUDE_USAGE_READ_FAILED' };
        })
      : null;
    let observed;
    try {
      observed = await askAuth({ capability: false, configDir, fsImpl });
    } catch (error) {
      // A failed auth check still owns the usage check it started. Its promise
      // settles only after provider cleanup, so drain it before releasing this
      // account for another check or reporting the original auth fault.
      if (livePromise) await livePromise;
      if (liveCleanupFailure) {
        if (cleanupUnproven(error)) throw joinClaudeCleanupFailures([error, liveCleanupFailure]);
        throw liveCleanupFailure;
      }
      throw error;
    }
    const authStatus = claudeStatusOf(observed, STATE);
    let allowance = null;
    let liveReading = null;
    let liveMeasured = false;
    if (livePromise) {
      liveReading = await livePromise;
      if (liveCleanupFailure) throw liveCleanupFailure;
      try {
        allowance = claudeAllowanceFromReading(liveReading, {
          model, exhaustedAtPercent, exhaustedAtPercentHourly, exhaustedAtPercentWeekly
        });
        liveMeasured = Boolean(allowance);
      } catch {
        // Kept around the conversion as well as the call, so a malformed live
        // reading is the same stated nothing it was before this ran early.
        allowance = null;
      }
    }
    // A subscription allowance cannot exhaust the API/cloud route chosen by
    // the native CLI. Those modes prove their own capacity at the first turn.
    if (['api_key', 'cloud', 'key_helper'].includes(observed?.billingSource)) { allowance = NO_CLAUDE_ALLOWANCE; liveMeasured = false; }
    if (!allowance) allowance = NO_CLAUDE_ALLOWANCE;
    /* The allowance may only ever move an account from healthy to spent -- or
       to TRANSIENT, when a figure WAS measured and the threshold it is judged
       against is not a valid percentage. Nothing was compared then, so nothing
       is known, and TRANSIENT is the state that stops rather than spends: the
       same answer health.js gives a Codex account in that position, and the
       opposite of a spent account passing because NaN compared as nothing. An
       unread allowance changes nothing. An account the auth probe already
       refused stays refused with its own reason: "signed out" and "out of
       allowance" send a person to two different places, and the auth fault is
       the one they have to fix first. */
    /* AND THE IDENTITY GATE, WHICH THIS PROVIDER DID NOT HAVE.
       health.js has held Codex to `expectEmail` since the day config/codex.json
       was written; nothing held Claude to anything. MEASURED 2026-09-03 on this
       tree: `expectEmail` appears in exactly one comparison in the whole engine
       (health.js's classifyProbe), and this factory read `observed.account`
       only to put it in the answer. So a person who picked the wrong account in
       the browser signed a different identity in under this row's label, every
       later start used it, and nothing anywhere said so.
       It runs only on an account the auth probe found HEALTHY, for the reason
       stated above: an account already refused keeps its own reason, and
       "signed out" is the fault a person has to fix before "wrong account"
       means anything. */
    const mismatch = authStatus === STATUS.HEALTHY ? claudeIdentityFault(account, observed) : null;
    const unjudged = !mismatch && authStatus === STATUS.HEALTHY && allowance.thresholdInvalid === true;
    const status = mismatch ? mismatch.status : (unjudged
      ? STATUS.TRANSIENT
      : (authStatus === STATUS.HEALTHY && allowance.exhausted ? STATUS.EXHAUSTED : authStatus));
    const sentence = unjudged
      ? `"${account.name}" reported its allowance, but the spent threshold is not a valid percentage, so it was not judged.`
      : claudeSelectionReason(observed, status, account.name);
    // Native API, cloud and helper routes do not inherit a subscription
    // allowance clause. The router and Accounts show the same route sentence.
    const nativeApi = Boolean(observed) && ['api_key', 'cloud', 'key_helper'].includes(observed.billingSource);
    const usageNotReported = ['CLAUDE_USAGE_RATE_LIMITS_UNAVAILABLE', 'CLAUDE_USAGE_NO_MEASURED_WINDOW'].includes(liveReading?.reason);
    const reading = Object.freeze({
      account: account.name,
      email: observed.account || null,
      /* BLANKED ON A MISMATCH, and health.js states the reason in its own gate:
         an allowance read off the WRONG identity describes somebody else's
         subscription, and the usage-ranked modes would order this list on a
         stranger's numbers. */
      usedPercent: mismatch ? null : allowance.usedPercent,
      readAt: mismatch ? null : allowance.readAt || null,
      // Authentication and allowance availability are independent.
      usageStatus: mismatch ? 'not_reported' : liveMeasured ? 'measured' : usageNotReported ? 'not_reported' : 'unavailable',
      usageSource: mismatch || allowance.usedPercent === null ? null : 'claude-get-usage',
      usageCode: mismatch ? 'ACCOUNT_USAGE_IDENTITY_MISMATCH' : liveMeasured ? null
        : (typeof liveReading?.reason === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(liveReading.reason)
          ? liveReading.reason : 'CLAUDE_USAGE_UNAVAILABLE'),
      usageReason: mismatch ? 'The allowance could not be matched to this account.' : liveMeasured ? null
        : usageNotReported ? 'Claude did not report an allowance percentage for this account.'
          : 'Claude could not check this allowance just now. Try Check allowances again.',
      resetsAt: mismatch ? null : allowance.resetsAt,
      windows: mismatch ? NO_WINDOWS : allowance.windows,
      planType: observed.plan || null,
      status,
      canServe: status === STATUS.HEALTHY,
      reason: mismatch
        ? mismatch.reason
        : (nativeApi || !allowance.note ? sentence : `${sentence} ${allowance.note}`)
    });
    // A directory pin is not a closure receipt. Both independently started
    // provider children must attest closure before a refresh retry is eligible.
    const authLifecycle = probeLifecycleOf(observed);
    const usageLifecycle = probeLifecycleOf(liveReading);
    const closed = authLifecycle === 'closed' && usageLifecycle === 'closed';
    if (memoKey && closed && (status === STATUS.HEALTHY || status === STATUS.EXHAUSTED)) {
      recentClaudeReadings.set(memoKey, { reading, atMs: now() });
    }
    return closed ? withProbeLifecycle(reading, 'closed') : reading;
  };
}

/* IS THIS THE ACCOUNT THE ENTRY SAYS IT IS? Null when there is nothing to
 * refuse; a status and the sentence a person reads when there is.
 *
 * THREE ANSWERS, NOT TWO, AND THE THIRD IS THE ONE THAT IS EASY TO LOSE.
 *   nothing recorded  -- no expectEmail on the entry. Nothing was promised, so
 *                        nothing is checked and the account is left exactly as
 *                        the auth probe found it. Every registry written before
 *                        this shipped is in this case, so nothing changes for
 *                        anybody who has not asked for the check.
 *   recorded, differs -- ACCOUNT_MISMATCH. Not a failover state (health.js's
 *                        an identity refusal is always held): the wrong
 *                        identity is a configuration fault the owner must see,
 *                        not something to route around by spending the next
 *                        account.
 *   recorded, unread  -- the probe answered no e-mail at all. "Could not look"
 *                        is not "not there", and calling it a mismatch would
 *                        accuse a person whose account may be perfectly right.
 *                        TRANSIENT: the state that stops rather than spends,
 *                        and the same answer this file already gives a measured
 *                        account with no valid threshold to judge it by.
 *
 * WHICH OF THE FOUR CASES THIS IS IS health.js's identityVerdict(), the one
 * comparison both legs now ask. It was written out separately here and in
 * classifyProbe, and the two spellings had already drifted: the Codex one read
 * an UNREADABLE address as a wrong one and accused the person (measured, four
 * ways -- identityVerdict's header lists them). Only the sentences stay here,
 * because a sentence is provider-shaped and belongs beside its reader. */
function claudeIdentityFault(account, observed) {
  const { verdict, seen } = identityVerdict(account, observed && observed.account);
  if (verdict === 'unchecked' || verdict === 'match') return null;
  if (verdict === 'unreadable') {
    return Object.freeze({
      status: STATUS.TRANSIENT,
      reason: `"${account.name}" expects a particular account, but the Claude sign-in did not say which account it is, so the two could not be compared. That is not a claim that the wrong one is signed in.`
    });
  }
  /* THE ADDRESS THAT IS ACTUALLY THERE IS NAMED, and the expected one is not.
     Both are the owner's own, on the owner's own screen, so neither is a
     secret from the person reading -- but the one they need is the one they
     did not expect, because that is the account they signed in by mistake and
     the thing they must recognise. The remedy names presses this menu has
     (Sign in on that row, Remove) rather than a field in a file. */
  return Object.freeze({
    status: STATUS.ACCOUNT_MISMATCH,
    reason: `"${account.name}" is signed in as ${seen}, which is not the account it expects. Sign that row in again as the account it expects, or remove it and add it back.`
  });
}

// Map the Claude probe's vocabulary onto the switcher's, which is the one
// the account status contract uses. `indeterminate` becomes `transient`,
// which STOPS the cascade rather than spending another account on a guess --
// the same policy both modules already state in their own words.
// Native status and launch preserve the same Claude.ai, API, cloud and
// helper authentication. Only a successful free status can make an unproven
// native home selectable; the first turn measures whether it can serve.
function claudeSelectionReason(observed, status, accountName) {
  if (status === STATUS.HEALTHY) {
    if (observed?.billingSource === 'api_key') return `"${accountName}" is signed in through the native CLI's API key settings; the first turn checks whether it can serve.`;
    if (observed?.billingSource === 'cloud') return `"${accountName}" is signed in through the native CLI's cloud provider settings; the first turn checks whether it can serve.`;
    if (observed?.billingSource === 'key_helper') return `"${accountName}" is signed in through the native CLI's key helper settings; the first turn checks whether it can serve.`;
    if (observed?.capabilityRan === false && observed.state === 'indeterminate') {
      return `Signed in on the subscription${observed.account ? ` as ${observed.account}` : ''}; the first turn proves it can serve.`;
    }
  }
  if (status === STATUS.EXHAUSTED) return observed?.state === 'rate_limited'
    ? 'Signed in, but the provider refused the last request for allowance reasons, so this account is not being started.'
    : 'Signed in, but this account is out of allowance for now, so it is not being started.';
  if (observed?.state === 'indeterminate' && observed.capabilityRan === false && observed.billingSource === null) {
    return 'This copy could not read the Claude sign-in for this account, so whether it is signed in is not known right now. It is not being started, and it is not being called signed out or out of allowance.';
  }
  if (status === STATUS.TRANSIENT && observed?.statusSucceeded !== true) {
    return 'The selected Claude account could not be checked. Open Accounts and check it again before starting.';
  }
  return observed?.reason;
}

function claudeStatusOf(observed, STATE) {
  if (!observed || typeof observed !== 'object') return STATUS.TRANSIENT;
  if (observed.state === STATE.INDETERMINATE && observed.statusSucceeded === true
      && observed.capabilityRan === false
      && ['subscription', 'api_key', 'cloud', 'key_helper'].includes(observed.billingSource)) return STATUS.HEALTHY;
  switch (observed.state) {
    case STATE.AUTHENTICATED: return STATUS.HEALTHY;
    case STATE.RATE_LIMITED: return STATUS.EXHAUSTED;
    case STATE.SIGNED_OUT: return STATUS.SIGNED_OUT;
    case STATE.EXPIRED: return STATUS.SIGNED_OUT;
    default: return STATUS.TRANSIENT;
  }
}

/* These provider-specific allowance reads share account selection and lifetime
 * custody. Gemini uses the pinned public SDK personal-OAuth quota worker;
 * Antigravity and Grok retain their official client reads. Model/token buckets
 * never become a fabricated hourly/weekly total or a cross-account rank. */
function presenceProbeFactory(options) {
  const { probeGeminiAccount, probeAntigravityAccount, probeGrokAccount } = require('./health.js');
  return account => account.client === 'antigravity' ? probeAntigravityAccount(account, options)
    : account.provider === 'grok' ? probeGrokAccount(account, options) : probeGeminiAccount(account, options);
}

// Shared per-account reader for Start, Accounts and explicit tool callers.
// An unrecognized provider must never be measured as Codex by fallback.
function defaultProbeFor(provider, options = {}) {
  if (provider === 'claude') return claudeProbeFactory(options);
  if (provider === 'gemini' || provider === 'grok') return presenceProbeFactory(options);
  if (provider === 'codex') return codexProbeFactory(options);
  const error = new Error('No account usage reader is available for this provider.');
  error.code = 'ACCOUNT_PROVIDER_UNSUPPORTED';
  throw error;
}

/* A manual choice persists until the person changes it. Older records can
 * recover that choice from their manual-switch history. Launches use only
 * that named account and never consume the choice when a limit is reached. */
function aboutProvider(entry, provider) {
  return typeof entry.provider !== 'string' || entry.provider === provider;
}

function namedPin(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function manualPin(state, provider) {
  if (!plainObject(state)) return null;
  /* A record that carries the map is answered by the map alone. "Written, with
     nothing in it for this provider" is a person having no standing choice
     here, and the history behind it is spent switches, not live ones. */
  if (plainObject(state.manualPinByProvider)) return namedPin(state.manualPinByProvider[provider]);
  const history = Array.isArray(state.history) ? state.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!plainObject(entry) || !aboutProvider(entry, provider)) continue;
    if (entry.outcome !== 'manual-switch') continue;
    return namedPin(entry.account) || namedPin(activeFor(state, provider));
  }
  return null;
}

/* A probe that threw, or answered nothing, as a reading the walk can record.
 * TRANSIENT is the state that stops the cascade rather than spending another
 * account on a guess, which is exactly what a failed check deserves. */
function transientReading(account, cause) {
  const cleanup = cleanupUnproven(cause);
  const reading = {
    account: account.name, email: null, usedPercent: null, resetsAt: null, planType: null,
    windows: NO_WINDOWS,
    status: STATUS.TRANSIENT, canServe: false,
    reason: cleanup ? `The previous check for "${account.name}" has not confirmed that its processes stopped.`
      : `The check for "${account.name}" failed (${cause}), so it was not treated as spent.`,
    ...(cleanup ? { usageStatus: 'unavailable', usageCode: cause.code,
      usageReason: 'The previous provider check must finish closing before this account can be checked again.' } : {})
  };
  if (cleanup) Object.defineProperty(reading, 'retryCleanup', { value: cause.retryCleanup });
  return cleanup ? withProbeLifecycle(reading, 'unproven') : Object.freeze(reading);
}

// Await a chosen-account health check while preserving caller cancellation.
async function awaitAccountProbe(reading, signal) {
  if (!signal) return reading;
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    /* These probes only read account health. The selection owner below must
       still observe cancellation before committing account or refusal state.
       A provider probe that cannot cancel keeps its own existing time bound. */
    return await Promise.race([reading, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}



async function resolveAccountForSession({
  provider = 'codex', client = null, model = null, servicesRoot,
  homeDir = process.env.USERPROFILE || process.env.HOME || '',
  preferred = null, persistSelection = true,
  probe = null, usageProbe = undefined, statePath = null, fsImpl = fs,
  signal = null, now = () => new Date().toISOString(), ...request
} = {}) {
  signal?.throwIfAborted();
  const refusal = (code, reason, extra = {}) => notRotated(code, reason,
    { blocked: true,  ...extra });
  const retired = automaticSwitchingRefusal(request);
  if (retired) return refusal(retired.code, retired.reason);
  const spec = providerSpec(provider);
  if (!spec) return notRotated(CODE.NONE_FOR_PROVIDER, 'This provider uses its own sign-in.');
  if (preferred !== null && (typeof preferred !== 'string' || !preferred || preferred.length > 120)) {
    return refusal('ACCOUNT_SELECTION_INVALID', 'The selected account name is invalid.');
  }
  if (client != null && (spec.id !== 'gemini' || client !== 'antigravity')) {
    return refusal('ACCOUNT_CLIENT_INVALID', 'The selected account client does not match this provider.');
  }
  if (typeof servicesRoot !== 'string' || !servicesRoot) {
    return preferred
      ? refusal(CODE.NOT_CONFIGURED, 'The selected account cannot be resolved without an account list location.')
      : notRotated(CODE.NOT_CONFIGURED, 'No account was selected. The official CLI uses its own sign-in.');
  }
  let context, registry, record, pinned, state;
  try {
    context = providerIsolation.isolationContext(process.env, { servicesRoot });
    record = statePath || statePathFor(servicesRoot);
    providerIsolation.assertIsolatedPath(record, context, { field: 'account selection state' });
    try { state = readState(record, { fsImpl }); }
    catch { return refusal(CODE.STATE_UNREADABLE, 'The saved account selection could not be read. Open Accounts and choose an account before starting again.'); }
    if (state.selectionUnreadableByProvider?.[spec.id]) return refusal(CODE.STATE_UNREADABLE,
      'The saved account selection could not be read. Open Accounts and choose an account before starting again.');
    pinned = manualPin(state, spec.id);
    const configPath = accountRegistryPath();
    providerIsolation.assertIsolatedPath(configPath, context, { field: 'account registry' });
    const read = readRegistryQuietly(configPath, { fsImpl });
    registry = read.registry;
    if (!registry) {
      if (preferred || pinned || read.code !== CODE.NOT_CONFIGURED) {
        return refusal(read.code, 'The selected account list could not be read. No replacement sign-in was selected.');
      }
      return notRotated(read.code, 'No account was selected. The official CLI uses its own sign-in.');
    }
  } catch {
    return refusal(CODE.UNREADABLE, 'The account selection could not be read. No replacement sign-in was selected.');
  }
  const wanted = preferred || pinned;
  if (!wanted) {
    return notRotated(CODE.NONE_FOR_PROVIDER, 'No account was selected. The official CLI uses its own sign-in.',
      {  });
  }
  const account = accountsFor(registry, spec.id)
    .find(entry => (entry.name === wanted || entry.previousNames?.includes(wanted)) && (entry.client || null) === client);
  if (!account) return refusal('ACCOUNT_SELECTION_UNAVAILABLE',
    'The explicitly selected account is not registered for this provider and client. Choose an account before retrying.');
  try {
    providerIsolation.assertIsolatedPath(resolveProfileDir(account, { homeDir }), context,
      { field: 'registered provider account' });
    const activeProbe = probe || defaultProbeFor(spec.id, {
      homeDir, model, ...PROVIDER_CEILING_THRESHOLDS, fsImpl, usageProbe, signal
    });
    const selection = await resolveForLaunch({
      registry: { ...registry, accounts: [account] }, provider: spec.id, preferred: account.name,
      probe: async entry => {
        try { return await awaitAccountProbe(activeProbe(entry), signal); }
        catch { signal?.throwIfAborted(); return transientReading(entry, 'provider check failed'); }
      }, statePath: record,
      persistSelection: false, observedState: state, fsImpl, now, signal
    });
    signal?.throwIfAborted();
    if (!selection.ok) return refusal(selection.code,
      selection.reason, { attempts: selection.attempts, nextStep: selection.reason });
    // Preserve the request's saved label while carrying this registry entry's
    // exact home. The committed choice always uses its current registry name.
    const answer = selected(preferred && account.name !== preferred ? { ...account, name: preferred } : account, {
      code: accountsFor(registry, spec.id).length === 1 ? CODE.SELECTED_SOLE : CODE.SELECTED,
      spec, homeDir, switched: false,
      attempts: selection.attempts, reason: `Using "${wanted}", the explicitly selected account.` });
    if (!answer.rotated) return refusal(answer.code, answer.reason);
    if (persistSelection !== false) commitLaunchSelection({
      selection, statePath: record, manualPin: pinned, fsImpl, now, signal
    });
    return Object.freeze({ ...answer,  selectionPinned: wanted,
      selectionPinnedServed: true,  });
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'ACCOUNT_LAUNCH_COMMIT_CONFLICT') return refusal(error.code,
      'The selected account changed while it was being checked. Start again to use your current choice.');
    return refusal(CODE.UNREADABLE, 'The selected account could not be checked. No replacement sign-in was selected.');
  }
}

/* The chosen account, and the ONE environment name that carries the choice.
 *
 * The value is a directory. Nothing is opened, nothing is copied, and the
 * official program does its own sign-in inside that directory exactly as it
 * would in the person's own terminal. */
function selected(account, { code, spec, homeDir, switched, attempts, reason }) {
  let resolvedHome = null;
  try {
    resolvedHome = resolveProfileDir(account, { homeDir });
  } catch {
    if (process.platform === 'linux') {
      return notRotated(CODE.UNREADABLE,
        'The selected account folder could not be established. No replacement sign-in was selected.');
    }
    return notRotated(CODE.NONE_FOR_PROVIDER,
      `The folder for "${account.name}" could not be worked out, so the usual sign-in is used.`);
  }
  return Object.freeze({
    rotated: true,
    blocked: false,
    switched: Boolean(switched),
    code,
    account: Object.freeze({
      name: account.name,
      provider: account.provider,
      ...(account.client ? { client: account.client, identityScope: 'current-user' } : {}),
      ...(account.expectEmail ? { expectEmail: account.expectEmail } : {}),
      ...(account.client === 'antigravity' ? { homeCreatedByApp: account.homeCreatedByApp === true } : {}),
      home: account.home,
      resolvedHome
    }),
    env: Object.freeze(account.client === 'antigravity'
      ? { HOME: resolvedHome, USERPROFILE: resolvedHome, XDG_CONFIG_HOME: path.join(resolvedHome, '.config'),
        XDG_CACHE_HOME: path.join(resolvedHome, '.cache'), XDG_DATA_HOME: path.join(resolvedHome, '.local', 'share') }
      : { [spec.homeEnv]: resolvedHome }),
    attempts: Object.freeze([...(attempts || [])]),
    nextStep: null,
    reason
  });
}

/* WHAT THE ACCOUNTS PANEL READS, AND WHY IT IS THE SAME CODE AS A START.
 *
 * A screen that shows "62% of this week left" and a start that then chooses a
 * account sees the same provider observation used for launch. This runs the
 * same probe factories and lists accounts for explicit selection. The only thing it
 * does not do is choose: nothing here writes state, commits a selection or
 * starts anything.
 *
 * IT NEVER THROWS, for the reason everything else in this file never throws: a
 * panel that goes blank because an optional file is missing is worse than a
 * panel that says the file is missing. Every failure is a record with a code.
 *
 * WHAT IT COSTS. Nothing in allowance terms -- Codex answers two zero-token
 * JSON-RPC calls per account, Claude asks its own program for the figure its
 * usage panel shows or reads a file already on disk, Antigravity answers its
 * print-mode /quota and Grok its `_x.ai/billing` read without a turn, and a
 * legacy Gemini CLI entry is a presence check -- but it does spawn one
 * short-lived program per Codex, Antigravity and Grok account, so it is a
 * read a person asks for by opening the panel, never a timer. A row whose
 * provider did not report a figure carries no windows and no percentage:
 * "not measured" must never be drawn as 0%.
 */
/* One opaque identity for the list and its allowance reply. Labels can be
 * reused; the resolved provider home and client identify the account we asked.
 * This boundary owns native path comparison, so renderers compare tokens only.
 * No sign-in file is opened and no path is returned in the token. */
function accountUsageBinding({ provider, client = null, directory } = {}) {
  if (!providerSpec(provider) || typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
  const resolved = path.resolve(directory);
  return createHash('sha256').update(JSON.stringify([
    provider, client, process.platform === 'win32' ? resolved.toLowerCase() : resolved
  ])).digest('hex');
}

const ACCOUNT_USAGE_CONCURRENCY = 4;
const ACCOUNT_USAGE_BINDING_FILTER_VERSION = 1;

async function readAccountUsage({
  homeDir = process.env.USERPROFILE || process.env.HOME || '',
  usageProbe = undefined,
  /* WHICH REGISTRY, SAID BY THE CALLER WHEN THE CALLER ALREADY KNOWS.
   *
   * accountRegistryPath() resolves the installed product's identity from
   * TOOLSENABLED_STATE_ROOT, and that variable is set for the capability
   * process rather than for whatever process happens to be asking. The shell's
   * main process has already resolved this exact file in order to build the
   * store that lists and edits it, so it passes the path rather than making
   * this module re-derive it from an environment it may not share -- which is
   * how a menu ends up reporting "no accounts" about a file the screen beside
   * it is reading happily. Absent, it falls back to the resolver, so a caller
   * inside the capability layer needs to change nothing. */
  registryPath = null,
  providers = null,
  accountBindings = null,
  probeFor = null,
  timeoutMs = undefined,
  fsImpl = fs,
  /* Same clock shape resolveAccountForSession takes, so a test can pin the
     "resets in 40 min" wording the expiring-first order sentence carries. */
  now = () => new Date().toISOString()
} = {}) {
  let bindingFilter = null;
  if (accountBindings !== null) {
    if (!Array.isArray(accountBindings) || accountBindings.length > 256
      || accountBindings.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
      || new Set(accountBindings).size !== accountBindings.length) {
      return Object.freeze({ ok: false, code: 'ACCOUNT_USAGE_BINDINGS_INVALID', accounts: Object.freeze([]),
          reason: 'The requested account bindings are invalid.' });
    }
    bindingFilter = new Set(accountBindings);
  }
  let configPath;
  let registryRead;
  try {
    configPath = registryPath || accountRegistryPath();
    providerIsolation.assertIsolatedPath(configPath, providerIsolation.isolationContext(), { field: 'account registry' });
    registryRead = readRegistryQuietly(configPath, { fsImpl });
  } catch (error) {
    return Object.freeze({
      ok: false, code: CODE.UNREADABLE, accounts: Object.freeze([]),

      reason: 'The account list location could not be worked out on this computer.',
      detail: (error && error.code) || null
    });
  }
  const { registry, code } = registryRead;
  if (!registry) {
    return Object.freeze({
      ok: false, code, accounts: Object.freeze([]),
      reason: code === CODE.NOT_CONFIGURED
        ? 'No accounts are listed on this computer yet.'
        : 'The account list on this computer could not be read.'
    });
  }

  try {
    const context = providerIsolation.isolationContext();
    for (const account of context ? registry.accounts : []) {
      providerIsolation.assertIsolatedPath(resolveProfileDir(account, { homeDir }), context,
        { field: 'provider account home' });
    }
  } catch (error) {
    return Object.freeze({ ok: false, code: CODE.UNREADABLE, accounts: Object.freeze([]),
       reason: 'A provider account leaves this isolated session.', detail: error.code || null });
  }

  const wanted = Array.isArray(providers) && providers.length > 0
    ? [...new Set(providers.filter(id => providerSpec(id)))]
    : PROVIDER_IDS;

  const rows = [];
  /* The same bounded pool covers every provider. A large account list used
     to start a process (two for Claude) for every entry simultaneously.
     Probes retain their own process deadlines; this does not abandon their
     lifetime or manufacture an allowance when a provider cannot answer. */
  const batches = wanted.map(id => {
    const candidates = accountsFor(registry, id).filter(account => {
      if (!bindingFilter) return true;
      try {
        return bindingFilter.has(accountUsageBinding({ ...account, directory: resolveProfileDir(account, { homeDir }) }));
      } catch { return false; }
    });
    let probe = null;
    if (candidates.length) {
      try {
        probe = probeFor ? probeFor(id)
          : defaultProbeFor(id, { homeDir, ...PROVIDER_CEILING_THRESHOLDS, fsImpl, usageProbe, timeoutMs });
      } catch { /* This provider is unreadable; the others can still answer. */ }
    }
    return { id, candidates, probe, readings: new Map() };
  });
  const jobs = batches.flatMap(batch => batch.candidates.map(account => ({ batch, account })));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(ACCOUNT_USAGE_CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const { batch: { id, probe, readings }, account } = jobs[next++];
      let observed = null;
      try { observed = await probe(account); }
      catch (error) { observed = cleanupUnproven(error) ? transientReading(account, error) : null; }
      let allowanceBinding = null;
      try { allowanceBinding = accountUsageBinding({ ...account, directory: resolveProfileDir(account, { homeDir }) }); }
      catch { /* An unresolved account has no identity to bind a cached value. */ }
      readings.set(account.name, observed);
      const row = {
        name: account.name,
        provider: id,
        allowanceBinding,
        readAt: observed && Object.hasOwn(observed, 'readAt')
          ? (typeof observed.readAt === 'string' ? observed.readAt : null) : now(),
        usageStatus: ['measured', 'unavailable', 'not_reported', 'unsupported'].includes(observed?.usageStatus)
          ? observed.usageStatus : id === 'gemini' && account.client !== 'antigravity' ? 'unavailable' : null,
        usageSource: typeof observed?.usageSource === 'string' ? observed.usageSource : null,
        usageCode: typeof observed?.usageCode === 'string' ? observed.usageCode
          : id === 'gemini' && account.client !== 'antigravity' ? 'GEMINI_USAGE_UNAVAILABLE' : null,
        usageReason: typeof observed?.usageReason === 'string' ? observed.usageReason
          : id === 'gemini' && account.client !== 'antigravity'
            ? 'Gemini allowance is unknown. Start an agent to let the official Gemini CLI check whether it can serve.' : null,
        reportedUsage: observed?.reportedUsage || null,
        allowanceBuckets: null,
        ...(account.client ? { client: account.client, identityScope: 'current-user' } : {}),

        role: account.role,
        /* Every field below is copied from the probe, and every one of them is
           null when the probe did not answer it. A panel drawing 0% from a
           missing reading is the one failure this whole lane is written
           against. */
        status: observed && typeof observed.status === 'string' ? observed.status : null,
        canServe: observed ? observed.canServe === true : false,
        /* THE ACCOUNT THE PROGRAM SAYS IT IS SIGNED IN AS, carried instead of
           dropped. MEASURED 2026-09-03: both live probes already report it --
           health.js's classifyProbe returns `email` for Codex, and
           claudeProbeFactory returns `observed.account` for Claude -- and this
           row threw it away, so the accounts menu could name a row "work" over
           a home signed in as somebody else and show nothing to say so.
           An identity, not a credential: health.js's own header draws that
           line ("It reads an account's e-mail ... Nothing else leaves it"),
           and this channel is reachable only from the application's main
           frame, so no agent gains anything it could not already ask for. */
        email: observed && typeof observed.email === 'string' && observed.email ? observed.email : null,
        usedPercent: observed && Number.isFinite(observed.usedPercent) ? observed.usedPercent : null,
        resetsAt: observed && typeof observed.resetsAt === 'string' ? observed.resetsAt : null,
        windows: observed && observed.windows ? observed.windows : NO_WINDOWS,
        planType: observed && typeof observed.planType === 'string' ? observed.planType : null,
        reason: observed && typeof observed.reason === 'string'
          ? observed.reason
          : 'This account could not be checked just now, so nothing is known about its allowance.'
      };
      // Internal callers may retry the retained cleanup operation; serialization
      // carries only the bounded status/code, never a function or process handle.
      if (typeof observed?.retryCleanup === 'function') Object.defineProperty(row, 'retryCleanup', { value: observed.retryCleanup });
      const lifecycle = probeLifecycleOf(observed);
      rows.push(lifecycle ? withProbeLifecycle(row, lifecycle) : Object.freeze(row));
    }
  }));

  return Object.freeze({
    ok: true,
    code: null,
    reason: null,
    /* WHEN THIS WAS READ, so a surface that keeps the answer can say how old
       it is rather than showing a number as if it were now. */
    readAt: now(),
    accounts: Object.freeze(rows),


  });
}

/**
 * Which account each provider is recorded as running under, for a surface that
 * shows the person what is happening. Names and statuses only.
 *
 * Never throws and never opens a sign-in file. An absent record answers "not
 * known", which is the honest answer before the first session has ever run.
 */
function activeAccountRecord(servicesRoot, { fsImpl = fs, statePath = null } = {}) {
  if (typeof servicesRoot !== 'string' || servicesRoot.length === 0) return null;
  try {
    const state = readState(statePath || statePathFor(servicesRoot), { fsImpl });
    const chooseAgain = Object.values(state.selectionUnreadableByProvider || {}).some(Boolean);
    return Object.freeze({
      ...(chooseAgain ? { code: CODE.STATE_UNREADABLE,
        reason: 'The saved account selection could not be read. Open Accounts and choose an account before starting again.' } : {}),
      activeAccount: state.activeAccount,
      /* One name per provider, or null for a record written before the map
         existed. A surface that marks a row "in use" should read this and
         match the row's provider as well as its name. */
      activeByProvider: state.activeByProvider ? Object.freeze({ ...state.activeByProvider }) : null,
      /* THE STANDING CHOICE, BESIDE THE ACCOUNT ACTUALLY RUNNING, because they
         answer different questions and the person's own choice is the one no
         start overwrites. Resolved through manualPin() rather than by reading
         `manualPinByProvider` here, so a record written before that field
         existed is still answered from its `manual-switch` history by the one
         reader that knows how -- a second interpretation of the same bytes is
         how two surfaces end up disagreeing about what the person chose. */
      manualPinByProvider: Object.freeze(Object.fromEntries(
        PROVIDER_IDS.map(id => [id, manualPin(state, id)])
      )),
      lastSwitch: state.lastSwitch ? Object.freeze({ ...state.lastSwitch }) : null
    });
  } catch (error) {
    return Object.freeze({
      activeAccount: null,
      activeByProvider: null,
      manualPinByProvider: null,
      lastSwitch: null,
      code: CODE.STATE_UNREADABLE,
      detail: (error && error.code) || null,
      reason: 'The active account record could not be read just now; this does NOT claim that no active account is recorded.'
    });
  }
}

module.exports = Object.freeze({
  ACCOUNT_REQUEST_SELECTION_VERSION: 1,
  ACCOUNT_MODEL_SCOPE_CONTRACT_VERSION: 1,
  // Every launch and native resume uses the provider ceiling.
  ACCOUNT_RESUME_PROVIDER_LIMIT_VERSION: 1,
  PROVIDER_CEILING_THRESHOLDS,
  ACCOUNT_CLIENT_CONTRACT_VERSION: 1,
  ACCOUNT_USAGE_CONCURRENCY,
  ACCOUNT_USAGE_BINDING_FILTER_VERSION,
  CLAUDE_CACHE_FRESHNESS_BUDGET_MS,
  CLAUDE_READING_REUSE_MS,
  CLAUDE_USAGE_PROBE_TIMEOUT_MS,
  CODE,
  STATE_LEAF,
  activeAccountRecord,
  accountUsageBinding,
  claudeAllowanceFromReading,
  claudeProbeFactory,
  claudeSelectionReason,
  claudeStatusOf,
  defaultProbeFor,
  forgetRecentClaudeReadings,
  manualPin,
  readAccountUsage,
  readRegistryQuietly,
  resolveAccountForSession,
  statePathFor
});
