#!/usr/bin/env node
'use strict';

// Keep the native-agent claimant running, so work dispatched from the peer
// machine over the 8788 bridge is claimed and executed here with a fully
// native local agent, with no agent session present, and comes back by itself
// after a reboot.
//
// This is the exact shape of the earlier local worker reconcile, for a separate
// worker and a separate queue. It is deliberately thin: it owns no policy and
// starts nothing else. It asks the runtime for status and, only when the
// worker is not running, asks it to start. Ownership, the PID+startTicks
// record, the create-only race guard, and termination all stay in the runtime.
//
// start() is idempotent by construction -- it returns already_running when it
// still owns a live process -- so this is safe on a short repeating trigger
// and safe to run twice concurrently.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { createNativeAgentWorkerRuntime } = require(path.join(ROOT, 'sidecars', 'native-agent', 'src', 'native-agent-runtime.js'));

const ACTOR = 'native-agent-worker-reconcile';
const LOG_FILE = path.join(ROOT, 'logs', 'native-agent-worker-reconcile.log');

// Task Scheduler discards stdout, so a run under the task is otherwise
// invisible: it reports only an exit code, and this script exits 0 both when
// it starts the worker and when it finds it already running. Those are the
// same number for opposite outcomes. Every run leaves a line here so the two
// can be told apart afterwards.
function record(payload) {
  const line = JSON.stringify({ at: new Date().toISOString(), actor: ACTOR, ...payload, secretValuesEmitted: false });
  process.stdout.write(`${line}\n`);
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
}

// 'stale' does not distinguish "the worker is gone" from "this caller cannot
// verify the worker". The scheduled task runs S4U in another session, so an
// ordinary interactive session can neither signal that worker nor read its
// start ticks, and reports stale for a perfectly healthy process. Starting on
// that reading launches a SECOND autonomous claimant onto the same queue.
// Only ESRCH is evidence of death. Anything else means do nothing.
function recordedProcessMayBeAlive(runtime) {
  let recorded;
  try { recorded = JSON.parse(fs.readFileSync(runtime.recordFile, 'utf8')); } catch { return true; }
  if (!recorded || !Number.isSafeInteger(recorded.pid)) return true;
  try {
    process.kill(recorded.pid, 0);
    return true;
  } catch (error) {
    return !error || error.code !== 'ESRCH';
  }
}

function main() {
  const runtime = createNativeAgentWorkerRuntime();
  const before = runtime.status();
  record({ decision: 'observed', status: before.status, running: before.running === true, pid: before.pid });

  if (before.running) {
    record({ ok: true, action: 'already_running', pid: before.pid });
    return;
  }
  if (before.status === 'stale' && recordedProcessMayBeAlive(runtime)) {
    record({
      ok: true,
      action: 'refused_unverifiable',
      detail: 'a recorded worker process is still alive but not verifiable from this session; refusing to start a duplicate claimant'
    });
    return;
  }
  // 'stale' means a record survived a process that did not. start() clears it.
  const result = runtime.start({
    actor: ACTOR,
    // Stable per wake: two triggers firing in the same minute must not look
    // like two different intents.
    idempotencyKey: `native-agent-worker-reconcile.${new Date().toISOString().slice(0, 16)}`
  });
  record({ ok: true, action: result.status, pid: result.pid, previousStatus: before.status });
}

// Guarded so that require()-ing this file -- for its exports, or by accident
// during unrelated investigation -- never spawns a worker process as a side
// effect. main() only runs when this file is executed directly
// (node tools/native-agent-worker-reconcile.js), matching the require.main
// convention already used elsewhere in this codebase (audit-durability-check.js,
// bridge-status.js, build-queue-migrate.js). No change to intended behavior:
// every real invocation already runs this file directly, never requires it.
if (require.main === module) {
  try {
    main();
  } catch (error) {
    const code = String((error && error.code) || 'NATIVE_AGENT_WORKER_RECONCILE_FAILED').slice(0, 100);
    record({ ok: false, action: 'error', code, message: String((error && error.message) || '').replace(/\s+/g, ' ').slice(0, 300) });
    process.exitCode = 1;
  }
}
