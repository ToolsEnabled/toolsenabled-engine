'use strict';

// The persistent fleet supervisor.
//
// WHAT WAS MISSING (the owner's complaint, 2026-07-28: "the gemini lanes are
// not running though? why not i thought you told me like 15 were running"):
// `tools/gemini-fleet.js` is one-shot. `main()` launches a batch with
// Promise.all, prints a summary, removes the worktrees and exits. There is no
// loop, no queue consumer, no relaunch and no persistent state, so when lanes
// finish nothing starts more work. Every "and then later, start the next one"
// closed through the interactive controller session, which only runs when the
// owner sends a message -- so it silently never happened.
//
// This module is the missing owner of that loop. It:
//   * keeps N lanes filled from BUILD-QUEUE.md's open phases (never invents work),
//   * claims items atomically through the on-disk lock in state.js,
//   * survives restart by reconciling durable state instead of re-dispatching,
//   * caps retries and parks permanently-failing items with a reason,
//   * refuses to run outward work while KILLSWITCH is present,
//   * reports a lane it cannot observe as `unknown`, never as running,
//   * and can only delete worktrees it can prove it created (worktree.js).

const fs = require('node:fs');
const path = require('node:path');
const { types: utilTypes } = require('node:util');

const queueReader = require('./queue.js');
const stateStore = require('./state.js');
const worktrees = require('./worktree.js');
const laneModels = require('./lane-models.js');
const modelReceipt = require('./model-receipt.js');
const directVertexReceipt = require('./direct-vertex-receipt.js');
const geminiReportContract = require('./gemini-report-contract.js');
// Review is required at load, but review.js only reaches for the provider
// gateway lazily, so `--status`/`--plan` stay as cheap as they were.
const reviewStage = require('./review.js');
// Planning (owner ledger R91): decomposes a whole phase into bounded
// sub-tasks before dispatch. Also lazy inside about the provider gateway
// (defaultRunPlanningLane requires lane-runner.js only when actually
// planning), so `--status`/`--plan` stay cheap.
const planningStage = require('./planning.js');

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 64;
// The owner authorizes up to 15 concurrent lanes; the doctrine says the
// binding constraint is REVIEW THROUGHPUT, not that ceiling. With the review
// stage wired, this is the ceiling and the backlog threshold is the brake.
const OWNER_AUTHORIZED_LANE_CEILING = 15;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_NO_PROGRESS_ATTEMPTS = 2;
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_LANE_TIMEOUT_MS = 20 * 60_000;
const ACTIVE_LANE_STATUSES = new Set(['starting', 'running']);

// Provider capacity/quota failures (observed live 2026-07-28: "Google Cloud
// project is experiencing high traffic and has hit its quota limits") are the
// PROVIDER's condition, not evidence the phase is unbuildable. Burning the
// item's bounded attempt budget on them parks productive items for congestion,
// so a transient failure refunds the attempt and puts the item on a short
// cooldown instead of hot-looping the congested pool. The refund itself is
// capped so a permanently-throttled environment still converges to parked.
const TRANSIENT_DETAIL_RE = /quota|rate.?limit|resource.?exhausted|high traffic|overloaded|too many requests|\b429\b|\b503\b|temporarily unavailable/i;
const TRANSIENT_REFUND_CAP = 6;
const TRANSIENT_COOLDOWN_BASE_MS = 5 * 60_000;
const TRANSIENT_COOLDOWN_MAX_MS = 30 * 60_000;
// A provider that states WHEN capacity returns is more informative than any
// backoff we could invent. Observed live 2026-07-29T00:05Z on the
// subscription CLI: "You have exhausted your capacity on this model. Your
// quota will reset after 11h43m52s." A 5-30 minute cooldown against an
// 11-hour exhaustion is ~90 pointless lane launches per item, so the stated
// window is honored instead -- bounded, because a provider string is
// untrusted input and must never be able to park the fleet indefinitely.
const QUOTA_RESET_RE = /quota will reset after\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i;
const QUOTA_RESET_MAX_MS = 24 * 60 * 60_000;

// Outcome codes that mean THE AGENT NEVER RAN: the harness refused, threw, or
// could not build the tree, all before any brief reached any model. Every one of
// these is already classed `environment-fault`/`infra-fault` by
// roster/attribution.js, whose own summaries say it outright -- "the lane never
// launched ... No agent acted", "the harness threw; the agent never got the
// brief". That classification was reporting-only, and the gap it left was
// expensive.
//
// MEASURED 2026-07-29: the accidental gitlink
// (reports/desktop-archive-2026-07-29/AI_Session_Logs) and a `git worktree add`
// path-length failure blocked 294 lanes back to back. Each reported
// changedFileCount 0 -- a truthful zero, because nothing ran -- which the
// no-progress rule read as "this phase changed zero files twice" and used to
// PARK 78 of 99 queue items permanently. The fleet then sat at 0 running lanes
// with almost nothing claimable while both faults were pure harness bugs.
//
// A zero diff from a lane that never launched is not evidence about the phase,
// exactly as the unmeasurable case below is not. So this is treated like a
// transient provider failure -- refund the attempt, leave the streak alone --
// with its OWN capped budget so a permanently broken harness still converges to
// parked instead of retrying forever, and so it cannot spend the transient
// budget that congestion needs. No cooldown: a harness fault does not heal by
// waiting, and the supervisor's poll interval already bounds the retry rate.
const NEVER_LAUNCHED_CODES = new Set([
  'DISPATCH_BLOCKED_STALE_SNAPSHOT', // materialization incomplete; no spawn
  'LANE_THREW',                      // harness threw around worktree setup
  'WORKTREE_MISSING',                // cwd absent at launch
  'SPAWN_THREW',                     // spawn() itself threw
  'SPAWN_FAILED',                    // child 'error' before any output
  'BRIEF_FILE_FAILED',               // the brief could not be staged
  'BASELINE_CAPTURE_FAILED',         // progress baseline could not be measured
  'INPUT_EXISTENCE_UNAVAILABLE',     // input lookup failed; absence was not established
  'COMMAND_LINE_TOO_LONG',           // refused pre-spawn by the argv preflight
  'LANE_ENV_REFUSED',                // billing/credential refusal, pre-spawn
  'FLEET_VERTEX_PROJECT_MISSING',
  'FLEET_VERTEX_CREDENTIALS_MISSING'
]);
const HARNESS_FAULT_REFUND_CAP = 6;
// The same idea one stage later: a review that could not EXECUTE is not a
// judgement of the work (review.js#UNVERIFIABLE_REASON_PREFIX explains the
// contract and the measurement). Charging it to the item's attempt budget parks
// phases nobody ever judged, so it is refunded on its own capped budget. Capped
// for the same reason as the others: a permanently unexecutable review tier must
// still converge to parked rather than cycling an item forever.
const UNREVIEWABLE_REFUND_CAP = 6;

// True when this outcome carries no information about the phase because no agent
// ever acted on it. EXIT_NONZERO and TIMEOUT are deliberately absent: there the
// agent did run, and its failure IS evidence.
function isNeverLaunchedCode(code) {
  return typeof code === 'string' && NEVER_LAUNCHED_CODES.has(code);
}

// A caller-provided `source`, verdict, or served-model string is not a
// producing-call receipt.  Direct Vertex is the one transport that can hand
// us the two raw response fields needed to bind a receipt.  Bind them here,
// where lane id, attempt, and whether an artifact actually exists are owned by
// the supervisor -- never by the caller.  This keeps the transport boundary
// narrow and prevents test-shaped events from crossing into markVerified().
function quarantinedProviderCallReceipt(receiptBase, code, reason) {
  const receipt = modelReceipt.assessModelReceipt({
    ...receiptBase,
    transport: directVertexReceipt.TRANSPORT,
    servedModel: null,
    modelEvidence: 'absent',
    responseId: null
  });
  return { ...receipt, verdict: 'quarantined', code, reason };
}

// This is the outer boundary between an untrusted runner result and the
// receipt verifier.  The nested receipt adapter has its own schema checks,
// but those do not make this wrapper safe: an extra field, inherited field,
// or accessor here used to be ignored before the verifier read its two values.
// Keep the envelope deliberately tiny and inspect descriptors before reading
// either value, so a hostile getter cannot run or leak a value into a reason.
function exactPlainDataEnvelope(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const actualKeys = Reflect.ownKeys(value);
    if (actualKeys.length !== keys.length || actualKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const envelope = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined) return null;
      // Read the descriptor's value into a fresh record rather than reading the
      // untrusted wrapper again after validation (a Proxy/getter must not get a
      // second chance to change or observe this boundary crossing).
      envelope[key] = descriptor.value;
    }
    return envelope;
  } catch {
    // Reflection can itself throw for a hostile Proxy.  It is untrusted input,
    // so that is a typed quarantine, never a supervisor crash.
    return null;
  }
}

function verifiedDirectVertexReceipt(receiptBase, binding, evidence) {
  const envelope = exactPlainDataEnvelope(evidence, ['providerCallEvent', 'rawResponse']);
  if (!envelope) {
    return quarantinedProviderCallReceipt(
      receiptBase,
      'DIRECT_VERTEX_EVIDENCE_ENVELOPE_INVALID',
      'A direct-Vertex result requires an exact plain data envelope before its receipt can be verified.'
    );
  }
  const verified = directVertexReceipt.verifyProviderCallEvent({
    providerCallEvent: envelope.providerCallEvent,
    binding,
    rawResponse: envelope.rawResponse
  });
  if (!verified.ok) {
    return quarantinedProviderCallReceipt(
      receiptBase,
      verified.code || 'DIRECT_VERTEX_RECEIPT_UNBOUND',
      'The direct-Vertex provider-call event did not match the raw response and authoritative lane binding.'
    );
  }
  const event = verified.event;
  return modelReceipt.assessModelReceipt({
    ...receiptBase,
    transport: event.transport,
    callId: event.callId,
    attemptNumber: event.attemptNumber,
    artifactProduced: event.artifactProduced,
    servedModel: event.servedModel,
    modelEvidence: event.modelEvidence,
    responseId: event.responseId
  });
}

// Q57's single receipt adjudication seam.  Callers submit only raw transport
// evidence; there is deliberately no `modelReceipt` input, no verdict field,
// and no way to promote CLI aggregates into a producing-call receipt.  The
// authoritative lane binding is constructed here from scalar lane facts, then
// direct-Vertex evidence is bound against it before model-receipt.js judges
// the observed provider fields.
function adjudicateLaneModelReceipt({
  laneId,
  attemptNumber = 1,
  artifactProduced = false,
  backend = null,
  configuredModel = null,
  reportedModels = null,
  perCallModelEvidence = null,
  directVertexEvidence = null
} = {}) {
  const binding = {
    callId: `lane:${String(laneId || '')}:attempt:${Number.isSafeInteger(attemptNumber) ? attemptNumber : 1}`,
    attemptNumber: Number.isSafeInteger(attemptNumber) && attemptNumber >= 1 ? attemptNumber : 1,
    artifactProduced: artifactProduced === true
  };
  const receiptBase = {
    laneId: typeof laneId === 'string' ? laneId : null,
    callId: binding.callId,
    callRole: 'primary',
    transport: 'gemini-cli',
    backend,
    configuredModel,
    actualRequestModel: configuredModel,
    artifactProduced: binding.artifactProduced,
    materialOutputUsed: true
  };
  const directVertexBackend = backend === 'vertex' || backend === 'vertex-seat';
  if (directVertexEvidence !== null && directVertexEvidence !== undefined) {
    return directVertexBackend
      ? verifiedDirectVertexReceipt(receiptBase, binding, directVertexEvidence)
      : quarantinedProviderCallReceipt(
        receiptBase,
        'DIRECT_VERTEX_BACKEND_MISMATCH',
        'A direct-Vertex receipt cannot be accepted for a lane whose configured backend is not Vertex.'
      );
  }
  if (perCallModelEvidence !== null && perCallModelEvidence !== undefined) {
    return quarantinedProviderCallReceipt(
      receiptBase,
      'PROVIDER_CALL_EVENT_UNBOUND',
      'Caller-provided provider-call events are not accepted without direct-Vertex raw-response binding.'
    );
  }
  return modelReceipt.assessCliModelReceipt({ ...receiptBase, reportedModels });
}

function isTransientFailureDetail(detail) {
  return typeof detail === 'string' && TRANSIENT_DETAIL_RE.test(detail);
}

// Milliseconds until the provider says capacity returns, or null when it did
// not say. Never trusted beyond QUOTA_RESET_MAX_MS.
function quotaResetDelayMs(detail) {
  if (typeof detail !== 'string') return null;
  const match = QUOTA_RESET_RE.exec(detail);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const total = ((hours * 3600) + (minutes * 60) + seconds) * 1000;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.min(total, QUOTA_RESET_MAX_MS);
}

// The graceful stop sentinel: `--stop` creates it, a serving supervisor
// notices it at the top of the next cycle, stops claiming, drains its
// in-flight lanes and exits. `--serve` refuses to START while it exists, so a
// restart is an explicit two-step (stop, then clear-stop + relaunch) instead
// of a hard kill that orphans running lanes.
function stopFileFor(repoRoot) {
  return path.join(path.resolve(repoRoot), 'state', 'fleet-supervisor.stop');
}

function activeLanes(state) {
  return Object.values(state.lanes).filter(lane => ACTIVE_LANE_STATUSES.has(lane.status));
}

function orphanWatchLanes(state) {
  return Object.values(state.lanes).filter(lane => lane.status === 'unknown' && lane.orphanWatch === true);
}

