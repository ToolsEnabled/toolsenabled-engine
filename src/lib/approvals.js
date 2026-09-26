'use strict';

const crypto = require('node:crypto');
const { getStateStore, hashInput } = require('./state-store');

const ACTION = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_TTL_SECONDS = 15 * 60;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function approvalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function actionInputHash(action, argumentsValue, hash = hashInput) {
  if (typeof action !== 'string' || !ACTION.test(action)) throw approvalError('APPROVAL_ACTION_INVALID', 'The approval action is invalid.');
  if (!plainObject(argumentsValue)) {
    throw approvalError('APPROVAL_INPUT_INVALID', 'The approval input must be a plain object.');
  }
  return hash({ action, arguments: argumentsValue });
}

function tokenHash(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw approvalError('APPROVAL_TOKEN_INVALID', 'The approval token is invalid.');
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function assertNoInjectedDependencies(argumentsLength) {
  if (argumentsLength <= 1) return;
  throw approvalError('APPROVAL_DEPENDENCY_INJECTION_FORBIDDEN',
    'Approval prompt and state dependencies are process-owned and cannot be supplied by a caller.');
}

function consume({ action, arguments: argumentsValue, approvalToken }) {
  assertNoInjectedDependencies(arguments.length);
  const inputHash = actionInputHash(action, argumentsValue, hashInput);
  const state = getStateStore();
  return state.consumeApprovalGrant({ action, inputHash, tokenHash: tokenHash(approvalToken) });
}

module.exports = Object.freeze({ ACTION, MAX_TTL_SECONDS, TOKEN, actionInputHash, approvalError, consume, plainObject, tokenHash });
