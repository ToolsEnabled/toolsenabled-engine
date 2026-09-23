'use strict';

const crypto = require('node:crypto');
const operationAudit = require('../operation-audit');
const OPERATION_TYPE = 'mission.bridge.terminate';

const agentWake = require('../agent-wake');
const presence = require('../agent-presence');
const fleetState = require('../fleet-supervisor/state');
const windowsJob = require('../windows-job-control');
const { MissionBridgeError, refuse } = require('./errors');

const REQUEST_BODY_SHA256 = Symbol('missionBridgeRequestBodySha256');
const INTENT_ACTION = 'mission.bridge.terminate.intent';
const COMPLETED_ACTION = 'mission.bridge.terminate.completed';
const FAILED_ACTION = 'mission.bridge.terminate.failed';
const DEFAULT_KILL_TIMEOUT_MS = 15_000;
const DEFAULT_PROCESS_GONE_TIMEOUT_MS = 15_000;
const DEFAULT_TERMINAL_TIMEOUT_MS = 30_000;
const DEFAULT_IDEMPOTENCY_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 100;
const TERMINAL = new Set(['finished', 'failed']);
const SAFE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const RUN_ID_RE = /^[a-f0-9-]{16,64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

const FAILURE_MESSAGES = Object.freeze({
  BRIDGE_TERMINATE_AGENT_UNKNOWN: 'No canonical presence record exists for the target.',
  BRIDGE_TERMINATE_ACTOR_REFUSED: 'The actor does not supervise the target lane.',
  BRIDGE_TERMINATE_AUTHORIZATION_UNAVAILABLE: 'Authorization could not be checked; this is NOT claiming that the actor or target is absent.',
  BRIDGE_TERMINATE_STALE_RUN: 'The target now belongs to a different run.',
  BRIDGE_TERMINATE_STALE_PID: 'The target PID no longer matches the fenced request.',
  BRIDGE_TERMINATE_ALREADY_TERMINAL: 'The target run is already terminal.',
  BRIDGE_TERMINATE_NOT_ACTIVE: 'The target run is not actively running.',
  BRIDGE_TERMINATE_KILL_FAILURE: 'The fenced process tree could not be terminated.',
  BRIDGE_TERMINATE_LIVENESS_UNCERTAIN: 'The target process liveness could not be verified.',
  BRIDGE_TERMINATE_TERMINAL_TIMEOUT: 'The canonical presence record did not become terminal in time.',
  BRIDGE_TERMINATE_REGISTRY_UNAVAILABLE: 'The canonical presence registry is unavailable.',
  BRIDGE_TERMINATE_PLATFORM_UNSUPPORTED: 'Process-tree termination is unavailable on this platform.'
});

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateInput(input) {
  const allowed = ['idempotencyKey', 'agentId', 'expectedRunId', 'expectedPid'];
  if (!plain(input)
      || Object.keys(input).some(key => !allowed.includes(key))
      || allowed.some(key => !Object.hasOwn(input, key))) {
    refuse('BRIDGE_TERMINATE_INPUT_INVALID', 'terminate has unexpected or missing fields.');
  }
  if (typeof input.idempotencyKey !== 'string' || !SAFE_KEY_RE.test(input.idempotencyKey)) {
    refuse('BRIDGE_TERMINATE_INPUT_INVALID', 'idempotencyKey is malformed.');
  }
  let agentId;
  let expectedRunId;
  try {
    agentId = presence.assertAgentId(input.agentId);
    expectedRunId = String(input.expectedRunId ?? '');
    if (!RUN_ID_RE.test(expectedRunId)) throw new Error('invalid run id');
  } catch {
    refuse('BRIDGE_TERMINATE_INPUT_INVALID', 'agentId or expectedRunId is malformed.');
  }
  if (!Number.isSafeInteger(input.expectedPid) || input.expectedPid <= 0) {
    refuse('BRIDGE_TERMINATE_INPUT_INVALID', 'expectedPid must be a positive integer.');
  }
  return Object.freeze({
    idempotencyKey: input.idempotencyKey,
    agentId,
    expectedRunId,
    expectedPid: input.expectedPid
  });
}

function bodySha256(input, normalized) {
  const attached = input[REQUEST_BODY_SHA256];
  if (typeof attached === 'string' && SHA256_RE.test(attached)) return attached;
  // Direct trusted invocations do not have HTTP bytes. Keep those calls
  // deterministic while the server route binds the digest to the raw body.
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function effectiveRequestSha256(bodyDigest, actor) {
  return crypto.createHash('sha256').update(`${bodyDigest}\n${actor}`, 'utf8').digest('hex');
}

function eventEnvelope(row) {
  if (!row || typeof row !== 'object') return null;
  const event = row.event && typeof row.event === 'object' ? row.event : row;
  const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
    ? event.details : null;
  const sequence = Number.isSafeInteger(row.sequence) ? row.sequence : event.sequence;
  const eventHash = typeof row.eventHash === 'string' ? row.eventHash : event.eventHash;
  if (!details || !Number.isSafeInteger(sequence) || sequence < 1 || !SHA256_RE.test(String(eventHash || ''))) return null;
  return Object.freeze({ details, sequence, eventHash });
}

function matchingEvent(rows, requestSha256) {
  if (!Array.isArray(rows)) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const envelope = eventEnvelope(rows[index]);
    if (envelope?.details?.requestSha256 === requestSha256) return envelope;
  }
  return null;
}

function anyEvent(rows) {
  if (!Array.isArray(rows)) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const envelope = eventEnvelope(rows[index]);
    if (envelope) return envelope;
  }
  return null;
}

