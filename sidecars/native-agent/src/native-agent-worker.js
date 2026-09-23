'use strict';

// A SEPARATE durable worker for a SEPARATE task type, on the queue machinery
// that already exists. It mirrors the earlier local claimant's shape: reconcile expired
// leases, claim one FIFO task, start it, heartbeat the lease while the work
// runs, checkpoint progress, then record exactly one terminal outcome.
//
// What is deliberately NOT shared with any other worker:
//   * its own queue name and task type, so neither daemon can claim the
//     other's work and no existing run changes behaviour;
//   * its own execution path -- a fully native local agent, not the fenced
//     CLI provider gateway and not the bounded no-tool local engine;
//   * its own runtime record, log files, and scheduled task.
//
// Everything it touches is additive. It modifies no existing module.

const crypto = require('node:crypto');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const tasks = require(path.join(ROOT, 'src', 'lib', 'providers', 'tasks.js'));
const { runNativeAgent, evaluateAcceptance, NativeAgentLaunchError } = require('./native-agent-launcher');
const { createRunLog } = require('./native-agent-log');

const QUEUE = 'native-agent';
const TASK_TYPE = 'native.agent.run';
const LEASE_SECONDS = 300;
const HEARTBEAT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;
const HEALTH_HEARTBEAT_MS = 15_000;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function safeCode(value, fallback) {
  const code = String(value || fallback).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100);
  return /^[A-Za-z0-9]/.test(code) ? code : fallback;
}

function safeMessage(error) {
  return String(error && error.message ? error.message : error || 'Unknown native agent worker error')
    .replace(/(?:Bearer|Basic)\s+[^\s,]+/gi, '$1 REDACTED')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, 'REDACTED')
    .replace(/\s+/g, ' ')
    .slice(0, 900);
}

