#!/usr/bin/env node
'use strict';

// DRAIN THE WRITE-AHEAD SPOOL INTO THE LEDGER, AND MAKE AN UNDRAINED DIRECTIVE
// IMPOSSIBLE TO IGNORE.
//
// tools/owner-capture.js now makes the owner's words durable BEFORE it touches
// the ledger (see src/lib/owner-capture-spool.js). That guarantees the words
// survive; it does not by itself put them where anyone reads. This tool is the
// second half: it replays every spooled capture that never reached the ledger,
// and -- in --check mode -- FAILS if any capture is still outstanding.
//
// The --check mode is the part that closes the original failure. A lane on
// 2026-08-11 hit a contended ledger, wrote the owner's directive somewhere else,
// and moved on; nothing alerted anyone, so the loss was discovered only when the
// owner noticed his instruction had not been carried out. An outstanding capture
// is now a red check with a file path and his verbatim words in it.
//
// It replays through owner-capture.js's own exported ledger functions rather
// than reimplementing the write, so the append-only verbatim invariant, the
// gate-authority guard and the provenance derivation are the SAME code in both
// paths. A reconciler with its own private idea of how to write an entry would
// be a second, less-tested way into the ledger -- exactly the kind of bypass
// this codebase keeps finding.
//
// Usage:
//   node tools/owner-capture-reconcile.js                 drain the default ledger's spool
//   node tools/owner-capture-reconcile.js --check         report only; exit 1 if anything is pending
//   node tools/owner-capture-reconcile.js --ledger <path> operate on a specific ledger
//   node tools/owner-capture-reconcile.js --json          machine-readable
//
// Exit 0 nothing outstanding, 1 captures still outstanding, 2 the tool failed.

const fs = require('node:fs');
const path = require('node:path');

const capture = require('./owner-capture');
const spool = require('../src/lib/owner-capture-spool');

function parseArgs(argv) {
  const out = { check: false, json: false, ledger: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--check') out.check = true;
    else if (token === '--json') out.json = true;
    else if (token === '--ledger') {
      out.ledger = argv[index + 1];
      if (!out.ledger) throw new Error('--ledger requires a value');
      index += 1;
    } else if (token === '--help' || token === '-h') out.help = true;
    else throw new Error(`Unexpected argument: ${token}`);
  }
  return out;
}

// One lock hold drains the whole queue. Taking and releasing the lock per record
// would reintroduce the contention this exists to survive: with ~10 lanes
// writing, a per-record lock could lose the lock mid-drain and leave half the
// queue outstanding for no reason.
function drain(ledgerFile, pending) {
  const results = [];
  const lock = capture.acquireLedgerLock(ledgerFile);
  try {
    for (const record of pending) {
      const handle = { name: record.name, file: record.file, record };
      try {
        const raw = fs.readFileSync(ledgerFile, 'utf8');
        const data = JSON.parse(raw);
        capture.validateLedgerShape(data, ledgerFile);
        const timestamp = new Date().toISOString();
        const gates = Array.isArray(record.gates) ? record.gates : [];
        const nextData = record.mode === 'new'
          ? capture.applyNewEntry(data, {
            id: record.id,
            text: record.text,
            interpretation: record.interpretation,
            status: record.status || 'open',
            scope: record.scope || 'global',
            threadId: record.threadId ?? null,
            gates,
            actor: record.actor,
            source: record.source ?? undefined,
            timestamp,
            provenanceClass: record.provenanceClass ?? undefined,
            proposal: record.proposal ?? undefined
          })
          : capture.applyAppend(data, {
            id: record.id,
            text: record.text,
            gates,
            actor: record.actor,
            source: record.source ?? undefined,
            timestamp
          });
        capture.atomicWriteLedgerWithBackup(ledgerFile, raw, nextData);
        spool.markReconciled(handle, { revision: nextData.revision });
        results.push({ name: record.name, id: record.id, outcome: 'reconciled', revision: nextData.revision });
      } catch (error) {
        // Stays pending, annotated. A record this tool cannot replay is a real
        // conflict needing a decision (most often: the id was taken while the
        // capture was stuck), and the right response is to keep the words and
        // say so, never to drop them to make the queue look clean.
        spool.annotatePending(handle, { code: error && error.code, message: error && error.message });
        results.push({
          name: record.name,
          id: record.id,
          outcome: 'still-outstanding',
          code: (error && error.code) || 'UNKNOWN',
          message: (error && error.message) || String(error),
          file: record.file
        });
      }
    }
  } finally {
    lock.release();
  }
  return results;
}

