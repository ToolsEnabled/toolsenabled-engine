// EXECUTABLE CHANGE
//
// Discriminating mutation: platform.redaction.js was temporarily changed so
// prepareEgress returned an empty payload for the legacy-field fixture. Before
// the key-set assertion below, Object.values({}).every(...) stayed green. With
// the assertion, the mutation went RED with:
//   AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
//   + actual - expected
//   + []
//   - [ 'accessToken', 'api_key', 'authorization', 'clientSecret', 'cookie',
//   -   'credential', 'password', 'privateKey', 'refresh_token', 'session',
//   -   'vaultKey' ]
// The generated source was restored byte-for-byte (SHA-256
// 5dd5338ca8aa6ff2f7b8dc099bc8299efe54809c4fe33b2f3c55a7f9b4e9639c), and
// `node tests/unified-agent-p09-redaction.js` was green again:
//   Unified-agent P09 redaction/canary check passed (six egresses, cross-language residual gate).
// Audit census: empty-loop/forEach -- FOUND and fixed for Object.values(...).every;
// exit-status/truthy-only -- NOT-FOUND (Python status is paired with parsed,
// cross-language output comparisons); swallowed try/catch/optional-chain --
// NOT-FOUND; mock-of-subject -- NOT-FOUND; skip/platform guard -- NOT-FOUND;
// same-code expected value -- NOT-FOUND. Preconditions: Python and generated
// artifacts were available after running the repository generator.

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
const vectors = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'fixtures', 'redaction-vectors.json'), 'utf8'));
const provenanceVectors = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'fixtures', 'provenance-vectors.json'), 'utf8'));
const artifact = JSON.parse(fs.readFileSync(contractFixture.pathFor(OUTPUTS.redactionArtifact), 'utf8'));
const { redactionPolicy, redactionReportSchema, redactionVectors } = loadPackage();
const redaction = require('../schemas/generated/platform.redaction');

assert.equal(redaction.POLICY.policyAuthority, 'toolsenabled');
assert.equal(redaction.POLICY.serviceId, 'coordinator-platform-redaction-v1');
assert.equal(redaction.REPORT_SCHEMA.$id, 'urn:coordinator:platform:redaction-report:1.0.0');
assert.equal(crypto.createHash('sha256').update(JSON.stringify(redactionPolicy)).digest('hex'), artifact.policySha256);
assert.equal(crypto.createHash('sha256').update(JSON.stringify(redactionReportSchema)).digest('hex'), artifact.reportSchemaSha256);
assert.equal(crypto.createHash('sha256').update(JSON.stringify(redactionVectors)).digest('hex'), artifact.fixtureSha256);
assert.deepEqual(redaction.POLICY.egressKinds, artifact.egressCases.map(item => item.egress));

const preparedCases = {};
for (const item of vectors.egressCases) {
  const raw = vectors.payloads[item.payload];
  assert.equal(redaction.scanCanaries(raw).detected, true);
  const prepared = redaction.prepareEgress(item.egress, raw);
  assert.deepEqual(redaction.verifyPreparedEgress(prepared, item.egress), prepared);
  assert.equal(redaction.scanCanaries(prepared.payload).count, 0);
  assert.doesNotMatch(JSON.stringify(prepared.payload), /TOOLSENABLED_CANARY_/);
  assert.doesNotMatch(JSON.stringify(prepared.redactionReport), /TOOLSENABLED_CANARY_|OWNER_PRIVATE_FIXTURE|CUSTOM_FIELD_FIXTURE/);
  assert.equal(prepared.redactionReport.canaryDetected, true);
  assert.ok(prepared.redactionReport.canaryCount >= 1);
  assert.ok(prepared.redactionReport.findingCount >= 1);
  for (const finding of prepared.redactionReport.findings) {
    assert.deepEqual(Object.keys(finding).sort(), ['category', 'count', 'detectorId', 'path']);
  }
  preparedCases[item.egress] = prepared;
}

const finance = preparedCases['training-candidate'].payload;
assert.equal(finance.ticker, 'AAPL');
assert.equal(finance.accountId, '[REDACTED]');
assert.deepEqual(finance.positions, vectors.payloads.finance.positions);
assert.equal(finance.code, vectors.payloads.finance.code);

