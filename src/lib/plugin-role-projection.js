'use strict';

// A PLUGIN'S ROLES ARE PROJECTED, NOT WRITTEN.
//
// THE OBVIOUS IMPLEMENTATION IS THE WRONG ONE. src/lib/custom-role-store.js has a
// createCustomRole(), so installing a plugin's roles by calling it looks like the
// answer. It is not, for three reasons and each one is a defect that would ship:
//
//   1. THE DURABLE FILE IS THE PERSON'S. It holds roles they wrote, and
//      src/lib/agent-org-store.js goes out of its way to say that a role store
//      which throws must never be read as "there are no custom roles", because
//      that would invalidate every agent already holding one. Writing a third
//      party's roles into that file makes a stranger's package a co-author of an
//      authority document, and the person cannot tell which lines are theirs.
//
//   2. REVOKING WOULD LEAVE ORPHANS. A grant withdrawn, or a plugin edited by one
//      byte, must take the roles with it. With durable writes, something has to
//      go back and remove them -- and nothing records which rows a plugin owns, so
//      that reconciliation would have to guess by id prefix and would eventually
//      delete a role the person happened to name the same way. Projected roles
//      simply are not there on the next read. There is nothing to reconcile
//      because there is nothing to clean up.
//
//   3. IT WOULD COLLIDE ON EVERY RESTART. createCustomRole() refuses a duplicate,
//      so a second launch would either throw or need an "ensure" path that edits
//      the person's file to match the package. Both are worse than not writing.
//
// SO: the activated plugins' roles are registered here once at start, and the role
// store adds them to what it read from disk WITHOUT writing them. A projected role
// is visible, usable and gone when the grant is.
//
// THE PERSON'S OWN ROLE ALWAYS WINS. If a stored role and a projected one share an
// id, the stored one is returned and the projected one is reported as shadowed. A
// plugin cannot take over an id somebody is already using, and the shadowing is
// surfaced rather than silently resolved -- which is the same rule
// src/lib/tool-pack-registry.js applies to a pack that tries to redefine a core
// tool, for the same reason.
//
// AND A PROJECTED ID CANNOT BE WRITTEN. custom-role-store refuses to create or
// edit a role whose id a plugin is currently projecting: a durable row with that
// id would shadow the projection from then on, and the two would disagree about
// what the role says with nothing to say which is in force.
//
// THE EMPTY CASE IS THE SHIPPED CASE. With no plugin activated this list is empty
// and every read is byte-identical to what it was before this file existed. The
// suite proves that rather than asserting it.

// WHAT A PROJECTED ID MAY LOOK LIKE. Lowercase words joined by dashes, as before
// (`notes-archivist`), and, after the last dash, lowercase words joined by
// UNDERSCORES -- because rolesFor() in src/lib/plugin-host builds a role's id from
// the plugin's name (words joined by dashes), a dash, and the role's own id (words
// joined by underscores): `notes-code_reviewer`.
//
// The first version of this pattern allowed no underscore at all, while the host
// REQUIRES a role's own id to be words joined by underscores and says so in its
// refusal. So the documented two-word form passed the host and failed here, and
// because every plugin's roles were registered in one call, one such id took
// every plugin's roles with it while the Plugins page said they were added (1.0.50
// release review F3). An underscore is accepted only after a dash, because only
// the role half of the id can hold one.
//
// The id must also be one custom-role-store's ROLE_ID accepts, because that store
// is what serves it: at most 64 characters, the same cap.
const PROJECTED_ROLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:-[a-z0-9]+(?:_[a-z0-9]+)+)?$/;
const MAX_PROJECTED_ROLE_ID = 64;
const MAX_PROJECTED_ROLES = 64;
const MAX_RULE_TEXT = 6000;

let projected = Object.freeze([]);
let sealed = false;

class PluginRoleProjectionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PluginRoleProjectionError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new PluginRoleProjectionError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function ruleText(value, field) {
  if (typeof value !== 'string' || !value || value.length > MAX_RULE_TEXT || value !== value.trim()) {
    fail('PLUGIN_ROLE_PROJECTION_INVALID', `${field} must be trimmed text of at most ${MAX_RULE_TEXT} characters.`, { field });
  }
  return value;
}

// One projected role, in exactly the shape custom-role-store's own definitions
// take -- so a caller downstream cannot tell a projected role from a stored one by
// its shape, only by asking this module.
function normalize(entry, index) {
  if (!plain(entry) || !plain(entry.rules)) {
    fail('PLUGIN_ROLE_PROJECTION_INVALID', `projected role ${index} must be { id, rules, plugin }.`, { index });
  }
  const id = entry.id;
  if (typeof id !== 'string' || id.length > MAX_PROJECTED_ROLE_ID || !PROJECTED_ROLE_ID.test(id)) {
    fail('PLUGIN_ROLE_PROJECTION_INVALID',
      `projected role ${index} has an invalid id. A plugin's role id is its plugin's name and the role's own, `
      + `joined by a dash, at most ${MAX_PROJECTED_ROLE_ID} characters in all.`, { index });
  }
  return Object.freeze({
    id,
    // Which package it came from, so a screen can say so and so a person can tell
    // a projected role from one they wrote.
    plugin: typeof entry.plugin === 'string' ? entry.plugin : null,
    pluginId: typeof entry.pluginId === 'string' ? entry.pluginId : null,
    baseDefaultRole: null,
    rules: Object.freeze({
      owns: ruleText(entry.rules.owns, `projected role ${index} rules.owns`),
      mustNot: ruleText(entry.rules.mustNot, `projected role ${index} rules.mustNot`),
      handoff: ruleText(entry.rules.handoff, `projected role ${index} rules.handoff`)
    })
  });
}

