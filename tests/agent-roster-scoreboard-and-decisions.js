// EXECUTABLE CHANGE
// testcanfail-tests-agent-roster-scoreboard-and-decisions-js
//
// Mutation audit:
// - Empty allotment-disabled results: temporarily removed the product loop that
//   adds `allotment-disabled` entries. RED: "Expected values to be strictly
//   equal: 0 !== 1". The added cardinality assertion prevents the following
//   per-row assertions from passing vacuously.
// - Empty global-day-cap results: temporarily removed the product loop that
//   adds `global-day-cap` entries. RED: "Expected values to be strictly equal:
//   0 !== 2". The added cardinality assertion prevents `.every()` from proving
//   the claim over an empty collection.
// - Tie selection: temporarily reversed the product's stable key ordering.
//   RED: actual model "gemini-3.1-pro-preview" versus expected
//   "gemini-2.5-pro". The literal
//   expected key is independent of `keyStringOf`, the function being checked.
// - NOT-FOUND: exit-status/truthy process assertions; swallowed failures via
//   try/catch or optional chaining; mocks of the subject; skip/platform guards.
// - RESTORED: both mutated source files were restored byte-for-byte (SHA-256
//   decisions.js 6c9f865935ac7a037193ca6878bbf54a3cb1fbaaaa61f4e59db7caeda61ec8d8;
//   scoreboard.js 8cdd4b37934de0d59c01538f9fa9afdc1a910123512fb9aa3e1afd5eb3c7c2f0).
//   Green confirmation: "33 checks passed".

'use strict';

// R103 agent roster — scoreboard-and-decisions builder tests.
//
// Covers the contractually named fixture regimes:
//   all-rejected, one-lucky-accept (n=1 must be UNKNOWN, not champion), tie,
//   small-n suspension refusal, floor exclusion, empty allotment ->
//   everything ineligible with reason 'not-allotted'
// plus the gate mechanics this builder owns: gate 1 (pending is never a
// success), gate 2 (infra faults never blame the agent), gate 3 (UNKNOWN
// below minN), gate 8 (queueDepth 0 -> no exploration, no advice),
// suspension-with-numbers, expiry -> bounded re-trial, trial-blocked-by-infra,
// rebuild determinism (same events -> byte-identical scoreboard), and
// decide() purity (inputs are not mutated).
//
// Everything runs on synthetic in-memory event fixtures shaped exactly like
// the contract eventSchema — no live state files, fully offline.

const assert = require('node:assert/strict');

const statistics = require('../src/lib/fleet-supervisor/roster/statistics.js');
const scoreboardMod = require('../src/lib/fleet-supervisor/roster/scoreboard.js');
const decisions = require('../src/lib/fleet-supervisor/roster/decisions.js');
// REAL floor API (verified import): the roster never restates model lists.
const laneModels = require('../src/lib/fleet-supervisor/lane-models.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

// --- fixture helpers ---------------------------------------------------------

const BASE = Date.parse('2026-07-01T00:00:00.000Z');
const MIN = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs) => new Date(BASE + offsetMs).toISOString();

const V25 = Object.freeze({ role: 'builder', provider: 'gemini', model: 'gemini-2.5-pro', backend: 'vertex', decomposed: false });
const S31 = Object.freeze({ role: 'builder', provider: 'gemini', model: 'gemini-3.1-pro-preview', backend: 'subscription', decomposed: false });
const FLASH = Object.freeze({ role: 'builder', provider: 'gemini', model: 'gemini-3-flash-preview', backend: 'vertex', decomposed: false });

let seq = 0;
function outcomeEvent({ config, cls, rule, ok = false, code = 'EXIT_NONZERO', when, laneId, headCommit = 'commit-aaa' }) {
  seq += 1;
  const lane = laneId || `lane-${seq}`;
  return {
    v: 1,
    eventId: `ev-${seq}`,
    kind: 'lane-outcome',
    at: when,
    source: 'backfill',
    laneId: lane,
    itemId: 'Q0',
    attempt: 1,
    config: { ...config },
    env: { headCommit, supervisorArgvHash: null, supervisorId: 'sup-test', snapshotProven: true },
    billing: null,
    outcome: { ok, code: ok ? null : code, transient: false, durationMs: 1000, changedFileCount: ok ? 1 : 0, reportedModels: null, servedBelowFloor: null, reportedTokens: null, detailPrefix: '' },
    attribution: { class: cls, rule: rule || (cls === 'agent-attributable' ? (ok ? 'R-OK-PENDING' : 'R-EXIT-AGENT') : 'R-FVPM') }
  };
}

