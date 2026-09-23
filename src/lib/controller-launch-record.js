'use strict';

// Q27 step 1-2 (BUILD-QUEUE.md): the launch record.
//
// This is deliberately NOT capability-chaining enforcement. The owner's
// correction, 2026-07-28: "most agents today follow most pinned instructions
// well." Build order is instruction-first: (1) pin the instruction that
// spawns should go through the dashboard, (2) always keep an unattributed
// counter so compliance is measured rather than assumed, (3) build a spawn
// gate only if the counter later shows non-compliance. This module is (1)'s
// durable target and (2)'s data source. It does not, and cannot, intercept a
// spawn it was not asked about -- see computeUnattributedWindow() below.
//
// The one exception, per the owner's spec, is the fan-out/depth cap: a
// misread objective producing many high-tier launches has real financial
// consequence (Sol is 5x Luna), and that risk does not degrade gracefully the
// way missed attribution does. So creating a launch DOES enforce a small
// numeric cap on fan-out and nesting depth -- see MAX_FAN_OUT/MAX_DEPTH.
//
// A launch record grants no authority of its own. Refusing to resolve a
// target agent, a disabled agent, or a phase the agent may not claim mirrors
// -- and never bypasses -- src/lib/agent-org.js's own normalizeOrg()/
// mayClaim() contract, which this module reuses rather than reimplements.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const audit = require('./audit');
const agentOrg = require('./agent-org');
const ownerScope = require('./owner-request-scope');
const { statePath } = require('./runtime-state-root');
const ownerScopeStore = require('./owner-request-scope-store');

const SCHEMA_VERSION = 1;
const LAUNCH_ACTION = 'controller.agent.launch';

// Cost tiers are named generically (not "sol"/"terra"/"luna") because this
// module must generalise across providers; config/agent-org.json's per-agent
// displayName is where a provider-specific tier name (e.g. "Sol (Codex high
// tier)") lives. "cheap" is the safe default; anything else must be proposed
// explicitly (tierProposed), never silently applied.
const TIERS = Object.freeze(['cheap', 'standard', 'premium']);
const DEFAULT_TIER = 'cheap';
const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CAP_KINDS = Object.freeze(['turns', 'budget']);
const TERMINAL_STATES = Object.freeze(['pending', 'completed', 'failed', 'cancelled', 'stale']);

// Small constants, not a capability system -- exactly what the owner asked
// for. A launch may directly parent at most MAX_FAN_OUT children, and a
// launch tree may not nest deeper than MAX_DEPTH levels (root = 0).
const MAX_FAN_OUT = 8;
const MAX_DEPTH = 3;

const MIN_CAP_VALUE = 1;
const MAX_CAP_VALUE = 100_000;
// cap.capMs is this module's addition beyond the spec's literal "turns or
// budget" wording: staleness (see projectLaunch()) needs a wall-clock bound,
// and turn/budget counts alone carry no inherent time meaning. It is bounded
// to a plausible single-launch lifetime: 1 minute .. 24 hours.
const MIN_CAP_MS = 60_000;
const MAX_CAP_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SCAN_LIMIT = 200; // audit.tail()'s own hard cap.

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PHASE_ID_RE = /^Q[0-9]{1,3}$/;
// A queue phase id or a short label -- never raw prompt text. Bounded
// charset and length are the enforceable half of "never"; word count is a
// heuristic against prose. Neither guarantees a determined caller cannot
// smuggle a short imperative through, so this is a shape check, not a
// content-safety guarantee.
const OBJECTIVE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,79}$/;
const LAUNCH_ID_RE = /^launch_[A-Za-z0-9_-]{16,64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
// A funding account/pool lane id -- a short identifier, never free text or a
// credential. Same bounded-charset philosophy as OBJECTIVE_LABEL_RE.
const ACCOUNT_LANE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+|\b(?:token|password|cookie|otp|secret|prompt|response|path)\b|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,})/i;
// reports/ is written at runtime, so installed it resolves under the user's
// state root rather than into the program directory. See
// src/lib/runtime-state-root.js.
const DEFAULT_OWNER_LEDGER_FILE = statePath('reports', 'OWNER-REQUEST-LEDGER.json');

const TARGET_ACTIVATION_KINDS = Object.freeze(['owner-scope-rule', 'owner-thread-scope-rule']);

class LaunchRecordError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LaunchRecordError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) { throw new LaunchRecordError(code, message, details); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, allowed, required, label) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('LAUNCH_INVALID', `${label} is invalid.`);
  return value;
}
function enumValue(value, values, label) { if (!values.includes(value)) fail('LAUNCH_INVALID', `${label} must be one of: ${values.join(', ')}.`, { field: label }); return value; }
function agentIdField(value, label) {
  if (typeof value !== 'string' || !AGENT_ID_RE.test(value)) fail('LAUNCH_INVALID', `${label} must be a lowercase agent id.`, { field: label });
  return value;
}
function shortText(value, label, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || SENSITIVE.test(value)) {
    fail('LAUNCH_INVALID', `${label} is invalid.`, { field: label });
  }
  return value;
}
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('LAUNCH_INVALID', `${label} must be an integer between ${min} and ${max}.`, { field: label });
  return value;
}

function objectiveRef(value) {
  if (typeof value !== 'string' || !OBJECTIVE_LABEL_RE.test(value) || SENSITIVE.test(value)) {
    fail('LAUNCH_INVALID', 'objectiveRef must be a queue phase id or a short label, never raw prompt text.', { field: 'objectiveRef' });
  }
  if (value.trim().split(/\s+/).length > 10) {
    fail('LAUNCH_INVALID', 'objectiveRef reads like prose, not a phase id or short label.', { field: 'objectiveRef' });
  }
  return value;
}

function cap(value) {
  exact(value, ['kind', 'value', 'capMs'], ['kind', 'value', 'capMs'], 'cap');
  return Object.freeze({
    kind: enumValue(value.kind, CAP_KINDS, 'cap.kind'),
    value: integer(value.value, 'cap.value', MIN_CAP_VALUE, MAX_CAP_VALUE),
    capMs: integer(value.capMs, 'cap.capMs', MIN_CAP_MS, MAX_CAP_MS)
  });
}

function timestamp(value, label) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(ms) || ms < 0) fail('LAUNCH_INVALID', `${label} is invalid.`, { field: label });
  return new Date(ms).toISOString();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function digest(value) {
  return crypto.createHash('sha256').update(`toolsenabled.launch-record.v${SCHEMA_VERSION}\0${JSON.stringify(stable(value))}`).digest('hex');
}

