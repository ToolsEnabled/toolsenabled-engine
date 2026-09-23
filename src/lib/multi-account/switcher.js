'use strict';
// Selection and automatic failover across the registered accounts.
//
// THE FAILOVER RULE, and why it is narrow. Only positive evidence that an
// account cannot serve moves us off it: the provider reporting a rate limit
// reached, a spend control reached, usage at/above the threshold, a signed-out
// home, or no home at all. Those are `FAILOVER_STATUSES`.
//
// Ordinarily a `transient` result stops the cascade and refuses. An explicit
// per-node keepTryingAccounts choice may inspect later accounts while leaving
// the unknown account unused and retaining its unknown status in the trail.
// A timeout or a dead pipe is not evidence that an allowance is spent, and
// rotating on it would abandon a perfectly good account and, over a flaky
// hour, walk through every account the owner has. Refusing surfaces the real
// fault instead of hiding an outage behind a rotation.
//
// An `account_mismatch` also stops the cascade. A home signed in as the wrong
// person is a configuration fault the owner must see, not something to route
// around silently -- routing around it is what made the 2026-08-09
// wrong-identity incident invisible for a day.
//
// Every selection returns the full trail of what was tried and why it was
// rejected, because a switch the user cannot see is its own trust problem.
//
// ONE RECORD, ONE ACTIVE NAME PER PROVIDER. The state file used to hold a
// single `activeAccount` for the whole machine, and every provider wrote it:
// a Codex start committed "school", and the next Claude start under manual
// mode then preferred "school" -- a name that belonged to the other program.
// With the ordinary case, the same person's account called the same thing on
// both providers, a switch on one silently changed which account the other
// started on. So the record now carries `activeByProvider`, one name per
// provider, and every reader here asks for the provider it is serving. The
// legacy `activeAccount` is still written (as the name most recently
// committed by anyone) for readers that predate the map, and it is only
// CONSULTED when the map is absent, which is what an old file looks like.

const fs = require('node:fs');
const path = require('node:path');

const { FAILOVER_STATUSES, STATUS } = require('./health.js');
const { MultiAccountError, PROVIDER_IDS, findAccount, requireAccount } = require('./registry.js');

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJsonFile(file, fsImpl) {
  let contents;
  try {
    contents = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    // A file that has never been written is a known absence. Any other read
    // failure is not evidence that the file is empty: refusing prevents an
    // unreadable state or pin from being replaced with freshly inferred data.
    if (error && error.code === 'ENOENT') return null;
    throw new MultiAccountError(
      'ACCOUNTS_JSON_READ_FAILED',
      `Could not read multi-account JSON file "${file}". Refusing to infer an empty value.`,
      { file, cause: error && error.message }
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new MultiAccountError(
      'ACCOUNTS_JSON_INVALID',
      `Multi-account JSON file "${file}" is invalid. Refusing to infer an empty value.`,
      { file, cause: error && error.message }
    );
  }
  if (!plainObject(parsed)) {
    throw new MultiAccountError(
      'ACCOUNTS_JSON_INVALID',
      `Multi-account JSON file "${file}" must contain an object. Refusing to infer an empty value.`,
      { file }
    );
  }
  return parsed;
}

/* WRITTEN BESIDE, FLUSHED, THEN RENAMED INTO PLACE. On 2026-09-02 a power loss
   left this file (9,420 bytes of NUL) unreadable, and readJsonFile above then
   refused every start's rotation until somebody moved it aside by hand -- the
   refusal is right, the exposure was the write. A truncate-and-overwrite leaves
   a window in which the file is empty or half-written; staging the bytes in a
   sibling, forcing them to disk, and renaming means the file is always either
   the old record or the new one. The fsync covers the bytes, which the audit
   ledger's crash-safe writes found a write-through rename of the name alone
   did not. A file system that offers no open/fsync/rename (the in-memory ones
   the tests pass) gets the plain write, so nothing changes what a test sees. */
function writeJsonFile(file, value, fsImpl) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const durable = ['openSync', 'fsyncSync', 'closeSync', 'renameSync'].every(name => typeof fsImpl[name] === 'function');
  if (!durable) {
    fsImpl.writeFileSync(file, text, 'utf8');
    return;
  }
  const staged = `${file}.tmp-${process.pid}`;
  fsImpl.writeFileSync(staged, text, 'utf8');
  const fd = fsImpl.openSync(staged, 'r+');
  try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
  fsImpl.renameSync(staged, file);
}