function verdictEvent({ config, verdict, cls = 'agent-attributable', rule = 'V-AGENT', when, laneId, headCommit = 'commit-aaa' }) {
  seq += 1;
  return {
    v: 1,
    eventId: `ev-${seq}`,
    kind: 'review-verdict',
    at: when,
    source: 'backfill',
    laneId,
    itemId: 'Q0',
    attempt: 1,
    config: { ...config },
    env: { headCommit, supervisorArgvHash: null, supervisorId: 'sup-test', snapshotProven: true },
    billing: null,
    verdict: { verdict, reviewer: 'review:codex', score: verdict === 'accepted' ? 1 : 0, scoreThreshold: 0.7, rubricVersion: 2, evidenceVerified: true, unreviewable: false, belowFloor: false, reasonPrefix: '' },
    attribution: { class: cls, rule }
  };
}

// N dispatches for `config`, each ok->pending then a verdict.
function reviewedRun(config, { accepted, rejected, startMs, headCommit }) {
  const events = [];
  let t = startMs;
  const emit = (verdict) => {
    seq += 1;
    const laneId = `lane-${seq}-r`;
    events.push(outcomeEvent({ config, cls: 'agent-attributable', ok: true, when: at(t), laneId, headCommit }));
    t += MIN;
    events.push(verdictEvent({ config, verdict, when: at(t), laneId, headCommit }));
    t += MIN;
  };
  for (let i = 0; i < accepted; i++) emit('accepted');
  for (let i = 0; i < rejected; i++) emit('rejected');
  return { events, endMs: t };
}

const build = (events, options) => scoreboardMod.buildScoreboard(events, {
  envNow: { headCommit: 'commit-aaa' },
  ...options
});

const rowFor = (board, config) => board.configs.find((r) =>
  r.key.provider === config.provider && r.key.model === config.model &&
  r.key.backend === config.backend && r.key.decomposed === config.decomposed);

const ALLOTMENT = Object.freeze({
  schemaVersion: 'agent-allotment-v1',
  enabled: true,
  allowed: [
    { role: 'builder', provider: 'gemini', backend: 'vertex', models: ['gemini-2.5-pro'], maxDispatchesPerDay: null },
    { role: 'builder', provider: 'gemini', backend: 'subscription', models: ['gemini-3.1-pro-preview'], maxDispatchesPerDay: null }
  ],
  budgets: { maxTotalDispatchesPerDay: null },
  parameters: { minSamples: 5, explorationEveryK: 5, suspendDays: 14 }
});

// =============================================================================
process.stdout.write('roster statistics (Jeffreys posterior, credible interval)\n');
// =============================================================================

check('jeffreys posterior is Beta(0.5+s, 0.5+f)', () => {
  assert.deepEqual(statistics.jeffreysPosterior(1, 35), { alpha: 1.5, beta: 35.5 });
  assert.deepEqual(statistics.jeffreysPosterior(0, 0), { alpha: 0.5, beta: 0.5 });
});

check('Beta(1,1) quantile is the identity (uniform)', () => {
  for (const p of [0.025, 0.3, 0.5, 0.9, 0.975]) {
    assert.ok(Math.abs(statistics.betaQuantile(p, 1, 1) - p) < 1e-9, `q(${p})`);
  }
});

check('Beta(0.5,0.5) quantile matches arcsine closed form sin^2(pi p / 2)', () => {
  for (const p of [0.025, 0.25, 0.5, 0.975]) {
    const expected = Math.pow(Math.sin((Math.PI * p) / 2), 2);
    assert.ok(Math.abs(statistics.betaQuantile(p, 0.5, 0.5) - expected) < 1e-9, `q(${p})`);
  }
});

check('regularized incomplete beta symmetry I_x(a,b) = 1 - I_{1-x}(b,a)', () => {
  for (const [x, a, b] of [[0.1, 1.5, 35.5], [0.7, 5.5, 0.5], [0.5, 2, 3]]) {
    const lhs = statistics.regularizedIncompleteBeta(x, a, b);
    const rhs = 1 - statistics.regularizedIncompleteBeta(1 - x, b, a);
    assert.ok(Math.abs(lhs - rhs) < 1e-12, `x=${x} a=${a} b=${b}: ${lhs} vs ${rhs}`);
  }
});

check('summary for 1 success / 35 failures is sane and ordered', () => {
  const s = statistics.summarize(1, 35);
  assert.equal(s.n, 36);
  assert.ok(Math.abs(s.mean - 1.5 / 37) < 1e-12);
  assert.ok(s.ci95.lower > 0 && s.ci95.lower < s.mean, `lower ${s.ci95.lower}`);
  assert.ok(s.ci95.upper > s.mean && s.ci95.upper < 0.25, `upper ${s.ci95.upper}`);
});

check('more successes -> higher posterior mean (monotonicity)', () => {
  assert.ok(statistics.summarize(3, 5).mean > statistics.summarize(2, 6).mean);
});

