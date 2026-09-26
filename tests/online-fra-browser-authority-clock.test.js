'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, sleep } = require('./helpers/online-fra-browser-authority-fixture');

test('the actual thirty-second authority ceiling stops dispatch through an otherwise live relay', async () => {
  // Real wall/monotonic clocks, shipped sixty-second crypto lease and shipped
  // thirty-second authority maximum. The account clock is at the largest
  // accepted ahead skew, which exercises the full thirty-second grant.
  const h = await createHarness({ productionClocks: true, authorityMaxAgeMs: 30_000, authorityTimeoutMs: 5000, accountClockAheadMs: 5000 });
  try {
    const { W } = await h.browser(); assert.equal((await W.request('GET', '/v1/status')).status, 200);
    h.revoked = true;
    await sleep(30_025);
    await assert.rejects(W.request('GET', '/v1/status'), { code: 'TUNNEL_BROWSER_AUTHORITY_ENDED' });
    assert.equal(h.calls.length, 1); assert.equal(h.introductions, 2);
    assert.equal(h.shellEvents.some(event => event.kind === 'online_fra_shell_closed'), false,
      'the test must stop dispatch independently while the relay connection remains open');
  } finally { await h.close(); }
});
