'use strict';

// FIRST REQUIRE, PER THE 06:12Z STANDING RULE: redirects TOOLSENABLED_STATE_ROOT
// off the live capability root before any other module in this file can
// resolve it, and throws if the redirect did not take. This file's own
// sandbox() below always passes an explicit rootPath to every store call, so
// this guard is belt-and-suspenders here, not the only thing standing between
// a test and the live ledger -- but the rule binds every store-touching test
// file regardless, and this is one.
require('./helpers/isolated-state-root');

// A DECLARED STATUS WITH NO WRITER IS A PROMISE THE STORE CANNOT KEEP.
//
// STATUS_VOCABULARY declares nine states. Before this suite, only four were
// reachable: `proposed` and `open` from fileRequest, `declined` from decide,
// `removed` from removeRequest. `decide` is a two-value approve/decline gate --
// its whole transition table is one expression yielding `open`, unchanged, or
// `declined` -- so `in-progress`, `partial`, `blocked-external`, `done` and
// `not-possible-as-asked` had no writer anywhere in the file. A request the
// person finished had nowhere truthful to go and stayed open for ever; the
// only exits misdescribed it as "You declined it" or "You deleted it".
//
// These cases pin a resolution writer. They do NOT touch the permission model:
// every status-changing call stays the person's alone, and the last case
// asserts that an agent is still refused.
//
//   node --test tests/owner-request-status-writer.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const store = require('../src/lib/owner-request-store');

function sandbox(extra = {}) {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'owner-request-status-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  return {
    opts: { rootPath, needsApproval: false, ...extra },
    readJson: () => JSON.parse(fs.readFileSync(rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), 'utf8')),
    chainLines: () => fs.readFileSync(rootPath('state', 'owner-request-record-events.jsonl'), 'utf8').split('\n').filter(Boolean)
  };
}

// The person files it directly, so it starts `open` without an approval step.
function anOpenRequest(box, words = 'keep the build green') {
  const filed = store.fileRequest({ scope: 'global', words, filedBy: 'owner' }, box.opts);
  return filed.id;
}

// collectStack returns one object per scope layer, each with nested `entries`.
function standing(box, id) {
  const walk = entries => entries.some(entry => entry.id === id || walk(entry.refinements || entry.entries || []));
  return store.collectStack({}, box.opts).some(layer => walk(layer.entries || []));
}

const RESOLUTIONS = ['in-progress', 'partial', 'blocked-external', 'done', 'not-possible-as-asked', 'superseded'];

test('every status the vocabulary declares now has a writer', () => {
  for (const status of RESOLUTIONS) {
    const box = sandbox();
    const id = anOpenRequest(box);
    const out = store.resolve({ id, status, reason: `moved to ${status}`, actor: 'owner' }, box.opts);
    assert.equal(out.status, status, `resolve must be able to reach ${status}`);
    const record = box.readJson().requests.find(entry => entry.id === id);
    assert.equal(record.status, status, `${status} must be persisted on the record, not just returned`);
  }
});

test('superseded is added to the vocabulary rather than reusing an existing word', () => {
  assert.ok(Object.prototype.hasOwnProperty.call(store.STATUS_VOCABULARY, 'superseded'),
    'STATUS_VOCABULARY must declare superseded');
  assert.equal(typeof store.STATUS_VOCABULARY.superseded, 'string');
  assert.ok(store.STATUS_VOCABULARY.superseded.length > 0, 'superseded needs a gloss like every other status');
  assert.ok(!store.ACTIVE_STATUSES.has('superseded'),
    'a superseded rule must stop counting as standing');
});

