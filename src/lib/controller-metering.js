'use strict';

// Q17 mechanical, content-free meter contract. Persistence and provider
// instrumentation remain separate phases; this module is deliberately pure so
// a dashboard can never infer billing from prompt/output text or a CLI timer.
const crypto = require('node:crypto');
const googleAccounts = require('./google-accounts');

const SCHEMA_VERSION = 1;
const PROVIDERS = new Set(['codex', 'claude', 'gemini', 'vertex', 'local']);
// 'unattributed' is a contract constant, not a registered identity: it is the
// honest name for usage that belongs to no registered account, and it stays a
// valid accountAlias on an installation whose roster is empty.
const UNATTRIBUTED = 'unattributed';
// Registered accounts are user data (config/google-accounts.profile.json),
// never a compile-time list -- a customer's own registered account must be a
// valid accountAlias here, the same as the sibling roster read by
// controller-projection.js.
//
// It is equally never a MODULE-LOAD SNAPSHOT, which is what it used to be.
// Freezing the roster at import made this module wrong in two directions:
//   * runtime: an account registered after this module was first required was
//     rejected until the whole process restarted. The customer added an
//     account and metering answered "accountAlias is invalid" about the
//     account they had just added.
//   * measurement: the profile is gitignored, so a checkout that does not have
//     it -- a fresh clone, a detached worktree, a fresh install before the
//     first tools/google-oauth-login.js run -- validated every record against
//     a roster of one. 12 engine test files failed there and passed only where
//     that gitignored file happened to exist, which is why a trustworthy
//     engine baseline could not be measured from a worktree at all (R1531 w8).
// The roster is therefore resolved WHEN NEEDED, once per public call, and the
// empty case is a NAMED state carried on the error rather than a silent wrong
// answer that looks identical to a genuinely unknown alias.
const ROSTER_STATES = Object.freeze({
  REGISTERED: 'accounts-registered',
  NONE_REGISTERED: 'no-accounts-registered'
});
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const LANES = new Set(['subscription-cli', 'vertex', 'api', 'local', 'unattributed']);
const SOURCE_TYPES = new Set(['provider-reported', 'deterministic-tokenizer', 'unavailable']);
const REQUEST_CLASSES = new Set(['planning', 'implementation', 'review', 'verification', 'research', 'control']);
const OUTCOMES = new Set(['success', 'failed', 'timeout', 'cancelled', 'blocked', 'unknown']);
const WASTE_REASONS = new Set(['none', 'retry', 'duplicate-review', 'idle-frontier', 'cache-miss', 'rework', 'unproductive-context', 'unknown']);
const UNAVAILABLE_REASONS = new Set(['provider-no-structured-meter', 'official-billing-unavailable', 'provider-not-configured', 'audit-unavailable', 'not-applicable']);
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE = /^mtr_[A-Za-z0-9_-]{16,96}$/;
const REF = /^[a-z][a-z0-9._:-]{2,159}$/;
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+|\b(?:token|password|cookie|otp|secret|prompt|response|path)\b|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,})/i;

class MeterError extends Error { constructor(code, message) { super(message); this.name = 'MeterError'; this.code = code; } }
function fail(code, message) { throw new MeterError(code, message); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, keys, required, label) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('METER_INVALID', `${label} is invalid.`);
  return value;
}
function enumValue(value, values, label) { if (!values.has(value)) fail('METER_INVALID', `${label} is invalid.`); return value; }
function opaque(value, label) { if (typeof value !== 'string' || !OPAQUE.test(value) || SENSITIVE.test(value)) fail('METER_INVALID', `${label} is invalid.`); return value; }
function ref(value, label) { if (typeof value !== 'string' || !REF.test(value) || SENSITIVE.test(value)) fail('METER_INVALID', `${label} is invalid.`); return value; }
function hash(value, label) { if (typeof value !== 'string' || !SHA256.test(value)) fail('METER_INVALID', `${label} is invalid.`); return value; }
function integer(value, label, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('METER_INVALID', `${label} is invalid.`); return value; }
function timestamp(value, label) { const ms = typeof value === 'string' ? Date.parse(value) : NaN; if (!Number.isSafeInteger(ms) || ms < 0) fail('METER_INVALID', `${label} is invalid.`); return new Date(ms).toISOString(); }
function stable(value) { if (Array.isArray(value)) return value.map(stable); if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])); return value; }
function digest(value) { return crypto.createHash('sha256').update(`toolsenabled.meter-record.v1\0${JSON.stringify(stable(value))}`).digest('hex'); }

