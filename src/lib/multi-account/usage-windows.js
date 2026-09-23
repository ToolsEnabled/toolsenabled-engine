'use strict';
// THE TWO WINDOWS A SUBSCRIPTION IS ACTUALLY LIMITED BY.
//
// Both providers meter the same person twice over: a SHORT rolling window
// (Codex calls it `primary` and it is five hours; Claude calls it `five_hour`)
// and a LONG one (Codex `secondary`, Claude `seven_day`). Until this module the
// product read only the short one -- health.js takes `rateLimits.primary` and
// nothing else -- so an account that was comfortable this hour and one turn off
// its weekly ceiling looked identical to an account with a whole week spare.
// Choosing between accounts on that reading picks the wrong one at exactly the
// moment the choice matters.
//
// NOTHING HERE MEASURES ANYTHING. It normalises what a provider already said
// into one shape, and every field it cannot read stays null. Four rules, and
// each is a defect this codebase has already found once:
//
//   1. NULL IS NOT ZERO. A window the provider did not report is `null`, never
//      0%. Rendering an unread window as empty invites a launch onto an account
//      nothing has vouched for -- the "absence read as consent" failure the
//      cloud panel already had to be repaired for.
//   2. A WINDOW THAT DOES NOT APPLY IS NOT A WINDOW. Claude's cache reports
//      `percent: null` for a limit that is inapplicable to the plan, and
//      claude-cached-utilization.js already labels that NOT_APPLICABLE. It is
//      dropped here rather than counted as free room.
//   3. HEADROOM IS THE WORST WINDOW, NOT THE AVERAGE. An account is stopped by
//      whichever ceiling it reaches first, so the room it has is the room in
//      its most constrained MEASURED window. Averaging the two would report a
//      weekly-spent account as half free.
//   4. ONE SLOT DECIDES; IT IS NOT THE WHOLE READING. A provider may meter more
//      than one week at once, and the `weekly` slot can hold one of them.
//      MEASURED 2026-09-02 against Claude Code 2.1.258 on the owner's own
//      account: the reply carried an all-models week at 25% used and a
//      Fable-scoped week at 46% and `is_active`, so the accounts menu drew a
//      single bar reading "this week · 54% free" and a person could tell
//      neither which week that was nor that the other existed (owner: "i think
//      fable weekly limit instead of all models weekly limit is shown for
//      claude we should include both"). The slot stays the single figure every
//      ranking and exhaustion test reads, and `weeklyWindows` carries every
//      weekly ceiling the provider reported -- in the provider's own order,
//      each naming the model it is scoped to -- so a SURFACE can show every
//      ceiling without a DECISION changing. Putting a second figure on a
//      screen is not a reason to change which ceiling stops a run.

const { decodeCodexWindow } = require('../usage/codex-rate-limits');

const HOURLY = 'hourly';
const WEEKLY = 'weekly';

const WINDOW_KINDS = Object.freeze({ HOURLY, WEEKLY });

// A reading with neither window read. Frozen and shared: consumers treat it as
// "nothing known", and nothing may mutate it into a claim. `weeklyWindows` is
// present-and-empty rather than absent, so on the far side of an IPC "this
// account reported no weekly ceiling" and "this build is older than the list"
// stay two different answers, and a consumer may iterate it without first
// asking which build answered.
const NO_WINDOWS = Object.freeze({ hourly: null, weekly: null, weeklyWindows: Object.freeze([]) });

// Anything at or under a day is the short window; anything longer is the long
// one. Used when a provider states the window's length.
const SHORT_WINDOW_MAX_MINUTES = 24 * 60;

