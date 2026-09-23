'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const agentOrg = require('../src/lib/agent-org');
const { createAgentOrgStore } = require('../src/lib/agent-org-store');
const onboarding = require('../src/lib/agent-onboarding');

const baseline = {
  schemaVersion: 1, revision: 1,
  agents: [{ id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true }],
  relationships: []
};
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-role-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const baselineFile = path.join(directory, 'config', 'agent-org.json');
  const overlayFile = path.join(directory, 'org-overlay.json');
  fs.mkdirSync(path.dirname(baselineFile));
  fs.writeFileSync(baselineFile, JSON.stringify(baseline));
  const env = { LOCALAPPDATA: directory, TOOLSENABLED_STATE_ROOT: path.join(directory, 'Role fixture', 'capability') };
  const open = () => createAgentOrgStore({ baselineFile, overlayFile, env });
  const create = selection => open().ensureSeat({ id: 'tree-agent', nodeId: 'tree-agent', role: 'worker', provider: 'codex',
    ...(selection === undefined ? {} : { roleSelection: selection }) });
  return { directory, baselineFile, open, create };
}

test('only a tree-bound Worker may persist the exact empty selection', t => {
  const f = fixture(t);
  f.create('');
  const saved = f.open().read().org;
  const seat = saved.agents.find(agent => agent.id === 'tree-agent');
  assert.equal(seat.roleSelection, '');
  assert.equal(seat.role, 'worker');
  assert.equal(seat.nodeId, 'tree-agent');
  assert.equal(agentOrg.roleHasCapability(saved, seat.role, 'mayClaimWork'), true);
  assert.equal(f.open().exportOrg().agents.find(agent => agent.id === seat.id).roleSelection, '');
  for (const change of [{ role: 'manager' }, { nodeId: null }, ...[null, false, 'worker', ' '].map(roleSelection => ({ roleSelection }))]) {
    assert.throws(() => agentOrg.normalizeOrg({ ...baseline,
      agents: [...baseline.agents, { ...seat, ...change }] }, { maxAgents: 0 }), error => error.code === 'AGENT_ORG_INVALID');
  }
  assert.throws(() => f.open().ensureSeat({ id: seat.id, nodeId: 'different-node', role: 'worker', roleSelection: '' }),
    error => error.code === 'AGENT_ORG_STORE_INVALID');
});

test('legacy roles stay assigned and deliberate assignment clears the empty choice durably', t => {
  const f = fixture(t);
  f.create(undefined);
  assert.equal(Object.hasOwn(f.open().read().org.agents.find(agent => agent.id === 'tree-agent'), 'roleSelection'), false);
  f.create('');
  assert.equal(f.create('').unchanged, true);
  f.open().assignRole({ agentId: 'tree-agent', role: 'worker' });
  assert.equal(Object.hasOwn(f.open().read().org.agents.find(agent => agent.id === 'tree-agent'), 'roleSelection'), false);
  f.create('');
  f.open().assignRole({ agentId: 'tree-agent', role: 'manager' });
  const assigned = f.open().read().org.agents.find(agent => agent.id === 'tree-agent');
  assert.equal(assigned.role, 'manager');
  assert.equal(Object.hasOwn(assigned, 'roleSelection'), false);
});

test('explicit onboarding honors the stored blank choice and cannot suppress an assigned role from input alone', t => {
  const f = fixture(t);
  function packet(input = {}) {
    // Use the fresh persisted document as the fixture runtime's declared org.
    fs.writeFileSync(f.baselineFile, JSON.stringify(f.open().exportOrg()));
    return onboarding.buildPacket({ runtimeRoot: f.directory, projectRoot: f.directory,
      scope: 'task', agentId: 'tree-agent', identityBinding: 'launcher-bound', ...input }, {
      environment: {}, git: () => ({ status: 1, stdout: '', stderr: '' }),
      readClaims: () => [], orient: () => ({}), collectRecentWork: () => ({ events: [] }),
      listTools: () => [], capabilityFeatures: { describe: () => [], featureLine: () => '' }
    });
  }
  f.create('');
  assert.throws(() => packet(), error => error.code === 'AGENT_ONBOARDING_LIVE_CONTEXT_REQUIRED',
    'empty role prose must not relax the transport seat\'s mutation-context requirement');
  // A staged-payload fixture follows the existing installed-app context rule.
  fs.writeFileSync(path.join(f.directory, 'PAYLOAD.json'), '{"fixture":true}');
  for (const role of [undefined, '', 'worker']) {
    const actual = packet(role === undefined ? {} : { role });
    assert.equal(actual.session.role, '');
    assert.equal(actual.roleDefinition, null);
    assert.equal(actual.settings.enabledAssignments.find(agent => agent.id === 'tree-agent').role, '');
    assert.doesNotMatch(onboarding.renderPacket(actual), /Fixed role definition:.*Worker|focused assignment context/);
  }
  f.open().assignRole({ agentId: 'tree-agent', role: 'worker' });
  const assigned = packet({ role: '' });
  assert.equal(assigned.session.role, 'worker');
  assert.equal(assigned.roleDefinition.name, 'Worker');
});
