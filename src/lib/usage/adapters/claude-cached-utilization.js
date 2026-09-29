'use strict';

// The passive route to Claude plan usage: Claude Code caches the same payload
// its /usage panel renders into ~/.claude.json under `cachedUsageUtilization`.
// Reading it costs no model turn, no session, no credential and no browser.
//
// Three things about this file will mislead anyone who reads it casually, and
// each is encoded here rather than left as folklore:
//
//   1. It carries DUPLICATE object keys.  JSON.parse keeps the last occurrence
//      and moves on; PowerShell's ConvertFrom-Json throws outright.  A reader
//      written in PowerShell therefore looks broken for no discoverable reason,
//      which is how this route gets abandoned as "not working".
//   2. A window whose value is null means NOT APPLICABLE, not zero.  Rendering
//      an inapplicable window as 0% invents a number and dresses it as measured.
//   3. The payload is a CACHE with a fetch timestamp.  Presenting a value from
//      it without checking age reports a stale number as current, which is the
//      precise failure this system has already committed once tonight.
//
// The adapter therefore withholds rather than guesses: absent, malformed,
// drifted or stale all resolve to UNKNOWN with a reason, never to a plausible
// figure.

const UNKNOWN = 'UNKNOWN';

const UNKNOWN_REASON = Object.freeze({
  CACHE_ABSENT: 'CLAUDE_CACHE_ABSENT',
  CACHE_UNREADABLE: 'CLAUDE_CACHE_UNREADABLE',
  CACHE_UNPARSEABLE: 'CLAUDE_CACHE_UNPARSEABLE',
  KEY_ABSENT: 'CLAUDE_CACHE_KEY_ABSENT',
  SHAPE_DRIFT: 'CLAUDE_CACHE_SHAPE_DRIFT',
  FUTURE_TIMESTAMP: 'CLAUDE_CACHE_FUTURE_TIMESTAMP',
  STALE: 'CLAUDE_CACHE_STALE'
});

const APPLICABILITY = Object.freeze({
  MEASURED: 'MEASURED',
  NOT_APPLICABLE: 'NOT_APPLICABLE'
});

// Fifteen minutes: long enough that a normal read hits a warm cache, short
// enough that a number this old is still a defensible description of now.
const DEFAULT_FRESHNESS_BUDGET_MS = 15 * 60 * 1_000;

function unknown(reason, detail) {
  return Object.freeze({ status: UNKNOWN, reason, detail: detail || null });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLimit(raw, index) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.kind !== 'string') return null;
  // percent null is meaningful: the window exists but does not apply.
  if (raw.percent !== null && !Number.isFinite(raw.percent)) return null;
  // Missing or drifted activity data cannot honestly be collapsed to false:
  // that flag determines which limit is reported as binding.
  if (typeof raw.is_active !== 'boolean') return null;

  const model =
    isPlainObject(raw.scope) && isPlainObject(raw.scope.model) && typeof raw.scope.model.display_name === 'string'
      ? raw.scope.model.display_name
      : null;

  return Object.freeze({
    kind: raw.kind,
    group: typeof raw.group === 'string' ? raw.group : null,
    applicability: raw.percent === null ? APPLICABILITY.NOT_APPLICABLE : APPLICABILITY.MEASURED,
    percent: raw.percent === null ? null : raw.percent,
    resetsAt: typeof raw.resets_at === 'string' ? raw.resets_at : null,
    model,
    // The active window is the one actually constraining the account right now.
    // Reporting the highest number instead of the active one is a common and
    // confidently-wrong summary.
    isActive: raw.is_active,
    index
  });
}

