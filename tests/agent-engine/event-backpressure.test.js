'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const { createEventBackpressure } = require('../../src/lib/agent-engine/event-backpressure');
const { ClaudeCliAdapter, CLAUDE_MAX_HELD_EVENTS } = require('../../src/lib/agent-engine/claude-cli-adapter');
const { CodexAdapter, CODEX_CLI_VERSION } = require('../../src/lib/agent-engine/codex-adapter');
const { AcpAdapter } = require('../../src/lib/agent-engine/acp-adapter');
const { AntigravityCliAdapter } = require('../../src/lib/agent-engine/antigravity-cli-adapter');
const { validateEngineEvent } = require('../../src/lib/agent-engine/engine-contract');

/* The sparse b102 checkout carries the real Linux process custodian but omits
 * its already-tracked proc dependency from the working tree. The focused
 * process proof loads the real createCodexProcessTransport and child process;
 * only the unrelated subscription-environment compatibility import is kept
 * dependency-light for this inert fixture. No provider credential or account
 * path is used by the fixture. */
const HIDDEN_SPAWN_FILE = path.resolve(__dirname, '../../src/lib/proc/hidden-spawn.js');
const CODEX_PROCESS_FILE = path.resolve(__dirname, '../../src/lib/agent-engine/codex-process.js');
const CLAUDE_PROCESS_FILE = path.resolve(__dirname, '../../src/lib/agent-engine/claude-cli-process.js');
const CLAUDE_ACP_PROCESS_FILE = path.resolve(__dirname, '../../src/lib/agent-engine/claude-process.js');
const { createCodexProcessTransport, createClaudeCliTransport, createClaudeAcpTransport, MAX_CLAUDE_LINE_BYTES } = (() => {
  const load = Module._load;
  Module._load = function(request, parent, isMain) {
    if ((parent?.filename === HIDDEN_SPAWN_FILE || parent?.filename === CLAUDE_ACP_PROCESS_FILE)
        && request === '../providers/subscription-launch-env') {
      return {
        BILLING_TRIPWIRE: Object.freeze([]),
        safeLaunchEnvironment(environment) { return { ...(environment || {}) }; }
      };
    }
    if (parent?.filename === CODEX_PROCESS_FILE && request === '../fleet-supervisor/kill-tree.js') {
      return { killProcessTree(child) { child.kill?.(); } };
    }
    if (parent?.filename === CLAUDE_PROCESS_FILE && request === '../providers/provider-toolchain') {
      return {
        isOwnedPath() { return false; },
        selfUpdateEnvironment() { return {}; },
        featuresFromHelp() { return null; },
        rowFor() { return { features: { list: [] } }; },
        evaluateFeatures() { return null; },
        describeCopy() { return null; },
        recallProbe() { return null; },
        rememberProbe() {}
      };
    }
    if (parent?.filename === CLAUDE_PROCESS_FILE && request === '../fleet-supervisor/kill-tree.js') {
      return { killProcessTree(child) { child.kill?.(); } };
    }
    return load.apply(this, arguments);
  };
  try {
    return {
      createCodexProcessTransport: require('../../src/lib/agent-engine/codex-process').createCodexProcessTransport,
      createClaudeCliTransport: require('../../src/lib/agent-engine/claude-cli-process').createClaudeCliTransport,
      createClaudeAcpTransport: require('../../src/lib/agent-engine/claude-process').createClaudeAcpTransport,
      MAX_CLAUDE_LINE_BYTES: require('../../src/lib/agent-engine/claude-cli-process').MAX_CLAUDE_LINE_BYTES
    };
  } finally {
    Module._load = load;
  }
})();

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

async function waitFor(check, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), message);
}

function fixtureEnvironment() {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: '/tmp',
    CODEX_HOME: '/tmp',
    LANG: 'C.UTF-8'
  };
}

function fastProviderScript(count, { exitOnClose = false } = {}) {
  return `
const readline = require('node:readline');
const count = ${count};
const threadId = 'thread-fast-provider';
const turnId = 'turn-fast-provider';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function write(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function burst() {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId, turnId, itemId: 'item-fast-provider', delta: 'delta-' + index
    }}));
  }
  lines.push(JSON.stringify({ method: 'turn/completed', params: {
    threadId, turn: { id: turnId, status: 'completed' }
  }}));
  process.stdout.write(lines.join('\\n') + '\\n');
}

rl.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    write({ id: request.id, result: { userAgent: 'fast-provider', codexHome: '/tmp', platformFamily: 'linux', platformOs: 'linux' } });
  } else if (request.method === 'thread/start') {
    write({ id: request.id, result: { thread: { id: threadId } } });
  } else if (request.method === 'turn/start') {
    write({ id: request.id, result: { turn: { id: turnId } } });
    setImmediate(burst);
  }
});
${exitOnClose ? "rl.on('close', () => setImmediate(() => process.exit(0)));" : ''}
`;
}

