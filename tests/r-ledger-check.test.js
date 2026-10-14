'use strict';

require('./helpers/isolated-state-root'); // FINDING 1, REPORT-ledger-kinds-tools-20260907.md: redirect TOOLSENABLED_STATE_ROOT off the live root before anything below can resolve it.

// The request system's one tripwire: a /Request* turn the owner typed that
// reached the spool but no ledger is named loudly; a filed one is clean; a
// plain turn is not the tripwire's business no matter what it says.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const { check, COMMAND_RE, ledgerCorpus, normalize } = require('../tools/r-ledger-check');
const store = require('../src/lib/owner-request-store');

const NOW = Date.parse('2026-08-16T02:00:00.000Z');
const turn = (text, hoursAgo = 1) => ({ id: `t-${text.length}-${hoursAgo}`, when: new Date(NOW - hoursAgo * 3600 * 1000).toISOString(), text, file: 'fixture' });
// Corpus entries carry the same normalization the real ledgerCorpus() applies.
const entry = words => ({ id: 'R2000', path: 'fixture', norm: normalize(words) });

test('the four command spellings are recognised and nothing else is', () => {
  for (const head of ['/Request x', '/request x', '/RequestSession x', '/RequestTree x', '/RequestThread x', '  /Request x']) {
    assert.ok(COMMAND_RE.test(head.trimStart()), head);
  }
  for (const head of ['/loop 10 continue', 'request x', '/requestor', 'please /Request x']) {
    assert.equal(COMMAND_RE.test(head.trimStart()), false, head);
  }
});

test('an unfiled /Request turn is named; a filed one is clean; plain turns are ignored', () => {
  const unfiled = check({
    now: NOW,
    listIngress: () => [turn('/Request keep the desktop quiet, no visible shells'), turn('some plain ruling nobody marked')],
    corpus: []
  });
  assert.equal(unfiled.markedInWindow, 1, 'only the marked turn counts');
  assert.equal(unfiled.unfiled.length, 1);
  assert.match(unfiled.unfiled[0].words, /keep the desktop quiet/);

  const filed = check({
    now: NOW,
    listIngress: () => [turn('/Request keep the desktop quiet, no visible shells')],
    corpus: [entry('keep the desktop quiet, no visible shells')]
  });
  assert.equal(filed.unfiled.length, 0, 'the same words in a ledger make it clean');

  const scoped = check({
    now: NOW,
    listIngress: () => [turn('/RequestThread show me diffs before committing')],
    corpus: [entry('Show me diffs before committing.')]
  });
  assert.equal(scoped.unfiled.length, 0, 'punctuation and case do not defeat the match');
});

/* THE REAL CORPUS comes from the one ledger, every tier, removed and waiting
   rows included: a turn the person filed and later deleted was still filed.
   An absent ledger is an empty corpus, not a refusal. */
test('ledgerCorpus reads every tier of the one ledger through the store', () => {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'r-ledger-check-'));
  const opts = { rootPath: (...parts) => path.join(dir, ...parts), needsApproval: false };
  assert.deepEqual(ledgerCorpus(opts), [], 'no ledger yet: nothing filed, nothing to match');
  assert.equal(fs.existsSync(path.join(dir, 'reports')), false, 'a read created nothing');
  store.fileRequest({ scope: 'global', words: 'Keep the desktop quiet, no visible shells.' }, opts);
  store.fileRequest({ scope: 'thread', key: 'node-4', words: 'show me diffs before committing' }, opts);
  store.fileRequest({ scope: 'session', key: 'S', words: 'an agent suggestion', filedBy: 'codex', proposed: true }, opts);
  store.fileRequest({ scope: 'global', words: 'deleted later' }, opts);
  store.removeRequest({ id: 'R4', actor: 'owner' }, opts);
  const corpus = ledgerCorpus(opts);
  assert.deepEqual(corpus.map(entry => [entry.id, entry.norm]), [
    ['R1', 'keep the desktop quiet no visible shells'],
    ['R2', 'show me diffs before committing'],
    ['R3', 'an agent suggestion'],
    ['R4', 'deleted later']
  ]);
  assert.ok(corpus.every(entry => entry.path === store.ledgerFileFor(opts)));
  const result = check({
    now: NOW,
    listIngress: () => [turn('/RequestThread Show me diffs before committing'), turn('/Request deleted later'), turn('/Request never filed')],
    corpus
  });
  assert.deepEqual(result.unfiled.map(item => item.words), ['/Request never filed']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the window is honoured and a bare command with no words is not a miss', () => {
  const old = check({ now: NOW, hours: 2, listIngress: () => [turn('/Request an old one', 30)], corpus: [] });
  assert.equal(old.markedInWindow, 0, 'outside the window it is not counted');
  const bare = check({ now: NOW, listIngress: () => [turn('/Request')], corpus: [] });
  assert.equal(bare.unfiled.length, 0, 'nothing to file, nothing missed');
});
