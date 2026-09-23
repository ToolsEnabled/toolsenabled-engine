'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('agent messaging tools are additive and use the declared effect classes', () => {
  const send = getTool('agent_comms.send');
  const read = getTool('agent_comms.read');
  const acknowledge = getTool('agent_comms.acknowledge');
  const legacyWrite = getTool('memory.set');

  assert.equal(send.effect, 'external-write');
  assert.equal(send.approvalEligible, false);
  assert.equal(send.annotations.openWorldHint, false);
  assert.equal(read.effect, 'external-read');
  assert.equal(read.annotations.openWorldHint, false);
  assert.equal(acknowledge.effect, 'local-write');
  assert.equal(legacyWrite.effect, 'local-write');
  assert.equal(typeof legacyWrite.handler, 'undefined');
  assert.equal(send.inputSchema.properties.sender, undefined);
});

const fs = require('node:fs');
const path = require('node:path');
const isolated = require('./lib/isolated-environment').activate('agent-delegation-policy');
const settings = require('../src/lib/settings');
const {
  TASK_ONLY_SETTING,
  COMMS_SETTING,
  resolveDelegationPolicy,
  readAgentDelegationPolicy,
  communicationDecision,
  assertAgentCommunicationAllowed
} = require('../src/lib/agent-delegation-policy');
const { createLocalAgentMessageProvider } = require('../src/lib/providers/agent-comms-local');
const { createAgentCommsProvider } = require('../src/lib/providers/agent-comms');
const { createTreeNodeDirectory } = require('../src/lib/agent-comms/tree-node-directory');
const { getTool, executeTool, registeredTools } = require('../src/lib/tool-registry');

const FULL_PERMISSION = Object.freeze({ origin: 'local', tier: 'full' });
let settingsRevision = 0;

function writeDelegationSettings(values, rejected = []) {
  const valuesPath = settings.resolveValuesPath();
  fs.mkdirSync(path.dirname(valuesPath), { recursive: true });
  fs.writeFileSync(valuesPath, JSON.stringify({
    revision: ++settingsRevision,
    values,
    provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user' }])),
    rejected
  }));
}

const policyCases = [
  {
    name: 'legacy defaults',
    values: {},
    policy: { taskOnly: false, commsEnabled: true },
    allowed: true,
    code: null
  },
  {
    name: 'direct comms enabled',
    values: { [TASK_ONLY_SETTING]: false, [COMMS_SETTING]: true },
    policy: { taskOnly: false, commsEnabled: true },
    allowed: true,
    code: null
  },
  {
    name: 'task-only delegation',
    values: { [TASK_ONLY_SETTING]: true, [COMMS_SETTING]: true },
    policy: { taskOnly: true, commsEnabled: true },
    allowed: false,
    code: 'AGENT_TASK_ONLY_DELEGATION'
  },
  {
    name: 'comms disabled',
    values: { [TASK_ONLY_SETTING]: false, [COMMS_SETTING]: false },
    policy: { taskOnly: false, commsEnabled: false },
    allowed: false,
    code: 'AGENT_COMMS_DISABLED'
  },
  {
    name: 'disabled takes precedence over task-only',
    values: { [TASK_ONLY_SETTING]: true, [COMMS_SETTING]: false },
    policy: { taskOnly: true, commsEnabled: false },
    allowed: false,
    code: 'AGENT_COMMS_DISABLED'
  }
];

test('delegation policy resolves legacy defaults and all four setting combinations', () => {
  for (const item of policyCases) {
    const policy = resolveDelegationPolicy({ values: item.values, rejected: [] });
    assert.deepEqual(policy, item.policy, item.name);
    assert.equal(Object.isFrozen(policy), true, item.name);
    const decision = communicationDecision(policy);
    assert.equal(decision.allowed, item.allowed, item.name);
    assert.equal(decision.code, item.code, item.name);
    assert.equal(Object.isFrozen(decision), true, item.name);
    if (item.allowed) {
      assert.deepEqual(assertAgentCommunicationAllowed(policy), decision, item.name);
    } else {
      assert.throws(() => assertAgentCommunicationAllowed(policy), { code: item.code });
    }
  }
});

