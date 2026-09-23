'use strict';
// Installed by the desktop host, using the same private in-process seam as
// tree spawning. There is no agent-supplied endpoint or JavaScript.
let host = null;
function installAppContextHost(value) {
  if (!value || typeof value.read !== 'function') throw new TypeError('App context host must provide read.');
  host = value;
}
async function read(context = {}) {
  const principal = context.agentPrincipal;
  if (!principal || principal.kind !== 'agent-session' || !principal.sessionId) {
    throw Object.assign(new Error('Application context requires an authenticated application agent session.'), { code: 'APP_CONTEXT_SESSION_REQUIRED' });
  }
  if (!host) throw Object.assign(new Error('The application context reader is not installed in this host.'), { code: 'APP_CONTEXT_UNAVAILABLE' });
  return host.read(principal);
}
module.exports = { installAppContextHost, read };
