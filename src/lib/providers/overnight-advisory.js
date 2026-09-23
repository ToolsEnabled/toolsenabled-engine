'use strict';

// A narrow control plane for useful, owner-submitted overnight local advisory
// work.  It deliberately rides the shared fenced task store: this module never
// invokes a model, starts a browser, reads a vault, or gives task text authority.

const crypto = require('node:crypto');
const operationAudit = require('../operation-audit');
const { getStateStore } = require('../state-store');
const { assertOvernightAdvisoryAllowed } = require('../policy');
const { containsSensitiveMaterial } = require('./research-hermes');

const QUEUE = 'overnight-local-advisory';
const TYPE = 'local-advisory';
const VERSION = 1;
const MAX_QUEUE_DEPTH = 8;
const MAX_ATTEMPTS = 6;
const MAX_TITLE = 160;
// This leaves room for the fixed safety wrapper and up to eight checklist
// entries while still fitting Hermes's independent 8 KiB prompt ceiling.
const MAX_PROMPT = 5000;
const MAX_CHECKLIST_ITEMS = 8;
const MAX_CHECKLIST_ITEM = 240;
const LIFECYCLE_OPERATION = 'overnight-advisory.lifecycle';
const LIFECYCLE_LEASE_MS = 60_000;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const ACTORS = Object.freeze(['human', 'codex', 'claude', 'gemini', 'grok', 'local']);
const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

// The generic task store also detects credential-like data.  This additional
// gate prevents the advisory queue from becoming a back door for PII or opaque
// vault/profile pointers, which a no-tool worker could neither need nor safely
// dereference.
const SENSITIVE_TEXT = /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{12,}|\b(?:sk_(?:live|test|prod)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b|\b\d{3}-\d{2}-\d{4}\b|\b(?:\d[ -]*?){13,19}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:vault|profiles?)\b)/i;

class OvernightAdvisoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OvernightAdvisoryError';
    this.code = code;
    this.details = details;
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_INPUT_INVALID', `${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unsupported = Object.keys(value).filter(key => !allowed.includes(key));
  if (unsupported.length) {
    throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_INPUT_INVALID', `${label} contains unsupported field(s): ${unsupported.join(', ')}.`);
  }
}

function safeText(value, label, { min = 1, max = 1000, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_INPUT_INVALID', `${label} must be a string from ${min} through ${max} characters.`);
  }
  if (containsProhibitedMaterial(value)) {
    throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_SENSITIVE_CONTENT', `${label} appears to contain credentials, private data, or a vault/profile reference.`);
  }
  return value;
}

function containsProhibitedMaterial(value) {
  return typeof value === 'string' && (containsSensitiveMaterial(value) || SENSITIVE_TEXT.test(value));
}

function actor(value) {
  const normalized = safeText(value, 'actor', { min: 3, max: 16, pattern: /^[a-z]+$/ });
  if (!ACTORS.includes(normalized)) {
    throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_INPUT_INVALID', `actor must be one of: ${ACTORS.join(', ')}.`);
  }
  return normalized;
}

function idempotencyKey(value) {
  return safeText(value, 'idempotencyKey', { min: 8, max: 160, pattern: SAFE_KEY });
}

function input(value) {
  const source = plainObject(value, 'overnight advisory submission');
  exactKeys(source, ['actor', 'idempotencyKey', 'title', 'prompt', 'acceptanceChecklist', 'maxOutputTokens', 'allowStrong'], 'overnight advisory submission');
  const checklist = source.acceptanceChecklist;
  if (!Array.isArray(checklist) || checklist.length < 1 || checklist.length > MAX_CHECKLIST_ITEMS || new Set(checklist).size !== checklist.length) {
    throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_INPUT_INVALID', `acceptanceChecklist must contain one through ${MAX_CHECKLIST_ITEMS} unique items.`);
  }
  const maxOutputTokens = source.maxOutputTokens === undefined ? 384 : source.maxOutputTokens;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 512) {
    throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_INPUT_INVALID', 'maxOutputTokens must be an integer from 1 through 512.');
  }
  if (source.allowStrong !== undefined && typeof source.allowStrong !== 'boolean') {
    throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_INPUT_INVALID', 'allowStrong must be a boolean when supplied.');
  }
  return {
    actor: actor(source.actor),
    idempotencyKey: idempotencyKey(source.idempotencyKey),
    title: safeText(source.title, 'title', { min: 1, max: MAX_TITLE }),
    prompt: safeText(source.prompt, 'prompt', { min: 1, max: MAX_PROMPT }),
    acceptanceChecklist: checklist.map((item, index) => safeText(item, `acceptanceChecklist[${index}]`, { min: 1, max: MAX_CHECKLIST_ITEM })),
    maxOutputTokens,
    allowStrong: source.allowStrong === true
  };
}

