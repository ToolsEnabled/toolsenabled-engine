'use strict';
// THE ONE PROJECTION BOTH CART SURFACES READ.
//
// The owner asked for his purchase cart to exist in the desktop software AND on
// the website, and for the two not to drift. The way two lists drift is that
// each surface computes its own answer to the same question. So neither surface
// computes: this file answers, once, from the snapshot the engine already
// serves at GET /v1/owner-prompts, and both surfaces render what it returns.
//
// WHAT IT ADDS TO THE SNAPSHOT, AND WHY EACH ONE IS THE OWNER'S ASK
//
//   expiry        The live carts expire 2026-08-18 and NOTHING TELLS HIM. The
//                 wire prompt has carried `expiresAt` since the beginning; the
//                 renderer (app src/owner-popup.js) validates it and then never
//                 draws it. So the field exists, is correct, and is invisible.
//                 This file turns it into a countdown and a sentence.
//
//   doNothing     "what happens if he does nothing". Expiry is DENIAL -- see
//                 owner-prompts.js `live()`, which drops a record the moment
//                 Date.parse(expiresAt) <= now, and `settle()`, which files it
//                 with the default decision. Silence is not neutral here, and
//                 the surface has to say so before the date, not after it.
//
//   needsAnswer   "Play a loud sound on the speakers whenever you post a
//                 question you need me to respond to" (owner, 2026-08-12
//                 22:04Z). An alarm needs to know which of these rows is a
//                 question he can still answer -- a notice is not, and an
//                 expired row is not. That test is answered ONCE, here, so the
//                 desktop, the website and tools/purchase-cart.js cannot each
//                 arrive at a different idea of what is worth waking him for.
//                 `questionCount` on the summary is the count of them.
//
//   provenance    `ownerRequestIds` does NOT survive onto the wire. wireItem()
//                 folds it into a text stamp on `description` and drops the
//                 field. A surface that wants to sort, filter or badge by "is
//                 this actually mine" has only prose to go on, so this file
//                 parses the stamp back into a value -- and says `unknown` when
//                 the text is neither known stamp, rather than guessing.
//
// WHAT IT DELIBERATELY REFUSES TO ANSWER
//
//   recurringCost Five of the sixteen live lines recur (hosting, signing,
//                 certificate, the backups, and every domain renewal). The
//                 purchase-line schema has no field for that. The only statement
//                 of recurrence anywhere on the wire is English prose inside
//                 `purpose`, and the only machine copy is a hard-coded id set in
//                 tools/purchase-cart-r1234.js `totals()` -- which is exactly the
//                 second list that drifts. Parsing prose to produce a dollar
//                 figure would be inventing a number on the owner's money
//                 surface, which is the defect four earlier carts were rejected
//                 for. So every line reports recurrence: null with a stated
//                 reason, and the cart reports firstYearCents: null. Fixing this
//                 means adding a field to the line schema; that is a routing item
//                 in docs/design/PURCHASE-CART.md, not a guess made here.
//
// IT HAS NO REQUIRES. It reads no file, opens no socket, and cannot reach a
// payment module -- the same structural guarantee tests/launch-approvals-cart.js
// pins on the cart producers, for the same reason: this is the owner's money
// surface.

const OWNER_STAMP_RE = /^\[From your words: ([^\]]+)\] /;
const AGENT_STAMP = '[AGENT-PROPOSED - not traceable to your words] ';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Why a line cannot state its recurring cost. Held as one constant so both
// surfaces print the same sentence and a reviewer greps one place.
const RECURRENCE_UNAVAILABLE =
  'The purchase line has no recurrence field. Whether this repeats, and what it '
  + 'costs the second time, is written only in prose in "Purpose". No annual figure '
  + 'is shown rather than a guessed one.';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireSafeInteger(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${what} is malformed`);
  return value;
}

function parseInstant(value, what) {
  if (typeof value !== 'string') throw new Error(`${what} is malformed`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${what} is malformed`);
  return parsed;
}

/**
 * Split the wire description back into {provenance, text}.
 *
 * The stamp is prepended by owner-prompts.js wireItem() and is the ONLY carrier
 * of provenance left on the wire. A description that carries neither known stamp
 * is reported `unknown` -- not `agent`, because "we could not tell" and "we
 * checked and it is not his" are different claims and only one of them is true.
 */
