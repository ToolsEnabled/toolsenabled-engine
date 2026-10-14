'use strict';

// Deterministic Phase 2 generator.  Schemas are the wire authority; generated
// consumers are copied only to the isolated Agent Activity Visualizer tree.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VISUALIZER_ROOT = path.resolve(ROOT, '..', 'AgentActivityVisualizer');
const PACKAGE_ROOT = path.join(ROOT, 'schemas', 'agent-activity', '1.0.0');
const LEDGER_PATH = path.join(ROOT, 'schemas', 'master-work-ledger', '2.0.0', 'schema.json');
const MANIFEST_PATH = path.join(PACKAGE_ROOT, 'manifest.json');
const OWNERSHIP_PATH = path.join(ROOT, 'schemas', 'ownership-map.json');
const IDENTITY_POLICY_PATH = path.join(ROOT, 'schemas', 'platform', 'identifier-policy.json');
const PROVENANCE_POLICY_PATH = path.join(ROOT, 'schemas', 'platform', 'provenance-policy.json');
const REDACTION_POLICY_PATH = path.join(ROOT, 'schemas', 'platform', 'redaction-policy.json');
const TEMPLATE_ROOT = path.join(ROOT, 'tools', 'templates');
const REQUIRED_CONTRACTS = Object.freeze([
  'common', 'agent', 'goal', 'request', 'phase', 'task', 'evidence', 'report',
  'edge', 'event', 'browser-event', 'snapshot', 'history', 'report-render-manifest'
]);
const OUTPUTS = Object.freeze({
  javascript: path.join(VISUALIZER_ROOT, 'src', 'generated', 'agent-activity-contracts.js'),
  typescript: path.join(VISUALIZER_ROOT, 'src', 'generated', 'agent-activity-contracts.d.ts'),
  python: path.join(VISUALIZER_ROOT, 'src', 'generated', 'agent_activity_contracts.py')
});

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
    return result;
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value), null, 2);
}

function assert(condition, message) {
  if (!condition) throw new Error('Agent Activity contract package: ' + message);
}

