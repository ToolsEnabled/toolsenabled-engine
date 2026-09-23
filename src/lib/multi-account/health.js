'use strict';
// Real account health, measured from the provider -- never inferred from a file.
//
// WHY THIS IS NOT A FILE CHECK. `codex login status` reads auth.json and
// reports "Logged in" whenever the file parses. Measured against two real
// signed-in Codex homes: BOTH held an id_token whose exp had already passed,
// and `login status` still answered "Logged in". A switcher that trusted it
// would route to an account that cannot serve a request.
//
// The inverse is equally wrong, and is the trap that makes "just check the
// expiry" fail too: one of those same accounts, whose id_token had expired the
// day before, served a live request anyway, because the CLI silently refreshed
// off its refresh_token. Reading the token expiry would have declared a
// perfectly good account dead and failed over for nothing.
//
// So health is read from the provider's own account surface over the Codex
// app-server JSON-RPC protocol:
//   account/read            -> { account: { type, email, planType } | null }
//   account/rateLimits/read -> { rateLimits: { primary: { usedPercent, resetsAt },
//                                              spendControlReached,
//                                              rateLimitReachedType, ... } }
// Both cost zero tokens, which is what makes it affordable to check before
// every launch instead of guessing.
//
// This module never reads, returns or logs a credential value. It reads an
// account's e-mail (identity, needed to prove we are on the intended account)
// and its usage percentage. Nothing else leaves it.
//
// TWO JUDGEMENTS LIVE HERE, AND THEY ARE NOT THE SAME KIND OF EVIDENCE.
// classifyProbe()/probeAccount() is the Codex one above: measured from the
// provider, with a percentage to compare. probeSignInPresence() below is the
// Gemini one: PRESENCE ONLY, because Gemini has no free surface to ask and
// writes no usage cache to read. It says "signed in" or "not signed in" and
// never a percentage, and every field that would carry one stays null so no
// surface can draw an unread allowance as 0%.

const { spawnHidden } = require('../proc/hidden-spawn');
const { probeLifecycleOf, withProbeLifecycle } = require('./probe-lifecycle');

const { MultiAccountError, PROVIDERS, profileProvisioned, providerSpec, resolveProfileDir } = require('./registry.js');
const { NO_WINDOWS, bindingWindow, codexWindows, spentWindow, windowLimits, windowRecord } = require('./usage-windows.js');
const { selectCodexRateLimits, decodeCodexWindow } = require('../usage/codex-rate-limits');

const DEFAULT_PROBE_TIMEOUT_MS = 20000;

function withClosedAccountProbes(reading, ...probes) {
  return probes.length > 0 && probes.every(probe => probeLifecycleOf(probe) === 'closed')
    ? withProbeLifecycle(reading, 'closed') : reading;
}

// The exhaustion states. `transient` is deliberately distinct from `exhausted`:
// failing over on a network blip would burn a second account for nothing, and
// spend an allowance nobody asked to spend.
const STATUS = Object.freeze({
  HEALTHY: 'healthy',
  EXHAUSTED: 'exhausted',
  SIGNED_OUT: 'signed_out',
  ACCOUNT_MISMATCH: 'account_mismatch',
  TRANSIENT: 'transient',
  NOT_PROVISIONED: 'not_provisioned'
});

// Only these may be failed over. `transient` may not: we do not know that the
// account is spent, and spending a second one on that guess is the costly
// mistake. `account_mismatch` may not either: the wrong identity is a
// configuration fault the owner must see, not something to route around.
const FAILOVER_STATUSES = Object.freeze(new Set([STATUS.EXHAUSTED, STATUS.SIGNED_OUT, STATUS.NOT_PROVISIONED]));

/* WHICH LIMIT SAID NO. `exhausted` is one word for two different facts, and a
 * person can only act on one of them:
 *
 *   'provider'   -- the provider itself refused, or reported the allowance
 *                   fully used. Nothing on this computer can change that; the
 *                   only answer is to wait or use another account.
 *   'configured' -- THIS COMPUTER's own cutoff, a number on the Accounts page,
 *                   classed the account spent while the provider would still
 *                   have served it.
 *
 * MEASURED, and this is why the field exists: an hourly cutoff of 25% classed
 * every Claude account past a quarter of its 5-hour window as exhausted, and a
 * saved conversation on an account with 84% of its WEEK left was refused four
 * times. The refusal said "the configured usage cutoff or its provider
 * allowance" because the code genuinely did not know which -- so the person was
 * told to wait for a reset that had already happened, for a limit they had set
 * themselves and could have moved in one click.
 *
 * A threshold of 100 is the provider's ceiling rather than a choice, so it
 * reads as 'provider': nobody configured "stop at completely spent". */
const EXHAUSTED_BY = Object.freeze({ PROVIDER: 'provider', CONFIGURED: 'configured' });

function exhaustedByLimit(limit) {
  return Number.isFinite(limit) && limit < 100 ? EXHAUSTED_BY.CONFIGURED : EXHAUSTED_BY.PROVIDER;
}

/* IS THIS THE ACCOUNT THE ENTRY SAYS IT IS? The one comparison, for every
 * provider whose probe reads an identity. It answers WHICH OF FOUR CASES this
 * is and nothing else; each leg writes its own sentence, because the sentence
 * is provider-shaped ("this Codex home", "this Claude sign-in") and belongs
 * next to the person reading it.
 *
 * WHY IT IS SHARED. The two legs were written months apart and drifted, and the
 * drift was not cosmetic. MEASURED 2026-09-03 on this tree, calling
 * classifyProbe with `expectEmail: 'work@example.test'` and an identity object
 * carrying no readable address:
 *
 *     email absent      -> account_mismatch
 *     email blank       -> account_mismatch
 *     email null        -> account_mismatch
 *     email non-string  -> account_mismatch
 *
 * all four with the sentence "This Codex home is signed in as a different
 * account than "work" expects." Nothing had been compared -- the probe never
 * learned which account it was -- so all four accused a person whose sign-in
 * may be perfectly right, and sent them to redo a sign-in that was never the
 * fault. `account_mismatch` is deliberately not in FAILOVER_STATUSES, so it
 * also pinned that account in a state nothing routes around. The Claude leg
 * (rotation.js's claudeIdentityFault) already answered this case TRANSIENT.
 *
 * FOUR ANSWERS, AND THE TWO EASY TO COLLAPSE ARE THE LAST TWO.
 *   'unchecked'  -- no expectEmail on the entry. Nothing was promised, so
 *                   nothing is checked and the probe's own reading stands.
 *                   Every registry written before the field existed is here.
 *   'match'      -- recorded and equal. Nothing to say.
 *   'unreadable' -- recorded, and the probe answered no address. "Could not
 *                   look" is not "not there": this is the answer that STOPS
 *                   without accusing anybody.
 *   'mismatch'   -- recorded and different. The only one that is a refusal.
 *
 * Compared trimmed and lower-cased on both sides: registry.js already stores
 * expectEmail that way, and the half of an address that matters here is not
 * case-sensitive. */
