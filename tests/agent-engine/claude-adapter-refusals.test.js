'use strict';

const assert = require('node:assert/strict');
const {
  ClaudeAdapter,
  ClaudeAdapterError
} = require('../../src/lib/agent-engine/claude-adapter');

class RecordingTransport {
  constructor({ throwOnWrite = false, unsubscribe = () => {} } = {}) {
    this.writes = [];
    this.listener = null;
    this.throwOnWrite = throwOnWrite;
    this.unsubscribe = unsubscribe;
  }

  write(line) {
    if (this.throwOnWrite) throw new Error('injected write failure');
    this.writes.push(JSON.parse(line));
  }

  onData(listener) {
    this.listener = listener;
    return this.unsubscribe;
  }

  emit(message) {
    this.listener(`${JSON.stringify(message)}\n`);
  }
}

function make(options = {}) {
  const transport = options.transport || new RecordingTransport();
  return { transport, adapter: new ClaudeAdapter({ transport, ...options, transport }) };
}

function expectCode(code) {
  return error => {
    assert.equal(error instanceof ClaudeAdapterError, true);
    assert.equal(error.code, code);
    return true;
  };
}

function reply(transport, request, result) {
  transport.emit({ jsonrpc: '2.0', id: request.id, result });
}

async function initialize(subject, capabilities = {}, authMethods = []) {
  const pending = subject.adapter.initialize();
  const request = subject.transport.writes.at(-1);
  reply(subject.transport, request, {
    protocolVersion: 1,
    agentCapabilities: capabilities,
    authMethods
  });
  await pending;
}

