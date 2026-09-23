'use strict';

require('./lib/isolated-environment').activate('research-access-owner-host-transport');
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { createOwnerHost } = require('../src/owner-host');
const mcp = require('../src/mcp-server');
const { validateResearchAccess } = require('../src/lib/research-access');

const root = path.resolve(process.env.TOOLSENABLED_TEST_ROOT);
const scopeRoot = fs.mkdtempSync(path.join(root, 'research-socket-scope-'));
const inside = path.join(scopeRoot, 'inside.txt');
const listingRoot = path.join(scopeRoot, 'listing');
const listedInside = path.join(listingRoot, 'inside.txt');
const outside = path.join(root, 'outside.txt');
fs.mkdirSync(listingRoot);
fs.writeFileSync(inside, 'inside');
fs.writeFileSync(listedInside, 'inside');
fs.writeFileSync(outside, 'outside');
const scope = validateResearchAccess({ version: 1, mode: 'folder', root: scopeRoot, access: 'read-only' });

function bounded(promise, ms = 5000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('transport fixture deadline')), ms);
  })]).finally(() => clearTimeout(timer));
}

function lineFor(socket, id) {
  let buffered = '';
  let listener;
  const result = new Promise((resolve, reject) => {
    listener = chunk => {
      buffered += String(chunk);
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          if (value.id === id) { resolve(value); return; }
        } catch (error) { reject(error); return; }
      }
    };
    socket.on('data', listener);
  });
  return bounded(result).finally(() => socket.off('data', listener));
}

function fixture() {
  const pipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\T605-research-transport-${randomUUID()}`
    : path.join(root, `research-${randomUUID()}.sock`);
  const host = createOwnerHost({
    allowTestPaths: true,
    platform: 'test',
    pipeName,
    token: randomBytes(32),
    capabilityFile: path.join(root, `${randomUUID()}.capability.json`),
    controlCapabilityFile: path.join(root, `${randomUUID()}.control.json`),
    principals: { ownerPrincipal: 'TEST\\owner', clientPrincipal: 'TEST\\owner' },
    credentialHygiene: async () => {},
    resolveWorkspaceRoots: () => [root],
    resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }),
    readInstalledOrg: () => ({
      org: { revision: 1, agents: [{ id: 'transport-agent', role: 'transport-role', provider: 'codex', enabled: true }] },
      roleRecord: { revision: 1, definition: { id: 'transport-role', functions: ['host.list_dir', 'host.read_file', 'host.write_file', 'host.exec'], requiresDirectUserAuthorization: false } }
    }),
    broker: {
      MAX_MESSAGE_BYTES: 1024 * 1024,
      resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }),
      processLine: mcp.processLine
    }
  });
  return { host, pipeName };
}

async function connect(host, pipeName, principal) {
  const bound = await host.bindSession(principal, { agentApiMode: 'Only', researchAccess: scope });
  const socket = net.connect({ path: pipeName });
  socket.on('error', () => {});
  await bounded(new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  }));
  const authorized = new Promise((resolve, reject) => {
    const onData = chunk => { socket.off('data', onData); resolve(chunk); };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  socket.write(`${JSON.stringify({ type: 'authorize-session', credential: bound.credential })}\n`);
  await bounded(authorized);
  return { bound, socket, identity: { ...principal, credential: bound.credential } };
}

function call(socket, id, name, argumentsValue) {
  socket.write(`${JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: argumentsValue }
  })}\n`);
  return lineFor(socket, id);
}

function refusalCode(response) {
  return response.error?.data?.code
    || response.result?.structuredContent?.error?.code
    || response.result?.structuredContent?.code;
}

test('bound owner-host socket dispatch enforces trusted research scope after omission/null rebind', async () => {
  const { host, pipeName } = fixture();
  const principal = {
    sessionId: `transport-${randomUUID()}`, agentId: 'transport-agent', provider: 'codex',
    roleId: 'transport-role', expectedOrgRevision: 1, expectedRoleRevision: 1
  };
  let session;
  const priorMediation = process.env.TOOLSENABLED_HOST_BYTE_MEDIATION;
  const restoreMediation = () => {
    if (priorMediation === undefined) delete process.env.TOOLSENABLED_HOST_BYTE_MEDIATION;
    else process.env.TOOLSENABLED_HOST_BYTE_MEDIATION = priorMediation;
  };
  try {
    await host.listen();
    session = await connect(host, pipeName, principal);

    const listedInside = await call(session.socket, 'list-inside', 'host.list_dir', { path: listingRoot });
    assert.equal(listedInside.error, undefined);
    assert.match(listedInside.result.content[0].text, /inside\.txt/);
    const listedOutside = await call(session.socket, 'list-outside', 'host.list_dir', { path: root });
    assert.equal(refusalCode(listedOutside), 'RESEARCH_ACCESS_REFUSED');

    process.env.TOOLSENABLED_HOST_BYTE_MEDIATION = 'off';
    const mediationOff = await call(session.socket, 'mediation-off', 'host.read_file', { path: 'inside.txt' });
    assert.equal(refusalCode(mediationOff), 'RESEARCH_ACCESS_REFUSED');
    restoreMediation();
    const overrideResult = await call(session.socket, 'override', 'host.read_file', {
      path: 'inside.txt',
      researchAccess: { version: 1, mode: 'folder', root: root, access: 'read-write' }
    });
    assert.equal(overrideResult.error.code, -32602);
    const insideResult = await call(session.socket, 'inside', 'host.read_file', { path: 'inside.txt' });
    assert.equal(insideResult.error, undefined);
    assert.match(insideResult.result.content[0].text, /inside/);

    const outsideResult = await call(session.socket, 'outside', 'host.read_file', { path: outside });
    assert.equal(refusalCode(outsideResult), 'RESEARCH_ACCESS_REFUSED');

    const terminalResult = await call(session.socket, 'terminal', 'host.exec', { command: 'ver' });
    assert.equal(terminalResult.error?.code, -32602);
    assert.match(terminalResult.error?.message || '', /host\.exec/);

    const writeResult = await call(session.socket, 'write', 'host.write_file', { path: 'inside.txt', content: 'changed' });
    assert.equal(writeResult.error?.code, -32602);
    assert.match(writeResult.error?.message || '', /host\.write_file/);
    assert.equal(fs.readFileSync(inside, 'utf8'), 'inside');

    await host.bindSession(principal, { agentApiMode: 'Only' });
    await host.bindSession(principal, { agentApiMode: 'Only', researchAccess: null });

    const afterRebind = await call(session.socket, 'after-rebind', 'host.read_file', { path: 'inside.txt' });
    assert.equal(afterRebind.error, undefined);
    assert.match(afterRebind.result.content[0].text, /inside/);

    const afterRebindOutside = await call(session.socket, 'after-outside', 'host.read_file', { path: outside });
    assert.equal(refusalCode(afterRebindOutside), 'RESEARCH_ACCESS_REFUSED');
  } finally {
    restoreMediation();
    if (session?.socket && !session.socket.destroyed) {
      session.socket.end();
      await bounded(new Promise(resolve => session.socket.once('close', resolve)));
    }
    await bounded(host.close());
  }
});
