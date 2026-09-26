'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const actions = require('../src/lib/mission-bridge/actions');
const { resolveTreeModelChoice } = require('../src/lib/tool-registry');
const { createMapLedgerFixture } = require('./lib/task-waiting-memory-fixture.cjs');

const SETTING = 'agent.task_difficulty_enabled';
const TIERS = actions.TIERS;
const NOW = '2026-09-23T15:00:00.000Z';
const LATER = '2026-09-23T15:01:00.000Z';

function targetFor(tier, { scope = 'tree', threadId = null } = {}) {
  const row = TIERS[tier];
  assert.ok(row, `the declared ${tier} target exists`);
  const nodeId = `node-${tier}`;
  return Object.freeze({
    identity: Object.freeze({
      nodeId,
      scope,
      scopeKey: nodeId,
      sessionId: `session-${tier}`,
      treeId: `tree-${tier}`,
      threadId,
    }),
    locality: Object.freeze({ sameHost: true, sameTree: true }),
    configuration: Object.freeze({
      tier,
      provider: row.provider,
      model: row.model,
      effort: row.effort,
    }),
  });
}

function fixture(enabled = true) {
  const f = createMapLedgerFixture({ label: 'task-assignment-transaction' });
  const originalSettings = f.opts.loadSettings;
  const state = { enabled, settingReads: 0 };
  f.opts.loadSettings = () => {
    state.settingReads += 1;
    const snapshot = originalSettings();
    return { ...snapshot, values: { ...snapshot.values, [SETTING]: state.enabled } };
  };
  return { ...f, state };
}

function assignmentInput({ id, nodeId, assignmentId, reason = 'Assign the existing task.', actor = 'codex', now = NOW }) {
  return { id, nodeId, assignmentId, reason, actor, now };
}

function authorityFixture(target, { revision = 1, receiptExtra = {} } = {}) {
  const state = { current: true, calls: [] };
  const assertCurrent = () => {
    if (!state.current) {
      throw Object.assign(new Error('The host target roster changed before assignment.'), {
        code: 'T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN',
      });
    }
  };
  const resolveAssignmentAuthority = ({ task, nodeId, assignmentId }) => {
    assertCurrent();
    assert.equal(task && typeof task === 'object', true, 'the private resolver receives the locked task');
    assert.equal(nodeId, target.identity.nodeId, 'the private resolver must bind the requested existing recipient');
    state.calls.push(Object.freeze({ taskId: task.id, nodeId, assignmentId }));
    const targetIdentity = Object.freeze({ ...target.identity });
    const targetConfiguration = Object.freeze({ ...target.configuration });
    const authorityReceipt = Object.freeze({
      source: 'host-target-roster',
      taskId: task.id,
      assignmentId,
      targetAgentId: target.identity.nodeId,
      target: targetIdentity,
      locality: target.locality,
      targetConfiguration,
      authorityRevision: revision,
      durable: true,
      ...receiptExtra,
    });
    return Object.freeze({
      taskId: task.id,
      assignmentId,
      targetAgentId: target.identity.nodeId,
      target: targetIdentity,
      locality: target.locality,
      targetConfiguration,
      authorityRevision: revision,
      authorityReceipt,
      assertCurrent,
    });
  };
  return {
    state,
    assertCurrent,
    resolveAssignmentAuthority,
  };
}

