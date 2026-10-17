'use strict';

// In-process host callbacks are the authority boundary. No wire identity,
// policy, provider name or message text grants a capability here.
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const LIMITS = Object.freeze({ deadlineMs: 60000, messages: 16, chars: 64000, attempts: 256, operations: 128 });
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function identity(snapshot, activeTurn = true) {
  const fields = ['treeKey', 'nodeId', 'sessionId', 'generation'];
  if (activeTurn) fields.push('threadId', 'turnId');
  else if (snapshot?.threadId) fields.push('threadId');
  if (!snapshot || fields.some(key => snapshot[key] === null || snapshot[key] === undefined || snapshot[key] === ''))
    fail('CONTROL_IDENTITY_UNKNOWN', 'The host has no exact active turn identity.');
  return Object.fromEntries(fields.map(key => [key, snapshot[key]]));
}
function sameIdentity(expected, actual) {
  if (!actual || Object.keys(expected).some(key => expected[key] !== actual[key]))
    fail('CONTROL_IDENTITY_CHANGED', 'The tree, session or receiving turn changed.');
}
function sameSession(expected, actual) {
  if (!actual || ['treeKey', 'nodeId', 'sessionId', 'generation'].some(key => expected[key] !== actual[key])
      || (Object.hasOwn(expected, 'threadId') && expected.threadId !== actual.threadId))
    fail('CONTROL_SESSION_CHANGED', 'The checkpoint belongs to another session.');
}
function sessionIdentity(snapshot) {
  return identity(snapshot, false);
}
function validDeadline(ms) {
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > LIMITS.deadlineMs)
    fail('CONTROL_DEADLINE_INVALID', 'Choose a bounded deadline of 1 through 60000 milliseconds.');
}
function notCancelled(signal) {
  if (signal?.aborted) fail('ABORT_ERR', 'The control wait was cancelled; no delivery was inferred.');
}
function acknowledgement(expected, response) {
  if (!response || response.threadId !== expected.threadId || response.turnId !== expected.turnId)
    fail('CONTROL_ACK_MISMATCH', 'The provider did not acknowledge the selected receiving turn.');
}
function operationSafe(snapshot, active) {
  return active === 0 && snapshot?.interactionPending !== true;
}
function admitted(hold) {
  if (hold) fail('CONTROL_DRAIN_HELD', 'Checkpoint/drain is held; no new work was admitted.');
}
function submissionSafe(attempts) {
  if (attempts.length) fail('CONTROL_DELIVERY_UNRESOLVED', 'A prior delivery is unresolved; no protected work was admitted.');
}
function deliveryOnTime(deadline, now) {
  if (now >= deadline) fail('CONTROL_DELIVERY_DEADLINE', 'The delivery acknowledgement missed its bounded deadline.');
}

