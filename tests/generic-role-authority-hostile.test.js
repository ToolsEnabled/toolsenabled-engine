'use strict';

// Independent hostile proof for the production role-authority path. This is
// deliberately separate from the historical wake/onboarding suites: it reads
// the shipped source and manifests, constructs adversarial role names and
// forged presence, and then drives the real wake and mission-bridge boundaries.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const agentOrg = require('../src/lib/agent-org');
const presence = require('../src/lib/agent-presence');
const wake = require('../src/lib/agent-wake');
const missionBridge = require('../src/lib/mission-bridge/actions');

const KNOWN_ROLES = Object.freeze([
  Object.freeze({ id: 'release-captain', baseDefaultRole: 'manager' }),
  Object.freeze({ id: 'global-supervisor', baseDefaultRole: 'observer' }),
  Object.freeze({ id: 'unbased-operator', baseDefaultRole: null })
]);

const capabilities = overrides => Object.freeze({
  orgRoot: false,
  singleSeat: false,
  mayClaimWork: false,
  mayWakeReports: false,
  requiresMutationContext: false,
  mayUseMissionBridge: false,
  mayReportMissionBridge: false,
  mayMutateMissionBridge: false,
  ...overrides
});

function declaredOrg({ codexIsShadow = false, releaseHasChild = true, shadowCapabilities = null } = {}) {
  const agents = [
    { id: 'root-a', displayName: 'Root A', role: 'controller', provider: 'none', enabled: true },
    { id: 'release-a', displayName: 'Release A', role: 'release-captain', provider: 'codex', enabled: true },
    { id: 'named-supervisor-a', displayName: 'Named Supervisor A', role: 'global-supervisor', provider: 'codex', enabled: true },
    { id: 'unbased-a', displayName: 'Unbased A', role: 'unbased-operator', provider: 'codex', enabled: true },
    { id: 'shadow-a', displayName: 'Shadow A', role: 'shadow-manager', provider: 'claude', enabled: true },
    { id: 'release-worker', displayName: 'Release Worker', role: 'worker', provider: 'codex', enabled: true },
    { id: 'named-worker', displayName: 'Named Worker', role: 'worker', provider: 'codex', enabled: true },
    { id: 'unbased-worker', displayName: 'Unbased Worker', role: 'worker', provider: 'codex', enabled: true },
    { id: 'shadow-worker', displayName: 'Shadow Worker', role: 'worker', provider: 'codex', enabled: true },
    { id: 'outside-worker', displayName: 'Outside Worker', role: 'worker', provider: 'codex', enabled: true }
  ];
  if (codexIsShadow) {
    agents.push({ id: 'codex', displayName: 'Colliding Codex', role: 'shadow-manager', provider: 'codex', enabled: true });
  }
  const relationships = [
    { from: 'root-a', to: 'release-a', type: 'manages' },
    { from: 'root-a', to: 'named-supervisor-a', type: 'manages' },
    { from: 'root-a', to: 'unbased-a', type: 'manages' },
    { from: 'root-a', to: 'shadow-a', type: 'manages' },
    { from: 'root-a', to: 'outside-worker', type: 'manages' },
    { from: 'named-supervisor-a', to: 'named-worker', type: 'manages' },
    { from: 'unbased-a', to: 'unbased-worker', type: 'manages' },
    { from: 'shadow-a', to: 'shadow-worker', type: 'manages' }
  ];
  if (releaseHasChild) relationships.push({ from: 'release-a', to: 'release-worker', type: 'manages' });
  if (codexIsShadow) relationships.push({ from: 'root-a', to: 'codex', type: 'manages' });
  return agentOrg.normalizeOrg({ schemaVersion: 1, revision: 1, agents, relationships }, {
    knownRoles: [
      ...KNOWN_ROLES,
      ...(shadowCapabilities ? [{
        id: 'shadow-manager',
        baseDefaultRole: null,
        capabilities: shadowCapabilities
      }] : [])
    ]
  });
}

function observedTarget(agentId, reportsTo) {
  return { agentId, role: 'worker', reportsTo };
}

function assertCode(run, code) {
  assert.throws(run, error => error && error.code === code, `expected ${code}`);
}

