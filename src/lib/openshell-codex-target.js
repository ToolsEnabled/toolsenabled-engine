'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');
const LIMIT = 65536;

function completed(value) {
  return value && !value.error && !value.signal && Number.isInteger(value.status)
    && typeof value.stdout === 'string' && typeof value.stderr === 'string'
    && Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) <= LIMIT;
}
function exactKeys(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...names].sort().join(',');
}
function optionalStrings(value) { return value === null || Array.isArray(value) && value.every(item => typeof item === 'string'); }
function canonicalFile(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value)
    || /[\x00-\x1f\x7f]/.test(value) || value.split(path.sep).some(part => part === '.' || part === '..')) throw Error('unsafe path');
  const result = fs.realpathSync(value);
  if (!fs.statSync(result).isFile()) throw Error('not a file');
  return result;
}
// Codex get includes trusted project layers, while remove writes the selected
// global profile. Refuse every distinct project config in the lookup ancestry;
// otherwise a matching project entry can hide a different global registration.
// Only path metadata is inspected, never configuration or credential contents.
function assertGlobalScope(env, cwd) {
  const canonical = require('./openshell-lifecycle-context').canonical;
  let selected, directory;
  try {
    const profile = env.CODEX_HOME === undefined ? path.join(env.HOME, '.codex') : env.CODEX_HOME;
    selected = canonical(path.join(canonical(profile), 'config.toml'));
    directory = canonical(cwd);
    for (;;) {
      const candidate = path.join(directory, '.codex/config.toml');
      try {
        fs.lstatSync(candidate);
        if (canonicalFile(candidate) !== selected) refuse('a project configuration can shadow the selected global profile');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch (error) {
    if (error.code === 'CODEX_TARGET_UNPROVEN') throw error;
    refuse('global registration scope cannot be verified');
  }
}
function refuse(reason) {
  throw Object.assign(new Error(`CODEX_TARGET_UNPROVEN: ${reason}; registration removal is refused. Inspect the selected Codex profile and retry with its original runtime.`),
    { code: 'CODEX_TARGET_UNPROVEN' });
}

// Qualified with Codex 0.158.0 in independent scratch profiles and a positive
// MCP-start sentinel control. JSON retains argv boundaries, including spaces;
// plaintext get output cannot prove them. Never invoke the registered command.
function assertCodexTarget(prefix, { env, cwd, launch = spawnSync, nodePath = process.execPath } = {}) {
  if (process.platform !== 'linux') refuse('Codex target inspection requires a Linux OpenShell sandbox');
  if (!env || typeof env.HOME !== 'string' || !path.isAbsolute(env.HOME)
    || typeof cwd !== 'string' || !path.isAbsolute(cwd) || !path.isAbsolute(prefix || '')) refuse('invalid exact-scope context');
  assertGlobalScope(env, cwd);
  const names = ['HOME', 'PATH', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'CODEX_HOME'];
  let environment;
  try {
    environment = safeLaunchEnvironment({ ...Object.fromEntries(names.filter(key => env[key] !== undefined).map(key => [key, env[key]])),
      LANG: 'C', LC_ALL: 'C' }, { context: 'Fleet uninstall Codex target inspection' });
  } catch { refuse('inspection environment is unavailable'); }
  const options = { env: environment, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000, maxBuffer: LIMIT, shell: false, windowsHide: true };
  let version, result;
  try { version = launch('codex', ['--version'], options); }
  catch { refuse('version inspection failed'); }
  if (!completed(version) || version.status !== 0 || version.stderr !== '' || version.stdout !== 'codex-cli 0.158.0\n') refuse('Codex version is unqualified');
  try { result = launch('codex', ['mcp', 'get', 'toolsenabled', '--json'], options); }
  catch { refuse('registration inspection failed'); }
  if (!completed(result)) refuse('registration inspection did not settle');
  if (result.status === 1 && result.stdout === '' && result.stderr === "Error: No MCP server named 'toolsenabled' found.\n") {
    return Object.freeze({ absent: true, version: '0.158.0' });
  }
  if (result.status !== 0 || result.stderr !== '') refuse('registration metadata is unavailable');
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { refuse('registration metadata is not valid JSON'); }
  if (!exactKeys(value, ['name', 'enabled', 'disabled_reason', 'transport', 'enabled_tools', 'disabled_tools', 'startup_timeout_sec', 'tool_timeout_sec'])
    || value.name !== 'toolsenabled' || typeof value.enabled !== 'boolean'
    || !(value.disabled_reason === null || typeof value.disabled_reason === 'string')
    || !optionalStrings(value.enabled_tools) || !optionalStrings(value.disabled_tools)
    || ![value.startup_timeout_sec, value.tool_timeout_sec].every(item => item === null || typeof item === 'number' && Number.isFinite(item) && item >= 0)
    || !exactKeys(value.transport, ['type', 'command', 'args', 'env', 'env_vars', 'cwd']) || value.transport.type !== 'stdio'
    || !(value.transport.env === null || typeof value.transport.env === 'object' && !Array.isArray(value.transport.env)
      && Object.values(value.transport.env).every(item => typeof item === 'string'))
    || !Array.isArray(value.transport.env_vars) || !value.transport.env_vars.every(item => typeof item === 'string')
    || !(value.transport.cwd === null || typeof value.transport.cwd === 'string' && path.isAbsolute(value.transport.cwd))
    || !Array.isArray(value.transport.args) || value.transport.args.length !== 1) refuse('registration has an unknown transport or argument shape');
  try {
    if (canonicalFile(value.transport.command) !== canonicalFile(nodePath)
      || canonicalFile(value.transport.args[0]) !== canonicalFile(path.join(prefix, 'runtime/engine/src/mcp-server.js'))) {
      refuse('registration points at a different command or runtime');
    }
  } catch (error) {
    if (error.code === 'CODEX_TARGET_UNPROVEN') throw error;
    refuse('registration command or runtime path cannot be verified');
  }
  return Object.freeze({ absent: false, version: '0.158.0' });
}
module.exports = Object.freeze({ assertCodexTarget });
