'use strict';

// Q50 regression: an indexed queue must never become an empty queue for the
// intent-fidelity consumer. An absent root is also a named corpus failure: it
// cannot be treated as evidence that there are no linked lanes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const corpus = require('../src/lib/build-queue-corpus');
const intent = require('../src/lib/intent-fidelity');
const intentCheck = require('../tools/intent-check');

const dash = '\u2014';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-queue-intent-consumer-'));
let checks = 0;

function check(name, fn) {
  fn();
  checks += 1;
  void name;
}

function expectCode(fn, code) {
  assert.throws(fn, error => error && error.code === code);
}

function write(relativePath, text) {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
}

try {
  check('a monolithic queue still returns its text', () => {
    const repo = path.join(root, 'monolith');
    write('monolith/BUILD-QUEUE.md', `## Q1 ${dash} Monolith (owner request R1)\n`);
    assert.match(intent.readQueueText(repo), /owner request R1/);
  });

  check('an absent root fails closed instead of projecting an empty queue', () => {
    expectCode(() => intent.readQueueText(path.join(root, 'no-root')), 'QUEUE_CORPUS_ROOT_UNREADABLE');
  });

  check('a missing indexed slice is surfaced rather than converted to empty text', () => {
    const repo = path.join(root, 'missing-slice');
    write('missing-slice/BUILD-QUEUE.md', corpus.renderQueueIndex(['owner.ledger']));
    expectCode(() => intent.readQueueText(repo), 'QUEUE_CORPUS_SLICE_UNREADABLE');
  });

  check('a duplicate phase across indexed slices is surfaced rather than converted to empty text', () => {
    const repo = path.join(root, 'duplicate-phase');
    write('duplicate-phase/BUILD-QUEUE.md', corpus.renderQueueIndex(['alpha', 'beta']));
    write('duplicate-phase/queue/alpha.md', `## Q2 ${dash} Alpha\n\n**Status:** OPEN\n`);
    write('duplicate-phase/queue/beta.md', `## Q2 ${dash} Beta\n\n**Status:** OPEN\n`);
    expectCode(() => intent.readQueueText(repo), 'QUEUE_CORPUS_PHASE_DUPLICATE');
  });

  check('an invalid indexed root is surfaced rather than converted to empty text', () => {
    const repo = path.join(root, 'invalid-index');
    write('invalid-index/BUILD-QUEUE.md', [
      '## Package queue index',
      corpus.INDEX_BEGIN,
      '- invalid index entry',
      corpus.INDEX_END,
      ''
    ].join('\n'));
    expectCode(() => intent.readQueueText(repo), 'QUEUE_CORPUS_INDEX_LINE_INVALID');
  });

  check('the CLI response identifies a corpus failure rather than proposing a heading edit', () => {
    const response = intentCheck.queueCorpusUnavailable('lane-7', { code: 'QUEUE_CORPUS_SLICE_UNREADABLE' });
    assert.deepEqual(response, {
      ok: false,
      code: 'INTENT_QUEUE_CORPUS_UNAVAILABLE',
      laneId: 'lane-7',
      queueCode: 'QUEUE_CORPUS_SLICE_UNREADABLE',
      note: "repair the BUILD-QUEUE corpus before resolving this lane's owner request"
    });
  });

  console.log(`build-queue-intent-consumer: ${checks} checks passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
