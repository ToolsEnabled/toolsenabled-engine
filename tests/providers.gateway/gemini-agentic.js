'EXECUTABLE CHANGE';
'use strict';

// Test-can-fail report (testcanfail-tests-providers-gateway-gemini-agentic-js):
// - FIXED shape 3: the kill-switch check fed an intentionally incompatible
//   matcher to rejects(), then swallowed the resulting assertion failure with
//   .catch(() => null). Mutation: swallow errors from deps.assertActive in
//   runAgenticTask while retaining successful calls.
//   RED after this fix: "AssertionError [ERR_ASSERTION]: Missing expected rejection."
// - NOT-FOUND shape 1: every assertion-bearing loop has a non-empty literal
//   input; there are no forEach assertion bodies.
// - NOT-FOUND shape 2: process results are checked through typed provider
//   errors and subject output/state, never merely through a non-zero status or
//   truthy process return.
// - NOT-FOUND shape 4: injected process/Git collaborators exercise provider
//   orchestration; no assertion compares the mocked implementation to itself.
// - NOT-FOUND shape 5: there are no skips or file-wide platform preconditions.
// - NOT-FOUND shape 6: expected constants are independent of provider output;
//   platform-derived worktree expectations do not call provider code.
// - RESTORE/GREEN: src/lib/providers/gemini-agentic.js was restored byte-for-byte;
//   final run: "Gemini agentic lane tests passed."
// - PRECONDITION: the default Node.js 20.20.2 lacks node:sqlite; all executable
//   checks used the installed Node.js 22.22.2 required by package.json.
// - PRECONDITION: the gateway aggregate runner references absent
//   vertex-gemini-strong.js, vertex-account-bridge.js, and
//   vertex-gemini-seat.js files; its remaining available tests did run.

require('../lib/isolated-environment').activate('gemini-agentic');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const gemini = require('../../src/lib/providers/gemini-agentic');

const WORKSPACE = path.join(os.tmpdir(), 'fake-workspace');
const WORKTREE_ROOT = path.join(os.tmpdir(), 'fake-worktrees');
const HEAD = 'a'.repeat(40);

