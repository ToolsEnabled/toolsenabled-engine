'use strict';

// Questions and notices for the person in the sandbox terminal. Answers never
// change permissions; every page states the shared sandbox state limitation.

const channel = require('./openshell-person-channel');
const { terminalSafeText } = require('./terminal-safe-text');

const NOT_A_BOUNDARY = channel.NOT_A_BOUNDARY;
const RECENT_NOTICE_MS = 24 * 60 * 60 * 1000;
const RECENT_NOTICES = 10;
const WATCH_INTERVAL_MS = 1000;

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

function defaults(dependencies = {}) {
  return {
    channel: dependencies.channel || channel,
    rules: dependencies.rules || rulesInForce,
    now: dependencies.now || Date.now,
    channelDependencies: dependencies.channelDependencies || {}
  };
}

function rulesInForce() {
  return [['Questions', 'The person answers yes or no; the agent collects the answer once.', null],
    ['Permissions', 'Answers do not change tool or agent permissions.', null]];
}

/** What the page shows: waiting questions, answers not yet collected, recent notices, the rules. */
function view({ all = false } = {}, dependencies = {}) {
  const d = defaults(dependencies);
  const nowMs = d.now();
  const { asks, notices } = d.channel.read(d.channelDependencies);
  return {
    waiting: asks.filter((ask) => ask.state === 'waiting'),
    answered: asks.filter((ask) => ask.state === 'approved' || ask.state === 'denied'),
    closed: all ? asks.filter((ask) => ask.state === 'collected' || ask.state === 'expired').slice(-20) : [],
    notices: notices.filter((notice) => nowMs - Date.parse(notice.at) <= RECENT_NOTICE_MS).slice(-RECENT_NOTICES),
    rules: d.rules(),
    note: process.env.TOOLSENABLED_OPENSHELL_HOST === '1' ? require('./openshell-authority').HOST_NOTE : NOT_A_BOUNDARY,
    nowMs
  };
}

function indent(textValue, prefix = '    ') {
  return String(textValue).split('\n').map((line) => `${prefix}${line}`.replace(/\s+$/, ''));
}

function age(fromIso, nowMs) {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(fromIso)) / 1000));
  if (seconds < 120) return `${seconds} s ago`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

function askLines(ask, nowMs) {
  const what = ask.kind === 'approval' ? `one-time approval for ${ask.action}` : 'question';
  const asked = ask.timesAsked > 1 ? `asked ${ask.timesAsked} times, last ${age(ask.lastAskedAt, nowMs)}` : `asked ${age(ask.askedAt, nowMs)}`;
  return [`${ask.id}  ${what}  from ${ask.from}  ${asked}`, ...indent(ask.title), ...indent(ask.message), ''];
}

function noticeLine(notice) {
  return `${notice.id}  ${notice.at.slice(11, 19)}  from ${notice.from}  ${notice.title}: ${notice.message.replace(/\s+/g, ' ')}`;
}

function answeredLine(ask) {
  const what = ask.kind === 'approval' ? ask.action : 'question';
  const said = ask.state === 'denied' ? `: ${ask.reason}` : ask.note ? `: ${ask.note}` : '';
  return `${ask.id}  ${ask.state}  ${what}  from ${ask.from}${said}`;
}

function closedLine(ask) {
  const what = ask.kind === 'approval' ? ask.action : 'question';
  const how = ask.state === 'collected' ? `${ask.collectedAs}, collected by the agent` : `closed (${ask.closedAs === 'waiting' ? 'unanswered' : `${ask.closedAs}, never collected`})`;
  const said = ask.reason ? `: ${ask.reason}` : ask.note ? `: ${ask.note}` : '';
  return `${ask.id}  ${how}  ${what}  from ${ask.from}${said}`;
}

