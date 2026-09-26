'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT } = require('../runtime');
const { assertActive, loadPolicy } = require('../policy');
const audit = require('../audit');
const operationAudit = require('../operation-audit');
const { assertValid } = require('../schema-validator');
const { getStateStore } = require('../state-store');
const { createWindowsSchedulerAdapter, resolveCurrentPrincipalId, resolveCurrentPrincipalName, SchedulerAdapterError } = require('../scheduler-adapter');
const { SUPPORTED_SCHEDULED_ACTIONS, normalizeScheduledAction } = require('../scheduled-actions');
const errorTaxonomy = require('../error-taxonomy');

const DEFAULT_RECONCILE_LIMIT = 16;

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function publicTypedError(value, options = {}) {
  if (value === undefined || value === null) return value;
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value : { code: 'SCHEDULER_ADAPTER_FAILED' };
  return {
    ...source,
    taxonomy: errorTaxonomy.publicFailure(errorTaxonomy.adaptToolError(source, options))
  };
}

function boundedMessage(error, redact = audit.redact) {
  return redact(error && (error.message || String(error))).slice(0, 1000) || 'Scheduler reconciliation failed.';
}

function schedulerErrorCode(error) {
  const candidate = String(error && error.code || 'SCHEDULER_ADAPTER_FAILED').slice(0, 200);
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(candidate) ? candidate : 'SCHEDULER_ADAPTER_FAILED';
}

function validPrincipalId(value) {
  return typeof value === 'string' && /^S-\d-(?:\d+-){1,14}\d+$/i.test(value);
}

function publicRegistration(registration) {
  if (!registration) return null;
  return compact({
    generation: registration.generation,
    taskName: registration.taskName,
    desiredState: registration.desiredState,
    observedState: registration.observedState,
    error: publicTypedError(registration.error, { timedOut: registration.observedState === 'uncertain' }),
    observedAtMs: registration.observedAtMs,
    updatedAtMs: registration.updatedAtMs
  });
}

function publicJob(job) {
  if (!job) return null;
  return compact({
    jobId: job.jobId,
    name: job.name,
    generation: job.generation,
    activeGeneration: job.activeGeneration,
    schedule: job.schedule,
    intervalMinutes: job.intervalMinutes,
    action: job.action,
    args: job.args,
    desiredState: job.desiredState,
    providerState: job.providerState,
    providerError: publicTypedError(job.providerError, { timedOut: job.providerState === 'uncertain' }),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    removedAt: job.removedAt,
    lastRunAt: job.lastRunAt,
    lastResult: job.lastResult,
    registration: publicRegistration(job.registration)
  });
}

function normalizeCreateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('scheduler.create input must be an object.');
  return { ...input, action: normalizeScheduledAction(input.action), args: input.args === undefined ? {} : input.args };
}

