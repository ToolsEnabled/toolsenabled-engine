'use strict';
/* A CRYPTO SESSION THAT EXPIRES BETWEEN TWO CHECKS, AND WHAT request() SAYS ABOUT IT.
 *
 * MEASURED against tests/online-fra-renewal.test.js (2026-09-07): section 3d's
 * "failed account observation must end browser authority" assertion is flaky
 * -- reproduced twice, at both b7149aeb and d9b44f96, with `actual` sometimes
 * a translated OnlineFraWebClientError and sometimes a RAW OnlineFraSessionError.
 * That second shape traces to one exact, untranslated code path in
 * src/lib/online-fra-web-client.mjs's request():
 *
 *   if (!leg.sending || leg.sending.closed) fail('WEB_CLIENT_NO_SESSION', ...);
 *   ...
 *   sealOn(leg.sending, {...}).catch((error) => { pending.delete(id); clearTimeout(timer); reject(error); });
 *
 * `leg.sending.closed` reads false for a session that is PAST its own
 * expiresAtMs but has not yet been TOUCHED since (online-fra-e2e-session.js's
 * own #ensureOpen() sets closed=true only when something calls seal(), open()
 * or close() after the deadline). So a session that goes stale between that
 * guard and sealOn()'s `await session.seal(plaintext)` throws a raw
 * OnlineFraSessionError('ONLINE_FRA_SESSION_EXPIRED', ...) straight out of
 * online-fra-e2e-session.js, and sealOn() has no catch of its own, so
 * request()'s catch forwards it verbatim -- unlike abandonPendingOn(), the
 * ONE place that correctly reports a session ending as the client's own
 * OnlineFraWebClientError('WEB_CLIENT_SESSION_ENDED', ...).
 *
 * THIS TEST FORCES THAT EXACT STATE WITHOUT THE MULTI-ACTOR RACE. Killing the
 * machine leg (the fixture's new stopMachine()) leaves the browser's session
 * with nobody to answer a renewal offer -- renewal is documented elsewhere in
 * this repo to cost the offer, not the socket, so the original session simply
 * ages out untouched. The client's own periodic sweep (renewTimer, ticking
 * every renewRetryMs) is what proactively closes an aged-out session before
 * anything else touches it -- so it is pushed out past this test's own wait
 * (renewalOverrides.renewRetryMs) precisely so the "expired but not yet
 * closed" window this bug lives in does not close itself before the test's
 * own single, deliberate request() gets there first.
 *
 *   node --test tests/online-fra-web-client-seal-error-translation.test.js
 */
const assert = require('node:assert/strict');
const { createHarness, sleep } = require('./helpers/online-fra-browser-authority-fixture');

(async () => {
  const { OnlineFraWebClientError } = await import('../src/lib/online-fra-web-client.mjs');
  const harness = await createHarness({ renewalOverrides: { renewRetryMs: 10_000 } });
  const { W } = await harness.browser();
  harness.stopMachine();
  // leaseTtlMs is 2000ms (see online-fra-browser-authority-fixture.js); with
  // the machine gone, no renewal offer can be answered, and with the sweep
  // pushed to 10s the session is simply older than its own lease -- untouched
  // -- by the time request() next runs.
  await sleep(2400);

  await assert.rejects(
    W.request('GET', '/v1/status?after-machine-gone=1'),
    (error) => {
      assert.ok(error instanceof OnlineFraWebClientError,
        `expected the client's own translated OnlineFraWebClientError; got ${error && error.constructor && error.constructor.name}: ${error && error.message}`);
      assert.equal(error.code, 'WEB_CLIENT_SESSION_ENDED',
        `expected WEB_CLIENT_SESSION_ENDED (what abandonPendingOn produces for every other session-ending path); got ${error.code}`);
      return true;
    },
    'a session that expired untouched between the closed-guard and seal() must be reported as WEB_CLIENT_SESSION_ENDED, not the raw session-layer error');

  console.log('online-fra-web-client-seal-error-translation: 1 assertion group passed -- an expired-but-untouched session was reported through the client\'s own translated error, not the raw session-layer one');
  await harness.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
