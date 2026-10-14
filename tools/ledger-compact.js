#!/usr/bin/env node
'use strict';

/* Compact the owner request ledger document without changing what the history
   chain speaks for.
 *
 * THE RULE THIS TOOL IS BUILT ON: owner-request-store.js `verifyHistory()`
 * fails on exactly two conditions --
 *   drift    a record whose `coreSha256(record)` differs from the chain's last
 *            word about it;
 *   missing  an id the chain names that is no longer in the document.
 * So compaction is safe if and only if it (a) removes no record and (b) leaves
 * every field `coreOf()` reads byte-identical. `coreOf()` reads: id, parentId,
 * scope, scopeKey, status, verbatim, filedBy, provenance.class,
 * provenance.recordedBy, decisions.LENGTH, removedAt, reset, waitingFor,
 * the task difficulty fields, the `review` decision rows verbatim,
 * ownerState and ownerNodeId. Nothing else on a record is hashed.
 *
 * This tool therefore folds only unhashed bulk into a sidecar and keeps the
 * array LENGTHS that are hashed:
 *   decisions[i].reason  progress prose, except the head/tail window and every
 *                        non-progress row (`review` rows are in the core hash);
 *                        the row itself stays, so decisions.length is untouched.
 *   history[i]           `resolve` rows that are neither the first nor the last
 *                        row of the record. The authoritative copy of every one
 *                        of them is a line of the chain file, which this tool
 *                        never opens for writing. The last row is always kept so
 *                        `carriesChainHash()`, `recoverHistory()` and
 *                        `assertHandoffTaskBinding()` still find it.
 *   captureLog[i]        every entry after the first. normalizeRecord() reads
 *                        the first one, so the first one always stays.
 *   request              ONLY with --fold-request. 2078/2111 live records carry
 *                        `request === '(interpretation) ' + verbatim`, i.e. a
 *                        second copy of the words. Folding it needs a reader
 *                        that re-derives the string, so it is off by default.
 *
 * Nothing is deleted: every folded value is written to the sidecar with its own
 * sha256, and `--restore` rebuilds the input document byte for byte. Tombstoned
 * and `removed` records are NOT dropped -- see the note in `plan()`.
 *
 * Usage:
 *   node tools/ledger-compact.js --ledger <file> [--history <file>]
 *        [--sidecar <file>] [--keep-head N] [--keep-tail N] [--fold-request]
 *        [--apply] [--json]
 *   node tools/ledger-compact.js --restore --ledger <file> --sidecar <file> [--apply]
 *
 * Without --apply it changes nothing and prints what it would do. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const SIDECAR_KIND = 'owner-request-ledger-archive';
const INTERPRETATION_PREFIX = '(interpretation) ';
const DEFAULT_KEEP_HEAD = 2;
const DEFAULT_KEEP_TAIL = 3;

function sha256(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

/* The store writes the document with JSON.stringify(data, null, 2) + '\n'
   (owner-request-store.js atomicWrite -> writeLedgerFile). Reproduce it exactly
   so a compacted file is byte-comparable with one the store itself wrote. */
function serialize(document) { return `${JSON.stringify(document, null, 2)}\n`; }

function parseArguments(argv) {
  const options = {
    ledger: null, history: null, sidecar: null,
    keepHead: DEFAULT_KEEP_HEAD, keepTail: DEFAULT_KEEP_TAIL,
    foldRequest: false, apply: false, restore: false, json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => { index += 1; return argv[index]; };
    if (argument === '--ledger') options.ledger = next();
    else if (argument === '--history') options.history = next();
    else if (argument === '--sidecar') options.sidecar = next();
    else if (argument === '--keep-head') options.keepHead = Number(next());
    else if (argument === '--keep-tail') options.keepTail = Number(next());
    else if (argument === '--fold-request') options.foldRequest = true;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--restore') options.restore = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--dry-run') options.apply = false;
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!options.ledger) throw new Error('--ledger is required');
  options.ledger = path.resolve(options.ledger);
  if (!options.sidecar) options.sidecar = `${options.ledger.replace(/\.json$/, '')}.archive.jsonl`;
  options.sidecar = path.resolve(options.sidecar);
  if (options.history) options.history = path.resolve(options.history);
  if (!Number.isInteger(options.keepHead) || options.keepHead < 0) throw new Error('--keep-head must be a non-negative integer');
  if (!Number.isInteger(options.keepTail) || options.keepTail < 0) throw new Error('--keep-tail must be a non-negative integer');
  return options;
}

