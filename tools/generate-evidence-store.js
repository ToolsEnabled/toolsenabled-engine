'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_ROOT = path.join(ROOT, 'schemas', 'platform');
const POLICY_PATH = path.join(PACKAGE_ROOT, 'evidence-store-policy.json');
const RECORD_SCHEMA_PATH = path.join(PACKAGE_ROOT, 'evidence-store-record.schema.json');
const PROVENANCE_POLICY_PATH = path.join(PACKAGE_ROOT, 'provenance-policy.json');
const REDACTION_POLICY_PATH = path.join(PACKAGE_ROOT, 'redaction-policy.json');
const REDACTION_REPORT_SCHEMA_PATH = path.join(PACKAGE_ROOT, 'redaction-report.schema.json');
const TEMPLATE_PATH = path.join(ROOT, 'tools', 'templates', 'coordinator_platform_evidence.py');
const OUTPUTS = Object.freeze({
  toolsEnabledPythonEvidence: path.join(ROOT, 'schemas', 'generated', 'coordinator_platform_evidence.py'),
  evidenceStoreArtifact: path.join(ROOT, 'artifacts', 'coordinator-platform-evidence-store-1.0.0.json')
});

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validate(policy, schema, provenancePolicy, redactionPolicy, redactionReportSchema) {
  if (!policy || policy.policyVersion !== '1.0.0' || policy.policyAuthority !== 'toolsenabled' ||
      policy.serviceId !== 'coordinator-platform-evidence-store-v1') {
    throw new Error('P10 evidence-store policy identity is invalid');
  }
  if (policy.database?.schemaVersion !== 1 ||
      policy.database.applicationId !== Buffer.from(policy.database.applicationIdAscii, 'ascii').readUInt32BE(0) ||
      policy.database.applicationIdAscii !== 'TEEV' ||
      !/^[a-f0-9]{64}$/.test(policy.database.schemaFingerprint || '') ||
      policy.database.journalMode !== 'wal' || policy.database.synchronous !== 'full') {
    throw new Error('P10 evidence-store database identity is invalid');
  }
  if (policy.storage?.hashAlgorithm !== 'sha256' || policy.storage.hashMeaning !== 'raw stored bytes' ||
      policy.storage.bodiesInDatabase !== false ||
      policy.storage.objectPath !== 'objects/sha256/<first-two-hex>/<next-two-hex>/<sha256>.blob') {
    throw new Error('P10 content-addressed object layout is invalid');
  }
  if (policy.recordHash?.domain !== 'coordinator:evidence-record' ||
      policy.tombstoneHash?.domain !== 'coordinator:evidence-tombstone' ||
      policy.tombstoneHash.appendOnly !== true) {
    throw new Error('P10 metadata hash domains are invalid');
  }
  if (policy.authorization?.defaultWithoutAuthorizer !== 'deny' ||
      policy.authorization.exactMatchRequired !== true ||
      policy.authorization.lexicalIdValidationGrantsAuthority !== false) {
    throw new Error('P10 authorization policy must fail closed');
  }
  if (!Number.isSafeInteger(policy.maintenance?.orphanGraceMs) ||
      policy.maintenance.orphanGraceMs < 60_000 ||
      !Number.isSafeInteger(policy.maintenance.maximumSweepFiles) ||
      policy.maintenance.maximumSweepFiles < 1 ||
      policy.maintenance.automaticStartupSweep !== false) {
    throw new Error('P10 bounded orphan-maintenance policy is invalid');
  }
  if (policy.publicExport?.egress !== 'evidence-export' ||
      policy.publicExport.preparedEnvelopeRequired !== true ||
      policy.publicExport.protectedBytesReturned !== false ||
      policy.publicExport.protectedDescriptorReturnedPublic !== false ||
      policy.publicExport.writerReceiptReturnsEvidenceReference !== true) {
    throw new Error('P10 public export must preserve the P09 gate');
  }
  if (policy.activation?.runtimeRouteEnabled !== false ||
      policy.activation.mcpToolEnabled !== false ||
      policy.activation.providerEnabled !== false) {
    throw new Error('P10 must remain default-off and unregistered');
  }
  const classes = policy.retention?.classes || {};
  if (policy.retention.defaultClass !== 'standard' ||
      Object.keys(classes).sort().join(',') !== 'durable,standard,transient' ||
      classes.durable.maxAgeMs !== null ||
      !Number.isSafeInteger(classes.standard.maxAgeMs) ||
      !Number.isSafeInteger(classes.transient.maxAgeMs)) {
    throw new Error('P10 retention classes are invalid');
  }
  if (JSON.stringify(policy.retention.deletion.reasonCodes) !==
      JSON.stringify(['retention', 'user-request', 'corrupt', 'superseded'])) {
    throw new Error('P10 tombstone reasons are invalid');
  }
  if (provenancePolicy?.policyVersion !== policy.policyVersion ||
      provenancePolicy.policyAuthority !== 'toolsenabled' ||
      !Array.isArray(provenancePolicy.labels) ||
      redactionPolicy?.policyVersion !== policy.policyVersion ||
      redactionPolicy.policyAuthority !== 'toolsenabled' ||
      redactionPolicy.serviceId !== 'coordinator-platform-redaction-v1' ||
      redactionReportSchema?.$id !== `urn:coordinator:platform:redaction-report:${policy.policyVersion}`) {
    throw new Error('P10 generated verifier prerequisites are invalid');
  }
  if (!schema || schema.$id !== `urn:coordinator:platform:evidence-store-record:${policy.policyVersion}` ||
      schema.type !== 'object' || schema.additionalProperties !== false ||
      schema.properties?.schemaVersion?.const !== policy.policyVersion ||
      schema.properties?.provenance?.$ref !== `urn:coordinator:platform:provenance:${policy.policyVersion}` ||
      schema.properties?.redactionReport?.$ref !== `urn:coordinator:platform:redaction-report:${policy.policyVersion}` ||
      !Array.isArray(schema.required) || schema.required.length !== Object.keys(schema.properties || {}).length) {
    throw new Error('P10 evidence-store record schema is invalid');
  }
  const required = [
    'schemaVersion', 'evidenceId', 'taskId', 'scopeId', 'toolRequestId', 'kind',
    'mediaType', 'summary', 'protectedContent', 'publicContent', 'provenance',
    'sourceVersion', 'locator', 'redactionReport', 'retentionClass', 'expiresAt',
    'createdAt', 'recordHash'
  ];
  if (required.some(field => !schema.required.includes(field)) ||
      JSON.stringify(schema.properties.kind.enum) !== JSON.stringify(policy.recordKinds) ||
      JSON.stringify(schema.properties.locator.properties.kind.enum) !== JSON.stringify(policy.locatorKinds) ||
      schema.properties.summary.maxLength !== policy.limits.summaryCharacters ||
      schema.properties.sourceVersion.maxLength !== policy.limits.sourceVersionCharacters ||
      schema.properties.sourceVersion.pattern !== '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$' ||
      schema.properties.locator.properties.value.maxLength !== policy.limits.locatorValueCharacters ||
      schema.properties.publicContent.properties.sizeBytes.maximum !== policy.limits.publicObjectBytes ||
      schema.properties.protectedContent.properties.sizeBytes.maximum !== policy.limits.protectedObjectBytes) {
    throw new Error('P10 evidence-store record fields diverge from policy');
  }
  return { policy, schema, provenancePolicy, redactionPolicy, redactionReportSchema };
}

