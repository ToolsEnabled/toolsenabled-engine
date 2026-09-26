'use strict';

// Q66 focused contract tests.  Every filesystem effect is confined to a
// disposable temporary git repository and its sibling evidence directory.
// The production checkout, queue, owner ledger, package manifests, and audit
// ledger are never used as test fixtures.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');

const luna = require('../src/lib/fleet-supervisor/luna-executor.js');
const laneWorktree = require('../src/lib/fleet-supervisor/worktree.js');

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
function ok(value, message) { assert.ok(value, message); checks += 1; }
function deepEqual(actual, expected, message) { assert.deepEqual(actual, expected, message); checks += 1; }
function rejects(fn, code, message) {
  assert.throws(fn, error => error instanceof luna.LunaExecutorError && error.code === code, message);
  checks += 1;
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function receiptFor(seed, sequence = 7) {
  const suffix = digest(`launch:${seed}`).slice(0, 20);
  return Object.freeze({
    launchId: `launch_${suffix}`,
    recordHash: digest(`record:${seed}`),
    auditSequence: sequence,
    auditEventHash: digest(`audit:${seed}`)
  });
}

function verifiedLaunchFor(receipt, executorPayloadHash) {
  return Object.freeze({
    ...receipt,
    targetAgentId: 'luna',
    model: luna.LUNA_MODEL,
    objectiveRef: 'Q66',
    executorPayloadHash,
    verifiedBy: 'test-signed-audit'
  });
}

const launchReceipt = receiptFor('baseline');

function git(args, cwd) {
  return String(execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false })).trim();
}

