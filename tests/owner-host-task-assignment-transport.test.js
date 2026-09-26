'use strict';

/* T1139 inert transport proof.  The writer is a private in-process callback;
 * only the real owner-host socket path can put it into executeTool context.
 * No store transaction, profile, renderer token or live agent is used here. */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { activate } = require('./lib/isolated-environment');
const isolated = activate('owner-host-task-assignment');
const { createOwnerHost } = require('../src/owner-host');
const mcp = require('../src/mcp-server');
const FIXTURE_PERMISSION_SESSION = Object.freeze({
  origin: 'local', tier: 'confined', profile: 'workspace',
});
const fixturePermissionOptions = Object.freeze({
  resolvePermissionSession: () => FIXTURE_PERMISSION_SESSION,
  resolveWorkspaceRoots: () => [isolated.root],
});

function receipt(input) {
  return Object.freeze({
    assigned: true,
    id: input.id,
    assignmentId: input.assignmentId,
    target: {
      targetAgentId: 'worker-node', nodeId: input.nodeId,
      scope: 'tree', scopeKey: input.nodeId, ownerNodeId: input.nodeId,
      sessionId: 'worker-session', threadId: 'worker-thread', treeId: 'root-node',
    },
    targetConfiguration: { tier: 'luna', provider: 'codex', model: 'gpt-test', effort: 'low' },
    difficulty: 'easy',
    difficultyPlan: { required: true, difficulty: 'easy' },
    revision: 1,
    recordedAt: '2026-09-23T00:00:00.000Z',
    receipt: {
      kind: 'task-assignment-authority', assignmentId: input.assignmentId,
      targetAgentId: 'worker-node', scope: 'tree', scopeKey: input.nodeId,
      ownerNodeId: input.nodeId, sessionId: 'worker-session', threadId: 'worker-thread',
      authorityRevision: 1,
    },
    replayed: false,
  });
}

