// EXECUTABLE CHANGE
// Assertion audit report (testcanfail-tests-controller-controller-projection-js):
// - Strengthened the invalid-audit provider-meter `.every(...)` assertion with
//   a non-empty precondition. Mutation: returned `[]` for `providerMeters` only
//   when audit verification was invalid. RED: `AssertionError [ERR_ASSERTION]:
//   an invalid audit still projects the fixed provider roster before checking
//   every row` (`actual: 0`, `expected: 0`, `operator: 'notStrictEqual'`).
// - Restored src/lib/controller-projection.js byte-for-byte after the mutation.
//   GREEN: `Controller projection account-roster tests passed (declared
//   configuration, honest empty-roster projection).`
// - NOT-FOUND (empty iteration): the other `.every(...)` is preceded by
//   provider-specific dereferences, the account-lane loop is preceded by an
//   exact non-empty deepEqual, and the TypeError loop iterates a fixed literal.
// - NOT-FOUND: exit-status/truthy process evidence; swallowed try/catch or
//   optional chaining; mocks of the subject; skips/platform guards; expected
//   values computed by the same projection code.
// - Preconditions met: Node and generated contract outputs were available.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildControllerProjection, staleProjection } = require('../../src/lib/controller-projection');
const meterContract = require('../../src/lib/controller-metering');
const savingsContract = require('../../src/lib/controller-savings');
const generator = require('../../tools/generate-agent-activity-contracts');
const coordinatorAudit = require('../../src/lib/coordinator-audit-events');
const cliSessionUsage = require('../../src/lib/cli-session-usage');
const googleAccounts = require('../../src/lib/google-accounts');
const vertexGemini = require('../../src/lib/providers/vertex-gemini');
const vertexGeminiSeat = require('../../src/lib/providers/vertex-gemini-seat');

// Render from the tracked schemas/templates into an isolated consumer fixture.
// The projection contract must not depend on a sibling visualizer checkout
// happening to exist beside this repository.
const generatedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-projection-contracts-'));
process.once('exit', () => fs.rmSync(generatedDirectory, { recursive: true, force: true }));
const renderedContracts = generator.renderAll();
assert.equal(renderedContracts.size, 3, 'the source package must render every declared consumer language');
const renderedJavascript = renderedContracts.get(generator.OUTPUTS.javascript);
assert.equal(typeof renderedJavascript, 'string', 'the source package must render its JavaScript consumer contract');
const generatedJavascript = path.join(generatedDirectory, 'agent-activity-contracts.js');
fs.writeFileSync(generatedJavascript, renderedJavascript, 'utf8');
const contracts = require(generatedJavascript);

// The account configuration this file projects is DECLARED here and passed in
// as buildControllerProjection({ accounts: ACCOUNTS, accounts }). It is deliberately NOT read from
// config/google-accounts.profile.json.
//
// Reading it was the older, subtler version of the same defect this file now
// guards against. The profile is gitignored, so this test asserted "the three
// Gemini lanes stay separate" against whatever the machine happened to have:
// it passed where the owner had registered three accounts, and failed in every
// fresh checkout and detached worktree, where the roster is empty and there
// are no reserved lanes to separate. That is a test passing because a
// gitignored file happened to exist. Declaring the configuration makes the
// assertions mean the same thing on every checkout, and lets the empty-roster
// case below be tested on purpose instead of encountered by accident.
//
// Whether a CONFIGURED lane actually matches the account its provider would
// use stays covered by tests/controller/gemini-account-lane-binding.js, which
// is the test that exists for that drift and still reads the live config.
const DEFAULT_ALIAS = 'acct-default';
const DUO_ALIAS = 'acct-duo';
const VERTEX_SEAT_ALIAS = 'acct-vertex-seat';
const VERTEX_API_ALIAS = 'acct-vertex-api';
const ACCOUNTS = Object.freeze({
  accounts: {
    [DEFAULT_ALIAS]: { email: 'default@example.test', label: 'declared default' },
    [VERTEX_SEAT_ALIAS]: { email: 'seat@example.test', label: 'declared vertex seat' },
    [VERTEX_API_ALIAS]: { email: 'api@example.test', label: 'declared vertex api' },
    [DUO_ALIAS]: { email: 'duo@example.test', label: 'declared duo' }
  },
  defaultAccount: DEFAULT_ALIAS,
  duoAccount: DUO_ALIAS,
  vertexSeatAccount: VERTEX_SEAT_ALIAS,
  vertexApiAccount: VERTEX_API_ALIAS
});

const NOW = Date.parse('2026-07-27T07:00:00.000Z');
const CANARY = 'CONTROLLER_PRIVATE_PROMPT_CANARY_44291';
const VERIFIED_AUDIT = Object.freeze({ valid: true, headSequence: 88, headHash: 'a'.repeat(64), headKeyId: 'audit-key-0001', signaturesValid: true });

// P11 wraps every coordinator.provider.* legacy call into one signed
// coordinator.audit.provider.operation event with an opaque subject -- build
// fixtures the same way the real writer does rather than hand-rolling the
// dead pre-P11 raw action shape, so this test tracks the actual wire format.
function wrapProviderEvent({ provider, outcome, durationMs, outputBytes, promptBytes, occurredAtMs }) {
  const event = coordinatorAudit.legacyEvent('coordinator.provider.complete', provider, {
    outcome, durationMs, outputBytes, promptBytes
  }, { occurredAtMs });
  return {
    action: `coordinator.audit.${event.kind}`,
    target: event.subject.opaqueId,
    details: coordinatorAudit.eventDetails(event)
  };
}

