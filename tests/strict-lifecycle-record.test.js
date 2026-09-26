'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const records = require('../tools/lib/strict-lifecycle-record');
const { runStrict } = require('../tools/test-strict');
const { parseSteps } = require('../tools/check-chain-runner');
const { parseSuiteList } = require('./lib/suite-list');
const { fixture, environment, captureSpawn } = require('./lib/strict-lifecycle-fixture');
const ROOT = path.resolve(__dirname, '..');

function run(setup, extra = {}) {
  const code = runStrict({ root: setup.root, temporaryRoot: setup.directory, spawn: captureSpawn,
    environment: environment({ TOOLSENABLED_STRICT_FIXTURE_STAGES: setup.stages, ...extra }) });
  const directories = fs.readdirSync(setup.directory).filter(name => name.startsWith('te-strict-'));
  assert.equal(directories.length, 1);
  const directory = path.join(setup.directory, directories[0]);
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'strict-lifecycle.json'), 'utf8'));
  const contractFile = path.join(directory, 'proof', 'contract.json');
  const bytes = fs.readFileSync(contractFile, 'utf8');
  const context = { directory: path.dirname(contractFile), contract: JSON.parse(bytes), contractDigest: records.digest(bytes) };
  return { code, report, context };
}

test('real npm receipts bind nested hooks, exact duplicate file occurrences and terminal completion', t => {
  const setup = fixture(t);
  const { code, report, context } = run(setup);
  assert.equal(code, 0);
  assert.equal(report.completed, true);
  assert.equal(report.npm.exitCode, 0);
  assert.equal(report.evidence.terminal, true);
  assert.equal(report.evidence.mandatoryFileOccurrences, 3);
  const duplicates = report.evidence.files.filter(file => file.file === 'tests/pass.test.cjs');
  assert.equal(duplicates.length, 2);
  assert.notEqual(duplicates[0].id, duplicates[1].id);
  assert.equal(duplicates[0].sha256, duplicates[1].sha256);
  assert.equal(duplicates[0].result.evidence.counts.pass, 1);
  assert.equal(duplicates[0].result.process.exitCode, 0);
  assert.deepEqual(report.outsideProof.map(entry => entry.status), ['UNEXECUTED', 'UNEXECUTED', 'UNEXECUTED', 'UNEXECUTED', 'UNEXECUTED', 'UNIMPLEMENTED']);
  assert.equal(report.outsideProof.find(entry => entry.file === 'tests/intent-fidelity-live.js').script,
    'test:intent-fidelity:live');
  assert.match(report.outsideProof.at(-1).coverage, /No key-custody coverage/);
  assert.deepEqual(records.verify(context, { terminal: true }), report.evidence);

  const leaf = context.contract.recipe.nodes.find(node => node.kind === 'file');
  const filename = path.join(context.directory, 'receipts', `${records.digest(leaf.id)}-end.json`);
  const original = fs.readFileSync(filename, 'utf8');
  const mutate = (callback, expected) => {
    const changed = JSON.parse(original);
    callback(changed);
    fs.writeFileSync(filename, JSON.stringify(changed));
    assert.throws(() => records.verify(context, { terminal: true }), expected);
    fs.writeFileSync(filename, original);
  };
  mutate(receipt => { receipt.runId = 'another-run'; }, /foreign/);
  mutate(receipt => { receipt.source.head = '0'.repeat(40); }, /old-source/);
  mutate(receipt => { receipt.id = 'undeclared'; }, /foreign/);
  mutate(receipt => { receipt.result = { status: 'pass', exitCode: 0 }; }, /own actual terminal/);
  mutate(receipt => { receipt.result.status = 'skip'; }, /nonpassing/);
  mutate(receipt => { receipt.result.process.exitCode = 7; }, /own actual terminal/);
  const copy = path.join(context.directory, 'receipts', 'duplicate.json');
  fs.writeFileSync(copy, original);
  assert.throws(() => records.verify(context, { terminal: true }), /duplicate/);
  fs.unlinkSync(copy);
  fs.unlinkSync(filename);
  assert.throws(() => records.verify(context, { terminal: true }), /missing strict terminal/);
  fs.writeFileSync(filename, original);
  const sourceFile = path.join(setup.root, leaf.file);
  const source = fs.readFileSync(sourceFile);
  fs.appendFileSync(sourceFile, '\n// uncommitted drift\n');
  assert.throws(() => records.verify(context, { terminal: true }), /drift/);
  fs.writeFileSync(sourceFile, source);
  setup.write('tests/extra.cjs', '// newly committed source\n');
  setup.commit();
  assert.throws(() => records.verify(context, { terminal: true }), /drifted/);
});

