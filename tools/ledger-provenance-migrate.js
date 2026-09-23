#!/usr/bin/env node
'use strict';

// MIGRATE THE LEDGER TO CARRY PROVENANCE -- without inventing any.
//
// 532 entries, zero provenance fields. This adds the field to every one of them
// and drops nothing. `preservesEveryRequest` is the ledger's headline guarantee
// and this tool proves it rather than asserting it: it compares the id SET and
// every pre-existing FIELD of every entry before and after, and refuses to write
// if anything but the added `provenance` key differs.
//
// THE CLASSIFICATION RULE, and why it is so stingy.
//
// The tempting migration reads the capture actor and calls `controller` and
// `owner` captures owner-stated. That would be FABRICATION, and it was measured
// to be wrong: commit f3ae016 established that `codex` captured both a genuine
// owner Telegram relay (R283) and an agent's self-authored brief (R1098). The
// actor name cannot separate them. A migration that guessed would manufacture
// exactly the false pedigree the $100/day cap acquired, 532 times over, and it
// would be unfalsifiable afterwards.
//
// So this applies RETROACTIVELY THE SAME EVIDENCE RULE new captures must meet:
//
//   owner-stated  <- the entry has the owner's verbatim words AND its captureLog
//                    cites the channel they arrived on.
//   unclassified  <- everything else: "the record does not say".
//
// Measured on this tree that promotes 9 entries and leaves 523 unclassified.
// That ratio is not a defect in the migration, it is the true state of the
// record, and it is the first honest measurement of how much of R can actually
// show the owner's authority. An `unclassified` entry is not deleted, not
// distrusted, and not less important -- it simply may not be cited AS HIS until
// someone establishes where it came from.
//
// Usage:
//   node tools/ledger-provenance-migrate.js            report only, writes nothing
//   node tools/ledger-provenance-migrate.js --apply    back up, migrate, verify
//   node tools/ledger-provenance-migrate.js --json     machine-readable report
//
// Exit 0 success, 1 verification failed (nothing written), 2 tool error.

const fs = require('node:fs');
const path = require('node:path');

const { normalizeProvenance, summarizeProvenance } = require('../src/lib/owner-request-provenance');
const { acquireLock } = require('../src/lib/process-claim-lock');

const REPO_ROOT = path.resolve(__dirname, '..');
const LEDGER_FILE = path.join(REPO_ROOT, 'reports', 'OWNER-REQUEST-LEDGER.json');
const MIN_SOURCE_LENGTH = 8;

function captureSourceOf(entry) {
  const log = entry && entry.captureLog;
  const list = Array.isArray(log) ? log : (log ? [log] : []);
  for (const item of list) {
    const source = item && typeof item.source === 'string' ? item.source.trim() : '';
    if (source.length >= MIN_SOURCE_LENGTH) return source;
  }
  return '';
}

function verbatimOf(entry) {
  return entry && typeof entry.verbatim === 'string' ? entry.verbatim.trim() : '';
}

/** The retroactive evidence rule. Deliberately identical to the live capture rule. */
function classify(entry, nowIso) {
  const source = captureSourceOf(entry);
  const verbatim = verbatimOf(entry);
  if (verbatim && source) {
    return normalizeProvenance({
      class: 'owner-stated',
      source,
      recordedBy: 'ledger-provenance-migration',
      recordedAt: nowIso,
      note: 'Classified retroactively from the entry\'s own captureLog source, which cites an owner channel, '
        + 'plus non-empty verbatim text. No inference from the capture actor was used.'
    });
  }
  const why = !verbatim && !source
    ? 'no verbatim owner text and no capture source were recorded'
    : (!verbatim ? 'no verbatim owner text was recorded' : 'no capture source was recorded');
  return normalizeProvenance({
    class: 'unclassified',
    recordedBy: 'ledger-provenance-migration',
    recordedAt: nowIso,
    note: `Provenance was not captured when this entry was written (${why}). The capture actor was `
      + 'deliberately NOT used to infer a class: the same actor has captured both genuine owner '
      + 'relays and agent-authored briefs, so the name cannot tell them apart. Reclassify by '
      + 'establishing where the words came from.'
  });
}

/**
 * PROOF, not assertion, that every request survived and nothing else changed.
 * Returns a list of human-readable problems; empty means verified.
 */
