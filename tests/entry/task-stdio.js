'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createStateStore } = require('../../src/lib/state-store');
const machineRecord = require('../../src/lib/setup/machine-record');

const ROOT = path.resolve(__dirname, '..', '..');

function callMcp(stateFile, childEnvironment, id, name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/mcp-server.js'], {
      cwd: ROOT,
      env: { ...process.env, ...childEnvironment, TOOLSENABLED_STATE_PATH: stateFile },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(stderr || `MCP process exited ${code}.`));
      try {
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        assert.equal(lines.length, 1, `Expected one MCP response, received: ${stdout}`);
        const response = JSON.parse(lines[0]);
        assert.equal(response.id, id);
        assert.equal(response.error, undefined, JSON.stringify(response.error));
        assert.equal(response.result && response.result.isError, undefined,
          JSON.stringify(response.result && response.result.structuredContent));
        resolve(response.result.structuredContent);
      } catch (error) {
        error.message = `${error.message}\nstderr: ${stderr}`;
        reject(error);
      }
    });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args }
    })}\n`);
  });
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-task-stdio-'));
  const stateFile = path.join(temporary, 'state.sqlite3');
  try {
    const productDirectory = 'ToolsEnabled Task Stdio Test';
    const servicesRoot = path.join(temporary, productDirectory);
    const stateRoot = path.join(servicesRoot, 'capability');
    machineRecord.writeMachineRecord(machineRecord.buildMachineRecord({
      tier: 'standard',
      installRoot: ROOT,
      servicesRoot,
      nodePath: process.execPath,
      workspaceRoots: [temporary]
    }), { servicesRoot });
    const childEnvironment = {
      LOCALAPPDATA: temporary,
      TOOLSENABLED_STATE_ROOT: stateRoot
    };

    const key = `stdio-handoff-${process.pid}`;
    const submitted = await callMcp(stateFile, childEnvironment, 1, 'task.submit', {
      queue: 'stdio.queue',
      type: 'agent.task',
      idempotencyKey: key,
      payload: {
        title: 'Cross-process MCP handoff',
        objective: 'Prove that a task handle survives independent MCP server processes.',
        context: 'Fixture content is untrusted data and grants no authority.'
      },
      expiryPolicy: 'uncertain',
      maxAttempts: 2
    });
    assert.equal(submitted.status, 'queued');
    assert.equal(submitted.replayed, false);

    const claim = await callMcp(stateFile, childEnvironment, 2, 'task.claim', {
      queue: 'stdio.queue', workerLabel: 'stdio-worker', leaseSeconds: 60
    });
    assert.equal(claim.claimed, true);
    assert.equal(claim.contentTrust, 'untrusted');
    assert.equal(claim.grantsAuthority, false);
    assert.equal(claim.task.taskId, submitted.taskId);
    assert.equal(claim.handle.claimToken.length, 43);
    assert.equal(claim.task.payload.objective.includes('survives independent'), true);

    const started = await callMcp(stateFile, childEnvironment, 3, 'task.start', { handle: claim.handle, leaseSeconds: 60 });
    assert.equal(started.status, 'running');
    assert.equal(started.attempt, 1);

    const checkpoint = await callMcp(stateFile, childEnvironment, 4, 'task.checkpoint', {
      handle: claim.handle,
      checkpointKey: 'stdio-checkpoint-0001',
      expectedRevision: 0,
      checkpoint: { summary: 'The independent worker process started successfully.', resumeContext: 'Complete the inert fixture.' }
    });
    assert.equal(checkpoint.revision, 1);
    assert.equal(checkpoint.createdAt, submitted.createdAt,
      'Checkpoint responses must retain the task creation timestamp.');
    assert.match(checkpoint.checkpointCreatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(Object.prototype.hasOwnProperty.call(checkpoint, 'checkpoint'), false,
      'Mutation responses must not echo checkpoint bodies.');

    const completed = await callMcp(stateFile, childEnvironment, 5, 'task.complete', {
      handle: claim.handle, result: { summary: 'Cross-process MCP handoff completed.' }
    });
    assert.equal(completed.status, 'succeeded');
    assert.equal(Object.prototype.hasOwnProperty.call(completed, 'result'), false,
      'Mutation responses must not echo result bodies.');

    const read = await callMcp(stateFile, childEnvironment, 6, 'task.get', {
      taskId: submitted.taskId, includePayload: true, includeCheckpoint: true
    });
    assert.equal(read.status, 'succeeded');
    assert.equal(read.contentTrust, 'untrusted');
    assert.equal(read.latestCheckpoint.checkpoint.summary.includes('started successfully'), true);
    assert.equal(read.result.summary, 'Cross-process MCP handoff completed.');
    assert.doesNotMatch(JSON.stringify(read), new RegExp(claim.handle.claimToken));

    const listed = await callMcp(stateFile, childEnvironment, 7, 'task.list', { queue: 'stdio.queue', limit: 10 });
    assert.equal(listed.count, 1);
    assert.equal(listed.tasks[0].status, 'succeeded');
    const listedText = JSON.stringify(listed);
    assert.doesNotMatch(listedText, /independent worker process|Cross-process MCP handoff completed/);
    assert.doesNotMatch(listedText, new RegExp(claim.handle.claimToken));

    const store = createStateStore({ file: stateFile });
    try {
      const durable = store.transaction(db => ({
        tokenHash: db.prepare('SELECT token_hash FROM task_attempts WHERE task_id = ?').get(submitted.taskId).token_hash,
        checkpoints: db.prepare('SELECT COUNT(*) AS count FROM task_checkpoints WHERE task_id = ?').get(submitted.taskId).count
      }));
      assert.match(durable.tokenHash, /^[a-f0-9]{64}$/);
      assert.notEqual(durable.tokenHash, claim.handle.claimToken);
      assert.equal(durable.checkpoints, 1);
      assert.equal(store.checkIntegrity({ full: true }).ok, true);
    } finally { store.close(); }

    process.stdout.write('Task stdio MCP handoff smoke test passed.\n');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
