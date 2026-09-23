// EXECUTABLE CHANGE
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createWakeRequestHandler } = require('../../src/lib/agent-wake/wake-request');
const { createWakeExecutor } = require('../../src/lib/agent-wake/executor');
const {
  createClaudeSessionResumeAdapter,
  createDurableTaskReenqueueAdapter,
  createWorkerRegistry
} = require('../../src/lib/agent-wake/worker-registry');

const TRUSTED_TRANSPORT = Object.freeze({ trustedTransport: true });

function trustedAuthenticator() {
  return Object.freeze({
    verify({ authentication }) {
      return Object.freeze({
        authenticated: authentication && authentication.trustedTransport === true,
        integrityChecked: authentication && authentication.trustedTransport === true,
        principal: 'machine-a-tunnel-peer'
      });
    }
  });
}

function instruction(requestId, targetId = 'claude-manager-b', overrides = {}) {
  return Object.freeze({
    requestId,
    agentId: targetId,
    sessionId: 'request-session-ignored-by-worker',
    action: 'resume',
    ...overrides
  });
}

function registry({ enabled = true, targetId = 'claude-manager-b' } = {}) {
  return createWorkerRegistry({
    workers: [{
      targetId,
      enabled,
      adapter: createClaudeSessionResumeAdapter({ storedSessionId: 'stored-claude-session-1' })
    }]
  });
}

test('a registered target resolves to its fixed local operation regardless of request contents', async () => {
  const calls = [];
  const executor = createWakeExecutor({
    registry: registry(),
    runner: Object.freeze({ async run(operation) { calls.push(operation); } })
  });

  const first = await executor.handle(instruction('request-fixed-0001'));
  const second = await executor.handle(instruction('request-fixed-0002', 'claude-manager-b', {
    sessionId: 'different-request-session',
    action: 'resume'
  }));

  assert.equal(first.outcome, 'STARTED');
  assert.equal(second.outcome, 'STARTED');
  assert.deepEqual(calls, [
    {
      kind: 'CLAUDE_SESSION_RESUME',
      program: 'claude',
      arguments: ['--resume', 'stored-claude-session-1']
    },
    {
      kind: 'CLAUDE_SESSION_RESUME',
      program: 'claude',
      arguments: ['--resume', 'stored-claude-session-1']
    }
  ]);
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.equal(Object.isFrozen(calls[0].arguments), true);
});

test('the two real adapters hold only locally declared values', () => {
  const claude = createClaudeSessionResumeAdapter({ storedSessionId: 'stored-claude-session-2' });
  const task = createDurableTaskReenqueueAdapter({
    taskId: 'durable-task-17',
    leaseFence: 'lease-fence-17'
  });

  assert.deepEqual(claude.operation, {
    kind: 'CLAUDE_SESSION_RESUME',
    program: 'claude',
    arguments: ['--resume', 'stored-claude-session-2']
  });
  assert.deepEqual(task.operation, {
    kind: 'DURABLE_TASK_REENQUEUE',
    taskId: 'durable-task-17',
    leaseFence: 'lease-fence-17'
  });
  assert.deepEqual(claude.allowedActions, ['resume', 'respawn', 'prompt']);
  assert.deepEqual(task.allowedActions, ['resume', 'respawn', 'prompt']);
});

test('every contract-approved wake action can execute a registered local operation', async () => {
  const calls = [];
  const executor = createWakeExecutor({
    registry: registry(),
    runner: Object.freeze({ async run(operation) { calls.push(operation); } })
  });

  for (const action of ['resume', 'respawn', 'prompt']) {
    const overrides = action === 'prompt'
      ? { action, prompt: 'Continue from the registered local state.' }
      : { action };
    const receipt = await executor.handle(instruction(`request-${action}-001`, 'claude-manager-b', overrides));
    assert.equal(receipt.outcome, 'STARTED', action);
  }

  assert.equal(calls.length, 3);
  assert.equal(calls.every(operation => operation === calls[0]), true);
});

test('an unregistered target never reaches the runner', async () => {
  let calls = 0;
  const executor = createWakeExecutor({
    registry: registry(),
    runner: Object.freeze({ async run() { calls += 1; } })
  });

  const receipt = await executor.handle(instruction('request-unknown-01', 'not-a-worker'));
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.outcome, 'TARGET_UNKNOWN');
  assert.equal(calls, 0);
});

test('hostile target IDs cannot traverse or inject into the registry', async () => {
  let calls = 0;
  const executor = createWakeExecutor({
    registry: registry(),
    runner: Object.freeze({ async run() { calls += 1; } })
  });
  const hostileIds = [
    '../claude-manager-b',
    'claude-manager-b/..',
    'claude-manager-b;ignored',
    'claude-manager-b$ignored',
    '__proto__',
    'constructor',
    'claude-manager-b\nsecond'
  ];

  for (let index = 0; index < hostileIds.length; index += 1) {
    const receipt = await executor.handle(instruction(`hostile-id-${index}`, hostileIds[index]));
    assert.equal(receipt.accepted, false, hostileIds[index]);
    assert.equal(calls, 0, hostileIds[index]);
  }
});

