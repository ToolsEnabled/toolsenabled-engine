'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { appServerRequest, probeAccount } = require('../../src/lib/multi-account/health');
const tick = () => new Promise(resolve => setImmediate(resolve));
const account = { account: { type: 'chatgpt', email: 'fixturé@example.invalid', planType: 'plus' } };
const limits = { rateLimits: { primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 2000000000 } } };

function peer({ autoClose = true, answer = true, receipt = { type: 'terminated', activeProcesses: 0 } } = {}) {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const requests = [], started = Promise.withResolvers();
  let options, kills = 0, closed = false;
  const close = () => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', 0, null); };
  const send = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  child.stdin = new Writable({ write(chunk, encoding, done) {
    const request = JSON.parse(String(chunk)); requests.push(request);
    queueMicrotask(() => {
      if (answer) send({ id: request.id, result: request.id === 1 ? {} : request.id === 2 ? account : limits });
      started.resolve();
    });
    done();
  } });
  child.kill = () => { kills++; if (autoClose) close(); };
  child.terminateJob = async () => { kills++; if (autoClose) close(); return receipt; };
  return { child, close, send, requests, started: started.promise,
    get kills() { return kills; }, get options() { return options; },
    spawnImpl(command, args, opts) { options = opts; return child; } };
}
const run = (fixture, options = {}) => appServerRequest({ command: 'offline-quota-fixture', env: {},
  timeoutMs: 100, spawnImpl: fixture.spawnImpl, ...options });

test('Codex replies remain pending until owned tree and pipes actually close', async () => {
  const fixture = peer({ autoClose: false });
  let settled = false;
  const pending = run(fixture).finally(() => { settled = true; });
  try {
    await fixture.started; await tick();
    assert.equal(settled, false, 'reply alone must not release the next account read');
    assert.equal(fixture.options.containProcessTree, true);
  } finally { fixture.close(); }
  const result = await pending;
  assert.equal(result.probeLifecycle, 'closed');
  assert.equal(Object.getOwnPropertyDescriptor(result, 'probeLifecycle').enumerable, false);
  assert.equal(JSON.stringify(result).includes('probeLifecycle'), false);
  assert.deepEqual(result.accountRead, account); assert.deepEqual(result.rateLimitsResult, limits);
  assert.equal(result.transportError, null);
  assert.deepEqual(fixture.requests.map(x => [x.method, x.params]), [
    ['initialize', { clientInfo: { name: 'toolsenabled-account-switch', title: 'ToolsEnabled account switch', version: '1.0.0' } }],
    ['account/read', {}], ['account/rateLimits/read', {}]
  ]);
});

test('unknown numeric reply IDs and duplicate initialize cannot grow state or duplicate requests', async () => {
  const fixture = peer({ answer: false });
  const pending = run(fixture);
  await fixture.started;
  fixture.send({ id: 700, result: limits });
  fixture.send({ id: 1, result: {} }); fixture.send({ id: 1, result: {} });
  fixture.send({ id: 2, result: account }); fixture.send({ id: 3, result: limits });
  const result = await pending;
  assert.deepEqual(fixture.requests.map(x => x.id), [1, 2, 3]);
  assert.deepEqual(result.rateLimitsResult, limits);
});

for (const stream of ['stdout', 'stderr']) test(`Codex caps ${stream} bytes even without a newline`, async () => {
  const fixture = peer({ answer: false });
  const pending = run(fixture);
  await fixture.started;
  fixture.child[stream].write(Buffer.alloc(131073, 65));
  const result = await pending;
  assert.equal(result.transportError, 'CODEX_ACCOUNT_OUTPUT_LIMIT');
  assert.equal(result.rateLimitsResult, null);
  assert.equal(fixture.kills, 1);
});

