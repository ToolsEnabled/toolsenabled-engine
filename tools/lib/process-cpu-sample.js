'use strict';

// Linux /proc/<pid>/stat is a kernel interface, not a delimiter-separated
// command name: comm itself may contain spaces and closing parentheses.
function parseLinuxCpuStat(text, pid, ticksPerSecond) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 ||
      !Number.isSafeInteger(pid) || pid <= 0 ||
      !Number.isSafeInteger(ticksPerSecond) || ticksPerSecond <= 0) throw new Error('Invalid Linux CPU sample input');
  const open = text.indexOf(' ('), end = text.lastIndexOf(')');
  if (open < 1 || end < open + 2 || !/^\d+$/.test(text.slice(0, open)) || Number(text.slice(0, open)) !== pid) {
    throw new Error('Linux CPU sample belongs to a different or unreadable process');
  }
  const fields = text.slice(end + 1).trim().split(/\s+/);
  if (fields.length < 20 || !/^[RSDZTWXxKPI]$/.test(fields[0]) ||
      [fields[11], fields[12], fields[19]].some(value => !/^\d+$/.test(value || ''))) {
    throw new Error('Linux CPU sample is missing kernel accounting fields');
  }
  const user = BigInt(fields[11]), system = BigInt(fields[12]), started = BigInt(fields[19]);
  const total = user + system;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Linux CPU accounting exceeds its numeric bound');
  return Object.freeze({ pid, startTicks: started.toString(), cpuSeconds: Number(total) / ticksPerSecond });
}

function parseClockTicks(text) {
  if (typeof text !== 'string' || !/^[1-9]\d*\s*$/.test(text)) throw new Error('Kernel clock tick rate is unreadable');
  const value = Number(text.trim());
  if (!Number.isSafeInteger(value)) throw new Error('Kernel clock tick rate exceeds its numeric bound');
  return value;
}

function cpuInterval(before, after, elapsedSeconds) {
  if (![before, after, elapsedSeconds].every(Number.isFinite) || before < 0 || after < before || elapsedSeconds <= 0) {
    throw new Error('CPU accounting decreased or the measured interval is invalid');
  }
  const deltaSeconds = after - before;
  return { deltaSeconds, percentOfOneCore: deltaSeconds / elapsedSeconds * 100 };
}

function createLinuxCpuSampler({ readStat, readClockTicks }) {
  let ticks;
  const starts = new Map();
  return pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('CPU sampling requires a positive process ID');
    if (ticks === undefined) ticks = parseClockTicks(readClockTicks());
    const sample = parseLinuxCpuStat(readStat(pid), pid, ticks);
    if (starts.has(pid) && starts.get(pid) !== sample.startTicks) throw new Error('CPU sample process identity changed');
    starts.set(pid, sample.startTicks);
    return sample.cpuSeconds;
  };
}

module.exports = Object.freeze({ parseLinuxCpuStat, parseClockTicks, cpuInterval, createLinuxCpuSampler });
