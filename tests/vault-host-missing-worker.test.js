'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const clientPath = path.resolve(__dirname, '../src/lib/vault-host-client.js');
const source = fs.readFileSync(clientPath, 'utf8');

for (const condition of ['missing', 'directory', 'unreadable']) {
  test(`a ${condition} worker falls back before opening a channel or blocking the caller`, () => {
    let workerStarts = 0;
    let channelStarts = 0;
    let waits = 0;
    const module = { exports: {} };
    vm.runInNewContext(source, {
      __dirname: path.dirname(clientPath), module, process: { env: {} }, Buffer,
      Atomics: { wait() { waits++; throw new Error('must not block'); } },
      require(name) {
        if (name === 'node:path') return path;
        if (name === 'node:fs') return {
          constants: fs.constants,
          statSync() {
            if (condition === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            return { isFile: () => condition !== 'directory' };
          },
          accessSync() { if (condition === 'unreadable') throw new Error('unreadable'); },
        };
        if (name === 'node:worker_threads') return {
          Worker: class { constructor() { workerStarts++; throw new Error('must not spawn'); } },
          MessageChannel: class { constructor() { channelStarts++; throw new Error('must not open'); } },
        };
        throw new Error(`Unexpected dependency before the worker was available: ${name}`);
      },
    }, { filename: clientPath });
    assert.equal(module.exports.callVaultHost('get', { key: 'synthetic-key' }), null);
    assert.equal(module.exports.diagnosticHostPid(), null);
    if (condition === 'missing') assert.throws(() => module.exports.callVaultHost('get', {
      key: 'x'.repeat(4 * 1024 * 1024)
    }), { code: 'SECRET_INPUT_INVALID' }, 'oversized requests refuse before a helper or fallback can run');
    assert.equal(workerStarts, 0, 'an unavailable file must not reach asynchronous Worker construction');
    assert.equal(channelStarts, 0);
    assert.equal(waits, 0);
  });
}

test('confirmed host shutdown remains distinct from a secret reply and completes before worker termination', async () => {
  let pending;
  let reply;
  let terminated = 0;
  const actions = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    __dirname: path.dirname(clientPath), module, process: { env: {} }, Buffer,
    Atomics: { wait: () => 'ok' },
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'node:fs') return fs;
      if (name === './providers/subscription-launch-env.js') return { safeLaunchEnvironment: () => ({}) };
      if (name === 'node:worker_threads') return {
        Worker: class {
          unref() {} on() {}
          postMessage(message) { pending = message.payload; actions.push(pending.action); }
          async terminate() { terminated++; }
        },
        MessageChannel: class { constructor() { this.port1 = this.port2 = { close() {} }; } },
        receiveMessageOnPort() { return { message: reply || (pending.action === '__shutdown'
          ? { ok: true, closed: true } : { ok: true, outputBase64: Buffer.from('synthetic').toString('base64') }) }; },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename: clientPath });
  const client = module.exports;
  assert.equal(client.callVaultHost('get', { key: 'synthetic' }).output, 'synthetic');
  reply = { ok: true, closed: true };
  assert.throws(() => client.callVaultHost('get', { key: 'synthetic' }), { code: 'SECRET_HELPER_PROTOCOL_INVALID' });
  reply = { ok: true, closed: 'unconfirmed' };
  await assert.rejects(client.closeVaultHost(), { code: 'SECRET_HELPER_PROTOCOL_INVALID' });
  assert.equal(terminated, 0, 'an invalid acknowledgement must not certify host closure');
  reply = null;
  await client.closeVaultHost();
  assert.equal(terminated, 1);
  const count = actions.length;
  await client.closeVaultHost();
  assert.equal(actions.length, count, 'closing an already closed client must not start a host');
});