// =============================================================================
process.stdout.write('scoreboard fold (gates 1-3, determinism)\n');
// =============================================================================

check('gate 1: ok lane-outcomes are pendingVerification, never successes', () => {
  const events = [];
  for (let i = 0; i < 6; i++) {
    events.push(outcomeEvent({ config: V25, cls: 'agent-attributable', ok: true, when: at(i * MIN) }));
  }
  const board = build(events);
  const row = rowFor(board, V25);
  assert.equal(row.counts.pendingVerification, 6);
  assert.equal(row.stats.n, 0);
  assert.equal(row.stats.successes, 0);
  assert.equal(row.decision.state, 'unknown');
  assert.equal(board.best, null);
});

check('gate 2: FVPM infra faults never enter agent statistics (regression class)', () => {
  const events = [];
  for (let i = 0; i < 7; i++) {
    events.push(outcomeEvent({ config: V25, cls: 'infra-fault', rule: 'R-FVPM', code: 'FLEET_VERTEX_PROJECT_MISSING', when: at(i * MIN) }));
  }
  const board = build(events);
  const row = rowFor(board, V25);
  assert.equal(row.counts.infraFault, 7);
  assert.deepEqual(row.counts.agentAttributable, { acceptedByReview: 0, rejectedByReview: 0, failedBeforeReview: 0 });
  assert.equal(row.stats.n, 0);
  assert.equal(row.decision.state, 'unknown');
  assert.equal(board.attributionTotals['infra-fault'], 7);
  assert.equal(board.attributionTotals.byRule['R-FVPM'], 7);
  assert.equal(row.stats.infraFaultShare, 1);
});

check('all-rejected regime: n counted, mean low, still the (only) candidate-best', () => {
  const run = reviewedRun(V25, { accepted: 0, rejected: 6, startMs: 0 });
  const board = build(run.events);
  const row = rowFor(board, V25);
  assert.equal(row.stats.n, 6);
  assert.equal(row.stats.successes, 0);
  assert.equal(row.counts.pendingVerification, 0, 'verdicts resolve pending lanes');
  assert.equal(row.counts.agentAttributable.rejectedByReview, 6);
  assert.ok(row.stats.mean < 0.1, `mean ${row.stats.mean}`);
  assert.equal(row.decision.state, 'candidate-best', 'best of a bad lot is still the best evidence-backed config');
  assert.deepEqual(board.best, { keyRef: board.configs.indexOf(row) });
});

check('one-lucky-accept regime: n=1 is UNKNOWN, not champion', () => {
  const run = reviewedRun(V25, { accepted: 1, rejected: 0, startMs: 0 });
  const board = build(run.events);
  const row = rowFor(board, V25);
  assert.equal(row.stats.n, 1);
  assert.equal(row.stats.successes, 1);
  assert.equal(row.decision.state, 'unknown');
  assert.match(row.decision.reason, /insufficient evidence \(n=1 < 5\)/);
  assert.equal(board.best, null, 'no config reaches minN -> no best');
});

check('tie regime: deterministic best by key order, loser stays active (never suspended)', () => {
  const a = reviewedRun(S31, { accepted: 4, rejected: 2, startMs: 0 });
  const b = reviewedRun(V25, { accepted: 4, rejected: 2, startMs: a.endMs });
  const board = build([...a.events, ...b.events]);
  const rowS = rowFor(board, S31);
  const rowV = rowFor(board, V25);
  const states = [rowS.decision.state, rowV.decision.state].sort();
  assert.deepEqual(states, ['active', 'candidate-best']);
  // identical stats -> tiebreak is lexicographic key order (stable, documented)
  const bestRow = board.configs[board.best.keyRef];
  const sortedKeys = [rowS, rowV].map((r) => scoreboardMod.keyStringOf(r.key)).sort();
  assert.deepEqual(bestRow.key, V25, 'literal expected tie winner is independent of keyStringOf');
  assert.equal(scoreboardMod.keyStringOf(bestRow.key), sortedKeys[0]);
  assert.ok(rowS.decision.state !== 'suspended' && rowV.decision.state !== 'suspended', 'overlapping bounds never suspend');
});

check('small-n suspension refusal: dominated config with n=4 stays UNKNOWN', () => {
  const a = reviewedRun(V25, { accepted: 5, rejected: 0, startMs: 0 });
  const b = reviewedRun(S31, { accepted: 0, rejected: 4, startMs: a.endMs });
  const board = build([...a.events, ...b.events]);
  const rowB = rowFor(board, S31);
  // numerically dominated (upper < best lower) but n=4 < minN=5: refuse to fire
  const bounds = statistics.summarize(0, 4).ci95;
  const bestBounds = statistics.summarize(5, 0).ci95;
  assert.ok(bounds.upper < bestBounds.lower, `fixture must be numerically dominated: ${bounds.upper} vs ${bestBounds.lower}`);
  assert.equal(rowB.decision.state, 'unknown');
  assert.match(rowB.decision.reason, /insufficient evidence \(n=4 < 5\)/);
});

