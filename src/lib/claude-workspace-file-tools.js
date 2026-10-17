'use strict';

// Claude workers run headless. Keep their native file surface small, with
// permission rules anchored at the CLI's cwd (the sealed workspace). Claude
// Code 2.1.287 evaluates Edit(path) for both Edit and Write and checks the
// resolved target as well as the requested path (Claude permissions reference:
// https://code.claude.com/docs/en/permissions). dontAsk denies everything
// that is not explicitly allowed; --tools removes Bash and other native tools.
const NATIVE_TOOLS = 'Read,Edit,Write';
const path = require('node:path');
// The OpenShell unrestricted tool surface can otherwise reach files outside
// the project through Fleet's own host and search tools. Remove those from an
// Only-mode Claude worker and all descendants of its tree surface.
const MCP_FILE_BYPASSES = Object.freeze(new Set([
  'host.read_file', 'host.write_file', 'host.patch_file', 'host.list_dir',
  'search.index', 'search.query',
]));
function confinedMcpNames(names) { return names.filter(name => !MCP_FILE_BYPASSES.has(name)); }
function outsideWriteDenial(files, workspaceRoot, label = 'Fleet') {
  if (!Array.isArray(files) || typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) return null;
  const root = path.resolve(workspaceRoot);
  for (const row of files.slice(0, 4)) {
    if (!row || !['Edit', 'Write'].includes(row.tool) || typeof row.path !== 'string'
        || row.path.length === 0 || row.path.length > 240 || !path.isAbsolute(row.path)
        || /[\x00-\x1f\x7f]/.test(row.path)) continue;
    const relative = path.relative(root, row.path);
    if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) continue;
    return `${row.tool} to ${JSON.stringify(row.path)} was denied: ${label} confines writes to the sealed workspace ${JSON.stringify(root)}.`;
  }
  return null;
}
const FILE_ALLOW = Object.freeze(['Read(./**)', 'Edit(./**)']);
const FILE_DENY = Object.freeze([
  'Read(.env)', 'Read(.env.*)', 'Read(.git/**)', 'Read(.claude/**)',
  'Read(.codex/**)', 'Read(.ssh/**)', 'Read(.aws/**)',
  'Read(.pgpass)', 'Read(.my.cnf)', 'Read(.claude.json)',
  'Read(*_history)', 'Read(*credentials*)', 'Read(*private_key*)',
  'Edit(.git/**)', 'Edit(.hg/**)', 'Edit(.svn/**)', 'Edit(.claude/**)',
  'Edit(.codex/**)', 'Edit(.envrc)', 'Edit(.bashrc)', 'Edit(.profile)',
  'Edit(.zshrc)', 'Edit(.vscode/**)', 'Edit(.idea/**)',
  'Edit(.husky/**)', 'Edit(.githooks/**)', 'Edit(.github/workflows/**)',
  'Edit(.github/actions/**)', 'Edit(.circleci/**)',
  'Edit(.mcp.json)', 'Edit(.mise.toml)', 'Edit(.npmrc)',
  'Edit(.gitconfig)', 'Edit(.pre-commit-config.yaml)',
]);

function settings(serverName, { serverEnabled = true } = {}) {
  const allow = [...(serverEnabled ? [require('./agent-engine/claude-cli-adapter').claudeServerPermissionRule(serverName)] : []), ...FILE_ALLOW];
  return Object.freeze({ permissions: Object.freeze({ allow, deny: [...FILE_DENY] }) });
}

module.exports = Object.freeze({ NATIVE_TOOLS, FILE_ALLOW, FILE_DENY, MCP_FILE_BYPASSES, confinedMcpNames, outsideWriteDenial, settings });