// Luna lane authority is intentionally a separate, explicit capability from
// the non-authorizing owner-scope packet.  The executor calls this helper only
// after it has normalized its own input; callers creating the signed launch
// record may call it on the same normalized authority payload.  Keeping the
// canonical field order here gives the controller and executor one hash
// contract without creating an executor -> controller import cycle.
function executorPayloadHash(value) {
  exact(value,
    ['repoRoot', 'baseCommit', 'laneId', 'itemId', 'allowedPaths', 'verificationCommand',
      'taskBrief', 'timeoutMs', 'outputBudgetBytes', 'evidenceRoot'],
    ['repoRoot', 'baseCommit', 'laneId', 'itemId', 'allowedPaths', 'verificationCommand',
      'taskBrief', 'timeoutMs', 'outputBudgetBytes', 'evidenceRoot'],
    'executor authority payload');
  if (typeof value.repoRoot !== 'string' || typeof value.baseCommit !== 'string'
      || typeof value.laneId !== 'string' || typeof value.itemId !== 'string'
      || typeof value.taskBrief !== 'string' || typeof value.evidenceRoot !== 'string'
      || !Number.isSafeInteger(value.timeoutMs) || !Number.isSafeInteger(value.outputBudgetBytes)
      || !Array.isArray(value.allowedPaths)) {
    fail('LAUNCH_INVALID', 'executor authority payload is invalid.');
  }
  exact(value.verificationCommand, ['command', 'args'], ['command', 'args'], 'executor verification command');
  if (typeof value.verificationCommand.command !== 'string'
      || !Array.isArray(value.verificationCommand.args)
      || value.verificationCommand.args.some(arg => typeof arg !== 'string')
      || value.allowedPaths.some(entry => typeof entry !== 'string')) {
    fail('LAUNCH_INVALID', 'executor authority payload is invalid.');
  }
  // Do not use stable() here: the explicit object literal is the protocol's
  // field order, including argv order and the already-normalized allowlist.
  const canonical = {
    repoRoot: value.repoRoot,
    baseCommit: value.baseCommit,
    laneId: value.laneId,
    itemId: value.itemId,
    allowedPaths: value.allowedPaths,
    verificationCommand: {
      command: value.verificationCommand.command,
      args: value.verificationCommand.args
    },
    taskBrief: value.taskBrief,
    timeoutMs: value.timeoutMs,
    outputBudgetBytes: value.outputBudgetBytes,
    evidenceRoot: value.evidenceRoot
  };
  return crypto.createHash('sha256')
    .update(`toolsenabled.luna-executor-authority.v1\0${JSON.stringify(canonical)}`)
    .digest('hex');
}

function optionalExecutorPayloadHash(value, label = 'executorPayloadHash') {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    fail('LAUNCH_INVALID', `${label} must be a lowercase SHA-256 digest.`, { field: label });
  }
  return value;
}

// Funding attribution (agent-coord mission-control-backend-contract-gaps-20260803):
// which funding account/pool paid for this launch, recorded at dispatch time
// so the UI reads it from the signed record instead of inferring it. Optional
// -- existing callers are untouched -- and shape-validated so garbage or a
// credential-shaped value can never enter the record.
function optionalAccountLane(value, label = 'accountLane') {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ACCOUNT_LANE_RE.test(value) || SENSITIVE.test(value)) {
    fail('LAUNCH_INVALID', `${label} must be a short funding account/pool lane id.`, { field: label });
  }
  return value;
}

function optionalReasoningEffort(value, label = 'effort') {
  if (value === undefined) return undefined;
  return enumValue(value, REASONING_EFFORTS, label);
}

// --- request (pre-org-check) validation --------------------------------------

/**
 * Validate the caller-supplied launch request shape. This does NOT touch the
 * declared org -- that happens in createLaunch(), which is where a refusal
 * vs. an invalid-shape error diverge (see the module doc comment).
 */
function normalizeLaunchRequest(input) {
  exact(input, ['requestingActor', 'targetAgentId', 'tier', 'model', 'effort', 'objectiveRef', 'cap', 'parentLaunchId', 'threadId', 'scopeRules', 'scopeStoreRevision', 'executorPayloadHash', 'accountLane'],
    ['requestingActor', 'targetAgentId', 'tier', 'model', 'objectiveRef', 'cap'], 'launch request');
  const parentLaunchId = input.parentLaunchId === undefined || input.parentLaunchId === null
    ? null
    : (LAUNCH_ID_RE.test(input.parentLaunchId) ? input.parentLaunchId : fail('LAUNCH_INVALID', 'parentLaunchId is invalid.', { field: 'parentLaunchId' }));
  const hasScopeRules = input.scopeRules !== undefined;
  const hasScopeStoreRevision = input.scopeStoreRevision !== undefined;
  if (input.threadId !== undefined && !hasScopeRules && !hasScopeStoreRevision) {
    fail('LAUNCH_SCOPE_INVALID', 'threadId requires explicit scopeRules or a scopeStoreRevision.', { field: 'threadId' });
  }
  if (hasScopeRules && !Array.isArray(input.scopeRules)) {
    fail('LAUNCH_SCOPE_INVALID', 'scopeRules must be an array when supplied.', { field: 'scopeRules' });
  }
  if (hasScopeRules && hasScopeStoreRevision) {
    fail('LAUNCH_SCOPE_INVALID', 'scopeRules and scopeStoreRevision are mutually exclusive.', { field: 'scopeStoreRevision' });
  }
  if (hasScopeStoreRevision && (!Number.isSafeInteger(input.scopeStoreRevision) || input.scopeStoreRevision < 0)) {
    fail('LAUNCH_SCOPE_INVALID', 'scopeStoreRevision is invalid.', { field: 'scopeStoreRevision' });
  }
  return Object.freeze({
    requestingActor: agentIdField(input.requestingActor, 'requestingActor'),
    targetAgentId: agentIdField(input.targetAgentId, 'targetAgentId'),
    tier: enumValue(input.tier, TIERS, 'tier'),
    model: shortText(input.model, 'model', 120),
    effort: optionalReasoningEffort(input.effort),
    objectiveRef: objectiveRef(input.objectiveRef),
    cap: cap(input.cap),
    parentLaunchId,
    threadId: input.threadId === undefined ? null : input.threadId,
    scopeRules: hasScopeRules ? Object.freeze(input.scopeRules.slice()) : null,
    scopeStoreRevision: hasScopeStoreRevision ? input.scopeStoreRevision : undefined,
    executorPayloadHash: optionalExecutorPayloadHash(input.executorPayloadHash),
    accountLane: optionalAccountLane(input.accountLane)
  });
}

