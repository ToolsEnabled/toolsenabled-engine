'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { harvestBatch } = require('../src/lib/cloud-agent/batch-harvest');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-harvest-refusals-'));
const target = 'src/lib/cloud-agent/widget.js';

function journal(label) {
  const file = path.join(temp, `${label}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ kind: 'intent', index: 1, target }),
    JSON.stringify({ kind: 'launched', index: 1, taskId: `task-${label}`, account: 'acct-a' }),
  ].join('\n'));
  return file;
}

function unrelatedTestDiff() {
  const file = 'tests/unrelated.test.js';
  return [
    `diff --git a/${target} b/${target}`,
    `--- a/${target}`,
    `+++ b/${target}`,
    '@@ -1 +1 @@',
    '-before',
    '+after',
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    '-old assertion',
    '+new assertion',
  ].join('\n');
}

async function run(label, fetchTask) {
  const outDir = path.join(temp, label);
  let calls = 0;
  const result = await harvestBatch({
    journalFile: journal(label),
    outDir,
    concurrency: 1,
    retryDelaysMs: [],
    fetchTask: async (request) => {
      calls += 1;
      return fetchTask(request);
    },
  });
  const manifest = JSON.parse(fs.readFileSync(result.manifestFile, 'utf8'));
  return { calls, manifest, outDir, result };
}

function assertNoDiffWritten(run) {
  assert.deepEqual(fs.readdirSync(run.outDir), ['manifest.json'],
    'a provider refusal must not fabricate or persist a task diff');
}

(async () => {
  const errored = await run('errored', async () => ({
    state: 'errored',
    detail: 'sandbox exited before the task ran',
  }));
  assert.deepEqual(errored.result.tally, { ERRORED: 1 });
  assert.equal(errored.manifest.tasks[0].verdict, 'ERRORED');
  assert.match(errored.manifest.tasks[0].note, /sandbox exited/);
  assert.equal(errored.calls, 1, 'an errored terminal task is not fetched or spawned again');
  assertNoDiffWritten(errored);

  const fetchError = await run('fetch-error', async () => {
    throw new Error('transport executable is unavailable');
  });
  assert.deepEqual(fetchError.result.tally, { FETCH_ERROR: 1 });
  assert.equal(fetchError.manifest.tasks[0].verdict, 'FETCH_ERROR');
  assert.match(fetchError.manifest.tasks[0].note, /transport executable/);
  assert.equal(fetchError.calls, 1, 'a non-throttle transport refusal is not retried or spawned');
  assertNoDiffWritten(fetchError);

  const throttled = await run('throttled', async () => {
    throw new Error('provider replied 429 Too Many Requests');
  });
  assert.deepEqual(throttled.result.tally, { THROTTLED: 1 });
  assert.equal(throttled.manifest.tasks[0].verdict, 'THROTTLED');
  assert.match(throttled.manifest.tasks[0].note, /429 Too Many Requests/);
  assert.equal(throttled.calls, 1, 'an exhausted (zero-delay) retry ladder makes no extra provider call');
  assertNoDiffWritten(throttled);

  const nearFence = await run('near-fence', async () => ({ state: 'ready', diff: unrelatedTestDiff() }));
  assert.deepEqual(nearFence.result.tally, { NEAR_FENCE: 1 });
  assert.equal(nearFence.manifest.tasks[0].verdict, 'NEAR_FENCE');
  assert.match(nearFence.manifest.tasks[0].note, /names the target nowhere/);
  assert.equal(nearFence.calls, 1);
  assert.deepEqual(fs.readdirSync(nearFence.outDir).sort(), ['001-widget.js.diff', 'manifest.json'],
    'NEAR_FENCE is a review grade, so its real provider diff remains available for review');

  console.log('cloud batch-harvest driven refusals passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
