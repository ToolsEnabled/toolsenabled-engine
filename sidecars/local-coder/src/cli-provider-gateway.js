'use strict';

// Compatibility entry point for the local sidecar. The canonical
// subscription-CLI gateway is global-safe broker code because the MCP control
// plane and the local UI must share one implementation and one state file.
module.exports = require('../../../src/lib/providers/cli-provider-gateway');
