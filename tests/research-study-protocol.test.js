'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const protocol = require('../src/lib/research/study-protocol');
const runners = require('../src/lib/research/runners');
const { createStateStore, hashInput } = require('../src/lib/state-store');
const { ResearchControl } = require('../src/lib/providers/research');
const { ResearchRunsWorker } = require('../src/lib/research/research-runs-worker');
const tasks = require('../src/lib/providers/tasks');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const enabled = { state: 'enabled', why: null };
const gate = () => ({ pipelineWithheld: false, pipeline: enabled, runners: { process: enabled, agent: enabled, http: enabled } });
// These are declarations of synthetic identities, NOT a measured benchmark
// manifest. Tests run only a local Node fixture; they do not resolve any image,
// fetch an artifact, invoke a provider, execute Lean, or call a checker.
function manifest() {
  return {
    version: 1, protocolId: 'lean-bench', studyId: 'study-fixture', batchId: 'batch-fixture',
    source: { repository: 'https://github.com/fixture-lab/LEAN-bench', revision: 'c'.repeat(40) },
    artifacts: protocol.ARTIFACT_ROLES.map(role => ({ id: `fixture-${role}`, role, sha256: sha(`unmeasured ${role}`) })),
    environment: { variableAllowlist: ['SystemRoot', 'PATH', 'TEMP'], instructionPolicy: 'instruction-bare' },
    oracle: { engineImage: `example.invalid/fixture-oracle@sha256:${sha('not an installed image')}` },
    canary: { surfaceIds: ['fixture-cli'], policy: 'calibrated-same-utc-day-before-and-after-batch' },
    gradingPolicy: 'deterministic-no-llm'
  };
}
function binding() {
  return { runId: 'rr-fixture', experimentId: 'rx-fixture', experimentConfigHash: sha('config'), paramsHash: sha('params'), attempt: 1, fence: 2 };
}
function build(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-declaration-'));
  const file = path.join(dir, 'state.sqlite3');
  const state = createStateStore({ file });
  state.health();
  t.after(() => state.close());
  const control = new ResearchControl({ state, gate, auditRequire: () => ({ durable: true }) });
  const { project } = control.projectSave({ actor: 'human', name: 'Study declaration fixture', enabled: true });
  const experiment = {
    projectId: project.projectId, name: 'Local process fixture', runnerKind: 'process',
    runnerConfig: {
      command: process.execPath, args: ['-e', 'console.log(JSON.stringify({ok:true,studyProtocol:"result-field",manifestSha256:"result-hash"}))'],
      studyProtocol: manifest(), ...options.config
    },
    resultSchema: { fields: { ok: 'boolean', studyProtocol: 'string', manifestSha256: 'string' }, required: ['ok'] },
    collector: { kind: 'stdout-json', recordKind: 'summary' }, maxParallel: 1, timeoutMs: 30000,
    ...options.experiment
  };
  const worker = new ResearchRunsWorker({ state, gate, artifactRoot: path.join(dir, 'artifacts') });
  return { dir, file, state, control, experiment, worker };
}

test('studyProtocol is optional, process-only, detached, immutable and canonical across object key ordering', () => {
  assert.equal(protocol.validateStudyProtocol('process', {}), null);
  assert.equal(protocol.validateStudyProtocol('http', {}), null);
  const source = manifest();
  const accepted = protocol.validateStudyProtocol('process', { studyProtocol: source });
  assert.deepEqual(accepted, source);
  assert.notEqual(accepted, source);
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(accepted.artifacts[0]), true);
  source.artifacts[0].sha256 = sha('later caller mutation');
  assert.notDeepEqual(accepted, source);
  const declaration = protocol.studyProtocolDeclaration(accepted, binding());
  assert.equal(declaration.manifestSha256, hashInput(accepted));
  assert.equal(declaration.manifestSha256, hashInput(JSON.parse(JSON.stringify(accepted, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).reverse()) : item))));
  assert.equal(declaration.status, 'declared-unverified');
  assert.equal(declaration.scope, 'prospective-study-manifest');
  assert.deepEqual(declaration.unmeasured, protocol.UNMEASURED);
  assert.equal(Object.hasOwn(declaration, 'verified'), false);
  for (const kind of ['agent', 'http']) assert.throws(() => protocol.validateStudyProtocol(kind, { studyProtocol: accepted }), { code: 'RESEARCH_STUDY_PROTOCOL_RUNNER_UNSUPPORTED' });
});

