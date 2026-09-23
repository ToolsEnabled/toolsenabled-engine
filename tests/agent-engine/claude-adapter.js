// EXECUTABLE CHANGE — testcanfail-tests-agent-engine-claude-adapter-js
// Strengthened assertion: the effort-choice description check now first requires
// at least one choice. Mutation: on the fifth getSessionConfigOptions call, the
// adapter was temporarily changed to return an empty effort options array. Before
// this change the suite stayed green; afterward it failed RED with:
// "AssertionError [ERR_ASSERTION]: effort config must expose choices" and
// "0 !== 6". The source mutation was then restored byte-for-byte (SHA-256
// f022bc44eca443e09edf98262535ed5f16cff4393f704ce5c230a8ddee57fed7).
// Restored green run: "Claude ACP agent-engine adapter tests passed (initialize,
// auth, capabilities, modes, config, streaming, approvals, images, fail-closed)."
// NOT-FOUND: exit-status/truthy-only evidence; swallowed try/catch or optional
// chaining; assertions against mocks of the behavior under test; file-wide skips
// or platform guards; expected values computed by the same production code.
// Preconditions not met: none.
'use strict';

const assert = require('node:assert/strict');
const contract = require('../../src/lib/agent-engine/engine-contract');
const {
  ACP_PROTOCOL_VERSION,
  ClaudeAdapter
} = require('../../src/lib/agent-engine/claude-adapter');

class FakeTransport {
  constructor() {
    this.writes = [];
    this.listeners = new Set();
  }

  write(line) {
    this.writes.push(JSON.parse(line));
  }

  onData(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message) {
    const line = typeof message === 'string' ? message : `${JSON.stringify(message)}\n`;
    for (const listener of this.listeners) listener(line);
  }
}

function createAdapter(options = {}) {
  const transport = new FakeTransport();
  const adapter = new ClaudeAdapter({ transport, ...options });
  return { transport, adapter };
}

function response(transport, request, result) {
  transport.emit({ jsonrpc: '2.0', id: request.id, result });
}

async function protocolReject(operation, code) {
  await assert.rejects(operation, error => error && error.code === code, `expected ${code}`);
}

async function initialize(case_, { image = false, authMethods = [], extraCapabilities = {} } = {}) {
  const pending = case_.adapter.initialize();
  const request = case_.transport.writes.at(-1);
  assert.deepEqual(request, {
    jsonrpc: '2.0', id: request.id, method: 'initialize',
    params: {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'toolsenabled', title: 'ToolsEnabled', version: '1' }
    }
  });
  response(case_.transport, request, {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      promptCapabilities: { image, audio: false, embeddedContext: false },
      ...extraCapabilities
    },
    agentInfo: { name: 'claude-agent-acp', version: 'test' },
    authMethods
  });
  return pending;
}

const liveModes = {
  currentModeId: 'default',
  availableModes: [
    { id: 'auto', name: 'Auto', description: 'Automatically choose when to request permission' },
    { id: 'default', name: 'Manual', description: 'Request permission for protected actions' },
    { id: 'acceptEdits', name: 'Accept Edits', description: 'Accept file edits without prompting' },
    { id: 'plan', name: 'Plan Mode', description: 'Planning mode, no actual tool execution' },
    { id: 'dontAsk', name: "Don't Ask", description: 'Do not request permission' },
    { id: 'bypassPermissions', name: 'Bypass Permissions', description: 'Bypass permission checks' }
  ]
};