/* Which decision rows keep their prose. A row is protected when it is not a
   `progress` row (so every `review` row -- part of the core hash -- and every
   resolve/approve/decline is kept whole), or when it is inside the head or tail
   window of the record's progress rows. */
function protectedDecisionIndexes(decisions, keepHead, keepTail) {
  const keep = new Set();
  const progress = [];
  decisions.forEach((row, index) => {
    if (!plain(row) || row.decision !== 'progress') keep.add(index);
    else progress.push(index);
  });
  for (let n = 0; n < Math.min(keepHead, progress.length); n += 1) keep.add(progress[n]);
  for (let n = 0; n < Math.min(keepTail, progress.length); n += 1) keep.add(progress[progress.length - 1 - n]);
  return keep;
}

/* Which history rows stay on the record. Every row that is not a plain
   `resolve` row stays, and the first and last row always stay. */
function protectedHistoryIndexes(history) {
  const keep = new Set();
  history.forEach((row, index) => { if (!plain(row) || row.kind !== 'resolve') keep.add(index); });
  if (history.length) { keep.add(0); keep.add(history.length - 1); }
  return keep;
}

function marker(hash) { return `[archived ${hash.slice(0, 8)}]`; }

/* Build the compaction plan. Pure: reads nothing, writes nothing. */
function plan(document, options) {
  const folded = [];
  const stats = {
    records: 0, recordsTouched: 0,
    decisionsTotal: 0, reasonsFolded: 0, reasonBytes: 0,
    historyTotal: 0, historyFolded: 0, historyBytes: 0,
    captureTotal: 0, captureFolded: 0, captureBytes: 0,
    requestFolded: 0, requestBytes: 0, requestNotDerivable: 0,
    /* Named so a reader cannot mistake this for a deletion plan. */
    recordsRemoved: 0, tombstonedRecordsKept: 0, decisionsRemoved: 0
  };
  const next = { ...document, requests: [] };
  for (const entry of document.requests) {
    stats.records += 1;
    if (!plain(entry)) { next.requests.push(entry); continue; }
    if (entry.status === 'removed' || typeof entry.removedAt === 'string') stats.tombstonedRecordsKept += 1;
    const record = { ...entry };
    let touched = false;

    const decisions = Array.isArray(entry.decisions) ? entry.decisions : null;
    if (decisions) {
      stats.decisionsTotal += decisions.length;
      const keep = protectedDecisionIndexes(decisions, options.keepHead, options.keepTail);
      const nextDecisions = decisions.map((row, index) => {
        if (keep.has(index) || !plain(row) || typeof row.reason !== 'string' || !row.reason) return row;
        /* Already folded by an earlier compaction: its prose is in that run's
           sidecar and the row holds only the marker. Folding the marker again
           would make this run's restore drop the earlier `reasonArchived` link. */
        if (typeof row.reasonArchived === 'string') return row;
        const hash = sha256(row.reason);
        folded.push({ requestId: entry.id, field: 'decisions.reason', index, sha256: hash, value: row.reason });
        stats.reasonsFolded += 1;
        stats.reasonBytes += Buffer.byteLength(row.reason, 'utf8');
        touched = true;
        return { ...row, reason: marker(hash), reasonArchived: hash.slice(0, 8) };
      });
      /* The hashed quantity. Never allowed to move. */
      if (nextDecisions.length !== decisions.length) throw new Error(`${entry.id}: decisions.length changed`);
      record.decisions = nextDecisions;
    }

    const history = Array.isArray(entry.history) ? entry.history : null;
    if (history) {
      stats.historyTotal += history.length;
      const keep = protectedHistoryIndexes(history);
      const nextHistory = [];
      history.forEach((row, index) => {
        if (keep.has(index)) { nextHistory.push(row); return; }
        const text = JSON.stringify(row);
        folded.push({ requestId: entry.id, field: 'history', index, sha256: sha256(text), value: row });
        stats.historyFolded += 1;
        stats.historyBytes += Buffer.byteLength(text, 'utf8');
        touched = true;
      });
      record.history = nextHistory;
    }

    const captureLog = Array.isArray(entry.captureLog) ? entry.captureLog : null;
    if (captureLog) {
      stats.captureTotal += captureLog.length;
      const nextCapture = [];
      captureLog.forEach((row, index) => {
        if (index === 0) { nextCapture.push(row); return; }
        const text = JSON.stringify(row);
        folded.push({ requestId: entry.id, field: 'captureLog', index, sha256: sha256(text), value: row });
        stats.captureFolded += 1;
        stats.captureBytes += Buffer.byteLength(text, 'utf8');
        touched = true;
      });
      record.captureLog = nextCapture;
    }

    if (typeof entry.request === 'string' && typeof entry.verbatim === 'string') {
      const derivable = entry.request === INTERPRETATION_PREFIX + entry.verbatim;
      if (!derivable) stats.requestNotDerivable += 1;
      else if (options.foldRequest) {
        folded.push({ requestId: entry.id, field: 'request', index: 0, sha256: sha256(entry.request), value: entry.request });
        stats.requestFolded += 1;
        stats.requestBytes += Buffer.byteLength(entry.request, 'utf8');
        record.request = null;
        record.requestDerived = 'interpretation';
        touched = true;
      }
    }

    if (touched) stats.recordsTouched += 1;
    next.requests.push(record);
  }
  return { document: next, folded, stats };
}

