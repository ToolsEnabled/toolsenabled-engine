'use strict';

const { VcsError, VCS_ERROR_CODES } = require('./errors');

function unboundService(operation) {
  throw new VcsError(
    VCS_ERROR_CODES.ADAPTER_UNAVAILABLE,
    `${operation} requires a bound internal VCS system instance`,
    { operation, factory: 'createInternalVcsSystem' },
    ['Create an isolated system instance with explicit adapters'],
  );
}

module.exports = Object.freeze({ unboundService });
