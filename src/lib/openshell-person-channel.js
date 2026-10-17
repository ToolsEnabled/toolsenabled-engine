'use strict';

// Terminal questions and notices. A bounded wait returns pending; a repeated
// question collects one answer. This module never creates permission grants.
// In one sandbox every process can edit the state, so it is not a boundary.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 2;
const MAX_ASK_MESSAGE = 16384;        // Maximum question text
const MAX_TITLE = 200;
const MAX_NOTICE_MESSAGE = 2000;      // Maximum notice text
const MAX_WORDS = 2000;
const MIN_TIMEOUT_SECONDS = 5;        // system.ask's schema bounds
const MAX_TIMEOUT_SECONDS = 900;
const DEFAULT_TIMEOUT_SECONDS = 60;
// A call returns after at most thirty seconds; an answer is kept for later.
const MAX_WAIT_SECONDS = 30;
const OPEN_FOR_MS = 24 * 60 * 60 * 1000;   // an unanswered question closes after a day
const COLLECT_WITHIN_MS = 60 * 60 * 1000;  // an answer nobody collects closes after an hour
const MAX_WAITING = 64;
const KEEP_CLOSED = 200;
const KEEP_NOTICES = 200;
const POLL_MS = 250;
const LOCK_WAIT_MS = 5000;
const STALE_LOCK_MS = 10000;
const ASK_ID = /^Q[1-9]\d{0,9}$/;
const OPEN_STATES = new Set(['waiting', 'approved', 'denied']);

const NOT_A_BOUNDARY = 'Inside one sandbox this is a product rule, not a boundary: agents could run this command too, and it records you as the one who answered but cannot prove it was you. '
  + 'Keeping these answers out of the agents\' reach needs the ToolsEnabled host outside the agents\' sandbox.';

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

function channelFile() {
  return require('./runtime-state-root').statePath('state', 'openshell-person-channel.json');
}

function emptyState() {
  return { version: VERSION, nextAsk: 1, nextNotice: 1, asks: [], notices: [] };
}

function readState(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw refuse('PERSON_CHANNEL_UNREADABLE', `The file that carries questions to the person's terminal (${file}) could not be read (${error.code || error.message}), so nothing was asked. The person can check that file.`);
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw refuse('PERSON_CHANNEL_UNREADABLE', `The file that carries questions to the person's terminal (${file}) is not valid JSON, so nothing was asked or changed. The person can move it aside to start afresh.`);
  }
  if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.asks) || !Array.isArray(parsed.notices)
    || !Number.isSafeInteger(parsed.nextAsk) || !Number.isSafeInteger(parsed.nextNotice)) {
    throw refuse('PERSON_CHANNEL_UNREADABLE', `The file that carries questions to the person's terminal (${file}) has an unknown shape, so nothing was asked or changed. The person can move it aside to start afresh.`);
  }
  return parsed;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// One writer at a time across processes: the agents' servers ask, the
// terminal answers. Held for one read-modify-write, never while waiting. A
// lock left by a process that died mid-write is broken after STALE_LOCK_MS;
// writes are a rename, so the file itself is never half written.
function mutate(file, change) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); } catch (error) {
    throw refuse('PERSON_CHANNEL_UNWRITABLE', `The folder for the person's terminal questions (${path.dirname(file)}) could not be created (${error.code || error.message}), so nothing was asked or changed.`);
  }
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle;
  for (;;) {
    try { handle = fs.openSync(lock, 'wx', 0o600); break; } catch (error) {
      if (error.code !== 'EEXIST') {
        throw refuse('PERSON_CHANNEL_UNWRITABLE', `The file that carries questions to the person's terminal could not be locked (${error.code || error.message}), so nothing was asked or changed.`);
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) { fs.rmSync(lock, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw refuse('PERSON_CHANNEL_BUSY', 'The file that carries questions to the person\'s terminal stayed locked for 5 seconds; nothing was changed. Try again.');
      sleepSync(20);
    }
  }
  try {
    const state = readState(file);
    const result = change(state);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* nothing more to do */ }
      throw refuse('PERSON_CHANNEL_UNWRITABLE', `The file that carries questions to the person's terminal could not be written (${error.code || error.message}), so nothing was asked or changed.`);
    }
    return result;
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lock, { force: true });
  }
}

function text(value, what, max) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || value.includes('\0')) {
    throw refuse('PERSON_CHANNEL_TEXT_INVALID', `The ${what} must be text of 1 to ${max} characters.`);
  }
  return value;
}

