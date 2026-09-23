// MUTATION CHECK (2026-08-27): changed the churn total reducer from
// `sum + row.used` to `sum - row.used` in src/lib/usage/adapters/local-ledger.js.
// The mutation landed (confirmed by matching the changed source line).
// This file went red (exit 1); the module was then restored byte-for-byte.
// EXECUTABLE CHANGE
'use strict';

const assert = require('node:assert/strict');
const {
  createAuditedLocalLedgerAdapter,
  deriveFromAuditSnapshot,
  deriveFromChurnSnapshot,
  normalizeAuditSnapshot,
  normalizeChurnSnapshot,
  parseChurnText
} = require('../../src/lib/usage/adapters/local-ledger');

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const OBSERVED_AT = '2026-08-27T11:55:00.000Z';
const ACCOUNT = Object.freeze({
  accountId: 'account-main',
  provider: 'codex',
  lane: 'subscription-cli',
  derivationSource: 'agent-churn-ledger'
});

function churnEntry(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'audited-local-usage',
    callId: 'call-001',
    accountId: ACCOUNT.accountId,
    provider: ACCOUNT.provider,
    lane: ACCOUNT.lane,
    used: 17,
    unit: 'tokens',
    observedAt: '2026-08-27T11:50:00.000Z',
    ...overrides
  };
}

function churnSnapshot(entries, overrides = {}) {
  return {
    text: entries.map(entry => JSON.stringify(entry)).join('\n'),
    complete: true,
    observedAt: OBSERVED_AT,
    ...overrides
  };
}

async function main() {
  const entries = [churnEntry(), churnEntry({ callId: 'call-002', used: 25 })];
  const text = churnSnapshot(entries).text;

  assert.deepEqual(parseChurnText(text), entries);
  assert.equal(parseChurnText('{not-json'), null);
  assert.equal(parseChurnText(`${JSON.stringify(churnEntry())}\n${JSON.stringify(churnEntry({ extra: true }))}`), null,
    'churn rows reject fields outside the ledger schema');

  const normalizedChurn = normalizeChurnSnapshot(churnSnapshot(entries));
  assert.deepEqual(normalizedChurn.entries, entries);
  assert.equal(normalizedChurn.observedAt, OBSERVED_AT);
  assert.equal(normalizeChurnSnapshot(churnSnapshot(entries, { complete: false })), null);

  const normalizedAudit = normalizeAuditSnapshot({ events: [], complete: true, observedAt: OBSERVED_AT });
  assert.deepEqual(normalizedAudit, { events: [], observedAt: OBSERVED_AT });
  assert.equal(normalizeAuditSnapshot({ events: [], complete: false, observedAt: OBSERVED_AT }), null);

  const churnUsage = deriveFromChurnSnapshot(churnSnapshot(entries), ACCOUNT, NOW);
  assert.equal(churnUsage.provenance, 'DERIVED');
  assert.equal(churnUsage.scope, 'LOCAL_SYSTEM_ONLY');
  assert.equal(churnUsage.used, 42, 'distinct matching churn calls are summed');
  assert.equal(churnUsage.unit, 'tokens');
  assert.equal(churnUsage.observedAt, OBSERVED_AT);

  const duplicate = deriveFromChurnSnapshot(
    churnSnapshot([churnEntry(), churnEntry({ used: 99 })]), ACCOUNT, NOW);
  assert.equal(duplicate.provenance, 'UNKNOWN');
  assert.equal(duplicate.reason, 'CHURN_LEDGER_INVALID');
  assert.equal(duplicate.used, null, 'duplicate call IDs never produce a partial total');

  const emptyAudit = deriveFromAuditSnapshot(
    { events: [], complete: true, observedAt: OBSERVED_AT },
    { ...ACCOUNT, derivationSource: 'audit-ledger' }, NOW);
  assert.equal(emptyAudit.provenance, 'UNKNOWN');
  assert.equal(emptyAudit.reason, 'LOCAL_USAGE_NOT_REPORTED', 'an empty audit snapshot is not evidence of zero usage');

  let receivedAccount;
  const adapter = createAuditedLocalLedgerAdapter({
    id: 'fixture-ledger',
    async readChurnLedger(account) {
      receivedAccount = account;
      return churnSnapshot(entries);
    }
  });
  assert.equal(adapter.id, 'fixture-ledger');
  assert.ok(Object.isFrozen(adapter));
  const adapterUsage = await adapter.read(ACCOUNT, { nowMs: NOW });
  assert.equal(receivedAccount, ACCOUNT, 'the configured reader receives the requested account');
  assert.equal(adapterUsage.used, 42);

  const unavailable = await createAuditedLocalLedgerAdapter().read(ACCOUNT, { nowMs: NOW });
  assert.equal(unavailable.reason, 'CHURN_LEDGER_UNAVAILABLE');
  assert.throws(() => createAuditedLocalLedgerAdapter({ readChurnLedger: 'not-a-function' }), TypeError);
}

main().then(() => {
  process.stdout.write('local-ledger behavior tests passed\n');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
