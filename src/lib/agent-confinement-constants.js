'use strict';

/* Two constants that Fleet's worker launchers and settings read. They used to
 * live in a desktop module that prepared generated agent homes by linking or
 * copying the person's CLI sign-in files; Fleet never copies a sign-in, so that
 * module is gone and these two values live here. */

// The permission level an unreadable or absent machine record resolves to.
const FAIL_CLOSED_TIER = 'guided';

// Codex features a worker running in Agent API "Only" mode has turned off.
const CODEX_API_ONLY_DISABLED_FEATURES = Object.freeze([
  'shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'computer_use', 'code_mode',
  'multi_agent', 'multi_agent_v2', 'goals', 'hooks', 'plugins', 'remote_plugin',
  'plugin_sharing', 'image_generation', 'view_image', 'in_app_browser',
  'in_app_chat', 'in_app_local_automation', 'in_app_updates',
  'skill_mcp_dependency_install', 'workspace_dependencies', 'tool_suggest',
]);

module.exports = Object.freeze({ FAIL_CLOSED_TIER, CODEX_API_ONLY_DISABLED_FEATURES });
