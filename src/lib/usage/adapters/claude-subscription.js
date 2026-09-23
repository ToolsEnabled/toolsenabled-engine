'use strict';

const {
  UNKNOWN_REASONS,
  measuredUsageRecord,
  unknownUsageRecord
} = require('../usage-contract');
const { createProviderAllowanceAdapter } = require('./provider-allowance');

// Public in @anthropic-ai/claude-agent-sdk 0.3.220, but deliberately named as
// experimental by Anthropic. Keeping the full name here makes an SDK change a
// fail-closed integration break instead of silently selecting another method.
const CLAUDE_AGENT_SDK_USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
const CLAUDE_AGENT_SDK_EVIDENCE_VERSION = '0.3.220';
const CLAUDE_CODE_EVIDENCE_VERSION = '2.1.186';
const WINDOWS = Object.freeze({
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly-opus',
  seven_day_sonnet: 'weekly-sonnet'
});

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isSafeInteger(Date.parse(value)) && Date.parse(value) >= 0;
}

function unknown(account, reason, nowMs) {
  return unknownUsageRecord({ ...account, reason, observedAt: nowMs });
}

function createClaudeAgentSdkUsageReader(query) {
  if (!query || typeof query[CLAUDE_AGENT_SDK_USAGE_METHOD] !== 'function') {
    throw new TypeError('Claude Agent SDK Query does not expose the pinned experimental usage method.');
  }
  return async function readClaudeAgentSdkUsage() {
    return query[CLAUDE_AGENT_SDK_USAGE_METHOD]();
  };
}

function responseAndObservation(reply, nowMs) {
  const fallbackObservedAt = new Date(nowMs).toISOString();
  if (plain(reply) && Object.keys(reply).length === 2
    && Object.hasOwn(reply, 'response') && Object.hasOwn(reply, 'observedAt')) {
    if (!validTimestamp(reply.observedAt)) return null;
    return Object.freeze({ response: reply.response, observedAt: new Date(reply.observedAt).toISOString() });
  }
  return Object.freeze({ response: reply, observedAt: fallbackObservedAt });
}

function validUsageResponse(value) {
  return plain(value)
    && Object.hasOwn(value, 'rate_limits_available')
    && Object.hasOwn(value, 'rate_limits')
    && typeof value.rate_limits_available === 'boolean'
    && (value.rate_limits === null || plain(value.rate_limits));
}

function validWindow(value) {
  if (!plain(value) || Object.keys(value).some(key => !['utilization', 'resets_at'].includes(key))
    || !['utilization', 'resets_at'].every(key => Object.hasOwn(value, key))) return false;
  return typeof value.utilization === 'number' && Number.isFinite(value.utilization)
    && value.utilization >= 0 && value.utilization <= 100
    && (value.resets_at === null || validTimestamp(value.resets_at));
}

function createClaudeSubscriptionAdapter({ readAllowance, readUsage, window = 'five_hour' } = {}) {
  if (!Object.hasOwn(WINDOWS, window)) throw new TypeError('Claude subscription window is invalid.');
  if (readAllowance !== undefined && readUsage !== undefined) {
    throw new TypeError('Configure either readAllowance or readUsage, not both.');
  }
  if (readUsage !== undefined && typeof readUsage !== 'function') {
    throw new TypeError('Claude subscription usage reader is invalid.');
  }
  if (readUsage === undefined) {
    return createProviderAllowanceAdapter({ id: 'claude-subscription', readAllowance });
  }

  return Object.freeze({
    id: 'claude-subscription',
    async read(account, { nowMs }) {
      let reply;
      try {
        reply = await readUsage(account);
      } catch {
        return unknown(account, UNKNOWN_REASONS.PROVIDER_SURFACE_UNAVAILABLE, nowMs);
      }

      const observation = responseAndObservation(reply, nowMs);
      if (!observation || !validUsageResponse(observation.response)) {
        return unknown(account, UNKNOWN_REASONS.PROVIDER_SURFACE_INVALID, nowMs);
      }
      if (!observation.response.rate_limits_available || observation.response.rate_limits === null) {
        return unknown(account, UNKNOWN_REASONS.PROVIDER_ALLOWANCE_NOT_MACHINE_READABLE, nowMs);
      }

      const limit = observation.response.rate_limits[window];
      if (limit === undefined || limit === null || limit.utilization === null) {
        return unknown(account, UNKNOWN_REASONS.PROVIDER_ALLOWANCE_NOT_MACHINE_READABLE, nowMs);
      }
      if (!validWindow(limit)) {
        return unknown(account, UNKNOWN_REASONS.PROVIDER_SURFACE_INVALID, nowMs);
      }

      // UsageRecord requires integers. Basis points preserve the provider's
      // percentage to 0.01 percentage point without laundering it into an
      // estimate or silently rounding it to a whole percent.
      const usedBasisPoints = Math.round(limit.utilization * 100);
      return measuredUsageRecord({
        ...account,
        used: usedBasisPoints,
        remaining: 10_000 - usedBasisPoints,
        unit: `basis-points-${WINDOWS[window]}`,
        resetsAt: limit.resets_at === null ? null : new Date(limit.resets_at).toISOString(),
        observedAt: observation.observedAt
      });
    }
  });
}

module.exports = Object.freeze({
  CLAUDE_AGENT_SDK_EVIDENCE_VERSION,
  CLAUDE_AGENT_SDK_USAGE_METHOD,
  CLAUDE_CODE_EVIDENCE_VERSION,
  createClaudeAgentSdkUsageReader,
  createClaudeSubscriptionAdapter
});
