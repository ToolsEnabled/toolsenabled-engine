'use strict';

// roster/attribution.js -- deterministic outcome -> attribution-class mapping.
//
// R103: promote/fire decisions may only ever be computed from events whose
// attribution class is 'agent-attributable'. This module is the ONLY place
// that class is assigned, and it assigns it from an ORDERED rule table where
// the FIRST matching rule wins and every rule names a REAL failure code or
// exact historical string observed in state/fleet-supervisor.json or
// logs/fleet-supervisor.log. An outcome code this table has never seen maps
// to 'unknown' -- NEVER to a guess, never to agent blame (ledger gate 3).
//
// The table is exported as data (ruleTable()) so tools/agent-roster.js can
// print exactly what will happen to any code without executing anything.
//
// Gate 2 regression anchor: FLEET_VERTEX_PROJECT_MISSING (29 lanes at design
// time) was a supervisor misconfiguration recorded as lane failure. R-FVPM
// maps it to 'infra-fault'; replaying that history must produce ZERO
// agent-attributable failures. tests/agent-roster-events-and-attribution.js
// pins this.
//
// Classes (exactly one per event):
//   agent-attributable  -- enters promote/fire statistics
//   infra-fault         -- counted and shown; a SUPERVISOR quality metric
//   environment-fault   -- counted and shown; the tree/harness was at fault
//   unknown             -- honest bucket; counted and shown, never decided on

const CLASSES = Object.freeze([
  'agent-attributable',
  'infra-fault',
  'environment-fault',
  'unknown'
]);

// --------------------------------------------------------------------------
// Enumerated matchers. Prose matching is restricted to the three exact
// historical strings below plus the harness's own transient regex -- never a
// general heuristic (contract attributionRules).
// --------------------------------------------------------------------------

// Mirrored VERBATIM from src/lib/fleet-supervisor/supervisor.js:58
// (TRANSIENT_DETAIL_RE). Mirrored rather than required because supervisor.js
// will require the roster at its two hook points, and the roster must never
// require supervisor.js back (require cycle). The test suite asserts the two
// regexes have identical source, so drift fails loudly.
const TRANSIENT_DETAIL_RE = /quota|rate.?limit|resource.?exhausted|high traffic|overloaded|too many requests|\b429\b|\b503\b|temporarily unavailable/i;

// Enumerated-string rule #1: the exact Gemini CLI model/project-access error
// observed live in phase-planning-fallback log events.
const MODEL_UNAVAILABLE_RE = /was not found or your project does not have access to it/i;

// Enumerated-string rule #2: pre-preserve-before-cleanup rejections (4
// observed in lane.review; log event review-rejected-no-artifact x4).
const NO_ARTIFACT_PREFIX =
  'unverifiable: the lane produced changes but no worktree or preserved packet survives';

// Enumerated-string rule #3: the reviewer itself could not execute (observed
// in a review-verdict log sample). No quality signal either way.
const POLICY_BLOCKED_PREFIX = 'unverifiable: policy blocked Node execution';

function startsWithPrefix(text, prefix) {
  return typeof text === 'string' && text.startsWith(prefix);
}

// --------------------------------------------------------------------------
// Normalized inputs
// --------------------------------------------------------------------------

function snapshotProvenOf(lane) {
  if (!lane || !lane.snapshot || typeof lane.snapshot !== 'object') return null;
  return typeof lane.snapshot.complete === 'boolean' ? lane.snapshot.complete : null;
}

function laneContext(lane) {
  const outcome = lane.outcome && typeof lane.outcome === 'object' ? lane.outcome : null;
  const code = outcome && typeof outcome.code === 'string' && outcome.code ? outcome.code : null;
  const hasOk = Boolean(outcome) && typeof outcome.ok === 'boolean';
  const hasTransient = Boolean(outcome) && typeof outcome.transient === 'boolean';
  const detail = outcome && typeof outcome.detail === 'string' ? outcome.detail : '';
  return { lane, outcome, code, hasOk, hasTransient, detail, snapshotProven: snapshotProvenOf(lane) };
}

// --------------------------------------------------------------------------
// LANE-OUTCOME rules -- ordered, first match wins.
// Every `summary` cites the real code and design-time count.
// --------------------------------------------------------------------------