function identityVerdict(account, observedEmail) {
  const expected = account && typeof account.expectEmail === 'string'
    ? account.expectEmail.trim().toLowerCase() : '';
  if (!expected) return Object.freeze({ verdict: 'unchecked', expected: null, seen: null });
  const seen = typeof observedEmail === 'string' ? observedEmail.trim().toLowerCase() : '';
  if (!seen) return Object.freeze({ verdict: 'unreadable', expected, seen: null });
  return Object.freeze({ verdict: seen === expected ? 'match' : 'mismatch', expected, seen });
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Reading an auth fault out of the transport's error text is a narrow, reluctant
// exception to this module's rule of using structured fields. There IS no
// structured auth-state field: the app-server surfaces the upstream HTTP failure
// as a message and nothing else. So the match is kept tight, anchored on the
// status code and the provider's own wording, and anything unrecognised falls
// through to `transient` -- the state that refuses rather than the state that
// spends another account. Being wrong here costs a refusal, not an allowance.
//
// Exhaustion is deliberately NOT inferred from text: it has a structured field
// (`rateLimitReachedType`), which is checked below and always wins.
// A generic 403 only establishes that this request was forbidden. It does not
// establish revoked authentication, so it stays transient unless the provider
// also supplies one of the explicit authentication faults below.
const AUTH_FAULT_PATTERNS = Object.freeze([
  [/\btoken_invalidated\b/i, 'the stored token was invalidated'],
  [/authentication token has been invalidated/i, 'the stored token was invalidated'],
  [/\baccount authentication required\b/i, 'no account is signed in'],
  [/please try signing in again/i, 'the provider asked for a fresh sign-in'],
  [/\b401\b\s*unauthorized/i, 'the provider rejected the credential (401)']
]);

function authFaultFrom(message) {
  if (typeof message !== 'string' || message.length === 0) return null;
  for (const [pattern, description] of AUTH_FAULT_PATTERNS) {
    if (pattern.test(message)) return description;
  }
  return null;
}

// Pure. Every branch here is reachable from a real, captured provider response;
// see tests/multi-account-health.test.js, whose fixtures are transcripts of a
// live app-server.
function classifyProbe({
  account,
  accountRead = null,
  accountReadError = null,
  rateLimitsResult = null,
  rateLimitsError = null,
  transportError = null,
  exhaustedAtPercent,
  exhaustedAtPercentHourly = null,
  exhaustedAtPercentWeekly = null
} = {}) {
  /* `windows` RIDES ALONG WITH `usedPercent` RATHER THAN REPLACING IT.
     usedPercent is the SHORT window and every existing consumer -- the
     exhaustion threshold below, switcher.js's attempt trail, the cloud panel's
     account line -- means exactly that by it. `windows` is the pair
     (./usage-windows.js): the same short window plus the long one, which
     nothing in this file used to read at all. Both are stated so a caller that
     wants the ceiling an account will hit FIRST can have it without any
     consumer of usedPercent quietly changing meaning underneath it. It is on
     `base` so every branch answers the same keys; only the branch that got a
     real allowance reading fills it. */
  const base = { account: account && account.name ? account.name : null, email: null, usedPercent: null, resetsAt: null, planType: null, windows: NO_WINDOWS };

  // The transport itself failed: the CLI would not start, the pipe died, or we
  // timed out. That is not evidence about the ACCOUNT at all.
  if (transportError) {
    return Object.freeze({
      ...base,
      status: STATUS.TRANSIENT,
      canServe: false,
      reason: `Could not reach the Codex account surface (${transportError}). This says nothing about the account's allowance, so it is not treated as exhaustion.`
    });
  }

  const identity = plainObject(accountRead) ? accountRead.account : undefined;

  // Measured signed-out shape: { account: null, requiresOpenaiAuth: true }, and
  // rateLimits answers JSON-RPC -32600 "codex account authentication required".
  if (identity === null) {
    /* The sentence names the state and nothing else. The way in -- the Codex
       sign-in run with CODEX_HOME set to this directory -- is what the accounts
       menu's own Sign in button does, so a variable name here would only reach
       a person as a hover tooltip beside the button that already does it. */
    return Object.freeze({
      ...base,
      status: STATUS.SIGNED_OUT,
      canServe: false,
      reason: 'This Codex home is not signed in.'
    });
  }

  if (!plainObject(identity)) {
    // We could not read an identity and it was not an explicit null. Do not
    // guess which it was.
    if (accountReadError) {
      return Object.freeze({
        ...base,
        status: STATUS.TRANSIENT,
        canServe: false,
        reason: `The Codex account surface returned an unreadable identity (${accountReadError}).`
      });
    }
    return Object.freeze({
      ...base,
      status: STATUS.TRANSIENT,
      canServe: false,
      reason: 'The Codex account surface returned no identity.'
    });
  }

  const email = typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : null;
  const planType = typeof identity.planType === 'string' ? identity.planType : null;
  const withIdentity = { ...base, email, planType };

  // The identity gate, modelled on the gateway's Gemini /about check: an
  // account that is signed in as somebody else must not be used just because
  // it happens to work. Silently running as the wrong identity is the exact
  // failure that produced config/codex.json.
  //
  // THE COMPARISON IS identityVerdict()'s, SHARED WITH THE CLAUDE LEG. It used
  // to be `email !== account.expectEmail` written out here, which read an
  // unreadable address as a wrong one -- see identityVerdict's own header for
  // the four measured cases that produced a false accusation.
  const identityCheck = identityVerdict(account, email);
  /* THE PROBE COULD NOT LOOK, so nothing is claimed about who is signed in.
     TRANSIENT, which stops without accusing and without spending the next
     account -- the same answer this file gives every other reading it could
     not take, and the one the Claude leg already gave here. */
  if (identityCheck.verdict === 'unreadable') {
    return Object.freeze({
      ...withIdentity,
      status: STATUS.TRANSIENT,
      canServe: false,
      usedPercent: null,
      resetsAt: null,
      windows: NO_WINDOWS,
      reason: `"${account.name}" expects a particular account, but the Codex account surface did not say which account this home is signed in as, so the two could not be compared. That is not a claim that the wrong one is signed in.`
    });
  }
  if (identityCheck.verdict === 'mismatch') {
    return Object.freeze({
      ...withIdentity,
      status: STATUS.ACCOUNT_MISMATCH,
      canServe: false,
      usedPercent: null,
      resetsAt: null,
      /* Blanked with the two above, and for the same reason: an allowance read
         off the WRONG identity describes somebody else's subscription, and
         ranking accounts by it would order this list on a stranger's numbers. */
      windows: NO_WINDOWS,
      /* NO FILENAME IN THE REMEDY. This used to end "or correct expectEmail in
         config/accounts.json", which reaches a person on the cloud panel and
         asks them to edit a JSON field in a file they have never opened. Both
         remedies below are things they can actually do from the product.
         THE ADDRESS THAT IS ACTUALLY THERE IS NAMED, as the Claude leg names
         it: the address a person needs is the unexpected one, because that is
         the account they signed in by mistake and the thing they have to
         recognise. It is the owner's own address on the owner's own screen,
         and it is the identity being compared, never a credential. */
      reason: `This Codex home is signed in as ${identityCheck.seen}, which is not the account "${account.name}" expects. Sign that home in again as the account it expects, or remove this account and add it back.`
    });
  }

  const rateLimits = selectCodexRateLimits(rateLimitsResult);
  if (!rateLimits) {
    // `account/read` answers from the LOCAL auth file, so it reports an
    // identity even when the stored credential has been revoked server-side.
    // Measured on a real account: a home restored from a two-day-old backup
    // reported its e-mail happily, while the allowance call came back 401
    // "Your authentication token has been invalidated." The account itself is
    // deliberately not named anywhere in here -- an account address is an
    // identity, and this file ships.
    // That home is signed OUT in every sense that matters, and the difference
    // is load-bearing: signed_out is a failover state, transient is not, so
    // misfiling it would let one permanently dead account block failover to
    // the healthy accounts behind it.
    const authFault = authFaultFrom(rateLimitsError);
    if (authFault) {
      return Object.freeze({
        ...withIdentity,
        status: STATUS.SIGNED_OUT,
        canServe: false,
        // Same rule as the signed-out sentence above: the menu offers the
        // sign-in (CODEX_HOME set to this directory), so no variable is named.
        reason: `This Codex home's stored credential is no longer accepted (${authFault}). Sign in to it again.`
      });
    }
    // Genuinely undiagnosed: positive evidence of a session, no evidence of
    // exhaustion and no evidence of an auth fault. Stay transient, which is
    // the state that refuses rather than the state that spends another
    // account.
    return Object.freeze({
      ...withIdentity,
      status: STATUS.TRANSIENT,
      canServe: false,
      reason: `Signed in, but the allowance surface did not answer${rateLimitsError ? ` (${rateLimitsError})` : ''}. Not treated as exhaustion.`
    });
  }

  const primary = decodeCodexWindow(rateLimits.primary);
  const usedPercent = primary?.usedPercent ?? null;
  const resetsAt = primary?.resetsAt ?? null;
  const measured = { ...withIdentity, usedPercent, resetsAt, windows: codexWindows(rateLimits) };

  // The provider's own explicit exhaustion flags outrank any threshold we pick.
  if (typeof rateLimits.rateLimitReachedType === 'string' && rateLimits.rateLimitReachedType.length > 0) {
    return Object.freeze({
      ...measured,
      status: STATUS.EXHAUSTED,
      exhaustedBy: EXHAUSTED_BY.PROVIDER,
      canServe: false,
      /* NO RESET TIMESTAMP IN THE SENTENCE. See "THE RESET TIME IS A FIELD,
         NOT PROSE" below: `resetsAt` and `windows` carry it, and the accounts
         menu turns it into words. */
      reason: `The provider reports this account's rate limit reached (${rateLimits.rateLimitReachedType}).`
    });
  }
  if (rateLimits.spendControlReached === true) {
    return Object.freeze({
      ...measured,
      status: STATUS.EXHAUSTED,
      exhaustedBy: EXHAUSTED_BY.PROVIDER,
      canServe: false,
      reason: 'The provider reports this account has reached its spend control.'
    });
  }
  // A missing/malformed percentage cannot establish that this account is
  // below our (possibly stricter than the provider's) exhaustion threshold.
  // The explicit provider flags above remain sufficient positive evidence of
  // exhaustion, but their absence is not a substitute for this measurement.
  if (usedPercent === null) {
    return Object.freeze({
      ...measured,
      status: STATUS.TRANSIENT,
      canServe: false,
      reason: 'Signed in, but the allowance surface returned no valid usage percentage. Not treated as healthy or exhausted.'
    });
  }

  // Likewise, without a valid threshold there is no meaningful comparison to
  // make. In particular, comparisons against undefined/NaN quietly evaluate
  // false and used to collapse this configuration failure into HEALTHY.
  if (!Number.isFinite(exhaustedAtPercent) || exhaustedAtPercent < 0 || exhaustedAtPercent > 100) {
    return Object.freeze({
      ...measured,
      status: STATUS.TRANSIENT,
      canServe: false,
      reason: 'Signed in, but the configured exhaustion threshold is invalid. Not treated as healthy or exhausted.'
    });
  }

  /* EXHAUSTION IS JUDGED ON THE WORST MEASURED WINDOW, NOT THE SHORT ONE.
     `usedPercent` is still the short window and every consumer that reads it
     gets exactly what it always got. But an account is stopped by whichever
     ceiling it reaches first, and while this comparison read only `primary`,
     a Codex account whose WEEKLY window was fully spent and whose five-hour
     window was fresh classified as healthy -- and the usage-ranked modes,
     sorting on that answer, put it at the head of every start, where its
     first turn failed and nothing failed over because the switcher had been
     told it was fine. So the threshold is compared against the most
     constrained window that was read. When only the short one was read this
     is the same test it always was. */
  /* AND EACH WINDOW IS JUDGED AGAINST ITS OWN LIMIT (owner, 2026-09-03: "that
     should be a weekly and 5h and slider (seperate)").

     One number for both was always a compromise. A weekly allowance is spent
     over days and is worth moving away from early, while a five-hour window
     refills so fast that the same figure would park an account that is about
     to be fine again. Measured on the owner's own machine the day this was
     written: two accounts sat at 90% and 91% of the WEEK with 96% and 65% of
     the five-hour window still free, and a single 90% threshold stopped both
     of them on the strength of the slow window alone.

     When only the one number is configured both windows use it, and the
     answer is exactly what it was: the most constrained window decides. */
  const { hourlyLimit, weeklyLimit } = windowLimits({
    exhaustedAtPercent, exhaustedAtPercentHourly, exhaustedAtPercentWeekly
  });
  const overspent = spentWindow(measured.windows, { hourlyLimit, weeklyLimit })
    || (bindingWindow(measured.windows) ? null : (usedPercent >= hourlyLimit
      ? { kind: 'hourly', usedPercent, resetsAt, limit: hourlyLimit } : null));
  /* THE RESET TIME IS A FIELD, NOT PROSE.
   *
   * These sentences are printed under a row in the accounts menu, and each one
   * used to end "; resets <ISO>". MEASURED 2026-09-03 in the installed copy's
   * accounts-usage-cache.json (%APPDATA%/ToolsEnabled-Live), the healthy Codex
   * row read "Signed in at 52% of its allowance; resets
   * 2026-09-07T02:29:34.000Z." -- a machine value on a screen a person reads,
   * beside the row's own line saying the same instant in words. NOTHING IS
   * LOST: `resetsAt` on the record and `resetsAt` on each window in
   * `measured.windows` still carry the time, and the menu builds its own
   * clause from them (account-switcher-state.js resetPhrase). The percentage
   * and the threshold stay, because those are what the sentence is about.
   */
  if (overspent) {
    const weekly = overspent.kind === 'weekly';
    return Object.freeze({
      ...measured,
      status: STATUS.EXHAUSTED,
      exhaustedBy: exhaustedByLimit(overspent.limit),
      exhaustedLimit: Number.isFinite(overspent.limit) ? overspent.limit : null,
      exhaustedWindow: weekly ? 'weekly' : 'hourly',
      canServe: false,
      reason: `This account is at ${overspent.usedPercent}% of its ${weekly ? 'weekly' : '5-hour'} allowance (threshold ${overspent.limit}%).`
    });
  }

  return Object.freeze({
    ...measured,
    status: STATUS.HEALTHY,
    canServe: true,
    reason: `Signed in at ${usedPercent}% of its allowance.`
  });
}

// The account surface uses the same bounded, owned process runner as the
// other provider reads. No result is released until its tree and pipes close.
async function appServerRequest({
  command,
  prefixArgs = [],
  env,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  spawnImpl = spawnHidden,
  signal = null
} = {}) {
  const replies = new Map();
  let invocation, childEnvironment, observed = null;
  const response = transportError => withClosedAccountProbes({
    transportError,
    accountRead: replies.has(2) ? replies.get(2).result ?? null : null,
    accountReadError: replies.has(2) ? replies.get(2).errorMessage : 'no reply',
    rateLimitsResult: replies.has(3) ? replies.get(3).result ?? null : null,
    rateLimitsError: replies.has(3) ? replies.get(3).errorMessage : 'no reply'
  }, observed);
  if (signal?.aborted) return response('ABORT_ERR');
  try {
    const isolation = require('../provider-session-isolation');
    const privateEnvironment = isolation.providerSessionEnvironment(env, { provider: 'codex', requireHome: true });
    const privateExecutable = isolation.resolvePrivateProviderExecutable('codex', privateEnvironment);
    const launchedCommand = privateExecutable ? privateExecutable.command : command;
    const launchedArgs = [...(privateExecutable ? privateExecutable.prefixArgs : prefixArgs),
      ...isolation.codexFileCredentialArgs(['app-server'], privateEnvironment)];
    invocation = privateExecutable
      ? require('../proc/hidden-spawn').resolveHiddenInvocation(launchedCommand, launchedArgs, privateEnvironment)
      : { command: launchedCommand, args: launchedArgs, env: {} };
    childEnvironment = { ...privateEnvironment, ...(privateExecutable?.env || {}), ...invocation.env };
    if (privateExecutable && invocation.command !== process.execPath) delete childEnvironment.ELECTRON_RUN_AS_NODE;
  } catch (error) { return response(error.code || error.message || 'spawn failed'); }

  observed = await runOwnedProbe({
    command: invocation.command, args: invocation.args, env: childEnvironment, spawnImpl, signal,
    timeoutMs, maxTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS, timeoutCode: 'CODEX_ACCOUNT_TIMEOUT',
    outputLimitCode: 'CODEX_ACCOUNT_OUTPUT_LIMIT', captureOutput: false,
    onStart: ({ write }) => write({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'toolsenabled-account-switch', title: 'ToolsEnabled account switch', version: '1.0.0' } } }),
    onLine(line, { write, finish }) {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!plainObject(message) || ![1, 2, 3].includes(message.id) || replies.has(message.id)) return;
      replies.set(message.id, {
        result: plainObject(message.result) ? message.result : null,
        errorMessage: plainObject(message.error) && typeof message.error.message === 'string' ? message.error.message : null
      });
      if (message.id === 1) {
        write({ jsonrpc: '2.0', id: 2, method: 'account/read', params: {} });
        write({ jsonrpc: '2.0', id: 3, method: 'account/rateLimits/read', params: {} });
      }
      if (replies.has(2) && replies.has(3)) finish({});
    }
  });
  if (observed.error?.code === 'CODEX_ACCOUNT_TIMEOUT') return response(`timed out after ${timeoutMs}ms`);
  if (observed.error) return response(observed.error.code || observed.error.message || 'spawn failed');
  return response(replies.has(2) && replies.has(3) ? null : 'the account surface exited before answering');
}