function metadata(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.context !== 'string') {
    throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_TASK_INVALID', 'The durable task does not contain overnight advisory metadata.');
  }
  let value;
  try { value = JSON.parse(payload.context); }
  catch { throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_TASK_INVALID', 'The durable task has malformed overnight advisory metadata.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION || value.kind !== TYPE ||
      !Array.isArray(value.acceptanceChecklist) || value.acceptanceChecklist.length < 1 || value.acceptanceChecklist.length > MAX_CHECKLIST_ITEMS ||
      value.acceptanceChecklist.some(item => typeof item !== 'string' || item.length < 1 || item.length > MAX_CHECKLIST_ITEM) ||
      !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > 512 ||
      typeof value.allowStrong !== 'boolean') {
    throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_TASK_INVALID', 'The durable task has unsupported overnight advisory metadata.');
  }
  // A task may be written only through overnight_advisory.submit, but validate
  // it again here so a malformed direct store row can never become model input.
  return {
    version: VERSION, kind: TYPE,
    acceptanceChecklist: value.acceptanceChecklist.map((item, index) => safeText(item, `stored acceptanceChecklist[${index}]`, { min: 1, max: MAX_CHECKLIST_ITEM })),
    maxOutputTokens: value.maxOutputTokens, allowStrong: value.allowStrong,
    title: safeText(payload.title, 'stored title', { min: 1, max: MAX_TITLE }),
    prompt: safeText(payload.objective, 'stored prompt', { min: 1, max: MAX_PROMPT })
  };
}

function taskMetadata(task) {
  if (!task || typeof task !== 'object') return null;
  return compact({
    taskId: task.id || task.taskId, queue: task.queue || task.queueName, type: task.type || task.taskType,
    status: task.status, attempt: task.attempt, maxAttempts: task.maxAttempts, expiryPolicy: task.expiryPolicy,
    createdAt: task.createdAt, createdAtMs: task.createdAtMs, updatedAt: task.updatedAt, updatedAtMs: task.updatedAtMs,
    availableAt: task.availableAt, availableAtMs: task.availableAtMs, leaseExpiresAt: task.leaseExpiresAt,
    leaseExpiresAtMs: task.leaseExpiresAtMs, checkpointRevision: task.checkpointRevision,
    cancellationRequested: task.cancellationRequested === undefined ? task.cancelRequested : task.cancellationRequested
  });
}

function lifecycleResponse(action, response, replayed = false) {
  return compact({
    action,
    accepted: response.accepted !== false,
    status: String(response.status || 'unknown').slice(0, 80),
    running: Boolean(response.running),
    detail: response.detail === undefined ? undefined : String(response.detail).slice(0, 500),
    replayed
  });
}

function validLifecycleState(value, { requireAccepted = false } = {}) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.status === 'string' && value.status.length > 0 &&
    typeof value.running === 'boolean' && (!requireAccepted || typeof value.accepted === 'boolean'));
}

class OvernightAdvisoryControl {
  constructor(dependencies = {}) {
    this.state = dependencies.state || getStateStore();
    this.runtime = dependencies.runtime || null;
    this.assertEnabled = dependencies.assertEnabled || assertOvernightAdvisoryAllowed;
    this.auditRequire = dependencies.auditRequire || operationAudit.requireRecord;
    this.auditRecord = dependencies.auditRecord || operationAudit.record;
  }

