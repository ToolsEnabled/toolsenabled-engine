'use strict';

// Controller projection is a browser egress boundary.  It consumes only
// already-authoritative local metadata and emits a closed, content-free shape.
// This module intentionally does not scrape CLI consoles, read browser state,
// or derive usage from prompt/response content.

const fs = require('node:fs');
const path = require('node:path');
const meter = require('./controller-metering');
const meterLedger = require('./controller-meter-ledger');
const savings = require('./controller-savings');
const costAttribution = require('./controller-cost-attribution');
const cliSessionUsage = require('./cli-session-usage');
const agentOrg = require('./agent-org');
const launchRecordLib = require('./controller-launch-record');
const launchOutcome = require('./launch-outcome');
const { canonicalHash } = require('../../schemas/generated/platform.identity');
const googleAccounts = require('./google-accounts');

const PROVIDERS = Object.freeze(['codex', 'claude', 'gemini', 'grok']);
const METER_PROVIDERS = Object.freeze([...PROVIDERS, 'local']);
// P11 wraps every coordinator.provider.* legacy call into one signed
// coordinator.audit.provider.operation event and hashes the raw provider id into
// an opaque subject (coordinator-audit-events.js opaqueReference('provider', id)).
// terminalProviderEvents() below must recognise that wrapped shape -- it
// previously scanned for the pre-wrap raw action strings, which stopped
// matching anything the moment P11 shipped, and reported zero provider
// operations from then on with no error, no warning, and a plausible-looking
// empty result.
const PROVIDER_OPAQUE_IDS = new Map(METER_PROVIDERS.map(id => [
  canonicalHash('coordinator.audit.subject.v1', { schemaVersion: 1, subjectType: 'provider', reference: id }),
  id
]));
const PROVIDER_OPERATION_ACTION = 'coordinator.audit.provider.operation';
const PROVIDER_TERMINAL_OPERATIONS = new Set(['provider.complete', 'provider.release_review']);
// Read WHEN NEEDED, never snapshotted at import. This is the twin of the
// controller-metering.js defect (R1531 w8): config/google-accounts.profile.json
// is gitignored user data, so freezing it at module load meant the dashboard
// showed the roster this process happened to load first -- an account the
// customer registered a minute ago simply did not exist until a restart, and a
// checkout without the profile projected a roster of nobody with no way to tell
// that apart from a genuinely empty installation. Both answers looked normal.
function accountAliases(declared) {
  return Object.freeze(Object.keys(configuredAccounts(declared).accounts));
}

// googleAccounts.load() defines the absent-profile case as an intentionally
// empty installation. If it throws, however, this boundary must not turn that
// failed read into the same definite empty roster: callers would otherwise be
// unable to distinguish "no accounts" from "accounts could not be read".
//
// `declared` lets a caller state the configuration explicitly instead of
// reading this machine's gitignored profile. ABSENCE IS NEVER CONSENT: omitting
// it reads the live configuration, and a `declared` value that is present but
// not an object is a caller error rather than a quiet "assume none" -- an
// empty roster is a claim, and a caller must make it on purpose.
function configuredAccounts(declared) {
  if (declared !== undefined && declared !== null) {
    if (!isObject(declared)) throw new TypeError('Declared Google account configuration must be an object.');
    return normalizeAccountConfig(declared);
  }
  return normalizeAccountConfig(googleAccounts.load() || {});
}

// An empty roster here is a real installation state, and every consumer below
// expresses it by having nothing to reserve rather than by naming a
// placeholder. The state is NAMED and carried on the error by
// controller-metering.js (ROSTER_STATES / error.accountRosterState), which is
// the module that judges an alias; this one deliberately holds no second copy
// of that vocabulary. Surfacing the roster state on the browser-safe contract
// so the dashboard can say "no accounts registered" instead of showing an
// unexplained empty list is a worthwhile follow-up and now a one-liner -- it is
// left out here because widening the browser egress contract is not this
// change, and a field nobody reads is the defect this codebase already has too
// much of.
function normalizeAccountConfig(value) {
  const role = name => (typeof value[name] === 'string' && value[name] ? value[name] : null);
  const accounts = isObject(value.accounts) ? value.accounts : {};
  return {
    accounts,
    defaultAccount: role('defaultAccount'),
    duoAccount: role('duoAccount'),
    vertexSeatAccount: role('vertexSeatAccount'),
    vertexApiAccount: role('vertexApiAccount')
  };
}
// These are distinct Gemini consumption lanes, not interchangeable account
// aliases. Keep them visible even before a signed meter record exists so the
// dashboard never silently folds a Vertex seat or the expiring API-credit pool
// into the subscription CLI row.
//
// Every alias is read from the account profile rather than duplicated as a
// literal here: subscription-cli is this installation's configured default
// Google account (the same identity the durable-run broker attributes Gemini
// subscription usage to), and vertex/api are its configured Vertex-seat and
// Vertex API-credit accounts. A role with nothing configured contributes no
// reserved row rather than a placeholder naming nobody.
//
// These three come from googleAccounts rather than from the Vertex provider
// modules' exported ACCOUNT_ALIAS constants, which is where two of them used
// to be read from. That import was a controller -> providers.gateway edge
// (tools/package-check.js:264 -- any domain-to-domain require is one), and
// this module is a browser egress boundary that has no other business knowing
// a provider's internals. Which account pays for a lane is configuration; the
// provider's own binding checks are its own. tests/controller/
// gemini-account-lane-binding.js fails if a configured lane names an
// account the corresponding provider would not actually use, so the two
// cannot drift apart silently now that neither reads the other.
function reservedGeminiAccountLanes(declared) {
  const { defaultAccount, vertexSeatAccount, vertexApiAccount } = configuredAccounts(declared);
  return Object.freeze([
    ...(defaultAccount ? [Object.freeze({ accountAlias: defaultAccount, lane: 'subscription-cli' })] : []),
    ...(vertexSeatAccount ? [Object.freeze({ accountAlias: vertexSeatAccount, lane: 'vertex' })] : []),
    ...(vertexApiAccount ? [Object.freeze({ accountAlias: vertexApiAccount, lane: 'api' })] : [])
  ]);
}
// The configured Duo/institutional account remains a named account in the
// browser-safe contract even though it has no declared Gemini lane: it still
// needs an explicit empty row rather than disappearing when it has no
// durable evidence.
function reservedAccountLanes(declared) {
  const { duoAccount } = configuredAccounts(declared);
  return Object.freeze([
    ...reservedGeminiAccountLanes(declared),
    ...(duoAccount ? [Object.freeze({ accountAlias: duoAccount, lane: 'unattributed' })] : [])
  ]);
}
const AUDIT_HASH = /^[a-f0-9]{64}$/;
const AUDIT_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const FOCUS_PROJECTS = Object.freeze([
  Object.freeze({ id: 'all', label: 'All registered projects' }),
  Object.freeze({ id: 'toolsenabled', label: 'ToolsEnabled' })
]);
const FOCUS_IDS = new Set(FOCUS_PROJECTS.map(project => project.id));
const TERMINAL_OUTCOMES = new Set(['success', 'failed', 'timeout', 'cancelled', 'empty_response', 'blocked']);
const RUN_STATE = Object.freeze({
  queued: 'queued', leased: 'queued', running: 'working', retry_wait: 'blocked',
  // The browser-safe activity contract has no literal `failed` or `uncertain`
  // state. `rejected` is its terminal non-success state, while `blocked` means
  // the durable outcome is not known or is awaiting a bounded handoff.
  uncertain: 'blocked', succeeded: 'completed', failed: 'rejected', cancelled: 'cancelled'
});
const PROVIDER_STATE = new Set(['disabled', 'unverified', 'ready', 'verification_failed', 'sign_in_required', 'rate_limited', 'billing_required']);
const CWS_IDENTITY_STATE = new Set(['dashboard_reached', 'password_required', 'mfa_or_passkey_required', 'captcha_required', 'configured_account_unavailable', 'configured_account_mismatch', 'identity_transition_pending']);
const MAX_DATE_MS = 8_640_000_000_000_000;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeInteger(value, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : fallback;
}

