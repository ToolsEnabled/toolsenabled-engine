// EXECUTABLE CHANGE — cost-reason assertions now compare against independent
// contract literals instead of values exported by the implementation under test.
//
// MUTATION REPORT (controller-cost-attribution): individually changing each
// reason constant in src/lib/controller-cost-attribution.js left the original
// test green. The strengthened assertions and their RED results are:
// - lane unavailableReason / NO_PROVIDER_AMOUNT mutation:
//   + 'MUTATED-no-provider-amount' / - 'provider-did-not-report-amount'
// - totals and item unavailableReason / PARTIAL_COVERAGE mutation:
//   + 'MUTATED-partial-coverage' / - 'partial-durable-meter'
// - item unavailableReason / NOT_PROVIDER_REPORTED mutation:
//   + 'MUTATED-not-provider-reported' / - 'amount-not-provider-reported'
// - totals unavailableReason / NO_RECORDS mutation:
//   + 'MUTATED-no-records' / - 'no-durable-provider-usage-in-window'
// Each RED run reported "AssertionError [ERR_ASSERTION]: Expected values to be
// strictly equal" and exited 1.
// The product source was then restored byte-for-byte (SHA-256
// 0ba6cb5dbc53112f2d7962f2287fe78a5396935a56b748d0d49d9586f35b25ee),
// and `node tests/controller/controller-cost-attribution.js` returned:
//   Controller cost attribution tests passed (provider amounts only; unknowns never priced).
// Checked shapes NOT-FOUND: vacuous iteration; exit-status/truthy-process
// evidence; swallowed failures via try/catch or optional chaining; mocks of the
// subject; platform skips or precondition guards. Same-code expected values
// were FOUND and fixed below. Preconditions not met: none.
'use strict';

const assert = require('node:assert/strict');
const cost = require('../../src/lib/controller-cost-attribution');
const meter = require('../../src/lib/controller-metering');

// The roster this file validates against is DECLARED here, not read from
// config/google-accounts.profile.json. That file is gitignored, so a test that
// spelled out the developer's own registered alias passed on his machine and
// failed in every fresh checkout and detached worktree -- which is exactly how
// an engine baseline stopped being measurable from a worktree at all (R1531
// w8). These two aliases exist only in this file.
const ROSTER = meter.accountRosterOf(['acct-a', 'acct-b']);

const hash = character => character.repeat(64);
function record(overrides = {}) {
  const { marker = 'A'.repeat(16), hash: hashCharacter = 'a', auditSequence = 7, ...rest } = overrides;
  return {
    schemaVersion: 1, meterId: `mtr_${marker}`,
    auditSequence, auditEventHash: hash(hashCharacter),
    taskRef: 'task.release-01', phaseRef: 'phase.review-01', configurationHash: hash('f'),
    provider: 'claude', accountAlias: 'acct-a', lane: 'subscription-cli', modelAlias: 'claude-cli',
    sourceType: 'provider-reported', tokenizerVersion: null, unavailableReason: null, requestClass: 'review',
    window: { startedAt: '2026-07-27T00:00:00.000Z', endedAt: '2026-07-27T00:00:01.000Z', freshness: 'fresh', completeness: 'complete' },
    units: { reportedTokens: 12, deterministicTokens: null, billableUnits: null, costMicros: 321 },
    elapsedMs: 1000, queueMs: 0, idleMs: 0, retry: false, replay: false, cacheReuse: false,
    reviewVerdict: 'approved', terminalStatus: 'success', wasteReason: 'none', ...rest
  };
}

const expected = [
  { accountAlias: 'acct-a', provider: 'gemini', lane: 'subscription-cli' },
  { accountAlias: 'acct-a', provider: 'gemini', lane: 'vertex' },
  { accountAlias: 'acct-b', provider: 'gemini', lane: 'api' }
];