// Scope-store reads are a deliberately explicit dependency seam.  Production
// launches use the store's state-root default; focused tests inject a reader
// that returns the same closed snapshot shape.  The caller supplies the
// revision it observed, so a scope decision cannot be recorded from an
// unobserved store revision.
function normalizeScopeStoreSnapshot(value) {
  // The store also records WHICH ledger corpus its rules were reviewed against
  // (see the watermark note in owner-request-scope-store.js). Launch decisions
  // are made from the rules alone, so the watermark is tolerated and dropped
  // here rather than required -- but it must not make the snapshot look
  // malformed, or applying a review would break the launch path.
  exact(value, ['schemaVersion', 'revision', 'reviewedLedgerRevision', 'reviewedRequestIds', 'rules'],
    ['schemaVersion', 'revision', 'rules'], 'launch scope store snapshot');
  if (value.schemaVersion !== ownerScopeStore.STORE_VERSION
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Array.isArray(value.rules)) {
    fail('LAUNCH_SCOPE_STORE_INVALID', 'launch scope store snapshot is invalid.');
  }
  let rules;
  try { rules = value.rules.map(rule => ownerScope.normalizeScopeRule(rule)); }
  catch (error) {
    fail('LAUNCH_SCOPE_STORE_INVALID', 'launch scope store snapshot is invalid.', { cause: error && error.code });
  }
  return Object.freeze({
    schemaVersion: ownerScopeStore.STORE_VERSION,
    revision: value.revision,
    rules: Object.freeze(rules)
  });
}

function readLaunchScopeStore(dependencies) {
  if (dependencies.readScopeStore !== undefined && dependencies.scopeStore !== undefined) {
    fail('LAUNCH_SCOPE_STORE_UNAVAILABLE', 'The launch scope-store reader is ambiguous.');
  }
  const reader = dependencies.readScopeStore !== undefined
    ? dependencies.readScopeStore
    : (dependencies.scopeStore !== undefined
      ? dependencies.scopeStore && dependencies.scopeStore.read
      : () => ownerScopeStore.createScopeStore().read());
  if (typeof reader !== 'function') {
    fail('LAUNCH_SCOPE_STORE_UNAVAILABLE', 'The launch scope-store reader is unavailable.');
  }
  let snapshot;
  try { snapshot = reader(); }
  catch (error) {
    fail('LAUNCH_SCOPE_STORE_UNAVAILABLE', 'The launch scope store could not be read.', { cause: error && error.code });
  }
  return normalizeScopeStoreSnapshot(snapshot);
}

// --- declared-org resolution --------------------------------------------------

function normalizeDeclaredOrg(raw) {
  let normalized;
  try { normalized = agentOrg.normalizeOrg(raw, { maxAgents: 0 }); }
  catch (error) {
    fail('LAUNCH_ORG_UNAVAILABLE', 'The declared agent org failed validation.', { cause: error && error.code });
  }
  const rawById = new Map(raw.agents.map(entry => [entry.id, entry]));
  const agents = normalized.agents.map(agent => {
    const directive = rawById.get(agent.id)?.$roleDirective;
    if (directive === undefined) return agent;
    if (!plain(directive)
        || Reflect.ownKeys(directive).some(key => !['id', 'date'].includes(key))
        || typeof directive.id !== 'string' || !/^R[0-9]{1,5}$/.test(directive.id)
        || typeof directive.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(directive.date)) {
      fail('LAUNCH_ORG_UNAVAILABLE', `Agent "${agent.id}" has an invalid role directive declaration.`);
    }
    return Object.freeze({ ...agent, $roleDirective: Object.freeze({ id: directive.id, date: directive.date }) });
  });
  return Object.freeze({ ...normalized, agents: Object.freeze(agents) });
}

function defaultLoadOrg() {
  const orgFile = path.join(__dirname, '..', '..', 'config', 'agent-org.json');
  let raw;
  try {
    // eslint-disable-next-line global-require
    raw = require(orgFile);
  } catch (error) {
    fail('LAUNCH_ORG_UNAVAILABLE', 'The declared agent org could not be read.', { cause: error && error.message });
  }
  return normalizeDeclaredOrg(raw);
}

/**
 * Resolve and gate a target agent against the declared org. Refuses (does
 * not silently downgrade) for an unknown agent, a disabled agent, or a phase
 * the agent may not claim per agent-org.js's own mayClaim().
 */
function defaultReadOwnerRequest(requestId) {
  const ledgerFile = process.env.TOOLSENABLED_OWNER_LEDGER_FILE
    ? path.resolve(process.env.TOOLSENABLED_OWNER_LEDGER_FILE)
    : DEFAULT_OWNER_LEDGER_FILE;
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); }
  catch { fail('LAUNCH_SCOPE_OWNER_PROVENANCE_REQUIRED', 'The owner-request ledger could not verify the scope activation.'); }
  if (!plain(ledger) || !Array.isArray(ledger.requests)) {
    fail('LAUNCH_SCOPE_OWNER_PROVENANCE_REQUIRED', 'The owner-request ledger could not verify the scope activation.');
  }
  return ledger.requests.find(entry => plain(entry) && entry.id === requestId) || null;
}

function assertOwnerScopeProvenance(rule, dependencies) {
  const reader = dependencies.readOwnerRequest === undefined
    ? defaultReadOwnerRequest
    : dependencies.readOwnerRequest;
  if (typeof reader !== 'function') {
    fail('LAUNCH_SCOPE_OWNER_PROVENANCE_REQUIRED', 'The owner-request reader is unavailable for a disabled-target activation.');
  }
  let source;
  try { source = reader(rule.sourceRequestId); }
  catch { fail('LAUNCH_SCOPE_OWNER_PROVENANCE_REQUIRED', 'The owner-request ledger could not verify the scope activation.'); }
  if (!plain(source) || source.id !== rule.sourceRequestId
      || typeof source.verbatim !== 'string' || source.verbatim !== rule.ownerVerbatim) {
    fail('LAUNCH_SCOPE_OWNER_PROVENANCE_REQUIRED', 'The scope activation is not backed by the exact recorded owner request.', {
      ruleId: rule.ruleId,
      sourceRequestId: rule.sourceRequestId
    });
  }
}

function activationCandidates(agent) {
  if (!agent.scopeActivation) return [];
  return [Object.freeze({ kind: 'owner-scope-rule', ...agent.scopeActivation, threadOnly: false })];
}

function scopeActivatesTarget(org, agent, request, scopePacket, dependencies) {
  if (!scopePacket || !Array.isArray(scopePacket.rules)) return null;
  for (const activation of activationCandidates(agent)) {
    if (request.model !== activation.model || request.tier !== activation.tier
        || (activation.effort !== undefined
          ? request.effort !== activation.effort
          : request.effort !== undefined)) continue;
    const rule = scopePacket.rules.find(candidate => candidate.ruleKey === activation.ruleKey
      && candidate.sourceRequestId === activation.sourceRequestId);
    if (!rule) continue;
    if (activation.threadOnly && (request.threadId === null || scopePacket.threadId !== request.threadId
        || rule.scopeKind !== 'thread' || rule.threadId !== request.threadId)) {
      continue;
    }
    // A caller-supplied scopeRules array is useful for non-authorizing context,
    // but cannot turn on a globally disabled target.  That privilege requires
    // the exact revision read from the durable owner-scope store.
    if (request.scopeStoreRevision === undefined) {
      return Object.freeze({ provenanceRequired: true, activation, rule });
    }
    assertOwnerScopeProvenance(rule, dependencies);
    return Object.freeze({
      kind: activation.kind,
      ruleId: rule.ruleId,
      ruleKey: rule.ruleKey,
      sourceRequestId: rule.sourceRequestId,
      scopeKind: rule.scopeKind,
      threadId: rule.threadId,
      scopeStoreRevision: request.scopeStoreRevision
    });
  }
  return null;
}

