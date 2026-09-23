'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const { createStateStore, SCHEMA_VERSION } = require('../../src/lib/state-store');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(__dirname, 'task-worker.js');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function taskInput(key, overrides = {}) {
  return {
    queue: 'concurrency.queue',
    type: 'agent.task',
    idempotencyKey: key,
    payload: { title: key, objective: `Execute ${key}`, context: 'Cross-process fixture; untrusted.' },
    priority: 0,
    maxAttempts: 3,
    retryBackoffMs: 0,
    maxRetryBackoffMs: 0,
    expiryPolicy: 'uncertain',
    ...overrides
  };
}

function taskId(value) {
  const task = value && value.task ? value.task : value;
  return task && (task.taskId || task.id);
}

function parseSingleLine(stdout, label) {
  const lines = String(stdout).split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `${label} must emit exactly one JSON line: ${stdout}`);
  return JSON.parse(lines[0]);
}

function runWorker(mode, databasePath, input, startAt = 0) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [WORKER, mode, databasePath, encode(input), String(startAt)], {
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

async function spawnHolding(mode, databasePath, input, liveChildren) {
  const child = spawn(process.execPath, [WORKER, mode, databasePath, encode(input), '0'], {
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
      if (settled) return;
      settled = true;
      reject(new Error(`${mode} worker did not become ready. stderr: ${stderr}`));
    }, 10_000);
    lines.once('line', line => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); }
      catch (error) { reject(error); }
    });
    child.once('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${mode} worker exited before READY with code ${code}. stderr: ${stderr}`));
    });
  });
  assert.equal(ready.ready, true, JSON.stringify(ready));
  return {
    child, lines, ready,
    output: () => stdout,
    errors: () => stderr
  };
}

async function killHolding(held, liveChildren) {
  const closed = once(held.child, 'close');
  held.child.kill('SIGKILL');
  await closed;
  liveChildren.delete(held.child);
  held.lines.close();
  assert.equal(held.errors(), '', 'Killed task worker wrote unexpected stderr.');
  parseSingleLine(held.output(), 'killed task worker');
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
function seedV1(databasePath) {
  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  store.health();
  store.recordSpend({ amountCents: 75, dailyLimitCents: 1000, purpose: 'migration contention', provider: 'fixture', reference: 'v1-row' });
  store.transaction(db => db.exec(`DROP TABLE scoped_approval_events;
    DROP TABLE scoped_approval_grants;
    DROP TABLE scoped_approval_actions;
    DROP TABLE scoped_approval_provenance;
    DROP TABLE policy_dispatch_consumptions;
    DROP TABLE policy_dispatch_authorizations;
    DROP TABLE scheduler_runs;
    DROP TABLE scheduler_attempts;
    DROP TABLE scheduler_outbox;
    DROP TABLE scheduler_registrations;
    DROP TABLE scheduler_jobs;
    DROP TABLE scheduler_legacy_import;
    DROP TABLE scheduler_installation;
    DROP TABLE capability_profile_revocations;
    DROP TABLE capability_profile_requests;
    DROP TABLE capability_profile_bindings;
    DROP TABLE capability_profile_versions;
    DROP TABLE coordinator_workflow_acceptances;
    DROP TABLE coordinator_workflow_outbox;
    DROP TABLE coordinator_workflow_events;
    DROP TABLE coordinator_broker_verifications;
    DROP TABLE coordinator_workflow_missions;
    DROP TABLE coordinator_phase_states;
    DROP TABLE coordinator_missions;
    DROP TABLE tavily_usage_monthly;
    DROP TABLE model_usage_daily;
    DROP TABLE remote_asks;
    DROP TABLE approval_grants;
    DROP TABLE memory_entries;
    DROP TABLE task_checkpoints;
    DROP TABLE task_attempts;
    DROP TABLE research_findings;
    DROP TABLE research_results;
    DROP TABLE research_runs;
    DROP TABLE research_experiments;
    DROP TABLE research_project_sessions;
    DROP TABLE research_projects;
    DROP TABLE tasks;
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
      PRAGMA user_version = 1;`));
  store.close();
}

async function concurrentMigration(databasePath) {
  seedV1(databasePath);
  const startAt = Date.now() + 1000;
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) =>
    runWorker('open', databasePath, { ownerId: `migration-${index}` }, startAt)));
  assert.ok(results.every(result => result.ok === true && result.schemaVersion === SCHEMA_VERSION && result.integrity === true), JSON.stringify(results));
  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  try {
    assert.equal(store.listSpend().length, 1);
    assert.equal(store.listSpend()[0].reference, 'v1-row');
    assert.equal(store.health().schemaVersion, SCHEMA_VERSION);
    assert.equal(store.checkIntegrity({ full: true }).ok, true);
  } finally { store.close(); }
}