// WHEN THE LENGTH IS NOT STATED, THE RESET TIME DECIDES. Codex Pro plans meter
// only a weekly window and report it as `primary` with no length (owner,
// 2026-09-02: "codex doesnt have 5 hour windows for some of my codex accounts
// since they are pro"), and the first cut labelled that "5-hour window ·
// resets in 6 days". A window that turns over more than six hours from now
// cannot be the five-hour one. Six, not twenty-four: a weekly window in its
// last day would otherwise read as the short one for a whole day out of
// every seven. Position is the last resort, when neither is stated.
const SHORT_WINDOW_RESET_MAX_MS = 6 * 60 * 60 * 1000;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finitePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** One window, or null when the provider did not report a usable one. */
function windowRecord({ kind, percent, resetsAt = null, label = null, model = null }) {
  if (!finitePercent(percent)) return null;
  return Object.freeze({
    kind,
    usedPercent: percent,
    // Kept as the number a person reads rather than recomputed downstream, so
    // "how much room is left" has exactly one definition in this codebase.
    remainingPercent: Math.max(0, 100 - percent),
    resetsAt: typeof resetsAt === 'string' && resetsAt ? resetsAt : null,
    // What the provider itself called this window, when it said. Shown rather
    // than translated, because "seven_day_opus" and "seven_day" are different
    // ceilings and collapsing them loses which one is nearly spent.
    label: typeof label === 'string' && label ? label : null,
    /* WHICH MODEL THIS CEILING COVERS, when the provider scoped it to one.
       `label` already carries the provider's own word, but that word is
       `weekly_scoped` -- jargon a surface cannot put in front of a person.
       The model's display name is the part that is readable, held apart so
       one bar can be named "this week · Fable" beside another named "this
       week · all models" without a display string being parsed back apart to
       do it. Null means the ceiling covers every model, NOT that the model is
       unknown: a window this module could not place is dropped rather than
       recorded with a blank scope. */
    model: typeof model === 'string' && model ? model : null
  });
}

/* CODEX. `account/rateLimits/read` answers `{ primary, secondary }`, each
 * `{ usedPercent, windowDurationMins, resetsAt }` with resetsAt in epoch seconds;
 * legacy local fixtures use windowMinutes. The shared decoder handles both.
 *
 * The window's own stated length decides which slot it lands in, and the field
 * name is only the fallback. Measured builds have disagreed about the length of
 * `primary` (five hours on the plans this was read against, and the field is
 * documented as variable), so binding "primary" to "hourly" by position alone
 * would mislabel any plan whose short window is not short. */
function codexWindows(rateLimits, { now = Date.now() } = {}) {
  if (!plainObject(rateLimits)) return NO_WINDOWS;
  const clock = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const slots = { hourly: null, weekly: null };
  for (const [field, fallbackKind] of [['primary', HOURLY], ['secondary', WEEKLY]]) {
    const decoded = decodeCodexWindow(rateLimits[field]);
    if (!decoded || decoded.durationStatus === 'invalid') continue;
    const { windowMinutes: minutes, resetsAt } = decoded;
    const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
    const kind = minutes !== null
      ? (minutes <= SHORT_WINDOW_MAX_MINUTES ? HOURLY : WEEKLY)
      : (Number.isFinite(resetMs) && resetMs - clock > SHORT_WINDOW_RESET_MAX_MS ? WEEKLY : fallbackKind);
    const record = windowRecord({
      kind,
      percent: decoded.usedPercent,
      resetsAt,
      label: minutes === null ? field : `${field} · ${minutes} min`
    });
    if (!record) continue;
    /* TWO READINGS FOR ONE SLOT KEEP THE MORE CONSTRAINED ONE. It only happens
       when a build reports two windows of similar length, and taking the freer
       of the two would be the one direction that overstates the room left. */
    if (!slots[kind] || record.usedPercent > slots[kind].usedPercent) slots[kind] = record;
  }
  /* Codex meters exactly one week, so the list is that window or nothing. It
     is filled here as well as for Claude so that a surface drawing "every
     weekly ceiling this account is under" has one rule and no provider test;
     a Codex row therefore draws the single bar it always drew. */
  return Object.freeze({
    ...slots,
    weeklyWindows: Object.freeze(slots.weekly ? [slots.weekly] : [])
  });
}