function validatePortableSchema(schema, label) {
  if (!schema || typeof schema !== 'object') return;
  if (typeof schema.pattern === 'string') {
    assert(schema.pattern.length <= 512 && /^[\x20-\x7e]*$/.test(schema.pattern), label + ' has a non-ASCII or oversized pattern');
    assert(!/(\(\?|\\[pPk])/.test(schema.pattern), label + ' has a non-portable pattern');
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' || key === 'pattern') continue;
    if (Array.isArray(value)) value.forEach((item, index) => validatePortableSchema(item, label + '.' + key + '[' + index + ']'));
    else if (value && typeof value === 'object') validatePortableSchema(value, label + '.' + key);
  }
}

function expectedId(schema, name, version) {
  return 'urn:toolsenabled:agent-activity:' + name + ':' + version;
}

function validatePolicyInputs(identity, provenance, redaction) {
  assert(identity.policyAuthority === 'toolsenabled', 'P07 identifier policy owner changed');
  assert(identity.idEncoding?.alphabet === 'base64url' && identity.idEncoding?.randomBytes === 24 &&
    identity.idEncoding?.encodedCharacters === 32 && identity.idEncoding?.randomnessBits === 192,
  'P07 identifier policy must keep 192-bit base64url IDs');
  assert(identity.controlTimestamp?.format === 'YYYY-MM-DDTHH:mm:ss.sssZ' &&
    identity.controlTimestamp?.timezone === 'UTC' && identity.controlTimestamp?.precision === 'milliseconds',
  'P07 control timestamp policy changed');
  assert(identity.canonicalHash?.algorithm === 'sha256' && identity.canonicalHash?.frameVersion === 'coordinator-platform-hash-v1' &&
    identity.canonicalHash?.domainPattern === '^[a-z][a-z0-9:._-]{0,127}$',
  'P07 domain-hash policy changed');
  assert(identity.authorization?.visiblePrefixGrantsAuthority === false && identity.authorization?.idValidationIsLexicalOnly === true,
    'P07 visible ID authority policy changed');

  assert(provenance.policyAuthority === 'toolsenabled' &&
    JSON.stringify(provenance.safeDisplay?.fields) === JSON.stringify(['labels', 'sourceCount', 'containsSecret']) &&
    provenance.safeDisplay?.includeSourceIdentifiers === false && provenance.safeDisplay?.includeContent === false,
  'P08 safe-display policy changed');
  assert(provenance.authorization?.provenanceAllowsAction === false && provenance.authorization?.sinkAllowIsNecessaryButNotSufficient === true,
    'P08 authorization policy changed');

  assert(redaction.policyAuthority === 'toolsenabled' && redaction.replacement === '[REDACTED]' &&
    Array.isArray(redaction.egressKinds) && redaction.egressKinds.includes('provider') && redaction.egressKinds.includes('evidence-export'),
  'P09 redaction policy changed');
}

function validatePackage(manifest, schemas, ledger, ownership, identity, provenance, redaction) {
  assert(manifest.package === 'agent-activity' && manifest.schemaAuthority === 'toolsenabled' && manifest.schemaVersion === '1.0.0',
    'manifest must name the ToolsEnabled-owned v1 package');
  assert(manifest.ownershipDomain === 'context', 'P04 ownership domain must be context');
  assert((ownership.owners || []).some(item => item.domain === 'context' && item.owner === 'toolsenabled'),
    'P04 ownership map no longer assigns context to ToolsEnabled');
  const names = (manifest.contracts || []).map(item => item.name);
  assert(names.length === REQUIRED_CONTRACTS.length && new Set(names).size === names.length &&
    REQUIRED_CONTRACTS.every(name => names.includes(name)), 'manifest contract list is incomplete');
  assert(JSON.stringify(manifest.browserSafeInvariants) === JSON.stringify({
    contentTrust: 'untrusted', grantsAuthority: false,
    safeDisplayFields: ['labels', 'sourceCount', 'containsSecret'], freeText: false,
    opaqueIds: false, hashes: false, paths: false
  }), 'browser-safe invariants changed');

  for (const item of manifest.contracts) {
    const schema = schemas[item.name];
    assert(schema && schema.type === 'object' && schema.additionalProperties === false,
      item.name + ' must be a closed object schema');
    assert(schema.$id === expectedId(schema, item.name, manifest.schemaVersion), item.name + ' has an unexpected schema ID');
    validatePortableSchema(schema, item.name);
  }
  const enumAt = (schema, pathParts) => pathParts.reduce((value, key) => value?.[key], schema);
  assert(JSON.stringify(enumAt(schemas.edge, ['properties', 'edgeType', 'enum'])) === JSON.stringify([
    'delegated_to', 'communicated_with', 'assigned_to', 'works_on', 'depends_on', 'blocked_by', 'supports_gate', 'reviewed_by'
  ]), 'edge vocabulary changed');
  assert(JSON.stringify(enumAt(schemas.event, ['properties', 'eventType', 'enum'])) === JSON.stringify([
    'agent_state', 'delegation_state', 'phase_state', 'checkpoint_observed', 'help_state', 'acceptance_state', 'report_state', 'source_state'
  ]), 'event vocabulary changed');
  for (const name of ['browser-event', 'snapshot', 'history']) {
    const serialized = JSON.stringify(schemas[name]);
    for (const forbidden of ['agentId', 'goalId', 'requestId', 'phaseId', 'taskId', 'evidenceId', 'reportId', 'eventId', 'edgeId', 'hash', 'path', 'Hash', 'Path', 'objective', 'prompt', 'mission', 'toolResult', 'helpText']) {
      assert(!serialized.includes(forbidden), name + ' exposes browser-forbidden field ' + forbidden);
    }
    assert(!/\bmac\b/i.test(serialized), name + ' must not project an abandoned lane entity');
  }
  assert(ledger.$id === 'urn:toolsenabled:master-work-ledger:2.0.0' && ledger.type === 'object' && ledger.additionalProperties === false,
    'ledger v2 must be a closed schema');
  assert(ledger.properties?.intentAuthority?.const === 'json-ledger' &&
    ledger.properties?.runtimeAssignmentAuthority?.const === 'toolsenabled',
  'ledger authority fields changed');
  assert(JSON.stringify(ledger.$defs?.masterLink?.required) === JSON.stringify([
    'missionId', 'observedLedgerRevision', 'requestId', 'phaseId', 'gateIds'
  ]), 'ledger masterLink is incomplete');
  assert(!/"runtimeAssignment"\s*:/.test(JSON.stringify(ledger)), 'ledger must not contain runtime assignment');
  validatePortableSchema(ledger, 'master-work-ledger');
  validatePolicyInputs(identity, provenance, redaction);
}

function loadPackage() {
  const manifest = readJson(MANIFEST_PATH);
  const schemas = {};
  for (const item of manifest.contracts || []) schemas[item.name] = readJson(path.join(PACKAGE_ROOT, item.file));
  const ledger = readJson(LEDGER_PATH);
  schemas['master-work-ledger'] = ledger;
  const ownership = readJson(OWNERSHIP_PATH);
  const identity = readJson(IDENTITY_POLICY_PATH);
  const provenance = readJson(PROVENANCE_POLICY_PATH);
  const redaction = readJson(REDACTION_POLICY_PATH);
  validatePackage(manifest, schemas, ledger, ownership, identity, provenance, redaction);
  return { manifest, schemas, ledger, ownership, identity, provenance, redaction };
}

function renderTemplate(filename, replacements) {
  let output = fs.readFileSync(path.join(TEMPLATE_ROOT, filename), 'utf8');
  for (const [marker, value] of Object.entries(replacements)) output = output.replaceAll(marker, value);
  assert(!/__[A-Z0-9_]+__/.test(output), filename + ' has an unresolved generator marker');
  return output;
}

function renderAll(source = loadPackage()) {
  const catalog = stableJson({ manifest: source.manifest, schemas: source.schemas });
  return new Map([
    [OUTPUTS.javascript, renderTemplate('agent_activity_contracts.js.tpl', { '__CATALOG_JSON__': catalog })],
    [OUTPUTS.typescript, renderTemplate('agent_activity_contracts.d.ts.tpl', { '__SCHEMA_VERSION__': source.manifest.schemaVersion })],
    [OUTPUTS.python, renderTemplate('agent_activity_contracts.py.tpl', { '__CATALOG_JSON__': catalog })]
  ]);
}

function generate({ check = false } = {}) {
  const outputs = renderAll();
  for (const [target, content] of outputs) {
    if (check) {
      assert(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content,
        'generated consumer is stale: ' + path.relative(ROOT, target));
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  }
  return outputs;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  assert(args.length <= 1 && (args.length === 0 || args[0] === '--check'), 'only --check is supported');
  generate({ check: args.includes('--check') });
  process.stdout.write('Agent Activity contracts ' + (args.includes('--check') ? 'verified' : 'generated') + '.\n');
}

module.exports = {
  IDENTITY_POLICY_PATH, LEDGER_PATH, MANIFEST_PATH, OUTPUTS, PACKAGE_ROOT, PROVENANCE_POLICY_PATH,
  REDACTION_POLICY_PATH, REQUIRED_CONTRACTS, VISUALIZER_ROOT, generate, loadPackage, renderAll,
  stableJson, validatePackage, validatePortableSchema
};