function hostAuthorityFixture(target, {
  sourceScopeKey = null,
  coordinatorNodeId = 'controller-node',
  coordinatorSessionId = 'controller-session',
  coordinatorRole = 'controller',
} = {}) {
  const authority = authorityFixture(target, {
    receiptExtra: { coordinatorNodeId, coordinatorSessionId, coordinatorRole },
  });
  const resolve = authority.resolveAssignmentAuthority;
  authority.resolveAssignmentAuthority = ({ task, nodeId, assignmentId, assignmentReplayContext }) => {
    const sourceMatches = sourceScopeKey === null
      ? task.scope === 'global' && task.scopeKey === null
      : task.scope === 'thread' && task.scopeKey === sourceScopeKey;
    if (!sourceMatches && !assignmentReplayContext) {
      throw Object.assign(new Error('The current task no longer belongs to this coordinator.'), {
        code: 'T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN',
      });
    }
    if (assignmentReplayContext) {
      if (assignmentReplayContext.kind !== 'task-assignment-replay'
          || assignmentReplayContext.taskId !== task.id
          || assignmentReplayContext.assignmentId !== assignmentId
          || assignmentReplayContext.source.scopeKey !== sourceScopeKey
          || assignmentReplayContext.source.coreSha256?.length !== 64
          || assignmentReplayContext.targetAgentId !== target.identity.nodeId
          || assignmentReplayContext.targetConfiguration?.tier !== target.configuration.tier
          || assignmentReplayContext.actor !== 'codex'
          || assignmentReplayContext.reason !== 'Assign the existing task.'
          || assignmentReplayContext.authorityReceipt?.coordinatorNodeId !== coordinatorNodeId
          || assignmentReplayContext.authorityReceipt?.coordinatorSessionId !== coordinatorSessionId
          || assignmentReplayContext.authorityReceipt?.coordinatorRole !== coordinatorRole) {
        throw Object.assign(new Error('The durable original coordinator or recipient binding changed.'), {
          code: 'T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN',
        });
      }
    }
    return resolve({ task, nodeId, assignmentId });
  };
  return authority;
}

function assignmentOptions(f, authority) {
  return {
    ...f.opts,
    taskLedgerOptions: {
      ...(f.opts.taskLedgerOptions || {}),
      assignmentAuthority: Object.freeze({
        resolveAssignmentAuthority: authority.resolveAssignmentAuthority,
        assertCurrent: authority.assertCurrent,
        readSettings: f.opts.loadSettings,
        tiers: TIERS,
        resolveModelChoice: resolveTreeModelChoice,
      }),
    },
  };
}

function actualB6Authority() {
  const appRoot = process.env.T1139_B6_APP_ROOT || process.env.IMAGE_APP_ROOT;
  assert.equal(typeof appRoot, 'string', 'the composed runner must publish IMAGE_APP_ROOT or T1139_B6_APP_ROOT');
  const authorityPath = path.join(appRoot, 'shell', 'task-assignment-target-authority.cjs');
  assert.equal(fs.existsSync(authorityPath), true, `the pinned B6 authority helper exists: ${authorityPath}`);
  const { createTaskAssignmentAuthority } = require(authorityPath);
  const luna = TIERS.luna;
  assert.ok(luna, 'the real engine tier registry contains luna');
  const sessions = new Map([['worker-session', {
    sessionId: 'worker-session', state: 'ready', closeRequested: false, ended: false,
    agentId: 'worker-seat', roleId: 'worker', treeNodeKey: 'worker-node', threadId: 'worker-thread',
    treeRequestIdentity: { treeAnchors: ['root-node', 'controller-node', 'worker-node'] },
    requestedModelTier: 'luna', provider: luna.provider,
    nativeModeSettings: { model: luna.model }, effort: luna.effort,
  }]]);
  const org = {
    ok: true,
    org: { revision: 7, agents: [
      { id: 'controller-seat', enabled: true, role: 'manager' },
      { id: 'worker-seat', enabled: true, role: 'worker' },
    ] },
    roles: [{ id: 'manager', revision: 2 }, { id: 'worker', revision: 3 }],
  };
  const current = {
    actor: 'agent', agentId: 'controller-seat', nodeId: 'controller-node',
    hostSessionId: 'app-host-session', sessionId: 'controller-session', treeId: 'root-node',
    treeAnchors: ['root-node', 'controller-node'], roleId: 'manager', roleRevision: 2,
    orgRevision: 7,
  };
  const authority = createTaskAssignmentAuthority({
    readOrg: () => org,
    readSessions: () => sessions,
    readCurrentCoordinator: () => current,
    readSettings: () => ({ values: { [SETTING]: true }, rejected: [], revision: 7 }),
    resolveTargetConfiguration: session => ({
      tier: session.requestedModelTier,
      provider: session.provider,
      model: session.nativeModeSettings.model,
      effort: session.effort,
    }),
  });
  return { authority, current, sessions };
}

function assignTask(f, input, authority) {
  assert.equal(typeof f.store.assignTask, 'function', 'B9 assignment transaction capability is not installed in this base');
  return f.store.assignTask(input, assignmentOptions(f, authority));
}

