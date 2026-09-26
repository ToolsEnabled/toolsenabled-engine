'use strict';

class SecretStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SecretStoreError';
    this.code = code;
    if (details && typeof details.name === 'string') this.secretName = details.name;
    if (Array.isArray(details.names)) this.secretNames = Object.freeze([...details.names]);
  }
}

function failure(code, message, details) {
  return new SecretStoreError(code, message, details);
}

module.exports = { SecretStoreError, failure };