function runtimeRecord(directory, agentId, role, reportsTo) {
  const worktree = path.join(directory, `${agentId}-worktree`);
  fs.mkdirSync(worktree, { recursive: true });
  return {
    agentId,
    runId: crypto.randomUUID(),
    role,
    tier: 'gpt-5.6-terra',
    reportsTo,
    dispatcher: reportsTo,
    lane: `lane-${agentId}`,
    territory: 'tests/**',
    currentTask: null,
    brief: path.join(worktree, 'brief.md'),
    consoleLog: path.join(directory, `${agentId}.log`),
    worktree,
    launchSpec: path.join(directory, `${agentId}.launch.json`),
    pid: 123,
    startedAt: 1_000,
    lastHeartbeat: 1_000,
    status: 'running',
    exitCode: null,
    lastVerdict: null,
    terminalAt: null,
    staleReason: null,
    mailboxOffset: 0,
    respawnCount: 0,
    verdictConsumedAt: null
  };
}

async function main() {
  assertCode(() => agentOrg.normalizeOrg({
    schemaVersion: 1,
    revision: 1,
    agents: [{ id: 'root-a', displayName: 'Root A', role: 'controller', provider: 'none', enabled: true }],
    relationships: []
  }, {
    knownRoles: [{
      id: 'shadow-manager',
      baseDefaultRole: null,
      capabilities: { mayClaimWork: true }
    }]
  }), 'AGENT_ORG_INVALID');

  const org = declaredOrg();
  const registry = {
    agents: {
      'release-worker': observedTarget('release-worker', 'release-a'),
      'named-worker': observedTarget('named-worker', 'named-supervisor-a'),
      'unbased-worker': observedTarget('unbased-worker', 'unbased-a'),
      'shadow-worker': observedTarget('shadow-worker', 'shadow-a'),
      'outside-worker': observedTarget('outside-worker', 'root-a'),
      // Hostile observation: presence claims the declared Shadow is a manager.
      // roleOf() must use the normalized declaration instead.
      'shadow-a': { agentId: 'shadow-a', role: 'manager', reportsTo: 'root-a' }
    }
  };

  assert.equal(wake.assertWakeAuthorized({
    from: 'release-a', target: 'release-worker', org, registry
  }).role, 'release-captain');
  assertCode(() => wake.assertWakeAuthorized({
    from: 'release-a', target: 'outside-worker', org, registry
  }), 'AGENT_WAKE_OUTSIDE_TOPOLOGY');
  for (const [from, target] of [
    ['named-supervisor-a', 'named-worker'],
    ['unbased-a', 'unbased-worker'],
    ['shadow-a', 'shadow-worker']
  ]) {
    assertCode(() => wake.assertWakeAuthorized({ from, target, org, registry }), 'AGENT_WAKE_ROLE_READ_ONLY');
  }
  assertCode(() => wake.assertWakeAuthorized({
    from: 'release-a', target: 'release-worker', org: declaredOrg({ releaseHasChild: false }), registry
  }), 'AGENT_WAKE_NOT_SUPERVISOR');

  const activeShadowOrg = declaredOrg({
    shadowCapabilities: capabilities({ mayClaimWork: true, mayWakeReports: true })
  });
  assert.equal(wake.assertWakeAuthorized({
    from: 'shadow-a', target: 'shadow-worker', org: activeShadowOrg, registry
  }).role, 'shadow-manager',
  'the Shadow name has no hardcoded mechanical posture; its stored capability record is decisive');

  // Provider labels never project into an organisation. The same spelling is
  // accepted only when it is itself an exact declared, capable agent id.
  assert.equal(Object.hasOwn(missionBridge, 'spawnCoordinatorOrg'), false);
  assertCode(() => missionBridge.authorizedMissionAgent('codex', org, KNOWN_ROLES),
    'BRIDGE_ACTOR_REFUSED');
  const exactCodexAgent = declaredOrg({ codexIsShadow: true });
  assert.equal(missionBridge.authorizedMissionAgent('codex', exactCodexAgent, KNOWN_ROLES), 'codex');
  assert.equal(exactCodexAgent.agents.find(agent => agent.id === 'release-a').role, 'release-captain');
  assert.equal(exactCodexAgent.agents.find(agent => agent.id === 'shadow-a').role, 'shadow-manager');

  // This account's own real temp root, expanded through the filesystem (see
  // src/lib/account-profile-boundary.js, "An 8.3 short name is the same
  // account, spelled shorter") rather than hardcoded to one developer's
  // account name -- the property below (path.resolve is a no-op on an
  // already-canonical absolute path) does not depend on whose account it is.
  const devTempRoot = fs.realpathSync.native(os.tmpdir());
  assert.equal(path.resolve(devTempRoot), devTempRoot,
    "the hostile oracle temp root must remain this account's own real temp directory");
  const directory = fs.mkdtempSync(path.join(devTempRoot, 'generic-role-hostile-'));
  try {
    const stateFile = path.join(directory, 'presence.json');
    const mailboxDir = path.join(directory, 'mailbox');
    const launchDir = path.join(directory, 'launch');
    for (const record of [
      runtimeRecord(directory, 'shadow-a', 'manager', 'root-a'),
      runtimeRecord(directory, 'shadow-worker', 'worker', 'shadow-a'),
      runtimeRecord(directory, 'named-worker', 'worker', 'named-supervisor-a'),
      runtimeRecord(directory, 'unbased-worker', 'worker', 'unbased-a'),
      runtimeRecord(directory, 'release-worker', 'worker', 'release-a')
    ]) presence.register(record, { file: stateFile });

    let launches = 0;
    const dependencies = {
      stateFile,
      mailboxDir,
      launchDir,
      org,
      isAlive: () => true,
      launchLane: async () => { launches += 1; return { pid: 999 }; }
    };
    for (const [from, target] of [
      ['shadow-a', 'shadow-worker'],
      ['named-supervisor-a', 'named-worker'],
      ['unbased-a', 'unbased-worker']
    ]) {
      await assert.rejects(() => wake.wakeAgent({
        agentId: target,
        from,
        prompt: 'Hostile authority attempt.',
        requestId: `hostile-${from}`
      }, dependencies), error => error && error.code === 'AGENT_WAKE_ROLE_READ_ONLY');
      assert.equal(fs.existsSync(path.join(mailboxDir, `${target}.jsonl`)), false,
        `${from} was refused before mailbox delivery`);
    }
    assert.equal(launches, 0, 'no hostile role reached the process launcher');

    const accepted = await wake.wakeAgent({
      agentId: 'release-worker',
      from: 'release-a',
      prompt: 'Continue the bounded release work.',
      requestId: 'hostile-control-success'
    }, dependencies);
    assert.equal(accepted.action, 'queued');
    assert.equal(launches, 0, 'a live descendant receives a mailbox request without spawning');
    assert.equal(presence.drainMailbox('release-worker', 0, { mailboxDir }).entries.length, 1);
    assert.deepEqual(fs.existsSync(launchDir) ? fs.readdirSync(launchDir) : [], [],
      'authority refusals and a live delivery leave no process state behind');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const wakeSource = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'agent-wake.js'), 'utf8');
  const missionSource = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'mission-bridge', 'actions.js'), 'utf8');
  assert.doesNotMatch(wakeSource, /\bSUPERVISOR_ROLES\b/);
  assert.doesNotMatch(wakeSource, /\brole\s*={2,3}\s*['"]shadow-manager['"]/);
  assert.match(wakeSource, /agentOrg\.isSupervisor\(org, actorId\)/);
  assert.match(wakeSource, /agentOrg\.roleHasCapability\(org, role, 'mayWakeReports'\)/);
  assert.doesNotMatch(missionSource, /shadow-manager/i,
    'mission dispatch has no Shadow-specific branch or authority path');

  const packageManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'packages.json'), 'utf8'));
  const packaged = new Set(packageManifest.packages.flatMap(entry => entry.files));
  const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'payload-boundary.json'), 'utf8'));
  const shipped = new Set(payload.open.paths);
  for (const relative of [
    'src/lib/agent-org-store.js',
    'src/lib/agent-org.js',
    'src/lib/agent-roles.js',
    'src/lib/agent-wake.js',
    'src/lib/mission-bridge/actions.js'
  ]) {
    assert.equal(packaged.has(relative), true, `${relative} is missing from config/packages.json`);
    assert.equal(shipped.has(relative), true, `${relative} is missing from the customer payload`);
  }

  process.stdout.write('generic role hostile authority proof passed (runtime, mission dispatch, manifests, and no-effect refusals)\n');
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