test('the pre-composition base reports the missing assignment transaction separately', () => {
  const f = fixture(true);
  assert.equal(typeof f.store.assignTask, 'function', 'B9 must add the store transaction before behavior can be measured');
});

test('assignTask locks the progressed task, derives strength from its stored grade, and journals one receipt', () => {
  const f = fixture(true);
  const task = f.fileTask({ scope: 'global', words: 'Assign this task.', filedBy: 'codex', difficulty: 'hard' });
  f.progress({ id: task.id, status: 'in-progress', reason: 'The task is ready for an owner.', actor: 'codex' });

  const target = targetFor('sol');
  const authority = authorityFixture(target);
  const settingReadsBefore = f.state.settingReads;
  const result = assignTask(f, assignmentInput({ id: task.id, nodeId: target.identity.nodeId, assignmentId: 'assignment-hard-1' }), authority);

  assert.equal(result.assigned, true);
  assert.equal(result.id, task.id);
  assert.equal(result.assignmentId, 'assignment-hard-1');
  assert.equal(result.replayed, false);
  assert.equal(Number.isSafeInteger(result.revision), true);
  assert.equal(typeof result.recordedAt, 'string');
  assert.ok(result.receipt && typeof result.receipt === 'object');
  assert.deepEqual(result.target, target.identity);
  assert.deepEqual(result.targetConfiguration, target.configuration);
  assert.equal(result.targetAgentId, target.identity.nodeId);
  assert.equal(result.difficultyPlan.requiredStrength, 'premium');
  assert.equal(result.difficultyPlan.requiredEffort, 'xhigh');
  assert.equal(result.difficulty, 'hard');
  assert.equal(authority.state.calls.length, 1);
  assert.ok(f.state.settingReads > settingReadsBefore, 'the grading setting was read inside the assignment transaction');
  assert.equal(f.findTask(task.id).status, 'in-progress');
  assert.equal(f.findTask(task.id).scope, target.identity.scope);
  assert.equal(f.findTask(task.id).scopeKey, target.identity.scopeKey);
  assert.equal(f.findTask(task.id).ownerState, 'assigned');
  assert.equal(f.findTask(task.id).ownerNodeId, target.identity.nodeId);
  const decision = f.findTask(task.id).decisions.find(row => row.decision === 'assign');
  assert.ok(decision, 'assignment is a Ledger decision, not a renderer-only result');
  assert.equal(decision.operation.type, 'task-assignment');
  assert.equal(decision.operation.assignmentId, 'assignment-hard-1');
  assert.equal(decision.operation.nodeId, target.identity.nodeId);
  assert.equal(decision.operation.requiredStrength, 'premium');
  assert.equal(f.store.verifyHistory(f.opts).ok, true);
});

test('assignment replay is exact, conflicting reuse is refused, and neither adds a second journal event', () => {
  const f = fixture(true);
  const task = f.fileTask({ scope: 'global', words: 'Replay this assignment.', filedBy: 'codex', difficulty: 'hard' });
  f.progress({ id: task.id, status: 'in-progress', reason: 'Ready for an owner.', actor: 'codex' });
  const target = targetFor('sol');
  const authority = authorityFixture(target);
  const input = assignmentInput({ id: task.id, nodeId: target.identity.nodeId, assignmentId: 'assignment-replay' });
  const first = assignTask(f, input, authority);
  const afterFirst = { ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) };

  const replay = assignTask(f, { ...input, now: LATER }, authority);
  assert.equal(replay.replayed, true);
  assert.equal(replay.recordedAt, first.recordedAt);
  assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, afterFirst);
  assert.equal(f.findTask(task.id).decisions.filter(row => row.decision === 'assign').length, 1);

  assert.throws(() => assignTask(f, { ...input, reason: 'A conflicting assignment.' }, authority), {
    code: 'T_LEDGER_ASSIGNMENT_EVENT_CONFLICT',
  });
  assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, afterFirst);

  const changedReceipt = authorityFixture(target, { receiptExtra: { coordinatorSessionId: 'different-controller-session' } });
  assert.throws(() => assignTask(f, { ...input, now: LATER }, changedReceipt), {
    code: 'T_LEDGER_ASSIGNMENT_EVENT_CONFLICT',
  });
  assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, afterFirst);
});

