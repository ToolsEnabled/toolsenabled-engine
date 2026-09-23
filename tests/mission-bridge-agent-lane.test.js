// EXECUTABLE CHANGE — test-can-fail report
//
// Declared-org fixture (this revision): the suite formerly asserted the
// SPELLING of one installation's private org — receipt.reportsTo had to be
// 'coordinator-opus5', the manager luna reported to in the author's own
// config/agent-org.json. The named-skip guard in tests/run-isolated.js is
// presence-based, so when the neutral example org was committed AT
// config/agent-org.json (755dc91) the guard disarmed and the suite ran — and
// failed — on every checkout: the runtime faithfully delivered the declared
// reporting line, which in the neutral org is 'controller'. The org is now an
// explicit fixture (FIXTURE_ORG below): dispatch receives it through
// createMissionActions' agentOrg option, and the spawned agent-wake CLI —
// a separate process that loads its org from disk — receives the same
// declaration via --org-file. The asserted property (the DECLARED reporting
// line reaches the runtime receipt and the durable spec unchanged) is now
// deterministic on every checkout, and the expected ids are literals from the
// fixture declaration, never recomputed with production helpers.
//
// Collected mutation evidence (each mutated file restored, SHA256-verified):
// - actions.js declaredLane reportsTo replaced with the enabled controller
//   (the dispatching actor): RED "declared reporting line reaches the runtime
//   unchanged" — actual 'fixture-controller', expected 'fixture-lane-manager'.
//   This is the discrimination the fixture's distinct manager seat exists for:
//   a runtime that clobbers reportsTo with the dispatcher cannot pass.
// - checkpointPath() emitting a `.mutated.md` suffix: RED "launch spec carries
//   the exact durable per-launch checkpoint path". (Predicted by the previous
//   revision of this header but uncollectable then — the org precondition
//   failed the run at the reportsTo assertion first.)
// - checkpointRelativePath() emitting `state/mutated-checkpoints/<launch>.md`:
//   RED "durable brief carries the bounded relative checkpoint instruction".
//
// Census: empty assertion loop/forEach NOT-FOUND; exit-status/truthy-only evidence
// NOT-FOUND (status assertions are paired with typed output/state evidence);
// swallowed assertion failure via try/catch or optional chaining NOT-FOUND;
// assertion against a mock of the subject NOT-FOUND; file-wide skip/platform
// precondition guard NOT-FOUND; same-code expected value FOUND three times
// previously and fixed — the fixture ids stay literals for the same reason.
// No unmet precondition remains: bare and isolated runs both pass on this
// repository's committed tree. Any temporary product/config files were
// restored or removed byte-for-byte; no source or tool file remains changed.

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const agentLane = require('../src/lib/agent-lane');
const presence = require('../src/lib/agent-presence');
const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { createStateStore } = require('../src/lib/state-store');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const ROOT = path.resolve(__dirname, '..');
const WAKE_CLI = path.join(ROOT, 'tools', 'agent-wake.js');
const LANE_FIXTURE = path.join(__dirname, 'fixtures', 'mission-bridge-checkpoint-lane.js');
const CHECKPOINT_DIRECTORY = path.join('state', 'mission-bridge-checkpoints');

// The declared org is a TEST FIXTURE, not the ambient config/agent-org.json,
// so the suite asserts the property (the declared reporting line survives to
// the runtime unchanged) rather than the spelling of whichever installation's
// org happens to be on disk. Two deliberate identity choices carry the
// assertion's discriminating power:
//   - luna's manager is a dedicated manager seat, NOT the controller. The
//     dispatching actor is always the org's single enabled controller, so if
//     the pipeline ever clobbered reportsTo with the dispatcher, expected
//     (fixture-lane-manager) !== actual (fixture-controller) and the test
//     goes red instead of silently blessing the clobber.
//   - the expected values below are literals from this declaration; they are
//     never recomputed with agentOrg.managerOf or any production helper (the
//     same-code-expected-value defect this file's census found three times).
const FIXTURE_CONTROLLER = 'fixture-controller';
const FIXTURE_MANAGER = 'fixture-lane-manager';
const FIXTURE_ORG = {
  revision: 1,
  agents: [
    { id: FIXTURE_CONTROLLER, displayName: 'Fixture controller', role: 'controller', provider: 'none', enabled: true },
    { id: FIXTURE_MANAGER, displayName: 'Fixture lane manager', role: 'manager', provider: 'none', enabled: true },
    { id: 'luna', displayName: 'Luna', role: 'builder', provider: 'codex', enabled: true }
  ],
  relationships: [
    { from: FIXTURE_CONTROLLER, to: FIXTURE_MANAGER, type: 'manages' },
    { from: FIXTURE_MANAGER, to: 'luna', type: 'manages' }
  ]
};

