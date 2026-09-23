'use strict';

// Q37 projection seam.  This module consumes an injected, already-redacted
// observation only; it never discovers or verifies backup material itself.

const SCHEMA_VERSION = 1;
const OBSERVATION_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'reportMode', 'observedAt', 'lastBackupAt'
]);
const OUTPUT_KEYS = Object.freeze([
  'schemaVersion', 'status', 'observedAt', 'reportedBackupAt', 'ageMs',
  'contentTrust', 'grantsAuthority', 'backupExistence'
]);
const DEFAULT_MAX_AGE_MS = 86_400_000;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function isPlainDataObject(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return false;
    return ownKeys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor
        && Object.hasOwn(descriptor, 'value')
        && descriptor.enumerable === true;
    });
  } catch {
    return false;
  }
}

function canonicalIso(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  try {
    return new Date(milliseconds).toISOString() === value ? milliseconds : null;
  } catch {
    return null;
  }
}

function unavailable(observedAt = null) {
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    status: 'unavailable',
    observedAt,
    reportedBackupAt: null,
    ageMs: null,
    contentTrust: 'untrusted',
    grantsAuthority: false,
    backupExistence: 'not-asserted'
  });
}

function projectBackupAgeStatus(observation, {
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS
} = {}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1
    || !isPlainDataObject(observation, OBSERVATION_KEYS)
    || observation.schemaVersion !== SCHEMA_VERSION
    || observation.kind !== 'backup-age-observation'
    || observation.reportMode !== 'report-only') {
    return unavailable();
  }

  const observedMs = canonicalIso(observation.observedAt);
  if (observedMs === null || observedMs > nowMs) return unavailable();
  if (observation.lastBackupAt === null) return unavailable(observation.observedAt);

  const backupMs = canonicalIso(observation.lastBackupAt);
  if (backupMs === null || backupMs > observedMs || backupMs > nowMs) {
    return unavailable(observation.observedAt);
  }

  const ageMs = nowMs - backupMs;
  if (!Number.isSafeInteger(ageMs)) return unavailable(observation.observedAt);
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    status: ageMs <= maxAgeMs ? 'fresh' : 'stale',
    observedAt: observation.observedAt,
    reportedBackupAt: observation.lastBackupAt,
    ageMs,
    contentTrust: 'untrusted',
    grantsAuthority: false,
    backupExistence: 'not-asserted'
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  OBSERVATION_KEYS,
  OUTPUT_KEYS,
  DEFAULT_MAX_AGE_MS,
  projectBackupAgeStatus
});