/* Called once, by src/lib/plugin-activation.js, at start. Replaces the list
   wholesale rather than appending: the set of projected roles is a function of
   which plugins are activated, and an append API would make it a function of how
   many times activation ran. */
function registerProjectedRoles(roles) {
  if (sealed) {
    fail('PLUGIN_ROLE_PROJECTION_SEALED',
      'Projected roles were registered after the projection was sealed. Register them during startup, before '
      + 'anything reads the role vocabulary.');
  }
  if (!Array.isArray(roles)) {
    fail('PLUGIN_ROLE_PROJECTION_INVALID', 'registerProjectedRoles(roles) takes an array.');
  }
  if (roles.length > MAX_PROJECTED_ROLES) {
    fail('PLUGIN_ROLE_PROJECTION_LIMIT', `At most ${MAX_PROJECTED_ROLES} roles may be projected by plugins at once.`);
  }
  const normalized = roles.map(normalize);
  const seen = new Set();
  for (const role of normalized) {
    if (seen.has(role.id)) {
      fail('PLUGIN_ROLE_PROJECTION_COLLISION',
        `Two activated plugins both project the role "${role.id}". Neither is used: a role id that two packages `
        + 'claim is a role nobody can say the wording of.', { id: role.id });
    }
    seen.add(role.id);
  }
  projected = Object.freeze(normalized.slice().sort((left, right) => left.id.localeCompare(right.id)));
  return projected;
}

function projectedRoles() {
  return projected;
}

/* SEALING IS AN ACT, NOT A SIDE EFFECT OF READING, and that is a correction.
 *
 * This module first sealed on the first read, copying the rule
 * src/lib/tool-pack-registry.js applies to a pack registered after the registry
 * was built. It is the wrong rule here and a test found out why: unlike
 * TOOL_REGISTRY, the role vocabulary is re-read on every request, so a late
 * registration would in fact work -- and meanwhile ANY innocent read sealed the
 * list. createCustomRole() calls listRoles() to count, so a person saving a role
 * of their own locked out plugin activation entirely.
 *
 * So the rule is kept and the trigger is fixed: src/lib/plugin-activation.js seals
 * once it has registered, which is the moment after which nothing legitimate
 * registers again. A read seals nothing. */
function seal() {
  sealed = true;
  return projected;
}

function projectedRole(id) {
  return projected.find(role => role.id === id) || null;
}

function isProjected(id) {
  return projected.some(role => role.id === id);
}

/* Which projected roles a set of already-stored ids hides. The caller reports
   these; this module does not resolve them silently. */
function shadowedBy(storedIds) {
  const stored = new Set(storedIds);
  return Object.freeze(projected.filter(role => stored.has(role.id)).map(role => role.id));
}

function resetForTests() {
  projected = Object.freeze([]);
  sealed = false;
}

/* One plugin's roles, checked against exactly the rules registerProjectedRoles()
   applies, WITHOUT registering anything. src/lib/plugin-activation.js calls this
   per plugin before it builds the one list it registers, so a role that would be
   refused costs its own plugin's roles and nobody else's. Returns the normalized
   entries; throws the same PluginRoleProjectionError registration would. */
function checkProjectedRoles(roles) {
  if (!Array.isArray(roles)) {
    fail('PLUGIN_ROLE_PROJECTION_INVALID', 'checkProjectedRoles(roles) takes an array.');
  }
  if (roles.length > MAX_PROJECTED_ROLES) {
    fail('PLUGIN_ROLE_PROJECTION_LIMIT', `At most ${MAX_PROJECTED_ROLES} roles may be projected by plugins at once.`);
  }
  const normalized = roles.map(normalize);
  const seen = new Set();
  for (const role of normalized) {
    if (seen.has(role.id)) {
      fail('PLUGIN_ROLE_PROJECTION_COLLISION',
        `The role "${role.id}" is projected twice. Neither is used: a role id that is claimed twice is a role `
        + 'nobody can say the wording of.', { id: role.id });
    }
    seen.add(role.id);
  }
  return Object.freeze(normalized);
}

module.exports = Object.freeze({
  PluginRoleProjectionError,
  registerProjectedRoles,
  checkProjectedRoles,
  projectedRoles,
  seal,
  projectedRole,
  isProjected,
  shadowedBy,
  resetForTests,
  MAX_PROJECTED_ROLES,
  MAX_PROJECTED_ROLE_ID,
  PROJECTED_ROLE_ID
});