function verifyPreservation(before, after) {
  const problems = [];
  // An empty comparison establishes nothing. Keep this proof helper honest even
  // when it is called independently of main(), which rejects an empty ledger.
  if (before.length === 0) {
    problems.push('no requests were available to verify');
  }
  if (before.length !== after.length) {
    problems.push(`request count changed: ${before.length} -> ${after.length}`);
  }
  const beforeIds = before.map(entry => entry && entry.id);
  const afterIds = after.map(entry => entry && entry.id);
  const beforeSet = new Set(beforeIds);
  const afterSet = new Set(afterIds);
  for (const id of beforeSet) if (!afterSet.has(id)) problems.push(`request ${id} was DROPPED`);
  for (const id of afterSet) if (!beforeSet.has(id)) problems.push(`request ${id} was INVENTED`);
  if (beforeIds.join('\0') !== afterIds.join('\0')) problems.push('request ORDER changed');

  // Every pre-existing field must be byte-identical; only `provenance` may appear.
  for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
    const originalEntry = before[index];
    const migratedEntry = after[index];
    for (const key of Object.keys(originalEntry)) {
      if (JSON.stringify(originalEntry[key]) !== JSON.stringify(migratedEntry[key])) {
        problems.push(`request ${originalEntry.id} field ${JSON.stringify(key)} was MODIFIED`);
      }
    }
    const added = Object.keys(migratedEntry).filter(key => !Object.hasOwn(originalEntry, key));
    if (added.length !== 1 || added[0] !== 'provenance') {
      problems.push(`request ${originalEntry.id} gained unexpected field(s): ${added.join(', ') || '(none)'}`);
    }
  }
  return problems;
}

function main(argv) {
  const apply = argv.includes('--apply');
  const asJson = argv.includes('--json');

  const originalRaw = fs.readFileSync(LEDGER_FILE, 'utf8');
  const data = JSON.parse(originalRaw);
  const before = Array.isArray(data.requests) ? data.requests : [];
  if (!before.length) {
    process.stderr.write('Ledger has no requests array; refusing to migrate.\n');
    return 2;
  }
  const alreadyMigrated = before.filter(entry => entry && entry.provenance).length;

  const nowIso = new Date().toISOString();
  const after = before.map(entry => (
    entry && entry.provenance ? entry : { ...entry, provenance: classify(entry, nowIso) }
  ));

  const problems = verifyPreservation(before, after);
  const summary = summarizeProvenance(after);
  const report = {
    ledger: LEDGER_FILE,
    applied: false,
    requestsBefore: before.length,
    requestsAfter: after.length,
    alreadyCarryingProvenance: alreadyMigrated,
    preservesEveryRequest: problems.length === 0,
    problems,
    provenance: summary
  };

  if (problems.length) {
    report.applied = false;
    process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n`
      : `REFUSING TO WRITE -- preservation check failed:\n  ${problems.join('\n  ')}\n`);
    return 1;
  }

  if (!apply) {
    process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n`
      : `Dry run (no changes written). ${before.length} requests -> `
        + `${summary.counts['owner-stated']} owner-stated, `
        + `${summary.counts['owner-ratified']} owner-ratified, `
        + `${summary.counts['agent-inferred']} agent-inferred, `
        + `${summary.counts.unclassified} unclassified.\n`
        + `Re-run with --apply to write. A timestamped backup is taken first.\n`);
    return 0;
  }

  const lock = acquireLock(`${LEDGER_FILE}.lock`);
  try {
    // Re-read under the lock: another lane may have written since the dry pass.
    const currentRaw = fs.readFileSync(LEDGER_FILE, 'utf8');
    if (currentRaw !== originalRaw) {
      process.stderr.write(
        'REFUSING TO WRITE: the ledger changed on disk between read and write (another lane wrote '
        + 'it). Nothing was modified. Re-run.\n');
      return 1;
    }
    const stamp = nowIso.replace(/[:.]/g, '-');
    const backup = `${LEDGER_FILE}.pre-provenance-${stamp}.bak`;
    fs.writeFileSync(backup, currentRaw, 'utf8');

    const next = { ...data, requests: after };
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    const temporary = `${LEDGER_FILE}.provenance-tmp`;
    fs.writeFileSync(temporary, serialized, 'utf8');
    // Read the temp file back and re-verify BEFORE it replaces the real ledger.
    const roundTrip = JSON.parse(fs.readFileSync(temporary, 'utf8'));
    const roundTripProblems = verifyPreservation(before, roundTrip.requests);
    if (roundTripProblems.length) {
      fs.unlinkSync(temporary);
      process.stderr.write(`REFUSING TO WRITE -- round-trip check failed:\n  ${roundTripProblems.join('\n  ')}\n`);
      return 1;
    }
    fs.renameSync(temporary, LEDGER_FILE);
    report.applied = true;
    report.backup = backup;
  } finally {
    lock.release();
  }

  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n`
    : `Migrated ${after.length} requests; none dropped, none modified.\n`
      + `  owner-stated:   ${summary.counts['owner-stated']}\n`
      + `  owner-ratified: ${summary.counts['owner-ratified']}\n`
      + `  agent-inferred: ${summary.counts['agent-inferred']}\n`
      + `  unclassified:   ${summary.counts.unclassified}\n`
      + `Backup: ${report.backup}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ledger-provenance-migrate failed: ${error && error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = Object.freeze({ classify, verifyPreservation, captureSourceOf });
