'use strict';

// This module is deliberately pure: it classifies a proposed secret-purpose
// binding before a future enforcement point performs any vault operation.
// It neither opens a vault nor grants a caller a capability to do so.
const OWNER_LEGAL_IDENTITY_VAULT_KEY = 'owner_legal_identity_v1';
const OWNER_LEGAL_IDENTITY_PURPOSE = 'owner_legal_identity';
const EXPECTED_KEYS = Object.freeze(['vaultKey', 'purpose']);
const INDETERMINATE_ERROR_CODES = Object.freeze(new Set([
  'EAGAIN',
  'EBUSY',
  'EIO',
  'EMFILE',
  'ETIMEDOUT'
]));

// This is an allowlist of the *broker surfaces*, not a list of arbitrary
// callers.  The registry validates a private binding against it while it is
// constructed, then retains only the redacted access class on the public tool
// descriptor.  That keeps a later tool addition from silently acquiring this
// identity read merely by copying a key name.
const DECLARED_TOOL_ACCESS = Object.freeze(Object.assign(Object.create(null), {
  'owner_identity.profile_status': 'identity-value-presence-read',
  'owner_identity.bootstrap_from_publisher_evidence': 'identity-value-read-for-profile-bootstrap'
}));

const DENIED = Object.freeze({
  classification: 'not-owner-legal-identity',
  purposeRecognized: false
});

const RECOGNIZED = Object.freeze({
  classification: 'owner-legal-identity',
  purposeRecognized: true
});

function indeterminatePurposeError(cause) {
  const error = new Error(
    'The owner identity purpose could not be determined; this is NOT claiming the binding is absent.'
  );
  error.code = 'OWNER_IDENTITY_PURPOSE_UNDETERMINED';
  error.cause = cause;
  return error;
}

function readExactDataShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype) return null;

    const keys = Reflect.ownKeys(input);
    if (keys.length !== EXPECTED_KEYS.length
      || keys.some(key => typeof key !== 'string' || !EXPECTED_KEYS.includes(key))) {
      return null;
    }

    const values = Object.create(null);
    for (const name of EXPECTED_KEYS) {
      if (!Object.hasOwn(input, name)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set
        || descriptor.enumerable !== true) {
        return null;
      }
      values[name] = descriptor.value;
    }
    return values;
  } catch (error) {
    if (error && INDETERMINATE_ERROR_CODES.has(error.code)) {
      throw indeterminatePurposeError(error);
    }
    return null;
  }
}

function hasExactDataShape(input) {
  return readExactDataShape(input) !== null;
}

function classifyOwnerIdentityPurpose(input) {
  const values = readExactDataShape(input);
  if (!values) return DENIED;
  if (values.vaultKey !== OWNER_LEGAL_IDENTITY_VAULT_KEY || values.purpose !== OWNER_LEGAL_IDENTITY_PURPOSE) {
    return DENIED;
  }
  return RECOGNIZED;
}

function declaredToolAccess(toolName, binding) {
  const classification = classifyOwnerIdentityPurpose(binding);
  if (typeof toolName !== 'string'
    || !Object.hasOwn(DECLARED_TOOL_ACCESS, toolName)
    || !classification.purposeRecognized) {
    const error = new Error('This tool is not allowed to access the owner legal-identity vault record.');
    error.code = 'OWNER_IDENTITY_ACCESS_REFUSED';
    throw error;
  }
  const capabilityClass = DECLARED_TOOL_ACCESS[toolName];
  // Deliberately discard vaultKey/purpose here. Tool descriptors and all audit
  // details carry only this public, fixed classification.
  return Object.freeze({ accessSurface: 'owner-legal-identity', capabilityClass });
}

module.exports = Object.freeze({
  DECLARED_TOOL_ACCESS,
  OWNER_LEGAL_IDENTITY_PURPOSE,
  OWNER_LEGAL_IDENTITY_VAULT_KEY,
  classifyOwnerIdentityPurpose,
  declaredToolAccess,
  hasExactDataShape
});
