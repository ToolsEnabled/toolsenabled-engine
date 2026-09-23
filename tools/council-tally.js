#!/usr/bin/env node
'use strict';

// Tally a council from an on-disk record.  Usage:
//   node tools/council-tally.js <recordDir> [--json]
//
// The record directory holds slate.json and one <seatId>.ballot.json per seat.
// Seats that never reported simply have no file; the tally reports items as
// UNDECIDED unless the missing seats could not have changed the outcome, which
// is what lets a council finish when a seat dies mid-run.

const fs = require('node:fs');
const path = require('node:path');
const { castBallot, correctPremise, sealSlate, tally } = require('../src/lib/council');

const args = process.argv.slice(2);
const recordDir = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');

if (!recordDir) {
  console.error('usage: council-tally.js <recordDir> [--json]');
  process.exit(2);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const record = readJson(path.join(recordDir, 'slate.json'));
let slate = sealSlate(record.slate);
for (const correction of record.corrections || []) {
  slate = correctPremise(slate, correction);
}

const ballots = fs
  .readdirSync(recordDir)
  .filter((f) => f.endsWith('.ballot.json'))
  .sort()
  .map((f) => {
    const raw = readJson(path.join(recordDir, f));
    try {
      return castBallot(slate, raw);
    } catch (error) {
      console.error(`refused ${f}: ${error.code} ${error.message}`);
      process.exitCode = 1;
      return null;
    }
  })
  .filter(Boolean);

// A refused ballot is not an absent ballot: its seat was observed, but its
// answer could not be established.  Do not publish a tally that silently
// treats that uncertainty as a non-report.
if (process.exitCode) {
  process.exit(process.exitCode);
}

const result = tally(slate, ballots);

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(process.exitCode || 0);
}

console.log(`council ${result.slateId} (revision ${result.revision})`);
console.log(`  convened under ${slate.convenedUnder}; tie rule ${result.tieRule}`);
console.log(`  ${result.reported} of ${result.seatCount} seats reported; majority is ${result.majority}\n`);

for (const item of result.items) {
  const tag = { PASSED: 'PASS', FAILED: 'fail', RESERVED_TO_OWNER: 'RSVD', UNDECIDED: '....' }[item.outcome];
  console.log(`  [${tag}] ${item.id}  ${item.title}`);
  console.log(`         ${item.decidedBy}`);
  if (item.corrections && item.corrections.length > 0) {
    for (const c of item.corrections) {
      console.log(`         CORRECTED by ${c.correctedBy}: ${c.correction}`);
    }
  }
}

if (result.supersededBallots.length > 0) {
  console.log(`\n  ballots cast under a superseded premise: ${result.supersededBallots.join(', ')}`);
  console.log('  (counted, but the seats answered the pre-correction text)');
}

console.log(`\n  passed:    ${result.passed.join(', ') || '(none)'}`);
console.log(`  failed:    ${result.failed.join(', ') || '(none)'}`);
console.log(`  reserved:  ${result.reserved.join(', ') || '(none)'}`);
console.log(`  undecided: ${result.undecided.join(', ') || '(none)'}`);
