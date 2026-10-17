'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('./supervision/launch-environment');
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
// global profile. Codex reads project configs "from the project root down to
// your current working directory" (the root is the nearest folder with .git;
// with none, the working directory alone). Refuse every distinct project config
// in that range; otherwise a matching project entry can hide a different global
// registration. Only path metadata is inspected, never configuration contents.
function assertGlobalScope(env, cwd, descriptor) {
  const canonical = require('./openshell-lifecycle-context').canonical;
  let selected, directory;
  try {
    const profile = require('./agents/registration').profile(descriptor, env).root;
    selected = canonical(path.join(canonical(profile), 'config.toml'));
    directory = canonical(cwd);
    const range = [];
    for (let at = directory; ; at = path.dirname(at)) {
      range.push(at);
      try { fs.lstatSync(path.join(at, '.git')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (path.dirname(at) === at) { range.splice(1); break; }
    }
    for (const folder of range) {
      const candidate = path.join(folder, descriptor.register.profile.default, descriptor.register.profile.file);
      try {
        fs.lstatSync(candidate);
        if (canonicalFile(candidate) !== selected) refuse('a project configuration can shadow the selected global profile');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) {
    if (error.code === 'CODEX_TARGET_UNPROVEN') throw error;
    refuse('global registration scope cannot be verified');
  }
}
function refuse(reason) {
  throw Object.assign(new Error(`CODEX_TARGET_UNPROVEN: ${reason}; registration changes are refused. Inspect the selected Codex profile and retry with its original runtime.`),
    { code: 'CODEX_TARGET_UNPROVEN' });
}

// Qualified with Codex 0.158.0 in independent scratch profiles and a positive
// MCP-start sentinel control. JSON retains argv boundaries, including spaces;
// plaintext get output cannot prove them. Never invoke the registered command.
function assertCodexTarget(prefix, { env, cwd, launch = spawnSync, nodePath = process.execPath, name = 'toolsenabled', entry, registry, descriptor = require('./agents/registry').activeRegistry().get('codex') } = {}) {
  if (process.platform !== 'linux') refuse('Codex target inspection requires a Linux OpenShell sandbox');
  if (!env || typeof env.HOME !== 'string' || !path.isAbsolute(env.HOME)
    || typeof cwd !== 'string' || !path.isAbsolute(cwd) || (!entry && !path.isAbsolute(prefix || ''))
    || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) refuse('invalid exact-scope context');
  assertGlobalScope(env, cwd, descriptor);
  const names = ['HOME', 'PATH', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', descriptor.register.profile.env];
  let environment;
  try {
    environment = safeLaunchEnvironment({ ...Object.fromEntries(names.filter(key => env[key] !== undefined).map(key => [key, env[key]])),
      LANG: 'C', LC_ALL: 'C' }, { context: 'Fleet uninstall Codex target inspection' });
  } catch { refuse('inspection environment is unavailable'); }
  const options = { env: environment, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000, maxBuffer: LIMIT, shell: false, windowsHide: true };
  let version, result;
  try { version = launch(descriptor.command, ['--version'], options); }
  catch { refuse('version inspection failed'); }
  const qualified = completed(version) ? require('./agents/registry').qualifiedVersion(descriptor.register.inspection, version.stdout) : null;
  if (!completed(version) || version.status !== 0 || version.stderr !== '' || qualified === null) refuse('Codex version is unqualified');
  try { result = launch(descriptor.command, ['mcp', 'get', name, '--json'], options); }
  catch { refuse('registration inspection failed'); }
  if (!completed(result)) refuse('registration inspection did not settle');
  if (result.status === 1 && result.stdout === '' && result.stderr === descriptor.register.inspection.absentStderr.replaceAll('{name}', name)) {
    return Object.freeze({ absent: true, version: qualified });
  }
  if (result.status !== 0 || result.stderr !== '') refuse('registration metadata is unavailable');
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { refuse('registration metadata is not valid JSON'); }
  if (!exactKeys(value, ['name', 'enabled', 'disabled_reason', 'transport', 'enabled_tools', 'disabled_tools', 'startup_timeout_sec', 'tool_timeout_sec'])
    || value.name !== name || typeof value.enabled !== 'boolean'
    || !(value.disabled_reason === null || typeof value.disabled_reason === 'string')
    || !optionalStrings(value.enabled_tools) || !optionalStrings(value.disabled_tools)
    || ![value.startup_timeout_sec, value.tool_timeout_sec].every(item => item === null || typeof item === 'number' && Number.isFinite(item) && item >= 0)
    || !exactKeys(value.transport, ['type', 'command', 'args', 'env', 'env_vars', 'cwd']) || value.transport.type !== 'stdio'
    || !(value.transport.env === null || typeof value.transport.env === 'object' && !Array.isArray(value.transport.env)
      && Object.values(value.transport.env).every(item => typeof item === 'string'))
    || !Array.isArray(value.transport.env_vars) || !value.transport.env_vars.every(item => typeof item === 'string')
    || !(value.transport.cwd === null || typeof value.transport.cwd === 'string' && path.isAbsolute(value.transport.cwd))
    || !Array.isArray(value.transport.args) || value.transport.args.some(arg => typeof arg !== 'string')
    || (!entry && value.transport.args.length !== 1)) refuse('registration has an unknown transport or argument shape');
  // A sealed setup entry also binds the forwarded names. A person changing
  // either the server or that consent list keeps their entry on rerun/removal.
  if (entry) {
    const equal = require('node:util').isDeepStrictEqual;
    const names = require('./agents/registration').forwardEnvNames(entry.passEnv || [], registry);
    if (value.transport.command !== entry.command || !equal(value.transport.args, entry.args)
      || !equal(value.transport.env || {}, entry.env) || !equal(value.transport.env_vars, names)
      || value.transport.cwd !== null || !value.enabled || value.disabled_reason !== null
      || value.enabled_tools !== null || value.disabled_tools !== null
      || value.startup_timeout_sec !== null || value.tool_timeout_sec !== null) refuse('registration differs from the recorded entry');
    return Object.freeze({ absent: false, owned: true, version: qualified, entry });
  }
  try {
    if (canonicalFile(value.transport.command) !== canonicalFile(nodePath)
      || canonicalFile(value.transport.args[0]) !== canonicalFile(path.join(prefix, 'runtime/engine/src/mcp-server.js'))) {
      refuse('registration points at a different command or runtime');
    }
  } catch (error) {
    if (error.code === 'CODEX_TARGET_UNPROVEN') throw error;
    refuse('registration command or runtime path cannot be verified');
  }
  return Object.freeze({ absent: false, version: qualified });
}
module.exports = Object.freeze({ assertCodexTarget });
