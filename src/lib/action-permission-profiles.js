'use strict';

// Saved user choices narrow the existing role and permission-tier surface.
// No policy or authorization evidence is accepted from tool arguments.
const SETTINGS_KEY = 'mc.action-permissions.v1';
const MODES = Object.freeze(['automatic', 'direct', 'inherited', 'disabled']);
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOOL = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;
const AUTOMATIC_WORKING_PROFILES = new Set(['independent', 'autonomous', 'autonomous-plus']);
function defaultAgentResumeMode(workingProfile) {
  const id = typeof workingProfile === 'string' ? workingProfile
    : workingProfile && typeof workingProfile.id === 'string' ? workingProfile.id : null;
  return AUTOMATIC_WORKING_PROFILES.has(id) ? 'automatic' : 'direct';
}
const defaults = () => ({ v: 1, activeProfileId: 'default', profiles: [
  { id: 'default', name: 'Default', parentId: null, actions: {}, functions: null },
] });
function invalid(message) { throw Object.assign(new Error(message), { code: 'ACTION_PERMISSION_PROFILE_INVALID' }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function normalize(value) {
  if (value === null || value === undefined) value = defaults();
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { invalid('Permission settings must be valid JSON.'); } }
  if (!object(value) || value.v !== 1 || !ID.test(value.activeProfileId || '')
    || !Array.isArray(value.profiles) || !value.profiles.length || value.profiles.length > 32) invalid('Invalid saved permission profiles.');
  const profiles = value.profiles.map(row => {
    if (!object(row) || !ID.test(row.id || '') || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120
      || (row.parentId !== null && row.parentId !== undefined && !ID.test(row.parentId)) || !object(row.actions)) invalid('Invalid permission profile.');
    if (Object.keys(row.actions).length > 2048) invalid('Too many action permissions.');
    const actions = {};
    for (const [key, mode] of Object.entries(row.actions)) {
      if ((key !== 'agentResume' && !TOOL.test(key)) || !MODES.includes(mode)) invalid('Invalid action permission.');
      actions[key] = mode;
    }
    let functions;
    if (row.functions !== undefined) {
      if (row.functions !== null && (!Array.isArray(row.functions) || row.functions.length > 2048
        || row.functions.some(name => typeof name !== 'string' || !TOOL.test(name)) || new Set(row.functions).size !== row.functions.length)) invalid('Invalid selected functions.');
      functions = row.functions === null ? null : [...row.functions];
    }
    return { id: row.id, name: row.name.trim(), parentId: row.parentId || null, actions,
      ...(functions === undefined ? {} : { functions }) };
  });
  const ids = new Map(profiles.map(row => [row.id, row]));
  if (ids.size !== profiles.length || !ids.has(value.activeProfileId)) invalid('Missing or duplicate permission profile.');
  for (const row of profiles) {
    const visited = new Set();
    let current = row;
    while (current) {
      if (visited.has(current.id)) invalid('Permission profiles cannot inherit in a cycle.');
      visited.add(current.id);
      if (current.parentId && !ids.has(current.parentId)) invalid('Inherited permission profile is missing.');
      current = ids.get(current.parentId);
    }
  }
  return { v: 1, activeProfileId: value.activeProfileId, profiles };
}
function effective(value, { workingProfile = null } = {}) {
  const saved = normalize(value);
  const ids = new Map(saved.profiles.map(row => [row.id, row]));
  const chain = [];
  for (let row = ids.get(saved.activeProfileId); row; row = ids.get(row.parentId)) chain.unshift(row);
  const result = { actions: { agentResume: defaultAgentResumeMode(workingProfile) }, functions: null };
  for (const row of chain) {
    Object.assign(result.actions, row.actions);
    if (Array.isArray(row.functions)) result.functions = result.functions === null ? row.functions
      : result.functions.filter(name => row.functions.includes(name));
  }
  return result;
}
let host = null;
function installHost(value) {
  if (!value || typeof value.readSaved !== 'function' || typeof value.isDirectUserTurn !== 'function'
    || typeof value.hasInheritedUserPermission !== 'function') throw new TypeError('Action permission host is incomplete.');
  host = value;
}
function current() {
  let workingProfile = null;
  try { workingProfile = typeof host?.readWorkingProfile === 'function' ? host.readWorkingProfile() : null; }
  catch { workingProfile = null; }
  return effective(host ? host.readSaved() : null, { workingProfile });
}
function actionMode(name) { return current().actions[name === 'agent.resume' ? 'agentResume' : name]; }
function narrowTools(tools) {
  const saved = current();
  const names = saved.functions === null ? null : new Set(saved.functions);
  return tools.filter(entry => (!names || names.has(entry.name))
    && saved.actions[entry.name === 'agent.resume' ? 'agentResume' : entry.name] !== 'disabled').map(entry => {
    const mode = saved.actions[entry.name === 'agent.resume' ? 'agentResume' : entry.name];
    return mode ? { ...entry, description: `${entry.description} Saved action permission: ${mode}. This specific saved choice governs the role's general direct-request rule; all other role, tree and permission-tier limits still apply.` } : entry;
  });
}
function assertAction(entry, principal) {
  const saved = current();
  if (saved.functions !== null && !saved.functions.includes(entry.name)) throw Object.assign(new Error('This function is no longer selected in the saved permission profile.'), {
    code: 'ACTION_PERMISSION_REQUIRED',
  });
  const mode = saved.actions[entry.name === 'agent.resume' ? 'agentResume' : entry.name];
  if (mode === undefined) return false; // Existing role gate remains authoritative.
  const sessionId = principal?.sessionId;
  const allowed = mode === 'automatic' || (sessionId && (host?.isDirectUserTurn(sessionId) === true
    || (mode === 'inherited' && host?.hasInheritedUserPermission(sessionId) === true)));
  if (mode === 'disabled' || !allowed) throw Object.assign(new Error('The saved permission profile does not authorize this action in the current task.'), {
    code: 'ACTION_PERMISSION_REQUIRED',
  });
  return true;
}
module.exports = { SETTINGS_KEY, MODES, defaults, normalize, effective, installHost, current, actionMode, narrowTools, assertAction };
