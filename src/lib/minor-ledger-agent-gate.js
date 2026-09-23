'use strict';

// THE AUDIT DOOR FOR TASK (T) AND ASK (A) LEDGER TOOLS -- built the way
// r_ledger.file is built (r-ledger-agent-gate.js): audit intent is required
// before every write and refused unless it comes back durable (the
// providers/research.js posture -- a write nobody can later find is a write
// nobody authorised), every refusal is a typed OwnerRequestStoreError code an
// agent can act on, and no refusal here says only "no": completeTask's,
// removeTask's and fileTask's/fileAsk's own store-level messages already name
// the next move (R_LEDGER_STATUS_INVALID, R_LEDGER_ENTRY_UNKNOWN,
// R_LEDGER_SCOPE_INVALID, R_LEDGER_KEY_INVALID each say what was wrong), so
// this door adds nothing on top of them beyond the audit requirement itself.
//
// WHAT THIS GATE DELIBERATELY DOES NOT CARRY, UNLIKE r_ledger.file'S OWN GATE.
// A standing rule is filed IN THE PERSON'S OWN WORDS and stands for what they
// said, which is why r-ledger-agent-gate.js reads a settings row
// (rules.capture_spoken) before allowing it, and checks the words against the
// person's own spooled turns before filing them. A task is an agent's own
// worklist item and an ask is an agent's own question -- neither is a claim
// about what the person said (LEDGER-KINDS-INTERFACE-20260907.md, TOOLS: "T
// and A words are the agent's own and must still pass the secret-shape
// refusal"), so there is no settings door here and no verbatim check. A
// purchase (P) is routed separately, straight through owner-request-store.js
// from the existing purchase.request / purchase.decision / pay.record tools
// (tool-registry.js), because those tools already carry their own
// owner-approval gate (purchase-authority.js) and re-gating them here would
// be a second, competing decision over the same money.
//
// THE ACTOR IS TRANSPORT-BOUND, NOT AGENT-CHOSEN. t_ledger.file/complete/
// remove and a_ledger.file are added to src/mcp-server.js's
// R_LEDGER_ACTOR_BOUND_TOOLS exactly as r_ledger.file/propose are: the
// `actor` argument must equal the principal this MCP transport was started
// as, so the name on a T or A record's head line is never a name the agent
// claims for itself.
//
// L3d -- "asks and purchases: agent closable" (the owner's ruling, verbatim,
// relayed 2026-09-07). a_ledger.answer, a_ledger.decline and p_ledger.decide
// close the loop the person's own words opened: an agent that filed an ask,
// or a purchase list waiting on a decision, can now settle it itself instead
// of the record sitting open until the person visits the Ledger page. This
// widens WHO may call answerAsk/declineAsk/decidePurchase (the store's own
// L1h change: those three drop their person-only gate and journal whichever
// actor the call names, exactly as decidePurchase already does for the
// standing outward-spend setting) -- it does not touch removeAsk or
// removePurchase, which stay owner-only, and it never widens R.
//
// p_ledger.decide MOVES THE LEDGER MIRROR ONLY. Spend authority is, and
// remains, purchase-authority.js's assertSpendAuthorized reading the owner's
// OWN settled decision on the prompt (mission-bridge/owner-prompts.js) --
// neither of those two files, nor providers/pay.js, ever reads a P record's
// status or decision field. Re-verified this turn by two independent
// methods: (1) a grep of purchase-authority.js, providers/pay.js,
// mission-bridge/purchase-recording.js and mission-bridge/owner-prompts.js
// for any read of owner-request-store's returned status/decision that feeds
// a spend decision -- purchase-authority.js and pay.js never require
// owner-request-store at all (zero hits); purchase-recording.js requires it
// only to WRITE the mirror after payApi.recordSpend() has already run,
// reading `ledger.findRecord(...).status` solely to make its OWN mirror
// write idempotent (never to decide whether to spend); owner-prompts.js
// never requires it either. (2) the require graph: of those four files,
// only purchase-recording.js requires owner-request-store, and every read it
// performs on the returned record happens strictly after the spend outcome
// is already computed. So p_ledger.decide changes what the Ledger page shows
// for a P record; it can never authorise or block a charge.

