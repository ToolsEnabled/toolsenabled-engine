#!/usr/bin/env node
'use strict';

// Installation-scoped dotted-request metadata migration. The product ships no
// target ids. --check is read-only; --write uses the existing ledger lock and
// atomic backup writer. Without --policy the neutral empty policy is a no-op.

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_LEDGER_FILE,
  acquireLedgerLock,
  atomicWriteLedgerWithBackup,
  validateLedgerShape,
  todayString
} = require('./owner-capture');
const {
  EMPTY_MIGRATION_POLICY,
  normalizePolicy,
  buildLegacyDottedMetadataById
} = require('../src/lib/request-version/legacy-dotted-disposition');

class LegacyDottedMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LegacyDottedMigrationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LegacyDottedMigrationError(code, message);
}

function parseArgs(argv) {
  const result = { mode: null, ledger: DEFAULT_LEDGER_FILE, policy: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--check' || value === '--write') {
      if (result.mode) fail('LEGACY_DOTTED_USAGE', 'Choose exactly one of --check or --write.');
      result.mode = value.slice(2);
      continue;
    }
    if (value === '--ledger' || value === '--policy') {
      if (index + 1 >= argv.length) fail('LEGACY_DOTTED_USAGE', `${value} requires a path.`);
      const key = value.slice(2);
      if (result[key] !== null && key === 'policy') fail('LEGACY_DOTTED_USAGE', '--policy may be supplied only once.');
      result[key] = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    fail('LEGACY_DOTTED_USAGE', `Unknown argument: ${value}`);
  }
  if (!result.mode) fail('LEGACY_DOTTED_USAGE', 'Choose exactly one of --check or --write.');
  return Object.freeze(result);
}

function parseLedger(raw, ledgerFile) {
  let ledger;
  try { ledger = JSON.parse(raw); }
  catch { fail('LEGACY_DOTTED_LEDGER_INVALID', `${ledgerFile} is not valid JSON.`); }
  validateLedgerShape(ledger, ledgerFile);
  if (!Number.isSafeInteger(ledger.revision) || ledger.revision < 0) {
    fail('LEGACY_DOTTED_LEDGER_INVALID', `${ledgerFile} has an invalid revision.`);
  }
  return ledger;
}

function readPolicy(policyFile) {
  if (policyFile === null || policyFile === undefined) return EMPTY_MIGRATION_POLICY;
  if (!fs.existsSync(policyFile)) fail('LEGACY_DOTTED_POLICY_NOT_FOUND', `No migration policy at ${policyFile}.`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(policyFile, 'utf8')); }
  catch { fail('LEGACY_DOTTED_POLICY_INVALID', `${policyFile} is not valid JSON.`); }
  try { return normalizePolicy(parsed); }
  catch (error) {
    if (error?.code === 'LEGACY_DOTTED_POLICY_INVALID') throw error;
    throw error;
  }
}

function targetIdsForPolicy(policy) {
  const normalized = normalizePolicy(policy);
  return Object.freeze([
    ...normalized.continuationIds,
    ...normalized.duplicatePairs.map(([, activeId]) => activeId)
  ]);
}

function applyLegacyDottedMigration(ledger, options = {}) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || !Array.isArray(ledger.requests)) {
    fail('LEGACY_DOTTED_LEDGER_INVALID', 'Ledger must contain a requests array.');
  }
  const policy = normalizePolicy(options.policy || EMPTY_MIGRATION_POLICY);
  const targetIds = targetIdsForPolicy(policy);
  const metadata = buildLegacyDottedMetadataById(ledger.requests, policy);
  const targetSet = new Set(targetIds);
  const changedIds = [];
  const requests = ledger.requests.map(entry => {
    if (!targetSet.has(entry.id)) return entry;
    const desired = metadata[entry.id];
    if (!desired) fail('LEGACY_DOTTED_METADATA_MISSING', `No policy metadata exists for ${entry.id}.`);
    for (const [field, value] of Object.entries(desired)) {
      if (Object.hasOwn(entry, field) && JSON.stringify(entry[field]) !== JSON.stringify(value)) {
        fail('LEGACY_DOTTED_METADATA_CONFLICT', `${entry.id}.${field} already has a different value.`);
      }
    }
    const pending = Object.entries(desired).some(([field, value]) =>
      !Object.hasOwn(entry, field) || JSON.stringify(entry[field]) !== JSON.stringify(value));
    if (!pending) return entry;
    changedIds.push(entry.id);
    return { ...entry, ...desired };
  });
  if (changedIds.length === 0) {
    return Object.freeze({ changed: false, changedIds: Object.freeze([]), targetIds, ledger });
  }
  if (changedIds.length !== targetIds.length) {
    fail('LEGACY_DOTTED_PARTIAL_STATE', `All ${targetIds.length} policy-declared records must migrate together; found ${changedIds.length} pending.`);
  }
  const updatedAt = options.updatedAt === undefined ? todayString() : options.updatedAt;
  if (typeof updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) {
    fail('LEGACY_DOTTED_UPDATED_AT_INVALID', 'updatedAt must be YYYY-MM-DD.');
  }
  return Object.freeze({
    changed: true,
    changedIds: Object.freeze([...changedIds]),
    targetIds,
    ledger: { ...ledger, revision: ledger.revision + 1, updatedAt, requests }
  });
}

function inspectFile(ledgerFile, options = {}) {
  if (!fs.existsSync(ledgerFile)) fail('LEGACY_DOTTED_LEDGER_NOT_FOUND', `No ledger file at ${ledgerFile}.`);
  const raw = fs.readFileSync(ledgerFile, 'utf8');
  const ledger = parseLedger(raw, ledgerFile);
  return { raw, result: applyLegacyDottedMigration(ledger, options) };
}

function summary(mode, ledgerFile, result) {
  return Object.freeze({
    ok: true,
    mode,
    ledgerFile,
    backupFile: mode === 'write' && result.changed ? `${ledgerFile}.bak` : null,
    changed: result.changed,
    changedIds: result.changedIds,
    targetCount: result.targetIds.length,
    revision: result.ledger.revision
  });
}

function main(argv) {
  const args = parseArgs(argv);
  const ledgerFile = path.resolve(args.ledger);
  const policy = readPolicy(args.policy);
  if (args.mode === 'check') {
    const { result } = inspectFile(ledgerFile, { policy });
    const output = summary('check', ledgerFile, result);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (result.changed) process.exitCode = 1;
    return output;
  }

  const lock = acquireLedgerLock(ledgerFile);
  try {
    const { raw, result } = inspectFile(ledgerFile, { policy });
    if (result.changed) atomicWriteLedgerWithBackup(ledgerFile, raw, result.ledger);
    const output = summary('write', ledgerFile, result);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return output;
  } finally {
    lock.release();
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error.code || 'LEGACY_DOTTED_UNEXPECTED'}: ${error.message || String(error)}\n`);
    process.exitCode = 2;
  }
}

module.exports = Object.freeze({
  LegacyDottedMigrationError,
  parseArgs,
  readPolicy,
  targetIdsForPolicy,
  applyLegacyDottedMigration,
  inspectFile,
  main
});
