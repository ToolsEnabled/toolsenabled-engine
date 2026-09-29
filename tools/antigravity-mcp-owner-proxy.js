#!/usr/bin/env node
'use strict';

// A fixed official-client MCP registration; all authority comes from THIS
// process's app-issued scope. No shared credential file or latest-session
// lookup, and no anonymous broker fallback.
const SCOPE_ENV = 'TOOLSENABLED_ANTIGRAVITY_MCP_SCOPE';
function scopedEnvironment(environment = process.env) {
  const raw = environment[SCOPE_ENV];
  if (typeof raw !== 'string' || !raw || raw.length > 262_144) throw new Error('Missing Antigravity app session scope');
  const scope = JSON.parse(raw);
  if (!scope || scope.version !== 1 || Object.keys(scope).sort().join(',') !== 'environment,version'
    || !scope.environment || Object.getPrototypeOf(scope.environment) !== Object.prototype) throw new Error('Invalid Antigravity app session scope');
  const bound = scope.environment;
  for (const [name, value] of Object.entries(bound)) {
    if (!/^(?:TOOLSENABLED_[A-Z0-9_]+|ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/.test(name)
      || name === SCOPE_ENV || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid Antigravity scope field');
  }
  const proxy = require('./mcp-owner-proxy');
  if (bound.TOOLSENABLED_AGENT_ACTOR !== 'gemini' || !proxy.agentIdentity(bound)) throw new Error('Missing Gemini agent identity');
  proxy.agentSessionCredential(bound);
  if (typeof bound.TOOLSENABLED_STATE_ROOT !== 'string' || !require('node:path').isAbsolute(bound.TOOLSENABLED_STATE_ROOT)) throw new Error('Missing app state scope');
  return { ...environment, ...bound };
}

function main(environment = process.env) {
  try {
    const bound = scopedEnvironment(environment);
    // The existing runtime-state module reads process.env. Set the generated
    // scope before opening its owner-host capability, then use its existing
    // peer check, session credential handshake and revocation lifecycle.
    for (const [name, value] of Object.entries(bound)) process.env[name] = value;
    return require('./mcp-owner-proxy').main(bound);
  } catch {
    process.stderr.write('Antigravity tools require a current ToolsEnabled app session.\n');
    process.exitCode = 1;
    return null;
  }
}
if (require.main === module) main();
module.exports = { SCOPE_ENV, scopedEnvironment, main };
