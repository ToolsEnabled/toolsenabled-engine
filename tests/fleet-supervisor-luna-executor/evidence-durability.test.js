'use strict';

// Q66 Terra fallback: exercise a real detached lane in a disposable git
// repository, then prove that its terminal evidence cannot survive either a
// committed-artifact mutation or terminal/result outcome disagreement.

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

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'q66-evidence-durability-'));
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

function receiptFor(seed) {
  return Object.freeze({
    launchId: `launch_${digest(`launch:${seed}`).slice(0, 20)}`,
    recordHash: digest(`record:${seed}`),
    auditSequence: 67,
    auditEventHash: digest(`audit:${seed}`)
  });
}

function removeLaneWorktree(fixture, laneId) {
  const lanePath = path.join(fixture.root, `ToolsEnabled-fleet-lane-${laneId}`);
  if (!fs.existsSync(lanePath)) return;
  try { git(['worktree', 'remove', '--force', lanePath], fixture.repoRoot); } catch { /* fixture cleanup */ }
}

async function main() {
  const fixture = makeFixture();
  const laneId = 'q66-evidence-durability';
  const allowedPath = 'src/evidence-durability.js';
  const receipt = receiptFor('durability');
  try {
    const input = {
      repoRoot: fixture.repoRoot,
      baseCommit: fixture.baseCommit,
      laneId,
      itemId: 'Q66',
      launchReceipt: receipt,
      allowedPaths: [allowedPath],
      verificationCommand: { command: process.execPath, args: ['-e', 'process.stdout.write("VERIFY_OK")'] },
      taskBrief: 'Exercise the Q66 durable terminal-evidence boundary.',
      timeoutMs: 30_000,
      outputBudgetBytes: 64 * 1024,
      evidenceRoot: fixture.evidenceRoot
    };
    const result = await luna.executeLunaLane(input, {
      now: () => Date.now(),
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
      })
    });

    equal(result.outcome, 'eligible', 'a scoped, verified lane is eligible');
    equal(result.evidenceComplete, true, 'an eligible lane has complete terminal evidence');
    equal(result.terminalized, true, 'complete terminal evidence durably consumes the reservation');

    const registry = path.join(fixture.evidenceRoot, '.luna-executor-reservations');
    const reservationPath = path.join(registry, fs.readdirSync(registry).find(name => name.endsWith('.json')));
    const reservation = JSON.parse(fs.readFileSync(reservationPath, 'utf8'));
    ok(luna.reservationEvidenceComplete(fs, reservation), 'the untouched terminal artifact set is coherent');

    const stdoutPath = path.join(result.evidenceDir, 'luna.stdout.log');
    const originalStdout = fs.readFileSync(stdoutPath);
    fs.writeFileSync(stdoutPath, Buffer.concat([originalStdout, Buffer.from('tampered\n')]));
    equal(luna.reservationEvidenceComplete(fs, reservation), false,
      'a committed evidence artifact hash mismatch invalidates terminal evidence');
    fs.writeFileSync(stdoutPath, originalStdout);

    const terminalPath = result.terminalReceiptPath;
    const originalTerminal = fs.readFileSync(terminalPath, 'utf8');
    const mismatchedTerminal = JSON.parse(originalTerminal);
    mismatchedTerminal.terminalState = 'rejected';
    fs.writeFileSync(terminalPath, `${JSON.stringify(mismatchedTerminal, null, 2)}\n`, 'utf8');
    equal(luna.reservationEvidenceComplete(fs, reservation), false,
      'terminal/result outcome disagreement invalidates terminal evidence');
    fs.writeFileSync(terminalPath, originalTerminal, 'utf8');
    ok(luna.reservationEvidenceComplete(fs, reservation), 'restoring exact artifacts restores coherent evidence');
  } finally {
    removeLaneWorktree(fixture, laneId);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  console.log(`Q66 evidence durability test passed (${checks} checks).`);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
