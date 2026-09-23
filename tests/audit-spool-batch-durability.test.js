'EXECUTABLE CHANGE';
'use strict';

// Discrimination report (testcanfail-tests-audit-spool-batch-durability-test-js):
// - MUTATION (batching removed): reverting src/lib/audit.js's chunked
//   withAppendBatch() drain back to the per-record loop turns
//   "a crash mid-drain commits no part of the batch" RED with
//   "AssertionError [ERR_ASSERTION]: a crash mid-drain must leave no
//   partially drained records ... 4 !== 0", and turns "draining N records
//   does not cost N ledger commits" RED with "draining 20 records must not
//   cost one ledger commit per record (saw 25 commits for 20 records)".
//   Restoring the fix byte-for-byte returns both to green (4 cases).
// - NOT-FOUND (2): no exit-status-only assertion stands in for the subject's
//   own output; the child's abort is confirmed AND the ledger it left behind
//   is read directly.
// - NOT-FOUND (3): no try/catch or optional chain swallows a subject failure.
// - NOT-FOUND (4): nothing asserts against a mock of the behavior under test.
//   The signer, paths, clock, reporter and anchor are injected only to keep
//   the real production drain off the real vault and the real ledger; the
//   drain, the SQLite transaction and the hash chain are all genuine.
// - NOT-FOUND (5): no skip or platform precondition guard.
// - NOT-FOUND (6): no expected value is computed by production code.
//   canonicalJson builds authenticated INPUT; every expected sequence, count
//   and action below is an independent literal.
// - PRECONDITION: node:sqlite is required, so this runs on Node.js >= 22.
//
// WHAT THIS PINS
//
// The emergency spool is drained by ingestEmergency() on every prepare().
// Each spooled record used to be its own BEGIN IMMEDIATE/COMMIT, and the
// ledger runs `PRAGMA synchronous=FULL` in WAL mode, so each record cost a
// real fsync. MEASURED 2026-09-03 (win32, node v22.14.0), draining 200
// spooled records, both sides back to back on the same loaded machine:
// before, 206 BEGIN / 206 COMMIT and 746-1028 ms; after chunking the drain
// into one transaction per 256 records, 7 BEGIN / 7 COMMIT and 475-542 ms,
// with time inside COMMIT falling from 243-255 ms to 8.0-9.8 ms.
//
// Batching an append loop is only allowed to be faster, never weaker, so the
// cases below assert the durability properties that make it safe rather than
// the speed:
//   - a crash midway through a batch commits NO part of that batch;
//   - the drain source survives that crash, so nothing is lost;
//   - re-draining after the crash restores every record exactly once, with a
//     contiguous, signature-valid hash chain;
//   - per-line admission is unchanged inside a batch: an unauthenticated line
//     is still refused and quarantined while its authentic neighbours land.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { canonicalJson, createAuditStore } = require('../src/lib/audit-store');
const audit = require('../src/lib/audit');

const REPO_ROOT = path.resolve(__dirname, '..');
const SPOOL_DOMAIN = 'toolsenabled.audit.spool.v1';
const SPOOL_CHALLENGE = 'toolsenabled.audit.spool.mac.v1';

// A fixed, exported keypair rather than tests/audit-spool-ingestion.test.js's
// throwaway one: the crash case needs a SECOND process to sign against the
// very same identity, so the material has to cross a process boundary. It is
// generated per run and never touches the real vault.
function exportableSigner(keyId) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-spool-batch-'));
  return {
    dir,
    emergency: path.join(dir, 'audit-emergency.jsonl'),
    ledger: path.join(dir, 'audit.sqlite3')
  };
}

// Same redirection tactic as tests/audit-spool-ingestion.test.js: the env
// override alone only moves the spool file, so rootPath is overridden too and
// every audit file this suite touches stays inside the scratch directory.
function pathsFor(space) {
  return {
    env: { TOOLSENABLED_AUDIT_EMERGENCY_PATH: space.emergency },
    rootPath: value => path.join(space.dir, value)
  };
}