// T and A words are the agent's own, never a claim about what the person
// said, so they skip r_ledger.file's settings gate and its
// verbatim-against-the-person's-turns check -- but LEDGER-KINDS-INTERFACE-
// 20260907.md is explicit that they "must still pass the secret-shape
// refusal". Reusing r-ledger-agent-gate.js's own judgement (rather than a
// second definition of "looks like a secret") keeps one answer to that
// question in this program, exactly as its own header promises for the audit
// scrubber.
const { looksSecretShaped } = require('./r-ledger-agent-gate');
const { normalizeWaitingFor } = require('./task-waiting');

class MinorLedgerAgentControl {
  constructor(dependencies = {}) {
    this.auditRequire = dependencies.auditRequire || ((...args) => require('./audit').requireRecord(...args));
    this.auditRequireAsync = dependencies.auditRequireAsync || dependencies.auditRequire
      || ((...args) => require('./audit-admission').requireRecordAsync(...args));
    this.store = dependencies.store || require('./owner-request-store');
    this.ledgerOptions = dependencies.ledgerOptions || {};
    this.scrub = dependencies.scrub || null;
    this.loadSettings = dependencies.loadSettings || (() => require('./settings').loadSettings());
  }

  // Uses the installation-owned store, with no caller-supplied path or write.
  read(args = {}) {
    const all = this.store.readAll({
      ...this.ledgerOptions, kinds: args.kinds || ['R', 'T', 'A', 'P'],
      includeRemoved: args.removed === true, includeProposed: true
    });
    const records = all.records.filter(record =>
      (!args.id || record.id === args.id)
      && (!args.scope || record.scope === args.scope)
      && (!args.key || record.scopeKey === args.key)
      && (!args.status || record.status === args.status));
    const offset = args.offset || 0;
    const limit = args.limit || 25;
    const page = records.slice(offset, offset + limit).map(record => {
      const { gates, captureLog, provenance, history, ...fields } = record;
      return { ...fields, historyCount: history.length, gateCount: gates.length };
    });
    const { head, ...chain } = require('./runtime-policy').runtimePolicy({ loadSettings: this.loadSettings }).verifyHistory
      ? this.store.verifyHistory(this.ledgerOptions)
      : { checked: false, ok: null, reason: 'history-verification-not-enabled' };
    return Object.freeze({
      exists: all.exists, revision: all.revision, updatedAt: all.updatedAt,
      total: records.length, offset,
      nextOffset: offset + page.length < records.length ? offset + page.length : null,
      records: page, chain, grantsAuthority: false
    });
  }

  _checkWords(words) {
    if (looksSecretShaped(words, { scrub: this.scrub })) {
      throw new this.store.OwnerRequestStoreError(
        'R_LEDGER_WORDS_REFUSED',
        'Those words look like a password, key or token, so they were not filed. Tell the person you did not file them.'
      );
    }
  }

  _audit(action, target, details) {
    if (!require('./operation-audit').configured({ loadSettings: this.loadSettings })) return require('./operation-audit').skippedStatus(action, target);
    return this._requireAudit(this.auditRequire(action, target, details));
  }

  _requireAudit(intent) {
    if (!intent || intent.durable !== true) {
      throw new this.store.OwnerRequestStoreError(
        'R_LEDGER_AUDIT_REQUIRED',
        'This was not recorded because its audit intent was not durably recorded. Tell the person what you tried to do; nothing was written.'
      );
    }
    return intent;
  }

