'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { createStateStore } = require('./state-store');
const { plaintextCredentialPattern } = require('./secret-patterns');

const NAMESPACE = 'agent.continuation.v1';
const RETRY_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT',
  'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'SERVICE_UNAVAILABLE', 'PROVIDER_UNAVAILABLE']);
const INTERRUPTED_CODES = new Set(['CODEX_APP_SERVER_EXITED', 'CLAUDE_CLI_EXITED', 'ACP_PROCESS_EXITED',
  'AGY_CLI_EXITED', 'AGY_CLI_TURN_TIMEOUT', 'AGENT_PROCESS_EXITED', 'PROVIDER_PROCESS_EXITED']);
const STATUSES = new Set(['idle', 'ready', 'retry_wait', 'claimed', 'running', 'reconciling',
  'uncertain', 'stopped', 'blocked']);
// The delay completed() puts between a finished turn and its next ledger
// review, and the base of the retry backoff. Exported because a test that
// advances a fake clock has to advance past it to see a due row at all, and a
// fixture holding its own copy of this number silently stops testing the
// scheduling boundary the moment this one changes.
const DEFAULT_BASE_DELAY_MS = 15000;
const DESCRIPTOR_KEYS = ['sessionId', 'resumeThreadId', 'resumeThreadProvider', 'cwd', 'tier',
  'effort', 'resumeAccount', 'requestKeys', 'treeIdentity', 'roleBinding', 'profileId', 'agentId'];

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function object(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('CONTINUATION_INVALID', `${label} must be a plain object.`);
  }
  if (keys && Object.keys(value).some(key => !keys.includes(key))) {
    fail('CONTINUATION_INVALID', `${label} contains an unsupported field.`);
  }
  return value;
}
function string(value, label, max = 512, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    fail('CONTINUATION_INVALID', `${label} must be bounded text without control characters.`);
  }
  return value;
}
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('CONTINUATION_INVALID', `${label} is out of range.`);
  return value;
}
function descriptor(input) {
  object(input, 'resume descriptor', DESCRIPTOR_KEYS);
  const result = {};
  for (const key of DESCRIPTOR_KEYS.filter(key => !['requestKeys', 'treeIdentity', 'roleBinding'].includes(key))) {
    result[key] = string(input[key], key, key === 'cwd' ? 4096 : 512, key !== 'sessionId');
  }
  if (result.resumeThreadProvider && !['codex', 'claude', 'gemini', 'grok', 'local'].includes(result.resumeThreadProvider)) {
    fail('CONTINUATION_INVALID', 'The resume provider is not supported.');
  }
  if (input.requestKeys != null) {
    object(input.requestKeys, 'requestKeys', ['threadId', 'treeAnchors']);
    const anchors = input.requestKeys.treeAnchors;
    if (!Array.isArray(anchors) || anchors.length < 1 || anchors.length > 16) fail('CONTINUATION_INVALID', 'A saved tree needs its exact ancestry.');
    result.requestKeys = { threadId: string(input.requestKeys.threadId, 'node id', 128),
      treeAnchors: anchors.map(value => string(value, 'tree anchor', 128)) };
    if (result.requestKeys.treeAnchors.at(-1) !== result.requestKeys.threadId) {
      fail('CONTINUATION_INVALID', 'The saved node must match the final tree anchor.');
    }
  } else result.requestKeys = null;
  if (input.treeIdentity != null) {
    object(input.treeIdentity, 'treeIdentity', ['selfName', 'managerName']);
    result.treeIdentity = { selfName: string(input.treeIdentity.selfName, 'circle name', 120),
      managerName: string(input.treeIdentity.managerName, 'manager name', 120, true) };
  } else result.treeIdentity = null;
  if (input.roleBinding != null) {
    object(input.roleBinding, 'roleBinding', ['id', 'agentId', 'expectedOrgRevision', 'expectedRoleRevision', 'selection']);
    result.roleBinding = { id: string(input.roleBinding.id, 'role id', 128),
      agentId: string(input.roleBinding.agentId, 'role agent id', 128, true),
      // Revision zero is the authoritative built-in role / initial org revision,
      // accepted by the app's start parser and role binding resolver.
      expectedOrgRevision: integer(input.roleBinding.expectedOrgRevision, 'organisation revision', 0),
      expectedRoleRevision: integer(input.roleBinding.expectedRoleRevision, 'role revision', 0) };
    if (Object.hasOwn(input.roleBinding, 'selection')) {
      if (input.roleBinding.selection !== '' || result.roleBinding.id !== 'worker'
        || !result.roleBinding.agentId || !result.treeIdentity) {
        fail('CONTINUATION_INVALID', 'An empty role choice requires an exact tree-bound Worker identity.');
      }
      // Retain the choice, not authority to apply it. A resumed start must
      // revalidate this binding against the current authoritative saved seat.
      result.roleBinding.selection = '';
    }
  } else result.roleBinding = null;
  return result;
}
function keyFor(input) {
  const value = descriptor(input);
  const identity = value.requestKeys
    ? ['tree', value.requestKeys.treeAnchors[0], value.requestKeys.threadId]
    : ['host', value.sessionId];
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
function checkpoint(input) {
  if (input == null) return null;
  object(input, 'checkpoint', ['taskId', 'fingerprint', 'unchanged', 'engagementTaskId', 'engagementHostId']);
  const signature = string(input.fingerprint, 'checkpoint fingerprint', 64);
  if (!/^[a-f0-9]{64}$/.test(signature)) fail('CONTINUATION_INVALID', 'A checkpoint needs its exact content digest.');
  const result = { taskId: string(input.taskId, 'task id', 128), fingerprint: signature,
    unchanged: integer(input.unchanged === undefined ? 0 : input.unchanged, 'unchanged turns', 0, 1000) };
  if (input.engagementTaskId !== undefined || input.engagementHostId !== undefined) {
    result.engagementTaskId = string(input.engagementTaskId, 'engagement task', 128);
    result.engagementHostId = string(input.engagementHostId, 'engagement host', 512);
  }
  return result;
}
function classifyFailure(error, { retrySafe = false } = {}) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  // Never infer retry safety from a message or a provider's generic retryable
  // flag. Quota, authentication and cancellation always win over transient hints.
  if (status === 401 || status === 403 || status === 429
    || /AUTH|QUOTA|RATE.?LIMIT|USAGE.?LIMIT|BUDGET|PAYMENT|CANCEL|ABORT|PERMISSION|POLICY/.test(code)) {
    return { retry: false, reason: 'requires_attention' };
  }
  if (INTERRUPTED_CODES.has(code)) return { retry: false, uncertain: true, reason: 'interrupted_turn' };
  if (retrySafe === true && RETRY_CODES.has(code)) return { retry: true, reason: 'transient_failure' };
  return { retry: false, reason: 'unclassified_failure' };
}