// Active lanes, watched orphans, and unresolved cleanup all reserve capacity.
function occupiedSlots(state) {
  return Object.values(state.lanes).filter(lane => ACTIVE_LANE_STATUSES.has(lane.status)
    || (lane.status === 'unknown' && lane.orphanWatch === true)
    || stateStore.hasUnprovenCleanup(lane)).length;
}

function itemIdsOverlap(left, right) {
  const a = String(left), b = String(right);
  if (a === b) return true;
  const phaseA = a.split('::')[0], phaseB = b.split('::')[0];
  return phaseA === phaseB && (a === phaseA || b === phaseB);
}

function hasCleanupHoldForItem(state, itemId) {
  return stateStore.hasUnprovenCleanup(state.plans?.[String(itemId).split('::')[0]])
    || Object.values(state.lanes).some(lane => itemIdsOverlap(lane.itemId, itemId)
      && stateStore.hasUnprovenCleanup(lane));
}

// Unknown native custody is a durable hold, not a failed attempt. One dead
// wrapper PID cannot prove that all descendants stopped; automatic paths must
// retain both the record and its resources until separate cleanup is proved.
function holdLaneCustody(state, lane, stamp, details = {}) {
  const firstHold = lane.cleanupUnproven !== true;
  lane.status = 'unknown';
  lane.cleanupUnproven = true;
  lane.orphanWatch = true;
  lane.unknownReason = 'cleanup-unproven';
  lane.changedFileCount = null;
  lane.outcome = { ...lane.outcome, processExitOk: null, ok: false, code: 'CLEANUP_UNPROVEN',
    cleanupConfirmed: false, neverLaunched: false, transient: false,
    detail: details.detail == null ? lane.outcome?.detail || null : String(details.detail).slice(0, 400),
    durationMs: details.durationMs ?? lane.outcome?.durationMs ?? null };
  if (details.retainedScratch) lane.outcome.retainedScratch = details.retainedScratch;
  if (details.billing) lane.billing = details.billing;
  const item = stateStore.itemRecord(state, lane.itemId);
  item.condition = 'parked';
  item.parkedReason = 'cleanup-unproven: native process custody must be resolved before retry or worktree disposal';
  item.parkedAt = item.parkedAt || stamp;
  if (!item.claimedByLaneId || item.claimedByLaneId === lane.laneId) item.claimedByLaneId = lane.laneId;
  item.lastUpdatedAt = stamp;
  item.lastOutcome = { laneId: lane.laneId, processExitOk: null, code: 'CLEANUP_UNPROVEN',
    changedFileCount: null, verification: 'unverified', at: stamp };
  if (firstHold) state.history.push({ event: 'lane-custody-held', laneId: lane.laneId,
    itemId: lane.itemId, code: 'CLEANUP_UNPROVEN', at: stamp });
  return { lane, item };
}

// Reconcile durable state against observable process state. Native cleanup
// holds survive restart and are never released by PID disappearance alone.
function reconcile(stateFile, {
  supervisorId,
  inFlightLaneIds = new Set(),
  isAlive = stateStore.pidAlive,
  now = () => new Date(),
  storeOptions = {}
} = {}) {
  return stateStore.withState(stateFile, state => {
    const transitions = [];
    const stamp = now().toISOString();

    for (const lane of Object.values(state.lanes)) {
      if (stateStore.hasUnprovenCleanup(lane)) {
        const newlyHeld = lane.cleanupUnproven !== true;
        holdLaneCustody(state, lane, stamp);
        if (newlyHeld) transitions.push({ laneId: lane.laneId, to: 'unknown', reason: lane.unknownReason });
        continue;
      }
      if (lane.status === 'succeeded' || lane.status === 'failed' || lane.status === 'refused') continue;

      const ownedByThisProcess = lane.supervisorId === supervisorId && inFlightLaneIds.has(lane.laneId);
      if (ownedByThisProcess) continue;
      // Native preparation precedes onStart, so a live owner can still hold
      // a valid claim without a root/wrapper PID in this durable record.
      if (lane.status === 'starting' && !lane.pid && lane.supervisorPid && isAlive(lane.supervisorPid)) continue;
      if (lane.pidKind === 'native-wrapper') {
        holdLaneCustody(state, lane, stamp, { detail: 'Supervisor lost the native wrapper receipt before cleanup was proved.' });
        transitions.push({ laneId: lane.laneId, to: 'unknown', reason: lane.unknownReason });
        continue;
      }

      if (lane.status === 'unknown') {
        if (lane.orphanWatch !== true) continue;
        if (lane.pid && isAlive(lane.pid)) continue; // still running somewhere; item stays claimed
        lane.orphanWatch = false;
        lane.unknownReason = 'orphan-process-exited-outcome-never-observed';
        lane.endedAt = lane.endedAt || stamp;
        releaseItem(state, lane, stamp);
        transitions.push({ laneId: lane.laneId, to: 'unknown', reason: lane.unknownReason });
        continue;
      }

      // Not ours (previous supervisor instance, or ours but no longer tracked):
      // we have no handle on its stdout or exit code, so its OUTCOME is by
      // definition unobserved. Never keep calling it running.
      lane.status = 'unknown';
      lane.endedAt = lane.endedAt || stamp;
      if (lane.pid && isAlive(lane.pid)) {
        lane.orphanWatch = true;
        lane.unknownReason = 'orphan-process-still-alive-outcome-unobservable';
        const item = stateStore.itemRecord(state, lane.itemId);
        item.condition = 'orphaned';
        item.claimedByLaneId = lane.laneId;
        item.lastUpdatedAt = stamp;
      } else {
        lane.orphanWatch = false;
        lane.unknownReason = 'supervisor-exited-before-outcome-was-observed';
        releaseItem(state, lane, stamp);
      }
      transitions.push({ laneId: lane.laneId, to: 'unknown', reason: lane.unknownReason });
    }

    // Bound the lane map so days of turnover at 15 lanes cannot grow the state
    // file without limit. Never drops a live, watched, or unreviewed lane.
    const pruned = stateStore.pruneLanes(state);
    if (pruned > 0) transitions.push({ pruned });

    return { state, result: transitions };
  }, storeOptions);
}

function releaseItem(state, lane, stamp) {
  const item = stateStore.itemRecord(state, lane.itemId);
  if (item.claimedByLaneId && item.claimedByLaneId !== lane.laneId) return;
  item.claimedByLaneId = null;
  item.lastUpdatedAt = stamp;
  if (item.condition === 'parked') return;
  item.condition = 'idle';
}

function parkDecision(item, { maxAttempts, maxNoProgressAttempts }) {
  if (item.noProgressAttempts >= maxNoProgressAttempts) {
    return `no-progress: ${item.noProgressAttempts} consecutive attempts changed zero files`;
  }
  if (item.attempts >= maxAttempts) {
    return `attempt-cap-reached: ${item.attempts} of ${maxAttempts} attempts used without the phase leaving the open set`;
  }
  return null;
}

// Atomically take the lowest-numbered eligible open phase. Two lanes -- in one
// process or in two -- can never take the same item, because the whole
// read-decide-write runs inside the exclusive state lock.
function claimNext(stateFile, {
  openItemIds,
  laneId,
  // Preferred over `laneId`: called with the item ACTUALLY being claimed, so
  // lane ids and worktree names carry the right item slug. The fixed `laneId`
  // path named every lane after openItemIds[0] (all lanes came out "q17-*"
  // regardless of item), which made retries unreadable on disk.
  laneIdFor = null,
  supervisorId,
  concurrency = DEFAULT_CONCURRENCY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxNoProgressAttempts = DEFAULT_MAX_NO_PROGRESS_ATTEMPTS,
  // The review brake. When set, the fleet refuses to claim more work while
  // this many lanes are already waiting for a verdict. Checked INSIDE the
  // state lock so two supervisors cannot each see room and both launch.
  // null = no brake (the pre-review fixed-cap behaviour).
  reviewBacklogThreshold = null,
  laneProvider = reviewStage.DEFAULT_LANE_PROVIDER,
  now = () => new Date(),
  storeOptions = {}
} = {}) {
  return stateStore.withState(stateFile, state => {
    if (occupiedSlots(state) >= concurrency) {
      return { state, result: { claimed: null, reason: 'concurrency-full' } };
    }
    if (Number.isFinite(reviewBacklogThreshold)) {
      const backlog = reviewStage.reviewBacklog(state);
      if (backlog >= reviewBacklogThreshold) {
        // Unreviewed output is inventory, not progress (doctrine). Building
        // more of it while the review tier is behind is the exact thing the
        // owner's 15-lane authorization was conditional on not doing.
        //
        // But there are two very different reasons to be here. A backlog of
        // LIVE lanes drains itself and the right response is patience. A
        // backlog with nothing drainable left never drains -- no reviewer can
        // claim any of it -- and the fleet is wedged until a human intervenes.
        // Both used to report `review-backlog-full`, so a permanent stop was
        // indistinguishable from a busy minute in the log.
        const stalled = reviewStage.stalledReviewLanes(state).map(lane => lane.laneId);
        const drainable = backlog - stalled.length;
        return {
          state,
          result: {
            claimed: null,
            reason: drainable > 0 ? 'review-backlog-full' : 'review-tier-wedged',
            backlog,
            drainable,
            stalled,
            reviewBacklogThreshold
          }
        };
      }
    }
    if (!laneIdFor && state.lanes[laneId]) {
      return { state, result: { claimed: null, reason: 'lane-id-already-used' } };
    }
    const stamp = now().toISOString();
    for (const itemId of openItemIds) {
      if (hasCleanupHoldForItem(state, itemId)) continue;
      const item = stateStore.itemRecord(state, itemId);
      if (item.condition !== 'idle') continue;
      // A cooling item is deliberately skipped, not parked: the provider was
      // congested, and ISO-8601 strings compare correctly as strings.
      if (typeof item.cooldownUntil === 'string' && stamp < item.cooldownUntil) continue;
      const park = parkDecision(item, { maxAttempts, maxNoProgressAttempts });
      if (park) {
        item.condition = 'parked';
        item.parkedReason = park;
        item.parkedAt = stamp;
        item.lastUpdatedAt = stamp;
        continue;
      }
      const chosenLaneId = laneIdFor ? laneIdFor(itemId) : laneId;
      if (state.lanes[chosenLaneId]) {
        return { state, result: { claimed: null, reason: 'lane-id-already-used' } };
      }
      item.attempts += 1;
      item.condition = 'claimed';
      item.claimedByLaneId = chosenLaneId;
      item.lastUpdatedAt = stamp;
      state.lanes[chosenLaneId] = {
        laneId: chosenLaneId,
        itemId,
        attempt: item.attempts,
        // Recorded at claim time so the review stage can refuse to let a
        // provider review its own family's work without re-deriving it later.
        provider: laneProvider,
        status: 'starting',
        supervisorId,
        supervisorPid: process.pid,
        pid: null,
        worktree: null,
        startedAt: stamp,
        endedAt: null,
        outcome: null,
        unknownReason: null,
        orphanWatch: false,
        changedFileCount: null,
        snapshot: null,
        // A lane can never verify itself. Fleet review (2026-07-28) found
        // Gemini lanes writing code against imagined schemas and then writing
        // tests that fabricate those same schemas, so "N checks passed" from a
        // lane is worth exactly nothing. Only markVerified() -- a separate
        // review stage with a named reviewer -- may move this.
        verification: {
          state: 'unverified',
          reason: 'lane self-report is not evidence; a separate review stage must verify',
          reviewer: null,
          verdict: null,
          at: null
        }
      };
      return { state, result: { claimed: { laneId: chosenLaneId, itemId, attempt: item.attempts }, reason: null } };
    }
    return { state, result: { claimed: null, reason: 'no-eligible-item' } };
  }, storeOptions);
}

function recordLaneStarted(stateFile, laneId, { pid = null, pidKind = null, worktree = null, model = null, project = null, backend = null, now = () => new Date(), storeOptions = {} } = {}) {
  return stateStore.withState(stateFile, state => {
    const lane = state.lanes[laneId];
    if (!lane) return { state, result: null };
    if (stateStore.hasUnprovenCleanup(lane)) return { state, result: lane };
    lane.status = 'running';
    lane.pid = Number.isSafeInteger(pid) ? pid : null;
    if (pidKind === 'native-wrapper' || pidKind === 'process') lane.pidKind = pidKind;
    lane.worktree = worktree;
    if (typeof model === 'string' && model) lane.model = model;
    if (typeof project === 'string' && project) lane.project = project;
    if (typeof backend === 'string' && backend) lane.backend = backend;
    lane.startedAt = lane.startedAt || now().toISOString();
    return { state, result: lane };
  }, storeOptions);
}

