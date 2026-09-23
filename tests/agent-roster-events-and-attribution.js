// EXECUTABLE CHANGE
//
// CAN-FAIL AUDIT (2026-08-26)
// - Strengthened eventId projection with an independently precomputed SHA-256
//   oracle. Mutation: computeEventId prefixed its hash input with "MUTATED|".
//   Before this change the suite stayed green: "agent-roster events + attribution:
//   43 checks passed". After strengthening it went RED:
//   "AssertionError [ERR_ASSERTION]: eventId must be the independently known
//   sha256(kind|laneId|attempt|at) for this fixture".
// - Strengthened the RULE_IDS iteration precondition. Mutation: ruleTable()
//   cleared the exported RULE_IDS Set before returning. RED output:
//   "AssertionError [ERR_ASSERTION]: ruleTable coverage requires a non-empty
//   independently exported rule-id set".
// - Restored both mutated product files byte-for-byte; the final green run was:
//   "agent-roster events + attribution: 43 checks passed".
// - NOT-FOUND: exit-status/truthy-return-only evidence; swallowed failures in
//   try/catch or optional chains; mocks of the subject; same-code expected values
//   beyond eventId; empty-capable assertion loops beyond RULE_IDS.
// - PRECONDITION-NOT-MET: state/fleet-supervisor.json is absent, so the optional
//   live-history replay cannot execute on this checkout; deterministic fixture
//   coverage remains active and the skip is printed rather than silent.

'use strict';

// R103 agent roster: events store + attribution classifier.
//
// Everything here runs against fixtures modeled byte-for-byte on REAL records
// observed in state/fleet-supervisor.json (232 lanes at test-writing time) and
// the markVerified history entry shape (supervisor.js:522-540). The final
// block additionally replays the LIVE state file when present, asserting
// INVARIANTS (not counts -- the file grows continuously): no FVPM lane may
// ever classify agent-attributable (ledger gate 2), and no projected event may
// carry billing.account or any other off-whitelist field (ledger gate 1).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const attribution = require('../src/lib/fleet-supervisor/roster/attribution.js');
const events = require('../src/lib/fleet-supervisor/roster/events.js');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;