function resolveTarget(org, request, scopePacket, dependencies) {
  const targetAgentId = request.targetAgentId;
  const agent = org.agents.find(entry => entry.id === targetAgentId);
  if (!agent) fail('LAUNCH_UNKNOWN_AGENT', `No declared agent has id "${targetAgentId}".`, { targetAgentId });
  const targetActivation = scopeActivatesTarget(org, agent, request, scopePacket, dependencies);
  if (!agent.enabled && targetActivation && targetActivation.provenanceRequired) {
    fail('LAUNCH_SCOPE_PROVENANCE_REQUIRED', `Agent "${targetAgentId}" may be activated only from a durable owner-scope store revision.`, {
      targetAgentId,
      ruleKey: targetActivation.activation.ruleKey,
      sourceRequestId: targetActivation.activation.sourceRequestId
    });
  }
  const scopeActivated = targetActivation !== null;
  if (!agent.enabled && !scopeActivated) {
    if (agent.scopeActivation) {
      fail('LAUNCH_SCOPE_ACTIVATION_REQUIRED', `Agent "${targetAgentId}" requires its exact owner-scoped activation rule and model tuple.`, {
        targetAgentId,
        ruleKey: agent.scopeActivation.ruleKey,
        sourceRequestId: agent.scopeActivation.sourceRequestId
      });
    }
    fail('LAUNCH_DISABLED_AGENT', `Agent "${targetAgentId}" is disabled in the declared org.`, { targetAgentId });
  }
  if (request.effort !== undefined && !scopeActivated) {
    fail('LAUNCH_REASONING_EFFORT_REFUSED', 'A reasoning effort may be declared only by an exact owner-scope activation tuple.', {
      targetAgentId,
      effort: request.effort
    });
  }
  if (PHASE_ID_RE.test(request.objectiveRef)) {
    // CALL mayClaim() rather than restating its rule. This module's own header
    // promises it "reuses rather than reimplements" agent-org.js's mayClaim()
    // contract, and the two lines that used to sit here -- a hand-copied
    // `role !== 'coordinator-assistant' && phasePriority...` -- are how that
    // promise quietly became false. config/standing-orders.json declares
    // COORDINATOR 3 enforcement:'mechanical' with enforcingComponent
    // 'src/lib/agent-org.js#mayClaim', while mayClaim() itself had ZERO callers
    // (language-server reference search, 2026-08-09: its declaration and its
    // export line, nothing else). The rule was really being carried by a copy
    // that could drift from the function the declaration named -- add a role to
    // mayClaim() and this gate would silently not get it.
    //
    // mayClaim() also refuses a disabled agent. Reaching this line with
    // enabled:false means the owner-scope activation checked above already
    // granted that exception, so the claim is evaluated against the activated
    // agent and behaviour is unchanged.
    const claimOrg = agent.enabled
      ? org
      : { ...org, agents: org.agents.map(entry => (entry === agent ? { ...entry, enabled: true } : entry)) };
    if (!agentOrg.mayClaim(claimOrg, targetAgentId, request.objectiveRef)) {
      fail('LAUNCH_PHASE_REJECTED', `Agent "${targetAgentId}" may not claim phase "${request.objectiveRef}".`, { targetAgentId, objectiveRef: request.objectiveRef });
    }
  }
  return Object.freeze({ agent, targetActivation });
}

// --- record (post-validation) shape ------------------------------------------

function normalizeRecord(value) {
  exact(value, ['schemaVersion', 'launchId', 'requestingActor', 'targetAgentId', 'tier', 'tierProposed', 'model', 'effort',
    'objectiveRef', 'cap', 'parentLaunchId', 'depth', 'launchedAt', 'terminalState', 'scopePacket', 'targetActivation', 'executorPayloadHash', 'accountLane'],
    ['schemaVersion', 'launchId', 'requestingActor', 'targetAgentId', 'tier', 'tierProposed', 'model',
      'objectiveRef', 'cap', 'parentLaunchId', 'depth', 'launchedAt', 'terminalState'], 'LaunchRecord');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('LAUNCH_VERSION_UNSUPPORTED', 'LaunchRecord schema version is unsupported.');
  if (typeof value.launchId !== 'string' || !LAUNCH_ID_RE.test(value.launchId)) fail('LAUNCH_INVALID', 'launchId is invalid.');
  if (typeof value.tierProposed !== 'boolean') fail('LAUNCH_INVALID', 'tierProposed must be a boolean.');
  const parentLaunchId = value.parentLaunchId === null ? null
    : (typeof value.parentLaunchId === 'string' && LAUNCH_ID_RE.test(value.parentLaunchId) ? value.parentLaunchId : fail('LAUNCH_INVALID', 'parentLaunchId is invalid.'));
  const targetAgentId = agentIdField(value.targetAgentId, 'targetAgentId');
  const body = {
    schemaVersion: SCHEMA_VERSION,
    launchId: value.launchId,
    requestingActor: agentIdField(value.requestingActor, 'requestingActor'),
    targetAgentId,
    tier: enumValue(value.tier, TIERS, 'tier'),
    tierProposed: value.tierProposed,
    model: shortText(value.model, 'model', 120),
    objectiveRef: objectiveRef(value.objectiveRef),
    cap: cap(value.cap),
    parentLaunchId,
    depth: integer(value.depth, 'depth', 0, MAX_DEPTH),
    launchedAt: timestamp(value.launchedAt, 'launchedAt'),
    terminalState: enumValue(value.terminalState, TERMINAL_STATES, 'terminalState')
  };
  if (value.effort !== undefined) body.effort = optionalReasoningEffort(value.effort);
  if (value.scopePacket !== undefined) body.scopePacket = normalizeScopePacket(value.scopePacket, targetAgentId);
  if (value.targetActivation !== undefined) body.targetActivation = normalizeTargetActivation(value.targetActivation, body.scopePacket);
  if (value.executorPayloadHash !== undefined) body.executorPayloadHash = optionalExecutorPayloadHash(value.executorPayloadHash);
  if (value.accountLane !== undefined) body.accountLane = optionalAccountLane(value.accountLane);
  return Object.freeze({ ...body, recordHash: digest(body) });
}

