// EXECUTABLE CHANGE
/* Test-can-fail report (testcanfail-tests-agent-engine-codex-adapter-js)
 *
 * Strengthened assertion: the command-approval decision catalog assertion now
 * uses the protocol's literal decision list instead of COMMAND_DECISIONS from
 * the module under test. Mutation: in a temporary edit to codex-adapter.js,
 * changed `acceptWithExecpolicyAmendment` to `mutatedDecision`. The old test
 * stayed green. With this assertion strengthened, the mutation produced RED:
 *
 *   AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
 *   + actual - expected
 *   ...
 *   +   'mutatedDecision',
 *   -   'acceptWithExecpolicyAmendment',
 *
 * The source mutation was restored byte-for-byte. The restored test run was:
 *
 *   Codex agent-engine adapter tests passed (streaming, approvals, images,
 *   lifecycle, interrupt, retry, fail-closed, resolved sandbox).
 *
 * Census of requested suspect shapes:
 *   (1) NOT-FOUND: the only assertion loop uses an inline, non-empty fixture.
 *   (2) NOT-FOUND: no exit-status or bare truthy-return assertion.
 *   (3) NOT-FOUND: no try/catch or optional chain swallowing test failure.
 *   (4) NOT-FOUND: transport mocks supply protocol input; expected adapter
 *       output is specified independently rather than copied from the mock.
 *   (5) NOT-FOUND: no skip or platform precondition guard.
 *   (6) FOUND/FIXED: command decisions expected the subject's own exported
 *       COMMAND_DECISIONS value, allowing the catalog and expectation to drift
 *       together. No precondition was unmet.
 */
'use strict';

const assert = require('node:assert/strict');
const contract = require('../../src/lib/agent-engine/engine-contract');
const {
  CODEX_CLI_VERSION,
  CodexAdapter,
  assertPinnedVersion
} = require('../../src/lib/agent-engine/codex-adapter');

const FAKE_SERVER_INFO = Object.freeze({
  userAgent: 'toolsenabled/0.146.0',
  codexHome: 'C:/Users/test/.codex',
  platformFamily: 'windows',
  platformOs: 'windows'
});

class FakeTransport {
  constructor() {
    this.writes = [];
    this.listeners = new Set();
    this.initialized = false;
  }

  write(line) {
    const message = JSON.parse(line);
    this.writes.push(message);
    if (message.method === 'initialize') {
      this.emit({ id: message.id, result: FAKE_SERVER_INFO });
      this.initialized = true;
      return;
    }
    if (typeof message.method === 'string' && !this.initialized) {
      this.emit({ id: message.id, error: { code: -32600, message: 'Not initialized' } });
    }
  }

  onData(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message) {
    const line = typeof message === 'string' ? message : `${JSON.stringify(message)}\n`;
    for (const listener of this.listeners) listener(line);
  }

  async completeInitialization(adapter) {
    return adapter.initialize();
  }
}

function createAdapter(options = {}) {
  const transport = new FakeTransport();
  const adapter = new CodexAdapter({ transport, codexVersion: CODEX_CLI_VERSION, retryDelayMs: 0, ...options });
  return { transport, adapter };
}

function response(transport, request, result) {
  transport.emit({ id: request.id, result });
}

function writtenRequests(transport, method) {
  return transport.writes.filter(message => message.method === method);
}

function writtenRequest(transport, method) {
  const requests = writtenRequests(transport, method);
  assert.equal(requests.length, 1, `expected one ${method} request`);
  return requests[0];
}

function writtenResponse(transport, id) {
  const responses = transport.writes.filter(message => message.id === id && Object.hasOwn(message, 'result'));
  assert.equal(responses.length, 1, `expected one response for ${String(id)}`);
  return responses[0];
}

function protocolError(operation, code) {
  return assert.throws(operation, error => error && error.code === code, `expected ${code}`);
}

async function protocolReject(operation, code) {
  await assert.rejects(operation, error => error && error.code === code, `expected ${code}`);
}

async function nextTick() {
  await new Promise(resolve => setTimeout(resolve, 5));
}

