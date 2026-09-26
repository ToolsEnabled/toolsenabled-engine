'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { activate } = require('./lib/isolated-environment');
const { parseSuiteList } = require('./lib/suite-list');
const { STRICT_ENV, OPT_IN_TESTS, validateCompletion } = require('../tools/lib/test-completion');
const { deleteEnvNames } = require('../src/lib/env-scrub');
const { runStrict, strictEnvironment } = require('../tools/test-strict');
const { parseSteps, runChain } = require('../tools/check-chain-runner');
const lifecycleFixture = require('./lib/strict-lifecycle-fixture');

const ROOT = path.resolve(__dirname, '..');
const PEER = 'tests/fixtures/strict-lifecycle-peer.cjs';
const scratch = activate('strict-lifecycle-spec').root;
let serial = 0;
const fixturePath = name => path.join(scratch, `${++serial}-${name}`);
const writeJson = (name, value) => {
  const file = fixturePath(name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};
function childEnvironment(extra = {}) {
  return { ...deleteEnvNames({ ...process.env }, ['NODE_TEST_CONTEXT', STRICT_ENV]), ...extra };
}
function isolated(mode, args = [], strict = true) {
  const summary = fixturePath('summary.json');
  const result = spawnSync(process.execPath, ['tests/run-isolated.js', '--summary', summary, ...args, PEER], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: childEnvironment({ [STRICT_ENV]: strict ? '1' : '0', TOOLSENABLED_STRICT_FIXTURE_MODE: mode })
  });
  assert.equal(result.error, undefined);
  return { ...result, files: JSON.parse(fs.readFileSync(summary, 'utf8')).files };
}

test('strict real node:test completion reconciles nested suites and reports partial skips as UNEXECUTED', () => {
  for (const mode of ['pass', 'partial-skip']) {
    const result = isolated(mode);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.files[0].evidence.kind, 'reconciled-tap');
    assert.equal(result.files[0].evidence.counts.suites, 1);
    assert.equal(result.files[0].evidence.unexecuted, mode === 'partial-skip' ? 1 : 0);
  }
});

for (const mode of ['incomplete', 'zero', 'cancelled', 'todo', 'all-skip', 'standalone-skip', 'standalone-stderr-skip']) {
  test(`strict refuses ${mode} even when no ordinary assertion failed`, () => {
    const result = isolated(mode);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.files[0].status, 'fail');
    assert.ok(result.files[0].evidenceError);
  });
}

test('causal control: premature TAP previously exits zero, strict evidence now refuses it', () => {
  const ordinary = isolated('incomplete', [], false);
  assert.equal(ordinary.status, 0);
  assert.equal(ordinary.files[0].status, 'pass');
  const strict = isolated('incomplete');
  assert.notEqual(strict.status, 0);
  assert.match(strict.files[0].evidenceError, /incomplete TAP/);
});

test('standalone assertions retain process-exit evidence without invented test counts', () => {
  const result = isolated('standalone');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.files[0].evidence, { kind: 'process-exit', counts: null, unexecuted: null });
});

test('a direct check-chain command cannot bypass strict TAP completion', () => {
  const result = spawnSync(process.execPath, ['tools/check-chain-runner.js', '--strict', '--then', 'node', PEER], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
    env: childEnvironment({ TOOLSENABLED_STRICT_FIXTURE_MODE: 'incomplete' })
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /incomplete evidence: incomplete TAP/);
});

test('real failure, timeout and abandoned request remain nonpassing', () => {
  const failed = isolated('fail');
  assert.notEqual(failed.status, 0);
  assert.equal(failed.files[0].evidence.counts.fail, 1);
  const timed = isolated('timeout', ['--timeout-ms', '200']);
  assert.notEqual(timed.status, 0);
  assert.equal(timed.files[0].status, 'timeout');
  const abandoned = isolated('standalone', ['package.json']);
  assert.notEqual(abandoned.status, 0);
  assert.deepEqual(abandoned.files.map(entry => entry.status), ['not-run', 'not-run']);
});

