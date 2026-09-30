'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');

const TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 65536;

function unknown(cli, reason, version) {
  return Object.freeze({ cli, absent: false, reason, ...(version ? { version } : {}) });
}

function completed(result) {
  return result && !result.error && !result.signal && Number.isInteger(result.status)
    && typeof result.stdout === 'string' && typeof result.stderr === 'string'
    && Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= MAX_OUTPUT_BYTES;
}

// These exact results are qualified by isolated real-CLI sentinel probes.
// Claude 2.1.284 `mcp get` starts the registered server, so its only accepted
// evidence is the caller's fresh result from `mcp remove --scope user
// toolsenabled`, run with the same env/cwd. Never inspect Claude via get/list
// or configuration files. Unknown versions/formats retain the runtime; no
// result or absence is cached across uninstall retries.
function probe(cli, context = {}) {
  if (cli !== 'codex' && cli !== 'claude') return unknown(cli, 'NONCONNECTING_INSPECTION_UNAVAILABLE');
  const { env, cwd, removalResult, spawnSync: launch = spawnSync } = context || {};
  if (cli === 'claude' && (!completed(removalResult) || removalResult.status !== 1
    || removalResult.stdout !== ''
    || removalResult.stderr !== 'No MCP server named "toolsenabled" in user scope\n')) {
    return unknown(cli, 'REGISTRATION_ABSENCE_UNPROVEN');
  }
  if (!env || typeof env !== 'object' || typeof env.HOME !== 'string' || !path.isAbsolute(env.HOME)
    || typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof launch !== 'function') {
    return unknown(cli, 'INSPECTION_CONTEXT_INVALID');
  }
  let environment;
  try {
    environment = safeLaunchEnvironment({ ...env, LANG: 'C', LC_ALL: 'C' },
      { context: `OpenShell uninstall: ${cli} registration inspection` });
  } catch { return unknown(cli, 'INSPECTION_ENVIRONMENT_REFUSED'); }
  const options = { env: environment, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, shell: false, windowsHide: true };
  let versionResult;
  try { versionResult = launch(cli, ['--version'], options); }
  catch { return unknown(cli, 'VERSION_INSPECTION_FAILED'); }
  const version = cli === 'codex' ? '0.158.0' : '2.1.284';
  const versionOutput = cli === 'codex' ? 'codex-cli 0.158.0\n' : '2.1.284 (Claude Code)\n';
  if (!completed(versionResult) || versionResult.status !== 0 || versionResult.stderr !== ''
    || versionResult.stdout !== versionOutput) {
    return unknown(cli, 'VERSION_UNQUALIFIED');
  }
  if (cli === 'claude') {
    return Object.freeze({ cli, absent: true, reason: 'REGISTRATION_ABSENT', version });
  }
  let result;
  try { result = launch(cli, ['mcp', 'get', 'toolsenabled'], options); }
  catch { return unknown(cli, 'REGISTRATION_INSPECTION_FAILED', version); }
  if (!completed(result)) return unknown(cli, 'REGISTRATION_INSPECTION_FAILED', version);
  if (result.status === 1 && result.stdout === ''
    && result.stderr === "Error: No MCP server named 'toolsenabled' found.\n") {
    return Object.freeze({ cli, absent: true, reason: 'REGISTRATION_ABSENT', version });
  }
  return unknown(cli, 'REGISTRATION_ABSENCE_UNPROVEN', version);
}

module.exports = Object.freeze({ probe });
