// EXECUTABLE CHANGE
// Mutation report: removing RESEARCH_ARTIFACT_STAT_UNAVAILABLE from the EBUSY
// path made the artifact test RED (expected the uncertainty record, received
// undefined; exit 1). The edit was confirmed in the module before the command.
// Byte-for-byte restoration matched the pre-mutation SHA-256
// ebe4a9769f8487ced4aacef4b211fcb34cbb0335ada9c19b0ab0f6748a68f902.
// NOT-FOUND: empty loop/forEach assertions; exit-status/truthy-return-only
// assertions; swallowed failures in try/catch or optional chains; assertions
// against a mock of their subject; file-wide skips or platform guards; expected
// values computed by the same code under test. PRECONDITION: Node >=22.19 is
// required for node:sqlite; /root/.nvm/versions/node/v22.22.2/bin/node was used.
// REPORTED, NOT CHANGED: the immutable-experiment assertion receives the
// StateStoreError produced by the state layer, not a ResearchError, so imposing
// the provider's error class there would reject the product's current contract.

'use strict';

// ResearchControl: the gates refuse with the deciding sentence, the content
// fence refuses credentials without refusing science, and the reserved queue
// cannot be driven by the public task surface.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createStateStore } = require('../src/lib/state-store');
const { ResearchControl, ResearchError } = require('../src/lib/providers/research');
const tasks = require('../src/lib/providers/tasks');

const auditRequire = () => ({ durable: true });
const enabled = { state: 'enabled', why: null };
const withheld = why => ({ state: 'withheld', why });

function onGate() {
  return {
    pipelineWithheld: false, pipeline: enabled,
    runners: { agent: withheld('"research.runner_agent" is off.'), process: enabled, http: withheld('"research.runner_http" is off.') }
  };
}
function offGate() {
  return {
    pipelineWithheld: true, pipeline: withheld('"research.pipeline" is off.'),
    runners: { agent: withheld('off'), process: withheld('off'), http: withheld('off') }
  };
}

function build(gate = onGate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-provider-'));
  const state = createStateStore({ file: path.join(dir, 'state.sqlite3') });
  state.health();
  return { state, dir, control: new ResearchControl({ state, gate, auditRequire }) };
}

const SPEC = projectId => ({
  projectId, name: 'grid', runnerKind: 'process',
  runnerConfig: { command: 'node', args: ['-e', 'console.log(1)'], stdin: 'none' },
  resultSchema: { fields: { n: 'number' }, required: ['n'] },
  collector: { kind: 'stdout-json' }
});

test('project creation rejects a non-boolean enabled value without creating a record', t => {
  const { state, control } = build();
  t.after(() => state.close());
  assert.throws(() => control.projectSave({ actor: 'human', name: 'Malformed enabled fixture', enabled: 'yes' }),
    error => error.code === 'RESEARCH_INPUT_INVALID');
  assert.deepEqual(state.listResearchProjects(), []);
});

test('a malformed enabled update cannot silently disable an existing project', t => {
  const { state, control } = build();
  t.after(() => state.close());
  const { project } = control.projectSave({ actor: 'human', name: 'Enabled fixture', enabled: true });
  assert.throws(() => control.projectSave({ actor: 'human', projectId: project.projectId, enabled: 'yes' }),
    error => error.code === 'RESEARCH_INPUT_INVALID');
  assert.deepEqual(state.getResearchProject({ projectId: project.projectId }), project);
});

const EAA_EXPERIMENT_ID = 'rx-eaa531abe68c3c01a34762b486b1cfd0bf61';
const ORDINARY_EXPERIMENT_ID = `rx-${'1'.repeat(36)}`;
const EAA_PARAMS_HASH = 'eaa348de8d7094449125f84f6a00da81fbf2f024850c04f726b32c75e75157c0';

function referenceFixture(t, experimentId) {
  const built = build();
  t.after(() => built.state.close());
  const originalId = built.state._researchId.bind(built.state);
  // A deterministic generated-ID dependency, not a bypass of submission.
  built.state._researchId = prefix => prefix === 'rx' ? experimentId : originalId(prefix);
  const { project } = built.control.projectSave({ actor: 'human', name: 'Reference fixture', enabled: true });
  const { experiment } = built.control.experimentSave({ actor: 'human', ...SPEC(project.projectId) });
  return { ...built, experiment };
}

