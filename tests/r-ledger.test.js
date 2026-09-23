'use strict';

require('./helpers/isolated-state-root'); // FINDING 1, REPORT-ledger-kinds-tools-20260907.md: redirect TOOLSENABLED_STATE_ROOT off the live root before anything below can resolve it.

// THE R-LEDGER ADAPTER over src/lib/owner-request-store.js. What must hold:
// every name the six callers require still answers with the same result keys;
// ids are R-numbered for all four scopes and a clean store files R1; no
// markdown file is ever created; the person's own entry carries no filedBy and
// an agent's names the agent; a refinement nests under its parent; edit and
// remove are the person's hand and go through the store's tombstone rules; the
// refusal codes keep their names; the CLI verbs work through the same module;
// and an installed build writes and reads in the same place.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const ledger = require('../src/lib/r-ledger');
const store = require('../src/lib/owner-request-store');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'r-ledger-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  return { dir, opts: { rootPath, needsApproval: false } };
}

function files(dir) {
  const out = [];
  const walk = current => {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current)) {
      const file = path.join(current, name);
      if (fs.statSync(file).isDirectory()) walk(file); else out.push(path.relative(dir, file).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

test('the adapter keeps every export name and the store\'s error class', () => {
  assert.deepEqual(Object.keys(ledger).sort(), [
    'GLOBAL_FLOOR', 'ID_PREFIX', 'MAX_FILED_BY_CHARS', 'RESOLUTION_STATUSES', 'RLedgerError', 'SAFE_KEY', 'SCOPES', 'SCOPE_WORD',
    'collectStack', 'decide', 'editRequest', 'ensure', 'fileRequest', 'findEntry', 'ledgerPath', 'nestEntries',
    'nextNumber', 'parseEntryId', 'parseLedger', 'readAll', 'readLedger', 'removeRequest', 'resolve', 'verifyHistory'
  ]);
  assert.equal(ledger.RLedgerError, store.OwnerRequestStoreError);
  assert.deepEqual(ledger.SCOPES, ['global', 'session', 'tree', 'thread']);
  assert.deepEqual(ledger.ID_PREFIX, { global: 'R', session: 'R', tree: 'R', thread: 'R' }, 'one R family for every scope');
  assert.equal(ledger.GLOBAL_FLOOR, 1);
  assert.equal(ledger.SAFE_KEY.source, store.SAFE_KEY.source);
  assert.equal(ledger.SCOPE_WORD.tree, 'this agent and every agent below it');
  assert.throws(() => ledger.parseLedger('anything', 'global'), { code: 'R_LEDGER_MARKDOWN_RETIRED' });
  assert.equal(ledger.RESOLUTION_STATUSES, store.RESOLUTION_STATUSES,
    'a caller reading resolvable statuses through this adapter reads the same set the store enforces, not a copy that could drift');
  assert.ok(ledger.RESOLUTION_STATUSES.has('done') && ledger.RESOLUTION_STATUSES.has('superseded'),
    'resolve() through this module can reach the statuses decide() never could');
});

// L1g: readLedger (= store.readLayer) is the choke point the app's session-
// start block reads through (shell/agent-host.cjs's composeStandingRequestsNote
// -> standing-requests-read.cjs -> this readLedger). Its own gate is
// ACTIVE_STATUSES.has(status), which excludes every RESOLUTION_STATUSES member
// EXCEPT the three that were already active before resolve() existed
// (in-progress, partial, blocked-external -- still standing, correctly kept).
// One test per terminal outcome, naming the reader, per L1g's rule that where
// a reader already handles a status one test naming it is enough.
test('readLedger never returns a record resolved to a terminal status', () => {
  const { opts } = sandbox();
  // resolve() only moves a record OUT of an active status (transact refuses a
  // second resolve once the first has already landed on a terminal one), so
  // each status in this table gets its own freshly filed record.
  for (const status of ['done', 'not-possible-as-asked', 'superseded']) {
    const filed = ledger.fileRequest({ scope: 'global', words: `a rule resolved to ${status}` }, opts);
    store.resolve({ id: filed.id, status, reason: `moved to ${status}`, actor: 'owner' }, opts);
    const read = ledger.readLedger('global', null, opts);
    assert.ok(!read.entries.some(entry => entry.id === filed.id),
      `readLedger must not return ${filed.id} once it is ${status}`);
  }
});

test('readLedger still returns a record resolved to a still-active status', () => {
  const { opts } = sandbox();
  for (const status of ['in-progress', 'partial', 'blocked-external']) {
    const filed = ledger.fileRequest({ scope: 'global', words: `a rule resolved to ${status}` }, opts);
    store.resolve({ id: filed.id, status, reason: `moved to ${status}`, actor: 'owner' }, opts);
    const read = ledger.readLedger('global', null, opts);
    assert.ok(read.entries.some(entry => entry.id === filed.id),
      `readLedger must still return ${filed.id} while it is ${status} -- it is standing, not resolved away`);
  }
});

test('a clean store files R1 for any scope and round-trips verbatim; no markdown is written', () => {
  const { dir, opts } = sandbox();
  const first = ledger.fileRequest({ scope: 'global', words: '  keep the desktop quiet\nno visible shells  ' }, opts);
  assert.equal(first.id, 'R1');
  assert.equal(first.filedBy, null, 'the person\'s own entry carries no attribution');
  assert.equal(first.status, 'open');
  assert.deepEqual(Object.keys(first).sort(), ['awaitingApproval', 'filedBy', 'id', 'key', 'parentId', 'path', 'revision', 'scope', 'stamp', 'status', 'words']);
  const second = ledger.fileRequest({ scope: 'session', key: 'sess-1', words: 'MIT licence for the free product' }, opts);
  assert.equal(second.id, 'R2', 'one counter across scopes');
  assert.equal(second.key, 'sess-1');
  assert.equal(second.path, first.path, 'every scope lives in the one file');
  const read = ledger.readLedger('global', null, opts);
  assert.equal(read.exists, true);
  assert.equal(read.path, ledger.ledgerPath('global', null, opts));
  assert.deepEqual(read.entries.map(entry => entry.id), ['R1']);
  assert.deepEqual(Object.keys(read.entries[0]).sort(), ['id', 'line', 'number', 'parentId', 'stamp', 'status', 'words'], 'a person row carries no filedBy at all');
  assert.equal(read.entries[0].words, 'keep the desktop quiet\nno visible shells', 'ends trimmed, inner bytes untouched');
  assert.equal(read.entries[0].number, 1);
  assert.equal(read.entries[0].line, null);
  assert.equal(read.warnings.length, 0);
  assert.equal(read.nextIdMark, null);
  assert.deepEqual(ledger.readLedger('session', 'sess-1', opts).entries.map(entry => entry.words), ['MIT licence for the free product']);
  assert.deepEqual(files(dir), ['reports/OWNER-REQUEST-LEDGER.json', 'reports/OWNER-REQUEST-LEDGER.json.bak', 'state/owner-request-record-events.jsonl'],
    'the canonical ledger, its backup and its history: no R-LEDGER.md, no state/r-ledger/');
  assert.equal(ledger.nextNumber(read), 3);
});

test('an agent-filed entry names the agent; the person\'s never does; a blank attribution is none', () => {
  const { opts } = sandbox();
  ledger.fileRequest({ scope: 'global', words: 'always ask before spending money' }, opts);
  const byAgent = ledger.fileRequest({ scope: 'global', words: 'keep replies to one sentence', filedBy: 'codex' }, opts);
  assert.equal(byAgent.filedBy, 'codex');
  const read = ledger.readLedger('global', null, opts);
  assert.equal(Object.hasOwn(read.entries[0], 'filedBy'), false);
  assert.equal(read.entries[1].filedBy, 'codex');
  assert.equal(read.entries[1].stamp, byAgent.stamp);
  assert.equal(read.entries[1].words, 'keep replies to one sentence');
  assert.equal(ledger.fileRequest({ scope: 'global', words: 'third', filedBy: 'proposed by codex, accepted by you' }, opts).filedBy, 'proposed by codex, accepted by you');
  assert.equal(ledger.fileRequest({ scope: 'global', words: 'fourth', filedBy: '   ' }, opts).filedBy, null, 'blank attribution is no attribution');
  for (const filedBy of ['codex\nowner', 'x'.repeat(ledger.MAX_FILED_BY_CHARS + 1), 42]) {
    assert.throws(() => ledger.fileRequest({ scope: 'global', words: 'w', filedBy }, opts), { code: 'R_LEDGER_FILED_BY_INVALID' });
  }
  assert.equal(ledger.readLedger('global', null, opts).entries.length, 4);
});

test('refusals keep their names and write nothing', () => {
  const { dir, opts } = sandbox();
  assert.throws(() => ledger.fileRequest({ scope: 'planet', words: 'x' }, opts), { code: 'R_LEDGER_SCOPE_INVALID' });
  assert.throws(() => ledger.fileRequest({ scope: 'tree', words: 'x' }, opts), { code: 'R_LEDGER_KEY_INVALID' });
  assert.throws(() => ledger.fileRequest({ scope: 'global', words: '   ' }, opts), { code: 'R_LEDGER_WORDS_EMPTY' });
  assert.throws(() => ledger.fileRequest({ scope: 'global', words: 42 }, opts), { code: 'R_LEDGER_WORDS_INVALID' });
  assert.throws(() => ledger.fileRequest({ scope: 'global', words: 'x'.repeat(16 * 1024 + 1) }, opts), { code: 'R_LEDGER_WORDS_TOO_LONG' });
  assert.throws(() => ledger.fileRequest({ scope: 'thread', key: '../escape', words: 'x' }, opts), { code: 'R_LEDGER_KEY_INVALID' });
  assert.throws(() => ledger.ledgerPath('thread', 'a b', opts), { code: 'R_LEDGER_KEY_INVALID' });
  assert.throws(() => ledger.ledgerPath('nope', null, opts), { code: 'R_LEDGER_SCOPE_INVALID' });
  assert.throws(() => ledger.findEntry('Q40', opts), { code: 'R_LEDGER_ID_INVALID' });
  assert.throws(() => ledger.findEntry('RS3', opts), { code: 'R_LEDGER_ID_INVALID' }, 'the retired prefixes are not ids');
  assert.equal(fs.existsSync(ledger.ledgerPath('global', null, opts)), false);
  assert.deepEqual(files(dir), []);
});

test('the boot stack reads global, session, ancestor trees top-down, then thread; a waiting row never rides', () => {
  const { opts } = sandbox();
  ledger.fileRequest({ scope: 'global', words: 'G' }, opts);
  ledger.fileRequest({ scope: 'global', words: 'G waiting', filedBy: 'codex', proposed: true }, opts);
  ledger.fileRequest({ scope: 'session', key: 'S', words: 'S-rule' }, opts);
  ledger.fileRequest({ scope: 'tree', key: 'root-agent', words: 'root tree rule' }, opts);
  ledger.fileRequest({ scope: 'tree', key: 'manager-agent', words: 'manager branch rule' }, opts);
  ledger.fileRequest({ scope: 'thread', key: 'worker-thread', words: 'only me', filedBy: 'claude' }, opts);
  const stack = ledger.collectStack({ sessionId: 'S', treeAnchors: ['root-agent', 'manager-agent'], threadId: 'worker-thread' }, opts);
  assert.deepEqual(stack.map(layer => `${layer.scope}:${layer.key || ''}`), ['global:', 'session:S', 'tree:root-agent', 'tree:manager-agent', 'thread:worker-thread']);
  assert.deepEqual(stack.map(layer => layer.entries.map(entry => entry.words).join('|')), ['G', 'S-rule', 'root tree rule', 'manager branch rule', 'only me']);
  assert.deepEqual(Object.keys(stack[0]).sort(), ['appliesTo', 'entries', 'exists', 'key', 'path', 'scope', 'warnings']);
  assert.equal(Object.hasOwn(stack[0].entries[0], 'filedBy'), false);
  assert.equal(stack[4].entries[0].filedBy, 'claude');
  assert.equal(stack[4].entries[0].depth, 0);
  assert.deepEqual(ledger.readLedger('global', null, { ...opts, includeProposed: true }).entries.map(entry => `${entry.id}:${entry.status}`), ['R1:open', 'R2:proposed'], 'the layer read carries the waiting row when asked, for the duplicate check');
  assert.deepEqual(ledger.readLedger('global', null, opts).entries.map(entry => entry.id), ['R1'], 'a plain layer read never hands out a waiting row');
  const sibling = ledger.collectStack({ sessionId: 'S', treeAnchors: ['root-agent'], threadId: 'other-thread' }, opts);
  assert.deepEqual(sibling.find(layer => layer.scope === 'thread').entries, [], 'another thread does not see this thread\'s rules');
  assert.equal(sibling.some(layer => layer.key === 'manager-agent'), false, 'a sibling branch never inherits the manager\'s tree rule');
});

test('findEntry reads where an id stands; parseEntryId keeps the dotted grammar and no scope', () => {
  const { opts } = sandbox();
  ledger.fileRequest({ scope: 'tree', key: 'node-2', words: 'w' }, opts);
  ledger.fileRequest({ scope: 'tree', key: 'node-2', words: 'w, refined', parentId: 'R1' }, opts);
  assert.deepEqual(ledger.findEntry('R1', opts), { scope: 'tree', id: 'R1', key: 'node-2' });
  assert.deepEqual(ledger.findEntry('R1.1', opts), { scope: 'tree', id: 'R1.1', key: 'node-2' });
  assert.throws(() => ledger.findEntry('R7', opts), { code: 'R_LEDGER_ENTRY_UNKNOWN' });
  assert.deepEqual(ledger.parseEntryId('R12.1.2'), { id: 'R12.1.2', scope: null, prefix: 'R', number: 12, segments: [1, 2], parentId: 'R12.1' });
  assert.equal(ledger.parseEntryId('R5').parentId, null);
  assert.equal(ledger.parseEntryId('R2000.0'), null);
  assert.equal(ledger.parseEntryId('R2000.01'), null);
  assert.equal(ledger.parseEntryId('Q40.1'), null);
  assert.equal(ledger.parseEntryId('RS3.1'), null, 'the retired prefixes are not ids');
});

test('a refinement files as a dotted child of a standing entry, parses back, and lists under its parent', () => {
  const { opts } = sandbox();
  ledger.fileRequest({ scope: 'global', words: 'keep it short' }, opts);
  const child = ledger.fileRequest({ scope: 'global', words: 'keep it short — one sentence', parentId: 'R1', filedBy: 'codex' }, opts);
  assert.equal(child.id, 'R1.1');
  assert.equal(child.parentId, 'R1');
  assert.equal(ledger.fileRequest({ scope: 'global', words: 'and no emoji', parentId: 'R1.1' }, opts).id, 'R1.1.1');
  assert.equal(ledger.fileRequest({ scope: 'global', words: 'keep it short, no lists', parentId: 'R1' }, opts).id, 'R1.2');
  const root = ledger.fileRequest({ scope: 'global', words: 'another root' }, opts);
  assert.equal(root.id, 'R2', 'children do not move the root numbering');
  const read = ledger.readLedger('global', null, opts);
  assert.deepEqual(read.entries.map(entry => [entry.id, entry.parentId]), [['R1', null], ['R1.1', 'R1'], ['R1.1.1', 'R1.1'], ['R1.2', 'R1'], ['R2', null]]);
  assert.equal(read.entries[1].filedBy, 'codex');
  const [layer] = ledger.collectStack({}, opts);
  assert.deepEqual(layer.entries.map(entry => `${entry.id}@${entry.depth}`), ['R1@0', 'R1.1@1', 'R1.1.1@2', 'R1.2@1', 'R2@0']);
  assert.deepEqual(ledger.nestEntries(read.entries).map(entry => entry.id), ['R1', 'R1.1', 'R1.1.1', 'R1.2', 'R2']);
  assert.throws(() => ledger.fileRequest({ scope: 'global', words: 'x', parentId: 'R9' }, opts), { code: 'R_LEDGER_PARENT_UNKNOWN' });
  assert.throws(() => ledger.fileRequest({ scope: 'global', words: 'x', parentId: 'RS1' }, opts), { code: 'R_LEDGER_PARENT_INVALID' });
  assert.equal(ledger.readLedger('global', null, opts).entries.length, 5);
  // A child the person removed never has its number handed to a later sibling.
  assert.deepEqual(ledger.removeRequest({ id: 'R1.1' }, opts).removed, ['R1.1', 'R1.1.1']);
  assert.deepEqual(ledger.readLedger('global', null, opts).entries.map(entry => entry.id), ['R1', 'R1.2', 'R2']);
  assert.equal(ledger.fileRequest({ scope: 'global', words: 'third refinement', parentId: 'R1' }, opts).id, 'R1.3', 'R1.1 is gone and R1.2 stands; the next is .3');
});

test('the person edits one entry in place and removes another; both are tombstone-safe and refuse unknown ids', () => {
  const { opts } = sandbox();
  ledger.fileRequest({ scope: 'session', key: 'S1', words: 'first' }, opts);
  ledger.fileRequest({ scope: 'session', key: 'S1', words: 'second — keep\nboth lines', filedBy: 'codex' }, opts);
  ledger.fileRequest({ scope: 'session', key: 'S1', words: 'third' }, opts);
  const file = ledger.ledgerPath('session', 'S1', opts);
  const before = fs.readFileSync(file, 'utf8');
  const edited = ledger.editRequest({ id: 'R2', key: 'S1', words: '  second — rewritten by hand  ' }, opts);
  assert.equal(edited.id, 'R2');
  assert.equal(edited.words, 'second — rewritten by hand');
  assert.equal(edited.scope, 'session');
  assert.equal(edited.key, 'S1');
  assert.equal(edited.backup, `${file}.bak`);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), before, 'the .bak is the file exactly as it was');
  const read = ledger.readLedger('session', 'S1', opts);
  assert.deepEqual(read.entries.map(entry => entry.words), ['first', 'second — rewritten by hand', 'third']);
  assert.equal(read.entries[1].filedBy, 'codex', 'the attribution stays');
  const history = ledger.readAll({ includeRemoved: true }, opts).records.find(record => record.id === 'R2').history;
  assert.deepEqual(history.map(row => [row.kind, row.wordsBefore]), [['file', undefined], ['edit', 'second — keep\nboth lines']]);
  assert.throws(() => ledger.editRequest({ id: 'R9', key: 'S1', words: 'x' }, opts), { code: 'R_LEDGER_ENTRY_UNKNOWN' });
  assert.throws(() => ledger.editRequest({ id: 'R1', key: 'S1', words: '   ' }, opts), { code: 'R_LEDGER_WORDS_EMPTY' });
  assert.throws(() => ledger.editRequest({ id: 'nonsense', key: 'S1', words: 'x' }, opts), { code: 'R_LEDGER_ID_INVALID' });
  const removed = ledger.removeRequest({ id: 'R3', key: 'S1' }, opts);
  assert.deepEqual(removed.removed, ['R3']);
  assert.equal(removed.backup, `${file}.bak`);
  assert.deepEqual(ledger.readLedger('session', 'S1', opts).entries.map(entry => entry.id), ['R1', 'R2']);
  assert.equal(ledger.readAll({ includeRemoved: true }, opts).records.find(record => record.id === 'R3').status, 'removed', 'kept on file as deleted');
  assert.throws(() => ledger.removeRequest({ id: 'R3', key: 'S1' }, opts), { code: 'R_LEDGER_ENTRY_UNKNOWN' });
  assert.throws(() => ledger.removeRequest({ id: 'R-3' }, opts), { code: 'R_LEDGER_ID_INVALID' });
  assert.equal(ledger.fileRequest({ scope: 'session', key: 'S1', words: 'fourth' }, opts).id, 'R4', 'R3 stays retired');
  assert.equal(ledger.verifyHistory(opts).ok, true);
});