function timestamp(value, fallbackMs) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  const selected = Number.isSafeInteger(ms) && ms >= 0 ? ms : fallbackMs;
  return new Date(selected).toISOString();
}

function nullableTimestamp(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isSafeInteger(ms) && ms >= 0 ? new Date(ms).toISOString() : null;
}

function providerOutcome(value) {
  return typeof value === 'string' && TERMINAL_OUTCOMES.has(value) ? value : null;
}

function mapRunState(value) {
  return typeof value === 'string' && RUN_STATE[value] ? RUN_STATE[value] : 'blocked';
}

function runTaskKind(value) {
  if (value === 'running' || value === 'leased') return 'implementation';
  if (value === 'succeeded') return 'validation';
  if (value === 'queued') return 'planning';
  return 'review';
}

// Durable-run lifecycle states and the browser-safe activity-state enum are
// deliberately not identical.  In particular, `uncertain` is terminal in the
// task store: it means the worker did not claim a result and must not keep the
// dashboard's worker lane or `works_on` edges alive.  The summary is a
// content-free report boundary: it uses only fixed state/error codes and
// counts, never task ids, objective text, checkpoint text, or error messages.
function durableRunOutcomes(runs) {
  const summary = {
    source: 'durable-run-lifecycle', total: 0, active: 0, completed: 0,
    failed: 0, cancelled: 0, needsHelp: 0, outcomeUnknown: 0
  };
  for (const run of runs) {
    summary.total += 1;
    switch (run?.status) {
      case 'queued':
      case 'leased':
      case 'running':
      case 'retry_wait':
        summary.active += 1;
        break;
      case 'succeeded':
        summary.completed += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
      case 'cancelled':
        summary.cancelled += 1;
        break;
      case 'uncertain':
        if (run?.error?.code === 'HELP_REQUIRED') summary.needsHelp += 1;
        else summary.outcomeUnknown += 1;
        break;
      default:
        // A malformed or future state must never disappear into a clean zero.
        // It has no durable success/failure outcome, so report it as unknown.
        summary.outcomeUnknown += 1;
        break;
    }
  }
  return Object.freeze(summary);
}

// Provider meters are accumulated in a MUTABLE, all-numeric internal shape and
// only turned into the wire shape by finalizeProviderMeter() at the very end.
// The two shapes differ on purpose:
//
//  - internally, a counter is a number and a source set says who contributed;
//  - on the wire, a column with NO contributing source is null, not 0.
//
// That difference is the whole point of this change. `0 operations` used to be
// rendered identically for "this provider genuinely did no work" and "nothing
// on this machine has ever measured this provider", and the owner was reading
// the second as the first. Codex and Claude Code are separate processes talking
// straight to their APIs, so before the local-session ingest existed the ledger
// held literally nothing about them -- and the dashboard confidently reported
// zero. An unmeasured column must read as unmeasured.
function emptyProviderMeter(provider) {
  return {
    provider,
    operationCount: 0,
    completedCount: 0,
    failedCount: 0,
    timeoutCount: 0,
    cancelledCount: 0,
    blockedCount: 0,
    durationMs: 0,
    outputBytes: 0,
    measuredEvidenceCount: 0,
    coverage: null,
    reportedTokenCount: null,
    deterministicPacketTokenCount: null,
    costMicros: null,
    tokenMeterState: 'unavailable',
    costMeterState: 'unavailable',
    // Which measurement sources actually contributed to each column family.
    // Empty set === nothing measured this === the column is unavailable.
    operationSources: new Set(),
    durationSources: new Set(),
    outputBytesSources: new Set(),
    // Set when two sources both cover a provider but disjointness cannot be
    // proven, i.e. the same real API call may appear in both. Adding them would
    // publish a number that is quietly too large, so the columns go unavailable
    // with that exact reason instead.
    overlapping: false
  };
}

// The vocabulary for "how was this column sourced", shared by the operation,
// duration and output-byte columns so a reader learns it once.
//  - 'ledger-lifecycle'      broker-launched runs metered by the durable-run broker
//  - 'local-session-record'  the CLI's own locally-persisted usage records
//  - 'partial-mixed-source'  both contributed to this figure
//  - 'not-instrumented'      nothing measured it; the column is null
const OPERATION_SOURCE_LEDGER = 'ledger-lifecycle';
const OPERATION_SOURCE_LOCAL = 'local-session-record';
const NOT_INSTRUMENTED = 'not-instrumented';
const REASON_NO_SOURCE = 'no-instrumented-source-in-window';
const REASON_NO_DURATION = 'source-records-no-duration';
const REASON_NO_OUTPUT_BYTES = 'source-records-no-output-bytes';
const REASON_OVERLAPPING = 'overlapping-measurement-sources';

function columnState(sources) {
  if (sources.size === 0) return NOT_INSTRUMENTED;
  if (sources.size === 1) return [...sources][0];
  return 'partial-mixed-source';
}

// One column family: either a real measured value with a stated source, or null
// with a stated reason. There is deliberately no third option -- no zero
// default, no "probably fine" fallback.
function column(sources, values, unavailableReason, overlapping) {
  if (overlapping) return { state: NOT_INSTRUMENTED, reason: REASON_OVERLAPPING, values: values.map(() => null) };
  if (sources.size === 0) return { state: NOT_INSTRUMENTED, reason: unavailableReason, values: values.map(() => null) };
  return { state: columnState(sources), reason: null, values };
}

function finalizeProviderMeter(row) {
  const operations = column(
    row.operationSources,
    [row.operationCount, row.completedCount, row.failedCount, row.timeoutCount, row.cancelledCount, row.blockedCount],
    REASON_NO_SOURCE, row.overlapping
  );
  const duration = column(
    row.durationSources, [row.durationMs],
    row.operationSources.size === 0 ? REASON_NO_SOURCE : REASON_NO_DURATION, row.overlapping
  );
  const outputBytes = column(
    row.outputBytesSources, [row.outputBytes],
    row.operationSources.size === 0 ? REASON_NO_SOURCE : REASON_NO_OUTPUT_BYTES, row.overlapping
  );
  const tokensSuppressed = row.overlapping;
  return {
    provider: row.provider,
    operationCount: operations.values[0],
    completedCount: operations.values[1],
    failedCount: operations.values[2],
    timeoutCount: operations.values[3],
    cancelledCount: operations.values[4],
    blockedCount: operations.values[5],
    durationMs: duration.values[0],
    outputBytes: outputBytes.values[0],
    measuredEvidenceCount: row.measuredEvidenceCount,
    coverage: row.coverage,
    reportedTokenCount: tokensSuppressed ? null : row.reportedTokenCount,
    deterministicPacketTokenCount: tokensSuppressed ? null : row.deterministicPacketTokenCount,
    costMicros: tokensSuppressed ? null : row.costMicros,
    tokenMeterState: tokensSuppressed ? 'unavailable' : row.tokenMeterState,
    costMeterState: tokensSuppressed ? 'unavailable' : row.costMeterState,
    operationMeterState: operations.state,
    operationUnavailableReason: operations.reason,
    durationMeterState: duration.state,
    durationUnavailableReason: duration.reason,
    outputBytesMeterState: outputBytes.state,
    outputBytesUnavailableReason: outputBytes.reason
  };
}

