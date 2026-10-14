'use strict';
// The engine half of Mission Control's public owner prompts: purchase batches,
// confirmations, and notices rendered inside the product. It supplies the
// route, durable store, presentation record, and decision actions expected by
// the renderer, including deny-by-default per-item purchase approval.
//
// WHAT THIS MODULE IS, AND IS NOT
//
// It is the approval RECORDER half of the purchase pipeline. Enqueue a
// purchase batch, serve it to the renderer, record which lines the owner
// approved or denied, all under a durable audit receipt. It never executes a
// purchase, never touches the vault, and never reads a card. The spend
// EXECUTOR is the adjacent module that consumes these recorded approvals
// (settledDecision below is its read API) and completes the purchase with the
// vault card through the capped pay path. The two are separate on purpose:
// when the only code that can spend requires a recorded approval as input,
// per-item owner approval is enforced by construction rather than by
// convention.
//
// Credential prompts NEVER appear here. The renderer's snapshot validator
// rejects them by construction ("Credential fields have no accepted shape"),
// and the native DPAPI-isolated dialog remains their only surface. This split
// is the security boundary, not an implementation accident.
//
// CONTRACT DISCIPLINE
//
// The renderer validates with exactKeys -- unknown keys are rejected as hard
// as missing ones, and one stray field blanks the popup in the field rather
// than failing here. Every shape below mirrors wt-installer
// src/owner-popup.js exactly, and tests/owner-public-prompts.test.js feeds a
// real snapshot through the renderer's OWN normalizeOwnerPromptSnapshot, so
// drift between the two halves fails a test instead of an owner.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const theme = require('../owner-prompt-theme.js');
const { statePath } = require('../runtime-state-root');

// Per-user runtime data, not a program resource: installed, this resolves under
// the user's state root rather than into the install directory, which the next
// update replaces wholesale. See src/lib/runtime-state-root.js.
const STATE_FILE = statePath('state', 'owner-public-prompts.json');

// Mirrors of the renderer's exact bounds (wt-installer src/owner-popup.js).
const PROMPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const KINDS = Object.freeze(['purchase_batch', 'confirmation', 'notice']);
const MAX_PROMPTS = 64;          // renderer refuses snapshots with more
const MAX_ITEMS = 100;           // renderer refuses purchase batches with more
const MAX_TITLE = 200;
const MAX_MESSAGE = 2_000;
const MAX_ITEM_DESCRIPTION = 300;
const MAX_ITEM_MERCHANT = 200;
const MAX_ITEM_PURPOSE = 500;

// ---------------------------------------------------------------------------
// PROVENANCE ON EVERY PURCHASE LINE.
//
// A purchase line must say whether it is traceable to an owner request rather
// than presenting agent-generated research as owner-authored. The original item
// shape could not distinguish the two kinds because it was exactly
// [id,description,amountCents,currency,merchant,purpose]: there was no field a
// request id could even be written into.
//
// The fix is not a convention. A line may now carry `ownerRequestIds`, and the
// WIRE description is stamped at render time with what that line is traceable
// to. A line with no ledger provenance renders as AGENT-PROPOSED. An
// unprovenanced cart therefore cannot present as an owner-authored list, including
// carts already sitting in the store -- the stamp happens on the way out, so
// legacy records are labelled without rewriting owner-facing state.
//
// The stamp goes in `description`, not `purpose`, for a measured reason: real
// carts run their purposes within a dozen characters of the 500-char renderer
// cap, so prefixing there would force truncation of the owner's own text on
// every line. Descriptions on the same carts sit far below their 300 cap, which
// is why the enqueue bound is 236 -- 300 less the 64 characters the stamp
// reserves.
//
// The wire SHAPE is deliberately unchanged. wt-installer src/owner-popup.js
// validates items with exactKeys; adding a seventh key would make every
// snapshot invalid and blank the popup -- the exact defect this module's header
// exists to prevent. Provenance travels as visible text inside an existing
// field, and lives structurally beside the record, never on the wire.
const OWNER_REQUEST_ID_RE = /^R\d{1,4}(?:\.\d{1,3})?$/;   // R241, R52.1
const MAX_OWNER_REQUEST_IDS = 8;
// Fixed budget the stamp may occupy, reserved at enqueue so a newly built batch
// can never overflow the renderer's description cap on the way out.
const PROVENANCE_STAMP_RESERVE = 64;
const UNPROVENANCED_STAMP = '[AGENT-PROPOSED - not traceable to your words] ';
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SETTLED_KEPT = 200;    // decided/expired history retained for audit reads
const LOCK_TIMEOUT_MS = 5_000;

class OwnerPromptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OwnerPromptError';
    this.code = code;
  }
}

