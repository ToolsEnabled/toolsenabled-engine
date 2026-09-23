'use strict';

const { VcsError, VCS_ERROR_CODES } = require('../errors');
const { deepFreeze, immutableClone } = require('../m1/canonical');

const DAY_MS = 24 * 60 * 60 * 1000;

const SAFE_DEFAULTS = deepFreeze({
  identity: {
    signatureAlgorithm: 'Ed25519',
    trustMode: 'explicit',
    administrativeRecoveryPrincipalIds: ['owner'],
    keyStoreKind: 'opaque-dpapi-reference',
    issueKeys: false,
  },
  retention: {
    controlLogMs: null,
    provenanceMs: null,
    repositoryContentMs: null,
    buildEvidenceMs: 90 * DAY_MS,
    tombstoneRequired: true,
    hardDeleteEnabled: false,
  },
  recovery: {
    rpoMs: DAY_MS,
    rtoMs: 60 * 60 * 1000,
    isolatedRestoreRequired: true,
  },
  admission: {
    failClosedOnUnknown: true,
    requireVerbatimAuthoritySource: true,
    requireFreshReview: true,
  },
});

const TOP_LEVEL_KEYS = Object.freeze(Object.keys(SAFE_DEFAULTS).sort());

function fail(message, details = {}) {
  throw new VcsError(VCS_ERROR_CODES.CONTRACT_VIOLATION, message, details);
}

function exactKnownKeys(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) fail(`${field} contains unknown configuration keys`, { field, unknown: unknown.sort() });
}

function mergeSection(defaults, override, field) {
  if (override === undefined) return { ...defaults };
  exactKnownKeys(override, Object.keys(defaults), field);
  return { ...defaults, ...override };
}

function positiveIntegerOrNull(value, field) {
  if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
    fail(`${field} must be a positive integer or null`, { field });
  }
}

function createInternalVcsConfig(overrides = {}) {
  exactKnownKeys(overrides, TOP_LEVEL_KEYS, 'configuration');
  const configuration = {
    identity: mergeSection(SAFE_DEFAULTS.identity, overrides.identity, 'identity'),
    retention: mergeSection(SAFE_DEFAULTS.retention, overrides.retention, 'retention'),
    recovery: mergeSection(SAFE_DEFAULTS.recovery, overrides.recovery, 'recovery'),
    admission: mergeSection(SAFE_DEFAULTS.admission, overrides.admission, 'admission'),
  };

  if (configuration.identity.signatureAlgorithm !== 'Ed25519') {
    fail('the configured identity signature algorithm is unsupported', {
      signatureAlgorithm: configuration.identity.signatureAlgorithm,
    });
  }
  if (configuration.identity.trustMode !== 'explicit') fail('identity.trustMode must fail closed as explicit');
  if (configuration.identity.issueKeys !== false) fail('this runtime cannot issue live identity keys');
  if (!Array.isArray(configuration.identity.administrativeRecoveryPrincipalIds)
      || configuration.identity.administrativeRecoveryPrincipalIds.length === 0
      || configuration.identity.administrativeRecoveryPrincipalIds.some(value => typeof value !== 'string' || value.length === 0)) {
    fail('identity.administrativeRecoveryPrincipalIds must name at least one principal');
  }
  if (configuration.retention.hardDeleteEnabled !== false) {
    fail('hard deletion is unavailable without an owner-authorized implementation');
  }
  for (const key of ['controlLogMs', 'provenanceMs', 'repositoryContentMs', 'buildEvidenceMs']) {
    positiveIntegerOrNull(configuration.retention[key], `retention.${key}`);
  }
  for (const key of ['rpoMs', 'rtoMs']) positiveIntegerOrNull(configuration.recovery[key], `recovery.${key}`);
  if (configuration.recovery.rpoMs === null || configuration.recovery.rtoMs === null) {
    fail('recovery RPO and RTO must be bounded');
  }
  return immutableClone(configuration);
}

module.exports = Object.freeze({ DAY_MS, SAFE_DEFAULTS, createInternalVcsConfig });