test('expired or replayed wake requests never make an additional runner call', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-executor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 10_000;
  let calls = 0;
  const executor = createWakeExecutor({
    registry: registry(),
    runner: Object.freeze({ async run() { calls += 1; } })
  });
  const handler = createWakeRequestHandler({
    stateFile: path.join(directory, 'wake.json'),
    authenticator: trustedAuthenticator(),
    isKnownAgent: () => true,
    executor: executor.forWakeRequest,
    ttlMs: 500,
    maxClockSkewMs: 100,
    rateLimit: { maxRequests: 3, windowMs: 60_000 },
    maxInFlight: 2,
    now: () => now
  });

  const expired = await handler.handle({
    requestId: 'request-expired-1',
    agentId: 'claude-manager-b',
    sessionId: 'session-b-1',
    action: 'resume',
    issuedAtMs: 9_499
  }, TRUSTED_TRANSPORT);
  assert.equal(expired.code, 'WAKE_REQUEST_EXPIRED');
  assert.equal(calls, 0);

  const request = {
    requestId: 'request-replay-01',
    agentId: 'claude-manager-b',
    sessionId: 'session-b-1',
    action: 'resume',
    issuedAtMs: now
  };
  assert.equal((await handler.handle(request, TRUSTED_TRANSPORT)).code, 'WAKE_EXECUTED');
  now += 1;
  const replay = await handler.handle(request, TRUSTED_TRANSPORT);
  assert.equal(replay.code, 'WAKE_REPLAY_NOOP');
  assert.equal(calls, 1);
});

test('a wake-contract refusal or an accepted unknown registry target never reaches the runner', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const executor = createWakeExecutor({
    registry: registry(),
    runner: Object.freeze({ async run() { calls += 1; } })
  });
  const handler = createWakeRequestHandler({
    stateFile: path.join(directory, 'wake.json'),
    authenticator: trustedAuthenticator(),
    isKnownAgent: () => true,
    executor: executor.forWakeRequest,
    ttlMs: 500,
    maxClockSkewMs: 100,
    rateLimit: { maxRequests: 3, windowMs: 60_000 },
    maxInFlight: 2,
    now: () => 10_000
  });

  const forbidden = await handler.handle({
    requestId: 'request-forbidden-1',
    agentId: 'claude-manager-b',
    sessionId: 'session-b-1',
    action: 'resume',
    issuedAtMs: 10_000,
    command: 'ignored'
  }, TRUSTED_TRANSPORT);
  assert.equal(forbidden.code, 'WAKE_FORBIDDEN_FIELD');

  const unknown = await handler.handle({
    requestId: 'request-no-worker-1',
    agentId: 'known-but-unregistered',
    sessionId: 'session-b-1',
    action: 'resume',
    issuedAtMs: 10_000
  }, TRUSTED_TRANSPORT);
  assert.equal(unknown.code, 'WAKE_EXECUTOR_FAILED');
  assert.equal(calls, 0);
  assert.equal(executor.getReceipts().at(-1).outcome, 'TARGET_UNKNOWN');
});

test('receipts are exact bounded data and exclude local operation or environment details', async () => {
  const executor = createWakeExecutor({
    registry: registry({ targetId: 'worker-b' }),
    runner: Object.freeze({ async run() {} })
  });
  const receipt = await executor.handle(instruction('request-receipt-01', 'worker-b'));

  assert.deepEqual(Object.keys(receipt).sort(), ['accepted', 'outcome', 'receiptVersion', 'requestId', 'targetId']);
  assert.deepEqual(receipt, {
    receiptVersion: 1,
    requestId: 'request-receipt-01',
    targetId: 'worker-b',
    accepted: true,
    outcome: 'STARTED'
  });
  const serialized = JSON.stringify(receipt);
  for (const forbidden of ['claude', '--resume', 'stored-claude-session-1', 'arguments', 'program', 'env', 'environment']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('default-off registry and default refusing runner do not start anything', async () => {
  const empty = createWakeExecutor();
  const unregistered = await empty.handle(instruction('request-default-01'));
  assert.equal(unregistered.outcome, 'TARGET_UNKNOWN');

  const armedWithoutRunner = createWakeExecutor({ registry: registry() });
  const refused = await armedWithoutRunner.handle(instruction('request-default-02'));
  assert.equal(refused.outcome, 'RUNNER_REFUSED');
});

/*
Mutation report (testcanfail-tests-agent-wake-executor-test-js)

Strengthened assertions:
- All receipt `outcome` assertions formerly derived their expectations from the
  executor's exported `OUTCOMES` object. Mutating `OUTCOMES.STARTED` from
  `STARTED` to `MUTATED_STARTED` left all 9 tests green. With literal contract
  expectations, the mutation produced: `Expected values to be strictly equal:
  + actual - expected`, `+ 'MUTATED_STARTED'`, `- 'STARTED'` (tests 1, 3, and 8).
- All operation `kind` assertions formerly derived their expectations from the
  worker registry's exported `ADAPTER_KINDS` object. Mutating
  `CLAUDE_SESSION_RESUME` to `MUTATED_CLAUDE_SESSION_RESUME` left all 9 tests
  green. With literal contract expectations, the mutation produced:
  `+ kind: 'MUTATED_CLAUDE_SESSION_RESUME'` and
  `- kind: 'CLAUDE_SESSION_RESUME'` (tests 1 and 2).

Shape census:
- EMPTY loop/forEach: NOT-FOUND. Both loops use non-empty in-test literals, and
  the action loop also has an exact post-loop call-count assertion.
- EXIT STATUS/truthy return using only subject output: NOT-FOUND.
- Swallowing try/catch or optional-chain: NOT-FOUND.
- Mock of the thing under test: NOT-FOUND. Runners are observation fakes at the
  executor boundary; registry and adapter behavior remain real.
- Skip or silent platform precondition: NOT-FOUND.
- Expected value computed by the checked code: FOUND and fixed as above.

Restoration: both mutated source files were restored byte-for-byte (SHA-256
executor.js 44b800c70825082dfbfcdac42964a881739fe5b932b3b443c6292aa7da613c11;
worker-registry.js 1550dd664bc6d1d5ecc9e26d6e38232d313a2c78a9844c4d9e336bb7e456f750).
The restored run was green: `# tests 9`, `# pass 9`, `# fail 0`.
Unmet preconditions: none.
*/
