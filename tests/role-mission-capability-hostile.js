'use strict';

// Direct hostile oracle for the real mission action constructor/guards.  It
// intentionally does not rely on the historical role suites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agentOrg = require('../src/lib/agent-org');
const mission = require('../src/lib/mission-bridge/actions');
const ALLOWED_TEMP_ROOT = fs.realpathSync(require('node:os').tmpdir());

const fields = overrides => Object.freeze({
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

const CUSTOM = Object.freeze([
  Object.freeze({ id: 'audit-reader', baseDefaultRole: null, capabilities: fields({ mayUseMissionBridge: true }) }),
  Object.freeze({ id: 'dispatch-lead', baseDefaultRole: null, capabilities: fields({ mayUseMissionBridge: true, mayReportMissionBridge: true, mayMutateMissionBridge: true }) }),
  Object.freeze({ id: 'shadow-manager-clone', baseDefaultRole: null, capabilities: fields({}) })
]);
const BUILTIN_ROLES = Object.freeze([
  'controller', 'shadow-manager', 'planner', 'manager', 'coordinator-assistant',
  'builder', 'reviewer', 'worker', 'observer'
]);
const MUTATING_BUILTINS = new Set(['controller', 'manager', 'builder', 'worker']);

function orgWith(overrides = {}) {
  const custom = new Map(CUSTOM.map(role => [role.id, role]));
  if (overrides.dispatchCapabilities) custom.set('dispatch-lead', {
    id: 'dispatch-lead', baseDefaultRole: null, capabilities: overrides.dispatchCapabilities
  });
  if (overrides.readerCapabilities) custom.set('audit-reader', {
    id: 'audit-reader', baseDefaultRole: null, capabilities: overrides.readerCapabilities
  });
  const knownRoles = [...custom.values()];
  if (overrides.controllerCapabilities) knownRoles.push({
    id: 'controller', baseDefaultRole: null, capabilities: overrides.controllerCapabilities
  });
  const agents = [
    ...BUILTIN_ROLES.map((role, index) => ({
      id: role === 'controller' ? 'root-agent' : `${role}-agent`,
      displayName: `${role} agent`,
      role,
      provider: index % 2 === 0 ? 'codex' : 'claude',
      enabled: true
    })),
    { id: 'reader-agent', displayName: 'Reader agent', role: 'audit-reader', provider: 'codex', enabled: true },
    { id: 'lead-agent', displayName: 'Lead agent', role: 'dispatch-lead', provider: 'claude', enabled: true },
    { id: 'clone-agent', displayName: 'Clone agent', role: 'shadow-manager-clone', provider: 'codex', enabled: true }
  ];
  return {
    knownRoles,
    org: agentOrg.normalizeOrg({
      schemaVersion: 1,
      revision: 11,
      agents,
      relationships: agents.slice(1).map(agent => ({ from: 'root-agent', to: agent.id, type: 'manages' }))
    }, { knownRoles })
  };
}

function principal(agent, roleId, provider) {
  return Object.freeze({
    kind: 'agent-session',
    sessionId: `session-${agent}`,
    agentId: agent,
    provider,
    roleId,
    expectedOrgRevision: 11,
    expectedRoleRevision: 1
  });
}

function code(expected) {
  return error => error && error.code === expected;
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(ALLOWED_TEMP_ROOT, 'role-mission-hostile-'));
  if (path.dirname(temporary).toLowerCase() !== ALLOWED_TEMP_ROOT.toLowerCase()) {
    throw new Error('The role mission oracle temp directory left the owned temporary root.');
  }
  const reportFile = path.join(temporary, 'finding-REPORT.md');
  fs.writeFileSync(reportFile, 'measured finding\n', 'utf8');
  try {
    const executeTool = async (tool, args) => {
      if (tool === 'host.read_file') {
        const content = fs.readFileSync(args.path, 'utf8');
        return { path: args.path, content, bytes: Buffer.byteLength(content) };
      }
      if (tool === 'memory.set') {
        return { namespace: args.namespace, key: args.key, revision: 1 };
      }
      throw new Error(`unexpected tool ${tool}`);
    };
    const baseOptions = {
      roots: { main: temporary },
      permissionSession: { origin: 'local', tier: 'full' },
      policy: { assertActive() {} },
      executeTool,
      researchActions: {},
      machinesActions: {}
    };
    const declared = orgWith();
    const actionsFor = identity => mission.createMissionActions({
      ...baseOptions,
      agentOrg: declared.org,
      knownRoles: declared.knownRoles,
      principal: identity
    });
    const actionsForAgent = (snapshot, agentId) => {
      const agent = snapshot.org.agents.find(candidate => candidate.id === agentId);
      return mission.createMissionActions({
        ...baseOptions,
        agentOrg: snapshot.org,
        knownRoles: snapshot.knownRoles,
        principal: principal(agent.id, agent.role, agent.provider)
      });
    };

    // Every shipped directions sheet has a generic API posture capable of its
    // stated job. Read/report roles remain unable to mutate; work/dispatch
    // roles pass the mutation role gate. No assertion below keys enforcement
    // on a role name -- names only select stored role records for this oracle.
    for (const role of BUILTIN_ROLES) {
      const agentId = role === 'controller' ? 'root-agent' : `${role}-agent`;
      const actions = actionsForAgent(declared, agentId);
      assert.equal((await actions.readReport({ rootId: 'main', relativePath: 'finding-REPORT.md' })).ok, true,
        `${role} cannot inspect through its stored generic capability`);
      assert.equal((await actions.reply({
        idempotencyKey: `builtin-${role}`, threadId: 'controller', message: `${role} report.`
      })).ok, true, `${role} cannot report through its stored generic capability`);
      if (MUTATING_BUILTINS.has(role)) {
        await assert.rejects(async () => actions.queue({}), error => error?.code === 'BRIDGE_INPUT_INVALID',
          `${role} did not pass its stored mutation role gate`);
      } else {
        await assert.rejects(async () => actions.queue({}), code('BRIDGE_ACTOR_REFUSED'),
          `${role} unexpectedly passed the mutation role gate`);
      }
    }

    const shadow = actionsFor(principal('shadow-manager-agent', 'shadow-manager', 'claude'));
    assert.equal((await shadow.readReport({ rootId: 'main', relativePath: 'finding-REPORT.md' })).ok, true);
    assert.equal((await shadow.reply({ idempotencyKey: 'shadow-report', threadId: 'controller', message: 'Measured finding.' })).ok, true);
    await assert.rejects(async () => shadow.queue({}), code('BRIDGE_ACTOR_REFUSED'));

    const reader = actionsFor(principal('reader-agent', 'audit-reader', 'codex'));
    assert.equal((await reader.readReport({ rootId: 'main', relativePath: 'finding-REPORT.md' })).ok, true,
      'a custom non-Shadow role could not receive the generic inspect capability');
    await assert.rejects(async () => reader.reply({}), code('BRIDGE_ACTOR_REFUSED'));
    await assert.rejects(async () => reader.queue({}), code('BRIDGE_ACTOR_REFUSED'));

    const reportOnlySnapshot = orgWith({ readerCapabilities: fields({ mayReportMissionBridge: true }) });
    const reportOnly = actionsForAgent(reportOnlySnapshot, 'reader-agent');
    await assert.rejects(async () => reportOnly.readReport({ rootId: 'main', relativePath: 'finding-REPORT.md' }), code('BRIDGE_ACTOR_REFUSED'));
    assert.equal((await reportOnly.reply({
      idempotencyKey: 'custom-report-only', threadId: 'controller', message: 'Report-only custom role.'
    })).ok, true);
    await assert.rejects(async () => reportOnly.queue({}), code('BRIDGE_ACTOR_REFUSED'));

    const mutationOnlySnapshot = orgWith({ readerCapabilities: fields({ mayMutateMissionBridge: true }) });
    const mutationOnly = actionsForAgent(mutationOnlySnapshot, 'reader-agent');
    await assert.rejects(async () => mutationOnly.readReport({ rootId: 'main', relativePath: 'finding-REPORT.md' }), code('BRIDGE_ACTOR_REFUSED'));
    await assert.rejects(async () => mutationOnly.reply({}), code('BRIDGE_ACTOR_REFUSED'));
    await assert.rejects(async () => mutationOnly.queue({}), error => error?.code === 'BRIDGE_INPUT_INVALID',
      'a custom role could not independently receive the mutation action class');

    const clone = actionsFor(principal('clone-agent', 'shadow-manager-clone', 'codex'));
    await assert.rejects(async () => clone.readReport({ rootId: 'main', relativePath: 'finding-REPORT.md' }), code('BRIDGE_ACTOR_REFUSED'));

    const lead = actionsFor(principal('lead-agent', 'dispatch-lead', 'claude'));
    await assert.rejects(async () => lead.queue({}), error => error?.code === 'BRIDGE_INPUT_INVALID',
      'a non-root custom role with mutation capability did not pass the role gate');

    const rootWithoutMutation = orgWith({
      controllerCapabilities: fields({ orgRoot: true, singleSeat: true, mayUseMissionBridge: true, mayReportMissionBridge: true })
    });
    const rootActions = mission.createMissionActions({
      ...baseOptions,
      agentOrg: rootWithoutMutation.org,
      knownRoles: rootWithoutMutation.knownRoles,
      principal: principal('root-agent', 'controller', 'codex')
    });
    await assert.rejects(async () => rootActions.queue({}), code('BRIDGE_ACTOR_REFUSED'),
      'orgRoot alone admitted a mission mutation');

    await assert.rejects(
      async () => mission.createMissionActions({ ...baseOptions, agentOrg: declared.org, knownRoles: declared.knownRoles }),
      code('BRIDGE_ACTOR_REFUSED'),
      'an anonymous caller inherited the organisation root'
    );
    await assert.rejects(
      async () => mission.createMissionActions({ ...baseOptions, agentOrg: declared.org, knownRoles: declared.knownRoles, actor: 'codex' }),
      code('BRIDGE_ACTOR_REFUSED'),
      'a provider label inherited an agent identity'
    );

    // Installed-mode actions re-read the role capabilities for every action.
    // Keep the org revision/assignment fixed and revoke only the role field.
    let current = orgWith();
    const live = mission.createMissionActions({
      ...baseOptions,
      principal: principal('lead-agent', 'dispatch-lead', 'claude'),
      readDeclaredOrgContext: () => current
    });
    await assert.rejects(async () => live.queue({}), error => error?.code === 'BRIDGE_INPUT_INVALID');
    current = orgWith({
      dispatchCapabilities: fields({ mayUseMissionBridge: true, mayReportMissionBridge: true })
    });
    await assert.rejects(async () => live.queue({}), code('BRIDGE_ACTOR_REFUSED'),
      'revoking a custom role capability did not affect the next action');
    assert.equal((await live.readReport({ rootId: 'main', relativePath: 'finding-REPORT.md' })).ok, true);

    assert.equal(mission.missionCapabilityForAction('report-read'), 'mayUseMissionBridge');
    assert.equal(mission.missionCapabilityForAction('thread-reply'), 'mayReportMissionBridge');
    assert.equal(mission.missionCapabilityForAction('dispatch'), 'mayMutateMissionBridge');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mission-bridge', 'actions.js'), 'utf8');
    assert.doesNotMatch(source, /roleId\s*={2,3}\s*['"]shadow-manager['"]/);
    assert.doesNotMatch(source, /declared\.role\s*={2,3}\s*['"]shadow-manager['"]/);
    process.stdout.write('role mission capability hostile oracle passed.\n');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
