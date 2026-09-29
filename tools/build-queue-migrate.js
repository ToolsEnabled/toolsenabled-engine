#!/usr/bin/env node
'use strict';

// Q50's bounded, reversible migration driver.  Split requires an explicit
// ownership plan and is preview-only unless --apply is present.  Package files
// and the merge receipt land before the root index, so partially emitted files
// remain inert; the root is replaced only behind a byte-for-byte CAS fence.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { mergeQueueMigration, splitQueueMigration } = require('../src/lib/build-queue-migration');
const { assertPackageId, queueSlicePath } = require('../src/lib/build-queue-package-contract');
const { acquireLock, AgentDigestLockError } = require('../src/lib/process-claim-lock');

const USAGE = `Q50 build-queue migration

  node tools/build-queue-migrate.js --split --plan <json> [--root <file>] [--queue-dir <dir>] [--apply]
  node tools/build-queue-migrate.js --merge [--root <file>] [--queue-dir <dir>] [--apply]

The plan schema is exactly:
  {"schemaVersion":1,"assignments":{"package.id":["Q50"]},"rootPhaseIds":["Q7"]}

Without --apply the command validates and prints a bounded preview. --merge
uses queue/manifest.json and proves the original SHA-256 and byte length.
`;

class BuildQueueMigrationCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BuildQueueMigrationCliError';
    this.code = code;
  }
}

