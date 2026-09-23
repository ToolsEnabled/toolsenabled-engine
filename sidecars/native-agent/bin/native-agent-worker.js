#!/usr/bin/env node
'use strict';

// The durable native-agent claimant. One process, one task at a time.
//
// It is started only by NativeAgentWorkerRuntime (which owns the PID record
// and the single-claim guard) and supervised by the 'ToolsEnabled Native Agent
// Worker' scheduled task, so it survives reboot with no agent session present.

const fs = require('node:fs');
const path = require('node:path');
const { NativeAgentWorker, workerId } = require('../src/native-agent-worker');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DAEMON_LOG = path.join(ROOT, 'logs', 'native-agent-worker.log');
const HEARTBEAT_FILE = path.join(ROOT, 'state', 'native-agent-runtime', 'heartbeat.json');

// The file is the authority, not stdout. The runtime already redirects this
// process's stdio into the same file, so writing to both would double every
// line and make the log actively misleading about how often things happened.
// stderr still lands in the same file through that redirect, so an unhandled
// crash is still captured.
function record(payload) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...payload, secretValuesEmitted: false });
  try {
    fs.mkdirSync(path.dirname(DAEMON_LOG), { recursive: true });
    fs.appendFileSync(DAEMON_LOG, `${line}\n`, 'utf8');
  } catch { /* never let logging stop the worker */ }
}

function publishHeartbeat(payload) {
  // One bounded, atomic, secret-free record is the health observer's
  // functioning proof. Never append: a long-running daemon should not turn a
  // heartbeat into an unbounded log. Never let telemetry failure stop work.
  const temporary = `${HEARTBEAT_FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: 'native-agent-worker-heartbeat.v1',
      observedAtMs: payload.observedAtMs,
      ok: payload.ok === true,
      state: payload.state,
      pid: payload.pid,
      secretValuesEmitted: false
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, HEARTBEAT_FILE);
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* no temporary file to clear */ }
  }
}

const worker = new NativeAgentWorker({
  workerLabel: process.env.NATIVE_AGENT_WORKER_LABEL || workerId(),
  // Never emit task objectives, agent output, credentials, or claim tokens
  // here. Per-run detail belongs in logs/native-agent-runs/, which is keyed by
  // durable task id; this file is the daemon's own lifecycle only.
  onEvent: event => record(event),
  onHeartbeat: heartbeat => publishHeartbeat(heartbeat)
});

const stop = () => { record({ event: 'signal_stop' }); worker.stop(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

worker.runForever().catch(error => {
  record({
    event: 'worker_crashed',
    code: String((error && error.code) || 'NATIVE_AGENT_WORKER_FAILED').slice(0, 100),
    message: String((error && error.message) || error || '').replace(/\s+/g, ' ').slice(0, 400)
  });
  process.exitCode = 1;
});