// Probe one account. `environmentFor` is injected from launch.js so the probe
// runs under exactly the same scrubbed, pinned environment a real launch would
// use. Probing under a different environment than we launch under would make
// the probe's answer inapplicable to the launch.
async function probeAccount(account, {
  homeDir,
  environmentFor,
  executable,
  exhaustedAtPercent,
  exhaustedAtPercentHourly = null,
  exhaustedAtPercentWeekly = null,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  spawnImpl = spawnHidden,
  signal = null,
  fsImpl
} = {}) {
  /* THE CODEX SURFACE ANSWERS ONLY FOR CODEX ACCOUNTS, AND SAYS SO.
     status-injection.js hands every registry entry to this probe. While the
     launcher checked auth.json for everything, a Claude entry failed that check
     and was refused by accident. The launcher now pins the right home for any
     provider, so a non-Codex entry would otherwise reach `codex app-server`
     with CODEX_HOME scrubbed and be measured as whatever ~/.codex holds -- the
     wrong identity, silently, which is the one failure this module exists to
     prevent. So the refusal is made on purpose, in the shape it always had. */
  const spec = providerSpec(account && account.provider) || PROVIDERS.codex;
  if (spec.id !== PROVIDERS.codex.id) {
    return Object.freeze({
      account: account.name,
      email: null,
      usedPercent: null,
      resetsAt: null,
      planType: null,
      windows: NO_WINDOWS,
      status: STATUS.NOT_PROVISIONED,
      canServe: false,
      reason: `"${account.name}" is a ${spec.id} account. The Codex account surface cannot check it, so it was skipped here.`
    });
  }

  let env;
  try {
    env = environmentFor(account, { homeDir, fsImpl });
  } catch (error) {
    if (error instanceof MultiAccountError && error.code === 'ACCOUNT_PROFILE_UNAVAILABLE') {
      return Object.freeze({
        account: account.name,
        email: null,
        usedPercent: null,
        resetsAt: null,
        planType: null,
        windows: NO_WINDOWS,
        status: STATUS.NOT_PROVISIONED,
        canServe: false,
        reason: `No signed-in Codex home at ${resolveProfileDirSafely(account, homeDir)}. Press Sign in beside it on the accounts menu, or sign in to that folder yourself.`
      });
    }
    throw error;
  }

  const observed = await appServerRequest({
    command: executable.command,
    prefixArgs: executable.prefixArgs || [],
    env,
    timeoutMs,
    spawnImpl,
    signal
  });

  return withClosedAccountProbes(classifyProbe({
    account, ...observed, exhaustedAtPercent, exhaustedAtPercentHourly, exhaustedAtPercentWeekly
  }), observed);
}