check('suspension fires only with n >= minN on both sides, and records the numbers', () => {
  const a = reviewedRun(V25, { accepted: 8, rejected: 2, startMs: 0 });
  const b = reviewedRun(S31, { accepted: 0, rejected: 10, startMs: a.endMs });
  const board = build([...a.events, ...b.events]);
  const rowB = rowFor(board, S31);
  assert.equal(rowB.decision.state, 'suspended');
  assert.match(rowB.decision.reason, /ci95\.upper 0\.\d+ < best\(.+\) ci95\.lower 0\.\d+ with n=\d+ vs best n=\d+/);
  assert.ok(rowB.decision.suspendExpiresAt, 'suspension carries an expiry');
  assert.equal(rowB.decision.suspendedAtCommit, 'commit-aaa');
  const expiryMs = Date.parse(rowB.decision.suspendExpiresAt) - Date.parse(rowB.decision.since);
  assert.equal(expiryMs, 14 * DAY, '14-day clock from the suspension moment');
  assert.ok(board.decisionLog.some((t) => t.to === 'suspended' && t.key.includes('gemini-3.1-pro-preview')), 'transition logged');
});

check('rebuild determinism: same events -> byte-identical scoreboard', () => {
  const a = reviewedRun(V25, { accepted: 8, rejected: 2, startMs: 0 });
  const b = reviewedRun(S31, { accepted: 0, rejected: 10, startMs: a.endMs });
  const events = [...a.events, ...b.events,
    outcomeEvent({ config: V25, cls: 'infra-fault', rule: 'R-FVPM', when: at(b.endMs) }),
    outcomeEvent({ config: { ...V25, provider: null, model: null }, cls: 'unknown', rule: 'R-SPARSE', when: at(b.endMs + MIN) })
  ];
  const opts = { envNow: { headCommit: 'commit-aaa' }, allotmentSnapshot: { path: 'config/agent-allotment.json', sha256: 'abc', enabled: true }, floorSnapshot: { union: ['x'] } };
  const one = scoreboardMod.serializeScoreboard(scoreboardMod.buildScoreboard(events, opts));
  const two = scoreboardMod.serializeScoreboard(scoreboardMod.buildScoreboard(events, opts));
  assert.equal(one, two);
  assert.ok(one.includes('"generatedAt"'), 'serialized');
  const parsed = JSON.parse(one);
  assert.equal(parsed.generatedAt, events[events.length - 1].at, 'generatedAt is the last event timestamp, not wall clock');
});

check('null-identity events land in the unknownConfig bucket, never decided', () => {
  const events = [
    outcomeEvent({ config: { role: 'builder', provider: null, model: null, backend: null, decomposed: false }, cls: 'unknown', rule: 'R-SPARSE', when: at(0) }),
    outcomeEvent({ config: { role: 'builder', provider: null, model: null, backend: null, decomposed: false }, cls: 'unknown', rule: 'R-UNOBSERVED', when: at(MIN) })
  ];
  const board = build(events);
  assert.equal(board.configs.length, 0);
  assert.equal(board.unknownConfig.counts.dispatched, 2);
  assert.equal(board.unknownConfig.counts.unknown, 2);
  assert.equal(board.unknownConfig.decision.state, 'unknown');
  assert.equal(board.best, null);
});

check('R-UNSEEN codes surface in unseenCodes verbatim', () => {
  const events = [
    outcomeEvent({ config: V25, cls: 'unknown', rule: 'R-UNSEEN', code: 'BRAND_NEW_FAILURE_MODE', when: at(0) }),
    outcomeEvent({ config: V25, cls: 'unknown', rule: 'R-UNSEEN', code: 'BRAND_NEW_FAILURE_MODE', when: at(MIN) })
  ];
  const board = build(events);
  assert.deepEqual(board.unseenCodes, [{ code: 'BRAND_NEW_FAILURE_MODE', count: 2, firstAt: at(0) }]);
});