function memoryAnchor() {
  let value = null;
  return { get: () => value, set(next) { value = next; } };
}

// Reproduces audit.js's internal spool mac derivation, exactly as the
// adjacent spool-ingestion suite does, so these lines are authenticated the
// way the real spool writer authenticates them.
function deriveMacKey(signer) {
  return crypto.createHash('sha256')
    .update(Buffer.from(signer.sign(Buffer.from(SPOOL_CHALLENGE, 'utf8'))))
    .digest();
}

function envelopeFor(item, signer) {
  const mac = crypto.createHmac('sha256', deriveMacKey(signer)).update(canonicalJson(item)).digest('hex');
  return { version: 1, domain: SPOOL_DOMAIN, item, mac };
}

function spoolItem(index, action = 'spool.batch.case') {
  const at = 1_756_000_000_000 + index;
  return {
    eventId: `audit-batch-${String(index).padStart(12, '0')}`,
    occurredAtMs: at,
    createdAtMs: at,
    event: {
      timestamp: new Date(at).toISOString(),
      action,
      target: `target-${index}`,
      details: { index }
    }
  };
}

function writeSpool(space, records) {
  fs.mkdirSync(space.dir, { recursive: true });
  fs.writeFileSync(space.emergency, records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8');
}

function drain(space, signer, store) {
  return audit.flush({ force: true }, {
    store,
    signer,
    ...pathsFor(space),
    clock: () => 1_756_000_900_000,
    reportError: () => {},
    report: () => {},
    anchorStore: memoryAnchor()
  });
}

function allEvents(store) {
  const events = [];
  let cursor = 0;
  for (;;) {
    const batch = store.listEvents({ afterSequence: cursor, limit: 1000 });
    if (!batch.length) return events;
    events.push(...batch);
    cursor = batch[batch.length - 1].sequence;
  }
}

// The spool source is renamed to `<base>.ingest-<pid>-<uuid><ext>` before the
// drain begins and unlinked only once the drain completes, so its presence is
// exactly the "nothing was lost" witness.
function spoolSourcesLeft(space) {
  return fs.readdirSync(space.dir).filter(name => name.startsWith('audit-emergency.ingest-'));
}

// ---------------------------------------------------------------------------

// A batch that dies partway through must commit NOTHING from that batch. This
// is the property that makes collapsing N commits into one legitimate: it
// leaves strictly less partial state behind than the per-record path did, not
// more. The kill is a real process abort inside the drain -- no exit handler,
// no graceful SQLite close -- so recovery is SQLite's genuine WAL recovery.
function testCrashMidBatchCommitsNoPartialDrain() {
  const space = scratch();
  const signer = exportableSigner('audit-batch-crash-0001');
  const total = 8;
  const killAfter = 4;
  writeSpool(space, Array.from({ length: total }, (unused, index) => envelopeFor(spoolItem(index), signer)));

  const config = path.join(space.dir, 'crash-config.json');
  fs.writeFileSync(config, JSON.stringify({
    repoRoot: REPO_ROOT,
    ledger: space.ledger,
    emergency: space.emergency,
    dir: space.dir,
    keyId: signer.keyId,
    privatePem: signer.privatePem,
    publicKeyPem: signer.publicKeyPem,
    killAfter
  }), 'utf8');

  const worker = path.join(space.dir, 'crash-worker.js');
  fs.writeFileSync(worker, [
    "'use strict';",
    "const crypto = require('node:crypto');",
    "const path = require('node:path');",
    `const config = require(${JSON.stringify(config)});`,
    "const { createAuditStore } = require(path.join(config.repoRoot, 'src/lib/audit-store'));",
    "const audit = require(path.join(config.repoRoot, 'src/lib/audit'));",
    'const key = crypto.createPrivateKey(config.privatePem);',
    'const signer = { keyId: config.keyId, publicKeyPem: config.publicKeyPem, sign: value => crypto.sign(null, value, key) };',
    'const store = createAuditStore({ file: config.ledger });',
    'let appended = 0;',
    'const realAppend = store.appendEvent.bind(store);',
    '// Abort from INSIDE the drain, between two records of the same batch.',
    'store.appendEvent = (input, eventSigner) => {',
    '  if (appended === config.killAfter) process.abort();',
    '  const result = realAppend(input, eventSigner);',
    '  appended += 1;',
    '  return result;',
    '};',
    'let anchor = null;',
    "audit.flush({ force: true }, {",
    '  store,',
    '  signer,',
    '  env: { TOOLSENABLED_AUDIT_EMERGENCY_PATH: config.emergency },',
    '  rootPath: value => path.join(config.dir, value),',
    '  clock: () => 1756000900000,',
    '  reportError: () => {},',
    '  report: () => {},',
    '  anchorStore: { get: () => anchor, set(next) { anchor = next; } }',
    '});',
    "process.stdout.write('DRAIN-COMPLETED-WITHOUT-CRASH');"
  ].join('\n'), 'utf8');

  const child = spawnSync(process.execPath, [worker], { encoding: 'utf8' });
  assert.notStrictEqual(child.status, 0, 'the drain worker must have died mid-batch, not completed');
  assert.ok(!String(child.stdout || '').includes('DRAIN-COMPLETED-WITHOUT-CRASH'),
    'the drain worker must have been killed before the drain returned');

  const crashed = createAuditStore({ file: space.ledger });
  const survivors = allEvents(crashed).filter(event => event.event.action === 'spool.batch.case');
  crashed.close();
  assert.strictEqual(survivors.length, 0,
    'a crash mid-drain must leave no partially drained records in the ledger');

  assert.strictEqual(spoolSourcesLeft(space).length, 1,
    'the drain source must survive the crash so the records are not lost');

  // Recovery: the very next drain must restore every record exactly once.
  const recovered = createAuditStore({ file: space.ledger });
  drain(space, signer, recovered);
  const events = allEvents(recovered).filter(event => event.event.action === 'spool.batch.case');
  assert.strictEqual(events.length, total, 're-draining after a crash must restore every spooled record');
  assert.deepStrictEqual(events.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8],
    'the recovered records must occupy a contiguous sequence range');
  assert.deepStrictEqual(events.map(event => event.event.details.index), [0, 1, 2, 3, 4, 5, 6, 7],
    'every spooled record must appear exactly once, in spool order');

  const verification = recovered.verify();
  assert.strictEqual(verification.valid, true, 'the recovered hash chain must verify');
  assert.strictEqual(verification.signaturesValid, true, 'every recovered record must still carry a valid signature');
  assert.strictEqual(verification.entries, total, 'the ledger must hold exactly the recovered records');
  recovered.close();
  assert.strictEqual(spoolSourcesLeft(space).length, 0,
    'a completed drain must retire its source');
}