const LANE_OUTCOME_RULES = Object.freeze([
  Object.freeze({
    id: 'R-DRYRUN',
    class: null,
    emitsEvent: false,
    summary: "code==='DRY_RUN': not a real dispatch; NO event is emitted at all.",
    when: ctx => ctx.code === 'DRY_RUN'
  }),
  Object.freeze({
    id: 'R-UNOBSERVED',
    class: 'unknown',
    summary: "lane.status==='unknown' (unknownReason 'supervisor-exited-before-outcome-was-observed', 9 observed): the supervisor died first; nothing about the agent is knowable.",
    when: ctx => ctx.lane.status === 'unknown'
  }),
  Object.freeze({
    id: 'R-SPARSE',
    class: 'unknown',
    summary: 'no outcome object, or outcome with neither ok nor code: the honest bucket sparse {status:failed}-style records demand.',
    when: ctx => !ctx.outcome || (!ctx.hasOk && ctx.code === null)
  }),
  Object.freeze({
    id: 'R-FVPM',
    class: 'infra-fault',
    summary: "code==='FLEET_VERTEX_PROJECT_MISSING' (29 lanes at design time): supervisor misconfiguration recorded as lane failure. THE gate-2 regression anchor -- replay must yield zero agent-attributable failures.",
    when: ctx => ctx.code === 'FLEET_VERTEX_PROJECT_MISSING'
  }),
  Object.freeze({
    id: 'R-STALE-SNAPSHOT',
    class: 'environment-fault',
    summary: "code==='DISPATCH_BLOCKED_STALE_SNAPSHOT' (20+ lanes): the lane never launched; repo materialization was incomplete. No agent acted.",
    when: ctx => ctx.code === 'DISPATCH_BLOCKED_STALE_SNAPSHOT'
  }),
  Object.freeze({
    id: 'R-LANE-THREW',
    class: 'infra-fault',
    summary: "code==='LANE_THREW' (18+ lanes; git worktree add path-length bug): the harness threw; the agent never got the brief.",
    when: ctx => ctx.code === 'LANE_THREW'
  }),
  Object.freeze({
    id: 'R-SPAWN-THREW',
    class: 'infra-fault',
    summary: "code==='SPAWN_THREW' (spawn ENAMETOOLONG, 3 observed in log): known harness bug named in the R103 brief.",
    when: ctx => ctx.code === 'SPAWN_THREW'
  }),
  Object.freeze({
    id: 'R-TRANSIENT',
    class: 'infra-fault',
    summary: 'outcome.transient===true (harness-computed, supervisor.js:352): quota/capacity is the PROVIDER fault; the harness already refunds the attempt.',
    when: ctx => Boolean(ctx.outcome) && ctx.outcome.transient === true
  }),
  Object.freeze({
    id: 'R-TRANSIENT-LEGACY',
    class: 'infra-fault',
    summary: "code==='EXIT_NONZERO', transient field ABSENT (14 pre-transient-era records observed), and the harness's own TRANSIENT_DETAIL_RE matches the stored detail: deterministic reconstruction of exactly what supervisor.js:352 would have computed, not a guess. A match on the truncated detail implies a match on the full detail, so this direction is safe.",
    when: ctx => ctx.code === 'EXIT_NONZERO' && !ctx.hasTransient && TRANSIENT_DETAIL_RE.test(ctx.detail)
  }),
  Object.freeze({
    id: 'R-LEGACY-UNJUDGED',
    class: 'unknown',
    summary: "code==='EXIT_NONZERO', transient field ABSENT, and TRANSIENT_DETAIL_RE does NOT match the stored (400-char-truncated) detail: reconstructing NON-transience from a truncated string could blame an agent for quota, so gate 3 says unknown. Not an unseen code -- EXIT_NONZERO is a seen code in a legacy shape.",
    when: ctx => ctx.code === 'EXIT_NONZERO' && !ctx.hasTransient
      && !MODEL_UNAVAILABLE_RE.test(ctx.detail)
  }),
  Object.freeze({
    id: 'R-MODEL-UNAVAILABLE',
    class: 'infra-fault',
    summary: "code==='EXIT_NONZERO' and detail matches the exact observed Gemini CLI string 'was not found or your project does not have access to it': model/project misconfiguration. Enumerated-string rule #1.",
    when: ctx => ctx.code === 'EXIT_NONZERO' && MODEL_UNAVAILABLE_RE.test(ctx.detail)
  }),
  Object.freeze({
    id: 'R-SNAPSHOT-UNPROVEN',
    class: 'environment-fault',
    summary: 'guard on R-EXIT-AGENT only: the failure would be agent-attributable but the lane ran without a proven-complete materialization (snapshot absent or not complete===true). The mechanical form of the pre-checkpoint-94a9d22 stale-tree attribution: failure inside an unproven tree is not agent evidence. Never downgrades an accepted verdict.',
    when: ctx => ctx.code === 'EXIT_NONZERO' && ctx.hasTransient
      && ctx.outcome.transient === false && !MODEL_UNAVAILABLE_RE.test(ctx.detail)
      && ctx.snapshotProven !== true
  }),
  Object.freeze({
    id: 'R-EXIT-AGENT',
    class: 'agent-attributable',
    agentFailure: true,
    summary: "code==='EXIT_NONZERO', transient===false, not model-unavailable, under a proven-complete snapshot: the provider process ran in a proven tree and exited nonzero for a non-capacity reason. Agent-attributable FAILURE.",
    when: ctx => ctx.code === 'EXIT_NONZERO' && ctx.hasTransient
      && ctx.outcome.transient === false && !MODEL_UNAVAILABLE_RE.test(ctx.detail)
      && ctx.snapshotProven === true
  }),
  Object.freeze({
    id: 'R-TIMEOUT',
    class: 'unknown',
    summary: "code==='TIMEOUT' (1 observed): with n=1 a provider hang is indistinguishable from an agent loop; below minimum evidence -> honest unknown (gate 3).",
    when: ctx => ctx.code === 'TIMEOUT'
  }),
  Object.freeze({
    id: 'R-OK-PENDING',
    class: 'agent-attributable',
    pendingVerification: true,
    summary: 'ok===true, code===null (80 observed): agent-attributable but flagged pendingVerification -- enters NO statistic until a review-verdict event lands (gate 1: a process exit is not a destination-verified outcome).',
    when: ctx => ctx.hasOk && ctx.outcome.ok === true && ctx.code === null
  }),
  Object.freeze({
    id: 'R-UNSEEN',
    class: 'unknown',
    recordsUnseenCode: true,
    summary: 'any other code: unknown, code recorded VERBATIM into scoreboard.unseenCodes so a new failure mode surfaces instead of being silently misfiled.',
    when: () => true
  })
]);

