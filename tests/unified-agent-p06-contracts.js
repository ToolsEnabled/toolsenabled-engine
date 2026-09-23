'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  OUTPUTS, PACKAGE_ROOT, assertAdditiveCompatible, loadPackage, validatePackage
} = require('../tools/generate-platform-contracts');
const { createPlatformContractFixture, machineWidePython } = require('./lib/platform-contract-fixture');

const ROOT = path.resolve(__dirname, '..');
const GENERATED_ROOT = path.join(ROOT, 'schemas', 'generated');
const PYTHON = machineWidePython();
const contractFixture = createPlatformContractFixture();
const { manifest, schemas, ownership } = loadPackage();
const validator = require('../schemas/generated/platform.validator');

const generatedOutputs = contractFixture.rendered;
for (const target of generatedOutputs.keys()) {
  const relative = path.relative(ROOT, target);
  assert.ok(
    relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `generated output escaped the ToolsEnabled repository: ${target}`
  );
}
assert.equal(manifest.schemaAuthority, 'toolsenabled');
assert.equal(manifest.schemaVersion, '1.0.0');
assert.equal(manifest.schemas.length, 12);

const canonical = {};
for (const item of manifest.schemas) {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(PACKAGE_ROOT, 'fixtures', 'valid', item.name + '.json'), 'utf8'));
  assert.deepEqual(validator.validateContract(item.name, fixture), fixture);
  canonical[item.name] = validator.canonicalContract(item.name, fixture);
  assert.equal(schemas[item.name].additionalProperties, false);
}
assert.match(canonical.task, /^\{"objective":/);
assert.throws(
  () => validator.validateContract('task', JSON.parse(fs.readFileSync(
    path.join(PACKAGE_ROOT, 'fixtures', 'invalid', 'task-breaking-extra-field.json'), 'utf8'))),
  /unknown property/
);
assert.equal(schemas['finance-result'].properties.data.additionalProperties, true);
assert.equal(validator.canonicalString({ b: 1.0, a: 'x' }), '{"a":"x","b":1}');
assert.throws(() => validator.canonicalString({ a: 0.5 }), /safe integer/);
const unsafeFinance = JSON.parse(fs.readFileSync(
  path.join(PACKAGE_ROOT, 'fixtures', 'valid', 'finance-result.json'), 'utf8'));
unsafeFinance.data.nested = Number.MAX_SAFE_INTEGER + 1;
assert.throws(() => validator.validateContract('finance-result', unsafeFinance), /dynamic JSON requires a safe integer/);

const optional = structuredClone(schemas.task);
optional.properties.optionalLabel = { type: 'string' };
assert.equal(assertAdditiveCompatible(schemas.task, optional), true);
const breaking = structuredClone(optional);
breaking.required.push('optionalLabel');
assert.throws(() => assertAdditiveCompatible(schemas.task, breaking), /new required field/);
const tightened = structuredClone(schemas.task);
tightened.properties.title.maxLength = 12;
assert.throws(() => assertAdditiveCompatible(schemas.task, tightened), /existing field changed/);
const nonPortable = structuredClone(schemas.task);
nonPortable.properties.taskId.pattern = '(?=.*)';
assert.throws(() => validatePackage(manifest, { ...schemas, task: nonPortable }, ownership), /non-portable/);

const typeSource = fs.readFileSync(OUTPUTS.types, 'utf8');
const validatorSource = fs.readFileSync(OUTPUTS.typescriptValidator, 'utf8');
const javascriptValidatorSource = fs.readFileSync(OUTPUTS.javascriptValidator, 'utf8');
for (const source of [typeSource, validatorSource, javascriptValidatorSource]) {
  assert.doesNotMatch(source, /(?:from|require)\s*\(?\s*['"][^'"]*(?:app\/markiv|src\/lib|sidecars\/|portfolio dashboard)/i);
}
assert.doesNotMatch(javascriptValidatorSource, /^\s*import\s+/m);
assert.doesNotMatch(javascriptValidatorSource, /^\s*(?:const|let|var)\s+.*\brequire\s*\(/m);
assert.match(typeSource, /export interface TaskV1/);
assert.match(validatorSource, /export \{ canonicalContract, canonicalString, normalize, validateContract \}/);
assert.equal(path.basename(OUTPUTS.toolsEnabledPython), 'coordinator_platform_contract.py');
assert.doesNotMatch(fs.readFileSync(OUTPUTS.toolsEnabledPython, 'utf8'), /\b(?:from|import)\s+app\b/);

const artifact = JSON.parse(fs.readFileSync(contractFixture.pathFor(OUTPUTS.artifact), 'utf8'));
assert.equal(artifact.wireVersion, manifest.schemaVersion);
for (const item of manifest.schemas) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(schemas[item.name])).digest('hex');
  assert.equal(artifact.schemaSha256[item.name], digest);
}

const pythonProgram = [
  'import json, sys',
  'from pathlib import Path',
  'generated = Path(sys.argv[1])',
  'package = Path(sys.argv[2])',
  'sys.path.insert(0, str(generated))',
  'import coordinator_platform_contract as contracts',
  "manifest = json.loads((package / 'manifest.json').read_text())",
  'result = {}',
  "for item in manifest['schemas']:",
  "    fixture = json.loads((package / 'fixtures' / 'valid' / (item['name'] + '.json')).read_text())",
  "    contracts.validate_contract(item['name'], fixture)",
  "    result[item['name']] = contracts.canonical_string(fixture)",
  "invalid = json.loads((package / 'fixtures' / 'invalid' / 'task-breaking-extra-field.json').read_text())",
  'try:',
  "    contracts.validate_contract('task', invalid)",
  'except ValueError:',
  "    result['_invalidRejected'] = True",
  'else:',
  "    result['_invalidRejected'] = False",
  'print(json.dumps(result, sort_keys=True))'
].join('\n');
const python = spawnSync(PYTHON, ['-B', '-c', pythonProgram, GENERATED_ROOT, PACKAGE_ROOT], {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true
});
assert.ifError(python.error);
assert.equal(python.status, 0, python.stderr);
const pythonCanonical = JSON.parse(python.stdout);
assert.equal(pythonCanonical._invalidRejected, true);
delete pythonCanonical._invalidRejected;
assert.deepEqual(pythonCanonical, canonical, 'Python and TypeScript-compatible validators must canonicalize every fixture identically');

console.log('Unified-agent P06 schema/codegen check passed (' + manifest.schemas.length + ' contracts).');