const projection = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW,
  auditVerification: VERIFIED_AUDIT,
  auditEvents: [
    { sequence: 85, timestamp: '2026-07-27T06:58:00.000Z', ...wrapProviderEvent({
      provider: 'gemini', outcome: 'success', durationMs: 2300, outputBytes: 144, promptBytes: 1024
    }) },
    { sequence: 86, timestamp: '2026-07-27T06:59:00.000Z', ...wrapProviderEvent({
      provider: 'codex', outcome: 'timeout', durationMs: 5000, outputBytes: 0
    }) },
    { sequence: 87, timestamp: '2026-07-27T06:59:30.000Z', ...wrapProviderEvent({
      provider: 'claude', outcome: 'intent', durationMs: 0, outputBytes: 0
    }) },
    { sequence: 88, timestamp: '2026-07-27T06:59:45.000Z', action: 'chrome_web_store.publisher_identity_verified', target: 'configured-cws-login', details: {
      accountAlias: 'configured_cws_login', state: 'dashboard_reached', identityVerified: true, privateEmail: CANARY
    } }
  ],
  runs: [
    { status: 'running', updatedAt: '2026-07-27T06:59:50.000Z', title: CANARY, taskId: 'private-task-id' },
    { status: 'succeeded', updatedAt: '2026-07-27T06:58:40.000Z', title: CANARY }
  ],
  lifecycle: { running: true, detail: CANARY },
  providerCache: { providers: [
    { id: 'codex', enabled: true, status: 'ready', verifiedAt: '2026-07-27T06:55:00.000Z' },
    { id: 'claude', enabled: false, status: 'disabled' },
    { id: 'gemini', enabled: true, status: 'ready', configuredAccountAlias: DEFAULT_ALIAS }
  ] },
  defaultGoogleAlias: DEFAULT_ALIAS,
  focus: 'toolsenabled'
});

assert.equal(projection.schemaVersion, 'controller-projection-v1');
assert.equal(projection.contentTrust, 'untrusted');
assert.equal(projection.grantsAuthority, false);
assert.equal(projection.source.audit, 'verified');
assert.equal(projection.source.subscriptionUsage, 'unavailable-no-durable-meter');
assert.equal(projection.source.meters, 'unavailable-no-durable-meter');
assert.equal(projection.metrics.providerMeters.find(item => item.provider === 'gemini').completedCount, 1);
assert.equal(projection.metrics.providerMeters.find(item => item.provider === 'codex').timeoutCount, 1);
// An intent record is not a completed operation, so it must not be counted --
// but "not counted" is NOT the same claim as "this provider performed zero
// operations". Nothing in this window measured Claude at all, so every activity
// column reads unavailable with a stated reason. Rendering that as a confident
// `0` is exactly the defect this asserts against: the owner read an
// uninstrumented provider's zero as a real zero.
const claudeMeter = projection.metrics.providerMeters.find(item => item.provider === 'claude');
assert.equal(claudeMeter.operationCount, null,
  'intent audit records are not counted, and an unmeasured provider reads unavailable rather than zero');
assert.equal(claudeMeter.operationMeterState, 'not-instrumented');
assert.equal(claudeMeter.operationUnavailableReason, 'no-instrumented-source-in-window');
assert.equal(claudeMeter.completedCount, null);
assert.equal(claudeMeter.durationMs, null);
assert.equal(claudeMeter.outputBytes, null);
assert.equal(claudeMeter.durationMeterState, 'not-instrumented');
assert.equal(claudeMeter.outputBytesMeterState, 'not-instrumented');
// A provider the ledger DID observe keeps real numbers with a stated source,
// including a genuine zero: Codex timed out here, so it completed nothing, and
// that zero is measured rather than assumed.
const codexMeter = projection.metrics.providerMeters.find(item => item.provider === 'codex');
assert.equal(codexMeter.operationMeterState, 'ledger-lifecycle');
assert.equal(codexMeter.operationUnavailableReason, null);
assert.equal(codexMeter.completedCount, 0, 'a measured zero stays a zero and is never converted to unavailable');
assert.equal(codexMeter.durationMs, 5000);
assert.equal(codexMeter.durationMeterState, 'ledger-lifecycle');
assert.equal(projection.metrics.providerMeters.every(item => item.reportedTokenCount === null && item.costMicros === null), true);
assert.equal(projection.metrics.waste.retryOrFailureCount, 1);
assert.deepEqual(
  projection.metrics.accountLanes.map(item => `${item.accountAlias}\0${item.lane}`),
  [`${DEFAULT_ALIAS}\0subscription-cli`, `${VERTEX_SEAT_ALIAS}\0vertex`, `${VERTEX_API_ALIAS}\0api`, `${DUO_ALIAS}\0unattributed`],
  'the three Gemini lanes remain separate before any signed meter evidence exists'
);
for (const lane of projection.metrics.accountLanes) {
  assert.equal(lane.meterState, 'unavailable');
  assert.equal(lane.evidenceCount, 0);
  assert.equal(lane.operationCount, 0);
  assert.equal(lane.window.freshness, 'unavailable');
}
assert.equal(projection.controls.providers.find(item => item.provider === 'gemini').accountAlias, DEFAULT_ALIAS);
assert.equal(projection.controls.focus.selected, 'toolsenabled');
assert.deepEqual(projection.controls.focus.options.map(option => option.id), ['all', 'toolsenabled']);
assert.deepEqual(projection.controls.identity, {
  requiredAccountAlias: DEFAULT_ALIAS, selector: 'fixed-configured-account', requiresPreflight: true,
  state: 'verified', verifiedAt: '2026-07-27T06:59:45.000Z'
});
assert.equal(projection.controls.providers.find(item => item.provider === 'codex').status, 'ready',
  'the controller may retain the exact saved check state but never treats it as a live provider probe');
