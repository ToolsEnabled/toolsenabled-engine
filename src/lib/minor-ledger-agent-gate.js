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
// Tasks and asks contain agent-authored text, so they do not use the standing
// rule capture setting or verbatim-turn check. Secret-shaped text is refused.
// Purchases use the existing payment authorization path and ledger store.
//
// THE ACTOR IS TRANSPORT-BOUND, NOT AGENT-CHOSEN. t_ledger.file/complete/
// remove and a_ledger.file are added to src/mcp-server.js's
// R_LEDGER_ACTOR_BOUND_TOOLS exactly as r_ledger.file/propose are: the
// `actor` argument must equal the principal this MCP transport was started
// as, so the name on a T or A record's head line is never a name the agent
// claims for itself.
//
// Agents may answer or decline asks and record purchase decisions. These calls
// retain the actual actor; ask/purchase removal remains person-only.
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

// Reuse the standing-rule gate's secret-shape classifier for task and ask text.
const { looksSecretShaped } = require('./r-ledger-agent-gate');
const { normalizeWaitingFor } = require('./task-waiting');

// WHY A REVIEW FILED AS PROGRESS IS CAUGHT HERE (T1997, wave lane L4).
// The decision kind on a T record is not inferred from its words: it is
// whichever store function was called. progressTask hardcodes
// `decision: 'progress'` (owner-request-store.js) and never touches
// failedReviewCount; recordTaskReview hardcodes `decision: 'review'` and is the
// ONLY writer of that counter (via task-difficulty.js planTaskDifficultyReview).
// So an agent that narrates "reviewed it, suites green" through
// t_ledger.progress files a checkpoint, the review never exists, the count
// never rises, and a troubled task cannot be told from a healthy one. Measured
// on the live store 2026-09-24: 8,947 progress rows against 126 reviews, of
// which only 2 were failures. progress is the cheaper call (no reviewId to
// invent), so it wins by default unless the door says otherwise.
//
// The test is deliberately two-signal and narrow: the prose must name a review
// AND state a verdict on it. "Reviewed the spec, still implementing" is real
// progress and passes; "review passed" is a verdict and is caught, with the
// exact call to make instead. This never guesses a verdict on the agent's
// behalf -- inferring pass/fail from prose is precisely the silent
// misclassification this check exists to prevent.
// Co-occurrence is not enough. Measured against the live store, a rule that
// merely finds a review word and a verdict word anywhere in the same 300
// characters catches 913 of 8,947 real checkpoints (10.2%), most of them
// honest work notes that happen to mention a branch called "review head" and
// a passing test. These patterns instead require the verdict to be ASSERTED
// ABOUT the review -- the two must be adjacent, with only short connective
// filler between them and no sentence boundary crossed. A bare "LGTM" or
// "approved for merge" counts on its own: those are verdicts whatever noun
// follows.
const REVIEW_VERDICT_PATTERNS = Object.freeze([
  // "review passed", "review: fail", "review is clean", "reviews came back green"
  /\b(?:re-?)?review(?:s|ed|er)?\b[^.;!?\n]{0,18}?\b(?:passed|passes|passing|pass|failed|fails|failing|fail|clean|green|approved|rejected|blocked|blocking)\b/i,
  // "passed review", "failed the code review", "rejected at review"
  /\b(?:passed|passes|failed|fails|rejected|approved|blocked)\b[^.;!?\n]{0,18}?\b(?:re-?)?review(?:s|ed|er)?\b/i,
  // "review verdict: pass", "QA outcome failed", "sign-off: approved"
  /\b(?:review|qa|sign[- ]?off)\b[^.;!?\n]{0,18}?\b(?:verdict|outcome|result)\b[^.;!?\n]{0,12}?\b(?:pass(?:ed)?|fail(?:ed)?|approved|rejected|clean|green)\b/i,
  /\b(?:verdict|sign(?:ed)?[- ]?off)\b[^.;!?\n]{0,18}?\b(?:pass(?:ed)?|fail(?:ed)?|approved|rejected|clean|green|stands)\b/i,
  // "reviewed and approved", "reviewed, rejected"
  /\breviewed\b[^.;!?\n]{0,12}?\b(?:approved|rejected|accepted|declined)\b/i,
  // Standalone verdicts that need no review noun to be a verdict.
  /\blgtm\b/i,
  /\bship it\b/i,
  /\bgood to go\b/i,
]);

// "the failed-review count is 0" and "failed review counts" discuss the counter;
// they do not pass or fail anything. Measured on the live store, that compound
// noun was the largest remaining false-positive family (3 of 88).
const COUNTER_TALK_RE = /\b(?:failed|passed)[- ]review\b[^.;!?\n]{0,8}?\bcounts?\b/i;

