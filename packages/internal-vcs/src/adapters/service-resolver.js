'use strict';

const { declareAdapter } = require('./contract');

/** Resolves a configured service role/capability without hardcoded endpoints. */
module.exports = declareAdapter('ServiceResolver', {
  resolveService: { request: 'serviceRole+requiredCapabilities', result: 'resolved endpoint|VcsError' },
  discoverLimits: { request: 'resolved service identity', result: 'serverCapabilityManifest' },
});
