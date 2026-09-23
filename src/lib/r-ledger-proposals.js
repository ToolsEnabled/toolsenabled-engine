'use strict';

// A RULE AN AGENT SUGGESTED, WAITING FOR THE PERSON. With the switch on, an
// agent that is unsure whether something was a rule does not file it; what
// it may do is put the person's words where the person will see them and
// press Accept. This module is that waiting room.
//
// IT IS THE OWNER-CAPTURE SPOOL, REUSED, NOT A NEW STORE. owner-capture-spool.js
// already holds the guarantee that matters here -- the words reach the disk
// before anything else is attempted, per-entry files that cannot contend, and
// NOTHING IS EVER DELETED: accept moves the record to reconciled/ and decline
// marks it discarded with the reason, bytes kept either way. A second store
// with its own durability story would be a second place to lose the person's
// words, which is the defect that spool was written to end.
//
// WHERE IT LIVES. The spool derives its directory from the ledger file it is
// a write-ahead log FOR. The anchor here is state/r-ledger/R-PROPOSALS (a name,
// never written), so the spool lands at state/r-ledger/owner-capture-spool/ --
// beside the session/tree/thread ledgers and NOT under reports/, where
// status-injection.js nags every boot about the R1 owner-request spool. A
// proposal is not an unclassified owner turn and must not read as one.
//
// WHAT A RECORD CARRIES. The person's exact words (text), the scope and key
// the agent named, the agent (actor) that proposed it, and its one-line why.
// The ledger write on accept is INJECTED (a filer function), because the only
// product write path is the host's fileStandingRequest and this module must
// not become a second one; the engine test injects r-ledger.fileRequest.

const { rootPath } = require('./runtime');
const rLedger = require('./r-ledger');
const spool = require('./owner-capture-spool');

const PROPOSAL_MODE = 'r-ledger-proposal';
const MAX_WHY_CHARS = 300;

class RLedgerProposalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RLedgerProposalError';
    this.code = code;
  }
}

function anchorFile(options = {}) {
  const root = typeof options.rootPath === 'function' ? options.rootPath : rootPath;
  return root('state', 'r-ledger', 'R-PROPOSALS');
}

function normalizeWhy(why) {
  if (why === undefined || why === null) return null;
  if (typeof why !== 'string') throw new RLedgerProposalError('R_LEDGER_PROPOSAL_WHY_INVALID', 'why must be one line of text.');
  const trimmed = why.replace(/\s+/g, ' ').trim();
  if (trimmed.length > MAX_WHY_CHARS) throw new RLedgerProposalError('R_LEDGER_PROPOSAL_WHY_INVALID', `why must be at most ${MAX_WHY_CHARS} characters.`);
  return trimmed || null;
}

function normalizeActor(actor) {
  if (typeof actor !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(actor)) {
    throw new RLedgerProposalError('R_LEDGER_PROPOSAL_ACTOR_INVALID', 'the proposing agent must be named.');
  }
  return actor;
}

/* The public view of one record: what the rail and the chat note need and
   nothing that crosses a boundary (no file path, no pid). */
function view(record) {
  return Object.freeze({
    proposalId: record.name,
    scope: record.scope,
    key: record.threadId,
    words: record.text,
    why: record.proposal ? record.proposal.why : null,
    proposedBy: record.actor,
    proposedAt: record.spooledAt,
    outcome: record.ledgerOutcome
  });
}

/**
 * Spool one suggestion. Validates exactly what r-ledger.fileRequest would --
 * scope, key shape, words -- so a proposal that could never be filed is
 * refused now, to the agent, rather than at Accept, to the person.
 */
