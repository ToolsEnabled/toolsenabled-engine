'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentResourceHost, RESOURCE_PREF_KEY } = require('../src/lib/agent-resource-host');
const { createResourceAdmission, DEFAULT_SETTINGS, normalizeSettings } = require('../src/lib/agent-resource-admission');
const MIB = 1024 ** 2, GIB = 1024 ** 3;
function fixture(initial = {}, options = {}) {
  let at = 10000, tick, cpu = 20, free = 128 * GIB, writable = true, throws = false;
  const cells = { [RESOURCE_PREF_KEY]: JSON.stringify(initial) }, writes = [];
  const host = createAgentResourceHost({ now: () => at, sessions: new Map(), readOrg: () => ({ ok: false }),
    prefs: { snapshot: () => ({ values: cells }), set(key, value) { if (throws) throw new Error('Synthetic disk failure'); if (!writable) return { ok: false }; writes.push(value); cells[key] = value; return { ok: true }; } },
    schedule(fn) { tick = fn; return 1; }, unschedule() { tick = null; },
    sample: ({ loopLagMs }) => ({ atMs: at, cpuPercent: cpu, freeBytes: free, totalBytes: 256 * GIB, loopLagMs }),
    ...options,
  });
  function advance(ms = 1000) { at += ms; tick?.(); }
  advance(); advance();
  return { host, cells, writes, advance, elapse(ms) { at += ms; }, cpu(value) { cpu = value; }, free(value) { free = value; }, writable(value) { writable = value; }, throws(value) { throws = value; } };
}

test('current tool mode reports new-controller compatibility without changing saved admission policy or existing advice', () => {
  let mode = 'Native tools only', unavailable = false;
  const f = fixture({ mode: 'both' }, { readToolMode: () => { if (unavailable) throw new Error('Busy settings'); return mode; } });
  const before = f.host.status();
  assert.deepEqual(before.newControllerTools, { known: true, mode, available: false });
  for (mode of ['ToolsEnabled only', 'ToolsEnabled and native tools']) {
    const current = f.host.status(); assert.equal(current.newControllerTools.available, true);
    assert.deepEqual(current.controller, before.controller); assert.equal(current.settings.mode, 'both');
  }
  mode = 'not-a-mode'; assert.deepEqual(f.host.status().newControllerTools, { known: false, mode: null, available: null });
  unavailable = true; assert.equal(f.host.status().newControllerTools.known, false); assert.equal(f.writes.length, 0);
  f.host.dispose();
});

test('reading a saved policy never writes it and mode-only / provider-only changes preserve all other saved values', () => {
  const saved = normalizeSettings({ mode: 'both', reserveBytes: 3 * GIB, providerBytes: { claude: 1.25 * GIB, codex: 2 * GIB, local: 12 * GIB }, maxConcurrentStarts: 16,
    cpuCeilingPercent: 94, cpuBusyPercent: 75, startIntervalMs: 100, busyStartIntervalMs: 2000, settleMs: 9000, sampleMaxAgeMs: 10000 });
  const f = fixture(saved);
  assert.deepEqual(f.host.status().settings, saved); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.host.configure({ mode: 'mechanical' }).settings, { ...saved, mode: 'mechanical' });
  const configured = f.host.configure({ providerBytes: { codex: 512 * MIB } });
  assert.deepEqual(configured.settings, { ...saved, mode: 'mechanical', providerBytes: { ...saved.providerBytes, codex: 512 * MIB } });
  const reopened = fixture(JSON.parse(f.cells[RESOURCE_PREF_KEY]));
  assert.deepEqual(reopened.host.status().settings, configured.settings); assert.equal(reopened.writes.length, 0);
  f.host.dispose(); reopened.host.dispose();
});

