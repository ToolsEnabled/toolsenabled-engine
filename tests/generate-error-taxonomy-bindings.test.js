'use strict';

// Pins every refusal emitted by tools/generate-error-taxonomy-bindings.js and
// drives every closed taxonomy code through the generated JavaScript binding.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const tool = require('../tools/generate-error-taxonomy-bindings');
const canonicalPolicy = require('../schemas/platform/error-policy.json');
const canonicalSchema = require('../schemas/platform/error.schema.json');
const generated = require('../schemas/generated/platform.errors');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function refusal(label, expected, invoke) {
  assert.throws(invoke, expected, `${label} must refuse`);
}

assert.equal(tool.validate(clone(canonicalPolicy), clone(canonicalSchema)), true);

refusal('non-JSON Python source', /P15 Python binding source must be JSON-compatible\./, () => {
  tool.pythonLiteral(undefined);
});

const invalidPolicy = clone(canonicalPolicy);
invalidPolicy.policyAuthority = 'somebody-else';
refusal('invalid policy/schema envelope', /P15 error taxonomy policy\/schema is invalid\./, () => {
  tool.validate(invalidPolicy, clone(canonicalSchema));
});

const openCodes = clone(canonicalPolicy);
openCodes.codes.pop();
refusal('non-closed code set', /P15 error taxonomy codes must be closed and schema-aligned\./, () => {
  tool.validate(openCodes, clone(canonicalSchema));
});

const openSchema = clone(canonicalSchema);
openSchema.additionalProperties = true;
refusal('open schema', /P15 error taxonomy schema must remain closed and fully bounded\./, () => {
  tool.validate(clone(canonicalPolicy), openSchema);
});

const invalidEntry = clone(canonicalPolicy);
invalidEntry.codes[0].safeSummary = '';
refusal('invalid taxonomy entry', /Invalid P15 taxonomy entry INVALID_REQUEST\./, () => {
  tool.validate(invalidEntry, clone(canonicalSchema));
});

const extraCeiling = clone(canonicalPolicy);
extraCeiling.operationRetryCeilings.surprise = 1;
refusal('non-closed retry ceiling keys', /P15 retry ceiling keys must match the closed policy\./, () => {
  tool.validate(extraCeiling, clone(canonicalSchema));
});

const highCeiling = clone(canonicalPolicy);
highCeiling.operationRetryCeilings.default = highCeiling.globalRetryCeiling + 1;
refusal('retry ceiling above global bound', /P15 retry ceilings must be bounded by the global ceiling\./, () => {
  tool.validate(highCeiling, clone(canonicalSchema));
});

for (const item of canonicalPolicy.codes) {
  const value = {
    schemaVersion: canonicalPolicy.policyVersion,
    code: item.code,
    classification: item.classification,
    retryable: item.retryable,
    safeSummary: item.safeSummary
  };
  if (item.defaultRetryAfterMs !== null) value.retryAfterMs = item.defaultRetryAfterMs;
  assert.deepEqual(generated.validatePublicFailure(value), value, `${item.code} must be an accepted named code`);
  assert.equal(generated.policyFor(item.code).code, item.code);
}

// Exercise the CLI-only stale-output refusal in an isolated miniature tree so
// this test never changes checked-in generated files.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-generator-'));
try {
  fs.mkdirSync(path.join(fixture, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'schemas', 'platform'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'generate-error-taxonomy-bindings.js'), path.join(fixture, 'tools', 'generate-error-taxonomy-bindings.js'));
  fs.copyFileSync(path.join(ROOT, 'schemas', 'platform', 'error-policy.json'), path.join(fixture, 'schemas', 'platform', 'error-policy.json'));
  fs.copyFileSync(path.join(ROOT, 'schemas', 'platform', 'error.schema.json'), path.join(fixture, 'schemas', 'platform', 'error.schema.json'));

  let result = spawnSync(process.execPath, ['tools/generate-error-taxonomy-bindings.js'], { cwd: fixture, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bindings generated/);

  // artifacts/ is untracked run output, not a clean-checkout prerequisite.
  // Removing or aging that output must not disable the tracked binding check.
  fs.writeFileSync(path.join(fixture, 'artifacts', 'coordinator-platform-error-taxonomy-1.0.0.json'), '{"stale":true}\n');
  result = spawnSync(process.execPath, ['tools/generate-error-taxonomy-bindings.js', '--check'], { cwd: fixture, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bindings verified/);

  fs.appendFileSync(path.join(fixture, 'schemas', 'generated', 'platform.errors.js'), '// stale\n');
  result = spawnSync(process.execPath, ['tools/generate-error-taxonomy-bindings.js', '--check'], { cwd: fixture, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'stale generated output must make --check exit nonzero');
  assert.match(result.stderr, /Generated P15 error binding is stale: schemas[/\\]generated[/\\]platform\.errors\.js/);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log('generate-error-taxonomy-bindings refusals and named codes pinned');