// A roster is a closed, self-describing value: which aliases a meter record may
// carry, how many registered accounts that came from, and -- by name -- whether
// this installation has any registered accounts at all. It carries no email and
// no other account metadata, because nothing here needs one and this module
// feeds a browser egress boundary.
function freezeRoster(aliases) {
  const registered = Object.freeze([...new Set(aliases)].sort());
  return Object.freeze({
    state: registered.length ? ROSTER_STATES.REGISTERED : ROSTER_STATES.NONE_REGISTERED,
    accountCount: registered.length,
    registeredAliases: registered,
    validAliases: Object.freeze(new Set([...registered, UNATTRIBUTED]))
  });
}

// The live roster, read from user data at CALL time. An absent or empty profile
// is the NONE_REGISTERED state exposed by googleAccounts.load(). A thrown read
// failure is different: it leaves the roster unmeasured and must not be
// collapsed into the definite claim that no accounts are registered.
function accountRoster() {
  let loaded;
  try { loaded = googleAccounts.load(); }
  catch { fail('METER_ROSTER_UNAVAILABLE', 'The account roster could not be read.'); }
  if (!plain(loaded) || !plain(loaded.accounts)) fail('METER_ROSTER_UNAVAILABLE', 'The account roster could not be established.');
  return accountRosterFor(loaded.accounts);
}

// Build a roster from an accounts map a caller already holds -- the live
// profile, or a configuration a caller declared. Same filtering as the live
// read above, so a declared configuration and a loaded one can never be judged
// by two different rules.
function accountRosterFor(accounts) {
  if (!plain(accounts)) fail('METER_INVALID', 'An accounts map must be declared as an object.');
  const aliases = Object.keys(accounts);
  if (aliases.some(alias => !ALIAS.test(alias) || alias === UNATTRIBUTED)) fail('METER_INVALID', 'An accounts map contains an invalid alias.');
  return freezeRoster(aliases);
}

// An explicitly declared roster, for a caller that must not depend on THIS
// machine's gitignored profile (a test, or a caller that already resolved the
// roster once and is validating a batch against it).
//
// Every roster is a RESTRICTION. The narrowest one -- zero registered accounts
// -- still admits 'unattributed' and nothing else, and there is no way to
// express "accept any alias". Declaring [] therefore means "this installation
// has no registered accounts"; it never means "skip the check".
function accountRosterOf(aliases) {
  if (!Array.isArray(aliases)) fail('METER_INVALID', 'An account roster must be declared as an array of aliases.');
  for (const alias of aliases) {
    if (typeof alias !== 'string' || !ALIAS.test(alias) || alias === UNATTRIBUTED) {
      fail('METER_INVALID', 'An account roster alias is invalid.');
    }
  }
  return freezeRoster(aliases);
}

function isRoster(value) {
  return plain(value)
    && (value.state === ROSTER_STATES.REGISTERED || value.state === ROSTER_STATES.NONE_REGISTERED)
    && Array.isArray(value.registeredAliases) && value.validAliases instanceof Set
    && value.accountCount === value.registeredAliases.length
    && (value.accountCount > 0) === (value.state === ROSTER_STATES.REGISTERED)
    && value.validAliases.has(UNATTRIBUTED);
}

// Absence is never consent. Omitting options resolves the LIVE roster; naming
// accountRoster and supplying anything that is not a roster is a caller error,
// not permission to accept any alias and not a quiet fall back to this
// machine's accounts.
// `accountRoster: undefined` means NOT SPECIFIED, exactly as an omitted key
// does -- an intermediate that forwards an optional argument it never received
// must not be punished for it. `accountRoster: null` is different: the caller
// wrote something and it resolved to nothing, which is a bug worth reporting
// rather than papering over. Both unspecified paths resolve the LIVE roster,
// which is the STRICTEST answer available -- no input to this function can ever
// widen what counts as a valid alias.
function resolveRoster(options) {
  if (options === undefined || options === null) return accountRoster();
  if (!plain(options) || Object.keys(options).some(key => key !== 'accountRoster')) fail('METER_INVALID', 'options is invalid.');
  if (options.accountRoster === undefined) return accountRoster();
  if (!isRoster(options.accountRoster)) fail('METER_INVALID', 'options.accountRoster is invalid.');
  return options.accountRoster;
}