test('decide and ensure reach the store as the person', () => {
  const { opts } = sandbox();
  assert.equal(ledger.ensure(opts).created, true);
  assert.equal(ledger.ensure(opts).created, false);
  const waiting = ledger.fileRequest({ scope: 'global', words: 'from an agent', filedBy: 'codex', proposed: true }, opts);
  assert.equal(waiting.status, 'proposed');
  assert.equal(waiting.awaitingApproval, true);
  assert.deepEqual(ledger.collectStack({}, opts)[0].entries, [], 'a waiting row is not handed to any agent');
  const decided = ledger.decide({ id: 'R1', decision: 'approve', reason: 'yes' }, opts);
  assert.equal(decided.status, 'open');
  assert.deepEqual(ledger.collectStack({}, opts)[0].entries.map(entry => entry.id), ['R1']);
  assert.equal(ledger.decide({ id: 'R1', decision: 'decline' }, opts).status, 'declined');
  assert.deepEqual(ledger.readLedger('global', null, opts).entries, []);
});

test('the CLI files, lists, shows, edits, removes, verifies and lists all through the same module', () => {
  const { dir } = sandbox();
  const env = { ...process.env, TOOLSENABLED_STATE_ROOT: dir };
  const cli = path.join(__dirname, '..', 'tools', 'r-ledger.js');
  const run = (args, extra = {}) => execFileSync('node', [cli, ...args], { env, encoding: 'utf8', ...extra });
  const receipt = JSON.parse(run(['file', '--scope', 'session', '--key', 'cli-test', '--words', 'from the cli', '--json']));
  assert.equal(receipt.id, 'R1');
  assert.ok(receipt.path.startsWith(dir), `the ledger lives under the state root: ${receipt.path}`);
  assert.equal(JSON.parse(run(['file', '--scope', 'global', '--words', 'second', '--json'])).id, 'R2');
  const listed = JSON.parse(run(['list', '--scope', 'session', '--key', 'cli-test', '--json']));
  assert.equal(listed.entries[0].words, 'from the cli');
  assert.equal(listed.entries[0].status, 'open');
  const shown = JSON.parse(run(['show', 'R1', '--json']));
  assert.equal(shown.entry.id, 'R1');
  assert.equal(shown.scope, 'session');
  assert.equal(shown.key, 'cli-test');
  let refusedCode = 0;
  try { run(['file', '--scope', 'session', '--key', 'cli-test', '--words', '   '], { stdio: 'pipe' }); }
  catch (error) { refusedCode = error.status; }
  assert.equal(refusedCode, 1, 'an empty request exits 1 with its reason');
  const edited = JSON.parse(run(['edit', '--id', 'R1', '--words-stdin', '--json'], { input: 'as retyped by hand\n' }));
  assert.equal(edited.words, 'as retyped by hand');
  assert.ok(fs.existsSync(`${edited.path}.bak`), 'the .bak sits beside the file');
  let status = 0;
  try { run(['edit', '--id', 'R1', '--words', 'on argv'], { stdio: 'pipe' }); }
  catch (error) { status = error.status; }
  assert.equal(status, 2, 'words on the command line are a usage error, not an edit');
  const removed = JSON.parse(run(['remove', '--id', 'R2', '--json']));
  assert.deepEqual(removed.removed, ['R2']);
  status = 0;
  try { run(['remove', '--id', 'R2'], { stdio: 'pipe' }); }
  catch (error) { status = error.status; }
  assert.equal(status, 1, 'an unknown or deleted id is refused with its reason');
  const stack = JSON.parse(run(['stack', '--session', 'cli-test', '--json']));
  assert.deepEqual(stack.map(layer => `${layer.scope}:${layer.entries.length}`), ['global:0', 'session:1']);
  const all = JSON.parse(run(['all', '--json']));
  assert.deepEqual(all.records.map(record => `${record.id}:${record.status}`), ['R1:open', 'R2:removed']);
  const verified = JSON.parse(run(['verify', '--json']));
  assert.equal(verified.ok, true);
  assert.equal(verified.events, 4);
  assert.match(run(['verify']), /^History verified: 4 events\./);
  const text = run(['list', '--scope', 'session', '--key', 'cli-test']);
  assert.match(text, /^R1 — \S+\n    as retyped by hand\n/m);
});