function propose({ actor, scope, key, words, why, now = () => new Date() }, options = {}) {
  const who = normalizeActor(actor);
  const scopeName = String(scope);
  if (!rLedger.SCOPES.includes(scopeName)) throw new rLedger.RLedgerError('R_LEDGER_SCOPE_INVALID', `scope must be one of ${rLedger.SCOPES.join(', ')}.`);
  // ledgerPath asserts the key shape for every non-global scope; its result
  // is the file the rule would land in, recorded so Accept needs no guess.
  const target = rLedger.ledgerPath(scopeName, key, options);
  if (typeof words !== 'string' || !words.trim()) throw new rLedger.RLedgerError('R_LEDGER_WORDS_EMPTY', 'the request is empty; nothing to propose.');
  if (/^## /m.test(words)) throw new rLedger.RLedgerError('R_LEDGER_WORDS_HEADING', 'a line starting with "## " would read as a new entry; reword it.');
  const reason = normalizeWhy(why);
  const handle = spool.writeAhead(anchorFile(options), {
    mode: PROPOSAL_MODE,
    id: null,
    text: words.replace(/\r\n/g, '\n').trim(),
    actor: who,
    source: 'r_ledger.propose',
    status: 'proposed',
    scope: scopeName,
    threadId: scopeName === 'global' ? null : key,
    provenanceClass: 'agent-proposal',
    proposal: { why: reason, target },
    now: now()
  });
  return view(handle.record);
}

function pendingHandles(options = {}) {
  return spool.listPending(anchorFile(options))
    .filter(record => record.mode === PROPOSAL_MODE)
    .map(record => {
      const { file, ...rest } = record;
      return { name: record.name, file, record: rest };
    });
}

/** Every suggestion the person has not yet answered, oldest first. */
function listPending(options = {}) {
  return Object.freeze(pendingHandles(options).map(handle => view(handle.record)));
}

function findPending(proposalId, options = {}) {
  if (typeof proposalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/.test(proposalId)) {
    throw new RLedgerProposalError('R_LEDGER_PROPOSAL_ID_INVALID', 'the proposal id is not one this spool issued.');
  }
  const handle = pendingHandles(options).find(entry => entry.name === proposalId);
  if (!handle) throw new RLedgerProposalError('R_LEDGER_PROPOSAL_NOT_PENDING', 'that suggestion is not waiting: it was already accepted, declined, or never existed.');
  return handle;
}

/**
 * The person pressed Accept. The RECORD's words are filed (never words the
 * caller re-supplies -- the person accepted what they were shown), through
 * the injected filer, attributed "proposed by <agent>, accepted by you"; then
 * the record moves to reconciled/ carrying the id it became.
 */
function accept({ proposalId, file, now = () => new Date() }, options = {}) {
  if (typeof file !== 'function') throw new RLedgerProposalError('R_LEDGER_PROPOSAL_FILER_REQUIRED', 'accept needs the one ledger write path injected.');
  const handle = findPending(proposalId, options);
  const record = handle.record;
  const filed = file({
    scope: record.scope,
    key: record.threadId,
    words: record.text,
    filedBy: `proposed by ${record.actor}, accepted by you`
  });
  // A filer that returns no revision has not established that the durable
  // ledger write completed. Keep the proposal pending rather than recording
  // the unknown outcome as a successful reconciliation with a null revision.
  if (!filed || typeof filed.id !== 'string' || !filed.id) {
    throw new RLedgerProposalError('R_LEDGER_PROPOSAL_FILING_UNCONFIRMED', 'the ledger filer did not confirm the filed revision; the suggestion remains pending.');
  }
  spool.markReconciled(handle, { revision: filed.id, now: now() });
  return Object.freeze({ proposal: view(record), filed });
}

/** The person pressed Decline. Nothing is filed; the record and reason stay. */
function decline({ proposalId, reason = 'declined by the person', now = () => new Date() }, options = {}) {
  const handle = findPending(proposalId, options);
  // Decline is a button the person pressed, which is the only thing that may
  // take a record out of the queue unfiled; the spool refuses a discard that
  // cannot say a person decided.
  spool.markDiscarded(handle, { reason, actor: 'person', decidedBy: spool.DISCARD_DECIDED_BY, now: now() });
  return Object.freeze({ proposal: view(handle.record), filed: null });
}

module.exports = Object.freeze({
  PROPOSAL_MODE,
  MAX_WHY_CHARS,
  RLedgerProposalError,
  anchorFile,
  propose,
  listPending,
  accept,
  decline
});