function compactRecord(record) {
  const { recordHash, ...payload } = record;
  return Object.freeze(payload);
}
function launchPayload(record) {
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, record: compactRecord(record) });
}

// This is the explicit handoff object for a dispatcher to put in the target
// agent's brief. It is deliberately derived after record normalization and is
// not itself persisted or signed as a new authority-bearing record. In
// particular, it excludes targetActivation and executor bindings: the scope
// packet is information about which owner rules applied, never permission to
// act on them.
function buildDispatchBrief(record) {
  const normalized = normalizeRecord(compactRecord(record));
  return Object.freeze({
    schemaVersion: 1,
    launchId: normalized.launchId,
    agentId: normalized.targetAgentId,
    objectiveRef: normalized.objectiveRef,
    scopePacket: normalized.scopePacket || null,
    informational: true,
    grantsAuthority: false
  });
}

/* The brief above is an OBJECT, and a dispatcher puts it at the top of the
   text a spawned agent reads. Dropping it straight into a string join renders
   it `[object Object]` — which is what every lane brief actually began with
   (measured 2026-08-16 by driving the installed 1.0.17: all three brief files,
   Claude and Codex alike), so no child ever learned its launch id, its agent
   id, its objective, or the scope packet those lines exist to carry. The
   rendering lives beside the shape so the two cannot drift, and it says out
   loud that it grants nothing — the same claim the object makes in a field a
   text-reading agent never sees. */
function renderDispatchBrief(brief) {
  if (!brief || typeof brief !== 'object') return '';
  const lines = ['Launch record for this run. It is information, not permission.'];
  lines.push(`  launch id: ${brief.launchId || 'not recorded'}`);
  lines.push(`  agent id: ${brief.agentId || 'not recorded'}`);
  lines.push(`  objective: ${brief.objectiveRef || 'none recorded'}`);
  if (brief.scopePacket) {
    const rules = Array.isArray(brief.scopePacket.appliedRuleIds) ? brief.scopePacket.appliedRuleIds : [];
    lines.push(`  owner rules applied: ${rules.length > 0 ? rules.join(', ') : 'none'}`);
  } else {
    lines.push('  owner rules applied: none recorded');
  }
  lines.push('  This record grants no authority; act only within the boundaries you were already given.');
  return lines.join('\n');
}

function normalizeScopePacket(value, expectedAgentId) {
  exact(value, ['schemaVersion', 'agentId', 'threadId', 'generatedAt', 'appliedRuleIds', 'rules', 'conflicts', 'grantsAuthority'],
    ['schemaVersion', 'agentId', 'threadId', 'generatedAt', 'appliedRuleIds', 'rules', 'conflicts', 'grantsAuthority'], 'launch scope packet');
  if (value.schemaVersion !== ownerScope.VERSION || value.grantsAuthority !== false) {
    fail('LAUNCH_SCOPE_INVALID', 'launch scope packet is unsupported or authorizing.');
  }
  if (value.agentId !== expectedAgentId) {
    fail('LAUNCH_SCOPE_INVALID', 'launch scope packet agentId does not match the launch target.', { field: 'agentId' });
  }
  if (value.threadId !== null && (typeof value.threadId !== 'string' || !ownerScope.THREAD_ID_RE.test(value.threadId))) {
    fail('LAUNCH_SCOPE_INVALID', 'launch scope packet threadId is invalid.', { field: 'threadId' });
  }
  const generatedAt = timestamp(value.generatedAt, 'scopePacket.generatedAt');
  if (!Array.isArray(value.rules) || !Array.isArray(value.appliedRuleIds) || !Array.isArray(value.conflicts)) {
    fail('LAUNCH_SCOPE_INVALID', 'launch scope packet collections are invalid.');
  }
  // Dispatch packets intentionally omit schemaVersion from each nested rule;
  // the packet carries that version once at its top level.  Validate the
  // packet-rule shape before adding the version back for the shared scope
  // normalizer, so a nested version field cannot be smuggled through.
  const packetRuleKeys = [
    'ruleId', 'ruleKey', 'scopeKind', 'threadId', 'sourceRequestId',
    'issuedAt', 'expiresAt', 'decisionSummary', 'evidenceRefs', 'ownerVerbatim'
  ];
  const rules = value.rules.map(rule => {
    if (!plain(rule)
        || Reflect.ownKeys(rule).some(key => !packetRuleKeys.includes(key))
        || packetRuleKeys.some(key => !Object.hasOwn(rule, key))) {
      fail('LAUNCH_SCOPE_INVALID', 'launch scope packet contains an invalid rule.');
    }
    return ownerScope.normalizeScopeRule({ schemaVersion: ownerScope.VERSION, ...rule });
  });
  const ruleIds = rules.map(rule => rule.ruleId);
  if (new Set(ruleIds).size !== ruleIds.length
      || JSON.stringify(ruleIds) !== JSON.stringify(value.appliedRuleIds)) {
    fail('LAUNCH_SCOPE_INVALID', 'launch scope packet appliedRuleIds do not match its rules.');
  }
  if (value.conflicts.some(conflict => !plain(conflict)
      || typeof conflict.ruleKey !== 'string'
      || !plain(conflict.winner)
      || !Array.isArray(conflict.losers))) {
    fail('LAUNCH_SCOPE_INVALID', 'launch scope packet conflicts are invalid.');
  }
  return ownerScope.buildDispatchScopePacket({
    schemaVersion: ownerScope.VERSION,
    threadId: value.threadId,
    generatedAt,
    appliedRuleIds: ruleIds,
    rules,
    conflicts: value.conflicts,
    grantsAuthority: false
  }, { agentId: expectedAgentId });
}

function normalizeTargetActivation(value, scopePacket) {
  exact(value, ['kind', 'ruleId', 'ruleKey', 'sourceRequestId', 'scopeKind', 'threadId', 'scopeStoreRevision'],
    ['kind', 'ruleId', 'ruleKey', 'sourceRequestId', 'scopeKind', 'threadId', 'scopeStoreRevision'], 'target activation');
  if (!scopePacket || !TARGET_ACTIVATION_KINDS.includes(value.kind)
      || !Number.isSafeInteger(value.scopeStoreRevision) || value.scopeStoreRevision < 0) {
    fail('LAUNCH_SCOPE_INVALID', 'target activation is invalid.');
  }
  const rule = scopePacket.rules.find(candidate => candidate.ruleId === value.ruleId
    && candidate.ruleKey === value.ruleKey
    && candidate.sourceRequestId === value.sourceRequestId
    && candidate.scopeKind === value.scopeKind
    && candidate.threadId === value.threadId);
  if (!rule || (value.kind === 'owner-thread-scope-rule'
      && (value.scopeKind !== 'thread' || value.threadId === null || scopePacket.threadId !== value.threadId))) {
    fail('LAUNCH_SCOPE_INVALID', 'target activation does not match the resolved launch scope.');
  }
  return Object.freeze({
    kind: value.kind,
    ruleId: rule.ruleId,
    ruleKey: rule.ruleKey,
    sourceRequestId: rule.sourceRequestId,
    scopeKind: rule.scopeKind,
    threadId: rule.threadId,
    scopeStoreRevision: value.scopeStoreRevision
  });
}

