/* HISTORICAL DISCRIMINATION RECORD (before the V24 table rename)
 * Assertion strengthened: the post-migration schema version is now compared
 * with the independently specified version 23, rather than SCHEMA_VERSION
 * imported from the implementation being checked.
 *
 * Mutation: state-store's health result and exported SCHEMA_VERSION were both
 * temporarily changed to 22. Before this change the test stayed green:
 *   "Transactional state cross-process tests passed."
 * After this change the mutation is rejected:
 *   "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n22 !== 23"
 * The source was restored byte-for-byte (SHA-256 before and after:
 * b615db5aafd92de72b350cbff129ff3a28076cf7a325a220fbce740caf364064).
 * The restored test is green:
 *   "Transactional state cross-process tests passed."
 *
 * NOT-FOUND (1): no vacuous collection assertion; every() inputs are fixed-size
 * or preceded by an exact non-zero length assertion.
 * NOT-FOUND (2): no exit-status/truthy-return-only assertion; workers must emit
 * exactly one parseable JSON line and no stderr.
 * NOT-FOUND (3): no swallowed target failure; cleanup catches are cleanup-only,
 * and the reservation catch is followed by assertions on both result and code.
 * NOT-FOUND (4): no assertion against a mock of the state store under test.
 * NOT-FOUND (5): no skip or platform precondition guard.
 * NOT-FOUND (6), other than the corrected schema-version assertion: no expected
 * value is computed by the implementation operation it checks.
 * Preconditions: Node 22+ with node:sqlite was required and met using Node 22.22.2.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const { createStateStore, hashInput } = require('../../src/lib/state-store');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(__dirname, 'state-concurrency-worker.js');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseSingleLine(stdout, label) {
  const lines = String(stdout).split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `${label} must emit exactly one JSON line.`);
  return JSON.parse(lines[0]);
}

function runWorker(mode, databasePath, identity, startAt, payload = undefined) {
  return new Promise((resolve, reject) => {
    const argumentsValue = [WORKER, mode, databasePath, String(identity), String(startAt)];
    if (payload !== undefined) argumentsValue.push(JSON.stringify(payload));
    execFile(process.execPath, argumentsValue, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`;
        reject(error);
        return;
      }
      try {
        assert.equal(stderr, '', `${mode} worker wrote unexpected stderr.`);
        resolve(parseSingleLine(stdout, mode));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function assertIntegrity(store) {
  const result = store.checkIntegrity({ full: true });
  const value = typeof result === 'string'
    ? result
    : result && (result.result || result.status || result.integrity);
  assert.ok(result === true || result && (result.ok === true || result.valid === true) || /^ok$/i.test(String(value || '')),
    `SQLite integrity check failed: ${JSON.stringify(result)}`);
}

function expectStateCode(callback, code) {
  assert.throws(callback, error => error && error.code === code);
}

function spendEntries(store) {
  const result = store.listSpend({ limit: 1000 });
  return Array.isArray(result) ? result : result && result.entries;
}

function initializeDatabase(databasePath) {
  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  try { assertIntegrity(store); }
  finally { if (typeof store.close === 'function') store.close(); }
}

async function distinctSpendContention(databasePath) {
  // Deliberately leave the database absent: all workers race through the first
  // WAL/schema initialization as well as the atomic cap transaction.
  assert.equal(fs.existsSync(databasePath), false);
  const startAt = Date.now() + 1000;
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    runWorker('spend-distinct', databasePath, index, startAt)));
  const succeeded = results.filter(result => result.ok === true);
  const rejected = results.filter(result => result.ok === false);
  assert.equal(succeeded.length, 5);
  assert.ok(succeeded.every(result => result.replayed === false));
  assert.equal(rejected.length, 15);
  assert.ok(rejected.every(result => result.code === 'SPEND_LIMIT_EXCEEDED'),
    `Unexpected spend rejection: ${JSON.stringify(rejected)}`);

  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  try {
    const entries = spendEntries(store);
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 5);
    assert.equal(entries.reduce((sum, entry) => sum + entry.amountCents, 0), 500);
    assert.equal(new Set(entries.map(entry => entry.reference)).size, 5);
    assertIntegrity(store);
  } finally {
    if (typeof store.close === 'function') store.close();
  }
}

async function identicalSpendReplay(databasePath) {
  initializeDatabase(databasePath);
  const startAt = Date.now() + 1000;
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    runWorker('spend-same', databasePath, index, startAt)));
  assert.ok(results.every(result => result.ok === true));
  assert.equal(results.filter(result => result.replayed === false).length, 1);
  assert.equal(results.filter(result => result.replayed === true).length, 9);
  assert.equal(new Set(results.map(result => result.entryId)).size, 1);

  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  try {
    const entries = spendEntries(store);
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].amountCents, 100);
    assert.equal(entries[0].provider, 'concurrency-fixture');
    assert.equal(entries[0].reference, 'same-reference');
    assertIntegrity(store);
  } finally {
    if (typeof store.close === 'function') store.close();
  }
}

function policyApprovalAttachment(store, suffix, argumentsValue) {
  const toolName = 'github.issue_create';
  const task = store.submitTask({
    queue: 'p13', type: 'policy', idempotencyKey: `p13-approval-attachment-${suffix}`,
    payload: { title: 'P13 approval attachment fixture', objective: 'Test one approval attachment across task-bound dispatches.' }
  }).task;
  const profileId = `p13.replay.${suffix}`;
  const profileHash = hashInput({ domain: 'p13-replay-profile', suffix, taskId: task.id });
  const requestHash = hashInput({ domain: 'p13-replay-request', suffix, taskId: task.id, toolName });
  const request = { profileHash, requestHash, request: { taskId: task.id, tool: toolName } };
  const now = Date.now();
  store.transaction(db => {
    db.prepare(`INSERT INTO capability_profile_versions(profile_id, version, task_id, manifest_json, manifest_hash, parent_hash, expires_at_ms, created_at_ms)
      VALUES(?, 1, ?, ?, ?, NULL, ?, ?)`)
      .run(profileId, task.id, JSON.stringify({ fixture: 'p13-approval-attachment' }), profileHash, now + 60_000, now);
    db.prepare(`INSERT INTO capability_profile_requests(request_id, task_id, request_kind, profile_id, profile_version, profile_hash, request_hash, request_json, status, created_at_ms)
      VALUES(?, ?, 'tool', ?, 1, ?, ?, ?, 'authorized', ?)`)
      .run(`p13-replay-request-${suffix}-0001`, task.id, profileId, profileHash, requestHash, JSON.stringify(request), now);
  });
  const authorizationId = `p13-replay-authorization-${suffix}-0001`;
  store.createPolicyDispatchAuthorization({
    authorizationId, taskId: task.id, toolName, argsHash: hashInput(argumentsValue), targetKind: 'external',
    targetHash: hashInput({ domain: 'p13-replay-target', suffix }), provenance: null,
    risk: 'low', delegationDepth: 0, userKind: 'owner-authenticated', requestHash
  });
  return { authorizationId, taskId: task.id, toolName };
}

function preparePolicyApprovalAttachmentPair(store, suffix) {
  const argumentsValue = { owner: 'fixture-org', repo: 'fixture-repo', title: `P13 approval attachment ${suffix}` };
  const left = policyApprovalAttachment(store, `${suffix}-left`, argumentsValue);
  const right = policyApprovalAttachment(store, `${suffix}-right`, argumentsValue);
  assert.notEqual(left.taskId, right.taskId, 'the replay test must use distinct task-bound P13 authorizations');
  const approvalInputHash = hashInput({ action: left.toolName, arguments: argumentsValue });
  const tokenHash = hashInput({ domain: 'p13-replay-approval', suffix });
  store.createApprovalGrant({
    id: `p13-replay-approval-${suffix}-0001`, action: left.toolName, inputHash: approvalInputHash,
    tokenHash, expiresAtMs: Date.now() + 60_000
  });
  const grant = store.consumeApprovalGrant({ action: left.toolName, inputHash: approvalInputHash, tokenHash });
  return { argumentsValue, left, right, approvalId: grant.approvalId, approvalInputHash };
}

function consumePolicyApprovalAttachment(store, authorization, fixture) {
  return store.consumePolicyDispatchAuthorization({
    authorizationId: authorization.authorizationId,
    toolName: authorization.toolName,
    argsHash: hashInput(fixture.argumentsValue),
    approvalId: fixture.approvalId,
    approvalInputHash: fixture.approvalInputHash
  });
}

function assertApprovalAttachmentIndex(store) {
  const index = store.transaction(db => db.prepare(`SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND name = 'policy_dispatch_consumptions_approval_once_idx'`).get());
  assert.match(index && index.sql || '', /ON policy_dispatch_consumptions\(approval_id\)\s+WHERE approval_id IS NOT NULL/i);
}

async function policyApprovalAttachmentSequentialReopen(databasePath) {
  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  const fixture = preparePolicyApprovalAttachmentPair(store, 'sequential');
  assert.equal(consumePolicyApprovalAttachment(store, fixture.left, fixture).approval.status, 'consumed');
  store.close();

  const reopened = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  try {
    expectStateCode(() => consumePolicyApprovalAttachment(reopened, fixture.right, fixture), 'POLICY_APPROVAL_EVIDENCE_REPLAYED');
    assert.equal(reopened.transaction(db => db.prepare(`SELECT COUNT(*) AS count FROM policy_dispatch_consumptions
      WHERE approval_id = ?`).get(fixture.approvalId).count), 1);
    assertApprovalAttachmentIndex(reopened);
    assertIntegrity(reopened);
  } finally {
    reopened.close();
  }
}

async function policyApprovalAttachmentConcurrent(databasePath) {
  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  const fixture = preparePolicyApprovalAttachmentPair(store, 'concurrent');
  store.close();
  const startAt = Date.now() + 1000;
  const results = await Promise.all([fixture.left, fixture.right].map((authorization, index) => runWorker(
    'policy-approval-attach', databasePath, index, startAt, {
      authorizationId: authorization.authorizationId,
      toolName: authorization.toolName,
      argsHash: hashInput(fixture.argumentsValue),
      approvalId: fixture.approvalId,
      approvalInputHash: fixture.approvalInputHash
    }
  )));
  assert.equal(results.filter(result => result.ok === true).length, 1, JSON.stringify(results));
  assert.equal(results.filter(result => result.ok === false && result.code === 'POLICY_APPROVAL_EVIDENCE_REPLAYED').length, 1, JSON.stringify(results));

  const reopened = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  try {
    assert.equal(reopened.transaction(db => db.prepare(`SELECT COUNT(*) AS count FROM policy_dispatch_consumptions
      WHERE approval_id = ?`).get(fixture.approvalId).count), 1);
    assertApprovalAttachmentIndex(reopened);
    assertIntegrity(reopened);
  } finally {
    reopened.close();
  }
}

// A DATABASE OLDER THAN 23 HAS THE THREE telegram_* TABLES. MIGRATION_V1 created
// them and MIGRATION_V23 (2026-08-23, the Telegram connector removal) drops them.
//
// The legacy fixture below stamps an old user_version onto a CURRENT database,
// which has already been migrated past 23. Without this it would describe a
// database that never existed and _validateSchema is right to refuse it on reopen.
// The CREATE text is byte-identical to SCHEMA_V1's, including the two singleton
// INSERTs its invariants check; a character of drift changes the DDL fingerprint
// and the reopen fails loudly rather than passing quietly. The three DROP IF EXISTS
// lines make it idempotent -- only they are conditional.
//
// V24 also renamed the durable-mission tables and four indexes. Restore their
// actual v14 names before stamping that version, as the state-store migration
// fixtures do. Production fingerprint checks remain unchanged.
const RESTORE_LEGACY_MISSION_NAMES = `
  ALTER TABLE coordinator_missions RENAME TO jarvis_missions;
  ALTER TABLE coordinator_phase_states RENAME TO jarvis_phase_states;
  ALTER TABLE coordinator_workflow_missions RENAME TO jarvis_workflow_missions;
  ALTER TABLE coordinator_broker_verifications RENAME TO jarvis_broker_verifications;
  ALTER TABLE coordinator_workflow_events RENAME TO jarvis_workflow_events;
  ALTER TABLE coordinator_workflow_outbox RENAME TO jarvis_workflow_outbox;
  ALTER TABLE coordinator_workflow_acceptances RENAME TO jarvis_workflow_acceptances;
  DROP INDEX coordinator_missions_updated_idx;
  CREATE INDEX jarvis_missions_updated_idx ON jarvis_missions(updated_at_ms DESC, run_id);
  DROP INDEX coordinator_phase_states_run_idx;
  CREATE INDEX jarvis_phase_states_run_idx ON jarvis_phase_states(run_id, updated_at_ms DESC, actor);
  DROP INDEX coordinator_workflow_missions_task_idx;
  CREATE INDEX jarvis_workflow_missions_task_idx ON jarvis_workflow_missions(task_id, updated_at_ms DESC);
  DROP INDEX coordinator_workflow_outbox_delivery_idx;
  CREATE INDEX jarvis_workflow_outbox_delivery_idx ON jarvis_workflow_outbox(run_id, status, created_at_ms, outbox_id);
`;

function policyApprovalAttachmentMigration(databasePath, corrupt = false) {
  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  const fixture = corrupt ? preparePolicyApprovalAttachmentPair(store, 'migration-corrupt') : null;
  store.transaction(db => {
    db.exec(`${RESTORE_LEGACY_MISSION_NAMES}
      DROP TABLE scoped_approval_events;
      DROP TABLE scoped_approval_grants;
      DROP TABLE scoped_approval_actions;
      DROP TABLE scoped_approval_provenance;
      DROP INDEX policy_dispatch_consumptions_approval_once_idx;
      DROP TABLE research_findings;
      DROP TABLE research_results;
      DROP TABLE research_runs;
      DROP TABLE research_experiments;
      DROP TABLE research_project_sessions;
      DROP TABLE research_projects;
            DROP TABLE IF EXISTS telegram_updates;
      DROP TABLE IF EXISTS telegram_poll_lease;
      DROP TABLE IF EXISTS telegram_cursor;
  CREATE TABLE telegram_cursor (
    provider TEXT PRIMARY KEY CHECK(provider = 'telegram'),
    next_update_id INTEGER NOT NULL CHECK(next_update_id >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
  ) STRICT;
  INSERT INTO telegram_cursor(provider, next_update_id, updated_at_ms) VALUES('telegram', 0, 0);

  CREATE TABLE telegram_poll_lease (
    provider TEXT PRIMARY KEY CHECK(provider = 'telegram'),
    owner_id TEXT,
    token TEXT,
    fence INTEGER NOT NULL CHECK(fence >= 0),
    expires_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
    CHECK((owner_id IS NULL AND token IS NULL AND expires_at_ms IS NULL) OR
          (owner_id IS NOT NULL AND token IS NOT NULL AND expires_at_ms IS NOT NULL))
  ) STRICT;
  INSERT INTO telegram_poll_lease(provider, owner_id, token, fence, expires_at_ms, updated_at_ms)
    VALUES('telegram', NULL, NULL, 0, NULL, 0);

  CREATE TABLE telegram_updates (
    update_id INTEGER PRIMARY KEY CHECK(update_id >= 0),
    received_at_ms INTEGER NOT NULL CHECK(received_at_ms >= 0),
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64)
  ) STRICT;
  CREATE INDEX telegram_updates_received_idx ON telegram_updates(received_at_ms, update_id);
      PRAGMA user_version = 14;`);
    if (fixture) {
      const insert = db.prepare(`INSERT INTO policy_dispatch_consumptions(authorization_id, args_hash, consumed_at_ms, approval_id)
        VALUES(?, ?, ?, ?)`);
      const now = Date.now();
      insert.run(fixture.left.authorizationId, hashInput(fixture.argumentsValue), now, fixture.approvalId);
      insert.run(fixture.right.authorizationId, hashInput(fixture.argumentsValue), now, fixture.approvalId);
    }
  });
  store.close();

  const reopened = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  try {
    if (corrupt) {
      expectStateCode(() => reopened.health(), 'POLICY_APPROVAL_EVIDENCE_REPLAYED');
      return;
    }
    // Deliberately pinned independently of the product's SCHEMA_VERSION.
    // The real V24 rename is now part of this v14-to-current migration.
    assert.equal(reopened.health().schemaVersion, 24);
    assertApprovalAttachmentIndex(reopened);
    assertIntegrity(reopened);
  } finally {
    reopened.close();
  }
}

async function crashedExecutingOperation(databasePath, liveChildren) {
  initializeDatabase(databasePath);
  const leaseMs = 1000;
  const operationHash = hashInput({
    userId: 'concurrency-owner',
    imageUrl: 'https://example.test/crash.jpg',
    caption: 'crash fixture'
  });
  const child = spawn(process.execPath, [
    WORKER, 'operation-executing', databasePath, String(leaseMs), '0', operationHash
  ], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  liveChildren.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  const ready = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`Operation worker did not become ready. stderr: ${stderr}`));
    }, 10_000);
    lines.once('line', line => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); }
      catch (error) { reject(error); }
    });
    child.once('exit', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Operation worker exited before READY with code ${code}. stderr: ${stderr}`));
      }
    });
  });
  assert.equal(ready.ready, true);

  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
  liveChildren.delete(child);
  lines.close();
  assert.equal(String(stderr), '', 'Operation worker wrote unexpected stderr.');
  parseSingleLine(stdout, 'operation-executing');

  await delay(leaseMs + 250);
  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  try {
    let reservation;
    let thrown;
    try {
      reservation = await store.reserveOperation({
        type: 'instagram.publish_image',
        key: 'crash-after-executing',
        inputHash: operationHash,
        ownerId: 'parent-after-crash',
        leaseMs: 1000
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal(reservation, undefined, 'An expired executing operation must never be reserved or replayed.');
    assert.equal(thrown && thrown.code, 'OPERATION_UNCERTAIN');
    assertIntegrity(store);
  } finally {
    if (typeof store.close === 'function') store.close();
  }
}

async function crashedUncommittedTransaction(databasePath, liveChildren) {
  initializeDatabase(databasePath);
  const child = spawn(process.execPath, [WORKER, 'transaction-crash', databasePath, '0', '0'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  liveChildren.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const ready = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`Transaction worker did not become ready. stderr: ${stderr}`));
    }, 10_000);
    lines.once('line', line => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); }
      catch (error) { reject(error); }
    });
    child.once('exit', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Transaction worker exited before READY with code ${code}. stderr: ${stderr}`));
      }
    });
  });
  assert.equal(ready.ready, true);

  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
  liveChildren.delete(child);
  lines.close();
  assert.equal(stderr, '', 'Transaction worker wrote unexpected stderr.');
  parseSingleLine(stdout, 'transaction-crash');

  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  try {
    assert.equal(spendEntries(store).length, 0, 'A row from a killed uncommitted transaction must be rolled back.');
    assertIntegrity(store);
  } finally {
    if (typeof store.close === 'function') store.close();
  }
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-state-concurrency-'));
  const liveChildren = new Set();
  try {
    await distinctSpendContention(path.join(temporary, 'distinct.sqlite'));
    await identicalSpendReplay(path.join(temporary, 'same.sqlite'));
    await policyApprovalAttachmentSequentialReopen(path.join(temporary, 'p13-approval-sequential.sqlite'));
    await policyApprovalAttachmentConcurrent(path.join(temporary, 'p13-approval-concurrent.sqlite'));
    policyApprovalAttachmentMigration(path.join(temporary, 'p13-approval-migration.sqlite'));
    policyApprovalAttachmentMigration(path.join(temporary, 'p13-approval-migration-corrupt.sqlite'), true);
    await crashedUncommittedTransaction(path.join(temporary, 'transaction-crash.sqlite'), liveChildren);
    await crashedExecutingOperation(path.join(temporary, 'crash.sqlite'), liveChildren);
    console.log('Transactional state cross-process tests passed.');
  } finally {
    for (const child of liveChildren) {
      try { child.kill('SIGKILL'); } catch { /* Already stopped. */ }
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