// The one place an alias is judged. On failure the roster state travels with
// the error so a caller -- a dashboard, a test, a report -- can tell "you named
// an account that is not registered" apart from "this installation has not
// registered any account yet". The message names the state and never the
// aliases: those are user data.
function accountAliasValue(value, roster) {
  if (typeof value === 'string' && roster.validAliases.has(value)) return value;
  const error = new MeterError('METER_INVALID', roster.state === ROSTER_STATES.NONE_REGISTERED
    ? `accountAlias is invalid: ${ROSTER_STATES.NONE_REGISTERED} on this installation, so '${UNATTRIBUTED}' is the only accountAlias a meter record can carry. Register an account with tools/google-oauth-login.js.`
    : 'accountAlias is invalid.');
  error.accountRosterState = roster.state;
  error.accountCount = roster.accountCount;
  throw error;
}

function units(value, sourceType) {
  exact(value, ['reportedTokens', 'deterministicTokens', 'billableUnits', 'costMicros'], ['reportedTokens', 'deterministicTokens', 'billableUnits', 'costMicros'], 'units');
  const output = {
    reportedTokens: value.reportedTokens === null ? null : integer(value.reportedTokens, 'units.reportedTokens', 100_000_000),
    deterministicTokens: value.deterministicTokens === null ? null : integer(value.deterministicTokens, 'units.deterministicTokens', 100_000_000),
    billableUnits: value.billableUnits === null ? null : integer(value.billableUnits, 'units.billableUnits', 100_000_000),
    costMicros: value.costMicros === null ? null : integer(value.costMicros, 'units.costMicros', 10_000_000_000_000)
  };
  if (sourceType === 'provider-reported' && output.reportedTokens === null && output.billableUnits === null && output.costMicros === null) fail('METER_INVALID', 'provider-reported meters require a provider-returned unit.');
  if (sourceType === 'deterministic-tokenizer' && output.deterministicTokens === null) fail('METER_INVALID', 'deterministic-tokenizer meters require a deterministic token count.');
  if (sourceType === 'unavailable' && Object.values(output).some(value => value !== null)) fail('METER_INVALID', 'unavailable meters must not invent units.');
  return Object.freeze(output);
}

function unavailableReason(value, sourceType) {
  if (sourceType === 'unavailable') {
    if (typeof value !== 'string' || !UNAVAILABLE_REASONS.has(value)) fail('METER_INVALID', 'unavailableReason is invalid.');
    return value;
  }
  if (value !== null) fail('METER_INVALID', 'unavailableReason is valid only for unavailable meters.');
  return null;
}

// Public entry: resolves the roster once, then validates against that single
// answer so every field in one record is judged against one roster read.
function normalizeRecord(value, options) {
  return normalizeRecordWith(value, resolveRoster(options));
}

