'use strict';

// WHO IS RUNNING ON THIS COMPUTER'S AGENT TREE, AND WHO EACH ONE REPORTS TO.
//
// THE DEFECT THIS EXISTS FOR, in the owner's words: "This is just the issue
// with trying to have it reach coordinator through agent comms it didnt work."
// A child agent started from a tree node was told the name of its manager and
// given a messaging tool, and every attempt was refused. Three separate walls
// produced that, and only one of them is about credentials or transport:
//
//   1. src/lib/providers/agent-comms.js addresses a recipient as
//      (actor, machineId) and REFUSES a recipient on the local machine by
//      design. The shipped config/service-registry.json declares exactly one
//      machine, so the tool's own recipientMachine enum contains exactly one
//      value and that value is the one the provider refuses. Measured, not
//      inferred: the enum is ["this-machine"] and the answer for it is
//      {accepted:false, code:"AGENT_COMMS_CROSS_MACHINE_RECIPIENT_REQUIRED"}.
//
//   2. Even where a recipient would be legal, the principal comes from
//      process.env.TOOLSENABLED_AGENT_ACTOR and nothing in the product sets it
//      for an app-spawned session, so the call dies with
//      AGENT_COMMS_ACTOR_REQUIRED before it reaches any addressing at all.
//
//   3. AND THE ONE THIS FILE IS ABOUT. There were two disjoint org structures.
//      The tree the person draws -- a node, its manager, its children -- lives
//      in the renderer's own store and never leaves the window. The messenger
//      consults a completely different structure. The tree held the
//      relationship; nothing that could deliver a message knew it existed.
//
// SO THIS IS THE MAPPING, AND IT IS THE POINT OF THE FIX. It translates the
// only two things a tree agent actually knows -- the name on its own circle and
// the name on the circle it wants to reach, both of which the person can read
// off the canvas -- into the durable agent identity the message fabric
// addresses. Nothing else in this feature is allowed to invent an address.
//
// WHY A NAME AND NOT AN INTERNAL ID. The owner's screenshot guessed that "the
// manager's internal agent ID isn't the..." right one. It is worse than that:
// the child is never told an internal id at all, deliberately --
// src/tree-node-brief.js's stated contract is that it names "the same string
// the person reads, never an internal id". A mapping keyed on anything else
// would require changing what a child is told, and the thing it is told is the
// thing a person can verify by looking at the screen. Names are therefore the
// address, and the ambiguity that creates is answered by refusing (see
// TREE_SENDER_AMBIGUOUS below) rather than by guessing which circle was meant.
//
// LIVENESS IS PART OF THE ADDRESS, NOT A DETAIL. An entry whose heartbeat has
// lapsed is NOT a recipient. A directory that answered from its own file would
// deliver into the void: the manager's session ended, the message lands in a
// durable spool nobody drains, and the child is told it was delivered. So a
// lapsed entry produces TREE_RECIPIENT_NOT_RUNNING with the recipient's name in
// it, and a sender whose own entry has lapsed cannot send at all. Both are
// answers a person can act on at two in the morning.
//
// SESSION BINDING. The app-owned MCP host now carries the session making the
// call. When supplied, that binding must match the sender's own live row, even
// if another session is the only one left under an old name. Legacy callers
// without a binding still use names alone; names are not authentication. A
// message only travels along an edge this directory holds, and both endpoints
// are recorded in durable fabric history.
//
// TWO TREES ON ONE COMPUTER, MEASURED 2026-09-03. The app's tree store numbers
// a role per tree, so a second tree's first Worker is also "Worker", and this
// file keyed on names alone: two live rows named "Worker" -- one per tree --
// and every roster or send from either was refused TREE_SENDER_AMBIGUOUS,
// including from the very circle making the call. Renaming is not the answer
// (a briefed agent knows its name from its own transcript and would write the
// old one into `from`), so two things narrow a name instead, and neither
// changes what a circle is told:
//
//   - a row may carry `treeKey`, the id of the top circle of its tree, handed
//     in by the app at registration. An edge, a roster and the manager
//     diagnosis never cross two rows whose keys are both known and differ. A
//     row without a key (written before the field existed, or a session the
//     app started without anchors) keeps the name-only answer it always had.
//   - a caller whose own session the tool surface can vouch for
//     (`senderSessionId`, taken from the owner host's binding and never from
//     the caller's words) resolves to its OWN row, regardless of how many rows
//     share its name. It only picks among the rows that already match; it never lets
//     a session send as a name that is on no live row, and a caller nobody
//     vouched for still meets the refusal above.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { acquireLock, pidAlive: lockPidAlive } = require('../process-claim-lock');
const { statePath } = require('../runtime-state-root');

const SCHEMA_VERSION = 1;

// The identity every other layer keys on. Chosen to satisfy the strictest
// validator in the chain -- local-runtime.js's AGENT_RE, /^[a-z0-9][a-z0-9_-]{0,63}$/
// -- so a directory entry can be handed to the fabric roster unchanged.
const AGENT_ID_PREFIX = 'tree-';
const AGENT_ID_HASH_LENGTH = 24;
const AGENT_ID_SHAPE = new RegExp(`^${AGENT_ID_PREFIX}[a-f0-9]{${AGENT_ID_HASH_LENGTH}}$`);

// A NAME IS BOUNDED BECAUSE IT ARRIVES FROM A TEXT BOX. The canvas lets a
// person call a circle anything; this file is a durable file read by another
// process, so the bound is enforced where it is written, not hoped for.
const MAX_NAME_LENGTH = 120;
const MAX_SESSION_ID_LENGTH = 512;
// This bounds saved directory records, including stopped sessions. Live
// process admission is enforced separately. Match the app's saved-node
// envelope so a 1,000-circle organisation does not fail at its 65th row.
const MAX_NODES = 4096;
// Enough for the full envelope with maximum-length, JSON-escaped fields.
// Check bytes as well as rows so malformed input cannot grow without bound.
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const ENTRY_KEYS = new Set([
  'agentId', 'nodeName', 'sessionId', 'managerAgentId', 'managerName',
  'managerUnresolved', 'registeredAt', 'heartbeatAt', 'stoppedAt', 'pid', 'threadId',
  'treeKey', 'nodeKey', 'supersededBy'
]);
/* WHICH TREE A CIRCLE IS ON, as an id the app already holds: the top circle's
 * node id, the same anchor the standing-request keys ride on every start (see
 * "TWO TREES ON ONE COMPUTER" above). Optional, bounded like a thread id, and
 * dropped rather than refused when unusable -- a registration must never be
 * lost over a scope hint, because a lost registration is a mute circle. */
const MAX_TREE_KEY_LENGTH = 128;

function normalizeTreeKey(treeKey) {
  if (typeof treeKey !== 'string') return null;
  const trimmed = treeKey.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TREE_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/* THE SAME TREE, OR NOT KNOWN TO BE DIFFERENT. Two rows are kept apart only
 * when both name a tree and the trees differ; a row without a key matches by
 * name alone, exactly as every row did before the key existed. */
function sameTree(left, right) {
  const a = typeof left.treeKey === 'string' ? left.treeKey : null;
  const b = typeof right.treeKey === 'string' ? right.treeKey : null;
  return a === null || b === null || a === b;
}

/* A bound session must identify its own live row even when only one name
 * matches. After a stop, restart or move, the sole remaining row may belong to
 * another circle. Callers without a binding retain legacy name-only lookup. */
function ownLiveRow(liveRows, senderSessionId) {
  const own = typeof senderSessionId === 'string' ? senderSessionId.trim() : '';
  // A bound caller cannot adopt another circle's name, even when it is unique.
  if (!own) return liveRows.length === 1 ? liveRows[0] : null;
  const matches = liveRows.filter(node => node.sessionId === own);
  return matches.length === 1 ? matches[0] : null;
}
/* A CIRCLE'S OWN ROW, WHEN THE NAME IT WAS GIVEN IS ON NO ROW AT ALL.
 *
 * The tree brief an agent reads is written once and never revised, while a row
 * here is rewritten from a freshly computed name at every registration. The
 * same namer produces both, so they agree at any instant and drift apart as
 * peers appear: a circle briefed before a same-role peer existed is briefed
 * with the unqualified name, and its next registration stores the qualified
 * one. Without this the product instructs an agent to use an address it then
 * refuses.
 *
 * The caller is resolved, never the name. `sessionId` is the session the owner
 * host bound this transport to. It is injected context, never a field of the
 * call, so it is proof rather than a guess -- and it is present whether or not
 * the session also carries a declared agent identity.
 *
 * INVARIANTS, each held by a case in
 * tests/agent-comms/tree-address-historical-sender.test.js:
 *   - reached only when NO row carries the supplied name, so a name that
 *     currently identifies someone else is never overridden;
 *   - matches only rows whose sessionId is the caller's, so no other session
 *     can be selected and no name is aliased across trees;
 *   - requires exactly one live own row, so an unvouched caller, a stopped row
 *     and an absent row keep their refusals.
 * The resolved row is what the delivery carries, so the message names the
 * sender's current identity. */
function historicalSenderRow(nodes, sessionId, live) {
  const own = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!own) return null;
  const mine = nodes.filter(node => node.sessionId === own && live(node));
  return mine.length === 1 ? mine[0] : null;
}

/* THE ENGINE THREAD BEHIND A CIRCLE, so a resume can find its own address.
 *
 * MEASURED 2026-09-02: a person resumed a Manager node; the shell started a
 * NEW session (new sessionId, hence a new agentId) whose first turn was the
 * word "resume" and not the tree brief, so nothing registered it, the old
 * registration went stale, and every send from that circle answered
 * TREE_SENDER_NOT_RUNNING while the agent sat there fully alive. The thread
 * id is the one thing a resume carries that names the conversation it
 * continues, so the entry keeps it and a resumed session can adopt the
 * name and manager the old session held. Optional: a session with no engine
 * thread yet registers exactly as before. */
const MAX_THREAD_ID_LENGTH = 512;

function normalizeThreadId(threadId) {
  if (threadId === undefined || threadId === null) return null;
  if (typeof threadId !== 'string') return null;
  const trimmed = threadId.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_THREAD_ID_LENGTH) return null;
  return trimmed;
}

// HOW LONG AN ENTRY SPEAKS FOR ITSELF WITHOUT SAYING ANYTHING.
//
// The app heartbeats every running session. This window has to be long enough
// that a busy main process missing a beat does not make a live manager
// unreachable, and short enough that a crashed window stops being a valid
// recipient while the person still remembers starting it. Ninety seconds is
// three missed beats at the thirty-second cadence the host uses.
const DEFAULT_LIVE_WINDOW_MS = 90_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

function sleepSync(milliseconds) {
  if (milliseconds > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }
}