function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok: ${label}`);
}

const CANARIES = Object.freeze([
  'CANARY_SELF_REPORT_the_agent_says_it_did_great',
  'canary-account@example.com',
  'CANARY_CLAIMED_TESTS_PASS'
]);

// A lane fixture mirroring the observed rich-record shape (q17-ms5c94s7mlg2)
// with agent-self-report canaries INJECTED at every level; the projection must
// leave every one of them behind.
function richLane(overrides = {}) {
  return {
    laneId: 'q17-testlane0001',
    itemId: 'Q17',
    attempt: 1,
    status: 'succeeded',
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    backend: 'vertex',
    supervisorId: 'sup-test-0001',
    supervisorPid: 11111,
    pid: 22222,
    worktree: 'C:\\somewhere\\lane',
    startedAt: '2026-07-29T01:00:00.000Z',
    endedAt: '2026-07-29T01:02:14.479Z',
    changedFileCount: 3,
    snapshot: { complete: true, patchBytes: 12345 },
    billing: {
      backend: 'vertex',
      account: CANARIES[1], // personal data: must NEVER reach an event
      project: 'example-vertex-project'
    },
    outcome: {
      processExitOk: true,
      ok: true,
      code: null,
      transient: false,
      reportedModels: ['gemini-2.5-pro'],
      servedBelowFloor: [],
      reportedTokens: 4321,
      detail: null,
      durationMs: 134479,
      agentSelfAssessment: CANARIES[0] // invented self-report field
    },
    selfReport: CANARIES[0],
    claimedOutcome: CANARIES[2],
    ...overrides
  };
}

function failedLane(outcome, overrides = {}) {
  return richLane({
    status: 'failed',
    outcome: { processExitOk: false, ok: false, transient: false, detail: null, durationMs: 5292, ...outcome },
    ...overrides
  });
}

console.log('agent-roster events + attribution');

// ---------------------------------------------------------------------------
// 0. The mirrored transient regex cannot drift from the harness's own
// ---------------------------------------------------------------------------

check('TRANSIENT_DETAIL_RE is byte-identical to supervisor.js TRANSIENT_DETAIL_RE', () => {
  const supervisor = require('../src/lib/fleet-supervisor/supervisor.js');
  assert.equal(String(attribution.TRANSIENT_DETAIL_RE), String(supervisor.TRANSIENT_DETAIL_RE));
});

// ---------------------------------------------------------------------------
// 1. Attribution: every REAL failure code observed in the state file
// ---------------------------------------------------------------------------

check('R-FVPM: FLEET_VERTEX_PROJECT_MISSING -> infra-fault (gate-2 anchor)', () => {
  const result = attribution.classifyLaneOutcome(failedLane({
    code: 'FLEET_VERTEX_PROJECT_MISSING',
    detail: 'A vertex lane requires an explicit Google Cloud project id.'
  }));
  assert.deepEqual({ class: result.class, rule: result.rule, agentFailure: result.agentFailure },
    { class: 'infra-fault', rule: 'R-FVPM', agentFailure: false });
});

check('R-STALE-SNAPSHOT: DISPATCH_BLOCKED_STALE_SNAPSHOT -> environment-fault', () => {
  const result = attribution.classifyLaneOutcome(failedLane({
    code: 'DISPATCH_BLOCKED_STALE_SNAPSHOT',
    detail: 'untracked-files-not-materialized: tools/telegram-bridge-task.ps1.tmp'
  }, { snapshot: { complete: false } }));
  assert.equal(result.class, 'environment-fault');
  assert.equal(result.rule, 'R-STALE-SNAPSHOT');
});

check('R-LANE-THREW: LANE_THREW -> infra-fault', () => {
  const result = attribution.classifyLaneOutcome(failedLane({
    code: 'LANE_THREW',
    detail: 'Command failed: git worktree add ... unable to create file reports/fleet-worktree-archive/ToolsEnabled-'
  }));
  assert.deepEqual([result.class, result.rule], ['infra-fault', 'R-LANE-THREW']);
});

check('R-SPAWN-THREW: SPAWN_THREW -> infra-fault', () => {
  const result = attribution.classifyLaneOutcome(failedLane({ code: 'SPAWN_THREW', detail: 'spawn ENAMETOOLONG' }));
  assert.deepEqual([result.class, result.rule], ['infra-fault', 'R-SPAWN-THREW']);
});

check('R-TRANSIENT: harness-computed transient===true -> infra-fault, even on EXIT_NONZERO', () => {
  const result = attribution.classifyLaneOutcome(failedLane({
    code: 'EXIT_NONZERO', transient: true,
    detail: 'd Google Cloud project is experiencing high traffic and has hit its quota limits.'
  }));
  assert.deepEqual([result.class, result.rule], ['infra-fault', 'R-TRANSIENT']);
});

check('R-TRANSIENT-LEGACY: pre-transient-era EXIT_NONZERO with quota detail -> infra-fault (14 such records live)', () => {
  const lane = failedLane({
    code: 'EXIT_NONZERO',
    detail: 'd Google Cloud project is experiencing high traffic and has hit its quota limits. To get dedicated,'
  });
  delete lane.outcome.transient; // the legacy shape: outcomeKeys were [processExitOk, ok, code, detail, durationMs]
  const result = attribution.classifyLaneOutcome(lane);
  assert.deepEqual([result.class, result.rule], ['infra-fault', 'R-TRANSIENT-LEGACY']);
});

check('R-LEGACY-UNJUDGED: pre-transient-era EXIT_NONZERO with non-quota detail -> unknown, NOT agent blame, NOT an unseen code', () => {
  const lane = failedLane({ code: 'EXIT_NONZERO', detail: 'some pre-era failure text with no capacity marker' });
  delete lane.outcome.transient;
  const result = attribution.classifyLaneOutcome(lane);
  assert.deepEqual([result.class, result.rule, result.agentFailure, result.unseenCode],
    ['unknown', 'R-LEGACY-UNJUDGED', false, null]);
});

check('R-MODEL-UNAVAILABLE: the exact Gemini CLI access string -> infra-fault', () => {
  const result = attribution.classifyLaneOutcome(failedLane({
    code: 'EXIT_NONZERO', transient: false,
    detail: 'EXIT_NONZERO -3.5-flash` was not found or your project does not have access to it'
  }));
  assert.deepEqual([result.class, result.rule], ['infra-fault', 'R-MODEL-UNAVAILABLE']);
});