function payloadProviderScript(count, payloadBytes, batchSize) {
  return `
const readline = require('node:readline');
const count = ${count};
const payloadBytes = ${payloadBytes};
const batchSize = ${batchSize};
const threadId = 'thread-payload-provider';
const turnId = 'turn-payload-provider';
const payload = 'p'.repeat(payloadBytes);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function write(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function writeBatch(index) {
  if (index >= count) {
    write({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    return;
  }
  const lines = [];
  const end = Math.min(count, index + batchSize);
  for (let cursor = index; cursor < end; cursor += 1) {
    lines.push(JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId, turnId, itemId: 'item-payload-provider', delta: 'index=' + cursor + ';' + payload
    }}));
  }
  const chunk = lines.join('\\n') + '\\n';
  const continueWriting = () => setImmediate(() => writeBatch(end));
  if (!process.stdout.write(chunk)) process.stdout.once('drain', continueWriting);
  else continueWriting();
}
rl.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    write({ id: request.id, result: { userAgent: 'payload-provider', codexHome: '/tmp', platformFamily: 'linux', platformOs: 'linux' } });
  } else if (request.method === 'thread/start') {
    write({ id: request.id, result: { thread: { id: threadId } } });
  } else if (request.method === 'turn/start') {
    write({ id: request.id, result: { turn: { id: turnId } } });
    setImmediate(() => writeBatch(0));
  }
});
`;
}

async function openPayloadProvider(count, payloadBytes, batchSize) {
  const raw = createCodexProcessTransport({
    command: process.execPath,
    args: ['-e', payloadProviderScript(count, payloadBytes, batchSize)],
    env: fixtureEnvironment(),
    cwd: process.cwd()
  });
  let pauseCalls = 0;
  let resumeCalls = 0;
  const transport = {
    ...raw,
    pause() { pauseCalls += 1; return raw.pause(); },
    resume() { resumeCalls += 1; return raw.resume(); },
    get pauseCalls() { return pauseCalls; },
    get resumeCalls() { return resumeCalls; }
  };
  const adapter = new CodexAdapter({ transport, codexVersion: CODEX_CLI_VERSION, retryDelayMs: 0 });
  return { transport, adapter, raw };
}

async function openFastProvider(count, options = {}) {
  const raw = createCodexProcessTransport({
    command: process.execPath,
    args: ['-e', fastProviderScript(count, options)],
    env: fixtureEnvironment(),
    cwd: process.cwd()
  });
  let pauseCalls = 0;
  let resumeCalls = 0;
  const transport = {
    ...raw,
    pause() { pauseCalls += 1; return raw.pause(); },
    resume() { resumeCalls += 1; return raw.resume(); },
    get pauseCalls() { return pauseCalls; },
    get resumeCalls() { return resumeCalls; }
  };
  const adapter = new CodexAdapter({ transport, codexVersion: CODEX_CLI_VERSION, retryDelayMs: 0 });
  return { transport, adapter, raw };
}

function claudePartsProviderScript(count) {
  return `
const count = ${count};
let sent = false;
process.stdin.on('data', () => {
  if (sent) return;
  sent = true;
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    session_id: 'claude-real-parts-thread',
    message: {
      id: 'claude-real-parts-message',
      content: Array.from({ length: count }, (_, index) => ({ type: 'text', text: 'assistant-' + index }))
    }
  }) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`;
}

function claudeExitAfterPacketScript() {
  return `
process.stdout.write(JSON.stringify({ type: 'fixture', value: 'accepted-before-exit' }) + '\\n');
setTimeout(() => process.exit(0), 40);
`;
}

async function openClaudePartsProvider(count) {
  const raw = createClaudeCliTransport({
    command: process.execPath,
    args: ['-e', claudePartsProviderScript(count)],
    env: fixtureEnvironment(),
    cwd: process.cwd(),
    stderrSink: () => null
  });
  let pauseCalls = 0;
  let resumeCalls = 0;
  const transport = {
    ...raw,
    pause() { pauseCalls += 1; return raw.pause(); },
    resume() { resumeCalls += 1; return raw.resume(); },
    get pauseCalls() { return pauseCalls; },
    get resumeCalls() { return resumeCalls; }
  };
  const adapter = new ClaudeCliAdapter({ transport });
  adapter.threadId = 'claude-real-parts-thread';
  return { transport, adapter, raw };
}

function fakeTransport({ startup = false } = {}) {
  let onData;
  let pauses = 0;
  let resumes = 0;
  return {
    send() {},
    write() {},
    onData(next) { onData = next; return () => { onData = null; }; },
    close() {},
    ...(startup ? { closeForStartupFailure() { return Promise.resolve(); } } : {}),
    pause() { pauses += 1; },
    resume() { resumes += 1; },
    get pauses() { return pauses; },
    get resumes() { return resumes; },
    deliver(...args) { onData?.(...args); }
  };
}

test('actual Codex process transport pauses stdout and resumes a fixed burst without loss', async t => {
  const count = 512;
  const { transport, adapter } = await openFastProvider(count);
  let stopped = false;
  t.after(() => {
    if (stopped) return;
    try { adapter.close(); } finally { transport.close(); }
  });

  const gate = deferred();
  const events = [];
  adapter.onEvent(event => {
    if (event.type === 'assistant_text_delta') {
      events.push(event.text);
      if (events.length === 1) return gate.promise;
    } else if (event.type === 'turn_completed') {
      events.push('completed');
    }
    return undefined;
  });

  await adapter.initialize();
  const { threadId } = await adapter.startThread({ cwd: process.cwd() });
  const baselineRss = process.memoryUsage().rss;
  const turn = adapter.sendTurn({ threadId, text: 'fixed-budget fixture' });
  await waitFor(() => events.length === 1, 'the first provider event was not accepted');
  assert.equal(transport.pauseCalls, 1, 'provider stdout pause was not requested at the held boundary');
  const pausedRss = process.memoryUsage().rss;
  const rssDelta = pausedRss - baselineRss;
  process.stdout.write(`# FAST_PROVIDER_RSS count=${count} rssDeltaBytes=${rssDelta} budgetBytes=${64 * 1024 * 1024}\n`);
  assert.ok(rssDelta < 64 * 1024 * 1024,
    `fixed ${count}-event provider burst exceeded the 64MiB RSS budget`);

  gate.resolve();
  await turn;
  await waitFor(() => events.length === count + 1, 'the fixed provider burst did not drain completely');
  assert.deepEqual(events, [...Array.from({ length: count }, (_, index) => `delta-${index}`), 'completed'],
    'provider events changed order or were lost after resume');
  assert.equal(transport.resumeCalls, 1, 'provider stdout stayed paused after the durable boundary');
  stopped = true;
  adapter.close();
  transport.close();
});