const patterns = redaction.prepareEgress('evidence-export', vectors.payloads.patternRegistry);
redaction.verifyPreparedEgress(patterns, 'evidence-export');
for (const key of ['privateKeyText', 'secretHandleText', 'authorizationText', 'providerTokenText', 'oauthText', 'jwtText']) {
  assert.match(patterns.payload[key], /\[REDACTED\]/, key + ' must use the canonical registry');
  assert.doesNotMatch(patterns.payload[key], /TOOLSENABLED_CANARY_|FAKEPROVIDERTOKEN|FAKEHEADER|FAKEPAYLOAD|FAKESIGNATURE/);
}
assert.equal(patterns.payload.payment.cardNumber, '[REDACTED]');
assert.equal(patterns.payload.payment.cvc, '[REDACTED]');

const customOptions = {
  sensitiveValues: vectors.customization.sensitiveValues,
  sensitiveFieldNames: vectors.customization.sensitiveFieldNames
};
const custom = redaction.prepareEgress('notification', vectors.payloads.customUserSensitive, customOptions);
redaction.verifyPreparedEgress(custom, 'notification', customOptions);
assert.equal(custom.payload.displayName, 'Fixture Owner');
assert.equal(custom.payload.personalNote, 'Owner marker [REDACTED]');
assert.equal(custom.payload.customIdentifier, '[REDACTED]');
assert.doesNotMatch(JSON.stringify(custom.redactionReport), /OWNER_PRIVATE_FIXTURE_7429|CUSTOM_FIELD_FIXTURE_7429/);

const harmless = redaction.prepareEgress('log', vectors.harmless);
assert.deepEqual(harmless.payload, vectors.harmless);
assert.equal(harmless.redactionReport.changed, false);
assert.equal(harmless.redactionReport.findingCount, 0);

const legacyFields = {
  accessToken: 'fixture', refresh_token: 'fixture', clientSecret: 'fixture', api_key: 'fixture',
  authorization: 'fixture', password: 'fixture', cookie: 'fixture', privateKey: 'fixture',
  credential: 'fixture', session: 'fixture', vaultKey: 'fixture'
};
const legacyPrepared = redaction.prepareEgress('log', legacyFields);
assert.deepEqual(Object.keys(legacyPrepared.payload).sort(), Object.keys(legacyFields).sort(), 'P09 must retain every legacy field');
assert.ok(Object.values(legacyPrepared.payload).every(value => value === '[REDACTED]'), 'P09 must extend existing audit field semantics');

const attached = {
  value: vectors.payloads.finance,
  provenance: provenanceVectors.envelopes.verifiedFinance
};
const attachedPrepared = redaction.prepareEgress('training-candidate', attached);
assert.deepEqual(attachedPrepared.payload.provenance, attached.provenance, 'P08 labels, evidence IDs, and hashes must survive P09');
assert.equal(attachedPrepared.payload.value.accountId, '[REDACTED]');

assert.throws(() => redaction.verifyPreparedEgress(vectors.payloads.nestedError, 'log'), /missing redaction pass/);
const validHarmlessReport = harmless.redactionReport;
assert.throws(
  () => redaction.verifyPreparedEgress({ payload: vectors.payloads.nestedError, redactionReport: validHarmlessReport }, 'log'),
  /residual sensitive material/
);
assert.throws(
  () => redaction.validateReport({ ...preparedCases.log.redactionReport, matchedValue: 'forbidden' }),
  /invalid/
);
assert.throws(() => redaction.prepareEgress('not-an-egress', {}), /unknown egress/);
assert.throws(() => redaction.prepareEgress('log', {}, { sensitiveValues: ['abc'] }), /bounded unique/);
assert.throws(() => redaction.prepareEgress('log', {}, { sensitiveValues: ['REDACT'] }), /replacement marker/);

const overlap = redaction.prepareEgress('log', { note: 'MySecretToken remains private' }, {
  sensitiveValues: ['SecretToken', 'MySecretToken']
});
assert.equal(overlap.payload.note, '[REDACTED] remains private');
assert.equal(overlap.redactionReport.findingCount, 1);

const unicodeAdjacent = redaction.prepareEgress('provider', {
  value: '\u00e9Bearer TOOLSENABLED_CANARY_UNICODE_BEARER_7429 \u200bTOOLSENABLED_CANARY_ZERO_WIDTH_7429'
});
assert.doesNotMatch(unicodeAdjacent.payload.value, /TOOLSENABLED_CANARY_/);
redaction.verifyPreparedEgress(unicodeAdjacent, 'provider');

