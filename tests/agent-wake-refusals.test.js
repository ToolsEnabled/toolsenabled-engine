'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const agentOrg = require('../src/lib/agent-org');
const presence = require('../src/lib/agent-presence');
const wake = require('../src/lib/agent-wake');

function org({ disabledManager = false } = {}) {
  return agentOrg.normalizeOrg({
    schemaVersion: 1,
    revision: 1,
    agents: [
      { id: 'controller-a', displayName: 'Controller A', role: 'controller', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] },
      { id: 'manager-a', displayName: 'Manager A', role: 'manager', provider: 'codex', enabled: !disabledManager, assignedPhase: null, phasePriority: [] },
      { id: 'manager-b', displayName: 'Manager B', role: 'manager', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] },
      { id: 'worker-a', displayName: 'Worker A', role: 'worker', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] },
      { id: 'worker-b', displayName: 'Worker B', role: 'worker', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] }
    ],
    relationships: [
      { from: 'controller-a', to: 'manager-a', type: 'manages' },
      { from: 'controller-a', to: 'manager-b', type: 'manages' },
      { from: 'manager-a', to: 'worker-a', type: 'manages' },
      { from: 'manager-b', to: 'worker-b', type: 'manages' }
    ]
  });
}

function record(directory) {
  const worktree = path.join(directory, 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  return {
    agentId: 'worker-a', runId: '11111111-1111-4111-8111-111111111111', role: 'worker', tier: 'gpt-test',
    reportsTo: 'manager-a', dispatcher: 'manager-a', lane: 'lane-worker-a', territory: 'tests/**',
    currentTask: null, brief: path.join(worktree, 'brief.md'), consoleLog: path.join(directory, 'worker.log'),
    worktree, launchSpec: path.join(directory, 'launch.json'), pid: 123, startedAt: 1_000,
    lastHeartbeat: 1_000, status: 'running', exitCode: null, lastVerdict: null, terminalAt: null,
    staleReason: null, mailboxOffset: 0, respawnCount: 0, verdictConsumedAt: null
  };
}

async function assertAuthorizationRefusal(t, actor, declaredOrg, code) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-refusal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const launchDir = path.join(directory, 'launch');
  presence.register(record(directory), { file: stateFile });
  let launches = 0;
  await assert.rejects(() => wake.wakeAgent({
    agentId: 'worker-a', from: actor, prompt: 'Do not queue this.', requestId: `refuse-${code}`
  }, {
    stateFile, mailboxDir, launchDir, org: declaredOrg, isAlive: () => true,
    launchLane: async () => { launches += 1; return { pid: 999 }; }
  }), error => error && error.code === code);
  assert.equal(launches, 0, `${code} must not spawn a lane`);
  assert.equal(fs.existsSync(path.join(mailboxDir, 'worker-a.jsonl')), false, `${code} must not write a directive`);
  assert.deepEqual(fs.existsSync(launchDir) ? fs.readdirSync(launchDir) : [], [], `${code} must leave no launch state`);
}

test('wake authorization refusals happen before mailbox writes or spawning', async t => {
  await assertAuthorizationRefusal(t, 'unknown-a', org(), 'AGENT_WAKE_ACTOR_UNKNOWN');
  await assertAuthorizationRefusal(t, 'manager-a', org({ disabledManager: true }), 'AGENT_WAKE_ACTOR_DISABLED');
  await assertAuthorizationRefusal(t, 'manager-b', org(), 'AGENT_WAKE_OUTSIDE_TOPOLOGY');
});

function customRoleOrg() {
  const knownRoles = [
    { id: 'release-captain', baseDefaultRole: 'manager' },
    { id: 'watcher', baseDefaultRole: 'observer' },
    { id: 'no-base-observer', baseDefaultRole: null }
  ];
  return agentOrg.normalizeOrg({
    schemaVersion: 1,
    revision: 1,
    agents: [
      { id: 'controller-a', displayName: 'Controller A', role: 'controller', provider: 'none', enabled: true },
      { id: 'release-a', displayName: 'Release A', role: 'release-captain', provider: 'codex', enabled: true },
      { id: 'watcher-a', displayName: 'Watcher A', role: 'watcher', provider: 'codex', enabled: true },
      { id: 'no-base-observer-a', displayName: 'No-base Observer A', role: 'no-base-observer', provider: 'codex', enabled: true },
      { id: 'shadow-a', displayName: 'Shadow A', role: 'shadow-manager', provider: 'codex', enabled: true },
      { id: 'release-worker', displayName: 'Release Worker', role: 'worker', provider: 'codex', enabled: true },
      { id: 'watcher-worker', displayName: 'Watcher Worker', role: 'worker', provider: 'codex', enabled: true },
      { id: 'no-base-worker', displayName: 'No-base Worker', role: 'worker', provider: 'codex', enabled: true },
      { id: 'shadow-worker', displayName: 'Shadow Worker', role: 'worker', provider: 'codex', enabled: true }
    ],
    relationships: [
      { from: 'controller-a', to: 'release-a', type: 'manages' },
      { from: 'controller-a', to: 'watcher-a', type: 'manages' },
      { from: 'controller-a', to: 'no-base-observer-a', type: 'manages' },
      { from: 'controller-a', to: 'shadow-a', type: 'manages' },
      { from: 'release-a', to: 'release-worker', type: 'manages' },
      { from: 'watcher-a', to: 'watcher-worker', type: 'manages' },
      { from: 'no-base-observer-a', to: 'no-base-worker', type: 'manages' },
      { from: 'shadow-a', to: 'shadow-worker', type: 'manages' }
    ]
  }, { knownRoles });
}

