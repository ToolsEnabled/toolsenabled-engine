'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const luna = require('../src/lib/fleet-supervisor/luna-executor.js');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function input(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-refusals-'));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot);
  return {
    repoRoot,
    baseCommit: 'a'.repeat(40),
    laneId: 'refusal-lane',
    itemId: 'Q66',
    launchReceipt: {
      launchId: `launch_${'b'.repeat(16)}`,
      recordHash: hash('record'),
      auditSequence: 1,
      auditEventHash: hash('event')
    },
    allowedPaths: ['src/allowed.js'],
    verificationCommand: { command: process.execPath, args: ['--version'] },
    taskBrief: 'Exercise a refusal through the public API.',
    timeoutMs: 1000,
    outputBudgetBytes: 1024,
    evidenceRoot: path.join(root, 'evidence'),
    ...overrides
  };
}

function assertRefusal(fn, code) {
  assert.throws(fn, error => error instanceof luna.LunaExecutorError && error.code === code);
}

// These validation refusals happen before dependency construction. If either
// call accidentally gets farther, the deliberately absent repository is also
// a guard against mistaking downstream failure for the requested refusal.
{
  const request = input({ baseCommit: 'HEAD' });
  const before = fs.readdirSync(request.repoRoot);
  assertRefusal(() => luna.normalizeInput(request), 'LUNA_BASE_INVALID');
  assert.deepEqual(fs.readdirSync(request.repoRoot), before, 'base refusal must not write');
}

{
  const request = input({ itemId: '66-starts-with-a-number' });
  const before = fs.readdirSync(request.repoRoot);
  assertRefusal(() => luna.normalizeInput(request), 'LUNA_ITEM_INVALID');
  assert.deepEqual(fs.readdirSync(request.repoRoot), before, 'item refusal must not write');
}

async function evidenceScopeRefusal() {
  const request = input();
  request.evidenceRoot = path.join(request.repoRoot, 'forbidden-evidence');
  const calls = { git: 0, spawn: 0, create: 0 };
  const authorityHash = luna.executorPayloadHash(request);
  const gitRun = args => {
    calls.git += 1;
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { status: 0, stdout: `${request.repoRoot}\n`, stderr: '', error: null };
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return { status: 0, stdout: `${request.baseCommit}\n`, stderr: '', error: null };
    }
    if (args[0] === 'worktree') return { status: 0, stdout: '', stderr: '', error: null };
    throw new Error(`unexpected git request: ${args.join(' ')}`);
  };
  await assert.rejects(
    luna.executeLunaLane(request, {
      gitRun,
      worktreePathFor: () => path.join(path.dirname(request.repoRoot), 'lane'),
      verifyLaunch: receipt => ({
        ...receipt,
        targetAgentId: 'luna',
        model: luna.LUNA_MODEL,
        executorPayloadHash: authorityHash
      }),
      spawnImpl: () => { calls.spawn += 1; throw new Error('must not spawn'); },
      createLaneWorktree: () => { calls.create += 1; throw new Error('must not create'); }
    }),
    error => error instanceof luna.LunaExecutorError && error.code === 'LUNA_EVIDENCE_SCOPE'
  );
  assert.equal(calls.git, 3, 'only read-only repository checks precede the scope refusal');
  assert.equal(calls.spawn, 0, 'scope refusal must not spawn a process');
  assert.equal(calls.create, 0, 'scope refusal must not create a worktree');
  assert.equal(fs.existsSync(request.evidenceRoot), false, 'scope refusal must not create evidence');
}

evidenceScopeRefusal().then(() => {
  process.stdout.write('luna executor refusal coverage passed\n');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
