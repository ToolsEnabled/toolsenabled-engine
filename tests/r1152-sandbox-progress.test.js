// EXECUTABLE CHANGE
// Report: testcanfail-tests-r1152-sandbox-progress-test-js
// FOUND (shape 1): the two probeCalls.every(...) assertions were vacuously true
// when no executable was probed. Mutation: replace the product's spawnSyncImpl
// version probe with a fabricated successful probe result, leaving probeCalls
// empty. The strengthened test went RED with:
//   ERR_ASSERTION: AssertionError [ERR_ASSERTION]: at least one accepted native candidate receives a version metadata probe
// Restored the product file byte-for-byte (matching SHA-256
// 36df429169673e90cdbb616e8b0f9a3fad309295f7fe5589859ef463f9609aef),
// then the platform-faithful run was GREEN with:
//   r1152 sandbox/progress: 83 assertions passed
// NOT-FOUND (shape 2): no exit-status-only or truthy-return assertion.
// NOT-FOUND (shape 3): the caught signature error is required by two following
// assertions, and optional chains do not swallow the expected failure.
// NOT-FOUND (shape 4): injected fakes record interactions or establish fixtures;
// no assertion substitutes a mock's result for the product behavior under test.
// NOT-FOUND (shape 5): no skip or precondition guard turns the file into a no-op.
// NOT-FOUND (shape 6): expected values are fixed fixtures, not computed by the
// same product code being checked.
// NAMED PRECONDITION: the host is Linux, while mission dispatch resolves the
// native pair only on win32. A plain run reaches a genuine 0 !== 1 assertion;
// the green/red mutation runs therefore override process.platform to win32 and
// set TEMP=/tmp, without changing product checks or process-spawn behavior.

'use strict';

require('./lib/agent-api-mode-fixture').selectAgentApiMode('Enabled');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const presence = require('../src/lib/agent-presence');
const lane = require('../src/lib/agent-lane');
const wake = require('../src/lib/agent-wake');
const { codexArgs, createMissionActions } = require('../src/lib/mission-bridge/actions');
const {
  defaultNpmRoots, resolveMissionCodexNativePair
} = require('../src/lib/mission-bridge/codex-native-pair');