function terminalProviderEvents(auditEvents, nowMs) {
  const meters = Object.fromEntries(METER_PROVIDERS.map(provider => [provider, emptyProviderMeter(provider)]));
  const events = [];
  // Every controller.meter.record/controller.meter.tool_batch MeterRecord for
  // a provider lane is REQUIRED (by recordMeter()'s assertParentAudit()) to
  // point at exactly one already-counted coordinator.audit.provider.operation
  // event via (auditSequence, auditEventHash). When that parent event is
  // still inside the same bounded tail window, withMechanicalProviderMeters()
  // below must not re-add it -- doing so double-counts the identical
  // real-world operation once from the raw terminal scan and once from its
  // derived meter record. Recording the raw ledger sequence of every event
  // counted here lets the mechanical side filter itself down to only the
  // meter records whose parent has scrolled OUTSIDE this window, which is
  // the one case that legitimately needs the extra coverage.
  const countedAuditSequences = new Set();
  for (const candidate of Array.isArray(auditEvents) ? auditEvents.slice(-200) : []) {
    if (!isObject(candidate) || !isObject(candidate.details)) continue;
    if (candidate.action !== PROVIDER_OPERATION_ACTION) continue;
    const summary = candidate.details.summary;
    if (!isObject(summary) || !PROVIDER_TERMINAL_OPERATIONS.has(summary.operation)) continue;
    const subjectOpaqueId = candidate.details.subject && candidate.details.subject.opaqueId;
    const provider = typeof subjectOpaqueId === 'string' ? PROVIDER_OPAQUE_IDS.get(subjectOpaqueId) : undefined;
    const outcome = providerOutcome(candidate.details.outcome);
    if (!provider || !outcome) continue;
    const meter = meters[provider];
    meter.operationCount += 1;
    meter.operationSources.add(OPERATION_SOURCE_LEDGER);
    // A field the signed event did not carry is not a zero. Only an actually
    // present integer marks the column as measured.
    if (Number.isSafeInteger(summary.durationMs)) {
      meter.durationMs += safeInteger(summary.durationMs, 0, 3_600_000);
      meter.durationSources.add(OPERATION_SOURCE_LEDGER);
    }
    if (Number.isSafeInteger(summary.outputBytes)) {
      meter.outputBytes += safeInteger(summary.outputBytes, 0, 48 * 1024);
      meter.outputBytesSources.add(OPERATION_SOURCE_LEDGER);
    }
    if (outcome === 'success') meter.completedCount += 1;
    if (outcome === 'failed' || outcome === 'empty_response') meter.failedCount += 1;
    if (outcome === 'timeout') meter.timeoutCount += 1;
    if (outcome === 'cancelled') meter.cancelledCount += 1;
    if (outcome === 'blocked') meter.blockedCount += 1;
    if (Number.isSafeInteger(candidate.sequence)) countedAuditSequences.add(candidate.sequence);
    events.push({
      eventType: outcome === 'success' ? 'acceptance_state' : 'source_state',
      sequence: safeInteger(candidate.sequence, events.length + 1, Number.MAX_SAFE_INTEGER),
      occurredAt: timestamp(candidate.timestamp, nowMs),
      context: outcome === 'success'
        ? { template: 'acceptance_state', data: { acceptance: 'pending' } }
        : { template: 'source_state', data: { evidenceKind: 'tool', evidenceCount: 1, freshness: 'unverified' } }
    });
  }
  return { meters, events: events.slice(-128), countedAuditSequences };
}

function providerControls(value, defaultGoogleAlias, declaredAccounts) {
  const aliases = accountAliases(declaredAccounts);
  const rows = Array.isArray(value?.providers) ? value.providers : [];
  const byId = new Map(rows.filter(isObject).map(row => [row.id, row]));
  return PROVIDERS.map(id => {
    const row = byId.get(id) || {};
    // `enabled` is the saved routing/control intent, not a live availability
    // probe. A cached "ready" check does not become "disabled" merely because
    // the saved toggle is off, and an absent cache row remains honestly
    // unverified rather than a fabricated negative availability result.
    const status = PROVIDER_STATE.has(row.status) ? row.status : 'unverified';
    return {
      provider: id,
      enabled: row.enabled === true,
      status,
      verifiedAt: nullableTimestamp(row.verifiedAt),
      lastCheckedAt: nullableTimestamp(row.lastCheckedAt),
      accountAlias: id === 'gemini' && aliases.includes(defaultGoogleAlias) ? defaultGoogleAlias : 'unattributed'
    };
  });
}

function sourceQuality(row) {
  if (row.sourceTypeCounts['provider-reported'] === row.recordCount) return 'provider-reported';
  if (row.sourceTypeCounts['deterministic-tokenizer'] === row.recordCount) return 'deterministic-tokenizer';
  if (row.sourceTypeCounts.unavailable === row.recordCount) return 'unavailable';
  return 'partial-mixed-source';
}

function emptyAccountLane(accountAlias, lane) {
  return {
    accountAlias,
    lane,
    meterState: 'unavailable', evidenceCount: 0, sourceQuality: 'unavailable',
    operationCount: 0, reportedTokenCount: null, deterministicPacketTokenCount: null, billableUnits: null, costMicros: null,
    window: { freshness: 'unavailable', completeness: 'unavailable', startedAt: null, endedAt: null }
  };
}

function accountLanes(meterRows, declaredAccounts) {
  const rows = Array.isArray(meterRows) ? meterRows : [];
  const output = [];
  // One roster read for the whole projection of these lanes, so the reserved
  // rows and the extra-evidence rows below cannot disagree about who exists.
  const config = configuredAccounts(declaredAccounts);
  const reservedLanes = reservedAccountLanes(config);
  const aliases = accountAliases(config);
  const reservedKeys = new Set(reservedLanes.map(item => `${item.accountAlias}\0${item.lane}`));
  for (const reserved of reservedLanes) {
    const matched = rows.filter(row => row.accountAlias === reserved.accountAlias && row.lane === reserved.lane);
    if (!matched.length) { output.push(emptyAccountLane(reserved.accountAlias, reserved.lane)); continue; }
    for (const row of matched) {
      output.push({
        accountAlias: reserved.accountAlias, lane: reserved.lane,
        meterState: row.sourceTypeCounts.unavailable === row.recordCount ? 'unavailable' : row.window.completeness,
        evidenceCount: row.recordCount, sourceQuality: sourceQuality(row), operationCount: row.recordCount,
        reportedTokenCount: row.reportedTokenEvidenceCount ? row.reportedTokens : null,
        deterministicPacketTokenCount: row.deterministicTokenEvidenceCount ? row.deterministicTokens : null,
        billableUnits: row.billableUnitEvidenceCount ? row.billableUnits : null,
        costMicros: row.costMicrosEvidenceCount ? row.costMicros : null,
        window: row.window
      });
    }
  }
  // Preserve any additional account/lane evidence rather than dropping it.
  // It cannot replace one of the reserved identities above, which remain their
  // own explicit rows even when the incoming evidence uses another lane.
  for (const row of rows.filter(item => aliases.includes(item.accountAlias) && !reservedKeys.has(`${item.accountAlias}\0${item.lane}`))) {
    output.push({
      accountAlias: row.accountAlias, lane: row.lane,
      meterState: row.sourceTypeCounts.unavailable === row.recordCount ? 'unavailable' : row.window.completeness,
      evidenceCount: row.recordCount, sourceQuality: sourceQuality(row), operationCount: row.recordCount,
      reportedTokenCount: row.reportedTokenEvidenceCount ? row.reportedTokens : null,
      deterministicPacketTokenCount: row.deterministicTokenEvidenceCount ? row.deterministicTokens : null,
      billableUnits: row.billableUnitEvidenceCount ? row.billableUnits : null,
      costMicros: row.costMicrosEvidenceCount ? row.costMicros : null,
      window: row.window
    });
  }
  // A local model has no Google/account lane. It appears only when a signed
  // local MeterRecord exists and is labelled as local compute by the UI;
  // unrelated unattributed provider records remain intentionally undisplayed.
  for (const row of rows.filter(item => item.accountAlias === 'unattributed' && item.provider === 'local' && item.lane === 'local')) {
    output.push({
      accountAlias: 'unattributed', lane: 'local',
      meterState: row.sourceTypeCounts.unavailable === row.recordCount ? 'unavailable' : row.window.completeness,
      evidenceCount: row.recordCount, sourceQuality: sourceQuality(row), operationCount: row.recordCount,
      reportedTokenCount: row.reportedTokenEvidenceCount ? row.reportedTokens : null,
      deterministicPacketTokenCount: row.deterministicTokenEvidenceCount ? row.deterministicTokens : null,
      billableUnits: row.billableUnitEvidenceCount ? row.billableUnits : null,
      costMicros: row.costMicrosEvidenceCount ? row.costMicros : null,
      window: row.window
    });
  }
  return output;
}

