'use strict';

// GROUP COMMIT ADMITS N EVENTS UNDER ONE LOCK AND TRADES NOTHING FOR IT.
//
// audit.recordBatch() exists so a burst of tool calls costs one writer-lock
// acquisition instead of one per call. These checks are the ledger's side of
// that bargain: every event of the batch is its own signed, hash-chained row
// with consecutive sequences; the whole chain still verifies from a separate
// connection; both projection files carry every event; an anchor requested by
// any item covers every item; the verification cache advances across the
// whole batch so the next admission is still incremental; and a batch that
// cannot be admitted spools every item and records one breach per item.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

function memoryAnchor() {
  let value = null;
  return {
    get: () => value,
    set(next, sequence) {
      if (value !== null && sequence < JSON.parse(value).sequence) throw new Error('anchor cannot move backward');
      value = next;
    }
  };
}

function harness(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `te-audit-batch-${label}-`));
  const keys = crypto.generateKeyPairSync('ed25519');
  const file = path.join(dir, 'audit.sqlite3');
  let nextId = 0;
  const dependencies = {
    storeOptions: { file },
    signer: {
      keyId: 'batch-key-0001',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sign: value => crypto.sign(null, value, keys.privateKey)
    },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(dir, value),
    env: {},
    eventIdFactory: () => `audit-batch-${String(++nextId).padStart(8, '0')}`,
    clock: Date.now,
    reportError: () => {},
    anchorStore: memoryAnchor()
  };
  return {
    dir, file, dependencies,
    jsonlLines: () => fs.existsSync(path.join(dir, 'actions.jsonl'))
      ? fs.readFileSync(path.join(dir, 'actions.jsonl'), 'utf8').split('\n').filter(Boolean) : [],
    textLines: () => fs.existsSync(path.join(dir, 'actions.log'))
      ? fs.readFileSync(path.join(dir, 'actions.log'), 'utf8').split('\n').filter(Boolean) : [],
    verify() {
      const store = createAuditStore({ file });
      try { return store.verify(); } finally { store.close(); }
    },
    close() {
      try { audit.resetForTests(); }
      finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
    }
  };
}

test('a batch of records lands as consecutive signed rows, projected and verifiable', () => {
  const h = harness('rows');
  try {
    const first = audit.record('warm.up', 'ledger', {}, h.dependencies);
    assert.equal(first.durable, true);
    const items = [];
    for (let i = 0; i < 25; i += 1) items.push({ action: 'mcp.tool.succeeded', target: `tool.${i}`, details: { i } });
    const statuses = audit.recordBatch(items, h.dependencies);
    assert.equal(statuses.length, 25);
    statuses.forEach((status, index) => {
      assert.equal(status.ok, true, `item ${index} ok`);
      assert.equal(status.durable, true, `item ${index} durable`);
      assert.equal(status.projected, true, `item ${index} projected`);
      assert.equal(status.sequence, first.sequence + 1 + index, `item ${index} sequence is consecutive`);
      assert.match(status.eventHash, /^[a-f0-9]{64}$/);
    });
    const verification = h.verify();
    assert.equal(verification.valid, true, `chain verifies after the batch: ${verification.reason || ''}`);
    assert.equal(verification.headSequence, first.sequence + 25);
    assert.equal(h.jsonlLines().length, first.sequence + 25, 'jsonl projection carries every event');
    assert.equal(h.textLines().length, first.sequence + 25, 'text projection carries every event');
    const projected = h.jsonlLines().slice(-25).map(line => JSON.parse(line));
    assert.deepEqual(projected.map(row => row.target), items.map(item => item.target), 'projection order is batch order');
    for (let i = 1; i < projected.length; i += 1) {
      assert.equal(projected[i].previousHash, projected[i - 1].eventHash, `row ${i} chains to row ${i - 1}`);
    }
  } finally { h.close(); }
});