// --------------------------------------------------------------------------
// REVIEW-VERDICT rules -- ordered, first match wins.
// --------------------------------------------------------------------------

const REVIEW_VERDICT_RULES = Object.freeze([
  Object.freeze({
    id: 'V-BELOW-FLOOR',
    class: 'infra-fault',
    summary: "servedBelowFloor non-empty OR review.state==='below-floor' (2 observed: gemini-3-flash-preview served on a vertex lane): the provider silently downgraded below the R95 floor. Not agent quality, and NEVER an agent success.",
    when: ctx => (Array.isArray(ctx.servedBelowFloor) && ctx.servedBelowFloor.length > 0)
      || ctx.reviewState === 'below-floor'
  }),
  Object.freeze({
    id: 'V-NO-ARTIFACT',
    class: 'environment-fault',
    summary: "unreviewable===true OR review.state==='no-artifact' OR reason starts with the exact historical string '" + NO_ARTIFACT_PREFIX + "' (4 observed; predates preserve-before-cleanup): the harness destroyed the work before anyone judged it. Enumerated-string rule #2.",
    when: ctx => ctx.unreviewable === true
      || ctx.reviewState === 'no-artifact'
      || startsWithPrefix(ctx.reason, NO_ARTIFACT_PREFIX)
  }),
  Object.freeze({
    id: 'V-POLICY-BLOCKED',
    class: 'environment-fault',
    summary: "reason starts with the exact observed string '" + POLICY_BLOCKED_PREFIX + "': the REVIEWER could not execute; no quality signal either way. Enumerated-string rule #3.",
    when: ctx => startsWithPrefix(ctx.reason, POLICY_BLOCKED_PREFIX)
  }),
  Object.freeze({
    id: 'V-AGENT',
    class: 'agent-attributable',
    summary: "any other accepted/rejected verdict: agent-attributable; success iff verdict==='accepted'. Many genuine rejections begin 'unverifiable:' but are real quality judgments -- prose matching stays limited to the three exact strings above.",
    when: ctx => ctx.verdict === 'accepted' || ctx.verdict === 'rejected'
  }),
  Object.freeze({
    id: 'V-UNSEEN',
    class: 'unknown',
    summary: "defensive terminal rule: a verdict string outside {accepted, rejected} cannot come from markVerified (it enforces the enum, supervisor.js:489) but the classifier must never guess. Unknown, never agent blame.",
    when: () => true
  })
]);

