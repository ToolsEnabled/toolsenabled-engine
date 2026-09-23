#!/usr/bin/env node
'use strict';

// tools/ledger-merge.js — durable union-merge for two diverged copies of
// reports/OWNER-REQUEST-LEDGER.json.
//
// Why this exists: the ledger diverged once between Machine A's retired tree
// and trunk, and was merged by a hand-written throwaway script that no longer
// exists. The next divergence would have had no tool. This is the durable,
// tested version of that merge.
//
// THE ONE INVARIANT THIS FILE EXISTS TO HOLD: the owner's words are never
// rewritten, truncated, reordered, or dropped. Every `verbatim` field and
// every gate `instruction` from BOTH inputs must survive into the output —
// exactly, or as a contiguous substring of a strictly longer capture of the
// same field (an append; nothing lost). If the merged result would lose even
// one, this tool REFUSES TO WRITE AT ALL (exit 5). That refusal is proven by
// tests/ledger-merge.js.
//
// Merge rules (per the owner-record conventions, precedent: R133/R133.1 on
// 2026-08-03):
//   - Union entries from both sides by id.
//   - Same id, identical content            -> one copy.
//   - Same id, one side's entry CONTAINS
//     the other's (append-only growth)      -> keep the longer side.
//   - Same id, genuinely different content  -> keep BOTH: --ours keeps the
//     plain id, --theirs is re-filed under the next free dotted id
//     (R133 -> R133.1) with a mergeNote naming the provenance. Content is
//     never altered; neither side is chosen over the other.
//   - A status flip (open -> done) is NOT containment and is deliberately
//     treated as a conflict: an automated merge adjudicating a status would
//     violate RECORD rule 2 ("never soften a status"), so both versions are
//     kept and a human resolves the pair.
//
// Usage:
//   node tools/ledger-merge.js --ours <path> --theirs <path> --out <path>
//        [--force] [--in-place] [--dry-run]
//        [--label-ours <name>] [--label-theirs <name>]
//
// Exit codes: 0 ok (or clean --dry-run) | 2 usage | 3 input read/shape |
//             4 output refusal (exists without --force / equals an input
//             without --in-place) | 5 VERBATIM-LOSS REFUSAL.

const fs = require('fs');
const path = require('path');
const { acquireLock } = require('../src/lib/process-claim-lock');

class LedgerMergeError extends Error {
  constructor(message, code = 'LEDGER_MERGE_ERROR', exitCode = 1) {
    super(message);
    this.name = 'LedgerMergeError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

// --- reading -----------------------------------------------------------------

function readLedgerDocument(ledgerPath) {
  let raw;
  try {
    raw = fs.readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new LedgerMergeError(`Ledger file not found: ${ledgerPath}`, 'LEDGER_MERGE_INPUT_MISSING', 3);
    }
    throw new LedgerMergeError(`Failed to read ${ledgerPath}: ${error.message}`, 'LEDGER_MERGE_INPUT_UNREADABLE', 3);
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // Machine A files have carried a BOM before.
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LedgerMergeError(`Malformed JSON in ${ledgerPath}: ${error.message}`, 'LEDGER_MERGE_INPUT_MALFORMED', 3);
  }
  validateLedgerShape(parsed, ledgerPath);
  return parsed;
}

function validateLedgerShape(doc, label) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.requests)) {
    throw new LedgerMergeError(`Malformed ledger shape in ${label}: expected an object with a requests array.`, 'LEDGER_MERGE_INPUT_SHAPE', 3);
  }
  // controllerNotes is optional, but a present value must be readable as the
  // note list it claims to be. Treating a malformed value as [] would turn
  // "could not enumerate this side's notes" into the definite answer "this
  // side has no notes", allowing a merge (and its notesAppended count) to
  // report success after silently dropping that input.
  if (Object.prototype.hasOwnProperty.call(doc, 'controllerNotes') && !Array.isArray(doc.controllerNotes)) {
    throw new LedgerMergeError(`Malformed ledger shape in ${label}: controllerNotes must be an array when present.`, 'LEDGER_MERGE_INPUT_SHAPE', 3);
  }
  const seen = new Set();
  for (const entry of doc.requests) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new LedgerMergeError(`Malformed request entry in ${label}: every request needs a non-empty string id.`, 'LEDGER_MERGE_INPUT_SHAPE', 3);
    }
    if (seen.has(entry.id)) {
      // A duplicate id inside ONE side makes "union by id" ambiguous. Guessing
      // which duplicate is canonical is exactly the silent adjudication this
      // tool refuses to perform, so it stops instead.
      throw new LedgerMergeError(`Duplicate id ${entry.id} within ${label}: refusing an ambiguous union.`, 'LEDGER_MERGE_DUPLICATE_ID', 3);
    }
    seen.add(entry.id);
  }
}