test('the CLI is the person\'s way out of a ledger that refuses every write: adopt without any other file, recover with the preserved journal', () => {
  const cli = path.join(__dirname, '..', 'tools', 'r-ledger.js');
  const runIn = dir => (args, extra = {}) => execFileSync('node', [cli, ...args], { env: { ...process.env, TOOLSENABLED_STATE_ROOT: dir }, encoding: 'utf8', ...extra });
  const refused = (run, args) => { try { run(args, { stdio: 'pipe' }); return null; } catch (error) { return { status: error.status, stderr: String(error.stderr) }; } };

  // state/ is lost while reports/ survives.
  const lost = sandbox();
  const run = runIn(lost.dir);
  assert.equal(JSON.parse(run(['file', '--scope', 'global', '--words', 'kept words', '--json'])).id, 'R1');
  fs.renameSync(path.join(lost.dir, 'state'), path.join(lost.dir, 'state-lost'));
  const stuck = refused(run, ['file', '--scope', 'global', '--words', 'second']);
  assert.equal(stuck.status, 1);
  assert.match(stuck.stderr, /^R_LEDGER_CHAIN_APPEND_UNCONFIRMED: .*only the person can adopt/);
  const adopted = JSON.parse(run(['adopt', '--json']));
  assert.deepEqual(adopted.adopted.map(row => row.id), ['R1']);
  assert.match(adopted.adopted[0].unconfirmed.eventSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(run(['file', '--scope', 'global', '--words', 'second', '--json'])).id, 'R2');
  assert.equal(JSON.parse(run(['verify', '--json'])).ok, true);
  assert.match(run(['adopt']), /^Nothing to adopt/);
  assert.equal(JSON.parse(run(['all', '--json'])).records[0].verbatim, 'kept words');

  // The document came from another computer and its journal was kept.
  const source = sandbox(), target = sandbox();
  runIn(source.dir)(['file', '--scope', 'global', '--words', 'from the other computer']);
  fs.mkdirSync(path.join(target.dir, 'reports'), { recursive: true });
  fs.copyFileSync(path.join(source.dir, 'reports', 'OWNER-REQUEST-LEDGER.json'), path.join(target.dir, 'reports', 'OWNER-REQUEST-LEDGER.json'));
  const there = runIn(target.dir);
  assert.equal(refused(there, ['file', '--scope', 'global', '--words', 'x']).status, 1);
  assert.equal(refused(there, ['recover']).status, 2, 'recover needs --from');
  assert.match(refused(there, ['recover', '--from', 'relative/journal.jsonl']).stderr, /^R_LEDGER_RECOVERY_SOURCE_INVALID/);
  const recovered = JSON.parse(there(['recover', '--from', path.join(source.dir, 'state', 'owner-request-record-events.jsonl'), '--json']));
  assert.deepEqual(recovered.recovered, ['R1']);
  assert.equal(JSON.parse(there(['file', '--scope', 'global', '--words', 'local again', '--json'])).id, 'R2');
  assert.equal(JSON.parse(there(['verify', '--json'])).ok, true);
});

