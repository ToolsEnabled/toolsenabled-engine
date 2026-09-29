'use strict';

// P06 deterministic generator. JSON Schema is the sole wire authority. All
// outputs are self-contained and contain no application-runtime import.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const evidenceStoreGenerator = require('./generate-evidence-store');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_ROOT = path.join(ROOT, 'schemas', 'platform');
const MANIFEST_PATH = path.join(PACKAGE_ROOT, 'manifest.json');
const IDENTITY_POLICY_PATH = path.join(PACKAGE_ROOT, 'identifier-policy.json');
const IDENTITY_VECTORS_PATH = path.join(PACKAGE_ROOT, 'fixtures', 'identity-vectors.json');
const PROVENANCE_POLICY_PATH = path.join(PACKAGE_ROOT, 'provenance-policy.json');
const PROVENANCE_SCHEMA_PATH = path.join(PACKAGE_ROOT, 'provenance.schema.json');
const PROVENANCE_VECTORS_PATH = path.join(PACKAGE_ROOT, 'fixtures', 'provenance-vectors.json');
const REDACTION_POLICY_PATH = path.join(PACKAGE_ROOT, 'redaction-policy.json');
const REDACTION_REPORT_SCHEMA_PATH = path.join(PACKAGE_ROOT, 'redaction-report.schema.json');
const REDACTION_VECTORS_PATH = path.join(PACKAGE_ROOT, 'fixtures', 'redaction-vectors.json');
const OWNERSHIP_PATH = path.join(ROOT, 'schemas', 'ownership-map.json');
const REQUIRED_NAMES = [
  'task', 'event', 'evidence', 'capability', 'approval', 'context',
  'delegation', 'resource-lease', 'budget', 'memory', 'finance-result', 'tool-package'
];
const OUTPUTS = Object.freeze({
  types: path.join(ROOT, 'schemas', 'generated', 'platform.types.ts'),
  typescriptValidator: path.join(ROOT, 'schemas', 'generated', 'platform.validator.ts'),
  javascriptValidator: path.join(ROOT, 'schemas', 'generated', 'platform.validator.js'),
  typescriptIdentity: path.join(ROOT, 'schemas', 'generated', 'platform.identity.ts'),
  javascriptIdentity: path.join(ROOT, 'schemas', 'generated', 'platform.identity.js'),
  typescriptProvenance: path.join(ROOT, 'schemas', 'generated', 'platform.provenance.ts'),
  javascriptProvenance: path.join(ROOT, 'schemas', 'generated', 'platform.provenance.js'),
  typescriptRedaction: path.join(ROOT, 'schemas', 'generated', 'platform.redaction.ts'),
  javascriptRedaction: path.join(ROOT, 'schemas', 'generated', 'platform.redaction.js'),
  toolsEnabledPython: path.join(ROOT, 'schemas', 'generated', 'coordinator_platform_contract.py'),
  toolsEnabledPythonIdentity: path.join(ROOT, 'schemas', 'generated', 'coordinator_platform_identity.py'),
  toolsEnabledPythonProvenance: path.join(ROOT, 'schemas', 'generated', 'coordinator_platform_provenance.py'),
  toolsEnabledPythonRedaction: path.join(ROOT, 'schemas', 'generated', 'coordinator_platform_redaction.py'),
  artifact: path.join(ROOT, 'artifacts', 'coordinator-platform-contracts-1.0.0.json'),
  identityArtifact: path.join(ROOT, 'artifacts', 'coordinator-platform-identity-vectors-1.0.0.json'),
  provenanceArtifact: path.join(ROOT, 'artifacts', 'coordinator-platform-provenance-vectors-1.0.0.json'),
  redactionArtifact: path.join(ROOT, 'artifacts', 'coordinator-platform-redaction-vectors-1.0.0.json')
});

function readJson(filename) { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
function className(name) {
  return name.split(/[-_]/).map(part => part[0].toUpperCase() + part.slice(1)).join('') + 'V1';
}
function stable(value) { return JSON.stringify(value); }

function loadPackage() {
  const manifest = readJson(MANIFEST_PATH);
  const ownership = readJson(OWNERSHIP_PATH);
  const identityPolicy = readJson(IDENTITY_POLICY_PATH);
  const identityVectors = readJson(IDENTITY_VECTORS_PATH);
  const provenancePolicy = readJson(PROVENANCE_POLICY_PATH);
  const provenanceSchema = readJson(PROVENANCE_SCHEMA_PATH);
  const provenanceVectors = readJson(PROVENANCE_VECTORS_PATH);
  const redactionPolicy = readJson(REDACTION_POLICY_PATH);
  const redactionReportSchema = readJson(REDACTION_REPORT_SCHEMA_PATH);
  const redactionVectors = readJson(REDACTION_VECTORS_PATH);
  const schemas = {};
  for (const item of manifest.schemas || []) schemas[item.name] = readJson(path.join(PACKAGE_ROOT, item.file));
  validatePackage(manifest, schemas, ownership);
  validateIdentityPolicy(identityPolicy, manifest);
  validateIdentityVectors(identityVectors, identityPolicy);
  validateProvenancePackage(provenancePolicy, provenanceSchema, provenanceVectors, manifest);
  validateRedactionPackage(redactionPolicy, redactionReportSchema, redactionVectors, manifest);
  return {
    manifest, schemas, ownership, identityPolicy, identityVectors,
    provenancePolicy, provenanceSchema, provenanceVectors,
    redactionPolicy, redactionReportSchema, redactionVectors
  };
}

function validatePackage(manifest, schemas, ownership) {
  if (!manifest || manifest.package !== 'coordinator-platform' || manifest.schemaAuthority !== 'toolsenabled') {
    throw new Error('manifest must name ToolsEnabled as the schema authority');
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.schemaVersion || '')) throw new Error('manifest version must be semver');
  const names = (manifest.schemas || []).map(item => item.name);
  if (names.length !== REQUIRED_NAMES.length || new Set(names).size !== names.length ||
      REQUIRED_NAMES.some(name => !names.includes(name))) throw new Error('manifest P06 schema list is incomplete');
  const owners = new Map((ownership.owners || []).map(item => [item.domain, item.owner]));
  for (const item of manifest.schemas) {
    const schema = schemas[item.name];
    if (!schema || schema.type !== 'object' || schema.additionalProperties !== false) {
      throw new Error(item.name + ' must be a closed object schema');
    }
    if (schema.$id !== 'urn:coordinator:platform:' + item.name + ':' + manifest.schemaVersion ||
        schema.properties?.schemaVersion?.const !== manifest.schemaVersion) {
      throw new Error(item.name + ' has an invalid ID or wire version');
    }
    if (owners.get(item.domain) !== item.owner) throw new Error(item.name + ' conflicts with P04 ownership');
    validatePortableSchema(schema, item.name);
  }
  if (schemas['finance-result'].properties?.data?.additionalProperties !== true) {
    throw new Error('finance-result.data must remain the documented extensible payload');
  }
}

