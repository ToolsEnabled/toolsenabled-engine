// EXECUTABLE CHANGE
/* testcanfail-tests-kernel-state-state-store-js
 *
 * MUTATION: _operationRow returned undefined for completedAtMs when an
 * operation was retryable_failed or uncertain. The original two
 * `completedAtMs !== null` assertions stayed GREEN (`state-store tests passed`),
 * because undefined is not null. Both assertions now require the fixture clock
 * value. With status-specific versions of that mutation both go RED:
 *
 *   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
 *   + actual - expected
 *   + undefined
 *   - 1767323045500
 *   at tests/kernel.state/state-store.js:771:12
 *
 * and:
 *
 *   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
 *   + actual - expected
 *   + undefined
 *   - 1767323052502
 *   at tests/kernel.state/state-store.js:818:12
 *
 * The source mutation was restored
 * byte-for-byte (SHA-256 b615db5aafd92de72b350cbff129ff3a28076cf7a325a220fbce740caf364064),
 * and the restored run is GREEN: `state-store tests passed`.
 *
 * NOT-FOUND (1): no assertion-only loop over a possibly empty product result;
 * the migration loop has a fixed two-case literal and asserts its legacy seed.
 * NOT-FOUND (2): no exit-status or truthy process-return assertion.
 * NOT-FOUND (3): no try/catch or optional chain swallows a subject failure;
 * the transaction catch records the error code asserted immediately afterward,
 * and final cleanup preserves the original failure.
 * NOT-FOUND (4): no mock of the state store behavior under test.
 * NOT-FOUND (5): no skip or platform precondition guard.
 * NOT-FOUND (6): no expected value is computed by the subject implementation.
 * PRECONDITION: the default Node 20.20.2 lacks node:sqlite; mutation and green
 * runs used the installed Node 22.22.2, satisfying the documented Node >=22.19
 * runtime requirement.
 */
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

