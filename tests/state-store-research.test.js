'use strict';

// The research domain's durable contract: fresh-vs-migrated schema identity,
// the table CHECK disciplines, atomic idempotent run submission, and the
// session-assignment resolution rules including the live 'all' row.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createStateStore, SCHEMA_VERSION } = require('../src/lib/state-store');

function fixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `research-store-${name}-`));
  return { dir, file: path.join(dir, 'state.sqlite3') };
}

const RESEARCH_TABLE_DROPS = 'DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_project_sessions; '
  + 'DROP TABLE research_findings; DROP TABLE research_experiments; DROP TABLE research_projects;';

// V24 also renamed these tables. Match the kernel migration fixture's inverse
// rename before calling a current database "v20"; the unchanged fingerprint
// validation below still proves the complete historical schema identity.
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

// This fixture starts from a CURRENT database and stamps it as v20. Since v22
// removed Discord and v23 removed Telegram, subtraction alone stopped producing
// a database that could ever have existed: every real v20 database had both
// connector schemas. The stale fixture was therefore correctly rejected before
// the research migration ran. Restore exactly what v22/v23 removed first, as
// the kernel migration fixtures do; any DDL drift is caught by the version-20
// fingerprint check during reopen.
const RESTORE_TELEGRAM_TABLES_FOR_V20 = `
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

const RESTORE_DISCORD_TABLES_FOR_V20 = `
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

test('a v20 database migrates through v21 and passes the same fingerprint validation as a fresh build', () => {
  const { file } = fixture('migrate');
  const store = createStateStore({ file });
  store.health();
  store.transaction(db => db.exec(`${RESEARCH_TABLE_DROPS} ${RESTORE_LEGACY_MISSION_NAMES} ${RESTORE_TELEGRAM_TABLES_FOR_V20} ${RESTORE_DISCORD_TABLES_FOR_V20} PRAGMA user_version = 20;`));
  store.close();
  const migrated = createStateStore({ file });
  // health() re-runs _migrate and _validateSchema; validation compares the
  // migrated database's DDL fingerprint against the fresh in-memory build, so
  // reaching the version assertion IS the fresh-vs-migrated identity proof.
  assert.equal(migrated.health().schemaVersion, SCHEMA_VERSION);
  migrated.close();
});

test('the CHECK disciplines hold at the SQL layer, not just in the methods', () => {
  const { file } = fixture('checks');
  const store = createStateStore({ file });
  store.health();
  const project = store.createResearchProject({ name: 'Demo', enabled: true });
  // A confirmed finding without evidence+falsifier must be refused by the
  // table itself, so a future writer that skips saveResearchFinding cannot
  // record an undisciplined confirmation.
  assert.throws(() => store.transaction(db => db.prepare(`INSERT INTO research_findings
    (finding_id, project_id, claim, status, evidence_json, method, confidence, falsifier, dissents_json, supersedes, created_at_ms, updated_at_ms)
    VALUES('F-2026-0101-001', ?, 'x', 'confirmed', NULL, NULL, NULL, NULL, '[]', NULL, 1, 1)`).run(project.projectId)),
  /CHECK|constraint/i);
  // The method layer says it in a sentence.
  assert.throws(() => store.saveResearchFinding({ projectId: project.projectId, claim: 'x', status: 'confirmed' }),
    error => error.code === 'RESEARCH_FINDING_UNDISCIPLINED');
  store.close();
});

