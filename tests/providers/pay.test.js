/*
 * Mutation check: changed `return cents;` to `return cents + 1;` in src/lib/providers/pay.js.
 * The edit landed: yes (the mutated source line was found before the run).
 * This isolated test went red: yes (1235 did not equal the expected 1234).
 */
'use strict';

// Behaviour tests for the public pay provider. Dependencies are injected so
// the assertions exercise pay.js itself without writing to the real ledger or
// consulting the machine's live policy.
const assert = require('node:assert/strict');
const Module = require('node:module');

// pay.js supports dependency injection, but its default state-store dependency
// is loaded eagerly and requires node:sqlite (Node 22+). Substitute only that
// unused default while loading so this focused unit test also runs on older
// developer Nodes; every exercised call supplies its own state object.
const originalLoad = Module._load;
Module._load = function loadPayDependency(request, parent, isMain) {
  if (request === '../state-store' && parent && /[\\/]providers[\\/]pay\.js$/.test(parent.filename)) {
    return { getStateStore: () => { throw new Error('test must inject a state store'); } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { check, recordSpend, usdToCents } = require('../../src/lib/providers/pay.js');
Module._load = originalLoad;

let assertions = 0;
function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

equal(usdToCents(12.34, 'price'), 1234, 'USD is converted to integer cents');
equal(usdToCents(0, 'price'), 0, 'zero is a valid amount');
for (const invalid of ['', false, -1, Infinity, 1.001]) {
  assert.throws(() => usdToCents(invalid, 'price'), /price must be/, `invalid amount ${String(invalid)} must be refused`);
  assertions += 1;
}

{
  let received;
  const result = check(
    { amountUsd: 4.25, purpose: 'postage' },
    {
      loadPolicy: () => ({ limits: { defaultDailySpendUsd: 20 } }),
      state: { checkSpend: inputs => { received = inputs; return { allowed: true, remainingCents: 1575 }; } }
    }
  );
  equal(received, { amountCents: 425, dailyLimitCents: 2000, purpose: 'postage' },
    'check sends normalized amounts and purpose to the state store');
  equal(result, { allowed: true, remainingCents: 1575 }, 'check returns the state-store decision');
}

{
  const calls = [];
  const stateResult = { allowed: true, replayed: false, entry: { id: 7, amountCents: 250 } };
  const result = recordSpend(
    {
      amountUsd: 2.50,
      purpose: 'approved item',
      provider: 'caller-provider',
      reference: 'caller-reference',
      authorization: { promptId: 'prompt-1', itemId: 'item-2' }
    },
    {
      assertActive: action => calls.push(['active', action]),
      loadPolicy: () => ({ limits: { defaultDailySpendUsd: 10 } }),
      assertSpendAuthorized: request => {
        calls.push(['authorize', request]);
        return {
          autoApproved: false,
          spendProvider: 'owner-prompt',
          spendReference: 'prompt-1:item-2',
          code: 'OWNER_APPROVED',
          decidedAt: '2026-08-27T00:00:00.000Z',
          ownerRequestIds: ['request-9']
        };
      },
      state: { recordSpend: inputs => { calls.push(['spend', inputs]); return stateResult; } },
      record: (...args) => calls.push(['audit', ...args])
    }
  );

  equal(result, stateResult, 'recordSpend returns the state-store result');
  equal(calls[0], ['active', 'pay.record'], 'the active-policy gate runs first');
  equal(calls[1], ['authorize', {
    amountCents: 250, currency: 'USD', promptId: 'prompt-1', itemId: 'item-2'
  }], 'authorization receives the exact normalized line identity and amount');
  equal(calls[2], ['spend', {
    amountCents: 250,
    dailyLimitCents: 1000,
    purpose: 'approved item',
    provider: 'owner-prompt',
    reference: 'prompt-1:item-2'
  }], 'an owner-approved line uses the authority-issued ledger key, not caller coordinates');
  equal(calls[3], ['audit', 'pay.record', 'prompt-1:item-2', {
    id: 7,
    amountCents: 250,
    replayed: false,
    approvedBy: 'owner',
    approvalCode: 'OWNER_APPROVED',
    approvedAt: '2026-08-27T00:00:00.000Z',
    ownerRequestIds: ['request-9']
  }], 'the audit receipt describes the ledger row and owner approval');
}

{
  let spent = false;
  assert.throws(
    () => recordSpend(
      { amountUsd: 1, authorization: { promptId: 'p', itemId: 'i' } },
      {
        assertActive: () => {},
        loadPolicy: () => ({ limits: { defaultDailySpendUsd: 10 } }),
        assertSpendAuthorized: () => ({ autoApproved: false, code: 'OWNER_APPROVED' }),
        state: { recordSpend: () => { spent = true; } }
      }
    ),
    error => error && error.code === 'PURCHASE_LEDGER_KEY_MISSING',
    'approved lines without an authority-issued deduplication key are refused'
  );
  assertions += 1;
  equal(spent, false, 'a missing ledger key cannot reach the state store');
}

console.log(`pay provider: ${assertions} assertions passed`);
