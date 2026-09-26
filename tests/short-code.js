'use strict';

// The code a person reads off one screen and types into another. This module
// was factored out of peer-enrollment.js and telegram-bridge.js, which each
// carried their own copy; these assertions are the ones both copies relied on
// plus the one genuinely new behaviour, `wrong-kind`.

const assert = require('node:assert/strict');
const {
  CODE_ALPHABET, CODE_BODY_LENGTH, CODE_PREFIXES, generateShortCode, normalizeShortCode
} = require('../src/lib/short-code');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }

// THE ALPHABET IS THE POINT. Every confusable pair is gone, so a code cannot
// fail for a reason the person reading it is unable to see.
{
  for (const confusable of ['I', 'L', 'O', '0', '1']) {
    ok(!CODE_ALPHABET.includes(confusable), `${confusable} is excluded because it is misread`);
  }
  equal(CODE_ALPHABET.length, 31, 'thirty-one characters survive that removal');
  equal(new Set(CODE_ALPHABET).size, 31, 'and none of them repeats');
  ok(/^[A-Z2-9]+$/.test(CODE_ALPHABET), 'upper case and digits only -- nothing needing a shift key twice');
}

// The shape both original copies produced, unchanged.
{
  const code = generateShortCode({ prefix: CODE_PREFIXES.PEER });
  ok(/^TE-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), `${code} is PREFIX-XXXX-XXXX`);
  equal(code.replace(/[^A-Z2-9]/g, '').length - 2, CODE_BODY_LENGTH, 'eight characters of body');

  const telegram = generateShortCode({ prefix: CODE_PREFIXES.TELEGRAM });
  ok(telegram.startsWith('TB-'), 'the telegram prefix still comes out of the same generator');
}

// randomInt is injectable so a test can pin output; there is deliberately no
// seeded fallback, so the default stays the CSPRNG.
{
  const code = generateShortCode({ prefix: 'TE', randomInt: () => 0 });
  equal(code, 'TE-AAAA-AAAA', 'a pinned source produces a pinned code');
}

{
  for (const bad of [undefined, '', 'te', 'TOOLONG', 'T3', 12]) {
    assertions += 1;
    assert.throws(() => generateShortCode({ prefix: bad }), /prefix/,
      `a prefix of ${JSON.stringify(bad)} is refused at the call, not encoded into a code`);
  }
}

/* WHAT A PERSON ACTUALLY TYPES. Case, spaces, dots, dashes and underscores are
   all forgiven, and the prefix may be dropped entirely -- people say "K7QP 4M2X"
   out loud. None of that costs entropy. */
{
  const forms = ['TE-K7QP-4M2X', 'te-k7qp-4m2x', 'TEK7QP4M2X', 'K7QP4M2X', 'k7qp 4m2x', ' TE.K7QP_4M2X '];
  for (const form of forms) {
    const result = normalizeShortCode(form, { prefix: 'TE' });
    ok(result.ok, `${JSON.stringify(form)} is accepted`);
    equal(result.body, 'K7QP4M2X', 'and normalises to the same body');
  }
}

/* AND WHAT MUST NOT BE REPAIRED. A code that "almost" parses has to burn an
   attempt like any other wrong code -- silently correcting it into a different
   valid code would make the attempt budget meaningless. */
{
  equal(normalizeShortCode(undefined, { prefix: 'TE' }).reason, 'absent', 'nothing supplied is its own answer');
  equal(normalizeShortCode('   ', { prefix: 'TE' }).reason, 'absent', 'and so is whitespace');
  for (const bad of ['K7QP4M2', 'K7QP4M2XX', 'K7QP4M2!', 'K7QPIM2X', 'K7QP0M2X', 'K7QP1M2X', 'K7QPLM2X']) {
    equal(normalizeShortCode(bad, { prefix: 'TE' }).reason, 'malformed', `${bad} is refused, never repaired`);
  }
  // The excluded characters are refused rather than folded onto their lookalikes:
  // accepting O as 0 would mean two different strings naming one code.
}

/* THE NEW BEHAVIOUR: a real code offered to the wrong surface is distinguishable
   from a typo. This is the person who typed their machine-to-machine pairing
   code into the website's add-a-computer box. It still burns an attempt; only
   the sentence they read differs, because "invalid" sends them hunting for a
   typo that is not there. */
{
  const claim = normalizeShortCode('TE-K7QP-4M2X', { prefix: CODE_PREFIXES.CLAIM });
  equal(claim.ok, false, 'a peer code is not accepted as a claim code');
  equal(claim.reason, 'wrong-kind', 'and it is recognised as a real code for elsewhere');
  equal(claim.offeredPrefix, 'TE', 'naming which surface it belongs to');

  const peer = normalizeShortCode('TC-K7QP-4M2X', { prefix: CODE_PREFIXES.PEER });
  equal(peer.reason, 'wrong-kind', 'and the reverse');
  equal(peer.offeredPrefix, 'TC', 'also named');

  // A well-formed body under an UNKNOWN prefix is just malformed -- we only
  // claim "wrong kind" about surfaces we actually have.
  equal(normalizeShortCode('ZZ-K7QP-4M2X', { prefix: 'TE' }).reason, 'malformed',
    'an unknown prefix is not dignified with a wrong-kind answer');
}

// The three prefixes are distinct, or the check above would be decorative.
{
  const values = Object.values(CODE_PREFIXES);
  equal(new Set(values).size, values.length, 'every surface has its own prefix');
}

// Same discipline as generate: a caller that forgets the prefix is a bug in the
// caller, not a code to be guessed at.
{
  for (const bad of [undefined, '', 'lower']) {
    assertions += 1;
    assert.throws(() => normalizeShortCode('TE-K7QP-4M2X', { prefix: bad }), /prefix/,
      'normalising without a real prefix is refused');
  }
}

console.log(`short-code: ${assertions} assertions passed`);