check('suspension expiry -> bounded re-trial -> destination-verified acceptance -> active', () => {
  // A weaker best (5/10) so one trial success lifts B out of dominance.
  const a = reviewedRun(V25, { accepted: 5, rejected: 5, startMs: 0 });
  const b = reviewedRun(S31, { accepted: 0, rejected: 10, startMs: a.endMs });
  const midBoard = build([...a.events, ...b.events]);
  assert.equal(rowFor(midBoard, S31).decision.state, 'suspended', 'fixture precondition');

  const afterExpiry = b.endMs + 15 * DAY;
  const trialLane = `lane-trial-1`;
  const events = [
    ...a.events, ...b.events,
    // any event after the clock runs out flips the suspension to trial
    outcomeEvent({ config: S31, cls: 'agent-attributable', ok: true, when: at(afterExpiry), laneId: trialLane }),
    verdictEvent({ config: S31, verdict: 'accepted', when: at(afterExpiry + MIN), laneId: trialLane })
  ];
  const board = build(events);
  const rowB = rowFor(board, S31);
  assert.ok(board.decisionLog.some((t) => t.key.includes('gemini-3.1-pro-preview') && t.from === 'suspended' && t.to === 'trial'), 'expiry transition logged');
  assert.ok(board.decisionLog.some((t) => t.key.includes('gemini-3.1-pro-preview') && t.from === 'trial' && t.to === 'active'), 'trial-pass transition logged');
  assert.equal(rowB.decision.state, 'active');
  assert.equal(rowB.stats.successes, 1);
});

check('trial blocked by infra: 3 non-attributable outcomes re-suspend with a fresh clock', () => {
  const a = reviewedRun(V25, { accepted: 8, rejected: 2, startMs: 0 });
  const b = reviewedRun(S31, { accepted: 0, rejected: 10, startMs: a.endMs });
  const afterExpiry = b.endMs + 15 * DAY;
  const events = [...a.events, ...b.events];
  for (let i = 0; i < 3; i++) {
    events.push(outcomeEvent({ config: S31, cls: 'infra-fault', rule: 'R-FVPM', code: 'FLEET_VERTEX_PROJECT_MISSING', when: at(afterExpiry + i * MIN) }));
  }
  const board = build(events);
  const rowB = rowFor(board, S31);
  assert.equal(rowB.decision.state, 'suspended');
  assert.match(rowB.decision.reason, /trial-blocked-by-infra/);
  assert.ok(Date.parse(rowB.decision.suspendExpiresAt) > BASE + afterExpiry, 'fresh clock');
});

// =============================================================================
process.stdout.write('decisions.decide() (allotment, floor, gate 8, exploration)\n');
// =============================================================================

const strongBoard = (() => {
  const a = reviewedRun(V25, { accepted: 8, rejected: 2, startMs: 0 });
  return build(a.events);
})();

check('empty allotment: everything ineligible with reason not-allotted, advice null', () => {
  const result = decisions.decide({
    scoreboard: strongBoard,
    allotment: { ...ALLOTMENT, allowed: [] },
    floorApi: laneModels,
    queueDepth: 3
  });
  assert.equal(result.advice, null);
  assert.ok(result.ineligible.length >= 1);
  for (const row of result.ineligible) assert.equal(row.reason, 'not-allotted');
  assert.equal(result.exploration, null);
});

check('allotment disabled: fail-dormant, everything ineligible allotment-disabled', () => {
  const result = decisions.decide({
    scoreboard: strongBoard,
    allotment: { ...ALLOTMENT, enabled: false },
    floorApi: laneModels,
    queueDepth: 3
  });
  assert.equal(result.advice, null);
  assert.equal(result.ineligible.length, 1, 'the scoreboard triple must be explicitly disabled');
  for (const row of result.ineligible) assert.equal(row.reason, 'allotment-disabled');
});

check('floor exclusion via the REAL lane-models API: below-floor model refused', () => {
  const run = reviewedRun(FLASH, { accepted: 5, rejected: 1, startMs: 0 });
  const board = build(run.events);
  const allot = {
    ...ALLOTMENT,
    allowed: [{ role: 'builder', provider: 'gemini', backend: 'vertex', models: ['gemini-3-flash-preview'], maxDispatchesPerDay: null }]
  };
  const result = decisions.decide({ scoreboard: board, allotment: allot, floorApi: laneModels, queueDepth: 3 });
  assert.equal(result.advice, null);
  const flashRow = result.ineligible.find((r) => r.key.model === 'gemini-3-flash-preview');
  assert.ok(flashRow, 'flash triple present');
  assert.equal(flashRow.reason, 'below-floor');
  assert.match(flashRow.detail, /FLEET_MODEL_REFUSED/);
});

check('one-lucky-accept board: advice null (promotion cannot precede evidence)', () => {
  const run = reviewedRun(V25, { accepted: 1, rejected: 0, startMs: 0 });
  const board = build(run.events);
  const result = decisions.decide({ scoreboard: board, allotment: ALLOTMENT, floorApi: laneModels, queueDepth: 3 });
  assert.equal(result.advice, null);
  assert.equal(result.best, null);
  assert.ok(result.notes.some((n) => /promotion cannot precede evidence/.test(n)), JSON.stringify(result.notes));
});

