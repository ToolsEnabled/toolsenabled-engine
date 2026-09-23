'use strict';
// THE SEAM BETWEEN THE ROTATION MACHINERY AND A REAL AGENT START.
//
// WHAT WAS WRONG, MEASURED 2026-08-18 BY INSTRUMENTING THE SHIPPED START PATH.
// registry.js, health.js, switcher.js and launch.js were all correct, all
// tested, and all UNREACHABLE from the thing a person actually does. The only
// non-test callers of resolveForLaunch() were tools/account.js -- a builder CLI
// that is not in the payload -- and codex-cloud-launch.js, which is the Cloud
// path. Starting an agent locally called NONE of it: agent-session-confinement.js
// read `process.env.CODEX_HOME || ~/.codex` and hard-linked that ONE credential,
// verified by inode. The switcher's own state file recorded 20 selections and
// every single one had `automatic: false`, which is the machinery saying, in its
// own records, that it had never once fired on its own.
//
// So this module is not new rotation logic. It is the missing CALL. Selection,
// ordering, exhaustion and the failover policy all still live in switcher.js and
// health.js and are not restated here.
//
// FIVE PROPERTIES, AND EACH ONE IS A REFUSAL TO REPEAT A KNOWN FAILURE.
//
// 1. IT NEVER BLOCKS A START THAT WOULD HAVE WORKED. Every "there is nothing to
//    rotate" condition -- no registry file, an unreadable one, one that lists no
//    account for this provider -- answers `rotated: false` and NOTHING ELSE. The
//    caller then does exactly what it did before this file existed. A person who
//    has never heard of multi-account must not be able to tell that this code
//    shipped. That is why loadRegistry()'s refusals are caught here rather than
//    relaxed there: a builder running `node tools/account.js` should still get a
//    loud error for a corrupt file; a customer starting an agent should not.
//
// 2. IT NEVER READS, COPIES, TRANSMITS OR HOLDS A CREDENTIAL. It resolves
//    DIRECTORY NAMES and hands one to the provider's own official program, which
//    signs itself in exactly as it does in the person's own terminal. The user
//    ran `codex login` / `claude auth login` into that home themselves (MEASURED
//    2026-08-18 off the installed claude 2.1.186: there is no bare `claude login`;
//    `login` is a subcommand of `auth`). This is a
//    product invariant, stated verbatim in the legal position of 2026-08-18:
//    "we never read, copy, transmit, or hold a provider credential store;
//    sign-in happens inside the official client's own flow."
//    tests/multi-account-rotation.test.js asserts it against this file's SOURCE,
//    because an absence of code is not observable from behaviour.
//
// 3. LIMITS ARE SURFACED, NEVER CIRCUMVENTED. Rotation moves between accounts
//    the SAME person subscribes to, and each account's own limit is respected
//    individually -- an exhausted account is skipped, never worked around, and
//    nothing here retries, spoofs, or re-frames a refusal. Whether it may move
//    at all is the person's explicit choice (`mode`), it defaults to `manual`,
//    and the account in use is reported so a surface can show it. This is a
//    binding condition of the same legal position.
//
// 4. `manual` MEANS MANUAL. The settings row's own words are "Stop and let me
//    switch". So in manual mode an exhausted account STOPS with a next step
//    naming the account and what to do -- it does not quietly switch, and it
//    does not quietly carry on into a refusal the person cannot interpret. A
//    setting whose off position is indistinguishable from its on position is
//    the defect the owner has already named once.
//
// 5. A CLAUDE ACCOUNT ON API BILLING IS NEVER SELECTED. This is the condition
//    that used to make the registry refuse Claude outright: every Codex-shaped
//    health signal comes back green for a Claude home that is silently billing
//    ANTHROPIC_API_KEY per token, so rotation would happily walk three accounts
//    that are all costing money. claude-auth-probe.js reports `billingSource`
//    off the CLI's own `apiKeySource` field, and a home that is not on the
//    subscription is treated as unusable rather than selected.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { DEFAULT_PROBE_TIMEOUT_MS, STATUS, identityVerdict } = require('./health.js');
const { PROVIDER_IDS, accountsFor, exhaustionThresholds, loadRegistry, providerSpec, resolveProfileDir } = require('./registry.js');

/* THE PROVIDER'S OWN CEILING, which is what "spent" means when nobody has
   expressed a preference. 100 in every window, so only the provider's explicit
   refusal or a genuinely full allowance classes an account exhausted. Used for
   an exact resume; every automatic start keeps the registry's own numbers. */
const PROVIDER_CEILING_THRESHOLDS = Object.freeze({
  exhaustedAtPercent: 100, exhaustedAtPercentHourly: 100, exhaustedAtPercentWeekly: 100
});

/* WHICH LIMIT A RESOLVE IS JUDGED AGAINST, as one named decision rather than a
   ternary buried in a probe factory. It is named because it is the whole of
   T367: the configured cutoff governs AUTOMATIC selection, and an exact resume
   is judged on the provider's ceiling. A test can assert that decision without
   spawning a provider, and a gate can prove it by mutation -- make this ignore
   `providerLimitsOnly` and the resume is refused by a number on the Accounts
   page again. */
function resolveThresholds(registry, providerLimitsOnly) {
  return providerLimitsOnly === true ? PROVIDER_CEILING_THRESHOLDS : exhaustionThresholds(registry);
}
const { accountRegistryPath } = require('./registry-location.js');
const providerIsolation = require('../provider-session-isolation');
const { probeLifecycleOf, withProbeLifecycle } = require('./probe-lifecycle');
const { activeFor, commitLaunchSelection, readState, resolveForLaunch, selectAccount } = require('./switcher.js');
const {
  DEFAULT_RANK_WINDOW,
  DEFAULT_RESERVE_PERCENT,
  DEFAULT_SELECTION_MODE,
  MODE,
  isAutomatic,
  normalizeRankWindow,
  normalizeReservePercent,
  normalizeSelectionMode,
  orderAccounts
} = require('./selection-modes.js');

/* THE RULE IN FORCE FOR ONE PROGRAM: its own entry where the person set one,
   the global record for whatever that entry left out. Each field answers null
   when nobody set it anywhere, so the caller's precedence keeps working. */
