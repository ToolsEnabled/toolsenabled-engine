'use strict';
// Trusted desktop host only. Roles select these ordinary registry functions;
// neither model arguments nor an MCP client can enable or confirm delegation.
let host = null;
function installAccessibilityHost(value) {
  if (!value || ['status', 'inspect', 'propose', 'navigate'].some(key => typeof value[key] !== 'function')) {
    throw new TypeError('Accessibility host is incomplete.');
  }
  host = value;
}
async function call(method, args, context = {}) {
  const principal = context.agentPrincipal;
  if (principal?.kind !== 'agent-session' || !principal.sessionId) {
    throw Object.assign(new Error('An authenticated local application agent is required.'), { code: 'ACCESSIBILITY_SESSION_REQUIRED' });
  }
  if (!host) throw Object.assign(new Error('Accessibility is unavailable in this host.'), { code: 'ACCESSIBILITY_HOST_UNAVAILABLE' });
  if (typeof host[method] !== 'function') throw Object.assign(new Error('This application build does not provide screen takeover.'), { code: 'SCREEN_HOST_UNAVAILABLE' });
  return host[method](principal, args);
}
module.exports = { installAccessibilityHost,
  screenStatus: (args, context) => call('screenStatus', args, context),
  screenControl: (args, context) => call('screenControl', args, context),
  status: (args, context) => call('status', args, context),
  inspect: (args, context) => call('inspect', args, context),
  propose: (args, context) => call('propose', args, context),
  navigate: (args, context) => call('navigate', args, context),
};