test('Codex decodes UTF-8 across stream chunks without corrupting account identity', async () => {
  const fixture = peer({ answer: false }); const pending = run(fixture);
  await fixture.started; fixture.send({ id: 1, result: {} });
  const bytes = Buffer.from(`${JSON.stringify({ id: 2, result: account })}\n`);
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  fixture.child.stdout.write(bytes.subarray(0, split)); fixture.child.stdout.write(bytes.subarray(split));
  fixture.send({ id: 3, result: limits });
  assert.deepEqual((await pending).accountRead, account);
});

test('Codex output cap counts combined UTF-8 bytes rather than characters or individual streams', async () => {
  const fixture = peer({ answer: false }); const pending = run(fixture);
  await fixture.started;
  fixture.child.stdout.write('é'.repeat(40000));
  fixture.child.stderr.write('x'.repeat(52000));
  assert.equal((await pending).transportError, 'CODEX_ACCOUNT_OUTPUT_LIMIT');
});

test('Codex stream failure is unavailable after cleanup rather than an unhandled error', async () => {
  const fixture = peer({ answer: false }); const pending = run(fixture);
  await fixture.started;
  fixture.child.stdout.emit('error', Object.assign(new Error('fixture pipe failure'), { code: 'EPIPE' }));
  const result = await pending;
  assert.equal(result.transportError, 'EPIPE');
  assert.equal(result.rateLimitsResult, null);
  assert.equal(fixture.kills, 1);
});

test('Codex pre-aborted read does not start a provider child', async () => {
  const controller = new AbortController(); controller.abort(); let starts = 0;
  const result = await appServerRequest({ command: 'offline-quota-fixture', env: {}, signal: controller.signal,
    spawnImpl() { starts++; throw Error('must not start'); } });
  assert.equal(starts, 0); assert.equal(result.transportError, 'ABORT_ERR');
  assert.equal(result.probeLifecycle, undefined);
});

for (const trigger of ['timeout', 'abort']) test(`Codex ${trigger} waits for closure before returning`, async () => {
  const fixture = peer({ answer: false, autoClose: false }); const controller = new AbortController();
  let settled = false;
  const pending = run(fixture, { signal: controller.signal, timeoutMs: 20 }).finally(() => { settled = true; });
  try {
    await fixture.started;
    if (trigger === 'abort') controller.abort();
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(settled, false);
  } finally { fixture.close(); }
  const result = await pending;
  assert.equal(result.transportError, trigger === 'abort' ? 'ABORT_ERR' : 'timed out after 20ms');
  assert.equal(result.rateLimitsResult, null);
  assert.equal(result.probeLifecycle, trigger === 'abort' ? undefined : 'closed');
});

test('a caught spawn error cannot manufacture a never-started process receipt', async () => {
  const result = await appServerRequest({ command: 'offline-quota-fixture', env: {},
    spawnImpl() { throw Object.assign(new Error('fixture spawn failure'), { code: 'ENOENT' }); } });
  assert.equal(result.transportError, 'ENOENT');
  assert.equal(result.probeLifecycle, undefined);
});

test('the canonical Codex account classifier preserves its ephemeral owned closure receipt', async () => {
  const fixture = peer();
  const result = await probeAccount({ name: 'synthetic', provider: 'codex', profileDir: 'fictional' }, {
    environmentFor: () => ({}), executable: { command: 'offline-quota-fixture' },
    exhaustedAtPercent: 95, timeoutMs: 100, spawnImpl: fixture.spawnImpl
  });
  assert.equal(result.status, 'healthy');
  assert.equal(result.usedPercent, 37);
  assert.equal(result.probeLifecycle, 'closed');
  assert.equal(JSON.stringify(result).includes('probeLifecycle'), false);
});

test('Codex refuses a valid quota result if descendants are not proven closed', async () => {
  const fixture = peer({ receipt: { type: 'terminated', activeProcesses: 1 } });
  await assert.rejects(run(fixture), error => error.code === 'CODEX_PROCESS_CLEANUP_UNPROVEN'
    && typeof error.retryCleanup === 'function');
});
