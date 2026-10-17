'use strict';
// Offline protocol + private IPC fixtures only. Synthetic terminal decisions
// are behavior checks, never evidence of a verified human or live consent.
require('./lib/isolated-environment').activate('host-input-context');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateInputRequest } = require('../src/lib/agent-engine/input-contract');
const { normalizeProviderInputContext } = require('../src/lib/agent-engine/codex-input-context');
const { CodexAdapter, CODEX_CLI_VERSION } = require('../src/lib/agent-engine/codex-adapter');
const { createInteractionBroker } = require('../src/lib/host-worker-interactions');
const { startInteractionTerminal, runInteractionTerminal } = require('../src/lib/host-interaction-terminal');
const owner = { nodeId: 'fixture-node', sessionId: 'fixture-session', parentSessionId: 'fixture-parent', level: 2 };
const request = { inputId: 'fixture-input', threadId: 'fixture-thread', turnId: 'fixture-turn',
  kind: 'form', sourceName: 'fixture-server', message: 'fixture provider question', schema: { type: 'object', properties: {} } };
const metadata = () => ({ codex_approval_kind: 'mcp_tool_call', codex_requires_user_input: true,
  tool_name: 'host.write_file', tool_params: { path: 'reports/fixture.md', content: 'PRIVATE_PAYLOAD_MARKER',
    authorization: 'PRIVATE_AUTH_MARKER' }, tool_params_display: 'PRIVATE_DISPLAY_MARKER',
  tool_description: 'PRIVATE_DESCRIPTION_MARKER', persist: ['session', 'always'] });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function adapterFixture(t, options = {}) {
  let receive;
  let resolveReply;
  const replyObserved = new Promise(resolve => { resolveReply = resolve; });
  const writes = [], events = [];
  const adapter = new CodexAdapter({ codexVersion: CODEX_CLI_VERSION, ...options, transport: {
    onData(fn) { receive = fn; return () => {}; },
    write(line) {
      const packet = JSON.parse(line); writes.push(packet);
      if (packet.id === 'fixture-rpc' && !packet.method) resolveReply(packet);
      if (packet.method === 'initialize') reply({ id: packet.id, result: { userAgent: 'offline-fixture' } });
      if (packet.method === 'turn/start') reply({ id: packet.id, result: { turn: { id: request.turnId } } });
    },
  } });
  function reply(packet) { receive(JSON.stringify(packet) + '\n'); }
  adapter.onEvent(event => events.push(event));
  t.after(() => adapter.close());
  await adapter.initialize();
  await adapter.sendTurn({ threadId: request.threadId, text: 'offline fixture' });
  function emit(extra = {}) {
    reply({ id: 'fixture-rpc', method: 'mcpServer/elicitation/request', params: {
      threadId: request.threadId, turnId: request.turnId, serverName: request.sourceName, mode: 'form',
      message: request.message, requestedSchema: request.schema, ...extra,
    } });
  }
  return { adapter, writes, events, emit, replyObserved };
}
function results(f) { return f.writes.filter(packet => packet.id === 'fixture-rpc'); }
async function waitForReply(f) {
  let timer;
  try {
    return await Promise.race([f.replyObserved, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Offline fixture reply was not observed within 2 seconds')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

test('approval context keeps only safe tool identity and lexical relative target, never parameter values', () => {
  const context = normalizeProviderInputContext(metadata());
  assert.equal(context.purpose, 'mcp-tool-approval');
  assert.equal(context.status, 'recognized');
  assert.equal(context.toolName, 'host.write_file');
  assert.equal(context.target, 'reports/fixture.md');
  assert.equal(context.parametersOmitted, true);
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE_|persist|authorization/);
  assert.ok(Object.isFrozen(context));
});

test('missing, unknown privileged and malformed metadata remain explicitly unresolved and bounded', () => {
  assert.deepEqual(normalizeProviderInputContext(undefined), { purpose: 'unknown', status: 'missing', parametersOmitted: true });
  assert.deepEqual(normalizeProviderInputContext(null), { purpose: 'unknown', status: 'missing', parametersOmitted: true });
  const unknown = normalizeProviderInputContext({ codex_approval_kind: 'future-privileged-kind', tool_name: 'host.write_file' });
  assert.equal(unknown.purpose, 'provider-approval');
  assert.equal(unknown.status, 'unrecognized');
  let accessed = false;
  const getter = { get codex_approval_kind() { accessed = true; return 'mcp_tool_call'; } };
  let deep = {}; for (let i = 0; i < 10; i++) deep = { nested: deep };
  for (const raw of [false, [], getter, deep, { codex_approval_kind: false },
    { codex_approval_kind: 'mcp_tool_call', content: 'x'.repeat(65537) }]) {
    const context = normalizeProviderInputContext(raw);
    assert.equal(context.purpose, 'provider-approval');
    assert.equal(context.status, 'malformed');
    assert.ok(Buffer.byteLength(JSON.stringify(context)) < 1024);
  }
  assert.equal(accessed, false);
});

test('unsafe identities and targets are omitted instead of rendered or treated as workspace authority', () => {
  for (const target of ['../outside', '/absolute/private', 'C:\\Users\\other\\file', 'reports/\u001b[31m.txt',
    'reports/token=private.txt', 'reports/api_key.txt', 'reports/' + 'x'.repeat(513), 'reports/.env']) {
    const context = normalizeProviderInputContext({ ...metadata(), tool_name: 'unsafe\u001b[31m', tool_params: { path: target } });
    assert.equal(context.target, undefined, target);
    assert.equal(context.toolName, undefined);
  }
  const credentialShape = 'sk-' + 'Z'.repeat(24); // synthetic shape, no credential value
  assert.equal(normalizeProviderInputContext({ ...metadata(), tool_params: { path: 'reports/' + credentialShape } }).target, undefined);
});

test('normalized context contract refuses raw parameters, forged grants, oversized and contradictory context', () => {
  for (const context of [null, { purpose: 'mcp-tool-approval', status: 'recognized', parametersOmitted: true, content: 'PRIVATE' },
    { purpose: 'mcp-tool-approval', status: 'recognized', parametersOmitted: true, approved: true },
    { purpose: 'unknown', status: 'recognized', parametersOmitted: true },
    { purpose: 'mcp-tool-approval', status: 'recognized', parametersOmitted: true, target: '../outside' },
    { purpose: 'mcp-tool-approval', status: 'recognized', parametersOmitted: true, toolName: 'x'.repeat(129) }]) {
    assert.throws(() => validateInputRequest({ ...request, context }), { code: 'AGENT_INPUT_INVALID' });
  }
});

for (const field of ['_meta', 'meta']) test(`adapter carries bounded ${field} context but waits for an explicit answer`, async t => {
  let shown, resolve;
  const f = await adapterFixture(t, { requestInput: value => { shown = value; return new Promise(r => { resolve = r; }); } });
  f.emit({ [field]: metadata() }); await tick();
  assert.equal(shown.context.purpose, 'mcp-tool-approval');
  assert.equal(shown.context.toolName, 'host.write_file');
  assert.doesNotMatch(JSON.stringify(shown), /PRIVATE_|authorization|persist/);
  assert.equal(results(f).length, 0, 'metadata is never an answer');
  resolve({ action: 'decline' }); await tick();
  assert.deepEqual(results(f).map(packet => packet.result), [{ action: 'decline', content: null }]);
  assert.doesNotMatch(JSON.stringify(f.events), /host.write_file|reports\/fixture|PRIVATE_/);
});

test('ambiguous and malformed wire metadata cannot be downgraded into an ordinary question', async t => {
  for (const extra of [{ _meta: metadata(), meta: {} }, { _meta: false }, { _meta: { codex_approval_kind: 'future-kind' } }, { _meta: null }, {}]) {
    let shown;
    const f = await adapterFixture(t, { requestInput: value => { shown = value; return { action: 'cancel' }; } });
    f.emit(extra); await tick();
    assert.ok(['provider-approval', 'unknown'].includes(shown.context.purpose));
    assert.ok(['missing', 'malformed', 'unrecognized'].includes(shown.context.status));
    assert.deepEqual(results(f)[0].result, { action: 'cancel', content: null });
  }
});

test('approval context cannot bypass broker read-only authority or foreign correlation and never enters summaries', async () => {
  const broker = createInteractionBroker();
  const events = [];
  const withContext = { ...request, context: normalizeProviderInputContext(metadata()) };
  assert.deepEqual(await broker.request({ ...owner, level: 1 }, withContext), { action: 'cancel', content: null });
  const pending = broker.request(owner, withContext, { onEvent: event => events.push(event) });
  const row = broker.show(broker.list()[0].interactionId);
  assert.equal(row.request.context.target, 'reports/fixture.md');
  assert.doesNotMatch(JSON.stringify([broker.list(), events]), /context|host.write_file|reports\/fixture|PRIVATE_/);
  assert.throws(() => broker.answer(row.interactionId, { ...row, threadId: 'foreign' }, { action: 'accept', content: {} }),
    { code: 'HOST_INPUT_IDENTITY_MISMATCH' });
  assert.equal(broker.list().length, 1);
  broker.answer(row.interactionId, row, { action: 'cancel' });
  assert.deepEqual(await pending, { action: 'cancel', content: null });
  assert.throws(() => broker.show(row.interactionId), { code: 'HOST_INPUT_STALE' });
  broker.close();
});

for (const mode of ['timeout', 'unavailable', 'cancel', 'decline']) test(`approval-context ${mode} preserves cancellation/decline without implicit consent`, async t => {
  const events = [];
  const broker = createInteractionBroker({ timeoutMs: 5 });
  t.after(() => broker.close());
  const f = await adapterFixture(t, { inputTimeoutMs: 1500,
    ...(mode === 'unavailable' ? {} : { requestInput: value => {
      const pending = broker.request(owner, value, { onEvent: event => events.push(event) });
      if (mode !== 'timeout') {
        const row = broker.show(broker.list()[0].interactionId);
        broker.answer(row.interactionId, row, { action: mode });
      }
      return pending;
    } }),
  });
  f.emit({ _meta: metadata() }); await waitForReply(f);
  // Without a host route ('unavailable') this build keeps 1.9.0's plain decline;
  // the Windows host line cancelled there (ported from its 700f45c).
  assert.deepEqual(results(f).map(packet => packet.result), [mode === 'unavailable' ? { action: 'decline' }
    : { action: mode === 'decline' ? 'decline' : 'cancel', content: null }]);
  if (mode === 'timeout') assert.equal(events.at(-1).payload.reason, 'timeout');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|reports\/fixture|host.write_file/);
});

for (const action of ['accept', 'decline', 'cancel']) test(`offline terminal fixture discloses empty approval purpose and preserves explicit ${action}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-context-ipc-'));
  const stateRoot = path.join(root, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 });
  const broker = createInteractionBroker();
  const terminal = await startInteractionTerminal({ stateRoot, broker, env: {} });
  t.after(async () => { await terminal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const pending = broker.request(owner, { ...request, message: 'PRIVATE_MESSAGE_MARKER\u001b[31m', context: normalizeProviderInputContext(metadata()) });
  let output = ''; const questions = ['1', action, '{}']; let asked = 0;
  const result = await runInteractionTerminal({ stateRoot, env: {}, input: { isTTY: true },
    output: { isTTY: true, write(value) { output += value; } },
    makeReader: () => ({ question: async () => { asked++; return questions.shift(); }, close() {} }),
  });
  assert.equal(result.action, action);
  assert.deepEqual(await pending, { action, content: action === 'accept' ? {} : null });
  assert.equal(asked, action === 'accept' ? 3 : 2, 'empty form still requires explicit decision, and explicit JSON on acceptance');
  assert.match(output, /MCP tool operation approval/);
  assert.match(output, /host.write_file/); assert.match(output, /reports\/fixture.md/);
  assert.match(output, /not.*permission grant|does not.*grant/i);
  assert.match(output, /omitted/i);
  assert.doesNotMatch(output, /PRIVATE_|\u001b|"persist"|authorization/);
  assert.doesNotMatch(fs.readFileSync(terminal.descriptorPath, 'utf8'), /context|host.write_file|reports\/fixture/);
});

test('offline terminal fixture labels missing approval purpose and bounds ordinary question display', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-context-bound-'));
  const stateRoot = path.join(root, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 });
  const broker = createInteractionBroker();
  const terminal = await startInteractionTerminal({ stateRoot, broker, env: {} });
  t.after(async () => { await terminal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const credentialShape = 'sk-' + 'Z'.repeat(24); // synthetic shape, no credential value
  for (const empty of [true, false]) {
    const pending = broker.request(owner, { ...request, inputId: `input-${empty}`,
      message: empty ? 'Please confirm the deployment window. token=PRIVATE_QUESTION_VALUE ' + credentialShape : 'x'.repeat(10000) + '\u001b[31m',
      schema: empty ? request.schema : { type: 'object', properties: { title: { type: 'string' } } } });
    let output = ''; const questions = ['1', 'cancel'];
    await runInteractionTerminal({ stateRoot, env: {}, input: { isTTY: true },
      output: { isTTY: true, write(value) { output += value; } },
      makeReader: () => ({ question: async () => questions.shift(), close() {} }) });
    assert.equal((await pending).action, 'cancel');
    assert.match(output, /purpose unknown/i);
    assert.doesNotMatch(output, /PRIVATE_QUESTION_VALUE|\u001b/);
    assert.equal(output.includes(credentialShape), false);
    if (empty) assert.match(output, /Please confirm the deployment window/);
    if (!empty) { assert.match(output, /truncated at 8192/); assert.ok(output.length < 10000); }
  }
});

test('offline nonempty approval form preserves enum choices and numeric constraints without displaying raw operation prose', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-context-schema-'));
  const stateRoot = path.join(root, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 });
  const broker = createInteractionBroker();
  const terminal = await startInteractionTerminal({ stateRoot, broker, env: {} });
  t.after(async () => { await terminal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const pending = broker.request(owner, { ...request, message: 'PRIVATE_OPERATION_MESSAGE',
    context: normalizeProviderInputContext(metadata()), schema: { type: 'object', properties: {
      mode: { type: 'string', enum: ['once', 'skip'], description: 'Select one choice' },
      count: { type: 'integer', minimum: 2, maximum: 4 },
    }, required: ['mode', 'count'] } });
  let output = ''; const questions = ['1', 'accept', '{"mode":"once","count":3}'];
  await runInteractionTerminal({ stateRoot, env: {}, input: { isTTY: true },
    output: { isTTY: true, write(value) { output += value; } },
    makeReader: () => ({ question: async () => questions.shift(), close() {} }) });
  assert.deepEqual(await pending, { action: 'accept', content: { mode: 'once', count: 3 } });
  assert.match(output, /"enum"/); assert.match(output, /"once"/); assert.match(output, /"skip"/);
  assert.match(output, /"minimum":\s*2/); assert.match(output, /"maximum":\s*4/);
  assert.match(output, /"required"/); assert.doesNotMatch(output, /PRIVATE_/);
});

test('offline terminal redacts quoted and escaped JSON sensitive assignments before display while retaining question and choices', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-context-quoted-'));
  const stateRoot = path.join(root, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 });
  const broker = createInteractionBroker();
  const terminal = await startInteractionTerminal({ stateRoot, broker, env: {} });
  t.after(async () => { await terminal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Synthetic non-provider-shaped values only; no credential is read or used.
  const value = 'SYNTHETIC_VALUE_FIRST "quoted" SYNTHETIC_VALUE_LAST';
  let quoted = JSON.stringify({ password: value, token: 'SYNTHETIC_TOKEN_VALUE', note: 'Select the delivery window' });
  for (let depth = 0; depth <= 3; depth++) {
    const pending = broker.request(owner, { ...request, inputId: `quoted-${depth}`,
      message: 'Question: choose safe-a or safe-b. ' + quoted,
      schema: { type: 'object', properties: { choice: { type: 'string', enum: ['safe-a', 'safe-b'],
        description: 'Field help ' + quoted } }, required: ['choice'] } });
    let output = ''; const questions = ['1', 'accept', '{"choice":"safe-a"}'];
    await runInteractionTerminal({ stateRoot, env: {}, input: { isTTY: true },
      output: { isTTY: true, write(chunk) { output += chunk; } },
      makeReader: () => ({ question: async () => questions.shift(), close() {} }) });
    assert.deepEqual(await pending, { action: 'accept', content: { choice: 'safe-a' } });
    assert.equal(output.includes('SYNTHETIC_VALUE_'), false, 'quoted sensitive value must be omitted');
    assert.equal(output.includes('SYNTHETIC_TOKEN_VALUE'), false, 'escaped sensitive value must be omitted');
    assert.match(output, /Question: choose safe-a or safe-b/);
    assert.match(output, /Select the delivery window/);
    assert.match(output, /"enum"/); assert.match(output, /"safe-a"/); assert.match(output, /"safe-b"/);
    assert.match(output, /credential omitted/i);
    quoted = JSON.stringify(quoted).slice(1, -1);
  }
});

test('offline terminal safely omits incomplete or unsupported sensitive quoting and retains response constraints', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-context-incomplete-'));
  const stateRoot = path.join(root, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 });
  const broker = createInteractionBroker();
  const terminal = await startInteractionTerminal({ stateRoot, broker, env: {} });
  t.after(async () => { await terminal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const [index, text] of [
    [0, 'Confirm scope. {"password":"SYNTHETIC_INCOMPLETE_VALUE'],
    [1, 'Confirm scope. "password":' + '\\'.repeat(2) + '"SYNTHETIC_UNSUPPORTED_VALUE'],
  ]) {
    const pending = broker.request(owner, { ...request, inputId: 'incomplete-' + index, message: text,
      schema: { type: 'object', properties: { count: { type: 'integer', minimum: 2, maximum: 4 } }, required: ['count'] } });
    let output = ''; const questions = ['1', 'cancel'];
    await runInteractionTerminal({ stateRoot, env: {}, input: { isTTY: true },
      output: { isTTY: true, write(chunk) { output += chunk; } },
      makeReader: () => ({ question: async () => questions.shift(), close() {} }) });
    assert.equal((await pending).action, 'cancel');
    assert.equal(output.includes('SYNTHETIC_'), false);
    assert.match(output, /Confirm scope/);
    assert.match(output, /incomplete quoted assignment|unsupported quote escaping/);
    assert.match(output, /"minimum":\s*2/); assert.match(output, /"maximum":\s*4/);
  }
});