/* A RETRY THAT ASKS FOR A NEW TICKET IS NOT A RETRY, IT IS REJOINING THE BACK
 * OF THE LINE -- and every contender doing that at once is the thundering herd
 * lock.js's own bakery queue was built to avoid.
 *
 * MEASURED 2026-09-03: eight processes (this file's own live ceiling --
 * MAX_AGENT_SESSIONS in shell/main.cjs) calling registerNode() concurrently,
 * default settings throughout. 64 calls, 45 (70%) failed TREE_DIRECTORY_BUSY,
 * each after burning the full ~10-13s this function let it wait; raising the
 * budget to 60s did not fix it -- calls kept failing at the full 60s, so this
 * is not "too impatient", it is a herd that never converges. Total wall time
 * for the run: 82.8s. The identical scenario against the fix below: 64/64
 * succeeded, 0 failures, in 39.2s -- faster AND correct, because nothing was
 * burning its whole budget on a doomed attempt any more.
 *
 * THE CAUSE. acquireLock() (lock.js) already has the fix for this -- read its
 * own comment above `contentionDeadline`: a ticket holder that finds another
 * ticket ahead of it WAITS, "instead of a thundering herd which
 * discards/reissues random tickets and can starve despite an outer caller
 * retrying for seconds." But that patience is bounded by ONE call's own
 * `publishGraceMs` (default 250ms), and this function was calling
 * acquireLock() again from scratch on every failure -- with no `publishGraceMs`
 * of its own, so lock.js's default applied. createClaim() mints a fresh random
 * nonce and a fresh ticket number every time it runs, so each of those retries
 * abandoned whatever queue position the previous attempt had built and asked
 * for a new one 25ms later. With eight processes all doing that, the queue
 * never stood still long enough for anyone to reach the front of it.
 *
 * THE FIX ASKS THE SAME MECHANISM TO WAIT LONGER, ONCE, INSTEAD OF ASKING IT
 * AGAIN. `publishGraceMs` is lock.js's own knob for exactly this, already
 * exposed and already documented there -- this file was simply never passing
 * it. Handing it the rest of OUR deadline lets one ticket sit in the stable
 * queue for as long as this caller was already willing to wait overall,
 * instead of rejoining the herd every 250-300ms. A holder that is not merely
 * busy but genuinely gone is still reaped: liveOrStaleClaim() still runs once
 * that (now longer) grace elapses, on the same path as before. The 25ms sleep
 * below still matters for the deadline's last moments and for a caller that
 * races acquireLock() itself (AGENT_DIGEST_ALREADY_RUNNING before any grace
 * wait began). */
function acquireMutationLock(lockFile, { pid, isAlive, timeoutMs, sleep }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remainingMs = deadline - Date.now();
    try {
      return acquireLock(lockFile, { pid, isAlive, publishGraceMs: Math.max(250, remainingMs), sleep });
    } catch (error) {
      if (!error || error.code !== 'AGENT_DIGEST_ALREADY_RUNNING' || Date.now() >= deadline) throw error;
      sleep(25);
    }
  }
}

class TreeDirectoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TreeDirectoryError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new TreeDirectoryError(code, message, details);
}

function directoryFile({ env = process.env } = {}) {
  const canonical = path.resolve(statePath('state', 'agent-comms', 'tree-nodes.json'));
  const configured = env.TOOLSENABLED_TREE_DIRECTORY_FILE;
  if (typeof configured === 'string' && configured.trim()) {
    const resolved = configured.trim();
    if (resolved.includes(String.fromCharCode(0))) fail('TREE_DIRECTORY_PATH_INVALID', 'The tree directory path contains a NUL byte.');
    if (!path.isAbsolute(resolved)) {
      fail('TREE_DIRECTORY_PATH_INVALID', 'The tree directory path must be absolute.');
    }
    const candidate = path.resolve(resolved);
    const same = process.platform === 'win32'
      ? candidate.toLowerCase() === canonical.toLowerCase()
      : candidate === canonical;
    if (!same) {
      fail('TREE_DIRECTORY_PATH_INVALID',
        'The tree directory file is fixed inside the ToolsEnabled state root and cannot be redirected to an arbitrary file.');
    }
    return canonical;
  }
  return canonical;
}

/** The durable identity for one running tree session. Stable for that session
 *  and derived from nothing a caller can choose, so two windows cannot mint the
 *  same address for different nodes. */
function normalizeSessionId(sessionId) {
  if (typeof sessionId !== 'string') {
    fail('TREE_SESSION_ID_INVALID', 'A tree session id is required.');
  }
  const normalized = sessionId.trim();
  if (normalized.length === 0 || normalized.length > MAX_SESSION_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(normalized)) {
    fail('TREE_SESSION_ID_INVALID',
      `A tree session id must contain 1 through ${MAX_SESSION_ID_LENGTH} non-control characters.`);
  }
  return normalized;
}

function agentIdForSession(sessionId) {
  const normalized = normalizeSessionId(sessionId);
  const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `${AGENT_ID_PREFIX}${digest.slice(0, AGENT_ID_HASH_LENGTH)}`;
}

/** COMPARISON IS WHAT THE PERSON WOULD CALL THE SAME NAME. Leading and trailing
 *  space and letter case are not differences a person intends when they type a
 *  name into a circle; everything else is. */
function nameKey(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

function normalizeName(value, label) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (text.length === 0) fail('TREE_NAME_INVALID', `${label} must not be empty.`, { field: label });
  if (text.length > MAX_NAME_LENGTH) {
    fail('TREE_NAME_INVALID', `${label} is longer than ${MAX_NAME_LENGTH} characters.`, { field: label });
  }
  // A name reaches a model's prompt and a durable file. Control characters in
  // it are never something a person typed on purpose and are exactly what makes
  // a later reader's parse ambiguous.
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    fail('TREE_NAME_INVALID', `${label} contains control characters.`, { field: label });
  }
  return text;
}

function emptyRecord() {
  return { version: SCHEMA_VERSION, nodes: [] };
}

function validStoredName(value, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  if (typeof value !== 'string') return false;
  try { return normalizeName(value, 'storedName') === value; }
  catch { return false; }
}

function validStoredSession(entry) {
  if (typeof entry.sessionId !== 'string') return false;
  try {
    return normalizeSessionId(entry.sessionId) === entry.sessionId
      && agentIdForSession(entry.sessionId) === entry.agentId;
  } catch {
    return false;
  }
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** The manager a row names but this tree does not hold, or null when the edge
 *  resolves. Pure, and computed from the node set it is given, so a read can
 *  restate it as safely as a write can record it. */
function managerIndex(nodes) {
  const byAgent = new Map();
  const byName = new Map();
  for (const node of nodes) {
    if (node.supersededBy) continue;
    byAgent.set(node.agentId, node);
    const key = nameKey(node.nodeName);
    const entry = byName.get(key) || { total: 0, trees: new Map() };
    entry.total += 1;
    const tree = node.treeKey || null;
    entry.trees.set(tree, (entry.trees.get(tree) || 0) + 1);
    byName.set(key, entry);
  }
  return { byAgent, byName };
}

function unresolvedManager(sender, nodes, index = null) {
  if (!sender.managerName) return null;
  const managerKey = nameKey(sender.managerName);
  if (index) {
    const addressed = sender.managerAgentId && index.byAgent.get(sender.managerAgentId);
    if (addressed && addressed.agentId !== sender.agentId && sameTree(sender, addressed)) return null;
    const matches = index.byName.get(managerKey);
    if (!matches) return sender.managerName;
    const count = sender.treeKey
      ? (matches.trees.get(sender.treeKey) || 0) + (matches.trees.get(null) || 0)
      : matches.total;
    return count > Number(nameKey(sender.nodeName) === managerKey) ? null : sender.managerName;
  }
  return nodes.some(node => !node.supersededBy && node.agentId !== sender.agentId
    && sameTree(sender, node)
    && (node.agentId === sender.managerAgentId || nameKey(node.nodeName) === managerKey))
    ? null
    : sender.managerName;
}

/* WHICH FIELD, NOT MERELY "INVALID".
 *
 * The 2026-09-02 outage below cost eighty minutes because the only thing
 * anybody could see was "The tree directory contains an invalid node list."
 * That names a fact and no action: not the file, not the row, not the field.
 * The verdict and the diagnosis are therefore the SAME computation --
 * validEntry() is `entryProblem(entry) === null` -- so the refusal can never
 * describe a row differently from the way it judged it. Every predicate below
 * is the one that was already here, in the order it was already evaluated.
 *
 * Field names are safe to print; stored values are not, and none is printed. */
function entryProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'it is not a JSON object';
  const unknown = Reflect.ownKeys(entry).find(key => typeof key !== 'string' || !ENTRY_KEYS.has(key));
  if (unknown !== undefined) return `it carries a field this version does not know ("${String(unknown).slice(0, 60)}")`;
  if (typeof entry.agentId !== 'string' || !AGENT_ID_SHAPE.test(entry.agentId)) return 'its "agentId" is not a tree agent identity';
  if (!validStoredName(entry.nodeName)) return 'its "nodeName" is empty, over 120 characters, or not already normalized';
  if (!validStoredSession(entry)) return 'its "sessionId" is unusable or does not derive the "agentId" beside it';
  if (!(entry.managerAgentId === null
    || (typeof entry.managerAgentId === 'string' && AGENT_ID_SHAPE.test(entry.managerAgentId)))) {
    return 'its "managerAgentId" is neither null nor a tree agent identity';
  }
  if (!validStoredName(entry.managerName, { nullable: true })) return 'its "managerName" is not null and not a normalized name';
  /* THE DIAGNOSIS IS CHECKED AS A NAME, NOT AS AGREEMENT WITH THE MANAGER EDGE.
   *
   * MEASURED 2026-09-02 on an installed copy: one row held managerName
   * "Controller" beside managerUnresolved "Controller 2" -- a stale diagnosis
   * left by an earlier writer. Requiring the two to agree made that one row
   * condemn the whole file as TREE_DIRECTORY_MALFORMED, and every agent_comms
   * tool on the machine answered with an internal error for eighty minutes,
   * because the read that every send, roster and journal starts with refuses
   * as a unit. The field is a durable diagnosis and never routing authority --
   * `reachabilityFrom` recomputes it from the live node set and never reads the
   * stored value -- so a disagreement is staleness, not corruption. It is
   * healed on read (see `readRecord`) rather than being fatal, and the shape
   * that reaches a person's screen is still enforced here. */
  if (!(entry.managerUnresolved === undefined
    || entry.managerUnresolved === null
    || validStoredName(entry.managerUnresolved))) {
    return 'its "managerUnresolved" is not null and not a normalized name';
  }
  if (!validTimestamp(entry.registeredAt)) return 'its "registeredAt" is not a non-negative whole-millisecond timestamp';
  if (!validTimestamp(entry.heartbeatAt)) return 'its "heartbeatAt" is not a non-negative whole-millisecond timestamp';
  if (!(entry.stoppedAt === undefined || entry.stoppedAt === null || validTimestamp(entry.stoppedAt))) {
    return 'its "stoppedAt" is neither null nor a non-negative whole-millisecond timestamp';
  }
  if (!(entry.pid === undefined || entry.pid === null
    || (Number.isSafeInteger(entry.pid) && entry.pid > 0))) {
    return 'its "pid" is neither null nor a positive whole number';
  }
  if (!(entry.threadId === undefined || entry.threadId === null
    || (typeof entry.threadId === 'string' && entry.threadId.length > 0 && entry.threadId.length <= MAX_THREAD_ID_LENGTH))) {
    return `its "threadId" is neither null nor text of 1 to ${MAX_THREAD_ID_LENGTH} characters`;
  }
  if (!(entry.treeKey === undefined || entry.treeKey === null
    || (typeof entry.treeKey === 'string' && normalizeTreeKey(entry.treeKey) === entry.treeKey))) {
    return `its "treeKey" is neither null nor already-normalized text of 1 to ${MAX_TREE_KEY_LENGTH} characters`;
  }
  if (!(entry.nodeKey === undefined || entry.nodeKey === null
    || (typeof entry.nodeKey === 'string' && normalizeTreeKey(entry.nodeKey) === entry.nodeKey))) {
    return `its "nodeKey" is neither null nor already-normalized text of 1 to ${MAX_TREE_KEY_LENGTH} characters`;
  }
  /* THE TRAIL FROM A RETIRED ADDRESS TO THE CIRCLE THAT CONTINUED IT.
     Present only on a tombstone: a row whose session was replaced, kept so a
     message already addressed to the old agentId can still be delivered. It
     names an agentId, so it is checked the way one is. */
  if (!(entry.supersededBy === undefined || entry.supersededBy === null
    || (typeof entry.supersededBy === 'string' && AGENT_ID_SHAPE.test(entry.supersededBy)
      && entry.supersededBy !== entry.agentId && Number.isFinite(entry.stoppedAt)))) {
    return 'its "supersededBy" is neither null nor an agent id';
  }
  return null;
}