function loadPackage() {
  return validate(
    readJson(POLICY_PATH),
    readJson(RECORD_SCHEMA_PATH),
    readJson(PROVENANCE_POLICY_PATH),
    readJson(REDACTION_POLICY_PATH),
    readJson(REDACTION_REPORT_SCHEMA_PATH)
  );
}

function pythonJsonLoad(value) {
  const canonicalJson = JSON.stringify(value);
  return `json.loads(${JSON.stringify(canonicalJson)})`;
}

function renderPython(source = loadPackage()) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const rendered = template
    .replace('__POLICY_JSON__', pythonJsonLoad(source.policy))
    .replace('__SCHEMA_JSON__', pythonJsonLoad(source.schema))
    .replace('__PROVENANCE_POLICY_JSON__', pythonJsonLoad(source.provenancePolicy))
    .replace('__REDACTION_POLICY_JSON__', pythonJsonLoad(source.redactionPolicy))
    .replace('__REDACTION_REPORT_SCHEMA_JSON__', pythonJsonLoad(source.redactionReportSchema));
  if (/__[A-Z_]+_JSON__/.test(rendered)) {
    throw new Error('P10 Python template markers were not fully rendered');
  }
  return `# Generated by tools/generate-evidence-store.js. Do not edit.\n${rendered}`;
}

function renderArtifact(source = loadPackage(), python = renderPython(source)) {
  const artifact = {
    package: 'coordinator-platform-evidence-store',
    policyVersion: source.policy.policyVersion,
    policyAuthority: source.policy.policyAuthority,
    serviceId: source.policy.serviceId,
    databaseSchemaVersion: source.policy.database.schemaVersion,
    applicationId: source.policy.database.applicationId,
    schemaFingerprint: source.policy.database.schemaFingerprint,
    objectPath: source.policy.storage.objectPath,
    contentHash: source.policy.storage.hashMeaning,
    recordHashDomain: source.policy.recordHash.domain,
    tombstoneHashDomain: source.policy.tombstoneHash.domain,
    retentionClasses: source.policy.retention.classes,
    runtimeRouteEnabled: source.policy.activation.runtimeRouteEnabled,
    policySha256: sha256(JSON.stringify(source.policy)),
    recordSchemaSha256: sha256(JSON.stringify(source.schema)),
    provenancePolicySha256: sha256(JSON.stringify(source.provenancePolicy)),
    redactionPolicySha256: sha256(JSON.stringify(source.redactionPolicy)),
    redactionReportSchemaSha256: sha256(JSON.stringify(source.redactionReportSchema)),
    pythonVerifierSha256: sha256(python)
  };
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function renderAll(source = loadPackage()) {
  const python = renderPython(source);
  return new Map([
    [OUTPUTS.toolsEnabledPythonEvidence, python],
    [OUTPUTS.evidenceStoreArtifact, renderArtifact(source, python)]
  ]);
}

function assertRepositoryOutput(target) {
  const relative = path.relative(ROOT, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Generated output must stay inside the ToolsEnabled repository: ${target}`);
  }
}

function generate({ check = false } = {}) {
  const outputs = renderAll();
  for (const [target, content] of outputs) {
    assertRepositoryOutput(target);
    if (check) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
        throw new Error(`Generated P10 evidence-store contract is stale: ${path.relative(ROOT, target)}`);
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  }
  return outputs;
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  generate({ check });
  process.stdout.write(`Coordinator evidence-store contracts ${check ? 'verified' : 'generated'}.\n`);
}

module.exports = {
  OUTPUTS,
  PACKAGE_ROOT,
  POLICY_PATH,
  PROVENANCE_POLICY_PATH,
  REDACTION_POLICY_PATH,
  REDACTION_REPORT_SCHEMA_PATH,
  RECORD_SCHEMA_PATH,
  TEMPLATE_PATH,
  generate,
  loadPackage,
  renderAll,
  renderArtifact,
  renderPython,
  validate
};
