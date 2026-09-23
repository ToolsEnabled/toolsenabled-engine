'use strict';

// P15's small deterministic code generator.  The checked JSON policy/schema
// remain the authority; generated consumers are intentionally self-contained
// so a worker in another process never needs to import the broker runtime.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const POLICY_PATH = path.join(ROOT, 'schemas', 'platform', 'error-policy.json');
const SCHEMA_PATH = path.join(ROOT, 'schemas', 'platform', 'error.schema.json');
const OUTPUTS = Object.freeze({
  javascript: path.join(ROOT, 'schemas', 'generated', 'platform.errors.js'),
  typescript: path.join(ROOT, 'schemas', 'generated', 'platform.errors.ts'),
  python: path.join(ROOT, 'schemas', 'generated', 'coordinator_platform_errors.py'),
  artifact: path.join(ROOT, 'artifacts', 'coordinator-platform-error-taxonomy-1.0.0.json')
});
// artifacts/ is deliberately gitignored run output. `--check` is the source
// ratchet, so it verifies only the three tracked generated bindings; an absent
// or old local artifact must not turn a clean checkout red or make P15 skip.
// A normal generation still writes all four outputs for consumers that want
// the portable digest artifact.
const CHECKED_OUTPUTS = Object.freeze([
  OUTPUTS.javascript,
  OUTPUTS.typescript,
  OUTPUTS.python
]);
const RETRY_CEILING_KEYS = Object.freeze(['default', 'external-read', 'external-write', 'local-read', 'local-write']);

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function stable(value) { return JSON.stringify(value, null, 2); }
function pythonLiteral(value) {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(', ')}]`;
  if (!value || typeof value !== 'object') throw new Error('P15 Python binding source must be JSON-compatible.');
  return `{${Object.keys(value).map(key => `${JSON.stringify(key)}: ${pythonLiteral(value[key])}`).join(', ')}}`;
}

function validate(policy, schema) {
  if (!policy || policy.policyVersion !== '1.0.0' || policy.policyAuthority !== 'toolsenabled'
    || !Array.isArray(policy.codes) || !Number.isSafeInteger(policy.globalRetryCeiling)
    || policy.globalRetryCeiling < 1 || policy.globalRetryCeiling > 10
    || !policy.operationRetryCeilings || typeof policy.operationRetryCeilings !== 'object' || Array.isArray(policy.operationRetryCeilings)
    || !schema || schema.$id !== 'urn:coordinator:platform:error:1.0.0') {
    throw new Error('P15 error taxonomy policy/schema is invalid.');
  }
  const codes = policy.codes.map(item => item.code);
  const requiredCodes = [
    'INVALID_REQUEST', 'POLICY_DENIED', 'APPROVAL_REQUIRED', 'INPUT_REQUIRED', 'AUTH_EXPIRED',
    'QUOTA_EXHAUSTED', 'UNAVAILABLE', 'TIMEOUT', 'MALFORMED_OUTPUT', 'VERIFICATION_FAILED',
    'STALE_DATA', 'RESOURCE_PRESSURE', 'INJECTION_DETECTED', 'SANDBOX_VIOLATION', 'EXTERNAL_CHANGE', 'INTERNAL_ERROR', 'OPERATION_CANCELLED'
  ];
  if (new Set(codes).size !== codes.length || codes.length < requiredCodes.length || requiredCodes.some(code => !codes.includes(code))
    || JSON.stringify(schema.properties?.code?.enum) !== JSON.stringify(codes)) {
    throw new Error('P15 error taxonomy codes must be closed and schema-aligned.');
  }
  const properties = schema.properties || {};
  const requiredFields = ['schemaVersion', 'code', 'classification', 'retryable', 'safeSummary'];
  const expectedProperties = ['schemaVersion', 'code', 'classification', 'retryable', 'safeSummary', 'retryAfterMs'];
  const noTerminalRetryAfter = schema.allOf && schema.allOf.length === 1 && schema.allOf[0];
  if (schema.type !== 'object' || schema.additionalProperties !== false
    || !Array.isArray(schema.required) || schema.required.length !== requiredFields.length
    || requiredFields.some(field => !schema.required.includes(field))
    || JSON.stringify(Object.keys(properties).sort()) !== JSON.stringify(expectedProperties.sort())
    || properties.schemaVersion?.type !== 'string' || properties.schemaVersion?.const !== policy.policyVersion
    || properties.code?.type !== 'string'
    || properties.classification?.type !== 'string'
    || JSON.stringify(properties.classification?.enum) !== JSON.stringify(['terminal', 'retry-after-input', 'retry-after-time'])
    || properties.retryable?.type !== 'boolean'
    || properties.safeSummary?.type !== 'string' || properties.safeSummary?.minLength !== 1 || properties.safeSummary?.maxLength !== 240
    || properties.retryAfterMs?.type !== 'integer' || properties.retryAfterMs?.minimum !== 0 || properties.retryAfterMs?.maximum !== 3600000
    || !noTerminalRetryAfter || noTerminalRetryAfter.if?.properties?.retryable?.const !== false
    || JSON.stringify(noTerminalRetryAfter.if?.required) !== JSON.stringify(['retryable'])
    || JSON.stringify(noTerminalRetryAfter.then?.not?.required) !== JSON.stringify(['retryAfterMs'])) {
    throw new Error('P15 error taxonomy schema must remain closed and fully bounded.');
  }
  for (const item of policy.codes) {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(item.code)
      || !['terminal', 'retry-after-input', 'retry-after-time'].includes(item.classification)
      || item.retryable !== (item.classification === 'retry-after-time')
      || typeof item.safeSummary !== 'string' || item.safeSummary.length < 1 || item.safeSummary.length > 240
      || !(item.defaultRetryAfterMs === null || (Number.isSafeInteger(item.defaultRetryAfterMs)
        && item.defaultRetryAfterMs >= 0 && item.defaultRetryAfterMs <= 3600000))
      || (!item.retryable && item.defaultRetryAfterMs !== null)) {
      throw new Error(`Invalid P15 taxonomy entry ${item.code}.`);
    }
  }
  if (JSON.stringify(Object.keys(policy.operationRetryCeilings).sort()) !== JSON.stringify([...RETRY_CEILING_KEYS].sort())) {
    throw new Error('P15 retry ceiling keys must match the closed policy.');
  }
  for (const value of Object.values(policy.operationRetryCeilings)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > policy.globalRetryCeiling) {
      throw new Error('P15 retry ceilings must be bounded by the global ceiling.');
    }
  }
  return true;
}

function renderJavaScript(policy, schema) {
  return [
    "'use strict';",
    '',
    '// Generated by tools/generate-error-taxonomy-bindings.js. Do not edit.',
    `const POLICY = Object.freeze(${stable(policy)});`,
    `const SCHEMA = Object.freeze(${stable(schema)});`,
    "const BY_CODE = new Map(POLICY.codes.map(item => [item.code, Object.freeze({ ...item })]));",
    'const ERROR_CODES = Object.freeze(Object.fromEntries([...BY_CODE]));',
    'const ERROR_CODE_VALUES = Object.freeze([...BY_CODE.keys()]);',
    "function policyFor(code) { return BY_CODE.get(code) || null; }",
    "function validatePublicFailure(value) {",
    "  const keys = ['schemaVersion','code','classification','retryable','safeSummary','retryAfterMs'];",
    "  const required = ['schemaVersion','code','classification','retryable','safeSummary'];",
    "  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('error failure is invalid');",
    "  const policy = policyFor(value.code);",
    "  if (!policy || value.schemaVersion !== POLICY.policyVersion || value.classification !== policy.classification || value.retryable !== policy.retryable || value.safeSummary !== policy.safeSummary || (Object.hasOwn(value, 'retryAfterMs') && (!policy.retryable || !Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0 || value.retryAfterMs > 3600000))) throw new TypeError('error failure is invalid');",
    '  return Object.freeze({ ...value });',
    '}',
    'module.exports = Object.freeze({ ERROR_CODES, ERROR_CODE_VALUES, POLICY, SCHEMA, policyFor, validatePublicFailure });',
    ''
  ].join('\n');
}

function renderTypeScript(policy) {
  const values = policy.codes.map(item => `'${item.code}'`).join(' | ');
  return [
    '// Generated by tools/generate-error-taxonomy-bindings.js. Do not edit.',
    `export type ErrorCode = ${values};`,
    "export type ErrorClassification = 'terminal' | 'retry-after-input' | 'retry-after-time';",
    'export interface PublicFailure { schemaVersion: "1.0.0"; code: ErrorCode; classification: ErrorClassification; retryable: boolean; safeSummary: string; retryAfterMs?: number; }',
    `export const ERROR_POLICY = ${stable(policy)} as const;`,
    ''
  ].join('\n');
}

function renderPython(policy, schema) {
  return [
    '# Generated by tools/generate-error-taxonomy-bindings.js. Do not edit.',
    'from __future__ import annotations',
    '',
    'from typing import Any, Mapping',
    `POLICY: dict[str, Any] = ${pythonLiteral(policy)}`,
    `SCHEMA: dict[str, Any] = ${pythonLiteral(schema)}`,
    "BY_CODE: dict[str, Mapping[str, Any]] = {item['code']: item for item in POLICY['codes']}",
    "ERROR_CODE_VALUES: tuple[str, ...] = tuple(BY_CODE)",
    '',
    'def policy_for(code: str) -> Mapping[str, Any] | None:',
    '    return BY_CODE.get(code)',
    '',
    'def validate_public_failure(value: Mapping[str, Any]) -> Mapping[str, Any]:',
    "    allowed = {'schemaVersion','code','classification','retryable','safeSummary','retryAfterMs'}",
    "    required = {'schemaVersion','code','classification','retryable','safeSummary'}",
    "    if type(value) is not dict or not required.issubset(set(value)) or not set(value).issubset(allowed): raise ValueError('error failure is invalid')",
    "    policy = policy_for(value.get('code'))",
    "    if policy is None or value.get('schemaVersion') != POLICY['policyVersion'] or value.get('classification') != policy['classification'] or value.get('retryable') is not policy['retryable'] or value.get('safeSummary') != policy['safeSummary']: raise ValueError('error failure is invalid')",
    "    if 'retryAfterMs' in value and (policy['retryable'] is not True or type(value['retryAfterMs']) is not int or value['retryAfterMs'] < 0 or value['retryAfterMs'] > 3600000): raise ValueError('error failure is invalid')",
    '    return dict(value)',
    '',
    "__all__ = ['POLICY', 'SCHEMA', 'BY_CODE', 'ERROR_CODE_VALUES', 'policy_for', 'validate_public_failure']",
    ''
  ].join('\n');
}

function renderArtifact(policy, schema) {
  return `${JSON.stringify({
    policyVersion: policy.policyVersion,
    policySha256: crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
    schemaSha256: crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex'),
    codes: policy.codes.map(item => item.code)
  }, null, 2)}\n`;
}

function renderAll() {
  const policy = readJson(POLICY_PATH);
  const schema = readJson(SCHEMA_PATH);
  validate(policy, schema);
  return new Map([
    [OUTPUTS.javascript, renderJavaScript(policy, schema)],
    [OUTPUTS.typescript, renderTypeScript(policy)],
    [OUTPUTS.python, renderPython(policy, schema)],
    [OUTPUTS.artifact, renderArtifact(policy, schema)]
  ]);
}

function generate({ check = false } = {}) {
  const outputs = renderAll();
  for (const [target, content] of outputs) {
    if (check) {
      if (!CHECKED_OUTPUTS.includes(target)) continue;
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) throw new Error(`Generated P15 error binding is stale: ${path.relative(ROOT, target)}`);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  }
  return outputs;
}

if (require.main === module) {
  generate({ check: process.argv.includes('--check') });
  process.stdout.write(`P15 error taxonomy bindings ${process.argv.includes('--check') ? 'verified' : 'generated'}.\n`);
}

module.exports = Object.freeze({ CHECKED_OUTPUTS, OUTPUTS, POLICY_PATH, SCHEMA_PATH, generate, pythonLiteral, renderAll, validate });
