'use strict';

// A cheap, passive CPU signal for THIS machine, in the same fail-closed idiom
// as the rest of src/lib/usage.  Three things about this file will mislead
// anyone who reads it casually, and each is encoded here rather than left as
// folklore:
//
//   1. os.loadavg() is NOT a real measurement on Windows.  Node's own docs
//      say the return value on Windows is ALWAYS [0, 0, 0], and this was
//      reconfirmed live on this machine before writing a line of this file
//      (win32, 16 logical cores, os.loadavg() -> [0, 0, 0]).  A reader that
//      trusts loadavg() here reports "zero load" forever -- a plausible-
//      looking number that is actually a platform stub with nothing behind
//      it.  This module never calls os.loadavg().  It measures utilization
//      directly from os.cpus() time-counter deltas, which are real on every
//      platform Node supports.
//   2. os.cpus()[i].times are CUMULATIVE counters (milliseconds of CPU time
//      in that bucket since boot), not an instantaneous reading.  A single
//      sample says nothing about current load; utilization is only
//      meaningful as a DELTA between two samples separated by a short
//      interval. This reader owns both samples itself so a caller never has
//      to keep sampling state alive across process lifetimes -- important
//      here because the coordinator may invoke this from a fresh process
//      per check rather than a long-lived one.
//   3. The sampling interval is a real wall-clock wait (default 200ms), but
//      it costs no meaningful CPU: it is an idle timer between two cheap
//      synchronous syscalls, never a spin loop, and it never spawns a
//      process. With ~40 node processes already on this machine, a poller
//      that itself burns CPU to measure CPU would be self-defeating; this
//      one does not.
//
// Absent, malformed, or internally inconsistent samples (e.g. a counter that
// moves backward between the two reads, or the core count changing mid
// -sample) resolve to UNKNOWN with a named reason, never to a plausible 0% or
// 100%.

const os = require('node:os');

const UNKNOWN = 'UNKNOWN';
const MEASURED = 'MEASURED';

const UNKNOWN_REASON = Object.freeze({
  CPU_SAMPLE_UNAVAILABLE: 'CPU_SAMPLE_UNAVAILABLE',
  CPU_SAMPLE_SHAPE_DRIFT: 'CPU_SAMPLE_SHAPE_DRIFT',
  CORE_COUNT_UNAVAILABLE: 'CORE_COUNT_UNAVAILABLE',
  CPU_SAMPLE_INCONSISTENT: 'CPU_SAMPLE_INCONSISTENT'
});

// 1000ms, raised from 200ms on 2026-08-13 after measurement, not reasoning.
//
// The old comment claimed 200ms was "long enough that the counters move enough
// to divide by without noise dominating". Measured concurrently against
// Get-Counter '\Processor(_Total)\% Processor Time' on a 16-core machine under
// real load, that is false in BOTH directions:
//
//   this reader @200ms   38, 14, 12, 12, 13, 10, 15, 12  percent
//   Get-Counter @1s      11.2, 14.9, 63.4, 47.4, 68.7, 56.9  percent
//   this reader @1000ms  35, 59, 66  percent   <- tracks
//
// At 200ms the window is short enough to land inside a scheduling gap and read
// ~12% while the machine is really at ~60%, and equally short enough to land
// inside a burst and read 100% on every core at once. A reading that can be
// wrong by 50 points in either direction is not a load signal.
//
// This is load-bearing, not cosmetic: dispatch-readiness.js gates agent
// dispatch on this number at an 85% threshold, so an over-reporting sample
// makes a machine refuse all dispatch, and an under-reporting one lets a
// saturated machine take more work. A single sample from this reader is still
// only a sample -- a dispatch-or-kill decision should require several
// consecutive ones, which belongs in dispatch-readiness.js, not here.
//
// The cost is that a reading now takes a second. That is the correct trade: a
// dispatch decision can afford a second, and cannot afford a wrong number.
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;
const MIN_SAMPLE_INTERVAL_MS = 50;
const MAX_SAMPLE_INTERVAL_MS = 5_000;

function unknown(reason, detail) {
  return Object.freeze({ status: UNKNOWN, reason, detail: detail || null });
}