// --- structural comparison ---------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

// contains(a, b): would keeping only `a` lose nothing that `b` holds?
//   strings  -> b must appear as a contiguous substring of a (append growth)
//   arrays   -> b's elements must appear, in order, as a subsequence of a's
//               (append-only logs: captureLog, gates, controllerNotes)
//   objects  -> every field of b must be present in a and contained by it
// Anything else (status flips, number changes, type changes) is NOT
// containment and falls to the keep-both conflict path.
function contains(a, b) {
  if (deepEqual(a, b)) return true;
  if (typeof a === 'string' && typeof b === 'string') return a.includes(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    let i = 0;
    for (const item of b) {
      while (i < a.length && !contains(a[i], item)) i += 1;
      if (i >= a.length) return false;
      i += 1;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const k of Object.keys(b)) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) return false;
      if (!contains(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function entrySupersedes(winner, loser) {
  return contains(winner, loser);
}

function stripKeys(entry, keys) {
  const out = {};
  for (const k of Object.keys(entry)) {
    if (!keys.includes(k)) out[k] = entry[k];
  }
  return out;
}

function contentEquivalent(a, b) {
  // Same content, ignoring identity and merge provenance. This is how a
  // previously re-filed entry (R133.1 = other side's R133 + mergeNote) is
  // recognized, which makes re-running the merge idempotent.
  return deepEqual(stripKeys(a, ['id', 'mergeNote']), stripKeys(b, ['id', 'mergeNote']));
}

// --- the protected-string invariant ------------------------------------------

const PROTECTED_KEYS = new Set(['verbatim', 'instruction']);

function collectProtectedStrings(node, out, trail) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) collectProtectedStrings(node[i], out, trail);
    return out;
  }
  if (isPlainObject(node)) {
    const where = typeof node.id === 'string' ? node.id : trail;
    for (const k of Object.keys(node)) {
      if (PROTECTED_KEYS.has(k) && typeof node[k] === 'string' && node[k].length > 0) {
        out.push({ kind: k, value: node[k], where });
      }
      collectProtectedStrings(node[k], out, where);
    }
  }
  return out;
}

function assertNoProtectedLoss(inputDocs, mergedDoc) {
  const survivors = collectProtectedStrings(mergedDoc, [], '(root)');
  const byKind = new Map();
  for (const s of survivors) {
    if (!byKind.has(s.kind)) byKind.set(s.kind, []);
    byKind.get(s.kind).push(s.value);
  }
  const losses = [];
  for (const doc of inputDocs) {
    for (const p of collectProtectedStrings(doc, [], '(root)')) {
      const pool = byKind.get(p.kind) || [];
      const survives = pool.some((v) => v === p.value || v.includes(p.value));
      if (!survives) losses.push(p);
    }
  }
  if (losses.length > 0) {
    const detail = losses
      .slice(0, 20)
      .map((l) => `  ${l.kind} at ${l.where}: "${l.value.slice(0, 80).replace(/\n/g, ' ')}${l.value.length > 80 ? '…' : ''}"`)
      .join('\n');
    throw new LedgerMergeError(
      `REFUSING TO WRITE: ${losses.length} protected string(s) from the inputs would not survive the merge. ` +
      `The owner's words are the integrity property this file exists to hold; nothing was written.\n${detail}` +
      (losses.length > 20 ? `\n  … and ${losses.length - 20} more` : ''),
      'LEDGER_MERGE_VERBATIM_LOSS',
      5
    );
  }
}

// --- merge -------------------------------------------------------------------

