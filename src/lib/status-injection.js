'use strict';

// R1232: machine-generated context belongs in the prompt when, and only when,
// the owner has opted in.  This module is deliberately a reader/composer.  It
// changes no settings, writes no health state, and never returns credential or
// account-identity fields from the sources it joins.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_ROOT = path.resolve(__dirname, '..', '..');
const GLOBAL_SETTING_ID = 'agent.status_injection';
const NODE_OVERRIDES_SETTING_ID = 'agent.status_injection_overrides';
const NODE_KINDS = Object.freeze(['agent', 'lane', 'host']);
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DEFAULT_QUOTA_TIMEOUT_MS = 8_000;
const STATUS_BEGIN = '[TOOLSENABLED STATUS v1]';
const STATUS_END = '[/TOOLSENABLED STATUS]';
const SETTINGS_UNAVAILABLE = Symbol('SETTINGS_UNAVAILABLE');

// Retained exported constants for existing callers. The old aggregate file
// lacks an authenticated account-generation binding and is no longer read or
// written. A future shared snapshot cache must establish that binding first.
const QUOTA_OBSERVATION_LEAF = 'status-quota-observation.json';
const DEFAULT_QUOTA_REPROBE_INTERVAL_MS = 60_000;
const DEFAULT_QUOTA_OBSERVATION_MAX_AGE_MS = 15 * 60_000;

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function finitePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeIso(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? new Date(parsed).toISOString() : null;
}

function safeNodeId(value) {
  return typeof value === 'string' && NODE_ID.test(value) ? value : null;
}

function safeReason(value, fallback) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : fallback;
}

function nodeContext(input = {}, environment = process.env, osImpl = os) {
  return Object.freeze({
    agent: safeNodeId(input.agentId || environment.TOOLSENABLED_AGENT_ID),
    lane: safeNodeId(input.laneId || environment.TOOLSENABLED_LANE_ID),
    host: safeNodeId(input.hostId || environment.TOOLSENABLED_HOST_NODE_ID)
      || safeNodeId(typeof osImpl.hostname === 'function' ? osImpl.hostname() : null)
  });
}

function normalizeOverrides(raw) {
  if (raw === undefined) return { ok: true, entries: [] };
  if (!Array.isArray(raw)) return { ok: false, entries: [] };
  const seen = new Set();
  const entries = [];
  for (const entry of raw) {
    if (!plain(entry) || Object.keys(entry).some(key => !['kind', 'id', 'enabled'].includes(key))
      || !NODE_KINDS.includes(entry.kind) || !safeNodeId(entry.id) || typeof entry.enabled !== 'boolean') {
      return { ok: false, entries: [] };
    }
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) return { ok: false, entries: [] };
    seen.add(key);
    entries.push(Object.freeze({ kind: entry.kind, id: entry.id, enabled: entry.enabled }));
  }
  return { ok: true, entries };
}

// A missing global key is OFF even if an override-shaped value happens to be
// present.  This is the absence-read-as-consent regression guard: until the
// setting is registered and loaded successfully, no status collection occurs.
function resolveInjectionSetting(settings, nodes) {
  if (settings === SETTINGS_UNAVAILABLE) {
    return deepFreeze({ enabled: false, source: 'default', reason: 'SETTINGS_UNAVAILABLE' });
  }
  const values = plain(settings) && plain(settings.values) ? settings.values : null;
  if (!values || !Object.hasOwn(values, GLOBAL_SETTING_ID)) {
    return deepFreeze({ enabled: false, source: 'default', reason: 'SETTING_ABSENT' });
  }
  if (typeof values[GLOBAL_SETTING_ID] !== 'boolean') {
    return deepFreeze({ enabled: false, source: 'default', reason: 'SETTING_INVALID' });
  }
  const overrides = normalizeOverrides(values[NODE_OVERRIDES_SETTING_ID]);
  if (!overrides.ok) {
    return deepFreeze({ enabled: false, source: 'default', reason: 'NODE_OVERRIDES_INVALID' });
  }
  for (const kind of NODE_KINDS) {
    const id = nodes && nodes[kind];
    if (!id) continue;
    const match = overrides.entries.find(entry => entry.kind === kind && entry.id === id);
    if (match) return deepFreeze({ enabled: match.enabled, source: kind, reason: 'NODE_OVERRIDE' });
  }
  return deepFreeze({
    enabled: values[GLOBAL_SETTING_ID],
    source: 'global',
    reason: values[GLOBAL_SETTING_ID] ? 'GLOBAL_ENABLED' : 'GLOBAL_DISABLED'
  });
}

