'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { codexWindows, NO_WINDOWS } = require('../src/lib/multi-account/usage-windows');
const { classifyProbe, STATUS } = require('../src/lib/multi-account/health');
const { createCodexChatgptAdapter, CODEX_APP_SERVER_CLI_VERSION } = require('../src/lib/usage/adapters/codex-chatgpt');

// Synthetic, non-secret fixtures based on:
// - https://learn.chatgpt.com/docs/app-server, Rate limits (ChatGPT), read 2026-09-14:
//   windowDurationMins; rateLimits compatibility view; codex/codex_other map buckets.
// - tests/usage/codex-chatgpt.js: locally verified 0.146.0 bare single-window shape.
// - tests/multi-account-health.test.js: legacy windowMinutes shape.
// These reproduce parser omissions; they are not captures of the owner's accounts.
const NOW = Date.parse('2026-09-14T12:00:00Z');
const RESET = NOW / 1000 + 2 * 60 * 60;
const ACCOUNT = { name: 'fixture', provider: 'codex', home: '.codex-fixture', expectEmail: null, priority: 1 };
const USAGE_ACCOUNT = { accountId: 'fixture', provider: 'openai', lane: 'subscription' };
const window = (minutes, usedPercent = 25) => ({ usedPercent, windowDurationMins: minutes, resetsAt: RESET });
function bucket(overrides = {}) {
  return {
    limitId: 'codex', limitName: null, primary: window(10080, 37), secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' }, individualLimit: null,
    spendControlReached: false, planType: 'plus', rateLimitReachedType: null, ...overrides
  };
}
function classify(result) {
  return classifyProbe({ account: ACCOUNT, accountRead: { account: { email: 'fixture@example.test', planType: 'plus' } },
    rateLimitsResult: result, exhaustedAtPercent: 99 });
}
async function readUsage(result) {
  const replies = [{ initialized: true }, result];
  return createCodexChatgptAdapter({ transport: {
    cliVersion: CODEX_APP_SERVER_CLI_VERSION, request: async () => replies.shift()
  } }).read(USAGE_ACCOUNT, { nowMs: NOW });
}

test('documented duration identifies a weekly primary even close to reset', () => {
  const windows = codexWindows(bucket(), { now: NOW });
  assert.equal(windows.hourly, null);
  assert.equal(windows.weekly?.usedPercent, 37);
  assert.equal(windows.weekly?.resetsAt, '2026-09-14T14:00:00.000Z');
});

test('documented short secondary is retained alongside a weekly primary', () => {
  const windows = codexWindows(bucket({ primary: { ...window(10080, 80), resetsAt: RESET + 4 * 86400 }, secondary: window(300, 20) }), { now: NOW });
  assert.equal(windows.hourly?.usedPercent, 20);
  assert.equal(windows.weekly?.usedPercent, 80);
  assert.equal(windows.weeklyWindows.length, 1);
});

test('duration aliases are equivalent and agreeing aliases preserve zero usage', () => {
  for (const duration of [{ windowMinutes: 10080 }, { windowDurationMins: 10080 }, { windowMinutes: 10080, windowDurationMins: 10080 }]) {
    const windows = codexWindows({ primary: { usedPercent: 0, resetsAt: RESET, ...duration } }, { now: NOW });
    assert.equal(windows.hourly, null);
    assert.equal(windows.weekly?.usedPercent, 0);
  }
});