test('assignTask accepts a newly filed open task and durably routes it to the trusted recipient', () => {
  const f = fixture(true);
  const task = f.fileTask({ scope: 'global', words: 'Assign this newly filed task.', filedBy: 'codex', difficulty: 'easy' });
  const beforeTask = f.findTask(task.id);
  const target = targetFor('luna');
  const authority = authorityFixture(target);
  const result = assignTask(f, assignmentInput({ id: task.id, nodeId: target.identity.nodeId, assignmentId: 'assignment-open-1' }), authority);

  assert.equal(result.assigned, true);
  const saved = f.findTask(task.id);
  assert.equal(saved.status, 'open');
  assert.equal(saved.scope, target.identity.scope);
  assert.equal(saved.scopeKey, target.identity.scopeKey);
  assert.equal(saved.ownerState, 'assigned');
  assert.equal(saved.ownerNodeId, target.identity.nodeId);
  assert.equal(saved.history.length, beforeTask.history.length + 1);
  assert.equal(saved.decisions.at(-1).fromScope, 'global');
  assert.equal(saved.decisions.at(-1).toScope, target.identity.scope);
});

test('assignment preserves a provider thread identity while routing a tree task by recipient node', () => {
  const f = fixture(true);
  const task = f.fileTask({ scope: 'global', words: 'Preserve the provider conversation.', filedBy: 'codex', difficulty: 'easy' });
  const target = targetFor('luna', { threadId: 'provider:thread-luna' });
  const result = assignTask(f, assignmentInput({
    id: task.id, nodeId: target.identity.nodeId, assignmentId: 'assignment-provider-thread',
  }), authorityFixture(target));

  const saved = f.findTask(task.id);
  assert.equal(saved.scope, 'tree');
  assert.equal(saved.scopeKey, target.identity.nodeId);
  assert.equal(saved.threadId, null, 'a tree-scoped Ledger task does not use the provider conversation as its scope key');
  assert.equal(result.target.threadId, 'provider:thread-luna');
  assert.equal(result.receipt.target.threadId, 'provider:thread-luna');
  assert.equal(saved.decisions.at(-1).target.threadId, 'provider:thread-luna');
});

test('thread-scoped assignment stores the recipient node as the Ledger thread key', () => {
  const f = fixture(true);
  const task = f.fileTask({ scope: 'thread', key: 'source-thread', words: 'Route this thread task.', filedBy: 'codex', difficulty: 'easy' });
  const target = targetFor('luna', { scope: 'thread', threadId: 'provider:thread-luna' });
  const result = assignTask(f, assignmentInput({
    id: task.id, nodeId: target.identity.nodeId, assignmentId: 'assignment-thread-target',
  }), authorityFixture(target));

  const saved = f.findTask(task.id);
  assert.equal(saved.scope, 'thread');
  assert.equal(saved.scopeKey, target.identity.nodeId);
  assert.equal(saved.threadId, target.identity.nodeId);
  assert.equal(result.receipt.target.threadId, 'provider:thread-luna');
});

test('assignment refuses a trusted target whose scope key is not its node identity', () => {
  const f = fixture(true);
  const task = f.fileTask({ scope: 'global', words: 'Reject a mismatched recipient.', filedBy: 'codex', difficulty: 'easy' });
  const base = targetFor('luna');
  const mismatched = Object.freeze({
    ...base,
    identity: Object.freeze({ ...base.identity, scopeKey: 'different-recipient' }),
  });
  const before = { ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) };
  assert.throws(() => assignTask(f, assignmentInput({
    id: task.id, nodeId: base.identity.nodeId, assignmentId: 'assignment-mismatched-scope',
  }), authorityFixture(mismatched)), { code: 'T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN' });
  assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, before);
  assert.equal(f.findTask(task.id).ownerNodeId, null);
});

