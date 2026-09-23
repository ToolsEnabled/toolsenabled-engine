const { assertActive, loadPolicy } = require('../policy');
const { record } = require('../audit');
const { getStateStore } = require('../state-store');
const { assertSpendAuthorized, PurchaseAuthorityError } = require('../purchase-authority');

function usdToCents(value, label) {
  // Do not let JavaScript's numeric coercion turn an unreadable/missing value
  // into a real amount. In particular, Number(''), Number(false), and
  // Number([]) are all zero; for a daily limit, zero means unlimited. Those
  // inputs therefore used to turn "the limit was not established" into a
  // definite (and least restrictive) limit.
  if (typeof value !== 'number') throw new Error(`${label} must be a non-negative number.`);
  const amount = value;
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${label} must be a non-negative number.`);
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || Math.abs((amount * 100) - cents) > 1e-8) {
    throw new Error(`${label} must be an exact USD amount with at most two decimal places.`);
  }
  return cents;
}

function spendInputs({ amountUsd, purpose = '' }, policy) {
  return {
    amountCents: usdToCents(amountUsd, 'amountUsd'),
    dailyLimitCents: usdToCents(policy.limits && policy.limits.defaultDailySpendUsd, 'defaultDailySpendUsd'),
    purpose
  };
}

function check({ amountUsd, purpose = '' }, dependencies = {}) {
  const policy = (dependencies.loadPolicy || loadPolicy)();
  const state = dependencies.state || getStateStore();
  return state.checkSpend(spendInputs({ amountUsd, purpose }, policy));
}

// THE OWNER'S APPROVAL IS CHECKED BEFORE THE CAP, NOT AFTER IT.
//
// The daily cap is a limit on how much may be spent. It was never a statement
// that the spend was WANTED, and until this gate existed it was the only thing
// standing between an agent and $100 of the owner's money -- see the measured
// finding in ../purchase-authority.js. The cap still applies; it is now the
// second question, not the first.
//
// `authorization` names the cart line the owner approved: {promptId, itemId}.
// Its ABSENCE is a refusal, not a default, so a caller that simply does not
// know about the gate cannot spend by omission.
function recordSpend({ amountUsd, purpose = '', provider = 'manual', reference = '', authorization = null }, dependencies = {}) {
  (dependencies.assertActive || assertActive)('pay.record');
  const policy = (dependencies.loadPolicy || loadPolicy)();
  const inputs = spendInputs({ amountUsd, purpose }, policy);

  // Throws PurchaseAuthorityError unless the owner approved this exact line for
  // this exact amount. Nothing below this line runs on a refusal.
  const approval = (dependencies.assertSpendAuthorized || assertSpendAuthorized)({
    amountCents: inputs.amountCents,
    currency: 'USD',
    promptId: authorization && authorization.promptId,
    itemId: authorization && authorization.itemId
  }, dependencies.purchaseAuthorityDependencies || {});

  // WHERE THIS SPEND IS RECORDED IS THE GATE'S DECISION, NOT THE CALLER'S.
  //
  // `state.recordSpend` dedupes on UNIQUE(provider, reference). That pair is
  // therefore the thing that decides whether an owner-approved line can be spent
  // twice -- and until now the caller chose it, so "spend once" depended on one
  // caller formatting a string a particular way. A different caller, or the same
  // caller passing a merchant receipt id as the reference, spent the same
  // approved line again at full amount and passed every check in the gate.
  //
  // For an owner-approved line the gate now returns the coordinates and they are
  // used verbatim: the same line always lands on the same row, so a second spend
  // replays instead of charging. The caller's `provider`/`reference` are ignored
  // in that case rather than merged -- a merge would be one more place the
  // caller could vary the key.
  //
  // The auto-approved path (the owner has removed the purchase reservation) has
  // no cart line to spend once, so it keeps the caller's own coordinates and its
  // only limit is the daily cap, exactly as before.
  // AND AN APPROVED LINE WITHOUT COORDINATES IS REFUSED, NOT DEFAULTED.
  // `state.recordSpend` treats an undefined provider as 'manual' and an
  // undefined reference as null -- and a null reference skips the dedupe
  // entirely, which would put the double-spend back exactly where it was, via an
  // absence. This is the same "absence read as consent" shape the gate itself
  // exists to refuse, so it refuses here too.
  if (!approval.autoApproved
    && (typeof approval.spendProvider !== 'string' || !approval.spendProvider
      || typeof approval.spendReference !== 'string' || !approval.spendReference)) {
    throw new PurchaseAuthorityError(
      'PURCHASE_LEDGER_KEY_MISSING',
      'This spend was approved but named no place to be recorded, so nothing was spent. '
      + 'Recording it without one would allow the same approved line to be spent again.'
    );
  }
  const ledgerProvider = approval.autoApproved ? provider : approval.spendProvider;
  const ledgerReference = approval.autoApproved ? reference : approval.spendReference;

  const state = dependencies.state || getStateStore();
  const result = state.recordSpend({
    ...inputs,
    provider: ledgerProvider,
    reference: ledgerReference
  });
  // The audit target names the row that was actually written, not the reference
  // the caller asked for -- for an owner-approved line those differ whenever the
  // caller passed something of its own, and an audit trail that names a key the
  // ledger does not hold cannot be reconciled against it.
  (dependencies.record || record)('pay.record', ledgerReference || ledgerProvider, {
    ...result.entry,
    replayed: result.replayed,
    // WHO APPROVED THIS, AND WHEN, travels into the audit receipt. A spend
    // record that cannot answer "who said yes" is not an audit trail, it is a
    // total. `approvedBy` is the owner for an approved cart line and the
    // setting itself when he has removed the reservation -- two different
    // facts, never collapsed into one.
    approvedBy: approval.autoApproved ? 'setting:outward.reserved_from_agents' : 'owner',
    approvalCode: approval.code,
    approvedAt: approval.decidedAt || null,
    ownerRequestIds: approval.ownerRequestIds || null
  });
  return result;
}

module.exports = { check, recordSpend, usdToCents };
