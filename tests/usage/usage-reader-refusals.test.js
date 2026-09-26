'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { UsageReader, UsageReaderError } = require('../../src/lib/usage/usage-reader');

const NOW = Date.parse('2026-08-27T12:00:00.000Z');

function account(overrides = {}) {
  return {
    accountId: 'account-main',
    provider: 'codex',
    lane: 'subscription-cli',
    adapterId: 'adapter-main',
    ...overrides
  };
}

function adapter(read) {
  return { id: 'adapter-main', read };
}

function refusal(code) {
  return error => error instanceof UsageReaderError && error.code === code;
}

async function withoutSideEffects(run) {
  const guarded = [
    [fs, 'writeFileSync'],
    [fs, 'appendFileSync'],
    [fs, 'createWriteStream'],
    [childProcess, 'spawn'],
    [childProcess, 'spawnSync'],
    [childProcess, 'execFile'],
    [childProcess, 'execFileSync']
  ];
  const originals = guarded.map(([owner, name]) => [owner, name, owner[name]]);
  const attempted = [];
  for (const [owner, name] of guarded) {
    owner[name] = (...args) => {
      attempted.push({ name, args });
      throw new Error(`unexpected side effect: ${name}`);
    };
  }
  try {
    await run();
    assert.deepEqual(attempted, [], 'a refusal must not write files or spawn processes');
  } finally {
    for (const [owner, name, original] of originals) owner[name] = original;
  }
}

async function main() {
  await withoutSideEffects(async () => {
    let reads = 0;
    const read = async () => { reads += 1; };

    assert.throws(() => new UsageReader(), refusal('USAGE_ACCOUNTS_INVALID'));
    assert.throws(
      () => new UsageReader({ accounts: [account(), account({ provider: 'claude' })], adapters: [adapter(read)] }),
      refusal('USAGE_ACCOUNTS_INVALID')
    );

    assert.throws(
      () => new UsageReader({ accounts: [account({ lane: '' })], adapters: [adapter(read)] }),
      refusal('USAGE_ACCOUNT_INVALID')
    );

    assert.throws(
      () => new UsageReader({ accounts: [account()], adapters: [{ id: 'adapter-main', read: 'not-a-function' }] }),
      refusal('USAGE_ADAPTER_INVALID')
    );

    assert.throws(
      () => new UsageReader({ accounts: [account()], adapters: [adapter(read)], freshnessBudgetMs: -1 }),
      refusal('USAGE_READER_INVALID')
    );

    const missingAccountReader = new UsageReader({
      accounts: [account()],
      adapters: [adapter(read)],
      clock: () => NOW
    });
    await assert.rejects(missingAccountReader.readAccount('account-other'), refusal('USAGE_ACCOUNT_NOT_FOUND'));

    const badClockReader = new UsageReader({
      accounts: [account()],
      adapters: [adapter(read)],
      clock: () => -1
    });
    await assert.rejects(badClockReader.readAccount('account-main'), refusal('USAGE_READER_CLOCK_INVALID'));

    assert.equal(reads, 0, 'configuration and lookup refusals must happen before an adapter is read');
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
