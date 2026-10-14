'use strict';
// Bridges an OWNER-APPROVED purchase line into the capped spend ledger.
//
// SCOPE, STATED PLAINLY BECAUSE IT IS EASY TO OVERSTATE
//
// This module does NOT complete a purchase. There is no merchant checkout
// integration anywhere in this codebase -- src/lib/providers/stripe.js only
// creates cardholders and virtual cards, and nothing in this repository
// submits an order to Namecheap, Delaware, or any other merchant. Building a
// function here that claimed to "execute" a purchase without a real payment
// rail behind it would be exactly the defect family this project spends most
// of its effort hunting: a reported success with no corresponding real-world
// action.
//
// What this module actually does: once an owner has approved a purchase line
// through src/lib/mission-bridge/owner-prompts.js (which requires measured
// presentation evidence and treats an undecided line as denied), this records
// that approval against the capped daily spend ledger in src/lib/providers/pay.js
// and returns a durable receipt. That is the "may this be spent" gate --
// enforcing the owner's daily cap and creating an auditable record BEFORE any
// fulfillment attempt, so a runaway approval flow cannot spend past the cap
// even if something downstream tries.
//
// Actual fulfillment -- visiting a merchant checkout, submitting a filing --
// remains a separate, explicit, owner-present action. Two reasons it stays
// separate rather than being chained on automatically here:
//   1. It is the highest-stakes outward action this system can take. The
//      project's own standing orders require confirming before anything
//      outward-facing and hard to reverse; a purchase is both.
//   2. The browser automation gateway has an open, reproduced defect where it
//      drives a stale CDP target rather than the actually-active tab. Chaining
//      real purchase automation onto that gateway before it is fixed and
//      re-verified would be building on a foundation known to misbehave.

const pay = require('../providers/pay');
const ownerPrompts = require('./owner-prompts');
const ownerRequestLedger = require('../owner-request-store');

class PurchaseRecordingError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PurchaseRecordingError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) { throw new PurchaseRecordingError(code, message, details); }

// Only errors that establish a refusal before a ledger write may be converted
// into a per-item `recorded: false` result. In particular, recordSpend also
// writes an audit record after the durable spend row; an I/O failure there can
// throw after the row exists. Treating every thrown error as "not recorded"
// therefore gave the caller a definite negative answer that had not been
// established (and could invite an unsafe retry).
const DEFINITE_RECORDING_REFUSALS = new Set([
  'SPEND_LIMIT_EXCEEDED',
  'SPEND_REFERENCE_CONFLICT',
  'PURCHASE_LEDGER_KEY_MISSING',
  'PURCHASE_NOT_AUTHORIZED',
  'PURCHASE_SETTINGS_UNREADABLE',
  'PURCHASE_DECISION_MISSING',
  'PURCHASE_LINE_NOT_APPROVED',
  'PURCHASE_AMOUNT_MISMATCH',
  'PURCHASE_AUTHORIZATION_MALFORMED',
  'PURCHASE_LINE_ID_AMBIGUOUS'
]);

// Cents, not float USD, travel between this module and the caller wherever
// possible -- pay.recordSpend still wants amountUsd, so the conversion happens
// once, here, from the SAME integer cents the owner-prompts store already
// validated. Reconstructing a dollar amount from a float anywhere in this path
// is how a $79.99 line becomes $79.98999999999999.
function centsToUsd(cents) {
  return Math.round(cents) / 100;
}

