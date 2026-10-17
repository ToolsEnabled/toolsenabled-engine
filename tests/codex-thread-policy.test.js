'use strict';
require('./lib/isolated-environment').activate('f3-policy-integration');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const filename = path.join(__dirname, '../src/lib/agent-engine/codex-adapter.js');
const mutations = {
  methodScope: ["if (phase !== 'closed' && ![METHOD.threadStart, METHOD.threadResume].includes(method)) return;", ''],
  nativeClosed: ["    this._observeThreadPolicy('closed');", ''],
  approvalProjection: ["['never', 'on-request', 'on-failure', 'untrusted'].includes(rawApproval) ? rawApproval : null", 'rawApproval'],
  sandboxProjection: ["['readOnly', 'workspaceWrite', 'dangerFullAccess'].includes(tag)", 'true'],
  idProjection: ["/^[A-Za-z0-9_.-]{1,160}$/.test(parsed.threadId)", 'true'],
  observerFailure: ["this.observeThreadPolicy(Object.freeze({ phase: 'closed' }))", 'undefined'],
  privateFunction: ["if (observeThreadPolicy !== null && typeof observeThreadPolicy !== 'function')", 'if (false)']
};
function loadAdapter() {
  if (!process.env.F3_POLICY_OBSERVER_MUTATION) return require(filename);
  const change = mutations[process.env.F3_POLICY_OBSERVER_MUTATION];
  if (!change) throw Error('Unknown observer mutant');
  const source = fs.readFileSync(filename, 'utf8'); if (!source.includes(change[0])) throw Error('Observer mutant not applicable');
  const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = module.paths;
  compiled._compile(source.replace(change[0], change[1]), filename); return compiled.exports;
}
const { CodexAdapter } = loadAdapter();
const codec = require('../src/lib/agent-engine/codex-policy-receipt');
const { createHostLaunchPolicy } = require('../src/lib/host-launch-policy');
function fixture({ reply = null, parentThreadId = null, observe = null } = {}) {
  let receive;
  const packets = [], seen = [];
  const bindings = new Map([
    ['parent', { nodeId: 'parent', launchId: 'launch', sessionId: 'session', provider: 'codex', workspaceId: 'workspace',
      generation: 1, level: 4, parentSessionId: null, threadId: parentThreadId }],
    ['child', { nodeId: 'child', launchId: 'child-launch', sessionId: 'child-session', provider: 'codex', workspaceId: 'workspace',
      generation: 1, level: 2, parentSessionId: 'session', threadId: null }]
  ]);
  const registry = createHostLaunchPolicy({ resolveBinding: key => bindings.get(key), normalizeThreadPolicy: codec.normalizeThreadPolicy,
    classifyMethod: codec.classifyMethod });
  const launch = registry.host.beginLaunch('parent');
  const transport = { onData(fn) { receive = fn; return () => {}; }, write(line) {
    const packet = JSON.parse(line); packets.push(packet);
    if (packet.id === undefined) return;
    const response = packet.method === 'initialize' ? { id: packet.id, result: {} }
      : reply ? reply(packet) : { id: packet.id, result: { thread: { id: 'new-thread' }, approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' }, privateText: 'PRIVATE_RESPONSE_MARKER', password: 'SYNTHETIC_PASSWORD_MARKER' } };
    queueMicrotask(() => receive(JSON.stringify({ jsonrpc: '2.0', ...response }) + '\n'));
  } };
  const adapter = new CodexAdapter({ transport, codexVersion: 'codex-cli 0.160.1', observeThreadPolicy: observe ?? (event => {
    seen.push(event); return launch.observe(event);
  }) });
  const commit = threadId => { bindings.set('parent', { ...bindings.get('parent'), threadId }); return registry.host.commitLaunch(launch.handle, threadId); };
  const inspect = () => registry.reader.inspect(registry.host.issueParentHandoff(launch.handle, 'child'), 'child');
  return { adapter, packets, seen, registry, launch, bindings, commit, inspect };
}
test('actual adapter matched-response seam feeds bounded receipt; canonical birth remains separate', async () => {
  const f = fixture(); await f.adapter.initialize();
  const thread = await f.adapter.startThread({ approvalPolicy: 'on-request' });
  assert.equal(f.inspect().status, 'unknown'); assert.equal(f.commit(thread.threadId), true);
  const value = f.inspect(); assert.equal(value.status, 'known');
  assert.deepEqual(value.observedPolicy, { approval: 'no-prompts', sandbox: 'unrestricted' });
  assert.equal(value.policyApplied, false); assert.equal(value.permissionsGranted, false);
  assert.equal(value.humanConsentQualified, false);
  assert.equal(f.packets.find(p => p.method === 'thread/start').params.approvalPolicy, 'on-request');
  assert.deepEqual(f.seen.map(e => e.phase), ['begin', 'reply']);
  for (const marker of ['PRIVATE_RESPONSE_MARKER', 'SYNTHETIC_PASSWORD_MARKER', 'params']) assert.ok(!JSON.stringify(f.seen).includes(marker));
  f.adapter.close(); assert.equal(f.inspect().status, 'unknown');
});
test('wrong raw JSON-RPC id closes observer; matching-looking policy never admitted', async () => {
  const f = fixture({ reply: p => ({ id: p.id + 100, result: { thread: { id: 'new-thread' }, approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } } }) });
  await f.adapter.initialize(); await assert.rejects(f.adapter.startThread(), { code: 'CODEX_PROTOCOL_INVALID' });
  assert.ok(f.seen.some(e => e.phase === 'closed')); assert.equal(f.inspect().status, 'unknown');
  assert.equal(f.commit('new-thread'), false);
});
test('native error retires observation without publishing provider error prose', async () => {
  const f = fixture({ reply: p => ({ id: p.id, error: { code: -32000, message: 'PRIVATE_ERROR_MARKER' } }) });
  await f.adapter.initialize(); await assert.rejects(f.adapter.startThread(), { code: 'CODEX_APP_SERVER_ERROR' });
  assert.deepEqual(f.seen.map(e => e.phase), ['begin', 'failed']);
  assert.ok(!JSON.stringify(f.seen).includes('PRIVATE_ERROR_MARKER')); assert.equal(f.inspect().status, 'unknown'); f.adapter.close();
});
test('missing or composite resolved policy does not borrow sent approval options', async () => {
  for (const approvalPolicy of [undefined, null, { granular: { mcp: true } }]) {
    const f = fixture({ reply: p => ({ id: p.id, result: { thread: { id: 'new-thread' }, approvalPolicy, sandbox: { type: 'dangerFullAccess' } } }) });
    await f.adapter.initialize(); const thread = await f.adapter.startThread({ approvalPolicy: 'never' }); f.commit(thread.threadId);
    assert.equal(f.inspect().status, 'unknown'); f.adapter.close();
  }
});
test('thread/read does not create an effective-policy observation or infer authority', async () => {
  const f = fixture(); await f.adapter.initialize(); await f.adapter.readThread('new-thread');
  assert.deepEqual(f.seen, []); assert.equal(f.inspect().status, 'unknown'); f.adapter.close();
});
test('observer errors retire the private observer while native response remains usable', async () => {
  const seen = []; const f = fixture({ observe: event => { seen.push(event.phase); if (event.phase === 'reply') throw Error('PRIVATE_OBSERVER_MARKER'); } });
  await f.adapter.initialize(); assert.equal((await f.adapter.startThread()).threadId, 'new-thread');
  assert.deepEqual(seen, ['begin', 'reply', 'closed']); assert.equal(f.adapter.observeThreadPolicy, null); f.adapter.close();
});
test('plain default adapter preserves options and has no observer-derived policy', async () => {
  const f = fixture(); f.adapter.observeThreadPolicy = null; await f.adapter.initialize();
  assert.equal((await f.adapter.startThread({ approvalPolicy: 'on-request', sandbox: 'danger-full-access' })).threadId, 'new-thread');
  assert.deepEqual(f.seen, []); assert.equal(f.inspect().status, 'unknown'); f.adapter.close();
});
test('unrecognized selected provider values are omitted from private observation without unsafe id or prose', async () => {
  for (const fields of [{ approvalPolicy: 'PRIVATE_POLICY_MARKER' }, { sandbox: { type: 'PRIVATE_POLICY_MARKER' } }, { thread: { id: 'thread/private' } }]) {
    const f = fixture({ reply: p => ({ id: p.id, result: { thread: { id: 'new-thread' }, approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' }, ...fields } }) });
    await f.adapter.initialize(); await f.adapter.startThread();
    const result = f.seen.find(e => e.phase === 'reply').result;
    assert.ok(!JSON.stringify(result).includes('PRIVATE_POLICY_MARKER'));
    assert.ok(!JSON.stringify(result).includes('thread/private'));
    assert.equal(f.inspect().status, 'unknown'); f.adapter.close();
  }
});
test('caller-shaped observer metadata is not a private callback', () => {
  assert.throws(() => new CodexAdapter({ transport: { write() {}, onData() { return () => {}; } },
    codexVersion: 'codex-cli 0.160.1', observeThreadPolicy: { claimedTrusted: true } }), { code: 'CODEX_ADAPTER_INVALID' });
});
