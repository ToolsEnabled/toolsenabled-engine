'use strict';

const fs = require('node:fs');
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

async function main() {
  const [mode, databasePath, identity = '0', startAtText = '0'] = process.argv.slice(2);
  if (!path.isAbsolute(databasePath || '')) throw new Error('An absolute temporary database path is required.');
  const startAt = Number(startAtText);
  if (!Number.isFinite(startAt) || startAt < 0) throw new Error('startAt must be a non-negative timestamp.');
  if (startAt) waitUntil(startAt);

  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  if (mode === 'transaction-crash') {
    store.transaction(db => {
      db.prepare(`INSERT INTO spend_entries(id, spend_date, timestamp_ms, amount_cents, purpose, provider, reference)
        VALUES('uncommitted-crash-row', '2026-01-02', 1, 100, 'must roll back', 'crash-fixture', 'uncommitted')`).run();
      fs.writeSync(1, `${JSON.stringify({ ready: true, pid: process.pid })}\n`);
      // Keep the write transaction open until the parent terminates this process.
      waitUntil(Date.now() + 60_000);
    });
    throw new Error('The transaction-crash worker was not terminated as expected.');
  }
  if (mode === 'operation-executing') {
    const leaseMs = Number(identity);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('The operation lease must be a positive integer.');
    const inputHash = process.argv[6];
    if (!/^[a-f0-9]{64}$/.test(inputHash || '')) throw new Error('A SHA-256 input hash is required.');
    const reservation = await store.reserveOperation({
      type: 'instagram.publish_image',
      key: 'crash-after-executing',
      inputHash,
      ownerId: `worker-${process.pid}`,
      leaseMs
    });
    if (reservation.disposition !== 'reserved' || !reservation.handle) {
      throw new Error(`Unexpected operation disposition '${reservation.disposition}'.`);
    }
    await store.markOperationExecuting(reservation.handle, { leaseMs });
    emit({ ready: true, pid: process.pid });
    // The parent deliberately terminates this process without releasing the lease.
    await new Promise(() => {});
    return;
  }

  try {
    if (mode === 'policy-approval-attach') {
      const attachment = JSON.parse(process.argv[6]);
      store.consumePolicyDispatchAuthorization({
        authorizationId: attachment.authorizationId,
        toolName: attachment.toolName,
        argsHash: attachment.argsHash,
        approvalId: attachment.approvalId,
        approvalInputHash: attachment.approvalInputHash
      });
      emit({ ok: true, authorizationId: attachment.authorizationId });
      return;
    }
    let input;
    if (mode === 'spend-distinct') {
      input = {
        amountCents: 100,
        dailyLimitCents: 500,
        purpose: `distinct-purpose-${identity}`,
        provider: 'concurrency-fixture',
        reference: `distinct-reference-${identity}`
      };
    } else if (mode === 'spend-same') {
      input = {
        amountCents: 100,
        dailyLimitCents: 5000,
        purpose: 'same-purpose',
        provider: 'concurrency-fixture',
        reference: 'same-reference'
      };
    } else {
      throw new Error(`Unknown worker mode '${mode}'.`);
    }
    const result = await store.recordSpend(input);
    emit({ ok: true, replayed: result.replayed === true, entryId: result.entry && result.entry.id });
  } finally {
    if (typeof store.close === 'function') store.close();
  }
}

main().catch(error => {
  emit({ ok: false, code: error && error.code || 'UNEXPECTED_ERROR', message: String(error && error.message || error) });
});
