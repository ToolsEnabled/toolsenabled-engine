'use strict';

require('./helpers/isolated-state-root');

/* T1139 B6 RED-first coverage.  The store transaction itself belongs to B9;
 * these tests pin the private writer capability and the role-function
 * gate (T1736) that must feed it.  No provider, app profile or live agent is used. */

const assert = require('node:assert/strict');
const test = require('node:test');
const store = require('../src/lib/owner-request-store');
const { MinorLedgerAgentControl } = require('../src/lib/minor-ledger-agent-gate');
const { getTool, executeTool } = require('../src/lib/tool-registry');
const roleFunctions = require('../src/lib/role-functions');
const { createStateStore } = require('../src/lib/state-store');
const { createCustomRoleStore } = require('../src/lib/custom-role-store');

const COORDINATOR = Object.freeze({
  actor: 'agent', nodeId: 'controller-node', hostSessionId: 'host-session', orgRevision: 7,
});

function assignmentAuthority() {
  return {
    resolveAssignmentAuthority: () => ({
      taskId: 'T1', assignmentId: 'assignment-1', targetAgentId: 'worker-node',
      target: { nodeId: 'worker-node', targetAgentId: 'worker-node', scope: 'tree', scopeKey: 'worker-node', ownerNodeId: 'worker-node', sessionId: 'worker-session', treeId: 'root-node', threadId: null },
      locality: { sameHost: true, sameTree: true },
      targetConfiguration: { tier: 'luna', provider: 'codex', model: 'gpt-test', effort: 'low' },
      authorityRevision: 7,
      authorityReceipt: {
        kind: 'task-assignment-authority', taskId: 'T1', assignmentId: 'assignment-1',
        targetAgentId: 'worker-node', scope: 'tree', scopeKey: 'worker-node', ownerNodeId: 'worker-node',
        sessionId: 'worker-session', treeId: 'root-node', orgRevision: 7,
      },
      assertCurrent() {},
    }),
    assertCurrent() {},
    readSettings: () => Object.freeze({
      values: Object.freeze({ 'agent.task_difficulty_enabled': true }),
      rejected: Object.freeze([]), revision: 7,
    }),
  };
}

function writerRegistration(extra = {}) {
  return store.registerTaskLedgerWriter({
    principal: 'task-assignment-service',
    options: { taskLedgerOptions: {
      coordinatorIdentity: COORDINATOR,
      assignmentAuthority: assignmentAuthority(),
    } },
    capability: 'task-assignment',
    ...extra,
  });
}

test('task assignment registration is distinct from native-removal writer capability', () => {
  const registration = writerRegistration();
  const writer = store.taskLedgerWriter(registration);
  assert.equal(typeof writer.assignTask, 'function');
  assert.equal(Object.hasOwn(writer, 'prepareTaskHandoff'), false);
  assert.equal(Object.hasOwn(writer, 'commitTaskOwnerGoneCleanup'), false);

  assert.throws(() => store.registerTaskLedgerWriter({
    principal: 'task-assignment-service',
    capability: 'task-assignment',
    options: { taskLedgerOptions: { assignmentAuthority: assignmentAuthority() } },
  }), { code: 'T_LEDGER_WRITER_POLICY_DENIED' });
  assert.throws(() => store.registerTaskLedgerWriter({
    principal: 'task-assignment-service',
    capability: 'task-assignment',
    options: { taskLedgerOptions: { coordinatorIdentity: COORDINATOR } },
  }), { code: 'T_LEDGER_WRITER_POLICY_DENIED' });
});

test('native-removal writer never receives an assignment method', () => {
  const registration = store.registerTaskLedgerWriter({
    options: { taskLedgerOptions: { coordinatorIdentity: COORDINATOR } },
    principal: 'native-removal-service',
    resolveAuthority: () => ({ kind: 'verified-no-parent', principal: 'native-removal-service' }),
  });
  const writer = store.taskLedgerWriter(registration);
  assert.equal(Object.hasOwn(writer, 'assignTask'), false);
});

test('assignment writer refuses after lifecycle revoke before attempting a transaction', () => {
  const registration = writerRegistration();
  const writer = store.taskLedgerWriter(registration);
  store.revokeTaskLedgerWriter(registration, 'LIFECYCLE');
  assert.throws(() => writer.assignTask({
    id: 'T1', nodeId: 'worker-node', assignmentId: 'assignment-1',
    reason: 'Assign the existing task to the verified child.', actor: 'codex',
  }), { code: 'T_LEDGER_WRITER_POLICY_DENIED' });
});