const cyclic = {};
cyclic.self = cyclic;
assert.throws(() => redaction.prepareEgress('log', cyclic), /acyclic/);
const shared = { safe: 'shared' };
const dag = redaction.prepareEgress('log', { first: shared, second: shared });
assert.deepEqual(dag.payload, { first: { safe: 'shared' }, second: { safe: 'shared' } });
let deep = {};
let cursor = deep;
for (let index = 0; index < 34; index += 1) {
  cursor.next = {};
  cursor = cursor.next;
}
assert.throws(() => redaction.prepareEgress('log', deep), /depth/);

const canaryKey = { TOOLSENABLED_CANARY_SECRET_KEY_7429: 'safe' };
const canaryKeyPrepared = redaction.prepareEgress('log', canaryKey);
assert.equal(redaction.scanCanaries(canaryKeyPrepared.payload).count, 0);
assert.doesNotMatch(JSON.stringify(canaryKeyPrepared), /TOOLSENABLED_CANARY_SECRET_KEY_7429/);
const collision = redaction.prepareEgress('log', {
  TOOLSENABLED_CANARY_COLLIDING_KEY_7429: 'safe',
  redactedField0: 'preserved'
});
assert.equal(Object.keys(collision.payload).length, 2);
assert.deepEqual(Object.values(collision.payload).sort(), ['preserved', 'safe']);
assert.doesNotMatch(JSON.stringify(collision), /TOOLSENABLED_CANARY_COLLIDING_KEY_7429/);

const javascriptSource = fs.readFileSync(OUTPUTS.javascriptRedaction, 'utf8');
const typescriptSource = fs.readFileSync(OUTPUTS.typescriptRedaction, 'utf8');
const pythonSource = fs.readFileSync(OUTPUTS.toolsEnabledPythonRedaction, 'utf8');
assert.doesNotMatch(javascriptSource, /\\b/);
assert.doesNotMatch(javascriptSource, /^\s*import\s+/m);
assert.doesNotMatch(javascriptSource, /\brequire\s*\(/);
assert.doesNotMatch(javascriptSource, /matchedValue|originalValue|secretValue/);
assert.doesNotMatch(typescriptSource, /(?:from|require)\s*\(?\s*['"][^'"]*(?:app\/markiv|src\/lib|sidecars\/|portfolio dashboard)/i);
assert.doesNotMatch(pythonSource, /\bfrom\s+app\./);
assert.doesNotMatch(pythonSource, /\bimport\s+toolsenabled\b/i);
assert.equal(path.basename(OUTPUTS.toolsEnabledPythonRedaction), 'coordinator_platform_redaction.py');

const pythonProgram = [
  'import json, sys',
  'from pathlib import Path',
  'generated = Path(sys.argv[1])',
  'vectors = json.loads(Path(sys.argv[2]).read_text())',
  'sys.path.insert(0, str(generated))',
  'import coordinator_platform_redaction as redaction',
  'result = {}',
  "result['prepared'] = {item['egress']: redaction.prepare_egress(item['egress'], vectors['payloads'][item['payload']]) for item in vectors['egressCases']}",
  "for item in vectors['egressCases']: redaction.verify_prepared_egress(result['prepared'][item['egress']], item['egress'])",
  "result['patterns'] = redaction.prepare_egress('evidence-export', vectors['payloads']['patternRegistry'])",
  "options = {'sensitiveValues': vectors['customization']['sensitiveValues'], 'sensitiveFieldNames': vectors['customization']['sensitiveFieldNames']}",
  "result['custom'] = redaction.prepare_egress('notification', vectors['payloads']['customUserSensitive'], options)",
  "result['harmless'] = redaction.prepare_egress('log', vectors['harmless'])",
  "result['scans'] = {name: redaction.scan_canaries(payload) for name, payload in vectors['payloads'].items()}",
  'print(json.dumps(result, sort_keys=True))'
].join('\n');
const python = spawnSync(PYTHON, ['-B', '-c', pythonProgram, GENERATED_ROOT, path.join(PACKAGE_ROOT, 'fixtures', 'redaction-vectors.json')], {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true
});
assert.ifError(python.error);
assert.equal(python.status, 0, python.stderr);
const pythonResult = JSON.parse(python.stdout);
assert.deepEqual(pythonResult.prepared, preparedCases);
assert.deepEqual(pythonResult.patterns, patterns);
assert.deepEqual(pythonResult.custom, custom);
assert.deepEqual(pythonResult.harmless, harmless);
for (const item of vectors.egressCases) assert.equal(pythonResult.scans[item.payload].detected, true);

console.log('Unified-agent P09 redaction/canary check passed (six egresses, cross-language residual gate).');