/* THE /Task AND /Ask FAMILIES RIDE fileRequest WITH ONE EXTRA FIELD (kind).
   A payload with no kind must take the exact R branch it always took --
   byte-for-byte -- proven here by hash-diffing the whole ledger document
   against a plain fileRequest call with the same words. */
test('fileRequest dispatches on kind: no kind is byte-for-byte R; kind T and A file through store.fileTask/fileAsk; kind P is never dispatched here', () => {
  const { opts: optsA } = sandbox();
  const { opts: optsB } = sandbox();
  const fixedNow = () => 1735689600000;
  const withoutKind = ledger.fileRequest({ scope: 'global', words: 'plain owner words', now: fixedNow }, optsA);
  const withRKind = ledger.fileRequest({ scope: 'global', words: 'plain owner words', kind: 'R', now: fixedNow }, optsB);
  // eventSha256 is seeded by chainEvent's own crypto.randomUUID() eventId, so
  // it differs between any two calls by design (the same reason two R writes
  // never chain to the same hash); strip only that one random field before
  // comparing, so what is actually asserted is that the two RECORDS -- every
  // field fileRequest itself decides -- are identical.
  const stripHash = text => text.replace(/[a-f0-9]{64}/g, '<hash>');
  const documentA = stripHash(fs.readFileSync(ledger.ledgerPath('global', null, optsA), 'utf8'));
  const documentB = stripHash(fs.readFileSync(ledger.ledgerPath('global', null, optsB), 'utf8'));
  assert.equal(documentA, documentB, 'kind: "R" and no kind at all, with the same clock, write identical ledger documents apart from the per-write random hash seed');
  assert.equal(withoutKind.id, 'R1');
  assert.equal(withRKind.id, 'R1');

  const { opts } = sandbox();
  const task = ledger.fileRequest({ scope: 'global', words: 'write the report', filedBy: 'codex', kind: 'T' }, opts);
  assert.equal(task.id, 'T1');
  assert.equal(store.readAll({ ...opts, kinds: ['T'] }).records[0].status, 'open');
  const ask = ledger.fileRequest({ scope: 'global', words: 'may I restart the service?', filedBy: 'codex', kind: 'A' }, opts);
  assert.equal(ask.id, 'A1');
  assert.equal(store.readAll({ ...opts, kinds: ['A'] }).records[0].status, 'open');
  assert.equal(ledger.fileRequest({ scope: 'global', words: 'a rule again' }, opts).id, 'R1', 'the R counter is untouched by T and A filings');
});

