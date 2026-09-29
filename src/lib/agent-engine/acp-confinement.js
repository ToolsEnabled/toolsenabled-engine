'use strict';

// Provider configuration only: credentials stay in the selected official CLI
// home. Research supplies its own generated MCP servers and no native tools.
const path = require('node:path');

function prepareAcpSurface({ provider, directory, configDir, entries, servers, env, account, agentApiMode, writeAtomic }) {
  if (!['gemini', 'grok'].includes(provider) || agentApiMode !== 'Only') {
    const error = new Error('Gemini and Grok Research sessions require ToolsEnabled tools only.');
    error.code = 'AGENT_ACP_REQUIRES_APP_TOOLS';
    throw error;
  }
  const mcpServers = entries.map(([name, entry]) => ({
    name, command: entry.command, args: entry.args || [],
    env: Object.entries(entry.env || {}).map(([name, value]) => ({ name, value: String(value) }))
  }));
  let args;
  let providerEnv;
  if (provider === 'gemini') {
    const settings = path.join(directory, 'gemini-settings.json');
    writeAtomic(settings, JSON.stringify({
      tools: { core: [], discoveryCommand: '', callCommand: '' },
      mcp: { allowed: servers, serverCommand: '' },
      mcpServers: Object.fromEntries(entries.map(([name, entry]) => [name, { ...entry, trust: true }])),
      hooksConfig: { enabled: false },
      skills: { enabled: false },
      experimental: { enableAgents: false },
      security: { auth: { selectedType: 'oauth-personal', enforcedType: 'oauth-personal', useExternal: true } },
      telemetry: { enabled: false }
    }, null, 2) + '\n');
    args = ['--acp', '--extensions', 'none', '--approval-mode', 'default'];
    providerEnv = { GEMINI_CLI_HOME: configDir, GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings };
  } else {
    const profile = path.join(directory, 'grok-agent.md');
    writeAtomic(profile, '---\n' + JSON.stringify({
      name: 'toolsenabled-research', description: 'Research with ToolsEnabled-controlled tools',
      agentsMd: false, discoverSkills: false, injectDefaultTools: false,
      // An exact tool configuration fails if either registry ID disappears.
      // Grok's friendly `tools` name allowlist can fail open on unknown names.
      toolConfig: { tools: [{ id: 'GrokBuild:search_tool' }, { id: 'GrokBuild:use_tool' }] },
      permissionMode: 'bypassPermissions'
    }, null, 2) + '\n---\nUse the supplied ToolsEnabled tools for this Research tree.\n');
    args = ['agent', '--no-leader', '--agent-profile', profile, 'stdio'];
    // No native filesystem/shell tools exist in this exact profile. Authority
    // resides in the generated MCP server, as in Claude's --tools '' path.
    providerEnv = { GROK_HOME: configDir, GROK_SANDBOX: 'off', GROK_SUBAGENTS: '0', GROK_MEMORY: '0',
      GROK_CAMPAIGNS: '0', GROK_MCP_AUTO_RESTART: '0', GROK_MCP_RECURSIVE_CONFIG_WATCH: '0',
      GROK_CURSOR_MCPS_ENABLED: '0', GROK_CURSOR_HOOKS_ENABLED: '0',
      GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CLAUDE_HOOKS_ENABLED: '0' };
  }
  return Object.freeze({ configDir, servers: Object.freeze(servers), account,
    env: Object.freeze({ ...env, ...providerEnv }),
    acp: Object.freeze({ provider, cwd: directory, args: Object.freeze(args), mcpServers: Object.freeze(provider === 'gemini' ? [] : mcpServers) })
  });
}

// Grok currently merges ambient MCP/hooks into ACP sessions, with no strict-MCP
// argument. Read-only introspection must prove that there are none before start.
// Unknown shapes fail closed; never discard or overwrite the user's extensions.
function assertGrokInspection(output) {
  let value;
  try { value = JSON.parse(output); } catch { value = null; }
  if (!value || ['hooks', 'plugins', 'mcpServers', 'lspServers'].some(key =>
    !Array.isArray(value[key]) || value[key].length !== 0)) {
    const error = new Error('Grok has extra tools or startup extensions outside Research. Use a separate signed-in Grok account without those extensions.');
    error.code = 'AGENT_ACP_AMBIENT_TOOLS';
    throw error;
  }
}

module.exports = { prepareAcpSurface, assertGrokInspection };