function createSchedulerProvider(dependencies = {}) {
  const state = () => dependencies.state || getStateStore();
  const adapter = dependencies.adapter || createWindowsSchedulerAdapter(dependencies.adapterDependencies);
  const policy = dependencies.policy || { assertActive, load: loadPolicy };
  const auditor = dependencies.audit || audit;
  const record = (event, target, details) => operationAudit.record(event, target, details, { audit: auditor });
  let cachedRuntime;
  let initialized = false;
  let legacyImport = null;
  function schedulerRuntime() {
    if (!cachedRuntime) cachedRuntime = Object.freeze({
      nodePath: path.resolve(dependencies.nodePath || process.execPath),
      runnerPath: path.resolve(dependencies.runnerPath || path.join(ROOT, 'src', 'job-runner.js')),
      principalId: dependencies.principalId || (dependencies.resolveCurrentPrincipalId || resolveCurrentPrincipalId)()
    });
    return cachedRuntime;
  }

  function validateAction(action, args) {
    if (!SUPPORTED_SCHEDULED_ACTIONS.includes(action)) throw new Error(`Scheduled action '${action}' is not supported.`);
    if (args && typeof args === 'object' && Object.prototype.hasOwnProperty.call(args, 'approvalToken')) {
      throw new Error('Scheduled action arguments must not contain an approvalToken.');
    }
    if (dependencies.validateAction) return dependencies.validateAction(action, args);
    // Lazy loading avoids a module-initialization cycle: tool-registry imports
    // this provider, while scheduled executions deliberately reuse its schemas.
    const target = require('../tool-registry').getTool(action);
    if (!target || target.effect !== 'external-write') throw new Error(`Scheduled action '${action}' is not an external-write tool.`);
    // '' (no root label), not '$.arguments': `args` already IS the target
    // tool's own flat arguments object, the same object a direct dispatch
    // through tool-registry.js#executeTool would validate. Naming a missing
    // field "$.arguments.url" sent a caller looking for a field this tool has
    // never had -- see executeTool's assertValid call for the full measurement.
    assertValid(target.baseInputSchema || target.inputSchema, args, { path: '' });
  }

  function maxScheduledJobs() {
    const configured = policy.load();
    const raw = configured && configured.limits && configured.limits.maxScheduledJobs;
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 50;
  }

  function ensureInitialized() {
    if (!dependencies.adapter && (dependencies.platform || process.platform) !== 'win32') {
      throw new SchedulerAdapterError('SCHEDULER_PLATFORM_UNSUPPORTED',
        'Scheduled jobs require Windows Task Scheduler; this platform has no scheduler adapter.',
        { retryable: false });
    }
    if (initialized) return legacyImport;
    const store = state();
    if (typeof store.importLegacyScheduler === 'function') {
      legacyImport = store.importLegacyScheduler({
        runtime: schedulerRuntime(),
        maxScheduledJobs: maxScheduledJobs(),
        validateAction
      });
    } else legacyImport = { status: 'unsupported' };
    initialized = true;
    return legacyImport;
  }

  function reconcileLegacyTasks(selectedName = null) {
    const imported = ensureInitialized();
    if (imported && imported.status === 'unsupported') {
      return { status: 'unsupported', total: 0, removed: 0, absent: 0, conflicts: 0, unknown: 0, tasks: [] };
    }
    const candidates = (imported && Array.isArray(imported.legacyTasks) ? imported.legacyTasks : [])
      .filter(item => selectedName === null || item.name === selectedName);
    if (candidates.length === 0) {
      return { status: 'not_applicable', total: 0, removed: 0, absent: 0, conflicts: 0, unknown: 0, tasks: [] };
    }
    if (typeof adapter.removeLegacy !== 'function') {
      return { status: 'unsupported', total: candidates.length, removed: 0, absent: 0, conflicts: 0, unknown: candidates.length, tasks: [] };
    }
    if (!/^[a-f0-9]{64}$/.test(imported.digest || '')) {
      return {
        status: 'attention_required', total: candidates.length, removed: 0, absent: 0, conflicts: 0,
        unknown: candidates.length,
        tasks: candidates.map(item => ({ name: item.name, state: 'unknown', code: 'SCHEDULER_LEGACY_DIGEST_MISSING' }))
      };
    }
    const runtime = schedulerRuntime();
    let principalName;
    try {
      principalName = dependencies.principalName
        || (dependencies.resolveCurrentPrincipalName || resolveCurrentPrincipalName)();
    } catch (error) {
      const code = schedulerErrorCode(error);
      return {
        status: 'attention_required', total: candidates.length, removed: 0, absent: 0, conflicts: 0,
        unknown: candidates.length, tasks: candidates.map(item => ({ name: item.name, state: 'unknown', code }))
      };
    }
    const tasks = [];
    for (const candidate of candidates) {
      if (!Number.isSafeInteger(candidate.createdAtMs) || candidate.createdAtMs < 0) {
        const missing = { name: candidate.name, state: 'conflict', code: 'SCHEDULER_LEGACY_EVIDENCE_INCOMPLETE', reason: 'created-at-missing' };
        tasks.push(missing);
        record('scheduler.legacy.cleanup.result', `\\ToolsEnabled-${candidate.name}`, {
          ...missing, sourceDigest: imported.digest, matcherVersion: 1
        });
        continue;
      }
      const spec = {
        name: candidate.name, schedule: candidate.schedule, taskName: `\\ToolsEnabled-${candidate.name}`,
        nodePath: runtime.nodePath, runnerPath: runtime.runnerPath, principalId: runtime.principalId,
        principalName, createdAtMs: candidate.createdAtMs
      };
      try {
        const result = adapter.removeLegacy(spec, {
          beforeMutation(event) {
            policy.assertActive('scheduler.legacy.delete');
            const evidenceHash = event && event.observation && event.observation.evidenceHash;
            if (!/^[a-f0-9]{64}$/.test(evidenceHash || '')) throw new Error('Legacy scheduler cleanup evidence hash is missing.');
            const auditEvidenceHash = crypto.createHash('sha256').update(JSON.stringify({
              matcherVersion: 1, sourceDigest: imported.digest, taskName: spec.taskName, evidenceHash
            })).digest('hex');
            requireIntent('scheduler.legacy.adapter.intent', spec.taskName, {
              operation: 'delete', name: spec.name, schedule: spec.schedule, migration: 'pre-saga',
              sourceDigest: imported.digest, matcherVersion: 1, evidenceHash: auditEvidenceHash
            }, 'Durable legacy scheduler cleanup intent was not recorded.');
          }
        });
        tasks.push({ name: candidate.name, state: result.changed === true ? 'removed' : 'absent' });
      } catch (error) {
        const conflict = error instanceof SchedulerAdapterError && error.retryable === false;
        tasks.push(compact({
          name: candidate.name, state: conflict ? 'conflict' : 'unknown', code: schedulerErrorCode(error),
          reason: error && error.observation && error.observation.reason
        }));
      }
      const latest = tasks.at(-1);
      record('scheduler.legacy.cleanup.result', spec.taskName, compact({
        name: latest.name, state: latest.state, code: latest.code, reason: latest.reason,
        sourceDigest: imported.digest, matcherVersion: 1
      }));
    }
    const summary = {
      status: tasks.some(item => item.state === 'conflict' || item.state === 'unknown') ? 'attention_required' : 'complete',
      total: tasks.length,
      removed: tasks.filter(item => item.state === 'removed').length,
      absent: tasks.filter(item => item.state === 'absent').length,
      conflicts: tasks.filter(item => item.state === 'conflict').length,
      unknown: tasks.filter(item => item.state === 'unknown').length,
      tasks
    };
    record('scheduler.legacy.cleanup', imported.path || 'jobs.json', {
      total: summary.total, removed: summary.removed, absent: summary.absent,
      conflicts: summary.conflicts, unknown: summary.unknown
    });
    return summary;
  }

  function requireIntent(event, target, details, message) {
    const auditPolicy = operationAudit.capturePolicy();
    const intent = operationAudit.requireRecord(event, target, details, { audit: auditor, auditPolicy });
    if (!auditPolicy.required && operationAudit.isNotRequired(intent, event, target)) return;
    if (!intent || intent.durable !== true) throw new Error(message);
  }

  function mutationIntent(context) {
    policy.assertActive(`scheduler.${context.operation}`);
    requireIntent('scheduler.adapter.intent', context.spec.taskName, {
      operation: context.operation,
      jobId: context.jobId,
      generation: context.generation,
      outboxId: context.outboxId,
      fence: context.fence
    }, 'Durable scheduler mutation intent was not recorded.');
  }

  function processClaim(claim) {
    const store = state();
    const work = claim.work;
    const context = {
      jobId: work.registration.jobId,
      generation: work.registration.generation,
      outboxId: work.outbox.outboxId,
      fence: claim.handle.fence,
      spec: work.registration.spec
    };
    const beforeMutation = event => mutationIntent({ ...context, operation: event.operation });
    let adapterSpec = work.registration.spec;
    if (work.outbox.operation === 'delete' && !validPrincipalId(adapterSpec.principalId)
      && adapterSpec.action === undefined && adapterSpec.args === undefined && adapterSpec.desiredSpecHash === undefined) {
      // Schema-3 registrations either omitted the SID or stored an account
      // name. They are deletion-only after migration, so enrich the ephemeral
      // adapter input with the current canonical SID without changing durable
      // ownership or making the historical registration executable.
      adapterSpec = { ...adapterSpec, principalId: schedulerRuntime().principalId };
    }
    let result;
    try {
      result = work.outbox.operation === 'ensure'
        ? adapter.ensure(adapterSpec, { beforeMutation })
        : adapter.remove(adapterSpec, { beforeMutation });
    } catch (error) {
      const disposition = error instanceof SchedulerAdapterError && error.retryable === false ? 'error'
        : error instanceof SchedulerAdapterError && error.uncertain === true ? 'uncertain' : 'retry';
      const code = schedulerErrorCode(error);
      const message = boundedMessage(error, auditor.redact || audit.redact);
      try {
        const completed = store.completeSchedulerOutbox(claim.handle, {
          disposition,
          code,
          message,
          retryDelayMs: Math.min(60_000, 1000 * (2 ** Math.min(work.outbox.attempt, 6))),
          observation: error.observation && typeof error.observation === 'object'
            ? compact({ state: error.observation.state, exact: error.observation.exact, reason: error.observation.reason, commandStatus: error.observation.commandStatus }) : {}
        });
        const outcome = completed.outbox && completed.outbox.status === 'superseded' ? 'superseded' : disposition;
        return { outcome, operation: work.outbox.operation, generation: work.registration.generation, code, message, job: completed.job };
      } catch (completionError) {
        if (completionError && completionError.code === 'SCHEDULER_OUTBOX_FENCE_LOST') {
          return { outcome: 'superseded', operation: work.outbox.operation, generation: work.registration.generation, code: completionError.code };
        }
        throw completionError;
      }
    }
    // Provider mutation success and durable completion are separate phases.
    // A database failure here must propagate for inspection/recovery; treating
    // it as a provider retry would attempt to complete the same fence twice.
    let completed;
    try {
      completed = store.completeSchedulerOutbox(claim.handle, {
        disposition: 'succeeded',
        observation: compact({
          state: result.observation && result.observation.state,
          exact: result.observation && result.observation.exact,
          changed: result.changed === true,
          commandStatus: result.command && result.command.commandStatus
        })
      });
    } catch (completionError) {
      if (completionError && completionError.code === 'SCHEDULER_OUTBOX_FENCE_LOST') {
        return { outcome: 'superseded', operation: work.outbox.operation, generation: work.registration.generation, code: completionError.code };
      }
      throw completionError;
    }
    const outcome = completed.outbox && completed.outbox.status === 'superseded' ? 'superseded' : 'succeeded';
    return { outcome, operation: work.outbox.operation, generation: work.registration.generation, changed: result.changed === true, job: completed.job };
  }

  function reconcile(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('scheduler.reconcile input must be an object.');
    policy.assertActive('scheduler.reconcile');
    ensureInitialized();
    const limit = input.limit === undefined ? DEFAULT_RECONCILE_LIMIT : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer from 1 through 100.');
    const store = state();
    let jobId;
    if (input.name !== undefined) {
      const selected = store.getSchedulerJob({ name: input.name });
      if (!selected) {
        const legacyCleanup = reconcileLegacyTasks(input.name);
        return { name: input.name, found: false, processed: 0, legacyCleanup, outcomes: [] };
      }
      jobId = selected.jobId;
    }
    const legacyCleanup = reconcileLegacyTasks(input.name === undefined ? null : input.name);
    if (input.requeueErrors === true && typeof store.listSchedulerOutbox === 'function') {
      const terminal = store.listSchedulerOutbox({ jobId, statuses: ['error'], limit: 500 });
      for (const item of terminal) store.requeueSchedulerOutbox({ outboxId: item.outboxId });
    }
    const outcomes = [];
    for (let index = 0; index < limit; index += 1) {
      // A drift repair can perform query/delete/query/create/query. Keep the
      // lease longer than the adapter's bounded worst-case I/O so another
      // reconciler cannot reclaim an in-flight OS operation.
      const claim = store.claimSchedulerOutbox(compact({ jobId, leaseMs: 5 * 60_000 }));
      if (!claim.claimed) break;
      outcomes.push(processClaim(claim));
    }
    const current = jobId ? store.getSchedulerJob({ jobId }) : null;
    const summary = {
      found: input.name === undefined ? undefined : true,
      name: input.name,
      processed: outcomes.length,
      succeeded: outcomes.filter(item => item.outcome === 'succeeded').length,
      retrying: outcomes.filter(item => item.outcome === 'retry' || item.outcome === 'uncertain').length,
      errors: outcomes.filter(item => item.outcome === 'error').length,
      legacyCleanup,
      outcomes: outcomes.map(item => compact({ outcome: item.outcome, operation: item.operation, generation: item.generation, changed: item.changed, code: item.code })),
      job: publicJob(current)
    };
    record('scheduler.reconcile', input.name || '*', { processed: summary.processed, succeeded: summary.succeeded, retrying: summary.retrying, errors: summary.errors });
    return compact(summary);
  }

  function list(input = {}) {
    const options = input && typeof input === 'object' ? input : {};
    ensureInitialized();
    return state().listSchedulerJobs({
      includeRemoved: options.includeRemoved === true,
      limit: options.limit === undefined ? 100 : options.limit
    }).map(publicJob);
  }

  function create(input) {
    policy.assertActive('scheduler.create');
    const normalized = normalizeCreateInput(input);
    validateAction(normalized.action, normalized.args);
    ensureInitialized();
    const desired = state().putSchedulerJob({ ...normalized, runtime: schedulerRuntime(), maxScheduledJobs: maxScheduledJobs() });
    const reconciled = reconcile({ name: desired.job.name, limit: DEFAULT_RECONCILE_LIMIT });
    const job = state().getSchedulerJob({ jobId: desired.job.jobId });
    record('scheduler.create', desired.job.name, {
      jobId: desired.job.jobId, generation: desired.job.generation, replayed: desired.replayed === true,
      providerState: job.providerState, processed: reconciled.processed
    });
    return { replayed: desired.replayed === true, job: publicJob(job), reconciliation: reconciled };
  }

  function remove(input) {
    policy.assertActive('scheduler.remove');
    ensureInitialized();
    const removed = state().removeSchedulerJob(input);
    if (!removed.job) {
      record('scheduler.remove', input.name, { removed: false });
      return { removed: false, replayed: true, job: null, reconciliation: { processed: 0, outcomes: [] } };
    }
    const reconciled = reconcile({ name: removed.job.name, limit: DEFAULT_RECONCILE_LIMIT });
    const job = state().getSchedulerJob({ jobId: removed.job.jobId });
    record('scheduler.remove', removed.job.name, {
      jobId: removed.job.jobId, removed: true, replayed: removed.replayed === true,
      providerState: job.providerState, processed: reconciled.processed
    });
    return { removed: true, replayed: removed.replayed === true, job: publicJob(job), reconciliation: reconciled };
  }

  return { create, list, reconcile, remove };
}

const provider = createSchedulerProvider();

module.exports = { ...provider, createSchedulerProvider, publicJob };