// The hash chain has to link ACROSS records that share one transaction. If a
// batched append read a stale head, records would collide on sequence or
// carry a previous_hash that does not name their predecessor.
function testChainLinksAcrossRecordsInOneBatch() {
  const space = scratch();
  const signer = exportableSigner('audit-batch-chain-0001');
  const total = 20;
  writeSpool(space, Array.from({ length: total }, (unused, index) => envelopeFor(spoolItem(index), signer)));

  const store = createAuditStore({ file: space.ledger });
  drain(space, signer, store);
  const events = allEvents(store).filter(event => event.event.action === 'spool.batch.case');
  assert.strictEqual(events.length, total, 'every spooled record must reach the ledger');

  for (let index = 1; index < events.length; index += 1) {
    assert.strictEqual(events[index].sequence, events[index - 1].sequence + 1,
      `record ${index} must follow its predecessor without a sequence gap`);
    assert.strictEqual(events[index].previousHash, events[index - 1].eventHash,
      `record ${index} must name its predecessor's hash`);
  }
  assert.strictEqual(events[0].previousHash, '0'.repeat(64),
    'the first record must chain to the genesis hash');

  const verification = store.verify();
  assert.strictEqual(verification.valid, true, 'a batched drain must leave a valid chain');
  assert.strictEqual(verification.signaturesValid, true, 'a batched drain must leave valid signatures');
  store.close();
}

