'use strict';

// Built-in wake/sweep mechanics. A live agent lane has no inbound prompt
// channel: supervisors can queue a directive for its next boundary, while a
// dead or terminal lane can be relaunched through tools/lane-run.js.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const agentOrg = require('./agent-org');
const { createInstalledAgentOrgStores } = require('./agent-org-store');
const presence = require('./agent-presence');
const { isRequestId } = require('./request-id');
const fleetState = require('./fleet-supervisor/state');
const memory = require('./providers/memory');
const taskProvider = require('./providers/tasks');
const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ORG_FILE = path.join(ROOT, 'config', 'agent-org.json');
const DEFAULT_LANE_RUN_FILE = path.join(ROOT, 'tools', 'lane-run.js');
const DEFAULT_MAX_RESPAWNS = 3;
const DEFAULT_MAX_AUTO_RESPAWNS_PER_SWEEP = 3;
const DEFAULT_RESERVATION_STALE_MS = 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_USEFUL_PROGRESS_STALE_MS = 120_000;
const DEFAULT_SWEEP_PROMPT = 'Resume from the verified checkpoint and report a fresh terminal VERDICT.';
const AUTO_WAKE_POLICIES = Object.freeze(['off', 'failed', 'dead', 'checkpointed']);
const TERMINAL = new Set(['finished', 'failed']);
const LANE_TASK_TYPE = 'codex-agent-lane';
const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'uncertain', 'cancelled']);
const LAUNCH_SPEC_KEYS = new Set([
  'schemaVersion', 'agentId', 'runId', 'kind', 'role', 'tier', 'reportsTo', 'dispatcher', 'lane', 'territory',
  'directiveId', 'brief', 'worktree', 'consoleLog', 'checkpoint', 'heartbeatMs', 'leaseSeconds', 'respawnCount',
  'command', 'childArgs'
]);
const REQUIRED_LAUNCH_SPEC_KEYS = Object.freeze([...LAUNCH_SPEC_KEYS].filter(key => key !== 'kind' && key !== 'directiveId'));
const RESERVATION_KEYS = new Set([
  'schemaVersion', 'agentId', 'priorRunId', 'pid', 'respawnCount', 'startedAt', 'status', 'failureCode'
]);

class AgentWakeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AgentWakeError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new AgentWakeError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function integer(value, field, { min, max }) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail('AGENT_WAKE_INVALID', `${field} must be an integer from ${min} through ${max}.`, { field });
  }
  return parsed;
}

function safePath(value, field) {
  return path.resolve(presence.assertSafeString(value, field, { max: 4096 }));
}

function assertExactKeys(value, allowed, required, label) {
  if (!plain(value)) fail('AGENT_WAKE_STATE_INVALID', `${label} must be an object.`);
  const keys = Object.keys(value);
  const unknown = keys.filter(key => !allowed.has(key));
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    fail('AGENT_WAKE_STATE_INVALID', `${label} has an invalid shape.`, { unknown, missing });
  }
}

function readJson(file, label, fsImpl = fs) {
  let text;
  try { text = fsImpl.readFileSync(file, 'utf8'); }
  catch (error) {
    fail('AGENT_WAKE_SOURCE_UNREADABLE', `${label} could not be read: ${file}.`, { cause: error && error.code });
  }
  try { return JSON.parse(text); }
  catch { fail('AGENT_WAKE_SOURCE_INVALID', `${label} is not valid JSON: ${file}.`); }
}

function loadOrg(file = DEFAULT_ORG_FILE, { fsImpl = fs, knownRoles, orgStore, env = process.env } = {}) {
  if (orgStore && typeof orgStore.read === 'function') {
    try {
      const view = orgStore.read();
      if (view && view.damaged) throw Object.assign(new Error(view.damaged), { code: 'AGENT_ORG_STORE_DAMAGED' });
      return view && view.org ? view.org : view;
    } catch (error) {
      fail('AGENT_WAKE_ORG_INVALID', 'Installed agent org could not be read.', { cause: error && error.code });
    }
  }
  if (file === DEFAULT_ORG_FILE && fsImpl === fs && knownRoles === undefined) {
    try {
      return createInstalledAgentOrgStores({ baselineFile: file, env }).read().org;
    } catch (error) {
      // Source-checkout invocations do not have a selected installed-product
      // identity. They continue to use the checked-in baseline; an installed
      // overlay that is damaged or unreadable never silently falls back.
      if (!error || error.code !== 'SERVICE_PRODUCT_IDENTITY_UNAVAILABLE') {
        fail('AGENT_WAKE_ORG_INVALID', 'Installed agent org could not be read.', { cause: error && error.code });
      }
    }
  }
  const parsed = readJson(file, 'Declared agent org', fsImpl);
  try { return agentOrg.normalizeOrg(parsed, { knownRoles, maxAgents: 0 }); }
  catch (error) {
    fail('AGENT_WAKE_ORG_INVALID', 'Declared agent org failed validation.', { cause: error && error.code });
  }
}

function declaredAgent(org, agentId) {
  return org.agents.find(agent => agent.id === agentId) || null;
}

function observedAgent(registry, agentId) {
  return registry.agents[agentId] || null;
}

function roleOf(org, registry, agentId) {
  const declared = declaredAgent(org, agentId);
  if (declared) return declared.role;
  const observed = observedAgent(registry, agentId);
  return observed ? observed.role : null;
}

function supervisionEdges(org, registry) {
  const edges = new Map();
  const add = (supervisor, target) => {
    if (!supervisor || !target || supervisor === target) return;
    if (!edges.has(supervisor)) edges.set(supervisor, new Set());
    edges.get(supervisor).add(target);
  };
  for (const relation of org.relationships) {
    if (relation.type === 'manages') add(relation.from, relation.to);
  }
  for (const record of Object.values(registry.agents)) add(record.reportsTo, record.agentId);
  return edges;
}

function isDescendant(edges, supervisor, target) {
  const pending = [...(edges.get(supervisor) || [])];
  const seen = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(edges.get(current) || []));
  }
  return false;
}

