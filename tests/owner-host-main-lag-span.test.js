'use strict';

/* AGENT TOOL WORK IS NAMED IN THE APP'S STALL RECORD (T1763).
 *
 * The app loads the owner host into its own main process and runs every agent
 * MCP line there, so a tool call's synchronous work holds the window. On LIVE
 * .47 none of it was named: 2,306 ledger.read calls and about 675 Ledger
 * writes in 2.5 h, and about 87% of main-thread stall time recorded as
 * unattributed. The app now hands the host its main-lag monitor (`mainLag`),
 * and each line is timed as `owner-host:<tool>` -- the line's own checks and
 * dispatch, and the tool handler where the registry runs it.
 *
 * These drive the real owner-host socket, the real MCP dispatcher and the real
 * tool registry (settings.read), with a recorder in place of the app's monitor
 * that has the monitor's span() shape. The only thing observed inside the
 * product is settings.loadSettings, wrapped so it can report which spans were
 * open while the handler ran; it calls the real function. */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { activate } = require('./lib/isolated-environment');
const isolated = activate('owner-host-main-lag-span');
const { createOwnerHost } = require('../src/owner-host');
const settings = require('../src/lib/settings');

const FIXTURE_PERMISSION_SESSION = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });

function recorder() {
  const spans = [];
  const open = new Set();
  return {
    spans,
    open,
    span(label) {
      const entry = { label, handler: /tool-registry\.js/.test(new Error().stack || ''), closed: false };
      spans.push(entry);
      open.add(entry);
      return () => { entry.closed = true; open.delete(entry); };
    }
  };
}

function hostFor(t, mainLag, extra = {}) {
  const host = createOwnerHost({
    resolvePermissionSession: () => FIXTURE_PERMISSION_SESSION,
    resolveWorkspaceRoots: () => [isolated.root],
    allowTestPaths: true,
    platform: 'test',
    pipeName: process.platform === 'win32'
      ? `\\\\.\\pipe\\ToolsEnabledOwnerHostLag-${process.pid}-${crypto.randomUUID()}`
      : path.join(isolated.root, `lag-${crypto.randomUUID()}.sock`),
    capabilityFile: path.join(isolated.root, `owner-${crypto.randomUUID()}.json`),
    principals: { ownerPrincipal: 'TESTHOST\\lag', clientPrincipal: 'TESTHOST\\lag' },
    credentialHygiene: async () => {},
    readInstalledOrg: () => ({
      org: { revision: 1, agents: [{ id: 'controller-node', role: 'controller', provider: 'codex', enabled: true }] },
      roleRecord: { definition: { id: 'controller' }, revision: 1 },
    }),
    ...(mainLag === undefined ? {} : { mainLag }),
    ...extra,
  });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await host.close();
    await require('../src/lib/audit').close();
    require('../src/lib/state-store').closeStateStore();
  });
  return { host, sockets };
}

async function session(host, sockets) {
  await host.listen();
  const socket = net.connect(host.pipeName);
  sockets.push(socket);
  socket.setEncoding('utf8');
  let buffer = '';
  const waiting = [];
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const next = waiting.shift();
      if (next) next(JSON.parse(line));
    }
  });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const exchange = value => new Promise(resolve => { waiting.push(resolve); socket.write(`${JSON.stringify(value)}\n`); });
  const bound = await host.bindSession({
    sessionId: `lag-session-${crypto.randomUUID()}`, agentId: 'controller-node', provider: 'codex',
    roleId: 'controller', expectedOrgRevision: 1, expectedRoleRevision: 1,
  }, {});
  assert.equal((await exchange({ type: 'authorize-session', credential: bound.credential })).type, 'authorized');
  return exchange;
}

function watchSettingsReads(t, lag) {
  const original = settings.loadSettings;
  const reads = [];
  settings.loadSettings = function watchedLoadSettings(...args) {
    reads.push([...lag.open].map(entry => ({ label: entry.label, handler: entry.handler })));
    return original.apply(this, args);
  };
  t.after(() => { settings.loadSettings = original; });
  return reads;
}

test('a tool call is named owner-host:<tool> for its line and for its handler', async t => {
  const lag = recorder();
  const { host, sockets } = hostFor(t, lag);
  const reads = watchSettingsReads(t, lag);
  const exchange = await session(host, sockets);
  const answer = await exchange({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'settings.read', arguments: {} } });
  assert.equal(answer.id, 1);
  assert.equal(answer.error, undefined, JSON.stringify(answer).slice(0, 400));
  assert.equal(answer.result?.isError, undefined, JSON.stringify(answer).slice(0, 400));
  const named = lag.spans.filter(entry => entry.label === 'owner-host:settings.read');
  assert.ok(named.some(entry => !entry.handler), 'the line itself is named owner-host:settings.read');
  assert.ok(named.some(entry => entry.handler), 'the tool handler is named owner-host:settings.read');
  assert.ok(reads.some(open => open.some(entry => entry.label === 'owner-host:settings.read' && entry.handler)),
    'the handler\'s own work ran inside its named span');
  assert.ok(lag.spans.every(entry => entry.closed), 'every span is closed once the call has answered');
  assert.ok(reads.every(open => open.length <= 1), 'a span is never opened inside another one, so no time is counted twice');

  const listed = await exchange({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.ok(Array.isArray(listed.result?.tools));
  assert.ok(lag.spans.some(entry => entry.label === 'owner-host:tools/list'), 'a non-tool line is named by its method');
});

test('a name off the wire that is not tool-shaped is never written into the record', async t => {
  const lag = recorder();
  const { host, sockets } = hostFor(t, lag);
  const exchange = await session(host, sockets);
  const answer = await exchange({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'token: sk_live_0123456789abcdef\n../../x', arguments: {} } });
  assert.ok(answer.error || answer.result?.isError, 'the unknown tool is refused');
  assert.ok(lag.spans.some(entry => entry.label === 'owner-host:unnamed-call'));
  assert.ok(lag.spans.every(entry => !entry.label.includes('sk_live') && !entry.label.includes('\n')));
});

test('a stall monitor that throws changes nothing about the call', async t => {
  const { host, sockets } = hostFor(t, { span() { throw new Error('monitor unavailable'); } });
  const exchange = await session(host, sockets);
  const answer = await exchange({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'settings.read', arguments: {} } });
  assert.equal(answer.id, 4);
  assert.equal(answer.error, undefined);
  assert.equal(answer.result?.isError, undefined);
});

test('a tool run from inside another tool is not timed twice', async t => {
  const lag = recorder();
  const openInside = [];
  const mcp = require('../src/mcp-server');
  const { host, sockets } = hostFor(t, lag, {
    // The production parser and registry answer the line; this wrapper only
    // nests one hook call inside another, as a tool that runs a tool would.
    broker: { ...mcp, createLineDispatcher: undefined },
    dispatchLine: (line, write, options) => {
      options.lagNote('outer.tool', () => options.lagNote('inner.tool', () => {
        openInside.push([...lag.open].map(entry => entry.label));
      }));
      return mcp.processLine(line, write, options);
    },
  });
  const exchange = await session(host, sockets);
  const answer = await exchange({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'settings.read', arguments: {} } });
  assert.equal(answer.id, 5);
  assert.deepEqual(openInside, [['owner-host:outer.tool']], 'the inner call runs inside the outer span and opens none of its own');
  assert.equal(lag.spans.filter(entry => entry.label === 'owner-host:inner.tool').length, 0);
  assert.ok(lag.spans.every(entry => entry.closed));
});
