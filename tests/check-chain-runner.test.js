'use strict';

// Contract tests for the command-line boundary of tools/check-chain-runner.js.
// Keep these as real subprocess calls: the contract being pinned is not merely
// the helper functions' return values, but the observable refusal text and the
// three exit codes presented to npm and CI.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { deleteEnvNames } = require('../src/lib/env-scrub');
const { STRICT_ENV } = require('../tools/lib/test-completion');
const { clearAuthority } = require('../tools/lib/strict-lifecycle-record');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'tools', 'check-chain-runner.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-chain-runner-test-'));
const PASS = [process.execPath, '-e', 'process.exit(0)'];
const FAIL = [process.execPath, '-e', 'process.exit(7)'];

function run(args) {
  // These synthetic fixtures explicitly test the ordinary developer ratchet.
  // Strict inheritance itself is exercised separately by strict-test-lifecycle.
  const environment = deleteEnvNames({ ...clearAuthority(), NO_COLOR: '1' }, [STRICT_ENV]);
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: environment,
    windowsHide: true,
    timeout: 20_000
  });
}

function expect(args, status, pattern, label) {
  const result = run(args);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, status, `${label}\n${output}`);
  assert.match(output, pattern, `${label}\n${output}`);
  return result;
}

function baseline(name, document) {
  const file = path.join(temp, `${name}.json`);
  fs.writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document));
  return file;
}

