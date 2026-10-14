'use strict';

// OWNER INPUT SURVIVES THE WRITE, OR THE WRITE WAS NOT DURABLE.
//
// A ledger write can correctly refuse while another process holds the lock. The
// input still needs a durable location before that refusal: keeping it only in
// the exiting process would turn safe concurrency control into data loss.
//
// WHY THIS IS A SHIPPING DEFECT AND NOT AN INTERNAL PROCESS PROBLEM. The
// product's entire selling point is running fleets of agents. Capture is a
// read-modify-write of one shared JSON file contended by concurrent lanes, so the
// probability that capture fails rises with fleet size: the product loses the
// most input exactly when the customer is using it hardest. Every customer
// running a fleet hits this.
//
// THE FIX IS A WRITE-AHEAD LOG, and the ORDER is the whole point. The words are
// made durable BEFORE the ledger is touched, not in a catch block afterwards.
// Spooling only on failure would still lose everything if the process were
// killed, or the machine lost power, between acquiring the lock and completing
// the rename. Spool-first converts every downstream failure from DATA LOSS
// (unrecoverable) into RECONCILIATION (recoverable, and visible).
//
// WHY PER-ENTRY FILES rather than the alternatives considered:
//
//   - A BIGGER RETRY / BETTER LOCK only shrinks the window. With ~10 lanes and a
//     ~1 MB read-modify-write, contention is the normal state rather than the
//     exception, and a retry loop still terminates in "gave up" -- the same loss,
//     slightly later, and now with a delay attached.
//
//   - ONE APPEND-ONLY JOURNAL FILE is the classic answer and is nearly right,
//     but a single shared file is exactly the resource being contended. An
//     O_APPEND write is atomic only for small writes on POSIX; these records are
//     multi-KB and this is Windows, so concurrent appends can interleave. A torn
//     record makes the journal unparseable, which loses the words a second way
//     while looking like durability.
//
//   - PER-ENTRY FILES cannot contend, by construction. Every capture writes a
//     NEW file under a name no other process can generate (timestamp + pid +
//     uuid). There is no shared mutable byte range, therefore no lock, therefore
//     nothing to wait for and nothing to lose a race to. The cost is a directory
//     with many small files, which is precisely what directories are for.
//
// NOTHING HERE IS EVER DELETED. Reconciling a record MOVES it from pending/ to
// reconciled/ and keeps the bytes. Losing work is the defect being fixed; a fix
// that tidies work away has failed. The rename is atomic, so a record is in
// exactly one of the two states at any instant and can never be in neither.
//
// AND ONLY A DECISION LEAVES pending/. The two moves out of the queue are the
// ledger accepting the words (markReconciled) and the PERSON declining them
// (markDiscarded, which now has to be told a person decided). Everything else
// -- a failed write (annotatePending), a turn that ended with an agent filing
// nothing (markUnfiled) -- annotates the record where it stands. A record that
// left the queue with nobody deciding is kept bytes nobody can reach, which is
// the same loss in a tidier directory.
//
// THIS MODULE DOES NOT KNOW WHAT A LEDGER ENTRY MEANS. It stores an opaque
// payload and the fields needed to replay it. Entry schema, provenance
// semantics and what an entry means are owned elsewhere; this file owns only
// the guarantee that the bytes reach the disk.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SPOOL_DIRECTORY_NAME = 'owner-capture-spool';
const PENDING = 'pending';
const RECONCILED = 'reconciled';
const RECORD_VERSION = 1;

class OwnerCaptureSpoolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The spool follows the ledger it is a write-ahead log FOR. Deriving it from the
// ledger path rather than a fixed root means a test ledger, an archived ledger
// and the live ledger each keep their own spool, and a --ledger override can
// never spool into the wrong file's queue.
function spoolDirectory(ledgerFile) {
  if (typeof ledgerFile !== 'string' || !ledgerFile.trim()) {
    throw new OwnerCaptureSpoolError('OWNER_CAPTURE_SPOOL_TARGET_INVALID', 'A ledger file path is required to locate its spool.');
  }
  return path.join(path.dirname(path.resolve(ledgerFile)), SPOOL_DIRECTORY_NAME);
}

function pendingDirectory(ledgerFile) {
  return path.join(spoolDirectory(ledgerFile), PENDING);
}