test('conflicting or explicitly invalid durations do not become guessed windows', () => {
  const invalid = [null, undefined, 0, -1, 1.5, '300', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  const cases = [
    { windowMinutes: 300, windowDurationMins: 10080 },
    ...invalid.flatMap(value => [
      { windowMinutes: value }, { windowDurationMins: value },
      { windowMinutes: 300, windowDurationMins: value },
      { windowMinutes: value, windowDurationMins: 300 }
    ])
  ];
  for (const duration of cases) {
    assert.deepEqual(codexWindows({ primary: { usedPercent: 25, resetsAt: RESET, ...duration } }, { now: NOW }), NO_WINDOWS);
  }
});

test('legacy missing duration keeps established fallback but does not synthesize a second window', () => {
  const windows = codexWindows({ primary: { usedPercent: 25, resetsAt: RESET } }, { now: NOW });
  assert.equal(windows.hourly?.usedPercent, 25);
  assert.equal(windows.weekly, null);
  assert.deepEqual(codexWindows({ primary: null, secondary: null }, { now: NOW }), NO_WINDOWS);
});

test('invalid percentages stay unknown and invalid reset dates cannot crash decoding', () => {
  for (const usedPercent of [null, undefined, -1, 101, '25', NaN, Infinity]) {
    assert.deepEqual(codexWindows(bucket({ primary: { ...window(300), usedPercent } }), { now: NOW }), NO_WINDOWS);
  }
  const windows = codexWindows(bucket({ primary: { ...window(10080), resetsAt: 8640000000001 } }), { now: NOW });
  assert.equal(windows.weekly?.resetsAt, null);
  assert.equal(windows.weekly?.usedPercent, 25);
});

test('Accounts selects only the named Codex bucket in a documented multi-bucket envelope', () => {
  const result = classify({ rateLimitsByLimitId: {
    codex_other: bucket({ limitId: 'codex_other', primary: window(300, 100) }),
    codex: bucket({ primary: window(300, 20), secondary: window(10080, 70) })
  } });
  assert.equal(result.status, STATUS.HEALTHY);
  assert.equal(result.usedPercent, 20);
  assert.equal(result.windows.hourly?.usedPercent, 20);
  assert.equal(result.windows.weekly?.usedPercent, 70);
});

test('explicit Codex map wins over compatibility view without merging its windows', async () => {
  const result = { rateLimits: bucket({ primary: window(300, 100) }),
    rateLimitsByLimitId: { codex: bucket({ primary: window(10080, 37) }) } };
  const health = classify(result);
  assert.equal(health.status, STATUS.HEALTHY);
  assert.equal(health.usedPercent, 37);
  assert.equal(health.windows.hourly, null);
  const usage = await readUsage(result);
  assert.equal(usage.provenance, 'MEASURED');
  assert.equal(usage.used, 37);
  assert.equal(usage.unit, 'percent-weekly');
});

test('missing, malformed or mismatched map bucket cannot fall back to an unrelated quota', async () => {
  for (const rateLimitsByLimitId of [
    {}, [], 'invalid', { codex_other: bucket({ limitId: 'codex_other' }) },
    { codex: null }, { codex: {} }, { codex: bucket({ limitId: 'codex_other' }) },
    { codex: bucket({ limitId: undefined }) }
  ]) {
    const result = { rateLimits: bucket(), rateLimitsByLimitId };
    const health = classify(result);
    assert.equal(health.status, STATUS.TRANSIENT);
    assert.equal(health.usedPercent, null);
    assert.deepEqual(health.windows, NO_WINDOWS);
    assert.equal((await readUsage(result)).provenance, 'UNKNOWN');
  }
});

test('both callers retain bare and compatibility envelopes when no map is supplied', async () => {
  for (const result of [bucket(), { rateLimits: bucket() }, { rateLimits: bucket(), rateLimitsByLimitId: null }]) {
    assert.equal(classify(result).windows.weekly?.usedPercent, 37);
    assert.equal((await readUsage(result)).unit, 'percent-weekly');
  }
  assert.equal(classify({ primary: { usedPercent: 20, windowMinutes: 300 } }).windows.hourly?.usedPercent, 20);
  for (const result of [bucket({ limitId: 'codex_other' }), { rateLimits: bucket({ limitId: 'codex_other' }) }]) {
    assert.equal(classify(result).status, STATUS.TRANSIENT);
    assert.equal((await readUsage(result)).provenance, 'UNKNOWN');
  }
});

test('strict UsageRecord shares aliases while retaining its exact single-window contract', async () => {
  for (const duration of [{ windowMinutes: 300 }, { windowMinutes: 300, windowDurationMins: 300 }]) {
    const result = await readUsage(bucket({ primary: { usedPercent: 0, resetsAt: RESET, ...duration } }));
    assert.equal(result.provenance, 'MEASURED');
    assert.equal(result.unit, 'percent-5-hour');
    assert.equal(result.used, 0);
  }
  for (const primary of [
    { usedPercent: 25, resetsAt: RESET }, { ...window(300), windowMinutes: 10080 },
    { ...window(300), windowDurationMins: null }, { ...window(300), extra: true },
    { ...window(300), resetsAt: 8640000000001 }
  ]) assert.equal((await readUsage(bucket({ primary }))).provenance, 'UNKNOWN');
  assert.equal((await readUsage(bucket({ secondary: window(300) }))).provenance, 'UNKNOWN');
});

test('selected Codex bucket keeps weekly exhaustion and explicit provider exhaustion flags', () => {
  const result = classify({ rateLimitsByLimitId: { codex: bucket({ primary: window(300, 0), secondary: window(10080, 100) }) } });
  assert.equal(result.status, STATUS.EXHAUSTED);
  assert.equal(result.windows.weekly?.usedPercent, 100);
  for (const flags of [{ rateLimitReachedType: 'weekly' }, { spendControlReached: true }]) {
    assert.equal(classify({ rateLimitsByLimitId: { codex: bucket(flags) } }).status, STATUS.EXHAUSTED);
  }
});
