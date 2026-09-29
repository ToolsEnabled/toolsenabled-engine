'use strict';

const crypto = require('node:crypto');
const storeDefault = require('./owner-request-store');
const promptsDefault = require('./mission-bridge/owner-prompts');
const KINDS = new Set(['R', 'T', 'A', 'P']);
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function assertInput(kind, actor) {
  if (actor !== 'owner') fail('R_LEDGER_RESET_OWNER_REQUIRED', 'Only the owner may reset a Ledger category.');
  if (!KINDS.has(kind)) fail('R_LEDGER_KIND_INVALID', 'kind must be R, T, A or P.');
}
function dependencies(options) {
  return { store: options.store || storeDefault, prompts: options.prompts || promptsDefault,
    ledger: options.ledger || options, prompt: options.prompt || options };
}
// The challenge fences the warning's count; owner authority is checked separately.
function challenge(kind, revision, promptIds) {
  return crypto.createHash('sha256').update(JSON.stringify({ kind, revision, promptIds })).digest('hex');
}
function pendingPreview(journal) {
  return Object.freeze({ kind: 'P', count: journal.count, revision: journal.revision,
    token: journal.token, promptCount: journal.promptIds.length, pending: true, batchId: journal.batchId });
}
function preview({ kind, actor } = {}, options = {}) {
  assertInput(kind, actor);
  const { store, prompts, ledger, prompt } = dependencies(options);
  const pending = kind === 'P' ? prompts.pendingLedgerReset(prompt) : null;
  if (pending) return pendingPreview(pending);
  const base = store.previewResetKind({ kind, actor }, ledger);
  const promptIds = kind === 'P'
    ? prompts.snapshot(prompt).prompts.filter(row => row.kind === 'purchase_batch').map(row => row.id).sort() : [];
  return Object.freeze({ kind, count: base.count, revision: base.revision,
    token: challenge(kind, base.revision, promptIds), ...(kind === 'P' ? { promptCount: promptIds.length } : {}) });
}
function pendingResult(journal, error, canonical) {
  return Object.freeze({ kind: 'P', count: journal.count, revision: journal.revision,
    batchId: journal.batchId, promptCount: journal.promptIds.length,
    ...(canonical ? { canonicalRevision: canonical.revision } : {}), ok: false, pending: true,
    code: error?.code || 'OWNER_PROMPT_STORE_UNAVAILABLE',
    reason: 'This purchase reset is unfinished. Retry to finish the same reset; purchases added afterwards will stay.' });
}
function confirmPurchase(input, options) {
  const { kind, actor, revision, token } = input;
  const { store, prompts, ledger, prompt } = dependencies(options);
  let journal = prompts.ledgerReset(token, prompt);
  if (journal && journal.revision !== revision) fail('R_LEDGER_RESET_STALE', 'This reset confirmation changed. Reopen the reset warning.');
  if (!journal) {
    // Validate one snapshot and carry those exact IDs into locked capture.
    const base = store.previewResetKind({ kind, actor }, ledger);
    const ids = prompts.snapshot(prompt).prompts.filter(row => row.kind === 'purchase_batch').map(row => row.id).sort();
    if (base.revision !== revision || challenge(kind, base.revision, ids) !== token) {
      fail('R_LEDGER_RESET_STALE', 'The Ledger changed. Review the current reset count.');
    }
    if (base.count === 0 && ids.length === 0) fail('R_LEDGER_RESET_EMPTY', 'There are no purchases to reset.');
    journal = prompts.beginLedgerReset({ token, canonicalToken: base.token, batchId: crypto.randomUUID(),
      promptIds: ids, revision, count: base.count }, prompt);
  }
  let canonical;
  if (journal.phase === 'captured') {
    try {
      canonical = store.resetKind({ kind, actor, revision: journal.revision,
        token: journal.canonicalToken, batchId: journal.batchId }, ledger);
    } catch (error) {
      // A write can fail after the canonical rename. Resume only a verified
      // receipt for this batch; an unreadable outcome must keep prompts held.
      try { canonical = store.resetBatchResult(kind, journal.batchId, ledger); }
      catch (inspectionError) { return pendingResult(journal, inspectionError); }
      if (!canonical && error.code === 'R_LEDGER_RESET_EMPTY' && journal.count === 0) {
        canonical = { count: 0, revision: journal.revision };
      }
      if (!canonical) {
        try { prompts.abortLedgerReset({ token }, prompt); }
        catch (abortError) { return pendingResult(journal, abortError); }
        return Object.freeze({ kind, ok: false, pending: false, aborted: true, count: 0,
          code: error.code || 'R_LEDGER_RESET_STALE',
          reason: 'This reset could not be saved. Close this warning and review the current Ledger count.' });
      }
    }
    try { journal = prompts.markLedgerResetCanonical({ token, count: canonical.count, revision: canonical.revision }, prompt); }
    catch (error) { return pendingResult(journal, error, canonical); }
  }
  try {
    const settled = prompts.completeLedgerReset({ token }, prompt);
    return Object.freeze({ kind, count: journal.count, batchId: journal.batchId,
      revision: journal.canonicalRevision, promptCount: journal.promptIds.length, ...settled, ok: true, pending: false });
  } catch (error) { return pendingResult(journal, error, canonical); }
}
function confirm(input = {}, options = {}) {
  const { kind, actor, revision, token } = input;
  assertInput(kind, actor);
  if (!Number.isSafeInteger(revision) || revision < 0 || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    fail('R_LEDGER_RESET_STALE', 'This reset confirmation is invalid. Reopen the reset warning.');
  }
  const { store, prompts, ledger, prompt } = dependencies(options);
  if (kind === 'P') {
    // Serializes complete attempts across processes, including outcome checks
    // and aborts. It does not hold the prompt lock while taking the ledger lock.
    return prompts.exclusiveLedgerReset(() => confirmPurchase(input, options), prompt);
  }
  const fresh = store.previewResetKind({ kind, actor }, ledger);
  if (fresh.revision !== revision || token !== challenge(kind, revision, [])) {
    fail('R_LEDGER_RESET_STALE', 'This reset confirmation is stale. Review the current count and try again.');
  }
  return Object.freeze({ ...store.resetKind({ kind, actor, revision, token: fresh.token }, ledger), ok: true, pending: false });
}
module.exports = Object.freeze({ preview, confirm });
