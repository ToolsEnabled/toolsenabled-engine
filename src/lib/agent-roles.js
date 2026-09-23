'use strict';

// THE DEFAULT ROLE LIBRARY — the nine roles every installation starts with.
//
// This file is the single source of the role definitions that SHIP. Two other
// modules used to carry their own copy of "the default rules", in different
// words, for the same nine ids:
//
//   src/lib/agent-onboarding.js  ROLE_DEFINITIONS  (owns / mustNot)
//   src/lib/custom-role-store.js DEFAULT_RULES_BY_ID (owns / mustNot / handoff)
//
// Neither was wrong; they simply disagreed, and a reader had no way to tell
// which one the product meant. Both now derive from this file, so there is one
// answer to "what does this role say it does" and it cannot drift into two.
//
// WHAT A DEFINITION HAS TO CONTAIN, and why each field exists:
//
//   name      A plain label a stranger can read. Ids are stable and
//             machine-facing ('shadow-manager'); names are for people.
//   summary   One sentence: what this role is FOR. Someone choosing a role
//             reads this and nothing else.
//   owns      What the role is accountable for.
//   mustNot   What it refuses, and refuses even when it could.
//   handoff   How it relates to the other roles: what it receives, and what it
//             returns to whom. A role described in isolation cannot be placed
//             in an organisation.
//   rules     The operating rules that were learned by something going wrong.
//   enforced  What the CODE actually guarantees, as opposed to what the prose
//             above asks for. See the honesty note below.
//
// ON "operator": the person the fleet works for. Roles are session-assigned —
// a role belongs to a session, not to a model, a vendor or a person — so no
// definition here names a provider, a model tier, or a holder.
//
// Give each role enough relevant starting context to act immediately. Keep
// incident history in references and coordination duties specific to dispatchers.
//
// HONESTY ABOUT ENFORCEMENT. Prose in `mustNot` is an instruction; the bounded
// `capabilities` record is what workflow code mechanically permits. It grants
// no OS/tool/provider authority. The compatibility `enforced` projection below
// exposes the two older fields without becoming a second source of truth:
//
//   singleSeat    the org refuses to hold two agents in this role at once.
//   mayClaimWork  whether mayClaim() lets an agent in this role reserve work.
//
// Defaults start with the postures declared in agent-org.js. Installed default
// edits and custom roles may replace the complete record, so no consumer is
// allowed to infer behavior from `shadow-manager` or any other role id.

const { ROLES, DEFAULT_ROLE_CAPABILITIES, normalizeRoleCapabilities } = require('./agent-org');
const NO_ROLE_CAPABILITIES = Object.freeze({
  orgRoot: false,
  singleSeat: false,
  mayClaimWork: false,
  mayWakeReports: false,
  requiresMutationContext: false,
  mayUseMissionBridge: false,
  mayReportMissionBridge: false,
  mayMutateMissionBridge: false
});

// Delivery starts a turn; sustaining delegated work is a role duty, not a
// courier retry or permission grant. Keep the same duty on both dispatching
// roles, including stored roles that inherit either base.
// One plain JSON file per default role. Static imports keep the shipping
// dependency closure complete. Installed edits remain separate overrides.
const DEFINITIONS = Object.freeze(Object.fromEntries(Object.entries({
  'controller': require('./roles/controller.json'),
  'shadow-manager': require('./roles/shadow-manager.json'),
  'planner': require('./roles/planner.json'),
  'manager': require('./roles/manager.json'),
  'coordinator-assistant': require('./roles/coordinator-assistant.json'),
  'builder': require('./roles/builder.json'),
  'reviewer': require('./roles/reviewer.json'),
  'worker': require('./roles/worker.json'),
  'observer': require('./roles/observer.json')
}).map(([id, definition]) => [id, Object.freeze({
  ...definition, rules: Object.freeze(definition.rules)
})])));