test('delegation policy fails closed for malformed and rejected settings', () => {
  const badSnapshots = [
    null,
    { values: null, rejected: [] },
    { values: { [TASK_ONLY_SETTING]: 'yes' }, rejected: [] },
    { values: {}, rejected: [{ id: COMMS_SETTING }] },
    { values: {}, rejected: [null] },
    { values: {}, rejected: ['not-an-object'] },
    { values: {}, rejected: [{}] },
    { values: {}, rejected: 'not-an-array' }
  ];
  for (const snapshot of badSnapshots) {
    assert.throws(() => resolveDelegationPolicy(snapshot), {
      code: 'AGENT_DELEGATION_POLICY_UNAVAILABLE'
    });
  }
  assert.throws(
    () => communicationDecision({ taskOnly: 'false', commsEnabled: true }),
    { code: 'AGENT_DELEGATION_POLICY_UNAVAILABLE' }
  );
});

function localProviderHarness(policy) {
  const counts = {
    listNodes: 0,
    resolveDelivery: 0,
    reachableFrom: 0,
    runtimeFactory: 0,
    fabricSend: 0
  };
  const provider = createLocalAgentMessageProvider({
    readDelegationPolicy: () => policy,
    brokerFile: 'delegation-policy-local-test.json',
    directory: {
      listNodes() {
        counts.listNodes += 1;
        return [
          { agentId: 'sender-id', nodeName: 'Worker' },
          { agentId: 'recipient-id', nodeName: 'Manager' }
        ];
      },
      resolveDelivery() {
        counts.resolveDelivery += 1;
        return {
          ok: true,
          relation: 'peer',
          sender: { agentId: 'sender-id', nodeName: 'Worker' },
          recipient: { agentId: 'recipient-id', nodeName: 'Manager' },
          recipientStopped: false
        };
      },
      reachableFrom() {
        counts.reachableFrom += 1;
        return [];
      }
    },
    runtimeFactory() {
      counts.runtimeFactory += 1;
      return {
        identity(agentId) {
          return { agentId };
        },
        fabric: {
          async send() {
            counts.fabricSend += 1;
            return {
              accepted: true,
              code: 'BROKER_DELIVERED',
              message: { id: 'message-id' },
              stream: { sequence: 1 },
              broker: { delivered: true }
            };
          }
        }
      };
    }
  });
  return { provider, counts };
}

test('local provider refuses before directory, runtime, or fabric side effects and ignores caller policy overrides', async () => {
  for (const item of policyCases) {
    const harness = localProviderHarness(item.policy);
    const input = {
      from: 'Worker',
      to: 'Manager',
      body: 'policy boundary',
      readDelegationPolicy: () => ({ taskOnly: false, commsEnabled: true }),
      delegationPolicy: { taskOnly: false, commsEnabled: true }
    };
    const context = {
      readDelegationPolicy: () => ({ taskOnly: false, commsEnabled: true }),
      delegationPolicy: { taskOnly: false, commsEnabled: true }
    };
    if (item.allowed) {
      const result = await harness.provider.send(input, context);
      assert.equal(result.accepted, true, item.name);
      assert.equal(harness.counts.resolveDelivery, 1, item.name);
      assert.equal(harness.counts.runtimeFactory, 1, item.name);
      assert.equal(harness.counts.fabricSend, 1, item.name);
    } else {
      await assert.rejects(
        () => harness.provider.send(input, context),
        { code: item.code },
        item.name
      );
      assert.deepEqual(harness.counts, {
        listNodes: 0,
        resolveDelivery: 0,
        reachableFrom: 0,
        runtimeFactory: 0,
        fabricSend: 0
      }, item.name);
    }
  }
});