  /* The id-kind check runs BEFORE the store, using the store's own
   * KIND_ID_RE -- the same grammar the store enforces internally, checked
   * here first so a wrong-kind id (a T id handed to a_ledger.answer, an A id
   * handed to p_ledger.decide) is refused without ever taking the ledger's
   * transact() lock. Same code the store itself would use for the same
   * defect (R_LEDGER_ID_INVALID), so a caller never has to learn two
   * spellings of "that id is the wrong shape." */
  _checkKind(kind, id) {
    const pattern = this.store.KIND_ID_RE && this.store.KIND_ID_RE[kind];
    if (!pattern || typeof id !== 'string' || !pattern.test(id)) {
      const label = (this.store.KIND_LABEL && this.store.KIND_LABEL[kind]) || kind;
      throw new this.store.OwnerRequestStoreError(
        'R_LEDGER_ID_INVALID',
        `${label} ids look like ${kind}1, ${kind}2, ... ("${id}" is not one).`
      );
    }
  }

  /** t_ledger.file: file one of this agent's own task records -- recurring or
   *  one-shot. Any actor may; it lands 'open' (or 'recurring') at once -- a
   *  task has no owner-approval wait, unlike a standing rule. */
  file(args) {
    const recurring = Boolean(args.recurrence);
    this._audit('t_ledger.file', `t-ledger:${args.scope}`, { actor: args.actor, scope: args.scope, recurring });
    this._checkWords(args.words);
    const filed = this.store.fileTask({
      scope: args.scope, key: args.key, words: args.words, filedBy: args.actor, why: args.why,
      recurrence: recurring ? { interval: args.recurrence.interval } : null,
      ...(args.difficulty === undefined ? {} : { difficulty: args.difficulty })
    }, this.ledgerOptions);
    return Object.freeze({
      filed: true, id: filed.id, status: filed.status, filedBy: filed.filedBy,
      note: `Filed ${filed.id} -- a ${recurring ? 'recurring' : 'one-shot'} task${recurring ? ` (repeats: ${args.recurrence.interval})` : ''}. `
        + 'Tell the person what you filed; they see it, and can remove it, on the Ledger page.'
    });
  }

  /** t_ledger.review: record one factual review of a task. The store owns
   * idempotency, the cumulative count, regrading and journal history. The
   * public gate deliberately accepts no clock, setting, count or prior-review
   * controls; the authoritative store supplies its own time and policy. */
  review(args = {}) {
    const { id, reviewId, outcome, reason, actor } = args;
    this._audit('t_ledger.review', `t-ledger:${id}`, { actor, reviewId, outcome });
    this._checkWords(reason);
    const reviewed = this.store.recordTaskReview(
      { id, reviewId, outcome, reason, actor },
      this.ledgerOptions
    );
    if (!reviewed || typeof reviewed !== 'object' || Array.isArray(reviewed)
      || typeof reviewed.then === 'function') {
      throw new this.store.OwnerRequestStoreError(
        'R_LEDGER_REVIEW_RESULT_INVALID',
        'The task review was not reported as durably recorded; nothing was reported as reviewed.'
      );
    }
    const returnedReviewId = reviewed.reviewId;
    const returnedOutcome = reviewed.outcome;
    const hasDifficulty = Object.prototype.hasOwnProperty.call(reviewed, 'difficulty');
    const difficultyValid = !hasDifficulty
      || ['easy', 'medium', 'hard'].includes(reviewed.difficulty);
    const regrade = reviewed.regrade;
    const regradeValid = regrade === null || (
      regrade && typeof regrade === 'object' && !Array.isArray(regrade)
      && ['easy', 'medium', 'hard'].includes(regrade.from)
      && ['easy', 'medium', 'hard'].includes(regrade.to)
      && Number.isSafeInteger(regrade.failedReviewCount)
      && regrade.failedReviewCount >= 0
      && typeof regrade.reason === 'string' && regrade.reason.length > 0
    );
    if (reviewed.reviewed !== true
      || typeof reviewed.changed !== 'boolean'
      || typeof reviewed.replayed !== 'boolean'
      || reviewed.changed === reviewed.replayed
      || reviewed.id !== id
      || returnedReviewId !== reviewId
      || !['passed', 'failed'].includes(returnedOutcome)
      || returnedOutcome !== outcome
      || typeof reviewed.status !== 'string' || reviewed.status.length === 0
      || !Number.isSafeInteger(reviewed.revision) || reviewed.revision < 0
      || typeof reviewed.recordedAt !== 'string' || reviewed.recordedAt.length === 0
      || !difficultyValid || !regradeValid) {
      throw new this.store.OwnerRequestStoreError(
        'R_LEDGER_REVIEW_RESULT_INVALID',
        'The task review returned an incomplete, mismatched or non-flat result; nothing was reported as reviewed.'
      );
    }
    if (!Number.isSafeInteger(reviewed.failedReviewCount) || reviewed.failedReviewCount < 0) {
      throw new this.store.OwnerRequestStoreError(
        'R_LEDGER_REVIEW_COUNT_INVALID',
        'The task review returned no valid cumulative failed-review count; nothing was reported as reviewed.'
      );
    }
    const response = {
      reviewed: reviewed.reviewed,
      changed: reviewed.changed,
      replayed: reviewed.replayed,
      id: reviewed.id,
      reviewId: reviewed.reviewId,
      outcome: reviewed.outcome,
      status: reviewed.status,
      failedReviewCount: reviewed.failedReviewCount,
      revision: reviewed.revision,
      recordedAt: reviewed.recordedAt,
      regrade: reviewed.regrade
    };
    if (hasDifficulty) response.difficulty = reviewed.difficulty;
    return Object.freeze(response);
  }

