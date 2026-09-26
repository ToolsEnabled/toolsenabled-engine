'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const batchTarget = require('../src/lib/cloud-agent/batch-target');
const journal = require('../src/lib/cloud-agent/batch-journal');
const { runBatch } = require('../src/lib/cloud-agent/batch-runner');

const FRESH_MIRROR = { checkMirrorFreshness: async () => ({ fresh: true }) };
let sequence = 0;

function declaration(label) {
  sequence += 1;
  const target = `src/${label}.js`;
  return {
    schemaVersion: batchTarget.BATCH_SCHEMA,
    batchId: `dispatch-refusal-${label}-${sequence}`,
    project: 'engine',
    tasks: [{
      target,
      contract: [
        'CONTRACT/1',
        'role      TESTER',
        `target    ${target}`,
        `do        drive the ${label} dispatch refusal through runBatch`,
        `because   1 named ${label} refusal has no driven test in this repository`,
        'done      the journal names the refusal and records no launch',
        `report    REPORT-${label}.md`
      ].join('\n')
    }],
    bounds: { launchesPerMinute: 1, accounts: 1 }
  };
}

async function exercise(label, dispatch) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cloud-dispatch-${label}-`));
  const input = declaration(label);
  const admission = await batchTarget.admitBatch(input, { mirrorApi: FRESH_MIRROR });
  let dispatchCalls = 0;

  try {
    const summary = await runBatch({
      admission,
      declaration: input,
      stateRoot,
      accounts: ['account-one'],
      now: () => 1000,
      sleep: async () => {},
      dispatch: async (request) => {
        dispatchCalls += 1;
        return dispatch(request);
      }
    });
    return { summary, dispatchCalls, parsed: journal.readJournal(summary.journalFile) };
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
}

(async () => {
  {
    const observed = await exercise('task-id-unusable', async () => ({ taskId: { opaque: 'provider-handle' } }));
    assert.deepEqual(
      { launched: observed.summary.launched, refused: observed.summary.refused, remaining: observed.summary.remaining, unresolved: observed.summary.unresolved },
      { launched: 0, refused: 1, remaining: 0, unresolved: 0 },
      'an unusable, present task id returns a definite refused summary rather than claiming a launch or unknown outcome'
    );
    assert.equal(observed.dispatchCalls, 1, 'the refusal is reached from the injected dispatcher response');
    assert.equal(observed.parsed.refused.length, 1, 'exactly one refusal is persisted');
    assert.equal(observed.parsed.refused[0].code, 'CLOUD_DISPATCH_TASK_ID_UNUSABLE');
    assert.match(observed.parsed.refused[0].reason, /taskId of type object/);
    assert.equal(observed.parsed.launched.length, 0, 'no launched outcome is written for an unusable id');
  }

  {
    const observed = await exercise('uncoded-provider-throw', async () => {
      const refusal = new Error('provider rejected the request');
      refusal.providerAnswered = true;
      throw refusal;
    });
    assert.deepEqual(
      { launched: observed.summary.launched, refused: observed.summary.refused, remaining: observed.summary.remaining, unresolved: observed.summary.unresolved },
      { launched: 0, refused: 1, remaining: 0, unresolved: 0 },
      'an uncoded provider refusal returns a definite refused summary rather than escaping or becoming unresolved'
    );
    assert.equal(observed.dispatchCalls, 1, 'the fallback code is reached from an injected provider-answer throw');
    assert.equal(observed.parsed.refused.length, 1, 'exactly one refusal is persisted');
    assert.equal(observed.parsed.refused[0].code, 'CLOUD_DISPATCH_THREW');
    assert.equal(observed.parsed.refused[0].reason, 'provider rejected the request');
    assert.equal(observed.parsed.launched.length, 0, 'no launched outcome is written for a provider refusal');
  }

  console.log('cloud batch runner dispatch refusal tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