function resolveProfileDirSafely(account, homeDir) {
  try { return resolveProfileDir(account, { homeDir }); } catch { return account.profileDir; }
}

// The provider's name as a person reads it, for the sentences below.
const PROVIDER_WORD = Object.freeze({ codex: 'Codex', claude: 'Claude', gemini: 'Gemini', grok: 'Grok' });

/* PRESENCE, AND ONLY PRESENCE, FOR A PROVIDER WITH NO FREE ALLOWANCE SURFACE.
 *
 * Gemini has no zero-cost account surface this module can ask and its CLI
 * writes no usage cache to read. What CAN be known without spending anything
 * is whether the home has ever been signed in: the presence of the file the
 * provider table names. The header above explains why that is not enough for
 * Codex, and it is not enough here either -- so the answer is honest about
 * its limits. A present sign-in is `healthy` with canServe true and NO
 * windows, so a surface says "not measured" and never draws 0%; an absent one
 * is `signed_out`, which failover may move past; a check that could not be
 * made is `transient`, which stops the cascade rather than guessing.
 *
 * NOTHING IS OPENED. profileProvisioned() is registry.js's own statSync
 * presence check, the one every provisioning question in this lane already
 * asks, and this function never throws: a fault in an optional check must not
 * be the reason somebody cannot start. */
async function probeSignInPresence(account, { homeDir, fsImpl } = {}) {
  const name = account && account.name ? account.name : null;
  const spec = providerSpec(account && account.provider) || PROVIDERS.codex;
  const word = PROVIDER_WORD[spec.id] || spec.id;
  const base = { account: name, email: null, usedPercent: null, resetsAt: null, planType: null, windows: NO_WINDOWS };

  let present;
  try {
    present = profileProvisioned(account, { homeDir, fsImpl });
  } catch (error) {
    if (error instanceof MultiAccountError && error.code === 'ACCOUNT_PROVISIONING_UNKNOWN') {
      return Object.freeze({
        ...base,
        status: STATUS.TRANSIENT,
        canServe: false,
        reason: `Could not tell whether "${name}" is signed in (${error.details.cause || 'unknown error'}). Not treated as signed out.`
      });
    }
    return Object.freeze({
      ...base,
      status: STATUS.NOT_PROVISIONED,
      canServe: false,
      reason: `The folder for "${name}" could not be worked out, so it was skipped.`
    });
  }

  if (!present) {
    /* The state, and only the state. The way in is the program's own sign-in
       run with spec.homeEnv (CODEX_HOME, CLAUDE_CONFIG_DIR or GEMINI_CLI_HOME)
       set to this directory, which is what the accounts menu's Sign in button
       does, so a variable name here would only reach a person as a hover
       tooltip beside the button that already does it. */
    return Object.freeze({
      ...base,
      status: STATUS.SIGNED_OUT,
      canServe: false,
      reason: `This ${word} home is not signed in.`
    });
  }
  // A file's presence cannot establish an explicitly pinned account identity.
  // Grok's first turn remains the service check; no Codex probe can validate it.
  if (spec.id === 'grok' && account.expectEmail) {
    return Object.freeze({ ...base, status: STATUS.TRANSIENT, canServe: false,
      reason: `Sign-in data is present, but the expected Grok account could not be confirmed. It is not being started.` });
  }
  return Object.freeze({
    ...base,
    status: STATUS.HEALTHY,
    canServe: true,
    reason: spec.id === 'grok'
      ? 'Grok sign-in data is present. Allowance is not measured; the first turn checks whether it can serve.'
      : `Sign-in data is present. Allowance and authenticated identity require a separate current check for this ${word} connection.`
  });
}