{
  const output = cost.fromMeterRecords([record()], { expectedLanes: expected, accountRoster: ROSTER });
  const claude = output.lanes.find(item => item.provider === 'claude');
  assert.deepEqual(claude, {
    accountAlias: 'acct-a', provider: 'claude', lane: 'subscription-cli',
    costMicros: 321, costState: 'observed', unavailableReason: null,
    itemCount: 1, observedItemCount: 1, unknownItemCount: 0
  });
  assert.equal(output.totals.costMicros, null, 'the required but unobserved Gemini lanes keep the cross-lane total UNKNOWN');
  assert.equal(output.totals.costState, 'UNKNOWN');
  const item = output.items[0];
  assert.equal(item.costMicros, 321);
  assert.equal(item.reviewVerdict, 'approved');
  assert.equal(item.terminalStatus, 'success');
  assert.match(item.itemId, /^cost_[A-Za-z0-9_-]{30}$/);
  assert.doesNotMatch(JSON.stringify(output), /task\.release|phase\.review|claude-cli/i,
    'the per-item spend-versus-verdict view contains only an opaque item id, never task/phase/model text');
  assert.ok(Object.isFrozen(output) && Object.isFrozen(output.totals) && Object.isFrozen(output.lanes) && Object.isFrozen(item));
}

{
  const missing = record({ marker: 'B'.repeat(16), auditSequence: 8, hash: 'b', units: { reportedTokens: 40, deterministicTokens: null, billableUnits: null, costMicros: null } });
  const output = cost.fromMeterRecords([record(), missing], { accountRoster: ROSTER });
  assert.equal(output.lanes[0].costMicros, null, 'one token-only record makes the lane total UNKNOWN rather than a partial sum');
  assert.equal(output.lanes[0].costState, 'UNKNOWN');
  assert.equal(output.lanes[0].unavailableReason, 'provider-did-not-report-amount');
  assert.equal(output.items.find(item => item.costState === 'UNKNOWN').costMicros, null);
  assert.equal(output.totals.costMicros, null);
}

{
  const output = cost.fromMeterRecords([record()], { coverageComplete: false, accountRoster: ROSTER });
  assert.equal(output.lanes[0].costMicros, 321,
    'a valid recovered lane remains useful evidence even when another record was skipped');
  assert.equal(output.totals.costMicros, null,
    'a partial durable read must never turn surviving provider amounts into a spend total');
  assert.equal(output.totals.costState, 'UNKNOWN');
  assert.equal(output.totals.unavailableReason, 'partial-durable-meter');
}

{
  const output = cost.fromMeterRecords([record()], { accountRoster: ROSTER });
  assert.equal(output.totals.costMicros, null,
    'omitting a coverage claim must not turn the supplied records into a proven complete total');
  assert.equal(output.totals.costState, 'UNKNOWN');
  assert.equal(output.totals.unavailableReason, cost.PARTIAL_COVERAGE);
}

{
  const partial = record({
    marker: 'E'.repeat(16), auditSequence: 11, hash: 'e',
    window: { startedAt: '2026-07-27T00:00:00.000Z', endedAt: '2026-07-27T00:00:01.000Z', freshness: 'partial', completeness: 'partial' }
  });
  const output = cost.fromMeterRecords([partial], { accountRoster: ROSTER });
  assert.equal(output.items[0].costMicros, null,
    'a provider amount from a partial capture is not a proven whole-operation cost');
  assert.equal(output.items[0].unavailableReason, 'partial-durable-meter');
  assert.equal(output.totals.costMicros, null);
}

{
  const tokenizer = record({
    marker: 'C'.repeat(16), auditSequence: 9, hash: 'c', sourceType: 'deterministic-tokenizer', tokenizerVersion: 'cl100k-base-v1',
    units: { reportedTokens: null, deterministicTokens: 50, billableUnits: null, costMicros: 999 }
  });
  const output = cost.fromMeterRecords([tokenizer], { accountRoster: ROSTER });
  assert.equal(output.items[0].costMicros, null, 'a tokenized value never becomes a price even if a malformed caller supplies one');
  assert.equal(output.items[0].unavailableReason, 'amount-not-provider-reported');
}

