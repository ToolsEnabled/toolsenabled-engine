'use strict';

// Durable owner-directive inbox — Phase 1 of docs/DASHBOARD-BRIDGE-PLAN.md.
//
// A small, durable queue for the owner's own words, written from anywhere
// (the future dashboard textbox, a system.ask-style flow, a CLI helper) and
// drained by the controller on every wake. It is deliberately NOT the
// owner-prompt-queue.js pattern: that module exists specifically to keep
// sensitive VALUES out of durable state (it stores a kind/vaultKey/label
// pointer, never the value). This module's entire purpose is the opposite --
// carrying the owner's actual text, verbatim, the same way
// reports/OWNER-REQUEST-LEDGER.json's `verbatim` field does (see
// STANDING-ORDERS.md RECORD rule 1a). Content here is NOT redacted. The
// caller-facing contract is: never put credentials or personal data in a
// directive (CLAUDE.md's shared-run protocol says the same about
// mission payloads) -- SENSITIVE below is a best-effort heuristic backstop
// against the most obviously credential-shaped text, not a guarantee.
//
// It is also deliberately NOT the task.* durable queue: a directive is a
// message multiple readers (the controller's next wake, a dashboard badge,
// a future system.ask writer) all need to see, not a unit of work one
// worker claims-with-a-lease and retries. Task semantics (single-claim,
// lease expiry) would be actively wrong here -- an unread directive must
// stay visible to every reader until someone explicitly acknowledges it,
// never "expire" or get invisibly claimed away.
//
// File-locking and atomic-write shape follows
// src/lib/providers/owner-prompt-queue.js exactly (fs.openSync(..., 'wx')
// advisory lock, temp-file-then-rename atomic writes, a bounded append-only
// events log) because that pattern is already reviewed and tested in this
// codebase -- there is no reason to invent a new one for a module with the
// same durability shape.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { statePath } = require('./runtime-state-root');

const VERSION = 1;
// This is the same state-root resolution runtime.rootPath('state', ...) uses,
// without importing runtime's credential/provider surface into a durable local
// inbox. The inbox must remain usable by the health observer when a watched
// subsystem is unavailable.
const INBOX_FILE = statePath('owner-directive-inbox.json');
const MAX_TEXT_LENGTH = 20000; // matches tools/owner-capture.js's MAX_TEXT_LENGTH convention
const MAX_ITEMS = 500;
const MAX_EVENTS = 500;
// Every withLock hold here is synchronous -- both call sites (append,
// acknowledge) do in-memory mutation only, and readInbox/writeInbox use
// readFileSync/writeFileSync/renameSync. Nothing awaits, spawns, or hits the
// network while the lock is held, so no legitimate hold approaches this bound.
// A lock older than this was abandoned by a holder that died before reaching
// its own finally block. Without this, ONE dead holder silently and
// permanently wedges the path that RECEIVES the owner's directives -- and
// unlike owner-chat.js's withLock, this one had no retry at all: a single
// failed open went straight to a permanent OWNER_DIRECTIVE_INBOX_BUSY.
const STALE_LOCK_MS = 10000;
const STATUS = Object.freeze(['unread', 'acknowledged']);
const ID_RE = /^owner-directive-[a-f0-9-]{36}$/;
// Lowercase lane identifier: 'dashboard', 'system_ask', 'system_ask_remote', 'cli', 'other', ...
// A bounded free-text pattern rather than a hard enum, so a new lane (e.g. the
// dashboard UI the controller builds next) doesn't require a code change here.
const SOURCE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const DEFAULT_SOURCE = 'other';
const DEFAULT_ACTOR = 'unknown';
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
// Best-effort heuristic backstop, not a content-safety guarantee -- same
// admitted limitation as src/lib/controller-launch-record.js's own SENSITIVE
// pattern, reused here for the same class of obviously credential-shaped text.
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+[A-Za-z0-9._-]{10,}|\b(?:password|passwd|api[-_]?key|secret[-_]?key|access[-_]?token|refresh[-_]?token)\s*[:=]\s*\S|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})/i;

class OwnerDirectiveInboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OwnerDirectiveInboxError';
    this.code = code;
  }
}

