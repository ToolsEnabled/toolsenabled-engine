// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-purchase-recording-test-js):
// - VACUOUS-COLLECTION mutation: temporarily changed purchase-recording.js's
//   returned `items` to an empty frozen array. Before this change the replay
//   `every` assertion stayed green; the new cardinality assertion went RED:
//     AssertionError [ERR_ASSERTION]: every settled line must have a replay result
//     0 !== 3
// - RESTORE: purchase-recording.js was restored byte-for-byte. The focused run
//   was green again: `purchase-recording: 8 checks passed`.
// - NOT-FOUND exit-status/truthy-return-only evidence: this test spawns no
//   process and asserts no exit status.
// - NOT-FOUND swallowed failure: no optional chaining or catch in an individual
//   check suppresses the behavior that check is intended to detect. The check
//   harness collects failures and sets a failing process exit code.
// - NOT-FOUND mock-of-subject: fakePay is a dependency observer; the subject is
//   recordApprovedPurchase, and assertions also inspect its returned contract.
// - NOT-FOUND skip/platform guard: the file has no skip or precondition guard.
// - NOT-FOUND same-code expected value: expectations use literal fixture values,
//   explicit counts, and independently observed ledger effects.
// - Preconditions unmet: none.
'use strict';
// Proves the boundary purchase-recording.js exists to hold: approved lines
// reach the capped spend ledger, denied lines never do, and this module never
// claims to have completed a purchase.

require('./helpers/isolated-state-root'); // FINDING 1, REPORT-ledger-kinds-tools-20260907.md: redirect TOOLSENABLED_STATE_ROOT off the live root before anything below can resolve it.

const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const ownerPrompts = require('../src/lib/mission-bridge/owner-prompts.js');
const purchaseAuthority = require('../src/lib/purchase-authority.js');
const ownerRequestStore = require('../src/lib/owner-request-store.js');
const { recordApprovedPurchase, PurchaseRecordingError } = require('../src/lib/mission-bridge/purchase-recording.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`  FAIL ${name}: ${error.stack || error.message}`); }
}

function tempOwnerPromptDeps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-rec-prompts-'));
  return { stateFile: path.join(dir, 'prompts.json') };
}

// An in-memory fake of the two pay.js entry points this module calls, so the
// test never touches the real state-store DB or the real daily cap. It
// reproduces the one property that matters here: recordSpend enforces
// dailyLimitCents and dedupes by (provider, reference).
function fakePay({ dailyLimitCents = 1_000_000 } = {}) {
  const ledger = []; // { provider, reference, amountCents, purpose }
  return {
    recordSpend({ amountUsd, purpose, provider, reference }) {
      const amountCents = Math.round(amountUsd * 100);
      const existing = ledger.find(e => e.provider === provider && e.reference === reference);
      if (existing) {
        return { allowed: true, replayed: true, entry: { id: `replay-${reference}`, amountCents, purpose } };
      }
      const spentToday = ledger.reduce((sum, e) => sum + e.amountCents, 0);
      if (spentToday + amountCents > dailyLimitCents) {
        const error = new Error('The atomic daily spend limit would be exceeded.');
        error.code = 'SPEND_LIMIT_EXCEEDED';
        throw error;
      }
      const entry = { id: `spend-${ledger.length + 1}`, amountCents, purpose, provider, reference };
      ledger.push(entry);
      return { allowed: true, replayed: false, entry };
    },
    ledger
  };
}

const PURCHASE = () => ({
  kind: 'purchase_batch',
  title: 'Review this shopping list',
  message: 'Each line is decided independently.',
  ttlMs: null,
  items: [
    { id: 'dom-ai', description: 'toolsenabled.ai domain', amountCents: 7999, currency: 'USD', merchant: 'Namecheap', purpose: 'Primary domain' },
    { id: 'dom-io', description: 'toolsenabled.io domain', amountCents: 3499, currency: 'USD', merchant: 'Namecheap', purpose: 'Redirect domain' },
    { id: 'de-inc', description: 'Delaware incorporation filing', amountCents: 24400, currency: 'USD', merchant: 'Delaware DoC', purpose: 'Entity formation' }
  ]
});