async function uniqueClaims(databasePath) {
  // These assertions concern overlapping claims, not expiry. Twenty real
  // SQLite workers can take longer than one lease on a busy machine. Share
  // the store's test clock so a legitimate expiry cannot create a new claim
  // halfway through this experiment. Kill/recovery cases below use real time.
  const clockNow = Date.now();
  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000, clock: () => clockNow });
  try {
    for (let index = 0; index < 12; index += 1) {
      store.submitTask(taskInput(`claim-unique-${String(index).padStart(4, '0')}`));
    }
  } finally { store.close(); }

  const startAt = Date.now() + 1000;
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => runWorker('claim', databasePath, {
    clockNow,
    claim: { queue: 'concurrency.queue', workerLabel: `claimer-${index}`, leaseMs: 5000 }
  }, startAt)));
  assert.ok(results.every(result => result.ok === true), JSON.stringify(results));
  const claimed = results.filter(result => result.claimed === true);
  const empty = results.filter(result => result.claimed === false);
  assert.equal(claimed.length, 12);
  assert.equal(empty.length, 8);
  assert.equal(new Set(claimed.map(result => result.taskId)).size, 12, 'Every task may have only one active claim.');
  assert.ok(claimed.every(result => result.fence === 1));

  const reopened = createStateStore({ file: databasePath, busyTimeoutMs: 30_000, clock: () => clockNow });
  try {
    assert.equal(reopened.listTasks({ queue: 'concurrency.queue', status: 'leased', limit: 100 }).length, 12);
    assert.equal(reopened.checkIntegrity({ full: true }).ok, true);
  } finally { reopened.close(); }
}

async function checkpointCas(databasePath) {
  const clockNow = Date.now();
  const store = createStateStore({ file: databasePath, busyTimeoutMs: 30_000, clock: () => clockNow });
  let handle;
  let id;
  try {
    id = taskId(store.submitTask(taskInput('checkpoint-cas-0001')));
    const claimed = store.claimTask({ queue: 'concurrency.queue', workerLabel: 'checkpoint-owner', leaseMs: 5000 });
    handle = claimed.handle;
    store.startTask(handle, { leaseMs: 5000 });
  } finally { store.close(); }

  const startAt = Date.now() + 1000;
  const results = await Promise.all([
    runWorker('checkpoint', databasePath, {
      clockNow,
      handle,
      checkpoint: { checkpointKey: 'cas-left-0001', expectedRevision: 0, checkpoint: { summary: 'left' }, leaseMs: 5000 }
    }, startAt),
    runWorker('checkpoint', databasePath, {
      clockNow,
      handle,
      checkpoint: { checkpointKey: 'cas-right-0001', expectedRevision: 0, checkpoint: { summary: 'right' }, leaseMs: 5000 }
    }, startAt)
  ]);
  assert.equal(results.filter(result => result.ok === true).length, 1, JSON.stringify(results));
  const rejected = results.find(result => result.ok === false);
  assert.equal(rejected && rejected.code, 'TASK_CHECKPOINT_REVISION_CONFLICT');

  const reopened = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  try {
    const task = reopened.getTask({ taskId: id, includeCheckpoint: true });
    assert.equal(task.latestCheckpoint.revision, 1);
    assert.ok(['left', 'right'].includes(task.latestCheckpoint.checkpoint.summary));
    assert.equal(reopened.checkIntegrity({ full: true }).ok, true);
  } finally { reopened.close(); }
}

