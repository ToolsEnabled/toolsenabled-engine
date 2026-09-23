// Declared agent organisation — the owner-authored model of who is who, who
// manages whom, and who works on what.
//
// This is deliberately separate from the *observed* agent activity that
// `controller-projection.js` derives from the signed audit ledger. The two
// answer different questions and must never be merged:
//
//   declared  — "Luna is managed by Claude." Owner intent. Editable. Governs
//               routing and claim eligibility.
//   observed  — "a worker was running at 07:14." Derived from the ledger.
//               Never editable; editing it would be falsifying the record.
//
// Nothing in this module grants authority. An agent marked enabled here is
// still bound by every policy, approval, kill-switch, and credential gate it
// was bound by before. This model changes *intent*, not permission.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { resolveSettingsValuesPath } = require('./durable-memory-file');

const SCHEMA_VERSION = 1;

// 'planner' exists because R1186 seats a planner alongside the controller and
// shadow manager. R1039's lesson applies literally here: when the schema cannot
// express the owner's current org, the declared file goes stale and the
// staleness looks like a decision. Adding the role is the fix, not annotating
// a nearby one.
const ROLES = Object.freeze(['controller', 'shadow-manager', 'planner', 'manager', 'coordinator-assistant', 'builder', 'reviewer', 'worker', 'observer']);
// Workflow capabilities belong to role definitions, not to role-name branches
// in the consumers that happen to enforce them. They never grant filesystem,
// process, credential, provider, or approval authority; they only describe the
// declared work protocol a role may participate in.
const ROLE_CAPABILITY_FIELDS = Object.freeze([
  'orgRoot', 'singleSeat', 'mayClaimWork', 'mayWakeReports',
  'requiresMutationContext', 'mayUseMissionBridge',
  'mayReportMissionBridge', 'mayMutateMissionBridge'
]);
const frozenCapabilities = values => Object.freeze({
  orgRoot: values.orgRoot === true,
  singleSeat: values.singleSeat === true,
  mayClaimWork: values.mayClaimWork === true,
  mayWakeReports: values.mayWakeReports === true,
  requiresMutationContext: values.requiresMutationContext === true,
  mayUseMissionBridge: values.mayUseMissionBridge === true,
  mayReportMissionBridge: values.mayReportMissionBridge === true,
  mayMutateMissionBridge: values.mayMutateMissionBridge === true
});
const DEFAULT_ROLE_CAPABILITIES = Object.freeze({
  controller: frozenCapabilities({ orgRoot: true, singleSeat: true, mayClaimWork: true, mayWakeReports: true, mayUseMissionBridge: true, mayReportMissionBridge: true, mayMutateMissionBridge: true }),
  // These are generic action-class grants, not role-name mechanics. Shipped
  // values follow each directions sheet; a custom role can receive or lose the
  // same fields regardless of its id or place in the graph.
  'shadow-manager': frozenCapabilities({ mayUseMissionBridge: true, mayReportMissionBridge: true }),
  planner: frozenCapabilities({ mayUseMissionBridge: true, mayReportMissionBridge: true }),
  manager: frozenCapabilities({ mayClaimWork: true, mayWakeReports: true, mayUseMissionBridge: true, mayReportMissionBridge: true, mayMutateMissionBridge: true }),
  'coordinator-assistant': frozenCapabilities({ mayUseMissionBridge: true, mayReportMissionBridge: true }),
  builder: frozenCapabilities({ mayClaimWork: true, mayWakeReports: true, requiresMutationContext: true, mayUseMissionBridge: true, mayReportMissionBridge: true, mayMutateMissionBridge: true }),
  reviewer: frozenCapabilities({ mayUseMissionBridge: true, mayReportMissionBridge: true }),
  worker: frozenCapabilities({ mayClaimWork: true, mayWakeReports: true, requiresMutationContext: true, mayUseMissionBridge: true, mayReportMissionBridge: true, mayMutateMissionBridge: true }),
  observer: frozenCapabilities({ mayUseMissionBridge: true, mayReportMissionBridge: true })
});
// Classifiers are orthogonal to an agent's functional role.  In particular,
// supervision is derived from the declared management graph so an agent can
// remain a builder, reviewer, or any other role while also being a supervisor.
const CLASSIFIERS = Object.freeze(['supervisor']);
// Reuses the edge vocabulary already generated for the activity contracts
// rather than inventing a second one that would drift.
const RELATION_TYPES = Object.freeze(['manages', 'reviews', 'delegates_to', 'escalates_to']);
const PROVIDERS = Object.freeze(['codex', 'claude', 'gemini', 'grok', 'local', 'none']);

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Deliberately the same shape as ROLE_ID in src/lib/custom-role-store.js, which
// is what actually mints a custom role. Two patterns that must agree are a
// drift risk, so the store's test asserts they accept the same strings.
const ROLE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PHASE_ID = /^Q[0-9]{1,3}$/;
const SCOPE_RULE_KEY = /^[a-z][a-z0-9._:-]{0,63}$/;
const REQUEST_ID = /^R[0-9]{1,4}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const TIERS = Object.freeze(['cheap', 'standard', 'premium']);