function validatePortableSchema(schema, label) {
  if (!schema || typeof schema !== 'object') return;
  if (typeof schema.pattern === 'string') {
    if (schema.pattern.length > 512 || /[^\x20-\x7e]/.test(schema.pattern) ||
        /(\(\?|\\[pPk])/.test(schema.pattern)) {
      throw new Error(label + ' uses a non-portable regular-expression pattern');
    }
  }
  for (const [key, child] of Object.entries(schema.properties || {})) {
    validatePortableSchema(child, label + '.' + key);
  }
  if (schema.items) validatePortableSchema(schema.items, label + '[]');
}

function validateIdentityPolicy(policy, manifest) {
  if (!policy || policy.policyVersion !== manifest.schemaVersion || policy.policyAuthority !== 'toolsenabled') {
    throw new Error('identity policy must be ToolsEnabled-owned and match the package version');
  }
  const encoding = policy.idEncoding || {};
  if (encoding.alphabet !== 'base64url' || encoding.randomBytes !== 24 ||
      encoding.encodedCharacters !== 32 || encoding.randomnessBits !== 192) {
    throw new Error('identity policy must require 192-bit base64url runtime IDs');
  }
  const requiredKinds = new Set(REQUIRED_NAMES.concat('provider-session'));
  const kinds = policy.idKinds || [];
  if (kinds.length !== requiredKinds.size || new Set(kinds.map(item => item.kind)).size !== kinds.length ||
      kinds.some(item => !requiredKinds.has(item.kind)) || [...requiredKinds].some(kind => !kinds.some(item => item.kind === kind))) {
    throw new Error('identity policy ID kinds must cover every P06 contract plus provider-session exactly once');
  }
  const prefixes = new Set();
  for (const item of kinds) {
    if (!/^[a-z][a-z0-9]{1,15}$/.test(item.prefix || '') || prefixes.has(item.prefix)) {
      throw new Error('identity policy prefixes must be unique lowercase ASCII tokens');
    }
    prefixes.add(item.prefix);
  }
  const clock = policy.controlTimestamp || {};
  if (clock.format !== 'YYYY-MM-DDTHH:mm:ss.sssZ' || clock.timezone !== 'UTC' || clock.precision !== 'milliseconds' ||
      typeof clock.sourceMarketTimezone !== 'string' || !clock.sourceMarketTimezone) {
    throw new Error('identity policy must define strict UTC control timestamps and separate market timezone semantics');
  }
  const monotonic = policy.monotonicClock || {};
  if (monotonic.serialized !== false || monotonic.crossProcessComparable !== false ||
      typeof monotonic.scope !== 'string' || !monotonic.scope) {
    throw new Error('identity policy must keep monotonic clocks process-local and non-serialized');
  }
  const hashing = policy.canonicalHash || {};
  if (hashing.algorithm !== 'sha256' || hashing.frameVersion !== 'coordinator-platform-hash-v1' ||
      hashing.domainPattern !== '^[a-z][a-z0-9:._-]{0,127}$' || hashing.domainEncoding !== 'ASCII' ||
      hashing.payloadEncoding !== 'ASCII canonical JSON' || typeof hashing.frame !== 'string' || !hashing.frame) {
    throw new Error('identity policy must define the P07 domain-separated SHA-256 frame');
  }
  if (policy.authorization?.visiblePrefixGrantsAuthority !== false || policy.authorization?.idValidationIsLexicalOnly !== true) {
    throw new Error('identity policy must prohibit prefix-based authorization');
  }
}

function validateIdentityVectors(vectors, policy) {
  if (!vectors || !Array.isArray(vectors.canonical) || !Array.isArray(vectors.hashes) ||
      !Array.isArray(vectors.validIds) || !Array.isArray(vectors.invalidIds) ||
      !Array.isArray(vectors.validControlTimestamps) || !Array.isArray(vectors.invalidControlTimestamps) ||
      !Array.isArray(vectors.invalidDomains)) {
    throw new Error('identity vectors are incomplete');
  }
  const knownKinds = new Set(policy.idKinds.map(item => item.kind));
  for (const item of vectors.validIds) {
    if (!knownKinds.has(item.kind) || typeof item.value !== 'string') throw new Error('identity valid-ID vector is invalid');
  }
  for (const item of vectors.invalidIds) {
    if (typeof item.kind !== 'string' || typeof item.value !== 'string') throw new Error('identity invalid-ID vector is invalid');
  }
}

function validateProvenancePackage(policy, schema, vectors, manifest) {
  const expectedLabels = [
    'trusted-user', 'trusted-configuration', 'verified-local-state', 'verified-project',
    'generated-model', 'untrusted-repository', 'untrusted-web', 'untrusted-browser',
    'untrusted-download', 'untrusted-agent', 'secret', 'secret-derived'
  ];
  if (!policy || policy.policyVersion !== manifest.schemaVersion || policy.policyAuthority !== 'toolsenabled') {
    throw new Error('provenance policy must be ToolsEnabled-owned and match the package version');
  }
  if (!Array.isArray(policy.labels) || policy.labels.length !== expectedLabels.length ||
      new Set(policy.labels).size !== expectedLabels.length ||
      expectedLabels.some(label => !policy.labels.includes(label)) ||
      policy.canonicalLabelOrder !== 'ASCII lexical ascending') {
    throw new Error('provenance policy labels must match Section 10 exactly');
  }
  if (policy.sourceReference?.evidenceIdPattern !== '^ev_[A-Za-z0-9_-]{8,128}$' ||
      policy.sourceReference?.contentHashPattern !== '^[a-f0-9]{64}$') {
    throw new Error('provenance policy source references are invalid');
  }
  const requiredSinks = ['command', 'memory', 'secret', 'approval', 'network', 'external-write'];
  if (!Array.isArray(policy.sinks) || policy.sinks.length !== requiredSinks.length ||
      new Set(policy.sinks.map(item => item.sink)).size !== requiredSinks.length ||
      requiredSinks.some(sink => !policy.sinks.some(item => item.sink === sink))) {
    throw new Error('provenance policy sink list is incomplete');
  }
  for (const item of policy.sinks) {
    if (!Array.isArray(item.denyLabels) || !item.denyLabels.length ||
        new Set(item.denyLabels).size !== item.denyLabels.length ||
        item.denyLabels.some(label => !expectedLabels.includes(label))) {
      throw new Error('provenance policy has an invalid sink deny-list');
    }
  }
  if (policy.sinkDenySemantics !== 'Any matching deny label blocks the sink; no other label can override a deny.') {
    throw new Error('provenance policy must give deny labels precedence');
  }
  const propagation = policy.propagation || {};
  if (propagation.concatenation !== 'union-input-labels-and-source-evidence' ||
      propagation.calculation !== 'union-input-labels-and-source-evidence' ||
      propagation.redaction !== 'union-input-labels-and-source-evidence; add secret-derived when any input is secret or secret-derived' ||
      propagation.agentTransformation !== 'union-input-labels-and-source-evidence; add untrusted-agent' ||
      propagation.modelSummary !== 'union-input-labels-and-source-evidence; add generated-model') {
    throw new Error('provenance policy propagation rules are incomplete');
  }
  if (!Array.isArray(policy.safeDisplay?.fields) ||
      stable(policy.safeDisplay.fields) !== stable(['labels', 'sourceCount', 'containsSecret']) ||
      policy.safeDisplay.includeSourceIdentifiers !== false || policy.safeDisplay.includeContent !== false ||
      policy.authorization?.provenanceAllowsAction !== false ||
      policy.authorization?.sinkAllowIsNecessaryButNotSufficient !== true) {
    throw new Error('provenance policy display or authorization policy is invalid');
  }
  if (!schema || schema.$id !== 'urn:coordinator:platform:provenance:' + manifest.schemaVersion ||
      schema.type !== 'object' || schema.additionalProperties !== false ||
      schema.properties?.schemaVersion?.const !== manifest.schemaVersion ||
      stable(schema.properties?.labels?.items?.enum) !== stable(expectedLabels) ||
      schema.properties?.labels?.minItems !== 1 ||
      schema.properties?.sources?.items?.properties?.evidenceId?.pattern !== policy.sourceReference.evidenceIdPattern ||
      schema.properties?.sources?.items?.properties?.contentHash?.pattern !== policy.sourceReference.contentHashPattern ||
      stable(schema.required) !== stable(['schemaVersion', 'labels', 'sources'])) {
    throw new Error('provenance envelope schema is invalid');
  }
  validatePortableSchema(schema, 'provenance');
  if (!vectors || !vectors.envelopes || !Array.isArray(vectors.invalidEnvelopes) ||
      !vectors.operations || !Array.isArray(vectors.sinkChecks) || !vectors.safeDisplay) {
    throw new Error('provenance vectors are incomplete');
  }
  for (const operation of ['concatenation', 'calculation', 'redaction', 'agentTransformation', 'modelSummary']) {
    if (!vectors.operations[operation] || !Array.isArray(vectors.operations[operation].inputs) ||
        !Array.isArray(vectors.operations[operation].expectedLabels) ||
        !Array.isArray(vectors.operations[operation].expectedEvidenceIds)) {
      throw new Error('provenance operation vector is incomplete: ' + operation);
    }
  }
}

function validateRedactionPackage(policy, schema, vectors, manifest) {
  const egressKinds = ['provider', 'log', 'sse', 'evidence-export', 'notification', 'training-candidate'];
  const categories = [
    'secret-handle', 'account-identifier', 'cookie', 'token', 'auth-code',
    'private-key', 'payment', 'credential', 'canary', 'user-sensitive'
  ];
  if (!policy || policy.policyVersion !== manifest.schemaVersion || policy.policyAuthority !== 'toolsenabled' ||
      policy.serviceId !== 'coordinator-platform-redaction-v1' || policy.replacement !== '[REDACTED]' ||
      policy.maxDepth !== 32 || stable(policy.egressKinds) !== stable(egressKinds)) {
    throw new Error('redaction policy identity or egress list is invalid');
  }
  const ruleIds = new Set();
  const fieldNames = new Set();
  if (!Array.isArray(policy.fieldRules) || !policy.fieldRules.length ||
      !Array.isArray(policy.suffixRules) || !policy.suffixRules.length ||
      !Array.isArray(policy.textRules) || !policy.textRules.length) {
    throw new Error('redaction policy rule lists must be non-empty arrays');
  }
  for (const item of policy.fieldRules) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(item.id || '') || ruleIds.has(item.id) ||
        !categories.includes(item.category) || !Array.isArray(item.names) || !item.names.length) {
      throw new Error('redaction field rule is invalid');
    }
    ruleIds.add(item.id);
    for (const name of item.names) {
      if (!/^[a-z0-9]{2,64}$/.test(name) || fieldNames.has(name)) throw new Error('redaction field name is invalid or duplicated');
      fieldNames.add(name);
    }
  }
  for (const item of policy.suffixRules) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(item.id || '') || ruleIds.has(item.id) ||
        !categories.includes(item.category) || !Array.isArray(item.suffixes) || !item.suffixes.length ||
        item.suffixes.some(value => !/^[a-z0-9]{4,32}$/.test(value))) {
      throw new Error('redaction suffix rule is invalid');
    }
    ruleIds.add(item.id);
  }
  for (const item of policy.textRules) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(item.id || '') || ruleIds.has(item.id) ||
        !categories.includes(item.category) || typeof item.pattern !== 'string' ||
        !item.pattern || item.pattern.length > 1024 || /[^\x20-\x7e]/.test(item.pattern) ||
        /(\(\?|\\[pPk1-9])/.test(item.pattern) || typeof item.caseInsensitive !== 'boolean') {
      throw new Error('redaction text rule is invalid or non-portable');
    }
    try { new RegExp(item.pattern, item.caseInsensitive ? 'gi' : 'g'); }
    catch { throw new Error('redaction text rule does not compile'); }
    ruleIds.add(item.id);
  }
  const customization = policy.customization || {};
  if (customization.mode !== 'exact-literal-values-and-exact-field-names' ||
      customization.maximumValues !== 32 || customization.minimumValueLength !== 4 ||
      customization.maximumValueLength !== 1024 || customization.maximumFieldNames !== 32 ||
      customization.fieldNamePattern !== '^[A-Za-z][A-Za-z0-9_.-]{0,63}$') {
    throw new Error('redaction customization boundary is invalid');
  }
  if (stable(policy.preparedEgress?.fields) !== stable(['payload', 'redactionReport']) ||
      policy.preparedEgress.gateRescansPayload !== true ||
      policy.preparedEgress.reportMarkerAloneIsSufficient !== false) {
    throw new Error('redaction prepared-egress gate policy is invalid');
  }
  if (!schema || schema.$id !== 'urn:coordinator:platform:redaction-report:' + manifest.schemaVersion ||
      schema.type !== 'object' || schema.additionalProperties !== false ||
      schema.properties?.schemaVersion?.const !== manifest.schemaVersion ||
      schema.properties?.serviceId?.const !== policy.serviceId ||
      stable(schema.properties?.egress?.enum) !== stable(egressKinds) ||
      schema.properties?.applied?.const !== true ||
      stable(schema.properties?.findings?.items?.properties?.category?.enum) !== stable(categories) ||
      stable(schema.required) !== stable([
        'schemaVersion', 'serviceId', 'egress', 'applied', 'changed',
        'canaryDetected', 'canaryCount', 'findingCount', 'findings'
      ])) {
    throw new Error('redaction report schema is invalid');
  }
  validatePortableSchema(schema, 'redaction-report');
  if (!vectors || vectors.fixtureVersion !== manifest.schemaVersion || !vectors.payloads ||
      !Array.isArray(vectors.egressCases) || vectors.egressCases.length !== egressKinds.length ||
      stable(vectors.egressCases.map(item => item.egress)) !== stable(egressKinds) ||
      vectors.egressCases.some(item => !Object.hasOwn(vectors.payloads, item.payload)) ||
      !vectors.customization || !vectors.harmless) {
    throw new Error('redaction vectors are incomplete');
  }
  if (vectors.egressCases.some(item => !JSON.stringify(vectors.payloads[item.payload]).includes('TOOLSENABLED_CANARY_'))) {
    throw new Error('every redaction egress vector must contain an obvious fake canary');
  }
}

function assertAdditiveCompatible(previous, current) {
  const oldVersion = String(previous?.properties?.schemaVersion?.const || '');
  const newVersion = String(current?.properties?.schemaVersion?.const || '');
  if (!oldVersion || oldVersion.split('.')[0] !== newVersion.split('.')[0]) {
    throw new Error('compatibility comparison requires matching major versions');
  }
  if (previous.type !== 'object' || current.type !== 'object' ||
      previous.additionalProperties !== current.additionalProperties) {
    throw new Error('object shape changed incompatibly');
  }
  const oldProperties = previous.properties || {};
  const newProperties = current.properties || {};
  for (const key of Object.keys(oldProperties)) {
    if (!Object.hasOwn(newProperties, key) || stable(oldProperties[key]) !== stable(newProperties[key])) {
      throw new Error('existing field changed incompatibly: ' + key);
    }
  }
  const oldRequired = new Set(previous.required || []);
  const newRequired = new Set(current.required || []);
  for (const key of oldRequired) if (!newRequired.has(key)) throw new Error('required field removed: ' + key);
  for (const key of newRequired) if (!oldRequired.has(key)) throw new Error('new required field is breaking: ' + key);
  return true;
}

function tsType(schema) {
  if (Object.hasOwn(schema, 'const')) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  if (schema.type === 'string') return 'string';
  if (schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'array') return 'readonly ' + tsType(schema.items || {}) + '[]';
  if (schema.type === 'object') return 'Readonly<Record<string, unknown>>';
  return 'unknown';
}

function renderTypes(source) {
  const lines = [
    '// Generated by tools/generate-platform-contracts.js. Do not edit.',
    "export const COORDINATOR_PLATFORM_SCHEMA_VERSION = '" + source.manifest.schemaVersion + "' as const;",
    'export type CoordinatorPlatformContractName = ' + source.manifest.schemas.map(item => "'" + item.name + "'").join(' | ') + ';',
    ''
  ];
  for (const item of source.manifest.schemas) {
    const schema = source.schemas[item.name];
    const required = new Set(schema.required || []);
    lines.push('export interface ' + className(item.name) + ' {');
    for (const [key, property] of Object.entries(schema.properties || {})) {
      lines.push('  readonly ' + key + (required.has(key) ? '' : '?') + ': ' + tsType(property) + ';');
    }
    lines.push('}', '');
  }
  lines.push('export type CoordinatorPlatformContract =');
  for (const item of source.manifest.schemas) lines.push('  | ' + className(item.name));
  lines.push(';', '');
  return lines.join('\n');
}

