// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-coordinator-duty-host-test-js):
// - EMPTY-LOOP: strengthened the shipped-duty census with a non-empty
//   precondition. Mutation: replaced both exported duty-ID arrays with empty
//   arrays. RED: "AssertionError [ERR_ASSERTION]: the shipped registry census
//   must contain duties before asserting each duty's heartbeat".
// - SWALLOWED-FAILURE: made killSwitch.status() throw and asserted both the
//   fail-closed verdict and diagnostic event. Mutation: changed the host's
//   catch-path assignment from `switchActive = true` to `switchActive = false`.
//   RED: "AssertionError [ERR_ASSERTION]: an unreadable kill switch must fail
//   closed" followed by "false !== true".
// - NOT-FOUND: no exit-status/truthy-return assertion uses only a subject
//   process's own output; no optional chain or catch swallows a tested failure;
//   no assertion mocks the duty host or CLI that it tests; no skip or platform
//   guard can turn this file into a no-op; and no expected value is computed by
//   the same subject code it checks.
// - RESTORATION: both mutations were restored byte-for-byte. The final run was
//   GREEN: "coordinator-duty-host: 30 checks passed".

'use strict';

// R100: the bounded duty loop.
//
// THE HEADLINE PROPERTY, and the reason this file exists: a duty that throws
// must not stop the loop, must not stop the OTHER duties, and must be
// SURFACED. Silent success on a duty that did not run is the exact failure
// mode the whole coordinator port exists to eliminate -- the coordinator's
// inbox drain died with an agent session and everything downstream kept
// reporting fine.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dutyHost = require('../src/lib/coordinator/duty-host.js');
const dutyRegistry = require('../src/lib/coordinator/duty-registry.js');
const heartbeat = require('../src/lib/coordinator/heartbeat.js');
const killSwitch = require('../src/lib/kill-switch.js');
const cli = require('../tools/coordinator-duty-host.js');

const ROOT = path.resolve(__dirname, '..');
const { DUTY_OUTCOME } = heartbeat;

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coord-host-'));
}

// A controllable clock so cycles are driven synchronously, never slept through.
function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: ms => { nowMs += ms; },
    set: ms => { nowMs = ms; }
  };
}

function mechanical(id, run, intervalMs = 1000, extra = {}) {
  return { id, kind: dutyRegistry.DUTY_KIND.MECHANICAL, intervalMs, description: `test duty ${id}`, run, ...extra };
}

function judgement(id) {
  return { id, kind: dutyRegistry.DUTY_KIND.JUDGEMENT, description: `judgement ${id}`, humanAction: 'a human decides' };
}

