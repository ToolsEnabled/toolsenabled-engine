// EXECUTABLE CHANGE
// Can-fail audit:
// - SAME-CODE EXPECTATION: the exported verdict limit and withheld-placeholder
//   assertions used product exports as their expected values. Mutating those
//   exports with their implementations left all 23 assertions green. They now
//   assert the independently specified literals below.
// - NOT-FOUND: empty loop/forEach assertion bodies; exit-status-only or
//   truthy-return assertions; swallowed failures via try/catch or optional
//   chaining; mocks of verdict normalization; skip/platform precondition
//   guards. fakeClaudeSpawn replaces the child process, not the normalization
//   subject, and its output is checked against an independent literal.
// - Mutation runs and quoted RED output are recorded beside the strengthened
//   assertions. The source mutation was restored byte-for-byte before the
//   final green run.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lane = require('../src/lib/agent-lane');
const presence = require('../src/lib/agent-presence');
const tasks = require('../src/lib/providers/tasks');
const { createStateStore } = require('../src/lib/state-store');

let assertions = 0;
function check(value, message) { assert.ok(value, message); assertions += 1; }
function equal(actual, expected, message) { assert.equal(actual, expected, message); assertions += 1; }

function optionsFor(root, agentId, command, childArgs, kind) {
  const worktree = path.join(root, `${agentId}-worktree`);
  fs.mkdirSync(worktree, { recursive: true });
  const brief = path.join(worktree, 'brief.md');
  fs.writeFileSync(brief, 'Run only the bounded verdict fixture.\n', 'utf8');
  return {
    agentId,
    kind,
    role: 'worker',
    tier: 'fixture',
    reportsTo: 'coordinator-sol',
    dispatcher: 'coordinator-sol',
    lane: 'verdict-normalization-fixture',
    territory: 'fixture-only',
    brief,
    worktree,
    consoleLog: path.join(root, 'logs', `${agentId}.log`),
    checkpoint: null,
    heartbeatMs: 1000,
    leaseSeconds: 120,
    respawnCount: 0,
    command,
    childArgs
  };
}

async function runFixture(root, options, runId, extraDependencies = {}) {
  const state = createStateStore({
    file: path.join(root, `${options.agentId}-tasks.sqlite3`),
    ownerId: `verdict-test-${options.agentId}`,
    clock: () => Date.UTC(2026, 7, 6, 12, 0, 0)
  });
  const taskDependencies = { state, auditRecord: () => {} };
  try {
    const result = await lane.runLane(options, {
      stateFile: path.join(root, `${options.agentId}-presence.json`),
      mailboxDir: path.join(root, 'mailbox'),
      launchDir: path.join(root, 'launch'),
      taskDependencies,
      runId,
      ...extraDependencies
    });
    const task = await tasks.get({ taskId: result.taskId }, taskDependencies);
    const registryText = fs.readFileSync(path.join(root, `${options.agentId}-presence.json`), 'utf8');
    return { result, task, registryText, taskText: JSON.stringify(task) };
  } finally {
    state.close();
  }
}