function loadResolvedSettings(environment, dependencies) {
  if (dependencies.settings !== undefined) return dependencies.settings;
  try {
    const loadSettings = dependencies.loadSettings || require('./settings').loadSettings;
    return loadSettings({ env: environment });
  } catch {
    // A failed settings read is not evidence that the opt-in key is absent.
    // Refuse collection, but preserve the read failure as a distinct decision.
    return SETTINGS_UNAVAILABLE;
  }
}

function unknown(reason) {
  return Object.freeze({ status: 'UNKNOWN', reason });
}

async function observed(reader, normalize, reason) {
  try {
    return normalize(await reader());
  } catch {
    return unknown(reason);
  }
}

function normalizeCpu(raw) {
  if (!plain(raw) || raw.status !== 'MEASURED' || !finitePercent(raw.utilizationPercent)) {
    return unknown(safeReason(raw?.reason, 'CPU_UNAVAILABLE'));
  }
  return Object.freeze({
    status: 'MEASURED',
    utilizationPercent: raw.utilizationPercent,
    coreCount: safeInteger(raw.coreCount),
    sampleIntervalMs: safeInteger(raw.sampleIntervalMs)
  });
}

function readMemory(osImpl = os) {
  const totalBytes = Number(osImpl.totalmem());
  const freeBytes = Number(osImpl.freemem());
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !Number.isSafeInteger(freeBytes)
    || freeBytes < 0 || freeBytes > totalBytes) return unknown('MEMORY_UNAVAILABLE');
  return Object.freeze({
    status: 'MEASURED',
    freeBytes,
    totalBytes,
    freePercent: Math.round((freeBytes / totalBytes) * 1_000) / 10
  });
}

function normalizeMemory(raw) {
  if (!plain(raw) || raw.status !== 'MEASURED' || !Number.isSafeInteger(raw.freeBytes)
    || !Number.isSafeInteger(raw.totalBytes) || raw.freeBytes < 0 || raw.totalBytes <= 0
    || raw.freeBytes > raw.totalBytes || !finitePercent(raw.freePercent)) {
    return unknown(safeReason(raw?.reason, 'MEMORY_UNAVAILABLE'));
  }
  return Object.freeze({
    status: 'MEASURED',
    freeBytes: raw.freeBytes,
    totalBytes: raw.totalBytes,
    freePercent: raw.freePercent
  });
}

function normalizeState(raw) {
  if (!plain(raw) || typeof raw.ok !== 'boolean') return unknown('STATE_STORE_UNAVAILABLE');
  return Object.freeze({
    status: raw.ok ? 'OK' : 'DEGRADED',
    ok: raw.ok,
    schemaVersion: safeInteger(raw.schemaVersion),
    expectedSchemaVersion: safeInteger(raw.expectedSchemaVersion),
    integrityOk: typeof raw.integrity?.ok === 'boolean' ? raw.integrity.ok : null
  });
}

function normalizeAudit(raw) {
  if (!plain(raw) || typeof raw.state !== 'string') return unknown('AUDIT_DURABILITY_UNAVAILABLE');
  const current = plain(raw.current) ? raw.current : {};
  return Object.freeze({
    status: 'MEASURED',
    state: ['ok', 'warn', 'critical', 'unknown', 'disabled'].includes(raw.state) ? raw.state : 'unknown',
    failingNow: typeof current.failing === 'boolean' ? current.failing : null,
    currentBreachCount: safeInteger(current.breachCount),
    pendingEmergency: safeInteger(raw.pendingEmergency),
    historicalBreachCount: safeInteger(raw.historical?.breachCount)
  });
}

// The canonical unclassified-ingress line shape, validated defensively before
// it is placed in a prompt. tools/owner-ingress-spool.js builds it from record
// counts and one age -- never from owner text -- but this module refuses to
// forward anything that does not match that exact shape.
const INGRESS_LINE = /^[0-9]{1,9} owner turns spooled and unclassified, oldest (?:none|unknown|[0-9]{1,9}(?:\.[0-9])?h)$/;

function ingressLine(count) {
  return `${count} owner turns spooled and unclassified, oldest unknown`;
}

