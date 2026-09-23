'use strict';

require('./lib/isolated-environment').activate('github-mutation-refusals');
const assert = require('node:assert/strict');
const github = require('../src/lib/providers/github');

const input = {
  owner: 'acme',
  repo: 'widgets',
  title: 'Refusal coverage',
  idempotencyKey: 'github-refusal-test-0001'
};

function harness({ executingError, requestError, succeedError } = {}) {
  const calls = [];
  const handle = { id: 'operation-1' };
  const state = {
    reserveOperation(details) {
      calls.push(['reserve', details]);
      return { disposition: 'reserved', handle };
    },
    markOperationExecuting(received, details) {
      calls.push(['executing', received, details]);
      if (executingError) throw executingError;
      return { handle };
    },
    succeedOperation(received, details) {
      calls.push(['succeed', received, details]);
      if (succeedError) throw succeedError;
    },
    markOperationUncertain(received, details) {
      calls.push(['uncertain', received, details]);
    },
    failOperation(received, details) {
      calls.push(['fail', received, details]);
    }
  };
  const dependencies = {
    state,
    assertActive: (...args) => calls.push(['active', ...args]),
    hashInput: () => 'input-hash',
    now: () => 1_800_000_000_000,
    getSecret: () => 'vault-github-token',
    record: (...args) => calls.push(['audit', ...args]),
    request: async (...args) => {
      calls.push(['request', ...args]);
      if (requestError) throw requestError;
      return { body: { number: 17, title: input.title } };
    }
  };
  return { calls, dependencies };
}

function count(calls, name) {
  return calls.filter(call => call[0] === name).length;
}

(async () => {
  {
    const original = new Error('state unavailable before request');
    const { calls, dependencies } = harness({ executingError: original });
    await assert.rejects(github.issueCreate(input, dependencies), error => error === original);
    assert.equal(count(calls, 'request'), 0, 'pre-request refusal must not write to GitHub');
    assert.equal(count(calls, 'audit'), 0, 'pre-request refusal must not write a success audit');
    assert.equal(count(calls, 'uncertain'), 0);
    assert.deepEqual(calls.find(call => call[0] === 'fail')[2], {
      errorCode: 'GITHUB_PRE_REQUEST_FAILED',
      errorMessage: 'The GitHub request did not begin; a retry may be safe after the error is corrected.',
      retryAtMs: 1_800_000_000_000
    });
  }

  {
    const original = new Error('connection lost after request began');
    const { calls, dependencies } = harness({ requestError: original });
    await assert.rejects(github.issueCreate(input, dependencies), error => error === original);
    assert.equal(count(calls, 'request'), 1, 'the failing provider request must not be replayed');
    assert.equal(count(calls, 'audit'), 0, 'an uncertain external outcome must not write a success audit');
    assert.equal(count(calls, 'fail'), 0);
    assert.deepEqual(calls.find(call => call[0] === 'uncertain')[2], {
      errorCode: 'GITHUB_EXTERNAL_OUTCOME_UNCERTAIN',
      errorMessage: 'The GitHub request began, so its external outcome is uncertain and automatic replay is blocked.'
    });
  }

  {
    const { calls, dependencies } = harness({ succeedError: new Error('durable state write failed') });
    await assert.rejects(github.issueCreate(input, dependencies), error => {
      assert.equal(error.code, 'GITHUB_EXTERNAL_COMMIT_UNRECORDED');
      assert.match(error.message, /Automatic replay is blocked/);
      return true;
    });
    assert.equal(count(calls, 'request'), 1, 'a completed external write must not be replayed');
    assert.equal(count(calls, 'succeed'), 1);
    assert.equal(count(calls, 'audit'), 0, 'an unrecorded completion must not write a success audit');
    assert.equal(count(calls, 'fail'), 0);
    assert.ok(calls.filter(call => call[0] === 'uncertain').length >= 1);
    for (const call of calls.filter(call => call[0] === 'uncertain')) {
      assert.equal(call[2].errorCode, 'GITHUB_EXTERNAL_COMMIT_UNRECORDED');
    }
  }

  console.log('GitHub mutation refusal tests passed.');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