const liveConfigOptions = [
  {
    id: 'mode',
    name: 'Permission mode',
    description: 'Controls permission behavior',
    category: 'permission',
    type: 'select',
    currentValue: 'default',
    options: liveModes.availableModes.map(({ id, name, description }) => ({ value: id, name, description }))
  },
  {
    id: 'model',
    name: 'Model',
    description: 'Selects the Claude model',
    category: 'model',
    type: 'select',
    currentValue: 'opus[1m]',
    options: [
      { value: 'default', name: 'Default', description: 'Use the agent default model' },
      { value: 'opus[1m]', name: 'Opus (1M)', description: 'Use Opus with a one-million-token context' },
      { value: 'claude-fable-5[1m]', name: 'Claude Fable 5 (1M)', description: 'Use Claude Fable 5 with extended context' },
      { value: 'sonnet', name: 'Sonnet', description: 'Use Sonnet' },
      { value: 'sonnet[1m]', name: 'Sonnet (1M)', description: 'Use Sonnet with extended context' },
      { value: 'haiku', name: 'Haiku', description: 'Use Haiku' }
    ]
  },
  {
    id: 'effort',
    name: 'Effort',
    description: 'Controls reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'xhigh',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'Extra high' },
      { value: 'max', name: 'Maximum' },
      { value: 'adaptive', name: 'Adaptive' }
    ]
  },
  {
    id: 'fast',
    name: 'Fast mode',
    description: 'Controls fast mode',
    category: 'model_config',
    type: 'select',
    currentValue: 'off',
    options: [
      { value: 'off', name: 'Off' },
      { value: 'on', name: 'On' }
    ]
  },
  {
    id: 'agent',
    name: 'Agent',
    description: 'Selects the agent',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default', description: 'Use the default agent' },
      { value: 'general-purpose', name: 'General purpose', description: 'Use the general-purpose agent' }
    ]
  }
];

const livePromptUsage = {
  inputTokens: 2,
  outputTokens: 5,
  cachedReadTokens: 24_494,
  cachedWriteTokens: 13_730,
  totalTokens: 38_231
};

