#!/usr/bin/env node
'use strict';

// The acceptance probe, and the only honest way this system can answer "what
// tool set does the spawned agent ACTUALLY have?".
//
// The agent runs this through its own mcp__toolsenabled__host_exec tool.
// host.exec (src/lib/providers/host-control.js) calls execFile WITHOUT an env
// option, so the shell it starts is a child of the MCP server the agent is
// talking to and inherits that server's environment verbatim -- including or
// excluding TOOLSENABLED_TOOL_ALLOWLIST. listTools() reads that variable at
// call time, so the numbers below are the profile the AGENT is bound to, not
// the profile of whoever launched the probe.
//
// That makes the reported tool names and count a discriminator for the local
// installation: an unrestricted local profile includes host.exec; a remote or
// FRA allowlist does not; an unreachable probe means the gateway refused the
// invocation. Counts are intentionally not pinned because the shipped registry
// evolves independently of this diagnostic.
// And because host.exec is the tool that carries this probe, a run that
// reports anything at all has already proven host.exec is present and usable.

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function main() {
  const registry = require(path.join(ROOT, 'src', 'lib', 'tool-registry.js'));
  const tools = registry.listTools();
  const names = tools.map(tool => tool.name);
  const allowlist = process.env[registry.TOOL_ALLOWLIST_ENV];
  const allowlistPresent = typeof allowlist === 'string' && allowlist.trim() !== '';
  let profile = 'unknown';
  if (!allowlistPresent && names.includes('host.exec')) profile = 'full-local';
  else if (allowlistPresent && !names.includes('host.exec')) profile = 'restricted-allowlist';
  else if (allowlistPresent) profile = 'allowlist-with-host-exec';
  // Never print the allowlist body: it is a profile selector, not a secret, but
  // it is also long and this line is copied into logs and task results.
  process.stdout.write(`${JSON.stringify({
    schema: 'native-agent.local-profile-probe.v1',
    toolCount: names.length,
    hostExecPresent: names.includes('host.exec'),
    allowlistPresent,
    profile,
    root: ROOT,
    secretValuesEmitted: false
  })}\n`);
}

try {
  main();
} catch (error) {
  const code = String((error && error.code) || 'LOCAL_PROFILE_PROBE_FAILED').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100);
  process.stdout.write(`${JSON.stringify({
    schema: 'native-agent.local-profile-probe.v1',
    ok: false, code, toolCount: null, hostExecPresent: null, secretValuesEmitted: false
  })}\n`);
  process.exitCode = 1;
}