check('R-EXIT-AGENT: non-transient EXIT_NONZERO under a proven snapshot -> agent-attributable FAILURE', () => {
  const result = attribution.classifyLaneOutcome(failedLane({
    code: 'EXIT_NONZERO', transient: false, detail: 'lane exited 1 after failing its own build'
  }));
  assert.deepEqual([result.class, result.rule, result.agentFailure],
    ['agent-attributable', 'R-EXIT-AGENT', true]);
});

check('R-SNAPSHOT-UNPROVEN guard: same failure without a proven snapshot -> environment-fault (stale-tree-era rule)', () => {
  const noSnapshot = failedLane({ code: 'EXIT_NONZERO', transient: false, detail: 'exited 1' });
  delete noSnapshot.snapshot;
  const result = attribution.classifyLaneOutcome(noSnapshot);
  assert.deepEqual([result.class, result.rule, result.agentFailure],
    ['environment-fault', 'R-SNAPSHOT-UNPROVEN', false]);
});

check('R-TIMEOUT: TIMEOUT -> unknown (n=1; gate 3 honest-unknown)', () => {
  const result = attribution.classifyLaneOutcome(failedLane({ code: 'TIMEOUT', detail: 'lane exceeded 1200000ms' }));
  assert.deepEqual([result.class, result.rule], ['unknown', 'R-TIMEOUT']);
});

check('R-OK-PENDING: clean exit -> agent-attributable but pendingVerification (a process exit is not evidence)', () => {
  const result = attribution.classifyLaneOutcome(richLane());
  assert.deepEqual([result.class, result.rule, result.pendingVerification, result.agentFailure],
    ['agent-attributable', 'R-OK-PENDING', true, false]);
});

check('R-UNOBSERVED: status unknown -> unknown (supervisor died first)', () => {
  const result = attribution.classifyLaneOutcome({
    laneId: 'q17-ms5ao8cgdpfx', itemId: 'Q17', attempt: 1, status: 'unknown',
    unknownReason: 'supervisor-exited-before-outcome-was-observed', outcome: null
  });
  assert.deepEqual([result.class, result.rule], ['unknown', 'R-UNOBSERVED']);
});

check('R-SPARSE: bare {status:failed} record -> unknown', () => {
  const result = attribution.classifyLaneOutcome({ status: 'failed' });
  assert.deepEqual([result.class, result.rule], ['unknown', 'R-SPARSE']);
});

check('R-DRYRUN: DRY_RUN -> null (no event at all)', () => {
  assert.equal(attribution.classifyLaneOutcome(failedLane({ code: 'DRY_RUN' })), null);
});

check('R-UNSEEN: a code this table has never seen -> unknown with the code recorded VERBATIM, never a guess', () => {
  const result = attribution.classifyLaneOutcome(failedLane({ code: 'SOME_FUTURE_FAILURE_MODE', detail: '??' }));
  assert.deepEqual([result.class, result.rule, result.unseenCode, result.agentFailure],
    ['unknown', 'R-UNSEEN', 'SOME_FUTURE_FAILURE_MODE', false]);
});

