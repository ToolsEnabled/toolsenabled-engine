'use strict';

// This module is intentionally pure: both the bounded MCP completion adapter
// and the future deep-research sidecar can import the exact same ladder without
// inheriting vault, provider, or process-launching capabilities.

const GiB = 1024 ** 3;
const MODEL_ROLES = Object.freeze({
  slowBatch: Object.freeze({ tier: 'slow-batch', model: 'gpt-oss:20b' }),
  highCapacity: Object.freeze({ tier: 'high-capacity', model: 'qwen3.5:9b' }),
  workhorse: Object.freeze({ tier: 'workhorse', model: 'qwen3.5:4b' })
});

function names(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(value
    .filter(entry => typeof entry === 'string' && entry.length <= 200)
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean));
}

function bytes(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function unavailable(reason) {
  return Object.freeze({ available: false, code: 'MODEL_UNAVAILABLE', reason });
}

/**
 * Pick an installed, fully local model from resource probe data. The return
 * uses role names rather than tier numbers so the shared policy remains stable
 * if a future measurement phase collapses or retunes the ladder.
 */
function pickModel(probe = {}, options = {}) {
  const source = probe && typeof probe === 'object' && !Array.isArray(probe) ? probe : {};
  const request = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  if (source.ollamaReachable !== true) return unavailable('ollama_unreachable');

  const installed = names(source.installedModels);
  const resident = names(source.residentModels);
  const freeRamBytes = bytes(source.freeRamBytes);
  const freeVramBytes = bytes(source.freeVramBytes);
  // Keep an unmeasured battery state distinct from a measured AC state. Larger
  // roles are AC-only, so an absent or malformed probe value must not enable
  // them by being collapsed to false.
  const onBattery = typeof source.onBattery === 'boolean' ? source.onBattery : null;
  const has = role => installed.has(role.model);
  const sameResident = role => resident.has(role.model);
  const anotherResident = role => Array.from(resident).some(model => model !== role.model);

  // The slowest model is opt-in, batch-only, AC-only, and must not force a
  // second resident model into memory just because it happened to be installed.
  if (request.allowSlowTier === true && request.batch === true && onBattery === false
    && has(MODEL_ROLES.slowBatch)
    && ((sameResident(MODEL_ROLES.slowBatch)
      && freeRamBytes >= 12 * GiB && freeVramBytes >= 2 * GiB)
      || (freeRamBytes >= 24 * GiB && freeVramBytes >= 7 * GiB))
    && !anotherResident(MODEL_ROLES.slowBatch)) {
    return { available: true, ...MODEL_ROLES.slowBatch };
  }

  // Battery is a hard cap at the workhorse role. The 9B context limit is
  // enforced by the caller's Ollama options, while this module owns only the
  // resource decision.
  if (onBattery === false && has(MODEL_ROLES.highCapacity)
    && (sameResident(MODEL_ROLES.highCapacity) || freeVramBytes >= 7 * GiB)) {
    return { available: true, ...MODEL_ROLES.highCapacity };
  }

  if (has(MODEL_ROLES.workhorse)
    && (sameResident(MODEL_ROLES.workhorse) || freeVramBytes >= 4.2 * GiB)) {
    return { available: true, ...MODEL_ROLES.workhorse };
  }

  return unavailable(onBattery === null ? 'battery_status_unknown' : 'no_eligible_local_model');
}

// A deliberately narrower policy for latency-sensitive, structured local work.
// It reuses the existing workhorse headroom threshold, but never promotes a
// quick operation to the 9B or slow batch model merely because those happen to
// be installed.  The caller never supplies a model id.
function pickFastModel(probe = {}) {
  const source = probe && typeof probe === 'object' && !Array.isArray(probe) ? probe : {};
  if (source.ollamaReachable !== true) return unavailable('ollama_unreachable');

  const installed = names(source.installedModels);
  const resident = names(source.residentModels);
  const freeVramBytes = bytes(source.freeVramBytes);
  const role = MODEL_ROLES.workhorse;
  if (installed.has(role.model) && (resident.has(role.model) || freeVramBytes >= 4.2 * GiB)) {
    return { available: true, ...role };
  }
  return unavailable('no_eligible_fast_local_model');
}

module.exports = { GiB, MODEL_ROLES, pickFastModel, pickModel };