/* THE DECLARED-ORG SIZE BOUND IS A DOCUMENT GUARD, NOT AN ENTITLEMENT.
 *
 * 64 sat here as a bare literal with no constant, no environment variable and
 * no configuration key, so the only way to run a tree larger than 64 declared
 * seats was to edit this file and promote a build. That made an arbitrary
 * validator limit look like an account limit to everyone above it.
 *
 * It is none of those things. It bounds how many rows this DOCUMENT may carry,
 * so a malformed or runaway overlay cannot be parsed without limit. The real
 * concurrency limits live elsewhere and are unaffected by this value:
 *   - provider seat pools      src/lib/mission-bridge/actions.js  (BRIDGE_ALL_SEATS_BUSY)
 *   - simultaneous starts      src/lib/agent-resource-admission.js (maxConcurrentStarts)
 *   - per-parent fan-out       src/lib/controller-launch-record.js (MAX_FAN_OUT)
 * Raising this bound does NOT raise any of those, and must not be described as
 * raising "how many agents can run".
 *
 * Resolution order: an explicit options.maxAgents, then MC_MAX_AGENTS in the
 * environment, then the saved fleet.max_declared_agents setting, then DEFAULT_MAX_AGENTS. A value of 0 -- or 'unlimited', 'none',
 * 'off' -- removes the bound entirely. The DEFAULT IS UNCHANGED at 64, so no
 * existing install changes behaviour until someone deliberately sets it.
 *
 * Seat release is a separate lifecycle operation. Removing a circle calls
 * releaseSeat; changing this document bound does not alter that lifecycle. */
const DEFAULT_MAX_AGENTS = 64;
const UNBOUNDED_WORDS = Object.freeze(['unlimited', 'none', 'off']);