function fakeClaudeSpawn(output) {
  return (_command, _args, spawnOptions) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdin = { end: () => {} };
    fs.writeSync(spawnOptions.stdio[1], output, null, 'utf8');
    process.nextTick(() => {
      child.emit('spawn');
      process.nextTick(() => child.emit('close', 0, null));
    });
    return child;
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lane-verdict-'));
  const priorTestMode = process.env.TOOLSENABLED_LANE_RUN_TEST;
  process.env.TOOLSENABLED_LANE_RUN_TEST = '1';
  try {
    const safeLine = 'VERDICT: already safe';
    equal(lane.normalizeTerminalVerdict(safeLine), safeLine, 'safe one-line verdict remains byte-for-byte unchanged');
    const boundedLongLine = lane.normalizeTerminalVerdict(`VERDICT: ${'x'.repeat(5000)}`);
    // Mutation: MAX_TERMINAL_VERDICT_CHARS 4096 -> 4097.
    // RED: "AssertionError [ERR_ASSERTION]: long verdict is bounded at the presence limit\n\n4097 !== 4096"
    equal(boundedLongLine.length, 4096, 'long verdict is bounded at the presence limit');
    check(boundedLongLine.endsWith('...'), 'bounded verdict makes truncation explicit');
    equal(
      lane.extractVerdict('noise\n## VERDICT\nFirst result.\nSecond result.\n## EVIDENCE\nignored\n'),
      '## VERDICT\nFirst result.\nSecond result.',
      'public Markdown extraction remains multiline'
    );

    const markdownFixture = path.join(root, 'markdown-child.js');
    fs.writeFileSync(markdownFixture, [
      "console.log('fixture prelude');",
      "console.log('## VERDICT');",
      "console.log('Completed scoped change.');",
      "console.log('Preserved the full report artifact.');",
      "console.log('## EVIDENCE');",
      "console.log('fixture evidence');"
    ].join('\n'), 'utf8');
    const markdown = await runFixture(
      root,
      optionsFor(root, 'markdown-fixture', process.execPath, [markdownFixture], 'test-node'),
      '11111111-1111-4111-8111-111111111111'
    );
    equal(markdown.result.terminal.status, 'finished', 'multiline child exit zero terminalizes presence as finished');
    equal(markdown.result.terminal.exitCode, 0, 'multiline child exit code remains zero');
    equal(
      markdown.result.terminal.lastVerdict,
      'VERDICT: Completed scoped change. Preserved the full report artifact.',
      'Markdown verdict becomes a compact semantic line'
    );
    check(!/[\r\n]/.test(markdown.result.terminal.lastVerdict), 'terminal verdict is one physical line');
    check(markdown.result.terminal.lastVerdict.length <= lane.MAX_TERMINAL_VERDICT_CHARS, 'terminal verdict respects the presence limit');
    equal(markdown.task.status, 'succeeded', 'multiline fixture durably completes its task');
    equal(markdown.task.result.verdict, markdown.result.terminal.lastVerdict, 'durable task stores the same compact verdict');

    const secretMarker = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
    const secretFixture = path.join(root, 'secret-child.js');
    fs.writeFileSync(secretFixture, [
      "console.log('## VERDICT');",
      `console.log(${JSON.stringify(`Completed work but emitted ${secretMarker}`)});`,
      "console.log('## EVIDENCE');"
    ].join('\n'), 'utf8');
    const secret = await runFixture(
      root,
      optionsFor(root, 'secret-fixture', process.execPath, [secretFixture], 'test-node'),
      '22222222-2222-4222-8222-222222222222'
    );
    equal(secret.result.terminal.status, 'finished', 'secret-shaped verdict cannot strand terminal presence');
    equal(secret.task.status, 'succeeded', 'secret-shaped verdict cannot strand durable completion');
    // Mutation: WITHHELD_TERMINAL_VERDICT -> "VERDICT: deliberately mutated safe placeholder.".
    // RED: "AssertionError [ERR_ASSERTION]: secret-shaped verdict uses the fixed safe placeholder"
    const expectedWithheldVerdict = 'VERDICT: terminal verdict unavailable in state; review the full console/report artifact.';
    equal(secret.result.terminal.lastVerdict, expectedWithheldVerdict, 'secret-shaped verdict uses the fixed safe placeholder');
    equal(secret.task.result.verdict, expectedWithheldVerdict, 'task result uses the same fixed safe placeholder');
    check(!secret.registryText.includes(secretMarker), 'presence registry contains no secret-shaped verdict bytes');
    check(!secret.taskText.includes(secretMarker), 'durable task result contains no secret-shaped verdict bytes');

    const failedFixture = path.join(root, 'failed-child.js');
    fs.writeFileSync(failedFixture, "console.log('## VERDICT');console.log('Child reported a bounded failure.');process.exitCode=7;\n", 'utf8');
    const failed = await runFixture(
      root,
      optionsFor(root, 'failed-fixture', process.execPath, [failedFixture], 'test-node'),
      '33333333-3333-4333-8333-333333333333'
    );
    equal(failed.result.terminal.status, 'failed', 'nonzero child exit remains failed after normalization');
    equal(failed.result.terminal.exitCode, 7, 'nonzero child exit code is preserved');
    equal(failed.task.status, 'failed', 'nonzero child exit durably fails the task');

    const claudeStream = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '## VERDICT\nSuperseded Claude block.' }] } }),
      JSON.stringify({ type: 'result', result: '## VERDICT\nResult envelope is not authoritative.' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '## VERDICT\nFinal Claude block.\nPreserve this meaning.\n## EVIDENCE\nignored' }] } })
    ].join('\n');
    const claude = await runFixture(
      root,
      optionsFor(root, 'claude-fixture', path.join(root, 'fixtures', 'claude'), ['--output-format', 'stream-json'], 'claude'),
      '44444444-4444-4444-8444-444444444444',
      {
        spawnImpl: fakeClaudeSpawn(claudeStream),
        // This suite tests terminal-verdict normalization, not the live
        // onboarding corpus. Production providers use the real builder; the
        // fixture supplies the same bounded dependency seam as test-node so a
        // missing machine-local queue/ledger cannot mask the verdict contract.
        buildOnboardingPacket: () => 'TEST CLAUDE ONBOARDING FIXTURE\n'
      }
    );
    equal(claude.result.terminal.status, 'finished', 'Claude fixture terminalizes normally');
    equal(
      claude.result.terminal.lastVerdict,
      'VERDICT: Final Claude block. Preserve this meaning.',
      'final Claude assistant Markdown block is selected and normalized at the terminal boundary'
    );
    equal(claude.task.result.verdict, claude.result.terminal.lastVerdict, 'Claude durable completion receives only the compact verdict');

    const fableReason = "You're out of usage credits. Fable resets Sep 2, 8am (America/Los_Angeles).";
    const claudeExhaustionStream = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: `${fableReason}\r\n${'Retry later. '.repeat(200)}`
    });
    const claudeExhausted = await runFixture(
      root,
      optionsFor(root, 'claude-exhausted-fixture', path.join(root, 'fixtures', 'claude'), ['--output-format', 'stream-json'], 'claude'),
      '55555555-5555-4555-8555-555555555555',
      {
        spawnImpl: fakeClaudeSpawn(claudeExhaustionStream),
        buildOnboardingPacket: () => 'TEST CLAUDE ONBOARDING FIXTURE\n'
      }
    );
    equal(claudeExhausted.result.terminal.status, 'failed', 'Claude result is_error terminalizes as failed even when the CLI exits zero');
    equal(claudeExhausted.result.terminal.exitCode, 1, 'Claude provider refusal replaces the misleading zero process exit');
    equal(claudeExhausted.task.status, 'failed', 'Claude provider refusal durably fails the lane task');
    equal(claudeExhausted.task.error.code, 'AGENT_LANE_PROVIDER_REFUSED', 'durable failure names the provider refusal instead of a generic process exit');
    check(claudeExhausted.result.terminal.lastVerdict.startsWith(`VERDICT: Claude provider refused the lane: ${fableReason}`), 'the measured Fable exhaustion sentence remains actionable');
    check(claudeExhausted.result.terminal.lastVerdict.length <= 1000, 'provider failure detail fits the durable task failure-message boundary');
    check(!/[\r\n]/.test(claudeExhausted.result.terminal.lastVerdict), 'provider failure detail is normalized to one physical line');
    equal(claudeExhausted.task.error.message, claudeExhausted.result.terminal.lastVerdict, 'durable task failure carries the same bounded actionable reason');

    const secretProviderMarker = 'Bearer abcdefghijklmnopqrstuvwxyz987654';
    const claudeSecretFailure = await runFixture(
      root,
      optionsFor(root, 'claude-secret-failure-fixture', path.join(root, 'fixtures', 'claude'), ['--output-format', 'stream-json'], 'claude'),
      '66666666-6666-4666-8666-666666666666',
      {
        spawnImpl: fakeClaudeSpawn(JSON.stringify({ type: 'result', is_error: true, result: `Provider refused with ${secretProviderMarker}` })),
        buildOnboardingPacket: () => 'TEST CLAUDE ONBOARDING FIXTURE\n'
      }
    );
    equal(
      claudeSecretFailure.result.terminal.lastVerdict,
      'VERDICT: Claude provider refused the lane; provider detail was withheld from state.',
      'secret-shaped provider detail uses a fixed actionable placeholder'
    );
    check(!claudeSecretFailure.registryText.includes(secretProviderMarker), 'secret-shaped provider detail never enters presence state');
    check(!claudeSecretFailure.taskText.includes(secretProviderMarker), 'secret-shaped provider detail never enters durable task state');

    process.stdout.write(`agent lane verdict normalization: ${assertions} assertions passed\n`);
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