// The per-provider map as read from disk: only the providers this build knows,
// only string names. Absent (an older file) reads as null rather than as an
// empty map, because "nobody has written one" and "written, with nothing in
// it for this provider" are the two cases activeFor() below has to tell apart.
// Both name maps this record carries -- the account in use and the account the
// person chose -- have that shape and that distinction, so they share it.
function readNameByProvider(value) {
  if (!plainObject(value)) return null;
  const map = {};
  for (const id of PROVIDER_IDS) {
    map[id] = typeof value[id] === 'string' && value[id].length > 0 ? value[id] : null;
  }
  return map;
}

/* WHICH NAME IS ACTIVE FOR THIS PROVIDER.
 *
 * With the map present, the answer is the provider's own entry and nothing
 * else: a missing entry means no account of that provider has been chosen,
 * and the other provider's name is not a substitute. The legacy single name is
 * consulted only when the map is absent -- a file written before the map
 * existed -- so an upgrade behaves exactly as the old record did once, and
 * per provider from then on. A caller with no provider to name (a mixed
 * registry) gets the legacy answer, which is all the record can say. */
function activeFor(state, provider) {
  if (!state) return null;
  if (plainObject(state.activeByProvider)) {
    if (typeof provider !== 'string') return state.activeAccount || null;
    return typeof state.activeByProvider[provider] === 'string' ? state.activeByProvider[provider] : null;
  }
  return state.activeAccount || null;
}

// The map after one provider's name changes, with the other providers' names
// exactly as they were. A record that never had a map starts one here.
function withName(previousMap, provider, name) {
  const previous = plainObject(previousMap) ? previousMap : {};
  return typeof provider === 'string' ? { ...previous, [provider]: name } : { ...previous };
}

function withActive(state, provider, name) {
  return withName(state && state.activeByProvider, provider, name);
}

/* THE CHOSEN NAME FOR ONE PROGRAM, LEAVING THE OTHER PROGRAMS' CHOICES ALONE.
   Same shape and same reason as withActive: the record is shared, so a Claude
   choice must not be readable as a Codex one. */
function withPinned(state, provider, name) {
  return withName(state && state.manualPinByProvider, provider, name);
}

// The persisted state holds names and statuses only -- never a token, never an
// account e-mail's credentials, never anything that would be unsafe in a log.
/* A STATE FILE THAT CANNOT BE PARSED IS MOVED ASIDE, NOT OBEYED AND NOT
   OVERWRITTEN. On 2026-09-02 a power loss left this file as 9,420 bytes of NUL
   (and the copy seeded into a second instance carried the same bytes). The
   refusal below is right about the REGISTRY -- a list of accounts that cannot
   be read must not become an empty list -- but this file is only the memory of
   the last switch, and refusing it forever meant every start lost rotation and
   every "Use this one" answered "could not be read" until somebody renamed the
   file by hand. So: the bytes are kept, under a name that says what they are,
   and the record starts again from nothing. A file system that offers no
   rename or exclusive directory creation cannot quarantine and keeps the
   refusal. One rename into that newly owned directory preserves the current
   source even if another writer replaces it; copy/link then unlink would
   risk deleting that replacement after preserving only the older bytes. */
