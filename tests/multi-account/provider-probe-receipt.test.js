'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { root } = require('../lib/isolated-environment').activate('provider-receipt');
const { probeAntigravityAccount, probeGrokAccount, probeSignInPresence } = require('../../src/lib/multi-account/health');
const { probeLifecycleOf } = require('../../src/lib/multi-account/probe-lifecycle');

function childPeer({ text = null, protocol = false }) {
  const child = new EventEmitter(); child.pid = 123;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let closed = false;
  const close = () => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', 0, null); };
  child.stdin = new Writable({ write(bytes, _encoding, done) {
    const request = JSON.parse(String(bytes));
    const result = request.id === 1 ? { authMethods: [{ id: 'cached_token' }] } : request.id === 2 ? { _meta: {} } : {};
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
    done();
  } });
  child.terminateJob = async () => { close(); return { type: 'terminated', activeProcesses: 0 }; };
  if (!protocol) queueMicrotask(() => { child.stdout.write(text); close(); });
  return child;
}

for (const provider of ['antigravity', 'grok']) for (const failSecond of [false, true]) {
  test(`${provider} carries a closed receipt only when both canonical reads close (${failSecond ? 'second spawn fails' : 'both close'})`, async () => {
    let starts = 0;
    const options = { homeDir: root, environmentFor: () => ({}), fsImpl: { statSync: () => ({ isFile: () => true }) },
      spawnImpl(_command, _args, opts) {
        assert.equal(opts.containProcessTree, true);
        starts++;
        if (starts === 2 && failSecond) throw Object.assign(new Error('fixture spawn failed'), { code: 'ENOENT' });
        if (provider === 'antigravity') return childPeer({ text: starts === 1 ? 'gemini-fixture\tFixture model\n' : '{}' });
        return starts === 1 ? childPeer({ text: JSON.stringify({ hooks: [], plugins: [], mcpServers: [], lspServers: [] }) })
          : childPeer({ protocol: true });
      } };
    const result = provider === 'antigravity'
      ? await probeAntigravityAccount({ name: 'synthetic', provider: 'gemini', client: 'antigravity', homeDir: path.join(root, 'agy') }, options)
      : await probeGrokAccount({ name: 'synthetic', provider: 'grok', configDir: path.join(root, 'grok') }, options);
    assert.equal(starts, 2);
    assert.equal(probeLifecycleOf(result), failSecond ? null : 'closed');
    assert.equal(JSON.stringify(result).includes('probeLifecycle'), false);
  });
}

test('a Gemini file-presence result cannot claim provider process closure', async () => {
  const result = await probeSignInPresence({ name: 'synthetic', provider: 'gemini', homeDir: path.join(root, 'gemini') },
    { homeDir: root, fsImpl: { statSync: () => ({ isFile: () => true }) } });
  assert.equal(probeLifecycleOf(result), null);
});
