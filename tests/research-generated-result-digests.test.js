'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('../src/lib/state-store');

const RUN_ID = 'rr-111111111111111111111111111111111111';
const COLLECTION_HASH = 'eaafeaada20a8fbbe33d2aa9277ab1b422fea714cbbd108f17209e4deb3726d2';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-research-digest-'));
  const state = createStateStore({ file: path.join(dir, 'state.sqlite3') });
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  state.health();
  const generateId = state._researchId.bind(state);
  state._researchId = prefix => prefix === 'rr' ? RUN_ID : generateId(prefix);
  const project = state.createResearchProject({ name: 'Digest fixture', enabled: true });
  const { experiment } = state.createResearchExperiment({ projectId: project.projectId, name: 'Exact generated digest', runnerKind: 'process',
    runnerConfig: { command: 'not-executed' }, resultSchema: { fields: { score: 'number' }, required: ['score'] }, collector: { kind: 'stdout-json' } });
  const { run } = state.submitResearchRun({ experimentId: experiment.experimentId, params: {} });
  const { handle } = state.claimTask({ queue: 'research-runs', workerLabel: 'fixture', leaseMs: 300000 });
  state.startTask(handle);
  const input = { runId: run.runId, records: [{ recordKind: 'summary', record: { score: 11217 } }],
    result: { summary: 'Fixture completed', runnerKind: 'process', evidenceStatus: 'collected' } };
  return { state, run, handle, input };
}

test('actual computed EAA-leading collection digest persists, replays and remains exact', t => {
  const { state, run, handle, input } = fixture(t);
  const completed = state.completeResearchRun(handle, input);
  assert.equal(completed.task.status, 'succeeded');
  assert.equal(completed.task.result.collectionHash, COLLECTION_HASH);
  assert.equal(Object.isFrozen(completed.result), true);
  assert.throws(() => { completed.result.collectionHash = 'changed'; }, TypeError);
  assert.equal(state.getResearchRunByTask({ taskId: run.taskId }).task.result.collectionHash, COLLECTION_HASH);
  assert.deepEqual(state.listResearchResults({ runId: run.runId }).map(row => row.record), [{ score: 11217 }]);
  assert.equal(state.completeResearchRun(handle, input).replayed, true);
  assert.throws(() => state.completeTask(handle, { result: { ...completed.task.result } }), { code: 'TASK_SECRET_REJECTED' },
    'a caller copy of persisted metadata does not acquire internal generated-value authority');
  assert.throws(() => state.completeTask(handle, { result: completed.result }), { code: 'TASK_SECRET_REJECTED' },
    'even the returned object no longer carries the consumed internal completion authority');
});

test('changing nested caller bytes before internal completion invalidates the exact generated-result binding', t => {
  const { state, run, handle, input } = fixture(t);
  const complete = state._completeTask.bind(state);
  state._completeTask = (db, claim, result) => {
    result.detail.note = 'substituted';
    return complete(db, claim, result);
  };
  assert.throws(() => state.completeResearchRun(handle, { ...input, result: { ...input.result, detail: { note: 'original' } } }), { code: 'TASK_SECRET_REJECTED' });
  assert.equal(state.getResearchRunByTask({ taskId: run.taskId }).task.status, 'running');
  assert.deepEqual(state.listResearchResults({ runId: run.runId }), []);
});

test('caller-controlled digest-looking text and actual secret fields still refuse without committing results', t => {
  const { state, run, handle, input } = fixture(t);
  for (const extra of [{ collectionHash: COLLECTION_HASH }, { metadata: { value: COLLECTION_HASH } }, { password: 'fixture-password' }]) {
    assert.throws(() => state.completeTask(handle, { result: { summary: 'Untrusted fixture', ...extra } }), { code: 'TASK_SECRET_REJECTED' });
  }
  for (const extra of [{ callerDigest: COLLECTION_HASH }, { nested: { password: 'fixture-password' } }]) {
    assert.throws(() => state.completeResearchRun(handle, { ...input, result: { ...input.result, ...extra } }), { code: 'TASK_SECRET_REJECTED' });
    assert.equal(state.getResearchRunByTask({ taskId: run.taskId }).task.status, 'running');
    assert.deepEqual(state.listResearchResults({ runId: run.runId }), []);
  }
});