test('an anchor requested by one item covers every item, and the next record is a cache advance', () => {
  const h = harness('anchor');
  try {
    audit.record('warm.up', 'ledger', {}, h.dependencies);
    const statuses = audit.recordBatch([
      { action: 'mcp.tool.succeeded', target: 'read.one', details: {} },
      { action: 'mcp.tool.intent', target: 'write.one', details: {}, anchorRequired: true },
      { action: 'mcp.tool.succeeded', target: 'read.two', details: {} }
    ], h.dependencies);
    for (const status of statuses) {
      assert.equal(status.durable, true);
      assert.equal(status.anchored, true, `${status.eventId} is covered by the batch anchor`);
      assert.equal(status.protectedSequence, statuses[2].sequence, 'the anchor names the last sequence of the batch');
    }
    assert.doesNotThrow(() => audit.requireDurableStatus(statuses[1]), 'the anchored item satisfies the requireRecord contract');
    const before = audit.verificationStats ? audit.verificationStats(h.dependencies) : null;
    const next = audit.record('after.batch', 'ledger', {}, h.dependencies);
    assert.equal(next.durable, true);
    assert.equal(next.sequence, statuses[2].sequence + 1);
    if (before && typeof before.fullVerifications === 'number') {
      const after = audit.verificationStats(h.dependencies);
      assert.equal(after.fullVerifications, before.fullVerifications, 'the record after a batch did not need a full chain walk');
    }
  } finally { h.close(); }
});

test('an item that names its own event id and time keeps them through the batch', () => {
  const h = harness('identity');
  try {
    audit.record('warm.up', 'ledger', {}, h.dependencies);
    const statuses = audit.recordBatch([
      { action: 'coordinator.audit.policy.decision', target: 'subject-1', details: { k: 1 }, eventId: 'audit-11111111-1111-4111-8111-111111111111', occurredAtMs: 1_700_000_000_123 },
      { action: 'mcp.tool.succeeded', target: 'read.one', details: {} }
    ], h.dependencies);
    assert.equal(statuses[0].durable, true);
    assert.equal(statuses[0].eventId, 'audit-11111111-1111-4111-8111-111111111111', 'the caller-named event id is the stored one');
    const stored = h.jsonlLines().map(line => JSON.parse(line)).find(row => row.eventId === 'audit-11111111-1111-4111-8111-111111111111');
    assert.ok(stored, 'the event is projected under its own id');
    assert.equal(stored.occurredAtMs, 1_700_000_000_123, 'the caller-named time is the stored one');
    assert.match(statuses[1].eventId, /^audit-batch-/, 'an item without an id gets the factory id as before');
  } finally { h.close(); }
});

test('a batch of one is the ordinary record path', () => {
  const h = harness('one');
  try {
    const [status] = audit.recordBatch([{ action: 'only.one', target: 'ledger', details: { n: 1 } }], h.dependencies);
    assert.equal(status.durable, true);
    assert.equal(status.sequence, 1);
    assert.equal(audit.recordBatch([], h.dependencies).length, 0);
  } finally { h.close(); }
});

test('a batch the ledger cannot admit spools every item and marks a breach per item', () => {
  const h = harness('spool');
  try {
    audit.record('warm.up', 'ledger', {}, h.dependencies);
    // A store that refuses the writer lock stands in for a contended or
    // broken ledger; the emergency spool must still receive every item.
    const refusing = createAuditStore({ file: h.file, busyTimeoutMs: 1, transactionRetryMs: 1 });
    const blocker = createAuditStore({ file: h.file });
    const db = blocker._open();
    db.exec('BEGIN IMMEDIATE');
    try {
      const statuses = audit.recordBatch([
        { action: 'mcp.tool.succeeded', target: 'a', details: {} },
        { action: 'mcp.tool.intent', target: 'b', details: {}, anchorRequired: true }
      ], { ...h.dependencies, store: refusing, auditAdmissionRetryLimit: 0 });
      assert.equal(statuses.length, 2);
      for (const status of statuses) {
        assert.equal(status.durable, false);
        assert.equal(status.pending, 1, 'the item was spooled');
        assert.ok(status.errors.length >= 1);
      }
      assert.throws(() => audit.requireDurableStatus(statuses[1]), /Durable audit intent could not be recorded/);
      const spool = fs.readFileSync(path.join(h.dir, 'emergency.jsonl'), 'utf8').split('\n').filter(Boolean);
      assert.equal(spool.length, 2, 'both items reached the emergency spool');
    } finally {
      db.exec('ROLLBACK');
      blocker.close();
      refusing.close();
    }
  } finally { h.close(); }
});