let assertions = 0;
function check(value, message) { assertions += 1; assert.ok(value, message); }
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function match(actual, expected, message) { assertions += 1; assert.match(actual, expected, message); }
async function rejectsCode(fn, code) {
  assertions += 1;
  let actual = null;
  try { await fn(); }
  catch (error) { actual = error; }
  assert.ok(
    actual && actual.code === code,
    `expected ${code}; received ${actual?.code || 'no rejection'}: ${actual?.message || 'no error message'}; details=${JSON.stringify(actual?.details || null)}`
  );
}

function auditFixture() {
  const events = [];
  const append = (action, target, details, extra = {}) => {
    const sequence = events.length + 1;
    const event = { action, target, details, sequence, ...extra };
    event.eventHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
    events.push(event);
    return event;
  };
  return {
    events,
    requireRecord(action, target, details) {
      const event = append(action, target, details);
      return { durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash };
    },
    findEvents({ action, target, limit = 100 } = {}) {
      return events.filter(event => (!action || event.action === action) && (!target || event.target === target)).slice(-limit);
    },
    conditionalRecord({ action, target, eventId, decide }) {
      const outcome = decide({ findEvents: this.findEvents.bind(this), nowMs: Date.now() });
      if (outcome.kind === 'refused') return { recorded: false, refusal: outcome.refusal };
      const event = append(action, target, outcome.details, { eventId });
      return { recorded: true, durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash, value: outcome.value };
    }
  };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(read, accept, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = read();
      if (accept(last)) return last;
    } catch (error) { last = error; }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}; last=${last?.message || JSON.stringify(last)}.`);
}

function processRun(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

function killIfAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already terminal */ }
}

function terminalEvents(auditApi, launchId) {
  return auditApi.events.filter(event => event.action === 'controller.agent.launch.terminal' && event.target === launchId);
}

async function main() {
  // run-isolated publishes an account-fenced root. Using ambient os.tmpdir()
  // here crossed into the launcher's profile on Windows and correctly tripped
  // the product account fence before the assertions ran.
  const scratchParent = process.env.TOOLSENABLED_TEST_ROOT || isolatedTemporaryRoot();
  const root = fs.mkdtempSync(path.join(scratchParent, 'mission-bridge-agent-lane-'));
  const stateFile = path.join(root, 'isolated-state', 'agent-presence.json');
  const mailboxDir = path.join(root, 'isolated-state', 'mailbox');
  const launchDir = path.join(root, 'isolated-state', 'launch');
  const taskFile = path.join(root, 'isolated-state', 'tasks.sqlite3');
  const auditDb = path.join(root, 'isolated-state', 'audit.sqlite3');
  const initialPromptCapture = path.join(root, 'initial-prompt.txt');
  const respawnPromptCapture = path.join(root, 'respawn-prompt.txt');
  const promptReadyFile = path.join(root, 'initial-prompt-ready');
  const allowCheckpointUpdateFile = path.join(root, 'allow-checkpoint-update');
  const checkpointReadyFile = path.join(root, 'checkpoint-ready');
  // The same declared-org fixture, as a file, for the spawned agent-wake CLI:
  // it is a separate process and loads its org from disk, so without
  // --org-file it would validate --from against the ambient
  // config/agent-org.json instead of the org this suite declared.
  const orgFixtureFile = path.join(root, 'agent-org.fixture.json');
  fs.writeFileSync(orgFixtureFile, `${JSON.stringify(FIXTURE_ORG, null, 2)}\n`, 'utf8');
  const children = new Set();
  const taskState = createStateStore({ file: taskFile, ownerId: 'mission-bridge-agent-lane-test' });
  const auditApi = auditFixture();
  const previousTestMode = process.env.TOOLSENABLED_LANE_RUN_TEST;
  process.env.TOOLSENABLED_LANE_RUN_TEST = '1';
  const isolatedEnvironment = {
    ...process.env,
    TOOLSENABLED_LANE_RUN_TEST: '1',
    TOOLSENABLED_STATE_PATH: taskFile,
    TOOLSENABLED_AUDIT_DB: auditDb,
    TOOLSENABLED_AUDIT_JSONL_PATH: path.join(root, 'isolated-state', 'audit.jsonl'),
    TOOLSENABLED_AUDIT_TEXT_PATH: path.join(root, 'isolated-state', 'audit.log'),
    TOOLSENABLED_AUDIT_EMERGENCY_PATH: path.join(root, 'isolated-state', 'audit-emergency.jsonl'),
    TOOLSENABLED_AGENT_PRESENCE_FILE: stateFile,
    TOOLSENABLED_AGENT_MAILBOX_DIR: mailboxDir,
    TOOLSENABLED_AGENT_LAUNCH_DIR: launchDir
  };

  const laneDependencies = {
    stateFile,
    mailboxDir,
    launchDir,
    taskDependencies: { state: taskState, auditRecord: () => {} }
  };
  let discoveryEnvironment = null;
  const actions = createMissionActions({
    roots: { isolated: root },
    actor: FIXTURE_CONTROLLER,
    audit: auditApi,
    policy: { assertActive() {} },
    agentOrg: FIXTURE_ORG,
    env: { PATH: process.env.PATH, HOME: root, TEST_API_KEY: 'must-not-reach-child' },
    laneDependencies,
    resolveCommand: (provider, environment) => {
      discoveryEnvironment = environment;
      return { command: process.execPath, prefixArgs: [] };
    },
    codexArgs: () => [
      LANE_FIXTURE,
      initialPromptCapture,
      respawnPromptCapture,
      promptReadyFile,
      allowCheckpointUpdateFile,
      checkpointReadyFile
    ],
    spawn(command, args, options) {
      const child = spawn(command, args, options);
      children.add(child);
      child.once('close', () => children.delete(child));
      child.once('error', () => children.delete(child));
      child.__bridgeSpawnOptions = options;
      return child;
    }
  });

  try {
    const first = await actions.dispatch({
      rootId: 'isolated',
      tier: 'luna',
      objectiveRef: 'phase3-lane-fixture',
      brief: 'update the durable checkpoint, then wait for the deliberate fixture kill',
      cap: { kind: 'turns', value: 3, capMs: 60_000 }
    });
    equal(first.receipt.action, 'dispatch', 'app dispatch keeps the typed bridge receipt');
    equal(first.receipt.agentId, 'luna', 'target identity comes from the normalized tier declaration');
    equal(first.receipt.role, 'builder', 'declared builder role reaches the runtime unchanged');
    equal(first.receipt.reportsTo, FIXTURE_MANAGER, 'declared reporting line reaches the runtime unchanged');

    const running = presence.readRegistry(stateFile).agents.luna;
    equal(running.status, 'running', 'dispatch returns only after the presence record is running');
    equal(running.runId, first.receipt.runId, 'running receipt and presence record identify the same run');
    check(Number.isSafeInteger(running.pid) && running.pid > 0, 'running presence records the child pid');
    equal(taskState.getTask({ taskId: running.currentTask }).status, 'running', 'canonical durable task lease is running with the lane');
    check(fs.existsSync(running.launchSpec), 'canonical launch spec is durable');
    const launchSpec = JSON.parse(fs.readFileSync(running.launchSpec, 'utf8'));
    equal(launchSpec.role, 'builder', 'respawn launch spec preserves builder');
    equal(launchSpec.reportsTo, FIXTURE_MANAGER, 'declared reporting line survives into the durable respawn spec');
    equal(launchSpec.dispatcher, FIXTURE_CONTROLLER, 'durable spec keeps the dispatcher distinct from the reporting line');
    equal(launchSpec.brief, running.brief, 'launch spec points at the durable app brief');
    equal(launchSpec.checkpoint, path.join(root, CHECKPOINT_DIRECTORY, `${first.receipt.launchId}.md`), 'launch spec carries the exact durable per-launch checkpoint path');
    check(typeof launchSpec.checkpoint === 'string' && fs.existsSync(launchSpec.checkpoint), 'launch spec checkpoint is non-null and published before child work');
    const checkpointStat = fs.lstatSync(launchSpec.checkpoint);
    check(checkpointStat.isFile() && !checkpointStat.isSymbolicLink(), 'published checkpoint is a regular non-symlink file');
    equal(path.relative(root, launchSpec.checkpoint), path.join('state', 'mission-bridge-checkpoints', `${first.receipt.launchId}.md`), 'checkpoint path is derived beneath the selected project root');
    const initialSeed = fs.readFileSync(launchSpec.checkpoint, 'utf8');
    check(initialSeed.includes('no child-authored progress has been recorded'), 'first-run seed truthfully states that no progress exists');
    equal(/Checkpoint state:\s*(?:complete|finished)/i.test(initialSeed), false, 'first-run seed does not masquerade as completed progress');
    check(fs.existsSync(running.brief), 'bounded app brief exists before and during child work');
    equal(path.resolve(running.brief).startsWith(path.resolve(root) + path.sep), true, 'brief path derives from the configured project root');
    const durableBrief = fs.readFileSync(running.brief, 'utf8');
    check(durableBrief.includes('update the durable checkpoint'), 'durable brief preserves the bounded app task');
    // The production instruction deliberately uses the portable forward-slash
    // relative path (checkpointRelativePath joins with '/'), so the expectation
    // must too -- path.join would demand backslashes on Windows and never match.
    check(durableBrief.includes(['state', 'mission-bridge-checkpoints', `${first.receipt.launchId}.md`].join('/')), 'durable brief carries the bounded relative checkpoint instruction');
    equal(durableBrief.includes(launchSpec.checkpoint), false, 'durable brief does not embed a machine-specific absolute checkpoint path');
    equal(durableBrief.includes('must-not-reach-child'), false, 'credential-shaped environment content never enters the brief');
    const firstChild = [...children][0];
    check(firstChild, 'initial fixture child is observable for the deliberate kill');
    equal(firstChild.__bridgeSpawnOptions.windowsHide, true, 'canonical child launch stays hidden');
    equal(firstChild.__bridgeSpawnOptions.shell, false, 'canonical child launch stays shell-free');
    equal(firstChild.__bridgeSpawnOptions.env.TEST_API_KEY, undefined, 'credential-shaped environment variables are stripped');
    const profileVariable = process.platform === 'win32' ? 'APPDATA' : 'HOME';
    check(discoveryEnvironment && discoveryEnvironment[profileVariable],
      'provider discovery receives the platform profile before resolving the command');
    equal(discoveryEnvironment[profileVariable], firstChild.__bridgeSpawnOptions.env[profileVariable],
      'provider discovery and the child launch use the same profile');
    if (process.platform !== 'win32') equal(discoveryEnvironment.HOME, root,
      'POSIX discovery preserves the explicit private fixture home');
    equal(discoveryEnvironment.TEST_API_KEY, undefined,
      'provider discovery never receives the caller credential environment');

    await waitFor(() => fs.existsSync(promptReadyFile), value => value === true, 'initial child prompt receipt');
    const initialPrompt = fs.readFileSync(initialPromptCapture, 'utf8');
    match(initialPrompt, /INITIAL CHECKPOINT SEED \(no prior progress/, 'first child receives the truthful seed boundary');
    equal(initialPrompt.includes('CHECKPOINT FROM THE PRIOR RUN'), false, 'first child is not told the seed is prior progress');
    const expectedCheckpointRelativePath = ['state', 'mission-bridge-checkpoints', `${first.receipt.launchId}.md`].join('/');
    match(initialPrompt, new RegExp(`Relative checkpoint path from the selected project root: ${expectedCheckpointRelativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'first child receives the exact relative checkpoint path instruction');

    const terminalCountBeforeCollision = auditApi.events.filter(event => event.action === 'controller.agent.launch.terminal').length;
    await rejectsCode(() => actions.dispatch({
      rootId: 'isolated',
      tier: 'luna',
      objectiveRef: 'phase3-collision-fixture',
      brief: 'attempt a concurrent lane with the same declared identity',
      cap: { kind: 'turns', value: 1, capMs: 60_000 }
    }), 'BRIDGE_AGENT_LANE_COLLISION');
    equal(presence.readRegistry(stateFile).agents.luna.runId, running.runId, 'collision does not overwrite the living presence owner');
    const tasksDuringCollision = taskState.listTasks({});
    equal(tasksDuringCollision.length, 2, 'collision still leaves a durable task outcome for both attempts');
    check(tasksDuringCollision.some(task => task.status === 'failed'), 'colliding task is terminal failed');
    equal(auditApi.events.filter(event => event.action === 'controller.agent.launch.terminal').length, terminalCountBeforeCollision + 1,
      'collision writes one failed launch-record receipt');

    fs.writeFileSync(allowCheckpointUpdateFile, 'update\n', 'utf8');
    await waitFor(() => fs.existsSync(checkpointReadyFile), value => value === true, 'child checkpoint update');
    equal(fs.readFileSync(launchSpec.checkpoint, 'utf8'), 'updated-checkpoint-from-first-mission-bridge-run\n', 'first child atomically replaces the seed with durable progress');
    killIfAlive(running.pid);
    const killed = await waitFor(
      () => presence.readRegistry(stateFile).agents.luna,
      record => record && record.runId === running.runId && record.status === 'failed',
      'deliberately killed first app lane'
    );
    equal(killed.exitCode, 1, 'deliberately killed first child records an honest nonzero exit');
    await waitFor(() => taskState.getTask({ taskId: killed.currentTask }).status, status => status === 'failed', 'killed lane task failure');
    await waitFor(() => terminalEvents(auditApi, first.receipt.launchId), events => events.length === 1, 'killed launch terminal receipt');
    equal(terminalEvents(auditApi, first.receipt.launchId)[0].details.receipt.terminalState, 'failed', 'deliberately killed launch receipt is honestly failed');

    const wakeRun = processRun(WAKE_CLI, [
      '--from', FIXTURE_MANAGER,
      '--org-file', orgFixtureFile,
      '--agent', 'luna',
      '--prompt', 'resume-phase3-from-updated-checkpoint',
      '--request-id', 'phase3-checkpoint-respawn',
      '--respawn-if-dead',
      '--startup-timeout-ms', '15000'
    ], isolatedEnvironment);
    const wakeResult = await Promise.race([
      wakeRun.done,
      delay(20_000).then(() => {
        killIfAlive(wakeRun.child.pid);
        throw new Error('agent-wake --respawn-if-dead timed out.');
      })
    ]);
    equal(wakeResult.code, 0, `canonical agent-wake CLI respawns the killed app lane: ${wakeResult.stderr}`);
    match(wakeResult.stdout, /^RESPAWNED:/, 'canonical wake path confirms new lane registration');
    const respawned = await waitFor(
      () => presence.readRegistry(stateFile).agents.luna,
      record => record && record.runId !== killed.runId && record.status === 'finished',
      'respawned app lane terminal success'
    );
    equal(respawned.exitCode, 0, 'respawned app lane exits successfully');
    equal(respawned.respawnCount, 1, 'respawned presence records the incremented count');
    equal(respawned.lastVerdict, 'VERDICT: mission bridge respawn consumed updated checkpoint and supervisor directive', 'respawned app lane reports checkpoint-plus-directive consumption');
    const respawnPrompt = fs.readFileSync(respawnPromptCapture, 'utf8');
    match(respawnPrompt, /CHECKPOINT FROM THE PRIOR RUN/, 'respawn prompt carries the prior-run checkpoint boundary');
    match(respawnPrompt, /updated-checkpoint-from-first-mission-bridge-run/, 'respawn prompt carries the child-updated checkpoint content');
    match(respawnPrompt, /SUPERVISOR DIRECTIVES SINCE YOUR LAST RUN/, 'respawn prompt carries the supervisor directive boundary');
    match(respawnPrompt, /resume-phase3-from-updated-checkpoint/, 'respawn prompt carries the queued supervisor directive');
    const respawnLaunchSpec = JSON.parse(fs.readFileSync(respawned.launchSpec, 'utf8'));
    equal(respawnLaunchSpec.checkpoint, launchSpec.checkpoint, 'respawn preserves the exact original durable checkpoint path');
    equal(presence.drainMailbox('luna', respawned.mailboxOffset, { mailboxDir }).entries.length, 0, 'respawn advances the mailbox offset without replay');
    await waitFor(
      () => fs.existsSync(`${respawned.consoleLog}.wrapper.log`) ? fs.readFileSync(`${respawned.consoleLog}.wrapper.log`, 'utf8') : '',
      text => text.includes('"status":"finished"'),
      'respawn wrapper terminal receipt'
    );
    const tasksAfterRespawn = taskState.listTasks({});
    equal(tasksAfterRespawn.length, 3, 'initial, collision, and respawn runs each own one durable task');
    equal(tasksAfterRespawn.filter(task => task.status === 'failed').length, 2, 'killed and colliding tasks remain failed');
    equal(tasksAfterRespawn.filter(task => task.status === 'succeeded').length, 1, 'respawned task is the sole success');

    const securityWorktree = path.join(root, 'checkpoint-security-worktree');
    const securityOutside = path.join(root, 'checkpoint-security-outside');
    const securityBrief = path.join(securityWorktree, 'brief.md');
    const credentialCheckpoint = path.join(securityWorktree, 'credential-checkpoint.md');
    fs.mkdirSync(securityWorktree);
    fs.mkdirSync(securityOutside);
    fs.writeFileSync(securityBrief, 'Security fixture.\n', 'utf8');
    fs.writeFileSync(credentialCheckpoint, 'api_key=abcdefghijklmnopqrstuvwxyz123456\n', 'utf8');
    assertions += 1;
    assert.throws(() => agentLane.buildPrompt({
      brief: securityBrief,
      checkpoint: credentialCheckpoint,
      worktree: securityWorktree,
      respawnCount: 1
    }, { entries: [] }), error => error?.code === 'AGENT_LANE_CHECKPOINT_CREDENTIAL_REFUSED', 'canonical checkpoint consumption refuses credential-shaped child updates');
    const outsideCheckpoint = path.join(securityOutside, 'outside.md');
    const checkpointJunction = path.join(securityWorktree, 'junction');
    fs.writeFileSync(outsideCheckpoint, 'outside checkpoint\n', 'utf8');
    fs.symlinkSync(securityOutside, checkpointJunction, 'junction');
    try {
      assertions += 1;
      assert.throws(() => agentLane.buildPrompt({
        brief: securityBrief,
        checkpoint: path.join(checkpointJunction, 'outside.md'),
        worktree: securityWorktree,
        respawnCount: 1
      }, { entries: [] }), error => error?.code === 'AGENT_LANE_CHECKPOINT_REFUSED', 'canonical checkpoint consumption refuses a junction path escape');
    } finally {
      fs.unlinkSync(checkpointJunction);
    }

    const spawnFailureActions = createMissionActions({
      roots: { isolated: root },
      actor: FIXTURE_CONTROLLER,
      audit: auditApi,
      policy: { assertActive() {} },
      agentOrg: FIXTURE_ORG,
      env: { PATH: process.env.PATH },
      laneDependencies: {
        ...laneDependencies,
        // The resolved command here is codex-shaped, so buildPrompt would
        // otherwise construct the REAL onboarding packet, which requires this
        // installation's live context (owner ledger, build queue, presence) --
        // installation state a checkout-portable suite must not depend on or
        // invent. Onboarding is not the property under test in this block; the
        // typed spawn failure is, and it happens strictly after prompt build.
        buildOnboardingPacket: () => 'SPAWN-FAILURE FIXTURE PACKET: onboarding context is not the property under test in this block.\n'
      },
      // This case measures the real OS spawn refusal for an absent executable.
      // API-only standalone admission has its own agent-api-modes coverage;
      // inert fixture argv lets this case reach the failing process boundary.
      codexArgs: () => ['exec', '--json'],
      resolveCommand: () => ({ command: path.join(root, 'missing', 'codex.exe'), prefixArgs: [] })
    });
    const launchEventsBeforeFailure = auditApi.events.filter(event => event.action === 'controller.agent.launch').length;
    await rejectsCode(() => spawnFailureActions.dispatch({
      rootId: 'isolated',
      tier: 'luna',
      objectiveRef: 'phase3-spawn-failure',
      brief: 'exercise typed spawn failure terminalization',
      cap: { kind: 'turns', value: 1, capMs: 60_000 }
    }), 'BRIDGE_CODEX_SPAWN_REFUSED');
    const failedPresence = presence.readRegistry(stateFile).agents.luna;
    equal(failedPresence.status, 'failed', 'spawn failure terminalizes presence');
    equal(failedPresence.exitCode, 1, 'spawn failure records a terminal exit code');
    check(/^VERDICT: spawn failed/.test(failedPresence.lastVerdict), 'spawn failure records a bounded terminal VERDICT');
    equal(taskState.getTask({ taskId: failedPresence.currentTask }).status, 'failed', 'spawn failure terminalizes the durable task');
    const failureLaunch = auditApi.events.filter(event => event.action === 'controller.agent.launch')[launchEventsBeforeFailure];
    equal(terminalEvents(auditApi, failureLaunch.target).length, 1, 'spawn failure writes exactly one launch terminal receipt');
    equal(terminalEvents(auditApi, failureLaunch.target)[0].details.receipt.terminalState, 'failed', 'spawn failure launch receipt is failed');

    process.stdout.write(`mission bridge agent lane: ${assertions} assertions passed\n`);
  } finally {
    if (!fs.existsSync(allowCheckpointUpdateFile)) fs.writeFileSync(allowCheckpointUpdateFile, 'update\n', 'utf8');
    for (const child of children) {
      try { child.kill(); } catch { /* best effort fixture cleanup */ }
    }
    try { killIfAlive(presence.readRegistry(stateFile).agents.luna?.pid); } catch { /* no registry */ }
    await delay(100);
    taskState.close();
    if (previousTestMode === undefined) delete process.env.TOOLSENABLED_LANE_RUN_TEST;
    else process.env.TOOLSENABLED_LANE_RUN_TEST = previousTestMode;
    // A TEARDOWN FAILURE IS NOT A PRODUCT FAILURE, AND IT IS NOT NOTHING EITHER.
    //
    // This removal used to be a bare rmSync. Under the isolated runner it raised
    // EBUSY on isolated-state/audit.sqlite3 deterministically -- the spawned
    // agent-wake CLI is a separate process and Windows holds its sqlite handle a
    // moment past kill() and the 100 ms wait above. The throw escaped main()'s
    // catch and set exitCode 1, so a run whose 63 assertions ALL PASSED reported
    // failure. That conflates 'the product is broken' with 'the filesystem was
    // busy for another 200 ms' -- two very different facts arriving as one byte.
    //
    // The runner already solved exactly this for its own suite root:
    // removeIsolatedDirectory() in tests/run-isolated.js retries the same four
    // codes with backoff, and its comment names the same causes (antivirus,
    // indexing, recently closed child handles). This is that idiom, not a fourth
    // shape -- the codes are kept identical on purpose so the two agree.
    //
    // If it still survives, ANNOUNCE it. A suite that silently leaves temp state
    // behind is how 135 scratch roots accumulated unseen in %TEMP% earlier this
    // week; a warning costs one line on a path that should never run.
    const RETRYABLE = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
    let removeError = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        if (!fs.existsSync(root)) { removeError = null; break; }
      } catch (error) {
        removeError = error;
        if (!RETRYABLE.has(error?.code)) throw error;
      }
      await delay(150 * (attempt + 1));
    }
    if (removeError || fs.existsSync(root)) {
      process.emitWarning('mission-bridge-agent-lane: scratch root survived teardown at ' + root
        + (removeError ? ' (' + removeError.code + ')' : '')
        + '. The assertions above still hold; remove it by hand.');
    }
  }
}

main().catch(error => {
  process.stderr.write(`${error?.code || 'ERROR'}: ${error && error.stack ? error.stack : error}\n`);
  if (error?.details) process.stderr.write(`DETAILS: ${JSON.stringify(error.details)}\n`);
  process.exitCode = 1;
});
