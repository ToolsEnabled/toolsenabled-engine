'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { normalizeTasks, writeStatus, reviewResult, reportedModelNames, buildLanePrompt, runLane, MODEL, MAX_COMMAND_LINE_CHARS } = require('../tools/gemini-fleet');

function task(lane, file) {
  return {
    lane,
    title: `Bounded ${lane}`,
    brief: 'Create only the declared review artifact.',
    expectFiles: [file],
    allowedPaths: [file],
    timeoutMs: 60_000
  };
}

(async () => {
  const lanes = normalizeTasks([
    task('lane-safe-a1', 'reports/gemini-fleet/a.md'),
    task('lane-safe-b1', 'reports/gemini-fleet/b.md')
  ]);
  assert.equal(lanes.length, 2);
  assert.equal(Object.isFrozen(lanes), true);
  assert.equal(Object.isFrozen(lanes[0]), true);
  const snapshotLane = normalizeTasks([{
    ...task('lane-snapshot-a1', 'reports/gemini-fleet/snapshot.md'),
    workspaceMode: 'tracked-snapshot',
    snapshotIncludePaths: ['src/lib/example-untracked-helper.js']
  }]);
  assert.equal(snapshotLane[0].workspaceMode, 'tracked-snapshot');
  assert.deepEqual(snapshotLane[0].snapshotIncludePaths, ['src/lib/example-untracked-helper.js']);

  for (const invalid of [
    [task('lane-safe-a1', 'reports/gemini-fleet/a.md'), task('lane-safe-a1', 'reports/gemini-fleet/b.md')],
    [task('lane-safe-a1', 'reports/gemini-fleet/a.md'), task('lane-safe-b1', 'reports/gemini-fleet/a.md')],
    [task('lane-safe-a1', 'BUILD-QUEUE.md')],
    [task('lane-safe-a1', '../escape.md')],
    [{ ...task('lane-safe-a1', 'reports/gemini-fleet/a.md'), workspaceMode: 'arbitrary-directory' }],
    [{ ...task('lane-safe-a1', 'reports/gemini-fleet/a.md'), workspaceMode: 'tracked-snapshot', snapshotIncludePaths: ['vault/secrets.json'] }],
    Array.from({ length: 16 }, (_, index) => task(`lane-many-${index}`, `reports/gemini-fleet/${index}.md`))
  ]) {
    assert.throws(() => normalizeTasks(invalid));
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'gemini-fleet.js'), 'utf8');
  assert.match(source, /worktree path is already occupied/);
  assert.match(source, /--allowed-mcp-server-names/);
  assert.match(source, /--extensions', 'none/);
  assert.match(source, /--approval-mode', 'yolo/);
  assert.match(source, /--admin-policy', FLEET_POLICY_PATH/);
  assert.match(source, /Fleet execution constraints/);
  assert.match(source, /never run npm, npx, pnpm, yarn, bun, pip/);
  const policy = fs.readFileSync(path.join(__dirname, '..', 'tools', 'gemini-fleet-policy.toml'), 'utf8');
  assert.match(policy, /toolName = "run_shell_command"/);
  assert.match(policy, /commandPrefix = \["npm", "npx", "pnpm", "yarn", "bun", "pip", "pip3", "uv"\]/);
  assert.match(policy, /decision = "deny"/);
  assert.match(source, /GOOGLE_GENAI_USE_VERTEXAI/);
  assert.match(source, /OUTPUT_SCOPE_OR_ARTIFACT_INVALID/);
  assert.match(source, /tracked-snapshot/);
  assert.match(source, /git', \['ls-files', '-z'\]/);
  assert.match(source, /SNAPSHOT_INCLUDE_FORBIDDEN_PREFIXES/);
  const promptInput = task('lane-packet-a1', 'reports/gemini-fleet/packet.md');
  let packetInput = null;
  const prompt = buildLanePrompt(promptInput, {
    projectRoot: 'C:\\fake\\lane-worktree',
    buildOnboardingPacket: input => {
      packetInput = input;
      return 'TEST FLEET ONBOARDING PACKET';
    }
  });
  assert.ok(prompt.indexOf('TEST FLEET ONBOARDING PACKET') < prompt.indexOf(`Task:\n${promptInput.brief}`));
  assert.equal(packetInput.projectRoot, 'C:\\fake\\lane-worktree');
  assert.equal(packetInput.scope, 'minimal');
  assert.equal(packetInput.profile, 'builder');
  assert.equal(packetInput.role, 'builder');
  assert.equal(packetInput.provider, 'gemini');
  assert.equal(packetInput.identityBinding, 'none');
  assert.equal(packetInput.model, MODEL);
  assert.deepEqual(packetInput.territory, ['reports/gemini-fleet/packet.md']);
  assert.equal(MAX_COMMAND_LINE_CHARS, 30_000);
  assert.doesNotMatch(source, /TOOLSENABLED_ONBOARDING_ALREADY_INJECTED/,
    'an unverified standalone launcher must not advertise hook suppression');
  assert.throws(() => buildLanePrompt(promptInput, { buildOnboardingPacket: () => '' }),
    /returned no context/, 'the fleet refuses an empty onboarding packet');

  const spawnRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-fleet-spawn-'));
  try {
    const [spawnTask] = normalizeTasks([{
      ...task('lane-spawn-a1', 'reports/gemini-fleet/spawn.md'),
      workspaceMode: 'tracked-snapshot'
    }]);
    let spawnCall = null;
    const result = await runLane(spawnTask, () => {}, {
      makeTrackedSnapshot: () => spawnRoot,
      buildOnboardingPacket: () => 'TEST FINAL FLEET PACKET',
      executableFor: () => ({ command: 'fake-gemini', prefixArgs: [] }),
      subscriptionEnvironment: () => ({}),
      spawnImpl: (command, args, options) => {
        spawnCall = { command, args, options };
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        queueMicrotask(() => {
          const output = path.join(spawnRoot, 'reports', 'gemini-fleet', 'spawn.md');
          fs.mkdirSync(path.dirname(output), { recursive: true });
          fs.writeFileSync(output, 'verified output\n', 'utf8');
          child.stdout.end(JSON.stringify({ response: 'done', stats: { models: { [MODEL]: { tokens: { total: 1 } } } } }));
          child.stderr.end();
          child.emit('close', 0);
        });
        return child;
      }
    });
    assert.equal(result.ok, true);
    const finalPrompt = spawnCall.args[spawnCall.args.indexOf('--prompt') + 1];
    assert.ok(finalPrompt.indexOf('TEST FINAL FLEET PACKET') < finalPrompt.indexOf(`Task:\n${spawnTask.brief}`));
    assert.equal(spawnCall.options.env.TOOLSENABLED_PROJECT_ROOT, spawnRoot);
    assert.equal(spawnCall.options.env.TOOLSENABLED_ONBOARDING_ALREADY_INJECTED, undefined);
    assert.equal(spawnCall.options.env.TOOLSENABLED_ONBOARDING_PACKET_VERSION, 'toolsenabled.agent-onboarding.v1');
    assert.match(spawnCall.options.env.TOOLSENABLED_ONBOARDING_PACKET_HASH, /^[a-f0-9]{64}$/);
    assert.equal(spawnCall.options.env.TOOLSENABLED_ONBOARDING_LAUNCHER_PROVENANCE, 'launcher-bound');
  } finally {
    fs.rmSync(spawnRoot, { recursive: true, force: true });
  }

  const unreadableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-fleet-unreadable-'));
  const [unreadableTask] = normalizeTasks([{
    ...task('lane-unreadable-a1', 'reports/gemini-fleet/unreadable.md'),
    workspaceMode: 'tracked-snapshot'
  }]);
  const unreadableResult = await runLane(unreadableTask, () => {}, {
    makeTrackedSnapshot: () => unreadableRoot,
    buildOnboardingPacket: () => 'TEST FINAL FLEET PACKET',
    executableFor: () => ({ command: 'fake-gemini', prefixArgs: [] }),
    subscriptionEnvironment: () => ({}),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => {
        fs.rmSync(unreadableRoot, { recursive: true, force: true });
        child.stdout.end(JSON.stringify({ response: 'done' }));
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    }
  });
  assert.equal(unreadableResult.ok, false);
  assert.equal(unreadableResult.code, 'OUTPUT_VERIFICATION_FAILED');
  assert.equal(unreadableResult.changedFiles, null);
  assert.equal(unreadableResult.changedFileCount, null);
  assert.equal(unreadableResult.unexpectedChanges, null);
  assert.match(unreadableResult.verificationError, /ENOENT/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-fleet-status-'));
  try {
    const statusPath = path.join(directory, 'lane-status.json');
    writeStatus(statusPath, { 'lane-safe-a1': { title: 'safe', state: 'running' } }, 'active');
    const state = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(state.schemaVersion, 1);
    assert.deepEqual(state.fleet, { state: 'active' });
    assert.deepEqual(state.lanes['lane-safe-a1'], { title: 'safe', state: 'running' });

    const receipt = reviewResult({
      lane: 'lane-safe-a1', title: 'safe', durationMs: 12,
      produced: [{ file: 'reports/gemini-fleet/a.md', exists: true, bytes: 3 }],
      changedFiles: ['reports/gemini-fleet/a.md'], changedFileCount: 1,
      unexpectedChanges: [], missingExpected: [], verified: true, ok: true,
      code: null, exitCode: 0, reportedTokens: 4, reportedModels: ['gemini-3.1-pro-preview'], toolCalls: 0,
      worktree: 'C:/private/worktree', response: 'untrusted output', stderrTail: 'private diagnostic'
    });
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.hasOwn(receipt, 'worktree'), false);
    assert.equal(Object.hasOwn(receipt, 'response'), false);
    assert.equal(Object.hasOwn(receipt, 'stderrTail'), false);
    assert.deepEqual(receipt.reportedModels, ['gemini-3.1-pro-preview']);
    assert.deepEqual(reportedModelNames({ 'gemini-3.5-flash': {}, 'unsafe model id': {} }), ['gemini-3.5-flash']);
    assert.equal(reportedModelNames(null), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  process.stdout.write('Gemini fleet coordinator tests passed\n');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