try {
  // EXIT_OK (0) and EXIT_RATCHET (1) are externally visible verdicts.
  expect(['--name', 'clean-contract', '--strict', '--then', ...PASS], 0, /CHAIN RATCHET: --strict/, 'a clean strict chain exits 0');
  expect(['--name', 'red-contract', '--strict', '--then', ...FAIL], 1, /exit 7[\s\S]*no failure is tolerated/, 'a failed strict chain exits 1');
  expect(
    ['--name', 'skipped-contract', '--strict', '--then', '--id', 'producer', ...FAIL,
      '--then', '--id', 'consumer', '--needs', 'producer', '--why', 'producer creates the input', ...PASS],
    1,
    /consumer -- SKIPPED[\s\S]*prerequisite not met: producer \(FAIL\)/,
    'a refused dependent is named and exits 1'
  );

  // CLI/chain-definition refusals all use EXIT_UNTRUSTED (2).
  const definitionRefusals = [
    { args: [], message: /chain "chain" has no steps/ },
    { args: ['--name', 'x', '--then', '--id', 'same', ...PASS, '--then', '--id', 'same', ...PASS], message: /duplicate step id: same/ },
    { args: ['--name', 'x', '--then', '--id', 'empty'], message: /step "empty" has no command/ },
    { args: ['--name', 'x', '--then', '--id', 'later', '--needs', 'missing', '--why', 'required', ...PASS], message: /needs "missing", which is not an earlier step/ },
    { args: ['--name', 'x', '--then', '--id', 'first', ...PASS, '--then', '--id', 'second', '--needs', 'first', ...PASS], message: /declares needs but no why/ }
  ];
  for (const [index, refusal] of definitionRefusals.entries()) {
    expect(refusal.args, 2, refusal.message, `definition refusal ${index + 1} exits 2`);
  }
  // parseSteps always derives an ID for a non-empty command, so this defensive
  // refusal is reachable only by programmatic callers of the exported API.
  const { validateChain } = require('../tools/check-chain-runner');
  assert.throws(
    () => validateChain('x', [{ id: '', run: PASS, needs: [] }]),
    /step 1 has no id/,
    'the exported validator refuses a step with no ID'
  );
  expect(
    ['--strict', '--update-baseline', '--then', ...PASS],
    2,
    /--strict and --update-baseline are mutually exclusive/,
    'incompatible ruling modes are refused with exit 2'
  );

  // Every malformed-baseline refusal is exercised through the executable.
  const malformed = [
    ['invalid-json', '{', /is not valid JSON/],
    ['array-root', [], /is not a JSON object/],
    ['bad-chains', { chains: [] }, /"chains" field that is not an object/],
    ['no-steps', { chains: { pinned: {} } }, /chain "pinned" has no steps array/],
    ['bad-step', { chains: { pinned: { steps: [null] } } }, /step 1 is not an object/],
    ['no-id', { chains: { pinned: { steps: [{ note: 'reason' }] } } }, /step 1 has no id/],
    ['no-note', { chains: { pinned: { steps: [{ id: 'one' }] } } }, /\("one"\) has no note/],
    ['duplicate', { chains: { pinned: { steps: [{ id: 'one', note: 'a' }, { id: 'one', note: 'b' }] } } }, /duplicates id "one"/]
  ];
  for (const [name, document, message] of malformed) {
    const file = baseline(name, document);
    expect(
      ['--name', 'pinned', '--baseline', file, '--then', ...PASS],
      2,
      new RegExp(`${message.source}[\\s\\S]*Refusing to run a chain whose baseline cannot be read`),
      `malformed baseline refusal ${name} exits 2`
    );
  }

  // Absence is strict, while a valid known failure is the sole tolerated-red case.
  expect(['--name', 'absent', '--baseline', path.join(temp, 'missing.json'), '--then', ...FAIL], 1, /missing record is not permission/, 'a missing baseline does not tolerate failure');
  const known = baseline('known', { chains: { pinned: { steps: [{ id: 'known-red', note: 'fixture failure' }] } } });
  expect(['--name', 'pinned', '--baseline', known, '--then', '--id', 'known-red', ...FAIL], 0, /tolerating 1 KNOWN-FAILING[\s\S]*CHAIN RATCHET OK/, 'a precisely baselined failure exits 0');

  // THE THIRD OUTCOME, and the guard that keeps it from becoming a hole.
  //
  // tests/run-isolated.js exits NON-ZERO whenever any requested file did not
  // pass, declared platform skips included, and says why in its own source: a
  // suite that always skips would otherwise be "indistinguishable from a suite
  // that actually ran and passed". Reading only that exit code, this runner
  // called 35 passes plus 1 declared Windows-only skip a REGRESSION.
  //
  // Driven through a disposable checkout with a STUB tests/run-isolated.js, so
  // what is pinned is the runner's classification of a per-file record -- not
  // the platform of whoever runs this suite. On Windows the real Windows-only
  // suites do not skip at all, and a test that depended on that would assert
  // nothing on half the fleet.
  const isolated = path.join(temp, 'isolated-link');
  for (const file of ['tools/check-chain-runner.js', 'tools/lib/test-completion.js',
    'tools/lib/strict-lifecycle-record.js', 'tests/lib/suite-list.js', 'src/lib/env-scrub.js']) {
    const target = path.join(isolated, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), target);
  }
  fs.writeFileSync(path.join(isolated, 'package.json'), JSON.stringify({ private: true }));
  fs.writeFileSync(path.join(isolated, 'tests', 'run-isolated.js'),
    "'use strict';\n"
    + "const fs = require('node:fs');\n"
    + "const argv = process.argv.slice(2);\n"
    + "const at = argv.indexOf('--summary');\n"
    + "const files = JSON.parse(process.env.FIXTURE_FILES);\n"
    + "if (at >= 0 && process.env.FIXTURE_WITHHOLD_SUMMARY !== '1') {\n"
    + "  fs.writeFileSync(argv[at + 1], JSON.stringify({ requested: files.length, files }));\n"
    + "}\n"
    // The behaviour that caused all this: non-zero whenever anything did not pass.
    + "process.exitCode = files.every(entry => entry.status === 'pass') ? 0 : 1;\n");

  const PASSED = { file: 'tests/alpha.test.js', status: 'pass', exitCode: 0, ms: 1 };
  const WINDOWS_SKIP = { file: 'tests/host-exec-vault-process-budget.test.js', status: 'skip',
    exitCode: null, ms: 0, reason: 'requires Windows to run for real', requiresPlatform: 'win32' };
  const REAL_FAILURE = { file: 'tests/beta.test.js', status: 'fail', exitCode: 1, ms: 1 };
  const UNGATED_SKIP = { file: 'tests/gamma.test.js', status: 'skip', exitCode: null, ms: 0,
    reason: 'requires an explicit opt-in environment variable' };

  function link(files, { strict = false, withholdSummary = false } = {}) {
    return spawnSync(process.execPath,
      [path.join(isolated, 'tools', 'check-chain-runner.js'), '--name', 'link',
        ...(strict ? ['--strict'] : []),
        '--then', '--id', 'orphans-link', 'node', 'tests/run-isolated.js', '--continue', 'tests/alpha.test.js'],
      {
        cwd: isolated,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20_000,
        env: {
          ...deleteEnvNames({ ...clearAuthority(), NO_COLOR: '1' }, [STRICT_ENV]),
          FIXTURE_FILES: JSON.stringify(files),
          ...(withholdSummary ? { FIXTURE_WITHHOLD_SUMMARY: '1' } : {})
        }
      });
  }

  const declaredOnly = link([PASSED, WINDOWS_SKIP]);
  assert.equal(declaredOnly.status, 0, `a link whose only non-pass is a declared platform skip exits 0\n${declaredOnly.stdout}${declaredOnly.stderr}`);
  assert.doesNotMatch(declaredOnly.stdout, /REGRESSION/, 'a declared platform skip is not a regression');
  // The count, the platform and the FILE NAME must all be visible: a skip that
  // names nothing is the silent skip this tree keeps re-finding.
  assert.match(declaredOnly.stdout, /declared-skip: 1 files, platform=win32/, 'the record states its count and platform');
  assert.match(declaredOnly.stdout, /tests\/host-exec-vault-process-budget\.test\.js/, 'the record names the skipped file');

  // THE NEGATIVE. A genuinely failing file in the SAME link, beside that very
  // same declared skip, must still exit 1. Without this the third outcome is
  // just a way to spell "green" over a real failure.
  const withFailure = link([PASSED, WINDOWS_SKIP, REAL_FAILURE]);
  assert.equal(withFailure.status, 1, `a real failure alongside a declared skip still exits 1\n${withFailure.stdout}${withFailure.stderr}`);
  assert.doesNotMatch(withFailure.stdout, /declared-skip/, 'a link containing a real failure is not recorded as a declared skip');

  // An opt-in gate or a missing precondition is an absence somebody CHOSE, not
  // one the platform forced. It must not reach the same exit as a platform gate.
  const ungated = link([PASSED, UNGATED_SKIP]);
  assert.equal(ungated.status, 1, `a skip naming no platform is not tolerated\n${ungated.stdout}${ungated.stderr}`);

  // Absence is not consent: with no record to read, the child's exit code stands.
  const withoutRecord = link([PASSED, WINDOWS_SKIP], { withholdSummary: true });
  assert.equal(withoutRecord.status, 1, `an unreadable per-file record rules on nothing\n${withoutRecord.stdout}${withoutRecord.stderr}`);

  // --strict asks whether this may leave the machine, where a declared skip is
  // missing coverage. The third outcome is deliberately unavailable there.
  const strictDeclared = link([PASSED, WINDOWS_SKIP], { strict: true });
  assert.equal(strictDeclared.status, 1, `--strict tolerates no declared skip\n${strictDeclared.stdout}${strictDeclared.stderr}`);

  // Run npm's real lifecycle in a disposable checkout. The outer strict flag
  // must reach nested chains; each phase executes once on a passing run. This
  // checks the chain flag itself; strict-lifecycle-record separately drives
  // the actual test:strict wrapper with fresh source-bound receipt fixtures.
  const fixture = path.join(temp, 'npm-lifecycle');
  fs.mkdirSync(path.join(fixture, 'tools'), { recursive: true });
  for (const file of ['tools/check-chain-runner.js', 'tools/lib/test-completion.js',
    'tools/lib/strict-lifecycle-record.js', 'tests/lib/suite-list.js', 'src/lib/env-scrub.js']) {
    const target = path.join(fixture, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), target);
  }
  fs.writeFileSync(path.join(fixture, 'record.cjs'),
    "require('node:fs').appendFileSync('phases.txt', process.argv[2] + '\\n');\n"
    + "if (process.env.FIXTURE_FAIL_PHASE === process.argv[2]) process.exitCode = 7;\n");
  const fixtureScripts = Object.fromEntries(['pretest', 'test', 'posttest'].map(phase => [phase,
    `node tools/check-chain-runner.js --name ${phase} --then --id ${phase} node record.cjs ${phase}`]));
  fixtureScripts['test:strict'] = 'node tools/check-chain-runner.js --name outer --strict --then npm run test';
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ private: true, scripts: fixtureScripts }));
  function lifecycle(strict, failedPhase = '') {
    fs.writeFileSync(path.join(fixture, 'phases.txt'), '');
    fs.writeFileSync(path.join(fixture, 'tools', 'check-chain-baseline.json'), JSON.stringify({
      chains: { test: { steps: [{ id: 'test', note: 'fixture known failure' }] } }
    }));
    const script = strict ? fixtureScripts['test:strict'] : 'node tools/check-chain-runner.js --name outer --then npm run test';
    const result = spawnSync(process.execPath, script.split(' ').slice(1), {
      cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 20_000,
      env: { ...deleteEnvNames(clearAuthority(), [STRICT_ENV]), FIXTURE_FAIL_PHASE: failedPhase }
    });
    assert.equal(result.error, undefined);
    return { ...result, phases: fs.readFileSync(path.join(fixture, 'phases.txt'), 'utf8').trim().split('\n') };
  }
  const developer = lifecycle(false, 'test');
  assert.equal(developer.status, 0, developer.stderr + developer.stdout);
  assert.deepEqual(developer.phases, ['pretest', 'test', 'posttest']);
  const strictFailure = lifecycle(true, 'test');
  assert.equal(strictFailure.status, 1, strictFailure.stderr + strictFailure.stdout);
  assert.deepEqual(strictFailure.phases, ['pretest', 'test']);
  assert.doesNotMatch(strictFailure.stdout, /tolerating .*KNOWN-FAILING/);
  const strictPass = lifecycle(true);
  assert.equal(strictPass.status, 0, strictPass.stderr + strictPass.stdout);
  assert.deepEqual(strictPass.phases, ['pretest', 'test', 'posttest']);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write('check-chain-runner contract tests passed\n');
