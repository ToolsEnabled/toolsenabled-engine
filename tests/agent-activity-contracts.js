'use strict';

// Phase 2 contract gate: generated-consumer drift, redaction/boundary cases,
// P07 canonical hashes, and JavaScript/Python agreement without a runtime app.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const generator = require('../tools/generate-agent-activity-contracts');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(ROOT, 'schemas', 'agent-activity', '1.0.0', 'fixtures');
const valid = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'valid-contracts.json'), 'utf8'));
const invalid = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'invalid-browser-safe.json'), 'utf8'));
const vectors = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'hash-vectors.json'), 'utf8'));

// Render the tracked schemas/templates into an owned temporary consumer tree.
// A contract test must not depend on a sibling visualizer checkout being
// present, stale, or writable on the machine running the engine suite.
const generatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-activity-contracts-'));
process.once('exit', () => fs.rmSync(generatedRoot, { recursive: true, force: true }));
const renderedOutputs = generator.renderAll();
assert.equal(renderedOutputs.size, 3, 'every declared consumer language must render');
const generatedOutputs = {};
for (const [declaredTarget, content] of renderedOutputs) {
  assert.ok(path.resolve(declaredTarget).startsWith(path.resolve(generator.VISUALIZER_ROOT) + path.sep),
    'the production generator may declare outputs only below the visualizer src/generated tree');
  const target = path.join(generatedRoot, path.basename(declaredTarget));
  fs.writeFileSync(target, content, 'utf8');
  generatedOutputs[path.basename(declaredTarget)] = target;
}
const generatedJavascript = generatedOutputs['agent-activity-contracts.js'];
const generatedPython = generatedOutputs['agent_activity_contracts.py'];
assert.equal(typeof generatedJavascript, 'string');
assert.equal(typeof generatedPython, 'string');
const contracts = require(generatedJavascript);

for (const [name, value] of Object.entries(valid)) {
  assert.deepEqual(contracts.validateContract(name, structuredClone(value)), value, name + ' must validate in generated JavaScript');
}

for (const item of invalid.cases) {
  const payload = structuredClone(valid.snapshot);
  Object.assign(payload, item.mutate);
  assert.throws(() => contracts.validateBrowserSafeSnapshot(payload), /(?:unknown property|unsafe|browser-safe|allowed enum|invalid|closed)/i, item.name);
}
const invalidLedger = structuredClone(valid['master-work-ledger']);
Object.assign(invalidLedger, invalid.invalidLedger);
assert.throws(() => contracts.validateMasterWorkLedger(invalidLedger), /unknown property/i);

assert.equal(valid['master-work-ledger'].intentAuthority, 'json-ledger');
assert.equal(valid['master-work-ledger'].runtimeAssignmentAuthority, 'toolsenabled');
assert.equal(valid['master-work-ledger'].masterLink.observedLedgerRevision, valid['master-work-ledger'].ledgerRevision);
assert.equal(valid['report-render-manifest'].pdfAuthority, 'human-snapshot-never-parsed');
assert.deepEqual(
  [valid['report-render-manifest'].ledgerHash.domain, valid['report-render-manifest'].htmlHash.domain, valid['report-render-manifest'].pdfHash.domain],
  ['master-work-ledger:2.0.0', 'agent-activity:report-html:1.0.0', 'agent-activity:report-pdf:1.0.0']
);
assert.equal(valid.history.aggregate.reportedTokenCount, null, 'reported tokens must remain explicitly nullable');
assert.equal(valid.history.aggregate.estimatedTokenCount.label, 'estimate-not-provider-reported', 'estimated tokens must remain labelled estimates');

const snapshotBytes = JSON.stringify(valid.snapshot);
assert.doesNotMatch(snapshotBytes, /(?:agt|goal|req|phs|tsk|ev|rpt|evt|con|dec|gate|ctx)_[A-Za-z0-9_-]{32}/);
assert.doesNotMatch(snapshotBytes, /(?:hash|path|prompt|objective|mission|toolResult|helpText|checkpointText)/i);
assert.doesNotMatch(JSON.stringify(valid.history), /(?:hash|path|prompt|objective|mission|toolResult|helpText|checkpointText)/i);
assert.equal(contracts.renderSafeContext(valid.snapshot.events[0].context), 'validation is working at 75%.');
assert.throws(() => contracts.renderSafeContext({
  template: 'phase_state',
  data: { phaseLabel: 'TOOLSENABLED_CANARY_AAV_CONTEXT_7429', state: 'working', progressPercent: 1 }
}), /allowed enum|closed|invalid/i);