function normalizeOwnerCapture(raw) {
  // Preferred source: tools/owner-ingress-spool.js getIngressStatus() ->
  // { count, records, line }. The line already folds in the fallback-file
  // records AND the oldest-unclassified age -- the two things a bare
  // owner-capture pending count could not see. Only the count and the pre-built,
  // shape-checked line are lifted; the `records` are NEVER copied, because each
  // one carries the owner's verbatim words and those must not enter a prompt.
  if (plain(raw) && Number.isSafeInteger(raw.count) && raw.count >= 0) {
    const line = typeof raw.line === 'string' && INGRESS_LINE.test(raw.line) ? raw.line : ingressLine(raw.count);
    return Object.freeze({ status: 'MEASURED', pendingCount: raw.count, line });
  }
  // Back-compat: a bare array or { pendingCount } still renders, with an
  // age-unknown line synthesized from the count alone.
  if (Array.isArray(raw)) {
    return Object.freeze({ status: 'MEASURED', pendingCount: raw.length, line: ingressLine(raw.length) });
  }
  if (plain(raw) && Number.isSafeInteger(raw.pendingCount) && raw.pendingCount >= 0) {
    return Object.freeze({ status: 'MEASURED', pendingCount: raw.pendingCount, line: ingressLine(raw.pendingCount) });
  }
  return unknown('OWNER_CAPTURE_BACKLOG_UNAVAILABLE');
}

function normalizeUsage(raw) {
  if (!plain(raw) || !plain(raw.coverage) || !plain(raw.totals)) return unknown('USAGE_SOURCE_UNAVAILABLE');
  const coverageState = ['complete', 'partial', 'empty'].includes(raw.coverage.state)
    ? raw.coverage.state : 'partial';
  return Object.freeze({
    status: 'MEASURED',
    coverageState,
    complete: raw.coverage.complete === true,
    scannedEvents: safeInteger(raw.coverage.scannedEvents),
    calls: safeInteger(raw.totals.calls),
    tokens: raw.totals.tokens === null ? null : safeInteger(raw.totals.tokens),
    measuredLowerBoundTokens: safeInteger(raw.totals.measuredLowerBoundTokens),
    latestTimestamp: safeIso(raw.window?.latestTimestamp)
  });
}

function normalizedCodexQuota(raw, unavailableReason = 'CODEX_QUOTA_UNAVAILABLE') {
  if (!plain(raw)) return unknown(unavailableReason);
  return Object.freeze({
    status: ['MEASURED', 'PARTIAL', 'UNKNOWN'].includes(raw.status) ? raw.status : 'UNKNOWN',
    reason: raw.status === 'UNKNOWN' ? safeReason(raw.reason, unavailableReason) : null,
    accountCount: safeInteger(raw.accountCount),
    usableAccounts: safeInteger(raw.usableAccounts),
    exhaustedAccounts: safeInteger(raw.exhaustedAccounts),
    unknownAccounts: safeInteger(raw.unknownAccounts),
    maxUsedPercent: raw.maxUsedPercent === null ? null : (finitePercent(raw.maxUsedPercent) ? raw.maxUsedPercent : null),
    minRemainingPercent: raw.minRemainingPercent === null ? null
      : (finitePercent(raw.minRemainingPercent) ? raw.minRemainingPercent : null),
    nearestReset: safeIso(raw.nearestReset)
  });
}

function normalizedClaudeQuota(raw) {
  if (plain(raw) && safeInteger(raw.accountCount) !== null) return normalizedCodexQuota(raw, 'CLAUDE_QUOTA_UNAVAILABLE');
  if (!plain(raw) || raw.status !== 'MEASURED' || !finitePercent(raw.usedPercent)) {
    return unknown(safeReason(raw?.reason, 'CLAUDE_QUOTA_UNAVAILABLE'));
  }
  return Object.freeze({
    status: 'MEASURED',
    usedPercent: raw.usedPercent,
    remainingPercent: Math.round((100 - raw.usedPercent) * 10) / 10,
    limitKind: typeof raw.limitKind === 'string' && NODE_ID.test(raw.limitKind) ? raw.limitKind : null,
    resetsAt: safeIso(raw.resetsAt),
    ageMs: safeInteger(raw.ageMs)
  });
}