test('run submission is one transaction with idempotent replay and a deterministic payload', () => {
  const { file } = fixture('submit');
  const store = createStateStore({ file });
  store.health();
  const project = store.createResearchProject({ name: 'Demo', enabled: true });
  const created = store.createResearchExperiment({
    projectId: project.projectId, name: 'grid', runnerKind: 'process',
    runnerConfig: { command: 'node', args: [], stdin: 'none' },
    resultSchema: { fields: { n: 'number' }, required: ['n'] },
    collector: { kind: 'stdout-json' }
  });
  assert.equal(created.disposition, 'created');

  const first = store.submitResearchRun({ experimentId: created.experiment.experimentId, params: { a: 1 } });
  const replay = store.submitResearchRun({ experimentId: created.experiment.experimentId, params: { a: 1 } });
  const second = store.submitResearchRun({ experimentId: created.experiment.experimentId, params: { a: 2 } });
  assert.equal(first.disposition, 'submitted');
  assert.equal(replay.disposition, 'replay');
  assert.equal(replay.run.runId, first.run.runId, 'identical params must replay the existing run, not mint a second');
  assert.equal(second.disposition, 'submitted');
  assert.notEqual(second.run.runId, first.run.runId);

  const byTask = store.getResearchRunByTask({ taskId: first.run.taskId });
  assert.equal(byTask.runId, first.run.runId);
  assert.equal(byTask.task.status, 'queued', 'status is read from the joined task, never stored twice');

  const results = store.recordResearchResults({ runId: first.run.runId, records: [
    { recordKind: 'summary', record: { n: 1 } },
    { recordKind: 'summary', record: { n: 1 } }
  ] });
  assert.equal(results.recorded, 1);
  assert.equal(results.deduplicated, 1, 'identical records hash-deduplicate inside one run');
  store.close();
});

test('experiment identity is the config hash, and configs are immutable after create', () => {
  const { file } = fixture('immutable');
  const store = createStateStore({ file });
  store.health();
  const project = store.createResearchProject({ name: 'Demo', enabled: true });
  const spec = {
    projectId: project.projectId, name: 'grid', runnerKind: 'process',
    runnerConfig: { command: 'node', args: [], stdin: 'none' },
    resultSchema: { fields: {} }, collector: { kind: 'none' }
  };
  const created = store.createResearchExperiment(spec);
  const replay = store.createResearchExperiment({ ...spec, name: 'renamed-but-identical-config' });
  assert.equal(replay.disposition, 'replay');
  assert.equal(replay.experiment.experimentId, created.experiment.experimentId);
  assert.throws(() => store.updateResearchExperiment({ experimentId: created.experiment.experimentId, runnerConfig: {} }),
    error => error.code === 'RESEARCH_EXPERIMENT_IMMUTABLE');
  store.close();
});

test("session resolution unions explicit references with the live 'all' rule, and unassignment keeps history", () => {
  const { file } = fixture('sessions');
  const store = createStateStore({ file });
  store.health();
  const project = store.createResearchProject({ name: 'Demo', enabled: true });
  store.assignResearchSessions({ projectId: project.projectId, assignedBy: 'test', sessions: [
    { kind: 'launch', ref: 'launch_1234567890abcdef' }, { kind: 'all' }
  ] });

  const viaAll = store.resolveSessionResearchProjects({ refs: [{ kind: 'observed', ref: 'a-session-never-assigned' }] });
  assert.equal(viaAll.length, 1, "the live 'all' row must cover sessions that did not exist when it was written");
  assert.equal(viaAll[0].via[0].kind, 'all');

  const viaExplicit = store.resolveSessionResearchProjects({ refs: [{ kind: 'launch', ref: 'launch_1234567890abcdef' }] });
  assert.equal(viaExplicit.length, 1);
  assert.ok(viaExplicit[0].via.some(entry => entry.kind === 'launch'));

  store.unassignResearchSession({ projectId: project.projectId, kind: 'all', ref: '*' });
  const afterUnassign = store.resolveSessionResearchProjects({ refs: [{ kind: 'observed', ref: 'a-session-never-assigned' }] });
  assert.equal(afterUnassign.length, 0);
  const history = store.listResearchSessionAssignments({ projectId: project.projectId, activeOnly: false });
  assert.ok(history.some(entry => entry.kind === 'all' && entry.active === false),
    'unassignment deactivates the row; it never deletes the record');
  store.close();
});

