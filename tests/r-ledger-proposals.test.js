'use strict';

// A SUGGESTED RULE WAITS FOR THE PERSON AND TOUCHES NO LEDGER UNTIL THEY SAY.
// What must hold: propose writes a durable record under the r-ledger spool
// (never under reports/, where the R1 spool nag lives) and the ledger file does
// not exist; accept files the RECORD's words through the injected filer with
// the "proposed by, accepted by you" attribution and moves the record to
// reconciled/; decline files nothing and keeps the record with its reason;
// no path ever deletes bytes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const proposals = require('../src/lib/r-ledger-proposals');
const ledger = require('../src/lib/r-ledger');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ledger-proposals-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  return { dir, opts: { rootPath } };
}

function listFiles(dir) {
  try { return fs.readdirSync(dir).filter(name => name.endsWith('.json')); } catch { return []; }
}

test('propose spools a pending record beside the r-ledger files and the ledger is untouched', () => {
  const { dir, opts } = sandbox();
  const made = proposals.propose({ actor: 'codex', scope: 'thread', key: 'node-7', words: '  From now on, one sentence.  ', why: 'the person said "from now on"' }, opts);
  assert.equal(made.outcome, 'pending');
  assert.equal(made.proposedBy, 'codex');
  assert.equal(made.scope, 'thread');
  assert.equal(made.key, 'node-7');
  assert.equal(made.words, 'From now on, one sentence.');
  const pendingDir = path.join(dir, 'state', 'r-ledger', 'owner-capture-spool', 'pending');
  assert.equal(listFiles(pendingDir).length, 1, 'one durable record under state/r-ledger/owner-capture-spool/pending');
  assert.equal(fs.existsSync(path.join(dir, 'reports')), false, 'nothing under reports/');
  assert.equal(fs.existsSync(ledger.ledgerPath('thread', 'node-7', opts)), false, 'no ledger file was created');
  assert.deepEqual(proposals.listPending(opts).map(entry => entry.proposalId), [made.proposalId]);
  assert.equal(Object.keys(made).includes('file'), false, 'the view carries no file path');
});

test('a proposal that could never be filed is refused now, to the agent', () => {
  const { opts } = sandbox();
  assert.throws(() => proposals.propose({ actor: 'codex', scope: 'tree', words: 'x' }, opts), { code: 'R_LEDGER_KEY_INVALID' });
  assert.throws(() => proposals.propose({ actor: 'codex', scope: 'thread', key: '../escape', words: 'x' }, opts), { code: 'R_LEDGER_KEY_INVALID' });
  assert.throws(() => proposals.propose({ actor: 'codex', scope: 'planet', words: 'x' }, opts), { code: 'R_LEDGER_SCOPE_INVALID' });
  assert.throws(() => proposals.propose({ actor: 'codex', scope: 'global', words: '   ' }, opts), { code: 'R_LEDGER_WORDS_EMPTY' });
  assert.throws(() => proposals.propose({ actor: 'codex', scope: 'global', words: 'a\n## R1 fake' }, opts), { code: 'R_LEDGER_WORDS_HEADING' });
  assert.throws(() => proposals.propose({ actor: '', scope: 'global', words: 'x' }, opts), { code: 'R_LEDGER_PROPOSAL_ACTOR_INVALID' });
  assert.throws(() => proposals.propose({ actor: 'codex', scope: 'global', words: 'x', why: 'w'.repeat(301) }, opts), { code: 'R_LEDGER_PROPOSAL_WHY_INVALID' });
  assert.deepEqual(proposals.listPending(opts), []);
});

