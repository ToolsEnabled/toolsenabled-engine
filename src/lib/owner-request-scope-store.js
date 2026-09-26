'use strict';

// Q64/R173 persistence seam.  Scope rules are stored separately from the
// legacy owner-request ledger so loading this store never classifies old
// requests and never rewrites their verbatim text.  The append operation is a
// provenance/fence check, not an identity provider: the caller must already
// have obtained an owner-authored scope event through the appropriate owner
// boundary.  This module grants no launch, dashboard, outward, or acceptance
// authority.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { rootPath } = require('./runtime');
const { normalizeScopeRule } = require('./owner-request-scope');
const { isRequestId } = require('./request-id');
const { acquireLock } = require('./process-claim-lock');

const STORE_VERSION = 1;
const STORE_FILE_NAME = 'owner-request-scope-rules.json';
// Compatibility export only. Production reads resolve this path again at
// operation time through productionScopeStoreFile(), rather than capturing a
// machine-specific path in a caller or test fixture.
const DEFAULT_FILE = rootPath('state', STORE_FILE_NAME);
const MAX_RULES = 5000;

class OwnerRequestScopeStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OwnerRequestScopeStoreError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new OwnerRequestScopeStoreError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, allowed, required, label) {
  if (!plain(value)
      || Reflect.ownKeys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) {
    fail('OWNER_SCOPE_STORE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function productionStateDirectory(options = {}) {
  exact(options, ['stateDirectory'], [], 'production store options');
  const selected = options.stateDirectory === undefined ? rootPath('state') : options.stateDirectory;
  if (typeof selected !== 'string' || selected.length === 0) {
    fail('OWNER_SCOPE_STORE_INVALID', 'production state directory is invalid.');
  }
  return path.resolve(selected);
}

// The single production-path seam. Tests pass an isolated stateDirectory;
// production derives its state directory from runtime.rootPath() at the point
// of use. No caller needs, or may rely on, a user-specific literal path.
function productionScopeStoreFile(options = {}) {
  return path.join(productionStateDirectory(options), STORE_FILE_NAME);
}

function resolveFile(options = {}) {
  exact(options, ['file', 'stateDirectory'], [], 'store options');
  if (options.file !== undefined && options.stateDirectory !== undefined) {
    fail('OWNER_SCOPE_STORE_INVALID', 'store file and stateDirectory are mutually exclusive.');
  }
  const selected = options.file === undefined
    ? productionScopeStoreFile({ stateDirectory: options.stateDirectory })
    : options.file;
  if (typeof selected !== 'string' || selected.length === 0) {
    fail('OWNER_SCOPE_STORE_INVALID', 'store file is invalid.');
  }
  return path.resolve(selected);
}

/**
 * Bind the store API to one state directory without making that directory a
 * global. Production callers use the no-argument form; tests inject a private
 * temporary directory. The returned API owns no authority beyond the existing
 * read/append operations.
 */
function createScopeStore(options = {}) {
  const file = resolveFile(options);
  return Object.freeze({
    file,
    read: () => readScopeStore({ file }),
    append: input => appendScopeRule(input, { file })
  });
}

function emptyStore() {
  return Object.freeze({ schemaVersion: STORE_VERSION, revision: 0, rules: Object.freeze([]) });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/* THE REVIEWED-CORPUS WATERMARK.
 *
 * A classified projection asks one question of every gate: is there an active
 * reviewed rule for it?  "No" has always been answered the same way -- file the
 * gate as unresolved and stop acting on it.  But "no" covers two completely
 * different facts:
 *
 *   1. Reviewers looked at this request and produced no active rule for it
 *      (no verbatim on file, hedged, session-scoped without a thread id...).
 *      Holding that gate back is the fail-closed behaviour we want.
 *
 *   2. The request did not exist when the reviewers finished.  Nobody declined
 *      it; nobody saw it.
 *
 * Case 2 was being filed as case 1, so a single classification run silently
 * became an expiry date on the owner's voice: every directive recorded after it
 * dropped out of the active set on arrival, with no error, no count, and no
 * way for a reader to tell the two cases apart.
 *
 * The store therefore records WHAT WAS REVIEWED, not just the resulting rules.
 * `reviewedLedgerRevision` is the ledger revision the reviewed proposal was
 * built from; `reviewedRequestIds` is the exact set of request ids that corpus
 * contained.  The id set is stored rather than inferred from a high-water id
 * because request ids are not strictly append-ordered -- a dotted id such as
 * R1163.1 can be minted long after R1549 -- and inferring membership from an
 * ordering that does not hold would put a brand-new request back into case 1,
 * which is the bug.
 *
 * Both fields move together.  Half a watermark is worse than none: it would let
 * a reader believe membership had been checked when it could not have been.
 */
function normalizeReviewedWatermark(value) {
  const hasRevision = Object.hasOwn(value, 'reviewedLedgerRevision');
  const hasIds = Object.hasOwn(value, 'reviewedRequestIds');
  if (!hasRevision && !hasIds) return null;
  if (hasRevision !== hasIds) {
    fail('OWNER_SCOPE_STORE_INVALID', 'reviewedLedgerRevision and reviewedRequestIds must be recorded together.');
  }
  if (!Number.isSafeInteger(value.reviewedLedgerRevision) || value.reviewedLedgerRevision < 0) {
    fail('OWNER_SCOPE_STORE_INVALID', 'reviewedLedgerRevision is invalid.');
  }
  const ids = value.reviewedRequestIds;
  if (!Array.isArray(ids) || ids.length === 0
      || ids.some(id => !isRequestId(id, { family: 'R' }))) {
    fail('OWNER_SCOPE_STORE_INVALID', 'reviewedRequestIds must be a non-empty array of R request ids.');
  }
  if (new Set(ids).size !== ids.length) {
    fail('OWNER_SCOPE_STORE_AMBIGUOUS', 'reviewedRequestIds contains duplicates.');
  }
  return Object.freeze({
    reviewedLedgerRevision: value.reviewedLedgerRevision,
    reviewedRequestIds: Object.freeze([...ids])
  });
}

// Carry an existing watermark across a write that is not itself a review.
// An ordinary append adds a rule; it does not widen the corpus anybody read.
function reviewedWatermarkOf(store) {
  return store && Object.hasOwn(store, 'reviewedLedgerRevision')
    ? {
        reviewedLedgerRevision: store.reviewedLedgerRevision,
        reviewedRequestIds: [...store.reviewedRequestIds]
      }
    : {};
}

function normalizeStore(value) {
  exact(value,
    ['schemaVersion', 'revision', 'reviewedLedgerRevision', 'reviewedRequestIds', 'rules'],
    ['schemaVersion', 'revision', 'rules'], 'scope store');
  if (value.schemaVersion !== STORE_VERSION) {
    fail('OWNER_SCOPE_STORE_VERSION_UNSUPPORTED', 'scope store schemaVersion is unsupported.');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    fail('OWNER_SCOPE_STORE_INVALID', 'scope store revision is invalid.');
  }
  if (!Array.isArray(value.rules) || value.rules.length > MAX_RULES) {
    fail('OWNER_SCOPE_STORE_INVALID', 'scope store rules are invalid.');
  }
  const watermark = normalizeReviewedWatermark(value);
  const seen = new Set();
  const rules = value.rules.map(raw => {
    const rule = normalizeScopeRule(raw);
    if (seen.has(rule.ruleId)) fail('OWNER_SCOPE_STORE_AMBIGUOUS', `duplicate ruleId "${rule.ruleId}" in scope store.`);
    seen.add(rule.ruleId);
    return rule;
  });
  // Watermark before rules so a human opening the file sees which corpus the
  // rules below were drawn from without scrolling past a thousand entries.
  return Object.freeze({
    schemaVersion: STORE_VERSION,
    revision: value.revision,
    ...(watermark || {}),
    rules: Object.freeze(rules)
  });
}

function readScopeStore(options = {}) {
  const file = resolveFile(options);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyStore();
    fail('OWNER_SCOPE_STORE_UNAVAILABLE', 'scope store could not be read.');
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { fail('OWNER_SCOPE_STORE_INVALID', 'scope store JSON is invalid.'); }
  return normalizeStore(parsed);
}

function writeAtomic(store, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (error && error.code === 'EEXIST') fail('OWNER_SCOPE_STORE_BUSY', 'scope store temporary file already exists.');
    fail('OWNER_SCOPE_STORE_WRITE_FAILED', 'scope store could not be written.');
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* atomic rename already consumed it */ }
  }
}

function withLock(file, work) {
  // Unique process claims serialize recovery as well as writes. The fixed
  // compatibility record alone is not a mutex: a delayed stale reader could
  // otherwise unlink the next owner's replacement and acknowledge lost data.
  let lock;
  try { lock = acquireLock(`${file}.lock`); }
  catch { fail('OWNER_SCOPE_STORE_BUSY', 'scope store is busy; retry later.'); }
  try { return work(); }
  finally {
    try { lock.release(); }
    catch {
      fail('OWNER_SCOPE_STORE_BUSY', 'scope store lock could not be released; read its current state before retrying.');
    }
  }
}

/**
 * Append one explicit scope rule under a revision fence.  A replay of the
 * exact same rule/event is idempotent; a different payload cannot reuse the
 * rule id.  `ownerEventRef` is intentionally a reference, not a claim that
 * this low-level module authenticated the owner.
 */
function appendScopeRule(input, options = {}) {
  exact(input, ['rule', 'ownerEventRef', 'expectedRevision'], ['rule', 'ownerEventRef'], 'scope append');
  exact(options, ['file'], [], 'store options');
  const rule = normalizeScopeRule(input.rule);
  if (!isRequestId(input.ownerEventRef, { family: 'R' })
      || input.ownerEventRef !== rule.sourceRequestId) {
    fail('OWNER_SCOPE_STORE_PROVENANCE_REQUIRED', 'ownerEventRef must match rule.sourceRequestId.');
  }
  if (input.expectedRevision !== undefined
      && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) {
    fail('OWNER_SCOPE_STORE_INVALID', 'expectedRevision is invalid.');
  }
  const file = resolveFile(options);
  return withLock(file, () => {
    const current = readScopeStore({ file });
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      fail('OWNER_SCOPE_STORE_REVISION_CONFLICT', 'scope store revision does not match expectedRevision.', {
        expectedRevision: input.expectedRevision, actualRevision: current.revision
      });
    }
    const existing = current.rules.find(candidate => candidate.ruleId === rule.ruleId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(rule)) {
        fail('OWNER_SCOPE_STORE_AMBIGUOUS', `ruleId "${rule.ruleId}" already has a different payload.`);
      }
      return Object.freeze({ schemaVersion: STORE_VERSION, revision: current.revision, rule: existing, replayed: true, durable: true });
    }
    if (current.rules.length >= MAX_RULES) fail('OWNER_SCOPE_STORE_FULL', 'scope store is full.');
    // An append must not drop the reviewed-corpus watermark: doing so would
    // re-arm the exact silent-expiry bug this store now guards against.
    const next = normalizeStore({
      schemaVersion: STORE_VERSION,
      revision: current.revision + 1,
      ...reviewedWatermarkOf(current),
      rules: [...current.rules, rule]
    });
    writeAtomic(next, file);
    const verified = readScopeStore({ file });
    if (verified.revision !== next.revision || !verified.rules.some(candidate => candidate.ruleId === rule.ruleId)) {
      fail('OWNER_SCOPE_STORE_WRITE_FAILED', 'scope store read-back verification failed.');
    }
    return Object.freeze({ schemaVersion: STORE_VERSION, revision: verified.revision, rule, replayed: false, durable: true });
  });
}