function classifyAntigravityCatalog(account, { stdout = '', stderr = '', code = null, error = null } = {}) {
  const base = { account: account?.name || null, email: null, usedPercent: null, resetsAt: null,
    identityScope: 'current-user', planType: null, windows: NO_WINDOWS };
  if (account?.expectEmail) return Object.freeze({ ...base, status: STATUS.TRANSIENT, canServe: false,
    reason: 'Antigravity does not report the signed-in address here, so the expected account could not be confirmed.' });
  const models = typeof stdout === 'string' && stdout.length <= 131072
    ? stdout.split(/\r?\n/).map(line => /^([A-Za-z0-9][A-Za-z0-9._-]{0,199})\t([^\t\r\n]+)$/.exec(line))
      .filter(match => match && match[2].trim()).map(match => match[1]).filter(id => id.startsWith('gemini-')) : [];
  if (!error && code === 0 && models.length > 0) return Object.freeze({ ...base,
    status: STATUS.HEALTHY, canServe: true, models: Object.freeze([...new Set(models)]),
    reason: 'Antigravity models are available through this computer’s current sign-in. The folder does not provide a separate account. Identity and allowance are unmeasured; the first turn checks whether it can serve.' });
  if (error?.code === 'ENOENT') return Object.freeze({ ...base, status: STATUS.NOT_PROVISIONED, canServe: false,
    reason: 'The official Antigravity client is not available on this computer.' });
  if (/please sign in to view available models|launch the cli without arguments to sign in/i.test(stderr)) {
    return Object.freeze({ ...base, status: STATUS.SIGNED_OUT, canServe: false,
      reason: 'Sign in through the official Antigravity client for this account.' });
  }
  return Object.freeze({ ...base, status: STATUS.TRANSIENT, canServe: false,
    reason: 'Antigravity could not confirm this account right now. Its allowance remains unknown.' });
}

/* ONE OWNED, BOUNDED PROGRAM RUN FOR THE PROVIDER READS BELOW.
 *
 * The Antigravity catalogue read already ran its official client this way:
 * contained process tree, bounded output, a deadline, Stop honoured, and the
 * tree's closure confirmed before any answer is returned. The allowance reads
 * added beside it (Antigravity's print-mode /quota and Grok's billing request)
 * run under the same custody rather than a second copy of it. `onLine` sees
 * each stdout line and may write a JSON-RPC reply or finish early; a program
 * that stays alive after answering (Grok's ACP agent) is ended by the
 * confirmation, exactly as a timed-out catalogue read always was. */
async function runOwnedProbe({ command, args, cwd, env, signal = null, timeoutMs = 15000, spawnImpl,
  maxTimeoutMs = 15000, timeoutCode = 'AGY_ACCOUNT_TIMEOUT', outputLimitCode = 'AGY_ACCOUNT_OUTPUT_LIMIT',
  captureOutput = true, closeStdin = false, onStart = null, onLine = null, onClose = null }) {
  let child;
  let cleanup;
  let removeAbort = () => {};
  let timer;
  let result;
  let receipt = null;
  if (signal?.aborted) return { error: { code: 'ABORT_ERR' } };
  try {
    // Every provider opts into the existing native ownership adapters.
    child = spawnImpl(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, containProcessTree: true });
    cleanup = require('../agent-engine/codex-startup-cleanup').createStartupCleanup(child);
    result = await new Promise(resolve => {
      let stdout = '', stderr = '', pending = '', settled = false, outputBytes = 0;
      const finish = details => { if (settled) return; settled = true; resolve({ stdout, stderr, ...details }); };
      const write = payload => {
        if (settled) return;
        try { child.stdin.write(`${JSON.stringify(payload)}\n`); } catch (error) { finish({ error }); }
      };
      const end = () => { try { child.stdin.end(); } catch (error) { finish({ error }); } };
      const append = (kind, chunk) => {
        if (settled) return;
        outputBytes += Buffer.byteLength(chunk, 'utf8');
        if (outputBytes > 131072) { finish({ error: { code: outputLimitCode } }); return; }
        if (captureOutput) { if (kind === 'stdout') stdout += chunk; else stderr += chunk; }
        if (kind !== 'stdout' || !onLine) return;
        pending += chunk;
        let index;
        while (!settled && (index = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, index).trim();
          pending = pending.slice(index + 1);
          if (line) { try { onLine(line, { write, finish }); } catch (error) { finish({ error }); } }
        }
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => append('stdout', chunk));
      child.stderr.on('data', chunk => append('stderr', chunk));
      child.stdout.on('error', error => finish({ error }));
      child.stderr.on('error', error => finish({ error }));
      child.once('error', error => finish({ error }));
      child.stdin?.on('error', error => finish({ error }));
      child.once('close', code => {
        if (onClose) { try { onClose({ code, pending, finish }); } catch (error) { finish({ error }); } }
        finish({ code });
      });
      const abort = () => finish({ error: { code: 'ABORT_ERR' } });
      signal?.addEventListener('abort', abort, { once: true });
      removeAbort = () => signal?.removeEventListener('abort', abort);
      if (signal?.aborted) abort();
      timer = setTimeout(() => finish({ error: { code: timeoutCode } }),
        Number.isFinite(timeoutMs) ? Math.max(1, Math.min(maxTimeoutMs, timeoutMs)) : maxTimeoutMs);
      if (closeStdin) { try { child.stdin.end(); } catch { /* exit/error settles */ } }
      if (!settled && onStart) onStart({ write, finish, end });
    });
  } catch (error) { result = { error }; }
  finally {
    clearTimeout(timer); removeAbort();
    if (cleanup) receipt = await cleanup.confirmClosed(5000);
  }
  return receipt && ['exit', 'terminated'].includes(receipt.type)
    && !signal?.aborted && result?.error?.code !== 'ABORT_ERR' ? withProbeLifecycle(result, 'closed') : result;
}

/* ANTIGRAVITY'S OWN ALLOWANCE, READ WITHOUT SPENDING ANY OF IT.
 *
 * The official client answers its read-only slash commands in print mode:
 * agy 1.2.0's own changelog says `-p "/usage"`, `/quota` ... "emit ... a
 * structured payload under `--output-format json` ... without starting an
 * agent turn, spending quota, or leaving a conversation behind". MEASURED
 * 2026-09-10 on this computer's current Antigravity sign-in (evidence
 * claude-finish-20260910/usage/evidence/agy-quota-json.stdout): status
 * SUCCESS, num_turns 0, total_tokens 0, and `command.data.groups` held
 *   "Gemini Models"         bucket gemini-weekly, window weekly, remaining_fraction 0.962
 *   "Claude and GPT models" bucket 3p-weekly,     window weekly, remaining_fraction 1
 * each with its own reset_time. "Within each group, models share a weekly
 * limit" (the payload's own description).
 *
 * WHICH BUCKET DECIDES. This account runs Gemini models only, so the Gemini
 * group's weekly bucket fills the `weekly` slot that every ranking and
 * exhaustion test reads. Every weekly bucket the client reported is carried
 * in `weeklyWindows`, in the client's order and named for its group, so the
 * menu can show the other group too without it ever deciding a start. A
 * bucket with no finite 0..1 fraction is not a reading and is dropped, never
 * drawn as 0% or 100%. */
const AGY_QUOTA_ARGS = Object.freeze(['-p', '/quota', '--output-format', 'json']);
const MAX_QUOTA_GROUPS = 8;
const MAX_QUOTA_BUCKETS = 8;

function antigravityQuotaData(stdout) {
  let payload = null;
  try { payload = typeof stdout === 'string' && stdout.length <= 131072 ? JSON.parse(stdout) : null; } catch { payload = null; }
  const command = plainObject(payload) && payload.status === 'SUCCESS' && plainObject(payload.command) ? payload.command : null;
  const data = command && command.name === 'usage' && plainObject(command.data) ? command.data : null;
  return data && Array.isArray(data.groups) ? data : null;
}

function antigravityQuotaWindows(stdout) {
  const data = antigravityQuotaData(stdout);
  if (!data) return null;
  const every = [];
  let gemini = null;
  for (const group of data.groups.slice(0, MAX_QUOTA_GROUPS)) {
    if (!plainObject(group) || typeof group.name !== 'string' || !Array.isArray(group.buckets)) continue;
    const groupName = group.name.trim().slice(0, 60);
    for (const bucket of group.buckets.slice(0, MAX_QUOTA_BUCKETS)) {
      if (!plainObject(bucket) || bucket.window !== 'weekly') continue;
      const fraction = bucket.remaining_fraction;
      if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const resetMs = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : Number.NaN;
      const id = typeof bucket.id === 'string' && /^[A-Za-z0-9._-]{1,60}$/.test(bucket.id) ? bucket.id : null;
      const record = windowRecord({
        kind: 'weekly',
        percent: Math.round((1 - fraction) * 1000) / 10,
        resetsAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
        label: id,
        model: groupName || null
      });
      if (!record) continue;
      every.push(record);
      const isGemini = /^gemini\b/i.test(groupName) || (id !== null && /^gemini-/i.test(id));
      if (isGemini && (!gemini || record.usedPercent > gemini.usedPercent)) gemini = record;
    }
  }
  if (every.length === 0) return null;
  return Object.freeze({ hourly: null, weekly: gemini, weeklyWindows: Object.freeze(every) });
}