{
  const unavailable = record({
    marker: 'D'.repeat(16), auditSequence: 10, hash: 'd', sourceType: 'unavailable', unavailableReason: 'official-billing-unavailable',
    window: { startedAt: '2026-07-27T00:00:00.000Z', endedAt: '2026-07-27T00:00:01.000Z', freshness: 'fresh', completeness: 'unavailable' },
    units: { reportedTokens: null, deterministicTokens: null, billableUnits: null, costMicros: null }
  });
  const output = cost.fromMeterRecords([unavailable], { accountRoster: ROSTER });
  assert.equal(output.items[0].costState, 'UNKNOWN');
  assert.equal(output.items[0].unavailableReason, 'official-billing-unavailable');
  /* BOTH KEPT, WITH DIFFERENT EXPECTED VALUES, because the sweep made these two
   * calls mean different things and the older assertion had not caught up.
   * An empty record set is only "no usage in this window" if you KNOW you saw
   * the whole window. With coverageComplete stated, empty is a measured answer.
   * Without it, empty is PARTIAL -- the meter may simply not have been read --
   * and reporting that as "no usage" is the could-not-collapse this sweep
   * exists to remove. Asserting the pair is what pins the distinction; either
   * one alone would pass against code that ignored coverage entirely. */
  assert.equal(cost.fromMeterRecords([], { expectedLanes: expected, coverageComplete: true, accountRoster: ROSTER }).totals.unavailableReason, cost.NO_RECORDS);
  assert.equal(cost.fromMeterRecords([], { expectedLanes: expected, accountRoster: ROSTER }).totals.unavailableReason, 'partial-durable-meter');
}

assert.throws(() => cost.fromMeterRecords([{ nope: true }], { accountRoster: ROSTER }), error => error && error.code === 'COST_ATTRIBUTION_INVALID');
assert.throws(() => cost.fromMeterRecords([], { expectedLanes: [{ accountAlias: 'bad', provider: 'gemini', lane: 'api' }], accountRoster: ROSTER }), error => error && error.code === 'COST_ATTRIBUTION_INVALID');
assert.throws(() => cost.fromMeterRecords([], { coverageComplete: 'yes', accountRoster: ROSTER }), error => error && error.code === 'COST_ATTRIBUTION_INVALID');

console.log('Controller cost attribution tests passed (provider amounts only; unknowns never priced).');

// ABSENCE CASE, tested on purpose rather than assumed. An installation with no
// registered Google accounts is a real state -- a fresh install before the
// first tools/google-oauth-login.js run -- and it must REJECT a lane naming a
// registered-looking account instead of quietly accepting it. Declaring an
// empty roster is a claim ("nobody is registered here"), never a request to
// skip the check.
const EMPTY_ROSTER = meter.accountRosterOf([]);
assert.equal(EMPTY_ROSTER.state, 'no-accounts-registered');
assert.throws(
  () => cost.fromMeterRecords([], { expectedLanes: [{ accountAlias: 'acct-a', provider: 'gemini', lane: 'api' }], accountRoster: EMPTY_ROSTER }),
  error => error && error.code === 'COST_ATTRIBUTION_INVALID',
  'an empty roster must reject a lane naming an account nobody registered');
assert.deepEqual(
  cost.fromMeterRecords([], { expectedLanes: [{ accountAlias: 'unattributed', provider: 'gemini', lane: 'api' }], accountRoster: EMPTY_ROSTER }).lanes
    .map(lane => `${lane.accountAlias}\0${lane.lane}`),
  ['unattributed\0api'],
  "'unattributed' stays valid on an installation that has registered nothing");
// A present-but-unusable roster is a caller error, not permission: it must not
// fall back to this machine's accounts and must not accept everything.
for (const bogus of [{}, [], 'acct-a', 0, true, { state: 'accounts-registered' }]) {
  assert.throws(() => cost.fromMeterRecords([], { accountRoster: bogus }),
    error => error && error.code === 'COST_ATTRIBUTION_INVALID',
    'a malformed declared roster must fail closed');
}// `accountRoster: undefined` is "not specified" (live roster), matching how an
// omitted key behaves; `null` is a caller error, because the caller wrote
// something that resolved to nothing.
assert.equal(cost.fromMeterRecords([], { accountRoster: undefined }).totals.costState, 'UNKNOWN');
assert.throws(() => cost.fromMeterRecords([], { accountRoster: null }),
  error => error && error.code === 'COST_ATTRIBUTION_INVALID');