// ---------------------------------------------------------------------------
// 2. Attribution: review verdicts
// ---------------------------------------------------------------------------

check('V-BELOW-FLOOR: servedBelowFloor non-empty -> infra-fault and NEVER a success, even if the verdict text says accepted', () => {
  const result = attribution.classifyReviewVerdict({
    verdict: 'accepted', servedBelowFloor: ['gemini-3-flash-preview'], reviewState: 'below-floor'
  });
  assert.deepEqual([result.class, result.rule, result.success], ['infra-fault', 'V-BELOW-FLOOR', false]);
});

check('V-NO-ARTIFACT: the exact preserved-packet historical string -> environment-fault', () => {
  const result = attribution.classifyReviewVerdict({
    verdict: 'rejected',
    reason: 'unverifiable: the lane produced changes but no worktree or preserved packet survives; predates preserve-before-cleanup'
  });
  assert.deepEqual([result.class, result.rule, result.success], ['environment-fault', 'V-NO-ARTIFACT', null]);
});

check('V-NO-ARTIFACT: unreviewable===true alone is enough', () => {
  const result = attribution.classifyReviewVerdict({ verdict: 'rejected', unreviewable: true });
  assert.equal(result.rule, 'V-NO-ARTIFACT');
});

check('V-POLICY-BLOCKED: the exact policy-blocked string -> environment-fault', () => {
  const result = attribution.classifyReviewVerdict({
    verdict: 'rejected', reason: 'unverifiable: policy blocked Node execution for the review harness'
  });
  assert.deepEqual([result.class, result.rule], ['environment-fault', 'V-POLICY-BLOCKED']);
});

check("V-AGENT: a genuine rejection that merely BEGINS 'unverifiable:' stays agent-attributable (three-exact-strings discipline)", () => {
  const result = attribution.classifyReviewVerdict({
    verdict: 'rejected',
    reason: 'unverifiable: no real DelegatedTask exists; the real baseline is rejected because the module invents its schema'
  });
  assert.deepEqual([result.class, result.rule, result.success], ['agent-attributable', 'V-AGENT', false]);
});

check('V-AGENT: accepted -> agent-attributable success (the ONLY success in the whole system)', () => {
  const result = attribution.classifyReviewVerdict({ verdict: 'accepted', reason: null });
  assert.deepEqual([result.class, result.rule, result.success], ['agent-attributable', 'V-AGENT', true]);
});

check('V-UNSEEN: a verdict string outside the enum -> unknown, never a guess', () => {
  const result = attribution.classifyReviewVerdict({ verdict: 'meh' });
  assert.deepEqual([result.class, result.rule, result.success], ['unknown', 'V-UNSEEN', null]);
});

// ---------------------------------------------------------------------------
// 3. Attribution: parks (informational only)
// ---------------------------------------------------------------------------

check('park: code-determined lastOutcome codes classify without the lane record', () => {
  const stale = attribution.classifyParkLastOutcome({
    laneId: 'q18-ms5u42bfovxo', processExitOk: false, code: 'DISPATCH_BLOCKED_STALE_SNAPSHOT',
    changedFileCount: 0, verification: 'unverified', at: '2026-07-29T08:40:25.805Z'
  });
  assert.deepEqual([stale.class, stale.rule], ['environment-fault', 'R-STALE-SNAPSHOT']);
  const fvpm = attribution.classifyParkLastOutcome({ laneId: 'x', code: 'FLEET_VERTEX_PROJECT_MISSING' });
  assert.deepEqual([fvpm.class, fvpm.rule], ['infra-fault', 'R-FVPM']);
});

check('park: EXIT_NONZERO without the lane record -> unknown R-PARK-CODE-AMBIGUOUS (park records carry no transient/detail/snapshot)', () => {
  const result = attribution.classifyParkLastOutcome({ laneId: 'x', processExitOk: false, code: 'EXIT_NONZERO' });
  assert.deepEqual([result.class, result.rule], ['unknown', 'R-PARK-CODE-AMBIGUOUS']);
});