function observedTarget(agentId, reportsTo) {
  return { agentId, role: 'worker', reportsTo };
}

test('custom role base posture and declared topology jointly govern wake authority', () => {
  const declaredOrg = customRoleOrg();
  const registry = {
    agents: {
      'release-worker': observedTarget('release-worker', 'release-a'),
      'watcher-worker': observedTarget('watcher-worker', 'watcher-a'),
      'no-base-worker': observedTarget('no-base-worker', 'no-base-observer-a'),
      'shadow-worker': observedTarget('shadow-worker', 'shadow-a')
    }
  };
  assert.deepEqual(wake.assertWakeAuthorized({
    from: 'release-a', target: 'release-worker', org: declaredOrg, registry
  }), { from: 'release-a', target: 'release-worker', role: 'release-captain', authorized: true });
  for (const [from, target] of [
    ['watcher-a', 'watcher-worker'],
    ['no-base-observer-a', 'no-base-worker'],
    ['shadow-a', 'shadow-worker']
  ]) {
    assert.throws(
      () => wake.assertWakeAuthorized({ from, target, org: declaredOrg, registry }),
      error => error && error.code === 'AGENT_WAKE_ROLE_READ_ONLY'
    );
  }
  assert.throws(
    () => wake.assertWakeAuthorized({ from: 'release-a', target: 'watcher-worker', org: declaredOrg, registry }),
    error => error && error.code === 'AGENT_WAKE_OUTSIDE_TOPOLOGY'
  );
});

test('a custom manager-based role delivers one bounded wake request without spawning', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-custom-role-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const launchDir = path.join(directory, 'launch');
  presence.register({
    ...record(directory),
    agentId: 'release-worker',
    reportsTo: 'release-a',
    dispatcher: 'release-a'
  }, { file: stateFile });
  let launches = 0;
  const result = await wake.wakeAgent({
    agentId: 'release-worker',
    from: 'release-a',
    prompt: 'Review the next bounded release packet.',
    requestId: 'custom-role-request-0001'
  }, {
    stateFile,
    mailboxDir,
    launchDir,
    org: customRoleOrg(),
    isAlive: () => true,
    launchLane: async () => { launches += 1; return { pid: 999 }; }
  });
  assert.equal(result.action, 'queued');
  assert.equal(launches, 0);
  const delivered = presence.drainMailbox('release-worker', 0, { mailboxDir }).entries;
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], {
    from: 'release-a',
    at: delivered[0].at,
    prompt: 'Review the next bounded release packet.',
    requestId: 'custom-role-request-0001'
  });
  assert.deepEqual(fs.existsSync(launchDir) ? fs.readdirSync(launchDir) : [], [],
    'a live-role request creates no process or respawn state');
});