function readState(statePath, { fsImpl = fs, now = () => new Date() } = {}) {
  let parsed;
  try {
    parsed = readJsonFile(statePath, fsImpl);
  } catch (error) {
    if (!(error && error.code === 'ACCOUNTS_JSON_INVALID') || typeof fsImpl.renameSync !== 'function'
      || typeof fsImpl.mkdtempSync !== 'function') throw error;
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const directory = fsImpl.mkdtempSync(`${statePath}.corrupt-${stamp}-`);
    const aside = path.join(directory, path.basename(statePath));
    try {
      fsImpl.renameSync(statePath, aside);
    } catch (renameError) {
      try { fsImpl.rmdirSync(directory); } catch { /* only our empty directory may be removed */ }
      throw renameError;
    }
    return {
      activeAccount: null, activeByProvider: null, manualPinByProvider: null, lastSwitch: null, history: [],
      quarantined: Object.freeze({ from: statePath, to: aside, cause: error.message })
    };
  }
  if (!parsed) return { activeAccount: null, activeByProvider: null, manualPinByProvider: null, lastSwitch: null, history: [] };
  return {
    activeAccount: typeof parsed.activeAccount === 'string' ? parsed.activeAccount : null,
    activeByProvider: readNameByProvider(parsed.activeByProvider),
    /* THE ACCOUNT THE PERSON CHOSE, WHICH IS NOT THE ACCOUNT IN USE.
       `activeByProvider` is overwritten by every start, including one that
       failed over off the chosen account; this map is written only when a
       person picks one, so their choice outlives a start that could not use
       it. MEASURED 2026-09-03 in the owner's own record: a hand switch to
       the pinned account at 13:16:57Z, a start 87 seconds later that found it 92%
       through its week and used another account, and from that point nothing
       on the machine remembered the choice had been made. */
    manualPinByProvider: readNameByProvider(parsed.manualPinByProvider),
    lastSwitch: plainObject(parsed.lastSwitch) ? parsed.lastSwitch : null,
    history: Array.isArray(parsed.history) ? parsed.history.slice(-20) : []
  };
}

function writeState(statePath, state, { fsImpl = fs } = {}) {
  writeJsonFile(statePath, {
    $comment: 'Runtime state for the multi-account switcher. Names and statuses only; no credentials.',
    activeAccount: state.activeAccount,
    /* Written beside the legacy name on every write, so a record that has
       been touched by this build always carries the map. Null only when the
       writer itself had nothing (a refusal recorded over an old file). */
    activeByProvider: plainObject(state.activeByProvider) ? state.activeByProvider : null,
    /* Written on the same terms: null only when the writer itself had nothing,
       so a record this build has touched and that carries no pin is telling a
       reader "nobody has chosen", not "this build cannot say". */
    manualPinByProvider: plainObject(state.manualPinByProvider) ? state.manualPinByProvider : null,
    lastSwitch: state.lastSwitch,
    history: (state.history || []).slice(-20)
  }, fsImpl);
}

// config/codex.json is the pin every EXISTING consumer already reads (see
// src/lib/mission-bridge/actions.js). Writing the active account through it
// means a switch made here is immediately obeyed by dispatch paths this lane
// does not own, instead of creating a second, competing notion of "the current
// account". The file's $comment and any unknown keys are preserved verbatim.
function syncCodexPin(codexConfigPath, account, { fsImpl = fs } = {}) {
  const existing = readJsonFile(codexConfigPath, fsImpl) || {};
  if (existing.profileDir === account.profileDir) return false;
  writeJsonFile(codexConfigPath, { ...existing, profileDir: account.profileDir }, fsImpl);
  return true;
}