  async progress(args = {}) {
    const { id, status, reason, actor } = args;
    const hasWaitingFor = Object.prototype.hasOwnProperty.call(args, 'waitingFor');
    // Snapshot and normalize the optional field before the asynchronous audit
    // admission. The same copied value is audited and persisted, so a
    // caller cannot mutate a submitted dependency list while the audit door is
    // awaiting its durable intent.
    const waitingFor = hasWaitingFor ? normalizeWaitingFor(args.waitingFor) : undefined;
    const auditDetails = { actor, status, ...(hasWaitingFor ? { waitingFor } : {}) };
    // Progress runs inside the desktop owner host. Use its existing audit
    // engine admission worker, while still awaiting durable, anchored intent
    // before the ledger mutation. The admission helper preserves strict-mode
    // behavior.
    if (require('./operation-audit').configured({ loadSettings: this.loadSettings })) {
      this._requireAudit(await this.auditRequireAsync('t_ledger.progress', `t-ledger:${id}`, auditDetails));
    }
    this._checkWords(reason);
    const storeArgs = { id, status, reason, actor };
    if (hasWaitingFor) storeArgs.waitingFor = waitingFor;
    const progress = this.store.progressTask(storeArgs, this.ledgerOptions);
    return Object.freeze({ updated: true, id: progress.id, status: progress.status, note: `${progress.id}: task checkpoint recorded.` });
  }

  /** t_ledger.complete: complete one task. A one-shot task lands 'done'; a
   *  recurring task stays 'recurring' and logs the completion. */
  complete(args) {
    this._audit('t_ledger.complete', `t-ledger:${args.id}`, { actor: args.actor });
    const completed = this.store.completeTask({ id: args.id, actor: args.actor }, this.ledgerOptions);
    return Object.freeze({
      completed: true, id: completed.id, status: completed.status,
      note: completed.status === 'recurring'
        ? `${completed.id} is recorded done for now; the same record stays open (recurring) and logs this completion.`
        : `${completed.id} is done.`
    });
  }

  /** t_ledger.remove: tombstone one task, any status, any actor. */
  remove(args) {
    this._audit('t_ledger.remove', `t-ledger:${args.id}`, { actor: args.actor });
    const removed = this.store.removeTask({ id: args.id, actor: args.actor }, this.ledgerOptions);
    return Object.freeze({ removed: true, id: removed.id, status: removed.status, note: `${removed.id} was removed.` });
  }

