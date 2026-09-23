'use strict';

// THE GATE BETWEEN AN AGENT AND THE OWNER'S MONEY.
//
// The requirement, paraphrased from the owner: the cart is the user's shopping
// cart, built by their AI, for anything the AI needs to buy that the user's
// settings do not auto-approve -- and the default settings auto-approve
// nothing. The request came with an instruction to verify the cart and the
// setting actually exist rather than assume they do.
//
// WHAT WAS VERIFIED BEFORE THIS FILE WAS WRITTEN, because the answer decided
// what it had to be:
//
//   The cart exists and is good.        purchase.request enqueues a batch,
//                                       owner-prompts.js requires measured
//                                       presentation evidence, decides per line,
//                                       denies by omission, and keeps the
//                                       settled record. None of that is new.
//
//   The setting exists and is correct.  outward.reserved_from_agents is a real
//                                       registry entry whose DEFAULT list
//                                       contains "Approving any purchase or
//                                       spending any money". So this owner's
//                                       settings do auto-approve nothing, by
//                                       default, exactly as he said.
//
//   NOTHING ON THE SPEND PATH READ IT.  That is the defect. Measured on this
//                                       checkout:
//
//     - pay.recordSpend() (src/lib/providers/pay.js) contained no reference to
//       an approval, a cart, a prompt, or the owner. Its only constraint was the
//       daily cap.
//     - `pay.record` is an MCP tool ADMITTED at the confined "Standard" tier
//       (src/lib/confined-tool-surface.js), and its effect is `local-write`.
//     - requiresApproval('pay.record', 'local-write', loadPolicy()) === false on
//       the shipped policy, because approvals only fire on `external-write` and
//       `pay.record` is not in approvals.actions.
//     - src/lib/owner-authorization.js, which holds the reservations, was read
//       only by agent-onboarding.js (to DISPLAY it) and by a comms cutover gate.
//
//   So the reservation was shown to agents and enforced against none of them.
//   An agent that never went near the cart could call pay.record and move the
//   owner's money to the daily cap. The protection was a label.
//
// THAT IS THE SHAPE THIS PROJECT KEEPS FINDING: a control that is declared,
// rendered, and inert. It is worse than no control, because the owner reads the
// setting and believes he is covered.
//
// ============================== THE RULE ==============================
//
//   A SPEND IS REFUSED UNLESS IT NAMES A CART LINE THE OWNER APPROVED,
//   AND THE AMOUNT MATCHES THAT LINE EXACTLY.
//
// Not "should be". Refused. There is no argument to this module that means
// "skip the check", no environment variable, and no caller identity that is
// trusted more than another -- a bypass that exists for a good caller is a
// bypass, and the point of a chokepoint is that it has no doors.
//
// ============================== FAIL CLOSED ==============================
//
// Unreadable settings, an unreadable prompt store, a missing decision, a
// malformed amount, a decision that was never settled: every one of these
// resolves to REFUSED. Absence is never consent. This is stated here because
// the inverse is precisely how the hole above came to exist -- nothing said
// yes, and the spend happened anyway.
//
// ============================== NOT A PAYMENT ==============================
//
// Passing this gate does not buy anything and this module cannot. It authorizes
// RECORDING an owner-approved amount against the capped ledger. No merchant is
// contacted, no card is read, and no card ever passes through here. Executing a
// purchase is a separate act nobody has authorized.

const {
  RESERVATION_PURCHASES,
  AUTO_APPROVE_SETTING_ID,
  REQUIRE_APPROVAL_SETTING_ID,
  purchaseApprovalReserved
} = require('./purchase-reservation-policy');

