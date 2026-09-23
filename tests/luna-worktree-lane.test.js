// EXECUTABLE CHANGE
// Test-can-fail report (testcanfail-tests-luna-worktree-lane-test-js):
// - Strengthened the two child-process success checks below. Mutation: replaced
//   a child's execution with a zero exit and empty stdout, the observable shape
//   of a process that never ran the selected scenario. RED was:
//     AssertionError [ERR_ASSERTION]: child scenario emitted no unique PASS evidence: mutation probe
// - Restored the mutation byte-for-byte. The assertion-level green probe was:
//     PASS child scenario evidence assertion mutation probe
// - Full-suite green confirmation could not be met in this Linux container;
//   named preconditions: win32 and pinned Windows PowerShell 5.1 (and git.exe).
// - NOT-FOUND (1): no remaining assertion loop has an unguarded empty input;
//   scenario selection is asserted nonempty and child evidence is now explicit.
// - NOT-FOUND (2): rejection exit-status assertions also require the lane's own
//   failureCode; successful child exits are now paired with child-owned output.
// - NOT-FOUND (3): catches either rethrow, preserve the original cleanup error,
//   or defer malformed manifest output to a mandatory assertion.
// - NOT-FOUND (4): fixtures stand in for external agent/verifier dependencies,
//   not for the runner or policy recorder behavior asserted by the scenarios.
// - NOT-FOUND (5): platform requirements fail loudly; there is no skip/guard.
// - NOT-FOUND (6): expected results are literal contract values, not computed by
//   the runner under test.
'use strict';

// Q66 focused offline contract. Children are fake Node programs and the
// canonical audit database is a temporary, ignored fixture. No provider,
// network, service, credential, real Codex process, or agent is used.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const policyRecorder = require('../tools/record-luna-worktree-policy');

const RUNNER_SOURCE = path.resolve(__dirname, '..', 'tools', 'run-luna-worktree-lane.ps1');
const POLICY_RECORDER_SOURCE = path.resolve(__dirname, '..', 'tools', 'record-luna-worktree-policy.js');
const POWER_SHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const OUTER_WORKTREE = path.resolve(__dirname, '..');
// Keep high-churn process/worktree fixtures out of the OneDrive-backed repo.
// OneDrive can retain directory handles after child termination and turn an
// otherwise clean test into an EBUSY cleanup failure.
const TEST_TEMP_PARENT = path.join(os.tmpdir(), 'toolsenabled-q66-luna-worktree-lane-tests');
// This machine routinely runs several agent sessions concurrently, and any
// of them can invoke this exact file at the same time. TEST_TEMP_PARENT is a
// fixed, well-known name shared by every such invocation, so cases live in a
// per-process RUN_ROOT beneath it: unique per pid+run, never touched by a
// sibling process's cleanup. Only ever delete RUN_ROOT, never TEST_TEMP_PARENT
// itself -- deleting the shared parent would rip out a concurrent sibling's
// still-live fixtures (its audit sqlite3 file, its worktree, mid-scenario).
const RUN_ROOT = path.join(TEST_TEMP_PARENT, `run-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
const preservedCaseRoots = new Set();
/* ONE AT A TIME, BECAUSE THESE SCENARIOS ASSERT ON A CLOCK.
 *
 * This was 4. Measured 2026-08-24 on a machine running twenty agents: the
 * scenario that asserts VERIFICATION_TIMEOUT with `timeoutSeconds: 1` instead
 * failed preflight with CANONICAL_LAUNCH_HELPER_FAILED -- "the read-only
 * canonical launch verifier did not produce a bounded verdict". The helper
 * could not get started inside one second while three sibling scenarios were
 * competing for the CPU, so the test never reached the condition it exists to
 * measure and the chain reported it as a new regression.
 *
 * A test that asserts a one-second timeout cannot share the machine with its
 * own siblings. The bounded runner below is kept -- it is the right shape and
 * it carries the scenario name into the error, which is how this was diagnosed
 * at all -- but its width is 1 until a scenario's timing budget is decoupled
 * from how loaded the host is. Raising it again means giving the clock-sensitive
 * cases their own pass, not turning the number up. */
const CHILD_SCENARIO_CONCURRENCY = 4;

// Observation is not the signed agent/verifier workload budget. This test
// also observes PowerShell startup/compilation, read-only policy verification,
// worktree setup and retained evidence. A quiet canonical fixture measured
// 14.9s total with a 333ms verifier and ~80ms fake agent; width4 exceeded the
// old 20s outer cap before emitting a terminal manifest. Keep a finite setup
// allowance plus both workload caps. The specific 12s/20s cleanup assertions
// below stay unchanged and can still reject a regression inside this window.
const LANE_OBSERVATION_OVERHEAD_MS = 60_000;
function laneObservationTimeoutMs(lane) {
  return LANE_OBSERVATION_OVERHEAD_MS + 2 * lane.timeoutSeconds * 1000;
}

/* SCENARIOS THAT ASSERT ON A CLOCK GET THE MACHINE TO THEMSELVES.
 *
 * Measured 2026-08-24 on a host running twenty agents: with all scenarios
 * sharing four workers, the one asserting VERIFICATION_TIMEOUT at
 * `timeoutSeconds: 1` instead failed preflight with
 * CANONICAL_LAUNCH_HELPER_FAILED -- "the read-only canonical launch verifier
 * did not produce a bounded verdict". The helper could not start inside one
 * second while three siblings competed for the CPU, so the test never reached
 * the condition it exists to measure, and the chain reported it as a new
 * regression.
 *
 * Running EVERYTHING sequentially was tried and is not the answer: the suite
 * then exceeds its own time budget, which is why the concurrency was added in
 * the first place. So the split is by what a scenario measures. A case whose
 * assertion is "this took longer than N seconds" cannot share a machine with
 * its own siblings; every other case can.
 *
 * Add a name here when its scenario asserts on elapsed time, not when it is
 * merely slow. */
const CLOCK_SENSITIVE_SCENARIOS = new Set([
  /* Both of these assert `run.durationMs < 12_000` directly. */
  'agent timeout finite cleanup',
  'agent output overflow is bounded',
  /* These three assert that a termination or overflow path COMPLETES rather
     than hangs, which is the same measurement wearing different words. Listed
     with their siblings deliberately: naming only the one that happened to fail
     first is how the second one surfaced ten minutes later. */
  'last response overflow is bounded',
  'verification output overflow is bounded',
  'verification timeout finite cleanup',
  // This checks the canonical verifier's measured duration against 5s.
  'bounded large-ledger authorization',
]);
const AUDIT_WRITER_SOURCE = String.raw`
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { createAuditStore, canonicalJson, eventHashInput, sha256 } = require('./src/lib/audit-store');

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
let store = null;
try {
  store = createAuditStore({ file: input.file });
  if (input.kind === 'register') {
    store.registerKey({
      keyId: input.keyId,
      publicKeyPem: input.publicKeyPem,
      createdAtMs: input.createdAtMs,
    });
  } else if (input.kind === 'append') {
    const privateKey = crypto.createPrivateKey(input.privateKeyPem);
    store.appendEvent({
      eventId: input.eventId,
      occurredAtMs: input.occurredAtMs,
      createdAtMs: input.createdAtMs,
      event: input.event,
    }, {
      keyId: input.keyId,
      sign: bytes => crypto.sign(null, bytes, privateKey),
    });
  } else if (input.kind === 'bulk') {
    // A single explicit transaction creates a representative 19.6k-event
    // canonical history without making the focused offline suite spend its
    // time in 19.6k process launches or fsyncs.
    store.close();
    store = null;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(input.file, { allowExtension: false, enableForeignKeyConstraints: true });
    try {
      const privateKey = crypto.createPrivateKey(input.privateKeyPem);
      const prior = db.prepare('SELECT sequence, event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1').get();
      let sequence = prior ? prior.sequence : 0;
      let previousHash = prior ? prior.event_hash : '0'.repeat(64);
      const insert = db.prepare('INSERT INTO audit_events(sequence, event_id, occurred_at_ms, event_json, previous_hash, ' +
        'event_hash, key_id, signature, created_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const startedAtMs = input.createdAtMs;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (let index = 0; index < input.count; index += 1) {
          sequence += 1;
          const atMs = startedAtMs + index;
          const eventId = 'q66-bulk-' + String(index).padStart(8, '0');
          const eventJson = canonicalJson({
            timestamp: new Date(atMs).toISOString(), action: 'q66.fixture.filler', target: eventId,
            details: { schemaVersion: 1, filler: index },
          });
          const eventHash = sha256(eventHashInput({ sequence, eventId, occurredAtMs: atMs, eventJson, previousHash, keyId: input.keyId, createdAtMs: atMs }));
          const signature = crypto.sign(null, Buffer.from(eventHash, 'hex'), privateKey).toString('base64');
          insert.run(sequence, eventId, atMs, eventJson, previousHash, eventHash, input.keyId, signature, atMs);
          previousHash = eventHash;
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* original error wins */ }
        throw error;
      }
    } finally {
      db.close();
    }
  } else {
    throw new Error('unknown audit fixture operation');
  }
} finally {
  if (store) store.close();
}
`;

const AUDIT_LAUNCH_ANCHOR_SOURCE = String.raw`
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const db = new DatabaseSync(input.file, { readOnly: true, allowExtension: false, enableForeignKeyConstraints: true });
try {
  const rows = db.prepare(
    "SELECT * FROM audit_events WHERE json_extract(event_json, '$.action') = ? AND json_extract(event_json, '$.target') = ? ORDER BY sequence LIMIT 2"
  ).all('controller.agent.launch', input.launchId);
  if (rows.length !== 1) throw new Error('fixture launch selector was not unique');
  const row = rows[0];
  const key = db.prepare('SELECT public_key_hash FROM audit_keys WHERE key_id = ?').get(row.key_id);
  if (!key) throw new Error('fixture launch key was not found');
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    launchEventId: row.event_id,
    launchSequence: row.sequence,
    launchPreviousHash: row.previous_hash,
    launchEventHash: row.event_hash,
    launchKeyId: row.key_id,
    launchPublicKeyHash: key.public_key_hash,
  }) + '\n');
} finally {
  db.close();
}
`;

function safeEnvironment(extra = {}) {
  const names = [
    'APPDATA', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'LOCALAPPDATA',
    'OS', 'PATH', 'Path', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'ProgramData',
    'PROGRAMFILES', 'PUBLIC', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP',
    'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'windir'
  ];
  const result = {};
  for (const name of names) {
    if (process.env[name] !== undefined && result[name.toUpperCase()] === undefined) {
      result[name] = process.env[name];
    }
  }
  if (result.PATH === undefined && process.env.Path !== undefined) result.PATH = process.env.Path;
  if (result.Path === undefined && result.PATH !== undefined) result.Path = result.PATH;
  return { ...result, ...extra };
}

function runProcess(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: options.timeout || 30_000,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
  });
  if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;
  return result;
}

function runAuditWriter(payload) {
  const result = runProcess(process.execPath, ['-e', AUDIT_WRITER_SOURCE], {
    cwd: OUTER_WORKTREE,
    env: safeEnvironment(),
    input: JSON.stringify(payload),
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
  assert.equal(result.error && result.error.code, undefined, 'audit fixture writer timed out or failed to spawn');
  assert.equal(result.status, 0, `audit fixture writer failed\n${result.stdout}\n${result.stderr}`);
}

function git(cwd, args) {
  const result = runProcess('git.exe', args, { cwd, env: safeEnvironment(), timeout: 30_000 });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function auditSnapshot(auditFile) {
  return [auditFile].map(file => ({
    file: path.basename(file),
    exists: fs.existsSync(file),
    sha256: fs.existsSync(file) ? sha256File(file) : null,
    size: fs.existsSync(file) ? fs.statSync(file).size : null,
  }));
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sortedPaths(values) {
  return [...values].sort((left, right) => {
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function makeAuditFixture(controlRoot) {
  const auditFile = path.join(controlRoot, 'state', 'audit.sqlite3');
  const pair = crypto.generateKeyPairSync('ed25519');
  const keyId = 'q66-test-audit-key';
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  runAuditWriter({
    kind: 'register',
    file: auditFile,
    keyId,
    publicKeyPem,
    createdAtMs: Date.now(),
  });
  return { auditFile, keyId, privateKeyPem, nextEvent: 1 };
}

function appendAudit(fixture, action, target, details) {
  const now = Date.now();
  const suffix = String(fixture.nextEvent++).padStart(4, '0');
  runAuditWriter({
    kind: 'append',
    file: fixture.auditFile,
    keyId: fixture.keyId,
    privateKeyPem: fixture.privateKeyPem,
    eventId: `q66-audit-${suffix}`,
    occurredAtMs: now,
    createdAtMs: now,
    event: {
      timestamp: new Date(now).toISOString(),
      action,
      target,
      details,
    },
  });
}

function appendBulkAudit(fixture, count) {
  runAuditWriter({
    kind: 'bulk',
    file: fixture.auditFile,
    keyId: fixture.keyId,
    privateKeyPem: fixture.privateKeyPem,
    createdAtMs: Date.now(),
    count,
  });
}

function readLaunchAnchor(fixture, launch) {
  const result = runProcess(process.execPath, ['-e', AUDIT_LAUNCH_ANCHOR_SOURCE], {
    cwd: OUTER_WORKTREE,
    env: safeEnvironment(),
    input: JSON.stringify({ file: fixture.auditFile, launchId: launch }),
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
  assert.equal(result.error && result.error.code, undefined, 'audit fixture anchor reader timed out or failed to spawn');
  assert.equal(result.status, 0, `audit fixture anchor reader failed\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function makeRepository(root) {
  const repo = path.join(root, 'source repository');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 'q66-test@example.invalid']);
  git(repo, ['config', 'user.name', 'Q66 deterministic test']);
  write(path.join(repo, '.gitignore'), 'state/\n');
  write(path.join(repo, 'README.md'), 'Q66 base\n');
  git(repo, ['add', '--all']);
  git(repo, ['commit', '-m', 'Q66 fixture base']);
  const baseCommit = git(repo, ['rev-parse', 'HEAD']);
  assert.match(baseCommit, /^[0-9a-f]{40}$/);
  return { repo, baseCommit };
}

