'use strict';
require('./helpers/isolated-state-root');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const ledger = require('../src/lib/owner-request-store');
const prompts = require('../src/lib/mission-bridge/owner-prompts');
const reset = require('../src/lib/ledger-category-reset');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-category-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, ledger: { rootPath: (...parts) => path.join(dir, 'ledger', ...parts), needsApproval: false },
    prompt: { stateFile: path.join(dir, 'prompts.json') } };
}
function purchase() {
  return { kind: 'purchase_batch', title: 'Fictional reset cart', message: 'review', ttlMs: null,
    items: [{ id: 'one', description: 'fixture item', amountCents: 100, currency: 'USD', merchant: 'fixture', purpose: 'fixture' }] };
}
function cart(f) {
  const prompt = prompts.enqueue(purchase(), f.prompt);
  const record = ledger.filePurchase({ scope: 'global', words: 'fixture purchase', filedBy: 'agent',
    purchase: { requestId: prompt.promptId, lines: [] } }, f.ledger);
  return { prompt, record };
}
function pendingIds(f) { return prompts.snapshot(f.prompt).prompts.map(row => row.id); }
function capture(f, preview) {
  return prompts.beginLedgerReset({ ...preview, batchId: crypto.randomUUID(),
    canonicalToken: ledger.previewResetKind({ kind: 'P', actor: 'owner' }, f.ledger).token,
    promptIds: pendingIds(f).sort() }, f.prompt);
}
const error = code => Object.assign(new Error('injected store failure'), { code });

for (const [kind, file, remove, stale] of [
  ['R', 'fileRequest', 'removeRequest', (id, opts) => ledger.editRequest({ id, words: 'stale edit', actor: 'owner' }, opts)],
  ['T', 'fileTask', 'removeTask', (id, opts) => ledger.completeTask({ id, actor: 'owner' }, opts)],
  ['A', 'fileAsk', 'removeAsk', (id, opts) => ledger.answerAsk({ id, answer: 'stale answer', actor: 'owner' }, opts)],
  ['P', 'filePurchase', 'removePurchase', (id, opts) => ledger.decidePurchase({ id, decision: 'approve', actor: 'owner' }, opts)],
]) test(`${kind}: reset spans every scope, preserves history and other kinds, and reserves retired IDs`, t => {
  const f = fixture(t);
  const selected = ['global', 'session', 'tree', 'thread'].map(scope => ledger[file]({
    scope, ...(scope === 'global' ? {} : { key: `${scope}-fixture` }), words: `${kind} ${scope}`, filedBy: 'owner',
  }, f.ledger));
  ledger[remove]({ id: selected[1].id, actor: 'owner' }, f.ledger);
  if (kind === 'R') ledger.decide({ id: selected[2].id, decision: 'decline', actor: 'owner' }, f.ledger);
  if (kind === 'T') ledger.completeTask({ id: selected[2].id, actor: 'owner' }, f.ledger);
  if (kind === 'A') ledger.answerAsk({ id: selected[2].id, answer: 'fixture answer', actor: 'owner' }, f.ledger);
  if (kind === 'P') ledger.decidePurchase({ id: selected[2].id, decision: 'decline', actor: 'owner' }, f.ledger);
  const before = JSON.parse(fs.readFileSync(ledger.ledgerFileFor(f.ledger), 'utf8'));
  const oldRemoved = before.requests.find(row => row.id === selected[1].id);
  const otherKind = kind === 'T' ? 'A' : 'T';
  const other = ledger[otherKind === 'T' ? 'fileTask' : 'fileAsk']({ scope: 'global', words: 'keep me' }, f.ledger);
  const otherBefore = ledger.findRecord(other.id, f.ledger);
  const preview = reset.preview({ kind, actor: 'owner' }, f);
  assert.equal(preview.count, 4);
  assert.throws(() => reset.confirm({ ...preview, actor: 'agent' }, f), { code: 'R_LEDGER_RESET_OWNER_REQUIRED' });
  const done = reset.confirm({ ...preview, actor: 'owner' }, f);
  assert.equal(done.ok, true); assert.equal(done.count, 4);
  assert.deepEqual(ledger.readAll({ kinds: [kind], includeRemoved: true, includeProposed: true, ...f.ledger }).records, []);
  for (const row of selected) {
    assert.throws(() => ledger.findRecord(row.id, f.ledger), { code: 'R_LEDGER_ENTRY_RESET' });
    assert.throws(() => stale(row.id, f.ledger), { code: 'R_LEDGER_ENTRY_RESET' });
  }
  assert.deepEqual(ledger.findRecord(other.id, f.ledger), otherBefore);
  const raw = JSON.parse(fs.readFileSync(ledger.ledgerFileFor(f.ledger), 'utf8'));
  const removed = raw.requests.find(row => row.id === oldRemoved.id);
  assert.equal(removed.removedAt, oldRemoved.removedAt); assert.equal(removed.removedBy, oldRemoved.removedBy);
  assert.deepEqual(removed.history.slice(0, oldRemoved.history.length), oldRemoved.history);
  assert.equal(ledger.verifyHistory(f.ledger).ok, true);
  assert.equal(ledger[file]({ scope: 'global', words: 'new record', filedBy: 'owner' }, f.ledger).id, `${kind}5`);
  if (kind !== 'P') assert.throws(() => reset.confirm({ ...preview, actor: 'owner' }, f), { code: 'R_LEDGER_RESET_STALE' });
});

