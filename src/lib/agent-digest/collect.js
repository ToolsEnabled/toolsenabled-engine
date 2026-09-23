'use strict';

// WHAT the agentic-workflow digest reports.
//
// This module is a reader, not a second source of truth. Every observed number
// comes from `src/lib/controller-projection.js` -- the canonical producer of
// agents, tasks, meters, and provenance -- fed the same inputs the durable-run
// sidecar feeds it. There is deliberately no parallel data path.
//
// Two honesty rules are structural here, not stylistic:
//
//   1. DECLARED vs OBSERVED are never merged. `declared` is owner-authored
//      intent from config/agent-org.json and grants no authority; `observed`
//      is derived from the signed audit ledger. A role someone declared and a
//      role someone was seen performing are different facts.
//   2. No token or cost number is ever invented. When the projection reports
//      `tokenMeterState`/`costMeterState` as unavailable, or
//      `source.metersUnavailableReason` explains why, the digest carries that
//      state through verbatim. A digest that prints a plausible number is
//      worse than a digest that prints "not recorded".
//
// Every source is read defensively and independently: one unreadable source
// degrades to a named entry in `gaps` and the rest of the digest still sends.

const nodeFs = require('node:fs');
const { rootPath } = require('../runtime');
const { buildControllerProjection, durableRunOutcomes } = require('../controller-projection');
const { readQueueCorpus } = require('../build-queue-corpus');

const AUDIT_TAIL_LIMIT = 200;
const QUEUE_STATUSES = Object.freeze(['OPEN', 'IN-PROGRESS', 'DONE', 'BLOCKED', 'PARTIAL']);
const PHASE_HEADING = /^##\s+([A-Z]+\d+)\s*[—\-–]\s*(.+?)\s*$/;
const STATUS_LINE = /^\*\*Status:\*\*\s*([A-Z-]+)\b(.*)$/;
const COMPLETED_HEADING = /^##\s+Completed\b/i;
const COMPLETED_PHASE = /^-\s+\*\*([A-Z]+\d+)(?:\s*\([^)]*\))?:\*\*\s+DONE\b/;
// A run whose last update is older than this is called out as stale rather
// than silently counted as in-flight.
const STALE_RUN_MS = 6 * 60 * 60 * 1000;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeCode(error) {
  if (!error) return 'unknown';
  if (typeof error.code === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.code)) return error.code;
  return error.name === 'Error' || !error.name ? 'error' : String(error.name).slice(0, 40);
}

// ---------------------------------------------------------------------------
// Declared intent (config/agent-org.json). Owner-authored; grants no authority.
// ---------------------------------------------------------------------------
function readDeclaredOrg(file, fs) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
  return {
    source: 'config/agent-org.json',
    trust: 'declared-owner-intent',
    revision: Number.isSafeInteger(parsed.revision) ? parsed.revision : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    agents: agents.filter(isObject).map(agent => ({
      id: String(agent.id || 'unknown'),
      displayName: typeof agent.displayName === 'string' ? agent.displayName : String(agent.id || 'unknown'),
      role: typeof agent.role === 'string' ? agent.role : 'unspecified',
      provider: typeof agent.provider === 'string' ? agent.provider : 'unspecified',
      enabled: agent.enabled === true,
      assignedPhase: typeof agent.assignedPhase === 'string' ? agent.assignedPhase : null
    })),
    relationships: (Array.isArray(parsed.relationships) ? parsed.relationships : [])
      .filter(isObject)
      .map(edge => ({ from: String(edge.from || ''), to: String(edge.to || ''), type: String(edge.type || '') }))
  };
}

