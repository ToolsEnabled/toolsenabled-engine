/*
 * Mutation check: changed `if (!FAILOVER_STATUSES.has(result.status))` to
 * `if (FAILOVER_STATUSES.has(result.status))` in src/lib/multi-account/switcher.js.
 * The edit landed (the module differed from its recorded SHA-256).
 * This test went red with exit code 1; the original module was then restored.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { STATUS } = require('../../src/lib/multi-account/health.js');
const { selectAccount } = require('../../src/lib/multi-account/switcher.js');

const accounts = [
  { name: 'primary', provider: 'codex', profileDir: '.codex-primary', priority: 1 },
  { name: 'reserve', provider: 'codex', profileDir: '.codex-reserve', priority: 2 }
];

function result(account, status, reason) {
  return {
    account: account.name,
    status,
    canServe: status === STATUS.HEALTHY,
    usedPercent: status === STATUS.EXHAUSTED ? 100 : 12,
    resetsAt: status === STATUS.EXHAUSTED ? '2026-08-28T00:00:00.000Z' : null,
    reason
  };
}

test('selectAccount fails over only on positive evidence that an account is unusable', async () => {
  const exhaustedCalls = [];
  const failover = await selectAccount({
    registry: { accounts },
    probe: async account => {
      exhaustedCalls.push(account.name);
      return account.name === 'primary'
        ? result(account, STATUS.EXHAUSTED, 'allowance spent')
        : result(account, STATUS.HEALTHY, 'allowance available');
    }
  });

  assert.deepEqual(exhaustedCalls, ['primary', 'reserve']);
  assert.equal(failover.ok, true);
  assert.equal(failover.account.name, 'reserve');
  assert.equal(failover.switched, true);
  assert.deepEqual(failover.attempts.map(attempt => ({
    account: attempt.account,
    status: attempt.status,
    usedPercent: attempt.usedPercent,
    resetsAt: attempt.resetsAt
  })), [
    { account: 'primary', status: STATUS.EXHAUSTED, usedPercent: 100, resetsAt: '2026-08-28T00:00:00.000Z' },
    { account: 'reserve', status: STATUS.HEALTHY, usedPercent: 12, resetsAt: null }
  ]);

  const transientCalls = [];
  const refusal = await selectAccount({
    registry: { accounts },
    probe: async account => {
      transientCalls.push(account.name);
      return account.name === 'primary'
        ? result(account, STATUS.TRANSIENT, 'provider timed out')
        : result(account, STATUS.HEALTHY, 'allowance available');
    }
  });

  assert.deepEqual(transientCalls, ['primary']);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, 'ACCOUNT_STATUS_UNKNOWN');
  assert.equal(refusal.switched, false);
  assert.equal(refusal.attempts.length, 1);
  assert.match(refusal.reason, /did not switch/);
});

test('explicit keep trying inspects later accounts but never uses unknown identity or allowance',async()=>{
  const calls=[];
  const selected=await selectAccount({registry:{accounts},keepTryingAccounts:true,probe:async account=>{
    calls.push(account.name);return result(account,account.name==='primary'?STATUS.TRANSIENT:STATUS.HEALTHY,'observed health');
  }});
  assert.deepEqual(calls,['primary','reserve']);assert.equal(selected.account.name,'reserve');
  assert.equal(selected.attempts[0].status,'transient');
  const unknown=await selectAccount({registry:{accounts},keepTryingAccounts:true,probe:async account=>result(account,STATUS.TRANSIENT,'unknown')});
  assert.equal(unknown.ok,false);assert.equal(unknown.code,'ACCOUNT_STATUS_UNKNOWN');assert.doesNotMatch(unknown.reason,/all .*exhausted/);
  const identityCalls=[];
  const mismatch=await selectAccount({registry:{accounts},keepTryingAccounts:true,probe:async account=>{
    identityCalls.push(account.name);return result(account,STATUS.ACCOUNT_MISMATCH,'wrong identity');
  }});
  assert.equal(mismatch.ok,false);assert.equal(mismatch.code,'ACCOUNT_MISMATCH');assert.deepEqual(identityCalls,['primary']);
});
test('Stop during a free account check fences the next candidate even with keep trying',async()=>{
  const controller=new AbortController(),calls=[];
  await assert.rejects(selectAccount({registry:{accounts},keepTryingAccounts:true,signal:controller.signal,probe:async account=>{
    calls.push(account.name);controller.abort(new Error('Stopped by owner'));return result(account,STATUS.TRANSIENT,'unknown');
  }}),/Stopped by owner/);
  assert.deepEqual(calls,['primary']);
});
