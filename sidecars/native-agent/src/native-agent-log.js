'use strict';

// Routine per-run diagnostics share the product store and its finite policy.
// Saved task state, task output and prior log directories are never enrolled.
const path = require('node:path');
const { createDiagnosticStore, resolveDiagnosticDirectory } = require('../../../src/lib/diagnostic-retention');
const stores = new Map();

function runStore(directory) {
  const root = directory ? path.join(directory, 'diagnostics-v1') : resolveDiagnosticDirectory();
  if (!stores.has(root)) {
    const store = createDiagnosticStore({ directory: root });
    store.start();
    stores.set(root, store);
  }
  return stores.get(root);
}

/** Diagnostic limits never stop a task. The returned status names suppression. */
function createRunLog(taskId, attempt, { directory, store, now = Date.now } = {}) {
  let target, decisions, stream, unavailable = null;
  try {
    target = store || runStore(directory);
    decisions = target.createWriter('native-decisions');
    stream = target.createWriter('native-stream');
  } catch (error) { unavailable = error.code || 'diagnostic-store-unavailable'; }
  const openedAt = now();
  let closed = false;
  function decision(payload) {
    if (closed) return { written: false, reason: 'closed' };
    try { return decisions?.append(JSON.stringify({ at: new Date(now()).toISOString(), taskId, attempt, ...payload }))
      || { written: false, reason: unavailable }; }
    catch { return { written: false, reason: 'diagnostic-serialization-failed' }; }
  }
  decision({ decision: 'run_log_opened', pid: process.pid });
  function fileOf(writer) {
    const id = writer?.state().id;
    return id ? path.join(target.directory, id) : null;
  }
  return {
    get file() { return fileOf(decisions); },
    get rawFile() { return fileOf(stream); },
    decision,
    raw(line) {
      if (closed) return { written: false, reason: 'closed' };
      try { return stream?.append(line) || { written: false, reason: unavailable }; }
      catch { return { written: false, reason: 'diagnostic-serialization-failed' }; }
    },
    status: () => ({ unavailable, decisions: decisions?.state() || null, stream: stream?.state() || null }),
    close() {
      if (closed) return;
      decision({ decision: 'run_log_closed', elapsedMs: now() - openedAt });
      closed = true; decisions?.close(); stream?.close();
    },
  };
}

module.exports = { createRunLog };