test('one local provider instance re-reads isolated settings across allow, deny, and restore', async () => {
  const counts = {
    listNodes: 0,
    resolveDelivery: 0,
    runtimeFactory: 0,
    fabricSend: 0
  };
  const provider = createLocalAgentMessageProvider({
    readDelegationPolicy: readAgentDelegationPolicy,
    brokerFile: path.join(isolated.root, 'delegation-freshness-local.broker.json'),
    directory: {
      listNodes() {
        counts.listNodes += 1;
        return [
          { agentId: 'fresh-sender-id', nodeName: 'Worker' },
          { agentId: 'fresh-recipient-id', nodeName: 'Manager' }
        ];
      },
      resolveDelivery() {
        counts.resolveDelivery += 1;
        return {
          ok: true,
          relation: 'peer',
          sender: { agentId: 'fresh-sender-id', nodeName: 'Worker' },
          recipient: { agentId: 'fresh-recipient-id', nodeName: 'Manager' },
          recipientStopped: false
        };
      },
      reachableFrom() {
        throw new Error('reachableFrom must not run for this direct delivery');
      }
    },
    runtimeFactory() {
      counts.runtimeFactory += 1;
      return {
        identity(agentId) {
          return { agentId };
        },
        fabric: {
          async send() {
            counts.fabricSend += 1;
            return {
              accepted: true,
              code: 'BROKER_DELIVERED',
              message: { id: 'fresh-message-id' },
              stream: { sequence: counts.fabricSend },
              broker: { delivered: true }
            };
          }
        }
      };
    }
  });
  const send = () => provider.send({
    from: 'Worker',
    to: 'Manager',
    body: 'freshness boundary'
  });

  writeDelegationSettings({ [TASK_ONLY_SETTING]: false, [COMMS_SETTING]: true });
  let result = await send();
  assert.equal(result.accepted, true, 'initial allowed send');
  const afterAllowed = { ...counts };

  writeDelegationSettings({ [TASK_ONLY_SETTING]: false, [COMMS_SETTING]: false });
  await assert.rejects(() => send(), { code: 'AGENT_COMMS_DISABLED' });
  assert.deepEqual(counts, afterAllowed, 'denied middle send does not touch directory or runtime');

  writeDelegationSettings({ [TASK_ONLY_SETTING]: false, [COMMS_SETTING]: true });
  result = await send();
  assert.equal(result.accepted, true, 'restored allowed send');
  assert.equal(counts.runtimeFactory, afterAllowed.runtimeFactory, 'same provider runtime remains reusable');
  assert.equal(counts.fabricSend, 2, 'restored send reaches the fake fabric');
});

test('cross-machine provider refuses before token, relay, or request preparation', async () => {
  for (const item of policyCases.filter(candidate => !candidate.allowed)) {
    let tokenLoads = 0;
    let requestCalls = 0;
    const provider = createAgentCommsProvider({
      readDelegationPolicy: () => item.policy,
      tokenLoader() {
        tokenLoads += 1;
        return 'test-token';
      },
      requestPort() {
        requestCalls += 1;
      }
    });
    await assert.rejects(
      () => provider.send({
        recipientActor: 'codex',
        recipientMachine: 'machine-for-policy-test',
        body: 'policy boundary',
        readDelegationPolicy: () => ({ taskOnly: false, commsEnabled: true }),
        delegationPolicy: { taskOnly: false, commsEnabled: true }
      }, {
        readDelegationPolicy: () => ({ taskOnly: false, commsEnabled: true }),
        delegationPolicy: { taskOnly: false, commsEnabled: true }
      }),
      { code: item.code },
      item.name
    );
    assert.equal(tokenLoads, 0, item.name);
    assert.equal(requestCalls, 0, item.name);
  }
});

function memoryStateStore() {
  const entries = new Map();
  return {
    getMemory({ namespace, key }) {
      const entry = entries.get(namespace + '\\0' + key);
      return entry ? JSON.parse(JSON.stringify(entry)) : null;
    },
    setMemory({ namespace, key, value, expectedRevision }) {
      const lookup = namespace + '\\0' + key;
      const prior = entries.get(lookup);
      const revision = prior ? prior.revision : 0;
      if (revision !== expectedRevision) {
        throw Object.assign(new Error('memory revision conflict'), { code: 'MEMORY_REVISION_CONFLICT' });
      }
      const entry = {
        namespace,
        key,
        value: JSON.parse(JSON.stringify(value)),
        revision: revision + 1
      };
      entries.set(lookup, entry);
      return { entry: JSON.parse(JSON.stringify(entry)), created: !prior, replayed: false };
    }
  };
}

test('cross-machine provider permits legacy and explicit direct-comms settings through configured fake transport', async () => {
  const registry = {
    schemaVersion: 1,
    machines: {
      'machine-a': { address: '203.0.113.2' },
      'machine-b': { address: '203.0.113.1' }
    },
    services: {}
  };
  for (const item of policyCases.filter(candidate => candidate.allowed)) {
    let requestCalls = 0;
    const provider = createAgentCommsProvider({
      readDelegationPolicy: () => item.policy,
      localMachine: { machineId: 'machine-a', address: '203.0.113.2' },
      serviceRegistryOptions: { registry },
      tokenLoader: () => 'test-link-bus-token-value-000000',
      stateStore: memoryStateStore(),
      stateFile: path.join(isolated.root, 'cross-positive-' + item.name.replace(/[^A-Za-z0-9]+/g, '-') + '.json'),
      requestPort: async descriptor => {
        requestCalls += 1;
        assert.equal(descriptor.method, 'POST', item.name);
        assert.equal(descriptor.path, '/v1/messages', item.name);
        return {
          statusCode: 200,
          body: JSON.stringify({ id: 'agent_comms_v1:1' })
        };
      }
    });
    const result = await provider.send({
      recipientActor: 'gemini',
      recipientMachine: 'machine-b',
      body: 'configured fake transport'
    }, { agentActor: 'codex' });
    assert.equal(result.accepted, true, item.name);
    assert.equal(requestCalls, 1, item.name);
  }
});

