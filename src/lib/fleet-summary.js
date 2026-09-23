// This summary never invents a figure: absent data is null, not zero.

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

function summarizeRuns(runs, nowMs) {
  if (!Array.isArray(runs)) {
    throw new TypeError('runs must be an array');
  }
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('nowMs must be a finite number');
  }

  let totalRuns = 0;
  const byStatus = {};
  const byProvider = {};
  let openHelpTotal = 0;
  const queuedRuns = [];
  const succeededDurations = [];
  const staleRuns = [];

  for (const [index, run] of runs.entries()) {
    if (!run || typeof run !== 'object' || !run.runId || !run.status
      || !Number.isFinite(run.createdAtMs) || !Number.isFinite(run.updatedAtMs)) {
      throw new TypeError(`runs[${index}] is not a measurable run`);
    }

    totalRuns++;
    const { runId, status, createdAtMs, updatedAtMs, completedAtMs, scope, help } = run;
    byStatus[status] = (byStatus[status] || 0) + 1;

    const provider = scope && scope.executionProvider ? scope.executionProvider : 'unknown';
    if (!byProvider[provider]) byProvider[provider] = { total: 0, succeeded: 0, failed: 0, openHelp: 0 };
    byProvider[provider].total++;
    if (status === 'succeeded') byProvider[provider].succeeded++;
    else if (status === 'failed') byProvider[provider].failed++;

    if (help && typeof help.open === 'number' && help.open > 0) {
      openHelpTotal += help.open;
      byProvider[provider].openHelp += help.open;
    }
    if (status === 'succeeded' && typeof completedAtMs === 'number') {
      const duration = completedAtMs - createdAtMs;
      if (duration >= 0) succeededDurations.push(duration);
    }
    if (status === 'queued') queuedRuns.push(run);
    if (!TERMINAL_STATUSES.has(status) && nowMs - updatedAtMs > STALE_THRESHOLD_MS && staleRuns.length < 10) {
      staleRuns.push({ runId, status, ageMs: nowMs - updatedAtMs });
    }
  }

  let oldestQueuedAgeMs = null;
  if (queuedRuns.length > 0) {
    const oldestTimestamp = Math.min(...queuedRuns.map(run => run.createdAtMs));
    const age = nowMs - oldestTimestamp;
    oldestQueuedAgeMs = age >= 0 ? age : null;
  }

  let medianSucceededDurationMs = null;
  if (succeededDurations.length > 0) {
    succeededDurations.sort((a, b) => a - b);
    const mid = Math.floor(succeededDurations.length / 2);
    medianSucceededDurationMs = succeededDurations.length % 2 === 0
      ? (succeededDurations[mid - 1] + succeededDurations[mid]) / 2
      : succeededDurations[mid];
    if (medianSucceededDurationMs < 0) medianSucceededDurationMs = null;
  }

  return { totalRuns, byStatus, byProvider, openHelpTotal, oldestQueuedAgeMs, medianSucceededDurationMs, staleRuns };
}

module.exports = { summarizeRuns };