function savedMaxAgents({ env = process.env, fileSystem = fs } = {}) {
  let document;
  try { document = JSON.parse(fileSystem.readFileSync(resolveSettingsValuesPath({ env }), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    fail('AGENT_ORG_LIMIT_INVALID', 'The saved organisation limit could not be read. Correct Settings before adding agents.');
  }
  if (!plain(document) || !plain(document.values) || !Number.isFinite(document.revision)) {
    fail('AGENT_ORG_LIMIT_INVALID', 'The saved settings document is invalid. Correct Settings before adding agents.');
  }
  const id = 'fleet.max_declared_agents';
  if (!Object.hasOwn(document.values, id)) return undefined;
  const value = document.values[id];
  if (!Number.isSafeInteger(value) || value < 0
    || !['user', 'installer', 'default'].includes(document.provenance?.[id]?.source)) {
    fail('AGENT_ORG_LIMIT_INVALID', 'The saved organisation limit must be a non-negative whole number with recorded provenance.');
  }
  return value;
}

function resolveMaxAgents(options = {}) {
  const supplied = options && Object.prototype.hasOwnProperty.call(options, 'maxAgents')
    ? options.maxAgents
    : undefined;
  const env = options.env || process.env;
  const raw = supplied !== undefined ? supplied
    : (env.MC_MAX_AGENTS !== undefined && env.MC_MAX_AGENTS !== '' ? env.MC_MAX_AGENTS : savedMaxAgents({ env, fileSystem: options.fileSystem || fs }));
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_AGENTS;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      fail('AGENT_ORG_INVALID', 'maxAgents must be a non-negative integer, or 0 for no bound.', { field: 'maxAgents' });
    }
    return raw === 0 ? null : raw;
  }
  const text = String(raw).trim().toLowerCase();
  if (UNBOUNDED_WORDS.includes(text)) return null;
  if (!/^[0-9]+$/.test(text)) {
    fail('AGENT_ORG_INVALID',
      `maxAgents must be a non-negative integer or one of ${UNBOUNDED_WORDS.join(', ')}.`,
      { field: 'maxAgents' });
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed)) fail('AGENT_ORG_INVALID', 'maxAgents must be a safe non-negative integer.', { field: 'maxAgents' });
  return parsed === 0 ? null : parsed;
}
// Parentheses are allowed because real display names qualify themselves —
// "Sol (Codex high tier)". Angle brackets, quotes, and control characters stay
// out so a name can never carry markup into the browser.
const DISPLAY_NAME = /^[\p{L}\p{N} ._'()-]{1,64}$/u;

// Secret-shaped content must never enter a record that is projected to a
// browser. Mirrors the posture used by the card layer and the search indexer.
const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/, /sk-[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /xox[a-z]?-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bAKIA[0-9A-Z]{16}\b/
];

class AgentOrgError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AgentOrgError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new AgentOrgError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function looksSecret(value) {
  return SECRET_PATTERNS.some(pattern => pattern.test(String(value)));
}

function assertNoSecret(value, label) {
  if (looksSecret(value)) fail('AGENT_ORG_SECRET_REJECTED', `${label} contains secret-shaped content.`, { field: label });
}

function hasExactRoleCapabilities(input) {
  return plain(input)
    && Object.keys(input).length === ROLE_CAPABILITY_FIELDS.length
    && ROLE_CAPABILITY_FIELDS.every(field => Object.hasOwn(input, field) && typeof input[field] === 'boolean');
}

function normalizeRoleCapabilities(input, label = 'role capabilities', {
  legacyMayUseMissionBridge = false,
  legacyMayReportMissionBridge = legacyMayUseMissionBridge,
  legacyMayMutateMissionBridge = false
} = {}) {
  // Schema-v1 installations may still carry the original five-field record.
  // Treat the new workflow authority as absent on those stored records rather
  // than corrupting the role or silently granting it.  Every normalized value
  // returned from here has the current exact shape.
  const previousFields = ROLE_CAPABILITY_FIELDS.filter(field => !['mayReportMissionBridge', 'mayMutateMissionBridge'].includes(field));
  const originalFields = previousFields.filter(field => field !== 'mayUseMissionBridge');
  const previous = plain(input)
    && Object.keys(input).length === previousFields.length
    && previousFields.every(field => Object.hasOwn(input, field) && typeof input[field] === 'boolean');
  const original = plain(input)
    && Object.keys(input).length === originalFields.length
    && originalFields.every(field => Object.hasOwn(input, field) && typeof input[field] === 'boolean');
  if (!hasExactRoleCapabilities(input) && !previous && !original) {
    fail('AGENT_ORG_INVALID', `${label} must contain exactly ${ROLE_CAPABILITY_FIELDS.join(', ')}.`, { field: label });
  }
  return frozenCapabilities(original
    ? {
      ...input,
      mayUseMissionBridge: legacyMayUseMissionBridge === true,
      mayReportMissionBridge: legacyMayReportMissionBridge === true,
      mayMutateMissionBridge: legacyMayMutateMissionBridge === true
    }
    : previous
      ? {
        ...input,
        mayReportMissionBridge: legacyMayReportMissionBridge === true,
        mayMutateMissionBridge: legacyMayMutateMissionBridge === true
      }
      : input);
}

function normalizeScopeActivation(input) {
  if (input === undefined || input === null) return null;
  if (!plain(input)
      || Object.keys(input).length !== 4
      || !Object.hasOwn(input, 'ruleKey')
      || !Object.hasOwn(input, 'sourceRequestId')
      || !Object.hasOwn(input, 'model')
      || !Object.hasOwn(input, 'tier')) {
    fail('AGENT_ORG_INVALID', 'scopeActivation must contain exactly ruleKey, sourceRequestId, model, and tier.', { field: 'scopeActivation' });
  }
  const ruleKey = String(input.ruleKey ?? '');
  const sourceRequestId = String(input.sourceRequestId ?? '');
  const model = String(input.model ?? '');
  const tier = String(input.tier ?? '');
  if (!SCOPE_RULE_KEY.test(ruleKey)) fail('AGENT_ORG_INVALID', 'scopeActivation.ruleKey is invalid.', { field: 'scopeActivation.ruleKey' });
  if (!REQUEST_ID.test(sourceRequestId)) fail('AGENT_ORG_INVALID', 'scopeActivation.sourceRequestId is invalid.', { field: 'scopeActivation.sourceRequestId' });
  if (!MODEL_ID.test(model)) fail('AGENT_ORG_INVALID', 'scopeActivation.model is invalid.', { field: 'scopeActivation.model' });
  if (!TIERS.includes(tier)) fail('AGENT_ORG_INVALID', 'scopeActivation.tier is invalid.', { field: 'scopeActivation.tier' });
  assertNoSecret(model, 'scopeActivation.model');
  return Object.freeze({ ruleKey, sourceRequestId, model, tier });
}

// IDENTIFIERS A ROLE MAY NEVER TAKE.
//
// These three words already mean "this is NOT an agent" everywhere else in the
// product, and they mean it in code that decides routing and attribution, not
// merely in display text:
//
//   src/lib/agent-lane.js:172        dispatcher === 'owner' bypasses assertAgentId
//   src/lib/agent-presence.js:381    dispatcher === 'owner' sets origin 'user'
//   src/lib/agent-wake.js:200        same sentinel on a launch spec
//   src/lib/owner-chat.js:564        'owner' is reserved for words HE typed
//   src/chatbox-feed.js:103          NOT_AGENTS = ['owner', 'me', 'act']
//
// A custom role that could call itself `owner` would put an operator-authored
// string into the one position several modules read as proof that no agent is
// involved. That is an impersonation seam, so the whole set is refused here
// rather than only the one word that happens to be checked most often.
const RESERVED_ROLE_IDS = Object.freeze(['owner', 'me', 'act']);

/**
 * Undefined means only the shipped defaults. Supplied entries overlay those
 * defaults or add custom roles; they never remove an unmentioned default.
 * Workflow capabilities are bounded data on the definition. Missing custom
 * capabilities inherit the declared base or fail closed when there is no base.
 */
function normalizeKnownRoles(knownRoles) {
  const defaults = new Map(ROLES.map(id => [id, Object.freeze({
    baseDefaultRole: null,
    capabilities: DEFAULT_ROLE_CAPABILITIES[id]
  })]));
  if (knownRoles === undefined || knownRoles === null) return defaults;
  if (!Array.isArray(knownRoles)) {
    fail('AGENT_ORG_INVALID', 'knownRoles must be an array of role-definition entries.', { field: 'knownRoles' });
  }
  const declared = new Map(defaults);
  const seen = new Set();
  for (const entry of knownRoles) {
    if (!plain(entry) || !Object.hasOwn(entry, 'id')
        || Object.keys(entry).some(key => !['id', 'baseDefaultRole', 'capabilities'].includes(key))) {
      fail('AGENT_ORG_INVALID', 'each knownRoles entry must be an object with an id and optional baseDefaultRole/capabilities.', { field: 'knownRoles' });
    }
    const roleId = String(entry.id);
    if (!ROLE_ID.test(roleId)) {
      fail('AGENT_ORG_INVALID', `knownRoles contains an invalid role id "${roleId}".`, { field: 'knownRoles' });
    }
    if (RESERVED_ROLE_IDS.includes(roleId)) {
      fail('AGENT_ORG_RESERVED_ROLE', `Role id "${roleId}" is reserved and cannot name a role.`, { field: 'knownRoles', roleId });
    }
    if (seen.has(roleId)) {
      fail('AGENT_ORG_INVALID', `knownRoles repeats role "${roleId}".`, { field: 'knownRoles', roleId });
    }
    seen.add(roleId);
    const base = entry.baseDefaultRole === undefined || entry.baseDefaultRole === null ? null : String(entry.baseDefaultRole);
    if (base !== null && !ROLES.includes(base)) {
      fail('AGENT_ORG_INVALID', `knownRoles entry "${roleId}" names an unknown baseDefaultRole "${base}".`, { field: 'knownRoles', roleId });
    }
    if (ROLES.includes(roleId) && base !== null) {
      fail('AGENT_ORG_INVALID', `Default role "${roleId}" cannot declare a baseDefaultRole.`, { field: 'knownRoles', roleId });
    }
    const inherited = ROLES.includes(roleId)
      ? DEFAULT_ROLE_CAPABILITIES[roleId]
      : (base ? DEFAULT_ROLE_CAPABILITIES[base] : frozenCapabilities({}));
    const capabilities = entry.capabilities === undefined
      ? inherited
      : normalizeRoleCapabilities(entry.capabilities, `knownRoles.${roleId}.capabilities`, {
        legacyMayUseMissionBridge: inherited.mayUseMissionBridge,
        legacyMayReportMissionBridge: inherited.mayReportMissionBridge,
        legacyMayMutateMissionBridge: inherited.mayMutateMissionBridge
      });
    declared.set(roleId, Object.freeze({ baseDefaultRole: base, capabilities }));
  }
  return declared;
}

/**
 * Compatibility projection for claim consumers that have not moved to the
 * complete roleCapabilitiesByRole record yet.
 */
function claimPostureFor(roleId, roleRecord) {
  return hasExactRoleCapabilities(roleRecord?.capabilities)
    && roleRecord.capabilities.mayClaimWork === true;
}

/**
 * Read one bounded workflow capability. Unknown/non-normalized custom roles
 * fail closed; consumers must not rebuild a second list of role names.
 */
function roleHasCapability(org, roleId, capability) {
  if (!org || typeof roleId !== 'string' || !ROLE_CAPABILITY_FIELDS.includes(capability)) return false;
  const byRole = org.roleCapabilitiesByRole;
  if (!plain(byRole) || !Object.hasOwn(byRole, roleId)) return false;
  const capabilities = byRole[roleId];
  return hasExactRoleCapabilities(capabilities) && capabilities[capability] === true;
}

// Compatibility name for existing claim consumers. Waking reports has its own
// capability and must no longer be inferred from a role's claim posture.
function roleMayAct(org, roleId) {
  return roleHasCapability(org, roleId, 'mayClaimWork');
}

// --- agents -----------------------------------------------------------------

function normalizeAgent(input, options = {}) {
  if (!plain(input)) fail('AGENT_ORG_INVALID', 'An agent entry must be an object.');
  const id = String(input.id ?? '');
  if (!AGENT_ID.test(id)) {
    fail('AGENT_ORG_INVALID', 'Agent id must be lowercase alphanumeric with dashes or underscores, 1-64 chars.', { field: 'id' });
  }
  const displayName = String(input.displayName ?? id);
  if (!DISPLAY_NAME.test(displayName)) {
    fail('AGENT_ORG_INVALID', 'Agent displayName must be 1-64 printable characters.', { field: 'displayName' });
  }
  assertNoSecret(displayName, 'displayName');

  // A caller that knows about custom roles passes them in; a caller that does
  // not gets exactly the nine declared roles and nothing else. The default is
  // the closed one on purpose, and it is the same shape as `knownPhases` in
  // normalizeOrg below: this module never invents vocabulary, it is told what
  // exists and refuses everything else. An operator who has defined a custom
  // role therefore cannot have it silently accepted by a code path that was
  // never taught to check whether the role still exists.
  const role = String(input.role ?? '');
  const allowedRoles = options.allowedRoles instanceof Map ? options.allowedRoles : normalizeKnownRoles(options.knownRoles);
  if (!allowedRoles.has(role)) {
    fail('AGENT_ORG_INVALID', `Agent role must be one of: ${[...allowedRoles.keys()].join(', ')}.`, { field: 'role' });
  }

  const provider = String(input.provider ?? 'none');
  if (!PROVIDERS.includes(provider)) {
    fail('AGENT_ORG_INVALID', `Agent provider must be one of: ${PROVIDERS.join(', ')}.`, { field: 'provider' });
  }

  if (typeof input.enabled !== 'boolean') {
    fail('AGENT_ORG_INVALID', 'Agent enabled must be a boolean; an unknown state is not a default.', { field: 'enabled' });
  }
  const scopeActivation = normalizeScopeActivation(input.scopeActivation);
  if (input.enabled && scopeActivation !== null) {
    fail('AGENT_ORG_INVALID', 'scopeActivation is only valid for a disabled-by-default agent.', { field: 'scopeActivation' });
  }

  const assignedPhase = input.assignedPhase === null || input.assignedPhase === undefined
    ? null
    : String(input.assignedPhase);
  if (assignedPhase !== null && !PHASE_ID.test(assignedPhase)) {
    fail('AGENT_ORG_INVALID', 'assignedPhase must be a queue phase id like "Q21", or null.', { field: 'assignedPhase' });
  }

  const phasePriority = input.phasePriority === undefined ? [] : input.phasePriority;
  if (!Array.isArray(phasePriority)) fail('AGENT_ORG_INVALID', 'phasePriority must be an array.', { field: 'phasePriority' });
  const priority = phasePriority.map(entry => {
    const phase = String(entry);
    if (!PHASE_ID.test(phase)) fail('AGENT_ORG_INVALID', 'phasePriority entries must be queue phase ids.', { field: 'phasePriority' });
    return phase;
  });
  if (new Set(priority).size !== priority.length) {
    fail('AGENT_ORG_INVALID', 'phasePriority must not repeat a phase.', { field: 'phasePriority' });
  }

  // nodeId names the tree node this seat was minted for, kept apart from `id`
  // so a seat's own identifier can be stable while the tree node it serves is
  // torn down and recreated. Absent for a seat nobody has bound to a node yet,
  // or a seat written before this field existed -- both read back as null,
  // never as a missing property a caller has to guard for.
  const nodeId = input.nodeId === null || input.nodeId === undefined ? null : String(input.nodeId);
  if (nodeId !== null && !AGENT_ID.test(nodeId)) {
    fail('AGENT_ORG_INVALID', 'Agent nodeId must be lowercase alphanumeric with dashes or underscores, 1-64 chars, or null.', { field: 'nodeId' });
  }
  // An optional empty choice belongs only to a tree-bound Worker transport
  // seat. The role still supplies mechanical authority; it supplies no role
  // instructions when the person deliberately left the tree role blank.
  const hasRoleSelection = Object.hasOwn(input, 'roleSelection');
  if (hasRoleSelection && (input.roleSelection !== '' || role !== 'worker' || !nodeId)) {
    fail('AGENT_ORG_INVALID', 'An empty role selection requires a Worker seat bound to a tree node.', { field: 'roleSelection' });
  }

  return Object.freeze({
    id, displayName, role, provider, enabled: input.enabled,
    scopeActivation, assignedPhase, phasePriority: Object.freeze(priority), nodeId,
    ...(hasRoleSelection ? { roleSelection: '' } : {})
  });
}

// --- relationships ----------------------------------------------------------

function normalizeRelationship(input) {
  if (!plain(input)) fail('AGENT_ORG_INVALID', 'A relationship entry must be an object.');
  const from = String(input.from ?? '');
  const to = String(input.to ?? '');
  const type = String(input.type ?? '');
  if (!AGENT_ID.test(from)) fail('AGENT_ORG_INVALID', 'Relationship "from" must be an agent id.', { field: 'from' });
  if (!AGENT_ID.test(to)) fail('AGENT_ORG_INVALID', 'Relationship "to" must be an agent id.', { field: 'to' });
  if (!RELATION_TYPES.includes(type)) {
    fail('AGENT_ORG_INVALID', `Relationship type must be one of: ${RELATION_TYPES.join(', ')}.`, { field: 'type' });
  }
  if (from === to) {
    fail('AGENT_ORG_SELF_RELATION', 'An agent cannot hold a relationship to itself.', { field: 'from' });
  }
  return Object.freeze({ from, to, type });
}

/**
 * Reject a management cycle. A cycle means no root, which means no agent is
 * ultimately accountable — the exact failure this model exists to prevent.
 */
function assertNoManagementCycle(relationships) {
  const edges = new Map();
  for (const relation of relationships) {
    if (relation.type !== 'manages') continue;
    const bucket = edges.get(relation.from);
    if (bucket) bucket.push(relation.to);
    else edges.set(relation.from, [relation.to]);
  }
  const VISITING = 1;
  const DONE = 2;
  const marks = new Map();
  const walk = (node, path) => {
    const mark = marks.get(node);
    if (mark === DONE) return;
    if (mark === VISITING) {
      fail('AGENT_ORG_CYCLE', `Management relationships form a cycle: ${[...path, node].join(' -> ')}.`);
    }
    marks.set(node, VISITING);
    for (const next of edges.get(node) ?? []) walk(next, [...path, node]);
    marks.set(node, DONE);
  };
  for (const node of edges.keys()) walk(node, []);
}

/** Every agent named in a relationship must exist. */
function assertRelationshipsResolve(agents, relationships) {
  const known = new Set(agents.map(agent => agent.id));
  for (const relation of relationships) {
    for (const side of ['from', 'to']) {
      if (!known.has(relation[side])) {
        fail('AGENT_ORG_UNKNOWN_AGENT', `Relationship references unknown agent "${relation[side]}".`, { field: side });
      }
    }
  }
}

/** Exactly one role-defined organisation root, regardless of the role's id. */
function assertRoleCardinality(agents, allowedRoles) {
  const roots = agents.filter(agent => allowedRoles.get(agent.role)?.capabilities.orgRoot === true);
  if (roots.length === 0) fail('AGENT_ORG_NO_CONTROLLER', 'The declared org needs exactly one root role; it has none.');
  if (roots.length > 1) {
    fail('AGENT_ORG_MULTIPLE_CONTROLLERS',
      `The declared org needs exactly one root role; it has ${roots.length}: ${roots.map(a => a.id).join(', ')}.`);
  }
  for (const [roleId, record] of allowedRoles) {
    if (!record.capabilities.singleSeat) continue;
    const holders = agents.filter(agent => agent.role === roleId);
    if (holders.length > 1) {
      fail('AGENT_ORG_ROLE_SEAT_LIMIT', `Role "${roleId}" allows one seat; it has ${holders.length}.`, {
        roleId,
        agents: holders.map(agent => agent.id)
      });
    }
  }
}

/** No agent may have two managers — accountability must be unambiguous. */
function assertSingleManager(relationships) {
  const managerOf = new Map();
  for (const relation of relationships) {
    if (relation.type !== 'manages') continue;
    const existing = managerOf.get(relation.to);
    if (existing && existing !== relation.from) {
      fail('AGENT_ORG_MULTIPLE_MANAGERS',
        `Agent "${relation.to}" is managed by both "${existing}" and "${relation.from}".`);
    }
    managerOf.set(relation.to, relation.from);
  }
}

// --- model ------------------------------------------------------------------

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * Validate and normalise a complete declared org. Returns a frozen model with
 * a content hash so a caller can detect drift without diffing structures.
 */
function normalizeOrg(input, options = {}) {
  if (!plain(input)) fail('AGENT_ORG_INVALID', 'The declared org must be an object.');

  const agentsInput = Array.isArray(input.agents) ? input.agents : null;
  if (!agentsInput) fail('AGENT_ORG_INVALID', 'The declared org must carry an agents array.', { field: 'agents' });
  if (agentsInput.length === 0) fail('AGENT_ORG_INVALID', 'The declared org must contain at least one agent.', { field: 'agents' });
  const maxAgents = resolveMaxAgents(options);
  if (maxAgents !== null && agentsInput.length > maxAgents) {
    fail('AGENT_ORG_INVALID', `The declared org is bounded to ${maxAgents} agents.`, { field: 'agents' });
  }

  const allowedRoles = normalizeKnownRoles(options.knownRoles);
  const agents = agentsInput.map(agent => normalizeAgent(agent, { allowedRoles }));
  const ids = agents.map(agent => agent.id);
  if (new Set(ids).size !== ids.length) fail('AGENT_ORG_DUPLICATE_AGENT', 'Agent ids must be unique.', { field: 'agents' });

  const relationshipsInput = Array.isArray(input.relationships) ? input.relationships : [];
  if (relationshipsInput.length > 256) {
    fail('AGENT_ORG_INVALID', 'The declared org is bounded to 256 relationships.', { field: 'relationships' });
  }
  const relationships = relationshipsInput.map(normalizeRelationship);
  const seen = new Set();
  for (const relation of relationships) {
    const key = `${relation.type}:${relation.from}->${relation.to}`;
    if (seen.has(key)) fail('AGENT_ORG_DUPLICATE_RELATION', `Duplicate relationship ${key}.`);
    seen.add(key);
  }

  assertRelationshipsResolve(agents, relationships);
  assertRoleCardinality(agents, allowedRoles);
  assertSingleManager(relationships);
  assertNoManagementCycle(relationships);

  // A phase an agent is assigned to, or prioritises, must be a phase that
  // exists. Callers that cannot supply the queue's phase list skip this rather
  // than guessing — an unchecked id is better than a wrongly rejected one.
  const knownPhases = Array.isArray(options.knownPhases) ? new Set(options.knownPhases.map(String)) : null;
  if (knownPhases) {
    for (const agent of agents) {
      if (agent.assignedPhase && !knownPhases.has(agent.assignedPhase)) {
        fail('AGENT_ORG_UNKNOWN_PHASE', `Agent "${agent.id}" is assigned unknown phase "${agent.assignedPhase}".`, { field: 'assignedPhase' });
      }
      for (const phase of agent.phasePriority) {
        if (!knownPhases.has(phase)) {
          fail('AGENT_ORG_UNKNOWN_PHASE', `Agent "${agent.id}" prioritises unknown phase "${phase}".`, { field: 'phasePriority' });
        }
      }
    }
  }

  const revision = input.revision === undefined ? 1 : input.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail('AGENT_ORG_INVALID', 'revision must be a positive integer.', { field: 'revision' });
  }

  const body = { schemaVersion: SCHEMA_VERSION, agents, relationships };
  const contentHash = crypto.createHash('sha256')
    .update(`toolsenabled.agent-org.v${SCHEMA_VERSION}\0${canonical(body)}`, 'utf8')
    .digest('hex');

  // Derived, and deliberately NOT part of `body` above: it is a restatement of
  // what the role vocabulary means, not a fact about this org's content, so
  // folding it into contentHash would change the hash of an org whose declared
  // agents and relationships had not changed at all.
  const roleCapabilitiesByRole = Object.freeze(Object.fromEntries(
    [...allowedRoles.entries()].map(([roleId, record]) => [roleId, record.capabilities])
  ));
  const claimPostureByRole = Object.freeze(Object.fromEntries(
    [...allowedRoles.entries()].map(([roleId, record]) => [roleId, claimPostureFor(roleId, record)])
  ));

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    revision,
    agents: Object.freeze(agents),
    relationships: Object.freeze(relationships),
    roleCapabilitiesByRole,
    claimPostureByRole,
    contentHash,
    // Stated on the record itself so a consumer cannot mistake declared intent
    // for observed fact, and cannot read authority into it.
    stateKind: 'declared',
    grantsAuthority: false
  });
}

