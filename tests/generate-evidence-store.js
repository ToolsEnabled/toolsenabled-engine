'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const generator = require('../tools/generate-evidence-store');

const EXPECTED_REFUSALS = [
  'P10 evidence-store policy identity is invalid',
  'P10 evidence-store database identity is invalid',
  'P10 content-addressed object layout is invalid',
  'P10 metadata hash domains are invalid',
  'P10 authorization policy must fail closed',
  'P10 bounded orphan-maintenance policy is invalid',
  'P10 public export must preserve the P09 gate',
  'P10 must remain default-off and unregistered',
  'P10 retention classes are invalid',
  'P10 tombstone reasons are invalid',
  'P10 generated verifier prerequisites are invalid',
  'P10 evidence-store record schema is invalid',
  'P10 evidence-store record fields diverge from policy',
  'P10 Python template markers were not fully rendered',
  'Generated output must stay inside the ToolsEnabled repository: ',
  'Generated P10 evidence-store contract is stale: '
];

function copyPackage() {
  return structuredClone(generator.loadPackage());
}

function rejectsValidation(message, mutate) {
  const source = copyPackage();
  mutate(source);
  assert.throws(
    () => generator.validate(
      source.policy,
      source.schema,
      source.provenancePolicy,
      source.redactionPolicy,
      source.redactionReportSchema
    ),
    error => error instanceof Error && error.message === message,
    `expected refusal: ${message}`
  );
}

rejectsValidation(EXPECTED_REFUSALS[0], source => { source.policy.policyAuthority = 'somebody-else'; });
rejectsValidation(EXPECTED_REFUSALS[1], source => { source.policy.database.journalMode = 'delete'; });
rejectsValidation(EXPECTED_REFUSALS[2], source => { source.policy.storage.hashAlgorithm = 'sha1'; });
rejectsValidation(EXPECTED_REFUSALS[3], source => { source.policy.recordHash.domain = 'wrong-domain'; });
rejectsValidation(EXPECTED_REFUSALS[4], source => { source.policy.authorization.defaultWithoutAuthorizer = 'allow'; });
rejectsValidation(EXPECTED_REFUSALS[5], source => { source.policy.maintenance.maximumSweepFiles = 0; });
rejectsValidation(EXPECTED_REFUSALS[6], source => { source.policy.publicExport.protectedBytesReturned = true; });
rejectsValidation(EXPECTED_REFUSALS[7], source => { source.policy.activation.providerEnabled = true; });
rejectsValidation(EXPECTED_REFUSALS[8], source => { source.policy.retention.defaultClass = 'durable'; });
rejectsValidation(EXPECTED_REFUSALS[9], source => { source.policy.retention.deletion.reasonCodes.pop(); });
rejectsValidation(EXPECTED_REFUSALS[10], source => { source.provenancePolicy.labels = null; });
rejectsValidation(EXPECTED_REFUSALS[11], source => { source.schema.additionalProperties = true; });
rejectsValidation(EXPECTED_REFUSALS[12], source => { source.schema.properties.summary.maxLength += 1; });

// Feed renderPython a template containing an extra named marker. This exercises
// the post-render refusal without changing the checked-in template.
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function readFileSyncWithUnrenderedMarker(filename, ...args) {
  const value = originalReadFileSync.call(this, filename, ...args);
  return path.resolve(filename) === generator.TEMPLATE_PATH ? `${value}\n__LEFTOVER_JSON__\n` : value;
};
try {
  assert.throws(
    () => generator.renderPython(copyPackage()),
    error => error instanceof Error && error.message === EXPECTED_REFUSALS[13]
  );
} finally {
  fs.readFileSync = originalReadFileSync;
}

// Load the real module source with its private path guard exposed. Keeping the
// production API narrow should not make its refusal untestable.
const filename = path.join(__dirname, '..', 'tools', 'generate-evidence-store.js');
const sourceText = `${fs.readFileSync(filename, 'utf8')}\nmodule.exports.assertRepositoryOutput = assertRepositoryOutput;`;
const sandboxModule = { exports: {} };
const localRequire = request => request.startsWith('.')
  ? require(path.resolve(path.dirname(filename), request))
  : require(request);
vm.runInNewContext(sourceText, {
  Buffer,
  __dirname: path.dirname(filename),
  __filename: filename,
  module: sandboxModule,
  exports: sandboxModule.exports,
  require: localRequire,
  process
}, { filename });
const outside = path.resolve(path.dirname(filename), '..', '..', 'outside.json');
assert.throws(
  () => sandboxModule.exports.assertRepositoryOutput(outside),
  error => error && error.message === `${EXPECTED_REFUSALS[14]}${outside}`
);

// A missing generated file is the simplest concrete stale-contract value.
const originalExistsSync = fs.existsSync;
fs.existsSync = filenameToCheck => filenameToCheck === generator.OUTPUTS.toolsEnabledPythonEvidence
  ? false
  : originalExistsSync(filenameToCheck);
try {
  const relative = path.relative(path.resolve(__dirname, '..'), generator.OUTPUTS.toolsEnabledPythonEvidence);
  assert.throws(
    () => generator.generate({ check: true }),
    error => error && error.message === `${EXPECTED_REFUSALS[15]}${relative}`
  );
} finally {
  fs.existsSync = originalExistsSync;
}

// Ratchet the complete named-refusal inventory so a newly added exit cannot be
// silently left without a concrete invocation above.
const namedThrows = [...fs.readFileSync(filename, 'utf8').matchAll(/throw new Error\((?:`([^`]+)`|'([^']+)')\)/g)]
  .map(match => (match[1] || match[2]).split('${')[0]);
assert.deepEqual(namedThrows, EXPECTED_REFUSALS);

process.stdout.write('generate-evidence-store refusal tests passed\n');
