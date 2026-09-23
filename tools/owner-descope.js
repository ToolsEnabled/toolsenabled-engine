#!/usr/bin/env node
'use strict';

// RECORD THE DROPPING OF SOMETHING THE OWNER ASKED FOR.
//
// The worked example, 2026-08-11: a lane removed the $350 USPTO trademark
// filing from the owner's purchase list because "$350 alone breaks his own
// $100/day cap". The cap was never his -- it traces to the repo's ROOT commit,
// Co-Authored-By an AI agent. His real requirement was deleted to satisfy an
// invented one, and NO RECORD ANYWHERE said a requirement had been deleted.
//
// The problem is not that a lane said no. Lanes must be able to defer, narrow
// and drop work. The problem is that it happened INVISIBLY and on borrowed
// authority. This tool makes the first impossible and the second loud.
//
// It writes to reports/OWNER-DESCOPE-JOURNAL.json -- a SEPARATE file from the
// ledger, deliberately. The ledger is ~1 MB and contended by roughly ten lanes;
// putting descope records in it would make recording a descope fail exactly
// when the fleet is busiest, which is the failure mode being fixed elsewhere in
// this same tree. A small dedicated file with its own lock keeps this write
// cheap and independent.
//
// Usage:
//   node tools/owner-descope.js \
//     --request-id R1200 \
//     --requirement "the $350 USPTO trademark filing, 1 class" \
//     --action dropped|deferred|narrowed|replaced \
//     --reason "why, substantively" \
//     --decided-by "purchase-list-lane" \
//     [--constraint-name "config/toolsenabled.policy.json limits.defaultDailySpendUsd"] \
//     [--constraint-value "100"] \
//     [--constraint-source "commit 02b27ac, Co-Authored-By an AI agent"] \
//     [--restore-condition "when he approves the spend"]
//
//   node tools/owner-descope.js --list            show the journal
//   node tools/owner-descope.js --pending-review  only those needing his decision
//
// Exit 0 recorded, 3 recorded AND needs the owner's decision, 1 refused, 2 error.

const fs = require('node:fs');
const path = require('node:path');

const { buildDescopeRecord, pendingOwnerReview, summarizeDescopes } = require('../src/lib/owner-requirement-descope');
const { provenanceClassOf } = require('../src/lib/owner-request-provenance');
const { acquireLock } = require('../src/lib/process-claim-lock');

const ROOT = path.resolve(__dirname, '..');
const LEDGER_FILE = path.join(ROOT, 'reports', 'OWNER-REQUEST-LEDGER.json');
const JOURNAL_FILE = path.join(ROOT, 'reports', 'OWNER-DESCOPE-JOURNAL.json');

const KNOWN_FLAGS = new Set([
  'request-id', 'requirement', 'action', 'reason', 'decided-by',
  'constraint-name', 'constraint-value', 'constraint-source', 'restore-condition', 'journal'
]);

