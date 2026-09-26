'use strict';

// Exercise the actual measurement code with a controlled child transport and
// clock. No MCP child or provider is launched, and the valid wire response is
// produced by the real server's initialize handler rather than a test parser.
require('./lib/isolated-environment').activate('cold-start-response');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { processMessage } = require('../src/mcp-server');

const target = path.resolve(__dirname, '../tools/cold-start-check.js');
const source = fs.readFileSync(target, 'utf8');
const targetRequire = createRequire(target);

function measurement({ main = false } = {}) {
  let now = 10_000;
  let output = '';
  const children = [];
  const timers = new Set();
  const module = { exports: {} };
  const processView = {
    execPath: process.execPath, env: {},
    stdout: { write(value) { output += value; } },
    stderr: { write(value) { output += value; } }
  };
  const childProcess = {
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.written = '';
      child.kills = [];
      child.stdin = { write(value) { child.written += value; } };
      child.kill = signal => { child.kills.push(signal); return true; };
      child.launch = { command, args, options };
      children.push(child);
      return child;
    }
  };
  const requireView = name => name === 'node:child_process' ? childProcess : targetRequire(name);
  requireView.main = main ? module : undefined;
  vm.runInNewContext(source, {
    module, exports: module.exports, require: requireView,
    __dirname: path.dirname(target), process: processView,
    Date: { now: () => now },
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); }
  }, { filename: target });
  return {
    exports: module.exports, children, timers, processView,
    get output() { return output; },
    at(elapsed, bytes, child = children.at(-1)) {
      now = 10_000 + elapsed;
      child.stdout.emit('data', Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    },
    timeout() {
      assert.equal(timers.size, 1);
      const [timer] = timers;
      assert.equal(timer.delay, 60_000, 'the hard timeout must remain bounded');
      timer.callback();
    }
  };
}

function start() {
  const run = measurement();
  let outcome;
  const done = run.exports.measureOnce().then(value => { outcome = value; return value; });
  return { run, done, get outcome() { return outcome; } };
}

async function responseFor(child) {
  assert.ok(child.written.endsWith('\n'), 'initialize is a complete stdio frame');
  const request = JSON.parse(child.written);
  assert.equal(request.jsonrpc, '2.0');
  assert.equal(request.method, 'initialize');
  assert.equal(request.id, 1);
  const replies = [];
  await processMessage(request, reply => replies.push(reply));
  assert.equal(replies.length, 1);
  const reply = replies[0];
  assert.equal(reply.result.protocolVersion, request.params.protocolVersion);
  assert.deepEqual(reply.result.capabilities, { tools: { listChanged: false } });
  assert.equal(reply.result.serverInfo.name, 'toolsenabled');
  assert.equal(reply.result.serverInfo.version, require('../package.json').version);
  return reply;
}

function assertClosed(run, child = run.children.at(-1)) {
  // This gate requests termination; it does not yet attest close/descendants.
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.equal(run.timers.size, 0);
}

test('a complete real initialize response produces the measured elapsed time', async () => {
  const { run, done } = start();
  const child = run.children[0];
  assert.equal(child.launch.command, process.execPath);
  assert.equal(child.launch.args.length, 1);
  assert.equal(child.launch.args[0], run.exports.TARGET_SCRIPT);
  assert.equal(child.launch.options.cwd, path.resolve(__dirname, '..'));
  run.at(812, JSON.stringify(await responseFor(child)) + '\n');
  const outcome = await done;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ms, 812);
  assertClosed(run);
});

test('fragmented JSON waits for the complete newline-delimited reply', async () => {
  const subject = start();
  const { run, done } = subject;
  const wire = JSON.stringify(await responseFor(run.children[0]));
  const split = wire.indexOf('"result"') + '"result"'.length;
  run.at(100, wire.slice(0, split));
  await Promise.resolve();
  assert.equal(subject.outcome, undefined, 'a result key is not an initialize response');
  run.at(250, wire.slice(split));
  await Promise.resolve();
  assert.equal(subject.outcome, undefined, 'stdio framing needs the terminating newline');
  run.at(901, '\n');
  const outcome = await done;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ms, 901);
  assertClosed(run);
});

for (const [name, frame] of [
  ['another request ID', reply => ({ ...reply, id: 2 })],
  ['a string ID rather than the numeric request ID', reply => ({ ...reply, id: '1' })],
  ['a notification containing a result key', () => ({ jsonrpc: '2.0', method: 'notifications/message', params: { result: 'still starting' } })],
  ['a notification with a forged request ID', reply => ({ ...reply, method: 'notifications/message' })],
  ['the wrong JSON-RPC version', reply => ({ ...reply, jsonrpc: '1.0' })],
  ['a JSON-RPC batch instead of a response', reply => [reply]]
]) {
  test(`${name} does not satisfy initialize or advance its measured completion`, async () => {
    const subject = start();
    const { run, done } = subject;
    const reply = await responseFor(run.children[0]);
    run.at(50, JSON.stringify(frame(reply)) + '\n');
    await Promise.resolve();
    assert.equal(subject.outcome, undefined);
    run.at(2_701, JSON.stringify(reply) + '\n');
    const outcome = await done;
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ms, 2_701, 'an unrelated early frame must not hide a slow initialize');
    assertClosed(run);
  });
}

