'use strict';

require('./helpers/isolated-state-root');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot, within } = require('./lib/isolated-environment');
const ledger = require('../src/lib/owner-request-store');
const { loadSettings } = require('../src/lib/settings');
const { loadRegistry } = require('../src/lib/settings-registry');
const { SETTING_ID, MAX_RULES_TURN_BYTES, loadRulesReadMode,
  buildRulesTurnSnapshot, assertRulesTurnSnapshotCurrent } = require('../src/lib/rules-turn-snapshot');

function row(id, verbatim, extra = {}) {
  return { id, kind: id.startsWith('R') ? 'R' : id[0], scope: 'global', scopeKey: null,
    parentId: null, verbatim, status: 'open', ...extra };
}

function fixture(t, records = null) {
  const parent = isolatedTemporaryRoot();
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'rules-turn-snapshot-'));
  const file = path.join(dir, 'reports', 'OWNER-REQUEST-LEDGER.json');
  const storeOptions = { rootPath: (...parts) => path.join(dir, ...parts) };
  t.after(() => {
    assert.ok(within(parent, dir) && dir !== parent);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const save = (requests, revision = 0) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision, requests }), 'utf8');
  };
  if (records !== null) save(records);
  return { dir, file, save, options: { storeOptions } };
}

test('the shared setting defaults off and a stored choice is read without writing', t => {
  const f = fixture(t);
  const valuesPath = path.join(f.dir, 'settings.json');
  const entry = loadRegistry().byId.get(SETTING_ID);
  assert.equal(entry.control, 'toggle');
  assert.equal(entry.default, false);
  assert.equal(entry.applies, 'next-call');
  const read = request => loadSettings({ ...request, valuesPath });
  assert.deepEqual(loadRulesReadMode({ loadSettings: read }), { enabled: false });
  assert.equal(fs.existsSync(valuesPath), false);
  const saved = JSON.stringify({ schemaVersion: 1, revision: 1, values: { [SETTING_ID]: true },
    provenance: { [SETTING_ID]: { source: 'user', atMs: 1, directive: null } } });
  fs.writeFileSync(valuesPath, saved);
  assert.deepEqual(loadRulesReadMode({ loadSettings: read }), { enabled: true });
  assert.equal(fs.readFileSync(valuesPath, 'utf8'), saved);
});

test('invalid, unreadable and incomplete policy results do not become off', () => {
  const answers = [null, {}, { values: {} }, { values: { [SETTING_ID]: true } },
    { values: {}, rejected: [] }, { values: { [SETTING_ID]: 'true' }, rejected: [] },
    { values: { [SETTING_ID]: false }, rejected: [{ id: '*' }] },
    { values: { [SETTING_ID]: false }, rejected: [{ id: SETTING_ID }] }];
  for (const answer of answers) assert.throws(() => loadRulesReadMode({ loadSettings: () => answer }), { code: 'RULES_POLICY_UNAVAILABLE' });
  assert.throws(() => loadRulesReadMode({ loadSettings: () => { throw new Error('Synthetic I/O failure'); } }), { code: 'RULES_POLICY_UNAVAILABLE' });
  assert.deepEqual(loadRulesReadMode({ loadSettings: () => ({ values: { [SETTING_ID]: false }, rejected: [{ id: 'unrelated.setting' }] }) }), { enabled: false });
});