const REFUSAL = Object.freeze({
  NO_AUTHORIZATION: 'PURCHASE_NOT_AUTHORIZED',
  SETTINGS_UNREADABLE: 'PURCHASE_SETTINGS_UNREADABLE',
  DECISION_UNREADABLE: 'PURCHASE_DECISION_UNREADABLE',
  DECISION_MISSING: 'PURCHASE_DECISION_MISSING',
  DECISION_NOT_APPROVED: 'PURCHASE_LINE_NOT_APPROVED',
  AMOUNT_MISMATCH: 'PURCHASE_AMOUNT_MISMATCH',
  MALFORMED: 'PURCHASE_AUTHORIZATION_MALFORMED',
  LINE_ID_AMBIGUOUS: 'PURCHASE_LINE_ID_AMBIGUOUS'
});

// ============================== SPEND ONCE ==============================
//
// AN APPROVED LINE BUYS ONE THING, ONCE. That sentence was true of the system
// but was not written anywhere in it. Measured before this section existed:
// `authorizeSpend` checked that a line was approved and that the amount matched,
// and then said yes -- again, and again, for as many times as it was asked. The
// only thing standing between one approved line and unlimited spends against it
// was the LEDGER KEY, and the ledger key was a string literal in one caller:
//
//     const reference = `${promptId}:${item.itemId}`;   // purchase-recording.js
//
// `state-store.js recordSpend` dedupes on UNIQUE(provider, reference), so that
// literal is what made the one caller safe. Any other caller of
// `pay.recordSpend` -- a second bridge, a retry wrapper, a future surface, or
// the same caller with a receipt id substituted in as a "better" reference --
// passing the SAME authorization with a DIFFERENT reference spends the owner's
// approved line a second time, at full amount, and passes every check above.
// Proven in a harness: the same approved line spent twice under two references,
// both succeeded.
//
// So the ledger key is derived HERE, by the gate, and returned as part of the
// verdict. The caller no longer chooses it and cannot vary it; `pay.recordSpend`
// uses what the gate hands back. "Spend once" is now a property of the gate, and
// it is enforced by a UNIQUE constraint in the database rather than by a caller
// remembering a convention. A second spend against the same line collapses onto
// the same row and comes back `replayed: true` -- no second entry, no second
// dollar, and the legitimate retry that the old convention supported still works
// exactly as it did.
//
// THE FORMAT IS UNCHANGED ON PURPOSE. It is byte-identical to the literal above,
// so every spend already recorded under the old convention keeps deduping
// against the new derivation. Changing the shape here would have silently made
// every prior approved line spendable one more time -- the exact defect, dressed
// as a cleanup.
const APPROVED_SPEND_PROVIDER = 'owner-prompt-purchase';
const LEDGER_KEY_SEPARATOR = ':';

/**
 * The one ledger key an approved line may ever be spent under.
 *
 * WHY THE COLON IS REFUSED RATHER THAN ESCAPED. Both ids are validated by
 * `owner-prompts.js PROMPT_ID_RE`, which permits `:` -- so `a:b` + `c` and `a` +
 * `b:c` produce the SAME key, and two genuinely different approved lines would
 * collide. That collision is not dangerous in the spending direction (the second
 * line would replay the first and no extra money would move), but it means one
 * approved line silently never gets recorded, which is a false receipt. Refusing
 * the ambiguity keeps the key injective without changing the format for the ids
 * that actually occur -- both are UUIDs in every path that reaches here.
 */
function approvedLineLedgerKey(promptId, itemId) {
  if (promptId.includes(LEDGER_KEY_SEPARATOR) || itemId.includes(LEDGER_KEY_SEPARATOR)) return null;
  return `${promptId}${LEDGER_KEY_SEPARATOR}${itemId}`;
}

class PurchaseAuthorityError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PurchaseAuthorityError';
    this.code = code;
    if (details) this.details = details;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function refuse(code, explanation, details) {
  return Object.freeze({
    authorized: false,
    code,
    // Plain language, because this sentence reaches a person. It says what was
    // refused and what would change it, never an internal identifier.
    explanation,
    ...(details ? { details: Object.freeze(details) } : {})
  });
}

