// EXECUTABLE CHANGE
// testcanfail-tests-fleet-supervisor-luna-executor-reservation-overlap-replay-test-js
//
// Assertion audit:
// - Strengthened the unconditional `ok(true)` completion assertion into an exact
//   assertion-count sentinel. Mutation: changed its expected count from 9 to 8.
//   RED: `AssertionError [ERR_ASSERTION]: both reservation authority scenarios
//   executed all nine discriminating assertions` and `9 !== 8`.
// - Restoration run: `Q66 reservation overlap/replay test passed (10 checks).`
// - NOT-FOUND (1): no assertion is inside a loop/forEach over a possibly empty
//   collection.
// - NOT-FOUND (2): no assertion relies on a child-process exit status or truthy
//   process return; git fixture commands must succeed and their output is used.
// - NOT-FOUND (3): no try/catch or optional chain swallows a tested failure; the
//   sole catch is best-effort fixture cleanup.
// - NOT-FOUND (4): reservation overlap and replay behavior is asserted against
//   executeLunaLane, not a mock of that behavior. Overrides mock only boundaries.
// - NOT-FOUND (5): there is no skip or platform precondition guard.
// - NOT-FOUND (6): expected outcomes, error codes, filesystem isolation, and git
//   snapshots are independent constants or pre-action observations, not values
//   computed by the implementation under test.
// - Unmet preconditions: none.

'use strict';

// Q66 Terra fallback: controller reservation gates must prevent both live
// allowlist overlap and reuse of a completed, signed launch receipt.  This
// test confines git and evidence effects to disposable sibling directories.

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
function deepEqual(actual, expected, message) { assert.deepEqual(actual, expected, message); checks += 1; }
async function rejects(promiseFactory, code, message) {
  await assert.rejects(promiseFactory, error => error instanceof luna.LunaExecutorError && error.code === code, message);
  checks += 1;
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function git(args, cwd) {
  return String(execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false })).trim();
}

function makeFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function sharedCheckoutSnapshot(fixture) {
  return Object.freeze({
    head: git(['rev-parse', 'HEAD'], fixture.repoRoot),
    status: git(['status', '--porcelain=v1', '--untracked-files=all'], fixture.repoRoot),
    diff: git(['diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--'], fixture.repoRoot),
    readmeHash: digest(fs.readFileSync(path.join(fixture.repoRoot, 'README.md')))
  });
}

function receiptFor(seed, auditSequence) {
  return Object.freeze({
    launchId: `launch_${digest(`launch:${seed}`).slice(0, 20)}`,
    recordHash: digest(`record:${seed}`),
    auditSequence,
    auditEventHash: digest(`audit:${seed}`)
  });
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
    taskBrief: 'Exercise a bounded Q66 controller reservation.',
    timeoutMs: 30_000,
    outputBudgetBytes: 64 * 1024,
    evidenceRoot: fixture.evidenceRoot
  };
}

function overrides(receipt, allowedPath, extra = {}) {
  let clock = Date.now();
  return {
    now: () => ++clock,
    processStartIdentity: pid => `test-process-${pid}`,
    verifyLaunch: (actualReceipt, normalizedInput) => Object.freeze({
      ...actualReceipt,
      targetAgentId: 'luna',
      model: luna.LUNA_MODEL,
      objectiveRef: 'Q66',
      executorPayloadHash: luna.executorPayloadHash(normalizedInput),
      verifiedBy: 'test-signed-audit'
    }),
    runLuna: async ({ worktreePath }) => {
      const target = path.join(worktreePath, ...allowedPath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'module.exports = 66;\n', 'utf8');
      return { ok: true, exitCode: 0, stdout: 'LUNA_OK\n', stderr: '', stdoutBytes: 8, stderrBytes: 0, durationMs: 1 };
    },
    runVerification: async () => ({
      ok: true, exitCode: 0, stdout: 'VERIFY_OK\n', stderr: '', stdoutBytes: 10, stderrBytes: 0, durationMs: 1
    }),
    ...extra
  };
}