// A meter-materialization failure (see the broker's recordLocalPhaseMeter
// and completeSubscriptionPhase) writes a best-effort, value-free durability
// marker through the same P11 semantic adapter used for every other coordinator
// audit event: legacyAuditRecord('coordinator.meter.failed', <provider>,
// {outcome: <safe-code>}) lands as a 'coordinator.audit.resource.decision' event
// whose summary.operation is 'meter.failed' and whose outcome is the
// lowercase, hyphenated gate/audit code -- never a message, stack, or any
// request/response content. This lets an otherwise-bare "unavailable" state
// say *why* instead of stopping at a generic label.
const METER_FAILURE_ACTION = 'coordinator.audit.resource.decision';
const METER_FAILURE_OPERATION = 'meter.failed';

function meterFailureReason(auditEvents) {
  const events = Array.isArray(auditEvents) ? auditEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (!isObject(candidate) || candidate.action !== METER_FAILURE_ACTION || !isObject(candidate.details)) continue;
    const summary = candidate.details.summary;
    if (isObject(summary) && summary.operation === METER_FAILURE_OPERATION && typeof candidate.details.outcome === 'string') {
      return candidate.details.outcome;
    }
  }
  return null;
}

// Three genuinely different signals, kept distinct rather than collapsed
// into one flag:
//  - 'unavailable-no-durable-meter': no meter records exist at all (the
//    honest empty state -- nothing was ever written, or the durable ledger
//    has nothing meter-shaped in this window).
//  - 'partial-durable-meter': some records exist and were read, but at
//    least one record (or, for a batch event, the whole malformed batch
//    container) could not be parsed. skippedCount carries how many were
//    dropped; the good records that WERE read are still returned and used.
//  - 'verified-durable': every meter record in the window was read cleanly.
// 'invalid' is reserved for a structural ledger problem that is not a
// per-record parse failure -- e.g. a duplicate recordHash across events --
// where isolating a single bad record cannot recover a trustworthy read.
function mechanicalMeters(auditEvents, verifiedAudit, accountRoster) {
  if (!verifiedAudit) return { state: 'unverified', records: [], rows: [], invalid: false, reason: null, skippedCount: 0 };
  try {
    const { records, skippedCount } = meterLedger.collectMeterRecords(auditEvents, { accountRoster });
    const state = skippedCount > 0
      ? 'partial-durable-meter'
      : records.length ? 'verified-durable' : 'unavailable-no-durable-meter';
    return {
      state, records, rows: meter.aggregate(records, { accountRoster }), invalid: false, skippedCount,
      reason: records.length === 0 && skippedCount === 0 ? meterFailureReason(auditEvents) : null
    };
  } catch {
    // The audit itself remains canonical, but a structural ledger problem
    // (e.g. a duplicate meter observation) cannot be surfaced as usage.
    // Treat it as a disconnected source rather than guessing or leaking the
    // underlying record. This is distinct from -- and rarer than -- a
    // per-record parse failure, which is isolated above and never reaches
    // this catch.
    return { state: 'invalid', records: [], rows: [], invalid: true, reason: null, skippedCount: 0 };
  }
}

// countRows and evidenceRows are deliberately different aggregations of the
// same underlying mechanical meter records:
//  - countRows excludes any record whose parent coordinator.audit.provider.
//    operation event is already independently counted by
//    terminalProviderEvents() (see that function's comment). It drives
//    operationCount/completedCount/failedCount/timeoutCount/cancelledCount/
//    blockedCount/durationMs, so a real operation is never counted twice.
//  - evidenceRows is the FULL, undeduplicated aggregation. Token/cost/
//    evidence fields (measuredEvidenceCount, reportedTokenCount,
//    deterministicPacketTokenCount, costMicros, tokenMeterState,
//    costMeterState) have no equivalent in the raw terminal scan -- it never
//    reports tokens or cost -- so there is nothing to double-count there,
//    and a meter record's token/cost evidence must not be discarded just
//    because its parent operation happened to also still be in-window.
function withMechanicalProviderMeters(providerMeters, countRows, evidenceRows) {
  const output = providerMeters.map(row => ({
    ...row,
    operationSources: new Set(row.operationSources),
    durationSources: new Set(row.durationSources),
    outputBytesSources: new Set(row.outputBytesSources)
  }));
  for (const row of countRows) {
    const target = output.find(candidate => candidate.provider === row.provider);
    if (!target) continue;
    target.operationCount += row.recordCount;
    target.operationSources.add(OPERATION_SOURCE_LEDGER);
    target.completedCount += row.terminalStatusCounts.success || 0;
    target.failedCount += (row.terminalStatusCounts.failed || 0) + (row.terminalStatusCounts.unknown || 0);
    target.timeoutCount += row.terminalStatusCounts.timeout || 0;
    target.cancelledCount += row.terminalStatusCounts.cancelled || 0;
    target.blockedCount += row.terminalStatusCounts.blocked || 0;
    target.durationMs += row.elapsedMs;
    target.durationSources.add(OPERATION_SOURCE_LEDGER);
  }
  for (const row of evidenceRows) {
    const target = output.find(candidate => candidate.provider === row.provider);
    if (!target) continue;
    const priorMeasuredEvidenceCount = target.measuredEvidenceCount || 0;
    const priorCostEvidence = target.costMicros !== null;
    target.measuredEvidenceCount = (target.measuredEvidenceCount || 0) + row.recordCount;
    if (row.reportedTokenEvidenceCount) target.reportedTokenCount = (target.reportedTokenCount || 0) + row.reportedTokens;
    if (row.deterministicTokenEvidenceCount) target.deterministicPacketTokenCount = (target.deterministicPacketTokenCount || 0) + row.deterministicTokens;
    if (row.costMicrosEvidenceCount) target.costMicros = (target.costMicros || 0) + row.costMicros;
    const rowTokenMeterState = sourceQuality(row);
    target.tokenMeterState = priorMeasuredEvidenceCount === 0
      ? rowTokenMeterState
      : target.tokenMeterState === rowTokenMeterState ? rowTokenMeterState : 'partial-mixed-source';
    const completeCostCoverage = row.costMicrosEvidenceCount === row.recordCount && row.window.completeness === 'complete';
    if (row.costMicrosEvidenceCount) {
      target.costMeterState = priorCostEvidence
        ? (target.costMeterState === 'complete' && completeCostCoverage ? 'complete' : 'partial')
        : (priorMeasuredEvidenceCount === 0 && completeCostCoverage ? 'complete' : 'partial');
    } else if (priorCostEvidence) {
      target.costMeterState = 'partial';
    }
  }
  return output;
}

