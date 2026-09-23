// EXECUTABLE CHANGE
//
// TEST-CAN-FAIL REPORT (testcanfail-tests-kernel-state-task-state-js)
//
// SHAPE 1 -- STRENGTHENED:
// - assertTaskQueueSchema now proves that both nested collections are nonempty.
//   Mutation: removed tasks.id from REQUIRED_SCHEMA_V2. RED:
//   "AssertionError [ERR_ASSERTION]: schema 23 no longer requires tasks.id, which this suite depends on"
// - The stale-handle mutation census now pins its five expected operations before
//   iterating. Mutation: changed both handle-validation TASK_FENCE_LOST codes.
//   RED: "+ 'MUTATED_FENCE_CHECK'" / "- 'TASK_FENCE_LOST'".
// - The credential-shape census now pins all nine cases before forEach.
//   Mutation: removed the tvly credential alternative from secret-patterns.
//   RED: "AssertionError [ERR_ASSERTION]: Missing expected exception."
//
// SHAPE 2 -- NOT-FOUND: no exit-status or truthy-process-result assertion exists.
// SHAPE 3 -- NOT-FOUND: the outer catch rethrows after cleanup; the cleanup catch
// preserves the original failure, and no optional chain swallows a subject failure.
// SHAPE 4 -- NOT-FOUND: no mock replaces the state store under test.
// SHAPE 5 -- NOT-FOUND: there is no skip or platform precondition guard.
// SHAPE 6 -- NOT-FOUND: no expected value is computed by the product path it checks.
//
// RESTORATION: mutated product files were restored byte-for-byte (state-store.js
// SHA-256 b615db5aafd92de72b350cbff129ff3a28076cf7a325a220fbce740caf364064;
// secret-patterns.js SHA-256 719fe4a03418bb673639ac4028a57ba05ef51a749eac6020513cee95387d40ef).
// The restored run was GREEN: "task state tests passed".
// PRECONDITION: PATH's Node 20 lacks node:sqlite; Node 22.22.2 was available and
// was used for every executable mutation and restoration run.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  APPLICATION_ID,
  REQUIRED_SCHEMA,
  SCHEMA_VERSION,
  StateStoreError,
  createStateStore,
  hashInput
} = require('../../src/lib/state-store');

// Kept as a named function taking the schema as an argument, not an inline
// block reading the import directly, so its teeth are demonstrable: hand it a
// schema with a task table or column removed and it must go red.
function assertTaskQueueSchema(schema, expected) {
  assert.equal(typeof schema, 'object', 'state-store must expose the schema this build requires');
  assert.notEqual(schema, null, 'state-store must expose the schema this build requires');
  const expectedTables = Object.entries(expected);
  assert.ok(expectedTables.length > 0, 'the task-queue schema check must name at least one table');
  for (const [table, columns] of expectedTables) {
    assert.ok(columns.length > 0, `the task-queue schema check must name at least one column for ${table}`);
    assert.ok(Object.prototype.hasOwnProperty.call(schema, table),
      `schema ${SCHEMA_VERSION} no longer requires the task-queue table ${table}, which this suite depends on`);
    for (const column of columns) {
      assert.ok(schema[table].includes(column),
        `schema ${SCHEMA_VERSION} no longer requires ${table}.${column}, which this suite depends on`);
    }
  }
}