function sidecarLines(header, folded) {
  return [JSON.stringify(header), ...folded.map(item => JSON.stringify(item))].join('\n') + '\n';
}

/* Put every folded value back exactly where it came from. */
function restore(document, folded) {
  const byId = new Map();
  for (const entry of document.requests) if (plain(entry) && typeof entry.id === 'string') byId.set(entry.id, entry);
  const historyInserts = new Map();
  const captureInserts = new Map();
  for (const item of folded) {
    const entry = byId.get(item.requestId);
    if (!entry) throw new Error(`restore: ${item.requestId} is not in the document`);
    if (item.field === 'decisions.reason') {
      const row = entry.decisions[item.index];
      if (!plain(row)) throw new Error(`restore: ${item.requestId} decisions[${item.index}] is absent`);
      const next = { ...row, reason: item.value };
      delete next.reasonArchived;
      entry.decisions[item.index] = next;
    } else if (item.field === 'request') {
      entry.request = item.value;
      delete entry.requestDerived;
    } else if (item.field === 'history') {
      if (!historyInserts.has(entry)) historyInserts.set(entry, []);
      historyInserts.get(entry).push(item);
    } else if (item.field === 'captureLog') {
      if (!captureInserts.has(entry)) captureInserts.set(entry, []);
      captureInserts.get(entry).push(item);
    } else throw new Error(`restore: unknown field ${item.field}`);
  }
  const splice = (entry, field, items) => {
    const kept = entry[field].slice();
    const out = [];
    const byIndex = new Map(items.map(item => [item.index, item.value]));
    const total = kept.length + items.length;
    let cursor = 0;
    for (let index = 0; index < total; index += 1) {
      if (byIndex.has(index)) out.push(byIndex.get(index));
      else { out.push(kept[cursor]); cursor += 1; }
    }
    if (cursor !== kept.length) throw new Error(`restore: ${entry.id} ${field} did not reassemble`);
    entry[field] = out;
  };
  for (const [entry, items] of historyInserts) splice(entry, 'history', items);
  for (const [entry, items] of captureInserts) splice(entry, 'captureLog', items);
  return document;
}

function readSidecar(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const header = lines.shift();
  if (!plain(header) || header.kind !== SIDECAR_KIND) throw new Error(`${file} is not a ledger archive sidecar`);
  return { header, folded: lines };
}

/* --apply REPLACES THE LIVE LEDGER, SO IT WRITES THE WAY THE STORE WRITES.
 *
 * Everything below runs under owner-request-store.js's own write lock, so a
 * running app's Ledger write can never interleave with it. Under that lock the
 * Ledger must still be exactly the bytes this run planned from; if another
 * writer got there first, nothing is written and the person runs it again,
 * rather than a compaction of the older document replacing the newer one.
 * Each file is written to a fresh temp file (wx, 0600, fsync) and renamed into
 * place, never rewritten in place. An existing sidecar is never overwritten:
 * the values it holds exist nowhere else once the Ledger carries only their
 * markers. If the Ledger cannot be replaced, the sidecar this run created is
 * removed again, because it describes a compaction that did not happen. */
