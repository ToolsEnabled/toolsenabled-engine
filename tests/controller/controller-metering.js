// EXECUTABLE CHANGE
// testcanfail-tests-controller-controller-metering-js
//
// Mutation report: the pairsFromAuditEvents assertion previously computed its
// expected value by calling savings.normalizePair, the same normalizer used by
// the subject.  Mutating normalizePair to return
// `validationRef: 'mutation-survived'` left the test GREEN.  After replacing the
// computed oracle with the literal contract below, the same mutation went RED:
// `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:`
// `+ actual - expected ... + validationRef: 'mutation-survived'`
// `- validationRef: 'baseline-check-01'`.
// The product file was then restored byte-for-byte (cmp exit 0); the final run
// was GREEN and printed `Controller mechanical metering tests passed.` and
// `Controller metering account-roster tests passed (live resolution, named absence, fail-closed declaration).`
// Checked shapes NOT-FOUND: empty collection iteration; exit-status/truthy
// process evidence; failure-swallowing try/catch or optional chaining (the one
// try/catch deliberately extracts an error message, while an earlier assert
// independently requires that call to throw); mock of the subject; platform
// skip/precondition guard.  Same-code expected value: FOUND and fixed.  No
// precondition was unmet.

'use strict';

const assert = require('node:assert/strict');
const meter = require('../../src/lib/controller-metering');
const savings = require('../../src/lib/controller-savings');

const hash = char => char.repeat(64);
const base = {
  schemaVersion: 1, meterId: `mtr_${'A'.repeat(16)}`, auditSequence: 7, auditEventHash: hash('a'), taskRef: 'task.release-01', phaseRef: 'phase.review-01', configurationHash: hash('f'),
  provider: 'gemini', accountAlias: 'unattributed', lane: 'subscription-cli', modelAlias: 'gemini-cli', sourceType: 'unavailable', tokenizerVersion: null, unavailableReason: 'provider-no-structured-meter', requestClass: 'review',
  window: { startedAt: '2026-07-27T00:00:00.000Z', endedAt: '2026-07-27T00:00:01.000Z', freshness: 'fresh', completeness: 'unavailable' },
  units: { reportedTokens: null, deterministicTokens: null, billableUnits: null, costMicros: null }, elapsedMs: 1000, queueMs: 0, idleMs: 0,
  retry: false, replay: false, cacheReuse: false, reviewVerdict: 'unavailable', terminalStatus: 'success', wasteReason: 'none'
};
const clone = value => JSON.parse(JSON.stringify(value));
const code = (fn, expected) => assert.throws(fn, error => error && error.code === expected, `expected ${expected}`);