test('host-bound replay uses the durable original source for global and thread tasks', () => {
  for (const source of [
    { scope: 'global', sourceScopeKey: null, assignmentId: 'assignment-host-global' },
    { scope: 'thread', sourceScopeKey: 'controller-thread', assignmentId: 'assignment-host-thread' },
  ]) {
    const f = fixture(true);
    const task = f.fileTask({
      scope: source.scope,
      ...(source.sourceScopeKey === null ? {} : { key: source.sourceScopeKey }),
      words: `Replay the ${source.scope} assignment.`, filedBy: 'codex', difficulty: 'easy',
    });
    const target = targetFor('luna', {
      scope: source.scope === 'thread' ? 'thread' : 'tree',
      threadId: 'provider:child-thread',
    });
    const authority = hostAuthorityFixture(target, { sourceScopeKey: source.sourceScopeKey });
    const input = assignmentInput({ id: task.id, nodeId: target.identity.nodeId, assignmentId: source.assignmentId });
    assignTask(f, input, authority);
    const beforeReplay = { ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) };

    const replay = assignTask(f, { ...input, now: LATER }, authority);
    assert.equal(replay.replayed, true);
    assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, beforeReplay);

    const changedCoordinator = hostAuthorityFixture(target, {
      sourceScopeKey: source.sourceScopeKey,
      coordinatorSessionId: 'different-controller-session',
    });
    assert.throws(() => assignTask(f, { ...input, now: LATER }, changedCoordinator), {
      code: 'T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN',
    });
    assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, beforeReplay);

    const changedTarget = targetFor('sol', {
      scope: source.scope === 'thread' ? 'thread' : 'tree',
      threadId: 'provider:other-thread',
    });
    assert.throws(() => assignTask(f, { ...input, nodeId: changedTarget.identity.nodeId }, hostAuthorityFixture(changedTarget, {
      sourceScopeKey: source.sourceScopeKey,
    })), { code: 'T_LEDGER_ASSIGNMENT_EVENT_CONFLICT' });
    assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, beforeReplay);

    const changedTask = f.fileTask({
      scope: source.scope,
      ...(source.sourceScopeKey === null ? {} : { key: source.sourceScopeKey }),
      words: `Reject a cross-task ${source.scope} replay.`, filedBy: 'codex', difficulty: 'easy',
    });
    const beforeChangedTaskReplay = { ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) };
    assert.throws(() => assignTask(f, { ...input, id: changedTask.id }, authority), {
      code: 'T_LEDGER_ASSIGNMENT_EVENT_CONFLICT',
    });
    assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, beforeChangedTaskReplay);
  }
});

test('assignment replay rejects tampered decision and history copies against the authenticated resolve event', () => {
  const f = fixture(true);
  const task = f.fileTask({ scope: 'global', words: 'Reject a forged replay binding.', filedBy: 'codex', difficulty: 'easy' });
  const target = targetFor('luna');
  const authority = authorityFixture(target);
  const input = assignmentInput({ id: task.id, nodeId: target.identity.nodeId, assignmentId: 'assignment-tampered-binding' });
  assignTask(f, input, authority);

  const ledger = f.readLedger();
  const entry = ledger.requests.find(row => row.id === task.id);
  const decision = entry.decisions.find(row => row.decision === 'assign' && row.assignmentId === input.assignmentId);
  const historyRow = entry.history.find(row => row.kind === 'resolve' && row.operation?.assignmentId === input.assignmentId);
  assert.ok(decision && historyRow, 'the forged replay fixture has both durable copies');
  const forgedCore = 'f'.repeat(64);
  decision.source = { ...decision.source, coreSha256: forgedCore };
  decision.operation = { ...decision.operation, source: { ...decision.operation.source, coreSha256: forgedCore } };
  historyRow.operation = { ...historyRow.operation, source: { ...historyRow.operation.source, coreSha256: forgedCore } };
  f.memory.writeFileSync(f.ledgerFile, `${JSON.stringify(ledger)}\n`);
  const beforeRefusedReplay = { ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) };

  assert.throws(() => assignTask(f, { ...input, now: LATER }, authority), {
    code: 'T_LEDGER_ASSIGNMENT_EVENT_CONFLICT',
  });
  assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, beforeRefusedReplay);
});