/** Parse a LaunchRecord back out of a signed audit event (either audit.tail()'s
 * flattened shape or audit.findEvents()'s nested-envelope shape). */
function launchFromAuditEvent(event) {
  if (!plain(event)) return null;
  const auditEvent = plain(event.event) ? event.event : event;
  if (auditEvent.action !== LAUNCH_ACTION) return null;
  const details = auditEvent.details;
  exact(details, ['schemaVersion', 'record'], ['schemaVersion', 'record'], 'launch audit details');
  if (details.schemaVersion !== SCHEMA_VERSION) fail('LAUNCH_VERSION_UNSUPPORTED', 'Launch audit schema version is unsupported.');
  return normalizeRecord(details.record);
}

// --- fan-out / depth (the one hard gate) -------------------------------------

function defaultGetLaunch(launchId, auditApi) {
  if (typeof auditApi.findEvents !== 'function') {
    fail('LAUNCH_PARENT_LOOKUP_UNAVAILABLE', 'The audit reader cannot look up the parent launch.');
  }
  let matches;
  try { matches = auditApi.findEvents({ action: LAUNCH_ACTION, target: launchId, limit: 1 }); }
  catch { fail('LAUNCH_PARENT_LOOKUP_UNAVAILABLE', 'The parent launch could not be read from the audit ledger.'); }
  if (!Array.isArray(matches)) {
    fail('LAUNCH_PARENT_LOOKUP_UNAVAILABLE', 'The audit reader returned no enumerable parent-launch results.');
  }
  if (matches.length === 0) return null;
  try { return launchFromAuditEvent(matches[0]); }
  catch { fail('LAUNCH_PARENT_LOOKUP_UNAVAILABLE', 'The recorded parent launch could not be validated.'); }
}

// Counts existing direct children of a parent launch within a bounded recent
// window of the ledger (audit.tail()'s own cap, 200 events). This is a
// best-effort scan, not an indexed query: a parent with children older than
// the scanned window would be undercounted. That is an acceptable trade for
// a hard financial-safety gate whose failure mode (refusing a launch that
// was actually fine) is far cheaper than the failure mode it prevents
// (silently unbounded fan-out).
function defaultCountChildren(parentLaunchId, auditApi, scanLimit) {
  // Returning 0 on an unreadable ledger made this gate fail OPEN: under audit
  // contention (a swarm writing concurrently) tail() throws, siblings reads as
  // 0, the `siblings >= MAX_FAN_OUT` check passes, and fan-out is silently
  // unbounded -- exactly what the comment above says this gate prevents. An
  // unknown count is not a zero count, so refuse instead.
  if (typeof auditApi.tail !== 'function') {
    fail('LAUNCH_FANOUT_UNKNOWN', 'The audit reader cannot enumerate sibling launches, so the fan-out cap cannot be enforced.');
  }
  let events;
  try { events = auditApi.tail(scanLimit); }
  catch (error) {
    fail('LAUNCH_FANOUT_UNKNOWN', 'Sibling launches could not be read, so the fan-out cap cannot be enforced.', { cause: error && error.message });
  }
  if (!Array.isArray(events)) {
    fail('LAUNCH_FANOUT_UNKNOWN', 'The audit reader returned no enumerable sibling launches, so the fan-out cap cannot be enforced.');
  }
  let count = 0;
  for (const event of events) {
    const record = launchFromAuditEvent(event);
    if (record && record.parentLaunchId === parentLaunchId) count += 1;
  }
  return count;
}

// Operational launch custody is independent of optional audit history. It uses
// the existing fenced StateStore, not a synthetic signed receipt.
function operationalStore(dependencies = {}) {
  return dependencies.stateStore || require('./state-store').getStateStore();
}
function getOperationalLaunch(id, dependencies = {}) {
  const row = operationalStore(dependencies).getOperation({ type: LAUNCH_ACTION, key: id });
  if (!row) return null;
  if (row.status !== 'succeeded' || !row.result?.record) fail('LAUNCH_PARENT_LOOKUP_UNAVAILABLE', 'The operational launch is not settled.');
  const record = normalizeRecord(row.result.record);
  if (record.launchId !== id || record.recordHash !== row.inputHash) fail('LAUNCH_PARENT_LOOKUP_UNAVAILABLE', 'The operational launch binding is invalid.');
  return record;
}
function claimOperationalChild(record, dependencies) {
  if (!record.parentLaunchId) return;
  const store = operationalStore(dependencies);
  for (let slot = 0; slot < MAX_FAN_OUT; slot++) {
    try {
      const claim = store.reserveOperation({ type: `${LAUNCH_ACTION}.child`, key: `${record.parentLaunchId}:${slot}`, inputHash: record.recordHash, leaseMs: 60000 });
      if (claim.disposition !== 'reserved') fail('LAUNCH_FANOUT_UNKNOWN', 'A child slot was not exclusively reserved.');
      store.markOperationExecuting(claim.handle, { leaseMs: 60000 });
      store.succeedOperation(claim.handle, { result: { launchId: record.launchId } });
      return;
    } catch (error) {
      if (['OPERATION_INPUT_CONFLICT', 'OPERATION_LEASE_HELD', 'OPERATION_UNCERTAIN'].includes(error.code)) continue;
      throw error;
    }
  }
  fail('LAUNCH_FANOUT_EXCEEDED', 'The parent has no unclaimed child slot.');
}
function saveOperationalLaunch(record, dependencies) {
  const store = operationalStore(dependencies);
  const claim = store.reserveOperation({ type: LAUNCH_ACTION, key: record.launchId, inputHash: record.recordHash, leaseMs: 60000 });
  if (claim.disposition !== 'reserved') fail('LAUNCH_PARENT_LOOKUP_UNAVAILABLE', 'The launch identity was already used.');
  store.markOperationExecuting(claim.handle, { leaseMs: 60000 });
  store.succeedOperation(claim.handle, { result: { record: launchPayload(record).record } });
}

// --- create -------------------------------------------------------------------

function generateLaunchId(request, launchedAtMs) {
  const seed = `${request.requestingActor} ${request.targetAgentId} ${request.objectiveRef} ${launchedAtMs} ${crypto.randomUUID()}`;
  return `launch_${crypto.createHash('sha256').update(seed, 'utf8').digest('base64url').slice(0, 32)}`;
}

