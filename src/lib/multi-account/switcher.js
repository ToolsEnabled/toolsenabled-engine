'use strict';
// Explicit account selection and manual state. A refused account never
// cascades to another account, regardless of usage, sign-in or probe status.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { STATUS } = require('./health.js');
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
// Quarantine preserves the damaged bytes and a durable choose-again record.
// The owned quarantine directory also guards an interrupted tombstone write:
// an absent state beside that directory cannot mean a never-chosen default.
function unreadableChoices() {
  return Object.fromEntries(PROVIDER_IDS.map(id => [id, true]));
}

function interruptedQuarantine(statePath, fsImpl) {
  if (typeof fsImpl.readdirSync !== 'function') return false;
  try {
    const prefix = `${path.basename(statePath)}.corrupt-`;
    return fsImpl.readdirSync(path.dirname(statePath)).some(name => name.startsWith(prefix));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new MultiAccountError('ACCOUNT_STATE_UNREADABLE',
      'The saved account selection could not be read. Open Accounts and choose an account before starting again.');
  }
}

function emptyState(selectionUnreadableByProvider = null) {
  return { activeAccount: null, activeByProvider: null, manualPinByProvider: null,
    selectionRevision: null, selectionUnreadableByProvider, lastSwitch: null, history: [] };
}

function choiceSnapshot(state) {
  // Compare legacy choices as well as the revision. Older writers do not
  // know the revision field and a pin-only change must still be detected.
  return JSON.stringify([state.selectionRevision || null, state.manualPinByProvider,
    state.manualPinByProvider ? null : state.history.filter(entry => entry?.outcome === 'manual-switch'),
    state.selectionUnreadableByProvider]);
}

function automaticSwitchingRefusal(request) {
  return ['excludeAccounts', 'keepTryingAccounts'].some(field => Object.hasOwn(request, field))
    ? { code: 'ACCOUNT_AUTOMATIC_SWITCHING_DISABLED',
      reason: 'Automatic account switching was removed. Choose an account before starting again.' } : null;
}

function accountStatusRefusal(status) {
  switch (status) {
    case STATUS.SIGNED_OUT: return { code: 'ACCOUNT_SIGNED_OUT', reason: 'The selected account is signed out. Open Accounts and sign in to that account before starting again.' };
    case STATUS.NOT_PROVISIONED: return { code: 'ACCOUNT_NOT_PROVISIONED', reason: 'The selected account is not set up. Open Accounts and sign in to that account before starting again.' };
    case STATUS.EXHAUSTED: return { code: 'ACCOUNT_EXHAUSTED', reason: 'The selected account has reached its allowance limit. Wait for its allowance to reset, or choose another account in Accounts.' };
    case STATUS.ACCOUNT_MISMATCH: return { code: 'ACCOUNT_MISMATCH', reason: 'The selected account is signed in as a different account. Open Accounts and sign in as the expected account before starting again.' };
    default: return { code: 'ACCOUNT_STATUS_UNKNOWN', reason: 'The selected account could not be checked. Open Accounts and check it again before starting.' };
  }
}

function validSelectionRecord(state) {
  if (!plainObject(state)) return false;
  if (state.activeAccount != null && (typeof state.activeAccount !== 'string' || !state.activeAccount.trim())) return false;
  if (state.selectionRevision != null && typeof state.selectionRevision !== 'string') return false;
  if (state.history != null && !Array.isArray(state.history)) return false;
  for (const field of ['activeByProvider', 'manualPinByProvider', 'selectionUnreadableByProvider']) {
    const map = state[field];
    if (map == null) continue;
    if (!plainObject(map)) return false;
    for (const provider of PROVIDER_IDS) {
      const value = map[provider];
      if (value == null) continue;
      if (field === 'selectionUnreadableByProvider' ? typeof value !== 'boolean'
        : typeof value !== 'string' || !value.trim()) return false;
    }
  }
  return true;
}

