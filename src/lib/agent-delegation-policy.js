'use strict';

// Installation-wide policy is read for each send. This module decides only
// message availability; it never grants task, role or permission authority.
const TASK_ONLY_SETTING = 'agent.task_only_delegation';
const COMMS_SETTING = 'agent.comms_enabled';

function unavailable() {
  return Object.assign(new Error('The agent delegation settings could not be read. No agent message was sent.'), {
    code: 'AGENT_DELEGATION_POLICY_UNAVAILABLE'
  });
}

function resolveDelegationPolicy(snapshot) {
  if (!snapshot || !snapshot.values || typeof snapshot.values !== 'object'
      || Array.isArray(snapshot.values)
      || (snapshot.rejected !== undefined && !Array.isArray(snapshot.rejected))) throw unavailable();
  if (snapshot.rejected?.some(item => !item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.id !== 'string' || item.id.length === 0
      || item.id === '*' || item.id === TASK_ONLY_SETTING || item.id === COMMS_SETTING)) {
    throw unavailable();
  }
  // Missing rows preserve installations whose registry predates these settings.
  // Present invalid values must never fall back to permissive defaults.
  const taskOnly = Object.hasOwn(snapshot.values, TASK_ONLY_SETTING) ? snapshot.values[TASK_ONLY_SETTING] : false;
  const commsEnabled = Object.hasOwn(snapshot.values, COMMS_SETTING) ? snapshot.values[COMMS_SETTING] : true;
  if (typeof taskOnly !== 'boolean' || typeof commsEnabled !== 'boolean') throw unavailable();
  return Object.freeze({ taskOnly, commsEnabled });
}

function readAgentDelegationPolicy() {
  let snapshot;
  try { snapshot = require('./settings').loadSettings(); }
  catch { throw unavailable(); }
  return resolveDelegationPolicy(snapshot);
}

function communicationDecision(policy) {
  if (!policy || typeof policy.taskOnly !== 'boolean' || typeof policy.commsEnabled !== 'boolean') throw unavailable();
  if (!policy.commsEnabled) return Object.freeze({
    allowed: false, code: 'AGENT_COMMS_DISABLED',
    reason: 'Agent comms is disabled. File and assign tasks, and report progress through task checkpoints.'
  });
  if (policy.taskOnly) return Object.freeze({
    allowed: false, code: 'AGENT_TASK_ONLY_DELEGATION',
    reason: 'Work is assigned only through tasks. Direct agent messages are disabled; use task assignments and checkpoints.'
  });
  return Object.freeze({ allowed: true, code: null, reason: null });
}

function assertAgentCommunicationAllowed(policy = readAgentDelegationPolicy()) {
  const decision = communicationDecision(policy);
  if (!decision.allowed) throw Object.assign(new Error(decision.reason), { code: decision.code });
  return decision;
}

module.exports = Object.freeze({
  TASK_ONLY_SETTING, COMMS_SETTING, resolveDelegationPolicy, readAgentDelegationPolicy,
  communicationDecision, assertAgentCommunicationAllowed
});