function reconciledDirectory(ledgerFile) {
  return path.join(spoolDirectory(ledgerFile), RECONCILED);
}

// Sortable first, unique second. The leading timestamp means a plain directory
// listing is in capture order, so the oldest unreconciled directive is the first
// line of `ls` -- no parsing required to answer "what did we lose?".
function recordName(now, pid) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${stamp}--pid${pid}--${crypto.randomUUID()}.json`;
}

// Write-then-rename within the same directory. The temp name is unique, so this
// cannot collide even with every other lane spooling at the same moment, and a
// reader of pending/ never observes a partially written record: it sees the file
// either not at all or complete.
function atomicWriteJson(file, payload) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, serialized, 'utf8');
    // fsync before the rename: without it the rename can be visible while the
    // contents are still only in the page cache, which after a power loss is a
    // zero-length file where a directive used to be.
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
    }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

/**
 * Make a capture durable BEFORE anything is attempted against the ledger.
 *
 * Returns a handle carrying the record's own path. Callers must treat a
 * successful return as "the owner's words now survive this process dying" and
 * nothing more -- it says nothing about the ledger.
 */
function writeAhead(ledgerFile, { mode, id, text, interpretation, actor, source, gates, status, scope, threadId, provenanceClass, proposal, now = new Date() }) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new OwnerCaptureSpoolError('OWNER_CAPTURE_SPOOL_EMPTY', 'Refusing to spool an empty capture; there are no words to protect.');
  }
  const directory = pendingDirectory(ledgerFile);
  fs.mkdirSync(directory, { recursive: true });
  const name = recordName(now, process.pid);
  const file = path.join(directory, name);
  const record = {
    version: RECORD_VERSION,
    name,
    spooledAt: now.toISOString(),
    spooledByPid: process.pid,
    ledgerFile: path.resolve(ledgerFile),
    mode,
    id,
    // The owner's words, stored exactly as given. This field is the entire
    // reason the file exists; everything else is replay metadata.
    text,
    interpretation: interpretation ?? null,
    actor,
    source: source ?? null,
    gates: Array.isArray(gates) ? gates : [],
    status: status ?? null,
    scope: scope ?? null,
    threadId: threadId ?? null,
    provenanceClass: provenanceClass ?? null,
    proposal: proposal ?? null,
    ledgerOutcome: 'pending'
  };
  atomicWriteJson(file, record);
  return { name, file, directory, record };
}

/**
 * The ledger write succeeded, so this record is no longer outstanding. The bytes
 * are KEPT -- moved, never removed -- so the spool doubles as an independent
 * verbatim history that does not depend on the big JSON file staying intact.
 */
function markReconciled(handle, { revision = null, now = new Date() } = {}) {
  const target = reconciledDirectory(handle.record.ledgerFile);
  fs.mkdirSync(target, { recursive: true });
  const destination = path.join(target, handle.name);
  const settled = { ...handle.record, ledgerOutcome: 'in-ledger', reconciledAt: now.toISOString(), ledgerRevision: revision };
  atomicWriteJson(destination, settled);
  // Only after the reconciled copy is safely on disk does the pending copy go.
  // The reverse order would leave a window in which the record exists nowhere.
  removePendingRecord(handle.file);
  return { file: destination };
}

// ENOENT establishes that the record is already out of pending (for example,
// because another custodian settled the same record). Any other unlink failure
// leaves it visibly pending, so reporting the settlement as complete would turn
// "could not remove it" into the definite answer "it was removed".
function removePendingRecord(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

/**
 * A turn ended over this record and nothing was filed. This is NOT a
 * settlement: the record STAYS pending, because nobody decided anything about
 * it. It only gains the note saying so, which is what turns an undifferentiated
 * queue into "these are the requests an agent read and left".
 *
 * MEASURED 2026-09-03, the owner's live spool at
 * state/r-ledger/owner-capture-spool: 228 of its 231 settled records read
 * ledgerOutcome 'discarded' with the reason "agent read it and filed nothing"
 * and discardedBy an agent name, while the canonical request ledger held ONE
 * request. An agent that read the person's words and did nothing was writing
 * the PERSON'S verdict for them, into the state this module treats as final,
 * and out of the only queue -- listPending -- that the review tool and the
 * reconciler can still reach. Bytes kept, and unreachable: the loss this module
 * exists to prevent, wearing the shape of a settlement.
 *
 * Returns whether the note reached the disk, on annotatePending's rule: the
 * words are already durable and already pending, so a failed note is reported,
 * never escalated into losing them and never reported as written.
 */
function markUnfiled(handle, { reason, actor = null, now = new Date() } = {}) {
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!normalizedReason) {
    throw new OwnerCaptureSpoolError(
      'OWNER_CAPTURE_SPOOL_UNFILED_REASON_REQUIRED',
      'Recording that a turn filed nothing requires a reason; the person reads it to decide what to do with the words.'
    );
  }
  const marked = {
    ...handle.record,
    ledgerOutcome: 'unfiled',
    unfiledAt: now.toISOString(),
    unfiledBy: actor,
    unfiledReason: normalizedReason
  };
  try {
    atomicWriteJson(handle.file, marked);
  } catch (error) {
    return { file: handle.file, marked: false, error };
  }
  return { file: handle.file, marked: true, record: marked };
}

// A discard is the PERSON'S verdict on the person's own words, so the caller
// has to say that a person gave it. Nothing infers this from the actor name:
// an actor is whoever ran the surface ('person', 'owner-spool-review', an
// agent), and reading intent out of that string is how an agent's silence came
// to be recorded as the owner's decision in the first place.
const DISCARD_DECIDED_BY = 'person';

/**
 * Settle an ingress record that the PERSON classified as noise rather than a
 * request of theirs. The record and the reason are retained permanently;
 * "discard" means "do not promote to the request ledger", never delete bytes.
 */
function markDiscarded(handle, { reason, actor = null, decidedBy = null, now = new Date() } = {}) {
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!normalizedReason) {
    throw new OwnerCaptureSpoolError(
      'OWNER_CAPTURE_SPOOL_DISCARD_REASON_REQUIRED',
      'Discarding a spooled owner turn requires a reason.'
    );
  }
  if (decidedBy !== DISCARD_DECIDED_BY) {
    throw new OwnerCaptureSpoolError(
      'OWNER_CAPTURE_SPOOL_DISCARD_NOT_A_PERSON',
      'Only the person may discard their own words, and this call did not say one did. '
        + `Pass decidedBy: "${DISCARD_DECIDED_BY}" from the surface the person acted on (Decline, or owner-spool-review --discard). `
        + 'A turn that ended with the agent filing nothing is markUnfiled() instead: it keeps the record pending, where the person can still read it and file it.'
    );
  }
  const target = reconciledDirectory(handle.record.ledgerFile);
  fs.mkdirSync(target, { recursive: true });
  const destination = path.join(target, handle.name);
  const settled = {
    ...handle.record,
    ledgerOutcome: 'discarded',
    discardedAt: now.toISOString(),
    discardedBy: actor,
    discardReason: normalizedReason,
    // The guard above already REQUIRED decidedBy to be the person before this
    // line runs; persisting it is the difference between a rule this function
    // enforces at call time and a fact a later reader can still find on disk.
    // Without it, a legitimate discard and the pre-guard bug it replaced are
    // byte-for-byte the same shape once written -- which is exactly how 228 of
    // the owner's own turns went unreachable while nothing on disk said why.
    decidedBy
  };
  atomicWriteJson(destination, settled);
  removePendingRecord(handle.file);
  return { file: destination };
}

/**
 * The ledger write did NOT happen. The record STAYS pending -- the words are the
 * point and they keep their place in the queue -- but it records why, so the
 * pending queue explains itself instead of being an undifferentiated pile.
 *
 * Deliberately keeps records that failed on a caller mistake (a wrong flag, a
 * duplicate id) rather than discarding them. Those records still contain text
 * somebody typed as the owner's words, and the whole failure being fixed here is
 * an agent deciding on its own that some words were not worth keeping.
 */
function annotatePending(handle, { code, message, now = new Date() } = {}) {
  const annotated = {
    ...handle.record,
    ledgerOutcome: 'not-in-ledger',
    lastAttemptAt: now.toISOString(),
    lastAttemptError: { code: code ?? null, message: typeof message === 'string' ? message.slice(0, 2000) : null }
  };
  try {
    atomicWriteJson(handle.file, annotated);
  } catch (error) {
    // The original pending record is already on disk and already holds the
    // words. Failing to add an explanation must never escalate into losing them.
    // Carry that uncertainty to callers instead of claiming the annotation was
    // written when it was not.
    return { file: handle.file, annotated: false, error };
  }
  return { file: handle.file, annotated: true };
}

function readRecord(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OwnerCaptureSpoolError(
      'OWNER_CAPTURE_SPOOL_RECORD_INVALID',
      `Pending spool record is not a JSON object: ${file}`
    );
  }
  return { ...parsed, file };
}

/**
 * Every capture whose words are durable but which never reached the ledger.
 * This is the answer to "what did the fleet lose today?", and it is a directory
 * listing rather than a claim.
 */
function listPending(ledgerFile) {
  const directory = pendingDirectory(ledgerFile);
  let names;
  try {
    names = fs.readdirSync(directory).filter((n) => n.endsWith('.json') && !n.endsWith('.tmp'));
  } catch (error) {
    // A spool that has never received a record has no pending directory; that
    // is an established empty state. Permission, I/O, and all other failures do
    // not establish emptiness and must refuse rather than pass an empty list.
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names.sort()
    .map((name) => readRecord(path.join(directory, name)));
}

/**
 * A reconciled record that reads as a discard but carries no proof a person
 * decided it. markDiscarded has refused to create this shape since it started
 * requiring decidedBy; a record already on disk in this shape predates that
 * guard. It is not a settlement -- it is an agent's silence wearing the
 * person's verdict, kept exactly where nothing that reads the queue can reach
 * it. `decidedBy` is checked, never `discardedBy`: the latter is whoever ran
 * the surface (an agent, or the reviewer acting on the person's behalf) and
 * was never proof of anything; only the former is.
 */
function isMisdiscarded(record) {
  return Boolean(record) && typeof record === 'object' && !Array.isArray(record)
    && record.ledgerOutcome === 'discarded' && record.decidedBy !== DISCARD_DECIDED_BY;
}

/**
 * Every misdiscarded record in one ledger's reconciled/. Same read-only,
 * directory-listing contract as listPending: an absent reconciled/ directory
 * is an established empty state, and no other read failure may be reported as
 * one.
 */
function listMisdiscarded(ledgerFile) {
  const directory = reconciledDirectory(ledgerFile);
  let names;
  try {
    names = fs.readdirSync(directory).filter((n) => n.endsWith('.json') && !n.endsWith('.tmp'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names.sort()
    .map((name) => readRecord(path.join(directory, name)))
    .filter(isMisdiscarded);
}

/**
 * Move every misdiscarded record in one ledger's reconciled/ back to
 * pending/, in exactly the shape markUnfiled leaves a turn in: that is what
 * this always was -- a turn that ended with nothing filed, never a person's
 * verdict. The mistaken discard fields stay on the record (nothing here
 * pretends the bug did not happen) alongside a note of the correction itself.
 * Same ordering guarantee as every other move in this module: the pending
 * copy is durable before the reconciled copy goes, so a record is never in
 * neither directory. Safe to call on every read -- once a record is moved, it
 * no longer matches isMisdiscarded and a second call finds nothing to do.
 */
function recoverMisdiscarded(ledgerFile, { now = new Date() } = {}) {
  const recovered = [];
  for (const record of listMisdiscarded(ledgerFile)) {
    const target = pendingDirectory(ledgerFile);
    fs.mkdirSync(target, { recursive: true });
    const destination = path.join(target, record.name);
    const restored = {
      ...record,
      ledgerOutcome: 'unfiled',
      unfiledAt: record.discardedAt,
      unfiledBy: record.discardedBy,
      unfiledReason: record.discardReason,
      recoveredAt: now.toISOString(),
      recoveredReason: 'discarded with no proof a person decided it; restored to the pending queue'
    };
    atomicWriteJson(destination, restored);
    removePendingRecord(record.file);
    recovered.push({ file: destination, record: restored });
  }
  return recovered;
}

module.exports = {
  OwnerCaptureSpoolError,
  SPOOL_DIRECTORY_NAME,
  RECORD_VERSION,
  DISCARD_DECIDED_BY,
  spoolDirectory,
  pendingDirectory,
  reconciledDirectory,
  writeAhead,
  markReconciled,
  markUnfiled,
  markDiscarded,
  annotatePending,
  listPending,
  isMisdiscarded,
  listMisdiscarded,
  recoverMisdiscarded
};