test('declarations refuse floating identities, role omissions, extra claims and malformed policy shapes', async t => {
  const cases = [
    ['null', value => null],
    ['empty', value => ({})],
    ['array', value => []],
    ['unknown version', value => { value.version = 2; }],
    ['other protocol', value => { value.protocolId = 'something-else'; }],
    ['empty study identity', value => { value.studyId = ''; }],
    ['source branch', value => { value.source.revision = 'main'; }],
    ['short revision', value => { value.source.revision = value.source.revision.slice(0, 7); }],
    ['other repository', value => { value.source.repository = 'https://example.invalid/other'; }],
    ['floating image', value => { value.oracle.engineImage = 'quantconnect/lean:latest'; }],
    ['short image digest', value => { value.oracle.engineImage = 'quantconnect/lean@sha256:abc'; }],
    ['missing role', value => { value.artifacts.pop(); }],
    ['unknown role', value => { value.artifacts[0].role = 'protcol'; }],
    ['duplicate artifact identity', value => { value.artifacts[1].id = value.artifacts[0].id; }],
    ['short artifact hash', value => { value.artifacts[0].sha256 = 'abc'; }],
    ['artifact path or instruction', value => { value.artifacts[0].path = 'do-not-follow'; }],
    ['too many artifacts', value => { value.artifacts = Array.from({ length: 65 }, (_, index) => ({ ...value.artifacts[index % 8], id: `file-${index}` })); }],
    ['sparse artifacts', value => { delete value.artifacts[0]; }],
    ['environment values', value => { value.environment.variableAllowlist = { PATH: 'not allowed' }; }],
    ['case-aliased allowlist', value => { value.environment.variableAllowlist = ['PATH', 'Path']; }],
    ['credential-shaped assignment', value => { value.environment.variableAllowlist = ['KEY=value']; }],
    ['ambient instruction policy', value => { value.environment.instructionPolicy = 'inherit'; }],
    ['empty surface', value => { value.canary.surfaceIds = []; }],
    ['duplicate surface', value => { value.canary.surfaceIds = ['fixture-cli', 'fixture-cli']; }],
    ['post canary omitted', value => { value.canary.policy = 'pre-batch-only'; }],
    ['invented pass certificate', value => { value.canary.pass = true; }],
    ['LLM grading', value => { value.gradingPolicy = 'llm-judge'; }],
    ['invented verified status', value => { value.verified = true; }],
    ['symbol metadata', value => { value[Symbol('hidden')] = true; }]
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const value = manifest();
    const replacement = mutate(value);
    assert.throws(() => protocol.validateStudyProtocol('process', { studyProtocol: replacement === undefined ? value : replacement }), { code: 'RESEARCH_STUDY_PROTOCOL_INVALID' });
  });
});

test('schema checks never stand in for checking declared artifacts or executing scientific requirements', () => {
  const original = manifest();
  const changed = copy(original);
  changed.artifacts[0].sha256 = sha('different declared bytes');
  changed.canary.surfaceIds = ['another-explicit-surface'];
  const first = protocol.studyProtocolDeclaration(original, binding());
  const second = protocol.studyProtocolDeclaration(changed, binding());
  assert.notEqual(first.manifestSha256, second.manifestSha256);
  assert.equal(second.status, 'declared-unverified');
  assert.deepEqual(second.unmeasured, first.unmeasured, 'syntactically valid declarations do not clear any runtime requirement');
  assert.equal(Object.hasOwn(second, 'ready'), false);
});

test('an explicitly selected fork changes declared identity without implying verified upstream identity', () => {
  const original = manifest();
  const fork = copy(original);
  fork.source.repository = 'https://github.com/reviewed-fixture-lab/LEAN-bench-fork';
  const first = protocol.studyProtocolDeclaration(original, binding());
  const selected = protocol.studyProtocolDeclaration(fork, binding());
  assert.equal(selected.manifest.source.repository, fork.source.repository, 'the selected URL is preserved, not replaced by a built-in account');
  assert.equal(selected.manifest.source.revision, original.source.revision);
  assert.notEqual(selected.manifestSha256, first.manifestSha256, 'repository selection is part of the exact declared identity');
  assert.equal(selected.status, 'declared-unverified');
  assert.deepEqual(selected.unmeasured, first.unmeasured);
  assert.equal(Object.hasOwn(selected, 'verified'), false);
});