function parseArgs(argv) {
  const out = {};
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === '--list' || token === '--pending-review' || token === '--json' || token === '--help') {
      out[token.slice(2)] = true;
      index += 1;
      continue;
    }
    if (typeof token !== 'string' || !token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!KNOWN_FLAGS.has(key)) throw new Error(`Unknown flag: --${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    out[key] = value;
    index += 2;
  }
  return out;
}

function readJournal(file) {
  if (!fs.existsSync(file)) {
    return {
      $comment: 'Every requirement an agent dropped, deferred, narrowed or replaced, and on whose '
        + 'authority. Created because the $350 trademark filing was removed from the owner\'s '
        + 'purchase list invisibly, citing a spend cap he never set.',
      schemaVersion: 1,
      records: []
    };
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.records)) throw new Error(`${file} is malformed: records must be an array.`);
  return data;
}

function readLedgerEntry(requestId) {
  const data = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  if (!Array.isArray(data.requests)) {
    throw new Error(`${LEDGER_FILE} is malformed: requests must be an array.`);
  }
  const entry = data.requests.find(candidate => candidate && candidate.id === requestId);
  if (!entry) {
    throw new Error(`Cannot establish provenance: ${requestId} is not present in ${LEDGER_FILE}.`);
  }
  return entry;
}

function nextDescopeId(records) {
  let max = 0;
  for (const record of records) {
    const match = /^D(\d+)$/.exec(String(record && record.descopeId || ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `D${max + 1}`;
}

function atomicWriteJournal(file, data) {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const temporary = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, serialized, 'utf8');
  JSON.parse(fs.readFileSync(temporary, 'utf8')); // validate the bytes on disk
  fs.renameSync(temporary, file);
}

function main(argv) {
  const args = parseArgs(argv);
  const journalFile = args.journal ? path.resolve(args.journal) : JOURNAL_FILE;

  if (args.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n')
      .filter(line => line.startsWith('//')).join('\n') + '\n');
    return 0;
  }

  if (args.list || args['pending-review']) {
    const journal = readJournal(journalFile);
    const records = args['pending-review'] ? pendingOwnerReview(journal.records) : journal.records;
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ summary: summarizeDescopes(journal.records), records }, null, 2)}\n`);
      return 0;
    }
    const summary = summarizeDescopes(journal.records);
    process.stdout.write(`${records.length} record(s); ${summary.requiringOwnerReview} need the owner's decision.\n\n`);
    for (const record of records) {
      process.stdout.write(
        `${record.descopeId}  ${record.requestId}  [${record.action}]${record.requiresOwnerReview ? '  ** NEEDS OWNER DECISION **' : ''}\n`
        + `  dropped: ${record.requirement}\n`
        + `  reason:  ${record.reason}\n`
        + `  by:      ${record.decidedBy} at ${record.decidedAt}\n`
        + (record.citedConstraint
          ? `  cited:   ${record.citedConstraint.name} (provenance: ${record.citedConstraint.provenanceClass})\n` : '')
        + '\n');
    }
    return 0;
  }

  const requestId = args['request-id'];
  if (!requestId) throw new Error('--request-id is required (or use --list / --pending-review).');

  // Resolve the requirement's provenance from the LEDGER, not from the caller.
  // A lane cannot understate what it is dropping in order to dodge the check.
  const requestEntry = readLedgerEntry(requestId);

  const citedConstraint = args['constraint-name']
    ? {
      name: args['constraint-name'],
      ...(args['constraint-value'] ? { value: args['constraint-value'] } : {}),
      ...(args['constraint-source'] ? { source: args['constraint-source'] } : {}),
      // Provenance of the CONSTRAINT is resolved the same way: if it names a
      // ledger request, that entry's class decides. A constraint that is just a
      // config value an agent chose has no owner provenance and stays
      // 'unclassified' -- which is what makes the trademark check fire.
      provenanceClass: /^R[0-9]/.test(args['constraint-name'])
        ? provenanceClassOf(readLedgerEntry(args['constraint-name'].split(/\s/)[0]))
        : 'unclassified'
    }
    : undefined;

  const lock = acquireLock(`${journalFile}.lock`);
  let record;
  try {
    const journal = readJournal(journalFile);
    record = buildDescopeRecord({
      descopeId: nextDescopeId(journal.records),
      requestId,
      requirement: args.requirement,
      action: args.action,
      reason: args.reason,
      decidedBy: args['decided-by'],
      ...(args['restore-condition'] ? { restoreCondition: args['restore-condition'] } : {}),
      ...(citedConstraint ? { citedConstraint } : {})
    }, { requestEntry });

    journal.records = [...journal.records, record];
    journal.updatedAt = new Date().toISOString();
    atomicWriteJournal(journalFile, journal);
  } finally {
    lock.release();
  }

  process.stdout.write(`Recorded ${record.descopeId}: ${record.action} "${record.requirement}" from ${record.requestId}.\n`);
  if (record.requiresOwnerReview) {
    // LOUD. This is the trademark pattern, and it must not read as routine.
    process.stderr.write(
      '\n*** THIS DESCOPE NEEDS THE OWNER\'S DECISION, NOT AN AGENT\'S ***\n'
      + `${record.ownerReviewReason}\n`
      + `Requirement provenance: ${record.requirementProvenance}\n`
      + `Cited constraint:       ${record.citedConstraint.name} (${record.citedConstraint.provenanceClass})\n`
      + 'Surface this to him rather than treating it as settled.\n\n');
    return 3;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`owner-descope refused: ${error && error.message}\n`);
    process.exitCode = error && /required|must|Unknown flag|Unexpected/.test(String(error.message)) ? 1 : 2;
  }
}

module.exports = Object.freeze({ nextDescopeId, readJournal });