// --- locally-recorded CLI usage (Defect 2) ----------------------------------
//
// Claude Code and Codex CLI never touch the durable-run broker, so the broker
// -- the only writer of metered provider operations -- never sees them. Both
// CLIs do persist the provider's OWN reported usage numbers locally, and
// cli-session-usage-ingest.js reads exactly those numbers and writes one signed,
// content-free `controller.cli_session.usage` observation per provider per run.
// This reads those observations back out of the same bounded audit tail as
// everything else on this page.
//
// Every observation in the window is summed, deduplicated by observationId: the
// id is derived from the byte ranges the ingest consumed, so a re-ingest of an
// already-credited range (cursor write failed, ledger write did not) contributes
// nothing rather than doubling the figure.
//
// A zero-valued observation is meaningful and is NOT discarded: it is the only
// evidence that a measurement source looked at this provider and honestly found
// no activity. Without it, "measured zero" and "never measured" collapse back
// into the same rendered `0` this change exists to separate.
function cliSessionUsageByProvider(auditEvents) {
  const byProvider = new Map();
  const seenObservations = new Set();
  for (const candidate of Array.isArray(auditEvents) ? auditEvents.slice(-200) : []) {
    const observation = cliSessionUsage.usageFromAuditEvent(candidate);
    if (!observation) continue;
    if (seenObservations.has(observation.observationId)) continue;
    seenObservations.add(observation.observationId);
    const entry = byProvider.get(observation.provider) || {
      operationCount: 0, reportedTokens: null, durationMs: null, outputBytes: null,
      evidenceCount: 0, brokerExcluded: true, coverage: 'complete'
    };
    entry.operationCount += observation.operationCount;
    if (observation.reportedTokens !== null) entry.reportedTokens = (entry.reportedTokens || 0) + observation.reportedTokens;
    if (observation.durationMs !== null) entry.durationMs = (entry.durationMs || 0) + observation.durationMs;
    if (observation.outputBytes !== null) entry.outputBytes = (entry.outputBytes || 0) + observation.outputBytes;
    entry.evidenceCount += 1;
    if (observation.brokerExcluded !== true) entry.brokerExcluded = false;
    if (observation.coverage !== 'complete') entry.coverage = 'partial';
    byProvider.set(observation.provider, entry);
  }
  return byProvider;
}

// Merges locally-recorded CLI usage into the provider meters, keeping its
// provenance distinguishable from a broker-lifecycle figure at every step.
//
// The one thing this refuses to do is add two sources it cannot prove disjoint.
// A broker-launched Claude run writes a transcript into the same directory the
// ingest reads, so the ingest excludes those records by `entrypoint` and can
// therefore claim disjointness. Codex's rollout format carries no equivalent
// discriminator, so if broker-lifecycle evidence for Codex ever appears in the
// same window as an ingest observation, the columns go unavailable with
// 'overlapping-measurement-sources' rather than publishing a sum that might
// count the same API call twice. An honest unavailable is the correct outcome
// there; a plausible-looking wrong number is not.
function withCliSessionUsage(providerMeters, usageByProvider) {
  return providerMeters.map(row => {
    const usage = usageByProvider.get(row.provider);
    if (!usage) return row;
    if (usage.brokerExcluded !== true && row.operationSources.has(OPERATION_SOURCE_LEDGER)) {
      return { ...row, overlapping: true, coverage: usage.coverage };
    }
    const target = {
      ...row,
      operationSources: new Set(row.operationSources),
      durationSources: new Set(row.durationSources),
      outputBytesSources: new Set(row.outputBytesSources)
    };
    target.coverage = usage.coverage;
    target.operationCount += usage.operationCount;
    // A recorded API response IS a completed provider operation; neither CLI
    // records a failed/timed-out/cancelled call, so those counters are left
    // exactly where the ledger put them rather than being inflated.
    target.completedCount += usage.operationCount;
    target.operationSources.add(OPERATION_SOURCE_LOCAL);
    if (usage.durationMs !== null) {
      target.durationMs += usage.durationMs;
      target.durationSources.add(OPERATION_SOURCE_LOCAL);
    }
    if (usage.outputBytes !== null) {
      target.outputBytes += usage.outputBytes;
      target.outputBytesSources.add(OPERATION_SOURCE_LOCAL);
    }
    if (usage.reportedTokens !== null) {
      const hadTokenEvidence = target.tokenMeterState !== 'unavailable';
      target.reportedTokenCount = (target.reportedTokenCount || 0) + usage.reportedTokens;
      target.tokenMeterState = hadTokenEvidence ? 'partial-mixed-source' : OPERATION_SOURCE_LOCAL;
    }
    target.measuredEvidenceCount += usage.evidenceCount;
    return target;
  });
}

function focusControl(value) {
  return {
    selected: typeof value === 'string' && FOCUS_IDS.has(value) ? value : 'all',
    options: FOCUS_PROJECTS
  };
}

function cwsIdentityControl(auditEvents, defaultGoogleAlias, declaredAccounts) {
  const requiredAccountAlias = accountAliases(declaredAccounts).includes(defaultGoogleAlias) ? defaultGoogleAlias : 'unattributed';
  const rows = Array.isArray(auditEvents) ? auditEvents : [];
  const event = rows.slice().reverse().find(candidate => isObject(candidate) && candidate.action === 'chrome_web_store.publisher_identity_verified'
    && isObject(candidate.details) && CWS_IDENTITY_STATE.has(candidate.details.state));
  const state = event?.details?.identityVerified === true && event.details.state === 'dashboard_reached'
    ? 'verified' : event ? event.details.state : 'not-yet-verified';
  return {
    requiredAccountAlias,
    selector: 'fixed-configured-account',
    requiresPreflight: true,
    state,
    verifiedAt: event && state === 'verified' ? timestamp(event.timestamp, 0) : null
  };
}

// A verified audit snapshot may remain useful while a refresh is in flight,
// but it is not live once its cache TTL has elapsed.  Keep the last validated
// values available for inspection and make their age explicit everywhere the
// browser contract carries a freshness value.  This deliberately does not
// change `source.audit` or `source.provenance`: they describe the integrity of
// the captured ledger head, whereas `freshness` describes whether this exact
// projection is current enough to operate from.
function staleProjection(projection) {
  if (!isObject(projection) || projection?.source?.freshness !== 'fresh') return projection;
  const stale = 'stale';
  return {
    ...projection,
    source: { ...projection.source, freshness: stale },
    snapshot: {
      ...projection.snapshot,
      freshness: stale,
      evidence: Array.isArray(projection.snapshot?.evidence)
        ? projection.snapshot.evidence.map(item => ({ ...item, freshness: stale }))
        : projection.snapshot?.evidence,
      reports: Array.isArray(projection.snapshot?.reports)
        ? projection.snapshot.reports.map(item => ({ ...item, freshness: stale }))
        : projection.snapshot?.reports
    }
  };
}

// --- agent roster: real lane identity (Q-lane-identity) ---------------------
//
// snapshot.agents/snapshot.edges are governed by the generated Agent Activity
// wire contract (AgentActivityVisualizer/src/generated/agent-activity-
// contracts.js), which this repo does not own edit rights to change right
// now: browserAgent.alias is a CLOSED 4-value enum (coordinator/worker/
// reviewer/observer) with additionalProperties:false, so it cannot carry a
// per-lane id, provider, model, or declared-vs-observed distinction no matter
// how this producer is shaped. Rather than silently pretend that distinction
// doesn't matter, it is carried in a new sibling envelope field,
// `agentRoster`, whose shape this module owns end to end (producer here,
// hand-written consumer allowlist in AgentActivityVisualizer/server/
// controller-projection.js). snapshot.agents/edges are still improved as far
// as the closed contract allows (see the 'observer' entry and the edge
// multiplication below), but real lane identity lives in agentRoster.
//
// declared vs observed is load-bearing and never conflated:
//  - declared: config/agent-org.json, the installation's neutral or
//    customer-edited declaration. Always present for every entry in that file,
//    regardless of whether anything has run.
//  - observed: derived only from the signed audit ledger (controller.agent.
//    launch records) or from caller-supplied live process evidence (a
//    Gemini fleet git worktree). Never invented from absence of evidence.
const AGENT_ORG_PATH = path.join(__dirname, '..', '..', 'config', 'agent-org.json');
// Built-in Codex tier mapping: Sol/Terra/Luna are product tiers, not evidence
// that any particular account or credential exists. This is display metadata,
// not something inferred per event.
const ROSTER_TIER_BY_AGENT_ID = Object.freeze({ astra: 'premium', luna: 'cheap', terra: 'standard', sol: 'premium' });
const ROSTER_MAX_LANES = 64;
const ROSTER_MAX_EDGES = 256;
const ROSTER_MAX_LAUNCH_LANES = 20;
const ROSTER_MAX_GEMINI_LANES = 16;
const GEMINI_LANE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// Reuses config/agent-org.json's own declared relationship vocabulary rather
// than forcing agent-agent relationships through the task/goal/phase-shaped
// browserEdge enum, which has no verb for "manages" or "reviews" at all.
const ORG_RELATION_TO_SNAPSHOT_EDGE_TYPE = Object.freeze({
  manages: 'delegated_to', reviews: 'reviewed_by', delegates_to: 'delegated_to', escalates_to: 'communicated_with'
});