test('the actual B6 host authority composes with the locked store for global and thread replay', () => {
  for (const source of [
    { scope: 'global', assignmentId: 'assignment-real-global' },
    { scope: 'thread', key: 'controller-node', assignmentId: 'assignment-real-thread' },
  ]) {
    const f = fixture(true);
    const task = f.fileTask({
      scope: source.scope,
      ...(source.key ? { key: source.key } : {}),
      words: `Compose the actual ${source.scope} host assignment.`, filedBy: 'codex', difficulty: 'easy',
    });
    const host = actualB6Authority();
    const input = assignmentInput({
      id: task.id, nodeId: 'worker-node', assignmentId: source.assignmentId,
    });
    const first = assignTask(f, input, host.authority);
    const afterFirst = { ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) };
    const replay = assignTask(f, { ...input, now: LATER }, host.authority);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, afterFirst);
    assert.equal(f.findTask(task.id).ownerNodeId, 'worker-node');
    assert.equal(f.findTask(task.id).scope, source.scope === 'thread' ? 'thread' : 'tree');
    assert.equal(f.findTask(task.id).scopeKey, 'worker-node');

    const beforeCoordinatorRefusal = { ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) };
    host.current.hostSessionId = 'replacement-host-session';
    assert.throws(() => assignTask(f, { ...input, now: LATER }, host.authority), {
      code: 'T_LEDGER_ASSIGNMENT_AUTHORITY_CHANGED',
    });
    host.current.hostSessionId = 'app-host-session';
    assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, beforeCoordinatorRefusal);

    const beforeTargetRefusal = { ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) };
    assert.throws(() => assignTask(f, { ...input, nodeId: 'other-node', now: LATER }, host.authority), {
      code: 'T_LEDGER_ASSIGNMENT_EVENT_CONFLICT',
    });
    assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, beforeTargetRefusal);
  }
});

test('an old assignment cannot replay after a later recipient assignment', () => {
  const f = fixture(true);
  const task = f.fileTask({ scope: 'global', words: 'Do not resurrect an old owner.', filedBy: 'codex', difficulty: 'easy' });
  const firstTarget = targetFor('luna');
  const firstInput = assignmentInput({ id: task.id, nodeId: firstTarget.identity.nodeId, assignmentId: 'assignment-old-owner' });
  assignTask(f, firstInput, authorityFixture(firstTarget));

  const secondTarget = targetFor('sol');
  assignTask(f, assignmentInput({ id: task.id, nodeId: secondTarget.identity.nodeId, assignmentId: 'assignment-new-owner' }), authorityFixture(secondTarget));
  const beforeReplay = { ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) };
  assert.throws(() => assignTask(f, { ...firstInput, now: LATER }, authorityFixture(firstTarget)), {
    code: 'T_LEDGER_ASSIGNMENT_EVENT_CONFLICT',
  });
  assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, beforeReplay);
  assert.equal(f.findTask(task.id).ownerNodeId, secondTarget.identity.nodeId);
});

test('assignment ids are durable across tasks and a cross-task reuse cannot write', () => {
  const f = fixture(true);
  const firstTask = f.fileTask({ scope: 'global', words: 'First assignment.', filedBy: 'codex', difficulty: 'easy' });
  const target = targetFor('luna');
  const authority = authorityFixture(target);
  const input = assignmentInput({ id: firstTask.id, nodeId: target.identity.nodeId, assignmentId: 'assignment-global-identity' });
  assignTask(f, input, authority);

  const secondTask = f.fileTask({ scope: 'global', words: 'Second assignment.', filedBy: 'codex', difficulty: 'easy' });
  const before = { ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) };
  assert.throws(() => assignTask(f, { ...input, id: secondTask.id }, authority), {
    code: 'T_LEDGER_ASSIGNMENT_EVENT_CONFLICT',
  });
  assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, before);
  assert.equal(f.findTask(secondTask.id).ownerNodeId, null);
});

test('assignment refuses a stale or weaker trusted target without changing the task', () => {
  const f = fixture(true);
  const task = f.fileTask({ scope: 'global', words: 'Keep target authority.', filedBy: 'codex', difficulty: 'hard' });
  f.progress({ id: task.id, status: 'in-progress', reason: 'Ready for an owner.', actor: 'codex' });
  const before = { ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) };
  const weak = targetFor('luna');
  const weakAuthority = authorityFixture(weak);
  assert.throws(() => assignTask(f, assignmentInput({ id: task.id, nodeId: weak.identity.nodeId, assignmentId: 'assignment-weak' }), weakAuthority), {
    code: 'AGENT_TASK_DIFFICULTY_MISMATCH',
  });
  assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, before);
});