// Record how a lane's PROCESS ended. `ok` here means "the child exited zero",
// nothing more -- not "the work is correct", not "the tests really pass". The
// lane's verification stays `unverified` no matter what it exited with.
function recordLaneOutcome(stateFile, laneId, {
  ok,
  code = null,
  detail = null,
  cleanupConfirmed = null,
  retainedScratch = null,
  changedFileCount = null,
  durationMs = null,
  snapshot = null,
  contract = null,
  reportedModels = null,
  // Legacy caller-shaped events are deliberately never trusted. They remain
  // an explicit quarantine regression path while transports are upgraded.
  perCallModelEvidence = null,
  // Direct Vertex transports must carry exactly { providerCallEvent,
  // rawResponse }. The event is re-bound against authoritative lane state
  // below; a caller cannot choose its call id, attempt, artifact flag, model,
  // or response id by attaching a verdict-shaped object.
  directVertexEvidence = null,
  reportedTokens = null,
  billing = null,
  backend = null,
  reviewPacket = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxNoProgressAttempts = DEFAULT_MAX_NO_PROGRESS_ATTEMPTS,
  now = () => new Date(),
  storeOptions = {}
} = {}) {
  return stateStore.withState(stateFile, state => {
    const lane = state.lanes[laneId];
    if (!lane) return { state, result: null };
    const stamp = now().toISOString();
    if (stateStore.hasUnprovenCleanup(lane) || stateStore.hasUnprovenCleanup({ code, cleanupConfirmed })) {
      return { state, result: holdLaneCustody(state, lane, stamp, { detail, durationMs, retainedScratch, billing }) };
    }
    const transient = !ok && isTransientFailureDetail(detail);
    const neverLaunched = !ok && isNeverLaunchedCode(code);
    lane.status = ok ? 'succeeded' : 'failed';
    lane.endedAt = stamp;
    lane.orphanWatch = false;
    lane.changedFileCount = Number.isFinite(changedFileCount) ? changedFileCount : null;
    if (snapshot) lane.snapshot = snapshot;
    if (contract) lane.contract = contract;
    // Where this lane's work was preserved before its worktree could be
    // cleaned up. Without this, "awaiting review" would mean "awaiting review
    // of something that no longer exists".
    if (reviewPacket) lane.reviewPacket = reviewPacket;
    // A lane-level CLI model aggregate is diagnostic only, never proof of
    // which producing call served the artifact.  The Q57 receipt adjudicator
    // quarantines every non-empty aggregate as unattributable (including a
    // one-model aggregate) until the CLI transport exposes a true per-call
    // event.  Empty aggregates remain the distinct missing-evidence case.
    const resolvedBackend = backend || lane.backend || (lane.billing && lane.billing.backend) || null;
    // The current CLI runner returns null because its JSON output exposes
    // invocation aggregates only; that path remains quarantined. Any legacy
    // caller-shaped event is *also* quarantined: source/verdict strings are
    // assertions, not a binding proof. Direct Vertex is accepted only through
    // the strict adapter above, after it is compared with the raw two-field
    // response and our authoritative lane binding.
    const callReceipt = adjudicateLaneModelReceipt({
      laneId,
      attemptNumber: lane.attempt || 1,
      artifactProduced: Number.isFinite(changedFileCount) && changedFileCount > 0,
      backend: resolvedBackend,
      configuredModel: lane.model || null,
      reportedModels,
      perCallModelEvidence,
      directVertexEvidence
    });
    lane.outcome = {
      // Named so no dashboard can read it as "this work is good".
      processExitOk: Boolean(ok),
      ok: Boolean(ok),
      code,
      transient,
      // The agent never ran. Recorded so a dashboard, the roster, and any later
      // repair pass can tell "this phase was tried and produced nothing" from
      // "this phase was never tried" without re-deriving it from the code.
      neverLaunched,
      // What the CLI says actually SERVED the lane. If this disagrees with
      // lane.model, the provider silently downgraded (observed live under
      // quota congestion) and the review stage must treat the output as
      // below-floor work, not accept it.
      reportedModels: Array.isArray(reportedModels) ? reportedModels.slice(0, 8) : null,
      // This is the authoritative per-lane acceptance evidence.  It includes
      // the actual served model when observed; it is deliberately not derived
      // from the configured/requested model.
      modelReceipt: callReceipt,
      // Non-empty => the provider served something OFF the backend's floor
      // (the silent flash-lite case). null => the CLI reported nothing, which
      // is UNKNOWN, not compliant, and must not be read as a pass.
      servedBelowFloor: laneModels.servedBelowFloor(resolvedBackend || 'subscription', reportedModels),
      // The CLI's OWN token total for this lane. Persisted so credit burn is
      // measured from what the provider reported, never estimated afterwards
      // from wall-clock (owner order R77: the $300 must be measurably spent
      // before 2026-10-25).
      reportedTokens: Number.isFinite(reportedTokens) ? reportedTokens : null,
      detail: detail === null ? null : String(detail).slice(0, 400),
      durationMs
    };
    if (billing) lane.billing = billing;
    if (!lane.verification) {
      lane.verification = { state: 'unverified', reason: null, reviewer: null, verdict: null, at: null };
    }
    lane.verification.state = 'unverified';
    lane.verification.reason = 'lane self-report is not evidence; a separate review stage must verify';

    const item = stateStore.itemRecord(state, lane.itemId);
    // A transient provider failure (quota/capacity) is the PROVIDER's fault,
    // not the item's: refund the attempt (capped) and set a bounded cooldown
    // so the item is neither parked for congestion nor hot-looped into it.
    if (transient) {
      item.transientFailures = (item.transientFailures || 0) + 1;
      if (item.transientFailures <= TRANSIENT_REFUND_CAP) {
        item.attempts = Math.max(0, item.attempts - 1);
      }
      // Prefer the provider's own stated reset window over our backoff guess.
      const stated = quotaResetDelayMs(detail);
      const coolMs = stated === null
        ? Math.min(TRANSIENT_COOLDOWN_MAX_MS, TRANSIENT_COOLDOWN_BASE_MS * item.transientFailures)
        : stated;
      item.cooldownUntil = new Date(now().getTime() + coolMs).toISOString();
      item.cooldownSource = stated === null ? 'supervisor-backoff' : 'provider-stated-reset';
    }
    // An UNMEASURABLE diff is not the same as a zero diff. Counting it as zero
    // would park a productive item for "no progress" on the strength of a
    // failed git call, so an unmeasurable attempt moves the streak neither way.
    // A lane that never launched is refunded on its own budget (see
    // NEVER_LAUNCHED_CODES): the harness failed, the phase was never tried.
    if (neverLaunched) {
      item.harnessFaults = (item.harnessFaults || 0) + 1;
      if (item.harnessFaults <= HARNESS_FAULT_REFUND_CAP) {
        item.attempts = Math.max(0, item.attempts - 1);
      }
    }
    const measurable = Number.isFinite(changedFileCount);
    const madeProgress = measurable && changedFileCount > 0;
    if (!measurable) item.unmeasuredAttempts = (item.unmeasuredAttempts || 0) + 1;
    else if (madeProgress) item.noProgressAttempts = 0;
    else if (!transient && !neverLaunched) item.noProgressAttempts += 1;
    if (madeProgress && ok) {
      item.unreviewedOutputs = (item.unreviewedOutputs || 0) + 1;
      item.lastUnreviewedLaneId = laneId;
    }
    item.lastOutcome = {
      laneId, processExitOk: Boolean(ok), code, changedFileCount: lane.changedFileCount,
      // Read from the lane rather than hardcoded. It IS 'unverified' at this
      // instant -- a process exit is not a verdict -- but markVerified() now
      // updates it in place when a verdict lands, so this stops being a
      // permanent lie about every lane that was later reviewed.
      verification: (lane.verification && lane.verification.state) || 'unverified',
      at: stamp
    };
    item.claimedByLaneId = null;
    item.lastUpdatedAt = stamp;

    const park = parkDecision(item, { maxAttempts, maxNoProgressAttempts });
    if (park) {
      item.condition = 'parked';
      item.parkedReason = park;
      item.parkedAt = stamp;
    } else {
      item.condition = 'idle';
    }

    // HISTORY IS THE ONLY RECORD THAT SURVIVES pruneLanes(). It used to carry
    // `verification: 'unverified'` hardcoded and no model attribution at all,
    // which made "does gemini-2.5-pro on Vertex produce work that passes review
    // more often than the subscription path" structurally unanswerable from our
    // own data -- the exact question that decides how the $300 credit is spent.
    // Two things fix it: stamp WHICH MODEL/BACKEND produced the lane here, and
    // emit a second event from markVerified() when the verdict actually lands.
    state.history.push({
      event: 'lane-outcome',
      laneId, itemId: lane.itemId, attempt: lane.attempt, processExitOk: Boolean(ok), code,
      transient,
      neverLaunched,
      changedFileCount: lane.changedFileCount, durationMs, at: stamp,
      provider: lane.provider || null,
      model: lane.model || null,
      backend: lane.backend || (lane.billing && lane.billing.backend) || null,
      reportedModels: lane.outcome.reportedModels,
      servedBelowFloor: lane.outcome.servedBelowFloor,
      reportedTokens: lane.outcome.reportedTokens,
      // Honest at this instant, and no longer frozen: the verification event
      // below carries the outcome a reviewer later reached.
      verification: (lane.verification && lane.verification.state) || 'unverified',
      parked: park ? item.parkedReason : null
    });
    return { state, result: { lane, item } };
  }, storeOptions);
}

// The ONLY way a lane's output becomes verified. Requires a named reviewer that
// is not the lane itself, so a lane cannot mark its own work good by any path.
function markVerified(stateFile, laneId, {
  reviewer,
  verdict,
  note = null,
  // Which rubric produced this verdict, and the threshold actually applied.
  // Without them, editing the review prompt silently makes every prior verdict
  // incomparable to every later one and no aggregation can say so.
  rubricVersion = null,
  score = null,
  scoreThreshold = null,
  evidenceVerified = null,
  unreviewable = false,
  now = () => new Date(),
  storeOptions = {}
} = {}) {
  if (typeof reviewer !== 'string' || !reviewer.trim()) throw new Error('markVerified requires a named reviewer.');
  if (reviewer === laneId) throw new Error('A lane cannot verify itself.');
  if (verdict !== 'accepted' && verdict !== 'rejected') {
    throw new Error("markVerified verdict must be 'accepted' or 'rejected'.");
  }
  return stateStore.withState(stateFile, state => {
    const lane = state.lanes[laneId];
    if (!lane) return { state, result: null };
    // This is the terminal state transition to merge eligibility.  Review.js
    // rejects an open receipt before it gets here, but retain this guard so a
    // direct caller cannot bypass the review harness and convert UNKNOWN,
    // ambiguous, or below-floor served-model evidence into an acceptance.
    if (verdict === 'accepted') {
      const receipt = lane.outcome && lane.outcome.modelReceipt;
      if (!receipt || receipt.verdict !== 'accepted' || receipt.observed !== true || !receipt.servedModel) {
        throw new Error('MODEL_RECEIPT_REQUIRED_FOR_ACCEPTANCE: a lane cannot be accepted without observed on-floor served-model evidence.');
      }
    }
    const stamp = now().toISOString();
    lane.verification = {
      state: verdict === 'accepted' ? 'verified' : 'rejected',
      reason: note === null ? null : String(note).slice(0, 400),
      reviewer,
      verdict,
      rubricVersion: Number.isFinite(rubricVersion) ? rubricVersion : null,
      score: Number.isFinite(score) ? score : null,
      scoreThreshold: Number.isFinite(scoreThreshold) ? scoreThreshold : null,
      // Did the HARNESS re-run the reviewer's own command and see what the
      // reviewer said it saw? null means "not applicable" (a rejection needs no
      // execution evidence); false must never reach here -- an unverified
      // acceptance is discarded upstream rather than recorded.
      evidenceVerified: typeof evidenceVerified === 'boolean' ? evidenceVerified : null,
      // Carried on the lane too, not only in the history event: a reader looking
      // at `lane.verification` must be able to tell "judged and rejected" from
      // "no reviewer could execute" without joining to history.
      unreviewable: unreviewable === true,
      at: stamp
    };
    const item = stateStore.itemRecord(state, lane.itemId);
    if (item.unreviewedOutputs > 0) item.unreviewedOutputs -= 1;
    // A rejection that only records "the reviewer could not run" is retracted
    // evidence, not a verdict: refund the attempt it was charged to.
    if (verdict === 'rejected' && unreviewable === true) {
      item.unreviewableVerdicts = (item.unreviewableVerdicts || 0) + 1;
      if (item.unreviewableVerdicts <= UNREVIEWABLE_REFUND_CAP) {
        item.attempts = Math.max(0, (item.attempts || 0) - 1);
        // The park this attempt helped justify was built on evidence that has
        // just been withdrawn, so it cannot stand. Releasing to 'idle' is safe
        // rather than optimistic: claimNext() re-runs parkDecision() before it
        // hands the item to anyone, and re-parks immediately if the budget is
        // genuinely spent. Only an attempt-cap park is released -- a
        // no-progress park rests on lanes that DID run and is untouched.
        if (item.condition === 'parked' && /^attempt-cap-reached/.test(String(item.parkedReason || ''))) {
          item.condition = 'idle';
          item.parkedReason = null;
          item.parkedAt = null;
          item.unparkedNote = 'released: the attempt-cap park counted reviews that never executed '
            + `(${item.unreviewableVerdicts} unreviewable verdict(s))`;
        }
      }
    }
    // The item's own last-outcome summary stops claiming 'unverified' forever.
    if (item.lastOutcome && item.lastOutcome.laneId === laneId) {
      item.lastOutcome.verification = lane.verification.state;
      item.lastOutcome.verdict = verdict;
      item.lastOutcome.reviewer = reviewer;
    }
    // The second history event. THIS is what makes per-model pass rates
    // computable: verdict, reviewer and the model that produced the work, on
    // the one log that outlives pruneLanes().
    state.history.push({
      event: 'verification',
      laneId,
      itemId: lane.itemId,
      attempt: lane.attempt,
      verdict,
      verification: lane.verification.state,
      reviewer,
      rubricVersion: Number.isFinite(rubricVersion) ? rubricVersion : null,
      score: Number.isFinite(score) ? score : null,
      scoreThreshold: Number.isFinite(scoreThreshold) ? scoreThreshold : null,
      evidenceVerified: typeof evidenceVerified === 'boolean' ? evidenceVerified : null,
      unreviewable: unreviewable === true,
      provider: lane.provider || null,
      model: lane.model || null,
      backend: lane.backend || (lane.billing && lane.billing.backend) || null,
      servedBelowFloor: (lane.outcome && lane.outcome.servedBelowFloor) || null,
      at: stamp
    });
    return { state, result: lane.verification };
  }, storeOptions);
}