// ---------------------------------------------------------------------------
// The indexed queue corpus. BUILD-QUEUE.md carries protocol/index/cross-package
// work; package slices carry their own phase bodies.
// ---------------------------------------------------------------------------
function readQueue(file, fs) {
  const corpus = readQueueCorpus(file, { fsImpl: fs });
  const lines = corpus.text.split(/\r?\n/);
  const phases = [];
  const completedIds = [];
  let inCompletedSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = PHASE_HEADING.exec(lines[index]);
    if (heading) inCompletedSection = false;
    if (COMPLETED_HEADING.test(lines[index])) {
      inCompletedSection = true;
      continue;
    }
    if (inCompletedSection) {
      const completed = COMPLETED_PHASE.exec(lines[index]);
      if (completed) completedIds.push(completed[1]);
      continue;
    }
    if (!heading) continue;
    // The Status line follows its heading closely; a bounded lookahead keeps a
    // prose paragraph elsewhere in the file from being adopted as a status.
    let status = null;
    let detail = '';
    for (let ahead = index + 1; ahead < Math.min(lines.length, index + 6); ahead += 1) {
      if (PHASE_HEADING.test(lines[ahead])) break;
      const match = STATUS_LINE.exec(lines[ahead]);
      if (match) {
        status = QUEUE_STATUSES.includes(match[1]) ? match[1] : 'UNRECOGNIZED';
        detail = match[2].trim().replace(/^\(/, '').slice(0, 240);
        break;
      }
    }
    if (status) phases.push({ id: heading[1], title: heading[2].slice(0, 120), status, detail });
  }
  const counts = Object.fromEntries([...QUEUE_STATUSES, 'UNRECOGNIZED'].map(key => [key, 0]));
  for (const phase of phases) counts[phase.status] += 1;
  const remaining = phases.filter(phase => phase.status !== 'DONE');
  return {
    source: 'BUILD-QUEUE.md',
    files: corpus.files,
    corpusHash: corpus.sha256,
    trust: 'declared-owner-intent',
    phases,
    // Bodies are deliberately deleted when work is done. Keep these compact
    // completion receipts separate from the live queue so a digest can say
    // "DONE" instead of falsely implying a phase vanished or died.
    completedIds: [...new Set(completedIds)].sort(),
    counts,
    depth: remaining.length,
    inFlight: phases.filter(phase => phase.status === 'IN-PROGRESS' || phase.status === 'PARTIAL').map(phase => phase.id),
    blocked: phases.filter(phase => phase.status === 'BLOCKED').map(phase => phase.id),
    open: phases.filter(phase => phase.status === 'OPEN').map(phase => phase.id)
  };
}

// ---------------------------------------------------------------------------
// Observed state, exclusively via the controller projection.
// ---------------------------------------------------------------------------
function readAudit(auditModule, auditDependencies) {
  let status = auditModule.status(auditDependencies);
  let verification = auditModule.verify(auditDependencies);
  // A durable event can briefly outrun its rebuildable projections. Reconcile
  // that bounded writer race once before reporting an invalid ledger; a
  // persistently invalid ledger still stays fail-closed.
  if (!verification.valid && ['projection-divergence', 'projection-malformed', 'emergency-backlog'].includes(verification.reason)) {
    try {
      auditModule.flush({ force: true }, auditDependencies);
      status = auditModule.status(auditDependencies);
      verification = auditModule.verify(auditDependencies);
    } catch { /* the original verification remains the safe result */ }
  }
  const events = verification.valid ? auditModule.tail(AUDIT_TAIL_LIMIT, auditDependencies) : [];
  return {
    status: {
      headSequence: Number.isSafeInteger(status.headSequence) ? status.headSequence : 0,
      headHash: typeof status.headHash === 'string' ? status.headHash : null,
      headKeyId: typeof status.headKeyId === 'string' ? status.headKeyId : null
    },
    verification,
    events
  };
}

function summarizeRuns(runs, nowMs) {
  if (!Array.isArray(runs)) {
    return {
      available: false,
      total: null,
      active: null,
      byStatus: null,
      openHelp: null,
      outcomes: null,
      stale: null
    };
  }
  const rows = runs.filter(isObject);
  const byStatus = {};
  const stale = [];
  let openHelp = 0;
  for (const run of rows.filter(isObject)) {
    const status = typeof run.status === 'string' ? run.status : 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    openHelp += Number.isSafeInteger(run.help && run.help.open) ? run.help.open : 0;
    const updatedAtMs = Number.isSafeInteger(run.updatedAtMs) ? run.updatedAtMs
      : typeof run.updatedAt === 'string' ? Date.parse(run.updatedAt) : Number.NaN;
    // `uncertain` is terminal in the durable task store.  It is either a
    // deliberate bounded HELP_REQUIRED handoff or a genuinely unobserved
    // outcome after expiry; neither is active work or a stale worker.
    const active = ['queued', 'leased', 'running', 'retry_wait'].includes(status);
    if (active && Number.isSafeInteger(updatedAtMs) && nowMs - updatedAtMs > STALE_RUN_MS) {
      stale.push({ runId: typeof run.runId === 'string' ? run.runId : 'unknown', status, ageMs: nowMs - updatedAtMs });
    }
  }
  const active = ['queued', 'leased', 'running', 'retry_wait']
    .reduce((sum, status) => sum + (byStatus[status] || 0), 0);
  return {
    available: true,
    total: rows.length,
    active,
    byStatus,
    openHelp,
    outcomes: durableRunOutcomes(rows),
    stale: stale.slice(0, 10)
  };
}