function retainedSourceHandoff(f, sourceNodeId) {
  const sourcePreimage = Object.freeze({
    id: sourceNodeId,
    treeId: 'tree-source',
    parentId: null,
    status: 'finished',
    sessionId: null,
  });
  const operationId = 'assignment-source-fence';
  const topologyToken = 'a'.repeat(64);
  const coordinatorIdentity = Object.freeze({
    actor: 'agent', nodeId: sourceNodeId, hostSessionId: 'assignment-test-host', orgRevision: 1,
  });
  const sourcePreimageSha256 = crypto.createHash('sha256')
    .update(f.store.canonical(sourcePreimage), 'utf8').digest('hex');
  const registration = f.store.registerTaskLedgerWriter({
    options: {
      ...f.opts,
      taskLedgerOptions: { coordinatorIdentity },
    },
    principal: 'native-removal-service',
    resolveAuthority: () => ({
      kind: 'verified-parent', sourceNodeId, parentNodeId: 'node-parent', parentTreeId: 'tree-source',
      topologyRevision: 'source-fence-revision', topologyToken, sourcePreimage,
      principal: 'native-removal-service',
    }),
    verifyTopologyReceipt: () => ({ durable: true }),
  });
  const writer = f.store.taskLedgerWriter(registration);
  const reservation = Object.freeze({
    token: 'assignment-source-fence-token', operationId, sourceNodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source', sourcePreimageSha256,
    topologyToken, orgRevision: 1,
  });
  const options = Object.freeze({ coordinatorIdentity, reservation });
  const input = {
    operationId, sourceNodeId, actor: 'native-removal-service',
    reason: 'Retain the source task while topology removal is unresolved.',
  };
  writer.prepareTaskHandoff(input, options);
  const committed = writer.commitTaskHandoff({ ...input, postimageSha256: 'f'.repeat(64) }, options);
  assert.equal(committed.phase, 'committed');
  return { registration, operationId };
}

test('assignment refuses a task with a real retained source handoff before writing', () => {
  const f = fixture(true);
  const task = f.fileTask({ scope: 'tree', key: 'node-fenced-source', words: 'Fence this retained task.', filedBy: 'codex', difficulty: 'hard' });
  f.progress({ id: task.id, status: 'in-progress', reason: 'Ready for a fenced source.', actor: 'codex' });
  const fence = retainedSourceHandoff(f, 'node-fenced-source');
  const before = { ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) };
  try {
    assert.equal(typeof f.store.assignTask, 'function', 'B9 must add the assignment transaction before source fencing can be measured');
    const target = targetFor('sol');
    const authority = authorityFixture(target);
    assert.throws(() => assignTask(f, assignmentInput({
      id: task.id, nodeId: target.identity.nodeId, assignmentId: 'assignment-fenced-source',
    }), authority), { code: 'T_LEDGER_HANDOFF_SOURCE_PENDING' });
    assert.deepEqual({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) }, before);
    const retained = f.findTask(task.id);
    assert.equal(retained.handoff.phase, 'committed');
    assert.equal(retained.handoff.sourceBarrier, 'retained');
    assert.equal(retained.handoff.sourcePreimageRetained, true);
  } finally {
    f.store.revokeTaskLedgerWriter(fence.registration, 'TEST_CLEANUP');
  }
});

test('assignment reads the grading setting inside the transaction and leaves legacy tasks ungraded when it is off', () => {
  const f = fixture(false);
  const task = f.fileTask({ scope: 'global', words: 'Legacy assignment.', filedBy: 'codex' });
  f.progress({ id: task.id, status: 'in-progress', reason: 'Ready for a legacy owner.', actor: 'codex' });
  const target = targetFor('luna');
  const authority = authorityFixture(target);
  const settingReadsBefore = f.state.settingReads;
  const result = assignTask(f, assignmentInput({ id: task.id, nodeId: target.identity.nodeId, assignmentId: 'assignment-legacy' }), authority);
  assert.equal(result.assigned, true);
  assert.deepEqual(result.difficultyPlan, { required: false, reason: 'grading-disabled' });
  assert.equal(result.targetAgentId, target.identity.nodeId);
  assert.ok(f.state.settingReads > settingReadsBefore, 'the disabled grading setting was read inside the assignment transaction');
  assert.equal(Object.hasOwn(f.findTask(task.id), 'difficulty'), false);
});