/* CLAUDE. Both Claude surfaces carry a `limits` array whose entries name their
 * own window: the `.claude.json` cache that claude-cached-utilization.js reads
 * and the live `get_usage` reply that ../providers/claude-usage-probe.js takes.
 * Measured on 2026-09-02 against Claude Code 2.1.258, the two are the same
 * payload -- the CLI writes the reply it fetched into the cache.
 *
 * WHICH SLOT AN ENTRY LANDS IN IS READ OFF THE ENTRY, GROUP FIRST. The entries
 * measured were `session` (group `session`), `weekly_all` and `weekly_scoped`
 * (both group `weekly`). The first draft of this function recognised only
 * `five_hour` and `seven_day*` -- the names of the SIBLING fields in the same
 * payload, not of anything in `limits` -- and so dropped every real entry,
 * which left every Claude account "unread" by the cache route. `group` is the
 * provider's own word for the slot and is taken first; the kind's prefix is
 * the fallback for an entry that omits the group.
 *
 * Without a requested session model, the active entry fills a slot before
 * the worst one. With a known requested model, its own and all-model ceilings
 * apply together, regardless of the default CLI model's active flag.
 * `is_active` is the
 * provider's statement of which ceiling is constraining the account right now.
 * In the live reading above the model-scoped weekly window (46%) was active
 * while the all-models weekly window (25%) and the session window (21%) were
 * not. So an active entry takes its slot over any inactive one, whatever the
 * percentages, and only when NO entry for that slot is active does the most
 * constrained measured entry stand in -- the pessimistic reading this file
 * has always preferred over the optimistic one. Ranking on an inactive
 * per-model ceiling would call an account spent on a limit it is not under.
 *
 * The entry's own name is carried through in `label` so the surface can say
 * WHICH ceiling is the one that is nearly spent.
 *
 * BOTH WEEKLY CEILINGS ARE CARRIED, AND STILL ONLY ONE OF THEM DECIDES. The
 * reply above holds two weekly entries at the same time -- `weekly_all` at 25%
 * and `weekly_scoped` for Fable at 46% -- and the paragraph before this one
 * puts the ACTIVE one in the `weekly` slot. The accounts menu draws that slot
 * as a single bar reading "this week", so the person saw the Fable ceiling and
 * had no way to tell it from the all-models one (owner, 2026-09-03: "i think
 * fable weekly limit instead of all models weekly limit is shown for claude we
 * should include both"). `weeklyWindows` therefore carries EVERY measured
 * weekly entry for a surface to draw, while `weekly` stays exactly what it
 * was: the one figure measuredWindows/bindingWindow/spentWindow read, so no
 * ranking and no exhaustion test moves because a second bar appeared.
 *
 * IN THE PROVIDER'S ORDER, NOT WORST FIRST. measuredWindows sorts because its
 * job is to find the worst; this list is a row of bars a person reads twice a
 * day, and sorting on the percentages would make two bars swap places the
 * moment the numbers crossed. The array order is the provider's own and does
 * not move between reads. */
function claudeSlotOf(limit) {
  if (limit.group === 'session') return HOURLY;
  if (limit.group === 'weekly') return WEEKLY;
  if (limit.kind === 'five_hour' || limit.kind === 'session') return HOURLY;
  if (limit.kind.startsWith('seven_day') || limit.kind.startsWith('weekly')) return WEEKLY;
  return null;
}

function claudeWindows(utilization, { model = null } = {}) {
  if (!plainObject(utilization) || !Array.isArray(utilization.limits)) return NO_WINDOWS;
  // The provider reports display names ("Claude Opus", "Sonnet 4.5") as
  // well as CLI model IDs. Both spellings must retain the same model scope.
  const family = value => typeof value === 'string' ? /^(?:claude[-/ ]+)?(fable|opus|sonnet|haiku)(?:[- ]|$)/i.exec(value)?.[1].toLowerCase() || null : null;
  const selectedModel = family(model);
  const candidates = { hourly: [], weekly: [] };
  for (const limit of utilization.limits) {
    if (!plainObject(limit) || typeof limit.kind !== 'string') continue;
    // NOT_APPLICABLE windows carry a null percent and are dropped by
    // windowRecord below; this is the same fact stated where it is decided.
    if (!finitePercent(limit.percent)) continue;
    const kind = claudeSlotOf(limit);
    if (kind === null) continue;
    // Legacy named windows encode their model in the field name instead of
    // scope.model. Keep that scope here for both live and cached readings;
    // an Opus-only ceiling must not become a shared ceiling for Sonnet.
    const namedModel = limit.kind === 'seven_day_opus' ? 'Opus'
      : limit.kind === 'seven_day_sonnet' ? 'Sonnet' : null;
    const scopeModel = typeof limit.model === 'string' && limit.model ? limit.model : namedModel;
    const record = windowRecord({
      kind,
      percent: limit.percent,
      resetsAt: limit.resetsAt,
      label: scopeModel ? `${limit.kind} · ${scopeModel}` : limit.kind,
      model: scopeModel
    });
    if (!record) continue;
    candidates[kind].push({ record, active: limit.isActive === true });
  }
  const slots = { hourly: null, weekly: null };
  for (const kind of [HOURLY, WEEKLY]) {
    // A default CLI's active model is not necessarily the model being started.
    // Keep shared and selected-model ceilings; retain unknown scopes conservatively.
    const applicable = candidates[kind].filter(({ record }) => !selectedModel || !family(record.model) || family(record.model) === selectedModel);
    const active = applicable.filter(candidate => candidate.active);
    const pool = selectedModel ? applicable : active.length > 0 ? active : applicable;
    for (const { record } of pool) {
      if (!slots[kind] || record.usedPercent > slots[kind].usedPercent) slots[kind] = record;
    }
  }
  return Object.freeze({
    ...slots,
    /* EVERY weekly ceiling, IN THE PROVIDER'S OWN ORDER -- not worst first.
       The order `limits[]` arrives in puts the all-models ceiling before the
       model-scoped one, which is the order a person reads them in ("the week,
       and then the week for this model"); sorting by percentage would move
       the bars around between two reads of the same account. The slot above
       is one of these records, selected for the requested model when given,
       and is what every admission decision reads. */
    weeklyWindows: Object.freeze(candidates.weekly.map(candidate => candidate.record))
  });
}