check('all-rejected sole config still ranks and is the exploit advice', () => {
  const run = reviewedRun(V25, { accepted: 0, rejected: 6, startMs: 0 });
  const board = build(run.events);
  // restrict allotment to the one config so no exploration candidate outranks it
  const allot = { ...ALLOTMENT, allowed: [ALLOTMENT.allowed[0]] };
  const result = decisions.decide({ scoreboard: board, allotment: allot, floorApi: laneModels, queueDepth: 3 });
  assert.equal(result.ranked.length, 1);
  assert.ok(result.advice);
  assert.equal(result.advice.kind, 'exploit');
  assert.equal(result.advice.model, 'gemini-2.5-pro');
  assert.match(result.advice.reason, /candidate-best/);
});

check('gate 8: queueDepth 0 -> no advice, no exploration, even with under-sampled configs', () => {
  const result = decisions.decide({ scoreboard: strongBoard, allotment: ALLOTMENT, floorApi: laneModels, queueDepth: 0 });
  assert.equal(result.advice, null);
  assert.equal(result.exploration, null);
  assert.ok(result.notes.some((n) => /gate 8/.test(n)));
  assert.ok(result.ranked.length >= 1, 'diagnostics still computed for display');
});

check('exploration: under-sampled allotted config gets the slot when unthrottled', () => {
  // strongBoard has V25 decided; S31 is allotted with zero events (synthesized n=0)
  const result = decisions.decide({
    scoreboard: strongBoard, allotment: ALLOTMENT, floorApi: laneModels, queueDepth: 3,
    context: { recentAdvisedDispatches: [] }
  });
  assert.ok(result.exploration, 'exploration slot filled');
  assert.equal(result.exploration.kind, 'exploration');
  assert.equal(result.advice.model, 'gemini-3.1-pro-preview');
  assert.equal(result.advice.kind, 'exploration');
});

check('exploration throttle: 1 exploration in last K blocks the slot; exploit advice instead', () => {
  const result = decisions.decide({
    scoreboard: strongBoard, allotment: ALLOTMENT, floorApi: laneModels, queueDepth: 3,
    context: { recentAdvisedDispatches: [{ keyStr: 'x', exploration: true }, { keyStr: 'y', exploration: false }] }
  });
  assert.equal(result.exploration, null);
  assert.ok(result.advice);
  assert.equal(result.advice.kind, 'exploit');
  assert.equal(result.advice.model, 'gemini-2.5-pro');
  assert.ok(result.notes.some((n) => /exploration throttled/.test(n)));
});

check('suspended config is never advised; expired suspension becomes the bounded trial slot', () => {
  const a = reviewedRun(V25, { accepted: 8, rejected: 2, startMs: 0 });
  const b = reviewedRun(S31, { accepted: 0, rejected: 10, startMs: a.endMs });
  const board = build([...a.events, ...b.events]);
  const suspendedRow = rowFor(board, S31);
  assert.equal(suspendedRow.decision.state, 'suspended', 'fixture precondition');

  // Unexpired: ineligible with the recorded reason.
  const before = decisions.decide({
    scoreboard: board, allotment: ALLOTMENT, floorApi: laneModels, queueDepth: 3,
    context: { now: suspendedRow.decision.since, headCommit: 'commit-aaa', recentAdvisedDispatches: [{ exploration: true }] }
  });
  const susp = before.ineligible.find((r) => r.key.model === 'gemini-3.1-pro-preview');
  assert.ok(susp, 'suspended triple listed ineligible');
  assert.equal(susp.reason, 'suspended');
  assert.match(susp.detail, /ci95\.upper/);
  assert.equal(before.advice.kind, 'exploit');

  // Expired by time: becomes the trial slot regardless of exploration throttle.
  const after = decisions.decide({
    scoreboard: board, allotment: ALLOTMENT, floorApi: laneModels, queueDepth: 3,
    context: { now: new Date(Date.parse(suspendedRow.decision.suspendExpiresAt) + MIN).toISOString(), headCommit: 'commit-aaa', recentAdvisedDispatches: [{ exploration: true }] }
  });
  assert.ok(after.advice);
  assert.equal(after.advice.kind, 'trial');
  assert.equal(after.advice.model, 'gemini-3.1-pro-preview');

  // Expired by environment fingerprint change (new HEAD) with time remaining.
  const byCommit = decisions.decide({
    scoreboard: board, allotment: ALLOTMENT, floorApi: laneModels, queueDepth: 3,
    context: { now: suspendedRow.decision.since, headCommit: 'commit-bbb', recentAdvisedDispatches: [{ exploration: true }] }
  });
  assert.ok(byCommit.advice);
  assert.equal(byCommit.advice.kind, 'trial');
});

