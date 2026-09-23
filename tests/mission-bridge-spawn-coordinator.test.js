'use strict';

const { activate } = require('./lib/isolated-environment');
activate('mission-bridge-spawn-coordinator');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const agentOrg = require('../src/lib/agent-org');
const machineRecord = require('../src/lib/setup/machine-record');
const {
  authorizedMissionAgent,
  createMissionActions
} = require('../src/lib/mission-bridge/actions');

const ROOT = path.resolve(__dirname, '..');
const ACTIONS_FILE = path.join(ROOT, 'src', 'lib', 'mission-bridge', 'actions.js');
const TOOL_REGISTRY_FILE = path.join(ROOT, 'src', 'lib', 'tool-registry.js');
const ORG_FILE = path.join(ROOT, 'config', 'agent-org.example.json');
const CAPABILITIES = Object.freeze({
  orgRoot: false,
  singleSeat: false,
  mayClaimWork: true,
  mayWakeReports: true,
  requiresMutationContext: false,
  mayUseMissionBridge: true,
  mayReportMissionBridge: true,
  mayMutateMissionBridge: true
});
const KNOWN_ROLES = Object.freeze([
  Object.freeze({ id: 'release-captain', capabilities: CAPABILITIES })
]);

function declaredOrg({ rootId = 'root-alpha', rootProvider = 'codex', enabled = true } = {}) {
  const raw = JSON.parse(fs.readFileSync(ORG_FILE, 'utf8'));
  const worker = raw.agents.find(agent => agent.id === 'luna');
  worker.id = rootId;
  worker.displayName = 'Release captain';
  worker.provider = rootProvider;
  worker.role = 'release-captain';
  worker.enabled = enabled;
  raw.relationships = raw.relationships
    .map(edge => ({ ...edge, to: edge.to === 'luna' ? rootId : edge.to }));
  return agentOrg.normalizeOrg(raw, { knownRoles: KNOWN_ROLES });
}

function noOpAudit() {
  let sequence = 0;
  return {
    requireRecord() {
      sequence += 1;
      return { durable: true, anchored: true, sequence, eventHash: String(sequence).padStart(64, '0') };
    }
  };
}

