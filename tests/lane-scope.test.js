// NOTHING FOUND
// testcanfail-tests-lane-scope-test-js
//
// Mutation audit:
// - NOT-FOUND (1): the only assertion loop iterates over an inline, non-empty
//   array of twelve invalid territories; its body cannot be skipped by an empty
//   runtime result.
// - NOT-FOUND (2): no assertion treats a non-zero exit status or a truthy
//   process return as evidence. The spawn double is checked through its captured
//   prompt, environment contract, and options, while its exit code is expected
//   to be exactly zero.
// - NOT-FOUND (3): the try/finally only restores process state and removes the
//   fixture; it has no catch or optional chain that can swallow an assertion.
// - NOT-FOUND (4): spawnImpl mocks the child-process dependency, not buildPrompt,
//   parseArgs, spawnChild, or the lane-scope contract under test.
// - NOT-FOUND (5): this file contains no skip or platform precondition guard.
// - NOT-FOUND (6): expected values are fixed literals rather than values derived
//   by the production implementation under test.
// - PRECONDITION-NOT-MET: mutation runs could not reach this file's assertions
//   because the available Node.js is v20.20.2 and cannot load node:sqlite; this
//   repository requires Node >=22.19.0. Baseline output was:
//   "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite"
//   No product mutation was retained or included in the diff.

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lane = require('../src/lib/agent-lane');
const scopeContract = require('../src/lib/lane-scope');

let assertions = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); assertions += 1; }
function deepEqual(actual, expected, message) { assert.deepEqual(actual, expected, message); assertions += 1; }
function check(value, message) { assert.ok(value, message); assertions += 1; }
function refuses(fn, message, code = 'LANE_SCOPE_INVALID') {
  assert.throws(fn, error => error && error.code === code, message);
  assertions += 1;
}