check('day caps: per-entry and global conserve-usage levers refuse further advice', () => {
  const cappedEntry = { ...ALLOTMENT.allowed[0], maxDispatchesPerDay: 2 };
  const tripleKey = decisions.tripleKeyOf(V25);
  const perEntry = decisions.decide({
    scoreboard: strongBoard,
    allotment: { ...ALLOTMENT, allowed: [cappedEntry] },
    floorApi: laneModels, queueDepth: 3,
    context: { dispatchCounts: { total: 2, byTriple: { [tripleKey]: 2 } } }
  });
  assert.ok(perEntry.ineligible.some((r) => r.reason === 'allotment-day-cap'));
  assert.equal(perEntry.advice, null);

  const global = decisions.decide({
    scoreboard: strongBoard,
    allotment: { ...ALLOTMENT, budgets: { maxTotalDispatchesPerDay: 5 } },
    floorApi: laneModels, queueDepth: 3,
    context: { dispatchCounts: { total: 5, byTriple: {} } }
  });
  assert.equal(global.advice, null);
  assert.equal(global.ineligible.length, 2, 'both allotted triples must be blocked by the global cap');
  assert.ok(global.ineligible.every((r) => r.reason === 'global-day-cap'));
});

check('configured day caps refuse when their contributing counts are unavailable', () => {
  const global = decisions.decide({
    scoreboard: strongBoard,
    allotment: { ...ALLOTMENT, budgets: { maxTotalDispatchesPerDay: 5 } },
    floorApi: laneModels,
    queueDepth: 3
  });
  assert.equal(global.advice, null);
  assert.ok(global.ineligible.every((r) => r.reason === 'dispatch-count-unavailable'));

  const perEntry = decisions.decide({
    scoreboard: strongBoard,
    allotment: { ...ALLOTMENT, allowed: [{ ...ALLOTMENT.allowed[0], maxDispatchesPerDay: 2 }] },
    floorApi: laneModels,
    queueDepth: 3,
    context: { dispatchCounts: { total: 0, byTriple: {} } }
  });
  assert.equal(perEntry.advice, null);
  assert.ok(perEntry.ineligible.some((r) => r.reason === 'dispatch-count-unavailable'));
});

check('missing exploration history does not masquerade as an empty history', () => {
  const result = decisions.decide({
    scoreboard: strongBoard, allotment: ALLOTMENT, floorApi: laneModels, queueDepth: 3
  });
  assert.equal(result.exploration, null);
  assert.equal(result.advice.kind, 'exploit');
  assert.ok(result.notes.some((n) => /exploration-history-unmeasured/.test(n)));
});

check('sol tier is refused defensively even if a loader let it through', () => {
  const board = build([]);
  const allot = {
    ...ALLOTMENT,
    allowed: [{ role: 'builder', provider: 'codex', backend: 'subscription', tier: 'sol', models: ['gemini-3.1-pro-preview'], maxDispatchesPerDay: null }]
  };
  const result = decisions.decide({ scoreboard: board, allotment: allot, floorApi: laneModels, queueDepth: 3 });
  assert.equal(result.advice, null);
  assert.ok(result.ineligible.some((r) => r.reason === 'sol-excluded'));
});

check('decide() is pure: inputs are not mutated, same inputs -> same output', () => {
  const a = reviewedRun(V25, { accepted: 8, rejected: 2, startMs: 0 });
  const board = build(a.events);
  const boardBytes = JSON.stringify(board);
  const allotBytes = JSON.stringify(ALLOTMENT);
  const ctx = { recentAdvisedDispatches: [], now: at(0), headCommit: 'commit-aaa' };
  const one = decisions.decide({ scoreboard: board, allotment: ALLOTMENT, floorApi: laneModels, queueDepth: 2, context: ctx });
  const two = decisions.decide({ scoreboard: board, allotment: ALLOTMENT, floorApi: laneModels, queueDepth: 2, context: ctx });
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify(board), boardBytes, 'scoreboard not mutated');
  assert.equal(JSON.stringify(ALLOTMENT), allotBytes, 'allotment not mutated');
});

check('vertex advice requires a project (FLEET_VERTEX_PROJECT_MISSING lesson)', () => {
  const result = decisions.decide({
    scoreboard: strongBoard, allotment: ALLOTMENT, floorApi: laneModels, queueDepth: 3,
    context: { laneProjectPresent: false, recentAdvisedDispatches: [{ exploration: true }] }
  });
  assert.ok(result.ineligible.some((r) => r.reason === 'vertex-project-missing' && r.key.backend === 'vertex'));
  assert.equal(result.advice, null, 'the only decided config was vertex; no cross-into-anything advice');
});

