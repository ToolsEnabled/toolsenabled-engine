'use strict';

// This broker never makes a human decision. It retains a bounded request in
// memory for the owner's interactive terminal; tool/agent callers cannot answer
// through Fleet's MCP surface. Form values, source prose and provider approval
// context stay out of summaries/events/state; show() alone returns that context.
const crypto = require('node:crypto');
const { validateInputRequest, validateInputResponse } = require('./agent-engine/input-contract');
const CANCEL = Object.freeze({ action: 'cancel', content: null });
function refusal(code, message) { return Object.assign(new Error(message), { code }); }
function identity(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512; }
function createInteractionBroker({ timeoutMs = 110000, maxPending = 32, now = () => Date.now() } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 290000
    || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 32) throw refusal('HOST_INPUT_INVALID', 'Invalid interaction bounds.');
  const pending = new Map();
  const seen = new Set();
  let closed = false;
  function summary(item, state, reason) {
    return Object.freeze({ interactionId: item.id, inputId: item.request.inputId,
      nodeId: item.owner.nodeId, sessionId: item.owner.sessionId, parentSessionId: item.owner.parentSessionId,
      threadId: item.request.threadId, turnId: item.request.turnId,
      sourceName: item.request.sourceName, kind: item.request.kind,
      state, reason, requiresUserDecision: true, responseAuthority: 'same-owner-interactive-terminal', expiresAt: new Date(item.expiresAt).toISOString() });
  }
  function notify(item, type, state, reason) {
    item.notify?.({ type, threadId: item.request.threadId, turnId: item.request.turnId, payload: summary(item, state, reason) });
  }
  function finish(item, answer, reason) {
    if (pending.get(item.id) !== item) return false;
    pending.delete(item.id);
    clearTimeout(item.timer);
    item.signal?.removeEventListener('abort', item.abort);
    try { notify(item, 'interaction_resolved', answer.action === 'cancel' ? 'cancelled' : 'answered', reason); }
    catch { /* the correlated request must settle even if a diagnostic sink failed */ }
    finally { item.resolve(answer); }
    return true;
  }
  function request(owner, raw, { signal, onEvent } = {}) {
    const checked = validateInputRequest(raw);
    const item = { id: crypto.randomUUID(), request: checked, owner: Object.freeze({ ...owner }),
      expiresAt: now() + timeoutMs, signal, notify: onEvent, timer: null };
    // Inherited read-only authority is a hard lower bound. A form that happens
    // to contain an approval must not become a route around that bound.
    let reason = closed ? 'host_closed' : !identity(owner?.nodeId) || !identity(owner?.sessionId)
      || !identity(owner?.parentSessionId) ? 'parent_identity_unavailable'
      : !Number.isInteger(owner.level) || owner.level < 2 ? 'read_only_or_unknown_authority'
      : signal?.aborted ? 'provider_cancelled'
      : pending.size >= maxPending ? 'capacity' : null;
    const key = JSON.stringify([owner?.nodeId, owner?.sessionId, checked.inputId]);
    if (seen.has(key)) reason = 'duplicate';
    if (seen.size >= 4096) reason = 'session_capacity';
    if (reason) {
      notify(item, 'interaction_required', 'unavailable', reason);
      return Promise.resolve(CANCEL);
    }
    seen.add(key);
    return new Promise(resolve => {
      item.resolve = resolve;
      item.abort = () => finish(item, CANCEL, 'provider_cancelled');
      pending.set(item.id, item);
      signal?.addEventListener('abort', item.abort, { once: true });
      item.timer = setTimeout(() => finish(item, CANCEL, 'timeout'), timeoutMs);
      item.timer.unref?.();
      try { notify(item, 'interaction_required', 'pending', 'human_input_required'); }
      catch { finish(item, CANCEL, 'handoff_failed'); }
    });
  }
  function inspect(id) {
    const item = pending.get(id);
    if (!item || now() >= item.expiresAt) {
      if (item) finish(item, CANCEL, 'timeout');
      throw refusal('HOST_INPUT_STALE', 'That interaction expired or was already resolved. Nothing was answered.');
    }
    return item;
  }
  return Object.freeze({
    request,
    list: () => [...pending.values()].map(item => summary(item, 'pending', 'human_input_required')),
    // These methods belong to the private owner-terminal transport only; never
    // register them as agent tools or accept claimed "human" roles from callers.
    show(id) {
      const item = inspect(id);
      return Object.freeze({ ...summary(item, 'pending', 'human_input_required'), request: item.request });
    },
    answer(id, binding, raw) {
      const item = inspect(id);
      if (!binding || ['nodeId', 'sessionId', 'parentSessionId', 'threadId', 'turnId', 'inputId']
        .some(key => binding[key] !== (key in item.request ? item.request[key] : item.owner[key]))) {
        throw refusal('HOST_INPUT_IDENTITY_MISMATCH', 'The interaction belongs to a different worker, session or turn.');
      }
      const answer = validateInputResponse(raw, item.request);
      finish(item, answer, 'owner_terminal');
      return { interactionId: id, action: answer.action, resolved: true };
    },
    close() {
      closed = true;
      for (const item of [...pending.values()]) finish(item, CANCEL, 'host_closed');
    },
  });
}
module.exports = { createInteractionBroker };