function expectedResearchDefinition(experimentId, params) {
  const paramsHash = crypto.createHash('sha256').update(JSON.stringify(params)).digest('hex');
  const objective = JSON.stringify({ experimentId, paramsHash });
  const title = `Research run ${paramsHash.slice(0, 12)}`;
  // Explicit canonical field order, independent of the production hash helper.
  const inputHash = crypto.createHash('sha256').update(JSON.stringify({
    availableAtMs: null, expiryPolicy: 'retry', maxAttempts: 6, maxRetryBackoffMs: 3600000,
    payload: { objective, title }, priority: 0, queue: 'research-runs', retryBackoffMs: 1000, type: 'research-run'
  })).digest('hex');
  return { paramsHash, objective, title, inputHash, bodyJson: JSON.stringify({ objective, title }),
    idempotencyKey: `run:${experimentId}:${paramsHash.slice(0, 32)}` };
}

for (const [name, experimentId, params] of [
  ['EAA-leading generated experiment ID', EAA_EXPERIMENT_ID, { replicate: 0 }],
  ['EAA-leading computed parameter hash', ORDINARY_EXPERIMENT_ID, { replicate: 4982 }]
]) test(`typed research references accept an ${name} without changing saved bytes or replay`, t => {
  const { state, control } = referenceFixture(t, experimentId);
  const expected = expectedResearchDefinition(experimentId, params);
  if (params.replicate === 4982) assert.equal(expected.paramsHash, EAA_PARAMS_HASH);
  const submitted = control.runSubmit({ actor: 'human', experimentId, params });
  assert.equal(submitted.disposition, 'submitted');
  assert.equal(submitted.run.experimentId, experimentId);
  assert.equal(submitted.run.paramsHash, expected.paramsHash);
  assert.deepEqual(submitted.run.params, params);
  const stored = state.transaction(db => db.prepare('SELECT body_json, input_hash, idempotency_key FROM tasks WHERE id = ?').get(submitted.run.taskId));
  assert.equal(stored.body_json, expected.bodyJson);
  assert.equal(stored.input_hash, expected.inputHash);
  assert.equal(stored.idempotency_key, expected.idempotencyKey);
  const replay = control.runSubmit({ actor: 'human', experimentId, params });
  assert.equal(replay.disposition, 'replay');
  assert.equal(replay.run.runId, submitted.run.runId);
  assert.equal(replay.run.taskId, submitted.run.taskId);
  for (const change of [{ priority: 1 }, { maxAttempts: 5 }, { availableAtMs: 1 }]) {
    assert.throws(() => control.runSubmit({ actor: 'human', experimentId, params, ...change }),
      error => error.code === 'TASK_IDEMPOTENCY_CONFLICT');
  }
});

test('typed research references preserve replay of a pre-existing ordinary task definition', t => {
  const experimentId = ORDINARY_EXPERIMENT_ID;
  const { state, control } = referenceFixture(t, experimentId);
  const params = { replicate: 0 };
  const expected = expectedResearchDefinition(experimentId, params);
  // Seed a real task using the original, unbranded generic payload path. This
  // is the pre-change representation, not an expected hash from the new path.
  const { task } = state.submitTask({
    queue: 'research-runs', type: 'research-run', idempotencyKey: expected.idempotencyKey,
    payload: { title: expected.title, objective: expected.objective },
    priority: 0, maxAttempts: 6, expiryPolicy: 'retry'
  });
  const runId = state._researchId('rr');
  state.transaction(db => db.prepare(`INSERT INTO research_runs
    (run_id,experiment_id,task_id,params_json,params_hash,created_at_ms) VALUES(?,?,?,?,?,?)`)
    .run(runId, experimentId, task.id, JSON.stringify(params), expected.paramsHash, Date.now()));
  const replay = control.runSubmit({ actor: 'human', experimentId, params });
  assert.equal(replay.disposition, 'replay');
  assert.equal(replay.run.runId, runId);
  assert.equal(replay.run.taskId, task.id);
  const stored = state.transaction(db => db.prepare('SELECT input_hash FROM tasks WHERE id = ?').get(task.id));
  assert.equal(stored.input_hash, expected.inputHash);
});