function createClaudeCachedUtilizationAdapter({
  readCache,
  now = () => Date.now(),
  freshnessBudgetMs = DEFAULT_FRESHNESS_BUDGET_MS
} = {}) {
  if (typeof readCache !== 'function') {
    throw new TypeError('createClaudeCachedUtilizationAdapter requires a readCache function.');
  }
  if (!Number.isFinite(freshnessBudgetMs) || freshnessBudgetMs <= 0) {
    throw new TypeError('freshnessBudgetMs must be a positive number of milliseconds.');
  }

  return function readClaudeCachedUtilization() {
    let raw;
    try {
      raw = readCache();
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return unknown(UNKNOWN_REASON.CACHE_ABSENT, 'No Claude CLI cache file on this machine.');
      }
      return unknown(UNKNOWN_REASON.CACHE_UNREADABLE, error.message);
    }
    if (raw === null || raw === undefined) {
      return unknown(UNKNOWN_REASON.CACHE_ABSENT, 'No Claude CLI cache file on this machine.');
    }

    let parsed;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        return unknown(UNKNOWN_REASON.CACHE_UNPARSEABLE, error.message);
      }
    } else {
      parsed = raw;
    }
    if (!isPlainObject(parsed)) {
      return unknown(UNKNOWN_REASON.SHAPE_DRIFT, 'Cache root is not an object.');
    }

    const cached = parsed.cachedUsageUtilization;
    if (cached === undefined || cached === null) {
      return unknown(UNKNOWN_REASON.KEY_ABSENT, 'cachedUsageUtilization is absent; the Claude CLI may not have fetched usage yet.');
    }
    if (!isPlainObject(cached)) return unknown(UNKNOWN_REASON.SHAPE_DRIFT, 'cachedUsageUtilization is not an object.');
    if (!Number.isFinite(cached.fetchedAtMs)) {
      // Without a fetch time the age is unknowable, and an unaged cache value
      // cannot honestly be called current.
      return unknown(UNKNOWN_REASON.SHAPE_DRIFT, 'cachedUsageUtilization carries no usable fetchedAtMs, so its age is unknown.');
    }
    if (!isPlainObject(cached.utilization) || !Array.isArray(cached.utilization.limits)) {
      return unknown(UNKNOWN_REASON.SHAPE_DRIFT, 'cachedUsageUtilization.utilization.limits is missing or not an array.');
    }

    const observedAtMs = now();
    if (!Number.isFinite(observedAtMs)) {
      return unknown(UNKNOWN_REASON.SHAPE_DRIFT, 'The current time could not be measured, so cache freshness is unknown.');
    }

    const ageMs = observedAtMs - cached.fetchedAtMs;
    if (ageMs < 0) {
      return unknown(
        UNKNOWN_REASON.FUTURE_TIMESTAMP,
        `The cache fetch timestamp is ${Math.round(-ageMs / 1_000)} seconds ahead of this clock, so its age is untrustworthy.`
      );
    }
    if (ageMs > freshnessBudgetMs) {
      return unknown(
        UNKNOWN_REASON.STALE,
        `The cached figure is ${Math.round(ageMs / 60_000)} minutes old, beyond the ${Math.round(freshnessBudgetMs / 60_000)}-minute budget.`
      );
    }

    const limits = cached.utilization.limits.map(normalizeLimit);
    if (limits.length === 0) {
      return unknown(UNKNOWN_REASON.SHAPE_DRIFT, 'No limit entry in the cache had a recognisable shape.');
    }
    if (limits.some((limit) => limit === null)) {
      return unknown(UNKNOWN_REASON.SHAPE_DRIFT, 'At least one limit entry in the cache had an unrecognisable shape.');
    }

    const measured = limits.filter((l) => l.applicability === APPLICABILITY.MEASURED);
    const active = measured.filter((l) => l.isActive);

    return Object.freeze({
      status: 'MEASURED',
      source: 'claude-cached-utilization',
      fetchedAtMs: cached.fetchedAtMs,
      ageMs,
      accountUuid: typeof cached.accountUuid === 'string' ? cached.accountUuid : null,
      limits: Object.freeze(limits),
      // Callers that want one number should use this one, and should say
      // plainly when it is null rather than substituting the largest.
      bindingLimit: active.length === 1 ? active[0] : null,
      activeLimits: Object.freeze(active)
    });
  };
}

module.exports = Object.freeze({
  APPLICABILITY,
  DEFAULT_FRESHNESS_BUDGET_MS,
  UNKNOWN_REASON,
  createClaudeCachedUtilizationAdapter
});
