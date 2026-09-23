'use strict';
/* AN INTEGRATION NOBODY HAS SET UP IS NOT A BROKEN INSTALLATION.
 *
 * MEASURED 2026-09-03 on the owner's own machine: doctor() returned ok:false
 * with SIX required failures -- instagram, chrome-web-store, google-default,
 * github, stripe, paddle -- none of which this machine has ever used. `ok` had
 * therefore been false on every run since install, and `system.doctor` is the
 * tool agents are told answers "what is configured here": they read "REQUIRED
 * credential missing" and asked the owner for an Instagram token.
 *
 * `criticality: 'required'` comes from the source scan in requirements.js
 * validate(): a provider file calling getSecret() must declare its secrets. It
 * means "code exists that would use this", which is true of every integration
 * shipped in the binary -- never "this machine needs it".
 *
 * THE HALF THAT MATTERS MORE is what still fails. Half-entered, expired,
 * unreadable and conflicting credentials are the states that mean something
 * actually stopped working, and widening the exemption to cover them would
 * silence the only failures worth printing. Most of this file guards that.
 *
 *   node --test tests/secret-store/never-configured-is-not-broken.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { evaluateIntegration } = require('../../src/lib/secret-store/doctor');

function absent(name) {
  return { name, present: false, readable: false, managed: false, state: 'missing', warnings: [] };
}
function held(name, state = 'active') {
  return { name, present: true, readable: state === 'active', managed: true, state, warnings: [] };
}
function integration(criticality, alternatives, secrets) {
  return evaluateIntegration(
    { id: 'ig', label: 'Instagram', criticality, alternatives },
    new Map(secrets.map(item => [item.name, item])),
  );
}

const IG = [['ig_access_token', 'ig_user_id']];

test('a required integration with nothing present at all is "not-configured"', () => {
  const result = integration('required', IG, []);
  assert.equal(result.state, 'not-configured');
  assert.equal(result.ready, false, 'it is still not usable -- that is not the same as not broken');

  /* Nothing is hidden: the credentials it would need are still listed by name,
     so the answer to "how would I turn this on" is still in the report. */
  assert.deepEqual(result.requirements[0].names, ['ig_access_token', 'ig_user_id']);
  assert.deepEqual(result.error, { code: 'SECRET_NOT_CONFIGURED', names: ['ig_access_token', 'ig_user_id'] });
});

test('HALF-ENTERED is broken and still fails, because someone started and stopped', () => {
  const result = integration('required', IG, [held('ig_access_token')]);
  assert.equal(result.state, 'will-fail',
    'one of two present means a real, half-finished configuration on this machine');
  assert.deepEqual(result.error.names, ['ig_user_id']);
});

test('present but EXPIRED, UNREADABLE or CONFLICTING still fails', () => {
  for (const [state, code] of [
    ['expired', 'SECRET_EXPIRED'],
    ['unreadable', 'SECRET_UNREADABLE'],
    ['conflict', 'SECRET_METADATA_CONFLICT'],
  ]) {
    const result = integration('required', IG, [held('ig_access_token', state), held('ig_user_id', state)]);
    assert.equal(result.state, 'will-fail', state + ' is a credential that WAS working');
    assert.equal(result.error.code, code, state);
  }
});

test('a second alternative that is partly present keeps the whole integration failing', () => {
  /* The exemption reads EVERY alternative, not just the selected one. A machine
     holding half of the OAuth triple has begun configuring this integration
     even when the single-token path is the one being reported. */
  const result = integration('required', [['cws_access_token'], ['cws_refresh_token', 'cws_client_id']],
    [held('cws_client_id')]);
  assert.equal(result.state, 'will-fail');
});

test('a removed credential is not "present" -- deleting it returns to not-configured', () => {
  const result = integration('required', IG,
    [{ name: 'ig_access_token', present: false, readable: false, managed: true, state: 'removed', warnings: [] }]);
  assert.equal(result.state, 'not-configured');
});

test('conditional and self-managed are untouched', () => {
  assert.equal(integration('conditional', IG, []).state, 'conditional-unavailable');
  assert.equal(integration('self-managed', IG, []).state, 'self-managed-uninitialized');
});

test('a working integration is still ready, with and without warnings', () => {
  const ok = integration('required', IG, [held('ig_access_token'), held('ig_user_id')]);
  assert.equal(ok.state, 'ready');
  assert.equal(ok.ready, true);

  const warned = evaluateIntegration({ id: 'ig', label: 'Instagram', criticality: 'required', alternatives: IG },
    new Map([
      ['ig_access_token', { ...held('ig_access_token'), warnings: ['expires in 3 days'] }],
      ['ig_user_id', held('ig_user_id')],
    ]));
  assert.equal(warned.state, 'ready-with-warning');
});

test('evaluation does not mutate the inventory it was handed', () => {
  const secrets = [held('ig_access_token'), absent('ig_user_id')];
  const before = JSON.stringify(secrets);
  integration('required', IG, secrets);
  assert.equal(JSON.stringify(secrets), before);
});