function describeAttempt(probe) {
  // Keep measurement absence explicit.  Attempts are the router's durable and
  // user-facing account report, so dropping the reset here makes a measured
  // allowance look as though it has no known recovery window.  Conversely,
  // substituting 0/100 or a computed date would turn "not observed" into a
  // plausible-looking provider fact.
  return Object.freeze({
    account: probe.account,
    status: probe.status,
    usedPercent: Number.isFinite(probe.usedPercent) ? probe.usedPercent : null,
    resetsAt: typeof probe.resetsAt === 'string' ? probe.resetsAt : null,
    /* The hourly and weekly pair, carried for the same reason usedPercent is:
       this trail is what a surface shows when it explains a switch, and "it
       moved off an account that had 60% of its hour left" is only answerable
       if the window that was actually full travelled with the attempt. Absent
       on a probe that predates ./usage-windows.js, which reads as not measured
       rather than as measured-and-empty. */
    windows: probe.windows && typeof probe.windows === 'object' ? probe.windows : null,
    /* WHICH LIMIT REFUSED, carried because the app has to say it. `exhausted`
       alone made every refusal read "the configured cutoff OR the provider
       allowance", which is the one word a person cannot act on -- and an exact
       resume was being turned away by a number on their own Accounts page. Left
       absent on a probe that predates the field, which reads as not known
       rather than as provider. */
    ...(typeof probe.exhaustedBy === 'string' ? { exhaustedBy: probe.exhaustedBy } : {}),
    ...(Number.isFinite(probe.exhaustedLimit) ? { exhaustedLimit: probe.exhaustedLimit } : {}),
    ...(typeof probe.exhaustedWindow === 'string' ? { exhaustedWindow: probe.exhaustedWindow } : {}),
    reason: probe.reason
  });
}

// Order candidates: the preferred account first (an explicit request, or the
// account already active), then everything else by registry priority.
function candidateOrder(registry, preferredName) {
  const preferred = preferredName ? findAccount(registry, preferredName) : null;
  if (!preferred) return registry.accounts.slice();
  return [preferred, ...registry.accounts.filter(account => account.name !== preferred.name)];
}

async function selectAccount({
  registry,
  preferred = null,
  probe,
  onAttempt = null,
  keepTryingAccounts = false,
  signal = null
} = {}) {
  signal?.throwIfAborted();
  if (!registry || !Array.isArray(registry.accounts)) {
    throw new MultiAccountError('ACCOUNTS_REGISTRY_INVALID', 'No account registry was given.');
  }
  if (typeof probe !== 'function') {
    throw new MultiAccountError('ACCOUNTS_PROBE_MISSING', 'No health probe was given; selection must never guess.');
  }

  const attempts = [];
  for (const account of candidateOrder(registry, preferred)) {
    signal?.throwIfAborted();
    const result = await probe(account);
    signal?.throwIfAborted();
    attempts.push(describeAttempt(result));
    if (onAttempt) onAttempt(result);

    if (result.status === STATUS.HEALTHY) {
      return Object.freeze({
        ok: true,
        account,
        probe: result,
        attempts: Object.freeze(attempts),
        switched: attempts.length > 1,
        reason: attempts.length > 1
          ? `Failed over to "${account.name}" after ${attempts.length - 1} unusable account(s).`
          : `Using "${account.name}".`
      });
    }

    // Not healthy, and not a state that justifies moving on. Stop here rather
    // than spending another account on an unknown.
    if (!FAILOVER_STATUSES.has(result.status)) {
      // Explicit persistent recovery may inspect the next account after an
      // uncertain free health check. It never uses this uncertain account or
      // conceals an identity mismatch, and the full observation stays visible.
      if (keepTryingAccounts === true && result.status === STATUS.TRANSIENT) continue;
      return Object.freeze({
        ok: false,
        account: null,
        probe: result,
        attempts: Object.freeze(attempts),
        switched: false,
        code: result.status === STATUS.ACCOUNT_MISMATCH ? 'ACCOUNT_MISMATCH' : 'ACCOUNT_STATUS_UNKNOWN',
        reason: `Stopped at "${result.account}": ${result.reason} Failover is reserved for accounts that are provably out of allowance, so this did not switch.`
      });
    }
  }

  return Object.freeze({
    ok: false,
    account: null,
    probe: null,
    attempts: Object.freeze(attempts),
    switched: false,
    code: attempts.some(attempt => attempt.status === STATUS.TRANSIENT) ? 'ACCOUNT_STATUS_UNKNOWN' : 'NO_ACCOUNT_USABLE',
    reason: attempts.some(attempt => attempt.status === STATUS.TRANSIENT)
      ? 'No account is currently proven eligible; some account health remains unknown. No account was used.'
      : `No usable account: all ${attempts.length} registered account(s) are exhausted, signed out, or unprovisioned. Refusing to run. This never falls back to API-key billing.`
  });
}