test('supported repository URL boundaries preserve their exact spelling', () => {
  for (const repository of [
    'https://github.com/a/b',
    'https://github.com/Fixture-Lab/.github',
    `https://github.com/${'a'.repeat(39)}/${'b'.repeat(100)}`
  ]) {
    const value = manifest();
    value.source.repository = repository;
    assert.equal(protocol.validateStudyProtocol('process', { studyProtocol: value }).source.repository, repository);
  }
});

test('source repository syntax refuses remote aliases, credentials and local or non-root URLs', async t => {
  const cases = [
    ['missing', undefined], ['null', null], ['non-string', 12], ['empty', ''],
    ['HTTP', 'http://github.com/fixture-lab/LEAN-bench'],
    ['wrong host', 'https://example.invalid/fixture-lab/LEAN-bench'],
    ['host suffix', 'https://github.com.example.invalid/fixture-lab/LEAN-bench'],
    ['raw-file host', 'https://raw.githubusercontent.com/fixture-lab/LEAN-bench'],
    ['credentials', 'https://fixture:secret@example.invalid/fixture-lab/LEAN-bench'],
    ['GitHub credentials', 'https://fixture:secret@github.com/fixture-lab/LEAN-bench'],
    ['host in userinfo', 'https://github.com@example.invalid/fixture-lab/LEAN-bench'],
    ['explicit port', 'https://github.com:443/fixture-lab/LEAN-bench'],
    ['query', 'https://github.com/fixture-lab/LEAN-bench?revision=main'],
    ['fragment', 'https://github.com/fixture-lab/LEAN-bench#main'],
    ['local path', 'C:\\fixtures\\LEAN-bench'],
    ['local file URL', 'file:///C:/fixtures/LEAN-bench'],
    ['SSH URL', 'ssh://git@github.com/fixture-lab/LEAN-bench'],
    ['Git shorthand', 'git@github.com:fixture-lab/LEAN-bench'],
    ['missing repository', 'https://github.com/fixture-lab'],
    ['empty owner', 'https://github.com//LEAN-bench'],
    ['extra path', 'https://github.com/fixture-lab/LEAN-bench/tree/main'],
    ['trailing slash', 'https://github.com/fixture-lab/LEAN-bench/'],
    ['dot segment', 'https://github.com/fixture-lab/.'],
    ['parent segment', 'https://github.com/fixture-lab/..'],
    ['escaped path', 'https://github.com/fixture-lab/%4cEAN-bench'],
    ['backslash alias', 'https://github.com\\fixture-lab\\LEAN-bench'],
    ['leading space', ' https://github.com/fixture-lab/LEAN-bench'],
    ['trailing newline', 'https://github.com/fixture-lab/LEAN-bench\n'],
    ['owner too long', `https://github.com/${'a'.repeat(40)}/LEAN-bench`],
    ['repository too long', `https://github.com/fixture-lab/${'a'.repeat(101)}`]
  ];
  for (const [name, repository] of cases) await t.test(name, () => {
    const value = manifest();
    value.source.repository = repository;
    assert.throws(() => protocol.validateStudyProtocol('process', { studyProtocol: value }), { code: 'RESEARCH_STUDY_PROTOCOL_INVALID' });
  });
});

test('real state persistence binds a new manifest identity and forbids editing the saved declaration', async t => {
  const { control, state, experiment, file } = build(t);
  experiment.runnerConfig.studyProtocol.source.repository = 'https://github.com/reviewed-fixture-lab/LEAN-bench-fork';
  const first = control.runSubmit({ actor: 'human', experiment, params: { replicate: 1 } });
  const submittedManifest = copy(first.experiment.runnerConfig.studyProtocol);
  experiment.runnerConfig.studyProtocol.artifacts[0].sha256 = sha('later caller mutation');
  const reopened = createStateStore({ file });
  try {
    assert.deepEqual(reopened.getResearchExperiment({ experimentId: first.experiment.experimentId }).runnerConfig.studyProtocol, submittedManifest);
  } finally { reopened.close(); }
  assert.throws(() => state.updateResearchExperiment({ experimentId: first.experiment.experimentId, runnerConfig: experiment.runnerConfig }), { code: 'RESEARCH_EXPERIMENT_IMMUTABLE' });
  const second = control.runSubmit({ actor: 'human', experiment: { ...experiment, name: 'Different declaration' }, params: { replicate: 1 } });
  assert.notEqual(second.experiment.configHash, first.experiment.configHash);
  assert.notEqual(second.run.runId, first.run.runId);
  assert.equal(control.runSubmit({ actor: 'human', experiment: first.experiment, params: { replicate: 1 } }).run.runId, first.run.runId, 'identical immutable declaration replays');
});