function createControlDelivery({ snapshot, children = () => [], queue, adapter, format, commit, journal = {},
  clock = () => performance.now(), newId = () => crypto.randomUUID() }) {
  journal.attempts = Array.isArray(journal.attempts) ? journal.attempts : [];
  // Retained accepted records are tombstones, not in-flight capacity. Never
  // discard their identities or message IDs to make a full journal pass.
  journal.history = Array.isArray(journal.history) ? journal.history : [];
  journal.holds = journal.holds && typeof journal.holds === 'object' ? journal.holds : {};
  const operations = new Map(), waiters = new Set();
  // A process loss cannot turn an unacknowledged submission into a retry.
  for (const attempt of journal.attempts) if (attempt.status === 'submitting') {
    attempt.status = 'unknown'; attempt.reason = 'host-restarted';
  }
  const save = () => commit(); // strict durability, unlike best-effort diagnostic save
  const notify = () => { for (const wake of [...waiters]) wake(); };
  const active = nodeId => [...operations.values()].filter(op => op.identity.nodeId === nodeId).length;
  const unresolved = nodeId => journal.attempts.filter(a => a.identity.nodeId === nodeId && ['submitting', 'unknown'].includes(a.status));
  const holdOf = nodeId => {
    const seen = new Set(); let current = snapshot(nodeId);
    while (current) {
      if (seen.has(current.nodeId)) fail('CONTROL_TREE_INVALID', 'A cyclic tree cannot establish admission scope.');
      seen.add(current.nodeId);
      if (journal.holds[current.nodeId]) return journal.holds[current.nodeId];
      current = current.parentNodeId ? snapshot(current.parentNodeId) : null;
    }
    return null;
  };
  function admitWork(nodeId) { admitted(holdOf(nodeId)); }
  function retireAccepted(nodeId) {
    const ids = new Set([...journal.history, ...journal.attempts].filter(a => a.identity.nodeId === nodeId && a.status === 'accepted').flatMap(a => a.messageIds));
    const items = queue(nodeId);
    for (let i = items.length - 1; i >= 0; i--) if (ids.has(items[i].id)) items.splice(i, 1);
  }
  function available(nodeId) { retireAccepted(nodeId); return unresolved(nodeId).length === 0; }
  function retainAcceptedHistory() {
    const accepted = journal.attempts.filter(a => a.status === 'accepted');
    journal.history.push(...accepted);
    journal.attempts = journal.attempts.filter(a => a.status !== 'accepted');
  }
  function scopeOf(nodeId) {
    const result = [], pending = [nodeId], seen = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id) || seen.size >= 4096) fail('CONTROL_TREE_INVALID', 'Drain scope is cyclic or exceeds 4096 nodes.');
      seen.add(id); result.push(id); pending.push(...children(id));
    }
    return result;
  }

  async function waitUntil(predicate, { timeoutMs, signal, check = () => {} }) {
    validDeadline(timeoutMs); notCancelled(signal); check();
    const deadline = clock() + timeoutMs;
    for (;;) {
      check(); notCancelled(signal);
      const ready = predicate(); if (ready) return { timedOut: false, value: ready };
      if (clock() >= deadline) return { timedOut: true, value: null };
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer);
          waiters.delete(finish); signal?.removeEventListener('abort', finish); resolve(); };
        waiters.add(finish);
        const timer = setTimeout(finish, Math.min(20, Math.max(1, deadline - clock())));
        signal?.addEventListener('abort', finish, { once: true });
        // Recheck after registration; no missed report or cancellation wake.
        if (signal?.aborted || predicate()) finish();
      });
    }
  }
  function beginBoundary({ nodeId, requestId, timeoutMs = 10000, protectedWork = true }) {
    validDeadline(timeoutMs);
    if (requestId !== null && !['string', 'number'].includes(typeof requestId)) fail('CONTROL_REQUEST_INVALID', 'A typed JSON-RPC request ID is required.');
    const current = snapshot(nodeId), bound = sessionIdentity(current);
    // This flag comes from the native MCP method classifier, not tool args.
    // Protocol discovery stays usable during a hold or uncertain delivery.
    if (protectedWork !== false) { admitted(holdOf(nodeId)); submissionSafe(unresolved(nodeId)); }
    const deliveryIdentity = current.turn === 'running' && current.threadId && current.turnId ? identity(current) : null;
    if (operations.size >= LIMITS.operations) fail('CONTROL_OPERATION_LIMIT', 'Too many in-flight control boundaries.');
    if ([...operations.values()].some(op => op.identity.nodeId === nodeId && op.requestId === requestId))
      fail('CONTROL_REQUEST_DUPLICATE', 'That exact request is already in flight.');
    const boundaryId = newId();
    operations.set(boundaryId, { identity: bound, deliveryIdentity, requestId, timeoutMs });
    return { boundaryId, identity: bound };
  }
  async function endBoundary({ boundaryId, nodeId, signal }) {
    const operation = operations.get(boundaryId);
    if (!operation) fail('CONTROL_BOUNDARY_UNKNOWN', 'The boundary is absent or already settled.');
    if (nodeId !== operation.identity.nodeId) fail('CONTROL_BOUNDARY_SCOPE_REFUSED', 'The boundary belongs to another node.');
    operations.delete(boundaryId); notify();
    const session = operation.identity;
    sameIdentity(session, snapshot(session.nodeId)); notCancelled(signal);
    if (!operationSafe(snapshot(session.nodeId), active(session.nodeId)))
      return { status: 'held', reason: 'protected-operation-or-human-interaction' };
    if (!available(session.nodeId)) return { status: 'unknown', reason: 'previous-delivery-unresolved', automaticRetry: false };
    const bound = operation.deliveryIdentity;
    if (!bound) return { status: 'unsupported', reason: 'no-active-turn', operationCompleted: true,
      messagesPending: queue(session.nodeId).length, providerAcknowledged: false };
    sameIdentity(bound, snapshot(bound.nodeId));
    const receiver = adapter(bound.nodeId);
    if (typeof receiver?.steerTurn !== 'function')
      return { status: 'unsupported', reason: 'adapter-active-turn-steering-unavailable', fallback: 'existing-next-turn-courier' };
    const batch = []; let chars = 0;
    for (const item of queue(bound.nodeId)) {
      const size = (item.text || '').length + 200;
      if (batch.length >= LIMITS.messages || (batch.length && chars + size > LIMITS.chars)) break;
      batch.push(item); chars += size;
    }
    if (!batch.length) return { status: 'empty' };
    const text = format(bound.nodeId, batch);
    if (typeof text !== 'string' || text.length > LIMITS.chars)
      return { status: 'held', reason: 'formatted-message-bound', messagesRetained: true };
    retainAcceptedHistory();
    if (journal.attempts.length >= LIMITS.attempts) fail('CONTROL_JOURNAL_FULL', 'Unresolved delivery capacity is full; no history was discarded.');
    const attempt = { attemptId: newId(), identity: bound, messageIds: batch.map(item => item.id), status: 'submitting' };
    journal.attempts.push(attempt);
    try { save(); } catch (error) { journal.attempts.pop(); fail('CONTROL_DURABILITY_REQUIRED', 'No delivery occurred: its intent could not be persisted.'); }
    let timer, onAbort, submitted = false;
    const deadline = clock() + operation.timeoutMs;
    try {
      // No interrupt, restart or new turn. The actual adapter owns its protocol.
      const response = await Promise.race([
        Promise.resolve().then(() => {
          sameIdentity(bound, snapshot(bound.nodeId)); notCancelled(signal);
          deliveryOnTime(deadline, clock());
          if (!operationSafe(snapshot(bound.nodeId), active(bound.nodeId)))
            fail('CONTROL_OPERATION_PROTECTED', 'An operation or interaction became protected before submission.');
          submitted = true;
          return receiver.steerTurn({ threadId: bound.threadId, turnId: bound.turnId, text });
        }),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(), { code: 'CONTROL_DELIVERY_DEADLINE' })), operation.timeoutMs);
          onAbort = () => reject(Object.assign(new Error(), { code: 'ABORT_ERR' }));
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
        })
      ]);
      notCancelled(signal); deliveryOnTime(deadline, clock());
      acknowledgement(bound, response); sameIdentity(bound, snapshot(bound.nodeId));
      attempt.status = 'accepted'; save();
      const ids = new Set(attempt.messageIds), items = queue(bound.nodeId);
      for (let i = items.length - 1; i >= 0; i--) if (ids.has(items[i].id)) items.splice(i, 1);
      save(); notify();
      return { status: 'accepted', attemptId: attempt.attemptId, identity: bound,
        messages: batch.length, providerAcknowledged: true, modelCompliance: 'unknown' };
    } catch (error) {
      // Nothing reached the provider: a check failed before the request, or the
      // adapter says it refused before sending (error.notSubmitted). The messages
      // stay queued for the next turn; no uncertain attempt blocks the worker.
      if (!submitted || error?.notSubmitted === true) {
        journal.attempts = journal.attempts.filter(entry => entry !== attempt);
        try { save(); } catch { /* the attempt was only an intent; nothing was sent */ }
        notify();
        return { status: 'not-delivered', reason: String(error?.code || 'CONTROL_NOT_SUBMITTED'),
          messagesRetained: true, providerAcknowledged: false, automaticRetry: false };
      }
      attempt.status = 'unknown'; attempt.reason = String(error?.code || 'CONTROL_PROVIDER_RESPONSE_LOST');
      try { save(); } catch { /* uncertain durable outcome remains explicit */ }
      return { status: 'unknown', reason: attempt.reason, attemptId: attempt.attemptId, automaticRetry: false };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  function checkpoint(nodeId, requestedBy) {
    const current = snapshot(nodeId);
    if (!current) fail('CONTROL_TARGET_UNKNOWN', 'The checkpoint target is absent.');
    let held = journal.holds[nodeId];
    if (!held) {
      const session = sessionIdentity(current), sessions = [], unknownSessions = [];
      for (const id of scopeOf(nodeId)) {
        try { sessions.push(sessionIdentity(snapshot(id))); } catch { unknownSessions.push(id); }
      }
      held = { nodeId, requestedBy, session, sessions, unknownSessions, status: 'draining' };
    }
    journal.holds[nodeId] = held; save(); notify();
    return status(nodeId);
  }
  function status(nodeId) {
    const held = journal.holds[nodeId];
    if (!held) return { status: 'not-requested', idle: false };
    const current = snapshot(nodeId);
    try { sameSession(held.session, current); } catch { return { status: 'unresolved', reason: 'session-changed', idle: false }; }
    if (held.unknownSessions?.length)
      return { status: 'unresolved', reason: 'descendant-identity-unknown', idle: false, newWorkHeld: true };
    const scope = scopeOf(nodeId);
    try { for (const expected of held.sessions || [held.session]) sameSession(expected, snapshot(expected.nodeId)); }
    catch { return { status: 'unresolved', reason: 'descendant-session-changed', idle: false, newWorkHeld: true }; }
    const pendingDelivery = scope.reduce((sum, id) => sum + unresolved(id).length, 0);
    const protectedCount = scope.reduce((sum, id) => sum + active(id), 0);
    const quiescent = scope.every(id => { const state = snapshot(id);
      return state?.state === 'running' && state.turn === 'idle' && !state.interactionPending; });
    const drained = quiescent && protectedCount === 0 && pendingDelivery === 0;
    return { status: pendingDelivery ? 'unresolved' : drained ? 'drained' : 'draining',
      ...(pendingDelivery ? { reason: 'delivery-unresolved' } : {}),
      activeOperations: protectedCount, unresolvedDeliveries: pendingDelivery, scopedNodes: scope.length,
      currentTurn: current.turn, idle: drained, newWorkHeld: true };
  }
  async function drain(nodeId, requestedBy, options) {
    checkpoint(nodeId, requestedBy);
    const result = await waitUntil(() => status(nodeId).status === 'drained', options);
    return result.timedOut ? { ...status(nodeId), status: 'unresolved', reason: 'deadline', idle: false } : status(nodeId);
  }
  // A worker's session ended: boundaries it opened can never be closed by it,
  // so they no longer count as protected work or block its request ids.
  function retire(nodeId) {
    let removed = 0;
    for (const [boundaryId, operation] of operations) if (operation.identity.nodeId === nodeId) {
      operations.delete(boundaryId); removed += 1;
    }
    if (removed) notify();
    return removed;
  }
  function release(nodeId) {
    const held = journal.holds[nodeId], current = snapshot(nodeId);
    if (!held) return { status: 'not-requested' };
    sameSession(held.session, current);
    if (current.state !== 'running') fail('CONTROL_STOP_FENCE', 'Release cannot resume a stopped or failed session.');
    delete journal.holds[nodeId]; save(); notify();
    return { status: 'released', startedWork: false };
  }
  return Object.freeze({ beginBoundary, endBoundary, checkpoint, drain, release, retire, status,
    admitWork, available, waitUntil, notify, activeOperations: active,
    reconciliation: () => ({ status: 'unknown', reason: 'no-provider-delivery-query-contract', automaticRetry: false }) });
}
module.exports = Object.freeze({ createControlDelivery, LIMITS });