const cachedControlProjection = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW,
  auditVerification: VERIFIED_AUDIT,
  providerCache: { providers: [{ id: 'gemini', enabled: false, status: 'ready' }] },
  defaultGoogleAlias: DEFAULT_ALIAS
});
const cachedGeminiControl = cachedControlProjection.controls.providers.find(item => item.provider === 'gemini');
assert.equal(cachedGeminiControl.enabled, false, 'the false value remains only the saved control intent');
assert.equal(cachedGeminiControl.status, 'ready',
  'a cached check is preserved rather than being rewritten to a false availability verdict');
const absentCodexControl = cachedControlProjection.controls.providers.find(item => item.provider === 'codex');
assert.equal(absentCodexControl.enabled, false, 'a missing cache row keeps the safe saved-control default');
assert.equal(absentCodexControl.status, 'unverified',
  'a missing cache row is unknown live availability, not a fabricated disabled result');
assert.equal(projection.snapshot.agents.some(item => item.alias === 'worker' && item.state === 'working'), true);
assert.equal(projection.snapshot.tasks.length, 2);

// A durable `uncertain` run is terminal, not a currently-working
// task.  The owner needs a mechanically distinct report for a deliberate
// bounded help handoff versus a lease-expired unknown versus a true failure;
// none of those categories may expose run ids, objective text, or messages.
const runOutcomeProjection = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW,
  auditVerification: VERIFIED_AUDIT,
  runs: [
    { status: 'uncertain', updatedAt: '2026-07-27T06:59:50.000Z', error: { code: 'HELP_REQUIRED', message: CANARY } },
    { status: 'uncertain', updatedAt: '2026-07-27T06:59:40.000Z', error: { code: 'TASK_LEASE_EXPIRED', message: CANARY } },
    { status: 'failed', updatedAt: '2026-07-27T06:59:30.000Z', error: { code: 'PROVIDER_FAILED', message: CANARY } },
    { status: 'cancelled', updatedAt: '2026-07-27T06:59:20.000Z' },
    { status: 'succeeded', updatedAt: '2026-07-27T06:59:10.000Z' },
    { status: 'running', updatedAt: '2026-07-27T06:59:00.000Z' }
  ]
});
assert.deepEqual(runOutcomeProjection.metrics.durableRunOutcomes, {
  source: 'durable-run-lifecycle', total: 6, active: 1, completed: 1,
  failed: 1, cancelled: 1, needsHelp: 1, outcomeUnknown: 1
});
assert.equal(runOutcomeProjection.snapshot.agents.find(item => item.alias === 'worker').state, 'working');
assert.equal(runOutcomeProjection.snapshot.tasks.filter(item => item.state === 'rejected').length, 1,
  'a durable failed run maps to the browser contract\'s terminal non-success state, not generic blocked');
assert.equal(runOutcomeProjection.snapshot.edges.filter(item => item.edgeType === 'works_on').length, 1,
  'only an actually active run produces a current work edge');
const stoppedRunProjection = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW, auditVerification: VERIFIED_AUDIT,
  runs: [{ status: 'uncertain', updatedAt: '2026-07-27T06:59:50.000Z', error: { code: 'HELP_REQUIRED', message: CANARY } }]
});
assert.equal(stoppedRunProjection.snapshot.agents.find(item => item.alias === 'worker').state, 'idle',
  'a help-required terminal run must not leave the worker visibly working');
assert.equal(stoppedRunProjection.snapshot.edges.some(item => item.edgeType === 'works_on'), false,
  'a help-required terminal run must not leave a dangling work edge');

// A projection kept briefly while its next signed-audit read is in flight is
// useful context, but it is not live.  Its values stay traceable to the
// verified head while every browser-facing freshness field switches to stale.
const stale = staleProjection(projection);
assert.notEqual(stale, projection, 'stale labelling returns a new projection rather than mutating the cached fresh object');
assert.equal(stale.source.audit, 'verified');
assert.deepEqual(stale.source.provenance, projection.source.provenance);
assert.equal(stale.source.freshness, 'stale');
assert.equal(stale.snapshot.freshness, 'stale');
assert.equal(stale.snapshot.evidence[0].freshness, 'stale');
assert.equal(stale.snapshot.reports[0].freshness, 'stale');
assert.equal(projection.source.freshness, 'fresh', 'the cached fresh projection remains intact for a successful refresh');
contracts.validateBrowserSafeSnapshot(stale.snapshot);