test('actual Codex child bounds a coalesced payload-heavy stream above the RSS budget', async t => {
  const count = 4_096;
  const payloadBytes = 32 * 1024;
  const batchSize = 8;
  const rssBudget = 64 * 1024 * 1024;
  const totalPayloadBytes = count * payloadBytes;
  assert.ok(totalPayloadBytes > rssBudget, 'fixture must exceed the declared RSS budget over its full valid stream');
  const { transport, adapter } = await openPayloadProvider(count, payloadBytes, batchSize);
  let stopped = false;
  t.after(() => {
    if (stopped) return;
    try { adapter.close(); } finally { transport.close(); }
  });

  const gate = deferred();
  const seen = [];
  adapter.onEvent(event => {
    if (event.type === 'assistant_text_delta') {
      const separator = event.text.indexOf(';');
      const index = Number(event.text.slice('index='.length, separator));
      assert.equal(event.text.slice(separator + 1).length, payloadBytes,
        'payload-heavy event was truncated before delivery');
      seen.push(index);
      if (seen.length === 1) return gate.promise;
    }
    return undefined;
  });

  await adapter.initialize();
  const { threadId } = await adapter.startThread({ cwd: process.cwd() });
  const baselineRss = process.memoryUsage().rss;
  const turn = adapter.sendTurn({ threadId, text: 'coalesced payload fixture' });
  await waitFor(() => seen.length === 1, 'payload provider did not reach its held boundary');
  assert.equal(transport.pauseCalls, 1, 'payload provider stdout was not paused at the first durable boundary');
  assert.ok(adapter.eventBoundary.maxOutstanding <= 1,
    'Codex parser offered more than one accepted event while storage was held');
  assert.ok(adapter.eventBoundary.maxOutstandingBytes >= payloadBytes,
    'Codex parser did not retain the measured bytes of its accepted event');
  const heldRssDelta = process.memoryUsage().rss - baselineRss;
  process.stdout.write(`# PAYLOAD_PROVIDER_RSS totalPayloadBytes=${totalPayloadBytes} heldRssDeltaBytes=${heldRssDelta} budgetBytes=${rssBudget} maxOutstandingBytes=${adapter.eventBoundary.maxOutstandingBytes}\n`);
  assert.ok(heldRssDelta < rssBudget,
    `coalesced valid stream exceeded the ${rssBudget}-byte harness RSS budget while held`);

  gate.resolve();
  await turn;
  await waitFor(() => seen.length === count, 'payload-heavy valid stream did not drain completely');
  assert.deepEqual(seen, Array.from({ length: count }, (_, index) => index),
    'coalesced valid lines changed order or lost a payload-heavy event');
  assert.equal(transport.resumeCalls, 1, 'payload provider stdout did not resume after the full stream drained');
  assert.equal(adapter.closed, null, 'valid multi-line payload stream was mistaken for a malformed line');
  stopped = true;
  adapter.close();
  transport.close();
});

test('person stop closes an actual provider child while stdout is paused', async t => {
  const { transport, adapter } = await openFastProvider(128, { exitOnClose: true });
  let stopped = false;
  t.after(() => {
    if (stopped) return;
    try { adapter.close(); } finally { transport.close(); }
  });

  const gate = deferred();
  const events = [];
  let exitInfo = null;
  transport.onData((chunk, exit) => { if (exit) exitInfo = exit; });
  adapter.onEvent(event => {
    if (event.type === 'assistant_text_delta') {
      events.push(event.text);
      if (events.length === 1) return gate.promise;
    }
    return undefined;
  });

  await adapter.initialize();
  const { threadId } = await adapter.startThread({ cwd: process.cwd() });
  const turn = adapter.sendTurn({ threadId, text: 'stop fixture' });
  turn.catch(() => {});
  await waitFor(() => events.length === 1, 'the stop fixture did not reach its held boundary');
  assert.equal(transport.pauseCalls, 1, 'stop fixture did not pause provider stdout');

  adapter.close();
  transport.close();
  await waitFor(() => exitInfo !== null,
    'person Stop did not close the paused provider child');
  process.stdout.write(`# FAST_PROVIDER_STOP signal=${exitInfo.signal || 'none'} code=${exitInfo.code === null ? 'none' : exitInfo.code}\n`);
  assert.equal(exitInfo.signal, 'SIGTERM', `the inert provider did not stop cleanly: ${JSON.stringify(exitInfo)}`);
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  stopped = true;
});

