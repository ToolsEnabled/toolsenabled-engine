'use strict';

// Q66 Terra fallback: restart reconciliation must release only a completed
// reservation.  Every fixture lives in one disposable temporary repository;
// neither the shared checkout nor its evidence/audit state is used.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const luna = require('../../src/lib/fleet-supervisor/luna-executor.js');

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
function ok(value, message) { assert.ok(value, message); checks += 1; }

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function git(args, cwd) {
  return String(execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false })).trim();
}

function receiptFor(seed, sequence) {
  return Object.freeze({
    launchId: `launch_${digest(`launch:${seed}`).slice(0, 20)}`,
    recordHash: digest(`record:${seed}`),
    auditSequence: sequence,
    auditEventHash: digest(`audit:${seed}`)
  });
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'q66-restart-reconciliation-'));
  const repoRoot = path.join(root, 'repo');
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(evidenceRoot, { recursive: true });
  git(['init'], repoRoot);
  git(['config', 'user.email', 'q66-test@example.invalid'], repoRoot);
  git(['config', 'user.name', 'Q66 Test'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'fixture\n', 'utf8');
  git(['add', 'README.md'], repoRoot);
  git(['commit', '-m', 'fixture'], repoRoot);
  return { root, repoRoot, evidenceRoot, baseCommit: git(['rev-parse', 'HEAD'], repoRoot) };
}

function inputFor(fixture, laneId, allowedPath, receipt) {
  return {
    repoRoot: fixture.repoRoot,
    baseCommit: fixture.baseCommit,
    laneId,
    itemId: 'Q66',
    launchReceipt: receipt,
    allowedPaths: [allowedPath],
    verificationCommand: { command: process.execPath, args: ['-e', 'process.stdout.write("VERIFY_OK")'] },
    taskBrief: 'Exercise only the Q66 restart reconciliation contract.',
    timeoutMs: 30_000,
    outputBudgetBytes: 64 * 1024,
    evidenceRoot: fixture.evidenceRoot
  };
}

function signedOverrides(receipt) {
  let clock = Date.now();
  return {
    now: () => ++clock,
    processStartIdentity: pid => `q66-test-process-${pid}`,
    verifyLaunch: (actualReceipt, normalizedInput) => Object.freeze({
      ...actualReceipt,
      targetAgentId: 'luna',
      model: luna.LUNA_MODEL,
      objectiveRef: 'Q66',
      executorPayloadHash: luna.executorPayloadHash(normalizedInput),
      verifiedBy: 'q66-restart-test'
    }),
    runLuna: async ({ worktreePath, input }) => {
      const target = path.join(worktreePath, ...input.allowedPaths[0].split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `module.exports = ${JSON.stringify(input.laneId)};\n`, 'utf8');
      return { ok: true, exitCode: 0, stdout: 'LUNA_OK\n', stderr: '', stdoutBytes: 8, stderrBytes: 0, durationMs: 1 };
    },
    runVerification: async () => ({
      ok: true, exitCode: 0, stdout: 'VERIFY_OK\n', stderr: '', stdoutBytes: 10, stderrBytes: 0, durationMs: 1
    })
  };
}

function recordForLaunch(registry, launchId) {
  const entry = fs.readdirSync(registry)
    .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(name => ({ path: path.join(registry, name), record: JSON.parse(fs.readFileSync(path.join(registry, name), 'utf8')) }))
    .find(entry => entry.record.payload.launchReceipt.launchId === launchId);
  assert.ok(entry, `reservation record exists for ${launchId}`);
  return entry;
}

function removeLaneWorktree(fixture, laneId) {
  const lanePath = path.join(fixture.root, `ToolsEnabled-fleet-lane-${laneId}`);
  if (!fs.existsSync(lanePath)) return;
  try { git(['worktree', 'remove', '--force', lanePath], fixture.repoRoot); } catch { /* disposable cleanup */ }
}