// Node's local IPC is a named pipe on Windows (\\.\pipe\...) and a socket
// file elsewhere; a socket-file path is refused on Windows (listen EACCES).
// Same form as the other owner-host suites (e.g. owner-host-tool-mode).
function localPipeName(prefix) {
  const id = `${prefix}-${crypto.randomUUID()}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(isolated.root, `${id}.sock`);
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
        request.answer(JSON.parse(line));
      }
    });
    const exchange = value => new Promise((answer, fail) => {
      const request = { answer, fail, timer: null };
      request.timer = setTimeout(() => {
        pending.delete(request);
        const index = waiting.indexOf(request);
        if (index >= 0) waiting.splice(index, 1);
        fail(new Error('owner-host transport response timeout'));
      }, 30000);
      pending.add(request);
      waiting.push(request);
      socket.write(`${JSON.stringify(value)}\n`);
    });
    exchange.cancelPending = reason => {
      const error = reason instanceof Error ? reason : new Error(String(reason || 'owner-host transport cancelled'));
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

function boundedJson(value) {
  let text;
  try { text = JSON.stringify(value); } catch { text = '<unserializable response>'; }
  return text.length > 4000 ? `${text.slice(0, 4000)}...<truncated>` : text;
}

function assertAssignmentRefused(response) {
  const body = boundedJson(response);
  assert.equal(response?.jsonrpc, '2.0', `assignment response was not JSON-RPC: ${body}`);
  if (response?.error) {
    const namedRefusal = response.error.code === -32600
      && response.error.data?.code === 'R_LEDGER_ASSIGNMENT_UNAVAILABLE';
    assert.ok(namedRefusal, `unexpected assignment error envelope: ${body}`);
    return;
  }
  assert.equal(response?.result?.isError, true, `assignment unexpectedly succeeded or returned no result error: ${body}`);
  assert.equal(response.result?.structuredContent?.error?.code, 'R_LEDGER_ASSIGNMENT_UNAVAILABLE',
    `unexpected assignment tool refusal: ${body}`);
}

test('assignment callback is lazy, private and rechecked for queued dispatch', async t => {
  const principals = {
    sessionId: 'controller-session', agentId: 'controller-node', provider: 'codex',
    roleId: 'controller', expectedOrgRevision: 1, expectedRoleRevision: 1,
  };
  let currentRevision = 1;
  let initialAdmissionWriter = null;
  let queuedDispatchWriter = null;
  let assignmentLookupCount = 0;
  let queuedDispatchLookup = false;
  let assignmentAdmissionResolve;
  const assignmentAdmission = new Promise(resolve => { assignmentAdmissionResolve = resolve });
  let ordinaryDispatchResolve;
  const ordinaryDispatchEntered = new Promise(resolve => { ordinaryDispatchResolve = resolve });
  let releaseOrdinaryResolve = () => {};
  const releaseOrdinary = new Promise(resolve => { releaseOrdinaryResolve = resolve });
  let writerCalls = 0;
  const writer = { assignTask: input => {
    writerCalls += 1;
    if (currentRevision !== 1) throw Object.assign(new Error('assignment identity changed'), { code: 'T_LEDGER_WRITER_POLICY_DENIED' });
    return receipt(input);
  } };
  const host = createOwnerHost({
    ...fixturePermissionOptions,
    allowTestPaths: true,
    platform: 'test',
    pipeName: localPipeName('assignment'),
    capabilityFile: path.join(isolated.root, 'owner.json'),
    principals: { ownerPrincipal: 'TESTHOST\\assignment', clientPrincipal: 'TESTHOST\\assignment' },
    credentialHygiene: async () => {},
    readInstalledOrg: () => ({
      org: { revision: 1, agents: [{ id: 'controller-node', role: 'controller', provider: 'codex', enabled: true }] },
      roleRecord: { definition: { id: 'controller' }, revision: 1 },
    }),
    resolveTaskLedgerWriter: principal => {
      const resolved = principal?.expectedOrgRevision === currentRevision ? writer : null;
      if (assignmentLookupCount === 0) {
        initialAdmissionWriter = resolved;
        assignmentAdmissionResolve();
      } else {
        queuedDispatchLookup = true;
        queuedDispatchWriter = resolved;
      }
      assignmentLookupCount += 1;
      return resolved;
    },
    // Keep the production MCP parser/registry while making the dispatch wrapper
    // explicit so the first queued line can force a fresh context recheck.
    broker: { ...mcp, createLineDispatcher: undefined },
    dispatchLine: async (line, write, options) => {
      const request = JSON.parse(line);
      if (request?.id === 1 && request?.method === 'tools/call'
          && request?.params?.name === 'settings.read') {
        // Hold a real ordinary dispatch at the head of owner-host's serial
        // lane. The assignment is enqueued behind it, so the production
        // serial recheck runs after the test changes the revision.
        ordinaryDispatchResolve();
        await releaseOrdinary;
      }
      if (request?.method === 'tools/call' && request?.params?.name === 't_ledger.assign') {
        // The queued production recheck has already resolved the writer. A
        // changed coordinator therefore reaches the real MCP gate with no
        // assignment capability; this dispatcher only passes through.
        assert.equal(options.taskLedgerWriter, null, 'queued drift recheck removes the stale private writer');
      }
      return mcp.processLine(line, write, options);
    },
  });
  const sockets = [];
  let exchange;
  t.after(async () => {
    releaseOrdinaryResolve();
    exchange?.cancelPending?.(new Error('owner-host transport test cleanup'));
    for (const socket of sockets) socket.destroy();
    await host.close();
    await require('../src/lib/audit').close();
    require('../src/lib/state-store').closeStateStore();
  });
  await host.listen();
  exchange = await connect(host, sockets);
  const bound = await host.bindSession(principals, {});
  assert.equal((await exchange({ type: 'authorize-session', credential: bound.credential })).type, 'authorized');

  let ordinaryResponse;
  let assignmentResponse;
  const assignment = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 't_ledger.assign', arguments: {
      actor: 'codex', id: 'T1', nodeId: 'worker-node', assignmentId: 'assignment-1', reason: 'queued identity check',
    },
  } };
  try {
    // Hold an ordinary dispatch at the head of the real owner-host serial
    // lane before queueing assignment. This gives the assignment an actual
    // initial admission callback, then a distinct queued recheck after the
    // coordinator revision changes.
    ordinaryResponse = exchange({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'settings.read', arguments: {} } });
    await ordinaryDispatchEntered;
    assert.equal(assignmentLookupCount, 0, 'ordinary reads must not resolve the assignment writer');

    assignmentResponse = exchange(assignment);
    await assignmentAdmission;
    assert.equal(currentRevision, 1, 'the admitted assignment starts under the original identity');
    assert.equal(typeof initialAdmissionWriter?.assignTask, 'function', 'the initial admission phase reached the private callback');
    assert.equal(queuedDispatchLookup, false, 'the queued dispatch recheck has not run before the ordinary latch is released');

    currentRevision = 2;
    releaseOrdinaryResolve();
    const ordinary = await ordinaryResponse;
    assert.equal(ordinary?.jsonrpc, '2.0', `ordinary read was not JSON-RPC: ${boundedJson(ordinary)}`);
    assert.equal(ordinary?.id, 1, `ordinary read returned the wrong response id: ${boundedJson(ordinary)}`);
    assert.ok(ordinary && Object.hasOwn(ordinary, 'result') && ordinary.result !== null
      && typeof ordinary.result === 'object' && !Array.isArray(ordinary.result),
    `ordinary read had no result: ${boundedJson(ordinary)}`);
    assert.equal(ordinary.error, undefined, `ordinary read unexpectedly failed: ${boundedJson(ordinary)}`);
    assert.equal(ordinary.result?.isError, undefined, `ordinary read returned a tool error: ${boundedJson(ordinary)}`);

    const first = await assignmentResponse;
    assertAssignmentRefused(first);
    assert.equal(queuedDispatchLookup, true, 'the post-latch dispatch recheck reached the private callback');
    assert.equal(queuedDispatchWriter, null, 'revision drift removed the stale private writer');
    assert.equal(writerCalls, 0, 'revision drift must prevent assignment execution');
  } finally {
    currentRevision = 2;
    releaseOrdinaryResolve();
    if (ordinaryResponse) await ordinaryResponse.catch(() => {});
    if (assignmentResponse) await assignmentResponse.catch(() => {});
  }
});

test('Grok assignment wire alias reaches the private writer while ordinary aliases stay lazy', async t => {
  const principals = {
    sessionId: 'grok-controller-session', agentId: 'controller-node', provider: 'grok',
    roleId: 'manager', expectedOrgRevision: 1, expectedRoleRevision: 1,
  };
  let writerLookupCount = 0;
  let writerCalls = 0;
  let assignmentWriterSeen = null;
  const writer = {
    assignTask(input) {
      writerCalls += 1;
      return receipt(input);
    }
  };
  const host = createOwnerHost({
    ...fixturePermissionOptions,
    allowTestPaths: true,
    platform: 'test',
    pipeName: localPipeName('assignment-grok'),
    capabilityFile: path.join(isolated.root, 'owner-grok.json'),
    principals: { ownerPrincipal: 'TESTHOST\\assignment-grok', clientPrincipal: 'TESTHOST\\assignment-grok' },
    credentialHygiene: async () => {},
    readInstalledOrg: () => ({
      org: { revision: 1, agents: [{ id: 'controller-node', role: 'manager', provider: 'grok', enabled: true }] },
      roleRecord: { definition: { id: 'manager' }, revision: 1 },
    }),
    resolveTaskLedgerWriter: principal => {
      writerLookupCount += 1;
      assert.equal(principal?.agentActor, 'grok', 'the writer lookup is bound to the authenticated Grok provider');
      return writer;
    },
    // Keep the real MCP canonicalizer and registry. The wrapper only observes
    // the private context at the owner-host boundary; it supplies no alias or
    // public capability of its own.
    broker: { ...mcp, createLineDispatcher: undefined },
    dispatchLine: (line, write, options) => {
      const request = JSON.parse(line);
      if (request?.params?.name === 'settings_read') {
        assert.equal(options.taskLedgerWriter, undefined,
          'ordinary Grok wire aliases must not resolve the assignment writer');
      }
      if (request?.params?.name === 't_ledger_assign') {
        assignmentWriterSeen = options.taskLedgerWriter;
        assert.equal(typeof assignmentWriterSeen?.assignTask, 'function',
          'the Grok assignment alias must receive the private writer');
      }
      return mcp.processLine(line, write, options);
    },
  });
  const sockets = [];
  let exchange;
  t.after(async () => {
    exchange?.cancelPending?.(new Error('Grok alias transport test cleanup'));
    for (const socket of sockets) socket.destroy();
    await host.close();
    await require('../src/lib/audit').close();
    require('../src/lib/state-store').closeStateStore();
  });
  await host.listen();
  exchange = await connect(host, sockets);
  const bound = await host.bindSession(principals, {});
  assert.equal((await exchange({ type: 'authorize-session', credential: bound.credential })).type, 'authorized');

  const ordinary = await exchange({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'settings_read', arguments: {} },
  });
  assert.equal(ordinary?.jsonrpc, '2.0', `ordinary Grok alias was not JSON-RPC: ${boundedJson(ordinary)}`);
  assert.equal(ordinary?.id, 1, `ordinary Grok alias returned the wrong id: ${boundedJson(ordinary)}`);
  assert.ok(ordinary && Object.hasOwn(ordinary, 'result') && ordinary.result
    && typeof ordinary.result === 'object' && !Array.isArray(ordinary.result),
  `ordinary Grok alias had no result: ${boundedJson(ordinary)}`);
  assert.equal(ordinary.error, undefined, `ordinary Grok alias returned an error: ${boundedJson(ordinary)}`);
  assert.equal(ordinary.result?.isError, undefined,
    `ordinary Grok alias returned a tool error: ${boundedJson(ordinary)}`);
  assert.equal(writerLookupCount, 0, 'ordinary Grok aliases must keep assignment capability lazy');

  const assignment = await exchange({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 't_ledger_assign', arguments: {
      actor: 'grok', id: 'T1', nodeId: 'worker-node', assignmentId: 'assignment-grok-1',
      reason: 'Grok wire alias assignment',
    } },
  });
  assert.equal(assignment?.jsonrpc, '2.0', `Grok assignment alias was not JSON-RPC: ${boundedJson(assignment)}`);
  assert.equal(assignment?.id, 2, `Grok assignment alias returned the wrong id: ${boundedJson(assignment)}`);
  assert.equal(assignment?.error, undefined, `Grok assignment alias returned an error: ${boundedJson(assignment)}`);
  assert.equal(assignment?.result?.isError, undefined,
    `Grok assignment alias returned a tool error: ${boundedJson(assignment)}`);
  assert.equal(assignment?.result?.structuredContent?.assigned, true,
    `Grok assignment alias did not return an assignment receipt: ${boundedJson(assignment)}`);
  assert.equal(writerLookupCount, 2,
    'the alias resolves the private writer at admission and again at queued dispatch');
  assert.equal(assignmentWriterSeen, writer, 'the callback stays private and reaches the real dispatch boundary');
  assert.equal(writerCalls, 1, 'the Grok alias executes the registered writer exactly once');
});
