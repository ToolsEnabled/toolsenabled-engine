'use strict';

// The research-runs worker: claims from the reserved 'research-runs' queue and
// drives one run at a time through preflight → runner → collector → durable
// results. Its claim-loop shape, lease heartbeat and retry discipline are the
// overnight advisory worker's; what differs is the work. Pausing is honest:
// every claimed task re-checks the settings gate and the project's enabled
// flag before anything executes, so flipping either off stops queued work with
// a named retry code rather than letting it drain.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../providers/tasks');
const { getStateStore } = require('../state-store');
const settingsGate = require('./settings-gate');
const runners = require('./runners');
const collectors = require('./collectors');
const provenance = require('./provenance');
const studyProtocol = require('./study-protocol');
const { rootPath } = require('../runtime');
const { knownProviderCredentialPattern } = require('../secret-patterns');

const QUEUE = 'research-runs';
const TYPE = 'research-run';
const DEFAULT_IDLE_MS = 15_000;
const MAX_IDLE_MS = 60_000;
const PAUSE_MS = 5 * 60_000;
const LEASE_SECONDS = 300;
const HEARTBEAT_MS = 30_000;
const TRANSIENT_CODES = new Set([
  'RESEARCH_RUN_SERIALIZED', 'RESEARCH_PAUSED_BY_SETTINGS', 'RESEARCH_PROJECT_DISABLED',
  'RESEARCH_BRIDGE_UNAVAILABLE', 'RESEARCH_RUN_INDETERMINATE'
]);
const COULD_NOT_TELL_CODES = new Set(['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']);

function safeError(error) {
  return String(error && error.message ? error.message : error || 'Unknown research run failure')
    .replace(/(?:Bearer|Basic)\s+[^\s,]+/gi, '$1 REDACTED')
    .replace(knownProviderCredentialPattern('g'), 'REDACTED')
    .replace(/\s+/g, ' ').slice(0, 900) || 'Unknown research run failure';
}

function workerId() { return `research-runs.${process.pid}.${crypto.randomBytes(3).toString('hex')}`; }

class ResearchRunsWorker {
  constructor(options = {}) {
    // The internal wrapper is what passes the reserved-queue fence; the public
    // task.* surface can never drive this queue.
    this.state = tasks.internalResearchRunsState(options.state || getStateStore());
    this.gate = options.gate || (() => settingsGate.loadGate());
    this.runProcess = options.runProcess || runners.runProcess;
    this.runHttp = options.runHttp || runners.runHttp;
    this.runAgent = options.runAgent || runners.runAgent;
    this.collect = options.collect || collectors.collect;
    this.artifactRoot = options.artifactRoot || rootPath('state', 'research');
    this.workerLabel = options.workerLabel || workerId();
    this.leaseSeconds = options.leaseSeconds || LEASE_SECONDS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || HEARTBEAT_MS;
    this.idleMs = options.idleMs || DEFAULT_IDLE_MS;
    this.pauseMs = options.pauseMs || PAUSE_MS;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.stopped = false;
    this.busy = false;
    this.activeController = null;
    this.wakeIdle = null;
    this.cleanupBlocked = false;
    this.nextDelayMs = this.idleMs;
    // While the mission bridge was just observed down, agent-kind runs are
    // deferred attempt-neutrally instead of being claimed into the same wall.
    this.bridgeDownUntilMs = 0;
  }

  stop() {
    this.stopped = true;
    this.activeController?.abort(new collectors.CollectorError('RESEARCH_RUN_WORKER_STOPPED',
      'The research worker stopped; an active process must finish its bounded cleanup before any result is accepted.'));
    this.wakeIdle?.();
  }