test('P clears only purchase prompts, invokes no decision, and replay keeps later purchases', t => {
  const f = fixture(t), first = cart(f);
  const notice = prompts.enqueue({ kind: 'notice', title: 'keep', message: 'keep', ttlMs: null }, f.prompt);
  const preview = reset.preview({ kind: 'P', actor: 'owner' }, f);
  const done = reset.confirm({ ...preview, actor: 'owner' }, { ...f,
    prompts: { ...prompts, decide() { assert.fail('Reset must never approve or decide a purchase'); } } });
  assert.equal(done.ok, true); assert.equal(done.promptCount, 1);
  assert.deepEqual(pendingIds(f), [notice.promptId]);
  assert.equal(prompts.settledDecision(first.prompt.promptId, f.prompt).decision, null);
  const later = cart(f);
  assert.equal(reset.confirm({ ...preview, actor: 'owner' }, f).ok, true);
  assert.ok(pendingIds(f).includes(later.prompt.promptId));
  assert.equal(ledger.findRecord(later.record.id, f.ledger).status, 'proposed');
});

test('a prompt arriving after the validated snapshot is refused, never included in the reset', t => {
  const f = fixture(t); cart(f);
  const preview = reset.preview({ kind: 'P', actor: 'owner' }, f);
  let reads = 0, later;
  const wrapped = { ...prompts, snapshot(options) {
    reads += 1; const snapshot = prompts.snapshot(options);
    if (reads === 1) later = prompts.enqueue(purchase(), options);
    return snapshot;
  } };
  assert.throws(() => reset.confirm({ ...preview, actor: 'owner' }, { ...f, prompts: wrapped }), { code: 'OWNER_PROMPT_RESET_STALE' });
  assert.equal(reads, 1);
  assert.ok(pendingIds(f).includes(later.promptId));
  assert.equal(ledger.readAll({ kinds: ['P'], ...f.ledger }).records.length, 1);
});

test('prompt-only resets can repeat for a later prompt and an empty reset writes no journal', t => {
  const f = fixture(t); let previous;
  for (let i = 0; i < 2; i++) {
    prompts.enqueue(purchase(), f.prompt);
    const preview = reset.preview({ kind: 'P', actor: 'owner' }, f);
    assert.equal(preview.count, 0); assert.equal(preview.promptCount, 1);
    assert.notEqual(preview.token, previous); previous = preview.token;
    assert.equal(reset.confirm({ ...preview, actor: 'owner' }, f).ok, true);
    assert.deepEqual(pendingIds(f), []);
  }
  const empty = reset.preview({ kind: 'P', actor: 'owner' }, f);
  assert.throws(() => reset.confirm({ ...empty, actor: 'owner' }, f), { code: 'R_LEDGER_RESET_EMPTY' });
  assert.equal(prompts.pendingLedgerReset(f.prompt), null);
});

for (const phase of ['markLedgerResetCanonical', 'completeLedgerReset']) {
  test(`${phase} failure resumes after reopening with original count/revision and leaves later data`, t => {
    const f = fixture(t); cart(f);
    const preview = reset.preview({ kind: 'P', actor: 'owner' }, f);
    const failed = reset.confirm({ ...preview, actor: 'owner' }, { ...f,
      prompts: { ...prompts, [phase]() { throw error('EIO'); } } });
    assert.equal(failed.ok, false); assert.equal(failed.pending, true);
    assert.equal(failed.count, 1); assert.equal(failed.revision, preview.revision);
    assert.match(failed.reason, /unfinished/);
    const later = cart(f);
    const reopened = reset.preview({ kind: 'P', actor: 'owner' }, f);
    assert.equal(reopened.token, preview.token); assert.equal(reopened.revision, preview.revision);
    assert.equal(reopened.count, 1); assert.equal(reopened.promptCount, 1);
    assert.throws(() => reset.confirm({ ...reopened, revision: reopened.revision + 1, actor: 'owner' }, f), { code: 'R_LEDGER_RESET_STALE' });
    const done = reset.confirm({ ...reopened, actor: 'owner' }, f);
    assert.equal(done.ok, true); assert.equal(done.count, 1); assert.equal(done.revision, preview.revision + 1);
    assert.deepEqual(pendingIds(f), [later.prompt.promptId]);
    assert.equal(ledger.findRecord(later.record.id, f.ledger).status, 'proposed');
  });
}