test('typed research references are unforgeable by caller fields, cloned payloads or another queue', t => {
  const { state, control } = referenceFixture(t, EAA_EXPERIMENT_ID);
  const originalPrepare = state._prepareTaskSubmission.bind(state);
  let captured;
  state._prepareTaskSubmission = input => {
    captured = input.payload;
    assert.equal(Object.isFrozen(captured), true);
    assert.throws(() => { captured.objective = 'credential-shaped content'; }, TypeError);
    assert.throws(() => originalPrepare({ ...input, queue: 'ordinary-research-fixture' }),
      error => error.code === 'TASK_SECRET_REJECTED');
    assert.throws(() => originalPrepare({ ...input, type: 'ordinary-fixture' }),
      error => error.code === 'TASK_SECRET_REJECTED');
    return originalPrepare(input);
  };
  control.runSubmit({ actor: 'human', experimentId: EAA_EXPERIMENT_ID, params: { replicate: 0 } });
  state._prepareTaskSubmission = originalPrepare;
  for (const payload of [captured, JSON.parse(JSON.stringify(captured))]) {
    assert.throws(() => state.submitTask({
      queue: 'research-runs', type: 'research-run', idempotencyKey: 'unbranded-references-fixture',
      payload, allowSecrets: true, typedReferences: true
    }), error => error.code === 'TASK_SECRET_REJECTED', 'the private brand is consumed and cannot be acquired from JSON');
  }
  assert.throws(() => control.runSubmit({ actor: 'human', experimentId: EAA_EXPERIMENT_ID,
    params: { replicate: 0 }, typedReferences: true }), error => error.code === 'RESEARCH_INPUT_INVALID');
});

test('typed research references do not relax credential or Authorization rejection', t => {
  const { state, control, experiment } = referenceFixture(t, EAA_EXPERIMENT_ID);
  // Synthetic token shapes only; no provider credential is read or used.
  const credentialShapes = ['EAA' + 'X'.repeat(32), 'eaa' + 'f'.repeat(32),
    'ghp_' + 'x'.repeat(32), 'Bearer ' + 'x'.repeat(32)];
  for (const credential of credentialShapes) for (const field of ['title', 'objective', 'context']) {
    assert.throws(() => state.submitTask({
      queue: 'research-runs', type: 'research-run', idempotencyKey: 'credential-refusal-fixture',
      payload: { title: 'Fixture', objective: 'Fixture', [field]: credential },
      allowSecrets: true, typedReferences: true
    }), error => error.code === 'TASK_SECRET_REJECTED');
  }
  for (const params of [{ authorization: 'Bearer ' + 'x'.repeat(32) }, { value: 'ghp_' + 'x'.repeat(32) }]) {
    assert.throws(() => control.runSubmit({ actor: 'human', experimentId: EAA_EXPERIMENT_ID, params }),
      error => error.code === 'RESEARCH_SENSITIVE_CONTENT');
  }
  assert.throws(() => control.runSubmit({ actor: 'human',
    experiment: { ...SPEC(experiment.projectId), name: 'Credential config refusal',
      runnerConfig: { command: 'unused', args: ['Authorization: Bearer ' + 'x'.repeat(32)] } }, params: {} }),
  error => error.code === 'RESEARCH_SENSITIVE_CONTENT');
  assert.equal(state.transaction(db => db.prepare('SELECT COUNT(*) AS count FROM research_runs').get().count), 0);
});