function normalizeQuota(raw) {
  if (!plain(raw)) return unknown('QUOTA_SOURCE_UNAVAILABLE');
  const codex = normalizedCodexQuota(raw.codex);
  const claude = normalizedClaudeQuota(raw.claude);
  const measured = codex.status === 'MEASURED' || codex.status === 'PARTIAL' || claude.status === 'MEASURED' || claude.status === 'PARTIAL';
  return Object.freeze({
    status: measured ? 'MEASURED' : 'UNKNOWN',
    reason: measured ? null : safeReason(raw.reason, 'NO_QUOTA_MEASUREMENT'),
    /* HOW LONG AGO THE FIGURES BELOW WERE TAKEN, or null when the reader that
       produced them did not say. Null is rendered as UNKNOWN, never as 0: a
       reading with no stated age is not a fresh reading, and guessing that it
       is would be exactly the claim this field exists to stop. */
    observedAgeMs: safeInteger(raw.observedAgeMs),
    codex,
    claude
  });
}

// Explicit readers use the Accounts/Start registry, provider factories and
// bounded worker pool. They do not consult ambient SDK objects or caches.
async function readCanonicalQuota(options, dependencies, providers) {
  const { readAccountUsage } = require('./multi-account/rotation');
  const environment = options.environment || process.env;
  const registryPath = options.registryPath
    || (dependencies.accountRegistryPathImpl || require('./multi-account/registry-location').accountRegistryPath)();
  return (dependencies.readAccountUsageImpl || readAccountUsage)({
    registryPath,
    homeDir: options.homeDir ?? environment.USERPROFILE ?? environment.HOME ?? '',
    providers,
    accountBindings: options.accountBindings ?? null,
    // Preserve the explicit Codex reader's shorter request deadline while
    // retaining the canonical probe's awaited cleanup and hard upper bound.
    timeoutMs: options.timeoutMs ?? DEFAULT_QUOTA_TIMEOUT_MS,
    fsImpl: dependencies.fsImpl
  });
}

function aggregateProviderQuota(result, provider, accountBindings) {
  const reason = `${provider.toUpperCase()}_QUOTA_UNAVAILABLE`;
  if (result?.ok !== true || !Array.isArray(result.accounts)) return unknown(reason);
  if (accountBindings != null && !Array.isArray(accountBindings)) return unknown(reason);
  const bindings = accountBindings == null ? null : new Set(accountBindings);
  // Filter again at the projection boundary so no row from another provider
  // or from an unrequested binding can contribute to this aggregate.
  const rows = result.accounts.filter(row => plain(row) && row.provider === provider
    && (!bindings || bindings.has(row.allowanceBinding)));
  if (!rows.length) return unknown(reason);
  const measured = rows.filter(row => finitePercent(row.usedPercent));
  const resets = measured.map(row => safeIso(row.resetsAt)).filter(Boolean).sort();
  const maxUsedPercent = measured.length ? Math.max(...measured.map(row => row.usedPercent)) : null;
  return Object.freeze({
    status: measured.length === rows.length ? 'MEASURED' : measured.length ? 'PARTIAL' : 'UNKNOWN',
    reason: measured.length ? null : reason,
    accountCount: rows.length,
    usableAccounts: rows.filter(row => row.canServe === true).length,
    exhaustedAccounts: rows.filter(row => row.status === 'exhausted').length,
    unknownAccounts: rows.length - measured.length,
    maxUsedPercent,
    minRemainingPercent: maxUsedPercent === null ? null : 100 - maxUsedPercent,
    nearestReset: resets[0] || null
  });
}

async function readDefaultCodexQuota(options = {}, dependencies = {}) {
  try {
    return aggregateProviderQuota(await readCanonicalQuota(options, dependencies, ['codex']),
      'codex', options.accountBindings);
  } catch { return unknown('CODEX_QUOTA_UNAVAILABLE'); }
}

async function readDefaultClaudeQuota(options = {}, dependencies = {}) {
  try {
    return aggregateProviderQuota(await readCanonicalQuota(options, dependencies, ['claude']),
      'claude', options.accountBindings);
  } catch { return unknown('CLAUDE_QUOTA_UNAVAILABLE'); }
}

async function readDefaultQuota(options = {}, dependencies = {}) {
  let result;
  try { result = await readCanonicalQuota(options, dependencies, ['codex', 'claude']); }
  catch { result = null; }
  return Object.freeze({
    codex: aggregateProviderQuota(result, 'codex', options.accountBindings),
    claude: aggregateProviderQuota(result, 'claude', options.accountBindings)
  });
}

// SessionStart/SubagentStart has no current selected-account snapshot from
// the canonical Start path. An age-only aggregate cannot survive a sign-in
// replacement safely. Do not replay it or start an all-account provider sweep
// for each hook. This informational UNKNOWN neither blocks a start nor makes
// an authentication/exhaustion judgment. Callers that hold a current bound
// snapshot can supply the existing readQuota dependency without persistence.
async function readQuotaObservation() {
  return unknown('QUOTA_BOUND_SNAPSHOT_UNAVAILABLE');
}