contracts.validateBrowserSafeSnapshot(projection.snapshot);
contracts.validateBrowserSafeHistory(projection.history);

const serialized = JSON.stringify(projection);
assert.doesNotMatch(serialized, new RegExp(CANARY));
assert.doesNotMatch(serialized, /private-task-id|promptBytes|taskId|outputText|providerToken/i);
assert.doesNotMatch(serialized, /@|[A-Za-z]:\\/,
  'browser projection may contain controlled aliases but never account emails or filesystem paths');

const meteredRecord = {
  schemaVersion: 1, meterId: `mtr_${'M'.repeat(16)}`, auditSequence: 90, auditEventHash: '9'.repeat(64), taskRef: 'task.release-01', phaseRef: 'phase.review-01', configurationHash: '8'.repeat(64),
  provider: 'gemini', accountAlias: DEFAULT_ALIAS, lane: 'subscription-cli', modelAlias: 'gemini-cli', sourceType: 'provider-reported', tokenizerVersion: null, unavailableReason: null, requestClass: 'review',
  window: { startedAt: '2026-07-27T06:59:00.000Z', endedAt: '2026-07-27T07:00:00.000Z', freshness: 'fresh', completeness: 'complete' },
  units: { reportedTokens: 321, deterministicTokens: null, billableUnits: 7, costMicros: 654 }, elapsedMs: 60_000, queueMs: 0, idleMs: 0,
  retry: false, replay: false, cacheReuse: false, reviewVerdict: 'approved', terminalStatus: 'success', wasteReason: 'none'
};
const metered = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW, auditVerification: { ...VERIFIED_AUDIT, headSequence: 91 }, defaultGoogleAlias: DEFAULT_ALIAS,
  auditEvents: [{ sequence: 91, action: 'controller.meter.record', target: meteredRecord.meterId, details: { schemaVersion: 1, record: meteredRecord } }]
});
assert.equal(metered.source.meters, 'verified-durable');
assert.equal(metered.source.subscriptionUsage, 'provider-reported');
assert.equal(metered.metrics.providerMeters.find(item => item.provider === 'gemini').reportedTokenCount, 321);
assert.equal(metered.metrics.providerMeters.find(item => item.provider === 'gemini').costMicros, 654);
assert.equal(metered.metrics.providerMeters.find(item => item.provider === 'gemini').operationCount, 1);
assert.equal(metered.metrics.providerMeters.find(item => item.provider === 'gemini').completedCount, 1);
assert.equal(metered.metrics.costAttribution.totals.costMicros, null,
  'a provider amount on one lane cannot become an all-lane spend total while other required lanes are unobserved');
assert.equal(metered.metrics.costAttribution.totals.costState, 'UNKNOWN');
assert.deepEqual(
  metered.metrics.costAttribution.items.map(item => ({ provider: item.provider, costMicros: item.costMicros, costState: item.costState, reviewVerdict: item.reviewVerdict })),
  [{ provider: 'gemini', costMicros: 654, costState: 'observed', reviewVerdict: 'approved' }],
  'the projection carries a redacted per-item spend-versus-verdict view from the signed meter record'
);
assert.doesNotMatch(JSON.stringify(metered.metrics.costAttribution), /task\.release|phase\.review|gemini-cli/i,
  'cost attribution must not expose task/phase/model content');
assert.deepEqual(metered.metrics.accountLanes.find(item => item.accountAlias === DEFAULT_ALIAS && item.lane === 'subscription-cli'), {
  accountAlias: DEFAULT_ALIAS, lane: 'subscription-cli', meterState: 'complete', evidenceCount: 1, sourceQuality: 'provider-reported', operationCount: 1,
  reportedTokenCount: 321, deterministicPacketTokenCount: null, billableUnits: 7, costMicros: 654,
  window: { startedAt: '2026-07-27T06:59:00.000Z', endedAt: '2026-07-27T07:00:00.000Z', freshness: 'fresh', completeness: 'complete' }
});

const vertexSeatRecord = {
  ...meteredRecord,
  meterId: `mtr_${'V'.repeat(16)}`, auditSequence: 92, auditEventHash: 'b'.repeat(64),
  accountAlias: VERTEX_SEAT_ALIAS, lane: 'vertex', modelAlias: 'gemini-vertex-seat',
  units: { reportedTokens: 222, deterministicTokens: null, billableUnits: 5, costMicros: null }
};
const vertexCreditRecord = {
  ...meteredRecord,
  meterId: `mtr_${'A'.repeat(16)}`, auditSequence: 93, auditEventHash: 'c'.repeat(64),
  accountAlias: VERTEX_API_ALIAS, lane: 'api', modelAlias: 'gemini-vertex-api',
  units: { reportedTokens: 444, deterministicTokens: null, billableUnits: 11, costMicros: 987 }
};
const threeGeminiLaneProjection = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW, auditVerification: { ...VERIFIED_AUDIT, headSequence: 93 },
  auditEvents: [
    { sequence: 91, action: 'controller.meter.record', target: meteredRecord.meterId, details: { schemaVersion: 1, record: meteredRecord } },
    { sequence: 92, action: 'controller.meter.record', target: vertexSeatRecord.meterId, details: { schemaVersion: 1, record: vertexSeatRecord } },
    { sequence: 93, action: 'controller.meter.record', target: vertexCreditRecord.meterId, details: { schemaVersion: 1, record: vertexCreditRecord } }
  ]
});
assert.deepEqual(
  threeGeminiLaneProjection.metrics.accountLanes
    .filter(item => (item.accountAlias === DEFAULT_ALIAS && item.lane === 'subscription-cli') ||
      (item.accountAlias === VERTEX_SEAT_ALIAS && item.lane === 'vertex') ||
      (item.accountAlias === VERTEX_API_ALIAS && item.lane === 'api'))
    .map(item => [item.accountAlias, item.lane, item.operationCount, item.reportedTokenCount, item.costMicros]),
  [
    [DEFAULT_ALIAS, 'subscription-cli', 1, 321, 654],
    [VERTEX_SEAT_ALIAS, 'vertex', 1, 222, null],
    [VERTEX_API_ALIAS, 'api', 1, 444, 987]
  ],
  'subscription CLI, Vertex seat, and Vertex/API-credit evidence are never merged'
);