test('typed research references require an existing active generated experiment row', t => {
  const { state } = referenceFixture(t, ORDINARY_EXPERIMENT_ID);
  const run = experimentId => ({ experimentId, params: { replicate: 4982 } });
  assert.throws(() => state.submitResearchRun(run(EAA_EXPERIMENT_ID)), error => error.code === 'RESEARCH_EXPERIMENT_NOT_FOUND');
  state.updateResearchExperiment({ experimentId: ORDINARY_EXPERIMENT_ID, status: 'archived' });
  assert.throws(() => state.submitResearchRun(run(ORDINARY_EXPERIMENT_ID)), error => error.code === 'RESEARCH_EXPERIMENT_ARCHIVED');
  // The real schema independently forbids manufacturing a non-generated row;
  // do not disable its CHECK constraint merely to reach a defensive branch.
  assert.throws(() => state.transaction(db => db.prepare('UPDATE research_experiments SET experiment_id = ?, status = ? WHERE experiment_id = ?')
    .run('rx-not-a-generated-id', 'active', ORDINARY_EXPERIMENT_ID)), error => error.code === 'STATE_CONSTRAINT');
  assert.throws(() => state.submitResearchRun(run('rx-not-a-generated-id')), error => error.code === 'RESEARCH_EXPERIMENT_NOT_FOUND');
  assert.equal(state.transaction(db => db.prepare('SELECT COUNT(*) AS count FROM research_runs').get().count), 0);
  assert.equal(state.transaction(db => db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count), 0);
});

test('the pipeline gate refuses submission with the deciding sentence', () => {
  const { state, control } = build(offGate);
  const { project } = control.projectSave({ actor: 'human', name: 'Demo', enabled: true });
  assert.throws(() => control.runSubmit({ actor: 'human', experiment: SPEC(project.projectId), params: { a: 1 } }),
    error => error instanceof ResearchError && error.code === 'RESEARCH_PIPELINE_DISABLED' && /research\.pipeline/.test(error.message));
  state.close();
});

test('the runner-kind gate and the project flag each refuse by name', () => {
  const { state, control } = build();
  const { project } = control.projectSave({ actor: 'human', name: 'Demo', enabled: true });
  assert.throws(() => control.runSubmit({
    actor: 'human',
    experiment: { ...SPEC(project.projectId), name: 'agentic', runnerKind: 'agent', runnerConfig: { briefTemplate: 'do {a}' } },
    params: { a: 1 }
  }), error => error instanceof ResearchError && error.code === 'RESEARCH_RUNNER_DISABLED' && /runner_agent/.test(error.message));

  const submitted = control.runSubmit({ actor: 'human', experiment: SPEC(project.projectId), params: { a: 1 } });
  control.projectSave({ actor: 'human', projectId: project.projectId, enabled: false });
  assert.throws(() => control.runSubmit({ actor: 'human', experimentId: submitted.experiment.experimentId, params: { a: 2 } }),
    error => error instanceof ResearchError && error.code === 'RESEARCH_PROJECT_DISABLED');
  state.close();
});

const submissionRows = state => state.transaction(db => ({
  experiments: db.prepare('SELECT * FROM research_experiments ORDER BY experiment_id').all(),
  runs: db.prepare('SELECT * FROM research_runs ORDER BY run_id').all(),
  tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all()
}));

for (const item of [
  { name: 'nondurable audit', auditRefused: true, code: 'RESEARCH_AUDIT_REQUIRED' },
  { name: 'withheld runner', runnerWithheld: true, code: 'RESEARCH_RUNNER_DISABLED' },
  { name: 'disabled project', projectDisabled: true, code: 'RESEARCH_PROJECT_DISABLED' },
  { name: 'invalid priority', input: { priority: 101 }, code: 'STATE_INVALID_ARGUMENT' },
  { name: 'invalid attempt bound', input: { maxAttempts: 0 }, code: 'STATE_INVALID_ARGUMENT' },
  { name: 'failed run insert after task creation', insertRefused: true, code: 'STATE_CONSTRAINT' },
  { name: 'existing inline experiment and refused audit', existing: true, auditRefused: true, code: 'RESEARCH_AUDIT_REQUIRED' }
]) test(`inline submission preserves all metadata after ${item.name}`, t => {
  const { state, dir, control } = build(() => ({ ...onGate(),
    runners: { ...onGate().runners, process: item.runnerWithheld ? withheld('Synthetic process runner off') : enabled } }));
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { project } = control.projectSave({ actor: 'human', name: 'Inline refusal', enabled: !item.projectDisabled });
  const experiment = SPEC(project.projectId);
  if (item.existing) control.experimentSave({ actor: 'human', ...experiment });
  if (item.insertRefused) state.transaction(db => db.exec(`CREATE TEMP TRIGGER fixture_inline_run_refusal
    BEFORE INSERT ON research_runs BEGIN SELECT RAISE(ABORT, 'Synthetic run insert failure'); END;`));
  const before = submissionRows(state), auditCalls = [];
  control.auditRequire = (action, target) => { auditCalls.push({ action, target }); return { durable: !item.auditRefused }; };
  assert.throws(() => control.runSubmit({ actor: 'human', experiment, params: { fixture: 1 }, ...item.input }), error => error.code === item.code);
  assert.deepEqual(submissionRows(state), before, 'A refused combined operation must preserve experiment, run and task rows.');
  if (item.auditRefused) assert.equal(auditCalls.length, 1);
  if (item.runnerWithheld || item.projectDisabled) assert.equal(auditCalls.length, 0);
});