// Record every APPROVED line of a settled purchase-batch decision against the
// capped ledger. Denied lines are never submitted to pay.recordSpend at all --
// not recorded as zero, not recorded as skipped, simply never presented to the
// spend layer, so a bug in this function cannot accidentally spend a denied
// line by falling through a default case.
//
// Idempotent by construction: pay.recordSpend dedupes on (provider, reference),
// and reference here is deterministic from (promptId, itemId), so calling this
// twice for the same settled decision returns the same receipts rather than
// double-spending against the cap.
function recordApprovedPurchase(promptId, dependencies = {}) {
  const promptStore = dependencies.ownerPrompts || ownerPrompts;
  const payApi = dependencies.pay || pay;
  const ledger = dependencies.ownerRequestLedger || ownerRequestLedger;
  const ledgerOptions = dependencies.ledgerOptions || {};
  const settled = promptStore.settledDecision(promptId, dependencies.ownerPromptDependencies || {});
  if (!settled) fail('PURCHASE_PROMPT_UNKNOWN', `No settled owner prompt has id "${promptId}".`, { promptId });
  if (settled.kind !== 'purchase_batch') {
    fail('PURCHASE_PROMPT_WRONG_KIND', `Prompt "${promptId}" is a "${settled.kind}" prompt, not a purchase batch.`, { promptId, kind: settled.kind });
  }
  if (!settled.decision || settled.decision.decision !== 'submit') {
    fail('PURCHASE_NOT_SUBMITTED', `Prompt "${promptId}" was not submitted with a purchase decision.`, { promptId });
  }

  const items = Array.isArray(settled.decision.items) ? settled.decision.items : [];
  const results = [];
  for (const item of items) {
    if (item.decision !== 'approve') {
      // Denied lines never touch the spend layer. Recorded here only as a
      // reporting fact for the caller, not as a ledger entry.
      results.push({ itemId: item.itemId, decision: 'deny', recorded: false });
      continue;
    }
    const reference = `${promptId}:${item.itemId}`;
    let outcome;
    try {
      outcome = payApi.recordSpend({
        amountUsd: centsToUsd(item.amountCents),
        purpose: item.description,
        provider: 'owner-prompt-purchase',
        reference,
        // The line the owner actually approved. This is the ONLY thing that
        // opens the spend gate in ../purchase-authority.js, and it is named
        // here rather than inferred from `reference` so that re-deriving the
        // authority from a formatted string can never become the contract.
        authorization: { promptId, itemId: item.itemId }
      }, dependencies.payDependencies || {});
    } catch (error) {
      // A known pre-write refusal is a real, expected outcome, not a defect in
      // this module -- surface it per-item rather than aborting the whole batch,
      // so an owner approving five lines under one over-cap line still sees the
      // four that succeeded. Unknown failures carry their uncertainty to the
      // caller: they may have happened after the durable row was written.
      if (!error || !DEFINITE_RECORDING_REFUSALS.has(error.code)) throw error;
      results.push({
        itemId: item.itemId, decision: 'approve', recorded: false,
        refusalCode: error.code,
        refusalReason: error.message ? error.message : String(error)
      });
      continue;
    }
    results.push({
      itemId: item.itemId, decision: 'approve', recorded: true,
      replayed: outcome.replayed === true,
      ledgerEntryId: outcome.entry ? outcome.entry.id : null,
      amountCents: item.amountCents,
      reference
    });
  }

  const recordedCents = results.filter(r => r.recorded).reduce((sum, r) => sum + (r.amountCents || 0), 0);
  const refusedCount = results.filter(r => r.decision === 'approve' && !r.recorded).length;

  // Mirror the owner's now-settled decision, and any resulting charge, onto
  // the SAME P record purchase.request filed for this promptId
  // (LEDGER-KINDS-INTERFACE-20260907.md, TOOLS ruling 05:12Z: "the settled
  // decision ... marks the record approved or declined; each recordSpend it
  // performs marks that line recorded"), so the shopping list, its decision
  // and its recorded charge read as ONE record. `actor: 'owner'` on the
  // decision is factual here -- unlike pay.record's direct/auto-approved
  // path, this function only runs after the owner's own settled decision
  // from mission-bridge/owner-prompts.js, so this mirrors a real owner
  // decision rather than attributing one to them. Best-effort and never
  // allowed to alter the results already computed above: the spend either
  // happened or did not, before this block ever runs, and a purchase with no
  // linked P record (filed some other way, or an unwritable ledger) simply
  // has nothing to mirror onto. Idempotent, like the function itself: a
  // record already decided or recorded is read, not re-decided.
  let ledgerMirror = { ok: false, code: 'PURCHASE_LEDGER_NOT_LINKED' };
  try {
    const ledgerId = ledger.findPurchaseByRequestId(promptId, ledgerOptions);
    if (ledgerId) {
      let status = ledger.findRecord(ledgerId, ledgerOptions).status;
      if (status === 'proposed') {
        const anyApproved = items.some(item => item.decision === 'approve');
        status = ledger.decidePurchase({
          id: ledgerId, decision: anyApproved ? 'approve' : 'decline', actor: 'owner',
          reason: `settled by the owner on prompt ${promptId}`
        }, ledgerOptions).status;
      }
      const recordedCount = results.filter(r => r.recorded).length;
      if (status === 'approved' && recordedCount > 0) {
        status = ledger.recordPurchase({
          id: ledgerId, actor: 'pay-provider',
          charge: { recordedCents, currency: settled.decision.currency, items: results }
        }, ledgerOptions).status;
      }
      ledgerMirror = { ok: true, id: ledgerId, status };
    }
  } catch (error) {
    ledgerMirror = { ok: false, code: error && error.code ? error.code : 'PURCHASE_LEDGER_MIRROR_FAILED' };
  }

  return Object.freeze({
    promptId,
    currency: settled.decision.currency,
    recordedCents,
    recordedCount: results.filter(r => r.recorded).length,
    deniedCount: results.filter(r => r.decision === 'deny').length,
    refusedCount,
    // Fulfillment is explicitly not attempted by this module. A caller must
    // not read "recorded" as "purchased" -- see the module header.
    fulfillmentAttempted: false,
    items: Object.freeze(results.map(item => Object.freeze(item))),
    ledgerMirror
  });
}

module.exports = Object.freeze({
  PurchaseRecordingError,
  recordApprovedPurchase
});