/**
 * Create and durably record one launch. Refuses (throws LaunchRecordError)
 * rather than downgrading for: invalid request shape, unresolvable org,
 * unknown/disabled target agent, a phase the target may not claim, an
 * unresolvable parent, or a fan-out/depth cap violation. Grants no new
 * authority -- every policy, approval, kill-switch, and credential gate a
 * launched agent was already bound by remains unchanged.
 */
function createLaunch(input, dependencies = {}) {
  const request = normalizeLaunchRequest(input);
  const org = dependencies.org || defaultLoadOrg();

  const auditApi = dependencies.audit || audit;
  const operationAudit = require('./operation-audit');
  const auditPolicy = operationAudit.capturePolicy(dependencies);
  const operationalParent = request.parentLaunchId ? getOperationalLaunch(request.parentLaunchId, dependencies) : null;
  const scanLimit = Number.isSafeInteger(dependencies.scanLimit) ? dependencies.scanLimit : DEFAULT_SCAN_LIMIT;
  const getLaunch = dependencies.getLaunch || (id => operationalParent || (auditPolicy.required ? defaultGetLaunch(id, auditApi) : null));
  const countChildren = dependencies.countChildren || (id => defaultCountChildren(id, auditApi, scanLimit));
  const nowMs = (dependencies.clock || Date.now)();
  let scopePacket = null;
  if (request.scopeRules !== null || request.scopeStoreRevision !== undefined) {
    let rules = request.scopeRules;
    if (request.scopeStoreRevision !== undefined) {
      const snapshot = readLaunchScopeStore(dependencies);
      if (snapshot.revision !== request.scopeStoreRevision) {
        fail('LAUNCH_SCOPE_STORE_REVISION_CONFLICT', 'The launch scope store revision does not match scopeStoreRevision.', {
          expectedRevision: request.scopeStoreRevision,
          actualRevision: snapshot.revision
        });
      }
      rules = snapshot.rules;
    }
    try {
      scopePacket = ownerScope.buildDispatchScopePacket(
        ownerScope.resolveScopeRules(rules, { threadId: request.threadId, nowMs }),
        { agentId: request.targetAgentId }
      );
    } catch (error) {
      if (error instanceof LaunchRecordError) throw error;
      fail('LAUNCH_SCOPE_INVALID', 'The explicit launch scope could not be resolved.', { cause: error && error.code });
    }
  }
  const target = resolveTarget(org, request, scopePacket, dependencies);

  let depth = 0;
  if (request.parentLaunchId) {
    const parentRecord = getLaunch(request.parentLaunchId);
    if (!parentRecord) fail('LAUNCH_UNKNOWN_PARENT', `No launch record found for parentLaunchId "${request.parentLaunchId}".`, { parentLaunchId: request.parentLaunchId });
    depth = parentRecord.depth + 1;
    if (depth > MAX_DEPTH) fail('LAUNCH_DEPTH_EXCEEDED', `Launch tree depth ${depth} exceeds the cap of ${MAX_DEPTH}.`, { depth, maxDepth: MAX_DEPTH });
    const siblings = operationalParent ? 0 : countChildren(request.parentLaunchId);
    if (siblings >= MAX_FAN_OUT) fail('LAUNCH_FANOUT_EXCEEDED', `Parent launch "${request.parentLaunchId}" already has ${siblings} children, at the cap of ${MAX_FAN_OUT}.`, { parentLaunchId: request.parentLaunchId, siblings, maxFanOut: MAX_FAN_OUT });
  }

  const launchedAt = new Date(nowMs).toISOString();
  const recordInput = {
    schemaVersion: SCHEMA_VERSION,
    launchId: generateLaunchId(request, nowMs),
    requestingActor: request.requestingActor,
    targetAgentId: request.targetAgentId,
    tier: request.tier,
    tierProposed: request.tier !== DEFAULT_TIER,
    model: request.model,
    objectiveRef: request.objectiveRef,
    cap: request.cap,
    parentLaunchId: request.parentLaunchId,
    depth,
    launchedAt,
    terminalState: 'pending'
  };
  if (request.effort !== undefined) recordInput.effort = request.effort;
  if (scopePacket !== null) recordInput.scopePacket = scopePacket;
  if (target.targetActivation !== null) recordInput.targetActivation = target.targetActivation;
  if (request.executorPayloadHash !== undefined) recordInput.executorPayloadHash = request.executorPayloadHash;
  if (request.accountLane !== undefined) recordInput.accountLane = request.accountLane;
  const record = normalizeRecord(recordInput);

  if (operationalParent) claimOperationalChild(record, dependencies);
  if (!auditPolicy.required) {
    saveOperationalLaunch(record, dependencies);
    return Object.freeze({ launchId: record.launchId, record,
      dispatchBrief: buildDispatchBrief(record), recordHash: record.recordHash,
      audit: operationAudit.skippedStatus(LAUNCH_ACTION, record.launchId) });
  }

  if (typeof auditApi.requireRecord !== 'function') fail('LAUNCH_AUDIT_UNAVAILABLE', 'The canonical audit writer is unavailable.');
  let receipt;
  try { receipt = auditApi.requireRecord(LAUNCH_ACTION, record.launchId, launchPayload(record)); }
  catch (error) {
    if (error instanceof LaunchRecordError) throw error;
    fail('LAUNCH_AUDIT_UNAVAILABLE', 'The canonical audit launch event could not be recorded.', { cause: error && error.message });
  }
  if (!receipt || receipt.durable !== true || receipt.anchored !== true || typeof receipt.eventHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.eventHash)) {
    fail('LAUNCH_AUDIT_UNAVAILABLE', 'The canonical audit launch event was not durably protected.');
  }

  saveOperationalLaunch(record, dependencies);
  return Object.freeze({
    launchId: record.launchId,
    record,
    dispatchBrief: buildDispatchBrief(record),
    recordHash: record.recordHash,
    auditSequence: receipt.sequence,
    auditEventHash: receipt.eventHash
  });
}

// --- read-time staleness derivation -------------------------------------------

/**
 * Project a stored LaunchRecord for reading. Mirrors state-store.js's
 * _taskRow() fix for the exact defect named in the Q27 spec: task.list used
 * to report an abandoned task as "running" forever because staleness was
 * never derived at read time. Here, terminalState is recomputed from
 * launchedAt + cap.capMs on every read; nothing is written back to "stale" --
 * there is deliberately no sweeper.
 */
function projectLaunch(record, { nowMs = Date.now() } = {}) {
  const storedTerminalState = record.terminalState;
  let terminalState = storedTerminalState;
  let stale = false;
  if (storedTerminalState === 'pending') {
    const launchedMs = Date.parse(record.launchedAt);
    if (Number.isFinite(launchedMs) && nowMs - launchedMs > record.cap.capMs) {
      terminalState = 'stale';
      stale = true;
    }
  }
  return Object.freeze({ ...record, terminalState, storedTerminalState, stale, evaluatedAtMs: nowMs });
}

