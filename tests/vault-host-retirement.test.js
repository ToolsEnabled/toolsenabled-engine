'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const test = require('node:test');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(platform, mode) {
  const file = path.join(root, 'src/lib/vault-host', platform === 'linux' ? 'linux-worker.js' : 'worker.js');
  const parent = new EventEmitter(), processEvents = new EventEmitter();
  const children = [], effects = [];
  const fakeProcess = Object.assign(processEvents, { env: {} });
  function spawn() {
    const number = children.length + 1;
    const child = Object.assign(new EventEmitter(), { pid: 90000 + number, exitCode: null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(), alive: true });
    child.kill = signal => { effects.push({ event: 'termination-request', child: number, signal: signal || null }); return false; };
    child.stdin = new Writable({ write(bytes, encoding, done) {
      const request = JSON.parse(bytes.toString());
      effects.push({ event: 'dispatch', child: number });
      queueMicrotask(() => {
        if (mode === 'protocol-refusal') child.stdout.write('invalid-frame\n');
        else if (platform === 'linux') child.stdout.write(JSON.stringify({ id: request.id, status: 0, stdout: '{"ok":true,"result":true}' }) + '\n');
        else child.stdout.write(JSON.stringify({ id: request.id, ok: true, outputBase64: Buffer.from('synthetic').toString('base64') }) + '\n');
      });
      done();
    } });
    child.closeFixture = () => {
      if (!child.alive) return;
      child.alive = false; child.exitCode = 0;
      child.stdout.end(); child.stderr.end();
      child.emit('exit', 0, null); child.emit('close', 0, null);
    };
    children.push(child);
    queueMicrotask(() => child.stderr.write(platform === 'linux' ? 'linux-vault-host-ready\n' : 'vault-host-ready\n'));
    return child;
  }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    __dirname: path.dirname(file), process: fakeProcess, Buffer, setTimeout, clearTimeout, Atomics,
    require(name) {
      if (name === 'node:worker_threads') return { parentPort: parent };
      if (name === 'node:child_process') return { spawn };
      if (name === 'node:path') return path;
      if (name === 'node:readline') return require(name);
      if (name === '../runtime-state-root') return { programOrStatePath: (base, parts) => path.join(base, ...parts) };
      if (name === '../supervision/launch-environment') return { safeLaunchEnvironment: env => env };
      throw new Error('Unexpected dependency ' + name);
    },
  }, { filename: file });
  function request(env, close = false) {
    return new Promise(resolve => {
      const port = { postMessage: value => resolve(structuredClone(value)), close() {} };
      if (platform === 'linux' && close) parent.emit('message', { close: true, port });
      else parent.emit('message', { port, sab: new Int32Array(new SharedArrayBuffer(4)), env,
        payload: { action: close ? '__shutdown' : platform === 'linux' ? 'status' : 'get', key: 'synthetic' } });
    });
  }
  return { request, children, effects, close: () => children.forEach(child => child.closeFixture()) };
}


for (const platform of ['linux', 'win32']) {
  test(`${platform}: rebind waits for the retired helper to close before dispatching the successor`, async () => {
    const f = fixture(platform, 'normal');
    try {
      await f.request({ FIXTURE_BINDING: 'A' });
      let settled = false;
      const second = f.request({ FIXTURE_BINDING: 'B' }).then(value => { settled = true; return value; });
      await tick(); await tick();
      assert.equal(settled, false, 'a kill request alone cannot release the old binding');
      assert.equal(f.children.length, 1, 'no successor process may start while old custody is unproven');
      f.children[0].closeFixture();
      const result = await second;
      assert.equal(result.unavailable, undefined);
      assert.equal(f.children.length, 2);
      assert.equal(f.children[0].alive, false);
      assert.deepEqual(f.effects.filter(item => item.event === 'dispatch').map(item => item.child), [1, 2]);
    } finally { f.close(); }
  });

  test(`${platform}: shutdown includes a protocol-failed helper already removed from the active slot`, async () => {
    const f = fixture(platform, 'protocol-refusal');
    try {
      const failure = await f.request({ FIXTURE_BINDING: 'A' });
      assert.equal(failure.unavailable, true);
      assert.equal(failure.dispatched, true, 'lost delivery must remain uncertain and must not allow replay');
      let settled = false;
      const closing = f.request({}, true).then(value => { settled = true; return value; });
      await tick(); await tick();
      assert.equal(settled, false, 'retired is not closed while the helper has not emitted close');
      assert.equal(f.children[0].alive, true);
      f.children[0].closeFixture();
      const reply = await closing;
      assert.equal(reply.closed, true);
    } finally { f.close(); }
  });
}