test('a resolved request leaves the standing stack but stays in the record', () => {
  const box = sandbox();
  const id = anOpenRequest(box, 'this one gets finished');
  assert.ok(standing(box, id), 'it is standing while open');

  store.resolve({ id, status: 'done', reason: 'delivered and verified', actor: 'owner' }, box.opts);

  assert.ok(!standing(box, id),
    'a done request must not still be read to every session as a standing rule');
  assert.ok(box.readJson().requests.some(entry => entry.id === id && entry.status === 'done'),
    'and it must remain in the ledger for the record');

  // EXTEND, DO NOT REPEAT (L1g): 'superseded' is a NEW status, not merely a
  // new writer for an old one -- readers that classify by an explicit set of
  // literal status strings (rather than ACTIVE_STATUSES membership) can miss
  // a status they were never written against. collectStack's own gate is
  // ACTIVE_STATUSES.has(status), so the same mechanism that dropped 'done'
  // above drops 'superseded' too; this proves it on the reader, not just on
  // the vocabulary flag the earlier test in this file checks.
  const supersededId = anOpenRequest(box, 'this one gets replaced');
  assert.ok(standing(box, supersededId), 'it is standing while open');
  store.resolve({ id: supersededId, status: 'superseded', reason: 'replaced by a newer rule', actor: 'owner' }, box.opts);
  assert.ok(!standing(box, supersededId),
    'a superseded request must not still be read to every session as a standing rule');
  assert.ok(box.readJson().requests.some(entry => entry.id === supersededId && entry.status === 'superseded'),
    'and it must remain in the ledger for the record');
});

test('a resolution appends one history row and one chain event, and the chain still verifies', () => {
  const box = sandbox();
  const id = anOpenRequest(box);
  const before = box.chainLines().length;

  store.resolve({ id, status: 'partial', reason: 'shipped without the export', actor: 'owner' }, box.opts);

  assert.equal(box.chainLines().length, before + 1, 'exactly one event is appended');
  const record = box.readJson().requests.find(entry => entry.id === id);
  const last = record.history[record.history.length - 1];
  assert.equal(last.statusBefore, 'open', 'the row records what it moved from');
  assert.equal(store.verifyHistory(box.opts).ok, true, 'the append-only chain must still verify');
});

/* THE PERMISSION MODEL IS NOT TOUCHED. Agents may file and nothing else; this
   asserts the new writer inherits that rather than opening a door beside it. */
test('resolving is the person\'s alone -- an agent is refused exactly as decide refuses one', () => {
  const box = sandbox();
  const id = anOpenRequest(box);
  assert.throws(
    () => store.resolve({ id, status: 'done', reason: 'I finished it', actor: 'Builder 3' }, box.opts),
    error => error.code === 'R_LEDGER_PERSON_REQUIRED',
    'an agent must not be able to mark the person\'s rule done');
  assert.equal(box.readJson().requests.find(entry => entry.id === id).status, 'open',
    'a refused resolution writes nothing');
});

test('a status outside the vocabulary is refused and writes nothing', () => {
  const box = sandbox();
  const id = anOpenRequest(box);
  assert.throws(
    () => store.resolve({ id, status: 'finished-ish', reason: 'x', actor: 'owner' }, box.opts),
    error => error.code === 'R_LEDGER_STATUS_INVALID');
  assert.equal(box.readJson().requests.find(entry => entry.id === id).status, 'open');
});

/* REACHABILITY. A writer nothing can call is not delivered. decide() is reached
   by the person through the r-ledger module, which binds actor:'owner' for it;
   resolve() must be reachable the same way or it exists only in the diff.
   It is NOT registered as an MCP tool, and must not be: that transport binds
   the actor to an AGENT principal (codex, claude, gemini), so assertPerson
   would refuse every call -- a tool that can never succeed is a trap, not a
   surface. */
test('the person can reach resolve through the r-ledger module, as they reach decide', () => {
  const ledger = require('../src/lib/r-ledger');
  assert.equal(typeof ledger.resolve, 'function', 'r-ledger must expose resolve beside decide');

  const box = sandbox();
  const id = anOpenRequest(box);
  const out = ledger.resolve({ id, status: 'done', reason: 'delivered' }, box.opts);
  assert.equal(out.status, 'done',
    'the wrapper must bind actor owner itself, exactly as the decide wrapper does');
  assert.equal(box.readJson().requests.find(entry => entry.id === id).status, 'done');
});

/* CONTROL. decide is untouched by this change; if this goes red alongside the
   others the suite is detecting an edit rather than the missing writer. */
test('decide still does exactly what it did: approve and decline, nothing more', () => {
  const box = sandbox();
  const id = anOpenRequest(box);
  assert.throws(
    () => store.decide({ id, decision: 'done', reason: 'x', actor: 'owner' }, box.opts),
    error => error.code === 'R_LEDGER_DECISION_INVALID',
    'decide must still refuse any decision that is not approve or decline');
  const out = store.decide({ id, decision: 'decline', reason: 'changed my mind', actor: 'owner' }, box.opts);
  assert.equal(out.status, 'declined');
});