check('park: supplying the full lane record upgrades the ambiguous case to the exact class', () => {
  const lane = failedLane({ code: 'EXIT_NONZERO', transient: true, detail: 'quota' });
  const result = attribution.classifyParkLastOutcome({ laneId: lane.laneId, code: 'EXIT_NONZERO' }, { lane });
  assert.deepEqual([result.class, result.rule], ['infra-fault', 'R-TRANSIENT']);
});

check('park: a full lane record from a different lane refuses a definite attribution', () => {
  const lane = failedLane({ code: 'EXIT_NONZERO', transient: false, detail: 'agent failure' });
  const result = attribution.classifyParkLastOutcome(
    { laneId: 'another-lane', code: 'EXIT_NONZERO' },
    { lane }
  );
  assert.deepEqual([result.class, result.rule], ['unknown', 'R-PARK-CODE-AMBIGUOUS']);
});

check('park: a stale outcome code paired with the lane refuses a definite attribution', () => {
  const lane = failedLane({ code: 'EXIT_NONZERO', transient: false, detail: 'agent failure' });
  const result = attribution.classifyParkLastOutcome(
    { laneId: lane.laneId, code: 'FLEET_VERTEX_PROJECT_MISSING' },
    { lane }
  );
  assert.deepEqual([result.class, result.rule], ['unknown', 'R-PARK-CODE-AMBIGUOUS']);
});

// ---------------------------------------------------------------------------
// 4. GATE-2 REGRESSION: replay the FVPM park history -> ZERO agent blame
// ---------------------------------------------------------------------------

check('replaying 29 FVPM lanes + 7 FVPM-parked items produces zero agent-attributable events', () => {
  let agentAttributable = 0;
  for (let index = 0; index < 29; index += 1) {
    const lane = failedLane({
      code: 'FLEET_VERTEX_PROJECT_MISSING',
      detail: 'A vertex lane requires an explicit Google Cloud project id.'
    }, { laneId: `q20-fvpm${String(index).padStart(4, '0')}`, itemId: 'Q20' });
    const event = events.laneOutcomeEvent(lane, { source: 'backfill' });
    if (event.attribution.class === 'agent-attributable') agentAttributable += 1;
  }
  for (let index = 0; index < 7; index += 1) {
    const event = events.parkEvent({
      itemId: `Q2${index}`,
      parkedReason: 'no-progress: 2 consecutive attempts changed zero files',
      parkedAt: '2026-07-29T05:00:00.000Z',
      lastOutcome: { laneId: `q2${index}-fvpmpark`, processExitOk: false, code: 'FLEET_VERTEX_PROJECT_MISSING' }
    });
    assert.equal(event.kind, 'park');
    if (event.attribution.class === 'agent-attributable') agentAttributable += 1;
  }
  assert.equal(agentAttributable, 0, 'FVPM misconfiguration must never be recorded as agent failure');
});

// ---------------------------------------------------------------------------
// 5. Projection: hard whitelist, no self-reports, no personal data
// ---------------------------------------------------------------------------

check('laneOutcomeEvent projects ONLY harness-authored fields: every canary and billing.account left behind', () => {
  const event = events.laneOutcomeEvent(richLane(), {
    source: 'hook',
    headCommit: '6cbfcef27ac3c56bdebc532c632e8167667655b4',
    supervisorArgvHash: 'a'.repeat(64)
  });
  const serialized = JSON.stringify(event);
  for (const canary of CANARIES) {
    assert.equal(serialized.includes(canary), false, `self-report/personal canary leaked: ${canary}`);
  }
  assert.equal(serialized.includes('account'), false, 'billing.account (or any account key) must not exist in an event');
  assert.deepEqual(event.billing, { backend: 'vertex', project: 'example-vertex-project' });
  assert.deepEqual(event.config, {
    role: 'builder', provider: 'gemini', model: 'gemini-2.5-pro', backend: 'vertex', decomposed: false
  });
  assert.equal(event.env.snapshotProven, true);
  assert.equal(event.eventId, '6e5c6ea8427832f3366126ea9b53361a28662982d0f7d4d963493d4a0e2a5e16',
    'eventId must be the independently known sha256(kind|laneId|attempt|at) for this fixture');
  assert.equal(event.eventId, events.computeEventId(event));
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.outcome), true);
});