function baseOptions(root, overrides = {}) {
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  const brief = path.join(worktree, 'brief.md');
  fs.writeFileSync(brief, 'Implement only the bounded fixture.\n', 'utf8');
  return {
    agentId: 'scope-fixture',
    kind: 'test-node',
    role: 'worker',
    tier: 'fixture',
    reportsTo: 'coordinator-sol',
    dispatcher: 'coordinator-sol',
    lane: 'scope-fixture',
    territory: 'src/lib/*.js;tests/**',
    directiveId: 'R1162',
    machineScope: 'local',
    brief,
    worktree,
    consoleLog: path.join(root, 'logs', 'scope-fixture.log'),
    checkpoint: null,
    heartbeatMs: 1000,
    leaseSeconds: 120,
    respawnCount: 0,
    command: process.execPath,
    childArgs: ['-e', 'process.exit(0)'],
    ...overrides
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-scope-test-'));
  const priorTestMode = process.env.TOOLSENABLED_LANE_RUN_TEST;
  process.env.TOOLSENABLED_LANE_RUN_TEST = '1';
  try {
    deepEqual(
      scopeContract.parseTerritory('src/lib/*.js;tests/**'),
      ['src/lib/*.js', 'tests/**'],
      'semicolon is the territory list delimiter'
    );
    deepEqual(
      scopeContract.parseTerritory('tools/gen-*.mjs,public/data/schema/**'),
      ['tools/gen-*.mjs,public/data/schema/**'],
      'the live legacy comma-bearing territory remains one valid entry'
    );
    deepEqual(
      scopeContract.parseTerritory('primary:r1152-progress-fixture'),
      ['primary:r1152-progress-fixture'],
      'the live colon-bearing territory label remains valid'
    );
    deepEqual(
      scopeContract.parseTerritory('docs/design/*.md; .\\tests\\fixtures\\** '),
      ['docs/design/*.md', '.\\tests\\fixtures\\**'],
      'repo-relative globs and both path separators remain valid'
    );

    for (const bad of [
      '', ';', 'src/**;', ';tests/**', 'src/**;;tests/**',
      '/etc/passwd', 'C:\\work\\file.js', 'C:drive-relative.js', '\\\\peer\\share\\file.js',
      '../outside.js', 'src/../outside.js', 'src\\..\\outside.js'
    ]) {
      refuses(() => scopeContract.parseTerritory(bad), `territory must refuse ${JSON.stringify(bad)}`);
    }

    const serialized = scopeContract.serialize({
      directiveId: 'R1162',
      territory: ['src/lib/*.js', 'tests/**'],
      machineScope: 'local'
    });
    deepEqual(scopeContract.parse(serialized), {
      directiveId: 'R1162',
      territory: ['src/lib/*.js', 'tests/**'],
      machineScope: 'local'
    }, 'serialized scope round-trips through the validated env contract');
    refuses(() => scopeContract.parse('{not json'), 'invalid env JSON is refused');
    refuses(() => scopeContract.parse(JSON.stringify({ territory: ['src/**'], machineScope: 'peer' })), 'unknown machine scope is refused');
    refuses(() => scopeContract.parse(JSON.stringify({ territory: ['src/**'], machineScope: 'local', extra: true })), 'unknown contract fields are refused');

    const options = baseOptions(root);
    let onboardingInput = null;
    const onboardingPacket = 'BEGIN TOOLSENABLED DYNAMIC ONBOARDING PACKET v1\nfixture packet\nEND TOOLSENABLED DYNAMIC ONBOARDING PACKET v1\n';
    const prompt = lane.buildPrompt(options, { entries: [] }, {
      buildOnboardingPacket(input) { onboardingInput = input; return onboardingPacket; }
    });
    check(prompt.startsWith('MECHANICAL LANE SCOPE (ENFORCED)\n'), 'mechanical header is prepended before the brief');
    check(prompt.includes('Directive ID: R1162'), 'header names the directive id');
    check(prompt.includes('Exact territory list: ["src/lib/*.js","tests/**"]'), 'header prints the exact parsed territory list');
    check(prompt.includes('Machine scope: local'), 'header names the machine scope');
    check(prompt.includes('Do ONLY what the brief says'), 'header states the directive-only rule');
    check(prompt.includes('LANE-QUESTIONS.md') && prompt.includes('VERDICT: NEEDS_INPUT') && prompt.includes('Never improvise'), 'header states the stop-and-ask protocol');
    check(prompt.includes('Never send, copy, or sync anything to another machine'), 'header states the cross-machine rule');
    check(prompt.indexOf('MECHANICAL LANE SCOPE') < prompt.indexOf(onboardingPacket.trim()), 'scope header precedes dynamic onboarding');
    check(prompt.indexOf(onboardingPacket.trim()) < prompt.indexOf('Implement only the bounded fixture.'), 'dynamic onboarding precedes brief bytes');
    deepEqual(onboardingInput.territory, ['src/lib/*.js', 'tests/**'], 'onboarding receives the validated exact territory');
    equal(onboardingInput.directiveId, 'R1162', 'onboarding receives the immutable directive');
    equal(onboardingInput.identityBinding, 'launcher-bound', 'the enforcing lane labels identity provenance');
    equal(onboardingInput.projectRoot, options.worktree, 'onboarding resolves the child project, not the launcher cwd');
    const customRoleInput = { ...options, role: 'release-captain' };
    lane.buildPrompt(customRoleInput, { entries: [] }, {
      buildOnboardingPacket(input) { onboardingInput = input; return onboardingPacket; }
    });
    equal(onboardingInput.role, 'release-captain', 'the launcher preserves a custom role identity for authoritative resolution');
    equal(onboardingInput.profile, 'agent',
      'the launcher does not translate any role id into an authority-bearing presentation profile');
    refuses(() => lane.buildPrompt(options, { entries: [] }, { buildOnboardingPacket: () => '' }),
      'an agent lane refuses to construct a prompt without onboarding context', 'AGENT_LANE_ONBOARDING_INVALID');

    const brief = options.brief;
    const parsedDefaults = lane.parseArgs([
      '--agent', 'scope-defaults', '--role', 'worker', '--tier', 'fixture',
      '--reports-to', 'coordinator-sol', '--dispatcher', 'coordinator-sol',
      '--lane', 'scope-defaults', '--territory', 'fixture.js', '--brief', brief,
      '--worktree', options.worktree, '--', process.execPath, '-e', 'process.exit(0)'
    ]);
    equal(parsedDefaults.machineScope, 'local', 'machine scope defaults to local');
    equal(parsedDefaults.directiveId, undefined, 'directive id remains optional');
    equal(parsedDefaults.territory, 'fixture.js', 'existing string territory field remains backward compatible');

    const parsedExplicit = lane.parseArgs([
      '--agent', 'scope-explicit', '--role', 'worker', '--tier', 'fixture',
      '--reports-to', 'coordinator-sol', '--dispatcher', 'coordinator-sol',
      '--lane', 'scope-explicit', '--territory', 'src/**;tests/**', '--directive', 'R1162',
      '--machine-scope', 'cross-machine', '--brief', brief, '--worktree', options.worktree,
      '--', process.execPath, '-e', 'process.exit(0)'
    ]);
    equal(parsedExplicit.directiveId, 'R1162', '--directive is retained');
    equal(parsedExplicit.machineScope, 'cross-machine', '--machine-scope accepts the explicit cross-machine grant');
    refuses(() => lane.parseArgs([
      '--agent', 'scope-bad', '--role', 'worker', '--tier', 'fixture',
      '--reports-to', 'coordinator-sol', '--dispatcher', 'coordinator-sol',
      '--lane', 'scope-bad', '--territory', '..\\outside', '--brief', brief,
      '--worktree', options.worktree, '--', process.execPath, '-e', 'process.exit(0)'
    ]), 'parseArgs delegates territory validation to lane-scope');

    let spawnOptions;
    let stdinPrompt = null;
    const spawnImpl = (_command, _args, receivedOptions) => {
      spawnOptions = receivedOptions;
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdin = { end(value) { stdinPrompt = value; } };
      process.nextTick(() => {
        child.emit('spawn');
        process.nextTick(() => child.emit('close', 0, null));
      });
      return child;
    };
    const launched = lane.spawnChild(options, prompt, { spawnImpl });
    await launched.started;
    const result = await launched.result;
    equal(result.exitCode, 0, 'spawn fixture closes normally');
    equal(stdinPrompt, prompt, 'spawn fixture receives the scoped prompt');
    const childScope = scopeContract.parse(spawnOptions.env[scopeContract.ENV_VAR]);
    deepEqual(childScope, {
      directiveId: 'R1162',
      territory: ['src/lib/*.js', 'tests/**'],
      machineScope: 'local'
    }, 'spawnChild injects the serialized scope contract into the child env');
    equal(spawnOptions.env.TOOLSENABLED_ONBOARDING_ALREADY_INJECTED, undefined,
      'an unverified launcher cannot request native-hook suppression');
    equal(spawnOptions.env.TOOLSENABLED_ONBOARDING_PACKET_VERSION, 'toolsenabled.agent-onboarding.v1');
    check(/^[a-f0-9]{64}$/.test(spawnOptions.env.TOOLSENABLED_ONBOARDING_PACKET_HASH), 'launcher propagates a packet hash');
    equal(spawnOptions.env.TOOLSENABLED_ONBOARDING_LAUNCHER_PROVENANCE, 'launcher-bound');
    equal(spawnOptions.windowsHide, true, 'spawn remains hidden');
    equal(spawnOptions.shell, false, 'spawn remains shell-free');

    process.stdout.write(`lane scope: ${assertions} assertions passed\n`);
  } finally {
    if (priorTestMode === undefined) delete process.env.TOOLSENABLED_LANE_RUN_TEST;
    else process.env.TOOLSENABLED_LANE_RUN_TEST = priorTestMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
