// EXECUTABLE CHANGE
// Discrimination report (testcanfail-tests-agent-presence-test-js):
// - Strengthened the role-vocabulary loop with a non-empty collection assertion.
//   Mutation: made agent-org ROLES mutable, then cleared it when the missing registry was read.
//   RED: "AssertionError [ERR_ASSERTION]: declared role vocabulary must not be empty".
// - NOT-FOUND: exit-status/truthy-only evidence; swallowed try/catch or optional-chain;
//   self-mocking assertions; skip/platform no-op guards; same-code computed expectations.
// - RESTORATION: src/lib/agent-org.js and src/lib/agent-presence.js were restored byte-for-byte.
// - PRECONDITION: the default Node.js 20 lacks node:sqlite; tests require Node.js >=22,
//   so all executions used /root/.nvm/versions/node/v22.22.2/bin/node.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const presence = require('../src/lib/agent-presence');
const agentOrg = require('../src/lib/agent-org');
const lane = require('../src/lib/agent-lane');
const tasks = require('../src/lib/providers/tasks');
const { createStateStore } = require('../src/lib/state-store');

let assertions = 0;
function check(value, message) { assert.ok(value, message); assertions += 1; }
function equal(actual, expected, message) { assert.equal(actual, expected, message); assertions += 1; }
function throws(fn, code) {
  assert.throws(fn, error => error && error.code === code);
  assertions += 1;
}

function testMissingIsDifferentFromCouldNotBeEstablished(temp) {
  const missingRegistry = path.join(temp, 'distinction', 'missing-presence.json');
  const missingMailbox = path.join(temp, 'distinction', 'missing-mailbox.jsonl');
  equal(presence.readRegistry(missingRegistry).revision, 0,
    'missing presence is a definite empty registry');
  equal(presence.drainMailbox('seat-1', 0, { file: missingMailbox }).entries.length, 0,
    'missing mailbox is a definite empty mailbox');

  const unreadable = new Error('fixture denied the read');
  unreadable.code = 'EACCES';
  const unreadableFs = Object.create(fs);
  unreadableFs.readFileSync = () => { throw unreadable; };
  assert.throws(() => presence.readRegistry(missingRegistry, { fsImpl: unreadableFs }), unreadable,
    'unreadable presence means the answer could not be established, not empty');
  assertions += 1;
  assert.throws(() => presence.drainMailbox('seat-1', 0, {
    file: missingMailbox,
    fsImpl: unreadableFs
  }), unreadable, 'unreadable mailbox means the answer could not be established, not empty');
  assertions += 1;
}

