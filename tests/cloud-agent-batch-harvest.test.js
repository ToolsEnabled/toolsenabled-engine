/* Mutation check (2026-08-27):
 * Exact edit: `tests.length > 1` -> `tests.length > 2` in batch-harvest.js.
 * The edit landed: yes (the mutated source line was printed and verified).
 * This isolated test went red: yes (expected OUT_OF_FENCE, got IN_FENCE).
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const batchHarvest = require('../src/lib/cloud-agent/batch-harvest');

function diffFor(file, added = 'changed') {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    '-before',
    `+${added}`,
  ].join('\n');
}

const exported = Object.keys(batchHarvest).sort();
assert.deepEqual(exported, ['filesOf', 'grade', 'harvestBatch', 'readWave'],
  'the module exposes the four batch-harvest operations');

const target = 'src/lib/cloud-agent/widget.js';
const targetAndOwnTest = [
  diffFor(target),
  diffFor('tests/cloud-agent-widget.test.js', 'assert widget.js behavior'),
].join('\n');

assert.deepEqual(batchHarvest.filesOf(targetAndOwnTest), [
  target,
  'tests/cloud-agent-widget.test.js',
], 'filesOf returns each changed path once in diff order');
assert.equal(batchHarvest.grade('', target).verdict, 'NO_DIFF',
  'an empty provider diff is a settled no-change answer');
assert.equal(batchHarvest.grade(targetAndOwnTest, target).verdict, 'IN_FENCE',
  'the target and its single named test stay inside the declared fence');

const twoTests = [
  diffFor(target),
  diffFor('tests/cloud-agent-widget.test.js', 'assert widget.js behavior'),
  diffFor('tests/cloud-agent-widget-edge.test.js', 'assert widget.js edge behavior'),
].join('\n');
const rejected = batchHarvest.grade(twoTests, target);
assert.equal(rejected.verdict, 'OUT_OF_FENCE',
  'touching two tests is rejected because the harvest fence permits at most one');
assert.match(rejected.note, /2 test files touched; the fence allows one/,
  'the rejection tells a reviewer exactly which fence rule was exceeded');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-harvest-test-'));
try {
  const journalFile = path.join(temp, 'journal.jsonl');
  fs.writeFileSync(journalFile, [
    JSON.stringify({ kind: 'intent', index: 1, target }),
    JSON.stringify({ kind: 'launched', index: 1, taskId: 'task-1', account: 'acct-a' }),
  ].join('\n'));

  assert.deepEqual([...batchHarvest.readWave(journalFile, fs)], [{
    index: 1,
    taskId: 'task-1',
    account: 'acct-a',
    target,
  }], 'readWave joins launched tasks to their declared targets');

  (async () => {
    const outDir = path.join(temp, 'harvest');
    const result = await batchHarvest.harvestBatch({
      journalFile,
      outDir,
      concurrency: 1,
      fetchTask: async ({ taskId, account }) => {
        assert.deepEqual({ taskId, account }, { taskId: 'task-1', account: 'acct-a' });
        return { state: 'ready', diff: targetAndOwnTest };
      },
    });

    assert.equal(result.taskCount, 1);
    assert.deepEqual(result.tally, { IN_FENCE: 1 });
    const manifest = JSON.parse(fs.readFileSync(result.manifestFile, 'utf8'));
    assert.equal(manifest.tasks[0].verdict, 'IN_FENCE');
    assert.equal(manifest.tasks[0].url, 'https://chatgpt.com/codex/tasks/task-1');
    assert.ok(fs.existsSync(path.join(outDir, '001-widget.js.diff')),
      'a non-empty provider diff is retained beside the manifest');
    console.log('cloud-agent batch-harvest behavior passed');
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} finally {
  process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
}
