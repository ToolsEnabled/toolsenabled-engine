'use strict';

require('./helpers/isolated-state-root'); // FINDING 1, REPORT-ledger-kinds-tools-20260907.md: redirect TOOLSENABLED_STATE_ROOT off the live root before anything below can resolve it.

// L3d -- a_ledger.answer, a_ledger.decline, p_ledger.decide ("asks and
// purchases: agent closable", the owner's ruling). Verified against the REAL
// store (Worker's L1h, engine 7fe768b2): answerAsk, declineAsk and
// decidePurchase drop their person-only gate and journal the real actor via
// normalizeFiledBy; removeAsk and removePurchase still call assertPerson.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const gate = require('../src/lib/minor-ledger-agent-gate');
const store = require('../src/lib/owner-request-store');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minor-ledger-gate-ap-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  return { dir, opts: { rootPath } };
}

function control(opts, extra = {}) {
  const audits = [];
  const made = new gate.MinorLedgerAgentControl({
    auditRequire: (action, target, details) => { audits.push({ action, target, details }); return { durable: true }; },
    store, ledgerOptions: opts, ...extra
  });
  return { control: made, audits };
}

test('a_ledger.answer closes a REAL open ask, journalling the calling agent as actor, not a fixed person', () => {
  const { opts } = sandbox();
  const { control: c, audits } = control(opts);
  const filed = store.fileAsk({ scope: 'global', words: 'may I restart the service?', filedBy: 'codex' }, opts);
  assert.equal(filed.status, 'open');
  const answered = c.answer({ actor: 'codex', id: filed.id, words: 'yes, go ahead' });
  assert.equal(answered.answered, true);
  assert.equal(answered.id, filed.id);
  assert.equal(answered.status, 'answered');
  const record = store.findRecord(filed.id, opts);
  assert.equal(record.answer.words, 'yes, go ahead');
  assert.equal(record.history[record.history.length - 1].actor, 'codex', 'the real caller, not a fixed owner word, is journalled');
  assert.equal(audits[0].action, 'a_ledger.answer');
  assert.equal(audits[0].details.actor, 'codex');
});

test('a_ledger.decline closes a REAL open ask without answering it, with a reason, actor journalled', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  const filed = store.fileAsk({ scope: 'global', words: 'may I delete the cache?', filedBy: 'codex' }, opts);
  const declined = c.decline({ actor: 'gemini', id: filed.id, reason: 'no longer needed' });
  assert.equal(declined.declined, true);
  assert.equal(declined.status, 'declined');
  const record = store.findRecord(filed.id, opts);
  assert.equal(record.decisions[record.decisions.length - 1].actor, 'gemini');
  assert.equal(record.decisions[record.decisions.length - 1].reason, 'no longer needed');
});

test('p_ledger.decide moves a REAL P record\'s ledger mirror -- approve/decline, actor journalled, and it never claims to spend', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  const filed = store.filePurchase({ scope: 'global', words: 'buy a domain', filedBy: 'agent', purchase: { requestId: 'prompt-1', lines: [] } }, opts);
  assert.equal(filed.status, 'proposed');
  const decided = c.decidePurchase({ actor: 'claude', id: filed.id, decision: 'approve', reason: 'within budget' });
  assert.equal(decided.decided, true);
  assert.equal(decided.status, 'approved');
  assert.match(decided.note, /ledger mirror only/);
  assert.match(decided.note, /never spends and never blocks a spend/);
  const record = store.findRecord(filed.id, opts);
  assert.equal(record.purchase.decision.actor, 'claude');
  assert.equal(record.purchase.decision.decision, 'approve');

  const filedDecline = store.filePurchase({ scope: 'global', words: 'buy another domain', filedBy: 'agent' }, opts);
  const declined = c.decidePurchase({ actor: 'gemini', id: filedDecline.id, decision: 'decline', reason: 'not needed' });
  assert.equal(declined.status, 'declined');
  assert.equal(store.findRecord(filedDecline.id, opts).purchase.decision.actor, 'gemini');
});

test('the id-kind check runs BEFORE the store: a T id handed to a_ledger.answer, an A id handed to p_ledger.decide, are refused WITHOUT the call ever reaching the store\'s write functions', () => {
  // The real store's answerAsk/decidePurchase ALSO call assertKindId internally
  // and would throw the identical R_LEDGER_ID_INVALID code on their own -- so
  // asserting the code alone cannot distinguish "the gate's pre-check caught
  // it" from "the store's own internal check caught it after being called".
  // Wrap the store's two write functions to prove which one actually ran.
  const { opts } = sandbox();
  let answerAskCalled = false;
  let decidePurchaseCalled = false;
  const watchedStore = {
    ...store,
    answerAsk(...args) { answerAskCalled = true; return store.answerAsk(...args); },
    decidePurchase(...args) { decidePurchaseCalled = true; return store.decidePurchase(...args); }
  };
  const { control: c } = control(opts, { store: watchedStore });
  assert.throws(() => c.answer({ actor: 'codex', id: 'T1', words: 'x' }), { code: 'R_LEDGER_ID_INVALID' });
  assert.equal(answerAskCalled, false, 'the pre-check must refuse a wrong-kind id before the store\'s answerAsk is ever called');
  assert.throws(() => c.decidePurchase({ actor: 'codex', id: 'A1', decision: 'approve', reason: 'x' }), { code: 'R_LEDGER_ID_INVALID' });
  assert.equal(decidePurchaseCalled, false, 'the pre-check must refuse a wrong-kind id before the store\'s decidePurchase is ever called');
  // Neither wrong-kind id reached the store: nothing was filed under any kind.
  assert.deepEqual(store.readAll({ kinds: ['T', 'A', 'P'], includeRemoved: true, includeProposed: true, ...opts }).records, []);
});

