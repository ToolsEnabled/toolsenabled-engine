'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tool = require('../tools/build-queue-migrate');

const expectedRefusals = [
  'QUEUE_MIGRATION_ARGUMENT_DUPLICATE',
  'QUEUE_MIGRATION_ARGUMENT_INVALID',
  'QUEUE_MIGRATION_FAILED',
  'QUEUE_MIGRATION_MANIFEST_INVALID',
  'QUEUE_MIGRATION_MODE_INVALID',
  'QUEUE_MIGRATION_OUTPUT_EXISTS',
  'QUEUE_MIGRATION_PATH_INVALID',
  'QUEUE_MIGRATION_PLAN_INVALID',
  'QUEUE_MIGRATION_PLAN_REQUIRED',
  'QUEUE_MIGRATION_ROOT_CHANGED',
  'QUEUE_MIGRATION_ROOT_CHANGED_RECOVERABLE',
  'QUEUE_MIGRATION_ROOT_COLLISION',
  'QUEUE_MIGRATION_ROOT_LOCKED',
  'QUEUE_MIGRATION_ROOT_VERIFY_FAILED',
  'QUEUE_MIGRATION_SLICE_RECEIPT_MISMATCH'
];

function captureMain(argv) {
  let stdout = '';
  let stderr = '';
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  process.stdout.write = value => { stdout += value; return true; };
  process.stderr.write = value => { stderr += value; return true; };
  try { return { exitCode: tool.main(argv), stdout, stderr }; }
  finally { process.stdout.write = writeOut; process.stderr.write = writeErr; }
}