check("decomposed identity comes from the itemId '::' marker", () => {
  const event = events.laneOutcomeEvent(richLane({ itemId: 'Q20::s2-controller-integ' }));
  assert.equal(event.config.decomposed, true);
});

check('laneOutcomeEvent returns null for DRY_RUN (no event, not an unknown event)', () => {
  assert.equal(events.laneOutcomeEvent(failedLane({ code: 'DRY_RUN' })), null);
});

check('reviewVerdictEvent projects the real markVerified history entry shape', () => {
  // Copied field-for-field from a real state.history verification entry.
  const entry = {
    event: 'verification', laneId: 'q20-ms5f3dqjyhrq', itemId: 'Q20', attempt: 3,
    verdict: 'rejected', verification: 'rejected', reviewer: 'review:codex',
    rubricVersion: 2, score: 0, scoreThreshold: 0.7, evidenceVerified: null,
    unreviewable: false, provider: 'gemini', model: 'gemini-2.5-pro', backend: 'vertex',
    servedBelowFloor: [], at: '2026-07-29T01:47:56.593Z',
    agentComment: CANARIES[0] // injected: must not survive projection
  };
  const event = events.reviewVerdictEvent(entry, {
    source: 'hook', reviewState: 'complete',
    reviewReason: 'unverifiable: no real DelegatedTask exists; the real baseline is rejected'
  });
  assert.equal(event.kind, 'review-verdict');
  assert.deepEqual([event.attribution.class, event.attribution.rule], ['agent-attributable', 'V-AGENT']);
  assert.equal(event.verdict.belowFloor, false);
  assert.equal(event.verdict.reviewer, 'review:codex');
  assert.equal(event.verdict.reasonPrefix.length <= 120, true);
  assert.equal(JSON.stringify(event).includes(CANARIES[0]), false);
});

check('reviewVerdictEvent: below-floor entry classifies infra-fault', () => {
  const event = events.reviewVerdictEvent({
    laneId: 'q17-floorlane', itemId: 'Q17', attempt: 1, verdict: 'rejected',
    reviewer: 'harness:model-floor', servedBelowFloor: ['gemini-3-flash-preview'],
    unreviewable: false, at: '2026-07-29T02:00:00.000Z'
  }, { reviewState: 'below-floor' });
  assert.deepEqual([event.attribution.class, event.attribution.rule], ['infra-fault', 'V-BELOW-FLOOR']);
  assert.equal(event.verdict.belowFloor, true);
});

check('validateEvent rejects an off-whitelist field wherever it hides (the guard itself)', () => {
  const base = events.laneOutcomeEvent(richLane());
  const tampered = JSON.parse(JSON.stringify(base));
  tampered.outcome.selfAssessment = 'I did great';
  let errors = events.validateEvent(tampered);
  assert.equal(errors.some(problem => problem.includes('outcome.selfAssessment')), true, errors.join('; '));

  const withAccount = JSON.parse(JSON.stringify(base));
  withAccount.billing = { backend: 'vertex', project: 'p', account: 'x@y.z' };
  errors = events.validateEvent(withAccount);
  assert.equal(errors.some(problem => problem.includes('billing.account') && problem.includes('personal data')), true, errors.join('; '));

  const topLevel = JSON.parse(JSON.stringify(base));
  topLevel.agentNotes = 'trust me';
  errors = events.validateEvent(topLevel);
  assert.equal(errors.some(problem => problem.includes('agentNotes')), true, errors.join('; '));
});

