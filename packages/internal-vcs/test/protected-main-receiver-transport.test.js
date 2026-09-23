'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFilekeeperProtectedMainReceiverTransport,
} = require('../src');

function processResult({ state = 'success', stdout = '', stderr = '', exitCode = state === 'success' ? 0 : 1, errorCode = null } = {}) {
  return { state, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode, errorCode };
}

function scriptedRunner(results) {
  const calls = [];
  return {
    calls,
    runner: {
      runChecked(input) {
        calls.push(input);
        const result = results.shift();
        assert.ok(result, `unexpected argv: ${input.argv.join(' ')}`);
        return result;
      },
    },
  };
}

function createTransport(runner) {
  return createFilekeeperProtectedMainReceiverTransport({
    repositoryLocator: 'C:\\worktree', remoteName: 'origin', branchName: 'main', runner,
  });
}

test('receiver transport uses Filekeeper-owned explicit argv for every allowed receiver action', () => {
  const scripted = scriptedRunner([
    processResult({ stdout: 'main\n' }),
    processResult(),
    processResult({ stdout: '?? scratch.txt\n' }),
    processResult({ stdout: '0\n' }),
    processResult({ stdout: '2\n' }),
    processResult(),
  ]);
  const transport = createTransport(scripted.runner);

  assert.deepEqual(transport.observeBranch(), { state: 'SAFE', exitCode: 0, errorCode: null, detail: '', branch: 'main' });
  assert.deepEqual(transport.fetchPrune(), { state: 'SAFE', exitCode: 0, errorCode: null, detail: '' });
  assert.deepEqual(transport.observeReceiver(), { state: 'SAFE', dirtyPaths: ['scratch.txt'], ahead: 0, behind: 2 });
  assert.deepEqual(transport.fastForward(), { state: 'SAFE', exitCode: 0, errorCode: null, detail: '' });

  assert.deepEqual(scripted.calls.map(call => call.argv), [
    ['branch', '--show-current'],
    ['fetch', '--prune', 'origin'],
    ['status', '--porcelain=v1', '--untracked-files=all'],
    ['rev-list', '--count', 'origin/main..HEAD'],
    ['rev-list', '--count', 'HEAD..origin/main'],
    ['merge', '--ff-only', 'origin/main'],
  ]);
  assert.ok(scripted.calls.every(call => call.executable === 'git' && call.cwd === 'C:\\worktree'));
});

test('receiver transport preserves failure and indeterminate results without treating them as clean', () => {
  const fetch = scriptedRunner([processResult({ state: 'indeterminate', exitCode: null, errorCode: 'ETIMEDOUT' })]);
  assert.deepEqual(createTransport(fetch.runner).fetchPrune(), {
    state: 'UNKNOWN', exitCode: null, errorCode: 'ETIMEDOUT', detail: '',
  });

  const inspection = scriptedRunner([processResult({ state: 'failure', stderr: 'index locked', exitCode: 128 })]);
  assert.deepEqual(createTransport(inspection.runner).observeReceiver(), {
    state: 'UNSAFE', exitCode: 128, errorCode: null, detail: 'index locked',
  });

  const invalidCount = scriptedRunner([
    processResult({ stdout: '' }), processResult({ stdout: 'unknown\n' }), processResult({ stdout: '0\n' }),
  ]);
  const result = createTransport(invalidCount.runner).observeReceiver();
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(result.errorCode, 'VCS_GIT_COMPATIBILITY');
});

test('transport has no generic command surface and fast-forward failures remain unsafe', () => {
  const scripted = scriptedRunner([processResult({ state: 'failure', stderr: 'not a fast-forward', exitCode: 1 })]);
  const transport = createTransport(scripted.runner);
  assert.equal(typeof transport.run, 'undefined');
  assert.deepEqual(transport.fastForward(), {
    state: 'UNSAFE', exitCode: 1, errorCode: null, detail: 'not a fast-forward',
  });
  assert.deepEqual(scripted.calls[0].argv, ['merge', '--ff-only', 'origin/main']);
});