// --- unattributed counter ------------------------------------------------------

// The only other observable, actor-tagged signal of agent activity that is
// generic across providers and stable in the ledger today. coordinator.run.claim
// fired whenever a worker actor picked up a durable run; per the earlier
// session finding, Sol/Terra/Luna all collapse into the single 'codex' actor
// there, same as everywhere else in the ledger.
const ACTIVITY_SIGNAL_ACTIONS = Object.freeze(['coordinator.run.claim']);
const UNATTRIBUTED_LOOKUP_UNAVAILABLE = 'LAUNCH_UNATTRIBUTED_LOOKUP_UNAVAILABLE';

/**
 * Estimate unattributed agent activity in [startMs, endMs) by diffing two
 * counts read from the same bounded ledger window: controller.agent.launch
 * events (attributed) vs. ACTIVITY_SIGNAL_ACTIONS events (a proxy for "an
 * agent did something"). This is NOT a per-event join -- launch records and
 * coordinator.run.claim events share no common id in this build -- so it can only
 * ever be a window-level count difference, never a verified per-spawn
 * attribution. Concretely:
 *
 *  - It undercounts: a provider CLI opened directly by the owner, or any
 *    activity that never claims a durable run, produces no signal at all and
 *    is invisible to this function even though the spec (BUILD-QUEUE.md
 *    Q27, "The residue") names both as unattributed.
 *  - It cannot attribute a tier: because every codex tier folds into one
 *    actor, an unattributed signal cannot say whether it was Sol, Terra, or
 *    Luna.
 *  - It is bounded by audit.tail()'s own 200-event cap, not by the window:
 *    if the ledger has moved on, older parts of [startMs, endMs) fall out of
 *    scan range and are silently not represented. windowCoverageComplete
 *    below says whether the scan actually reached back to startMs.
 *
 * The return shape carries this honestly rather than returning a bare
 * number.
 */
function computeUnattributedWindow({ startMs, endMs }, dependencies = {}) {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) {
    fail('LAUNCH_INVALID', 'window {startMs, endMs} is invalid.');
  }
  const auditApi = dependencies.audit || audit;
  const scanLimit = Number.isSafeInteger(dependencies.scanLimit) ? dependencies.scanLimit : DEFAULT_SCAN_LIMIT;
  let events = [];
  let available = true;
  let unavailableCode = null;
  let unavailableReason = null;
  if (typeof auditApi.tail === 'function') {
    try { events = auditApi.tail(scanLimit); }
    catch {
      available = false;
      unavailableCode = UNATTRIBUTED_LOOKUP_UNAVAILABLE;
      unavailableReason = 'The audit ledger could not be read; this result is NOT claiming that unattributed activity is absent.';
    }
  } else {
    available = false;
    unavailableCode = UNATTRIBUTED_LOOKUP_UNAVAILABLE;
    unavailableReason = 'The audit reader cannot enumerate events; this result is NOT claiming that unattributed activity is absent.';
  }
  if (!Array.isArray(events)) {
    events = [];
    available = false;
    unavailableCode = UNATTRIBUTED_LOOKUP_UNAVAILABLE;
    unavailableReason = 'The audit reader returned no enumerable events; this result is NOT claiming that unattributed activity is absent.';
  }

  const eventMs = event => {
    const flat = plain(event.event) ? event.event : event;
    const ms = Date.parse(flat.timestamp || '');
    return Number.isFinite(ms) ? ms : null;
  };
  const withMs = events.map(event => ({ event, ms: eventMs(event) })).filter(entry => entry.ms !== null);
  const oldestScannedMs = withMs.length ? Math.min(...withMs.map(entry => entry.ms)) : null;
  // A failed read supplies no population to measure. Do not turn the
  // placeholder empty array above into definite zero counts or a false
  // coverage answer: those values describe the ledger, while all we know is
  // that the ledger could not be observed.
  const windowCoverageComplete = available
    ? oldestScannedMs !== null && oldestScannedMs <= startMs
    : null;

  const inWindow = withMs.filter(entry => entry.ms >= startMs && entry.ms < endMs);
  const actionOf = event => (plain(event.event) ? event.event : event).action;
  const launchCount = available
    ? inWindow.filter(entry => actionOf(entry.event) === LAUNCH_ACTION).length
    : null;
  const signalCount = available
    ? inWindow.filter(entry => ACTIVITY_SIGNAL_ACTIONS.includes(actionOf(entry.event))).length
    : null;
  const unattributedEstimate = available ? Math.max(0, signalCount - launchCount) : null;

  return Object.freeze({
    windowStartMs: startMs,
    windowEndMs: endMs,
    available,
    unavailableCode,
    unavailableReason,
    scannedEventCount: available ? events.length : null,
    scanLimit,
    windowCoverageComplete,
    attributedLaunchCount: launchCount,
    activitySignalCount: signalCount,
    unattributedEstimate,
    method: 'bounded-tail-window-count-diff',
    signalActions: ACTIVITY_SIGNAL_ACTIONS,
    confidence: available ? (windowCoverageComplete ? 'low' : 'very-low') : 'unavailable',
    limitations: Object.freeze([
      ...(unavailableReason === null ? [] : [unavailableReason]),
      'window-level count diff only, not a per-event join: no shared id ties a signal event to a specific missing launch',
      'undercounts activity with no coordinator.run.claim signal at all (a directly opened provider CLI, a controller-spawned subagent that never claims a durable run)',
      'cannot attribute a tier to an unattributed signal: all codex tiers collapse into a single actor',
      !available
        ? 'window coverage was not measured because the audit ledger was unavailable'
        : windowCoverageComplete
        ? 'the scanned tail reached back to windowStartMs'
        : 'the scanned tail (audit.tail\'s own 200-event cap) did not reach back to windowStartMs; earlier in-window activity may be missing from both counts'
    ])
  });
}

module.exports = Object.freeze({
  getOperationalLaunch,
  LaunchRecordError,
  SCHEMA_VERSION, LAUNCH_ACTION, TIERS, DEFAULT_TIER, CAP_KINDS, TERMINAL_STATES,
  MAX_FAN_OUT, MAX_DEPTH, MIN_CAP_VALUE, MAX_CAP_VALUE, MIN_CAP_MS, MAX_CAP_MS,
  ACTIVITY_SIGNAL_ACTIONS,
  normalizeLaunchRequest, normalizeRecord, normalizeScopePacket, launchPayload, launchFromAuditEvent,
  buildDispatchBrief, renderDispatchBrief,
  executorPayloadHash,
  readLaunchScopeStore,
  createLaunch, projectLaunch, computeUnattributedWindow
});