function validEntry(entry) {
  return entryProblem(entry) === null;
}

/* EVERY agent_comms READ STARTS HERE, SO EVERY ONE OF THEM FAILS AS A UNIT.
 *
 * Measured in this installation's capability/logs/actions.jsonl: 25 refusals
 * of agent_comms.local_roster and agent_comms.send_local whose whole
 * caller-visible reason was "The tree directory contains an invalid node
 * list." Nothing in that sentence says where the file is, which of up to 64
 * rows is wrong, what is wrong with it, or what to do -- and the same sentence
 * was also used for a `nodes` field that was not a list at all and for a
 * directory holding too many rows, so two of its three causes were misstated.
 *
 * This is the shared tail: the file to open, and the one instruction that is
 * true for all of these -- the file is written by the app, so a hand edit is
 * the usual cause, and a wrong row is preserved rather than repaired. */
function directoryRefusal(file, problem) {
  return `The tree directory at ${file} ${problem}, so every agent_comms read on this computer refuses until it is valid. `
    + 'This file is written by the app and is not meant to be edited by hand; a hand edit is the usual cause. '
    + 'The wrong content is preserved rather than repaired, so open that file and correct exactly what is named here.';
}

/* A MALFORMED OR PARTIALLY READ DIRECTORY IS NOT AN EMPTY DIRECTORY.
 *
 * Returning an empty record here used to turn a failed parse, a wrong schema,
 * or invalid rows into confident "unknown" answers about agents. Refuse the
 * read instead. A genuinely absent file is accepted only by the operation
 * which creates the directory's first row. */
function readRecord(file, { fsImpl = fs, allowMissing = false } = {}) {
  let raw;
  try {
    if (typeof fsImpl.statSync === 'function' && fsImpl.statSync(file).size > MAX_DOCUMENT_BYTES) {
      fail('TREE_DIRECTORY_MALFORMED', directoryRefusal(file, `exceeds the ${MAX_DOCUMENT_BYTES}-byte document limit`), { file, limit: MAX_DOCUMENT_BYTES });
    }
    raw = fsImpl.readFileSync(file, 'utf8');
  }
  catch (error) {
    if (error && error.code === 'TREE_DIRECTORY_MALFORMED') throw error;
    if (allowMissing && error && error.code === 'ENOENT') return emptyRecord();
    const causeCode = error && typeof error.code === 'string' ? error.code : null;
    // "Could not read" is not "is not there": say which it was, by the code the
    // filesystem returned, so a permission problem is never read as an absence.
    fail('TREE_DIRECTORY_UNREADABLE',
      `The tree directory at ${file} could not be read (${causeCode || 'no filesystem code was reported'}), `
      + 'so every agent_comms read on this computer refuses until it can be read. This is a filesystem answer and not '
      + 'a statement that no agents are registered: check that the file exists and that this Windows identity may read it.',
      { causeCode });
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_DOCUMENT_BYTES) {
    fail('TREE_DIRECTORY_MALFORMED', directoryRefusal(file, `exceeds the ${MAX_DOCUMENT_BYTES}-byte document limit`), { file, limit: MAX_DOCUMENT_BYTES });
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    fail('TREE_DIRECTORY_MALFORMED', directoryRefusal(file, 'is not valid JSON'), { file });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== SCHEMA_VERSION) {
    fail('TREE_DIRECTORY_MALFORMED',
      directoryRefusal(file, `is not an object with "version": ${SCHEMA_VERSION}, which is the only schema this build reads`),
      { file, expectedVersion: SCHEMA_VERSION });
  }
  if (!Array.isArray(parsed.nodes)) {
    fail('TREE_DIRECTORY_MALFORMED', directoryRefusal(file, 'has a "nodes" field that is not a list'), { file });
  }
  if (parsed.nodes.length > MAX_NODES) {
    fail('TREE_DIRECTORY_MALFORMED',
      directoryRefusal(file, `lists ${parsed.nodes.length} rows and this build reads at most ${MAX_NODES}`),
      { file, nodeCount: parsed.nodes.length, limit: MAX_NODES });
  }
  for (let index = 0; index < parsed.nodes.length; index += 1) {
    const problem = entryProblem(parsed.nodes[index]);
    if (problem === null) continue;
    // The row is named by position and, when its identity is itself readable,
    // by agentId. No stored value is echoed: a node name comes from a text box.
    const node = parsed.nodes[index];
    const identity = node && typeof node === 'object' && typeof node.agentId === 'string' && AGENT_ID_SHAPE.test(node.agentId)
      ? ` (agentId ${node.agentId})`
      : '';
    fail('TREE_DIRECTORY_MALFORMED',
      directoryRefusal(file, `has a row that this build cannot read: row ${index + 1} of ${parsed.nodes.length}${identity}, because ${problem}`),
      { file, nodeIndex: index, problem });
  }
  const durableAgentIds = new Set();
  for (const node of parsed.nodes) {
    if (durableAgentIds.has(node.agentId)) {
      fail('TREE_DIRECTORY_MALFORMED',
        directoryRefusal(file, `lists the same durable session identity twice (agentId ${node.agentId}); one row must be removed`),
        { file, agentId: node.agentId });
    }
    durableAgentIds.add(node.agentId);
  }
  /* A STALE DIAGNOSIS IS RESTATED, NOT OBEYED AND NOT MOURNED. Whoever wrote
   * the row -- an older build, a hand edit, a writer that changed managerName
   * without recomputing -- the answer this process gives about an unreachable
   * manager is the one its own node set supports. Nothing is written back here;
   * the next mutation persists the healed value because it writes what it read. */
  if (parsed.links !== undefined) {
    if (!Array.isArray(parsed.links) || parsed.links.length > 8192) {
      fail('TREE_DIRECTORY_MALFORMED', 'Direct tree links must be a list of at most 8192 pairs.');
    }
    const seen = new Set();
    for (const link of parsed.links) {
      if (!link || Object.keys(link).some(key => !['from', 'to'].includes(key))
        || normalizeTreeKey(link.from) !== link.from || !link.from
        || normalizeTreeKey(link.to) !== link.to || !link.to || link.from >= link.to) {
        fail('TREE_DIRECTORY_MALFORMED', 'A direct tree link has invalid saved node identities.');
      }
      const key = JSON.stringify([link.from, link.to]);
      if (seen.has(key)) fail('TREE_DIRECTORY_MALFORMED', 'The directory repeats a direct tree link.');
      seen.add(key);
    }
  }
  const managers = managerIndex(parsed.nodes);
  const nodes = parsed.nodes.map(node => {
    const diagnosed = unresolvedManager(node, parsed.nodes, managers);
    return node.managerUnresolved === diagnosed ? node : { ...node, managerUnresolved: diagnosed };
  });
  return { version: SCHEMA_VERSION, nodes, ...(parsed.links ? { links: parsed.links } : {}) };
}

/* TEMP-AND-RENAME IS NOT THE SAME AS DURABLE, AND THIS FILE PAID FOR THE
 * DIFFERENCE.
 *
 * The rename below has always meant a reader never sees half a file. It does
 * NOT mean the bytes reached the disk: without an fsync, the rename can be
 * recorded while the data blocks it points at are still only in the cache, and
 * an unclean shutdown then leaves a file of the right LENGTH full of zeros.
 *
 * MEASURED 2026-09-03: this directory was found as 22,346 bytes of pure NUL and
 * quarantined as tree-nodes.json.corrupt-...zeros. The reader's own guard
 * caught it and rebuilt, but everything in it was gone -- every circle
 * registered at that moment lost its address at once, which is the fleet-wide
 * failure this file is the single point of. A second file on this machine went
 * the same way the same day, and this machine has a recorded history of
 * unclean power events, so the window is real and not theoretical.
 *
 * A dozen other writers in this engine already fsync before renaming
 * (agent-presence.js, agent-org-store.js, browser-owner.js, audit.js among
 * them). The shared file the whole tree depends on was one of the ones that
 * did not. The handle is opened with 'wx' so a leftover temp from a dead
 * process is never silently written through, and the finally block removes the
 * temp on any failure rather than leaving litter beside the real file.
 *
 * fsyncSync is called only when the injected filesystem offers it, matching
 * agent-presence.js: a test fake without it still works and is not silently
 * treated as durable. */