(async () => {
  const main = createAdapter();
  contract.assertEngineAdapter(main.adapter);
  assert.equal(main.adapter.getCapabilities(), null);
  assert.equal(main.adapter.getAuthMethods(), null);
  const authMethods = [{ id: 'api-key', name: 'Anthropic API key', description: 'Agent-owned key setup' }];
  const initialized = await initialize(main, {
    image: true,
    authMethods,
    extraCapabilities: { loadSession: true, sessionCapabilities: { fork: true } }
  });
  assert.equal(initialized.agentCapabilities.promptCapabilities.image, true);
  assert.deepEqual(main.adapter.getCapabilities(), initialized.agentCapabilities);
  assert.deepEqual(main.adapter.getAuthMethods(), authMethods);
  assert.equal(Object.isFrozen(main.adapter.getAuthMethods()), true);

  const authenticated = main.adapter.authenticate('api-key');
  const authRequest = main.transport.writes.at(-1);
  assert.deepEqual(authRequest, {
    jsonrpc: '2.0', id: authRequest.id, method: 'authenticate', params: { methodId: 'api-key' }
  });
  response(main.transport, authRequest, {});
  assert.deepEqual(await authenticated, { methodId: 'api-key' });

  const started = main.adapter.startThread({ cwd: 'C:/workspace' });
  const newRequest = main.transport.writes.at(-1);
  assert.deepEqual(newRequest, {
    jsonrpc: '2.0', id: newRequest.id, method: 'session/new',
    params: { cwd: 'C:/workspace', mcpServers: [] }
  });
  response(main.transport, newRequest, {
    sessionId: 'session-1',
    modes: liveModes,
    configOptions: liveConfigOptions
  });
  assert.deepEqual(await started, {
    threadId: 'session-1',
    modes: liveModes,
    configOptions: liveConfigOptions
  });
  assert.equal(main.adapter.getSessionModes('session-1').availableModes.find(mode => mode.id === 'plan').id, 'plan');
  assert.equal(
    main.adapter.getSessionModes('session-1').availableModes.find(mode => mode.id === 'bypassPermissions').id,
    'bypassPermissions'
  );
  assert.deepEqual(main.adapter.getSessionConfigOptions('session-1'), liveConfigOptions);
  assert.equal(main.adapter.getSessionConfigOptions('session-1').find(option => option.id === 'model').currentValue, 'opus[1m]');
  assert.deepEqual(
    main.adapter.getSessionConfigOptions('session-1').find(option => option.id === 'mode').options.map(option => option.value),
    liveModes.availableModes.map(mode => mode.id)
  );
  assert.equal(Object.hasOwn(
    main.adapter.getSessionConfigOptions('session-1').find(option => option.id === 'agent'),
    'category'
  ), false);
  const effortChoices = main.adapter.getSessionConfigOptions('session-1')
    .find(option => option.id === 'effort').options;
  assert.equal(effortChoices.length, 6, 'effort config must expose choices');
  assert.equal(
    effortChoices.every(option => !Object.hasOwn(option, 'description')),
    true
  );

  const sparseDescriptors = createAdapter();
  await initialize(sparseDescriptors);
  const sparseSession = sparseDescriptors.adapter.startThread({ cwd: 'C:/workspace' });
  const sparseSessionRequest = sparseDescriptors.transport.writes.at(-1);
  response(sparseDescriptors.transport, sparseSessionRequest, {
    sessionId: 'session-sparse-descriptors',
    modes: { currentModeId: 'default', availableModes: [{ id: 'default' }] },
    configOptions: [{ id: 'minimal' }, { id: 'choice', options: [{ value: 'only' }] }]
  });
  assert.deepEqual(await sparseSession, {
    threadId: 'session-sparse-descriptors',
    modes: { currentModeId: 'default', availableModes: [{ id: 'default' }] },
    configOptions: [{ id: 'minimal' }, { id: 'choice', options: [{ value: 'only' }] }]
  });

  const events = [];
  main.adapter.onEvent(event => events.push(event));
  main.transport.emit({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'help', description: 'Show available commands' }]
      }
    }
  });
  const turn = main.adapter.sendTurn({
    threadId: 'session-1',
    text: 'Inspect the image',
    images: [{ url: 'data:image/png;base64,AA==' }]
  });
  const promptRequest = main.transport.writes.at(-1);
  assert.deepEqual(promptRequest, {
    jsonrpc: '2.0', id: promptRequest.id, method: 'session/prompt',
    params: {
      sessionId: 'session-1',
      prompt: [
        { type: 'text', text: 'Inspect the image' },
        { type: 'image', data: 'AA==', mimeType: 'image/png' }
      ]
    }
  });

  main.transport.emit({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello ' },
        messageId: 'message-1'
      }
    }
  });
  main.transport.emit({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'world' },
        messageId: 'message-1'
      }
    }
  });
  main.transport.emit({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'session-1',
      update: { sessionUpdate: 'usage_update', used: 1, size: 100 }
    }
  });
  main.transport.emit({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'session-1',
      update: { sessionUpdate: 'usage_update', used: 2, size: 100, _meta: { source: 'live-agent' } }
    }
  });
  main.transport.emit({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'usage_update',
        used: 3,
        size: 100,
        cost: { amount: 0.01, currency: 'USD' },
        _meta: { source: 'live-agent' }
      }
    }
  });
  main.transport.emit({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read file',
        kind: 'read', status: 'in_progress', rawInput: { path: 'src/example.js' }
      }
    }
  });
  main.transport.emit({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed',
        rawOutput: { text: 'ok' }
      }
    }
  });
  assert.deepEqual(events.filter(event => event.type === 'assistant_text_delta').map(event => event.text), ['Hello ', 'world']);
  assert.deepEqual(events.filter(event => event.toolCallId === 'tool-1').map(event => event.type), ['tool_call', 'tool_result']);
  assert.equal(events.find(event => event.type === 'tool_call').tool, 'read');

  main.transport.emit({
    jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-2', title: 'Run tests', kind: 'execute' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ]
    }
  });
  const approvalEvent = events.find(event => event.type === 'approval_request');
  assert.equal(approvalEvent.threadId, 'session-1');
  assert.equal(approvalEvent.toolCallId, 'tool-2');
  assert.deepEqual(approvalEvent.approval.availableDecisions.map(option => option.optionId), ['allow-once', 'reject-once']);
  main.adapter.answerApproval({
    approvalId: approvalEvent.approval.approvalId,
    response: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
  });
  assert.deepEqual(main.transport.writes.at(-1), {
    jsonrpc: '2.0', id: 'permission-1',
    result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
  });

  response(main.transport, promptRequest, { stopReason: 'end_turn', usage: livePromptUsage });
  const turnResult = await turn;
  /* The id carries a per-instance token (adapter turnIdToken), so a literal
     would be a value a restart may legitimately never issue again. Identity is
     asserted by coupling instead: the receipt, the assistant row's own id and
     the completion all name the one turn. */
  const { turnId } = turnResult;
  assert.match(turnId, /^acp-turn-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-1$/);
  assert.deepEqual(turnResult, { turnId, stopReason: 'end_turn' });
  assert.deepEqual(events.find(event => event.type === 'assistant_text'), {
    type: 'assistant_text', threadId: 'session-1', turnId,
    itemId: `acp-assistant-${turnId}`, text: 'Hello world'
  });
  for (const event of events.filter(item => Object.hasOwn(item, 'turnId'))) {
    assert.equal(event.turnId, turnId, `${event.type} named a turn this session never issued`);
  }
  assert.deepEqual(main.adapter.getUsage('session-1'), livePromptUsage);
  assert.equal(events.filter(event => event.type === 'usage').length, 4);
  assert.equal(events.at(-1).type, 'turn_completed');

  const wrongConfigChoiceKey = createAdapter();
  await initialize(wrongConfigChoiceKey);
  const invalidSession = wrongConfigChoiceKey.adapter.startThread({ cwd: 'C:/workspace' });
  const invalidSessionRequest = wrongConfigChoiceKey.transport.writes.at(-1);
  response(wrongConfigChoiceKey.transport, invalidSessionRequest, {
    sessionId: 'session-invalid-config',
    configOptions: [{
      ...liveConfigOptions[0],
      options: liveConfigOptions[0].options.map(({ value, ...option }) => ({ id: value, ...option }))
    }]
  });
  await protocolReject(invalidSession, 'ACP_PROTOCOL_INVALID');

  const authRequired = createAdapter();
  await initialize(authRequired, { authMethods });
  const unauthenticatedSession = authRequired.adapter.startThread({ cwd: 'C:/workspace' });
  const unauthenticatedRequest = authRequired.transport.writes.at(-1);
  authRequired.transport.emit({
    jsonrpc: '2.0', id: unauthenticatedRequest.id,
    error: { code: -32000, message: 'Authentication required' }
  });
  await assert.rejects(unauthenticatedSession, error => {
    assert.equal(error.code, 'ACP_AUTH_REQUIRED');
    assert.deepEqual(error.authMethods, authMethods);
    return true;
  });

  const noImage = createAdapter();
  await initialize(noImage, { image: false });
  const writesBeforeRefusal = noImage.transport.writes.length;
  await protocolReject(noImage.adapter.sendTurn({
    threadId: 'session-no-image', text: 'Image', images: [{ url: 'data:image/png;base64,AA==' }]
  }), 'ACP_IMAGE_UNSUPPORTED');
  assert.equal(noImage.transport.writes.length, writesBeforeRefusal, 'refused image never reaches the ACP transport');

  const hostile = createAdapter();
  await initialize(hostile);
  hostile.transport.emit({
    jsonrpc: '2.0', id: 'attack', method: 'session/request_permission',
    params: { sessionId: 'session-hostile' }
  });
  await protocolReject(hostile.adapter.startThread({ cwd: 'C:/workspace' }), 'ACP_PROTOCOL_INVALID');

  console.log('Claude ACP agent-engine adapter tests passed (initialize, auth, capabilities, modes, config, streaming, approvals, images, fail-closed).');
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