test('an unknown or wrong-status ask/purchase id is refused with the store\'s own typed code', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  assert.throws(() => c.answer({ actor: 'codex', id: 'A999', words: 'x' }), { code: 'R_LEDGER_ENTRY_UNKNOWN' });
  const filed = store.fileAsk({ scope: 'global', words: 'a question', filedBy: 'codex' }, opts);
  c.decline({ actor: 'codex', id: filed.id, reason: 'done with it' });
  assert.throws(() => c.answer({ actor: 'codex', id: filed.id, words: 'too late' }), { code: 'R_LEDGER_STATUS_INVALID' });
  assert.throws(() => c.decidePurchase({ actor: 'codex', id: 'P999', decision: 'approve', reason: 'x' }), { code: 'R_LEDGER_ENTRY_UNKNOWN' });
});

test('words/reason on the A/P tools pass the SAME secret-shape refusal as a_ledger.file\'s', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  const a1 = store.fileAsk({ scope: 'global', words: 'q1', filedBy: 'codex' }, opts);
  const a2 = store.fileAsk({ scope: 'global', words: 'q2', filedBy: 'codex' }, opts);
  const p1 = store.filePurchase({ scope: 'global', words: 'buy x', filedBy: 'agent' }, opts);
  assert.throws(() => c.answer({ actor: 'codex', id: a1.id, words: 'rotate token=abc123 now' }), { code: 'R_LEDGER_WORDS_REFUSED' });
  assert.throws(() => c.decline({ actor: 'codex', id: a2.id, reason: 'the api key is sk_live_abcdefghijklmnopqrstuvwxyz0123456789' }), { code: 'R_LEDGER_WORDS_REFUSED' });
  assert.throws(() => c.decidePurchase({ actor: 'codex', id: p1.id, decision: 'decline', reason: 'rotate token=abc123 now' }), { code: 'R_LEDGER_WORDS_REFUSED' });
});

test('a refusal to durably record audit intent files nothing, for every one of the three tools, and names why', () => {
  const { opts } = sandbox();
  const a1 = store.fileAsk({ scope: 'global', words: 'q', filedBy: 'codex' }, opts);
  const p1 = store.filePurchase({ scope: 'global', words: 'buy x', filedBy: 'agent' }, opts);
  const notDurable = new gate.MinorLedgerAgentControl({ auditRequire: () => ({ durable: false }), store, ledgerOptions: opts });
  assert.throws(() => notDurable.answer({ actor: 'codex', id: a1.id, words: 'x' }), { code: 'R_LEDGER_AUDIT_REQUIRED' });
  assert.throws(() => notDurable.decline({ actor: 'codex', id: a1.id, reason: 'x' }), { code: 'R_LEDGER_AUDIT_REQUIRED' });
  assert.throws(() => notDurable.decidePurchase({ actor: 'codex', id: p1.id, decision: 'approve', reason: 'x' }), { code: 'R_LEDGER_AUDIT_REQUIRED' });
  assert.equal(store.findRecord(a1.id, opts).status, 'open', 'the ask must still be open -- neither refused call wrote anything');
  assert.equal(store.findRecord(p1.id, opts).status, 'proposed', 'the purchase must still be proposed -- the refused call wrote nothing');
});

test('removeAsk-style operations are NOT exposed by this gate: a_ledger has no remove method, matching the owner\'s ruling that only asks/purchases are agent-CLOSABLE, not agent-removable', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  assert.equal(typeof c.removeAsk, 'undefined');
  assert.equal(typeof c.removePurchase, 'undefined');
  // And the store's own removeAsk/removePurchase still refuse a non-owner actor directly.
  const filed = store.fileAsk({ scope: 'global', words: 'q', filedBy: 'codex' }, opts);
  assert.throws(() => store.removeAsk({ id: filed.id, actor: 'codex' }, opts), { code: 'R_LEDGER_PERSON_REQUIRED' });
  const filedP = store.filePurchase({ scope: 'global', words: 'buy x', filedBy: 'agent' }, opts);
  assert.throws(() => store.removePurchase({ id: filedP.id, actor: 'codex' }, opts), { code: 'R_LEDGER_PERSON_REQUIRED' });
});

test('the tool registry defines a_ledger.answer, a_ledger.decline and p_ledger.decide beside t_ledger.*/a_ledger.file, actor-bound and surface-contained the same way', () => {
  const registry = require('../src/lib/tool-registry');
  const tools = registry.listTools();
  const names = new Set(tools.map(t => t.name));
  for (const name of ['a_ledger.answer', 'a_ledger.decline', 'p_ledger.decide']) {
    assert.ok(names.has(name), `tool-registry.js must define ${name}`);
  }

  const mcpServerSource = require('node:fs').readFileSync(require.resolve('../src/mcp-server.js'), 'utf8');
  const actorBoundMatch = mcpServerSource.match(/R_LEDGER_ACTOR_BOUND_TOOLS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(actorBoundMatch, 'mcp-server.js must still define R_LEDGER_ACTOR_BOUND_TOOLS as a Set literal');
  for (const name of ['a_ledger.answer', 'a_ledger.decline', 'p_ledger.decide']) {
    assert.ok(actorBoundMatch[1].includes(`'${name}'`), `${name} must be in R_LEDGER_ACTOR_BOUND_TOOLS`);
  }

  const surface = require('../src/lib/confined-tool-surface');
  for (const name of ['a_ledger.answer', 'a_ledger.decline', 'p_ledger.decide']) {
    assert.equal(surface.classify(name), 'contained', `${name} must classify 'contained' in confined-tool-surface.js, same reach as t_ledger.*`);
  }
});
