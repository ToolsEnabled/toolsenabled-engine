'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createStateStore, hashInput, SCHEMA_VERSION } = require('../../src/lib/state-store');

const roots = [];
const stores = [];
function fixture(label, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-scheduler-state-${label}-`));
  roots.push(dir);
  let now = options.now === undefined ? 1_800_000_000_000 : options.now;
  const store = createStateStore({ file: path.join(dir, 'state.sqlite3'), clock: () => now, busyTimeoutMs: 10000 });
  stores.push(store);
  return { dir, store, advance(ms) { now += ms; }, now() { return now; } };
}

const runtime = Object.freeze({
  nodePath: process.execPath,
  runnerPath: path.resolve(__dirname, '..', '..', 'src', 'job-runner.js'),
  principalId: 'S-1-5-21-111111111-222222222-333333333-1001'
});
// FIXTURE ACTION CHANGED 2026-08-23: every job in this suite was built on
// 'telegram.send', which left SUPPORTED_SCHEDULED_ACTIONS with the Telegram
// connector. 'gmail.send' is a surviving external-write action with the same
// shape of use, so the scheduler machinery under test -- cadence, registration,
// outbox, run admission -- is exercised exactly as before against an action the
// allowlist actually contains.
function input(name, extra = {}) {
  return {
    name, schedule: 'hourly', action: 'gmail.send',
    args: { to: 'owner@example.invalid', subject: `message-${name}` }, runtime, ...extra
  };
}
function expectCode(fn, code) {
  assert.throws(fn, error => error && error.code === code, `Expected ${code}.`);
}
function succeed(store, claim, observation = {}) {
  return store.completeSchedulerOutbox(claim.handle, { disposition: 'succeeded', observation });
}
function runWorker(file, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'scheduler-state-worker.js'), file, name], {
      cwd: path.resolve(__dirname, '..', '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `worker exited ${code}`));
      try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
    });
  });
}

// A DATABASE OLDER THAN 23 HAS THE THREE telegram_* TABLES. MIGRATION_V1 created
// them and MIGRATION_V23 (2026-08-23, the Telegram connector removal) drops them.
//
// The legacy fixtures below stamp an old user_version onto a CURRENT database,
// which has already been migrated past 23. Without this they would describe a v2
// or v3 database that never existed, and _validateSchema is right to refuse it on
// reopen. The CREATE text is byte-identical to SCHEMA_V1's, including the two
// singleton INSERTs its invariants check; a character of drift changes the DDL
// fingerprint and the reopen fails loudly rather than passing quietly. The three
// DROP IF EXISTS lines make it idempotent -- only they are conditional.
const RESTORE_TELEGRAM_TABLES_V1 = `DROP TABLE IF EXISTS telegram_updates; DROP TABLE IF EXISTS telegram_poll_lease; DROP TABLE IF EXISTS telegram_cursor; CREATE TABLE telegram_cursor ( provider TEXT PRIMARY KEY CHECK(provider = 'telegram'), next_update_id INTEGER NOT NULL CHECK(next_update_id >= 0), updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0) ) STRICT; INSERT INTO telegram_cursor(provider, next_update_id, updated_at_ms) VALUES('telegram', 0, 0); CREATE TABLE telegram_poll_lease ( provider TEXT PRIMARY KEY CHECK(provider = 'telegram'), owner_id TEXT, token TEXT, fence INTEGER NOT NULL CHECK(fence >= 0), expires_at_ms INTEGER, updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0), CHECK((owner_id IS NULL AND token IS NULL AND expires_at_ms IS NULL) OR (owner_id IS NOT NULL AND token IS NOT NULL AND expires_at_ms IS NOT NULL)) ) STRICT; INSERT INTO telegram_poll_lease(provider, owner_id, token, fence, expires_at_ms, updated_at_ms) VALUES('telegram', NULL, NULL, 0, NULL, 0); CREATE TABLE telegram_updates ( update_id INTEGER PRIMARY KEY CHECK(update_id >= 0), received_at_ms INTEGER NOT NULL CHECK(received_at_ms >= 0), payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64) ) STRICT; CREATE INDEX telegram_updates_received_idx ON telegram_updates(received_at_ms, update_id); `;

// A REAL v2 DATABASE HAD THE THREE telegram_* TABLES. MIGRATION_V1 created them
// and MIGRATION_V23 (2026-08-23, the Telegram connector removal) dropped them.
// The legacy fixture below stamps an old user_version onto a CURRENT database,
// so it puts them back first -- otherwise it describes a v2 database that never
// existed and _validateSchema is right to refuse it. The CREATE text is
// byte-identical to SCHEMA_V1's; a character of drift changes the DDL
// fingerprint and the reopen fails loudly rather than passing quietly.
(async () => {
try {
  // PINNED, AND MOVED DELIBERATELY. 22 -> 23 on 2026-08-23: MIGRATION_V23 drops the
  // three telegram_* tables with the Telegram connector. This assertion exists so a
  // schema bump cannot land without someone reading this suite's legacy fixtures
  // and deciding whether they still describe databases that could have existed.
  assert.equal(SCHEMA_VERSION, 24);

  // Schema 3 has one stable installation identity and enforces the documented
  // schtasks MINUTE cadence boundary.
  {
    const test = fixture('schema');
    const health = test.store.health();
    assert.equal(health.schemaVersion, SCHEMA_VERSION);
    const installation = test.store.schedulerInstallation();
    assert.match(installation.installationId, /^[a-f0-9]{32}$/);
    assert.equal(test.store.schedulerInstallation().installationId, installation.installationId);
    test.store.putSchedulerJob(input('minute-one', { schedule: 'minutes', intervalMinutes: 1 }));
    test.store.putSchedulerJob(input('minute-max', { schedule: 'minutes', intervalMinutes: 1439 }));
    expectCode(() => test.store.putSchedulerJob(input('minute-zero', { schedule: 'minutes', intervalMinutes: 0 })), 'STATE_INVALID_ARGUMENT');
    expectCode(() => test.store.putSchedulerJob(input('minute-over', { schedule: 'minutes', intervalMinutes: 1440 })), 'STATE_INVALID_ARGUMENT');
    test.store.close();
  }

  // A genuine v2 layout upgrades additively and preserves prior domain data.
  {
    const test = fixture('migration-v2');
    test.store.health();
    test.store.recordSpend({ amountCents: 125, dailyLimitCents: 1000, purpose: 'preserve', provider: 'fixture', reference: 'scheduler-v2' });
    test.store.transaction(db => db.exec(`DROP TABLE scheduler_runs;
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
      DROP TABLE scoped_approval_events; DROP TABLE scoped_approval_grants; DROP TABLE scoped_approval_actions; DROP TABLE scoped_approval_provenance; DROP TABLE policy_dispatch_consumptions;
      DROP TABLE policy_dispatch_authorizations;
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
      DROP TABLE research_results;
      DROP TABLE research_runs;
      DROP TABLE research_project_sessions;
      DROP TABLE research_findings;
      DROP TABLE research_experiments;
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
      PRAGMA user_version = 2;`));
    test.store.close();
    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3') });
    stores.push(migrated);
    assert.equal(migrated.health().schemaVersion, SCHEMA_VERSION);
    assert.equal(migrated.listSpend()[0].reference, 'scheduler-v2');
    assert.match(migrated.schedulerInstallation().installationId, /^[a-f0-9]{32}$/);
    migrated.close();
  }

  // A populated, exact schema-3 database upgrades without losing its runnable
  // registration. Schema 3 did not persist immutable action/args in that spec;
  // migration 4 binds them for the active generation in the same transaction.
  {
    const test = fixture('migration-v3');
    const created = test.store.putSchedulerJob(input('v3-active', { args: { to: 'owner@example.invalid', subject: 'preserved-v3' } }));
    succeed(test.store, test.store.claimSchedulerOutbox({ jobId: created.job.jobId }));
    test.store.transaction(db => {
      const row = db.prepare('SELECT spec_json FROM scheduler_registrations WHERE job_id = ? AND generation = 1').get(created.job.jobId);
      const legacySpec = JSON.parse(row.spec_json);
      delete legacySpec.action;
      delete legacySpec.args;
      const legacyJson = JSON.stringify(legacySpec, Object.keys(legacySpec).sort());
      db.prepare('UPDATE scheduler_registrations SET spec_json = ?, spec_hash = ? WHERE job_id = ? AND generation = 1')
        .run(legacyJson, hashInput(legacySpec), created.job.jobId);
      db.exec('DROP TABLE scoped_approval_events; DROP TABLE scoped_approval_grants; DROP TABLE scoped_approval_actions; DROP TABLE scoped_approval_provenance; DROP TABLE policy_dispatch_consumptions; DROP TABLE policy_dispatch_authorizations; DROP TABLE capability_profile_revocations; DROP TABLE capability_profile_requests; DROP TABLE capability_profile_bindings; DROP TABLE capability_profile_versions; DROP TABLE tavily_usage_monthly; DROP TABLE model_usage_daily; DROP TABLE remote_asks; DROP TABLE approval_grants; DROP TABLE memory_entries; DROP TABLE coordinator_workflow_acceptances; DROP TABLE coordinator_workflow_outbox; DROP TABLE coordinator_workflow_events; DROP TABLE coordinator_broker_verifications; DROP TABLE coordinator_workflow_missions; DROP TABLE coordinator_phase_states; DROP TABLE coordinator_missions; DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects; DROP INDEX scheduler_runs_active_job_idx; ALTER TABLE scheduler_jobs DROP COLUMN active_generation; ' + RESTORE_TELEGRAM_TABLES_V1 + 'PRAGMA user_version = 3;');
    });
    test.store.close();
    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3'), clock: () => test.now() });
    stores.push(migrated);
    assert.equal(migrated.health().schemaVersion, SCHEMA_VERSION);
    const restored = migrated.getSchedulerJob({ jobId: created.job.jobId });
    assert.equal(restored.activeGeneration, 1);
    const execution = migrated.startSchedulerRun({
      installationId: migrated.schedulerInstallation().installationId,
      jobId: created.job.jobId,
      generation: 1,
      ownershipMarker: restored.registration.ownershipMarker
    });
    assert.equal(execution.action, 'gmail.send');
    assert.deepEqual(execution.args, { to: 'owner@example.invalid', subject: 'preserved-v3' });
    migrated.completeSchedulerRun(execution, { status: 'succeeded', result: { migrated: true } });
    migrated.close();
  }

  // Real schema-3 registrations with a non-SID account name are deliberately
  // not activated: their Windows identity cannot be reconstructed safely. The
  // deletion record must also drop that invalid value so provider-side
  // ephemeral SID enrichment can clean it up. A normal put then rolls forward.
  {
    const test = fixture('migration-v3-no-principal');
    const desired = input('v3-no-principal', { args: { to: 'owner@example.invalid', subject: 'old-principal' } });
    const created = test.store.putSchedulerJob(desired);
    succeed(test.store, test.store.claimSchedulerOutbox({ jobId: created.job.jobId }));
    test.store.transaction(db => {
      const row = db.prepare('SELECT spec_json FROM scheduler_registrations WHERE job_id = ? AND generation = 1').get(created.job.jobId);
      const legacySpec = JSON.parse(row.spec_json);
      delete legacySpec.action;
      delete legacySpec.args;
      legacySpec.principalId = 'DESKTOP\\legacy-user';
      const legacyJson = JSON.stringify(legacySpec, Object.keys(legacySpec).sort());
      const oldDesiredHash = hashInput({
        schedule: 'hourly', intervalMinutes: null, action: 'gmail.send', args: desired.args,
        nodePath: runtime.nodePath, runnerPath: runtime.runnerPath
      });
      db.prepare('UPDATE scheduler_registrations SET spec_json = ?, spec_hash = ? WHERE job_id = ? AND generation = 1')
        .run(legacyJson, hashInput(legacySpec), created.job.jobId);
      db.prepare('UPDATE scheduler_jobs SET spec_hash = ? WHERE id = ?').run(oldDesiredHash, created.job.jobId);
      db.exec('DROP TABLE scoped_approval_events; DROP TABLE scoped_approval_grants; DROP TABLE scoped_approval_actions; DROP TABLE scoped_approval_provenance; DROP TABLE policy_dispatch_consumptions; DROP TABLE policy_dispatch_authorizations; DROP TABLE capability_profile_revocations; DROP TABLE capability_profile_requests; DROP TABLE capability_profile_bindings; DROP TABLE capability_profile_versions; DROP TABLE tavily_usage_monthly; DROP TABLE model_usage_daily; DROP TABLE remote_asks; DROP TABLE approval_grants; DROP TABLE memory_entries; DROP TABLE coordinator_workflow_acceptances; DROP TABLE coordinator_workflow_outbox; DROP TABLE coordinator_workflow_events; DROP TABLE coordinator_broker_verifications; DROP TABLE coordinator_workflow_missions; DROP TABLE coordinator_phase_states; DROP TABLE coordinator_missions; DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects; DROP INDEX scheduler_runs_active_job_idx; ALTER TABLE scheduler_jobs DROP COLUMN active_generation; ' + RESTORE_TELEGRAM_TABLES_V1 + 'PRAGMA user_version = 3;');
    });
    test.store.close();
    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3'), clock: () => test.now() });
    stores.push(migrated);
    const degraded = migrated.getSchedulerJob({ jobId: created.job.jobId });
    assert.equal(degraded.activeGeneration, null);
    assert.equal(degraded.providerState, 'error');
    assert.equal(degraded.providerError.code, 'SCHEDULER_PRINCIPAL_REFRESH_REQUIRED');
    expectCode(() => migrated.getSchedulerExecution({
      installationId: migrated.schedulerInstallation().installationId,
      jobId: created.job.jobId, generation: 1, ownershipMarker: degraded.registration.ownershipMarker
    }), 'SCHEDULER_STALE_INVOCATION');
    const legacyDelete = migrated.claimSchedulerOutbox({ jobId: created.job.jobId });
    assert.equal(legacyDelete.work.outbox.operation, 'delete');
    assert.equal(legacyDelete.work.registration.spec.principalId, undefined,
      'A migrated non-SID principal must not poison deletion retries.');
    const cleanedLegacy = succeed(migrated, legacyDelete);
    assert.equal(cleanedLegacy.job.providerError.code, 'SCHEDULER_PRINCIPAL_REFRESH_REQUIRED');
    const refreshed = migrated.putSchedulerJob(desired);
    assert.equal(refreshed.job.generation, 2);
    assert.equal(refreshed.job.activeGeneration, null);
    assert.equal(refreshed.registration.spec.principalId, runtime.principalId);
    migrated.close();
  }

  // A cleanup error for an old generation must not deactivate a current,
  // exactly observed registration during the schema-3-to-4 migration.
  {
    const test = fixture('migration-v3-active-with-cleanup-error');
    const first = test.store.putSchedulerJob(input('v3-cleanup-error'));
    succeed(test.store, test.store.claimSchedulerOutbox({ jobId: first.job.jobId }));
    const second = test.store.putSchedulerJob(input('v3-cleanup-error', {
      args: { to: 'owner@example.invalid', subject: 'current-generation' }
    }));
    succeed(test.store, test.store.claimSchedulerOutbox({ jobId: first.job.jobId }));
    const oldDelete = test.store.claimSchedulerOutbox({ jobId: first.job.jobId });
    assert.equal(oldDelete.work.outbox.generation, 1);
    test.store.completeSchedulerOutbox(oldDelete.handle, {
      disposition: 'error', code: 'LEGACY_DELETE_FAILED', message: 'old cleanup failed'
    });
    const before = test.store.getSchedulerJob({ jobId: first.job.jobId });
    assert.equal(before.activeGeneration, 2);
    assert.equal(before.providerState, 'error');
    test.store.transaction(db => {
      db.exec('DROP TABLE scoped_approval_events; DROP TABLE scoped_approval_grants; DROP TABLE scoped_approval_actions; DROP TABLE scoped_approval_provenance; DROP TABLE policy_dispatch_consumptions; DROP TABLE policy_dispatch_authorizations; DROP TABLE capability_profile_revocations; DROP TABLE capability_profile_requests; DROP TABLE capability_profile_bindings; DROP TABLE capability_profile_versions; DROP TABLE tavily_usage_monthly; DROP TABLE model_usage_daily; DROP TABLE remote_asks; DROP TABLE approval_grants; DROP TABLE memory_entries; DROP TABLE coordinator_workflow_acceptances; DROP TABLE coordinator_workflow_outbox; DROP TABLE coordinator_workflow_events; DROP TABLE coordinator_broker_verifications; DROP TABLE coordinator_workflow_missions; DROP TABLE coordinator_phase_states; DROP TABLE coordinator_missions; DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects; DROP INDEX scheduler_runs_active_job_idx; ALTER TABLE scheduler_jobs DROP COLUMN active_generation; ' + RESTORE_TELEGRAM_TABLES_V1 + 'PRAGMA user_version = 3;');
    });
    test.store.close();
    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3'), clock: () => test.now() });
    stores.push(migrated);
    const after = migrated.getSchedulerJob({ jobId: first.job.jobId });
    assert.equal(after.activeGeneration, 2, 'Unrelated cleanup failure must not disable the current generation.');
    assert.equal(after.providerState, 'error');
    assert.equal(migrated.getSchedulerExecution({
      installationId: migrated.schedulerInstallation().installationId,
      jobId: first.job.jobId, generation: 2, ownershipMarker: second.registration.ownershipMarker
    }).action, 'gmail.send');
    const replay = migrated.putSchedulerJob(input('v3-cleanup-error', {
      args: { to: 'owner@example.invalid', subject: 'current-generation' }
    }));
    assert.equal(replay.replayed, true);
    assert.equal(replay.job.activeGeneration, 2);
    migrated.close();
  }

  // A schema-3 alias cannot be rewritten in place because its OS ownership
  // marker binds the old desired hash. Retire it deletion-only and require a
  // fresh canonical generation.
  {
    const test = fixture('migration-v3-action-alias');
    const desired = input('v3-action-alias', {
      action: 'instagram.publish_image', args: { imageUrl: 'https://example.test/image.jpg', caption: 'legacy alias' }
    });
    const created = test.store.putSchedulerJob(desired);
    succeed(test.store, test.store.claimSchedulerOutbox({ jobId: created.job.jobId }));
    test.store.transaction(db => {
      const row = db.prepare('SELECT spec_json FROM scheduler_registrations WHERE job_id = ? AND generation = 1').get(created.job.jobId);
      const spec = JSON.parse(row.spec_json);
      const oldDesiredHash = hashInput({
        schedule: 'hourly', intervalMinutes: null, action: 'instagram.publishImage', args: desired.args,
        nodePath: runtime.nodePath, runnerPath: runtime.runnerPath, principalId: runtime.principalId
      });
      delete spec.action;
      delete spec.args;
      spec.desiredSpecHash = oldDesiredHash;
      spec.ownershipMarker = hashInput({
        domain: 'toolsenabled.scheduler.registration.v1', installationId: spec.installationId,
        jobId: spec.jobId, generation: spec.generation, taskName: spec.taskName,
        specHash: oldDesiredHash, nodePath: spec.nodePath, runnerPath: spec.runnerPath,
        principalId: spec.principalId
      });
      const specJson = JSON.stringify(spec);
      db.prepare(`UPDATE scheduler_registrations SET ownership_marker = ?, spec_json = ?, spec_hash = ?
        WHERE job_id = ? AND generation = 1`).run(spec.ownershipMarker, specJson, hashInput(spec), created.job.jobId);
      db.prepare(`UPDATE scheduler_jobs SET action = 'instagram.publishImage', spec_hash = ? WHERE id = ?`).run(oldDesiredHash, created.job.jobId);
      db.exec('DROP TABLE scoped_approval_events; DROP TABLE scoped_approval_grants; DROP TABLE scoped_approval_actions; DROP TABLE scoped_approval_provenance; DROP TABLE policy_dispatch_consumptions; DROP TABLE policy_dispatch_authorizations; DROP TABLE capability_profile_revocations; DROP TABLE capability_profile_requests; DROP TABLE capability_profile_bindings; DROP TABLE capability_profile_versions; DROP TABLE tavily_usage_monthly; DROP TABLE model_usage_daily; DROP TABLE remote_asks; DROP TABLE approval_grants; DROP TABLE memory_entries; DROP TABLE coordinator_workflow_acceptances; DROP TABLE coordinator_workflow_outbox; DROP TABLE coordinator_workflow_events; DROP TABLE coordinator_broker_verifications; DROP TABLE coordinator_workflow_missions; DROP TABLE coordinator_phase_states; DROP TABLE coordinator_missions; DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects; DROP INDEX scheduler_runs_active_job_idx; ALTER TABLE scheduler_jobs DROP COLUMN active_generation; ' + RESTORE_TELEGRAM_TABLES_V1 + 'PRAGMA user_version = 3;');
    });
    test.store.close();
    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3'), clock: () => test.now() });
    stores.push(migrated);
    const degraded = migrated.getSchedulerJob({ jobId: created.job.jobId });
    assert.equal(degraded.action, 'instagram.publish_image');
    assert.equal(degraded.activeGeneration, null);
    assert.equal(degraded.providerError.code, 'SCHEDULER_ACTION_REFRESH_REQUIRED');
    assert.equal(degraded.registration.desiredState, 'absent');
    assert.equal(degraded.registration.spec.action, undefined);
    const refreshed = migrated.putSchedulerJob(desired);
    assert.equal(refreshed.job.generation, 2);
    migrated.close();
  }

  // Job identity is immutable, runtime identity participates in the desired
  // hash, and every generation owns a distinct flat root task name.
  {
    const test = fixture('generations');
    const first = test.store.putSchedulerJob(input('rotate'));
    assert.match(first.registration.taskName, /^\\ToolsEnabled-v2-[A-Za-z0-9-]+$/);
    assert.equal(first.registration.taskName.slice(1).includes('\\'), false);
    const replay = test.store.putSchedulerJob({ ...input('rotate'), args: { subject: 'message-rotate', to: 'owner@example.invalid' } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.job.generation, 1);
    const moved = test.store.putSchedulerJob(input('rotate', {
      runtime: { ...runtime, runnerPath: path.resolve(__dirname, '..', '..', 'src', 'job-runner-moved.js') }
    }));
    assert.equal(moved.job.jobId, first.job.jobId);
    assert.equal(moved.job.generation, 2);
    assert.notEqual(moved.job.specHash, first.job.specHash);
    assert.notEqual(moved.registration.taskName, first.registration.taskName);
    test.store.close();
  }

  // The max job cap is checked in the same write transaction as insertion.
  {
    const test = fixture('limit');
    test.store.putSchedulerJob(input('only', { maxScheduledJobs: 1 }));
    expectCode(() => test.store.putSchedulerJob(input('blocked', { maxScheduledJobs: 1 })), 'SCHEDULER_JOB_LIMIT_REACHED');
    assert.deepEqual(test.store.listSchedulerJobs().map(job => job.name), ['only']);
    test.store.close();
  }

  // Fenced terminal failures do not spin automatically, but can be explicitly
  // requeued. A stale capability remains unusable after the new fence is issued.
  {
    const test = fixture('requeue');
    const created = test.store.putSchedulerJob(input('retry'));
    const firstClaim = test.store.claimSchedulerOutbox({ jobId: created.job.jobId, ownerId: 'worker-a', leaseMs: 1000 });
    const failed = test.store.completeSchedulerOutbox(firstClaim.handle, {
      disposition: 'error', code: 'ACCESS_DENIED', message: 'definitive provider rejection'
    });
    assert.equal(failed.outbox.status, 'error');
    assert.equal(test.store.claimSchedulerOutbox({ jobId: created.job.jobId }).claimed, false);
    assert.equal(test.store.requeueSchedulerOutbox({ outboxId: failed.outbox.outboxId }).outbox.status, 'pending');
    const secondClaim = test.store.claimSchedulerOutbox({ jobId: created.job.jobId, ownerId: 'worker-b', leaseMs: 1000 });
    assert.equal(secondClaim.handle.fence, firstClaim.handle.fence + 1);
    expectCode(() => succeed(test.store, firstClaim), 'SCHEDULER_OUTBOX_FENCE_LOST');
    assert.equal(succeed(test.store, secondClaim).job.providerState, 'registered');
    test.store.close();
  }

  // A job may have several generation/operation records, but only one may be
  // executing at a time. In particular, a retired delete cannot race a newer
  // ensure at Task Scheduler's external mutation boundary.
  {
    const test = fixture('serialized-outbox');
    const first = test.store.putSchedulerJob(input('serialized'));
    const firstEnsure = test.store.claimSchedulerOutbox({ jobId: first.job.jobId, ownerId: 'worker-one' });
    assert.equal(firstEnsure.claimed, true);
    test.store.putSchedulerJob(input('serialized', { args: { to: 'owner@example.invalid', subject: 'generation-two' } }));
    assert.equal(test.store.claimSchedulerOutbox({ jobId: first.job.jobId, ownerId: 'worker-two' }).claimed, false);

    succeed(test.store, firstEnsure);
    const secondEnsure = test.store.claimSchedulerOutbox({ jobId: first.job.jobId, ownerId: 'worker-two' });
    assert.equal(secondEnsure.work.outbox.operation, 'ensure');
    assert.equal(secondEnsure.work.outbox.generation, 2);
    assert.equal(test.store.claimSchedulerOutbox({ jobId: first.job.jobId, ownerId: 'worker-three' }).claimed, false);

    succeed(test.store, secondEnsure);
    const retiredDelete = test.store.claimSchedulerOutbox({ jobId: first.job.jobId, ownerId: 'worker-three' });
    assert.equal(retiredDelete.work.outbox.operation, 'delete');
    assert.equal(retiredDelete.work.outbox.generation, 1);
    assert.equal(test.store.claimSchedulerOutbox({ jobId: first.job.jobId, ownerId: 'worker-four' }).claimed, false);
    succeed(test.store, retiredDelete);
    assert.equal(test.store.claimSchedulerOutbox({ jobId: first.job.jobId }).claimed, false);
    test.store.close();
  }

  // Removing while an ensure is in flight makes that ensure historical. Its
  // late failure must not become a terminal error that masks successful cleanup.
  {
    const test = fixture('late-ensure-after-remove');
    const created = test.store.putSchedulerJob(input('late-remove'));
    const ensure = test.store.claimSchedulerOutbox({ jobId: created.job.jobId });
    test.store.removeSchedulerJob({ name: 'late-remove' });
    const late = test.store.completeSchedulerOutbox(ensure.handle, {
      disposition: 'error', code: 'LATE_ENSURE_FAILED', message: 'ensure finished after tombstone'
    });
    assert.equal(late.outbox.status, 'superseded');
    assert.equal(late.job.providerState, 'removing');
    assert.equal(test.store.requeueSchedulerOutbox({ outboxId: late.outbox.outboxId }).replayed, true);
    const cleanup = test.store.claimSchedulerOutbox({ jobId: created.job.jobId });
    assert.equal(cleanup.work.outbox.operation, 'delete');
    assert.equal(succeed(test.store, cleanup).job.providerState, 'absent');
    test.store.close();
  }

  // Removing during a generation handoff tombstones every generation, wakes
  // every delete, and reports absent only after all exact registrations are gone.
  {
    const test = fixture('remove-all');
    const gen1 = test.store.putSchedulerJob(input('handoff'));
    succeed(test.store, test.store.claimSchedulerOutbox({ jobId: gen1.job.jobId }));
    const gen2 = test.store.putSchedulerJob(input('handoff', { args: { to: 'owner@example.invalid', subject: 'new' } }));
    assert.equal(gen2.job.generation, 2);
    const removed = test.store.removeSchedulerJob({ name: 'handoff' });
    assert.equal(removed.job.providerState, 'removing');
    const rows = test.store.transaction(db => ({
      registrations: db.prepare('SELECT generation, desired_state FROM scheduler_registrations WHERE job_id = ? ORDER BY generation').all(gen1.job.jobId),
      deletes: db.prepare("SELECT generation, status, available_at_ms FROM scheduler_outbox WHERE job_id = ? AND operation = 'delete' ORDER BY generation").all(gen1.job.jobId)
    }));
    assert.deepEqual(rows.registrations.map(row => ({ ...row })), [{ generation: 1, desired_state: 'absent' }, { generation: 2, desired_state: 'absent' }]);
    assert.deepEqual(rows.deletes.map(row => row.status), ['pending', 'pending']);
    assert.ok(rows.deletes.every(row => row.available_at_ms === test.now()));

    // Force current generation first to cover the former false-absent window.
    test.store.transaction(db => db.prepare("UPDATE scheduler_outbox SET available_at_ms = ? WHERE job_id = ? AND generation = 1 AND operation = 'delete'")
      .run(test.now() + 5000, gen1.job.jobId));
    const currentDelete = test.store.claimSchedulerOutbox({ jobId: gen1.job.jobId });
    assert.equal(currentDelete.work.outbox.generation, 2);
    assert.equal(succeed(test.store, currentDelete).job.providerState, 'removing');
    test.advance(5000);
    const oldDelete = test.store.claimSchedulerOutbox({ jobId: gen1.job.jobId });
    assert.equal(oldDelete.work.outbox.generation, 1);
    assert.equal(succeed(test.store, oldDelete).job.providerState, 'absent');
    assert.equal(test.store.removeSchedulerJob({ name: 'handoff' }).replayed, true);
    test.store.close();
  }

  // Run validation and insertion are one transaction; overriding the public
  // read helper cannot create a TOCTOU path. Tombstoning blocks later starts.
  {
    const test = fixture('runs');
    const created = test.store.putSchedulerJob(input('runner'));
    succeed(test.store, test.store.claimSchedulerOutbox({ jobId: created.job.jobId }));
    const selector = {
      installationId: test.store.schedulerInstallation().installationId,
      jobId: created.job.jobId,
      generation: 1,
      ownershipMarker: created.registration.ownershipMarker
    };
    test.store.getSchedulerExecution = () => { throw new Error('must not be called by startSchedulerRun'); };
    const run = test.store.startSchedulerRun(selector);
    assert.equal(run.job.jobId, created.job.jobId);
    assert.equal(run.action, 'gmail.send');
    assert.deepEqual(run.args, input('runner').args);
    test.store.completeSchedulerRun(run, { status: 'succeeded', result: { ok: true } });
    const abandoned = test.store.startSchedulerRun(selector);
    test.advance(60_001);
    const recovered = test.store.reapExpiredSchedulerRuns({ olderThanMs: 60_000, limit: 1 });
    assert.equal(recovered.reaped, 1);
    assert.equal(recovered.runs[0].runId, abandoned.runId);
    expectCode(() => test.store.completeSchedulerRun(abandoned, { status: 'succeeded', result: {} }), 'SCHEDULER_RUN_FENCE_LOST');
    test.store.removeSchedulerJob({ name: 'runner' });
    expectCode(() => test.store.startSchedulerRun(selector), 'SCHEDULER_STALE_INVOCATION');
    test.store.close();
  }

  // Replacement is a real handoff: a failed desired generation leaves the
  // previous immutable registration executable; success flips exactly once.
  {
    const test = fixture('continuity');
    const first = test.store.putSchedulerJob(input('continuous', { args: { to: 'owner@example.invalid', subject: 'generation-one' } }));
    succeed(test.store, test.store.claimSchedulerOutbox({ jobId: first.job.jobId }));
    const installationId = test.store.schedulerInstallation().installationId;
    const firstSelector = {
      installationId, jobId: first.job.jobId, generation: 1,
      ownershipMarker: first.registration.ownershipMarker
    };
    assert.deepEqual(test.store.getSchedulerExecution(firstSelector).args, { to: 'owner@example.invalid', subject: 'generation-one' });

    const second = test.store.putSchedulerJob(input('continuous', { args: { to: 'owner@example.invalid', subject: 'generation-two' } }));
    assert.equal(second.job.activeGeneration, 1);
    assert.equal(test.store.getSchedulerExecution(firstSelector).action, 'gmail.send');
    const secondSelector = {
      installationId, jobId: first.job.jobId, generation: 2,
      ownershipMarker: second.registration.ownershipMarker
    };
    expectCode(() => test.store.getSchedulerExecution(secondSelector), 'SCHEDULER_STALE_INVOCATION');
    expectCode(() => test.store.getSchedulerExecution({ ...firstSelector, ownershipMarker: '0'.repeat(64) }), 'SCHEDULER_STALE_INVOCATION');

    const failedClaim = test.store.claimSchedulerOutbox({ jobId: first.job.jobId });
    assert.equal(failedClaim.work.outbox.generation, 2);
    const failed = test.store.completeSchedulerOutbox(failedClaim.handle, {
      disposition: 'error', code: 'REGISTER_FAILED', message: 'replacement failed'
    });
    assert.equal(failed.job.activeGeneration, 1);
    const oldRun = test.store.startSchedulerRun(firstSelector);
    assert.deepEqual(oldRun.args, { to: 'owner@example.invalid', subject: 'generation-one' });
    assert.equal(test.store.transaction(db => db.prepare('SELECT generation FROM scheduler_runs WHERE id = ?').get(oldRun.runId).generation), 1);

    test.store.requeueSchedulerOutbox({ outboxId: failed.outbox.outboxId });
    const replacement = test.store.claimSchedulerOutbox({ jobId: first.job.jobId });
    const activated = succeed(test.store, replacement);
    assert.equal(activated.job.activeGeneration, 2);
    expectCode(() => test.store.getSchedulerExecution(firstSelector), 'SCHEDULER_STALE_INVOCATION');
    assert.deepEqual(test.store.getSchedulerExecution(secondSelector).args, { to: 'owner@example.invalid', subject: 'generation-two' });
    expectCode(() => test.store.startSchedulerRun(secondSelector), 'SCHEDULER_RUN_OVERLAP');
    test.store.completeSchedulerRun(oldRun, { status: 'succeeded', result: { generation: 1 } });
    const newRun = test.store.startSchedulerRun(secondSelector);
    assert.equal(test.store.transaction(db => db.prepare('SELECT generation FROM scheduler_runs WHERE id = ?').get(newRun.runId).generation), 2);
    test.store.completeSchedulerRun(newRun, { status: 'succeeded', result: { generation: 2 } });
    assert.ok(test.store.listSchedulerOutbox({ jobId: first.job.jobId, statuses: ['pending'] })
      .some(item => item.operation === 'delete' && item.generation === 1));
    const cleanup = test.store.claimSchedulerOutbox({ jobId: first.job.jobId });
    const cleanupFailed = test.store.completeSchedulerOutbox(cleanup.handle, {
      disposition: 'error', code: 'DELETE_DENIED', message: 'retired task cleanup failed'
    });
    assert.equal(cleanupFailed.job.providerState, 'error');
    assert.equal(cleanupFailed.job.providerError.code, 'DELETE_DENIED');
    test.store.requeueSchedulerOutbox({ outboxId: cleanupFailed.outbox.outboxId });
    assert.equal(test.store.getSchedulerJob({ jobId: first.job.jobId }).providerState, 'registered');
    succeed(test.store, test.store.claimSchedulerOutbox({ jobId: first.job.jobId }));

    test.store.removeSchedulerJob({ name: 'continuous' });
    expectCode(() => test.store.getSchedulerExecution(firstSelector), 'SCHEDULER_STALE_INVOCATION');
    expectCode(() => test.store.getSchedulerExecution(secondSelector), 'SCHEDULER_STALE_INVOCATION');
    test.store.close();
  }

  // A job-scoped claim cannot consume an unrelated job's work.
  {
    const test = fixture('claim-filter');
    const left = test.store.putSchedulerJob(input('left'));
    const right = test.store.putSchedulerJob(input('right'));
    const claimed = test.store.claimSchedulerOutbox({ jobId: right.job.jobId });
    assert.equal(claimed.work.job.jobId, right.job.jobId);
    assert.notEqual(claimed.work.job.jobId, left.job.jobId);
    test.store.close();
  }

  // The cap remains atomic across independent processes.
  {
    const test = fixture('concurrency');
    test.store.health();
    test.store.close();
    const file = path.join(test.dir, 'state.sqlite3');
    const results = await Promise.all([runWorker(file, 'concurrent-a'), runWorker(file, 'concurrent-b')]);
    assert.equal(results.filter(item => item.ok).length, 1);
    assert.equal(results.filter(item => item.code === 'SCHEDULER_JOB_LIMIT_REACHED').length, 1);
    const reopened = createStateStore({ file });
    assert.equal(reopened.listSchedulerJobs().length, 1);
    reopened.close();
  }

  // Row-level tampering of the singleton is detected even when DDL is intact.
  {
    const test = fixture('singleton');
    test.store.health();
    test.store.transaction(db => db.prepare('DELETE FROM scheduler_installation WHERE singleton = 1').run());
    expectCode(() => test.store.health(), 'STATE_SCHEMA_INVALID');
    test.store.close();
  }

  // Scheduler payloads are canonicalized and credential-shaped values never
  // enter the durable database.
  {
    const test = fixture('secrets');
    expectCode(() => test.store.putSchedulerJob(input('unsafe', { args: { accessToken: 'secret' } })), 'SCHEDULER_SECRET_REJECTED');
    expectCode(() => test.store.putSchedulerJob(input('unsafe-string', { args: { text: 'Bearer abcdefghijklmnopqrstuvwxyz1234' } })), 'SCHEDULER_SECRET_REJECTED');
    assert.equal(test.store.listSchedulerJobs().length, 0);
    test.store.close();
  }

  // Canonical hashes and row bindings are authority boundaries: corruption is
  // rejected before a run or outbox claim can acquire a fence.
  {
    const test = fixture('tamper');
    const job = test.store.putSchedulerJob(input('tampered-job'));
    test.store.transaction(db => db.prepare('UPDATE scheduler_jobs SET args_json = ? WHERE id = ?')
      .run('{"to":"owner@example.invalid","subject":"changed"}', job.job.jobId));
    expectCode(() => test.store.health(), 'SCHEDULER_JOB_CORRUPT');
    expectCode(() => test.store.getSchedulerJob({ jobId: job.job.jobId }), 'SCHEDULER_JOB_CORRUPT');
    test.store.close();
  }
  {
    const test = fixture('registration-tamper');
    const job = test.store.putSchedulerJob(input('tampered-registration'));
    test.store.transaction(db => {
      const row = db.prepare('SELECT spec_json FROM scheduler_registrations WHERE job_id = ? AND generation = 1').get(job.job.jobId);
      const spec = JSON.parse(row.spec_json);
      spec.action = 'gmail.send';
      spec.args = { to: 'ops@example.invalid', subject: 'swapped-after-signing' };
      spec.desiredSpecHash = hashInput({
        schedule: spec.schedule, intervalMinutes: spec.intervalMinutes, action: spec.action, args: spec.args,
        nodePath: spec.nodePath, runnerPath: spec.runnerPath, principalId: spec.principalId
      });
      spec.ownershipMarker = hashInput({
        domain: 'toolsenabled.scheduler.registration.v1', installationId: spec.installationId,
        jobId: spec.jobId, generation: spec.generation, taskName: spec.taskName,
        specHash: spec.desiredSpecHash, nodePath: spec.nodePath, runnerPath: spec.runnerPath,
        principalId: spec.principalId
      });
      const json = JSON.stringify(spec);
      db.prepare('UPDATE scheduler_registrations SET ownership_marker = ?, spec_json = ?, spec_hash = ? WHERE job_id = ? AND generation = 1')
        .run(spec.ownershipMarker, json, hashInput(spec), job.job.jobId);
    });
    expectCode(() => test.store.health(), 'SCHEDULER_REGISTRATION_CORRUPT');
    expectCode(() => test.store.claimSchedulerOutbox({ jobId: job.job.jobId }), 'SCHEDULER_REGISTRATION_CORRUPT');
    const unchanged = test.store.transaction(db => db.prepare("SELECT status, attempt, fence FROM scheduler_outbox WHERE job_id = ? AND operation = 'ensure'").get(job.job.jobId));
    assert.deepEqual({ ...unchanged }, { status: 'pending', attempt: 0, fence: 0 });
    test.store.close();
  }
  {
    const test = fixture('execution-cross-bind');
    const job = test.store.putSchedulerJob(input('tampered-execution'));
    succeed(test.store, test.store.claimSchedulerOutbox({ jobId: job.job.jobId }));
    let tamperedMarker;
    test.store.transaction(db => {
      const row = db.prepare('SELECT spec_json FROM scheduler_registrations WHERE job_id = ? AND generation = 1').get(job.job.jobId);
      const spec = JSON.parse(row.spec_json);
      spec.action = 'gmail.send';
      spec.args = { to: 'ops@example.invalid', subject: 'tampered-execution' };
      spec.desiredSpecHash = hashInput({
        schedule: spec.schedule, intervalMinutes: spec.intervalMinutes, action: spec.action, args: spec.args,
        nodePath: spec.nodePath, runnerPath: spec.runnerPath, principalId: spec.principalId
      });
      spec.ownershipMarker = hashInput({
        domain: 'toolsenabled.scheduler.registration.v1', installationId: spec.installationId,
        jobId: spec.jobId, generation: spec.generation, taskName: spec.taskName,
        specHash: spec.desiredSpecHash, nodePath: spec.nodePath, runnerPath: spec.runnerPath,
        principalId: spec.principalId
      });
      tamperedMarker = spec.ownershipMarker;
      const json = JSON.stringify(spec);
      db.prepare('UPDATE scheduler_registrations SET ownership_marker = ?, spec_json = ?, spec_hash = ? WHERE job_id = ? AND generation = 1')
        .run(spec.ownershipMarker, json, hashInput(spec), job.job.jobId);
    });
    expectCode(() => test.store.startSchedulerRun({
      installationId: test.store.schedulerInstallation().installationId,
      jobId: job.job.jobId, generation: 1, ownershipMarker: tamperedMarker
    }), 'SCHEDULER_REGISTRATION_CORRUPT');
    assert.equal(test.store.transaction(db => db.prepare('SELECT COUNT(*) AS count FROM scheduler_runs WHERE job_id = ?').get(job.job.jobId).count), 0);
    test.store.close();
  }
  {
    const test = fixture('task-name-tamper');
    const job = test.store.putSchedulerJob(input('tampered-task-name'));
    test.store.transaction(db => {
      const row = db.prepare('SELECT spec_json FROM scheduler_registrations WHERE job_id = ? AND generation = 1').get(job.job.jobId);
      const spec = JSON.parse(row.spec_json);
      spec.taskName = `${spec.taskName}-foreign`;
      const json = JSON.stringify(spec);
      db.prepare('UPDATE scheduler_registrations SET task_name = ?, spec_json = ?, spec_hash = ? WHERE job_id = ? AND generation = 1')
        .run(spec.taskName, json, hashInput(spec), job.job.jobId);
    });
    expectCode(() => test.store.getSchedulerJob({ jobId: job.job.jobId }), 'SCHEDULER_REGISTRATION_CORRUPT');
    test.store.close();
  }
  {
    const test = fixture('outbox-cross-bind');
    const job = test.store.putSchedulerJob(input('tampered-outbox-operation'));
    test.store.transaction(db => {
      const row = db.prepare("SELECT * FROM scheduler_outbox WHERE job_id = ? AND operation = 'ensure'").get(job.job.jobId);
      const forgedId = row.id.replace(/^scheduler-ensure-/, 'scheduler-delete-');
      db.prepare("UPDATE scheduler_outbox SET id = ?, operation = 'delete' WHERE id = ?").run(forgedId, row.id);
    });
    expectCode(() => test.store.health(), 'SCHEDULER_OUTBOX_CORRUPT');
    expectCode(() => test.store.claimSchedulerOutbox({ jobId: job.job.jobId }), 'SCHEDULER_OUTBOX_CORRUPT');
    const unchanged = test.store.transaction(db => db.prepare('SELECT status, attempt, fence FROM scheduler_outbox WHERE job_id = ?').get(job.job.jobId));
    assert.deepEqual({ ...unchanged }, { status: 'pending', attempt: 0, fence: 0 });
    test.store.close();
  }
  {
    const test = fixture('outbox-completeness-recovery');
    const desired = input('missing-outbox');
    const job = test.store.putSchedulerJob(desired);
    test.store.transaction(db => db.prepare('DELETE FROM scheduler_outbox WHERE job_id = ?').run(job.job.jobId));
    expectCode(() => test.store.health(), 'SCHEDULER_OUTBOX_CORRUPT');
    expectCode(() => test.store.claimSchedulerOutbox({ jobId: job.job.jobId }), 'SCHEDULER_OUTBOX_CORRUPT');
    const repaired = test.store.putSchedulerJob(desired);
    assert.equal(repaired.replayed, true);
    assert.equal(repaired.requeued, true);
    assert.equal(repaired.outbox.status, 'pending');
    assert.equal(succeed(test.store, test.store.claimSchedulerOutbox({ jobId: job.job.jobId })).job.providerState, 'registered');
    test.store.close();
  }
  {
    const test = fixture('current-registration-completeness');
    const first = test.store.putSchedulerJob(input('missing-current-registration'));
    succeed(test.store, test.store.claimSchedulerOutbox({ jobId: first.job.jobId }));
    const desired = input('missing-current-registration', { args: { to: 'owner@example.invalid', subject: 'generation-two' } });
    test.store.putSchedulerJob(desired);
    test.store.transaction(db => {
      db.prepare('DELETE FROM scheduler_outbox WHERE job_id = ? AND generation = 2').run(first.job.jobId);
      db.prepare('DELETE FROM scheduler_registrations WHERE job_id = ? AND generation = 2').run(first.job.jobId);
    });
    expectCode(() => test.store.health(), 'SCHEDULER_REGISTRATION_CORRUPT');
    expectCode(() => test.store.claimSchedulerOutbox({ jobId: first.job.jobId }), 'SCHEDULER_REGISTRATION_CORRUPT');
    expectCode(() => test.store.putSchedulerJob(desired), 'SCHEDULER_REGISTRATION_CORRUPT');
    test.store.close();
  }
  {
    const test = fixture('current-registration-desired-cross-bind');
    const first = test.store.putSchedulerJob(input('desired-cross-bind'));
    succeed(test.store, test.store.claimSchedulerOutbox({ jobId: first.job.jobId }));
    test.store.putSchedulerJob(input('desired-cross-bind', { args: { to: 'owner@example.invalid', subject: 'generation-two' } }));
    test.store.transaction(db => {
      const ensure = db.prepare("SELECT * FROM scheduler_outbox WHERE job_id = ? AND generation = 2 AND operation = 'ensure'").get(first.job.jobId);
      const forgedId = ensure.id.replace(/^scheduler-ensure-/, 'scheduler-delete-');
      db.prepare("UPDATE scheduler_registrations SET desired_state = 'absent' WHERE job_id = ? AND generation = 2").run(first.job.jobId);
      db.prepare("UPDATE scheduler_outbox SET id = ?, operation = 'delete' WHERE id = ?").run(forgedId, ensure.id);
    });
    expectCode(() => test.store.health(), 'SCHEDULER_REGISTRATION_CORRUPT');
    expectCode(() => test.store.claimSchedulerOutbox({ jobId: first.job.jobId }), 'SCHEDULER_REGISTRATION_CORRUPT');
    test.store.close();
  }

  process.stdout.write('scheduler-state tests passed\n');
} finally {
  for (const store of stores) {
    try { store.close(); } catch { /* preserve the initiating test failure */ }
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