function providerPolicyOf(registry, providerId) {
  const own = registry && registry.selectionByProvider ? registry.selectionByProvider[providerId] : null;
  const pick = key => (own && own[key] != null ? own[key] : (registry && registry[key] != null ? registry[key] : null));
  return Object.freeze({
    selectionMode: pick('selectionMode'),
    reservePercent: pick('reservePercent'),
    rankWindow: pick('rankWindow'),
    /* Whether THIS program has a rule of its own, so a surface can say so. */
    own: Boolean(own && (own.selectionMode != null || own.reservePercent != null || own.rankWindow != null))
  });
}
const { NO_WINDOWS, bindingWindow, claudeWindows, headroomPercent, spentWindow, windowLimits, recoveryTiming } = require('./usage-windows.js');
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

// `manual` first, and that order is load-bearing rather than alphabetical: it is
// the safest option, it is what the app's own settings row already lists first,
// and it is what an unreadable or absent answer falls back to.
const FAILOVER_MODES = Object.freeze(['manual', 'auto']);
const DEFAULT_FAILOVER_MODE = 'manual';

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

function normalizeMode(mode) {
  return FAILOVER_MODES.includes(mode) ? mode : DEFAULT_FAILOVER_MODE;
}

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
    /* Present on every answer, including the ones taken before the mode was
       worked out, so a caller never has to tell "no mode key in this build"
       from "no mode was chosen". Both are null here and both mean the same
       thing: nothing was ordered, because nothing was rotated. */
    selectionMode: null,
    selectionWhy: null,
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
    /* The metered-key sentence is the whole reason, with no allowance clause
       after it: what is wrong with that account is the billing route, not the
       figure. It is decided in claudeSelectionReason() rather than here so the
       account router (../tool-registry.js) reads the same sentence. */
    const metered = Boolean(observed) && observed.billingSource === 'api_key';
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
        : (metered || !allowance.note ? sentence : `${sentence} ${allowance.note}`)
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
 *                        FAILOVER_STATUSES leaves it out on purpose): the wrong
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
// FAILOVER_STATUSES is written against. `indeterminate` becomes `transient`,
// which STOPS the cascade rather than spending another account on a guess --
// the same policy both modules already state in their own words.
/* The sentence shown for a selected-but-unproven home. The probe's own reason
   tells an operator to re-run with capability checking, which is advice for the
   probe CLI, not for a person pressing Start.

   AND THE SAME IS TRUE OF A SPENT ONE, WHICH THIS GUARD USED TO MISS.
   MEASURED 2026-09-03 in the installed copy's own accounts-usage-cache.json
   (%APPDATA%/ToolsEnabled-Live), the exhausted Claude row read:

     "The account surface reports a signed-in session, but no request was made,
      so it is not proven able to serve one. Re-run with capability checking
      enabled to resolve this. 92% of its weekly allowance is used; ..."

   -- ../providers/claude-auth-probe.js's INDETERMINATE sentence, verbatim,
   under a row already flagged "exhausted". It reached that row because the
   rewrite below was guarded on STATUS.HEALTHY alone, so every other status
   inherited the probe CLI's wording. An account is EXHAUSTED here in one of
   two ways and both are now said in the switcher's own words: the figure this
   computer read is at or over the limit it is judged against, or the provider
   itself refused a request for allowance reasons.

   NO RESET TIME IN THE SENTENCE, for the reason ./claude-allowance.js states
   about its note: `resetsAt` and every window carry the time, and the accounts
   menu says it in words (account-switcher-state.js resetPhrase) rather than as
   an ISO string. The api_key case never reaches here -- claudeSelectionReason
   below answers it before this is asked.


   AND THE THIRD STATUS, WHICH REWRITING PER STATUS LEFT BEHIND AGAIN.
   The two guards above name a status apiece, so every status they do not name
   still inherits the probe's voice -- the shape that let the CLI's advice onto
   the exhausted row in the first place. MEASURED 2026-09-03 by driving
   ../providers/claude-auth-probe.js's own classifyClaudeAuth() through
   claudeProbeFactory above (a readable usage cache on the folder, a status
   probe that timed out), the row a person reads came back:

     status transient, canServe false, "The Claude account surface could not be
     reached (timed out after 6000ms). This is not evidence about the account,
     so it is not treated as a sign-out. 92% of its weekly allowance is used."

   -- "the account surface" and "treated as a sign-out" are the probe's own
   vocabulary for the thing it spawned and for where it routes the answer, and
   "(timed out after 6000ms)" is a machine value under a row in the accounts
   menu, which is the one thing this whole sentence set exists to keep out.
   The unreadable-response branch lands in the same place with the same shape.

   SO IT IS ANSWERED ON WHAT WAS OBSERVED, NOT ON WHERE THE ROW WAS ROUTED.
   `billingSource` is the fact that separates the three: the probe sets it from
   the account surface's own reply, so `subscription` (or `api_key`) means a
   sign-in WAS seen and null on an indeterminate answer means the surface never
   said. Nothing was seen, so nothing is claimed -- and NOT the "Signed in on
   the subscription" sentence above, which on this row would be an invention:
   could-not-look and not-there are different answers, and this is the first.
   It is not called signed out either; that is the SIGNED_OUT row's sentence
   and it sends a person somewhere else entirely.

   THE TRANSPORT DETAIL IS DROPPED ON PURPOSE. The two branches differ only in
   the probe's prose ("could not be reached" vs "returned an unreadable
   response"), so telling them apart here would mean parsing that prose -- and
   the millisecond count is not a thing a person acts on. What is actionable is
   that it is the Claude program that did not answer, which the sentence says,
   beside a row already flagged with its status. The probe's own reason is
   untouched for every other reader of it. */
function selectionReason(observed, status) {
  if (status === STATUS.HEALTHY && observed && observed.capabilityRan === false && observed.state === 'indeterminate') {
    return `Signed in on the subscription${observed.account ? ` as ${observed.account}` : ''}; the first turn proves it can serve.`;
  }
  if (status === STATUS.EXHAUSTED) {
    return observed && observed.state === 'rate_limited'
      ? 'Signed in, but the provider refused the last request for allowance reasons, so this account is not being started.'
      : 'Signed in, but this account is out of allowance for now, so it is not being started.';
  }
  if (observed && observed.state === 'indeterminate' && observed.capabilityRan === false && observed.billingSource === null) {
    return 'This copy could not read the Claude sign-in for this account, so whether it is signed in is not known right now. It is not being started, and it is not being called signed out or out of allowance.';
  }
  return observed && observed.reason;
}

