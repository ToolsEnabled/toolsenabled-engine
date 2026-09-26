'use strict';

// The bounded duty loop (owner request R100).
//
// Clock- and duty-injectable so the whole thing is testable without spawning a
// process, touching Telegram, or waiting real seconds. tools/coordinator-duty-
// host.js is a thin wrapper around createHost(); every interesting property
// below is asserted against runCycle() directly.
//
// THE FOUR PROPERTIES THIS FILE EXISTS TO GUARANTEE
//
// 1. ONE DUTY'S THROW NEVER ENDS THE CYCLE. Every mechanical duty runs inside
//    its own try/catch AND its own timeout. A duty that throws is recorded
//    FAILED with its message and the next duty still runs.
//
// 2. A FAILURE IS REPORTED, NEVER SWALLOWED. There is no outcome meaning "we
//    did not look but assume it is fine". consecutiveFailures accumulates
//    across cycles and travels in the heartbeat, so a duty that has been
//    broken for 40 cycles is visible as such rather than averaged away.
//
// 3. THE HEARTBEAT IS WRITTEN AT THE END OF THE CYCLE, NEVER AT THE START.
//    A start-of-cycle heartbeat proves only that the loop is turning. That is
//    liveness wearing function's clothes -- the same defect the telegram-bridge
//    "functioning" rung was written against.
//
// 4. THE HOST CANNOT REPORT OK WHILE BEING USELESS. hostSelfState() rolls the
//    worst duty state into the surfaced verdict: any duty at or past
//    MAX_CONSECUTIVE_FAILURES forces DEGRADED regardless of how happily the
//    loop is ticking.
//
// A NOTE ON THE TIMEOUT. Node cannot cancel a pending promise. A duty that
// exceeds its budget is recorded TIMEOUT and the cycle moves on; the abandoned
// promise may still settle later and its result is discarded. That is a
// deliberate trade: a hung duty stalling the whole loop is strictly worse than
// a leaked continuation, because a stalled loop stops writing heartbeats and
// the dashboard correctly reports the host as dead.

const dutyRegistry = require('./duty-registry.js');
const heartbeat = require('./heartbeat.js');
const killSwitch = require('../kill-switch.js');

const CYCLE_INTERVAL_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const DUTY_TIMEOUT_MS = 20_000;

// Bridge probe thresholds, passed through onto the duty context.
const BRIDGE_POLL_STALE_MS = 120_000;
const BRIDGE_ACK_FAILURE_WINDOW_MS = 300_000;

const { DUTY_OUTCOME, HOST_STATE } = heartbeat;

function noopLog() { /* the host must work with no logger attached */ }

/**
 * Fresh in-memory host state for one boot. `memo` survives cycles (the wake
 * cursor, the previous bridge counters); `duties` is the per-duty accounting
 * the heartbeat carries.
 */
function createState({
  bootId = heartbeat.newBootId(),
  startedAtMs = Date.now(),
  pid = process.pid,
  cycleIntervalMs = CYCLE_INTERVAL_MS,
  duties = dutyRegistry.DUTIES
} = {}) {
  const dutyState = {};
  for (const duty of duties) {
    dutyState[duty.id] = {
      kind: duty.kind,
      lastRunAtMs: null,
      outcome: duty.kind === dutyRegistry.DUTY_KIND.JUDGEMENT
        ? DUTY_OUTCOME.WAITING
        : DUTY_OUTCOME.NOT_YET_RUN,
      reason: duty.kind === dutyRegistry.DUTY_KIND.JUDGEMENT
        ? 'a human must decide this; the host has no code path to execute it'
        : 'registered, not yet executed in this boot',
      consecutiveFailures: 0,
      detail: null
    };
  }
  return {
    pid,
    bootId,
    startedAtMs,
    cycleIntervalMs,
    cycleSeq: 0,
    duties: dutyState,
    memo: {},
    escalationsSuppressed: null,
    escalationChannel: {
      state: heartbeat.ESCALATION_CHANNEL.UNKNOWN,
      reason: 'no escalation has been attempted in this boot',
      lastErrorAtMs: null,
      lastSendAtMs: null
    }
  };
}

/**
 * The surfaced host verdict. DEGRADED when ANY duty has failed
 * MAX_CONSECUTIVE_FAILURES times in a row -- an alive-but-useless host must
 * not read as OK.
 */
