'use strict';

// Environment removals are literal disable switches or JSON tool denials.
// They cannot carry credentials, commands, config search paths or grants.
function refusal(code, message) { return Object.assign(new Error(message), { code }); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function denialMap(value) {
  try {
    const parsed = JSON.parse(value);
    return plain(parsed) && Object.keys(parsed).length > 0 && Object.entries(parsed).every(([name, action]) =>
      /^[a-z][a-z0-9_]{0,63}$/.test(name) && action === 'deny') ? parsed : null;
  } catch { return null; }
}
function validRemovalEnv(name, value) {
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(name) || /(?:AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY|HOME|PATH|DIR)/.test(name)
      || typeof value !== 'string' || value.length > 4096) return false;
  return /_DISABLE_[A-Z_]+$/.test(name) && value === '1'
    || /_PERMISSION$/.test(name) && Boolean(denialMap(value));
}

function mergeRemovalEnvironment(env, additions) {
  const result = { ...env };
  for (const [name, value] of Object.entries(additions)) {
    if (!validRemovalEnv(name, value)) throw refusal('AGENT_NATIVE_ENV_INVALID', 'Native tool environment settings must contain only disable switches or tool denials.');
    // A true disable switch can only narrow, including an inherited false.
    if (value === '1') { result[name] = value; continue; }
    let previous = {};
    try {
      if (env[name]) previous = JSON.parse(env[name]);
      const action = item => ['allow', 'ask', 'deny'].includes(item);
      if (!plain(previous) || Object.entries(previous).some(([key, item]) =>
        !/^(?:\*|[a-z][a-z0-9_]*)$/.test(key)
        || !(action(item) || plain(item) && Object.values(item).every(action)))) throw new Error('Not permission rules');
    } catch {
      throw refusal('AGENT_NATIVE_ENV_INVALID', 'The existing native permission environment is not a JSON object, so this worker was not started.');
    }
    // Keep other entries, including pattern denials. Replace each removed
    // tool's entire rule with deny so a specific allow cannot survive it.
    const denied = denialMap(value);
    for (const tool of Object.keys(denied)) delete previous[tool];
    result[name] = JSON.stringify({ ...previous, ...denied });
  }
  return result;
}

function removalEnvironment(removals, env, { nodeFolder, workerSettings } = {}) {
  let result = mergeRemovalEnvironment(env, removals.env);
  if (removals.workerAgent?.kind === 'inline-primary-agent') {
    result = require('../agent-engine/inline-worker-agent').workerEnvironment(result, removals.workerAgent, workerSettings);
  }
  if (removals.settings.length) {
    const excludes = [...new Set(removals.settings.flatMap(row => row.exclude))];
    result = require('../agent-engine/gemini-native-tools').removalEnvironment(result, nodeFolder, excludes);
  }
  return result;
}

module.exports = Object.freeze({ validRemovalEnv, mergeRemovalEnvironment, removalEnvironment });