/* A window record this module would have produced: both figures finite. A
   foreign object in a slot -- a probe result built elsewhere with a bare
   `{ usedPercent }` or nothing at all -- is not a reading, and counting it
   would rank an account on NaN. */
function measuredRecord(window) {
  return plainObject(window) && Number.isFinite(window.usedPercent) && Number.isFinite(window.remainingPercent);
}

/**
 * Every window that was actually read, worst first.
 *
 * THE TWO SLOTS, AND DELIBERATELY NOT `weeklyWindows`. That list exists so a
 * surface can DRAW every weekly ceiling; this function is what every ranking
 * and exhaustion decision is built on, and reading the list here would let a
 * second, inactive weekly entry decide which account a start goes to -- the
 * exact reading the active-entry rule above was written to refuse.
 */
function measuredWindows(windows) {
  if (!plainObject(windows)) return [];
  return [windows.hourly, windows.weekly]
    .filter(measuredRecord)
    .sort((a, b) => b.usedPercent - a.usedPercent);
}

/**
 * The window this account will hit first, or null when neither was read.
 *
 * "First" is by how little room is left, not by how soon it resets: a weekly
 * ceiling that resets in five days still stops the next turn if it is full.
 */
function bindingWindow(windows) {
  const measured = measuredWindows(windows);
  return measured.length > 0 ? measured[0] : null;
}

/**
 * How much room this account has, as a percentage, or null when NOTHING was
 * read. Null is the whole point: a caller ordering accounts by headroom must be
 * able to tell an account with room from an account nobody asked.
 */
function headroomPercent(windows) {
  const binding = bindingWindow(windows);
  return binding === null ? null : binding.remainingPercent;
}

/** True when at least one window was read. */
function anyWindowMeasured(windows) {
  return measuredWindows(windows).length > 0;
}

/**
 * A limit meant for ONE window, or the single number to fall back on.
 *
 * A value outside 0..100 is not a limit and never silently becomes one. It
 * falls back rather than comparing against nonsense, so a registry with a typo
 * in one of the two per-window fields keeps exactly the behaviour it had.
 */
function usableThreshold(specific, fallback) {
  const ok = value => Number.isFinite(value) && value >= 0 && value <= 100;
  return ok(specific) ? specific : fallback;
}

/**
 * The two limits in force, resolved from a registry's three fields.
 *
 * ONE LIMIT PER WINDOW, because the two windows are not the same kind of
 * thing. A weekly allowance is spent over days and is worth moving away from
 * early; a five-hour window refills fast enough that the same figure would
 * park an account that is about to be fine again. Measured on the owner's own
 * machine 2026-09-03: two accounts sat at 90% and 91% of the WEEK with 96% and
 * 65% of their five-hour window still free, and a single 90% threshold stopped
 * both of them on the strength of the slow window alone.
 *
 * A registry naming only the old single field gets that number for both, which
 * is the answer it has always had.
 */
function windowLimits(source) {
  const from = source && typeof source === 'object' ? source : {};
  const single = from.exhaustedAtPercent;
  return Object.freeze({
    hourlyLimit: usableThreshold(from.exhaustedAtPercentHourly, single),
    weeklyLimit: usableThreshold(from.exhaustedAtPercentWeekly, single)
  });
}

