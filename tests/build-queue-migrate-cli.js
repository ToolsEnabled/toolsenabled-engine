'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../tools/build-queue-migrate');

const source = [
  '# Queue', '',
  '## Builder protocol', '', 'Pick the lowest open phase.', '',
  '## Q1 — Package phase', '', '**Status:** OPEN', '', '**Build:** one', '',
  '## Q2 — Cross phase', '', '**Status:** BLOCKED (fixture)', '', '**Build:** two', ''
].join('\n');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-migrate-cli-'));
const rootFile = path.join(directory, 'BUILD-QUEUE.md');
const queueDirectory = path.join(directory, 'queue');
const planFile = path.join(directory, 'plan.json');
fs.writeFileSync(rootFile, source, 'utf8');
fs.writeFileSync(planFile, `${JSON.stringify({
  schemaVersion: 1,
  assignments: { 'repo-protocol': ['Q1'] },
  rootPhaseIds: ['Q2']
}, null, 2)}\n`, 'utf8');

try {
  const preview = cli.executeSplit({ rootFile, queueDirectory, planFile, apply: false });
  assert.equal(preview.applied, false);
  assert.equal(fs.existsSync(queueDirectory), false, 'preview is read-only');
  assert.equal(fs.readFileSync(rootFile, 'utf8'), source);

  const split = cli.executeSplit({ rootFile, queueDirectory, planFile, apply: true });
  assert.equal(split.applied, true);
  assert.match(fs.readFileSync(rootFile, 'utf8'), /## Package queue index/);
  assert.match(fs.readFileSync(path.join(queueDirectory, 'repo-protocol.md'), 'utf8'), /## Q1/);
  assert.ok(fs.existsSync(path.join(queueDirectory, 'manifest.json')));

  const mergePreview = cli.executeMerge({ rootFile, queueDirectory, apply: false });
  assert.equal(mergePreview.mergedSha256, split.sourceSha256);
  assert.notEqual(fs.readFileSync(rootFile, 'utf8'), source, 'merge preview is read-only');

  const merged = cli.executeMerge({ rootFile, queueDirectory, apply: true });
  assert.equal(merged.applied, true);
  assert.equal(fs.readFileSync(rootFile, 'utf8'), source, 'merge restores the monolith byte-for-byte');

  const validManifest = cli.manifestFor(require('../src/lib/build-queue-migration').splitQueueMigration({
    queueMarkdown: source,
    assignments: { 'repo-protocol': ['Q1'] },
    rootPhaseIds: ['Q2']
  }));
  assert.throws(
    () => cli.assertManifest({
      ...validManifest,
      slices: [{ ...validManifest.slices[0], packageId: '../escaped', path: 'queue/../escaped.md' }]
    }),
    error => error && error.code === 'QUEUE_MIGRATION_MANIFEST_INVALID'
  );

  const concurrent = `${source}\nconcurrent edit`;
  fs.writeFileSync(rootFile, source, 'utf8');
  assert.throws(
    () => cli.replaceRootCas(rootFile, source, `${source}\nnext`, {
      beforeMove: () => fs.writeFileSync(rootFile, concurrent, 'utf8')
    }),
    error => error && error.code === 'QUEUE_MIGRATION_ROOT_CHANGED'
  );
  assert.equal(fs.readFileSync(rootFile, 'utf8'), concurrent, 'a late edit is restored instead of overwritten');

  assert.equal(cli.main(['--split']), 1, 'missing plan is refused');
  console.log('build-queue-migrate-cli: 7 contract groups passed');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
