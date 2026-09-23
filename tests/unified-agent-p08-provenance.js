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
const vectors = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'fixtures', 'provenance-vectors.json'), 'utf8'));
const artifact = JSON.parse(fs.readFileSync(contractFixture.pathFor(OUTPUTS.provenanceArtifact), 'utf8'));
const { manifest, provenancePolicy, provenanceSchema } = loadPackage();
const provenance = require('../schemas/generated/platform.provenance');

assert.equal(provenance.POLICY.policyVersion, manifest.schemaVersion);
assert.deepEqual(
  provenance.LABELS,
  [
    'generated-model', 'secret', 'secret-derived', 'trusted-configuration',
    'trusted-user', 'untrusted-agent', 'untrusted-browser', 'untrusted-download',
    'untrusted-repository', 'untrusted-web', 'verified-local-state', 'verified-project'
  ]
);
assert.equal(provenance.POLICY.authorization.provenanceAllowsAction, false);
assert.equal(provenance.POLICY.authorization.sinkAllowIsNecessaryButNotSufficient, true);
assert.equal(crypto.createHash('sha256').update(JSON.stringify(provenancePolicy)).digest('hex'), artifact.policySha256);
assert.equal(crypto.createHash('sha256').update(JSON.stringify(provenanceSchema)).digest('hex'), artifact.schemaSha256);
assert.equal(provenance.SCHEMA.$id, 'urn:coordinator:platform:provenance:1.0.0');

for (const envelope of Object.values(vectors.envelopes)) {
  assert.deepEqual(provenance.validateEnvelope(envelope), envelope);
}
for (const envelope of vectors.invalidEnvelopes) {
  assert.throws(() => provenance.validateEnvelope(envelope), /canonical|safe evidence reference|known provenance labels/);
}
const reorderedKeys = {
  sources: vectors.envelopes.untrustedWeb.sources,
  labels: vectors.envelopes.untrustedWeb.labels,
  schemaVersion: vectors.envelopes.untrustedWeb.schemaVersion
};
assert.deepEqual(provenance.validateEnvelope(reorderedKeys), reorderedKeys, 'object key order is not provenance semantics');

const operationFunctions = {
  concatenation: provenance.concatenate,
  calculation: provenance.calculate,
  redaction: provenance.redact,
  agentTransformation: provenance.agentTransform,
  modelSummary: provenance.modelSummary
};
for (const [name, vector] of Object.entries(vectors.operations)) {
  const inputs = vector.inputs.map(input => vectors.envelopes[input]);
  const output = operationFunctions[name](inputs);
  assert.deepEqual(output, artifact.operations[name]);
  assert.deepEqual(output.labels, vector.expectedLabels);
  assert.deepEqual(output.sources.map(item => item.evidenceId), vector.expectedEvidenceIds);
}

const finance = provenance.calculate([vectors.envelopes.verifiedFinance]);
assert.deepEqual(finance.sources, vectors.envelopes.verifiedFinance.sources, 'deterministic finance retains verified source evidence');
assert.equal(provenance.evaluateSink(finance, 'memory').allowed, true);
const modelledWeb = provenance.modelSummary([vectors.envelopes.untrustedWeb]);
assert.deepEqual(modelledWeb.labels, ['generated-model', 'untrusted-web']);
assert.equal(provenance.evaluateSink(modelledWeb, 'command').allowed, false, 'model summary cannot upgrade untrusted evidence');
assert.throws(() => provenance.requireSink(vectors.envelopes.untrustedWeb, 'command'), error => error.code === 'PROVENANCE_VIOLATION');

for (const item of vectors.sinkChecks) {
  const decision = provenance.evaluateSink(vectors.envelopes[item.input], item.sink);
  assert.equal(decision.allowed, item.allowed);
  assert.deepEqual(decision.blockingLabels, item.blockingLabels);
}
for (const item of provenance.POLICY.sinks) {
  assert.equal(provenance.evaluateSink(vectors.envelopes.untrustedWeb, item.sink).allowed, false, item.sink + ' must evaluate untrusted provenance');
  assert.equal(provenance.evaluateSink(vectors.envelopes.trustedUser, item.sink).allowed, true, item.sink + ' must have a deterministic trusted-label path');
}
assert.deepEqual(provenance.safeDisplay(vectors.envelopes[vectors.safeDisplay.input]), artifact.safeDisplay);
assert.deepEqual(Object.keys(provenance.safeDisplay(vectors.envelopes.secretInput)).sort(), ['containsSecret', 'labels', 'sourceCount']);
const attached = provenance.attach({ display: 'external payload' }, vectors.envelopes.untrustedWeb);
assert.deepEqual(provenance.validateAttached(attached), attached);
assert.throws(() => provenance.validateAttached({ value: 'missing provenance' }), /must carry/);

