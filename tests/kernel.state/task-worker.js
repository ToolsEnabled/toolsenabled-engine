'use strict';

const path = require('node:path');
const { createStateStore } = require('../../src/lib/state-store');

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function waitUntil(timestamp) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < timestamp) {
    Atomics.wait(sleeper, 0, 0, Math.min(timestamp - Date.now(), 50));
  }
}

function decode(value) {
  if (!value) return {};
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function publicClaim(value) {
  if (!value || value.claimed === false) return { claimed: false };
  const handle = value.handle || value.claim || {};
  const task = value.task || value;
  return {
    claimed: true,
    taskId: handle.taskId || task.taskId || task.id,
    fence: handle.fence,
    attempt: handle.attempt,
    status: task.status,
    checkpointRevision: task.checkpointRevision
  };
}

async function main() {
  const [mode, databasePath, encoded = '', startAtText = '0'] = process.argv.slice(2);
  if (!path.isAbsolute(databasePath || '')) throw new Error('An absolute temporary database path is required.');
  const startAt = Number(startAtText);
  if (!Number.isFinite(startAt) || startAt < 0) throw new Error('startAt must be a non-negative timestamp.');
  const input = decode(encoded);
  if (startAt) waitUntil(startAt);

  const store = createStateStore({
    file: databasePath,
    busyTimeoutMs: 30_000,
    ...(Number.isSafeInteger(input.clockNow) ? { clock: () => input.clockNow } : {}),
    ownerId: input.ownerId || `task-worker-${process.pid}`
  });

  try {
    if (mode === 'open') {
      const health = store.health();
      emit({ ok: true, schemaVersion: health.schemaVersion, integrity: health.integrity && health.integrity.ok });
      return;
    }

    if (mode === 'claim') {
      emit({ ok: true, ...publicClaim(await store.claimTask(input.claim || input)) });
      return;
    }

    if (mode === 'checkpoint') {
      const result = await store.checkpointTask(input.handle, input.checkpoint);
      emit({
        ok: true,
        replayed: result.replayed === true,
        revision: result.revision === undefined && result.task ? result.task.checkpointRevision : result.revision,
        checkpointKey: result.checkpointKey || result.checkpoint && result.checkpoint.key
      });
      return;
    }

    if (mode === 'hold-leased' || mode === 'hold-running') {
      const claim = await store.claimTask(input.claim);
      if (!claim || claim.claimed === false || !claim.handle) throw new Error('Worker could not claim the fixture task.');
      let current = claim;
      if (mode === 'hold-running') {
        current = await store.startTask(claim.handle, input.start || {});
      }
      emit({ ready: true, ...publicClaim({ handle: current.handle || claim.handle, task: current.task || current }) });
      await new Promise(() => {});
      return;
    }

    throw new Error(`Unknown task worker mode '${mode}'.`);
  } finally {
    store.close();
  }
}

main().catch(error => {
  emit({ ok: false, code: error && error.code || 'UNEXPECTED_ERROR', message: String(error && error.message || error) });
});