function fail(code, message) { throw new OwnerDirectiveInboxError(code, message); }
function now() { return Date.now(); }
function emptyInbox() { return { version: VERSION, nextSequence: 1, items: [], events: [] }; }

function validateInbox(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION ||
      !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1 ||
      !Array.isArray(value.items) || !Array.isArray(value.events) ||
      value.items.length > MAX_ITEMS || value.events.length > MAX_EVENTS) {
    fail('OWNER_DIRECTIVE_INBOX_INVALID', 'The durable owner directive inbox is invalid.');
  }
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !ID_RE.test(item.id) ||
        typeof item.text !== 'string' || item.text.length < 1 || item.text.length > MAX_TEXT_LENGTH ||
        !STATUS.includes(item.status) || !SOURCE_RE.test(String(item.source || '')) ||
        !ACTOR_RE.test(String(item.submittedBy || '')) ||
        !Number.isSafeInteger(item.createdAtMs) || !Number.isSafeInteger(item.updatedAtMs) ||
        (item.idempotencyKey !== null && !IDEMPOTENCY_KEY_RE.test(String(item.idempotencyKey || ''))) ||
        (item.acknowledgedAtMs !== null && !Number.isSafeInteger(item.acknowledgedAtMs)) ||
        (item.acknowledgedBy !== null && !ACTOR_RE.test(String(item.acknowledgedBy || '')))) {
      fail('OWNER_DIRECTIVE_INBOX_INVALID', 'The durable owner directive inbox is invalid.');
    }
  }
  for (const event of value.events) {
    if (!event || typeof event !== 'object' || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
        typeof event.id !== 'string' || !ID_RE.test(event.id) ||
        !['appended', 'acknowledged', 'evicted'].includes(event.type) ||
        !STATUS.includes(event.status) || !Number.isSafeInteger(event.atMs)) {
      fail('OWNER_DIRECTIVE_INBOX_INVALID', 'The durable owner directive inbox is invalid.');
    }
  }
  return value;
}

function readInbox(file = INBOX_FILE) {
  try { return validateInbox(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) {
    if (error && error.code === 'ENOENT') return emptyInbox();
    if (error instanceof OwnerDirectiveInboxError) throw error;
    fail('OWNER_DIRECTIVE_INBOX_UNAVAILABLE', 'The durable owner directive inbox is unavailable.');
  }
  return undefined; // unreachable
}

function writeInbox(inbox, file = INBOX_FILE) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(inbox, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* atomic move already consumed it */ }
  }
}

function withLock(work, options = {}) {
  const file = path.resolve(options.inboxFile || INBOX_FILE);
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600);
  } catch {
    // Reclaim a lock orphaned by a holder that died before its finally block,
    // rather than fail closed forever. Deliberately minimal: a genuinely-held
    // FRESH lock still fails fast exactly as before, preserving this module's
    // existing contention semantics (and the tests that pin them). Only a
    // provably abandoned lock is reclaimed, and only then is the open retried.
    let reclaimed = false;
    try {
      const stat = fs.statSync(lock);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        fs.unlinkSync(lock);
        reclaimed = true;
      }
    } catch (error) {
      // A vanished lock is a harmless acquisition race: the open below can
      // establish whether the inbox is now available. Any other stat failure
      // is not evidence of contention. Report that lock availability could
      // not be established instead of presenting it as the definite BUSY
      // answer used for a lock we successfully inspected.
      if (!error || error.code !== 'ENOENT') {
        fail('OWNER_DIRECTIVE_INBOX_UNAVAILABLE', 'The owner directive inbox lock state is unavailable.');
      }
      reclaimed = true;
    }
    if (!reclaimed) {
      fail('OWNER_DIRECTIVE_INBOX_BUSY', 'The owner directive inbox is busy; retry shortly.');
    }
    try {
      descriptor = fs.openSync(lock, 'wx', 0o600);
    } catch {
      fail('OWNER_DIRECTIVE_INBOX_BUSY', 'The owner directive inbox is busy; retry shortly.');
    }
  }
  try {
    const inbox = readInbox(file);
    const result = work(inbox);
    writeInbox(inbox, file);
    return result;
  } finally {
    try { fs.closeSync(descriptor); } catch { /* best effort */ }
    try { fs.unlinkSync(lock); } catch { /* best effort */ }
  }
}