function assertWakeAuthorized({ from, target, org, registry }) {
  const actorId = presence.assertAgentId(from, 'from');
  const targetId = presence.assertAgentId(target, 'target');
  const actorDeclared = declaredAgent(org, actorId);
  const targetDeclared = declaredAgent(org, targetId);
  const actorObserved = observedAgent(registry, actorId);
  const targetObserved = observedAgent(registry, targetId);
  if (!targetObserved) fail('AGENT_WAKE_TARGET_UNKNOWN', `No presence record exists for ${targetId}.`, { target: targetId });
  if (!actorDeclared && !actorObserved) fail('AGENT_WAKE_ACTOR_UNKNOWN', `Wake actor ${actorId} is not declared or observed.`, { from: actorId });
  if (actorDeclared && actorDeclared.enabled === false) {
    fail('AGENT_WAKE_ACTOR_DISABLED', `Wake actor ${actorId} is disabled in the declared org.`, { from: actorId });
  }
  if (targetDeclared && targetDeclared.enabled === false) {
    fail('AGENT_WAKE_TARGET_DISABLED', `Wake target ${targetId} is disabled in the declared org.`, { target: targetId });
  }
  if (actorId === targetId) fail('AGENT_WAKE_SELF_REFUSED', 'An agent cannot authorize its own wake.');
  const role = roleOf(org, registry, actorId);
  // Supervisory reach is a relationship, not a role name. The actor must be a
  // declared supervisor and its authoritative role definition must explicitly
  // permit waking reports. A name, including Shadow Manager, grants nothing.
  if (!actorDeclared || !agentOrg.isSupervisor(org, actorId)) {
    fail('AGENT_WAKE_NOT_SUPERVISOR', `${actorId} is not a declared supervisor and may not wake agents.`, {
      from: actorId,
      target: targetId,
      role
    });
  }
  if (!agentOrg.roleHasCapability(org, role, 'mayWakeReports')) {
    fail('AGENT_WAKE_ROLE_READ_ONLY', `${actorId} has read-only role ${role || 'unknown'} and may not wake agents.`, {
      from: actorId,
      target: targetId,
      role
    });
  }
  if (!isDescendant(supervisionEdges(org, registry), actorId, targetId)) {
    fail('AGENT_WAKE_OUTSIDE_TOPOLOGY', `${actorId} does not supervise ${targetId} in the declared/observed topology.`, {
      from: actorId,
      target: targetId,
      role
    });
  }
  return Object.freeze({ from: actorId, target: targetId, role, authorized: true });
}

function normalizeLaunchSpec(input, record) {
  assertExactKeys(input, LAUNCH_SPEC_KEYS, REQUIRED_LAUNCH_SPEC_KEYS, 'Launch spec');
  if (input.schemaVersion !== 1) fail('AGENT_WAKE_LAUNCH_SPEC_INVALID', 'Launch spec schemaVersion must be 1.');
  const role = presence.assertSafeString(input.role, 'launchSpec.role', { max: 40 });
  if (!agentOrg.ROLE_ID.test(role) || agentOrg.RESERVED_ROLE_IDS.includes(role)) {
    fail('AGENT_WAKE_LAUNCH_SPEC_INVALID', 'Launch spec role is not a safe declared-role identifier.');
  }
  if (!Array.isArray(input.childArgs) || input.childArgs.length > 128) {
    fail('AGENT_WAKE_LAUNCH_SPEC_INVALID', 'Launch spec childArgs must be an array of at most 128 entries.');
  }
  if (input.directiveId !== undefined && !isRequestId(input.directiveId)) {
    fail('AGENT_WAKE_LAUNCH_SPEC_INVALID', 'Launch spec directiveId must be a canonical R/Q request id when provided.');
  }
  const inferredRecordKind = record.kind
    || (String(record.tier || '').startsWith('claude/') ? 'claude' : 'codex');
  const spec = Object.freeze({
    schemaVersion: 1,
    agentId: presence.assertAgentId(input.agentId),
    runId: presence.assertSafeString(input.runId, 'launchSpec.runId', { max: 64 }),
    kind: input.kind === undefined
      ? inferredRecordKind
      : presence.assertSafeString(input.kind, 'launchSpec.kind', { max: 20 }),
    role,
    tier: presence.assertSafeString(input.tier, 'launchSpec.tier', { max: 120 }),
    reportsTo: presence.assertAgentId(input.reportsTo, 'launchSpec.reportsTo'),
    dispatcher: input.dispatcher === 'owner' ? 'owner' : presence.assertAgentId(input.dispatcher, 'launchSpec.dispatcher'),
    lane: presence.assertSafeString(input.lane, 'launchSpec.lane', { max: 120 }),
    territory: presence.assertSafeString(input.territory, 'launchSpec.territory'),
    ...(input.directiveId === undefined ? {} : { directiveId: input.directiveId }),
    brief: safePath(input.brief, 'launchSpec.brief'),
    worktree: safePath(input.worktree, 'launchSpec.worktree'),
    consoleLog: safePath(input.consoleLog, 'launchSpec.consoleLog'),
    checkpoint: input.checkpoint === null ? null : safePath(input.checkpoint, 'launchSpec.checkpoint'),
    heartbeatMs: integer(input.heartbeatMs, 'launchSpec.heartbeatMs', { min: 1000, max: 60_000 }),
    leaseSeconds: integer(input.leaseSeconds, 'launchSpec.leaseSeconds', {
      min: taskProvider.MIN_LEASE_SECONDS,
      max: taskProvider.MAX_LEASE_SECONDS
    }),
    respawnCount: integer(input.respawnCount, 'launchSpec.respawnCount', { min: 0, max: 100 }),
    command: presence.assertSafeString(input.command, 'launchSpec.command', { max: 1024 }),
    childArgs: Object.freeze(input.childArgs.map((arg, index) => presence.assertSafeString(arg, `launchSpec.childArgs[${index}]`, { max: 4096 })))
  });
  if (spec.agentId !== record.agentId || spec.runId !== record.runId) {
    fail('AGENT_WAKE_LAUNCH_SPEC_MISMATCH', 'Launch spec does not describe the target presence run.');
  }
  if (!presence.KINDS.includes(spec.kind)) fail('AGENT_WAKE_LAUNCH_SPEC_INVALID', 'Launch spec kind is unsupported.');
  const comparisons = ['kind', 'role', 'tier', 'reportsTo', 'dispatcher', 'lane', 'territory', 'directiveId', 'brief', 'worktree', 'consoleLog', 'respawnCount'];
  const mismatch = comparisons.find(field => spec[field] !== (field === 'kind' ? inferredRecordKind : record[field]));
  if (mismatch) {
    fail('AGENT_WAKE_LAUNCH_SPEC_MISMATCH', `Launch spec and presence record disagree on ${mismatch}.`, { field: mismatch });
  }
  return spec;
}

function readLaunchSpec(record, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const file = safePath(record.launchSpec, 'launchSpec');
  const spec = normalizeLaunchSpec(readJson(file, 'Lane launch spec', fsImpl), record);
  const requireKind = (target, kind, field) => {
    let stat;
    try { stat = fsImpl.statSync(target); }
    catch { fail('AGENT_WAKE_SOURCE_UNREADABLE', `${field} is unavailable: ${target}.`, { field }); }
    if ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory())) {
      fail('AGENT_WAKE_SOURCE_INVALID', `${field} must be a ${kind}: ${target}.`, { field });
    }
  };
  requireKind(spec.brief, 'file', 'brief');
  requireKind(spec.worktree, 'directory', 'worktree');
  if (spec.checkpoint) requireKind(spec.checkpoint, 'file', 'checkpoint');
  return Object.freeze({ file, spec });
}