test('crash after capture resumes its exact valid original challenge', t => {
  const f = fixture(t); cart(f);
  const preview = reset.preview({ kind: 'P', actor: 'owner' }, f);
  capture(f, preview);
  assert.throws(() => prompts.completeLedgerReset({ token: preview.token }, f.prompt), { code: 'OWNER_PROMPT_RESET_PENDING' });
  const reopened = reset.preview({ kind: 'P', actor: 'owner' }, f);
  assert.equal(reopened.revision, preview.revision); assert.equal(reopened.count, 1);
  assert.equal(reset.confirm({ ...reopened, actor: 'owner' }, f).ok, true);
});

test('canonical refusal plus abort I/O failure stays recoverable and eventually unblocks the original prompts', t => {
  const f = fixture(t), first = cart(f);
  const preview = reset.preview({ kind: 'P', actor: 'owner' }, f);
  const failed = reset.confirm({ ...preview, actor: 'owner' }, { ...f,
    store: { ...ledger, resetKind(input, options) {
      ledger.fileTask({ scope: 'global', words: 'concurrent unrelated write' }, options);
      return ledger.resetKind(input, options);
    } },
    prompts: { ...prompts, abortLedgerReset() { throw error('EIO'); } },
  });
  assert.equal(failed.pending, true);
  assert.throws(() => prompts.decide({ promptId: first.prompt.promptId, decision: 'submit', itemDecisions: [] }, f.prompt), { code: 'OWNER_PROMPT_RESET_PENDING' });
  const reopened = reset.preview({ kind: 'P', actor: 'owner' }, f);
  assert.equal(reopened.token, preview.token); assert.equal(reopened.revision, preview.revision);
  const aborted = reset.confirm({ ...reopened, actor: 'owner' }, f);
  assert.equal(aborted.pending, false); assert.equal(aborted.aborted, true);
  assert.equal(prompts.pendingLedgerReset(f.prompt), null);
  assert.throws(() => prompts.decide({ promptId: first.prompt.promptId, decision: 'submit', itemDecisions: [] }, f.prompt), { code: 'OWNER_PROMPT_NOT_PRESENTED' });
  assert.ok(ledger.findRecord(first.record.id, f.ledger));
  assert.equal(reset.confirm({ ...reset.preview({ kind: 'P', actor: 'owner' }, f), actor: 'owner' }, f).ok, true);
});

test('a malformed persisted reset journal is refused without overwriting it', t => {
  const f = fixture(t); cart(f);
  const state = JSON.parse(fs.readFileSync(f.prompt.stateFile, 'utf8'));
  state.ledgerResets = [{ token: 'broken', promptIds: null, phase: 'captured' }];
  const raw = JSON.stringify(state); fs.writeFileSync(f.prompt.stateFile, raw);
  assert.throws(() => reset.preview({ kind: 'P', actor: 'owner' }, f), { code: 'OWNER_PROMPT_STORE_CORRUPT' });
  assert.equal(fs.readFileSync(f.prompt.stateFile, 'utf8'), raw);
});

test('a completed reset fences a delayed mirror, while a new prompt can still be mirrored', t => {
  const f = fixture(t), first = prompts.enqueue(purchase(), f.prompt);
  reset.confirm({ ...reset.preview({ kind: 'P', actor: 'owner' }, f), actor: 'owner' }, f);
  assert.throws(() => prompts.withPurchaseLedgerMirror(first.promptId, () => assert.fail('reset prompt was mirrored'), f.prompt), { code: 'OWNER_PROMPT_RESET_PENDING' });
  const later = prompts.enqueue(purchase(), f.prompt);
  const record = prompts.withPurchaseLedgerMirror(later.promptId, () => ledger.filePurchase({ scope: 'global', words: 'later',
    purchase: { requestId: later.promptId, lines: [] } }, f.ledger), f.prompt);
  assert.equal(ledger.findPurchaseByRequestId(later.promptId, f.ledger), record.id);
});

