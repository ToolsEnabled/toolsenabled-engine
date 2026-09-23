'use strict';

// Like agent-tree-spawn, this slot is shared only by the app-owned MCP host
// and Electron main, through the installed payload's exact module path. A
// standalone worker has no slot. No editable file is admission authority.
const admission = require('./agent-resource-admission');
const monitor = require('./agent-resource-monitor');
const appHost = require('./agent-resource-host');
const channel = require('./agent-resource-channel');
let host = null;
let applicationScope = false;
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function installResourceHost(value) {
  if (!value || typeof value.status !== 'function' || typeof value.advise !== 'function') {
    fail('RESOURCE_HOST_INVALID', 'A resource host must provide status and advise.');
  }
  applicationScope = true;
  host = value;
}
function clearResourceHost() { host = null; }
function reserveApplicationLane(request, principal) {
  // An independent engine has no app-owned sampler and retains its existing
  // behavior. An app that stopped its sampler must not turn into that case.
  if (!applicationScope) return null;
  if (!host || typeof host.reserveLane !== 'function') {
    fail('AGENT_RESOURCE_UNKNOWN', 'This application resource monitor is unavailable; detached starts must wait.');
  }
  return host.reserveLane(request, principal);
}
function sessionContext(context) {
  const principal = context?.agentPrincipal;
  if (!principal || principal.kind !== 'agent-session' || !principal.sessionId || !principal.agentId
    || principal.sessionId !== context.agentSessionId || principal.agentId !== context.agentId) {
    fail('RESOURCE_CONTROLLER_REQUIRED', 'Resource advice requires an authenticated application controller session.');
  }
  return principal;
}
function resourceStatus(args, context) {
  const principal = sessionContext(context);
  if (!host) fail('RESOURCE_HOST_UNAVAILABLE', 'This process has no application resource monitor.');
  return host.status(principal);
}
function resourceAdvice(args, context) {
  const principal = sessionContext(context);
  if (!host) fail('RESOURCE_HOST_UNAVAILABLE', 'This process has no application resource monitor.');
  return host.advise(args, principal);
}
module.exports = Object.freeze({ ...admission, ...monitor, ...appHost, ...channel, installResourceHost, clearResourceHost, reserveApplicationLane, resourceStatus, resourceAdvice });
