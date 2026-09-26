'use strict';

// P12 capability-manifest core.  This module is deliberately pure: it has no
// MCP registration, provider, browser, vault, or state-store side effect.  The
// durable adapter owns persistence and auditing; callers inject a trusted tool
// catalog and named base-profile configuration.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalHash, canonicalString } = require('../../schemas/generated/platform.identity');

const SCHEMA_VERSION = 1;
const HASH_DOMAIN = 'coordinator.capability-manifest.v1';
const REQUEST_HASH_DOMAIN = 'coordinator.capability-request.v1';
const EXPANSION_HASH_DOMAIN = 'coordinator.capability-expansion-request.v1';
const PROFILE_ID = /^[a-z][a-z0-9._-]{2,119}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;
const METHOD = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE)$/;
const EFFECTS = new Set(['local-read', 'local-write', 'external-read', 'external-write']);
// A profile only grants a selector when it names an exact resolved set.  The
// controller cannot interpret an omitted selector as "any of the above".  This
// table is deliberately closed: adding a new selector requires an explicit
// manifest field, request field, normalizer, and enforcement entry here.
const SELECTOR_POLICY = Object.freeze([
  Object.freeze({ requestKey: 'rootId', grantKey: 'roots', values: grants => grants.roots.map(item => item.id) }),
  Object.freeze({ requestKey: 'domain', grantKey: 'domains', values: grants => grants.domains }),
  Object.freeze({ requestKey: 'httpMethod', grantKey: 'httpMethods', values: grants => grants.httpMethods }),
  Object.freeze({ requestKey: 'commandId', grantKey: 'commandIds', values: grants => grants.commandIds }),
  Object.freeze({ requestKey: 'secretHandle', grantKey: 'secretHandles', values: grants => grants.secretHandles }),
  Object.freeze({ requestKey: 'externalAction', grantKey: 'externalActions', values: grants => grants.externalActions })
]);
const SENSITIVE = /(?:TOOLSENABLED_CANARY_|OWNER_PRIVATE_FIXTURE|FAKE(?:PROVIDER)?TOKEN|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{20,}|\b(?:sk_(?:live|test|prod)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}))\b/i;

class CapabilityManifestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CapabilityManifestError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new CapabilityManifestError(code, message, details);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, allowed, label, required = []) {
  if (!plainObject(value)) fail('CAPABILITY_MANIFEST_INVALID', `${label} must be an object.`, { field: label });
  const keys = Object.keys(value);
  const unexpected = keys.filter(key => !allowed.includes(key));
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (unexpected.length || missing.length) {
    fail('CAPABILITY_MANIFEST_INVALID', `${label} has unsupported or missing fields.`, { field: label, unexpected, missing });
  }
  return value;
}

function safeString(value, label, pattern = IDENTIFIER, { min = 1, max = 240 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || !pattern.test(value) || SENSITIVE.test(value)) {
    fail('CAPABILITY_MANIFEST_INVALID', `${label} is invalid.`, { field: label });
  }
  return value;
}

function safeHash(value, label) {
  return safeString(value, label, /^[a-f0-9]{64}$/, { min: 64, max: 64 });
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('CAPABILITY_MANIFEST_INVALID', `${label} is invalid.`, { field: label });
  }
  return value;
}