function baseRecord(overrides = {}) {
  return {
    agentId: 'seat-1',
    runId: '11111111-1111-4111-8111-111111111111',
    role: 'manager',
    tier: 'gpt-5.6-sol',
    reportsTo: 'coordinator-sol',
    dispatcher: 'coordinator-sol',
    lane: 'phase-b-live-data',
    territory: 'tools/gen-*.mjs,public/data/schema/**',
    currentTask: 'task-1',
    brief: 'C:\\work\\brief.md',
    consoleLog: 'C:\\work\\lane.log',
    worktree: 'C:\\work',
    launchSpec: 'C:\\state\\seat-1.json',
    pid: null,
    startedAt: 1000,
    lastHeartbeat: 1000,
    status: 'starting',
    exitCode: null,
    lastVerdict: null,
    terminalAt: null,
    staleReason: null,
    mailboxOffset: 0,
    respawnCount: 0,
    verdictConsumedAt: null,
    ...overrides
  };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-presence-test-'));
  const stateFile = path.join(temp, 'state', 'agent-presence.json');
  const mailboxDir = path.join(temp, 'state', 'mailbox');
  const launchDir = path.join(temp, 'state', 'launch');
  try {
    const empty = presence.readRegistry(stateFile);
    equal(empty.revision, 0, 'missing state starts at revision zero');
    equal(Object.keys(empty.agents).length, 0, 'missing state means unknown, not fabricated records');
    testMissingIsDifferentFromCouldNotBeEstablished(temp);
    assert.deepEqual(presence.ROLES, agentOrg.ROLES,
      'runtime presence continues to export the shipped default role vocabulary');
    assertions += 1;
    check(agentOrg.ROLES.length > 0, 'declared role vocabulary must not be empty');
    for (const role of agentOrg.ROLES) {
      equal(presence.normalizeRecord(baseRecord({ role, recordRevision: 1 })).role, role, `${role} is valid in live presence`);
    }
    equal(presence.normalizeRecord(baseRecord({ role: 'release-captain', recordRevision: 1 })).role,
      'release-captain', 'a safe operator-defined role remains observable after launch');
    throws(() => presence.normalizeRecord(baseRecord({ role: 'owner', recordRevision: 1 })), 'AGENT_PRESENCE_INVALID');
    throws(() => presence.normalizeRecord(baseRecord({ role: 'Not Safe', recordRevision: 1 })), 'AGENT_PRESENCE_INVALID');
    throws(() => presence.normalizeRecord(baseRecord({ role: 'coordinator', recordRevision: 1 })), 'AGENT_PRESENCE_INVALID');
    const legacyRegistry = presence.normalizeRegistry({
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1000,
      agents: { legacy: baseRecord({ agentId: 'legacy', role: 'coordinator', recordRevision: 1 }) }
    });
    equal(legacyRegistry.agents.legacy.role, 'controller', 'historical coordinator presence migrates read-only to the fixed controller role');

    const first = presence.register(baseRecord(), { file: stateFile });
    equal(first.kind, 'codex', 'legacy records infer the Codex lane kind');
    equal(first.origin, 'self', 'coordinator dispatch derives self origin');
    equal(first.recordRevision, 1, 'first record revision is one');
    equal(first.directiveId, undefined, 'legacy unbound presence remains valid');
    equal(presence.readRegistry(stateFile).revision, 1, 'registry revision advanced atomically');
    const progressFile = presence.usefulProgressFile(first.agentId, { file: stateFile });
    const validProgress = fs.readFileSync(progressFile);
    fs.writeFileSync(progressFile, '{not-json}\n');
    throws(() => presence.readRegistry(stateFile), 'AGENT_USEFUL_PROGRESS_STATE_INVALID');
    fs.writeFileSync(progressFile, validProgress);
    throws(() => presence.register(baseRecord(), { file: stateFile }), 'AGENT_PRESENCE_ACTIVE');
    throws(() => presence.update('seat-1', '22222222-2222-4222-8222-222222222222', { status: 'running' }, { file: stateFile }), 'AGENT_PRESENCE_WRITER_MISMATCH');

    const processStartTicks = '639265824000000000';
    const running = presence.heartbeat('seat-1', first.runId, {
      pid: 1234, processStartTicks, currentTask: 'task-1', mailboxOffset: 0, at: 2000
    }, { file: stateFile });
    equal(running.status, 'running', 'heartbeat makes the record running');
    equal(running.pid, 1234, 'heartbeat records the observed child pid');
    equal(running.processStartTicks, processStartTicks, 'heartbeat binds the PID to its exact Windows creation identity');
    throws(() => presence.heartbeat('seat-1', first.runId, {
      pid: 1234, processStartTicks: '639265824000000001', currentTask: 'task-1', mailboxOffset: 0, at: 2001
    }, { file: stateFile }), 'AGENT_PRESENCE_WRITER_MISMATCH');
    throws(() => presence.update('seat-1', first.runId, { lane: 'different' }, { file: stateFile, expectedRecordRevision: 1 }), 'AGENT_PRESENCE_CAS_MISMATCH');
    const finished = presence.finish('seat-1', first.runId, { exitCode: 0, verdict: 'VERDICT: done', at: 3000 }, { file: stateFile });
    equal(finished.status, 'finished', 'zero exit is terminal finished');
    equal(finished.lastVerdict, 'VERDICT: done', 'terminal verdict is retained');

    const builder = presence.register(baseRecord({
      agentId: 'builder-lane',
      runId: '55555555-5555-4555-8555-555555555555',
      role: 'builder',
      directiveId: 'R1162.1'
    }), { file: stateFile });
    equal(builder.role, 'builder', 'declared builder is a first-class canonical runtime presence role');
    equal(builder.directiveId, 'R1162.1', 'canonical directive binding is retained in presence');
    throws(() => presence.update('builder-lane', builder.runId, { directiveId: 'R1' }, { file: stateFile }), 'AGENT_PRESENCE_INVALID');
    throws(() => presence.register(baseRecord({
      agentId: 'malformed-role',
      runId: '66666666-6666-4666-8666-666666666666',
      role: 'Builder'
    }), { file: stateFile }), 'AGENT_PRESENCE_INVALID');
    throws(() => presence.register(baseRecord({
      agentId: 'malformed-directive',
      runId: '67676767-6767-4676-8676-676767676767',
      directiveId: 'owner said this'
    }), { file: stateFile }), 'AGENT_PRESENCE_INVALID');

    const owner = presence.register(baseRecord({
      agentId: 'owner-lane',
      runId: '33333333-3333-4333-8333-333333333333',
      role: 'worker',
      dispatcher: 'owner',
      reportsTo: 'coordinator-sol'
    }), { file: stateFile });
    equal(owner.origin, 'user', 'owner dispatch derives user origin');

    const claudeRecord = presence.register(baseRecord({
      agentId: 'claude-fixture',
      runId: '77777777-7777-4777-8777-777777777777',
      kind: 'claude',
      role: 'shadow-manager',
      tier: 'claude/sonnet'
    }), { file: stateFile });
    equal(claudeRecord.kind, 'claude', 'Claude kind is retained in canonical presence');
    equal(presence.rosterRows(presence.readRegistry(stateFile)).find(row => row.agentId === 'claude-fixture').kind, 'claude', 'roster rows expose lane kind');

    const queued = presence.appendMailbox('seat-1', { from: 'coordinator-sol', at: 4000, prompt: 'Continue from the verified checkpoint.', requestId: 'wake-1' }, { mailboxDir });
    equal(queued.requestId, 'wake-1', 'mailbox returns the appended request');
    const drained = presence.drainMailbox('seat-1', 0, { mailboxDir });
    equal(drained.entries.length, 1, 'mailbox drains one append-only entry');
    equal(drained.entries[0].prompt, 'Continue from the verified checkpoint.', 'mailbox preserves prompt bytes');
    equal(presence.drainMailbox('seat-1', drained.nextOffset, { mailboxDir }).entries.length, 0, 'mailbox offset prevents replay');
    throws(() => presence.appendMailbox('seat-1', { from: 'coordinator-sol', prompt: 'Bearer abcdefghijklmnopqrstuvwxyz123456', requestId: 'wake-secret' }, { mailboxDir }), 'AGENT_PRESENCE_SECRET_REJECTED');

    equal(lane.extractVerdict('noise\nVERDICT: one-line result\n'), 'VERDICT: one-line result', 'one-line verdict remains supported');
    equal(
      lane.extractVerdict('noise\n## VERDICT\nFirst result.\nSecond result.\n## EVIDENCE\nignored\n'),
      '## VERDICT\nFirst result.\nSecond result.',
      'Markdown verdict block is captured through the next heading'
    );
    const claudeStream = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'VERDICT: superseded' }] } }),
      JSON.stringify({ type: 'result', result: 'VERDICT: result envelope is not authoritative' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'VERDICT: final structured Claude result' }] } })
    ].join('\n');
    equal(lane.extractLaneVerdict(claudeStream, 'claude'), 'VERDICT: final structured Claude result', 'Claude verdict comes from the final assistant message only');
    const nativeClaude = path.join(os.tmpdir(), 'tools', 'claude.exe');
    equal(lane.commandKind(nativeClaude), 'claude', 'resolved Claude executable is a supported lane kind');
    throws(() => lane.commandKind(path.join(os.tmpdir(), 'tools', 'claude.cmd')), 'AGENT_LANE_COMMAND_REFUSED');
    equal(lane.normalizeChildExitCode(0xffffffff), -1, 'Windows force-kill DWORD is retained as a signed exit code');
    equal(lane.normalizeChildExitCode(null), 1, 'missing child exit code fails closed');

    equal(presence.deriveLiveness(running, { now: 100_000, staleMs: 10_000, isAlive: () => false }), 'stale', 'late heartbeat plus dead pid derives stale');
    equal(presence.deriveLiveness(running, { now: 100_000, staleMs: 10_000, isAlive: () => true }), 'heartbeat-fault', 'late heartbeat plus live pid is a distinct fault');
    equal(presence.deriveLiveness(running, { now: 2500, staleMs: 10_000, isAlive: () => false }), 'process-gone', 'recent heartbeat plus dead pid is not mislabeled stale');

    const worktree = path.join(temp, 'worktree');
    fs.mkdirSync(worktree, { recursive: true });
    const brief = path.join(worktree, 'brief.md');
    const fixture = path.join(worktree, 'fixture.js');
    const consoleLog = path.join(temp, 'logs', 'lane.log');
    fs.writeFileSync(brief, 'Build only the bounded fixture.\n', 'utf8');
    fs.writeFileSync(fixture, "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(!input.includes('SUPERVISOR DIRECTIVES')||!input.includes('wake-2'))process.exit(7);console.log('VERDICT: fixture received its mailbox');});\n", 'utf8');
    presence.appendMailbox('fixture-seat', { from: 'coordinator-sol', at: 5000, prompt: 'wake-2', requestId: 'wake-2' }, { mailboxDir });

    const taskCalls = [];
    const handle = { taskId: 'task-fixture', workerLabel: 'fixture-seat', attempt: 1, fence: 1, claimToken: 'never-persist-this' };
    const taskApi = {
      submit: async input => { taskCalls.push(['submit', input]); return { taskId: handle.taskId }; },
      claim: async input => { taskCalls.push(['claim', input]); return { claimed: true, handle }; },
      start: async input => { taskCalls.push(['start', input]); return { taskId: handle.taskId }; },
      heartbeat: async input => { taskCalls.push(['heartbeat', input]); return { taskId: handle.taskId }; },
      complete: async input => { taskCalls.push(['complete', input]); return { taskId: handle.taskId }; },
      fail: async input => { taskCalls.push(['fail', input]); return { taskId: handle.taskId }; }
    };
    const previousTestMode = process.env.TOOLSENABLED_LANE_RUN_TEST;
    process.env.TOOLSENABLED_LANE_RUN_TEST = '1';
    try {
      const options = lane.parseArgs([
        '--agent', 'fixture-seat', '--role', 'worker', '--tier', 'gpt-5.6-terra',
        '--reports-to', 'coordinator-sol', '--dispatcher', 'coordinator-sol',
        '--lane', 'presence-fixture', '--territory', 'fixture.js', '--brief', brief,
        '--worktree', worktree, '--console-log', consoleLog, '--heartbeat-ms', '1000',
        '--directive', 'R1162',
        '--', process.execPath, fixture
      ]);
      equal(options.kind, 'test-node', 'test fixture records its explicit runtime kind');
      equal(options.directiveId, 'R1162', 'lane accepts only its structured canonical directive binding');
      throws(() => lane.parseArgs([
        '--agent', 'directive-invalid', '--role', 'worker', '--tier', 'gpt-5.6-terra',
        '--reports-to', 'coordinator-sol', '--dispatcher', 'coordinator-sol',
        '--lane', 'presence-fixture', '--territory', 'fixture.js', '--brief', brief,
        '--worktree', worktree, '--console-log', consoleLog, '--heartbeat-ms', '1000',
        '--directive', 'not-a-request-id', '--', process.execPath, fixture
      ]), 'AGENT_LANE_DIRECTIVE_INVALID');
      const payload = lane.taskPayloadFor(options);
      assert.deepEqual(Object.keys(payload).sort(), ['context', 'objective', 'title']);
      assertions += 1;
      const payloadState = createStateStore({
        file: path.join(temp, 'payload-contract.sqlite3'),
        ownerId: 'agent-presence-test',
        clock: () => Date.UTC(2026, 7, 6, 10, 0, 0)
      });
      try {
        const accepted = await tasks.submit({
          queue: 'agent-lane-contract',
          type: lane.LANE_TASK_TYPE,
          idempotencyKey: 'agent-run:payload-contract',
          payload,
          maxAttempts: 1
        }, { state: payloadState, auditRecord: () => {} });
        check(typeof accepted.taskId === 'string', 'canonical durable task store accepts the lane payload envelope');
      } finally {
        payloadState.close();
      }
      const result = await lane.runLane(options, {
        tasks: taskApi,
        stateFile: path.join(temp, 'fixture-presence.json'),
        mailboxDir,
        launchDir,
        runId: '44444444-4444-4444-8444-444444444444'
      });
      equal(result.terminal.status, 'finished', 'real wrapped child lands a finished terminal record');
      equal(result.terminal.exitCode, 0, 'real wrapped child exit is recorded');
      equal(result.terminal.lastVerdict, 'VERDICT: fixture received its mailbox', 'last verdict is captured from the console');
      equal(result.terminal.kind, 'test-node', 'terminal presence retains lane kind');
      equal(result.terminal.directiveId, 'R1162', 'terminal record retains the immutable directive binding');
      check(taskCalls.some(([name]) => name === 'submit'), 'wrapper submits a durable task');
      check(taskCalls.some(([name]) => name === 'claim'), 'wrapper claims the durable task');
      check(taskCalls.some(([name]) => name === 'start'), 'wrapper starts the durable task before child work');
      check(taskCalls.some(([name]) => name === 'complete'), 'wrapper completes the durable task');
      check(!JSON.stringify(presence.readRegistry(path.join(temp, 'fixture-presence.json'))).includes('never-persist-this'), 'claim token never enters presence state');
      equal(presence.drainMailbox('fixture-seat', presence.readRegistry(path.join(temp, 'fixture-presence.json')).agents['fixture-seat'].mailboxOffset, { mailboxDir }).entries.length, 0, 'wrapped lane advances the durable mailbox offset');
    } finally {
      if (previousTestMode === undefined) delete process.env.TOOLSENABLED_LANE_RUN_TEST;
      else process.env.TOOLSENABLED_LANE_RUN_TEST = previousTestMode;
    }

    process.stdout.write(`agent presence: ${assertions} assertions passed\n`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