// Per-model review outcomes, computed from the append-only history rather than
// from `lanes` (which pruneLanes() empties). This is the answer to "which model
// produces work that passes review" -- unanswerable before the two history
// edits above. Counts only; nothing here estimates a rate it cannot measure.
function verdictsByModel(state) {
  const rows = new Map();
  const key = entry => `${entry.backend || 'unknown-backend'}|${entry.model || 'unknown-model'}`;
  for (const entry of (state && state.history) || []) {
    if (entry.event !== 'verification') continue;
    const id = key(entry);
    if (!rows.has(id)) {
      rows.set(id, {
        backend: entry.backend || null, model: entry.model || null, provider: entry.provider || null,
        accepted: 0, rejected: 0, unreviewable: 0, belowFloor: 0,
        scored: 0, scoreSum: 0, meanScore: null, rubricVersions: []
      });
    }
    const row = rows.get(id);
    if (entry.unreviewable) row.unreviewable += 1;
    else if (Array.isArray(entry.servedBelowFloor) && entry.servedBelowFloor.length) row.belowFloor += 1;
    else if (entry.verdict === 'accepted') row.accepted += 1;
    else if (entry.verdict === 'rejected') row.rejected += 1;
    // The score of a review that never executed is not a score. Counting it
    // kept meanScore poisoned even after the accept/reject counts were made
    // honest: 44 unreviewable entries carrying score 0 held this model's mean
    // at 0.000 on 2026-07-29 while no reviewer had run a single command.
    if (!entry.unreviewable && Number.isFinite(entry.score)) {
      row.scored += 1;
      row.scoreSum += entry.score;
    }
    if (Number.isFinite(entry.rubricVersion) && !row.rubricVersions.includes(entry.rubricVersion)) {
      row.rubricVersions.push(entry.rubricVersion);
    }
  }
  return [...rows.values()].map(row => ({
    ...row,
    meanScore: row.scored ? Number((row.scoreSum / row.scored).toFixed(4)) : null,
    // A pass rate computed across two rubric versions is not one number, and
    // saying so is cheaper than discovering it later in a chart.
    mixedRubricVersions: row.rubricVersions.length > 1
  }));
}

// Honest observable state. The running count is the count of lanes with a
// LIVE, VERIFIED process id. Anything else non-terminal lands in `unknown`.
function status(stateFile, {
  supervisorId = null,
  isAlive = stateStore.pidAlive,
  openItemIds = null,
  killSwitch = null,
  reviewBacklogThreshold = null,
  now = () => new Date(),
  storeOptions = {}
} = {}) {
  const state = stateStore.readState(stateFile, storeOptions);
  const running = [];
  const starting = [];
  const unknown = [];
  const awaitingReview = [];
  const staleSnapshotBlocked = [];
  const counts = { running: 0, starting: 0, unknown: 0, succeeded: 0, failed: 0, refused: 0 };

  const inReview = [];
  const reviewStalled = [];
  const mergeEligible = [];
  const rejected = [];
  // Owner order R58: lanes the provider served OFF the model floor. Was
  // computed on every lane outcome and read by nothing.
  const belowFloor = [];
  const servedModelUnknown = [];

  for (const lane of Object.values(state.lanes)) {
    const verification = (lane.verification && lane.verification.state) || 'unverified';
    const review = lane.review || null;
    // The SAME predicate the launch brake uses, so the number an operator
    // reads is the number that gates the fleet.
    if (reviewStage.awaitsReview(lane)) {
      awaitingReview.push({
        laneId: lane.laneId, itemId: lane.itemId, changedFileCount: lane.changedFileCount,
        endedAt: lane.endedAt,
        reviewState: review ? review.state : 'pending',
        reviewAttempts: review ? review.attempts : 0,
        lastReviewError: review ? review.lastError : null,
        packet: (lane.reviewPacket && lane.reviewPacket.dir) || null
      });
      if (review && review.state === 'in-review') inReview.push({ laneId: lane.laneId, reviewer: review.reviewer, startedAt: review.startedAt });
      if (review && review.state === 'stalled') {
        reviewStalled.push({
          laneId: lane.laneId, itemId: lane.itemId, attempts: review.attempts,
          reclaims: review.reclaims || 0, lastError: review.lastError
        });
      }
    }
    if (verification === 'verified') {
      mergeEligible.push({
        laneId: lane.laneId, itemId: lane.itemId,
        reviewer: lane.verification.reviewer, reason: lane.verification.reason,
        worktree: lane.worktree, packet: (review && review.packetDir) || null
      });
    }
    if (verification === 'rejected') {
      rejected.push({
        laneId: lane.laneId, itemId: lane.itemId,
        reviewer: lane.verification.reviewer, reason: lane.verification.reason,
        quarantine: (review && review.packetDir) || null,
        // A rejection because nobody could SEE the work is a different fact
        // from a rejection because a reviewer judged the work wrong -- and a
        // refusal because the provider served a below-floor model is a third
        // fact again. Three labels, so no reader has to guess.
        unreviewable: Boolean(review && review.unreviewable),
        belowFloor: (review && review.belowFloor) ? review.belowFloor.servedBelowFloor : null,
        score: Number.isFinite(lane.verification.score) ? lane.verification.score : null,
        rubricVersion: Number.isFinite(lane.verification.rubricVersion) ? lane.verification.rubricVersion : null
      });
    }
    if (lane.outcome) {
      const served = lane.outcome.servedBelowFloor;
      if (Array.isArray(served) && served.length) {
        belowFloor.push({
          laneId: lane.laneId, itemId: lane.itemId,
          requestedModel: lane.model || null,
          backend: lane.backend || (lane.billing && lane.billing.backend) || null,
          servedModels: served,
          verification,
          enforced: Boolean(review && review.belowFloor)
        });
      } else if (served === null && lane.status === 'succeeded') {
        // null is UNKNOWN, not compliant. Reported separately so nobody reads
        // an empty below-floor list as proof the floor held.
        servedModelUnknown.push({ laneId: lane.laneId, itemId: lane.itemId, requestedModel: lane.model || null });
      }
    }
    if (lane.outcome && lane.outcome.code === 'DISPATCH_BLOCKED_STALE_SNAPSHOT') {
      staleSnapshotBlocked.push({ laneId: lane.laneId, itemId: lane.itemId, detail: lane.outcome.detail });
    }
    if (lane.status === 'succeeded') { counts.succeeded += 1; continue; }
    if (lane.status === 'failed') { counts.failed += 1; continue; }
    if (lane.status === 'refused') { counts.refused += 1; continue; }
    if (lane.status === 'unknown') {
      counts.unknown += 1;
      unknown.push(summarizeLane(lane));
      continue;
    }
    const supervisorLive = Number.isSafeInteger(lane.supervisorPid) ? isAlive(lane.supervisorPid) : false;
    const laneProcessLive = Number.isSafeInteger(lane.pid) && isAlive(lane.pid);

    // BOTH must be live to claim `running`. A lane process that outlived its
    // supervisor is an orphan: nobody holds its stdout or exit code, so its
    // OUTCOME is unobservable even though the process is up. Counting it as
    // running is precisely the overstatement that produced "I thought like 15
    // were running" -- so it lands in `unknown` with a reason instead. This is
    // checked here, not only in reconcile(), so a bare `--status` read from a
    // machine where no supervisor is running still tells the truth.
    if (laneProcessLive && supervisorLive) {
      counts.running += 1;
      running.push(summarizeLane(lane));
    } else if (laneProcessLive && !supervisorLive) {
      counts.unknown += 1;
      unknown.push({
        ...summarizeLane(lane),
        unknownReason: 'orphan-process-alive-but-supervisor-gone-outcome-unobservable'
      });
    } else if (lane.status === 'starting' && supervisorLive) {
      // Launched but no pid observed yet. This is NOT counted as running: the
      // whole point of this rewrite is that an unverified lane never inflates
      // the live count.
      counts.starting += 1;
      starting.push(summarizeLane(lane));
    } else {
      counts.unknown += 1;
      unknown.push({ ...summarizeLane(lane), unknownReason: lane.unknownReason || 'recorded-active-but-no-live-process-found' });
    }
  }

  // Credit-burn accounting, summed from what the PROVIDER reported per lane.
  // Deliberately reports tokens (a measured fact) and leaves dollars to the
  // caller: this repo has no verified price table for the Vertex 2.5 models,
  // and inventing one would turn an honest number into a guess.
  const burn = { vertexLanes: 0, subscriptionLanes: 0, vertexTokens: 0, subscriptionTokens: 0, lanesMissingTokenReport: 0 };
  for (const lane of Object.values(state.lanes)) {
    if (!lane.outcome) continue;
    const tokens = lane.outcome.reportedTokens;
    const isVertex = (lane.backend || (lane.billing && lane.billing.backend)) === 'vertex';
    if (isVertex) burn.vertexLanes += 1; else burn.subscriptionLanes += 1;
    if (Number.isFinite(tokens)) {
      if (isVertex) burn.vertexTokens += tokens; else burn.subscriptionTokens += tokens;
    } else {
      burn.lanesMissingTokenReport += 1;
    }
  }

  const items = { idle: 0, claimed: 0, orphaned: 0, parked: 0 };
  const parked = [];
  for (const item of Object.values(state.items)) {
    if (Object.prototype.hasOwnProperty.call(items, item.condition)) items[item.condition] += 1;
    if (item.condition === 'parked') parked.push({ itemId: item.itemId, reason: item.parkedReason, at: item.parkedAt });
  }

  return {
    generatedAt: now().toISOString(),
    stateFile,
    supervisorId,
    supervisor: state.supervisor,
    supervisorProcessAlive: state.supervisor && Number.isSafeInteger(state.supervisor.pid)
      ? isAlive(state.supervisor.pid) : false,
    laneCounts: counts,
    // Named so no reader can mistake it for "we think it is probably running".
    observedRunningLanes: running,
    startingLanes: starting,
    unknownLanes: unknown,
    itemCounts: items,
    creditBurn: burn,
    parkedItems: parked,
    // A lane exiting zero is NOT an accepted result. These are outputs no
    // reviewer has looked at yet, and they are reported as such.
    lanesAwaitingReview: awaitingReview,
    verifiedLaneCount: Object.values(state.lanes)
      .filter(lane => lane.verification && lane.verification.state === 'verified').length,
    // The review stage's own view. `launchGate` is the honest answer to "why
    // is the fleet not starting more lanes" -- the cap is review throughput.
    review: {
      backlog: awaitingReview.length,
      // How much of that backlog a reviewer could still actually claim. When
      // this is 0 and the backlog is not, reviewing harder changes nothing.
      drainable: awaitingReview.length - reviewStalled.length,
      backlogThreshold: Number.isFinite(reviewBacklogThreshold) ? reviewBacklogThreshold : null,
      inReview,
      stalled: reviewStalled,
      rubricVersion: reviewStage.REVIEW_RUBRIC_VERSION,
      scoreThreshold: reviewStage.REVIEW_SCORE_THRESHOLD,
      launchGate: Number.isFinite(reviewBacklogThreshold) && awaitingReview.length >= reviewBacklogThreshold
        ? {
          blocked: true,
          // Congestion clears itself; a wedge does not. Naming them the same
          // thing hid a permanent stop behind a routine-looking message.
          reason: awaitingReview.length > reviewStalled.length ? 'review-backlog-full' : 'review-tier-wedged'
        }
        : { blocked: false, reason: null }
    },
    // Owner order R58, now READ rather than merely recorded. A non-empty list
    // means the provider silently answered a floor-model request with something
    // cheaper; `enforced` says the review stage refused that lane for it.
    lanesServedBelowFloor: belowFloor,
    // Distinct from the above: the CLI reported no model at all. Unknown is not
    // compliant, and an empty below-floor list is not evidence the floor held.
    lanesWithUnknownServedModel: servedModelUnknown,
    // Per-(backend, model) review outcomes from the append-only history.
    verdictsByModel: verdictsByModel(state),
    // Phase decomposition (owner ledger R91). `planning` is the headline: a
    // planner that cannot RUN is reported as loudly as a wedged review tier,
    // because a silent fallback to whole-phase dispatch is indistinguishable
    // from normal operation and hid a 100%-failing planner for a whole batch.
    planning: planningHealthSummary(state),
    // Per-phase planning status and, for a `ready` plan, the "N/M sub-tasks
    // verified" rollup so the phase-level view survives dispatch moving to
    // the sub-task level.
    decomposition: phaseDecompositionSummary(state),
    // Accepted work the CONTROLLER may merge. The supervisor never merges.
    lanesEligibleForMerge: mergeEligible,
    lanesRejected: rejected,
    lanesBlockedByStaleSnapshot: staleSnapshotBlocked,
    openItemIds: Array.isArray(openItemIds) ? openItemIds : null,
    openItemCount: Array.isArray(openItemIds) ? openItemIds.length : null,
    killSwitch,
    updatedAt: state.updatedAt
  };
}

// ---------------------------------------------------------------------------
// Phase decomposition (owner ledger R91): expand open phases into claimable
// items, preferring a phase's planned sub-tasks over the whole phase.
// ---------------------------------------------------------------------------

function subtaskItemId(phaseId, subtaskId) {
  return `${phaseId}::${subtaskId}`;
}