function renderJavaScriptValidator(source) {
  const packageJson = JSON.stringify(source, null, 2);
  const lines = [
    "'use strict';",
    '// Generated by tools/generate-platform-contracts.js. Do not edit.',
    'const PACKAGE = Object.freeze(' + packageJson + ');',
    'const SAFE_MAX = Number.MAX_SAFE_INTEGER;',
    "function fail(p, m) { throw new TypeError(p + ': ' + m); }",
    "function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }",
    "function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }",
    "function dynamic(v, p) {",
    "  if (v === null || typeof v === 'boolean' || typeof v === 'string') return;",
    "  if (typeof v === 'number') { if (!Number.isSafeInteger(v)) fail(p, 'dynamic JSON requires a safe integer'); return; }",
    "  if (Array.isArray(v)) { v.forEach((x, i) => dynamic(x, p + '[' + i + ']')); return; }",
    "  if (!object(v)) fail(p, 'dynamic JSON requires JSON values');",
    "  for (const k of Object.keys(v)) { if (!/^[\\x20-\\x7e]*$/.test(k)) fail(p, 'dynamic JSON requires ASCII object keys'); dynamic(v[k], p + '.' + k); }",
    "}",
    "function validateValue(s, v, p) {",
    "  if (Object.hasOwn(s, 'const') && !same(v, s.const)) fail(p, 'must equal const');",
    "  if (Array.isArray(s.enum) && !s.enum.some(x => same(v, x))) fail(p, 'must be an allowed enum value');",
    "  if (!s.type) return;",
    "  if (s.type === 'object') {",
    "    if (!object(v)) fail(p, 'must be an object'); const props = s.properties || {};",
    "    for (const k of s.required || []) if (!Object.hasOwn(v, k)) fail(p, 'missing required ' + k);",
    "    if (s.additionalProperties === false) for (const k of Object.keys(v)) if (!Object.hasOwn(props, k)) fail(p, 'unknown property ' + k);",
    "    if (s.additionalProperties === true) for (const k of Object.keys(v)) if (!Object.hasOwn(props, k)) dynamic(v[k], p + '.' + k);",
    "    for (const [k, child] of Object.entries(props)) if (Object.hasOwn(v, k)) validateValue(child, v[k], p + '.' + k); return;",
    "  }",
    "  if (s.type === 'array') { if (!Array.isArray(v)) fail(p, 'must be an array'); if (s.minItems !== undefined && v.length < s.minItems) fail(p, 'has too few items'); v.forEach((x, i) => validateValue(s.items || {}, x, p + '[' + i + ']')); return; }",
    "  if (s.type === 'string') { if (typeof v !== 'string') fail(p, 'must be a string'); if (s.minLength !== undefined && v.length < s.minLength) fail(p, 'is too short'); if (s.maxLength !== undefined && v.length > s.maxLength) fail(p, 'is too long'); if (s.pattern && !(new RegExp(s.pattern)).test(v)) fail(p, 'does not match pattern'); return; }",
    "  if (s.type === 'boolean') { if (typeof v !== 'boolean') fail(p, 'must be boolean'); return; }",
    "  if (s.type === 'integer') { if (!Number.isSafeInteger(v)) fail(p, 'must be a finite safe integer'); if (s.minimum !== undefined && v < s.minimum) fail(p, 'is below minimum'); if (s.maximum !== undefined && v > s.maximum) fail(p, 'is above maximum'); return; }",
    "  fail(p, 'uses unsupported type ' + s.type);",
    "}",
    "function validateContract(name, value) { const schema = PACKAGE.schemas[name]; if (!schema) fail(name, 'unknown contract'); validateValue(schema, value, name); return value; }",
    "function ascii(value) { return JSON.stringify(value).replace(/[^\\x00-\\x7f]/g, c => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')); }",
    "function normalize(value, p = '$') {",
    "  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;",
    "  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail(p, 'canonical form requires a safe integer'); return Object.is(value, -0) ? 0 : value; }",
    "  if (Array.isArray(value)) return value.map((x, i) => normalize(x, p + '[' + i + ']'));",
    "  if (!object(value)) fail(p, 'canonical form requires JSON values'); const out = {};",
    "  for (const k of Object.keys(value).sort()) { if (!/^[\\x20-\\x7e]*$/.test(k)) fail(p, 'canonical form requires ASCII object keys'); out[k] = normalize(value[k], p + '.' + k); } return out;",
    "}",
    "function render(value) { if (value === null) return 'null'; if (typeof value === 'boolean') return value ? 'true' : 'false'; if (typeof value === 'string') return ascii(value); if (typeof value === 'number') return String(value); if (Array.isArray(value)) return '[' + value.map(render).join(',') + ']'; return '{' + Object.keys(value).map(k => ascii(k) + ':' + render(value[k])).join(',') + '}'; }",
    "function canonicalString(value) { return render(normalize(value)); }",
    "function canonicalContract(name, value) { validateContract(name, value); return canonicalString(value); }",
    "module.exports = Object.freeze({ PACKAGE, canonicalContract, canonicalString, normalize, validateContract });",
    ''
  ];
  return lines.join('\n');
}

function renderTypeScriptValidator() {
  return [
    '// Generated by tools/generate-platform-contracts.js. Do not edit.',
    '// This TypeScript surface delegates to the generated dependency-free JavaScript validator core.',
    "export type { CoordinatorPlatformContractName } from './platform.types';",
    "export { canonicalContract, canonicalString, normalize, validateContract } from './platform.validator.js';",
    ''
  ].join('\n');
}

function renderArtifact(source) {
  const schemas = {};
  for (const item of source.manifest.schemas) {
    schemas[item.name] = crypto.createHash('sha256').update(JSON.stringify(source.schemas[item.name])).digest('hex');
  }
  return JSON.stringify({
    artifactVersion: 1,
    package: source.manifest.package,
    wireVersion: source.manifest.schemaVersion,
    schemaAuthority: source.manifest.schemaAuthority,
    canonicalization: source.manifest.canonicalization.id,
    schemaSha256: schemas
  }, null, 2) + '\n';
}

function identityCanonicalString(value) {
  function fail(message) { throw new TypeError('identity canonicalization: ' + message); }
  function ascii(value) {
    return JSON.stringify(value).replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }
  function normalize(value, label = '$') {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) fail(label + ' requires a safe integer');
      return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) return value.map((item, index) => normalize(item, label + '[' + index + ']'));
    if (!value || typeof value !== 'object') fail(label + ' requires JSON values');
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (!/^[\x20-\x7e]*$/.test(key)) fail(label + ' requires ASCII object keys');
      output[key] = normalize(value[key], label + '.' + key);
    }
    return output;
  }
  function render(value) {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') return ascii(value);
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return '[' + value.map(render).join(',') + ']';
    return '{' + Object.keys(value).map(key => ascii(key) + ':' + render(value[key])).join(',') + '}';
  }
  return render(normalize(value));
}

function identityHash(domain, value) {
  if (typeof domain !== 'string' || !/^[a-z][a-z0-9:._-]{0,127}$/.test(domain)) {
    throw new TypeError('identity hash domain is invalid');
  }
  const domainBytes = Buffer.from(domain, 'ascii');
  const payloadBytes = Buffer.from(identityCanonicalString(value), 'ascii');
  const length = value => {
    const output = Buffer.alloc(8);
    output.writeBigUInt64BE(BigInt(value));
    return output;
  };
  const frame = Buffer.concat([
    Buffer.from('coordinator-platform-hash-v1', 'ascii'), Buffer.from([0]),
    length(domainBytes.length), domainBytes, length(payloadBytes.length), payloadBytes
  ]);
  return crypto.createHash('sha256').update(frame).digest('hex');
}

function renderIdentityArtifact(source) {
  const canonical = source.identityVectors.canonical.map(item => ({
    value: item.value,
    canonical: identityCanonicalString(item.value)
  }));
  for (let index = 0; index < canonical.length; index += 1) {
    if (canonical[index].canonical !== source.identityVectors.canonical[index].canonical) {
      throw new Error('identity canonical vector is stale at index ' + index);
    }
  }
  return JSON.stringify({
    artifactVersion: 1,
    policyVersion: source.identityPolicy.policyVersion,
    policySha256: crypto.createHash('sha256').update(JSON.stringify(source.identityPolicy)).digest('hex'),
    framing: source.identityPolicy.canonicalHash.frame,
    canonical,
    hashes: source.identityVectors.hashes.map(item => ({
      domain: item.domain,
      canonical: identityCanonicalString(item.value),
      sha256: identityHash(item.domain, item.value)
    }))
  }, null, 2) + '\n';
}

function renderJavaScriptIdentity(source) {
  const policyJson = JSON.stringify(source.identityPolicy, null, 2);
  return [
    "'use strict';",
    '// Generated by tools/generate-platform-contracts.js. Do not edit.',
    '// P07 lexical identifiers and clocks grant no authority and perform no I/O.',
    "const crypto = require('node:crypto');",
    'const POLICY = Object.freeze(' + policyJson + ');',
    'const SAFE_MAX = Number.MAX_SAFE_INTEGER;',
    'const CONTROL_TIMESTAMP = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/;',
    'const DOMAIN = new RegExp(POLICY.canonicalHash.domainPattern);',
    "function fail(p, m) { throw new TypeError(p + ': ' + m); }",
    "function kindPolicy(kind) { const found = POLICY.idKinds.find(item => item.kind === kind); if (!found) fail('kind', 'unknown ID kind'); return found; }",
    "function validateId(kind, value) { const item = kindPolicy(kind); if (typeof value !== 'string' || !(new RegExp('^' + item.prefix + '_[A-Za-z0-9_-]{' + POLICY.idEncoding.encodedCharacters + '}$')).test(value)) fail('id', 'malformed ' + kind + ' ID'); return value; }",
    "function newId(kind) { const item = kindPolicy(kind); const value = crypto.randomBytes(POLICY.idEncoding.randomBytes).toString('base64url'); if (value.length !== POLICY.idEncoding.encodedCharacters) fail('id', 'unexpected base64url length'); return item.prefix + '_' + value; }",
    "function parseControlTimestamp(value) { if (typeof value !== 'string' || !CONTROL_TIMESTAMP.test(value)) fail('timestamp', 'must be a UTC ISO-8601 control timestamp with milliseconds and Z'); const parsed = new Date(value); if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail('timestamp', 'is not a real UTC control timestamp'); return parsed; }",
    'function utcNowIso() { return new Date().toISOString(); }',
    'function monotonicMilliseconds() { return Number(process.hrtime.bigint() / 1000000n); }',
    'class TaskEventSequence {',
    "  constructor(taskId, next = 1) { validateId('task', taskId); if (!Number.isSafeInteger(next) || next < 1) fail('sequence', 'must begin at a positive safe integer'); this.taskId = taskId; this.nextValue = next; }",
    "  next() { if (this.nextValue >= SAFE_MAX) fail('sequence', 'exhausted'); const value = this.nextValue; this.nextValue += 1; return value; }",
    '}',
    "function ascii(value) { return JSON.stringify(value).replace(/[^\\x00-\\x7f]/g, c => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')); }",
    "function normalize(value, p = '$') { if (value === null || typeof value === 'boolean' || typeof value === 'string') return value; if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail(p, 'canonical form requires a safe integer'); return Object.is(value, -0) ? 0 : value; } if (Array.isArray(value)) return value.map((item, index) => normalize(item, p + '[' + index + ']')); if (!value || typeof value !== 'object') fail(p, 'canonical form requires JSON values'); const output = {}; for (const key of Object.keys(value).sort()) { if (!/^[\\x20-\\x7e]*$/.test(key)) fail(p, 'canonical form requires ASCII object keys'); output[key] = normalize(value[key], p + '.' + key); } return output; }",
    "function render(value) { if (value === null) return 'null'; if (typeof value === 'boolean') return value ? 'true' : 'false'; if (typeof value === 'string') return ascii(value); if (typeof value === 'number') return String(value); if (Array.isArray(value)) return '[' + value.map(render).join(',') + ']'; return '{' + Object.keys(value).map(key => ascii(key) + ':' + render(value[key])).join(',') + '}'; }",
    'function canonicalString(value) { return render(normalize(value)); }',
    "function canonicalHash(domain, value) { if (typeof domain !== 'string' || !DOMAIN.test(domain)) fail('domain', 'must match the canonical hash domain policy'); const domainBytes = Buffer.from(domain, 'ascii'); const payloadBytes = Buffer.from(canonicalString(value), 'ascii'); const length = size => { const output = Buffer.alloc(8); output.writeBigUInt64BE(BigInt(size)); return output; }; const frame = Buffer.concat([Buffer.from(POLICY.canonicalHash.frameVersion, 'ascii'), Buffer.from([0]), length(domainBytes.length), domainBytes, length(payloadBytes.length), payloadBytes]); return crypto.createHash('sha256').update(frame).digest('hex'); }",
    "module.exports = Object.freeze({ POLICY, TaskEventSequence, canonicalHash, canonicalString, monotonicMilliseconds, newId, parseControlTimestamp, utcNowIso, validateId });",
    ''
  ].join('\n');
}