const completeVertexSeatCostRecord = {
  ...vertexSeatRecord,
  meterId: `mtr_${'W'.repeat(16)}`, auditSequence: 94, auditEventHash: 'd'.repeat(64),
  units: { reportedTokens: 222, deterministicTokens: null, billableUnits: 5, costMicros: 800 }
};
const completeVertexCreditCostRecord = {
  ...vertexCreditRecord,
  meterId: `mtr_${'X'.repeat(16)}`, auditSequence: 95, auditEventHash: 'e'.repeat(64),
  units: { reportedTokens: 444, deterministicTokens: null, billableUnits: 11, costMicros: 987 }
};
const malformedCostRecord = { ...meteredRecord, meterId: `mtr_${'Y'.repeat(16)}`, auditSequence: 96, auditEventHash: 'f'.repeat(64) };
delete malformedCostRecord.taskRef;
const partialCostProjection = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW, auditVerification: { ...VERIFIED_AUDIT, headSequence: 96 },
  auditEvents: [
    { sequence: 91, action: 'controller.meter.record', target: meteredRecord.meterId, details: { schemaVersion: 1, record: meteredRecord } },
    { sequence: 94, action: 'controller.meter.record', target: completeVertexSeatCostRecord.meterId, details: { schemaVersion: 1, record: completeVertexSeatCostRecord } },
    { sequence: 95, action: 'controller.meter.record', target: completeVertexCreditCostRecord.meterId, details: { schemaVersion: 1, record: completeVertexCreditCostRecord } },
    { sequence: 96, action: 'controller.meter.record', target: malformedCostRecord.meterId, details: { schemaVersion: 1, record: malformedCostRecord } }
  ]
});
assert.equal(partialCostProjection.source.meters, 'partial-durable-meter');
assert.equal(partialCostProjection.metrics.costAttribution.totals.costMicros, null,
  'a skipped meter record must keep an otherwise fully-priced cross-lane total UNKNOWN');
assert.equal(partialCostProjection.metrics.costAttribution.totals.costState, 'UNKNOWN');
assert.equal(partialCostProjection.metrics.costAttribution.totals.unavailableReason, 'partial-durable-meter');

const matchedCandidateInput = {
  ...meteredRecord,
  meterId: `mtr_${'N'.repeat(16)}`, auditSequence: 92, auditEventHash: 'c'.repeat(64),
  units: { reportedTokens: 100, deterministicTokens: null, billableUnits: 3, costMicros: 200 }
};
// Same declared roster the projections above are given: these two records
// carry DEFAULT_ALIAS, which is a registered account only in the declared
// configuration, never on the machine running the test.
const DECLARED_ROSTER = meterContract.accountRosterFor(ACCOUNTS.accounts);
const matchedBaseline = meterContract.normalizeRecord(meteredRecord, { accountRoster: DECLARED_ROSTER });
const matchedCandidate = meterContract.normalizeRecord(matchedCandidateInput, { accountRoster: DECLARED_ROSTER });
const matchedPair = {
  schemaVersion: 1, pairId: `sav_${'Q'.repeat(16)}`, taskClass: 'review',
  baselineMeterId: matchedBaseline.meterId, candidateMeterId: matchedCandidate.meterId,
  baselineRecordHash: matchedBaseline.recordHash, candidateRecordHash: matchedCandidate.recordHash,
  attribution: 'evidence-compression', protocolHash: 'd'.repeat(64), validationRef: 'projection-check-01',
  nonOverlapping: true,
  window: { startedAt: '2026-07-27T06:58:00.000Z', endedAt: '2026-07-27T07:01:00.000Z', freshness: 'fresh', completeness: 'complete' }
};
const matchedProjection = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW, auditVerification: { ...VERIFIED_AUDIT, headSequence: 93 }, defaultGoogleAlias: DEFAULT_ALIAS,
  auditEvents: [
    { sequence: 91, action: 'controller.meter.record', target: matchedBaseline.meterId, details: { schemaVersion: 1, record: meteredRecord } },
    { sequence: 92, action: 'controller.meter.record', target: matchedCandidate.meterId, details: { schemaVersion: 1, record: matchedCandidateInput } },
    { sequence: 93, action: savingsContract.ACTION, target: matchedPair.pairId, details: { schemaVersion: 1, pair: matchedPair } }
  ]
});
assert.equal(matchedProjection.source.savings, 'verified-matched-baseline');
assert.equal(matchedProjection.metrics.actualSavings.state, 'verified-matched-baseline');
assert.equal(matchedProjection.metrics.actualSavings.tokenCount, 221);
assert.equal(matchedProjection.metrics.actualSavings.costMicros, 454);
assert.equal(matchedProjection.metrics.actualSavings.pairCount, 1);