  /** a_ledger.file: file one durable ask, waiting for the person to answer on
   *  the Ledger page. Distinct from system.ask (a live yes/no dialog, an
   *  interruption answered now or not at all): a_ledger.file is for a
   *  question that can wait -- it never blocks this turn, it just stands on
   *  the Ledger page until the person gets to it. */
  fileAsk(args) {
    this._audit('a_ledger.file', `a-ledger:${args.scope}`, { actor: args.actor, scope: args.scope });
    this._checkWords(args.words);
    const filed = this.store.fileAsk({ scope: args.scope, key: args.key, words: args.words, filedBy: args.actor, why: args.why }, this.ledgerOptions);
    return Object.freeze({
      filed: true, id: filed.id, status: filed.status, filedBy: filed.filedBy,
      note: `Filed ${filed.id} -- a durable ask waiting for the person to answer on the Ledger page (not a live dialog; check back later).`
    });
  }

  /** a_ledger.answer: close one open ask with an answer, in this agent's own
   *  words. Agent-closable per the owner's ruling ("asks and purchases:
   *  agent closable") -- the actor journalled is the calling agent, not the
   *  person, so an answer here is never mistaken for the person's own words
   *  the way a_ledger.file's words already are not. */
  _assertAskDecisionAllowed() {
    let settings;
    try { settings = this.loadSettings(); } catch { settings = null; }
    if (!settings || settings.values?.['agent.close_asks'] === false || (settings.rejected || []).some(row => row && ['*', 'agent.close_asks'].includes(row.id))) {
      throw Object.assign(new Error('You have reserved answering and closing ledger asks for yourself.'), { code: 'AGENT_ASK_DECISION_DISABLED' });
    }
  }

  answer(args) {
    this._assertAskDecisionAllowed();
    this._checkKind('A', args.id);
    this._audit('a_ledger.answer', `a-ledger:${args.id}`, { actor: args.actor });
    this._checkWords(args.words);
    const answered = this.store.answerAsk({ id: args.id, answer: args.words, actor: args.actor }, this.ledgerOptions);
    return Object.freeze({
      answered: true, id: answered.id, status: answered.status,
      note: `${answered.id} is answered.`
    });
  }

  /** a_ledger.decline: close one open ask without answering it, with a
   *  reason in this agent's own words. Agent-closable, same ruling. */
  decline(args) {
    this._assertAskDecisionAllowed();
    this._checkKind('A', args.id);
    this._audit('a_ledger.decline', `a-ledger:${args.id}`, { actor: args.actor });
    this._checkWords(args.reason);
    const declined = this.store.declineAsk({ id: args.id, reason: args.reason, actor: args.actor }, this.ledgerOptions);
    return Object.freeze({
      declined: true, id: declined.id, status: declined.status,
      note: `${declined.id} is declined.`
    });
  }

  /** p_ledger.decide: approve or decline one proposed purchase's LEDGER
   *  MIRROR. Agent-closable per the owner's ruling. This moves only the
   *  Ledger page's view of the P record; it carries no spend authority and
   *  cannot cause or block a charge -- see the module header for the
   *  two-method re-verification that no spend path reads a P record's
   *  status. */
  decidePurchase(args) {
    this._checkKind('P', args.id);
    this._audit('p_ledger.decide', `p-ledger:${args.id}`, { actor: args.actor, decision: args.decision });
    this._checkWords(args.reason);
    const decided = this.store.decidePurchase({ id: args.id, decision: args.decision, reason: args.reason, actor: args.actor }, this.ledgerOptions);
    return Object.freeze({
      decided: true, id: decided.id, status: decided.status,
      note: `${decided.id} is ${decided.status}. This moves the ledger mirror only; it never spends and never blocks a spend.`
    });
  }
}

module.exports = Object.freeze({ MinorLedgerAgentControl });