/**
 * Decide whether one spend may be recorded.
 *
 * ORDER IS THE SECURITY PROPERTY, and it is the same ordering mistake this
 * repository has made before: the owner's approval is checked FIRST and its
 * absence is terminal. The auto-approve setting can only ever widen a spend
 * that is otherwise refused -- it is consulted only when there is no approved
 * cart line -- so a bug in the settings reader can never invalidate an
 * approval the owner actually gave.
 *
 * @param {object} request {amountCents, currency, promptId, itemId}
 * @param {object} dependencies {settledDecision, loadSettings, ...}
 */
function authorizeSpend(request, dependencies = {}) {
  if (!isPlainObject(request)) {
    return refuse(REFUSAL.MALFORMED, 'This spend carried no description of what it was for, so it was refused.');
  }
  const { amountCents, currency, promptId, itemId } = request;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return refuse(REFUSAL.MALFORMED, 'This spend named no exact amount, so it was refused.');
  }

  // ---- 1. AN APPROVED CART LINE, OR NOTHING. ----------------------------
  // No promptId/itemId means the caller is not pointing at anything the owner
  // ever saw. That is the direct-spend case, and it is the one the whole file
  // exists to refuse.
  if (typeof promptId !== 'string' || promptId === '' || typeof itemId !== 'string' || itemId === '') {
    const reservation = purchaseApprovalReserved(dependencies);
    if (!reservation.readable) {
      return refuse(REFUSAL.SETTINGS_UNREADABLE, `${reservation.reason} Put it on your shopping list and approve it there.`);
    }
    if (reservation.reserved) {
      return refuse(
        REFUSAL.NO_AUTHORIZATION,
        'You keep purchase approval for yourself, and this spend does not point at anything on your shopping list that you approved. '
        + 'Nothing was spent. To buy this, an assistant has to put it on your shopping list and you have to approve that line.'
      );
    }
    // The owner has explicitly removed the purchase reservation. Even then the
    // spend is only allowed to proceed to the CAP -- which is a separate limit
    // enforced downstream and is not this module's to grant.
    return Object.freeze({
      authorized: true,
      code: 'PURCHASE_AUTO_APPROVED_BY_SETTING',
      explanation: 'You removed purchase approval from the list of things you keep for yourself, so assistants may spend within your daily limit without asking.',
      autoApproved: true,
      promptId: null,
      itemId: null
    });
  }

  // ---- 2. THE DECISION HAS TO EXIST, AND HAVE BEEN SETTLED. -------------
  let settled;
  try {
    const settledDecision = dependencies.settledDecision
      || require('./mission-bridge/owner-prompts').settledDecision;
    settled = settledDecision(promptId, dependencies.ownerPromptDependencies || {});
  } catch (error) {
    return refuse(
      REFUSAL.DECISION_UNREADABLE,
      `Your decision on this could not be read (${error && error.message ? error.message : String(error)}), so nothing was spent. This does not mean the decision is absent; the machine could not tell.`
    );
  }
  if (!settled || !isPlainObject(settled.decision)) {
    return refuse(REFUSAL.DECISION_MISSING, 'You have not decided on this yet, so nothing was spent. It is waiting on your shopping list.');
  }
  if (settled.kind !== 'purchase_batch' || settled.decision.decision !== 'submit') {
    return refuse(REFUSAL.DECISION_MISSING, 'This spend points at something that is not an approved shopping list line, so nothing was spent.');
  }

  // ---- 3. THE LINE HAS TO BE ONE HE APPROVED. ---------------------------
  const items = Array.isArray(settled.decision.items) ? settled.decision.items : [];
  const line = items.find(item => isPlainObject(item) && item.itemId === itemId);
  if (!line) {
    return refuse(REFUSAL.DECISION_MISSING, 'This spend points at a line that is not on the list you decided, so nothing was spent.');
  }
  if (line.decision !== 'approve') {
    // A refused line stays refused. It is not re-askable by spending against
    // it, which is the same property the cart surface keeps by showing a denied
    // line as denied rather than removing it.
    return refuse(REFUSAL.DECISION_NOT_APPROVED, 'You refused this line, so nothing was spent. A refused line stays refused.');
  }

  // ---- 4. THE AMOUNT HAS TO BE THE AMOUNT HE SAW. -----------------------
  // Approving $11.08 must not authorize $1,108. The comparison is on the exact
  // integer cents the owner was shown, never on a reconstructed float.
  if (!Number.isSafeInteger(line.amountCents) || line.amountCents !== amountCents) {
    return refuse(REFUSAL.AMOUNT_MISMATCH, 'The amount does not match the amount you approved, so nothing was spent.', {
      approvedCents: Number.isSafeInteger(line.amountCents) ? line.amountCents : null,
      attemptedCents: amountCents
    });
  }
  // Currency is part of the amount's namespace. If either side is absent or
  // malformed, equality cannot be established; skipping this comparison used
  // to turn that uncertainty into an authorization based on cents alone.
  if (typeof currency !== 'string' || currency === ''
      || typeof line.currency !== 'string' || line.currency === ''
      || line.currency !== currency) {
    return refuse(REFUSAL.AMOUNT_MISMATCH, 'The currency does not match the one you approved, so nothing was spent.');
  }

  // ---- 5. THE LINE IS SPENT ONCE, UNDER A KEY THE CALLER DOES NOT CHOOSE. --
  // See the SPEND ONCE note above. This is computed only after the line is known
  // to be approved and correctly priced, so a refusal never leaks a usable key.
  const spendReference = approvedLineLedgerKey(promptId, itemId);
  if (!spendReference) {
    return refuse(REFUSAL.LINE_ID_AMBIGUOUS,
      'This spend points at a shopping list line whose identifiers cannot be told apart from another line\'s, '
      + 'so nothing was spent. Nothing is wrong with your approval; the line has to be re-proposed with a plain id.');
  }

  return Object.freeze({
    authorized: true,
    code: 'PURCHASE_APPROVED_BY_OWNER',
    explanation: 'You approved this exact line, for this exact amount.',
    autoApproved: false,
    promptId,
    itemId,
    amountCents,
    // The ledger coordinates this spend MUST be recorded under. `pay.recordSpend`
    // uses these instead of anything the caller passed, which is what makes
    // "spend once" enforceable rather than conventional.
    spendProvider: APPROVED_SPEND_PROVIDER,
    spendReference,
    // Which of his own words this line came from, carried through so the audit
    // receipt for a spend can answer "which of my words bought this?". Null is
    // the honest answer for an agent-proposed line, and is what he saw stamped
    // on that line when he approved it.
    ownerRequestIds: Array.isArray(line.ownerRequestIds) ? Object.freeze([...line.ownerRequestIds]) : null,
    decidedAt: typeof settled.decision.decidedAt === 'string' ? settled.decision.decidedAt : null
  });
}

/**
 * The same decision, as a refusal that cannot be ignored.
 *
 * authorizeSpend returns a verdict a surface can render. This throws, because a
 * caller that forgets to check a returned boolean is the failure mode that puts
 * the gate back where it started. The spend path calls THIS one.
 */
function assertSpendAuthorized(request, dependencies = {}) {
  const verdict = authorizeSpend(request, dependencies);
  if (!verdict.authorized) {
    throw new PurchaseAuthorityError(verdict.code, verdict.explanation, verdict.details);
  }
  return verdict;
}

module.exports = Object.freeze({
  RESERVATION_PURCHASES,
  AUTO_APPROVE_SETTING_ID,
  REQUIRE_APPROVAL_SETTING_ID,
  APPROVED_SPEND_PROVIDER,
  REFUSAL,
  approvedLineLedgerKey,
  PurchaseAuthorityError,
  purchaseApprovalReserved,
  authorizeSpend,
  assertSpendAuthorized
});