test('TAP evidence rejects count/exit disagreement, duplicate summaries and duplicate ordinals', () => {
  const result = spawnSync(process.execPath, [PEER], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: childEnvironment() });
  assert.equal(validateCompletion(result).counts.pass, 2);
  assert.throws(() => validateCompletion({ ...result, status: 1 }), /disagrees/);
  assert.throws(() => validateCompletion({ ...result, stdout: result.stdout.replace('# pass 2', '# pass 3') }), /counts do not reconcile/);
  assert.throws(() => validateCompletion({ ...result, stdout: result.stdout + '\n# pass 2\n' }), /duplicate TAP/);
  assert.throws(() => validateCompletion({ ...result, stdout: result.stdout.replace(/^ok 1 -/m, 'ok 2 -') }), /sequence/);
  assert.throws(() => validateCompletion({ ...result, stdout: result.stdout.replace('    ok 2 -', '    ok 1 -') }), /sequence/);
  assert.throws(() => validateCompletion({ ...result, stdout: result.stdout.replace('    1..2', '    1..1') }), /plan/);
  assert.throws(() => validateCompletion({ ...result, stdout: result.stdout + '\nBail out! interrupted\n' }), /bail out/);
  assert.throws(() => validateCompletion({ ...result, signal: 'SIGTERM' }), /terminated/);
  assert.throws(() => validateCompletion({ ...result, error: { code: 'ENOBUFS' } }), /ENOBUFS/);
});

test('TAP refuses a missing intermediate parent even when all counts and individual plans agree', () => {
  const stdout = ['TAP version 13', '        ok 1 - child with missing enclosing level', '        1..1',
    'ok 1 - top result', '1..1', '# tests 2', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'].join('\n');
  assert.throws(() => validateCompletion({ status: 0, stdout }), /parent/);
});

test('TAP reconciles real two-level nesting but refuses malformed result/plan and nested bailout', () => {
  const result = spawnSync(process.execPath, [PEER], { cwd: ROOT, encoding: 'utf8', windowsHide: true,
    env: childEnvironment({ TOOLSENABLED_STRICT_FIXTURE_MODE: 'nested' }) });
  assert.equal(validateCompletion(result).counts.suites, 2);
  assert.equal(validateCompletion(result).counts.pass, 2);
  assert.throws(() => validateCompletion({ ...result, stdout: result.stdout + '\n    Bail out! unfinished\n' }), /bail out/);
  assert.throws(() => validateCompletion({ ...result, stdout: result.stdout + '\n    ok without ordinal\n' }), /malformed/);
  assert.throws(() => validateCompletion({ ...result, stdout: result.stdout + '\n    2..3\n' }), /malformed/);
});

test('explicit and inherited strict reject a nested baselined failure; inherited updates refuse without writes', () => {
  const baseline = writeJson('chain.json', { chains: { fixture: { steps: [{ id: 'known-red', note: 'synthetic failure' }] } } });
  const env = childEnvironment({ TOOLSENABLED_STRICT_FIXTURE_MODE: 'nested-chain', TOOLSENABLED_STRICT_FIXTURE_BASELINE: baseline });
  const runner = 'tools/check-chain-runner.js';
  const args = [runner, '--name', 'outer', '--then', 'node', PEER];
  const control = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', windowsHide: true });
  assert.equal(control.status, 0, control.stdout + control.stderr);
  for (const explicit of [false, true]) {
    const command = explicit ? [runner, '--strict', ...args.slice(1)] : args;
    const result = spawnSync(process.execPath, command, { cwd: ROOT, env: { ...env, ...(explicit ? {} : { [STRICT_ENV]: '1' }) }, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /tolerating 1 KNOWN/);
  }
  const before = fs.readFileSync(baseline);
  const update = spawnSync(process.execPath, [runner, '--name', 'fixture', '--baseline', baseline, '--update-baseline', '--then', 'node', PEER], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, env: { ...env, [STRICT_ENV]: '1' }
  });
  assert.equal(update.status, 2);
  assert.match(update.stderr, /mutually exclusive/);
  assert.deepEqual(fs.readFileSync(baseline), before);
});

test('programmatic strict crosses a real nested npm boundary', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(scratch, 'npm-chain-'));
  const baseline = writeJson('nested.json', { chains: { fixture: { steps: [{ id: 'known-red', note: 'synthetic failure' }] } } });
  fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ scripts: { 'test:fixture': `node "${path.join(ROOT, PEER)}"` } }));
  const previousMode = process.env.TOOLSENABLED_STRICT_FIXTURE_MODE;
  const previousBaseline = process.env.TOOLSENABLED_STRICT_FIXTURE_BASELINE;
  process.env.TOOLSENABLED_STRICT_FIXTURE_MODE = 'nested-chain';
  process.env.TOOLSENABLED_STRICT_FIXTURE_BASELINE = baseline;
  try {
    const result = runChain([{ id: 'npm-child', npm: 'test:fixture', needs: [] }], { cwd: fixtureRoot, strict: true, log: () => {} });
    assert.equal(result.failed.length, 1);
  } finally {
    if (previousMode === undefined) delete process.env.TOOLSENABLED_STRICT_FIXTURE_MODE;
    else process.env.TOOLSENABLED_STRICT_FIXTURE_MODE = previousMode;
    if (previousBaseline === undefined) delete process.env.TOOLSENABLED_STRICT_FIXTURE_BASELINE;
    else process.env.TOOLSENABLED_STRICT_FIXTURE_BASELINE = previousBaseline;
  }
});