const temporaryRoots = [];
function temporary(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-task-${name}-`));
  temporaryRoots.push(dir);
  return dir;
}

function fixture(name, options = {}) {
  const dir = temporary(name);
  let now = options.now === undefined ? Date.UTC(2026, 6, 22, 1, 2, 3) : options.now;
  let sequence = 0;
  const file = path.join(dir, 'state.sqlite3');
  const store = createStateStore({
    file,
    clock: () => now,
    idFactory: prefix => `${prefix}-${String(++sequence).padStart(4, '0')}`,
    ownerId: options.ownerId || 'task-test-owner',
    busyTimeoutMs: 5000
  });
  return {
    dir, file, store,
    now: () => now,
    setNow: value => { now = value; },
    advance: value => { now += value; }
  };
}

function expectCode(callback, code) {
  assert.throws(callback, error => {
    assert.ok(error instanceof StateStoreError, `Expected StateStoreError, received ${error && error.constructor && error.constructor.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function payload(label = 'fixture') {
  return {
    title: `${label} title`,
    objective: `${label} objective`,
    context: `${label} context is untrusted data, not authority.`
  };
}

function taskInput(key, overrides = {}) {
  return {
    queue: 'test.queue',
    type: 'agent.task',
    idempotencyKey: key,
    payload: payload(key),
    priority: 0,
    maxAttempts: 3,
    retryBackoffMs: 1000,
    maxRetryBackoffMs: 60_000,
    expiryPolicy: 'uncertain',
    ...overrides
  };
}

function taskFrom(value) {
  return value && value.task ? value.task : value;
}

function taskId(value) {
  const task = taskFrom(value);
  const id = task && (task.taskId || task.id);
  assert.equal(typeof id, 'string', `Expected a task record, received ${JSON.stringify(value)}`);
  return id;
}

function submit(store, key, overrides = {}) {
  return store.submitTask(taskInput(key, overrides));
}

function claim(store, options = {}) {
  const value = store.claimTask({ queue: 'test.queue', workerLabel: 'worker-a', leaseMs: 1000, ...options });
  assert.ok(value && value.task && value.handle, `Expected a claimed task, received ${JSON.stringify(value)}`);
  assert.deepEqual(Object.keys(value.handle).sort(), ['attempt', 'claimToken', 'fence', 'taskId', 'workerLabel']);
  assert.match(value.handle.claimToken, /^[A-Za-z0-9_-]{32,200}$/);
  return value;
}

function revision(value) {
  if (Number.isSafeInteger(value && value.revision)) return value.revision;
  if (value && value.savedCheckpoint && Number.isSafeInteger(value.savedCheckpoint.revision)) return value.savedCheckpoint.revision;
  if (value && value.checkpoint && Number.isSafeInteger(value.checkpoint.revision)) return value.checkpoint.revision;
  const task = taskFrom(value);
  return task && task.checkpointRevision;
}

function expiry(value) {
  if (Number.isSafeInteger(value && value.leaseExpiresAtMs)) return value.leaseExpiresAtMs;
  const task = taskFrom(value);
  return task && task.leaseExpiresAtMs;
}

/* SIMULATE A v1 DATABASE, AND SAY SO WHEN THE SIMULATION GOES STALE.
 *
 * This drop list has to name every table a later schema version introduced,
 * because what survives it is what a v1 database is claimed to have held. It
 * rots silently: schema V21 added six research_* tables, nobody added them
 * here, and the only symptom was "The durable state DDL fingerprint does not
 * match this schema version" thrown from health() -- a message that names
 * neither the fixture nor the missing tables, in a test whose subject is
 * migration. It sat red in the census until someone read the stack.
 *
 * So the fixture now checks itself: after the drop, anything left that a v1
 * database could not have held is named, with the instruction to decide. A
 * fixture that cannot rot quietly is worth more than one that is briefly
 * correct. */
const V1_SURVIVING_TABLES = Object.freeze([
  'legacy_imports', 'operations', 'spend_entries', 'telegram_cursor',
  'telegram_poll_lease', 'telegram_updates'
]);

function assertV1Shape(db) {
  const present = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map(row => row.name).sort();
  const unexpected = present.filter(name => !V1_SURVIVING_TABLES.includes(name));
  assert.deepEqual(unexpected, [],
    `the v1 fixture left ${unexpected.join(', ')} behind: a later schema version added ${unexpected.length === 1 ? 'that table' : 'those tables'}, `
    + 'so either drop it above (if v1 never had it) or add it to V1_SURVIVING_TABLES (if it did). '
    + 'Left alone it surfaces as an unexplained DDL fingerprint mismatch.');
}

// THE v1 FIXTURE PUTS THE THREE telegram_* TABLES BACK BEFORE STAMPING v1.
//
// A real v1 database had them: MIGRATION_V1 created them and MIGRATION_V23
// (2026-08-23, the Telegram connector removal) dropped them. This fixture stamps
// v1 onto a CURRENT database, which has already been migrated past 23, so without
// this it would describe a v1 database that never existed and _validateSchema
// would be right to refuse it on reopen.
//
// The CREATE text is byte-identical to SCHEMA_V1's, including the two singleton
// INSERTs the cursor and poll-lease invariants check. It does not need to be
// trusted: a character of drift changes the DDL fingerprint and the reopen fails
// loudly. The three DROP IF EXISTS lines make it idempotent, because this runs on
// more than one fixture and a store not yet migrated past 23 still has the tables;
// only the DROPs are conditional, the CREATE text stays exact.
function dropTaskSchema(store) {
  store.transaction(db => {
    db.exec(`DROP TABLE scoped_approval_events;
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
      DROP TABLE tavily_usage_monthly;
      DROP TABLE model_usage_daily;
      DROP TABLE remote_asks;
      DROP TABLE approval_grants;
      DROP TABLE memory_entries;
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
      DROP TABLE research_findings;
      DROP TABLE research_results;
      DROP TABLE research_runs;
      DROP TABLE research_experiments;
      DROP TABLE research_project_sessions;
      DROP TABLE research_projects;
      DROP TABLE task_checkpoints;
      DROP TABLE task_attempts;
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
      PRAGMA user_version = 1;`);
    assertV1Shape(db);
  });
}

function rawDatabase(file) {
  // state-store has already loaded node:sqlite through its narrow warning guard.
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { allowExtension: false, enableForeignKeyConstraints: true });
}

(async () => {
let failure;
try {
  // The task queue remains available through additive schema growth.
  //
  // This used to read `assert.equal(SCHEMA_VERSION, 18, ...)`. The message
  // promised a behaviour; the assertion pinned a constant, so the two came
  // apart the moment V19 landed -- and V19 is verifiably additive (it spreads
  // V18 and adds three discord_* tables, touching nothing this suite uses).
  // A green-to-red flip with no behavioural change is a false alarm, and the
  // reflex fix -- bumping 18 to 19 -- would just reload the same trap for V20.
  // So assert the promise directly: every task-queue table and column this
  // file depends on must exist in the schema the build actually requires.
  // Additive growth passes; dropping or renaming any of this fails.
  const TASK_QUEUE_SCHEMA = Object.freeze({
    tasks: ['id', 'queue_name', 'task_type', 'idempotency_key', 'input_hash', 'body_json', 'status', 'priority',
      'available_at_ms', 'max_attempts', 'attempt', 'retry_backoff_ms', 'max_retry_backoff_ms', 'expiry_policy',
      'fence', 'lease_worker_label', 'lease_token_hash', 'lease_expires_at_ms', 'checkpoint_revision',
      'checkpoint_key', 'checkpoint_json', 'checkpoint_hash', 'result_json', 'result_hash', 'error_code',
      'error_message', 'cancel_requested_at_ms', 'cancel_reason', 'created_at_ms', 'updated_at_ms',
      'completed_at_ms'],
    task_attempts: ['task_id', 'fence', 'execution_attempt', 'worker_label', 'token_hash', 'status',
      'lease_expires_at_ms', 'claimed_at_ms', 'started_at_ms', 'updated_at_ms', 'ended_at_ms', 'outcome_hash',
      'error_code', 'error_message'],
    task_checkpoints: ['task_id', 'revision', 'fence', 'execution_attempt', 'checkpoint_key', 'previous_hash',
      'checkpoint_json', 'checkpoint_hash', 'created_at_ms']
  });
  assertTaskQueueSchema(REQUIRED_SCHEMA, TASK_QUEUE_SCHEMA);

  // A populated, genuine v1 layout upgrades transactionally without changing
  // any pre-task domain data. The fixture is derived from v2 by dropping only
  // the additive task tables, so it cannot silently drift from the shipped v1.
  {
    const test = fixture('migration');
    test.store.health();
    test.store.recordSpend({ amountCents: 123, dailyLimitCents: 1000, purpose: 'migration', provider: 'fixture', reference: 'migration-spend' });
    // THE PRESERVED-DATA SUBJECT CHANGED 2026-08-23. This seeded a Telegram update
    // and then proved the migration carried it across. MIGRATION_V23 DESTROYS that
    // data by design, so it is the one thing that must not be used to prove
    // preservation. The spend row and the completed operation below are seeded for
    // the same purpose and do survive, so the claim under test is unchanged.
    const digest = hashInput({ migration: true });
    let operation = test.store.reserveOperation({ type: 'migration.operation', key: 'migration-operation', inputHash: digest, leaseMs: 5000 });
    operation = test.store.markOperationExecuting(operation.handle, { leaseMs: 5000 });
    test.store.succeedOperation(operation.handle, { result: { providerId: 'preserved-provider-id' } });
    test.store.transaction(db => db.prepare(`INSERT INTO legacy_imports(source,source_path,digest,imported_at_ms,records,details_json)
      VALUES('spend','migration-fixture','${'a'.repeat(64)}',1,0,'{}')`).run());
    dropTaskSchema(test.store);
    test.store.close();

    const migrated = createStateStore({ file: test.file, busyTimeoutMs: 5000 });
    const health = migrated.health();
    assert.equal(health.schemaVersion, SCHEMA_VERSION);
    assert.equal(health.applicationId, APPLICATION_ID);
    assert.equal(health.integrity.ok, true);
    assert.equal(migrated.listSpend()[0].reference, 'migration-spend');
    assert.equal(migrated.getOperation({ type: 'migration.operation', key: 'migration-operation' }).result.providerId, 'preserved-provider-id');
    const tables = migrated.transaction(db => ['tasks', 'task_attempts', 'task_checkpoints'].map(name => {
      const row = db.prepare('PRAGMA table_list').all().find(entry => entry.name === name);
      return { name, strict: row && row.strict };
    }));
    assert.deepEqual(tables, [
      { name: 'tasks', strict: 1 },
      { name: 'task_attempts', strict: 1 },
      { name: 'task_checkpoints', strict: 1 }
    ]);
    const created = submit(migrated, 'migration-task-0001');
    assert.equal(migrated.getTask({ taskId: taskId(created) }).status, 'queued');
    const counts = migrated.transaction(db => ({
      spend: db.prepare('SELECT COUNT(*) AS count FROM spend_entries').get().count,
      operations: db.prepare('SELECT COUNT(*) AS count FROM operations').get().count,
      tasks: db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count
    }));
    migrated.close();

    const reopened = createStateStore({ file: test.file, busyTimeoutMs: 5000 });
    assert.equal(reopened.health().schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(reopened.transaction(db => ({
      spend: db.prepare('SELECT COUNT(*) AS count FROM spend_entries').get().count,
      operations: db.prepare('SELECT COUNT(*) AS count FROM operations').get().count,
      tasks: db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count
    })), counts, 'Reopening a migrated store must not replay migration work.');
    assert.equal(reopened.checkIntegrity({ full: true }).ok, true);
    reopened.close();
  }

  // Invalid v1 DDL fails closed and rolls back any additive migration work.
  {
    const test = fixture('migration-tamper');
    test.store.health();
    dropTaskSchema(test.store);
    test.store.close();
    const raw = rawDatabase(test.file);
    raw.exec('ALTER TABLE spend_entries ADD COLUMN migration_tamper TEXT;');
    raw.close();

    const rejected = createStateStore({ file: test.file, busyTimeoutMs: 5000 });
    expectCode(() => rejected.health(), 'STATE_SCHEMA_INVALID');
    rejected.close();

    const after = rawDatabase(test.file);
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 1);
    const names = new Set(after.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
    assert.equal(names.has('tasks'), false);
    assert.equal(names.has('task_attempts'), false);
    assert.equal(names.has('task_checkpoints'), false);
    after.close();
  }

  // Submission is durable and replay-safe; the key cannot be rebound.
  {
    const test = fixture('submit');
    const first = submit(test.store, 'submit-replay-0001');
    const replay = submit(test.store, 'submit-replay-0001');
    assert.equal(taskId(replay), taskId(first));
    assert.equal(test.store.listTasks({ queue: 'test.queue' }).length, 1);
    expectCode(() => submit(test.store, 'submit-replay-0001', { payload: payload('different') }), 'TASK_IDEMPOTENCY_CONFLICT');
    assert.equal(test.store.listTasks({ queue: 'test.queue' }).length, 1);
    test.store.close();
  }

  // Claim is pre-execution. Start consumes the attempt, checkpoints use CAS,
  // heartbeats never shorten a lease, and terminal replay is deterministic.
  {
    const test = fixture('lifecycle');
    const submitted = submit(test.store, 'lifecycle-task-0001');
    const id = taskId(submitted);
    const leased = claim(test.store);
    assert.equal(taskId(leased), id);
    assert.equal(leased.task.status, 'leased');
    assert.equal(test.store.claimTask({ queue: 'test.queue', workerLabel: 'worker-b', leaseMs: 1000 }), null);

    const started = test.store.startTask(leased.handle, { leaseMs: 5000 });
    assert.equal(taskFrom(started).status, 'running');
    assert.equal(taskFrom(started).attempt, 1);
    test.advance(100);
    const longHeartbeat = test.store.heartbeatTask(leased.handle, { leaseMs: 5000 });
    const longExpiry = expiry(longHeartbeat);
    const shortHeartbeat = test.store.heartbeatTask(leased.handle, { leaseMs: 1000 });
    assert.equal(expiry(shortHeartbeat), longExpiry, 'A heartbeat must never shorten an existing lease.');

    const checkpoint = { summary: 'downloaded metadata', cursor: { page: 2 } };
    const saved = test.store.checkpointTask(leased.handle, {
      checkpointKey: 'metadata-page-2', expectedRevision: 0, checkpoint, leaseMs: 5000
    });
    assert.equal(revision(saved), 1);
    const checkpointReplay = test.store.checkpointTask(leased.handle, {
      checkpointKey: 'metadata-page-2', expectedRevision: 0, checkpoint, leaseMs: 5000
    });
    assert.equal(revision(checkpointReplay), 1);
    assert.equal(checkpointReplay.replayed, true);
    expectCode(() => test.store.checkpointTask(leased.handle, {
      checkpointKey: 'metadata-page-2', expectedRevision: 0, checkpoint: { summary: 'different' }
    }), 'TASK_CHECKPOINT_CONFLICT');
    expectCode(() => test.store.checkpointTask(leased.handle, {
      checkpointKey: 'new-key-with-stale-revision', expectedRevision: 0, checkpoint: { summary: 'stale' }
    }), 'TASK_CHECKPOINT_REVISION_CONFLICT');
    const second = test.store.checkpointTask(leased.handle, {
      checkpointKey: 'metadata-page-3', expectedRevision: 1, checkpoint: { summary: 'page three' }
    });
    assert.equal(revision(second), 2);
    const checkpointLinks = test.store.transaction(db => db.prepare(
      'SELECT revision, previous_hash, checkpoint_hash FROM task_checkpoints WHERE task_id = ? ORDER BY revision'
    ).all(id));
    assert.equal(checkpointLinks.length, 2);
    assert.equal(checkpointLinks[0].previous_hash, null);
    assert.equal(checkpointLinks[1].previous_hash, checkpointLinks[0].checkpoint_hash,
      'Checkpoint history must form an append-only hash chain.');

    const result = { summary: 'finished safely', artifacts: ['artifact-1'] };
    const completed = test.store.completeTask(leased.handle, { result });
    assert.equal(taskFrom(completed).status, 'succeeded');
    assert.deepEqual(test.store.getTask({ taskId: id, includePayload: true, includeCheckpoint: true }).result, result);
    const completionReplay = test.store.completeTask(leased.handle, { result });
    assert.equal(taskFrom(completionReplay).status, 'succeeded');
    assert.equal(completionReplay.replayed, true);
    expectCode(() => test.store.completeTask(leased.handle, { result: { summary: 'different outcome' } }), 'TASK_OUTCOME_CONFLICT');
    test.store.close();
  }

  // An expired leased claim is safely reclaimed without consuming an attempt.
  // Its old fence cannot mutate the replacement claim.
  {
    const test = fixture('fence');
    const id = taskId(submit(test.store, 'stale-fence-task-0001'));
    const stale = claim(test.store, { workerLabel: 'worker-old' });
    assert.equal(stale.task.attempt, 0);
    test.advance(1001);
    test.store.reapExpiredTasks();
    const replacement = claim(test.store, { workerLabel: 'worker-new' });
    assert.equal(taskId(replacement), id);
    assert.equal(replacement.task.attempt, 0);
    assert.equal(replacement.handle.attempt, stale.handle.attempt);
    assert.ok(replacement.handle.fence > stale.handle.fence);
    const staleHandleMutations = [
      () => test.store.startTask(stale.handle, { leaseMs: 1000 }),
      () => test.store.heartbeatTask(stale.handle, { leaseMs: 1000 }),
      () => test.store.checkpointTask(stale.handle, { checkpointKey: 'stale-key-0001', expectedRevision: 0, checkpoint: { summary: 'stale' } }),
      () => test.store.completeTask(stale.handle, { result: { summary: 'stale' } }),
      () => test.store.failTask(stale.handle, { disposition: 'failed', code: 'STALE' })
    ];
    assert.equal(staleHandleMutations.length, 5, 'every stale-handle mutation must exercise the fence check');
    for (const mutation of staleHandleMutations) expectCode(mutation, 'TASK_FENCE_LOST');
    const running = test.store.startTask(replacement.handle, { leaseMs: 1000 });
    assert.equal(taskFrom(running).attempt, 1);
    test.store.completeTask(replacement.handle, { result: { summary: 'replacement won' } });
    test.store.close();
  }

  // Read-time lease-expiry reporting: getTask/listTasks must not echo a stale
  // 'leased'/'running' status once the lease has visibly expired, even before
  // any claimant on the queue triggers the lazy reaper. This is a correctness
  // contract on the read path, independent of when (or whether) reaping runs.
  {
    const test = fixture('lease-reporting');
    // Two different queues so that claiming the second (running) task cannot
    // itself trigger claimTask's lazy reap of the first (leased) task's queue
    // -- this test is specifically about a queue nobody claims from again.
    const leasedId = taskId(submit(test.store, 'lease-report-leased-0001'));
    const leased = claim(test.store, { workerLabel: 'lease-report-worker' });
    assert.equal(taskId(leased), leasedId);

    // Not yet expired: the raw status is reported unchanged.
    const fresh = test.store.getTask({ taskId: leasedId });
    assert.equal(fresh.status, 'leased');
    assert.equal(fresh.storedStatus, 'leased');
    assert.equal(fresh.leaseExpired, false);

    test.advance(1001);

    // The lease has expired but nothing has claimed this queue since, so the
    // stored column is still 'leased'. The report must not say so.
    const staleGet = test.store.getTask({ taskId: leasedId });
    assert.equal(staleGet.status, 'expired', 'An expired, never-started claim must not be reported as leased.');
    assert.equal(staleGet.storedStatus, 'leased', 'The stored column is untouched until something reaps it.');
    assert.equal(staleGet.leaseExpired, true);

    const staleList = test.store.listTasks({ queue: 'test.queue' });
    const staleListed = staleList.find(entry => entry.id === leasedId);
    assert.ok(staleListed, 'listTasks must still surface the expired task.');
    assert.equal(staleListed.status, 'expired');

    const runningId = taskId(submit(test.store, 'lease-report-running-0001', { queue: 'test.queue.running' }));
    const runningClaim = claim(test.store, { queue: 'test.queue.running', workerLabel: 'lease-report-worker-2' });
    assert.equal(taskId(runningClaim), runningId);
    test.store.startTask(runningClaim.handle, { leaseMs: 1000 });
    test.advance(1001);
    const staleRunning = test.store.getTask({ taskId: runningId });
    assert.equal(staleRunning.status, 'uncertain', 'An expired running lease must be reported uncertain, not running.');
    assert.equal(staleRunning.storedStatus, 'running');
    assert.equal(staleRunning.leaseExpired, true);

    // The stored column really is untouched -- reporting derived it without
    // mutating anything.
    const rawStatus = test.store.transaction(db => db.prepare('SELECT status FROM tasks WHERE id = ?').get(leasedId).status);
    assert.equal(rawStatus, 'leased');

    // Once something actually reaps the queues, the derived and stored status
    // converge and the flag clears -- reporting never fights the reaper.
    test.store.reapExpiredTasks();
    const reapedLeased = test.store.getTask({ taskId: leasedId });
    assert.equal(reapedLeased.status, 'retry_wait');
    assert.equal(reapedLeased.storedStatus, 'retry_wait');
    assert.equal(reapedLeased.leaseExpired, false);
    const reapedRunning = test.store.getTask({ taskId: runningId });
    assert.equal(reapedRunning.status, 'uncertain');
    assert.equal(reapedRunning.storedStatus, 'uncertain');
    assert.equal(reapedRunning.leaseExpired, false);
    test.store.close();
  }

  // Explicit retry timing is exact. Expired running work follows its declared
  // policy, while a manual/uncertain task is never blindly reclaimed.
  {
    const test = fixture('retry');
    const retryId = taskId(submit(test.store, 'retry-policy-task-0001', { expiryPolicy: 'retry', maxAttempts: 2 }));
    let retryClaim = claim(test.store, { workerLabel: 'retry-one' });
    test.store.startTask(retryClaim.handle, { leaseMs: 1000 });
    const retryAtMs = test.now() + 5000;
    test.store.failTask(retryClaim.handle, { disposition: 'retry', code: 'TEMPORARY', message: 'try later', retryDelayMs: 5000 });
    assert.equal(test.store.getTask({ taskId: retryId }).status, 'retry_wait');
    test.setNow(retryAtMs - 1);
    assert.equal(test.store.claimTask({ queue: 'test.queue', workerLabel: 'too-early', leaseMs: 1000 }), null);
    test.setNow(retryAtMs);
    retryClaim = claim(test.store, { workerLabel: 'retry-two' });
    const secondAttempt = test.store.startTask(retryClaim.handle, { leaseMs: 1000 });
    assert.equal(taskFrom(secondAttempt).attempt, 2);
    test.advance(1001);
    test.store.reapExpiredTasks();
    assert.equal(test.store.getTask({ taskId: retryId }).status, 'uncertain', 'An exhausted running task must not be silently dropped or retried.');

    const manualId = taskId(submit(test.store, 'manual-policy-task-0001', { expiryPolicy: 'uncertain' }));
    const manual = claim(test.store, { workerLabel: 'manual-worker' });
    assert.equal(taskId(manual), manualId);
    test.store.startTask(manual.handle, { leaseMs: 1000 });
    test.advance(1001);
    test.store.reapExpiredTasks();
    assert.equal(test.store.getTask({ taskId: manualId }).status, 'uncertain');
    assert.equal(test.store.claimTask({ queue: 'test.queue', workerLabel: 'must-not-retry', leaseMs: 1000 }), null);
    test.store.close();
  }

  // Retry requires an explicit retry-safe declaration. An uncertain task is
  // never claimable, but the original capability may still report a late,
  // definitive success or failure without granting authority to another worker.
  {
    const test = fixture('late-outcomes');
    const forbiddenId = taskId(submit(test.store, 'retry-forbidden-task-0001', { expiryPolicy: 'uncertain' }));
    const forbidden = claim(test.store, { workerLabel: 'retry-forbidden' });
    test.store.startTask(forbidden.handle, { leaseMs: 1000 });
    expectCode(() => test.store.failTask(forbidden.handle, {
      disposition: 'retry', code: 'TEMPORARY', retryDelayMs: 0
    }), 'TASK_RETRY_FORBIDDEN');
    assert.equal(test.store.getTask({ taskId: forbiddenId }).status, 'running');
    test.store.completeTask(forbidden.handle, { result: { summary: 'finished after rejected retry' } });

    const successId = taskId(submit(test.store, 'late-success-task-0001', { expiryPolicy: 'uncertain' }));
    const success = claim(test.store, { workerLabel: 'late-success' });
    test.store.startTask(success.handle, { leaseMs: 1000 });
    test.advance(1001);
    test.store.reapExpiredTasks();
    assert.equal(test.store.getTask({ taskId: successId }).status, 'uncertain');
    const lateSuccess = test.store.completeTask(success.handle, { result: { summary: 'provider later confirmed success' } });
    assert.equal(taskFrom(lateSuccess).status, 'succeeded');
    assert.equal(test.store.completeTask(success.handle, { result: { summary: 'provider later confirmed success' } }).replayed, true);

    const failureId = taskId(submit(test.store, 'late-failure-task-0001', { expiryPolicy: 'uncertain' }));
    const failure = claim(test.store, { workerLabel: 'late-failure' });
    test.store.startTask(failure.handle, { leaseMs: 1000 });
    test.advance(1001);
    test.store.reapExpiredTasks();
    assert.equal(test.store.getTask({ taskId: failureId }).status, 'uncertain');
    const lateFailure = test.store.failTask(failure.handle, {
      disposition: 'failed', code: 'PROVIDER_CONFIRMED_FAILURE', message: 'No external effect committed.'
    });
    assert.equal(taskFrom(lateFailure).status, 'failed');
    assert.equal(test.store.failTask(failure.handle, {
      disposition: 'failed', code: 'PROVIDER_CONFIRMED_FAILURE', message: 'No external effect committed.'
    }).replayed, true);
    expectCode(() => test.store.failTask(failure.handle, {
      disposition: 'failed', code: 'DIFFERENT_OUTCOME'
    }), 'TASK_OUTCOME_CONFLICT');
    test.store.close();
  }

  // Cancellation is an idempotent local-principal operation. Active workers
  // observe the request and acknowledge it through their fenced fail handle.
  {
    const test = fixture('cancel');
    const queuedId = taskId(submit(test.store, 'cancel-queued-task-0001'));
    const queuedCancel = test.store.cancelTask({ taskId: queuedId, reason: 'no longer needed' });
    assert.equal(taskFrom(queuedCancel).status, 'cancelled');
    assert.equal(taskFrom(test.store.cancelTask({ taskId: queuedId, reason: 'repeat' })).status, 'cancelled');
    assert.equal(test.store.claimTask({ queue: 'test.queue', workerLabel: 'cancel-check', leaseMs: 1000 }), null);

    const runningId = taskId(submit(test.store, 'cancel-running-task-0001'));
    const running = claim(test.store, { workerLabel: 'cancel-worker' });
    assert.equal(taskId(running), runningId);
    test.store.startTask(running.handle, { leaseMs: 5000 });
    const requested = test.store.cancelTask({ taskId: runningId, reason: 'stop work' });
    assert.equal(taskFrom(requested).cancelRequested, true);
    const repeatedRequest = test.store.cancelTask({ taskId: runningId, reason: 'replacement reason must not overwrite' });
    assert.equal(taskFrom(repeatedRequest).cancellation.reason, 'stop work');
    assert.equal(test.store.heartbeatTask(running.handle, { leaseMs: 5000 }).cancelRequested, true);
    expectCode(() => test.store.checkpointTask(running.handle, {
      checkpointKey: 'after-cancel', expectedRevision: 0, checkpoint: { summary: 'must not persist' }
    }), 'TASK_CANCEL_REQUESTED');
    expectCode(() => test.store.completeTask(running.handle, { result: { summary: 'must not win after cancellation' } }), 'TASK_CANCEL_REQUESTED');
    const acknowledged = test.store.failTask(running.handle, { disposition: 'cancelled', code: 'CANCELLED', message: 'acknowledged' });
    assert.equal(taskFrom(acknowledged).status, 'cancelled');
    test.store.close();
  }

  // Either serial order of a cancellation and a safe retry acknowledgement
  // must leave a terminal cancellation. retry_wait + cancel_requested would
  // otherwise be neither claimable nor eligible for lease reaping.
  for (const [phase, order] of [['leased', 'cancel-first'], ['running', 'cancel-first'],
    ['leased', 'retry-first'], ['running', 'retry-first']]) {
    const test = fixture(`cancel-retry-${phase}-${order}`);
    const id = taskId(submit(test.store, `cancel-retry-${phase}-${order}-0001`, { expiryPolicy: 'retry' }));
    const ownership = claim(test.store);
    if (phase === 'running') test.store.startTask(ownership.handle, { leaseMs: 5000 });
    if (order === 'cancel-first') test.store.cancelTask({ taskId: id, reason: 'No further execution.' });
    const failure = { disposition: 'retry', code: 'TEMPORARY', message: 'No effects remain.', retryDelayMs: 0 };
    test.store.failTask(ownership.handle, failure);
    if (order === 'retry-first') test.store.cancelTask({ taskId: id, reason: 'No further execution.' });
    test.advance(60000);
    test.store.reapExpiredTasks({ queue: 'test.queue' });
    assert.equal(test.store.claimTask({ queue: 'test.queue', workerLabel: 'must-not-retry', leaseMs: 1000 }), null);
    assert.equal(test.store.getTask({ taskId: id }).status, 'cancelled', 'the cancellation cannot be stranded in an unclaimable retry queue');
    assert.equal(test.store.getTask({ taskId: id }).error, null);
    const replayed = test.store.failTask(ownership.handle, failure);
    assert.equal(replayed.replayed, true);
    assert.equal(taskFrom(replayed).status, 'cancelled');
    test.store.close();
  }

  // Persisted bodies, checkpoints, and results are bounded and reject obvious
  // credential/payment fields. Capability tokens exist only in the caller.
  {
    const test = fixture('bounds');
    const marker = `sk_live_${'A'.repeat(24)}${process.pid}`;
    expectCode(() => submit(test.store, 'sensitive-body-task-0001', {
      payload: { title: 'unsafe', objective: 'reject credentials', context: marker }
    }), 'TASK_SECRET_REJECTED');
    const currentVaultShapes = [
      `rk_live_${'b'.repeat(32)}`,
      `sk-ant-${'c'.repeat(32)}`,
      `GOCSPX-${'d'.repeat(32)}`,
      `ya29.${'e'.repeat(24)}`,
      `1//${'f'.repeat(32)}`,
      `dop_v1_${'a'.repeat(64)}`,
      `tvly-${'g'.repeat(32)}`,
      `pdl_${'h'.repeat(32)}`,
      `IGQ${'i'.repeat(32)}`
    ];
    assert.equal(currentVaultShapes.length, 9, 'every supported vault credential shape must exercise secret rejection');
    currentVaultShapes.forEach((credential, index) => {
      expectCode(() => submit(test.store, `sensitive-shape-task-${String(index).padStart(4, '0')}`, {
        payload: { title: 'unsafe shape', objective: 'reject credentials', context: credential }
      }), 'TASK_SECRET_REJECTED');
    });
    expectCode(() => submit(test.store, 'large-body-task-0001', {
      payload: { title: 'large', objective: 'large', context: 'x'.repeat(32001) }
    }), 'STATE_INVALID_ARGUMENT');

    const id = taskId(submit(test.store, 'bounded-values-task-0001'));
    const active = claim(test.store, { workerLabel: 'bounds-worker', leaseMs: 5000 });
    test.store.startTask(active.handle, { leaseMs: 5000 });
    expectCode(() => test.store.checkpointTask(active.handle, {
      checkpointKey: 'sensitive-checkpoint', expectedRevision: 0, checkpoint: { nested: { credential: marker } }
    }), 'TASK_SECRET_REJECTED');
    expectCode(() => test.store.checkpointTask(active.handle, {
      checkpointKey: 'large-checkpoint', expectedRevision: 0, checkpoint: { text: 'x'.repeat((256 * 1024) + 1) }
    }), 'TASK_CHECKPOINT_TOO_LARGE');
    let deep = {};
    for (let index = 0; index < 100; index += 1) deep = { child: deep };
    expectCode(() => test.store.checkpointTask(active.handle, {
      checkpointKey: 'deep-checkpoint', expectedRevision: 0, checkpoint: deep
    }), 'STATE_JSON_DEPTH');
    expectCode(() => test.store.completeTask(active.handle, { result: { nested: { credential: marker } } }), 'TASK_SECRET_REJECTED');
    expectCode(() => test.store.completeTask(active.handle, { result: { text: 'x'.repeat((1024 * 1024) + 1) } }), 'TASK_RESULT_TOO_LARGE');

    const publicTask = test.store.getTask({ taskId: id, includePayload: true, includeCheckpoint: true });
    const publicList = test.store.listTasks({ queue: 'test.queue' });
    assert.doesNotMatch(JSON.stringify(publicTask), new RegExp(active.handle.claimToken));
    assert.doesNotMatch(JSON.stringify(publicList), new RegExp(active.handle.claimToken));
    const persisted = test.store.transaction(db => JSON.stringify({
      tasks: db.prepare('SELECT * FROM tasks').all(),
      attempts: db.prepare('SELECT * FROM task_attempts').all(),
      checkpoints: db.prepare('SELECT * FROM task_checkpoints').all()
    }));
    assert.doesNotMatch(persisted, new RegExp(active.handle.claimToken), 'Raw claim tokens must never be persisted.');
    assert.doesNotMatch(persisted, new RegExp(marker), 'Rejected sensitive content must not be persisted.');
    assert.match(persisted, /[a-f0-9]{64}/, 'A one-way claim-token hash should be persisted.');
    assert.equal(test.store.getTask({ taskId: id }).latestCheckpoint, null, 'Rejected checkpoints must not create a public checkpoint.');
    assert.equal(test.store.transaction(db => db.prepare('SELECT checkpoint_revision FROM tasks WHERE id = ?').get(id).checkpoint_revision), 0,
      'Rejected checkpoints must not advance CAS revision.');
    test.store.close();
  }

  // The only public attempt reader is redacted, immutable, and keyed by the
  // canonical (task_id, fence) generation. It must not expose a worker label,
  // claim-token digest, outcome hash, or error fields.
  {
    const test = fixture('attempt-reader');
    const id = taskId(submit(test.store, 'attempt-reader-task-0001'));
    const active = claim(test.store, { leaseMs: 5000 });
    assert.equal(taskId(active), id);
    const metadata = test.store.getTaskAttemptMetadata({ taskId: id, fence: active.handle.fence });
    assert.deepEqual(Object.keys(metadata).sort(), [
      'claimedAtMs', 'endedAtMs', 'executionAttempt', 'fence', 'leaseExpiresAtMs',
      'startedAtMs', 'status', 'taskId', 'updatedAtMs'
    ].sort());
    assert.equal(metadata.taskId, id);
    assert.equal(metadata.fence, active.handle.fence);
    assert.equal(metadata.executionAttempt, 1);
    assert.equal(metadata.status, 'leased');
    assert.equal(metadata.startedAtMs, null);
    assert.equal(Object.isFrozen(metadata), true);
    assert.throws(() => { metadata.status = 'altered'; }, TypeError);
    assert.equal(test.store.getTaskAttemptMetadata({ taskId: id, fence: active.handle.fence + 1 }), null);
    test.store.close();
  }

  process.stdout.write('task state tests passed\n');
} catch (error) {
  failure = error;
} finally {
  for (const dir of temporaryRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (error) { if (!failure) throw error; }
  }
}
if (failure) throw failure;
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
