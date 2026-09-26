'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const queueSlice = require('../src/lib/build-queue-slice');

const queue = [
  '# Queue',
  '',
  '## Q1 — Alpha',
  '',
  '**Status:** OPEN',
  '',
  '**Authority:** R1 (directiveId: alpha)',
  ''
].join('\n');

function expectReadOnlyRefusal(callback, code) {
  let sideEffects = 0;
  const restorations = [];
  for (const [object, methods] of [
    [fs, ['writeFileSync', 'appendFileSync', 'renameSync']],
    [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'fork']]
  ]) {
    for (const method of methods) {
      const original = object[method];
      object[method] = function unexpectedSideEffect(...args) {
        sideEffects += 1;
        return original.apply(this, args);
      };
      restorations.push(() => { object[method] = original; });
    }
  }
  try {
    assert.throws(callback, error => {
      assert.equal(error && error.name, 'BuildQueueSliceError');
      assert.equal(error && error.code, code);
      return true;
    });
    assert.equal(sideEffects, 0, `${code} must refuse before writing or spawning`);
  } finally {
    for (const restore of restorations.reverse()) restore();
  }
}

expectReadOnlyRefusal(
  () => queueSlice.generatePackageQueueSlices({ queueMarkdown: queue, assignments: [] }),
  'QUEUE_SLICE_ASSIGNMENTS_INVALID'
);
expectReadOnlyRefusal(
  () => queueSlice.projectPackageQueueSlice({ queueMarkdown: queue, packageId: 'alpha', phaseIds: [] }),
  'QUEUE_SLICE_PHASE_IDS_INVALID'
);
expectReadOnlyRefusal(
  () => queueSlice.projectPackageQueueSlice({ queueMarkdown: queue, packageId: 'alpha', phaseIds: ['Q1', 'Q1'] }),
  'QUEUE_SLICE_PHASE_IDS_DUPLICATE'
);
expectReadOnlyRefusal(
  () => queueSlice.parseQueueBlocks(null),
  'QUEUE_SLICE_MARKDOWN_INVALID'
);

// The fallback is specifically for a parser failure which has no refusal code.
// Inject that dependency before loading a fresh copy of this module so the
// public parseQueueBlocks entry point, rather than a source-text assertion,
// drives the fallback.
const writerPath = require.resolve('../src/lib/build-queue-writer');
const slicePath = require.resolve('../src/lib/build-queue-slice');
const realWriterCache = require.cache[writerPath];
const realSliceCache = require.cache[slicePath];
require.cache[writerPath] = {
  id: writerPath,
  filename: writerPath,
  loaded: true,
  exports: { parseStrictQueue() { throw new Error('injected parser failure'); } },
  children: [],
  paths: []
};
delete require.cache[slicePath];
const injectedQueueSlice = require('../src/lib/build-queue-slice');
require.cache[writerPath] = realWriterCache;
require.cache[slicePath] = realSliceCache;
expectReadOnlyRefusal(
  () => injectedQueueSlice.parseQueueBlocks(queue),
  'QUEUE_SLICE_QUEUE_INVALID'
);

expectReadOnlyRefusal(
  () => queueSlice.parseQueueBlocks(queue.replace(
    '**Authority:** R1 (directiveId: alpha)',
    '**Authority:** R1 (directiveId: alpha)\n**Authority:** R2 (directiveId: beta)'
  )),
  'QUEUE_SLICE_AUTHORITY_AMBIGUOUS'
);

const instructionEnvelope = [
  '**Instructions (verbatim):**',
  '<!-- build-queue-writer:v1 bytes=1 -->',
  'x'
].join('\n');
expectReadOnlyRefusal(
  () => queueSlice.parseQueueBlocks(`${queue}${instructionEnvelope}\n${instructionEnvelope}\n`),
  'QUEUE_SLICE_INSTRUCTION_AMBIGUOUS'
);
expectReadOnlyRefusal(
  () => queueSlice.parseSerializedPackageQueueSlice(42, { expectedSha256: '0'.repeat(64) }),
  'QUEUE_SLICE_SERIALIZED_INVALID'
);
expectReadOnlyRefusal(
  () => queueSlice.serializePackageQueueSlice({}),
  'QUEUE_SLICE_SERIALIZE_INVALID'
);

console.log('build-queue-slice-refusals: 9 driven refusal paths passed');