function readState(statePath, { fsImpl = fs, now = () => new Date() } = {}) {
  let parsed;
  try {
    parsed = readJsonFile(statePath, fsImpl);
    if (parsed && !validSelectionRecord(parsed)) throw new MultiAccountError('ACCOUNTS_JSON_INVALID',
      'The saved account selection is unreadable. Choose an account before starting again.');
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
    const state = emptyState(unreadableChoices());
    writeState(statePath, state, { fsImpl });
    return { ...state, quarantined: Object.freeze({ from: statePath, to: aside, cause: error.message }) };
  }
  if (!parsed) return emptyState(interruptedQuarantine(statePath, fsImpl) ? unreadableChoices() : null);
  return {
    selectionRevision: typeof parsed.selectionRevision === 'string' ? parsed.selectionRevision : null,
    selectionUnreadableByProvider: plainObject(parsed.selectionUnreadableByProvider) ? parsed.selectionUnreadableByProvider : null,
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
    selectionRevision: state.selectionRevision || null,
    selectionUnreadableByProvider: state.selectionUnreadableByProvider || null,
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

// Check only the account explicitly selected for this request.


async function selectAccount({ registry, preferred = null, probe, onAttempt = null, signal = null, ...request } = {}) {
  signal?.throwIfAborted();
  const retired = automaticSwitchingRefusal(request);
  if (retired) return Object.freeze({ ok: false, account: null, probe: null, attempts: Object.freeze([]), switched: false, ...retired });
  if (!registry || !Array.isArray(registry.accounts)) throw new MultiAccountError('ACCOUNTS_REGISTRY_INVALID', 'No account registry was given.');
  if (typeof probe !== 'function') throw new MultiAccountError('ACCOUNTS_PROBE_MISSING', 'No health probe was given; selection must never guess.');
  const account = preferred ? findAccount(registry, preferred) : null;
  if (!account) return Object.freeze({ ok: false, account: null, probe: null, attempts: Object.freeze([]), switched: false,
    code: preferred ? 'ACCOUNT_SELECTION_UNAVAILABLE' : 'ACCOUNT_SELECTION_REQUIRED',
    reason: preferred ? 'The selected account is not registered. Choose an account before retrying.' : 'Choose an account before starting.' });
  const result = await probe(account);
  signal?.throwIfAborted();
  if (onAttempt) onAttempt(result);
  const attempts = Object.freeze([describeAttempt(result)]);
  if (result?.status === STATUS.HEALTHY && result.canServe !== false) return Object.freeze({ ok: true, account, probe: result, attempts, switched: false, reason: `Using "${account.name}".` });
  return Object.freeze({ ok: false, account: null, probe: result, attempts, switched: false,
    ...accountStatusRefusal(result?.status) });
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
      || !Object.hasOwn(selection, 'previousAccount')
      || typeof selection.choiceSnapshot !== 'string') {
    throw new MultiAccountError(
      'ACCOUNT_LAUNCH_SELECTION_INVALID',
      'The checked account choice is missing or out of date. Start again to check your current choice.'
    );
  }

  const state = readState(statePath, { fsImpl });
  const provider = typeof selection.account.provider === 'string' ? selection.account.provider : null;
  const expectedPrevious = selection.previousAccount || null;
  const observedPrevious = activeFor(state, provider);
  if (observedPrevious !== expectedPrevious || state.selectionUnreadableByProvider?.[provider]
      || choiceSnapshot(state) !== selection.choiceSnapshot) {
    throw new MultiAccountError(
      'ACCOUNT_LAUNCH_COMMIT_CONFLICT',
      'The selected account changed while it was being checked. Start again to use your current choice.',
      { expectedPrevious, observedPrevious }
    );
  }

  const previous = observedPrevious;
  const changed = previous !== selection.account.name;
  if (codexConfigPath) syncCodexPin(codexConfigPath, selection.account, { fsImpl });
  writeState(statePath, {
    ...state,
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

// Resolve the chosen account for a launch. Existing callers intentionally
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
  manualPin = undefined,
  fsImpl = fs,
  signal = null,
  now = () => new Date().toISOString(),
  observedState = null,
  ...request
} = {}) {
  signal?.throwIfAborted();
  const retired = automaticSwitchingRefusal(request);
  if (retired) return Object.freeze({ ok: false, account: null, attempts: Object.freeze([]), ...retired });
  const state = observedState || readState(statePath, { fsImpl });
  /* The provider whose active name is the fallback head: the one the caller
     named, else the one the registry is entirely made of. */
  const served = typeof provider === 'string' ? provider : soleProviderOf(registry);
  if (state.selectionUnreadableByProvider?.[served]) return Object.freeze({ ok: false, account: null,
    attempts: Object.freeze([]), code: 'ACCOUNT_STATE_UNREADABLE',
    reason: 'The saved account selection could not be read. Open Accounts and choose an account before starting again.' });
  const pinned = plainObject(state.manualPinByProvider)
    ? state.manualPinByProvider[served]
    : [...state.history].reverse().find(entry => entry.outcome === 'manual-switch' && entry.provider === served)?.account;
  const wanted = preferred || pinned || null;
  const selection = await selectAccount({ registry, preferred: wanted, probe, signal });
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
      ...current,
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
  const resolved = Object.freeze({ ...selection, previousAccount: previous, changed, choiceSnapshot: choiceSnapshot(state) });
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
    ...state,
    selectionRevision: randomUUID(),
    selectionUnreadableByProvider: state.selectionUnreadableByProvider
      ? { ...state.selectionUnreadableByProvider, [provider]: false } : null,
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
  automaticSwitchingRefusal,
  commitLaunchSelection,
  readState,
  resolveForLaunch,
  selectAccount,
  switchTo,
  syncCodexPin,
  writeState
});
