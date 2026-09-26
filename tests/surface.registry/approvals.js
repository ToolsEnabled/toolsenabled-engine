'use strict';

// A legacy approval is one opaque, single-use token bound to one canonical
// action and one exact argument object. Prompt and state authority remain
// process-owned; callers may only consume an already-created grant.

require('../lib/isolated-environment').activate('surface-registry-approvals');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const approvals = require('../../src/lib/approvals');
const stateStore = require('../../src/lib/state-store');

let checks = 0;

function checkEqual(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
}

function checkDeepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

function checkOk(value, message) {
  assert.ok(value, message);
  checks += 1;
}

function checkThrows(block, predicate, message) {
  assert.throws(block, predicate, message);
  checks += 1;
}

function hasCode(code) {
  return error => Boolean(error && error.code === code);
}

function main() {
  checkEqual(Object.isFrozen(approvals), true,
    'authority contract: the approval API surface must be frozen');
  checkDeepEqual(Object.keys(approvals).sort(), [
    'ACTION', 'MAX_TTL_SECONDS', 'TOKEN', 'actionInputHash', 'approvalError',
    'consume', 'plainObject', 'tokenHash'
  ], 'authority contract: callers may consume grants but cannot mint or prompt for them');

  const args = { command: 'Write-Output exact', timeoutMs: 5000 };
  let hashedValue;
  const sentinel = 'b'.repeat(64);
  const boundHash = approvals.actionInputHash('host.exec', args, value => {
    hashedValue = value;
    return sentinel;
  });
  checkEqual(boundHash, sentinel,
    'binding contract: actionInputHash must return the canonical hasher result');
  checkDeepEqual(hashedValue, { action: 'host.exec', arguments: args },
    'binding contract: the canonical hash must include both the action and exact arguments');
  checkThrows(() => approvals.actionInputHash('host', args), hasCode('APPROVAL_ACTION_INVALID'),
    'binding contract: a non-namespaced action must be refused');
  checkThrows(() => approvals.actionInputHash('Host.Exec', args), hasCode('APPROVAL_ACTION_INVALID'),
    'binding contract: a non-canonical action name must be refused');
  checkThrows(() => approvals.actionInputHash('host.exec', []), hasCode('APPROVAL_INPUT_INVALID'),
    'binding contract: an array must not be accepted as an argument object');
  checkThrows(() => approvals.actionInputHash('host.exec', Object.create(null)), hasCode('APPROVAL_INPUT_INVALID'),
    'binding contract: an exotic prototype must not be accepted as approval input');

  const token = 'A'.repeat(42) + '_';
  const expectedTokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  checkEqual(approvals.tokenHash(token), expectedTokenHash,
    'token contract: an opaque token must be reduced to its SHA-256 digest');
  checkOk(/^[a-f0-9]{64}$/.test(approvals.tokenHash(token)) && !approvals.tokenHash(token).includes(token),
    'token contract: token material must not survive in the persisted digest');
  checkThrows(() => approvals.tokenHash('A'.repeat(42)), hasCode('APPROVAL_TOKEN_INVALID'),
    'token contract: a short token must be refused');
  checkThrows(() => approvals.tokenHash('A'.repeat(42) + '='), hasCode('APPROVAL_TOKEN_INVALID'),
    'token contract: non-base64url token characters must be refused');
  checkThrows(
    () => approvals.consume({ action: 'host.exec', arguments: args, approvalToken: token }, { state: {} }),
    hasCode('APPROVAL_DEPENDENCY_INJECTION_FORBIDDEN'),
    'authority contract: a caller must not inject fake state or prompt dependencies'
  );

  const store = stateStore.getStateStore();
  const inputHash = approvals.actionInputHash('host.exec', args);
  const grant = store.createApprovalGrant({
    id: 'approval-surface-registry', action: 'host.exec', inputHash,
    tokenHash: approvals.tokenHash(token), expiresAtMs: Date.now() + 60_000
  });
  checkEqual(grant.status, 'approved',
    'consume precondition: the durable grant must begin approved');
  checkThrows(
    () => approvals.consume({
      action: 'host.exec', arguments: { ...args, timeoutMs: 5001 }, approvalToken: token
    }),
    hasCode('APPROVAL_BINDING_MISMATCH'),
    'consume contract: changing one argument must not consume the grant'
  );
  let consumed;
  try {
    consumed = approvals.consume({ action: 'host.exec', arguments: args, approvalToken: token });
  } catch (error) {
    assert.fail(`consume contract: the exact action and arguments must consume their bound grant; got ${error && error.code}`);
  }
  checkEqual(consumed.approvalId, grant.approvalId,
    'consume contract: the exact action and arguments must consume their bound grant');
  checkEqual(consumed.status, 'consumed',
    'consume contract: a successful use must atomically become consumed');
  checkThrows(
    () => approvals.consume({ action: 'host.exec', arguments: args, approvalToken: token }),
    hasCode('APPROVAL_ALREADY_USED'),
    'consume contract: the same approval token must never be reusable'
  );

  process.stdout.write(`approvals contract: ${checks} checks passed\n`);
}

try { main(); }
catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
} finally {
  stateStore.closeStateStore();
}