// A whole PHASE stops being claimable because a human/controller edits
// BUILD-QUEUE.md's status line (queue.js's own documented invariant: this
// package never writes that file). A SUB-TASK has no such external file, so
// without an equivalent check here a sub-task that already succeeded would
// keep being re-claimed every tick forever (state.items never marks anything
// "done", only 'idle' | 'claimed' | 'parked' -- see state.js#itemRecord).
// Settled = a real, non-empty change landed (matches reviewStage.awaitsReview
// exactly) and the verdict is not a rejection. A REJECTED sub-task is
// deliberately left reclaimable -- rejection means "do it again", not "stop".
// A zero-diff success or an outright failure is also left reclaimable, so it
// still goes through the ordinary no-progress/attempt-cap parking path.
function isSubtaskSettled(item) {
  const outcome = item && item.lastOutcome;
  if (!outcome || outcome.processExitOk !== true) return false;
  if (!Number.isFinite(outcome.changedFileCount) || outcome.changedFileCount <= 0) return false;
  return outcome.verification !== 'rejected';
}

// Turns the open phase list into the ids claimNext() actually claims from,
// plus a lookup back to (phase, subtask) for dispatch(). A phase contributes:
//   * its planned sub-task ids that are not yet settled (see above), if
//     planning succeeded for it (`ready`)
//   * its own phase id, if planning fell back for it (`fallback`) -- the OLD
//     whole-phase behaviour, byte-identical to before this module existed
//   * nothing at all, if planning has not been attempted yet this run (or is
//     still in flight) -- the phase simply is not claimable until then; it
//     never silently degrades to whole-phase while a plan might still land.
// When planning is disabled outright, every phase behaves as fallback always
// did: this is what makes --no-planning a true return to prior behaviour.
function expandClaimableItems(openPhases, plans, { planningEnabled = true, items = null } = {}) {
  const ids = [];
  const meta = new Map();
  for (const phase of openPhases) {
    const plan = plans && plans[phase.id];
    if (stateStore.hasUnprovenCleanup(plan)) continue;
    if (!planningEnabled) {
      ids.push(phase.id);
      meta.set(phase.id, { kind: 'phase', phase });
      continue;
    }
    if (plan && plan.status === 'ready' && Array.isArray(plan.subtasks) && plan.subtasks.length) {
      const byId = new Map(plan.subtasks.map(entry => [entry.id, entry]));
      for (const subtask of plan.subtasks) {
        const itemId = subtaskItemId(phase.id, subtask.id);
        if (items && isSubtaskSettled(items[itemId])) continue;
        // Sequencing (planner `dependsOn`): a sub-task that only becomes
        // reachable once a sibling lands must not be dispatched alongside it,
        // or the fleet produces two independently-unwireable halves -- the
        // measured top cause of rejected decomposed work.
        //
        // A PARKED dependency deliberately does NOT block forever: waiting on
        // something that will never land silently removes real work from the
        // queue, which is worse than dispatching it and letting the review
        // tier judge whether it is wireable. Unknown ids are ignored rather
        // than treated as unmet, so a hallucinated dependency cannot wedge a
        // sub-task.
        const blockedBy = (subtask.dependsOn || []).filter(depId => {
          if (!byId.has(depId)) return false;
          const dep = items && items[subtaskItemId(phase.id, depId)];
          if (dep && dep.condition === 'parked') return false;
          return !(items && isSubtaskSettled(dep));
        });
        if (blockedBy.length) continue;
        ids.push(itemId);
        meta.set(itemId, { kind: 'subtask', phase, subtask, planLaneId: plan.laneId });
      }
    } else if (plan && plan.status === 'fallback') {
      ids.push(phase.id);
      meta.set(phase.id, { kind: 'phase', phase });
    }
    // else: no plan record yet (or a status this module never writes) -- the
    // phase contributes no claimable item this tick.
  }
  return { ids, meta };
}

// Read-time rollup: "Q21: 3/5 sub-tasks verified" per the owner's brief. Pure
// function of durable state -- nothing here is cached, so it can never drift
// from what markVerified()/recordLaneOutcome() actually recorded.
function phaseDecompositionSummary(state) {
  const plans = (state && state.plans) || {};
  const rows = [];
  for (const phaseId of Object.keys(plans)) {
    const plan = plans[phaseId];
    if (!plan || plan.status !== 'ready') {
      const failureClass = (plan && plan.failureClass) || null;
      const unavailable = failureClass === planningStage.FAILURE_UNAVAILABLE;
      rows.push({
        phaseId,
        status: (plan && plan.status) || 'unknown',
        // The distinction the fallback used to hide: "the planner could not
        // run at all" vs "the planner ran and this phase produced no usable
        // decomposition" are different failures with different owners.
        failureClass,
        plannerUnavailable: unavailable,
        attempts: (plan && Number.isFinite(plan.attempts)) ? plan.attempts : null,
        model: (plan && plan.model) || null,
        reason: (plan && plan.reason) || null,
        subtaskCount: 0,
        summaryLine: unavailable
          ? `${phaseId}: PLANNER UNAVAILABLE -- dispatched WHOLE-PHASE, decomposition did NOT run`
            + `${plan && plan.reason ? ` (${String(plan.reason).slice(0, 120)})` : ''}`
          : `${phaseId}: planning ${(plan && plan.status) || 'unknown'}${plan && plan.reason ? ` (${String(plan.reason).slice(0, 120)})` : ''}`
      });
      continue;
    }
    let verified = 0;
    let rejected = 0;
    let parked = 0;
    let pending = 0;
    const detail = [];
    for (const subtask of plan.subtasks) {
      const itemId = subtaskItemId(phaseId, subtask.id);
      const item = state.items ? state.items[itemId] : null;
      const verification = item && item.lastOutcome ? item.lastOutcome.verification : null;
      let bucket;
      if (verification === 'verified') { verified += 1; bucket = 'verified'; }
      else if (verification === 'rejected') { rejected += 1; bucket = 'rejected'; }
      else if (item && item.condition === 'parked') { parked += 1; bucket = 'parked'; }
      else { pending += 1; bucket = 'pending'; }
      detail.push({ subtaskId: subtask.id, title: subtask.title, itemId, bucket });
    }
    const total = plan.subtasks.length;
    rows.push({
      phaseId,
      status: 'ready',
      model: plan.model || null,
      subtaskCount: total,
      verified,
      rejected,
      parked,
      pending,
      // Every sub-task has left the open set (verified, rejected-terminal, or
      // parked) -- the phase-level view the owner asked for, computed without
      // ever writing back to BUILD-QUEUE.md (queue.js's own invariant).
      addressed: (verified + rejected + parked) === total,
      summaryLine: `${phaseId}: ${verified}/${total} sub-tasks verified`
        + (rejected ? `, ${rejected} rejected` : '')
        + (parked ? `, ${parked} parked` : '')
        + (pending ? `, ${pending} pending` : ''),
      detail
    });
  }
  return rows;
}

// One honest headline for the whole planning stage. This exists because the
// per-phase rows above are easy to skim past: a planner failing on 100% of
// phases degraded silently to whole-phase dispatch for an entire live batch
// and nothing anywhere said so. `healthy` is false whenever the planner could
// not RUN, and the headline says outright that decomposition is not happening.
function planningHealthSummary(state) {
  const plans = Object.values((state && state.plans) || {});
  const held = plans.filter(plan => stateStore.hasUnprovenCleanup(plan));
  const ready = plans.filter(plan => plan && plan.status === 'ready');
  const unavailable = plans.filter(plan => plan && plan.status !== 'ready'
    && (plan.failureClass || planningStage.FAILURE_UNAVAILABLE) === planningStage.FAILURE_UNAVAILABLE);
  const incoherent = plans.filter(plan => plan && plan.status !== 'ready'
    && plan.failureClass === planningStage.FAILURE_INCOHERENT);
  const lastUnavailable = unavailable
    .slice()
    .sort((a, b) => String(a.plannedAt || '').localeCompare(String(b.plannedAt || '')))
    .pop() || null;

  let headline;
  if (plans.length === 0) headline = 'No phase has been through the planning pass yet.';
  else if (held.length > 0) headline = `Planning custody unknown for ${held.length} phase(s); planning and dispatch remain held.`;
  else if (unavailable.length === 0) {
    headline = `Planning healthy: ${ready.length} phase(s) decomposed`
      + `${incoherent.length ? `, ${incoherent.length} produced no usable plan (whole-phase fallback)` : ''}.`;
  } else {
    headline = `PLANNER UNAVAILABLE on ${unavailable.length} of ${plans.length} phase(s) -- `
      + 'those phases are being dispatched WHOLE, so decomposition is not running for them. '
      + `Last error: ${String((lastUnavailable && lastUnavailable.reason) || 'unknown').slice(0, 200)}`;
  }

  return {
    headline,
    // False whenever the planning provider could not be reached/run at all.
    healthy: unavailable.length === 0 && held.length === 0,
    cleanupHeldPhases: held.map(plan => plan.phaseId),
    phasesPlanned: plans.length,
    decomposed: ready.length,
    subtasksPlanned: ready.reduce((total, plan) => total + ((plan.subtasks && plan.subtasks.length) || 0), 0),
    // Infrastructure failures: OUR bug or the provider's, never a statement
    // about the phase. Retried up to the planning attempt bound.
    plannerUnavailable: unavailable.length,
    plannerUnavailablePhases: unavailable.map(plan => plan.phaseId),
    // The planner really answered; the answer was unusable for this phase.
    planIncoherent: incoherent.length,
    lastUnavailableReason: (lastUnavailable && lastUnavailable.reason) || null,
    lastUnavailableModel: (lastUnavailable && lastUnavailable.model) || null
  };
}

function summarizeLane(lane) {
  return {
    laneId: lane.laneId,
    itemId: lane.itemId,
    attempt: lane.attempt,
    model: lane.model || null,
    status: lane.status,
    pid: lane.pid,
    supervisorId: lane.supervisorId,
    worktree: lane.worktree,
    startedAt: lane.startedAt,
    endedAt: lane.endedAt,
    unknownReason: lane.unknownReason || null,
    orphanWatch: lane.orphanWatch === true
  };
}

