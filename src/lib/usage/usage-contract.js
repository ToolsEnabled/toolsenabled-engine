'use strict';

// The usage reader deliberately models account allowance and local-system
// consumption as different facts.  A locally derived token total is useful,
// but it is never evidence of an account-wide remaining balance.

const SCHEMA_VERSION = 1;
const PROVENANCE = Object.freeze({
  MEASURED: 'MEASURED',
  DERIVED: 'DERIVED',
  UNKNOWN: 'UNKNOWN'
});
const FRESHNESS = Object.freeze({ FRESH: 'FRESH', STALE: 'STALE' });
const SCOPE = Object.freeze({
  ACCOUNT_ALLOWANCE: 'ACCOUNT_ALLOWANCE',
  LOCAL_SYSTEM_ONLY: 'LOCAL_SYSTEM_ONLY',
  UNKNOWN: 'UNKNOWN'
});
const UNKNOWN_REASONS = Object.freeze({
  ADAPTER_NOT_CONFIGURED: 'ADAPTER_NOT_CONFIGURED',
  ADAPTER_READ_FAILED: 'ADAPTER_READ_FAILED',
  ADAPTER_RESPONSE_INVALID: 'ADAPTER_RESPONSE_INVALID',
  PROVIDER_ALLOWANCE_NOT_MACHINE_READABLE: 'PROVIDER_ALLOWANCE_NOT_MACHINE_READABLE',
  PROVIDER_SURFACE_UNAVAILABLE: 'PROVIDER_SURFACE_UNAVAILABLE',
  PROVIDER_SURFACE_INVALID: 'PROVIDER_SURFACE_INVALID',
  AUDIT_LEDGER_UNAVAILABLE: 'AUDIT_LEDGER_UNAVAILABLE',
  AUDIT_LEDGER_INCOMPLETE: 'AUDIT_LEDGER_INCOMPLETE',
  AUDIT_LEDGER_INVALID: 'AUDIT_LEDGER_INVALID',
  LOCAL_USAGE_NOT_REPORTED: 'LOCAL_USAGE_NOT_REPORTED',
  LOCAL_USAGE_UNIT_UNAVAILABLE: 'LOCAL_USAGE_UNIT_UNAVAILABLE',
  CHURN_LEDGER_UNAVAILABLE: 'CHURN_LEDGER_UNAVAILABLE',
  CHURN_LEDGER_INCOMPLETE: 'CHURN_LEDGER_INCOMPLETE',
  CHURN_LEDGER_INVALID: 'CHURN_LEDGER_INVALID'
});

class UsageContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UsageContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new UsageContractError(code, message);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, allowed, required, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) {
    fail('USAGE_RECORD_INVALID', `${label} is invalid.`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]{1,119}$/i.test(value)) {
    fail('USAGE_RECORD_INVALID', `${label} is invalid.`);
  }
  return value;
}

