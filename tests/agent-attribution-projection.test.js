'use strict';

const assert = require('node:assert');
const {
  MATCH_LEAD_MS,
  MAX_MATCH_AFTER_MS,
  buildAgentAttributionProjection,
  correlate
} = require('../src/lib/agent-attribution-projection');

const launchedAt = '2026-08-27T12:00:00.000Z';
const launchedAtMs = Date.parse(launchedAt);

function launch(overrides = {}) {
  return {
    launchId: 'launch_primary',
    launchedAt,
    provider: 'codex',
    model: 'gpt-5.6-sol',
    cap: { capMs: MAX_MATCH_AFTER_MS },
    ...overrides
  };
}

function session(observationRef, overrides = {}) {
  return {
    observationRef,
    provider: 'codex',
    model: null,
    declaredModelAlias: null,
    firstObservedAtMs: launchedAtMs,
    ...overrides
  };
}

function testExactModelWinsAndReportsItsEvidence() {
  const result = correlate(
    [launch()],
    [
      session('provider-time-only'),
      session('exact-model', { model: 'gpt-5.6-sol' })
    ]
  );

  assert.deepStrictEqual(result.sessionMatch.get('exact-model'), {
    launchId: 'launch_primary',
    matchStrength: 'model-exact'
  });
  assert.strictEqual(result.sessionMatch.has('provider-time-only'), false);
  assert.deepStrictEqual(result.launchOutcome.get('launch_primary'), {
    matchedRef: 'exact-model',
    matchStrength: 'model-exact',
    ambiguous: false,
    observable: true,
    reason: null
  });
}

function testEqualBestCandidatesAreRefusedAsAmbiguous() {
  const result = correlate(
    [launch()],
    [
      session('exact-one', { model: 'gpt-5.6-sol' }),
      session('exact-two', { model: 'gpt-5.6-sol' })
    ]
  );
  const outcome = result.launchOutcome.get('launch_primary');

  assert.strictEqual(result.sessionMatch.size, 0);
  assert.strictEqual(outcome.matchedRef, null);
  assert.strictEqual(outcome.ambiguous, true);
  assert.match(outcome.reason, /refusing to attribute rather than guessing/);
}

function testSessionsAreConsumedOnceInLaunchTimeOrder() {
  const result = correlate(
    [
      launch({ launchId: 'launch_later', launchedAt: '2026-08-27T12:01:00.000Z' }),
      launch({ launchId: 'launch_earlier' })
    ],
    [session('only-session', { model: 'gpt-5.6-sol' })]
  );

  assert.strictEqual(result.sessionMatch.get('only-session').launchId, 'launch_earlier');
  assert.strictEqual(result.launchOutcome.get('launch_later').matchedRef, null);
  assert.match(result.launchOutcome.get('launch_later').reason, /no observed session/);
}

function testProviderAndBoundedWindowAreEnforced() {
  const result = correlate(
    [launch({ cap: { capMs: 5 * 60 * 1000 } })],
    [
      session('wrong-provider', { provider: 'claude', model: 'gpt-5.6-sol' }),
      session('too-early', { model: 'gpt-5.6-sol', firstObservedAtMs: launchedAtMs - MATCH_LEAD_MS - 1 }),
      session('too-late-for-cap', { model: 'gpt-5.6-sol', firstObservedAtMs: launchedAtMs + 5 * 60 * 1000 + 1 })
    ]
  );

  assert.strictEqual(result.sessionMatch.size, 0);
  assert.strictEqual(result.launchOutcome.get('launch_primary').observable, true);
  assert.match(result.launchOutcome.get('launch_primary').reason, /outside the scanned observation coverage/);
}

function testUnsupportedProviderIsUnobservableRatherThanDrift() {
  const result = correlate(
    [launch({ provider: 'local' })],
    [session('local-session', { provider: 'local', model: 'gpt-5.6-sol' })]
  );
  const outcome = result.launchOutcome.get('launch_primary');

  assert.strictEqual(result.sessionMatch.size, 0);
  assert.strictEqual(outcome.observable, false);
  assert.strictEqual(outcome.ambiguous, false);
  assert.match(outcome.reason, /no session-file observer exists/);
}

function projectionDependencies(overrides = {}) {
  return {
    audit: { tail: () => [] },
    ...overrides
  };
}

function projectionOptions() {
  return {
    nowMs: launchedAtMs,
    observation: { method: 'fixture', coverage: 'complete', coverageNotes: [], scans: [], sessions: [] },
    sessionConsent: { ok: true, source: 'absent', importedSurfaces: [] }
  };
}

function testOrgReadFailureIsNotReportedAsAbsenceOrCached() {
  let busyReads = 0;
  const busyFs = {
    readFileSync() {
      busyReads += 1;
      throw Object.assign(new Error('machine busy'), { code: 'EBUSY' });
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () => buildAgentAttributionProjection(projectionOptions(), projectionDependencies({ fs: busyFs })),
      error => error?.code === 'ATTRIBUTION_ORG_UNAVAILABLE'
        && /NOT claiming.*absent/.test(error.message)
        && error.cause?.code === 'EBUSY'
    );
  }
  assert.strictEqual(busyReads, 2, 'a could-not-tell result must not be cached or latched');

  const absent = buildAgentAttributionProjection(projectionOptions(), projectionDependencies({
    fs: { readFileSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }
  }));
  assert.strictEqual(absent.reconciliation.declaredOrgResolved, false,
    'CONTROL: genuine absence retains the established absent projection');

  let injectedOrgReads = 0;
  const injected = { agents: [] };
  const injectedDependencies = projectionDependencies({
    org: injected,
    fs: { readFileSync: () => { injectedOrgReads += 1; throw new Error('must not read'); } }
  });
  buildAgentAttributionProjection(projectionOptions(), injectedDependencies);
  buildAgentAttributionProjection(projectionOptions(), injectedDependencies);
  assert.strictEqual(injectedOrgReads, 0,
    'CONTROL: a caller-supplied resolved org retains the existing no-read fast path');
}

const tests = [
  testExactModelWinsAndReportsItsEvidence,
  testEqualBestCandidatesAreRefusedAsAmbiguous,
  testSessionsAreConsumedOnceInLaunchTimeOrder,
  testProviderAndBoundedWindowAreEnforced,
  testUnsupportedProviderIsUnobservableRatherThanDrift,
  testOrgReadFailureIsNotReportedAsAbsenceOrCached
];

for (const test of tests) test();
console.log(`Agent attribution projection tests passed (${tests.length} cases).`);
