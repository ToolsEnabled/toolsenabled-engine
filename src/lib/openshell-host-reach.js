'use strict';

// OpenShell binds a host grant's placeholder to an endpoint, not a program.
// A second rule on that endpoint can give the grant to another executable.
// Reserve all gateway-host endpoints for policy the person writes outside the
// sandbox. This also covers custom ports and broad paths without ever reading
// agent configuration, which can contain sign-in credentials.

const HOST_NAME = 'host.openshell.internal';
const MCP_PATH_PREFIX = '/mcp';
const DEFAULT_HOST_PORT = 18795;
const REFUSAL_CODE = 'OPENSHELL_PROPOSAL_REACHES_HOST';

function normalHost(host) {
  return typeof host === 'string' ? host.trim().toLowerCase().replace(/\.$/, '') : '';
}

// OpenShell host patterns: `*` inside one label, `**` only as the whole
// first label (schema.mdx, Destination Fields).
function hostPatternMatches(pattern, name = HOST_NAME) {
  const host = normalHost(pattern);
  if (!host) return false;
  if (!host.includes('*')) return host === name;
  if (host.startsWith('**.') && hostPatternMatches(host.slice(3), name)) return true;
  const labels = host.split('.');
  const parts = labels.map((label, index) => {
    if (label === '**' && index === 0) return '(?:[^.]+\\.)*[^.]+';
    return label.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*');
  });
  return new RegExp(`^${parts.join('\\.')}$`).test(name);
}

function endpointReachesHost(endpoint) {
  if (!endpoint || typeof endpoint !== 'object') return null;
  return ['host.openshell.internal', 'localhost', '127.0.0.1', '[::1]', '::1']
    .some(name => hostPatternMatches(endpoint.host, name)) ? Object.freeze({ host: endpoint.host }) : null;
}

function ruleReachesHost(rule) {
  return Boolean(rule && Array.isArray(rule.endpoints) && rule.endpoints.some(endpointReachesHost));
}

function guardedHostPorts() { return Object.freeze([DEFAULT_HOST_PORT]); }

/** The refusal an agent reads when a drafted rule would reach the host. */
function proposalRefusal({ host, port, path: requestPath, binary }) {
  const where = `${host}:${port}${requestPath || ''}`;
  const error = new Error(
    `No rule is drafted or proposed for ${where}: that is the ToolsEnabled host outside this sandbox. `
    + `A rule there would let ${binary || 'another program'} use an agent CLI's grant on the host, so only the person `
    + 'writes rules for it, from outside the sandbox with `toolsenabled-authority policy`. Do not propose it another way; '
    + 'carry on without this access, or tell the person what the work needs.'
  );
  error.code = REFUSAL_CODE;
  return error;
}

module.exports = Object.freeze({
  DEFAULT_HOST_PORT, HOST_NAME, MCP_PATH_PREFIX, REFUSAL_CODE,
  endpointReachesHost, guardedHostPorts, hostPatternMatches, proposalRefusal, ruleReachesHost
});