function hostSelfState(dutyState, { maxConsecutiveFailures = MAX_CONSECUTIVE_FAILURES } = {}) {
  const failing = [];
  let mechanicalDutyCount = 0;
  for (const [id, record] of Object.entries(dutyState || {})) {
    if (record && record.kind === dutyRegistry.DUTY_KIND.MECHANICAL) mechanicalDutyCount += 1;
    if (record && record.consecutiveFailures >= maxConsecutiveFailures) {
      failing.push({ id, consecutiveFailures: record.consecutiveFailures, outcome: record.outcome });
    }
  }
  const hasNoMechanicalDuties = mechanicalDutyCount === 0;
  return {
    state: failing.length > 0 || hasNoMechanicalDuties ? HOST_STATE.DEGRADED : HOST_STATE.OK,
    failing,
    reason: hasNoMechanicalDuties
      ? 'no mechanical duties are registered; host usefulness was not established'
      : failing.length > 0
      ? `${failing.length} duty(ies) at or past ${maxConsecutiveFailures} consecutive failures: ${failing.map(f => f.id).join(', ')}`
      : 'every duty is inside its failure budget'
  };
}

function withTimeout(promise, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    // NOT unref'd, deliberately. An unref'd timeout lets the process exit
    // while a duty is hung, which silently discards the cycle -- the loop just
    // stops, no heartbeat, no TIMEOUT record, nothing to read afterwards. The
    // timer is bounded (it either fires once or is cleared when the duty
    // settles), so holding the event loop for at most timeoutMs is the cheap
    // half of that trade.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(Object.assign(new Error(`duty exceeded its ${timeoutMs}ms budget`), { code: 'DUTY_TIMEOUT' }));
    }, timeoutMs);
    Promise.resolve(promise).then(
      value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); },
      error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); }
    );
  });
}

function normalizeResult(raw) {
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return {
      outcome: DUTY_OUTCOME.FAILED,
      reason: 'duty returned no structured outcome; success could not be established',
      detail: raw === undefined ? null : { value: raw }
    };
  }
  const validOutcome = Object.values(DUTY_OUTCOME).includes(raw.outcome);
  const outcome = raw.outcome === undefined ? DUTY_OUTCOME.OK
    : validOutcome ? raw.outcome : DUTY_OUTCOME.FAILED;
  return {
    outcome,
    reason: validOutcome || raw.outcome === undefined
      ? (typeof raw.reason === 'string' ? raw.reason : null)
      : `duty returned unknown outcome ${JSON.stringify(raw.outcome)}; success could not be established`,
    detail: raw.detail === undefined ? null : raw.detail
  };
}

function isFailure(outcome) {
  return heartbeat.FAILING_OUTCOMES.includes(outcome);
}

/**
 * Run one cycle. Returns the heartbeat record the caller should write; it does
 * NOT write it, so a test can assert the record and a caller can decide the
 * file. createHost() writes it immediately after this resolves -- at the END.
 *
 * Mutates `state` in place (that is its purpose: accounting across cycles).
 */