test('one canonical read includes every applicable active scope in order, with exact words and refinements', t => {
  const exact = '  Keep both lines exactly.\r\nSecond line: café 🧪.  ';
  const f = fixture(t, [
    row('R1', exact),
    row('R1.1', 'The full refinement.', { parentId: 'R1' }),
    row('R2', 'Session rule.', { scope: 'session', scopeKey: 'session-1' }),
    row('R3', 'Ancestor rule.', { scope: 'tree', scopeKey: 'root-node' }),
    row('R4', 'Nearer tree rule.', { scope: 'tree', scopeKey: 'parent-node', status: 'partial' }),
    row('R5', 'Conversation rule.', { scope: 'thread', scopeKey: 'node-1', status: 'in-progress' }),
    row('R6', 'Still applies while blocked.', { status: 'blocked-external' }),
    row('R7', 'Other session.', { scope: 'session', scopeKey: 'other-session' }),
    row('R8', 'Other tree.', { scope: 'tree', scopeKey: 'other-node' }),
    row('R9', 'Other conversation.', { scope: 'thread', scopeKey: 'other-node' }),
    ...['proposed', 'declined', 'removed', 'done', 'superseded', 'not-possible-as-asked'].map((status, i) => row(`R${10 + i}`, `Inactive ${status}.`, { status })),
    row('T1', 'Task words are not standing rules.'), row('A1', 'Ask words are not standing rules.'), row('P1', 'Purchase words are not standing rules.'),
  ]);
  const before = fs.readFileSync(f.file, 'utf8');
  let reads = 0;
  const store = { readAll(options) { reads++; return ledger.readAll(options); } };
  const identity = { sessionId: 'session-1', treeAnchors: ['root-node', 'parent-node'], threadId: 'node-1' };
  const snapshot = buildRulesTurnSnapshot(identity, { ...f.options, store });
  assert.equal(reads, 1);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.ruleCount, 7);
  assert.deepEqual(snapshot.scopes.map(scope => [scope.scope, scope.key]), [
    ['global', null], ['session', 'session-1'], ['tree', 'root-node'], ['tree', 'parent-node'], ['thread', 'node-1'],
  ]);
  assert.deepEqual(snapshot.scopes.flatMap(scope => scope.entries.map(entry => entry.id)), ['R1', 'R1.1', 'R6', 'R2', 'R3', 'R4', 'R5']);
  assert.equal(snapshot.scopes[0].entries[0].words, exact);
  assert.ok(snapshot.text.includes(exact));
  assert.ok(snapshot.text.includes('R1.1 (refines R1):\nThe full refinement.'));
  assert.doesNotMatch(snapshot.text, /Other session|Other tree|Other conversation|Inactive|Task words|Ask words|Purchase words/);
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.byteLength, Buffer.byteLength(snapshot.text, 'utf8'));
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(assertRulesTurnSnapshotCurrent(snapshot, identity).digest, snapshot.digest);
  assert.equal(reads, 2, 'final dispatch recheck performs a new canonical read');
});

test('large applicable rules above the old 20KiB cap are included in full', t => {
  const first = 'First complete rule.\n' + 'A'.repeat(14000);
  const second = 'Second complete rule.\n' + 'B'.repeat(14000);
  const f = fixture(t, [row('R1', first), row('R2', second)]);
  const snapshot = buildRulesTurnSnapshot({}, f.options);
  assert.ok(snapshot.byteLength > 20 * 1024);
  assert.ok(snapshot.text.includes(first));
  assert.ok(snapshot.text.includes(second));
  assert.equal(snapshot.ruleCount, 2);
  assert.deepEqual(snapshot.scopes[0].entries.map(entry => entry.words), [first, second]);
});

test('empty existing ledger is complete for an anonymous agent, while a missing ledger fails without creation', t => {
  const missing = fixture(t);
  assert.throws(() => buildRulesTurnSnapshot({}, missing.options), { code: 'RULES_CONTEXT_UNAVAILABLE' });
  assert.equal(fs.existsSync(missing.file), false);
  const empty = fixture(t, []);
  const snapshot = buildRulesTurnSnapshot({}, empty.options);
  assert.equal(snapshot.ruleCount, 0);
  assert.deepEqual(snapshot.scopes.map(scope => [scope.scope, scope.key, scope.entries.length]), [['global', null, 0]]);
  assert.match(snapshot.text, /No active rules in this scope/);
  assert.equal(snapshot.complete, true);
});

test('unreadable, malformed, partial and unavailable canonical reads fail closed', t => {
  const f = fixture(t, []);
  fs.writeFileSync(f.file, '{');
  assert.throws(() => buildRulesTurnSnapshot({}, f.options), error => error.code === 'RULES_CONTEXT_UNAVAILABLE' && error.details.causeCode === 'R_LEDGER_UNREADABLE');
  const valid = { exists: true, revision: 0, records: [] };
  const answers = [null, {}, { ...valid, exists: false }, { ...valid, revision: null },
    { ...valid, revision: -1 }, { ...valid, records: null }, { ...valid, complete: false },
    { ...valid, truncated: true }, { ...valid, nextOffset: 25 }, { ...valid, warnings: ['An ancestor could not be read.'] }];
  for (const answer of answers) assert.throws(() => buildRulesTurnSnapshot({}, { store: { readAll: () => answer } }), { code: 'RULES_CONTEXT_UNAVAILABLE' });
  assert.throws(() => buildRulesTurnSnapshot({}, { store: { readAll() { throw Object.assign(new Error('Synthetic denied file'), { code: 'EACCES' }); } } }),
    error => error.code === 'RULES_CONTEXT_UNAVAILABLE' && error.details.causeCode === 'EACCES' && !error.message.includes('Synthetic'));
});

