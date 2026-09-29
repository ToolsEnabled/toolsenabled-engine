'use strict';

const { resolveSettingsValuesPath } = require('./durable-memory-file');
const { readSettingsDocument, applyStoredValues } = require('./settings-values');

const SPECS = Object.freeze({
  'tools.audit_batch_window_ms': Object.freeze({ default: 1, minimum: 0, maximum: 25 }),
  'tools.audit_batch_size': Object.freeze({ default: 512, minimum: 1, maximum: 4096 }),
  // Zero preserves the existing content-digest cache. Positive values also
  // force a helper recheck after this interval, even if the vault is unchanged.
  'tools.credential_check_interval_seconds': Object.freeze({ default: 0, minimum: 0, maximum: 300 })
});
let cached = null;
function loadPerformanceRows(valuesPath) {
  const registry = require('./settings-registry').loadRegistry();
  const requested = new Set(Object.keys(SPECS));
  const values = {}, provenance = {}, rejected = [];
  for (const id of requested) {
    const entry = registry.byId.get(id);
    if (!entry) throw new TypeError('Selected settings must be declared registry ids.');
    values[id] = entry.default;
  }
  const stored = readSettingsDocument(valuesPath, rejected);
  if (stored.valid) applyStoredValues({ registry, document: stored.document, requested, values, provenance, rejected });
  return { values };
}
function performanceSettings({ loadSettings, fresh = false, now = Date.now() } = {}) {
  // A short read cache keeps tuning the hot path from creating a new hot path.
  // It never caches credentials, authority, a vault digest or a tool decision.
  let path = null;
  try { path = resolveSettingsValuesPath({}); } catch { /* an unconfigured installation uses the shipped tuning */ }
  if (!loadSettings && !fresh && cached && cached.path === path && now - cached.at < 1000) return cached.values;
  let resolved;
  try { resolved = loadSettings ? loadSettings({ ids: Object.keys(SPECS) }) : loadPerformanceRows(path); } catch { resolved = null; }
  const values = {};
  for (const [id, spec] of Object.entries(SPECS)) {
    const value = resolved?.values?.[id];
    values[id] = Number.isSafeInteger(value) && value >= spec.minimum && value <= spec.maximum ? value : spec.default;
  }
  const answer = Object.freeze(values);
  if (!loadSettings) cached = { path, at: now, values: answer };
  return answer;
}
module.exports = Object.freeze({ SPECS, performanceSettings });