function uniqueSorted(values, label, validator) {
  if (!Array.isArray(values) || values.length > 500) fail('CAPABILITY_MANIFEST_INVALID', `${label} must be a bounded array.`, { field: label });
  const normalized = values.map((value, index) => validator(value, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail('CAPABILITY_MANIFEST_INVALID', `${label} must not contain duplicates.`, { field: label });
  return Object.freeze([...normalized].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
}

function subset(values, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const value of values) {
    if (!allowedSet.has(value)) fail('CAPABILITY_MANIFEST_SCOPE_DENIED', `${label} is outside its base profile.`, { field: label, value });
  }
  return values;
}

function normalizedDomain(value, label) {
  const domain = safeString(String(value || '').toLowerCase(), label, DOMAIN, { min: 3, max: 253 });
  if (domain.includes('..') || !domain.includes('.')) fail('CAPABILITY_MANIFEST_INVALID', `${label} is invalid.`, { field: label });
  return domain;
}

function normalizedTool(value, label) { return safeString(value, label, TOOL_NAME, { min: 3, max: 200 }); }
function normalizedProfileId(value, label = 'profileId') { return safeString(value, label, PROFILE_ID, { min: 3, max: 120 }); }
function normalizedTaskId(value, label = 'taskId') { return safeString(value, label, TASK_ID, { min: 8, max: 200 }); }

function schemaHash(schema) {
  try { return canonicalHash('coordinator.capability-tool-schema.v1', schema); }
  catch { fail('CAPABILITY_MANIFEST_INVALID', 'A tool schema cannot be canonically hashed.'); }
}

function normalizeCatalog(input) {
  exactKeys(input, ['tools', 'roots', 'domains', 'httpMethods', 'commandIds', 'secretHandles', 'externalActions'], 'catalog', ['tools']);
  if (!Array.isArray(input.tools) || input.tools.length > 500) fail('CAPABILITY_MANIFEST_INVALID', 'catalog.tools is invalid.', { field: 'catalog.tools' });
  const toolMap = new Map();
  for (const [index, raw] of input.tools.entries()) {
    exactKeys(raw, ['name', 'effect', 'approvalEligible', 'inputSchema'], `catalog.tools[${index}]`, ['name', 'effect', 'approvalEligible', 'inputSchema']);
    const name = normalizedTool(raw.name, `catalog.tools[${index}].name`);
    if (toolMap.has(name)) fail('CAPABILITY_MANIFEST_INVALID', 'catalog tool names must be unique.', { field: 'catalog.tools' });
    if (!EFFECTS.has(raw.effect) || typeof raw.approvalEligible !== 'boolean' || !plainObject(raw.inputSchema)) {
      fail('CAPABILITY_MANIFEST_INVALID', 'catalog tool metadata is invalid.', { field: `catalog.tools[${index}]` });
    }
    toolMap.set(name, Object.freeze({ name, effect: raw.effect, approvalEligible: raw.approvalEligible, inputSchemaHash: schemaHash(raw.inputSchema) }));
  }
  const roots = new Map();
  for (const [index, raw] of (input.roots || []).entries()) {
    exactKeys(raw, ['id', 'path'], `catalog.roots[${index}]`, ['id', 'path']);
    const id = safeString(raw.id, `catalog.roots[${index}].id`, /^[a-z][a-z0-9._-]{1,79}$/, { min: 2, max: 80 });
    if (typeof raw.path !== 'string' || !path.isAbsolute(raw.path) || raw.path.length > 4096 || SENSITIVE.test(raw.path)) {
      fail('CAPABILITY_MANIFEST_INVALID', 'catalog root path is invalid.', { field: `catalog.roots[${index}].path` });
    }
    if (roots.has(id)) fail('CAPABILITY_MANIFEST_INVALID', 'catalog root IDs must be unique.', { field: 'catalog.roots' });
    const resolved = fs.realpathSync.native(raw.path);
    roots.set(id, Object.freeze({ id, path: resolved, pathHash: crypto.createHash('sha256').update(resolved, 'utf8').digest('hex') }));
  }
  const domainList = uniqueSorted(input.domains || [], 'catalog.domains', normalizedDomain);
  const methods = uniqueSorted(input.httpMethods || [], 'catalog.httpMethods', (value, label) => safeString(value, label, METHOD, { min: 3, max: 6 }));
  const commandIds = uniqueSorted(input.commandIds || [], 'catalog.commandIds', (value, label) => safeString(value, label, /^[a-z][a-z0-9._-]{1,119}$/, { min: 2, max: 120 }));
  const secretHandles = uniqueSorted(input.secretHandles || [], 'catalog.secretHandles', (value, label) => safeString(value, label, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/, { min: 1, max: 200 }));
  const externalActions = uniqueSorted(input.externalActions || [], 'catalog.externalActions', normalizedTool);
  const canonical = {
    tools: [...toolMap.values()].sort((left, right) => left.name.localeCompare(right.name, 'en')),
    roots: [...roots.values()].map(item => ({ id: item.id, pathHash: item.pathHash })).sort((left, right) => left.id.localeCompare(right.id, 'en')),
    domains: domainList, httpMethods: methods, commandIds, secretHandles, externalActions
  };
  return Object.freeze({ tools: toolMap, roots, domains: domainList, httpMethods: methods, commandIds, secretHandles, externalActions, hash: canonicalHash('coordinator.capability-catalog.v1', canonical) });
}

function normalizeProfile(raw, index, catalog) {
  exactKeys(raw, ['id', 'tools', 'roots', 'domains', 'httpMethods', 'commandIds', 'secretHandles', 'externalActions', 'approvalRequiredActions', 'deniedTools', 'completionCriteria', 'maxTtlMs'], `profiles[${index}]`, ['id', 'tools', 'maxTtlMs']);
  const id = normalizedProfileId(raw.id, `profiles[${index}].id`);
  const tools = uniqueSorted(raw.tools, `profiles[${index}].tools`, normalizedTool);
  subset(tools, catalog.tools.keys(), `profiles[${index}].tools`);
  const roots = uniqueSorted(raw.roots || [], `profiles[${index}].roots`, (value, label) => safeString(value, label, /^[a-z][a-z0-9._-]{1,79}$/, { min: 2, max: 80 }));
  subset(roots, catalog.roots.keys(), `profiles[${index}].roots`);
  const domains = uniqueSorted(raw.domains || [], `profiles[${index}].domains`, normalizedDomain);
  subset(domains, catalog.domains, `profiles[${index}].domains`);
  const httpMethods = uniqueSorted(raw.httpMethods || [], `profiles[${index}].httpMethods`, (value, label) => safeString(value, label, METHOD, { min: 3, max: 6 }));
  subset(httpMethods, catalog.httpMethods, `profiles[${index}].httpMethods`);
  const commandIds = uniqueSorted(raw.commandIds || [], `profiles[${index}].commandIds`, (value, label) => safeString(value, label, /^[a-z][a-z0-9._-]{1,119}$/, { min: 2, max: 120 }));
  subset(commandIds, catalog.commandIds, `profiles[${index}].commandIds`);
  const secretHandles = uniqueSorted(raw.secretHandles || [], `profiles[${index}].secretHandles`, (value, label) => safeString(value, label, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/, { min: 1, max: 200 }));
  subset(secretHandles, catalog.secretHandles, `profiles[${index}].secretHandles`);
  const externalActions = uniqueSorted(raw.externalActions || [], `profiles[${index}].externalActions`, normalizedTool);
  subset(externalActions, catalog.externalActions, `profiles[${index}].externalActions`);
  for (const action of externalActions) {
    const tool = catalog.tools.get(action);
    if (!tool || tool.effect !== 'external-write' || !tools.includes(action)) {
      fail('CAPABILITY_MANIFEST_INVALID', 'A profile external action must name one of its external-write tools.', { field: `profiles[${index}].externalActions`, action });
    }
  }
  const approvalRequiredActions = uniqueSorted(raw.approvalRequiredActions || [], `profiles[${index}].approvalRequiredActions`, normalizedTool);
  subset(approvalRequiredActions, tools, `profiles[${index}].approvalRequiredActions`);
  const deniedTools = uniqueSorted(raw.deniedTools || [], `profiles[${index}].deniedTools`, normalizedTool);
  const completionCriteria = uniqueSorted(raw.completionCriteria || [], `profiles[${index}].completionCriteria`, (value, label) => safeString(value, label, /^[a-z][a-z0-9._-]{1,119}$/, { min: 2, max: 120 }));
  const maxTtlMs = safeInteger(raw.maxTtlMs, `profiles[${index}].maxTtlMs`, { min: 1_000, max: 7 * 24 * 60 * 60 * 1000 });
  return Object.freeze({ id, tools, roots, domains, httpMethods, commandIds, secretHandles, externalActions, approvalRequiredActions, deniedTools, completionCriteria, maxTtlMs });
}

function normalizeConfiguration(input, catalog) {
  exactKeys(input, ['schemaVersion', 'profiles'], 'capability profile configuration', ['schemaVersion', 'profiles']);
  if (input.schemaVersion !== SCHEMA_VERSION || !Array.isArray(input.profiles) || !input.profiles.length || input.profiles.length > 100) {
    fail('CAPABILITY_MANIFEST_INVALID', 'capability profile configuration is invalid.');
  }
  const profiles = input.profiles.map((item, index) => normalizeProfile(item, index, catalog));
  if (new Set(profiles.map(item => item.id)).size !== profiles.length) fail('CAPABILITY_MANIFEST_INVALID', 'profile IDs must be unique.');
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, profiles: new Map(profiles.map(item => [item.id, item])), hash: canonicalHash('coordinator.capability-base-profiles.v1', { schemaVersion: SCHEMA_VERSION, profiles }) });
}