test('a custom manager-based role may relaunch its dead descendant while a no-base observer may not', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-custom-respawn-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const launchDir = path.join(directory, 'launch');
  const releaseRecord = {
    ...record(directory),
    agentId: 'release-worker',
    reportsTo: 'release-a',
    dispatcher: 'release-a',
    pid: null,
    lastHeartbeat: 2_000,
    status: 'failed',
    exitCode: 1,
    terminalAt: 2_000
  };
  fs.writeFileSync(releaseRecord.brief, 'bounded release brief\n', 'utf8');
  fs.writeFileSync(releaseRecord.launchSpec, `${JSON.stringify({
    schemaVersion: 1,
    agentId: releaseRecord.agentId,
    runId: releaseRecord.runId,
    role: releaseRecord.role,
    tier: releaseRecord.tier,
    reportsTo: releaseRecord.reportsTo,
    dispatcher: releaseRecord.dispatcher,
    lane: releaseRecord.lane,
    territory: releaseRecord.territory,
    brief: releaseRecord.brief,
    worktree: releaseRecord.worktree,
    consoleLog: releaseRecord.consoleLog,
    checkpoint: null,
    heartbeatMs: 1_000,
    leaseSeconds: 30,
    respawnCount: 0,
    command: 'node',
    childArgs: []
  })}\n`, 'utf8');
  presence.register(releaseRecord, { file: stateFile });

  let launches = 0;
  const launched = await wake.wakeAgent({
    agentId: 'release-worker',
    from: 'release-a',
    prompt: 'Resume the bounded release packet.',
    requestId: 'custom-role-respawn-0001',
    respawnIfDead: true
  }, {
    stateFile,
    mailboxDir,
    launchDir,
    org: customRoleOrg(),
    isAlive: () => false,
    launchLane: async spec => {
      launches += 1;
      assert.equal(spec.agentId, 'release-worker');
      assert.equal(spec.role, 'worker');
      return { pid: 999 };
    },
    awaitRegistration: false,
    clock: () => 10_000
  });
  assert.equal(launched.action, 'respawned');
  assert.equal(launched.authorization.role, 'release-captain');
  assert.equal(launched.respawn.respawnCount, 1);
  assert.equal(launched.respawn.registrationConfirmed, false);
  assert.equal(launches, 1);
  assert.equal(presence.drainMailbox('release-worker', 0, { mailboxDir }).entries.length, 1);

  const noBaseDirectory = path.join(directory, 'no-base');
  fs.mkdirSync(noBaseDirectory, { recursive: true });
  const noBaseRecord = {
    ...record(noBaseDirectory),
    agentId: 'no-base-worker',
    reportsTo: 'no-base-observer-a',
    dispatcher: 'no-base-observer-a',
    pid: null,
    lastHeartbeat: 2_000,
    status: 'failed',
    exitCode: 1,
    terminalAt: 2_000
  };
  presence.register(noBaseRecord, { file: stateFile });
  await assert.rejects(() => wake.wakeAgent({
    agentId: 'no-base-worker',
    from: 'no-base-observer-a',
    prompt: 'This read-only role must not relaunch.',
    requestId: 'no-base-respawn-refusal-0001',
    respawnIfDead: true
  }, {
    stateFile,
    mailboxDir,
    launchDir,
    org: customRoleOrg(),
    isAlive: () => false,
    launchLane: async () => { launches += 1; return { pid: 1000 }; },
    awaitRegistration: false,
    clock: () => 10_000
  }), error => error && error.code === 'AGENT_WAKE_ROLE_READ_ONLY');
  assert.equal(launches, 1, 'the no-base observer does not start another lane');
  assert.equal(fs.existsSync(path.join(mailboxDir, 'no-base-worker.jsonl')), false,
    'the no-base observer is refused before writing a request');
});

test('invalid org and launch specs expose their specific refusal codes without effects', () => {
  let reads = 0;
  assert.throws(() => wake.loadOrg('/virtual/org.json', {
    fsImpl: { readFileSync() { reads += 1; return '{"schemaVersion":999}'; } }
  }), error => error && error.code === 'AGENT_WAKE_ORG_INVALID');
  assert.equal(reads, 1);

  const target = { agentId: 'worker-a', runId: 'run-a', kind: 'codex', role: 'worker', tier: 'gpt-test', reportsTo: 'manager-a', dispatcher: 'manager-a', lane: 'lane-a', territory: 'tests/**', directiveId: undefined, brief: path.resolve('/brief'), worktree: path.resolve('/worktree'), consoleLog: path.resolve('/log'), respawnCount: 0 };
  const spec = { schemaVersion: 2, agentId: 'worker-a', runId: 'run-a', role: 'worker', tier: 'gpt-test', reportsTo: 'manager-a', dispatcher: 'manager-a', lane: 'lane-a', territory: 'tests/**', brief: path.resolve('/brief'), worktree: path.resolve('/worktree'), consoleLog: path.resolve('/log'), checkpoint: null, heartbeatMs: 1000, leaseSeconds: 30, respawnCount: 0, command: 'node', childArgs: [] };
  assert.throws(() => wake.normalizeLaunchSpec(spec, target), error => error && error.code === 'AGENT_WAKE_LAUNCH_SPEC_INVALID');
  assert.throws(() => wake.normalizeLaunchSpec({ ...spec, schemaVersion: 1, runId: 'run-b' }, target), error => error && error.code === 'AGENT_WAKE_LAUNCH_SPEC_MISMATCH');
  assert.equal(wake.normalizeLaunchSpec({ ...spec, schemaVersion: 1, role: 'release-captain' }, {
    ...target, role: 'release-captain'
  }).role, 'release-captain', 'a safe custom role survives the durable launch-spec path');
});

test('sweep input, oversized findings, and persistence failures are driven', async () => {
  await assert.rejects(() => wake.sweepAgents(null), error => error && error.code === 'AGENT_SWEEP_INVALID');
  const findings = { at: 0, policy: 'off', usefulProgressStaleMs: 1000, counts: {}, terminalVerdicts: [], failures: [], deadStale: [], heartbeatFaults: [], aliveNoUsefulProgress: [], unknownLiveness: [], respawns: [], escalations: [] };
  assert.throws(() => wake.boundedMemoryPacket(findings, 1), error => error && error.code === 'AGENT_SWEEP_FINDINGS_TOO_LARGE');
  let writes = 0;
  await assert.rejects(() => wake.persistSweepFindings(findings, {
    memoryDependencies: { state: { setMemory() { writes += 1; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } }
  }), error => error && error.code === 'AGENT_SWEEP_FINDINGS_PERSIST_FAILED');
  assert.equal(writes, 1);
});

test('safeError turns an unclassified exception into the public wake error refusal', () => {
  assert.deepEqual(wake.safeError(new Error('unclassified failure')), {
    code: 'AGENT_WAKE_ERROR', message: 'unclassified failure'
  });
});