  _delay(milliseconds) {
    if (this.stopped) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); if (this.wakeIdle === done) this.wakeIdle = null; resolve(); };
      const timer = setTimeout(done, milliseconds);
      this.wakeIdle = done;
    });
  }

  setPriority() {
    try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); return 'below_normal'; }
    catch { return 'unknown'; }
  }

  reconcile() { return this.state.reapExpiredTasks({ queue: QUEUE, limit: 1000 }); }

  async runForever() {
    this.setPriority();
    this.reconcile();
    let idleDelay = this.idleMs;
    while (!this.stopped) {
      const worked = await this.runOnce();
      if (this.stopped) break;
      if (this.nextDelayMs > idleDelay) {
        await this._delay(this.nextDelayMs);
        idleDelay = this.idleMs;
      } else if (!worked) {
        await this._delay(idleDelay);
        idleDelay = Math.min(MAX_IDLE_MS, idleDelay * 2);
      } else {
        idleDelay = this.idleMs;
      }
      this.nextDelayMs = this.idleMs;
    }
  }

  async runOnce() {
    if (this.stopped || this.busy || this.cleanupBlocked) return false;
    this.busy = true;
    try { return await this._runOnce(); }
    finally { this.busy = false; }
  }

  async _runOnce() {
    this.nextDelayMs = this.idleMs;
    if (this.stopped) return false;
    // Pause by NOT claiming, never by claim-then-retry: a retry burns a task
    // attempt per cycle and the closed taxonomy caps local-write retries, so
    // pause-by-retry quietly kills waiting runs on the second cycle. With the
    // pipeline off nothing is claimed at all; disabled projects and withheld
    // runner kinds are deferred attempt-neutrally before each claim. The
    // in-execute checks below remain as backstops for mid-claim races.
    const decided = this.gate();
    if (decided.pipelineWithheld) {
      this.nextDelayMs = this.pauseMs;
      return false;
    }
    const withheldKinds = Object.entries(decided.runners)
      .filter(([, entry]) => entry.state !== 'enabled').map(([kind]) => kind);
    if (this.bridgeDownUntilMs > Date.now() && !withheldKinds.includes('agent')) withheldKinds.push('agent');
    try { this.state.deferResearchRuns({ withheldKinds, delayMs: this.pauseMs }); }
    catch (error) {
      // A failed pre-claim sweep cannot establish that withheld work was
      // deferred. Refuse to claim rather than silently treating that unknown
      // set as empty and possibly executing a withheld runner kind.
      this.onEvent({ type: 'defer_error', code: error.code || 'DEFER_FAILED' });
      this.nextDelayMs = this.pauseMs;
      return false;
    }
    const claimed = await tasks.claim({ queue: QUEUE, types: [TYPE], workerLabel: this.workerLabel, leaseSeconds: this.leaseSeconds }, { state: this.state });
    if (!claimed.claimed) return false;
    await this._execute(claimed);
    return true;
  }

  _requireCurrentPolicy(experiment) {
    const decided = this.gate();
    if (decided.pipelineWithheld) {
      throw new runners.ResearchPolicyRefusal('RESEARCH_PAUSED_BY_SETTINGS',
        decided.pipeline.why || 'The research pipeline is off.', 'pipeline');
    }
    const runnerDecision = decided.runners[experiment.runnerKind];
    if (!runnerDecision || runnerDecision.state !== 'enabled') {
      throw new runners.ResearchPolicyRefusal('RESEARCH_PAUSED_BY_SETTINGS',
        runnerDecision ? runnerDecision.why : `Runner kind "${experiment.runnerKind}" has no control and is withheld.`, 'runner');
    }
    const project = this.state.getResearchProject({ projectId: experiment.projectId });
    if (!project) throw new collectors.CollectorError('RESEARCH_PROJECT_NOT_FOUND', 'The experiment\'s project no longer exists.');
    if (project.enabled !== true || project.status !== 'active') {
      throw new runners.ResearchPolicyRefusal('RESEARCH_PROJECT_DISABLED',
        `Project "${project.name}" is disabled or archived; its queued runs wait until it is enabled again.`, 'project');
    }
    return project;
  }

  async _checkpoint(handle, revision, summary, phase, extra = {}) {
    const saved = await tasks.checkpoint({
      handle, checkpointKey: `research-run-${handle.taskId}-${String(revision + 1).padStart(3, '0')}`,
      expectedRevision: revision, extendSeconds: this.leaseSeconds,
      checkpoint: { summary: String(summary).slice(0, 1900), resumeContext: JSON.stringify({ phase, ...extra }).slice(0, 4000) }
    }, { state: this.state });
    return Number.isSafeInteger(saved.revision) ? saved.revision : revision + 1;
  }

  async _retry(handle, revision, code, message) {
    try { await this._checkpoint(handle, revision, `Paused safely: ${message}`, 'paused', { code }); }
    catch { /* The lease transition still carries the durable retry reason. */ }
    try {
      await tasks.fail({ handle, disposition: 'retry', code, message, retryDelaySeconds: Math.floor(this.pauseMs / 1000) }, { state: this.state });
    } catch (adapterError) {
      // The closed taxonomy ceilings local-write retries at two ATTEMPTS, and
      // a second claim-while-paused would surface as INVALID_REQUEST — a pause
      // reported as a malformed request, which is a lie. A pause is not a
      // failure: fall back to the state layer's own retry, which is bounded by
      // the task's maxAttempts instead, keeping the pause code on the record.
      this.onEvent({ type: 'retry_adapter_refused', taskId: handle.taskId, code: adapterError.code || 'RETRY_REFUSED' });
      await this.state.failTask({
        taskId: handle.taskId, attempt: handle.attempt, workerLabel: handle.workerLabel,
        claimToken: handle.claimToken, fence: handle.fence
      }, { disposition: 'retry', code, message, retryDelayMs: this.pauseMs });
    }
    this.nextDelayMs = this.pauseMs;
  }

  _artifactDir(project, experiment, run, handle) {
    let parent = path.resolve(this.artifactRoot);
    fs.mkdirSync(parent, { recursive: true });
    // The globally unique run id already binds its project and experiment in
    // the state store. Repeating all three ids here consumed ~80 unnecessary
    // path characters and made valid Windows roots fail at mkdtemp/spawn.
    // Existing artifact pointers remain opaque and are never moved or reused.
    for (const child of [null, run.runId]) {
      if (child !== null) {
        parent = path.join(parent, child);
        try { fs.mkdirSync(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new collectors.CollectorError('RESEARCH_RUN_ARTIFACT_PATH_REFUSED', 'The run artifact root or a scoped parent is not a regular directory; it was not followed.');
      }
    }
    // An attempt must never collect a predecessor's files after a retry or
    // crash. Keep the old evidence and create a new, exclusive directory.
    const dir = fs.mkdtempSync(path.join(parent, `attempt-${handle.attempt}-`));
    return dir;
  }

  async _execute(claim) {
    const { handle, task } = claim;
    let started = false;
    let revision = Number.isSafeInteger(task.checkpointRevision) ? task.checkpointRevision : 0;
    let heartbeatTimer = null;
    let cancellationRequested = false;
    let heartbeatPending = false;
    let heartbeatWork = null;
    let heartbeatFailure = null;
    let finished = false;
    const controller = new AbortController();
    this.activeController = controller;
    if (this.stopped) this.stop();
    const requireContinuing = () => {
      if (heartbeatFailure) throw heartbeatFailure;
      if (this.stopped && !cancellationRequested) {
        throw new collectors.CollectorError('RESEARCH_RUN_WORKER_STOPPED', 'The research worker stopped before accepting an outcome. Process cleanup is reported separately; a dispatched agent may still be running.');
      }
    };
    try {
      const begin = await tasks.start({ handle, leaseSeconds: this.leaseSeconds }, { state: this.state });
      started = true;
      revision = Number.isSafeInteger(begin.checkpointRevision) ? begin.checkpointRevision : revision;
      requireContinuing();
      const heartbeat = async () => {
        if (heartbeatPending || cancellationRequested || heartbeatFailure || finished) return;
        heartbeatPending = true;
        try {
          const update = await tasks.heartbeat({ handle, extendSeconds: this.leaseSeconds }, { state: this.state });
          if (finished) return;
          cancellationRequested = cancellationRequested || update.cancellationRequested === true;
          if (cancellationRequested) controller.abort(new collectors.CollectorError('CANCELLED', 'The task requested cancellation.'));
        } catch (error) {
          if (finished) return;
          heartbeatFailure = error;
          controller.abort(error);
          this.onEvent({ type: 'heartbeat_error', taskId: handle.taskId, code: error.code || 'HEARTBEAT_FAILED' });
        } finally { heartbeatPending = false; }
      };
      heartbeatTimer = setInterval(() => {
        if (!heartbeatPending && !finished) heartbeatWork = heartbeat();
      }, this.heartbeatIntervalMs);

      // The run row, experiment and project are the durable truth; the task
      // payload is only the pointer that got us here.
      const run = this.state.getResearchRunByTask({ taskId: handle.taskId });
      if (!run) {
        await tasks.fail({ handle, disposition: 'failed', code: 'RESEARCH_RUN_ORPHAN_TASK', message: 'No research run row matches this task.' }, { state: this.state });
        return;
      }
      const experiment = this.state.getResearchExperiment({ experimentId: run.experimentId });
      if (!experiment || experiment.status !== 'active') {
        await tasks.fail({ handle, disposition: 'failed', code: 'RESEARCH_EXPERIMENT_ARCHIVED', message: 'The experiment no longer accepts runs.' }, { state: this.state });
        return;
      }
      let project = this.state.getResearchProject({ projectId: experiment.projectId });
      if (!project) {
        await tasks.fail({ handle, disposition: 'failed', code: 'RESEARCH_PROJECT_NOT_FOUND', message: 'The experiment\'s project no longer exists.' }, { state: this.state });
        return;
      }
      // The fenced task already identifies its durable run. Do not duplicate
      // generated IDs into generic free-text checkpoints: valid hex IDs can
      // match a provider credential shape (for example rr-eaa...). Keep the
      // plaintext credential guard intact for all checkpoint content.
      revision = await this._checkpoint(handle, revision, 'Claimed a research run.', 'claimed', {});

      // Every awaited checkpoint can outlive a policy change. Keep this check
      // synchronous so callers can reuse it at the native root-admission hook.
      const requirePolicy = () => { project = this._requireCurrentPolicy(experiment); };
      requirePolicy();

      // Admission: the experiment's own parallelism cap and, when declared,
      // the cross-experiment mutex. The fenced queue is the lock.
      const activeForExperiment = this.state.countActiveResearchRuns({ experimentId: experiment.experimentId, excludeTaskId: handle.taskId });
      if (activeForExperiment >= experiment.maxParallel) {
        await this._retry(handle, revision, 'RESEARCH_RUN_SERIALIZED', `The experiment already has ${activeForExperiment} active run(s) of an allowed ${experiment.maxParallel}.`);
        return;
      }
      if (experiment.mutexKey) {
        const activeForMutex = this.state.countActiveResearchRuns({ mutexKey: experiment.mutexKey, excludeTaskId: handle.taskId });
        if (activeForMutex > 0) {
          await this._retry(handle, revision, 'RESEARCH_RUN_SERIALIZED', `Another run holds the shared "${experiment.mutexKey}" workspace.`);
          return;
        }
      }

      const schemaErrors = collectors.schemaDefinitionProblems(experiment.resultSchema);
      if (schemaErrors.length) throw new collectors.CollectorError('RESEARCH_RESULT_SCHEMA_UNSUPPORTED', schemaErrors.join('; '));
      const pins = provenance.validatePinnedFiles(experiment.runnerKind, experiment.runnerConfig);
      const studyManifest = studyProtocol.validateStudyProtocol(experiment.runnerKind, experiment.runnerConfig);
      const artifactDir = this._artifactDir(project, experiment, run, handle);
      this.state.setResearchRunArtifactDir({ runId: run.runId, artifactDir, handle });
      // The exact artifact path was just persisted under the same claim fence;
      // checkpoint consumers resolve it from the run, not a duplicated string.
      revision = await this._checkpoint(handle, revision, 'Preflight passed; the run is admitted.', 'preflight', {});

      requireContinuing();
      if (cancellationRequested) {
        await tasks.fail({ handle, disposition: 'cancelled', code: 'CANCELLED', message: 'The research worker observed cancellation before the runner started.' }, { state: this.state });
        return;
      }
      revision = await this._checkpoint(handle, revision, `Running the ${experiment.runnerKind} runner.`, 'running', { runnerKind: experiment.runnerKind });
      requireContinuing();
      if (cancellationRequested) throw new collectors.CollectorError('CANCELLED', 'Cancellation was observed before the runner started.');
      requirePolicy();

      let outcome;
      if (experiment.runnerKind === 'process') outcome = await this.runProcess({ experiment, run, artifactDir, signal: controller.signal, requirePolicy, beforeLaunch: async () => {
        // Do not skip this read when the periodic heartbeat is still pending.
        // Pin verification introduced an await before the process side effect.
        const update = await tasks.heartbeat({ handle, extendSeconds: this.leaseSeconds }, { state: this.state });
        cancellationRequested = cancellationRequested || update.cancellationRequested === true;
        if (cancellationRequested) controller.abort(new collectors.CollectorError('CANCELLED', 'The task requested cancellation before launch.'));
        requireContinuing();
        if (cancellationRequested) throw new collectors.CollectorError('CANCELLED', 'Cancellation was observed after verifying inputs and before the command started.');
        requirePolicy();
      } });
      else if (experiment.runnerKind === 'http') outcome = await this.runHttp({ experiment, run });
      else outcome = await this.runAgent({ experiment, run, project, artifactDir });

      if (experiment.runnerKind === 'agent') {
        // This queue task finishes at dispatch, not at research completion.
        // The explicit evidence status prevents a receipt becoming a result.
        if (!outcome || typeof outcome.launchId !== 'string' || !outcome.launchId.trim()) {
          throw new collectors.CollectorError('RESEARCH_RUN_DISPATCH_UNCONFIRMED', 'The dispatch returned no launch reference. No completed research result was confirmed.');
        }
        if (outcome.launchId) {
          this.state.setResearchRunSession({ runId: run.runId, sessionRefKind: 'launch', sessionRef: outcome.launchId, handle });
          try {
            this.state.assignResearchSessions({ projectId: project.projectId, assignedBy: 'research-worker', sessions: [{ kind: 'launch', ref: outcome.launchId }] });
          } catch (error) {
            this.onEvent({ type: 'assignment_error', taskId: handle.taskId, code: error.code || 'ASSIGNMENT_FAILED' });
          }
        }
        requireContinuing();
        if (cancellationRequested) {
          await tasks.fail({ handle, disposition: 'cancelled', code: 'CANCELLED', message: 'Cancellation was observed after dispatch; the referenced agent may still be running.' }, { state: this.state });
          return;
        }
        await tasks.complete({ handle, result: {
          summary: outcome.launchId ? `Dispatched as launch ${outcome.launchId}.` : 'Dispatched; the bridge receipt carried no launch reference.',
          runnerKind: 'agent', launchId: outcome.launchId, durationMs: outcome.durationMs,
          evidenceStatus: 'dispatch-only',
          contentTrust: 'untrusted', grantsAuthority: false
        } }, { state: this.state });
        this.onEvent({ type: 'completed', taskId: handle.taskId, runnerKind: 'agent' });
        return;
      }

      if (experiment.runnerKind === 'process') {
        if (!outcome || typeof outcome !== 'object') throw new collectors.CollectorError('RESEARCH_RUN_PROCESS_OUTCOME_INVALID', 'The process runner returned no lifecycle outcome.');
        const lifecycle = outcome.processLifecycle;
        if (lifecycle?.cleanupStatus === 'UNKNOWN') {
          this.cleanupBlocked = true;
          this.stop();
          try {
            revision = await this._checkpoint(handle, revision, 'Process cleanup remains unproved; this worker will claim no further work.',
              'cleanup-unproven', { processLifecycle: lifecycle, causeCode: outcome.failure?.code || null });
          } catch { /* A lost claim must not write through its successor's fence. */ }
          throw new collectors.CollectorError('RESEARCH_RUN_CLEANUP_UNPROVEN',
            'The process cleanup deadline ended without confirmed cleanup. This worker is halted and no result was collected.');
        }
        if (lifecycle && lifecycle.acceptanceReady !== true) {
          try {
            revision = await this._checkpoint(handle, revision, 'The process did not produce an acceptable completion; cleanup is recorded separately.',
              'process-stopped', { processLifecycle: lifecycle, causeCode: outcome.failure?.code || null });
          } catch (error) {
            // Cancellation and lease loss can legitimately close the existing
            // checkpoint fence. Never write around it to preserve a receipt.
            if (error?.code === 'TASK_CANCEL_REQUESTED') cancellationRequested = true;
            this.onEvent({ type: 'process_receipt_record_error', taskId: handle.taskId, code: error?.code || 'CHECKPOINT_FAILED' });
          }
        }
        requireContinuing();
        if (cancellationRequested) {
          await tasks.fail({ handle, disposition: 'cancelled', code: 'CANCELLED', message: 'Cancellation was observed; no process result was accepted.' }, { state: this.state });
          return;
        }
        if (outcome.admissionRefusal) {
          if (lifecycle?.cleanupStatus !== 'NOT_STARTED' || lifecycle.started !== false || lifecycle.pipesClosed !== true
              || lifecycle.receipt?.type !== 'not-started' || lifecycle.receipt.activeProcesses !== 0) {
            throw new collectors.CollectorError('RESEARCH_RUN_PROCESS_OUTCOME_INVALID', 'A policy refusal did not carry a confirmed non-start lifecycle.');
          }
          const refused = outcome.admissionRefusal;
          throw new runners.ResearchPolicyRefusal(refused.code, refused.message, refused.reason);
        }
        if (outcome.spawnError) {
          await tasks.fail({ handle, disposition: 'failed', code: 'RESEARCH_RUN_SPAWN_FAILED', message: safeError(outcome.spawnError) }, { state: this.state });
          return;
        }
        if (outcome.timedOut) {
          await tasks.fail({ handle, disposition: 'failed', code: 'RESEARCH_RUN_TIMEOUT', message: `The declared command exceeded its ${experiment.timeoutMs}ms limit. No result was accepted.` }, { state: this.state });
          return;
        }
        if (outcome.cancelled === true) throw new collectors.CollectorError('RESEARCH_RUN_ABORTED', 'The process runner was aborted; no result was accepted.');
        if (outcome.failure) throw new collectors.CollectorError(outcome.failure.code || 'RESEARCH_RUN_PROCESS_FAILED', safeError(outcome.failure));
        if (outcome.exitCode !== 0) {
          await tasks.fail({ handle, disposition: 'failed', code: 'RESEARCH_RUN_PROCESS_FAILED', message: `Exit code ${outcome.exitCode}. ${safeError(outcome.stderr || outcome.stdout)}` }, { state: this.state });
          return;
        }
        if (!lifecycle || lifecycle.schemaVersion !== 1 || lifecycle.acceptanceReady !== true) {
          throw new collectors.CollectorError('RESEARCH_RUN_PROCESS_OUTCOME_INVALID', 'The process lifecycle did not confirm a complete successful execution.');
        }
      }
      if (experiment.runnerKind === 'http' && (!Number.isInteger(outcome.status) || outcome.status < 200 || outcome.status >= 300)) {
        await tasks.fail({ handle, disposition: 'failed', code: 'RESEARCH_RUN_HTTP_FAILED', message: `The declared request answered status ${outcome.status}.` }, { state: this.state });
        return;
      }
      if (outcome.truncated === true || outcome.stdoutTruncated === true || outcome.stderrTruncated === true) {
        throw new collectors.CollectorError('RESEARCH_RUN_OUTPUT_INCOMPLETE', 'The runner output exceeded its capture limit. Partial output is not a complete research result.');
      }
      if (pins) provenance.assertProcessReceipt(outcome.provenance, { pins, runId: run.runId, artifactDir });

      revision = await this._checkpoint(handle, revision, 'Runner finished; collecting results.', 'collecting', {});
      const collected = this.collect({
        collector: experiment.collector, resultSchema: experiment.resultSchema,
        stdout: experiment.runnerKind === 'http' ? outcome.body : outcome.stdout,
        artifactDir
      });
      if (!collected || !Array.isArray(collected.records) || !Array.isArray(collected.refused)
          || !Number.isSafeInteger(collected.dropped) || collected.dropped < 0) {
        throw new collectors.CollectorError('RESEARCH_RUN_COLLECTION_INVALID', 'The collector did not return a valid completeness report.');
      }
      if (collected.refused.length || collected.dropped > 0) {
        throw new collectors.CollectorError('RESEARCH_RUN_RESULTS_INCOMPLETE',
          `Collection refused ${collected.refused.length} item(s) and omitted ${collected.dropped}. No partial set was accepted. ${collected.refused.slice(0, 3).map(entry => entry.reason).join('; ')}`);
      }
      if (experiment.collector.kind !== 'none' && collected.records.length === 0) {
        throw new collectors.CollectorError('RESEARCH_RUN_RESULTS_EMPTY', 'The declared collector produced no result records. A successful command alone does not confirm a research result.');
      }
      requireContinuing();
      if (cancellationRequested) {
        await tasks.fail({ handle, disposition: 'cancelled', code: 'CANCELLED', message: 'The research worker observed cancellation before recording results.' }, { state: this.state });
        return;
      }
      await tasks.completeResearchRun({ handle, runId: run.runId, records: collected.records, result: {
        summary: experiment.collector.kind === 'none' ? 'The declared runner completed without collecting results.'
          : `Collected all ${collected.records.length} declared result record(s). This is collection evidence, not independent verification of the reported measurements.`,
        runnerKind: experiment.runnerKind,
        evidenceStatus: experiment.collector.kind === 'none' ? 'execution-only' : 'collected',
        refused: collected.refused.slice(0, 20), dropped: collected.dropped, durationMs: outcome.durationMs,
        ...(experiment.runnerKind === 'http' ? { status: outcome.status } : { exitCode: outcome.exitCode }),
        ...(outcome.processLifecycle ? { processLifecycle: outcome.processLifecycle } : {}),
        ...(pins ? { provenance: outcome.provenance } : {}),
        ...(studyManifest ? { studyProtocol: studyProtocol.studyProtocolDeclaration(studyManifest, {
          runId: run.runId, experimentId: experiment.experimentId, experimentConfigHash: experiment.configHash,
          paramsHash: run.paramsHash, attempt: handle.attempt, fence: handle.fence
        }) } : {}),
        contentTrust: 'untrusted', grantsAuthority: false
      } }, { state: this.state });
      this.onEvent({ type: 'completed', taskId: handle.taskId, runnerKind: experiment.runnerKind, recorded: collected.records.length });
    } catch (error) {
      if (!started) return;
      const observedCode = String(error && error.code || 'RESEARCH_RUN_FAILED').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100);
      // The final transaction may observe a real cancellation before the next
      // heartbeat. Conversely, a heartbeat error is not a cancellation request.
      if (observedCode === 'TASK_CANCEL_REQUESTED') cancellationRequested = true;
      // Resource exhaustion and transient I/O failures say only that this
      // attempt could not inspect or persist the run. They do not establish
      // absence (or a failed experiment), and unlike a known-down bridge they
      // must not be latched into a decision about later runs.
      const couldNotTell = COULD_NOT_TELL_CODES.has(observedCode);
      const code = couldNotTell ? 'RESEARCH_RUN_INDETERMINATE' : observedCode;
      if (code === 'RESEARCH_BRIDGE_UNAVAILABLE') this.bridgeDownUntilMs = Date.now() + this.pauseMs;
      let failureRecorded = true;
      try {
        if (error instanceof runners.ResearchPolicyRefusal && !cancellationRequested && !this.cleanupBlocked) {
          await this._retry(handle, revision, code, safeError(error));
          this.onEvent({ type: 'paused', taskId: handle.taskId, reason: error.reason });
          return;
        } else if (couldNotTell) {
          await this._retry(handle, revision, code, `The worker could not tell whether the run can proceed (${observedCode}); this does not claim that any required resource is absent.`);
        } else if (TRANSIENT_CODES.has(code)) await this._retry(handle, revision, code, safeError(error));
        else await tasks.fail({ handle, disposition: cancellationRequested ? 'cancelled' : 'failed',
          code: cancellationRequested && !this.cleanupBlocked ? 'CANCELLED' : code,
          message: cancellationRequested && !this.cleanupBlocked ? 'The research worker observed cancellation.' : safeError(error) }, { state: this.state });
      } catch (completionError) {
        failureRecorded = false;
        this.onEvent({ type: 'failure_record_error', taskId: handle.taskId, code: completionError.code || 'FAILURE_RECORD_FAILED' });
      }
      if (failureRecorded) this.onEvent({ type: 'failed', taskId: handle.taskId, code });
    } finally {
      finished = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // A pending asynchronous heartbeat must drain before runForever returns
      // and the supervised entrypoint closes its worker-owned DB connection.
      if (heartbeatWork) await heartbeatWork;
      if (this.activeController === controller) this.activeController = null;
    }
  }
}

module.exports = {
  DEFAULT_IDLE_MS, HEARTBEAT_MS, LEASE_SECONDS, PAUSE_MS, QUEUE, TRANSIENT_CODES, TYPE,
  ResearchRunsWorker, workerId
};