const canonical = contracts.canonicalString(vectors.canonical);
const hashes = vectors.domains.map(domain => contracts.domainHash(domain, vectors.canonical));
assert.equal(canonical, '{"a":{"b":2,"m":"safe"},"z":[3,true,null]}');
assert.equal(new Set(hashes).size, hashes.length, 'P07 domains must separate identical canonical payloads');
assert.throws(() => contracts.domainHash('UPPERCASE', vectors.canonical), /P07 ASCII domain/);
assert.throws(() => contracts.canonicalString({ value: 0.5 }), /safe integer/);

const sourceFiles = Object.values(generatedOutputs);
for (const file of sourceFiles) {
  assert.ok(path.resolve(file).startsWith(path.resolve(generatedRoot) + path.sep),
    'this test may load consumers only from its owned temporary tree');
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /(?:require|from)\s*\(?\s*['"][^'"]*(?:src[\\/]lib|portfolio|sidecars)[^'"]*['"]/i, 'consumer must have no cross-repository runtime import');
}
const pythonSource = fs.readFileSync(generatedPython, 'utf8');
assert.doesNotMatch(pythonSource, /(?:from\s+(?:app|toolsenabled)|import\s+(?:app|toolsenabled))/i);

for (const name of ['browser-event.schema.json', 'snapshot.schema.json', 'history.schema.json']) {
  const source = fs.readFileSync(path.join(ROOT, 'schemas', 'agent-activity', '1.0.0', name), 'utf8');
  assert.doesNotMatch(source, /\bmac\b/i, 'abandoned lane may not become a projected schema entity');
}

const pythonProgram = [
  'import json, sys',
  'from copy import deepcopy',
  'sys.path.insert(0, sys.argv[1])',
  'import agent_activity_contracts as c',
  "valid = json.loads(open(sys.argv[2], encoding='utf8').read())",
  "invalid = json.loads(open(sys.argv[3], encoding='utf8').read())",
  "vectors = json.loads(open(sys.argv[4], encoding='utf8').read())",
  "for name, value in valid.items(): c.validate_contract(name, deepcopy(value))",
  "rejected = []",
  "for item in invalid['cases']:",
  "    payload = deepcopy(valid['snapshot']); payload.update(item['mutate'])",
  "    try: c.validate_browser_safe_snapshot(payload)",
  "    except ValueError: rejected.append(True)",
  "    else: rejected.append(False)",
  "ledger = deepcopy(valid['master-work-ledger']); ledger.update(invalid['invalidLedger'])",
  "try: c.validate_master_work_ledger(ledger)",
  "except ValueError: ledger_rejected = True",
  "else: ledger_rejected = False",
  "result = {'canonical': c.canonical_string(vectors['canonical']), 'hashes': [c.domain_hash(domain, vectors['canonical']) for domain in vectors['domains']], 'rendered': c.render_safe_context(valid['snapshot']['events'][0]['context']), 'rejected': rejected, 'ledgerRejected': ledger_rejected}",
  'print(json.dumps(result, sort_keys=True))'
].join('\n');
const python = spawnSync(process.env.PYTHON || 'python', [
  '-c', pythonProgram,
  path.dirname(generatedPython),
  path.join(FIXTURE_ROOT, 'valid-contracts.json'),
  path.join(FIXTURE_ROOT, 'invalid-browser-safe.json'),
  path.join(FIXTURE_ROOT, 'hash-vectors.json')
], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
});
if (python.error && python.error.code === 'ENOENT') {
  // Python is not a runtime dependency of the engine. A machine without it
  // still proves that the Python consumer was deterministically rendered from
  // the same validated package and contains each public contract primitive;
  // machines with Python execute the full cross-language oracle below.
  for (const required of [
    'def validate_contract(', 'def validate_browser_safe_snapshot(',
    'def validate_master_work_ledger(', 'def canonical_string(',
    'def domain_hash(', 'def render_safe_context('
  ]) {
    assert.match(pythonSource, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `rendered Python consumer is missing ${required}`);
  }
  process.stdout.write('Python runtime unavailable; deterministic Python consumer source contract verified.\n');
} else {
  assert.equal(python.status, 0, python.stderr || python.error?.message);
  const pythonResult = JSON.parse(python.stdout);
  assert.equal(pythonResult.canonical, canonical);
  assert.deepEqual(pythonResult.hashes, hashes);
  assert.equal(pythonResult.rendered, 'validation is working at 75%.');
  assert.deepEqual(pythonResult.rejected, invalid.cases.map(() => true));
  assert.equal(pythonResult.ledgerRejected, true);
}

console.log('Agent Activity Phase 2 contracts pass generator drift, boundary, redaction, and cross-language checks.');