class FleetSupervisor {
  constructor({
    repoRoot,
    stateFile = null,
    queueFile = null,
    concurrency = DEFAULT_CONCURRENCY,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    maxNoProgressAttempts = DEFAULT_MAX_NO_PROGRESS_ATTEMPTS,
    pollMs = DEFAULT_POLL_MS,
    laneTimeoutMs = DEFAULT_LANE_TIMEOUT_MS,
    maxIdleCycles = 0,
    keepWorktrees = false,
    dryRun = false,
    runLane = null,
    killSwitch = null,
    isAlive = stateStore.pidAlive,
    now = () => new Date(),
    logger = () => {},
    storeOptions = {},
    supervisorId = null,
    laneModel = null,
    // Optional dedicated Google Cloud project for CLI quota; becomes the
    // lane's GOOGLE_CLOUD_PROJECT. Never hardcoded, never defaulted -- the
    // operator names it (--project / TOOLSENABLED_FLEET_PROJECT) and every
    // lane records which project it billed against.
    laneProject = null,
    // 'vertex' (default) bills the owner's Vertex credit; 'subscription'
    // uses the owner's Code Assist login.
    laneBackend = null,
    stopFile = null,
    // The review stage. OFF by default in the library so an embedder that has
    // not wired a reviewer cannot deadlock its own fleet behind a backlog
    // nothing drains; tools/fleet-supervisor.js turns it ON for the real fleet.
    review = null,
    // The planning pass (owner ledger R91). OFF by default in the library,
    // same reasoning as `review` above: an embedder (or a test) that
    // constructs a FleetSupervisor directly and injects its own `runLane`
    // gets EXACTLY the pre-decomposition dispatch behaviour unless it opts
    // in; tools/fleet-supervisor.js turns it ON for the real fleet. This also
    // means a caller that has not injected a `runPlanningLane` test seam
    // never accidentally spawns a real planning-lane process.
    planning = null
  } = {}) {
    if (!repoRoot) throw new Error('FleetSupervisor requires repoRoot.');
    const requested = Number(concurrency);
    if (!Number.isInteger(requested) || requested < 1 || requested > MAX_CONCURRENCY) {
      throw new Error(`concurrency must be an integer between 1 and ${MAX_CONCURRENCY}; got ${concurrency}`);
    }
    // Refuses (throws) on anything not on the fleet model floor -- a model
    // downgrade is a refusal, never a fallback (owner order R58).
    this.laneBackend = laneModels.assertBackend(laneBackend);
    // Backend-aware: the two products have different top tiers, and an
    // off-floor model throws for either one.
    this.laneModel = laneModels.assertLaneModelFor(this.laneBackend, laneModel);
    this.laneProject = typeof laneProject === 'string' && laneProject.trim() ? laneProject.trim() : null;
    this.repoRoot = path.resolve(repoRoot);
    // The report-only Gemini contract is a durable fleet learning, not a
    // controller-session memory. Loading it during every supervisor
    // construction means a malformed/missing contract fails loud before the
    // persistent worker begins dispatching work.
    this.geminiReportContract = geminiReportContract.loadDefinition();
    this.stopFile = stopFile || stopFileFor(this.repoRoot);
    this.stateFile = stateFile || stateStore.defaultStateFile(this.repoRoot);
    this.queueFile = queueFile || queueReader.defaultQueueFile(this.repoRoot);
    this.concurrency = requested;
    this.maxAttempts = maxAttempts;
    this.maxNoProgressAttempts = maxNoProgressAttempts;
    this.pollMs = pollMs;
    this.laneTimeoutMs = laneTimeoutMs;
    this.maxIdleCycles = maxIdleCycles;
    this.keepWorktrees = keepWorktrees;
    this.dryRun = dryRun;
    this.isAlive = isAlive;
    this.now = now;
    this.logger = logger;
    this.storeOptions = storeOptions;
    this.supervisorId = supervisorId || `sup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.inFlight = new Map();
    this.stopping = false;
    this.idleCycles = 0;
    this.cycles = 0;
    this.killSwitch = killSwitch || require('../kill-switch.js');
    this.runLane = runLane || null;
    this._runLane = runLane || null;

    const reviewOptions = review && typeof review === 'object' ? review : {};
    this.reviewEnabled = reviewOptions.enabled === true;
    this.reviewConcurrency = Number.isInteger(reviewOptions.concurrency) && reviewOptions.concurrency > 0
      ? reviewOptions.concurrency
      : reviewStage.DEFAULT_REVIEW_CONCURRENCY;
    this.reviewBacklogThreshold = Number.isInteger(reviewOptions.backlogThreshold) && reviewOptions.backlogThreshold > 0
      ? reviewOptions.backlogThreshold
      : reviewStage.DEFAULT_REVIEW_BACKLOG_THRESHOLD;
    this.reviewerPreference = Array.isArray(reviewOptions.reviewerPreference) && reviewOptions.reviewerPreference.length
      ? reviewOptions.reviewerPreference.slice()
      : reviewStage.DEFAULT_REVIEWER_PREFERENCE.slice();
    this.reviewerModel = typeof reviewOptions.reviewerModel === 'string' ? reviewOptions.reviewerModel : null;
    this.reviewTimeoutMs = Number.isInteger(reviewOptions.timeoutMs) && reviewOptions.timeoutMs > 0
      ? reviewOptions.timeoutMs
      : reviewStage.DEFAULT_REVIEW_TIMEOUT_MS;
    this.maxReviewAttempts = Number.isInteger(reviewOptions.maxAttempts) && reviewOptions.maxAttempts > 0
      ? reviewOptions.maxAttempts
      : reviewStage.DEFAULT_MAX_REVIEW_ATTEMPTS;
    this.maxReviewReclaims = Number.isInteger(reviewOptions.maxReclaims) && reviewOptions.maxReclaims > 0
      ? reviewOptions.maxReclaims
      : reviewStage.DEFAULT_MAX_REVIEW_RECLAIMS;
    // Test seam: an injected reviewer runner, exactly like `runLane`.
    this.runReviewer = typeof reviewOptions.runReviewer === 'function' ? reviewOptions.runReviewer : null;
    this.chooseReviewer = typeof reviewOptions.chooseReviewer === 'function' ? reviewOptions.chooseReviewer : null;
    this.reviewsInFlight = new Map();
    // Latch so the wedge is announced once per occurrence, not every tick.
    this.wedgeAnnounced = false;

    const planningOptions = planning && typeof planning === 'object' ? planning : {};
    this.planningEnabled = planningOptions.enabled === true;
    this.planningTimeoutMs = Number.isInteger(planningOptions.timeoutMs) && planningOptions.timeoutMs > 0
      ? planningOptions.timeoutMs
      : planningStage.DEFAULT_PLANNING_TIMEOUT_MS;
    // Bounds how many NEW phases get a planning call started in a single
    // tick, so a burst of freshly-unparked phases cannot turn one tick into a
    // long serial chain of planning calls; each unplanned phase just picks up
    // a plan on a later tick (a plan is attempted once, ever, and cached
    // durably -- see ensurePlans()).
    this.planningMaxPerTick = Number.isInteger(planningOptions.maxPerTick) && planningOptions.maxPerTick > 0
      ? planningOptions.maxPerTick
      : 3;
    // Bounded re-attempts for a planner that could not RUN (see ensurePlans).
    // Small on purpose: enough to ride out a transient provider hiccup or pick
    // up a corrected model id, not enough for a permanently-broken planner to
    // re-probe every phase every cycle forever.
    this.planningMaxAttempts = Number.isInteger(planningOptions.maxAttempts) && planningOptions.maxAttempts > 0
      ? planningOptions.maxAttempts
      : 3;
    // Test seam: an injected planning-lane runner, exactly like `runLane`.
    this.runPlanningLane = typeof planningOptions.runPlanningLane === 'function' ? planningOptions.runPlanningLane : null;
  }

  log(event, detail = {}) {
    this.logger({ at: this.now().toISOString(), supervisorId: this.supervisorId, event, ...detail });
  }

  registerSelf() {
    const stamp = this.now().toISOString();
    stateStore.withState(this.stateFile, state => {
      state.supervisor = {
        supervisorId: this.supervisorId,
        pid: process.pid,
        startedAt: stamp,
        heartbeatAt: stamp,
        concurrency: this.concurrency,
        queueFile: this.queueFile,
        laneModel: this.laneModel,
        laneThinking: laneModels.LANE_MODEL_THINKING[this.laneModel] || null,
        laneProject: this.laneProject,
        laneBackend: this.laneBackend,
        geminiReportContract: {
          version: this.geminiReportContract.version,
          sha256: this.geminiReportContract.sha256
        },
        dryRun: this.dryRun
      };
      return { state };
    }, this.storeOptions);
  }

  heartbeat() {
    stateStore.withState(this.stateFile, state => {
      if (state.supervisor && state.supervisor.supervisorId === this.supervisorId) {
        state.supervisor.heartbeatAt = this.now().toISOString();
      }
      return { state };
    }, this.storeOptions);
  }

  readQueue() {
    const queue = queueReader.readBuildQueue(this.queueFile);
    return { ...queue, open: queueReader.openPhases(queue.phases) };
  }

  reconcile() {
    return reconcile(this.stateFile, {
      supervisorId: this.supervisorId,
      inFlightLaneIds: new Set(this.inFlight.keys()),
      isAlive: this.isAlive,
      now: this.now,
      storeOptions: this.storeOptions
    });
  }

  status(openItemIds = null) {
    return status(this.stateFile, {
      supervisorId: this.supervisorId,
      isAlive: this.isAlive,
      openItemIds,
      killSwitch: this.killSwitch.status(),
      reviewBacklogThreshold: this.reviewEnabled ? this.reviewBacklogThreshold : null,
      now: this.now,
      storeOptions: this.storeOptions
    });
  }

  nextLaneId(itemId) {
    const slug = String(itemId).toLowerCase().replace(/[^a-z0-9]+/g, '');
    return `${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  // One supervision cycle: reconcile reality, then fill empty slots.
  async tick() {
    this.cycles += 1;
    const transitions = this.reconcile();
    if (transitions.length) this.log('reconciled', { transitions });

    const kill = this.killSwitch.status();
    if (kill.active) {
      // Reviews spawn an external provider CLI too, so the kill switch stops
      // them for the same reason it stops lanes.
      this.log('killswitch-active', { path: kill.path, launching: false, reviewing: false });
      return { launched: [], reviews: [], blocked: 'killswitch', openItemCount: null, transitions };
    }

    // Review runs alongside lane execution, on its own small concurrency, and
    // is started BEFORE new lanes are claimed: draining the backlog is what
    // creates room to launch, so it must not queue behind a build.
    const reviews = this.reviewTick();

    const queue = this.readQueue();
    const openItemIds = queue.open.map(phase => phase.id);

    // Decomposition (owner ledger R91): make sure every open phase has a plan
    // attempt on record (bounded per tick), THEN claim from sub-task ids
    // where a plan is ready, or the phase id itself where planning fell back
    // or is disabled. A phase with no plan record yet contributes nothing
    // claimable this tick rather than guessing.
    const planningSummary = await this.ensurePlans(queue.open, queue.protocol);
    const afterPlanning = stateStore.readState(this.stateFile, this.storeOptions);
    const { ids: claimableIds, meta } = expandClaimableItems(queue.open, afterPlanning.plans, {
      planningEnabled: this.planningEnabled,
      items: afterPlanning.items
    });

    const launched = [];
    let wedgedThisTick = false;

    for (;;) {
      if (this.stopping) break;
      if (this.inFlight.size >= this.concurrency) break;
      const claim = claimNext(this.stateFile, {
        openItemIds: claimableIds,
        // Generated from the item ACTUALLY claimed, inside the claim lock, so
        // lane ids and worktree directories carry the right item slug. The old
        // pre-generated id used openItemIds[0] and named EVERY lane after the
        // lowest open item ("q17-..." for Q18/Q20/Q21/Q22 work), which made
        // retry accounting on disk unreadable.
        laneIdFor: itemId => this.nextLaneId(itemId),
        supervisorId: this.supervisorId,
        concurrency: this.concurrency,
        maxAttempts: this.maxAttempts,
        maxNoProgressAttempts: this.maxNoProgressAttempts,
        reviewBacklogThreshold: this.reviewEnabled ? this.reviewBacklogThreshold : null,
        now: this.now,
        storeOptions: this.storeOptions
      });
      if (!claim.claimed) {
        if (claim.reason === 'review-backlog-full') {
          this.log('launch-blocked-by-review-backlog', {
            backlog: claim.backlog, drainable: claim.drainable, threshold: claim.reviewBacklogThreshold
          });
        } else if (claim.reason === 'review-tier-wedged') {
          wedgedThisTick = true;
          // Every lane blocking the fleet is stalled: reviewing harder cannot
          // clear this and the fleet will never launch again on its own. Said
          // once per occurrence, with the lanes named, because the previous
          // behaviour was to repeat "backlog-full" every 30s forever.
          if (!this.wedgeAnnounced) {
            this.log('review-tier-wedged', {
              backlog: claim.backlog,
              stalled: claim.stalled,
              threshold: claim.reviewBacklogThreshold,
              detail: 'every lane holding the launch gate has exhausted its review budget; '
                + 'no reviewer can claim any of them and no new lane can start until an operator intervenes'
            });
            this.wedgeAnnounced = true;
          }
        } else if (claim.reason !== 'no-eligible-item' && claim.reason !== 'concurrency-full') {
          this.log('claim-refused', { reason: claim.reason });
        }
        break;
      }
      const info = meta.get(claim.claimed.itemId);
      if (!info) {
        // Cannot happen with the current claim path, but a brief must never be
        // assembled from a phase/sub-task we did not derive from BUILD-QUEUE.md
        // ourselves. Release the claim as a recorded failure rather than
        // inventing work.
        recordLaneOutcome(this.stateFile, claim.claimed.laneId, {
          ok: false, code: 'PHASE_NOT_IN_QUEUE',
          detail: `claimed ${claim.claimed.itemId} but it is not in the claimable set derived from ${this.queueFile}`,
          changedFileCount: 0, maxAttempts: this.maxAttempts,
          maxNoProgressAttempts: this.maxNoProgressAttempts, now: this.now, storeOptions: this.storeOptions
        });
        this.log('phase-not-in-queue', { laneId: claim.claimed.laneId, itemId: claim.claimed.itemId });
        continue;
      }
      this.dispatch(claim.claimed, info.phase, queue.protocol, info.kind === 'subtask' ? info.subtask : null);
      launched.push({ ...claim.claimed });
    }

    // Re-arm the announcement once the wedge clears, so a later one is not
    // swallowed by the latch that silenced the first.
    if (!wedgedThisTick) this.wedgeAnnounced = false;

    if (launched.length === 0 && reviews.length === 0) this.idleCycles += 1;
    else this.idleCycles = 0;

    return { launched, reviews, blocked: null, openItemCount: openItemIds.length, transitions, planning: planningSummary };
  }

  // Make sure every open phase has a usable planning attempt on record. The
  // attempt itself never touches state.items -- there is no code path from
  // here to claimNext()/recordLaneOutcome(), so planning cost structurally
  // cannot spend a phase's (or sub-task's) attempt budget.
  //
  // RE-ATTEMPT POLICY (learned the expensive way, 2026-07-29): a `ready` plan
  // is final. A `fallback` is NOT necessarily final, because the two failure
  // classes are completely different facts:
  //   * planner-unavailable -- the provider/CLI never answered (bad model id,
  //     spawn failure, quota, timeout). Nothing was learned about the phase.
  //     Caching that forever means one broken environment permanently demotes
  //     every phase to whole-phase dispatch, and a later fix can never take
  //     effect. This is the same rule the doctrine already states for lanes:
  //     an environmental failure must not consume an item's budget. Bounded
  //     re-attempts, so a permanently-broken planner still converges.
  //   * plan-incoherent -- the planner really answered and the answer was
  //     unusable. That IS information about this phase; re-deriving the same
  //     verdict just spends tokens. Final.
  async ensurePlans(openPhases, protocol) {
    const summary = { attempted: [] };
    if (!this.planningEnabled) return summary;
    let budget = this.planningMaxPerTick;
    for (const phase of openPhases) {
      if (budget <= 0) break;
      // The preceding planner awaited an external lifetime. A different
      // supervisor may have recorded a hold during that wait.
      const current = stateStore.readState(this.stateFile, this.storeOptions);
      if (hasCleanupHoldForItem(current, phase.id)) continue;
      const prior = current.plans?.[phase.id];
      if (prior && !this.planningIsRetryable(prior)) continue;
      if (this.stopping) break;
      budget -= 1;

      let planned;
      try {
        planned = await planningStage.planPhase(phase, protocol, {
          repoRoot: this.repoRoot,
          backend: this.laneBackend,
          project: this.laneProject,
          timeoutMs: this.planningTimeoutMs,
          runPlanningLane: this.runPlanningLane,
          now: this.now
        });
      } catch (error) {
        // Ordinary stage errors retain the fallback contract. Explicit
        // cleanup uncertainty must retain custody even when raised as an error.
        planned = stateStore.hasUnprovenCleanup(error) ? {
          ok: false, status: 'unknown', code: 'CLEANUP_UNPROVEN', cleanupConfirmed: false,
          failureClass: 'cleanup-unproven', reason: 'Planning process custody is unknown.',
          scratch: error.scratch || null, retainedScratch: error.retainedScratch || null,
          subtasks: [], model: null, laneId: null, plannedAt: this.now().toISOString()
        } : {
          ok: false, status: 'fallback',
          failureClass: planningStage.FAILURE_UNAVAILABLE,
          reason: `planning-stage-threw: ${String(error && error.message || error).slice(0, 200)}`,
          subtasks: [], model: null, laneId: null, plannedAt: this.now().toISOString()
        };
      }

      const attemptsBefore = (prior && Number.isFinite(prior.attempts)) ? prior.attempts : 0;
      const persisted = stateStore.withState(this.stateFile, state => {
        if (!state.plans) state.plans = {};
        const existing = state.plans[phase.id];
        // Custody uncertainty wins over a decomposition: an answer cannot
        // authorize overlap with a planning process that may still be alive.
        if (stateStore.hasUnprovenCleanup(existing)) return { state, result: existing };
        if (existing && existing.status === 'ready' && !stateStore.hasUnprovenCleanup(planned)) return { state, result: existing };
        state.plans[phase.id] = {
          phaseId: phase.id,
          status: planned.status,
          // null on success; otherwise which KIND of failure this was, which
          // is what makes a broken planner distinguishable from a phase that
          // genuinely could not be decomposed.
          failureClass: planned.status === 'ready' ? null : (planned.failureClass || planningStage.FAILURE_UNAVAILABLE),
          reason: planned.reason || null,
          subtasks: planned.status === 'ready' ? planned.subtasks : [],
          model: planned.model || null,
          laneId: planned.laneId || null,
          ...(stateStore.hasUnprovenCleanup(planned) ? {
            code: 'CLEANUP_UNPROVEN', cleanupConfirmed: false,
            scratch: planned.scratch || null, retainedScratch: planned.retainedScratch || null
          } : {}),
          attempts: attemptsBefore + 1,
          plannedAt: planned.plannedAt || this.now().toISOString(),
          reportedTokens: Number.isFinite(planned.reportedTokens) ? planned.reportedTokens : null
        };
        if (stateStore.hasUnprovenCleanup(planned)) {
          const item = stateStore.itemRecord(state, phase.id);
          item.condition = 'parked';
          item.parkedReason = 'cleanup-unproven: planning process custody must be resolved before planning or dispatch';
          item.parkedAt = item.parkedAt || this.now().toISOString();
          item.lastUpdatedAt = this.now().toISOString();
        }
        return { state, result: state.plans[phase.id] };
      }, this.storeOptions);
      planned = persisted;

      if (stateStore.hasUnprovenCleanup(planned)) {
        this.log('phase-planning-custody-held', { itemId: phase.id, laneId: planned.laneId,
          code: 'CLEANUP_UNPROVEN', scratch: planned.scratch || null });
      } else if (planned.status === 'ready') {
        this.log('phase-planned', {
          itemId: phase.id, subtaskCount: planned.subtasks.length, reason: planned.reason || null
        });
      } else {
        const unavailable = (planned.failureClass || planningStage.FAILURE_UNAVAILABLE) === planningStage.FAILURE_UNAVAILABLE;
        // LOUD on the infrastructure class. A planner that cannot run at all
        // used to be indistinguishable in the log from a phase that simply had
        // nothing to decompose, so a 100%-failing component looked like normal
        // operation for a whole batch.
        this.log(unavailable ? 'phase-planning-UNAVAILABLE' : 'phase-planning-incoherent', {
          itemId: phase.id,
          failureClass: planned.failureClass || planningStage.FAILURE_UNAVAILABLE,
          attempt: attemptsBefore + 1,
          model: planned.model || null,
          backend: this.laneBackend,
          reason: planned.reason || null,
          detail: unavailable
            ? 'the planning provider never answered; this phase fell back to WHOLE-PHASE dispatch. '
              + 'Decomposition is NOT running for it. Check the model id/backend before trusting this batch.'
            : 'the planner answered but the plan was unusable; this phase fell back to whole-phase dispatch'
        });
      }
      summary.attempted.push({ itemId: phase.id, status: planned.status, failureClass: planned.failureClass || null });
    }
    return summary;
  }

  // A `ready` plan is final. A `plan-incoherent` fallback is final. A
  // `planner-unavailable` fallback is retried up to a bound, because nothing
  // was learned about the phase and the cause is usually a fixable
  // environment/model-id problem.
  planningIsRetryable(plan) {
    if (stateStore.hasUnprovenCleanup(plan)) return false;
    if (!plan || plan.status === 'ready') return false;
    if ((plan.failureClass || planningStage.FAILURE_UNAVAILABLE) !== planningStage.FAILURE_UNAVAILABLE) return false;
    const attempts = Number.isFinite(plan.attempts) ? plan.attempts : 1;
    return attempts < this.planningMaxAttempts;
  }

  // Fill the review slots. Reviews are cheaper than builds but they must not
  // starve: they run on their OWN concurrency, not out of the lane budget.
  reviewTick() {
    if (!this.reviewEnabled) return [];
    const kill = this.killSwitch.status();
    if (kill.active) {
      this.log('killswitch-active', { path: kill.path, reviewing: false });
      return [];
    }
    const started = [];
    while (!this.stopping && this.reviewsInFlight.size < this.reviewConcurrency) {
      const claim = reviewStage.claimLaneForReview(this.stateFile, {
        supervisorId: this.supervisorId,
        inFlightLaneIds: new Set([...this.reviewsInFlight.keys()]),
        maxAttempts: this.maxReviewAttempts,
        maxReclaims: this.maxReviewReclaims,
        isAlive: this.isAlive,
        now: this.now,
        logger: (event, detail) => this.log(event, detail),
        storeOptions: this.storeOptions
      });
      if (!claim.claimed) break;
      this.dispatchReview(claim.claimed);
      started.push({ ...claim.claimed });
    }
    return started;
  }

  dispatchReview(claim) {
    const promise = (async () => {
      try {
        return await reviewStage.reviewOneLane(this.stateFile, claim, {
          repoRoot: this.repoRoot,
          reviewerPreference: this.reviewerPreference,
          reviewerModel: this.reviewerModel,
          timeoutMs: this.reviewTimeoutMs,
          maxAttempts: this.maxReviewAttempts,
          runReviewerImpl: this.runReviewer || reviewStage.runReviewer,
          chooseReviewerImpl: this.chooseReviewer || reviewStage.chooseReviewer,
          now: this.now,
          logger: (event, detail) => this.log(event, detail),
          storeOptions: this.storeOptions
        });
      } catch (error) {
        // A thrown reviewer must never leave a lane stuck in `in-review`.
        reviewStage.releaseReviewClaim(this.stateFile, claim.laneId, {
          error: `review-threw: ${String((error && error.message) || error).slice(0, 200)}`,
          maxAttempts: this.maxReviewAttempts,
          now: this.now,
          logger: (event, detail) => this.log(event, detail),
          storeOptions: this.storeOptions
        });
        this.log('review-error', { laneId: claim.laneId, code: (error && error.code) || 'REVIEW_THREW' });
        return null;
      }
    })();
    this.reviewsInFlight.set(claim.laneId, promise);
    // .finally() returns a NEW promise that adopts the rejection; without the
    // trailing .catch that derived promise is unhandled when the IIFE's own
    // error handler throws (e.g. releaseReviewClaim failing). The returned
    // `promise` keeps its rejection for any caller that awaits it.
    promise.finally(() => this.reviewsInFlight.delete(claim.laneId)).catch(() => {});
    return promise;
  }

  // Start one lane. Never awaited by tick(): the whole point is that lanes run
  // concurrently and the supervisor stays free to refill slots as they empty.
  // `subtask` is non-null when this claim came from a planned decomposition
  // (owner ledger R91): the lane gets a bounded sub-task brief instead of the
  // whole phase, but every other mechanic below -- worktree isolation,
  // materialization, the stale-snapshot backstop, review packet capture,
  // attempt/park bookkeeping -- is completely unchanged.
  dispatch(claim, phase, protocol, subtask = null) {
    const { laneId, itemId } = claim;
    const worktree = worktrees.worktreePathFor(laneId, this.repoRoot);
    const brief = subtask
      ? queueReader.buildSubtaskBrief(phase, subtask, protocol, { laneId, worktree, repoRoot: this.repoRoot })
      : queueReader.buildLaneBrief(phase, protocol, {
        laneId,
        worktree,
        // Doctrine countermeasure #1, now enforced in code rather than left to
        // whatever prose the queue body happened to carry: every producer file
        // the phase names gets its REAL exported shape extracted and injected.
        repoRoot: this.repoRoot
      });

    const promise = (async () => {
      const startedAt = Date.now();
      let created = null;
      let preserveForCustody = false;
      const durableCustodyHeld = () => stateStore.hasUnprovenCleanup(
        stateStore.readState(this.stateFile, this.storeOptions).lanes[laneId]);
      // Set when this lane produced reviewable output: its worktree is the
      // only place the artifact can be EXECUTED the way it would really run,
      // so it is kept until a reviewer has reached a verdict.
      let preserveForReview = false;
      try {
        if (this.dryRun) {
          this.log('dry-run-lane', { laneId, itemId, briefBytes: Buffer.byteLength(brief, 'utf8') });
          recordLaneStarted(this.stateFile, laneId, {
            pid: null, worktree: '(dry-run: no worktree created)', now: this.now, storeOptions: this.storeOptions
          });
          recordLaneOutcome(this.stateFile, laneId, {
            ok: true, code: 'DRY_RUN', detail: 'dry run: nothing was launched', changedFileCount: 0,
            durationMs: 0, maxAttempts: this.maxAttempts, maxNoProgressAttempts: this.maxNoProgressAttempts,
            now: this.now, storeOptions: this.storeOptions
          });
          return;
        }

        created = worktrees.createLaneWorktree(laneId, {
          repoRoot: this.repoRoot, supervisorId: this.supervisorId, itemId, now: this.now
        });

        // A lane worktree starts at the last COMMIT. This repo carries a large
        // uncommitted working state, so a lane launched here would read a repo
        // that does not exist -- the batch-2 failure. Bring it up to the real
        // working state, then PROVE it before launching anything.
        const snapshot = this.materialize(created.path);
        const briefedInputs = queueReader.referencedPaths(phase && phase.body);
        // A briefed input that exists in the live repo but not in the lane is
        // the batch-2 failure in miniature. Most commonly it fell under a
        // policy skip prefix, so try one targeted copy of that exact named
        // file before giving up. The skip set itself is NOT widened.
        const rescued = [];
        const stale = [];
        // A rescue the credential fence refused is NOT a stale snapshot. The
        // refusal is deliberate and permanent (worktree.js
        // #credentialMaterialReason), so counting it as `stale` would block the
        // lane on every attempt for a file that must never arrive. Measured
        // 2026-08-11: BUILD-QUEUE.md backticks 11 distinct `state/` paths, 4 of
        // which exist right now -- treating those as stale would blockade those
        // phases permanently, and the first person debugging that would "fix"
        // it by deleting the fence. So a fenced input is recorded loudly and
        // the lane still launches, simply without a file it should never have
        // been able to read.
        const credentialFenced = [];
        for (const relative of briefedInputs) {
          if (!this.existsInRepo(relative)) continue; // an output the phase must create
          if (worktrees.missingBriefedInputs(created.path, [relative]).length === 0) continue;
          const rescue = worktrees.copyRepoFileIntoWorktree(relative, {
            repoRoot: this.repoRoot, worktree: created.path
          });
          if (rescue.copied) rescued.push(relative);
          else if (rescue.fenced) credentialFenced.push(relative);
          else stale.push(relative);
        }
        if (credentialFenced.length > 0) {
          this.log('credential-material-fenced', { laneId, itemId, paths: credentialFenced.slice(0, 10) });
        }
        snapshot.briefedInputsChecked = briefedInputs.length;
        snapshot.briefedInputsRescued = rescued;
        snapshot.briefedInputsMissing = stale;
        snapshot.briefedInputsCredentialFenced = credentialFenced;

        if (!snapshot.complete || stale.length > 0) {
          // Backstop (b): refuse to dispatch rather than send an agent into a
          // snapshot we already know is wrong.
          const reason = stale.length > 0
            ? `briefed inputs absent from the lane worktree: ${stale.slice(0, 5).join(', ')}`
            : snapshot.reason;
          recordLaneOutcome(this.stateFile, laneId, {
            ok: false,
            code: 'DISPATCH_BLOCKED_STALE_SNAPSHOT',
            detail: String(reason).slice(0, 400),
            changedFileCount: 0,
            durationMs: Date.now() - startedAt,
            snapshot,
            maxAttempts: this.maxAttempts,
            maxNoProgressAttempts: this.maxNoProgressAttempts,
            now: this.now,
            storeOptions: this.storeOptions
          });
          this.log('dispatch-blocked-stale-snapshot', { laneId, itemId, reason: String(reason).slice(0, 200) });
          return;
        }

        // Baseline the materialized state so "did this lane change anything"
        // measures the LANE, not the ~700 files materialization just brought in.
        let baselineTree = null;
        try {
          baselineTree = worktrees.captureBaselineTree(created.path);
          snapshot.baselineTree = baselineTree;
        } catch (error) {
          snapshot.baselineTree = null;
          snapshot.baselineError = String(error && error.message || error).slice(0, 200);
          // Without the pre-run tree, neither the supervisor nor the runner
          // can distinguish lane work from files copied in by materialization.
          // Refuse before spawning instead of turning that failed measurement
          // into the runner's confident (and differently based) file count.
          const refusal = new Error(`progress baseline capture failed: ${snapshot.baselineError}`);
          refusal.code = 'BASELINE_CAPTURE_FAILED';
          throw refusal;
        }

        const result = await this.laneRunner()({
          laneId,
          itemId,
          brief,
          cwd: created.path,
          territory: subtask
            ? [...new Set(subtask.newFiles || [])]
            : queueReader.referencedPaths(phase && phase.body),
          model: this.laneModel,
          project: this.laneProject,
          backend: this.laneBackend,
          timeoutMs: this.laneTimeoutMs,
          onStart: (pid, { pidKind = null } = {}) => recordLaneStarted(this.stateFile, laneId, {
            pid, pidKind, worktree: created.path, model: this.laneModel, project: this.laneProject,
            backend: this.laneBackend, now: this.now, storeOptions: this.storeOptions
          })
        });

        // Only the supervisor's pre-run baseline has the namespace needed to
        // exclude materialization. If the post-run diff cannot be read, carry
        // that uncertainty as null; the runner's differently based count must
        // not turn a failed supervisor measurement into a definite answer.
        if (stateStore.hasUnprovenCleanup(result) || durableCustodyHeld()) {
          preserveForCustody = true;
          recordLaneOutcome(this.stateFile, laneId, { ...result, ok: false, code: 'CLEANUP_UNPROVEN',
            cleanupConfirmed: false, changedFileCount: null, durationMs: Date.now() - startedAt,
            now: this.now, storeOptions: this.storeOptions });
          this.log('lane-custody-held', { laneId, itemId, code: 'CLEANUP_UNPROVEN', worktree: created.path });
          return;
        }
        const measured = worktrees.changedSinceBaseline(created.path, baselineTree);
        const changedFileCount = Number.isFinite(measured) ? measured : null;

        // Result contract: the lane was briefed to name the REAL files it read
        // and changed. Every named path is checked against the worktree; a
        // missing path or an omitted report is recorded for the review stage,
        // never silently accepted. This does not verify the WORK -- only that
        // the lane's own account is not about imagined files.
        let contract = null;
        {
          const reported = result && result.reportedFiles;
          if (reported && (Array.isArray(reported.filesRead) || Array.isArray(reported.filesChanged))) {
            const named = [...new Set([...(reported.filesRead || []), ...(reported.filesChanged || [])])];
            contract = {
              reported: true,
              filesRead: (reported.filesRead || []).length,
              filesChanged: (reported.filesChanged || []).length,
              missing: worktrees.missingBriefedInputs(created.path, named)
            };
          } else {
            contract = { reported: false, filesRead: 0, filesChanged: 0, missing: [] };
          }
        }

        // PRESERVE BEFORE CLEANUP. Until this existed, a lane's output lived
        // only in a worktree the `finally` below removes, so "awaiting review"
        // named work that no longer existed. Never throws.
        let packet = null;
        if (this.reviewEnabled && Number.isFinite(changedFileCount) && changedFileCount > 0) {
          try {
            packet = reviewStage.capturePacket({
              laneId,
              itemId,
              attempt: claim.attempt,
              repoRoot: this.repoRoot,
              worktree: created.path,
              baselineTree,
              brief,
              // A sub-task lane gets the reviewer its OWN expected files, not
              // the whole phase's -- the reviewer should judge this lane
              // against what it was actually briefed to touch.
              briefedInputs: subtask
                ? [...new Set([...(subtask.groundTruthFiles || []), ...(subtask.newFiles || [])])]
                : briefedInputs,
              laneClaims: (result && result.reportedFiles) || null,
              laneOutcome: {
                processExitOk: Boolean(result && result.ok),
                code: (result && result.code) || null,
                reportedTokens: (result && result.reportedTokens) || null,
                contract
              },
              laneProvider: reviewStage.DEFAULT_LANE_PROVIDER,
              laneModel: this.laneModel,
              now: this.now
            });
            if (!packet.ok) this.log('review-packet-incomplete', { laneId, reason: packet.reason });
          } catch (error) {
            packet = { ok: false, reason: `capture-threw: ${String(error && error.message).slice(0, 160)}`, dir: null };
            this.log('review-packet-failed', { laneId, reason: packet.reason });
          }
          preserveForReview = Boolean(result && result.ok);
        }

        recordLaneOutcome(this.stateFile, laneId, {
          ok: Boolean(result && result.ok),
          code: result && result.code ? result.code : null,
          detail: result && result.detail ? result.detail : null,
          changedFileCount,
          durationMs: Date.now() - startedAt,
          snapshot,
          contract,
          reportedModels: (result && result.reportedModels) || null,
          perCallModelEvidence: (result && result.perCallModelEvidence) || null,
          directVertexEvidence: (result && result.directVertexEvidence) || null,
          reportedTokens: (result && Number.isFinite(result.reportedTokens)) ? result.reportedTokens : null,
          billing: (result && result.billing) || null,
          backend: this.laneBackend,
          reviewPacket: packet ? {
            dir: packet.dir, ok: packet.ok, reason: packet.reason,
            filesCopied: packet.filesCopied, diffBytes: packet.diffBytes
          } : null,
          maxAttempts: this.maxAttempts,
          maxNoProgressAttempts: this.maxNoProgressAttempts,
          now: this.now,
          storeOptions: this.storeOptions
        });
        // Deliberately NOT logged as "ok" or "passed": the exit code says the
        // process ended, not that the work is right.
        this.log('lane-process-ended', {
          laneId, itemId, processExitOk: Boolean(result && result.ok),
          code: result && result.code, verification: 'unverified',
          transient: isTransientFailureDetail(result && result.detail),
          contractReported: contract.reported,
          contractMissing: contract.missing.length,
          reportedModels: (result && result.reportedModels) || null
        });
      } catch (error) {
        preserveForCustody = preserveForCustody || stateStore.hasUnprovenCleanup(error);
        try { preserveForCustody = preserveForCustody || durableCustodyHeld(); }
        catch { preserveForCustody = true; }
        recordLaneOutcome(this.stateFile, laneId, {
          ok: false,
          code: preserveForCustody ? 'CLEANUP_UNPROVEN' : (error && error.code) || 'LANE_THREW',
          detail: String((error && error.message) || error).slice(0, 400),
          changedFileCount: preserveForCustody ? null : 0,
          durationMs: Date.now() - startedAt,
          maxAttempts: this.maxAttempts,
          maxNoProgressAttempts: this.maxNoProgressAttempts,
          now: this.now,
          storeOptions: this.storeOptions
        });
        this.log('lane-error', { laneId, itemId, code: (error && error.code) || 'LANE_THREW' });
      } finally {
        // A concurrent reconciler may have retained custody while this lane
        // awaited its runner. Unreadable state cannot authorize disposal.
        try { preserveForCustody = preserveForCustody || durableCustodyHeld(); }
        catch { preserveForCustody = true; }
        // Cleanup goes through the guarded remover. It can only ever delete a
        // directory carrying THIS repo's fleet marker, so the protected
        // ToolsEnabled-lane-* worktrees are structurally unreachable from here.
        //
        // A lane awaiting review is NEVER cleaned up here: reviewing work by
        // executing it requires the work to still exist. Disposal of a
        // reviewed worktree is a controller decision, like merging.
        if (created && preserveForCustody) {
          this.log('worktree-retained-for-custody', { laneId, worktree: created.path });
        } else if (created && preserveForReview) {
          this.log('worktree-retained-for-review', { laneId, worktree: created.path });
        }
        if (created && !this.keepWorktrees && !preserveForReview && !preserveForCustody) {
          try {
            worktrees.removeLaneWorktree(created.path, { repoRoot: this.repoRoot });
          } catch (error) {
            this.log('worktree-cleanup-refused', { laneId, reason: (error && error.reason) || String(error && error.message) });
          }
        }
      }
    })();

    // Registered BEFORE any `.finally` can fire, so a lane that completes
    // synchronously cannot leave a phantom entry behind (which would make the
    // supervisor believe a slot is occupied forever).
    this.inFlight.set(laneId, promise);
    // Same shape as reviewsInFlight above: the .finally-derived promise must
    // carry its own .catch, or a lane whose error handler itself throws
    // becomes an unhandled rejection while the map entry is already gone.
    promise.finally(() => this.inFlight.delete(laneId)).catch(() => {});
    this.log('lane-dispatched', {
      laneId, itemId, attempt: claim.attempt, model: this.laneModel, backend: this.laneBackend,
      phaseId: phase.id, subtaskId: subtask ? subtask.id : null
    });
    return promise;
  }

  materialize(worktreePath) {
    return worktrees.materializeWorkingTree(worktreePath, { repoRoot: this.repoRoot });
  }

  existsInRepo(relative) {
    const resolved = path.resolve(this.repoRoot, relative);
    if (!resolved.startsWith(this.repoRoot + path.sep)) return false;
    try {
      return fs.statSync(resolved, { throwIfNoEntry: false }) !== undefined;
    } catch (error) {
      // existsSync turns every lookup failure into `false`.  At this call site
      // false means "this is an output the phase must create", so EMFILE/EIO
      // (and similar temporary failures) used to let a lane run without an
      // input that may actually exist.  Only ENOENT is absence; preserve every
      // other failure as an uncacheable, pre-launch infrastructure outcome.
      if (error && error.code === 'ENOENT') return false;
      const unavailable = new Error(
        `could not determine whether briefed input exists (${error && error.code || 'UNKNOWN'}); `
        + 'this is NOT claiming the input is absent'
      );
      unavailable.code = 'INPUT_EXISTENCE_UNAVAILABLE';
      unavailable.cause = error;
      throw unavailable;
    }
  }

  // Loaded lazily so `--status` and `--plan` never pull in the provider gateway.
  laneRunner() {
    if (!this._runLane) this._runLane = this.runLane || require('./lane-runner.js').runLane;
    return this._runLane;
  }

  async run({ maxCycles = Infinity, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.registerSelf();
    this.log('supervisor-started', { concurrency: this.concurrency, stateFile: this.stateFile, dryRun: this.dryRun });
    let cycles = 0;
    while (!this.stopping && cycles < maxCycles) {
      // Graceful stop: the sentinel is checked at the top of every cycle so a
      // stop request stops CLAIMING immediately, then drains in-flight lanes
      // instead of orphaning them the way a process kill does on Windows.
      // AN UNREADABLE STOP FILE IS NOT AN ABSENT ONE. fs.existsSync swallows
      // EVERY error and answers false -- EACCES, EPERM, EIO all read as "no
      // stop was requested", so the supervisor would keep CLAIMING new lanes
      // at the one moment somebody is trying to halt it. statSync with
      // throwIfNoEntry:false separates the two: a genuinely missing sentinel
      // answers undefined, and anything else throws to the caller, which stops
      // the loop rather than continuing on an unestablished negative.
      if (fs.statSync(this.stopFile, { throwIfNoEntry: false }) !== undefined) {
        this.log('stop-file-detected', { stopFile: this.stopFile });
        this.stopping = true;
        break;
      }
      cycles += 1;
      await this.tick();
      this.heartbeat();
      if (this.maxIdleCycles > 0 && this.idleCycles >= this.maxIdleCycles
        && this.inFlight.size === 0 && this.reviewsInFlight.size === 0) {
        this.log('supervisor-drained', { idleCycles: this.idleCycles });
        break;
      }
      if (this.stopping || cycles >= maxCycles) break;
      await sleep(this.pollMs);
    }
    await this.drain();
    this.log('supervisor-stopped', { cycles });
    return { cycles };
  }

  // Bounded: a stuck lane must not turn draining into an infinite loop.
  // In-flight REVIEWS are drained too: abandoning one would leave its lane
  // claimed as `in-review` by a process that no longer exists.
  async drain(maxRounds = 10_000) {
    for (let round = 0; round < maxRounds && (this.inFlight.size > 0 || this.reviewsInFlight.size > 0); round += 1) {
      await Promise.allSettled([...this.inFlight.values(), ...this.reviewsInFlight.values()]);
      await new Promise(resolve => setImmediate(resolve));
    }
    return this.inFlight.size + this.reviewsInFlight.size;
  }

  stop() {
    this.stopping = true;
  }
}

module.exports = {
  ACTIVE_LANE_STATUSES,
  DEFAULT_CONCURRENCY,
  DEFAULT_LANE_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_NO_PROGRESS_ATTEMPTS,
  DEFAULT_POLL_MS,
  FleetSupervisor,
  MAX_CONCURRENCY,
  OWNER_AUTHORIZED_LANE_CEILING,
  TRANSIENT_COOLDOWN_BASE_MS,
  TRANSIENT_COOLDOWN_MAX_MS,
  TRANSIENT_DETAIL_RE,
  TRANSIENT_REFUND_CAP,
  QUOTA_RESET_MAX_MS,
  adjudicateLaneModelReceipt,
  claimNext,
  expandClaimableItems,
  isSubtaskSettled,
  isNeverLaunchedCode,
  isTransientFailureDetail,
  NEVER_LAUNCHED_CODES,
  quotaResetDelayMs,
  markVerified,
  phaseDecompositionSummary,
  planningHealthSummary,
  verdictsByModel,
  occupiedSlots,
  parkDecision,
  reconcile,
  recordLaneOutcome,
  recordLaneStarted,
  status,
  stopFileFor,
  subtaskItemId
};