function makeRepo(prefix) {
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

function commonInput(fixture, laneId, allowedPaths, overrides = {}) {
  return {
    // Git may report a canonical path with different casing from a caller on
    // Windows; the executor must not turn that harmless difference into a
    // false repository-boundary refusal.
    repoRoot: process.platform === 'win32' ? fixture.repoRoot.toUpperCase() : fixture.repoRoot,
    baseCommit: fixture.baseCommit,
    laneId,
    itemId: 'Q66',
    launchReceipt,
    allowedPaths,
    verificationCommand: { command: process.execPath, args: ['-e', 'process.stdout.write("VERIFY_OK")'] },
    taskBrief: 'Implement the bounded Q66 test slice.',
    timeoutMs: 30_000,
    outputBudgetBytes: 64 * 1024,
    evidenceRoot: fixture.evidenceRoot,
    ...overrides
  };
}

function executorOverrides(extra = {}, receipt = launchReceipt) {
  let clock = Date.now();
  return {
    now: () => ++clock,
    // The executor requires the controller-signed hash to bind precisely the
    // normalized input it is about to reserve.
    verifyLaunch: (actualReceipt, normalizedInput) => verifiedLaunchFor(actualReceipt, luna.executorPayloadHash(normalizedInput)),
    processStartIdentity: pid => `test-process-${pid}`,
    ...extra
  };
}

function removeLaneWorktree(fixture, laneId) {
  const lanePath = path.join(fixture.root, `ToolsEnabled-fleet-lane-${laneId}`);
  if (!fs.existsSync(lanePath)) return;
  try { git(['worktree', 'remove', '--force', lanePath], fixture.repoRoot); } catch { /* disposable fixture cleanup */ }
}

function successfulLaneRunner(relativePath, source = 'module.exports = true;\n') {
  return async ({ worktreePath }) => {
    const absolute = path.join(worktreePath, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source, 'utf8');
    return { ok: true, exitCode: 0, stdout: 'LUNA_OK\n', stderr: '', stdoutBytes: 8, stderrBytes: 0, durationMs: 1 };
  };
}

function successfulVerification() {
  return async () => ({ ok: true, exitCode: 0, stdout: 'VERIFY_OK\n', stderr: '', stdoutBytes: 10, stderrBytes: 0, durationMs: 1 });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

// ---------------------------------------------------------------------------
// Pure input and signed-receipt gates
// ---------------------------------------------------------------------------

rejects(() => luna.normalizeAllowedPaths(['BUILD-QUEUE.md']), 'LUNA_CONTROLLER_SCOPE',
  'the queue is controller-only');
rejects(() => luna.normalizeAllowedPaths(['src/a.js', 'src/a.js']), 'LUNA_INPUT_INVALID',
  'duplicate exact paths are refused');
rejects(() => luna.normalizeAllowedPaths(['../escape.js']), 'LUNA_INPUT_INVALID',
  'path traversal is refused');
if (process.platform === 'win32') {
  rejects(() => luna.normalizeAllowedPaths(['src/trailing-dot.']), 'LUNA_PATH_AMBIGUOUS',
    'Windows trailing-dot aliases are refused');
  rejects(() => luna.normalizeAllowedPaths(['src/CON.js']), 'LUNA_PATH_AMBIGUOUS',
    'Windows device names are refused');
}

// "The marker did not match" is different from "its state could not be
// established": only actual absence is a definite negative.
equal(luna.markerMatches({ readFileSync() { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } },
  '/lane', {}), false, 'an absent marker is reported as a definite mismatch');
rejects(() => luna.markerMatches({ readFileSync() { const error = new Error('unreadable'); error.code = 'EACCES'; throw error; } },
  '/lane', {}), 'LUNA_MARKER_UNESTABLISHED', 'an unreadable marker is reported as unestablished, not mismatched');

const event = {
  sequence: launchReceipt.auditSequence,
  eventHash: launchReceipt.auditEventHash,
  keyId: 'audit-key-1',
  signature: 'signed-event',
  event: { action: 'controller.agent.launch', target: launchReceipt.launchId, details: {} }
};
const signedRecord = {
  launchId: launchReceipt.launchId,
  recordHash: launchReceipt.recordHash,
  targetAgentId: 'luna',
  model: luna.LUNA_MODEL,
  objectiveRef: 'Q66',
  executorPayloadHash: 'c'.repeat(64)
};
const verified = luna.verifyLaunchReceipt(launchReceipt, {
  auditApi: { findEvents: () => [event] },
  launchApi: { LAUNCH_ACTION: 'controller.agent.launch', launchFromAuditEvent: () => signedRecord }
});
equal(verified.verifiedBy, 'canonical-signed-audit', 'the default verifier identifies the canonical signed path');
equal(verified.auditSequence, launchReceipt.auditSequence, 'the receipt sequence is bound to the signed event');

// ---------------------------------------------------------------------------
// Real detached-worktree success: model output, exact scope, verification,
// portable patch, per-file hash, and durable local terminal evidence.
// ---------------------------------------------------------------------------

(async () => {
let capturedLunaSpawn = null;
let capturedLunaInput = null;
let capturedLunaOnboardingInput = null;
const isolatedRunner = await luna.runLunaProcess({
  input: commonInput({ repoRoot: process.cwd(), baseCommit: 'a'.repeat(40), evidenceRoot: os.tmpdir() },
    'q66-mcp-isolation', ['src/mcp-isolation.js']),
  worktreePath: process.cwd(),
  evidenceDir: os.tmpdir(),
  timeoutMs: 10_000,
  outputBudgetBytes: 64 * 1024,
  verifiedLaunch: verifiedLaunchFor(launchReceipt, 'c'.repeat(64)),
  deps: {
    resolveLunaCommand: () => 'codex',
    buildOnboardingPacket: input => {
      capturedLunaOnboardingInput = input;
      return 'TEST LUNA ONBOARDING PACKET';
    },
    onboardingDependencies: {},
    spawnImpl: (command, args, options) => {
      capturedLunaSpawn = { command, args, options };
      const child = new EventEmitter();
      child.pid = 999_999;
      child.stdin = { end(value) { capturedLunaInput = value; } };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => child.emit('close', 0));
      return child;
    }
  }
});
equal(isolatedRunner.ok, true, 'the isolated Luna command completes through the bounded runner');
ok(capturedLunaSpawn.args.includes('--ignore-user-config'), 'the Luna command excludes user MCP and plugin configuration');
ok(capturedLunaSpawn.args.includes('windows.sandbox="elevated"'),
  'the isolated Luna command restores the host Windows workspace-write backend explicitly');
const codexProfileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-codex-profile-'));
try {
  const codexConfigPath = path.join(codexProfileRoot, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
  fs.writeFileSync(codexConfigPath, [
    '[mcp_servers.playwright]',
    'command = "node"',
    '[mcp_servers.toolsenabled-readonly]',
    'command = "node"',
    '[mcp_servers.toolsenabled-readonly.env]',
    'TOOLSENABLED_TOOL_ALLOWLIST = "system.status"',
    '[mcp_servers.toolsenabled]',
    'command = "node"',
    ''
  ].join('\n'), 'utf8');
  const projectCodexConfig = fs.readFileSync(codexConfigPath, 'utf8');
  const projectMcpNames = [...new Set([...projectCodexConfig.matchAll(/^\s*\[mcp_servers\.([A-Za-z0-9_-]+)(?:\.|\])/gm)]
    .map(match => match[1]))].sort();
  deepEqual(projectMcpNames, ['playwright', 'toolsenabled', 'toolsenabled-readonly'],
    'the disposable Codex profile parser identifies every configured MCP exactly once');
  for (const name of projectMcpNames) {
    const commandOverride = `mcp_servers.${name}.command="disabled"`;
    const enabledOverride = `mcp_servers.${name}.enabled=false`;
    ok(capturedLunaSpawn.args.includes(commandOverride), `the isolated config retains an inert transport for ${name}`);
    ok(capturedLunaSpawn.args.includes(enabledOverride), `the Luna command disables ${enabledOverride}`);
  }
} finally {
  fs.rmSync(codexProfileRoot, { recursive: true, force: true });
}
equal(capturedLunaSpawn.options.cwd, process.cwd(), 'the isolated Luna process still runs in its detached worktree');
equal(capturedLunaSpawn.options.shell, false, 'the isolated Luna process remains argv-only');
ok(capturedLunaInput.indexOf('TEST LUNA ONBOARDING PACKET') < capturedLunaInput.indexOf('Implement the bounded Q66 test slice.'),
  'the Luna packet precedes the task brief on stdin');
equal(capturedLunaOnboardingInput.agentId, 'luna', 'the packet receives the verified launch holder');
equal(capturedLunaOnboardingInput.identityBinding, 'verified-launch');
equal(capturedLunaOnboardingInput.role, 'builder', 'the packet receives the lane role rather than inferring it from a provider name');
equal(capturedLunaOnboardingInput.provider, 'codex');
equal(capturedLunaOnboardingInput.model, luna.LUNA_MODEL, 'the packet receives the verified launch model');
equal(capturedLunaOnboardingInput.projectRoot, process.cwd(), 'the packet receives the detached worktree project root');
equal(capturedLunaSpawn.options.env.TOOLSENABLED_AGENT_ID, 'luna');
equal(capturedLunaSpawn.options.env.TOOLSENABLED_AGENT_ROLE, 'builder');
equal(capturedLunaSpawn.options.env.TOOLSENABLED_ONBOARDING_ALREADY_INJECTED, '1');
equal(capturedLunaSpawn.options.env.TOOLSENABLED_ONBOARDING_PACKET_VERSION, 'toolsenabled.agent-onboarding.v1');
ok(/^[a-f0-9]{64}$/.test(capturedLunaSpawn.options.env.TOOLSENABLED_ONBOARDING_PACKET_HASH));
equal(capturedLunaSpawn.options.env.TOOLSENABLED_ONBOARDING_LAUNCHER_PROVENANCE,
  'verified-launch');
equal(capturedLunaSpawn.options.env.TOOLSENABLED_LAUNCH_RECORD_HASH, launchReceipt.recordHash);
equal(capturedLunaSpawn.options.env.TOOLSENABLED_LAUNCH_AUDIT_SEQUENCE, String(launchReceipt.auditSequence));
equal(capturedLunaSpawn.options.env.TOOLSENABLED_LAUNCH_AUDIT_EVENT_HASH, launchReceipt.auditEventHash);
rejects(() => luna.boundedInputPrompt(commonInput({ repoRoot: process.cwd(), baseCommit: 'a'.repeat(40), evidenceRoot: os.tmpdir() },
  'q66-empty-onboarding', ['src/empty.js']), { buildOnboardingPacket: () => '' }), 'LUNA_ONBOARDING_INVALID',
  'the Luna prompt refuses empty onboarding context');

const bounded = await luna.runBoundedCommand({
  command: process.execPath,
  args: ['-e', 'process.stdout.write("x".repeat(4096))'],
  cwd: process.cwd(),
  timeoutMs: 10_000,
  outputBudgetBytes: 1_024,
  env: process.env
});
equal(bounded.outputBudgetExceeded, true, 'the runner output budget is enforced across captured output');

// The controller's signed hash must bind every authority-bearing executor
// input before a reservation, worktree, or runner can be reached.
const authorityBinding = makeRepo('q66-luna-authority-');
try {
  const original = commonInput(authorityBinding, 'q66-authority', ['src/authority.js']);
  const authorityHash = luna.executorPayloadHash(original);
  const signedOverrides = executorOverrides({
    verifyLaunch: receipt => verifiedLaunchFor(receipt, authorityHash)
  });
  const mutations = [
    ['repoRoot', value => ({ ...value, repoRoot: path.join(authorityBinding.root, 'other-repo') })],
    ['baseCommit', value => ({ ...value, baseCommit: 'b'.repeat(40) })],
    ['laneId', value => ({ ...value, laneId: 'q66-authority-other' })],
    ['itemId', value => ({ ...value, itemId: 'Q67' })],
    ['allowedPaths', value => ({ ...value, allowedPaths: ['src/other.js'] })],
    ['verification argv', value => ({ ...value, verificationCommand: { command: process.execPath, args: ['-e', 'process.exit(0)'] } })],
    ['taskBrief', value => ({ ...value, taskBrief: 'Different signed instruction.' })],
    ['timeoutMs', value => ({ ...value, timeoutMs: 29_000 })],
    ['outputBudgetBytes', value => ({ ...value, outputBudgetBytes: 65_537 })],
    ['evidenceRoot', value => ({ ...value, evidenceRoot: path.join(authorityBinding.root, 'other-evidence') })]
  ];
  for (const [field, mutate] of mutations) {
    await assert.rejects(
      () => luna.executeLunaLane(mutate(original), signedOverrides),
      error => error instanceof luna.LunaExecutorError && error.code === 'LUNA_AUTHORITY_MISMATCH',
      `tampering ${field} is rejected before reservation`
    );
    checks += 1;
  }
  await assert.rejects(
    () => luna.executeLunaLane(original, executorOverrides({ verifyLaunch: receipt => verifiedLaunchFor(receipt, undefined) })),
    error => error instanceof luna.LunaExecutorError && error.code === 'LUNA_AUTHORITY_UNBOUND',
    'an otherwise valid Luna receipt without explicit authority binding is refused'
  );
  checks += 1;
} finally {
  fs.rmSync(authorityBinding.root, { recursive: true, force: true });
}

const success = makeRepo('q66-luna-success-');
try {
  const result = await luna.executeLunaLane(
    commonInput(success, 'q66-success-1', ['src/luna.js']),
    executorOverrides({
      runLuna: async ({ worktreePath }) => {
        fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(worktreePath, 'src', 'luna.js'), 'module.exports = 66;\n', 'utf8');
        return { ok: true, exitCode: 0, stdout: 'LUNA_OK\n', stderr: '', stdoutBytes: 9, stderrBytes: 0, durationMs: 2 };
      },
      runVerification: async ({ worktreePath }) => {
        equal(fs.readFileSync(path.join(worktreePath, 'src', 'luna.js'), 'utf8'), 'module.exports = 66;\n',
          'verification runs inside the detached lane worktree');
        return { ok: true, exitCode: 0, stdout: 'VERIFY_OK', stderr: '', stdoutBytes: 9, stderrBytes: 0, durationMs: 1,
          declared: { command: process.execPath, args: [] } };
      }
    })
  );
  equal(result.outcome, 'eligible', 'an in-scope diff with passing verification is eligible for controller review');
  deepEqual(result.rejectionCodes, [], 'the eligible lane has no rejection codes');
  deepEqual(result.changedPaths, ['src/luna.js'], 'the result exposes the exact changed path');
  ok(result.rootUnchanged, 'the shared checkout fingerprint stayed unchanged');
  ok(result.markerOk, 'the ownership marker stayed unchanged');
  ok(fs.existsSync(result.manifestPath), 'the manifest is written outside the worktree');
  ok(fs.existsSync(result.terminalReceiptPath), 'a terminal receipt is written');
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  equal(manifest.baseCommit, success.baseCommit, 'the manifest binds the immutable base commit');
  equal(manifest.pathHashes['src/luna.js'], crypto.createHash('sha256').update('module.exports = 66;\n').digest('hex'),
    'the manifest carries the final file hash');
  ok(fs.readFileSync(path.join(result.evidenceDir, 'final.diff'), 'utf8').includes('src/luna.js'),
    'the final portable diff is captured separately');
  const successRegistry = path.join(success.evidenceRoot, '.luna-executor-reservations');
  const successRecordPath = path.join(successRegistry, fs.readdirSync(successRegistry).find(name => name.endsWith('.json')));
  const successReservation = JSON.parse(fs.readFileSync(successRecordPath, 'utf8'));
  ok(luna.reservationEvidenceComplete(fs, successReservation),
    'only a coherent terminal receipt with hashes makes evidence complete');
  const diffPath = path.join(result.evidenceDir, 'final.diff');
  const originalDiff = fs.readFileSync(diffPath);
  fs.writeFileSync(diffPath, Buffer.concat([originalDiff, Buffer.from('\ncorrupted\n')]));
  equal(luna.reservationEvidenceComplete(fs, successReservation), false,
    'evidence corruption invalidates the terminal artifact hash commitment');
  fs.writeFileSync(diffPath, originalDiff);
  const symlinkEvidenceFs = Object.create(fs);
  symlinkEvidenceFs.lstatSync = target => {
    if (target === diffPath) return { isSymbolicLink: () => true, isFile: () => false };
    return fs.lstatSync(target);
  };
  equal(luna.reservationEvidenceComplete(symlinkEvidenceFs, successReservation), false,
    'a symlinked evidence artifact is never accepted as durable evidence');
  const terminalPath = result.terminalReceiptPath;
  const originalTerminal = fs.readFileSync(terminalPath, 'utf8');
  const mismatchedTerminal = JSON.parse(originalTerminal);
  mismatchedTerminal.terminalState = 'rejected';
  fs.writeFileSync(terminalPath, `${JSON.stringify(mismatchedTerminal, null, 2)}\n`, 'utf8');
  equal(luna.reservationEvidenceComplete(fs, successReservation), false,
    'manifest/result/terminal outcome disagreement invalidates evidence');
  fs.writeFileSync(terminalPath, originalTerminal, 'utf8');
  const failedTest = await luna.executeLunaLane(
    commonInput(success, 'q66-failed-test-1', ['src/fail.js'], { launchReceipt: receiptFor('failed-verification', 8) }),
    executorOverrides({
      runLuna: async ({ worktreePath }) => {
        fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(worktreePath, 'src', 'fail.js'), 'module.exports = 0;\n', 'utf8');
        return { ok: true, exitCode: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, durationMs: 1 };
      },
      runVerification: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'FAIL', stdoutBytes: 0, stderrBytes: 4, durationMs: 1 })
    }, receiptFor('failed-verification', 8))
  );
  equal(failedTest.outcome, 'rejected', 'a failed declared test rejects an otherwise scoped lane');
  ok(failedTest.rejectionCodes.includes('VERIFICATION_FAILED'), 'failed verification is explicit');
  await assert.rejects(
    () => luna.executeLunaLane(commonInput(success, 'q66-success-1', ['src/luna.js']), executorOverrides()),
    error => error instanceof luna.LunaExecutorError && error.code === 'LUNA_LANE_COLLISION',
    'a second launch cannot reuse the lane id or worktree'
  );
  checks += 1;
} finally {
  try { git(['worktree', 'remove', '--force', path.join(success.root, 'ToolsEnabled-fleet-lane-q66-failed-test-1')], success.repoRoot); } catch { /* test cleanup */ }
  try { git(['worktree', 'remove', '--force', path.join(success.root, 'ToolsEnabled-fleet-lane-q66-success-1')], success.repoRoot); } catch { /* test cleanup */ }
  fs.rmSync(success.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Rejection keeps the lane and evidence instead of deleting them.
// ---------------------------------------------------------------------------

const rejected = makeRepo('q66-luna-rejected-');
try {
  const result = await luna.executeLunaLane(
    commonInput(rejected, 'q66-rejected-1', ['src/allowed.js']),
    executorOverrides({
      runLuna: async ({ worktreePath }) => {
        fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(worktreePath, 'src', 'not-allowed.js'), 'module.exports = 0;\n', 'utf8');
        return { ok: true, exitCode: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, durationMs: 1 };
      }
    })
  );
  equal(result.outcome, 'rejected', 'an out-of-scope diff is rejected');
  ok(result.rejectionCodes.includes('SCOPE_VIOLATION'), 'scope rejection is explicit');
  equal(fs.existsSync(result.worktreePath), true, 'the rejected worktree is preserved for controller classification');
  equal(fs.existsSync(result.terminalReceiptPath), true, 'rejected evidence includes a terminal receipt');
  equal(fs.existsSync(path.join(result.evidenceDir, 'final.diff')), true, 'rejected evidence includes a diff artifact');
} finally {
  try { git(['worktree', 'remove', '--force', path.join(rejected.root, 'ToolsEnabled-fleet-lane-q66-rejected-1')], rejected.repoRoot); } catch { /* test cleanup */ }
  fs.rmSync(rejected.root, { recursive: true, force: true });
}

const reparse = makeRepo('q66-luna-reparse-');
try {
  let runnerStarted = false;
  const escapedDirectory = path.join(reparse.root, 'escaped-outside-lane');
  fs.mkdirSync(escapedDirectory, { recursive: true });
  const reparseResult = await luna.executeLunaLane(
    commonInput(reparse, 'q66-reparse-preflight', ['src/reparse.js']),
    executorOverrides({
      createLaneWorktree: (laneId, options) => {
        const created = laneWorktree.createLaneWorktree(laneId, options);
        fs.symlinkSync(escapedDirectory, path.join(created.path, 'src'), 'junction');
        return created;
      },
      runLuna: async () => {
        runnerStarted = true;
        return { ok: true, exitCode: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, durationMs: 1 };
      }
    })
  );
  equal(runnerStarted, false, 'a pre-existing junction escape is refused before the Luna runner starts');
  equal(reparseResult.outcome, 'rejected', 'a reparse-point preflight failure leaves a rejected preserved lane');
  ok(reparseResult.rejectionCodes.includes('LUNA_PATH_REPARSE_ESCAPE'), 'the reparse escape is explicit in result evidence');
} finally {
  removeLaneWorktree(reparse, 'q66-reparse-preflight');
  fs.rmSync(reparse.root, { recursive: true, force: true });
}

// Evidence storage has a separate boundary from the worktree.  A pre-existing
// reservation-root junction must be refused before the runner/worktree, with
// the shared checkout's bytes and Git status untouched.
const evidenceReservationJunction = makeRepo('q66-luna-evidence-reservation-junction-');
try {
  const outsideEvidence = path.join(evidenceReservationJunction.root, 'outside-evidence');
  const reservationJunction = path.join(evidenceReservationJunction.evidenceRoot, '.luna-executor-reservations');
  fs.mkdirSync(outsideEvidence, { recursive: true });
  fs.symlinkSync(outsideEvidence, reservationJunction, 'junction');
  const beforeShared = sharedCheckoutSnapshot(evidenceReservationJunction);
  let runnerStarted = false;
  await assert.rejects(
    () => luna.executeLunaLane(
      commonInput(evidenceReservationJunction, 'q66-evidence-reservation-junction', ['src/evidence-boundary.js']),
      executorOverrides({
        runLuna: async () => {
          runnerStarted = true;
          return { ok: true, exitCode: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, durationMs: 1 };
        }
      })
    ),
    error => error instanceof luna.LunaExecutorError && error.code === 'LUNA_EVIDENCE_REPARSE',
    'a pre-existing reservation-root junction is refused before a runner starts'
  );
  checks += 1;
  equal(runnerStarted, false, 'the evidence reservation junction is rejected before the Luna runner');
  deepEqual(sharedCheckoutSnapshot(evidenceReservationJunction), beforeShared,
    'reservation-root evidence rejection leaves shared checkout bytes and status unchanged');
} finally {
  fs.rmSync(evidenceReservationJunction.root, { recursive: true, force: true });
}

const evidenceLaneJunction = makeRepo('q66-luna-evidence-lane-junction-');
try {
  const laneReceipt = receiptFor('evidence-lane-junction', 141);
  const laneId = 'q66-evidence-lane-junction';
  const outsideEvidence = path.join(evidenceLaneJunction.root, 'outside-lane-evidence');
  const laneEvidenceDir = path.join(evidenceLaneJunction.evidenceRoot, `${laneReceipt.launchId}-${laneId}`);
  fs.mkdirSync(outsideEvidence, { recursive: true });
  fs.symlinkSync(outsideEvidence, laneEvidenceDir, 'junction');
  let runnerStarted = false;
  const result = await luna.executeLunaLane(
    commonInput(evidenceLaneJunction, laneId, ['src/evidence-lane.js'], { launchReceipt: laneReceipt }),
    executorOverrides({
      runLuna: async () => {
        runnerStarted = true;
        return { ok: true, exitCode: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, durationMs: 1 };
      }
    }, laneReceipt)
  );
  equal(result.outcome, 'rejected', 'a lane evidence-directory junction rejects the lane before worktree creation');
  equal(result.error, 'LUNA_EVIDENCE_REPARSE', 'the evidence-directory junction refusal remains explicit');
  equal(runnerStarted, false, 'the lane evidence-directory junction is rejected before the Luna runner');
} finally {
  removeLaneWorktree(evidenceLaneJunction, 'q66-evidence-lane-junction');
  fs.rmSync(evidenceLaneJunction.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Controller-owned durable reservation: four disjoint concurrent lanes, an
// active overlap refusal, a consumed-receipt refusal, and restart recovery.
// ---------------------------------------------------------------------------

const concurrent = makeRepo('q66-luna-concurrent-');
const concurrentLanes = ['a', 'b', 'c', 'd'].map((suffix, index) => ({
  laneId: `q66-concurrent-${suffix}`,
  allowedPath: `src/concurrent-${suffix}.js`,
  receipt: receiptFor(`concurrent-${suffix}`, 20 + index)
}));
try {
  const results = await Promise.all(concurrentLanes.map(spec => luna.executeLunaLane(
    commonInput(concurrent, spec.laneId, [spec.allowedPath], { launchReceipt: spec.receipt }),
    executorOverrides({ runLuna: successfulLaneRunner(spec.allowedPath), runVerification: successfulVerification() }, spec.receipt)
  )));
  equal(results.length, 4, 'four controller lanes may acquire disjoint reservations concurrently');
  for (const [index, result] of results.entries()) {
    equal(result.outcome, 'eligible', `concurrent lane ${index} remains eligible`);
    equal(result.terminalized, true, `concurrent lane ${index} persists a terminal reservation`);
  }
  equal(new Set(results.flatMap(result => result.changedPaths)).size, 4,
    'the four concurrent lanes produced disjoint changed paths');
} finally {
  for (const spec of concurrentLanes) removeLaneWorktree(concurrent, spec.laneId);
  fs.rmSync(concurrent.root, { recursive: true, force: true });
}

const overlap = makeRepo('q66-luna-overlap-');
const overlapSpec = {
  first: { laneId: 'q66-overlap-first', allowedPaths: ['src/shared-canary.js'], receiptSeed: 'overlap-first', auditSequence: 101 },
  second: { laneId: 'q66-overlap-second', allowedPaths: ['src/shared-canary.js'], receiptSeed: 'overlap-second', auditSequence: 102 }
};
let releaseOverlap;
const overlapRelease = new Promise(resolve => { releaseOverlap = resolve; });
let markOverlapStarted;
const overlapStarted = new Promise(resolve => { markOverlapStarted = resolve; });
try {
  const firstReceipt = receiptFor(overlapSpec.first.receiptSeed, overlapSpec.first.auditSequence);
  const secondReceipt = receiptFor(overlapSpec.second.receiptSeed, overlapSpec.second.auditSequence);
  const first = luna.executeLunaLane(
    commonInput(overlap, overlapSpec.first.laneId, overlapSpec.first.allowedPaths, { launchReceipt: firstReceipt }),
    executorOverrides({
      runLuna: async ({ worktreePath }) => {
        const target = path.join(worktreePath, ...overlapSpec.first.allowedPaths[0].split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'module.exports = "first";\n', 'utf8');
        markOverlapStarted();
        await overlapRelease;
        return { ok: true, exitCode: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, durationMs: 1 };
      },
      runVerification: successfulVerification()
    }, firstReceipt)
  );
  await overlapStarted;
  await assert.rejects(
    () => luna.executeLunaLane(
      commonInput(overlap, overlapSpec.second.laneId, overlapSpec.second.allowedPaths, { launchReceipt: secondReceipt }),
      executorOverrides({ runLuna: successfulLaneRunner(overlapSpec.second.allowedPaths[0]) }, secondReceipt)
    ),
    error => error instanceof luna.LunaExecutorError && error.code === 'LUNA_ALLOWLIST_COLLISION',
    'an intersecting active allowlist is refused before a second worktree starts'
  );
  checks += 1;
  releaseOverlap();
  equal((await first).outcome, 'eligible', 'the original active reservation completes normally');
} finally {
  releaseOverlap();
  removeLaneWorktree(overlap, overlapSpec.first.laneId);
  removeLaneWorktree(overlap, overlapSpec.second.laneId);
  fs.rmSync(overlap.root, { recursive: true, force: true });
}

const replay = makeRepo('q66-luna-replay-');
const replaySpec = {
  firstLaneId: 'q66-replay-first', secondLaneId: 'q66-replay-second',
  firstAllowedPaths: ['src/replay-first.js'], secondAllowedPaths: ['src/replay-second.js'],
  receiptSeed: 'receipt-replay', auditSequence: 103
};
try {
  const replayReceipt = receiptFor(replaySpec.receiptSeed, replaySpec.auditSequence);
  const first = await luna.executeLunaLane(
    commonInput(replay, replaySpec.firstLaneId, replaySpec.firstAllowedPaths, { launchReceipt: replayReceipt }),
    executorOverrides({ runLuna: successfulLaneRunner(replaySpec.firstAllowedPaths[0]), runVerification: successfulVerification() }, replayReceipt)
  );
  equal(first.terminalized, true, 'the original receipt is durably consumed at terminalization');
  const replayRegistry = path.join(replay.evidenceRoot, '.luna-executor-reservations');
  const replayRecordPath = path.join(replayRegistry, fs.readdirSync(replayRegistry).find(name => name.endsWith('.json')));
  const replayRecord = JSON.parse(fs.readFileSync(replayRecordPath, 'utf8'));
  replayRecord.payload.launchReceipt = {
    auditEventHash: replayReceipt.auditEventHash,
    auditSequence: replayReceipt.auditSequence,
    recordHash: replayReceipt.recordHash,
    launchId: replayReceipt.launchId
  };
  fs.writeFileSync(replayRecordPath, `${JSON.stringify(replayRecord, null, 2)}\n`, 'utf8');
  await assert.rejects(
    () => luna.executeLunaLane(
      commonInput(replay, replaySpec.secondLaneId, replaySpec.secondAllowedPaths, { launchReceipt: replayReceipt }),
      executorOverrides({ runLuna: successfulLaneRunner(replaySpec.secondAllowedPaths[0]) }, replayReceipt)
    ),
    error => error instanceof luna.LunaExecutorError && error.code === 'LUNA_RECEIPT_REUSED',
    'a completed signed receipt cannot be replayed when a persisted receipt object has reordered keys'
  );
  checks += 1;
} finally {
  removeLaneWorktree(replay, replaySpec.firstLaneId);
  removeLaneWorktree(replay, replaySpec.secondLaneId);
  fs.rmSync(replay.root, { recursive: true, force: true });
}

const reconciliation = makeRepo('q66-luna-reconcile-');
try {
  const reconciledReceipt = receiptFor('reconcile-source', 31);
  const completed = await luna.executeLunaLane(
    commonInput(reconciliation, 'q66-reconcile-source', ['src/reconcile-source.js'], { launchReceipt: reconciledReceipt }),
    executorOverrides({ runLuna: successfulLaneRunner('src/reconcile-source.js'), runVerification: successfulVerification() }, reconciledReceipt)
  );
  equal(completed.terminalized, true, 'the source reservation completed before restart simulation');
  const registry = path.join(reconciliation.evidenceRoot, '.luna-executor-reservations');
  const sourceRecordPath = path.join(registry, fs.readdirSync(registry).find(name => name.endsWith('.json')));
  const sourceRecord = JSON.parse(fs.readFileSync(sourceRecordPath, 'utf8'));
  sourceRecord.state = 'active';
  delete sourceRecord.terminalizedAt;
  delete sourceRecord.reconciledAt;
  fs.writeFileSync(sourceRecordPath, `${JSON.stringify(sourceRecord, null, 2)}\n`, 'utf8');
  const recoveryReceipt = receiptFor('reconcile-recovery', 32);
  const recovered = await luna.executeLunaLane(
    commonInput(reconciliation, 'q66-reconcile-recovery', ['src/reconcile-recovery.js'], { launchReceipt: recoveryReceipt }),
    executorOverrides({ runLuna: successfulLaneRunner('src/reconcile-recovery.js'), runVerification: successfulVerification() }, recoveryReceipt)
  );
  equal(recovered.outcome, 'eligible', 'a restart reconciles complete active evidence without blocking unrelated lanes');
  equal(JSON.parse(fs.readFileSync(sourceRecordPath, 'utf8')).state, 'terminal',
    'restart reconciliation durably terminalizes the completed active reservation');
} finally {
  removeLaneWorktree(reconciliation, 'q66-reconcile-source');
  removeLaneWorktree(reconciliation, 'q66-reconcile-recovery');
  fs.rmSync(reconciliation.root, { recursive: true, force: true });
}

const evidenceFailure = makeRepo('q66-luna-evidence-');
const evidenceSpec = {
  laneId: 'q66-evidence-failure', allowedPaths: ['src/evidence-failure.js'],
  receiptSeed: 'evidence-write-failure', auditSequence: 104, failingArtifact: 'manifest.json'
};
try {
  const evidenceReceipt = receiptFor(evidenceSpec.receiptSeed, evidenceSpec.auditSequence);
  const faultingFs = Object.create(fs);
  faultingFs.renameSync = (source, target, ...args) => {
    if (typeof target === 'string' && target.endsWith(evidenceSpec.failingArtifact)) {
      const error = new Error('simulated durable evidence failure');
      error.code = 'EIO';
      throw error;
    }
    return fs.renameSync(source, target, ...args);
  };
  const result = await luna.executeLunaLane(
    commonInput(evidenceFailure, evidenceSpec.laneId, evidenceSpec.allowedPaths, { launchReceipt: evidenceReceipt }),
    executorOverrides({
      fs: faultingFs,
      runLuna: successfulLaneRunner(evidenceSpec.allowedPaths[0]),
      runVerification: successfulVerification()
    }, evidenceReceipt)
  );
  equal(result.outcome, 'rejected', 'any evidence artifact write failure rejects the lane');
  ok(result.rejectionCodes.includes('EVIDENCE_WRITE_FAILED'), 'evidence write failure is explicit');
  equal(result.evidenceComplete, false, 'incomplete evidence can never become eligible evidence');
  equal(result.terminalized, false, 'a lane with incomplete durable evidence remains reserved for reconciliation');
} finally {
  removeLaneWorktree(evidenceFailure, evidenceSpec.laneId);
  fs.rmSync(evidenceFailure.root, { recursive: true, force: true });
}

// A crash before publishing the prepared lock leaves a staging directory only;
// a stale published owner with the same numeric PID but another start identity
// can be recovered without treating PID reuse as ownership.
const lockRecovery = makeRepo('q66-luna-lock-recovery-');
try {
  const registry = path.join(lockRecovery.evidenceRoot, '.luna-executor-reservations');
  fs.mkdirSync(path.join(registry, '.reservation-lock.staging-crash-before-publish'), { recursive: true });
  const staleLock = path.join(registry, '.reservation-lock');
  fs.mkdirSync(staleLock, { recursive: true });
  fs.writeFileSync(path.join(staleLock, 'owner.json'), JSON.stringify({
    pid: process.pid, startIdentity: 'different-process-with-reused-pid', createdAt: new Date().toISOString()
  }), 'utf8');
  const lockReceipt = receiptFor('lock-recovery', 121);
  const recoveredLock = await luna.executeLunaLane(
    commonInput(lockRecovery, 'q66-lock-recovery', ['src/lock-recovery.js'], { launchReceipt: lockReceipt }),
    executorOverrides({ runLuna: successfulLaneRunner('src/lock-recovery.js'), runVerification: successfulVerification() }, lockReceipt)
  );
  equal(recoveredLock.outcome, 'eligible', 'a stale lock is recovered only after its process-start identity mismatches');
  equal(fs.existsSync(path.join(registry, '.reservation-lock.staging-crash-before-publish')), true,
    'a crash-before-publish staging artifact is ignored rather than mistaken for ownership');
} finally {
  removeLaneWorktree(lockRecovery, 'q66-lock-recovery');
  fs.rmSync(lockRecovery.root, { recursive: true, force: true });
}

const malformedReservation = makeRepo('q66-luna-malformed-reservation-');
try {
  const malformedInput = commonInput(malformedReservation, 'q66-malformed-record', ['src/malformed.js']);
  const malformedHash = luna.executorPayloadHash(malformedInput);
  const registry = path.join(malformedReservation.evidenceRoot, '.luna-executor-reservations');
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, `${'a'.repeat(64)}.json`), JSON.stringify({
    schemaVersion: 1,
    kind: 'luna-controller-reservation',
    state: 'active',
    consumedAt: new Date().toISOString(),
    evidenceDir: path.join(malformedReservation.evidenceRoot, 'malformed-evidence'),
    payload: {
      launchReceipt: malformedInput.launchReceipt,
      executorPayloadHash: malformedHash,
      laneId: malformedInput.laneId,
      itemId: malformedInput.itemId,
      baseCommit: malformedInput.baseCommit,
      allowedPaths: 'outer-shape-valid-but-not-an-array',
      verificationCommand: malformedInput.verificationCommand
    }
  }, null, 2), 'utf8');
  await assert.rejects(
    () => luna.executeLunaLane(malformedInput, executorOverrides()),
    error => error instanceof luna.LunaExecutorError && error.code === 'LUNA_RESERVATION_CORRUPT',
    'an outer-valid persisted reservation with malformed nested authority fails closed'
  );
  checks += 1;
} finally {
  fs.rmSync(malformedReservation.root, { recursive: true, force: true });
}

const descendant = await luna.runBoundedCommand({
  command: process.execPath,
  args: ['-e', "const { spawn } = require('node:child_process'); const children = [spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }), spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })]; process.stdout.write(children.map(child => child.pid).join(',')); setInterval(() => {}, 1000);"],
  cwd: process.cwd(),
  timeoutMs: 1_000,
  outputBudgetBytes: 4_096,
  env: process.env
});
equal(descendant.timedOut, true, 'the parent process reaches the bounded timeout');
equal(descendant.descendantsContained, true, 'timeout resolves only after task-tree containment succeeds');
const descendantPids = descendant.stdout.trim().split(',').map(Number);
equal(descendantPids.length, 2, 'the timeout fixture exposes multiple descendant PIDs');
for (const descendantPid of descendantPids) {
  ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, 'the timeout fixture exposed a valid descendant PID');
  equal(processExists(descendantPid), false, 'every captured descendant is gone when the timeout result resolves');
}

console.log(`Luna executor tests passed (${checks} checks; isolated worktree, scope, receipt, evidence, and rejection contract).`);
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