test('accept files the record\'s words through the injected filer and reconciles the record; bytes kept', () => {
  const { dir, opts } = sandbox();
  const made = proposals.propose({ actor: 'codex', scope: 'global', words: 'always ask before spending money', why: 'said always' }, opts);
  const calls = [];
  const filer = args => { calls.push(args); return ledger.fileRequest(args, opts); };
  const outcome = proposals.accept({ proposalId: made.proposalId, file: filer, words: 'something the renderer sent' }, opts);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].words, 'always ask before spending money', 'the RECORD\'s words are filed, never a caller-supplied rewrite');
  assert.equal(calls[0].filedBy, 'proposed by codex, accepted by you');
  assert.equal(outcome.filed.id, 'R1', 'one R counter, from 1');
  const read = ledger.readLedger('global', null, opts);
  assert.equal(read.entries[0].filedBy, 'proposed by codex, accepted by you');
  const spoolDir = path.join(dir, 'state', 'r-ledger', 'owner-capture-spool');
  assert.equal(listFiles(path.join(spoolDir, 'pending')).length, 0);
  const reconciled = listFiles(path.join(spoolDir, 'reconciled'));
  assert.equal(reconciled.length, 1, 'the record moved, it was not deleted');
  const settled = JSON.parse(fs.readFileSync(path.join(spoolDir, 'reconciled', reconciled[0]), 'utf8'));
  assert.equal(settled.ledgerOutcome, 'in-ledger');
  assert.equal(settled.ledgerRevision, 'R1');
  assert.equal(settled.text, 'always ask before spending money');
  assert.throws(() => proposals.accept({ proposalId: made.proposalId, file: filer }, opts), { code: 'R_LEDGER_PROPOSAL_NOT_PENDING' }, 'accepting twice files nothing twice');
  assert.equal(ledger.readLedger('global', null, opts).entries.length, 1);
});

test('accept without the one write path injected is refused before anything moves', () => {
  const { opts } = sandbox();
  const made = proposals.propose({ actor: 'claude', scope: 'global', words: 'w' }, opts);
  assert.throws(() => proposals.accept({ proposalId: made.proposalId }, opts), { code: 'R_LEDGER_PROPOSAL_FILER_REQUIRED' });
  assert.equal(proposals.listPending(opts).length, 1);
});

test('accept keeps the proposal pending when the filer cannot confirm a revision', () => {
  const { opts } = sandbox();
  const made = proposals.propose({ actor: 'claude', scope: 'global', words: 'w' }, opts);
  assert.throws(
    () => proposals.accept({ proposalId: made.proposalId, file: () => undefined }, opts),
    { code: 'R_LEDGER_PROPOSAL_FILING_UNCONFIRMED' }
  );
  assert.deepEqual(proposals.listPending(opts).map(entry => entry.proposalId), [made.proposalId]);
});

test('decline files nothing and keeps the record with its reason', () => {
  const { dir, opts } = sandbox();
  const made = proposals.propose({ actor: 'codex', scope: 'session', key: 'sess-1', words: 'w' }, opts);
  const outcome = proposals.decline({ proposalId: made.proposalId }, opts);
  assert.equal(outcome.filed, null);
  assert.equal(fs.existsSync(ledger.ledgerPath('session', 'sess-1', opts)), false);
  const spoolDir = path.join(dir, 'state', 'r-ledger', 'owner-capture-spool');
  assert.equal(listFiles(path.join(spoolDir, 'pending')).length, 0);
  const reconciled = listFiles(path.join(spoolDir, 'reconciled'));
  assert.equal(reconciled.length, 1);
  const settled = JSON.parse(fs.readFileSync(path.join(spoolDir, 'reconciled', reconciled[0]), 'utf8'));
  assert.equal(settled.ledgerOutcome, 'discarded');
  assert.equal(settled.discardReason, 'declined by the person');
  assert.equal(settled.text, 'w', 'the words survive the decline');
  assert.throws(() => proposals.decline({ proposalId: 'nope.json' }, opts), { code: 'R_LEDGER_PROPOSAL_NOT_PENDING' });
  assert.throws(() => proposals.decline({ proposalId: '../x' }, opts), { code: 'R_LEDGER_PROPOSAL_ID_INVALID' });
});