function waitSecondsFor(timeoutSeconds) {
  const asked = timeoutSeconds === undefined ? DEFAULT_TIMEOUT_SECONDS : timeoutSeconds;
  if (!Number.isSafeInteger(asked) || asked < MIN_TIMEOUT_SECONDS || asked > MAX_TIMEOUT_SECONDS) {
    throw refuse('PERSON_CHANNEL_TIMEOUT_INVALID', `timeoutSeconds must be a whole number from ${MIN_TIMEOUT_SECONDS} through ${MAX_TIMEOUT_SECONDS}.`);
  }
  return Math.min(asked, MAX_WAIT_SECONDS);
}

/** Who is asking: the CLI the server was registered for, and the tree node when it is a worker. */
function askerFrom(env = process.env) {
  const actor = typeof env.TOOLSENABLED_AGENT_ACTOR === 'string' && env.TOOLSENABLED_AGENT_ACTOR ? env.TOOLSENABLED_AGENT_ACTOR : 'an agent';
  const node = typeof env.TOOLSENABLED_OPENSHELL_NODE === 'string' && env.TOOLSENABLED_OPENSHELL_NODE ? env.TOOLSENABLED_OPENSHELL_NODE : null;
  return node ? `${actor} (${node})` : actor;
}

// What makes two asks "the same": the asker, and either the exact question or
// the exact action with its argument hash (approvals.actionInputHash, the
// hash the one-time grant is bound to).
function keyOf({ kind, from, title, message, action, inputHash, scope }) {
  const parts = kind === 'approval' ? [kind, from, action, inputHash] : [kind, from, title, message];
  if (scope) parts.push(scope);
  return crypto.createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

/** An ask as the person sees it now: waiting, answered, collected, or closed (and why). */
function viewAsk(ask, nowMs = Date.now()) {
  let state = ask.state;
  if (state === 'waiting' && Date.parse(ask.expiresAt) <= nowMs) state = 'expired';
  if ((state === 'approved' || state === 'denied') && Date.parse(ask.decidedAt) + COLLECT_WITHIN_MS <= nowMs) state = 'expired';
  return { ...ask, state };
}

function closeOld(state, nowMs) {
  for (const entry of state.asks) {
    const current = viewAsk(entry, nowMs);
    if (current.state === 'expired' && entry.state !== 'expired') { entry.closedAs = entry.state; entry.state = 'expired'; }
  }
  const closed = state.asks.filter((entry) => !OPEN_STATES.has(entry.state));
  if (closed.length > KEEP_CLOSED) {
    const drop = new Set(closed.slice(0, closed.length - KEEP_CLOSED).map((entry) => entry.id));
    state.asks = state.asks.filter((entry) => !drop.has(entry.id));
  }
}

function answerOf(entry) {
  const base = { askId: entry.id, answeredAt: entry.decidedAt, via: 'terminal' };
  if (entry.state === 'approved') return { answer: 'yes', approved: true, timedOut: false, ...base, ...(entry.note ? { note: entry.note } : {}) };
  if (entry.state === 'denied') return { answer: 'no', approved: false, timedOut: false, ...base, reason: entry.reason };
  return null;
}

// Hand the answer to this caller, once: under the lock, an answered ask becomes
// collected. Another caller that collected it first wins; this one gets null.
function collect(file, id, nowMs) {
  return mutate(file, (state) => {
    const entry = state.asks.find((candidate) => candidate.id === id);
    if (!entry) return null;
    const current = viewAsk(entry, nowMs);
    if (current.state !== 'approved' && current.state !== 'denied') return null;
    const answer = answerOf(entry);
    entry.collectedAs = entry.state;
    entry.state = 'collected';
    entry.collectedAt = new Date(nowMs).toISOString();
    return answer;
  });
}

function pendingAnswer(entry, waitedSeconds) {
  const again = entry.kind === 'approval'
    ? 'Call system.ask again with the same action and arguments to collect the answer'
    : 'Call system.ask again with the same message to collect the answer';
  return {
    answer: 'pending', approved: false, pending: true, timedOut: false, askId: entry.id, waitedSeconds,
    reason: `Waiting for the person to answer ${entry.id} in the terminal (${process.env.TOOLSENABLED_OPENSHELL_HOST === '1' ? 'toolsenabled-authority ask list' : 'toolsenabled approvals'}). ${again}; it is kept for 24 hours. Work on something else meanwhile.`
  };
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Ask the person at the terminal. Returns what desktop.ask returns once the
 * person has answered ({answer: yes|no, approved, ...}, plus their words:
 * `reason` on a no, `note` on a yes), or {answer: 'pending', pending: true,
 * askId} when they have not answered within the short wait. `action` and
 * `inputHash` make this a one-time approval for that exact call.
 */
async function ask(args = {}, dependencies = {}) {
  require('./openshell-authority').requireLocal();
  const file = dependencies.file || channelFile();
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || defaultSleep;
  const signal = dependencies.signal;
  const title = text(args.title === undefined ? 'ToolsEnabled confirmation' : args.title, 'title', MAX_TITLE);
  const message = text(args.message, 'question', MAX_ASK_MESSAGE);
  const waitSeconds = waitSecondsFor(args.timeoutSeconds);
  const action = typeof args.action === 'string' && args.action ? args.action : null;
  const inputHash = typeof args.inputHash === 'string' && /^[a-f0-9]{64}$/.test(args.inputHash) ? args.inputHash : null;
  const kind = action && inputHash ? 'approval' : 'question';
  const from = typeof dependencies.from === 'string' && dependencies.from ? dependencies.from : askerFrom();
  const key = keyOf({ kind, from, title, message, action, inputHash, scope: dependencies.scope });
  const startedMs = now();

  const found = mutate(file, (state) => {
    closeOld(state, startedMs);
    const open = state.asks.filter((entry) => entry.key === key && OPEN_STATES.has(entry.state)).pop();
    if (open && open.state !== 'waiting') {
      const answer = answerOf(open);
      open.collectedAs = open.state;
      open.state = 'collected';
      open.collectedAt = new Date(startedMs).toISOString();
      return { entry: { ...open }, answer };
    }
    if (open) {
      open.lastAskedAt = new Date(startedMs).toISOString();
      open.timesAsked += 1;
      return { entry: { ...open }, answer: null };
    }
    const waiting = state.asks.filter((entry) => entry.state === 'waiting');
    if (waiting.length >= MAX_WAITING) {
      throw refuse('PERSON_CHANNEL_FULL', `${MAX_WAITING} questions are already waiting for the person at the terminal, so this one was not asked. Wait for answers before asking more.`);
    }
    const entry = {
      id: `Q${state.nextAsk}`, key, kind, title, message, action, from,
      askedAt: new Date(startedMs).toISOString(), lastAskedAt: new Date(startedMs).toISOString(), timesAsked: 1,
      expiresAt: new Date(startedMs + OPEN_FOR_MS).toISOString(),
      shownAt: null, state: 'waiting', decidedAt: null, reason: null, note: null, collectedAt: null
    };
    state.nextAsk += 1;
    state.asks.push(entry);
    return { entry: { ...entry }, answer: null };
  });
  if (found.answer) return found.answer;

  const deadlineMs = startedMs + (waitSeconds * 1000);
  for (;;) {
    if (signal && signal.aborted) break;
    const current = readState(file).asks.find((candidate) => candidate.id === found.entry.id);
    if (!current) break;
    const state = viewAsk(current, now()).state;
    if (state === 'approved' || state === 'denied') {
      const answer = collect(file, found.entry.id, now());
      if (answer) return answer;
      break;
    }
    if (state !== 'waiting') break;
    const left = deadlineMs - now();
    if (left <= 0) break;
    await sleep(Math.min(POLL_MS, left), signal);
  }
  return pendingAnswer(found.entry, Math.round((now() - startedMs) / 1000));
}

/** Post a notice for the person; `toolsenabled watch` prints it as it arrives. */
function notify(args = {}, dependencies = {}) {
  require('./openshell-authority').requireLocal();
  const file = dependencies.file || channelFile();
  const now = dependencies.now || Date.now;
  const title = text(String(args.title === undefined ? 'ToolsEnabled' : args.title).slice(0, MAX_TITLE), 'title', MAX_TITLE);
  const message = text(String(args.message === undefined ? '' : args.message).slice(0, MAX_NOTICE_MESSAGE), 'message', MAX_NOTICE_MESSAGE);
  let durationSeconds = Number(args.durationSeconds);
  if (!Number.isFinite(durationSeconds)) durationSeconds = 5;
  durationSeconds = Math.min(Math.max(Math.trunc(durationSeconds), 1), 30);
  const from = typeof dependencies.from === 'string' && dependencies.from ? dependencies.from : askerFrom();
  const notice = mutate(file, (state) => {
    const entry = { id: `N${state.nextNotice}`, title, message, from, at: new Date(now()).toISOString() };
    state.nextNotice += 1;
    state.notices.push(entry);
    if (state.notices.length > KEEP_NOTICES) state.notices.splice(0, state.notices.length - KEEP_NOTICES);
    return entry;
  });
  // Nothing here can tell whether the person looked, so it says where the
  // notice waits instead of claiming it was shown.
  return {
    shown: false, posted: true, noticeId: notice.id, title, message, durationSeconds,
    where: process.env.TOOLSENABLED_OPENSHELL_HOST === '1'
      ? 'On the authority host: toolsenabled-authority watch or toolsenabled-authority ask list.'
      : 'In this OpenShell sandbox the person sees notices in the terminal: `toolsenabled watch` prints them as they arrive and `toolsenabled approvals` lists recent ones.'
  };
}

/** Everything the terminal pages read: asks with their current state, and notices. */
function read(dependencies = {}) {
  require('./openshell-authority').requireLocal();
  const state = readState(dependencies.file || channelFile());
  const nowMs = (dependencies.now || Date.now)();
  return { asks: state.asks.map((entry) => viewAsk(entry, nowMs)), notices: state.notices.slice() };
}

/** Record that these asks were printed in full on the person's terminal. */
function markShown(ids, dependencies = {}) {
  const wanted = new Set(ids);
  if (wanted.size === 0) return 0;
  const at = new Date((dependencies.now || Date.now)()).toISOString();
  return mutate(dependencies.file || channelFile(), (state) => {
    let marked = 0;
    for (const entry of state.asks) {
      if (wanted.has(entry.id) && entry.state === 'waiting' && !entry.shownAt) { entry.shownAt = at; marked += 1; }
    }
    return marked;
  });
}

const WHY_CLOSED = Object.freeze({
  collected: 'the agent already collected the answer',
  expired: 'it closed unanswered or uncollected; if the agent asks again it gets a new id'
});

/**
 * The person's answer to one ask. approve: a waiting ask. deny: a waiting ask,
 * or an approval the agent has not collected yet (taking it back). A denial
 * needs the reason, which reaches the agent as the person's sentence.
 */
function decide({ id, decision, words }, dependencies = {}) {
  require('./openshell-authority').requireLocal();
  if (typeof id !== 'string' || !ASK_ID.test(id)) throw refuse('PERSON_CHANNEL_ID_INVALID', `Expected a question id such as Q3, got ${JSON.stringify(id)}.`);
  if (decision !== 'approve' && decision !== 'deny') throw refuse('PERSON_CHANNEL_DECISION_INVALID', 'Answer with approve or deny.');
  const said = typeof words === 'string' && words.trim() !== '' ? words.trim() : null;
  if (decision === 'deny' && !said) throw refuse('PERSON_CHANNEL_REASON_REQUIRED', 'Give the reason; the agent is told it in your words.');
  if (said && said.length > MAX_WORDS) throw refuse('PERSON_CHANNEL_TEXT_INVALID', `Keep the words to ${MAX_WORDS} characters.`);
  const nowMs = (dependencies.now || Date.now)();
  return mutate(dependencies.file || channelFile(), (state) => {
    const entry = state.asks.find((candidate) => candidate.id === id);
    if (!entry) throw refuse('PERSON_CHANNEL_ID_UNKNOWN', `${id} is not a question on this terminal.`);
    const current = viewAsk(entry, nowMs);
    const takingBack = decision === 'deny' && current.state === 'approved';
    if (current.state !== 'waiting' && !takingBack) {
      const why = current.state === 'approved' ? 'you already approved it; it waits for the agent to collect it (you can still deny it)'
        : current.state === 'denied' ? 'you already denied it' : WHY_CLOSED[current.state] || `it is ${current.state}`;
      throw refuse('PERSON_CHANNEL_NOT_WAITING', `${id} is not waiting for an answer: ${why}. Nothing was changed.`);
    }
    if (!entry.shownAt) {
      throw refuse('PERSON_CHANNEL_NOT_SHOWN', `${id} has not been shown to you in full yet. Run \`toolsenabled approvals\` to read it, then answer.`);
    }
    entry.state = decision === 'approve' ? 'approved' : 'denied';
    entry.decidedAt = new Date(nowMs).toISOString();
    if (decision === 'deny') { entry.reason = said; entry.note = null; } else entry.note = said;
    if (takingBack) entry.tookBackAt = entry.decidedAt;
    return { ...entry, takenBack: takingBack };
  });
}

module.exports = Object.freeze({
  ask, notify, read, markShown, decide, viewAsk, channelFile, askerFrom,
  NOT_A_BOUNDARY, MAX_ASK_MESSAGE, MAX_WAIT_SECONDS, DEFAULT_TIMEOUT_SECONDS, OPEN_FOR_MS, COLLECT_WITHIN_MS, ASK_ID
});