// Park-only rule: item.lastOutcome carries {laneId, processExitOk, code,
// changedFileCount, verification, at} (the observed shape) -- no transient, no
// detail, no snapshot -- so a code whose class needs that context cannot be
// attributed from the park record alone. Parks are informational and never
// enter statistics, so honest unknown costs nothing; pass the lane record to
// classifyParkLastOutcome for an exact class instead.
const PARK_AMBIGUOUS_RULE = Object.freeze({
  id: 'R-PARK-CODE-AMBIGUOUS',
  class: 'unknown',
  summary: 'park-only: item.lastOutcome does not carry the transient/detail/snapshot context this code needs for attribution; unknown unless the caller supplies the full lane record.'
});

// Roster self-failure events: always unknown, always excluded from statistics.
const ROSTER_ERROR_RULE = Object.freeze({
  id: 'R-ROSTER-ERROR',
  class: 'unknown',
  summary: "kind='roster-error': the roster's own failure, logged as data; always class unknown, excluded from all statistics."
});

const RULE_IDS = Object.freeze(new Set([
  ...LANE_OUTCOME_RULES.map(rule => rule.id),
  ...REVIEW_VERDICT_RULES.map(rule => rule.id),
  PARK_AMBIGUOUS_RULE.id,
  ROSTER_ERROR_RULE.id
]));

// --------------------------------------------------------------------------
// Classifiers
// --------------------------------------------------------------------------

function laneResult(rule, ctx) {
  return Object.freeze({
    class: rule.class,
    rule: rule.id,
    agentFailure: rule.agentFailure === true,
    pendingVerification: rule.pendingVerification === true,
    unseenCode: rule.recordsUnseenCode === true ? (ctx.code || null) : null
  });
}

// lane record -> { class, rule, agentFailure, pendingVerification, unseenCode }
// or null for R-DRYRUN (no event is emitted at all).
function classifyLaneOutcome(lane) {
  if (!lane || typeof lane !== 'object') {
    throw new TypeError('classifyLaneOutcome requires a lane record object.');
  }
  const ctx = laneContext(lane);
  for (const rule of LANE_OUTCOME_RULES) {
    if (!rule.when(ctx)) continue;
    if (rule.emitsEvent === false) return null;
    return laneResult(rule, ctx);
  }
  /* istanbul ignore next -- R-UNSEEN matches everything */
  throw new Error('unreachable: R-UNSEEN is a terminal catch-all');
}

// Inputs are the harness-authored markVerified history entry fields plus the
// harness-authored review record fields; the lane itself never wrote any of
// them. Returns { class, rule, success } where success is true only for an
// agent-attributable acceptance, false for an agent-attributable rejection,
// and null when there is no quality signal either way.
function classifyReviewVerdict({ verdict, unreviewable = false, servedBelowFloor = null, reviewState = null, reason = null } = {}) {
  const ctx = { verdict, unreviewable, servedBelowFloor, reviewState, reason };
  for (const rule of REVIEW_VERDICT_RULES) {
    if (!rule.when(ctx)) continue;
    let success = null;
    if (rule.id === 'V-AGENT') success = verdict === 'accepted';
    if (rule.id === 'V-BELOW-FLOOR') success = false; // never an agent success
    return Object.freeze({ class: rule.class, rule: rule.id, success });
  }
  /* istanbul ignore next -- V-UNSEEN matches everything */
  throw new Error('unreachable: V-UNSEEN is a terminal catch-all');
}