function defaultReaders(environment, dependencies) {
  return {
    cpu: dependencies.readMachineLoad || require('./usage/machine-load').createMachineLoadReader(),
    memory: dependencies.readMemory || (() => readMemory(dependencies.osImpl || os)),
    state: dependencies.readStateHealth || (() => {
      const stateStore = require('./state-store');
      const health = stateStore.getStateStore().health();
      return { ...health, expectedSchemaVersion: stateStore.SCHEMA_VERSION };
    }),
    audit: dependencies.readAuditDurability || (() => require('./audit').durability()),
    ownerCapture: dependencies.readOwnerCapture || (() => {
      // The owner-ingress reader, not a bare owner-capture pending count: it
      // merges the primary spool with the fallback-file journal and computes the
      // oldest-unclassified age, so a fallback record (a turn captured when the
      // spool write itself failed) is never silently missing from the status.
      // reports/ is runtime state; on an install it is under the per-user
      // state root, so the spool status must look where the ledger is written.
      const ledgerFile = require('./runtime-state-root').statePath('reports', 'OWNER-REQUEST-LEDGER.json');
      return require(path.join(MODULE_ROOT, 'tools', 'owner-ingress-spool')).getIngressStatus({ ledgerFile });
    }),
    usage: dependencies.readUsage || (() => require(path.join(MODULE_ROOT, 'tools', 'usage-attribution-query')).readObservation({ limit: 200 })),
    quota: dependencies.readQuota || readQuotaObservation
  };
}

async function collectStatusSnapshot(options = {}, dependencies = {}) {
  const environment = dependencies.environment || options.environment || process.env;
  const clock = dependencies.clock || Date.now;
  const nowMs = Number(clock());
  const generatedAt = Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : new Date(0).toISOString();
  const nodes = nodeContext(options.input || options, environment, dependencies.osImpl || os);
  const settings = options.settings === undefined
    ? loadResolvedSettings(environment, dependencies)
    : options.settings;
  const setting = resolveInjectionSetting(settings, nodes);
  const base = { schemaVersion: 1, generatedAt, enabled: setting.enabled, setting };
  if (!setting.enabled) return deepFreeze({ ...base, observations: null });

  const readers = defaultReaders(environment, dependencies);
  const [cpu, memory, stateStore, auditDurability, ownerCapture, usage, quota] = await Promise.all([
    observed(readers.cpu, normalizeCpu, 'CPU_UNAVAILABLE'),
    observed(readers.memory, normalizeMemory, 'MEMORY_UNAVAILABLE'),
    observed(readers.state, normalizeState, 'STATE_STORE_UNAVAILABLE'),
    observed(readers.audit, normalizeAudit, 'AUDIT_DURABILITY_UNAVAILABLE'),
    observed(readers.ownerCapture, normalizeOwnerCapture, 'OWNER_CAPTURE_BACKLOG_UNAVAILABLE'),
    observed(readers.usage, normalizeUsage, 'USAGE_SOURCE_UNAVAILABLE'),
    observed(readers.quota, normalizeQuota, 'QUOTA_SOURCE_UNAVAILABLE')
  ]);
  return deepFreeze({
    ...base,
    observations: { cpu, memory, stateStore, auditDurability, ownerCapture, usage, quota }
  });
}

function gib(bytes) {
  return Number.isSafeInteger(bytes) ? `${(bytes / (1024 ** 3)).toFixed(1)}GiB` : '?';
}

function formatCpu(value) {
  return value.status === 'MEASURED'
    ? `${value.utilizationPercent}%/${value.coreCount ?? '?'}c/${value.sampleIntervalMs ?? '?'}ms`
    : `UNKNOWN(${value.reason})`;
}

function formatMemory(value) {
  return value.status === 'MEASURED'
    ? `${gib(value.freeBytes)}/${gib(value.totalBytes)} free (${value.freePercent}%)`
    : `UNKNOWN(${value.reason})`;
}

// A supplied snapshot with no observation age stays undated. The status
// renderer never declares freshness or account identity on the caller's behalf.
function formatProviderQuota(provider, value) {
  if (value.status === 'UNKNOWN') return `${provider}=UNKNOWN(${value.reason})`;
  const partial = value.status === 'PARTIAL';
  return `${provider}=${partial ? 'PARTIAL ' : ''}`
    + `${value.usableAccounts ?? '?'}/${value.accountCount ?? '?'} usable, `
    + `${value.minRemainingPercent ?? '?'}% ${partial ? 'measured-' : ''}min remaining`
    + `${value.nearestReset ? `, reset ${value.nearestReset}` : ''}`;
}

