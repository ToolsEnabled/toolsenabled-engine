'use strict';

// C1, carried 4-2 by the 2026-08-03 council: adopt the experimental SDK usage
// method as the PRIMARY Claude usage source.
//
// Both dissenting seats made the same verified objection, and it is a good one:
// the SDK is installed on neither tree, the reader has no production caller,
// and a passive cache route demonstrably works today.  Their stated 3am failure
// mode was precise — "Claude allowance quietly becomes UNKNOWN even though
// fresher cached utilization may exist".  Implementing "primary" as "only"
// would have made the dissenters right and demoted a working route in favour of
// an uninstalled one.
//
// So primary means FIRST IN ORDER, not SOLE.  Sources are tried in preference
// order; the first that yields a measured figure answers; UNKNOWN is returned
// only when every source declined, and it carries the reason each one gave.
// The majority gets the SDK figure wherever the SDK exists; the dissent gets
// its guarantee that a working passive read is never discarded in favour of
// silence.
//
// The resolver never merges sources.  Two disagreeing measurements are not
// averaged into a third number nobody observed; the winner is named in the
// result so a reader can always tell which surface produced the figure.

const UNKNOWN = 'UNKNOWN';

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finitePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function normalizeMeasured(result) {
  if (!plain(result)) return null;

  if (result.status === 'MEASURED') {
    return plain(result.bindingLimit) && finitePercent(result.bindingLimit.percent) ? result : null;
  }

  // createClaudeAgentSdkUsageReader intentionally returns the SDK response
  // unchanged. Its default subscription window is the same five-hour window
  // used by createClaudeSubscriptionAdapter.
  const fiveHour = plain(result.rate_limits) ? result.rate_limits.five_hour : null;
  if (result.rate_limits_available === true && plain(fiveHour) && finitePercent(fiveHour.utilization)) {
    return Object.freeze({
      status: 'MEASURED',
      bindingLimit: Object.freeze({ kind: 'five_hour', percent: fiveHour.utilization }),
      raw: result
    });
  }

  // A UsageReader-backed Claude subscription adapter returns a UsageRecord,
  // whose measured allowance is expressed as used and remaining quantities.
  const total = result.used + result.remaining;
  if (result.provenance === 'MEASURED' && result.scope === 'ACCOUNT_ALLOWANCE'
    && Number.isSafeInteger(result.used) && result.used >= 0
    && Number.isSafeInteger(result.remaining) && result.remaining >= 0
    && Number.isSafeInteger(total) && total > 0) {
    return Object.freeze({
      ...result,
      status: 'MEASURED',
      bindingLimit: Object.freeze({ kind: result.unit, percent: (result.used / total) * 100 })
    });
  }

  return null;
}

function createOrderedClaudeUsageSource(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new TypeError('createOrderedClaudeUsageSource requires a non-empty ordered array of sources.');
  }
  sources.forEach((source, index) => {
    if (!source || typeof source.read !== 'function' || typeof source.name !== 'string' || source.name.length === 0) {
      throw new TypeError(`sources[${index}] must be { name, read }.`);
    }
  });

  return async function readClaudeUsage() {
    const declined = [];

    for (const source of sources) {
      let result;
      try {
        result = await source.read();
      } catch (error) {
        // A source that throws is a source that declined.  It must never take
        // the whole reading down with it, or one broken adapter makes the
        // system blind to allowances it could still have measured.
        declined.push(Object.freeze({ source: source.name, reason: 'SOURCE_THREW', detail: error.message }));
        continue;
      }

      if (result && (result.status === UNKNOWN || result.provenance === UNKNOWN)) {
        declined.push(Object.freeze({ source: source.name, reason: result.reason, detail: result.detail || null }));
        continue;
      }
      const measured = normalizeMeasured(result);
      if (!measured) {
        declined.push(Object.freeze({ source: source.name, reason: 'SOURCE_RETURNED_UNRECOGNISED_SHAPE', detail: null }));
        continue;
      }

      return Object.freeze({
        ...measured,
        answeredBy: source.name,
        // Kept even on success: knowing the SDK was absent and the cache
        // answered is operationally different from the SDK having answered,
        // and a caller that cares can see it without a second call.
        declined: Object.freeze(declined)
      });
    }

    return Object.freeze({
      status: UNKNOWN,
      reason: 'ALL_CLAUDE_USAGE_SOURCES_DECLINED',
      detail: declined.map((d) => `${d.source}: ${d.reason}`).join('; '),
      declined: Object.freeze(declined)
    });
  };
}

module.exports = Object.freeze({ createOrderedClaudeUsageSource });