async function collectDigestState({
  nowMs = Date.now(),
  auditModule = require('../audit'),
  auditDependencies = {},
  runControl = null,
  providerGateway = null,
  orgFile = rootPath('config', 'agent-org.json'),
  buildQueueFile = rootPath('BUILD-QUEUE.md'),
  previous = null,
  fs = nodeFs
} = {}) {
  const gaps = [];
  const note = (source, reason) => gaps.push({ source, reason });

  let auditData = null;
  try {
    auditData = readAudit(auditModule, auditDependencies);
  } catch (error) {
    note('signed-audit-ledger', `unreadable (${safeCode(error)})`);
  }

  let runs = null;
  let lifecycle = null;
  if (runControl) {
    try {
      const listedRuns = runControl.list({ limit: 100 });
      if (!Array.isArray(listedRuns)) throw Object.assign(new TypeError('durable run list is not an array'), { code: 'INVALID_RUN_LIST' });
      runs = listedRuns;
    }
    catch (error) { note('durable-runs', `unreadable (${safeCode(error)})`); }
    try {
      const lifecycleStatus = runControl.lifecycleStatus();
      if (!isObject(lifecycleStatus)) throw Object.assign(new TypeError('worker lifecycle status is not an object'), { code: 'INVALID_LIFECYCLE_STATUS' });
      lifecycle = lifecycleStatus;
    }
    catch (error) { note('durable-lifecycle', `unreadable (${safeCode(error)})`); }
  } else {
    note('durable-runs', 'no durable-run control adapter configured for this digest process');
  }

  let providerCache = null;
  if (providerGateway) {
    try {
      const cachedStatus = await providerGateway.cachedStatus();
      if (!isObject(cachedStatus) || !Array.isArray(cachedStatus.providers)) {
        throw Object.assign(new TypeError('provider control status has no provider list'), { code: 'INVALID_PROVIDER_STATUS' });
      }
      providerCache = cachedStatus;
    }
    catch (error) { note('provider-controls', `unreadable (${safeCode(error)})`); }
  } else {
    note('provider-controls', 'no provider gateway configured for this digest process');
  }
  const defaultGoogleAlias = (providerCache ? providerCache.providers : [])
    .find(provider => isObject(provider) && provider.id === 'gemini')?.configuredAccountAlias;

  const projection = buildControllerProjection({
    nowMs,
    auditEvents: auditData && auditData.verification.valid && Array.isArray(auditData.events) ? auditData.events : [],
    auditVerification: auditData
      ? {
        ...auditData.verification,
        headSequence: auditData.status.headSequence,
        headHash: auditData.verification.headHash || auditData.status.headHash,
        headKeyId: auditData.verification.headKeyId || auditData.status.headKeyId
      }
      : { valid: false, entries: 0, reason: 'audit-unavailable' },
    runs: runs || [],
    lifecycle: lifecycle || {},
    providerCache: providerCache || {},
    defaultGoogleAlias
  });

  let declared = null;
  try { declared = readDeclaredOrg(orgFile, fs); }
  catch (error) { note('declared-agent-org', `unreadable (${safeCode(error)})`); }

  let queue = null;
  try { queue = readQueue(buildQueueFile, fs); }
  catch (error) { note('build-queue', `unreadable (${safeCode(error)})`); }

  const observed = {
    trust: 'observed-from-signed-audit-ledger',
    auditState: projection.source.audit,
    provenance: projection.source.provenance,
    freshness: projection.source.freshness,
    eventsInWindow: projection.snapshot.safeDisplay.sourceCount,
    agents: projection.snapshot.agents,
    phases: projection.snapshot.phases,
    goals: projection.snapshot.goals,
    lifecycle: lifecycle ? projection.controls.lifecycle : null,
    providerControls: providerCache ? projection.controls.providers : null,
    runs: summarizeRuns(runs, nowMs),
    meters: {
      state: projection.source.meters,
      unavailableReason: projection.source.metersUnavailableReason,
      skippedCount: projection.source.metersSkippedCount,
      subscriptionUsage: projection.source.subscriptionUsage,
      savingsState: projection.source.savings,
      providers: projection.metrics.providerMeters,
      waste: projection.metrics.waste
    }
  };

  const state = {
    schemaVersion: 'agent-digest-state-v1',
    observedAtMs: nowMs,
    observedAt: new Date(nowMs).toISOString(),
    declared,
    observed,
    queue,
    gaps,
    contentTrust: 'untrusted',
    grantsAuthority: false
  };
  state.delta = computeDelta(state, previous);
  return state;
}

