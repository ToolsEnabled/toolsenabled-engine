'use strict';

/**
 * The `tools.throughput` setting: how the capability layer trades per-call
 * ceremony for speed when many agents call tools at once.
 *
 *   fast    (default)  Tool calls from one connection are scheduled by their
 *                      effect -- reads run side by side, writes keep their
 *                      order per agent -- and every call's audit record joins a
 *                      group commit (src/lib/audit-admission.js) instead of
 *                      taking the ledger's writer lock on its own. The record
 *                      is still durable before the call answers.
 *   strict             The previous behaviour: one call at a time per
 *                      connection and one writer-lock acquisition per record.
 *
 * Owner, 2026-09-03: "security or not, this has to be worked into something
 * that keeps things secure and tracked but does not slow down a user with
 * even 1000 agents making tool calls." The default is therefore `fast`; a
 * person who wants the older one-at-a-time behaviour chooses it.
 *
 * Read on the hot path of every tool call, so the answer is memoised for a
 * few seconds. An unreadable settings file yields the default rather than a
 * refusal: throughput is not a security boundary, and the audit ledger's own
 * fail-closed rules are unchanged in either mode.
 */

const SETTING_ID = 'tools.throughput';
const MODES = Object.freeze(['fast', 'strict']);
const DEFAULT_MODE = 'fast';
const CACHE_TTL_MS = 5000;

let cached = null;
let cachedAtMs = 0;
let overrideForTests = null;

function normalize(value) {
  return MODES.includes(value) ? value : DEFAULT_MODE;
}

function readMode({ loadSettings: loadSettingsImpl, env = process.env } = {}) {
  // A process-level override lets a launcher or a test pin the mode without
  // a settings file: TOOLSENABLED_TOOLS_THROUGHPUT=strict.
  const fromEnv = env && typeof env.TOOLSENABLED_TOOLS_THROUGHPUT === 'string'
    ? env.TOOLSENABLED_TOOLS_THROUGHPUT.trim().toLowerCase() : '';
  if (MODES.includes(fromEnv)) return fromEnv;
  try {
    const settings = (loadSettingsImpl || require('./settings').loadSettings)({ ids: [SETTING_ID] });
    const values = settings && settings.values;
    return normalize(values ? values[SETTING_ID] : undefined);
  } catch {
    return DEFAULT_MODE;
  }
}

function throughputMode(options = {}) {
  if (overrideForTests !== null) return overrideForTests;
  const now = Date.now();
  if (cached !== null && now - cachedAtMs < CACHE_TTL_MS && !options.fresh) return cached;
  cached = readMode(options);
  cachedAtMs = now;
  return cached;
}

function setThroughputModeForTests(mode) {
  overrideForTests = mode === null || mode === undefined ? null : normalize(mode);
  cached = null;
  cachedAtMs = 0;
}

module.exports = Object.freeze({
  DEFAULT_MODE, MODES, SETTING_ID,
  readMode, setThroughputModeForTests, throughputMode
});