function readProvenance(description) {
  if (typeof description !== 'string') throw new Error('purchase item description is malformed');
  if (description.startsWith(AGENT_STAMP)) {
    return Object.freeze({
      provenance: 'agent-proposed',
      ownerRequestIds: Object.freeze([]),
      label: 'Nobody asked for this. An agent proposed it.',
      text: description.slice(AGENT_STAMP.length)
    });
  }
  const owned = OWNER_STAMP_RE.exec(description);
  if (owned) {
    // The stamp truncates when it would not fit its reserve ("+2 more", or a
    // bare count). Ids are reported only when the stamp is a literal list; a
    // truncated stamp yields the label and an empty id list rather than a
    // half-list that reads as complete.
    const inner = owned[1];
    const literal = /^R\d{1,4}(?:\.\d{1,3})?(?:, R\d{1,4}(?:\.\d{1,3})?)*$/.test(inner);
    return Object.freeze({
      provenance: 'owner',
      ownerRequestIds: Object.freeze(literal ? inner.split(', ') : []),
      label: `From your words: ${inner}`,
      text: description.slice(owned[0].length)
    });
  }
  return Object.freeze({
    provenance: 'unknown',
    ownerRequestIds: Object.freeze([]),
    label: 'This line carries no provenance stamp, so where it came from is not recorded.',
    text: description
  });
}

/**
 * How long is left, and what the clock does when it runs out.
 *
 * `decidedBy` is the plain-language deadline both surfaces print. `outcome` is
 * the consequence of doing nothing, which differs by kind and must not be
 * softened: a purchase batch and a confirmation are DENIED at expiry, a notice
 * is acknowledged.
 */
function expiryOf(prompt, nowMs) {
  // Parsed ONCE and carried, rather than re-derived by each consumer. The app
  // tree's sibling copy (desktop-app src/purchase-cart-view.js) already
  // exposes `expiresAtMs`; this one did not, so the only ordering key it could
  // offer a caller was the raw ISO STRING. See `cartView` for what that cost.
  const expiresAtMs = parseInstant(prompt.expiresAt, 'prompt expiresAt');
  const remainingMs = expiresAtMs - nowMs;
  const expired = remainingMs <= 0;
  const outcome = prompt.kind === 'notice'
    ? 'If you do nothing, this is marked read on the date above. Nothing else changes.'
    : (prompt.kind === 'purchase_batch'
      ? 'If you do nothing, every line here is DENIED on the date above and the cart disappears. '
        + 'Nothing is bought either way -- but nothing stays waiting for you either.'
      : 'If you do nothing, this is DENIED on the date above and stops being offered.');
  return Object.freeze({
    expiresAt: prompt.expiresAt,
    expiresAtMs,
    expired,
    remainingMs: expired ? 0 : remainingMs,
    // Whole days remaining, rounded DOWN. A cart with 23 hours left says "today",
    // never "1 day": rounding a deadline up is how a deadline gets missed.
    remainingDays: expired ? 0 : Math.floor(remainingMs / MS_PER_DAY),
    outcome
  });
}

function humanDeadline(expiry) {
  if (expiry.expired) return 'This expired. It is no longer waiting for you.';
  if (expiry.remainingDays === 0) return 'Expires today.';
  if (expiry.remainingDays === 1) return 'Expires tomorrow.';
  return `Expires in ${expiry.remainingDays} days.`;
}

/**
 * Provenance from the STORED record's own field, for a reader that has the file.
 *
 * The store's rule is explicit (owner-prompts.js provenanceStamp): absent or
 * empty `ownerRequestIds` IS the agent-proposed case, not an unknown one. A
 * reader holding the record therefore knows something a reader holding the wire
 * does not, and must not throw that away by reporting `unknown`.
 */
function recordProvenance(item) {
  const ids = item.ownerRequestIds;
  if (Array.isArray(ids) && ids.length > 0) {
    const list = ids.map(String);
    return Object.freeze({
      provenance: 'owner',
      ownerRequestIds: Object.freeze(list),
      label: `From your words: ${list.join(', ')}`,
      text: String(item.description)
    });
  }
  return Object.freeze({
    provenance: 'agent-proposed',
    ownerRequestIds: Object.freeze([]),
    label: 'Nobody asked for this. An agent proposed it.',
    text: String(item.description)
  });
}

/**
 * @param {object} item
 * @param {'wire'|'record'} source  Where provenance is to be read from. 'wire'
 *        (the default, and what every surface consuming GET /v1/owner-prompts
 *        must use) parses the stamp, because the field is gone by then. 'record'
 *        is for a reader holding the store file, where the field still exists.
 *        Getting this backwards would put a false stamp on the owner's lines, so
 *        it is a declared argument and never a sniff.
 */