const javascriptSource = fs.readFileSync(OUTPUTS.javascriptProvenance, 'utf8');
const typescriptSource = fs.readFileSync(OUTPUTS.typescriptProvenance, 'utf8');
const pythonSource = fs.readFileSync(OUTPUTS.toolsEnabledPythonProvenance, 'utf8');
assert.doesNotMatch(javascriptSource, /^\s*import\s+/m);
assert.doesNotMatch(javascriptSource, /\brequire\s*\(/);
assert.match(javascriptSource, /function asciiCompare/);
assert.doesNotMatch(javascriptSource, /localeCompare/);
assert.doesNotMatch(typescriptSource, /(?:from|require)\s*\(?\s*['"][^'"]*(?:app\/markiv|src\/lib|sidecars\/|portfolio dashboard)/i);
assert.doesNotMatch(pythonSource, /\bfrom\s+app\./);
assert.doesNotMatch(pythonSource, /\bimport\s+toolsenabled\b/i);
assert.equal(path.basename(OUTPUTS.toolsEnabledPythonProvenance), 'coordinator_platform_provenance.py');

const pythonProgram = [
  'import json, sys',
  'from pathlib import Path',
  'generated = Path(sys.argv[1])',
  'vectors = json.loads(Path(sys.argv[2]).read_text())',
  'sys.path.insert(0, str(generated))',
  'import coordinator_platform_provenance as provenance',
  'result = {}',
  "functions = {'concatenation': provenance.concatenate, 'calculation': provenance.calculate, 'redaction': provenance.redact, 'agentTransformation': provenance.agent_transform, 'modelSummary': provenance.model_summary}",
  "result['operations'] = {name: functions[name]([vectors['envelopes'][input_name] for input_name in vector['inputs']]) for name, vector in vectors['operations'].items()}",
  "result['sinkChecks'] = [provenance.evaluate_sink(vectors['envelopes'][item['input']], item['sink']) for item in vectors['sinkChecks']]",
  "result['safeDisplay'] = provenance.safe_display(vectors['envelopes'][vectors['safeDisplay']['input']])",
  "result['invalid'] = []",
  "for envelope in vectors['invalidEnvelopes']:",
  '    try: provenance.validate_envelope(envelope)',
  "    except ValueError: result['invalid'].append(True)",
  "    else: result['invalid'].append(False)",
  "result['attached'] = provenance.validate_attached(provenance.attach({'display': 'external payload'}, vectors['envelopes']['untrustedWeb']))",
  'print(json.dumps(result, sort_keys=True))'
].join('\n');
const python = spawnSync(PYTHON, ['-B', '-c', pythonProgram, GENERATED_ROOT, path.join(PACKAGE_ROOT, 'fixtures', 'provenance-vectors.json')], {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true
});
assert.ifError(python.error);
assert.equal(python.status, 0, python.stderr);
const pythonResult = JSON.parse(python.stdout);
assert.deepEqual(pythonResult.operations, artifact.operations);
assert.deepEqual(pythonResult.sinkChecks, artifact.sinkChecks.map(item => ({
  sink: item.sink, allowed: item.allowed, code: item.allowed ? 'OK' : 'PROVENANCE_VIOLATION', blockingLabels: item.blockingLabels
})));
assert.deepEqual(pythonResult.safeDisplay, artifact.safeDisplay);
assert.deepEqual(pythonResult.invalid, vectors.invalidEnvelopes.map(() => true));
assert.deepEqual(pythonResult.attached, attached);

console.log('Unified-agent P08 provenance propagation check passed (cross-language sinks and mixed provenance vectors).');
