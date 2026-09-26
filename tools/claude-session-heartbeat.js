#!/usr/bin/env node
'use strict';

// R1186 root cause. The presence registry calls a seat stale after 45s
// (DEFAULT_STALE_MS) and `deriveLiveness` then reports `heartbeat-fault`.
// `src/lib/agent-lane.js` heartbeats on a timer for the children it spawns, so
// codex lanes stay honest. An OWNER-LAUNCHED Claude session has no such parent:
// it can only beat while it happens to be running a tool call, so within a
// minute of going quiet every Claude seat decayed to `heartbeat-fault` and
// `agent-roster --presence` reported zero live roles. That is the whole
// "the structure is dead" symptom -- the roles were seated, nothing kept
// saying so.
//
// This is the missing sidecar, and nothing more: a detached beater that mirrors
// what agent-lane already does for its own children. It adds no state store, no
// scheduling policy, and no admission control. It stops when the session's real
// process stops, and it closes the seat honestly on the way out.
//
// Usage (normally launched for you by tools/claude-session-register.js):
//   node tools/claude-session-heartbeat.js --agent <id> --run-id <id> \
//     --session-pid <claude.exe pid> [--interval-ms 10000]

const fs = require('node:fs');
const path = require('node:path');
const presence = require('../src/lib/agent-presence');

const ROOT = path.resolve(__dirname, '..');
const MIN_INTERVAL_MS = 2_000;
const MAX_INTERVAL_MS = 30_000;

function sessionProcessState(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error && error.code === 'ESRCH') return 'gone';
    if (error && error.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !flag.startsWith('--') || value === undefined) {
      process.stderr.write(`${JSON.stringify({ ok: false, code: 'HEARTBEAT_ARGUMENT_INVALID', message: `Expected --name value pairs; problem at ${flag || '<end>'}.` })}\n`);
      process.exit(1);
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

function main() {
  const values = parseArgs(process.argv.slice(2));
  const agentId = values.agent;
  const runId = values['run-id'];
  const sessionPid = Number(values['session-pid']);
  if (!agentId || !runId || !Number.isSafeInteger(sessionPid) || sessionPid <= 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'HEARTBEAT_ARGUMENT_INVALID', message: 'Need --agent, --run-id, and a positive --session-pid.' })}\n`);
    process.exit(1);
  }
  // Beat well inside the 45s stale window so a slow tick is not a fault.
  const requested = values['interval-ms'] === undefined ? 10_000 : Number(values['interval-ms']);
  const intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Number.isFinite(requested) ? requested : 10_000));

  const logFile = path.join(ROOT, 'logs', 'lane-consoles', `${agentId}-heartbeat.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = message => {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, { encoding: 'utf8' });
    } catch {
      // A heartbeat that cannot log still beats.
    }
  };

  log(`start agent=${agentId} run=${runId} sessionPid=${sessionPid} intervalMs=${intervalMs}`);

  const stop = (reason, closeSeat) => {
    let exitCode = 0;
    if (closeSeat) {
      try {
        presence.finish(agentId, runId, { exitCode: 0, verdict: `session ended (${reason})` });
        log(`closed seat: ${reason}`);
      } catch (error) {
        log(`close failed (${error.code || 'unknown'}): ${error.message}`);
        exitCode = 1;
      }
    }
    log(`exit: ${reason}`);
    process.exit(exitCode);
  };

  const beat = () => {
    // The session's real process is the liveness source of truth.
    const processState = sessionProcessState(sessionPid);
    if (processState === 'unknown') {
      log(`session pid ${sessionPid} liveness probe failed; refusing to report it gone`);
      return;
    }
    if (processState === 'gone') {
      stop(`session pid ${sessionPid} gone`, true);
      return;
    }
    let record;
    try {
      const registry = presence.readRegistry(presence.DEFAULT_STATE_FILE);
      record = registry.agents[agentId] || null;
    } catch (error) {
      log(`registry read failed (${error.code || 'unknown'}): ${error.message}`);
      return;
    }
    // Someone else owns the seat, or it was already closed: this beater is done
    // and must not resurrect a record it no longer owns.
    if (!record) stop('presence record removed', false);
    else if (record.runId !== runId) stop(`seat taken by run ${record.runId}`, false);
    else if (presence.TERMINAL.has(record.status)) stop(`seat already ${record.status}`, false);
    else {
      try {
        presence.heartbeat(agentId, runId, { pid: sessionPid, currentTask: record.currentTask });
      } catch (error) {
        log(`heartbeat failed (${error.code || 'unknown'}): ${error.message}`);
      }
    }
  };

  beat();
  const timer = setInterval(beat, intervalMs);
  const shutdown = signal => {
    clearInterval(timer);
    stop(`received ${signal}`, false);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