async function killedBeforeStart(databasePath, liveChildren) {
  const seed = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  const id = taskId(seed.submitTask(taskInput('killed-before-start-0001')));
  seed.close();
  const held = await spawnHolding('hold-leased', databasePath, {
    claim: { queue: 'concurrency.queue', workerLabel: 'killed-leased', leaseMs: 1000 }
  }, liveChildren);
  assert.equal(held.ready.taskId, id);
  await killHolding(held, liveChildren);
  await delay(1250);

  const replacementStore = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  try {
    replacementStore.reapExpiredTasks();
    const replacement = replacementStore.claimTask({ queue: 'concurrency.queue', workerLabel: 'replacement', leaseMs: 1000 });
    assert.equal(taskId(replacement), id);
    assert.equal(replacement.task.attempt, 0, 'A killed pre-start claim must not consume an execution attempt.');
    assert.equal(replacement.handle.attempt, held.ready.attempt);
    assert.ok(replacement.handle.fence > held.ready.fence);
    replacementStore.startTask(replacement.handle, { leaseMs: 1000 });
    assert.equal(replacementStore.getTask({ taskId: id }).attempt, 1);
    assert.equal(replacementStore.checkIntegrity({ full: true }).ok, true);
  } finally { replacementStore.close(); }
}

async function killedAfterStart(databasePath, policy, liveChildren) {
  const seed = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  const id = taskId(seed.submitTask(taskInput(`killed-running-${policy}-0001`, {
    expiryPolicy: policy,
    maxAttempts: 2,
    retryBackoffMs: 0,
    maxRetryBackoffMs: 0
  })));
  seed.close();
  const held = await spawnHolding('hold-running', databasePath, {
    claim: { queue: 'concurrency.queue', workerLabel: `killed-${policy}`, leaseMs: 1000 },
    start: { leaseMs: 1000 }
  }, liveChildren);
  assert.equal(held.ready.taskId, id);
  await killHolding(held, liveChildren);
  await delay(1250);

  const recovered = createStateStore({ file: databasePath, busyTimeoutMs: 30_000 });
  try {
    recovered.reapExpiredTasks();
    const task = recovered.getTask({ taskId: id });
    if (policy === 'uncertain') {
      assert.equal(task.status, 'uncertain');
      assert.equal(recovered.claimTask({ queue: 'concurrency.queue', workerLabel: 'unsafe-retry', leaseMs: 1000 }), null);
    } else {
      assert.ok(['queued', 'retry_wait'].includes(task.status), JSON.stringify(task));
      const replacement = recovered.claimTask({ queue: 'concurrency.queue', workerLabel: 'safe-retry', leaseMs: 1000 });
      assert.equal(taskId(replacement), id);
      assert.equal(replacement.handle.attempt, 2);
    }
    assert.equal(recovered.checkIntegrity({ full: true }).ok, true);
  } finally { recovered.close(); }
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-task-concurrency-'));
  const liveChildren = new Set();
  try {
    await concurrentMigration(path.join(temporary, 'migration.sqlite'));
    await uniqueClaims(path.join(temporary, 'claims.sqlite'));
    await checkpointCas(path.join(temporary, 'checkpoint.sqlite'));
    await killedBeforeStart(path.join(temporary, 'killed-leased.sqlite'), liveChildren);
    await killedAfterStart(path.join(temporary, 'killed-uncertain.sqlite'), 'uncertain', liveChildren);
    await killedAfterStart(path.join(temporary, 'killed-retry.sqlite'), 'retry', liveChildren);
    process.stdout.write('task cross-process tests passed\n');
  } finally {
    for (const child of liveChildren) {
      try { child.kill('SIGKILL'); } catch { /* already stopped */ }
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
