'use strict';

// Gemini applies system settings last. Fleet's per-run exclusions take that
// place, so they are used only where no system settings file exists.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function refusal(message) { return Object.assign(new Error(message), { code: 'AGENT_NATIVE_SETTINGS_UNAVAILABLE' }); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function systemPath(env) {
  return env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || (process.platform === 'darwin'
    ? '/Library/Application Support/GeminiCli/settings.json' : process.platform === 'win32'
      ? 'C:\\ProgramData\\gemini-cli\\settings.json' : '/etc/gemini-cli/settings.json');
}
// Fleet never opens an agent's settings files. Gemini applies the system
// settings file last, and pointing it at Fleet's own file replaces that file
// for the run, so Fleet adds its exclusions only when no system settings file
// exists. Only the path's metadata is checked; its content is never read.
function requireNoSystemSettings(file) {
  if (!path.isAbsolute(file)) {
    throw refusal('Gemini CLI needs an absolute system settings path, so this worker was not started.');
  }
  try { fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw refusal('Gemini CLI system settings could not be checked, so this worker was not started.');
  }
  throw refusal(`Gemini CLI has system settings at ${file}. Fleet does not read agent settings files, and switching off this worker's own subagents would replace them for the run, so this worker was not started. Choose another agent for this worker.`);
}

function readOwn(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 || process.platform !== 'win32' && stat.uid !== process.getuid()) throw new Error('unsafe');
    const document = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!plain(document) || Object.keys(document).some(key => !['tools', 'experimental'].includes(key))) throw new Error('foreign');
    return document;
  } catch { throw refusal('Fleet\'s own Gemini CLI tool settings from the worker above could not be read, so this worker was not started.'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function removalEnvironment(env, nodeFolder, exclude) {
  if (typeof nodeFolder !== 'string' || !path.isAbsolute(nodeFolder)) throw refusal('Gemini CLI needs a private Fleet node folder for native tool removals.');
  fs.mkdirSync(nodeFolder, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(nodeFolder);
  if (!stat.isDirectory() || fs.realpathSync(nodeFolder) !== path.resolve(nodeFolder)
      || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) {
    throw refusal('Gemini CLI native tool settings must stay in a private Fleet node folder.');
  }
  const source = systemPath(env);
  // A worker below a Gemini worker inherits Fleet's own file as its system
  // settings; that file is Fleet's, so its exclusions carry forward.
  const inherited = env.TOOLSENABLED_GEMINI_NATIVE_TOOLS && env.TOOLSENABLED_GEMINI_NATIVE_TOOLS === source;
  const settings = inherited ? readOwn(source) : requireNoSystemSettings(source);
  if (settings.tools !== undefined && !plain(settings.tools)
      || settings.tools?.exclude !== undefined && (!Array.isArray(settings.tools.exclude) || settings.tools.exclude.some(x => typeof x !== 'string'))
      || settings.experimental !== undefined && !plain(settings.experimental)) {
    throw refusal('Gemini CLI system tool settings cannot be preserved safely, so this worker was not started.');
  }
  const document = { ...settings, tools: { ...settings.tools, exclude: [...new Set([...(settings.tools?.exclude || []), ...exclude])] },
    ...(exclude.includes('invoke_agent') ? { experimental: { ...settings.experimental, enableAgents: false } } : {}) };
  const file = path.join(nodeFolder, 'native-tools.json');
  const temporary = path.join(nodeFolder, `native-tools-${crypto.randomBytes(12).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(document) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  // Gemini derives defaults from the system file's directory. Keep its original
  // location explicitly; system/user/workspace policy paths remain untouched.
  return { ...env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: file, TOOLSENABLED_GEMINI_NATIVE_TOOLS: file,
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH || path.join(path.dirname(source), 'system-defaults.json') };
}

module.exports = Object.freeze({ removalEnvironment });