/* The catalogue said HEALTHY; this adds what the allowance read said. A read
   that failed or answered nothing usable leaves the catalogue's verdict
   standing and says the allowance is unknown -- never zero, never spent. Only
   a Gemini bucket the client itself reported at or past its limit stops the
   account, and its reset time rides on the window and the row. */
function classifyAntigravityQuota(catalog, { stdout = '', code = null, error = null } = {}, thresholds = {}) {
  const windows = !error && code === 0 ? antigravityQuotaWindows(stdout) : null;
  const shared = 'Antigravity models are available through this computer’s current sign-in. The folder does not provide a separate account.';
  if (!windows || !windows.weekly) {
    const answered = !error && code === 0 && Boolean(antigravityQuotaData(stdout));
    return Object.freeze({ ...catalog, ...(windows ? { windows } : {}),
      usageStatus: answered ? 'not_reported' : 'unavailable', usageSource: 'antigravity-quota',
      usageCode: answered ? 'ANTIGRAVITY_USAGE_NOT_REPORTED' : 'ANTIGRAVITY_USAGE_UNAVAILABLE',
      usageReason: answered ? 'Antigravity did not report a Gemini allowance percentage.'
        : 'Antigravity could not check this allowance just now. Try Check allowances again.',
      reason: `${shared} ${windows ? 'Antigravity reported no Gemini allowance bucket' : 'Its allowance could not be read just now'}, so it is unknown rather than zero; the first turn checks whether it can serve.` });
  }
  const gemini = windows.weekly;
  const measured = { ...catalog, usedPercent: gemini.usedPercent, resetsAt: gemini.resetsAt, windows,
    usageStatus: 'measured', usageSource: 'antigravity-quota', usageCode: null, usageReason: null };
  const { hourlyLimit, weeklyLimit } = windowLimits(thresholds);
  const over = spentWindow(windows, { hourlyLimit, weeklyLimit })
    || (gemini.usedPercent >= 100 ? { ...gemini, limit: 100 } : null);
  if (over) {
    return Object.freeze({ ...measured, status: STATUS.EXHAUSTED,
      exhaustedBy: exhaustedByLimit(over.limit),
      exhaustedLimit: Number.isFinite(over.limit) ? over.limit : null,
      exhaustedWindow: 'weekly', canServe: false,
      reason: `Antigravity reports ${over.usedPercent}% of this week’s Gemini allowance used for this computer’s sign-in (threshold ${over.limit}%).` });
  }
  return Object.freeze({ ...measured,
    reason: `${shared} Antigravity reports ${gemini.usedPercent}% of this week’s Gemini allowance used.` });
}

async function probeAntigravityAccount(account, { homeDir, command = 'agy', signal = null,
  timeoutMs = 15000, spawnImpl = require('../proc/hidden-spawn').spawnHidden,
  exhaustedAtPercent = null, exhaustedAtPercentHourly = null, exhaustedAtPercentWeekly = null } = {}) {
  if (account?.provider !== 'gemini' || account?.client !== 'antigravity' || account.expectEmail) {
    return classifyAntigravityCatalog(account);
  }
  signal?.throwIfAborted();
  const accountHome = resolveProfileDir(account, { homeDir });
  const isolation = require('../provider-session-isolation');
  isolation.assertIsolatedPath(accountHome, isolation.isolationContext(), { field: 'Antigravity account home' });
  const path = require('node:path');
  const ambient = {};
  // No provider tokens, alternate client homes, injection flags or billing keys
  // are inherited. The official program accesses only its selected native home.
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (typeof process.env[key] === 'string') ambient[key] = process.env[key];
  }
  const env = { ...ambient, HOME: accountHome, USERPROFILE: accountHome,
    XDG_CONFIG_HOME: path.join(accountHome, '.config'), XDG_CACHE_HOME: path.join(accountHome, '.cache'),
    XDG_DATA_HOME: path.join(accountHome, '.local', 'share'), AGY_CLI_DISABLE_AUTO_UPDATE: '1' };
  const run = args => runOwnedProbe({ command, args, cwd: accountHome, env, signal, timeoutMs, spawnImpl,
    closeStdin: args !== ANTIGRAVITY_CATALOG_ARGS });
  const catalogRun = await run(ANTIGRAVITY_CATALOG_ARGS);
  const catalog = classifyAntigravityCatalog(account, catalogRun);
  signal?.throwIfAborted();
  if (catalog.status !== STATUS.HEALTHY) return withClosedAccountProbes(catalog, catalogRun);
  const quota = await run(AGY_QUOTA_ARGS);
  signal?.throwIfAborted();
  return withClosedAccountProbes(classifyAntigravityQuota(catalog, quota, { exhaustedAtPercent, exhaustedAtPercentHourly, exhaustedAtPercentWeekly }), catalogRun, quota);
}
const ANTIGRAVITY_CATALOG_ARGS = Object.freeze(['models']);

/* GROK'S OWN ALLOWANCE SURFACE: THE BILLING READ BEHIND ITS /usage MODAL.
 *
 * The Grok CLI has no usage subcommand for the account (`grok usage` is one
 * local session's token ledger). Its TUI's /usage modal reads the account's
 * "Usage limit" through the ACP agent's `_x.ai/billing` extension (the agent
 * advertises `x.ai/*` extensions and sends `_x.ai/...` notifications; the
 * handler fetches `/billing?format=credits`). MEASURED 2026-09-10 against
 * Grok CLI 1.0.25 on this computer (evidence
 * claude-finish-20260910/usage/evidence/grok-billing-probe-result-underscore.json):
 * initialize, the advertised headless `cached_token` authenticate, then
 * `_x.ai/billing` answered
 *   { config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start, end },
 *               onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 },
 *               isUnifiedBillingUser: true, billingPeriodStart, billingPeriodEnd },
 *     subscription_tier: 'X Premium+' }
 * and the authenticate reply named the signed-in address. No session/new and
 * no prompt are ever sent, so no model turn runs and no allowance is spent.
 *
 * WHAT IS NOT THERE IS NOT INVENTED. The client's billing struct also carries
 * an optional `creditUsagePercent` (the figure its "Weekly limit" row shows);
 * this account's reply did not include it. When it is present, finite and
 * within 0..100 on a WEEKLY period, it is this week's window; otherwise the
 * row states the plan and the period's end and says the percentage was not
 * reported -- it is never drawn as 0% and never counted as spent.
 *
 * THE SAME PRE-CHECK A START MAKES. acp-process.js refuses a Grok start while
 * `grok inspect --json` shows hooks, plugins, MCP or LSP servers outside
 * Research; the billing read starts the same agent program, so it is only
 * made under the same clean inspection, in the same environment
 * (launch.js launchEnvironment, the one a start uses) with the same features
 * off. Anything else leaves the presence verdict exactly as it was. */
const GROK_READ_ENV = Object.freeze({ GROK_SANDBOX: 'off', GROK_SUBAGENTS: '0', GROK_MEMORY: '0',
  GROK_CAMPAIGNS: '0', GROK_MCP_AUTO_RESTART: '0', GROK_MCP_RECURSIVE_CONFIG_WATCH: '0',
  GROK_CURSOR_MCPS_ENABLED: '0', GROK_CURSOR_HOOKS_ENABLED: '0',
  GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CLAUDE_HOOKS_ENABLED: '0' });
const GROK_PERIODS = Object.freeze({ USAGE_PERIOD_TYPE_WEEKLY: 'week', USAGE_PERIOD_TYPE_MONTHLY: 'month' });

