'use strict';

const assert = require('node:assert/strict');

const registry = require('../src/lib/coordinator/duty-registry.js');

const { runTaskRegistrationCheck, runBoundedRestart } = registry._internals;

function baseContext(overrides = {}) {
  return {
    now: () => 1234,
    killSwitchActive: false,
    allowRestart: true,
    deps: {},
    ...overrides
  };
}

function restartContext({ policy, managedProcesses, spawnManaged } = {}) {
  return baseContext({
    deps: {
      observer: { sweep: () => ({ subsystems: { worker: { state: 'DOWN', reason: 'gone' } } }) },
      health: { STATE: { DOWN: 'DOWN' } },
      policy,
      managedProcesses
    },
    ...(spawnManaged === undefined ? {} : { spawnManaged })
  });
}

function onlyDecision(result) {
  assert.equal(result.outcome, 'OK');
  assert.equal(result.detail.downSubsystems, 1);
  assert.equal(result.detail.decisions.length, 1);
  return result.detail.decisions[0];
}

async function main() {
  let collected = 0;
  const processes = [
    { id: 'one', taskName: 'Task One' },
    { id: 'two', taskName: 'Task Two' }
  ];
  const taskDeps = tasks => ({
    managedProcesses: { listProcesses: () => processes },
    observer: {
      collectScheduledTasks(names) {
        collected += 1;
        assert.deepEqual(names, ['Task One', 'Task Two']);
        return tasks;
      }
    }
  });

  const all = await runTaskRegistrationCheck(baseContext({
    deps: taskDeps(new Map([
      ['Task One', { state: 'Ready' }],
      ['Task Two', { state: 'Running' }]
    ]))
  }));
  assert.equal(all.detail.durability, 'ALL_REGISTERED');
  assert.equal(all.detail.registered.length, 2);
  assert.deepEqual(all.detail.notRegistered, []);

  const some = await runTaskRegistrationCheck(baseContext({
    deps: taskDeps(new Map([['Task One', { state: 'Ready' }]]))
  }));
  assert.equal(some.detail.durability, 'SOME_NOT_REGISTERED');
  assert.deepEqual(some.detail.notRegistered, [{ id: 'two', taskName: 'Task Two' }]);
  assert.equal(collected, 2, 'each result must come from an actual scheduler observation');

  let forbiddenCalls = 0;
  let result = await runBoundedRestart(restartContext({
    policy: { decide: () => { throw new Error('policy store corrupt'); } },
    managedProcesses: {
      resolveArgv: () => { forbiddenCalls += 1; },
      checkArgvPreconditions: () => { forbiddenCalls += 1; }
    },
    spawnManaged: () => { forbiddenCalls += 1; }
  }));
  let decision = onlyDecision(result);
  assert.equal(decision.outcome, 'POLICY_ERROR');
  assert.match(decision.reason, /policy store corrupt/);
  assert.equal(decision.attempted, false);
  assert.equal(forbiddenCalls, 0, 'a policy refusal must not resolve argv, write accounting, or spawn');

  result = await runBoundedRestart(restartContext({
    policy: { decide: () => ({ action: 'correct', outcome: 'CORRECT', reason: 'repair' }) },
    managedProcesses: {
      resolveArgv: () => { throw new Error('declaration unavailable'); },
      checkArgvPreconditions: () => { forbiddenCalls += 1; }
    },
    spawnManaged: () => { forbiddenCalls += 1; }
  }));
  decision = onlyDecision(result);
  assert.equal(decision.outcome, 'ARGV_UNRESOLVABLE');
  assert.match(decision.decisionReason, /declaration unavailable/);
  assert.equal(decision.attempted, false);
  assert.equal(forbiddenCalls, 0, 'an argv refusal must not check later preconditions or spawn');

  result = await runBoundedRestart(restartContext({
    policy: { decide: () => ({ action: 'correct', outcome: 'CORRECT', reason: 'repair' }) },
    managedProcesses: {
      resolveArgv: () => ['node', 'worker.js'],
      checkArgvPreconditions: () => ({ ok: true })
    }
  }));
  decision = onlyDecision(result);
  assert.equal(decision.outcome, 'NO_SPAWNER');
  assert.match(decision.decisionReason, /no spawnManaged/);
  assert.equal(decision.attempted, false);
  assert.equal(result.detail.attempted, 0);

  let spawnCalls = 0;
  let accountingWrites = 0;
  result = await runBoundedRestart(restartContext({
    policy: {
      decide: () => ({ action: 'correct', outcome: 'CORRECT', reason: 'repair' }),
      recordAttempt: () => { accountingWrites += 1; }
    },
    managedProcesses: {
      resolveArgv: () => ['node', 'worker.js'],
      checkArgvPreconditions: () => ({ ok: true })
    },
    spawnManaged: async () => {
      spawnCalls += 1;
      throw new Error('spawn denied by OS');
    }
  }));
  decision = onlyDecision(result);
  assert.equal(decision.outcome, 'RESTART_SPAWN_FAILED');
  assert.match(decision.decisionReason, /spawn denied by OS/);
  assert.equal(decision.attempted, false);
  assert.equal(result.detail.attempted, 0);
  assert.equal(spawnCalls, 1, 'the injected spawner must be driven to produce this refusal');
  assert.equal(accountingWrites, 0, 'a failed spawn must not be recorded as a completed attempt');

  process.stdout.write('coordinator duty registry refusal behaviour: PASS\n');
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