(() => {
  const unavailable = meter.normalizeRecord(base);
  assert.match(unavailable.recordHash, /^[a-f0-9]{64}$/);
  assert.equal(unavailable.units.reportedTokens, null);

  const reported = clone(base); reported.meterId = `mtr_${'B'.repeat(16)}`; reported.auditSequence = 8; reported.auditEventHash = hash('b'); reported.sourceType = 'provider-reported'; reported.unavailableReason = null; reported.window.completeness = 'complete'; reported.units.reportedTokens = 123; reported.units.costMicros = 456; reported.wasteReason = 'retry'; reported.retry = true;
  const deterministic = clone(base); deterministic.meterId = `mtr_${'C'.repeat(16)}`; deterministic.auditSequence = 9; deterministic.auditEventHash = hash('c'); deterministic.provider = 'local'; deterministic.accountAlias = 'unattributed'; deterministic.lane = 'local'; deterministic.sourceType = 'deterministic-tokenizer'; deterministic.tokenizerVersion = 'cl100k-base-v1'; deterministic.unavailableReason = null; deterministic.window.completeness = 'complete'; deterministic.units.deterministicTokens = 77;
  const totals = meter.aggregate([base, reported, deterministic]);
  assert.equal(totals.length, 2);
  const gemini = totals.find(item => item.provider === 'gemini');
  assert.equal(gemini.recordCount, 2); assert.equal(gemini.reportedTokens, 123); assert.equal(gemini.costMicros, 456); assert.equal(gemini.unavailableCount, 1); assert.equal(gemini.retryCount, 1); assert.equal(gemini.waste.retry, 1); assert.equal(gemini.terminalStatusCounts.success, 2);

  const secret = clone(base); secret.taskRef = 'Bearer hidden-token'; code(() => meter.normalizeRecord(secret), 'METER_INVALID');
  const invented = clone(base); invented.units.reportedTokens = 1; code(() => meter.normalizeRecord(invented), 'METER_INVALID');
  const noProviderUnit = clone(reported); noProviderUnit.units.reportedTokens = null; noProviderUnit.units.costMicros = null; code(() => meter.normalizeRecord(noProviderUnit), 'METER_INVALID');
  const duplicate = clone(reported); duplicate.meterId = `mtr_${'D'.repeat(16)}`; code(() => meter.aggregate([reported, duplicate]), 'METER_DUPLICATE');
  const raw = clone(base); raw.prompt = 'forbidden'; code(() => meter.normalizeRecord(raw), 'METER_INVALID');
  code(() => meter.aggregate(null), 'METER_INVALID');
  code(() => meter.aggregate({}), 'METER_INVALID');
  const missingUnavailableReason = clone(base); missingUnavailableReason.unavailableReason = null; code(() => meter.normalizeRecord(missingUnavailableReason), 'METER_INVALID');
  const missingTokenizer = clone(deterministic); missingTokenizer.tokenizerVersion = null; code(() => meter.normalizeRecord(missingTokenizer), 'METER_INVALID');

  const baselineInput = clone(reported);
  baselineInput.meterId = `mtr_${'E'.repeat(16)}`;
  baselineInput.auditSequence = 10;
  baselineInput.auditEventHash = hash('e');
  baselineInput.units.reportedTokens = 100;
  baselineInput.units.costMicros = 1000;
  baselineInput.retry = false;
  baselineInput.wasteReason = 'none';
  const candidateInput = clone(reported);
  candidateInput.meterId = `mtr_${'F'.repeat(16)}`;
  candidateInput.auditSequence = 11;
  candidateInput.auditEventHash = hash('f');
  candidateInput.units.reportedTokens = 60;
  candidateInput.units.costMicros = 600;
  candidateInput.retry = false;
  candidateInput.wasteReason = 'none';
  const baseline = meter.normalizeRecord(baselineInput);
  const candidate = meter.normalizeRecord(candidateInput);
  const pair = {
    schemaVersion: 1,
    pairId: `sav_${'P'.repeat(16)}`,
    taskClass: 'review',
    baselineMeterId: baseline.meterId,
    candidateMeterId: candidate.meterId,
    baselineRecordHash: baseline.recordHash,
    candidateRecordHash: candidate.recordHash,
    attribution: 'bounded-context',
    protocolHash: hash('a'),
    validationRef: 'baseline-check-01',
    nonOverlapping: true,
    window: {
      startedAt: '2026-07-27T00:00:00.000Z',
      endedAt: '2026-07-27T00:00:02.000Z',
      freshness: 'fresh',
      completeness: 'complete'
    }
  };
  const verifiedSavings = savings.matchedSavings([baseline, candidate], [pair]);
  assert.equal(verifiedSavings.state, 'verified-matched-baseline');
  assert.equal(verifiedSavings.pairCount, 1);
  assert.equal(verifiedSavings.tokenCount, 40);
  assert.equal(verifiedSavings.costMicros, 400);
  assert.equal(verifiedSavings.regressionTokenCount, 0);
  assert.equal(verifiedSavings.regressionCostMicros, 0);
  assert.deepEqual(verifiedSavings.attributionCounts, { 'bounded-context': 1 });
  assert.deepEqual(savings.pairsFromAuditEvents([{
    action: savings.ACTION,
    details: { schemaVersion: 1, pair }
  }]), [{
    schemaVersion: 1,
    pairId: `sav_${'P'.repeat(16)}`,
    taskClass: 'review',
    baselineMeterId: `mtr_${'E'.repeat(16)}`,
    candidateMeterId: `mtr_${'F'.repeat(16)}`,
    baselineRecordHash: '9a449653f956f04817d02e3db394a8e63cbbead66ffd087191c2f0010fefdca1',
    candidateRecordHash: '3a75c5d34e6be1344564658537a2a6e3284b38bf1832173a5c90af293711fd96',
    attribution: 'bounded-context',
    protocolHash: hash('a'),
    validationRef: 'baseline-check-01',
    nonOverlapping: true,
    window: {
      startedAt: '2026-07-27T00:00:00.000Z',
      endedAt: '2026-07-27T00:00:02.000Z',
      freshness: 'fresh',
      completeness: 'complete'
    }
  }]);
  const alteredPair = clone(pair);
  alteredPair.baselineRecordHash = hash('0');
  const rejectedSavings = savings.matchedSavings([baseline, candidate], [alteredPair]);
  assert.equal(rejectedSavings.state, 'invalid-matched-baseline');
  assert.equal(rejectedSavings.reason, 'pair-evidence-mismatch');
  assert.equal(savings.matchedSavings([baseline, candidate], []).state, savings.UNKNOWN_STATE);
  console.log('Controller mechanical metering tests passed.');
})();

