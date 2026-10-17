'use strict';

// Private host composition only. No caller metadata, rollout/config parser,
// permission setter, RPC or public agent tool belongs to this registry.
const SCOPE = Object.freeze(['nodeId', 'launchId', 'sessionId', 'provider', 'workspaceId',
  'generation', 'level', 'parentSessionId']);
const APPROVAL = new Set(['no-prompts', 'prompt-required', 'prompt-on-failure', 'prompt-untrusted']);
const SANDBOX = new Set(['read-only', 'workspace-write', 'unrestricted']);
function own(value, key) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && Object.hasOwn(field, 'value') ? field.value : undefined;
  } catch { return undefined; }
}
function id(value) { return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(value); }
function scope(value) {
  const result = {};
  for (const field of SCOPE) result[field] = own(value, field);
  for (const field of ['nodeId', 'launchId', 'sessionId', 'provider', 'workspaceId']) if (!id(result[field])) return null;
  if (!Number.isSafeInteger(result.generation) || result.generation < 1
      || ![1, 2, 3, 4].includes(result.level)
      || !(result.parentSessionId === null || id(result.parentSessionId))) return null;
  const threadId = own(value, 'threadId');
  if (!(threadId === null || id(threadId))) return null;
  return Object.freeze({ ...result, threadId });
}
function sameScope(a, b) { return Boolean(a && b && SCOPE.every(key => a[key] === b[key])); }
function rpcId(value) { return id(value) || (Number.isSafeInteger(value) && value >= 0); }
function publicResult(status, reason, policy = null) {
  return Object.freeze({ schemaVersion: 1, status, reason, observedPolicy: policy,
    policyApplied: false, permissionsGranted: false, humanConsentQualified: false,
    mcpApprovalMode: 'unknown', fallback: 'unchanged' });
}
// classifyMethod names an observed provider request as a thread 'start' or
// 'resume' (or neither); the driver's own receipt module supplies it, so no
// provider wire vocabulary lives here.
function createHostLaunchPolicy({ resolveBinding, normalizeThreadPolicy, classifyMethod, clock = Date.now, maxAgeMs = 60000 } = {}) {
  if (typeof resolveBinding !== 'function' || typeof normalizeThreadPolicy !== 'function' || typeof classifyMethod !== 'function'
      || typeof clock !== 'function' || !Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 300000)
    throw new TypeError('Host policy observation requires trusted composition and bounded TTL');
  const launches = new WeakMap(), handoffs = new WeakMap();
  function now() { try { const n = clock(); return Number.isSafeInteger(n) && n >= 0 ? n : null; } catch { return null; } }
  function resolve(key) { if (!id(key)) return null; try { return scope(resolveBinding(key)); } catch { return null; } }
  function get(map, token) { return token && typeof token === 'object' ? map.get(token) : undefined; }
  function token() { return Object.freeze(Object.create(null)); }
  function retire(record, reason) { record.active = false; record.pending = null; record.receipt = null; record.reason = reason; }
  function current(record) {
    const live = resolve(record.key);
    return record.active && sameScope(record.binding, live)
      && (!record.committed || live.threadId === record.committedThreadId);
  }
  const host = Object.freeze({
    beginLaunch(key) {
      const handle = token(), binding = resolve(key);
      const record = { key: id(key) ? key : null, binding, active: Boolean(binding),
        committed: false, committedThreadId: null, pending: null, receipt: null,
        reason: binding ? 'thread-receipt-unavailable' : 'canonical-launch-unavailable' };
      launches.set(handle, record);
      // The owner gives this closure only to the adapter of this exact launch.
      // Observer possession is an in-process boundary, not human/IPC proof.
      const observe = event => {
        if (!record.active || !record.binding || !current(record)) return false;
        const phase = own(event, 'phase');
        if (phase === 'closed') { retire(record, 'provider-closed'); return false; }
        if (record.committed) {
          record.pending = null; record.receipt = null; record.reason = 'launch-observation-retired'; return false;
        }
        const method = own(event, 'method'), requestId = own(event, 'id');
        let kind;
        try { kind = classifyMethod(method); } catch { kind = null; }
        if (!['start', 'resume'].includes(kind) || !rpcId(requestId)) {
          record.pending = null; record.receipt = null; record.reason = 'observation-unsupported'; return false;
        }
        if (phase === 'begin') {
          const at = now();
          record.receipt = null;
          if (at === null || (kind === 'resume' && !record.binding.threadId)) {
            record.pending = null; record.reason = 'observation-unavailable'; return false;
          }
          record.pending = { method, id: requestId, startedAt: at };
          record.reason = 'thread-receipt-pending'; return true;
        }
        const pending = record.pending;
        record.pending = null; record.receipt = null;
        if (!pending || method !== pending.method || typeof requestId !== typeof pending.id || requestId !== pending.id) {
          record.reason = 'response-correlation-mismatch'; return false;
        }
        if (phase !== 'reply') { record.reason = 'provider-reply-unavailable'; return false; }
        const at = now();
        if (at === null || at < pending.startedAt || at - pending.startedAt > maxAgeMs) {
          record.reason = 'provider-request-stale'; return false;
        }
        let projection;
        try { projection = normalizeThreadPolicy(method, own(event, 'result')); } catch { projection = null; }
        const threadId = own(projection, 'threadId'), policy = own(projection, 'policy');
        const approval = own(policy, 'approval'), sandbox = own(policy, 'sandbox');
        if (!id(threadId) || !APPROVAL.has(approval) || !SANDBOX.has(sandbox)) {
          record.reason = 'provider-policy-incomplete'; return false;
        }
        if (kind === 'resume' && threadId !== record.binding.threadId) {
          record.reason = 'response-thread-mismatch'; return false;
        }
        record.receipt = { threadId, policy: Object.freeze({ approval, sandbox }), observedAt: at };
        record.reason = 'canonical-commit-pending'; return true;
      };
      return Object.freeze({ handle, observe });
    },
    commitLaunch(handle, returnedThreadId) {
      const record = get(launches, handle);
      if (!record?.active || record.committed || !id(returnedThreadId)) return false;
      const live = resolve(record.key);
      if (!sameScope(record.binding, live) || live.threadId !== returnedThreadId
          || (record.binding.threadId !== null && record.binding.threadId !== returnedThreadId)
          || (record.receipt && record.receipt.threadId !== returnedThreadId)) {
        retire(record, 'canonical-commit-mismatch'); return false;
      }
      record.committed = true; record.committedThreadId = returnedThreadId;
      record.reason = record.receipt ? 'correlated-thread-policy' : record.reason;
      return true;
    },
    issueParentHandoff(handle, childKey) {
      const handoff = token();
      handoffs.set(handoff, { parent: get(launches, handle), childKey: id(childKey) ? childKey : null,
        child: resolve(childKey), issuedAt: now() });
      return handoff;
    },
    closeLaunch(handle) { const record = get(launches, handle); if (!record) return false; retire(record, 'launch-closed'); return true; }
  });
  const reader = Object.freeze({
    inspect(handoffHandle, childKey) {
      const handoff = get(handoffs, handoffHandle), parent = handoff?.parent;
      if (!parent?.binding) return publicResult('unknown', 'parent-not-observed');
      if (!current(parent)) return publicResult('unknown', 'parent-scope-unavailable');
      if (!parent.committed) return publicResult('unknown', 'canonical-commit-pending');
      const child = resolve(childKey);
      if (childKey !== handoff.childKey || !sameScope(handoff.child, child)
          || child.threadId !== handoff.child?.threadId) return publicResult('unknown', 'child-scope-mismatch');
      if (child.parentSessionId !== parent.binding.sessionId || child.level > parent.binding.level)
        return publicResult('unknown', 'parent-child-authority-mismatch');
      if (child.provider !== parent.binding.provider || child.workspaceId !== parent.binding.workspaceId)
        return publicResult('unknown', 'provider-workspace-mismatch');
      const at = now(), receipt = parent.receipt;
      if (at === null || handoff.issuedAt === null || at < handoff.issuedAt || at - handoff.issuedAt > maxAgeMs)
        return publicResult('unknown', 'handoff-stale');
      if (!receipt) return publicResult('unknown', parent.reason);
      if (at < receipt.observedAt || at - receipt.observedAt > maxAgeMs)
        return publicResult('unknown', 'thread-receipt-stale');
      return publicResult('known', 'correlated-current-parent-policy', receipt.policy);
    }
  });
  return Object.freeze({ host, reader });
}
module.exports = Object.freeze({ createHostLaunchPolicy });