function requireAuditRows(rows) {
  if (!Array.isArray(rows) || rows.some(row => !eventEnvelope(row))) {
    refuse('BRIDGE_TERMINATE_AUDIT_UNAVAILABLE', 'The canonical audit lookup returned an invalid result.', { status: 503 });
  }
  return rows;
}

function auditFind(auditApi, action, target) {
  if (!auditApi || typeof auditApi.findEvents !== 'function') {
    refuse('BRIDGE_TERMINATE_AUDIT_UNAVAILABLE', 'The canonical audit lookup is unavailable.', { status: 503 });
  }
  try { return requireAuditRows(auditApi.findEvents({ action, target, limit: 20 })); }
  catch {
    refuse('BRIDGE_TERMINATE_AUDIT_UNAVAILABLE', 'The canonical audit lookup failed closed.', { status: 503 });
  }
}

function completedReceipt(envelope, expected) {
  if (envelope.audit ? !operationAudit.isNotRequired(envelope.audit, COMPLETED_ACTION, expected.idempotencyKey)
      : (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 || !SHA256_RE.test(envelope.eventHash || ''))) {
    refuse('BRIDGE_TERMINATE_CUSTODY_UNAVAILABLE', 'The stored audit disposition is invalid.', { status: 503 });
  }
  const details = envelope?.details;
  if (!details
      || details.schemaVersion !== 1
      || details.idempotencyKey !== expected.idempotencyKey
      || details.requestSha256 !== expected.requestSha256
      || details.actor !== expected.actor
      || details.agentId !== expected.agentId
      || details.runId !== expected.expectedRunId
      || details.pid !== expected.expectedPid
      || !TERMINAL.has(details.terminalStatus)
      || !Number.isSafeInteger(details.exitCode)
      || details.verifiedGone !== true) {
    refuse('BRIDGE_TERMINATE_AUDIT_UNAVAILABLE', 'The durable terminate receipt is invalid.', { status: 503 });
  }
  return Object.freeze({
    action: 'terminate',
    idempotencyKey: details.idempotencyKey,
    actor: details.actor,
    agentId: details.agentId,
    runId: details.runId,
    pid: details.pid,
    terminalStatus: details.terminalStatus,
    exitCode: details.exitCode,
    verifiedGone: true,
    verifiedGoneAt: details.verifiedGoneAt,
    terminalAt: details.terminalAt,
    ...(envelope.audit?.disposition === 'not-required'
      ? { audit: envelope.audit }
      : { auditSequence: envelope.sequence, auditEventHash: envelope.eventHash })
  });
}

function replayFailure(envelope, expected) {
  const details = envelope?.details;
  if (!details || details.schemaVersion !== 1
      || details.idempotencyKey !== expected.idempotencyKey
      || details.requestSha256 !== expected.requestSha256
      || details.actor !== expected.actor
      || details.agentId !== expected.agentId
      || details.runId !== expected.expectedRunId
      || details.pid !== expected.expectedPid
      || typeof details.code !== 'string'
      || !Object.hasOwn(FAILURE_MESSAGES, details.code)) {
    refuse('BRIDGE_TERMINATE_AUDIT_UNAVAILABLE', 'The durable terminate failure receipt is invalid.', { status: 503 });
  }
  throw new MissionBridgeError(details.code, FAILURE_MESSAGES[details.code], {
    status: Number.isSafeInteger(details.status) ? details.status : 503
  });
}

