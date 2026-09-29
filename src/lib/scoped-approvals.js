'use strict';

// P14 controller-only scoped approval authority.  This module is deliberately
// unregistered: agents and MCP callers cannot construct previews, targets,
// provenance, status, or approval evidence.  A trusted controller first
// creates a P12/P13-bound action, then this module renders exactly that stored
// canonical preview to the local owner prompt.

const crypto = require('node:crypto');
const desktop = require('./desktop');
const { getStateStore } = require('./state-store');

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function error(code, message, details = {}) {
  const value = new Error(message);
  value.name = 'ScopedApprovalError';
  value.code = code;
  value.details = details;
  return value;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch { return false; }
  return prototype === Object.prototype || prototype === null;
}

function exact(value, keys, label) {
  if (!plainObject(value)) throw error('SCOPED_APPROVAL_INVALID', `${label} must be a plain object.`);
  let actual;
  try { actual = Reflect.ownKeys(value); } catch {
    throw error('SCOPED_APPROVAL_INVALID', `${label} own fields are unavailable.`);
  }
  if (actual.length !== keys.length
      || actual.some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw error('SCOPED_APPROVAL_INVALID', `${label} has unsupported or missing fields.`);
  }
  const snapshot = {};
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch {
      throw error('SCOPED_APPROVAL_INVALID', `${label} field descriptors are unavailable.`);
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw error('SCOPED_APPROVAL_INVALID', `${label} must not contain accessors.`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function assertNoInjectedDependencies(argumentsLength) {
  if (argumentsLength <= 1) return;
  throw error('SCOPED_APPROVAL_DEPENDENCY_INJECTION_FORBIDDEN',
    'Scoped-approval prompt, clock, and state dependencies are process-owned and cannot be supplied by a caller.');
}

function stateFor() { return getStateStore(); }

function tokenHash(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw error('APPROVAL_TOKEN_INVALID', 'The scoped approval token is invalid.');
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function uiContract(action) {
  if (!action || typeof action !== 'object') throw error('SCOPED_APPROVAL_NOT_FOUND', 'The scoped approval was not found.');
  // This is the only object supplied to the UI.  The controller cannot add a
  // description, substitute a target, or alter a field after the preview hash
  // was created in durable state.
  return Object.freeze({
    schemaVersion: '1.0.0',
    approvalId: action.approvalId,
    action: action.action,
    target: action.target,
    parameters: action.parameters,
    subject: action.subject,
    previewHash: action.previewHash,
    expiresAtMs: action.expiresAtMs,
    singleUse: true,
    revocable: true
  });
}

function promptMessage(contract) {
  const message = JSON.stringify(contract);
  if (message.length > 2000) {
    throw error('SCOPED_APPROVAL_PREVIEW_TOO_LARGE', 'The canonical approval preview is too large for the local confirmation UI.');
  }
  return message;
}

function recordProvenance(input) {
  assertNoInjectedDependencies(arguments.length);
  input = exact(input, ['evidenceId', 'taskId', 'provenance'], 'broker provenance evidence');
  return stateFor().recordScopedApprovalProvenance(input);
}

function createAction(input) {
  assertNoInjectedDependencies(arguments.length);
  // No action/tool/target/preview/provenance body/approval ID/status fields are
  // accepted here.  State derives action/target from the immutable P13 record
  // and dereferences only a separately recorded broker provenance ID.
  input = exact(input, ['authorizationId', 'parameters', 'subject', 'provenanceEvidenceId', 'expiresAtMs'], 'controller scoped approval action');
  return stateFor().createScopedApprovalAction(input).action;
}

function preview(input) {
  assertNoInjectedDependencies(arguments.length);
  input = exact(input, ['approvalId'], 'scoped approval preview selector');
  const action = stateFor().getScopedApprovalAction(input);
  if (!action) throw error('SCOPED_APPROVAL_NOT_FOUND', 'The scoped approval was not found.', { approvalId: input.approvalId });
  return uiContract(action);
}

async function request(input) {
  assertNoInjectedDependencies(arguments.length);
  input = exact(input, ['approvalId'], 'scoped approval request');
  const state = stateFor();
  const action = state.getScopedApprovalAction(input);
  if (!action) throw error('SCOPED_APPROVAL_NOT_FOUND', 'The scoped approval was not found.', { approvalId: input.approvalId });
  const contract = uiContract(action);
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw error('SCOPED_APPROVAL_CLOCK_INVALID', 'The scoped approval clock is invalid.');
  if (action.expiresAtMs <= now) {
    // The state-store records expiry when it next evaluates the action.  A
    // prompt is never shown for an already stale preview.
    state.expireScopedApproval({ approvalId: action.approvalId });
    throw error('APPROVAL_EXPIRED', 'The scoped approval expired before it could be shown.');
  }
  const remainingSeconds = Math.floor((action.expiresAtMs - now) / 1000);
  const answer = await desktop.ask({
    title: `Approve ${contract.action}`,
    message: promptMessage(contract),
    // desktop.ask has a five-second lower bound.  The durable state check on
    // the answer is still authoritative if this exact action expires sooner.
    timeoutSeconds: Math.max(5, Math.min(900, remainingSeconds))
  });
  if (!answer || typeof answer !== 'object' || !['yes', 'no', 'timeout'].includes(answer.answer)) {
    throw error('SCOPED_APPROVAL_PROMPT_INVALID', 'The local scoped-approval prompt returned an invalid response.');
  }
  if (answer.answer === 'yes') {
    const approvalToken = crypto.randomBytes(32).toString('base64url');
    const approved = state.approveScopedApproval({
      approvalId: action.approvalId,
      previewHash: action.previewHash,
      tokenHash: tokenHash(approvalToken)
    });
    return Object.freeze({ approved: true, timedOut: false, approvalToken, approval: uiContract(approved) });
  }
  if (answer.answer === 'no') {
    const declined = state.declineScopedApproval({ approvalId: action.approvalId, previewHash: action.previewHash });
    return Object.freeze({ approved: false, timedOut: false, approval: uiContract(declined) });
  }
  // A dialog timeout is not a substitute for an approval.  The action remains
  // time-bounded and will be atomically marked expired when the stored expiry
  // is reached; callers receive no token or status bypass.
  return Object.freeze({ approved: false, timedOut: true, approval: contract });
}

function cancel(input) {
  assertNoInjectedDependencies(arguments.length);
  input = exact(input, ['approvalId', 'reasonCode'], 'scoped approval cancellation');
  return uiContract(stateFor().cancelScopedApproval(input));
}

function revoke(input) {
  assertNoInjectedDependencies(arguments.length);
  input = exact(input, ['approvalId', 'reasonCode'], 'scoped approval revocation');
  return uiContract(stateFor().revokeScopedApproval(input));
}

function consumeForDispatch(input) {
  assertNoInjectedDependencies(arguments.length);
  input = exact(input, ['authorizationId', 'toolName', 'arguments', 'approvalToken'], 'P14 dispatch consumption');
  const { hashInput } = require('./state-store');
  return stateFor().consumeScopedApprovalDispatch({
    authorizationId: input.authorizationId,
    toolName: input.toolName,
    argsHash: hashInput(input.arguments),
    tokenHash: tokenHash(input.approvalToken)
  });
}

module.exports = Object.freeze({
  TOKEN, consumeForDispatch, error, tokenHash, uiContract
});
