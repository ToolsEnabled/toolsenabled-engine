#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const path = require('node:path');
const {
  INDEX_BEGIN,
  INDEX_END,
  INDEX_HEADING,
  composeQueueCorpus,
  parseQueueIndex,
  readQueueCorpus,
  removeQueueIndex,
  renderQueueIndex
} = require('../src/lib/build-queue-corpus');

let writes = 0;
let spawns = 0;
const originalWriteFileSync = fs.writeFileSync;
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;
fs.writeFileSync = (...args) => {
  writes += 1;
  return originalWriteFileSync(...args);
};
childProcess.spawn = (...args) => {
  spawns += 1;
  return originalSpawn(...args);
};
childProcess.spawnSync = (...args) => {
  spawns += 1;
  return originalSpawnSync(...args);
};

let checks = 0;

function refuses(code, action, verify = () => {}) {
  const beforeWrites = writes;
  const beforeSpawns = spawns;
  let error;
  assert.throws(action, candidate => {
    error = candidate;
    assert.equal(candidate.name, 'BuildQueueCorpusError');
    assert.equal(candidate.code, code);
    return true;
  });
  verify(error);
  assert.equal(writes, beforeWrites, `${code} must not write before refusing`);
  assert.equal(spawns, beforeSpawns, `${code} must not spawn before refusing`);
  checks += 1;
}

try {
  refuses('QUEUE_CORPUS_FILE_REQUIRED', () => readQueueCorpus(''));

  const unreadableReads = [];
  refuses('QUEUE_CORPUS_ROOT_UNREADABLE', () => readQueueCorpus('/missing/BUILD-QUEUE.md', {
    fsImpl: {
      readFileSync(file, encoding) {
        unreadableReads.push({ file, encoding });
        const error = new Error('fixture refusal');
        error.code = 'EACCES';
        throw error;
      }
    }
  }), error => assert.equal(error.details.causeCode, 'EACCES'));
  assert.deepEqual(unreadableReads, [{ file: path.resolve('/missing/BUILD-QUEUE.md'), encoding: 'utf8' }]);

  refuses('QUEUE_CORPUS_INPUT_INVALID', () => composeQueueCorpus());
  refuses('QUEUE_CORPUS_INPUT_INVALID', () => composeQueueCorpus({
    rootFile: 'BUILD-QUEUE.md',
    rootMarkdown: '# Queue\n',
    sliceMarkdownByPath: []
  }));
  refuses('QUEUE_CORPUS_ROOT_INVALID', () => parseQueueIndex(Buffer.from('not markdown')));
  refuses('QUEUE_CORPUS_INDEX_PACKAGES_INVALID', () => renderQueueIndex([]));

  refuses('QUEUE_CORPUS_INDEX_AMBIGUOUS', () => parseQueueIndex(
    `${INDEX_HEADING}\n${INDEX_HEADING}\n${INDEX_BEGIN}\n${INDEX_END}\n`
  ));
  refuses('QUEUE_CORPUS_INDEX_MALFORMED', () => parseQueueIndex(
    `${INDEX_HEADING}\n${INDEX_END}\n${INDEX_BEGIN}\n`
  ));
  refuses('QUEUE_CORPUS_INDEX_EMPTY', () => parseQueueIndex(
    `${INDEX_HEADING}\n${INDEX_BEGIN}\n${INDEX_END}\n`
  ));
  refuses('QUEUE_CORPUS_INDEX_MISSING', () => removeQueueIndex('# Queue\n\nNo package index.\n'));

  const indexedRoot = `${INDEX_HEADING}\n${INDEX_BEGIN}\n- \`alpha\`: [queue/alpha.md](queue/alpha.md)\n${INDEX_END}\n`;
  refuses('QUEUE_CORPUS_SLICE_INVALID', () => composeQueueCorpus({
    rootFile: 'BUILD-QUEUE.md',
    rootMarkdown: indexedRoot,
    sliceMarkdownByPath: { 'queue/alpha.md': Buffer.from('not markdown text') }
  }));
} finally {
  fs.writeFileSync = originalWriteFileSync;
  childProcess.spawn = originalSpawn;
  childProcess.spawnSync = originalSpawnSync;
}

process.stdout.write(`build queue corpus refusals: ${checks} driven checks passed\n`);
