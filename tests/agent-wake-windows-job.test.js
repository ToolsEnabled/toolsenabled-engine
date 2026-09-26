'use strict';

// Durable wake is a separate process path from an app dispatch:
// agent-wake -> tools/lane-run.js -> agent-lane.  This real Windows test keeps
// the respawned child alive long enough to prove that path owns a registered
// Job Object, publishes the exact wrapper creation identity into presence, and
// can be terminated through the default cross-process control implementation.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const isolated = require('./lib/isolated-environment');

assert.equal(process.platform, 'win32', 'durable wake containment is a Windows release contract');

const root = fs.mkdtempSync(path.join(isolated.isolatedTemporaryRoot(), 'toolsenabled-wake-job-'));
isolated.configure(root, process.env);
process.env.TOOLSENABLED_LANE_RUN_TEST = '1';
process.env.TOOLSENABLED_AGENT_PRESENCE_FILE = path.join(root, 'presence.json');
process.env.TOOLSENABLED_AGENT_MAILBOX_DIR = path.join(root, 'mailbox');
process.env.TOOLSENABLED_AGENT_LAUNCH_DIR = path.join(root, 'launch');

// Load state-owning product modules only after the isolated state root exists.
const agentOrg = require('../src/lib/agent-org');
const presence = require('../src/lib/agent-presence');
const wake = require('../src/lib/agent-wake');
const termination = require('../src/lib/mission-bridge/termination');
const jobs = require('../src/lib/windows-job-control');