test('every numeric bound, malformed object, unknown key and incompatible CPU/pacing pair is refused without changing storage', () => {
  const f = fixture(); const saved = f.host.status().settings;
  const cases = [null, [], true, 'off', { mode: 'unknown' }, { future: true }, { providerBytes: null }, { providerBytes: [] }, { providerBytes: 3 }, { providerBytes: { unknown: MIB } },
    { cpuBusyPercent: 97 }, { cpuCeilingPercent: 79 }, { startIntervalMs: 5001 }, { busyStartIntervalMs: 249 }];
  for (const [key, min, max] of [['cpuCeilingPercent', 50, 99], ['cpuBusyPercent', 20, 98], ['startIntervalMs', 50, 10000], ['busyStartIntervalMs', 250, 30000], ['maxConcurrentStarts', 1, 64]]) {
    for (const value of [min - 1, max + 1, NaN, Infinity, null, '', '250', min + .5]) cases.push({ [key]: value });
  }
  for (const [key, min, max] of [['reserveBytes', 0, 1024 ** 4], ['settleMs', 1000, 30000], ['sampleMaxAgeMs', 1000, 30000]]) {
    for (const value of [min - 1, max + 1, NaN, Infinity, null, '', '250']) cases.push({ [key]: value });
  }
  for (const provider of ['claude', 'codex', 'local']) for (const value of [MIB - 1, 1024 ** 4 + 1, NaN, Infinity, null, '', '250']) cases.push({ providerBytes: { [provider]: value } });
  for (const value of cases) { const result = f.host.configure(value); assert.equal(result.ok, false, JSON.stringify(value)); assert.equal(result.code, 'RESOURCE_SETTINGS_INVALID'); assert.deepEqual(f.host.status().settings, saved); }
  assert.equal(f.writes.length, 0); f.host.dispose();
});

test('valid minimum and maximum settings are accepted, including paired threshold and pacing boundaries', () => {
  for (const next of [
    { cpuCeilingPercent: 50, cpuBusyPercent: 20, startIntervalMs: 50, busyStartIntervalMs: 250, maxConcurrentStarts: 1, reserveBytes: 0, providerBytes: { claude: MIB }, settleMs: 1000, sampleMaxAgeMs: 1000 },
    { cpuCeilingPercent: 99, cpuBusyPercent: 98, startIntervalMs: 10000, busyStartIntervalMs: 30000, maxConcurrentStarts: 64, reserveBytes: 1024 ** 4, providerBytes: { local: 1024 ** 4 }, settleMs: 30000, sampleMaxAgeMs: 30000 },
  ]) { const f = fixture(); const result = f.host.configure(next); assert.equal(result.ok, true, result.reason); for (const key of Object.keys(next).filter(key => key !== 'providerBytes')) assert.equal(result.settings[key], next[key]); f.host.dispose(); }
});

test('thrown and returned write failures retain the active policy; disposed hosts cannot write a new policy', () => {
  const f = fixture({ mode: 'both', cpuCeilingPercent: 94 }); const saved = f.host.status().settings;
  f.writable(false); assert.equal(f.host.configure({ mode: 'off' }).code, 'RESOURCE_SETTINGS_WRITE_FAILED');
  f.writable(true); f.throws(true); assert.equal(f.host.configure({ mode: 'off' }).code, 'RESOURCE_SETTINGS_WRITE_FAILED');
  assert.deepEqual(f.host.status().settings, saved); assert.equal(f.writes.length, 0);
  f.host.dispose(); assert.equal(f.host.configure({ mode: 'off' }).code, 'AGENT_RESOURCE_UNKNOWN'); assert.equal(f.writes.length, 0);
});