/**
 * P4's one-time reviewed import. The caller authenticates the review receipt;
 * this lower persistence seam independently fences the exact prior store bytes
 * and revision, validates every proposed rule, and commits the complete rule
 * array once under the existing lock. It is never a merge or partial append.
 */
function replaceScopeRulesFromReviewedProposal(input, options = {}) {
  exact(input,
    ['rules', 'expectedRevision', 'expectedStoreSha256', 'proposalSha256',
      'reviewedLedgerRevision', 'reviewedRequestIds'],
    ['rules', 'expectedRevision', 'expectedStoreSha256', 'proposalSha256',
      'reviewedLedgerRevision', 'reviewedRequestIds'], 'reviewed scope import');
  exact(options, ['file'], [], 'store options');
  if (!Array.isArray(input.rules) || input.rules.length > MAX_RULES
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || typeof input.expectedStoreSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedStoreSha256)
      || typeof input.proposalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.proposalSha256)) {
    fail('OWNER_SCOPE_STORE_INVALID', 'reviewed scope import is invalid.');
  }
  // The watermark is REQUIRED here, not optional. This is the only path that
  // makes a review durable, so it is the only place that can honestly say which
  // corpus was reviewed. An import that cannot say leaves every later directive
  // indistinguishable from one the reviewers rejected.
  const watermark = normalizeReviewedWatermark(input);
  const normalizedRules = input.rules.map(normalizeScopeRule);
  const ruleIds = normalizedRules.map(rule => rule.ruleId);
  if (new Set(ruleIds).size !== ruleIds.length) {
    fail('OWNER_SCOPE_STORE_AMBIGUOUS', 'reviewed scope import contains duplicate rule ids.');
  }
  const file = resolveFile(options);
  return withLock(file, () => {
    let raw;
    let exists = true;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error?.code !== 'ENOENT') fail('OWNER_SCOPE_STORE_UNAVAILABLE', 'scope store could not be read.');
      exists = false;
      raw = null;
    }
    const currentSha256 = sha256(exists ? raw : 'absent');
    let current;
    try { current = exists ? normalizeStore(JSON.parse(raw)) : emptyStore(); }
    catch (error) {
      if (error instanceof OwnerRequestScopeStoreError) throw error;
      fail('OWNER_SCOPE_STORE_INVALID', 'scope store JSON is invalid.');
    }
    if (current.revision !== input.expectedRevision || currentSha256 !== input.expectedStoreSha256) {
      fail('OWNER_SCOPE_STORE_REVISION_CONFLICT', 'scope store bytes or revision changed after proposal generation.', {
        expectedRevision: input.expectedRevision,
        actualRevision: current.revision,
        expectedStoreSha256: input.expectedStoreSha256,
        actualStoreSha256: currentSha256
      });
    }
    // Replay means "this exact review is already durable" -- which now includes
    // the corpus it covered. Identical rules under a wider corpus is a real
    // change and must still be written, or a re-review that only widened what
    // was read would report success while changing nothing.
    if (JSON.stringify(current.rules) === JSON.stringify(normalizedRules)
        && JSON.stringify(reviewedWatermarkOf(current)) === JSON.stringify({
          reviewedLedgerRevision: watermark.reviewedLedgerRevision,
          reviewedRequestIds: [...watermark.reviewedRequestIds]
        })) {
      return Object.freeze({
        schemaVersion: STORE_VERSION,
        revision: current.revision,
        ruleCount: current.rules.length,
        reviewedLedgerRevision: current.reviewedLedgerRevision,
        reviewedRequestCount: current.reviewedRequestIds.length,
        proposalSha256: input.proposalSha256,
        replayed: true,
        durable: true
      });
    }
    const next = normalizeStore({
      schemaVersion: STORE_VERSION,
      revision: current.revision + 1,
      reviewedLedgerRevision: watermark.reviewedLedgerRevision,
      reviewedRequestIds: [...watermark.reviewedRequestIds],
      rules: normalizedRules
    });
    writeAtomic(next, file);
    const verified = readScopeStore({ file });
    if (verified.revision !== next.revision
        || JSON.stringify(verified.rules) !== JSON.stringify(next.rules)
        || JSON.stringify(reviewedWatermarkOf(verified)) !== JSON.stringify(reviewedWatermarkOf(next))) {
      fail('OWNER_SCOPE_STORE_WRITE_FAILED', 'reviewed scope import read-back verification failed.');
    }
    return Object.freeze({
      schemaVersion: STORE_VERSION,
      revision: verified.revision,
      ruleCount: verified.rules.length,
      reviewedLedgerRevision: verified.reviewedLedgerRevision,
      reviewedRequestCount: verified.reviewedRequestIds.length,
      proposalSha256: input.proposalSha256,
      replayed: false,
      durable: true
    });
  });
}

module.exports = Object.freeze({
  OwnerRequestScopeStoreError,
  STORE_VERSION,
  STORE_FILE_NAME,
  DEFAULT_FILE,
  MAX_RULES,
  productionStateDirectory,
  productionScopeStoreFile,
  createScopeStore,
  normalizeStore,
  reviewedWatermarkOf,
  readScopeStore,
  appendScopeRule,
  replaceScopeRulesFromReviewedProposal
});
