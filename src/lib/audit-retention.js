'use strict';

// HOW MUCH AUDIT HISTORY STAYS IN THE LIVE LEDGER, AND WHAT THAT COSTS.
//
// The audit ledger has never been bounded. Measured on the owner's install
// 2026-08-17: 1,527 events/day, ~34,900 events after 23 days, ~557,000
// projected after a year. Every short-lived process verifies the whole thing
// before it may read or write -- a keeper deciding "nothing to do" costs
// 8,924 ms and 34,951 signature checks -- and a full install starts ~110 such
// processes an hour. At a year's growth that is ~190% of a CPU core spent
// re-proving the same immutable bytes, forever.
//
// This module decides WHEN an event leaves the live ledger for signed cold
// storage (audit.js's rollArchiveOnce does the moving). Nothing here deletes
// anything; it only answers "is the live window over its limit".
//
// It also computes what each choice costs, because the owner's directive was
// explicit that the customer must be told: "Let them know the system load they
// are getting themselves into clearly when they set their settings."

// MEASURED, NOT ESTIMATED. Full verification of the owner's 34,895-event
// ledger took 3,900 ms end to end (Ed25519 ~2,970 ms + content binding ~839 ms
// + row read ~125 ms), and the cost is linear in event count -- confirmed by
// profiling rather than assumed. Recalibrate from a real measurement if the
// verification path changes; do not adjust this to make a number look better.
const MEASURED_MS_PER_EVENT = 3900 / 34895;

// A full install registers keepers at 2 min, bridges at 5 min, sweeps at 15
// and 30 min. Counted from the machine's own scheduled-task registrations.
const SCHEDULED_STARTS_PER_HOUR = 110;

// Observed append rate, used only to translate an event count into "about how
// many days of history is that" for the disclosure. A caller with a real
// measurement for this install should pass its own.
const OBSERVED_EVENTS_PER_DAY = 1527;

const MODES = Object.freeze(['events', 'time', 'forever']);

// A window smaller than this is almost certainly a typo, and acting on it
// would strip the ledger to a stub. The roll has its own never-empty guard;
// this is the second, earlier one, so a bad setting is refused before it ever
// reaches the code that deletes.
const MINIMUM_EVENT_WINDOW = 100;
const MINIMUM_TIME_WINDOW_MS = 60 * 60 * 1000;

// ~6.5 days of history at the observed rate, ~1.1 s to verify, ~3.4% of one
// core across the scheduled fleet. Chosen against the owner's constraint that
// a customer machine must not be taxed beyond "one time at system start, and
// that minimal" -- a larger window is available and disclosed, but should be
// the customer's explicit choice rather than a default they never saw.
// Archived events are NOT lost: they stay signed, chained and verifiable in
// cold storage, so this trades live-query convenience, never evidence.
const DEFAULT_RETENTION = Object.freeze({ mode: 'events', value: 10000 });

// FAIL TOWARD KEEPING DATA, NEVER TOWARD DELETING IT.
//
// An unreadable or malformed retention setting resolves to 'forever' -- not to
// the default, and not to a guess. Growth is recoverable; a deletion driven by
// a misparsed setting is not. So the failure mode is a ledger that gets large
// and slow (visible, fixable) rather than one that quietly discarded history
// nobody asked it to discard.
function resolveRetention(raw) {
  if (raw === 'forever') return Object.freeze({ mode: 'forever', value: null, resolved: 'explicit' });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return Object.freeze({ mode: 'forever', value: null, resolved: 'unreadable' });
  }
  if (raw.mode === 'forever') return Object.freeze({ mode: 'forever', value: null, resolved: 'explicit' });
  if (!MODES.includes(raw.mode)) {
    return Object.freeze({ mode: 'forever', value: null, resolved: 'unreadable' });
  }
  if (!Number.isSafeInteger(raw.value) || raw.value <= 0) {
    return Object.freeze({ mode: 'forever', value: null, resolved: 'unreadable' });
  }
  if (raw.mode === 'events') {
    if (raw.value < MINIMUM_EVENT_WINDOW) {
      return Object.freeze({ mode: 'forever', value: null, resolved: 'below-floor' });
    }
    return Object.freeze({ mode: 'events', value: raw.value, resolved: 'explicit' });
  }
  if (raw.value < MINIMUM_TIME_WINDOW_MS) {
    return Object.freeze({ mode: 'forever', value: null, resolved: 'below-floor' });
  }
  return Object.freeze({ mode: 'time', value: raw.value, resolved: 'explicit' });
}

// Is the live window over its limit? Answers for ONE event -- the oldest --
// because the roll is deliberately one-out-one-in (owner directive: "it only
// ever deletes 1 old event and places in 1 new event, dont delet the whole
// record at once"). A bulk purge would reintroduce exactly the multi-second
// stall on a customer machine that this work exists to remove; amortising it
// one event at a time keeps the per-append cost flat and invisible.
// HOW FAR OVER AN EVENT WINDOW MAY GROW BEFORE IT ROLLS. One percent of the
// window, at least one event, at most a thousand. The roll then brings the
// live window back to exactly the policy value, so a customer never keeps
// FEWER events than they chose; for a while they keep up to this many more.
// MEASURED 2026-09-02: rolling one event per append at the cap rewrote both
// projection files (18 MB together) inside the writer lock on every append.
// HOW FAR OVER THE WINDOW THE LEDGER MAY DRIFT BEFORE IT ROLLS.
//
// A roll rewrites BOTH projection files for the whole live window (measured
// 11.5 MB + 6.7 MB at 10,000 events) and invalidates every process's parse
// memo of them. MEASURED 2026-09-04 on the owner's Live instance at the cap
// with seventeen circles: at 1% slack (100 events) the audit worker rolled
// every minute or two and then re-read and re-parsed ~18 MB per admission --
// ~50 MB of allocation a minute, a 313 MB worker heap, and Windows flagging
// the process for a leak. 5% (500 events at 10,000; never more than 2,000)
// keeps the same promise -- the person never keeps fewer than the policy says,
// briefly a few more -- at a twentieth of the rewrite rate.
function eventWindowSlack(value) {
  return Math.min(2000, Math.max(1, Math.floor(value / 20)));
}

