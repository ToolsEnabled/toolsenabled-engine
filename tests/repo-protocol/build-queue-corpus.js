'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const corpus = require('../../src/lib/build-queue-corpus');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function expectCode(fn, code) {
  assert.throws(fn, error => error && error.code === code);
}

function phase(id, status = 'OPEN') {
  return `## ${id} — fixture\n\n**Status:** ${status}\n\n**Build:** exact bytes\n\n`;
}

check('a monolith remains byte-compatible and keeps its historical hash', () => {
  const root = `# queue\n\n${phase('Q2')}`;
  const result = corpus.composeQueueCorpus({ rootFile: 'BUILD-QUEUE.md', rootMarkdown: root });
  assert.equal(result.indexed, false);
  assert.equal(result.text, root);
  assert.equal(result.sha256, corpus.sha256(root));
  assert.deepEqual(result.files, ['BUILD-QUEUE.md']);
});

check('an indexed root reads sorted canonical slices into one corpus', () => {
  const index = corpus.renderQueueIndex(['repo-protocol', 'desktop.browser']);
  const root = `# queue\n\n${index}${phase('Q3', 'BLOCKED')}`;
  const slices = {
    'queue/desktop.browser.md': phase('Q1'),
    'queue/repo-protocol.md': phase('Q2', 'IN-PROGRESS')
  };
  const result = corpus.composeQueueCorpus({ rootFile: 'BUILD-QUEUE.md', rootMarkdown: root, sliceMarkdownByPath: slices });
  assert.equal(result.indexed, true);
  assert.deepEqual(result.index.map(entry => entry.packageId), ['desktop.browser', 'repo-protocol']);
  assert.deepEqual(result.files, ['BUILD-QUEUE.md', 'queue/desktop.browser.md', 'queue/repo-protocol.md']);
  assert.match(result.text, /## Q1/);
  assert.match(result.text, /## Q2/);
  assert.match(result.text, /## Q3/);
});

check('index rendering, parsing, and removal round-trip exactly', () => {
  const index = corpus.renderQueueIndex(['owner.ledger']);
  const root = `prefix\n${index}suffix\n`;
  assert.deepEqual(corpus.parseQueueIndex(root), [{ packageId: 'owner.ledger', path: 'queue/owner.ledger.md' }]);
  assert.equal(corpus.removeQueueIndex(root), 'prefix\nsuffix\n');
});

check('malformed, unsorted, mismatched, and duplicate index entries fail closed', () => {
  const begin = corpus.INDEX_BEGIN;
  const end = corpus.INDEX_END;
  expectCode(() => corpus.parseQueueIndex(`## Package queue index\n${begin}\n- bad\n${end}\n`), 'QUEUE_CORPUS_INDEX_LINE_INVALID');
  expectCode(() => corpus.parseQueueIndex(`## Package queue index\n${begin}\n- \`z.last\`: [queue/z.last.md](queue/z.last.md)\n- \`a.first\`: [queue/a.first.md](queue/a.first.md)\n${end}\n`), 'QUEUE_CORPUS_INDEX_ORDER_INVALID');
  expectCode(() => corpus.parseQueueIndex(`## Package queue index\n${begin}\n- \`owner.ledger\`: [queue/other.md](queue/other.md)\n${end}\n`), 'QUEUE_CORPUS_INDEX_PATH_INVALID');
  expectCode(() => corpus.renderQueueIndex(['owner.ledger', 'owner.ledger']), 'QUEUE_CORPUS_INDEX_PACKAGE_DUPLICATE');
});

check('the physical slice set and phase ids must be one-to-one', () => {
  const root = `${corpus.renderQueueIndex(['owner.ledger'])}${phase('Q1')}`;
  expectCode(() => corpus.composeQueueCorpus({ rootFile: 'BUILD-QUEUE.md', rootMarkdown: root, sliceMarkdownByPath: {} }), 'QUEUE_CORPUS_SLICE_SET_INVALID');
  expectCode(() => corpus.composeQueueCorpus({
    rootFile: 'BUILD-QUEUE.md', rootMarkdown: root,
    sliceMarkdownByPath: { 'queue/owner.ledger.md': phase('Q1') }
  }), 'QUEUE_CORPUS_PHASE_DUPLICATE');
});

check('filesystem reads reject a missing indexed slice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-corpus-'));
  const rootFile = path.join(dir, 'BUILD-QUEUE.md');
  fs.writeFileSync(rootFile, corpus.renderQueueIndex(['owner.ledger']), 'utf8');
  expectCode(() => corpus.readQueueCorpus(rootFile), 'QUEUE_CORPUS_SLICE_UNREADABLE');
});

check('the corpus digest binds slice path and bytes', () => {
  const root = corpus.renderQueueIndex(['owner.ledger']);
  const first = corpus.composeQueueCorpus({ rootFile: 'BUILD-QUEUE.md', rootMarkdown: root, sliceMarkdownByPath: { 'queue/owner.ledger.md': phase('Q1') } });
  const second = corpus.composeQueueCorpus({ rootFile: 'BUILD-QUEUE.md', rootMarkdown: root, sliceMarkdownByPath: { 'queue/owner.ledger.md': phase('Q1', 'PARTIAL') } });
  assert.notEqual(first.sha256, second.sha256);
});

console.log(`build-queue-corpus: ${checks} checks passed`);
