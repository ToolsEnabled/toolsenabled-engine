'use strict';

// Selected data only; no RPC, config/auth read, launch override or grant.
const APPROVAL = Object.freeze({ never: 'no-prompts', 'on-request': 'prompt-required',
  'on-failure': 'prompt-on-failure', untrusted: 'prompt-untrusted' });
const SANDBOX = Object.freeze({ readOnly: 'read-only', workspaceWrite: 'workspace-write',
  dangerFullAccess: 'unrestricted' });
function own(value, key) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}
function admitted(map, key) {
  return typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : null;
}
function project(approval, sandbox) {
  return Object.freeze({ approval: admitted(APPROVAL, approval), sandbox: admitted(SANDBOX, sandbox) });
}
// Which observed Codex requests start or resume a thread (host-launch-policy.js).
function classifyMethod(method) {
  return method === 'thread/start' ? 'start' : method === 'thread/resume' ? 'resume' : null;
}
function supportsObservation(method) {
  return classifyMethod(method) !== null;
}
function normalizeThreadPolicy(method, response) {
  if (!supportsObservation(method)) return null;
  const threadId = own(own(response, 'thread'), 'id');
  if (typeof threadId !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(threadId)) return null;
  return Object.freeze({ threadId, policy: project(own(response, 'approvalPolicy'), own(own(response, 'sandbox'), 'type')) });
}
function normalizeConfiguration(response) {
  // Effective config value is only a diagnostic hint, never a thread receipt.
  const config = own(own(response, 'config'), 'value');
  const rawApproval = own(config, 'approval_policy');
  const approval = typeof rawApproval === 'string' ? rawApproval : own(rawApproval, 'value');
  const modes = Object.freeze({ 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' });
  return project(approval, admitted(modes, own(config, 'sandbox_mode')));
}

module.exports = Object.freeze({ classifyMethod, supportsObservation, normalizeThreadPolicy, normalizeConfiguration });