test('the real disk reader rejects incomplete rules before filtering or legacy normalization', t => {
  const f = fixture(t, []);
  for (const records of [
    [{ verbatim: 'Missing identity.', status: 'open' }],
    [row('R1', 'One.'), row('R1', 'Duplicate.')],
    [row('R1', 'A rule must not disappear.', { kind: 'T' })],
    [row('T1', 'A task must not become a rule.', { kind: 'R' })],
    [row('Rbroken', 'Malformed rule identity.')],
    [row('R1', 'Explicitly invalid scope.', { scope: 'somewhere' })],
    [row('R1', undefined)],
    [row('R1', 'Missing status.', { status: undefined })],
  ]) {
    f.save(records);
    const before = fs.readFileSync(f.file, 'utf8');
    assert.throws(() => buildRulesTurnSnapshot({}, f.options), error =>
      ['RULES_CONTEXT_UNAVAILABLE', 'RULES_CONTEXT_INCOMPLETE'].includes(error.code));
    assert.equal(fs.readFileSync(f.file, 'utf8'), before, 'a refusal never repairs or rewrites the owner record');
  }
  f.save([row('R1', 'A conflicting stored kind.', { kind: 'T' })]);
  assert.equal(ledger.readAll(f.options.storeOptions).records.length, 0, 'ordinary readers retain their existing kind filtering');
  f.save([row('R1', 'An explicit unsupported scope.', { scope: 'somewhere' })]);
  assert.equal(ledger.readAll(f.options.storeOptions).records[0].scope, 'global', 'ordinary readers retain legacy normalization');
  f.save([{ id: 'R1', verbatim: 'Legacy global rule.', status: 'open' },
    { id: 'R2', scope: 'thread', threadId: 'node-1', verbatim: 'Legacy conversation rule.', status: 'open' }]);
  const snapshot = buildRulesTurnSnapshot({ threadId: 'node-1' }, f.options);
  assert.deepEqual(snapshot.scopes.map(scope => scope.entries.map(entry => entry.words)), [
    ['Legacy global rule.'], ['Legacy conversation rule.'],
  ]);
});

test('missing words, ambiguous scope, unknown active state and cyclic refinement cannot silently disappear', t => {
  const f = fixture(t, []);
  for (const records of [
    [row('R1', '')], [row('R1', 'Words.', { status: 'unknown-state' })],
    [row('R1', 'Words.', { scope: 'tree', scopeKey: null })],
    [row('R1', 'One.', { parentId: 'R2' }), row('R2', 'Two.', { parentId: 'R1' })],
  ]) {
    f.save(records);
    assert.throws(() => buildRulesTurnSnapshot({}, f.options), { code: 'RULES_CONTEXT_INCOMPLETE' });
  }
});

test('applicable edits invalidate the snapshot even if a writer fails to advance revision', t => {
  const f = fixture(t, [row('R1', 'Original current rule.')]);
  const old = buildRulesTurnSnapshot({}, f.options);
  f.save([row('R1', 'Changed current rule.')], old.revision);
  assert.throws(() => assertRulesTurnSnapshotCurrent(old), { code: 'RULES_CONTEXT_CHANGED' });
  assert.equal(old.scopes[0].entries[0].words, 'Original current rule.');
  assert.ok(buildRulesTurnSnapshot({}, f.options).text.includes('Changed current rule.'));
});

test('rule removal and a saved tree move invalidate previous context, including the last rule', t => {
  const f = fixture(t, [row('R1', 'Original current rule.')]);
  const old = buildRulesTurnSnapshot({ threadId: 'node-1', treeAnchors: ['parent-1'] }, f.options);
  assert.throws(() => assertRulesTurnSnapshotCurrent(old, { threadId: 'node-1', treeAnchors: ['parent-2'] }), { code: 'RULES_CONTEXT_CHANGED' });
  f.save([row('R1', 'Original current rule.', { status: 'removed' })], 1);
  assert.throws(() => assertRulesTurnSnapshotCurrent(old), { code: 'RULES_CONTEXT_CHANGED' });
  const current = buildRulesTurnSnapshot({}, f.options);
  assert.equal(current.ruleCount, 0);
  assert.doesNotMatch(current.text, /Original current rule/);
});