for (const [name, frame] of [
  ['malformed JSON containing a result key', () => '{"jsonrpc":"2.0","id":1,"result":}\n'],
  ['a complete JSON value without a terminating newline', reply => JSON.stringify(reply)],
  ['a truncated JSON result', () => '{"jsonrpc":"2.0","id":1,"result":']
]) {
  test(`${name} cannot produce a measurement`, async () => {
    const subject = start();
    const { run, done } = subject;
    run.at(100, frame(await responseFor(run.children[0])));
    await Promise.resolve();
    assert.equal(subject.outcome, undefined);
    run.timeout();
    const outcome = await done;
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /hard timeout/);
    assertClosed(run);
  });
}

for (const [name, result] of [
  ['empty result', () => ({})],
  ['non-object result', () => 42],
  ['wrong negotiated protocol', reply => ({ ...reply.result, protocolVersion: 'wrong' })],
  ['missing server information', reply => ({ ...reply.result, serverInfo: undefined })],
  ['missing server version', reply => ({ ...reply.result, serverInfo: { name: 'toolsenabled' } })],
  ['another server identity', reply => ({ ...reply.result, serverInfo: { ...reply.result.serverInfo, name: 'another-server' } })],
  ['non-object capabilities', reply => ({ ...reply.result, capabilities: [] })]
]) {
  test(`${name} is a refusal rather than a successful startup measurement`, async () => {
    const { run, done } = start();
    const reply = await responseFor(run.children[0]);
    run.at(100, JSON.stringify({ ...reply, result: result(reply) }) + '\n');
    const outcome = await done;
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /invalid initialize result/);
    assertClosed(run);
  });
}

test('a matching error reply fails promptly, including an invalid reply carrying result too', async () => {
  for (const includeResult of [false, true]) {
    const { run, done } = start();
    const reply = await responseFor(run.children[0]);
    const request = JSON.parse(run.children[0].written);
    delete request.params.protocolVersion;
    const errors = [];
    await processMessage(request, value => errors.push(value));
    assert.equal(errors.length, 1);
    const errorReply = errors[0];
    assert.equal(errorReply.id, reply.id);
    assert.equal(errorReply.error.code, -32602);
    if (includeResult) errorReply.result = reply.result;
    run.at(111, JSON.stringify(errorReply) + '\n');
    // A failure must settle on receipt, without waiting for the hard timeout.
    let settled;
    done.then(value => { settled = value; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled?.ok, false);
    const outcome = await done;
    assert.match(outcome.reason, /initialize failed/);
    assertClosed(run);
  }
});

test('malformed and unrelated lines in the same chunk cannot hide a later valid reply', async () => {
  const { run, done } = start();
  const reply = await responseFor(run.children[0]);
  run.at(997, '{"result":}\n' + JSON.stringify({ ...reply, id: 3 }) + '\r\n' + JSON.stringify(reply) + '\r\n');
  assert.equal((await done).ms, 997);
  assertClosed(run);
});

test('spawn failure and exit before answering remain failed measurements', async () => {
  for (const event of ['error', 'exit']) {
    const { run, done } = start();
    if (event === 'error') run.children[0].emit('error', new Error('fixture spawn refusal'));
    else run.children[0].emit('exit', 7, null);
    const outcome = await done;
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, event === 'error' ? /could not spawn/ : /exited before answering/);
    assertClosed(run);
  }
});

test('the actual CLI preserves three attempts and the 2500ms worst-attempt boundary', async () => {
  for (const slowest of [2_500, 2_501]) {
    const run = measurement({ main: true });
    assert.equal(run.exports.CEILING_MS, 2_500);
    assert.equal(run.exports.ATTEMPTS, 3);
    let elapsed = 0;
    for (const duration of [800, slowest, 900]) {
      const child = run.children.at(-1);
      const wire = JSON.stringify(await responseFor(child)) + '\n';
      elapsed += duration;
      run.at(elapsed, wire, child);
      await Promise.resolve();
      assert.deepEqual(child.kills, ['SIGKILL']);
    }
    await Promise.resolve();
    assert.equal(run.children.length, 3);
    assert.equal(run.timers.size, 0);
    assert.equal(run.processView.exitCode || 0, slowest === 2_500 ? 0 : 1);
    assert.match(run.output, slowest === 2_500 ? /PASS: cold start/ : /FAIL: cold start exceeds/);
  }
});