const missing = ROLES.filter(id => !Object.hasOwn(DEFINITIONS, id));
const extra = Object.keys(DEFINITIONS).filter(id => !ROLES.includes(id));
if (missing.length || extra.length) {
  throw new Error(
    'The default role library must define exactly the declared role vocabulary. '
    + `Missing: ${missing.join(', ') || 'none'}. Undeclared: ${extra.join(', ') || 'none'}.`
  );
}

const ROLE_LIBRARY = Object.freeze(ROLES.map(id => Object.freeze({
  id,
  ...DEFINITIONS[id],
  capabilities: DEFAULT_ROLE_CAPABILITIES[id],
  // Compatibility projection for surfaces that distinguish mechanically
  // enforced posture from prose. The source of truth is capabilities above.
  enforced: Object.freeze({
    singleSeat: DEFAULT_ROLE_CAPABILITIES[id].singleSeat,
    mayClaimWork: DEFAULT_ROLE_CAPABILITIES[id].mayClaimWork
  })
})));
const BY_ID = new Map(ROLE_LIBRARY.map(role => [role.id, role]));

/** The full definition for one declared role, or null. */
function roleDefinition(id) {
  return BY_ID.get(id) || null;
}

/**
 * The three editable rule fields, in the exact shape the custom-role store
 * accepts. Projected rather than stored separately so the editable defaults and
 * the shipped description can never say different things.
 */
function roleRules(id) {
  const role = BY_ID.get(id);
  if (!role) return null;
  return Object.freeze({ owns: role.owns, mustNot: role.mustNot, handoff: role.handoff });
}

function roleCapabilities(id) {
  return BY_ID.get(id)?.capabilities || null;
}

function displayNameForRoleId(id) {
  return String(id).split(/[-_]+/).filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

/**
 * Compose the directions sheet stored for one installation with the shipped
 * operating rules of its declared base role.  Custom roles are ordinary roles:
 * the base contributes posture and learned rules, while the operator-authored
 * owns/mustNot/handoff text remains the actual assignment.  A role with no
 * base deliberately inherits no mutating posture or implicit instructions.
 */
function storedRoleDefinition(definition) {
  if (!definition || typeof definition !== 'object' || typeof definition.id !== 'string'
      || !definition.rules || typeof definition.rules !== 'object') return null;
  const shipped = roleDefinition(definition.id);
  const base = shipped || (typeof definition.baseDefaultRole === 'string'
    ? roleDefinition(definition.baseDefaultRole)
    : null);
  if (!shipped && definition.baseDefaultRole !== null && !base) return null;
  const owns = definition.rules.owns;
  const mustNot = definition.rules.mustNot;
  const handoff = definition.rules.handoff;
  if (![owns, mustNot, handoff].every(value => typeof value === 'string' && (value === '' || value.trim().length > 0))) return null;
  let capabilities;
  try {
    capabilities = definition.capabilities === undefined
      ? (base?.capabilities || NO_ROLE_CAPABILITIES)
      : normalizeRoleCapabilities(definition.capabilities, 'stored role capabilities', {
        legacyMayUseMissionBridge: (base?.capabilities || NO_ROLE_CAPABILITIES).mayUseMissionBridge,
        legacyMayReportMissionBridge: (base?.capabilities || NO_ROLE_CAPABILITIES).mayReportMissionBridge,
        legacyMayMutateMissionBridge: (base?.capabilities || NO_ROLE_CAPABILITIES).mayMutateMissionBridge
      });
  } catch {
    return null;
  }
  return Object.freeze({
    id: definition.id,
    name: shipped ? shipped.name : displayNameForRoleId(definition.id),
    summary: shipped
      ? shipped.summary
      : (base ? `Operator-defined role based on ${base.name}.` : 'Operator-defined read-only role with no inherited base.'),
    owns,
    mustNot,
    handoff,
    rules: base ? base.rules : Object.freeze([]),
    capabilities
  });
}

module.exports = Object.freeze({ ROLE_LIBRARY, roleDefinition, roleRules, roleCapabilities, storedRoleDefinition });
