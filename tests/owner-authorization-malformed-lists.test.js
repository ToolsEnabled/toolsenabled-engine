'use strict';

/* A GRANT WHOSE LIMITS ARE NOT LIMITS.
 *
 * src/lib/owner-authorization.js states its own rule three lines above the gate
 * this pins: never show a grant without its limits, "and that has to hold at the
 * surface that does the showing". Its header adds a second: a malformed record
 * yields NOT_AUTHORIZED with a stated reason, "never a thrown exception that
 * takes down the orientation surface that carries it, and never a silent true".
 *
 * MEASURED 2026-08-27, BOTH RULES BROKEN. Only `reserved` had its ELEMENTS
 * checked; the other three lists were validated as containers only. So:
 *
 *   doesNotGrant: [null]       rendered   "OWNER AUTHORIZATION ON FILE ..."
 *                              with the limitation line   "- null"
 *   doesNotGrant: ['']         rendered a silently empty limitation
 *   decisionProcedure: [null]  rendered as authorized
 *   inScope: [null]            THREW on item.statement -- the forbidden shape
 *
 * A grant that authorizes agents to act under the owner's name, whose stated
 * limits read "null", is the blank cheque this module exists to refuse, wearing
 * a limit. */

const assert = require('node:assert/strict');
const authorization = require('../src/lib/owner-authorization.js');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok ${name}`);
}

const VALID = Object.freeze({
  state: 'AUTHORIZED',
  authorized: true,
  authorizedOn: '2026-08-27',
  subject: 'agents',
  publisherIdentity: 'owner',
  inScope: [{ statement: 'act under his name' }],
  reserved: [{ statement: 'nothing irreversible without a same-moment yes' }],
  doesNotGrant: ['new spending'],
  decisionProcedure: ['ask first, in writing'],
  record: 'config/owner-authorization.json',
});

check('a limitation list that is not readable statements refuses instead of rendering', () => {
  for (const [what, patch] of [
    ['doesNotGrant [null]', { doesNotGrant: [null] }],
    ['doesNotGrant with an empty string', { doesNotGrant: [''] }],
    ['doesNotGrant with a number', { doesNotGrant: [42] }],
    ['decisionProcedure [null]', { decisionProcedure: [null] }],
    ['inScope [null]', { inScope: [null] }],
    ['inScope with no statement', { inScope: [{}] }],
  ]) {
    const projection = { ...VALID, ...patch };
    let headline;
    assert.doesNotThrow(() => { headline = authorization.authorizationHeadline(projection); },
      `${what} threw, and this file's header forbids exactly that: a malformed record must refuse, never take down the surface carrying it`);
    assert.match(headline, /REFUSED-MALFORMED-GRANT/,
      `${what} was shown as a grant; its limits are not statements a person can read`);
    assert.doesNotThrow(() => authorization.authorizationLines(projection), `${what} threw while rendering`);
    const rendered = authorization.authorizationLines(projection).join('\n');
    assert.equal(/^\s*-\s*(null|undefined|)$/m.test(rendered), false,
      `${what} rendered a limitation line that is not a limitation`);
  }
});

check('the valid record still renders as a grant, with its limits intact', () => {
  /* THE CONTROL. Without it, refusing every projection satisfies everything above
     while making the product unable to show an authorization at all -- which is
     the failure this module was written to prevent from the other direction. */
  const headline = authorization.authorizationHeadline(VALID);
  assert.match(headline, /ON FILE/, 'a well-formed authorization stopped rendering');
  const rendered = authorization.authorizationLines(VALID).join('\n');
  assert.ok(rendered.includes('new spending'), 'the limitation the record states was dropped from the render');
  assert.ok(rendered.includes('nothing irreversible'), 'the reservation was dropped from the render');
});

console.log(`owner-authorization malformed lists: ${checks} checks passed`);