// The point of the change: N spooled records must not cost N commits, because
// each commit is an fsync under `PRAGMA synchronous=FULL`.
function testDrainDoesNotCommitOncePerRecord() {
  const space = scratch();
  const signer = exportableSigner('audit-batch-commits-0001');
  const total = 20;
  writeSpool(space, Array.from({ length: total }, (unused, index) => envelopeFor(spoolItem(index), signer)));

  const store = createAuditStore({ file: space.ledger });
  // Counting the driver's own COMMITs is the only place the fsync count is
  // observable; tests/audit-verify-cached-health-read.test.js reaches the
  // same handle. Opened here so schema migration is not counted.
  const db = store._open();
  const realExec = db.exec.bind(db);
  let commits = 0;
  db.exec = sql => {
    if (String(sql).trim().toUpperCase().startsWith('COMMIT')) commits += 1;
    return realExec(sql);
  };

  drain(space, signer, store);
  const events = allEvents(store).filter(event => event.event.action === 'spool.batch.case');
  assert.strictEqual(events.length, total, 'every spooled record must reach the ledger');
  assert.ok(commits < total,
    `draining ${total} records must not cost one ledger commit per record (saw ${commits} commits for ${total} records)`);
  store.close();
}

// Batching must not blur per-line admission. An unauthenticated line sharing
// a batch with authentic ones must still be refused and quarantined, and must
// not take its neighbours down with it (AUDIT-F-03).
function testUnauthenticatedLineInABatchIsStillRefused() {
  const space = scratch();
  const signer = exportableSigner('audit-batch-mixed-0001');
  const attacker = exportableSigner('audit-batch-attacker-0001');
  writeSpool(space, [
    envelopeFor(spoolItem(0), signer),
    envelopeFor(spoolItem(1, 'attacker.forged'), attacker),
    envelopeFor(spoolItem(2), signer)
  ]);

  const store = createAuditStore({ file: space.ledger });
  drain(space, signer, store);
  const actions = allEvents(store).map(event => event.event.action);
  assert.ok(!actions.includes('attacker.forged'),
    'a line whose mac does not verify must never reach the canonical ledger, batch or no batch');
  assert.strictEqual(actions.filter(action => action === 'spool.batch.case').length, 2,
    'the authentic lines sharing the batch must still be admitted');
  assert.ok(actions.includes('audit.emergency.quarantined'),
    'the refused line must still be quarantined');
  const quarantine = fs.readdirSync(space.dir).filter(name => name.startsWith('audit-emergency.jsonl.quarantine-'));
  assert.strictEqual(quarantine.length, 1, 'the poisoned spool source must be preserved for manual review');
  store.close();
}

const CASES = [
  ['a crash mid-drain commits no part of the batch', testCrashMidBatchCommitsNoPartialDrain],
  ['the hash chain links across records sharing one batch', testChainLinksAcrossRecordsInOneBatch],
  ['draining N records does not cost N ledger commits', testDrainDoesNotCommitOncePerRecord],
  ['an unauthenticated line in a batch is still refused', testUnauthenticatedLineInABatchIsStillRefused]
];

assert.strictEqual(CASES.length, 4, 'audit spool batch durability must execute all four cases');

for (const [name, run] of CASES) {
  run();
  process.stdout.write(`  ok  ${name}\n`);
}
process.stdout.write(`Audit emergency-spool batch durability tests passed (${CASES.length} cases)\n`);
