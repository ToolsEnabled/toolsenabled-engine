'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const agentOrg = require('../src/lib/agent-org');
const presence = require('../src/lib/agent-presence');
const wake = require('../src/lib/agent-wake');
const tasks = require('../src/lib/providers/tasks');
const { createStateStore } = require('../src/lib/state-store');

const ROOT = path.resolve(__dirname, '..');
const LANE_RUN = path.join(ROOT, 'tools', 'lane-run.js');
const WAKE_CLI = path.join(ROOT, 'tools', 'agent-wake.js');
const LANE_FIXTURE = path.join(__dirname, 'fixtures', 'agent-wake-lane.js');

let assertions = 0;
function check(value, message) { assert.ok(value, message); assertions += 1; }
function equal(actual, expected, message) { assert.equal(actual, expected, message); assertions += 1; }
function deepEqual(actual, expected, message) { assert.deepEqual(actual, expected, message); assertions += 1; }
function match(actual, expected, message) { assert.match(actual, expected, message); assertions += 1; }
function throwsCode(fn, code) {
  assert.throws(fn, error => error && error.code === code);
  assertions += 1;
}
async function rejectsCode(fn, code) {
  await assert.rejects(fn, error => error && error.code === code);
  assertions += 1;
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// The default budget is a BOUND on a hang, not an assertion about latency. It
// was 15_000ms, which is inside the real cost of what the slowest wait here
// measures: registering a lane means booting a second Node process, loading the
// engine module graph, opening SQLite and taking the state lock. Measured on
// this machine across four runs, 'initial lane running' took 12_541ms,
// 21_300ms, 14_272ms and 24_652ms -- so the budget sat between the samples and
// the suite went red on whichever run happened to be slowest, against a lane
// that was starting correctly every time (the presence record was on disk with
// status "running" and a live pid). 60_000ms is ~2.4x the measured 24_652ms
// worst case; a lane that never registers still fails the run.
async function waitFor(read, accept, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    try {
      last = read();
      if (accept(last)) return last;
    } catch (error) { last = error; }
    await delay(25);
  }
  const error = new Error(`Timed out waiting for ${label}; last=${last && last.message ? last.message : JSON.stringify(last)}`);
  error.code = 'AGENT_WAKE_TEST_TIMEOUT';
  throw error;
}

function processRun(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

function killIfAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already terminal */ }
}

async function removeTreeEventually(directory) {
  let lastError = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!error || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await delay(25);
    }
  }
  throw lastError;
}

function testOrg() {
  return agentOrg.normalizeOrg({
    schemaVersion: 1,
    revision: 1,
    agents: [
      { id: 'coordinator-sol', displayName: 'Coordinator Sol', role: 'controller', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] },
      { id: 'shadow-claude', displayName: 'Shadow Claude', role: 'shadow-manager', provider: 'claude', enabled: true, assignedPhase: null, phasePriority: [] },
      { id: 'manager-a', displayName: 'Manager A', role: 'manager', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] },
      { id: 'worker-a', displayName: 'Worker A', role: 'worker', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] }
    ],
    relationships: [
      { from: 'coordinator-sol', to: 'manager-a', type: 'manages' },
      { from: 'manager-a', to: 'worker-a', type: 'manages' }
    ]
  });
}

function derivedSupervisorOrg() {
  return agentOrg.normalizeOrg({
    schemaVersion: 1,
    revision: 1,
    agents: [
      { id: 'root-a', displayName: 'Root A', role: 'controller', provider: 'none', enabled: true },
      { id: 'release-a', displayName: 'Release A', role: 'release-captain', provider: 'codex', enabled: true },
      { id: 'release-worker', displayName: 'Release Worker', role: 'worker', provider: 'codex', enabled: true },
      { id: 'watcher-a', displayName: 'Watcher A', role: 'watcher', provider: 'codex', enabled: true },
      { id: 'watcher-worker', displayName: 'Watcher Worker', role: 'worker', provider: 'codex', enabled: true }
    ],
    relationships: [
      { from: 'root-a', to: 'release-a', type: 'manages' },
      { from: 'root-a', to: 'watcher-a', type: 'manages' },
      { from: 'release-a', to: 'release-worker', type: 'manages' },
      { from: 'watcher-a', to: 'watcher-worker', type: 'manages' }
    ]
  }, {
    knownRoles: [
      { id: 'release-captain', baseDefaultRole: 'manager' },
      { id: 'watcher', baseDefaultRole: 'observer' }
    ]
  });
}

function recordPaths(directory, agentId) {
  const worktree = path.join(directory, `${agentId}-worktree`);
  fs.mkdirSync(worktree, { recursive: true });
  return {
    brief: path.join(worktree, 'brief.md'),
    checkpoint: path.join(worktree, 'checkpoint.md'),
    consoleLog: path.join(directory, 'logs', `${agentId}.log`),
    worktree,
    launchSpec: path.join(directory, 'launch', `${agentId}.json`)
  };
}

