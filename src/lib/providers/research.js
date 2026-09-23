'use strict';

// The research control plane. Every write the app or an agent can make to the
// research domain passes through here: input validation, the settings gate,
// the sensitive-content fence and the durable audit intent, in that order.
// It deliberately rides the shared fenced task store the way the overnight
// advisory control does: this module never runs a job itself — the reserved
// research-runs queue and its worker do — and task text carries no authority.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const audit = require('../audit');
const { getStateStore } = require('../state-store');
const { containsSensitiveMaterial } = require('./sensitive-local-input');
const settingsGate = require('../research/settings-gate');

const QUEUE = 'research-runs';
const TYPE = 'research-run';
const LIFECYCLE_OPERATION = 'research.lifecycle';
const LIFECYCLE_LEASE_MS = 60_000;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const ACTORS = Object.freeze(['human', 'codex', 'claude', 'gemini', 'grok', 'local']);
const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

// What the fence refuses in configs, params and free text. The base guard
// (sensitive-local-input) catches key blocks, `password=`/`api_key:` style
// assignments and vault/profile paths through its obfuscation-normalizing
// pass; the shapes below add recognizable bearer tokens and issued-key
// formats. The overnight queue's broader net (bare 13-19 digit runs, bare
// e-mail addresses, the bare words vault/profile) is deliberately NOT copied:
// research params routinely carry millisecond timestamps and seeds, configs
// carry URLs and field names like envProfile, and a fence that refuses those
// teaches config authors to obfuscate — which defeats the normalizing guard
// that actually works.
const TOKEN_SHAPES = /(?:\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{12,}|\b(?:sk_(?:live|test|prod)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b|\b\d{3}-\d{2}-\d{4}\b)/;

class ResearchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ResearchError';
    this.code = code;
    this.details = details;
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new ResearchError('RESEARCH_INPUT_INVALID', `${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unsupported = Object.keys(value).filter(key => !allowed.includes(key));
  if (unsupported.length) {
    throw new ResearchError('RESEARCH_INPUT_INVALID', `${label} contains unsupported field(s): ${unsupported.join(', ')}.`);
  }
}

function containsProhibitedMaterial(value) {
  return typeof value === 'string' && (containsSensitiveMaterial(value) || TOKEN_SHAPES.test(value));
}

function safeText(value, label, { min = 1, max = 1000, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    throw new ResearchError('RESEARCH_INPUT_INVALID', `${label} must be a string from ${min} through ${max} characters.`);
  }
  if (containsProhibitedMaterial(value)) {
    throw new ResearchError('RESEARCH_SENSITIVE_CONTENT', `${label} appears to contain credential or private-vault material.`);
  }
  return value;
}

function fencedJsonValue(value, label) {
  const serialized = JSON.stringify(value);
  if (typeof serialized === 'string' && containsProhibitedMaterial(serialized)) {
    throw new ResearchError('RESEARCH_SENSITIVE_CONTENT', `${label} appears to contain credential or private-vault material.`);
  }
  return value;
}

function actor(value) {
  const normalized = safeText(value, 'actor', { min: 3, max: 16, pattern: /^[a-z]+$/ });
  if (!ACTORS.includes(normalized)) {
    throw new ResearchError('RESEARCH_INPUT_INVALID', `actor must be one of: ${ACTORS.join(', ')}.`);
  }
  return normalized;
}

function idempotencyKey(value) {
  return safeText(value, 'idempotencyKey', { min: 8, max: 160, pattern: SAFE_KEY });
}

function researchId(value, label) {
  return safeText(value, label, { min: 3, max: 39, pattern: /^[a-z]{1,4}-[0-9a-f]{4,36}$/ });
}

function lifecycleResponse(action, response, replayed = false) {
  if (typeof response.accepted !== 'boolean' || typeof response.running !== 'boolean') {
    throw new ResearchError('RESEARCH_RUNTIME_INVALID', 'The local lifecycle adapter returned an incomplete response.');
  }
  return compact({
    action,
    accepted: response.accepted,
    status: String(response.status || 'unknown').slice(0, 80),
    running: response.running,
    detail: response.detail === undefined ? undefined : String(response.detail).slice(0, 500),
    replayed
  });
}

class ResearchControl {
  constructor(dependencies = {}) {
    this._state = dependencies.state || null;
    this._stateFactory = dependencies.stateFactory || getStateStore;
    this.runtime = dependencies.runtime || null;
    // Injectable for tests; the default reads the live settings files through
    // the one module allowed to decide research enablement.
    this.gate = dependencies.gate || (() => settingsGate.loadGate());
    this.auditRequire = dependencies.auditRequire || audit.requireRecord;
  }

  get state() { return this._state || (this._state = this._stateFactory()); }

  _audit(action, target, details) {
    const intent = this.auditRequire(action, target, details);
    if (!intent || intent.durable !== true) {
      throw new ResearchError('RESEARCH_AUDIT_REQUIRED', 'The research control action was not started because its audit intent was not durably recorded.');
    }
    return intent;
  }

  _assertPipelineEnabled() {
    const decided = this.gate();
    if (decided.pipelineWithheld) {
      throw new ResearchError('RESEARCH_PIPELINE_DISABLED', decided.pipeline.why || 'The research pipeline is off.');
    }
    return decided;
  }

  // ---- reads (no gate: seeing state is not running work) -------------------

  snapshot() {
    const projects = this.state.listResearchProjects({});
    const experiments = {};
    for (const project of projects) {
      experiments[project.projectId] = this.state.listResearchExperiments({ projectId: project.projectId });
    }
    const decided = this.gate();
    return {
      projects,
      experiments,
      assignments: this.state.listResearchSessionAssignments({}),
      settings: {
        pipelineEnabled: !decided.pipelineWithheld,
        pipelineWhy: decided.pipeline.why,
        runnerKinds: Object.fromEntries(Object.entries(decided.runners)
          .map(([kind, entry]) => [kind, { enabled: entry.state === 'enabled', why: entry.why }]))
      },
      lifecycle: this.lifecycleStatus(),
      ...UNTRUSTED_CONTENT
    };
  }

  runs(value = {}) {
    const source = plainObject(value, 'research runs query');
    exactKeys(source, ['experimentId', 'runId', 'limit', 'cursor'], 'research runs query');
    if (source.cursor !== undefined && source.runId !== undefined) throw new ResearchError('RESEARCH_INPUT_INVALID', 'A run cursor belongs to an experiment list, not a single-run query.');
    const query = compact({
      experimentId: source.experimentId === undefined ? undefined : researchId(source.experimentId, 'experimentId'),
      runId: source.runId === undefined ? undefined : researchId(source.runId, 'runId'),
      limit: source.limit, cursor: source.cursor
    });
    const page = source.runId === undefined ? this.state.listResearchRunsPage(query) : null;
    const runs = page ? page.runs : this.state.listResearchRuns(query);
    // The drill-in read: a single-run query also lists what the run left in
    // its artifact folder — names and sizes only, bounded, never file content.
    // A folder that cannot be read says so instead of reading as empty.
    if (source.runId !== undefined) {
      for (const run of runs) {
        if (!run.artifactDir) { run.artifacts = []; continue; }
        try {
          const entries = fs.readdirSync(run.artifactDir, { withFileTypes: true }).filter(entry => entry.isFile());
          run.artifactsTruncated = entries.length > 50;
          run.artifacts = entries.slice(0, 50).map(entry => {
            let bytes = null;
            let bytesError;
            try {
              bytes = fs.statSync(path.join(run.artifactDir, entry.name)).size;
            } catch (error) {
              // ENOENT is the one definite answer: the file disappeared after
              // readdir named it. Every other failure means stat could not
              // answer, not that the artifact is absent or has no size.
              if (!error || error.code !== 'ENOENT') {
                bytesError = {
                  code: 'RESEARCH_ARTIFACT_STAT_UNAVAILABLE',
                  message: 'The artifact size could not be read; this is not claiming that the artifact is absent.'
                };
              }
            }
            return compact({ name: entry.name, bytes, bytesError });
          });
        } catch {
          run.artifacts = null;
          run.artifactsNote = 'The artifact folder could not be read from here.';
        }
      }
    }
    return { runs, ...(page ? { pagination: page.pagination } : {}), ...UNTRUSTED_CONTENT };
  }

  results(value) {
    const source = plainObject(value, 'research results query');
    exactKeys(source, ['runId', 'limit'], 'research results query');
    return {
      results: this.state.listResearchResults(compact({
        runId: researchId(source.runId, 'runId'),
        limit: source.limit
      })),
      ...UNTRUSTED_CONTENT
    };
  }

  findings(value) {
    const source = plainObject(value, 'research findings query');
    exactKeys(source, ['projectId', 'status'], 'research findings query');
    return {
      findings: this.state.listResearchFindings(compact({
        projectId: researchId(source.projectId, 'projectId'),
        status: source.status
      })),
      ...UNTRUSTED_CONTENT
    };
  }

  sessionContext(value) {
    const source = plainObject(value, 'session context query');
    exactKeys(source, ['refs'], 'session context query');
    return {
      projects: this.state.resolveSessionResearchProjects({ refs: source.refs }),
      ...UNTRUSTED_CONTENT
    };
  }

  // ---- writes --------------------------------------------------------------

  projectSave(value) {
    const source = plainObject(value, 'research project save');
    exactKeys(source, ['actor', 'projectId', 'name', 'description', 'enabled', 'status'], 'research project save');
    const who = actor(source.actor);
    if (source.enabled !== undefined && typeof source.enabled !== 'boolean') {
      throw new ResearchError('RESEARCH_INPUT_INVALID', 'enabled must be a boolean.', { field: 'enabled' });
    }
    if (source.name !== undefined) safeText(source.name, 'name', { min: 1, max: 120 });
    if (source.description !== undefined && source.description !== '') safeText(source.description, 'description', { min: 1, max: 2000 });
    this._audit('research.project_save', source.projectId || 'new-project', {
      actor: who, update: source.projectId !== undefined
    });
    const project = source.projectId === undefined
      ? this.state.createResearchProject(compact({ name: source.name, description: source.description, enabled: source.enabled }))
      : this.state.updateResearchProject(compact({
        projectId: researchId(source.projectId, 'projectId'),
        name: source.name, description: source.description, enabled: source.enabled, status: source.status
      }));
    return { project, ...UNTRUSTED_CONTENT };
  }

  experimentSave(value) {
    const source = plainObject(value, 'research experiment save');
    exactKeys(source, ['actor', 'experimentId', 'projectId', 'name', 'runnerKind', 'runnerConfig',
      'resultSchema', 'collector', 'maxParallel', 'mutexKey', 'timeoutMs', 'status'], 'research experiment save');
    const who = actor(source.actor);
    if (source.name !== undefined) safeText(source.name, 'name', { min: 1, max: 120 });
    if (source.experimentId !== undefined) {
      // Update path: the store refuses config mutation; only name/status/
      // maxParallel can change.
      this._audit('research.experiment_save', source.experimentId, { actor: who, update: true });
      const experiment = this.state.updateResearchExperiment(compact({
        experimentId: researchId(source.experimentId, 'experimentId'),
        name: source.name, status: source.status, maxParallel: source.maxParallel,
        runnerKind: source.runnerKind, runnerConfig: source.runnerConfig,
        resultSchema: source.resultSchema, collector: source.collector,
        mutexKey: source.mutexKey, timeoutMs: source.timeoutMs
      }));
      return { disposition: 'updated', experiment, ...UNTRUSTED_CONTENT };
    }
    fencedJsonValue(source.runnerConfig, 'runnerConfig');
    this._audit('research.experiment_save', source.projectId || 'new-experiment', { actor: who, update: false });
    const created = this.state.createResearchExperiment(compact({
      projectId: researchId(source.projectId, 'projectId'),
      name: source.name, runnerKind: source.runnerKind, runnerConfig: source.runnerConfig,
      resultSchema: source.resultSchema, collector: source.collector,
      maxParallel: source.maxParallel, mutexKey: source.mutexKey, timeoutMs: source.timeoutMs
    }));
    return { disposition: created.disposition, experiment: created.experiment, ...UNTRUSTED_CONTENT };
  }

  runSubmit(value) {
    const source = plainObject(value, 'research run submission');
    exactKeys(source, ['actor', 'experimentId', 'experiment', 'params', 'priority', 'maxAttempts',
      'availableAtMs', 'sessionRefKind', 'sessionRef'], 'research run submission');
    const who = actor(source.actor);
    const decided = this._assertPipelineEnabled();
    const admit = (experiment, project) => {
      const runnerDecision = decided.runners[experiment.runnerKind];
      if (!runnerDecision || runnerDecision.state !== 'enabled') {
        throw new ResearchError('RESEARCH_RUNNER_DISABLED',
          runnerDecision ? runnerDecision.why : `No control exists for runner kind "${experiment.runnerKind}", so it is withheld.`);
      }
      if (!project || project.status !== 'active' || project.enabled !== true) {
        throw new ResearchError('RESEARCH_PROJECT_DISABLED',
          'The experiment\'s project is disabled or archived; enable it before submitting runs.', { projectId: experiment.projectId });
      }
      fencedJsonValue(source.params, 'params');
      this._audit('research.run_submit', experiment.experimentId, {
        actor: who, runnerKind: experiment.runnerKind,
        paramsHash: crypto.createHash('sha256').update(JSON.stringify(source.params)).digest('hex').slice(0, 32)
      });
    };
    const run = compact({
      params: source.params,
      priority: source.priority, maxAttempts: source.maxAttempts, availableAtMs: source.availableAtMs,
      sessionRefKind: source.sessionRefKind, sessionRef: source.sessionRef
    });
    if (source.experimentId === undefined) {
      // Registration and queue submission commit together. Admission/audit
      // runs before the first insert; any later refusal rolls both back.
      const spec = plainObject(source.experiment, 'experiment');
      fencedJsonValue(spec.runnerConfig, 'experiment.runnerConfig');
      const submitted = this.state.registerAndSubmitResearchRun({ ...run, experiment: spec }, admit);
      return { ...submitted, ...UNTRUSTED_CONTENT };
    }
    const experiment = this.state.getResearchExperiment({ experimentId: researchId(source.experimentId, 'experimentId') });
    if (!experiment) throw new ResearchError('RESEARCH_EXPERIMENT_NOT_FOUND', 'No research experiment has that id.', { experimentId: source.experimentId });
    admit(experiment, this.state.getResearchProject({ projectId: experiment.projectId }));
    const submitted = this.state.submitResearchRun({ ...run, experimentId: experiment.experimentId });
    return { disposition: submitted.disposition, run: submitted.run, experiment, ...UNTRUSTED_CONTENT };
  }

  sessionAssign(value) {
    const source = plainObject(value, 'research session assignment');
    exactKeys(source, ['actor', 'projectId', 'assign', 'unassign'], 'research session assignment');
    const who = actor(source.actor);
    const projectId = researchId(source.projectId, 'projectId');
    const assign = source.assign === undefined ? [] : source.assign;
    const unassign = source.unassign === undefined ? [] : source.unassign;
    if (!Array.isArray(assign) || !Array.isArray(unassign) || (assign.length === 0 && unassign.length === 0)) {
      throw new ResearchError('RESEARCH_INPUT_INVALID', 'assign and unassign must be arrays, and at least one entry is required.');
    }
    this._audit('research.session_assign', projectId, {
      actor: who, assignCount: assign.length, unassignCount: unassign.length
    });
    const assigned = assign.length
      ? this.state.assignResearchSessions({ projectId, assignedBy: who, sessions: assign }).assignments
      : [];
    const unassigned = unassign.map(entry => {
      const record = plainObject(entry, 'unassign entry');
      return this.state.unassignResearchSession(compact({
        projectId, assignmentId: record.assignmentId, kind: record.kind, ref: record.ref
      }));
    });
    return { projectId, assigned, unassigned, ...UNTRUSTED_CONTENT };
  }

  findingSave(value) {
    const source = plainObject(value, 'research finding save');
    exactKeys(source, ['actor', 'findingId', 'projectId', 'claim', 'status', 'evidence',
      'method', 'confidence', 'falsifier', 'dissents', 'supersedes'], 'research finding save');
    const who = actor(source.actor);
    safeText(source.claim, 'claim', { min: 1, max: 500 });
    if (source.evidence !== undefined && source.evidence !== null) fencedJsonValue(source.evidence, 'evidence');
    this._audit('research.finding_save', source.projectId, {
      actor: who, update: source.findingId !== undefined, status: source.status || 'open'
    });
    const findingId = this.state.saveResearchFinding(compact({
      findingId: source.findingId, projectId: researchId(source.projectId, 'projectId'),
      claim: source.claim, status: source.status, evidence: source.evidence, method: source.method,
      confidence: source.confidence, falsifier: source.falsifier, dissents: source.dissents,
      supersedes: source.supersedes
    }));
    return { findingId, ...UNTRUSTED_CONTENT };
  }

  // ---- worker lifecycle (owned native launch/stop acknowledgements) -------

  lifecycleStatus() {
    if (!this.runtime || typeof this.runtime.status !== 'function') return { available: false, status: 'unconfigured', running: null };
    const status = this.runtime.status();
    if (!status || typeof status !== 'object' || Array.isArray(status)
        || !(typeof status.running === 'boolean' || (status.running === null && status.status === 'unknown'))) {
      throw new ResearchError('RESEARCH_RUNTIME_INVALID', 'The local lifecycle adapter returned an incomplete status.');
    }
    return compact({ available: true, status: String(status.status || 'unknown').slice(0, 80), running: status.running, detail: status.detail === undefined ? undefined : String(status.detail).slice(0, 500) });
  }

  async lifecycle(value) {
    const source = plainObject(value, 'research lifecycle request');
    exactKeys(source, ['actor', 'action', 'idempotencyKey'], 'research lifecycle request');
    const who = actor(source.actor);
    const action = safeText(source.action, 'action', { min: 4, max: 5, pattern: /^(start|stop)$/ });
    const key = idempotencyKey(source.idempotencyKey);
    if (!this.runtime || typeof this.runtime[action] !== 'function') {
      throw new ResearchError('RESEARCH_RUNTIME_UNAVAILABLE', 'Research worker lifecycle control is not configured on this host.');
    }
    if (action === 'start') this._assertPipelineEnabled();
    this._audit(`research.lifecycle.${action}`, 'research-runs-worker', {
      actor: who, idempotencyKeyHash: crypto.createHash('sha256').update(key).digest('hex')
    });
    const reservation = this.state.reserveOperation({
      type: LIFECYCLE_OPERATION,
      key,
      inputHash: crypto.createHash('sha256').update(JSON.stringify({ action, actor: who })).digest('hex'),
      ownerId: 'research-lifecycle-' + process.pid,
      leaseMs: LIFECYCLE_LEASE_MS
    });
    if (reservation.disposition === 'replay') {
      const replay = reservation.result;
      if (!replay || typeof replay !== 'object' || Array.isArray(replay) || replay.action !== action) {
        throw new ResearchError('RESEARCH_LIFECYCLE_REPLAY_INVALID', 'The stored lifecycle replay is invalid.');
      }
      return lifecycleResponse(action, replay, true);
    }
    if (reservation.disposition !== 'reserved' || !reservation.handle) {
      throw new ResearchError('RESEARCH_LIFECYCLE_RESERVATION_FAILED', 'The lifecycle operation could not be durably reserved.');
    }
    let handle = reservation.handle;
    try {
      const executing = this.state.markOperationExecuting(handle, { leaseMs: LIFECYCLE_LEASE_MS });
      handle = executing.handle;
      const response = await this.runtime[action]({ actor: who, idempotencyKey: key });
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw new ResearchError('RESEARCH_RUNTIME_INVALID', 'The local lifecycle adapter returned an invalid response.');
      }
      const output = lifecycleResponse(action, response, false);
      this.state.succeedOperation(handle, { result: output });
      return output;
    } catch (error) {
      // A launch may have taken effect despite a lost acknowledgement. A
      // stopped-looking PID/status, however, is never owned Job/DB-close proof.
      let observed = null;
      try { observed = this.runtime.status(); } catch { /* Preserve uncertainty below. */ }
      const converged = observed && action === 'start' && observed.running === true;
      try {
        if (converged) {
          const output = lifecycleResponse(action, { accepted: true, status: observed.status, running: observed.running, detail: observed.detail }, false);
          this.state.succeedOperation(handle, { result: output });
          return output;
        }
        this.state.markOperationUncertain(handle, {
          errorCode: 'RESEARCH_LIFECYCLE_UNCERTAIN',
          errorMessage: 'The research worker lifecycle outcome could not be confirmed.'
        });
      } catch { /* Preserve the primary runtime failure without unbounded detail. */ }
      throw error;
    }
  }
}

module.exports = {
  ACTORS, LIFECYCLE_LEASE_MS, QUEUE, TYPE, UNTRUSTED_CONTENT,
  ResearchControl, ResearchError, containsProhibitedMaterial
};
