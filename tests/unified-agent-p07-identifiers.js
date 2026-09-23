'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { OUTPUTS, PACKAGE_ROOT, loadPackage } = require('../tools/generate-platform-contracts');
const { createPlatformContractFixture, machineWidePython } = require('./lib/platform-contract-fixture');

const ROOT = path.resolve(__dirname, '..');
const GENERATED_ROOT = path.join(ROOT, 'schemas', 'generated');
const PYTHON = machineWidePython();
const contractFixture = createPlatformContractFixture();
const vectors = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'fixtures', 'identity-vectors.json'), 'utf8'));
const artifact = JSON.parse(fs.readFileSync(contractFixture.pathFor(OUTPUTS.identityArtifact), 'utf8'));
const { identityPolicy, manifest } = loadPackage();
const identity = require('../schemas/generated/platform.identity');

assert.equal(identity.POLICY.policyVersion, manifest.schemaVersion);
assert.equal(identity.POLICY.authorization.visiblePrefixGrantsAuthority, false);
assert.equal(identity.POLICY.authorization.idValidationIsLexicalOnly, true);
assert.equal(identity.POLICY.monotonicClock.serialized, false);
assert.equal(identity.POLICY.monotonicClock.crossProcessComparable, false);
assert.equal(identity.POLICY.controlTimestamp.timezone, 'UTC');
assert.equal(identity.POLICY.idEncoding.randomnessBits, 192);
assert.equal(crypto.createHash('sha256').update(JSON.stringify(identityPolicy)).digest('hex'), artifact.policySha256);