function cliError(code, message) {
  throw new BuildQueueMigrationCliError(code, message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseArgs(argv) {
  const flags = new Map();
  const values = new Set(['plan', 'root', 'queue-dir']);
  const booleans = new Set(['split', 'merge', 'apply', 'help']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) cliError('QUEUE_MIGRATION_ARGUMENT_INVALID', `Unexpected argument ${token}.`);
    const key = token.slice(2);
    if (booleans.has(key)) {
      if (flags.has(key)) cliError('QUEUE_MIGRATION_ARGUMENT_DUPLICATE', `--${key} was repeated.`);
      flags.set(key, true);
      continue;
    }
    if (!values.has(key)) cliError('QUEUE_MIGRATION_ARGUMENT_INVALID', `Unknown flag --${key}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) cliError('QUEUE_MIGRATION_ARGUMENT_INVALID', `--${key} requires a value.`);
    if (flags.has(key)) cliError('QUEUE_MIGRATION_ARGUMENT_DUPLICATE', `--${key} was repeated.`);
    flags.set(key, value);
    index += 1;
  }
  return flags;
}

function readJson(file, code) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { cliError(code, `${path.basename(file)} is not readable canonical JSON.`); }
  return parsed;
}

function assertPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some(key => !['schemaVersion', 'assignments', 'rootPhaseIds'].includes(key))
      || Reflect.ownKeys(value).length !== 3 || value.schemaVersion !== 1) {
    cliError('QUEUE_MIGRATION_PLAN_INVALID', 'The migration plan has an invalid exact schema.');
  }
  return value;
}

function assertManifest(value) {
  const keys = ['schemaVersion', 'sourceSha256', 'sourceBytes', 'phaseOrder', 'rootPhaseIds', 'slices'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== keys.length
      || Reflect.ownKeys(value).some(key => !keys.includes(key))
      || value.schemaVersion !== 1 || typeof value.sourceSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.sourceSha256) || !Number.isSafeInteger(value.sourceBytes)
      || !Array.isArray(value.phaseOrder) || !Array.isArray(value.rootPhaseIds) || !Array.isArray(value.slices)) {
    cliError('QUEUE_MIGRATION_MANIFEST_INVALID', 'The queue migration manifest has an invalid exact schema.');
  }
  const packages = new Set();
  for (const slice of value.slices) {
    let canonicalPath;
    try { canonicalPath = queueSlicePath(assertPackageId(slice && slice.packageId)); }
    catch { cliError('QUEUE_MIGRATION_MANIFEST_INVALID', 'The queue migration manifest contains an invalid package id.'); }
    if (!slice || typeof slice !== 'object' || Array.isArray(slice)
        || Reflect.ownKeys(slice).length !== 4
        || !['packageId', 'path', 'sha256', 'bytes'].every(key => Object.hasOwn(slice, key))
        || slice.path !== canonicalPath || packages.has(slice.packageId)
        || typeof slice.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(slice.sha256)
        || !Number.isSafeInteger(slice.bytes) || slice.bytes < 1) {
      cliError('QUEUE_MIGRATION_MANIFEST_INVALID', 'The queue migration manifest contains an invalid slice receipt.');
    }
    packages.add(slice.packageId);
  }
  return value;
}

function pathsFor({ rootFile, queueDirectory }) {
  const root = path.resolve(rootFile);
  const queueDir = path.resolve(queueDirectory);
  if (path.dirname(queueDir) !== path.dirname(root) || path.basename(queueDir).toLowerCase() !== 'queue') {
    cliError('QUEUE_MIGRATION_PATH_INVALID', 'queue-dir must be the queue sibling of the selected root file.');
  }
  return { root, queueDir, manifestFile: path.join(queueDir, 'manifest.json') };
}

function writeNewOrExact(file, content) {
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== content) cliError('QUEUE_MIGRATION_OUTPUT_EXISTS', `${file} already exists with different bytes.`);
    return false;
  }
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, content, 'utf8'); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  return true;
}

function replaceRootCas(file, previous, next, { fsImpl = fs, beforeMove } = {}) {
  let lock;
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const backup = `${file}.${process.pid}.${crypto.randomUUID()}.recovery`;
  let descriptor;
  try {
    try { lock = acquireLock(`${file}.lock`, { fsImpl }); }
    catch (error) {
      if (error instanceof AgentDigestLockError) cliError('QUEUE_MIGRATION_ROOT_LOCKED', 'Another queue writer holds the root queue lock.');
      throw error;
    }
    descriptor = fsImpl.openSync(temporary, 'wx', 0o600);
    fsImpl.writeFileSync(descriptor, next, 'utf8');
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = null;
    if (fsImpl.readFileSync(file, 'utf8') !== previous) cliError('QUEUE_MIGRATION_ROOT_CHANGED', 'The root queue changed during migration; emitted slices remain inert.');
    if (typeof beforeMove === 'function') beforeMove();
    // Move the current inode aside before installing the staged root.  A
    // non-cooperating editor that wins after the read fence is therefore
    // detected in the recovery file instead of being overwritten by rename.
    fsImpl.renameSync(file, backup);
    if (fsImpl.readFileSync(backup, 'utf8') !== previous) {
      try { fsImpl.linkSync(backup, file); } catch { /* preserve recovery */ }
      cliError('QUEUE_MIGRATION_ROOT_CHANGED', `The root queue changed during migration; recovery bytes remain at ${backup}.`);
    }
    try { fsImpl.linkSync(temporary, file); }
    catch {
      cliError('QUEUE_MIGRATION_ROOT_COLLISION', `A root queue appeared during migration; recovery bytes remain at ${backup}.`);
    }
    if (fsImpl.readFileSync(file, 'utf8') !== next) cliError('QUEUE_MIGRATION_ROOT_VERIFY_FAILED', `The installed root did not verify; recovery bytes remain at ${backup}.`);
    if (fsImpl.readFileSync(backup, 'utf8') !== previous) {
      cliError('QUEUE_MIGRATION_ROOT_CHANGED_RECOVERABLE', `A late write reached the prior root; recovery bytes remain at ${backup}.`);
    }
    fsImpl.unlinkSync(backup);
  } finally {
    if (descriptor !== undefined && descriptor !== null) { try { fsImpl.closeSync(descriptor); } catch { /* closed */ } }
    try { if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary); } catch { /* best effort */ }
    if (lock) lock.release();
  }
}

function manifestFor(result) {
  return {
    schemaVersion: 1,
    sourceSha256: result.sourceSha256,
    sourceBytes: result.sourceBytes,
    phaseOrder: [...result.phaseOrder],
    rootPhaseIds: [...result.rootPhaseIds],
    slices: Object.keys(result.slices).sort().map(packageId => ({
      packageId,
      path: queueSlicePath(packageId),
      sha256: sha256(result.slices[packageId]),
      bytes: Buffer.byteLength(result.slices[packageId], 'utf8')
    }))
  };
}

function executeSplit({ rootFile, queueDirectory, planFile, apply = false }) {
  const selected = pathsFor({ rootFile, queueDirectory });
  const source = fs.readFileSync(selected.root, 'utf8');
  const plan = assertPlan(readJson(path.resolve(planFile), 'QUEUE_MIGRATION_PLAN_INVALID'));
  const result = splitQueueMigration({ queueMarkdown: source, assignments: plan.assignments, rootPhaseIds: plan.rootPhaseIds });
  const manifest = manifestFor(result);
  const preview = {
    ok: true,
    action: 'split',
    applied: apply,
    sourceSha256: result.sourceSha256,
    sourceBytes: result.sourceBytes,
    rootPhaseCount: result.rootPhaseIds.length,
    slices: manifest.slices
  };
  if (!apply) return preview;
  fs.mkdirSync(selected.queueDir, { recursive: true });
  for (const slice of manifest.slices) {
    writeNewOrExact(path.join(selected.queueDir, `${slice.packageId}.md`), result.slices[slice.packageId]);
  }
  writeNewOrExact(selected.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  replaceRootCas(selected.root, source, result.rootMarkdown);
  return preview;
}

function executeMerge({ rootFile, queueDirectory, apply = false }) {
  const selected = pathsFor({ rootFile, queueDirectory });
  const rootMarkdown = fs.readFileSync(selected.root, 'utf8');
  const manifest = assertManifest(readJson(selected.manifestFile, 'QUEUE_MIGRATION_MANIFEST_INVALID'));
  const slices = {};
  for (const receipt of manifest.slices) {
    const resolvedSlice = path.resolve(path.dirname(selected.root), ...receipt.path.split('/'));
    const expectedParent = `${selected.queueDir}${path.sep}`;
    if (!resolvedSlice.startsWith(expectedParent)) cliError('QUEUE_MIGRATION_MANIFEST_INVALID', 'A manifest slice path escaped the queue directory.');
    const text = fs.readFileSync(resolvedSlice, 'utf8');
    if (sha256(text) !== receipt.sha256 || Buffer.byteLength(text, 'utf8') !== receipt.bytes) {
      cliError('QUEUE_MIGRATION_SLICE_RECEIPT_MISMATCH', `${receipt.path} no longer matches its migration receipt.`);
    }
    slices[receipt.packageId] = text;
  }
  const merged = mergeQueueMigration({
    rootMarkdown,
    slices,
    sourceSha256: manifest.sourceSha256,
    sourceBytes: manifest.sourceBytes
  });
  const preview = {
    ok: true,
    action: 'merge',
    applied: apply,
    mergedSha256: sha256(merged),
    mergedBytes: Buffer.byteLength(merged, 'utf8'),
    sliceCount: manifest.slices.length
  };
  if (apply) replaceRootCas(selected.root, rootMarkdown, merged);
  return preview;
}

function main(argv) {
  try {
    const flags = parseArgs(argv);
    if (flags.get('help')) { process.stdout.write(USAGE); return 0; }
    if (Boolean(flags.get('split')) === Boolean(flags.get('merge'))) cliError('QUEUE_MIGRATION_MODE_INVALID', 'Choose exactly one of --split or --merge.');
    const rootFile = flags.get('root') || path.resolve(__dirname, '..', 'BUILD-QUEUE.md');
    const queueDirectory = flags.get('queue-dir') || path.join(path.dirname(path.resolve(rootFile)), 'queue');
    let result;
    if (flags.get('split')) {
      if (!flags.get('plan')) cliError('QUEUE_MIGRATION_PLAN_REQUIRED', '--split requires --plan.');
      result = executeSplit({ rootFile, queueDirectory, planFile: flags.get('plan'), apply: flags.get('apply') === true });
    } else {
      if (flags.get('plan')) cliError('QUEUE_MIGRATION_ARGUMENT_INVALID', '--merge does not accept --plan.');
      result = executeMerge({ rootFile, queueDirectory, apply: flags.get('apply') === true });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error && error.code ? error.code : 'QUEUE_MIGRATION_FAILED'}: ${error && error.message ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = Object.freeze({
  BuildQueueMigrationCliError,
  USAGE,
  assertManifest,
  assertPlan,
  executeMerge,
  executeSplit,
  main,
  manifestFor,
  parseArgs,
  replaceRootCas
});
