'use strict';

// OpenCode workers run as a Fleet-owned primary agent defined per run through
// OpenCode's documented OPENCODE_CONFIG_CONTENT, under both the "agent" key and
// the legacy "mode" key, so a person's or an administrator's setting for that
// name cannot re-allow what the worker must not do (handtest/subagents/).
// Only an administrator's managed config that names this agent under the legacy
// key still can; that is the administrator's own policy. No file is read.
function refusal(code, message) { return Object.assign(new Error(message), { code }); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function workerEnvironment(env, mechanism, settings) {
  if (!settings || !['none', 'edits', 'all'].includes(settings.allow)) {
    throw refusal('AGENT_NATIVE_ENV_INVALID', 'The inline worker agent needs an inherited permission level.');
  }
  let config, denials;
  try {
    config = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
    denials = env.OPENCODE_PERMISSION ? JSON.parse(env.OPENCODE_PERMISSION) : {};
    if (!plain(config) || config.agent !== undefined && !plain(config.agent)
        || config.agent?.[mechanism.name] !== undefined && !plain(config.agent[mechanism.name])
        || !plain(denials)) throw new Error('Not an object');
  } catch {
    throw refusal('AGENT_NATIVE_ENV_INVALID', 'The existing inline agent configuration is not a JSON object, so this worker was not started.');
  }
  if (denials.task !== 'deny') {
    throw refusal('AGENT_NATIVE_ENV_INVALID', 'The inline worker agent must deny native subagents.');
  }
  const previous = config.agent?.[mechanism.name] || {};
  if (previous.permission !== undefined && !plain(previous.permission)) {
    throw refusal('AGENT_NATIVE_ENV_INVALID', 'The existing worker agent permissions are not a JSON object, so this worker was not started.');
  }
  // Never add an allow setting. Asking delegates each decision to the ACP
  // worker's existing none/edits/all policy, which uses only once-only replies.
  // An inherited denial stays a denial; removed tools are unconditional.
  const permission = Object.assign(Object.create(null), { '*': 'ask' });
  for (const [tool, rule] of Object.entries({ ...denials, ...previous.permission })) {
    if (['allow', 'ask', 'deny'].includes(rule)) permission[tool] = rule === 'deny' ? 'deny' : 'ask';
    else if (plain(rule) && Object.values(rule).every(action => ['allow', 'ask', 'deny'].includes(action))) {
      permission[tool] = Object.fromEntries(Object.entries(rule).map(([pattern, action]) => [pattern, action === 'deny' ? 'deny' : 'ask']));
    } else throw refusal('AGENT_NATIVE_ENV_INVALID', 'The existing worker agent has unsupported permission rules, so this worker was not started.');
  }
  for (const [tool, action] of Object.entries(denials)) if (action === 'deny') {
    delete permission[tool];
    permission[tool] = 'deny';
  }
  const agent = { ...previous, mode: 'primary', description: 'Fleet worker at its inherited permission level.', permission };
  if (config.mode !== undefined && (!plain(config.mode) || config.mode[mechanism.name] !== undefined && !plain(config.mode[mechanism.name]))) {
    throw refusal('AGENT_NATIVE_ENV_INVALID', 'The existing inline mode configuration is not a JSON object, so this worker was not started.');
  }
  // OpenCode still reads the legacy "mode" key for primary agents and merges
  // it over "agent"; Fleet's own name is defined there too, so a person's
  // legacy entry for that name cannot re-allow what this worker must not do.
  const { mode: _legacyMode, ...legacy } = agent;
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, default_agent: mechanism.name,
    agent: { ...config.agent, [mechanism.name]: agent }, mode: { ...config.mode, [mechanism.name]: legacy } }) };
}

module.exports = Object.freeze({ workerEnvironment });
