#!/usr/bin/env node
'use strict';

// BUILD-QUEUE Q116.5 -- reproducible idle-CPU ceiling check.
//
// WHAT THIS MEASURES. The core, always-present customer-facing product
// process: `node src/mcp-server.js`, run exactly as a real MCP client (Claude
// Code, Codex, or the owner-host proxy in front of it) runs it -- spawned,
// left with its stdin open and unwritten, and never sent a single request.
// That is what sits on a customer's machine between tool calls: no different
// from every other minute of every session. If this process burns CPU while
// nothing is asking it to, that cost is charged to every install, all day,
// whether or not the product is in active use -- exactly the shape of the
// bug fixed in commit 48598d3 (a DPAPI vault read shelled out to a fresh
// powershell.exe every 2s on three listeners, ~43,200 spawns/day each).
//
// THE CEILING: 1% of one logical CPU core, sustained over a >=30s idle
// window, per idle product process.
//   - Directly measured (this repo, 2026-08-10, 16 logical cores): every one
//     of 12 sampled live mcp-server.js/mcp-owner-proxy.js/owner-host.js/
//     mission-bridge.js instances that had no in-flight request showed
//     EXACTLY 0.000% CPU delta over a real 35s window (see the Q116.5 report
//     for the full sample). 1% leaves ~30-100x headroom above that measured
//     reality before this check would even flag a healthy process, room for
//     GC/event-loop bookkeeping noise and a slower reference machine.
//   - The bug this whole effort exists to catch was NOT subtle at this scale:
//     one powershell.exe spawn every 2s cost roughly 5-7% of one core,
//     continuously (commit 8811d24: "8+ CPU-hours" over ~6 days on one
//     listener). A 1% ceiling catches that class of regression with margin
//     to spare long before it reaches the severity that made the owner's
//     machine unusable, rather than waiting until it is that bad again.
//   - Per-process, not aggregate: a customer runs one client, not the four-plus
//     concurrent sessions a dev/test machine like this one carries. Per-process
//     is the number that is true regardless of how many sessions someone runs.
//
// REPRODUCE: node tools/idle-cpu-check.js
// Exit 0 = under ceiling (PASS). Exit 1 = at/over ceiling (FAIL) or a
// measurement could not be taken (reported honestly, never silently passed).

const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { createLinuxCpuSampler, cpuInterval } = require('./lib/process-cpu-sample');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env.js');

const ROOT = path.resolve(__dirname, '..');
const TARGET_SCRIPT = path.join(ROOT, 'src', 'mcp-server.js');
// WAIT FOR STARTUP TO ACTUALLY FINISH, RATHER THAN GUESSING HOW LONG IT TAKES.
//
// This was a flat 3s sleep, on the reasoning that module-load CPU is "a one-time
// cost, not idle drain" -- correct reasoning, wrong number. Measured on this
// machine 2026-08-17, sampling a freshly spawned mcp-server every 2s: it was
// still burning 1.63% and 1.59% of one core at t+4s and t+6s, and only reached
// 0.00% from t+8s onward, where it then stayed for the remaining 24 seconds.
//
// So a 3s warmup left roughly five seconds of startup inside a window labelled
// "idle", and the check reported it as idle drain. Four consecutive runs came
// back 0.9372%, 0.1041%, 0.5729% and 1.3538% -- a 13x spread against a 1.0%
// ceiling, with the FAIL arriving on the LEAST loaded run. That spread is not
// the product being erratic; it is startup finishing at different times
// depending on how busy the machine is, landing more or less of itself inside
// the sample.
//
// A fixed number cannot be right here, because the thing it has to outlast is
// machine-dependent -- and this product is meant to run on customer hardware
// slower than this. So the warmup now WATCHES for quiet instead of assuming it:
// poll until the process has been genuinely idle for two consecutive intervals,
// then start the real sample. A process that never settles is itself the finding,
// and is reported as one rather than being silently sampled anyway.
const SETTLE_POLL_MS = 2_000;          // granularity of the quiet-detection poll.
const SETTLE_QUIET_PERCENT = 0.25;     // an interval under this counts as quiet.
const SETTLE_CONSECUTIVE = 2;          // consecutive quiet intervals before sampling.
const SETTLE_TIMEOUT_MS = 60_000;      // never wait forever; not settling is a result.
const WARMUP_MS = 3_000;   // floor: never start watching before this, even on a fast box.
const SAMPLE_MS = 30_000;  // ">= 30 seconds", per the Q116.5 measurement requirement.
const CEILING_PERCENT_OF_ONE_CORE = 1.0;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const linuxCpuSeconds = createLinuxCpuSampler({
  readStat: pid => fs.readFileSync(path.join('/proc', String(pid), 'stat'), 'utf8'),
  readClockTicks: () => execFileSync('getconf', ['CLK_TCK'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024, env: safeLaunchEnvironment(), windowsHide: true,
  }),
});

