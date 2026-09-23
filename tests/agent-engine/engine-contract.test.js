/* Mutation check:
 * Changed `const CONTRACT_VERSION = 1;` to `const CONTRACT_VERSION = 2;` in the module.
 * The edit landed: yes.
 * This isolated test went red: yes (exit 1, expected 1 but received 2).
 */

'use strict';

const assert = require('node:assert/strict');
const contract = require('../../src/lib/agent-engine/engine-contract');

function expectContractError(run, message) {
  assert.throws(run, error => {
    assert.equal(error.name, 'AgentEngineContractError');
    assert.equal(error.code, 'AGENT_ENGINE_CONTRACT_INVALID');
    return true;
  }, message);
}

function adapter() {
  return Object.fromEntries(contract.ENGINE_METHODS.map(method => [method, () => {}]));
}

function main() {
  assert.equal(contract.CONTRACT_VERSION, 1);
  assert.deepEqual(contract.ENGINE_METHODS, [
    'startThread', 'resumeThread', 'forkThread', 'sendTurn', 'onEvent',
    'answerApproval', 'interrupt', 'getUsage'
  ]);
  assert.ok(Object.isFrozen(contract.ENGINE_METHODS));

  const validAdapter = adapter();
  assert.equal(contract.assertEngineAdapter(validAdapter), validAdapter);
  delete validAdapter.sendTurn;
  expectContractError(() => contract.assertEngineAdapter(validAdapter), 'an incomplete adapter was accepted');

  const options = contract.validateThreadOptions({
    cwd: '/workspace', model: 'model-1', approvalPolicy: 'on-request',
    sandbox: 'workspace-write', personality: 'friendly', ephemeral: true,
    effort: 'max'
  });
  assert.deepEqual(options, {
    cwd: '/workspace', model: 'model-1', approvalPolicy: 'on-request',
    sandbox: 'workspace-write', personality: 'friendly', ephemeral: true,
    effort: 'max'
  });
  assert.ok(Object.isFrozen(options));
  expectContractError(() => contract.validateThreadOptions({ sandbox: 'unrestricted' }));
  expectContractError(() => contract.validateThreadOptions({ effort: 'maximum-ish' }));
  expectContractError(() => contract.validateThreadOptions({ surprise: true }));

  assert.equal(contract.validateThreadId('thread-1'), 'thread-1');
  expectContractError(() => contract.validateThreadId(''));

  assert.deepEqual(contract.validateImage({ path: '/tmp/image.png', detail: 'high' }, 0), {
    path: '/tmp/image.png', detail: 'high'
  });
  expectContractError(() => contract.validateImage({ url: 'data:image/png,x', path: '/tmp/x' }, 0));

  const turn = contract.validateSendTurnRequest({
    threadId: 'thread-1', text: '', images: [{ url: 'data:image/png,x', detail: 'auto' }]
  });
  assert.deepEqual(turn, {
    threadId: 'thread-1', text: '',
    images: [{ url: 'data:image/png,x', detail: 'auto' }], options: {}
  });
  assert.ok(Object.isFrozen(turn));
  assert.ok(Object.isFrozen(turn.images));
  expectContractError(() => contract.validateSendTurnRequest({ threadId: 'thread-1', text: '' }));

  const answer = contract.validateApprovalAnswer({
    approvalId: 'approval-1', response: { approved: true, limits: [1, null] }
  });
  assert.deepEqual(answer, {
    approvalId: 'approval-1', response: { approved: true, limits: [1, null] }
  });
  assert.ok(Object.isFrozen(answer.response));
  expectContractError(() => contract.validateApprovalAnswer({
    approvalId: 'approval-1', response: { value: Number.POSITIVE_INFINITY }
  }));

  /* turn_accepted and thinking, added 2026-09-03 (owner: "more event types
     are fine we should be showing the user when the model is thinking
     anyway"). Neither is assistant speech -- see engine-contract.js's own
     comment on the two entries for why each exists. */
  assert.deepEqual(contract.EVENT_TYPES, [
    'assistant_text_delta', 'assistant_text', 'tool_call', 'tool_result',
    'approval_request', 'usage', 'turn_completed', 'turn_accepted', 'thinking'
  ]);
  const event = contract.validateEngineEvent({
    type: 'assistant_text', threadId: 'thread-1', text: '', payload: { final: true }
  });
  assert.deepEqual(event, {
    type: 'assistant_text', threadId: 'thread-1', text: '', payload: { final: true }
  });
  assert.ok(Object.isFrozen(event));
  expectContractError(() => contract.validateEngineEvent({ type: 'unknown_event' }));

  const accepted = contract.validateEngineEvent({ type: 'turn_accepted', threadId: 'thread-1', turnId: 'turn-1' });
  assert.deepEqual(accepted, { type: 'turn_accepted', threadId: 'thread-1', turnId: 'turn-1' });

  const thinking = contract.validateEngineEvent({
    type: 'thinking', threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', text: 'considering it'
  });
  assert.deepEqual(thinking, {
    type: 'thinking', threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', text: 'considering it'
  });

  process.stdout.write('PASS - engine-contract exported validation behaviour\n');
}

main();
