'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseLinuxCpuStat, parseClockTicks, cpuInterval, createLinuxCpuSampler } = require('../tools/lib/process-cpu-sample');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Execute the actual CLI caller with a deterministic kernel/process boundary.
// No real process, owner state, or thirty-second sleep is needed for these
// timing and failure-classification cases.
async function runCaller({ unreadableAt = -1, busy = false, readLatency = 1000 } = {}) {
  let clock = 0, reads = 0, killed = false, stdout = '', stderr = '';
  const child = new EventEmitter(); child.pid = 42;
  child.kill = () => { killed = true; child.emit('exit', 0, 'SIGTERM'); };
  const localModule = { exports: {} };
  const filename = path.resolve(__dirname, '../tools/idle-cpu-check.js');
  const fakeProcess = { platform: 'linux', execPath: process.execPath,
    stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } };
  const fakeRequire = name => {
    if (name === 'node:child_process') return { spawn: () => child, execFileSync: () => '100\n' };
    if (name === 'node:perf_hooks') return { performance: { now: () => clock } };
    if (name === 'node:fs') return { readFileSync: () => {
      clock += readLatency;
      if (reads++ === unreadableAt) throw new Error('unreadable procfs sample');
      return stat({ user: busy ? reads * 100 : reads >= 5 ? 20 : 0, system: 0 });
    } };
    if (name === './lib/process-cpu-sample') return require('../tools/lib/process-cpu-sample');
    if (name.endsWith('/subscription-launch-env.js')) return { safeLaunchEnvironment: () => ({}) };
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: fakeRequire, module: localModule, __dirname: path.dirname(filename),
    process: fakeProcess, setTimeout: (callback, delay) => { clock += delay; queueMicrotask(callback); },
  }, { filename });
  await localModule.exports.main();
  return { stdout, stderr, code: fakeProcess.exitCode, reads, killed };
}

test('idle CPU caller includes final counter-read latency in the measured interval', async () => {
  const result = await runCaller();
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /0\.2000s CPU consumed over 31\.00s idle .*0\.6452%/);
  assert.equal(result.killed, true);
});

test('unreadable initial or settling counters report inability to measure, never activity', async () => {
  for (const unreadableAt of [0, 1]) {
    const result = await runCaller({ unreadableAt });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /COULD NOT MEASURE: could not read CPU time/);
    assert.doesNotMatch(result.stdout, /never idle|PASS:/);
    assert.equal(result.killed, true);
  }
});

test('readable continuously busy counters fail settling with an activity finding', async () => {
  const result = await runCaller({ busy: true });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL: the process never went quiet/);
  assert.equal(result.stderr, '');
  assert.equal(result.killed, true);
});

function stat({ pid = 42, name = 'worker ) with spaces', user = 250, system = 50, started = 1234 } = {}) {
  const fields = ['S', ...Array(49).fill('0')];
  fields[11] = String(user); fields[12] = String(system); fields[19] = String(started);
  return pid + ' (' + name + ') ' + fields.join(' ') + '\n';
}

test('Linux accounting reads both CPU counters after a comm containing spaces and parentheses', () => {
  assert.deepEqual(parseLinuxCpuStat(stat(), 42, 100), { pid: 42, startTicks: '1234', cpuSeconds: 3 });
  assert.equal(parseLinuxCpuStat(stat({ user: 25, system: 75 }), 42, 250).cpuSeconds, 0.4);
  assert.equal(parseLinuxCpuStat(stat({ user: 0, system: 0, started: 0 }), 42, 100).cpuSeconds, 0);
});

test('Linux accounting refuses another PID malformed fields and unsafe counters', () => {
  assert.throws(() => parseLinuxCpuStat(stat({ pid: 43 }), 42, 100), /different or unreadable/);
  for (const value of ['', '42 (incomplete) S 1', stat({ user: -1 }), stat({ system: 'nan' }),
    stat({ user: '9007199254740992' }), stat({ started: 'unknown' })]) {
    assert.throws(() => parseLinuxCpuStat(value, 42, 100));
  }
  for (const value of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => parseLinuxCpuStat(stat(), 42, value));
});

test('clock tick rate refuses missing zero malformed and unbounded readings', () => {
  assert.equal(parseClockTicks('100\n'), 100);
  assert.equal(parseClockTicks('250'), 250);
  for (const value of ['', '0', '-1', '100\n200', '1.5', 'nan', '9007199254740992']) assert.throws(() => parseClockTicks(value));
});

test('sampler retains the process start identity and measures the clock rate once', () => {
  let current = stat(), clockReads = 0;
  const sample = createLinuxCpuSampler({ readStat: () => current, readClockTicks: () => { clockReads++; return '100\n'; } });
  assert.equal(sample(42), 3);
  current = stat({ user: 300 });
  assert.equal(sample(42), 3.5);
  assert.equal(clockReads, 1);
  current = stat({ started: 9999 });
  assert.throws(() => sample(42), /process identity changed/);
  assert.throws(() => sample(0), /positive process ID/);
});

test('CPU intervals never turn a decreasing counter or unreadable measurement into idle zero', () => {
  const measured = cpuInterval(1, 1.3, 30);
  assert.ok(Math.abs(measured.deltaSeconds - 0.3) < 1e-10);
  assert.ok(Math.abs(measured.percentOfOneCore - 1) < 1e-10);
  assert.deepEqual(cpuInterval(1, 1, 30), { deltaSeconds: 0, percentOfOneCore: 0 });
  for (const args of [[2, 1, 30], [-1, 0, 30], [0, Infinity, 30], [0, 1, 0], [0, 1, -1], [null, 0, 30]]) {
    assert.throws(() => cpuInterval(...args), /invalid|decreased/);
  }
});