// --- The account roster: resolved when needed, absence named ---------------
// Registered accounts live in config/google-accounts.profile.json, which is
// GITIGNORED user data. This module used to snapshot that roster into a Set at
// MODULE LOAD, which was wrong twice over: an account the customer registered
// after the first require() was rejected until the process restarted, and any
// checkout without the profile (fresh clone, detached worktree, fresh install)
// validated every record against a roster of one. Nothing below reads this
// machine's profile -- every roster here is declared by this file, so these
// assertions mean the same thing on every checkout.
(() => {
  const registered = meter.accountRosterOf(['acct-a', 'acct-b']);
  assert.equal(registered.state, 'accounts-registered');
  assert.equal(registered.accountCount, 2);
  assert.deepEqual(registered.registeredAliases, ['acct-a', 'acct-b']);

  const withRegistered = clone(base); withRegistered.accountAlias = 'acct-a';
  assert.equal(meter.normalizeRecord(withRegistered, { accountRoster: registered }).accountAlias, 'acct-a',
    'a customer\'s own registered account must be a valid accountAlias');

  const unregistered = clone(base); unregistered.accountAlias = 'acct-z';
  code(() => meter.normalizeRecord(unregistered, { accountRoster: registered }), 'METER_INVALID');

  // ABSENCE FIRST. "No accounts are registered" is a legitimate installation
  // state, not an error and not permission. It must reject a registered-looking
  // alias, keep accepting 'unattributed', and SAY WHICH STATE IT IS -- the old
  // code answered a bare "accountAlias is invalid." that read identically to a
  // typo'd alias, which is what made a whole worktree's failure look like a
  // dozen unrelated regressions.
  const empty = meter.accountRosterOf([]);
  assert.equal(empty.state, 'no-accounts-registered');
  assert.equal(empty.accountCount, 0);
  assert.equal(meter.normalizeRecord(clone(base), { accountRoster: empty }).accountAlias, 'unattributed',
    "'unattributed' stays valid on an installation that has registered nothing");
  assert.throws(() => meter.normalizeRecord(withRegistered, { accountRoster: empty }), error =>
    error && error.code === 'METER_INVALID'
    && error.accountRosterState === 'no-accounts-registered'
    && error.accountCount === 0
    && /no-accounts-registered/.test(error.message),
  'an empty roster must name its state on the error, not just say "invalid"');
  // The named state is reported, but the aliases themselves are user data and
  // must never travel in an error message.
  assert.doesNotMatch(
    (() => { try { meter.normalizeRecord(unregistered, { accountRoster: registered }); return ''; } catch (error) { return error.message; } })(),
    /acct-a|acct-b/, 'a roster error must not leak the registered aliases');

  // Absence is never consent: an options object that supplies something other
  // than a roster fails closed rather than accepting any alias or silently
  // reading this machine's accounts.
  // The record used here carries 'unattributed', which EVERY roster accepts --
  // including the live one. So the only way this can throw is if the malformed
  // DECLARATION itself was rejected. Asserting against a record with an
  // unregistered alias instead would pass whether the declaration failed closed
  // or silently fell back to this machine's accounts, and a test that cannot
  // tell those apart is a false control: a mutation that replaced the throw
  // with `return accountRoster()` survived it.
  for (const bogus of [{}, [], 'acct-a', 0, true, null, { state: 'accounts-registered', accountCount: 1 }]) {
    code(() => meter.normalizeRecord(clone(base), { accountRoster: bogus }), 'METER_INVALID');
    code(() => meter.aggregate([clone(base)], { accountRoster: bogus }), 'METER_INVALID');
  }
  // ...but an UNDEFINED value is "not specified", the same as an omitted key:
  // an intermediate forwarding an optional argument it never received must
  // still get the live roster, not an exception. Unspecified resolves to the
  // strictest available answer, so this can never widen anything.
  assert.equal(
    meter.normalizeRecord(clone(base), { accountRoster: undefined }).accountAlias, 'unattributed',
    'accountRoster: undefined must mean "not specified", not "invalid"');
  assert.equal(meter.normalizeRecord(clone(base)).accountAlias, 'unattributed');
  code(() => meter.normalizeRecord(withRegistered, { rosterAliases: ['acct-a'] }), 'METER_INVALID');
  code(() => meter.accountRosterOf('acct-a'), 'METER_INVALID');
  code(() => meter.accountRosterOf(['not a valid alias']), 'METER_INVALID');
  code(() => meter.accountRosterOf(['unattributed']), 'METER_INVALID');
  code(() => meter.accountRosterFor(null), 'METER_INVALID');
  code(() => meter.accountRosterFor({ 'invalid alias': {} }), 'METER_INVALID');

  // A whole batch is judged against one roster.
  const batchA = clone(withRegistered); batchA.meterId = `mtr_${'G'.repeat(16)}`; batchA.auditSequence = 21; batchA.auditEventHash = hash('1');
  const batchB = clone(base); batchB.meterId = `mtr_${'H'.repeat(16)}`; batchB.auditSequence = 22; batchB.auditEventHash = hash('2');
  assert.equal(meter.aggregate([batchA, batchB], { accountRoster: registered }).length, 2);
  code(() => meter.aggregate([batchA, batchB], { accountRoster: empty }), 'METER_INVALID');

  // The module must expose no import-time snapshot for a caller to trust.
  assert.equal(meter.ACCOUNTS, undefined,
    'a roster frozen at import must not be exported: a caller cannot tell a stale Set from a current one');
  // And the live roster must be a fresh read each time, not a memoised one.
  assert.notEqual(meter.accountRoster(), meter.accountRoster(),
    'accountRoster() must resolve when called, not hand back one value frozen at load');
  assert.deepEqual(meter.accountRoster().registeredAliases, meter.accountRoster().registeredAliases);

  // A dependency failure means the roster was not measured; it must not be
  // reported as the definite (and more permissive for unattributed records)
  // no-accounts-registered state.
  const googleAccounts = require('../../src/lib/google-accounts');
  const originalLoad = googleAccounts.load;
  googleAccounts.load = () => { throw new Error('simulated unreadable profile'); };
  try { code(() => meter.accountRoster(), 'METER_ROSTER_UNAVAILABLE'); }
  finally { googleAccounts.load = originalLoad; }
  console.log('Controller metering account-roster tests passed (live resolution, named absence, fail-closed declaration).');
})();
