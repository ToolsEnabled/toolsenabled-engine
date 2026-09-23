#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  DEFAULT_DB_FILE,
  DEFAULT_ROOT,
  EvidenceStoreError,
  verifyEvidenceStore
} = require('../src/lib/evidence-store');

function usage() {
  return [
    'Usage: node tools/verify-evidence-store.js [--db <evidence.sqlite3>] [--object-root <directory>] [--json]',
    '',
    'Read-only P10 verification. No evidence content, locator, credential, or filesystem path is printed.',
    'Defaults use the configured private evidence-store locations.'
  ].join('\n');
}

function parseArguments(argv) {
  const output = { dbFile: DEFAULT_DB_FILE, objectRoot: DEFAULT_ROOT, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') return { help: true };
    if (value === '--json') {
      output.json = true;
      continue;
    }
    if (value === '--db' || value === '--object-root') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`);
      if (value === '--db') output.dbFile = path.resolve(next);
      else output.objectRoot = path.resolve(next);
      index += 1;
      continue;
    }
    throw new Error('unknown argument');
  }
  return output;
}

function safeFailure(error) {
  if (error instanceof EvidenceStoreError) return { ok: false, code: error.code, message: error.message };
  return { ok: false, code: 'EVIDENCE_VERIFY_ERROR', message: 'Evidence verification could not complete.' };
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 64;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  let result;
  try {
    result = verifyEvidenceStore(options);
  } catch (error) {
    const failure = safeFailure(error);
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    return failure.code === 'EVIDENCE_DATABASE_MISSING' ? 66 : 65;
  }
  if (result.ok && result.records === 0) {
    result = {
      ...result,
      ok: false,
      code: 'EVIDENCE_NOT_MEASURED',
      failures: [{ part: 'store', reason: 'no-records' }]
    };
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `Evidence store verified: ${result.records} records, ${result.activeRecords} active, ` +
      `${result.tombstones} tombstones, ${result.objectsVerified} objects.\n`
    );
  } else {
    process.stderr.write(
      `Evidence integrity failure: ${result.failures.length} safe finding(s) across ${result.records} record(s).\n`
    );
    process.stderr.write(`${JSON.stringify(result.failures)}\n`);
  }
  return result.ok ? 0 : 2;
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArguments, safeFailure, usage };