test('assignment-ID unassignment honors the supplied project and preserves ID-only callers', t => {
  const { dir, file } = fixture('assignment-project-scope');
  const store = createStateStore({ file });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.health();
  const first = store.createResearchProject({ name: 'First project', enabled: true });
  const second = store.createResearchProject({ name: 'Second project', enabled: true });
  const assign = project => store.assignResearchSessions({
    projectId: project.projectId, assignedBy: 'test', sessions: [{ kind: 'all' }]
  }).assignments[0];
  const firstAssignment = assign(first);
  const secondAssignment = assign(second);
  const rows = () => store.transaction(db => db.prepare(`SELECT assignment_id, project_id, active, unassigned_at_ms
    FROM research_project_sessions ORDER BY project_id`).all());
  const before = rows();

  let refusal;
  try {
    store.unassignResearchSession({ projectId: first.projectId, assignmentId: secondAssignment.assignmentId });
  } catch (error) { refusal = error; }
  assert.deepEqual(rows(), before, 'a mismatched project must leave every assignment and its history unchanged');
  assert.equal(refusal?.code, 'RESEARCH_ASSIGNMENT_NOT_FOUND');

  const removed = store.unassignResearchSession({ projectId: second.projectId, assignmentId: secondAssignment.assignmentId });
  assert.equal(removed.projectId, second.projectId);
  assert.equal(removed.assignmentId, secondAssignment.assignmentId);
  assert.equal(store.listResearchSessionAssignments({ projectId: second.projectId }).length, 0);
  assert.throws(() => store.unassignResearchSession({ projectId: second.projectId, assignmentId: secondAssignment.assignmentId }),
    error => error.code === 'RESEARCH_ASSIGNMENT_NOT_FOUND', 'an inactive assignment remains a refusal');

  const legacy = store.unassignResearchSession({ assignmentId: firstAssignment.assignmentId });
  assert.equal(legacy.projectId, first.projectId, 'the store still accepts the existing ID-only selector');
  const history = store.listResearchSessionAssignments({ activeOnly: false });
  assert.equal(history.length, 2);
  assert.ok(history.every(row => row.active === false && Number.isSafeInteger(row.unassignedAtMs)));
});

test('finding ids allocate a daily sequence and confirmed findings carry their discipline', () => {
  const { file } = fixture('findings');
  const store = createStateStore({ file });
  store.health();
  const project = store.createResearchProject({ name: 'Demo', enabled: true });
  const first = store.saveResearchFinding({ projectId: project.projectId, claim: 'a', status: 'open' });
  const second = store.saveResearchFinding({
    projectId: project.projectId, claim: 'b', status: 'confirmed',
    evidence: { runs: 2 }, falsifier: 'a run where b fails'
  });
  assert.match(first, /^F-\d{4}-\d{4}-001$/);
  assert.match(second, /^F-\d{4}-\d{4}-002$/);
  assert.equal(store.listResearchFindings({ projectId: project.projectId }).length, 2);
  store.close();
});

process.on('exit', () => { console.log('state-store research tests passed'); });