function laneRunArguments(spec, respawnCount) {
  const args = [
    '--agent', spec.agentId,
    '--kind', spec.kind,
    '--role', spec.role,
    '--tier', spec.tier,
    '--reports-to', spec.reportsTo,
    '--dispatcher', spec.dispatcher,
    '--lane', spec.lane,
    '--territory', spec.territory,
    '--brief', spec.brief,
    '--worktree', spec.worktree,
    '--console-log', spec.consoleLog,
    '--heartbeat-ms', String(spec.heartbeatMs),
    '--lease-seconds', String(spec.leaseSeconds),
    '--respawn-count', String(respawnCount)
  ];
  if (spec.directiveId !== undefined) args.push('--directive', spec.directiveId);
  if (spec.checkpoint) args.push('--checkpoint', spec.checkpoint);
  args.push('--', spec.command, ...spec.childArgs);
  return Object.freeze(args);
}

async function spawnLaneWrapper(spec, respawnCount, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const spawnImpl = options.spawnImpl || spawn;
  const laneRunFile = safePath(options.laneRunFile || DEFAULT_LANE_RUN_FILE, 'laneRunFile');
  let stat;
  try { stat = fsImpl.statSync(laneRunFile); }
  catch { fail('AGENT_WAKE_SOURCE_UNREADABLE', `lane-run.js is unavailable: ${laneRunFile}.`); }
  if (!stat.isFile()) fail('AGENT_WAKE_SOURCE_INVALID', `lane-run.js is not a file: ${laneRunFile}.`);
  const wrapperLog = safePath(`${spec.consoleLog}.wrapper.log`, 'wrapperLog');
  fsImpl.mkdirSync(path.dirname(wrapperLog), { recursive: true });
  const logFd = fsImpl.openSync(wrapperLog, 'a');
  let child;
  try {
    child = spawnImpl(process.execPath, [laneRunFile, ...laneRunArguments(spec, respawnCount)], {
      cwd: ROOT,
      // The FIRST of the two hops in agent-wake -> lane-run -> agent-lane.
      // Scrubbing only the second one would still start lane-run.js holding
      // every ambient credential, and lane-run is a full Node process that goes
      // on to launch provider CLIs -- so the second scrub would be protecting
      // a child whose parent had already been handed ambient credentials.
      env: safeLaunchEnvironment(process.env, { context: 'agent wake lane wrapper' }),
      windowsHide: true,
      shell: false,
      // The wake CLI is intentionally short-lived; lane-run owns the durable
      // lease and heartbeat after this process exits, so it must have an
      // independent process lifetime.
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });
  } catch (error) {
    try { fsImpl.closeSync(logFd); } catch { /* already closed */ }
    fail('AGENT_WAKE_RESPAWN_FAILED', 'lane-run.js could not be spawned.', { cause: error && error.code });
  }
  try { fsImpl.closeSync(logFd); } catch { /* child owns the duplicated descriptor */ }
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  }).catch(error => fail('AGENT_WAKE_RESPAWN_FAILED', 'lane-run.js failed before spawn.', { cause: error && error.code }));
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) fail('AGENT_WAKE_RESPAWN_FAILED', 'lane-run.js did not report a process id.');
  child.on('error', () => { /* terminal state is reported through presence or the wrapper log */ });
  if (typeof child.unref === 'function') child.unref();
  return Object.freeze({ pid: child.pid, wrapperLog, child });
}

function reservationFile(agentId, launchDir = presence.DEFAULT_LAUNCH_DIR) {
  return path.join(launchDir, `${presence.assertAgentId(agentId)}.respawn.json`);
}

function normalizeReservation(input, agentId) {
  assertExactKeys(input, RESERVATION_KEYS, [...RESERVATION_KEYS], 'Respawn reservation');
  if (input.schemaVersion !== 1 || presence.assertAgentId(input.agentId) !== agentId) {
    fail('AGENT_WAKE_STATE_INVALID', 'Respawn reservation identity is invalid.');
  }
  return Object.freeze({
    schemaVersion: 1,
    agentId,
    priorRunId: presence.assertSafeString(input.priorRunId, 'priorRunId', { max: 64 }),
    pid: input.pid === null ? null : integer(input.pid, 'pid', { min: 1, max: 2147483647 }),
    respawnCount: integer(input.respawnCount, 'respawnCount', { min: 1, max: 100 }),
    startedAt: integer(input.startedAt, 'startedAt', { min: 0, max: Number.MAX_SAFE_INTEGER }),
    status: ['reserved', 'started', 'failed'].includes(input.status)
      ? input.status
      : fail('AGENT_WAKE_STATE_INVALID', 'Respawn reservation status is invalid.'),
    failureCode: input.failureCode === null
      ? null
      : presence.assertSafeString(input.failureCode, 'failureCode', { max: 80 })
  });
}

function readReservation(agentId, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const file = options.file || reservationFile(agentId, options.launchDir);
  try { fsImpl.accessSync(file, fs.constants.F_OK); }
  catch (error) {
    if (error && error.code === 'ENOENT') return Object.freeze({ file, reservation: null });
    fail('AGENT_WAKE_SOURCE_UNREADABLE', `Respawn reservation could not be read: ${file}.`);
  }
  return Object.freeze({ file, reservation: normalizeReservation(readJson(file, 'Respawn reservation', fsImpl), agentId) });
}

function clearReservation(file, fsImpl = fs) {
  try { fsImpl.rmSync(file, { force: true }); }
  catch (error) { fail('AGENT_WAKE_STATE_INVALID', `Respawn reservation could not be cleared: ${file}.`, { cause: error && error.code }); }
}

function writeReservation(file, value, fsImpl = fs) {
  const normalized = normalizeReservation(value, value.agentId);
  presence.writeAtomic(file, normalized, { fsImpl });
  return normalized;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeFailureCode(error, fallback = 'AGENT_WAKE_RESPAWN_FAILED') {
  const value = String(error && error.code ? error.code : fallback).slice(0, 80);
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value) ? value : fallback;
}

async function waitForNewRun(agentId, priorRunId, launch, options = {}) {
  const clock = options.clock || Date.now;
  const pause = options.pause || delay;
  const timeoutMs = options.startupTimeoutMs === undefined
    ? DEFAULT_STARTUP_TIMEOUT_MS
    : integer(options.startupTimeoutMs, 'startupTimeoutMs', { min: 100, max: 60_000 });
  const deadline = clock() + timeoutMs;
  for (;;) {
    const registry = presence.readRegistry(options.stateFile || presence.DEFAULT_STATE_FILE, { fsImpl: options.fsImpl || fs });
    const current = registry.agents[agentId];
    if (current && current.runId !== priorRunId) return Object.freeze({ confirmed: true, record: current });
    if (launch.child && launch.child.exitCode !== null) {
      fail('AGENT_WAKE_RESPAWN_FAILED', `lane-run.js exited ${launch.child.exitCode} before registering a new run.`);
    }
    if (clock() >= deadline) return Object.freeze({ confirmed: false, record: current || null });
    await pause(25);
  }
}

