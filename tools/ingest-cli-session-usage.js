'use strict';

// Reads the officially-recorded local usage of Claude Code and Codex CLI and
// writes one signed, content-free observation per provider into the canonical
// audit ledger. Run it manually, from a schedule, or let the local-coder
// sidecar call it on its own throttle.
//
//   node tools/ingest-cli-session-usage.js            bounded incremental run
//   node tools/ingest-cli-session-usage.js --force    ignore the run throttle
//   node tools/ingest-cli-session-usage.js --dry-run  read and print, write nothing
//
// --dry-run touches neither the ledger nor the cursor, so it is safe to use to
// see what a run WOULD credit before crediting it.

const { collectCliSessionUsage } = require('../src/lib/cli-session-usage');
const { ingestCliSessionUsage } = require('../src/lib/cli-session-usage-ingest');

function parseIntOption(argv, name, multiplier = 1) {
  const indexes = argv.reduce((found, argument, index) => {
    if (argument === name) found.push(index);
    return found;
  }, []);
  if (indexes.length === 0) return null;
  if (indexes.length !== 1) throw new Error(`${name} must be specified at most once`);

  const raw = argv[indexes[0] + 1];
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} requires a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(value * multiplier)) {
    throw new Error(`${name} is too large`);
  }
  return value * multiplier;
}

function main(argv) {
  const options = {};
  const maxAgeMs = parseIntOption(argv, '--max-age-hours', 60 * 60 * 1000);
  const maxFiles = parseIntOption(argv, '--max-files');
  const maxBytes = parseIntOption(argv, '--max-mb', 1024 * 1024);
  if (maxAgeMs !== null) options.maxAgeMs = maxAgeMs;
  if (maxFiles !== null) options.maxFiles = maxFiles;
  if (maxBytes !== null) options.maxBytes = maxBytes;

  if (argv.includes('--dry-run')) {
    const { observations } = collectCliSessionUsage(options);
    if (!Array.isArray(observations)) throw new Error('usage collection did not return observations');
    process.stdout.write(`${JSON.stringify({ dryRun: true, observations }, null, 2)}\n`);
    return 0;
  }
  const result = ingestCliSessionUsage({ ...options, force: argv.includes('--force') });
  if (!result || typeof result.ran !== 'boolean') throw new Error('usage ingestion did not report whether it ran');
  if (result.ran && !Array.isArray(result.failedProviders)) {
    throw new Error('usage ingestion did not report provider failures');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ran && result.failedProviders.length > 0) return 1;
  return 0;
}

process.exitCode = main(process.argv.slice(2));
