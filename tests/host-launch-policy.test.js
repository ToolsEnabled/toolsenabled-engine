'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const filename = path.join(__dirname, '../src/lib/host-launch-policy.js');
const mutations = Object.freeze({
  scopeIdentity: [['SCOPE.every(key => a[key] === b[key])', 'true']],
  canonicalCommit: [['if (!sameScope(record.binding, live) || live.threadId !== returnedThreadId', 'if (false || false']],
  canonicalCommitRequired: [["if (!parent.committed) return publicResult('unknown', 'canonical-commit-pending');", '']],
  canonicalThread: [['(record.receipt && record.receipt.threadId !== returnedThreadId)', 'false']],
  resumeThread: [["if (kind === 'resume' && threadId !== record.binding.threadId)", 'if (false)']],
  postCommit: [['if (record.committed) {', 'if (false) {']],
  methodScope: [["!['start', 'resume'].includes(kind)", 'false']],
  failedReply: [["if (phase !== 'reply')", 'if (false)']],
  singleCommit: [['!record?.active || record.committed || !id(returnedThreadId)', '!record?.active || !id(returnedThreadId)']],
  responseCorrelation: [['if (!pending || method !== pending.method || typeof requestId !== typeof pending.id || requestId !== pending.id)', 'if (!pending)']],
  requestAge: [['at - pending.startedAt > maxAgeMs', 'false']],
  reversedClock: [['at < pending.startedAt', 'false']],
  parentCurrent: [["if (!current(parent)) return publicResult('unknown', 'parent-scope-unavailable');", '']],
  childIdentity: [["if (childKey !== handoff.childKey || !sameScope(handoff.child, child)\n          || child.threadId !== handoff.child?.threadId)", 'if (!child)']],
  parentRelation: [['child.parentSessionId !== parent.binding.sessionId', 'false']],
  levelCap: [['child.level > parent.binding.level', 'false']],
  providerWorkspace: [['child.provider !== parent.binding.provider || child.workspaceId !== parent.binding.workspaceId', 'false']],
  handoffAge: [['at - handoff.issuedAt > maxAgeMs', 'false']],
  receiptAge: [['at - receipt.observedAt > maxAgeMs', 'false']],
  policyIncomplete: [['if (!id(threadId) || !APPROVAL.has(approval) || !SANDBOX.has(sandbox))', 'if (false)']],
  retirement: [["function retire(record, reason) { record.active = false; record.pending = null; record.receipt = null; record.reason = reason; }", 'function retire(record, reason) { record.reason = reason; }']],
  accessors: [["return field && Object.hasOwn(field, 'value') ? field.value : undefined;", 'return value[key];']],
  identifierBound: [['/^[A-Za-z0-9_.-]{1,160}$/.test(value)', 'true']],
  noAuthority: [['policyApplied: false, permissionsGranted: false, humanConsentQualified: false', 'policyApplied: true, permissionsGranted: true, humanConsentQualified: true']],
  handleIsolation: [['new WeakMap()', 'new Map()'], ['new WeakMap()', 'new Map()'], ['map.get(token) : undefined', '(map.get(token) ?? [...map.values()][0]) : undefined']]
});
function loadRegistry() {
  if (!process.env.F3_POLICY_INTEGRATION_MUTATION) return require(filename);
  const changes = mutations[process.env.F3_POLICY_INTEGRATION_MUTATION];
  if (!changes) throw Error('Unknown fixture mutant');
  let source = fs.readFileSync(filename, 'utf8');
  for (const [before, after] of changes) {
    if (!source.includes(before)) throw Error('Fixture mutant not applicable');
    source = source.replace(before, after);
  }
  const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = module.paths;
  compiled._compile(source, filename); return compiled.exports;
}
const { createHostLaunchPolicy } = loadRegistry();
const known = Object.freeze({ approval: 'no-prompts', sandbox: 'unrestricted' });
const adapter = (_method, result) => result;
function fixture({ normalizeThreadPolicy = adapter, maxAgeMs = 10, parentLevel = 4 } = {}) {
  let time = 100;
  const values = new Map([
    ['parent', { nodeId: 'parent-node', launchId: 'parent-launch', sessionId: 'parent-session', provider: 'fixture',
      workspaceId: 'workspace', generation: 1, level: parentLevel, parentSessionId: null, threadId: null }],
    ['child', { nodeId: 'child-node', launchId: 'child-launch', sessionId: 'child-session', provider: 'fixture',
      workspaceId: 'workspace', generation: 1, level: 2, parentSessionId: 'parent-session', threadId: null }]
  ]);
  const registry = createHostLaunchPolicy({ resolveBinding: key => values.get(key), normalizeThreadPolicy,
    classifyMethod: require('../src/lib/agent-engine/codex-policy-receipt').classifyMethod, maxAgeMs, clock: () => time });
  const launch = registry.host.beginLaunch('parent');
  const begin = (id = 1, method = 'thread/start') => launch.observe({ phase: 'begin', id, method });
  const reply = (id = 1, method = 'thread/start', result = { threadId: 'new-thread', policy: known }) =>
    launch.observe({ phase: 'reply', id, method, result });
  const commit = (threadId = 'new-thread') => {
    values.set('parent', { ...values.get('parent'), threadId });
    return registry.host.commitLaunch(launch.handle, threadId);
  };
  const inspect = token => {
    const value = registry.reader.inspect(token ?? registry.host.issueParentHandoff(launch.handle, 'child'), 'child');
    assert.equal(value.policyApplied, false); assert.equal(value.permissionsGranted, false);
    assert.equal(value.humanConsentQualified, false); assert.equal(value.mcpApprovalMode, 'unknown');
    assert.equal(value.fallback, 'unchanged'); return value;
  };
  const ready = () => { assert.equal(begin(), true); assert.equal(reply(), true); assert.equal(commit(), true); };
  return { registry, launch, values, begin, reply, commit, inspect, ready, tick: n => { time = n; } };
}
test('server-assigned thread is provisional until canonical host commit; parent handoff then known', () => {
  const f = fixture(); assert.equal(f.begin(), true); assert.equal(f.reply(), true);
  assert.equal(f.inspect().status, 'unknown'); assert.equal(f.commit(), true);
  const output = f.inspect(); assert.equal(output.status, 'known'); assert.deepEqual(output.observedPolicy, known);
  assert.ok(Object.isFrozen(output)); assert.ok(Object.isFrozen(output.observedPolicy));
});
test('canonical start scope does not need a fabricated preexisting thread id', () => {
  const f = fixture(); assert.equal(f.values.get('parent').threadId, null); f.ready();
  assert.equal(f.inspect().status, 'known');
});
test('wrong or reused response correlation cannot admit a parent policy', () => {
  for (const id of [2, '1', null]) {
    const f = fixture(); f.begin(); assert.equal(f.reply(id), false); f.commit(); assert.equal(f.inspect().status, 'unknown');
  }
  const f = fixture(); f.begin(); assert.equal(f.reply(), true); assert.equal(f.reply(), false);
  f.commit(); assert.equal(f.inspect().status, 'unknown');
});
test('request age at TTL is valid; over-limit and delayed replies cannot refresh', () => {
  for (const age of [10, 11, 900]) {
    const f = fixture(); f.begin(); f.tick(100 + age);
    assert.equal(f.reply(), age <= 10); f.commit();
    assert.equal(f.inspect().status, age <= 10 ? 'known' : 'unknown');
  }
});
test('canonical commit mismatches or changed live generation remain unknown', () => {
  for (const field of ['nodeId', 'launchId', 'sessionId', 'provider', 'workspaceId', 'generation', 'level', 'parentSessionId']) {
    const f = fixture(); f.begin(); f.reply();
    f.values.set('parent', { ...f.values.get('parent'), [field]: typeof f.values.get('parent')[field] === 'number' ? 2 : 'different' });
    assert.equal(f.commit(), false, field); assert.equal(f.inspect().status, 'unknown');
  }
  const f = fixture(); f.begin(); f.reply(); assert.equal(f.commit('wrong-thread'), false);
  assert.equal(f.inspect().status, 'unknown');
});
test('canonical commit is single-use and requires current canonical thread identity', () => {
  const f = fixture(); f.begin(); f.reply();
  assert.equal(f.registry.host.commitLaunch(f.launch.handle, 'new-thread'), false);
  assert.equal(f.commit(), false);
  const g = fixture(); g.ready(); assert.equal(g.registry.host.commitLaunch(g.launch.handle, 'new-thread'), false);
});
test('matched resume must retain the preexisting canonical thread id', () => {
  const f = fixture(); f.values.set('parent', { ...f.values.get('parent'), threadId: 'old-thread' });
  const launch = f.registry.host.beginLaunch('parent');
  assert.equal(launch.observe({ phase: 'begin', id: 1, method: 'thread/resume' }), true);
  assert.equal(launch.observe({ phase: 'reply', id: 1, method: 'thread/resume', result: { threadId: 'different', policy: known } }), false);
  f.values.set('parent', { ...f.values.get('parent'), threadId: 'different' });
  assert.equal(f.registry.host.commitLaunch(launch.handle, 'different'), false);
});
test('post-commit observation cannot replace the admitted parent thread policy', () => {
  const f = fixture(); f.ready(); assert.equal(f.begin(2), false); assert.equal(f.reply(2), false);
  assert.equal(f.inspect().status, 'unknown');
});
test('missing GUI parent and unsupported methods cannot manufacture known policy', () => {
  const f = fixture(); const launch = f.registry.host.beginLaunch('gui');
  assert.equal(launch.observe({ phase: 'begin', id: 1, method: 'thread/start' }), false);
  assert.equal(f.registry.reader.inspect(f.registry.host.issueParentHandoff(launch.handle, 'child'), 'child').status, 'unknown');
  assert.equal(f.begin(1, 'thread/read'), false); assert.equal(f.inspect().status, 'unknown');
});
test('errors, cancellation and missing/malformed provider policies fail unknown without raw data', () => {
  for (const phase of ['failed', 'cancelled', 'unrecognized']) {
    const f = fixture(); f.begin(); assert.equal(f.launch.observe({ phase, id: 1, method: 'thread/start',
      result: { threadId: 'new-thread', policy: known } }), false);
    f.commit(); assert.equal(f.inspect().status, 'unknown');
  }
  for (const result of [null, {}, { threadId: 'new-thread', policy: { approval: 'no-prompts' } },
    { threadId: 'new-thread', policy: { approval: 'RAW_SECRET_MARKER', sandbox: 'unrestricted' } }]) {
    const f = fixture(); f.begin(); assert.equal(f.reply(1, 'thread/start', result), false); f.commit();
    assert.equal(f.inspect().status, 'unknown'); assert.ok(!JSON.stringify(f.inspect()).includes('RAW_SECRET_MARKER'));
  }
});
test('throwing normalizer and failed or reversed clocks are unknown', () => {
  const f = fixture({ normalizeThreadPolicy: () => { throw Error('PRIVATE_NORMALIZER_MARKER'); } });
  f.begin(); assert.equal(f.reply(), false); f.commit(); assert.equal(f.inspect().status, 'unknown');
  assert.ok(!JSON.stringify(f.inspect()).includes('PRIVATE_NORMALIZER_MARKER'));
  for (const time of [99, NaN]) { const g = fixture(); g.begin(); g.tick(time); assert.equal(g.reply(), false); }
});
test('handoff requires canonical same-parent relation and cannot exceed parent level', () => {
  for (const change of [{ parentSessionId: 'unrelated' }, { level: 4 }]) {
    const f = fixture({ parentLevel: 2 });
    f.values.set('child', { ...f.values.get('child'), ...change }); f.ready();
    assert.equal(f.inspect().status, 'unknown');
  }
});
test('cross-provider/workspace, foreign child and changed child scope cannot use a handoff', () => {
  for (const field of ['provider', 'workspaceId']) {
    const f = fixture(); f.values.set('child', { ...f.values.get('child'), [field]: 'other' }); f.ready();
    assert.equal(f.inspect().status, 'unknown');
  }
  const f = fixture(); f.ready(); const token = f.registry.host.issueParentHandoff(f.launch.handle, 'child');
  f.values.set('child', { ...f.values.get('child'), generation: 2 }); assert.equal(f.inspect(token).status, 'unknown');
  assert.equal(f.registry.reader.inspect(token, 'different').status, 'unknown');
});
test('old receipts and old handoffs independently expire', () => {
  const f = fixture(); f.ready(); const token = f.registry.host.issueParentHandoff(f.launch.handle, 'child');
  f.tick(111); assert.equal(f.inspect(token).status, 'unknown'); assert.equal(f.inspect().status, 'unknown');
  const g = fixture(); const early = g.registry.host.issueParentHandoff(g.launch.handle, 'child');
  g.tick(109); g.ready(); g.tick(111);
  assert.equal(g.inspect(early).status, 'unknown'); assert.equal(g.inspect().status, 'known');
});
test('cloned or caller-provided handles cannot replace an existing admitted handoff', () => {
  const f = fixture(); f.ready(); const real = f.registry.host.issueParentHandoff(f.launch.handle, 'child');
  assert.equal(f.inspect(real).status, 'known');
  for (const fake of [{}, JSON.parse(JSON.stringify(real)), structuredClone(real)]) assert.equal(f.inspect(fake).status, 'unknown');
});
test('closed provider/launch, replaced thread and fresh registry cannot restore admitted state', () => {
  for (const close of ['provider', 'host']) {
    const f = fixture(); f.ready(); const token = f.registry.host.issueParentHandoff(f.launch.handle, 'child');
    if (close === 'provider') f.launch.observe({ phase: 'closed' }); else f.registry.host.closeLaunch(f.launch.handle);
    assert.equal(f.inspect(token).status, 'unknown');
  }
  const f = fixture(); f.ready(); f.values.set('parent', { ...f.values.get('parent'), threadId: 'different' });
  assert.equal(f.inspect().status, 'unknown');
  const g = fixture(); const token = f.registry.host.issueParentHandoff(f.launch.handle, 'child');
  assert.equal(g.inspect(token).status, 'unknown'); assert.equal(g.inspect(JSON.parse(JSON.stringify(token))).status, 'unknown');
});
test('public output omits canonical identifiers/raw response and does not mutate inputs', () => {
  const f = fixture(); f.begin(); const input = Object.freeze({ threadId: 'new-thread', policy: known, privateText: 'PRIVATE_MARKER' });
  assert.equal(f.reply(1, 'thread/start', input), true); f.commit(); const value = f.inspect();
  for (const marker of ['PRIVATE_MARKER', 'parent-session', 'new-thread', 'parent-node']) assert.ok(!JSON.stringify(value).includes(marker));
  assert.equal(input.privateText, 'PRIVATE_MARKER');
});
test('getters and malformed identities do not run or create canonical bindings', () => {
  const f = fixture(); let called = 0; const event = {};
  Object.defineProperty(event, 'phase', { get() { called++; return 'begin'; } });
  assert.equal(f.launch.observe(event), false); assert.equal(called, 0);
  for (const key of ['../other', 'x'.repeat(161), null]) assert.equal(f.registry.host.beginLaunch(key).observe({ phase: 'begin', id: 1, method: 'thread/start' }), false);
  for (const nodeId of ['../other', 'x'.repeat(161), 'name\u001b[31m']) {
    const g = fixture(); g.values.set('parent', { ...g.values.get('parent'), nodeId });
    const launch = g.registry.host.beginLaunch('parent');
    assert.equal(launch.observe({ phase: 'begin', id: 1, method: 'thread/start' }), false);
  }
});
test('invalid composition bounds fail explicitly and unknown remains diagnostic only', () => {
  for (const maxAgeMs of [0, 300001, NaN]) assert.throws(() => createHostLaunchPolicy({ resolveBinding: () => null, normalizeThreadPolicy: adapter,
    classifyMethod: () => null, maxAgeMs }), TypeError);
  assert.throws(() => createHostLaunchPolicy({ resolveBinding: () => null, normalizeThreadPolicy: adapter }), TypeError, 'a method classifier is required');
  const f = fixture(); assert.equal(f.inspect().status, 'unknown');
});