function normalizeRecordWith(value, roster) {
  exact(value, ['schemaVersion', 'meterId', 'auditSequence', 'auditEventHash', 'taskRef', 'phaseRef', 'configurationHash', 'provider', 'accountAlias', 'lane', 'modelAlias', 'sourceType', 'tokenizerVersion', 'unavailableReason', 'requestClass', 'window', 'units', 'elapsedMs', 'queueMs', 'idleMs', 'retry', 'replay', 'cacheReuse', 'reviewVerdict', 'terminalStatus', 'wasteReason'],
    ['schemaVersion', 'meterId', 'auditSequence', 'auditEventHash', 'taskRef', 'phaseRef', 'configurationHash', 'provider', 'accountAlias', 'lane', 'modelAlias', 'sourceType', 'tokenizerVersion', 'unavailableReason', 'requestClass', 'window', 'units', 'elapsedMs', 'queueMs', 'idleMs', 'retry', 'replay', 'cacheReuse', 'reviewVerdict', 'terminalStatus', 'wasteReason'], 'MeterRecord');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('METER_VERSION_UNSUPPORTED', 'MeterRecord schema version is unsupported.');
  exact(value.window, ['startedAt', 'endedAt', 'freshness', 'completeness'], ['startedAt', 'endedAt', 'freshness', 'completeness'], 'window');
  const startedAt = timestamp(value.window.startedAt, 'window.startedAt'); const endedAt = timestamp(value.window.endedAt, 'window.endedAt');
  if (Date.parse(endedAt) < Date.parse(startedAt) || !['fresh', 'partial', 'unavailable'].includes(value.window.freshness) || !['complete', 'partial', 'unavailable'].includes(value.window.completeness)) fail('METER_INVALID', 'window is invalid.');
  if (typeof value.modelAlias !== 'string' || value.modelAlias.length > 120 || SENSITIVE.test(value.modelAlias)) fail('METER_INVALID', 'modelAlias is invalid.');
  if (typeof value.reviewVerdict !== 'string' || !['not-applicable', 'approved', 'rejected', 'unavailable'].includes(value.reviewVerdict)) fail('METER_INVALID', 'reviewVerdict is invalid.');
  const sourceType = enumValue(value.sourceType, SOURCE_TYPES, 'sourceType');
  if (sourceType === 'deterministic-tokenizer') {
    if (typeof value.tokenizerVersion !== 'string' || !REF.test(value.tokenizerVersion) || SENSITIVE.test(value.tokenizerVersion)) fail('METER_INVALID', 'tokenizerVersion is invalid.');
  } else if (value.tokenizerVersion !== null) fail('METER_INVALID', 'tokenizerVersion is valid only for deterministic-tokenizer meters.');
  const output = {
    schemaVersion: SCHEMA_VERSION, meterId: opaque(value.meterId, 'meterId'), auditSequence: integer(value.auditSequence, 'auditSequence'), auditEventHash: hash(value.auditEventHash, 'auditEventHash'),
    taskRef: ref(value.taskRef, 'taskRef'), phaseRef: ref(value.phaseRef, 'phaseRef'), configurationHash: hash(value.configurationHash, 'configurationHash'), provider: enumValue(value.provider, PROVIDERS, 'provider'), accountAlias: accountAliasValue(value.accountAlias, roster), lane: enumValue(value.lane, LANES, 'lane'), modelAlias: value.modelAlias,
    sourceType, tokenizerVersion: value.tokenizerVersion, unavailableReason: unavailableReason(value.unavailableReason, sourceType), requestClass: enumValue(value.requestClass, REQUEST_CLASSES, 'requestClass'), window: Object.freeze({ startedAt, endedAt, freshness: value.window.freshness, completeness: value.window.completeness }),
    units: units(value.units, sourceType), elapsedMs: integer(value.elapsedMs, 'elapsedMs', 86_400_000), queueMs: integer(value.queueMs, 'queueMs', 86_400_000), idleMs: integer(value.idleMs, 'idleMs', 86_400_000), retry: value.retry === true, replay: value.replay === true, cacheReuse: value.cacheReuse === true,
    reviewVerdict: value.reviewVerdict, terminalStatus: enumValue(value.terminalStatus, OUTCOMES, 'terminalStatus'), wasteReason: enumValue(value.wasteReason, WASTE_REASONS, 'wasteReason')
  };
  return Object.freeze({ ...output, recordHash: digest(output) });
}