// Commit a previously resolved launch candidate only after the caller has
// positive evidence that its launch succeeded. The expected previous account
// makes the write fail closed if a concurrent manual switch happened between
// selection and commit.
function commitLaunchSelection({
  selection,
  statePath,
  codexConfigPath = null,
  /* THE CHOSEN NAME THIS START RESOLVED, WHEN THE CALLER RESOLVED ONE.
     Omitted -- which is every caller that does not read the pin -- the record's
     own map is carried through untouched, so committing a start can never be
     the thing that forgets a person's choice. Stated, it is written: that is
     how a choice a record only carries in its history (a file written before
     the map existed) is promoted into the field, before the twenty-entry
     history it currently lives in rolls over and drops it silently. */
  manualPin = undefined,
  fsImpl = fs,
  signal = null,
  now = () => new Date().toISOString()
} = {}) {
  signal?.throwIfAborted();
  if (!selection || selection.ok !== true || !selection.account
      || typeof selection.account.name !== 'string'
      || !Object.hasOwn(selection, 'previousAccount')) {
    throw new MultiAccountError(
      'ACCOUNT_LAUNCH_SELECTION_INVALID',
      'Only a successful resolved launch selection can be committed.'
    );
  }

  const state = readState(statePath, { fsImpl });
  const provider = typeof selection.account.provider === 'string' ? selection.account.provider : null;
  const expectedPrevious = selection.previousAccount || null;
  const observedPrevious = activeFor(state, provider);
  if (observedPrevious !== expectedPrevious) {
    throw new MultiAccountError(
      'ACCOUNT_LAUNCH_COMMIT_CONFLICT',
      'The active account changed after launch selection. Refusing to overwrite the newer choice.',
      { expectedPrevious, observedPrevious }
    );
  }

  const previous = observedPrevious;
  const changed = previous !== selection.account.name;
  if (codexConfigPath) syncCodexPin(codexConfigPath, selection.account, { fsImpl });
  writeState(statePath, {
    activeAccount: selection.account.name,
    activeByProvider: withActive(state, provider, selection.account.name),
    manualPinByProvider: manualPin === undefined
      ? (state.manualPinByProvider || null)
      : withPinned(state, provider, manualPin),
    lastSwitch: changed
      ? { at: now(), from: previous, to: selection.account.name, provider, automatic: Boolean(selection.switched), reason: selection.reason }
      : state.lastSwitch,
    history: [...state.history, {
      at: now(),
      outcome: 'selected',
      account: selection.account.name,
      provider,
      switchedFrom: changed ? previous : null,
      automatic: Boolean(selection.switched),
      attempts: selection.attempts
    }]
  }, { fsImpl });

  return selection;
}

// The one provider a registry serves, when it serves exactly one. A mixed
// registry (the cloud lane loads the whole file) answers null and falls back
// to the legacy single name, which is all that record can say for it.
function soleProviderOf(registry) {
  const providers = new Set((registry && Array.isArray(registry.accounts) ? registry.accounts : [])
    .map(account => account && account.provider)
    .filter(value => typeof value === 'string'));
  return providers.size === 1 ? [...providers][0] : null;
}