/** CPU-seconds consumed by this process identity, or null if unreadable. */
function cpuSecondsFor(pid) {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (process.platform === 'linux') return linuxCpuSeconds(pid);
    if (process.platform !== 'win32') return null;
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).CPU`
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: safeLaunchEnvironment()
    }).trim();
    if (!/^\d+(?:\.\d+)?$/.test(out)) return null;
    const value = Number(out);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

async function main() {
  if (!['win32', 'linux'].includes(process.platform)) {
    process.stderr.write('idle-cpu-check.js requires Windows Get-Process or Linux procfs; nothing was measured.\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Spawning ${path.relative(ROOT, TARGET_SCRIPT)} exactly as a real MCP client would (stdin open, unwritten)...\n`);
  const child = spawn(process.execPath, [TARGET_SCRIPT], {
    cwd: ROOT,
    // 'pipe' stdin and simply never write to it: this is what keeps a real
    // client's server process alive and idle between tool calls. Output is
    // ignored -- this check measures CPU cost, not behaviour.
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    env: safeLaunchEnvironment()
  });
  child.on('error', error => {
    process.stderr.write(`could not spawn the target process: ${error.message}\n`);
    process.exitCode = 1;
  });

  let exitedEarly = null;
  child.once('exit', (code, signal) => { exitedEarly = { code, signal }; });

  try {
    await sleep(WARMUP_MS);
    if (exitedEarly) throw new Error(`target process exited during warmup (code=${exitedEarly.code}, signal=${exitedEarly.signal})`);

    // Watch until startup goes quiet. See the SETTLE_* rationale above.
    let quietRun = 0;
    let settledAfterMs = null;
    let watchPrevious = cpuSecondsFor(child.pid);
    if (watchPrevious === null) throw new Error(`could not read CPU time for pid ${child.pid} before settling`);
    const watchStart = performance.now();
    let watchTime = watchStart;
    while (performance.now() - watchStart < SETTLE_TIMEOUT_MS) {
      await sleep(SETTLE_POLL_MS);
      if (exitedEarly) throw new Error(`target process exited while settling (code=${exitedEarly.code}, signal=${exitedEarly.signal})`);
      const now = cpuSecondsFor(child.pid);
      const observedAt = performance.now();
      if (now === null) throw new Error(`could not read CPU time for pid ${child.pid} while settling`);
      const { percentOfOneCore: percent } = cpuInterval(watchPrevious, now, (observedAt - watchTime) / 1000);
      watchPrevious = now;
      watchTime = observedAt;
      quietRun = percent <= SETTLE_QUIET_PERCENT ? quietRun + 1 : 0;
      if (quietRun >= SETTLE_CONSECUTIVE) { settledAfterMs = performance.now() - watchStart; break; }
    }
    if (settledAfterMs === null) {
      // Not a measurement problem to work around -- a process that never stops
      // consuming CPU is exactly what this check exists to catch, so say so
      // instead of sampling anyway and reporting a number that means something else.
      process.stdout.write(`FAIL: the process never went quiet within ${SETTLE_TIMEOUT_MS / 1000}s of starting; `
        + 'it is not merely slow to start, it is never idle.\n');
      process.exitCode = 1;
      return;
    }
    // SAY WHEN THIS IS A FLOOR RATHER THAN A MEASUREMENT.
    //
    // The earliest this loop can possibly report is WARMUP_MS plus
    // SETTLE_CONSECUTIVE polls -- 7.0s as configured. A process that was quiet
    // from the very first poll therefore prints ~7.4s, which reads exactly like
    // "startup took 7.4s" and is not that at all. That misreading already
    // happened once: 7.5s was recorded as a customer-visible cold-start cost
    // when the real time-to-first-response was under a second.
    //
    // So distinguish the two. A number at the floor means "quiet by the time we
    // first looked", and the honest phrasing is an upper bound, not a value.
    const settledTotalMs = WARMUP_MS + settledAfterMs;
    const floorMs = WARMUP_MS + (SETTLE_CONSECUTIVE * SETTLE_POLL_MS);
    const atFloor = settledAfterMs <= (SETTLE_CONSECUTIVE * SETTLE_POLL_MS) + (SETTLE_POLL_MS / 2);
    process.stdout.write(atFloor
      ? `Startup was already quiet at the first look (<= ${(floorMs / 1000).toFixed(1)}s, this check's floor); sampling idle from here.\n`
      : `Startup settled ${(settledTotalMs / 1000).toFixed(1)}s after spawn; sampling idle from here.\n`);

    const before = cpuSecondsFor(child.pid);
    if (before === null) throw new Error(`could not read CPU time for pid ${child.pid} before the sample window`);
    const t0 = performance.now();

    await sleep(SAMPLE_MS);
    if (exitedEarly) throw new Error(`target process exited during the sample window (code=${exitedEarly.code}, signal=${exitedEarly.signal})`);

    const after = cpuSecondsFor(child.pid);
    const elapsedSeconds = (performance.now() - t0) / 1000;
    if (after === null) throw new Error(`could not read CPU time for pid ${child.pid} after the sample window`);

    const { deltaSeconds, percentOfOneCore } = cpuInterval(before, after, elapsedSeconds);

    process.stdout.write(`pid ${child.pid}: ${deltaSeconds.toFixed(4)}s CPU consumed over ${elapsedSeconds.toFixed(2)}s idle `
      + `(no requests sent) = ${percentOfOneCore.toFixed(4)}% of one core.\n`);
    process.stdout.write(`Ceiling: ${CEILING_PERCENT_OF_ONE_CORE}% of one core, sustained while idle.\n`);

    if (percentOfOneCore > CEILING_PERCENT_OF_ONE_CORE) {
      process.stdout.write(`FAIL: idle CPU exceeds the stated ceiling.\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('PASS: idle CPU is within the stated ceiling.\n');
      process.exitCode = 0;
    }
  } catch (error) {
    process.stderr.write(`COULD NOT MEASURE: ${error.message}. Reported honestly rather than passing without evidence.\n`);
    process.exitCode = 1;
  } finally {
    if (!exitedEarly) {
      try { child.kill(); } catch { /* best effort: this is our own throwaway measurement child, not a shared process */ }
    }
  }
}

if (require.main === module) main();

module.exports = { main, cpuSecondsFor, CEILING_PERCENT_OF_ONE_CORE, SAMPLE_MS, WARMUP_MS, TARGET_SCRIPT };