/** Refuse to answer relationship questions about an agent the org does not name. */
function requireAgent(org, agentId) {
  const agent = org.agents.find(entry => entry.id === agentId);
  if (!agent) {
    fail('AGENT_ORG_UNKNOWN_AGENT', `The declared org does not contain agent "${agentId}".`, { field: 'agentId' });
  }
  return agent;
}

/** The manager of a known agent, or null at the root. */
function managerOf(org, agentId) {
  requireAgent(org, agentId);
  const relation = org.relationships.find(entry => entry.type === 'manages' && entry.to === agentId);
  return relation ? relation.from : null;
}

/** The one role-defined root seat. normalizeOrg has already enforced one. */
function rootAgentOf(org) {
  if (!org || !Array.isArray(org.agents)) return null;
  return org.agents.find(agent => roleHasCapability(org, agent.role, 'orgRoot')) || null;
}

/** Direct reports of a known agent, in declared order. */
function reportsOf(org, agentId) {
  requireAgent(org, agentId);
  return org.relationships.filter(entry => entry.type === 'manages' && entry.from === agentId).map(entry => entry.to);
}

/** Classifiers derived from declared relationships, never caller assertions. */
function classifiersOf(org, agentId) {
  const classifiers = reportsOf(org, agentId).length > 0 ? ['supervisor'] : [];
  return Object.freeze(classifiers);
}

