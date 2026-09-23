'use strict';

// Durable custom-role definitions layered over the declared defaults. This is
// deliberately a role-definition store, not another organisation schema or
// rule language: agent-org.json remains the declared organisation.

const { createStateStore } = require('./state-store');
const {
  ROLES,
  RESERVED_ROLE_IDS,
  DEFAULT_ROLE_CAPABILITIES,
  normalizeRoleCapabilities
} = require('./agent-org');
const { roleRules } = require('./agent-roles');
const { defaultFunctionPolicy, normalizeFunctionPolicy } = require('./role-functions');

const NAMESPACE = 'custom-roles';
const SCHEMA_VERSION = 1;
const MAX_CUSTOM_ROLES = 10;
const ROLE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RULE_FIELDS = Object.freeze(['owns', 'mustNot', 'handoff']);
const STRUCTURAL_CAPABILITY_FIELDS = Object.freeze(['orgRoot', 'singleSeat']);
const MAX_RULE_TEXT = 6000;

class CustomRoleError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CustomRoleError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new CustomRoleError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys, label) {
  if (!plain(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    fail('CUSTOM_ROLE_INVALID', `${label} has unsupported or missing fields.`, { field: label });
  }
}

function requiredAndOptionalKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  if (!plain(value)
      || !required.every(key => Object.hasOwn(value, key))
      || Object.keys(value).some(key => !allowed.has(key))) {
    fail('CUSTOM_ROLE_INVALID', `${label} has unsupported or missing fields.`, { field: label });
  }
}

