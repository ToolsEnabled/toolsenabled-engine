'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const host = require('../src/owner-host');
const credentials = require('../src/lib/agent-session-credential');

const token = crypto.randomBytes(32);
const binding = {
  sessionId: 'local-test-session', agentId: 'local-test-agent', provider: 'local',
  roleId: 'coordinator-assistant', expectedOrgRevision: 4, expectedRoleRevision: 0
};
const packet = { type: 'bind-session', token: token.toString('base64url'), ...binding };
const parsed = host.validBindSession(packet, token);
assert.ok(parsed, 'A local provider must reach the same exact session-binding validation');
assert.equal(parsed.principal.agentActor, 'local', 'Never impersonate a cloud provider');
assert.deepEqual(credentials.validateBinding(binding, { requireCredential: false }), binding);
for (const change of [
  { provider: 'owner' }, { provider: 'unknown' }, { provider: '' },
  { expectedRoleRevision: -1 }, { expectedOrgRevision: '4' },
  { agentId: '../other' }, { extra: true }, { token: crypto.randomBytes(32).toString('base64url') }
]) assert.equal(host.validBindSession({ ...packet, ...change }, token), null);

const principal = parsed.principal;
const snapshot = {
  org: { revision: 4, agents: [{ id: binding.agentId, role: binding.roleId, provider: 'local', enabled: true }] },
  roleRecord: { definition: { id: binding.roleId }, revision: 0 }
};
const options = { readInstalledOrg: () => snapshot };
assert.equal(host.authorizeDeclaredAgentBinding(principal, options, { fresh: true }), true);
snapshot.org.agents[0].provider = 'claude';
assert.equal(host.authorizeDeclaredAgentBinding(principal, options, { fresh: true }), false);
snapshot.org.agents[0].provider = 'local';
snapshot.org.agents[0].enabled = false;
assert.equal(host.authorizeDeclaredAgentBinding(principal, options), false);
snapshot.org.agents[0].enabled = true;
snapshot.org.agents[0].role = 'controller';
assert.equal(host.authorizeDeclaredAgentBinding(principal, options), false);
snapshot.org.agents[0].role = binding.roleId;
// A moved ROLE revision is a rebind, not a revocation, on a running line
// (2026-09-19: six controller/manager sessions retired per-line-recheck after
// a Role library save); it still refuses a NEW bind from a stale screen.
snapshot.roleRecord.revision = 1;
assert.equal(host.authorizeDeclaredAgentBinding(principal, options), true);
assert.equal(host.authorizeDeclaredAgentBinding(principal, options, { fresh: true }), false);
snapshot.roleRecord.revision = 0;
snapshot.org.revision = 5;
assert.equal(host.authorizeDeclaredAgentBinding(principal, options, { fresh: true }), false);
assert.equal(host.authorizeDeclaredAgentBinding(principal, options, { fresh: false }), true);
console.log('local owner session binding: exact provider, identity, role, revisions and revocation checks passed');