// Resolve an account for a launch. Existing rotation callers intentionally
// persist immediately; transactional launch callers pass
// `persistSelection:false` and invoke commitLaunchSelection only after the
// external process acknowledges creation.
async function resolveForLaunch({
  registry,
  provider = null,
  preferred = null,
  probe,
  statePath,
  codexConfigPath = null,
  persistSelection = true,
  keepTryingAccounts = false,
  manualPin = undefined,
  fsImpl = fs,
  signal = null,
  now = () => new Date().toISOString()
} = {}) {
  signal?.throwIfAborted();
  const state = readState(statePath, { fsImpl });
  /* The provider whose active name is the fallback head: the one the caller
     named, else the one the registry is entirely made of. */
  const served = typeof provider === 'string' ? provider : soleProviderOf(registry);
  const wanted = preferred || activeFor(state, served) || null;
  const selection = await selectAccount({ registry, preferred: wanted, probe, signal, keepTryingAccounts });
  /* Both successful selections and refusals write state below, even when
     persistSelection is false. Cancel before either post-probe write. */
  signal?.throwIfAborted();

  if (!selection.ok) {
    /* A refusal is recorded too: the owner should be able to see that a launch
       was refused and why, not just that nothing happened.

       THE RECORD IS RE-READ FIRST, as commitLaunchSelection does. Every probe
       above was awaited, and a start for another provider can commit while
       they run; writing the map as it was read before the probes would hand
       that commit back its old name. So the history entry is the only thing
       this write adds, and the active names and lastSwitch are whatever the
       record says now. */
    const current = readState(statePath, { fsImpl });
    writeState(statePath, {
      activeAccount: current.activeAccount,
      activeByProvider: current.activeByProvider,
      /* A refusal is the LEAST reason to forget a choice: nothing served, so
         the account the person picked is still the account they picked. */
      manualPinByProvider: current.manualPinByProvider,
      lastSwitch: current.lastSwitch,
      history: [...current.history, { at: now(), outcome: 'refused', provider: served, code: selection.code, attempts: selection.attempts }]
    }, { fsImpl });
    return selection;
  }

  const previous = activeFor(state, selection.account.provider);
  const changed = previous !== selection.account.name;
  const resolved = Object.freeze({ ...selection, previousAccount: previous, changed });
  if (persistSelection === false) return resolved;
  return commitLaunchSelection({
    selection: resolved,
    statePath,
    codexConfigPath,
    manualPin,
    fsImpl,
    now,
    signal
  });
}

// A manual switch still verifies the target before committing to it. Switching
// to an account that cannot serve would just move the failure somewhere less
// obvious.
async function switchTo({
  registry,
  selector,
  probe,
  statePath,
  codexConfigPath = null,
  fsImpl = fs,
  force = false,
  now = () => new Date().toISOString()
} = {}) {
  const account = requireAccount(registry, selector);
  const result = await probe(account);
  if (!result.canServe && !force) {
    return Object.freeze({
      ok: false,
      account: account.name,
      probe: result,
      code: result.status,
      reason: `Did not switch to "${account.name}": ${result.reason}`
    });
  }

  const state = readState(statePath, { fsImpl });
  const provider = typeof account.provider === 'string' ? account.provider : null;
  const previous = activeFor(state, provider);
  if (codexConfigPath) syncCodexPin(codexConfigPath, account, { fsImpl });
  writeState(statePath, {
    activeAccount: account.name,
    activeByProvider: withActive(state, provider, account.name),
    /* THE CHOICE, RECORDED WHERE A FAILOVER CANNOT REACH IT. The history entry
       below says a person chose this once; the map says they still have. */
    manualPinByProvider: withPinned(state, provider, account.name),
    lastSwitch: { at: now(), from: previous, to: account.name, provider, automatic: false, reason: result.reason },
    history: [...state.history, { at: now(), outcome: 'manual-switch', account: account.name, provider, switchedFrom: previous, automatic: false }]
  }, { fsImpl });

  return Object.freeze({
    ok: true,
    account: account.name,
    probe: result,
    previousAccount: previous,
    changed: previous !== account.name,
    forced: Boolean(force && !result.canServe),
    reason: `Active account is now "${account.name}".`
  });
}

module.exports = Object.freeze({
  activeFor,
  candidateOrder,
  commitLaunchSelection,
  readState,
  resolveForLaunch,
  selectAccount,
  switchTo,
  syncCodexPin,
  writeState
});