check('backend availability: advice never crosses the constructed backend (v1)', () => {
  const result = decisions.decide({
    scoreboard: strongBoard, allotment: ALLOTMENT, floorApi: laneModels, queueDepth: 3,
    context: { backend: 'vertex', recentAdvisedDispatches: [] }
  });
  assert.ok(result.ineligible.some((r) => r.reason === 'backend-unavailable' && r.key.backend === 'subscription'));
  assert.ok(result.advice);
  assert.equal(result.advice.backend, 'vertex');
});

// =============================================================================
process.stdout.write('rebuild() end-to-end (CLI --rebuild delegation seam)\n');
// =============================================================================

check('rebuild(): reads real-validator events, writes scoreboard, byte-identical on rerun', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const eventsMod = require('../src/lib/fleet-supervisor/roster/events.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-rebuild-'));
  try {
    const mkEvent = (kind, laneId, when, body) => {
      const e = {
        v: 1,
        eventId: eventsMod.computeEventId({ kind, laneId, attempt: 1, at: when }),
        kind,
        at: when,
        source: 'backfill',
        laneId,
        itemId: 'Q0',
        attempt: 1,
        config: { ...V25 },
        env: { headCommit: null, supervisorArgvHash: null, supervisorId: 'sup-test', snapshotProven: true },
        billing: null,
        ...body
      };
      const problems = eventsMod.validateEvent(e);
      assert.deepEqual(problems, [], `fixture event must pass the REAL validator: ${JSON.stringify(problems)}`);
      return e;
    };
    const lines = [];
    for (let i = 0; i < 3; i++) {
      const laneId = `lane-rb-${i}`;
      lines.push(mkEvent('lane-outcome', laneId, at(i * 2 * MIN), {
        outcome: { ok: true, code: null, transient: false, durationMs: 1000, changedFileCount: 1, reportedModels: null, servedBelowFloor: null, reportedTokens: null, detailPrefix: '' },
        attribution: { class: 'agent-attributable', rule: 'R-OK-PENDING' }
      }));
      lines.push(mkEvent('review-verdict', laneId, at((i * 2 + 1) * MIN), {
        verdict: { verdict: i === 0 ? 'accepted' : 'rejected', reviewer: 'review:codex', score: null, scoreThreshold: null, rubricVersion: null, evidenceVerified: true, unreviewable: false, belowFloor: false, reasonPrefix: '' },
        attribution: { class: 'agent-attributable', rule: 'V-AGENT' }
      }));
    }
    const eventsPath = path.join(dir, 'events.jsonl');
    fs.writeFileSync(eventsPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

    const outPath = path.join(dir, 'agent-roster.json');
    const one = scoreboardMod.rebuild({ repoRoot: dir, eventsPath, outPath });
    assert.equal(one.written, true);
    assert.equal(one.eventCount, 6);
    assert.equal(one.corruptLines, 0);
    assert.equal(one.changed, true, 'first build writes fresh bytes');
    const bytesOne = fs.readFileSync(outPath, 'utf8');
    const parsed = JSON.parse(bytesOne);
    assert.equal(parsed.generatedAt, lines[lines.length - 1].at, 'generatedAt from last event');
    assert.equal(parsed.configs[0].stats.n, 3);
    assert.equal(parsed.configs[0].stats.successes, 1);
    assert.equal(parsed.configs[0].decision.state, 'unknown', 'n=3 < 5 stays unknown');

    // delete-and-recompute must be byte-identical (contract)
    fs.unlinkSync(outPath);
    const two = scoreboardMod.rebuild({ repoRoot: dir, eventsPath, outPath });
    assert.equal(fs.readFileSync(outPath, 'utf8'), bytesOne, 'byte-identical rebuild');
    assert.equal(two.eventCount, 6);
    const three = scoreboardMod.rebuild({ repoRoot: dir, eventsPath, outPath });
    assert.equal(three.changed, false, 'unchanged bytes reported honestly');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('rebuild(): refuses when the events input could not be established', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-rebuild-missing-'));
  try {
    const eventsPath = path.join(dir, 'missing-events.jsonl');
    const outPath = path.join(dir, 'agent-roster.json');
    assert.throws(
      () => scoreboardMod.rebuild({ repoRoot: dir, eventsPath, outPath }),
      (error) => error && error.code === 'ENOENT'
    );
    assert.equal(fs.existsSync(outPath), false, 'an absent input must not produce a definite empty scoreboard');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('rebuild(): refuses when the previous scoreboard cannot be read', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-rebuild-unreadable-'));
  try {
    const eventsPath = path.join(dir, 'events.jsonl');
    fs.writeFileSync(eventsPath, '', 'utf8');
    const outPath = path.join(dir, 'scoreboard-directory');
    fs.mkdirSync(outPath);
    assert.throws(
      () => scoreboardMod.rebuild({ repoRoot: dir, eventsPath, outPath }),
      (error) => error && error.code !== 'ENOENT'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

process.stdout.write(`\n${passed} checks passed\n`);
