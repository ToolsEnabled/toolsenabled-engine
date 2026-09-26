'use strict';

const assert = require('node:assert/strict');
const pay = require('../../src/lib/providers/pay');

(async () => {
  {
    assert.equal(pay.usdToCents(12.34, 'amount'), 1234);
    assert.equal(pay.usdToCents(0.1, 'amount'), 10);
    assert.throws(() => pay.usdToCents(1.001, 'amount'), /two decimal places/);
    assert.throws(() => pay.usdToCents(-1, 'amount'), /non-negative/);

    let checked;
    const state = {
      checkSpend: input => {
        checked = input;
        return { date: '2026-07-21', currentSpendUsd: 1, requestedUsd: 2.5, limitUsd: 12.34, allowed: true, purpose: input.purpose };
      }
    };
    const result = pay.check({ amountUsd: 2.5, purpose: 'fixture' }, {
      state,
      loadPolicy: () => ({ limits: { defaultDailySpendUsd: 12.34 } })
    });
    assert.deepEqual(checked, { amountCents: 250, dailyLimitCents: 1234, purpose: 'fixture' });
    assert.equal(result.allowed, true);
  }

  {
    const events = [];
    const state = {
      recordSpend: input => {
        events.push(['state', input]);
        return {
          date: '2026-07-21', currentSpendUsd: 0, requestedUsd: 9.99, limitUsd: 10, allowed: true,
          replayed: false,
          entry: { id: 'spend-1', amountCents: 999, amountUsd: 9.99, purpose: input.purpose, provider: input.provider, reference: input.reference }
        };
      }
    };
    // The owner's purchase gate (src/lib/purchase-authority.js) now sits inside
    // recordSpend and refuses any spend that names no approved cart line. This
    // fixture exercises the plumbing, not the gate, so it injects a stub -- and
    // asserts the gate WAS consulted, and consulted BEFORE the ledger was
    // touched. That ordering is the security property: a spend must be
    // authorized before it is recorded, never audited into existence after.
    const result = pay.recordSpend({ amountUsd: 9.99, purpose: 'test', provider: 'fixture', reference: 'receipt-1' }, {
      state,
      assertActive: action => events.push(['active', action]),
      loadPolicy: () => ({ limits: { defaultDailySpendUsd: 10 } }),
      assertSpendAuthorized: request => {
        events.push(['gate', request]);
        // The gate also decides WHERE an owner-approved spend is recorded, and
        // recordSpend refuses an approval that names nowhere -- an undefined
        // reference would skip the ledger's dedupe and let one approved line be
        // spent twice. The stub therefore has to answer that too.
        return {
          authorized: true, code: 'TEST_STUB', autoApproved: false, decidedAt: null, ownerRequestIds: null,
          spendProvider: 'fixture', spendReference: 'receipt-1'
        };
      },
      record: (...args) => events.push(['audit', ...args])
    });
    assert.equal(result.entry.amountCents, 999);
    assert.deepEqual(events.map(event => event[0]), ['active', 'gate', 'state', 'audit']);
    // The gate is asked about the SAME integer cents the ledger is given, so a
    // spend cannot be approved for one amount and recorded for another.
    assert.equal(events[1][1].amountCents, 999);
    assert.equal(events[2][1].dailyLimitCents, 1000);
  }
  // THE TWO TELEGRAM POLL-LEASE CASES WERE REMOVED 2026-08-23. They drove
  // providers/messaging.telegramPoll() against a stubbed
  // acquire/commit/releaseTelegramPollLease trio to prove the lease was released
  // on a malformed update. All four -- the provider module and the three store
  // methods -- went with the connector, and MIGRATION_V23 dropped the tables
  // underneath them. The spend/pay cases above are untouched and are what this
  // suite still covers.

  console.log('Provider transactional-state tests passed.');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