function loadDeclaredOrg() {
  // This file is the authoritative declaration. A read, parse, or validation
  // failure is not evidence that the organization has zero declared lanes;
  // refuse to publish a projection whose empty roster would make that claim.
  const raw = JSON.parse(fs.readFileSync(AGENT_ORG_PATH, 'utf8'));
  return agentOrg.normalizeOrg(raw, { maxAgents: 0 });
}

function declaredRosterLanes(org, terminal, lifecycle, nowMs) {
  if (!org) return [];
  return org.agents.map(agent => {
    let state = 'unknown';
    if (!agent.enabled) {
      // A disabled declared agent cannot honestly be reported as active no
      // matter what stray evidence exists.
      state = 'idle';
    } else if (agent.provider === 'claude') {
      state = terminal.meters.claude.operationCount > 0 ? 'working' : 'idle';
    } else if (agent.provider === 'local') {
      state = lifecycle && lifecycle.running === true ? 'working' : 'idle';
    }
    // Every other declared provider (codex, today's luna/terra/sol) stays
    // 'unknown': the ledger actor tag collapses every Codex tier into one
    // 'codex' subject, so no event can be honestly attributed to one
    // specific declared tier -- see agent-org.json's own note on this gap.
    return Object.freeze({
      id: agent.id, label: agent.displayName, provider: agent.provider, role: agent.role,
      tier: ROSTER_TIER_BY_AGENT_ID[agent.id] || null, origin: 'declared', enabled: agent.enabled,
      state, parentId: null, observedAt: timestamp(nowMs, nowMs)
    });
  });
}

function mapLaunchTerminalStateToRosterState(terminalState) {
  if (terminalState === 'pending') return 'working';
  if (terminalState === 'completed') return 'completed';
  if (terminalState === 'failed') return 'blocked';
  if (terminalState === 'cancelled') return 'cancelled';
  return 'unknown'; // 'stale': the launch cap elapsed with no terminal report -- honestly unknown, not finished.
}

// Each dispatched launch (Q27's controller.agent.launch signed record) is its
// own transient lane, distinct from the declared org row that named its
// target. The normal audit window is still 200 records; the trusted worker may
// add at most two exact immutable parents for each of the twenty newest recent
// terminal receipts, so a terminal result never loses its older parent solely
// because unrelated meter events have scrolled by.
function observedLaunchLanes(auditEvents, org, nowMs) {
  const byLaunchId = new Map();
  const terminalEventsByLaunchId = new Map();
  for (const candidate of Array.isArray(auditEvents) ? auditEvents : []) {
    const event = isObject(candidate?.event) ? candidate.event : candidate;
    if (event?.action === launchOutcome.TERMINAL_ACTION && typeof event.target === 'string') {
      const entries = terminalEventsByLaunchId.get(event.target) || [];
      entries.push(candidate);
      terminalEventsByLaunchId.set(event.target, entries);
    }
    // Non-launch events return null. A launch-shaped event that cannot be
    // validated throws: dropping it here would report a definite roster while
    // silently omitting a lane the verified audit says should be considered.
    const record = launchRecordLib.launchFromAuditEvent(candidate);
    if (record) byLaunchId.set(record.launchId, record);
  }
  const records = [...byLaunchId.values()]
    .sort((left, right) => Date.parse(right.launchedAt) - Date.parse(left.launchedAt))
    .slice(0, ROSTER_MAX_LAUNCH_LANES);
  return records.map(record => {
    // The original launch record remains immutable. A terminal state may only
    // come from exactly one matching signed receipt; malformed, mismatched,
    // replayed, or conflicting events deliberately degrade to pending/stale.
    const terminalReceipt = launchOutcome.terminalReceiptForRecord(record, terminalEventsByLaunchId.get(record.launchId) || []);
    const pendingProjection = launchRecordLib.projectLaunch(record, { nowMs });
    const projected = terminalReceipt
      ? Object.freeze({ ...pendingProjection, terminalState: terminalReceipt.terminalState, storedTerminalState: terminalReceipt.terminalState, stale: false })
      : pendingProjection;
    const declaredAgent = org ? org.agents.find(agent => agent.id === record.targetAgentId) : null;
    return Object.freeze({
      id: record.launchId, label: `${record.targetAgentId} launch`,
      provider: declaredAgent ? declaredAgent.provider : 'none',
      role: declaredAgent ? declaredAgent.role : 'worker',
      tier: record.tier, origin: 'observed', enabled: true,
      state: mapLaunchTerminalStateToRosterState(projected.terminalState),
      parentId: record.parentLaunchId, observedAt: timestamp(record.launchedAt, nowMs)
    });
  });
}

// Live 'ToolsEnabled-lane-*' git worktrees (tools/gemini-fleet.js) are the
// clearest available signal of an active Gemini fleet lane, but this module
// intentionally performs no I/O of its own (see the file-header comment) --
// the caller gathers the worktree list the same way it already gathers
// runControl.list()/providerGateway.cachedStatus() and passes lane ids in.
function geminiFleetRosterLanes(laneIds, nowMs) {
  const seen = new Set();
  const lanes = [];
  for (const raw of Array.isArray(laneIds) ? laneIds : []) {
    if (lanes.length >= ROSTER_MAX_GEMINI_LANES) break;
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!GEMINI_LANE_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    lanes.push(Object.freeze({
      id: `gemini-lane-${id}`, label: `Gemini fleet lane ${id}`, provider: 'gemini', role: 'builder',
      tier: null, origin: 'observed', enabled: true,
      // A live worktree only proves a lane was claimed and not yet cleaned
      // up, not that work is happening in it right now -- honestly unknown
      // rather than guessed 'working'.
      state: 'unknown', parentId: null, observedAt: timestamp(nowMs, nowMs)
    }));
  }
  return lanes;
}

function declaredRosterEdges(org, nowMs) {
  if (!org) return [];
  return org.relationships.map(relation => Object.freeze({
    fromId: relation.from, toId: relation.to, type: relation.type, origin: 'declared',
    observedAt: timestamp(nowMs, nowMs)
  }));
}

// Only emitted when BOTH ends are lanes this projection actually carries, so
// the roster graph never references a dangling id.
function launchParentageRosterEdges(launchLanes) {
  const presentIds = new Set(launchLanes.map(lane => lane.id));
  return launchLanes
    .filter(lane => lane.parentId && presentIds.has(lane.parentId))
    .map(lane => Object.freeze({ fromId: lane.parentId, toId: lane.id, type: 'delegates_to', origin: 'observed', observedAt: lane.observedAt }));
}