function wakeCondition(record, reservation, isAlive, now, staleMs) {
  if (reservation && reservation.priorRunId === record.runId && reservation.status === 'started'
      && reservation.pid !== null && isAlive(reservation.pid)) return 'respawn-starting';
  if (TERMINAL.has(record.status)) return record.status;
  if (record.status === 'stale') {
    if (record.pid === null) return 'unknown';
    if (record.pid !== null && isAlive(record.pid)) return 'heartbeat-fault';
    return 'stale';
  }
  if (record.pid === null && now - record.lastHeartbeat > staleMs) return 'unknown';
  return presence.deriveLiveness(record, { now, staleMs, isAlive });
}

async function wakeAgent(input, options = {}) {
  if (!plain(input)) fail('AGENT_WAKE_INVALID', 'Wake input must be an object.');
  const target = presence.assertAgentId(input.agentId);
  const from = presence.assertAgentId(input.from, 'from');
  const prompt = presence.assertSafeString(input.prompt, 'prompt', { max: 8192 });
  const requestId = presence.assertSafeString(input.requestId || crypto.randomUUID(), 'requestId', { max: 120 });
  const respawnIfDead = input.respawnIfDead === true;
  const stateFile = options.stateFile || presence.DEFAULT_STATE_FILE;
  const mailboxDir = options.mailboxDir || presence.DEFAULT_MAILBOX_DIR;
  const launchDir = options.launchDir || presence.DEFAULT_LAUNCH_DIR;
  const fsImpl = options.fsImpl || fs;
  const isAlive = options.isAlive || fleetState.pidAlive;
  const clock = options.clock || Date.now;
  const staleMs = options.staleMs === undefined ? presence.DEFAULT_STALE_MS : integer(options.staleMs, 'staleMs', { min: 1000, max: 86_400_000 });
  const wakeLock = options.wakeLockFile || path.join(launchDir, `${target}.wake.lock`);
  fleetState.acquireStateLock(wakeLock, {
    fsImpl,
    pid: options.pid || process.pid,
    isAlive: options.lockIsAlive || fleetState.pidAlive,
    timeoutMs: options.lockTimeoutMs
  });
  try {
    let registry = presence.readRegistry(stateFile, { fsImpl });
    const org = options.org || loadOrg(options.orgFile || DEFAULT_ORG_FILE, {
      fsImpl,
      knownRoles: options.knownRoles,
      orgStore: options.orgStore,
      env: options.environment || process.env
    });
    const authorization = assertWakeAuthorized({ from, target, org, registry });
    let record = registry.agents[target];
    const reservationView = readReservation(target, { fsImpl, launchDir });
    let reservation = reservationView.reservation;
    if (reservation && reservation.priorRunId !== record.runId) {
      clearReservation(reservationView.file, fsImpl);
      reservation = null;
    }
    const activeReservation = reservation
      && reservation.status === 'started'
      && reservation.pid !== null
      && clock() - reservation.startedAt <= DEFAULT_RESERVATION_STALE_MS
      && isAlive(reservation.pid)
      ? reservation
      : null;
    const condition = wakeCondition(record, activeReservation, isAlive, clock(), staleMs);
    const mailbox = presence.appendMailbox(target, { from, prompt, requestId, at: clock() }, { fsImpl, mailboxDir });
    const dead = TERMINAL.has(condition) || condition === 'stale' || condition === 'process-gone';
    if (!dead || !respawnIfDead) {
      let message;
      if (!dead) {
        message = condition === 'unknown'
          ? `QUEUED: ${target} liveness is unknown; it cannot be safely respawned until a process outcome is verified.`
          : `QUEUED: ${target} is running; it will read this at its next boundary. A running ${record.kind} lane cannot be interrupted.`;
      } else {
        message = `QUEUED: ${target} is ${condition}; use --respawn-if-dead to relaunch it through lane-run.js.`;
      }
      return Object.freeze({
        ok: true,
        action: 'queued',
        condition,
        requestId: mailbox.requestId,
        authorization,
        message
      });
    }

    const launchSpec = readLaunchSpec(record, { fsImpl });
    const nextRespawnCount = Math.max(launchSpec.spec.respawnCount, reservation ? reservation.respawnCount : 0) + 1;
    if (options.maxRespawns !== undefined) {
      const maximum = integer(options.maxRespawns, 'maxRespawns', { min: 1, max: 100 });
      if (nextRespawnCount > maximum) {
        fail('AGENT_WAKE_RESPAWN_LIMIT', `${target} reached the respawn cap of ${maximum}.`, {
          target,
          respawnCount: launchSpec.spec.respawnCount,
          maximum
        });
      }
    }
    const launchLane = options.launchLane || spawnLaneWrapper;
    writeReservation(reservationView.file, {
      schemaVersion: 1,
      agentId: target,
      priorRunId: record.runId,
      pid: null,
      respawnCount: nextRespawnCount,
      startedAt: clock(),
      status: 'reserved',
      failureCode: null
    }, fsImpl);
    let launch;
    try {
      launch = await launchLane(launchSpec.spec, nextRespawnCount, {
        fsImpl,
        spawnImpl: options.spawnImpl,
        laneRunFile: options.laneRunFile
      });
      if (!launch || !Number.isSafeInteger(launch.pid) || launch.pid <= 0) {
        fail('AGENT_WAKE_RESPAWN_FAILED', 'The lane launcher returned no process id.');
      }
    } catch (error) {
      writeReservation(reservationView.file, {
        schemaVersion: 1,
        agentId: target,
        priorRunId: record.runId,
        pid: null,
        respawnCount: nextRespawnCount,
        startedAt: clock(),
        status: 'failed',
        failureCode: safeFailureCode(error)
      }, fsImpl);
      throw error;
    }
    const reservationValue = writeReservation(reservationView.file, {
      schemaVersion: 1,
      agentId: target,
      priorRunId: record.runId,
      pid: launch.pid,
      respawnCount: nextRespawnCount,
      startedAt: clock(),
      status: 'started',
      failureCode: null
    }, fsImpl);
    let registration;
    try {
      registration = options.awaitRegistration === false
        ? Object.freeze({ confirmed: false, record: null })
        : await waitForNewRun(target, record.runId, launch, {
          stateFile,
          fsImpl,
          clock,
          pause: options.pause,
          startupTimeoutMs: options.startupTimeoutMs
        });
    } catch (error) {
      writeReservation(reservationView.file, {
        schemaVersion: 1,
        agentId: target,
        priorRunId: record.runId,
        pid: null,
        respawnCount: nextRespawnCount,
        startedAt: clock(),
        status: 'failed',
        failureCode: safeFailureCode(error)
      }, fsImpl);
      throw error;
    }
    if (registration.confirmed) clearReservation(reservationView.file, fsImpl);
    const message = registration.confirmed
      ? `RESPAWNED: ${target} relaunched through lane-run.js with queued supervisor directives.`
      : `RESPAWN STARTED: ${target} has not yet confirmed a new presence run; the durable reservation prevents duplicate relaunch.`;
    return Object.freeze({
      ok: true,
      action: 'respawned',
      condition,
      requestId: mailbox.requestId,
      authorization,
      respawn: Object.freeze({
        pid: reservationValue.pid,
        respawnCount: reservationValue.respawnCount,
        registrationConfirmed: registration.confirmed,
        runId: registration.record ? registration.record.runId : null
      }),
      message
    });
  } finally {
    fleetState.releaseStateLock(wakeLock, options.pid || process.pid, fsImpl);
  }
}