let assertions = 0;
function check(value, message) { assertions += 1; assert.ok(value, message); }
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }
async function rejectsCode(work, code) {
  assertions += 1;
  await assert.rejects(work, error => error?.code === code, `expected ${code}`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function rewritePresenceAsLegacy(file, agentId) {
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete registry.agents[agentId].usefulProgressSeq;
  delete registry.agents[agentId].lastUsefulProgressAt;
  delete registry.agents[agentId].lastUsefulProgressKind;
  writeJson(file, registry);
  return registry;
}

function writePe(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
}

function writeCodexPair(npmRoot, version, { nativeVersion = `${version}-win32-x64`, layoutVersion = version } = {}) {
  const packageRoot = path.join(npmRoot, '@openai', 'codex');
  const nativeRoot = path.join(packageRoot, 'node_modules', '@openai', 'codex-win32-x64');
  const vendor = path.join(nativeRoot, 'vendor', 'x86_64-pc-windows-msvc');
  writeJson(path.join(packageRoot, 'package.json'), {
    name: '@openai/codex',
    version,
    optionalDependencies: {
      '@openai/codex-win32-x64': `npm:@openai/codex@${version}-win32-x64`
    }
  });
  writeJson(path.join(nativeRoot, 'package.json'), {
    name: '@openai/codex',
    version: nativeVersion,
    os: ['win32'],
    cpu: ['x64']
  });
  writeJson(path.join(vendor, 'codex-package.json'), {
    layoutVersion: 1,
    version: layoutVersion,
    target: 'x86_64-pc-windows-msvc',
    variant: 'codex',
    entrypoint: 'bin/codex.exe',
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path'
  });
  const command = path.join(vendor, 'bin', 'codex.exe');
  const commandRunner = path.join(vendor, 'codex-resources', 'codex-command-runner.exe');
  const sandboxSetup = path.join(vendor, 'codex-resources', 'codex-windows-sandbox-setup.exe');
  writePe(command);
  writePe(commandRunner);
  writePe(sandboxSetup);
  return { command, commandRunner, sandboxSetup, version };
}

function recordFixture(temp, overrides = {}) {
  return {
    agentId: 'progress-lane',
    runId: '11111111-1111-4111-8111-111111111111',
    kind: 'codex',
    role: 'builder',
    tier: 'gpt-5.6-luna',
    reportsTo: 'coordinator-sol',
    dispatcher: 'coordinator-sol',
    lane: 'mission-bridge-app-dispatch',
    territory: 'primary:r1152-progress-fixture',
    currentTask: 'task-progress',
    brief: path.join(temp, 'brief.md'),
    consoleLog: path.join(temp, 'lane.log'),
    worktree: temp,
    launchSpec: path.join(temp, 'launch.json'),
    pid: 4321,
    startedAt: 1_000,
    lastHeartbeat: 1_000,
    status: 'running',
    exitCode: null,
    lastVerdict: null,
    terminalAt: null,
    staleReason: null,
    usefulProgressSeq: 0,
    lastUsefulProgressAt: null,
    lastUsefulProgressKind: null,
    mailboxOffset: 0,
    respawnCount: 0,
    verdictConsumedAt: null,
    ...overrides
  };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'r1152-sandbox-progress-'));
  try {
    const olderRoot = path.join(temp, 'npm-older', 'node_modules');
    const newerRoot = path.join(temp, 'npm-newer', 'node_modules');
    const alphaRoot = path.join(temp, 'npm-alpha', 'node_modules');
    const older = writeCodexPair(olderRoot, '0.146.0');
    const newer = writeCodexPair(newerRoot, '0.147.0');
    writeCodexPair(alphaRoot, '0.148.0-alpha.1');
    const probeCalls = [];
    const signatureCalls = [];
    const versions = new Map([
      [fs.realpathSync(older.command), older.version],
      [fs.realpathSync(newer.command), newer.version]
    ]);
    const selected = resolveMissionCodexNativePair({
      platform: 'win32',
      arch: 'x64',
      npmRoots: [olderRoot, alphaRoot, newerRoot],
      environment: { PATH: 'fixture-path' },
      verifySignaturesImpl(files) {
        signatureCalls.push([...files]);
        return files.map(() => ({ status: 'Valid', signer: 'OpenAI OpCo, LLC' }));
      },
      spawnSyncImpl(command, args, options) {
        probeCalls.push({ command, args, options });
        const version = versions.get(command);
        return version
          ? { status: 0, signal: null, stdout: `codex-cli ${version}\n`, stderr: '' }
          : { status: 1, signal: null, stdout: '', stderr: 'unexpected fixture command' };
      }
    });
    equal(selected.version, '0.147.0', 'newest valid stable npm release wins over an older stable and a newer prerelease');
    equal(selected.command, fs.realpathSync(newer.command), 'the selected command is the native executable declared by the stable package');
    equal(selected.commandRunner, fs.realpathSync(newer.commandRunner), 'the selected command runner comes from the same native package layout');
    equal(selected.sandboxSetup, fs.realpathSync(newer.sandboxSetup), 'the matching sandbox setup helper is also verified');
    check(probeCalls.length > 0, 'at least one accepted native candidate receives a version metadata probe');
    check(probeCalls.every(call => call.args.length === 1 && call.args[0] === '--version'), 'every accepted native candidate receives only a version metadata probe');
    check(probeCalls.every(call => call.options.windowsHide === true && call.options.shell === false), 'metadata probes stay hidden and shell-free');
    equal(signatureCalls.length, 2, 'each stable metadata candidate receives one Authenticode verification pass');
    check(signatureCalls.every(files => files.length === 3 && files.every(file => file.endsWith('.exe'))),
      'Authenticode verification covers the native executable, command runner, and sandbox helper as one pair');

    const mismatchedRoot = path.join(temp, 'npm-mismatch', 'node_modules');
    writeCodexPair(mismatchedRoot, '0.149.0', { nativeVersion: '0.148.0-win32-x64' });
    await rejectsCode(
      async () => resolveMissionCodexNativePair({
        platform: 'win32', arch: 'x64', npmRoots: [mismatchedRoot],
        spawnSyncImpl: () => ({ status: 0, signal: null, stdout: 'codex-cli 0.149.0\n' })
      }),
      'CODEX_NATIVE_PAIR_UNAVAILABLE'
    );
    await rejectsCode(
      async () => resolveMissionCodexNativePair({ platform: 'win32', arch: 'x64', npmRoots: [] }),
      'CODEX_NATIVE_PAIR_UNAVAILABLE'
    );
    let signatureFailure = null;
    try {
      resolveMissionCodexNativePair({
        platform: 'win32', arch: 'x64', npmRoots: [olderRoot],
        verifySignaturesImpl() {
          throw Object.assign(new Error('invalid signer fixture'), { code: 'CODEX_NATIVE_PAIR_SIGNATURE_INVALID' });
        },
        spawnSyncImpl: () => ({ status: 0, signal: null, stdout: 'codex-cli 0.146.0\n' })
      });
    } catch (error) { signatureFailure = error; }
    equal(signatureFailure?.code, 'CODEX_NATIVE_PAIR_LOOKUP_INDETERMINATE',
      'an Authenticode verifier failure stays indeterminate and fails the resolver closed');
    equal(signatureFailure?.details?.causeCode, 'CODEX_NATIVE_PAIR_SIGNATURE_INVALID',
      'fail-closed diagnostics preserve the signature verifier failure code');
    const closeFailureFs = Object.create(fs);
    closeFailureFs.closeSync = () => { throw new Error('fixture could not close PE handle'); };
    let closeFailure = null;
    try {
      resolveMissionCodexNativePair({
        platform: 'win32', arch: 'x64', npmRoots: [olderRoot], fsImpl: closeFailureFs,
        verifySignaturesImpl: () => [],
        spawnSyncImpl: () => ({ status: 0, signal: null, stdout: 'codex-cli 0.146.0\n' })
      });
    } catch (error) { closeFailure = error; }
    equal(closeFailure?.code, 'CODEX_NATIVE_PAIR_LOOKUP_INDETERMINATE',
      'an unconfirmed PE handle close stays indeterminate and fails the resolver closed');
    equal(closeFailure?.details?.causeCode, 'UNKNOWN',
      'an untyped PE handle close failure remains explicit instead of becoming an absence claim');
    const discoveredRoots = defaultNpmRoots({
      environment: { APPDATA: path.join(temp, 'user-appdata'), PATH: '' },
      globalPaths: [],
      execPath: path.join(temp, 'node', 'node.exe')
    });
    check(discoveredRoots.includes(path.join(temp, 'user-appdata', 'npm', 'node_modules')), 'npm discovery derives the per-user global root from APPDATA');
    equal(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mission-bridge', 'codex-native-pair.js'), 'utf8').includes('owner'), false,
      'the resolver does not hardcode the current user path');

    const expectedArgs = [
      'exec', '--dangerously-bypass-approvals-and-sandbox',
      '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
      '-c', 'mcp_servers.playwright.command="disabled"', '-c', 'mcp_servers.playwright.enabled=false',
      '-c', 'mcp_servers.toolsenabled-readonly.command="disabled"', '-c', 'mcp_servers.toolsenabled-readonly.enabled=false',
      '-c', 'mcp_servers.toolsenabled.command="disabled"', '-c', 'mcp_servers.toolsenabled.enabled=false',
      '-c', 'notify=[]', '--cd', temp,
      '--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort=medium', '-'
    ];
    // The session is stated explicitly. This assertion is about what the
    // UNRESTRICTED level emits, and it used to establish that by passing no
    // session at all and relying on codexArgs() defaulting to local/full --
    // which quietly made "absence" the thing under test and pinned a default
    // whose effect was an unsandboxed spawn. Naming the level tests the same
    // posture and stops this file from holding that default open.
    deepEqual(codexArgs({
      root: temp,
      tier: { model: 'gpt-5.6-luna', effort: 'medium' },
      permissionSession: { origin: 'local', tier: 'full' }
    }), expectedArgs,
      'app Codex argv preserves the exact R1161 unrestricted, ephemeral, config, model, and stdin posture while enabling JSONL');
    equal(expectedArgs.filter(value => /dangerously-bypass-approvals-and-sandbox/.test(value)).length, 1,
      'app Codex dispatch has exactly one explicit unrestricted-control argument');
    equal(expectedArgs.includes('--sandbox'), false,
      'app Codex dispatch does not silently reintroduce a sandbox mode');

    const terminalStates = [];
    const org = {
      schemaVersion: 1,
      revision: 1,
      agents: [
        { id: 'coordinator-sol', displayName: 'Coordinator', role: 'controller', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] },
        { id: 'luna', displayName: 'Luna', role: 'builder', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] }
      ],
      relationships: [{ from: 'coordinator-sol', to: 'luna', type: 'manages' }]
    };
    const unavailableActions = createMissionActions({
      roots: { primary: temp },
      agentOrg: org,
      actor: 'coordinator-sol',
      policy: { assertActive() {} },
      createLaunch: () => ({
        launchId: 'launch_1234567890abcdef', dispatchBrief: 'fixture', recordHash: 'record-hash',
        auditSequence: 1, auditEventHash: 'audit-hash'
      }),
      recordTerminal: input => { terminalStates.push(input.terminalState); return input; },
      resolveCommand: () => { throw Object.assign(new Error('no stable pair'), { code: 'CODEX_NATIVE_PAIR_UNAVAILABLE' }); }
    });
    await rejectsCode(() => unavailableActions.dispatch({
      rootId: 'primary', tier: 'luna', objectiveRef: 'stable-pair-refusal', brief: 'fixture',
      cap: { kind: 'turns', value: 1, capMs: 60_000 }
    }), 'BRIDGE_CODEX_NATIVE_PAIR_UNAVAILABLE');
    deepEqual(terminalStates, ['failed'], 'native-pair refusal terminalizes the canonical launch exactly once');

    let resolverCalls = 0;
    let wiredLaneOptions = null;
    const wiredActions = createMissionActions({
      roots: { primary: temp },
      agentOrg: org,
      actor: 'coordinator-sol',
      env: { APPDATA: path.join(temp, 'appdata'), TEST_API_KEY: 'must-be-scrubbed' },
      policy: { assertActive() {} },
      createLaunch: () => ({
        launchId: 'launch_abcdef1234567890', dispatchBrief: 'fixture', recordHash: 'record-hash',
        auditSequence: 2, auditEventHash: 'audit-hash-2'
      }),
      recordTerminal: input => input,
      resolveCodexNativePair(input) {
        resolverCalls += 1;
        equal(input.environment.TEST_API_KEY, undefined, 'mission resolver receives the existing credential-scrubbed environment');
        return selected;
      },
      async runLane(options) {
        wiredLaneOptions = options;
        return {
          runId: '33333333-3333-4333-8333-333333333333',
          taskId: 'task-wired',
          terminal: { status: 'finished', exitCode: 0, lastVerdict: 'VERDICT: wired fixture' }
        };
      }
    });
    const wired = await wiredActions.dispatch({
      rootId: 'primary', tier: 'luna', objectiveRef: 'stable-pair-wiring', brief: 'fixture',
      cap: { kind: 'turns', value: 1, capMs: 60_000 }
    });
    equal(wired.ok, true, 'mission dispatch accepts the verified stable native pair');
    equal(resolverCalls, 1, 'mission dispatch invokes its Codex-specific native-pair resolver exactly once');
    equal(wiredLaneOptions.command, selected.command, 'the canonical app lane receives the verified stable native executable');

    const progressRoot = path.join(temp, 'progress');
    fs.mkdirSync(progressRoot);
    const stateFile = path.join(progressRoot, 'presence.json');
    const consoleLog = path.join(progressRoot, 'lane.log');
    const checkpoint = path.join(progressRoot, 'checkpoint.md');
    fs.writeFileSync(consoleLog, '', 'utf8');
    fs.writeFileSync(checkpoint, 'initial checkpoint seed\n', 'utf8');
    const record = presence.register(recordFixture(progressRoot, { consoleLog }), { file: stateFile });
    equal(record.usefulProgressSeq, 0, 'new lane progress starts truthfully at sequence zero');
    equal(record.lastUsefulProgressAt, null, 'new lane progress time starts null');
    equal(record.lastUsefulProgressKind, null, 'new lane progress kind starts null');
    const progressFile = presence.usefulProgressFile(record.agentId, { file: stateFile });
    const initialSidecarBytes = fs.readFileSync(progressFile);
    const initialSidecar = JSON.parse(initialSidecarBytes.toString('utf8'));
    deepEqual(Object.keys(initialSidecar).sort(), [
      'agentId', 'lastUsefulProgressAt', 'lastUsefulProgressKind', 'runId', 'schemaVersion', 'usefulProgressSeq'
    ], 'per-agent sidecar contains only the bounded mechanical progress contract');
    check(initialSidecarBytes.length <= presence.MAX_USEFUL_PROGRESS_BYTES, 'per-agent sidecar stays within its fixed byte bound');
    equal(initialSidecar.runId, record.runId, 'registration binds the zero sidecar to the exact run owner');
    const heartbeat = presence.heartbeat(record.agentId, record.runId, {
      pid: 4321, currentTask: record.currentTask, mailboxOffset: 0, at: 2_000
    }, { file: stateFile });
    equal(heartbeat.usefulProgressSeq, 0, 'heartbeat does not advance useful progress');

    let progressClock = 3_000;
    const observer = lane.createUsefulProgressObserver({
      agentId: record.agentId,
      runId: record.runId,
      kind: 'codex',
      command: path.join(progressRoot, 'codex.exe'),
      childArgs: ['exec'],
      consoleLog,
      checkpoint,
      worktree: progressRoot,
      stateFile
    }, { presenceApi: presence, fsImpl: fs, clock: () => progressClock });
    const failedEvents = [
      { type: 'item.started', item: { id: 'tool-1', type: 'command_execution' } },
      { type: 'item.completed', item: { id: 'tool-1', type: 'command_execution', status: 'failed', exit_code: 1 } }
    ].map(JSON.stringify).join('\n');
    fs.appendFileSync(consoleLog, `${failedEvents}\nERROR windows sandbox: timed out connecting runner pipe-in\n`, 'utf8');
    equal(observer.observe(), 0, 'tool start, failed completion, and timeout text produce no useful-progress event');
    equal(presence.readRegistry(stateFile).agents[record.agentId].usefulProgressSeq, 0, 'failed tool output leaves useful progress at zero');

    const successfulEvent = JSON.stringify({
      type: 'item.completed',
      item: { id: 'tool-2', type: 'command_execution', status: 'completed', exit_code: 0 }
    });
    fs.appendFileSync(consoleLog, `${successfulEvent}\n`, 'utf8');
    equal(observer.observe(), 1, 'one completed successful tool execution emits one useful-progress event');
    let progressed = presence.readRegistry(stateFile).agents[record.agentId];
    equal(progressed.usefulProgressSeq, 1, 'one successful tool completion advances the sequence once');
    equal(progressed.lastUsefulProgressKind, 'tool-success', 'successful tool completion records its useful kind');
    equal(progressed.lastUsefulProgressAt, 3_000, 'successful tool completion records the observation time');
    equal(observer.observe(), 0, 're-observing an unchanged log does not advance progress');
    fs.appendFileSync(consoleLog, `${successfulEvent}\n`, 'utf8');
    equal(observer.observe(), 0, 'a repeated structured event with the same item id is deduplicated');
    equal(presence.readRegistry(stateFile).agents[record.agentId].usefulProgressSeq, 1, 'duplicate successful event observation does not double count');

    rewritePresenceAsLegacy(stateFile, record.agentId);
    const legacyRecovered = presence.readRegistry(stateFile).agents[record.agentId];
    equal(legacyRecovered.usefulProgressSeq, 1, 'matching sidecar recovers tool progress after a legacy writer strips the registry fields');
    equal(legacyRecovered.lastUsefulProgressAt, 3_000, 'legacy rewrite recovery retains the durable tool-success time');
    equal(legacyRecovered.lastUsefulProgressKind, 'tool-success', 'legacy rewrite recovery retains the durable tool-success kind');
    const legacyRoster = presence.rosterRows(presence.readRegistry(stateFile), { now: 5_000, isAlive: () => true });
    equal(legacyRoster[0].usefulProgressSeq, 1, 'roster consumes the recovered sidecar sequence after a legacy rewrite');
    equal(legacyRoster[0].lastUsefulProgressKind, 'tool-success', 'roster consumes the recovered sidecar kind after a legacy rewrite');
    const legacySweep = await wake.sweepAgents({
      autoWake: 'off', staleMs: 10_000, usefulProgressStaleMs: 2_500
    }, {
      stateFile,
      clock: () => 5_000,
      isAlive: () => true,
      recordFindings: async packet => ({ revision: packet.counts.scanned })
    });
    equal(legacySweep.aliveNoUsefulProgress.length, 0,
      'sweep uses recovered tool-success time instead of misclassifying the legacy-shaped live record as stalled');

    progressClock = 4_000;
    fs.writeFileSync(checkpoint, 'child-authored checkpoint content\n', 'utf8');
    equal(observer.observe(), 1, 'one checkpoint content-hash change emits one useful-progress event');
    progressed = presence.readRegistry(stateFile).agents[record.agentId];
    equal(progressed.usefulProgressSeq, 2, 'checkpoint hash change advances the sequence once');
    equal(progressed.lastUsefulProgressKind, 'checkpoint-change', 'checkpoint progress records its kind');
    equal(observer.observe(), 0, 're-observing the same checkpoint hash does not advance progress');

    const terminal = presence.finish(record.agentId, record.runId, {
      exitCode: 0, verdict: 'VERDICT: structured lane complete', at: 5_000
    }, { file: stateFile });
    equal(terminal.usefulProgressSeq, 3, 'terminalization advances useful progress exactly once');
    equal(terminal.lastUsefulProgressKind, 'terminal', 'terminalization records the terminal useful kind');
    rewritePresenceAsLegacy(stateFile, record.agentId);
    const legacyTerminalRecovered = presence.readRegistry(stateFile).agents[record.agentId];
    equal(legacyTerminalRecovered.usefulProgressSeq, 3, 'matching sidecar recovers terminal sequence after a second legacy rewrite');
    equal(legacyTerminalRecovered.lastUsefulProgressKind, 'terminal', 'matching sidecar wins over the one-step legacy terminal fallback');
    const repeatedTerminal = presence.finish(record.agentId, record.runId, {
      exitCode: 0, verdict: 'VERDICT: repeated observer', at: 6_000
    }, { file: stateFile });
    equal(repeatedTerminal.usefulProgressSeq, 3, 'repeated terminal observation does not double count');
    equal(repeatedTerminal.terminalAt, 5_000, 'repeated terminal observation preserves the first terminal fact');

    const oldRunSidecarText = fs.readFileSync(progressFile, 'utf8');
    const newRunId = '44444444-4444-4444-8444-444444444444';
    const newRun = presence.register(recordFixture(progressRoot, {
      runId: newRunId,
      startedAt: 7_000,
      lastHeartbeat: 7_000,
      status: 'running'
    }), { file: stateFile });
    equal(newRun.usefulProgressSeq, 0, 'registration resets a replacement run to sequence zero');
    const resetSidecarText = fs.readFileSync(progressFile, 'utf8');
    const resetSidecar = JSON.parse(resetSidecarText);
    equal(resetSidecar.runId, newRunId, 'replacement registration resets the sidecar run owner');
    equal(resetSidecar.usefulProgressSeq, 0, 'replacement registration durably resets the sidecar sequence');
    fs.writeFileSync(progressFile, oldRunSidecarText, 'utf8');
    const staleSidecarIgnored = presence.readRegistry(stateFile).agents[record.agentId];
    equal(staleSidecarIgnored.runId, newRunId, 'current presence retains the replacement run identity');
    equal(staleSidecarIgnored.usefulProgressSeq, 0, 'a valid old-run sidecar is ignored instead of inherited by the replacement run');
    fs.writeFileSync(progressFile, resetSidecarText, 'utf8');

    const legacyTerminalState = path.join(temp, 'legacy-terminal-presence.json');
    const legacyTerminalRecord = {
      ...recordFixture(temp, {
        agentId: 'legacy-terminal',
        runId: '55555555-5555-4555-8555-555555555555',
        status: 'finished',
        exitCode: 0,
        terminalAt: 8_000,
        lastHeartbeat: 8_000
      }),
      recordRevision: 1
    };
    delete legacyTerminalRecord.usefulProgressSeq;
    delete legacyTerminalRecord.lastUsefulProgressAt;
    delete legacyTerminalRecord.lastUsefulProgressKind;
    writeJson(legacyTerminalState, {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 8_000,
      agents: { [legacyTerminalRecord.agentId]: legacyTerminalRecord }
    });
    const projectedLegacyTerminal = presence.readRegistry(legacyTerminalState).agents['legacy-terminal'];
    equal(projectedLegacyTerminal.usefulProgressSeq, 1, 'legacy terminal projection remains the fallback when no matching sidecar exists');
    equal(projectedLegacyTerminal.lastUsefulProgressKind, 'terminal', 'legacy terminal fallback retains its terminal kind');

    const malformedState = path.join(temp, 'malformed-sidecar-presence.json');
    const malformedRecord = presence.register(recordFixture(temp, {
      agentId: 'malformed-sidecar',
      runId: '66666666-6666-4666-8666-666666666666'
    }), { file: malformedState });
    const malformedSidecar = presence.usefulProgressFile(malformedRecord.agentId, { file: malformedState });
    const validMalformedSidecar = fs.readFileSync(malformedSidecar, 'utf8');
    fs.writeFileSync(malformedSidecar, '{not-json\n', 'utf8');
    await rejectsCode(async () => presence.readRegistry(malformedState),
      'AGENT_USEFUL_PROGRESS_STATE_INVALID');
    await rejectsCode(async () => presence.advanceUsefulProgress(
      malformedRecord.agentId, malformedRecord.runId, { kind: 'tool-success', at: 9_000 }, { file: malformedState }
    ), 'AGENT_USEFUL_PROGRESS_STATE_INVALID');
    await rejectsCode(async () => presence.finish(
      malformedRecord.agentId, malformedRecord.runId, { exitCode: 1, verdict: 'VERDICT: partial-order fixture', at: 9_500 }, { file: malformedState }
    ), 'AGENT_USEFUL_PROGRESS_STATE_INVALID');
    const conservativeRaw = JSON.parse(fs.readFileSync(malformedState, 'utf8')).agents[malformedRecord.agentId];
    equal(conservativeRaw.status, 'running',
      'an indeterminate sidecar prevents a terminal-state claim before either record can be verified');
    equal(conservativeRaw.usefulProgressSeq, 0,
      'the refused terminal observation never exposes a phantom progress advance');
    fs.writeFileSync(malformedSidecar, validMalformedSidecar, 'utf8');
    const repairedTerminal = presence.finish(
      malformedRecord.agentId, malformedRecord.runId, { exitCode: 1, verdict: 'VERDICT: retry fixture', at: 10_000 }, { file: malformedState }
    );
    equal(repairedTerminal.usefulProgressSeq, 1, 'repeat terminal observation repairs the missing sidecar advance exactly once');
    equal(repairedTerminal.lastUsefulProgressAt, 10_000,
      'the repaired terminal observation records the first timestamp that became durable');

    const oversizedState = path.join(temp, 'oversized-sidecar-presence.json');
    const oversizedRecord = presence.register(recordFixture(temp, {
      agentId: 'oversized-sidecar',
      runId: '77777777-7777-4777-8777-777777777777'
    }), { file: oversizedState });
    const oversizedSidecar = presence.usefulProgressFile(oversizedRecord.agentId, { file: oversizedState });
    fs.writeFileSync(oversizedSidecar, Buffer.alloc(presence.MAX_USEFUL_PROGRESS_BYTES + 1, 0x20));
    await rejectsCode(async () => presence.readRegistry(oversizedState),
      'AGENT_USEFUL_PROGRESS_FILE_REFUSED');
    await rejectsCode(async () => presence.advanceUsefulProgress(
      oversizedRecord.agentId, oversizedRecord.runId, { kind: 'tool-success', at: 9_000 }, { file: oversizedState }
    ), 'AGENT_USEFUL_PROGRESS_FILE_REFUSED');

    const symlinkState = path.join(temp, 'symlink-sidecar-presence.json');
    const symlinkRecord = presence.register(recordFixture(temp, {
      agentId: 'symlink-sidecar',
      runId: '88888888-8888-4888-8888-888888888888'
    }), { file: symlinkState });
    const symlinkRawRegistry = fs.readFileSync(symlinkState, 'utf8');
    const simulatedSymlinkFs = {
      readFileSync(file, encoding) {
        if (path.resolve(file) === path.resolve(symlinkState) && encoding === 'utf8') return symlinkRawRegistry;
        throw Object.assign(new Error('unexpected fixture read'), { code: 'ENOENT' });
      },
      lstatSync() {
        return {
          isSymbolicLink: () => true,
          isFile: () => false,
          nlink: 1n,
          size: 1n
        };
      }
    };
    await rejectsCode(async () => presence.readRegistry(symlinkState, { fsImpl: simulatedSymlinkFs }),
      'AGENT_USEFUL_PROGRESS_FILE_REFUSED');

    const structuredVerdict = [
      JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'VERDICT: superseded' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'msg-2', type: 'agent_message', text: 'VERDICT: final structured Codex result' } })
    ].join('\n');
    equal(lane.extractLaneVerdict(structuredVerdict, 'codex'), 'VERDICT: final structured Codex result',
      'structured Codex JSONL preserves final assistant VERDICT extraction');

    const stalledState = path.join(temp, 'stalled-presence.json');
    const stalled = presence.register(recordFixture(temp, {
      agentId: 'stalled-lane',
      runId: '22222222-2222-4222-8222-222222222222',
      pid: 999,
      startedAt: 1_000,
      lastHeartbeat: 199_000
    }), { file: stalledState });
    const packets = [];
    const sweep = await wake.sweepAgents({
      autoWake: 'off', staleMs: 45_000, usefulProgressStaleMs: 120_000
    }, {
      stateFile: stalledState,
      clock: () => 200_000,
      isAlive: () => true,
      recordFindings: async packet => { packets.push(packet); return { revision: packets.length }; }
    });
    equal(sweep.aliveNoUsefulProgress.length, 1, 'fresh heartbeat and live PID can coexist with a stalled-usefulness finding');
    equal(sweep.aliveNoUsefulProgress[0].kind, 'alive-no-useful-progress', 'stalled usefulness has an exact machine-readable kind');
    equal(sweep.aliveNoUsefulProgress[0].heartbeatAgeMs, 1_000, 'finding retains fresh heartbeat age independently');
    equal(sweep.aliveNoUsefulProgress[0].usefulProgressStaleMs, 120_000, 'finding exposes the explicit usefulness threshold');
    equal(packets[0].counts.aliveNoUsefulProgress, 1, 'bounded sweep packet carries the stalled-usefulness count');
    presence.advanceUsefulProgress(stalled.agentId, stalled.runId, { kind: 'tool-success', at: 199_500 }, { file: stalledState });
    const cleared = await wake.sweepAgents({
      autoWake: 'off', staleMs: 45_000, usefulProgressStaleMs: 120_000
    }, {
      stateFile: stalledState,
      clock: () => 200_000,
      isAlive: () => true,
      recordFindings: async packet => ({ revision: packet.counts.scanned })
    });
    equal(cleared.aliveNoUsefulProgress.length, 0, 'a successful tool progress event clears the live-but-stalled finding');
    const parsedThreshold = wake.parseSweepArgs(['--useful-progress-stale-ms', '90000']);
    equal(parsedThreshold.input.usefulProgressStaleMs, 90_000, 'sweep CLI accepts an explicit bounded usefulness threshold');
    const roster = presence.rosterRows(presence.readRegistry(stalledState), { now: 200_000, isAlive: () => true });
    equal(roster[0].usefulProgressSeq, 1, 'roster projection exposes the monotonic useful-progress sequence');
    equal(roster[0].lastUsefulProgressKind, 'tool-success', 'roster projection exposes the last useful-progress kind');

    process.stdout.write(`r1152 sandbox/progress: ${assertions} assertions passed\n`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error?.code || 'ERROR'}: ${error && error.stack ? error.stack : error}\n`);
  if (error?.details) process.stderr.write(`DETAILS: ${JSON.stringify(error.details)}\n`);
  process.exitCode = 1;
});