function viewItem(item, source = 'wire') {
  if (!isPlainObject(item)) throw new Error('purchase item is malformed');
  if (source !== 'wire' && source !== 'record') throw new Error('provenance source must be wire or record');
  const provenance = source === 'record' ? recordProvenance(item) : readProvenance(item.description);
  return Object.freeze({
    id: String(item.id),
    // Both are given. `description` is the wire string the engine stamped, kept
    // byte-identical so a surface that renders it raw is still correct; `text`
    // and `provenanceLabel` are for a surface that wants to badge them apart.
    description: item.description,
    text: provenance.text,
    provenance: provenance.provenance,
    provenanceLabel: provenance.label,
    ownerRequestIds: provenance.ownerRequestIds,
    amountCents: requireSafeInteger(item.amountCents, 'purchase item amountCents'),
    currency: String(item.currency),
    merchant: String(item.merchant),
    purpose: String(item.purpose),
    // Stated absence, not silence. See the header.
    recurrence: null,
    recurrenceUnavailableReason: RECURRENCE_UNAVAILABLE
  });
}

/**
 * Project one prompt into the shape both cart surfaces render.
 *
 * Non-purchase prompts are projected too, and on purpose: the live queue holds
 * six confirmations and a notice alongside the two carts, they expire on the
 * same clock, and a surface that showed the deadline on carts only would leave
 * the owner to discover the rest by their absence.
 */
function viewPrompt(prompt, nowMs, source = 'wire') {
  if (!isPlainObject(prompt)) throw new Error('owner prompt is malformed');
  const expiry = expiryOf(prompt, nowMs);
  const base = {
    id: String(prompt.id),
    kind: String(prompt.kind),
    title: String(prompt.title),
    message: String(prompt.message),
    createdAt: prompt.createdAt,
    state: String(prompt.state),
    defaultDecision: String(prompt.defaultDecision),
    expiresAt: expiry.expiresAt,
    expiresAtMs: expiry.expiresAtMs,
    expired: expiry.expired,
    remainingMs: expiry.remainingMs,
    remainingDays: expiry.remainingDays,
    deadline: humanDeadline(expiry),
    doNothing: expiry.outcome,
    // IS THIS ONE ACTUALLY WAITING ON HIM TO SAY SOMETHING.
    //
    // The owner asked for a loud sound "whenever you post a question you need
    // me to respond to", so a surface that raises an alarm has to know which
    // records are questions. Two things disqualify a record and both are
    // measured here rather than in the surface, because a second surface
    // computing its own rule is how the alarm ends up lying:
    //
    //   a NOTICE needs no answer -- expiry marks it read, and beeping at him
    //   for something that resolves itself teaches him to ignore the sound;
    //
    //   an EXPIRED record has already been answered, by silence, with a deny.
    //   Waking him for a decision he can no longer make is worse than silence.
    //
    // Note this reads the projection's own expiry, not `state`: this file is
    // also read by tools/purchase-cart.js, which holds the RAW store rather
    // than the store's `live()` filter, so an expired-but-still-pending record
    // does reach here.
    needsAnswer: prompt.kind !== 'notice' && !expiry.expired
  };
  if (prompt.kind !== 'purchase_batch') {
    return Object.freeze({ ...base, items: Object.freeze([]), totalCents: null, currency: null, firstYearCents: null });
  }
  if (!Array.isArray(prompt.items)) throw new Error('purchase batch has no items');
  const items = prompt.items.map(item => viewItem(item, source));
  const summed = items.reduce((sum, item) => sum + item.amountCents, 0);
  const totalCents = requireSafeInteger(prompt.totalCents, 'purchase batch totalCents');
  // The renderer already refuses a total that is not bound to its lines. This
  // repeats the check because THIS file is what a second surface will trust, and
  // a projection that silently re-totals would let a drifted cart look correct.
  if (summed !== totalCents) throw new Error('purchase total is not bound to its line items');
  return Object.freeze({
    ...base,
    items: Object.freeze(items),
    totalCents,
    currency: String(prompt.currency),
    // Null, always, until the line schema can state recurrence. See the header.
    firstYearCents: null,
    firstYearUnavailableReason: RECURRENCE_UNAVAILABLE,
    ownerLineCount: items.filter(item => item.provenance === 'owner').length,
    agentProposedLineCount: items.filter(item => item.provenance === 'agent-proposed').length,
    unknownProvenanceLineCount: items.filter(item => item.provenance === 'unknown').length
  });
}

/**
 * The whole cart surface, from the exact payload of GET /v1/owner-prompts.
 *
 * @param {object} snapshot  {ok, schemaVersion, generatedAt, theme, prompts}
 * @param {object} [options] {now, provenanceSource}. `now` is a ms epoch,
 *                           injected so a surface and its test agree on the
 *                           clock instead of racing it. `provenanceSource`
 *                           defaults to 'wire' -- the safe default, because a
 *                           wire consumer that wrongly claimed 'record' would
 *                           report every line as agent-proposed.
 */