(async () => {
  for (const version of ['codex-cli 0.147.0', 'codex-cli 0.154.0', 'codex-cli 8.3.1', 'codex-cli 1.0.0-alpha.2']) {
    assert.equal(assertPinnedVersion(version), version, 'a newer CLI is admitted by protocol, not a release list');
  }
  protocolError(() => new CodexAdapter({ transport: new FakeTransport(), codexVersion: 'not-a-version' }), 'CODEX_PROTOCOL_VERSION_MISMATCH');

  const uninitialized = createAdapter();
  await protocolReject(() => uninitialized.adapter.startThread(), 'CODEX_NOT_INITIALIZED');
  await protocolReject(() => uninitialized.adapter.sendTurn({ threadId: 'thread-1', text: 'hello' }), 'CODEX_NOT_INITIALIZED');
  await protocolReject(() => uninitialized.adapter.interrupt({ threadId: 'thread-1', turnId: 'turn-1' }), 'CODEX_NOT_INITIALIZED');
  assert.equal(uninitialized.transport.writes.length, 0, 'thread operations must not reach the app-server before initialization');
  const initialized = uninitialized.transport.completeInitialization(uninitialized.adapter);
  assert.equal(uninitialized.transport.writes.at(0).method, 'initialize');
  assert.deepEqual(await initialized, FAKE_SERVER_INFO);

  const { transport, adapter } = createAdapter();
  contract.assertEngineAdapter(adapter);
  const events = [];
  adapter.onEvent(event => events.push(event));
  assert.deepEqual(await transport.completeInitialization(adapter), FAKE_SERVER_INFO);

  const started = adapter.startThread({ cwd: 'C:/workspace', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  const startRequest = writtenRequest(transport, 'thread/start');
  assert.deepEqual(startRequest, {
    jsonrpc: '2.0', id: 2, method: 'thread/start',
    params: { cwd: 'C:/workspace', approvalPolicy: 'on-request', sandbox: 'workspace-write' }
  });
  response(transport, startRequest, { thread: { id: 'thread-1' } });
  const startedThread = await started;
  assert.equal(startedThread.threadId, 'thread-1');
  assert.deepEqual(startedThread.turns, [], 'a fresh thread has no history, and must not invent one');
  /* THE START ABOVE ASKED FOR `workspace-write` AND THIS REPLY NAMES NO SANDBOX.
     The honest answer is that the engine did not say -- never the value that was
     requested, which is the assumption that let a silent downgrade run unseen. */
  assert.equal(startedThread.resolvedSandbox, null,
    'a response that names no sandbox must answer null, never echo the request back as fact');

  /* RESUME HANDS BACK THE CONVERSATION, and keeping it is the whole point.
     This assertion used to read `deepEqual(await resumed, { threadId })`,
     which pinned the defect: the engine returned every turn of the thread
     and the parser dropped them, so the product could not resume anything
     and pasted a summary into a new agent instead. */
  const resumed = adapter.resumeThread('thread-1');
  const resumeRequest = writtenRequest(transport, 'thread/resume');
  assert.equal(resumeRequest.method, 'thread/resume');
  assert.deepEqual(resumeRequest.params, { threadId: 'thread-1' });
  response(transport, resumeRequest, {
    thread: {
      id: 'thread-1',
      cwd: 'C:/workspace',
      path: 'C:/rollouts/thread-1.jsonl',
      turns: [
        /* The person's side arrives as `content`, not `text` -- measured
           against codex 0.146.0. Reading only `text` dropped every line the
           person wrote and restored a one-voiced conversation. */
        { id: 'saved-turn-1', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Fix the header' }] }, { type: 'agentMessage', text: 'Header fixed' }] },
        { id: 'saved-turn-2', items: [{ type: 'reasoning', text: 'thinking' }, { type: 'agentMessage', text: 'Anything else?' }] }
      ]
    },
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh'
  });
  const resumedThread = await resumed;
  assert.equal(resumedThread.threadId, 'thread-1');
  assert.equal(resumedThread.turnCount, 2);
  assert.equal(resumedThread.model, 'gpt-5.6-sol');
  assert.equal(resumedThread.reasoningEffort, 'xhigh', 'the effort the thread really has is what the surface must show');
  assert.equal(resumedThread.cwd, 'C:/workspace');
  assert.deepEqual(resumedThread.turns[0].said, [
    { who: 'you', text: 'Fix the header' },
    { who: 'agent', text: 'Header fixed' }
  ]);
  assert.deepEqual(resumedThread.turns[1].said, [{ who: 'agent', text: 'Anything else?' }],
    'only what was said crosses into a UI; reasoning and tool payloads stay on the engine side');

  const forked = adapter.forkThread('thread-1', { lastTurnId: 'turn-0' });
  const forkRequest = writtenRequest(transport, 'thread/fork');
  assert.equal(forkRequest.method, 'thread/fork');
  assert.deepEqual(forkRequest.params, { threadId: 'thread-1', lastTurnId: 'turn-0' });
  response(transport, forkRequest, { thread: { id: 'thread-2' } });
  assert.equal((await forked).threadId, 'thread-2');


  const turn = adapter.sendTurn({
    threadId: 'thread-1', text: 'Inspect this image',
    images: [{ path: 'C:/images/example.png', detail: 'high' }, { url: 'data:image/png;base64,AA==' }]
  });
  const turnRequest = writtenRequest(transport, 'turn/start');
  assert.equal(turnRequest.method, 'turn/start');
  assert.deepEqual(turnRequest.params.input, [
    { type: 'text', text: 'Inspect this image', text_elements: [] },
    { type: 'localImage', path: 'C:/images/example.png', detail: 'high' },
    { type: 'image', url: 'data:image/png;base64,AA==' }
  ]);
  response(transport, turnRequest, { turn: { id: 'turn-1' } });
  assert.deepEqual(await turn, { turnId: 'turn-1' });

  transport.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'Hello ' } });
  transport.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'world' } });
  transport.emit({ method: 'item/completed', params: {
    threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'item-1', text: 'Hello world' }
  } });
  assert.deepEqual(events.filter(event => event.type === 'assistant_text_delta').map(event => event.text), ['Hello ', 'world']);
  assert.deepEqual(events.find(event => event.type === 'assistant_text'), {
    type: 'assistant_text', threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', text: 'Hello world'
  });

  // Textless starts are progress, not assistant speech or a completed reasoning row.
  transport.emit({ method: 'item/started', params: {
    threadId: 'thread-1', turnId: 'turn-1', item: { type: 'reasoning', id: 'reason-1' }
  } });
  assert.deepEqual(events.find(event => event.type === 'thinking'), {
    type: 'thinking', threadId: 'thread-1', turnId: 'turn-1', itemId: 'reason-1', text: '', status: 'inProgress'
  });
  transport.emit({ method: 'item/completed', params: {
    threadId: 'thread-1', turnId: 'turn-1', item: { type: 'reasoning', id: 'reason-1', text: 'considering the header fix' }
  } });
  assert.deepEqual(events.find(event => event.type === 'thinking' && event.text), {
    type: 'thinking', threadId: 'thread-1', turnId: 'turn-1', itemId: 'reason-1', text: 'considering the header fix'
  });
  assert.ok(!events.some(event => event.type === 'assistant_text' && event.text === 'considering the header fix'),
    'reasoning must never be forwarded as assistant_text');

  /* A REASONING BLOCK WITHOUT TEXT IS SILENCE, NOT A DEAD SESSION. MEASURED
     2026-09-03 on the owner's running instance: text "" reached requiredString,
     which threw CODEX_PROTOCOL_INVALID, which fail-closed the whole adapter
     mid-turn -- the circle stayed "running" forever and Halt, Queue and Send
     all reported busy. Mutation-checked: restoring requiredString on that read
     makes the assistant_text assertion below fail, because the adapter is dead
     by the time the message arrives. */
  transport.emit({ method: 'item/completed', params: {
    threadId: 'thread-1', turnId: 'turn-1', item: {
      type: 'reasoning', id: 'reason-summary', summary: ['Checking the result.'], content: ['must not be surfaced']
    }
  } });
  assert.equal(events.find(event => event.itemId === 'reason-summary').text, 'Checking the result.');
  assert.ok(!JSON.stringify(events).includes('must not be surfaced'));
  const thinkingBefore = events.filter(event => event.type === 'thinking').length;
  for (const item of [
    { type: 'reasoning', id: 'reason-empty', text: '' },
    { type: 'reasoning', id: 'reason-absent' },
    { type: 'reasoning', id: 'reason-null', text: null }
  ]) {
    transport.emit({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item } });
  }
  assert.equal(events.filter(event => event.type === 'thinking').length, thinkingBefore,
    'a reasoning block with empty, absent or null text must emit no thinking event');
  transport.emit({ method: 'item/completed', params: {
    threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'item-after-silence', text: 'still here' }
  } });
  assert.deepEqual(events.find(event => event.type === 'assistant_text' && event.itemId === 'item-after-silence'), {
    type: 'assistant_text', threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-after-silence', text: 'still here'
  }, 'the adapter must still deliver events after a textless reasoning block');

  transport.emit({
    id: 'approval-command', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', startedAtMs: 1,
      command: 'node test.js', cwd: 'C:/workspace', reason: 'test command'
    }
  });
  const commandApproval = events.find(event => event.type === 'approval_request' && event.approval.kind === 'commandExecution').approval;
  assert.deepEqual(commandApproval.availableDecisions.map(choice => choice.value), [
    'accept',
    'acceptForSession',
    'acceptWithExecpolicyAmendment',
    'applyNetworkPolicyAmendment',
    'decline',
    'cancel'
  ]);
  adapter.answerApproval({ approvalId: commandApproval.approvalId, response: { decision: 'acceptForSession' } });
  assert.deepEqual(writtenResponse(transport, 'approval-command'), {
    jsonrpc: '2.0', id: 'approval-command', result: { decision: 'acceptForSession' }
  });

  transport.emit({
    id: 'approval-file', method: 'item/fileChange/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-1', startedAtMs: 2,
      reason: 'write output', grantRoot: 'C:/workspace'
    }
  });
  const fileApproval = events.find(event => event.type === 'approval_request' && event.approval.kind === 'fileChange').approval;
  assert.deepEqual(fileApproval.availableDecisions.map(choice => choice.value), ['accept', 'acceptForSession', 'decline', 'cancel']);
  adapter.answerApproval({ approvalId: fileApproval.approvalId, response: { decision: 'decline' } });
  assert.deepEqual(writtenResponse(transport, 'approval-file'), {
    jsonrpc: '2.0', id: 'approval-file', result: { decision: 'decline' }
  });

  transport.emit({
    id: 9, method: 'item/permissions/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'permissions-1', startedAtMs: 3,
      cwd: 'C:/workspace', environmentId: null, reason: 'network', permissions: { network: { enabled: true }, fileSystem: null }
    }
  });
  const permissionsApproval = events.find(event => event.type === 'approval_request' && event.approval.kind === 'permissions').approval;
  assert.deepEqual(permissionsApproval.availableDecisions, [{ responseFields: ['permissions', 'scope', 'strictAutoReview'], scopes: ['turn', 'session'] }]);
  adapter.answerApproval({
    approvalId: permissionsApproval.approvalId,
    response: { permissions: { network: { enabled: true }, fileSystem: null }, scope: 'turn', strictAutoReview: true }
  });
  assert.deepEqual(writtenResponse(transport, 9), {
    jsonrpc: '2.0', id: 9,
    result: { permissions: { network: { enabled: true }, fileSystem: null }, scope: 'turn', strictAutoReview: true }
  });

  transport.emit({ method: 'item/started', params: {
    threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'command-2', command: 'node check.js', cwd: 'C:/workspace' }
  } });
  transport.emit({ method: 'item/completed', params: {
    threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'command-2', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 }
  } });
  assert.deepEqual(events.filter(event => event.toolCallId === 'command-2').map(event => event.type), ['tool_call', 'tool_result']);
  transport.emit({ method: 'item/completed', params: {
    threadId: 'thread-1', turnId: 'turn-1', item: {
      type: 'mcpToolCall', id: 'rejoined-tool', server: 'toolsenabled', tool: 'host.exec',
      arguments: { command: 'node check.js' }, status: 'completed', result: { output: 'ok' }
    }
  } });
  const rejoined = events.find(event => event.toolCallId === 'rejoined-tool');
  assert.equal(rejoined.type, 'tool_result');
  assert.equal(rejoined.payload.tool, 'host.exec', 'a result received without its start still names the actual tool');
  assert.deepEqual(rejoined.payload.arguments, { command: 'node check.js' });
  assert.deepEqual(rejoined.payload.result, { output: 'ok' }, 'call context never replaces the actual result');


  transport.emit({ method: 'thread/tokenUsage/updated', params: {
    threadId: 'thread-1', turnId: 'turn-1', tokenUsage: {
      total: { totalTokens: 12, inputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0 },
      last: { totalTokens: 4, inputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      modelContextWindow: 128000
    }
  } });
  assert.equal(adapter.getUsage('thread-1').total.totalTokens, 12);
  assert.equal(events.at(-1).type, 'usage');

  const interrupted = adapter.interrupt({ threadId: 'thread-1', turnId: 'turn-1' });
  const interruptRequest = writtenRequest(transport, 'turn/interrupt');
  assert.deepEqual(interruptRequest, { jsonrpc: '2.0', id: 6, method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } });
  response(transport, interruptRequest, {});
  await interrupted;

  /* The wire's own effort knob, and the catalog the menu is built from. */
  const settings = adapter.updateThreadSettings('thread-1', { effort: 'high' });
  const settingsRequest = writtenRequest(transport, 'thread/settings/update');
  assert.deepEqual(settingsRequest.params, { threadId: 'thread-1', effort: 'high' });
  response(transport, settingsRequest, {});
  assert.deepEqual(await settings, { threadId: 'thread-1', effort: 'high' });

  const catalog = adapter.listModels();
  const catalogRequest = writtenRequest(transport, 'model/list');
  assert.deepEqual(catalogRequest.params, {});
  response(transport, catalogRequest, {
    models: [{
      id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
        { reasoningEffort: 'ultra', description: 'Maximum reasoning with automatic task delegation' }
      ]
    }]
  });
  const models = (await catalog).models;
  assert.equal(models[0].id, 'gpt-5.6-sol');
  assert.equal(models[0].defaultEffort, 'low');
  assert.deepEqual(models[0].efforts.map(entry => entry.id), ['low', 'ultra']);
  assert.match(models[0].efforts[1].description, /automatic task delegation/,
    "the provider's own words describe its own efforts; the product does not paraphrase them");

  const retryCase = createAdapter();
  const modern = createAdapter({ codexVersion: 'codex-cli 0.153.2' });
  await modern.transport.completeInitialization(modern.adapter);
  assert.deepEqual(writtenRequest(modern.transport, 'initialized'), { method: 'initialized' });
  const modernCatalog = modern.adapter.listModels();
  response(modern.transport, writtenRequest(modern.transport, 'model/list'), {
    data: [{ id: 'first-model', supportedReasoningEfforts: [] }], nextCursor: 'page-two'
  });
  await nextTick();
  assert.deepEqual(writtenRequests(modern.transport, 'model/list').at(-1).params, { cursor: 'page-two' });
  response(modern.transport, writtenRequests(modern.transport, 'model/list').at(-1), {
    data: [{ id: 'second-model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null
  });
  assert.deepEqual((await modernCatalog).models.map(m => m.id), ['first-model', 'second-model']);
  const malformedCatalog = modern.adapter.listModels();
  response(modern.transport, writtenRequests(modern.transport, 'model/list').at(-1), { wrongField: [] });
  await assert.rejects(malformedCatalog, /data/);
  modern.adapter.close();
  await retryCase.transport.completeInitialization(retryCase.adapter);
  const retried = retryCase.adapter.startThread();
  const firstStartAttempt = writtenRequest(retryCase.transport, 'thread/start');
  retryCase.transport.emit({ id: firstStartAttempt.id, error: { code: -32001, message: 'backpressure' } });
  await nextTick();
  const startAttempts = writtenRequests(retryCase.transport, 'thread/start');
  assert.equal(startAttempts.length, 2, 'backpressure retries the JSON-RPC request once');
  const retryStartAttempt = startAttempts.find(request => request.id !== firstStartAttempt.id);
  assert.ok(retryStartAttempt, 'backpressure retry has a distinct JSON-RPC request id');
  response(retryCase.transport, retryStartAttempt, { thread: { id: 'thread-retried' } });
  assert.equal((await retried).threadId, 'thread-retried');

  const hostile = createAdapter();
  await hostile.transport.completeInitialization(hostile.adapter);
  hostile.transport.emit({ id: 'attack', method: 'item/tool/call', params: {} });
  await nextTick();
  await protocolReject(() => hostile.adapter.startThread(), 'CODEX_PROTOCOL_UNSUPPORTED_REQUEST');

  /* THE RESOLVED SANDBOX, AND THE DOWNGRADE THAT MADE IT WORTH READING.
   *
   * MEASURED off codex-cli 0.146.0 on Windows, 2026-08-20, one real
   * `thread/start` per row against the app-server, reading this exact field:
   *
   *   asked read-only          -> {"type":"readOnly","networkAccess":false}
   *   asked workspace-write    -> {"type":"readOnly","networkAccess":false}
   *   asked danger-full-access -> {"type":"dangerFullAccess"}
   *
   * The middle row is the defect: a Standard session asked for workspace-write,
   * was given read-only, and could then neither write a file in its own working
   * directory nor run `node --version`. The packets below are those, byte for
   * byte, beside the shapes that must NEVER throw -- a parser that refuses a
   * surprise in this field refuses to START THE SESSION, which trades a copy
   * defect for an outage. */
  const resolvedSandboxFor = async (result) => {
    const probe = createAdapter();
    await probe.transport.completeInitialization(probe.adapter);
    const pending = probe.adapter.startThread({ cwd: 'C:/workspace', sandbox: 'workspace-write' });
    response(probe.transport, writtenRequest(probe.transport, 'thread/start'), result);
    return (await pending).resolvedSandbox;
  };

  assert.deepEqual(
    await resolvedSandboxFor({ thread: { id: 't' }, sandbox: { type: 'readOnly', networkAccess: false } }),
    { type: 'readOnly', networkAccess: false },
    'the engine answered readOnly to a workspace-write request, and that disagreement is the fact a person is owed',
  );
  assert.deepEqual(
    await resolvedSandboxFor({ thread: { id: 't' }, sandbox: { type: 'dangerFullAccess' } }),
    { type: 'dangerFullAccess', networkAccess: null },
    'a resolved sandbox that carries no networkAccess reports null for it rather than guessing false',
  );

  for (const [label, sandbox] of [
    ['a string where an object was measured', 'read-only'],
    ['an array', ['readOnly']],
    ['null', null],
    ['an object naming no type', { networkAccess: false }],
    ['an empty type', { type: '' }],
    ['a non-string type', { type: 7 }],
  ]) {
    assert.equal(
      await resolvedSandboxFor({ thread: { id: 't' }, sandbox }),
      null,
      `${label} must answer null -- the engine did not say -- rather than throwing or guessing`,
    );
  }

  /* THE 0.153 LINE. MEASURED 2026-09-04: the owner's Codex updated itself to
     0.153.2 and every Codex circle was refused CODEX_PROTOCOL_VERSION_MISMATCH.
     Its app-server schema carries every method this adapter names except
     thread/settings/update; TurnStartParams gained `effort`. So the line is
     supported by learning the missing method from the running server and
     carrying the effort on turn/start. Newer CLIs use the same negotiation. */
  assert.equal(assertPinnedVersion('codex-cli 0.153.2'), 'codex-cli 0.153.2', 'the checked 0.153 line is admitted');
  assert.equal(assertPinnedVersion('codex-cli 0.154.0'), 'codex-cli 0.154.0');
  {
    const { transport, adapter } = createAdapter({ codexVersion: 'codex-cli 0.153.2' });
    await transport.completeInitialization(adapter);
    const pendingSettings = adapter.updateThreadSettings('thread-9', { effort: 'high' });
    const settingsProbe = writtenRequest(transport, 'thread/settings/update');
    transport.emit({ id: settingsProbe.id, error: { code: -32601, message: 'Method not found' } });
    const remembered = await pendingSettings;
    assert.deepEqual(remembered, { threadId: 'thread-9', effort: 'high', appliesOn: 'next-turn' });
    await adapter.updateThreadSettings('thread-9', { effort: 'high' });
    assert.equal(writtenRequests(transport, 'thread/settings/update').length, 1,
      'the server capability is learned once, never inferred from the version');
    const turn = adapter.sendTurn({ threadId: 'thread-9', text: 'think harder' });
    const turnRequest = writtenRequest(transport, 'turn/start');
    assert.equal(turnRequest.params.effort, 'high', 'the remembered effort rides on the next turn/start');
    assert.equal(turnRequest.params.threadId, 'thread-9');
    response(transport, turnRequest, { turn: { id: 'turn-9', status: 'inProgress' } });
    await turn;
    const other = adapter.sendTurn({ threadId: 'thread-10', text: 'plain' });
    const otherRequest = writtenRequests(transport, 'turn/start')[1];
    assert.equal(Object.hasOwn(otherRequest.params, 'effort'), false, 'a thread with no remembered effort sends none');
    response(transport, otherRequest, { turn: { id: 'turn-10', status: 'inProgress' } });
    await other;
  }
  /* A REAL CODEX SAYS "UNKNOWN VARIANT", NOT -32601. MEASURED 2026-09-22 on
     codex-cli 0.155.1 and 0.156.0: an app-server answers a request it does not
     have with -32600 "Invalid request: unknown variant `<method>`, expected one
     of ...". The fallback must learn from that answer too, or a Codex without
     thread/settings/update fails the effort change instead of carrying it on
     the next turn. An -32600 naming a DIFFERENT variant is not that answer. */
  {
    const { transport, adapter } = createAdapter({ codexVersion: 'codex-cli 0.157.0' });
    await transport.completeInitialization(adapter);
    const pendingSettings = adapter.updateThreadSettings('thread-12', { effort: 'low' });
    const settingsProbe = writtenRequest(transport, 'thread/settings/update');
    transport.emit({ id: settingsProbe.id, error: { code: -32600,
      message: 'Invalid request: unknown variant `thread/settings/update`, expected one of `initialize`, `thread/start`' } });
    assert.deepEqual(await pendingSettings, { threadId: 'thread-12', effort: 'low', appliesOn: 'next-turn' },
      "Codex's own unknown-request answer must select the next-turn fallback");
    adapter.close();
  }
  {
    const { transport, adapter } = createAdapter({ codexVersion: 'codex-cli 0.157.0' });
    await transport.completeInitialization(adapter);
    const pending = adapter.updateThreadSettings('thread-13', { effort: 'low' });
    const request = writtenRequest(transport, 'thread/settings/update');
    transport.emit({ id: request.id, error: { code: -32600,
      message: 'Invalid request: unknown variant `lowest`, expected one of `low`, `medium`, `high`' } });
    await assert.rejects(pending, error => error.rpcCode === -32600 && error.requestUnknown === false);
    assert.equal(adapter.pendingTurnEffort.size, 0, 'an invalid value must not be disguised as a missing request');
    adapter.close();
  }
  {
    const { transport, adapter } = createAdapter({ codexVersion: 'codex-cli 9.0.0' });
    await transport.completeInitialization(adapter);
    const pending = adapter.updateThreadSettings('thread-err', { effort: 'high' });
    const request = writtenRequest(transport, 'thread/settings/update');
    transport.emit({ id: request.id, error: { code: -32602, message: 'Invalid params' } });
    await assert.rejects(pending, error => error.rpcCode === -32602);
    assert.equal(adapter.pendingTurnEffort.size, 0, 'a real failure must not be disguised as a capability fallback');
    adapter.close();
  }
  {
    const { transport, adapter } = createAdapter();
    await transport.completeInitialization(adapter);
    const pending = adapter.sendTurn({ threadId: 'thread-11', text: 'plain' });
    const request = writtenRequest(transport, 'turn/start');
    assert.equal(Object.hasOwn(request.params, 'effort'), false, 'the 0.146 line never puts effort on turn/start');
    response(transport, request, { turn: { id: 'turn-11', status: 'inProgress' } });
    await pending;
  }

  // A valid silent final message must not detach the event reader before
  // turn/completed. The next send also proves the adapter remains usable.
  for (const version of [CODEX_CLI_VERSION, '0.153.0']) {
    const { transport, adapter } = createAdapter({ codexVersion: version });
    await transport.completeInitialization(adapter);
    const events = [];
    adapter.onEvent(event => events.push(event));
    const first = adapter.sendTurn({ threadId: 'silent-thread', text: 'No reply needed' });
    response(transport, writtenRequest(transport, 'turn/start'), { turn: { id: 'silent-turn', status: 'inProgress' } });
    await first;
    transport.emit({ method: 'item/completed', params: {
      threadId: 'silent-thread', turnId: 'silent-turn',
      item: { type: 'agentMessage', id: 'silent-item', text: '' }
    } });
    transport.emit({ method: 'turn/completed', params: {
      threadId: 'silent-thread', turn: { id: 'silent-turn', status: 'completed' }
    } });
    assert.deepEqual(events.map(event => [event.type, event.turnId, event.text ?? event.status]), [
      ['assistant_text', 'silent-turn', ''],
      ['turn_completed', 'silent-turn', 'completed']
    ], `${version}: silence must preserve the terminal event`);
    const next = adapter.sendTurn({ threadId: 'silent-thread', text: 'Next assignment' });
    response(transport, writtenRequests(transport, 'turn/start')[1], { turn: { id: 'next-turn', status: 'inProgress' } });
    assert.deepEqual(await next, { turnId: 'next-turn' });
    adapter.close();
  }

  // Only an empty string is newly valid: malformed text and disagreement
  // with streamed content must continue to fail closed.
  for (const item of [
    { type: 'agentMessage', id: 'invalid-item' },
    { type: 'agentMessage', id: 'invalid-item', text: null },
    { type: 'agentMessage', id: 'invalid-item', text: 42 }
  ]) {
    const { transport, adapter } = createAdapter();
    await transport.completeInitialization(adapter);
    transport.emit({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item } });
    await protocolReject(() => adapter.sendTurn({ threadId: 'thread-1', text: 'next' }), 'CODEX_PROTOCOL_INVALID');
  }
  {
    const { transport, adapter } = createAdapter();
    await transport.completeInitialization(adapter);
    transport.emit({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'inconsistent-item', delta: 'Already spoken'
    } });
    transport.emit({ method: 'item/completed', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'inconsistent-item', text: '' }
    } });
    await protocolReject(() => adapter.sendTurn({ threadId: 'thread-1', text: 'next' }), 'CODEX_PROTOCOL_INVALID');
  }

  // Notifications may be delivered synchronously while turn/start is being
  // written, before its response. They establish the same thread/turn pair;
  // the later acknowledgement must agree and the next turn remains usable.
  {
    const { transport, adapter } = createAdapter({ codexVersion: '0.153.0' });
    await transport.completeInitialization(adapter);
    const earlyEvents = [];
    adapter.onEvent(event => earlyEvents.push(event));
    const first = adapter.sendTurn({ threadId: 'early-thread', text: 'No reply needed' });
    const firstRequest = writtenRequest(transport, 'turn/start');
    transport.emit({ method: 'item/completed', params: {
      threadId: 'early-thread', turnId: 'early-turn',
      item: { type: 'agentMessage', id: 'early-item', text: '' }
    } });
    transport.emit({ method: 'turn/completed', params: {
      threadId: 'early-thread', turn: { id: 'early-turn', status: 'completed' }
    } });
    response(transport, firstRequest, { turn: { id: 'early-turn', status: 'inProgress' } });
    assert.deepEqual(await first, { turnId: 'early-turn' });
    assert.deepEqual(earlyEvents.map(event => [event.type, event.threadId, event.turnId, event.text ?? event.status]), [
      ['assistant_text', 'early-thread', 'early-turn', ''],
      ['turn_completed', 'early-thread', 'early-turn', 'completed']
    ]);
    const next = adapter.sendTurn({ threadId: 'early-thread', text: 'next' });
    response(transport, writtenRequests(transport, 'turn/start')[1], { turn: { id: 'early-next', status: 'inProgress' } });
    assert.deepEqual(await next, { turnId: 'early-next' });
    adapter.close();
  }

  // Once a turn is acknowledged, a protocol refusal must end that exact turn
  // as failed before the reader detaches. The malformed/conflicting packet and
  // the later wire terminal itself never become public authority.
  for (const invalid of [
    {
      label: 'missing assistant text',
      packets: [{ method: 'item/completed', params: {
        threadId: 'guarded-thread', turnId: 'guarded-turn',
        item: { type: 'agentMessage', id: 'bad-item' }
      } }],
      message: /item\/completed\.item\.text must be a string/
    },
    {
      label: 'streamed/final disagreement',
      packets: [
        { method: 'item/agentMessage/delta', params: {
          threadId: 'guarded-thread', turnId: 'guarded-turn', itemId: 'bad-item', delta: 'spoken'
        } },
        { method: 'item/completed', params: {
          threadId: 'guarded-thread', turnId: 'guarded-turn',
          item: { type: 'agentMessage', id: 'bad-item', text: '' }
        } }
      ],
      prefix: [['assistant_text_delta', 'guarded-thread', 'guarded-turn', 'spoken']],
      message: /assistant message deltas disagree/
    },
    {
      label: 'wrong thread terminal',
      packets: [{ method: 'turn/completed', params: {
        threadId: 'other-thread', turn: { id: 'guarded-turn', status: 'completed' }
      } }],
      message: /did not match an active Codex thread/
    },
    {
      label: 'nonterminal status on terminal method',
      packets: [{ method: 'turn/completed', params: {
        threadId: 'guarded-thread', turn: { id: 'guarded-turn', status: 'inProgress' }
      } }],
      message: /status must be a terminal status/
    },
    {
      label: 'wrong turn terminal',
      packets: [{ method: 'turn/completed', params: {
        threadId: 'guarded-thread', turn: { id: 'other-turn', status: 'completed' }
      } }],
      message: /did not match the active Codex turn/
    }
  ]) {
    const { transport, adapter } = createAdapter({ codexVersion: '0.153.0' });
    await transport.completeInitialization(adapter);
    const guardedEvents = [];
    adapter.onEvent(event => guardedEvents.push(event));
    const first = adapter.sendTurn({ threadId: 'guarded-thread', text: invalid.label });
    response(transport, writtenRequest(transport, 'turn/start'), { turn: { id: 'guarded-turn', status: 'inProgress' } });
    await first;
    for (const packet of invalid.packets) transport.emit(packet);
    transport.emit({ method: 'turn/completed', params: {
      threadId: 'guarded-thread', turn: { id: 'guarded-turn', status: 'completed' }
    } });
    const publicShape = guardedEvents.map(event => [event.type, event.threadId, event.turnId, event.text ?? event.status]);
    assert.deepEqual(publicShape.slice(0, -1), invalid.prefix || [], `${invalid.label}: invalid packet became public`);
    assert.deepEqual(publicShape.at(-1).slice(0, 3), ['turn_completed', 'guarded-thread', 'guarded-turn'],
      `${invalid.label}: failure did not name the accepted turn`);
    assert.equal(guardedEvents.at(-1).status, 'failed', `${invalid.label}: protocol failure looked successful`);
    assert.match(guardedEvents.at(-1).text, invalid.message, `${invalid.label}: failure reason was lost`);
    await protocolReject(() => adapter.sendTurn({ threadId: 'guarded-thread', text: 'next' }), 'CODEX_PROTOCOL_INVALID');
  }

  // All statuses that the generated Codex TurnStatus makes terminal remain
  // valid; only inProgress is refused on the turn/completed method.
  for (const status of ['completed', 'interrupted', 'failed']) {
    const { transport, adapter } = createAdapter({ codexVersion: '0.153.0' });
    await transport.completeInitialization(adapter);
    const terminalEvents = [];
    adapter.onEvent(event => terminalEvents.push(event));
    const first = adapter.sendTurn({ threadId: 'status-thread', text: status });
    response(transport, writtenRequest(transport, 'turn/start'), { turn: { id: 'status-turn', status: 'inProgress' } });
    await first;
    transport.emit({ method: 'turn/completed', params: {
      threadId: 'status-thread', turn: { id: 'status-turn', status }
    } });
    assert.deepEqual(terminalEvents, [{
      type: 'turn_completed', threadId: 'status-thread', turnId: 'status-turn', status
    }]);
    const next = adapter.sendTurn({ threadId: 'status-thread', text: 'next' });
    response(transport, writtenRequests(transport, 'turn/start')[1], { turn: { id: 'status-next', status: 'inProgress' } });
    assert.deepEqual(await next, { turnId: 'status-next' });
    const beforeClose = terminalEvents.length;
    adapter.close();
    assert.equal(terminalEvents.length, beforeClose, 'explicit close must not invent a failed completion');
  }

  // Inert transport controls: a malformed packet cannot end host ownership
  // before the retained native transport confirms closure. No child is run.
  for (const refusesFirst of [false, true]) {
    const { transport, adapter } = createAdapter({ codexVersion: '0.153.0' });
    await adapter.initialize();
    const events = [];
    adapter.onEvent(event => events.push(event));
    const sent = adapter.sendTurn({ threadId: 'owned-thread', text: 'work' });
    response(transport, writtenRequest(transport, 'turn/start'), { turn: { id: 'owned-turn', status: 'inProgress' } });
    await sent;
    let calls = 0, confirm;
    transport.closeForProtocolFailure = () => {
      calls++;
      if (refusesFirst && calls === 1) return Promise.reject(new Error('No empty-job proof'));
      return new Promise(resolve => { confirm = resolve; });
    };
    const pending = adapter.listModels();
    let rejected = false;
    const observed = pending.catch(error => { rejected = true; assert.equal(error.code, 'CODEX_PROTOCOL_INVALID'); });
    transport.emit('not json\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.deepEqual(events, [], 'unconfirmed native closure must not declare the turn terminal');
    assert.equal(rejected, false, 'pending request custody must survive unconfirmed closure');
    assert.equal(adapter.activeTurns.size, 1);
    transport.emit({ method: 'turn/completed', params: { threadId: 'owned-thread', turn: { id: 'owned-turn', status: 'completed' } } });
    assert.deepEqual(events, [], 'late wire completion cannot replace closure proof');
    if (refusesFirst) {
      adapter.close();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 2, 'Close retries the retained cleanup rather than losing custody');
    }
    confirm();
    await observed;
    assert.equal(adapter.activeTurns.size, 0);
    assert.deepEqual(events.map(({ type, threadId, turnId, status }) => ({ type, threadId, turnId, status })), [
      { type: 'turn_completed', threadId: 'owned-thread', turnId: 'owned-turn', status: 'failed' }
    ]);
    await adapter.closed.retryCleanup();
    assert.equal(calls, refusesFirst ? 2 : 1, 'confirmed cleanup and terminal are idempotent');
  }

  console.log('Codex agent-engine adapter tests passed (streaming, approvals, images, lifecycle, interrupt, retry, fail-closed, resolved sandbox, 0.153 line, confirmed protocol closure).');
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