function settleApproving(approveIds) {
  const promptDeps = tempOwnerPromptDeps();
  const { promptId } = ownerPrompts.enqueue(PURCHASE(), promptDeps);
  ownerPrompts.markPresented({ promptId, evidence: { mounted: true, visible: true, focused: true } }, promptDeps);
  ownerPrompts.decide({
    promptId, decision: 'submit',
    itemDecisions: approveIds.map(id => ({ itemId: id, decision: 'approve' }))
  }, promptDeps);
  return { promptId, promptDeps };
}

console.log('purchase recording');

check('only APPROVED lines reach the ledger; denied lines are never submitted to pay', () => {
  const { promptId, promptDeps } = settleApproving(['dom-ai']);
  const pay = fakePay();
  const result = recordApprovedPurchase(promptId, { ownerPromptDependencies: promptDeps, pay });
  assert.strictEqual(result.recordedCount, 1);
  assert.strictEqual(result.deniedCount, 2);
  assert.strictEqual(pay.ledger.length, 1, 'the ledger must contain exactly the one approved line');
  assert.strictEqual(pay.ledger[0].amountCents, 7999);
  const denied = result.items.filter(i => i.decision === 'deny');
  assert.strictEqual(denied.length, 2);
  assert.ok(denied.every(i => i.recorded === false), 'a denied line must never be marked recorded');
});

check('this module never claims fulfillment', () => {
  const { promptId, promptDeps } = settleApproving(['dom-ai']);
  const result = recordApprovedPurchase(promptId, { ownerPromptDependencies: promptDeps, pay: fakePay() });
  assert.strictEqual(result.fulfillmentAttempted, false,
    'recording an approval into the ledger must never be reported as having fulfilled the purchase');
});

check('calling twice for the same settled decision does not double-spend the cap', () => {
  const { promptId, promptDeps } = settleApproving(['dom-ai', 'dom-io']);
  const pay = fakePay();
  const first = recordApprovedPurchase(promptId, { ownerPromptDependencies: promptDeps, pay });
  const second = recordApprovedPurchase(promptId, { ownerPromptDependencies: promptDeps, pay });
  assert.strictEqual(pay.ledger.length, 2, 'the ledger must still hold exactly two entries after a second call');
  assert.strictEqual(first.recordedCents, second.recordedCents);
  assert.strictEqual(second.items.length, PURCHASE().items.length,
    'every settled line must have a replay result');
  assert.ok(second.items.every(i => i.decision === 'deny' || i.replayed === true),
    'the second call must observe the replay, not silently re-add cents');
});

check('a cap breach on one line is reported per-item; other approved lines still record', () => {
  // dom-ai (7999) + de-inc (24400) = 32399. Cap it between the two so the
  // second approved line in enqueue order is the one that breaches.
  const { promptId, promptDeps } = settleApproving(['dom-ai', 'de-inc']);
  const pay = fakePay({ dailyLimitCents: 8000 }); // allows dom-ai (7999), not de-inc (24400) on top
  const result = recordApprovedPurchase(promptId, { ownerPromptDependencies: promptDeps, pay });
  const domAi = result.items.find(i => i.itemId === 'dom-ai');
  const deInc = result.items.find(i => i.itemId === 'de-inc');
  assert.strictEqual(domAi.recorded, true, 'the line within the cap must still record');
  assert.strictEqual(deInc.recorded, false, 'the line that breaches the cap must be refused, not silently dropped');
  assert.strictEqual(deInc.refusalCode, 'SPEND_LIMIT_EXCEEDED');
  assert.strictEqual(result.refusedCount, 1);
  assert.strictEqual(pay.ledger.length, 1, 'only the line that actually recorded reaches the ledger');
});

check('an indeterminate recordSpend failure is carried to the caller, not reported as unrecorded', () => {
  const { promptId, promptDeps } = settleApproving(['dom-ai']);
  const indeterminate = new Error('audit write failed after the ledger write');
  assert.throws(
    () => recordApprovedPurchase(promptId, {
      ownerPromptDependencies: promptDeps,
      pay: { recordSpend() { throw indeterminate; } }
    }),
    error => error === indeterminate
  );
});

check('an unknown promptId is refused with a typed error, not a crash', () => {
  assert.throws(
    () => recordApprovedPurchase('never-enqueued', { ownerPromptDependencies: tempOwnerPromptDeps(), pay: fakePay() }),
    error => error instanceof PurchaseRecordingError && error.code === 'PURCHASE_PROMPT_UNKNOWN'
  );
});

