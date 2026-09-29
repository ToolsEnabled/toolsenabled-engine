'use strict';

// The Ledger page for a person working in a terminal inside an OpenShell
// sandbox: the same records the desktop app's Ledger page shows (rules, tasks
// and asks), and the same person-side actions on them (answer, decline or
// remove an ask; complete or remove a task), through the engine's own store
// with the person as the actor -- exactly what the desktop page calls.
//
// Inside one sandbox this is a product rule, not a boundary: every process in
// the sandbox, agents included, could run the same command. The person is told
// so on every page; keeping the person's actions out of the agents' reach needs
// the ToolsEnabled host outside the agents' sandbox.

const store = require('./owner-request-store');
const { MinorLedgerAgentControl } = require('./minor-ledger-agent-gate');

const PERSON = 'owner';
const KINDS = Object.freeze(['R', 'T', 'A']);
const NOT_A_BOUNDARY = 'Inside one sandbox, agents could run this command too; it records you as the actor but cannot prove it was you.';

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireId(kind, id) {
  const pattern = kind === 'A' ? /^A[1-9]\d{0,9}$/ : /^T[1-9]\d{0,9}$/;
  if (typeof id !== 'string' || !pattern.test(id)) {
    throw refuse('LEDGER_PAGE_ID_INVALID', `Expected ${kind === 'A' ? 'an ask id such as A3' : 'a task id such as T12'}, got ${JSON.stringify(id)}.`);
  }
  return id;
}

function requireText(text, what) {
  if (typeof text !== 'string' || text.trim() === '') throw refuse('LEDGER_PAGE_TEXT_REQUIRED', `Give the ${what}.`);
  return text;
}

/** Records to show: open work first. `kinds` narrows to R, T and/or A. */
function view({ kinds = KINDS, limit = 50, includeClosed = false } = {}, { read = (args) => new MinorLedgerAgentControl().read(args) } = {}) {
  const wanted = kinds.filter((kind) => KINDS.includes(kind));
  if (wanted.length === 0) throw refuse('LEDGER_PAGE_KIND_INVALID', 'Choose rules (R), tasks (T) or asks (A).');
  // Declined and removed records are kept but hidden from a plain read; --all shows them too.
  const page = read({ kinds: wanted, limit, ...(includeClosed ? { removed: true } : {}) });
  const records = Array.isArray(page && page.records) ? page.records : [];
  const closed = new Set(['done', 'answered', 'declined', 'removed', 'completed']);
  return {
    records: includeClosed ? records : records.filter((record) => !closed.has(record.status)),
    total: page && typeof page.total === 'number' ? page.total : records.length,
    note: NOT_A_BOUNDARY
  };
}

function answer({ id, words }, { writer = store } = {}) {
  return writer.answerAsk({ id: requireId('A', id), answer: requireText(words, 'answer'), actor: PERSON });
}

function decline({ id, reason }, { writer = store } = {}) {
  return writer.declineAsk({ id: requireId('A', id), reason: requireText(reason, 'reason'), actor: PERSON });
}

function removeAsk({ id }, { writer = store } = {}) {
  return writer.removeAsk({ id: requireId('A', id), actor: PERSON });
}

function completeTask({ id }, { writer = store } = {}) {
  return writer.completeTask({ id: requireId('T', id), actor: PERSON });
}

function removeTask({ id }, { writer = store } = {}) {
  return writer.removeTask({ id: requireId('T', id), actor: PERSON });
}

// Where a record the person typed here came from, as the ledger's provenance
// says it; the desktop page records "typed by the person in the ToolsEnabled app".
const TERMINAL_SOURCE = 'typed by the person at the sandbox terminal (toolsenabled ledger add)';

/** A standing rule for every agent, as the person's own words. */
function addRule({ words }, { writer = store } = {}) {
  return writer.fileRequest({ scope: 'global', words: requireText(words, 'rule'), filedBy: PERSON, source: TERMINAL_SOURCE });
}

/** A task for the agents, as the person's own words. */
function addTask({ words }, { writer = store } = {}) {
  return writer.fileTask({ scope: 'global', words: requireText(words, 'task'), filedBy: PERSON });
}

function oneLine(text, max = 160) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Plain terminal lines for view()'s result. */
function format({ records, note }) {
  if (records.length === 0) return ['Nothing open on the ledger.', '', note];
  const lines = records.map((record) => {
    const who = record.filedBy ? ` (from ${record.filedBy})` : '';
    const words = record.verbatim || record.request || record.words || '';
    return `${record.id}  ${record.status || 'open'}${who}  ${oneLine(words)}`;
  });
  return [...lines, '', note];
}

module.exports = Object.freeze({ view, answer, decline, removeAsk, completeTask, removeTask, addRule, addTask, format, NOT_A_BOUNDARY });