const temporaryRoots = [];
// Set only by the last statement of the run. Lets the cleanup below tell "this
// run passed and then leaked a handle" from "this run was already failing".
let reachedTheEnd = false;
function temporary(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-state-${name}-`));
  temporaryRoots.push(dir);
  return dir;
}

function fixture(name, options = {}) {
  const dir = temporary(name);
  let now = options.now === undefined ? Date.UTC(2026, 0, 2, 3, 4, 5) : options.now;
  let sequence = 0;
  const store = createStateStore({
    file: path.join(dir, 'state.sqlite3'),
    clock: () => now,
    idFactory: prefix => `${prefix}-${++sequence}`,
    ownerId: options.ownerId || 'test-owner',
    busyTimeoutMs: 2000,
    telegramRetention: options.telegramRetention === undefined ? 100 : options.telegramRetention
  });
  return { dir, store, now: () => now, setNow: value => { now = value; }, advance: value => { now += value; } };
}

function expectCode(callback, code) {
  assert.throws(callback, error => {
    assert.ok(error instanceof StateStoreError, `Expected StateStoreError, received ${error && error.constructor && error.constructor.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return fs.readFileSync(file, 'utf8');
}

(async () => {
try {
  // The store is lazy, configures the intended durability pragmas, and creates
  // only STRICT application tables.
  {
    const test = fixture('health');
    const databaseFile = path.join(test.dir, 'state.sqlite3');
    assert.equal(fs.existsSync(databaseFile), false);
    const health = test.store.health();
    assert.equal(fs.existsSync(databaseFile), true);
    assert.deepEqual(health, {
      ok: true,
      path: databaseFile,
      schemaVersion: SCHEMA_VERSION,
      applicationId: APPLICATION_ID,
      journalMode: 'wal',
      synchronous: 2,
      foreignKeys: true,
      busyTimeoutMs: 2000,
      integrity: { ok: true, mode: 'quick', result: ['ok'] }
    });
    assert.deepEqual(test.store.checkIntegrity({ full: true }), { ok: true, mode: 'full', result: ['ok'] });
    const tables = test.store.transaction(db => db.prepare("PRAGMA table_list").all()
      .filter(row => !row.name.startsWith('sqlite_'))
      .map(row => ({ name: row.name, strict: row.strict })));
    assert.ok(tables.length >= 6);
    assert.ok(tables.every(table => table.strict === 1), JSON.stringify(tables));
    assert.equal(test.store.close(), true);
    assert.equal(test.store.close(), false);
    assert.equal(test.store.health().ok, true, 'A closed store can reopen cleanly.');
    test.store.close();
  }

  // Transactions rollback every failed statement group, reject nesting, and
  // reject Promise-returning callbacks before commit.
  {
    const test = fixture('transactions');
    expectCode(() => test.store.transaction(() => test.store.transaction(() => 1)), 'STATE_TRANSACTION_NESTED');
    expectCode(() => test.store.transaction(async () => 1), 'STATE_TRANSACTION_ASYNC');
    let escaped;
    expectCode(() => test.store.transaction(db => {
      assert.equal(db.close, undefined, 'The callback receives a revocable transaction view, not the raw connection.');
      const statement = db.prepare(`INSERT INTO spend_entries(id,spend_date,timestamp_ms,amount_cents,purpose,provider)
        VALUES('escaped','2026-01-02',1,10,'test','manual')`);
      return Promise.resolve().then(() => {
        try { statement.run(); escaped = 'committed'; }
        catch (error) { escaped = error.code; }
      });
    }), 'STATE_TRANSACTION_ASYNC');
    await Promise.resolve();
    assert.equal(escaped, 'STATE_TRANSACTION_CLOSED');
    expectCode(() => test.store.transaction(db => {
      db.prepare(`INSERT INTO spend_entries(id,spend_date,timestamp_ms,amount_cents,purpose,provider)
        VALUES('manual-commit','2026-01-02',1,10,'test','manual')`).run();
      db.exec('/* escape attempt */ COMMIT');
    }), 'STATE_TRANSACTION_CONTROL');
    expectCode(() => test.store.transaction(db => db.prepare('-- hidden\nROLLBACK').run()), 'STATE_TRANSACTION_CONTROL');
    assert.equal(test.store.listSpend().length, 0);
    assert.throws(() => test.store.transaction(db => {
      db.prepare(`INSERT INTO spend_entries(id,spend_date,timestamp_ms,amount_cents,purpose,provider)
        VALUES('rollback','2026-01-02',1,10,'test','manual')`).run();
      throw new Error('intentional');
    }), /intentional/);
    assert.equal(test.store.listSpend().length, 0);
    test.store.close();
  }

  // Spend cap evaluation and insertion are one transaction. References replay
  // exactly once and cannot be rebound to different details.
  {
    const test = fixture('spend');
    assert.deepEqual(test.store.checkSpend({ amountCents: 600, dailyLimitCents: 1000, purpose: 'hosting' }), {
      date: '2026-01-02', currentSpendCents: 0, currentSpendUsd: 0,
      requestedCents: 600, requestedUsd: 6, limitCents: 1000, limitUsd: 10,
      allowed: true, purpose: 'hosting'
    });
    const first = test.store.recordSpend({ amountCents: 600, dailyLimitCents: 1000, purpose: 'hosting', provider: 'stripe', reference: 'invoice-1' });
    assert.equal(first.replayed, false);
    assert.equal(first.entry.amountCents, 600);
    assert.equal(first.entry.amountUsd, 6);
    assert.equal(first.entry.timestamp, '2026-01-02T03:04:05.000Z');
    const replay = test.store.recordSpend({ amountCents: 600, dailyLimitCents: 1000, purpose: 'hosting', provider: 'stripe', reference: 'invoice-1' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.allowed, true, 'A replay consumes no additional budget.');
    assert.equal(replay.entry.id, first.entry.id);
    assert.equal(test.store.listSpend().length, 1);
    expectCode(() => test.store.recordSpend({ amountCents: 601, dailyLimitCents: 1000, purpose: 'hosting', provider: 'stripe', reference: 'invoice-1' }), 'SPEND_REFERENCE_CONFLICT');
    const second = test.store.recordSpend({ amountCents: 400, dailyLimitCents: 1000, purpose: 'storage', provider: 'manual' });
    assert.equal(second.currentSpendCents, 600);
    expectCode(() => test.store.recordSpend({ amountCents: 1, dailyLimitCents: 1000, purpose: 'over' }), 'SPEND_LIMIT_EXCEEDED');
    assert.equal(test.store.listSpend({ date: '2026-01-02' }).length, 2);
    test.advance(24 * 60 * 60 * 1000);
    assert.equal(test.store.checkSpend({ amountCents: 1000, dailyLimitCents: 1000 }).allowed, true);
    assert.equal(test.store.recordSpend({ amountCents: 5000, dailyLimitCents: 0 }).entry.amountUsd, 50, 'zero cap means unlimited');
    expectCode(() => test.store.recordSpend({ amountCents: 1.2, dailyLimitCents: 100 }), 'STATE_INVALID_ARGUMENT');
    test.store.close();
  }

  // Durable memory is namespaced, bounded, revision-aware, and literal-searchable.
  // Stored values and notes cannot become a second plaintext credential store.
  {
    const test = fixture('memory');
    assert.equal(test.store.getMemory({ namespace: 'agent.preferences', key: 'theme' }), null);
    const created = test.store.setMemory({
      namespace: 'agent.preferences', key: 'theme', value: { mode: 'dark', contrast: 'high' },
      note: 'Use a dark high-contrast interface.', tags: ['preference', 'ux'], expectedRevision: 0
    });
    assert.equal(created.created, true);
    assert.equal(created.replayed, false);
    assert.equal(created.entry.revision, 1);
    assert.deepEqual(test.store.getMemory({ namespace: 'agent.preferences', key: 'theme' }), created.entry);

    const replay = test.store.setMemory({
      namespace: 'agent.preferences', key: 'theme', value: { contrast: 'high', mode: 'dark' },
      note: 'Use a dark high-contrast interface.', tags: ['preference', 'ux'], expectedRevision: 1
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.entry.revision, 1);
    expectCode(() => test.store.setMemory({
      namespace: 'agent.preferences', key: 'theme', value: 'light', expectedRevision: 0
    }), 'MEMORY_REVISION_CONFLICT');

    const updated = test.store.setMemory({
      namespace: 'agent.preferences', key: 'theme', value: 'light', note: 'Prefer readable light mode.',
      tags: ['preference'], expectedRevision: 1
    });
    assert.equal(updated.created, false);
    assert.equal(updated.entry.revision, 2);
    assert.equal(test.store.searchMemory({ query: 'readable' }).length, 1);
    assert.equal(test.store.searchMemory({ query: 'preference', namespace: 'agent.preferences' })[0].key, 'theme');

    test.store.setMemory({ namespace: 'agent.metrics', key: 'coverage', value: '100% verified', tags: ['test'] });
    assert.deepEqual(test.store.searchMemory({ query: '%' }).map(entry => entry.key), ['coverage'],
      'Search treats SQL wildcard characters as literal user input.');
    expectCode(() => test.store.searchMemory({ query: '   ' }), 'STATE_INVALID_ARGUMENT');
    expectCode(() => test.store.setMemory({ namespace: 'agent.preferences', key: 'duplicate-tags', value: true, tags: ['ux', 'ux'] }), 'MEMORY_TAGS_INVALID');
    expectCode(() => test.store.setMemory({
      namespace: 'agent.preferences', key: 'credential', value: { accessToken: 'must-not-persist' }
    }), 'MEMORY_SECRET_REJECTED');
    expectCode(() => test.store.setMemory({
      namespace: 'agent.preferences', key: 'fine-grained-pat', value: `github_pat_${'a'.repeat(82)}`
    }), 'MEMORY_SECRET_REJECTED');
    expectCode(() => test.store.setMemory({
      namespace: 'agent.preferences', key: 'oversized', value: 'x'.repeat((32 * 1024) + 1)
    }), 'MEMORY_VALUE_TOO_LARGE');
    test.store.close();
  }

  // Approval grants are opaque, input-bound, single-use, and expire durably.
  {
    const test = fixture('approval-grants');
    const action = 'github.issue_create';
    const inputHash = hashInput({ action, arguments: { owner: 'acme', repo: 'widgets', title: 'Safe issue' } });
    const tokenHash = hashInput({ approvalToken: 'token-a' });
    const created = test.store.createApprovalGrant({
      id: 'approval-fixture-a', action, inputHash, tokenHash, expiresAtMs: test.now() + 60_000
    });
    assert.equal(created.status, 'approved');
    assert.equal(created.approvalId, 'approval-fixture-a');
    assert.equal(Object.hasOwn(created, 'tokenHash'), false);
    const consumed = test.store.consumeApprovalGrant({ action, inputHash, tokenHash });
    assert.equal(consumed.status, 'consumed');
    /* `consumed.consumedAtMs !== null` was true for `undefined` too.
     *
     * Deleting the consumedAtMs mapping from _approvalGrantRow made every approval
     * grant lose its millisecond timestamp, and this assertion passed, because
     * `undefined !== null`. It also passed for 0, NaN, -1 and a wrong timestamp: it
     * asserted the object was still an object, not that the field was there. The
     * field appears exactly once in src/ and once in tests/, so nothing else
     * covered it. Assert the WHOLE record instead, which also names a field that
     * is added, renamed, or silently changed -- including tokenHash, which must
     * never come back out. */
    assert.deepStrictEqual(consumed, {
      approvalId: 'approval-fixture-a',
      action,
      inputHash,
      status: 'consumed',
      createdAt: new Date(test.now()).toISOString(),
      createdAtMs: test.now(),
      expiresAt: new Date(test.now() + 60_000).toISOString(),
      expiresAtMs: test.now() + 60_000,
      consumedAt: new Date(test.now()).toISOString(),
      consumedAtMs: test.now()
    }, 'the consumed grant must carry every field, with the exact consumption timestamp');
    expectCode(() => test.store.consumeApprovalGrant({ action, inputHash, tokenHash }), 'APPROVAL_ALREADY_USED');

    const secondHash = hashInput({ approvalToken: 'token-b' });
    test.store.createApprovalGrant({
      id: 'approval-fixture-b', action, inputHash, tokenHash: secondHash, expiresAtMs: test.now() + 60_000
    });
    expectCode(() => test.store.consumeApprovalGrant({
      action: 'github.issue_create', inputHash: hashInput({ action, arguments: { owner: 'other' } }), tokenHash: secondHash
    }), 'APPROVAL_BINDING_MISMATCH');
    test.advance(60_001);
    expectCode(() => test.store.consumeApprovalGrant({ action, inputHash, tokenHash: secondHash }), 'APPROVAL_EXPIRED');
    expectCode(() => test.store.createApprovalGrant({
      id: 'approval-fixture-expired', action, inputHash, tokenHash: hashInput({ approvalToken: 'token-c' }), expiresAtMs: test.now()
    }), 'APPROVAL_EXPIRY_INVALID');
    test.store.close();
  }

// A DATABASE OLDER THAN 23 HAS THE THREE telegram_* TABLES. MIGRATION_V1 created
// them and MIGRATION_V23 (2026-08-23, the Telegram connector removal) drops them.
//
// The legacy fixtures below fabricate an old database by taking a CURRENT one and
// stamping an old user_version onto it. That current one has already been migrated
// past 23, so it no longer has these tables -- which makes the fabricated "v4"
// database one that could never have existed, and _validateSchema is right to
// refuse it. Each fixture therefore puts back what V23 took away, immediately
// before the PRAGMA that sets the old version.
//
// The DDL is byte-identical to SCHEMA_V1's, including the two singleton INSERTs
// that _validateSchema's cursor and poll-lease invariants check. It does not need
// to be trusted: a single character of drift changes the DDL fingerprint and the
// reopen below fails loudly rather than passing on a database that lies about its
// own shape.
// A database at any version from 10 to 23 carried the durable-mission tables under the
// pre-rename prefix (MIGRATION_V24 renames them). A downgrade fixture that stamps one of
// those versions has to put the old names -- and the old index names -- back, or the
// ladder's fingerprint for that version describes a database that never existed.
const RESTORE_LEGACY_MISSION_NAMES = `
    ALTER TABLE coordinator_missions RENAME TO jarvis_missions;
    ALTER TABLE coordinator_phase_states RENAME TO jarvis_phase_states;
    ALTER TABLE coordinator_workflow_missions RENAME TO jarvis_workflow_missions;
    ALTER TABLE coordinator_broker_verifications RENAME TO jarvis_broker_verifications;
    ALTER TABLE coordinator_workflow_events RENAME TO jarvis_workflow_events;
    ALTER TABLE coordinator_workflow_outbox RENAME TO jarvis_workflow_outbox;
    ALTER TABLE coordinator_workflow_acceptances RENAME TO jarvis_workflow_acceptances;
    DROP INDEX IF EXISTS coordinator_missions_updated_idx;
    CREATE INDEX jarvis_missions_updated_idx ON jarvis_missions(updated_at_ms DESC, run_id);
    DROP INDEX IF EXISTS coordinator_phase_states_run_idx;
    CREATE INDEX jarvis_phase_states_run_idx ON jarvis_phase_states(run_id, updated_at_ms DESC, actor);
    DROP INDEX IF EXISTS coordinator_workflow_missions_task_idx;
    CREATE INDEX jarvis_workflow_missions_task_idx ON jarvis_workflow_missions(task_id, updated_at_ms DESC);
    DROP INDEX IF EXISTS coordinator_workflow_outbox_delivery_idx;
    CREATE INDEX jarvis_workflow_outbox_delivery_idx ON jarvis_workflow_outbox(run_id, status, created_at_ms, outbox_id);
`;
const RESTORE_TELEGRAM_TABLES_V1 = `
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
`;

  // Schema 4 databases migrate additively through memory, approval grants, and remote asks.
  {
    const test = fixture('memory-migration');
    test.store.health();
    test.store.transaction(db => db.exec('DROP TABLE scoped_approval_events; DROP TABLE scoped_approval_grants; DROP TABLE scoped_approval_actions; DROP TABLE scoped_approval_provenance; DROP TABLE policy_dispatch_consumptions; DROP TABLE policy_dispatch_authorizations; DROP TABLE capability_profile_revocations; DROP TABLE capability_profile_requests; DROP TABLE capability_profile_bindings; DROP TABLE capability_profile_versions; DROP TABLE coordinator_workflow_acceptances; DROP TABLE coordinator_workflow_outbox; DROP TABLE coordinator_workflow_events; DROP TABLE coordinator_broker_verifications; DROP TABLE coordinator_workflow_missions; DROP TABLE coordinator_phase_states; DROP TABLE coordinator_missions; DROP TABLE tavily_usage_monthly; DROP TABLE model_usage_daily; DROP TABLE remote_asks; DROP TABLE approval_grants; DROP TABLE memory_entries; DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects; ' + RESTORE_TELEGRAM_TABLES_V1 + 'PRAGMA user_version = 4;'));
    test.store.transaction(db => db.exec(''));
    test.store.close();
    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3'), clock: () => test.now() });
    assert.equal(migrated.health().schemaVersion, SCHEMA_VERSION);
    assert.equal(migrated.getMemory({ namespace: 'agent.preferences', key: 'theme' }), null);
    migrated.close();
  }

  // Schema 5 databases gain approval grants and remote asks without rewriting memory.
  {
    const test = fixture('approval-migration');
    test.store.setMemory({ namespace: 'agent.preferences', key: 'theme', value: 'dark' });
    test.store.transaction(db => db.exec('DROP TABLE scoped_approval_events; DROP TABLE scoped_approval_grants; DROP TABLE scoped_approval_actions; DROP TABLE scoped_approval_provenance; DROP TABLE policy_dispatch_consumptions; DROP TABLE policy_dispatch_authorizations; DROP TABLE capability_profile_revocations; DROP TABLE capability_profile_requests; DROP TABLE capability_profile_bindings; DROP TABLE capability_profile_versions; DROP TABLE coordinator_workflow_acceptances; DROP TABLE coordinator_workflow_outbox; DROP TABLE coordinator_workflow_events; DROP TABLE coordinator_broker_verifications; DROP TABLE coordinator_workflow_missions; DROP TABLE coordinator_phase_states; DROP TABLE coordinator_missions; DROP TABLE tavily_usage_monthly; DROP TABLE model_usage_daily; DROP TABLE remote_asks; DROP TABLE approval_grants; DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects; ' + RESTORE_TELEGRAM_TABLES_V1 + 'PRAGMA user_version = 5;'));
    test.store.transaction(db => db.exec(''));
    test.store.close();
    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3') });
    assert.equal(migrated.health().schemaVersion, SCHEMA_VERSION);
    assert.equal(migrated.getMemory({ namespace: 'agent.preferences', key: 'theme' }).value, 'dark');
    migrated.close();
  }

  // Schema 6 databases gain remote-ask routing state without rewriting approvals.
  {
    const test = fixture('remote-ask-migration');
    const action = 'github.issue_create';
    test.store.createApprovalGrant({
      id: 'approval-remote-migration', action, inputHash: hashInput({ action }), tokenHash: hashInput({ token: 'remote-migration' }),
      expiresAtMs: test.now() + 60_000
    });
    test.store.transaction(db => db.exec('DROP TABLE scoped_approval_events; DROP TABLE scoped_approval_grants; DROP TABLE scoped_approval_actions; DROP TABLE scoped_approval_provenance; DROP TABLE policy_dispatch_consumptions; DROP TABLE policy_dispatch_authorizations; DROP TABLE capability_profile_revocations; DROP TABLE capability_profile_requests; DROP TABLE capability_profile_bindings; DROP TABLE capability_profile_versions; DROP TABLE coordinator_workflow_acceptances; DROP TABLE coordinator_workflow_outbox; DROP TABLE coordinator_workflow_events; DROP TABLE coordinator_broker_verifications; DROP TABLE coordinator_workflow_missions; DROP TABLE coordinator_phase_states; DROP TABLE coordinator_missions; DROP TABLE tavily_usage_monthly; DROP TABLE model_usage_daily; DROP TABLE remote_asks; DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects; ' + RESTORE_TELEGRAM_TABLES_V1 + 'PRAGMA user_version = 6;'));
    test.store.transaction(db => db.exec(''));
    test.store.close();
    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3'), clock: () => test.now() });
    assert.equal(migrated.health().schemaVersion, SCHEMA_VERSION);
    assert.equal(migrated.consumeApprovalGrant({ action, inputHash: hashInput({ action }), tokenHash: hashInput({ token: 'remote-migration' }) }).status, 'consumed');
    migrated.close();
  }

  // Schema 7 databases gain the aggregate-only local-model token ledger
  // without rewriting remote-ask state.
  {
    const test = fixture('model-usage-migration');
    const callbackHash = value => require('node:crypto').createHash('sha256').update(value, 'utf8').digest('hex');
    test.store.createRemoteAsk({
      id: 'remote-ask-model-ledger', yesCallbackHash: callbackHash('yes-model-ledger'), noCallbackHash: callbackHash('no-model-ledger'),
      chatId: '123', expiresAtMs: test.now() + 60_000
    });
    test.store.transaction(db => db.exec('DROP TABLE scoped_approval_events; DROP TABLE scoped_approval_grants; DROP TABLE scoped_approval_actions; DROP TABLE scoped_approval_provenance; DROP TABLE policy_dispatch_consumptions; DROP TABLE policy_dispatch_authorizations; DROP TABLE capability_profile_revocations; DROP TABLE capability_profile_requests; DROP TABLE capability_profile_bindings; DROP TABLE capability_profile_versions; DROP TABLE coordinator_workflow_acceptances; DROP TABLE coordinator_workflow_outbox; DROP TABLE coordinator_workflow_events; DROP TABLE coordinator_broker_verifications; DROP TABLE coordinator_workflow_missions; DROP TABLE coordinator_phase_states; DROP TABLE coordinator_missions; DROP TABLE tavily_usage_monthly; DROP TABLE model_usage_daily; DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects; ' + RESTORE_TELEGRAM_TABLES_V1 + 'PRAGMA user_version = 7;'));
    test.store.transaction(db => db.exec(''));
    test.store.close();
    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3'), clock: () => test.now() });
    assert.equal(migrated.health().schemaVersion, SCHEMA_VERSION);
    assert.equal(migrated.getRemoteAsk({ id: 'remote-ask-model-ledger' }).status, 'pending');
    assert.deepEqual(migrated.listModelUsage(), []);
    migrated.close();
  }

  // Schema 8 databases gain the Tavily budget ledger without rewriting model usage.
  {
    const test = fixture('tavily-budget-migration');
    test.store.recordModelUsage({ model: 'qwen3.5:4b', promptTokens: 12, evalTokens: 7 });
    test.store.transaction(db => db.exec('DROP TABLE scoped_approval_events; DROP TABLE scoped_approval_grants; DROP TABLE scoped_approval_actions; DROP TABLE scoped_approval_provenance; DROP TABLE policy_dispatch_consumptions; DROP TABLE policy_dispatch_authorizations; DROP TABLE capability_profile_revocations; DROP TABLE capability_profile_requests; DROP TABLE capability_profile_bindings; DROP TABLE capability_profile_versions; DROP TABLE coordinator_workflow_acceptances; DROP TABLE coordinator_workflow_outbox; DROP TABLE coordinator_workflow_events; DROP TABLE coordinator_broker_verifications; DROP TABLE coordinator_workflow_missions; DROP TABLE coordinator_phase_states; DROP TABLE coordinator_missions; DROP TABLE tavily_usage_monthly; DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects; ' + RESTORE_TELEGRAM_TABLES_V1 + 'PRAGMA user_version = 8;'));
    test.store.transaction(db => db.exec(''));
    test.store.close();
    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3'), clock: () => test.now() });
    assert.equal(migrated.health().schemaVersion, SCHEMA_VERSION);
    assert.equal(migrated.listModelUsage().length, 1);
    migrated.close();
  }

  // Schema 9 databases gain coordinator mission/phase state without rewriting the
  // existing aggregate usage ledgers.
  {
    const test = fixture('coordinator-mission-migration');
    test.store.recordModelUsage({ model: 'qwen3.5:4b', promptTokens: 12, evalTokens: 7 });
    test.store.transaction(db => db.exec('DROP TABLE scoped_approval_events; DROP TABLE scoped_approval_grants; DROP TABLE scoped_approval_actions; DROP TABLE scoped_approval_provenance; DROP TABLE policy_dispatch_consumptions; DROP TABLE policy_dispatch_authorizations; DROP TABLE capability_profile_revocations; DROP TABLE capability_profile_requests; DROP TABLE capability_profile_bindings; DROP TABLE capability_profile_versions; DROP TABLE coordinator_workflow_acceptances; DROP TABLE coordinator_workflow_outbox; DROP TABLE coordinator_workflow_events; DROP TABLE coordinator_broker_verifications; DROP TABLE coordinator_workflow_missions; DROP TABLE coordinator_phase_states; DROP TABLE coordinator_missions; DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects; ' + RESTORE_TELEGRAM_TABLES_V1 + 'PRAGMA user_version = 9;'));
    test.store.transaction(db => db.exec(''));
    test.store.close();
    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3'), clock: () => test.now() });
    assert.equal(migrated.health().schemaVersion, SCHEMA_VERSION);
    assert.equal(migrated.listModelUsage().length, 1);
    assert.deepEqual(migrated.getCoordinatorPhaseStates({ runId: 'run-00000000000000000000000000000000' }), []);
    migrated.close();
  }

  // THE CERBERUS CORRECTION STORAGE IS GONE, AND A DATABASE THAT ALREADY HAS IT LOSES IT.
  //
  // This block asserted the exact opposite until 2026-08-11: that migrating created the five
  // cerberus_correction_* tables. The owner stated that the Cerberus system is not part of
  // this product and believed it had already been removed. MIGRATION_V20 removes it, and this
  // is the test that keeps it removed -- re-adding the tables to the migration chain fails
  // here by name.
  //
  // TWO DATABASES, BECAUSE THEY COULD FAIL DIFFERENTLY. The v16 one never had the tables and
  // proves the chain no longer creates them. The v19 one is seeded with the exact historical
  // DDL, so it genuinely carries all five tables and all ten immutability triggers, and it
  // proves MIGRATION_V20 clears them from an installation that already exists -- the only
  // case that could have left them on a real machine. Asserting only the fresh path would
  // pass while every existing database kept its tables forever.
  //
  // TRIGGERS ARE CHECKED SEPARATELY FROM TABLES ON PURPOSE. Dropping a table drops its
  // triggers, so a table-only assertion cannot tell a real drop from a rename, and a trigger
  // left behind referencing a missing table is a schema this store would refuse to open.
  const LEGACY_CERBERUS_DDL = `
    CREATE TABLE cerberus_correction_closures (
      closure_family_id TEXT PRIMARY KEY CHECK(length(closure_family_id) = 64 AND closure_family_id NOT GLOB '*[^0-9a-f]*'),
      source_run_id TEXT NOT NULL UNIQUE CHECK(length(source_run_id) = 36 AND source_run_id GLOB 'run-[0-9a-f]*'),
      source_task_id TEXT NOT NULL UNIQUE CHECK(length(source_task_id) BETWEEN 1 AND 500),
      mission_hash TEXT NOT NULL CHECK(length(mission_hash) = 64 AND mission_hash NOT GLOB '*[^0-9a-f]*'),
      owner_revision INTEGER NOT NULL CHECK(owner_revision >= 1),
      closure_ref_hash TEXT NOT NULL UNIQUE CHECK(length(closure_ref_hash) = 64 AND closure_ref_hash NOT GLOB '*[^0-9a-f]*'),
      acceptance_ref_hash TEXT NOT NULL UNIQUE CHECK(length(acceptance_ref_hash) = 64 AND acceptance_ref_hash NOT GLOB '*[^0-9a-f]*'),
      issuer TEXT NOT NULL CHECK(issuer = 'toolsenabled-broker-v1'),
      purpose TEXT NOT NULL CHECK(purpose = 'correction-closure-observation'),
      acceptance_scope TEXT NOT NULL CHECK(acceptance_scope = 'correction-closure-proof'),
      catalog_digest TEXT NOT NULL CHECK(length(catalog_digest) = 64 AND catalog_digest NOT GLOB '*[^0-9a-f]*'),
      status TEXT NOT NULL CHECK(status = 'resolved'),
      FOREIGN KEY(source_run_id) REFERENCES jarvis_workflow_missions(run_id) ON DELETE RESTRICT,
      FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE cerberus_correction_evidence (
      evidence_id TEXT PRIMARY KEY CHECK(length(evidence_id) = 64 AND evidence_id NOT GLOB '*[^0-9a-f]*'),
      closure_family_id TEXT NOT NULL CHECK(length(closure_family_id) = 64 AND closure_family_id NOT GLOB '*[^0-9a-f]*'),
      source_run_id TEXT NOT NULL CHECK(length(source_run_id) = 36 AND source_run_id GLOB 'run-[0-9a-f]*'),
      task_fence INTEGER NOT NULL CHECK(task_fence >= 1),
      owner_revision INTEGER NOT NULL CHECK(owner_revision >= 1),
      catalog_digest TEXT NOT NULL CHECK(length(catalog_digest) = 64 AND catalog_digest NOT GLOB '*[^0-9a-f]*'),
      broker_epoch_digest TEXT NOT NULL CHECK(length(broker_epoch_digest) = 64 AND broker_epoch_digest NOT GLOB '*[^0-9a-f]*'),
      resolver_policy_digest TEXT NOT NULL CHECK(length(resolver_policy_digest) = 64 AND resolver_policy_digest NOT GLOB '*[^0-9a-f]*'),
      verifier_catalog_digest TEXT NOT NULL CHECK(length(verifier_catalog_digest) = 64 AND verifier_catalog_digest NOT GLOB '*[^0-9a-f]*'),
      verifier_entry_digest TEXT NOT NULL CHECK(length(verifier_entry_digest) = 64 AND verifier_entry_digest NOT GLOB '*[^0-9a-f]*'),
      taxonomy_catalog_digest TEXT NOT NULL CHECK(length(taxonomy_catalog_digest) = 64 AND taxonomy_catalog_digest NOT GLOB '*[^0-9a-f]*'),
      projection_policy_digest TEXT NOT NULL CHECK(length(projection_policy_digest) = 64 AND projection_policy_digest NOT GLOB '*[^0-9a-f]*'),
      source_clearance_digest TEXT NOT NULL CHECK(length(source_clearance_digest) = 64 AND source_clearance_digest NOT GLOB '*[^0-9a-f]*'),
      audit_head_sequence INTEGER NOT NULL CHECK(audit_head_sequence >= 0),
      audit_head_hash TEXT NOT NULL CHECK(length(audit_head_hash) = 64 AND audit_head_hash NOT GLOB '*[^0-9a-f]*'),
      arbiter_epoch INTEGER NOT NULL CHECK(arbiter_epoch = 1),
      arbiter_epoch_digest TEXT NOT NULL CHECK(length(arbiter_epoch_digest) = 64 AND arbiter_epoch_digest NOT GLOB '*[^0-9a-f]*'),
      status TEXT NOT NULL CHECK(status = 'resolved'),
      UNIQUE(source_run_id, task_fence, catalog_digest),
      FOREIGN KEY(closure_family_id) REFERENCES cerberus_correction_closures(closure_family_id) ON DELETE RESTRICT,
      FOREIGN KEY(source_run_id) REFERENCES jarvis_workflow_missions(run_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE cerberus_correction_handle_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      closure_family_id TEXT NOT NULL CHECK(length(closure_family_id) = 64 AND closure_family_id NOT GLOB '*[^0-9a-f]*'),
      evidence_id TEXT NOT NULL CHECK(length(evidence_id) = 64 AND evidence_id NOT GLOB '*[^0-9a-f]*'),
      event_type TEXT NOT NULL CHECK(event_type IN ('issued', 'revoked', 'superseded')),
      reason_code TEXT CHECK(reason_code IS NULL OR (length(reason_code) BETWEEN 3 AND 80 AND reason_code NOT GLOB '*[^a-z0-9._-]*')),
      FOREIGN KEY(closure_family_id) REFERENCES cerberus_correction_closures(closure_family_id) ON DELETE RESTRICT,
      FOREIGN KEY(evidence_id) REFERENCES cerberus_correction_evidence(evidence_id) ON DELETE RESTRICT,
      CHECK((event_type = 'issued' AND reason_code IS NULL) OR (event_type IN ('revoked', 'superseded') AND reason_code IS NOT NULL))
    ) STRICT;

    CREATE TABLE cerberus_correction_episodes (
      evidence_id TEXT PRIMARY KEY CHECK(length(evidence_id) = 64 AND evidence_id NOT GLOB '*[^0-9a-f]*'),
      episode_json TEXT NOT NULL CHECK(json_valid(episode_json) AND length(CAST(episode_json AS BLOB)) BETWEEN 2 AND 2048),
      task_class TEXT NOT NULL CHECK(task_class = 'broker-authoritative-workflow'),
      taxonomy TEXT NOT NULL CHECK(taxonomy = 'broker-verified-fault-fix'),
      check_intent TEXT NOT NULL CHECK(check_intent = 'run-current-isolated-adversarial-verifier'),
      current_verifier_required INTEGER NOT NULL CHECK(current_verifier_required = 1),
      training_state TEXT NOT NULL CHECK(training_state = 'quarantined-not-admitted'),
      authority_effect TEXT NOT NULL CHECK(authority_effect = 'none'),
      FOREIGN KEY(evidence_id) REFERENCES cerberus_correction_evidence(evidence_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TRIGGER cerberus_correction_closures_no_update BEFORE UPDATE ON cerberus_correction_closures
      BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction closure'); END;
    CREATE TRIGGER cerberus_correction_closures_no_delete BEFORE DELETE ON cerberus_correction_closures
      BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction closure'); END;
    CREATE TRIGGER cerberus_correction_evidence_no_update BEFORE UPDATE ON cerberus_correction_evidence
      BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction evidence'); END;
    CREATE TRIGGER cerberus_correction_evidence_no_delete BEFORE DELETE ON cerberus_correction_evidence
      BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction evidence'); END;
    CREATE TRIGGER cerberus_correction_handle_events_no_update BEFORE UPDATE ON cerberus_correction_handle_events
      BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction handle event'); END;
    CREATE TRIGGER cerberus_correction_handle_events_no_delete BEFORE DELETE ON cerberus_correction_handle_events
      BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction handle event'); END;
    CREATE TRIGGER cerberus_correction_episodes_no_update BEFORE UPDATE ON cerberus_correction_episodes
      BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction episode'); END;
    CREATE TRIGGER cerberus_correction_episodes_no_delete BEFORE DELETE ON cerberus_correction_episodes
      BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction episode'); END;

    CREATE TABLE cerberus_correction_acceptance_bindings (
      evidence_id TEXT PRIMARY KEY CHECK(length(evidence_id) = 64 AND evidence_id NOT GLOB '*[^0-9a-f]*'),
      closure_family_id TEXT NOT NULL UNIQUE CHECK(length(closure_family_id) = 64 AND closure_family_id NOT GLOB '*[^0-9a-f]*'),
      source_run_id TEXT NOT NULL UNIQUE CHECK(length(source_run_id) = 36 AND source_run_id GLOB 'run-[0-9a-f]*'),
      source_task_id TEXT NOT NULL UNIQUE CHECK(length(source_task_id) BETWEEN 1 AND 500),
      acceptance_hash TEXT NOT NULL CHECK(length(acceptance_hash) = 64 AND acceptance_hash NOT GLOB '*[^0-9a-f]*'),
      event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 3 AND 160 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      event_hash TEXT NOT NULL CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
      baseline_record_hash TEXT NOT NULL CHECK(length(baseline_record_hash) = 64 AND baseline_record_hash NOT GLOB '*[^0-9a-f]*'),
      candidate_record_hash TEXT NOT NULL CHECK(length(candidate_record_hash) = 64 AND candidate_record_hash NOT GLOB '*[^0-9a-f]*'),
      bound_at_ms INTEGER NOT NULL CHECK(bound_at_ms >= 0),
      FOREIGN KEY(evidence_id) REFERENCES cerberus_correction_evidence(evidence_id) ON DELETE RESTRICT,
      FOREIGN KEY(closure_family_id) REFERENCES cerberus_correction_closures(closure_family_id) ON DELETE RESTRICT,
      FOREIGN KEY(source_run_id) REFERENCES jarvis_workflow_acceptances(run_id) ON DELETE RESTRICT,
      FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY(event_id) REFERENCES jarvis_workflow_events(event_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TRIGGER cerberus_correction_acceptance_bindings_no_update BEFORE UPDATE ON cerberus_correction_acceptance_bindings
      BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction acceptance binding'); END;
    CREATE TRIGGER cerberus_correction_acceptance_bindings_no_delete BEFORE DELETE ON cerberus_correction_acceptance_bindings
      BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction acceptance binding'); END;
  `;
  // MIGRATION_V19's tables, verbatim, for the same reason the Cerberus DDL above is here:
  // a database that claims user_version 19 has to actually look like one. V22 drops these,
  // so a store created by THIS build no longer carries them and the fake legacy database
  // has to put them back before it can be recognised as a 19 and upgraded past it.
  const LEGACY_DISCORD_DDL = `
    CREATE TABLE discord_gateway_state (
      provider TEXT PRIMARY KEY CHECK(provider = 'discord'),
      session_id TEXT CHECK(session_id IS NULL OR length(session_id) BETWEEN 1 AND 256),
      resume_gateway_url TEXT CHECK(resume_gateway_url IS NULL OR length(resume_gateway_url) BETWEEN 6 AND 2048),
      sequence INTEGER CHECK(sequence IS NULL OR sequence >= 0),
      status TEXT NOT NULL CHECK(status IN ('idle','connecting','ready','resuming','reconnecting','error')),
      last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 100),
      last_event_at_ms INTEGER CHECK(last_event_at_ms IS NULL OR last_event_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
      CHECK((session_id IS NULL AND resume_gateway_url IS NULL AND sequence IS NULL) OR
            (session_id IS NOT NULL AND resume_gateway_url IS NOT NULL AND sequence IS NOT NULL))
    ) STRICT;
    INSERT INTO discord_gateway_state(provider, session_id, resume_gateway_url, sequence, status, last_error_code, last_event_at_ms, updated_at_ms)
      VALUES('discord', NULL, NULL, NULL, 'idle', NULL, NULL, 0);

    CREATE TABLE discord_gateway_lease (
      provider TEXT PRIMARY KEY CHECK(provider = 'discord'),
      owner_id TEXT CHECK(owner_id IS NULL OR length(owner_id) BETWEEN 1 AND 200),
      token_hash TEXT CHECK(token_hash IS NULL OR length(token_hash) = 64),
      fence INTEGER NOT NULL CHECK(fence >= 0),
      expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
      CHECK((owner_id IS NULL AND token_hash IS NULL AND expires_at_ms IS NULL) OR
            (owner_id IS NOT NULL AND token_hash IS NOT NULL AND expires_at_ms IS NOT NULL))
    ) STRICT;
    INSERT INTO discord_gateway_lease(provider, owner_id, token_hash, fence, expires_at_ms, updated_at_ms)
      VALUES('discord', NULL, NULL, 0, NULL, 0);

    CREATE TABLE discord_command_events (
      event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 17 AND 20 AND event_id NOT GLOB '*[^0-9]*' AND substr(event_id, 1, 1) <> '0'),
      gateway_sequence INTEGER NOT NULL CHECK(gateway_sequence >= 0),
      channel_id TEXT NOT NULL CHECK(length(channel_id) BETWEEN 17 AND 20 AND channel_id NOT GLOB '*[^0-9]*' AND substr(channel_id, 1, 1) <> '0'),
      owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 17 AND 20 AND owner_user_id NOT GLOB '*[^0-9]*' AND substr(owner_user_id, 1, 1) <> '0'),
      content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
      event_hash TEXT NOT NULL CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
      received_at_ms INTEGER NOT NULL CHECK(received_at_ms >= 0)
    ) STRICT;
    CREATE INDEX discord_command_events_received_idx ON discord_command_events(received_at_ms, event_id);
  `;
  for (const [name, statements, seedLegacy] of [
    ['cerberus-removed-from-v16', RESTORE_LEGACY_MISSION_NAMES + 'DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects; ' + RESTORE_TELEGRAM_TABLES_V1 + 'PRAGMA user_version = 16;', false],
    ['cerberus-removed-from-v19-legacy', RESTORE_LEGACY_MISSION_NAMES + 'DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects; ' + RESTORE_TELEGRAM_TABLES_V1 + 'PRAGMA user_version = 19;', true]
  ]) {
    const test = fixture(name);
    test.store.health();
    // Unrelated durable data recorded BEFORE the downgrade, so the assertions below
    // distinguish "the correction tables were dropped" from "the database was rebuilt".
    test.store.recordSpend({ amountCents: 42, dailyLimitCents: 1000, purpose: 'preserve', provider: 'fixture', reference: name });
    test.store.transaction(db => {
      if (seedLegacy) db.exec(`${LEGACY_CERBERUS_DDL}
${LEGACY_DISCORD_DDL}`);
      db.exec(statements);
    });
    if (seedLegacy) {
      // The seed has to be real, or this case proves nothing. A silent no-op here would
      // make the drop below vacuous and the test would still pass.
      const seeded = test.store.transaction(db => db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'cerberus_correction_%'"
      ).get().count);
      assert.equal(seeded, 15, 'legacy seed must create five tables and ten triggers');
      const seededDiscord = test.store.transaction(db => db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'discord_%'"
      ).get().count);
      assert.equal(seededDiscord, 4, 'legacy seed must create the three V19 discord tables and their index');
    }
    test.store.close();
    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3'), clock: () => test.now() });
    assert.equal(migrated.health().schemaVersion, SCHEMA_VERSION);
    const residue = migrated.transaction(db => db.prepare(
      "SELECT type, name FROM sqlite_schema WHERE name LIKE 'cerberus_correction_%' OR sql LIKE '%cerberus_correction_%' ORDER BY type, name"
    ).all());
    assert.deepEqual(residue, [], `${name}: no cerberus correction table, trigger or index may survive migration`);
    // V22, the same shape of assertion for the Discord connector storage. Agent comms is a
    // different system with no table here, so nothing in this query can reach it.
    const discordResidue = migrated.transaction(db => db.prepare(
      "SELECT type, name FROM sqlite_schema WHERE name LIKE 'discord_%' OR sql LIKE '%discord_%' ORDER BY type, name"
    ).all());
    assert.deepEqual(discordResidue, [], `${name}: no discord connector table or index may survive migration`);
    assert.equal(migrated.transaction(db => db.prepare("SELECT COUNT(*) AS count FROM spend_entries WHERE reference = ?").get(name).count), 1,
      `${name}: unrelated durable rows must survive the removal`);
    migrated.close();
  }

  // The model ledger stores only per-day aggregate provider counters. It never
  // has a prompt/output argument or column, so model content cannot persist in
  // transactional state accidentally.
  {
    const test = fixture('model-usage');
    const first = test.store.recordModelUsage({ model: 'qwen3.5:4b', promptTokens: 12, evalTokens: 7 });
    assert.deepEqual(first, {
      date: '2026-01-02', model: 'qwen3.5:4b', promptTokens: 12, evalTokens: 7, calls: 1,
      updatedAtMs: test.now(), updatedAt: '2026-01-02T03:04:05.000Z'
    });
    const aggregate = test.store.recordModelUsage({ model: 'qwen3.5:4b', promptTokens: 3, evalTokens: 9 });
    assert.equal(aggregate.promptTokens, 15);
    assert.equal(aggregate.evalTokens, 16);
    assert.equal(aggregate.calls, 2);
    test.store.recordModelUsage({ model: 'qwen3.5:9b', promptTokens: 2, evalTokens: 1 });
    assert.deepEqual(test.store.listModelUsage({ date: '2026-01-02' }).map(row => row.model), ['qwen3.5:4b', 'qwen3.5:9b']);
    assert.deepEqual(test.store.transaction(db => Object.keys(db.prepare('SELECT * FROM model_usage_daily LIMIT 1').get()).sort()),
      ['calls', 'eval_tokens', 'model', 'prompt_tokens', 'updated_at_ms', 'usage_date']);
    test.advance(24 * 60 * 60 * 1000);
    assert.equal(test.store.recordModelUsage({ model: 'qwen3.5:4b', promptTokens: 1, evalTokens: 2 }).calls, 1);
    assert.equal(test.store.listModelUsage({ model: 'qwen3.5:4b' }).length, 2);
    expectCode(() => test.store.recordModelUsage({ model: 'qwen/unsafe', promptTokens: 1, evalTokens: 1 }), 'STATE_INVALID_ARGUMENT');
    expectCode(() => test.store.recordModelUsage({ model: 'qwen3.5:4b', promptTokens: -1, evalTokens: 1 }), 'STATE_INVALID_ARGUMENT');
    test.store.close();
  }

  // Remote asks retain only callback hashes, resolve atomically from the shared
  // Telegram update stream, and cannot be replayed or resolved by another chat.
  {
    const test = fixture('remote-asks');
    const callbackHash = value => require('node:crypto').createHash('sha256').update(value, 'utf8').digest('hex');
    const yesData = 'te:a:remote-ask-001:y';
    const noData = 'te:a:remote-ask-001:n';
    const created = test.store.createRemoteAsk({
      id: 'remote-ask-00000001', yesCallbackHash: callbackHash(yesData), noCallbackHash: callbackHash(noData),
      chatId: '123', expiresAtMs: test.now() + 60_000
    });
    assert.equal(created.status, 'pending');
    assert.equal(Object.hasOwn(created, 'yesCallbackHash'), false);
    assert.equal(test.store.attachRemoteAskMessage({ id: created.askId, messageId: 77 }).messageId, 77);
    assert.equal(test.store.attachRemoteAskMessage({ id: created.askId, messageId: 77 }).messageId, 77);
    expectCode(() => test.store.attachRemoteAskMessage({ id: created.askId, messageId: 78 }), 'REMOTE_ASK_MESSAGE_CONFLICT');
    // THE CALLBACK-RESOLUTION CASES WERE REMOVED 2026-08-23. A remote ask was
    // answered by a Telegram inline-button press arriving through
    // commitTelegramUpdates(), which resolved it inside the same transaction that
    // committed the update. That method is deleted with the three telegram_*
    // tables, so the resolution path has no driver.
    //
    // WHAT THIS MEANS FOR remote_asks, STATED PLAINLY RATHER THAN LEFT TO BE
    // DISCOVERED: system.ask_remote was implemented by
    // providers/messaging.telegramAskRemote and was removed with the connector, so
    // the remote_asks TABLE and the store methods below it are now unreachable
    // from any product surface. The table is deliberately NOT dropped by V23 --
    // that migration was scoped to the three tables the contract named, and
    // widening a schema migration on the way past is exactly the move the V22
    // note warns against. The live database holds 0 rows in remote_asks. A
    // follow-up V24 should drop it; until then the lifecycle assertions that
    // survive below keep the code honest.

    // The rest of the lifecycle needs no Telegram update to drive it: expiry is a
    // clock read and 'unavailable' is a send failure, both reachable directly.
    const other = test.store.createRemoteAsk({
      id: 'remote-ask-00000002', yesCallbackHash: callbackHash('te:a:remote-ask-002:y'), noCallbackHash: callbackHash('te:a:remote-ask-002:n'),
      chatId: '123', expiresAtMs: test.now() + 60_000
    });
    assert.equal(test.store.getRemoteAsk({ id: other.askId }).status, 'pending');
    test.advance(60_001);
    assert.equal(test.store.expireRemoteAsk({ id: other.askId }).status, 'timeout');

    const unavailable = test.store.createRemoteAsk({
      id: 'remote-ask-00000003', yesCallbackHash: callbackHash('te:a:remote-ask-003:y'), noCallbackHash: callbackHash('te:a:remote-ask-003:n'),
      chatId: '123', expiresAtMs: test.now() + 60_000
    });
    assert.equal(test.store.markRemoteAskUnavailable({ id: unavailable.askId, errorCode: 'REMOTE_ASK_TRANSPORT_UNAVAILABLE' }).status, 'unavailable');
    const hashes = test.store.transaction(db => db.prepare('SELECT yes_callback_hash, no_callback_hash FROM remote_asks WHERE id = ?').get(created.askId));
    assert.doesNotMatch(JSON.stringify(hashes), new RegExp(yesData));
    test.store.close();
  }

  // THE TELEGRAM POLLING BLOCK WAS REMOVED 2026-08-23 with MIGRATION_V23.
  //
  // It exercised the fenced poll lease end to end: single-writer serialisation,
  // update-id deduplication without payload overwrite, monotonic cursor advance,
  // TELEGRAM_UPDATE_CONFLICT on a changed payload for a seen id, bounded
  // retention, the 8 MiB batch ceiling, and lease takeover/expiry. All fifteen
  // store methods it drove are gone with the three tables they read.
  //
  // THE LEASE MACHINERY ITSELF IS NOT WHAT WAS LOST -- operations and tasks have
  // their own fenced leases, covered by the blocks above and below. What is gone
  // is the only caller that used a lease to serialise an EXTERNAL poll.

  // Canonical input hashes are stable across object key order. Operation
  // transitions are fenced, retry scheduling is explicit, and an expired
  // executing lease becomes uncertain rather than being replayed.
  {
    assert.equal(hashInput({ b: 2, a: [1, true] }), hashInput({ a: [1, true], b: 2 }));
    assert.notEqual(hashInput({ a: 1 }), hashInput({ a: 2 }));
    assert.equal(hashInput(Array(1)), hashInput([null]));
    assert.notEqual(hashInput(Array(1)), hashInput([]));
    expectCode(() => hashInput({ value: Infinity }), 'STATE_JSON_INVALID');
    let tooDeep = {};
    for (let index = 0; index < 100; index += 1) tooDeep = { child: tooDeep };
    expectCode(() => hashInput(tooDeep), 'STATE_JSON_DEPTH');

    const test = fixture('operations');
    const digest = hashInput({ imageUrl: 'https://example.com/a.jpg', caption: 'a' });
    const reserved = test.store.reserveOperation({ type: 'instagram.publish_image', key: 'post-a', inputHash: digest, leaseMs: 2000 });
    assert.equal(reserved.disposition, 'reserved');
    assert.equal(reserved.operation.status, 'reserved');
    assert.equal(reserved.operation.attempt, 1);
    assert.equal(reserved.operation.result, null);
    expectCode(() => test.store.reserveOperation({ type: 'instagram.publish_image', key: 'post-a', inputHash: digest, leaseMs: 2000 }), 'OPERATION_LEASE_HELD');
    const executing = test.store.markOperationExecuting(reserved.handle, { leaseMs: 3000 });
    assert.equal(executing.operation.status, 'executing');
    expectCode(() => test.store.succeedOperation(executing.handle, { result: { access_token: 'must-not-persist' } }), 'OPERATION_RESULT_SENSITIVE');
    assert.equal(test.store.getOperation({ id: executing.operation.id }).status, 'executing');
    test.advance(500);
    const heartbeat = test.store.heartbeatOperation(executing.handle, { leaseMs: 4000 });
    assert.equal(heartbeat.handle.fence, executing.handle.fence);
    assert.ok(heartbeat.handle.expiresAtMs > executing.handle.expiresAtMs);
    const nonShortening = test.store.heartbeatOperation(heartbeat.handle, { leaseMs: 1000 });
    assert.equal(nonShortening.handle.expiresAtMs, heartbeat.handle.expiresAtMs);
    const succeeded = test.store.succeedOperation(nonShortening.handle, { result: { mediaId: 'm-1', status: 'published' } });
    assert.equal(succeeded.operation.status, 'succeeded');
    assert.deepEqual(succeeded.result, { mediaId: 'm-1', status: 'published' });
    const replay = test.store.reserveOperation({ type: 'instagram.publish_image', key: 'post-a', inputHash: digest, leaseMs: 2000 });
    assert.equal(replay.disposition, 'replay');
    assert.deepEqual(replay.result, succeeded.result);
    expectCode(() => test.store.reserveOperation({ type: 'instagram.publish_image', key: 'post-a', inputHash: hashInput({ other: true }), leaseMs: 2000 }), 'OPERATION_INPUT_CONFLICT');
    expectCode(() => test.store.succeedOperation(heartbeat.handle, { result: {} }), 'OPERATION_FENCE_LOST');

    const retryDigest = hashInput({ task: 'retry' });
    let retry = test.store.reserveOperation({ type: 'provider.write', key: 'retry-me', inputHash: retryDigest, leaseMs: 2000 });
    retry = test.store.markOperationExecuting(retry.handle, { leaseMs: 2000 });
    const retryAtMs = test.now() + 5000;
    const failed = test.store.failOperation(retry.handle, { errorCode: 'PROVIDER_TEMPORARY', errorMessage: 'try later', retryAtMs });
    assert.equal(failed.operation.status, 'retryable_failed');
    assert.equal(failed.operation.retryAtMs, retryAtMs);
    assert.equal(failed.operation.completedAtMs, test.now());
    expectCode(() => test.store.reserveOperation({ type: 'provider.write', key: 'retry-me', inputHash: retryDigest, leaseMs: 2000 }), 'OPERATION_RETRY_NOT_READY');
    test.setNow(retryAtMs);
    const retried = test.store.reserveOperation({ type: 'provider.write', key: 'retry-me', inputHash: retryDigest, leaseMs: 2000 });
    assert.equal(retried.operation.attempt, 2);
    assert.equal(retried.handle.fence, 2);
    assert.equal(retried.operation.completedAtMs, null);
    expectCode(() => test.store.heartbeatOperation(retry.handle, { leaseMs: 2000 }), 'OPERATION_FENCE_LOST');
    const retryExecuting = test.store.markOperationExecuting(retried.handle, { leaseMs: 2000 });
    const uncertain = test.store.markOperationUncertain(retryExecuting.handle, { errorCode: 'PROVIDER_AMBIGUOUS', errorMessage: 'request outcome unknown' });
    assert.equal(uncertain.operation.status, 'uncertain');
    expectCode(() => test.store.reserveOperation({ type: 'provider.write', key: 'retry-me', inputHash: retryDigest, leaseMs: 2000 }), 'OPERATION_UNCERTAIN');
    expectCode(() => test.store.reconcileOperationSuccess({ type: 'provider.write', key: 'retry-me', inputHash: hashInput({ wrong: true }), result: { providerId: 'wrong-input' } }), 'OPERATION_INPUT_CONFLICT');
    expectCode(() => test.store.reconcileOperationSuccess({ type: 'provider.write', key: 'retry-me', inputHash: retryDigest, result: { access_token: 'must-not-persist' } }), 'OPERATION_RESULT_SENSITIVE');
    const reconciled = test.store.reconcileOperationSuccess({ type: 'provider.write', key: 'retry-me', inputHash: retryDigest, result: { providerId: 'reconciled-after-observation' } });
    assert.equal(reconciled.disposition, 'reconciled');
    assert.equal(reconciled.operation.status, 'succeeded');
    assert.deepEqual(reconciled.result, { providerId: 'reconciled-after-observation' });
    const reconciledReplay = test.store.reconcileOperationSuccess({ type: 'provider.write', key: 'retry-me', inputHash: retryDigest, result: { providerId: 'ignored-on-replay' } });
    assert.equal(reconciledReplay.disposition, 'replay');
    assert.deepEqual(reconciledReplay.result, { providerId: 'reconciled-after-observation' });

    const noEffectDigest = hashInput({ task: 'observed-no-effect' });
    let noEffect = test.store.reserveOperation({ type: 'provider.write', key: 'observed-no-effect', inputHash: noEffectDigest, leaseMs: 2000 });
    noEffect = test.store.markOperationExecuting(noEffect.handle, { leaseMs: 2000 });
    test.store.markOperationUncertain(noEffect.handle, { errorCode: 'PROVIDER_AMBIGUOUS', errorMessage: 'outcome unknown' });
    const noEffectReconciled = test.store.reconcileOperationFailure({ type: 'provider.write', key: 'observed-no-effect', inputHash: noEffectDigest, errorCode: 'PROVIDER_NO_EFFECT_OBSERVED', errorMessage: 'independent absence observation', retryAtMs: test.now() });
    assert.equal(noEffectReconciled.disposition, 'reconciled');
    assert.equal(noEffectReconciled.operation.status, 'retryable_failed');
    assert.equal(noEffectReconciled.operation.error.code, 'PROVIDER_NO_EFFECT_OBSERVED');
    assert.equal(test.store.reconcileOperationFailure({ type: 'provider.write', key: 'observed-no-effect', inputHash: noEffectDigest, errorCode: 'PROVIDER_NO_EFFECT_OBSERVED', errorMessage: 'ignored on replay', retryAtMs: test.now() }).disposition, 'replay');

    const reservedExpiryHash = hashInput({ task: 'reserved-expiry' });
    const oldReservation = test.store.reserveOperation({ type: 'provider.write', key: 'reserved-expiry', inputHash: reservedExpiryHash, leaseMs: 1000 });
    test.advance(1001);
    const reclaimed = test.store.reserveOperation({ type: 'provider.write', key: 'reserved-expiry', inputHash: reservedExpiryHash, leaseMs: 1000 });
    assert.equal(reclaimed.operation.attempt, 2);
    assert.equal(reclaimed.handle.fence, oldReservation.handle.fence + 1);

    const executionExpiryHash = hashInput({ task: 'execution-expiry' });
    let expires = test.store.reserveOperation({ type: 'provider.write', key: 'execution-expiry', inputHash: executionExpiryHash, leaseMs: 1000 });
    expires = test.store.markOperationExecuting(expires.handle, { leaseMs: 1000 });
    test.advance(1001);
    expectCode(() => test.store.reserveOperation({ type: 'provider.write', key: 'execution-expiry', inputHash: executionExpiryHash, leaseMs: 1000 }), 'OPERATION_UNCERTAIN');
    const expiredRecord = test.store.getOperation({ type: 'provider.write', key: 'execution-expiry' });
    assert.equal(expiredRecord.status, 'uncertain');
    assert.equal(expiredRecord.error.code, 'LEASE_EXPIRED_DURING_EXECUTION');
    assert.equal(expiredRecord.completedAtMs, test.now());
    assert.equal(expiredRecord.leaseOwner, expires.handle.ownerId, 'Uncertain expiry preserves the original success capability.');
    const lateSuccess = test.store.succeedOperation(expires.handle, { result: { providerId: 'known-late-id' } });
    assert.equal(lateSuccess.operation.status, 'succeeded');
    assert.deepEqual(lateSuccess.result, { providerId: 'known-late-id' });
    assert.equal(test.store.listOperations({ status: 'uncertain' }).length, 0, 'explicit reconciliation clears the prior uncertainty before later late-success checks');
    assert.ok(!Object.keys(expiredRecord).includes('input'), 'Only an input hash is exposed/persisted.');

    const explicitLateHash = hashInput({ task: 'explicit-late-uncertain' });
    let explicitLate = test.store.reserveOperation({ type: 'provider.write', key: 'explicit-late-uncertain', inputHash: explicitLateHash, leaseMs: 1000 });
    explicitLate = test.store.markOperationExecuting(explicitLate.handle, { leaseMs: 1000 });
    test.advance(1001);
    const explicitlyUncertain = test.store.markOperationUncertain(explicitLate.handle, { errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'outcome unknown' });
    assert.equal(explicitlyUncertain.operation.status, 'uncertain');
    const explicitResolution = test.store.succeedOperation(explicitLate.handle, { result: { providerId: 'late-confirmed' } });
    assert.equal(explicitResolution.operation.status, 'succeeded');
    test.store.close();
  }

  // Legacy files are validated and hashed independently, never changed, and
  // never re-imported. Instagram's key-only record binds its first observed
  // input hash, after which normal conflict detection applies.
  {
    const test = fixture('legacy');
    const spendPath = path.join(test.dir, 'spend.json');
    const instagramPath = path.join(test.dir, 'instagram.json');
    const spendOriginal = writeJson(spendPath, {
      version: 1,
      entries: [{ id: 'old-spend', date: '2025-12-31', timestamp: '2025-12-31T12:00:00.000Z', amountUsd: 1.23, purpose: 'legacy', provider: 'manual', reference: 'old-ref' }]
    });
    // The legacy TELEGRAM importer was removed 2026-08-23 with MIGRATION_V23:
    // logs/message-queue.json imported into telegram_updates/telegram_cursor and
    // both tables are dropped. The spend and instagram importers below are
    // untouched -- only this one lost its destination.
    const instagramOriginal = writeJson(instagramPath, {
      version: 1,
      entries: { 'legacy-post': { containerId: 'container-old', mediaId: 'media-old', status: 'published', completedAt: '2025-12-31T12:00:00.000Z' } }
    });
    const aggregate = test.store.importLegacyState({ spendPath, instagramPath });
    assert.equal(aggregate.spend.status, 'imported');
    assert.equal(aggregate.instagram.status, 'imported');
    assert.match(aggregate.spend.digest, /^[a-f0-9]{64}$/);
    assert.equal(test.store.listSpend({ date: '2025-12-31' })[0].amountCents, 123);
    assert.equal(fs.readFileSync(spendPath, 'utf8'), spendOriginal);
    assert.equal(fs.readFileSync(instagramPath, 'utf8'), instagramOriginal);
    assert.equal(test.store.importLegacySpend(spendPath).status, 'already_imported');
    assert.equal(test.store.importLegacyInstagram(instagramPath).status, 'already_imported');

    const boundHash = hashInput({ imageUrl: 'https://example.com/legacy.jpg', caption: 'legacy' });
    const legacyReplay = test.store.reserveOperation({ type: 'instagram.publish_image', key: 'legacy-post', inputHash: boundHash, leaseMs: 1000 });
    assert.equal(legacyReplay.disposition, 'replay');
    assert.equal(legacyReplay.result.mediaId, 'media-old');
    assert.equal(legacyReplay.operation.inputVerified, true);
    expectCode(() => test.store.reserveOperation({ type: 'instagram.publish_image', key: 'legacy-post', inputHash: hashInput({ different: true }), leaseMs: 1000 }), 'OPERATION_INPUT_CONFLICT');

    fs.appendFileSync(spendPath, ' ');
    expectCode(() => test.store.importLegacySpend(spendPath), 'LEGACY_IMPORT_CHANGED');

    const missing = test.store.importLegacyState({
      spendPath: path.join(test.dir, 'absent-spend.json'),
      instagramPath: path.join(test.dir, 'absent-instagram.json')
    });
    // Sources already imported: an absent alternate path is still harmless and
    // does not replace or delete their existing durable records.
    assert.equal(missing.spend.status, 'missing');
    assert.equal(missing.instagram.status, 'missing');
    test.store.close();

    const invalid = fixture('legacy-invalid');
    const invalidSpend = path.join(invalid.dir, 'bad-spend.json');
    writeJson(invalidSpend, { version: 1, entries: [{ amountUsd: 1.234, date: '2026-01-01' }] });
    expectCode(() => invalid.store.importLegacySpend(invalidSpend), 'LEGACY_IMPORT_INVALID');
    assert.equal(invalid.store.listSpend().length, 0);
    writeJson(invalidSpend, { version: 1, entries: [{ amountUsd: 1, date: '2025-12-30', timestamp: '2025-12-31T01:00:00.000Z' }] });
    expectCode(() => invalid.store.importLegacySpend(invalidSpend), 'LEGACY_IMPORT_INVALID');
    invalid.store.close();

    const spendConflict = fixture('legacy-spend-conflict');
    const durable = spendConflict.store.recordSpend({ amountCents: 100, dailyLimitCents: 1000, purpose: 'durable', provider: 'manual', reference: 'durable-ref' }).entry;
    const conflictPath = path.join(spendConflict.dir, 'spend-conflict.json');
    writeJson(conflictPath, { version: 1, entries: [{
      id: durable.id, date: durable.date, timestamp: durable.timestamp, amountUsd: 2,
      purpose: 'different', provider: 'manual', reference: 'different-ref'
    }] });
    expectCode(() => spendConflict.store.importLegacySpend(conflictPath), 'LEGACY_IMPORT_CONFLICT');
    writeJson(conflictPath, { version: 1, entries: [{
      id: 'different-id', date: durable.date, timestamp: durable.timestamp, amountUsd: 2,
      purpose: 'different', provider: 'manual', reference: 'durable-ref'
    }] });
    expectCode(() => spendConflict.store.importLegacySpend(conflictPath), 'LEGACY_IMPORT_CONFLICT');
    writeJson(conflictPath, { version: 1, entries: [{
      id: durable.id, date: durable.date, timestamp: durable.timestamp, amountUsd: durable.amountUsd,
      purpose: durable.purpose, provider: durable.provider, reference: durable.reference
    }] });
    const exactImport = spendConflict.store.importLegacySpend(conflictPath);
    assert.deepEqual(exactImport.details, { validated: 1, imported: 0, skipped: 1 });
    spendConflict.store.close();

    const instagramUnsafe = fixture('legacy-instagram-unsafe');
    const unsafeInstagramPath = path.join(instagramUnsafe.dir, 'instagram.json');
    writeJson(unsafeInstagramPath, { version: 1, entries: {
      unsafe: { containerId: 'c', mediaId: 'm', status: 'published', completedAt: '2025-12-31T00:00:00.000Z', accessToken: 'must-not-import' }
    } });
    expectCode(() => instagramUnsafe.store.importLegacyInstagram(unsafeInstagramPath), 'LEGACY_IMPORT_INVALID');
    assert.equal(instagramUnsafe.store.getOperation({ type: 'instagram.publish_image', key: 'unsafe' }), null);
    instagramUnsafe.store.close();
  }

  // A newer on-disk schema fails closed with a precise code.
  {
    const test = fixture('future-schema');
    test.store.health();
    test.store.transaction(db => db.exec('PRAGMA user_version = 999'));
    test.store.close();
    const future = createStateStore({ file: path.join(test.dir, 'state.sqlite3') });
    expectCode(() => future.health(), 'STATE_SCHEMA_TOO_NEW');
    future.close();
  }

  // MIGRATION_V23 REMOVES THE TELEGRAM CONNECTOR STORAGE (2026-08-23).
  //
  // The three telegram_* tables were created by MIGRATION_V1, so every database
  // that has ever existed has them and V1 is NOT edited to pretend otherwise --
  // that would make expectedSchemaFingerprint(1..22) describe a database that
  // never existed and every installation would refuse to open. The subtraction
  // happens once, at 23. This is the V22/Discord shape, one migration later.
  {
    const test = fixture('telegram-v23');
    test.store.health();
    // Fabricate a genuine v22 database: put back exactly what V23 removed, then
    // stamp the version that still had them.
    test.store.transaction(db => db.exec(`${RESTORE_LEGACY_MISSION_NAMES}${RESTORE_TELEGRAM_TABLES_V1}
      PRAGMA user_version = 22;`));
    // Give telegram_updates a row, so this proves the DROP actually destroys
    // owner content rather than only removing empty scaffolding. This is the
    // loss the migration comment owns up to.
    test.store.transaction(db => db.exec(
      `INSERT INTO telegram_updates(update_id, received_at_ms, payload_json, payload_hash)
       VALUES(7, 1, '{"update_id":7}', '${'a'.repeat(64)}');`));
    test.store.transaction(db => {
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM telegram_updates').get().c, 1);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 22);
    });
    test.store.close();

    const migrated = createStateStore({ file: path.join(test.dir, 'state.sqlite3'), clock: () => test.now() });
    assert.equal(migrated.health().schemaVersion, SCHEMA_VERSION);
    // V24 (2026-09-03) renames the durable-mission tables on top of V23; this case
    // still exercises V23's telegram migration on the way through, so the pin moves
    // to 24 deliberately here and nowhere else.
    assert.equal(SCHEMA_VERSION, 24, 'V24 is the migration under test; update this suite deliberately, not incidentally');
    const survivors = migrated.transaction(db =>
      db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'telegram%' ORDER BY name").all().map(row => row.name));
    assert.deepEqual(survivors, [],
      'the three tables AND telegram_updates_received_idx must all be gone; SQLite drops the index with its table');

    // A MIGRATED database and a FRESH one must be byte-identical in DDL. This is
    // the property _validateSchema compares, and it is the reason IF EXISTS is
    // load-bearing rather than defensive noise: a fresh database runs V1 (which
    // creates these tables) and then V23 (which drops them) in the same open.
    const migratedDdl = migrated.transaction(db =>
      db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all());
    migrated.close();

    const freshHome = fixture('telegram-v23-fresh');
    freshHome.store.health();
    const freshDdl = freshHome.store.transaction(db =>
      db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all());
    assert.deepEqual(migratedDdl, freshDdl,
      'a database migrated 22 -> 23 and one created fresh at 23 must reach the same schema');
    freshHome.store.close();

    // Reopening an already-migrated database must revalidate rather than
    // re-drop: the telegram singleton invariants in _validateSchema are bounded
    // ABOVE at 22 and must not be asked of a database at 23.
    const reopened = createStateStore({ file: path.join(test.dir, 'state.sqlite3'), clock: () => test.now() });
    assert.equal(reopened.health().schemaVersion, SCHEMA_VERSION);
    reopened.close();
  }

  // The store must not keep methods that can only ever raise "no such table".
  {
    const test = fixture('telegram-surface');
    for (const gone of [
      'getTelegramCursor', 'acquireTelegramPollLease', 'releaseTelegramPollLease',
      'commitTelegramUpdates', 'listTelegramUpdates', 'getTelegramCommand',
      'pruneTelegramUpdates', 'importLegacyTelegram'
    ]) {
      assert.equal(typeof test.store[gone], 'undefined', `${gone} reads a table MIGRATION_V23 dropped and must not survive`);
    }
    // ...and REQUIRED_SCHEMA must stop demanding the tables it just dropped.
    for (const table of ['telegram_cursor', 'telegram_poll_lease', 'telegram_updates']) {
      assert.equal(Object.hasOwn(REQUIRED_SCHEMA, table), false, `${table} must not be required at the current schema`);
    }
    // The importer that lost its destination is gone from the aggregate too.
    const aggregate = test.store.importLegacyState({
      spendPath: path.join(test.dir, 'absent-spend.json'),
      instagramPath: path.join(test.dir, 'absent-instagram.json')
    });
    assert.equal(Object.hasOwn(aggregate, 'telegram'), false,
      'importLegacyState must not offer a telegram key whose importer is deleted');
    test.store.close();
  }

  // Version metadata alone cannot spoof a valid store: application identity
  // and the exact required STRICT table layouts are checked on every open.
  {
    const corrupt = fixture('invalid-schema');
    corrupt.store.health();
    // SUBJECT CHANGED 2026-08-23: this used telegram_cursor, which MIGRATION_V23
    // dropped. legacy_imports is the same shape of victim -- a small STRICT table
    // present since MIGRATION_V1 -- so the property under test (a re-created table
    // with a slack layout is caught even though the version metadata still looks
    // right) is unchanged.
    corrupt.store.transaction(db => db.exec(`DROP TABLE legacy_imports;
      CREATE TABLE legacy_imports(source TEXT, source_path TEXT, digest TEXT, imported_at_ms INTEGER, records INTEGER, details_json TEXT) STRICT;`));
    expectCode(() => corrupt.store.health(), 'STATE_SCHEMA_INVALID');
    corrupt.store.close();
    const reopened = createStateStore({ file: path.join(corrupt.dir, 'state.sqlite3') });
    expectCode(() => reopened.health(), 'STATE_SCHEMA_INVALID');
    reopened.close();

    const foreign = fixture('foreign-database');
    foreign.store.health();
    foreign.store.transaction(db => db.exec('PRAGMA application_id = 123'));
    foreign.store.close();
    const wrongIdentity = createStateStore({ file: path.join(foreign.dir, 'state.sqlite3') });
    expectCode(() => wrongIdentity.health(), 'STATE_DATABASE_IDENTITY');
    wrongIdentity.close();
  }

  process.stdout.write('state-store tests passed\n');
  reachedTheEnd = true;
} finally {
  /* CLEANUP MUST NOT REPLACE THE FAILURE THE RUN EXISTS TO REPORT.
   *
   * SQLite/AV handle release on Windows can trail an otherwise successful close
   * by a few ticks, so this stayed deliberately strict to surface a persistent
   * leaked handle. But a throw from a `finally` REPLACES an in-flight exception:
   * when an assertion failed part-way through, the store it was using was never
   * closed, its file stayed locked, and rmSync threw EBUSY over the top of the
   * AssertionError. MEASURED -- a planted defect took this suite to exit 1 whose
   * entire output was "EBUSY: resource busy or locked, unlink ...state.sqlite3",
   * with the real assertion nowhere in it. Every failure in this file was
   * unreadable, and an exit code with the wrong reason attached is how a
   * mutation round records a kill it did not earn.
   *
   * Both intents are kept: on a run that reached the end, an unremovable root is
   * still a failure (that is the leak check). On a run that was already failing,
   * it is reported and the original error is left to propagate. */
  const cleanupFailures = [];
  for (const dir of temporaryRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      cleanupFailures.push(`${dir}: ${error.message}`);
    }
  }
  if (cleanupFailures.length) {
    console.error(`state-store: ${cleanupFailures.length} temporary root(s) could not be removed:`);
    for (const failure of cleanupFailures) console.error(`  ${failure}`);
    if (reachedTheEnd) {
      throw new Error(`state-store leaked ${cleanupFailures.length} open handle(s) after an otherwise passing run`);
    }
    console.error('  (reported, not thrown: the run was already failing and that failure is the one that matters)');
  }
}
})().catch(error => {
  console.error(error.stack || error.message);
  if (error && error.details && Object.keys(error.details).length) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exitCode = 1;
});