function makeFixture(root) {
  const source = makeRepository(root);
  const controlRoot = path.join(root, 'canonical control root');
  const script = path.join(controlRoot, 'tools', 'run-luna-worktree-lane.ps1');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(RUNNER_SOURCE, script);
  const audit = makeAuditFixture(controlRoot);
  return { ...source, controlRoot, script, audit };
}

function environmentReportSource(sourcePath) {
  return [
    "'use strict';",
    'const fs = require(\'node:fs\');',
    'const path = require(\'node:path\');',
    'const { spawn } = require(\'node:child_process\');',
    'const args = process.argv.slice(1);',
    'const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };',
    'const worktree = value(\'--cd\');',
    'const lastResponse = value(\'--output-last-message\');',
    'const pidFile = value(\'--q66-pid-file\');',
    'const names = Object.keys(process.env).sort();',
    'const requiredNames = [\'PATH\', \'SystemRoot\', \'TEMP\', \'TMP\', \'USERPROFILE\', \'CODEX_HOME\'];',
    'const required = Object.fromEntries(requiredNames.map(name => [name, names.some(item => item.toLowerCase() === name.toLowerCase())]));',
    'console.log(JSON.stringify({ args, cwd: process.cwd(), worktree, environmentNames: names, required }));',
    'if (pidFile) { fs.mkdirSync(path.dirname(pidFile), { recursive: true }); fs.writeFileSync(pidFile, `${process.pid}\\n`); }',
    'const actionIndex = args.indexOf(\'--q66-action\');',
    'const action = actionIndex >= 0 ? args[actionIndex + 1] : \'valid\';',
    "if (action === 'timeout') { fs.writeFileSync(path.join(worktree, 'allowed.txt'), 'allowed change\\n'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true }); if (pidFile) fs.appendFileSync(pidFile, `${child.pid}\\n`); setInterval(() => {}, 1000); }",
    "if (action === 'agent-overflow') { fs.writeFileSync(path.join(worktree, 'allowed.txt'), 'allowed change\\n'); process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000); }",
    "if (action === 'response-overflow') { fs.writeFileSync(path.join(worktree, 'allowed.txt'), 'allowed change\\n'); fs.writeFileSync(lastResponse, 'x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000); }",
    "if (action === 'valid' || action === 'nonzero' || action === 'out-of-scope' || action === 'source-interference' || action === 'verifier-timeout') fs.writeFileSync(path.join(worktree, 'allowed.txt'), 'allowed change\\n');",
    "if (action === 'untracked') fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'untracked change\\n');",
    "if (action === 'out-of-scope') fs.writeFileSync(path.join(worktree, 'agent-outside.txt'), 'outside change\\n');",
    `if (action === 'source-interference') fs.appendFileSync(${JSON.stringify(sourcePath)}, 'interference\\n');`,
    "if (action !== 'timeout' && action !== 'agent-overflow' && action !== 'response-overflow' && lastResponse) fs.writeFileSync(lastResponse, 'fake Luna last response\\n');",
    "if (action === 'nonzero') process.exit(7);",
  ].join('\n') + '\n';
}

