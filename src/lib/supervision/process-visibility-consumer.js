'use strict';

// Reader-side boundary for the Q39 cross-session visibility snapshot.
// Missing, malformed, future-dated, and stale input fails closed. Callers use
// the unavailable projection as UNKNOWN rather than falling back to a
// cross-session probe that may be blind to the process it is judging.

const fs = require('node:fs');
const path = require('node:path');

const managedProcesses = require('../managed-processes.js');
const snapshot = require('./process-visibility-snapshot.js');
const targets = require('./process-visibility-targets.js');

const SNAPSHOT_FILE = path.join(managedProcesses.ROOT, 'state', 'process-visibility.json');
const DEFAULT_MAX_AGE_MS = 120000;

function unavailable(code, reason, extra = {}) {
  return Object.freeze({ usable: false, code, reason, ...extra });
}

function displayArgv(argv) {
  // argv passed the producer/parser secret checks. This is comparison data,
  // never a shell command.
  return argv.join(' ');
}

function loadProcessVisibility({
  file = SNAPSHOT_FILE,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  expectedTaskNames = targets.TASK_NAMES
} = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return unavailable('PROCESS_VISIBILITY_CONSUMER_INVALID_CLOCK',
      'the process-visibility freshness clock is invalid, so cross-session observations are unavailable');
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return unavailable('PROCESS_VISIBILITY_CONSUMER_UNAVAILABLE',
      'no readable process-visibility snapshot exists, so cross-session observations are unknown');
  }

  let validated;
  try {
    validated = snapshot.parseProcessVisibilitySnapshot(raw, { expectedTaskNames });
  } catch (error) {
    return unavailable('PROCESS_VISIBILITY_CONSUMER_INVALID',
      `the process-visibility snapshot failed closed validation${error && error.code ? ` (${error.code})` : ''}`);
  }

  const ageMs = now - validated.capturedAtMs;
  if (ageMs < 0) {
    return unavailable('PROCESS_VISIBILITY_CONSUMER_FUTURE',
      'the process-visibility snapshot is future-dated, so cross-session observations are unavailable',
      { ageMs, capturedAtMs: validated.capturedAtMs, maxAgeMs });
  }
  if (ageMs > maxAgeMs) {
    return unavailable('PROCESS_VISIBILITY_CONSUMER_STALE',
      `the process-visibility snapshot is ${Math.round(ageMs / 1000)}s old, past the ${Math.round(maxAgeMs / 1000)}s bound`,
      { ageMs, capturedAtMs: validated.capturedAtMs, maxAgeMs });
  }

  const tasks = new Map(validated.tasks.map(task => [task.taskName, task.state === 'NotFound' ? null : Object.freeze({
    state: task.state,
    execute: task.executable,
    arguments: displayArgv(task.argv),
    workingDirectory: task.workingDirectory
  })]));
  const processes = new Map(validated.processes.map(process => [process.pid, Object.freeze({
    pid: process.pid,
    startedAt: process.startedAtMs === null ? null : new Date(process.startedAtMs).toISOString(),
    commandLine: displayArgv(process.argv)
  })]));

  return Object.freeze({
    usable: true,
    code: 'PROCESS_VISIBILITY_CONSUMER_FRESH',
    ageMs,
    capturedAtMs: validated.capturedAtMs,
    maxAgeMs,
    // null means the elevated reader measured a declared target and reported
    // NotFound. An undeclared name was not measured by this snapshot at all.
    getScheduledTask: name => tasks.has(name) ? tasks.get(name) : undefined,
    getProcessInfo: pid => processes.get(Number(pid)) || null
  });
}

module.exports = Object.freeze({
  DEFAULT_MAX_AGE_MS,
  SNAPSHOT_FILE,
  loadProcessVisibility
});