check('validateEvent rejects eventId tampering and cross-kind section smuggling', () => {
  const base = events.laneOutcomeEvent(richLane());
  const badId = { ...JSON.parse(JSON.stringify(base)), eventId: 'f'.repeat(64) };
  assert.equal(events.validateEvent(badId).some(problem => problem.startsWith('eventId')), true);

  const smuggled = JSON.parse(JSON.stringify(base));
  smuggled.verdict = { verdict: 'accepted', reviewer: 'the-lane-itself', unreviewable: false, belowFloor: false, reasonPrefix: null, score: null, scoreThreshold: null, rubricVersion: null, evidenceVerified: null };
  assert.equal(events.validateEvent(smuggled).some(problem => problem.includes('verdict: forbidden')), true);
});

check("roster-error events are pinned to class 'unknown' / R-ROSTER-ERROR", () => {
  const event = events.rosterErrorEvent({ hookPoint: 'dispatch', message: 'x'.repeat(1000), at: '2026-07-29T03:00:00.000Z' });
  assert.deepEqual(event.attribution, { class: 'unknown', rule: 'R-ROSTER-ERROR' });
  assert.equal(event.error.message.length, 300);
  const tampered = JSON.parse(JSON.stringify(event));
  tampered.attribution = { class: 'agent-attributable', rule: 'R-EXIT-AGENT' };
  assert.equal(events.validateEvent(tampered).some(problem => problem.includes('roster-error')), true);
});

// ---------------------------------------------------------------------------
// 6. The JSONL store: round-trip, idempotency, corrupt lines SURFACED
// ---------------------------------------------------------------------------

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-roster-events-'));
const eventsFile = path.join(tempDir, 'state', 'agent-roster-events.jsonl');

try {
  check('append/read round-trip preserves events exactly', () => {
    const first = events.laneOutcomeEvent(richLane());
    const second = events.laneOutcomeEvent(failedLane({
      code: 'FLEET_VERTEX_PROJECT_MISSING',
      detail: 'A vertex lane requires an explicit Google Cloud project id.'
    }, { laneId: 'q20-otherlane', itemId: 'Q20' }));
    assert.deepEqual(events.appendEvent(eventsFile, first), { appended: true, eventId: first.eventId, reason: null });
    assert.deepEqual(events.appendEvent(eventsFile, second), { appended: true, eventId: second.eventId, reason: null });
    const loaded = events.readEvents(eventsFile);
    assert.equal(loaded.corrupt.length, 0);
    assert.deepEqual(loaded.events, [JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second))]);
  });

  check('appendEvent is idempotent by eventId -- hook/backfill overlap is safe', () => {
    const hookSide = events.laneOutcomeEvent(richLane(), { source: 'hook' });
    const backfillSide = events.laneOutcomeEvent(richLane(), { source: 'backfill' });
    assert.equal(hookSide.eventId, backfillSide.eventId, 'source must not change identity');
    const result = events.appendEvent(eventsFile, backfillSide);
    assert.deepEqual(result, { appended: false, eventId: backfillSide.eventId, reason: 'duplicate' });
    assert.equal(events.readEvents(eventsFile).events.length, 2);
  });

  check('a corrupt line is REPORTED with its line number, never silently skipped', () => {
    fs.appendFileSync(eventsFile, 'this is not JSON at all\n', 'utf8');
    fs.appendFileSync(eventsFile, `${JSON.stringify({ v: 1, kind: 'lane-outcome' })}\n`, 'utf8'); // parseable but invalid
    const third = events.rosterErrorEvent({ hookPoint: 'verdict', message: 'still readable after corruption', at: '2026-07-29T04:00:00.000Z' });
    events.appendEvent(eventsFile, third);
    const loaded = events.readEvents(eventsFile);
    assert.equal(loaded.events.length, 3, 'valid events before and after the corruption still load');
    assert.equal(loaded.corrupt.length, 2);
    assert.equal(loaded.corrupt[0].lineNumber, 3);
    assert.match(loaded.corrupt[0].error, /not JSON/);
    assert.equal(loaded.corrupt[0].linePrefix, 'this is not JSON at all');
    assert.equal(loaded.corrupt[1].lineNumber, 4);
    assert.match(loaded.corrupt[1].error, /invalid event/);
  });

  check('appendEvent refuses an invalid event outright', () => {
    assert.throws(
      () => events.appendEvent(eventsFile, { v: 1, kind: 'lane-outcome', made: 'up' }),
      error => error.code === 'ROSTER_EVENT_INVALID'
    );
  });

  check('createEventLog reports corruption at load and dedupes across appends', () => {
    const log = events.createEventLog(eventsFile);
    assert.equal(log.corruptAtLoad.length, 2);
    assert.equal(log.eventIds.size, 3);
    const duplicate = events.laneOutcomeEvent(richLane());
    assert.equal(log.append(duplicate).appended, false);
  });

  check('a missing file reads as an empty log', () => {
    const missing = events.readEvents(path.join(tempDir, 'does-not-exist.jsonl'));
    assert.deepEqual({ events: missing.events, corrupt: missing.corrupt }, { events: [], corrupt: [] });
  });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 7. Rule table export for the CLI