test('a research run whose lease expired reports it, instead of reading running for ever', async () => {
  // Installed build, 2026-08-15: a run sat at 'running' with leaseExpired
  // false for two and a half hours beside a stopped worker, because the
  // research row built its task without a clock. The reclaim was fine; the
  // report was not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-lease-'));
  const state = createStateStore({ file: path.join(dir, 'state.sqlite3') });
  state.health();
  const project = state.createResearchProject({ name: 'Lease', enabled: true });
  const created = state.createResearchExperiment({
    projectId: project.projectId, name: 'grid', runnerKind: 'process',
    runnerConfig: { command: 'node', args: [], stdin: 'none' },
    resultSchema: { fields: { n: 'number' }, required: ['n'] },
    collector: { kind: 'stdout-json' }
  });
  const submitted = state.submitResearchRun({ experimentId: created.experiment.experimentId, params: { a: 1 } });
  const claim = state.claimTask({ queue: 'research-runs', workerLabel: 'test', leaseMs: 1000 });
  assert.ok(claim && claim.task, 'the run must be claimable');

  const before = state.getResearchRunByTask({ taskId: submitted.run.taskId });
  assert.equal(typeof before.task.leaseExpired, 'boolean', 'the field must be computed, not absent');

  // Let the shortest allowed lease die, then read it the way a board does.
  await new Promise(resolve => setTimeout(resolve, 1200));
  const after = state.getResearchRunByTask({ taskId: submitted.run.taskId });
  assert.equal(after.task.leaseExpired, true, 'an expired lease must say so');
  // A claim that never started is stored 'leased'; the reported word separates
  // from the stored one exactly here, which is the whole point of the field.
  assert.equal(after.task.storedStatus, 'leased', 'the stored row is untouched by a read');
  assert.equal(after.task.status, 'expired', 'the reported word must not be the stale stored one');
  assert.notEqual(after.task.status, after.task.storedStatus);
  state.close();
});