test('unrelated task and other-scope changes keep the complete applicable digest', t => {
  const identity = { sessionId: 'session-1', treeAnchors: ['parent-1'], threadId: 'node-1' };
  const records = [row('R1', 'Keep this rule.'), row('R2', 'Other rule.', { scope: 'thread', scopeKey: 'node-2' }), row('T1', 'Task version one.')];
  const f = fixture(t, records);
  const snapshot = buildRulesTurnSnapshot(identity, f.options);
  f.save([records[0], { ...records[1], verbatim: 'Other rule version two.' }, row('T1', 'Task version two.')], 2);
  const current = assertRulesTurnSnapshotCurrent(snapshot, identity);
  assert.equal(current.digest, snapshot.digest);
  assert.equal(current.text, snapshot.text);
  assert.equal(current.revision, 2);
});

test('an unavailable recheck and a copied or partial snapshot cannot authorize a turn', t => {
  const f = fixture(t, [row('R1', 'Complete words.')]);
  const snapshot = buildRulesTurnSnapshot({}, f.options);
  for (const value of [null, {}, { ...snapshot }, { ...snapshot, complete: false }, { ...snapshot, text: '' }]) {
    assert.throws(() => assertRulesTurnSnapshotCurrent(value), { code: 'RULES_CONTEXT_UNVERIFIED' });
  }
  assert.throws(() => { snapshot.text = ''; }, TypeError);
  assert.throws(() => { snapshot.scopes[0].entries[0].words = ''; }, TypeError);
  fs.writeFileSync(f.file, '{');
  assert.throws(() => assertRulesTurnSnapshotCurrent(snapshot), { code: 'RULES_CONTEXT_UNAVAILABLE' });
});

test('total UTF-8 byte bound rejects the whole context and never returns a shortened block', t => {
  const f = fixture(t, [row('R1', 'é'.repeat(2000))]);
  const full = buildRulesTurnSnapshot({}, f.options);
  assert.ok(full.byteLength > full.text.length);
  assert.equal(buildRulesTurnSnapshot({}, { ...f.options, maxBytes: full.byteLength }).text, full.text);
  assert.throws(() => buildRulesTurnSnapshot({}, { ...f.options, maxBytes: full.byteLength - 1 }),
    error => error.code === 'RULES_CONTEXT_TOO_LARGE' && error.details.byteLength === full.byteLength && error.details.ruleCount === 1);
  f.save([row('R1', 'x'.repeat(MAX_RULES_TURN_BYTES))]);
  assert.throws(() => buildRulesTurnSnapshot({}, f.options), { code: 'RULES_CONTEXT_TOO_LARGE' });
  assert.throws(() => buildRulesTurnSnapshot({}, { ...f.options, maxBytes: MAX_RULES_TURN_BYTES + 1 }), { code: 'RULES_CONTEXT_READER_INVALID' });
});

test('invalid or repeated scope keys never fall back to global-only rules', t => {
  const f = fixture(t, []);
  for (const identity of [null, [], { unexpected: true }, { sessionId: '' }, { threadId: '../node' },
    { treeAnchors: 'parent' }, { treeAnchors: [null] }, { treeAnchors: ['parent', 'parent'] }]) {
    assert.throws(() => buildRulesTurnSnapshot(identity, f.options), { code: 'RULES_CONTEXT_SCOPE_INVALID' });
  }
  const treeAnchors = Array.from({ length: 17 }, (_, i) => `node-${i}`);
  f.save([row('R1', 'The distant descendant keeps every supplied ancestor.', { scope: 'tree', scopeKey: 'node-16' })]);
  const snapshot = buildRulesTurnSnapshot({ treeAnchors }, f.options);
  assert.equal(snapshot.scopes.length, 18);
  assert.equal(snapshot.scopes[17].entries[0].id, 'R1', 'the complete snapshot adds no hidden ancestry-depth ceiling');
});
