'use strict';
/* Compaction must not move anything the history chain speaks for.
   Synthetic ledger + chain, so the test needs no live profile. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('../src/lib/owner-request-store.js');
const compact = require('../tools/ledger-compact.js');
const verifier = require('../tools/ledger-compact-verify.js');

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ledger-compact-'));
const ledgerFile = path.join(root, 'reports', 'OWNER-REQUEST-LEDGER.json');
const historyFile = path.join(root, 'state', 'owner-request-record-events.jsonl');
fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
fs.mkdirSync(path.dirname(historyFile), { recursive: true });

function record(id, decisionCount, reviewAt) {
  const decisions = [];
  for (let n = 0; n < decisionCount; n += 1) {
    decisions.push(n === reviewAt
      ? { at: `2026-09-0${(n % 9) + 1}T00:00:00.000Z`, actor: 'claude', decision: 'review', status: 'in-progress', reason: `review prose ${n} `.repeat(6) }
      : { at: `2026-09-0${(n % 9) + 1}T00:00:00.000Z`, actor: 'claude', decision: 'progress', status: 'in-progress', reason: `progress prose ${n} `.repeat(20) });
  }
  const history = [{ seq: 0, kind: 'file', at: '2026-09-01T00:00:00.000Z', actor: 'claude', eventSha256: '' }];
  for (let n = 0; n < decisionCount; n += 1) history.push({ seq: 0, kind: 'resolve', at: '2026-09-02T00:00:00.000Z', actor: 'claude', statusBefore: 'open', eventSha256: '' });
  return {
    id, verbatim: `the words of ${id}`, request: `(interpretation) the words of ${id}`,
    status: 'in-progress', scope: 'global', scopeKey: null, parentId: null, filedBy: 'claude',
    filedAt: '2026-09-01T00:00:00.000Z', removedAt: null, removedBy: null, gates: [],
    provenance: { class: 'agent-inferred', recordedBy: 'claude', recordedAt: '2026-09-01T00:00:00.000Z', source: 'test', note: 'a note that is only prose' },
    captureLog: [{ at: '2026-09-01T00:00:00.000Z', actor: 'claude', mode: 'new', gatesAdded: 0, source: 'test' },
      { at: '2026-09-02T00:00:00.000Z', actor: 'claude', mode: 'append', gatesAdded: 0, source: 'test again' }],
    decisions, history
  };
}
// A tombstoned record too: compaction must keep it, not drop it.
const removed = record('T3', 3, null);
removed.status = 'removed';
removed.removedAt = '2026-09-09T00:00:00.000Z';
removed.removedBy = 'owner';
const document = {
  requests: [record('R1175', 12, 4), record('T1', 40, 7), record('T2', 1, null), removed],
  schemaVersion: 1, revision: 5, updatedAt: '2026-09-24',
  statusVocabulary: store.STATUS_VOCABULARY
};
fs.writeFileSync(ledgerFile, compact.serialize(document), 'utf8');

// A chain whose last word about each record is that record's current core.
let previous = store.GENESIS_SHA256;
const lines = [];
document.requests.forEach((entry, index) => {
  const event = {
    schemaVersion: 1, eventId: crypto.randomUUID(), seq: index + 1, at: '2026-09-24T00:00:00.000Z',
    actor: 'claude', kind: 'file', requestId: entry.id, scope: entry.scope, scopeKey: entry.scopeKey,
    statusAfter: entry.status, coreSha256: store.coreSha256(entry), ledgerRevision: 5, prevSha256: previous
  };
  event.eventSha256 = store.chainHash(previous, event);
  previous = event.eventSha256;
  lines.push(JSON.stringify(event));
});
// One id the chain names that the document does not hold: the torn tail this
// ledger already has. Compaction must leave it reported exactly as it is.
const torn = { schemaVersion: 1, eventId: crypto.randomUUID(), seq: 5, at: '2026-09-24T00:00:00.000Z', actor: 'claude', kind: 'file', requestId: 'R9001', scope: 'global', scopeKey: null, statusAfter: 'open', coreSha256: store.coreSha256({ id: 'R9001' }), ledgerRevision: 5, prevSha256: previous };
torn.eventSha256 = store.chainHash(previous, torn);
lines.push(JSON.stringify(torn));
fs.writeFileSync(historyFile, lines.join('\n') + '\n', 'utf8');

const baseline = store.verifyHistory({ ledgerFile, historyFile });
assert.strictEqual(baseline.drift.length, 0, `fixture drifts: ${baseline.drift.join(',')}`);
assert.deepStrictEqual([...baseline.missing], ['R9001'], 'fixture must start with exactly one torn id');

const beforeRaw = fs.readFileSync(ledgerFile, 'utf8');
const beforeCopy = path.join(root, 'before.json');
fs.writeFileSync(beforeCopy, beforeRaw, 'utf8');

// 1. A dry run writes nothing.
const sidecar = path.join(root, 'reports', 'OWNER-REQUEST-LEDGER.archive.jsonl');
const dry = compact.run(['--ledger', ledgerFile, '--history', historyFile, '--sidecar', sidecar]);
assert.strictEqual(fs.readFileSync(ledgerFile, 'utf8'), beforeRaw, 'a dry run changed the ledger');
assert.ok(!fs.existsSync(sidecar), 'a dry run wrote a sidecar');
assert.ok(dry.bytesSaved > 0, 'the dry run claims no saving');
assert.strictEqual(dry.recordsRemoved, 0);
assert.strictEqual(dry.tombstonedRecordsKept, 1, 'the tombstoned record was not counted as kept');

// 2. Apply, then every invariant.
const applied = compact.run(['--ledger', ledgerFile, '--history', historyFile, '--sidecar', sidecar, '--apply']);
assert.strictEqual(applied.bytesAfter, fs.statSync(ledgerFile).size);
assert.deepStrictEqual({ bytesBefore: dry.bytesBefore, bytesAfter: dry.bytesAfter, reasonsFolded: dry.reasonsFolded },
  { bytesBefore: applied.bytesBefore, bytesAfter: applied.bytesAfter, reasonsFolded: applied.reasonsFolded },
  'the dry run did not predict the apply');

const result = verifier.verify({ before: beforeCopy, after: ledgerFile, history: historyFile, historyAfter: historyFile, sidecar });
for (const check of result.checks) assert.ok(check.pass, `${check.name} failed: ${check.detail}`);
assert.ok(result.ok);

// 3. The chain's own verdict is untouched, torn tail included.
const after = store.verifyHistory({ ledgerFile, historyFile });
assert.strictEqual(after.ok, baseline.ok);
assert.strictEqual(after.head, baseline.head);
assert.deepStrictEqual([...after.missing], [...baseline.missing], 'compaction changed which ids the chain misses');
assert.deepStrictEqual([...after.drift], [...baseline.drift], 'compaction introduced drift');
assert.deepStrictEqual([...after.unchained], [...baseline.unchained]);

// 4. Nothing hashed moved; the review row is byte-exact; no record left.
const compacted = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
assert.strictEqual(compacted.requests.length, document.requests.length);
for (const entry of document.requests) {
  const other = compacted.requests.find(row => row.id === entry.id);
  assert.ok(other, `${entry.id} disappeared`);
  assert.strictEqual(store.coreSha256(other), store.coreSha256(entry), `${entry.id} core moved`);
  assert.strictEqual(other.decisions.length, entry.decisions.length, `${entry.id} decisions.length moved`);
  assert.strictEqual(JSON.stringify(other.decisions.filter(row => row.decision === 'review')),
    JSON.stringify(entry.decisions.filter(row => row.decision === 'review')), `${entry.id} review rows changed`);
  assert.strictEqual(other.captureLog[0].source, entry.captureLog[0].source, `${entry.id} lost its first capture`);
  assert.ok(other.history.length >= 1 && other.history.at(-1).kind === entry.history.at(-1).kind, `${entry.id} lost its last history row`);
}

// 5. Restore is exact, and its dry run does not write either.
const restoreDry = compact.run(['--restore', '--ledger', ledgerFile, '--sidecar', sidecar]);
assert.strictEqual(restoreDry.reproducesOriginal, true);
assert.notStrictEqual(fs.readFileSync(ledgerFile, 'utf8'), beforeRaw, 'the restore dry run wrote the file');
compact.run(['--restore', '--ledger', ledgerFile, '--sidecar', sidecar, '--apply']);
assert.strictEqual(fs.readFileSync(ledgerFile, 'utf8'), beforeRaw, 'restore is not byte exact');

// 6. A compaction that moved a hashed field must be caught, not passed.
const tampered = path.join(root, 'tampered.json');
const bad = JSON.parse(beforeRaw);
bad.requests[1].decisions.pop();
fs.writeFileSync(tampered, compact.serialize(bad), 'utf8');
const caught = verifier.verify({ before: beforeCopy, after: tampered, history: historyFile, historyAfter: historyFile, sidecar });
assert.strictEqual(caught.ok, false, 'the verifier passed a ledger whose decisions.length moved');
assert.ok(caught.checks.some(check => check.name === 'core-identical' && !check.pass));
assert.ok(caught.checks.some(check => check.name === 'decisions-length' && !check.pass));

fs.rmSync(root, { recursive: true, force: true });
console.log('ledger-compact: 6 groups OK');