test('metadata completion cannot override actual npm terminal failure', t => {
  const setup = fixture(t);
  // Deliberately make this fixture's real final chain terminate unsuccessfully
  // AFTER writing its usual envelope. The outer observer must still refuse.
  const runner = fs.readFileSync(path.join(setup.root, 'tools/check-chain-runner.js'), 'utf8');
  setup.write('tools/check-chain-runner.js', runner
    + "\nif (require.main === module && process.env.npm_lifecycle_event === 'posttest') process.exitCode = 9;\n");
  setup.commit();
  const { code, report } = run(setup);
  assert.equal(code, 9);
  assert.equal(report.npm.exitCode, 9);
  assert.equal(report.completed, false);
  assert.equal(report.evidence, undefined);
});

test('complete actual recipe reaches native custody once and binds both leaf inputs without inventing execution', () => {
  const recipe = records.buildRecipe(ROOT);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = recipe.nodes.filter(node => node.kind === 'file').map(node => node.file);
  assert.ok(files.length > 0);
  assert.equal(recipe.nodes.filter(node => node.kind === 'verifier').length, 1);
  assert.ok(recipe.verifier.startsWith('npm:test/phase:posttest/'));
  assert.deepEqual(recipe.retired, []);
  assert.equal(recipe.nodes.filter(node => node.kind === 'npm' && node.name === 'test:key-custody').length, 1);
  const dispatch = recipe.nodes.filter(node => node.kind === 'command' && node.file === 'tests/key-custody/run.js');
  assert.equal(dispatch.length, 1);
  assert.ok(dispatch[0].id.includes('/step:key-custody/phase:test%3Akey-custody/'));
  for (const file of ['tests/linux-vault.test.js', 'tests/vault-native.test.js']) {
    assert.equal(files.includes(file), false, 'a dispatched leaf is not another direct execution occurrence');
    assert.deepEqual(recipe.inputs.find(input => input.file === file), records.fileIdentity(ROOT, file));
  }
  for (const file of ['tests/agent-engine/root-admission.test.js', 'tests/owner-host-root-assertion.test.js',
    'tests/hidden-spawn-root-guard.test.js', 'tests/strict-test-lifecycle.test.js', 'tests/strict-lifecycle-record.test.js',
    'tests/linux-keyring-fixture-root.test.js', 'tests/key-custody-dispatch.test.js']) assert.ok(files.includes(file), file);
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/check-chain-baseline.json'), 'utf8'));
  const testSteps = parseSteps(pkg.scripts.test.split(/\s+/).slice(2)).map(step => step.id);
  assert.equal(testSteps.filter(id => id === 'key-custody').length, 1);
  assert.ok(!testSteps.includes('test-ratchet'));
  assert.equal(parseSteps(pkg.scripts.posttest.split(/\s+/).slice(2)).at(-1).id, 'test-ratchet');
  assert.ok(!baseline.chains.test.steps.some(step => ['key-custody', 'test-ratchet'].includes(step.id)));
  assert.deepEqual(baseline.chains.posttest.steps, [{ id: 'test-ratchet', status: 'FAIL',
    note: 'Required current-install test measurement is absent; the ratchet refuses to rule.' }]);
  const empty = spawnSync(process.execPath, ['tests/run-isolated.js'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: environment() });
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /Usage:/);
});

