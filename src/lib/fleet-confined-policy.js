'use strict';

// A local confined session cannot use tools whose reach is outside the
// recorded workspace. Host file tools remain available only at Unrestricted,
// except in host mode: there every host file path is bounded by the sealed
// workspace record (providers/host-control.js#checkHostWorkspaceBoundary) and
// fenced again at dispatch, so the Standard profile admits these four.
const PERMANENT_EXCLUDED_TOOLS = new Set([
  'host.list_dir', 'host.patch_file', 'host.read_file', 'host.write_file'
]);
const PERMANENT_EXCLUDED_NAMESPACES = new Set(['host']);
const HOST_MODE_WORKSPACE_FILE_TOOLS = new Set([
  'host.list_dir', 'host.patch_file', 'host.read_file', 'host.write_file'
]);
function hostModeWorkspaceFileTool(name, profile, env = process.env) {
  return env.TOOLSENABLED_RUNTIME_MODE === 'host' && profile === 'workspace' && HOST_MODE_WORKSPACE_FILE_TOOLS.has(name);
}

module.exports = Object.freeze({ PERMANENT_EXCLUDED_TOOLS, PERMANENT_EXCLUDED_NAMESPACES,
  HOST_MODE_WORKSPACE_FILE_TOOLS, hostModeWorkspaceFileTool });
