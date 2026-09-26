#!/usr/bin/env node
'use strict';

// REFUSE A QUEUE ITEM WHOSE AUTHORITY DOES NOT EXIST, AND NAME EVERY DIRECTIVE
// THAT REACHED THE QUEUE NOWHERE.
//
// Run:  node tools/build-queue-provenance.js
//       node tools/build-queue-provenance.js --json
//       node tools/build-queue-provenance.js --orphans          (list them all)
//       node tools/build-queue-provenance.js --since R1150       (recent only)
//
// Exit codes: 0 clean · 6 provenance errors (phantom id / unverifiable owner
// claim) · 4 queue or ledger unreadable · 2 usage.
//
// Reads the queue through src/lib/build-queue-corpus.js so the root file AND
// every package slice it declares are covered -- checking BUILD-QUEUE.md alone
// would let a slice carry a phantom citation unseen. Read-only: this tool never
// writes the queue or the ledger. reports/OWNER-REQUEST-LEDGER.json is written
// only by tools/owner-capture.js.

const fs = require('node:fs');
const path = require('node:path');
const { readQueueCorpus } = require('../src/lib/build-queue-corpus');
const provenance = require('../src/lib/build-queue-provenance');

const ROOT = path.join(__dirname, '..');
const DEFAULT_QUEUE = path.join(ROOT, 'BUILD-QUEUE.md');
const DEFAULT_LEDGER = path.join(ROOT, 'reports', 'OWNER-REQUEST-LEDGER.json');

class CliError extends Error {
  constructor(message, exitCode = 2) { super(message); this.exitCode = exitCode; }
}

function loadCorpusSources(queueFile) {
  let corpus;
  try {
    corpus = readQueueCorpus(queueFile);
  } catch (error) {
    throw new CliError(`Could not read the queue corpus at ${queueFile}: ${error.message}`, 4);
  }
  const sources = [{ file: 'BUILD-QUEUE.md', markdown: corpus.rootText }];
  for (const slice of corpus.slices) sources.push({ file: slice.path, markdown: slice.text });
  return sources;
}

function loadLedger(ledgerFile) {
  let raw;
  try { raw = fs.readFileSync(ledgerFile, 'utf8'); }
  catch (error) {
    // Absence is a failure, never a pass. A missing ledger cannot certify that
    // every citation is real.
    throw new CliError(`Could not read the owner request ledger at ${ledgerFile}: ${error.message}`, 4);
  }
  try { return JSON.parse(raw); }
  catch (error) { throw new CliError(`${ledgerFile} is not valid JSON: ${error.message}`, 4); }
}

function ridNumber(rid) {
  const match = /^R(\d+)(?:\.\d+)?$/.exec(String(rid));
  const value = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(value)) {
    throw new CliError(`Could not compare invalid owner-request id: ${rid}`, 2);
  }
  return value;
}

function render(result, options) {
  const lines = [];
  lines.push('BUILD-QUEUE PROVENANCE -- every queued item against the owner request ledger');
  lines.push('');
  lines.push(`  queue        ${result.files.join(', ')}`);
  lines.push(`  ledger       revision ${result.ledgerRevision}, ${result.ledgerEntries} entries`);
  lines.push(`  phases       ${result.phaseCount} (${result.pendingPhaseCount} still pending)`);
  lines.push(`  cited ids    ${result.citedIdCount}`);
  lines.push('');

  const errors = result.findings.filter(f => f.severity === 'error');
  const warns = result.findings.filter(f => f.severity !== 'error');

  if (errors.length) {
    lines.push(`  ERRORS (${errors.length}) -- a queue item asserting authority it does not have:`);
    for (const f of errors) {
      lines.push(`    ${f.file}:${f.line}  [${f.code}] ${f.message}`);
    }
    lines.push('');
  } else {
    lines.push('  No phantom citations and no unverifiable owner claims among pending phases.');
    lines.push('');
  }

  if (warns.length) {
    lines.push(`  WARNINGS (${warns.length}):`);
    for (const f of warns.slice(0, options.limit)) {
      lines.push(`    ${f.file}:${f.line}  [${f.code}] ${f.message}`);
    }
    if (warns.length > options.limit) lines.push(`    ... and ${warns.length - options.limit} more.`);
    lines.push('');
  }

  lines.push(`  DIRECTIVES QUEUED NOWHERE: ${result.orphanDirectiveCount} of ${result.actionableDirectiveCount} unfinished ledger entries are named by no queue phase.`);
  if (result.orphanDirectiveCount) {
    const shown = options.orphans ? result.orphanDirectives : result.orphanDirectives.slice(-options.limit);
    for (const o of shown) lines.push(`    ${o.rid.padEnd(8)} ${o.status}`);
    if (!options.orphans && result.orphanDirectiveCount > shown.length) {
      lines.push(`    ... and ${result.orphanDirectiveCount - shown.length} more; pass --orphans for the full list.`);
    }
    lines.push('');
    lines.push('  Each one is work the owner asked for that no builder loop can pick up.');
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { queue: DEFAULT_QUEUE, ledger: DEFAULT_LEDGER, json: false, orphans: false, limit: 20, since: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new CliError(`${arg} needs a value`, 2);
      i += 1;
      return value;
    };
    if (arg === '--json') options.json = true;
    else if (arg === '--orphans') options.orphans = true;
    else if (arg === '--queue') options.queue = path.resolve(next());
    else if (arg === '--ledger') options.ledger = path.resolve(next());
    else if (arg === '--limit') {
      options.limit = Number(next());
      if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
        throw new CliError('--limit must be a non-negative integer', 2);
      }
    } else if (arg === '--since') {
      options.since = next();
      // Refuse an unorderable floor here. Previously ridNumber collapsed a
      // malformed --since value to -1, producing a definite unfiltered count.
      ridNumber(options.since);
    }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new CliError(`unknown argument: ${arg}`, 2);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write([
      'usage: node tools/build-queue-provenance.js [--queue FILE] [--ledger FILE] [--since RNNN] [--orphans] [--limit N] [--json]',
      '',
      'Checks that every owner-request id cited by a queue phase actually exists in the',
      'owner request ledger, and names every unfinished directive that no queue phase',
      'claims. Read-only. Exit 6 when a queue item asserts authority it does not have.',
      ''
    ].join('\n'));
    return 0;
  }

  const sources = loadCorpusSources(options.queue);
  const ledger = loadLedger(options.ledger);

  let result;
  try {
    result = provenance.auditQueueProvenance({
      sources,
      ledger,
      ledgerSource: path.relative(ROOT, options.ledger).replace(/\\/g, '/')
    });
  } catch (error) {
    throw new CliError(error.message, 4);
  }

  if (options.since) {
    const floor = ridNumber(options.since);
    result = {
      ...result,
      orphanDirectives: result.orphanDirectives.filter(o => ridNumber(o.rid) >= floor)
    };
    result.orphanDirectiveCount = result.orphanDirectives.length;
  }

  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${render(result, options)}\n`);
  return result.errorCount ? 6 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

module.exports = Object.freeze({ CliError, loadCorpusSources, loadLedger, main });