function renderTypeScriptIdentity() {
  return [
    '// Generated by tools/generate-platform-contracts.js. Do not edit.',
    '// This TypeScript surface delegates to the generated dependency-free JavaScript P07 core.',
    "export { POLICY, TaskEventSequence, canonicalHash, canonicalString, monotonicMilliseconds, newId, parseControlTimestamp, utcNowIso, validateId } from './platform.identity.js';",
    ''
  ].join('\n');
}

function renderPythonIdentity(source) {
  const policyJson = JSON.stringify(source.identityPolicy, null, 2);
  return [
    '# Generated by tools/generate-platform-contracts.js. Do not edit.',
    '# P07 lexical identifiers and clocks grant no authority and perform no I/O.',
    'from __future__ import annotations',
    '',
    'import base64',
    'import hashlib',
    'import json',
    'import math',
    'import re',
    'import secrets',
    'import time',
    'from datetime import datetime, timezone',
    'from typing import Any',
    '',
    "POLICY: dict[str, Any] = json.loads(r'''" + policyJson + "''')",
    "SAFE_MAX = 9007199254740991",
    "CONTROL_TIMESTAMP = re.compile(r'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$')",
    "DOMAIN = re.compile(POLICY['canonicalHash']['domainPattern'])",
    '',
    "def _fail(p: str, m: str) -> None: raise ValueError(f'{p}: {m}')",
    "def _kind_policy(kind: str) -> dict[str, Any]:",
    "    for item in POLICY['idKinds']:",
    "        if item['kind'] == kind: return item",
    "    _fail('kind', 'unknown ID kind')",
    "    raise AssertionError('unreachable')",
    "def validate_id(kind: str, value: str) -> str:",
    "    item = _kind_policy(kind)",
    "    pattern = r'^' + re.escape(item['prefix']) + r'_[A-Za-z0-9_-]{' + str(POLICY['idEncoding']['encodedCharacters']) + r'}$'",
    "    if not isinstance(value, str) or re.fullmatch(pattern, value) is None: _fail('id', 'malformed ' + kind + ' ID')",
    "    return value",
    "def new_id(kind: str) -> str:",
    "    item = _kind_policy(kind)",
    "    value = base64.urlsafe_b64encode(secrets.token_bytes(POLICY['idEncoding']['randomBytes'])).decode('ascii').rstrip('=')",
    "    if len(value) != POLICY['idEncoding']['encodedCharacters']: _fail('id', 'unexpected base64url length')",
    "    return item['prefix'] + '_' + value",
    '',
    "def _format_utc(value: datetime) -> str:",
    "    value = value.astimezone(timezone.utc)",
    "    return f'{value.year:04d}-{value.month:02d}-{value.day:02d}T{value.hour:02d}:{value.minute:02d}:{value.second:02d}.{value.microsecond // 1000:03d}Z'",
    "def parse_control_timestamp(value: str) -> datetime:",
    "    if not isinstance(value, str) or CONTROL_TIMESTAMP.fullmatch(value) is None: _fail('timestamp', 'must be a UTC ISO-8601 control timestamp with milliseconds and Z')",
    "    try: parsed = datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)",
    "    except ValueError: _fail('timestamp', 'is not a real UTC control timestamp')",
    "    if _format_utc(parsed) != value: _fail('timestamp', 'is not a real UTC control timestamp')",
    "    return parsed",
    "def utc_now_iso() -> str: return _format_utc(datetime.now(timezone.utc))",
    "def monotonic_milliseconds() -> int: return time.monotonic_ns() // 1_000_000",
    '',
    "class TaskEventSequence:",
    "    def __init__(self, task_id: str, next_value: int = 1) -> None:",
    "        self.task_id = validate_id('task', task_id)",
    "        if type(next_value) is not int or next_value < 1 or next_value > SAFE_MAX: _fail('sequence', 'must begin at a positive safe integer')",
    "        self.next_value = next_value",
    "    def next(self) -> int:",
    "        if self.next_value >= SAFE_MAX: _fail('sequence', 'exhausted')",
    "        value = self.next_value",
    "        self.next_value += 1",
    "        return value",
    '',
    "def _normalize(value: Any, p: str = '$') -> Any:",
    "    if value is None or type(value) is bool or isinstance(value, str): return value",
    "    if type(value) is int:",
    "        if abs(value) > SAFE_MAX: _fail(p, 'canonical form requires a safe integer')",
    "        return value",
    "    if type(value) is float:",
    "        if not math.isfinite(value) or not value.is_integer() or abs(value) > SAFE_MAX: _fail(p, 'canonical form requires a safe integer')",
    "        return int(value)",
    "    if isinstance(value, list): return [_normalize(item, p + '[' + str(index) + ']') for index, item in enumerate(value)]",
    "    if not isinstance(value, dict): _fail(p, 'canonical form requires JSON values')",
    "    output: dict[str, Any] = {}",
    "    for key in sorted(value):",
    "        if not isinstance(key, str) or any(ord(char) < 32 or ord(char) > 126 for char in key): _fail(p, 'canonical form requires ASCII object keys')",
    "        output[key] = _normalize(value[key], p + '.' + key)",
    "    return output",
    "def canonical_string(value: Any) -> str: return json.dumps(_normalize(value), ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False)",
    "def canonical_hash(domain: str, value: Any) -> str:",
    "    if not isinstance(domain, str) or DOMAIN.fullmatch(domain) is None: _fail('domain', 'must match the canonical hash domain policy')",
    "    domain_bytes = domain.encode('ascii')",
    "    payload_bytes = canonical_string(value).encode('ascii')",
    "    frame = (POLICY['canonicalHash']['frameVersion'].encode('ascii') + bytes([0]) + len(domain_bytes).to_bytes(8, 'big') + domain_bytes + len(payload_bytes).to_bytes(8, 'big') + payload_bytes)",
    "    return hashlib.sha256(frame).hexdigest()",
    '',
    "__all__ = ['POLICY', 'TaskEventSequence', 'canonical_hash', 'canonical_string', 'monotonic_milliseconds', 'new_id', 'parse_control_timestamp', 'utc_now_iso', 'validate_id']",
    ''
  ].join('\n');
}

function provenancePolicyItem(policy, sink) {
  const item = policy.sinks.find(candidate => candidate.sink === sink);
  if (!item) throw new TypeError('unknown provenance sink');
  return item;
}

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function provenanceCanonicalEnvelope(source, labels, sources) {
  const allowed = new Set(source.provenancePolicy.labels);
  if (!Array.isArray(labels) || !labels.length || labels.some(label => typeof label !== 'string' || !allowed.has(label))) {
    throw new TypeError('invalid provenance labels');
  }
  const canonicalLabels = [...new Set(labels)].sort();
  const idPattern = new RegExp(source.provenancePolicy.sourceReference.evidenceIdPattern);
  const hashPattern = new RegExp(source.provenancePolicy.sourceReference.contentHashPattern);
  if (!Array.isArray(sources)) throw new TypeError('invalid provenance sources');
  const canonicalSources = sources.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).length !== 2 ||
        typeof item.evidenceId !== 'string' || !idPattern.test(item.evidenceId) ||
        typeof item.contentHash !== 'string' || !hashPattern.test(item.contentHash)) {
      throw new TypeError('invalid provenance source');
    }
    return { evidenceId: item.evidenceId, contentHash: item.contentHash };
  }).sort((left, right) => asciiCompare(left.evidenceId + '\u0000' + left.contentHash, right.evidenceId + '\u0000' + right.contentHash));
  const seen = new Set();
  for (const item of canonicalSources) {
    const key = item.evidenceId + '\u0000' + item.contentHash;
    if (seen.has(key)) throw new TypeError('duplicate provenance source');
    seen.add(key);
  }
  return { schemaVersion: source.provenancePolicy.policyVersion, labels: canonicalLabels, sources: canonicalSources };
}

function provenanceOperationVector(source, operation) {
  const vector = source.provenanceVectors.operations[operation];
  const inputs = vector.inputs.map(name => {
    const envelope = source.provenanceVectors.envelopes[name];
    if (!envelope) throw new Error('unknown provenance fixture envelope: ' + name);
    return provenanceCanonicalEnvelope(source, envelope.labels, envelope.sources);
  });
  const labels = inputs.flatMap(item => item.labels);
  if (operation === 'redaction' && labels.some(label => label === 'secret' || label === 'secret-derived')) labels.push('secret-derived');
  if (operation === 'agentTransformation') labels.push('untrusted-agent');
  if (operation === 'modelSummary') labels.push('generated-model');
  const result = provenanceCanonicalEnvelope(source, labels, inputs.flatMap(item => item.sources));
  if (stable(result.labels) !== stable(vector.expectedLabels) ||
      stable(result.sources.map(item => item.evidenceId)) !== stable(vector.expectedEvidenceIds)) {
    throw new Error('provenance vector is stale for ' + operation);
  }
  return result;
}

function renderProvenanceArtifact(source) {
  const operations = {};
  for (const operation of Object.keys(source.provenanceVectors.operations)) {
    operations[operation] = provenanceOperationVector(source, operation);
  }
  const sinkChecks = source.provenanceVectors.sinkChecks.map(item => {
    const envelope = source.provenanceVectors.envelopes[item.input];
    if (!envelope) throw new Error('unknown provenance sink input: ' + item.input);
    const checked = provenanceCanonicalEnvelope(source, envelope.labels, envelope.sources);
    const denied = provenancePolicyItem(source.provenancePolicy, item.sink).denyLabels;
    const blockingLabels = checked.labels.filter(label => denied.includes(label));
    if (item.allowed !== (blockingLabels.length === 0) || stable(item.blockingLabels) !== stable(blockingLabels)) {
      throw new Error('provenance sink vector is stale for ' + item.sink);
    }
    return { sink: item.sink, envelope: item.input, allowed: item.allowed, blockingLabels };
  });
  const displayEnvelope = source.provenanceVectors.envelopes[source.provenanceVectors.safeDisplay.input];
  const safeDisplay = {
    labels: displayEnvelope.labels,
    sourceCount: displayEnvelope.sources.length,
    containsSecret: displayEnvelope.labels.includes('secret') || displayEnvelope.labels.includes('secret-derived')
  };
  if (stable(safeDisplay) !== stable(source.provenanceVectors.safeDisplay.expected)) {
    throw new Error('provenance safe-display vector is stale');
  }
  return JSON.stringify({
    artifactVersion: 1,
    policyVersion: source.provenancePolicy.policyVersion,
    policySha256: crypto.createHash('sha256').update(JSON.stringify(source.provenancePolicy)).digest('hex'),
    schemaSha256: crypto.createHash('sha256').update(JSON.stringify(source.provenanceSchema)).digest('hex'),
    canonicalLabelOrder: source.provenancePolicy.canonicalLabelOrder,
    operations,
    sinkChecks,
    safeDisplay
  }, null, 2) + '\n';
}

function renderJavaScriptProvenance(source) {
  const policyJson = JSON.stringify(source.provenancePolicy, null, 2);
  const schemaJson = JSON.stringify(source.provenanceSchema, null, 2);
  return [
    "'use strict';",
    '// Generated by tools/generate-platform-contracts.js. Do not edit.',
    '// P08 provenance is structured metadata only; sink approval never grants authority.',
    'const POLICY = Object.freeze(' + policyJson + ');',
    'const SCHEMA = Object.freeze(' + schemaJson + ');',
    'const LABELS = Object.freeze([...POLICY.labels].sort());',
    'const LABEL_SET = new Set(LABELS);',
    'const EVIDENCE_ID = new RegExp(POLICY.sourceReference.evidenceIdPattern);',
    'const CONTENT_HASH = new RegExp(POLICY.sourceReference.contentHashPattern);',
    "function fail(p, m) { throw new TypeError(p + ': ' + m); }",
    "function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }",
    "function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }",
    "function asciiCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }",
    "function sourceKey(value) { return value.evidenceId + '\\u0000' + value.contentHash; }",
    "function canonicalLabels(labels) { if (!Array.isArray(labels) || !labels.length || labels.some(label => typeof label !== 'string' || !LABEL_SET.has(label))) fail('labels', 'must be a non-empty array of known provenance labels'); return [...new Set(labels)].sort(); }",
    "function canonicalSources(sources) { if (!Array.isArray(sources)) fail('sources', 'must be an array'); const output = sources.map((item, index) => { if (!object(item) || Object.keys(item).length !== 2 || typeof item.evidenceId !== 'string' || !EVIDENCE_ID.test(item.evidenceId) || typeof item.contentHash !== 'string' || !CONTENT_HASH.test(item.contentHash)) fail('sources[' + index + ']', 'must be a safe evidence reference'); return { evidenceId: item.evidenceId, contentHash: item.contentHash }; }).sort((left, right) => asciiCompare(sourceKey(left), sourceKey(right))); if (new Set(output.map(sourceKey)).size !== output.length) fail('sources', 'must not duplicate evidence references'); return output; }",
    "function createEnvelope(labels, sources = []) { return Object.freeze({ schemaVersion: POLICY.policyVersion, labels: Object.freeze(canonicalLabels(labels)), sources: Object.freeze(canonicalSources(sources).map(item => Object.freeze(item))) }); }",
    "function validateEnvelope(value) { if (!object(value) || Object.keys(value).length !== 3 || value.schemaVersion !== POLICY.policyVersion) fail('envelope', 'must be a closed current provenance envelope'); const canonical = createEnvelope(value.labels, value.sources); if (!same(canonical.labels, value.labels) || !same(canonical.sources, value.sources)) fail('envelope', 'labels and sources must be canonical ASCII-lexical unique arrays'); return value; }",
    "function combine(inputs, additions = []) { if (!Array.isArray(inputs) || !inputs.length) fail('inputs', 'must contain at least one provenance envelope'); const checked = inputs.map(validateEnvelope); return createEnvelope(checked.flatMap(item => item.labels).concat(additions), checked.flatMap(item => item.sources)); }",
    'function concatenate(inputs) { return combine(inputs); }',
    'function calculate(inputs) { return combine(inputs); }',
    "function redact(inputs) { const checked = inputs.map(validateEnvelope); const hasSecret = checked.some(item => item.labels.includes('secret') || item.labels.includes('secret-derived')); return combine(checked, hasSecret ? ['secret-derived'] : []); }",
    "function agentTransform(inputs) { return combine(inputs, ['untrusted-agent']); }",
    "function modelSummary(inputs) { return combine(inputs, ['generated-model']); }",
    "function attach(value, provenance) { return Object.freeze({ value, provenance: validateEnvelope(provenance) }); }",
    "function validateAttached(value) { if (!object(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'value') || !Object.hasOwn(value, 'provenance')) fail('value', 'must carry a provenance envelope'); validateEnvelope(value.provenance); return value; }",
    "function sinkPolicy(sink) { const item = POLICY.sinks.find(candidate => candidate.sink === sink); if (!item) fail('sink', 'unknown consequential sink'); return item; }",
    "function evaluateSink(provenance, sink) { const checked = validateEnvelope(provenance); const policy = sinkPolicy(sink); const blockingLabels = checked.labels.filter(label => policy.denyLabels.includes(label)); return Object.freeze({ sink, allowed: blockingLabels.length === 0, code: blockingLabels.length === 0 ? 'OK' : 'PROVENANCE_VIOLATION', blockingLabels: Object.freeze(blockingLabels) }); }",
    "function requireSink(provenance, sink) { const decision = evaluateSink(provenance, sink); if (!decision.allowed) { const error = new Error('PROVENANCE_VIOLATION: ' + sink + ' blocks ' + decision.blockingLabels.join(',')); error.code = decision.code; error.decision = decision; throw error; } return decision; }",
    "function safeDisplay(provenance) { const checked = validateEnvelope(provenance); return Object.freeze({ labels: Object.freeze([...checked.labels]), sourceCount: checked.sources.length, containsSecret: checked.labels.includes('secret') || checked.labels.includes('secret-derived') }); }",
    "module.exports = Object.freeze({ LABELS, POLICY, SCHEMA, agentTransform, attach, calculate, canonicalLabels, canonicalSources, combine, concatenate, createEnvelope, evaluateSink, modelSummary, redact, requireSink, safeDisplay, validateAttached, validateEnvelope });",
    ''
  ].join('\n');
}

function renderTypeScriptProvenance() {
  return [
    '// Generated by tools/generate-platform-contracts.js. Do not edit.',
    '// This TypeScript surface delegates to the generated dependency-free JavaScript P08 core.',
    "export { LABELS, POLICY, SCHEMA, agentTransform, attach, calculate, canonicalLabels, canonicalSources, combine, concatenate, createEnvelope, evaluateSink, modelSummary, redact, requireSink, safeDisplay, validateAttached, validateEnvelope } from './platform.provenance.js';",
    ''
  ].join('\n');
}

function renderPythonProvenance(source) {
  const policyJson = JSON.stringify(source.provenancePolicy, null, 2);
  const schemaJson = JSON.stringify(source.provenanceSchema, null, 2);
  return [
    '# Generated by tools/generate-platform-contracts.js. Do not edit.',
    '# P08 provenance is structured metadata only; sink approval never grants authority.',
    'from __future__ import annotations',
    '',
    'import json',
    'import re',
    'from typing import Any, Iterable, Mapping',
    '',
    "POLICY: dict[str, Any] = json.loads(r'''" + policyJson + "''')",
    "SCHEMA: dict[str, Any] = json.loads(r'''" + schemaJson + "''')",
    "LABELS = tuple(sorted(POLICY['labels']))",
    'LABEL_SET = frozenset(LABELS)',
    "EVIDENCE_ID = re.compile(POLICY['sourceReference']['evidenceIdPattern'])",
    "CONTENT_HASH = re.compile(POLICY['sourceReference']['contentHashPattern'])",
    '',
    "def _fail(p: str, m: str) -> None: raise ValueError(f'{p}: {m}')",
    "def _same(left: Any, right: Any) -> bool: return left == right",
    "def _source_key(value: Mapping[str, str]) -> tuple[str, str]: return (value['evidenceId'], value['contentHash'])",
    "def canonical_labels(labels: Iterable[str]) -> list[str]:",
    "    values = list(labels) if not isinstance(labels, str) else []",
    "    if not values or any(type(label) is not str or label not in LABEL_SET for label in values): _fail('labels', 'must be a non-empty array of known provenance labels')",
    "    return sorted(set(values))",
    "def canonical_sources(sources: Iterable[Mapping[str, str]]) -> list[dict[str, str]]:",
    "    if isinstance(sources, (str, bytes)) or not isinstance(sources, Iterable): _fail('sources', 'must be an array')",
    "    output: list[dict[str, str]] = []",
    "    for index, item in enumerate(sources):",
    "        if not isinstance(item, Mapping) or set(item) != {'evidenceId', 'contentHash'} or type(item['evidenceId']) is not str or EVIDENCE_ID.fullmatch(item['evidenceId']) is None or type(item['contentHash']) is not str or CONTENT_HASH.fullmatch(item['contentHash']) is None: _fail('sources[' + str(index) + ']', 'must be a safe evidence reference')",
    "        output.append({'evidenceId': item['evidenceId'], 'contentHash': item['contentHash']})",
    "    output.sort(key=_source_key)",
    "    if len({_source_key(item) for item in output}) != len(output): _fail('sources', 'must not duplicate evidence references')",
    "    return output",
    "def create_envelope(labels: Iterable[str], sources: Iterable[Mapping[str, str]] = ()) -> dict[str, Any]:",
    "    return {'schemaVersion': POLICY['policyVersion'], 'labels': canonical_labels(labels), 'sources': canonical_sources(sources)}",
    "def validate_envelope(value: Mapping[str, Any]) -> Mapping[str, Any]:",
    "    if not isinstance(value, Mapping) or set(value) != {'schemaVersion', 'labels', 'sources'} or value['schemaVersion'] != POLICY['policyVersion']: _fail('envelope', 'must be a closed current provenance envelope')",
    "    canonical = create_envelope(value['labels'], value['sources'])",
    "    if not _same(canonical, value): _fail('envelope', 'labels and sources must be canonical ASCII-lexical unique arrays')",
    "    return value",
    "def combine(inputs: Iterable[Mapping[str, Any]], additions: Iterable[str] = ()) -> dict[str, Any]:",
    "    if isinstance(inputs, (str, bytes)) or not isinstance(inputs, Iterable): _fail('inputs', 'must contain at least one provenance envelope')",
    "    checked = [validate_envelope(item) for item in inputs]",
    "    if not checked: _fail('inputs', 'must contain at least one provenance envelope')",
    "    return create_envelope([label for item in checked for label in item['labels']] + list(additions), [source for item in checked for source in item['sources']])",
    "def concatenate(inputs: Iterable[Mapping[str, Any]]) -> dict[str, Any]: return combine(inputs)",
    "def calculate(inputs: Iterable[Mapping[str, Any]]) -> dict[str, Any]: return combine(inputs)",
    "def redact(inputs: Iterable[Mapping[str, Any]]) -> dict[str, Any]:",
    "    checked = [validate_envelope(item) for item in inputs]",
    "    has_secret = any('secret' in item['labels'] or 'secret-derived' in item['labels'] for item in checked)",
    "    return combine(checked, ['secret-derived'] if has_secret else [])",
    "def agent_transform(inputs: Iterable[Mapping[str, Any]]) -> dict[str, Any]: return combine(inputs, ['untrusted-agent'])",
    "def model_summary(inputs: Iterable[Mapping[str, Any]]) -> dict[str, Any]: return combine(inputs, ['generated-model'])",
    "def attach(value: Any, provenance: Mapping[str, Any]) -> dict[str, Any]: return {'value': value, 'provenance': validate_envelope(provenance)}",
    "def validate_attached(value: Mapping[str, Any]) -> Mapping[str, Any]:",
    "    if not isinstance(value, Mapping) or set(value) != {'value', 'provenance'}: _fail('value', 'must carry a provenance envelope')",
    "    validate_envelope(value['provenance'])",
    "    return value",
    "def _sink_policy(sink: str) -> Mapping[str, Any]:",
    "    for item in POLICY['sinks']:",
    "        if item['sink'] == sink: return item",
    "    _fail('sink', 'unknown consequential sink')",
    "    raise AssertionError('unreachable')",
    "def evaluate_sink(provenance: Mapping[str, Any], sink: str) -> dict[str, Any]:",
    "    checked = validate_envelope(provenance)",
    "    policy = _sink_policy(sink)",
    "    blocking_labels = [label for label in checked['labels'] if label in policy['denyLabels']]",
    "    return {'sink': sink, 'allowed': not blocking_labels, 'code': 'OK' if not blocking_labels else 'PROVENANCE_VIOLATION', 'blockingLabels': blocking_labels}",
    "def require_sink(provenance: Mapping[str, Any], sink: str) -> dict[str, Any]:",
    "    decision = evaluate_sink(provenance, sink)",
    "    if not decision['allowed']: _fail('PROVENANCE_VIOLATION', sink + ' blocks ' + ','.join(decision['blockingLabels']))",
    "    return decision",
    "def safe_display(provenance: Mapping[str, Any]) -> dict[str, Any]:",
    "    checked = validate_envelope(provenance)",
    "    return {'labels': list(checked['labels']), 'sourceCount': len(checked['sources']), 'containsSecret': 'secret' in checked['labels'] or 'secret-derived' in checked['labels']}",
    '',
    "__all__ = ['LABELS', 'POLICY', 'SCHEMA', 'agent_transform', 'attach', 'calculate', 'canonical_labels', 'canonical_sources', 'combine', 'concatenate', 'create_envelope', 'evaluate_sink', 'model_summary', 'redact', 'require_sink', 'safe_display', 'validate_attached', 'validate_envelope']",
    ''
  ].join('\n');
}