function clientFixture(platform) {
  const file = path.join(root, 'src/lib', platform === 'linux' ? 'linux-vault-host-client.js' : 'vault-host-client.js');
  const workers = [];
  let closeConfirmed = true, terminations = 0;
  class Port extends EventEmitter {
    close() { queueMicrotask(() => this.emit('close')); }
  }
  class MessageChannel {
    constructor() { this.port1 = new Port(); this.port2 = new Port(); this.port2.peer = this.port1; }
  }
  class Worker extends EventEmitter {
    constructor() { super(); workers.push(this); }
    unref() {}
    postMessage(message) {
      const closing = message.close === true || message.payload?.action === '__shutdown';
      const reply = closing ? platform === 'linux' ? { closed: closeConfirmed } : { ok: true, closed: closeConfirmed }
        : platform === 'linux' ? { status: 0, stdout: '{"ok":true,"result":"synthetic"}' }
        : { ok: true, outputBase64: Buffer.from('synthetic').toString('base64') };
      const peer = message.port.peer;
      peer.reply = reply;
      queueMicrotask(() => peer.emit('message', reply));
    }
    async terminate() { terminations++; this.emit('exit', 1); }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    __dirname: path.dirname(file), module, process: { env: {} }, Buffer,
    setTimeout, clearTimeout, Atomics: { wait: () => 'ok' },
    require(name) {
      if (name === 'node:worker_threads') return { Worker, MessageChannel, receiveMessageOnPort: port => ({ message: port.reply }) };
      if (name === 'node:path') return path;
      if (name === 'node:fs') return fs;
      if (name === './providers/subscription-launch-env.js') return { safeLaunchEnvironment: () => ({}) };
      throw new Error('Unexpected dependency ' + name);
    },
  }, { filename: file });
  const client = module.exports;
  return { workers, setClose: value => { closeConfirmed = value; }, terminations: () => terminations,
    call: () => platform === 'linux' ? client.call({ action: 'status', file: '/synthetic-only' }, {}) : client.callVaultHost('get', { key: 'synthetic' }),
    close: () => platform === 'linux' ? client.close() : client.closeVaultHost() };
}

for (const platform of ['linux', 'win32']) {
  test(`${platform}: an unconfirmed close preserves the worker for a later confirmed cleanup`, async () => {
    const f = clientFixture(platform);
    f.call();
    f.setClose(false);
    await assert.rejects(f.close(), { code: 'VAULT_HOST_CLOSE_FAILED' });
    assert.equal(f.terminations(), 0, 'worker termination cannot replace missing helper-close proof');
    f.setClose(true);
    await f.close();
    assert.equal(f.terminations(), 1);
    await f.close();
    assert.equal(f.workers.length, 1, 'an already closed client must not spawn on close');
  });

  test(`${platform}: unexpected worker exit does not prove helper closure or admit a replacement`, async () => {
    const f = clientFixture(platform);
    f.call();
    f.workers[0].emit('exit', 1);
    await assert.rejects(f.close(), { code: 'VAULT_HOST_CLOSE_FAILED' });
    let result, error;
    try { result = f.call(); } catch (caught) { error = caught; }
    assert.equal(f.workers.length, 1, 'lost worker custody must not auto-start another helper');
    assert.ok(error || result?.cleanupUnproven, 'unknown custody must fail closed rather than permit a one-shot fallback');
    assert.equal(f.terminations(), 0);
  });
}
