'use strict';
require('./lib/isolated-environment').activate('mission-action-admission');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

let auditGate = null;
let enteredAudit = null;
const auditPath = require.resolve('../src/lib/coordinator-audit-events');
const coordinatorAudit = require(auditPath);
require.cache[auditPath].exports = { ...coordinatorAudit,
  writeAsync: async () => { if (auditGate) { enteredAudit?.(); await auditGate; } return { durable: true }; },
  write: () => ({ durable: true }),
};
const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { getStateStore, closeStateStore } = require('../src/lib/state-store');
test.after(() => closeStateStore());

for (const change of ['unchanged', 'disabled', 'provider-reassigned', 'kill-switch']) {
  test(`real bridge task admission after an audit wait: ${change}`, async t => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'te-action-admission-'));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    let org = declaredOrg();
    const agent = org.agents.find(row => row.id === enabledControllerId(org));
    const principal = { kind: 'agent-session', sessionId: `fixture-${change}`, agentId: agent.id,
      provider: agent.provider, roleId: agent.role, expectedOrgRevision: org.revision, expectedRoleRevision: 1 };
    let stopped = false;
    const actions = createMissionActions({ roots: { fixture: scratch }, principal,
      permissionSession: { origin: 'local', tier: 'full' },
      // This is the installed-store seam, not an explicit immutable agentOrg.
      // All action/registry guards and the SQLite task effect are production code.
      readDeclaredOrgContext: () => ({ org }),
      policy: { assertActive() { if (stopped) throw new Error('Fixture kill switch is active.'); } },
    });
    const input = { queue: `fixture-${change}`, type: 'fixture', idempotencyKey: 'fixture-one',
      payload: { title: 'Synthetic task', objective: 'No worker is started.' }, expiryPolicy: 'uncertain', maxAttempts: 1 };
    let release;
    auditGate = new Promise(resolve => { release = resolve; });
    const admitted = new Promise(resolve => { enteredAudit = resolve; });
    const pending = actions.taskSubmit(input);
    pending.catch(() => {});
    await Promise.race([admitted, pending.then(() => { throw new Error('Audit gate was not reached.'); })]);
    if (change === 'disabled' || change === 'provider-reassigned') {
      org = { ...org, revision: org.revision + 1, agents: org.agents.map(row => row.id !== agent.id ? row
        : { ...row, ...(change === 'disabled' ? { enabled: false } : { provider: agent.provider === 'codex' ? 'claude' : 'codex' }) }) };
    } else if (change === 'kill-switch') stopped = true;
    release();
    try {
      if (change === 'unchanged') assert.equal((await pending).ok, true);
      else await assert.rejects(pending, error => ['BRIDGE_ACTOR_REFUSED', 'BRIDGE_GUARD_REFUSED'].includes(error.code));
    } finally { auditGate = null; enteredAudit = null; }
    const tasks = getStateStore().listTasks({ queue: input.queue });
    assert.equal(tasks.length, change === 'unchanged' ? 1 : 0, 'retired authority must not create a durable task');
  });
}