for (const item of vectors.validIds) assert.equal(identity.validateId(item.kind, item.value), item.value);
for (const item of vectors.invalidIds) {
  assert.throws(() => identity.validateId(item.kind, item.value), /(unknown ID kind|malformed)/);
}
for (const value of vectors.validControlTimestamps) {
  assert.equal(identity.parseControlTimestamp(value).toISOString(), value);
}
for (const value of vectors.invalidControlTimestamps) {
  assert.throws(() => identity.parseControlTimestamp(value), /UTC ISO-8601|real UTC/);
}
assert.match(identity.utcNowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
assert.ok(identity.monotonicMilliseconds() >= 0);

for (let index = 0; index < vectors.canonical.length; index += 1) {
  assert.equal(identity.canonicalString(vectors.canonical[index].value), vectors.canonical[index].canonical);
  assert.equal(artifact.canonical[index].canonical, vectors.canonical[index].canonical);
}
for (let index = 0; index < vectors.hashes.length; index += 1) {
  const vector = vectors.hashes[index];
  assert.equal(identity.canonicalHash(vector.domain, vector.value), artifact.hashes[index].sha256);
  assert.equal(identity.canonicalString(vector.value), artifact.hashes[index].canonical);
}
for (const value of vectors.invalidDomains) {
  assert.throws(() => identity.canonicalHash(value, {}), /canonical hash domain/);
}
assert.notEqual(
  identity.canonicalHash('coordinator:task:v1', vectors.hashes[0].value),
  identity.canonicalHash('coordinator:event:v1', vectors.hashes[0].value),
  'domain separation must affect the digest'
);
assert.throws(() => identity.canonicalString({ unsafe: 0.5 }), /safe integer/);
assert.throws(() => identity.canonicalString({ 'nön-ascii': 1 }), /ASCII object keys/);

const sequenceTask = vectors.validIds.find(item => item.kind === 'task').value;
const sequence = new identity.TaskEventSequence(sequenceTask);
assert.deepEqual([sequence.next(), sequence.next()], [1, 2]);
const resumed = new identity.TaskEventSequence(sequenceTask, 41);
assert.deepEqual([resumed.next(), resumed.next()], [41, 42]);
assert.throws(() => new identity.TaskEventSequence('tsk_fixture01'), /malformed/);

const generated = new Set();
for (let index = 0; index < 10000; index += 1) {
  const value = identity.newId('task');
  identity.validateId('task', value);
  assert.equal(generated.has(value), false, 'CSPRNG sample contained an unexpected collision');
  generated.add(value);
}
assert.equal(generated.size, 10000);

const javascriptSource = fs.readFileSync(OUTPUTS.javascriptIdentity, 'utf8');
const typescriptSource = fs.readFileSync(OUTPUTS.typescriptIdentity, 'utf8');
const pythonSource = fs.readFileSync(OUTPUTS.toolsEnabledPythonIdentity, 'utf8');
assert.match(javascriptSource, /crypto\.randomBytes/);
assert.doesNotMatch(javascriptSource, /Math\.random/);
assert.doesNotMatch(javascriptSource, /^\s*import\s+/m);
assert.doesNotMatch(javascriptSource, /^\s*(?:const|let|var)\s+.*\brequire\s*\(\s*['"](?!node:crypto)/m);
assert.doesNotMatch(typescriptSource, /(?:from|require)\s*\(?\s*['"][^'"]*(?:app\/markiv|src\/lib|sidecars\/|portfolio dashboard)/i);
assert.match(pythonSource, /secrets\.token_bytes/);
assert.doesNotMatch(pythonSource, /\bimport\s+(?:app|toolsenabled)\b/);
assert.equal(path.basename(OUTPUTS.toolsEnabledPythonIdentity), 'coordinator_platform_identity.py');

const pythonProgram = [
  'import json, sys',
  'from pathlib import Path',
  'generated = Path(sys.argv[1])',
  'vectors = json.loads(Path(sys.argv[2]).read_text())',
  'sys.path.insert(0, str(generated))',
  'import coordinator_platform_identity as identity',
  'result = {}',
  "result['canonical'] = [identity.canonical_string(item['value']) for item in vectors['canonical']]",
  "result['hashes'] = [identity.canonical_hash(item['domain'], item['value']) for item in vectors['hashes']]",
  "result['validIds'] = [identity.validate_id(item['kind'], item['value']) for item in vectors['validIds']]",
  "result['invalidIds'] = []",
  "for item in vectors['invalidIds']:",
  '    try: identity.validate_id(item[\'kind\'], item[\'value\'])',
  '    except ValueError: result[\'invalidIds\'].append(True)',
  '    else: result[\'invalidIds\'].append(False)',
  "result['validTimes'] = []",
  "for value in vectors['validControlTimestamps']:",
  '    identity.parse_control_timestamp(value)',
  "    result['validTimes'].append(value)",
  "result['invalidTimes'] = []",
  "for value in vectors['invalidControlTimestamps']:",
  '    try: identity.parse_control_timestamp(value)',
  '    except ValueError: result[\'invalidTimes\'].append(True)',
  '    else: result[\'invalidTimes\'].append(False)',
  "task = next(item['value'] for item in vectors['validIds'] if item['kind'] == 'task')",
  'sequence = identity.TaskEventSequence(task)',
  "result['sequence'] = [sequence.next(), sequence.next()]",
  'print(json.dumps(result, sort_keys=True))'
].join('\n');
const python = spawnSync(PYTHON, ['-B', '-c', pythonProgram, GENERATED_ROOT, path.join(PACKAGE_ROOT, 'fixtures', 'identity-vectors.json')], {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true
});
assert.ifError(python.error);
assert.equal(python.status, 0, python.stderr);
const pythonResult = JSON.parse(python.stdout);
assert.deepEqual(pythonResult.canonical, vectors.canonical.map(item => item.canonical));
assert.deepEqual(pythonResult.hashes, artifact.hashes.map(item => item.sha256));
assert.deepEqual(pythonResult.validIds, vectors.validIds.map(item => item.value));
assert.deepEqual(pythonResult.invalidIds, vectors.invalidIds.map(() => true));
assert.deepEqual(pythonResult.validTimes, vectors.validControlTimestamps);
assert.deepEqual(pythonResult.invalidTimes, vectors.invalidControlTimestamps.map(() => true));
assert.deepEqual(pythonResult.sequence, [1, 2]);

console.log('Unified-agent P07 identifier/clock/hash check passed (10,000 CSPRNG IDs, cross-language vectors).');