function todayString(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function nextDottedId(baseId, takenIds) {
  for (let n = 1; n <= 10000; n += 1) {
    const candidate = `${baseId}.${n}`;
    if (!takenIds.has(candidate)) return candidate;
  }
  throw new LedgerMergeError(`Could not allocate a dotted id for ${baseId}.`, 'LEDGER_MERGE_ID_EXHAUSTED', 1);
}

function refileEntry(entry, dottedId, oursLabel, theirsLabel, today) {
  const body = stripKeys(entry, ['id']);
  const note = `Re-filed from ${entry.id} on ${today} by tools/ledger-merge.js: ` +
    `${oursLabel} and ${theirsLabel} each allocated ${entry.id} to different content. ` +
    `Both are preserved; neither was altered. This is ${theirsLabel}'s entry, byte-for-byte, under a new id.`;
  const out = { id: dottedId };
  for (const k of Object.keys(body)) {
    if (k === 'mergeNote') continue;
    out[k] = body[k];
  }
  out.mergeNote = typeof entry.mergeNote === 'string' && entry.mergeNote.length > 0
    ? `${entry.mergeNote} ${note}`
    : note;
  return out;
}

function mergeLedgerDocuments(oursDoc, theirsDoc, options = {}) {
  const oursLabel = options.oursLabel || 'ours';
  const theirsLabel = options.theirsLabel || 'theirs';
  const today = options.today || todayString();

  if (oursDoc.schemaVersion !== theirsDoc.schemaVersion) {
    throw new LedgerMergeError(
      `schemaVersion mismatch (${oursLabel}=${oursDoc.schemaVersion}, ${theirsLabel}=${theirsDoc.schemaVersion}); refusing to guess a migration.`,
      'LEDGER_MERGE_SCHEMA_MISMATCH', 3
    );
  }

  const report = {
    oursCount: oursDoc.requests.length,
    theirsCount: theirsDoc.requests.length,
    identical: 0,
    oursSuperseded: 0,   // theirs contained ours -> theirs kept, same id
    theirsSuperseded: 0, // ours contained theirs -> ours kept, same id
    appendedNew: 0,      // id existed only in theirs
    refiled: [],         // conflicts re-filed under dotted ids
    alreadyPresent: 0,   // conflict content already present in ours' dotted family
    upgradedSiblings: 0, // theirs strictly grew an existing dotted sibling
    notesAppended: 0,
    changed: false
  };

  // Ours passes through in order and untouched unless a rule above says
  // otherwise. Entry objects are reused, never rebuilt, so field order and
  // content are preserved exactly.
  const result = oursDoc.requests.slice();
  const indexById = new Map();
  result.forEach((entry, i) => indexById.set(entry.id, i));

  const familyOf = (baseId) => result.filter((e) => e.id === baseId || e.id.startsWith(`${baseId}.`));

  const handleConflict = (theirsEntry) => {
    // Was this exact content already merged once (as a dotted re-file, or
    // under any family id)? Then re-merging must not duplicate it.
    for (const member of familyOf(theirsEntry.id)) {
      if (contentEquivalent(member, theirsEntry) || entrySupersedes(stripKeys(member, ['mergeNote']), stripKeys(theirsEntry, ['id', 'mergeNote']))) {
        report.alreadyPresent += 1;
        return;
      }
    }
    // Did theirs strictly grow an entry we already hold under a dotted id?
    for (const member of familyOf(theirsEntry.id)) {
      if (member.id !== theirsEntry.id &&
          entrySupersedes(stripKeys(theirsEntry, ['id', 'mergeNote']), stripKeys(member, ['id', 'mergeNote']))) {
        const upgraded = { id: member.id };
        for (const k of Object.keys(stripKeys(theirsEntry, ['id', 'mergeNote']))) upgraded[k] = theirsEntry[k];
        if (typeof member.mergeNote === 'string') upgraded.mergeNote = member.mergeNote;
        result[indexById.get(member.id)] = upgraded;
        report.upgradedSiblings += 1;
        report.changed = true;
        return;
      }
    }
    const taken = new Set(result.map((e) => e.id));
    const dottedId = nextDottedId(theirsEntry.id, taken);
    const refiled = refileEntry(theirsEntry, dottedId, oursLabel, theirsLabel, today);
    indexById.set(dottedId, result.length);
    result.push(refiled);
    report.refiled.push({ from: theirsEntry.id, to: dottedId });
    report.changed = true;
  };

  for (const theirsEntry of theirsDoc.requests) {
    const idx = indexById.get(theirsEntry.id);
    if (idx === undefined) {
      indexById.set(theirsEntry.id, result.length);
      result.push(theirsEntry);
      report.appendedNew += 1;
      report.changed = true;
      continue;
    }
    const oursEntry = result[idx];
    if (deepEqual(oursEntry, theirsEntry)) {
      report.identical += 1;
      continue;
    }
    if (entrySupersedes(oursEntry, theirsEntry)) {
      report.theirsSuperseded += 1; // ours already holds everything theirs has
      continue;
    }
    if (entrySupersedes(theirsEntry, oursEntry)) {
      result[idx] = theirsEntry; // theirs is the append-grown longer copy
      report.oursSuperseded += 1;
      report.changed = true;
      continue;
    }
    handleConflict(theirsEntry);
  }

  // controllerNotes: ours' order, then any theirs note not already present.
  const oursNotes = Array.isArray(oursDoc.controllerNotes) ? oursDoc.controllerNotes.slice() : [];
  const theirsNotes = Array.isArray(theirsDoc.controllerNotes) ? theirsDoc.controllerNotes : [];
  for (const note of theirsNotes) {
    if (!oursNotes.some((n) => deepEqual(n, note))) {
      oursNotes.push(note);
      report.notesAppended += 1;
      report.changed = true;
    }
  }

  // Rebuild the document in ours' own top-level key order.
  const merged = {};
  for (const k of Object.keys(oursDoc)) {
    if (k === 'requests') merged.requests = result;
    else if (k === 'controllerNotes') merged.controllerNotes = oursNotes;
    else merged[k] = oursDoc[k];
  }
  if (!Object.prototype.hasOwnProperty.call(merged, 'controllerNotes') && oursNotes.length > 0) {
    merged.controllerNotes = oursNotes;
  }
  merged.revision = report.changed
    ? Math.max(Number(oursDoc.revision) || 0, Number(theirsDoc.revision) || 0) + 1
    : oursDoc.revision;
  if (report.changed) merged.updatedAt = today;

  report.mergedCount = result.length;
  return { doc: merged, report };
}

// --- writing -----------------------------------------------------------------

function writeMergedDocument(outPath, mergedDoc, inputDocs, options = {}) {
  // The invariant gate runs BEFORE any byte reaches disk. A refusal leaves no
  // partial file, no tmp file, and no mutated output.
  assertNoProtectedLoss(inputDocs, mergedDoc);
  const serialized = `${JSON.stringify(mergedDoc, null, 2)}\n`;
  // Belt and braces: re-parse what will actually be written and run the gate
  // again against the serialized form, so a serialization bug cannot slip
  // a loss past the object-level check.
  assertNoProtectedLoss(inputDocs, JSON.parse(serialized));

  if (options.backupPath) {
    fs.copyFileSync(outPath, options.backupPath);
  }
  const tmpPath = `${outPath}.tmp-${process.pid}`;
  const displacedPath = `${tmpPath}.previous`;
  fs.writeFileSync(tmpPath, serialized, 'utf8');
  try {
    if (fs.existsSync(outPath)) fs.renameSync(outPath, displacedPath);
    fs.renameSync(tmpPath, outPath);
    if (fs.existsSync(displacedPath)) { try { fs.rmSync(displacedPath); } catch (_) { /* best-effort cleanup after successful replacement */ } }
  } catch (error) {
    try { fs.rmSync(tmpPath); } catch (_) { /* leave nothing behind on a best-effort basis */ }
    if (fs.existsSync(displacedPath) && !fs.existsSync(outPath)) {
      try { fs.renameSync(displacedPath, outPath); } catch (_) { /* preserve the displaced copy for manual recovery */ }
    }
    throw new LedgerMergeError(`Failed to write ${outPath}: ${error.message}`, 'LEDGER_MERGE_WRITE_FAILED', 4);
  }
  return outPath;
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = { force: false, inPlace: false, dryRun: false };
  const flags = argv.slice(2);
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    const needValue = () => {
      i += 1;
      if (i >= flags.length) throw new LedgerMergeError(`${flag} requires a value.`, 'LEDGER_MERGE_USAGE', 2);
      return flags[i];
    };
    switch (flag) {
      case '--ours': args.ours = needValue(); break;
      case '--theirs': args.theirs = needValue(); break;
      case '--out': args.out = needValue(); break;
      case '--label-ours': args.labelOurs = needValue(); break;
      case '--label-theirs': args.labelTheirs = needValue(); break;
      case '--force': args.force = true; break;
      case '--in-place': args.inPlace = true; break;
      case '--dry-run': args.dryRun = true; break;
      default:
        throw new LedgerMergeError(`Unknown flag: ${flag}`, 'LEDGER_MERGE_USAGE', 2);
    }
  }
  if (!args.ours || !args.theirs) {
    throw new LedgerMergeError('Usage: node tools/ledger-merge.js --ours <path> --theirs <path> --out <path> [--force|--in-place|--dry-run]', 'LEDGER_MERGE_USAGE', 2);
  }
  if (!args.dryRun && !args.out) {
    throw new LedgerMergeError('--out is required unless --dry-run is given.', 'LEDGER_MERGE_USAGE', 2);
  }
  return args;
}