test('Claude assistant and user packet parts stay one-at-a-time under a held boundary', async () => {
  const cases = [
    {
      name: 'assistant',
      makePart: index => ({ type: 'text', text: `assistant-${index}` }),
      eventType: 'assistant_text'
    },
    {
      name: 'user',
      makePart: index => ({ type: 'tool_result', tool_use_id: `tool-${index}`, content: `result-${index}` }),
      eventType: 'tool_result'
    }
  ];
  const count = 8;
  for (const entry of cases) {
    const transport = fakeTransport();
    const adapter = new ClaudeCliAdapter({ transport });
    adapter.threadId = 'claude-parts-thread';
    const gates = Array.from({ length: count }, () => deferred());
    const seen = [];
    let inFlight = 0;
    let maxInFlight = 0;
    adapter.onEvent(event => {
      if (event.type !== entry.eventType) return undefined;
      seen.push(event.text);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return gates[seen.length - 1].promise.finally(() => { inFlight -= 1; });
    });
    const packet = entry.name === 'assistant'
      ? { type: 'assistant', session_id: adapter.threadId,
          message: { id: 'message-parts', content: Array.from({ length: count }, (_, index) => entry.makePart(index)) } }
      : { type: 'user', session_id: adapter.threadId,
          message: { role: 'user', content: Array.from({ length: count }, (_, index) => entry.makePart(index)) } };
    const handling = transport.deliver(packet);
    await waitFor(() => seen.length === 1, `${entry.name} packet did not reach its first event`);
    assert.equal(transport.pauses, 1, `${entry.name} packet did not pause its transport`);
    assert.ok(adapter.eventBoundary.maxQueued <= CLAUDE_MAX_HELD_EVENTS,
      `${entry.name} packet offered more than one accepted event while the first was held`);
    for (let index = 0; index < count; index += 1) {
      gates[index].resolve();
      if (index + 1 < count) {
        await waitFor(() => seen.length === index + 2,
          `${entry.name} packet did not deliver part ${index + 1} after the prior boundary settled`);
      }
    }
    await handling;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(maxInFlight, 1, `${entry.name} packet had concurrent listener deliveries`);
    assert.deepEqual(seen, Array.from({ length: count }, (_, index) => `${entry.name === 'assistant' ? 'assistant' : 'result'}-${index}`));
    assert.equal(adapter.eventBoundary.maxQueued, CLAUDE_MAX_HELD_EVENTS,
      `${entry.name} packet did not retain the declared one-event queue bound`);
    assert.equal(transport.resumes, 1, `${entry.name} packet did not resume after the full packet drained`);
    adapter.close();
  }
});

test('actual Claude process transport pauses a multi-part assistant packet at one accepted event', async () => {
  const count = 8;
  const { transport, adapter, raw } = await openClaudePartsProvider(count);
  const gates = Array.from({ length: count }, () => deferred());
  const seen = [];
  adapter.onEvent(event => {
    if (event.type !== 'assistant_text') return undefined;
    seen.push(event.text);
    return gates[seen.length - 1].promise;
  });
  transport.send({ type: 'fixture' });
  await waitFor(() => seen.length === 1, 'the real Claude fixture did not deliver its first part');
  assert.equal(transport.pauseCalls, 1, 'the real Claude stdout was not paused at the held boundary');
  assert.equal(adapter.eventBoundary.maxQueued, CLAUDE_MAX_HELD_EVENTS,
    'the real Claude packet offered more than one accepted event');
  for (let index = 0; index < count; index += 1) {
    gates[index].resolve();
    if (index + 1 < count) {
      await waitFor(() => seen.length === index + 2,
        `the real Claude fixture did not deliver part ${index + 1}`);
      assert.equal(transport.resumeCalls, 0,
        'Claude stdout resumed between parts of one held packet');
    }
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, Array.from({ length: count }, (_, index) => `assistant-${index}`));
  assert.equal(transport.resumeCalls, 1, 'the real Claude stdout did not resume after the packet drained');
  adapter.close();
  transport.close();
  await new Promise(resolve => raw.child.once('close', resolve));
});

test('Claude process keeps a valid line and refuses an oversized unframed remainder', async () => {
  const valid = JSON.stringify({ type: 'system', subtype: 'status', session_id: 'line-cap-thread' });
  const script = `
process.stdout.write(${JSON.stringify(valid + '\n')} + 'x'.repeat(${MAX_CLAUDE_LINE_BYTES + 1}), () => setTimeout(() => process.exit(0), 100));
process.stdin.resume();
`;
  const transport = createClaudeCliTransport({
    command: process.execPath,
    args: ['-e', script],
    env: fixtureEnvironment(),
    cwd: process.cwd(),
    stderrSink: () => null
  });
  const packets = [];
  const exit = new Promise(resolve => transport.onData((packet, info) => {
    if (packet === null) resolve(info);
    else packets.push(packet);
  }));
  const info = await exit;
  assert.deepEqual(packets, [{ type: 'system', subtype: 'status', session_id: 'line-cap-thread' }],
    'a valid line before malformed input was discarded');
  assert.equal(info.error?.code, 'CLAUDE_CLI_PROTOCOL_INVALID',
    'an oversized unframed remainder did not become a protocol refusal');
  assert.equal(info.error?.message, 'The Claude program wrote a protocol line that exceeded the safety limit.');
  transport.close();
});