async function main() {
  const actionsSource = fs.readFileSync(ACTIONS_FILE, 'utf8');
  const registrySource = fs.readFileSync(TOOL_REGISTRY_FILE, 'utf8');

  assert.equal(Object.hasOwn(require('../src/lib/mission-bridge/actions'), 'spawnCoordinatorOrg'), false,
    'provider-to-root projection is still exported');
  assert.doesNotMatch(actionsSource, /\bspawnCoordinatorOrg\b/,
    'provider-to-root projection remains in the mission action path');
  assert.doesNotMatch(registrySource, /spawnCoordinatorOrg|agentOrg:\s*spawn/i,
    'agent.spawn still rewrites an organisation for a provider');
  assert.match(registrySource, /actor:\s*context\.agentId/,
    'agent.spawn is not attributed to its exact declared identity');

  /* This tripwire fired for real: a57cd698 (2026-09-10) added 'grok' to
     AGENT_ACTORS (setup/machine-record.js:902) for the ACP launch path and did
     not come back here. Reviewed and accepted as the fourth actor; the list stays
     exact so the next unreviewed addition trips it the same way. */
  assert.deepEqual(machineRecord.AGENT_ACTORS, ['codex', 'claude', 'gemini', 'grok'],
    'provider vocabulary changed unexpectedly');

  const codexRoot = declaredOrg({ rootProvider: 'codex' });
  assert.equal(authorizedMissionAgent('root-alpha', codexRoot, KNOWN_ROLES), 'root-alpha',
    'a non-root custom role with mission-bridge capability was not admitted generically');
  for (const provider of machineRecord.AGENT_ACTORS) {
    assert.throws(
      () => authorizedMissionAgent(provider, codexRoot, KNOWN_ROLES),
      error => error?.code === 'BRIDGE_ACTOR_REFUSED' && error?.status === 403,
      `${provider} inherited root authority merely by naming a provider`
    );
  }
  assert.throws(
    () => authorizedMissionAgent('shadow-manager', codexRoot, KNOWN_ROLES),
    error => error?.code === 'BRIDGE_ACTOR_REFUSED' && error?.status === 403,
    'a role-like actor name acquired authority without a declared capable seat'
  );
  assert.equal(authorizedMissionAgent('controller', codexRoot, KNOWN_ROLES), 'controller',
    'the shipped controller capability was not read from its role definition');

  const claudeRoot = declaredOrg({ rootProvider: 'claude' });
  assert.equal(authorizedMissionAgent('root-alpha', claudeRoot, KNOWN_ROLES), 'root-alpha',
    'the same generic root role changed semantics with provider');

  const principal = (provider, agentId = 'root-alpha', roleId = 'release-captain') => ({
    kind: 'agent-session',
    sessionId: `session-${provider}-${agentId}`,
    agentId,
    provider,
    roleId,
    expectedOrgRevision: codexRoot.revision,
    expectedRoleRevision: 1
  });
  assert.doesNotThrow(() => createMissionActions({
    roots: { workspace: ROOT },
    principal: principal('codex'),
    permissionSession: { origin: 'local', tier: 'full' },
    agentOrg: codexRoot,
    knownRoles: KNOWN_ROLES,
    policy: { assertActive() {} },
    researchActions: {},
    machinesActions: {}
  }), 'the exact Codex transport principal did not retain its generic custom-role authority');
  /* An org revision that has moved on since the credential was issued is not,
     by itself, a reason to refuse: a tree spawn bumps it for every seat it
     declares, and the spawning session's own row is unchanged. Measured
     2026-09-03: this comparison answered 403 to the circle that had just
     spawned. Disabled, re-roled or re-providered seats are still refused by
     the checks that name those facts. */
  assert.doesNotThrow(() => createMissionActions({
    roots: { workspace: ROOT },
    principal: { ...principal('codex'), expectedOrgRevision: codexRoot.revision + 1 },
    permissionSession: { origin: 'local', tier: 'full' },
    agentOrg: codexRoot,
    knownRoles: KNOWN_ROLES,
    policy: { assertActive() {} },
    researchActions: {},
    machinesActions: {}
  }), 'an org revision bump for another seat refused a principal whose own seat is unchanged');
  assert.throws(() => createMissionActions({
    roots: { workspace: ROOT },
    principal: principal('claude'),
    permissionSession: { origin: 'local', tier: 'full' },
    agentOrg: codexRoot,
    knownRoles: KNOWN_ROLES,
    policy: { assertActive() {} },
    researchActions: {},
    machinesActions: {}
  }), error => error?.code === 'BRIDGE_ACTOR_REFUSED' && error?.status === 403,
  'a Claude transport credential was able to reuse a Codex-declared agent identity');

  let current = codexRoot;
  let mutationCalls = 0;
  const actions = createMissionActions({
    roots: { workspace: ROOT },
    actor: 'root-alpha',
    permissionSession: { origin: 'local', tier: 'full' },
    policy: { assertActive() {} },
    audit: noOpAudit(),
    readDeclaredOrgContext() { return { org: current, knownRoles: KNOWN_ROLES }; },
    cloudMirror: {
      disableMirrorProject() {
        mutationCalls += 1;
        return { projectKey: 'fixture', registryPath: 'fixture', project: {} };
      }
    },
    researchActions: {},
    machinesActions: {}
  });

  current = declaredOrg({ rootProvider: 'codex', enabled: false });
  await assert.rejects(
    async () => actions.cloudMirrorDisable({ projectKey: 'fixture' }),
    error => error?.code === 'BRIDGE_ACTOR_REFUSED' && error?.status === 403,
    'a disabled root retained a non-spawn mutation through a long-lived bridge'
  );
  assert.equal(mutationCalls, 0, 'the mutation dependency ran before current authority was rechecked');

  assert.throws(
    () => createMissionActions({
      roots: { workspace: ROOT },
      actor: 'codex',
      permissionSession: { origin: 'local', tier: 'full' },
      agentOrg: claudeRoot,
      knownRoles: KNOWN_ROLES,
      policy: { assertActive() {} },
      researchActions: {},
      machinesActions: {}
    }),
    error => error?.code === 'BRIDGE_ACTOR_REFUSED' && error?.status === 403,
    'a Codex provider label inherited a Claude session root'
  );

  process.stdout.write(
    'mission bridge identity: exact custom-role root admitted on Codex/Claude; provider labels refused; stale non-spawn mutation refused before side effect\n'
  );
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