function loadConfiguration(filename, catalog) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('CAPABILITY_MANIFEST_INVALID', 'configuration path must be absolute.');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { fail('CAPABILITY_MANIFEST_CONFIGURATION_UNAVAILABLE', 'capability profile configuration could not be read.'); }
  return normalizeConfiguration(raw, catalog);
}

function requestList(value, label, validator, fallback) {
  if (value === undefined) return fallback;
  return uniqueSorted(value, label, validator);
}

function requestedScope(raw, base, catalog, now) {
  const source = raw === undefined ? {} : exactKeys(raw, ['tools', 'roots', 'domains', 'httpMethods', 'commandIds', 'secretHandles', 'externalActions', 'approvalRequiredActions', 'deniedTools', 'completionCriteria', 'expiresAtMs'], 'requested scope');
  const tools = requestList(source.tools, 'requested.tools', normalizedTool, base.tools);
  subset(tools, base.tools, 'requested.tools');
  const roots = requestList(source.roots, 'requested.roots', (value, label) => safeString(value, label, /^[a-z][a-z0-9._-]{1,79}$/, { min: 2, max: 80 }), base.roots);
  subset(roots, base.roots, 'requested.roots');
  const domains = requestList(source.domains, 'requested.domains', normalizedDomain, base.domains);
  subset(domains, base.domains, 'requested.domains');
  const httpMethods = requestList(source.httpMethods, 'requested.httpMethods', (value, label) => safeString(value, label, METHOD, { min: 3, max: 6 }), base.httpMethods);
  subset(httpMethods, base.httpMethods, 'requested.httpMethods');
  const commandIds = requestList(source.commandIds, 'requested.commandIds', (value, label) => safeString(value, label, /^[a-z][a-z0-9._-]{1,119}$/, { min: 2, max: 120 }), base.commandIds);
  subset(commandIds, base.commandIds, 'requested.commandIds');
  const secretHandles = requestList(source.secretHandles, 'requested.secretHandles', (value, label) => safeString(value, label, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/, { min: 1, max: 200 }), base.secretHandles);
  subset(secretHandles, base.secretHandles, 'requested.secretHandles');
  const externalActions = requestList(source.externalActions, 'requested.externalActions', normalizedTool, base.externalActions);
  subset(externalActions, base.externalActions, 'requested.externalActions');
  const approvalRequiredActions = requestList(source.approvalRequiredActions, 'requested.approvalRequiredActions', normalizedTool, base.approvalRequiredActions);
  subset(approvalRequiredActions, base.approvalRequiredActions, 'requested.approvalRequiredActions');
  subset(approvalRequiredActions, tools, 'requested.approvalRequiredActions');
  const deniedTools = requestList(source.deniedTools, 'requested.deniedTools', normalizedTool, []);
  const completionCriteria = requestList(source.completionCriteria, 'requested.completionCriteria', (value, label) => safeString(value, label, /^[a-z][a-z0-9._-]{1,119}$/, { min: 2, max: 120 }), base.completionCriteria);
  subset(completionCriteria, base.completionCriteria, 'requested.completionCriteria');
  const current = safeInteger(now, 'clock result');
  const expiresAtMs = source.expiresAtMs === undefined ? current + base.maxTtlMs : safeInteger(source.expiresAtMs, 'requested.expiresAtMs', { min: current + 1, max: current + base.maxTtlMs });
  return Object.freeze({ tools, roots, domains, httpMethods, commandIds, secretHandles, externalActions, approvalRequiredActions, deniedTools: uniqueSorted([...base.deniedTools, ...deniedTools], 'requested.deniedTools', normalizedTool), completionCriteria, expiresAtMs });
}

