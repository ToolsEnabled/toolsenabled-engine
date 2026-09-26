'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createCodexCliTransport } = require('../src/lib/cloud-agent/codex-cli-transport');
const { CloudAgentError } = require('../src/lib/cloud-agent/errors');

const TASK_ID = 'task_e_abc123DEF456';

async function rejectsWithCode(promise, expectedCode) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof CloudAgentError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

function childWithoutStdin() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = null;
  child.killCount = 0;
  child.kill = () => { child.killCount += 1; };
  return child;
}

(async () => {
  {
    let spawnAttempts = 0;
    const spawnImpl = () => {
      spawnAttempts += 1;
      throw new Error('executable lookup failed');
    };
    const transport = createCodexCliTransport({ spawnImpl });

    await rejectsWithCode(transport.getTask(TASK_ID), 'CODEX_CLI_SPAWN_FAILED');
    assert.equal(spawnAttempts, 1, 'the transport must make only the refused spawn attempt');
  }

  {
    let spawnAttempts = 0;
    const spawnImpl = () => {
      spawnAttempts += 1;
      return null;
    };
    const transport = createCodexCliTransport({ spawnImpl });

    await rejectsWithCode(transport.getTask(TASK_ID), 'CODEX_CLI_SPAWN_FAILED');
    assert.equal(spawnAttempts, 1, 'an invalid spawn result must not trigger another spawn');
  }

  {
    let spawnAttempts = 0;
    const child = childWithoutStdin();
    const spawnImpl = () => {
      spawnAttempts += 1;
      return child;
    };
    const transport = createCodexCliTransport({
      spawnImpl,
      branch: 'main',
      buildQuery: () => 'submit this exact query'
    });

    await rejectsWithCode(
      transport.createTask({ environment: 'env-main' }),
      'CODEX_CLI_STDIN_UNAVAILABLE'
    );
    assert.equal(spawnAttempts, 1, 'stdin refusal must not retry or spawn another process');
    assert.equal(child.killCount, 1, 'the child that cannot accept the query must be killed');
    assert.equal(child.stdin, null, 'no query can be written when the child exposes no stdin');
  }

  console.log('codex-cli transport process refusal tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