function compactRecord(record, extra = {}) {
  return Object.freeze({ agentId: record.agentId, runId: record.runId, status: record.status, ...extra });
}

function autoWakeEligible(policy, kind) {
  if (policy === 'checkpointed') return kind === 'failed' || kind === 'dead';
  return policy === kind;
}

async function nonTerminalLaneTask(record, options = {}) {
  if (typeof record.currentTask !== 'string' || record.currentTask.length === 0) return null;
  const getTask = options.getTask || taskProvider.get;
  let task;
  try {
    task = await getTask({
      taskId: record.currentTask,
      includePayload: false,
      includeCheckpoint: false
    }, options.taskDependencies || {});
  } catch (error) {
    // Presence cannot establish whether an unreadable durable task is still
    // non-terminal. Refuse the sweep rather than collapsing that uncertainty
    // into the same null used for a measured absent or terminal task.
    fail('AGENT_SWEEP_TASK_UNREADABLE', `Durable task ${record.currentTask} could not be read.`, {
      taskId: record.currentTask,
      cause: error && error.code
    });
  }
  if (!task || task.type !== LANE_TASK_TYPE || TERMINAL_TASK_STATUSES.has(task.status)) return null;
  return Object.freeze({ taskId: record.currentTask, taskStatus: task.status });
}

function persistentRespawnFailure(record, code, options = {}, knownReservation = undefined) {
  const fsImpl = options.fsImpl || fs;
  const launchDir = options.launchDir || presence.DEFAULT_LAUNCH_DIR;
  let reservation = knownReservation;
  try {
    if (reservation === undefined) {
      reservation = readReservation(record.agentId, { fsImpl, launchDir }).reservation;
    }
    const priorRespawns = reservation && reservation.priorRunId === record.runId
      ? reservation.respawnCount
      : 0;
    return writeReservation(reservationFile(record.agentId, launchDir), {
      schemaVersion: 1,
      agentId: record.agentId,
      priorRunId: record.runId,
      pid: null,
      respawnCount: Math.max(record.respawnCount, priorRespawns) + 1,
      startedAt: (options.clock || Date.now)(),
      status: 'failed',
      failureCode: safeFailureCode({ code })
    }, fsImpl);
  } catch (error) {
    fail('AGENT_SWEEP_ESCALATION_PERSIST_FAILED', 'Automatic recovery failure could not be durably recorded.', {
      cause: safeFailureCode(error, 'AGENT_SWEEP_ESCALATION_PERSIST_FAILED')
    });
  }
}

function priorRespawnFailure(record, reservation) {
  if (!reservation || reservation.priorRunId !== record.runId || reservation.status !== 'failed') return null;
  return compactRecord(record, {
    code: reservation.failureCode || 'AGENT_WAKE_RESPAWN_FAILED',
    message: `${record.agentId} has an unresolved prior automatic respawn failure.`,
    respawnCount: reservation.respawnCount,
    durable: true
  });
}

function boundedMemoryPacket(findings, maxBytes = 28 * 1024) {
  const packet = {
    schemaVersion: 1,
    at: findings.at,
    policy: findings.policy,
    usefulProgressStaleMs: findings.usefulProgressStaleMs,
    counts: { ...findings.counts },
    terminalVerdicts: findings.terminalVerdicts.map(item => ({ ...item, verdict: item.verdict.slice(0, 512) })),
    failures: findings.failures.map(item => ({ ...item })),
    deadStale: findings.deadStale.map(item => ({ ...item })),
    heartbeatFaults: findings.heartbeatFaults.map(item => ({ ...item })),
    aliveNoUsefulProgress: findings.aliveNoUsefulProgress.map(item => ({ ...item })),
    unknownLiveness: findings.unknownLiveness.map(item => ({ ...item })),
    respawns: findings.respawns.map(item => ({ ...item })),
    escalations: findings.escalations.map(item => ({ ...item, message: String(item.message || '').slice(0, 512) })),
    omitted: {}
  };
  const arrays = [
    'terminalVerdicts', 'failures', 'deadStale', 'heartbeatFaults', 'aliveNoUsefulProgress',
    'unknownLiveness', 'respawns', 'escalations'
  ];
  while (Buffer.byteLength(JSON.stringify(packet), 'utf8') > maxBytes) {
    const key = arrays.sort((a, b) => packet[b].length - packet[a].length)[0];
    if (!key || packet[key].length === 0) {
      fail('AGENT_SWEEP_FINDINGS_TOO_LARGE', 'Sweep findings could not fit the bounded agent-coord packet.');
    }
    packet[key].pop();
    packet.omitted[key] = (packet.omitted[key] || 0) + 1;
  }
  return Object.freeze(packet);
}

async function persistSweepFindings(findings, options = {}) {
  const packet = boundedMemoryPacket(findings, options.maxMemoryBytes);
  if (typeof options.recordFindings === 'function') {
    const result = await options.recordFindings(packet);
    return Object.freeze({ packet, result });
  }
  try {
    const result = await memory.set({
      namespace: 'agent-coord',
      key: `sweep/${new Date(findings.at).toISOString()}`,
      value: packet,
      note: 'Built-in bounded agent wake/sweep finding; untrusted runtime context, not authority.',
      tags: ['agent-sweep']
    }, options.memoryDependencies || {});
    return Object.freeze({ packet, result });
  } catch (error) {
    fail('AGENT_SWEEP_FINDINGS_PERSIST_FAILED', 'Sweep findings could not be written to agent-coord.', { cause: error && error.code });
  }
}