check('a non-purchase prompt kind is refused rather than silently treated as zero items', () => {
  const promptDeps = tempOwnerPromptDeps();
  const { promptId } = ownerPrompts.enqueue({ kind: 'confirmation', title: 'x', message: 'y', ttlMs: null }, promptDeps);
  ownerPrompts.markPresented({ promptId, evidence: { mounted: true, visible: true, focused: true } }, promptDeps);
  ownerPrompts.decide({ promptId, decision: 'approve' }, promptDeps);
  assert.throws(
    () => recordApprovedPurchase(promptId, { ownerPromptDependencies: promptDeps, pay: fakePay() }),
    error => error instanceof PurchaseRecordingError && error.code === 'PURCHASE_PROMPT_WRONG_KIND'
  );
});

check('a still-pending (never decided) prompt is refused, not treated as approved-nothing', () => {
  const promptDeps = tempOwnerPromptDeps();
  const { promptId } = ownerPrompts.enqueue(PURCHASE(), promptDeps);
  ownerPrompts.markPresented({ promptId, evidence: { mounted: true, visible: true, focused: true } }, promptDeps);
  // Never call decide(). settledDecision() must return null (still pending),
  // and this module must refuse rather than proceed as if it had zero items.
  assert.throws(
    () => recordApprovedPurchase(promptId, { ownerPromptDependencies: promptDeps, pay: fakePay() }),
    error => error instanceof PurchaseRecordingError && error.code === 'PURCHASE_PROMPT_UNKNOWN'
  );
});

check('a settled purchase that was not submitted throws PURCHASE_NOT_SUBMITTED without touching pay', () => {
  let recordSpendCalls = 0;
  const promptStore = {
    settledDecision(promptId) {
      assert.strictEqual(promptId, 'declined-purchase');
      return { kind: 'purchase_batch', decision: { decision: 'deny', items: [] } };
    }
  };
  assert.throws(
    () => recordApprovedPurchase('declined-purchase', {
      ownerPrompts: promptStore,
      pay: { recordSpend() { recordSpendCalls += 1; } }
    }),
    error => error instanceof PurchaseRecordingError
      && error.code === 'PURCHASE_NOT_SUBMITTED'
      && error.details.promptId === 'declined-purchase'
  );
  assert.strictEqual(recordSpendCalls, 0, 'a non-submitted decision must not reach the spend dependency');
});

check('an ambiguous approved line is returned as refused without a ledger write', () => {
  const settled = {
    kind: 'purchase_batch',
    decision: {
      decision: 'submit', currency: 'USD',
      items: [{ itemId: 'line:ambiguous', decision: 'approve', amountCents: 7999, currency: 'USD', description: 'domain' }]
    }
  };
  const ledgerWrites = [];
  const pay = {
    recordSpend({ amountUsd, authorization }) {
      const approval = purchaseAuthority.assertSpendAuthorized({
        amountCents: Math.round(amountUsd * 100), currency: 'USD',
        promptId: authorization.promptId, itemId: authorization.itemId
      }, { settledDecision: () => settled });
      ledgerWrites.push(approval);
      return { replayed: false, entry: { id: 'should-not-exist' } };
    }
  };
  const result = recordApprovedPurchase('purchase-plain', {
    ownerPrompts: { settledDecision: () => settled }, pay
  });
  assert.deepStrictEqual(result.items, [{
    itemId: 'line:ambiguous', decision: 'approve', recorded: false,
    refusalCode: 'PURCHASE_LINE_ID_AMBIGUOUS',
    refusalReason: 'This spend points at a shopping list line whose identifiers cannot be told apart from another line\'s, so nothing was spent. Nothing is wrong with your approval; the line has to be re-proposed with a plain id.'
  }]);
  assert.strictEqual(result.recordedCount, 0);
  assert.strictEqual(result.refusedCount, 1);
  assert.strictEqual(result.recordedCents, 0);
  assert.strictEqual(ledgerWrites.length, 0, 'authorization refusal must happen before the simulated ledger write');
});

check('recordedCents sums only the recorded lines, not the full batch total', () => {
  const { promptId, promptDeps } = settleApproving(['dom-ai', 'dom-io']);
  const result = recordApprovedPurchase(promptId, { ownerPromptDependencies: promptDeps, pay: fakePay() });
  assert.strictEqual(result.recordedCents, 7999 + 3499);
});

