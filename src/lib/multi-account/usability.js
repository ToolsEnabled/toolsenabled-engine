'use strict';
/* CAN THIS ACCOUNT SERVE A TURN RIGHT NOW? Asked once, here, so that the two
 * places that need the answer cannot drift apart.
 *
 * THE DEFECT THIS EXISTS FOR. Selection did not consider whether the thing it
 * was selecting could actually work. Measured on the running build's account
 * cache: all six Codex accounts exhausted while three Claude and several Gemini
 * were healthy, with Codex the default provider -- so a new agent landed on a
 * dead account and every turn failed until the owner switched by hand. The
 * picker arm is the same defect one step earlier: it offered a provider nobody
 * was signed into at all.
 *
 * WHY IT IS ONE MODULE AND NOT TWO CHECKS. "Prefer a healthy account" and
 * "prefer a usable provider" are the same question asked of different things.
 * Written twice they would drift, and the drift would be invisible: each side
 * would look correct on its own and the pair would disagree about an account
 * that is signed out but not spent.
 *
 * THE DISTINCTION THIS MODULE REFUSES TO COLLAPSE. Not-signed-in and exhausted
 * are both "cannot serve now" and they are NOT the same fact:
 *
 *   exhausted        -- mostly a FIVE-HOUR window, and it comes back on its own.
 *                       MEASURED on this machine's cache: two accounts sat at an
 *                       identical weekly 71% used with OPPOSITE statuses, hourly
 *                       55% against 2%. So the weekly figure cannot be the
 *                       operative gate, and an account that is spent now is very
 *                       often the best account an hour later.
 *   signed out /     -- permanently unavailable UNTIL A PERSON ACTS. No amount of
 *   not provisioned     waiting changes it.
 *
 * That is why nothing here is allowed to say "demote permanently". Every answer
 * below is computed from the CURRENT reading, so an account that has recovered
 * is reconsidered the next time anything asks. A rotation that permanently
 * demoted a spent account would strand the owner on their worst accounts within
 * a day -- which is the same "could not look" versus "not there" distinction the
 * rest of this codebase is built on, applied to allowances.
 *
 * NEVER THROWS, and an unrecognised status is UNKNOWN rather than unusable. A
 * status this module has not been taught is not evidence that an account is
 * dead, and refusing to select it on that basis would strand a person on the
 * strength of a spelling.
 */

/* THIS MODULE REQUIRES NOTHING, AND THAT IS LOAD-BEARING. The obvious spelling
 * is to import STATUS from ./health.js, and it does not work: health.js requires
 * registry.js, registry.js requires selection-modes.js, and selection-modes.js
 * is the caller that needs this. Importing health here closes that ring, and a
 * require cycle in CommonJS does not fail loudly -- selection-modes would just
 * receive a half-built registry module and the breakage would surface somewhere
 * unrelated. So the status names are written out below.
 *
 * THE DRIFT THAT BUYS IS REAL AND IS GUARDED, NOT HOPED FOR. These names must
 * stay equal to health.js's STATUS values, and
 * tests/multi-account/selection-modes.test.js -- which is reachable from
 * tests/suites/orphans-wired-0901.txt, so it actually runs -- fails if either
 * side gains or loses a name, or if a status arrives here that nobody decided
 * about. Without that, a status added to health.js would silently answer
 * `unknown` and an account would quietly stop being classified. The guard lives
 * in a suite rather than beside this file on purpose: a check that only exists
 * in whoever-wrote-it's working tree is a check nobody has. */
const STATUS = Object.freeze({
  HEALTHY: 'healthy',
  EXHAUSTED: 'exhausted',
  SIGNED_OUT: 'signed_out',
  ACCOUNT_MISMATCH: 'account_mismatch',
  TRANSIENT: 'transient',
  NOT_PROVISIONED: 'not_provisioned'
});

/* WHEN could this serve, rather than merely whether it can now. The names are
   about the person's experience of waiting, because that is what decides
   whether skipping it is polite or permanent. */