test('strict wrapper runs actual nested npm pre/test/post hooks and keeps failure nonpassing', t => {
  const setup = lifecycleFixture.fixture(t);
  for (const failStage of ['', 'pretest']) {
    const stages = fixturePath('stages.txt');
    const code = runStrict({ root: setup.root, temporaryRoot: setup.directory, spawn: lifecycleFixture.captureSpawn, environment: childEnvironment({
      NPM_CONFIG_IGNORE_SCRIPTS: 'true', TOOLSENABLED_STRICT_FIXTURE_STAGES: stages,
      TOOLSENABLED_STRICT_FIXTURE_FAIL_STAGE: failStage
    }) });
    assert.equal(code, failStage ? 1 : 0);
    assert.deepEqual(fs.readFileSync(stages, 'utf8').trim().split('\n'), failStage ? ['pretest']
      : ['pretest', 'pretest:inner', 'posttest:inner', 'posttest']);
  }
});

test('strict environment isolates direct lifecycle state and scrubs ambient provider credentials', () => {
  const environment = strictEnvironment(fixturePath('environment'), {
    anthropic_api_key: 'synthetic-not-a-secret', OPENAI_API_KEY: 'synthetic-not-a-secret',
    NODE_TEST_CONTEXT: 'child-v8', NODE_OPTIONS: '--require not-a-real-path', NPM_CONFIG_IGNORE_SCRIPTS: 'true'
  });
  assert.equal(environment.anthropic_api_key, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.NODE_TEST_CONTEXT, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.NPM_CONFIG_IGNORE_SCRIPTS, undefined);
  assert.equal(environment.npm_config_ignore_scripts, 'false');
  assert.equal(environment[STRICT_ENV], '1');
  for (const key of ['TOOLSENABLED_STATE_ROOT', 'TOOLSENABLED_VAULT_PATH', 'TOOLSENABLED_OWNER_LEDGER_FILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    assert.ok(environment[key].startsWith(scratch + path.sep), key);
  }
});

test('the five declared opt-ins are preserved, outside normal recursive npm selection, and refused under strict even with opt-in flags', () => {
  // Independent inventory: deriving the expected refusals solely from the
  // subject's list would let a dropped opt-in silently lose this protection.
  const expectedOptIns = [
    ['tests/agent-engine/claude-live-turn.js', 'test:agent-engine:live'],
    ['tests/agent-engine/codex-live-turn.js', 'test:agent-engine:live'],
    ['tests/intent-fidelity-live.js', 'test:intent-fidelity:live'],
    ['tests/scheduler-windows-mutation.js', 'test:scheduler:mutation'],
    ['tests/scheduler-windows-legacy-mutation.js', 'test:scheduler:mutation']
  ];
  assert.deepEqual(OPT_IN_TESTS.map(entry => [entry.file, entry.script]), expectedOptIns);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const visited = new Set();
  const files = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    for (const hook of [`pre${name}`, `post${name}`]) if (pkg.scripts[hook]) visit(hook);
    const command = pkg.scripts[name];
    assert.ok(command, name);
    const args = command.split(/\s+/);
    for (const value of args) if (/^tests\/.*\.[cm]?js$/.test(value)) files.add(value);
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--from') for (const entry of parseSuiteList(fs.readFileSync(path.join(ROOT, args[++index]), 'utf8'))) files.add(entry);
    }
    if (command.startsWith('node tools/check-chain-runner.js ')) {
      for (const step of parseSteps(args.slice(2))) if (step.npm) visit(step.npm);
    }
  }
  visit('test');
  for (const entry of OPT_IN_TESTS) {
    assert.equal(files.has(entry.file), false, entry.file);
    assert.ok(pkg.scripts[entry.script].includes(entry.file), entry.script);
  }
  for (const file of ['tests/agent-engine/root-admission.test.js', 'tests/owner-host-root-assertion.test.js', 'tests/hidden-spawn-root-guard.test.js']) assert.ok(files.has(file), file);
  const result = spawnSync(process.execPath, ['tests/run-isolated.js', ...OPT_IN_TESTS.map(entry => entry.file)], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
    env: childEnvironment({ [STRICT_ENV]: '1', TOOLSENABLED_WINDOWS_SCHEDULER_MUTATION_SMOKE: '1', TOOLSENABLED_WINDOWS_SCHEDULER_LEGACY_MUTATION_SMOKE: '1' })
  });
  assert.equal(result.status, 1);
  const refusedFiles = [...result.stderr.matchAll(/^UNEXECUTED \(strict scope refusal\): (.+) -- /gm)].map(match => match[1]);
  assert.deepEqual(refusedFiles, expectedOptIns.map(([file]) => file), 'each declared opt-in is refused exactly once');
});