function formatQuota(value) {
  if (value.reason === 'QUOTA_BOUND_SNAPSHOT_UNAVAILABLE'
    || !plain(value.codex) || !plain(value.claude)) return `UNKNOWN(${value.reason})`;
  const observed = `observedAgeMs=${Number.isSafeInteger(value.observedAgeMs) ? value.observedAgeMs : 'UNKNOWN'}`;
  const codex = formatProviderQuota('codex', value.codex);
  const claude = safeInteger(value.claude.accountCount) !== null
    ? formatProviderQuota('claude', value.claude)
    : value.claude.status === 'MEASURED'
    ? `claude=${value.claude.remainingPercent}% remaining${value.claude.resetsAt ? `, reset ${value.claude.resetsAt}` : ''}`
      + `, sourceAgeMs=${Number.isSafeInteger(value.claude.ageMs) ? value.claude.ageMs : 'UNKNOWN'}`
    : `claude=UNKNOWN(${value.claude.reason})`;
  return `${observed}; ${codex}; ${claude}`;
}

function renderStatusBlock(snapshot) {
  if (!plain(snapshot) || snapshot.enabled !== true || !plain(snapshot.observations)) return '';
  const status = snapshot.observations;
  const state = status.stateStore.status === 'UNKNOWN'
    ? `UNKNOWN(${status.stateStore.reason})`
    : `${status.stateStore.status.toLowerCase()} schema=${status.stateStore.schemaVersion ?? '?'} expected=${status.stateStore.expectedSchemaVersion ?? '?'}`;
  const audit = status.auditDurability.status === 'UNKNOWN'
    ? `UNKNOWN(${status.auditDurability.reason})`
    : `${status.auditDurability.state} failingNow=${status.auditDurability.failingNow ?? '?'} currentBreaches=${status.auditDurability.currentBreachCount ?? '?'} emergency=${status.auditDurability.pendingEmergency ?? '?'}`;
  const capture = status.ownerCapture.status === 'MEASURED'
    ? status.ownerCapture.line : `UNKNOWN(${status.ownerCapture.reason})`;
  const usageTokens = status.usage.status === 'MEASURED'
    ? (status.usage.tokens === null
      ? `tokens>=${status.usage.measuredLowerBoundTokens ?? '?'}`
      : `tokens=${status.usage.tokens ?? '?'}`)
    : null;
  const usage = status.usage.status === 'MEASURED'
    ? `${status.usage.coverageState} ${usageTokens} calls=${status.usage.calls ?? '?'} tail=${status.usage.scannedEvents ?? '?'}`
    : `UNKNOWN(${status.usage.reason})`;
  return [
    `${STATUS_BEGIN} generated=${snapshot.generatedAt} setting=${snapshot.setting.source}`,
    `cpu=${formatCpu(status.cpu)}; memory=${formatMemory(status.memory)}`,
    `state=${state}; audit=${audit}`,
    `ownerIngress=${capture}`,
    `quota=${formatQuota(status.quota)}`,
    `usage=${usage}`,
    STATUS_END
  ].join('\n');
}

async function prependStatusInjection(text, options = {}, dependencies = {}) {
  const snapshot = await collectStatusSnapshot(options, dependencies);
  const block = renderStatusBlock(snapshot);
  return block ? `${block}\n\n${String(text)}` : String(text);
}

module.exports = Object.freeze({
  DEFAULT_QUOTA_OBSERVATION_MAX_AGE_MS,
  DEFAULT_QUOTA_REPROBE_INTERVAL_MS,
  DEFAULT_QUOTA_TIMEOUT_MS,
  GLOBAL_SETTING_ID,
  MODULE_ROOT,
  NODE_KINDS,
  NODE_OVERRIDES_SETTING_ID,
  QUOTA_OBSERVATION_LEAF,
  STATUS_BEGIN,
  STATUS_END,
  collectStatusSnapshot,
  nodeContext,
  normalizeOverrides,
  prependStatusInjection,
  readDefaultClaudeQuota,
  readDefaultCodexQuota,
  readDefaultQuota,
  readQuotaObservation,
  renderStatusBlock,
  resolveInjectionSetting
});
