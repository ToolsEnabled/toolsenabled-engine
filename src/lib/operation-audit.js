'use strict';

// Ordinary operation records are optional infrastructure, never permission or
// evidence of an effect. Required/conditional audit APIs keep their strict
// contracts for state machines whose correctness depends on signed receipts.
const { runtimePolicy } = require('./runtime-policy');
const decisions = new WeakSet();
const activePolicy = new (require('node:async_hooks').AsyncLocalStorage)();
function capturePolicy(options = {}) {
  if (options.auditPolicy !== undefined) {
    if (!decisions.has(options.auditPolicy)) throw new TypeError('Audit policy must come from the trusted runtime resolver.');
    return options.auditPolicy;
  }
  if (activePolicy.getStore()) return activePolicy.getStore();
  const configured = runtimePolicy(options);
  // A readable default/false setting is Basic. A failed read or rejected
  // master is unknown, not evidence that the owner disabled auditing.
  // Validate before minting a snapshot or touching optional worker lifecycle.
  if (configured.configurationAvailable !== true || !Array.isArray(configured.rejected)
      || configured.rejected.includes('*') || configured.rejected.includes('audit.enabled')) {
    throw Object.assign(new Error('The audit setting could not be read or validated. Repair the saved setting before retrying.'), {
      code: 'AUDIT_POLICY_INVALID'
    });
  }
  const policy = Object.freeze({ required: configured.auditEnabled, activity: configured.activity });
  decisions.add(policy);
  if (!policy.required) requestIdleRetirement();
  return policy;
}
function auditEnabledNow(options = {}) { return runtimePolicy(options).auditEnabled; }
function requestIdleRetirement() {
  return require('./audit-admission').retireDefaultAdmissionQueue().catch(error => {
    try { process.stderr.write(`ToolsEnabled idle audit retirement failed: ${error?.code || error?.message || 'unknown'}\n`); } catch {}
  });
}
function retireIfDisabled(options = {}) {
  return auditEnabledNow(options) ? Promise.resolve() : requestIdleRetirement();
}
function withPolicy(policy, run) {
  capturePolicy({ auditPolicy: policy });
  return activePolicy.run(policy, run);
}
function configured(options = {}) { return capturePolicy(options).required; }
function skippedStatus(action, target) {
  return Object.freeze({ action, target, ok: true, disposition: 'not-required', required: false,
    recorded: false, durable: false, anchored: false, signed: false,
    sequence: null, eventId: null, eventHash: null });
}
function isNotRequired(receipt, action, target) {
  return Boolean(receipt) && typeof receipt === 'object' && !Array.isArray(receipt)
    && Reflect.ownKeys(receipt).length === 12
    && ['ok', 'disposition', 'required', 'recorded', 'durable', 'anchored', 'signed', 'sequence', 'eventId', 'eventHash', 'action', 'target'].every(key => Object.hasOwn(receipt, key))
    && receipt.ok === true && receipt.disposition === 'not-required'
    && receipt.required === false && receipt.recorded === false && receipt.durable === false
    && receipt.anchored === false && receipt.signed === false && receipt.sequence === null
    && receipt.eventId === null && receipt.eventHash === null && receipt.action === action && receipt.target === target;
}
function requireRecord(action, target, details = {}, options = {}) {
  if (!configured(options)) return skippedStatus(action, target);
  return (options.audit || require('./audit')).requireRecord(action, target, details, options);
}
async function requireRecordAsync(action, target, details = {}, options = {}) {
  if (!configured(options)) return skippedStatus(action, target);
  try { return await require('./audit-admission').requireRecordAsync(action, target, details, options); }
  finally { void retireIfDisabled(options); }
}
function record(action, target, details = {}, options = {}) {
  if (!configured(options)) return skippedStatus(action, target);
  return (options.audit || require('./audit')).record(action, target, details, options);
}
async function recordAsync(action, target, details = {}, options = {}) {
  if (!configured(options)) return skippedStatus(action, target);
  try { return await require('./audit-admission').recordAsync(action, target, details, options); }
  finally { void retireIfDisabled(options); }
}
module.exports = Object.freeze({ capturePolicy, auditEnabledNow, retireIfDisabled, withPolicy, configured, skippedStatus, isNotRequired, requireRecord, requireRecordAsync, record, recordAsync });