test('strict file ratchet refuses known failures/skips, updates and undeclared census execution', () => {
  for (const status of ['fail', 'skip']) {
    const baseline = writeJson('file-baseline.json', { knownFailures: [{ file: 'tests/synthetic.js', status, note: 'synthetic nonpass' }] });
    const summary = writeJson('file-summary.json', {
      complete: true, completedBatches: 1, totalBatches: 1,
      totals: { requested: 1, total: 1, passed: 0, failed: status === 'fail' ? 1 : 0, skipped: status === 'skip' ? 1 : 0,
        timedOut: 0, configMutation: 0, notRun: 0, noRecord: 0, other: 0 }, files: [{ file: 'tests/synthetic.js', status }]
    });
    const args = ['tools/test-ratchet.mjs', '--baseline', baseline, '--from-summary', summary];
    const control = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: childEnvironment() });
    assert.equal(control.status, 0, control.stdout + control.stderr);
    const strict = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: childEnvironment({ [STRICT_ENV]: '1' }) });
    assert.equal(strict.status, 2, strict.stdout + strict.stderr);
    assert.match(strict.stderr, /no matching source\/selection-bound summary producer/);
    const before = fs.readFileSync(baseline);
    const update = spawnSync(process.execPath, [...args, '--update'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: childEnvironment({ [STRICT_ENV]: '1' }) });
    assert.equal(update.status, 2);
    assert.deepEqual(fs.readFileSync(baseline), before);
  }
  const result = spawnSync(process.execPath, ['tools/test-ratchet.mjs'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: childEnvironment({ [STRICT_ENV]: '1' }) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /will not launch a census run/);
  const baseline = writeJson('clean-baseline.json', { knownFailures: [] });
  const summary = writeJson('unrelated-clean-summary.json', { complete: true, generatedAt: new Date().toISOString(),
    completedBatches: 1, totalBatches: 1,
    totals: { requested: 1, total: 1, passed: 1, failed: 0, skipped: 0, timedOut: 0, configMutation: 0, notRun: 0, noRecord: 0, other: 0 },
    files: [{ file: 'tests/unrelated.js', status: 'pass' }] });
  const unrelated = spawnSync(process.execPath, ['tools/test-ratchet.mjs', '--baseline', baseline, '--from-summary', summary, '--max-age-hours', '24'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, env: childEnvironment({ [STRICT_ENV]: '1' })
  });
  assert.equal(unrelated.status, 2);
  assert.match(unrelated.stderr, /no matching source\/selection-bound summary producer/);
});