async function sweepAgents(input = {}, options = {}) {
  if (!plain(input)) fail('AGENT_SWEEP_INVALID', 'Sweep input must be an object.');
  const stateFile = options.stateFile || presence.DEFAULT_STATE_FILE;
  const fsImpl = options.fsImpl || fs;
  const isAlive = options.isAlive || fleetState.pidAlive;
  const clock = options.clock || Date.now;
  const now = clock();
  const staleMs = input.staleMs === undefined ? presence.DEFAULT_STALE_MS : integer(input.staleMs, 'staleMs', { min: 1000, max: 86_400_000 });
  const usefulProgressStaleMs = input.usefulProgressStaleMs === undefined
    ? DEFAULT_USEFUL_PROGRESS_STALE_MS
    : integer(input.usefulProgressStaleMs, 'usefulProgressStaleMs', { min: 1000, max: 86_400_000 });
  const policy = input.autoWake || 'off';
  if (!AUTO_WAKE_POLICIES.includes(policy)) {
    fail('AGENT_SWEEP_INVALID', `autoWake must be one of: ${AUTO_WAKE_POLICIES.join(', ')}.`);
  }
  let sweepFrom = input.from;
  if (policy !== 'off' && !sweepFrom) {
    const declaredOrg = options.org || loadOrg(options.orgFile || DEFAULT_ORG_FILE, {
      fsImpl,
      knownRoles: options.knownRoles,
      orgStore: options.orgStore,
      env: options.environment || process.env
    });
    const root = agentOrg.rootAgentOf(declaredOrg);
    if (!root || root.enabled !== true) {
      fail('AGENT_SWEEP_ROOT_UNAVAILABLE', 'Automatic recovery requires one enabled declared organisation root.');
    }
    sweepFrom = root.id;
  }
  const maxRespawns = input.maxRespawns === undefined
    ? DEFAULT_MAX_RESPAWNS
    : integer(input.maxRespawns, 'maxRespawns', { min: 1, max: 100 });
  const maxAutoRespawns = input.maxAutoRespawns === undefined
    ? DEFAULT_MAX_AUTO_RESPAWNS_PER_SWEEP
    : integer(input.maxAutoRespawns, 'maxAutoRespawns', { min: 1, max: 20 });
  const registry = presence.readRegistry(stateFile, { fsImpl });
  const findings = {
    schemaVersion: 1,
    at: now,
    policy,
    usefulProgressStaleMs,
    terminalVerdicts: [],
    failures: [],
    deadStale: [],
    heartbeatFaults: [],
    aliveNoUsefulProgress: [],
    unknownLiveness: [],
    respawns: [],
    escalations: [],
    consumptionRaces: []
  };
  const recoveryCandidates = new Map();
  const addRecoveryCandidate = (kind, record) => {
    const key = `${record.agentId}\0${record.runId}`;
    const existing = recoveryCandidates.get(key);
    // A dead process with a non-terminal durable task is stronger evidence
    // than a terminal presence symptom. Keep one candidate so one pass can
    // never launch the same lane twice.
    if (!existing || (kind === 'dead' && existing.kind !== 'dead')) {
      recoveryCandidates.set(key, { kind, record });
    }
  };
  const records = Object.values(registry.agents).sort((a, b) => a.agentId.localeCompare(b.agentId));
  for (const snapshot of records) {
    let record = snapshot;
    const alive = record.pid === null ? null : isAlive(record.pid);
    const nonTerminalTask = alive === false ? await nonTerminalLaneTask(record, options) : null;
    const taskEvidence = nonTerminalTask === null ? {} : {
      currentTask: nonTerminalTask.taskId,
      taskStatus: nonTerminalTask.taskStatus
    };
    if (TERMINAL.has(record.status)) {
      if (record.lastVerdict && record.verdictConsumedAt === null) {
        findings.terminalVerdicts.push(compactRecord(record, { verdict: record.lastVerdict, exitCode: record.exitCode }));
      }
      if (record.status === 'failed') {
        findings.failures.push(compactRecord(record, { exitCode: record.exitCode }));
        addRecoveryCandidate('failed', record);
      } else if (!record.lastVerdict) {
        // Exit zero is not proof of completion. A FINISHED lane without a
        // terminal VERDICT has not supplied the evidence required to stop.
        findings.failures.push(compactRecord(record, {
          exitCode: record.exitCode,
          code: 'AGENT_SWEEP_MISSING_VERDICT'
        }));
        addRecoveryCandidate('failed', record);
      }
      if (nonTerminalTask) {
        findings.deadStale.push(compactRecord(record, {
          pid: record.pid,
          kind: 'dead-process-nonterminal-lane-task',
          ...taskEvidence
        }));
        addRecoveryCandidate('dead', record);
      }
      continue;
    }
    const late = now - record.lastHeartbeat > staleMs;
    if (record.status === 'stale') {
      if (alive === true) {
        findings.heartbeatFaults.push(compactRecord(record, { pid: record.pid, kind: 'alive-process-stale-record' }));
      } else if (alive === false) {
        findings.deadStale.push(compactRecord(record, {
          pid: record.pid,
          kind: nonTerminalTask ? 'dead-process-nonterminal-lane-task' : 'dead-process-stale-record',
          ...taskEvidence
        }));
        addRecoveryCandidate('dead', record);
      } else {
        findings.unknownLiveness.push(compactRecord(record, { pid: null, kind: 'stale-record-without-pid' }));
      }
      continue;
    }
    if (alive === true && late) {
      findings.heartbeatFaults.push(compactRecord(record, { pid: record.pid, kind: 'alive-process-stale-heartbeat' }));
      continue;
    }
    if (alive === false) {
      const kind = late ? 'dead-process-stale-heartbeat' : 'dead-process';
      record = presence.markStale(record.agentId, record.runId, kind, { file: stateFile, fsImpl });
      findings.deadStale.push(compactRecord(record, {
        pid: record.pid,
        kind: nonTerminalTask ? 'dead-process-nonterminal-lane-task' : kind,
        ...taskEvidence
      }));
      addRecoveryCandidate('dead', record);
      continue;
    }
    if (record.pid === null && late) {
      findings.unknownLiveness.push(compactRecord(record, { pid: null, kind: 'stale-heartbeat-without-pid' }));
      continue;
    }
    if (record.status === 'running' && alive === true && !late) {
      const usefulProgressBase = record.lastUsefulProgressAt === null ? record.startedAt : record.lastUsefulProgressAt;
      const usefulProgressAgeMs = Math.max(0, now - usefulProgressBase);
      if (usefulProgressAgeMs > usefulProgressStaleMs) {
        findings.aliveNoUsefulProgress.push(compactRecord(record, {
          kind: 'alive-no-useful-progress',
          pid: record.pid,
          heartbeatAgeMs: Math.max(0, now - record.lastHeartbeat),
          usefulProgressAgeMs,
          usefulProgressStaleMs,
          usefulProgressSeq: record.usefulProgressSeq,
          lastUsefulProgressAt: record.lastUsefulProgressAt,
          lastUsefulProgressKind: record.lastUsefulProgressKind
        }));
      }
    }
  }

  const candidates = [...recoveryCandidates.values()];
  const candidateReservations = new Map();
  const unreadableReservationKeys = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.record.agentId}\0${candidate.record.runId}`;
    try {
      const reservation = readReservation(candidate.record.agentId, {
        fsImpl,
        launchDir: options.launchDir || presence.DEFAULT_LAUNCH_DIR
      }).reservation;
      candidateReservations.set(key, reservation);
      const priorFailure = priorRespawnFailure(candidate.record, reservation);
      if (priorFailure) findings.escalations.push(priorFailure);
    } catch (error) {
      unreadableReservationKeys.add(key);
      findings.escalations.push(compactRecord(candidate.record, {
        code: safeFailureCode(error, 'AGENT_WAKE_STATE_INVALID'),
        message: error && error.message ? error.message : String(error)
      }));
    }
  }

  if (policy !== 'off') {
    let automaticAttempts = 0;
    for (const candidate of candidates) {
      if (!autoWakeEligible(policy, candidate.kind)) continue;
      const key = `${candidate.record.agentId}\0${candidate.record.runId}`;
      if (unreadableReservationKeys.has(key)) continue;
      const reservation = candidateReservations.get(key);
      let launchSpec;
      try { launchSpec = readLaunchSpec(candidate.record, { fsImpl }); }
      catch (error) {
        let persisted;
        try {
          persisted = persistentRespawnFailure(candidate.record, safeFailureCode(error, 'AGENT_SWEEP_LAUNCH_SPEC_INVALID'), {
            fsImpl,
            launchDir: options.launchDir || presence.DEFAULT_LAUNCH_DIR,
            clock
          }, reservation);
        } catch (persistenceError) {
          findings.escalations.push(compactRecord(candidate.record, {
            code: safeFailureCode(persistenceError, 'AGENT_SWEEP_ESCALATION_PERSIST_FAILED'),
            message: persistenceError && persistenceError.message ? persistenceError.message : String(persistenceError)
          }));
          continue;
        }
        findings.escalations.push(compactRecord(candidate.record, {
          code: safeFailureCode(error, 'AGENT_SWEEP_LAUNCH_SPEC_INVALID'),
          message: error && error.message ? error.message : String(error),
          respawnCount: persisted.respawnCount,
          durable: true
        }));
        continue;
      }
      if (!launchSpec.spec.checkpoint) {
        let persisted;
        try {
          persisted = persistentRespawnFailure(candidate.record, 'AGENT_SWEEP_NO_CHECKPOINT', {
            fsImpl,
            launchDir: options.launchDir || presence.DEFAULT_LAUNCH_DIR,
            clock
          }, reservation);
        } catch (persistenceError) {
          findings.escalations.push(compactRecord(candidate.record, {
            code: safeFailureCode(persistenceError, 'AGENT_SWEEP_ESCALATION_PERSIST_FAILED'),
            message: persistenceError && persistenceError.message ? persistenceError.message : String(persistenceError)
          }));
          continue;
        }
        findings.escalations.push(compactRecord(candidate.record, {
          code: 'AGENT_SWEEP_NO_CHECKPOINT',
          message: `${candidate.record.agentId} is not automatically recoverable because it has no checkpoint.`,
          respawnCount: persisted.respawnCount,
          durable: true
        }));
        continue;
      }
      const priorRespawns = Math.max(
        launchSpec.spec.respawnCount,
        reservation && reservation.priorRunId === candidate.record.runId ? reservation.respawnCount : 0
      );
      if (priorRespawns >= maxRespawns) {
        findings.escalations.push(compactRecord(candidate.record, {
          code: 'AGENT_SWEEP_RESPAWN_CAP',
          message: `${candidate.record.agentId} reached the automatic respawn cap of ${maxRespawns}.`,
          respawnCount: priorRespawns
        }));
        continue;
      }
      if (automaticAttempts >= maxAutoRespawns) {
        findings.escalations.push(compactRecord(candidate.record, {
          code: 'AGENT_SWEEP_PASS_RESPAWN_CAP',
          message: `This bounded sweep reached its per-pass automatic respawn cap of ${maxAutoRespawns}.`
        }));
        continue;
      }
      automaticAttempts += 1;
      try {
        const result = await wakeAgent({
          agentId: candidate.record.agentId,
          from: sweepFrom,
          prompt: input.prompt || DEFAULT_SWEEP_PROMPT,
          requestId: `sweep-${now}-${candidate.record.agentId}`,
          respawnIfDead: true
        }, {
          ...options,
          stateFile,
          fsImpl,
          maxRespawns,
          org: options.org
        });
        findings.respawns.push(Object.freeze({
          agentId: candidate.record.agentId,
          priorRunId: candidate.record.runId,
          respawnCount: result.respawn.respawnCount,
          registrationConfirmed: result.respawn.registrationConfirmed
        }));
      } catch (error) {
        findings.escalations.push(compactRecord(candidate.record, {
          code: safeFailureCode(error, 'AGENT_SWEEP_RESPAWN_FAILED'),
          message: error && error.message ? error.message : String(error)
        }));
      }
    }
  }

  findings.counts = Object.freeze({
    scanned: records.length,
    terminalVerdicts: findings.terminalVerdicts.length,
    failures: findings.failures.length,
    deadStale: findings.deadStale.length,
    heartbeatFaults: findings.heartbeatFaults.length,
    aliveNoUsefulProgress: findings.aliveNoUsefulProgress.length,
    unknownLiveness: findings.unknownLiveness.length,
    respawns: findings.respawns.length,
    escalations: findings.escalations.length
  });
  const persisted = await persistSweepFindings(findings, options);
  const persistedVerdicts = new Set(persisted.packet.terminalVerdicts.map(item => `${item.agentId}\0${item.runId}`));

  for (const item of findings.terminalVerdicts) {
    // A bounded packet may omit older verdicts to stay inside the durable
    // memory limit. Only acknowledge the exact verdicts that were actually
    // persisted; omitted items remain available for a later sweep.
    if (!persistedVerdicts.has(`${item.agentId}\0${item.runId}`)) continue;
    try {
      const current = presence.readRegistry(stateFile, { fsImpl }).agents[item.agentId];
      if (!current || current.runId !== item.runId || current.verdictConsumedAt !== null) continue;
      presence.update(item.agentId, item.runId, { verdictConsumedAt: now }, {
        file: stateFile,
        fsImpl,
        expectedRecordRevision: current.recordRevision
      });
    } catch (error) {
      findings.consumptionRaces.push(Object.freeze({
        agentId: item.agentId,
        runId: item.runId,
        code: error && error.code ? error.code : 'AGENT_SWEEP_CONSUME_FAILED'
      }));
    }
  }
  return Object.freeze({ ...findings, persisted });
}

function parsePairs(argv, booleanFlags = new Set()) {
  if (!Array.isArray(argv)) fail('AGENT_WAKE_ARGUMENT_INVALID', 'argv must be an array.');
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag || !flag.startsWith('--')) fail('AGENT_WAKE_ARGUMENT_INVALID', `Expected a --flag at ${flag || '<end>'}.`);
    const key = flag.slice(2);
    if (Object.hasOwn(values, key)) fail('AGENT_WAKE_ARGUMENT_INVALID', `Duplicate option --${key}.`);
    if (booleanFlags.has(key)) values[key] = true;
    else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail('AGENT_WAKE_ARGUMENT_INVALID', `Option --${key} requires a value.`);
      values[key] = value;
      index += 1;
    }
  }
  return values;
}

function rejectUnknown(values, allowed) {
  const unknown = Object.keys(values).filter(key => !allowed.has(key));
  if (unknown.length) fail('AGENT_WAKE_ARGUMENT_INVALID', `Unknown option(s): ${unknown.map(key => `--${key}`).join(', ')}.`);
}

function parseWakeArgs(argv, environment = process.env) {
  const values = parsePairs(argv, new Set(['respawn-if-dead']));
  rejectUnknown(values, new Set([
    'agent', 'from', 'prompt', 'request-id', 'respawn-if-dead', 'state-file', 'mailbox-dir', 'launch-dir',
    'org-file', 'startup-timeout-ms', 'stale-ms'
  ]));
  for (const required of ['agent', 'prompt']) {
    if (values[required] === undefined) fail('AGENT_WAKE_ARGUMENT_INVALID', `Missing option --${required}.`);
  }
  const from = values.from || environment.TOOLSENABLED_AGENT_ID;
  if (!from) fail('AGENT_WAKE_ARGUMENT_INVALID', 'Wake caller identity is required via --from or TOOLSENABLED_AGENT_ID.');
  return Object.freeze({
    input: Object.freeze({
      agentId: presence.assertAgentId(values.agent),
      from: presence.assertAgentId(from, 'from'),
      prompt: presence.assertSafeString(values.prompt, 'prompt', { max: 8192 }),
      requestId: values['request-id'] ? presence.assertSafeString(values['request-id'], 'requestId', { max: 120 }) : undefined,
      respawnIfDead: values['respawn-if-dead'] === true
    }),
    options: Object.freeze({
      stateFile: values['state-file'] ? safePath(values['state-file'], 'stateFile') : presence.DEFAULT_STATE_FILE,
      mailboxDir: values['mailbox-dir'] ? safePath(values['mailbox-dir'], 'mailboxDir') : presence.DEFAULT_MAILBOX_DIR,
      launchDir: values['launch-dir'] ? safePath(values['launch-dir'], 'launchDir') : presence.DEFAULT_LAUNCH_DIR,
      orgFile: values['org-file'] ? safePath(values['org-file'], 'orgFile') : DEFAULT_ORG_FILE,
      startupTimeoutMs: values['startup-timeout-ms'] === undefined ? DEFAULT_STARTUP_TIMEOUT_MS : integer(values['startup-timeout-ms'], 'startup-timeout-ms', { min: 100, max: 60_000 }),
      staleMs: values['stale-ms'] === undefined ? presence.DEFAULT_STALE_MS : integer(values['stale-ms'], 'stale-ms', { min: 1000, max: 86_400_000 })
    })
  });
}

function parseSweepArgs(argv, environment = process.env) {
  const values = parsePairs(argv);
  rejectUnknown(values, new Set([
    'from', 'auto-wake', 'prompt', 'max-respawns', 'max-auto-respawns', 'stale-ms', 'state-file', 'mailbox-dir', 'launch-dir',
    'org-file', 'startup-timeout-ms', 'useful-progress-stale-ms'
  ]));
  const policy = values['auto-wake'] || 'off';
  if (!AUTO_WAKE_POLICIES.includes(policy)) {
    fail('AGENT_WAKE_ARGUMENT_INVALID', `--auto-wake must be one of: ${AUTO_WAKE_POLICIES.join(', ')}.`);
  }
  const from = values.from || environment.TOOLSENABLED_AGENT_ID;
  return Object.freeze({
    input: Object.freeze({
      from: from ? presence.assertAgentId(from, 'from') : undefined,
      autoWake: policy,
      prompt: values.prompt ? presence.assertSafeString(values.prompt, 'prompt', { max: 8192 }) : undefined,
      maxRespawns: values['max-respawns'] === undefined ? DEFAULT_MAX_RESPAWNS : integer(values['max-respawns'], 'max-respawns', { min: 1, max: 100 }),
      maxAutoRespawns: values['max-auto-respawns'] === undefined
        ? DEFAULT_MAX_AUTO_RESPAWNS_PER_SWEEP
        : integer(values['max-auto-respawns'], 'max-auto-respawns', { min: 1, max: 20 }),
      staleMs: values['stale-ms'] === undefined ? presence.DEFAULT_STALE_MS : integer(values['stale-ms'], 'stale-ms', { min: 1000, max: 86_400_000 }),
      usefulProgressStaleMs: values['useful-progress-stale-ms'] === undefined
        ? DEFAULT_USEFUL_PROGRESS_STALE_MS
        : integer(values['useful-progress-stale-ms'], 'useful-progress-stale-ms', { min: 1000, max: 86_400_000 })
    }),
    options: Object.freeze({
      stateFile: values['state-file'] ? safePath(values['state-file'], 'stateFile') : presence.DEFAULT_STATE_FILE,
      mailboxDir: values['mailbox-dir'] ? safePath(values['mailbox-dir'], 'mailboxDir') : presence.DEFAULT_MAILBOX_DIR,
      launchDir: values['launch-dir'] ? safePath(values['launch-dir'], 'launchDir') : presence.DEFAULT_LAUNCH_DIR,
      orgFile: values['org-file'] ? safePath(values['org-file'], 'orgFile') : DEFAULT_ORG_FILE,
      startupTimeoutMs: values['startup-timeout-ms'] === undefined ? DEFAULT_STARTUP_TIMEOUT_MS : integer(values['startup-timeout-ms'], 'startup-timeout-ms', { min: 100, max: 60_000 })
    })
  });
}

function safeError(error) {
  return Object.freeze({
    code: String(error && error.code ? error.code : 'AGENT_WAKE_ERROR').slice(0, 80),
    message: String(error && error.message ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 500)
  });
}

module.exports = Object.freeze({
  AUTO_WAKE_POLICIES,
  AgentWakeError,
  DEFAULT_LANE_RUN_FILE,
  DEFAULT_MAX_AUTO_RESPAWNS_PER_SWEEP,
  DEFAULT_MAX_RESPAWNS,
  DEFAULT_ORG_FILE,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_SWEEP_PROMPT,
  DEFAULT_USEFUL_PROGRESS_STALE_MS,
  assertWakeAuthorized,
  boundedMemoryPacket,
  isDescendant,
  laneRunArguments,
  loadOrg,
  normalizeLaunchSpec,
  parseSweepArgs,
  parseWakeArgs,
  persistSweepFindings,
  readLaunchSpec,
  readReservation,
  reservationFile,
  safeError,
  spawnLaneWrapper,
  supervisionEdges,
  sweepAgents,
  wakeAgent,
  waitForNewRun
});