function renderRedactionArtifact(source) {
  return JSON.stringify({
    artifactVersion: 1,
    policyVersion: source.redactionPolicy.policyVersion,
    serviceId: source.redactionPolicy.serviceId,
    policySha256: crypto.createHash('sha256').update(JSON.stringify(source.redactionPolicy)).digest('hex'),
    reportSchemaSha256: crypto.createHash('sha256').update(JSON.stringify(source.redactionReportSchema)).digest('hex'),
    fixtureSha256: crypto.createHash('sha256').update(JSON.stringify(source.redactionVectors)).digest('hex'),
    egressCases: source.redactionVectors.egressCases.map(item => ({ egress: item.egress, payload: item.payload })),
    canaryPrefix: 'TOOLSENABLED_CANARY_',
    replacement: source.redactionPolicy.replacement
  }, null, 2) + '\n';
}

function renderJavaScriptRedaction(source) {
  const policyJson = JSON.stringify(source.redactionPolicy, null, 2);
  const schemaJson = JSON.stringify(source.redactionReportSchema, null, 2);
  return [
    "'use strict';",
    '// Generated by tools/generate-platform-contracts.js. Do not edit.',
    '// P09 is an inert, deterministic egress-preparation service with no external I/O.',
    'const POLICY = Object.freeze(' + policyJson + ');',
    'const REPORT_SCHEMA = Object.freeze(' + schemaJson + ');',
    'const EGRESS = new Set(POLICY.egressKinds);',
    'const CUSTOM_FIELD = new RegExp(POLICY.customization.fieldNamePattern);',
    "function fail(p, m) { throw new TypeError(p + ': ' + m); }",
    "function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }",
    "function asciiCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }",
    "function normalizeName(value) { return value.toLowerCase().replace(/[-_.]/g, ''); }",
    "function safeSegment(key, index) { return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) ? key : '<field-' + index + '>'; }",
    "function compileRule(rule) { return new RegExp(rule.pattern, rule.caseInsensitive ? 'gi' : 'g'); }",
    "function validateOptions(options = {}) {",
    "  if (!object(options)) fail('options', 'must be an object');",
    "  for (const key of Object.keys(options)) if (!['sensitiveValues', 'sensitiveFieldNames'].includes(key)) fail('options', 'has unknown field ' + key);",
    "  const values = options.sensitiveValues === undefined ? [] : options.sensitiveValues;",
    "  const fields = options.sensitiveFieldNames === undefined ? [] : options.sensitiveFieldNames;",
    "  if (!Array.isArray(values) || values.length > POLICY.customization.maximumValues || values.some(value => typeof value !== 'string' || value.length < POLICY.customization.minimumValueLength || value.length > POLICY.customization.maximumValueLength || POLICY.replacement.includes(value) || value.includes(POLICY.replacement)) || new Set(values).size !== values.length) fail('sensitiveValues', 'must be bounded unique exact strings that cannot alter the replacement marker');",
    "  if (!Array.isArray(fields) || fields.length > POLICY.customization.maximumFieldNames || fields.some(value => typeof value !== 'string' || !CUSTOM_FIELD.test(value)) || new Set(fields.map(normalizeName)).size !== fields.length) fail('sensitiveFieldNames', 'must be bounded unique exact field names');",
    "  return { values: [...values].sort((left, right) => right.length - left.length || asciiCompare(left, right)), fields: new Set(fields.map(normalizeName)) };",
    "}",
    "function fieldRule(key, options) { const normalized = normalizeName(key); for (const rule of POLICY.fieldRules) if (rule.names.includes(normalized)) return rule; for (const rule of POLICY.suffixRules) if (rule.suffixes.some(suffix => normalized.endsWith(suffix))) return rule; if (options.fields.has(normalized)) return { id: 'user-sensitive-field', category: 'user-sensitive' }; return null; }",
    "function addFinding(findings, path, detectorId, category, count) { if (!count) return; const existing = findings.find(item => item.path === path && item.detectorId === detectorId && item.category === category); if (existing) existing.count += count; else findings.push({ path, detectorId, category, count }); }",
    "function redactText(value, path, findings, options) { let output = value; for (const rule of POLICY.textRules) { const replaced = output.replace(compileRule(rule), () => POLICY.replacement); if (replaced !== output) { const count = (output.match(compileRule(rule)) || []).length; addFinding(findings, path, rule.id, rule.category, count); output = replaced; } } for (const sensitive of options.values) { const count = output.split(sensitive).length - 1; if (count) { addFinding(findings, path, 'user-sensitive-value', 'user-sensitive', count); output = output.split(sensitive).join(POLICY.replacement); } } while (output.includes(POLICY.replacement + POLICY.replacement)) output = output.split(POLICY.replacement + POLICY.replacement).join(POLICY.replacement); return output; }",
    "function scanCanaries(value) {",
    "  const canary = POLICY.textRules.find(rule => rule.id === 'canary-text'); const active = new Set(); let count = 0;",
    "  function scan(item, depth) { if (depth > POLICY.maxDepth) fail('value', 'exceeds redaction depth'); if (item === null || typeof item === 'boolean' || typeof item === 'number') { if (typeof item === 'number' && !Number.isFinite(item)) fail('value', 'requires finite JSON numbers'); return; } if (typeof item === 'string') { count += (item.match(compileRule(canary)) || []).length; return; } if (Array.isArray(item)) { if (active.has(item)) fail('value', 'must be acyclic'); active.add(item); item.forEach(child => scan(child, depth + 1)); active.delete(item); return; } if (!object(item)) fail('value', 'requires JSON-compatible values'); if (active.has(item)) fail('value', 'must be acyclic'); active.add(item); for (const [key, child] of Object.entries(item)) { count += (key.match(compileRule(canary)) || []).length; scan(child, depth + 1); } active.delete(item); }",
    "  scan(value, 0); return Object.freeze({ detected: count > 0, count });",
    "}",
    "function redactStructured(value, rawOptions = {}) {",
    "  const options = validateOptions(rawOptions); const findings = []; const active = new Set();",
    "  function visit(item, path, depth) {",
    "    if (depth > POLICY.maxDepth) fail(path, 'exceeds redaction depth');",
    "    if (item === null || typeof item === 'boolean') return item;",
    "    if (typeof item === 'number') { if (!Number.isFinite(item)) fail(path, 'requires finite JSON numbers'); return item; }",
    "    if (typeof item === 'string') return redactText(item, path, findings, options);",
    "    if (Array.isArray(item)) { if (active.has(item)) fail(path, 'must be acyclic'); active.add(item); const output = item.map((child, index) => visit(child, path + '[' + index + ']', depth + 1)); active.delete(item); return output; }",
    "    if (!object(item)) fail(path, 'requires JSON-compatible values'); if (active.has(item)) fail(path, 'must be acyclic'); active.add(item); const output = {}; let index = 0;",
    "    for (const [key, child] of Object.entries(item)) { const keyFindings = []; const redactedKey = redactText(key, path + '.<key>', keyFindings, options); const segment = redactedKey === key ? safeSegment(key, index) : '<redacted-key-' + index + '>'; let outputKey = redactedKey === key ? key : 'redactedField' + index; while (Object.hasOwn(output, outputKey)) outputKey += '_'; findings.push(...keyFindings); const rule = fieldRule(key, options); if (rule && child !== POLICY.replacement) { output[outputKey] = POLICY.replacement; addFinding(findings, path + '.' + segment, rule.id, rule.category, 1); } else output[outputKey] = visit(child, path + '.' + segment, depth + 1); index += 1; }",
    "    active.delete(item); return output;",
    "  }",
    "  const canaries = scanCanaries(value); const output = visit(value, '$', 0); findings.sort((left, right) => asciiCompare(left.path, right.path) || asciiCompare(left.detectorId, right.detectorId) || asciiCompare(left.category, right.category)); return { value: output, findings, canaryDetected: canaries.detected, canaryCount: canaries.count, changed: findings.length > 0 };",
    "}",
    "function validateReport(report) {",
    "  const required = ['schemaVersion','serviceId','egress','applied','changed','canaryDetected','canaryCount','findingCount','findings']; if (!object(report) || Object.keys(report).length !== required.length || required.some(key => !Object.hasOwn(report, key)) || report.schemaVersion !== POLICY.policyVersion || report.serviceId !== POLICY.serviceId || !EGRESS.has(report.egress) || report.applied !== true || typeof report.changed !== 'boolean' || typeof report.canaryDetected !== 'boolean' || !Number.isSafeInteger(report.canaryCount) || report.canaryCount < 0 || !Number.isSafeInteger(report.findingCount) || report.findingCount < 0 || !Array.isArray(report.findings)) fail('redactionReport', 'is invalid');",
    "  const categories = new Set(REPORT_SCHEMA.properties.findings.items.properties.category.enum); let total = 0; let prior = null; for (const item of report.findings) { if (!object(item) || Object.keys(item).length !== 4 || typeof item.path !== 'string' || item.path.length < 1 || item.path.length > 512 || typeof item.detectorId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(item.detectorId) || !categories.has(item.category) || !Number.isSafeInteger(item.count) || item.count < 1) fail('redactionReport.findings', 'is invalid'); const key = item.path + '\\u0000' + item.detectorId + '\\u0000' + item.category; if (prior !== null && asciiCompare(prior, key) >= 0) fail('redactionReport.findings', 'must be canonical and unique'); prior = key; total += item.count; }",
    "  if (report.findingCount !== total || report.changed !== (total > 0) || report.canaryDetected !== (report.canaryCount > 0)) fail('redactionReport', 'counts are inconsistent'); return report;",
    "}",
    "function prepareEgress(egress, payload, options = {}) { if (!EGRESS.has(egress)) fail('egress', 'unknown egress kind'); const redacted = redactStructured(payload, options); const findingCount = redacted.findings.reduce((sum, item) => sum + item.count, 0); const report = { schemaVersion: POLICY.policyVersion, serviceId: POLICY.serviceId, egress, applied: true, changed: redacted.changed, canaryDetected: redacted.canaryDetected, canaryCount: redacted.canaryCount, findingCount, findings: redacted.findings }; validateReport(report); return Object.freeze({ payload: redacted.value, redactionReport: Object.freeze(report) }); }",
    "function verifyPreparedEgress(envelope, expectedEgress, options = {}) { if (!object(envelope) || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'payload') || !Object.hasOwn(envelope, 'redactionReport')) fail('preparedEgress', 'missing redaction pass envelope'); const report = validateReport(envelope.redactionReport); if (report.egress !== expectedEgress) fail('preparedEgress', 'egress mismatch'); const residual = redactStructured(envelope.payload, options); if (residual.canaryDetected || residual.changed) fail('preparedEgress', 'residual sensitive material detected'); return envelope; }",
    "function assertNoCanaries(value) { const result = scanCanaries(value); if (result.detected) fail('canary', 'secret canary detected'); return value; }",
    "module.exports = Object.freeze({ POLICY, REPORT_SCHEMA, assertNoCanaries, prepareEgress, redactStructured, scanCanaries, validateReport, verifyPreparedEgress });",
    ''
  ].join('\n');
}