function compileManifest(input, dependencies = {}) {
  exactKeys(input, ['profileId', 'version', 'taskId', 'baseProfileId', 'requested', 'parentHash'], 'capability manifest compile request', ['profileId', 'version', 'taskId', 'baseProfileId']);
  const catalog = normalizeCatalog(dependencies.catalog || {});
  const now = typeof dependencies.now === 'function' ? dependencies.now() : Date.now();
  const configuration = dependencies.configuration && dependencies.configuration.profiles instanceof Map
    ? dependencies.configuration : normalizeConfiguration(dependencies.configuration || {}, catalog);
  const profileId = normalizedProfileId(input.profileId);
  const version = safeInteger(input.version, 'version', { min: 1 });
  const taskId = normalizedTaskId(input.taskId);
  const baseProfileId = normalizedProfileId(input.baseProfileId, 'baseProfileId');
  const base = configuration.profiles.get(baseProfileId);
  if (!base) fail('CAPABILITY_MANIFEST_SCOPE_DENIED', 'The named base profile is unavailable.', { baseProfileId });
  const parentHash = input.parentHash === undefined ? null : safeHash(input.parentHash, 'parentHash');
  if ((version === 1) !== (parentHash === null)) fail('CAPABILITY_MANIFEST_INVALID', 'Only version one may omit parentHash.', { field: 'parentHash' });
  const selected = requestedScope(input.requested, base, catalog, now);
  const toolDescriptors = selected.tools.map(name => catalog.tools.get(name));
  const denied = new Set(selected.deniedTools);
  const grants = {
    tools: toolDescriptors.filter(tool => !denied.has(tool.name)),
    roots: selected.roots.map(id => {
      const root = catalog.roots.get(id);
      return { id: root.id, path: root.path, pathHash: root.pathHash };
    }),
    domains: selected.domains,
    httpMethods: selected.httpMethods,
    commandIds: selected.commandIds,
    secretHandles: selected.secretHandles,
    externalActions: selected.externalActions,
    approvalRequiredActions: selected.approvalRequiredActions
  };
  for (const action of grants.approvalRequiredActions) {
    if (!grants.tools.some(tool => tool.name === action)) fail('CAPABILITY_MANIFEST_SCOPE_DENIED', 'Approval-required action is not visible to the profile.', { action });
  }
  for (const action of grants.externalActions) {
    const tool = catalog.tools.get(action);
    if (!tool || tool.effect !== 'external-write' || !grants.tools.some(item => item.name === action)) {
      fail('CAPABILITY_MANIFEST_SCOPE_DENIED', 'An external action must name a visible external-write tool.', { action });
    }
  }
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    profileId, version, taskId, baseProfileId,
    baseProfileHash: configuration.hash,
    catalogHash: catalog.hash,
    parentHash,
    grants,
    denials: { tools: selected.deniedTools },
    completionCriteria: selected.completionCriteria,
    expiresAtMs: selected.expiresAtMs
  };
  return Object.freeze({ manifest: Object.freeze(manifest), manifestHash: canonicalHash(HASH_DOMAIN, manifest) });
}