test('event boundary keeps synchronous observers synchronous and drains async events in order', async () => {
  const events = [];
  let pauses = 0;
  let resumes = 0;
  const gate = deferred();
  const boundary = createEventBackpressure({
    listeners: [event => {
      events.push(event);
      if (event === 'first') return gate.promise;
      return undefined;
    }],
    pause: () => { pauses += 1; },
    resume: () => { resumes += 1; }
  });

  assert.equal(boundary.emit('first')?.constructor, Promise);
  assert.deepEqual(events, ['first']);
  assert.equal(boundary.paused, true);
  boundary.emit('second');
  assert.deepEqual(events, ['first']);

  gate.resolve();
  await boundary.wait();
  assert.deepEqual(events, ['first', 'second']);
  assert.equal(boundary.paused, false);
  assert.equal(pauses, 1);
  assert.equal(resumes, 1);

  const synchronous = [];
  const syncBoundary = createEventBackpressure({ listeners: [event => synchronous.push(event)] });
  assert.equal(syncBoundary.emit('now'), undefined);
  assert.deepEqual(synchronous, ['now']);
});

test('event sequences advance lazily after each accepted durability boundary', async () => {
  const gate = deferred();
  const seen = [];
  let produced = 0;
  const boundary = createEventBackpressure({
    listeners: [event => {
      seen.push(event);
      return event === 'first' ? gate.promise : undefined;
    }]
  });
  function* sequence() {
    produced += 1;
    yield 'first';
    produced += 1;
    yield 'second';
    produced += 1;
    yield 'third';
  }
  const draining = boundary.emitSequence(sequence());
  assert.equal(produced, 1, 'the sequence eagerly converted events beyond the first held boundary');
  assert.deepEqual(seen, ['first']);
  gate.resolve();
  await draining;
  assert.equal(produced, 3);
  assert.deepEqual(seen, ['first', 'second', 'third']);
  assert.equal(boundary.maxOutstanding, 1);
});

test('event boundary rejects a failed durability listener and stays paused', async () => {
  const failure = new Error('durability refused');
  let pauses = 0;
  let resumes = 0;
  const boundary = createEventBackpressure({
    listeners: [() => Promise.reject(failure)],
    pause: () => { pauses += 1; },
    resume: () => { resumes += 1; }
  });

  const failed = boundary.emit('accepted');
  assert.equal(boundary.wait(), failed);
  await assert.rejects(failed, error => error === failure);
  assert.equal(boundary.paused, true);
  assert.equal(pauses, 1);
  assert.equal(resumes, 0);
  await assert.rejects(boundary.close(), error => error === failure);
});

test('event boundary keeps later accepted events held after a rejected listener', async () => {
  const failure = new Error('durability refused');
  const events = [];
  let pauses = 0;
  let resumes = 0;
  const boundary = createEventBackpressure({
    listeners: [event => {
      events.push(event);
      return Promise.reject(failure);
    }],
    pause: () => { pauses += 1; },
    resume: () => { resumes += 1; }
  });

  const refused = boundary.emit('accepted');
  await assert.rejects(refused, error => error === failure);
  const later = boundary.emit('later-accepted');
  assert.equal(later, refused, 'a later accepted event must retain the same refused boundary');
  assert.equal(boundary.wait(), refused, 'wait must continue to refuse after the first rejection');
  await assert.rejects(later, error => error === failure);
  assert.deepEqual(events, ['accepted'], 'the later event must remain held, not be discarded or delivered');
  assert.equal(boundary.paused, true);
  assert.equal(pauses, 1);
  assert.equal(resumes, 0);

  // Explicit close is the only terminal action after refusal. It must not
  // re-enter a pending wait loop or resume the refused source.
  const closeResult = boundary.close();
  assert.equal(closeResult, refused);
  await assert.rejects(closeResult, error => error === failure);
  assert.equal(boundary.paused, true);
  assert.equal(resumes, 0);
});

test('event boundary refuses post-failure emits before mutating the undeliverable queue', async () => {
  const failure = new Error('durability refused');
  const boundary = createEventBackpressure({
    listeners: [() => Promise.reject(failure)]
  });

  const refused = boundary.emit('accepted');
  await assert.rejects(refused, error => error === failure);
  const queuedBefore = boundary.queued;
  const outstandingBefore = boundary.outstanding;
  const outstandingBytesBefore = boundary.outstandingBytes;
  const later = boundary.emit('after-refusal');
  assert.equal(later, refused, 'a post-failure event must return the existing refusal');
  assert.equal(boundary.queued, queuedBefore, 'a refused event was appended to an undeliverable queue');
  assert.equal(boundary.outstanding, outstandingBefore, 'a refused event changed outstanding event accounting');
  assert.equal(boundary.outstandingBytes, outstandingBytesBefore, 'a refused event changed outstanding byte accounting');
  await assert.rejects(later, error => error === failure);
  assert.equal(boundary.wait(), refused, 'wait must remain the terminal refusal');
  await assert.rejects(boundary.close(), error => error === failure);
});

test('validated multibyte event remains deliverable without a new payload refusal', () => {
  const text = '€'.repeat(333_333);
  const event = validateEngineEvent({
    type: 'assistant_text',
    threadId: 'multibyte-thread',
    turnId: 'multibyte-turn',
    text
  });
  assert.equal(Buffer.byteLength(event.text, 'utf8'), 999_999);
  const seen = [];
  const boundary = createEventBackpressure({ listeners: [value => seen.push(value)] });
  assert.equal(boundary.emit(event), undefined);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, text);
});