function retentionPlan({ policy, total, oldestOccurredAtMs, nowMs } = {}) {
  const resolved = resolveRetention(policy);
  if (resolved.mode === 'forever') {
    return { shouldRoll: false, reason: 'retention-forever', policy: resolved, retained: total };
  }
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new TypeError('retention total must be a non-negative safe integer');
  }
  if (total === 0) {
    return { shouldRoll: false, reason: 'empty-ledger', policy: resolved, retained: total };
  }
  if (resolved.mode === 'events') {
    const slack = eventWindowSlack(resolved.value);
    if (total <= resolved.value + slack) {
      return { shouldRoll: false, reason: 'within-window', policy: resolved, retained: total, slack };
    }
    return {
      shouldRoll: true, reason: 'over-event-window', policy: resolved,
      retained: total, excess: total - resolved.value, slack
    };
  }
  // time
  if (!Number.isSafeInteger(oldestOccurredAtMs) || !Number.isSafeInteger(nowMs)) {
    throw new TypeError('time retention requires safe-integer oldestOccurredAtMs and nowMs');
  }
  const age = nowMs - oldestOccurredAtMs;
  if (age <= resolved.value) {
    return { shouldRoll: false, reason: 'within-window', policy: resolved, retained: total };
  }
  return { shouldRoll: true, reason: 'over-time-window', policy: resolved, retained: total, ageMs: age };
}

// WHAT THE CUSTOMER IS SIGNING UP FOR, IN THEIR OWN NUMBERS.
//
// Returns the load a given retention choice implies on THIS machine, derived
// from the measured per-event verification cost rather than a guess. `forever`
// deliberately reports the projected one-year figure as well, because the
// whole point of disclosing it is that "forever" does not feel expensive until
// it is.
function projectedLoad(policy, { eventsPerDay = OBSERVED_EVENTS_PER_DAY, startsPerHour = SCHEDULED_STARTS_PER_HOUR } = {}) {
  const resolved = resolveRetention(policy);
  if (!Number.isFinite(eventsPerDay) || eventsPerDay < 0) {
    throw new TypeError('eventsPerDay must be a non-negative finite number');
  }
  if (!Number.isFinite(startsPerHour) || startsPerHour < 0) {
    throw new TypeError('startsPerHour must be a non-negative finite number');
  }
  const forEvents = count => {
    const verifyMs = count * MEASURED_MS_PER_EVENT;
    return {
      events: count,
      days: eventsPerDay > 0 ? Number((count / eventsPerDay).toFixed(1)) : null,
      verifyMs: Math.round(verifyMs),
      cpuPercentOfOneCore: Number((((verifyMs * startsPerHour) / 3_600_000) * 100).toFixed(1))
    };
  };
  if (resolved.mode === 'events') return { mode: 'events', bounded: true, ...forEvents(resolved.value) };
  if (resolved.mode === 'time') {
    const count = Math.max(1, Math.round((resolved.value / 86_400_000) * eventsPerDay));
    return { mode: 'time', bounded: true, windowMs: resolved.value, ...forEvents(count) };
  }
  const oneYear = forEvents(Math.round(eventsPerDay * 365));
  return {
    mode: 'forever', bounded: false,
    ...forEvents(Math.round(eventsPerDay * 30)),
    afterOneYear: oneYear,
    note: 'Unbounded: this cost keeps growing for as long as the install is used.'
  };
}

// THE CHOICES A CUSTOMER ACTUALLY SEES.
//
// The settings registry takes plain strings for a select control, which is
// also the better surface: "newest 10,000 events" is a decision someone can
// make, where a raw policy object is not. Both axes the owner asked for are
// offered -- a count, a duration, and forever -- and the labels say which is
// which, so nobody has to guess whether "a month" means events or days.
const RETENTION_PRESETS = Object.freeze({
  'Newest 10,000 events': { mode: 'events', value: 10000 },
  'Newest 50,000 events': { mode: 'events', value: 50000 },
  'Last 30 days': { mode: 'time', value: 30 * 86_400_000 },
  'Last 90 days': { mode: 'time', value: 90 * 86_400_000 },
  'Keep everything': 'forever'
});

const DEFAULT_RETENTION_LABEL = 'Newest 10,000 events';

// An unknown label is treated exactly like any other unreadable setting: keep
// everything. A renamed or hand-edited option must never fall through to a
// window that deletes more than the customer chose.
function resolvePreset(label) {
  return resolveRetention(Object.prototype.hasOwnProperty.call(RETENTION_PRESETS, label)
    ? RETENTION_PRESETS[label]
    : null);
}

module.exports = Object.freeze({
  MODES, DEFAULT_RETENTION, MINIMUM_EVENT_WINDOW, MINIMUM_TIME_WINDOW_MS,
  MEASURED_MS_PER_EVENT, SCHEDULED_STARTS_PER_HOUR, OBSERVED_EVENTS_PER_DAY,
  RETENTION_PRESETS, DEFAULT_RETENTION_LABEL, resolvePreset, eventWindowSlack,
  resolveRetention, retentionPlan, projectedLoad
});
