'use strict';

const {
  UNKNOWN_REASONS,
  measuredUsageRecord,
  unknownUsageRecord
} = require('../usage-contract');
const { selectCodexRateLimits, decodeCodexWindow } = require('../codex-rate-limits');

// `codex app-server` is experimental. Verified locally with `codex --version`
// on 2026-08-03; a different CLI is a different, unverified protocol.
const CODEX_APP_SERVER_CLI_VERSION = 'codex-cli 0.146.0';

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, allowed, required) {
  return plain(value) && !Object.keys(value).some(key => !allowed.includes(key))
    && required.every(key => Object.hasOwn(value, key));
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isSafeInteger(Date.parse(value)) && Date.parse(value) >= 0;
}

function unknown(account, reason, nowMs) {
  return unknownUsageRecord({ ...account, reason, observedAt: nowMs });
}

// The usage adapter deliberately owns no child process. The injected transport
// must use the same executable to obtain `cliVersion` and to speak newline-
// delimited JSON-RPC over its stdio. Its request method receives the complete
// JSON-RPC request and returns either the result directly, a JSON-RPC result
// envelope, or { result, observedAt }. The final form retains an exact receipt
// time when a caller is replaying a captured reading.
function validTransport(transport) {
  return plain(transport) && typeof transport.cliVersion === 'string' && typeof transport.request === 'function';
}

function responseAndObservation(reply, nowMs) {
  const fallbackObservedAt = new Date(nowMs).toISOString();
  if (exact(reply, ['result', 'observedAt'], ['result', 'observedAt'])) {
    if (!validTimestamp(reply.observedAt)) return null;
    return Object.freeze({ result: reply.result, observedAt: new Date(reply.observedAt).toISOString() });
  }
  if (exact(reply, ['jsonrpc', 'id', 'result'], ['jsonrpc', 'id', 'result'])
    && reply.jsonrpc === '2.0' && (typeof reply.id === 'number' || typeof reply.id === 'string')) {
    return Object.freeze({ result: reply.result, observedAt: fallbackObservedAt });
  }
  return Object.freeze({ result: reply, observedAt: fallbackObservedAt });
}

function successfulInitializeReply(reply) {
  // Transports may resolve, rather than reject, a JSON-RPC error response.
  // Such a response means initialization was not established and must not be
  // collapsed into permission to read and publish a measured allowance.
  if (plain(reply) && Object.hasOwn(reply, 'error')) return false;
  if (plain(reply) && (Object.hasOwn(reply, 'jsonrpc') || Object.hasOwn(reply, 'id'))) {
    return exact(reply, ['jsonrpc', 'id', 'result'], ['jsonrpc', 'id', 'result'])
      && reply.jsonrpc === '2.0'
      && (typeof reply.id === 'number' || typeof reply.id === 'string');
  }
  return exact(reply, ['result', 'observedAt'], ['result', 'observedAt'])
    ? validTimestamp(reply.observedAt)
    : reply !== undefined;
}

function validWindow(value) {
  if (!exact(value, ['usedPercent', 'windowDurationMins', 'windowMinutes', 'resetsAt'], ['usedPercent', 'resetsAt'])) return false;
  const decoded = decodeCodexWindow(value);
  return decoded !== null && Number.isSafeInteger(decoded.usedPercent)
    && decoded.durationStatus === 'valid' && decoded.resetsAt !== null;
}

function validRateLimits(result) {
  if (!exact(result,
    ['limitId', 'limitName', 'primary', 'secondary', 'credits', 'individualLimit', 'spendControlReached', 'planType', 'rateLimitReachedType'],
    ['limitId', 'limitName', 'primary', 'secondary', 'credits', 'individualLimit', 'spendControlReached', 'planType', 'rateLimitReachedType'])) {
    return false;
  }
  return result.limitId === 'codex'
    && (result.limitName === null || typeof result.limitName === 'string')
    && validWindow(result.primary)
    // One UsageRecord can represent only one allowance window. Do not discard
    // a newly populated secondary window without extending that contract.
    && result.secondary === null
    && exact(result.credits, ['hasCredits', 'unlimited', 'balance'], ['hasCredits', 'unlimited', 'balance'])
    && typeof result.credits.hasCredits === 'boolean'
    && typeof result.credits.unlimited === 'boolean'
    && typeof result.credits.balance === 'string'
    && result.individualLimit === null
    && typeof result.spendControlReached === 'boolean'
    && typeof result.planType === 'string'
    && (result.rateLimitReachedType === null || typeof result.rateLimitReachedType === 'string');
}

function windowLabel(windowDurationMins) {
  if (windowDurationMins === 7 * 24 * 60) return 'weekly';
  if (windowDurationMins === 24 * 60) return 'daily';
  if (windowDurationMins % 60 === 0) return `${windowDurationMins / 60}-hour`;
  return `${windowDurationMins}-minute`;
}

function createCodexChatgptAdapter({ transport } = {}) {
  if (transport !== undefined && !validTransport(transport)) {
    throw new TypeError('Codex app-server transport is invalid.');
  }

  let nextRequestId = 1;
  function request(method, params) {
    return Object.freeze({ jsonrpc: '2.0', id: nextRequestId++, method, params });
  }

  return Object.freeze({
    id: 'codex-chatgpt',
    async read(account, { nowMs }) {
      if (!transport) return unknown(account, UNKNOWN_REASONS.PROVIDER_SURFACE_UNAVAILABLE, nowMs);
      // The pin is checked before I/O so a new experimental CLI cannot produce
      // a plausible but unverified account figure.
      if (transport.cliVersion !== CODEX_APP_SERVER_CLI_VERSION) {
        return unknown(account, UNKNOWN_REASONS.PROVIDER_SURFACE_INVALID, nowMs);
      }

      let reply;
      try {
        const initializeReply = await transport.request(request('initialize', {}));
        if (!successfulInitializeReply(initializeReply)) {
          return unknown(account, UNKNOWN_REASONS.PROVIDER_SURFACE_INVALID, nowMs);
        }
        reply = await transport.request(request('account/rateLimits/read', {}));
      } catch {
        return unknown(account, UNKNOWN_REASONS.PROVIDER_SURFACE_UNAVAILABLE, nowMs);
      }

      const observation = responseAndObservation(reply, nowMs);
      const rateLimits = observation ? selectCodexRateLimits(observation.result) : null;
      if (!observation || !validRateLimits(rateLimits)) {
        return unknown(account, UNKNOWN_REASONS.PROVIDER_SURFACE_INVALID, nowMs);
      }

      const primary = decodeCodexWindow(rateLimits.primary);
      return measuredUsageRecord({
        ...account,
        used: primary.usedPercent,
        remaining: 100 - primary.usedPercent,
        unit: `percent-${windowLabel(primary.windowMinutes)}`,
        resetsAt: primary.resetsAt,
        observedAt: observation.observedAt
      });
    }
  });
}

module.exports = Object.freeze({ CODEX_APP_SERVER_CLI_VERSION, createCodexChatgptAdapter });
