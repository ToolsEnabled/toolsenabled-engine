'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const engine = process.env.T850_ENGINE_ROOT || path.resolve(__dirname, '..');
const lib = process.env.T850_COMPOSITION_LIB || path.join(engine, 'src', 'lib');
const helperPath = process.env.T850_HELPER_PATH || path.join(lib, 'task-waiting.js');
const waiting = require(helperPath);
const { createMapLedgerFixture } = require('./lib/task-waiting-memory-fixture.cjs');

function createFixture(label) {
  return createMapLedgerFixture({ engine, lib, label });
}

const MALFORMED_WAITS = Object.freeze([
  ['null', null],
  ['string', 'T12'],
  ['invalid ID', ['t1']],
  ['over-limit list', Array.from({ length: 17 }, (_, index) => 'T' + (index + 1))]
]);

function fileTask(fixture, words, extra = {}) {
  return fixture.store.fileTask({
    scope: 'global',
    words,
    filedBy: 'codex',
    ...extra
  }, fixture.opts);
}

function readTasks(fixture) {
  return fixture.store.readAll({
    ...fixture.opts,
    kinds: ['T'],
    includeRemoved: true,
    includeProposed: true
  }).records;
}

function taskById(fixture, id) {
  const record = readTasks(fixture).find(candidate => candidate.id === id);
  assert.ok(record, id + ' must remain readable from the T store');
  return record;
}

/*
 * This is an edit to the fixture's retained Map only. It models the hand-edit
 * and reset-row shapes in T1150/T1152 without touching a physical ledger.
 */
function editRetainedRecord(fixture, id, edit) {
  const document = fixture.readLedger();
  const entry = document.requests.find(candidate => candidate && candidate.id === id);
  assert.ok(entry, id + ' must exist in the retained Map document');
  edit(entry, document);
  fixture.memory.writeFileSync(fixture.ledgerFile, JSON.stringify(document));
}