const localMeteredRecord = {
  ...meteredRecord,
  meterId: `mtr_${'L'.repeat(16)}`, auditSequence: 92, auditEventHash: 'a'.repeat(64),
  taskRef: 'task.local-01', phaseRef: 'phase.local.0', configurationHash: 'b'.repeat(64),
  provider: 'local', accountAlias: 'unattributed', lane: 'local', modelAlias: 'llama3.2-local',
  units: { reportedTokens: 55, deterministicTokens: null, billableUnits: null, costMicros: null }
};
const localMetered = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW, auditVerification: { ...VERIFIED_AUDIT, headSequence: 93 }, defaultGoogleAlias: DEFAULT_ALIAS,
  auditEvents: [{ sequence: 93, action: 'controller.meter.record', target: localMeteredRecord.meterId, details: { schemaVersion: 1, record: localMeteredRecord } }]
});
assert.equal(localMetered.metrics.providerMeters.find(item => item.provider === 'local').reportedTokenCount, 55);
assert.equal(localMetered.metrics.providerMeters.find(item => item.provider === 'local').operationCount, 1);
assert.deepEqual(localMetered.metrics.accountLanes.find(item => item.accountAlias === 'unattributed'), {
  accountAlias: 'unattributed', lane: 'local', meterState: 'complete', evidenceCount: 1, sourceQuality: 'provider-reported', operationCount: 1,
  reportedTokenCount: 55, deterministicPacketTokenCount: null, billableUnits: null, costMicros: null,
  window: { startedAt: '2026-07-27T06:59:00.000Z', endedAt: '2026-07-27T07:00:00.000Z', freshness: 'fresh', completeness: 'complete' }
});

const invalid = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW,
  auditVerification: { valid: false, reason: 'projection-divergence', headSequence: 89 },
  auditEvents: [{ sequence: 89, action: 'coordinator.provider.complete', target: 'gemini', details: { outcome: 'success', durationMs: 1 } }]
});
assert.equal(invalid.source.audit, 'invalid');
assert.equal(invalid.snapshot.evidence[0].evidenceCount, 0);
assert.notEqual(invalid.metrics.providerMeters.length, 0,
  'an invalid audit still projects the fixed provider roster before checking every row');
assert.equal(invalid.metrics.providerMeters.every(item => item.operationCount === null
  && item.operationMeterState === 'not-instrumented'
  && item.operationUnavailableReason === 'no-instrumented-source-in-window'), true,
  'an invalid audit contributes no metrics, and reports that as unmeasured rather than as a measured zero');
assert.equal(invalid.controls.identity.state, 'not-yet-verified');
assert.equal(staleProjection(invalid), invalid, 'an unverified or invalid projection must never be upgraded or relabelled as stale');
contracts.validateBrowserSafeSnapshot(invalid.snapshot);
contracts.validateBrowserSafeHistory(invalid.history);

// Production writes a controller.meter.record/tool_batch MeterRecord as a
// SECOND signed observation pointing back at an already-signed
// coordinator.audit.provider.operation event (see controller-meter-ledger.js's
// recordMeter()/assertParentAudit()). Both events land in the same bounded
// audit.tail(200) window read by buildControllerProjection() in normal
// operation. Prove the dashboard counts that single real operation once,
// not twice (regression for the double-counting bug fixed alongside this
// test: withMechanicalProviderMeters() used to add mechanical.rows on top
// of terminalProviderEvents()'s counts even when the same parent event was
// independently visible in-window).
const dedupParentSequence = 90;
const dedupParentEvent = { sequence: dedupParentSequence, timestamp: '2026-07-27T06:59:10.000Z', ...wrapProviderEvent({
  provider: 'gemini', outcome: 'success', durationMs: 2000, outputBytes: 100
}) };
const dedupMeterRecord = {
  ...meteredRecord, meterId: `mtr_${'D'.repeat(16)}`,
  auditSequence: dedupParentSequence, auditEventHash: 'e'.repeat(64),
  elapsedMs: 60_000 // deliberately different from the raw event's durationMs so a leftover double-count is unmistakable
};
const dedupProjection = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW, auditVerification: { ...VERIFIED_AUDIT, headSequence: 91 }, defaultGoogleAlias: DEFAULT_ALIAS,
  auditEvents: [
    dedupParentEvent,
    { sequence: 91, action: 'controller.meter.record', target: dedupMeterRecord.meterId, details: { schemaVersion: 1, record: dedupMeterRecord } }
  ]
});
const dedupGemini = dedupProjection.metrics.providerMeters.find(item => item.provider === 'gemini');
assert.equal(dedupGemini.operationCount, 1,
  'a meter record whose parent event is still in-window must not add a second operation count');