test('a lowered CPU ceiling holds immediately, while a steady 85 percent still allows paced starts at the defaults', () => {
  const f = fixture(); f.cpu(85); f.advance(); f.advance(); f.advance();
  assert.equal(f.host.inspect({ provider: 'claude' }).ok, true);
  assert.equal(f.host.configure({ cpuCeilingPercent: 84 }).ok, true);
  assert.equal(f.host.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_PRESSURE');
  f.cpu(84); f.advance(); assert.equal(f.host.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_PRESSURE');
  f.cpu(77); f.advance(); f.advance(); assert.equal(f.host.inspect({ provider: 'claude' }).ok, false);
  f.advance(); assert.equal(f.host.inspect({ provider: 'claude' }).ok, true);
  f.host.configure({ cpuCeilingPercent: 99 }); f.cpu(99); f.advance(); assert.equal(f.host.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_PRESSURE');
  f.host.dispose();
});

test('busy threshold and both pace controls affect reservation and the final provider-root boundary', () => {
  let at = 10000;
  const cfg = { cpuCeilingPercent: 94, cpuBusyPercent: 70, startIntervalMs: 600, busyStartIntervalMs: 1800 };
  const governor = createResourceAdmission({ now: () => at, settings: () => cfg });
  const sample = (cpu = 20) => governor.recordSample({ atMs: at, cpuPercent: cpu, freeBytes: 128 * GIB, totalBytes: 256 * GIB, loopLagMs: 0 });
  sample(); at += 1000; sample(); at += 1000; sample();
  const first = governor.reserve({ provider: 'claude' }); assert.equal(first.ok, true); assert.equal(governor.revalidate(first.token).ok, true);
  at += 599; assert.equal(governor.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_PACING');
  at += 1; const second = governor.reserve({ provider: 'claude' }); assert.equal(second.ok, true); assert.equal(governor.revalidate(second.token).ok, true);
  governor.ready(first.token); governor.ready(second.token);
  for (let i = 0; i < 3; i++) { at += 1000; sample(75); }
  const busy = governor.reserve({ provider: 'claude' }); assert.equal(busy.ok, true); assert.equal(busy.state.headroomWindow, false); assert.equal(governor.revalidate(busy.token).ok, true); governor.ready(busy.token);
  at += 1799; assert.equal(governor.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_PACING');
  at += 1; sample(75); assert.equal(governor.reserve({ provider: 'claude' }).ok, true);
});

test('parallel control is an actual startup cap up to 64; provider footprints and keep-free RAM can reduce admission', () => {
  for (const limit of [1, 8, 16, 64]) {
    const f = fixture({ maxConcurrentStarts: limit, startIntervalMs: 50 });
    for (let index = 0; index < limit; index++) { assert.equal(f.host.reserve({ provider: 'claude' }).ok, true, `launch ${index + 1} of ${limit}`); f.elapse(50); }
    assert.equal(f.host.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_STARTS_BUSY'); f.host.dispose();
  }
  const f = fixture({ reserveBytes: 4 * GIB, providerBytes: { claude: 512 * MIB, codex: GIB, local: 16 * GIB } }); f.free(5 * GIB); f.advance();
  assert.equal(f.host.status().admission.claude.ok, true); assert.equal(f.host.status().admission.local.code, 'AGENT_MEMORY_LOW');
  const first = f.host.reserve({ provider: 'claude' }); assert.equal(first.ok, true); f.elapse(250);
  assert.equal(f.host.inspect({ provider: 'codex' }).code, 'AGENT_MEMORY_LOW');
  assert.equal(f.host.configure({ reserveBytes: 3 * GIB }).ok, true); assert.equal(f.host.inspect({ provider: 'codex' }).ok, true); f.host.dispose();
});

test('a 50-agent tree can populate at the selected pace without a running-agent ceiling, while settled RAM is measured before release', () => {
  let at = 10000; const governor = createResourceAdmission({ now: () => at });
  const sample = () => governor.recordSample({ atMs: at, cpuPercent: 20, freeBytes: 128 * GIB, totalBytes: 256 * GIB, loopLagMs: 0 });
  sample(); at += 1000; sample(); at += 1000; sample(); const began = at;
  for (let index = 0; index < 50; index++) {
    const result = governor.reserve({ provider: 'claude' }); assert.equal(result.ok, true, `node ${index + 1}: ${result.code}`);
    assert.equal(governor.revalidate(result.token).ok, true); governor.ready(result.token); at += DEFAULT_SETTINGS.startIntervalMs;
    if ((index + 1) % 4 === 0) sample();
  }
  assert.equal(at - began, 12500); assert.equal(governor.snapshot().starting, 0); assert.ok(governor.snapshot().settling > 0);
  console.log('50 simulated tree starts admitted in 12.5 seconds at default pace with measured synthetic CPU/RAM headroom. No provider process launched.');
});
