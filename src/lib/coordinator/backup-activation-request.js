'use strict';

// Q37's production boundary starts with a request, not an executor.  This
// module validates a deliberately non-authorizing activation *proposal* that
// the coordinator-duty host can name in its report.  It cannot read a request
// from disk, resolve a backup root, inspect a vault, or turn a proposal into
// permission.  A later activation phase must provide an independently
// verified owner approval and a fixed-root executor as separate capabilities.

const SCHEMA_VERSION = 1;
const KIND = 'recurring-backup-activation-request';
const ROOT_BINDING = 'toolsenabled-backup-root-v1';
const INSPECTION_UNAVAILABLE = 'ACTIVATION_REQUEST_INSPECTION_UNAVAILABLE';
const ARTIFACT_KINDS = Object.freeze([
  'git-bundle', 'vault-state-copy', 'manifest-sha256', 'retention-prune'
]);
const INPUT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'requestId', 'rootBinding', 'requestedAt',
  'artifactKinds', 'retentionMaxSnapshots', 'schedulerRegistrationRequested',
  'ownerApproval'
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function isExactDataObject(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { exact: false };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { exact: false };
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return { exact: false };
    return { exact: ownKeys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
    }) };
  } catch {
    return { exact: null };
  }
}

function isCanonicalIso(value) {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sameStrings(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function unavailable(errors) {
  return deepFreeze({
    valid: false,
    errors: Object.freeze(errors.slice()),
    request: null,
    executionAuthorized: false,
    ownerApprovalRequired: true,
    schedulerRegistrationAuthorized: false,
    retentionDeletionAuthorized: false
  });
}

function inspectionUnavailable() {
  return deepFreeze({
    valid: null,
    code: INSPECTION_UNAVAILABLE,
    errors: Object.freeze(['activation request could not be inspected; this is NOT claiming the request is absent or invalid']),
    request: null,
    executionAuthorized: false,
    ownerApprovalRequired: true,
    schedulerRegistrationAuthorized: false,
    retentionDeletionAuthorized: false
  });
}

// The only accepted approval state is intentionally *not approved*.  This
// makes this type safe to serialize, test, and report before a future owner
// approval verifier exists.  A string such as "approved" is rejected rather
// than becoming a dangerous boolean that a future caller could misread.
function validatePendingActivationRequest(input) {
  const errors = [];
  const inspection = isExactDataObject(input, INPUT_KEYS);
  if (inspection.exact === null) return inspectionUnavailable();
  if (!inspection.exact) return unavailable(['activation request must use the exact pending-request schema']);
  if (input.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (input.kind !== KIND) errors.push(`kind must be ${KIND}`);
  if (typeof input.requestId !== 'string' || !/^[a-z0-9][a-z0-9-]{7,79}$/.test(input.requestId)) errors.push('requestId must be a bounded opaque id');
  if (input.rootBinding !== ROOT_BINDING) errors.push('rootBinding is not the fixed approved backup root binding');
  if (!isCanonicalIso(input.requestedAt)) errors.push('requestedAt must be a canonical UTC ISO timestamp');
  if (!sameStrings(input.artifactKinds, ARTIFACT_KINDS)) errors.push('artifactKinds must be the exact canonical list');
  if (!Number.isSafeInteger(input.retentionMaxSnapshots) || input.retentionMaxSnapshots < 1 || input.retentionMaxSnapshots > 90) {
    errors.push('retentionMaxSnapshots must be a safe integer from 1 through 90');
  }
  if (input.schedulerRegistrationRequested !== false) errors.push('schedulerRegistrationRequested must be false before a separate scheduler phase');
  if (input.ownerApproval !== 'not-approved') errors.push('ownerApproval must be not-approved; this module cannot verify an approval');
  if (errors.length > 0) return unavailable(errors);

  return deepFreeze({
    valid: true,
    errors: Object.freeze([]),
    request: Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      kind: KIND,
      requestId: input.requestId,
      rootBinding: ROOT_BINDING,
      requestedAt: input.requestedAt,
      artifactKinds: Object.freeze([...ARTIFACT_KINDS]),
      retentionMaxSnapshots: input.retentionMaxSnapshots,
      ownerApproval: 'not-approved'
    }),
    executionAuthorized: false,
    ownerApprovalRequired: true,
    schedulerRegistrationAuthorized: false,
    retentionDeletionAuthorized: false
  });
}

function activationContractSummary() {
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    requestState: 'not-present',
    executionAuthorized: false,
    ownerApprovalRequired: true,
    schedulerRegistrationAuthorized: false,
    retentionDeletionAuthorized: false
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  KIND,
  ROOT_BINDING,
  INSPECTION_UNAVAILABLE,
  ARTIFACT_KINDS,
  INPUT_KEYS,
  validatePendingActivationRequest,
  activationContractSummary,
  unavailable
});