async function runCycle({
  state,
  duties = dutyRegistry.DUTIES,
  now = Date.now,
  log = noopLog,
  ctx: ctxOverrides = {},
  dutyTimeoutMs = DUTY_TIMEOUT_MS,
  maxConsecutiveFailures = MAX_CONSECUTIVE_FAILURES,
  killSwitchActive = null
} = {}) {
  if (!state) throw new Error('runCycle requires a state object from createState()');

  state.cycleSeq += 1;
  const cycleStartedAtMs = now();

  let switchActive = killSwitchActive;
  if (switchActive === null) {
    // Even the kill-switch read is guarded: an unreadable kill switch must not
    // end the cycle. Unknown is treated as ACTIVE, because the safe reading of
    // "I cannot tell whether outward actions are forbidden" is "do not act".
    try {
      switchActive = Boolean(killSwitch.status().active);
    } catch (error) {
      switchActive = true;
      log({ event: 'kill-switch-unreadable', message: String(error && error.message).slice(0, 200) });
    }
  }

  const cycle = {
    escalationChannel: { ...state.escalationChannel },
    escalationsSuppressed: undefined,
    actionedDirectiveIds: []
  };

  const ctx = {
    now,
    log,
    memo: state.memo,
    cycle,
    killSwitchActive: switchActive,
    allowRestart: false,
    bridgePollStaleMs: BRIDGE_POLL_STALE_MS,
    bridgeAckFailureWindowMs: BRIDGE_ACK_FAILURE_WINDOW_MS,
    ...ctxOverrides
  };

  const judgementWaiting = [];
  const ran = [];

  for (const duty of duties) {
    const record = state.duties[duty.id] || (state.duties[duty.id] = {
      kind: duty.kind, lastRunAtMs: null, outcome: DUTY_OUTCOME.NOT_YET_RUN,
      reason: 'registered mid-run', consecutiveFailures: 0, detail: null
    });

    // JUDGEMENT: never executed. There is no run() to execute (the registry
    // refuses one), and this branch does not look for it.
    if (duty.kind === dutyRegistry.DUTY_KIND.JUDGEMENT) {
      record.kind = duty.kind;
      record.outcome = DUTY_OUTCOME.WAITING;
      record.reason = duty.description;
      record.consecutiveFailures = 0;
      judgementWaiting.push({
        id: duty.id,
        description: duty.description,
        humanAction: duty.humanAction || null,
        waitingSinceMs: state.startedAtMs
      });
      continue;
    }

    // Not due yet: leave the previous outcome ALONE. Overwriting it with a
    // fresh OK would erase a real failure between runs.
    const due = record.lastRunAtMs === null || (cycleStartedAtMs - record.lastRunAtMs) >= duty.intervalMs;
    if (!due) continue;

    // Outward duties are suppressed, not run, while the kill switch is active.
    if (duty.outward && switchActive) {
      record.outcome = DUTY_OUTCOME.SKIPPED;
      record.reason = 'kill switch is active; outward duties are suppressed';
      record.lastRunAtMs = now();
      record.detail = null;
      ran.push({ id: duty.id, outcome: record.outcome });
      continue;
    }

    let result;
    try {
      let timedOut = false;
      result = normalizeResult(await withTimeout(
        Promise.resolve().then(() => duty.run(ctx)),
        dutyTimeoutMs,
        () => { timedOut = true; }
      ));
      void timedOut;
    } catch (error) {
      const timeout = error && error.code === 'DUTY_TIMEOUT';
      result = {
        outcome: timeout ? DUTY_OUTCOME.TIMEOUT : DUTY_OUTCOME.FAILED,
        // The message is the whole point: a duty that failed silently is the
        // failure mode this port exists to eliminate.
        reason: `${(error && error.code) || 'ERROR'}: ${String((error && error.message) || error).slice(0, 400)}`,
        detail: null
      };
      log({
        event: 'duty-failed',
        duty: duty.id,
        code: (error && error.code) || null,
        message: String((error && error.message) || error).slice(0, 400),
        stack: error && error.stack ? String(error.stack).slice(0, 2000) : null
      });
    }

    record.kind = duty.kind;
    record.lastRunAtMs = now();
    record.outcome = result.outcome;
    record.reason = result.reason;
    record.detail = result.detail;
    record.consecutiveFailures = isFailure(result.outcome) ? record.consecutiveFailures + 1 : 0;
    ran.push({ id: duty.id, outcome: result.outcome });
  }

  // Carry per-cycle facts the duties recorded onto durable host state.
  if (cycle.escalationChannel) state.escalationChannel = cycle.escalationChannel;
  // null is carried through UNCHANGED. It means "the sink could not tell us",
  // which is not the same as zero -- see the note in heartbeat.js.
  if (cycle.escalationsSuppressed !== undefined) {
    state.escalationsSuppressed = cycle.escalationsSuppressed;
  }

  const self = hostSelfState(state.duties, { maxConsecutiveFailures });

  const record = {
    schemaVersion: heartbeat.HEARTBEAT_SCHEMA_VERSION,
    pid: state.pid,
    bootId: state.bootId,
    startedAtMs: state.startedAtMs,
    observedAtMs: now(),                    // END of cycle, never the start
    cycleIntervalMs: state.cycleIntervalMs,
    cycleSeq: state.cycleSeq,
    hostState: self.state,
    hostStateReason: self.reason,
    duties: {},
    judgementWaiting,
    escalationsSuppressed: state.escalationsSuppressed === undefined ? null : state.escalationsSuppressed,
    escalationChannel: state.escalationChannel
  };
  for (const [id, duty] of Object.entries(state.duties)) {
    record.duties[id] = {
      kind: duty.kind,
      lastRunAtMs: duty.lastRunAtMs,
      outcome: duty.outcome,
      reason: duty.reason,
      consecutiveFailures: duty.consecutiveFailures,
      detail: duty.detail
    };
  }

  return { heartbeat: record, ran, self, cycleStartedAtMs, killSwitchActive: switchActive };
}

