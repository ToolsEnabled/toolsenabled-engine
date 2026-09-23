#!/usr/bin/env node
'use strict';

// Advisory-only freshness check for reports/OPEN-GATES.md, invoked from
// .githooks/pre-push. See src/lib/open-gates-freshness.js for the shared
// verdict logic (also used by tools/agent-preflight.js).
//
// WHY ADVISORY, NOT BLOCKING. reports/OPEN-GATES.md is controller-serial
// (STANDING-ORDERS.md: shared ledger/report files are off-limits to the
// fleet); an ordinary lane cannot fix staleness in this file itself, only the
// controller can. A push-blocking gate over state that only one specific role
// may repair is the same shape .githooks/pre-push's own header already
// rejects for the territory/package/single-copy checks it runs -- it trains
// people to bypass the hook. So this reports loudly and always exits with a
// real code (see below) while the *hook* that calls it still exits 0.
//
// EXIT CODE CONTRACT (for the caller, and for tests/open-gates-freshness-check.js):
//   0  FRESH
//   1  STALE, INCOMPLETE, MISSING, or UNSTAMPED (an agent can fix all four by
//      running `node tools/ledger-query.js open --gates --write`)
//   1  INDETERMINATE (the live ledger's revision field could not be read, so
//      the digest cannot be confirmed fresh)
//
// INCOMPLETE is the shape axis: the digest's revision stamp is current but the
// file is missing a section the current renderer emits, so it was published by
// an older renderer. It exits 1 for the same reason STALE does -- an agent
// reading it at SESSION-BOOT is missing information that exists -- and it is
// named differently because the sentence a reader needs is different.
//
// Usage:
//   node tools/check-open-gates-freshness.js
//   node tools/check-open-gates-freshness.js --ledger <path> --digest <path>   (testing only)

const { checkOpenGatesFreshness } = require('../src/lib/open-gates-freshness');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--ledger') out.ledgerPath = argv[++i];
    else if (argv[i] === '--digest') out.digestPath = argv[++i];
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = checkOpenGatesFreshness(options);

  if (result.state === 'FRESH') {
    console.log(`  [open-gates] fresh -- reports/OPEN-GATES.md matches ledger revision ${result.liveRevision}.`);
    return 0;
  }
  if (result.state === 'INDETERMINATE') {
    console.log(`  [open-gates] INDETERMINATE -- ${result.message}`);
    return 1;
  }

  // Named separately from the revision verdicts: "stale" tells a reader to
  // expect missing DIRECTIVES, "incomplete" tells them to expect a missing
  // SECTION. Printing the same sentence for both would send them looking in
  // the wrong place.
  if (result.state === 'INCOMPLETE') {
    console.log('  [open-gates] reports/OPEN-GATES.md is fresh but STRUCTURALLY INCOMPLETE:');
    console.log(`  ${result.message}`);
    return 1;
  }

  console.log('  [open-gates] reports/OPEN-GATES.md is not fresh:');
  console.log(`  ${result.message}`);
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };
