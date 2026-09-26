'use strict';

// Compatibility names for the legacy ACP wrapper. The shipped official Claude
// engine uses claude-cli-adapter; Gemini and Grok share the provider-neutral ACP core.
const acp = require('./acp-adapter');
module.exports = {
  ...acp,
  ClaudeAdapter: acp.AcpAdapter,
  ClaudeAdapterError: acp.AcpAdapterError,
  createClaudeAdapter: acp.createAcpAdapter
};