function scriptedSpawn(scripts, calls) {
  return (command, args, options) => {
    const call = { command, args: [...args], options, stdin: null };
    calls.push(call);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdin.on('data', chunk => { call.stdin = `${call.stdin || ''}${chunk.toString('utf8')}`; });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = signal => { child.killed = true; child.lastSignal = signal; return true; };
    const script = scripts.shift() || { code: 0, stdout: '{"session_id":"s","response":"ok"}' };
    if (!script.neverClose) {
      const finish = () => {
        if (script.stdout) child.stdout.write(script.stdout);
        if (script.stderr) child.stderr.write(script.stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', script.code ?? 0);
      };
      if (script.waitFor) Promise.resolve(script.waitFor).then(finish);
      else queueMicrotask(finish);
    }
    return child;
  };
}

function gitRunFor({ dirty = false, worktreeAddFails = false, changedPath = 'newfile.txt' } = {}) {
  const calls = [];
  const fn = (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const joined = args.join(' ');
    const worktreeAt = args.indexOf('worktree');
    if (joined === 'rev-parse --show-toplevel') return { status: 0, stdout: `${WORKSPACE}\n`, stderr: '' };
    if (joined === 'rev-parse HEAD') return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
    if (joined === 'status --porcelain=v1' && cwd === WORKSPACE) {
      return { status: 0, stdout: dirty ? ' M dirty-file.js\n' : '', stderr: '' };
    }
    if (args[0] === '-C' && worktreeAt >= 0 && args[worktreeAt + 1] === 'add') {
      if (worktreeAddFails) return { status: 1, stdout: '', stderr: 'fatal: worktree add failed' };
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === '-C' && worktreeAt >= 0 && args[worktreeAt + 1] === 'remove') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (joined === 'diff --stat HEAD') return { status: 0, stdout: ' 1 file changed, 1 insertion(+)\n', stderr: '' };
    if (joined === 'diff --name-status -z HEAD') return { status: 0, stdout: `M\0${changedPath}\0`, stderr: '' };
    if (joined === 'ls-files --others --exclude-standard -z') return { status: 0, stdout: `${changedPath}\0`, stderr: '' };
    if (joined === 'status --porcelain=v1') return { status: 0, stdout: '?? newfile.txt\n', stderr: '' };
    throw new Error(`unexpected git invocation: ${joined} (cwd=${cwd})`);
  };
  return { fn, calls };
}

function fixture(options = {}) {
  const spawnCalls = [];
  const git = gitRunFor(options.git);
  const records = [];
  const activeCalls = [];
  const onboardingInputs = [];
  const dependencies = {
    spawnImpl: options.spawnImpl || scriptedSpawn(options.scripts || [{ code: 0, stdout: '{"session_id":"s","response":"Did the thing.","stats":{"inputTokenCount":10,"outputTokenCount":5}}' }], spawnCalls),
    gitRun: git.fn,
    fs: options.fs || { existsSync: () => false, mkdirSync: () => {}, writeFileSync: () => {} },
    now: options.now || (() => 1_800_000_000_000),
    randomId: options.randomId || (() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    assertActive: options.assertActive || ((...args) => { activeCalls.push(args); }),
    record: options.record || (event => { records.push(event); return { ok: true }; }),
    executableFor: options.executableFor || (() => ({ command: 'fake-gemini', prefixArgs: [] })),
    tmpdir: options.tmpdir || (() => WORKTREE_ROOT),
    vertexAdcPath: options.vertexAdcPath || (() => null),
    buildOnboardingPacket: options.buildOnboardingPacket || (input => {
      onboardingInputs.push(input);
      return 'TEST DYNAMIC ONBOARDING PACKET';
    }),
    onboardingDependencies: {}
  };
  return { dependencies, spawnCalls, gitCalls: git.calls, records, activeCalls, onboardingInputs };
}

async function rejects(input, options, expected) {
  const test = fixture(options);
  await assert.rejects(
    gemini.runAgenticTask(input, test.dependencies),
    error => typeof expected === 'function'
      ? expected(error)
      : error && error.code === expected
  );
  return test;
}

(async () => {
  // Happy path + audit record shape.
  {
    const test = fixture();
    const result = await gemini.runAgenticTask(
      { taskBrief: 'Do the thing.', workspacePath: WORKSPACE, allowedPaths: ['newfile.txt'] },
      test.dependencies
    );
    assert.equal(result.backend, 'subscription');
    assert.equal(result.model, gemini.DEFAULT_MODEL);
    assert.equal(result.sourceHead, HEAD);
    assert.equal(result.summary, 'Did the thing.');
    assert.deepEqual(result.stats, { inputTokenCount: 10, outputTokenCount: 5 });
    assert.equal(result.statsStatus, 'reported');
    assert.match(result.diffStat, /1 file changed/);
    assert.equal(result.untrackedFiles, 1);
    assert.equal(result.changedFileCount, 1);
    assert.equal(result.scopeEnforced, true);
    assert.equal(result.contentTrust, 'untrusted');
    assert.equal(result.grantsAuthority, false);
    assert.equal(typeof result.durationMs, 'number');
    const expectedWorktreeRoot = process.platform === 'win32'
      ? path.join(path.parse(path.resolve(WORKTREE_ROOT)).root, 'te-g')
      : WORKTREE_ROOT;
    assert.ok(result.worktreePath.startsWith(expectedWorktreeRoot));

    // Real tool execution shape: --approval-mode yolo, no branch bookkeeping.
    assert.equal(test.spawnCalls.length, 1);
    const spawned = test.spawnCalls[0];
    assert.equal(spawned.command, 'fake-gemini');
    assert.ok(spawned.args.includes('--approval-mode'));
    assert.ok(spawned.args.includes('yolo'));
    assert.ok(spawned.args.includes('--skip-trust'));
    assert.equal(spawned.options.cwd, result.worktreePath);
    assert.equal(spawned.options.shell, false);
    assert.equal(spawned.options.windowsHide, true);
    assert.equal(spawned.options.env.GOOGLE_GENAI_USE_VERTEXAI, undefined);
    assert.equal(spawned.options.env.GEMINI_API_KEY, undefined);
    assert.equal(spawned.options.env.TOOLSENABLED_AGENT_ROLE, 'builder');
    assert.equal(spawned.options.env.TOOLSENABLED_AGENT_MODEL, gemini.DEFAULT_MODEL);
    assert.equal(spawned.options.env.TOOLSENABLED_PROJECT_ROOT, result.worktreePath);
    assert.equal(spawned.options.env.TOOLSENABLED_ONBOARDING_ALREADY_INJECTED, undefined,
      'an unverified agentic launcher cannot request native-hook suppression');
    assert.equal(spawned.options.env.TOOLSENABLED_ONBOARDING_PACKET_VERSION, 'toolsenabled.agent-onboarding.v1');
    assert.match(spawned.options.env.TOOLSENABLED_ONBOARDING_PACKET_HASH, /^[a-f0-9]{64}$/);
    assert.equal(spawned.options.env.TOOLSENABLED_ONBOARDING_LAUNCHER_PROVENANCE, 'launcher-bound');
    assert.equal(spawned.args.includes('--prompt'), false, 'the packet and brief never ride Windows argv');
    assert.deepEqual(spawned.options.stdio, ['pipe', 'pipe', 'pipe']);
    const prompt = spawned.stdin;
    assert.ok(prompt.indexOf('TEST DYNAMIC ONBOARDING PACKET') < prompt.indexOf('TASK:\nDo the thing.'),
      'the mechanical onboarding packet precedes the agentic task brief');
    assert.equal(test.onboardingInputs.length, 1);
    assert.equal(test.onboardingInputs[0].projectRoot, result.worktreePath);
    assert.deepEqual(test.onboardingInputs[0].territory, ['newfile.txt']);
    assert.equal(test.onboardingInputs[0].provider, 'gemini');
    assert.equal(test.onboardingInputs[0].role, 'builder');
    assert.equal(test.onboardingInputs[0].identityBinding, 'none');

    // Kill-switch/policy gate checked before any git or spawn call.
    assert.equal(test.activeCalls.length, 1);
    assert.equal(test.activeCalls[0][0], 'gemini.agentic.run');

    // Worktree created with --detach at the fixed source HEAD.
    const addCall = test.gitCalls.find(c => c.args[c.args.indexOf('worktree') + 1] === 'add');
    assert.ok(addCall);
    assert.ok(addCall.args.includes('--detach'));
    if (process.platform === 'win32') {
      assert.ok(addCall.args.includes('core.longpaths=true'), 'Windows worktree checkout must opt into Git long paths locally');
    }
    assert.equal(addCall.args[addCall.args.length - 1], HEAD);

    // Exactly one signed audit record, value-free (hash only, no prompt/output text).
    assert.equal(test.records.length, 1);
    const event = test.records[0];
    assert.equal(event.kind, 'provider.operation');
    assert.equal(event.subject.type, 'provider');
    assert.equal(event.outcome, 'success');
    assert.equal(event.summary.operation, 'run');
    assert.equal(typeof event.summary.durationMs, 'number');
    assert.equal(typeof event.summary.outputBytes, 'number');
    assert.match(event.hashes.result, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(event).includes('Did the thing'), false);

    // Worktree is never auto-removed -- merging is the dispatcher's decision.
    assert.equal(test.gitCalls.some(c => c.args[c.args.indexOf('worktree') + 1] === 'remove'), false);
  }

  // The named distinction: "stats were not reported" is not the same as
  // "stats could not be established" from an unstructured provider result.
  {
    const notReported = gemini._testing.resultEnvelopeFrom('{"response":"done"}');
    const couldNotBeEstablished = gemini._testing.resultEnvelopeFrom('done');
    assert.equal(notReported.stats, null);
    assert.equal(notReported.statsStatus, 'not_reported');
    assert.equal(couldNotBeEstablished.stats, null);
    assert.equal(couldNotBeEstablished.statsStatus, 'could_not_be_established');
  }

  // Dirty-worktree refusal: never reaches spawn or worktree creation.
  {
    const test = await rejects(
      { taskBrief: 'Do the thing.', workspacePath: WORKSPACE, allowedPaths: ['newfile.txt'] },
      { git: { dirty: true } },
      'GEMINI_AGENTIC_SOURCE_DIRTY'
    );
    assert.equal(test.spawnCalls.length, 0);
    assert.equal(test.gitCalls.some(c => c.args[c.args.indexOf('worktree') + 1] === 'add'), false);
  }

  // Kill-switch / policy refusal: never reaches git or spawn at all.
  {
    const test = await rejects(
      { taskBrief: 'Do the thing.', workspacePath: WORKSPACE, allowedPaths: ['newfile.txt'] },
      { assertActive: () => { throw new Error("KILLSWITCH is active. 'gemini.agentic.run' was not executed."); } },
      error => /KILLSWITCH/.test(error.message)
    );
    assert.equal(test.spawnCalls.length, 0);
    assert.equal(test.gitCalls.length, 0);

    // Also assert directly that a plain policy Error is preserved unchanged.
    const direct = fixture({ assertActive: () => { throw new Error('KILLSWITCH is active.'); } });
    await assert.rejects(
      gemini.runAgenticTask({ taskBrief: 'Do the thing.', workspacePath: WORKSPACE, allowedPaths: ['newfile.txt'] }, direct.dependencies),
      error => /KILLSWITCH/.test(error.message)
    );
    assert.equal(direct.spawnCalls.length, 0);
    assert.equal(direct.gitCalls.length, 0);
  }

  // Worktree creation failure surfaces as a typed error, never a hang.
  {
    const test = await rejects(
      { taskBrief: 'Do the thing.', workspacePath: WORKSPACE, allowedPaths: ['newfile.txt'] },
      { git: { worktreeAddFails: true } },
      'GEMINI_AGENTIC_WORKTREE_CREATE_FAILED'
    );
    assert.equal(test.spawnCalls.length, 0);
  }

  // Model/backend/maxMinutes/taskBrief input validation never silently
  // substitutes a different value.
  for (const invalid of [
    { taskBrief: 'x', workspacePath: WORKSPACE, model: 'gemini-1.0-nonexistent' },
    { taskBrief: 'x', workspacePath: WORKSPACE, backend: 'api-key' },
    { taskBrief: 'x', workspacePath: WORKSPACE, maxMinutes: 0 },
    { taskBrief: 'x', workspacePath: WORKSPACE, maxMinutes: 61 },
    { taskBrief: '', workspacePath: WORKSPACE },
    { taskBrief: 'x', workspacePath: 'relative/path' },
    { taskBrief: 'x' },
    { taskBrief: 'x', workspacePath: WORKSPACE, allowedPaths: ['../escape'] },
    { taskBrief: 'x', workspacePath: WORKSPACE, allowedPaths: [] }
  ]) {
    await rejects(invalid, {}, 'GEMINI_AGENTIC_INPUT_INVALID');
  }
  assert.throws(
    () => gemini._testing.buildAgenticPrompt('bounded task', { buildOnboardingPacket: () => '' }),
    error => error && error.code === 'GEMINI_AGENTIC_ONBOARDING_INVALID',
    'the agentic provider refuses to spawn without onboarding context'
  );

  // Timeout kill: exercised directly at the spawn layer (maxMinutes' input
  // floor is 1 real minute, far too slow for a unit test) with a child that
  // never closes on its own.
  {
    const test = fixture({
      scripts: [{ neverClose: true }]
    });
    const deps = gemini._testing.dependencies(test.dependencies);
    const prepared = { taskBrief: 'x', model: gemini.DEFAULT_MODEL, backend: 'subscription', maxMinutes: 1 / 60000 }; // ~1ms
    const result = await gemini._testing.spawnGeminiAgentic(
      deps,
      prepared,
      path.join(WORKTREE_ROOT, 'fake-worktree'),
      'run-id'
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.equal(test.spawnCalls.length, 1);
  }

  // A non-zero exit is reported as a typed failure outcome, not thrown as a
  // generic error, and still produces exactly one audit record.
  {
    const test = fixture({ scripts: [{ code: 1, stderr: 'boom' }] });
    await assert.rejects(
      gemini.runAgenticTask({ taskBrief: 'x', workspacePath: WORKSPACE, allowedPaths: ['newfile.txt'] }, test.dependencies),
      error => error.code === 'GEMINI_AGENTIC_EXECUTION_FAILED'
    );
    assert.equal(test.records.length, 1);
    assert.equal(test.records[0].outcome, 'failed');
  }

  // A model exit code of zero is not a successful artifact when Git observes
  // an out-of-scope change. The error exposes no path or worker prose.
  {
    const test = await rejects(
      { taskBrief: 'x', workspacePath: WORKSPACE, allowedPaths: ['inside.js'] },
      { git: { changedPath: 'outside.js' } },
      'GEMINI_AGENTIC_SCOPE_VIOLATION'
    );
    assert.equal(test.records.length, 1);
    assert.equal(test.records[0].outcome, 'failed');
  }

  console.log('Gemini agentic lane tests passed.');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