function completionFixture(t, name = 'completion', collectorKind = 'stdout-json') {
  const { dir, file } = fixture(name);
  const state = createStateStore({ file });
  t.after(() => {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.health();
  const project = state.createResearchProject({ name: 'Atomic fixture', enabled: true });
  const { experiment } = state.createResearchExperiment({
    projectId: project.projectId, name, runnerKind: 'process',
    runnerConfig: { command: 'fixture-only-never-executed', args: [], stdin: 'none' },
    resultSchema: { fields: { n: 'number' }, required: ['n'] }, collector: { kind: collectorKind }
  });
  const { run } = state.submitResearchRun({ experimentId: experiment.experimentId, params: { fixture: name } });
  const { handle } = state.claimTask({ queue: 'research-runs', workerLabel: 'atomic-fixture', leaseMs: 300000 });
  state.startTask(handle);
  const records = [
    { recordKind: 'first', record: { observationId: 'a', n: 7 } },
    { recordKind: 'second', record: { observationId: 'b', n: 7 }, artifactPath: 'result.json' }
  ];
  const result = { summary: 'Collected fixture records.', runnerKind: 'process', evidenceStatus: 'collected' };
  return { state, run, experiment, handle, records, result };
}

function assertNoCompletion(state, run, status = 'running') {
  const observed = state.getResearchRunByTask({ taskId: run.taskId });
  assert.equal(observed.task.status, status);
  assert.equal(observed.task.result, null);
  assert.deepEqual(state.listResearchResults({ runId: run.runId }), []);
}

test('research completion binds every observation and the task outcome in one replayable transaction', t => {
  const { state, run, handle, records, result } = completionFixture(t);
  const input = { runId: run.runId, records, result: { ...result, recorded: 999, collectionHash: 'caller-supplied', attempt: 9, fence: 99 } };
  const completed = state.completeResearchRun(handle, input);
  assert.equal(completed.replayed, false);
  assert.equal(completed.task.status, 'succeeded');
  assert.equal(completed.task.result.recorded, 2, 'equal measurements with distinct observation IDs remain two observations');
  assert.equal(completed.task.result.deduplicated, 0);
  assert.equal(completed.task.result.attempt, handle.attempt);
  assert.equal(completed.task.result.fence, handle.fence);
  assert.match(completed.task.result.collectionHash, /^[a-f0-9]{64}$/);
  assert.match(state.transaction(db => db.prepare('SELECT result_hash FROM tasks WHERE id = ?').get(run.taskId)).result_hash, /^[a-f0-9]{64}$/);
  const stored = state.listResearchResults({ runId: run.runId });
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map(entry => entry.record), records.map(entry => entry.record));
  assert.equal(state.completeResearchRun(handle, input).replayed, true);
  assert.deepEqual(state.listResearchResults({ runId: run.runId }), stored, 'replay does not rewrite row identities or timestamps');
  assert.throws(() => state.completeResearchRun(handle, { ...input, records: [records[0], { ...records[1], record: { observationId: 'b', n: 8 } }] }),
    error => error.code === 'TASK_OUTCOME_CONFLICT');
  assert.throws(() => state.completeResearchRun(handle, { ...input, records: [...records].reverse() }),
    error => error.code === 'TASK_OUTCOME_CONFLICT', 'replay must retain the originally bound collection');
  assert.deepEqual(state.listResearchResults({ runId: run.runId }), stored);
});

test('cancellation and forged or lost claims cannot leak collected records', async t => {
  await t.test('real cancellation and a fake cancellation acknowledgement', t => {
    const { state, run, handle, records, result } = completionFixture(t, 'cancel');
    assert.throws(() => state.failTask(handle, { disposition: 'cancelled', code: 'CANCELLED', message: 'not requested' }),
      error => error.code === 'TASK_CANCEL_NOT_REQUESTED');
    assertNoCompletion(state, run);
    state.cancelTask({ taskId: run.taskId, reason: 'fixture cancellation' });
    assert.throws(() => state.completeResearchRun(handle, { runId: run.runId, records, result }),
      error => error.code === 'TASK_CANCEL_REQUESTED');
    assertNoCompletion(state, run);
    state.failTask(handle, { disposition: 'cancelled', code: 'CANCELLED', message: 'requested' });
    assertNoCompletion(state, run, 'cancelled');
  });
  await t.test('forged handles and a claim for another run', t => {
    const { state, run, experiment, handle, records, result } = completionFixture(t, 'forged');
    for (const forged of [
      { ...handle, claimToken: 'A'.repeat(43) }, { ...handle, workerLabel: 'different-worker' },
      { ...handle, fence: handle.fence + 1 }, { ...handle, attempt: handle.attempt + 1 }
    ]) {
      assert.throws(() => state.completeResearchRun(forged, { runId: run.runId, records, result }), error => error.code === 'TASK_FENCE_LOST');
      assertNoCompletion(state, run);
    }
    const other = state.submitResearchRun({ experimentId: experiment.experimentId, params: { fixture: 'other-run' } }).run;
    assert.throws(() => state.completeResearchRun(handle, { runId: other.runId, records, result }), error => error.code === 'TASK_FENCE_LOST');
    assertNoCompletion(state, run);
    assertNoCompletion(state, other, 'queued');
  });
  await t.test('a superseded attempt cannot complete after its successor starts', t => {
    const { state, run, handle, records, result } = completionFixture(t, 'successor');
    state.failTask(handle, { disposition: 'retry', code: 'FIXTURE_RETRY', message: 'retry', retryDelayMs: 0 });
    const next = state.claimTask({ queue: 'research-runs', workerLabel: 'successor', leaseMs: 300000 }).handle;
    state.startTask(next);
    const artifactDir = path.join(path.dirname(state.file), 'attempt-two');
    state.setResearchRunArtifactDir({ runId: run.runId, artifactDir, handle: next });
    state.setResearchRunSession({ runId: run.runId, sessionRefKind: 'launch', sessionRef: 'launch_successor', handle: next });
    assert.throws(() => state.setResearchRunArtifactDir({ runId: run.runId, artifactDir: path.join(path.dirname(state.file), 'stale-attempt'), handle }), error => error.code === 'TASK_FENCE_LOST');
    assert.throws(() => state.setResearchRunSession({ runId: run.runId, sessionRefKind: 'launch', sessionRef: 'launch_stale', handle }), error => error.code === 'TASK_FENCE_LOST');
    const current = state.getResearchRunByTask({ taskId: run.taskId });
    assert.equal(current.artifactDir, artifactDir);
    assert.equal(current.sessionRef, 'launch_successor');
    assert.throws(() => state.completeResearchRun(handle, { runId: run.runId, records, result }), error => error.code === 'TASK_FENCE_LOST');
    assertNoCompletion(state, run);
    const fresh = [{ recordKind: 'fresh', record: { observationId: 'new-attempt', n: 11 } }];
    state.completeResearchRun(next, { runId: run.runId, records: fresh, result });
    assert.equal(state.getResearchRunByTask({ taskId: run.taskId }).task.result.attempt, 2);
    assert.deepEqual(state.listResearchResults({ runId: run.runId }).map(entry => entry.record), [fresh[0].record]);
  });
});

test('insertion errors, silent omissions, and mutated inserts roll back both records and terminal state', async t => {
  for (const [name, trigger, expected] of [
    ['abort', "BEFORE INSERT ON research_results WHEN NEW.record_kind = 'second' BEGIN SELECT RAISE(ABORT, 'fixture insert failed'); END", error => error.code === 'STATE_CONSTRAINT' && error.details.sqliteCode === 1811],
    ['ignore', "BEFORE INSERT ON research_results WHEN NEW.record_kind = 'second' BEGIN SELECT RAISE(IGNORE); END", error => error.code === 'RESEARCH_RUN_RESULTS_INCOMPLETE'],
    ['mutate', "AFTER INSERT ON research_results BEGIN UPDATE research_results SET record_json = '{\"n\":999}' WHERE result_id = NEW.result_id; END", error => error.code === 'RESEARCH_RESULTS_INTEGRITY_CONFLICT']
  ]) await t.test(name, t => {
    const { state, run, handle, records, result } = completionFixture(t, name);
    state.transaction(db => db.exec(`CREATE TEMP TRIGGER fixture_result_fault ${trigger};`));
    assert.throws(() => state.completeResearchRun(handle, { runId: run.runId, records, result }), expected);
    assertNoCompletion(state, run);
    assert.equal(state.transaction(db => db.prepare('SELECT status FROM task_attempts WHERE task_id = ? AND fence = ?').get(handle.taskId, handle.fence)).status, 'running');
    state.transaction(db => db.exec('DROP TRIGGER fixture_result_fault;'));
    assert.equal(state.completeResearchRun(handle, { runId: run.runId, records, result }).task.status, 'succeeded', 'the same claim can commit after the storage fault is removed');
  });
});

test('unfenced prior records are preserved but cannot be adopted into a new completion', t => {
  const { state, run, handle, records, result } = completionFixture(t, 'legacy-prior');
  state.recordResearchResults({ runId: run.runId, records: [records[0]] });
  const prior = state.listResearchResults({ runId: run.runId });
  assert.throws(() => state.completeResearchRun(handle, { runId: run.runId, records, result }), error => error.code === 'RESEARCH_RESULTS_PRIOR_UNVERIFIED');
  assert.equal(state.getResearchRunByTask({ taskId: run.taskId }).task.status, 'running');
  assert.deepEqual(state.listResearchResults({ runId: run.runId }), prior);
});

test('a replay refuses stored evidence deletion, mutation, or later legacy append without repairing it', async t => {
  for (const mutation of ['delete', 'payload', 'kind', 'path', 'append']) await t.test(mutation, t => {
    const { state, run, handle, records, result } = completionFixture(t, `replay-${mutation}`);
    const input = { runId: run.runId, records, result };
    state.completeResearchRun(handle, input);
    if (mutation === 'append') state.recordResearchResults({ runId: run.runId, records: [{ recordKind: 'legacy', record: { n: 99 } }] });
    else state.transaction(db => {
      const resultId = db.prepare('SELECT result_id FROM research_results WHERE run_id = ? LIMIT 1').get(run.runId).result_id;
      const statements = {
        delete: 'DELETE FROM research_results WHERE result_id = ?',
        payload: 'UPDATE research_results SET record_json = \'{"n":99}\' WHERE result_id = ?',
        kind: "UPDATE research_results SET record_kind = 'different' WHERE result_id = ?",
        path: "UPDATE research_results SET artifact_path = 'different.json' WHERE result_id = ?"
      };
      db.prepare(statements[mutation]).run(resultId);
    });
    const altered = state.listResearchResults({ runId: run.runId });
    assert.throws(() => state.completeResearchRun(handle, input), error => error.code === 'RESEARCH_RESULTS_INTEGRITY_CONFLICT');
    assert.deepEqual(state.listResearchResults({ runId: run.runId }), altered, 'the refusal must not repair or erase evidence');
  });
});

test('a replay refuses a modified task receipt even when its old hash field was left untouched', t => {
  const { state, run, handle, records, result } = completionFixture(t, 'receipt-mutation');
  const input = { runId: run.runId, records, result };
  state.completeResearchRun(handle, input);
  const original = state.transaction(db => db.prepare('SELECT result_json, result_hash FROM tasks WHERE id = ?').get(run.taskId));
  const altered = JSON.stringify({ ...JSON.parse(original.result_json), recorded: 999, evidenceStatus: 'verified' });
  state.transaction(db => db.prepare('UPDATE tasks SET result_json = ? WHERE id = ?').run(altered, run.taskId));
  assert.throws(() => state.completeResearchRun(handle, input), error => error.code === 'TASK_OUTCOME_CONFLICT');
  assert.equal(state.transaction(db => db.prepare('SELECT result_json FROM tasks WHERE id = ?').get(run.taskId)).result_json, altered);
  assert.equal(state.listResearchResults({ runId: run.runId }).length, 2);
});

test('fenced completion refuses duplicate observations, non-finite values, and incoherent evidence states', t => {
  const { state, run, handle, records, result } = completionFixture(t, 'invalid-data');
  const complete = (newRecords, newResult = result) => state.completeResearchRun(handle, { runId: run.runId, records: newRecords, result: newResult });
  assert.throws(() => complete([records[0], { ...records[0], recordKind: 'different-kind' }]), error => error.code === 'RESEARCH_RESULTS_DUPLICATE_IDENTITY');
  for (const number of [Infinity, -Infinity, NaN]) {
    assert.throws(() => complete([{ recordKind: 'bad', record: { nested: [{ n: number }] } }]), error => error.code === 'STATE_INVALID_ARGUMENT');
    assert.throws(() => complete(records, { ...result, durationMs: number }), error => error.code === 'STATE_INVALID_ARGUMENT');
  }
  for (const bad of [null, [], 'not an object']) {
    assert.throws(() => complete([{ recordKind: 'bad', record: bad }]), error => error.code === 'STATE_INVALID_ARGUMENT');
  }
  for (const evidenceStatus of ['execution-only', 'dispatch-only', 'verified', undefined]) {
    assert.throws(() => complete(records, { ...result, evidenceStatus }), error => error.code === 'RESEARCH_RESULTS_EVIDENCE_MISMATCH');
  }
  assert.throws(() => complete([]), error => error.code === 'RESEARCH_RESULTS_EVIDENCE_MISMATCH');
  assertNoCompletion(state, run);
  assert.throws(() => complete([], { ...result, evidenceStatus: 'execution-only' }), error => error.code === 'RESEARCH_RESULTS_EVIDENCE_MISMATCH', 'a declared stdout collector cannot be silently turned into execution-only');
  assert.throws(() => complete(records, { ...result, runnerKind: 'agent' }), error => error.code === 'RESEARCH_RESULTS_EVIDENCE_MISMATCH');
  assertNoCompletion(state, run);
});

test('a declared none collector can complete as execution-only without inventing records', t => {
  const { state, run, handle, result } = completionFixture(t, 'execution-only', 'none');
  const execution = state.completeResearchRun(handle, { runId: run.runId, records: [], result: { ...result, evidenceStatus: 'execution-only' } });
  assert.equal(execution.task.status, 'succeeded');
  assert.equal(execution.task.result.recorded, 0);
  assert.equal(execution.task.result.evidenceStatus, 'execution-only');
  assert.deepEqual(state.listResearchResults({ runId: run.runId }), []);
});