test('one cross-machine provider instance re-reads isolated settings across allow, deny, and restore', async () => {
  const registry = {
    schemaVersion: 1,
    machines: {
      'machine-a': { address: '203.0.113.2' },
      'machine-b': { address: '203.0.113.1' }
    },
    services: {}
  };
  let tokenLoads = 0;
  let requestCalls = 0;
  const provider = createAgentCommsProvider({
    readDelegationPolicy: readAgentDelegationPolicy,
    localMachine: { machineId: 'machine-a', address: '203.0.113.2' },
    serviceRegistryOptions: { registry },
    tokenLoader() {
      tokenLoads += 1;
      return 'test-link-bus-token-value-000000';
    },
    stateStore: memoryStateStore(),
    stateFile: path.join(isolated.root, 'delegation-freshness-cross.broker.json'),
    requestPort: async descriptor => {
      requestCalls += 1;
      assert.equal(descriptor.method, 'POST');
      assert.equal(descriptor.path, '/v1/messages');
      return {
        statusCode: 200,
        // A relay acknowledgement names the configured channel and its next
        // sequence; anything else leaves the stream blocked as uncertain.
        body: JSON.stringify({ id: 'agent_comms_v1:' + requestCalls })
      };
    }
  });
  let sendCount = 0;
  const send = () => provider.send({
    recipientActor: 'gemini',
    recipientMachine: 'machine-b',
    body: 'freshness boundary ' + (++sendCount)
  }, { agentActor: 'codex' });

  writeDelegationSettings({ [TASK_ONLY_SETTING]: false, [COMMS_SETTING]: true });
  let result = await send();
  assert.equal(result.accepted, true, 'initial allowed send');
  const afterAllowed = { tokenLoads, requestCalls };

  writeDelegationSettings({ [TASK_ONLY_SETTING]: false, [COMMS_SETTING]: false });
  await assert.rejects(() => send(), { code: 'AGENT_COMMS_DISABLED' });
  assert.deepEqual({ tokenLoads, requestCalls }, afterAllowed,
    'denied middle send does not load credentials or call relay');

  writeDelegationSettings({ [TASK_ONLY_SETTING]: false, [COMMS_SETTING]: true });
  result = await send();
  assert.equal(result.accepted, true, 'restored allowed send');
  assert.equal(tokenLoads, afterAllowed.tokenLoads, 'same provider relay remains reusable');
  assert.equal(requestCalls, 2, 'restored send reaches the fake relay');
});

let policyDirectoryRevision = 0;

function authorizationProviderHarness(policy) {
  const suffix = String(++policyDirectoryRevision);
  const file = path.join(isolated.root, 'delegation-authorization-' + suffix + '.json');
  const treeKey = 'delegation-tree-' + suffix;
  const managerSession = 'manager-' + suffix;
  const workerSession = 'worker-' + suffix;
  const outsiderSession = 'outsider-' + suffix;
  const directory = createTreeNodeDirectory({
    file,
    now: () => 1_900_000_000_000,
    liveWindowMs: 90_000
  });
  directory.registerNode({
    sessionId: managerSession,
    nodeName: 'Manager',
    treeKey
  });
  directory.registerNode({
    sessionId: workerSession,
    nodeName: 'Worker',
    managerSessionId: managerSession,
    managerName: 'Manager',
    treeKey
  });
  directory.registerNode({
    sessionId: outsiderSession,
    nodeName: 'Outsider',
    treeKey
  });
  return {
    workerSession,
    provider: createLocalAgentMessageProvider({
      directory,
      brokerFile: path.join(isolated.root, 'delegation-authorization-' + suffix + '.broker.json'),
      readDelegationPolicy: () => policy,
      runtimeFactory() {
        throw new Error('an unauthorized actor or target must be refused before runtime preparation');
      }
    })
  };
}