test('the session-start reader (readLedger, collectStack) serves ONLY kind R even once T, A and P records exist', () => {
  const { opts } = sandbox();
  ledger.fileRequest({ scope: 'global', words: 'a rule' }, opts);
  ledger.fileRequest({ scope: 'global', words: 'a task', kind: 'T' }, opts);
  ledger.fileRequest({ scope: 'global', words: 'an ask', kind: 'A' }, opts);
  store.filePurchase({ scope: 'global', words: 'a purchase' }, opts);
  assert.deepEqual(ledger.readLedger('global', null, opts).entries.map(entry => entry.id), ['R1']);
  assert.deepEqual(ledger.collectStack({}, opts)[0].entries.map(entry => entry.id), ['R1']);
  assert.deepEqual(ledger.readAll({}, opts).records.map(record => record.id), ['R1']);
});

/* AN INSTALLED BUILD WRITES AND READS THE SAME LEDGER. The store resolves
   through runtime-state-root at call time, which redirects reports/ and state/
   to the per-user state root when the program root is a read-only staged
   payload. agent-onboarding.js reads through the same resolver. */
test('a payload-hosted root writes and reads its ledger in the same place', () => {
  const base = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'r-ledger-install-'));
  const program = path.join(base, 'payload');
  const stateRoot = path.join(base, 'state-root');
  fs.mkdirSync(program, { recursive: true });
  fs.writeFileSync(path.join(program, 'PAYLOAD.json'), JSON.stringify({ v: 1 }), 'utf8');
  const previous = process.env.TOOLSENABLED_STATE_ROOT;
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot;
  const stateRootModule = require('../src/lib/runtime-state-root');
  try {
    stateRootModule.resetStateRootForTests();
    const rootPath = (...parts) => stateRootModule.programOrStatePath(program, parts);
    const filed = ledger.fileRequest({ scope: 'global', words: 'Begin every reply with PINEAPPLE.' }, { rootPath });
    assert.ok(filed.path.startsWith(stateRoot), 'a staged payload files under the state root');
    assert.ok(!filed.path.startsWith(program), 'never into the read-only program root');
    const layers = ledger.collectStack({}, { rootPath });
    const global = layers.find(layer => layer.scope === 'global');
    assert.equal(global.exists, true, 'the packet reads the ledger it just wrote');
    assert.equal(global.entries.length, 1);
    assert.match(global.entries[0].words, /PINEAPPLE/);
    assert.equal(ledger.fileRequest({ scope: 'global', words: 'and the default path agrees' }).path, filed.path, 'no rootPath: the same state root');
  } finally {
    if (previous === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
    else process.env.TOOLSENABLED_STATE_ROOT = previous;
    stateRootModule.resetStateRootForTests();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
