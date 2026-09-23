'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fixture, binding, change, inspect } = require('./helpers/byte-authority-fixture');

function child(t, f, actor, start, end, replacement, mode = 'ordinary') {
  const processHandle = spawn(process.execPath, [
    path.join(path.dirname(__dirname), 'tests/helpers/byte-authority-child.js'), f.root, f.resource,
    actor, String(start), String(end), replacement, mode
  ], { cwd: path.dirname(__dirname), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', TEMP: f.root, TMP: f.root } });
  const events = [];
  const listeners = [];
  let stderr = '';
  processHandle.stderr.on('data', chunk => { stderr += chunk; });
  processHandle.stdout.resume();
  const closed = new Promise((resolve, reject) => {
    processHandle.once('error', reject);
    processHandle.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  processHandle.on('message', event => {
    events.push(event);
    for (const listener of [...listeners]) listener(event);
  });
  t.after(async () => {
    if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill();
    await closed;
  });
  return {
    processHandle, events, closed,
    send: command => processHandle.send({ command }),
    wait: name => {
      const existing = events.find(event => event.event === name);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for ' + name + ': ' + stderr)), 15000);
        const listener = event => {
          if (event.event !== name) return;
          clearTimeout(timeout);
          listeners.splice(listeners.indexOf(listener), 1);
          resolve(event);
        };
        listeners.push(listener);
        closed.then(outcome => {
          if (listeners.includes(listener)) {
            clearTimeout(timeout);
            listeners.splice(listeners.indexOf(listener), 1);
            reject(new Error('Child closed before ' + name + ': ' + JSON.stringify(outcome)));
          }
        }, reject);
      });
    }
  };
}

test('two actual processes retain disjoint edits, including shifted byte coordinates', async t => {
  const f = fixture(t, 'AA BB');
  const left = child(t, f, 'left-a', 0, 2, 'AAAA');
  const right = child(t, f, 'right-b', 3, 5, 'ZZ');
  await Promise.all([left.wait('ready'), right.wait('ready')]);
  left.send('apply'); right.send('apply');
  const results = await Promise.all([left.wait('result'), right.wait('result')]);
  assert.ok(results.every(result => result.ok), JSON.stringify(results));
  const outcomes = await Promise.all([left.closed, right.closed]);
  assert.ok(outcomes.every(outcome => outcome.code === 0), JSON.stringify(outcomes));
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'AAAA ZZ');
});

test('a real competing process cannot publish while another lifetime transaction remains held', async t => {
  const f = fixture(t, 'AA BB');
  const left = child(t, f, 'left-a', 0, 2, 'AAAA', 'held');
  const right = child(t, f, 'right-b', 3, 5, 'ZZ');
  await Promise.all([left.wait('ready'), right.wait('ready')]);
  left.send('apply');
  await left.wait('publishing');
  right.send('apply');
  // A real writer already holds SQLite's lock. An independent connection
  // proves contention directly; process startup timing is not the evidence.
  const { DatabaseSync } = require('node:sqlite');
  const probe = new DatabaseSync(f.authority.lockFile);
  try { assert.throws(() => probe.exec('BEGIN IMMEDIATE'), error => (error.errcode & 255) === 5); }
  finally { probe.close(); }
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(right.events.some(event => event.event === 'publishing'), false);
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'AA BB');
  left.send('release');
  const results = await Promise.all([left.wait('result'), right.wait('result')]);
  assert.ok(results.every(result => result.ok), JSON.stringify(results));
  await Promise.all([left.closed, right.closed]);
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'AAAA ZZ');
});

for (const [mode, code, expected, outcome] of [
  ['crash-before', 71, 'AA BB', 'unapplied'],
  ['crash-after', 72, 'AAAA BB', 'recovered-materialized']
]) {
  test('actual process exit at ' + mode + ' releases its OS lock and preserves the publication journal', async t => {
    const f = fixture(t, 'AA BB');
    const worker = child(t, f, 'left-crash', 0, 2, 'AAAA', mode);
    await worker.wait('ready');
    worker.send('apply');
    assert.equal((await worker.closed).code, code);
    assert.equal(fs.readFileSync(f.resource, 'utf8'), expected);
    assert.equal(inspect(f.authority, 'SELECT status FROM operations')[0].status, 'PREPARED');
    const recovery = await f.authority.recoverPending();
    assert.equal(recovery.recovered[0].outcome, outcome);
    const after = binding('after-crash');
    await f.authority.observeRead({ binding: after, resource: f.resource });
    await change(f.authority, after, f.resource, 0, 1, 'X');
  });
}