test('invalid or unsupported configuration is refused before experiment creation or runner side effects', async t => {
  const { control, state, experiment, dir } = build(t);
  for (const kind of ['agent', 'http']) {
    assert.throws(() => control.runSubmit({ actor: 'human', experiment: { ...experiment, runnerKind: kind }, params: {} }), { code: 'RESEARCH_STUDY_PROTOCOL_RUNNER_UNSUPPORTED' });
    assert.deepEqual(state.listResearchExperiments({ projectId: experiment.projectId }), []);
  }
  let dispatches = 0;
  await assert.rejects(runners.runAgent({ experiment, run: { params: {} }, dispatch: () => { dispatches++; } }), { code: 'RESEARCH_STUDY_PROTOCOL_RUNNER_UNSUPPORTED' });
  await assert.rejects(runners.runHttp({ experiment, run: { params: {} } }), { code: 'RESEARCH_STUDY_PROTOCOL_RUNNER_UNSUPPORTED' });
  assert.equal(dispatches, 0);
  const marker = path.join(dir, 'must-not-start.txt');
  experiment.runnerConfig.args = ['-e', 'require("node:fs").writeFileSync(process.argv[1],"started")', marker];
  experiment.runnerConfig.studyProtocol.source.revision = 'main';
  assert.throws(() => control.runSubmit({ actor: 'human', experiment, params: {} }), { code: 'RESEARCH_STUDY_PROTOCOL_INVALID' });
  assert.deepEqual(state.listResearchExperiments({ projectId: experiment.projectId }), []);
  await assert.rejects(async () => runners.runProcess({ experiment, run: { params: {} }, artifactDir: dir }), { code: 'RESEARCH_STUDY_PROTOCOL_INVALID' });
  assert.equal(fs.existsSync(marker), false);
});

test('a real local process persists collected records, file receipts and study declarations in separate namespaces', async t => {
  const { control, state, experiment, worker, dir, file } = build(t);
  const pinned = path.join(dir, 'fixture-input.txt');
  fs.writeFileSync(pinned, 'fixture bytes');
  experiment.runnerConfig.pinnedFiles = [{ path: pinned, sha256: sha('fixture bytes') }];
  const submitted = control.runSubmit({ actor: 'human', experiment, params: { studyProtocol: 'input-field', manifestSha256: 'input-hash', replicate: 0 } });
  await worker.runOnce();
  const run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'succeeded', JSON.stringify(run.task.error));
  assert.equal(run.task.result.evidenceStatus, 'collected');
  assert.equal(run.task.result.provenance.scope, 'declared-file-checks-at-process-boundaries');
  const declaration = run.task.result.studyProtocol;
  assert.equal(declaration.status, 'declared-unverified');
  assert.deepEqual(declaration.manifest, submitted.experiment.runnerConfig.studyProtocol);
  assert.equal(declaration.manifestSha256, hashInput(declaration.manifest));
  assert.equal(declaration.runId, run.runId);
  assert.equal(declaration.experimentId, run.experimentId);
  assert.equal(declaration.experimentConfigHash, submitted.experiment.configHash);
  assert.equal(declaration.paramsHash, run.paramsHash);
  assert.equal(declaration.attempt, run.task.attempt);
  assert.equal(declaration.fence, run.task.result.fence);
  assert.deepEqual(declaration.unmeasured, protocol.UNMEASURED, 'even successful pre/post pins do not discharge protocol requirements');
  assert.equal(run.params.studyProtocol, 'input-field');
  assert.equal(control.results({ runId: run.runId }).results[0].record.studyProtocol, 'result-field');
  const reopened = createStateStore({ file });
  try {
    const transported = JSON.parse(JSON.stringify(reopened.listResearchRuns({ runId: run.runId })[0]));
    assert.deepEqual(transported.task.result.studyProtocol, declaration);
    assert.equal(transported.task.result.studyProtocol.manifestSha256, hashInput(transported.task.result.studyProtocol.manifest));
  } finally { reopened.close(); }
  assert.equal(state.getResearchExperiment({ experimentId: run.experimentId }).runnerConfig.studyProtocol.batchId, 'batch-fixture');
});

