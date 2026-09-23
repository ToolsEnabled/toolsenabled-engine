'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../src/lib/agent-resource-control');
const GB = 1024 ** 3;
function fixture(mode = 'both') {
  let at = 10000;
  let tick;
  let writable = true;
  const cells = { [api.RESOURCE_PREF_KEY]: JSON.stringify({ mode }) };
  const sessions = new Map([['controller-session', { agentId: 'root', state: 'ready', started: true }], ['worker-session', { agentId: 'worker', state: 'ready', started: true }]]);
  const org = { ok: true, org: { agents: [{ id: 'root', role: 'controller-role', provider: 'claude', enabled: true }, { id: 'worker', role: 'worker-role', provider: 'claude', enabled: true }] },
    roles: [{ id: 'controller-role', revision: 4, capabilities: { orgRoot: true } }, { id: 'worker-role', revision: 5, capabilities: { orgRoot: false } }] };
  const principal = { kind: 'agent-session', sessionId: 'controller-session', agentId: 'root', roleId: 'controller-role', provider: 'claude', expectedOrgRevision: 1, expectedRoleRevision: 4 };
  sessions.get('controller-session').agentAuthority = { agentId: principal.agentId, roleId: principal.roleId, provider: principal.provider,
    expectedOrgRevision: principal.expectedOrgRevision, expectedRoleRevision: principal.expectedRoleRevision };
  const host = api.createAgentResourceHost({ bootId: 'this-boot', now: () => at, sessions, readOrg: () => org,
    prefs: { snapshot: () => ({ values: { ...cells } }), set(key, value) { if (!writable) return { ok: false }; cells[key] = value; return { ok: true }; } },
    schedule(fn) { tick = fn; return 1; }, unschedule() { tick = null; },
    sample: ({ loopLagMs }) => ({ atMs: at, cpuPercent: 20, freeBytes: 16 * GB, totalBytes: 32 * GB, loopLagMs }),
  });
  function advance(ms = 1000) { at += ms; tick?.(); }
  advance(); advance();
  const advice = (overrides = {}) => { const state = host.status(principal); return { bootId: state.bootId, sampleId: state.sampleId, provider: 'claude', decision: 'allow', launches: 2, expiresAtMs: at + 30000, reason: 'Measured headroom supports two additional launches.', ...overrides }; };
  return { host, org, sessions, principal, advice, advance, cells, now: () => at, writable(value) { writable = value; } };
}
test.afterEach(() => api.clearResourceHost());
test('controller tool requires an installed app host and authenticated transport context', () => {
  const f = fixture();
  assert.throws(() => api.resourceStatus({}, {}), { code: 'RESOURCE_CONTROLLER_REQUIRED' });
  const context = { agentPrincipal: f.principal, agentId: 'root', agentSessionId: 'controller-session' };
  assert.throws(() => api.resourceStatus({}, context), { code: 'RESOURCE_HOST_UNAVAILABLE' });
  api.installResourceHost(f.host);
  assert.equal(api.resourceStatus({}, context).bootId, 'this-boot');
  assert.throws(() => api.resourceStatus({}, { ...context, agentId: 'worker' }), { code: 'RESOURCE_CONTROLLER_REQUIRED' });
  assert.throws(() => api.resourceAdvice(f.advice(), { ...context, agentPrincipal: { ...f.principal, agentId: 'worker', sessionId: 'worker-session', roleId: 'worker-role', expectedRoleRevision: 5 }, agentId: 'worker', agentSessionId: 'worker-session' }), { code: 'RESOURCE_CONTROLLER_REQUIRED' });
});
test('one boot/sample/controller/provider supplies one budget, never concurrent refill or replay', () => {
  const f = fixture('controller');
  const args = f.advice();
  f.host.advise(args, f.principal);
  assert.equal(f.host.reserve({ provider: 'claude' }).ok, true);
  f.host.advise(args, f.principal);
  assert.equal(f.host.reserve({ provider: 'claude' }).ok, true);
  assert.equal(f.host.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
  assert.throws(() => f.host.advise({ ...args, launches: 3 }, f.principal), { code: 'RESOURCE_ADVICE_REPLAY' });
  assert.throws(() => f.host.advise({ ...args, bootId: 'previous-boot' }, f.principal), { code: 'RESOURCE_ADVICE_INVALID' });
});
test('advice is bound to a sample read by that session and cannot outlive it by more than 60 seconds', () => {
  const f = fixture('controller');
  const args = f.advice();
  assert.throws(() => f.host.advise({ ...args, sampleId: 'invented' }, f.principal), { code: 'RESOURCE_ADVICE_STALE' });
  f.advance(10000);
  assert.throws(() => f.host.advise({ ...args, expiresAtMs: f.now() + 59000 }, f.principal), { code: 'RESOURCE_ADVICE_STALE' });
  f.host.advise(args, f.principal);
  f.advance(21000);
  assert.equal(f.host.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
});
test('org role, session death, and role revision are checked again at consumption', () => {
  for (const revoke of [f => { f.org.roles[0].capabilities.orgRoot = false; }, f => { f.org.roles[0].revision++; }, f => { f.sessions.get('controller-session').state = 'ended'; }, f => { f.org.org.agents[0].enabled = false; },
    f => { f.sessions.get('controller-session').agentAuthority = null; }, f => { f.sessions.get('controller-session').agentAuthority.expectedOrgRevision++; }]) {
    const f = fixture('controller'); f.host.advise(f.advice(), f.principal); revoke(f);
    assert.equal(f.host.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
    assert.throws(() => f.host.status(f.principal), { code: 'RESOURCE_CONTROLLER_REQUIRED' });
  }
});
test('only one exact declared root may bootstrap; no role-label or unsigned request bypass', () => {
  const f = fixture(); f.sessions.delete('controller-session');
  f.sessions.set('first', { agentId: 'root', state: 'starting' });
  f.sessions.set('second', { agentId: 'root', state: 'starting' });
  const options = { provider: 'claude', sessionId: 'first', agentId: 'root', agentAuthority: { agentId: 'root', roleId: 'controller-role', provider: 'claude', expectedRoleRevision: 4 } };
  assert.equal(f.host.reserve({ provider: 'claude', role: 'Controller', bootstrapController: true }).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
  const first = f.host.reserve(options);
  assert.equal(first.ok, true); assert.equal(first.state.bootstrapController, true);
  f.advance();
  assert.equal(f.host.reserve({ ...options, sessionId: 'second' }).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
  f.host.release(first.token, 'first');
  f.sessions.delete('first');
  assert.equal(f.host.reserve({ ...options, sessionId: 'second' }).ok, true);
});
test('settings write failure retains actual policy; All off persists and stops both admission gates', () => {
  const f = fixture(); f.writable(false);
  assert.equal(f.host.configure({ mode: 'off' }).code, 'RESOURCE_SETTINGS_WRITE_FAILED');
  assert.equal(f.host.status().mode, 'both');
  f.writable(true);
  assert.equal(f.host.configure({ mode: 'off' }).mode, 'off');
  f.advance(61000);
  assert.equal(f.host.reserve({ provider: 'claude' }).ok, true);
  assert.equal(JSON.parse(f.cells[api.RESOURCE_PREF_KEY]).mode, 'off');
  assert.equal(f.host.configure({ mode: 'off', providerBytes: { claude: NaN } }).code, 'RESOURCE_SETTINGS_INVALID');
  f.host.dispose();
  assert.equal(f.host.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_UNKNOWN');
});

test('tree final validation uses the same host debit and refuses a disposed monitor even when policy is Off', () => {
  const f = fixture('mechanical');
  const first = f.host.reserve({ provider: 'claude' }); assert.equal(first.ok, true);
  assert.equal(f.host.revalidate(first.token).ok, true);
  assert.equal(f.host.revalidate(first.token).code, 'AGENT_RESOURCE_GRANT_USED');
  f.host.configure({ mode: 'off' });
  const off = f.host.reserve({ provider: 'claude' }); assert.equal(off.ok, true);
  f.host.dispose();
  assert.equal(f.host.revalidate(off.token).code, 'AGENT_RESOURCE_UNKNOWN');
});
test('a different live authenticated org-root prevents bootstrap; a revoked role or ended session does not', () => {
  for (const disposition of ['ready', 'ended', 'role-revoked']) {
    const f = fixture(); f.sessions.delete('controller-session');
    f.org.org.agents.push({ id: 'other-root', role: 'other-controller-role', provider: 'claude', enabled: true });
    f.org.roles.push({ id: 'other-controller-role', revision: 8, capabilities: { orgRoot: disposition !== 'role-revoked' } });
    f.sessions.set('other-root-session', { agentId: 'other-root', state: disposition === 'ended' ? 'ended' : 'ready', started: true,
      agentAuthority: { agentId: 'other-root', provider: 'claude', roleId: 'other-controller-role', expectedRoleRevision: 8 } });
    const result = f.host.reserve({ provider: 'claude', sessionId: 'new-root-session', agentId: 'root',
      agentAuthority: { agentId: 'root', provider: 'claude', roleId: 'controller-role', expectedRoleRevision: 4 } });
    if (disposition === 'ready') assert.equal(result.code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
    else { assert.equal(result.ok, true); assert.equal(result.state.bootstrapController, true); }
  }
});


test('Basic resource policy has no sampler or timer; explicit setup alone starts them', () => {
  for (const raw of [undefined, '{}', '{', JSON.stringify({ mode: 'unknown' }), JSON.stringify({ mode: 'off' })]) {
    let at = 10000, samples = 0, scheduled = 0, cleared = 0, callback, writable = true;
    const cells = raw === undefined ? {} : { [api.RESOURCE_PREF_KEY]: raw };
    const host = api.createAgentResourceHost({ sessions: new Map(), readOrg: () => null, now: () => at,
      prefs: { snapshot: () => ({ values: cells }), set(key, value) { if (!writable) return { ok: false }; cells[key] = value; return { ok: true }; } },
      sample: () => { samples++; return { atMs: at, cpuPercent: 99, freeBytes: 0, totalBytes: GB }; },
      schedule(fn) { scheduled++; callback = fn; return 0; }, unschedule(id) { assert.equal(id, 0); cleared++; },
    });
    assert.equal(host.status().mode, 'off');
    assert.equal(host.reserve({ provider: 'claude' }).ok, true);
    assert.deepEqual([samples, scheduled, cleared], [0, 0, 0]);
    writable = false;
    assert.equal(host.configure({ mode: 'mechanical' }).ok, false);
    assert.deepEqual([samples, scheduled, cleared], [0, 0, 0]);
    writable = true;
    assert.equal(host.configure({ mode: 'mechanical' }).mode, 'mechanical');
    assert.deepEqual([samples, scheduled, cleared], [1, 1, 0]);
    assert.equal(host.reserve({ provider: 'claude' }).ok, false, 'explicit enforcement must still refuse observed pressure');
    host.configure({ mode: 'off' });
    at += 1000; callback();
    assert.deepEqual([samples, scheduled, cleared], [1, 1, 1], 'even an already queued callback must stop sampling');
    assert.equal(host.reserve({ provider: 'claude' }).ok, true);
    host.configure({ mode: 'controller' });
    assert.deepEqual([samples, scheduled, cleared], [2, 2, 1]);
    assert.equal(host.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
    host.dispose(); callback();
    assert.deepEqual([samples, scheduled, cleared], [2, 2, 2]);
  }
});

test('resource status recognizes the authoritative tool modes without broadening invalid values', () => {
  for (const [mode, expected] of [
    ['ToolsEnabled only', { known: true, mode: 'ToolsEnabled only', available: true }],
    ['ToolsEnabled and selected native tools', { known: true, mode: 'ToolsEnabled and selected native tools', available: true }],
    ['ToolsEnabled and native tools', { known: true, mode: 'ToolsEnabled and native tools', available: true }],
    ['Native tools only', { known: true, mode: 'Native tools only', available: false }],
    ['invented', { known: false, mode: null, available: null }]
  ]) {
    const host = api.createAgentResourceHost({
      prefs: { snapshot: () => ({ values: {} }) },
      sessions: new Map(), readOrg: () => null, readToolMode: () => mode,
      schedule: () => { throw new Error('Off must not start a timer'); },
      sample: () => { throw new Error('Off must not sample'); }
    });
    try { assert.deepEqual(host.status().newControllerTools, expected); }
    finally { host.dispose(); }
  }
});