function removeQuietly(file) {
  try { fs.unlinkSync(file); } catch { /* absent, or nothing more to do */ }
}

function writeTemporaryBeside(file, text) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    return temporary;
  } catch (error) {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch { /* closed */ } }
    removeQuietly(temporary);
    throw error;
  }
}

function replaceByRename(file, text) {
  const temporary = writeTemporaryBeside(file, text);
  try { fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) removeQuietly(temporary); }
}

function applyUnderLedgerLock(options, plannedSha256, { ledgerText, sidecarText = null }) {
  const store = require('../src/lib/owner-request-store.js');
  return store.withLedgerWriteLock(options.ledger, () => {
    if (sha256(fs.readFileSync(options.ledger, 'utf8')) !== plannedSha256) {
      throw new Error('the Ledger changed after it was read, so nothing was written. Run it again.');
    }
    let createdSidecar = false;
    if (sidecarText !== null) {
      if (fs.existsSync(options.sidecar)) {
        throw new Error(`the sidecar ${options.sidecar} already exists and holds values an earlier compaction folded, so nothing was written. Pass a new --sidecar path.`);
      }
      replaceByRename(options.sidecar, sidecarText);
      createdSidecar = true;
    }
    try {
      replaceByRename(options.ledger, ledgerText);
    } catch (error) {
      if (createdSidecar) removeQuietly(options.sidecar);
      throw error;
    }
  });
}

function run(argv) {
  const options = parseArguments(argv);
  const raw = fs.readFileSync(options.ledger, 'utf8');
  const before = { bytes: Buffer.byteLength(raw, 'utf8'), sha256: sha256(raw) };

  if (options.restore) {
    const { header, folded } = readSidecar(options.sidecar);
    const rebuilt = serialize(restore(JSON.parse(raw), folded));
    const matches = sha256(rebuilt) === header.ledgerSha256Before;
    const result = {
      mode: options.apply ? 'restore' : 'restore (dry run)',
      restored: folded.length, bytes: Buffer.byteLength(rebuilt, 'utf8'),
      reproducesOriginal: matches,
      expectedSha256: String(header.ledgerSha256Before).slice(0, 16),
      actualSha256: sha256(rebuilt).slice(0, 16)
    };
    if (!matches) throw new Error('restore did not reproduce the pre-compaction bytes; nothing was written');
    if (options.apply) applyUnderLedgerLock(options, before.sha256, { ledgerText: rebuilt });
    return result;
  }

  const document = JSON.parse(raw);
  const { document: compacted, folded, stats } = plan(document, options);
  const serialized = serialize(compacted);
  const header = {
    schemaVersion: SCHEMA_VERSION, kind: SIDECAR_KIND,
    createdAt: new Date().toISOString(),
    ledgerFile: path.basename(options.ledger),
    ledgerSha256Before: before.sha256,
    ledgerSha256After: sha256(serialized),
    records: stats.records, entries: folded.length,
    keepHead: options.keepHead, keepTail: options.keepTail, foldRequest: options.foldRequest
  };
  const sidecar = sidecarLines(header, folded);

  const result = {
    mode: options.apply ? 'compact' : 'compact (dry run)',
    ledger: options.ledger, sidecar: options.sidecar,
    bytesBefore: before.bytes,
    bytesAfter: Buffer.byteLength(serialized, 'utf8'),
    sidecarBytes: Buffer.byteLength(sidecar, 'utf8'),
    ...stats
  };
  result.bytesSaved = result.bytesBefore - result.bytesAfter;
  result.percentSaved = Number((result.bytesSaved / result.bytesBefore * 100).toFixed(2));
  if (options.apply) applyUnderLedgerLock(options, before.sha256, { ledgerText: serialized, sidecarText: sidecar });
  return result;
}

module.exports = { plan, restore, serialize, readSidecar, sidecarLines, run, sha256, protectedDecisionIndexes, protectedHistoryIndexes, INTERPRETATION_PREFIX, SIDECAR_KIND };

if (require.main === module) {
  try {
    const result = run(process.argv.slice(2));
    if (result.mode.includes('dry run')) console.log('DRY RUN -- nothing was written.');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`ledger-compact: ${error.message}`);
    process.exitCode = 1;
  }
}