function looksLikeReviewVerdict(words) {
  if (typeof words !== 'string' || words.length === 0) return false;
  const text = COUNTER_TALK_RE.test(words) ? words.replace(new RegExp(COUNTER_TALK_RE, 'gi'), ' ') : words;
  return REVIEW_VERDICT_PATTERNS.some(pattern => pattern.test(text));
}

// REFUSE OR WARN IS ONE SWITCH, AND ITS DEFAULT IS WARN (O11 IS OPEN).
// L4 shipped the detector as a refusal. RELEASE-READINESS O11 asks whether a
// ~1% checkpoint-rewording rate is acceptable or whether the detector should
// warn instead, and the Controller's return on T1997 says a composed packet
// must not choose that silently. So both behaviours are here and the choice is
// one explicit switch:
//
//   'warn'    (DEFAULT) the checkpoint is written exactly as it was before this
//             check existed -- same store call, same row, same waitingFor, same
//             agent id -- and the receipt carries a `warning` naming the
//             t_ledger.review call that would have raised the count.
//   'refuse'  L4's behaviour, unchanged: typed T_LEDGER_REVIEW_AS_PROGRESS,
//             nothing written, not even the progress row.
//
// The default is the non-refusing one because that is the behaviour the base
// already had for every current caller. Answering O11 "refuse" is changing
// REVIEW_AS_PROGRESS_DEFAULT below (or constructing the control with
// { reviewAsProgress: 'refuse' }). No historical row is touched either way:
// re-filing the prose verdicts already in the Ledger is O10, also open.
const REVIEW_AS_PROGRESS_MODES = Object.freeze(['warn', 'refuse']);
const REVIEW_AS_PROGRESS_DEFAULT = 'warn';

class MinorLedgerAgentControl {
  constructor(dependencies = {}) {
    this.auditRequire = dependencies.auditRequire || ((...args) => require('./audit').requireRecord(...args));
    this.auditRequireAsync = dependencies.auditRequireAsync || dependencies.auditRequire
      || ((...args) => require('./audit-admission').requireRecordAsync(...args));
    this.store = dependencies.store || require('./owner-request-store');
    this.ledgerOptions = dependencies.ledgerOptions || {};
    this.scrub = dependencies.scrub || null;
    this.loadSettings = dependencies.loadSettings || (() => require('./settings').loadSettings());
    const reviewAsProgress = dependencies.reviewAsProgress === undefined
      ? REVIEW_AS_PROGRESS_DEFAULT : dependencies.reviewAsProgress;
    if (!REVIEW_AS_PROGRESS_MODES.includes(reviewAsProgress)) {
      throw Object.assign(new TypeError(
        `reviewAsProgress must be one of ${REVIEW_AS_PROGRESS_MODES.join(', ')}; a misspelt switch is not silently read as either.`
      ), { code: 'T_LEDGER_REVIEW_AS_PROGRESS_MODE_INVALID' });
    }
    this.reviewAsProgress = reviewAsProgress;
  }