test('assignment gate forwards the exact existing-T request and validates the bound receipt', () => {
  const calls = [];
  const fakeStore = {
    KIND_ID_RE: store.KIND_ID_RE,
    OwnerRequestStoreError: class OwnerRequestStoreError extends Error {
      constructor(code, message) { super(message); this.code = code; }
    },
    assignTask(input, options) {
      calls.push({ input, options });
      return Object.freeze({
        assigned: true, id: input.id, assignmentId: input.assignmentId,
        target: { targetAgentId: 'worker-node', nodeId: input.nodeId, scope: 'tree', scopeKey: input.nodeId, ownerNodeId: input.nodeId, sessionId: 'worker-session' },
        targetConfiguration: { tier: 'luna', provider: 'codex', model: 'gpt-test', effort: 'low' },
        difficulty: 'easy', difficultyPlan: { required: true, difficulty: 'easy' },
        revision: 12, recordedAt: '2026-09-23T00:00:00.000Z',
        receipt: { kind: 'task-assignment-authority', assignmentId: input.assignmentId, authorityRevision: 7, scope: 'tree', scopeKey: input.nodeId, ownerNodeId: input.nodeId },
        replayed: false,
      });
    },
  };
  const control = new MinorLedgerAgentControl({
    store: fakeStore,
    ledgerOptions: { rootPath: () => '/inert' },
    auditRequire: () => ({ durable: true }),
    loadSettings: () => ({ values: {} }),
  });
  const result = control.assign({
    actor: 'codex', id: 'T1', nodeId: 'worker-node', assignmentId: 'assignment-1',
    reason: 'Assign the existing task to the verified child.',
  }, { taskLedgerWriter: { assignTask(input) { return fakeStore.assignTask(input, control.ledgerOptions) } } });
  assert.equal(result.assigned, true);
  assert.equal(result.id, 'T1');
  assert.equal(result.assignmentId, 'assignment-1');
  assert.deepEqual(calls[0].input, {
    id: 'T1', nodeId: 'worker-node', assignmentId: 'assignment-1',
    reason: 'Assign the existing task to the verified child.', actor: 'codex',
  });
  assert.equal(calls[0].options, control.ledgerOptions);
});

test('assignment is an actual registered role tool gated by the role function, not the role name', async t => {
  // The registered entry is unchanged; it is simply no longer part of the
  // normal installed surface (T1736): a role must be given it.
  const entry = getTool('t_ledger.assign', { agentRole: { functions: ['t_ledger.assign'] } });
  assert.equal(entry.effect, 'local-write');
  assert.equal(entry.annotations.idempotentHint, true);
  assert.equal(getTool('t_ledger.assign'), null, 'the normal installed surface does not include task hand-out');
  const catalogRow = roleFunctions.functionCatalog().find(item => item.id === 't_ledger.assign');
  assert.equal(catalogRow.defaultEnabled, false, 'the Role library shows hand-out as an explicit grant');

  const stateStore = createStateStore({ file: ':memory:' });
  t.after(() => stateStore.close());
  const roles = createCustomRoleStore({ stateStore });
  const writes = [];
  const writer = { assignTask(input) {
    writes.push(input);
    return Object.freeze({ assigned: true, id: input.id, assignmentId: input.assignmentId, replayed: false,
      revision: 12, recordedAt: '2026-09-23T00:00:00.000Z',
      receipt: { kind: 'task-assignment-authority', assignmentId: input.assignmentId, targetAgentId: input.nodeId } });
  } };
  const principal = roleId => ({ agentId: roleId + '-node', roleId, sessionId: roleId + '-session' });
  const call = (agentRole, who, { withWriter = true } = {}) => executeTool('t_ledger.assign', {
    actor: 'codex', id: 'T1', nodeId: 'child-node', assignmentId: 'assignment-1', reason: 'role function gate',
  }, {
    permissionSession: { origin: 'local', tier: 'full' },
    agentActor: 'codex',
    ...(agentRole === undefined ? {} : { agentRole }),
    ...(who === undefined ? {} : { agentPrincipal: who }),
    ...(withWriter ? { taskLedgerWriter: writer } : {}),
  });

  // Every parent that manages workers in a real tree is a Builder. The shipped
  // Controller, Manager and Builder function lists hold hand-out, so each one
  // reaches the private writer, which binds the target to the caller's own
  // live descendants.
  for (const roleId of ['controller', 'manager', 'builder']) {
    const result = await call(roles.getRole(roleId), principal(roleId));
    assert.equal(result.assigned, true, roleId);
    assert.equal(result.id, 'T1', roleId);
  }
  assert.deepEqual(writes.map(row => row.nodeId), ['child-node', 'child-node', 'child-node']);
  // Without the private writer the same granted call is still refused by the
  // writer check, never admitted by a role name.
  for (const roleId of ['controller', 'manager', 'builder']) {
    await assert.rejects(() => call(roles.getRole(roleId), principal(roleId), { withWriter: false }),
      { code: 'R_LEDGER_ASSIGNMENT_UNAVAILABLE' }, roleId);
  }

  // A Worker's default (the normal installed surface) does not include it.
  assert.equal(roles.getRole('worker').functions, null);
  await assert.rejects(() => call(roles.getRole('worker'), principal('worker')), { code: 'TOOL_NOT_ENABLED' });
  await assert.rejects(() => call({ functions: null, requiresDirectUserAuthorization: false }, principal('builder')),
    { code: 'TOOL_NOT_ENABLED' });
  // Any role the person gives the function may hand out, whatever its name.
  const rules = { owns: 'Keep my directions.', mustNot: 'Do not widen grants.', handoff: 'Report back.' };
  const scribe = roles.createCustomRole({ id: 'release-scribe', baseDefaultRole: 'worker', rules,
    functions: ['t_ledger.assign', 't_ledger.progress'] }).definition;
  const scribeResult = await call(scribe, principal('release-scribe'));
  assert.equal(scribeResult.assigned, true);
  const grantedWorker = roles.editDefaultRole({ id: 'worker', rules, expectedRevision: 0,
    functions: ['t_ledger.assign', 't_ledger.progress'] }).definition;
  assert.equal((await call(grantedWorker, principal('worker'))).assigned, true);
  // A role whose saved function list omits it cannot assign, whatever its name.
  const withheld = { functions: ['t_ledger.file', 't_ledger.progress'], requiresDirectUserAuthorization: false };
  for (const roleId of ['controller', 'manager', 'builder']) {
    await assert.rejects(() => call(withheld, principal(roleId)), { code: 'TOOL_NOT_ENABLED' }, roleId);
  }
  // Assignment is still an agent-session act: no authenticated role, no hand-out.
  const granted = { functions: ['t_ledger.assign'], requiresDirectUserAuthorization: false };
  await assert.rejects(() => call(granted, undefined), { code: 'AGENT_ASSIGNMENT_ROLE_REQUIRED' });
  await assert.rejects(() => call(granted, { agentId: 'node', roleId: '', sessionId: 'session' }), { code: 'AGENT_ASSIGNMENT_ROLE_REQUIRED' });
  await assert.rejects(() => call(undefined, undefined), { code: 'TOOL_NOT_ENABLED' });
  assert.equal(writes.length, 5, 'only the five granted, authenticated calls reached the writer');
});