test('inline admission audits its exact identity before insertion and commits one replayable run', t => {
  const { state, dir, control } = build();
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { project } = control.projectSave({ actor: 'human', name: 'Atomic inline control', enabled: true });
  const auditCalls = [];
  control.auditRequire = (action, target) => {
    // The test inspects the same SQLite connection so an uncommitted early
    // insert cannot masquerade as an audit-before-write transition.
    auditCalls.push({ action, target,
      experiments: state._db.prepare('SELECT COUNT(*) AS count FROM research_experiments').get().count,
      runs: state._db.prepare('SELECT COUNT(*) AS count FROM research_runs').get().count,
      tasks: state._db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count });
    return { durable: true };
  };
  const input = { actor: 'human', experiment: SPEC(project.projectId), params: { fixture: 1 } };
  const first = control.runSubmit(input), repeated = control.runSubmit(input);
  assert.equal(first.disposition, 'submitted'); assert.equal(repeated.disposition, 'replay');
  assert.equal(repeated.run.runId, first.run.runId); assert.equal(repeated.experiment.experimentId, first.experiment.experimentId);
  assert.deepEqual(auditCalls, [
    { action: 'research.run_submit', target: first.experiment.experimentId, experiments: 0, runs: 0, tasks: 0 },
    { action: 'research.run_submit', target: first.experiment.experimentId, experiments: 1, runs: 1, tasks: 1 }
  ]);
  const rows = submissionRows(state);
  assert.equal(rows.experiments.length, 1); assert.equal(rows.runs.length, 1); assert.equal(rows.tasks.length, 1);
  assert.equal(rows.tasks[0].status, 'queued');
});

test('inline admission refuses missing, asynchronous and nested callbacks without writes', t => {
  const { state, dir, control } = build();
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { project } = control.projectSave({ actor: 'human', name: 'Synchronous inline admission', enabled: true });
  const input = { experiment: SPEC(project.projectId), params: {} };
  const before = submissionRows(state);
  let asyncEntered = false;
  for (const [admit, code] of [
    [undefined, 'STATE_INVALID_ARGUMENT'],
    [async () => { asyncEntered = true; }, 'STATE_INVALID_ARGUMENT'],
    [() => Promise.reject(new Error('Synthetic asynchronous admission refusal')), 'STATE_TRANSACTION_ASYNC'],
    [() => state.transaction(() => {}), 'STATE_TRANSACTION_NESTED']
  ]) {
    assert.throws(() => state.registerAndSubmitResearchRun(input, admit), error => error.code === code);
    assert.deepEqual(submissionRows(state), before);
  }
  assert.equal(asyncEntered, false, 'A declared async admission callback must not be entered.');
  const admitted = control.runSubmit({ actor: 'human', ...input });
  assert.equal(admitted.disposition, 'submitted', 'A refused transaction must release its scope for the next valid submission.');
});