/**
 * THE ONE SENTENCE A CLAUDE ROW IS GIVEN, WHEREVER THE ROW IS DRAWN.
 *
 * claudeStatusOf() below is asked by TWO surfaces -- claudeProbeFactory above,
 * which fills the accounts menu, and ../tool-registry.js listAccountRouter(),
 * which is what an agent reads through `system.status includeAccountRouter`.
 * Only the first of them rewrote the sentence, so the router kept forwarding
 * ../providers/claude-auth-probe.js's own reason under whatever status it had
 * just computed.
 *
 * MEASURED 2026-09-03 on this tree, driving listAccountRouter() with the
 * measured billing tell (`billingSource: 'api_key'`, `capabilityRan: false`)
 * and no provider spawned: the row came back
 *
 *   healthStatus: exhausted
 *   reason: "The account surface reports a signed-in session, but no request
 *            was made, so it is not proven able to serve one. Re-run with
 *            capability checking enabled to resolve this."
 *
 * -- the INDETERMINATE sentence, which is advice for somebody running the probe
 * from a command line, printed as the explanation of an EXHAUSTED account. That
 * is the same defect the accounts menu was repaired for, on the other surface.
 *
 * THE METERED KEY IS ANSWERED FIRST because it is the one exhaustion that is
 * not about allowance at all: claudeStatusOf() calls an api_key sign-in
 * EXHAUSTED so nothing starts on it, and "out of allowance" would send a person
 * to wait for a reset that is never coming. `accountName` is the row's own
 * label, so the sentence names the row a person is looking at.
 */
function claudeSelectionReason(observed, status, accountName) {
  if (observed && observed.billingSource === 'api_key') {
    return `"${accountName}" is set up to bill a metered key rather than the subscription, so it was skipped.`;
  }
  return selectionReason(observed, status);
}

function claudeStatusOf(observed, STATE) {
  if (!observed || typeof observed !== 'object') return STATUS.TRANSIENT;
  if (observed.billingSource === 'api_key') return STATUS.EXHAUSTED;
  /* SIGNED IN ON THE SUBSCRIPTION, NOT YET LIVE-PROVEN, IS SELECTABLE.
   *
   * Measured 2026-09-02 on the installed 1.0.40: this factory probes with
   * `capability: false` (by design, it must not spend allowance before every
   * start), and claude-auth-probe.js answers INDETERMINATE for every signed-in
   * home on that path, because only a live request can produce AUTHENTICATED.
   * Mapping that INDETERMINATE to TRANSIENT meant canServe was false for EVERY
   * Claude account, so a listed Claude account could never be selected --
   * the registry answered ACCOUNT_NONE_USABLE with a healthy Max sign-in --
   * and listing one was strictly worse than listing none.
   *
   * The free surface proves identity and the billing route. That is enough to
   * CHOOSE an account; whether it can serve is proven by the launch itself,
   * loudly, on the first turn. What stays TRANSIENT is the other
   * INDETERMINATE: a live request WAS made and failed for no attributable
   * reason, which is not grounds to pick this home or to switch away from it. */
  if (observed.state === STATE.INDETERMINATE
      && observed.capabilityRan === false
      && observed.billingSource === 'subscription') {
    return STATUS.HEALTHY;
  }
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

/* THE PIN: A SWITCH MADE BY HAND STANDS UNTIL THE PERSON CHANGES IT.
 *
 * Under the usage-ranked modes the ranked head was always handed to the
 * switcher as `preferred`, which beat the account the person had just chosen
 * on the menu -- so "Use this one" confirmed a switch that the next start
 * ignored and then overwrote, recording the ranking's own move as a switch
 * made by a person. The first repair made the choice go first ONCE, which was
 * still wrong for the case that actually happens.
 *
 * MEASURED 2026-09-03 IN THE OWNER'S OWN RECORD
 * (%LOCALAPPDATA%/ToolsEnabled-Live/multi-account-state.json; account names
 * withheld from source per ACCOUNT-FENCE.md): entry 10 is a
 * hand switch to the pinned account at 13:16:57Z; entry 11, 87 seconds later, is a
 * start that put that account first exactly as the pin intended, found it 92%
 * through a weekly window that did not reset until 16:59:59Z, and used a
 * DIFFERENT account instead. That start's own `selected` entry then
 * became this provider's last one -- so the pin was spent by the start that
 * could NOT honour it, `activeByProvider.claude` was overwritten with the
 * failover's account, and from 13:18:24Z onward nothing on the machine knew a
 * choice had ever been made. Not at 16:59 when the chosen account's allowance
 * came back either. That is the "reverted in about two and a half minutes"
 * the owner reported, and it is one-shot pinning working as written.
 *
 * SO THE CHOICE IS A STANDING FACT, NOT AN EVENT THAT GETS CONSUMED. It is
 * recorded in `manualPinByProvider` (switcher.js), which only a person's own
 * switch writes, and it is offered to the switcher as `preferred` on EVERY
 * start. A start that cannot use it fails over for that start alone and says
 * so (see the sentence built in resolveAccountForSession); the choice is still
 * there for the next one. The ranking is what happens when nobody has chosen,
 * which is what a standing answer to "and if nobody named one" always was.
 *
 * A RECORD WRITTEN BEFORE THE FIELD EXISTED STILL ANSWERS. Its history carries
 * the `manual-switch` entry, so the last one ABOUT THIS PROVIDER names the
 * choice, and the first start to commit after this build promotes that name
 * into the field -- before the twenty-entry history it lives in rolls over.
 *
 * PER PROVIDER, BECAUSE THE RECORD IS SHARED. Every program appends to the
 * same history and every commit overwrites `lastSwitch`, so reading only the
 * final entry let a Codex start consume a Claude switch: the person chose a
 * Claude account on the menu, started a Codex agent, and the next Claude
 * start ranked again as though nothing had been chosen. Both the map and the
 * history walk are per provider, and an entry naming no provider is what a
 * record written before that field existed looks like. */
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

/**
 * Choose which of the person's own accounts this session runs as.
 *
 * Returns a plain record and NEVER throws. A caller that gets `rotated: false`
 * must carry on exactly as it did before this module existed -- that is the
 * contract, and it is what makes this safe to put in front of every start.
 *
 * `probe` is injectable so the selection policy can be measured without
 * spending a provider request. The documented seam is used by
 * tests/multi-account-rotation.test.js to drive a forced exhaustion through the
 * code's own classification rather than by draining a real account.
 *
 * `selectionMode` is the person's answer to "which account should go first"
 * (./selection-modes.js). `mode` is the older two-valued question it grew out
 * of, honoured only when a caller states it: `manual` means manual and `auto`
 * means the registry order this function has always walked. With nothing
 * stated anywhere the DEFAULT applies -- the listed order, walked until an
 * account runs out (./selection-modes.js says why that is the default).
 */
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

// Starts sharing one runtime wait their turn before reading the persisted
// cursor. Probes may await; without this queue concurrent starts all choose
// the same next account. Other modes and providers remain independent.
const rotationTurns = new WeakMap();
async function withRotationTurn(record, provider, fsImpl, signal, run) {
  let turns = rotationTurns.get(fsImpl);
  if (!turns) { turns = new Map(); rotationTurns.set(fsImpl, turns); }
  const key = JSON.stringify([path.resolve(record), provider]);
  const previous = turns.get(key) || Promise.resolve();
  let release;
  const own = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => own);
  turns.set(key, tail);
  try {
    await awaitAccountProbe(previous, signal);
    signal?.throwIfAborted();
    return await run();
  } finally {
    release();
    void tail.then(() => { if (turns.get(key) === tail) turns.delete(key); });
  }
}

