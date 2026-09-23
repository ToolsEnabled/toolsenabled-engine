'use strict';

// Bounded, metadata-only observation of the durable coordinator channel.
//
// Coordinator liveness evidence must survive a controller handoff without
// copying either agent's private context into an owner-facing surface.
// `agent-coord` is already the role-independent coordination transport. This
// module reads only entry metadata: it never returns, formats, parses, or uses
// a memory entry's `value` or `note`.

const { getStateStore } = require('./state-store');

const NAMESPACE = 'agent-coord';
const QUERY = 'controller/';
const SEARCH_LIMIT = 20;

function isQualifyingEntry(entry) {
  // The long-lived controller activity records use controller/<agent>-wave-*
  // and controller/coordinator-status.  Do not treat directives, reviews, or
  // arbitrary namespace content as activity evidence.
  return Boolean(entry)
    && entry.namespace === NAMESPACE
    && typeof entry.key === 'string'
    && (/^controller\/coordinator-status$/i.test(entry.key)
      || /^controller\/[a-z0-9._-]*-wave-[a-z0-9._-]+$/i.test(entry.key))
    && Number.isSafeInteger(entry.updatedAtMs);
}

function unavailable() {
  return Object.freeze({ state: 'unobserved', lastUpdatedAgeMs: null });
}

function defaultSearch(input) {
  return { entries: getStateStore().searchMemory(input) };
}

/**
 * Observe coordinator activity without exposing coordinator memory contents.
 * `search` is injected by tests; production uses the same bounded memory
 * state store already used by the MCP coordination channel.
 */
function observe({ nowMs, maxAgeMs, required = true } = {}, dependencies = {}) {
  if (!required) return Object.freeze({ state: 'not-required', lastUpdatedAgeMs: null });
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) return unavailable();

  let result;
  try {
    const search = dependencies.search || defaultSearch;
    result = search({ namespace: NAMESPACE, query: QUERY, limit: SEARCH_LIMIT }, dependencies.memoryDependencies || {});
  } catch {
    return unavailable();
  }

  const entries = result && Array.isArray(result.entries) ? result.entries : null;
  if (!entries) return unavailable();
  const candidates = entries.filter(isQualifyingEntry)
    // Future-dated metadata is not liveness evidence: a bad clock must never
    // turn a silent coordinator into a healthy one.
    .filter(entry => entry.updatedAtMs <= nowMs);
  if (candidates.length === 0) {
    // A full bounded result does not prove that no qualifying entry exists:
    // unrelated or future-dated records may have crowded it out.  Preserve
    // that uncertainty instead of reporting a definite silent coordinator.
    if (entries.length >= SEARCH_LIMIT) return unavailable();
    return Object.freeze({ state: 'silent', lastUpdatedAgeMs: null });
  }

  const latest = candidates.reduce((winner, entry) => entry.updatedAtMs > winner.updatedAtMs ? entry : winner);
  const ageMs = nowMs - latest.updatedAtMs;
  return Object.freeze({
    state: ageMs <= maxAgeMs ? 'recent' : 'silent',
    lastUpdatedAgeMs: ageMs
  });
}

module.exports = Object.freeze({ NAMESPACE, QUERY, SEARCH_LIMIT, isQualifyingEntry, observe });
