'use strict';

// Read-only projection of the bounded state written by tools/repo-sync.js.
// This module deliberately imports no Git/process helper: system.status and
// doctor must observe synchronization state without running Git or moving refs.

const fs = require('node:fs');
const path = require('node:path');
const { statePath } = require('./runtime-state-root');

const SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_STATE_BYTES = 32 * 1024;
// Per-user runtime data. See src/lib/runtime-state-root.js for why state/ does
// not resolve into an installed program's own directory.
const DEFAULT_STATE_FILE = statePath('state', 'repo-sync.json');
const SUCCESS_ACTIONS = new Set(['in-sync', 'fast-forward']);
const CONTAINMENT_STATUSES = new Set(['verified', 'stranded', 'unknown']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function bounded(value, limit) {
  const text = String(value == null ? '' : value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function baseStatus(stateFile) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'UNKNOWN',
    reason: null,
    detail: null,
    stateFile: path.resolve(stateFile),
    generatedAt: null,
    ageMs: null,
    // WHEN THE FILE WAS LAST WRITTEN, which is a different question from what
    // it says. An unusable record still proves that repo-sync last ran at
    // some point, and "it has not run for a week" is the single most useful
    // thing a reader can learn from one. These two fields come from the
    // filesystem, never from the record's body, so they are trustworthy even
    // when everything inside the file is refused.
    fileWrittenAtMs: null,
    fileAgeMs: null,
    branch: null,
    ahead: null,
    behind: null,
    lastAction: null,
    actionOk: null,
    dirtyPathCount: null,
    dirtyPaths: [],
    dirtyPathsTruncated: false,
    containment: {
      status: 'unknown',
      networkVerified: false,
      checkedRemotes: [],
      code: 'STATE_UNAVAILABLE',
      summary: 'repo-sync state is unavailable'
    },
    countsAreContainmentProof: false,
    contentTrust: 'untrusted',
    grantsAuthority: false
  };
}

// AN UNUSABLE RECORD IS NOT A CONTENTLESS ONE.
//
// Every rejection used to return `generatedAt: null, ageMs: null`, so
// "tools/repo-sync.js is emitting a broken record right now" and "no repo-sync
// has run for seven days and what is on disk predates this build" arrived at
// the operator as the identical bare UNKNOWN. Those need opposite responses --
// fix a writer, or register a task -- and on 2026-08-11 the second one cost a
// lane a hunt through the writer/reader contract for a bug that was not there.
//
// `provenance` carries only facts this reader established itself: the file's
// mtime, and `generatedAt` ONLY when the raw value passes the same canonical
// ISO test the healthy path applies. Nothing else from an invalid record's
// body travels outward -- `contentTrust` stays `untrusted` and
// `grantsAuthority` stays false, because a record that failed its schema
// cannot be allowed to describe the repository.
function unavailable(stateFile, reason, detail, provenance = {}) {
  const fileWrittenAtMs = isNonNegativeSafeInteger(provenance.fileWrittenAtMs)
    ? provenance.fileWrittenAtMs : null;
  const generatedAt = typeof provenance.generatedAt === 'string' ? provenance.generatedAt : null;
  return deepFreeze({
    ...baseStatus(stateFile),
    reason,
    detail: bounded(detail, 1000),
    fileWrittenAtMs,
    fileAgeMs: isNonNegativeSafeInteger(provenance.fileAgeMs) ? provenance.fileAgeMs : null,
    generatedAt,
    ageMs: generatedAt !== null && isNonNegativeSafeInteger(provenance.ageMs) ? provenance.ageMs : null
  });
}

// The provenance of a record we are about to refuse. `generatedAt` survives
// only if it is a canonical ISO string that is not in the future -- exactly the
// test readRepoSyncStatus() applies before it trusts a VALID record's stamp --
// so a hostile or corrupt stamp is dropped rather than reported as a time.
function refusedProvenance(parsed, fileWrittenAtMs, nowMs) {
  const provenance = {
    fileWrittenAtMs,
    fileAgeMs: isNonNegativeSafeInteger(fileWrittenAtMs) && nowMs >= fileWrittenAtMs
      ? nowMs - fileWrittenAtMs : null
  };
  const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.generatedAt : null;
  if (!isBoundedString(raw, 64)) return provenance;
  const generatedMs = Date.parse(raw);
  let canonical = false;
  try {
    canonical = Number.isFinite(generatedMs) && new Date(generatedMs).toISOString() === raw;
  } catch { /* a stamp we cannot round-trip is simply not reported */ }
  if (!canonical || generatedMs > nowMs || generatedMs < 0) return provenance;
  provenance.generatedAt = raw;
  provenance.ageMs = nowMs - generatedMs;
  return provenance;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNullableCount(value) {
  return value === null || isNonNegativeSafeInteger(value);
}

function isBoundedString(value, limit, { nullable = false } = {}) {
  return (nullable && value === null)
    || (typeof value === 'string' && value.length > 0 && value.length <= limit);
}

function validateContainment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!CONTAINMENT_STATUSES.has(value.status) || typeof value.networkVerified !== 'boolean') return false;
  if (!Array.isArray(value.checkedRemotes) || value.checkedRemotes.length > 20
    || value.checkedRemotes.some(remote => !isBoundedString(remote, 128))) return false;
  if (!isBoundedString(value.code, 128, { nullable: true }) || !isBoundedString(value.summary, 1024)) return false;
  if (value.status === 'verified' && value.networkVerified !== true) return false;
  return true;
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'STATE_SHAPE_INVALID';
  // A MISSING VERSION IS NOT VERSION 1, AND IT IS NOT A WRONG VERSION EITHER.
  //
  // tools/repo-sync.js only began stamping `schemaVersion` when R1162 added
  // the containment fields, so a record with no such field is a LEGACY record
  // written by an older receiver -- it means "nothing current has run here",
  // not "the writer produced something this build rejects". Both were
  // STATE_SCHEMA_UNSUPPORTED, which is why the 2026-08-04 record on this host
  // looked like a live writer defect for a week.
  //
  // The absence is still refused, and deliberately so: reading a missing
  // version as the current one would let a pre-containment record -- which
  // cannot carry `countsAreContainmentProof` or a containment verdict at all
  // -- be projected as a synchronization claim it never made.
  if (value.schemaVersion === undefined || value.schemaVersion === null) return 'STATE_SCHEMA_MISSING';
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) return 'STATE_SCHEMA_UNSUPPORTED';
  if (!isBoundedString(value.generatedAt, 64)) return 'STATE_GENERATED_AT_INVALID';
  if (!isBoundedString(value.action, 128) || typeof value.ok !== 'boolean') return 'STATE_ACTION_INVALID';
  if (!isBoundedString(value.detail, 1024)) return 'STATE_DETAIL_INVALID';
  if (!isBoundedString(value.branch, 256, { nullable: true })) return 'STATE_BRANCH_INVALID';
  if (!isNullableCount(value.ahead) || !isNullableCount(value.behind)) return 'STATE_COUNTS_INVALID';
  if (!isNonNegativeSafeInteger(value.dirtyPathCount)
    || !Array.isArray(value.dirtyPaths)
    || value.dirtyPaths.length > 50
    || value.dirtyPaths.some(item => !isBoundedString(item, 512))
    || typeof value.dirtyPathsTruncated !== 'boolean'
    || value.dirtyPathCount < value.dirtyPaths.length) return 'STATE_DIRTY_PATHS_INVALID';
  if (!validateContainment(value.containment)) return 'STATE_CONTAINMENT_INVALID';
  if (value.countsAreContainmentProof !== false) return 'STATE_CONTAINMENT_CLAIM_INVALID';
  if (value.ok !== SUCCESS_ACTIONS.has(value.action)) return 'STATE_ACTION_RESULT_MISMATCH';
  if (value.ok && value.containment.status !== 'verified') return 'STATE_SUCCESS_WITHOUT_CONTAINMENT';
  return null;
}