test('real Claude adapter retains a previously accepted oversized valid payload across a held boundary', async () => {
  const payloadBytes = 16 * 1024 * 1024 + 1_024;
  const transport = fakeTransport();
  const adapter = new ClaudeCliAdapter({ transport });
  const gate = deferred();
  const seen = [];
  adapter.onEvent(event => {
    seen.push(event);
    return gate.promise;
  });
  const event = {
    type: 'assistant_text',
    threadId: 'oversized-payload-thread',
    turnId: 'oversized-payload-turn',
    payload: { blob: 'x'.repeat(payloadBytes) }
  };
  const validated = validateEngineEvent(event);
  assert.ok(Buffer.byteLength(JSON.stringify(validated), 'utf8') > 16 * 1024 * 1024,
    'the fixture must be a valid engine event larger than the former boundary threshold');
  let boundary;
  try {
    assert.doesNotThrow(() => { boundary = adapter.emit(event); },
      'a previously accepted valid payload must not become a hard refusal');
    assert.equal(typeof boundary?.then, 'function',
      'the real adapter must return the held durability boundary');
    assert.equal(seen.length, 1, 'the accepted oversized event was not delivered exactly once');
    assert.equal(seen[0].payload.blob.length, payloadBytes,
      'the accepted oversized payload changed before the listener saw it');
    assert.ok(adapter.eventBoundary.maxOutstandingBytes > 16 * 1024 * 1024,
      'the accepted event must be reported as exceeding the former threshold');
    gate.resolve();
    await boundary;
    assert.equal(seen.length, 1, 'the accepted oversized event was delivered more than once');
  } finally {
    gate.resolve();
    if (boundary) await boundary.catch(() => {});
    adapter.close();
  }
});

test('real Claude CLI transport resumes a paused stdout before late child exit delivery', async () => {
  const transport = createClaudeCliTransport({
    command: process.execPath,
    args: ['-e', claudeExitAfterPacketScript()],
    env: fixtureEnvironment(),
    cwd: process.cwd(),
    stderrSink: () => null
  });
  const gate = deferred();
  let packetSeen = false;
  let exitInfo = null;
  const exited = new Promise(resolve => transport.onData((chunk, info) => {
    if (chunk === null) {
      exitInfo = info;
      resolve();
      return;
    }
    packetSeen = true;
    return gate.promise;
  }));
  try {
    await waitFor(() => packetSeen, 'the real Claude CLI child did not deliver its packet');
    await waitFor(() => transport.child.exitCode !== null, 'the real Claude CLI child did not exit while stdout was paused');
    transport.close();
    assert.equal(transport.child.stdout.isPaused(), false,
      'closing a paused Claude CLI transport left stdout paused after the child exited');
    gate.resolve();
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Claude CLI late exit was stranded')), 1_000))
    ]);
    assert.equal(exitInfo.code, 0);
  } finally {
    gate.resolve();
    transport.close();
  }
});

test('real Claude ACP transport resumes a paused stdout before close delivers late exit', async () => {
  const transport = createClaudeAcpTransport({
    command: process.execPath,
    args: ['-e', claudeExitAfterPacketScript()],
    env: fixtureEnvironment(),
    cwd: process.cwd()
  });
  let packetSeen = false;
  let exitInfo = null;
  const exited = new Promise(resolve => transport.onData((chunk, info) => {
    if (chunk === null) {
      exitInfo = info;
      resolve();
      return;
    }
    packetSeen = true;
    transport.pause();
  }));
  try {
    await waitFor(() => packetSeen, 'the real Claude ACP child did not deliver its packet');
    transport.close();
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Claude ACP late exit was stranded')), 1_000))
    ]);
    assert.ok(exitInfo && (exitInfo.code === 0 || exitInfo.signal || exitInfo.error),
      'Claude ACP close did not return a terminal child outcome');
  } finally {
    transport.resume();
    transport.close();
  }
});