function buildAgentRoster({ org, auditEvents, nowMs, terminal, lifecycle, geminiFleetLaneIds }) {
  const declaredLanes = declaredRosterLanes(org, terminal, lifecycle, nowMs);
  const launchLanes = observedLaunchLanes(auditEvents, org, nowMs);
  const geminiLanes = geminiFleetRosterLanes(geminiFleetLaneIds, nowMs);
  const lanes = [...declaredLanes, ...launchLanes, ...geminiLanes].slice(0, ROSTER_MAX_LANES);
  const edges = [...declaredRosterEdges(org, nowMs), ...launchParentageRosterEdges(launchLanes)].slice(0, ROSTER_MAX_EDGES);
  return Object.freeze({ schemaVersion: 1, lanes: Object.freeze(lanes), edges: Object.freeze(edges) });
}

function buildControllerProjection({
  // Default parameters are evaluated per call, so reading the configured
  // default account here (rather than from an import-time constant) is what
  // makes a newly registered account visible to the next projection instead of
  // the next process.
  nowMs = Date.now(), auditEvents = [], auditVerification = {}, runs = [], lifecycle = {}, providerCache = {}, accounts, defaultGoogleAlias, focus = 'all', geminiFleetLaneIds = []
} = {}) {
  // Resolved HERE, once, at call time -- not at import, and not separately in
  // each consumer below, so one projection cannot describe two different
  // rosters. `accounts` is the explicit declaration; omitting it reads the
  // live configuration.
  const accountConfig = configuredAccounts(accounts);
  // ONE roster for this whole projection: the ledger read, the aggregate, the
  // cost view and the account-lane rows all judge aliases against this single
  // value, so a projection can never half-recognise an account.
  const accountRoster = meter.accountRosterFor(accountConfig.accounts);
  if (defaultGoogleAlias === undefined) defaultGoogleAlias = accountConfig.defaultAccount;
  // Safe integers can still fall outside ECMAScript's representable Date
  // range, where toISOString() throws instead of producing a projection.
  nowMs = safeInteger(nowMs, Date.now(), MAX_DATE_MS);
  const verifiedAudit = auditVerification && auditVerification.valid === true;
  const auditHeadHash = typeof auditVerification?.headHash === 'string' && AUDIT_HASH.test(auditVerification.headHash)
    ? auditVerification.headHash : null;
  const auditHeadKeyId = typeof auditVerification?.headKeyId === 'string' && AUDIT_KEY_ID.test(auditVerification.headKeyId)
    ? auditVerification.headKeyId : null;
  const auditProvenanceVerified = verifiedAudit && auditVerification.signaturesValid === true
    && auditHeadHash !== null && auditHeadKeyId !== null;
  const freshness = auditProvenanceVerified ? 'fresh' : verifiedAudit ? 'unverified'
    : auditVerification && auditVerification.reason ? 'invalid' : 'unverified';
  const sourceEvents = auditProvenanceVerified ? auditEvents : [];
  const terminal = terminalProviderEvents(sourceEvents, nowMs);
  const mechanical = mechanicalMeters(sourceEvents, auditProvenanceVerified, accountRoster);
  let actualSavings;
  if (!auditProvenanceVerified || mechanical.invalid) {
    actualSavings = savings.unknownSavings(auditProvenanceVerified ? 'invalid-matched-baseline' : savings.UNKNOWN_STATE, 'audit-unavailable');
  } else {
    try {
      actualSavings = savings.matchedSavings(mechanical.records, savings.pairsFromAuditEvents(sourceEvents), { accountRoster });
    } catch {
      actualSavings = savings.unknownSavings('invalid-matched-baseline', 'audit-pair-invalid');
    }
  }
  const safeRuns = Array.isArray(runs) ? runs.slice(0, 100) : [];
  // `uncertain` has a completedAt value in the durable store.  Treating it as
  // active made a worker that had safely stopped for help look permanently
  // alive in the dashboard, and it manufactured a continuing works_on edge.
  const activeRuns = safeRuns.filter(run => ['queued', 'leased', 'running', 'retry_wait'].includes(run?.status));
  const runOutcomes = durableRunOutcomes(safeRuns);
  const runTasks = safeRuns.slice(0, 64).map(run => ({
    taskKind: runTaskKind(run?.status),
    state: mapRunState(run?.status),
    progressPercent: run?.status === 'succeeded' ? 100 : 0,
    observedAt: timestamp(run?.updatedAt, nowMs)
  }));
  const coordinatorState = lifecycle && lifecycle.running === true ? 'working' : 'idle';
  const reviewerState = terminal.meters.gemini.operationCount + terminal.meters.codex.operationCount > 0 ? 'working' : 'idle';
  // 'observer' is the 4th value the wire contract's closed agentKind/alias
  // enum already allows but this producer never emitted -- it represents the
  // ledger-verification/meter-observation lane itself, honestly derived from
  // whether this projection actually had a verified, non-empty audit window
  // to observe.
  const observerState = auditProvenanceVerified && sourceEvents.length > 0 ? 'working' : 'idle';
  const agents = [
    { alias: 'coordinator', agentKind: 'coordinator', state: coordinatorState, observedAt: timestamp(nowMs, nowMs) },
    { alias: 'worker', agentKind: 'worker', state: activeRuns.length ? 'working' : 'idle', observedAt: timestamp(nowMs, nowMs) },
    { alias: 'reviewer', agentKind: 'reviewer', state: reviewerState, observedAt: timestamp(nowMs, nowMs) },
    { alias: 'observer', agentKind: 'observer', state: observerState, observedAt: timestamp(nowMs, nowMs) }
  ];
  const declaredOrg = loadDeclaredOrg();
  const agentRoster = buildAgentRoster({ org: declaredOrg, auditEvents: sourceEvents, nowMs, terminal, lifecycle, geminiFleetLaneIds });
  // snapshot.edges stays inside the closed browserEdge contract (edgeType/
  // fromKind/toKind/observedAt only -- no entity ids, see buildAgentRoster's
  // header comment), but is no longer hardcoded to at most one edge: it now
  // emits one honest works_on edge per real non-terminal task, plus one edge
  // per declared agent-agent relationship, mapped onto the closed edgeType
  // vocabulary. Real per-lane identity (which agent, which task) lives in
  // agentRoster above; this stays a coarse, schema-legal category count.
  const orgRelationshipSnapshotEdges = (declaredOrg?.relationships || []).map(relation => ({
    edgeType: ORG_RELATION_TO_SNAPSHOT_EDGE_TYPE[relation.type] || 'communicated_with',
    fromKind: 'agent', toKind: 'agent', observedAt: timestamp(nowMs, nowMs)
  }));
  const taskAssignmentSnapshotEdges = activeRuns.map(() => ({
    edgeType: 'works_on', fromKind: 'agent', toKind: 'task', observedAt: timestamp(nowMs, nowMs)
  }));
  // mechanical.rows aggregates every meter record in the window, including
  // ones whose parent coordinator.audit.provider.operation event is ALSO directly
  // visible and already counted by terminalProviderEvents() above. Feeding
  // the full mechanical.rows into withMechanicalProviderMeters()'s
  // operation-count pass would count each such operation twice (see
  // terminalProviderEvents()'s comment), so that pass gets only the
  // deduplicated rows below; its evidence/token/cost pass still gets the
  // full mechanical.rows (passed separately), since token/cost data has no
  // raw-terminal-scan equivalent to double with. accountLanes/waste/
  // actualSavings further down intentionally keep using the full,
  // undeduplicated mechanical.rows/records too, since those report
  // durable-evidence coverage, not a claimed count of distinct operations.
  const nonDuplicateMechanicalRows = meter.aggregate(
    mechanical.records.filter(record => !terminal.countedAuditSequences.has(record.auditSequence)),
    { accountRoster }
  );
  // Internal, all-numeric accumulation order: signed lifecycle events, then
  // durable MeterRecords, then locally-recorded CLI usage. finalizeProviderMeter()
  // below is the only place a column becomes null-with-a-reason.
  const accumulated = withCliSessionUsage(
    withMechanicalProviderMeters(Object.values(terminal.meters), nonDuplicateMechanicalRows, mechanical.rows),
    cliSessionUsageByProvider(sourceEvents)
  );
  const providerMeters = accumulated.map(finalizeProviderMeter);
  // Q38's amount view is intentionally separate from the existing aggregate
  // meter: it exposes a dollar total only where every contributing signed
  // record carried a provider-returned amount.  Token counts, trial credits,
  // and static pricing are not substitutes for an observed amount.
  const costByLane = costAttribution.fromMeterRecords(mechanical.records, {
    expectedLanes: reservedGeminiAccountLanes(accountConfig).map(lane => ({ ...lane, provider: 'gemini' })),
    // The same roster this projection resolved, handed down rather than
    // re-read: a declared configuration must be judged by the module that
    // validates lanes, or a caller could declare accounts the cost view would
    // then reject as unregistered.
    accountRoster,
    coverageComplete: mechanical.state === 'verified-durable'
  });
  // These aggregates are computed from the internal numeric rows, not from the
  // finalized wire rows, because a finalized column may legitimately be null.
  // A null there means "not measured", so it contributes nothing to a total --
  // which is exactly what these sums already meant.
  const totalDurationMs = accumulated.reduce((sum, meter) => sum + (meter.durationSources.size ? meter.durationMs : 0), 0);
  const totalOutputBytes = accumulated.reduce((sum, meter) => sum + (meter.outputBytesSources.size ? meter.outputBytes : 0), 0);
  const retryCount = accumulated.reduce((sum, meter) => sum + (meter.operationSources.size ? meter.timeoutCount + meter.failedCount : 0), 0);
  const errorSignatures = [
    ...(accumulated.some(meter => meter.operationSources.size && meter.timeoutCount > 0) ? ['PROVIDER_TIMEOUT'] : []),
    ...(accumulated.some(meter => meter.operationSources.size && meter.failedCount > 0) ? ['PROVIDER_FAILED'] : [])
  ];
  const snapshot = {
    schemaVersion: '1.0.0', projectionKind: 'browser-safe-snapshot', observedAt: timestamp(nowMs, nowMs),
    sequence: Math.max(1, safeInteger(auditVerification?.headSequence, 1)), freshness,
    contentTrust: 'untrusted', grantsAuthority: false,
    safeDisplay: { labels: ['verified-local-state'], sourceCount: auditProvenanceVerified ? sourceEvents.length : 0, containsSecret: false },
    agents,
    goals: [{ safeLabel: 'implementation', state: activeRuns.length ? 'working' : 'idle', progressPercent: activeRuns.length ? 50 : 0, observedAt: timestamp(nowMs, nowMs) }],
    requests: [{ safeLabel: 'planning', state: activeRuns.length ? 'working' : 'idle', gateState: activeRuns.length ? 'waiting' : 'not-started', observedAt: timestamp(nowMs, nowMs) }],
    phases: [{ safeLabel: 'validation', state: retryCount ? 'blocked' : activeRuns.length ? 'working' : 'idle', progressPercent: activeRuns.length ? 50 : 0, observedAt: timestamp(nowMs, nowMs) }],
    tasks: runTasks,
    evidence: [{ evidenceKind: 'tool', evidenceCount: auditProvenanceVerified ? sourceEvents.length : 0, freshness, observedAt: timestamp(nowMs, nowMs) }],
    reports: [{ state: 'completed', freshness, observedAt: timestamp(nowMs, nowMs) }],
    edges: [...orgRelationshipSnapshotEdges, ...taskAssignmentSnapshotEdges],
    events: terminal.events
  };
  const history = {
    schemaVersion: '1.0.0', projectionKind: 'browser-safe-history', owner: { kind: 'agent', alias: 'coordinator' },
    observedAt: timestamp(nowMs, nowMs), contentTrust: 'untrusted', grantsAuthority: false,
    safeDisplay: { labels: ['verified-local-state'], sourceCount: auditProvenanceVerified ? sourceEvents.length : 0, containsSecret: false },
    detailEvents: terminal.events.map(event => ({ ...event, redactionState: 'redacted' })),
    aggregate: {
      windowStartedAt: timestamp(nowMs - Math.min(totalDurationMs, 24 * 60 * 60 * 1000), nowMs), windowEndedAt: timestamp(nowMs, nowMs),
      windowEventCount: auditProvenanceVerified ? sourceEvents.length : 0, wallTimeMs: totalDurationMs,
      reportedTokenCount: mechanical.rows.some(row => row.reportedTokenEvidenceCount > 0)
        ? mechanical.rows.reduce((sum, row) => sum + row.reportedTokens, 0) : null,
      estimatedTokenCount: { value: mechanical.rows.reduce((sum, row) => sum + row.deterministicTokens, 0), label: 'estimate-not-provider-reported' },
      toolBytes: 0, outputBytes: totalOutputBytes, retryCount, noProgressCount: 0,
      errorSignatures, acceptance: 'not-applicable', workflowVersion: 'v1.0'
    }
  };
  return {
    schemaVersion: 'controller-projection-v1', projectionKind: 'controller-browser-safe', observedAt: timestamp(nowMs, nowMs),
    source: {
      audit: auditProvenanceVerified ? 'verified' : freshness === 'invalid' ? 'invalid' : 'unverified',
      provenance: {
        state: auditProvenanceVerified ? 'verified' : 'unavailable',
        headSequence: safeInteger(auditVerification?.headSequence, 0),
        headHash: auditHeadHash,
        headKeyId: auditHeadKeyId
      },
      meters: mechanical.state,
      metersUnavailableReason: mechanical.reason,
      metersSkippedCount: mechanical.skippedCount,
      subscriptionUsage: mechanical.rows.some(row => row.lane === 'subscription-cli' && row.sourceTypeCounts['provider-reported'] > 0)
        ? 'provider-reported' : mechanical.rows.some(row => row.lane === 'subscription-cli')
          ? 'unavailable-provider-no-structured-meter' : 'unavailable-no-durable-meter',
      savings: actualSavings.state,
      freshness
    },
    snapshot, history,
    metrics: {
      providerMeters,
      accountLanes: accountLanes(mechanical.rows, accountConfig),
      costAttribution: costByLane,
      durableRunOutcomes: runOutcomes,
      waste: {
        retryOrFailureCount: retryCount,
        duplicateReviewCount: mechanical.rows.reduce((sum, row) => sum + row.waste['duplicate-review'], 0),
        idleFrontierDurationMs: mechanical.rows.reduce((sum, row) => sum + (row.waste['idle-frontier'] ? row.elapsedMs : 0), 0),
        cacheMissCount: mechanical.rows.reduce((sum, row) => sum + row.waste['cache-miss'], 0),
        unproductiveContextCount: mechanical.rows.reduce((sum, row) => sum + row.waste['unproductive-context'], 0),
        measuredEvidenceCount: mechanical.records.length,
        sourceState: mechanical.state
      },
      actualSavings
    },
    controls: {
      lifecycle: lifecycle && lifecycle.running === true ? 'running' : 'stopped',
      providers: providerControls(providerCache, defaultGoogleAlias, accountConfig),
      focus: focusControl(focus),
      identity: cwsIdentityControl(sourceEvents, defaultGoogleAlias, accountConfig)
    },
    agentRoster,
    contentTrust: 'untrusted', grantsAuthority: false
  };
}

// accountAliases/reservedAccountLanes are exported as FUNCTIONS, not as the
// frozen arrays they used to be: an exported snapshot of gitignored state is
// the same defect one module further out, and a caller cannot tell a stale
// array from a current one.
module.exports = { FOCUS_PROJECTS, METER_PROVIDERS, PROVIDERS, accountAliases, accountLanes, buildControllerProjection, cwsIdentityControl, durableRunOutcomes, mechanicalMeters, reservedAccountLanes, reservedGeminiAccountLanes, staleProjection, terminalProviderEvents };