function verificationSource(mode, worktreePath, controllerFile = null) {
  const escapedWorktree = JSON.stringify(worktreePath);
  const escapedControllerFile = JSON.stringify(controllerFile);
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const mode = ${JSON.stringify(mode)};`,
    `const controllerFile = ${escapedControllerFile};`,
    'const names = Object.keys(process.env).sort();',
    'const requiredNames = [\'PATH\', \'SystemRoot\', \'TEMP\', \'TMP\', \'USERPROFILE\', \'CODEX_HOME\'];',
    'const required = Object.fromEntries(requiredNames.map(name => [name, names.some(item => item.toLowerCase() === name.toLowerCase())]));',
    "if (mode === 'timeout') setInterval(() => {}, 1000);",
    "if (mode === 'overflow') { process.stdout.write('v'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000); }",
    "if (mode === 'out-of-scope') fs.writeFileSync(path.join(process.cwd(), 'verifier-outside.txt'), 'verifier outside change\\n');",
    "if (mode === 'change-allowed') fs.appendFileSync(path.join(process.cwd(), 'allowed.txt'), 'verifier changed\\n');",
    "if (mode === 'controller-write') fs.appendFileSync(controllerFile, 'verifier changed controller input\\n');",
    `console.log(JSON.stringify({ cwd: process.cwd(), expectedWorktree: ${escapedWorktree}, environmentNames: names, required }));`,
    "if (mode === 'fail') { console.error('verification fixture failure'); process.exit(9); }",
  ].join('\n') + '\n';
}

function launchId(index) {
  return `launch_q66_${String(index).padStart(20, '0')}`;
}

function agentProfile(lane) {
  if (lane.agentProfile === 'terra') {
    return { name: 'terra', targetAgentId: 'terra', tier: 'standard', tierProposed: true, model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' };
  }
  if (lane.agentProfile === 'sol') {
    return { name: 'sol', targetAgentId: 'sol', tier: 'premium', tierProposed: true, model: 'gpt-5.6-sol', reasoningEffort: 'ultra' };
  }
  return { name: 'luna', targetAgentId: 'luna', tier: 'cheap', tierProposed: false, model: 'gpt-5.6-luna', reasoningEffort: 'max' };
}

function scopePacketForProfile(profile) {
  if (profile.name !== 'sol') return null;
  return {
    schemaVersion: 1,
    agentId: 'sol',
    threadId: null,
    generatedAt: new Date().toISOString(),
    appliedRuleIds: ['rule_customer_game_agent_model'],
    rules: [{
      ruleId: 'rule_customer_game_agent_model',
      ruleKey: 'game.agent.model',
      scopeKind: 'global',
      threadId: null,
      sourceRequestId: 'R400',
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      decisionSummary: 'This installation explicitly selects the Sol model for this lane.',
      evidenceRefs: ['state/current-owner-ledger.json#R400'],
      ownerVerbatim: 'Use the configured Sol model for this lane.'
    }],
    conflicts: [],
    grantsAuthority: false
  };
}

function policyForLane(lane, fixture) {
  const profile = agentProfile(lane);
  const agentArguments = ['--ask-for-approval', 'never'];
  if (lane.applyPatchOnly) agentArguments.push('--disable', 'shell_tool');
  agentArguments.push('exec', '--json', '--ephemeral', '--ignore-user-config');
  if (lane.allowNpmRegistryNetwork) {
    agentArguments.push(
      '-c', 'default_permissions="lane-npm-registry"',
      '-c', 'permissions.lane-npm-registry.extends=":workspace"',
      '-c', 'permissions.lane-npm-registry.network.enabled=true',
      '-c', 'permissions.lane-npm-registry.network.domains={ "registry.npmjs.org" = "allow", "127.0.0.1" = "allow" }',
    );
  }
  agentArguments.push(
    '-c', 'windows.sandbox="elevated"',
    '-c', 'mcp_servers={}',
  );
  if (!lane.allowNpmRegistryNetwork) agentArguments.push('--sandbox', 'workspace-write');
  agentArguments.push(
    '--cd', lane.worktreePath,
    '--model', profile.model, '-c', `model_reasoning_effort=${profile.reasoningEffort}`, '--output-last-message',
    path.join(lane.artifactPath, 'last-response.txt'), '-',
  );
  return {
    schemaVersion: 1,
    controllerActor: 'codex',
    launchId: lane.launchId,
    laneId: lane.laneId,
    objectiveRef: lane.objectiveRef,
    baseCommit: lane.baseCommit,
    allowlist: sortedPaths(lane.allowlist),
    prompt: { path: lane.promptFile, sha256: sha256File(lane.promptFile) },
    verification: {
      program: lane.verificationProgram,
      sha256: sha256File(lane.verificationProgram),
      arguments: lane.verificationArgument,
      allowChangedPathArguments: Boolean(lane.allowChangedPathArguments),
    },
    timeoutSeconds: lane.timeoutSeconds,
    outputBudgetBytes: lane.outputBudgetBytes,
    agent: {
      program: lane.codexExecutablePath,
      sha256: sha256File(lane.codexExecutablePath),
      prefixArguments: lane.codexPrefixArgument,
      arguments: agentArguments,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      sandbox: lane.allowNpmRegistryNetwork ? 'permission-profile:lane-npm-registry' : 'workspace-write',
      nodePath: lane.nodeExecutablePath,
      nodeSha256: sha256File(lane.nodeExecutablePath),
    },
    auditAnchor: readLaunchAnchor(fixture.audit, lane.launchId),
  };
}

function appendCanonicalLaunch(fixture, lane, options) {
  const profile = agentProfile({ agentProfile: options.auditAgentProfile || lane.agentProfile });
  const allowlist = sortedPaths(lane.allowlist);
  const record = {
    schemaVersion: 1,
    launchId: lane.launchId,
    requestingActor: 'codex',
    targetAgentId: profile.targetAgentId,
    tier: profile.tier,
    tierProposed: profile.tierProposed,
    model: profile.model,
    objectiveRef: options.auditObjectiveRef || lane.objectiveRef,
    cap: { kind: 'turns', value: 1, capMs: Math.max(60_000, lane.timeoutSeconds * 1000 + 10_000) },
    parentLaunchId: null,
    depth: 0,
    launchedAt: new Date().toISOString(),
    terminalState: options.terminalState || 'pending',
  };
  const scopePacket = scopePacketForProfile(profile);
  if (scopePacket !== null) record.scopePacket = scopePacket;
  if (options.launchUnknownField) record.unrecognizedObjectiveCapability = true;
  appendAudit(fixture.audit, 'controller.agent.launch', options.auditLaunchTarget || lane.launchId, { schemaVersion: 1, record });
  if (!options.skipPolicy) {
    appendAudit(fixture.audit, 'controller.agent.launch.policy', lane.launchId, policyForLane(lane, fixture));
  }
}

function makeCase(root, fixture, fakeAgent, index, options = {}) {
  const laneId = options.laneId || `lane-${index}`;
  const allowlist = options.allowlist || ['allowed.txt'];
  const promptFile = options.promptFile || path.join(root, 'inputs', `${laneId}-prompt.txt`);
  if (!fs.existsSync(promptFile)) write(promptFile, 'Implement only the exact assigned file change.\n');
  const worktreePath = options.worktreePath || path.join(root, 'lanes', laneId);
  const artifactPath = options.artifactPath || path.join(root, 'artifacts', laneId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  if (!isPathWithin(worktreePath, artifactPath)) fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const verificationProgram = process.execPath;
  const verificationArgument = options.verificationArgument || ['-e', verificationSource(options.verifyMode || 'valid', worktreePath, options.controllerFile || null), 'deterministic'];
  const fakeAction = options.fakeAction || 'valid';
  const pidFile = path.join(root, 'child-pids', `${laneId}.txt`);
  const codexPrefixArgument = ['-e', fakeAgent, 'deterministic', '--q66-action', fakeAction, '--q66-pid-file', pidFile];
  const lane = {
    script: fixture.script,
    repoPath: fixture.repo,
    worktreePath,
    artifactPath,
    baseCommit: fixture.baseCommit,
    launchId: launchId(index),
    laneId,
    objectiveRef: options.objectiveRef || 'Q66',
    allowlist,
    promptFile,
    verificationProgram,
    verificationArgument,
    timeoutSeconds: options.timeoutSeconds || 5,
    outputBudgetBytes: options.outputBudgetBytes || 128 * 1024,
    codexExecutablePath: process.execPath,
    nodeExecutablePath: process.execPath,
    codexPrefixArgument,
    allowChangedPathArguments: Boolean(options.allowChangedPathArguments),
    applyPatchOnly: Boolean(options.applyPatchOnly),
    allowNpmRegistryNetwork: Boolean(options.allowNpmRegistryNetwork),
    agentProfile: options.agentProfile || 'luna',
    fakeAction,
    pidFile,
    verifyMode: options.verifyMode || 'valid',
    legacyPublicKeyPath: options.legacyPublicKeyPath || null,
  };
  appendCanonicalLaunch(fixture, lane, options);
  return lane;
}

function runLane(lane) {
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lane.script,
    '-RepoPath', lane.repoPath,
    '-WorktreePath', lane.worktreePath,
    '-ArtifactPath', lane.artifactPath,
    '-BaseCommit', lane.baseCommit,
    '-LaunchId', lane.launchId,
    '-LaneId', lane.laneId,
    '-ObjectiveRef', lane.objectiveRef,
    '-AllowPath', ...lane.allowlist,
    '-PromptFile', lane.promptFile,
    '-VerificationProgram', lane.verificationProgram,
    '-VerificationArgumentsJson', JSON.stringify(lane.verificationArgument),
    '-TimeoutSeconds', String(lane.timeoutSeconds),
    '-OutputBudgetBytes', String(lane.outputBudgetBytes),
    '-CodexExecutablePath', lane.codexExecutablePath,
    '-NodeExecutablePath', lane.nodeExecutablePath,
    '-CodexPrefixArgumentsJson', JSON.stringify(lane.codexPrefixArgument),
  ];
  if (lane.allowChangedPathArguments) args.push('-AllowVerificationChangedPathArguments');
  if (lane.applyPatchOnly) args.push('-ApplyPatchOnly');
  if (lane.allowNpmRegistryNetwork) args.push('-AllowNpmRegistryNetwork');
  if (lane.agentProfile !== 'luna') args.push('-AgentProfile', lane.agentProfile);
  if (lane.legacyPublicKeyPath) args.push('-LaunchPublicKeyPath', lane.legacyPublicKeyPath);
  const startedAt = Date.now();
  const harnessTimeoutMs = laneObservationTimeoutMs(lane);
  const result = runProcess(POWER_SHELL, args, {
    cwd: path.dirname(lane.script),
    timeout: harnessTimeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: safeEnvironment({
      CODEX_HOME: path.join(path.dirname(lane.repoPath), 'safe-codex-home'),
      OPENAI_API_KEY: 'sentinel-openai-value',
      AUTH_TOKEN: 'sentinel-auth-value',
      PASSWORD: 'sentinel-password-value',
      PASSWD: 'sentinel-passwd-value',
      CREDENTIALS: 'sentinel-credentials-value',
      BRIDGE_TOKEN: 'sentinel-bridge-value',
      TUNNEL_TOKEN: 'sentinel-tunnel-value',
      CLOUD_PROVIDER_KEY: 'sentinel-cloud-value',
      TOOLSENABLED_VAULT_PATH: 'sentinel-vault-path',
      KEY_API: 'sentinel-key-api-value',
    }),
  });
  const durationMs = Date.now() - startedAt;
  // "We killed it" and "it produced nothing" are DIFFERENT results and were
  // being reported as the same one. runProcess deliberately swallows ETIMEDOUT
  // (see its `result.error.code !== 'ETIMEDOUT'` guard) and hands back a result
  // whose stdout and stderr are empty because the child was terminated, not
  // because the lane declined to answer. The manifest assertion below then said
  // "lane did not emit a terminal manifest" -- a claim about the LANE -- for
  // what is actually a statement about the MEASUREMENT. Observed 2026-08-25 on
  // this contended machine: one scenario per run failed that way, a different
  // scenario each run, always with both streams empty. runPreparation already
  // separates the two cases; runLane did not.
  if (result.error && result.error.code === 'ETIMEDOUT') {
    const error = new Error(
      `lane MEASUREMENT FAILED, not the lane: the harness killed ${lane.laneId} after `
      + `${harnessTimeoutMs} ms (elapsed ${durationMs} ms) before it could emit a terminal `
      + 'manifest, so this run says nothing about whether the lane would have refused, '
      + `passed, or hung.\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
    error.code = 'Q66_LANE_MEASUREMENT_TIMEOUT';
    error.preserveCaseEvidence = true;
    throw error;
  }
  let manifest = null;
  const manifestPath = path.join(lane.artifactPath, 'terminal-manifest.json');
  if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest && result.stdout) {
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    try { manifest = JSON.parse(lines[lines.length - 1]); } catch { /* assertion below reports it */ }
  }
  assert.ok(manifest, `lane did not emit a terminal manifest\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  try { assertNoRecordedChildren(lane, manifest); }
  catch (error) { error.preserveCaseEvidence = true; throw error; }
  return { result, manifest, durationMs };
}

function runPreparation(lane, observeProcess = runProcess) {
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lane.script,
    '-RepoPath', lane.repoPath,
    '-WorktreePath', lane.worktreePath,
    '-ArtifactPath', lane.artifactPath,
    '-BaseCommit', lane.baseCommit,
    '-LaunchId', lane.launchId,
    '-LaneId', lane.laneId,
    '-ObjectiveRef', lane.objectiveRef,
    '-AllowPath', ...lane.allowlist,
    '-PromptFile', lane.promptFile,
    '-VerificationProgram', lane.verificationProgram,
    '-VerificationArgumentsJson', JSON.stringify(lane.verificationArgument),
    '-TimeoutSeconds', String(lane.timeoutSeconds),
    '-OutputBudgetBytes', String(lane.outputBudgetBytes),
    '-CodexExecutablePath', lane.codexExecutablePath,
    '-NodeExecutablePath', lane.nodeExecutablePath,
    '-CodexPrefixArgumentsJson', JSON.stringify(lane.codexPrefixArgument),
    '-PreparePolicy',
  ];
  if (lane.allowChangedPathArguments) args.push('-AllowVerificationChangedPathArguments');
  if (lane.applyPatchOnly) args.push('-ApplyPatchOnly');
  if (lane.allowNpmRegistryNetwork) args.push('-AllowNpmRegistryNetwork');
  if (lane.agentProfile !== 'luna') args.push('-AgentProfile', lane.agentProfile);
  const startedAt = Date.now();
  const result = observeProcess(POWER_SHELL, args, {
    cwd: path.dirname(lane.script),
    timeout: laneObservationTimeoutMs(lane),
    maxBuffer: 8 * 1024 * 1024,
    env: safeEnvironment({
      CODEX_HOME: path.join(path.dirname(lane.repoPath), 'safe-codex-home'),
      OPENAI_API_KEY: 'sentinel-openai-value',
      TUNNEL_TOKEN: 'sentinel-tunnel-value',
      TOOLSENABLED_VAULT_PATH: 'sentinel-vault-path',
    }),
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    const error = new Error('policy preparation observation timed out; native child cleanup is unknown');
    error.code = 'Q66_PREPARATION_MEASUREMENT_TIMEOUT';
    error.preserveCaseEvidence = true;
    throw error;
  }
  assert.equal(result.error && result.error.code, undefined, 'policy preparation timed out or failed to spawn');
  assert.equal(result.status, 0, `policy preparation failed\n${result.stdout}\n${result.stderr}`);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `policy preparation produced an unexpected output shape\n${result.stdout}\n${result.stderr}`);
  return { result, policy: JSON.parse(lines[0]), durationMs: Date.now() - startedAt };
}

function expectRejected(run, failureCode, failureClass) {
  const acceptedCodes = Array.isArray(failureCode) ? failureCode : [failureCode];
  assert.notEqual(run.result.status, 0, `expected rejection ${acceptedCodes.join(' or ')}`);
  assert.ok(acceptedCodes.includes(run.manifest.failureCode),
    `expected rejection ${acceptedCodes.join(' or ')}, received ${run.manifest.failureCode}\n${run.result.stderr || run.result.stdout}`);
  if (failureClass) assert.equal(run.manifest.failureClass, failureClass);
}

function assertNoRecordedChildren(lane, manifest) {
  if (!fs.existsSync(lane.pidFile)) return;
  const pids = fs.readFileSync(lane.pidFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(Number);
  assert.ok(pids.length > 0, 'recorded child evidence must not be empty');
  for (const pid of pids) {
    assert.equal(Number.isSafeInteger(pid) && pid > 0, true, `invalid recorded child pid ${pid}`);
  }
  // A later signal-zero probe can observe a reused PID, not the original
  // fixture. The actual runner now measures its retained, non-breakaway Job;
  // the native scenario below independently checks a living detached child's
  // membership before cancellation and a separate Job surviving that stop.
  const agent = manifest.agent;
  assert.ok(agent && agent.started, 'recorded agent lacks a native launch');
  assert.equal(agent.rootPid, pids[0], 'recorded fixture must be the original native root');
  assert.match(agent.rootStartTicks, /^[1-9][0-9]+$/);
  assert.equal(agent.jobEmpty, true, 'original agent Job has not measured zero active members');
  assert.equal(agent.cleanupFailed, false, 'agent cleanup is not proven');
  assert.ok(Number.isSafeInteger(agent.containedProcessCount) && agent.containedProcessCount >= pids.length,
    'native accounting must include every recorded fixture process');
}

function assertPreserved(run) {
  assert.equal(run.manifest.worktree.preserved, true);
  assert.equal(fs.existsSync(run.manifest.worktreePath), true);
}

function artifactJson(file) {
  const content = fs.readFileSync(file, 'utf8').trim();
  return JSON.parse(content);
}

function testNativeProcessContainment(root) {
  const pidFile = path.join(root, 'native-evidence-shape.txt');
  write(pidFile, '123\n');
  const evidence = { started: true, rootPid: 123, rootStartTicks: '123456789',
    jobEmpty: true, cleanupFailed: false, containedProcessCount: 1 };
  for (const change of [{ rootPid: 124 }, { rootStartTicks: null }, { jobEmpty: false },
    { cleanupFailed: true }, { containedProcessCount: 0 }, { started: false }]) {
    assert.throws(() => assertNoRecordedChildren({ pidFile }, { agent: { ...evidence, ...change } }),
      'missing or mismatched native evidence must not establish child cleanup');
  }
  write(pidFile, '');
  assert.throws(() => assertNoRecordedChildren({ pidFile }, { agent: evidence }),
    /recorded child evidence must not be empty/);
  const probe = path.join(root, 'native-process-probe.ps1');
  write(probe, String.raw`param([string]$Runner, [string]$Node)
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Runner, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Runner did not parse' }
$functions = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Initialize-BoundedCaptureType'
}, $true))
if ($functions.Count -ne 1) { throw 'Expected the actual native capture initializer' }
Invoke-Expression $functions[0].Extent.Text
Initialize-BoundedCaptureType
$owned = New-Object 'System.Collections.Generic.List[Q66Lane.ContainedProcess]'
function New-Probe([string]$Code) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Node
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Code))
  $info.Arguments = '-e "eval(Buffer.from(''' + $encoded + ''',''base64'').toString())"'
  $info.WorkingDirectory = $PSScriptRoot
  $info.EnvironmentVariables.Clear()
  foreach ($name in @('PATH','SystemRoot','TEMP','TMP','USERPROFILE')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($null -ne $value) { $info.EnvironmentVariables[$name] = $value }
  }
  $info.EnvironmentVariables['Q66_UNICODE'] = [string][char]0x3bb
  $child = New-Object Q66Lane.ContainedProcess
  $owned.Add($child)
  $child.StartInfo = $info
  if (-not $child.Start()) { throw 'No child started' }
  $child.StandardInput.Close()
  return $child
}
try {
  $normal = New-Probe 'console.log(process.env.Q66_UNICODE);'
  $output = $normal.StandardOutput.ReadToEndAsync()
  if (-not $normal.WaitForExit(10000) -or $normal.ExitCode -ne 0 -or -not $normal.WaitForEmpty(5000)) { throw 'Normal completion failed' }
  if (-not $output.Wait(1000) -or $output.Result.Trim() -ne [string][char]0x3bb) { throw 'Private Unicode environment/output failed' }
  if ($normal.TotalProcesses -lt 1 -or $normal.StartTicks -notmatch '^[1-9][0-9]+$' -or $normal.ProcessIds().Length -ne 0) { throw 'Creation/accounting evidence missing' }
  Write-Output 'PASS normal root: private pipes, Unicode environment, native identity and Job zero'
  $code259 = New-Probe 'process.exit(259);'
  if (-not $code259.WaitForExit(10000) -or $code259.ExitCode -ne 259 -or -not $code259.WaitForEmpty(5000)) { throw 'Exit 259 was not retained' }
  Write-Output 'PASS native exit 259 is a completed root, not STILL_ACTIVE'
  $survivor = New-Probe 'const c=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{detached:true,stdio:"ignore",windowsHide:true});console.log(c.pid);c.unref();'
  $descendantId = $survivor.StandardOutput.ReadToEndAsync()
  if (-not $survivor.WaitForExit(10000) -or $survivor.ExitCode -ne 0) { throw 'Parent did not finish' }
  if (-not $descendantId.Wait(1000) -or $descendantId.Result.Trim() -notmatch '^[1-9][0-9]+$') { throw 'Detached child identity missing' }
  if ($survivor.TotalProcesses -lt 2 -or $survivor.ProcessIds() -notcontains [long]$descendantId.Result.Trim()) { throw 'Live detached descendant was not measured' }
  if (-not $survivor.Stop(5000) -or $survivor.ActiveProcesses -ne 0 -or $survivor.ExitCode -ne 0) { throw 'Exact Job cleanup failed' }
  Write-Output 'PASS exited root plus live detached child: native membership then exact Job cleanup'
  $live = New-Probe 'setTimeout(()=>{},30000);'
  $other = New-Probe 'setTimeout(()=>{},30000);'
  if ($live.HasExited -or $other.HasExited) { throw 'Live fixtures did not start' }
  # Compare two native readings of the same still-owned process, not separate
  # wall-clock calls whose Windows clock resolutions need not agree.
  $observer = [System.Diagnostics.Process]::GetProcessById($other.Id)
  try {
    if ($other.ProcessIds() -notcontains [long]$other.Id -or [long]$other.StartTicks -ne $observer.StartTime.ToUniversalTime().Ticks) { throw 'Original creation identity mismatch' }
  } finally { $observer.Dispose() }
  if (-not $live.Stop(5000) -or $live.ActiveProcesses -ne 0 -or $other.HasExited -or $other.ProcessIds() -notcontains [long]$other.Id) { throw 'Cleanup crossed a Job boundary' }
  if (-not $other.Stop(5000)) { throw 'Control cleanup failed' }
  Write-Output 'PASS live cancellation affects only the retained Job; adjacent Job survives'
} finally {
  $cleanupFailed = $false
  foreach ($child in $owned) {
    try { if (-not $child.Stop(5000)) { $cleanupFailed = $true } }
    catch { $cleanupFailed = $true }
    finally { $child.Dispose() }
  }
  if ($cleanupFailed) { throw 'Native probe cleanup could not be verified' }
}
`);
  const result = runProcess(POWER_SHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe,
    '-Runner', RUNNER_SOURCE, '-Node', process.execPath,
  ], { cwd: root, env: safeEnvironment() });
  assert.equal(result.status, 0, 'native process controls failed\n' + result.stdout + '\n' + result.stderr);
  for (const marker of ['PASS normal root:', 'PASS native exit 259', 'PASS exited root plus live detached child:', 'PASS live cancellation affects only the retained Job;']) {
    assert.ok(result.stdout.includes(marker), 'missing native evidence: ' + marker);
  }
}

function testFileHashSnapshots(root) {
  const first = path.join(root, 'hash first [literal].bin');
  const second = path.join(root, 'hash second.bin');
  write(first, 'AAAA');
  write(second, 'CCCC');
  const probe = path.join(root, 'hash-snapshot-probe.ps1');
  write(probe, String.raw`
param([string]$Runner, [string]$First, [string]$Second, [string]$Before, [string]$After, [string]$Other)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Runner, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Runner did not parse' }
$functions = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-FileHashSnapshot'
}, $true))
if ($functions.Count -ne 1) { throw 'Expected the actual runner hash snapshot function' }
Invoke-Expression $functions[0].Extent.Text
$script:reads = @()
$script:blockedWrites = 0
$script:failHash = $false
function Get-FileHash {
  param([System.IO.Stream]$InputStream, [string]$Algorithm)
  $script:reads += $InputStream.Name
  # Both files must already be held, including a file not hashed yet.
  foreach ($candidate in @($First, $Second)) {
    $writer = $null
    try {
      $writer = [System.IO.File]::Open($candidate, 'Open', 'Write', 'ReadWrite')
      throw 'Snapshot allowed a concurrent writer'
    } catch [System.IO.IOException] { $script:blockedWrites += 1 }
    finally { if ($null -ne $writer) { $writer.Dispose() } }
  }
  if ($script:failHash) { throw 'injected hash read failure' }
  Microsoft.PowerShell.Utility\Get-FileHash -InputStream $InputStream -Algorithm $Algorithm
}
function Assert-Released {
  foreach ($candidate in @($First, $Second)) {
    $exclusive = [System.IO.File]::Open($candidate, 'Open', 'ReadWrite', 'None')
    $exclusive.Dispose()
  }
}
$paths = @($First, $Second, $First.ToUpperInvariant(), $First)
$snapshot = Get-FileHashSnapshot -Paths $paths
if ($snapshot.Count -ne 2 -or $script:reads.Count -ne 2 -or $script:blockedWrites -ne 4) { throw 'Distinct files were not hashed once with all inputs held' }
if ($snapshot[$First] -ne $Before -or $snapshot[$First.ToUpperInvariant()] -ne $Before -or $snapshot[$Second] -ne $Other) { throw 'Snapshot digest mismatch' }
Assert-Released
$timestamp = [System.IO.File]::GetLastWriteTimeUtc($First)
[System.IO.File]::WriteAllText($First, 'BBBB', (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::SetLastWriteTimeUtc($First, $timestamp)
$fresh = Get-FileHashSnapshot -Paths $paths
if ($fresh[$First] -ne $After -or $fresh[$Second] -ne $Other -or $script:reads.Count -ne 4) { throw 'A later boundary reused stale content with unchanged size and timestamp' }
Assert-Released
$script:failHash = $true
$failed = $false
try { Get-FileHashSnapshot -Paths $paths | Out-Null }
catch {
  if ($_.Exception.Message -notmatch 'injected hash read failure' -or @($First, $Second) -notcontains $_.Exception.Data['LaneHashPath']) { throw }
  $failed = $true
}
if (-not $failed) { throw 'Hash read failure was accepted' }
Assert-Released
$script:failHash = $false
$missing = $First + '.missing'
$failed = $false
try { Get-FileHashSnapshot -Paths @($First, $missing) | Out-Null }
catch {
  if ($_.Exception.Data['LaneHashPath'] -ne $missing) { throw 'Missing input failure lost its path' }
  $failed = $true
}
if (-not $failed) { throw 'Missing input was accepted' }
Assert-Released
Write-Output 'PASS actual hash snapshot: distinct reads, held files, fresh bytes, failure cleanup'
`);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const result = runProcess(POWER_SHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe,
    '-Runner', RUNNER_SOURCE, '-First', first, '-Second', second,
    '-Before', hash('AAAA'), '-After', hash('BBBB'), '-Other', hash('CCCC'),
  ], { cwd: root, env: safeEnvironment() });
  assert.equal(result.status, 0, `hash snapshot controls failed\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^PASS actual hash snapshot: distinct reads, held files, fresh bytes, failure cleanup\r?$/m);
}

function laneDiagnostics(run) {
  const files = run.manifest.artifacts || {};
  const read = file => file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return `${run.result.stderr || ''}\nstate=${run.manifest.terminalState} failure=${run.manifest.failureClass}/${run.manifest.failureCode}: ${run.manifest.failureMessage || ''}\nagent-command=${run.manifest.agent.commandLine || ''}\nagent-stdout=${read(files.agentStdout)}\nagent-stderr=${read(files.agentStderr)}\nverification-stdout=${read(files.verificationStdout)}\nverification-stderr=${read(files.verificationStderr)}`;
}

function testValidCanonicalIsolationEnvironment(root, fixture, fakeAgent) {
  const legacyKey = path.join(root, 'inputs', 'arbitrary-public-key.json');
  write(legacyKey, '{"kty":"RSA","n":"not-a-trust-anchor","e":"AQAB"}\n');
  const lane = makeCase(root, fixture, fakeAgent, 1, { legacyPublicKeyPath: legacyKey });
  const auditBefore = auditSnapshot(fixture.audit.auditFile);
  const run = runLane(lane);
  assert.equal(run.result.status, 0, laneDiagnostics(run));
  assert.equal(run.manifest.terminalState, 'accepted');
  assert.equal(run.manifest.evidence.canonicalVerified, true);
  assert.equal(run.manifest.evidence.canonicalControlRoot, fixture.controlRoot);
  assert.equal(run.manifest.evidence.canonicalAuditPath, fixture.audit.auditFile);
  assert.equal(run.manifest.evidence.legacyPublicKeyIgnored, true);
  assert.equal(run.manifest.evidence.publicKeyPath, undefined);
  assert.equal(run.manifest.verification.controllerOwned, true);
  assert.equal(run.manifest.verification.passed, true);
  assert.deepEqual(run.manifest.changedPaths, ['allowed.txt']);
  assert.equal(run.manifest.worktree.head, fixture.baseCommit);
  assert.equal(run.manifest.worktree.detached, true);
  assert.equal(isPathWithin(run.manifest.repoPath, run.manifest.worktreePath), false);
  assert.equal(isPathWithin(run.manifest.repoPath, run.manifest.artifactPath), false);
  assert.equal(isPathWithin(fixture.controlRoot, lane.repoPath), false);
  assert.equal(isPathWithin(lane.repoPath, fixture.controlRoot), false);
  assert.equal(fs.existsSync(path.join(lane.repoPath, 'state', 'audit.sqlite3')), false);
  assert.equal(fs.existsSync(path.join(lane.repoPath, 'allowed.txt')), false);
  assert.equal(fs.readFileSync(path.join(lane.worktreePath, 'allowed.txt'), 'utf8'), 'allowed change\n');
  const agentReport = artifactJson(run.manifest.artifacts.agentStdout);
  const verificationReport = artifactJson(run.manifest.artifacts.verificationStdout);
  for (const report of [agentReport, verificationReport]) {
    const names = new Set(report.environmentNames.map(name => name.toLowerCase()));
    for (const secretName of ['OPENAI_API_KEY', 'AUTH_TOKEN', 'PASSWORD', 'PASSWD', 'CREDENTIALS', 'BRIDGE_TOKEN', 'TUNNEL_TOKEN', 'CLOUD_PROVIDER_KEY', 'TOOLSENABLED_VAULT_PATH', 'KEY_API']) {
      assert.equal(names.has(secretName.toLowerCase()), false, `${secretName} reached a child`);
    }
    for (const [name, present] of Object.entries(report.required)) assert.equal(present, true, `${name} was not usable in the child`);
  }
  assert.ok(run.manifest.agent.removedEnvironmentNames.includes('OPENAI_API_KEY'));
  assert.ok(run.manifest.verification.removedEnvironmentNames.includes('TOOLSENABLED_VAULT_PATH'));
  assert.ok(run.manifest.environment.canonicalVerifierDroppedNames.includes('TUNNEL_TOKEN'));
  assert.deepEqual(auditSnapshot(fixture.audit.auditFile), auditBefore, 'read-only canonical verification mutated its ledger');
  const allArtifacts = Object.values(run.manifest.artifacts).filter(file => fs.existsSync(file) && fs.statSync(file).isFile())
    .map(file => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(allArtifacts.includes('sentinel-openai-value'), false);
  assert.equal(git(lane.repoPath, ['status', '--porcelain', '--ignored=matching']), '');
}

function testCanonicalAuditRequired(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 2, { skipPolicy: true, legacyPublicKeyPath: path.join(root, 'missing-key.json') });
  const run = runLane(lane);
  expectRejected(run, 'CANONICAL_POLICY_NOT_FOUND', 'preflight');
  assert.equal(fs.existsSync(lane.worktreePath), false);
}

function testControllerPreparationIsReadOnlyAndNonQ66SliceExecutes(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 29, {
    skipPolicy: true,
    objectiveRef: 'Q67',
    applyPatchOnly: true,
  });
  const auditBefore = auditSnapshot(fixture.audit.auditFile);
  const prepared = runPreparation(lane);
  assert.deepEqual(prepared.policy, policyForLane(lane, fixture));
  assert.deepEqual(prepared.policy.agent.arguments.slice(0, 4),
    ['--ask-for-approval', 'never', '--disable', 'shell_tool']);
  assert.equal(fs.existsSync(lane.worktreePath), false, 'preparation created a worktree');
  assert.equal(fs.existsSync(lane.artifactPath), false, 'preparation created an artifact directory');
  assert.equal(fs.existsSync(lane.pidFile), false, 'preparation started a fake agent');
  assert.deepEqual(auditSnapshot(fixture.audit.auditFile), auditBefore, 'preparation mutated the canonical ledger');
  assert.equal(git(lane.repoPath, ['status', '--porcelain', '--ignored=matching']), '');
  // This append is the controller-signing step, deliberately outside
  // preparation. The executor sees the exact reviewed packet on execution.
  appendAudit(fixture.audit, 'controller.agent.launch.policy', lane.launchId, prepared.policy);
  const run = runLane(lane);
  assert.equal(run.result.status, 0, laneDiagnostics(run));
  assert.equal(run.manifest.objectiveRef, 'Q67');
}

function runPolicyRecorderCli(args, input) {
  return runProcess(process.execPath, [POLICY_RECORDER_SOURCE, ...args], {
    cwd: OUTER_WORKTREE,
    env: safeEnvironment(),
    input,
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
}

function testMismatchedObjectiveRejected(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 30, {
    auditObjectiveRef: 'Q67',
  });
  const run = runLane(lane);
  expectRejected(run, 'CANONICAL_LAUNCH_FACTS_MISMATCH', 'preflight');
  assert.equal(fs.existsSync(lane.worktreePath), false);
}

function testFreeTextObjectiveRejected(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 31, {
    objectiveRef: 'implement the remaining BUILD-QUEUE work now',
  });
  const run = runLane(lane);
  expectRejected(run, 'OBJECTIVE_REF_INVALID', 'preflight');
  assert.equal(fs.existsSync(lane.worktreePath), false);
}

function testTerraXhighProfile(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 142, { agentProfile: 'terra', skipPolicy: true });
  const prepared = runPreparation(lane);
  assert.equal(prepared.policy.agent.model, 'gpt-5.6-terra');
  assert.equal(prepared.policy.agent.reasoningEffort, 'xhigh');
  assert.ok(prepared.policy.agent.arguments.includes('gpt-5.6-terra'));
  assert.ok(prepared.policy.agent.arguments.includes('model_reasoning_effort=xhigh'));
  assert.equal(fs.existsSync(lane.worktreePath), false, 'preparation must remain read-only');
  appendAudit(fixture.audit, 'controller.agent.launch.policy', lane.launchId, prepared.policy);
  const run = runLane(lane);
  assert.equal(run.result.status, 0, `Terra lane failed\n${run.result.stdout}\n${run.result.stderr}`);
  assert.equal(run.manifest.terminalState, 'accepted');
  assert.equal(run.manifest.model, 'gpt-5.6-terra');
  assert.equal(run.manifest.reasoningEffort, 'xhigh');
}

function testTerraRejectsLunaLaunchRecord(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 143, { agentProfile: 'terra', auditAgentProfile: 'luna' });
  const run = runLane(lane);
  expectRejected(run, 'CANONICAL_LAUNCH_FACTS_MISMATCH', 'preflight');
  assert.equal(fs.existsSync(lane.worktreePath), false);
}

function testSolUltraProfile(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 144, { agentProfile: 'sol', objectiveRef: 'R400', skipPolicy: true });
  const prepared = runPreparation(lane);
  assert.equal(prepared.policy.agent.model, 'gpt-5.6-sol');
  assert.equal(prepared.policy.agent.reasoningEffort, 'ultra');
  assert.ok(prepared.policy.agent.arguments.includes('gpt-5.6-sol'));
  assert.ok(prepared.policy.agent.arguments.includes('model_reasoning_effort=ultra'));
  assert.equal(fs.existsSync(lane.worktreePath), false, 'preparation must remain read-only');
  const selectedLaunch = selectedLaunchForPolicyRecorder(lane, prepared.policy);
  const successful = policyRecorderAudit(selectedLaunch);
  const receipt = policyRecorder.recordPreparedPolicy(lane.launchId, prepared.policy, {
    auditApi: successful.auditApi,
    eventId: 'sol-policy-record-test',
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.objectiveRef, 'R400');
  const missingScope = structuredClone(selectedLaunch);
  delete missingScope.event.details.record.scopePacket;
  expectPolicyRecorderCode(() => policyRecorder.recordPreparedPolicy(lane.launchId, prepared.policy, {
    auditApi: policyRecorderAudit(missingScope).auditApi,
    eventId: 'sol-policy-missing-scope-test',
  }), 'POLICY_LAUNCH_INVALID');
  appendAudit(fixture.audit, 'controller.agent.launch.policy', lane.launchId, prepared.policy);
  const run = runLane(lane);
  assert.equal(run.result.status, 0, `Sol lane failed\n${run.result.stdout}\n${run.result.stderr}`);
  assert.equal(run.manifest.terminalState, 'accepted');
  assert.equal(run.manifest.objectiveRef, 'R400');
  assert.equal(run.manifest.model, 'gpt-5.6-sol');
  assert.equal(run.manifest.reasoningEffort, 'ultra');
}

function testNpmRegistryPermissionProfile(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 154, {
    agentProfile: 'sol',
    objectiveRef: 'R400',
    allowNpmRegistryNetwork: true,
    skipPolicy: true,
  });
  const prepared = runPreparation(lane);
  assert.equal(prepared.policy.agent.sandbox, 'permission-profile:lane-npm-registry');
  assert.equal(prepared.policy.agent.arguments.includes('--sandbox'), false);
  for (const argument of [
    'default_permissions="lane-npm-registry"',
    'permissions.lane-npm-registry.extends=":workspace"',
    'permissions.lane-npm-registry.network.enabled=true',
    'permissions.lane-npm-registry.network.domains={ "registry.npmjs.org" = "allow", "127.0.0.1" = "allow" }',
  ]) assert.ok(prepared.policy.agent.arguments.includes(argument), `missing profile argument ${argument}`);
  const selectedLaunch = selectedLaunchForPolicyRecorder(lane, prepared.policy);
  const successful = policyRecorderAudit(selectedLaunch);
  assert.equal(policyRecorder.recordPreparedPolicy(lane.launchId, prepared.policy, {
    auditApi: successful.auditApi,
    eventId: 'npm-profile-policy-record-test',
  }).ok, true);
  const incomplete = structuredClone(prepared.policy);
  incomplete.agent.arguments = incomplete.agent.arguments.filter(argument =>
    argument !== 'permissions.lane-npm-registry.network.domains={ "registry.npmjs.org" = "allow", "127.0.0.1" = "allow" }');
  expectPolicyRecorderCode(() => policyRecorder.recordPreparedPolicy(lane.launchId, incomplete, {
    auditApi: policyRecorderAudit(selectedLaunch).auditApi,
    eventId: 'npm-profile-policy-incomplete-test',
  }), 'PREPARED_POLICY_INVALID');
  appendAudit(fixture.audit, 'controller.agent.launch.policy', lane.launchId, prepared.policy);
  const run = runLane(lane);
  assert.equal(run.result.status, 0, `npm-profile lane failed\n${run.result.stdout}\n${run.result.stderr}`);
  assert.equal(run.manifest.terminalState, 'accepted');
  assert.equal(run.manifest.sandbox, 'permission-profile:lane-npm-registry');
}

function testPrefixedSliceAndOutOfRangeObjectivesRejected(root, fixture, fakeAgent) {
  for (const [offset, objectiveRef] of ['BUILD-QUEUE:Q66', 'Q66.lane-a', 'R240.slice-a', 'Q0', 'Q1000', 'R0', 'R10000'].entries()) {
    const lane = makeCase(root, fixture, fakeAgent, 135 + offset, { objectiveRef });
    const run = runLane(lane);
    expectRejected(run, 'OBJECTIVE_REF_INVALID', 'preflight');
    assert.equal(fs.existsSync(lane.worktreePath), false);
  }
}

function testUnknownLaunchObjectiveFieldRejected(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 32, { launchUnknownField: true });
  const run = runLane(lane);
  expectRejected(run, 'CANONICAL_LAUNCH_FACTS_MISMATCH', 'preflight');
  assert.equal(fs.existsSync(lane.worktreePath), false);
}

function selectedLaunchForPolicyRecorder(lane, policy) {
  const profile = agentProfile(lane);
  const record = {
    schemaVersion: 1,
    launchId: lane.launchId,
    requestingActor: 'codex',
    targetAgentId: profile.targetAgentId,
    tier: profile.tier,
    tierProposed: profile.tierProposed,
    model: profile.model,
    objectiveRef: lane.objectiveRef,
    cap: { kind: 'turns', value: 1, capMs: Math.max(60_000, lane.timeoutSeconds * 1000 + 10_000) },
    parentLaunchId: null,
    depth: 0,
    launchedAt: new Date().toISOString(),
    terminalState: 'pending',
  };
  const scopePacket = scopePacketForProfile(profile);
  if (scopePacket !== null) record.scopePacket = scopePacket;
  return {
    sequence: policy.auditAnchor.launchSequence,
    eventId: policy.auditAnchor.launchEventId,
    previousHash: policy.auditAnchor.launchPreviousHash,
    eventHash: policy.auditAnchor.launchEventHash,
    keyId: policy.auditAnchor.launchKeyId,
    event: {
      timestamp: new Date().toISOString(),
      action: 'controller.agent.launch',
      target: lane.launchId,
      details: {
        schemaVersion: 1,
        record
      }
    }
  };
}

function policyRecorderAudit(launchEntry, { existingPolicy = false, receipt = undefined } = {}) {
  const policyRows = existingPolicy ? [{ sequence: 99 }] : [];
  const calls = [];
  const successfulReceipt = receipt || {
    recorded: true,
    durable: true,
    anchored: true,
    sequence: 100,
    eventHash: 'c'.repeat(64),
  };
  return {
    calls,
    auditApi: {
      conditionalRecord(request) {
        calls.push(request);
        let decision;
        try {
          decision = request.decide({
            findEvents(selector) {
              if (selector.action === 'controller.agent.launch') return [launchEntry];
              if (selector.action === 'controller.agent.launch.policy') return policyRows;
              assert.fail(`unexpected policy-recorder audit selector ${JSON.stringify(selector)}`);
            }
          });
        } catch (error) {
          throw new Error(`policy-recorder decision escaped its transaction: ${error.code || error.message}`);
        }
        if (decision.kind === 'refused') return { recorded: false, refusal: decision.refusal };
        policyRows.push({ sequence: successfulReceipt.sequence });
        return successfulReceipt;
      }
    }
  };
}

function expectPolicyRecorderCode(callback, code) {
  assert.throws(callback, error => error && error.code === code, `expected policy recorder code ${code}`);
}

function testPolicyRecorderClosedShapeAndReceipts(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 136, { skipPolicy: true, objectiveRef: 'Q67' });
  const policy = policyForLane(lane, fixture);
  const selectedLaunch = selectedLaunchForPolicyRecorder(lane, policy);

  for (const [args, input, code] of [
    [[lane.launchId], '{', 'POLICY_INPUT_INVALID'],
    [[lane.launchId], Buffer.alloc(policyRecorder.MAX_PREPARED_POLICY_BYTES + 1, 0x20), 'POLICY_INPUT_TOO_LARGE'],
    [[lane.launchId, 'unexpected'], '{}', 'POLICY_CLI_USAGE'],
  ]) {
    const cli = runPolicyRecorderCli(args, input);
    assert.equal(cli.status, 1, `policy recorder CLI should refuse ${code}: ${cli.stderr}`);
    assert.deepEqual(JSON.parse(cli.stdout), { ok: false, code });
    assert.equal(cli.stderr, '');
  }

  const successful = policyRecorderAudit(selectedLaunch);
  const receipt = policyRecorder.recordPreparedPolicy(lane.launchId, policy, {
    auditApi: successful.auditApi,
    eventId: 'q66-policy-record-test',
  });
  assert.deepEqual(receipt, {
    ok: true,
    code: 'POLICY_RECORDED',
    launchId: lane.launchId,
    objectiveRef: 'Q67',
    sequence: 100,
    eventHash: 'c'.repeat(64),
    durable: true,
    anchored: true,
  });
  assert.equal(successful.calls.length, 1);
  assert.equal(successful.calls[0].action, 'controller.agent.launch.policy');
  assert.equal(successful.calls[0].target, lane.launchId);

  const malformed = { ...policy };
  delete malformed.agent;
  expectPolicyRecorderCode(() => policyRecorder.validatePreparedPolicy(lane.launchId, malformed), 'PREPARED_POLICY_INVALID');
  expectPolicyRecorderCode(() => policyRecorder.parsePreparedPolicyInput(Buffer.from('{', 'utf8')), 'POLICY_INPUT_INVALID');
  expectPolicyRecorderCode(() => policyRecorder.parsePreparedPolicyInput(Buffer.alloc(policyRecorder.MAX_PREPARED_POLICY_BYTES + 1, 0x20)), 'POLICY_INPUT_TOO_LARGE');
  assert.deepEqual(
    policyRecorder.parsePreparedPolicyInput(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"schemaVersion":1}', 'utf8')
    ])),
    { schemaVersion: 1 },
    'one Windows PowerShell UTF-8 preamble is transport encoding, not preparation JSON'
  );
  expectPolicyRecorderCode(() => policyRecorder.parsePreparedPolicyInput(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from('{"schemaVersion":1}', 'utf8')
  ])), 'POLICY_INPUT_INVALID');

  const mismatchedLaunch = structuredClone(policy);
  mismatchedLaunch.launchId = launchId(998);
  expectPolicyRecorderCode(() => policyRecorder.recordPreparedPolicy(lane.launchId, mismatchedLaunch, {
    auditApi: policyRecorderAudit(selectedLaunch).auditApi,
    eventId: 'q66-policy-launch-mismatch-test',
  }), 'POLICY_LAUNCH_MISMATCH');
  const mismatchedObjective = structuredClone(policy);
  mismatchedObjective.objectiveRef = 'Q68';
  expectPolicyRecorderCode(() => policyRecorder.recordPreparedPolicy(lane.launchId, mismatchedObjective, {
    auditApi: policyRecorderAudit(selectedLaunch).auditApi,
    eventId: 'q66-policy-mismatch-test',
  }), 'POLICY_OBJECTIVE_MISMATCH');
  expectPolicyRecorderCode(() => policyRecorder.recordPreparedPolicy(lane.launchId, policy, {
    auditApi: policyRecorderAudit(selectedLaunch, { existingPolicy: true }).auditApi,
    eventId: 'q66-policy-duplicate-test',
  }), 'POLICY_ALREADY_EXISTS');
  expectPolicyRecorderCode(() => policyRecorder.recordPreparedPolicy(lane.launchId, policy, {
    auditApi: policyRecorderAudit(selectedLaunch, {
      receipt: { recorded: true, durable: false, anchored: true, sequence: 101, eventHash: 'd'.repeat(64) },
    }).auditApi,
    eventId: 'q66-policy-nondurable-test',
  }), 'POLICY_RECORD_RECEIPT_INVALID');
}

function testChangedPreparedPolicyRejected(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 33, { skipPolicy: true });
  const prepared = runPreparation(lane);
  appendAudit(fixture.audit, 'controller.agent.launch.policy', lane.launchId, prepared.policy);
  write(lane.promptFile, 'Controller input changed after policy preparation.\n');
  const run = runLane(lane);
  expectRejected(run, 'CANONICAL_POLICY_MISMATCH', 'preflight');
  assert.equal(fs.existsSync(lane.worktreePath), false);
}

function testBoundedLargeLedgerAuthorization(root, fixture, fakeAgent) {
  appendBulkAudit(fixture.audit, 19_600);
  const lane = makeCase(root, fixture, fakeAgent, 34, { objectiveRef: 'Q68' });
  const run = runLane(lane);
  assert.equal(run.result.status, 0, laneDiagnostics(run));
  // This is the per-lane canonical verifier only: fake agent/provider/model
  // time is excluded, as is ordinary Git/worktree setup.
  assert.equal(run.manifest.evidence.canonicalVerifierDurationMs < 5_000, true,
    `bounded 19.6k-event canonical verification exceeded 5000ms: ${run.manifest.evidence.canonicalVerifierDurationMs}ms`);
}

function testCounterfeitSourceAuditRejected(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 20, { skipPolicy: true });
  const counterfeit = makeAuditFixture(lane.repoPath);
  appendCanonicalLaunch({ audit: counterfeit }, lane, {});
  write(path.join(root, 'inputs', 'counterfeit-key.json'), '{"kty":"OKP","crv":"Ed25519","x":"counterfeit"}\n');
  lane.legacyPublicKeyPath = path.join(root, 'inputs', 'counterfeit-key.json');
  const run = runLane(lane);
  expectRejected(run, 'SOURCE_CHECKOUT_NOT_DEDICATED_CLEAN', 'preflight');
  assert.equal(fs.existsSync(lane.worktreePath), false);
  assert.equal(run.manifest.evidence.canonicalVerified, false);
}

function testConflictingCanonicalPolicyRejected(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 21);
  appendAudit(fixture.audit, 'controller.agent.launch.policy', lane.launchId, policyForLane(lane, fixture));
  const run = runLane(lane);
  expectRejected(run, 'CANONICAL_POLICY_CONFLICT', 'preflight');
  assert.equal(fs.existsSync(lane.worktreePath), false);
}

function testUnknownPolicyFieldRejected(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 22, { skipPolicy: true });
  const policy = policyForLane(lane, fixture);
  policy.unrecognizedCapability = true;
  appendAudit(fixture.audit, 'controller.agent.launch.policy', lane.launchId, policy);
  const run = runLane(lane);
  expectRejected(run, 'CANONICAL_POLICY_MISMATCH', 'preflight');
  assert.equal(fs.existsSync(lane.worktreePath), false);
}

function testPathTraversal(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 3, { allowlist: ['../escape.txt'] });
  const run = runLane(lane);
  expectRejected(run, 'ALLOWLIST_PATH_TRAVERSAL', 'preflight');
  assert.equal(fs.existsSync(lane.worktreePath), false);
}

function testAllowlistSpacesAndParentheses(root, fixture, fakeAgent) {
  const allowed = '03 - Compactness (tower defence)/OVERHAUL-PLAN.md';
  const lane = makeCase(root, fixture, fakeAgent, 145, { allowlist: [allowed], skipPolicy: true });
  const prepared = runPreparation(lane);
  assert.deepEqual(prepared.policy.allowlist, [allowed]);
  assert.equal(fs.existsSync(lane.worktreePath), false, 'preparation must remain read-only');
}

function testUnsafeWindowsAllowlistSegments(root, fixture, fakeAgent) {
  const values = ['folder./plan.md', 'folder /plan.md', 'CON/plan.md', 'bad:name/plan.md'];
  for (const [offset, allowPath] of values.entries()) {
    const lane = makeCase(root, fixture, fakeAgent, 146 + offset, { allowlist: [allowPath] });
    const run = runLane(lane);
    expectRejected(run, 'ALLOWLIST_PATH_INVALID', 'preflight');
    assert.equal(fs.existsSync(lane.worktreePath), false);
  }
}

function testReparseTargetRefusal(root, fixture, fakeAgent) {
  const target = path.join(root, 'real-worktree-parent');
  const junction = path.join(root, 'junction-worktree-parent');
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, junction, 'junction');
  const lane = makeCase(root, fixture, fakeAgent, 23, { worktreePath: path.join(junction, 'lane-23') });
  const run = runLane(lane);
  // Both outcomes are fail-closed. The exact code depends on whether this
  // Windows execution context permits reading the junction's reparse tag.
  expectRejected(run, ['PATH_REPARSE_COMPONENT', 'PATH_REPARSE_TAG_UNAVAILABLE'], 'preflight');
  assert.equal(fs.existsSync(path.join(target, 'lane-23')), false);
}

function testExistingTargetRefusal(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 4);
  fs.mkdirSync(lane.worktreePath, { recursive: true });
  write(path.join(lane.worktreePath, 'sentinel.txt'), 'preserve me\n');
  const run = runLane(lane);
  expectRejected(run, 'WORKTREE_TARGET_EXISTS', 'preflight');
  assert.equal(fs.readFileSync(path.join(lane.worktreePath, 'sentinel.txt'), 'utf8'), 'preserve me\n');
}

function testAgentScopeRejection(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 5, { fakeAction: 'out-of-scope' });
  const run = runLane(lane);
  expectRejected(run, 'CHANGED_PATH_OUTSIDE_ALLOWLIST', 'scope');
  assertPreserved(run);
  assert.deepEqual(run.manifest.changedPaths, ['agent-outside.txt', 'allowed.txt']);
  assert.match(fs.readFileSync(run.manifest.artifacts.portablePatch, 'utf8'), /agent-outside\.txt/);
  assert.equal(run.manifest.verification.exitState, 'not-run');
}

function testAgentTimeoutFiniteCleanup(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 6, { fakeAction: 'timeout', timeoutSeconds: 1 });
  const run = runLane(lane);
  expectRejected(run, 'AGENT_TIMEOUT', 'model-quality');
  assertPreserved(run);
  assert.equal(run.manifest.agent.timedOut, true);
  assert.equal(run.manifest.agent.cleanupFailed, false);
  assert.equal(run.manifest.agent.drainCompleted, true);
  assert.equal(run.durationMs < 12_000, true, `timeout cleanup was not bounded: ${run.durationMs}ms`);
  assert.equal(run.manifest.eligibleForDenominator, true);
}

function testAgentOutputOverflowBounded(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 7, { fakeAction: 'agent-overflow', timeoutSeconds: 5, outputBudgetBytes: 65_536 });
  const run = runLane(lane);
  expectRejected(run, 'OUTPUT_BUDGET_EXCEEDED', 'model-quality');
  assertPreserved(run);
  assert.equal(run.manifest.agent.outputOverflowed, true);
  assert.equal(fs.statSync(run.manifest.artifacts.agentStdout).size <= lane.outputBudgetBytes, true);
  assert.equal(run.durationMs < 12_000, true, `overflow termination was not bounded: ${run.durationMs}ms`);
}

function testResponseOverflowBounded(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 8, { fakeAction: 'response-overflow', timeoutSeconds: 5, outputBudgetBytes: 65_536 });
  const run = runLane(lane);
  expectRejected(run, 'LAST_RESPONSE_TOO_LARGE', 'model-quality');
  assertPreserved(run);
  assert.equal(fs.statSync(run.manifest.artifacts.lastResponse).size <= lane.outputBudgetBytes, true);
  assert.equal(run.manifest.agent.lastResponseOverflowed, true);
  assert.equal(run.durationMs < 12_000, true, `last-response overflow cleanup was not bounded: ${run.durationMs}ms`);
}

function testNoDiffRejected(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 24, { fakeAction: 'no-diff' });
  const run = runLane(lane);
  expectRejected(run, 'NO_SOURCE_DIFF', 'model-quality');
  assertPreserved(run);
  assert.deepEqual(run.manifest.changedPaths, []);
}

function testPortableUntrackedPatch(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 25, { fakeAction: 'untracked', allowlist: ['untracked.txt'] });
  const run = runLane(lane);
  assert.equal(run.result.status, 0, laneDiagnostics(run));
  assert.deepEqual(run.manifest.changedPaths, ['untracked.txt']);
  assert.match(fs.readFileSync(run.manifest.artifacts.portablePatch, 'utf8'), /new file mode 100644/);
  assert.match(fs.readFileSync(run.manifest.artifacts.portablePatch, 'utf8'), /untracked change/);
}

function testNonzeroAgent(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 9, { fakeAction: 'nonzero' });
  const run = runLane(lane);
  expectRejected(run, 'AGENT_EXIT_NONZERO', 'model-quality');
  assertPreserved(run);
  assert.equal(run.manifest.agent.exitCode, 7);
  assert.deepEqual(run.manifest.changedPaths, ['allowed.txt']);
}

function testVerificationFailure(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 10, { verifyMode: 'fail' });
  const run = runLane(lane);
  expectRejected(run, 'VERIFICATION_FAILED', 'test');
  assertPreserved(run);
  assert.equal(run.manifest.verification.exitCode, 9);
  assert.equal(run.manifest.verification.passed, false);
  assert.match(fs.readFileSync(run.manifest.artifacts.verificationStderr, 'utf8'), /verification fixture failure/);
  assert.deepEqual(run.manifest.changedPaths, ['allowed.txt']);
}

function testVerificationOverflowBounded(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 11, { verifyMode: 'overflow', timeoutSeconds: 5, outputBudgetBytes: 65_536 });
  const run = runLane(lane);
  expectRejected(run, 'VERIFICATION_OUTPUT_BUDGET_EXCEEDED', 'test');
  assertPreserved(run);
  assert.equal(run.manifest.verification.outputOverflowed, true);
  assert.equal(run.manifest.verification.cleanupFailed, false);
  assert.equal(run.manifest.verification.drainCompleted, true);
  assert.equal(fs.statSync(run.manifest.artifacts.verificationStdout).size <= lane.outputBudgetBytes, true);
  assert.equal(run.durationMs < 20_000, true, `verification overflow termination was not bounded: ${run.durationMs}ms`);
}

function testVerificationTimeoutFiniteCleanup(root, fixture, fakeAgent) {
  // This signed budget covers the prerequisite agent too. A cheap, deliberate
  // startup delay makes the old one-second fixture fail in that earlier phase
  // deterministically; the ordinary five-second budget must reach the actual
  // verifier. Keep the independent total cleanup deadline below unchanged.
  const delayedAgent = `setTimeout(() => {\n${fakeAgent}\n}, 1200);\n`;
  const lane = makeCase(root, fixture, delayedAgent, 26, { fakeAction: 'verifier-timeout', verifyMode: 'timeout', timeoutSeconds: 5 });
  const run = runLane(lane);
  expectRejected(run, 'VERIFICATION_TIMEOUT', 'test');
  assertPreserved(run);
  assert.equal(run.manifest.agent.started, true);
  assert.equal(run.manifest.agent.exitState, 'exited');
  assert.equal(run.manifest.agent.exitCode, 0);
  assert.equal(run.manifest.agent.timedOut, false);
  assert.equal(run.manifest.agent.jobEmpty, true);
  assert.equal(run.manifest.agent.cleanupFailed, false);
  assert.equal(run.manifest.agent.drainCompleted, true);
  const verifier = artifactJson(run.manifest.artifacts.verificationStdout);
  assert.equal(verifier.cwd, lane.worktreePath, 'the verifier body must actually execute');
  assert.equal(verifier.expectedWorktree, lane.worktreePath);
  assert.equal(run.manifest.verification.started, true);
  assert.equal(run.manifest.verification.exitState, 'timed-out');
  assert.equal(run.manifest.verification.timedOut, true);
  assert.equal(run.manifest.verification.jobEmpty, true);
  assert.equal(run.manifest.verification.passed, false);
  assert.equal(run.manifest.verification.exitCode, null);
  assert.equal(run.manifest.verification.cleanupFailed, false);
  assert.equal(run.manifest.verification.drainCompleted, true);
  assert.equal(run.durationMs < 20_000, true, `verification timeout cleanup was not bounded: ${run.durationMs}ms`);
}

function testVerifierOutOfScopeRescan(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 12, { verifyMode: 'out-of-scope' });
  const run = runLane(lane);
  expectRejected(run, 'VERIFIER_WORKTREE_SCOPE_VIOLATION', 'scope');
  assertPreserved(run);
  assert.deepEqual(run.manifest.changedPaths, ['allowed.txt', 'verifier-outside.txt']);
  assert.match(fs.readFileSync(run.manifest.artifacts.portablePatch, 'utf8'), /verifier-outside\.txt/);
  assert.equal(run.manifest.eligibleForDenominator, false);
}

function testVerifierCannotChangeControllerFile(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 13, { verifyMode: 'valid' });
  const original = fs.readFileSync(lane.verificationProgram, 'utf8');
  // The verifier source is process.execPath for this fixture, so exercise the
  // controller-owned file guard with a verifier program outside all roots that
  // is itself replaced by the fixture before execution.
  const verifier = path.join(root, 'controller-owned-verifier.js');
  write(verifier, "require('node:fs').appendFileSync(process.argv[2], 'changed\\n');\n");
  lane.verificationProgram = verifier;
  lane.verificationArgument = ['-e', verificationSource('valid', lane.worktreePath), 'deterministic'];
  // The canonical policy was intentionally created for process.execPath; this
  // mismatch must fail before a worktree is created rather than letting an
  // agent-authored verifier redefine the policy.
  const run = runLane(lane);
  expectRejected(run, 'CANONICAL_POLICY_MISMATCH', 'preflight');
  assert.equal(fs.readFileSync(lane.verificationProgram, 'utf8').includes('changed'), true);
  assert.equal(original.length > 0, true);
}

function testVerificationChangedArgumentNeedsPolicy(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 14, {
    verificationArgument: ['-e', verificationSource('valid', path.join(root, 'lanes', 'lane-14')), 'allowed.txt'],
  });
  const run = runLane(lane);
  expectRejected(run, 'VERIFICATION_CHANGED_PATH_UNAUTHORIZED', 'preflight');
  assert.equal(fs.existsSync(lane.worktreePath), false);
}

function testVerifierControllerFileWriteRejected(root, fixture, fakeAgent) {
  const promptFile = path.join(root, 'inputs', 'controller-bound-prompt.txt');
  write(promptFile, 'Implement only the exact assigned file change.\n');
  const lane = makeCase(root, fixture, fakeAgent, 28, {
    promptFile,
    verifyMode: 'controller-write',
    controllerFile: promptFile,
  });
  const run = runLane(lane);
  expectRejected(run, 'VERIFIER_CONTROLLER_FILE_CHANGED', 'scope');
  assertPreserved(run);
  assert.match(fs.readFileSync(promptFile, 'utf8'), /verifier changed controller input/);
  assert.equal(run.manifest.eligibleForDenominator, false);
}

function testVerificationChangedArgumentAllowedByPolicy(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 27, {
    verificationArgument: ['-e', verificationSource('valid', path.join(root, 'lanes', 'lane-27')), 'allowed.txt'],
    allowChangedPathArguments: true,
  });
  const run = runLane(lane);
  assert.equal(run.result.status, 0, laneDiagnostics(run));
  assert.equal(run.manifest.verification.allowChangedPathArguments, true);
}

function testSourceInterferenceIsHarness(root, fixture, fakeAgent) {
  const lane = makeCase(root, fixture, fakeAgent, 15, { fakeAction: 'source-interference' });
  const run = runLane(lane);
  expectRejected(run, 'SOURCE_CHECKOUT_INTERFERENCE', 'harness');
  assert.equal(run.manifest.eligibleForDenominator, false);
  assert.equal(run.manifest.failureMessage.includes('not Luna model quality'), true);
}

function testArtifactSeparation(root, fixture, fakeAgent) {
  const worktreePath = path.join(root, 'lanes', 'separation');
  const lane = makeCase(root, fixture, fakeAgent, 16, {
    worktreePath,
    artifactPath: path.join(worktreePath, 'artifacts'),
  });
  const run = runLane(lane);
  expectRejected(run, 'ARTIFACT_INSIDE_WORKTREE', 'preflight');
  assert.equal(fs.existsSync(worktreePath), false);
}

function removeCaseRoot(root) {
  try {
    // Windows can keep a just-terminated child/worktree directory briefly
    // busy after timeout cleanup. Node's bounded recursive retry handles that
    // OS release window without hiding a durable lock or cleanup failure.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    const cleanupError = new Error(`Q66_CASE_CLEANUP_FAILED: ${error.code || 'UNKNOWN'} at ${error.path || root}`);
    cleanupError.cause = error;
    throw cleanupError;
  }
}

function cleanupScenarioRoot(root, preserve) {
  if (preserve) {
    preservedCaseRoots.add(root);
    console.error(`Q66_CASE_RETAINED: child cleanup is unknown; evidence remains at ${root}`);
    return;
  }
  try { removeCaseRoot(root); preservedCaseRoots.delete(root); }
  catch (error) { preservedCaseRoots.add(root); throw error; }
}

function runScenario(name, scenario) {
  const caseRoot = fs.mkdtempSync(path.join(RUN_ROOT, 'case-'));
  let preserveEvidence = false;
  try {
    const fixture = makeFixture(caseRoot);
    const fakeAgent = environmentReportSource(path.join(fixture.repo, 'README.md'));
    scenario(caseRoot, fixture, fakeAgent);
  } catch (error) {
    preserveEvidence = error.preserveCaseEvidence === true;
    error.message = `${name}: ${error.message}`;
    throw error;
  } finally {
    cleanupScenarioRoot(caseRoot, preserveEvidence);
  }
}

function spawnChildScenario(scenarioName) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [__filename], {
      cwd: OUTER_WORKTREE,
      env: safeEnvironment({ Q66_TEST_SCENARIO: scenarioName }),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      error.message = `${scenarioName}: ${error.message}`;
      reject(error);
    });
    child.on('close', code => resolve({ code, stdout, stderr, durationMs: Date.now() - startedAt }));
  });
}

function assertChildScenarioPassed(result, scenarioName) {
  assert.match(result.stdout, /^PASS Q66 Luna worktree lane focused tests \(1\/\d+ scenarios; no provider\/network calls\)\r?\n?$/m,
    `child scenario emitted no unique PASS evidence: ${scenarioName}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

async function settleScenarioWorkers(workers) {
  // Do not report terminal failure while an already-started sibling still
  // owns a case. Each child has its own RUN_ROOT, but early Promise.all
  // rejection used to let this invocation's finally/report run before the
  // sibling worker chains were finished.
  const settled = await Promise.allSettled(workers);
  const failures = settled.filter(item => item.status === 'rejected').map(item => item.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures,
    `Q66 scenario workers failed after draining:\n${failures.map(error => error.stack || error.message || String(error)).join('\n')}`);
  return settled.map(item => item.value);
}

async function runChildScenariosBounded(scenarioNames, concurrency, startScenario = spawnChildScenario) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < scenarioNames.length) {
      const scenarioName = scenarioNames[nextIndex];
      nextIndex += 1;
      const result = await startScenario(scenarioName);
      assert.equal(result.code, 0,
        `child scenario failed: ${scenarioName}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assertChildScenarioPassed(result, scenarioName);
      if (Number.isFinite(result.durationMs)) console.log(`PASS Q66 scenario: ${scenarioName} (${result.durationMs}ms)`);
    }
  }
  const workerCount = Math.min(concurrency, scenarioNames.length);
  await settleScenarioWorkers(Array.from({ length: workerCount }, () => worker()));
}

async function testScenarioWorkersDrainBeforeFailure() {
  // Actual harmless Node children, not timer-only promises: the first refuses
  // while the second deliberately retains a live IPC channel. The test must
  // not claim terminal failure until the second has exited and closed it.
  const children = new Map();
  fs.mkdirSync(RUN_ROOT, { recursive: true });
  const evidenceRoot = fs.mkdtempSync(path.join(RUN_ROOT, 'drain-proof-'));
  const sentinel = path.join(evidenceRoot, 'evidence.txt');
  write(sentinel, 'preserve uncertain child evidence');
  let finished = false;
  let outcome;
  const pending = runChildScenariosBounded(['refuses', 'still-owned'], 2, name => {
    const code = name === 'refuses' ? 17 : 0;
    const child = spawn(process.execPath, ['-e', [
      'const guard=setTimeout(()=>process.exit(99),30000);',
      'process.once("message",()=>{clearTimeout(guard);',
      code === 0 ? 'console.log("PASS Q66 Luna worktree lane focused tests (1/39 scenarios; no provider/network calls)");' : '',
      `process.exit(${code});});`,
      'process.send("ready");'
    ].join('\n')], {
      cwd: OUTER_WORKTREE, env: safeEnvironment(), windowsHide: true, shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const ready = new Promise((resolve, reject) => {
      child.once('message', message => message === 'ready' ? resolve() : reject(new Error('unexpected control message')));
      child.once('error', reject);
      child.once('exit', () => reject(new Error('control child exited before ready')));
    });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', exitCode => resolve({ code: exitCode, stdout, stderr }));
    });
    children.set(name, { child, ready, closed });
    return closed;
  }).then(() => { finished = true; }, error => { finished = true; outcome = error; });
  try {
    await Promise.all([...children.values()].map(item => item.ready));
    children.get('refuses').child.send('finish');
    await children.get('refuses').closed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, 'scheduler reported terminal failure with a sibling child still owned');
    assert.doesNotThrow(() => process.kill(children.get('still-owned').child.pid, 0));
    let timeoutError;
    try {
      runPreparation({
        script: path.join(evidenceRoot, 'not-executed.ps1'), repoPath: evidenceRoot,
        allowlist: [], timeoutSeconds: 1, agentProfile: 'luna'
      }, () => ({ error: { code: 'ETIMEDOUT' }, status: null, stdout: '', stderr: '' }));
    } catch (error) { timeoutError = error; }
    assert.equal(timeoutError && timeoutError.code, 'Q66_PREPARATION_MEASUREMENT_TIMEOUT');
    assert.equal(timeoutError.preserveCaseEvidence, true);
    cleanupScenarioRoot(evidenceRoot, timeoutError.preserveCaseEvidence);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve uncertain child evidence');
    assert.equal(preservedCaseRoots.has(evidenceRoot), true,
      'top-level cleanup must know that the failed case is retained');
  } finally {
    for (const { child } of children.values()) {
      if (child.connected) child.send('finish', () => {});
    }
    await Promise.allSettled([...children.values()].map(item => item.closed));
    await pending;
    cleanupScenarioRoot(evidenceRoot, false);
  }
  assert.ok(outcome, 'the original refused scenario must still make the invocation fail');
  assert.match(outcome.message, /child scenario failed: refuses/);
  for (const [name, { child, closed }] of children) {
    const receipt = await closed;
    assert.equal(receipt.code, name === 'refuses' ? 17 : 0,
      'each original child must emit its expected terminal close event');
    assert.equal(child.exitCode, receipt.code);
    assert.equal(child.signalCode, null);
    assert.equal(child.connected, false);
  }
  assert.throws(() => assertChildScenarioPassed({ stdout: '', stderr: '' }, 'empty evidence'),
    /child scenario emitted no unique PASS evidence/);
}

// Regression check for a real defect: this file used to keep every case
// under one fixed, well-known TEST_TEMP_PARENT and delete that entire shared
// parent in its top-level `finally`. Several agent sessions on this machine
// can invoke this exact file at overlapping times; whichever one finished
// (or errored) first would delete the fixtures a sibling invocation was
// still mid-scenario on, surfacing as unrelated-looking failures (an audit
// sqlite3 fixture that "cannot be opened", a lane that fails preflight for
// no visible reason). Two literal concurrent invocations of this file is
// the actual failure condition, so that is what this proves stays fixed.
async function testConcurrentInvocationsDoNotCollide() {
  const scenario = 'mismatched queue objective is rejected';
  const [a, b] = await settleScenarioWorkers([spawnChildScenario(scenario), spawnChildScenario(scenario)]);
  assert.equal(a.code, 0, `concurrent invocation A failed\n${a.stdout}\n${a.stderr}`);
  assert.equal(b.code, 0, `concurrent invocation B failed\n${b.stdout}\n${b.stderr}`);
  assertChildScenarioPassed(a, `${scenario} (concurrent invocation A)`);
  assertChildScenarioPassed(b, `${scenario} (concurrent invocation B)`);
}

async function main() {
  assert.equal(process.platform, 'win32', 'Q66 executor tests require Windows PowerShell 5.1');
  assert.equal(fs.existsSync(POWER_SHELL), true, `missing pinned Windows PowerShell: ${POWER_SHELL}`);
  assert.equal(fs.existsSync(RUNNER_SOURCE), true);
  fs.mkdirSync(RUN_ROOT, { recursive: true });
  const scenarios = [
    ['native process handles isolate cleanup and measure descendants', testNativeProcessContainment],
    ['file hash snapshots lock inputs and stay fresh', testFileHashSnapshots],
    ['canonical isolation and minimal environment', testValidCanonicalIsolationEnvironment],
    ['canonical launch policy is required', testCanonicalAuditRequired],
    ['read-only preparation and non-Q66 queue phase', testControllerPreparationIsReadOnlyAndNonQ66SliceExecutes],
    ['Terra xhigh profile is a closed signed tuple', testTerraXhighProfile],
    ['Terra xhigh rejects a Luna launch record', testTerraRejectsLunaLaunchRecord],
    ['Sol ultra profile is a closed signed scoped tuple', testSolUltraProfile],
    ['npm registry permission profile is closed, signed, and opt-in', testNpmRegistryPermissionProfile],
    ['mismatched queue objective is rejected', testMismatchedObjectiveRejected],
    ['free-text objective is rejected', testFreeTextObjectiveRejected],
    ['prefixed, slice, and out-of-range objectives are rejected', testPrefixedSliceAndOutOfRangeObjectivesRejected],
    ['unknown launch objective field is rejected', testUnknownLaunchObjectiveFieldRejected],
    ['policy recorder has closed shape and durable receipt boundary', testPolicyRecorderClosedShapeAndReceipts],
    ['changed prepared policy is rejected', testChangedPreparedPolicyRejected],
    ['counterfeit source audit and key are rejected', testCounterfeitSourceAuditRejected],
    ['conflicting canonical policy is rejected', testConflictingCanonicalPolicyRejected],
    ['unknown canonical policy field is rejected', testUnknownPolicyFieldRejected],
    ['allowlist path traversal', testPathTraversal],
    ['allowlist accepts bounded spaces and parentheses', testAllowlistSpacesAndParentheses],
    ['unsafe Windows allowlist segments are rejected', testUnsafeWindowsAllowlistSegments],
    ['reparse worktree target is rejected', testReparseTargetRefusal],
    ['existing target refusal', testExistingTargetRefusal],
    ['agent out-of-allowlist write', testAgentScopeRejection],
    ['agent timeout finite cleanup', testAgentTimeoutFiniteCleanup],
    ['agent output overflow is bounded', testAgentOutputOverflowBounded],
    ['last response overflow is bounded', testResponseOverflowBounded],
    ['no source diff is rejected', testNoDiffRejected],
    ['portable untracked patch is retained', testPortableUntrackedPatch],
    ['nonzero agent exit', testNonzeroAgent],
    ['verification failure', testVerificationFailure],
    ['verification output overflow is bounded', testVerificationOverflowBounded],
    ['verification timeout finite cleanup', testVerificationTimeoutFiniteCleanup],
    ['verifier out-of-scope write is rescanned', testVerifierOutOfScopeRescan],
    ['verifier controller-file write is rejected', testVerifierControllerFileWriteRejected],
    ['verifier policy remains controller-owned', testVerifierCannotChangeControllerFile],
    ['changed verification arguments require policy', testVerificationChangedArgumentNeedsPolicy],
    ['changed verification arguments allowed by policy', testVerificationChangedArgumentAllowedByPolicy],
    ['source interference is harness failure', testSourceInterferenceIsHarness],
    ['artifact/worktree separation', testArtifactSeparation],
    ['bounded large-ledger authorization', testBoundedLargeLedgerAuthorization],
  ];
  const requestedScenario = process.env.Q66_TEST_SCENARIO;
  const selectedScenarios = requestedScenario
    ? scenarios.filter(([name]) => name === requestedScenario)
    : scenarios;
  assert.ok(selectedScenarios.length > 0, `Q66_TEST_SCENARIO did not select a known scenario: ${requestedScenario}`);
  try {
    if (requestedScenario) {
      const [[name, scenario]] = selectedScenarios;
      runScenario(name, scenario);
    } else {
      await testScenarioWorkersDrainBeforeFailure();
      const allNames = scenarios.map(([name]) => name);
      const clockSensitive = allNames.filter(name => CLOCK_SENSITIVE_SCENARIOS.has(name));
      const rest = allNames.filter(name => !CLOCK_SENSITIVE_SCENARIOS.has(name));
      await runChildScenariosBounded(rest, CHILD_SCENARIO_CONCURRENCY);
      // Alone, and after the others have exited, so the clock it measures is
      // the product's and not the test host's.
      await runChildScenariosBounded(clockSensitive, 1);
    }
    // Only on a full, unfiltered run: a scenario-filtered run IS the kind of
    // child this check itself spawns, so gating on that (rather than a
    // separate env flag) is what keeps this from recursing.
    if (!requestedScenario) await testConcurrentInvocationsDoNotCollide();
  } finally {
    // Never remove TEST_TEMP_PARENT here: it is shared with any concurrently
    // running instance of this same file. Removing only RUN_ROOT confines
    // cleanup to fixtures this process created.
    if (preservedCaseRoots.size === 0) removeCaseRoot(RUN_ROOT);
    else console.error(`Q66_RUN_RETAINED: ${preservedCaseRoots.size} case(s) need cleanup review at ${RUN_ROOT}`);
  }
  console.log(`PASS Q66 Luna worktree lane focused tests (${selectedScenarios.length}/${scenarios.length} scenarios; no provider/network calls)`);
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { testScenarioWorkersDrainBeforeFailure };