test('Codex process-like transport drains coalesced lines before a held child exit', async t => {
  // This fixture mirrors createCodexProcessTransport's observable seam:
  // pause() defers deliverExit, resume() schedules it, and a data callback can
  // carry multiple newline-delimited protocol messages. The sparse checkout
  // intentionally lacks src/proc/hidden-spawn.js, so the real child factory
  // is not importable in this focused source fixture; the process transport
  // itself is reviewed separately and this exercises the adapter _receive path.
  class ProcessLikeTransport {
    constructor() {
      this.listeners = new Set();
      this.paused = false;
      this.exitInfo = null;
      this.writes = [];
    }
    onData(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    write(line) {
      const request = JSON.parse(line);
      this.writes.push(request);
      const respond = result => queueMicrotask(() => this.emit(`${JSON.stringify({ id: request.id, result })}\n`));
      if (request.method === 'initialize') {
        respond({ userAgent: 'fixture', codexHome: '/tmp', platformFamily: 'linux', platformOs: 'linux' });
      } else if (request.method === 'thread/start') {
        respond({ thread: { id: 'thread-transport' } });
      } else if (request.method === 'turn/start') {
        respond({ turn: { id: 'turn-transport' } });
      }
    }
    emit(chunk) { for (const listener of this.listeners) listener(chunk); }
    pause() { this.paused = true; }
    resume() {
      this.paused = false;
      if (this.exitInfo) queueMicrotask(() => this.deliverExit());
    }
    notifyExit(info) { this.exitInfo = info; this.deliverExit(); }
    deliverExit() {
      if (!this.exitInfo || this.paused) return;
      for (const listener of this.listeners) listener(null, this.exitInfo);
    }
    close() {}
  }

  const transport = new ProcessLikeTransport();
  const adapter = new CodexAdapter({ transport, codexVersion: CODEX_CLI_VERSION, retryDelayMs: 0 });
  t.after(() => { adapter.close(); transport.close(); });

  const gate = deferred();
  const events = [];
  let closedWhenCompletionArrived = null;
  adapter.onEvent(event => {
    events.push(event.type);
    if (event.type === 'assistant_text_delta') return gate.promise;
    if (event.type === 'turn_completed') closedWhenCompletionArrived = adapter.closed;
    return undefined;
  });

  await adapter.initialize();
  const { threadId } = await adapter.startThread({ cwd: process.cwd() });
  await adapter.sendTurn({ threadId, text: 'fixture' });
  const lines = [
    { method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-transport', itemId: 'message-1', delta: 'held' } },
    { method: 'turn/completed', params: { threadId, turn: { id: 'turn-transport', status: 'completed' } } }
  ].map(JSON.stringify).join('\n') + '\n';
  transport.emit(lines);
  transport.notifyExit({ code: 7, signal: null, error: null, stderr: 'fixture exit' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['assistant_text_delta'], 'the held first line must stop the coalesced second line');
  assert.equal(adapter.closed, null, 'child exit must remain held with the unread line');

  gate.resolve();
  const deadline = Date.now() + 2_000;
  while (events.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(events.slice(0, 2), ['assistant_text_delta', 'turn_completed'],
    'the buffered completion must be delivered before the child exit');
  assert.equal(closedWhenCompletionArrived, null,
    'completion must be observed while the adapter is still open');
  while (!adapter.closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(adapter.closed?.code, 'CODEX_APP_SERVER_EXITED',
    'the held exit is delivered only after buffered protocol lines drain');
});

test('ACP process-like transport drains coalesced updates before a held child exit', async t => {
  class ProcessLikeTransport {
    constructor() {
      this.listeners = new Set();
      this.paused = false;
      this.exitInfo = null;
      this.prompt = null;
    }
    onData(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    write(line) {
      const request = JSON.parse(line);
      const respond = result => queueMicrotask(() => this.emit(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`));
      if (request.method === 'initialize') {
        respond({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
      } else if (request.method === 'session/new') {
        respond({ sessionId: 'session-transport' });
      } else if (request.method === 'session/prompt') {
        this.prompt = request;
      }
    }
    emit(chunk) { for (const listener of this.listeners) listener(chunk); }
    pause() { this.paused = true; }
    resume() {
      this.paused = false;
      if (this.exitInfo) queueMicrotask(() => this.deliverExit());
    }
    notifyExit(info) { this.exitInfo = info; this.deliverExit(); }
    deliverExit() {
      if (!this.exitInfo || this.paused) return;
      for (const listener of this.listeners) listener(null, this.exitInfo);
    }
    close() {}
  }

  const transport = new ProcessLikeTransport();
  const adapter = new AcpAdapter({ transport, defaultCwd: process.cwd(), mcpServers: [] });
  t.after(() => { adapter.close(); transport.close(); });

  const gate = deferred();
  const events = [];
  adapter.onEvent(event => {
    events.push(event.type);
    if (event.type === 'assistant_text_delta') return gate.promise;
    return undefined;
  });

  await adapter.initialize();
  const { threadId } = await adapter.startThread({ cwd: process.cwd() });
  const turn = adapter.sendTurn({ threadId, text: 'fixture' });
  turn.catch(() => {});
  const lines = [
    { jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: threadId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'held' } }
    } },
    { jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: threadId,
      update: { sessionUpdate: 'tool_call', toolCallId: 'tool-2', title: 'fixture', status: 'completed' }
    } }
  ].map(JSON.stringify).join('\n') + '\n';
  transport.emit(lines);
  transport.notifyExit({ code: 7, signal: null, error: null, stderr: 'fixture exit' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['assistant_text_delta'], 'the held first update must stop the coalesced second update');
  assert.equal(adapter.closed, null, 'child exit must remain held with the unread update');

  gate.resolve();
  const deadline = Date.now() + 2_000;
  while (events.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(events.slice(0, 3), ['assistant_text_delta', 'tool_call', 'tool_result'],
    'the buffered update must be delivered before the child exit');
  while (!adapter.closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(adapter.closed?.code, 'ACP_PROCESS_EXITED',
    'the held exit is delivered only after buffered ACP updates drain');
});

test('event boundary wait covers every queued event, not only the first held event', async () => {
  const events = [];
  const firstGate = deferred();
  const secondGate = deferred();
  const boundary = createEventBackpressure({
    listeners: [event => {
      events.push(event);
      if (event === 'first') return firstGate.promise;
      if (event === 'second') return secondGate.promise;
      return undefined;
    }]
  });

  const all = boundary.emit('first');
  boundary.emit('second');
  boundary.emit('third');
  assert.equal(boundary.wait(), all);
  firstGate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['first', 'second']);
  let settled = false;
  all.finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  secondGate.resolve();
  await all;
  assert.deepEqual(events, ['first', 'second', 'third']);
});

test('event boundary close drains queued accepted events instead of discarding them', async () => {
  const events = [];
  const gate = deferred();
  const boundary = createEventBackpressure({
    listeners: [event => {
      events.push(event);
      if (event === 'first') return gate.promise;
      return undefined;
    }]
  });

  boundary.emit('first');
  boundary.emit('queued');
  const closing = boundary.close();
  assert.equal(typeof closing?.then, 'function');
  assert.deepEqual(events, ['first']);
  gate.resolve();
  await closing;
  assert.deepEqual(events, ['first', 'queued']);
  assert.equal(boundary.emit('after-close'), undefined);
});

test('event boundary drains accepted events before a re-entrant resume callback', async () => {
  const events = [];
  const gate = deferred();
  let boundary;
  boundary = createEventBackpressure({
    listeners: [event => {
      events.push(event);
      if (event === 'first') return gate.promise;
      return undefined;
    }],
    resume: () => {
      if (events.length === 2) boundary.emit('late');
    }
  });

  const first = boundary.emit('first');
  boundary.emit('second');
  gate.resolve();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['first', 'second', 'late']);
});

test('adapter delivery pauses its transport and preserves packet order until output settles', async () => {
  let handler;
  let pauseCalls = 0;
  let resumeCalls = 0;
  const transport = {
    send() {},
    onData(next) { handler = next; },
    close() {},
    pause() { pauseCalls += 1; },
    resume() { resumeCalls += 1; }
  };
  const adapter = new ClaudeCliAdapter({ transport });
  const gate = deferred();
  const packets = [];
  adapter.onEvent(event => {
    packets.push(event.turnId);
    if (event.turnId === 'turn-1') return gate.promise;
    return undefined;
  });
  handler = event => adapter.emit(event);

  const first = handler({ type: 'turn_accepted', threadId: 'thread-stream', turnId: 'turn-1' });
  handler({ type: 'turn_accepted', threadId: 'thread-stream', turnId: 'turn-2' });
  assert.deepEqual(packets, ['turn-1']);
  assert.equal(pauseCalls, 1);

  gate.resolve();
  await first;
  assert.deepEqual(packets, ['turn-1', 'turn-2']);
  assert.equal(resumeCalls, 1);
});

test('Codex, ACP, and Antigravity adapters all await host event listeners', async () => {
  const cases = [
    {
      name: 'Codex',
      make(transport) { return new CodexAdapter({ transport, codexVersion: CODEX_CLI_VERSION }); },
      emit(adapter, event) { return adapter._emit(event); }
    },
    {
      name: 'ACP',
      make(transport) { return new AcpAdapter({ transport }); },
      emit(adapter, event) { return adapter._emit(event); }
    },
    {
      name: 'Antigravity',
      make(transport) {
        return new AntigravityCliAdapter({ transport, model: 'fixture-model', tools: [] });
      },
      emit(adapter, event) { return adapter.emit(event); }
    }
  ];

  for (const entry of cases) {
    const transport = fakeTransport({ startup: entry.name === 'Antigravity' });
    const adapter = entry.make(transport);
    const gate = deferred();
    const seen = [];
    adapter.onEvent(event => {
      seen.push(event.turnId);
      if (event.turnId === `${entry.name}-1`) return gate.promise;
      return undefined;
    });
    const first = entry.emit(adapter, {
      type: 'turn_accepted', threadId: `${entry.name}-thread`, turnId: `${entry.name}-1`
    });
    entry.emit(adapter, {
      type: 'turn_accepted', threadId: `${entry.name}-thread`, turnId: `${entry.name}-2`
    });
    assert.equal(typeof first?.then, 'function', `${entry.name} did not return a durability boundary`);
    assert.deepEqual(seen, [`${entry.name}-1`]);
    assert.equal(transport.pauses, 1, `${entry.name} did not pause its transport`);
    gate.resolve();
    await first;
    assert.deepEqual(seen, [`${entry.name}-1`, `${entry.name}-2`]);
    assert.equal(transport.resumes, 1, `${entry.name} did not resume its transport`);
  }
});

test('adapter close waits for a retained event promise before closing the session', async () => {
  let pauseCalls = 0;
  let resumeCalls = 0;
  const transport = {
    send() {},
    onData() {},
    close() {},
    pause() { pauseCalls += 1; },
    resume() { resumeCalls += 1; }
  };
  const adapter = new ClaudeCliAdapter({ transport });
  const gate = deferred();
  adapter.onEvent(() => gate.promise);

  const boundary = adapter.emit({
    type: 'turn_accepted',
    threadId: 'thread-backpressure',
    turnId: 'turn-backpressure'
  });
  assert.equal(typeof boundary?.then, 'function');
  adapter.close();
  assert.equal(adapter.closed, false);
  assert.equal(pauseCalls, 1);

  gate.resolve();
  await boundary;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.closed, true);
  assert.equal(resumeCalls, 1);
});

test('adapter close terminates after a failed event boundary without re-entering wait', async () => {
  const transport = {
    send() {},
    onData() {},
    close() {},
    pause() {},
    resume() {}
  };
  const adapter = new ClaudeCliAdapter({ transport });
  const failure = new Error('durability refused');
  adapter.onEvent(() => Promise.reject(failure));
  const boundary = adapter.emit({
    type: 'turn_accepted', threadId: 'thread-failed-close', turnId: 'turn-failed-close'
  });
  await assert.rejects(boundary, error => error === failure);
  adapter.close();
  assert.equal(adapter.closed, true, 'a failed boundary must allow explicit adapter close');
  adapter.close();
  assert.equal(adapter.closed, true, 'repeated close must remain terminal after refusal');
});