// ---------------------------------------------------------------------------

check('ruleTable() is serializable data covering every rule id', () => {
  const table = attribution.ruleTable();
  assert.equal(typeof JSON.stringify(table), 'string');
  const ids = new Set(table.map(row => row.id));
  assert.equal(attribution.RULE_IDS.size > 0, true,
    'ruleTable coverage requires a non-empty independently exported rule-id set');
  for (const id of attribution.RULE_IDS) assert.equal(ids.has(id), true, `missing rule row: ${id}`);
  const fvpm = table.find(row => row.id === 'R-FVPM');
  assert.equal(fvpm.class, 'infra-fault');
  const dryRun = table.find(row => row.id === 'R-DRYRUN');
  assert.equal(dryRun.class, 'no-event');
});

// ---------------------------------------------------------------------------
// 8. LIVE-HISTORY INVARIANTS (count-agnostic; skipped when the file is absent)
// ---------------------------------------------------------------------------

const liveStateFile = path.join(ROOT, 'state', 'fleet-supervisor.json');
if (fs.existsSync(liveStateFile)) {
  check('live state file: every lane classifies; no infra/environment code is ever agent-attributable; no event leaks an account', () => {
    const state = JSON.parse(fs.readFileSync(liveStateFile, 'utf8'));
    const lanes = Object.values(state.lanes || {});
    assert.equal(lanes.length > 0, true, 'expected at least one lane in the live file');
    const NEVER_AGENT = new Set([
      'FLEET_VERTEX_PROJECT_MISSING', 'DISPATCH_BLOCKED_STALE_SNAPSHOT', 'LANE_THREW', 'SPAWN_THREW'
    ]);
    for (const lane of lanes) {
      const classification = attribution.classifyLaneOutcome(lane);
      if (classification === null) continue; // dry run
      assert.equal(attribution.CLASSES.includes(classification.class), true);
      const code = lane.outcome && lane.outcome.code;
      if (NEVER_AGENT.has(code)) {
        assert.notEqual(classification.class, 'agent-attributable',
          `${lane.laneId}: ${code} must never be agent-attributable (gate 2)`);
      }
      const event = events.laneOutcomeEvent(lane, { source: 'backfill' });
      if (event === null) continue;
      const serialized = JSON.stringify(event);
      assert.equal(serialized.includes('"account"'), false, `${lane.laneId}: event leaked billing.account`);
      assert.equal(events.validateEvent(event).length, 0);
    }
    console.log(`    (replayed ${lanes.length} live lanes)`);
  });
} else {
  console.log('  skip: live state/fleet-supervisor.json not present');
}

console.log(`agent-roster events + attribution: ${passed} checks passed`);