/**
 * Wrap runCycle in a timer loop plus the heartbeat write. The clock is
 * injectable (`clock.setInterval` / `clock.clearInterval` / `clock.now`) so a
 * test drives cycles synchronously instead of sleeping.
 *
 * The heartbeat write is itself guarded: a write failure is logged and the
 * loop continues, because a host that stops looping because it could not
 * write a status file has turned a reporting problem into an outage.
 */
function createHost({
  duties = dutyRegistry.DUTIES,
  state = null,
  intervalMs = CYCLE_INTERVAL_MS,
  heartbeatFile = heartbeat.HEARTBEAT_FILE,
  writeHeartbeat = heartbeat.writeHeartbeat,
  log = noopLog,
  clock = {},
  ctx = {},
  dutyTimeoutMs = DUTY_TIMEOUT_MS,
  maxConsecutiveFailures = MAX_CONSECUTIVE_FAILURES,
  shouldStop = null
} = {}) {
  const now = clock.now || Date.now;
  const setIntervalFn = clock.setInterval || setInterval;
  const clearIntervalFn = clock.clearInterval || clearInterval;

  const hostState = state || createState({ cycleIntervalMs: intervalMs, duties, startedAtMs: now() });
  let timer = null;
  let running = false;
  let lastCycle = null;

  async function cycleOnce() {
    if (running) {
      log({ event: 'cycle-overlap-skipped', cycleSeq: hostState.cycleSeq });
      return lastCycle;
    }
    running = true;
    try {
      const result = await runCycle({
        state: hostState, duties, now, log, ctx, dutyTimeoutMs, maxConsecutiveFailures
      });
      lastCycle = result;
      // END of cycle. This is the only place a heartbeat is written.
      try {
        writeHeartbeat(result.heartbeat, { file: heartbeatFile });
      } catch (error) {
        log({ event: 'heartbeat-write-failed', message: String(error && error.message).slice(0, 400) });
      }
      log({
        event: 'cycle',
        cycleSeq: result.heartbeat.cycleSeq,
        hostState: result.heartbeat.hostState,
        ran: result.ran.length,
        outcomes: result.ran
      });
      return result;
    } catch (error) {
      // runCycle already guards each duty; reaching here means the loop
      // scaffolding itself broke. Report it and keep the timer alive.
      log({
        event: 'cycle-failed',
        message: String((error && error.message) || error).slice(0, 400),
        stack: error && error.stack ? String(error.stack).slice(0, 2000) : null
      });
      return null;
    } finally {
      running = false;
    }
  }

  function stop(reason = 'stopped') {
    if (timer !== null) { clearIntervalFn(timer); timer = null; }
    log({ event: 'host-stopped', reason, cycleSeq: hostState.cycleSeq });
  }

  function start() {
    if (timer !== null) return { started: false, reason: 'already started' };
    log({ event: 'host-started', pid: hostState.pid, bootId: hostState.bootId, intervalMs, duties: duties.length });
    // Fire immediately so a fresh host writes a heartbeat within one cycle
    // rather than one interval.
    void cycleOnce();
    timer = setIntervalFn(() => {
      if (typeof shouldStop === 'function') {
        let stopNow = false;
        try { stopNow = Boolean(shouldStop()); }
        catch (error) {
          log({ event: 'stop-sentinel-unreadable', message: String(error && error.message).slice(0, 200) });
          stop('stop sentinel unreadable');
          return;
        }
        if (stopNow) { stop('stop sentinel present'); return; }
      }
      void cycleOnce();
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return { started: true, bootId: hostState.bootId };
  }

  return {
    state: hostState,
    cycleOnce,
    start,
    stop,
    get lastCycle() { return lastCycle; }
  };
}

module.exports = Object.freeze({
  CYCLE_INTERVAL_MS,
  MAX_CONSECUTIVE_FAILURES,
  DUTY_TIMEOUT_MS,
  BRIDGE_POLL_STALE_MS,
  BRIDGE_ACK_FAILURE_WINDOW_MS,
  createState,
  runCycle,
  createHost,
  hostSelfState
});