test('inline full-queue refusal rolls back registration while replay preserves identity and first attribution', t => {
  const { state, dir, control } = build();
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { project } = control.projectSave({ actor: 'human', name: 'Inline capacity control', enabled: true });
  const input = { actor: 'human', experiment: SPEC(project.projectId), params: { z: 1, a: 2 },
    sessionRefKind: 'observed', sessionRef: 'first-session' };
  const first = control.runSubmit(input);
  for (let i = 0; i < 127; i++) state.submitResearchRun({ experimentId: first.experiment.experimentId, params: { capacity: i } });
  const full = submissionRows(state);
  assert.equal(full.tasks.length, 128);
  assert.throws(() => control.runSubmit({ ...input,
    experiment: { ...input.experiment, name: 'New configuration', runnerConfig: { ...input.experiment.runnerConfig, command: 'another-unused-command' } }
  }), error => error.code === 'TASK_QUEUE_FULL');
  assert.deepEqual(submissionRows(state), full, 'Queue refusal must roll back the newly inserted experiment.');
  const replay = control.runSubmit({ ...input, experiment: { ...input.experiment, name: 'Ignored replay rename' }, sessionRef: 'later-session' });
  assert.equal(replay.disposition, 'replay', 'An existing identical task must replay even when its queue is full.');
  assert.equal(replay.run.runId, first.run.runId);
  assert.equal(replay.experiment.name, first.experiment.name);
  assert.equal(replay.run.sessionRef, 'first-session');
  assert.equal(replay.run.sessionRefKind, 'observed');
  for (const changed of [{ priority: 1 }, { maxAttempts: 7 }, { availableAtMs: 1 }]) {
    assert.throws(() => control.runSubmit({ ...input, ...changed }), error => error.code === 'TASK_IDEMPOTENCY_CONFLICT');
  }
  assert.deepEqual(submissionRows(state), full, 'Replay and conflicting definitions must not rewrite saved metadata or attribution.');
  const saved = full.runs.find(row => row.run_id === first.run.runId);
  assert.equal(saved.params_json, JSON.stringify(input.params), 'Existing JSON property order remains part of the params hash contract.');
  assert.equal(full.experiments[0].runner_config_json, JSON.stringify(input.experiment.runnerConfig));
});

test('explicit experiment registration remains available on a disabled project', t => {
  const { state, dir, control } = build();
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { project } = control.projectSave({ actor: 'human', name: 'Disabled catalog control', enabled: false });
  const registered = control.experimentSave({ actor: 'human', ...SPEC(project.projectId) });
  assert.equal(registered.disposition, 'created');
  const before = submissionRows(state);
  assert.equal(before.experiments.length, 1);
  assert.throws(() => control.runSubmit({ actor: 'human', experimentId: registered.experiment.experimentId, params: {} }),
    error => error.code === 'RESEARCH_PROJECT_DISABLED');
  assert.deepEqual(submissionRows(state), before);
});

test('the content fence refuses credentials and accepts timestamps and seeds', () => {
  const { state, control } = build();
  const { project } = control.projectSave({ actor: 'human', name: 'Demo', enabled: true });
  assert.throws(() => control.runSubmit({
    actor: 'human',
    experiment: { ...SPEC(project.projectId), name: 'leaky', runnerConfig: { command: 'curl', args: ['-H', 'Authorization: Bearer abcdefghijklmnop1234'] } },
    params: { a: 1 }
  }), error => error instanceof ResearchError && error.code === 'RESEARCH_SENSITIVE_CONTENT');
  // Millisecond timestamps and long numeric seeds are ordinary science; a
  // fence that refuses them teaches config authors to obfuscate.
  const ok = control.runSubmit({
    actor: 'human', experiment: SPEC(project.projectId),
    params: { seed: 20260814120000, atMs: 1765650000000 }
  });
  assert.equal(ok.disposition, 'submitted');
  state.close();
});

test('the public task surface can neither submit to nor read the reserved research-runs queue', async () => {
  const { state, control } = build();
  const { project } = control.projectSave({ actor: 'human', name: 'Demo', enabled: true });
  const submitted = control.runSubmit({ actor: 'human', experiment: SPEC(project.projectId), params: { a: 1 } });

  await assert.rejects(tasks.submit({
    queue: 'research-runs', type: 'research-run', idempotencyKey: 'research-bypass-0001',
    expiryPolicy: 'retry', maxAttempts: 1,
    payload: { title: 'Bypass', objective: 'Unsafe direct route.' }
  }, { state }), /reserved/);
  await assert.rejects(tasks.claim({ queue: 'research-runs', types: ['research-run'], workerLabel: 'generic', leaseSeconds: 300 }, { state }),
    error => error.code === 'TASK_QUEUE_RESERVED');
  await assert.rejects(tasks.get({ taskId: submitted.run.taskId, includePayload: true }, { state }),
    error => error.code === 'TASK_QUEUE_RESERVED');
  assert.equal((await tasks.list({}, { state })).count, 0, 'reserved tasks are invisible to the public list');

  const wrapped = tasks.internalResearchRunsState(state);
  const claimed = await tasks.claim({ queue: 'research-runs', types: ['research-run'], workerLabel: 'internal', leaseSeconds: 300 }, { state: wrapped });
  assert.equal(claimed.claimed, true, 'the internal wrapper passes the same fence');
  state.close();
});