function findPriorOutcome(auditApi, expected) {
  const completedRows = auditFind(auditApi, COMPLETED_ACTION, expected.idempotencyKey);
  const completed = matchingEvent(completedRows, expected.requestSha256);
  if (completed) return Object.freeze({ kind: 'completed', envelope: completed });
  if (anyEvent(completedRows)) return Object.freeze({ kind: 'collision' });
  const failedRows = auditFind(auditApi, FAILED_ACTION, expected.idempotencyKey);
  const failed = matchingEvent(failedRows, expected.requestSha256);
  if (failed) return Object.freeze({ kind: 'failed', envelope: failed });
  if (anyEvent(failedRows)) return Object.freeze({ kind: 'collision' });
  const intentRows = auditFind(auditApi, INTENT_ACTION, expected.idempotencyKey);
  const intent = matchingEvent(intentRows, expected.requestSha256);
  if (intent) return Object.freeze({ kind: 'intent', envelope: intent });
  if (anyEvent(intentRows)) return Object.freeze({ kind: 'collision' });
  return Object.freeze({ kind: 'none' });
}

function collision() {
  refuse('BRIDGE_TERMINATE_IDEMPOTENCY_COLLISION', 'The idempotency key is already bound to a different request.', { status: 409 });
}

function replayPrior(prior, expected) {
  if (prior.kind === 'collision') collision();
  if (prior.kind === 'completed') return Object.freeze({ ok: true, receipt: completedReceipt(prior.envelope, expected) });
  if (prior.kind === 'failed') replayFailure(prior.envelope, expected);
  return null;
}