test('a live mirror lock cannot be stolen by reset capture even when its file is old', t => {
  const f = fixture(t), first = prompts.enqueue(purchase(), f.prompt);
  const preview = reset.preview({ kind: 'P', actor: 'owner' }, f);
  const request = { ...preview, canonicalToken: ledger.previewResetKind({ kind: 'P', actor: 'owner' }, f.ledger).token,
    batchId: crypto.randomUUID(), promptIds: [first.promptId] };
  prompts.withPurchaseLedgerMirror(first.promptId, () => {
    const old = (Date.now() - 10000) / 1000; fs.utimesSync(`${f.prompt.stateFile}.lock`, old, old);
    const program = `const p=require(${JSON.stringify(require.resolve('../src/lib/mission-bridge/owner-prompts'))});
      try {p.beginLedgerReset(${JSON.stringify(request)},${JSON.stringify(f.prompt)});process.exitCode=2;}
      catch(e){process.stdout.write(e.code);process.exitCode=e.code==='OWNER_PROMPT_STORE_BUSY'?0:3;}`;
    const child = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 8000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.equal(child.stdout, 'OWNER_PROMPT_STORE_BUSY');
    ledger.filePurchase({ scope: 'global', words: 'mirror commits before capture', purchase: { requestId: first.promptId } }, f.ledger);
  }, f.prompt);
  assert.equal(prompts.pendingLedgerReset(f.prompt), null);
  assert.throws(() => reset.confirm({ ...preview, actor: 'owner' }, f), { code: 'R_LEDGER_RESET_STALE' });
  assert.ok(ledger.findPurchaseByRequestId(first.promptId, f.ledger));
});

test('a real journal rename failure after canonical reset recovers from the persisted capture', t => {
  const f = fixture(t); cart(f);
  const preview = reset.preview({ kind: 'P', actor: 'owner' }, f);
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (to === f.prompt.stateFile && JSON.parse(fs.readFileSync(from, 'utf8')).ledgerResets.some(row => row.phase === 'canonical')) {
      injected = true; throw error('EIO');
    }
    return rename(from, to);
  };
  let result;
  try { result = reset.confirm({ ...preview, actor: 'owner' }, f); }
  finally { fs.renameSync = rename; }
  assert.equal(injected, true); assert.equal(result.pending, true);
  assert.equal(prompts.ledgerReset(preview.token, f.prompt).phase, 'captured');
  assert.equal(ledger.readAll({ kinds: ['P'], ...f.ledger }).records.length, 0);
  assert.equal(reset.confirm({ ...reset.preview({ kind: 'P', actor: 'owner' }, f), actor: 'owner' }, f).ok, true);
  assert.deepEqual(pendingIds(f), []);
});

test('the real purchase.request dispatch links the returned prompt to its single P record', async () => {
  const registry = require('./helpers/dispatch');
  const request = purchase(); delete request.kind; delete request.ttlMs;
  const result = await registry.executeTool('purchase.request', request);
  assert.equal(typeof result.promptId, 'string');
  assert.equal(result.ledgerMirror.ok, true, JSON.stringify(result.ledgerMirror));
  const record = ledger.findRecord(result.ledgerMirror.id);
  assert.equal(record.purchase.requestId, result.promptId);
  const decision = await registry.executeTool('purchase.decision', { promptId: result.promptId });
  assert.equal(decision.ledgerRecord.id, record.id);
  const current = reset.preview({ kind: 'P', actor: 'owner' });
  assert.equal(reset.confirm({ ...current, actor: 'owner' }).ok, true);
  const after = await registry.executeTool('purchase.decision', { promptId: result.promptId });
  assert.equal(after.ledgerRecord, null);
  assert.equal(after.settled.decision, null);
});

test('another process cannot resume or abort an attempt whose coordinator still holds its lease', t => {
  const f = fixture(t); cart(f);
  const preview = reset.preview({ kind: 'P', actor: 'owner' }, f);
  prompts.exclusiveLedgerReset(() => {
    capture(f, preview);
    const program = `const reset=require(${JSON.stringify(require.resolve('../src/lib/ledger-category-reset'))});
      const path=require('node:path');const options={ledger:{rootPath:(...p)=>path.join(${JSON.stringify(f.dir)},'ledger',...p),needsApproval:false},prompt:${JSON.stringify(f.prompt)}};
      try{reset.confirm(${JSON.stringify({ ...preview, actor: 'owner' })},options);process.exitCode=2;}
      catch(e){process.stdout.write(e.code);process.exitCode=e.code==='OWNER_PROMPT_STORE_BUSY'?0:3;}`;
    const child = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 8000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.equal(child.stdout, 'OWNER_PROMPT_STORE_BUSY');
    assert.equal(prompts.ledgerReset(preview.token, f.prompt).phase, 'captured');
    assert.equal(ledger.readAll({ kinds: ['P'], ...f.ledger }).records.length, 1);
  }, f.prompt);
  assert.equal(reset.confirm({ ...preview, actor: 'owner' }, f).ok, true);
});