test('experiment save is create-or-match and the update path cannot mutate config', () => {
  const { state, control } = build();
  const { project } = control.projectSave({ actor: 'human', name: 'Demo', enabled: true });
  const created = control.experimentSave({ actor: 'human', ...SPEC(project.projectId) });
  assert.equal(created.disposition, 'created');
  const replay = control.experimentSave({ actor: 'human', ...SPEC(project.projectId), name: 'renamed' });
  assert.equal(replay.disposition, 'replay');
  assert.throws(() => control.experimentSave({
    actor: 'human', experimentId: created.experiment.experimentId, runnerConfig: { command: 'other' }
  }), error => error.code === 'RESEARCH_EXPERIMENT_IMMUTABLE');
  state.close();
});

test('assignment writes resolve later sessions through the live all rule', () => {
  const { state, control } = build();
  const { project } = control.projectSave({ actor: 'human', name: 'Demo', enabled: true });
  const assigned = control.sessionAssign({ actor: 'human', projectId: project.projectId, assign: [{ kind: 'all' }] });
  assert.equal(assigned.assigned[0].disposition, 'assigned');
  const resolved = control.sessionContext({ refs: [{ kind: 'observed', ref: 'later-session' }] });
  assert.equal(resolved.projects.length, 1);
  const removed = control.sessionAssign({ actor: 'human', projectId: project.projectId, unassign: [{ kind: 'all', ref: '*' }] });
  assert.equal(removed.unassigned[0].kind, 'all');
  assert.equal(control.sessionContext({ refs: [{ kind: 'observed', ref: 'later-session' }] }).projects.length, 0);
  state.close();
});

test('assignment-ID removal cannot change a different project through ResearchControl', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-assignment-project-'));
  const state = createStateStore({ file: path.join(dir, 'state.sqlite3') });
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  state.health();
  const control = new ResearchControl({ state, gate: onGate, auditRequire });
  const first = control.projectSave({ actor: 'human', name: 'First project', enabled: true }).project;
  const second = control.projectSave({ actor: 'human', name: 'Second project', enabled: true }).project;
  const { assigned } = control.sessionAssign({ actor: 'human', projectId: second.projectId, assign: [{ kind: 'all' }] });
  const before = state.listResearchSessionAssignments({ activeOnly: false });

  let refusal;
  try {
    control.sessionAssign({ actor: 'human', projectId: first.projectId, unassign: [{ assignmentId: assigned[0].assignmentId }] });
  } catch (error) { refusal = error; }
  assert.deepEqual(state.listResearchSessionAssignments({ activeOnly: false }), before,
    'a refused project selection must not deactivate another project\'s live rule');
  assert.equal(refusal?.code, 'RESEARCH_ASSIGNMENT_NOT_FOUND');

  const removed = control.sessionAssign({
    actor: 'human', projectId: second.projectId, unassign: [{ assignmentId: assigned[0].assignmentId }]
  });
  assert.equal(removed.projectId, second.projectId);
  assert.equal(removed.unassigned[0].projectId, second.projectId);
  assert.equal(removed.unassigned[0].assignmentId, assigned[0].assignmentId);
  assert.equal(state.listResearchSessionAssignments({}).length, 0);
  assert.equal(state.listResearchSessionAssignments({ activeOnly: false })[0].active, false);
});