// The compact record persisted after each send so the NEXT digest can honestly
// say what moved. It is deliberately small, value-free, and JSON-safe.
function digestFingerprint(state) {
  return {
    schemaVersion: 'agent-digest-fingerprint-v1',
    observedAtMs: state.observedAtMs,
    headSequence: state.observed?.provenance?.headSequence ?? 0,
    queueDepth: state.queue ? state.queue.depth : null,
    phaseStatuses: state.queue
      ? Object.fromEntries(state.queue.phases.map(phase => [phase.id, phase.status]))
      : null,
    activeRuns: state.observed?.runs?.active ?? null,
    agentStates: Object.fromEntries((state.observed?.agents || []).map(agent => [agent.alias, agent.state]))
  };
}

function computeDelta(state, previous) {
  if (!isObject(previous) || previous.schemaVersion !== 'agent-digest-fingerprint-v1') {
    return { available: false, reason: 'no-previous-digest-recorded' };
  }
  const movedPhases = [];
  if (state.queue && isObject(previous.phaseStatuses)) {
    const before = previous.phaseStatuses;
    const after = Object.fromEntries(state.queue.phases.map(phase => [phase.id, phase.status]));
    for (const [id, status] of Object.entries(after)) {
      if (before[id] === undefined) movedPhases.push({ id, from: 'absent', to: status });
      else if (before[id] !== status) movedPhases.push({ id, from: before[id], to: status });
    }
    const completedNow = new Set(Array.isArray(state.queue.completedIds) ? state.queue.completedIds : []);
    for (const id of Object.keys(before)) {
      if (after[id] === undefined) {
        movedPhases.push({ id, from: before[id], to: completedNow.has(id) ? 'DONE' : 'removed' });
      }
    }
  }
  const agentChanges = [];
  if (isObject(previous.agentStates)) {
    for (const agent of state.observed?.agents || []) {
      const before = previous.agentStates[agent.alias];
      if (before !== undefined && before !== agent.state) agentChanges.push({ alias: agent.alias, from: before, to: agent.state });
    }
  }
  const headSequence = state.observed?.provenance?.headSequence ?? 0;
  return {
    available: true,
    sinceMs: previous.observedAtMs ?? null,
    since: Number.isSafeInteger(previous.observedAtMs) ? new Date(previous.observedAtMs).toISOString() : null,
    auditEventsSince: Number.isSafeInteger(previous.headSequence) && headSequence >= previous.headSequence
      ? headSequence - previous.headSequence
      : null,
    queueDepthBefore: previous.queueDepth ?? null,
    queueDepthAfter: state.queue ? state.queue.depth : null,
    movedPhases,
    agentChanges,
    activeRunsBefore: previous.activeRuns ?? null,
    activeRunsAfter: state.observed?.runs?.active ?? null
  };
}

// The always-available fallback read. It touches only cheap, independent
// sources and never the rich projection path, so it can still produce a
// truthful message when rich generation failed or timed out.
function collectFallbackState({
  nowMs = Date.now(),
  auditModule = require('../audit'),
  auditDependencies = {},
  orgFile = rootPath('config', 'agent-org.json'),
  buildQueueFile = rootPath('BUILD-QUEUE.md'),
  reason = null,
  fs = nodeFs
} = {}) {
  const gaps = [];
  let auditStatus = null;
  try {
    const status = auditModule.status(auditDependencies);
    auditStatus = { headSequence: Number.isSafeInteger(status.headSequence) ? status.headSequence : 0, disabled: status.disabled === true };
  } catch (error) {
    gaps.push({ source: 'signed-audit-ledger', reason: `unreadable (${safeCode(error)})` });
  }
  let declared = null;
  try { declared = readDeclaredOrg(orgFile, fs); }
  catch (error) { gaps.push({ source: 'declared-agent-org', reason: `unreadable (${safeCode(error)})` }); }
  let queue = null;
  try { queue = readQueue(buildQueueFile, fs); }
  catch (error) { gaps.push({ source: 'build-queue', reason: `unreadable (${safeCode(error)})` }); }
  return {
    schemaVersion: 'agent-digest-fallback-v1',
    observedAtMs: nowMs,
    observedAt: new Date(nowMs).toISOString(),
    degradedReason: reason,
    auditStatus,
    declared,
    queue,
    gaps,
    contentTrust: 'untrusted',
    grantsAuthority: false
  };
}

module.exports = {
  AUDIT_TAIL_LIMIT, STALE_RUN_MS,
  collectDigestState, collectFallbackState, computeDelta, digestFingerprint, readQueue, readDeclaredOrg, summarizeRuns
};
