'use strict';

// Metadata only: shared by the vault adapter and the CLI's final projection.
// Never trust a message, path, command, or open-ended SECRET_* spelling here.
const LOCAL_CAUSES = Object.freeze([
  'SECRET_BACKEND_UNAVAILABLE', 'SECRET_BACKEND_LOCKED', 'SECRET_BACKEND_UNSAFE',
  'SECRET_BACKEND_IDENTITY_INVALID', 'SECRET_BACKEND_KEY_MISSING', 'SECRET_BACKEND_KEY_INVALID',
  'SECRET_VAULT_FORMAT_UNSUPPORTED', 'SECRET_VAULT_UNREADABLE', 'SECRET_VAULT_PATH_UNSAFE',
  'SECRET_VAULT_LOCK_TIMEOUT', 'SECRET_ACCESS_DENIED', 'SECRET_NOT_CONFIGURED',
  'SECRET_INPUT_INVALID', 'SECRET_MONOTONIC_CONFLICT', 'SECRET_PAYMENT_CARD_REVIEW_REQUIRED',
  'SECRET_VAULT_WRITE_FAILED', 'SECRET_VAULT_WRITE_UNCERTAIN',
  'SECRET_HELPER_UNAVAILABLE', 'SECRET_HELPER_PROTOCOL_INVALID'
]);
const causes = new Set(LOCAL_CAUSES);

function failureDetails(error) {
  try {
    const candidate = error && error.code;
    const localCause = causes.has(candidate) ? candidate : 'SECRET_HELPER_PROTOCOL_INVALID';
    const mutationOutcome = localCause !== 'SECRET_HELPER_PROTOCOL_INVALID'
      && localCause !== 'SECRET_VAULT_WRITE_UNCERTAIN' && error.mutationOutcome === 'NOT_ATTEMPTED'
      ? 'NOT_ATTEMPTED' : 'UNCERTAIN';
    return Object.freeze({ mutationOutcome, localCause });
  } catch {
    return Object.freeze({ mutationOutcome: 'UNCERTAIN', localCause: 'SECRET_HELPER_PROTOCOL_INVALID' });
  }
}

module.exports = Object.freeze({ LOCAL_CAUSES, failureDetails });
