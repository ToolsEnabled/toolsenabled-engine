'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('../src/lib/state-store');
const { ResearchControl } = require('../src/lib/providers/research');
const { createResearchActions } = require('../src/lib/mission-bridge/research-actions');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-research-pages-'));
  const state = createStateStore({ file: path.join(dir, 'state.sqlite3'), clock: () => 1700000000000 });
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  state.health();
  const project = state.createResearchProject({ name: 'Page fixture', enabled: true });
  const experiment = name => state.createResearchExperiment({ projectId: project.projectId, name, runnerKind: 'process',
    runnerConfig: { command: 'not-executed', args: [name] }, resultSchema: {}, collector: { kind: 'none' } }).experiment;
  const first = experiment('First'), other = experiment('Other');
  assert.notEqual(first.experimentId, other.experimentId, 'different configurations must create actual distinct experiments');
  const control = new ResearchControl({ state });
  const actions = createResearchActions({ control });
  function add(experimentId, index) {
    const { run } = state.submitResearchRun({ experimentId, params: { index } });
    state.cancelTask({ taskId: run.taskId, reason: 'Fixture history' });
    return run;
  }
  return { state, control, actions, first, other, add };
}
const decode = cursor => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
const encode = cursor => Buffer.from(JSON.stringify(cursor)).toString('base64url');

test('bridge pages cover tied timestamps exactly, preserve array callers and freeze membership before append', async t => {
  const f = fixture(t), experimentId = f.first.experimentId;
  const expected = Array.from({ length: 5 }, (_, i) => f.add(experimentId, i).runId).reverse();
  f.add(f.other.experimentId, 0);
  const first = (await f.actions.researchRuns({ experimentId, limit: 2 })).receipt;
  assert.deepEqual(first.runs.map(run => run.runId), expected.slice(0, 2));
  assert.equal(first.pagination.total, 5); assert.equal(first.pagination.offset, 0);
  assert.equal(first.contentTrust, 'untrusted'); assert.equal(first.grantsAuthority, false);
  assert.ok(Array.isArray(f.state.listResearchRuns({ experimentId, limit: 2 })));
  assert.equal(f.state.listResearchRuns({ experimentId, limit: 2 }).length, 2);
  const appended = f.add(experimentId, 5).runId;
  const second = f.control.runs({ experimentId, limit: 2, cursor: first.pagination.nextCursor });
  assert.deepEqual(f.control.runs({ experimentId, limit: 2, cursor: first.pagination.nextCursor }), second, 'an unchanged page cursor replays exactly');
  const third = f.control.runs({ experimentId, limit: 2, cursor: second.pagination.nextCursor });
  assert.deepEqual([...first.runs, ...second.runs, ...third.runs].map(run => run.runId), expected);
  assert.equal(second.pagination.total, 5); assert.equal(third.pagination.nextCursor, null);
  assert.equal(f.control.runs({ experimentId }).pagination.total, 6);
  assert.equal(f.control.runs({ experimentId }).runs[0].runId, appended);
  assert.equal(f.control.runs({ runId: expected[0] }).runs.length, 1);
})

test('cursor scope, position, ceiling identities and total cannot be substituted', t => {
  const f = fixture(t), experimentId = f.first.experimentId;
  const rows = Array.from({ length: 5 }, (_, i) => f.add(experimentId, i));
  const page = f.control.runs({ experimentId, limit: 2 });
  const cursor = page.pagination.nextCursor, value = decode(cursor);
  assert.throws(() => f.control.runs({ experimentId: f.other.experimentId, cursor }), { code: 'STATE_INVALID_ARGUMENT' });
  assert.throws(() => f.control.runs({ runId: rows[0].runId, cursor }), { code: 'RESEARCH_INPUT_INVALID' });
  for (const bad of ['', '%%%bad', 'x'.repeat(1025), encode(null), encode({ ...value, extra: true }), encode({ ...value, version: 2 }), encode({ ...value, before: 0 })]) {
    assert.throws(() => f.control.runs({ experimentId, cursor: bad }), { code: 'STATE_INVALID_ARGUMENT' });
  }
  for (const change of [{ total: value.total + 1 }, { offset: value.offset + 1 }, { beforeRunId: rows[0].runId }, { ceilingRunId: rows[0].runId }]) {
    assert.throws(() => f.control.runs({ experimentId, cursor: encode({ ...value, ...change }) }), { code: 'RESEARCH_RUNS_CHANGED' });
  }
  for (const limit of [0, 1001, 1.5]) assert.throws(() => f.control.runs({ experimentId, limit }), { code: 'STATE_INVALID_ARGUMENT' });
  assert.equal(f.control.runs({ experimentId, limit: 1000 }).runs.length, 5);
})

test('deletion during a traversal refuses the next page and a fresh read gives the actual remaining history', async t => {
  const f = fixture(t), experimentId = f.first.experimentId;
  const rows = Array.from({ length: 5 }, (_, i) => f.add(experimentId, i));
  const first = f.control.runs({ experimentId, limit: 2 });
  f.state.transaction(db => db.prepare('DELETE FROM tasks WHERE id = ?').run(rows[0].taskId));
  await assert.rejects(f.actions.researchRuns({ experimentId, cursor: first.pagination.nextCursor }), error => error.code === 'RESEARCH_RUNS_CHANGED' && error.status === 409);
  const refreshed = f.control.runs({ experimentId });
  assert.equal(refreshed.pagination.total, 4); assert.equal(refreshed.pagination.nextCursor, null);
  assert.deepEqual(new Set(refreshed.runs.map(run => run.runId)), new Set(rows.slice(1).map(run => run.runId)));
})

test('an empty experiment has an explicit complete empty page', t => {
  const f = fixture(t), experimentId = f.first.experimentId;
  const read = f.control.runs({ experimentId });
  assert.deepEqual(read.runs, []);
  assert.deepEqual(read.pagination, { version: 1, experimentId, snapshot: null, total: 0, offset: 0, nextCursor: null });
});