function renderReport(report, dryRun) {
  const lines = [];
  lines.push(`${dryRun ? '[dry-run] ' : ''}ours=${report.oursCount} theirs=${report.theirsCount} merged=${report.mergedCount}`);
  lines.push(`identical=${report.identical} ours-kept-longer=${report.theirsSuperseded} theirs-kept-longer=${report.oursSuperseded} new-from-theirs=${report.appendedNew}`);
  lines.push(`conflicts-refiled=${report.refiled.length}${report.refiled.length ? ' [' + report.refiled.map((r) => `${r.from}->${r.to}`).join(', ') + ']' : ''} already-present=${report.alreadyPresent} upgraded-siblings=${report.upgradedSiblings} notes-appended=${report.notesAppended}`);
  lines.push(`changed=${report.changed}`);
  return lines.join('\n');
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const oursResolved = path.resolve(args.ours);
  const theirsResolved = path.resolve(args.theirs);
  const outResolved = args.out ? path.resolve(args.out) : null;
  let backupPath;
  if (!args.dryRun && outResolved === theirsResolved) {
    throw new LedgerMergeError('Refusing to overwrite --theirs: write over --ours (with --in-place) or to a new path.', 'LEDGER_MERGE_OUTPUT_REFUSED', 4);
  }
  if (!args.dryRun && outResolved === oursResolved) {
    if (!args.inPlace) {
      throw new LedgerMergeError('--out equals --ours; pass --in-place to allow it (a timestamped .bak is made first).', 'LEDGER_MERGE_OUTPUT_REFUSED', 4);
    }
    backupPath = `${outResolved}.pre-merge-${todayString()}-${Date.now()}.bak`;
  } else if (!args.dryRun && fs.existsSync(outResolved) && !args.force) {
    throw new LedgerMergeError(`Output already exists: ${args.out} (pass --force to overwrite).`, 'LEDGER_MERGE_OUTPUT_REFUSED', 4);
  }

  let lock;
  if (backupPath) {
    try {
      lock = acquireLock(`${oursResolved}.lock`);
    } catch {
      throw new LedgerMergeError(
        'The owner request ledger is busy; merge refused rather than racing its writer.',
        'LEDGER_MERGE_LOCKED',
        4
      );
    }
  }
  try {
    // A writer landing after the read but before replacement would otherwise
    // disappear silently, so the lock covers every read, merge, and rename.
    const oursDoc = readLedgerDocument(args.ours);
    const theirsDoc = readLedgerDocument(args.theirs);
    const oursLabel = args.labelOurs || path.basename(path.dirname(path.dirname(oursResolved))) || 'ours';
    const theirsLabel = args.labelTheirs || path.basename(path.dirname(path.dirname(theirsResolved))) || 'theirs';
    const { doc, report } = mergeLedgerDocuments(oursDoc, theirsDoc, { oursLabel, theirsLabel });

    if (args.dryRun) {
      // The invariant is checked even on a dry run, so a merge that WOULD lose
      // owner words reports the refusal instead of a healthy-looking summary.
      assertNoProtectedLoss([oursDoc, theirsDoc], doc);
      process.stdout.write(`${renderReport(report, true)}\n`);
      return 0;
    }

    writeMergedDocument(outResolved, doc, [oursDoc, theirsDoc], { backupPath });
    process.stdout.write(`${renderReport(report, false)}\nwrote ${outResolved}${backupPath ? `\nbackup ${backupPath}` : ''}\n`);
    return 0;
  } finally {
    lock?.release();
  }
}

module.exports = {
  LedgerMergeError,
  readLedgerDocument,
  validateLedgerShape,
  deepEqual,
  contains,
  entrySupersedes,
  contentEquivalent,
  collectProtectedStrings,
  assertNoProtectedLoss,
  mergeLedgerDocuments,
  refileEntry,
  nextDottedId,
  writeMergedDocument,
  parseArgs,
  todayString,
  main
};

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${error.code || 'LEDGER_MERGE_ERROR'}: ${error.message}\n`);
      process.exitCode = error instanceof LedgerMergeError ? error.exitCode : 1;
    }
  );
}