async function resolveAccountForSession({
  provider = 'codex',
  client = null,
  model = null,
  servicesRoot,
  homeDir = process.env.USERPROFILE || process.env.HOME || '',
  mode = null,
  selectionMode = null,
  reservePercent = null,
  rankWindow = null,
  preferred = null,
  excludeAccounts = [],
  keepTryingAccounts = false,
  recheckAttempt = 0,
  /* JUDGE THIS ACCOUNT ON THE PROVIDER'S LIMIT ALONE, ignoring the cutoff this
     computer configured. Set for an EXACT resume: that cutoff exists to spread
     AUTOMATIC starts across accounts, and applying it to a named saved
     conversation turns a person away from their own thread on their own
     preference. See the caller in shell/main.cjs. */
  providerLimitsOnly = false,
  // A managed-slot choice belongs to this start, not the computer's rotation state.
  persistSelection = true,
  probe = null,
  usageProbe = undefined,
  statePath = null,
  fsImpl = fs,
  signal = null,
  /* The settings row's reader, injectable so a test can drive slot 4 below
     without a settings file on the machine running it. */
  failoverChoiceImpl = null,
  now = () => new Date().toISOString()
} = {}) {
  /* Intentional cancellation is the exception to the optional-registry
     fallback: it must stop before even a state read can quarantine a file. */
  signal?.throwIfAborted();
  let privateContext;
  try { privateContext = providerIsolation.isolationContext(process.env, { servicesRoot: servicesRoot || null }); }
  catch (error) { return notRotated(error.code || 'AGENT_PROVIDER_ISOLATION_INVALID', error.message); }
  const spec = providerSpec(provider);
  if (!spec) return notRotated(CODE.NONE_FOR_PROVIDER, `Nothing is set up to switch accounts for ${provider}.`);
  if (typeof servicesRoot !== 'string' || servicesRoot.length === 0) {
    return notRotated(CODE.NOT_CONFIGURED, 'This computer has no place recorded for its account list, so the usual sign-in is used.');
  }

  // servicesRoot is only for the independent rotation-state record below.
  // Resolving the installed-product identity is optional on this start path in
  // exactly the same way as reading its registry: neither may escape the
  // resolver's never-throws boundary and prevent the usual sign-in.
  let configPath;
  let registryRead;
  try {
    configPath = accountRegistryPath();
    providerIsolation.assertIsolatedPath(configPath, privateContext, { field: 'account registry' });
    registryRead = readRegistryQuietly(configPath, { fsImpl });
  } catch (error) {
    return notRotated(CODE.UNREADABLE,
      'The account list location could not be worked out, so the usual sign-in is used.',
      { detail: (error && error.code) || null });
  }
  const { registry, code } = registryRead;
  if (!registry) {
    return notRotated(code, code === CODE.NOT_CONFIGURED
      ? 'No extra accounts are listed on this computer, so the usual sign-in is used.'
      : `The account list on this computer could not be read, so the usual sign-in is used. Open ${configPath} and correct it, or remove it.`);
  }

  // A fresh recovery must never silently fall back to the account whose turn
  // exhausted its allowance. The ordinary resolver still owns eligibility.
  if (!Array.isArray(excludeAccounts) || excludeAccounts.length > 32
    || excludeAccounts.some(name => typeof name !== 'string' || !name || name.length > 120)) {
    return Object.freeze({ rotated: false, blocked: true, code: 'ACCOUNT_RECOVERY_INVALID', reason: 'The recovery account exclusions are invalid.' });
  }
  if (client != null && (spec.id !== 'gemini' || client !== 'antigravity')) {
    return Object.freeze({ rotated: false, blocked: true, code: 'ACCOUNT_CLIENT_INVALID',
      reason: 'The selected account client does not match this provider.' });
  }
  const excluded = new Set(excludeAccounts);
  const compatible = accountsFor(registry, spec.id).filter(account => (account.client || null) === client);
  if (spec.id === 'gemini' && compatible.length === 0 && (client || accountsFor(registry, spec.id).length)) {
    return Object.freeze({ rotated: false, blocked: true, code: 'ACCOUNT_CLIENT_UNAVAILABLE',
      reason: 'No registered account uses the selected Gemini client. Choose a compatible account or model.' });
  }
  const candidates = compatible.filter(account => !excluded.has(account.name));
  if (privateContext) {
    try {
      for (const account of candidates) {
        providerIsolation.assertIsolatedPath(resolveProfileDir(account, { homeDir }), privateContext,
          { field: 'registered provider account' });
      }
    } catch (error) { return notRotated(error.code || 'AGENT_PROVIDER_ISOLATION_PATH', error.message); }
  }
  if (excluded.size && candidates.length === 0) {
    const retry = keepTryingAccounts === true
      ? recoveryTiming([{ status: 'transient' }], exhaustionThresholds(registry), Date.parse(now()), { recheckAttempt })
      : null;
    return Object.freeze({ rotated: false, blocked: true, code: 'ACCOUNT_RECOVERY_NO_ALTERNATE',
      reason: retry ? 'The listed accounts have already been tried. Their status will be checked again after a bounded wait.'
        : 'No other account is available for this program. Add or restore an account, then retry.',
      ...(retry ? { retry, keepTryingAccounts: true, attempts: [] } : {}) });
  }
  if (candidates.length === 0) {
    return notRotated(CODE.NONE_FOR_PROVIDER,
      `No ${spec.id} accounts are listed on this computer, so the usual sign-in is used.`);
  }

  const record = statePath || statePathFor(servicesRoot);
  try { providerIsolation.assertIsolatedPath(record, privateContext, { field: 'account selection state' }); }
  catch (error) { return notRotated(error.code || 'AGENT_PROVIDER_ISOLATION_PATH', error.message); }
  /* WHO DECIDES THE ORDER, IN THE ONE ORDER OF PRECEDENCE THERE IS.
   *
   *   1. what this CALL asked for, because a caller naming a mode has a reason;
   *   2. what the person recorded IN THE REGISTRY, which is what the panel
   *      writes and therefore what "this computer is set to" means;
   *   3. the older two-valued `mode`, only when a caller STATED one --
   *      `auto` is the registry-order walk this function has always done and
   *      `manual` is the stop;
   *   4. the `accounts.failover` SETTINGS ROW, when the person chose one.
   *      MEASURED 2026-09-03: the catalogue named this file as the row's
   *      enforcer and this file never asked what the row said, so the control
   *      moved and nothing happened -- and slot 3 above had no production
   *      caller either (shell/main.cjs resolveSessionAccount passes
   *      `selectionMode` and never `mode`), which is what left slots 1-3 all
   *      silent on a real start and the default deciding every time. The row
   *      is read last of the four because it is the GLOBAL answer and slots 1-3
   *      are all more specific; ./failover-setting.js is what refuses to read
   *      a value nobody chose;
   *   5. with nothing stated anywhere, the default: the listed order, walked
   *      until an account runs out. This used to be the stop, and a person who
   *      had added and signed in a second account found it never used
   *      (owner, 2026-09-02). Stopping is still one choice away on the menu.
   *
   * Reading the registry second rather than last is what makes the dropdown
   * real: a setting that lost to an older answer would be a setting whose off
   * position is indistinguishable from its on position. */
  const legacy = FAILOVER_MODES.includes(mode) ? mode : null;
  /* The registry's answer for THIS program: its own rule where one was set,
     the global rule otherwise (owner, 2026-09-02: "by provider"). */
  const recorded = providerPolicyOf(registry, spec.id);
  /* Asked ONLY when slots 1-3 said nothing, so a start that already has its
     answer never pays for opening the settings file to be told the same thing. */
  const rowSaid = (selectionMode !== null || recorded.selectionMode != null || legacy !== null)
    ? null
    : (failoverChoiceImpl || require('./failover-setting.js').failoverChoice)();
  const chosenRow = rowSaid && rowSaid.chosen === true ? rowSaid.value : null;
  const configuredSelection = selectionMode !== null
    ? normalizeSelectionMode(selectionMode)
    : (recorded.selectionMode != null
      ? normalizeSelectionMode(recorded.selectionMode)
      : (legacy === 'auto' ? MODE.PRIORITY
        : legacy === 'manual' ? MODE.MANUAL
          : chosenRow === 'auto' ? MODE.PRIORITY
            : chosenRow === 'manual' ? MODE.MANUAL
              : DEFAULT_SELECTION_MODE));
  // This one start carries the person's explicit per-node retry choice. It
  // does not rewrite the standing account preference or permit an unknown account.
  const chosenSelection = keepTryingAccounts === true && configuredSelection === MODE.MANUAL ? MODE.PRIORITY : configuredSelection;
  const automatic = isAutomatic(chosenSelection);
  const reserve = normalizeReservePercent(
    reservePercent === null ? recorded.reservePercent : reservePercent
  );
  const chosenWindow = normalizeRankWindow(rankWindow === null ? recorded.rankWindow : rankWindow);

  const chooseAndRecord = async () => {
    const singleProviderRegistry = Object.freeze({ ...registry, accounts: Object.freeze(candidates) });
    const activeProbe = probe || defaultProbeFor(spec.id, {
      homeDir, model,
      ...resolveThresholds(registry, providerLimitsOnly),
      fsImpl, usageProbe, signal
    });

    /* EVERY PROBE IS TAKEN AT MOST ONCE PER CALL, whichever path below runs.
       The manual path already needed this so its preflight and its commit could
       not observe -- or spend -- a provider check twice; the usage-ranked path
       needs it for a second reason, which is that it deliberately reads EVERY
       account before choosing, and then hands the same readings to the selection
       walk that follows. All three provider probes are free: Codex answers two
       zero-token JSON-RPC calls, Claude asks its own program for the figure its
       usage panel shows (or reads a file already on disk), and Gemini is a
       presence check.

       A PROBE THAT THROWS BECOMES A READING, NOT A REJECTED PROMISE. The cache
       used to memoise the rejection itself: the ranked ordering caught it per
       account, but the selection walk re-awaited the same promise, the outer
       catch below answered "no rotation", and one mis-declared account plus a
       spent sibling sent the start off the registry entirely with no attempt
       trail and no mode. Converted here, the walk records a transient attempt
       and stops, which is what a failed check deserves. The catch below stays
       for faults in the machinery itself. */
    const observed = new Map();
    const cachedProbe = account => {
      if (!observed.has(account.name)) {
        observed.set(account.name, Promise.resolve()
          .then(() => {
            signal?.throwIfAborted();
            return awaitAccountProbe(activeProbe(account), signal);
          })
          .then(reading => (plainObject(reading) ? reading : transientReading(account, 'no reading')))
          .catch(error => {
            signal?.throwIfAborted();
            return transientReading(account, cleanupUnproven(error) ? error : (error && (error.code || error.message)) || 'unknown error');
          }));
      }
      return observed.get(account.name);
    };

    /* THE ORDER THE PERSON ASKED FOR, WORKED OUT BEFORE ANYTHING IS COMMITTED.
     *
     * `manual` and `priority` skip this entirely and keep the registry order they
     * are defined as: reading allowances to produce an order the panel does not
     * show would be two answers to one question. Every other mode has to read
     * first, because "which account has the most room" is unanswerable from the
     * list alone.
     *
     * A PROBE THAT THROWS DOES NOT TAKE THE START DOWN. cachedProbe() has already
     * turned it into a transient reading with no windows, which
     * ./selection-modes.js leaves in registry order behind the accounts that
     * answered -- the same treatment an account whose allowance surface was
     * simply silent gets. The catch here is belt and braces for that promise. */
    let ranked = null;
    if (chosenSelection === MODE.ROTATE) {
      ranked = orderAccounts({ mode: chosenSelection, accounts: candidates,
        previousAccount: activeFor(readState(record, { fsImpl }), spec.id) });
    } else if (chosenSelection !== MODE.MANUAL && chosenSelection !== MODE.PRIORITY) {
      const readings = new Map();
      await Promise.all(candidates.map(async account => {
        try { readings.set(account.name, await cachedProbe(account)); }
        catch { signal?.throwIfAborted(); readings.set(account.name, null); }
      }));
      signal?.throwIfAborted();
      /* The registry's own threshold, so the hour this order calls spent is the
         hour health.js calls spent. Left out, the order ran on the default 99
         while a registry set to 90 had health refusing the account at its head. */
      ranked = orderAccounts({
        mode: chosenSelection, accounts: candidates, readings, reservePercent: reserve,
        rankWindow: chosenWindow,
        ...exhaustionThresholds(registry),
        /* The clock this start already carries, so "resets in 40 min" in the
           order sentence is measured from the same moment as the state record. */
        now: Date.parse(now())
      });
    }
    /* The ranked order is expressed as a registry whose accounts are already in
       that order, with its head named as `preferred`. switcher.js's candidateOrder
       then yields exactly this sequence, so the failover walk, the attempt trail
       and the refusal rules stay where they are and none of them is restated
       here. */
    const orderedRegistry = ranked
      ? Object.freeze({ ...registry, accounts: Object.freeze([...ranked.accounts]) })
      : singleProviderRegistry;
    const rankedHead = ranked && ranked.accounts.length > 0 ? ranked.accounts[0].name : null;

    let selection;
    /* THE PERSON'S OWN CHOICE, READ ON EVERY PATH BECAUSE EVERY PATH CAN LOSE IT.
       It used to be read only under the ranked modes, on the reasoning that
       `priority` keeps the previously active account at the head anyway -- but
       the previously active account is whatever the LAST FAILOVER committed, so
       under `priority` a single spent hour moved the head off the chosen account
       and left it there. The pin is the one field a failover does not write. */
    const recordedPin = manualPin(readState(record, { fsImpl }), spec.id);
    // Rotate is an explicit request to take turns, even if another mode has a
    // standing manual pin. Keep that pin saved for a later return to that mode.
    const pinned = chosenSelection === MODE.ROTATE ? null : recordedPin;
    try {
      if (!automatic) {
        /* Preflight without committing. resolveForLaunch persists a successful
         * fallback, so applying the manual gate after calling it would make a
         * refused start silently become the next start's preferred account.
         * The head is the account the person chose, else THIS provider's active
         * account: a name the other program committed is not a preference about
         * this one. */
        const state = readState(record, { fsImpl });
        const wanted = preferred || pinned || activeFor(state, spec.id) || null;
        const preflight = await selectAccount({
          registry: singleProviderRegistry, preferred: wanted, probe: cachedProbe, signal, keepTryingAccounts
        });
        if (preflight.ok && preflight.switched) selection = preflight;
        else selection = await resolveForLaunch({
          registry: singleProviderRegistry, provider: spec.id, preferred: wanted, probe: cachedProbe,
          statePath: record, fsImpl, now, manualPin: pinned, signal, keepTryingAccounts,
          /* Resolved, not yet recorded. See the commit below. */
          persistSelection: false
        });
      } else {
        selection = await resolveForLaunch({
          registry: orderedRegistry,
          provider: spec.id,
          /* AN EXPLICIT REQUEST STILL BEATS THE RANKING, AND SO DOES THE ACCOUNT
             THE PERSON CHOSE. `preferred` is a caller naming an account
             outright; `pinned` is the account the person chose on the menu and
             has not changed since (manualPin above); the ranking is this
             computer's standing answer to "and if nobody named one". Under
             `priority` there is no ranking and the pin, then the previously
             active account of THIS provider, keeps the head. */
          preferred: preferred || pinned || rankedHead,
          probe: cachedProbe,
          statePath: record,
          fsImpl,
          now,
          manualPin: pinned,
          signal,
          keepTryingAccounts,
          /* Resolved, not yet recorded. See the commit below. */
          persistSelection: false
        });
      }
    } catch (error) {
      signal?.throwIfAborted();
      /* A fault in the machinery is not a reason a person cannot work. It answers
         "no rotation" and the start proceeds on the usual sign-in, which is
         exactly what happened before this module existed. */
      return notRotated(CODE.UNREADABLE,
        'The account list could not be checked just now, so the usual sign-in is used.',
        { detail: (error && error.code) || null });
    }

    /* WHICH ORDER WAS USED, CARRIED ON EVERY ANSWER THIS FUNCTION GIVES.
       A blocked start and a successful one are equally in need of it: the panel
       that shows either has to be able to say what the setting did, and a mode
       reported only on the happy path is a mode nobody can debug on the unhappy
       one. `selectionWhy` is null under manual and priority, where the order is
       the list itself and there is nothing to explain.

       AND IT NAMES THE ACCOUNT THAT ACTUALLY RAN. The ranking's sentence
       explains the head it chose; when that head was refused and the walk moved
       on, or when a switch made by hand went first, the sentence said one name
       while another account was running. So the two cases add their own clause
       rather than leaving the ranking's claim standing alone.

       AND WHEN THE COMPUTER MOVED OFF THE ACCOUNT THE PERSON CHOSE, IT SAYS SO
       WHATEVER THE MODE IS. This clause used to be gated behind `ranked`, so on
       a machine set to `priority` -- where the order is the list and there is no
       ranking sentence to append to -- the answer was silent about it. From the
       outside that is a choice that reverted itself with no explanation
       anywhere, which is what the owner reported on 2026-09-03. The chosen
       account's OWN reading from this start's trail carries it, because the
       figure and the reset time that made the walk move on are what turn "could
       not serve" into something a person can act on. And it says the choice
       still stands, because it does. */
    /* THE ACCOUNT THAT WILL ACTUALLY RUN. Under `manual` a resolved fallback is
       refused further down rather than used, so it must never be described here
       as the account that was used. */
    const willRun = selection.ok && !(selection.switched && !automatic);
    const usedName = willRun && selection.account ? selection.account.name : null;
    const attempts = selection.attempts || [];
    const firstTried = attempts[0] ? attempts[0].account : null;
    /* "Could not look" and "not there" are different answers: an account that is
       no longer on the list is never probed, so an absent attempt is only ever
       read as a missing account when the list says the same. */
    const pinnedListed = pinned !== null && candidates.some(account => account.name === pinned);
    const pinnedAttempt = pinned === null ? null : (attempts.find(entry => entry && entry.account === pinned) || null);
    const pinnedServed = pinned === null ? null : (usedName !== null && usedName === pinned);
    const lead = ranked ? `${ranked.why} ` : '';
    let selectionWhy = ranked ? ranked.why : null;
    if (pinned !== null && pinnedServed) {
      selectionWhy = `${lead}"${pinned}" was chosen by hand, so it went first.`;
    } else if (pinned !== null && usedName !== null && pinnedAttempt) {
      selectionWhy = `${lead}"${pinned}" was chosen by hand and could not serve this start: ${pinnedAttempt.reason} "${usedName}" was used instead, and "${pinned}" is still the chosen account.`;
    } else if (pinned !== null && usedName !== null && !pinnedListed) {
      selectionWhy = `${lead}"${pinned}" was chosen by hand but is no longer on this computer's list, so "${usedName}" was used.`;
    } else if (ranked && usedName !== null && selection.switched && firstTried && firstTried !== usedName) {
      selectionWhy = `${ranked.why} "${firstTried}" could not serve, so "${usedName}" was used.`;
    }
    const chosenFacts = {
      retry: recoveryTiming(attempts, exhaustionThresholds(registry), Date.parse(now()), { recheckAttempt }),
      keepTryingAccounts: keepTryingAccounts === true,
      selectionMode: chosenSelection,
      rankWindow: chosenWindow,
      selectionWhy,
      selectionPinned: pinned,
      /* Whether the choice was honoured, as a value rather than as prose a
         surface would have to parse. Null when nobody has chosen. */
      selectionPinnedServed: pinnedServed,
      selectionMeasured: ranked ? ranked.measuredCount : null,
      selectionUnmeasured: ranked ? ranked.unmeasuredCount : null
    };

    if (!selection.ok) {
      const first = selection.attempts && selection.attempts[0];
      return Object.freeze({
        ...notRotated(CODE.NONE_USABLE,
          'None of the listed accounts can run right now. Sign one of them in, or wait for an allowance to reset, then start again.'),
        ...chosenFacts,
        blocked: true,
        attempts: selection.attempts || Object.freeze([]),
        nextStep: first
          ? `Check "${first.account}" first: ${first.reason}`
          : 'Check the accounts listed on this computer.'
      });
    }

    /* MANUAL MEANS MANUAL, AND THIS IS THE ONLY PLACE THAT DECIDES IT.
     *
     * The switcher has already worked out which account WOULD serve, which is
     * what makes the message below able to name both the spent account and the
     * one that is ready. Answering the question before refusing to act on it is
     * what turns "it stopped" into "it stopped, here is who is spent, here is who
     * is free, here is the one switch that fixes it". Nothing has been spent to
     * learn that: the free account surfaces cost no allowance. */
    if (selection.switched && !automatic) {
      const spent = selection.attempts[0];
      return Object.freeze({
        ...notRotated(CODE.EXHAUSTED_MANUAL,
          `"${spent.account}" has run out, and this computer is set to let you switch rather than switch for you.`),
        ...chosenFacts,
        blocked: true,
        attempts: selection.attempts,
        nextStep: `"${selection.account.name}" is ready. Switch to it on the accounts page, or turn on switching for me, then start again.`
      });
    }

    /* THE CHOICE IS PROVEN BEFORE IT IS RECORDED, NOT AFTER.
     *
     * resolveForLaunch records the choice itself unless it is told not to,
     * and this path let it -- so the account became this computer's active one,
     * and the head of the next start's order, at the moment it was CHOSEN. The
     * work that can still refuse it all happens after that point: selected()
     * below has to resolve the account's folder, and when it cannot it answers
     * `account: null` and "the usual sign-in is used". The session then ran as
     * nobody while the record named an account it had never used, and the next
     * start preferred that same account, and the one after that.
     *
     * That is the shape the owner described from the outside: agents moved onto
     * an account before anything checked it could take them, sessions ending on
     * their first turn, and the fleet staying pointed at the account that had
     * just failed.
     *
     * So the selection is resolved WITHOUT being persisted, the answer is built,
     * and only an answer that actually carries an account and a folder is
     * committed. A refusal now leaves the previously active account exactly
     * where it was, which is the account that was last known to work.
     *
     * WHAT THIS STILL DOES NOT PROVE: that a turn succeeds. Only running one
     * proves that, and running one to find out spends the allowance this whole
     * feature exists to conserve. This moves the record from "chosen" to
     * "chosen and bindable", which is as far as free evidence reaches. */
    const answer = selected(selection.account, {
      code: candidates.length === 1 ? CODE.SELECTED_SOLE : CODE.SELECTED, spec, homeDir,
      switched: Boolean(selection.switched),
      attempts: selection.attempts || [],
      reason: selection.reason
    });
    if (!answer.rotated) return Object.freeze({ ...answer, ...chosenFacts });

    try {
      signal?.throwIfAborted();
      /* The choice travels with the commit so that a record which only carried
         it in its history now carries it in the field, where the twenty-entry
         history rolling over cannot drop it. */
      if (persistSelection !== false) {
        commitLaunchSelection({ selection, statePath: record, manualPin: recordedPin, fsImpl, now, signal });
      }
    } catch (error) {
      signal?.throwIfAborted();
      /* The same answer this function has always given when the record could
         not be written: the commit used to happen inside the try above, and a
         conflicting write from another program's start landed here. It is left
         unchanged rather than improved, because "somebody else chose while we
         were probing" is a different question from the one this change is
         about, and answering both at once would make neither reviewable. */
      return Object.freeze({
        ...notRotated(CODE.UNREADABLE,
          'The account list could not be checked just now, so the usual sign-in is used.',
          { detail: (error && error.code) || null }),
        ...chosenFacts
      });
    }

    return Object.freeze({ ...answer, ...chosenFacts });
  };
  return chosenSelection === MODE.ROTATE
    ? withRotationTurn(record, spec.id, fsImpl, signal, chooseAndRecord)
    : chooseAndRecord();
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
 * different account have disagreed about the same question, and the person has
 * no way to tell which one was wrong. So this runs the SAME probe factories and
 * the SAME ordering that resolveAccountForSession() runs, and returns their
 * answers rather than a second reading taken its own way. The only thing it
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
        orders: Object.freeze([]), policy: null, reason: 'The requested account bindings are invalid.' });
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
      ok: false, code: CODE.UNREADABLE, accounts: Object.freeze([]), orders: Object.freeze([]),
      policy: null,
      reason: 'The account list location could not be worked out on this computer.',
      detail: (error && error.code) || null
    });
  }
  const { registry, code } = registryRead;
  if (!registry) {
    return Object.freeze({
      ok: false, code, accounts: Object.freeze([]), orders: Object.freeze([]), policy: null,
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
    return Object.freeze({ ok: false, code: CODE.UNREADABLE, accounts: Object.freeze([]), orders: Object.freeze([]),
      policy: null, reason: 'A provider account leaves this isolated session.', detail: error.code || null });
  }

  const policy = Object.freeze({
    selectionMode: registry.selectionMode == null ? DEFAULT_SELECTION_MODE : registry.selectionMode,
    /* Said out loud so the panel can draw the difference between "nobody has
       chosen" and "somebody chose the cautious one". A dropdown that cannot
       tell those apart cannot show a person that their choice was recorded. */
    selectionModeRecorded: registry.selectionMode != null,
    reservePercent: normalizeReservePercent(registry.reservePercent),
    rankWindow: normalizeRankWindow(registry.rankWindow),
    ...exhaustionThresholds(registry),
    /* Each program's rule in force, own or inherited, so the menu can show a
       per-program control that reads what a start of that program obeys. */
    byProvider: Object.freeze(Object.fromEntries(PROVIDER_IDS.map(id => {
      const own = providerPolicyOf(registry, id);
      return [id, Object.freeze({
        selectionMode: own.selectionMode == null ? DEFAULT_SELECTION_MODE : own.selectionMode,
        reservePercent: normalizeReservePercent(own.reservePercent),
        rankWindow: normalizeRankWindow(own.rankWindow),
        own: own.own
      })];
    })))
  });

  const wanted = Array.isArray(providers) && providers.length > 0
    ? [...new Set(providers.filter(id => providerSpec(id)))]
    : PROVIDER_IDS;

  const rows = [];
  const orders = [];
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
          : defaultProbeFor(id, { homeDir, ...exhaustionThresholds(registry), fsImpl, usageProbe, timeoutMs });
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
            ? 'Gemini allowance was not measured for this connection. No percentage was estimated.' : null,
        reportedUsage: observed?.reportedUsage || null,
        allowanceBuckets: observed?.allowanceBuckets || null,
        ...(account.client ? { client: account.client, identityScope: 'current-user' } : {}),
        priority: account.priority,
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
  // A subset is a remeasurement, not a replacement ranking for its provider.
  for (const { id, candidates, readings } of bindingFilter ? [] : batches) {
    if (!candidates.length) continue;
    orders.push(Object.freeze({
        provider: id,
        ...orderAccounts({
          mode: policy.byProvider[id].selectionMode,
          accounts: candidates,
          readings,
          reservePercent: policy.byProvider[id].reservePercent,
          rankWindow: policy.byProvider[id].rankWindow,
          ...exhaustionThresholds(policy),
          now: Date.parse(now())
        })
    }));
  }

  return Object.freeze({
    ok: true,
    code: null,
    reason: null,
    /* WHEN THIS WAS READ, so a surface that keeps the answer can say how old
       it is rather than showing a number as if it were now. */
    readAt: now(),
    policy,
    accounts: Object.freeze(rows.sort((a, b) => a.provider.localeCompare(b.provider)
      || (a.priority - b.priority)
      || a.name.localeCompare(b.name))),
    /* One per provider, because selection is always made within a provider and
       a single merged order would imply a Claude session could fail over onto a
       Codex account. registry.js calls that a category error and it is right. */
    orders: Object.freeze(orders)
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
    return Object.freeze({
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
  /* An engine that carries this ALSO honours providerLimitsOnly and tags every
     exhausted reading with which limit refused. An older payload ignores the
     option silently, which is why the app's refusal says it could not tell
     which limit was reached rather than guessing the provider. */
  ACCOUNT_RESUME_PROVIDER_LIMIT_VERSION: 1,
  PROVIDER_CEILING_THRESHOLDS,
  resolveThresholds,
  ACCOUNT_RECOVERY_TIMING_VERSION: 1,
  recoveryTiming,
  ACCOUNT_CLIENT_CONTRACT_VERSION: 1,
  ACCOUNT_USAGE_CONCURRENCY,
  ACCOUNT_USAGE_BINDING_FILTER_VERSION,
  CLAUDE_CACHE_FRESHNESS_BUDGET_MS,
  CLAUDE_READING_REUSE_MS,
  CLAUDE_USAGE_PROBE_TIMEOUT_MS,
  CODE,
  DEFAULT_FAILOVER_MODE,
  FAILOVER_MODES,
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
  normalizeMode,
  readAccountUsage,
  readRegistryQuietly,
  resolveAccountForSession,
  statePathFor
});
