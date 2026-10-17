'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('person-side ledger apply accepts bounded stdin JSON and returns a machine receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ledger-action-'));
  const entry = path.join(__dirname, '../bin/toolsenabled-openshell.js');
  const env = { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root };
  try {
    const preview = spawnSync(process.execPath, [entry, 'ledger', '--json'], { env, encoding: 'utf8' });
    assert.equal(preview.status, 0, preview.stderr);
    const expectedRevision = JSON.parse(preview.stdout).revision;
    const result = spawnSync(process.execPath, [entry, 'ledger', 'apply'], {
      env, input: JSON.stringify({ action: 'add-task', words: 'Review the bounded report', expectedRevision }), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.schema, 'ai.toolsenabled/fleet-ledger-action/v1');
    assert.match(receipt.auditEventId, /^audit-/);
    const auditProof = spawnSync(process.execPath, ['-e',
      `const a=require(${JSON.stringify(path.join(__dirname, '../src/lib/audit.js'))});` +
      'process.stdout.write(JSON.stringify({verify:a.verify(),events:a.tail(20)}));'], { env, encoding: 'utf8' });
    assert.equal(auditProof.status, 0, auditProof.stderr);
    const proof = JSON.parse(auditProof.stdout);
    assert.equal(proof.verify.valid, true, JSON.stringify(proof.verify));
    const signedIntent = proof.events.find(row => row.eventId === receipt.auditEventId);
    assert.equal(signedIntent.action, 'ledger.apply.intent');
    assert.equal(signedIntent.details.actor, 'owner-claimed');
    assert.equal(signedIntent.details.surface, 'terminal-cli');
    assert.equal(signedIntent.details.expectedRevision, expectedRevision);
    assert.match(receipt.id, /^T\d+$/);
    const listed = spawnSync(process.execPath, [entry, 'ledger', '--json'], { env, encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(JSON.parse(listed.stdout).records.some(row => row.id === receipt.id));
    const stale = spawnSync(process.execPath, [entry, 'ledger', 'apply'], {
      env, input: JSON.stringify({ action: 'add-task', words: 'Must not be filed', expectedRevision }), encoding: 'utf8'
    });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /ledger changed/i);
    const listedAfter = spawnSync(process.execPath, [entry, 'ledger', '--json'], { env, encoding: 'utf8' });
    assert.ok(!JSON.parse(listedAfter.stdout).records.some(row => row.words === 'Must not be filed'));
    const refused = spawnSync(process.execPath, [entry, 'ledger', 'apply'], {
      env, input: JSON.stringify({ action: 'add-task', words: 'x', unexpected: true }), encoding: 'utf8'
    });
    assert.notEqual(refused.status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ledger machine detail includes bounded task progress, waits and recurrence', () => {
  const row = { kind: 'T', id: 'T1', status: 'blocked-external', verbatim: 'Review release',
    decisions: [{ decision: 'progress', status: 'blocked-external', reason: 'Need owner input', at: '2026-10-02T00:00:00Z' }],
    waitingFor: ['T2'], difficulty: 'hard', recurrence: { interval: 'daily' } };
  const result = require('../src/lib/openshell-ledger-page').machineView({}, {
    read: () => ({ revision: 1, records: [row] })
  });
  assert.equal(result.records[0].progress.reason, 'Need owner input');
  assert.deepEqual(result.records[0].waitingFor, ['T2']);
  assert.equal(result.records[0].difficulty, 'hard');
  assert.equal(result.records[0].recurrence.interval, 'daily');
});

test('plain ledger verbs write the same signed intent as ledger apply, and refused actions write none', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ledger-plain-'));
  const entry = path.join(__dirname, '../bin/toolsenabled-openshell.js');
  const lib = path.join(__dirname, '../src/lib');
  const env = { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root };
  const cli = (...args) => spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8' });
  const intents = () => {
    const read = spawnSync(process.execPath, ['-e',
      `const a=require(${JSON.stringify(path.join(lib, 'audit.js'))});` +
      'process.stdout.write(JSON.stringify({verify:a.verify(),events:a.tail(100)}));'], { env, encoding: 'utf8' });
    assert.equal(read.status, 0, read.stderr);
    const proof = JSON.parse(read.stdout);
    assert.equal(proof.verify.valid, true, JSON.stringify(proof.verify));
    return proof.events.filter(row => row.action === 'ledger.apply.intent');
  };
  try {
    // Establish this scratch root's signing key before an agent files a
    // ledger record. The first terminal intent then signs against that exact
    // generation rather than relying on a keyring from another test root.
    const bootstrap = spawnSync(process.execPath, ['-e',
      `require(${JSON.stringify(path.join(lib, 'audit.js'))}).requireRecord('test.seed', 'ledger-plain', {});`],
    { env, encoding: 'utf8' });
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    const asked = spawnSync(process.execPath, ['-e', [
      `const { executeTool } = require(${JSON.stringify(path.join(lib, 'tool-registry'))});`,
      `const permissionSession = require(${JSON.stringify(path.join(lib, 'permission-tier-policy'))}).installTierSession('unrestricted');`,
      "const ctx = { agentActor: 'codex', permissionSession };",
      '(async () => {',
      "  for (const words of ['Approve the deploy?', 'Use the staging account?'])",
      "    await executeTool('a_ledger.file', { actor: 'codex', scope: 'global', words }, ctx);",
      '})().then(() => process.exit(0), error => { console.error(error.code, error.message); process.exit(1); });'
    ].join('\n')], { env, encoding: 'utf8' });
    assert.equal(asked.status, 0, asked.stderr);
    const steps = [
      [['ledger', 'add', 'task', 'Review the bounded report'], 'add-task', null],
      [['ledger', 'add', 'rule', 'Always run the tests first'], 'add-rule', null],
      [['ledger', 'add', 'task', 'Draft the notes'], 'add-task', null],
      [['ledger', 'done', 'T1'], 'done', 'T1'],
      [['ledger', 'remove', 'T2'], 'remove', 'T2'],
      [['ledger', 'answer', 'A1', 'yes, deploy after the tests pass'], 'answer', 'A1'],
      [['ledger', 'decline', 'A2', 'use production'], 'decline', 'A2']
    ];
    for (const [args] of steps) {
      const result = cli(...args);
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    }
    const problems = [];
    const recorded = intents();
    const got = JSON.stringify(recorded.map(row => [row.target, row.details.recordId]));
    const want = JSON.stringify(steps.map(([, action, id]) => [action, id]));
    if (got !== want) problems.push(`plain verbs recorded ${got}, expected ${want}`);
    for (const row of recorded) {
      if (row.details.actor !== 'owner-claimed' || row.details.surface !== 'terminal-cli')
        problems.push(`intent ${row.target} has actor ${row.details.actor} surface ${row.details.surface}`);
    }
    // Refused before any record: a wrong id kind, an unknown verb and an unknown apply action.
    assert.notEqual(cli('ledger', 'done', 'A1').status, 0);
    assert.notEqual(cli('ledger', 'answer', 'T3', 'words').status, 0);
    assert.notEqual(cli('ledger', 'frob', 'T3').status, 0);
    const revision = JSON.parse(cli('ledger', '--json').stdout).revision;
    const unknown = spawnSync(process.execPath, [entry, 'ledger', 'apply'], {
      env, input: JSON.stringify({ action: 'delete-all', expectedRevision: revision }), encoding: 'utf8' });
    assert.notEqual(unknown.status, 0);
    const injected = spawnSync(process.execPath, [entry, 'ledger', 'apply'], {
      env, input: JSON.stringify({ action: 'done', id: 'T1; rm -rf ~', expectedRevision: revision }), encoding: 'utf8' });
    assert.notEqual(injected.status, 0);
    const after = intents().length - recorded.length;
    if (after !== 0) problems.push(`refused actions added ${after} signed intent(s)`);
    assert.deepEqual(problems, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
