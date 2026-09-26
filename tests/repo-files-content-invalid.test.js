'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const repoFiles = require('../src/lib/providers/repo-files');

const relativeTarget = `tests/.repo-files-invalid-content-${process.pid}-${Date.now()}.txt`;
const absoluteTarget = path.join(repoFiles.ROOT, relativeTarget);
const calls = [];
const originals = {
  mkdirSync: fs.mkdirSync,
  writeFileSync: fs.writeFileSync,
  renameSync: fs.renameSync,
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync
};

// Observe every filesystem mutation used by writeFile, plus both synchronous
// and asynchronous process creation. Content validation must happen before any
// of these side effects.
fs.mkdirSync = (...args) => { calls.push(['mkdirSync', args]); };
fs.writeFileSync = (...args) => { calls.push(['writeFileSync', args]); };
fs.renameSync = (...args) => { calls.push(['renameSync', args]); };
childProcess.spawn = (...args) => { calls.push(['spawn', args]); };
childProcess.spawnSync = (...args) => { calls.push(['spawnSync', args]); };

try {
  assert.equal(fs.existsSync(absoluteTarget), false, 'the proposed target must begin absent');

  let refusal;
  try {
    repoFiles.writeFile({ path: relativeTarget, content: Buffer.from('not a string') });
    assert.fail('writeFile must reject non-string content');
  } catch (error) {
    refusal = error;
  }

  assert.equal(refusal.name, 'RepoFileError');
  assert.equal(refusal.code, 'REPO_FILE_CONTENT_INVALID');
  assert.equal(refusal.message, 'content must be a string.');
  assert.deepEqual(calls, [], 'a content refusal must not write, create directories, rename, or spawn');
  assert.equal(fs.existsSync(absoluteTarget), false, 'refusal must leave no target behind');
} finally {
  fs.mkdirSync = originals.mkdirSync;
  fs.writeFileSync = originals.writeFileSync;
  fs.renameSync = originals.renameSync;
  childProcess.spawn = originals.spawn;
  childProcess.spawnSync = originals.spawnSync;
  // Defensive cleanup uses the restored implementation and keeps reruns clean.
  fs.rmSync(absoluteTarget, { force: true });
}

process.stdout.write('repo-files invalid-content refusal test passed.\n');

// Exercise the real cut-payload marker, without loading an installed runtime.
// Exclusive creation ensures this test cannot overwrite a pre-existing seal.
const marker = path.join(repoFiles.ROOT, 'PAYLOAD.json');
fs.writeFileSync(marker, '{}\n', { flag: 'wx' });
try {
  assert.equal(repoFiles.isWriteProtectedPath('REPORT-new.md'), true);
  assert.equal(repoFiles.isWriteProtectedPath('PAYLOAD.json'), true);
  for (const options of [undefined, { fileToolContext: {} }]) {
    assert.throws(() => repoFiles.writeFile({ path: relativeTarget, content: 'report' }, options),
      error => error.code === 'REPO_FILE_WRITE_PROTECTED' && /writable workspace/.test(error.message));
    assert.throws(() => repoFiles.patchFile({ path: 'package.json', oldText: 'toolsenabled', newText: 'changed' }, options),
      error => error.code === 'REPO_FILE_WRITE_PROTECTED');
  }
  assert.equal(fs.existsSync(absoluteTarget), false, 'payload refusal cannot create a report');
  assert.equal(JSON.parse(repoFiles.readFile({ path: 'package.json' }).content).name, 'toolsenabled',
    'payload reads remain available and the existing file is unchanged');
} finally { fs.unlinkSync(marker); }
assert.equal(repoFiles.isWriteProtectedPath(relativeTarget), false, 'source checkout keeps its writable file surface');
process.stdout.write('repo-files immutable payload write and patch refusal tests passed.\n');