test('real blind writers serialize whole-file publication without creating read receipts', async t => {
  const f = fixture(t, 'old');
  const left = child(t, f, 'left-writer', 0, 0, 'left image', 'write-held');
  const right = child(t, f, 'right-writer', 0, 0, 'right image', 'write-ordinary');
  await Promise.all([left.wait('ready'), right.wait('ready')]);
  left.send('apply');
  await left.wait('publishing');
  right.send('apply');
  const { DatabaseSync } = require('node:sqlite');
  const probe = new DatabaseSync(f.authority.lockFile);
  try { assert.throws(() => probe.exec('BEGIN IMMEDIATE'), error => (error.errcode & 255) === 5); }
  finally { probe.close(); }
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'old');
  left.send('release');
  const results = await Promise.all([left.wait('result'), right.wait('result')]);
  assert.ok(results.every(result => result.ok), JSON.stringify(results));
  assert.ok((await Promise.all([left.closed, right.closed])).every(outcome => outcome.code === 0));
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'right image');
  const operations = inspect(f.authority, 'SELECT operation_json,status FROM operations ORDER BY rowid');
  assert.ok(operations.every(row => row.status === 'COMMITTED'));
  const first = JSON.parse(operations[0].operation_json), second = JSON.parse(operations[1].operation_json);
  assert.equal(second.beforeSha256, first.afterSha256, 'the second blind write materializes the actual serialized predecessor');
  assert.equal(inspect(f.authority, 'SELECT * FROM receipts').length, 0);
  assert.equal(inspect(f.authority, 'SELECT * FROM reads').length, 0);
});

test('two real blind writers on an absent resource perform one creation then one explicit overwrite', async t => {
  const f = fixture(t, null);
  const left = child(t, f, 'left-writer', 0, 0, 'first', 'write-held');
  const right = child(t, f, 'right-writer', 0, 0, 'second', 'write-ordinary');
  await Promise.all([left.wait('ready'), right.wait('ready')]);
  left.send('apply');
  await left.wait('publishing');
  right.send('apply');
  assert.equal(fs.existsSync(f.resource), false);
  left.send('release');
  const results = await Promise.all([left.wait('result'), right.wait('result')]);
  assert.ok(results.every(result => result.ok), JSON.stringify(results));
  assert.ok((await Promise.all([left.closed, right.closed])).every(outcome => outcome.code === 0));
  assert.deepEqual(inspect(f.authority, 'SELECT operation_json FROM operations ORDER BY rowid')
    .map(row => JSON.parse(row.operation_json).publicationMode), ['create-only', 'replace-existing']);
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'second');
  assert.equal(fs.statSync(f.resource).nlink, 1);
});

for (const [phase, code, present, expectedOutcome] of [
  ['crash-before', 71, false, 'unapplied'],
  ['crash-after-link', 73, true, 'recovered-materialized'],
  ['crash-after', 72, true, 'recovered-materialized']
]) {
  test('real creation process exit at ' + phase + ' releases the lifetime lock and recovers only its staged identity', async t => {
    const f = fixture(t, null);
    const worker = child(t, f, 'create-crash', 0, 0, '', 'write-' + phase);
    await worker.wait('ready');
    worker.send('apply');
    assert.equal((await worker.closed).code, code);
    assert.equal(fs.existsSync(f.resource), present);
    const row = inspect(f.authority, 'SELECT * FROM operations')[0];
    assert.equal(row.status, 'PREPARED');
    const operation = JSON.parse(row.operation_json);
    assert.equal(operation.beforePresent, false);
    assert.equal(operation.noOp, false, 'empty creation is not an empty-file no-op');
    if (phase === 'crash-after-link') assert.equal(fs.statSync(f.resource).nlink, 2);
    const recovery = await f.authority.recoverPending();
    assert.equal(recovery.recovered[0].outcome, expectedOutcome);
    assert.equal(fs.existsSync(operation.createPreparation.stagingPath), false);
    if (present) assert.equal(fs.statSync(f.resource).nlink, 1);
    await f.authority.applyWrite({ binding: binding('after-crash'), resource: f.resource, bytes: Buffer.from('after') });
    assert.equal(fs.readFileSync(f.resource, 'utf8'), 'after');
  });
}

test('a real crash after staging but before its journal cannot imply publication or authorize a cleanup sweep', async t => {
  const f = fixture(t, null);
  const worker = child(t, f, 'create-crash', 0, 0, 'staged', 'write-crash-before-journal');
  await worker.wait('ready');
  worker.send('apply');
  assert.equal((await worker.closed).code, 70);
  assert.equal(fs.existsSync(f.resource), false);
  assert.equal(inspect(f.authority, 'SELECT * FROM operations').length, 0);
  const stages = fs.readdirSync(f.root).filter(name => name.endsWith('.create.tmp'));
  assert.equal(stages.length, 1);
  assert.equal((await f.authority.recoverPending()).recovered.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, stages[0])), true, 'an unjournaled stage is retained, not inferred to be cleanup-owned');
  await f.authority.applyWrite({ binding: binding('after-crash'), resource: f.resource, bytes: Buffer.from('published') });
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'published');
  assert.equal(fs.readFileSync(path.join(f.root, stages[0]), 'utf8'), 'staged');
});