  // ONE CAPTURED POLICY PER ADVISORY ACTION. The intent read the audit setting
  // and the refusal test below read it again, so a submit or a lifecycle change
  // resolved the same setting twice and could be refused against a policy that
  // had changed after its own intent was already decided. Reached through
  // tool-registry.js#executeTool() both reads already share one frozen
  // AsyncLocalStorage policy; see the scope note in model.js. This makes the
  // control correct on its own instead of only inside such a scope.
  _audit(action, target, details) {
    const captured = this.auditRequire === operationAudit.requireRecord ? operationAudit.capturePolicy() : null;
    const intent = captured === null
      ? this.auditRequire(action, target, details)
      : this.auditRequire(action, target, details, { auditPolicy: captured });
    if ((!intent || intent.durable !== true)
      && (!operationAudit.isNotRequired(intent, action, target)
        || (captured === null ? operationAudit.configured() : captured.required))) {
      throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_AUDIT_REQUIRED', 'The advisory control action was not started because its audit intent was not durably recorded.');
    }
    return intent;
  }

  submit(value) {
    const prepared = input(value);
    try { this.assertEnabled(); }
    catch { throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_DISABLED', 'Overnight local advisory work is disabled by policy.'); }
    this._audit('overnight_advisory.submit', QUEUE, {
      actor: prepared.actor, idempotencyKeyHash: crypto.createHash('sha256').update(prepared.idempotencyKey).digest('hex'),
      titleBytes: Buffer.byteLength(prepared.title, 'utf8'), promptBytes: Buffer.byteLength(prepared.prompt, 'utf8'),
      checklistCount: prepared.acceptanceChecklist.length, maxOutputTokens: prepared.maxOutputTokens, allowStrong: prepared.allowStrong
    });
    let result;
    try {
      result = this.state.submitBoundedTask({
      queue: QUEUE, type: TYPE, idempotencyKey: prepared.idempotencyKey,
      payload: {
        title: prepared.title,
        objective: prepared.prompt,
        context: JSON.stringify({ version: VERSION, kind: TYPE, acceptanceChecklist: prepared.acceptanceChecklist, maxOutputTokens: prepared.maxOutputTokens, allowStrong: prepared.allowStrong })
      },
      expiryPolicy: 'retry', maxAttempts: MAX_ATTEMPTS
      }, MAX_QUEUE_DEPTH);
    } catch (error) {
      if (error && error.code === 'TASK_QUEUE_FULL') {
        throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_QUEUE_FULL', `The bounded overnight advisory queue already has ${MAX_QUEUE_DEPTH} active tasks.`);
      }
      throw error;
    }
    const task = result && result.task ? result.task : result;
    return {
      ...taskMetadata(task), replayed: Boolean(result && (result.replayed === true || result.disposition === 'replay')),
      queueDepthLimit: MAX_QUEUE_DEPTH, workerType: TYPE, contentTrust: 'untrusted', grantsAuthority: false
    };
  }

  list(value = {}) {
    const source = plainObject(value, 'overnight advisory list');
    exactKeys(source, ['status', 'limit'], 'overnight advisory list');
    if (source.limit !== undefined && (!Number.isSafeInteger(source.limit) || source.limit < 1 || source.limit > 100)) {
      throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_INPUT_INVALID', 'limit must be an integer from 1 through 100.');
    }
    const tasks = this.state.listTasks({ queue: QUEUE, status: source.status, limit: source.limit || 100 });
    return { tasks: tasks.filter(task => task.type === TYPE || task.taskType === TYPE).map(taskMetadata), workerType: TYPE };
  }

  status(value) {
    const source = plainObject(value, 'overnight advisory status');
    exactKeys(source, ['taskId'], 'overnight advisory status');
    const taskId = safeText(source.taskId, 'taskId', { min: 8, max: 160, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/ });
    const task = this.state.getTask({ taskId, includePayload: false, includeCheckpoint: true });
    if (!task || (task.queue !== QUEUE && task.queueName !== QUEUE) || (task.type !== TYPE && task.taskType !== TYPE)) {
      throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_TASK_NOT_FOUND', 'No overnight advisory task exists with that taskId.');
    }
    return { ...taskMetadata(task), result: task.result, error: task.error, latestCheckpoint: task.latestCheckpoint, workerType: TYPE, ...UNTRUSTED_CONTENT };
  }

  lifecycleStatus() {
    if (!this.runtime || typeof this.runtime.status !== 'function') return { available: false, status: 'unconfigured', running: false };
    const status = this.runtime.status();
    if (!validLifecycleState(status)) {
      throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_RUNTIME_INVALID', 'The local lifecycle adapter returned an invalid status response.');
    }
    return compact({ available: true, status: String(status.status || 'unknown').slice(0, 80), running: Boolean(status.running), detail: status.detail === undefined ? undefined : String(status.detail).slice(0, 500) });
  }

  lifecycle(value) {
    const source = plainObject(value, 'overnight advisory lifecycle request');
    exactKeys(source, ['actor', 'action', 'idempotencyKey'], 'overnight advisory lifecycle request');
    const who = actor(source.actor);
    const action = safeText(source.action, 'action', { min: 4, max: 5, pattern: /^(start|stop)$/ });
    const key = idempotencyKey(source.idempotencyKey);
    if (!this.runtime || typeof this.runtime[action] !== 'function') {
      throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_RUNTIME_UNAVAILABLE', 'Overnight advisory lifecycle control is not configured on this host.');
    }
    if (action === 'start') {
      try { this.assertEnabled(); }
      catch { throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_DISABLED', 'Overnight local advisory work is disabled by policy.'); }
    }
    this._audit(`overnight_advisory.lifecycle.${action}`, 'local-advisory-worker', {
      actor: who, idempotencyKeyHash: crypto.createHash('sha256').update(key).digest('hex')
    });
    const reservation = this.state.reserveOperation({
      type: LIFECYCLE_OPERATION,
      key,
      inputHash: crypto.createHash('sha256').update(JSON.stringify({ action, actor: who })).digest('hex'),
      ownerId: 'overnight-advisory-lifecycle-' + process.pid,
      leaseMs: LIFECYCLE_LEASE_MS
    });
    if (reservation.disposition === 'replay') {
      const replay = reservation.result;
      if (!validLifecycleState(replay, { requireAccepted: true }) || replay.action !== action) {
        throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_LIFECYCLE_REPLAY_INVALID', 'The stored lifecycle replay is invalid.');
      }
      return lifecycleResponse(action, replay, true);
    }
    if (reservation.disposition !== 'reserved' || !reservation.handle) {
      throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_LIFECYCLE_RESERVATION_FAILED', 'The lifecycle operation could not be durably reserved.');
    }
    let handle = reservation.handle;
    try {
      const executing = this.state.markOperationExecuting(handle, { leaseMs: LIFECYCLE_LEASE_MS });
      handle = executing.handle;
      const response = this.runtime[action]({ actor: who, idempotencyKey: key });
      if (!validLifecycleState(response, { requireAccepted: true })) {
        throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_RUNTIME_INVALID', 'The local lifecycle adapter returned an invalid response.');
      }
      const output = lifecycleResponse(action, response, false);
      this.state.succeedOperation(handle, { result: output });
      return output;
    } catch (error) {
      // A child launch or exact-PID stop can have taken effect even if its local
      // acknowledgement was interrupted. Reconcile only the desired observable
      // state; otherwise preserve uncertainty and forbid a replay of this key.
      let observed = null;
      try { observed = this.runtime.status(); } catch { /* Preserve uncertainty below. */ }
      const converged = validLifecycleState(observed) &&
        ((action === 'start' && observed.running === true) || (action === 'stop' && observed.running === false));
      try {
        if (converged) {
          const output = lifecycleResponse(action, { accepted: true, status: observed.status, running: observed.running, detail: observed.detail }, false);
          this.state.succeedOperation(handle, { result: output });
          return output;
        }
        this.state.markOperationUncertain(handle, {
          errorCode: 'OVERNIGHT_ADVISORY_LIFECYCLE_UNCERTAIN',
          errorMessage: 'The local advisory worker lifecycle outcome could not be confirmed.'
        });
      } catch { /* Preserve the primary runtime failure without unbounded detail. */ }
      throw error;
    }
  }
}

module.exports = {
  ACTORS, LIFECYCLE_LEASE_MS, MAX_ATTEMPTS, MAX_PROMPT, MAX_QUEUE_DEPTH, QUEUE, TYPE, UNTRUSTED_CONTENT, VERSION,
  OvernightAdvisoryControl, OvernightAdvisoryError, containsProhibitedMaterial, input, metadata, safeText, taskMetadata
};