async function waitForPriorOutcome(auditApi, expected, dependencies) {
  const attempts = Math.max(1, Math.ceil(dependencies.idempotencyWaitTimeoutMs / dependencies.pollMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const prior = findPriorOutcome(auditApi, expected);
    const replay = replayPrior(prior, expected);
    if (replay) return replay;
    if (prior.kind !== 'intent') break;
    if (attempt + 1 < attempts) await dependencies.delay(dependencies.pollMs);
  }
  refuse('BRIDGE_TERMINATE_IN_PROGRESS', 'An identical terminate request is already in progress.', { status: 409 });
}

function readRegistry(presenceApi, dependencies) {
  try {
    return presenceApi.readRegistry(
      dependencies.stateFile || presenceApi.DEFAULT_STATE_FILE,
      { fsImpl: dependencies.fsImpl }
    );
  } catch {
    refuse('BRIDGE_TERMINATE_REGISTRY_UNAVAILABLE', FAILURE_MESSAGES.BRIDGE_TERMINATE_REGISTRY_UNAVAILABLE, { status: 503 });
  }
}

function targetRecord(registry, target, { requireRunning = true } = {}) {
  const record = registry?.agents?.[target.agentId] || null;
  if (!record) refuse('BRIDGE_TERMINATE_AGENT_UNKNOWN', 'No canonical presence record exists for the target.', { status: 404 });
  if (record.runId !== target.expectedRunId) {
    refuse('BRIDGE_TERMINATE_STALE_RUN', FAILURE_MESSAGES.BRIDGE_TERMINATE_STALE_RUN, { status: 409 });
  }
  if (record.pid !== target.expectedPid) {
    refuse('BRIDGE_TERMINATE_STALE_PID', FAILURE_MESSAGES.BRIDGE_TERMINATE_STALE_PID, { status: 409 });
  }
  if (TERMINAL.has(record.status)) {
    refuse('BRIDGE_TERMINATE_ALREADY_TERMINAL', FAILURE_MESSAGES.BRIDGE_TERMINATE_ALREADY_TERMINAL, { status: 409 });
  }
  if (requireRunning && record.status !== 'running') {
    refuse('BRIDGE_TERMINATE_NOT_ACTIVE', FAILURE_MESSAGES.BRIDGE_TERMINATE_NOT_ACTIVE, { status: 409 });
  }
  return record;
}

function authorize(actor, target, org, registry, assertAuthorized) {
  try { assertAuthorized({ from: actor, target: target.agentId, org, registry }); }
  catch (error) {
    if (error?.code === 'AGENT_WAKE_TARGET_UNKNOWN') {
      refuse('BRIDGE_TERMINATE_AGENT_UNKNOWN', 'No canonical presence record exists for the target.', { status: 404 });
    }
    const definiteRefusals = new Set([
      'AGENT_WAKE_ACTOR_UNKNOWN',
      'AGENT_WAKE_ACTOR_DISABLED',
      'AGENT_WAKE_TARGET_DISABLED',
      'AGENT_WAKE_SELF_REFUSED',
      'AGENT_WAKE_NOT_SUPERVISOR',
      'AGENT_WAKE_ROLE_READ_ONLY',
      'AGENT_WAKE_OUTSIDE_TOPOLOGY'
    ]);
    if (definiteRefusals.has(error?.code)) {
      refuse('BRIDGE_TERMINATE_ACTOR_REFUSED', 'The actor is not allowed to terminate this lane.', { status: 403 });
    }
    refuse('BRIDGE_TERMINATE_AUTHORIZATION_UNAVAILABLE', FAILURE_MESSAGES.BRIDGE_TERMINATE_AUTHORIZATION_UNAVAILABLE, { status: 503 });
  }
}

function liveness(isAlive, pid) {
  try {
    const value = isAlive(pid);
    return value === true ? true : value === false ? false : null;
  } catch { return null; }
}

function delay(milliseconds, timers = {}) {
  const setTimeoutImpl = timers.setTimeoutImpl || setTimeout;
  return new Promise(resolve => {
    const timer = setTimeoutImpl(resolve, milliseconds);
    timer?.unref?.();
  });
}

async function waitForProcessGone(pid, dependencies) {
  const attempts = Math.max(1, Math.ceil(dependencies.processGoneTimeoutMs / dependencies.pollMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const alive = liveness(dependencies.isAlive, pid);
    if (alive === false) return new Date(dependencies.clock()).toISOString();
    if (alive === null) {
      refuse('BRIDGE_TERMINATE_LIVENESS_UNCERTAIN', FAILURE_MESSAGES.BRIDGE_TERMINATE_LIVENESS_UNCERTAIN, { status: 504 });
    }
    if (attempt + 1 < attempts) await dependencies.delay(dependencies.pollMs);
  }
  refuse('BRIDGE_TERMINATE_LIVENESS_UNCERTAIN', FAILURE_MESSAGES.BRIDGE_TERMINATE_LIVENESS_UNCERTAIN, { status: 504 });
}

async function waitForTerminal(target, presenceApi, dependencies) {
  const attempts = Math.max(1, Math.ceil(dependencies.terminalTimeoutMs / dependencies.pollMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const registry = readRegistry(presenceApi, dependencies);
    const record = registry?.agents?.[target.agentId] || null;
    if (!record) refuse('BRIDGE_TERMINATE_AGENT_UNKNOWN', 'The canonical target record disappeared.', { status: 404 });
    if (record.runId !== target.expectedRunId) {
      refuse('BRIDGE_TERMINATE_STALE_RUN', FAILURE_MESSAGES.BRIDGE_TERMINATE_STALE_RUN, { status: 409 });
    }
    if (record.pid !== target.expectedPid) {
      refuse('BRIDGE_TERMINATE_STALE_PID', FAILURE_MESSAGES.BRIDGE_TERMINATE_STALE_PID, { status: 409 });
    }
    if (TERMINAL.has(record.status)) return record;
    if (attempt + 1 < attempts) await dependencies.delay(dependencies.pollMs);
  }
  refuse('BRIDGE_TERMINATE_TERMINAL_TIMEOUT', FAILURE_MESSAGES.BRIDGE_TERMINATE_TERMINAL_TIMEOUT, { status: 504 });
}

async function terminateWindowsTree(pid, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  if (platform !== 'win32') {
    throw new MissionBridgeError(
      'BRIDGE_TERMINATE_PLATFORM_UNSUPPORTED',
      'Process-tree termination is available only from the Windows Mission Bridge.',
      { status: 503 }
    );
  }
  if (!windowsJob.validTicks(dependencies.expectedStartTicks)) {
    throw new MissionBridgeError(
      'BRIDGE_TERMINATE_KILL_FAILURE',
      FAILURE_MESSAGES.BRIDGE_TERMINATE_KILL_FAILURE,
      { status: 503, details: { cause: 'exact process creation identity is unavailable' } }
    );
  }
  const terminateImpl = dependencies.terminateRegisteredJobImpl || windowsJob.terminateRegisteredJob;
  try {
    return await terminateImpl(pid, {
      ...(dependencies.windowsJobDependencies || {}),
      expectedStartTicks: dependencies.expectedStartTicks,
      cleanupTimeoutMs: dependencies.killTimeoutMs || DEFAULT_KILL_TIMEOUT_MS
    });
  } catch (error) {
    if (error?.code === 'WINDOWS_JOB_IDENTITY_MISMATCH') {
      throw new MissionBridgeError('BRIDGE_TERMINATE_STALE_PID', FAILURE_MESSAGES.BRIDGE_TERMINATE_STALE_PID, {
        status: 409
      });
    }
    throw new MissionBridgeError('BRIDGE_TERMINATE_KILL_FAILURE', FAILURE_MESSAGES.BRIDGE_TERMINATE_KILL_FAILURE, {
      status: 503,
      details: { cause: typeof error?.code === 'string' ? error.code.slice(0, 100) : null }
    });
  }
}

function claimIntent(auditApi, expected) {
  if (!auditApi || typeof auditApi.conditionalRecord !== 'function') {
    refuse('BRIDGE_TERMINATE_AUDIT_UNAVAILABLE', 'The canonical conditional audit writer is unavailable.', { status: 503 });
  }
  try {
    return auditApi.conditionalRecord({
      action: INTENT_ACTION,
      target: expected.idempotencyKey,
      eventId: `audit-${crypto.randomUUID()}`,
      decide({ findEvents }) {
        const completed = requireAuditRows(findEvents({ action: COMPLETED_ACTION, target: expected.idempotencyKey, limit: 20 }));
        const failed = requireAuditRows(findEvents({ action: FAILED_ACTION, target: expected.idempotencyKey, limit: 20 }));
        const intents = requireAuditRows(findEvents({ action: INTENT_ACTION, target: expected.idempotencyKey, limit: 20 }));
        const all = [...completed, ...failed, ...intents];
        if (all.length) {
          const matching = all.some(row => eventEnvelope(row)?.details?.requestSha256 === expected.requestSha256);
          return { kind: 'refused', refusal: { kind: matching ? 'replay' : 'collision' } };
        }
        return {
          kind: 'record',
          details: {
            schemaVersion: 1,
            idempotencyKey: expected.idempotencyKey,
            requestSha256: expected.requestSha256,
            actor: expected.actor,
            agentId: expected.agentId,
            runId: expected.expectedRunId,
            pid: expected.expectedPid
          },
          value: null
        };
      }
    });
  } catch {
    refuse('BRIDGE_TERMINATE_AUDIT_UNAVAILABLE', 'The canonical conditional audit writer failed closed.', { status: 503 });
  }
}

function recordFailure(auditApi, expected, error) {
  const code = Object.hasOwn(FAILURE_MESSAGES, error?.code) ? error.code : 'BRIDGE_TERMINATE_KILL_FAILURE';
  const status = Number.isSafeInteger(error?.status) ? error.status : 503;
  try {
    const receipt = auditApi.requireRecord(FAILED_ACTION, expected.idempotencyKey, {
      schemaVersion: 1,
      idempotencyKey: expected.idempotencyKey,
      requestSha256: expected.requestSha256,
      actor: expected.actor,
      agentId: expected.agentId,
      runId: expected.expectedRunId,
      pid: expected.expectedPid,
      code,
      status
    });
    if (!receipt || receipt.durable !== true || receipt.anchored !== true) throw new Error('not durable');
  } catch {
    refuse('BRIDGE_TERMINATE_AUDIT_UNAVAILABLE', 'The terminate failure could not be durably recorded.', { status: 503 });
  }
  throw new MissionBridgeError(code, FAILURE_MESSAGES[code], { status });
}

function recordCompleted(auditApi, expected, terminal, verifiedGoneAt) {
  let receipt;
  try {
    receipt = auditApi.requireRecord(COMPLETED_ACTION, expected.idempotencyKey, {
      schemaVersion: 1,
      idempotencyKey: expected.idempotencyKey,
      requestSha256: expected.requestSha256,
      actor: expected.actor,
      agentId: expected.agentId,
      runId: expected.expectedRunId,
      pid: expected.expectedPid,
      terminalStatus: terminal.status,
      exitCode: terminal.exitCode,
      verifiedGone: true,
      verifiedGoneAt,
      terminalAt: terminal.terminalAt
    });
  } catch {
    refuse('BRIDGE_TERMINATE_AUDIT_UNAVAILABLE', 'The terminate outcome could not be durably recorded.', { status: 503 });
  }
  if (!receipt || receipt.durable !== true || receipt.anchored !== true
      || !Number.isSafeInteger(receipt.sequence) || !SHA256_RE.test(String(receipt.eventHash || ''))) {
    refuse('BRIDGE_TERMINATE_AUDIT_UNAVAILABLE', 'The terminate outcome receipt was not durably anchored.', { status: 503 });
  }
  return completedReceipt({
    details: {
      schemaVersion: 1,
      idempotencyKey: expected.idempotencyKey,
      requestSha256: expected.requestSha256,
      actor: expected.actor,
      agentId: expected.agentId,
      runId: expected.expectedRunId,
      pid: expected.expectedPid,
      terminalStatus: terminal.status,
      exitCode: terminal.exitCode,
      verifiedGone: true,
      verifiedGoneAt,
      terminalAt: terminal.terminalAt
    },
    sequence: receipt.sequence,
    eventHash: receipt.eventHash
  }, expected);
}

function createTerminateAction(options = {}) {
  const actor = options.actor;
  const org = options.org;
  const auditApi = options.audit;
  const presenceApi = options.presence || presence;
  const assertAuthorized = options.assertAuthorized || agentWake.assertWakeAuthorized;
  const dependencies = Object.freeze({
    stateFile: options.stateFile,
    fsImpl: options.fsImpl,
    clock: options.clock || Date.now,
    isAlive: options.isAlive || fleetState.pidAlive,
    terminateProcess: options.terminateProcess || ((pid, identity) => terminateWindowsTree(pid, {
      ...options,
      expectedStartTicks: identity.processStartTicks
    })),
    processGoneTimeoutMs: options.processGoneTimeoutMs || DEFAULT_PROCESS_GONE_TIMEOUT_MS,
    terminalTimeoutMs: options.terminalTimeoutMs || DEFAULT_TERMINAL_TIMEOUT_MS,
    idempotencyWaitTimeoutMs: options.idempotencyWaitTimeoutMs || DEFAULT_IDEMPOTENCY_WAIT_TIMEOUT_MS,
    pollMs: options.pollMs || DEFAULT_POLL_MS,
    delay: options.delay || (milliseconds => delay(milliseconds, options))
  });

  return async function terminate(input) {
    const target = validateInput(input);
    const requestSha256 = effectiveRequestSha256(bodySha256(input, target), actor);
    const expected = Object.freeze({ ...target, actor, requestSha256 });
    const policy = operationAudit.capturePolicy(options);
    const storage = options.stateStore || require('../state-store').getStateStore();
    const replayStored = row => {
      if (row.inputHash !== requestSha256) collision();
      if (row.status !== 'succeeded') refuse('BRIDGE_TERMINATE_IN_PROGRESS', 'The earlier operation is pending or uncertain; it will not be replayed.', { status: 409 });
      const result = row.result;
      if (result?.kind === 'failed') return replayFailure(result.envelope, expected);
      if (result?.kind !== 'completed') refuse('BRIDGE_TERMINATE_CUSTODY_UNAVAILABLE', 'The stored operation has no validated outcome.', { status: 503 });
      return Object.freeze({ ok: true, receipt: completedReceipt(result.envelope, expected) });
    };
    const stored = storage.getOperation({ type: OPERATION_TYPE, key: target.idempotencyKey });
    if (stored) return replayStored(stored);
    if (policy.required) {
      const prior = findPriorOutcome(auditApi, expected);
      const replay = replayPrior(prior, expected);
      if (replay) return replay;
      if (prior.kind === 'intent') return waitForPriorOutcome(auditApi, expected, dependencies);
    } else {
      try {
        const probe = options.hasLegacyOperation || require('../audit-store').hasLegacyOperation;
        if (probe({ actions: [INTENT_ACTION, COMPLETED_ACTION, FAILED_ACTION], target: target.idempotencyKey })) {
          refuse('BRIDGE_TERMINATE_LEGACY_CUSTODY', 'This key has a legacy audit record; reconcile that outcome before requesting another termination.', { status: 409 });
        }
      } catch (error) {
        if (error instanceof MissionBridgeError) throw error;
        refuse('BRIDGE_TERMINATE_CUSTODY_UNAVAILABLE', 'Legacy operation custody could not be checked; no process was changed.', { status: 503 });
      }
    }
    const initialRegistry = readRegistry(presenceApi, dependencies);
    targetRecord(initialRegistry, target);
    authorize(actor, target, org, initialRegistry, assertAuthorized);
    let claim;
    try { claim = storage.reserveOperation({ type: OPERATION_TYPE, key: target.idempotencyKey, inputHash: requestSha256, leaseMs: 360000 }); }
    catch (error) {
      if (error.code === 'OPERATION_INPUT_CONFLICT') collision();
      refuse('BRIDGE_TERMINATE_IN_PROGRESS', 'The operation is already claimed or its custody is unavailable.', { status: 409 });
    }
    if (claim.disposition !== 'reserved') return replayStored(claim.operation);
    storage.markOperationExecuting(claim.handle, { leaseMs: 360000 });
    try {
      if (policy.required) {
        const intent = claimIntent(auditApi, expected);
        if (intent?.recorded !== true || intent.durable !== true || intent.anchored !== true) {
          refuse('BRIDGE_TERMINATE_AUDIT_UNAVAILABLE', 'The configured terminate intent was not exclusively and durably recorded.', { status: 503 });
        }
      }
      const fencedRegistry = readRegistry(presenceApi, dependencies);
      const fencedRecord = targetRecord(fencedRegistry, target);
      authorize(actor, target, org, fencedRegistry, assertAuthorized);
      if (liveness(dependencies.isAlive, target.expectedPid) !== true) {
        refuse('BRIDGE_TERMINATE_LIVENESS_UNCERTAIN', FAILURE_MESSAGES.BRIDGE_TERMINATE_LIVENESS_UNCERTAIN, { status: 504 });
      }
      await dependencies.terminateProcess(target.expectedPid, Object.freeze({ processStartTicks: fencedRecord.processStartTicks, runId: fencedRecord.runId }));
      const verifiedGoneAt = await waitForProcessGone(target.expectedPid, dependencies);
      const terminal = await waitForTerminal(target, presenceApi, dependencies);
      const details = { schemaVersion: 1, idempotencyKey: target.idempotencyKey, requestSha256, actor,
        agentId: target.agentId, runId: target.expectedRunId, pid: target.expectedPid,
        terminalStatus: terminal.status, exitCode: terminal.exitCode, verifiedGone: true, verifiedGoneAt, terminalAt: terminal.terminalAt };
      const recorded = policy.required ? recordCompleted(auditApi, expected, terminal, verifiedGoneAt) : null;
      const envelope = { details, ...(recorded ? { sequence: recorded.auditSequence, eventHash: recorded.auditEventHash }
        : { audit: operationAudit.skippedStatus(COMPLETED_ACTION, target.idempotencyKey) }) };
      const receipt = completedReceipt(envelope, expected);
      storage.succeedOperation(claim.handle, { result: { kind: 'completed', envelope } });
      return Object.freeze({ ok: true, receipt });
    } catch (error) {
      // A timeout/refusal after dispatch cannot become a retryable kill.
      storage.markOperationUncertain(claim.handle, { errorCode: 'TERMINATE_UNCERTAIN', errorMessage: 'Termination did not reach a confirmed terminal receipt.' });
      if (policy.required && !(error instanceof MissionBridgeError && ['BRIDGE_TERMINATE_AUDIT_UNAVAILABLE', 'BRIDGE_TERMINATE_AUTHORIZATION_UNAVAILABLE'].includes(error.code))) recordFailure(auditApi, expected, error);
      throw error;
    }

  };
}

module.exports = Object.freeze({
  COMPLETED_ACTION,
  DEFAULT_KILL_TIMEOUT_MS,
  DEFAULT_IDEMPOTENCY_WAIT_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  DEFAULT_PROCESS_GONE_TIMEOUT_MS,
  DEFAULT_TERMINAL_TIMEOUT_MS,
  FAILED_ACTION,
  INTENT_ACTION,
  REQUEST_BODY_SHA256,
  createTerminateAction,
  effectiveRequestSha256,
  terminateWindowsTree,
  validateInput
});