(async () => {
  // Constructor refusals happen before subscription and can have no transport side effects.
  for (const invalidTransport of [null, { write() {} }, { onData() {} }]) {
    assert.throws(() => new ClaudeAdapter({ transport: invalidTransport }), expectCode('ACP_TRANSPORT_INVALID'));
  }
  const versionTransport = new RecordingTransport();
  assert.throws(
    () => new ClaudeAdapter({ transport: versionTransport, protocolVersion: 2 }),
    expectCode('ACP_PROTOCOL_VERSION_MISMATCH')
  );
  assert.equal(versionTransport.listener, null);
  assert.deepEqual(versionTransport.writes, []);

  const invalidOptionTransport = new RecordingTransport();
  assert.throws(
    () => new ClaudeAdapter({ transport: invalidOptionTransport, defaultCwd: '' }),
    expectCode('ACP_ADAPTER_INVALID')
  );
  assert.deepEqual(invalidOptionTransport.writes, []);

  const uninitialized = make();
  await assert.rejects(uninitialized.adapter.startThread({ cwd: '/tmp' }), expectCode('ACP_NOT_INITIALIZED'));
  assert.deepEqual(uninitialized.transport.writes, []);

  let unsubscribed = 0;
  const closable = make({ transport: new RecordingTransport({ unsubscribe: () => { unsubscribed += 1; } }) });
  closable.adapter.close();
  assert.equal(unsubscribed, 1);
  assert.throws(() => closable.adapter.onEvent(() => {}), expectCode('ACP_ADAPTER_CLOSED'));
  assert.deepEqual(closable.transport.writes, []);

  const brokenWrite = make({ transport: new RecordingTransport({ throwOnWrite: true }) });
  await assert.rejects(brokenWrite.adapter.initialize(), expectCode('ACP_TRANSPORT_WRITE_FAILED'));
  assert.equal(brokenWrite.adapter.pending.size, 0);
  assert.deepEqual(brokenWrite.transport.writes, []);

  const rpcFailure = make();
  const failedInitialize = rpcFailure.adapter.initialize();
  const rpcRequest = rpcFailure.transport.writes.at(-1);
  rpcFailure.transport.emit({
    jsonrpc: '2.0', id: rpcRequest.id,
    error: { code: -32603, message: 'injected ACP failure' }
  });
  await assert.rejects(failedInitialize, error => {
    expectCode('ACP_REQUEST_FAILED')(error);
    assert.equal(error.rpcCode, -32603);
    return true;
  });
  assert.equal(rpcFailure.transport.writes.length, 1);

  for (const malformed of [null, [], {}, { code: 'invalid' }, { code: -32603 }, { code: -32603, message: 7 }]) {
    const brokenResponse = make();
    const initializing = brokenResponse.adapter.initialize();
    const request = brokenResponse.transport.writes.at(-1);
    brokenResponse.transport.emit({ jsonrpc: '2.0', id: request.id, error: malformed });
    const outcome = await Promise.race([
      initializing.then(() => ({ status: 'resolved' }), error => ({ status: 'rejected', code: error.code })),
      new Promise(resolve => setImmediate(() => resolve({ status: 'pending' })))
    ]);
    assert.deepEqual(outcome, { status: 'rejected', code: 'ACP_PROTOCOL_INVALID' },
      `a malformed RPC error must settle the request owned by the closed reader: ${JSON.stringify(malformed)}`);
    assert.equal(brokenResponse.adapter.closed.code, 'ACP_PROTOCOL_INVALID');
    assert.equal(brokenResponse.adapter.pending.size, 0);
    brokenResponse.adapter.close();
  }

  const initialized = make();
  await initialize(initialized, {}, [{ id: 'allowed' }]);
  const baselineWrites = initialized.transport.writes.length;
  await assert.rejects(initialized.adapter.authenticate('unknown'), expectCode('ACP_AUTH_METHOD_INVALID'));
  await assert.rejects(
    initialized.adapter.resumeThread('session-1', { cwd: '/tmp' }),
    expectCode('ACP_CAPABILITY_UNSUPPORTED')
  );
  await assert.rejects(
    initialized.adapter.interrupt({ threadId: 'session-1', turnId: 'turn-absent' }),
    expectCode('ACP_TURN_UNKNOWN')
  );
  assert.throws(
    () => initialized.adapter.answerApproval({ approvalId: 'missing', response: { outcome: { outcome: 'cancelled' } } }),
    expectCode('ACP_APPROVAL_UNKNOWN')
  );
  assert.equal(initialized.transport.writes.length, baselineWrites);

  const images = make();
  await initialize(images, { promptCapabilities: { image: true } });
  const imageBaseline = images.transport.writes.length;
  await assert.rejects(images.adapter.sendTurn({
    threadId: 'session-1', text: '', images: [{ url: 'not-a-data-url' }]
  }), expectCode('ACP_IMAGE_INVALID'));
  assert.equal(images.transport.writes.length, imageBaseline);
  assert.equal(images.adapter.activeTurns.size, 0);

  const approval = make();
  await initialize(approval);
  const approvalTurn = approval.adapter.sendTurn({ threadId: 'session-1', text: 'ask permission' });
  approvalTurn.catch(() => {});
  const approvalPrompt = approval.transport.writes.at(-1);
  let approvalId;
  approval.adapter.onEvent(event => { if (event.type === 'approval_request') approvalId = event.approval.approvalId; });
  const approvalBaseline = approval.transport.writes.length;
  approval.transport.emit({
    jsonrpc: '2.0', id: 77, method: 'session/request_permission',
    params: {
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'dangerous tool' },
      options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }]
    }
  });
  assert.equal(approval.adapter.approvals.size, 1);
  assert.throws(() => approval.adapter.answerApproval({
    approvalId,
    response: { outcome: { outcome: 'selected', optionId: 'no' } }
  }), expectCode('ACP_APPROVAL_INVALID'));
  assert.equal(approval.adapter.approvals.size, 1, 'invalid answer must leave approval pending');
  assert.equal(approval.transport.writes.length, approvalBaseline, 'invalid answer must not write a response');
  reply(approval.transport, approvalPrompt, { stopReason: 'end_turn' });
  await approvalTurn;

  const unsupported = make();
  let unsupportedUnsubscribed = 0;
  unsupported.adapter.unsubscribe = () => { unsupportedUnsubscribed += 1; };
  unsupported.transport.emit({ jsonrpc: '2.0', id: 88, method: 'host/unknown', params: {} });
  assert.equal(unsupported.adapter.closed.code, 'ACP_PROTOCOL_UNSUPPORTED_REQUEST');
  assert.equal(unsupportedUnsubscribed, 1);
  assert.deepEqual(unsupported.transport.writes, []);
  assert.throws(() => unsupported.adapter.onEvent(() => {}), expectCode('ACP_PROTOCOL_UNSUPPORTED_REQUEST'));

  console.log('Claude adapter driven refusal tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
