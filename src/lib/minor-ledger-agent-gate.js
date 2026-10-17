'use strict';

// Task and ask handlers share the owner-request ledger. Every mutation requires
// durable audit admission and refuses secret-shaped free text. A task or ask
// contains this agent's own words; standing rules use a separate verbatim gate.
const { ledgerPlace } = require('./ledger-place');

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
  //
  // `ids` answers many exact records from this ONE store read. Without it a
  // caller that needs 200 records starts 200 reads, each parsing the whole
  // Ledger, and a Codex code-mode script that fans out that far stops
  // dispatching at about 130 calls in flight and never returns (measured
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
        + `Tell the person what you filed; they see it, and can remove it, ${ledgerPlace()}.`
    });
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
    // Wait for durable, anchored audit admission before the ledger mutation.
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
      note: `Filed ${filed.id} -- a durable ask waiting for the person to answer ${ledgerPlace()} (not a live dialog; check back later).`
    });
  }


}

module.exports = Object.freeze({ MinorLedgerAgentControl });
