'use strict';

const { createFileControlStore } = require('../../src/m1/control-store');

const [root, expectedSnapshotId, dedupeKey] = process.argv.slice(2);
try {
  const store = createFileControlStore({ root });
  const receipt = store.compareAndSwap({
    expectedSnapshotId,
    event: { type: 'worker.appended', payload: { dedupeKey } },
    dedupeKey,
    occurredAt: '2026-08-06T12:00:00.000Z',
  });
  process.stdout.write(`${JSON.stringify({ ok: true, receipt })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || error.name })}\n`);
}
