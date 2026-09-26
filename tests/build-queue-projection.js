'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const projection = require('../src/lib/build-queue-projection');
const { readQueueCorpus, renderQueueIndex } = require('../src/lib/build-queue-corpus');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

check('exports the closed status vocabulary', () => {
  assert.deepEqual(projection.STATUSES, ['DONE', 'BLOCKED', 'IN-PROGRESS', 'PARTIAL', 'OPEN', 'UNKNOWN']);
  assert.equal(Object.isFrozen(projection.STATUSES), true);
  assert.equal(projection.classifyStatus('IN-PROGRESS 2026-08-01'), 'IN-PROGRESS');
  assert.equal(projection.classifyStatus('not a queue status'), 'UNKNOWN');
});

check('projects only Q headings and closes at ordinary document sections', () => {
  const result = projection.parseQueuePhases([
    '# Queue',
    '',
    '## Q2 — Canonical',
    '',
    '**Status:** OPEN planned',
    '',
    '**Build:**',
    'Exact body.',
    '',
    '## Completed',
    'Older work.',
    '',
    '## Q3 - Legacy',
    '',
    '**Status:** DONE 2026-08-01',
    '',
    'Done body.'
  ].join('\n'));
  assert.deepEqual(result.map(phase => [phase.id, phase.title, phase.status]), [
    ['Q2', 'Canonical', 'OPEN'],
    ['Q3', 'Legacy', 'DONE']
  ]);
  assert.match(result[0].body, /Exact body/);
  assert.doesNotMatch(result[0].body, /Older work/);
});

check('preserves phase body bytes and exposes the writer-required shape', () => {
  const body = '## Q4 — Bytes\n\n**Status:** PARTIAL\n\nExact **markdown**, CRLF\r\n, and ---.';
  const phase = projection.parseQueuePhases(body)[0];
  assert.equal(phase.body, body);
  assert.equal(phase.detail, body);
  assert.equal(phase.statusRaw, 'PARTIAL');
  assert.equal(phase.statusLine, 2);
  assert.equal(phase.headingLine, 0);
});

check('refuses an unavailable queue input instead of projecting an empty queue', () => {
  assert.throws(
    () => projection.parseQueuePhases(undefined),
    { name: 'TypeError', message: 'BUILD-QUEUE projection input must be a string.' }
  );
});

check('parses an indexed root and slice corpus without installation state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-queue-projection-'));
  const queueDirectory = path.join(root, 'queue');
  fs.mkdirSync(queueDirectory, { recursive: true });
  const rootQueue = [
    '# BUILD-QUEUE',
    '',
    renderQueueIndex(['fleet']).trimEnd(),
    '## Q3 \u2014 Root phase',
    '',
    '**Status:** OPEN',
    ''
  ].join('\n');
  const sliceQueue = '## Q7 \u2014 Slice phase\n\n**Status:** PARTIAL\n';
  fs.writeFileSync(path.join(root, 'BUILD-QUEUE.md'), rootQueue, 'utf8');
  fs.writeFileSync(path.join(queueDirectory, 'fleet.md'), sliceQueue, 'utf8');
  try {
    const corpus = readQueueCorpus(path.join(root, 'BUILD-QUEUE.md'));
    const phases = projection.parseQueuePhases(corpus.text);
    const rootPhases = projection.parseQueuePhases(corpus.rootText);
    const slicePhases = corpus.slices.flatMap(slice => projection.parseQueuePhases(slice.text));
    assert.deepEqual(phases.map(phase => phase.id), ['Q3', 'Q7']);
    assert.deepEqual(rootPhases.map(phase => phase.id), ['Q3'], 'the root phase remains visible');
    assert.deepEqual(slicePhases.map(phase => phase.id), ['Q7'], 'the indexed package phase remains visible');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`build-queue-projection: ${checks} checks passed`);