function boundedWord(value, max = 40) {
  return typeof value === 'string' && value.trim() && value.trim().length <= max && !/[\u0000-\u001f]/.test(value)
    ? value.trim() : null;
}

/** Pure: what one `_x.ai/billing` answer says, with every unread field null. */
function grokBillingReading(billing) {
  const none = Object.freeze({ planType: null, period: null, resetsAt: null, percent: null, windows: NO_WINDOWS });
  if (!plainObject(billing)) return none;
  const config = plainObject(billing.config) ? billing.config : null;
  const current = config && plainObject(config.currentPeriod) ? config.currentPeriod : null;
  const period = current && typeof current.type === 'string' && Object.hasOwn(GROK_PERIODS, current.type)
    ? GROK_PERIODS[current.type] : null;
  const endRaw = current && typeof current.end === 'string' ? current.end
    : (config && typeof config.billingPeriodEnd === 'string' ? config.billingPeriodEnd : null);
  const endMs = endRaw ? Date.parse(endRaw) : Number.NaN;
  const resetsAt = Number.isFinite(endMs) ? new Date(endMs).toISOString() : null;
  const raw = config ? config.creditUsagePercent : undefined;
  const percent = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : null;
  const record = percent !== null && period === 'week'
    ? windowRecord({ kind: 'weekly', percent, resetsAt, label: 'creditUsagePercent' }) : null;
  return Object.freeze({
    planType: boundedWord(billing.subscription_tier),
    period,
    resetsAt,
    percent,
    windows: record ? Object.freeze({ hourly: null, weekly: record, weeklyWindows: Object.freeze([record]) }) : NO_WINDOWS
  });
}

/* Pure. `presence` is probeSignInPresence()'s verdict and it STANDS unless the
   provider itself said something stronger: a signed-in address that differs
   from the one the entry expects (a mismatch, as for Codex and Claude), the
   expected address confirmed (which settles the presence check's doubt), or a
   reported weekly percentage at or past its limit. A read that failed says so
   and changes nothing else. */
function classifyGrokBilling(account, presence, {
  authMeta = null, authError = null, billing = null, billingError = null, error = null, skipped = null
} = {}, thresholds = {}) {
  const seen = plainObject(authMeta) && typeof authMeta.email === 'string' ? authMeta.email.trim().toLowerCase() : '';
  const email = /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(seen) ? seen : null;
  const reading = grokBillingReading(billing);
  const planType = reading.planType || (plainObject(authMeta) ? boundedWord(authMeta.subscription_tier) : null);
  const base = { ...presence, email, planType, resetsAt: reading.resetsAt,
    usageStatus: 'not_reported', usageSource: 'grok-billing', usageCode: null, usageReason: null, reportedUsage: null };
  const identity = identityVerdict(account, email);
  if (identity.verdict === 'mismatch') {
    return Object.freeze({ ...base, status: STATUS.ACCOUNT_MISMATCH, canServe: false, usedPercent: null, resetsAt: null,
      windows: NO_WINDOWS,
      reason: `This Grok home is signed in as ${identity.seen}, which is not the account "${account.name}" expects. Sign that home in again as the account it expects, or remove this account and add it back.` });
  }
  const confirmed = identity.verdict === 'match' && presence.status === STATUS.TRANSIENT
    ? { status: STATUS.HEALTHY, canServe: true } : {};
  const standing = { ...base, ...confirmed };
  if (!plainObject(billing)) {
    const why = skipped === 'extensions' ? 'Grok has extra startup extensions, so its agent was not started just to ask'
      : skipped ? `Grok's configuration could not be inspected (${skipped})`
        : error ? `the read did not finish (${error.code === 'ENOENT' ? 'the Grok program was not found' : (error.code || 'error')})`
          : authError ? 'its stored sign-in was not accepted for the read'
            : billingError ? 'Grok did not answer the billing request' : 'Grok returned no billing answer';
    const unavailable = { ...standing, usageStatus: 'unavailable', usageCode: 'GROK_USAGE_UNAVAILABLE',
      usageReason: 'Grok could not check this allowance just now. Try Check allowances again.' };
    if (standing.status !== STATUS.HEALTHY) return Object.freeze(unavailable);
    return Object.freeze({ ...unavailable,
      reason: `Grok sign-in data is present, but its allowance could not be read just now (${why}), so it is unknown rather than zero. The first turn checks whether it can serve.` });
  }
  if (standing.status !== STATUS.HEALTHY) return Object.freeze(standing);
  // A reported monthly figure is displayable without turning it into the
  // weekly/5-hour windows that the existing selection policy ranks.
  const reportedUsage = reading.percent !== null && reading.period
    ? Object.freeze({ usedPercent: reading.percent, period: reading.period, resetsAt: reading.resetsAt }) : null;
  const supplied = { ...standing, reportedUsage, usageStatus: reportedUsage ? 'measured' : 'not_reported',
    usageCode: reportedUsage ? null : 'GROK_USAGE_NOT_REPORTED',
    usageReason: reportedUsage ? null : 'Grok did not report an allowance percentage for this account.' };
  const unit = reading.period || 'billing period';
  if (reading.windows.weekly) {
    const week = reading.windows.weekly;
    const measured = { ...supplied, usedPercent: week.usedPercent, windows: reading.windows };
    const { hourlyLimit, weeklyLimit } = windowLimits(thresholds);
    const over = spentWindow(reading.windows, { hourlyLimit, weeklyLimit })
      || (week.usedPercent >= 100 ? { ...week, limit: 100 } : null);
    if (over) {
      return Object.freeze({ ...measured, status: STATUS.EXHAUSTED,
        exhaustedBy: exhaustedByLimit(over.limit),
        exhaustedLimit: Number.isFinite(over.limit) ? over.limit : null,
        exhaustedWindow: 'weekly', canServe: false,
        reason: `Grok reports ${over.usedPercent}% of this week’s allowance used (threshold ${over.limit}%).` });
    }
    return Object.freeze({ ...measured, reason: `Signed in at ${week.usedPercent}% of this week’s Grok allowance.` });
  }
  if (reading.percent !== null && reading.percent >= 100) {
    return Object.freeze({ ...supplied, status: STATUS.EXHAUSTED,
      exhaustedBy: EXHAUSTED_BY.PROVIDER, canServe: false,
      reason: `Grok reports this ${unit}’s allowance fully used.` });
  }
  return Object.freeze({ ...supplied, windows: NO_WINDOWS, usedPercent: null,
    reason: reading.percent !== null
      ? `Grok reports ${reading.percent}% of this ${unit}’s allowance used.`
      : `Grok reports this ${unit}’s usage period but not how much of it is used, so usage is not measured. The first turn checks whether it can serve.` });
}

/* One JSON-RPC exchange: initialize, the headless cached sign-in the agent
   advertises, then the billing request. Agent-to-client requests are refused
   (this read answers nothing); notifications are ignored. The reply fields
   kept are the address and the plan from authenticate, and the billing
   answer -- never a credential.

   EVERY METHOD IS WRITTEN OUT AS A LITERAL. The accounts menu promises that
   Check allowances "spends none of your allowance and starts no work", and
   the app's product-account-surface test holds that promise to the methods
   this file can name, read as quoted method-name literals. A method named
   through a constant is invisible to that audit, which is exactly how a paid
   call could slip past it, so none is. */
function grokBillingExchange() {
  const state = { authMeta: null, authError: null, billing: null, billingError: null };
  const onStart = ({ write }) => write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: 1, clientCapabilities: {},
    clientInfo: { name: 'toolsenabled-account-usage', title: 'ToolsEnabled account usage', version: '1' } } });
  const onLine = (line, { write, finish }) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!plainObject(message)) return;
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not handled by the account usage read.' } });
      return;
    }
    const failed = Object.hasOwn(message, 'error');
    if (message.id === 1) {
      const methods = !failed && plainObject(message.result) && Array.isArray(message.result.authMethods) ? message.result.authMethods : [];
      if (!methods.some(method => plainObject(method) && method.id === 'cached_token')) {
        state.authError = 'cached sign-in not offered';
        finish({});
        return;
      }
      write({ jsonrpc: '2.0', id: 2, method: 'authenticate', params: { methodId: 'cached_token', _meta: { headless: true } } });
    } else if (message.id === 2) {
      if (failed) { state.authError = 'refused'; finish({}); return; }
      state.authMeta = plainObject(message.result) && plainObject(message.result._meta) ? message.result._meta : {};
      write({ jsonrpc: '2.0', id: 3, method: '_x.ai/billing', params: {} });
    } else if (message.id === 3) {
      if (failed || !plainObject(message.result)) state.billingError = 'refused';
      else state.billing = message.result;
      finish({});
    }
  };
  return { state, onStart, onLine };
}