function renderTypeScriptRedaction() {
  return [
    '// Generated by tools/generate-platform-contracts.js. Do not edit.',
    '// This TypeScript surface delegates to the generated dependency-free JavaScript P09 core.',
    "export { POLICY, REPORT_SCHEMA, assertNoCanaries, prepareEgress, redactStructured, scanCanaries, validateReport, verifyPreparedEgress } from './platform.redaction.js';",
    ''
  ].join('\n');
}

function renderPythonRedaction(source) {
  const policyJson = JSON.stringify(source.redactionPolicy, null, 2);
  const schemaJson = JSON.stringify(source.redactionReportSchema, null, 2);
  return [
    '# Generated by tools/generate-platform-contracts.js. Do not edit.',
    '# P09 is an inert, deterministic egress-preparation service with no external I/O.',
    'from __future__ import annotations',
    '',
    'import math',
    'import json',
    'import re',
    'from typing import Any, Mapping',
    '',
    "POLICY: dict[str, Any] = json.loads(r'''" + policyJson + "''')",
    "REPORT_SCHEMA: dict[str, Any] = json.loads(r'''" + schemaJson + "''')",
    "EGRESS = frozenset(POLICY['egressKinds'])",
    "CUSTOM_FIELD = re.compile(POLICY['customization']['fieldNamePattern'])",
    '',
    "def _fail(path: str, message: str) -> None: raise ValueError(f'{path}: {message}')",
    "def _normalize_name(value: str) -> str: return re.sub(r'[-_.]', '', value.lower())",
    "def _safe_segment(key: str, index: int) -> str: return key if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,63}', key) else '<field-' + str(index) + '>'",
    "def _compile_rule(rule: Mapping[str, Any]): return re.compile(rule['pattern'], re.IGNORECASE if rule['caseInsensitive'] else 0)",
    "def _options(options: Mapping[str, Any] | None = None) -> dict[str, Any]:",
    "    raw = {} if options is None else options",
    "    if not isinstance(raw, Mapping): _fail('options', 'must be an object')",
    "    if any(key not in {'sensitiveValues', 'sensitiveFieldNames'} for key in raw): _fail('options', 'has an unknown field')",
    "    values = raw.get('sensitiveValues', [])",
    "    fields = raw.get('sensitiveFieldNames', [])",
    "    custom = POLICY['customization']",
    "    if not isinstance(values, list) or len(values) > custom['maximumValues'] or any(type(value) is not str or len(value) < custom['minimumValueLength'] or len(value) > custom['maximumValueLength'] or value in POLICY['replacement'] or POLICY['replacement'] in value for value in values) or len(set(values)) != len(values): _fail('sensitiveValues', 'must be bounded unique exact strings that cannot alter the replacement marker')",
    "    if not isinstance(fields, list) or len(fields) > custom['maximumFieldNames'] or any(type(value) is not str or CUSTOM_FIELD.fullmatch(value) is None for value in fields) or len({_normalize_name(value) for value in fields}) != len(fields): _fail('sensitiveFieldNames', 'must be bounded unique exact field names')",
    "    return {'values': sorted(values, key=lambda value: (-len(value), value)), 'fields': {_normalize_name(value) for value in fields}}",
    "def _field_rule(key: str, options: Mapping[str, Any]) -> Mapping[str, str] | None:",
    "    normalized = _normalize_name(key)",
    "    for rule in POLICY['fieldRules']:",
    "        if normalized in rule['names']: return rule",
    "    for rule in POLICY['suffixRules']:",
    "        if any(normalized.endswith(suffix) for suffix in rule['suffixes']): return rule",
    "    if normalized in options['fields']: return {'id': 'user-sensitive-field', 'category': 'user-sensitive'}",
    "    return None",
    "def _add_finding(findings: list[dict[str, Any]], path: str, detector_id: str, category: str, count: int) -> None:",
    "    if not count: return",
    "    for item in findings:",
    "        if item['path'] == path and item['detectorId'] == detector_id and item['category'] == category:",
    "            item['count'] += count",
    "            return",
    "    findings.append({'path': path, 'detectorId': detector_id, 'category': category, 'count': count})",
    "def _redact_text(value: str, path: str, findings: list[dict[str, Any]], options: Mapping[str, Any]) -> str:",
    "    output = value",
    "    for rule in POLICY['textRules']:",
    "        output, count = _compile_rule(rule).subn(POLICY['replacement'], output)",
    "        _add_finding(findings, path, rule['id'], rule['category'], count)",
    "    for sensitive in options['values']:",
    "        count = output.count(sensitive)",
    "        if count:",
    "            _add_finding(findings, path, 'user-sensitive-value', 'user-sensitive', count)",
    "            output = output.replace(sensitive, POLICY['replacement'])",
    "    while POLICY['replacement'] + POLICY['replacement'] in output:",
    "        output = output.replace(POLICY['replacement'] + POLICY['replacement'], POLICY['replacement'])",
    "    return output",
    "def scan_canaries(value: Any) -> dict[str, Any]:",
    "    canary = next(rule for rule in POLICY['textRules'] if rule['id'] == 'canary-text')",
    "    expression = _compile_rule(canary)",
    "    active: set[int] = set()",
    "    count = 0",
    "    def scan(item: Any, depth: int) -> None:",
    "        nonlocal count",
    "        if depth > POLICY['maxDepth']: _fail('value', 'exceeds redaction depth')",
    "        if item is None or type(item) is bool: return",
    "        if type(item) in (int, float):",
    "            if type(item) is float and not math.isfinite(item): _fail('value', 'requires finite JSON numbers')",
    "            return",
    "        if isinstance(item, str):",
    "            count += len(expression.findall(item))",
    "            return",
    "        if isinstance(item, list):",
    "            marker = id(item)",
    "            if marker in active: _fail('value', 'must be acyclic')",
    "            active.add(marker)",
    "            for child in item: scan(child, depth + 1)",
    "            active.remove(marker)",
    "            return",
    "        if not isinstance(item, Mapping): _fail('value', 'requires JSON-compatible values')",
    "        marker = id(item)",
    "        if marker in active: _fail('value', 'must be acyclic')",
    "        active.add(marker)",
    "        for key, child in item.items():",
    "            if type(key) is not str: _fail('value', 'requires string object keys')",
    "            count += len(expression.findall(key))",
    "            scan(child, depth + 1)",
    "        active.remove(marker)",
    "    scan(value, 0)",
    "    return {'detected': count > 0, 'count': count}",
    "def redact_structured(value: Any, options: Mapping[str, Any] | None = None) -> dict[str, Any]:",
    "    checked_options = _options(options)",
    "    findings: list[dict[str, Any]] = []",
    "    active: set[int] = set()",
    "    def visit(item: Any, path: str, depth: int) -> Any:",
    "        if depth > POLICY['maxDepth']: _fail(path, 'exceeds redaction depth')",
    "        if item is None or type(item) is bool: return item",
    "        if type(item) in (int, float):",
    "            if type(item) is float and not math.isfinite(item): _fail(path, 'requires finite JSON numbers')",
    "            return item",
    "        if isinstance(item, str): return _redact_text(item, path, findings, checked_options)",
    "        if isinstance(item, list):",
    "            marker = id(item)",
    "            if marker in active: _fail(path, 'must be acyclic')",
    "            active.add(marker)",
    "            output = [visit(child, path + '[' + str(index) + ']', depth + 1) for index, child in enumerate(item)]",
    "            active.remove(marker)",
    "            return output",
    "        if not isinstance(item, Mapping): _fail(path, 'requires JSON-compatible values')",
    "        marker = id(item)",
    "        if marker in active: _fail(path, 'must be acyclic')",
    "        active.add(marker)",
    "        output: dict[str, Any] = {}",
    "        for index, (key, child) in enumerate(item.items()):",
    "            if type(key) is not str: _fail(path, 'requires string object keys')",
    "            key_findings: list[dict[str, Any]] = []",
    "            redacted_key = _redact_text(key, path + '.<key>', key_findings, checked_options)",
    "            segment = _safe_segment(key, index) if redacted_key == key else '<redacted-key-' + str(index) + '>'",
    "            output_key = key if redacted_key == key else 'redactedField' + str(index)",
    "            while output_key in output: output_key += '_'",
    "            findings.extend(key_findings)",
    "            rule = _field_rule(key, checked_options)",
    "            if rule is not None and child != POLICY['replacement']:",
    "                output[output_key] = POLICY['replacement']",
    "                _add_finding(findings, path + '.' + segment, rule['id'], rule['category'], 1)",
    "            else:",
    "                output[output_key] = visit(child, path + '.' + segment, depth + 1)",
    "        active.remove(marker)",
    "        return output",
    "    canaries = scan_canaries(value)",
    "    output = visit(value, '$', 0)",
    "    findings.sort(key=lambda item: (item['path'], item['detectorId'], item['category']))",
    "    return {'value': output, 'findings': findings, 'canaryDetected': canaries['detected'], 'canaryCount': canaries['count'], 'changed': bool(findings)}",
    "def validate_report(report: Mapping[str, Any]) -> Mapping[str, Any]:",
    "    required = {'schemaVersion','serviceId','egress','applied','changed','canaryDetected','canaryCount','findingCount','findings'}",
    "    if not isinstance(report, Mapping) or set(report) != required or report['schemaVersion'] != POLICY['policyVersion'] or report['serviceId'] != POLICY['serviceId'] or report['egress'] not in EGRESS or report['applied'] is not True or type(report['changed']) is not bool or type(report['canaryDetected']) is not bool or type(report['canaryCount']) is not int or report['canaryCount'] < 0 or type(report['findingCount']) is not int or report['findingCount'] < 0 or not isinstance(report['findings'], list): _fail('redactionReport', 'is invalid')",
    "    categories = set(REPORT_SCHEMA['properties']['findings']['items']['properties']['category']['enum'])",
    "    total = 0",
    "    prior: tuple[str, str, str] | None = None",
    "    for item in report['findings']:",
    "        if not isinstance(item, Mapping) or set(item) != {'path','detectorId','category','count'} or type(item['path']) is not str or not 1 <= len(item['path']) <= 512 or type(item['detectorId']) is not str or re.fullmatch(r'[a-z][a-z0-9-]{0,63}', item['detectorId']) is None or item['category'] not in categories or type(item['count']) is not int or item['count'] < 1: _fail('redactionReport.findings', 'is invalid')",
    "        key = (item['path'], item['detectorId'], item['category'])",
    "        if prior is not None and prior >= key: _fail('redactionReport.findings', 'must be canonical and unique')",
    "        prior = key",
    "        total += item['count']",
    "    if report['findingCount'] != total or report['changed'] != (total > 0) or report['canaryDetected'] != (report['canaryCount'] > 0): _fail('redactionReport', 'counts are inconsistent')",
    "    return report",
    "def prepare_egress(egress: str, payload: Any, options: Mapping[str, Any] | None = None) -> dict[str, Any]:",
    "    if egress not in EGRESS: _fail('egress', 'unknown egress kind')",
    "    redacted = redact_structured(payload, options)",
    "    finding_count = sum(item['count'] for item in redacted['findings'])",
    "    report = {'schemaVersion': POLICY['policyVersion'], 'serviceId': POLICY['serviceId'], 'egress': egress, 'applied': True, 'changed': redacted['changed'], 'canaryDetected': redacted['canaryDetected'], 'canaryCount': redacted['canaryCount'], 'findingCount': finding_count, 'findings': redacted['findings']}",
    "    validate_report(report)",
    "    return {'payload': redacted['value'], 'redactionReport': report}",
    "def verify_prepared_egress(envelope: Mapping[str, Any], expected_egress: str, options: Mapping[str, Any] | None = None) -> Mapping[str, Any]:",
    "    if not isinstance(envelope, Mapping) or set(envelope) != {'payload', 'redactionReport'}: _fail('preparedEgress', 'missing redaction pass envelope')",
    "    report = validate_report(envelope['redactionReport'])",
    "    if report['egress'] != expected_egress: _fail('preparedEgress', 'egress mismatch')",
    "    residual = redact_structured(envelope['payload'], options)",
    "    if residual['canaryDetected'] or residual['changed']: _fail('preparedEgress', 'residual sensitive material detected')",
    "    return envelope",
    "def assert_no_canaries(value: Any) -> Any:",
    "    if scan_canaries(value)['detected']: _fail('canary', 'secret canary detected')",
    "    return value",
    '',
    "__all__ = ['POLICY', 'REPORT_SCHEMA', 'assert_no_canaries', 'prepare_egress', 'redact_structured', 'scan_canaries', 'validate_report', 'verify_prepared_egress']",
    ''
  ].join('\n');
}

