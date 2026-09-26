'use strict';

// Shared decoding for Codex account/rateLimits/read. Callers retain their own
// contracts: Accounts can classify legacy windows without stated durations;
// the single-window UsageRecord adapter requires a complete, pinned schema.
// https://learn.chatgpt.com/docs/app-server (Rate limits, checked 2026-09-14)
// documents windowDurationMins and rateLimitsByLimitId. Older local fixtures
// use windowMinutes and a bare or rateLimits-wrapped bucket.
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function selectCodexRateLimits(result) {
  if (!plain(result)) return null;
  // The keyed view is authoritative when supplied. Never mix meters or use
  // compatibility data to conceal a missing/malformed named Codex bucket.
  if (Object.hasOwn(result, 'rateLimitsByLimitId') && result.rateLimitsByLimitId !== null) {
    const buckets = result.rateLimitsByLimitId;
    if (!plain(buckets) || !Object.hasOwn(buckets, 'codex')) return null;
    const bucket = buckets.codex;
    return plain(bucket) && bucket.limitId === 'codex' ? bucket : null;
  }
  const bucket = Object.hasOwn(result, 'rateLimits')
    ? result.rateLimits : (Object.hasOwn(result, 'primary') ? result : null);
  if (!plain(bucket)) return null;
  // Legacy responses omitted the identity; an explicit different identity is
  // never an account-wide Codex allowance, even in the compatibility view.
  if (Object.hasOwn(bucket, 'limitId') && bucket.limitId !== 'codex') return null;
  return bucket;
}

function decodeCodexWindow(value) {
  if (!plain(value)) return null;
  const usedPercent = Number.isFinite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100
    ? value.usedPercent : null;
  const durations = ['windowMinutes', 'windowDurationMins']
    .filter(key => Object.hasOwn(value, key)).map(key => value[key]);
  const durationStatus = durations.length === 0 ? 'missing'
    : durations.every(minutes => Number.isSafeInteger(minutes) && minutes > 0 && minutes === durations[0])
      ? 'valid' : 'invalid';
  // Invalid and conflicting aliases are distinct from omitted duration. They
  // must not trigger a position/reset-time guess in an Accounts consumer.
  const windowMinutes = durationStatus === 'valid' ? durations[0] : null;
  // Date's range is narrower than Number.MAX_SAFE_INTEGER milliseconds.
  const resetsAt = Number.isSafeInteger(value.resetsAt) && value.resetsAt >= 0 && value.resetsAt <= 8_640_000_000_000
    ? new Date(value.resetsAt * 1000).toISOString() : null;
  return Object.freeze({ usedPercent, windowMinutes, durationStatus, resetsAt });
}

module.exports = Object.freeze({ selectCodexRateLimits, decodeCodexWindow });
