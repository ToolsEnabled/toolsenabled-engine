'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const batchTarget = require('../../../src/lib/cloud-agent/batch-target');
const { runBatch } = require('../../../src/lib/cloud-agent/batch-runner');

function declaration() {
  const target = 'src/example.js';
  return {
    schemaVersion: batchTarget.BATCH_SCHEMA,
    batchId: 'firsttest-batch-runner',
    project: 'engine',
    tasks: [{
      target,
      contract: [
        'CONTRACT/1',
        'role      TESTER',
        `target    ${target}`,
        'do        add a focused behavioural test for the runner',
        `because   448 lines in the runner require direct behavioural coverage measured at ${target}`,
        'done      the focused test runs alone and observes the journal before dispatch',
        'report    REPORT-firsttest-example.md'
      ].join('\n')
    }],
    bounds: { launchesPerMinute: 1, accounts: 1 }
  };
}

(async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'firsttest-batch-runner-'));
  try {
    const input = declaration();
    const admission = await batchTarget.admitBatch(input, {
      mirrorApi: { checkMirrorFreshness: async () => ({ fresh: true }) }
    });
    let recordsSeenByDispatch;

    const result = await runBatch({
      admission,
      declaration: input,
      stateRoot,
      accounts: ['account-one'],
      now: () => 1000,
      sleep: async () => {},
      dispatch: async ({ index, task, account }) => {
        recordsSeenByDispatch = fs.readFileSync(path.join(stateRoot, `${input.batchId}.jsonl`), 'utf8')
          .trim().split('\n').map(JSON.parse);
        assert.deepEqual({ index, task, account }, { index: 0, task: input.tasks[0], account: 'account-one' });
        return { taskId: 'provider-task-1' };
      }
    });

    assert.equal(recordsSeenByDispatch.some((row) => row.kind === 'intent' && row.index === 0), true,
      'runBatch must persist the dispatch intent before calling the provider');
    assert.equal(recordsSeenByDispatch.some((row) => row.kind === 'launched'), false,
      'runBatch must not claim a launch before the provider answers');
    assert.deepEqual(
      { launched: result.launched, refused: result.refused, remaining: result.remaining, unresolved: result.unresolved },
      { launched: 1, refused: 0, remaining: 0, unresolved: 0 }
    );
    console.log('batch-runner focused behaviour test passed');
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