function unit(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/i.test(value)) {
    fail('USAGE_RECORD_INVALID', `${label} is invalid.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('USAGE_RECORD_INVALID', `${label} is invalid.`);
  }
  return value;
}

function isoOrNull(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string') fail('USAGE_RECORD_INVALID', `${label} is invalid.`);
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || ms < 0) fail('USAGE_RECORD_INVALID', `${label} is invalid.`);
  return new Date(ms).toISOString();
}

function reasonOrNull(value, required) {
  if (!required && value === null) return null;
  if (typeof value !== 'string' || !Object.hasOwn(UNKNOWN_REASONS, value)) {
    fail('USAGE_RECORD_INVALID', 'reason is invalid.');
  }
  return value;
}

function normalizeUsageRecord(value) {
  exact(value,
    ['schemaVersion', 'accountId', 'provider', 'lane', 'used', 'remaining', 'unit', 'resetsAt', 'provenance', 'observedAt', 'reason', 'scope'],
    ['schemaVersion', 'accountId', 'provider', 'lane', 'used', 'remaining', 'unit', 'resetsAt', 'provenance', 'observedAt', 'reason', 'scope'],
    'UsageRecord');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('USAGE_VERSION_UNSUPPORTED', 'UsageRecord schema version is unsupported.');
  if (!Object.hasOwn(PROVENANCE, value.provenance) || !Object.hasOwn(SCOPE, value.scope)) {
    fail('USAGE_RECORD_INVALID', 'UsageRecord provenance or scope is invalid.');
  }

  const record = {
    schemaVersion: SCHEMA_VERSION,
    accountId: identifier(value.accountId, 'accountId'),
    provider: identifier(value.provider, 'provider'),
    lane: identifier(value.lane, 'lane'),
    used: value.used === null ? null : nonNegativeInteger(value.used, 'used'),
    remaining: value.remaining === null ? null : nonNegativeInteger(value.remaining, 'remaining'),
    unit: value.unit === null ? null : unit(value.unit, 'unit'),
    resetsAt: isoOrNull(value.resetsAt, 'resetsAt'),
    provenance: value.provenance,
    observedAt: isoOrNull(value.observedAt, 'observedAt'),
    reason: value.reason,
    scope: value.scope
  };

  if (record.observedAt === null) fail('USAGE_RECORD_INVALID', 'observedAt is required.');
  if (record.provenance === PROVENANCE.MEASURED) {
    if (record.scope !== SCOPE.ACCOUNT_ALLOWANCE || record.used === null || record.remaining === null
      || record.unit === null || record.reason !== null) {
      fail('USAGE_RECORD_INVALID', 'Measured usage must be a complete account allowance reading.');
    }
  } else if (record.provenance === PROVENANCE.DERIVED) {
    // DERIVED is intentionally narrower than an account allowance: `used` is
    // only the amount proven in this system's own audited records.  It must
    // never invent a remaining balance, reset time, or account-wide total.
    if (record.scope !== SCOPE.LOCAL_SYSTEM_ONLY || record.used === null || record.remaining !== null
      || record.unit === null || record.resetsAt !== null || record.reason !== null) {
      fail('USAGE_RECORD_INVALID', 'Derived usage must be local-system-only and must not claim remaining allowance.');
    }
  } else {
    if (record.scope !== SCOPE.UNKNOWN || record.used !== null || record.remaining !== null
      || record.unit !== null || record.resetsAt !== null) {
      fail('USAGE_RECORD_INVALID', 'Unknown usage must not carry a number or allowance metadata.');
    }
    reasonOrNull(record.reason, true);
  }
  if (record.provenance !== PROVENANCE.UNKNOWN) reasonOrNull(record.reason, false);
  return Object.freeze(record);
}

function unknownUsageRecord({ accountId, provider, lane, reason, observedAt }) {
  return normalizeUsageRecord({
    schemaVersion: SCHEMA_VERSION,
    accountId,
    provider,
    lane,
    used: null,
    remaining: null,
    unit: null,
    resetsAt: null,
    provenance: PROVENANCE.UNKNOWN,
    observedAt: new Date(observedAt).toISOString(),
    reason,
    scope: SCOPE.UNKNOWN
  });
}

function measuredUsageRecord({ accountId, provider, lane, used, remaining, unit: usageUnit, resetsAt = null, observedAt }) {
  return normalizeUsageRecord({
    schemaVersion: SCHEMA_VERSION,
    accountId,
    provider,
    lane,
    used,
    remaining,
    unit: usageUnit,
    resetsAt,
    provenance: PROVENANCE.MEASURED,
    observedAt,
    reason: null,
    scope: SCOPE.ACCOUNT_ALLOWANCE
  });
}

function derivedUsageRecord({ accountId, provider, lane, used, unit: usageUnit, observedAt }) {
  return normalizeUsageRecord({
    schemaVersion: SCHEMA_VERSION,
    accountId,
    provider,
    lane,
    used,
    remaining: null,
    unit: usageUnit,
    resetsAt: null,
    provenance: PROVENANCE.DERIVED,
    observedAt,
    reason: null,
    scope: SCOPE.LOCAL_SYSTEM_ONLY
  });
}

function applyFreshness(record, { nowMs = Date.now(), freshnessBudgetMs }) {
  const normalized = normalizeUsageRecord(record);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(freshnessBudgetMs) || freshnessBudgetMs < 0) {
    fail('USAGE_FRESHNESS_INVALID', 'Freshness inputs are invalid.');
  }
  const observedAtMs = Date.parse(normalized.observedAt);
  if (observedAtMs > nowMs) {
    fail('USAGE_FRESHNESS_INVALID', 'observedAt cannot be later than nowMs.');
  }
  const ageMs = nowMs - observedAtMs;
  return Object.freeze({
    ...normalized,
    freshness: ageMs > freshnessBudgetMs ? FRESHNESS.STALE : FRESHNESS.FRESH,
    ageMs
  });
}

module.exports = Object.freeze({
  FRESHNESS,
  PROVENANCE,
  SCHEMA_VERSION,
  SCOPE,
  UNKNOWN_REASONS,
  UsageContractError,
  applyFreshness,
  derivedUsageRecord,
  measuredUsageRecord,
  normalizeUsageRecord,
  unknownUsageRecord
});