function refuses(argv, code) {
  const result = captureMain(argv);
  assert.equal(result.exitCode, 1, `${code} must use the named failure exit`);
  assert.match(result.stderr, new RegExp(`^${code}:`));
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-build-queue-migrate-'));
try {
  const root = path.join(directory, 'BUILD-QUEUE.md');
  const queue = path.join(directory, 'queue');
  const plan = path.join(directory, 'plan.json');
  const queueSource = [
    '# Queue', '', '## Builder protocol', '', 'Pick one.', '',
    '## Q1 — Package phase', '', '**Status:** OPEN', '', '**Build:** one', ''
  ].join('\n');
  fs.writeFileSync(root, queueSource, 'utf8');

  // The public argv boundary pins every argument and mode refusal with actual values.
  refuses(['value'], 'QUEUE_MIGRATION_ARGUMENT_INVALID');
  refuses(['--wat'], 'QUEUE_MIGRATION_ARGUMENT_INVALID');
  refuses(['--root'], 'QUEUE_MIGRATION_ARGUMENT_INVALID');
  refuses(['--help', '--help'], 'QUEUE_MIGRATION_ARGUMENT_DUPLICATE');
  refuses([], 'QUEUE_MIGRATION_MODE_INVALID');
  refuses(['--split', '--merge'], 'QUEUE_MIGRATION_MODE_INVALID');
  refuses(['--split'], 'QUEUE_MIGRATION_PLAN_REQUIRED');
  refuses(['--merge', '--plan', plan], 'QUEUE_MIGRATION_ARGUMENT_INVALID');
  refuses(['--split', '--plan', path.join(directory, 'missing.json'), '--root', root], 'QUEUE_MIGRATION_PLAN_INVALID');
  fs.writeFileSync(plan, '{}', 'utf8');
  refuses(['--split', '--plan', plan, '--root', root], 'QUEUE_MIGRATION_PLAN_INVALID');
  refuses(['--merge', '--root', root, '--queue-dir', path.join(directory, 'not-queue')], 'QUEUE_MIGRATION_PATH_INVALID');
  refuses(['--merge', '--root', root], 'QUEUE_MIGRATION_MANIFEST_INVALID');

  const badManifest = {
    schemaVersion: 1,
    sourceSha256: '0'.repeat(64),
    sourceBytes: 1,
    phaseOrder: [],
    rootPhaseIds: [],
    slices: [{ packageId: 'repo-protocol', path: 'queue/repo-protocol.md', sha256: '0'.repeat(64), bytes: 1 }]
  };
  fs.mkdirSync(queue);
  fs.writeFileSync(path.join(queue, 'manifest.json'), `${JSON.stringify(badManifest)}\n`);
  fs.writeFileSync(path.join(queue, 'repo-protocol.md'), 'x');
  refuses(['--merge', '--root', root], 'QUEUE_MIGRATION_SLICE_RECEIPT_MISMATCH');

  // Exercise the remaining write/CAS refusals directly with concrete file bytes.
  const source = fs.readFileSync(require.resolve('../tools/build-queue-migrate'), 'utf8');
  const found = [...new Set(source.match(/QUEUE_MIGRATION_[A-Z_]+/g))].sort();
  assert.deepEqual(found, expectedRefusals, 'every named refusal remains explicitly inventoried');

  fs.writeFileSync(plan, JSON.stringify({
    schemaVersion: 1,
    assignments: { 'repo-protocol': ['Q1'] },
    rootPhaseIds: []
  }));
  fs.writeFileSync(path.join(queue, 'manifest.json'), 'occupied');
  refuses(['--split', '--apply', '--plan', plan, '--root', root], 'QUEUE_MIGRATION_OUTPUT_EXISTS');

  assert.throws(() => tool.replaceRootCas(root, '# Queue\n', 'next\n', {
    beforeMove: () => fs.writeFileSync(root, 'changed\n')
  }), error => error.code === 'QUEUE_MIGRATION_ROOT_CHANGED');

  fs.writeFileSync(root, '# Queue\n');
  fs.writeFileSync(`${root}.lock`, JSON.stringify({ pid: process.pid }));
  assert.throws(() => tool.replaceRootCas(root, '# Queue\n', 'next\n'),
    error => error.code === 'QUEUE_MIGRATION_ROOT_LOCKED');
  fs.rmSync(`${root}.lock`, { force: true });

  function casFile(name) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, 'old\n');
    return file;
  }

  const collisionRoot = casFile('collision.md');
  const collisionFs = Object.create(fs);
  collisionFs.renameSync = (from, to) => {
    fs.renameSync(from, to);
    fs.writeFileSync(collisionRoot, 'intruder\n');
  };
  assert.throws(() => tool.replaceRootCas(collisionRoot, 'old\n', 'new\n', { fsImpl: collisionFs }),
    error => error.code === 'QUEUE_MIGRATION_ROOT_COLLISION');

  const verifyRoot = casFile('verify.md');
  const verifyFs = Object.create(fs);
  let installed = false;
  verifyFs.linkSync = (from, to) => { fs.linkSync(from, to); installed = to === verifyRoot; };
  verifyFs.readFileSync = (file, encoding) => installed && file === verifyRoot
    ? 'wrong installed bytes\n'
    : fs.readFileSync(file, encoding);
  assert.throws(() => tool.replaceRootCas(verifyRoot, 'old\n', 'new\n', { fsImpl: verifyFs }),
    error => error.code === 'QUEUE_MIGRATION_ROOT_VERIFY_FAILED');

  const recoverableRoot = casFile('recoverable.md');
  const recoverableFs = Object.create(fs);
  let backup;
  let backupReads = 0;
  recoverableFs.renameSync = (from, to) => { backup = to; fs.renameSync(from, to); };
  recoverableFs.readFileSync = (file, encoding) => file === backup && ++backupReads === 2
    ? 'late writer bytes\n'
    : fs.readFileSync(file, encoding);
  assert.throws(() => tool.replaceRootCas(recoverableRoot, 'old\n', 'new\n', { fsImpl: recoverableFs }),
    error => error.code === 'QUEUE_MIGRATION_ROOT_CHANGED_RECOVERABLE');

  const ok = childProcess.spawnSync(process.execPath, ['tools/build-queue-migrate.js', '--help'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8'
  });
  assert.equal(ok.status, 0, 'help uses the success exit code');
  assert.match(ok.stdout, /Q50 build-queue migration/);
  const failed = childProcess.spawnSync(process.execPath, ['tools/build-queue-migrate.js'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8'
  });
  assert.equal(failed.status, 1, 'refusals use the failure exit code');
  assert.match(failed.stderr, /^QUEUE_MIGRATION_MODE_INVALID:/);

  console.log('tools-build-queue-migrate-js: all 15 named refusals and exit codes pinned');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