function safeItem(item) {
  return Object.freeze({
    id: item.id,
    text: item.text,
    status: item.status,
    source: item.source,
    submittedBy: item.submittedBy,
    createdAtMs: item.createdAtMs,
    updatedAtMs: item.updatedAtMs,
    acknowledgedAtMs: item.acknowledgedAtMs || null,
    acknowledgedBy: item.acknowledgedBy || null
  });
}

function appendEvent(inbox, item, type) {
  inbox.events.push({
    sequence: inbox.nextSequence++, id: item.id, type,
    status: item.status, atMs: item.updatedAtMs
  });
  if (inbox.events.length > MAX_EVENTS) inbox.events.splice(0, inbox.events.length - MAX_EVENTS);
}

function inboxCounts(inbox) {
  const counts = { unread: 0, acknowledged: 0, total: inbox.items.length };
  for (const item of inbox.items) counts[item.status] += 1;
  return counts;
}

function makeRoomOrRefuse(inbox) {
  if (inbox.items.length < MAX_ITEMS) return;
  // Evict the single oldest ACKNOWLEDGED item to make room. Never evict an
  // unread directive -- losing an owner's word silently is exactly the
  // failure STANDING-ORDERS.md RECORD rule 1a exists to prevent.
  const evictIndex = inbox.items.findIndex(item => item.status === 'acknowledged');
  if (evictIndex === -1) {
    fail('OWNER_DIRECTIVE_INBOX_FULL', 'The owner directive inbox is full of unread directives; acknowledge some before adding more.');
  }
  const [evicted] = inbox.items.splice(evictIndex, 1);
  appendEvent(inbox, evicted, 'evicted');
}

/**
 * Append one directive, verbatim. `text` is stored exactly as given (only
 * bounded for length and scanned by the SENSITIVE heuristic); it is never
 * trimmed, summarized, or otherwise rewritten -- STANDING-ORDERS.md RECORD
 * rule 1a: "you need to keep my exact words every word in my prompts matter."
 *
 * `idempotencyKey`, if given and already present on a still-tracked item,
 * returns that existing item instead of creating a duplicate (a retried
 * dashboard submit or a repeated system.ask write is not a second directive).
 */
function append(input = {}, overrides = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('OWNER_DIRECTIVE_INVALID', 'The owner directive request is invalid.');
  }
  const allowed = ['text', 'source', 'submittedBy', 'idempotencyKey'];
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    fail('OWNER_DIRECTIVE_INVALID', 'The owner directive request is invalid.');
  }
  const text = input.text;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_TEXT_LENGTH) {
    fail('OWNER_DIRECTIVE_INVALID', `The directive text must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters.`);
  }
  if (SENSITIVE.test(text)) {
    fail('OWNER_DIRECTIVE_LOOKS_SENSITIVE', 'This directive looks like it contains a credential or secret; it was not stored. Use a credential tool instead.');
  }
  const source = input.source === undefined ? DEFAULT_SOURCE : input.source;
  if (!SOURCE_RE.test(String(source))) fail('OWNER_DIRECTIVE_INVALID', 'source is invalid.');
  const submittedBy = input.submittedBy === undefined ? DEFAULT_ACTOR : input.submittedBy;
  if (!ACTOR_RE.test(String(submittedBy))) fail('OWNER_DIRECTIVE_INVALID', 'submittedBy is invalid.');
  let idempotencyKey = null;
  if (input.idempotencyKey !== undefined) {
    if (!IDEMPOTENCY_KEY_RE.test(String(input.idempotencyKey))) fail('OWNER_DIRECTIVE_INVALID', 'idempotencyKey is invalid.');
    idempotencyKey = input.idempotencyKey;
  }

  const result = withLock(inbox => {
    if (idempotencyKey) {
      const existing = inbox.items.find(item => item.idempotencyKey === idempotencyKey);
      if (existing) return { item: existing, replayed: true, counts: inboxCounts(inbox) };
    }
    makeRoomOrRefuse(inbox);
    const atMs = now();
    const item = {
      id: `owner-directive-${crypto.randomUUID()}`,
      text, status: 'unread', source, submittedBy, idempotencyKey,
      createdAtMs: atMs, updatedAtMs: atMs, acknowledgedAtMs: null, acknowledgedBy: null
    };
    inbox.items.push(item);
    appendEvent(inbox, item, 'appended');
    return { item, replayed: false, counts: inboxCounts(inbox) };
  }, overrides);

  return Object.freeze({ ...safeItem(result.item), replayed: result.replayed, counts: Object.freeze(result.counts) });
}