function validateManifest(input) {
  const source = exactKeys(input, ['schemaVersion', 'profileId', 'version', 'taskId', 'baseProfileId', 'baseProfileHash', 'catalogHash', 'parentHash', 'grants', 'denials', 'completionCriteria', 'expiresAtMs'], 'capability manifest', ['schemaVersion', 'profileId', 'version', 'taskId', 'baseProfileId', 'baseProfileHash', 'catalogHash', 'parentHash', 'grants', 'denials', 'completionCriteria', 'expiresAtMs']);
  if (source.schemaVersion !== SCHEMA_VERSION) fail('CAPABILITY_MANIFEST_INVALID', 'capability manifest schemaVersion is invalid.');
  // The closed validator above needs only shape validation; it does not reopen
  // base-profile authority from mutable configuration.
  exactKeys(source.grants, ['tools', 'roots', 'domains', 'httpMethods', 'commandIds', 'secretHandles', 'externalActions', 'approvalRequiredActions'], 'capability manifest grants', ['tools', 'roots', 'domains', 'httpMethods', 'commandIds', 'secretHandles', 'externalActions', 'approvalRequiredActions']);
  exactKeys(source.denials, ['tools'], 'capability manifest denials', ['tools']);
  const tools = source.grants.tools.map((item, index) => {
    exactKeys(item, ['name', 'effect', 'approvalEligible', 'inputSchemaHash'], `grants.tools[${index}]`, ['name', 'effect', 'approvalEligible', 'inputSchemaHash']);
    const name = normalizedTool(item.name, `grants.tools[${index}].name`);
    if (!EFFECTS.has(item.effect) || typeof item.approvalEligible !== 'boolean') fail('CAPABILITY_MANIFEST_INVALID', 'tool grant metadata is invalid.', { field: `grants.tools[${index}]` });
    return { name, effect: item.effect, approvalEligible: item.approvalEligible, inputSchemaHash: safeHash(item.inputSchemaHash, `grants.tools[${index}].inputSchemaHash`) };
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'));
  if (new Set(tools.map(item => item.name)).size !== tools.length) fail('CAPABILITY_MANIFEST_INVALID', 'tool grants must be unique.');
  const roots = source.grants.roots.map((item, index) => {
    exactKeys(item, ['id', 'path', 'pathHash'], `grants.roots[${index}]`, ['id', 'path', 'pathHash']);
    const id = safeString(item.id, `grants.roots[${index}].id`, /^[a-z][a-z0-9._-]{1,79}$/, { min: 2, max: 80 });
    if (typeof item.path !== 'string' || !path.isAbsolute(item.path) || item.path.length > 4096 || SENSITIVE.test(item.path)) fail('CAPABILITY_MANIFEST_INVALID', 'root grant path is invalid.', { field: `grants.roots[${index}].path` });
    let resolved;
    try { resolved = fs.realpathSync.native(item.path); }
    catch { fail('CAPABILITY_MANIFEST_ROOT_UNAVAILABLE', 'A manifest root is no longer available.', { rootId: id }); }
    const pathHash = safeHash(item.pathHash, `grants.roots[${index}].pathHash`);
    if (crypto.createHash('sha256').update(resolved, 'utf8').digest('hex') !== pathHash) fail('CAPABILITY_MANIFEST_INVALID', 'root grant path hash is invalid.', { field: `grants.roots[${index}].pathHash` });
    return { id, path: resolved, pathHash };
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
  if (new Set(roots.map(item => item.id)).size !== roots.length) fail('CAPABILITY_MANIFEST_INVALID', 'root grants must be unique.');
  const grants = {
    tools,
    roots,
    domains: uniqueSorted(source.grants.domains, 'grants.domains', normalizedDomain),
    httpMethods: uniqueSorted(source.grants.httpMethods, 'grants.httpMethods', (value, label) => safeString(value, label, METHOD, { min: 3, max: 6 })),
    commandIds: uniqueSorted(source.grants.commandIds, 'grants.commandIds', (value, label) => safeString(value, label, /^[a-z][a-z0-9._-]{1,119}$/, { min: 2, max: 120 })),
    secretHandles: uniqueSorted(source.grants.secretHandles, 'grants.secretHandles', (value, label) => safeString(value, label, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/, { min: 1, max: 200 })),
    externalActions: uniqueSorted(source.grants.externalActions, 'grants.externalActions', normalizedTool),
    approvalRequiredActions: uniqueSorted(source.grants.approvalRequiredActions, 'grants.approvalRequiredActions', normalizedTool)
  };
  const output = {
    schemaVersion: SCHEMA_VERSION,
    profileId: normalizedProfileId(source.profileId),
    version: safeInteger(source.version, 'version', { min: 1 }),
    taskId: normalizedTaskId(source.taskId),
    baseProfileId: normalizedProfileId(source.baseProfileId, 'baseProfileId'),
    baseProfileHash: safeHash(source.baseProfileHash, 'baseProfileHash'),
    catalogHash: safeHash(source.catalogHash, 'catalogHash'),
    parentHash: source.parentHash === null ? null : safeHash(source.parentHash, 'parentHash'),
    grants,
    denials: { tools: uniqueSorted(source.denials.tools, 'denials.tools', normalizedTool) },
    completionCriteria: uniqueSorted(source.completionCriteria, 'completionCriteria', (value, label) => safeString(value, label, /^[a-z][a-z0-9._-]{1,119}$/, { min: 2, max: 120 })),
    expiresAtMs: safeInteger(source.expiresAtMs, 'expiresAtMs', { min: 1 })
  };
  if ((output.version === 1) !== (output.parentHash === null)) fail('CAPABILITY_MANIFEST_INVALID', 'manifest parent version is invalid.');
  for (const action of output.grants.approvalRequiredActions) {
    if (!output.grants.tools.some(tool => tool.name === action)) fail('CAPABILITY_MANIFEST_INVALID', 'approval-required action must be visible.', { action });
  }
  for (const action of output.grants.externalActions) {
    const tool = output.grants.tools.find(item => item.name === action);
    if (!tool || tool.effect !== 'external-write') {
      fail('CAPABILITY_MANIFEST_INVALID', 'An external action must name a visible external-write tool.', { action });
    }
  }
  return Object.freeze(output);
}

function manifestHash(manifest) { return canonicalHash(HASH_DOMAIN, validateManifest(manifest)); }

function normalizeAuthorizationRequest(input) {
  exactKeys(input, ['taskId', 'tool', 'rootId', 'targetPath', 'domain', 'httpMethod', 'commandId', 'secretHandle', 'externalAction'], 'capability-bound request', ['taskId', 'tool']);
  if (input.targetPath !== undefined && (typeof input.targetPath !== 'string' || !path.isAbsolute(input.targetPath) || input.targetPath.length > 4096 || SENSITIVE.test(input.targetPath))) {
    fail('CAPABILITY_MANIFEST_INVALID', 'targetPath is invalid.', { field: 'targetPath' });
  }
  return Object.freeze({
    taskId: normalizedTaskId(input.taskId),
    tool: normalizedTool(input.tool),
    rootId: input.rootId === undefined ? null : safeString(input.rootId, 'rootId', /^[a-z][a-z0-9._-]{1,79}$/, { min: 2, max: 80 }),
    targetPath: input.targetPath === undefined ? null : input.targetPath,
    domain: input.domain === undefined ? null : normalizedDomain(input.domain, 'domain'),
    httpMethod: input.httpMethod === undefined ? null : safeString(input.httpMethod, 'httpMethod', METHOD, { min: 3, max: 6 }),
    commandId: input.commandId === undefined ? null : safeString(input.commandId, 'commandId', /^[a-z][a-z0-9._-]{1,119}$/, { min: 2, max: 120 }),
    secretHandle: input.secretHandle === undefined ? null : safeString(input.secretHandle, 'secretHandle', /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/, { min: 1, max: 200 }),
    externalAction: input.externalAction === undefined ? null : normalizedTool(input.externalAction, 'externalAction')
  });
}

function rootTargetHash(manifest, request) {
  if (request.targetPath === null) return null;
  if (request.rootId === null) fail('CAPABILITY_MANIFEST_SCOPE_DENIED', 'A target path requires an explicitly granted root.', { field: 'rootId' });
  const root = manifest.grants.roots.find(item => item.id === request.rootId);
  if (!root) fail('CAPABILITY_MANIFEST_SCOPE_DENIED', 'The requested root is outside the manifest.', { field: 'rootId' });
  let target;
  try { target = fs.realpathSync.native(request.targetPath); }
  catch { fail('CAPABILITY_MANIFEST_ROOT_UNAVAILABLE', 'The requested target path is unavailable.', { rootId: request.rootId }); }
  const relative = path.relative(root.path, target);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return crypto.createHash('sha256').update(target, 'utf8').digest('hex');
  }
  fail('CAPABILITY_MANIFEST_SCOPE_DENIED', 'The requested target path is outside its granted root.', { field: 'targetPath', rootId: request.rootId });
}

function authorize(manifestInput, status, input, { now = Date.now() } = {}) {
  const manifest = validateManifest(manifestInput);
  const request = normalizeAuthorizationRequest(input);
  if (!status || status.revoked === true) fail('CAPABILITY_MANIFEST_REVOKED', 'The capability manifest has been revoked.');
  if (!Number.isSafeInteger(now) || now >= manifest.expiresAtMs) fail('CAPABILITY_MANIFEST_EXPIRED', 'The capability manifest has expired.');
  if (request.taskId !== manifest.taskId) fail('CAPABILITY_MANIFEST_BINDING_MISMATCH', 'The capability manifest is not bound to this task.');
  if (manifest.denials.tools.includes(request.tool) || !manifest.grants.tools.some(tool => tool.name === request.tool)) {
    fail('CAPABILITY_MANIFEST_SCOPE_DENIED', 'The requested tool is outside the manifest.');
  }
  for (const selector of SELECTOR_POLICY) {
    const values = selector.values(manifest.grants);
    const value = request[selector.requestKey];
    if (values.length && value === null) {
      fail('CAPABILITY_MANIFEST_SELECTOR_REQUIRED', `The constrained ${selector.requestKey} selector is required.`, { field: selector.requestKey });
    }
    if (value !== null && !values.includes(value)) {
      fail('CAPABILITY_MANIFEST_SCOPE_DENIED', `The requested ${selector.requestKey} is outside the manifest.`, { field: selector.requestKey });
    }
  }
  const tool = manifest.grants.tools.find(item => item.name === request.tool);
  if (tool.effect === 'external-write' && request.externalAction !== request.tool) {
    fail('CAPABILITY_MANIFEST_SCOPE_DENIED', 'An external-write request must name its exact approved external action.', { field: 'externalAction' });
  }
  const targetPathHash = rootTargetHash(manifest, request);
  const profileHash = manifestHash(manifest);
  const { targetPath: _targetPath, ...requestWithoutPath } = request;
  const boundedRequest = Object.freeze({ ...requestWithoutPath, targetPathHash });
  return Object.freeze({ manifest, profileHash, request: boundedRequest, requestHash: canonicalHash(REQUEST_HASH_DOMAIN, { profileHash, request: boundedRequest }) });
}

function expansionRequest(manifestInput, input) {
  const manifest = validateManifest(manifestInput);
  exactKeys(input, ['reason', 'requested', 'evidenceReference', 'expectedAction'], 'capability expansion request', ['reason', 'requested', 'expectedAction']);
  const reason = safeString(input.reason, 'reason', /^[\x20-\x7e]{1,1000}$/, { min: 1, max: 1000 });
  const expectedAction = safeString(input.expectedAction, 'expectedAction', /^[\x20-\x7e]{1,500}$/, { min: 1, max: 500 });
  const evidenceReference = input.evidenceReference === undefined ? null : safeString(input.evidenceReference, 'evidenceReference');
  const requested = canonicalString(input.requested);
  const profileHash = manifestHash(manifest);
  const record = {
    profileHash,
    taskId: manifest.taskId,
    reasonHash: crypto.createHash('sha256').update(reason, 'utf8').digest('hex'),
    requestedHash: crypto.createHash('sha256').update(requested, 'utf8').digest('hex'),
    evidenceReference,
    expectedActionHash: crypto.createHash('sha256').update(expectedAction, 'utf8').digest('hex')
  };
  return Object.freeze({ ...record, requestHash: canonicalHash(EXPANSION_HASH_DOMAIN, record), grantsAuthority: false });
}

function inspect(manifestInput, status) {
  const manifest = validateManifest(manifestInput);
  if (!plainObject(status) || typeof status.revoked !== 'boolean') {
    fail('CAPABILITY_MANIFEST_STATUS_UNAVAILABLE', 'Capability manifest status could not be established.');
  }
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    profileId: manifest.profileId,
    version: manifest.version,
    taskId: manifest.taskId,
    manifestHash: manifestHash(manifest),
    parentHash: manifest.parentHash,
    baseProfileId: manifest.baseProfileId,
    baseProfileHash: manifest.baseProfileHash,
    catalogHash: manifest.catalogHash,
    status: status.revoked ? 'revoked' : (Date.now() >= manifest.expiresAtMs ? 'expired' : 'active'),
    expiresAtMs: manifest.expiresAtMs,
    grants: {
      tools: manifest.grants.tools.map(tool => ({ name: tool.name, effect: tool.effect, approvalEligible: tool.approvalEligible, inputSchemaHash: tool.inputSchemaHash })),
      roots: manifest.grants.roots.map(root => ({ id: root.id, pathHash: root.pathHash })),
      domains: manifest.grants.domains,
      httpMethods: manifest.grants.httpMethods,
      commandIds: manifest.grants.commandIds,
      secretHandles: manifest.grants.secretHandles.map(handle => ({ handle, value: '[VAULT-HANDLE]' })),
      externalActions: manifest.grants.externalActions,
      approvalRequiredActions: manifest.grants.approvalRequiredActions
    },
    denials: manifest.denials,
    completionCriteria: manifest.completionCriteria,
    revocation: status.revoked ? { reasonCode: status.reasonCode, revokedAtMs: status.revokedAtMs } : null,
    contentTrust: 'verified-local-state',
    grantsAuthority: false
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION, HASH_DOMAIN, REQUEST_HASH_DOMAIN, EXPANSION_HASH_DOMAIN,
  CapabilityManifestError, authorize, compileManifest, expansionRequest,
  inspect, loadConfiguration, manifestHash, normalizeCatalog, normalizeConfiguration,
  normalizeAuthorizationRequest, SELECTOR_POLICY, validateManifest
});