// Park attribution is INFORMATIONAL only (the underlying lane outcomes already
// carry the signal; counting both would double-count). Contract: the class of
// item.lastOutcome.code via the lane-outcome table. When the full lane record
// is supplied it is used for exactness; otherwise codes whose class needs
// context the park record does not carry map to R-PARK-CODE-AMBIGUOUS/unknown.
// Returns null (no event) only for DRY_RUN.
function classifyParkLastOutcome(lastOutcome, { lane = null } = {}) {
  if (lane && typeof lane === 'object') {
    // A lane supplied alongside a park record is only evidence for that park
    // when both records name the same lane and outcome.  Without this fence a
    // failed/stale lookup can pair unrelated records and turn "could not link
    // the park to its lane" into the other lane's definite attribution.
    const lastLaneId = lastOutcome && typeof lastOutcome.laneId === 'string' && lastOutcome.laneId
      ? lastOutcome.laneId
      : null;
    const laneId = typeof lane.laneId === 'string' && lane.laneId ? lane.laneId : null;
    const lastCode = lastOutcome && typeof lastOutcome.code === 'string' && lastOutcome.code
      ? lastOutcome.code
      : null;
    const laneCode = lane.outcome && typeof lane.outcome === 'object'
      && typeof lane.outcome.code === 'string' && lane.outcome.code
      ? lane.outcome.code
      : null;
    if (lastLaneId === null || laneId === null || lastLaneId !== laneId || lastCode !== laneCode) {
      return parkAmbiguousResult();
    }
    const exact = classifyLaneOutcome(lane);
    if (exact !== null) return exact;
    return null; // dry-run lane: no event
  }
  const code = lastOutcome && typeof lastOutcome.code === 'string' && lastOutcome.code
    ? lastOutcome.code
    : null;
  if (code === 'DRY_RUN') return null;
  if (!code) {
    if (lastOutcome && lastOutcome.processExitOk === true) {
      return laneResult(findLaneRule('R-OK-PENDING'), { code: null });
    }
    return laneResult(findLaneRule('R-SPARSE'), { code: null });
  }
  const CODE_DETERMINED = {
    FLEET_VERTEX_PROJECT_MISSING: 'R-FVPM',
    DISPATCH_BLOCKED_STALE_SNAPSHOT: 'R-STALE-SNAPSHOT',
    LANE_THREW: 'R-LANE-THREW',
    SPAWN_THREW: 'R-SPAWN-THREW',
    TIMEOUT: 'R-TIMEOUT'
  };
  if (CODE_DETERMINED[code]) {
    return laneResult(findLaneRule(CODE_DETERMINED[code]), { code });
  }
  if (code === 'EXIT_NONZERO') {
    // Needs transient/detail/snapshot context the park record does not carry.
    return parkAmbiguousResult();
  }
  return laneResult(findLaneRule('R-UNSEEN'), { code });
}

function parkAmbiguousResult() {
  return Object.freeze({
    class: PARK_AMBIGUOUS_RULE.class,
    rule: PARK_AMBIGUOUS_RULE.id,
    agentFailure: false,
    pendingVerification: false,
    unseenCode: null
  });
}

function findLaneRule(id) {
  const rule = LANE_OUTCOME_RULES.find(candidate => candidate.id === id);
  /* istanbul ignore next */
  if (!rule) throw new Error(`unknown lane rule id: ${id}`);
  return rule;
}

// --------------------------------------------------------------------------
// Printable rule table for the CLI (data only, no functions)
// --------------------------------------------------------------------------

function ruleTable() {
  const rows = [];
  for (const rule of LANE_OUTCOME_RULES) {
    rows.push({
      id: rule.id,
      appliesTo: 'lane-outcome',
      class: rule.emitsEvent === false ? 'no-event' : rule.class,
      agentFailure: rule.agentFailure === true,
      pendingVerification: rule.pendingVerification === true,
      recordsUnseenCode: rule.recordsUnseenCode === true,
      summary: rule.summary
    });
  }
  for (const rule of REVIEW_VERDICT_RULES) {
    rows.push({ id: rule.id, appliesTo: 'review-verdict', class: rule.class, summary: rule.summary });
  }
  rows.push({ id: PARK_AMBIGUOUS_RULE.id, appliesTo: 'park', class: PARK_AMBIGUOUS_RULE.class, summary: PARK_AMBIGUOUS_RULE.summary });
  rows.push({ id: ROSTER_ERROR_RULE.id, appliesTo: 'roster-error', class: ROSTER_ERROR_RULE.class, summary: ROSTER_ERROR_RULE.summary });
  return rows;
}

module.exports = {
  CLASSES,
  RULE_IDS,
  LANE_OUTCOME_RULES,
  REVIEW_VERDICT_RULES,
  PARK_AMBIGUOUS_RULE,
  ROSTER_ERROR_RULE,
  TRANSIENT_DETAIL_RE,
  MODEL_UNAVAILABLE_RE,
  NO_ARTIFACT_PREFIX,
  POLICY_BLOCKED_PREFIX,
  snapshotProvenOf,
  classifyLaneOutcome,
  classifyReviewVerdict,
  classifyParkLastOutcome,
  ruleTable
};