async function probeGrokAccount(account, { homeDir, fsImpl, signal = null, command = 'grok', timeoutMs = 10000,
  spawnImpl = require('../proc/hidden-spawn').spawnHidden, environmentFor = null,
  exhaustedAtPercent = null, exhaustedAtPercentHourly = null, exhaustedAtPercentWeekly = null } = {}) {
  const presence = await probeSignInPresence(account, { homeDir, fsImpl });
  if (account?.provider !== 'grok') return presence;
  /* Only a present sign-in is worth asking about: HEALTHY, or the TRANSIENT
     the presence check gives a pinned address it cannot confirm. */
  const askable = presence.status === STATUS.HEALTHY
    || (presence.status === STATUS.TRANSIENT && Boolean(account.expectEmail) && presence.reason.startsWith('Sign-in data is present'));
  if (!askable) return presence;
  signal?.throwIfAborted();
  const thresholds = { exhaustedAtPercent, exhaustedAtPercentHourly, exhaustedAtPercentWeekly };
  let env;
  let cwd;
  try {
    env = { ...(environmentFor || require('./launch.js').launchEnvironment)(account, { homeDir, fsImpl }), ...GROK_READ_ENV };
    cwd = resolveProfileDir(account, { homeDir });
  } catch (error) {
    return classifyGrokBilling(account, presence, { skipped: (error && error.code) || 'environment' }, thresholds);
  }
  const inspection = await runOwnedProbe({ command, args: ['--no-auto-update', 'inspect', '--json'], cwd, env, signal,
    timeoutMs, spawnImpl, timeoutCode: 'GROK_ACCOUNT_TIMEOUT', closeStdin: true });
  signal?.throwIfAborted();
  if (inspection.error || inspection.code !== 0) {
    return withClosedAccountProbes(classifyGrokBilling(account, presence, { error: inspection.error || { code: `exit ${inspection.code}` } }, thresholds), inspection);
  }
  try { require('../agent-engine/acp-confinement').assertGrokInspection(inspection.stdout); }
  catch { return withClosedAccountProbes(classifyGrokBilling(account, presence, { skipped: 'extensions' }, thresholds), inspection); }
  const exchange = grokBillingExchange();
  const read = await runOwnedProbe({ command, args: ['--no-auto-update', 'agent', '--no-leader', 'stdio'], cwd, env, signal,
    timeoutMs, spawnImpl, timeoutCode: 'GROK_ACCOUNT_TIMEOUT', onStart: exchange.onStart, onLine: exchange.onLine });
  signal?.throwIfAborted();
  return withClosedAccountProbes(classifyGrokBilling(account, presence, { ...exchange.state, error: read.error || null }, thresholds), inspection, read);
}

async function probeGeminiAccount(account, options = {}) {
  const presence = await probeSignInPresence(account, options);
  if (account?.provider !== 'gemini' || account?.client || presence.status !== STATUS.HEALTHY) return presence;
  let home;
  try { home = resolveProfileDir(account, { homeDir: options.homeDir }); }
  catch { return presence; }
  const probe = options.quotaProbe || require('../providers/gemini-quota-probe').probeGeminiQuota;
  const result = await probe({ home, signal: options.signal, timeoutMs: options.timeoutMs,
    ...(options.baseEnvironment ? { baseEnvironment: options.baseEnvironment } : {}) });
  const observed = result?.status === 'observed';
  const buckets = observed ? result.allowanceBuckets : null;
  const { validEmail } = require('../providers/gemini-quota-protocol');
  const email = validEmail(result?.email) ? result.email : null;
  const mismatch = account.expectEmail && email && email.toLowerCase() !== account.expectEmail.toLowerCase();
  const identityMissing = Boolean(account.expectEmail && !email);
  // Verified identity and quota availability are independent. A known service
  // eligibility/project refusal still prevents serving, even with that identity.
  // Google no longer serves this account through Gemini CLI. That is known and
  // permanent, so it is not left as an unknown that stops Start on this account.
  const retired = !observed && result?.code === 'GEMINI_CLIENT_RETIRED';
  const serviceRefusal = !observed && ({
    GEMINI_CLIENT_RETIRED: require('../agent-engine/acp-adapter').GEMINI_INDIVIDUAL_RETIREMENT_MESSAGE,
    GEMINI_VALIDATION_REQUIRED: 'Gemini requires account validation before this connection can serve.',
    GEMINI_NOT_PROVISIONED: 'Gemini has not provisioned this connection for service.',
    GEMINI_PROJECT_UNAVAILABLE: 'Gemini could not establish a usable project for this connection.',
    GEMINI_PROJECT_CHANGED: 'Gemini returned a different project from the one requested.',
  })[result?.code];
  const measured = !mismatch && !identityMissing && ['measured', 'partial'].includes(buckets?.status);
  const unsupported = ['GEMINI_AUTH_MODE_UNSUPPORTED', 'GEMINI_AUTH_FILE_UNSUPPORTED'].includes(result?.code);
  const reading = Object.freeze({ ...presence,
    email,
    status: mismatch ? STATUS.ACCOUNT_MISMATCH : retired ? STATUS.NOT_PROVISIONED
      : identityMissing || serviceRefusal ? STATUS.TRANSIENT : presence.status,
    canServe: mismatch || identityMissing || serviceRefusal ? false : presence.canServe,
    allowanceBuckets: mismatch || identityMissing || serviceRefusal ? null : buckets,
    readAt: buckets?.observedAt || null,
    usageStatus: measured ? 'measured' : unsupported ? 'unsupported' : observed ? 'not_reported' : 'unavailable',
    usageSource: observed ? 'gemini-cli-core/retrieveUserQuota' : null,
    usageCode: mismatch ? 'ACCOUNT_USAGE_IDENTITY_MISMATCH' : serviceRefusal ? result.code : identityMissing ? 'GEMINI_IDENTITY_UNAVAILABLE'
      : measured ? null : result?.code || 'GEMINI_USAGE_NOT_REPORTED',
    usageReason: measured ? null : unsupported
      ? 'This Gemini connection does not use the supported personal OAuth file storage. No allowance was estimated.'
      : serviceRefusal || 'Gemini allowance could not be measured for this connection. This does not establish that its sign-in expired.',
    reason: mismatch ? `The Gemini sign-in for "${account.name}" does not match the expected account.`
      : serviceRefusal || (identityMissing ? `Gemini did not verify the expected identity for "${account.name}".`
      : observed ? 'Gemini verified this sign-in. Allowance is reported separately for each model and token type.'
      : email ? 'Gemini verified this sign-in, but its allowance could not be measured.' : presence.reason)
  });
  return probeLifecycleOf(result) === 'closed' ? withProbeLifecycle(reading, 'closed') : reading;
}

module.exports = Object.freeze({
  runOwnedProbe,
  probeGeminiAccount,
  DEFAULT_PROBE_TIMEOUT_MS,
  EXHAUSTED_BY,
  FAILOVER_STATUSES,
  STATUS,
  antigravityQuotaWindows,
  appServerRequest,
  authFaultFrom,
  classifyProbe,
  classifyAntigravityCatalog,
  classifyAntigravityQuota,
  classifyGrokBilling,
  grokBillingReading,
  probeAntigravityAccount,
  probeGrokAccount,
  identityVerdict,
  probeAccount,
  probeSignInPresence,
  unwrapRateLimits: selectCodexRateLimits
});
