'use strict';

// Exercise the registry dispatch boundary. The existing writer suite starts
// below it and cannot detect an authenticated session discarded here.
const isolated = require('./lib/isolated-environment').activate('build-queue-tool-context');
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const workspace = path.join(isolated.root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const seen = [];
const bridgePath = require.resolve('../src/lib/mission-bridge/actions');
require.cache[bridgePath] = {
  id: bridgePath, filename: bridgePath, loaded: true,
  exports: {
    createMissionActions(options) {
      return { async queue(input) { seen.push({ options, input }); return { ok: true }; } };
    }
  }
};
const { executeTool } = require('../src/lib/tool-registry');
const tools = ['build_queue.open', 'build_queue.claim', 'build_queue.close'];
const principal = Object.freeze({ kind: 'agent-session', sessionId: 'bound-session',
  agentId: 'controller', provider: 'codex', roleId: 'controller',
  expectedOrgRevision: 6, expectedRoleRevision: 0 });
const permissionSession = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
const context = { agentId: 'controller', agentSessionId: principal.sessionId, agentPrincipal: principal,
  agentRole: { functions: tools, requiresDirectUserAuthorization: false },
  permissionSession, workspaceRoots: [workspace] };
const argumentsByOperation = {
  open: { expectedHash: 'a'.repeat(64), title: 'Dispatch context regression',
    authority: 'R1 directiveId: isolated-regression', brief: 'No actual queue write in this dispatch-boundary test.' },
  claim: { expectedHash: 'b'.repeat(64), phaseId: 'Q1', reason: 'Isolated claim dispatch' },
  close: { expectedHash: 'c'.repeat(64), phaseId: 'Q1', reason: 'Isolated close dispatch' }
};

for (const operation of ['open', 'claim', 'close']) {
  test(`build_queue.${operation} retains the bound principal, permission ceiling and workspace`, async () => {
    seen.length = 0;
    await executeTool(`build_queue.${operation}`, argumentsByOperation[operation], context);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].options.principal, principal);
    assert.equal(seen[0].options.permissionSession, permissionSession);
    assert.deepEqual(seen[0].options.roots, { workspace });
    assert.equal(Object.hasOwn(seen[0].options, 'actor'), false);
    assert.deepEqual(seen[0].input, { rootId: 'workspace', operation, ...argumentsByOperation[operation] });
  });
}

test('queue arguments cannot replace the bound principal and a missing role still refuses', async () => {
  seen.length = 0;
  await assert.rejects(executeTool('build_queue.open', {
    ...argumentsByOperation.open, agentPrincipal: { ...principal, agentId: 'another-agent' }
  }, context), { code: 'INVALID_PARAMS' });
  const { agentRole, ...unbound } = context;
  await assert.rejects(executeTool('build_queue.open', argumentsByOperation.open, unbound), { code: 'ROLE_POLICY_REQUIRED' });
  assert.equal(seen.length, 0);
});