assert.equal(dedupGemini.completedCount, 1);
assert.equal(dedupGemini.durationMs, 2000,
  'durationMs must come from the raw terminal event only, not also from the duplicate meter record\'s elapsedMs (60000)');
// Token/cost evidence has no raw-terminal-scan equivalent, so it must NOT be
// discarded just because this record's parent operation is also in-window --
// only the count/duration fields are deduplicated, not the whole record.
assert.equal(dedupGemini.measuredEvidenceCount, 1, 'the meter record\'s evidence is still counted, just not its operation count');
assert.equal(dedupGemini.reportedTokenCount, meteredRecord.units.reportedTokens);
assert.equal(dedupGemini.costMicros, meteredRecord.units.costMicros);
// accountLanes intentionally reports durable-evidence coverage, a distinct
// concept from providerMeters' operation count, and is unaffected by dedup.
assert.equal(dedupProjection.metrics.accountLanes.find(item => item.accountAlias === DEFAULT_ALIAS && item.lane === 'subscription-cli').evidenceCount, 1);

// --- locally-recorded CLI usage reaches the meter (Defect 2) ----------------
//
// Claude Code and Codex CLI never touch the durable-run broker, so the broker
// -- the only writer of metered provider operations -- never sees them and both
// lanes read `not-instrumented` above. cli-session-usage-ingest.js signs a
// content-free observation of what those CLIs officially recorded locally;
// these cases prove the projection picks it up, keeps its provenance separate
// from a broker-lifecycle figure, and never double counts.
function cliUsageEvent({ sequence, provider, observationId, operationCount, reportedTokens, durationMs, brokerExcluded = true, coverage = 'complete' }) {
  return {
    sequence, timestamp: '2026-07-27T06:59:00.000Z',
    action: cliSessionUsage.CLI_SESSION_USAGE_ACTION, target: provider,
    details: {
      schemaVersion: 1, provider, observationId, sourceKind: 'local-session-record',
      brokerExcluded, coverage, operationCount, reportedTokens, durationMs, outputBytes: null,
      transcriptCount: 1, window: { startedAt: '2026-07-27T06:00:00.000Z', endedAt: '2026-07-27T06:59:00.000Z' }
    }
  };
}

const ingested = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW, auditVerification: { ...VERIFIED_AUDIT, headSequence: 96 }, defaultGoogleAlias: DEFAULT_ALIAS,
  auditEvents: [
    cliUsageEvent({ sequence: 94, provider: 'claude', observationId: `obs_${'A'.repeat(24)}`, operationCount: 1150, reportedTokens: 640837859, durationMs: null }),
    // Re-ingesting an already-credited byte range (cursor write failed after the
    // ledger write) repeats the same observationId and must contribute nothing.
    cliUsageEvent({ sequence: 95, provider: 'claude', observationId: `obs_${'A'.repeat(24)}`, operationCount: 1150, reportedTokens: 640837859, durationMs: null }),
    cliUsageEvent({ sequence: 96, provider: 'codex', observationId: `obs_${'B'.repeat(24)}`, operationCount: 97, reportedTokens: 13163589, durationMs: 459416, brokerExcluded: false })
  ]
});
const ingestedClaude = ingested.metrics.providerMeters.find(item => item.provider === 'claude');
assert.equal(ingestedClaude.operationCount, 1150, 'a repeated observationId must not double count the same byte range');
assert.equal(ingestedClaude.completedCount, 1150);
assert.equal(ingestedClaude.reportedTokenCount, 640837859);
assert.equal(ingestedClaude.operationMeterState, 'local-session-record');
assert.equal(ingestedClaude.tokenMeterState, 'local-session-record',
  'a figure read back out of a local CLI record is a different provenance from one an API returned to this process');
// Claude Code records no per-call latency and no output byte count, so those
// columns stay unavailable WITH A REASON even though the provider is measured.
// Deriving either from the transcript's size would be the exact fabrication
// this whole contract exists to prevent.
assert.equal(ingestedClaude.durationMs, null);
assert.equal(ingestedClaude.durationMeterState, 'not-instrumented');
assert.equal(ingestedClaude.durationUnavailableReason, 'source-records-no-duration');
assert.equal(ingestedClaude.outputBytes, null);
assert.equal(ingestedClaude.outputBytesUnavailableReason, 'source-records-no-output-bytes');
assert.equal(ingestedClaude.costMicros, null, 'neither CLI records a cost, so cost stays unavailable forever');
const ingestedCodex = ingested.metrics.providerMeters.find(item => item.provider === 'codex');
assert.equal(ingestedCodex.operationCount, 97);
assert.equal(ingestedCodex.durationMs, 459416, 'Codex does record its own turn wall time, so that column is real');
assert.equal(ingestedCodex.durationMeterState, 'local-session-record');
// Gemini is untouched by any of this and must stay honestly unmeasured.
const ingestedGemini = ingested.metrics.providerMeters.find(item => item.provider === 'gemini');
assert.equal(ingestedGemini.operationCount, null);
assert.equal(ingestedGemini.operationMeterState, 'not-instrumented');

