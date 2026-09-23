'use strict';

const assert = require('node:assert/strict');
const statusInjection = require('../src/lib/status-injection');

const NOW = Date.parse('2026-08-27T12:00:00.000Z');

function setting(value, overrides = []) {
  return { values: {
    [statusInjection.GLOBAL_SETTING_ID]: value,
    [statusInjection.NODE_OVERRIDES_SETTING_ID]: overrides
  } };
}

async function assertCollectionRefused(settings, reason) {
  let sourceCalls = 0;
  const failIfCalled = () => { sourceCalls += 1; throw new Error('disabled collection touched a source'); };
  const snapshot = await statusInjection.collectStatusSnapshot({ settings }, {
    clock: () => NOW,
    readMachineLoad: failIfCalled,
    readMemory: failIfCalled,
    readStateHealth: failIfCalled,
    readAuditDurability: failIfCalled,
    readOwnerCapture: failIfCalled,
    readUsage: failIfCalled,
    readQuota: failIfCalled
  });
  assert.equal(snapshot.setting.reason, reason);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.observations, null);
  assert.equal(sourceCalls, 0, 'a refusal must happen before any source (and its side effects) runs');
  assert.equal(statusInjection.renderStatusBlock(snapshot), '');
}

async function main() {
  await assertCollectionRefused(setting('yes'), 'SETTING_INVALID');
  await assertCollectionRefused(setting(true, [{ kind: 'host', id: 'host-a', enabled: 'yes' }]),
    'NODE_OVERRIDES_INVALID');
  await assertCollectionRefused(setting(false), 'GLOBAL_DISABLED');

  let reads = 0;
  const enabled = await statusInjection.collectStatusSnapshot({ settings: setting(true) }, {
    clock: () => NOW,
    readMachineLoad: () => { reads += 1; return { status: 'MEASURED', utilizationPercent: 1 }; },
    readMemory: () => { reads += 1; return { status: 'bad' }; },
    readStateHealth: () => { reads += 1; return { ok: true }; },
    readAuditDurability: () => { reads += 1; return { state: 'ok' }; },
    readOwnerCapture: () => { reads += 1; return []; },
    readUsage: () => { reads += 1; return { coverage: {}, totals: {} }; },
    readQuota: () => { reads += 1; return {}; }
  });
  assert.equal(enabled.setting.reason, 'GLOBAL_ENABLED');
  assert.equal(enabled.enabled, true);
  assert.equal(reads, 7, 'global opt-in must collect each source exactly once');
  assert.equal(enabled.observations.memory.reason, 'MEMORY_UNAVAILABLE');
  assert.equal(enabled.observations.quota.reason, 'NO_QUOTA_MEASUREMENT');
  assert.equal(enabled.observations.quota.codex.reason, 'CODEX_QUOTA_UNAVAILABLE');
  assert.equal(enabled.observations.quota.claude.reason, 'CLAUDE_QUOTA_UNAVAILABLE');

  let canonicalReads = 0;
  const codex = await statusInjection.readDefaultCodexQuota({}, {
    accountRegistryPathImpl: () => '/not-read.json',
    readAccountUsageImpl: async options => {
      canonicalReads += 1;
      assert.deepEqual(options.providers, ['codex']);
      return { ok: true, accounts: [] };
    }
  });
  assert.deepEqual(codex, { status: 'UNKNOWN', reason: 'CODEX_QUOTA_UNAVAILABLE' });
  assert.equal(canonicalReads, 1);

  let cacheReads = 0;
  const claude = await statusInjection.readDefaultClaudeQuota({}, {
    accountRegistryPathImpl: () => '/not-read.json',
    readAccountUsageImpl: async options => {
      assert.deepEqual(options.providers, ['claude']);
      return { ok: false, code: 'ACCOUNT_REGISTRY_UNREADABLE', accounts: [] };
    },
    readClaudeCache: () => { cacheReads += 1; throw new Error('unbound cache must not be read'); }
  });
  assert.deepEqual(claude, { status: 'UNKNOWN', reason: 'CLAUDE_QUOTA_UNAVAILABLE' });
  assert.equal(cacheReads, 0);

  process.stdout.write('status-injection refusal tests passed\n');
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
