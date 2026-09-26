'use strict';

/* T1139 retained composition proof.
 *
 * This fixture deliberately lives with the Engine tests because the parent
 * composes it with the exact app checkout through IMAGE_APP_ROOT.  The app
 * checkout is never copied into this tree.  The settings document, Ledger
 * document and event journal all resolve below one retained temporary state
 * root, while sessions and the local message transport are inert test seams.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const ENGINE_ROOT = path.resolve(process.env.T1630_ENGINE_ROOT
  || process.env.TOOLSENABLED_TEST_ENGINE_ROOT
  || path.join(__dirname, '..'));
const appCandidates = [
  process.env.IMAGE_APP_ROOT,
  process.env.TOOLSENABLED_TEST_APP_ROOT,
  process.env.MC_CANONICAL_ROOT,
].filter(value => typeof value === 'string' && value.trim())
  .map(value => path.resolve(value));
const APP_ROOT = appCandidates.find(root =>
  fs.existsSync(path.join(root, 'shell', 'main.cjs'))
  && fs.existsSync(path.join(root, 'shell', 'task-assignment-target-authority.cjs')));
if (!APP_ROOT) {
  throw new Error('T1139 composition requires an explicit IMAGE_APP_ROOT app checkout.');
}
if (!fs.existsSync(path.join(ENGINE_ROOT, 'src', 'lib', 'owner-request-store.js'))) {
  throw new Error(`T1139 composition Engine root is not a checkout: ${ENGINE_ROOT}`);
}

const requireApp = require('node:module').createRequire(path.join(APP_ROOT, 'shell', 'main.cjs'));
const requireEngine = require('node:module').createRequire(path.join(ENGINE_ROOT, 'src', 'lib', 'owner-request-store.js'));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1139-task-assignment-composition-'));
const FIXTURE_PERMISSION_SESSION = Object.freeze({
  origin: 'local', tier: 'confined', profile: 'workspace',
});
const fixturePermissionOptions = Object.freeze({
  resolvePermissionSession: () => FIXTURE_PERMISSION_SESSION,
  resolveWorkspaceRoots: () => [fixtureRoot],
});
const stateRoot = path.join(fixtureRoot, 'state-root');
const settingsPath = path.join(fixtureRoot, 'settings.json');
const localAppData = path.join(fixtureRoot, 'localappdata');
const xdgDataHome = path.join(fixtureRoot, 'xdg-data');
fs.mkdirSync(stateRoot, { recursive: true });
fs.mkdirSync(localAppData, { recursive: true });
fs.mkdirSync(xdgDataHome, { recursive: true });
const priorStateRoot = process.env.TOOLSENABLED_STATE_ROOT;
const priorSettingsPath = process.env.TOOLSENABLED_SETTINGS_PATH;
const priorLocalAppData = process.env.LOCALAPPDATA;
const priorXdgDataHome = process.env.XDG_DATA_HOME;
process.env.TOOLSENABLED_STATE_ROOT = stateRoot;
process.env.TOOLSENABLED_SETTINGS_PATH = settingsPath;
process.env.LOCALAPPDATA = localAppData;
process.env.XDG_DATA_HOME = xdgDataHome;

const store = requireEngine(path.join(ENGINE_ROOT, 'src', 'lib', 'owner-request-store.js'));
const engineRegistry = requireEngine(path.join(ENGINE_ROOT, 'src', 'lib', 'tool-registry.js'));
const modelTiers = requireEngine(path.join(ENGINE_ROOT, 'src', 'lib', 'mission-bridge', 'actions.js')).TIERS;
const { createOwnerHost } = requireEngine(path.join(ENGINE_ROOT, 'src', 'owner-host.js'));
const mcp = requireEngine(path.join(ENGINE_ROOT, 'src', 'mcp-server.js'));
const { createLocalAgentMessageProvider } = requireEngine(path.join(ENGINE_ROOT, 'src', 'lib', 'providers', 'agent-comms-local.js'));
const { readAgentDelegationPolicy } = requireEngine(path.join(ENGINE_ROOT, 'src', 'lib', 'agent-delegation-policy.js'));
const { createTaskAssignmentAuthority } = requireApp(path.join(APP_ROOT, 'shell', 'task-assignment-target-authority.cjs'));
const productSettings = requireApp(path.join(APP_ROOT, 'shell', 'product-settings.cjs'));

const mainSource = fs.readFileSync(path.join(APP_ROOT, 'shell', 'main.cjs'), 'utf8');

function functionSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `production function interval exists: ${startMarker}`);
  return source.slice(start, end);
}

function extractMainFunction(startMarker, endMarker, context) {
  return vm.runInNewContext(`(${functionSource(mainSource, startMarker, endMarker)})`, context);
}

function settingsRead() {
  return productSettings.readProductSettings({ root: ENGINE_ROOT, load: requireEngine });
}

function setSettings(items) {
  const result = productSettings.setProductSettingsMany(items, { root: ENGINE_ROOT, load: requireEngine });
  assert.equal(result.ok, true, `settings write failed: ${JSON.stringify(result)}`);
  return result;
}

function responseResult(response, label) {
  assert.equal(response?.jsonrpc, '2.0', `${label} was not JSON-RPC: ${JSON.stringify(response)}`);
  assert.equal(response?.error, undefined, `${label} returned an error: ${JSON.stringify(response)}`);
  const content = response?.result;
  assert.ok(content && typeof content === 'object' && !Array.isArray(content),
    `${label} had no MCP result wrapper: ${JSON.stringify(response)}`);
  assert.equal(content.isError, undefined, `${label} returned a tool error: ${JSON.stringify(response)}`);
  assert.ok(content.structuredContent && typeof content.structuredContent === 'object'
    && !Array.isArray(content.structuredContent),
  `${label} had no structured result: ${JSON.stringify(response)}`);
  return content.structuredContent;
}

function assertFixturePath(value, label) {
  assert.equal(typeof value, 'string', `${label} did not resolve a path`);
  const relative = path.relative(fixtureRoot, path.resolve(value));
  assert.ok(relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)),
    `${label} escaped the retained fixture root: ${value}`);
}

function connect(host, sockets) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(host.pipeName);
    sockets.push(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    const waiting = [];
    const pending = new Set();
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const request = waiting.shift();
        if (!request) continue;
        pending.delete(request);
        clearTimeout(request.timer);
        try { request.answer(JSON.parse(line)); }
        catch (error) { request.fail(error); }
      }
    });
    const exchange = value => new Promise((answer, fail) => {
      const request = { answer, fail, timer: null };
      request.timer = setTimeout(() => {
        pending.delete(request);
        const index = waiting.indexOf(request);
        if (index >= 0) waiting.splice(index, 1);
        fail(new Error('T1139 composition owner-host response timeout'));
      }, 30000);
      pending.add(request);
      waiting.push(request);
      socket.write(`${JSON.stringify(value)}\n`);
    });
    exchange.cancelPending = reason => {
      const error = reason instanceof Error ? reason : new Error(String(reason || 'T1139 composition cancelled'));
      for (const request of [...pending]) {
        pending.delete(request);
        clearTimeout(request.timer);
        const index = waiting.indexOf(request);
        if (index >= 0) waiting.splice(index, 1);
        request.fail(error);
      }
    };
    socket.once('error', reject);
    resolve(exchange);
  });
}

test('settings, real host writer assignment, recipient checkpoint and message restoration compose', async t => {
  productSettings.resetForTests();

  const org = {
    ok: true,
    org: { revision: 7, agents: [
      { id: 'controller-seat', enabled: true, role: 'manager', provider: 'codex' },
      { id: 'worker-seat', enabled: true, role: 'worker', provider: 'codex' },
    ] },
    roles: [{ id: 'manager', revision: 1 }, { id: 'worker', revision: 1 }],
  };
  const agentSessions = new Map([
    ['controller-session', {
      state: 'ready', ended: false, closeRequested: false,
      agentId: 'controller-seat', agentAuthority: { roleId: 'manager' },
    }],
    ['worker-session', {
      state: 'ready', ended: false, closeRequested: false,
      agentId: 'worker-seat', agentAuthority: { roleId: 'worker' },
    }],
  ]);
  const agentHost = {
    readTreeParent(sessionId) {
      if (sessionId === 'controller-session') return {
        sessionId, agentId: 'controller-seat', nodeId: 'controller-node', treeId: 'root-node',
        treeAnchors: ['root-node', 'controller-node'], threadId: null,
      };
      if (sessionId === 'worker-session') return {
        sessionId, agentId: 'worker-seat', nodeId: 'worker-node', treeId: 'root-node',
        treeAnchors: ['root-node', 'controller-node', 'worker-node'], threadId: 'provider-thread',
        modelTier: 'terra',
      };
      return null;
    },
    sessionDeliverySettings(sessionId) {
      if (sessionId !== 'worker-session') return { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' };
      return { provider: 'codex', model: 'gpt-5.6-terra', effort: 'high' };
    },
  };
  const assignmentAuthorityFailure = (code, reason) => {
    throw Object.assign(new Error(reason), { code });
  };
  const readCoordinator = extractMainFunction(
    'function readTaskAssignmentCoordinator(',
    '\nfunction readTaskAssignmentSessions',
    {
      TASK_LEDGER_HOST_SESSION_ID: 'composition-host-session',
      assignmentAuthorityFailure,
      agentSessions,
      agentHost,
      agentOrgRecord: { read: () => org },
    },
  );
  const readSessions = extractMainFunction(
    'function readTaskAssignmentSessions(',
    '\nfunction readTaskAssignmentSettings',
    { Map, agentSessions, agentHost },
  );
  const initialSessions = readSessions();
  assert.ok(initialSessions instanceof Map,
    'the extracted session reader must use the host-realm Map');
  assert.equal(initialSessions.get('worker-session')?.treeNodeKey, 'worker-node',
    'the extracted session reader must retain the authenticated worker scope');
  const readProductSettings = () => settingsRead();
  const readAssignmentSettings = extractMainFunction(
    'function readTaskAssignmentSettings(',
    '\nfunction resolveTaskAssignmentConfiguration',
    { readProductSettings, assignmentAuthorityFailure },
  );
  const resolveTargetConfiguration = extractMainFunction(
    'function resolveTaskAssignmentConfiguration(',
    '\nfunction revokeTaskLedgerAssignmentCapability',
    { agentHost, assignmentAuthorityFailure },
  );
  const registerAssignmentWriter = extractMainFunction(
    'function registerTaskLedgerAssignmentWriter(',
    '\nfunction getTaskLedgerAssignmentWriter',
    { TASK_ASSIGNMENT_PRINCIPAL: 'task-assignment-service', assignmentAuthorityFailure },
  );

  const controller = {
    sessionId: 'controller-session', agentId: 'controller-seat', provider: 'codex',
    roleId: 'manager', expectedOrgRevision: 7, expectedRoleRevision: 1,
  };
  const readCurrentCoordinator = () => readCoordinator(controller);
  const makeAuthority = () => createTaskAssignmentAuthority({
    readOrg: () => org,
    readSessions,
    readCurrentCoordinator,
    readSettings: readAssignmentSettings,
    resolveTargetConfiguration: (session) => resolveTargetConfiguration(session),
  });

  let registered = null;
  let cachedIdentity = null;
  const resolveRegisteredWriter = principal => {
    const coordinatorIdentity = readCoordinator(principal);
    const identity = JSON.stringify(coordinatorIdentity);
    if (registered && cachedIdentity === identity) return registered.capability;
    const assignmentAuthority = makeAuthority();
    registered = registerAssignmentWriter({
      loaded: store,
      modelRegistry: engineRegistry,
      modelTiers,
      coordinatorIdentity,
      assignmentAuthority,
    });
    cachedIdentity = identity;
    return registered.capability;
  };
  const revokeRegistered = reason => {
    if (!registered?.registration || typeof store.revokeTaskLedgerWriter !== 'function') return;
    try { store.revokeTaskLedgerWriter(registered.registration, reason); } finally {
      registered = null;
      cachedIdentity = null;
    }
  };

  const sockets = [];
  const workerSockets = [];
  let host = null;
  let workerHost = null;
  let exchange = null;
  let workerExchange = null;
  t.after(async () => {
    exchange?.cancelPending?.(new Error('T1139 composition cleanup'));
    workerExchange?.cancelPending?.(new Error('T1139 worker composition cleanup'));
    for (const socket of sockets) socket.destroy();
    for (const socket of workerSockets) socket.destroy();
    try { await workerHost?.close?.(); } catch {}
    try { await host?.close?.(); } catch {}
    revokeRegistered('TEST_COMPLETE');
    try { await requireEngine(path.join(ENGINE_ROOT, 'src', 'lib', 'audit.js')).close(); } catch {}
    try { requireEngine(path.join(ENGINE_ROOT, 'src', 'lib', 'state-store.js')).closeStateStore(); } catch {}
    productSettings.resetForTests();
    if (priorStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
    else process.env.TOOLSENABLED_STATE_ROOT = priorStateRoot;
    if (priorSettingsPath === undefined) delete process.env.TOOLSENABLED_SETTINGS_PATH;
    else process.env.TOOLSENABLED_SETTINGS_PATH = priorSettingsPath;
    if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = priorLocalAppData;
    if (priorXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorXdgDataHome;
  });

  // Resolve every durable destination after cleanup is registered and before
  // the first write.  A failed path assertion must not leak the fixture env.
  const resolvedSettingsBeforeWrite = settingsRead();
  const resolvedLedgerPath = store.ledgerFileFor();
  const resolvedHistoryPath = store.historyFileFor();
  assert.equal(resolvedSettingsBeforeWrite.valuesPath, settingsPath,
    'the settings resolver uses the retained fixture override');
  assertFixturePath(resolvedSettingsBeforeWrite.valuesPath, 'settings values');
  assertFixturePath(resolvedLedgerPath, 'Ledger document');
  assertFixturePath(resolvedHistoryPath, 'Ledger history');
  assert.equal(resolvedLedgerPath, path.join(stateRoot, 'reports', 'OWNER-REQUEST-LEDGER.json'));
  assert.equal(resolvedHistoryPath, path.join(stateRoot, 'state', 'owner-request-record-events.jsonl'));

  // The first durable settings write is intentionally after cleanup and all
  // destination assertions so a failed fixture precondition cannot leak it.
  setSettings([
    { id: 'agent.task_difficulty_enabled', value: true },
    { id: 'agent.task_only_delegation', value: true },
    { id: 'agent.comms_enabled', value: true },
  ]);
  const settings = settingsRead();
  assert.equal(settings.available, true);
  const settingRows = new Map(settings.rows.filter(row => row.present === true).map(row => [row.id, row]));
  assert.equal(settingRows.get('agent.task_difficulty_enabled')?.value, true);
  assert.equal(settingRows.get('agent.task_only_delegation')?.value, true);
  assert.equal(settingRows.get('agent.comms_enabled')?.value, true);
  assert.equal(fs.existsSync(settings.valuesPath), true, 'the real settings document is retained in the fixture root');

  store.ensureLedger();
  host = createOwnerHost({
    ...fixturePermissionOptions,
    allowTestPaths: true,
    platform: 'test',
    pipeName: path.join(fixtureRoot, `owner-${crypto.randomUUID()}.sock`),
    capabilityFile: path.join(fixtureRoot, 'owner.json'),
    principals: { ownerPrincipal: 'TESTHOST\\composition', clientPrincipal: 'TESTHOST\\composition' },
    credentialHygiene: async () => {},
    readInstalledOrg: () => ({
      org: org.org,
      roles: org.roles,
      roleRecord: { definition: { id: 'manager' }, revision: 1 },
    }),
    resolveTaskLedgerWriter: resolveRegisteredWriter,
    broker: { ...mcp, createLineDispatcher: undefined },
    dispatchLine: (line, write, options) => mcp.processLine(line, write, options),
  });
  await host.listen();
  exchange = await connect(host, sockets);
  const bound = await host.bindSession(controller, {});
  assert.equal((await exchange({ type: 'authorize-session', credential: bound.credential })).type, 'authorized');

  const settingsResult = responseResult(await exchange({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'settings.read', arguments: {} },
  }), 'settings.read');
  assert.equal(settingsResult.values['agent.task_difficulty_enabled'], true);
  assert.equal(settingsResult.values['agent.task_only_delegation'], true);
  assert.equal(settingsResult.values['agent.comms_enabled'], true);

  const filed = responseResult(await exchange({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 't_ledger.file', arguments: {
      actor: 'codex', scope: 'global', words: 'Deliver the composed assignment checkpoint.', difficulty: 'medium',
    } },
  }), 't_ledger.file');
  assert.equal(filed.filed, true);
  assert.match(filed.id, /^T[1-9]\d*$/);

  const assigned = responseResult(await exchange({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 't_ledger.assign', arguments: {
      actor: 'codex', id: filed.id, nodeId: 'worker-node', assignmentId: 'assignment-composition-1',
      reason: 'Assign the durable task to the verified recipient.',
    } },
  }), 't_ledger.assign');
  assert.equal(assigned.assigned, true);
  assert.equal(assigned.replayed, false);
  assert.equal(assigned.target.targetAgentId, 'worker-node');
  assert.equal(assigned.target.agentId, 'worker-seat');
  assert.equal(assigned.target.scope, 'tree');
  assert.equal(assigned.target.scopeKey, 'worker-node');
  assert.equal(assigned.target.threadId, 'provider-thread');
  assert.equal(assigned.difficultyPlan.required, true);
  assert.equal(assigned.difficultyPlan.difficulty, 'medium');
  assert.equal(assigned.difficultyPlan.requiredStrength, 'standard');
  assert.equal(assigned.difficultyPlan.requiredEffort, 'high');
  assert.equal(typeof registered.capability.prepareTaskHandoff, 'undefined');

  workerHost = createOwnerHost({
    ...fixturePermissionOptions,
    allowTestPaths: true,
    platform: 'test',
    pipeName: path.join(fixtureRoot, `worker-${crypto.randomUUID()}.sock`),
    capabilityFile: path.join(fixtureRoot, 'worker.json'),
    principals: { ownerPrincipal: 'TESTHOST\\composition-worker', clientPrincipal: 'TESTHOST\\composition-worker' },
    credentialHygiene: async () => {},
    readInstalledOrg: () => ({
      org: org.org,
      roles: org.roles,
      roleRecord: { definition: { id: 'worker' }, revision: 1 },
    }),
    broker: { ...mcp, createLineDispatcher: undefined },
    dispatchLine: (line, write, options) => mcp.processLine(line, write, options),
  });
  await workerHost.listen();
  workerExchange = await connect(workerHost, workerSockets);
  const worker = {
    sessionId: 'worker-session', agentId: 'worker-seat', provider: 'codex',
    roleId: 'worker', expectedOrgRevision: 7, expectedRoleRevision: 1,
  };
  const workerBound = await workerHost.bindSession(worker, {});
  assert.equal((await workerExchange({ type: 'authorize-session', credential: workerBound.credential })).type, 'authorized');
  const checkpoint = responseResult(await workerExchange({
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 't_ledger.progress', arguments: {
      actor: 'codex', id: filed.id, status: 'in-progress',
      reason: 'Recipient accepted the assigned task and recorded a checkpoint.',
    } },
  }), 'recipient checkpoint');
  assert.equal(checkpoint.updated, true);
  assert.equal(checkpoint.status, 'in-progress');

  const persisted = store.readAll({ kinds: ['T'], includeRemoved: true, includeProposed: true });
  const record = persisted.records.find(row => row.id === filed.id);
  assert.ok(record, 'the assigned task is present in the retained Ledger document');
  assert.equal(record.ownerState, 'assigned');
  assert.equal(record.ownerNodeId, 'worker-node');
  assert.equal(record.scope, 'tree');
  assert.equal(record.scopeKey, 'worker-node');
  assert.equal(record.status, 'in-progress');
  assert.equal(record.decisions.some(row => row.decision === 'assign' && row.assignmentId === 'assignment-composition-1'), true);
  assert.equal(record.decisions.some(row => row.decision === 'progress' && row.status === 'in-progress'), true);
  assert.equal(store.verifyHistory().ok, true);
  const ledgerFile = store.ledgerFileFor();
  const historyFile = store.historyFileFor();
  assert.equal(fs.existsSync(ledgerFile), true, 'the real Ledger document is retained in the fixture root');
  assert.equal(fs.existsSync(historyFile), true, 'the real Ledger event journal is retained in the fixture root');
  assert.match(fs.readFileSync(historyFile, 'utf8'), /assignment-composition-1/);

  // No later operation needs the private writer. Revoke it before the
  // settings restoration writes the next durable document.
  revokeRegistered('TEST_SETTINGS_RESTORE');

  const directory = {
    listNodes: () => [],
    resolveDelivery: () => ({
      ok: true,
      sender: { agentId: 'controller-seat', nodeName: 'controller' },
      recipient: { agentId: 'worker-seat', nodeName: 'worker' },
      relation: 'child', recipientStopped: false,
    }),
    reachableFrom: () => [],
  };
  const provider = createLocalAgentMessageProvider({
    directory,
    readDelegationPolicy: readAgentDelegationPolicy,
    runtimeFactory: () => ({
      identity: agentId => ({ agentId }),
      fabric: {
        send: async () => ({
          accepted: true, code: 'BROKER_DELIVERED',
          message: { id: 'composition-message-1' }, stream: { sequence: 1 },
          broker: { delivered: true },
        }),
      },
    }),
  });
  await assert.rejects(
    () => provider.send({ from: 'controller', to: 'worker', body: 'direct message while task-only is enabled' }, {
      agentPrincipal: { sessionId: 'controller-session' },
    }),
    { code: 'AGENT_TASK_ONLY_DELEGATION' },
  );

  setSettings([
    { id: 'agent.task_only_delegation', value: false },
    { id: 'agent.comms_enabled', value: true },
  ]);
  const restored = readAssignmentSettings();
  assert.equal(restored.values['agent.task_only_delegation'], false);
  assert.equal(restored.values['agent.comms_enabled'], true);
  const delivered = await provider.send({ from: 'controller', to: 'worker', body: 'direct message after settings restoration' }, {
    agentPrincipal: { sessionId: 'controller-session' },
  });
  assert.equal(delivered.accepted, true);
  assert.equal(delivered.code, 'BROKER_DELIVERED');
});