function renderPython(source) {
  const packageJson = JSON.stringify(source, null, 2);
  const classes = source.manifest.schemas.map(item => 'class ' + className(item.name) + "(ContractModel):\n    CONTRACT_NAME = '" + item.name + "'\n").join('\n');
  const exported = ['validate_contract', 'canonical_string', 'canonical_bytes', 'ContractModel']
    .concat(source.manifest.schemas.map(item => className(item.name))).map(value => "'" + value + "'").join(', ');
  return [
    '# Generated by tools/generate-platform-contracts.js. Do not edit.',
    'from __future__ import annotations',
    '',
    'import json',
    'import math',
    'import re',
    'from dataclasses import dataclass',
    'from typing import Any, ClassVar, Mapping',
    '',
    "PACKAGE: dict[str, Any] = json.loads(r'''" + packageJson + "''')",
    "SCHEMA_VERSION = '" + source.manifest.schemaVersion + "'",
    'SAFE_MAX = 9007199254740991',
    '',
    "def _fail(p: str, m: str) -> None: raise ValueError(f'{p}: {m}')",
    'def _same(a: Any, b: Any) -> bool: return type(a) is type(b) and a == b',
    'def _dynamic(v: Any, p: str) -> None:',
    '    if v is None or type(v) is bool or isinstance(v, str): return',
    '    if type(v) is int:',
    "        if abs(v) > SAFE_MAX: _fail(p, 'dynamic JSON requires a safe integer')",
    '        return',
    '    if type(v) is float:',
    "        if not math.isfinite(v) or not v.is_integer() or abs(v) > SAFE_MAX: _fail(p, 'dynamic JSON requires a safe integer')",
    '        return',
    "    if isinstance(v, list):",
    "        for i, x in enumerate(v): _dynamic(x, p + '[' + str(i) + ']')",
    '        return',
    "    if not isinstance(v, dict): _fail(p, 'dynamic JSON requires JSON values')",
    '    for k, x in v.items():',
    "        if not isinstance(k, str) or any(ord(c) < 32 or ord(c) > 126 for c in k): _fail(p, 'dynamic JSON requires ASCII object keys')",
    "        _dynamic(x, p + '.' + k)",
    'def _validate(s: Mapping[str, Any], v: Any, p: str) -> None:',
    "    if 'const' in s and not _same(v, s['const']): _fail(p, 'must equal const')",
    "    if 'enum' in s and not any(_same(v, x) for x in s['enum']): _fail(p, 'must be an allowed enum value')",
    "    t = s.get('type')",
    '    if not t: return',
    "    if t == 'object':",
    "        if not isinstance(v, dict): _fail(p, 'must be an object')",
    "        props = s.get('properties', {})",
    "        for k in s.get('required', []):",
    "            if k not in v: _fail(p, 'missing required ' + k)",
    "        if s.get('additionalProperties') is False:",
    "            for k in v:",
    "                if k not in props: _fail(p, 'unknown property ' + k)",
    "        if s.get('additionalProperties') is True:",
    "            for k in v:",
    "                if k not in props: _dynamic(v[k], p + '.' + k)",
    '        for k, child in props.items():',
    "            if k in v: _validate(child, v[k], p + '.' + k)",
    '        return',
    "    if t == 'array':",
    "        if not isinstance(v, list): _fail(p, 'must be an array')",
    "        if len(v) < s.get('minItems', 0): _fail(p, 'has too few items')",
    "        for i, x in enumerate(v): _validate(s.get('items', {}), x, p + '[' + str(i) + ']')",
    '        return',
    "    if t == 'string':",
    "        if not isinstance(v, str): _fail(p, 'must be a string')",
    "        if len(v) < s.get('minLength', 0): _fail(p, 'is too short')",
    "        if 'maxLength' in s and len(v) > s['maxLength']: _fail(p, 'is too long')",
    "        if 'pattern' in s and not re.fullmatch(s['pattern'], v): _fail(p, 'does not match pattern')",
    '        return',
    "    if t == 'boolean':",
    "        if type(v) is not bool: _fail(p, 'must be boolean')",
    '        return',
    "    if t == 'integer':",
    "        if type(v) is not int or abs(v) > SAFE_MAX: _fail(p, 'must be a finite safe integer')",
    "        if 'minimum' in s and v < s['minimum']: _fail(p, 'is below minimum')",
    "        if 'maximum' in s and v > s['maximum']: _fail(p, 'is above maximum')",
    '        return',
    "    _fail(p, 'uses unsupported type ' + str(t))",
    '',
    'def validate_contract(name: str, value: Any) -> dict[str, Any]:',
    "    schema = PACKAGE['schemas'].get(name)",
    "    if schema is None: _fail(name, 'unknown contract')",
    '    _validate(schema, value, name)',
    '    return value',
    '',
    "def _normalize(v: Any, p: str = '$') -> Any:",
    '    if v is None or type(v) is bool or isinstance(v, str): return v',
    '    if type(v) is int:',
    "        if abs(v) > SAFE_MAX: _fail(p, 'canonical form requires a safe integer')",
    '        return v',
    '    if type(v) is float:',
    "        if not math.isfinite(v) or not v.is_integer() or abs(v) > SAFE_MAX: _fail(p, 'canonical form requires a safe integer')",
    '        return int(v)',
    "    if isinstance(v, list): return [_normalize(x, p + '[' + str(i) + ']') for i, x in enumerate(v)]",
    "    if not isinstance(v, dict): _fail(p, 'canonical form requires JSON values')",
    '    out: dict[str, Any] = {}',
    '    for k in sorted(v):',
    "        if not isinstance(k, str) or any(ord(c) < 32 or ord(c) > 126 for c in k): _fail(p, 'canonical form requires ASCII object keys')",
    "        out[k] = _normalize(v[k], p + '.' + k)",
    '    return out',
    '',
    "def canonical_string(v: Any) -> str: return json.dumps(_normalize(v), ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False)",
    "def canonical_bytes(v: Any) -> bytes: return canonical_string(v).encode('ascii')",
    '',
    '@dataclass(frozen=True)',
    'class ContractModel:',
    '    data: Mapping[str, Any]',
    "    CONTRACT_NAME: ClassVar[str] = ''",
    '    @classmethod',
    "    def from_dict(cls, value: Mapping[str, Any]) -> 'ContractModel':",
    '        validate_contract(cls.CONTRACT_NAME, dict(value))',
    '        return cls(dict(value))',
    '    def to_dict(self) -> dict[str, Any]: return json.loads(canonical_string(dict(self.data)))',
    '    def canonical_bytes(self) -> bytes:',
    '        validate_contract(self.CONTRACT_NAME, dict(self.data))',
    '        return canonical_bytes(dict(self.data))',
    '',
    classes,
    '__all__ = [' + exported + ']',
    ''
  ].join('\n');
}

function renderAll(source = loadPackage()) {
  return new Map([
    [OUTPUTS.types, renderTypes(source)],
    [OUTPUTS.javascriptValidator, renderJavaScriptValidator(source)],
    [OUTPUTS.typescriptValidator, renderTypeScriptValidator()],
    [OUTPUTS.javascriptIdentity, renderJavaScriptIdentity(source)],
    [OUTPUTS.typescriptIdentity, renderTypeScriptIdentity()],
    [OUTPUTS.javascriptProvenance, renderJavaScriptProvenance(source)],
    [OUTPUTS.typescriptProvenance, renderTypeScriptProvenance()],
    [OUTPUTS.javascriptRedaction, renderJavaScriptRedaction(source)],
    [OUTPUTS.typescriptRedaction, renderTypeScriptRedaction()],
    [OUTPUTS.toolsEnabledPython, renderPython(source)],
    [OUTPUTS.toolsEnabledPythonIdentity, renderPythonIdentity(source)],
    [OUTPUTS.toolsEnabledPythonProvenance, renderPythonProvenance(source)],
    [OUTPUTS.toolsEnabledPythonRedaction, renderPythonRedaction(source)],
    [OUTPUTS.artifact, renderArtifact(source)],
    [OUTPUTS.identityArtifact, renderIdentityArtifact(source)],
    [OUTPUTS.provenanceArtifact, renderProvenanceArtifact(source)],
    [OUTPUTS.redactionArtifact, renderRedactionArtifact(source)],
    ...evidenceStoreGenerator.renderAll()
  ]);
}

function assertRepositoryOutput(target) {
  const relative = path.relative(ROOT, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Generated output must stay inside the ToolsEnabled repository: ' + target);
  }
}

function generate({ check = false } = {}) {
  const outputs = renderAll();
  for (const [target, content] of outputs) {
    assertRepositoryOutput(target);
    if (check) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
        throw new Error('Generated Coordinator platform contract is stale: ' + path.relative(ROOT, target));
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  }
  return outputs;
}

if (require.main === module) {
  generate({ check: process.argv.includes('--check') });
  process.stdout.write('Coordinator platform contracts ' + (process.argv.includes('--check') ? 'verified' : 'generated') + '.\n');
}

module.exports = {
  IDENTITY_POLICY_PATH, IDENTITY_VECTORS_PATH, MANIFEST_PATH, OUTPUTS, PACKAGE_ROOT, PROVENANCE_POLICY_PATH,
  PROVENANCE_SCHEMA_PATH, PROVENANCE_VECTORS_PATH, REDACTION_POLICY_PATH, REDACTION_REPORT_SCHEMA_PATH,
  REDACTION_VECTORS_PATH, REQUIRED_NAMES, assertAdditiveCompatible, generate,
  identityCanonicalString, identityHash, loadPackage, provenanceCanonicalEnvelope, provenanceOperationVector,
  renderAll, validateIdentityPolicy, validateIdentityVectors, validatePackage, validatePortableSchema,
  validateProvenancePackage, validateRedactionPackage
};