function baseRecord(directory, agentId, overrides = {}) {
  const files = recordPaths(directory, agentId);
  return {
    agentId,
    runId: crypto.randomUUID(),
    role: 'worker',
    tier: 'gpt-5.6-terra',
    reportsTo: 'manager-a',
    dispatcher: 'manager-a',
    lane: `lane-${agentId}`,
    territory: 'tests/fixtures/**',
    currentTask: null,
    brief: files.brief,
    consoleLog: files.consoleLog,
    worktree: files.worktree,
    launchSpec: files.launchSpec,
    pid: 123,
    startedAt: 1_000,
    lastHeartbeat: 1_000,
    status: 'running',
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

function writeLaunchFixture(record, { checkpoint = true, command = process.execPath, childArgs = [LANE_FIXTURE] } = {}) {
  fs.mkdirSync(path.dirname(record.brief), { recursive: true });
  fs.writeFileSync(record.brief, 'Execute only the bounded wake fixture.\n', 'utf8');
  if (checkpoint) fs.writeFileSync(path.join(record.worktree, 'checkpoint.md'), 'checkpoint-marker-r1146\n', 'utf8');
  const spec = {
    schemaVersion: 1,
    agentId: record.agentId,
    runId: record.runId,
    role: record.role,
    tier: record.tier,
    reportsTo: record.reportsTo,
    dispatcher: record.dispatcher,
    lane: record.lane,
    territory: record.territory,
    ...(record.directiveId === undefined ? {} : { directiveId: record.directiveId }),
    brief: record.brief,
    worktree: record.worktree,
    consoleLog: record.consoleLog,
    checkpoint: checkpoint ? path.join(record.worktree, 'checkpoint.md') : null,
    heartbeatMs: 1_000,
    leaseSeconds: 30,
    respawnCount: record.respawnCount,
    command,
    childArgs
  };
  presence.writeAtomic(record.launchSpec, spec);
  return spec;
}

function builderLaunchSpecTests(directory) {
  const builder = baseRecord(directory, 'builder-a', { role: 'builder' });
  const spec = writeLaunchFixture(builder, { checkpoint: false });
  equal(wake.normalizeLaunchSpec(spec, builder).role, 'builder', 'wake launch specs accept the canonical builder role');
  equal(wake.normalizeLaunchSpec(spec, builder).kind, 'codex', 'legacy launch specs infer Codex kind for wake compatibility');
  throwsCode(() => wake.normalizeLaunchSpec({ ...spec, role: 'Builder' }, builder), 'AGENT_WAKE_LAUNCH_SPEC_INVALID');

  const bound = baseRecord(directory, 'bound-worker', { directiveId: 'R1162.1' });
  const boundSpec = writeLaunchFixture(bound, { checkpoint: false });
  equal(wake.normalizeLaunchSpec(boundSpec, bound).directiveId, 'R1162.1', 'wake launch specs preserve a canonical directive binding');
  check(wake.laneRunArguments(wake.normalizeLaunchSpec(boundSpec, bound), 1).includes('R1162.1'), 'respawn returns the binding through lane-run');
  throwsCode(() => wake.normalizeLaunchSpec({ ...boundSpec, directiveId: 'free text' }, bound), 'AGENT_WAKE_LAUNCH_SPEC_INVALID');

  const claude = baseRecord(directory, 'claude-a', { kind: 'claude', role: 'shadow-manager', tier: 'claude/opus' });
  const claudeSpec = { ...writeLaunchFixture(claude, { checkpoint: false, command: 'C:\\tools\\claude.exe' }), kind: 'claude' };
  equal(wake.normalizeLaunchSpec(claudeSpec, claude).kind, 'claude', 'Claude launch kind survives wake normalization');
  equal(wake.laneRunArguments(wake.normalizeLaunchSpec(claudeSpec, claude), 1).includes('--kind'), true, 'respawn passes the explicit lane kind back through lane-run');
}

async function authorizationAndQueueTests(directory) {
  const stateFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const launchDir = path.join(directory, 'launch');
  const org = testOrg();
  const manager = presence.register(baseRecord(directory, 'manager-a', {
    role: 'manager',
    reportsTo: 'coordinator-sol',
    dispatcher: 'coordinator-sol',
    pid: 201
  }), { file: stateFile });
  const worker = presence.register(baseRecord(directory, 'worker-a', { pid: 202 }), { file: stateFile });
  const registry = presence.readRegistry(stateFile);

  equal(wake.assertWakeAuthorized({ from: 'coordinator-sol', target: 'worker-a', org, registry }).authorized, true, 'coordinator reaches a transitive declared descendant');
  equal(wake.assertWakeAuthorized({ from: 'manager-a', target: 'worker-a', org, registry }).authorized, true, 'manager reaches its declared descendant');
  throwsCode(() => wake.assertWakeAuthorized({ from: 'shadow-claude', target: 'manager-a', org, registry }), 'AGENT_WAKE_NOT_SUPERVISOR');
  throwsCode(() => wake.assertWakeAuthorized({ from: 'worker-a', target: 'manager-a', org, registry }), 'AGENT_WAKE_NOT_SUPERVISOR');

  const derivedOrg = derivedSupervisorOrg();
  // Wake always requires an observed target so authorization can never create
  // a mailbox for an agent that has no live/durable presence identity.  Keep
  // that invariant in the custom-role fixture instead of bypassing it merely
  // to exercise the declared relationship.
  const derivedRegistry = { agents: {
    'release-worker': { agentId: 'release-worker', role: 'worker' },
    'watcher-worker': { agentId: 'watcher-worker', role: 'worker' }
  } };
  equal(wake.assertWakeAuthorized({
    from: 'release-a', target: 'release-worker', org: derivedOrg, registry: derivedRegistry
  }).role, 'release-captain', 'a manager-derived customer role has ordinary authority over its declared descendant');
  throwsCode(() => wake.assertWakeAuthorized({
    from: 'release-a', target: 'watcher-worker', org: derivedOrg, registry: derivedRegistry
  }), 'AGENT_WAKE_OUTSIDE_TOPOLOGY');
  throwsCode(() => wake.assertWakeAuthorized({
    from: 'watcher-a', target: 'watcher-worker', org: derivedOrg, registry: derivedRegistry
  }), 'AGENT_WAKE_ROLE_READ_ONLY');

  const queued = await wake.wakeAgent({
    agentId: 'worker-a', from: 'manager-a', prompt: 'Continue at the next safe boundary.', requestId: 'queue-running-1'
  }, { stateFile, mailboxDir, launchDir, org, isAlive: () => true, clock: () => 2_000 });
  equal(queued.action, 'queued', 'a live lane is queued rather than interrupted');
  match(queued.message, /running codex lane/, 'live wake diagnostic names the observed lane kind');
  match(queued.message, /cannot be interrupted/, 'live-lane output states the honest interruption limit');
  equal(presence.drainMailbox('worker-a', 0, { mailboxDir }).entries.length, 1, 'queued direction is durable');

  await rejectsCode(() => wake.wakeAgent({
    agentId: 'manager-a', from: 'worker-a', prompt: 'Wake upward.', requestId: 'worker-upward-1'
  }, { stateFile, mailboxDir, launchDir, org, isAlive: () => true }), 'AGENT_WAKE_NOT_SUPERVISOR');
  equal(presence.drainMailbox('manager-a', 0, { mailboxDir }).entries.length, 0, 'refused worker-to-manager wake writes no mailbox entry');
  await rejectsCode(() => wake.wakeAgent({
    agentId: 'worker-a', from: 'manager-a', prompt: 'Bearer abcdefghijklmnopqrstuvwxyz123456', requestId: 'secret-wake-1'
  }, { stateFile, mailboxDir, launchDir, org, isAlive: () => true }), 'AGENT_PRESENCE_SECRET_REJECTED');
  equal(presence.drainMailbox('worker-a', 0, { mailboxDir }).entries.length, 1, 'secret-shaped direction is not appended');

  const parsed = wake.parseWakeArgs(['--agent', 'worker-a', '--prompt', 'Queued via environment.'], { TOOLSENABLED_AGENT_ID: 'manager-a' });
  equal(parsed.input.from, 'manager-a', 'wake CLI derives its lane identity from the runner environment');
  equal(manager.runId === worker.runId, false, 'presence records remain owned by distinct run ids');
}

async function respawnReservationTests(directory) {
  const stateFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const launchDir = path.join(directory, 'launch');
  const org = testOrg();
  const failed = baseRecord(directory, 'worker-a', {
    status: 'failed', exitCode: 7, terminalAt: 3_000, lastHeartbeat: 3_000, pid: 777,
    lastVerdict: 'VERDICT: failed for the reservation test'
  });
  writeLaunchFixture(failed);
  presence.register(failed, { file: stateFile });
  const launches = [];
  const result = await wake.wakeAgent({
    agentId: 'worker-a', from: 'manager-a', prompt: 'Resume the bounded fixture.', requestId: 'respawn-1', respawnIfDead: true
  }, {
    stateFile, mailboxDir, launchDir, org, isAlive: () => false, clock: () => 4_000,
    awaitRegistration: false,
    launchLane: async (spec, count) => { launches.push({ spec, count }); return { pid: 333 }; }
  });
  equal(result.action, 'respawned', 'terminal lane is relaunched when explicitly requested');
  equal(result.respawn.respawnCount, 1, 'first respawn increments the durable count');
  equal(launches.length, 1, 'one lane-run launch is issued');
  equal(launches[0].spec.brief, failed.brief, 'respawn preserves the brief');
  equal(launches[0].spec.worktree, failed.worktree, 'respawn preserves the worktree');
  check(Boolean(launches[0].spec.checkpoint), 'respawn carries the checkpoint');
  check(fs.existsSync(wake.reservationFile('worker-a', launchDir)), 'unconfirmed launch has a durable anti-duplicate reservation');

  const second = await wake.wakeAgent({
    agentId: 'worker-a', from: 'manager-a', prompt: 'Do not duplicate the relaunch.', requestId: 'respawn-2', respawnIfDead: true
  }, {
    stateFile, mailboxDir, launchDir, org, isAlive: pid => pid === 333, clock: () => 4_001,
    awaitRegistration: false,
    launchLane: async () => { launches.push('duplicate'); return { pid: 334 }; }
  });
  equal(second.action, 'queued', 'an alive respawn reservation is treated as an in-flight lane');
  equal(second.condition, 'respawn-starting', 'reservation condition is explicit');
  equal(launches.length, 1, 'reservation prevents a duplicate relaunch');

  const args = wake.laneRunArguments(launches[0].spec, 1);
  check(args.includes('--checkpoint'), 'lane-run arguments include the checkpoint');
  check(args.includes('--respawn-count'), 'lane-run arguments include the incremented counter');
}

async function sweepTests(directory) {
  const stateFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const launchDir = path.join(directory, 'launch');
  const records = [
    baseRecord(directory, 'live-stale', { pid: 101, lastHeartbeat: 1_000 }),
    baseRecord(directory, 'dead-stale', { pid: 102, lastHeartbeat: 1_000 }),
    baseRecord(directory, 'unknown-stale', { pid: null, status: 'starting', lastHeartbeat: 1_000 }),
    baseRecord(directory, 'failed-lane', {
      pid: 103, status: 'failed', exitCode: 5, terminalAt: 90_000, lastHeartbeat: 90_000,
      lastVerdict: 'VERDICT: bounded failure'
    }),
    baseRecord(directory, 'finished-lane', {
      pid: 104, status: 'finished', exitCode: 0, terminalAt: 90_000, lastHeartbeat: 90_000,
      lastVerdict: 'VERDICT: bounded success'
    })
  ];
  for (const record of records) presence.register(record, { file: stateFile });
  const packets = [];
  const result = await wake.sweepAgents({ autoWake: 'off', staleMs: 10_000 }, {
    stateFile, mailboxDir, launchDir, clock: () => 100_000,
    isAlive: pid => pid === 101,
    recordFindings: async packet => { packets.push(packet); return { stored: true }; }
  });
  equal(result.counts.scanned, 5, 'one bounded pass scans each snapshot record once');
  equal(result.deadStale.length, 1, 'dead process is reported separately');
  equal(result.deadStale[0].agentId, 'dead-stale', 'the dead process is identified');
  equal(result.heartbeatFaults.length, 1, 'alive process with stale heartbeat is a distinct fault');
  equal(result.heartbeatFaults[0].agentId, 'live-stale', 'the alive heartbeat fault is identified');
  equal(result.unknownLiveness.length, 1, 'missing pid remains unknown rather than dead or healthy');
  equal(result.failures.length, 1, 'failed lanes are listed with terminal evidence');
  equal(result.failures[0].exitCode, 5, 'failed lane exit code is retained');
  equal(result.terminalVerdicts.length, 2, 'unconsumed terminal verdicts are listed');
  equal(packets.length, 1, 'one sweep writes one bounded agent-coord packet');
  equal(packets[0].counts.heartbeatFaults, 1, 'persisted packet carries the heartbeat-fault count');
  equal(presence.readRegistry(stateFile).agents['dead-stale'].status, 'stale', 'verified dead process is marked stale');
  check(presence.readRegistry(stateFile).agents['finished-lane'].verdictConsumedAt !== null, 'persisted terminal verdict is marked consumed');

  const memoryStore = createStateStore({ file: ':memory:', ownerId: 'agent-sweep-memory-test' });
  try {
    const saved = await wake.persistSweepFindings(result, {
      memoryDependencies: { state: memoryStore, auditRecord: () => {} }
    });
    equal(saved.result.namespace, 'agent-coord', 'default sweep persistence uses the central agent-coord namespace');
    const key = `sweep/${new Date(result.at).toISOString()}`;
    equal(memoryStore.getMemory({ namespace: 'agent-coord', key }).value.counts.deadStale, 1, 'agent-coord retains the bounded sweep finding');
  } finally {
    memoryStore.close();
  }
}

async function boundedVerdictConsumptionTest(directory) {
  const stateFile = path.join(directory, 'presence.json');
  const packets = [];
  for (let index = 0; index < 6; index += 1) {
    presence.register(baseRecord(directory, `terminal-${index}`, {
      status: 'finished',
      exitCode: 0,
      terminalAt: 90_000,
      lastHeartbeat: 90_000,
      lastVerdict: `VERDICT: ${String(index).repeat(500)}`
    }), { file: stateFile });
  }
  await wake.sweepAgents({ autoWake: 'off', staleMs: 10_000 }, {
    stateFile,
    clock: () => 100_000,
    maxMemoryBytes: 1_800,
    recordFindings: async packet => { packets.push(packet); return { stored: true }; }
  });
  equal(packets.length, 1, 'bounded verdict sweep persists one packet');
  check((packets[0].omitted.terminalVerdicts || 0) > 0, 'oversized verdict set is honestly omitted from the bounded packet');
  const records = Object.values(presence.readRegistry(stateFile).agents);
  const consumed = records.filter(record => record.verdictConsumedAt !== null).length;
  equal(consumed, packets[0].terminalVerdicts.length, 'only verdicts present in the durable packet are marked consumed');
  check(consumed < records.length, 'omitted verdicts remain unconsumed for a later sweep');
}

async function unreadableDurableTaskRefusalTest(directory) {
  const stateFile = path.join(directory, 'presence.json');
  presence.register(baseRecord(directory, 'task-read-failure', {
    pid: 105,
    currentTask: 'task-unreadable'
  }), { file: stateFile });
  let persisted = false;
  await rejectsCode(() => wake.sweepAgents({ autoWake: 'off', staleMs: 10_000 }, {
    stateFile,
    clock: () => 100_000,
    isAlive: () => false,
    getTask: async () => {
      const error = new Error('task store unavailable');
      error.code = 'EIO';
      throw error;
    },
    recordFindings: async () => { persisted = true; }
  }), 'AGENT_SWEEP_TASK_UNREADABLE');
  equal(persisted, false, 'a sweep with unreadable durable task evidence is not reported as measured');
}

async function missingVerdictRecoveryTest(directory) {
  const stateFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const launchDir = path.join(directory, 'launch');
  const org = testOrg();
  const finishedWithoutVerdict = baseRecord(directory, 'worker-a', {
    pid: 401,
    status: 'finished',
    exitCode: 0,
    terminalAt: 10_000,
    lastHeartbeat: 10_000,
    lastVerdict: null
  });
  writeLaunchFixture(finishedWithoutVerdict);
  presence.register(finishedWithoutVerdict, { file: stateFile });
  const launches = [];
  const result = await wake.sweepAgents({
    autoWake: 'checkpointed', from: 'manager-a', staleMs: 1_000
  }, {
    stateFile,
    mailboxDir,
    launchDir,
    org,
    clock: () => 20_000,
    isAlive: () => false,
    awaitRegistration: false,
    launchLane: async (spec, count) => { launches.push({ spec, count }); return { pid: 501 }; },
    recordFindings: async () => ({ stored: true })
  });
  equal(result.failures.length, 1, 'finished without a verdict is a sweep failure');
  equal(result.failures[0].code, 'AGENT_SWEEP_MISSING_VERDICT', 'missing verdict has a typed failure code');
  equal(result.respawns.length, 1, 'missing-verdict lane is eligible for checkpointed recovery');
  equal(launches.length, 1, 'missing-verdict lane gets one relaunch attempt');
  check(Boolean(launches[0].spec.checkpoint), 'missing-verdict relaunch keeps the checkpoint source');
}

async function nonTerminalTaskRecoveryTest(directory) {
  const stateFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const launchDir = path.join(directory, 'launch');
  const org = testOrg();
  const store = createStateStore({ file: ':memory:', ownerId: 'agent-wake-nonterminal-task-test' });
  const taskDependencies = { state: store, auditRecord: () => {} };
  try {
    const queue = 'agent-wake-nonterminal-task';
    await tasks.submit({
      queue,
      type: 'codex-agent-lane',
      idempotencyKey: 'agent-wake-nonterminal-task-1',
      payload: { title: 'wake test', objective: 'exercise a durable lane task', context: '{}' },
      maxAttempts: 1
    }, taskDependencies);
    const claimed = await tasks.claim({
      queue,
      types: ['codex-agent-lane'],
      workerLabel: 'worker-a',
      leaseSeconds: 30
    }, taskDependencies);
    await tasks.start({ handle: claimed.handle, leaseSeconds: 30 }, taskDependencies);
    const taskId = claimed.handle.taskId;
    const finishedPresence = baseRecord(directory, 'worker-a', {
      pid: 402,
      status: 'finished',
      exitCode: 0,
      terminalAt: 10_000,
      lastHeartbeat: 10_000,
      lastVerdict: 'VERDICT: child exited before its durable task closed',
      currentTask: taskId
    });
    writeLaunchFixture(finishedPresence);
    presence.register(finishedPresence, { file: stateFile });
    const launches = [];
    const result = await wake.sweepAgents({
      autoWake: 'checkpointed', from: 'manager-a', staleMs: 1_000
    }, {
      stateFile,
      mailboxDir,
      launchDir,
      org,
      clock: () => 20_000,
      isAlive: () => false,
      taskDependencies,
      awaitRegistration: false,
      launchLane: async (spec, count) => { launches.push({ spec, count }); return { pid: 502 }; },
      recordFindings: async () => ({ stored: true })
    });
    equal(result.deadStale.length, 1, 'dead pid with a non-terminal durable lane task is reported');
    equal(result.deadStale[0].kind, 'dead-process-nonterminal-lane-task', 'durable task mismatch has its own finding kind');
    equal(result.deadStale[0].currentTask, taskId, 'finding identifies the durable task without its lease secret');
    equal(result.deadStale[0].taskStatus, 'running', 'finding preserves the non-terminal durable task status');
    equal(result.respawns.length, 1, 'dead lane with a non-terminal task is checkpoint-relaunched');
    check(Boolean(launches[0].spec.checkpoint), 'non-terminal-task recovery uses the checkpoint');
  } finally {
    store.close();
  }
}

async function durableRespawnFailureEscalationTest(directory) {
  const stateFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const launchDir = path.join(directory, 'launch');
  const org = testOrg();
  const failed = baseRecord(directory, 'worker-a', {
    pid: 403,
    status: 'failed',
    exitCode: 1,
    terminalAt: 10_000,
    lastHeartbeat: 10_000,
    lastVerdict: 'VERDICT: fixture failed before recovery'
  });
  writeLaunchFixture(failed);
  presence.register(failed, { file: stateFile });
  const first = await wake.sweepAgents({
    autoWake: 'checkpointed', from: 'manager-a', staleMs: 1_000
  }, {
    stateFile,
    mailboxDir,
    launchDir,
    org,
    clock: () => 20_000,
    isAlive: () => false,
    awaitRegistration: false,
    launchLane: async () => {
      const error = new Error('fixture spawn failed');
      error.code = 'TEST_RESPAWN_SPAWN_ERROR';
      throw error;
    },
    recordFindings: async () => ({ stored: true })
  });
  check(first.escalations.some(item => item.code === 'TEST_RESPAWN_SPAWN_ERROR'), 'spawn failure is an escalation in its originating sweep');
  const reservation = wake.readReservation('worker-a', { launchDir }).reservation;
  equal(reservation.status, 'failed', 'spawn failure is stored in the durable respawn reservation');
  equal(reservation.failureCode, 'TEST_RESPAWN_SPAWN_ERROR', 'durable reservation records the typed spawn failure');

  const second = await wake.sweepAgents({
    autoWake: 'checkpointed', from: 'manager-a', staleMs: 1_000
  }, {
    stateFile,
    mailboxDir,
    launchDir,
    org,
    clock: () => 30_000,
    isAlive: () => false,
    awaitRegistration: false,
    launchLane: async () => ({ pid: 503 }),
    recordFindings: async () => ({ stored: true })
  });
  check(second.escalations.some(item => item.code === 'TEST_RESPAWN_SPAWN_ERROR' && item.durable === true),
    'the next sweep re-surfaces the unresolved durable respawn failure');
  equal(second.respawns.length, 1, 're-surfacing the failure does not suppress the bounded retry');
}

async function crashLoopCapTest(directory) {
  const stateFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const launchDir = path.join(directory, 'launch');
  const org = testOrg();
  const failed = baseRecord(directory, 'worker-a', {
    status: 'failed', exitCode: 9, terminalAt: 10_000, lastHeartbeat: 10_000, pid: 999, respawnCount: 0
  });
  writeLaunchFixture(failed);
  presence.register(failed, { file: stateFile });
  presence.writeAtomic(wake.reservationFile('worker-a', launchDir), {
    schemaVersion: 1,
    agentId: 'worker-a',
    priorRunId: failed.runId,
    pid: null,
    respawnCount: 2,
    startedAt: 15_000,
    status: 'failed',
    failureCode: 'AGENT_WAKE_RESPAWN_FAILED'
  });
  let launches = 0;
  const result = await wake.sweepAgents({
    autoWake: 'checkpointed', from: 'manager-a', maxRespawns: 2, staleMs: 1_000
  }, {
    stateFile, mailboxDir, launchDir, org, clock: () => 20_000, isAlive: () => false,
    launchLane: async () => { launches += 1; return { pid: 555 }; },
    awaitRegistration: false,
    recordFindings: async () => ({ stored: true })
  });
  equal(result.respawns.length, 0, 'crash-looping lane is not respawned past the cap');
  equal(launches, 0, 'cap prevents the process launch itself');
  equal(result.escalations.length, 2, 'prior failed wakeup and crash cap are both surfaced');
  check(result.escalations.some(item => item.code === 'AGENT_WAKE_RESPAWN_FAILED' && item.durable === true),
    'durable prior wake failure is re-surfaced before a capped retry');
  const cap = result.escalations.find(item => item.code === 'AGENT_SWEEP_RESPAWN_CAP');
  check(Boolean(cap), 'crash-loop escalation is typed');
  equal(cap.respawnCount, 2, 'pre-registration failures remain counted durably');

  fs.writeFileSync(failed.launchSpec, '{not-json', 'utf8');
  await rejectsCode(() => wake.wakeAgent({
    agentId: 'worker-a', from: 'manager-a', prompt: 'Attempt strict relaunch.', requestId: 'invalid-spec', respawnIfDead: true
  }, { stateFile, mailboxDir, launchDir, org, isAlive: () => false }), 'AGENT_WAKE_SOURCE_INVALID');
}

async function boundedPassRespawnTest(directory) {
  const stateFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const launchDir = path.join(directory, 'launch');
  const org = testOrg();
  for (const agentId of ['worker-one', 'worker-two']) {
    const failed = baseRecord(directory, agentId, {
      reportsTo: 'manager-a',
      dispatcher: 'manager-a',
      status: 'failed',
      exitCode: 6,
      terminalAt: 10_000,
      lastHeartbeat: 10_000,
      pid: 800
    });
    writeLaunchFixture(failed);
    presence.register(failed, { file: stateFile });
  }
  let launches = 0;
  const result = await wake.sweepAgents({
    autoWake: 'checkpointed',
    from: 'manager-a',
    maxRespawns: 3,
    maxAutoRespawns: 1,
    staleMs: 1_000
  }, {
    stateFile,
    mailboxDir,
    launchDir,
    org,
    clock: () => 20_000,
    isAlive: () => false,
    launchLane: async () => { launches += 1; return { pid: 600 + launches }; },
    awaitRegistration: false,
    recordFindings: async () => ({ stored: true })
  });
  equal(launches, 1, 'one bounded sweep honors its per-pass automatic launch cap');
  equal(result.respawns.length, 1, 'only one recovery is started in the capped pass');
  equal(result.escalations.length, 1, 'remaining recoverable work is escalated rather than hidden');
  equal(result.escalations[0].code, 'AGENT_SWEEP_PASS_RESPAWN_CAP', 'per-pass cap escalation is typed');
}

function secretFree(text) {
  const patterns = [
    /sk_live_[A-Za-z0-9]+/,
    /sk-[A-Za-z0-9]{20,}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
    /claimToken/
  ];
  return patterns.every(pattern => !pattern.test(text));
}

async function endToEndKilledLaneTest(directory) {
  const stateFile = path.join(directory, 'state', 'agent-presence.json');
  const mailboxDir = path.join(directory, 'state', 'agent-mailbox');
  const launchDir = path.join(directory, 'state', 'agent-launch');
  const durableState = path.join(directory, 'state', 'toolsenabled.sqlite3');
  const auditDb = path.join(directory, 'state', 'audit.sqlite3');
  const worktree = path.join(directory, 'worktree');
  const brief = path.join(worktree, 'brief.md');
  const checkpoint = path.join(worktree, 'checkpoint.md');
  const promptCapture = path.join(directory, 'logs', 'captured-prompt.txt');
  const consoleLog = path.join(directory, 'logs', 'lane.log');
  const agentId = 'wake-fixture-worker';
  const controllerActor = 'controller';
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.dirname(consoleLog), { recursive: true });

  // This case spawns the REAL wake CLI, so unlike every in-process case above it
  // cannot hand `org` in as an argument -- the CLI loads a file. Left to itself
  // it reads config/agent-org.json, which would make the test depend on an
  // installation's current controller. Pointing at a neutral fixture keeps the
  // assertion about wake authorization instead of one historical controller.
  // Pointing --org-file at a fixture the case writes itself keeps the assertion
  // about wake authorization instead of about the contents of a shipped config,
  // so re-organizing the real org can no longer forge a failure here.
  const orgFile = path.join(directory, 'agent-org.json');
  fs.writeFileSync(orgFile, JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    agents: [
      {
        id: controllerActor,
        displayName: 'Controller',
        role: 'controller',
        provider: 'none',
        enabled: true,
        assignedPhase: null,
        phasePriority: []
      },
      {
        id: agentId,
        displayName: 'Killed Lane Worker',
        role: 'worker',
        provider: 'codex',
        enabled: true,
        assignedPhase: null,
        phasePriority: []
      }
    ],
    relationships: [{ from: controllerActor, to: agentId, type: 'manages' }]
  }), 'utf8');
  fs.writeFileSync(brief, 'Execute only this bounded killed-lane fixture.\n', 'utf8');
  fs.writeFileSync(checkpoint, 'checkpoint-marker-r1146\n', 'utf8');
  const env = {
    ...process.env,
    TOOLSENABLED_LANE_RUN_TEST: '1',
    TOOLSENABLED_STATE_PATH: durableState,
    TOOLSENABLED_AUDIT_DB: auditDb,
    TOOLSENABLED_AUDIT_JSONL_PATH: path.join(directory, 'logs', 'audit.jsonl'),
    TOOLSENABLED_AUDIT_TEXT_PATH: path.join(directory, 'logs', 'audit.log'),
    TOOLSENABLED_AUDIT_EMERGENCY_PATH: path.join(directory, 'logs', 'audit-emergency.jsonl'),
    TOOLSENABLED_AGENT_PRESENCE_FILE: stateFile,
    TOOLSENABLED_AGENT_MAILBOX_DIR: mailboxDir,
    TOOLSENABLED_AGENT_LAUNCH_DIR: launchDir
  };
  const laneArgs = [
    '--agent', agentId,
    '--role', 'worker',
    '--tier', 'gpt-5.6-terra',
    '--reports-to', controllerActor,
    '--dispatcher', controllerActor,
    '--lane', 'killed-lane-e2e',
    '--territory', 'tests/fixtures/agent-wake-lane.js',
    '--brief', brief,
    '--worktree', worktree,
    '--console-log', consoleLog,
    '--checkpoint', checkpoint,
    '--heartbeat-ms', '1000',
    '--lease-seconds', '30',
    '--', process.execPath, LANE_FIXTURE, promptCapture
  ];
  let initial;
  let initialLanePid = null;
  try {
    initial = processRun(LANE_RUN, laneArgs, env);
    const running = await waitFor(
      () => presence.readRegistry(stateFile).agents[agentId],
      record => record && record.status === 'running' && Number.isSafeInteger(record.pid),
      'initial lane running'
    );
    initialLanePid = running.pid;
    check(typeof running.currentTask === 'string', 'initial lane owns a durable task before child work');
    killIfAlive(initialLanePid);
    const initialResult = await Promise.race([
      initial.done,
      // Same calibration as waitFor: the wrapper has to notice a killed child,
      // write its terminal record and exit, on a machine where lane startup
      // alone measured up to 24_652ms.
      delay(60_000).then(() => { throw new Error('Initial killed lane wrapper did not terminate.'); })
    ]);
    equal(initialResult.code, 1, 'deliberately killed child makes lane-run exit nonzero');
    const failed = presence.readRegistry(stateFile).agents[agentId];
    equal(failed.status, 'failed', 'deliberately killed lane lands a failed terminal record');
    equal(failed.exitCode, 1, 'killed lane records an honest nonzero exit code');
    const priorRunId = failed.runId;

    const sweep = await wake.sweepAgents({ autoWake: 'off', staleMs: 1_000 }, {
      stateFile, mailboxDir, launchDir,
      recordFindings: async packet => ({ key: `sweep/${packet.at}` })
    });
    equal(sweep.failures.some(item => item.agentId === agentId), true, 'sweep detects the deliberately killed lane');

    const cli = processRun(WAKE_CLI, [
      '--from', controllerActor,
      '--agent', agentId,
      '--prompt', 'resume-after-deliberate-kill',
      '--request-id', 'e2e-authorized-respawn',
      '--respawn-if-dead',
      '--org-file', orgFile,
      // Same measurement as waitFor above: a lane needs 12.5s-24.7s to register
      // on this machine, so a 15000ms startup budget made the CLI give up on a
      // respawn that was still coming and the run failed on the /^RESPAWNED:/
      // match instead. 60000 is the CLI's own documented ceiling for this flag.
      '--startup-timeout-ms', '60000'
    ], env);
    const cliResult = await Promise.race([
      cli.done,
      // Must stay STRICTLY GREATER than the --startup-timeout-ms handed to that
      // CLI above, or this race kills the CLI while it is still legitimately
      // waiting and the run reports "CLI timed out" for a respawn that was
      // working. At 20_000 against a 60_000 startup budget it did exactly that.
      delay(90_000).then(() => { killIfAlive(cli.child.pid); throw new Error('agent-wake CLI timed out.'); })
    ]);
    equal(cliResult.code, 0, `authorized wake CLI succeeds: ${cliResult.stderr}`);
    match(cliResult.stdout, /^RESPAWNED:/,
      `wake CLI confirms the lane-run registration; stdout=${JSON.stringify(cliResult.stdout)} `
      + `stderr=${JSON.stringify(cliResult.stderr)}`);

    const terminal = await waitFor(
      () => presence.readRegistry(stateFile).agents[agentId],
      record => record && record.runId !== priorRunId && record.status === 'finished',
      'respawned lane terminal success'
    );
    equal(terminal.exitCode, 0, 'respawned lane exits successfully');
    equal(terminal.respawnCount, 1, 'respawned presence carries the incremented counter');
    equal(terminal.lastVerdict, 'VERDICT: respawn received checkpoint and queued direction', 'respawned lane reports the expected verdict');
    const captured = fs.readFileSync(promptCapture, 'utf8');
    match(captured, /CHECKPOINT FROM THE PRIOR RUN/, 'respawn prompt carries the checkpoint boundary');
    match(captured, /checkpoint-marker-r1146/, 'respawn prompt carries checkpoint content');
    match(captured, /SUPERVISOR DIRECTIVES SINCE YOUR LAST RUN/, 'respawn prompt carries the supervisor boundary');
    match(captured, /resume-after-deliberate-kill/, 'respawn prompt carries the queued direction');
    equal(presence.drainMailbox(agentId, terminal.mailboxOffset, { mailboxDir }).entries.length, 0, 'respawn advances the mailbox offset without replay');

    await waitFor(
      () => fs.existsSync(`${consoleLog}.wrapper.log`) ? fs.readFileSync(`${consoleLog}.wrapper.log`, 'utf8') : '',
      text => text.includes('"status":"finished"'),
      'respawn wrapper terminal receipt'
    );
    const store = createStateStore({ file: durableState, ownerId: 'agent-wake-e2e-reader' });
    try {
      const taskList = await tasks.list({ limit: 10 }, { state: store, auditRecord: () => {} });
      equal(taskList.count, 2, 'initial and respawned runs each own one durable task');
      deepEqual(taskList.tasks.map(item => item.status).sort(), ['failed', 'succeeded'], 'task terminal states preserve killed failure and respawn success');
      check(taskList.tasks.every(item => item.attempt === 1), 'each lane task remains single-attempt and fenced');
    } finally {
      store.close();
    }

    const textFiles = [
      stateFile,
      presence.mailboxFile(agentId, mailboxDir),
      presence.launchSpecFile(agentId, launchDir),
      consoleLog,
      `${consoleLog}.wrapper.log`,
      promptCapture
    ];
    for (const file of textFiles) {
      check(secretFree(fs.readFileSync(file, 'utf8')), `${path.basename(file)} contains no credential-like data or claim token`);
    }
  } finally {
    killIfAlive(initialLanePid);
    if (initial) killIfAlive(initial.child.pid);
    try {
      const registry = presence.readRegistry(stateFile);
      for (const record of Object.values(registry.agents)) killIfAlive(record.pid);
    } catch { /* state may not have been created */ }
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-test-'));
  try {
    builderLaunchSpecTests(path.join(root, 'builder-role'));
    await authorizationAndQueueTests(path.join(root, 'authorization'));
    await respawnReservationTests(path.join(root, 'reservation'));
    await sweepTests(path.join(root, 'sweep'));
    await boundedVerdictConsumptionTest(path.join(root, 'bounded-verdicts'));
    await unreadableDurableTaskRefusalTest(path.join(root, 'unreadable-task'));
    await missingVerdictRecoveryTest(path.join(root, 'missing-verdict'));
    await nonTerminalTaskRecoveryTest(path.join(root, 'nonterminal-task'));
    await durableRespawnFailureEscalationTest(path.join(root, 'durable-respawn-failure'));
    await crashLoopCapTest(path.join(root, 'crash-cap'));
    await boundedPassRespawnTest(path.join(root, 'pass-cap'));
    await endToEndKilledLaneTest(path.join(root, 'e2e'));
    process.stdout.write(`agent wake/sweep: ${assertions} assertions passed\n`);
  } finally {
    // Cleanup must never become the reported cause. Windows keeps the lane's
    // SQLite files locked for a while after the child exits, so this throws
    // EBUSY often enough to matter -- and thrown from a finally it REPLACES
    // whatever the suite actually failed on. Observed doing exactly that: a run
    // whose real failure was a slow lane reported only
    // "EBUSY: resource busy or locked, unlink ...\\e2e\\state\\audit.sqlite3".
    // Report it, never raise it.
    try { await removeTreeEventually(root); }
    catch (error) {
      process.stderr.write(`warning: temp tree ${root} could not be removed: ${error && error.code}\n`);
    }
  }
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