function workerId() {
  return `native-agent.${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
}

// The payload is untrusted data from whichever peer dispatched it.
//
// It uses the durable queue's EXISTING payload contract unchanged --
// { title, objective, context } -- because inventing a payload shape would
// mean changing state-store's validator, which every other queue depends on.
// Optional run controls ride in `context` as a small JSON object. That is
// deliberately the weakest possible channel: `context` can select only a
// bounded timeout, a bounded turn count, and which of two IN-CODE prompts is
// used. It cannot select the executable, the registry, the permission mode, or
// the argv -- those are fixed in native-agent-launcher.js.
function readPayload(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const objective = typeof source.objective === 'string' ? source.objective.trim() : '';
  let control = {};
  if (typeof source.context === 'string' && source.context.trim() !== '') {
    try {
      const parsed = JSON.parse(source.context);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) control = parsed;
    } catch { /* context is free-form untrusted text; anything that is not the control block is ignored */ }
  }
  const mode = control.mode === 'acceptance' ? 'acceptance' : 'objective';
  if (mode === 'objective' && !objective) {
    const error = new Error('The task payload has no objective text.');
    error.code = 'NATIVE_AGENT_PAYLOAD_INVALID';
    throw error;
  }
  return {
    mode,
    objective,
    title: typeof source.title === 'string' ? source.title.slice(0, 200) : '',
    timeoutMs: Number.isSafeInteger(control.timeoutMs) ? control.timeoutMs : undefined,
    maxTurns: Number.isSafeInteger(control.maxTurns) ? control.maxTurns : undefined
  };
}

class NativeAgentWorker {
  constructor(options = {}) {
    this.queue = options.queue || QUEUE;
    this.taskType = options.taskType || TASK_TYPE;
    this.workerLabel = options.workerLabel || workerId();
    this.leaseSeconds = options.leaseSeconds || LEASE_SECONDS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || HEARTBEAT_MS;
    this.pollIntervalMs = options.pollIntervalMs || POLL_INTERVAL_MS;
    this.tasks = options.tasks || tasks;
    this.launch = options.launch || runNativeAgent;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.onHeartbeat = typeof options.onHeartbeat === 'function' ? options.onHeartbeat : () => {};
    this.healthHeartbeatMs = Number.isSafeInteger(options.healthHeartbeatMs) && options.healthHeartbeatMs > 0
      ? options.healthHeartbeatMs
      : HEALTH_HEARTBEAT_MS;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.lastCycleOk = null;
    this.stopped = false;
  }

  stop() { this.stopped = true; }

  _reportHealth(state = 'polling') {
    // Health telemetry is deliberately best effort. A full disk, antivirus
    // race, or malformed observer must never become permission to abandon an
    // already-claimed task. The callback receives only fixed lifecycle facts;
    // objectives, output, claim handles, and credentials never cross it.
    try {
      this.onHeartbeat({
        observedAtMs: this.now(),
        // Startup is not proof of function. Stay unready until at least one
        // durable-queue read has completed successfully; otherwise a hung
        // first claim can publish a fresh but false-green heartbeat forever.
        ok: this.lastCycleOk === true,
        state: this.lastCycleOk === null ? 'starting' : state,
        pid: process.pid,
        secretValuesEmitted: false
      });
    } catch { /* health publication must not stop task execution */ }
  }

  async runForever() {
    this.onEvent({ event: 'worker_started', queue: this.queue, type: this.taskType, workerLabel: this.workerLabel, pid: process.pid });
    this._reportHealth('starting');
    const healthTimer = setInterval(() => this._reportHealth('polling'), this.healthHeartbeatMs);
    if (typeof healthTimer.unref === 'function') healthTimer.unref();
    try {
      while (!this.stopped) {
        let worked = false;
        try {
          worked = await this.runOnce();
        } catch (error) {
          this.lastCycleOk = false;
          this.onEvent({ event: 'worker_loop_error', code: safeCode(error && error.code, 'NATIVE_AGENT_WORKER_LOOP_FAILED'), message: safeMessage(error) });
        }
        this._reportHealth('polling');
        if (!worked && !this.stopped) await delay(this.pollIntervalMs);
      }
    } finally {
      clearInterval(healthTimer);
    }
    this.onEvent({ event: 'worker_stopped', workerLabel: this.workerLabel });
  }

  async runOnce() {
    let claim;
    try {
      claim = await this.tasks.claim({
        queue: this.queue,
        types: [this.taskType],
        workerLabel: this.workerLabel,
        leaseSeconds: this.leaseSeconds
      });
    } catch (error) {
      this.lastCycleOk = false;
      this.onEvent({ event: 'claim_error', code: safeCode(error && error.code, 'NATIVE_AGENT_CLAIM_FAILED'), message: safeMessage(error) });
      return false;
    }
    // A successful durable-queue read proves the polling seam is functioning,
    // whether it returned work or an honest empty queue. Keep this true while
    // a claimed task runs; that task's own lease heartbeat covers execution.
    this.lastCycleOk = true;
    if (!claim || claim.claimed !== true) return false;
    await this._execute(claim);
    return true;
  }

  async _execute(claim) {
    const handle = claim.handle;
    const taskId = handle.taskId;
    const attempt = handle.attempt;
    const log = createRunLog(taskId, attempt);
    const controller = new AbortController();
    let heartbeatTimer = null;
    let finished = false;
    let cancellationRequested = false;
    let leaseLost = false;

    log.decision({ decision: 'claimed', taskId, attempt, workerLabel: this.workerLabel, queue: this.queue, type: this.taskType, pid: process.pid });
    this.onEvent({ event: 'claimed', taskId, attempt });

    let request;
    try {
      request = readPayload(claim.task && claim.task.payload);
      log.decision({ decision: 'payload_accepted', mode: request.mode, timeoutMs: request.timeoutMs || null, maxTurns: request.maxTurns || null, objectiveBytes: Buffer.byteLength(request.objective, 'utf8') });
    } catch (error) {
      log.decision({ decision: 'payload_rejected', code: safeCode(error && error.code, 'NATIVE_AGENT_PAYLOAD_INVALID'), message: safeMessage(error) });
      await this._fail(handle, 'failed', safeCode(error && error.code, 'NATIVE_AGENT_PAYLOAD_INVALID'), safeMessage(error), log);
      log.close();
      return;
    }

    try {
      await this.tasks.start({ handle, leaseSeconds: this.leaseSeconds });
      log.decision({ decision: 'started', leaseSeconds: this.leaseSeconds });
    } catch (error) {
      log.decision({ decision: 'start_failed', code: safeCode(error && error.code, 'NATIVE_AGENT_START_FAILED'), message: safeMessage(error) });
      log.close();
      return;
    }

    // A lost lease means another claimant may already own this task. Abort the
    // agent rather than keep a second execution running against a dead claim.
    const heartbeat = async () => {
      if (finished) return;
      try {
        const value = await this.tasks.heartbeat({ handle, extendSeconds: this.leaseSeconds });
        if (finished) return;
        const cancelled = value && (value.cancellationRequested === true || value.cancelRequested === true);
        log.decision({ decision: 'heartbeat', cancellationRequested: Boolean(cancelled) });
        if (cancelled && !cancellationRequested) {
          cancellationRequested = true;
          log.decision({ decision: 'cancellation_observed' });
          controller.abort();
        }
      } catch (error) {
        if (finished) return;
        leaseLost = true;
        log.decision({ decision: 'heartbeat_failed', code: safeCode(error && error.code, 'NATIVE_AGENT_HEARTBEAT_FAILED'), message: safeMessage(error) });
        controller.abort();
      }
    };
    heartbeatTimer = setInterval(() => { heartbeat().catch(() => {}); }, this.heartbeatIntervalMs);

    const assertCurrentClaim = () => {
      try {
        const value = this.tasks.inspectClaim({ handle });
        if (!value || typeof value.then === 'function') {
          throw new NativeAgentLaunchError('NATIVE_AGENT_CLAIM_CHECK_UNAVAILABLE', 'The native launch claim check must complete synchronously.');
        }
        if (value.cancellationRequested === true || value.cancelRequested === true) {
          cancellationRequested = true;
          throw new NativeAgentLaunchError('NATIVE_AGENT_CANCELLED', 'Cancellation was requested before native launch.');
        }
      } catch (error) {
        if (!cancellationRequested) leaseLost = true;
        controller.abort();
        throw error;
      }
    };

    let outcome;
    try {
      assertCurrentClaim();
      outcome = await this.launch({
        mode: request.mode,
        objective: request.objective,
        timeoutMs: request.timeoutMs,
        maxTurns: request.maxTurns,
        signal: controller.signal,
        beforeLaunch: assertCurrentClaim,
        onEvent: event => log.decision(event),
        onRawLine: line => log.raw(line)
      });
    } catch (error) {
      finished = true;
      clearInterval(heartbeatTimer);
      const code = error instanceof NativeAgentLaunchError
        ? safeCode(error.code, 'NATIVE_AGENT_LAUNCH_REFUSED')
        : safeCode(error && error.code, 'NATIVE_AGENT_LAUNCH_FAILED');
      log.decision({ decision: 'launch_refused', code, message: safeMessage(error) });
      if (leaseLost) {
        log.decision({ decision: 'terminal_skipped_lease_lost' });
        log.close();
        return;
      }
      if (cancellationRequested) {
        await this._fail(handle, 'cancelled', 'NATIVE_AGENT_CANCELLED', 'Cancellation was requested before the native run completed.', log);
        log.close();
        return;
      }
      await this._fail(handle, 'failed', code, safeMessage(error), log);
      log.close();
      return;
    }
    finished = true;
    clearInterval(heartbeatTimer);

    const acceptance = evaluateAcceptance(outcome);
    log.decision({
      decision: 'acceptance_evaluated',
      passed: acceptance.passed,
      code: acceptance.code,
      toolCount: acceptance.toolCount,
      hostExecPresent: acceptance.hostExecPresent
    });

    // Best-effort durable breadcrumb before the terminal write. If the process
    // dies between here and the outcome, the checkpoint still says what ran.
    try {
      await this.tasks.checkpoint({
        handle,
        checkpointKey: `native-agent-${String(attempt).padStart(4, '0')}`,
        expectedRevision: Number.isSafeInteger(claim.task && claim.task.checkpointRevision) ? claim.task.checkpointRevision : 0,
        // The queue's existing { summary, resumeContext } checkpoint contract,
        // unchanged. The machine-readable evidence rides in resumeContext.
        checkpoint: {
          summary: `The native local agent finished with code ${outcome.code || 'ok'}; acceptance ${acceptance.passed ? 'passed' : 'failed'} (${acceptance.code}).`,
          resumeContext: JSON.stringify({
            acceptancePassed: acceptance.passed,
            acceptanceCode: acceptance.code,
            toolCount: acceptance.toolCount === undefined ? null : acceptance.toolCount,
            hostExecPresent: acceptance.hostExecPresent === undefined ? null : acceptance.hostExecPresent,
            hostExecInvoked: outcome.hostExecInvoked === true,
            logFile: log.file
          })
        },
        extendSeconds: this.leaseSeconds
      });
      log.decision({ decision: 'checkpointed' });
    } catch (error) {
      log.decision({ decision: 'checkpoint_failed', code: safeCode(error && error.code, 'NATIVE_AGENT_CHECKPOINT_FAILED'), message: safeMessage(error) });
    }

    if (leaseLost) {
      log.decision({ decision: 'terminal_skipped_lease_lost' });
      log.close();
      return;
    }
    if (cancellationRequested && outcome.code !== 'NATIVE_AGENT_CLEANUP_UNPROVEN') {
      await this._fail(handle, 'cancelled', 'NATIVE_AGENT_CANCELLED', 'The run stopped after cooperative cancellation was requested.', log);
      log.close();
      return;
    }
    if (!outcome.ok || outcome.code === 'NATIVE_AGENT_CLEANUP_UNPROVEN') {
      // A timeout is genuinely uncertain: the agent holds real local capability
      // and may have completed side effects before it was killed. Only a clean
      // refusal to launch is a definite failure, and that path returned above.
      const disposition = ['NATIVE_AGENT_TIMEOUT', 'NATIVE_AGENT_CLEANUP_UNPROVEN'].includes(outcome.code) ? 'uncertain' : 'failed';
      await this._fail(handle, disposition, safeCode(outcome.code, 'NATIVE_AGENT_FAILED'),
        `The native local agent did not complete (${outcome.code || 'unknown'}).`, log);
      log.close();
      return;
    }

    try {
      // The queue's existing { summary } result contract, unchanged. One
      // prefixed JSON line so the dispatching peer can read the acceptance
      // numbers with task.get and no new tool, and a human tail after it.
      const evidence = {
        outcome: 'completed',
        mode: request.mode,
        acceptancePassed: acceptance.passed,
        acceptanceCode: acceptance.code,
        toolCount: acceptance.toolCount === undefined ? null : acceptance.toolCount,
        hostExecPresent: acceptance.hostExecPresent === undefined ? null : acceptance.hostExecPresent,
        hostExecInvoked: outcome.hostExecInvoked === true,
        elapsedMs: outcome.elapsedMs,
        logFile: log.file,
        secretValuesEmitted: false
      };
      const result = await this.tasks.complete({
        handle,
        result: {
          summary: `NATIVE_AGENT_RESULT ${JSON.stringify(evidence)} | ${String(outcome.finalText || 'The native local agent completed.').replace(/\s+/g, ' ').slice(0, 1500)}`
        }
      });
      log.decision({ decision: 'completed', status: result && result.status });
      this.onEvent({ event: 'completed', taskId, attempt, acceptancePassed: acceptance.passed, toolCount: acceptance.toolCount });
    } catch (error) {
      log.decision({ decision: 'complete_failed', code: safeCode(error && error.code, 'NATIVE_AGENT_COMPLETE_FAILED'), message: safeMessage(error) });
    }
    log.close();
  }

  async _fail(handle, disposition, code, message, log) {
    try {
      await this.tasks.fail({ handle, disposition, code, message });
      log.decision({ decision: 'failed_recorded', disposition, code });
      this.onEvent({ event: 'failed', taskId: handle.taskId, disposition, code });
    } catch (error) {
      log.decision({ decision: 'fail_record_error', code: safeCode(error && error.code, 'NATIVE_AGENT_FAIL_RECORD_FAILED'), message: safeMessage(error) });
    }
  }
}

module.exports = { HEALTH_HEARTBEAT_MS, HEARTBEAT_MS, LEASE_SECONDS, NativeAgentWorker, QUEUE, TASK_TYPE, readPayload, workerId };
