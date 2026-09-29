'use strict';

// Compatibility entry for existing digest callers and persisted error contracts.
// All domains share the same kernel mutex implementation and class identities.
module.exports = require('../process-claim-lock');
