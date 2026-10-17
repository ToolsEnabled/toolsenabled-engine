'use strict';

// Internal approval-token validation and dispatch consumption. This module is
// not an MCP tool; callers cannot create an approval through its exports.

const crypto = require('node:crypto');
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

function consumeForDispatch(input) {
  assertNoInjectedDependencies(arguments.length);
  input = exact(input, ['authorizationId', 'toolName', 'arguments', 'approvalToken'], 'scoped approval dispatch');
  const { hashInput } = require('./state-store');
  return stateFor().consumeScopedApprovalDispatch({
    authorizationId: input.authorizationId,
    toolName: input.toolName,
    argsHash: hashInput(input.arguments),
    tokenHash: tokenHash(input.approvalToken)
  });
}

module.exports = Object.freeze({
  TOKEN, consumeForDispatch
});
