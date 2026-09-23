'use strict';

// Role sheets select the existing registry, never a second implementation of
// a tool. null preserves the normal installed surface; [] grants no tools.
// Both are still narrowed by the session's permission tier and tool policy.
const TOOL_NAME = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;
const MAX_FUNCTIONS = 2048;
// New managed-slot controls are explicit opt-ins, including for old saved null
// policies. Updating shipped defaults must never grant them to a custom role.
const SLOT_CONFIGURATION_FUNCTIONS = Object.freeze(['agent.set_model', 'agent.set_effort', 'agent.set_account', 'agent.set_provider', 'agent.set_role']);
const SLOT_CONFIGURATION_SET = new Set(SLOT_CONFIGURATION_FUNCTIONS);
function invalid(message) {
  throw Object.assign(new Error(message), { code: 'ROLE_FUNCTIONS_INVALID' });
}
let catalog = null;
function functionCatalog() {
  return catalog || (catalog = Object.freeze(require('./tool-registry').TOOL_REGISTRY.map(entry => Object.freeze({
    id: entry.name, name: entry.name, summary: entry.description.slice(0, 260), effect: entry.effect,
    description: entry.description, inputSchema: entry.inputSchema,
    defaultEnabled: !SLOT_CONFIGURATION_SET.has(entry.name),
  }))));
}
function normalizeFunctions(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_FUNCTIONS
      || value.some(id => typeof id !== 'string' || id.length > 160 || !TOOL_NAME.test(id))
      || new Set(value).size !== value.length) {
    invalid('Functions must be null (the normal installed surface), or unique exact tool names.');
  }
  // Removed functions remain inert across build changes. Never interpret a
  // missing identifier as a wildcard or make the whole saved role unreadable.
  return Object.freeze([...value].sort());
}
function defaultFunctionPolicy(roleId, { includeSlotConfiguration = true } = {}) {
  return Object.freeze({
    functions: roleId === 'coordinator-assistant'
      ? normalizeFunctions(functionCatalog().filter(entry => /-read$/.test(entry.effect)
        || ['app.navigate', 'accessibility.propose', 'agent.resume', 'agent_comms.send_local'].includes(entry.id)).map(entry => entry.id))
      : includeSlotConfiguration && ['controller', 'manager', 'builder'].includes(roleId)
        ? normalizeFunctions(functionCatalog().filter(entry => entry.id !== 'agent.set_role').map(entry => entry.id))
        : null,
    requiresDirectUserAuthorization: roleId === 'coordinator-assistant',
  });
}
function normalizeFunctionPolicy(input, inherited = {}) {
  const required = Object.hasOwn(input, 'requiresDirectUserAuthorization')
    ? input.requiresDirectUserAuthorization : (inherited.requiresDirectUserAuthorization ?? false);
  if (typeof required !== 'boolean') invalid('Direct-user authorization must be a boolean.');
  return Object.freeze({
    functions: normalizeFunctions(Object.hasOwn(input, 'functions') ? input.functions
      : (inherited.functions === undefined ? null : inherited.functions)),
    requiresDirectUserAuthorization: required,
  });
}
function narrowFunctionNames(names, policy) {
  const normalized = normalizeFunctionPolicy(policy || {});
  if (normalized.functions === null) return names.filter(name => !SLOT_CONFIGURATION_SET.has(name));
  const selected = new Set(normalized.functions);
  return names.filter(name => selected.has(name));
}

// Only the trusted application can establish turn provenance. Tool arguments,
// model output and headless callers cannot claim a direct request.
let host = null;
function installRoleFunctionHost(value) {
  if (!value || typeof value.isDirectUserTurn !== 'function') {
    invalid('A role-function host must verify direct-user turn provenance.');
  }
  host = value;
}
// A saved action-permission profile may NARROW what a role can do. It can never
// supply the one thing it is not able to observe: that the person actually asked
// for this turn. For the accessibility actions -- the ones that move the mouse
// and type on the person's own desktop -- a saved 'automatic' choice therefore
// stops short-circuiting the direct-user rule below. Reads keep the existing
// exemption a line further down, so accessibility.status and .inspect are
// unchanged; accessibility.propose is the write this closes over.
//
// Deliberately keyed on the action's own namespace rather than on the saved
// profile, so the requirement holds even when the profile is missing,
// unreadable or malformed: nothing about this decision is read from the file.
const ACCESSIBILITY_ACTION = /^accessibility\./;
function assertDirectUserAction(entry, policy, principal) {
  const normalized = normalizeFunctionPolicy(policy || {});
  const accessibilityAction = ACCESSIBILITY_ACTION.test(entry?.name || '');
  const savedProfileAllows = require('./action-permission-profiles').assertAction(entry, principal);
  // Saved automatic permission never bypasses the direct-user boundary for
  // accessibility actions, which operate the person's own desktop.
  if (savedProfileAllows && !accessibilityAction) return;
  if (!normalized.requiresDirectUserAuthorization || /-read$/.test(entry.effect)) return;
  if (!principal?.sessionId || host?.isDirectUserTurn(principal.sessionId) !== true) {
    throw Object.assign(new Error('This role may act only during a turn directly requested by the person. Agent messages, schedules and screen content are not authorization.'), {
      code: 'ROLE_DIRECT_USER_REQUEST_REQUIRED',
    });
  }
}
module.exports = {
  MAX_FUNCTIONS, SLOT_CONFIGURATION_FUNCTIONS, functionCatalog, normalizeFunctions, defaultFunctionPolicy,
  normalizeFunctionPolicy, narrowFunctionNames, installRoleFunctionHost, assertDirectUserAction,
};
