'use strict';

// THE CODE A PERSON READS OFF ONE SCREEN AND TYPES INTO ANOTHER.
//
// Several enrollment surfaces once carried their own copy of this alphabet and
// shape. The shared implementation keeps each caller's error vocabulary while
// avoiding drift.
//
// WHY THIS ALPHABET. Thirty-one characters with every confusable pair removed
// -- no I, no L, no O, no 0, no 1. A code that fails because a person read a
// letter as a digit fails for a reason they cannot see and cannot fix, and they
// will blame the product rather than the glyph. The entropy cost is trivial
// (31^8 ~= 2^39.6 for a single-use secret that expires in ten minutes and burns
// an attempt on every miss); the usability gain is not.
//
// WHY THE PREFIX IS A PARAMETER. Different codes are redeemed at different
// places, and a code typed into the wrong box should say so rather than fail as
// "invalid". The prefix is what lets the wrong surface recognise a code that is
// well-formed but not for it.

const crypto = require('node:crypto');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_BODY_LENGTH = 8;
const CODE_BODY_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const PREFIX_RE = /^[A-Z]{2,4}$/;

/** Known prefixes, so a code offered to the wrong surface can be named. */
const CODE_PREFIXES = Object.freeze({
  // Two of this person's own computers pairing directly with each other.
  PEER: 'TE',
  // A computer asking to be added to an account, redeemed on the website.
  CLAIM: 'TC',
  // Historical removed-provider prefix, retained only to reject a migrated
  // wrong-kind code accurately. No live caller mints one.
  TELEGRAM: 'TB'
});

/**
 * Mint one code. `randomInt` is injectable so a test can pin the output;
 * it defaults to the CSPRNG and there is deliberately no seeded fallback.
 */
function generateShortCode({ prefix, randomInt = crypto.randomInt } = {}) {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) {
    throw new Error('generateShortCode requires an upper-case prefix of 2-4 letters.');
  }
  let body = '';
  for (let index = 0; index < CODE_BODY_LENGTH; index += 1) {
    const alphabetIndex = randomInt(CODE_ALPHABET.length);
    if (!Number.isInteger(alphabetIndex) || alphabetIndex < 0 || alphabetIndex >= CODE_ALPHABET.length) {
      throw new Error('generateShortCode randomInt returned an invalid alphabet index.');
    }
    body += CODE_ALPHABET[alphabetIndex];
  }
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4)}`;
}

/**
 * Accept what a person actually types -- any case, any or no separators -- and
 * refuse everything else rather than guessing.
 *
 * A code that "almost" parses must NOT be silently repaired into a different
 * valid code: it has to burn an attempt like any other wrong code, or the
 * attempt budget stops meaning anything.
 *
 * Returns a RESULT rather than throwing, because each caller owns its own error
 * grammar (`PEER_ENROLL_CODE_MALFORMED` and friends) and this module must not
 * flatten those into one shared code:
 *
 *   { ok: true,  body }                     the normalised 8-character body
 *   { ok: false, reason: 'absent' }         nothing was supplied
 *   { ok: false, reason: 'malformed' }      not a code at all
 *   { ok: false, reason: 'wrong-kind',
 *                offeredPrefix }            a real code, for somewhere else
 *
 * `wrong-kind` is the one worth handling separately: it is the person who typed
 * their machine-to-machine pairing code into the website's add-a-computer box,
 * and telling them that is much better than "invalid code".
 */
function normalizeShortCode(value, { prefix } = {}) {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) {
    throw new Error('normalizeShortCode requires an upper-case prefix of 2-4 letters.');
  }
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: 'absent' };

  const compact = value.trim().toUpperCase().replace(/[\s._-]/g, '');

  if (compact.startsWith(prefix)) {
    const body = compact.slice(prefix.length);
    return CODE_BODY_RE.test(body) ? { ok: true, body } : { ok: false, reason: 'malformed' };
  }

  /* A well-formed code carrying somebody else's prefix. Checked BEFORE the
     bare-body case below, so "TB-XXXX-XXXX" offered to the peer surface is
     reported as the wrong kind rather than as malformed. */
  for (const known of Object.values(CODE_PREFIXES)) {
    if (known === prefix || !compact.startsWith(known)) continue;
    if (CODE_BODY_RE.test(compact.slice(known.length))) {
      return { ok: false, reason: 'wrong-kind', offeredPrefix: known };
    }
  }

  /* A bare body with no prefix is accepted: people drop the "TE-" when reading
     a code aloud, and the prefix carries no entropy. */
  return CODE_BODY_RE.test(compact) ? { ok: true, body: compact } : { ok: false, reason: 'malformed' };
}

module.exports = Object.freeze({
  CODE_ALPHABET,
  CODE_BODY_LENGTH,
  CODE_BODY_RE,
  CODE_PREFIXES,
  generateShortCode,
  normalizeShortCode
});