function fail(code, message) { throw new OwnerPromptError(code, message); }

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value, keys, label) {
  if (!plain(value)) fail('OWNER_PROMPT_MALFORMED', `${label} must be a plain object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    fail('OWNER_PROMPT_MALFORMED', `${label} keys are [${actual.join(',')}] but must be exactly [${wanted.join(',')}].`);
  }
}

function boundedText(value, label, maximum) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || CONTROL_RE.test(value)) {
    fail('OWNER_PROMPT_MALFORMED', `${label} must be non-empty text of at most ${maximum} characters with no control characters.`);
  }
  return value;
}

function promptId(value, label) {
  if (typeof value !== 'string' || !PROMPT_ID_RE.test(value)) {
    fail('OWNER_PROMPT_MALFORMED', `${label} is not a valid prompt id.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Durable state. One file, exclusive-lock read-modify-write, atomic rename.
// The bridge server is the only writer for presented/decision; enqueue may
// come from a separate CLI process, so cross-process exclusion is real, not
// theoretical. Lock ownership is the open 'wx' file handle; a dead process's
// stale lock is broken only after it exceeds the timeout, and breaking it is
// logged into the state rather than silent.
// ---------------------------------------------------------------------------

function emptyState() {
  return { version: 1, prompts: [], settled: [], lockBreaks: [], ledgerResets: [] };
}

function readStateFile(stateFile) {
  let raw;
  try { raw = fs.readFileSync(stateFile, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    fail('OWNER_PROMPT_STORE_UNAVAILABLE', 'The owner prompt store could not be read.');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail('OWNER_PROMPT_STORE_CORRUPT', 'The owner prompt store is not valid JSON; refusing to guess at its contents.'); }
  if (!plain(parsed) || parsed.version !== 1 || !Array.isArray(parsed.prompts) || !Array.isArray(parsed.settled)) {
    fail('OWNER_PROMPT_STORE_CORRUPT', 'The owner prompt store has an unknown shape; refusing to overwrite evidence.');
  }
  // lockBreaks is newer than this store's on-disk shape; a file written
  // before it existed is not corrupt, it is simply missing a still-optional
  // field. Backfill only that known legacy absence. If the field is present
  // but unreadable, replacing it with [] would turn "could not establish the
  // lock-break history" into the definite answer "there were no breaks".
  if (parsed.lockBreaks === undefined) parsed.lockBreaks = [];
  else if (!Array.isArray(parsed.lockBreaks)) {
    fail('OWNER_PROMPT_STORE_CORRUPT', 'The owner prompt store has an invalid lock-break history; refusing to report it as empty.');
  }
  if (parsed.ledgerResets === undefined) parsed.ledgerResets = [];
  else if (!Array.isArray(parsed.ledgerResets)) fail('OWNER_PROMPT_STORE_CORRUPT', 'The owner prompt store has an invalid ledger reset journal; refusing to overwrite evidence.');
  const resetTokens = new Set();
  for (const row of parsed.ledgerResets) {
    if (!plain(row) || typeof row.token !== 'string' || typeof row.canonicalToken !== 'string'
        || !/^[a-f0-9]{64}$/.test(row.token) || !/^[a-f0-9]{64}$/.test(row.canonicalToken)
        || typeof row.batchId !== 'string' || !/^[a-f0-9-]{36}$/.test(row.batchId)
        || !Number.isSafeInteger(row.revision) || row.revision < 0 || !Number.isSafeInteger(row.count) || row.count < 0
        || !Array.isArray(row.promptIds) || row.promptIds.some(id => typeof id !== 'string' || !PROMPT_ID_RE.test(id))
        || new Set(row.promptIds).size !== row.promptIds.length || resetTokens.has(row.token)
        || !['captured', 'canonical', 'complete'].includes(row.phase)
        || (row.phase !== 'captured' && (!Number.isSafeInteger(row.canonicalRevision) || row.canonicalRevision < row.revision))) {
      fail('OWNER_PROMPT_STORE_CORRUPT', 'The saved purchase reset is invalid; refusing to overwrite it.');
    }
    resetTokens.add(row.token);
  }
  if (parsed.ledgerResets.filter(row => row.phase !== 'complete').length > 1) {
    fail('OWNER_PROMPT_STORE_CORRUPT', 'The prompt store contains overlapping unfinished resets.');
  }
  return parsed;
}

function writeStateFile(stateFile, state) {
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = `${stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, stateFile);
    if (process.platform !== 'win32') {
      descriptor = fs.openSync(dir, 'r');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
    }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    fail('OWNER_PROMPT_STORE_UNAVAILABLE', 'The owner prompt store could not be written.');
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
  }
}

function withLock(stateFile, clock, operation, { read = true, write = true } = {}) {
  const lockFile = `${stateFile}.lock`;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle = null;
  // Set when this call breaks a stale lock, so the break can be recorded
  // into the state once it is loaded below (see the header comment: "logged
  // into the state rather than silent"). Timestamped with the injected
  // clock for consistency with every other timestamp this module writes.
  let brokenLockAtMs = null;
  for (;;) {
    try { handle = fs.openSync(lockFile, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') fail('OWNER_PROMPT_STORE_UNAVAILABLE', 'The owner prompt store lock could not be created.');
      let stale = false;
      try {
        // Staleness must compare like against like. fs.statSync().mtimeMs is
        // always real OS wall-clock time -- it cannot be injected -- so it
        // has to be measured against Date.now(), never the `clock` passed
        // into this function. `clock` is deliberately injectable (tests
        // freeze or offset it) for the record TIMESTAMPS this module
        // writes; using it here instead made every staleness check
        // meaningless whenever a fake clock was active, which is exactly
        // this module's own test suite -- the one place that should have
        // been able to catch a wrong verdict couldn't, because the fake
        // clock and the real mtime were never in the same domain to begin
        // with.
        const ageExpired = Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_TIMEOUT_MS;
        const rawHolder = fs.readFileSync(lockFile, 'utf8');
        if (!rawHolder) stale = ageExpired; // Previous releases wrote empty lock files.
        else {
          let holder;
          try { holder = JSON.parse(rawHolder); } catch { holder = null; }
          if (Number.isSafeInteger(holder?.pid) && holder.pid > 0) {
            try { process.kill(holder.pid, 0); }
            catch (error) { stale = error.code === 'ESRCH'; }
          }
        }
      } catch (error) {
        // ENOENT is the one failure that establishes a race: there is no lock
        // left to inspect, so retrying acquisition is truthful. Permission and
        // I/O failures establish nothing about staleness. Treating all of them
        // as "not stale" used to end in OWNER_PROMPT_STORE_BUSY, a definite
        // claim that another process held a lock we had not actually read.
        if (error.code !== 'ENOENT') {
          fail('OWNER_PROMPT_STORE_UNAVAILABLE', 'The owner prompt store lock could not be inspected; this does not claim that the lock is absent or held.');
        }
      }
      if (stale) {
        try { fs.unlinkSync(lockFile); brokenLockAtMs = clock(); }
        catch (error) {
          // As above, only absence proves that another process won the race.
          // An unreadable/unremovable stale lock is not evidence of that race.
          if (error.code !== 'ENOENT') {
            fail('OWNER_PROMPT_STORE_UNAVAILABLE', 'The stale owner prompt store lock could not be removed.');
          }
        }
      } else if (Date.now() >= deadline) fail('OWNER_PROMPT_STORE_BUSY', 'The owner prompt store is locked by another process.');
      else {
        // Bounded spin. A synchronous store cannot await; the wait is capped
        // by the deadline above and each pass yields to the filesystem.
        const until = Math.min(Date.now() + 25, deadline);
        while (Date.now() < until) { /* bounded wait */ }
      }
    }
  }
  try {
    // A slow live holder must never lose its lock merely because five seconds
    // elapsed. Identity also lets a later process recover after a crash.
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() }), 'utf8');
    const state = read ? readStateFile(stateFile) : emptyState();
    if (brokenLockAtMs !== null) {
      state.lockBreaks.push({ at: new Date(brokenLockAtMs).toISOString() });
      if (state.lockBreaks.length > MAX_SETTLED_KEPT) state.lockBreaks.splice(0, state.lockBreaks.length - MAX_SETTLED_KEPT);
    }
    const result = operation(state);
    if (write) writeStateFile(stateFile, state);
    return result;
  } finally {
    try {
      const held = fs.fstatSync(handle), current = fs.statSync(lockFile);
      if (held.dev === current.dev && held.ino === current.ino) fs.unlinkSync(lockFile);
    } catch {}
    try { fs.closeSync(handle); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

// `ownerRequestIds` is OPTIONAL on the way in and never inferred. Omitting it
// is allowed and is not an error -- it is a claim, recorded honestly, that this
// line does not come from the owner's words, and the renderer says exactly that.
// Refusing the enqueue instead would only push lanes to invent an id, which is
// the fabricated-provenance failure one layer down.
function normalizeOwnerRequestIds(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    fail('OWNER_PROMPT_MALFORMED', 'purchase item ownerRequestIds must be a non-empty array of owner-request ids, or omitted.');
  }
  if (value.length > MAX_OWNER_REQUEST_IDS) {
    fail('OWNER_PROMPT_MALFORMED', `purchase item ownerRequestIds may name at most ${MAX_OWNER_REQUEST_IDS} owner requests.`);
  }
  const ids = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !OWNER_REQUEST_ID_RE.test(entry)) {
      fail('OWNER_PROMPT_MALFORMED', `purchase item ownerRequestIds entry ${JSON.stringify(entry)} is not an owner-request id (R123 or R52.1).`);
    }
    if (ids.includes(entry)) fail('OWNER_PROMPT_MALFORMED', `purchase item ownerRequestIds repeats ${entry}.`);
    ids.push(entry);
  }
  return ids;
}

// The stamp a reader sees on the line. Bounded to PROVENANCE_STAMP_RESERVE so
// the enqueue-time reservation below is exact rather than approximate.
function provenanceStamp(ownerRequestIds) {
  if (!Array.isArray(ownerRequestIds) || ownerRequestIds.length === 0) return UNPROVENANCED_STAMP;
  for (let shown = ownerRequestIds.length; shown >= 1; shown -= 1) {
    const extra = ownerRequestIds.length - shown;
    const stamp = `[From your words: ${ownerRequestIds.slice(0, shown).join(', ')}${extra ? ` +${extra} more` : ''}] `;
    if (stamp.length <= PROVENANCE_STAMP_RESERVE) return stamp;
  }
  return `[From your words: ${ownerRequestIds.length} owner requests] `;
}

function normalizeEnqueueItem(value, seen) {
  const withProvenance = plain(value) && value.ownerRequestIds !== undefined;
  exactKeys(value, withProvenance
    ? ['id', 'description', 'amountCents', 'currency', 'merchant', 'purpose', 'ownerRequestIds']
    : ['id', 'description', 'amountCents', 'currency', 'merchant', 'purpose'], 'purchase item');
  promptId(value.id, 'purchase item id');
  if (seen.has(value.id)) fail('OWNER_PROMPT_MALFORMED', `purchase item id "${value.id}" is duplicated.`);
  seen.add(value.id);
  if (!Number.isSafeInteger(value.amountCents) || value.amountCents < 1) {
    fail('OWNER_PROMPT_MALFORMED', 'purchase item amountCents must be a positive safe integer.');
  }
  if (typeof value.currency !== 'string' || !CURRENCY_RE.test(value.currency)) {
    fail('OWNER_PROMPT_MALFORMED', 'purchase item currency must be a three-letter uppercase code.');
  }
  // Reserve the stamp's budget HERE so no batch this store accepts can produce
  // a description that overflows the renderer's cap once stamped.
  const description = boundedText(value.description, 'purchase item description', MAX_ITEM_DESCRIPTION - PROVENANCE_STAMP_RESERVE);
  const ownerRequestIds = normalizeOwnerRequestIds(value.ownerRequestIds);
  return {
    id: value.id,
    description,
    amountCents: value.amountCents,
    currency: value.currency,
    merchant: boundedText(value.merchant, 'purchase item merchant', MAX_ITEM_MERCHANT),
    purpose: boundedText(value.purpose, 'purchase item purpose', MAX_ITEM_PURPOSE),
    ownerRequestIds
  };
}

// The wire prompt is EXACTLY what the renderer validates; internal bookkeeping
// (evidence, decisions) lives beside it, never inside it.
function wirePrompt(record) {
  const base = {
    id: record.id,
    kind: record.kind,
    title: record.title,
    message: record.message,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    state: record.state,
    defaultDecision: record.kind === 'notice' ? 'acknowledge' : 'deny'
  };
  if (record.kind !== 'purchase_batch') return base;
  return { ...base, items: record.items.map(wireItem), totalCents: record.totalCents, currency: record.currency };
}

// Stamp provenance onto the line the owner actually reads, and keep the wire
// key set byte-identical to what wt-installer src/owner-popup.js validates.
// Records written before `ownerRequestIds` existed have no provenance, so they
// stamp as AGENT-PROPOSED -- which is the true statement about them.
function wireItem(item) {
  const stamp = provenanceStamp(item.ownerRequestIds);
  // A legacy record may already sit near the cap (the live 0e33e84f cart's
  // descriptions run 57..92, but nothing enforced a reserve before now). The
  // stamp must survive: an over-long description loses its tail visibly rather
  // than the whole snapshot losing renderer validation and blanking the popup.
  const room = MAX_ITEM_DESCRIPTION - stamp.length;
  const description = item.description.length <= room
    ? `${stamp}${item.description}`
    : `${stamp}${item.description.slice(0, Math.max(0, room - 3))}...`;
  return {
    id: item.id,
    description,
    amountCents: item.amountCents,
    currency: item.currency,
    merchant: item.merchant,
    purpose: item.purpose
  };
}

function live(record, nowMs) {
  return !record.decision && Date.parse(record.expiresAt) > nowMs;
}

function settle(state, record, nowMs, reason) {
  state.prompts = state.prompts.filter(candidate => candidate.id !== record.id);
  state.settled.push({ ...record, settledAt: new Date(nowMs).toISOString(), settledReason: reason });
  if (state.settled.length > MAX_SETTLED_KEPT) state.settled.splice(0, state.settled.length - MAX_SETTLED_KEPT);
}

function prune(state, nowMs) {
  for (const record of [...state.prompts]) {
    if (Date.parse(record.expiresAt) <= nowMs && !record.decision) settle(state, record, nowMs, 'expired');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function enqueue(input, dependencies = {}) {
  const stateFile = dependencies.stateFile || STATE_FILE;
  const clock = dependencies.clock || Date.now;
  exactKeys(input, input?.kind === 'purchase_batch'
    ? ['kind', 'title', 'message', 'items', 'ttlMs']
    : ['kind', 'title', 'message', 'ttlMs'], 'owner prompt enqueue input');
  if (!KINDS.includes(input.kind)) fail('OWNER_PROMPT_MALFORMED', `kind must be one of ${KINDS.join(', ')}.`);
  const ttlMs = input.ttlMs === null ? DEFAULT_TTL_MS : input.ttlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    fail('OWNER_PROMPT_MALFORMED', `ttlMs must be null (default) or ${MIN_TTL_MS}..${MAX_TTL_MS}.`);
  }
  const nowMs = clock();
  const record = {
    id: crypto.randomUUID(),
    kind: input.kind,
    title: boundedText(input.title, 'prompt title', MAX_TITLE),
    message: boundedText(input.message, 'prompt message', MAX_MESSAGE),
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    state: 'pending',
    evidence: null,
    decision: null
  };
  if (input.kind === 'purchase_batch') {
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_ITEMS) {
      fail('OWNER_PROMPT_MALFORMED', `purchase items must number 1..${MAX_ITEMS}.`);
    }
    const seen = new Set();
    const items = input.items.map(item => normalizeEnqueueItem(item, seen));
    const currency = items[0].currency;
    if (items.some(item => item.currency !== currency)) {
      fail('OWNER_PROMPT_MALFORMED', 'every purchase item must use the same currency as the batch.');
    }
    record.items = items;
    record.currency = currency;
    record.totalCents = items.reduce((sum, item) => sum + item.amountCents, 0);
    if (!Number.isSafeInteger(record.totalCents)) fail('OWNER_PROMPT_MALFORMED', 'purchase total overflows a safe integer.');
  }
  return withLock(stateFile, clock, state => {
    prune(state, nowMs);
    if (state.prompts.filter(candidate => live(candidate, nowMs)).length >= MAX_PROMPTS) {
      fail('OWNER_PROMPT_QUEUE_FULL', `at most ${MAX_PROMPTS} owner prompts may be pending; decide or expire some first.`);
    }
    state.prompts.push(record);
    return Object.freeze({ promptId: record.id, kind: record.kind, expiresAt: record.expiresAt, ...(record.kind === 'purchase_batch' ? { totalCents: record.totalCents, currency: record.currency, itemCount: record.items.length } : {}) });
  });
}

// The exact snapshot the renderer validates: {ok, schemaVersion, generatedAt,
// theme, prompts} and NOTHING ELSE -- exactKeys on the far side rejects
// unknown keys as hard as missing ones.
function snapshot(dependencies = {}) {
  const stateFile = dependencies.stateFile || STATE_FILE;
  const clock = dependencies.clock || Date.now;
  const nowMs = clock();
  return withLock(stateFile, clock, state => {
    prune(state, nowMs);
    const prompts = state.prompts.filter(record => live(record, nowMs)).map(wirePrompt);
    return {
      ok: true,
      schemaVersion: 1,
      generatedAt: new Date(nowMs).toISOString(),
      theme: theme.themeManifest(),
      prompts
    };
  });
}

function markPresented(input, dependencies = {}) {
  const stateFile = dependencies.stateFile || STATE_FILE;
  const clock = dependencies.clock || Date.now;
  exactKeys(input, ['promptId', 'evidence'], 'owner prompt presented input');
  promptId(input.promptId, 'promptId');
  exactKeys(input.evidence, ['mounted', 'visible', 'focused'], 'presentation evidence');
  for (const key of ['mounted', 'visible', 'focused']) {
    if (typeof input.evidence[key] !== 'boolean') fail('OWNER_PROMPT_MALFORMED', `evidence.${key} must be a boolean.`);
  }
  // The whole point of measured evidence is that "presented" means the owner
  // could actually see it. Accepting unmounted or invisible evidence would be
  // a confirmation artefact not bound to what it confirms.
  if (!input.evidence.mounted || !input.evidence.visible) {
    fail('OWNER_PROMPT_NOT_VISIBLE', 'presentation evidence does not show a mounted, visible dialog; the prompt stays pending.');
  }
  const nowMs = clock();
  return withLock(stateFile, clock, state => {
    prune(state, nowMs);
    const record = state.prompts.find(candidate => candidate.id === input.promptId);
    if (!record || !live(record, nowMs)) fail('OWNER_PROMPT_UNKNOWN', 'no pending owner prompt has that id.');
    // Idempotent: the renderer re-presents on every poll cycle that finds the
    // prompt undecided, and a second identical confirmation is not an error.
    record.state = 'presented';
    record.evidence = { ...input.evidence, at: new Date(nowMs).toISOString() };
    return Object.freeze({ promptId: record.id, state: record.state });
  });
}

function decide(input, dependencies = {}) {
  const stateFile = dependencies.stateFile || STATE_FILE;
  const clock = dependencies.clock || Date.now;
  if (!plain(input) || typeof input.promptId !== 'string') fail('OWNER_PROMPT_MALFORMED', 'decision input must carry a promptId.');
  promptId(input.promptId, 'promptId');
  const nowMs = clock();
  return withLock(stateFile, clock, state => {
    prune(state, nowMs);
    const record = state.prompts.find(candidate => candidate.id === input.promptId);
    if (!record || !live(record, nowMs)) fail('OWNER_PROMPT_UNKNOWN', 'no pending owner prompt has that id.');
    if (state.ledgerResets.some(reset => reset.phase !== 'complete' && reset.promptIds.includes(record.id))) fail('OWNER_PROMPT_RESET_PENDING', 'this purchase prompt is being reset and cannot be decided.');
    // A decision on a prompt that was never measurably presented is exactly
    // the unbound-confirmation defect class; refuse it.
    if (record.state !== 'presented') fail('OWNER_PROMPT_NOT_PRESENTED', 'this prompt has not been measurably presented; a decision cannot be recorded for it.');

    let outcome;
    if (record.kind === 'purchase_batch') {
      exactKeys(input, ['promptId', 'decision', 'itemDecisions'], 'purchase decision input');
      if (input.decision !== 'submit') fail('OWNER_PROMPT_MALFORMED', 'purchase batches are decided with decision "submit" plus per-item decisions.');
      if (!Array.isArray(input.itemDecisions) || input.itemDecisions.length > record.items.length) {
        fail('OWNER_PROMPT_MALFORMED', 'itemDecisions must be an array no longer than the item list.');
      }
      const known = new Set(record.items.map(item => item.id));
      const chosen = new Map();
      for (const entry of input.itemDecisions) {
        exactKeys(entry, ['itemId', 'decision'], 'item decision');
        promptId(entry.itemId, 'item decision itemId');
        if (!known.has(entry.itemId)) fail('OWNER_PROMPT_MALFORMED', `item decision names unknown item "${entry.itemId}".`);
        if (chosen.has(entry.itemId)) fail('OWNER_PROMPT_MALFORMED', `item "${entry.itemId}" is decided twice.`);
        if (entry.decision !== 'approve' && entry.decision !== 'deny') fail('OWNER_PROMPT_MALFORMED', 'item decisions must be approve or deny.');
        chosen.set(entry.itemId, entry.decision);
      }
      // Deny-by-default: a line the owner did not explicitly approve is
      // denied. Omission is never consent.
      // ownerRequestIds rides into the recorded decision so the audit receipt
      // for a spend can answer which owner request authorized it -- null where
      // the line was agent-proposed, which is the honest answer and is exactly
      // what the owner saw stamped on that line when approving it.
      const items = record.items.map(item => ({ itemId: item.id, decision: chosen.get(item.id) || 'deny', amountCents: item.amountCents, currency: item.currency, description: item.description, ownerRequestIds: item.ownerRequestIds || null }));
      const approved = items.filter(item => item.decision === 'approve');
      outcome = {
        decision: 'submit',
        items,
        approvedCount: approved.length,
        deniedCount: items.length - approved.length,
        approvedTotalCents: approved.reduce((sum, item) => sum + item.amountCents, 0),
        currency: record.currency
      };
    } else if (record.kind === 'confirmation') {
      exactKeys(input, ['promptId', 'decision'], 'confirmation decision input');
      if (input.decision !== 'approve' && input.decision !== 'deny') fail('OWNER_PROMPT_MALFORMED', 'confirmations are decided with approve or deny.');
      outcome = { decision: input.decision };
    } else {
      exactKeys(input, ['promptId', 'decision'], 'notice decision input');
      if (input.decision !== 'acknowledge') fail('OWNER_PROMPT_MALFORMED', 'notices are decided with acknowledge.');
      outcome = { decision: 'acknowledge' };
    }

    record.decision = { ...outcome, decidedAt: new Date(nowMs).toISOString() };
    settle(state, record, nowMs, 'decided');
    return Object.freeze({ promptId: record.id, kind: record.kind, ...outcome });
  });
}

// Read a settled decision back (for the later spend path and for audit reads).
// Returns null rather than throwing for an unknown id: absence of a decision
// is a normal answer to this question, not an error -- and the distinction
// matters, because the spend path must treat "no recorded decision" as DENIED.
function settledDecision(promptIdValue, dependencies = {}) {
  const stateFile = dependencies.stateFile || STATE_FILE;
  const clock = dependencies.clock || Date.now;
  promptId(promptIdValue, 'promptId');
  return withLock(stateFile, clock, state => {
    const record = state.settled.find(candidate => candidate.id === promptIdValue);
    if (!record) return null;
    return JSON.parse(JSON.stringify({ id: record.id, kind: record.kind, settledReason: record.settledReason, settledAt: record.settledAt, decision: record.decision }));
  });
}

// ---------------------------------------------------------------------------
// REPLACING A CART, AS OPPOSED TO DECIDING ONE.
//
// Purchase batches are shown to the owner and may later be replaced by
// the next one. Until this function existed the store had no way to SAY that:
// `decide` records an owner decision (fabricating one here would be the worst
// possible lie on a money surface) and `prune` only settles on TTL. So retiring
// a superseded cart meant reaching into the state file from outside the module
// and rewriting its `expiresAt` -- which leaves an unmistakable signature on
// disk: several unrelated batches carrying one identical expiry to the
// millisecond, seconds before a prune sweeps them. That is a hand edit wearing
// the store's clothes, and it is exactly the class of thing this file's header
// says must not happen to owner-facing state.
//
// So supersession becomes a real operation with real preconditions:
//
//   - the REPLACEMENT must already be live in the queue. A cart is never
//     retired into a gap; at no instant is there no list available to open.
//   - the replacement may not retire itself.
//   - `decision` stays null. A superseded batch was never approved, and
//     settledDecision() therefore keeps reporting no decision, which the spend
//     path in purchase-recording.js already treats as DENIED. Retiring a list
//     can never become a route to spending against it.
//   - the record keeps `supersededBy`, so the settled history answers "what
//     replaced this, and when" without anyone reconstructing it from timestamps.
function supersede(input, dependencies = {}) {
  const stateFile = dependencies.stateFile || STATE_FILE;
  const clock = dependencies.clock || Date.now;
  exactKeys(input, ['promptIds', 'supersededBy'], 'supersede input');
  promptId(input.supersededBy, 'supersededBy');
  if (!Array.isArray(input.promptIds) || input.promptIds.length === 0) {
    fail('OWNER_PROMPT_MALFORMED', 'promptIds must be a non-empty array of prompt ids to retire.');
  }
  const targets = [];
  for (const id of input.promptIds) {
    promptId(id, 'promptIds entry');
    if (id === input.supersededBy) fail('OWNER_PROMPT_MALFORMED', 'a prompt cannot supersede itself.');
    if (targets.includes(id)) fail('OWNER_PROMPT_MALFORMED', `promptIds repeats ${id}.`);
    targets.push(id);
  }
  const nowMs = clock();
  return withLock(stateFile, clock, state => {
    prune(state, nowMs);
    const replacement = state.prompts.find(candidate => candidate.id === input.supersededBy);
    if (!replacement || !live(replacement, nowMs)) {
      fail('OWNER_PROMPT_UNKNOWN', 'the superseding prompt is not live in the queue; refusing to retire a list with nothing to replace it.');
    }
    const retired = [];
    for (const id of targets) {
      const record = state.prompts.find(candidate => candidate.id === id);
      // Already gone (decided, expired, or retired by an earlier run) is the
      // desired end state, not a failure -- this stays idempotent so a retried
      // supersede does not abort a load half-done.
      if (!record || !live(record, nowMs)) continue;
      record.supersededBy = input.supersededBy;
      settle(state, record, nowMs, 'superseded');
      retired.push(id);
    }
    return Object.freeze({
      supersededBy: input.supersededBy,
      retired: Object.freeze(retired),
      alreadySettled: Object.freeze(targets.filter(id => !retired.includes(id)))
    });
  });
}

// Captures exact purchase prompt ids before the canonical P phase. The journal
// is durable under this module's existing lock and retry is keyed by token.
function beginLedgerReset({ token, canonicalToken, batchId, promptIds, revision, count } = {}, dependencies = {}) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(canonicalToken)
      || typeof batchId !== 'string' || !/^[a-f0-9-]{36}$/.test(batchId) || !Array.isArray(promptIds)
      || promptIds.some(id => typeof id !== 'string' || !PROMPT_ID_RE.test(id))
      || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(count) || count < 0) {
    fail('OWNER_PROMPT_MALFORMED', 'ledger reset requires a valid challenge, batch and count.');
  }
  const stateFile = dependencies.stateFile || STATE_FILE; const clock = dependencies.clock || Date.now; const nowMs = clock();
  return withLock(stateFile, clock, state => {
    prune(state, nowMs);
    const old = state.ledgerResets.find(row => row.token === token);
    if (old) { if (old.batchId !== batchId) fail('OWNER_PROMPT_RESET_STALE', 'this reset token belongs to a different batch.'); return JSON.parse(JSON.stringify(old)); }
    if (state.ledgerResets.some(row => row.phase !== 'complete')) fail('OWNER_PROMPT_RESET_PENDING', 'Finish the previous purchase reset first.');
    const captured = state.prompts.filter(row => row.kind === 'purchase_batch' && live(row, nowMs)).map(row => row.id).sort();
    if (JSON.stringify(captured) !== JSON.stringify(promptIds)) fail('OWNER_PROMPT_RESET_STALE', 'purchase prompts changed; review the current reset count.');
    const row = { token, canonicalToken, batchId, promptIds: captured, revision, count, phase: 'captured', createdAt: new Date(nowMs).toISOString() };
    state.ledgerResets.push(row); return JSON.parse(JSON.stringify(row));
  });
}
function ledgerReset(token, dependencies = {}) {
  const stateFile = dependencies.stateFile || STATE_FILE;
  const state = readStateFile(stateFile); const row = state.ledgerResets.find(item => item.token === token);
  return row ? JSON.parse(JSON.stringify(row)) : null;
}
function pendingLedgerReset(dependencies = {}) {
  const stateFile = dependencies.stateFile || STATE_FILE; const state = readStateFile(stateFile);
  const row = state.ledgerResets.find(item => item.phase !== 'complete');
  return row ? JSON.parse(JSON.stringify(row)) : null;
}
function ledgerResetForPrompt(promptIdValue, dependencies = {}) {
  const stateFile = dependencies.stateFile || STATE_FILE; const state = readStateFile(stateFile);
  const row = state.ledgerResets.find(item => item.promptIds.includes(promptIdValue));
  return row ? JSON.parse(JSON.stringify(row)) : null;
}
function abortLedgerReset({ token } = {}, dependencies = {}) {
  const stateFile = dependencies.stateFile || STATE_FILE; const clock = dependencies.clock || Date.now;
  return withLock(stateFile, clock, state => { const row = state.ledgerResets.find(item => item.token === token); if (!row || row.phase !== 'captured') return false; state.ledgerResets = state.ledgerResets.filter(item => item !== row); return true; });
}
function markLedgerResetCanonical({ token, count, revision } = {}, dependencies = {}) {
  const stateFile = dependencies.stateFile || STATE_FILE; const clock = dependencies.clock || Date.now;
  return withLock(stateFile, clock, state => {
    const row = state.ledgerResets.find(item => item.token === token);
    if (!row) fail('OWNER_PROMPT_RESET_UNKNOWN', 'no reset journal has that token.');
    if (count !== row.count || !Number.isSafeInteger(revision) || revision < row.revision) fail('OWNER_PROMPT_RESET_STALE', 'The saved reset receipt does not match its batch.');
    if (row.phase === 'captured') { row.phase = 'canonical'; row.canonicalRevision = revision; }
    else if (row.canonicalRevision !== revision) fail('OWNER_PROMPT_RESET_STALE', 'The saved reset receipt changed.');
    return JSON.parse(JSON.stringify(row));
  });
}
function completeLedgerReset({ token } = {}, dependencies = {}) {
  const stateFile = dependencies.stateFile || STATE_FILE; const clock = dependencies.clock || Date.now; const nowMs = clock();
  return withLock(stateFile, clock, state => {
    prune(state, nowMs); const row = state.ledgerResets.find(item => item.token === token);
    if (!row) fail('OWNER_PROMPT_RESET_UNKNOWN', 'no reset journal has that token.');
    if (row.phase === 'captured') fail('OWNER_PROMPT_RESET_PENDING', 'canonical purchase reset has not committed.');
    if (row.phase === 'complete') return Object.freeze({ settled: 0, alreadySettled: row.promptIds.length, phase: 'complete' });
    const settled = [];
    for (const id of row.promptIds) { const prompt = state.prompts.find(item => item.id === id); if (!prompt || !live(prompt, nowMs) || prompt.kind !== 'purchase_batch') continue; prompt.decision = null; prompt.resetBatchId = row.batchId; settle(state, prompt, nowMs, 'ledger-reset'); settled.push(id); }
    row.phase = 'complete'; row.completedAt = new Date(nowMs).toISOString();
    return Object.freeze({ settled: settled.length, alreadySettled: row.promptIds.length - settled.length, phase: 'complete' });
  });
}

function exclusiveLedgerReset(operation, dependencies = {}) {
  if (typeof operation !== 'function') fail('OWNER_PROMPT_MALFORMED', 'A reset operation is required.');
  const stateFile = dependencies.stateFile || STATE_FILE;
  return withLock(`${stateFile}.reset-coordinator`, dependencies.clock || Date.now, operation, { read: false, write: false });
}

// Prompt -> canonical ledger is the only nested lock order. Reset capture and
// completion use the prompt lock separately from their canonical transaction.
function withPurchaseLedgerMirror(promptIdValue, operation, dependencies = {}) {
  promptId(promptIdValue, 'promptId');
  if (typeof operation !== 'function') fail('OWNER_PROMPT_MALFORMED', 'A purchase mirror operation is required.');
  const stateFile = dependencies.stateFile || STATE_FILE;
  return withLock(stateFile, dependencies.clock || Date.now, state => {
    if (state.ledgerResets.some(row => row.promptIds.includes(promptIdValue))) {
      fail('OWNER_PROMPT_RESET_PENDING', 'This purchase request was captured by a Ledger reset.');
    }
    const record = [...state.prompts, ...state.settled].find(row => row.id === promptIdValue);
    if (!record || record.kind !== 'purchase_batch') fail('OWNER_PROMPT_UNKNOWN', 'The purchase request is no longer available to mirror.');
    const result = operation();
    if (result && typeof result.then === 'function') fail('OWNER_PROMPT_MALFORMED', 'Purchase mirrors must finish synchronously while the prompt lock is held.');
    return result;
  }, { write: false });
}

module.exports = Object.freeze({
  KINDS, MAX_PROMPTS, MAX_ITEMS, STATE_FILE,
  MAX_ITEM_DESCRIPTION, PROVENANCE_STAMP_RESERVE, UNPROVENANCED_STAMP, MAX_OWNER_REQUEST_IDS,
  OwnerPromptError,
  enqueue, snapshot, markPresented, decide, settledDecision, supersede,
  beginLedgerReset, ledgerReset, pendingLedgerReset, ledgerResetForPrompt, abortLedgerReset, markLedgerResetCanonical, completeLedgerReset,
  exclusiveLedgerReset, withPurchaseLedgerMirror,
  provenanceStamp
});