const AGENT_ID = 'wake-job-worker';
const MANAGER_ID = 'wake-job-manager';
const CONTROLLER_ID = 'wake-job-controller';

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(read, accept, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    try {
      last = read();
      if (accept(last)) return last;
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}; last=${last?.message || JSON.stringify(last)}`);
}

async function removeEventually(directory) {
  const resolved = path.resolve(directory);
  assert.equal(resolved, root, 'cleanup is bounded to the exact isolated root');
  let lastError = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); return; }
    catch (error) {
      lastError = error;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function writePriorRun() {
  const stateFile = process.env.TOOLSENABLED_AGENT_PRESENCE_FILE;
  const worktree = path.join(root, 'worktree');
  const brief = path.join(worktree, 'brief.md');
  const consoleLog = path.join(root, 'logs', 'lane.log');
  const launchSpec = path.join(root, 'launch', `${AGENT_ID}.json`);
  const readyFile = path.join(root, 'real-child.ready');
  const runId = crypto.randomUUID();
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(brief, 'Remain alive until the exact Job Object termination request arrives.\n', 'utf8');

  const prior = presence.register({
    agentId: AGENT_ID,
    runId,
    kind: 'test-node',
    role: 'worker',
    tier: 'test-node/windows-job',
    reportsTo: MANAGER_ID,
    dispatcher: MANAGER_ID,
    lane: 'durable-wake-job-test',
    territory: 'tests/agent-wake-windows-job.test.js',
    currentTask: null,
    brief,
    consoleLog,
    worktree,
    launchSpec,
    pid: null,
    startedAt: 1_000,
    lastHeartbeat: 2_000,
    status: 'failed',
    exitCode: 1,
    lastVerdict: 'VERDICT: prior run failed',
    terminalAt: 2_000,
    staleReason: null,
    mailboxOffset: 0,
    respawnCount: 0,
    verdictConsumedAt: null
  }, { file: stateFile });

  const childProgram = [
    "const fs = require('node:fs');",
    "process.stdin.resume();",
    `process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid), 'utf8'); setInterval(() => {}, 1000); });`
  ].join('');
  presence.writeAtomic(launchSpec, {
    schemaVersion: 1,
    agentId: AGENT_ID,
    runId,
    kind: 'test-node',
    role: prior.role,
    tier: prior.tier,
    reportsTo: prior.reportsTo,
    dispatcher: prior.dispatcher,
    lane: prior.lane,
    territory: prior.territory,
    brief,
    worktree,
    consoleLog,
    checkpoint: null,
    heartbeatMs: 1_000,
    leaseSeconds: 30,
    respawnCount: 0,
    command: process.execPath,
    childArgs: ['-e', childProgram]
  });
  return { prior, readyFile, stateFile };
}

async function main() {
  const { prior, readyFile, stateFile } = writePriorRun();
  const org = agentOrg.normalizeOrg({
    schemaVersion: 1,
    revision: 1,
    agents: [
      { id: CONTROLLER_ID, displayName: 'Wake Job Controller', role: 'controller', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] },
      { id: MANAGER_ID, displayName: 'Wake Job Manager', role: 'manager', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] },
      { id: AGENT_ID, displayName: 'Wake Job Worker', role: 'worker', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] }
    ],
    relationships: [
      { from: CONTROLLER_ID, to: MANAGER_ID, type: 'manages' },
      { from: MANAGER_ID, to: AGENT_ID, type: 'manages' }
    ]
  });
  let respawn = null;
  let running = null;
  try {
    respawn = await wake.wakeAgent({
      from: MANAGER_ID,
      agentId: AGENT_ID,
      prompt: 'Resume inside the retained Windows job.',
      requestId: 'wake-job-object-regression',
      respawnIfDead: true
    }, {
      org,
      stateFile,
      mailboxDir: process.env.TOOLSENABLED_AGENT_MAILBOX_DIR,
      launchDir: process.env.TOOLSENABLED_AGENT_LAUNCH_DIR,
      startupTimeoutMs: 30_000
    });
    assert.equal(respawn.action, 'respawned');
    assert.equal(respawn.respawn.registrationConfirmed, true);
    assert.notEqual(respawn.respawn.runId, prior.runId);

    running = await waitFor(
      () => presence.readRegistry(stateFile).agents[AGENT_ID],
      record => record?.status === 'running'
        && typeof record.processStartTicks === 'string'
        && fs.existsSync(readyFile),
      'woken lane Job Object registration'
    );
    assert.match(running.processStartTicks, /^[1-9]\d{0,19}$/);
    const identity = jobs.readIdentity(running.pid);
    assert.equal(identity.wrapperPid, running.pid);
    assert.equal(identity.wrapperStartTicks, running.processStartTicks);
    assert.equal(identity.rootPid, Number(fs.readFileSync(readyFile, 'utf8')),
      'the retained job record names the real child reached through durable wake');

    const receipt = await termination.terminateWindowsTree(running.pid, {
      platform: 'win32',
      expectedStartTicks: running.processStartTicks
    });
    assert.equal(receipt.type, 'terminated');
    assert.equal(receipt.activeProcesses, 0);

    const terminal = await waitFor(
      () => presence.readRegistry(stateFile).agents[AGENT_ID],
      record => record?.runId === running.runId && record.status === 'failed',
      'woken lane terminal presence'
    );
    assert.equal(terminal.processStartTicks, running.processStartTicks,
      'terminal presence retains the exact creation identity used by termination');
    await waitFor(() => alive(respawn.respawn.pid), value => value === false, 'durable lane-run wrapper exit');
    assert.throws(() => jobs.readIdentity(running.pid), error => error?.code === 'WINDOWS_JOB_NOT_REGISTERED',
      'the job identity is removed only after the contained wrapper closes');
    process.stdout.write('agent-wake Windows Job Object: durable respawn identity, registration, and termination passed\n');
  } finally {
    if (running && alive(running.pid)) {
      try {
        await termination.terminateWindowsTree(running.pid, {
          platform: 'win32', expectedStartTicks: running.processStartTicks
        });
      } catch { try { process.kill(running.pid, 'SIGTERM'); } catch {} }
    }
    if (respawn?.respawn?.pid && alive(respawn.respawn.pid)) {
      try { process.kill(respawn.respawn.pid, 'SIGTERM'); } catch {}
    }
    await removeEventually(root);
  }
}

main().catch(error => {
  process.stdout.write(`agent-wake Windows Job Object failure: ${String(error?.stack || error).replace(/[\r\n]+/g, ' | ')}\n`);
  process.exitCode = 1;
});