(async () => {
  const fixture = makeFixture();
  const sourceLane = 'q66-restart-source';
  const recoveryLane = 'q66-restart-recovery';
  const unrelatedLane = 'q66-unrelated-active-hold';
  const sourceReceipt = receiptFor('restart-source', 401);
  const recoveryReceipt = receiptFor('restart-recovery', 402);
  const unrelatedReceipt = receiptFor('unrelated-hold', 403);

  try {
    const sourceInput = inputFor(fixture, sourceLane, 'src/restart-source.js', sourceReceipt);
    const completed = await luna.executeLunaLane(sourceInput, signedOverrides(sourceReceipt));
    equal(completed.outcome, 'eligible', 'the source lane creates eligible terminal evidence');
    equal(completed.evidenceComplete, true, 'the source evidence is complete before restart simulation');
    equal(completed.terminalized, true, 'the source reservation terminalizes before restart simulation');

    const registry = path.join(fixture.evidenceRoot, '.luna-executor-reservations');
    const sourceEntry = recordForLaunch(registry, sourceReceipt.launchId);
    const interruptedRecord = { ...sourceEntry.record, state: 'active' };
    delete interruptedRecord.terminalizedAt;
    delete interruptedRecord.reconciledAt;
    fs.writeFileSync(sourceEntry.path, `${JSON.stringify(interruptedRecord, null, 2)}\n`, 'utf8');

    const unrelatedInput = inputFor(fixture, unrelatedLane, 'src/unrelated-held.js', unrelatedReceipt);
    const unrelatedEvidenceDir = path.join(fixture.evidenceRoot, 'unrelated-incomplete-evidence');
    fs.mkdirSync(unrelatedEvidenceDir, { recursive: true });
    const unrelatedRecord = {
      schemaVersion: 1,
      kind: 'luna-controller-reservation',
      state: 'active',
      consumedAt: new Date().toISOString(),
      evidenceDir: unrelatedEvidenceDir,
      payload: {
        launchReceipt: unrelatedInput.launchReceipt,
        executorPayloadHash: luna.executorPayloadHash(unrelatedInput),
        laneId: unrelatedInput.laneId,
        itemId: unrelatedInput.itemId,
        baseCommit: unrelatedInput.baseCommit,
        allowedPaths: unrelatedInput.allowedPaths,
        verificationCommand: unrelatedInput.verificationCommand
      }
    };
    const unrelatedPath = path.join(registry, `${digest('unrelated-active-hold')}.json`);
    fs.writeFileSync(unrelatedPath, `${JSON.stringify(unrelatedRecord, null, 2)}\n`, 'utf8');
    const unrelatedBytes = fs.readFileSync(unrelatedPath);

    const recovered = await luna.executeLunaLane(
      inputFor(fixture, recoveryLane, 'src/restart-recovery.js', recoveryReceipt),
      signedOverrides(recoveryReceipt)
    );
    equal(recovered.outcome, 'eligible', 'restart permits a disjoint lane after complete evidence is reconciled');
    const reconciled = JSON.parse(fs.readFileSync(sourceEntry.path, 'utf8'));
    equal(reconciled.state, 'terminal', 'the completed active source reservation is reconciled to terminal');
    ok(typeof reconciled.reconciledAt === 'string' && reconciled.reconciledAt.length > 0,
      'the source record carries durable reconciliation metadata');
    equal(Object.hasOwn(reconciled, 'terminalizedAt'), false,
      'restart reconciliation does not misrepresent itself as the original terminalization');
    assert.deepEqual(fs.readFileSync(unrelatedPath), unrelatedBytes,
      'an unrelated active hold with incomplete evidence is preserved byte-for-byte');
    checks += 1;

    let contenderRunnerStarted = false;
    const contenderReceipt = receiptFor('unrelated-contender', 404);
    await assert.rejects(
      () => luna.executeLunaLane(
        inputFor(fixture, 'q66-unrelated-contender', 'src/unrelated-held.js', contenderReceipt),
        {
          ...signedOverrides(contenderReceipt),
          runLuna: async () => {
            contenderRunnerStarted = true;
            throw new Error('the active hold should reject before a runner starts');
          }
        }
      ),
      error => error instanceof luna.LunaExecutorError && error.code === 'LUNA_ALLOWLIST_COLLISION',
      'the unrelated active hold remains collision-protective after reconciliation'
    );
    checks += 1;
    equal(contenderRunnerStarted, false, 'the preserved unrelated hold rejects before its contender runner starts');
    assert.deepEqual(fs.readFileSync(unrelatedPath), unrelatedBytes,
      'collision rejection does not mutate the unrelated active hold');
    checks += 1;

    console.log(`Restart reconciliation test passed (${checks} checks; complete terminal evidence reconciled, unrelated active hold preserved).`);
  } finally {
    for (const laneId of [sourceLane, recoveryLane, unrelatedLane, 'q66-unrelated-contender']) {
      removeLaneWorktree(fixture, laneId);
    }
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