function historyEvents(fixture) {
  return fixture.readHistory()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function markUnavailable(fixture, dependency, mode) {
  if (mode === 'removed') {
    fixture.store.removeTask({ id: dependency.id, actor: 'codex' }, fixture.opts);
    return;
  }
  if (mode === 'superseded') {
    // A task cannot be declined: decide() takes only R ids and refuses a T id
    // before any write. The product's other way to retire a live task is to
    // file its successor with `supersedes`, which rewrites it to 'superseded'.
    assert.throws(() => fixture.store.decide({
      id: dependency.id,
      decision: 'decline',
      reason: 'A task is never declined.',
      actor: 'owner'
    }, fixture.opts), { code: 'R_LEDGER_ID_INVALID' });
    const successor = fileTask(fixture, 'Successor of ' + dependency.id, { supersedes: dependency.id });
    assert.equal(taskById(fixture, dependency.id).status, 'superseded');
    assert.equal(taskById(fixture, dependency.id).supersededBy, successor.id);
    return;
  }
  if (mode === 'recurring') {
    editRetainedRecord(fixture, dependency.id, entry => {
      entry.status = 'recurring';
      entry.recurrence = { interval: 'synthetic-daily', completions: [] };
    });
    return;
  }
  if (mode === 'reset') {
    editRetainedRecord(fixture, dependency.id, entry => {
      entry.status = 'done';
      entry.completedAt = '2026-09-21T23:00:00.000Z';
      entry.completedBy = 'owner';
      // The store's shape check refuses a reset marker whose 'at' is not a
      // real time, so the synthetic marker carries one (as resetKind writes).
      entry.reset = {
        batchId: '00000000-0000-4000-8000-000000000001',
        kind: 'T',
        at: '2026-09-22T00:00:00.000Z',
        actor: 'owner',
        revision: 0
      };
    });
    return;
  }
  throw new Error('unknown unavailable mode: ' + mode);
}

test('malformed on-disk waits stay not-ready while real store operations continue', () => {
  for (const [label, malformedWait] of MALFORMED_WAITS) {
    const fixture = createFixture('t1173-lockout-' + label.replace(/[^a-z0-9]+/gi, '-'));
    const malformed = fileTask(fixture, 'Malformed wait ' + label);
    const other = fileTask(fixture, 'Other task to complete');

    editRetainedRecord(fixture, malformed.id, entry => {
      entry.waitingFor = malformedWait;
    });

    assert.doesNotThrow(() => fixture.store.fileRequest({
      scope: 'global',
      words: 'Unrelated rule write while a task wait is malformed.',
      filedBy: 'owner'
    }, fixture.opts), label);
    assert.doesNotThrow(() => fixture.store.completeTask({
      id: other.id,
      actor: 'codex'
    }, fixture.opts), label);

    let newcomer;
    assert.doesNotThrow(() => {
      newcomer = fileTask(fixture, 'New task after malformed wait');
    }, label);
    assert.ok(newcomer && newcomer.id, label);

    let records;
    assert.doesNotThrow(() => {
      records = readTasks(fixture);
    }, label);
    const malformedRecord = records.find(record => record.id === malformed.id);
    assert.ok(malformedRecord, label);
    assert.equal(
      waiting.taskDependenciesReady(malformedRecord, new Map(records.map(record => [record.id, record]))),
      false,
      label + ': malformed task must remain not-ready'
    );

    let preview;
    assert.doesNotThrow(() => {
      preview = fixture.store.previewResetKind({ kind: 'T', actor: 'owner' }, fixture.opts);
    }, label);
    assert.equal(preview.kind, 'T');
    assert.equal(preview.count, 3, label + ': preview must see all three T rows');

    assert.doesNotThrow(() => fixture.store.progressTask({
      id: malformed.id,
      status: 'in-progress',
      reason: 'Explicitly repair the malformed wait before relying on this task.',
      actor: 'codex',
      waitingFor: []
    }, fixture.opts), label);

    const repaired = taskById(fixture, malformed.id);
    assert.deepEqual(repaired.waitingFor, [], label + ': explicit repair clears the wait');
    assert.ok(
      historyEvents(fixture).some(event => event.kind === 'drift-observed' && event.requestId === malformed.id),
      label + ': explicit repair must record drift-observed'
    );
    assert.equal(fixture.store.verifyHistory(fixture.opts).ok, true, label + ': repaired ledger must verify');
  }
});

test('new malformed wait input remains strict and has no write side effect', () => {
  for (const [label, malformedWait] of MALFORMED_WAITS) {
    const fixture = createFixture('t1173-strict-' + label.replace(/[^a-z0-9]+/gi, '-'));
    const dependency = fileTask(fixture, 'Valid dependency for strict-input case');
    const target = fileTask(fixture, 'Target task for strict-input case');
    const before = taskById(fixture, target.id);
    const ledgerBefore = fixture.fileBytes(fixture.ledgerFile);
    const historyBefore = fixture.fileBytes(fixture.historyFile);

    assert.throws(() => fixture.store.progressTask({
      id: target.id,
      status: 'in-progress',
      reason: 'Reject malformed new wait input.',
      actor: 'codex',
      waitingFor: malformedWait
    }, fixture.opts), { code: 'T_LEDGER_WAIT_INVALID' }, label);

    const after = taskById(fixture, target.id);
    assert.equal(after.decisions.length, before.decisions.length, label + ': refusal must not append a decision');
    assert.equal(Object.hasOwn(after, 'waitingFor'), false, label + ': refusal must not add a wait');
    assert.equal(fixture.fileBytes(fixture.ledgerFile).equals(ledgerBefore), true, label + ': malformed refusal must preserve ledger bytes');
    assert.equal(fixture.fileBytes(fixture.historyFile).equals(historyBefore), true, label + ': malformed refusal must preserve history bytes');
    assert.equal(taskById(fixture, dependency.id).status, 'open');
  }
});

test('new waits on unavailable prerequisites refuse with T_LEDGER_WAIT_UNAVAILABLE', () => {
  for (const mode of ['removed', 'superseded', 'recurring', 'reset']) {
    const fixture = createFixture('t1173-new-unavailable-' + mode);
    const dependency = fileTask(fixture, 'Unavailable prerequisite ' + mode, mode === 'recurring' ? {
      recurrence: { interval: 'synthetic-daily' }
    } : {});
    const target = fileTask(fixture, 'New wait target ' + mode);
    if (mode !== 'recurring') markUnavailable(fixture, dependency, mode);
    const ledgerBefore = fixture.fileBytes(fixture.ledgerFile);
    const historyBefore = fixture.fileBytes(fixture.historyFile);

    assert.throws(() => fixture.store.progressTask({
      id: target.id,
      status: 'in-progress',
      reason: 'Reject a new wait on an unavailable prerequisite.',
      actor: 'codex',
      waitingFor: [dependency.id]
    }, fixture.opts), { code: 'T_LEDGER_WAIT_UNAVAILABLE' }, mode);

    assert.equal(Object.hasOwn(taskById(fixture, target.id), 'waitingFor'), false, mode + ': refusal must preserve no wait');
    assert.equal(fixture.fileBytes(fixture.ledgerFile).equals(ledgerBefore), true, mode + ': unavailable refusal must preserve ledger bytes');
    assert.equal(fixture.fileBytes(fixture.historyFile).equals(historyBefore), true, mode + ': unavailable refusal must preserve history bytes');
  }
});

test('existing waits can be re-supplied or cleared after a prerequisite becomes unavailable', () => {
  for (const mode of ['removed', 'superseded', 'recurring', 'reset']) {
    const fixture = createFixture('t1173-existing-unavailable-' + mode);
    const dependency = fileTask(fixture, 'Existing wait prerequisite ' + mode);
    const waiter = fileTask(fixture, 'Existing wait target ' + mode);

    fixture.store.progressTask({
      id: waiter.id,
      status: 'in-progress',
      reason: 'Record the wait before the prerequisite changes.',
      actor: 'codex',
      waitingFor: [dependency.id]
    }, fixture.opts);
    markUnavailable(fixture, dependency, mode);

    assert.doesNotThrow(() => fixture.store.progressTask({
      id: waiter.id,
      status: 'blocked-external',
      reason: 'Keep the existing wait when progress omits waitingFor.',
      actor: 'codex'
    }, fixture.opts), mode);
    // readAll omits a reset prerequisite, but the waiting task remains visible.
    assert.deepEqual(taskById(fixture, waiter.id).waitingFor, [dependency.id], mode + ': omitted waitingFor must preserve the held wait');

    assert.doesNotThrow(() => fixture.store.progressTask({
      id: waiter.id,
      status: 'blocked-external',
      reason: 'Keep the existing wait after its prerequisite changes.',
      actor: 'codex',
      waitingFor: [dependency.id]
    }, fixture.opts), mode);
    assert.deepEqual(taskById(fixture, waiter.id).waitingFor, [dependency.id], mode + ': re-supplying the existing wait preserves it');

    assert.doesNotThrow(() => fixture.store.progressTask({
      id: waiter.id,
      status: 'blocked-external',
      reason: 'Clear the existing wait explicitly.',
      actor: 'codex',
      waitingFor: []
    }, fixture.opts), mode);
    assert.deepEqual(taskById(fixture, waiter.id).waitingFor, [], mode + ': clearing remains available');
  }
});