function snapshotCpus(readCpus) {
  let raw;
  try {
    raw = readCpus();
  } catch (error) {
    return { error: unknown(UNKNOWN_REASON.CPU_SAMPLE_UNAVAILABLE, error.message) };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: unknown(UNKNOWN_REASON.CORE_COUNT_UNAVAILABLE, 'os.cpus() returned no cores.') };
  }
  const cores = [];
  for (const core of raw) {
    const times = core && typeof core === 'object' ? core.times : null;
    if (!times || typeof times !== 'object'
      || !Number.isFinite(times.user) || !Number.isFinite(times.nice)
      || !Number.isFinite(times.sys) || !Number.isFinite(times.idle)
      || !Number.isFinite(times.irq)
      || times.user < 0 || times.nice < 0 || times.sys < 0
      || times.idle < 0 || times.irq < 0) {
      return { error: unknown(UNKNOWN_REASON.CPU_SAMPLE_SHAPE_DRIFT, 'A core entry from os.cpus() had an unrecognised shape.') };
    }
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    if (!Number.isFinite(total)) {
      return { error: unknown(UNKNOWN_REASON.CPU_SAMPLE_SHAPE_DRIFT, 'A core entry from os.cpus() had time counters whose total was not finite.') };
    }
    cores.push({ idle: times.idle, total });
  }
  return { cores };
}

function createMachineLoadReader({
  readCpus = () => os.cpus(),
  wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  now = () => Date.now()
} = {}) {
  if (typeof readCpus !== 'function' || typeof wait !== 'function' || typeof now !== 'function') {
    throw new TypeError('createMachineLoadReader requires readCpus, wait and now functions.');
  }
  if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs < MIN_SAMPLE_INTERVAL_MS || sampleIntervalMs > MAX_SAMPLE_INTERVAL_MS) {
    throw new TypeError(`sampleIntervalMs must be a number from ${MIN_SAMPLE_INTERVAL_MS} through ${MAX_SAMPLE_INTERVAL_MS} milliseconds.`);
  }

  return async function readMachineLoad() {
    const before = snapshotCpus(readCpus);
    if (before.error) return before.error;

    await wait(sampleIntervalMs);

    const after = snapshotCpus(readCpus);
    if (after.error) return after.error;

    if (after.cores.length !== before.cores.length) {
      return unknown(UNKNOWN_REASON.CPU_SAMPLE_INCONSISTENT, 'Core count changed between samples.');
    }

    let idleDelta = 0;
    let totalDelta = 0;
    const perCoreUtilizationPercent = [];
    for (let index = 0; index < before.cores.length; index += 1) {
      const coreIdleDelta = after.cores[index].idle - before.cores[index].idle;
      const coreTotalDelta = after.cores[index].total - before.cores[index].total;
      // A cumulative counter must never move backward between two samples
      // taken moments apart in the same process. If it does, the platform's
      // counters are not behaving as documented and the reading is
      // untrustworthy -- that is a different fact from "load happens to be
      // low", and reporting it as low load would be exactly the invented
      // number this module exists to refuse.
      if (!Number.isFinite(coreTotalDelta) || !Number.isFinite(coreIdleDelta)
        || coreTotalDelta < 0 || coreIdleDelta < 0 || coreIdleDelta > coreTotalDelta) {
        return unknown(
          UNKNOWN_REASON.CPU_SAMPLE_INCONSISTENT,
          `Core ${index} time counters moved backward or were incoherent between samples.`
        );
      }
      idleDelta += coreIdleDelta;
      totalDelta += coreTotalDelta;
      perCoreUtilizationPercent.push(
        coreTotalDelta === 0 ? null : Math.round((1 - coreIdleDelta / coreTotalDelta) * 100)
      );
    }

    if (totalDelta === 0) {
      // No CPU-time movement at all across every core in the sampling
      // window is evidence the window was too short to measure, not
      // evidence of exactly zero load.
      return unknown(UNKNOWN_REASON.CPU_SAMPLE_INCONSISTENT, 'No CPU time elapsed between samples; the interval was too short to measure.');
    }

    return Object.freeze({
      status: MEASURED,
      source: 'os-cpus-delta',
      coreCount: before.cores.length,
      utilizationPercent: Math.round((1 - idleDelta / totalDelta) * 100),
      perCoreUtilizationPercent: Object.freeze(perCoreUtilizationPercent),
      sampleIntervalMs,
      observedAtMs: now()
    });
  };
}

module.exports = Object.freeze({
  DEFAULT_SAMPLE_INTERVAL_MS,
  MIN_SAMPLE_INTERVAL_MS,
  MAX_SAMPLE_INTERVAL_MS,
  UNKNOWN_REASON,
  createMachineLoadReader
});