function describe(record) {
  const words = String(record.text || '').replace(/\s+/g, ' ').trim();
  return `${record.name}\n      id=${record.id} mode=${record.mode} actor=${record.actor} spooledAt=${record.spooledAt}`
    + `\n      words: "${words.slice(0, 160)}${words.length > 160 ? '...' : ''}"`
    + `\n      file:  ${record.file}`;
}

// listPending is a gate input: an unreadable directory or record must not be
// indistinguishable from an empty queue. The spool library's tolerant reader is
// useful to best-effort consumers, but this reconciler promises that "clean"
// means every pending record was actually measured.
function listPendingStrict(ledgerFile) {
  const directory = spool.pendingDirectory(ledgerFile);
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    // A spool directory is created by the first capture, so ENOENT establishes
    // that no capture has ever been placed in this ledger's queue. Every other
    // failure leaves the queue unknown and must refuse the clean result.
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  return names
    .filter((name) => name.endsWith('.json') && !name.endsWith('.tmp'))
    .sort()
    .map((name) => {
      const file = path.join(directory, name);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Invalid pending owner-capture record: ${file}`);
      }
      return { ...parsed, file };
    });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node tools/owner-capture-reconcile.js [--check] [--ledger <path>] [--json]\n');
    return;
  }
  const ledgerFile = args.ledger ? path.resolve(args.ledger) : capture.DEFAULT_LEDGER_FILE;
  if (!fs.existsSync(ledgerFile)) {
    process.stderr.write(`owner-capture-reconcile: no ledger at ${ledgerFile}\n`);
    process.exitCode = 2;
    return;
  }

  const pending = listPendingStrict(ledgerFile);
  const results = args.check ? [] : drain(ledgerFile, pending);
  const outstanding = listPendingStrict(ledgerFile);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ledgerFile,
      mode: args.check ? 'check' : 'drain',
      pendingBefore: pending.length,
      reconciled: results.filter((r) => r.outcome === 'reconciled').length,
      outstanding: outstanding.length,
      results,
      outstandingRecords: outstanding.map((r) => ({ name: r.name, id: r.id, spooledAt: r.spooledAt, file: r.file }))
    }, null, 2)}\n`);
  } else if (outstanding.length === 0) {
    process.stdout.write(`Owner-capture spool: clean. ${results.filter((r) => r.outcome === 'reconciled').length} replayed, `
      + `0 outstanding.\n  Ledger: ${ledgerFile}\n`);
  } else {
    process.stdout.write(
      `OWNER DIRECTIVES CAPTURED BUT NOT IN THE LEDGER -- ${outstanding.length} outstanding.\n\n`
      + 'These are the owner\'s words. They are durable on disk and they are NOT in the request\n'
      + 'ledger, so nothing that reads the ledger can see them. This is the state that let a\n'
      + 'directive be lost on 2026-08-11.\n\n'
    );
    for (const record of outstanding) process.stdout.write(`  ${describe(record)}\n\n`);
    process.stdout.write(args.check
      ? 'Replay them: node tools/owner-capture-reconcile.js --ledger "' + ledgerFile + '"\n'
      : 'These could not be replayed automatically; each needs a decision. Do not delete them.\n');
  }

  process.exitCode = outstanding.length === 0 ? 0 : 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`owner-capture-reconcile failed: ${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