function writeRecord(file, record, { fsImpl = fs } = {}) {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) {
    fail('TREE_DIRECTORY_FULL', 'The saved tree directory exceeds its document byte limit.', { limit: MAX_DOCUMENT_BYTES });
  }
  const directory = path.dirname(file);
  fsImpl.mkdirSync(directory, { recursive: true });
  // Temp-and-rename, so a reader in the other process never sees half a file.
  // The suffix carries the pid because two processes may register at once.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = fsImpl.openSync(temporary, 'wx');
    fsImpl.writeFileSync(handle, text, { encoding: 'utf8' });
    if (typeof fsImpl.fsyncSync === 'function') fsImpl.fsyncSync(handle);
    fsImpl.closeSync(handle);
    handle = undefined;
    fsImpl.renameSync(temporary, file);
  } finally {
    if (handle !== undefined) {
      try { fsImpl.closeSync(handle); } catch { /* best effort */ }
    }
    try { fsImpl.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
  return file;
}

/* IS THERE A LINE BETWEEN THESE TWO CIRCLES, and which way does it point.
 *
 * A name can establish the edge before a manager session exists: a person can
 * start a tree bottom-up. Once a unique saved manager exists, read/write repair
 * binds its address and follows only same-nodeKey successors. A name remains
 * the legacy fallback for rows with no saved identity; it cannot override an
 * established address when a different circle later reuses the old label.
 */
function directlyLinked(sender, candidate, links = []) {
  if (!sender.nodeKey || !candidate.nodeKey || sender.nodeKey === candidate.nodeKey) return false;
  const [from, to] = [sender.nodeKey, candidate.nodeKey].sort();
  return links.some(link => link.from === from && link.to === to);
}

function managerEdge(child, candidate, byAgent) {
  if (child.managerAgentId) {
    if (candidate.agentId === child.managerAgentId) return true;
    const current = byAgent?.get(child.managerAgentId);
    // A retained address alias may still be named in an in-flight request.
    // A different live circle reusing its old label gains no relationship.
    return Boolean(candidate.supersededBy && current?.nodeKey
      && candidate.nodeKey === current.nodeKey && sameTree(candidate, current));
  }
  return Boolean(child.managerName && nameKey(child.managerName) === nameKey(candidate.nodeName));
}

function edge(sender, candidate, links = [], byAgent = null) {
  if (directlyLinked(sender, candidate, links)) return true;
  /* Two trees that use the same role names are two different lines. A row
     that names no tree still matches by name, as it always did. */
  if (!sameTree(sender, candidate)) return false;
  return managerEdge(sender, candidate, byAgent) || managerEdge(candidate, sender, byAgent);
}

function relationOf(sender, candidate, links = [], byAgent = null) {
  if (directlyLinked(sender, candidate, links)) return 'linked-agent';
  if (managerEdge(sender, candidate, byAgent)) return 'manager';
  return 'reports-to-sender';
}

/* A PROCESS THAT IS GONE IS NOT RUNNING A SESSION, WHATEVER ITS LAST HEARTBEAT
 * SAYS. Every row carries the pid of the process that registered it, and the
 * heartbeat window is three missed beats -- ninety seconds -- during which a
 * crashed app's rows went on answering "live". A child started under such a
 * manager in that window was told its message was delivered, into a spool
 * nobody will ever drain; the canvas, meanwhile, already said the session
 * ended with the app. The probe only ever turns "live" into "not live": a pid
 * that has been reused reads as alive (the answer this file always gave), and
 * a probe that cannot answer at all reads as alive too, because a liveness
 * hint must never become the one refusal every agent_comms read shares. */
function processGone(entry, pidIsAlive) {
  if (!(Number.isSafeInteger(entry.pid) && entry.pid > 0)) return false;
  try { return pidIsAlive(entry.pid) === false; }
  catch { return false; }
}

function liveAt(entry, atMs, liveWindowMs, pidIsAlive = null) {
  if (Number.isFinite(entry.stoppedAt)) return false;
  if (!(Number.isFinite(entry.heartbeatAt) && atMs - entry.heartbeatAt <= liveWindowMs)) return false;
  return pidIsAlive === null || !processGone(entry, pidIsAlive);
}

/* A STOPPED NODE IS REMEMBERED FOR A WHILE, AND THAT IS THE WHOLE POINT.
 *
 * Deleting the entry on close was the first version and it produced the wrong
 * sentence: a child writing to a manager that had just stopped was told "no
 * agent called Manager is registered on this computer's tree", which reads as
 * "you got the name wrong" and sends the person looking for a typo. The name
 * was right; the session ended. So the row survives its session, marked, long
 * enough for that distinction to be the answer, and is swept afterwards so the
 * directory does not accumulate every agent the person ever started. */
const STOPPED_RETENTION_MS = 60 * 60 * 1000;

/* A ROW WITH NO stoppedAt IS NOT A ROW THAT IS STILL RUNNING -- it may be one
 * whose process never got the chance to say so.
 *
 * MEASURED 2026-09-03 against the live directory (11 rows): two, both named
 * "Controller", carried stoppedAt: null with heartbeatAt 4007s and 2229s in
 * the past -- 66 and 37 minutes past the 90-second live window, with no
 * session left anywhere to call unregisterNode for them. (This machine has a
 * recorded history of unclean power events; a killed or crashed process
 * leaves exactly this shape -- heartbeats stop, nothing ever marks stoppedAt.)
 * The old expired() answered false for both, and would go on answering false
 * forever: a row only ages out once stoppedAt is set, and nothing ever sets
 * it for a session that did not exit cleanly. Delivery was never fooled --
 * liveAt() already treats a lapsed heartbeat as not-live no matter what
 * stoppedAt says -- but the row itself was immortal: one of MAX_NODES=64
 * slots spent forever on a circle nobody can reach and this file could never
 * retire, on a machine where this is not a rare event.
 *
 * The fix gives a heartbeat that has gone silent the same grace period a
 * clean stop gets, measured from the last proof of life instead of from a
 * close that never happened. A session that is merely slow keeps its row --
 * the live window is 90 seconds and this is sixty minutes, forty times
 * longer -- and a session that is genuinely gone stops being immortal. */
function expired(entry, atMs) {
  return Number.isFinite(entry.stoppedAt)
    ? atMs - entry.stoppedAt > STOPPED_RETENTION_MS
    : atMs - entry.heartbeatAt > STOPPED_RETENTION_MS;
}

/* T255: THE ONE PLACE THAT DECIDES WHETHER A NOT-RUNNING ROW CAN BE WOKEN.
 *
 * Two callers need this answer and they must never be able to disagree:
 * resolveDelivery(), which refuses a row that cannot wake, and the roster's
 * unavailable rows, which tell a person whether writing would be held for a
 * wake. Those started as two separate expressions -- the roster asking
 * `!superseded && !expired` and the delivery path refusing on
 * `superseded || expired`. Logically identical by De Morgan, which is exactly
 * what made it dangerous: nothing structural kept them in step, so a third
 * condition added to one would leave the other quietly offering a wake the
 * delivery path refuses. That is the failure the roster change exists to
 * prevent, reintroduced one level up.
 *
 * A superseded row is a tombstone: its circle either continued elsewhere, which
 * resolveDelivery handles before reaching here, or ended. An expired row is past
 * STOPPED_RETENTION_MS and no longer describes anything startable. Neither is a
 * stopped circle waiting to be reached.
 *
 * Liveness is deliberately NOT part of this. A running row never gets here, and
 * folding that in would make the predicate answer a different question for each
 * caller -- which is the shape of the problem it was extracted to remove. */
function canWake(entry, atMs) {
  return typeof entry.supersededBy !== 'string' && !expired(entry, atMs);
}

/* ONE ENGINE THREAD, ONE ROW -- A RESUMED CIRCLE TAKES ITS ENTRY OVER RATHER
 * THAN STANDING BESIDE IT.
 *
 * MEASURED 2026-09-03 against this module: register "Manager" on thread T,
 * register its "Worker", then register the RESUME of Manager on the same thread
 * T without the first row having been unregistered -- which is what a process
 * that ended without closing its sessions leaves behind, inside the 90s live
 * window. Both Manager rows came back live, and resolveDelivery({from:'Worker',
 * to:'Manager'}) answered TREE_RECIPIENT_AMBIGUOUS: "More than one running
 * agent connected to you is called \"Manager\". Rename one of them." One circle
 * on the person's canvas, unreachable, and the advice was to rename it.
 * reachabilityFrom listed the same Manager twice.
 *
 * With the first row properly STOPPED -- the ordinary in-app resume -- the
 * roster still answered with the circle under both headings at once: reachable
 * "Manager" AND unavailable "Manager, registered-but-session-stopped", for the
 * full hour of stopped retention. That is what the model reads before it writes.
 *
 * A THREAD RUNS IN EXACTLY ONE SESSION, so a row naming a thread that a new
 * registration has just taken over is not the record of a stopped circle that
 * STOPPED_RETENTION_MS exists to preserve -- it is a stale duplicate of the
 * circle registering now, and the row that replaces it says everything the old
 * one could. Only same-thread rows go: a circle that merely stopped keeps its
 * entry, and its "the session ended" sentence, because nothing re-registers its
 * thread. Rows carrying no thread are never matched. */
function supersededByThread(entry, incoming) {
  // A saved circle ID is stronger evidence than an engine conversation ID:
  // copied conversations may be resumed in two different saved circles.
  if (incoming.threadId === null || entry.threadId !== incoming.threadId) return false;
  if (entry.nodeKey && incoming.nodeKey) return entry.nodeKey === incoming.nodeKey;
  return sameTree(entry, incoming);
}

/* THE SAME CIRCLE, COMING BACK UNDER THE SAME NAME ON THE SAME TREE, WITH
 * NOTHING SHARING A THREAD.
 *
 * The thread rule above covers a resume. Page 2 has two other ways a circle
 * registers again, and both left the earlier row standing beside the new one
 * for the whole hour of STOPPED_RETENTION_MS: a clean restart (the old session
 * closed, a NEW session on a NEW thread registers the saved identity), and a
 * resume after a crash by a provider that never bound a thread id -- or a
 * seeded resume, which starts a fresh thread by design. The roster a Worker
 * read then listed its Manager as reachable AND as
 * "registered-but-session-stopped", at once, for an hour.
 *
 * A name is unique per tree: the app persists a per-tree ordinal on every
 * circle ("Worker", "Worker 2") precisely so that two circles never share
 * one. So a row with the same name key and the SAME KNOWN tree key is this
 * circle's earlier session, and when it is not live -- stopped, lapsed, or
 * its process gone -- the registration now arriving is its replacement. A
 * same-name row that is still live is left alone: that is a real conflict,
 * and TREE_SENDER_AMBIGUOUS / TREE_RECIPIENT_AMBIGUOUS are its honest
 * answer. A row without a tree key, or on another tree, is another circle's
 * history and keeps the "its session ended" sentence it was retained for. */
function supersededByCircle(entry, incoming, isLive) {
  if (entry.agentId === incoming.agentId) return false;
  // Saved IDs survive a move or a label repair. The name/tree fallback below
  // is only for older rows that cannot provide this stronger identity.
  if (entry.nodeKey && incoming.nodeKey) return entry.nodeKey === incoming.nodeKey && !isLive(entry);
  if (typeof entry.treeKey !== 'string' || typeof incoming.treeKey !== 'string') return false;
  if (entry.treeKey !== incoming.treeKey) return false;
  if (nameKey(entry.nodeName) !== nameKey(incoming.nodeName)) return false;
  return !isLive(entry);
}

/* ONE SAVED CIRCLE IS ONE RECIPIENT, WHATEVER SESSIONS IT HAS RUN IN (T839).
 *
 * MEASURED 2026-09-21 on this module alone, no app: a circle an account recovery
 * replaced (a6 -> b6) answered its manager three different ways depending only on
 * the successor's state, and none of them was the truth. The successor still
 * starting (registered, heartbeat not yet renewed) was TREE_RECIPIENT_AMBIGUOUS by
 * name and TREE_RECIPIENT_NOT_RUNNING by its old address; a successor the person had
 * stopped was AMBIGUOUS; and a live successor whose manager label had drifted from
 * the manager's registered name was TREE_RECIPIENT_NOT_RUNNING while it worked. The
 * plain stopped circle with no successor, meanwhile, was held for a wake (T255).
 *
 * WHY. resolveDelivery judged whichever ROW the name happened to match, and a
 * superseded row is a tombstone that cannot wake -- while the roster (reachabilityFrom)
 * already judged the circle's CURRENT row. Two answers to one question, which is the
 * drift canWake() was extracted to prevent, reintroduced one level up.
 *
 * THE SHARED ANSWER: the row that continues the circle today is the newest
 * registration of its saved circle (nodeKey), whether or not the supersededBy trail
 * between the rows is still intact -- a trail hop can age out of retention before
 * the row it led to does, and two expired rows of one circle are one circle, not two
 * candidates. A row that names no saved circle stands for itself. */
function currentRowOf(nodes, row) {
  if (!row.nodeKey) return row;
  let current = row;
  for (const node of nodes) {
    if (node.nodeKey !== row.nodeKey || !sameTree(node, row)) continue;
    // The newest registration of a saved circle is the one that continues it; between two of the
    // same instant the one that is not itself superseded is.
    if (node.registeredAt > current.registeredAt
      || (node.registeredAt === current.registeredAt && !node.supersededBy && current.supersededBy)) current = node;
  }
  return current;
}

/* THE CANVAS SPELLS ONE CIRCLE TWO WAYS. It draws "Builder 2 (964cd27e)" while another circle
 * shares the role name and "Builder 2" while none does, and the app re-sends whichever it shows
 * now (updateTreeAddress) -- the same session was told "Worker 3 (277f776d)" and then "Worker 3"
 * within one conversation. spellingBase answers the plain form of a suffixed name: the same
 * text without the hex disambiguator the canvas appends, or null when the name carries none.
 * Nothing else is folded: "Builder 2" never matches "Builder 20". */
function spellingBase(key) {
  const match = /^(.+) \([0-9a-f]{6,16}\)$/.exec(key);
  return match ? match[1] : null;
}

function createTreeNodeDirectory({
  file = null,
  fsImpl = fs,
  now = Date.now,
  liveWindowMs = DEFAULT_LIVE_WINDOW_MS,
  env = process.env,
  pid = process.pid,
  lockIsAlive = lockPidAlive,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockSleep = sleepSync,
  /* Whether the process a row names still exists. Injected so a test can
     declare a pid dead without killing anything; the default is the same
     probe the mutation lock trusts. See processGone(). */
  pidIsAlive = lockPidAlive
} = {}) {
  const target = file === null ? directoryFile({ env }) : path.resolve(file);
  const isLive = (entry, atMs) => liveAt(entry, atMs, liveWindowMs, pidIsAlive);

  function currentTime() {
    const value = now();
    if (!validTimestamp(value)) {
      fail('TREE_CLOCK_INVALID', 'The tree directory clock did not return a non-negative safe integer timestamp.');
    }
    return value;
  }

  function read({ allowMissing = false } = {}) {
    const record = readRecord(target, { fsImpl, allowMissing });
    return { ...record, nodes: resolveManagerRows(record.nodes, currentTime()) };
  }

  /* Bind a unique known manager once, then follow the saved circle through
   * its retained successor trail. Display labels are only the initial lookup:
   * a continuation may lose its suffix while reports retain the old label.
   * Read repair also covers directories written before this binding existed;
   * the next ordinary mutation persists it. No address or schema is migrated. */
  function resolveManagerRows(nodes, at) {
    const byId = new Map(nodes.map(node => [node.agentId, node]));
    const byName = new Map();
    for (const node of nodes) {
      const key = nameKey(node.nodeName);
      const matches = byName.get(key) || [];
      matches.push(node);
      byName.set(key, matches);
    }
    /* T839: rows indexed by the plain spelling of their name, so a label that drifted between the
       canvas's two spellings of one circle can still find it. See spellingBase. */
    const bySpelling = new Map();
    for (const node of nodes) {
      const base = spellingBase(nameKey(node.nodeName));
      if (base === null) continue;
      const matches = bySpelling.get(base) || [];
      matches.push(node);
      bySpelling.set(base, matches);
    }
    const successors = new Map();
    const currentManager = (manager, child) => {
      if (!manager || manager.agentId === child.agentId || !sameTree(manager, child)) return null;
      if (!manager.supersededBy) return manager;
      if (!successors.has(manager.agentId)) successors.set(manager.agentId, successorRow(nodes, manager.agentId, at));
      const current = successors.get(manager.agentId);
      // Moving an established parent edge needs a known, matching tree on
      // both identities. The legacy unknown-tree name fallback is not proof
      // that a replacement is still on the child's saved tree.
      return current && manager.treeKey && current.treeKey === manager.treeKey
        && sameTree(current, child) ? current : null;
    };
    const bound = nodes.map(node => {
      let manager = null;
      if (node.managerAgentId) {
        manager = currentManager(byId.get(node.managerAgentId), node);
      } else if (node.managerName) {
        const candidates = new Map();
        for (const named of byName.get(nameKey(node.managerName)) || []) {
          // Keyless legacy rows keep their existing name-based behavior. An
          // expired alias cannot establish a new manager relationship.
          if (!named.nodeKey || expired(named, at)) continue;
          const current = currentManager(named, node);
          if (current) candidates.set(current.agentId, current);
        }
        if (candidates.size === 0) {
          /* T839: NO EXACT NAME, SO TRY THE OTHER SPELLING -- with the same rules and the same demand
             for exactly one circle. Measured: a circle's successor re-sent its manager as "Builder 2"
             while the manager was registered as "Builder 2 (964cd27e)"; nothing matched, the successor
             had no line to its manager, and the manager could not reach a circle that was working.
             A label that could name two circles on this tree binds to neither (candidates.size), a label
             that names another circle exactly binds there (the loop above), and a circle the person
             moved keeps no line to its old manager. Read repair, like the binding above: it heals rows
             already saved unbound, and the next ordinary mutation persists it. */
          const key = nameKey(node.managerName);
          const base = spellingBase(key);
          for (const named of [...(bySpelling.get(key) || []), ...(base === null ? [] : byName.get(base) || [])]) {
            if (!named.nodeKey || expired(named, at)) continue;
            const current = currentManager(named, node);
            if (current) candidates.set(current.agentId, current);
          }
        }
        if (candidates.size === 1) manager = candidates.values().next().value;
      }
      // Keep the supplied label so a later registration of the same cached
      // brief can retain the binding, even after the old tombstone expires.
      return manager && manager.agentId !== node.managerAgentId
        ? { ...node, managerAgentId: manager.agentId } : node;
    });
    const index = managerIndex(bound);
    return bound.map(node => {
      const diagnosed = unresolvedManager(node, bound, index);
      return node.managerUnresolved === diagnosed ? node : { ...node, managerUnresolved: diagnosed };
    });
  }

  function mutate(change, { allowMissing = false } = {}) {
    const lockFile = `${target}.lock`;
    let lock;
    try {
      lock = acquireMutationLock(lockFile, {
        pid, isAlive: lockIsAlive, timeoutMs: lockTimeoutMs, sleep: lockSleep
      });
    } catch (error) {
      fail(
        error && error.code === 'AGENT_DIGEST_ALREADY_RUNNING' ? 'TREE_DIRECTORY_BUSY' : 'TREE_DIRECTORY_UNAVAILABLE',
        error && error.code === 'AGENT_DIGEST_ALREADY_RUNNING'
          ? 'Another ToolsEnabled process is updating the tree directory; this update was not applied.'
          : 'The tree directory mutation lock could not be acquired.',
        { causeCode: error && typeof error.code === 'string' ? error.code : null }
      );
    }
    try {
      // Read only after the cross-process lock is held. Atomic rename protects
      // readers from torn JSON; this serialization protects writers from both
      // reading the same predecessor and silently dropping one update.
      const record = read({ allowMissing });
      const next = change(record);
      if (record.links && !Object.hasOwn(next, 'links')) next.links = record.links;
      writeRecord(target, next, { fsImpl });
      return next;
    } finally {
      lock.release();
    }
  }

  /** Announce a session that has just started under a node of the tree.
   *
   *  `managerSessionId` is how the manager is addressed rather than its name,
   *  because a name can be edited on the canvas while a session runs and the
   *  edge must not move when it is. The name is carried too, for the refusal
   *  text a person reads. */
  function listLinks() {
    return Object.freeze((read({ allowMissing: true }).links || []).map(link => Object.freeze({ ...link })));
  }

  function setLink({ from, to, connected = true } = {}) {
    if (!from || !to || normalizeTreeKey(from) !== from || normalizeTreeKey(to) !== to || from === to
      || typeof connected !== 'boolean') fail('TREE_LINK_INVALID', 'Choose two different saved agents to link.');
    const [first, second] = [from, to].sort();
    const next = mutate(record => {
      const links = (record.links || []).filter(link => link.from !== first || link.to !== second);
      if (connected) links.push({ from: first, to: second });
      if (links.length > 8192) fail('TREE_LINK_LIMIT', 'This computer has reached its direct-link limit.');
      return { ...record, links };
    }, { allowMissing: true });
    return Object.freeze({ ok: true, links: Object.freeze(next.links.map(link => Object.freeze({ ...link }))) });
  }

  function registerNode({
    sessionId,
    nodeName,
    managerSessionId = null,
    managerName = null,
    pid = null,
    threadId = null,
    treeKey = null,
    nodeKey = null,
    replacesSessionId = null
  } = {}) {
    const agentId = agentIdForSession(sessionId);
    const name = normalizeName(nodeName, 'nodeName');
    const managerAgentId = managerSessionId === null || managerSessionId === undefined
      ? null
      : agentIdForSession(managerSessionId);
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedNodeKey = normalizeTreeKey(nodeKey);
    if (nodeKey !== null && nodeKey !== undefined && normalizedNodeKey === null) {
      fail('TREE_NODE_KEY_INVALID', 'The saved circle identity must be non-empty text of at most 128 characters.');
    }
    const replacedSession = replacesSessionId === null || replacesSessionId === undefined
      ? null : normalizeSessionId(replacesSessionId);
    const at = currentTime();
    let registeredEntry;
    const entry = {
      agentId,
      nodeName: name,
      sessionId: normalizedSessionId,
      managerAgentId,
      managerName: managerName === null || managerName === undefined ? null : normalizeName(managerName, 'managerName'),
      registeredAt: at,
      heartbeatAt: at,
      stoppedAt: null,
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      threadId: normalizeThreadId(threadId),
      treeKey: normalizeTreeKey(treeKey),
      nodeKey: normalizedNodeKey
    };
    mutate(record => {
      const previous = record.nodes.find(node => node.agentId === agentId);
      if (previous?.nodeKey && entry.nodeKey && previous.nodeKey !== entry.nodeKey) {
        fail('TREE_NODE_IDENTITY_MISMATCH', 'This session already belongs to a different saved circle.');
      }
      if (!entry.nodeKey && previous?.nodeKey) entry.nodeKey = previous.nodeKey;
      const predecessor = replacedSession && record.nodes.find(node => node.sessionId === replacedSession);
      if (predecessor?.nodeKey && entry.nodeKey && predecessor.nodeKey !== entry.nodeKey) {
        fail('TREE_REPLACEMENT_IDENTITY_MISMATCH', 'The session being replaced belongs to a different saved circle.');
      }
      if (!entry.nodeKey && predecessor?.nodeKey) entry.nodeKey = predecessor.nodeKey;
      if (!entry.managerAgentId && entry.managerName) {
        const priorBindings = record.nodes.filter(node => node.managerAgentId
          && (node.agentId === agentId || (entry.nodeKey && node.nodeKey === entry.nodeKey))
          && sameTree(node, entry) && !expired(node, at)
          && nameKey(node.managerName) === nameKey(entry.managerName));
        const managers = new Set(priorBindings.map(node => node.managerAgentId));
        if (managers.size === 1) entry.managerAgentId = managers.values().next().value;
      }
      /* A REPLACED ROW IS NOT DELETED, IT IS MARKED.
         agentId is sha256(sessionId), so a circle that moves accounts or is
         restarted gets a NEW address and its old one resolved to nothing --
         measured on this computer 2026-09-15, the Controller's node was
         tree-e60571a0… until 07:12Z and tree-4b31cd18… from 07:13Z. Anything
         already addressed to the old id was undeliverable from that instant,
         with the sender holding a receipt that said delivered.
         Keeping the retired row, marked with the address that continues it,
         is what makes that message arrive. It is NOT a re-keying: every
         existing agentId is unchanged, so nothing in flight breaks and no
         stored id is migrated. The tombstone carries stoppedAt, so it is not
         live, is never a delivery target in its own right, and is swept by the
         same STOPPED_RETENTION_MS a cleanly stopped row already gets.
         Only a REPLACEMENT leaves one. A circle that simply stopped has no
         successor and must not appear to have one. */
      const continuedByThis = node => node.agentId !== agentId
        && !expired(node, at)
        && (node.sessionId === replacedSession
          || supersededByThread(node, entry)
          || supersededByCircle(node, entry, candidate => isLive(candidate, at)));
      const tombstones = record.nodes.filter(continuedByThis).map(node => ({
        ...node,
        stoppedAt: Number.isFinite(node.stoppedAt) ? node.stoppedAt : at,
        supersededBy: agentId
      }));
      const kept = record.nodes.filter(node => node.agentId !== agentId
        && node.sessionId !== replacedSession
        && !expired(node, at)
        && !supersededByThread(node, entry)
        && !supersededByCircle(node, entry, candidate => isLive(candidate, at)));
      if (kept.length + tombstones.length >= MAX_NODES) {
        fail('TREE_DIRECTORY_FULL', `This computer already has ${MAX_NODES} registered tree agents.`, { limit: MAX_NODES });
      }
      const nodes = resolveManagerRows([...kept, ...tombstones, entry], at);
      registeredEntry = nodes.find(node => node.agentId === agentId);
      return { version: SCHEMA_VERSION, nodes };
    }, { allowMissing: true });
    return Object.freeze({ ...registeredEntry });
  }

  /** Still running. The app calls this on a cadence shorter than the live
   *  window; a session that stops calling it stops being a recipient. */
  function heartbeatNode({ sessionId } = {}) {
    return heartbeatNodes([{ sessionId }])[0];
  }

  /** One host round takes one lock and makes one durable write. A retained
   * stopped row is still found, but cannot receive messages; report both facts
   * so the host can re-register a session it still owns. */
  function heartbeatNodes(requests = []) {
    if (!Array.isArray(requests)) {
      throw new TypeError('Heartbeat requests must be an array of sessions.');
    }
    const results = requests.map(request => ({
      agentId: agentIdForSession(request && request.sessionId), found: false, live: false
    }));
    if (results.length === 0) return Object.freeze([]);
    const wanted = new Set(results.map(result => result.agentId));
    const updated = new Map();
    const at = currentTime();
    mutate(record => ({
      version: SCHEMA_VERSION,
      nodes: record.nodes.map(node => {
        if (!wanted.has(node.agentId)) return node;
        const next = { ...node, heartbeatAt: at };
        updated.set(node.agentId, next);
        return next;
      })
    }), { allowMissing: true });
    return Object.freeze(results.map(result => {
      const node = updated.get(result.agentId);
      return Object.freeze({ ...result, found: Boolean(node), live: Boolean(node && isLive(node, at)) });
    }));
  }

  /** Gone on purpose. Distinct from a lapsed heartbeat only in speed: both end
   *  with the same refusal for anyone still addressing it. */
  /** Name the engine thread a registered session runs, once it is known. */
  function bindThread({ sessionId, threadId } = {}) {
    const agentId = agentIdForSession(sessionId);
    const thread = normalizeThreadId(threadId);
    if (!thread) fail('TREE_THREAD_INVALID', 'A thread id must be a non-empty string of at most 512 characters.');
    let found = false;
    mutate(record => ({
      version: SCHEMA_VERSION,
      nodes: record.nodes.map(node => {
        if (node.agentId !== agentId) return node;
        found = true;
        return { ...node, threadId: thread };
      })
    }));
    return Object.freeze({ agentId, found });
  }

  /** The newest registration that ran this engine thread, live or stopped, or
   *  null. A resumed session asks this to inherit its circle's name and
   *  manager; it does not care whether the old session is still running. */
  function findByThreadId(threadId) {
    const thread = normalizeThreadId(threadId);
    if (!thread) return null;
    const matches = read({ allowMissing: true }).nodes.filter(node => node.threadId === thread);
    if (matches.length === 0) return null;
    matches.sort((left, right) => right.registeredAt - left.registeredAt);
    return Object.freeze({ ...matches[0] });
  }

  function unregisterNode({ sessionId } = {}) {
    const agentId = agentIdForSession(sessionId);
    const at = currentTime();
    let removed = false;
    mutate(record => ({
      version: SCHEMA_VERSION,
      nodes: record.nodes
        .filter(node => !expired(node, at))
        .map(node => {
          if (node.agentId !== agentId) return node;
          removed = true;
          return { ...node, stoppedAt: at };
        })
    }));
    return Object.freeze({ agentId, removed });
  }

  /** Everything the directory holds, each entry told apart by whether it is
   *  still speaking. Callers that want only recipients filter on `live`.
   *
   *  A DIRECTORY NOBODY HAS WRITTEN YET HOLDS NOTHING, AND THAT IS AN ANSWER.
   *  The file is created by the first registration, so on every installation
   *  where no tree session has ever started it is absent -- which is not a
   *  failure to look, it is the complete truth about how many nodes exist.
   *  Refusing here made a pure reader depend on a write having happened first,
   *  and the owner journal (the only production caller) crashed on a fresh
   *  machine rather than listing a conversation with undecorated ids.
   *
   *  ONLY absence is forgiven, and only as the platform reports it.
   *  `allowMissing` tolerates ENOENT and nothing else -- deliberately NOT the
   *  ENOTDIR this file also tolerated before 5fa759e. A malformed file, a wrong
   *  schema version, an invalid node list, EISDIR, EACCES and every other errno
   *  still refuse, because those are failures to READ and answering "no nodes"
   *  to them would be a confident lie about who is running.
   *
   *  ENOTDIR IS NOT A DISTINCTION EVERY PLATFORM MAKES, and that is measured,
   *  not assumed: on win32 (node v22) a regular file standing in the path
   *  raises ENOENT, so an obstructed directory is indistinguishable from an
   *  unwritten one at this layer and is forgiven here on Windows whatever this
   *  code says. It is left to surface where it can be told apart -- the first
   *  registerNode mkdirSync on that path fails loudly rather than silently
   *  reporting an empty tree. On POSIX ENOTDIR arrives as itself and refuses. */
  function listNodes({ at = null, includeSuperseded = false } = {}) {
    const atMs = at === null ? now() : at;
    return Object.freeze(read({ allowMissing: true }).nodes
      .filter(node => includeSuperseded || !node.supersededBy)
      .map(node => Object.freeze({
      ...node,
      live: isLive(node, atMs)
    })));
  }

  function refusal(code, message, details = {}) {
    return Object.freeze({ ok: false, code, message, ...details });
  }

  /* WHERE A RETIRED ADDRESS WENT.
   * A tombstone names the agentId that continued its circle; that successor may
   * itself have been replaced, so the trail is followed rather than read once.
   * Each hop must retain the saved circle and remain inside its retention
   * window. The visited set bounds the walk by the actual directory size. */
  function successorRow(nodes, agentId, atMs) {
    const byId = new Map(nodes.map(node => [node.agentId, node]));
    const original = byId.get(agentId);
    if (!original?.nodeKey || expired(original, atMs)) return null;
    let current = agentId;
    const seen = new Set();
    while (seen.size < nodes.length) {
      if (seen.has(current)) return null;
      seen.add(current);
      const row = byId.get(current);
      if (!row || row.nodeKey !== original.nodeKey || expired(row, atMs)) return null;
      if (isLive(row, atMs)) return current === agentId ? null : row;
      if (typeof row.supersededBy !== 'string') return null;
      current = row.supersededBy;
    }
    return null;
  }

  /** The live address that continues a retired one, or null. A caller holding
   *  only an old agentId -- a spool entry keyed by it, say -- can re-key
   *  instead of orphaning the message. */
  function successorAgentId(agentId) {
    if (typeof agentId !== 'string' || !agentId) return null;
    const atMs = currentTime();
    const { nodes } = read({ allowMissing: true });
    const row = successorRow(nodes, agentId, atMs);
    return row ? row.agentId : null;
  }

  function senderSessionMismatch(from, senderSessionId) {
    if (typeof senderSessionId !== 'string' || !senderSessionId.trim()) return null;
    return refusal('TREE_SENDER_IDENTITY_MISMATCH',
      `The session making this call is not the running circle called "${String(from).trim()}". Use the current name of your own circle after a move or restart.`);
  }

  function managerUnregisteredRefusal(managerName) {
    return refusal(
      'TREE_MANAGER_UNREGISTERED',
      `The manager "${managerName}" named for this agent is not registered on this tree, so a message to that manager cannot be routed. Start that manager node or re-point this agent.`,
      { managerName }
    );
  }

  function reachabilityRefusal(code, message, details = {}) {
    return Object.freeze({
      ...refusal(code, message, details),
      reachable: Object.freeze([]),
      unavailable: Object.freeze([])
    });
  }

  /* THE MAPPING. Two names a person can read off the canvas in, one pair of
   * durable fabric identities out, or a named refusal that says which of the
   * two names could not be honoured and why.
   *
   * The order of the checks is the order a person would ask the questions:
   * are you who you say you are, are you still running, is the name you are
   * addressing on this tree, is it connected to you, and is it still running. */
  function resolveDelivery({ from, to, at = null, senderSessionId = null } = {}) {
    const atMs = at === null ? now() : at;
    /* allowMissing: true, FOR THE SAME REASON listNodes() TAKES IT.
     *
     * A machine on which no tree agent has ever registered has no directory
     * file yet -- registerNode() is the one write that creates it. Without
     * this, a caller with nobody to reach at all (the ordinary "no such
     * agent" case TREE_SENDER_UNKNOWN below exists to answer) threw
     * TREE_DIRECTORY_UNREADABLE (ENOENT) instead, straight through
     * src/lib/providers/agent-comms-local.js's send(), which calls this with
     * no try/catch beneath its own header comment: "A REFUSAL IS AN ANSWER,
     * NOT AN EXCEPTION... only a genuinely malformed call throws." An
     * unwritten directory is not a malformed one. */
    const { nodes, links = [] } = read({ allowMissing: true });
    const byAgent = new Map(nodes.map(node => [node.agentId, node]));
    const fromKey = nameKey(from);
    const toKey = nameKey(to);
    if (!fromKey) return refusal('TREE_SENDER_REQUIRED', 'Say which circle on the tree you are, using the name you were given.');
    if (!toKey) return refusal('TREE_RECIPIENT_REQUIRED', 'Say which circle on the tree you are writing to, using the name you were given.');

    const callerSession = typeof senderSessionId === 'string' ? senderSessionId.trim() : '';
    // A retained alias of this caller is not a second stopped sender. Other
    // circles' names remain subject to the existing caller identity checks.
    const senderMatches = nodes.filter(node => nameKey(node.nodeName) === fromKey
      && !(node.supersededBy && successorRow(nodes, node.agentId, atMs)?.sessionId === callerSession));
    const liveSenders = senderMatches.filter(node => isLive(node, atMs));
    let sender;
    if (senderMatches.length === 0) {
      // The name is on no row at all, so it identifies nobody and nothing is
      // being overridden. The session is the one the owner host bound this
      // transport to; a caller it vouched for nobody keeps the refusal below.
      sender = historicalSenderRow(nodes, senderSessionId, node => isLive(node, atMs));
      if (!sender) {
        return refusal('TREE_SENDER_UNKNOWN',
          `No agent called "${String(from).trim()}" is registered on this computer's tree.`);
      }
    } else if (liveSenders.length === 0) {
      return refusal('TREE_SENDER_NOT_RUNNING',
        `"${String(from).trim()}" is on this computer's tree but its session is no longer running, so it cannot send.`);
    } else {
      // Refusing beats guessing: two running circles share a name, and a
      // delivery under the wrong one is indistinguishable from a correct one
      // afterwards. The caller's own vouched-for session is not a guess -- see
      // ownLiveRow. A refusal must not suggest a rename tool that does not exist.
      sender = ownLiveRow(liveSenders, senderSessionId);
      if (sender === null) {
        const mismatch = senderSessionMismatch(from, senderSessionId);
        if (mismatch) return mismatch;
        return refusal('TREE_SENDER_AMBIGUOUS',
          `More than one running agent on this tree is called "${String(from).trim()}", so this message has no unambiguous sender. No message was sent.`,
          { candidates: liveSenders.length });
      }
    }

    // THE EDGE IS THE AUTHORITY. A tree agent may write to the agent it reports
    // to and to the agents that report to it, and to nothing else -- that is
    // the relationship the person drew, and it is the only relationship this
    // file is willing to certify.
    const connected = nodes.filter(node => node.agentId !== sender.agentId && edge(sender, node, links, byAgent));
    const exactMatches = connected.filter(node => nameKey(node.nodeName) === toKey || node.agentId === toKey);
    /* A BARE NAME THE PERSON ACTUALLY TYPES.
       Circles are registered with a disambiguating suffix -- "Controller
       (da02fefa)" -- and nothing is named plainly "Controller", so an exact
       match on the shorthand finds nothing and the old answer was "No agent
       called "Controller" is registered on this computer's tree" while two
       were. Measured 2026-09-15: the math tree's manager, reading its roster,
       sent to the Controller in its own tree rather than the linked one.
       A shorthand that fits exactly ONE reachable live circle is not ambiguous
       and resolves. Two and it is refused BY NAME, as it always was -- this
       widens what can be addressed, never what can be guessed at. */
    const prefixMatches = exactMatches.length > 0 ? [] : connected.filter(node =>
      isLive(node, atMs) && toKey.length > 0 && nameKey(node.nodeName).startsWith(toKey));
    const connectedMatches = exactMatches.length > 0 ? exactMatches : prefixMatches;
    if (connectedMatches.length === 0) {
      const missingManager = unresolvedManager(sender, nodes);
      // A missing manager invalidates only the edge addressed to that manager.
      // It must not revoke valid outgoing edges to this sender's own children.
      if (missingManager && nameKey(missingManager) === toKey) {
        return managerUnregisteredRefusal(missingManager);
      }
      const elsewhere = nodes.some(node => nameKey(node.nodeName) === toKey);
      if (elsewhere) {
        return refusal('TREE_RECIPIENT_NOT_CONNECTED',
          `"${String(to).trim()}" is on this computer's tree, but it is not your manager and it does not report to you, so there is no line between you.`);
      }
      /* SAY WHAT IS REACHABLE INSTEAD OF DENYING IT EXISTS. A flat "no agent
         called X" sends the person hunting for a typo when the name was right
         and only the suffix was missing. Naming the live circles the sender can
         actually write to turns the refusal into the answer. */
      const reachableLive = connected.filter(node => isLive(node, atMs));
      const reachableNames = reachableLive.map(node => node.nodeName);
      /* AND SAY IT IN A FORM THE NEXT ATTEMPT CAN USE. A list of bare names is
         no answer at all when the names repeat, which is the state T138 was
         filed for: a caller refused for addressing a saved-circle id was told
         "You can write to: Worker, Worker, Worker", and every one of those is
         TREE_RECIPIENT_AMBIGUOUS. The address goes beside the name so the
         refusal carries its own remedy; `reachable` keeps its array-of-names
         shape for the callers already reading it. */
      const reachableAddresses = reachableLive.map(node => `${node.nodeName} (${node.agentId})`);
      return refusal('TREE_RECIPIENT_UNKNOWN',
        reachableLive.length === 0
          ? `No agent called "${String(to).trim()}" is registered on this computer's tree, and you have no one to write to.`
          : `No agent called "${String(to).trim()}" is connected to you. You can write to: ${reachableAddresses.join(', ')}.`,
        { reachable: reachableNames, reachableAgents: reachableLive.map(node => Object.freeze({ nodeName: node.nodeName, agentId: node.agentId })) });
    }
    const liveRecipients = connectedMatches.filter(node => isLive(node, atMs));
    if (liveRecipients.length === 0) {
      /* THE CIRCLE MAY HAVE CONTINUED SOMEWHERE ELSE. A row addressed by its
         retired agentId is a tombstone, and its successor is the same circle on
         a new session -- an account move or a restart. Delivering there is the
         whole point of keeping the tombstone. A circle that merely stopped has
         no successor and still refuses below. */
      /* T255: A CIRCLE THAT MERELY STOPPED IS WOKEN, NOT REFUSED.
       *
       * This used to refuse outright, and the refusal's own words -- "its
       * session has stopped, so nothing would read this message" -- were an
       * accurate description of the product at the time and the reason the
       * owner could not reach their own agent. Nothing downstream was broken:
       * the message never existed, because it was rejected here before any
       * write. So this is the only place a wake can begin.
       *
       * AUTHORITY IS ALREADY SETTLED ABOVE AND NOTHING IS WIDENED HERE.
       * `connectedMatches` has already passed edge(sender, node, links,
       * byAgent) -- the manager/report relationship the person drew, which this
       * file calls THE EDGE IS THE AUTHORITY. A stopped circle reachable on that
       * edge was always addressable; the only thing that changes is that its
       * message is now kept instead of thrown away. No new permission concept
       * exists, and none is consulted: a sender that could not write to this
       * circle while it ran still cannot write to it now, refused by the
       * branches above this one.
       *
       * AMBIGUITY IS STILL REFUSED, for the same reason it is for live
       * recipients: two stopped circles sharing a name means the message has no
       * unambiguous destination, and guessing one would deliver a person's words
       * to the wrong agent on a wake they cannot see.
       *
       * AND A ROW THAT CANNOT WAKE STILL REFUSES. A superseded row is a
       * tombstone whose circle continued elsewhere -- handled just above -- or
       * ended; an expired row is past STOPPED_RETENTION_MS and no longer
       * describes anything startable. Neither is a stopped circle, so neither
       * gets a wake, and the original refusal stands for them with its original
       * wording. */
      /* T839: ONE CIRCLE, ONE RECIPIENT. See currentRowOf. Every row this name matched is
       * reduced to the row that continues its saved circle today: rows of ONE circle are one
       * recipient, two circles sharing a name are still two (AMBIGUOUS). This used to chase the
       * first matched row to a LIVE successor only, count a circle's own predecessor and successor
       * as two candidates, and judge wakeability on a tombstone -- so a circle a recovery replaced
       * was refused (AMBIGUOUS / NOT_RUNNING) exactly while its successor started, while an
       * identical circle with no predecessor was held.
       *
       * NOTHING HERE ADDS AN EDGE. Every candidate came from connectedMatches (already through
       * edge()), and the row a message would reach is held to the same edge() test the running
       * path uses. When the circle continues on a session this directory holds no line to, the
       * answer says that, not that the circle stopped. And nothing here starts anything: a held
       * message is only recorded (see the caller's recipientStopped), so a person's Stop is not
       * undone by writing to the circle. */
      const heads = new Map();
      for (const match of connectedMatches) {
        const current = currentRowOf(nodes, match);
        heads.set(current.agentId, current);
      }
      if (heads.size > 1) {
        const candidates = [...heads.values()];
        return refusal('TREE_RECIPIENT_AMBIGUOUS',
          `More than one circle connected to you is called "${String(to).trim()}" and none is running: ${candidates.map(node => `${node.nodeName} (${node.agentId})`).join(', ')}. No message was sent because the recipient is ambiguous; send again to one of those agentIds.`,
          {
            candidates: candidates.length,
            candidateAgents: candidates.map(node => Object.freeze({ nodeName: node.nodeName, agentId: node.agentId })),
          });
      }
      const current = [...heads.values()][0];
      if (!edge(sender, current, links, byAgent)) {
        return refusal('TREE_RECIPIENT_NOT_CONNECTED',
          `"${String(to).trim()}" is on this computer's tree and continues on a newer session, but this directory holds no line between you and that session, so nothing was sent. The circle may have been moved under another manager, or the manager label it registered with no longer matches the name you are registered under.`);
      }
      if (isLive(current, atMs)) {
        return Object.freeze({
          ok: true,
          sender: Object.freeze({ agentId: sender.agentId, nodeName: sender.nodeName, sessionId: sender.sessionId }),
          recipient: Object.freeze({ agentId: current.agentId, nodeName: current.nodeName, sessionId: current.sessionId }),
          relation: relationOf(sender, current, links, byAgent),
          succeeded: Object.freeze({ from: connectedMatches[0].agentId })
        });
      }
      if (!canWake(current, atMs)) {
        return refusal('TREE_RECIPIENT_NOT_RUNNING',
          `"${String(to).trim()}" is on this computer's tree but its session has stopped, so nothing would read this message.`);
      }
      return Object.freeze({
        ok: true,
        sender: Object.freeze({ agentId: sender.agentId, nodeName: sender.nodeName, sessionId: sender.sessionId }),
        recipient: Object.freeze({ agentId: current.agentId, nodeName: current.nodeName, sessionId: current.sessionId }),
        relation: relationOf(sender, current, links, byAgent),
        /* The caller MUST NOT report this as delivered. It says: this circle is
         * addressable and its message may be recorded, but no session is reading
         * yet, so something has to start it and say whether that worked. */
        recipientStopped: true
      });
    }
    if (liveRecipients.length > 1) {
      /* THE ADVICE HAS TO BE FOLLOWABLE. "Use the full name" was the whole
         answer here, and it is not one when the full names are the thing that
         collided: T138 measured four circles whose full name was "Manager", so
         every re-attempt this sentence invited was refused again the same way.
         Each candidate is named with the address that separates it, and the
         addresses ride in the details so a caller can pick one without parsing
         a sentence. `candidates` keeps its count for the readers already on it. */
      return refusal('TREE_RECIPIENT_AMBIGUOUS',
        `More than one running agent connected to you is called "${String(to).trim()}": ${liveRecipients.map(node => `${node.nodeName} (${node.agentId})`).join(', ')}. No message was sent because the recipient is ambiguous; send again to one of those agentIds.`,
        {
          candidates: liveRecipients.length,
          candidateAgents: liveRecipients.map(node => Object.freeze({ nodeName: node.nodeName, agentId: node.agentId })),
        });
    }
    const recipient = liveRecipients[0];
    return Object.freeze({
      ok: true,
      sender: Object.freeze({ agentId: sender.agentId, nodeName: sender.nodeName, sessionId: sender.sessionId }),
      recipient: Object.freeze({ agentId: recipient.agentId, nodeName: recipient.nodeName, sessionId: recipient.sessionId }),
      relation: relationOf(sender, recipient, links, byAgent)
    });
  }

  /** What a running node may address, by name, so a surface can show it and a
   *  tool description can be honest about it. */
  function reachableFrom({ from, at = null, senderSessionId = null } = {}) {
    return reachabilityFrom({ from, at, senderSessionId }).reachable;
  }

  /** A roster needs both live endpoints and named reasons for relationships
   *  which cannot currently carry a message. `reachableFrom` remains the
   *  backwards-compatible array projection used by older callers. */
  function reachabilityFrom({ from, at = null, senderSessionId = null } = {}) {
    const atMs = at === null ? now() : at;
    /* allowMissing: true -- see the identical note on resolveDelivery() above.
     * reachableFrom() (the backwards-compatible array projection) calls this,
     * so fixing it here closes both doors. */
    const { nodes, links = [] } = read({ allowMissing: true });
    const byAgent = new Map(nodes.map(node => [node.agentId, node]));
    const fromKey = nameKey(from);
    if (!fromKey) {
      return reachabilityRefusal(
        'TREE_SENDER_REQUIRED',
        'Say which circle on the tree you are, using the name you were given.'
      );
    }
    const callerSession = typeof senderSessionId === 'string' ? senderSessionId.trim() : '';
    const senderMatches = nodes.filter(node => nameKey(node.nodeName) === fromKey
      && !(node.supersededBy && successorRow(nodes, node.agentId, atMs)?.sessionId === callerSession));
    const liveSenders = senderMatches.filter(node => isLive(node, atMs));
    let sender;
    if (senderMatches.length === 0) {
      /* The same fallback the delivery path takes, under the same conditions.
         The two must agree, or the roster offers a name the send refuses. */
      sender = historicalSenderRow(nodes, senderSessionId, node => isLive(node, atMs));
      if (!sender) {
        return reachabilityRefusal(
          'TREE_SENDER_UNKNOWN',
          `No agent called "${String(from).trim()}" is registered on this computer's tree.`
        );
      }
    } else if (liveSenders.length === 0) {
      return reachabilityRefusal(
        'TREE_SENDER_NOT_RUNNING',
        `"${String(from).trim()}" is on this computer's tree but its session is no longer running, so it cannot send.`
      );
    } else {
      /* TWO CIRCLES WITH ONE NAME answer like every other refusal on this path
       * instead of throwing.
       * It throwing made both the roster and `send`'s "what it could have said
       * instead" list -- which calls `reachableFrom` while composing a refusal
       * -- reach the model as a tool failure and the person as nothing at all.
       * A caller the surface vouched for is told apart first (ownLiveRow). */
      sender = ownLiveRow(liveSenders, senderSessionId);
      if (sender === null) {
        const mismatch = senderSessionMismatch(from, senderSessionId);
        if (mismatch) return reachabilityRefusal(mismatch.code, mismatch.message);
        return reachabilityRefusal('TREE_SENDER_AMBIGUOUS',
          `More than one running agent on this tree is called "${String(from).trim()}", so its reachable agents cannot be established.`,
          { candidates: liveSenders.length });
      }
    }
    const reachable = nodes
      .filter(node => node.agentId !== sender.agentId
        && isLive(node, atMs)
        && edge(sender, node, links, byAgent))
      .map(node => Object.freeze({
        nodeName: node.nodeName,
        /* EVERY REACHABLE ROW CARRIES ITS ADDRESS, not only a user-linked one.
           The agentId arrived with direct links (f582c5a5) and was scoped to
           them because that was the case being built; a manager and a report
           were simply never extended. Measured 2026-09-16 (T138): a manager
           whose four workers all registered as "Worker" read this roster, got
           four identical rows with nothing on them to tell apart, and every
           send_local it could compose answered TREE_RECIPIENT_AMBIGUOUS -- while
           resolveDelivery() below has accepted an agentId as `to` the whole
           time. The roster was withholding the one value that already worked.
           It is an address, not a credential: agentIdForSession() derives it
           from the session id, a caller cannot choose it, and handing it out
           widens nothing -- the edge is still what authorises the delivery. */
        agentId: node.agentId,
        relation: relationOf(sender, node, links, byAgent),
        /* WHICH TREE, BESIDE WHO. Two trees using the same role names put two
           "Controller" rows in one roster, and relation alone does not separate
           them -- one is this sender's own report, the other a linked peer in
           somebody else's tree. Measured 2026-09-15: a manager reading exactly
           this roster picked the Controller in its own tree when it meant the
           linked one. The tree is what makes that choice visible. */
        treeKey: typeof node.treeKey === 'string' ? node.treeKey : null,
        lastSeenAt: node.heartbeatAt,
        transient: false
      }));
    const unavailable = nodes
      .filter(node => node.agentId !== sender.agentId
        && !node.supersededBy
        && !isLive(node, atMs)
        && edge(sender, node, links, byAgent))
      .map(node => {
        const transient = !Number.isFinite(node.stoppedAt) && !processGone(node, pidIsAlive);
        return Object.freeze({
          nodeName: node.nodeName,
          /* The same address on the unavailable rows, for the same reason: a
             circle whose heartbeat is overdue is the one a caller most needs to
             name exactly when it comes back, and a row that loses its id on the
             way through this branch reads as a different circle. */
          agentId: node.agentId,
          relation: relationOf(sender, node, links, byAgent),
          treeKey: node.treeKey || null,
          lastSeenAt: node.heartbeatAt,
          transient,
          status: transient ? 'heartbeat-overdue' : 'registered-but-session-stopped',
          code: 'TREE_RECIPIENT_NOT_RUNNING',
          /* T255: WHAT THIS BRANCH WAS PROTECTING IS NOW PARTLY EXPOSED, so it
           * has to say so. These rows are "unavailable" and carry
           * TREE_RECIPIENT_NOT_RUNNING, and both remain true: no session is
           * reading. But since a stopped circle's message is now accepted and
           * the circle woken, "unavailable" no longer means "do not bother
           * writing" -- and a roster that still implied that would send a person
           * away from the one action that now works. That is the same shape of
           * wrong as the refusal this change removed, moved one surface along.
           *
           * So the row states, mechanically, whether writing to it would be
           * held for a wake. It is the SAME condition resolveDelivery uses -- not
           * a second opinion that could drift from it -- so the roster cannot
           * offer a wake the delivery path would refuse, or hide one it allows.
           * A superseded row is a tombstone and an expired row is past
           * STOPPED_RETENTION_MS; neither can wake, and both still read false. */
          wakeable: canWake(node, atMs)
        });
      });
    const missingManager = unresolvedManager(sender, nodes);
    if (missingManager) {
      unavailable.push(Object.freeze({
        nodeName: missingManager,
        relation: 'manager',
        treeKey: sender.treeKey || null,
        lastSeenAt: null,
        transient: false,
        status: 'never-registered',
        code: 'TREE_MANAGER_UNREGISTERED'
      }));
      return Object.freeze({
        ...managerUnregisteredRefusal(missingManager),
        reachable: Object.freeze(reachable),
        unavailable: Object.freeze(unavailable)
      });
    }
    return Object.freeze({
      ok: true,
      reachable: Object.freeze(reachable),
      unavailable: Object.freeze(unavailable)
    });
  }

  return Object.freeze({
    file: target,
    supportsExactReplacement: true,
    agentIdForSession,
    bindThread,
    findByThreadId,
    heartbeatNode,
    heartbeatNodes,
    listNodes,
    listLinks,
    setLink,
    reachabilityFrom,
    reachableFrom,
    registerNode,
    resolveDelivery,
    successorOf: successorAgentId,
    unregisterNode
  });
}

module.exports = Object.freeze({
  AGENT_ID_PREFIX,
  DEFAULT_LIVE_WINDOW_MS,
  STOPPED_RETENTION_MS,
  MAX_NAME_LENGTH,
  MAX_SESSION_ID_LENGTH,
  MAX_NODES,
  MAX_DOCUMENT_BYTES,
  MAX_TREE_KEY_LENGTH,
  SCHEMA_VERSION,
  TreeDirectoryError,
  agentIdForSession,
  createTreeNodeDirectory,
  directoryFile,
  nameKey,
  sleepSync
});