/**
 * List directives, oldest first (the order the owner said them in). Defaults
 * to unread only -- this is the shape the controller's "drain on every wake"
 * loop wants: what's new since I last looked.
 */
function list(input = {}, overrides = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('OWNER_DIRECTIVE_LIST_INVALID', 'The owner directive list request is invalid.');
  }
  const allowed = ['unreadOnly', 'limit'];
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    fail('OWNER_DIRECTIVE_LIST_INVALID', 'The owner directive list request is invalid.');
  }
  const unreadOnly = input.unreadOnly === undefined ? true : input.unreadOnly;
  if (typeof unreadOnly !== 'boolean') fail('OWNER_DIRECTIVE_LIST_INVALID', 'unreadOnly must be a boolean.');
  const limit = input.limit === undefined ? DEFAULT_LIST_LIMIT : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    fail('OWNER_DIRECTIVE_LIST_INVALID', `limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
  }

  const inboxFile = path.resolve(overrides.inboxFile || INBOX_FILE);
  const inbox = readInbox(inboxFile);
  const filtered = unreadOnly ? inbox.items.filter(item => item.status === 'unread') : inbox.items;
  const items = filtered.slice(0, limit).map(safeItem);
  return Object.freeze({ items: Object.freeze(items), counts: Object.freeze(inboxCounts(inbox)) });
}

/**
 * Acknowledge one directive by id. Idempotent: acknowledging an already-
 * acknowledged item is a no-op that returns its existing (first) acker,
 * rather than overwriting who actually drained it or erroring on a retry.
 */
function acknowledge(input = {}, overrides = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('OWNER_DIRECTIVE_INVALID', 'The owner directive acknowledge request is invalid.');
  }
  const allowed = ['id', 'by'];
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    fail('OWNER_DIRECTIVE_INVALID', 'The owner directive acknowledge request is invalid.');
  }
  if (typeof input.id !== 'string' || !ID_RE.test(input.id)) fail('OWNER_DIRECTIVE_INVALID', 'id is invalid.');
  if (typeof input.by !== 'string' || !ACTOR_RE.test(input.by)) fail('OWNER_DIRECTIVE_INVALID', 'by is invalid.');

  const result = withLock(inbox => {
    const item = inbox.items.find(candidate => candidate.id === input.id);
    if (!item) fail('OWNER_DIRECTIVE_NOT_FOUND', 'The owner directive is unavailable.');
    if (item.status === 'unread') {
      item.status = 'acknowledged';
      item.updatedAtMs = now();
      item.acknowledgedAtMs = item.updatedAtMs;
      item.acknowledgedBy = input.by;
      appendEvent(inbox, item, 'acknowledged');
    }
    return { item, counts: inboxCounts(inbox) };
  }, overrides);

  return Object.freeze({ ...safeItem(result.item), counts: Object.freeze(result.counts) });
}

/** Cheap counts-only view, for a dashboard badge. Not part of the minimal
 * append/list/acknowledge contract, but derived from list() at negligible
 * cost -- see docs/DASHBOARD-BRIDGE-PLAN.md Phase 1's dashboard half. */
function status(overrides = {}) {
  const inboxFile = path.resolve(overrides.inboxFile || INBOX_FILE);
  const inbox = readInbox(inboxFile);
  return Object.freeze({ counts: Object.freeze(inboxCounts(inbox)) });
}

module.exports = Object.freeze({
  OwnerDirectiveInboxError,
  VERSION, INBOX_FILE, STATUS, MAX_TEXT_LENGTH, MAX_ITEMS,
  append, list, acknowledge, status, readInbox
});