/** Plain terminal lines for view()'s result. */
function format(page) {
  const lines = [];
  if (page.waiting.length === 0) lines.push('Nothing is waiting for you.', '');
  else {
    lines.push('Waiting for you. Answer with `toolsenabled approvals approve <id>` or `toolsenabled approvals deny <id> <reason>`.', '');
    for (const ask of page.waiting) lines.push(...askLines(ask, page.nowMs));
  }
  if (page.answered.length > 0) {
    lines.push('Answered; the agent collects the answer when it asks again (deny still takes back an approval until then)',
      ...page.answered.map((ask) => `  ${answeredLine(ask)}`), '');
  }
  if (page.closed.length > 0) lines.push('Closed', ...page.closed.map((ask) => `  ${closedLine(ask)}`), '');
  if (page.notices.length > 0) lines.push('Recent notices', ...page.notices.map((notice) => `  ${noticeLine(notice)}`), '');
  lines.push('Rules in force');
  const width = Math.max(...page.rules.map(([label]) => label.length));
  for (const [label, value, how] of page.rules) {
    lines.push(`  ${label.padEnd(width)}  ${value}`);
    if (how) lines.push(`  ${' '.repeat(width)}  ${how}`);
  }
  lines.push('', page.note);
  return lines.map(terminalSafeText);
}

/** The page as the person runs it: printed in full, then its waiting questions marked shown. */
function list(options = {}, dependencies = {}) {
  const d = defaults(dependencies);
  const page = view(options, dependencies);
  const lines = format(page);
  d.channel.markShown(page.waiting.map((ask) => ask.id), d.channelDependencies);
  return lines.map(terminalSafeText);
}

function decide(id, { decision, words }, dependencies = {}) {
  const d = defaults(dependencies);
  if (typeof id !== 'string' || !channel.ASK_ID.test(id)) {
    throw refuse('APPROVALS_PAGE_ID_INVALID', `Expected an id shown by \`toolsenabled approvals\`, such as Q3, got ${JSON.stringify(id === undefined ? '' : id)}.`);
  }
  const said = typeof words === 'string' && words.trim() !== '' ? words.trim() : null;
  return d.channel.decide({ id, decision, words: said }, d.channelDependencies);
}

function approve({ id, words }, dependencies = {}) {
  return decide(id, { decision: 'approve', words }, dependencies);
}

function deny({ id, reason }, dependencies = {}) {
  return decide(id, { decision: 'deny', words: reason }, dependencies);
}

/** What the person is told after a decision. */
function formatDecision(ask) {
  if (ask.state === 'approved') {
    return [ask.kind === 'approval'
      ? `${ask.id} approved. ${ask.from} gets one approval for ${ask.action} with exactly the arguments shown, when it asks again; one call uses it up.`
      : `${ask.id} answered yes${ask.note ? `, with your words: ${ask.note}` : ''}. ${ask.from} gets the answer when it asks again.`];
  }
  return [`${ask.id} ${ask.takenBack ? 'approval taken back and ' : ''}denied. ${ask.from} is told, when it asks again: ${ask.reason}`];
}

/** Two lines for `toolsenabled setup`: whether outward actions wait for the person, and where they answer. */
function setupLines() {
  if (require('./openshell-authority').configured()) return [`  Questions          ${require('./openshell-authority').NOTE}`];
  return ['  Questions          toolsenabled approvals; notices as they arrive: toolsenabled watch'];
}

/**
 * Print what is waiting now, then each new question, approval and notice as
 * it arrives, and what became of each question printed here, until stopped.
 * Questions printed in full are marked shown, as `toolsenabled approvals` does.
 */
async function watch({ once = false, intervalMs = WATCH_INTERVAL_MS, out = (line) => process.stdout.write(`${line}\n`), bell = false, signal } = {}, dependencies = {}) {
  const rawOut = out;
  out = line => rawOut(terminalSafeText(String(line)));
  const d = defaults(dependencies);
  const sleep = dependencies.sleep || ((ms, stop) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (stop) stop.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  }));
  const printed = new Set();
  const seenNotices = new Set();
  const lastState = new Map();
  const startedMs = d.now();
  out(once ? 'Waiting for you now:' : 'Watching for questions, approvals and notices. Answer in another terminal with toolsenabled approvals. Ctrl-C to stop.');
  out(process.env.TOOLSENABLED_OPENSHELL_HOST === '1' ? require('./openshell-authority').HOST_NOTE : NOT_A_BOUNDARY);
  for (let first = true; ; first = false) {
    const nowMs = d.now();
    const { asks, notices } = d.channel.read(d.channelDependencies);
    const fresh = asks.filter((ask) => ask.state === 'waiting' && !printed.has(ask.id));
    // On the first pass, notices from the last ten minutes; after that, every new one.
    const newNotices = notices.filter((notice) => !seenNotices.has(notice.id) && (!first || Date.parse(notice.at) >= startedMs - 10 * 60 * 1000));
    if (fresh.length > 0 || newNotices.length > 0) {
      if (bell && fresh.length > 0) out('\u0007');
      out('');
      for (const ask of fresh) askLines(ask, nowMs).forEach((line) => out(line));
      for (const notice of newNotices) out(`notice ${noticeLine(notice)}`);
      d.channel.markShown(fresh.map((ask) => ask.id), d.channelDependencies);
    }
    for (const ask of fresh) printed.add(ask.id);
    for (const notice of notices) seenNotices.add(notice.id);
    // Say what became of each question printed here as its state changes.
    for (const ask of asks) {
      if (!printed.has(ask.id)) continue;
      const before = lastState.get(ask.id) || 'waiting';
      if (ask.state !== before) {
        out(ask.state === 'collected' || ask.state === 'expired' ? closedLine(ask) : answeredLine(ask));
        lastState.set(ask.id, ask.state);
      }
    }
    if (first && fresh.length === 0) out('Nothing is waiting for you.');
    if (once || (signal && signal.aborted)) return 0;
    await sleep(intervalMs, signal);
    if (signal && signal.aborted) return 0;
  }
}