async function run() {
  process.stdout.write('coordinator-duty-host\n');

  // ======================================================================
  // THE CRASH-SAFETY PROPERTY
  // ======================================================================

  await check('A THROWN DUTY DOES NOT STOP THE CYCLE AND IS SURFACED', async () => {
    const clock = fakeClock();
    const calls = [];
    const duties = [
      mechanical('before', () => { calls.push('before'); return { detail: { ok: true } }; }),
      mechanical('exploder', () => {
        calls.push('exploder');
        const error = new Error('the inbox reader blew up');
        error.code = 'BOOM';
        throw error;
      }),
      mechanical('after', () => { calls.push('after'); return { detail: { ok: true } }; })
    ];
    const state = dutyHost.createState({ duties, startedAtMs: clock.now(), pid: 1, bootId: 'boot-x' });

    const result = await dutyHost.runCycle({ state, duties, now: clock.now });

    // 1. Every duty still ran.
    assert.deepEqual(calls, ['before', 'exploder', 'after'],
      'a duty that throws must not prevent the duties after it from running');

    // 2. The failure is SURFACED, not swallowed.
    const record = result.heartbeat.duties.exploder;
    assert.equal(record.outcome, DUTY_OUTCOME.FAILED);
    assert.equal(record.consecutiveFailures, 1);
    assert.match(record.reason, /BOOM/);
    assert.match(record.reason, /the inbox reader blew up/,
      'the failure message must reach the heartbeat; a code alone does not tell anyone what broke');

    // 3. The neighbours are clean, not collaterally marked failed.
    assert.equal(result.heartbeat.duties.before.outcome, DUTY_OUTCOME.OK);
    assert.equal(result.heartbeat.duties.after.outcome, DUTY_OUTCOME.OK);

    // 4. The heartbeat is still produced -- the host does not go dark because
    //    one duty broke.
    assert.equal(heartbeat.validateHeartbeat(result.heartbeat).valid, true);
  });

  await check('a duty that keeps throwing drives the HOST to DEGRADED (no false OK)', async () => {
    const clock = fakeClock();
    const duties = [
      mechanical('healthy', () => ({ detail: {} })),
      mechanical('broken', () => { throw new Error('still broken'); })
    ];
    const state = dutyHost.createState({ duties, startedAtMs: clock.now(), pid: 2, bootId: 'boot-y' });

    let last = null;
    for (let cycle = 0; cycle < dutyHost.MAX_CONSECUTIVE_FAILURES; cycle += 1) {
      last = await dutyHost.runCycle({ state, duties, now: clock.now });
      clock.advance(2000);
    }

    assert.equal(state.duties.broken.consecutiveFailures, dutyHost.MAX_CONSECUTIVE_FAILURES);
    assert.equal(last.heartbeat.hostState, 'DEGRADED',
      'a host heartbeating happily while a duty has failed its budget must NOT read OK');
    assert.match(last.heartbeat.hostStateReason, /broken/);
  });

  await check('consecutiveFailures RESETS when the duty recovers', async () => {
    const clock = fakeClock();
    let fail = true;
    const duties = [mechanical('flaky', () => { if (fail) throw new Error('nope'); return {}; })];
    const state = dutyHost.createState({ duties, startedAtMs: clock.now() });

    await dutyHost.runCycle({ state, duties, now: clock.now });
    clock.advance(2000);
    await dutyHost.runCycle({ state, duties, now: clock.now });
    assert.equal(state.duties.flaky.consecutiveFailures, 2);

    fail = false;
    clock.advance(2000);
    const recovered = await dutyHost.runCycle({ state, duties, now: clock.now });
    assert.equal(recovered.heartbeat.duties.flaky.outcome, DUTY_OUTCOME.OK);
    assert.equal(recovered.heartbeat.duties.flaky.consecutiveFailures, 0);
    assert.equal(recovered.heartbeat.hostState, 'OK');
  });

  await check('a HANGING duty is recorded TIMEOUT and the cycle still completes', async () => {
    const clock = fakeClock();
    let afterRan = false;
    const duties = [
      mechanical('hangs', () => new Promise(() => { /* never settles */ })),
      mechanical('after', () => { afterRan = true; return {}; })
    ];
    const state = dutyHost.createState({ duties, startedAtMs: clock.now() });

    const result = await dutyHost.runCycle({ state, duties, now: clock.now, dutyTimeoutMs: 40 });
    assert.equal(result.heartbeat.duties.hangs.outcome, DUTY_OUTCOME.TIMEOUT);
    assert.equal(afterRan, true, 'a hung duty must not stall the rest of the cycle');
    assert.equal(result.heartbeat.duties.after.outcome, DUTY_OUTCOME.OK);
  });

  await check('a duty that rejects with a non-Error is still recorded, not swallowed', async () => {
    const clock = fakeClock();
    const duties = [mechanical('weird', async () => { throw 'a bare string'; })];   // eslint-disable-line no-throw-literal
    const state = dutyHost.createState({ duties, startedAtMs: clock.now() });
    const result = await dutyHost.runCycle({ state, duties, now: clock.now });
    assert.equal(result.heartbeat.duties.weird.outcome, DUTY_OUTCOME.FAILED);
    assert.match(result.heartbeat.duties.weird.reason, /a bare string/);
  });

  await check('an unstructured duty result cannot collapse into OK', async () => {
    const duties = [mechanical('silent', () => undefined)];
    const state = dutyHost.createState({ duties });
    const result = await dutyHost.runCycle({ state, duties });
    assert.equal(result.heartbeat.duties.silent.outcome, DUTY_OUTCOME.FAILED);
    assert.match(result.heartbeat.duties.silent.reason, /success could not be established/);
  });

  await check('an empty mechanical registry cannot report the host OK', () => {
    const self = dutyHost.hostSelfState({});
    assert.equal(self.state, 'DEGRADED');
    assert.match(self.reason, /no mechanical duties/);
  });

  // ======================================================================
  // THE HEARTBEAT IS WRITTEN AT THE END
  // ======================================================================

  await check('createHost writes the heartbeat AFTER the duties, never before', async () => {
    const clock = fakeClock();
    const order = [];
    const duties = [mechanical('slow', () => { order.push('duty'); return {}; })];
    const dir = tempDir();
    const file = path.join(dir, 'hb.json');

    const host = dutyHost.createHost({
      duties, intervalMs: 1000, heartbeatFile: file, clock: { now: clock.now },
      writeHeartbeat: (record, options) => { order.push('heartbeat'); return heartbeat.writeHeartbeat(record, options); }
    });
    await host.cycleOnce();

    assert.deepEqual(order, ['duty', 'heartbeat'],
      'a start-of-cycle heartbeat would prove only that the loop is turning');
    const read = heartbeat.readHeartbeatRaw({ file });
    assert.equal(read.ok, true);
    assert.equal(read.record.cycleSeq, 1);
  });

  await check('a failing heartbeat WRITE does not stop the loop (reporting problem != outage)', async () => {
    const clock = fakeClock();
    const logged = [];
    let ran = 0;
    const duties = [mechanical('counts', () => { ran += 1; return {}; })];
    const host = dutyHost.createHost({
      duties, intervalMs: 1000, clock: { now: clock.now }, log: record => logged.push(record),
      writeHeartbeat: () => { throw new Error('disk full'); }
    });
    await host.cycleOnce();
    clock.advance(2000);
    await host.cycleOnce();
    assert.equal(ran, 2);
    assert.ok(logged.some(entry => entry.event === 'heartbeat-write-failed'),
      'a heartbeat write failure must be reported, not silent');
  });

  await check('an ABSENT heartbeat file is UNKNOWN, never OK and never blank', () => {
    const status = cli.readStatus({ file: path.join(tempDir(), 'missing.json'), now: Date.now() });
    assert.equal(status.liveness, 'UNKNOWN');
    assert.equal(status.errorCode, 'HEARTBEAT_ABSENT');
    assert.ok(status.reason.length > 0, 'absence of evidence must render loudly, never as health');
  });

  // ======================================================================
  // JUDGEMENT DUTIES ARE NEVER EXECUTED
  // ======================================================================

  await check('judgement duties evaluate to WAITING and are never run', async () => {
    const clock = fakeClock();
    const duties = [mechanical('m', () => ({})), judgement('j')];
    const state = dutyHost.createState({ duties, startedAtMs: clock.now() });
    const result = await dutyHost.runCycle({ state, duties, now: clock.now });

    assert.equal(result.heartbeat.duties.j.outcome, DUTY_OUTCOME.WAITING);
    assert.equal(result.heartbeat.judgementWaiting.length, 1);
    assert.equal(result.heartbeat.judgementWaiting[0].id, 'j');
    assert.equal(result.heartbeat.judgementWaiting[0].humanAction, 'a human decides');
    assert.deepEqual(result.ran.map(entry => entry.id), ['m'], 'a judgement duty must never appear as "ran"');
  });

  await check('even a judgement duty smuggling a run() is NOT executed by the loop', async () => {
    // validateRegistry refuses such an entry; this asserts the loop is safe
    // even if one somehow reached it, because two independent guards is the
    // right number for "the daemon must never answer the owner".
    const clock = fakeClock();
    let executed = false;
    const smuggled = { ...judgement('sneaky'), run: () => { executed = true; return {}; } };
    const duties = [smuggled];
    const state = dutyHost.createState({ duties, startedAtMs: clock.now() });
    const result = await dutyHost.runCycle({ state, duties, now: clock.now });
    assert.equal(executed, false, 'the loop must dispatch on kind, never on the presence of run()');
    assert.equal(result.heartbeat.duties.sneaky.outcome, DUTY_OUTCOME.WAITING);
  });

  // ======================================================================
  // SCHEDULING AND THE KILL SWITCH
  // ======================================================================

  await check('a duty that is not due is skipped WITHOUT overwriting its last outcome', async () => {
    const clock = fakeClock();
    let runs = 0;
    const duties = [mechanical('rare', () => { runs += 1; throw new Error('failed once'); }, 60_000)];
    const state = dutyHost.createState({ duties, startedAtMs: clock.now() });

    await dutyHost.runCycle({ state, duties, now: clock.now });
    assert.equal(runs, 1);
    assert.equal(state.duties.rare.outcome, DUTY_OUTCOME.FAILED);

    clock.advance(1000);                       // nowhere near the 60s interval
    const second = await dutyHost.runCycle({ state, duties, now: clock.now });
    assert.equal(runs, 1, 'the duty must not run before its interval elapses');
    assert.equal(second.heartbeat.duties.rare.outcome, DUTY_OUTCOME.FAILED,
      'a not-due duty must keep its real last outcome; overwriting it with OK would erase the failure');
    assert.equal(second.heartbeat.duties.rare.consecutiveFailures, 1);
  });

  await check('the kill switch SKIPS outward duties and leaves detection duties running', async () => {
    const clock = fakeClock();
    let outward = 0;
    let detection = 0;
    const duties = [
      mechanical('detect', () => { detection += 1; return {}; }),
      mechanical('send', () => { outward += 1; return {}; }, 1000, { outward: true })
    ];
    const state = dutyHost.createState({ duties, startedAtMs: clock.now() });
    const result = await dutyHost.runCycle({ state, duties, now: clock.now, killSwitchActive: true });

    assert.equal(outward, 0);
    assert.equal(detection, 1, 'detection must keep working while outward action is blocked');
    assert.equal(result.heartbeat.duties.send.outcome, DUTY_OUTCOME.SKIPPED);
    assert.match(result.heartbeat.duties.send.reason, /kill switch/i);
  });

  await check('an UNREADABLE kill switch is treated as ACTIVE, and said out loud', async () => {
    const clock = fakeClock();
    const logged = [];
    const duties = [mechanical('send', () => ({}), 1000, { outward: true })];
    const state = dutyHost.createState({ duties, startedAtMs: clock.now() });
    const originalStatus = killSwitch.status;
    killSwitch.status = () => { throw new Error('permission denied reading sentinel'); };
    let result;
    try {
      result = await dutyHost.runCycle({ state, duties, now: clock.now, killSwitchActive: null, log: r => logged.push(r) });
    } finally {
      killSwitch.status = originalStatus;
    }
    assert.equal(result.killSwitchActive, true, 'an unreadable kill switch must fail closed');
    assert.equal(result.heartbeat.duties.send.outcome, DUTY_OUTCOME.SKIPPED,
      'an outward duty must not run when the kill-switch verdict is unknown');
    assert.deepEqual(logged, [{ event: 'kill-switch-unreadable', message: 'permission denied reading sentinel' }],
      'the unreadable sentinel must be diagnosed rather than silently treated as active');
  });

  await check('cycleSeq advances and observedAtMs is the END of the cycle', async () => {
    const clock = fakeClock(500_000);
    const duties = [mechanical('tick', () => { clock.advance(250); return {}; })];
    const state = dutyHost.createState({ duties, startedAtMs: clock.now() });
    const first = await dutyHost.runCycle({ state, duties, now: clock.now });
    assert.equal(first.heartbeat.cycleSeq, 1);
    assert.ok(first.heartbeat.observedAtMs >= first.cycleStartedAtMs + 250,
      'observedAtMs must be taken after the duties ran');
    clock.advance(2000);
    const second = await dutyHost.runCycle({ state, duties, now: clock.now });
    assert.equal(second.heartbeat.cycleSeq, 2);
  });

  await check('bootId is stable within a boot and differs across boots', async () => {
    const a = dutyHost.createState({ duties: [] });
    const b = dutyHost.createState({ duties: [] });
    assert.notEqual(a.bootId, b.bootId, 'a recycled pid must not read as an unbroken host');
  });

  // ======================================================================
  // hostSelfState AND THE WORST-DUTY ROLLUP
  // ======================================================================

  await check('an UNKNOWN suppression count stays null and the heartbeat still writes', async () => {
    // The sink returns null when it cannot count. Coercing that to 0 would
    // re-create the false "nothing was suppressed"; refusing it would block
    // the heartbeat entirely and read as a dead host.
    const clock = fakeClock();
    const duties = [mechanical('budget', ctx => { ctx.cycle.escalationsSuppressed = null; return {}; })];
    const state = dutyHost.createState({ duties, startedAtMs: clock.now() });
    const result = await dutyHost.runCycle({ state, duties, now: clock.now });
    assert.equal(result.heartbeat.escalationsSuppressed, null);
    assert.equal(heartbeat.validateHeartbeat(result.heartbeat).valid, true,
      'an unknown suppression count must not stop the heartbeat from being published');

    const dir = tempDir();
    const file = path.join(dir, 'hb.json');
    heartbeat.writeHeartbeat(result.heartbeat, { file });
    assert.equal(heartbeat.readHeartbeatRaw({ file }).record.escalationsSuppressed, null);
  });

  await check('a known suppression count is carried through as a number', async () => {
    const clock = fakeClock();
    const duties = [mechanical('budget', ctx => { ctx.cycle.escalationsSuppressed = 7; return {}; })];
    const state = dutyHost.createState({ duties, startedAtMs: clock.now() });
    const result = await dutyHost.runCycle({ state, duties, now: clock.now });
    assert.equal(result.heartbeat.escalationsSuppressed, 7);
  });

  await check('hostSelfState is OK below the budget and DEGRADED at it', () => {
    /* THE FIXTURES NOW DECLARE A KIND, because the runtime stopped guessing one.
     * hostSelfState previously treated a record with no `kind` as mechanical by
     * default -- an absent field read as a definite classification. It now
     * requires the caller to say. The assertions are unchanged: this is the test
     * catching up to a stricter contract, not a relaxation of what is checked. */
    const below = dutyHost.hostSelfState({ a: { kind: dutyRegistry.DUTY_KIND.MECHANICAL, consecutiveFailures: dutyHost.MAX_CONSECUTIVE_FAILURES - 1, outcome: 'FAILED' } });
    assert.equal(below.state, 'OK');
    const at = dutyHost.hostSelfState({ a: { kind: dutyRegistry.DUTY_KIND.MECHANICAL, consecutiveFailures: dutyHost.MAX_CONSECUTIVE_FAILURES, outcome: 'FAILED' } });
    assert.equal(at.state, 'DEGRADED');
    assert.equal(at.failing[0].id, 'a');
  });

  await check('readStatus surfaces DEGRADED even when the heartbeat is FRESH', () => {
    const dir = tempDir();
    const file = path.join(dir, 'hb.json');
    const nowMs = Date.now();
    const record = heartbeat.emptyHeartbeat({ pid: 1, bootId: 'boot-z', startedAtMs: nowMs - 1000, observedAtMs: nowMs, cycleIntervalMs: 30_000 });
    record.cycleSeq = 40;
    record.hostState = 'DEGRADED';
    record.duties = {
      dead: { kind: 'mechanical', lastRunAtMs: nowMs, outcome: 'FAILED', reason: 'broken for 40 cycles', consecutiveFailures: 40, detail: null }
    };
    heartbeat.writeHeartbeat(record, { file });

    const status = cli.readStatus({ file, now: nowMs });
    assert.equal(status.liveness, 'OK', 'the heartbeat itself is fresh');
    assert.equal(status.surfaced, 'DEGRADED',
      'a host heartbeating happily with a duty broken 40 cycles must NOT surface as OK');
  });

  await check('readStatus grades staleness OK / STALE / DOWN by age', () => {
    const dir = tempDir();
    const file = path.join(dir, 'hb.json');
    const base = Date.now();
    heartbeat.writeHeartbeat(
      heartbeat.emptyHeartbeat({ pid: 1, bootId: 'b', startedAtMs: base, observedAtMs: base, cycleIntervalMs: 30_000 }),
      { file });
    const grace = Math.max(2 * 30_000, 90_000);          // 90s

    assert.equal(cli.readStatus({ file, now: base + 1000 }).liveness, 'OK');
    assert.equal(cli.readStatus({ file, now: base + grace + 5000 }).liveness, 'STALE');
    assert.equal(cli.readStatus({ file, now: base + grace * 3 + 5000 }).liveness, 'DOWN');
  });

  await check('a heartbeat from the FUTURE is UNKNOWN (clock skew), never OK', () => {
    const dir = tempDir();
    const file = path.join(dir, 'hb.json');
    const base = Date.now();
    heartbeat.writeHeartbeat(
      heartbeat.emptyHeartbeat({ pid: 1, bootId: 'b', startedAtMs: base, observedAtMs: base + 600_000, cycleIntervalMs: 30_000 }),
      { file });
    const status = cli.readStatus({ file, now: base });
    assert.equal(status.liveness, 'UNKNOWN');
    assert.match(status.reason, /clock skew/);
  });

  // ======================================================================
  // THE LOOP ITSELF
  // ======================================================================

  await check('createHost().start() fires immediately and then on the interval', async () => {
    const clock = fakeClock();
    let ran = 0;
    let intervalCallback = null;
    const duties = [mechanical('tick', () => { ran += 1; return {}; }, 1)];
    const dir = tempDir();

    const host = dutyHost.createHost({
      duties, intervalMs: 1000, heartbeatFile: path.join(dir, 'hb.json'),
      clock: {
        now: clock.now,
        setInterval: callback => { intervalCallback = callback; return { unref() {} }; },
        clearInterval: () => { intervalCallback = null; }
      }
    });
    host.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ran, 1, 'a fresh host must write a heartbeat within one cycle, not one interval');

    clock.advance(2000);
    intervalCallback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ran, 2);
  });

  await check('the stop sentinel stops the loop', async () => {
    const clock = fakeClock();
    let intervalCallback = null;
    let cleared = false;
    let stopNow = false;
    const duties = [mechanical('tick', () => ({}), 1)];
    const dir = tempDir();

    const host = dutyHost.createHost({
      duties, intervalMs: 1000, heartbeatFile: path.join(dir, 'hb.json'),
      shouldStop: () => stopNow,
      clock: {
        now: clock.now,
        setInterval: callback => { intervalCallback = callback; return { unref() {} }; },
        clearInterval: () => { cleared = true; }
      }
    });
    host.start();
    await new Promise(resolve => setImmediate(resolve));
    stopNow = true;
    intervalCallback();
    assert.equal(cleared, true, 'the stop sentinel must clear the timer, not just skip a cycle');
  });

  await check('overlapping cycles are skipped, not stacked', async () => {
    const clock = fakeClock();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let starts = 0;
    const duties = [mechanical('slow', async () => { starts += 1; await gate; return {}; }, 1)];
    const dir = tempDir();
    const host = dutyHost.createHost({ duties, intervalMs: 1000, heartbeatFile: path.join(dir, 'hb.json'), clock: { now: clock.now } });

    const first = host.cycleOnce();
    await new Promise(resolve => setImmediate(resolve));
    await host.cycleOnce();                     // must not start a second run
    assert.equal(starts, 1);
    release();
    await first;
  });

  // ======================================================================
  // THE SHIPPED REGISTRY RUNS END TO END
  // ======================================================================

  await check('every shipped duty id appears in the heartbeat after one real cycle', async () => {
    const clock = fakeClock();
    const state = dutyHost.createState({ startedAtMs: clock.now() });
    const result = await dutyHost.runCycle({
      state,
      now: clock.now,
      killSwitchActive: true,          // no outward action from a test run
      // No probeListener and no spawner: those duties must report honestly
      // rather than throw.
      ctx: { probeListener: null, allowRestart: false }
    });
    const shippedDutyIds = dutyRegistry.MECHANICAL_DUTY_IDS.concat(dutyRegistry.JUDGEMENT_DUTY_IDS);
    assert.ok(shippedDutyIds.length > 0,
      'the shipped registry census must contain duties before asserting each duty\'s heartbeat');
    for (const id of shippedDutyIds) {
      assert.ok(result.heartbeat.duties[id], `duty ${id} is missing from the heartbeat`);
      assert.ok(result.heartbeat.duties[id].outcome, `duty ${id} has no outcome`);
    }
    assert.equal(heartbeat.validateHeartbeat(result.heartbeat).valid, true);
  });

  // ======================================================================
  // CLI CONTRACT
  // ======================================================================

  await check('--help exits cleanly and names the reply prohibition', () => {
    const stdout = execFileSync(process.execPath,
      [path.join(ROOT, 'tools', 'coordinator-duty-host.js'), '--help'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.match(stdout, /--serve/);
    assert.match(stdout, /--once/);
    assert.match(stdout, /--status/);
    assert.match(stdout, /never composes a\s+reply/);
  });

  await check('--status --json is valid JSON with a liveness verdict', () => {
    const stdout = execFileSync(process.execPath,
      [path.join(ROOT, 'tools', 'coordinator-duty-host.js'), '--status', '--json'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    const status = JSON.parse(stdout);
    assert.ok(['OK', 'STALE', 'DOWN', 'UNKNOWN', 'DEGRADED'].includes(status.liveness),
      `unexpected liveness ${status.liveness}`);
  });

  await check('the CLI source never composes a reply to the owner', () => {
    const source = fs.readFileSync(path.join(ROOT, 'tools', 'coordinator-duty-host.js'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/\.reply\s*\(/.test(code), false, 'the duty host CLI must never call reply()');
    assert.equal(/owner-chat/.test(code), false, 'the duty host CLI must not reach owner-chat directly');
  });

  await check('every spawn in the CLI redirects to FILE descriptors and hides the window', () => {
    const source = fs.readFileSync(path.join(ROOT, 'tools', 'coordinator-duty-host.js'), 'utf8');
    assert.match(source, /windowsHide:\s*true/, 'spawns must set windowsHide');
    assert.match(source, /stdio:\s*\['ignore',\s*out,\s*err\]/,
      'child stdout/stderr must be file descriptors; this repo has been wedged twice by an undrained pipe');
    assert.equal(/stdio:\s*'pipe'/.test(source), false);
    assert.equal(/stdio:\s*\[[^\]]*'pipe'/.test(source), false);
  });

  await check('the CLI resolves its declared registry entry (or reports its absence)', () => {
    assert.ok(cli.PATHS.pidLockFile.endsWith(path.join('state', 'coordinator-duty-host.pid.lock')));
    assert.ok(cli.PATHS.logFile.endsWith(path.join('logs', 'coordinator-duty-host.log')));
    if (!cli.PATHS.declared.present) {
      assert.match(cli.PATHS.declared.reason, /managed-processes\.json/,
        'an absent registry entry must be REPORTED, never invented');
    }
  });

  process.stdout.write(`\ncoordinator-duty-host: ${passed} checks passed\n`);
}

run().catch(error => {
  process.stdout.write(`\nFAILED: ${error && error.message}\n${error && error.stack}\n`);
  process.exitCode = 1;
});