test('at the Standard level the generated server still offers hand-out to a role that holds it', () => {
  // App-launched agents reach their tools through the MCP server entry setup
  // generates, which the recorded level narrows with TOOLSENABLED_TOOL_ALLOWLIST
  // (generateMcpConfig's tierTools). The level bounds what that server may offer
  // EVERY session; which of those tools a session's role receives is decided per
  // session by its role functions. So the server's list must still carry
  // t_ledger.assign, or no role at that level could ever be given it, whatever
  // its saved function list says.
  const machineRecord = require('../src/lib/setup/machine-record');
  const permissionTierPolicy = require('../src/lib/permission-tier-policy');
  const { TOOL_ALLOWLIST_ENV } = require('../src/lib/tool-registry');
  const server = machineRecord.tierServerAllowlist('standard');
  assert.ok(server.includes('t_ledger.assign'), 'the Standard server allowlist withholds task hand-out from every role');
  assert.ok(!machineRecord.tierServerAllowlist('guided').includes('t_ledger.assign'), 'Guided stays read-only');
  // The role-less default surface (what the tool note describes) still does not list it.
  assert.ok(!machineRecord.tierToolAllowlist('standard').includes('t_ledger.assign'));
  const saved = process.env[TOOL_ALLOWLIST_ENV];
  process.env[TOOL_ALLOWLIST_ENV] = server.join(',');
  try {
    const session = permissionTierPolicy.installTierSession('standard');
    const granted = { functions: ['t_ledger.assign', 't_ledger.progress'], requiresDirectUserAuthorization: false };
    assert.ok(getTool('t_ledger.assign', { agentRole: granted, permissionSession: session }),
      'a role that holds hand-out is offered it by the Standard server');
    // The role-less default, a null policy and a role that withholds it still do not get it.
    assert.equal(getTool('t_ledger.assign', { permissionSession: session }), null);
    assert.equal(getTool('t_ledger.assign', { agentRole: { functions: null }, permissionSession: session }), null);
    assert.equal(getTool('t_ledger.assign', { agentRole: { functions: ['t_ledger.progress'] }, permissionSession: session }), null);
  } finally {
    if (saved === undefined) delete process.env[TOOL_ALLOWLIST_ENV];
    else process.env[TOOL_ALLOWLIST_ENV] = saved;
  }
});