const USAGE = [
  'Usage: toolsenabled approvals [--all]                  what agents are waiting on you for, recent notices, the rules in force',
  '       toolsenabled approvals approve <Q#> [words...]  yes to a question or a one-time approval',
  '       toolsenabled approvals deny <Q#> <reason...>    no (or take back an approval not yet used); the agent is told your reason',
  '       toolsenabled watch [--once]                     print each new question, approval and notice as it arrives'
];

/** `toolsenabled approvals ...` and `toolsenabled watch ...` (bin/toolsenabled-openshell.js). */
async function command(argv, { out = (line) => process.stdout.write(`${line}\n`), signal } = {}, dependencies = {}) {
  // The pages read the same state root as the agents' servers (setup writes it
  // into their registration); set before any state module loads.
  if (require('./openshell-inside').isInsideOpenShellSandbox() && !process.env.TOOLSENABLED_STATE_ROOT) {
    process.env.TOOLSENABLED_STATE_ROOT = require('node:path').join(require('node:os').homedir(), '.toolsenabled');
  }
  const [name, ...rest] = argv;
  const flags = rest.filter((word) => word.startsWith('--'));
  const words = rest.filter((word) => !word.startsWith('--'));
  if (name === 'watch') {
    const unknown = flags.filter((flag) => flag !== '--once');
    if (unknown.length > 0 || words.length > 0) throw refuse('APPROVALS_PAGE_USAGE', `Unexpected ${unknown[0] || words[0]}. ${USAGE[3].trim()}`);
    let stop = signal;
    if (!stop && !flags.includes('--once')) {
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      process.once('SIGTERM', () => controller.abort());
      stop = controller.signal;
    }
    return watch({ once: flags.includes('--once'), out, signal: stop, bell: Boolean(process.stdout.isTTY) }, dependencies);
  }
  const [verb, id, ...more] = words;
  const unknown = flags.filter((flag) => flag !== '--all');
  if (unknown.length > 0) throw refuse('APPROVALS_PAGE_USAGE', `Unknown option ${unknown[0]}. Use toolsenabled approvals help.`);
  if (verb === undefined || verb === 'list') {
    if (id !== undefined) throw refuse('APPROVALS_PAGE_USAGE', `Unexpected "${id}". Use toolsenabled approvals help.`);
    list({ all: flags.includes('--all') }, dependencies).forEach((line) => out(line));
    return 0;
  }
  if (verb === 'help') { USAGE.forEach((line) => out(line)); return 0; }
  if (verb === 'approve' || verb === 'deny') {
    if (id === undefined) throw refuse('APPROVALS_PAGE_USAGE', `Give the id: toolsenabled approvals ${verb} <id>${verb === 'deny' ? ' <reason>' : ''}.`);
    const said = more.join(' ');
    const result = verb === 'approve' ? approve({ id, words: said }, dependencies) : deny({ id, reason: said }, dependencies);
    formatDecision(result).forEach((line) => out(terminalSafeText(line)));
    return 0;
  }
  throw refuse('APPROVALS_PAGE_USAGE', `Unknown approvals action "${verb}". Use list, approve, deny or help.`);
}

module.exports = Object.freeze({
  view, format, list, approve, deny, formatDecision, setupLines, watch, command, rulesInForce, NOT_A_BOUNDARY, USAGE
});