test('worker preflight refuses malformed legacy configuration before even an injected runner is called', async t => {
  const { control, experiment, worker, state } = build(t);
  const submitted = control.runSubmit({ actor: 'human', experiment, params: {} });
  const corrupted = copy(experiment.runnerConfig);
  corrupted.studyProtocol.source.revision = 'main';
  state.transaction(db => db.prepare('UPDATE research_experiments SET runner_config_json = ? WHERE experiment_id = ?')
    .run(JSON.stringify(corrupted), submitted.experiment.experimentId));
  let calls = 0;
  worker.runProcess = async () => { calls++; return { exitCode: 0, stdout: '{"ok":true}', durationMs: 1 }; };
  await worker.runOnce();
  const run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(calls, 0);
  assert.equal(run.task.status, 'failed');
  assert.equal(run.task.error.code, 'RESEARCH_STUDY_PROTOCOL_INVALID');
  assert.deepEqual(control.results({ runId: run.runId }).results, []);
});

test('execution-only runs retain declarations without inventing collected or verified results', async t => {
  const { control, experiment, worker } = build(t, { experiment: { collector: { kind: 'none' } } });
  const submitted = control.runSubmit({ actor: 'human', experiment, params: {} });
  await worker.runOnce();
  const run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'succeeded', JSON.stringify(run.task.error));
  assert.equal(run.task.result.evidenceStatus, 'execution-only');
  assert.equal(run.task.result.studyProtocol.status, 'declared-unverified');
  assert.deepEqual(control.results({ runId: run.runId }).results, []);
});

test('a failed attempt retains its prospective declaration only in immutable experiment configuration', async t => {
  const { control, experiment, worker, state } = build(t, { config: { args: ['-e', 'process.exit(7)'] } });
  const submitted = control.runSubmit({ actor: 'human', experiment, params: {} });
  await worker.runOnce();
  const run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'failed');
  assert.equal(run.task.result, null, 'no successful completion declaration or checker evidence is fabricated');
  assert.deepEqual(state.getResearchExperiment({ experimentId: run.experimentId }).runnerConfig.studyProtocol, experiment.runnerConfig.studyProtocol);
  assert.deepEqual(control.results({ runId: run.runId }).results, []);
});

test('ordinary no-protocol Research stays compatible and cannot acquire a study claim from stdout', async t => {
  const { control, experiment, worker } = build(t);
  delete experiment.runnerConfig.studyProtocol;
  const submitted = control.runSubmit({ actor: 'human', experiment, params: {} });
  await worker.runOnce();
  const run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'succeeded', JSON.stringify(run.task.error));
  assert.equal(Object.hasOwn(run.task.result, 'studyProtocol'), false);
  assert.equal(control.results({ runId: run.runId }).results[0].record.studyProtocol, 'result-field');
  assert.throws(() => protocol.assertStudyProtocolDeclaration(protocol.studyProtocolDeclaration(manifest(), binding()), { manifest: null }), { code: 'RESEARCH_STUDY_DECLARATION_UNEXPECTED' });
});

test('the atomic completion boundary rejects omitted, relabelled, tampered and cross-attempt declarations', async t => {
  const { control, state, experiment } = build(t);
  const { run, experiment: saved } = control.runSubmit({ actor: 'human', experiment, params: {} });
  const wrapped = tasks.internalResearchRunsState(state);
  const { handle } = await tasks.claim({ queue: 'research-runs', types: ['research-run'], workerLabel: 'study-boundary-test', leaseSeconds: 300 }, { state: wrapped });
  await tasks.start({ handle, leaseSeconds: 300 }, { state: wrapped });
  const declaration = protocol.studyProtocolDeclaration(saved.runnerConfig.studyProtocol, {
    runId: run.runId, experimentId: saved.experimentId, experimentConfigHash: saved.configHash,
    paramsHash: run.paramsHash, attempt: handle.attempt, fence: handle.fence
  });
  const result = { runnerKind: 'process', evidenceStatus: 'collected', summary: 'local fixture', studyProtocol: declaration };
  const records = [{ recordKind: 'summary', record: { ok: true } }];
  const changes = [
    value => undefined,
    value => null,
    value => { value.status = 'verified'; return value; },
    value => { value.unmeasured = []; return value; },
    value => { value.manifest.artifacts[0].sha256 = sha('other bytes'); value.manifestSha256 = hashInput(value.manifest); return value; },
    value => { value.manifest.source.revision = 'main'; return value; },
    value => { value.manifest.source.repository = 'https://github.com/another-fixture-lab/LEAN-bench'; value.manifestSha256 = hashInput(value.manifest); return value; },
    value => { value.manifestSha256 = sha('wrong hash'); return value; },
    value => { value.runId = 'rr-other'; return value; },
    value => { value.experimentId = 'rx-other'; return value; },
    value => { value.experimentConfigHash = sha('other config'); return value; },
    value => { value.paramsHash = sha('other params'); return value; },
    value => { value.attempt++; return value; },
    value => { value.fence++; return value; }
  ];
  for (const change of changes) {
    const changed = change(copy(declaration));
    const changedResult = { ...result };
    if (changed === undefined) delete changedResult.studyProtocol;
    else changedResult.studyProtocol = changed;
    assert.throws(() => state.completeResearchRun(handle, { runId: run.runId, records, result: changedResult }), {
      code: changed == null ? 'RESEARCH_STUDY_DECLARATION_MISSING' : 'RESEARCH_STUDY_DECLARATION_INVALID'
    });
    assert.equal(control.runs({ runId: run.runId }).runs[0].task.status, 'running');
    assert.deepEqual(control.results({ runId: run.runId }).results, []);
  }
  assert.equal(state.completeResearchRun(handle, { runId: run.runId, records, result }).replayed, false);
  assert.equal(state.completeResearchRun(handle, { runId: run.runId, records, result }).replayed, true);
  assert.deepEqual(control.runs({ runId: run.runId }).runs[0].task.result.studyProtocol, declaration);
});

