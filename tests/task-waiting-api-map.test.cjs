'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const engine = process.env.T850_ENGINE_ROOT || require('node:path').resolve(__dirname, '..');
const lib = process.env.T850_COMPOSITION_LIB
  || require('node:path').resolve(__dirname, '..', 'src', 'lib');
const { createMapLedgerFixture } = require('./lib/task-waiting-memory-fixture.cjs');
const variant = process.env.T850_WAIT_VARIANT === 'base' ? 'base' : 'candidate';

function world(label) {
  return createMapLedgerFixture({ variant, engine, lib, label });
}

function bytes(fixture) {
  return {
    ledger: fixture.fileBytes(fixture.ledgerFile),
    history: fixture.fileBytes(fixture.historyFile)
  };
}

test('waitingFor is stored, omitted waits persist, [] clears, and invalid graphs publish nothing', async () => {
  const fixture = world('api-history');
  const dependency = fixture.fileTask({ scope: 'global', words: 'prerequisite', filedBy: 'codex' });
  const target = fixture.fileTask({ scope: 'global', words: 'dependent work', filedBy: 'codex' });
  const legacy = fixture.findTask(dependency.id);
  assert.equal(Object.hasOwn(legacy, 'waitingFor'), false);
  const legacyWithoutWaitingFor = { ...legacy };
  delete legacyWithoutWaitingFor.waitingFor;
  assert.equal(
    fixture.store.coreSha256(legacy),
    fixture.store.coreSha256(legacyWithoutWaitingFor),
    'legacy rows without waitingFor retain their historical core'
  );
  assert.notEqual(
    fixture.store.coreSha256(legacy),
    fixture.store.coreSha256({ ...legacy, waitingFor: [] }),
    'an explicitly present [] is history-bound while a legacy absence stays unbound'
  );

  fixture.progress({
    id: target.id,
    status: 'in-progress',
    reason: 'waiting on prerequisite',
    actor: 'codex',
    waitingFor: [dependency.id]
  });
  assert.deepEqual(fixture.findTask(target.id).waitingFor, [dependency.id]);

  fixture.progress({
    id: target.id,
    status: 'in-progress',
    reason: 'checkpoint while still waiting',
    actor: 'codex'
  });
  assert.deepEqual(fixture.findTask(target.id).waitingFor, [dependency.id]);

  const clearResult = fixture.progress({
    id: target.id,
    status: 'in-progress',
    reason: 'explicitly clear wait',
    actor: 'codex',
    waitingFor: []
  });
  assert.equal(Object.hasOwn(fixture.findTask(target.id), 'waitingFor'), true);
  assert.deepEqual(fixture.findTask(target.id).waitingFor, []);
  const beforeDuplicate = bytes(fixture);
  const duplicateResult = fixture.progress({
    id: target.id,
    status: 'in-progress',
    reason: 'explicitly clear wait',
    actor: 'codex',
    waitingFor: []
  });
  assert.equal(duplicateResult.revision, clearResult.revision);
  assert.deepEqual(bytes(fixture), beforeDuplicate, 'identical checkpoints publish no new revision');

  const terminal = fixture.fileTask({ scope: 'global', words: 'terminal task', filedBy: 'codex' });
  fixture.complete({ id: terminal.id, actor: 'codex' });
  const beforeTerminal = bytes(fixture);
  assert.throws(() => fixture.progress({
    id: terminal.id, status: 'in-progress', reason: 'must not revive terminal task', actor: 'codex'
  }), { code: 'R_LEDGER_STATUS_INVALID' });
  assert.deepEqual(bytes(fixture), beforeTerminal, 'terminal refusal publishes nothing');

  const beforeMissing = bytes(fixture);
  assert.throws(() => fixture.progress({
    id: target.id, status: 'in-progress', reason: 'missing dependency', actor: 'codex', waitingFor: ['T999']
  }), { code: 'T_LEDGER_WAIT_INVALID' });
  assert.deepEqual(bytes(fixture), beforeMissing);

  const third = fixture.fileTask({ scope: 'global', words: 'cycle target', filedBy: 'codex' });
  fixture.progress({
    id: third.id, status: 'in-progress', reason: 'third waits for target', actor: 'codex', waitingFor: [target.id]
  });
  const beforeCycle = bytes(fixture);
  assert.throws(() => fixture.progress({
    id: target.id, status: 'in-progress', reason: 'cycle back', actor: 'codex', waitingFor: [third.id]
  }), { code: 'T_LEDGER_WAIT_INVALID' });
  assert.deepEqual(bytes(fixture), beforeCycle);
  assert.equal(fixture.store.verifyHistory(fixture.opts).ok, true);
});

test('MinorLedgerAgentControl.progress carries the optional wait through the durable gate', async () => {
  const fixture = world('api-gate');
  const dependency = fixture.fileTask({ scope: 'global', words: 'gate prerequisite', filedBy: 'codex' });
  const target = fixture.fileTask({ scope: 'global', words: 'gate target', filedBy: 'codex' });
  const audits = [];
  let auditEntered;
  let releaseAudit;
  const auditReady = new Promise(resolve => { auditEntered = resolve; });
  const auditRelease = new Promise(resolve => { releaseAudit = resolve; });
  const control = fixture.gate({
    loadSettings: () => ({
      values: { 'audit.enabled': true },
      provenance: { 'audit.enabled': { source: 'user' } }
    }),
    auditRequireAsync: async (action, name, details) => {
      audits.push({ action, name, details });
      auditEntered();
      await auditRelease;
      return { durable: true };
    }
  });
  const waitingFor = [dependency.id];
  const pending = control.progress({
    actor: 'codex',
    id: target.id,
    status: 'in-progress',
    reason: 'gate wait',
    waitingFor
  });
  await auditReady;
  waitingFor.push('T999');
  releaseAudit();
  const result = await pending;
  assert.equal(result.updated, true);
  assert.deepEqual(fixture.findTask(target.id).waitingFor, [dependency.id]);
  assert.deepEqual(audits.at(-1).details.waitingFor, [dependency.id]);
});

test('waiting IDs normalize and only completed dependencies release readiness', () => {
  const helper = require(require('node:path').join(lib, 'task-waiting.js'));
  assert.deepEqual(helper.normalizeWaitingFor(['T10', 'T2']), ['T2', 'T10']);
  assert.throws(() => helper.normalizeWaitingFor(['T2', 'T2']), { code: 'T_LEDGER_WAIT_INVALID' });
  const dependency = { id: 'T2', kind: 'T', status: 'in-progress' };
  const task = { id: 'T1', kind: 'T', waitingFor: ['T2'] };
  assert.equal(helper.taskDependenciesReady(task, new Map([['T2', dependency]])), false);
  dependency.status = 'done';
  assert.equal(helper.taskDependenciesReady(task, new Map([['T2', dependency]])), true);
});
