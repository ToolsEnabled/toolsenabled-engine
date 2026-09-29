'use strict';

// Stdio MCP client for the separately managed Full Remote Access listener.
// The normal remote-agent proxy remains the bounded profile on port 8788.
// Secure mode is selected only through the non-exported entrypoint capability
// held by this dedicated wrapper; an environment variable cannot turn the
// ordinary stdio bridge into FRA.

const {
  RemoteAgentMcpProxy,
  createFullRemoteAccessProxy
} = require('./remote-agent-mcp-proxy');

if (require.main === module) {
  createFullRemoteAccessProxy().run();
}

module.exports = Object.freeze({ RemoteAgentMcpProxy, createFullRemoteAccessProxy });