test('a real retry cannot reuse the predecessor declaration under its new claim', t => {
  const { control, state, experiment } = build(t);
  const { run, experiment: saved } = control.runSubmit({ actor: 'human', experiment, params: {} });
  const first = state.claimTask({ queue: 'research-runs', workerLabel: 'study-first', leaseMs: 300000 }).handle;
  state.startTask(first);
  const context = {
    runId: run.runId, experimentId: saved.experimentId, experimentConfigHash: saved.configHash,
    paramsHash: run.paramsHash, attempt: first.attempt, fence: first.fence
  };
  const records = [{ recordKind: 'summary', record: { ok: true } }];
  const result = { runnerKind: 'process', evidenceStatus: 'collected', summary: 'retry fixture', studyProtocol: protocol.studyProtocolDeclaration(saved.runnerConfig.studyProtocol, context) };
  state.failTask(first, { disposition: 'retry', code: 'FIXTURE_RETRY', message: 'local fixture', retryDelayMs: 0 });
  const next = state.claimTask({ queue: 'research-runs', workerLabel: 'study-successor', leaseMs: 300000 }).handle;
  state.startTask(next);
  assert.equal(next.attempt, first.attempt + 1);
  assert.ok(next.fence > first.fence);
  assert.throws(() => state.completeResearchRun(next, { runId: run.runId, records, result }), { code: 'RESEARCH_STUDY_DECLARATION_INVALID' });
  assert.deepEqual(control.results({ runId: run.runId }).results, []);
  result.studyProtocol = protocol.studyProtocolDeclaration(saved.runnerConfig.studyProtocol, { ...context, attempt: next.attempt, fence: next.fence });
  state.completeResearchRun(next, { runId: run.runId, records, result });
  assert.equal(control.runs({ runId: run.runId }).runs[0].task.result.studyProtocol.attempt, next.attempt);
});

test('atomic ordinary completion refuses an unsolicited study declaration instead of silently adopting it', t => {
  const { control, state, experiment } = build(t);
  delete experiment.runnerConfig.studyProtocol;
  const { run } = control.runSubmit({ actor: 'human', experiment, params: {} });
  const { handle } = state.claimTask({ queue: 'research-runs', workerLabel: 'ordinary-fixture', leaseMs: 300000 });
  state.startTask(handle);
  const records = [{ recordKind: 'summary', record: { ok: true } }];
  const result = { runnerKind: 'process', evidenceStatus: 'collected', summary: 'ordinary fixture', studyProtocol: protocol.studyProtocolDeclaration(manifest(), binding()) };
  assert.throws(() => state.completeResearchRun(handle, { runId: run.runId, records, result }), { code: 'RESEARCH_STUDY_DECLARATION_UNEXPECTED' });
  assert.deepEqual(control.results({ runId: run.runId }).results, []);
  delete result.studyProtocol;
  state.completeResearchRun(handle, { runId: run.runId, records, result });
  assert.equal(Object.hasOwn(control.runs({ runId: run.runId }).runs[0].task.result, 'studyProtocol'), false);
});