test('the single-run read carries the checkpoint body and a bounded artifact listing', async () => {
  const { state, control } = build();
  const { project } = control.projectSave({ actor: 'human', name: 'Demo', enabled: true });
  const submitted = control.runSubmit({ actor: 'human', experiment: SPEC(project.projectId), params: { a: 1 } });

  // Drive a real checkpoint through the internal task surface, the way the
  // worker does, so the drill-in read is proven against the same machinery.
  const wrapped = tasks.internalResearchRunsState(state);
  const claimed = await tasks.claim({ queue: 'research-runs', types: ['research-run'], workerLabel: 'drill', leaseSeconds: 300 }, { state: wrapped });
  await tasks.start({ handle: claimed.handle, leaseSeconds: 300 }, { state: wrapped });
  await tasks.checkpoint({
    handle: claimed.handle, checkpointKey: `drill-${claimed.handle.taskId}-001`, expectedRevision: 0, extendSeconds: 300,
    checkpoint: { summary: 'Preflight passed; the run is admitted.', resumeContext: '{"phase":"preflight"}' }
  }, { state: wrapped });

  const artifactDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'research-drill-')), 'run');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'output.json'), '{"n":1}');
  state.setResearchRunArtifactDir({ runId: submitted.run.runId, artifactDir });

  const run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.latestCheckpoint.checkpoint.summary, 'Preflight passed; the run is admitted.',
    'the joined task carries the checkpoint BODY, not just its revision');
  assert.equal(run.artifacts.length, 1);
  assert.equal(run.artifacts[0].name, 'output.json');
  assert.equal(run.artifacts[0].bytes, 7);

  // A transient stat failure is uncertainty, not a claim that the named file
  // is absent. It is not latched: the next drill-in retries and can recover.
  const realStatSync = fs.statSync;
  let artifactStats = 0;
  let failureCode = 'EBUSY';
  fs.statSync = (target, ...args) => {
    if (target === path.join(artifactDir, 'output.json') && artifactStats++ === 0) {
      const error = new Error('machine busy');
      error.code = failureCode;
      throw error;
    }
    return realStatSync(target, ...args);
  };
  try {
    const uncertain = control.runs({ runId: submitted.run.runId }).runs[0].artifacts[0];
    assert.equal(uncertain.bytes, null);
    assert.deepEqual(uncertain.bytesError, {
      code: 'RESEARCH_ARTIFACT_STAT_UNAVAILABLE',
      message: 'The artifact size could not be read; this is not claiming that the artifact is absent.'
    });
    const retried = control.runs({ runId: submitted.run.runId }).runs[0].artifacts[0];
    assert.equal(retried.bytes, 7);
    assert.equal(retried.bytesError, undefined);

    // ENOENT alone retains the old, definite disappeared-between-reads shape.
    artifactStats = 0;
    failureCode = 'ENOENT';
    const disappeared = control.runs({ runId: submitted.run.runId }).runs[0].artifacts[0];
    assert.deepEqual(disappeared, { name: 'output.json', bytes: null });
  } finally {
    fs.statSync = realStatSync;
  }

  // CONTROL: durable lifecycle replays are the provider's legitimate cache;
  // uncertainty handling above must not remove that idempotency saving.
  let starts = 0;
  const lifecycle = new ResearchControl({
    state, gate: onGate, auditRequire,
    runtime: {
      start: () => ({ accepted: true, status: 'running', running: true, detail: `start-${++starts}` }),
      status: () => ({ status: 'running', running: true })
    }
  });
  const lifecycleRequest = { actor: 'human', action: 'start', idempotencyKey: 'research-lifecycle-control-0001' };
  assert.equal((await lifecycle.lifecycle(lifecycleRequest)).replayed, false);
  assert.equal((await lifecycle.lifecycle(lifecycleRequest)).replayed, true);
  assert.equal(starts, 1, 'a valid durable replay remains cached');

  // A list read (no runId) stays lean: no filesystem walk per run.
  const listed = control.runs({ experimentId: submitted.experiment.experimentId }).runs[0];
  assert.equal(listed.artifacts, undefined, 'artifact listing is the drill-in read only');
  state.close();
});

test('an action whose audit intent is not durable does not start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-provider-audit-'));
  const state = createStateStore({ file: path.join(dir, 'state.sqlite3') });
  state.health();
  const control = new ResearchControl({ state, gate: onGate, auditRequire: () => ({ durable: false }) });
  assert.throws(() => control.projectSave({ actor: 'human', name: 'Demo' }),
    error => error instanceof ResearchError && error.code === 'RESEARCH_AUDIT_REQUIRED');
  assert.equal(state.listResearchProjects({}).length, 0, 'nothing was written');
  state.close();
});
