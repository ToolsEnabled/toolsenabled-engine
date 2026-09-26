'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  LspError,
  LspSession,
  MessageReader,
  encodeMessage
} = require('../src/lib/lsp-client');

function framePayload(frame) {
  const separator = frame.indexOf('\r\n\r\n');
  return JSON.parse(frame.subarray(separator + 4).toString('utf8'));
}

function fakeChild(onWrite = () => {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.writes = [];
  child.kills = [];
  child.stdin = {
    destroyed: false,
    write(frame) {
      const payload = framePayload(frame);
      child.writes.push(payload);
      onWrite(payload, child);
      return true;
    },
    ref() {},
    unref() {}
  };
  child.stdout = Object.assign(new EventEmitter(), { ref() {}, unref() {} });
  child.stderr = Object.assign(new EventEmitter(), { ref() {}, unref() {} });
  child.ref = () => {};
  child.unref = () => {};
  child.kill = signal => {
    child.kills.push(signal);
    queueMicrotask(() => child.exit(null, signal));
    return true;
  };
  child.reply = message => child.stdout.emit('data', encodeMessage({ jsonrpc: '2.0', ...message }));
  child.exit = (code, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  return child;
}

function sessionOptions(overrides = {}) {
  return { command: 'fake-lsp', rootUri: 'file:///workspace', ...overrides };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error instanceof LspError && error.code === code);
}

let checks = 0;
async function check(label, fn) {
  await fn();
  checks += 1;
  void label;
}

(async () => {
  await check('input validation refuses before spawning', async () => {
    let spawnCalls = 0;
    const spawnFn = () => { spawnCalls += 1; };
    assert.throws(() => new LspSession(sessionOptions({ command: '', spawnFn })),
      error => error instanceof LspError && error.code === 'LSP_INPUT_INVALID');
    assert.throws(() => new LspSession(sessionOptions({ rootUri: '', spawnFn })),
      error => error instanceof LspError && error.code === 'LSP_INPUT_INVALID');
    assert.equal(spawnCalls, 0);
  });

  await check('invalid session state refuses without spawning or writing', async () => {
    let spawnCalls = 0;
    const session = new LspSession(sessionOptions({ spawnFn: () => { spawnCalls += 1; } }));
    await rejectsCode(session.request('textDocument/hover', {}), 'LSP_SESSION_INVALID_STATE');
    assert.throws(() => session.notify('initialized', {}),
      error => error instanceof LspError && error.code === 'LSP_SESSION_INVALID_STATE');
    assert.equal(spawnCalls, 0);
    assert.equal(session.nextId, 1, 'the refused request was not allocated or written');
  });

  await check('synchronous spawn failure is typed and writes nothing', async () => {
    let spawnCalls = 0;
    const session = new LspSession(sessionOptions({ spawnFn() {
      spawnCalls += 1;
      throw new Error('exec unavailable');
    } }));
    await rejectsCode(session.start(), 'LSP_SERVER_START_FAILED');
    assert.equal(spawnCalls, 1);
    assert.equal(session.child, null);
    assert.equal(session.state, 'failed');
  });

  await check('server JSON-RPC error rejects initialization and kills the child', async () => {
    const child = fakeChild((message, target) => {
      if (message.method === 'initialize') queueMicrotask(() => target.reply({ id: message.id, error: { code: -32002, message: 'not ready' } }));
    });
    const session = new LspSession(sessionOptions({ spawnFn: () => child }));
    await rejectsCode(session.start(), 'LSP_SERVER_ERROR');
    assert.deepEqual(child.writes.map(message => message.method), ['initialize']);
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(session.state, 'failed');
  });

  await check('request timeout cancels, kills, and fails the session', async () => {
    const child = fakeChild();
    const session = new LspSession(sessionOptions({ spawnFn: () => child, startTimeoutMs: 10 }));
    await rejectsCode(session.start(), 'LSP_REQUEST_TIMEOUT');
    assert.deepEqual(child.writes.map(message => message.method), ['initialize', '$/cancelRequest']);
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(session.state, 'failed');
  });

  await check('unexpected process exit rejects pending initialization as a crash', async () => {
    const child = fakeChild((message, target) => {
      if (message.method === 'initialize') queueMicrotask(() => target.exit(23));
    });
    const session = new LspSession(sessionOptions({ spawnFn: () => child }));
    await rejectsCode(session.start(), 'LSP_SERVER_CRASHED');
    assert.deepEqual(child.writes.map(message => message.method), ['initialize']);
    assert.deepEqual(child.kills, []);
    assert.deepEqual(session.exitInfo, { code: 23, signal: null });
  });

  await check('stopping rejects outstanding work with the stopped refusal', async () => {
    const child = fakeChild((message, target) => {
      if (message.method === 'initialize' || message.method === 'shutdown') {
        queueMicrotask(() => target.reply({ id: message.id, result: message.method === 'initialize' ? { capabilities: {} } : null }));
      }
      if (message.method === 'exit') queueMicrotask(() => target.exit(0));
    });
    const session = new LspSession(sessionOptions({ spawnFn: () => child }));
    await session.start();
    const outstanding = session.request('workspace/symbol', { query: 'never answered' });
    const stopped = session.stop({ timeoutMs: 20 });
    await rejectsCode(outstanding, 'LSP_SESSION_STOPPED');
    assert.deepEqual(await stopped, { stopped: true, graceful: true });
    assert.equal(session.state, 'stopped');
    assert.deepEqual(child.kills, []);
    assert.deepEqual(child.writes.map(message => message.method),
      ['initialize', 'initialized', 'workspace/symbol', 'shutdown', 'exit']);
  });

  await check('encodeMessage declares UTF-8 length and preserves payload', async () => {
    const payload = { jsonrpc: '2.0', id: 7, result: 'ready ✓' };
    const framed = encodeMessage(payload);
    const separator = framed.indexOf('\r\n\r\n');
    const body = framed.subarray(separator + 4);
    assert.equal(framed.subarray(0, separator).toString('ascii'), `Content-Length: ${body.length}`);
    assert.deepEqual(JSON.parse(body.toString('utf8')), payload);
  });

  await check('MessageReader incrementally decodes split and back-to-back frames', async () => {
    const first = { jsonrpc: '2.0', id: 1, result: { label: 'λ' } };
    const second = { jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'done' } };
    const bytes = Buffer.concat([encodeMessage(first), encodeMessage(second)]);
    const splitAt = bytes.indexOf(Buffer.from('λ')) + 1;
    const reader = new MessageReader();
    assert.deepEqual(reader.push(bytes.subarray(0, splitAt)), []);
    assert.deepEqual(reader.push(bytes.subarray(splitAt)), [first, second]);
    assert.equal(reader.buffer.length, 0);
  });

  await check('MessageReader reports malformed framing as a typed failure', async () => {
    const reader = new MessageReader();
    assert.throws(() => reader.push(Buffer.from('X-Length: 2\r\n\r\n{}')),
      error => error instanceof LspError && error.code === 'LSP_PROTOCOL_ERROR' && /Content-Length/.test(error.message));
  });

  await check('MessageReader enforces the configured message-size bound', async () => {
    const reader = new MessageReader({ maxMessageBytes: 3, maxBufferBytes: 100 });
    assert.throws(() => reader.push(Buffer.from('Content-Length: 4\r\n\r\nnull')),
      error => error instanceof LspError
        && error.code === 'LSP_RESPONSE_TOO_LARGE'
        && error.details.maxMessageBytes === 3);
  });

  console.log(`lsp-client tests passed (${checks} checks).`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