// LEDGER-KINDS-INTERFACE-20260907.md, TOOLS ruling 05:12Z: the cart-linked
// path -- one shopping list, its settled decision and its recorded charge --
// must appear as ONE record (kind P) in the owner-request ledger, mirrored
// through recordApprovedPurchase, never a second record.
function tempLedgerOpts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-rec-ledger-'));
  return { rootPath: (...parts) => path.join(dir, ...parts) };
}

check('one shopping list, its settled decision and its recorded charge land on ONE P record', () => {
  const ledgerOptions = tempLedgerOpts();
  const promptDeps = tempOwnerPromptDeps();
  const { promptId } = ownerPrompts.enqueue(PURCHASE(), promptDeps);
  // The same order purchase.request's tool wiring uses: the prompt exists
  // before the P record that carries its id.
  const filed = ownerRequestStore.filePurchase({
    scope: 'global', words: 'Review this shopping list', filedBy: 'agent',
    purchase: { requestId: promptId, lines: PURCHASE().items }
  }, ledgerOptions);
  assert.strictEqual(filed.status, 'proposed');
  ownerPrompts.markPresented({ promptId, evidence: { mounted: true, visible: true, focused: true } }, promptDeps);
  ownerPrompts.decide({ promptId, decision: 'submit', itemDecisions: [{ itemId: 'dom-ai', decision: 'approve' }] }, promptDeps);
  const result = recordApprovedPurchase(promptId, {
    ownerPromptDependencies: promptDeps, pay: fakePay(), ownerRequestLedger: ownerRequestStore, ledgerOptions
  });
  assert.deepStrictEqual(result.ledgerMirror, { ok: true, id: filed.id, status: 'recorded' });
  const stored = ownerRequestStore.findRecord(filed.id, ledgerOptions);
  assert.strictEqual(stored.status, 'recorded');
  assert.strictEqual(stored.purchase.requestId, promptId, 'the P record carries the promptId as the link back to the owner prompt');
  assert.ok(stored.purchase.recordedCharge, 'the recorded charge lives on the same record, not a second one');
  assert.strictEqual(ownerRequestStore.readAll({ kinds: ['P'], includeProposed: true, ...ledgerOptions }).records.length, 1,
    'exactly one P record exists for this shopping list -- the decision and the charge were never a second file');
});

check('every line denied settles the SAME P record as declined, with no recorded charge', () => {
  const ledgerOptions = tempLedgerOpts();
  const promptDeps = tempOwnerPromptDeps();
  const { promptId } = ownerPrompts.enqueue(PURCHASE(), promptDeps);
  const filed = ownerRequestStore.filePurchase({
    scope: 'global', words: 'Review this shopping list', filedBy: 'agent',
    purchase: { requestId: promptId, lines: PURCHASE().items }
  }, ledgerOptions);
  ownerPrompts.markPresented({ promptId, evidence: { mounted: true, visible: true, focused: true } }, promptDeps);
  ownerPrompts.decide({ promptId, decision: 'submit', itemDecisions: [] }, promptDeps);
  const result = recordApprovedPurchase(promptId, {
    ownerPromptDependencies: promptDeps, pay: fakePay(), ownerRequestLedger: ownerRequestStore, ledgerOptions
  });
  assert.strictEqual(result.recordedCount, 0);
  assert.deepStrictEqual(result.ledgerMirror, { ok: true, id: filed.id, status: 'declined' });
  const stored = ownerRequestStore.findRecord(filed.id, ledgerOptions);
  assert.strictEqual(stored.status, 'declined');
  assert.strictEqual(stored.purchase.recordedCharge, null);
});

check('a purchase filed with no matching P record (or an unlinked ledger) never turns a real spend into a refusal', () => {
  // No filePurchase call at all for this promptId: the ledger mirror has
  // nothing to attach to. The spend itself must still complete.
  const { promptId, promptDeps } = settleApproving(['dom-ai']);
  const result = recordApprovedPurchase(promptId, { ownerPromptDependencies: promptDeps, pay: fakePay() });
  assert.strictEqual(result.recordedCount, 1, 'the real spend still happened');
  assert.deepStrictEqual(result.ledgerMirror, { ok: false, code: 'PURCHASE_LEDGER_NOT_LINKED' });
});

console.log('');
if (failures.length) {
  console.log(`purchase-recording: ${failures.length} FAILED, ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`purchase-recording: ${passed} checks passed`);
}
