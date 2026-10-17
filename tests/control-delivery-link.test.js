'use strict';
require('./lib/isolated-environment').activate('f1-control-link');
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
function loadSource(relative, override) {
  if (!override) return require(relative);
  const Module = require('node:module'), filename = path.resolve(__dirname, relative + '.js');
  const loaded = new Module(filename, module); loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(override, 'utf8'), filename); return loaded.exports;
}
const link = loadSource('../src/lib/openshell-tree-link', process.env.F1_LINK_TEST_MODULE);
const { createOpenShellTreeClient } = loadSource('../src/lib/openshell-agent-host', process.env.F1_HOST_TEST_MODULE);
test('proxy keeps AbortSignal out of JSON and bounds scoped wait transport', async () => {
  const calls = []; const abort = new AbortController();
  const client = createOpenShellTreeClient({ socketPath: path.join(os.tmpdir(), 'unused-fixture'), token: undefined,
    sessionId: 'fixture-session', request: async value => { calls.push(value); return {}; } });
  await client.wait({ timeoutSeconds: 2, signal: abort.signal });
  assert.equal(calls[0].signal, abort.signal); assert.equal(Object.hasOwn(calls[0].request, 'signal'), false);
  assert.equal(calls[0].timeoutMs, 3000);
  abort.abort(); await client.controlBoundary({ phase: 'end', boundaryId: 'fixture-boundary', signal: abort.signal });
  assert.equal(calls[1].request.cancelled, true); assert.equal(Object.hasOwn(calls[1], 'signal'), false);
});
test('private connection cancellation reaches server wait without trusting a wire signal', async t => {
  const folder = fs.mkdtempSync(path.join(path.resolve(__dirname, '../..'), '.s-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  let started; const entered = new Promise(resolve => { started = resolve; });
  let cancelled; const observed = new Promise(resolve => { cancelled = resolve; });
  const server = link.createTreeLinkServer({ socketPath: path.join(folder, 'control.sock'),
    handle: async (unused, op, request) => { assert.equal(request.signal instanceof AbortSignal, true); started();
      await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
      cancelled(); return {}; } });
  await server.listen(); t.after(() => server.close());
  const abort = new AbortController();
  const pending = link.treeLinkRequest({ socketPath: server.socketPath, token: undefined, op: 'fixture-wait',
    request: { signal: { aborted: false } }, timeoutMs: 1000, signal: abort.signal });
  const refusal = assert.rejects(pending, { code: 'ABORT_ERR' });
  await entered; abort.abort(); await refusal;
  await Promise.race([observed, new Promise((resolve, reject) => setTimeout(() => reject(new Error('fixture cancellation deadline')), 1000))]);
});
test('wire signal spoof cannot impersonate the transport lifetime', async t => {
  const folder = fs.mkdtempSync(path.join(path.resolve(__dirname, '../..'), '.s-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const server = link.createTreeLinkServer({ socketPath: path.join(folder, 'control.sock'),
    handle: async (unused, op, request) => ({ trusted: request.signal instanceof AbortSignal, aborted: request.signal.aborted }) });
  await server.listen(); t.after(() => server.close());
  const result = await link.treeLinkRequest({ socketPath: server.socketPath, token: undefined, op: 'fixture',
    request: { signal: { aborted: true } }, timeoutMs: 1000 });
  assert.equal(result.trusted, true); assert.equal(result.aborted, false);
});
