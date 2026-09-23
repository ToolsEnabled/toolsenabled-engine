'use strict';

const AGENT_API_SETTING_ID = 'agent.agent_api';
const AGENT_API_MODES = Object.freeze(['Only', 'Optimized', 'Enabled', 'Disabled']);
const TOOL_MODE_SETTING_ID = 'agent.tool_mode';
const TOOL_MODES = Object.freeze({
  Only: 'ToolsEnabled only',
  Optimized: 'ToolsEnabled and selected native tools',
  Enabled: 'ToolsEnabled and native tools',
  Disabled: 'Native tools only'
});

// The former switch restricted native tools when true; false allowed both.
// Read old installations without rewriting their settings or provenance.
function normalizeAgentApiMode(value) {
  if (value === true) return 'Only';
  if (value === false) return 'Enabled';
  return AGENT_API_MODES.includes(value) ? value : null;
}

function agentApiModeFromToolMode(value) {
  return AGENT_API_MODES.find(mode => TOOL_MODES[mode] === value) || null;
}

// Pure normalization, shared by the existing human/installer and app writers.
// No persistence or authority is granted by these helpers.
function normalizeSettingChange(id, value) {
  if (id !== AGENT_API_SETTING_ID && id !== TOOL_MODE_SETTING_ID) return { id, value };
  const mode = id === TOOL_MODE_SETTING_ID ? agentApiModeFromToolMode(value) : normalizeAgentApiMode(value);
  if (!mode) throw Object.assign(new Error('Choose Only, Optimized, Enabled, or Disabled for the available tool sets.'), { code: 'AGENT_API_MODE_INVALID' });
  return { id: AGENT_API_SETTING_ID, value: mode };
}

function settingChangesWithCompatibility(id, value) {
  const canonical = normalizeSettingChange(id, value);
  return canonical.id === AGENT_API_SETTING_ID
    ? [canonical, { id: TOOL_MODE_SETTING_ID, value: TOOL_MODES[canonical.value] }]
    : [canonical];
}

module.exports = { AGENT_API_SETTING_ID, AGENT_API_MODES, TOOL_MODE_SETTING_ID, TOOL_MODES,
  normalizeAgentApiMode, agentApiModeFromToolMode, normalizeSettingChange, settingChangesWithCompatibility };