function frozenClone(value) {
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function ruleText(value, field) {
  if (typeof value !== 'string' || value.length > MAX_RULE_TEXT || value !== value.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail('CUSTOM_ROLE_INVALID', `${field} must be trimmed readable text of at most ${MAX_RULE_TEXT} characters.`, { field });
  }
  return value;
}

function normalizeRules(input) {
  exactKeys(input, RULE_FIELDS, 'rules');
  return Object.freeze({
    owns: ruleText(input.owns, 'rules.owns'),
    mustNot: ruleText(input.mustNot, 'rules.mustNot'),
    handoff: ruleText(input.handoff, 'rules.handoff')
  });
}

// These are baseline definitions, not live organisation state. The rule TEXT is
// no longer written here: it is projected from src/lib/agent-roles.js, the
// shipped default role library, which is also what the onboarding packet
// describes.
//
// This file used to hold its own wording for the same nine roles. Nothing was
// wrong with it, and that was the problem: a user editing "the default rules"
// here saw one sentence per role while the onboarding packet handed their agent
// a different one, and neither surface admitted the other existed. Rolling a
// default back therefore restored text the agent had never been given.
//
// The set and its order still come from ROLES, so a default added to the org
// vocabulary cannot silently disappear from this store.
const DEFAULT_ROLE_IDS = new Set(ROLES);
const DEFAULT_ROLE_DEFINITIONS = deepFreeze(ROLES.map(id => {
  const rules = roleRules(id);
  if (!rules) throw new Error(`The default role library has no definition for declared role "${id}".`);
  return {
    id,
    baseDefaultRole: null,
    rules: normalizeRules(rules),
    capabilities: DEFAULT_ROLE_CAPABILITIES[id],
    ...defaultFunctionPolicy(id)
  };
}));

const DEFAULTS_BY_ID = new Map(DEFAULT_ROLE_DEFINITIONS.map(definition => [definition.id, definition]));

function normalizeDefinition(input, { custom }) {
  if (!plain(input) || !Object.hasOwn(input, 'id') || !Object.hasOwn(input, 'rules')
    || Object.keys(input).some(key => !['id', 'baseDefaultRole', 'rules', 'capabilities', 'functions', 'requiresDirectUserAuthorization'].includes(key))) {
    fail('CUSTOM_ROLE_INVALID', 'definition has unsupported or missing fields.', { field: 'definition' });
  }
  if (typeof input.id !== 'string' || !ROLE_ID.test(input.id)) {
    fail('CUSTOM_ROLE_INVALID', 'definition.id is invalid.', { field: 'definition.id' });
  }
  if (custom && DEFAULT_ROLE_IDS.has(input.id)) {
    fail('CUSTOM_ROLE_DEFAULT_COLLISION', `Custom role "${input.id}" collides with a default role.`, { id: input.id });
  }
  // A free-text id may not be one of the words that already mean "not an
  // agent" elsewhere in the product. The set and the reasoning live in
  // src/lib/agent-org.js next to the routing code that reads them, so this is
  // a reference and not a second copy that could drift out of agreement with
  // the modules actually doing the checking.
  if (RESERVED_ROLE_IDS.includes(input.id)) {
    fail('CUSTOM_ROLE_RESERVED_ID', `Role id "${input.id}" is reserved and cannot name a role.`, { id: input.id });
  }
  if (!custom && !DEFAULT_ROLE_IDS.has(input.id)) {
    fail('CUSTOM_ROLE_INVALID', 'A default-role definition must name a declared default role.', { field: 'definition.id' });
  }
  const baseDefaultRole = input.baseDefaultRole === undefined ? null : input.baseDefaultRole;
  if (baseDefaultRole !== null && (typeof baseDefaultRole !== 'string' || !DEFAULT_ROLE_IDS.has(baseDefaultRole))) {
    fail('CUSTOM_ROLE_INVALID', 'baseDefaultRole must be null or a default role id.', { field: 'definition.baseDefaultRole' });
  }
  if (!custom && baseDefaultRole !== null) {
    fail('CUSTOM_ROLE_INVALID', 'A default role cannot have a baseDefaultRole.', { field: 'definition.baseDefaultRole' });
  }
  const inherited = custom
    ? (baseDefaultRole ? DEFAULT_ROLE_CAPABILITIES[baseDefaultRole] : Object.freeze({
      orgRoot: false,
      singleSeat: false,
      mayClaimWork: false,
      mayWakeReports: false,
      requiresMutationContext: false,
      mayUseMissionBridge: false,
      mayReportMissionBridge: false,
      mayMutateMissionBridge: false
    }))
    : DEFAULT_ROLE_CAPABILITIES[input.id];
  let capabilities;
  try {
    capabilities = input.capabilities === undefined
      ? inherited
      : normalizeRoleCapabilities(input.capabilities, 'definition.capabilities', {
        legacyMayUseMissionBridge: inherited.mayUseMissionBridge,
        legacyMayReportMissionBridge: inherited.mayReportMissionBridge,
        legacyMayMutateMissionBridge: inherited.mayMutateMissionBridge
      });
  } catch (error) {
    fail('CUSTOM_ROLE_INVALID', error.message, { field: 'definition.capabilities' });
  }
  // Stored/custom roles without a function field retain their previous normal
  // surface. Only the shipped definitions above deliberately gain new controls.
  const functionPolicy = normalizeFunctionPolicy(input, defaultFunctionPolicy(custom ? baseDefaultRole : input.id, { includeSlotConfiguration: false }));
  return Object.freeze({ id: input.id, baseDefaultRole, rules: normalizeRules(input.rules), capabilities, ...functionPolicy });
}

function assertStructuralCapabilitiesUnchanged(existing, candidate) {
  for (const field of STRUCTURAL_CAPABILITY_FIELDS) {
    if (existing.capabilities[field] !== candidate.capabilities[field]) {
      fail('CUSTOM_ROLE_STRUCTURE_READ_ONLY',
        `${field} cannot be changed after a role is created because role-definition and organisation writes are not atomic.`,
        { field: `definition.capabilities.${field}`, roleId: existing.id });
    }
  }
}

function memoryKey(kind, id) {
  return `${kind}:${id}`;
}

function storedValue(kind, definition) {
  return { schemaVersion: SCHEMA_VERSION, kind, definition: JSON.parse(JSON.stringify(definition)) };
}

class CustomRoleStore {
  constructor({ stateStore = createStateStore() } = {}) {
    if (!stateStore || typeof stateStore.getMemory !== 'function' || typeof stateStore.setMemory !== 'function' || typeof stateStore.searchMemory !== 'function') {
      fail('CUSTOM_ROLE_INVALID', 'stateStore must expose getMemory, setMemory, and searchMemory.');
    }
    this.stateStore = stateStore;
    this.defaultDefinitions = DEFAULT_ROLE_DEFINITIONS;
  }

  _readEntry(kind, id) {
    const entry = this.stateStore.getMemory({ namespace: NAMESPACE, key: memoryKey(kind, id) });
    // getMemory's only definite "not found" result is null. Do not collapse an
    // invalid falsy response from an injected/unavailable store into absence:
    // callers such as hasRole() would otherwise turn "not measured" into false.
    if (entry === null) return null;
    if (!plain(entry)) {
      fail('CUSTOM_ROLE_CORRUPT', 'Stored custom-role lookup returned an invalid result.', { id, kind });
    }
    const value = entry.value;
    if (!plain(value) || Object.keys(value).length !== 3 || value.schemaVersion !== SCHEMA_VERSION || value.kind !== kind || !Object.hasOwn(value, 'definition')) {
      fail('CUSTOM_ROLE_CORRUPT', 'Stored custom-role data is malformed.', { id, kind });
    }
    const definition = normalizeDefinition(value.definition, { custom: kind === 'custom' });
    if (definition.id !== id) fail('CUSTOM_ROLE_CORRUPT', 'Stored custom-role id does not match its key.', { id, kind });
    return Object.freeze({ definition, revision: entry.revision });
  }

  _write(kind, definition, expectedRevision) {
    const saved = this.stateStore.setMemory({
      namespace: NAMESPACE,
      key: memoryKey(kind, definition.id),
      value: storedValue(kind, definition),
      note: `custom-role:${kind}:${definition.id}`,
      tags: ['custom-role', kind],
      ...(expectedRevision === undefined ? {} : { expectedRevision })
    });
    return Object.freeze({ definition: frozenClone(definition), revision: saved.entry.revision, created: saved.created, replayed: saved.replayed });
  }

  getRole(id) {
    if (typeof id !== 'string' || !ROLE_ID.test(id)) fail('CUSTOM_ROLE_INVALID', 'role id is invalid.', { field: 'id' });
    if (DEFAULT_ROLE_IDS.has(id)) {
      const override = this._readEntry('default', id);
      return frozenClone(override ? override.definition : DEFAULTS_BY_ID.get(id));
    }
    const custom = this._readEntry('custom', id);
    return custom ? frozenClone(custom.definition) : null;
  }

  getRoleRecord(id) {
    if (typeof id !== 'string' || !ROLE_ID.test(id)) fail('CUSTOM_ROLE_INVALID', 'role id is invalid.', { field: 'id' });
    if (DEFAULT_ROLE_IDS.has(id)) {
      const override = this._readEntry('default', id);
      return Object.freeze({
        definition: frozenClone(override ? override.definition : DEFAULTS_BY_ID.get(id)),
        revision: override ? override.revision : 0
      });
    }
    const custom = this._readEntry('custom', id);
    return custom ? Object.freeze({ definition: frozenClone(custom.definition), revision: custom.revision }) : null;
  }

  hasRole(id) {
    return this.getRole(id) !== null;
  }

  listRoles() {
    const entries = this.stateStore.searchMemory({ namespace: NAMESPACE, query: 'custom-role', limit: 20 });
    const custom = [];
    for (const entry of entries) {
      const value = entry.value;
      if (!plain(value) || Object.keys(value).length !== 3 || value.schemaVersion !== SCHEMA_VERSION
        || !['default', 'custom'].includes(value.kind) || !Object.hasOwn(value, 'definition')) {
        fail('CUSTOM_ROLE_CORRUPT', 'Stored custom-role data is malformed.', { key: entry.key });
      }
      const definition = normalizeDefinition(value.definition, { custom: value.kind === 'custom' });
      if (entry.key !== memoryKey(value.kind, definition.id)) {
        fail('CUSTOM_ROLE_CORRUPT', 'Stored custom-role id does not match its key.', { key: entry.key });
      }
      if (value.kind === 'custom') custom.push(definition);
    }
    if (custom.length > MAX_CUSTOM_ROLES) fail('CUSTOM_ROLE_LIMIT_REACHED', 'Too many custom roles are stored.');
    return Object.freeze([
      ...ROLES.map(id => this.getRole(id)),
      ...custom.sort((left, right) => left.id.localeCompare(right.id)).map(frozenClone)
    ]);
  }

  createCustomRole(input) {
    const definition = normalizeDefinition(input, { custom: true });
    if (this._readEntry('custom', definition.id)) {
      fail('CUSTOM_ROLE_COLLISION', `Custom role "${definition.id}" already exists.`, { id: definition.id });
    }
    const customCount = this.listRoles().filter(role => !DEFAULT_ROLE_IDS.has(role.id)).length;
    if (customCount >= MAX_CUSTOM_ROLES) fail('CUSTOM_ROLE_LIMIT_REACHED', `At most ${MAX_CUSTOM_ROLES} custom roles may be stored.`);
    try {
      return this._write('custom', definition, 0);
    } catch (error) {
      if (error && error.code === 'MEMORY_REVISION_CONFLICT') {
        fail('CUSTOM_ROLE_COLLISION', `Custom role "${definition.id}" already exists.`, { id: definition.id });
      }
      throw error;
    }
  }

  editRole(input) {
    requiredAndOptionalKeys(input, ['id', 'rules', 'expectedRevision'], ['capabilities', 'functions', 'requiresDirectUserAuthorization'], 'edit');
    if (typeof input.id !== 'string' || !ROLE_ID.test(input.id)) fail('CUSTOM_ROLE_INVALID', 'edit.id is invalid.', { field: 'edit.id' });
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      fail('CUSTOM_ROLE_INVALID', 'edit.expectedRevision must be a positive integer.', { field: 'edit.expectedRevision' });
    }
    const existing = this._readEntry('custom', input.id);
    if (!existing) fail('CUSTOM_ROLE_NOT_FOUND', `Custom role "${input.id}" does not exist.`, { id: input.id });
    const candidate = normalizeDefinition({
      id: input.id,
      baseDefaultRole: existing.definition.baseDefaultRole,
      rules: input.rules,
      capabilities: Object.hasOwn(input, 'capabilities') ? input.capabilities : existing.definition.capabilities,
      ...normalizeFunctionPolicy(input, existing.definition)
    }, { custom: true });
    assertStructuralCapabilitiesUnchanged(existing.definition, candidate);
    return this._write('custom', candidate, input.expectedRevision);
  }

  editDefaultRole(input) {
    requiredAndOptionalKeys(input, ['id', 'rules', 'expectedRevision'], ['capabilities', 'functions', 'requiresDirectUserAuthorization'], 'default edit');
    if (typeof input.id !== 'string' || !DEFAULT_ROLE_IDS.has(input.id)) fail('CUSTOM_ROLE_NOT_FOUND', 'Default role id is invalid or unknown.', { field: 'default edit.id' });
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      fail('CUSTOM_ROLE_INVALID', 'default edit.expectedRevision must be a non-negative integer.', { field: 'default edit.expectedRevision' });
    }
    const existing = this.getRole(input.id);
    const candidate = normalizeDefinition({
      id: input.id,
      baseDefaultRole: null,
      rules: input.rules,
      capabilities: Object.hasOwn(input, 'capabilities') ? input.capabilities : existing.capabilities,
      ...normalizeFunctionPolicy(input, existing)
    }, { custom: false });
    assertStructuralCapabilitiesUnchanged(existing, candidate);
    return this._write('default', candidate, input.expectedRevision);
  }

  rollbackDefaultRole(input) {
    exactKeys(input, ['id', 'expectedRevision'], 'default rollback');
    if (typeof input.id !== 'string' || !DEFAULT_ROLE_IDS.has(input.id)) fail('CUSTOM_ROLE_NOT_FOUND', 'Default role id is invalid or unknown.', { field: 'default rollback.id' });
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      fail('CUSTOM_ROLE_INVALID', 'default rollback.expectedRevision must be a non-negative integer.', { field: 'default rollback.expectedRevision' });
    }
    const existing = this.getRole(input.id);
    const restored = DEFAULTS_BY_ID.get(input.id);
    assertStructuralCapabilitiesUnchanged(existing, restored);
    return this._write('default', restored, input.expectedRevision);
  }
}

function createCustomRoleStore(options) {
  return new CustomRoleStore(options);
}

module.exports = Object.freeze({
  NAMESPACE, SCHEMA_VERSION, MAX_CUSTOM_ROLES, MAX_RULE_TEXT, DEFAULT_ROLE_DEFINITIONS,
  CustomRoleError, CustomRoleStore, createCustomRoleStore,
  functionCatalog: () => require('./role-functions').functionCatalog()
});