function cartView(snapshot, options = {}) {
  if (!isPlainObject(snapshot) || snapshot.ok !== true || snapshot.schemaVersion !== 1
      || !Array.isArray(snapshot.prompts)) {
    throw new Error('owner prompt snapshot is malformed');
  }
  // An omitted clock means "measure now". A supplied clock that cannot be
  // measured is different: silently replacing it with the wall clock would
  // turn an invalid/unknown observation into definite expiry and question
  // counts. Refuse that input instead of confidently answering another time.
  const nowMs = options.now === undefined
    ? Date.now()
    : requireSafeInteger(options.now, 'cart view now');
  const source = options.provenanceSource === 'record' ? 'record' : 'wire';
  const prompts = snapshot.prompts.map(prompt => viewPrompt(prompt, nowMs, source));
  const carts = prompts.filter(prompt => prompt.kind === 'purchase_batch');

  // Only sum what is comparable. Mixed currencies get no invented rate; the
  // total goes null and the surface shows counts instead of a wrong number --
  // the same rule the app's approvals screen already applies to its tile.
  const currencies = new Set(carts.map(cart => cart.currency));
  const singleCurrency = currencies.size === 1 ? [...currencies][0] : null;

  // WHAT DIES FIRST -- ORDERED BY INSTANT, AND ONLY OVER WHAT IS STILL ALIVE.
  //
  // This used to compare `prompt.expiresAt < earliest.expiresAt`, i.e. two ISO
  // STRINGS, over EVERY record including dead ones. Both halves were wrong in
  // the same direction -- they can put the wrong line under the word SOONEST,
  // which is the one line on this surface whose whole job is to be right:
  //
  //   ORDER. Lexical order equals chronological order only while every value
  //   is UTC with identical fractional-second width. `...T00:00:00+00:00` and
  //   `...T00:00:00.000Z` are the same instant written three ways and sort in
  //   an order that has nothing to do with time. Nothing on the wire promises
  //   one spelling, and a deadline sorted by spelling is not sorted.
  //
  //   LIVENESS. An expired record was still eligible to win, so the headline
  //   could name a thing that already died and hide the next one that has not.
  //   Expired records reach this file (see `needsAnswer`), so this is the
  //   reader's own filter and not the store's.
  //
  // If everything on the queue has expired, this is null and the surface says
  // nothing is waiting rather than pointing at a corpse.
  const soonest = prompts.reduce((earliest, prompt) => {
    if (prompt.expired) return earliest;
    return earliest === null || prompt.expiresAtMs < earliest.expiresAtMs ? prompt : earliest;
  }, null);

  return Object.freeze({
    generatedAt: snapshot.generatedAt,
    nowMs,
    prompts: Object.freeze(prompts),
    carts: Object.freeze(carts),
    cartCount: carts.length,
    lineCount: carts.reduce((sum, cart) => sum + cart.items.length, 0),
    waitingCount: prompts.length,
    // The number an alarm may act on, and it is NOT `waitingCount`. That counts
    // rows; this counts questions he still has the power to answer. See
    // `needsAnswer`. `expiredCount` is beside it so a surface can name what it
    // dropped instead of quietly shrinking the total it prints.
    questionCount: prompts.filter(prompt => prompt.needsAnswer).length,
    expiredCount: prompts.filter(prompt => prompt.expired).length,
    currency: singleCurrency,
    approveEverythingCents: singleCurrency === null
      ? null
      : carts.reduce((sum, cart) => sum + cart.totalCents, 0),
    approveEverythingUnavailableReason: singleCurrency === null
      ? 'These carts are priced in more than one currency. No exchange rate is invented, so no single total is shown.'
      : null,
    firstYearCents: null,
    firstYearUnavailableReason: RECURRENCE_UNAVAILABLE,
    soonestExpiry: soonest === null ? null : Object.freeze({
      promptId: soonest.id,
      title: soonest.title,
      expiresAt: soonest.expiresAt,
      remainingDays: soonest.remainingDays,
      deadline: soonest.deadline,
      doNothing: soonest.doNothing
    }),
    // Restated at the top of both surfaces. Approving records a decision; the
    // buying is a separate act the owner takes himself. Nothing in this file, or
    // in either surface that renders it, can spend.
    spendNotice: 'Approving records your decision. It does not spend, does not enter a card, '
      + 'and does not contact a merchant.'
  });
}

module.exports = Object.freeze({
  cartView,
  viewPrompt,
  viewItem,
  readProvenance,
  recordProvenance,
  humanDeadline,
  RECURRENCE_UNAVAILABLE,
  AGENT_STAMP
});