function readRepoSyncStatus({
  stateFile = DEFAULT_STATE_FILE,
  fsImpl = fs,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS
} = {}) {
  const resolvedStateFile = path.resolve(stateFile);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) {
    return unavailable(resolvedStateFile, 'READER_OPTIONS_INVALID', 'nowMs and maxAgeMs must be positive safe integers');
  }

  let size;
  let fileWrittenAtMs = null;
  try {
    const stat = fsImpl.statSync(resolvedStateFile);
    size = stat.size;
    // Math.floor, not Math.round: an mtime must never round forward past nowMs
    // and turn a fresh file into a negative age.
    const mtimeMs = Math.floor(Number(stat.mtimeMs));
    fileWrittenAtMs = isNonNegativeSafeInteger(mtimeMs) ? mtimeMs : null;
  } catch (error) {
    // existsSync() deliberately collapses every filesystem error to false.
    // Classify absence only from stat's explicit not-found result so an access,
    // I/O, or injected filesystem failure cannot claim the writer never ran.
    if (error && error.code === 'ENOENT') {
      return unavailable(resolvedStateFile, 'STATE_MISSING', 'repo-sync has not written its state file');
    }
    return unavailable(resolvedStateFile, 'STATE_UNREADABLE', error && error.message ? error.message : error);
  }
  if (!isNonNegativeSafeInteger(size) || size > MAX_STATE_BYTES) {
    return unavailable(resolvedStateFile, 'STATE_SIZE_INVALID',
      `repo-sync state is ${size} bytes; maximum is ${MAX_STATE_BYTES}`,
      refusedProvenance(null, fileWrittenAtMs, nowMs));
  }

  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(resolvedStateFile, 'utf8'));
  } catch (error) {
    return unavailable(resolvedStateFile, 'STATE_MALFORMED', error && error.message ? error.message : error,
      refusedProvenance(null, fileWrittenAtMs, nowMs));
  }

  const invalidReason = validateState(parsed);
  if (invalidReason) {
    const provenance = refusedProvenance(parsed, fileWrittenAtMs, nowMs);
    const written = provenance.generatedAt !== undefined
      ? `last written ${provenance.generatedAt}`
      : (provenance.fileAgeMs === null ? 'write time unknown' : `file last modified ${new Date(fileWrittenAtMs).toISOString()}`);
    const detail = invalidReason === 'STATE_SCHEMA_MISSING'
      ? `repo-sync state carries no schemaVersion, so it predates this build's receiver; ${written}, and no current repo-sync has run since`
      : `repo-sync state did not match the bounded schema; ${written}`;
    return unavailable(resolvedStateFile, invalidReason, detail, provenance);
  }

  const generatedMs = Date.parse(parsed.generatedAt);
  let generatedAtIsCanonical = false;
  try {
    generatedAtIsCanonical = Number.isFinite(generatedMs)
      && new Date(generatedMs).toISOString() === parsed.generatedAt;
  } catch { /* Invalid dates remain unavailable below. */ }
  if (!generatedAtIsCanonical || generatedMs > nowMs) {
    // refusedProvenance() applies the same canonical test that just failed, so
    // it will drop the stamp and report only the filesystem mtime here.
    return unavailable(resolvedStateFile, 'STATE_TIME_INVALID', 'generatedAt is invalid or in the future',
      refusedProvenance(parsed, fileWrittenAtMs, nowMs));
  }

  const ageMs = nowMs - generatedMs;
  const projected = {
    ...baseStatus(resolvedStateFile),
    status: ageMs > maxAgeMs ? 'STALE' : (parsed.ok ? 'SYNCED' : 'FAILED'),
    reason: ageMs > maxAgeMs ? 'STATE_STALE' : (parsed.ok ? null : 'LAST_ACTION_FAILED'),
    detail: parsed.detail,
    generatedAt: parsed.generatedAt,
    ageMs,
    fileWrittenAtMs,
    fileAgeMs: isNonNegativeSafeInteger(fileWrittenAtMs) && nowMs >= fileWrittenAtMs
      ? nowMs - fileWrittenAtMs : null,
    branch: parsed.branch,
    ahead: parsed.ahead,
    behind: parsed.behind,
    lastAction: parsed.action,
    actionOk: parsed.ok,
    dirtyPathCount: parsed.dirtyPathCount,
    dirtyPaths: [...parsed.dirtyPaths],
    dirtyPathsTruncated: parsed.dirtyPathsTruncated,
    containment: {
      status: parsed.containment.status,
      networkVerified: parsed.containment.networkVerified,
      checkedRemotes: [...parsed.containment.checkedRemotes],
      code: parsed.containment.code,
      summary: parsed.containment.summary
    }
  };
  return deepFreeze(projected);
}

module.exports = Object.freeze({
  DEFAULT_MAX_AGE_MS,
  DEFAULT_STATE_FILE,
  MAX_STATE_BYTES,
  SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  readRepoSyncStatus,
  validateState
});
