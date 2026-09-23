'use strict';

// Customer-selected lifetime and restart policy for temporary capability
// profiles. The durable capability manifest is the grant: this module only
// supplies its existing expiresAtMs lease and revokes that same record on a
// later process start. It deliberately does not create a parallel timer store.
// Feature-manifest command probes are resolved by capability-features.js; this
// policy module never receives their installation root or probe file paths and
// therefore cannot enforce probe containment at this boundary.

const ELEVATION_DURATION_ID = 'capability.elevation_duration';
const ELEVATION_SURVIVES_RESTART_ID = 'capability.elevation_survives_restart';
const RESTART_REVOCATION_REASON = 'restart-policy';
const preparedStates = new WeakSet();

class CapabilityElevationPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CapabilityElevationPolicyError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new CapabilityElevationPolicyError(code, message, details);
}

function settingsResult(dependencies = {}) {
  try {
    const loadSettings = dependencies.loadSettings || require('./settings').loadSettings;
    let options = dependencies.settingsOptions || {};
    // A controller/test may inject an exact durable store. Its settings live
    // beside that store unless it supplies a more explicit authority path.
    // Production uses getStateStore() and continues through resolveValuesPath.
    if (!dependencies.settingsOptions && dependencies.state
        && typeof dependencies.state.file === 'string'
        && dependencies.state.file !== ':memory:' && path.isAbsolute(dependencies.state.file)) {
      options = { valuesPath: path.join(path.dirname(dependencies.state.file), 'settings.json') };
    }
    return loadSettings(options);
  } catch (error) {
    fail('CAPABILITY_ELEVATION_SETTINGS_UNAVAILABLE',
      'Temporary capability settings could not be read, so no temporary capability grant can remain active.',
      { cause: error && error.code ? error.code : 'SETTINGS_READ_FAILED' });
  }
}

function resolvePolicy(dependencies = {}) {
  const resolved = settingsResult(dependencies);
  const rejected = Array.isArray(resolved && resolved.rejected) ? resolved.rejected : [];
  const relevantRejection = rejected.find(item => item && (item.id === '*'
    || item.id === ELEVATION_DURATION_ID || item.id === ELEVATION_SURVIVES_RESTART_ID));
  if (!resolved || !resolved.values || relevantRejection) {
    fail('CAPABILITY_ELEVATION_SETTINGS_UNAVAILABLE',
      'Temporary capability settings are unreadable or invalid, so no temporary capability grant can remain active.',
      { cause: relevantRejection ? relevantRejection.reason : 'SETTINGS_RESULT_INVALID' });
  }
  const minutes = resolved.values[ELEVATION_DURATION_ID];
  const survivesRestart = resolved.values[ELEVATION_SURVIVES_RESTART_ID];
  const durationMs = minutes * 60 * 1000;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0
      || !Number.isSafeInteger(durationMs) || typeof survivesRestart !== 'boolean') {
    fail('CAPABILITY_ELEVATION_SETTINGS_INVALID',
      'Temporary capability duration and restart settings must be a positive safe minute duration and a boolean.',
      { durationMinutes: minutes, survivesRestart });
  }
  return Object.freeze({ durationMs, survivesRestart, valuesPath: resolved.valuesPath || null });
}

function boundedCompileInput(input, nowMs, dependencies = {}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail('CAPABILITY_ELEVATION_CLOCK_INVALID',
      'The temporary capability clock is invalid, so the grant was refused.');
  }
  const policy = resolvePolicy(dependencies);
  const limit = nowMs + policy.durationMs;
  if (!Number.isSafeInteger(limit)) {
    fail('CAPABILITY_ELEVATION_CLOCK_INVALID',
      'The temporary capability expiry is outside the safe clock range, so the grant was refused.');
  }
  const requested = input && input.requested && typeof input.requested === 'object'
    ? { ...input.requested }
    : {};
  requested.expiresAtMs = requested.expiresAtMs === undefined
    ? limit
    : Math.min(requested.expiresAtMs, limit);
  return Object.freeze({ ...input, requested: Object.freeze(requested) });
}

function prepareState(state, dependencies = {}) {
  if (!state || (typeof state !== 'object' && typeof state !== 'function')) {
    fail('CAPABILITY_ELEVATION_STATE_UNAVAILABLE',
      'The temporary capability record holder is unavailable, so no grant can remain active.');
  }
  if (preparedStates.has(state)) return Object.freeze({ prepared: true, revoked: 0 });
  let policy;
  try {
    policy = resolvePolicy(dependencies);
  } catch (error) {
    // An unreadable policy is the OFF direction: revoke everything before
    // propagating the named read failure to the attempted grant operation.
    try { state.revokeActiveCapabilityProfiles({ reasonCode: RESTART_REVOCATION_REASON }); }
    catch (revokeError) {
      fail('CAPABILITY_ELEVATION_REVOCATION_FAILED',
        'Temporary capability settings and the revocation record could not be read, so the capability boundary is unavailable.',
        { cause: revokeError && revokeError.code ? revokeError.code : 'REVOCATION_FAILED' });
    }
    throw error;
  }
  let revoked = 0;
  if (!policy.survivesRestart) {
    let result;
    try {
      result = state.revokeActiveCapabilityProfiles({ reasonCode: RESTART_REVOCATION_REASON });
    } catch (error) {
      fail('CAPABILITY_ELEVATION_REVOCATION_FAILED',
        'The restart revocation record could not be written, so the temporary capability boundary is unavailable.',
        { cause: error && error.code ? error.code : 'REVOCATION_FAILED' });
    }
    if (!result || !Number.isSafeInteger(result.revoked) || result.revoked < 0) {
      fail('CAPABILITY_ELEVATION_REVOCATION_FAILED',
        'The restart revocation result was invalid, so the temporary capability boundary is unavailable.',
        { cause: 'REVOCATION_RESULT_INVALID' });
    }
    revoked = result.revoked;
  }
  preparedStates.add(state);
  return Object.freeze({ prepared: true, revoked });
}

module.exports = Object.freeze({
  CapabilityElevationPolicyError,
  ELEVATION_DURATION_ID,
  ELEVATION_SURVIVES_RESTART_ID,
  RESTART_REVOCATION_REASON,
  boundedCompileInput,
  prepareState,
  resolvePolicy
});
const path = require('node:path');