function aggregate(records, options) {
  // One roster read for the whole batch: every record in an aggregate is
  // judged against the same roster, and a batch cannot straddle a mid-run
  // registration and half-accept an alias.
  if (!Array.isArray(records)) fail('METER_INVALID', 'Meter records must be declared as an array.');
  const roster = resolveRoster(options);
  const seen = new Set(); const rows = [];
  for (const value of records) {
    const hasDerivedHash = plain(value) && Object.hasOwn(value, 'recordHash');
    const { recordHash, ...input } = hasDerivedHash ? value : {};
    const row = normalizeRecordWith(hasDerivedHash ? input : value, roster);
    if (hasDerivedHash && recordHash !== row.recordHash) fail('METER_INVALID', 'MeterRecord derived hash is invalid.');
    if (seen.has(row.meterId) || rows.some(existing => existing.auditSequence === row.auditSequence || existing.auditEventHash === row.auditEventHash)) fail('METER_DUPLICATE', 'Meter records must not double count an audit event.');
    seen.add(row.meterId); rows.push(row);
  }
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.accountAlias}\0${row.provider}\0${row.lane}`;
    const entry = groups.get(key) || {
      accountAlias: row.accountAlias, provider: row.provider, lane: row.lane,
      recordCount: 0,
      reportedTokens: 0, reportedTokenEvidenceCount: 0,
      deterministicTokens: 0, deterministicTokenEvidenceCount: 0,
      billableUnits: 0, billableUnitEvidenceCount: 0,
      costMicros: 0, costMicrosEvidenceCount: 0,
      unavailableCount: 0,
      terminalStatusCounts: Object.fromEntries([...OUTCOMES].map(outcome => [outcome, 0])),
      elapsedMs: 0, retryCount: 0, replayCount: 0, cacheReuseCount: 0,
      sourceTypeCounts: Object.fromEntries([...SOURCE_TYPES].map(sourceType => [sourceType, 0])),
      window: { startedAt: row.window.startedAt, endedAt: row.window.endedAt, freshness: row.window.freshness, completeness: row.window.completeness },
      waste: Object.fromEntries([...WASTE_REASONS].map(reason => [reason, 0]))
    };
    entry.recordCount += 1; entry.elapsedMs += row.elapsedMs; entry.retryCount += row.retry ? 1 : 0; entry.replayCount += row.replay ? 1 : 0; entry.cacheReuseCount += row.cacheReuse ? 1 : 0; entry.waste[row.wasteReason] += 1;
    entry.terminalStatusCounts[row.terminalStatus] += 1;
    entry.sourceTypeCounts[row.sourceType] += 1;
    if (row.window.startedAt < entry.window.startedAt) entry.window.startedAt = row.window.startedAt;
    if (row.window.endedAt > entry.window.endedAt) entry.window.endedAt = row.window.endedAt;
    if (row.window.freshness === 'unavailable' || (row.window.freshness === 'partial' && entry.window.freshness === 'fresh')) entry.window.freshness = row.window.freshness;
    if (row.window.completeness === 'unavailable' || (row.window.completeness === 'partial' && entry.window.completeness === 'complete')) entry.window.completeness = row.window.completeness;
    if (row.units.reportedTokens !== null) { entry.reportedTokens += row.units.reportedTokens; entry.reportedTokenEvidenceCount += 1; }
    if (row.units.deterministicTokens !== null) { entry.deterministicTokens += row.units.deterministicTokens; entry.deterministicTokenEvidenceCount += 1; }
    if (row.units.billableUnits !== null) { entry.billableUnits += row.units.billableUnits; entry.billableUnitEvidenceCount += 1; }
    if (row.units.costMicros !== null) { entry.costMicros += row.units.costMicros; entry.costMicrosEvidenceCount += 1; }
    if (row.sourceType === 'unavailable') entry.unavailableCount += 1;
    groups.set(key, entry);
  }
  return Object.freeze([...groups.values()].sort((a, b) => `${a.accountAlias}/${a.provider}/${a.lane}`.localeCompare(`${b.accountAlias}/${b.provider}/${b.lane}`)).map(value => Object.freeze({
    ...value, sourceTypeCounts: Object.freeze(value.sourceTypeCounts), terminalStatusCounts: Object.freeze(value.terminalStatusCounts), window: Object.freeze(value.window), waste: Object.freeze(value.waste)
  })));
}

// ACCOUNTS (a Set frozen at import) is deliberately GONE rather than kept as a
// compatibility alias: re-exporting it would leave the same trap armed for the
// next caller, who would have no way to see that the value was already stale.
// Callers ask accountRoster() when they need the answer.
module.exports = Object.freeze({ LANES, MeterError, OUTCOMES, PROVIDERS, REQUEST_CLASSES, ROSTER_STATES, SCHEMA_VERSION, SOURCE_TYPES, UNATTRIBUTED, UNAVAILABLE_REASONS, WASTE_REASONS, accountRoster, accountRosterFor, accountRosterOf, aggregate, isAccountRoster: isRoster, normalizeRecord });