/**
 * The window that has reached its OWN limit, or null when neither has.
 *
 * When both have, the one further past its limit is reported, because that is
 * the one a person would name if asked why the account stopped. A window
 * nobody measured is not past anything: it is skipped, never guessed at.
 */
function spentWindow(windows, limits) {
  if (!windows || typeof windows !== 'object') return null;
  const { hourlyLimit, weeklyLimit } = limits || {};
  const over = [];
  for (const [kind, limit] of [['hourly', hourlyLimit], ['weekly', weeklyLimit]]) {
    const window = windows[kind];
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    if (!Number.isFinite(limit)) continue;
    if (window.usedPercent >= limit) {
      over.push({ ...window, kind, limit, margin: window.usedPercent - limit });
    }
  }
  if (over.length === 0) return null;
  return over.sort((a, b) => b.margin - a.margin)[0];
}

// A retry time is an observation/recheck schedule, never a promise of quota.
// The caller persists this alongside its existing recovery intent and Stop
// fence. No account is probed or selected by this calculation.
function recoveryTiming(attempts, thresholds = {}, now = Date.now(), { recheckAttempt = 0 } = {}) {
  if (!Array.isArray(attempts) || attempts.length > 256 || !Number.isFinite(now)) {
    throw new TypeError('Recovery timing requires bounded account observations and a current clock.');
  }
  const limits = windowLimits(thresholds);
  const delayMs = Math.min(300000, 30000 * 2 ** Math.min(4, Math.max(0, Number.isSafeInteger(recheckAttempt) ? recheckAttempt : 0)));
  const waits = [];
  let unmeasuredCount = 0;
  let confirmedQuotaCount = 0;
  const exhausted = attempts.filter(attempt => attempt?.status === 'exhausted');
  for (const attempt of attempts) {
    if (!attempt || attempt.status === 'transient') {
      unmeasuredCount++;
      waits.push({ at: now + delayMs, resetAt: null, reason: 'status-recheck' });
      continue;
    }
    if (attempt.status !== 'exhausted') continue;
    const windows = [['hourly', limits.hourlyLimit], ['weekly', limits.weeklyLimit]]
      .filter(([kind, limit]) => Number.isFinite(limit) && Number.isFinite(attempt.windows?.[kind]?.usedPercent)
        && attempt.windows[kind].usedPercent >= limit)
      .map(([kind]) => attempt.windows[kind]);
    // A configured reserve/threshold is an eligibility policy, not proof that
    // the provider has no quota left. Only observed full usage supports that claim.
    if (windows.some(window => window.usedPercent >= 100)
      || Number.isFinite(attempt.usedPercent) && attempt.usedPercent >= 100) confirmedQuotaCount++;
    // Both a full hour and a full week must reset before this account can be
    // eligible. A missing reset in either window cannot be guessed from the other.
    const resetValues = (windows.length ? windows.map(window => window.resetsAt) : [attempt.resetsAt])
      .map(value => typeof value === 'string' && value ? Date.parse(value) : NaN);
    const resetMs = resetValues.every(value => Number.isFinite(value) && value > now) ? Math.max(...resetValues) : NaN;
    if (Number.isFinite(resetMs)) waits.push({ at: resetMs + 1000, resetAt: new Date(resetMs).toISOString(), reason: 'observed-reset' });
    else {
      unmeasuredCount++;
      waits.push({ at: now + delayMs, resetAt: null, reason: 'reset-recheck' });
    }
  }
  const identityBlocked = attempts.some(attempt => attempt?.status === 'account_mismatch');
  const next = identityBlocked ? null : waits.sort((a, b) => a.at - b.at)[0];
  return Object.freeze({ nextAttemptAt: next ? new Date(next.at).toISOString() : null,
    resetAt: next?.resetAt || null, reason: next?.reason || (identityBlocked ? 'identity-action-required' : 'account-action-required'),
    allQuotaExhausted: attempts.length > 0 && confirmedQuotaCount === attempts.length,
    exhaustedCount: exhausted.length, unmeasuredCount });
}

module.exports = Object.freeze({
  recoveryTiming,
  NO_WINDOWS,
  SHORT_WINDOW_MAX_MINUTES,
  SHORT_WINDOW_RESET_MAX_MS,
  WINDOW_KINDS,
  anyWindowMeasured,
  bindingWindow,
  claudeWindows,
  codexWindows,
  headroomPercent,
  measuredWindows,
  spentWindow,
  usableThreshold,
  windowLimits,
  windowRecord
});