/** Whether an agent is responsible for at least one declared direct report. */
function isSupervisor(org, agentId) {
  return classifiersOf(org, agentId).includes('supervisor');
}

/** A compact role-plus-classifier view for routing alerts without conflation. */
function classifyAgent(org, agentId) {
  const agent = requireAgent(org, agentId);
  return Object.freeze({
    agentId: agent.id,
    role: agent.role,
    classifiers: classifiersOf(org, agentId)
  });
}

// Compatibility inventory for older diagnostics. It is derived from the
// shipped definition data and is never consulted to decide a live role's
// posture; installed/default overrides and custom roles live in the normalized
// roleCapabilitiesByRole map.
const NON_CLAIMING_ROLES = Object.freeze(
  ROLES.filter(roleId => DEFAULT_ROLE_CAPABILITIES[roleId].mayClaimWork !== true)
);

/**
 * Whether an agent may claim a phase. Disabled agents may claim nothing. An
 * agent with an explicit priority list is limited to it; an agent with no list
 * is unrestricted, so the model stays useful before it is fully populated.
 *
 * The decision comes from the normalized definition's explicit capability
 * record. A custom role inherits its base unless the operator supplies a full
 * replacement; a no-base role defaults closed. A hand-built object without a
 * normalized custom-role map also fails closed for unknown roles.
 */
function mayClaim(org, agentId, phase) {
  const agent = org.agents.find(entry => entry.id === agentId);
  if (!agent || !agent.enabled) return false;
  if (!roleMayAct(org, agent.role)) return false;
  if (agent.phasePriority.length === 0) return true;
  return agent.phasePriority.includes(String(phase));
}

module.exports = Object.freeze({
  SCHEMA_VERSION, ROLES, CLASSIFIERS, RELATION_TYPES, PROVIDERS,
  DEFAULT_MAX_AGENTS, resolveMaxAgents,
  RESERVED_ROLE_IDS, NON_CLAIMING_ROLES, ROLE_ID,
  ROLE_CAPABILITY_FIELDS, DEFAULT_ROLE_CAPABILITIES,
  AgentOrgError,
  normalizeRoleCapabilities, normalizeAgent, normalizeRelationship, normalizeOrg,
  managerOf, rootAgentOf, reportsOf, classifiersOf, isSupervisor, classifyAgent,
  roleHasCapability, roleMayAct, mayClaim
});