function removeLaneWorktree(fixture, laneId) {
  const lanePath = path.join(fixture.root, `ToolsEnabled-fleet-lane-${laneId}`);
  if (!fs.existsSync(lanePath)) return;
  try { git(['worktree', 'remove', '--force', lanePath], fixture.repoRoot); } catch { /* fixture cleanup */ }
}

async function testActiveOverlapRefusal() {
  const fixture = makeFixture('q66-reservation-overlap-');
  const firstLaneId = 'q66-overlap-first';
  const secondLaneId = 'q66-overlap-second';
  const sharedPath = 'src/shared-reservation.js';
  const before = sharedCheckoutSnapshot(fixture);
  let releaseFirst = () => {};
  const released = new Promise(resolve => { releaseFirst = resolve; });
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  try {
    const firstReceipt = receiptFor('overlap-first', 71);
    const secondReceipt = receiptFor('overlap-second', 72);
    const first = luna.executeLunaLane(
      inputFor(fixture, firstLaneId, sharedPath, firstReceipt),
      overrides(firstReceipt, sharedPath, {
        runLuna: async ({ worktreePath }) => {
          const target = path.join(worktreePath, ...sharedPath.split('/'));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, 'module.exports = "first";\n', 'utf8');
          signalStarted();
          await released;
          return { ok: true, exitCode: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, durationMs: 1 };
        }
      })
    );
    await started;
    await rejects(
      () => luna.executeLunaLane(
        inputFor(fixture, secondLaneId, sharedPath, secondReceipt),
        overrides(secondReceipt, sharedPath)
      ),
      'LUNA_ALLOWLIST_COLLISION',
      'a simultaneous active allowlist overlap is refused before a second lane starts'
    );
    equal(fs.existsSync(path.join(fixture.root, `ToolsEnabled-fleet-lane-${secondLaneId}`)), false,
      'the refused overlapping lane never receives a detached worktree');
    releaseFirst();
    equal((await first).outcome, 'eligible', 'the original active reservation completes normally');
    deepEqual(sharedCheckoutSnapshot(fixture), before,
      'active-overlap refusal and the isolated first lane leave the shared checkout unchanged');
  } finally {
    releaseFirst();
    removeLaneWorktree(fixture, firstLaneId);
    removeLaneWorktree(fixture, secondLaneId);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testCanonicalReceiptReplayRefusal() {
  const fixture = makeFixture('q66-receipt-replay-');
  const firstLaneId = 'q66-replay-first';
  const secondLaneId = 'q66-replay-second';
  const before = sharedCheckoutSnapshot(fixture);
  try {
    const receipt = receiptFor('canonical-receipt-replay', 73);
    const firstPath = 'src/replay-first.js';
    const first = await luna.executeLunaLane(
      inputFor(fixture, firstLaneId, firstPath, receipt),
      overrides(receipt, firstPath)
    );
    equal(first.outcome, 'eligible', 'the first signed receipt use is eligible');
    equal(first.terminalized, true, 'the first signed receipt is durably consumed');
    await rejects(
      () => luna.executeLunaLane(
        inputFor(fixture, secondLaneId, 'src/replay-second.js', receipt),
        overrides(receipt, 'src/replay-second.js')
      ),
      'LUNA_RECEIPT_REUSED',
      'a canonical signed launch receipt cannot be replayed for a disjoint lane'
    );
    equal(fs.existsSync(path.join(fixture.root, `ToolsEnabled-fleet-lane-${secondLaneId}`)), false,
      'a replay refusal occurs before a second detached worktree starts');
    deepEqual(sharedCheckoutSnapshot(fixture), before,
      'receipt replay refusal and isolated execution leave the shared checkout unchanged');
  } finally {
    removeLaneWorktree(fixture, firstLaneId);
    removeLaneWorktree(fixture, secondLaneId);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function main() {
  await testActiveOverlapRefusal();
  await testCanonicalReceiptReplayRefusal();
  equal(checks, 9, 'both reservation authority scenarios executed all nine discriminating assertions');
  console.log(`Q66 reservation overlap/replay test passed (${checks} checks).`);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