test('actor and target authorization stay independent across every delegation policy pair', async () => {
  for (const item of policyCases) {
    const harness = authorizationProviderHarness(item.policy);
    const unauthorizedActor = () => harness.provider.send(
      { from: 'Manager', to: 'Worker', body: 'actor boundary' },
      { agentSessionId: harness.workerSession }
    );
    const unauthorizedTarget = () => harness.provider.send(
      { from: 'Worker', to: 'Outsider', body: 'target boundary' },
      { agentSessionId: harness.workerSession }
    );

    if (item.allowed) {
      const actorResult = await unauthorizedActor();
      assert.equal(actorResult.accepted, false, item.name + ' actor');
      assert.equal(actorResult.code, 'TREE_SENDER_IDENTITY_MISMATCH', item.name + ' actor');
      const targetResult = await unauthorizedTarget();
      assert.equal(targetResult.accepted, false, item.name + ' target');
      assert.equal(targetResult.code, 'TREE_RECIPIENT_NOT_CONNECTED', item.name + ' target');
    } else {
      await assert.rejects(unauthorizedActor, { code: item.code }, item.name + ' actor');
      await assert.rejects(unauthorizedTarget, { code: item.code }, item.name + ' target');
    }

    const checkpointNames = new Set(registeredTools({
      agentRole: {
        functions: ['task.checkpoint'],
        requiresDirectUserAuthorization: false
      },
      permissionSession: FULL_PERMISSION
    }).map(tool => tool.name));
    assert.equal(checkpointNames.has('task.checkpoint'), true,
      item.name + ' keeps task checkpoint in an allowed role context');
  }
});

test('executeTool reads settings for send refusal while Ledger task tools remain independently usable', async () => {
  const sendArgs = { from: 'Worker', to: 'Manager', body: 'isolated policy boundary' };
  for (const item of policyCases.filter(candidate => !candidate.allowed)) {
    writeDelegationSettings(item.values);
    await assert.rejects(
      () => executeTool('agent_comms.send_local', sendArgs, {
        permissionSession: FULL_PERMISSION,
        delegationPolicy: { taskOnly: false, commsEnabled: true },
        readDelegationPolicy: () => ({ taskOnly: false, commsEnabled: true })
      }),
      { code: item.code },
      item.name
    );
  }

  const ledgerRole = Object.freeze({
    functions: ['t_ledger.file', 't_ledger.progress', 'ledger.read', 'task.checkpoint'],
    requiresDirectUserAuthorization: false
  });
  const ledgerContext = Object.freeze({
    permissionSession: FULL_PERMISSION,
    agentRole: ledgerRole
  });
  for (const item of policyCases) {
    writeDelegationSettings(item.values);
    const filed = await executeTool('t_ledger.file', {
      actor: 'codex',
      scope: 'thread',
      key: 't1180',
      words: 'T1180 isolated Ledger checkpoint coverage',
      why: 'Verify task tools remain outside the agent-comms policy gate.'
    }, ledgerContext);
    assert.equal(filed.filed, true, item.name);
    assert.match(filed.id, /^T[1-9][0-9]*$/, item.name);

    const progressed = await executeTool('t_ledger.progress', {
      actor: 'codex',
      id: filed.id,
      status: 'in-progress',
      reason: 'T1180 isolated progress readback.'
    }, ledgerContext);
    assert.equal(progressed.updated, true, item.name);
    assert.equal(progressed.id, filed.id, item.name);

    const readback = await executeTool('ledger.read', { id: filed.id }, ledgerContext);
    assert.equal(readback.exists, true, item.name);
    assert.ok(readback.records.some(record =>
      record.id === filed.id && record.status === 'in-progress'
    ), item.name + ' Ledger readback');
  }

  writeDelegationSettings({});
  for (const name of [
    'task.submit',
    'task.checkpoint',
    'task.complete',
    'task.fail',
    'task.get',
    'task.list'
  ]) {
    assert.ok(getTool(name), name + ' remains registered');
  }
  const ledgerArgs = {
    actor: 'codex',
    scope: 'thread',
    key: 't1180-permission',
    words: 'permission-boundary Ledger task',
    why: 'Verify a missing session is refused.'
  };
  await assert.rejects(
    () => executeTool('t_ledger.file', ledgerArgs, { agentRole: ledgerRole }),
    { code: 'PERMISSION_SESSION_REQUIRED' }
  );
  await assert.rejects(
    () => executeTool('t_ledger.file', ledgerArgs, {
      permissionSession: FULL_PERMISSION,
      agentRole: { functions: ['task.checkpoint'], requiresDirectUserAuthorization: false }
    }),
    { code: 'TOOL_NOT_ENABLED' }
  );
  await assert.rejects(
    () => executeTool('task.checkpoint', {}, {}),
    { code: 'PERMISSION_SESSION_REQUIRED' }
  );
  // The full permission context is intentionally not used to assign a task;
  // the assignment API is still pending its store/host/grading contract.
  assert.ok(isolated.root);
});