  // Uses the installation-owned store, with no caller-supplied path or write.
  //
  // `ids` answers many exact records from this ONE store read. Without it a
  // caller that needs 200 records starts 200 reads, each parsing the whole
  // Ledger, and a Codex code-mode script that fans out that far stops
  // dispatching at about 130 calls in flight and never returns (Controller 1,
  // 2026-09-24). `missing` names every asked-for id that is not in the answer,
  // so nobody has to fan out again to learn which ones exist.
  read(args = {}) {
    const all = this.store.readAll({
      ...this.ledgerOptions, kinds: args.kinds || ['R', 'T', 'A', 'P'],
      includeRemoved: args.removed === true, includeProposed: true
    });
    const asked = Array.isArray(args.ids) ? [...new Set([...(args.id ? [args.id] : []), ...args.ids])] : null;
    const wanted = asked ? new Set(asked) : null;
    const records = all.records.filter(record =>
      (wanted ? wanted.has(record.id) : (!args.id || record.id === args.id))
      && (!args.scope || record.scope === args.scope)
      && (!args.key || record.scopeKey === args.key)
      && (!args.status || record.status === args.status));
    const offset = args.offset || 0;
    // An id list is one answer: page it whole by default (the schema caps
    // ids at 100, the same ceiling as limit), not in the default 25.
    const limit = args.limit || (asked ? Math.min(asked.length, 100) : 25);
    let missing;
    if (asked) {
      const found = new Set(records.map(record => record.id));
      missing = asked.filter(id => !found.has(id));
    }
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
      records: page, ...(missing === undefined ? {} : { missing }), chain, grantsAuthority: false
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

  /* A checkpoint may say what was done; a review's verdict belongs in
   * t_ledger.review, the only call that raises the failed-review count.
   * Under 'refuse' (L4's behaviour) the verdict is refused with the exact call
   * to make instead and NOTHING is written -- the progress row is not saved
   * either, because saving it would put the verdict back where the counter
   * cannot see it. Under 'warn' (the default until O11 is answered) this
   * returns the same advice as a warning for the receipt and the checkpoint is
   * written exactly as before. Returns null when the words carry no verdict. */
  _reviewAsProgress(id, reason) {
    if (!looksLikeReviewVerdict(reason)) return null;
    const instead = `Send it as a review instead: t_ledger.review with id "${id}", outcome "passed" or "failed", `
      + 'a reviewId that is stable for this one review, and reason set to the evidence. '
      + 'A failed review is what raises this task\'s failed-review count. ';
    if (this.reviewAsProgress === 'refuse') {
      throw new this.store.OwnerRequestStoreError(
        'T_LEDGER_REVIEW_AS_PROGRESS',
        'That reads as a review verdict, and a task checkpoint cannot carry one, so nothing was filed. '
        + instead
        + 'If you meant a work checkpoint and not a verdict, resend it through t_ledger.progress without the pass/fail wording.'
      );
    }
    return Object.freeze({
      code: 'T_LEDGER_REVIEW_AS_PROGRESS',
      message: 'The checkpoint was recorded, but it reads as a review verdict, and a checkpoint never reaches the failed-review count. '
        + instead
        + 'If it was only a work checkpoint, nothing more is needed.'
    });
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

  /** t_ledger.assign: assign one existing task to a host-verified child.
   * The transaction and authority receipt belong to owner-request-store;
   * this gate only binds the actor, validates the task-shaped input and
   * refuses to report a non-durable or mismatched result. Role restriction is
   * enforced by tool-registry before this handler is reached. */
  assign(args = {}, context = {}) {
    const { id, nodeId, assignmentId, reason, actor } = args;
    this._checkKind('T', id);
    if (typeof nodeId !== 'string' || nodeId.length === 0
        || typeof assignmentId !== 'string' || assignmentId.length === 0
        || typeof actor !== 'string' || actor.length === 0
        || typeof reason !== 'string' || reason.length === 0) {
      throw new this.store.OwnerRequestStoreError(
        'R_LEDGER_ASSIGNMENT_INVALID',
        'A task assignment needs an existing task, target node, assignment id, reason and bound actor.'
      );
    }
    if (typeof context.agentActor === 'string' && context.agentActor !== actor) {
      throw new this.store.OwnerRequestStoreError(
        'R_LEDGER_ACTOR_BOUND',
        'The assignment actor must match the authenticated owner-host transport actor.'
      );
    }
    this._audit('t_ledger.assign', `t-ledger:${id}`, { actor, nodeId, assignmentId });
    this._checkWords(reason);
    const writer = context && context.taskLedgerWriter;
    if (!writer || typeof writer.assignTask !== 'function') {
      throw new this.store.OwnerRequestStoreError(
        'R_LEDGER_ASSIGNMENT_UNAVAILABLE',
        'The authenticated owner-host task-assignment writer is unavailable, so no assignment was written.'
      );
    }
    const assigned = writer.assignTask({ id, nodeId, assignmentId, reason, actor });
    if (!assigned || typeof assigned !== 'object' || Array.isArray(assigned)
        || typeof assigned.then === 'function'
        || assigned.assigned !== true || assigned.id !== id
        || assigned.assignmentId !== assignmentId
        || typeof assigned.replayed !== 'boolean'
        || !Number.isSafeInteger(assigned.revision) || assigned.revision < 0
        || typeof assigned.recordedAt !== 'string' || assigned.recordedAt.length === 0
        || !assigned.receipt || typeof assigned.receipt !== 'object') {
      throw new this.store.OwnerRequestStoreError(
        'R_LEDGER_ASSIGNMENT_RESULT_INVALID',
        'The task assignment returned an incomplete durable receipt, so no assignment was reported.'
      );
    }
    return Object.freeze({ ...assigned });
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
    // T1997: refused here under 'refuse' before any store write; under 'warn'
    // the same store call below runs unchanged and the receipt says why the
    // count did not move. The caller's waitingFor reaches the store on both
    // paths exactly as it would without this check.
    const reviewVerdict = this._reviewAsProgress(id, reason);
    const storeArgs = { id, status, reason, actor };
    if (hasWaitingFor) storeArgs.waitingFor = waitingFor;
    const progress = this.store.progressTask(storeArgs, this.ledgerOptions);
    return Object.freeze({
      updated: true, id: progress.id, status: progress.status, note: `${progress.id}: task checkpoint recorded.`,
      ...(reviewVerdict ? { warning: reviewVerdict } : {})
    });
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

  /** Ask decisions retain the calling actor and require the configured permission. */
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

  /** Record a purchase decision without granting payment authority. */
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

module.exports = Object.freeze({
  MinorLedgerAgentControl, looksLikeReviewVerdict, REVIEW_AS_PROGRESS_MODES, REVIEW_AS_PROGRESS_DEFAULT
});
