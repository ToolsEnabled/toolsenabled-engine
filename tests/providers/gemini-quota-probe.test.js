'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const path = require('node:path');
const os = require('node:os');
const { probeGeminiQuota, workerEnvironment } = require('../../src/lib/providers/gemini-quota-probe');
const { PROTOCOL } = require('../../src/lib/providers/gemini-quota-protocol');
function peer() {
  const child = new EventEmitter(); child.pid = 123;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const started = Promise.withResolvers();
  let request, closed = false;
  child.stdin = new Writable({ write(chunk, encoding, done) { request = JSON.parse(String(chunk)); done(); started.resolve(); } });
  const close = (code = 0) => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', code); };
  child.terminateJob = async () => { close(); return { type: 'terminated', activeProcesses: 0 }; };
  const send = (extra = {}) => child.stdout.write(`${PROTOCOL}\t${JSON.stringify({ version: 1, id: request.id,
    status: 'observed', email: 'fixture@example.invalid', observedAt: '2026-09-14T18:00:00.000Z',
    quota: { buckets: [{ modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', remainingFraction: 0.421875 }] }, ...extra })}\n`);
  return { child, started: started.promise, close, send, spawnImpl: () => child };
}
const run = (fixture, options = {}) => probeGeminiQuota({ home: path.join(os.tmpdir(), 'synthetic-gemini-home'),
  baseEnvironment: {}, timeoutMs: 300, spawnImpl: fixture.spawnImpl, ...options });
test('a valid frame cannot release quota before successful natural worker closure', async () => {
  const fixture = peer(); let resolved = false;
  const pending = run(fixture).then(value => { resolved = true; return value; });
  await fixture.started; fixture.send(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  fixture.close(); const answer = await pending;
  assert.equal(answer.status, 'observed');
  assert.equal(answer.allowanceBuckets.buckets[0].remainingFraction, 0.421875);
  assert.equal(answer.probeLifecycle, 'closed');
  assert.equal(Object.getOwnPropertyDescriptor(answer, 'probeLifecycle').enumerable, false);
});
for (const mode of ['duplicate', 'noise', 'tail', 'wrong-id', 'stdout-overflow', 'stderr-overflow', 'exit-failure']) {
  test(`Gemini ${mode} withholds any measurement after confirmed cleanup`, async () => {
    const fixture = peer(); const pending = run(fixture);
    await fixture.started;
    if (mode === 'wrong-id') fixture.send({ id: 'not-the-request' });
    else if (mode === 'noise') fixture.child.stdout.write('Loaded cached credentials.\n');
    else if (mode === 'stdout-overflow') fixture.child.stdout.write('x'.repeat(131073));
    else if (mode === 'stderr-overflow') fixture.child.stderr.write('x'.repeat(131073));
    else { fixture.send(); if (mode === 'duplicate') fixture.send(); if (mode === 'tail') fixture.child.stdout.write('trailing'); }
    fixture.close(mode === 'exit-failure' ? 1 : 0);
    const answer = await pending;
    assert.equal(answer.status, 'unavailable');
    assert.equal(answer.allowanceBuckets, undefined);
    assert.equal(answer.probeLifecycle, 'closed');
    assert.equal(answer.code, mode.endsWith('overflow') ? 'GEMINI_USAGE_OUTPUT_LIMIT'
      : mode === 'exit-failure' ? 'GEMINI_WORKER_EXIT_FAILED' : 'GEMINI_USAGE_MALFORMED');
  });
}
test('cancellation and timeout close the worker without making a quota or auth verdict', async () => {
  for (const mode of ['cancel', 'timeout']) {
    const fixture = peer(), controller = new AbortController();
    const pending = run(fixture, { signal: controller.signal, timeoutMs: 20 });
    await fixture.started; if (mode === 'cancel') controller.abort();
    const answer = await pending;
    assert.equal(answer.status, 'unavailable');
    assert.equal(answer.code, mode === 'cancel' ? 'GEMINI_USAGE_CANCELLED' : 'GEMINI_USAGE_TIMEOUT');
    assert.equal(answer.probeLifecycle, mode === 'cancel' ? undefined : 'closed');
  }
});
test('ambient auth mode is refused before spawn and child environment carries only its registered home', async () => {
  let starts = 0;
  const answer = await probeGeminiQuota({ home: os.tmpdir(), baseEnvironment: { GOOGLE_APPLICATION_CREDENTIALS: 'synthetic-not-read' },
    spawnImpl() { starts += 1; throw Error('must not spawn'); } });
  assert.equal(answer.code, 'GEMINI_AUTH_MODE_UNSUPPORTED'); assert.equal(starts, 0);
  const env = workerEnvironment({ NODE_OPTIONS: 'synthetic-no-exec', NODE_PATH: 'synthetic', GEMINI_API_KEY: 'synthetic', PATH: 'fixture-path' }, 'home', 'cwd');
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.NODE_PATH, undefined); assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GEMINI_CLI_HOME, 'home'); assert.equal(env.HOME, 'home'); assert.equal(env.TEMP, 'cwd');
});