// Two measurement sources that cannot be proven disjoint are never added. A
// broker-launched Codex run would appear in BOTH the lifecycle ledger and the
// rollout files, and the rollout format carries no discriminator to exclude it,
// so the honest result is unavailable-with-a-reason rather than a sum that may
// count one real API call twice.
const overlapping = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW, auditVerification: { ...VERIFIED_AUDIT, headSequence: 98 }, defaultGoogleAlias: DEFAULT_ALIAS,
  auditEvents: [
    { sequence: 97, timestamp: '2026-07-27T06:58:00.000Z', ...wrapProviderEvent({ provider: 'codex', outcome: 'success', durationMs: 1000, outputBytes: 10 }) },
    cliUsageEvent({ sequence: 98, provider: 'codex', observationId: `obs_${'C'.repeat(24)}`, operationCount: 5, reportedTokens: 500, durationMs: 900, brokerExcluded: false })
  ]
});
const overlappingCodex = overlapping.metrics.providerMeters.find(item => item.provider === 'codex');
assert.equal(overlappingCodex.operationCount, null);
assert.equal(overlappingCodex.operationUnavailableReason, 'overlapping-measurement-sources');
assert.equal(overlappingCodex.reportedTokenCount, null);
assert.equal(overlappingCodex.tokenMeterState, 'unavailable');

// Claude's ingest CAN prove disjointness (it excludes the `sdk-cli` entrypoint
// the broker produces), so the two sources are added and the mixed provenance
// is stated rather than hidden behind one source label.
const mixed = buildControllerProjection({
  accounts: ACCOUNTS,
  nowMs: NOW, auditVerification: { ...VERIFIED_AUDIT, headSequence: 100 }, defaultGoogleAlias: DEFAULT_ALIAS,
  auditEvents: [
    { sequence: 99, timestamp: '2026-07-27T06:58:00.000Z', ...wrapProviderEvent({ provider: 'claude', outcome: 'success', durationMs: 1000, outputBytes: 10 }) },
    cliUsageEvent({ sequence: 100, provider: 'claude', observationId: `obs_${'D'.repeat(24)}`, operationCount: 5, reportedTokens: 500, durationMs: null })
  ]
});
const mixedClaude = mixed.metrics.providerMeters.find(item => item.provider === 'claude');
assert.equal(mixedClaude.operationCount, 6);
assert.equal(mixedClaude.operationMeterState, 'partial-mixed-source');
assert.equal(mixedClaude.durationMs, 1000, 'only the lifecycle source recorded duration, so only it contributes');
assert.equal(mixedClaude.durationMeterState, 'ledger-lifecycle');

// Nothing about an ingested observation may carry a path, a session id, or any
// message content into the browser projection.
const ingestedSerialized = JSON.stringify(ingested);
assert.doesNotMatch(ingestedSerialized, /@|[A-Za-z]:\\|\.jsonl|rollout-|requestId/i,
  'ingested CLI usage must never carry filesystem paths, transcript names, or request identifiers into the projection');

assert.equal(path.isAbsolute(generator.VISUALIZER_ROOT), true, 'the declared consumer root remains absolute');
assert.equal(path.dirname(generatedJavascript), generatedDirectory,
  'this test loads the generated consumer from its isolated fixture, not a sibling checkout');
console.log('Controller projection tests passed (redaction, invalid-audit fail-closed behavior, and meter truthfulness).');

// --- ABSENCE CASE: an installation that has registered no Google account ----
// This is a real state (a fresh install before the first
// tools/google-oauth-login.js run), and it is the state EVERY fresh checkout
// and detached worktree is in, because config/google-accounts.profile.json is
// gitignored. It must project honestly: no reserved account lanes to show,
// 'unattributed' as the required identity, and no lane invented for an account
// nobody registered.
const noAccounts = buildControllerProjection({
  accounts: {},
  nowMs: NOW, auditVerification: VERIFIED_AUDIT, auditEvents: []
});
assert.deepEqual(noAccounts.metrics.accountLanes, [],
  'an installation with no registered accounts reserves no account lanes rather than naming nobody');
assert.equal(noAccounts.controls.identity.requiredAccountAlias, 'unattributed');
assert.equal(noAccounts.controls.providers.find(item => item.provider === 'gemini').accountAlias, 'unattributed');
// A record naming an account nobody registered is not silently accepted into
// the empty-roster projection: it is skipped and COUNTED, so the dashboard
// reports a partial read instead of a confident wrong one.
const unregisteredRecordProjection = buildControllerProjection({
  accounts: {},
  nowMs: NOW, auditVerification: { ...VERIFIED_AUDIT, headSequence: 91 },
  auditEvents: [{ sequence: 91, action: 'controller.meter.record', target: meteredRecord.meterId, details: { schemaVersion: 1, record: meteredRecord } }]
});
assert.equal(unregisteredRecordProjection.source.metersSkippedCount, 1);
assert.equal(unregisteredRecordProjection.metrics.accountLanes.length, 0);
// Absence is never consent: `accounts` present but not an object is a caller
// error, not a request to assume an empty roster.
for (const bogus of ['acct-default', 42, true]) {
  assert.throws(() => buildControllerProjection({ accounts: bogus }), TypeError,
    'a declared account configuration that is not an object must fail loudly');
}
console.log('Controller projection account-roster tests passed (declared configuration, honest empty-roster projection).');