const AVAILABILITY = Object.freeze({
  NOW: 'now',
  WHEN_THE_WINDOW_RESETS: 'when_the_window_resets',
  WHEN_THE_PERSON_ACTS: 'when_the_person_acts',
  UNKNOWN: 'unknown'
});

/* Lower is preferred. UNKNOWN sits ABOVE both unusable tiers on purpose: a
   reading that failed is not a dead account, and a person whose only account
   had a probe blip must still get a turn. It sits below NOW because a known-good
   account is always the better answer when one exists. */
const TIER = Object.freeze({
  [AVAILABILITY.NOW]: 0,
  [AVAILABILITY.UNKNOWN]: 1,
  [AVAILABILITY.WHEN_THE_WINDOW_RESETS]: 2,
  [AVAILABILITY.WHEN_THE_PERSON_ACTS]: 3
});

const BY_STATUS = Object.freeze({
  [STATUS.HEALTHY]: AVAILABILITY.NOW,
  [STATUS.EXHAUSTED]: AVAILABILITY.WHEN_THE_WINDOW_RESETS,
  [STATUS.SIGNED_OUT]: AVAILABILITY.WHEN_THE_PERSON_ACTS,
  [STATUS.NOT_PROVISIONED]: AVAILABILITY.WHEN_THE_PERSON_ACTS,
  /* The wrong identity is a configuration fault the owner must SEE, so it is
     never quietly routed around -- health.js keeps it out of FAILOVER_STATUSES
     for that reason and this agrees with it. It still ranks last, because
     selecting it first would spend a turn to reach the same refusal. */
  [STATUS.ACCOUNT_MISMATCH]: AVAILABILITY.WHEN_THE_PERSON_ACTS,
  /* We do not know that this account is spent. Guessing that it is, and burning
     a second account on the guess, is the expensive mistake. */
  [STATUS.TRANSIENT]: AVAILABILITY.UNKNOWN
});

function availabilityOf(status) {
  const known = typeof status === 'string' ? BY_STATUS[status] : undefined;
  return known === undefined ? AVAILABILITY.UNKNOWN : known;
}

/**
 * Has this status been DECIDED about here, whatever the decision was?
 *
 * Distinct from `availabilityOf(status) === UNKNOWN`, and the difference is the
 * whole reason this exists. `transient` is classified UNKNOWN on purpose -- we
 * genuinely do not know whether that account is spent, and guessing is the
 * expensive mistake. A status nobody has taught this module ALSO answers
 * UNKNOWN, and that is a gap rather than a judgement. Reading the first as the
 * second is the could-not-look versus not-there confusion, so the drift guard
 * needs a way to tell them apart that the availability answer cannot give it.
 */
function isClassified(status) {
  return typeof status === 'string' && Object.prototype.hasOwnProperty.call(BY_STATUS, status);
}

/** Can a turn be served on this status right now, with nothing else changing? */
function canServeNow(status) {
  return availabilityOf(status) === AVAILABILITY.NOW;
}

/** Will this come back without the person doing anything? */
function recoversWithoutPerson(status) {
  return availabilityOf(status) === AVAILABILITY.WHEN_THE_WINDOW_RESETS;
}

/** Does this need the person before it can ever serve again? */
function needsPerson(status) {
  return availabilityOf(status) === AVAILABILITY.WHEN_THE_PERSON_ACTS;
}

/**
 * Preference order for selection. Lower is preferred; equal means "this module
 * has no opinion, keep whatever order you already had". It deliberately returns
 * a TIER rather than a full ordering, so a caller's own ranking survives inside
 * each tier and this never becomes a second, competing selection mode.
 */
function selectionTier(status) {
  return TIER[availabilityOf(status)];
}

/** Read the status off a health reading without assuming its shape. */
function statusOf(reading) {
  return reading && typeof reading === 'object' && typeof reading.status === 'string'
    ? reading.status
    : null;
}

module.exports = Object.freeze({
  AVAILABILITY,
  STATUS,
  TIER,
  availabilityOf,
  canServeNow,
  isClassified,
  needsPerson,
  recoversWithoutPerson,
  selectionTier,
  statusOf
});
