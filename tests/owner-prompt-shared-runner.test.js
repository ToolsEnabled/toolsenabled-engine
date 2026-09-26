'use strict';
const isolated = require('./lib/isolated-environment').activate('owner-prompt-shared-runner');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const queue = require('../src/lib/providers/owner-prompt-queue');
const context = { purpose: 'Verify local owner input', scope: 'Isolated test only', lifetime: 'Until test ends' };
function fixture(name) {
  const file = path.join(isolated.root, name, 'queue.json');
  const options = { queueFile: file, spawn: () => ({ pid: 1234, unref() {} }) };
  const add = key => queue.enqueue({ kind: 'credential', vaultKey: 'custom.' + key, label: 'Fixture credential', requestContext: context, requester: 'codex' }, options);
  return { file, add, options };
}
test('Linux reaches the native runner boundary instead of refusing its supported vault platform', () => {
  const cp = require('node:child_process');
  const script = `require(${JSON.stringify(path.join(__dirname, 'lib/isolated-environment'))}).activate('credential-linux-red');
    const cp=require('node:child_process'); cp.spawn=()=>{throw Error('synthetic native boundary')};
    const q=require(${JSON.stringify(require.resolve('../src/lib/providers/owner-prompt-queue'))});
    const r=q.enqueue(${JSON.stringify({ kind: 'credential', vaultKey: 'custom.fixture', label: 'Fixture credential', requestContext: context, requester: 'codex' })});
    console.log(JSON.stringify({code:r.launchFailure,queued:q.readQueue().items[0].status}));`;
  const result = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, DISPLAY: ':fixture', WAYLAND_DISPLAY: '' } });
  assert.equal(result.status, 0);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.queued, 'queued');
  assert.equal(answer.code, 'OWNER_PROMPT_RUNNER_UNAVAILABLE');
});
test('the shared launcher supplies the shipped script first and enables Node mode for Electron', () => {
  const native = require('../src/lib/owner-prompt-platform');
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  try {
    Object.defineProperty(process.versions, 'electron', { value: '43.0.0', configurable: true });
    for (const platform of ['linux', 'win32']) {
      const spec = native.launchSpec('/fixture/owner-prompt-runner.js', '/fixture/queue.json', {
        platform, node: '/fixture/runtime', environment: { SystemRoot: 'D:\\Windows', NODE_OPTIONS: '--inspect', PYTHONPATH: '/bad' }
      });
      assert.equal(spec.options.env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(spec.options.env.NODE_OPTIONS, undefined);
      assert.equal(spec.options.env.PYTHONPATH, undefined);
      assert.deepEqual(platform === 'win32' ? spec.args.slice(2) : spec.args,
        ['/fixture/owner-prompt-runner.js', '--queue', '/fixture/queue.json']);
      if (platform === 'win32') assert.equal(spec.command, 'D:\\Windows\\System32\\conhost.exe');
    }
  } finally {
    if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor); else delete process.versions.electron;
  }
});
test('the shared drain requires Start and pauses after cancellation without opening the next item', async () => {
  const run = require('../src/lib/owner-prompt-runner').drain;
  const f = fixture('pause'), first = f.add('first'), second = f.add('second');
  let opened = 0;
  const ui = { supportedKinds: ['credential'], begin: () => false, capture: () => { opened++; return 'completed'; } };
  await run({ queueFile: f.file, ui, graceMs: 0 });
  assert.equal(opened, 0);
  assert.deepEqual(queue.readQueue(f.file).items.map(x => x.status), ['queued', 'queued']);
  ui.begin = () => true; ui.capture = item => { opened++; assert.equal(item.requestId, first.requestId); return 'cancelled'; };
  await run({ queueFile: f.file, ui, graceMs: 0 });
  assert.equal(opened, 1);
  assert.deepEqual(queue.readQueue(f.file).items.map(x => x.status), ['cancelled', 'queued']);
  assert.equal(queue.readQueue(f.file).items[1].requestId, second.requestId);
});
test('one shared flow completes Linux and Windows items, and timeout requeues without losing the id', async () => {
  const run = require('../src/lib/owner-prompt-runner').drain;
  for (const platform of ['linux', 'win32']) {
    const f = fixture(platform), first = f.add('first'), second = f.add('second');
    let count = 0;
    await run({ queueFile: f.file, graceMs: 0, ui: { supportedKinds: ['credential'], begin: () => true,
      capture: item => { count++; assert.equal(queue.readQueue(f.file).items.find(x => x.requestId === item.requestId).status, 'presenting'); return count === 1 ? 'completed' : 'timeout'; } } });
    const value = queue.readQueue(f.file);
    assert.deepEqual(value.items.map(x => x.status), ['completed', 'queued']);
    assert.equal(value.items[1].requestId, second.requestId);
    assert.deepEqual(value.events.map(x => x.type), ['queued', 'queued', 'presented', 'completed', 'presented', 'requeued_after_interruption']);
    assert.deepEqual(Object.keys(value.events.at(-1)).sort(), ['atMs', 'kind', 'requestId', 'sequence', 'status', 'type']);
    assert.equal(value.items[0].requestId, first.requestId);
  }
});
test('cancellation during Start is respected by the atomic claim, and invalid native output fails closed', async () => {
  const run = require('../src/lib/owner-prompt-runner').drain;
  const f = fixture('start-race'), first = f.add('first'); let opened = 0;
  await run({ queueFile: f.file, graceMs: 0, ui: { supportedKinds: ['credential'],
    begin: () => { queue.cancel({ requestId: first.requestId }, f.options); return true; }, capture: () => { opened++; } } });
  assert.equal(opened, 0);
  f.add('next');
  await run({ queueFile: f.file, graceMs: 0, ui: { supportedKinds: ['credential'], begin: () => true, capture: () => ({ value: 'forbidden-output' }) } });
  assert.equal(queue.readQueue(f.file).items.at(-1).status, 'failed');
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('forbidden-output'), false);
});
test('a completed Save survives queue contention without repeating the native form', async () => {
  const run = require('../src/lib/owner-prompt-runner').drain;
  const f = fixture('settle-contention'); f.add('first'); let saves = 0;
  await run({ queueFile: f.file, graceMs: 0, ui: { supportedKinds: ['credential'], begin: () => true,
    capture() {
      saves++;
      fs.writeFileSync(f.file + '.lock', '', { flag: 'wx', mode: 0o600 });
      setTimeout(() => fs.unlinkSync(f.file + '.lock'), 100);
      return 'completed';
    } } });
  assert.equal(saves, 1);
  assert.equal(queue.readQueue(f.file).items[0].status, 'completed');
  assert.deepEqual(queue.readQueue(f.file).events.map(x => x.type), ['queued', 'presented', 'completed']);
});
test('a busy native vault form requeues this request without claiming the owner cancelled it', async () => {
  const run = require('../src/lib/owner-prompt-runner').drain;
  const f = fixture('deferred'); const request = f.add('first'); let calls = 0;
  await run({ queueFile: f.file, graceMs: 0, ui: { supportedKinds: ['credential'], begin: () => true,
    capture() { calls++; return 'deferred'; } } });
  assert.equal(calls, 1);
  const state = queue.readQueue(f.file);
  assert.equal(state.items[0].requestId, request.requestId);
  assert.equal(state.items[0].status, 'queued');
  assert.equal(Object.hasOwn(state.items[0], 'completedAtMs'), false);
  assert.deepEqual(state.events.map(event => event.type), ['queued', 'presented', 'requeued_after_interruption']);
});