// An explicit installation/profile file is required. This module does not open
// the singleton, import legacy state, register an OS task, or restore authority.
// Existing StateStore memory entries provide integrity checks, FULL SQLite WAL,
// and revision CAS; no second schema or JSON lock protocol is introduced.
//
// track -> begin -> heartbeat* -> success/failed records an accepted live turn.
// dueRecoveries -> claim -> begin precedes a scheduled dispatch. Claiming an
// uncertain row instead enters reconciling: observe the SAME saved thread and
// call reconcile, without replaying an unobserved prompt. Every mutation returns
// a new handle; retain it. stop(key) wins against every earlier handle. Only an
// explicit person/brief track(...,{resume:true}) can revive a stopped row.
function createContinuationState({ file, now = Date.now, leaseMs = 30000,
  maxRetries = 5, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = 120000, onChange = () => {} } = {}) {
  string(file, 'explicit state file', 4096);
  if (file !== ':memory:' && !path.isAbsolute(file)) fail('CONTINUATION_INVALID', 'The state file must be absolute.');
  if (typeof now !== 'function' || typeof onChange !== 'function') fail('CONTINUATION_INVALID', 'Clock and change observer must be functions.');
  integer(leaseMs, 'lease duration', 1000, 300000);
  integer(maxRetries, 'retry limit', 0, 10);
  integer(baseDelayMs, 'retry delay', 1000, 3600000);
  integer(maxDelayMs, 'maximum retry delay', baseDelayMs, 3600000);
  const store = createStateStore({ file, clock: now });
  let closed = false;
  const time = () => integer(now(), 'clock result');
  function active() { if (closed) fail('CONTINUATION_CLOSED', 'The continuation store is closed.'); }
  function validKey(key) {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) fail('CONTINUATION_INVALID', 'Invalid continuation key.');
    return key;
  }
  function decode(entry) {
    if (!entry) return null;
    const value = entry.value;
    object(value, 'stored continuation');
    if (value.version !== 1 || !STATUSES.has(value.status)) fail('CONTINUATION_CORRUPT', 'The stored continuation schema is invalid.');
    // sessionId is an app-generated public ID, not an authentication session.
    // The durable-memory guard intentionally rejects that spelling; preserve
    // the same identity under hostId without relaxing its secret validation.
    const { hostId, ...rest } = value.descriptor || {};
    const decoded = descriptor({ ...rest, sessionId: hostId });
    if (keyFor(decoded) !== entry.key) fail('CONTINUATION_CORRUPT', 'The stored continuation identity does not match its key.');
    integer(value.fence, 'stored fence', 1);
    integer(value.retries, 'stored retries', 0, 10);
    integer(value.updatedAtMs, 'stored update time');
    integer(value.dueAtMs, 'stored due time');
    let progress = checkpoint(value.checkpoint);
    const { engagement, ...stored } = value;
    if (engagement != null) {
      object(engagement, 'stored engagement', ['taskId', 'hostId']);
      if (!progress) fail('CONTINUATION_CORRUPT', 'Engagement requires a continuation checkpoint.');
      progress = checkpoint({ ...progress, engagementTaskId: engagement.taskId, engagementHostId: engagement.hostId });
    }
    if (value.lease !== null) {
      object(value.lease, 'stored lease', ['digest', 'untilMs']);
      if (!/^[a-f0-9]{64}$/.test(value.lease.digest)) fail('CONTINUATION_CORRUPT', 'The stored lease is invalid.');
      integer(value.lease.untilMs, 'stored lease expiry');
    }
    return { ...stored, checkpoint: progress, descriptor: decoded, key: entry.key, revision: entry.revision };
  }
  function read(key) { active(); return decode(store.getMemory({ namespace: NAMESPACE, key: validKey(key) })); }
  function publicRow(row) {
    if (!row) return null;
    const { lease, ...result } = row;
    return { ...result, leaseUntilMs: lease?.untilMs ?? null };
  }
  function readHandle(handle, statuses, requireLease = false) {
    object(handle, 'continuation handle');
    const row = read(handle.key);
    if (!row || row.revision !== handle.revision || row.fence !== handle.fence
      || !statuses.includes(row.status)) fail('CONTINUATION_FENCE_LOST', 'The continuation changed; re-read it before acting.');
    if ((requireLease || row.lease) && (!row.lease || row.lease.untilMs <= time()
      || typeof handle.claimId !== 'string' || digest(handle.claimId) !== row.lease.digest)) {
      fail('CONTINUATION_FENCE_LOST', 'The continuation lease is no longer owned by this attempt.');
    }
    return row;
  }
  function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
  function write(prior, value, claimId = null) {
    active();
    const { key, revision, ...data } = value;
    const { sessionId, ...rest } = descriptor(data.descriptor);
    // Keep the stored v1 checkpoint readable by older engines during rollback.
    // Their row decoder permits extension fields, but its checkpoint decoder
    // accepts exactly the original three keys. New readers join this evidence.
    const { engagementTaskId, engagementHostId, ...progress } = data.checkpoint || {};
    const engagement = engagementTaskId ? { taskId: engagementTaskId, hostId: engagementHostId } : null;
    const entry = store.setMemory({ namespace: NAMESPACE, key,
      expectedRevision: prior?.revision ?? 0,
      value: { ...data, checkpoint: data.checkpoint ? progress : null, engagement,
        descriptor: { ...rest, hostId: sessionId }, updatedAtMs: time() } }).entry;
    const row = publicRow(decode(entry));
    if (claimId) row.claimId = claimId;
    // Observation happens after the durable commit. A broken UI observer must
    // not turn an accepted state change into a caller retry of the same action.
    try {
      const observed = onChange(publicRow(decode(entry)));
      if (observed && typeof observed.catch === 'function') observed.catch(() => {});
    } catch { /* list/get expose the durable status for the next UI refresh. */ }
    return row;
  }
  function leased(prior, status) {
    // The digest of our random lease can coincidentally match a credential
    // shape (for example a SHA256 beginning with "eaa"). Select fresh random
    // custody material before writing anything. Keep the v1 representation and
    // the memory guard unchanged; supplied text and checkpoints get no bypass.
    const credentialShape = plaintextCredentialPattern();
    for (let attempt = 0; attempt < 8; attempt++) {
      const claimId = crypto.randomBytes(24).toString('base64url');
      const leaseDigest = digest(claimId);
      if (credentialShape.test(leaseDigest)) continue;
      return write(prior, { ...prior, status, fence: prior.fence + 1,
        lease: { digest: leaseDigest, untilMs: time() + leaseMs }, reason: status }, claimId);
    }
    fail('CONTINUATION_LEASE_UNAVAILABLE', 'Could not generate a durable continuation lease.');
  }
  function track(input, { resume = false } = {}) {
    if (typeof resume !== 'boolean') fail('CONTINUATION_INVALID', 'Explicit resume must be a boolean.');
    const clean = descriptor(input);
    const key = keyFor(clean);
    const prior = read(key);
    if (prior && !resume) return publicRow(prior);
    if (prior?.lease && prior.lease.untilMs > time()) fail('CONTINUATION_ACTIVE', 'The prior continuation still owns its turn.');
    return write(prior, { version: 1, key, descriptor: clean, status: 'idle',
      checkpoint: null, retries: 0, dueAtMs: time(), lease: null,
      fence: (prior?.fence ?? 0) + 1, reason: resume ? 'person_resumed' : 'tracked' });
  }
  function save(handle, patch) {
    object(patch, 'continuation update', ['descriptor', 'checkpoint']);
    const row = readHandle(handle, [...STATUSES].filter(status => !['stopped', 'blocked', 'uncertain'].includes(status)), Boolean(handle.claimId));
    const next = { ...row };
    if (patch.descriptor !== undefined) {
      next.descriptor = descriptor(patch.descriptor);
      if (keyFor(next.descriptor) !== row.key) fail('CONTINUATION_INVALID', 'A continuation cannot move to another saved node.');
    }
    if (patch.checkpoint !== undefined) next.checkpoint = checkpoint(patch.checkpoint);
    return write(row, next, handle.claimId);
  }
  function begin(handle, { observed = false } = {}) {
    if (typeof observed !== 'boolean') fail('CONTINUATION_INVALID', 'Observed turn must be a boolean.');
    // The host has already admitted ordinary person/brief/courier traffic.
    // Record that fact even before a scheduled continuation's due time, but
    // never use observation to revive Stop, hard failure or unknown custody.
    const statuses = observed ? ['idle', 'claimed', 'ready', 'retry_wait'] : ['idle', 'claimed'];
    const row = readHandle(handle, statuses, handle.status === 'claimed');
    if (row.status !== 'claimed') return leased(row, 'running');
    return write(row, { ...row, status: 'running', reason: 'dispatching' }, handle.claimId);
  }
  function heartbeat(handle) {
    const row = readHandle(handle, ['running', 'claimed', 'reconciling'], true);
    return write(row, { ...row, lease: { ...row.lease, untilMs: Math.max(row.lease.untilMs, time() + leaseMs) } }, handle.claimId);
  }
  function completed(row, { checkpoint: progress, delayMs = baseDelayMs } = {}) {
    integer(delayMs, 'continuation delay', 0, 3600000);
    return write(row, { ...row, status: 'ready', retries: 0, lease: null,
      checkpoint: progress === undefined ? row.checkpoint : checkpoint(progress), dueAtMs: time() + delayMs, reason: 'turn_completed' });
  }
  function success(handle, options = {}) {
    return completed(readHandle(handle, ['idle', 'running'], handle.status !== 'idle'), options);
  }
  function failure(row, error, options, { observedTerminal = false } = {}) {
    const classification = classifyFailure(error, options);
    if (classification.uncertain) {
      return write(row, { ...row, status: 'uncertain', lease: null, dueAtMs: time() + baseDelayMs, reason: 'interrupted_turn' });
    }
    const retry = classification.retry && row.retries < maxRetries;
    if (row.status === 'reconciling' && !observedTerminal && retry) {
      return write(row, { ...row, status: 'uncertain', lease: null, retries: row.retries + 1,
        dueAtMs: time() + Math.min(maxDelayMs, baseDelayMs * (2 ** row.retries)), reason: 'reconciliation_retry' });
    }
    return write(row, { ...row, status: retry ? 'retry_wait' : 'blocked', lease: null,
      retries: retry ? row.retries + 1 : row.retries,
      dueAtMs: retry ? time() + Math.min(maxDelayMs, baseDelayMs * (2 ** row.retries)) : 0,
      reason: classification.retry && !retry ? 'retry_limit' : classification.reason });
  }
  function failed(handle, error, options = {}) {
    return failure(readHandle(handle, ['idle', 'claimed', 'running', 'reconciling'], handle.status !== 'idle'), error, options);
  }
  function stop(key) {
    // Stop is the one operation intentionally retried on a concurrent revision:
    // cancellation must win a racing completion, rather than dropping the stop.
    for (let count = 0; count < 8; count += 1) {
      const row = read(key);
      if (!row || row.status === 'stopped') return publicRow(row);
      try { return write(row, { ...row, status: 'stopped', lease: null, dueAtMs: 0,
        fence: row.fence + 1, reason: 'person_stopped' }); }
      catch (error) { if (error.code !== 'MEMORY_REVISION_CONFLICT') throw error; }
    }
    fail('CONTINUATION_BUSY', 'The continuation changed repeatedly before Stop could commit.');
  }
  function list() {
    active();
    const keys = store.transaction(db => db.prepare('SELECT entry_key FROM memory_entries WHERE namespace = ? ORDER BY entry_key').all(NAMESPACE));
    return keys.map(({ entry_key: key }) => publicRow(read(key)));
  }
  function dueRecoveries({ includeUncertain = false } = {}) {
    const due = [];
    for (const visible of list()) {
      let row = read(visible.key);
      if (row.lease && row.lease.untilMs <= time()) {
        try {
          const recoverable = row.status === 'claimed';
          write(row, { ...row, status: recoverable ? 'ready' : 'uncertain', lease: null,
            dueAtMs: time(), fence: row.fence + 1, reason: recoverable ? 'unused_claim_expired' : 'interrupted_turn' });
          row = read(row.key);
        } catch (error) { if (error.code === 'MEMORY_REVISION_CONFLICT') continue; throw error; }
      }
      if (['ready', 'retry_wait'].includes(row.status) && row.dueAtMs <= time()) {
        due.push({ ...publicRow(row), action: 'continue' });
      } else if (includeUncertain && row.status === 'uncertain' && row.reason !== 'terminal_evidence_unavailable' && row.dueAtMs <= time() && row.descriptor.resumeThreadId) {
        due.push({ ...publicRow(row), action: 'reconcile' });
      }
    }
    return due.sort((a, b) => a.dueAtMs - b.dueAtMs || a.key.localeCompare(b.key));
  }
  function claim(handle) {
    try {
      const row = readHandle(handle, ['ready', 'retry_wait', 'uncertain']);
      if (row.dueAtMs > time() || row.status === 'uncertain' && (!row.descriptor.resumeThreadId || row.reason === 'terminal_evidence_unavailable')) return null;
      return leased(row, row.status === 'uncertain' ? 'reconciling' : 'claimed');
    } catch (error) {
      if (['CONTINUATION_FENCE_LOST', 'MEMORY_REVISION_CONFLICT'].includes(error.code)) return null;
      throw error;
    }
  }
  /* 'end_turn' is the raw ACP stopReason a real turn ends with on success;
     kept in step with agent-ledger-continuation.js's own SUCCESS_STATUSES. */
  const RECONCILE_SUCCESS_STATUSES = new Set(['completed', 'end_turn']);
  function reconcile(handle, { observedThreadId, terminalStatus, checkpoint: progress, retrySafe = false, error } = {}) {
    const row = readHandle(handle, ['reconciling'], true);
    if (!row.descriptor.resumeThreadId || observedThreadId !== row.descriptor.resumeThreadId) {
      fail('CONTINUATION_RECONCILE_REFUSED', 'Recovery must observe the exact saved conversation.');
    }
    // A provider can prove the conversation identity while exposing no old
    // terminal state. Preserve uncertainty and stop automatic observation
    // attempts; another resume cannot manufacture the missing evidence.
    if (terminalStatus === 'unknown') return write(row, { ...row, status: 'uncertain', lease: null,
      dueAtMs: 0, reason: 'terminal_evidence_unavailable' });
    if (terminalStatus === 'cancelled') return stop(row.key);
    if (RECONCILE_SUCCESS_STATUSES.has(terminalStatus)) return completed(row, { checkpoint: progress });
    // An opted-in host may observe that shutdown interrupted this exact saved
    // turn. Schedule a NEW ledger review only after that observation; do not
    // label the interrupted work completed or erase its retry/progress history.
    if (terminalStatus === 'interrupted' && retrySafe === true) {
      return write(row, { ...row, status: 'ready', lease: null,
        checkpoint: progress === undefined ? row.checkpoint : checkpoint(progress),
        dueAtMs: time() + baseDelayMs, reason: 'interruption_observed' });
    }
    if (terminalStatus === 'failed') return failure(row, error, { retrySafe }, { observedTerminal: true });
    fail('CONTINUATION_RECONCILE_REFUSED', 'The saved conversation has no confirmed terminal turn.');
  }
  function settleRetry(handle, options = {}) {
    return options.success === true ? success(handle, options) : failed(handle, options.error, options);
  }
  function close() {
    if (closed) return;
    closed = true;
    store.close();
  }
  return Object.freeze({ track, save, success, failed, stop, cancel: stop, dueRecoveries, claim, begin,
    heartbeat, reconcile, settleRetry, get: key => publicRow(read(key)), list, close });
}

module.exports = { createContinuationState, keyFor, classifyFailure, DEFAULT_BASE_DELAY_MS };