test('populated retired alias, premature verifier, recursive or uninstrumented npm phase refuse before spawn', t => {
  const setup = fixture(t);
  const change = (callback, expected) => {
    const scripts = { ...setup.scripts };
    callback(scripts);
    setup.write('package.json', JSON.stringify({ scripts }));
    assert.throws(() => records.buildRecipe(setup.root), expected);
  };
  change(scripts => { scripts['test:key-custody'] += ' tests/pass.test.cjs'; }, /populated/);
  change(scripts => { scripts.posttest += ' --then --id too-late node tests/stage.cjs too-late'; }, /last in posttest/);
  change(scripts => { scripts['test:inner'] = 'node tools/check-chain-runner.js --then npm run test'; }, /recursive/);
  change(scripts => { scripts['pretest:inner'] = 'node tests/stage.cjs pretest:inner'; }, /instrumented/);
  change(scripts => { scripts.pretest += ' --list'; }, /non-executing/);
  setup.write('package.json', JSON.stringify({ private: true, scripts: setup.scripts }));
  assert.throws(() => records.verify(null), /no matching/);
});

test('default recipe invokes state concurrency parents without invoking their worker protocols as tests', () => {
  const files = records.buildRecipe(ROOT).nodes.filter(node => node.kind === 'file').map(node => node.file);
  for (const [parent, worker] of [
    ['tests/kernel.state/state-concurrency.js', 'tests/kernel.state/state-concurrency-worker.js'],
    ['tests/kernel.state/task-concurrency.js', 'tests/kernel.state/task-worker.js']
  ]) {
    assert.ok(files.includes(parent), `${parent} must remain in the actual default recipe`);
    assert.ok(!files.includes(worker), `${worker} requires the parent's database, mode and coordination arguments`);
    assert.ok(fs.statSync(path.join(ROOT, worker)).isFile(), `${worker} remains a measured child input`);
  }
});

test('array-runner migration preserves every previously declared adversarial/protocol test', () => {
  const expected = {
    adversarial: ['controller-launch-scope-adversarial.js', 'coordinator-backup-age-status-adversarial.test.js',
      'coordinator-backup-observer-adversarial.test.js', 'coordinator-backup-test-writer-adversarial.test.js',
      'owner-identity-purpose-gate-adversarial-g9.js', 'owner-identity-reader-audit-adversarial-g9.js',
      'owner-ledger-gate-batch-adversarial-g8.js', 'owner-request-scope-adversarial.js',
      'owner-request-scope-store-adversarial.js', 'package-check-adversarial-g8.js', 'package-manifest-contract-adversarial.js'],
    'repo-protocol': ['repo-protocol/build-queue-corpus.js', 'repo-protocol/build-queue-migration.js',
      'test-census.test.js', 'test-ratchet.test.js', 'naming-ratchet.test.js', 'invocation-guard.test.js',
      'repo-sync.test.js', 'repo-sync-status.test.js']
  };
  const recipe = records.buildRecipe(ROOT);
  for (const [name, previous] of Object.entries(expected)) {
    const list = parseSuiteList(fs.readFileSync(path.join(ROOT, 'tests/suites', `${name}.txt`), 'utf8'));
    assert.deepEqual(list, previous.map(file => `tests/${file}`));
    const selected = recipe.nodes.find(node => node.kind === 'isolated' && node.argv.includes(`tests/suites/${name}.txt`));
    assert.deepEqual(selected.files, list);
    // This integrated recipe runs the assertion guards through root-suite.
    // Keep proving their execution without requiring a duplicate invocation.
    for (const file of ['tests/builtin-assertion-evidence.test.js', 'tests/builtin-assertion-scope.test.js']) {
      assert.ok(recipe.nodes.some(node => node.kind === 'file' && node.file === file), `${file} must remain in the actual default recipe`);
    }
  }
});
