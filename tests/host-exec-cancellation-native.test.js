'use strict';
// Real named-pipe -> MCP -> registry -> host.exec -> owned Windows Job tests.
// Only installation authority and audit persistence are synthetic. Every shell,
// native Job, cancellation, marker file, and closure receipt below is real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const isolated = require('./lib/isolated-environment');
assert.equal(process.platform, 'win32', 'this suite requires actual Windows Jobs');
assert.ok(process.env.TOOLSENABLED_TEST_ROOT && path.isAbsolute(process.env.TOOLSENABLED_TEST_ROOT));
const scratch = path.join(process.env.TOOLSENABLED_TEST_ROOT, `host exec cancellation ${randomUUID()}`);
let cursor = path.parse(scratch).root;
for (const part of path.relative(cursor, path.dirname(scratch)).split(path.sep)) {
  cursor = path.join(cursor, part);
  assert.equal(fs.lstatSync(cursor).isSymbolicLink(), false, 'scratch ancestry must not contain links');
}
fs.mkdirSync(scratch);
isolated.configure(path.join(scratch, 'state'));
fs.mkdirSync(path.join(scratch, 'temp'));
process.env.TEMP = path.join(scratch, 'temp');
process.env.TMP = path.join(scratch, 'temp');
process.env.TOOLSENABLED_TOOLS_THROUGHPUT = 'strict';
// A fresh installation fixture explicitly chooses its tool-approval setting.
// No installed owner's settings or approval grants are read or modified.
const settings = require('../src/lib/settings');
const settingsFile = settings.resolveValuesPath();
assert.ok(isolated.within(scratch, settingsFile));
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify({ revision: 1,
  values: { 'agent.tool_approvals': false },
  provenance: { 'agent.tool_approvals': { source: 'user', atMs: Date.now(), directive: 'isolated native cancellation fixture' } }
}));
assert.equal(settings.loadSettings().values['agent.tool_approvals'], false);
const audit = require('../src/lib/audit');
audit.requireRecord = () => ({ ok: true });
audit.record = () => ({ ok: true });
const jobs = require('../src/lib/windows-job-control');
const hostControl = require('../src/lib/providers/host-control');
const actualExec = hostControl.exec;
const children = [];
const results = [];
const positiveControls = [];
let currentHost = null;
let sequence = 0;
hostControl.exec = (args, context) => actualExec(args, {
  ...context,
  requireRecordAsync: async () => ({ ok: true }),
  recordAsync: async () => ({ ok: true }),
  spawnInJobImpl(file, argv, options, dependencies) {
    const child = jobs.spawnInJob(file, argv, options, dependencies);
    const row = { child, sequence: ++sequence };
    children.push(row);
    child.on('error', error => { row.error = error.code || error.message; });
    return child;
  },
  windowsJobDependencies: {
    recordDirectory: path.join(scratch, 'job-records'),
    assemblyCacheDirectory: path.join(scratch, 'assembly-cache'), cleanupTimeoutMs: 3000
  }
});
const mcp = require('../src/mcp-server');
const ownerHost = require('../src/owner-host');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await sleep(15);
  }
  throw new Error(`Timed out: ${label}`);
}
function bounded(promise, label, timeoutMs = 12000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}
function makeHost(mode) {
  const pipeName = `\\\\.\\pipe\\ToolsEnabledExecCancellation-${process.pid}-${randomUUID()}`;
  const token = randomBytes(32);
  const host = ownerHost.createOwnerHost({
    pipeName, token, allowTestPaths: true, platform: 'test',
    capabilityFile: path.join(scratch, `${randomUUID()}.capability.json`),
    controlCapabilityFile: path.join(scratch, `${randomUUID()}.control.json`),
    principals: { ownerPrincipal: 'TESTHOST\\exec-cancellation', clientPrincipal: 'TESTHOST\\exec-cancellation' },
    credentialHygiene() {}, sessionRetirementObserver() {},
    authorizeAgentBinding: () => true,
    readInstalledOrg(principal) {
      return { roleRecord: { revision: 1, definition: {
        id: principal.roleId, functions: ['host.exec'], requiresDirectUserAuthorization: false
      } } };
    },
    broker: { ...mcp, recordMcpSurface() {}, resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }) },
    lineDispatcher: { modeOf: () => mode }
  });
  return { host, token };
}
async function connect(pipeName) {
  const socket = net.connect({ path: pipeName });
  const messages = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  socket.on('error', () => {});
  await bounded(new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }), 'connect');
  return { socket, messages, write: value => socket.write(`${JSON.stringify(value)}\n`) };
}
async function session(host, label) {
  const principal = { sessionId: `session-${label}`, agentId: `agent-${label}`, provider: 'claude',
    roleId: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 };
  const binding = await host.bindSession(principal);
  const client = await connect(host.pipeName);
  client.write({ type: 'authorize-session', credential: binding.credential });
  await until(() => client.messages.find(message => message.type === 'authorized'), 'authorize');
  return { ...client, principal, credential: binding.credential };
}
const quote = value => `'${value.replace(/'/g, "''")}'`;
async function start(client, label, delayMs = 5000, descendant = false) {
  const marker = path.join(scratch, `${label}.txt`);
  const id = `exec-${label}`;
  const beforeCount = children.length;
  const childScript = `const fs = require('node:fs'); const marker = ${JSON.stringify(marker)}; fs.writeFileSync(marker, 'BEFORE\\n'); setTimeout(() => fs.appendFileSync(marker, 'AFTER\\n'), ${delayMs});`;
  const childFile = path.join(scratch, `${label}.cjs`);
  if (descendant) fs.writeFileSync(childFile, `${childScript}\n`);
  const command = descendant ? `& ${quote(process.execPath)} ${quote(childFile)}`
    : `$marker = ${quote(marker)}; [IO.File]::WriteAllText($marker, "BEFORE\n"); Start-Sleep -Milliseconds ${delayMs}; [IO.File]::AppendAllText($marker, "AFTER\n")`;
  client.write({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'host.exec', arguments: { command, cwd: scratch, timeoutMs: 30000 } } });
  await until(() => {
    const refused = client.messages.find(message => message.id === id);
    if (refused) throw new Error(`Command refused before marker: ${JSON.stringify(refused)}`);
    return fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'BEFORE\n';
  }, `${label} marker`);
  assert.equal(children.length, beforeCount + 1);
  return { marker, id, child: children.at(-1).child, startedAt: Date.now(), delayMs, descendant };
}
async function proveCancelled(run, label) {
  const outcome = await bounded(run.child.jobOutcome, `${label} Job outcome`);
  const closed = await bounded(run.child.jobClosed, `${label} wrapper closure`);
  assert.equal(outcome.activeProcesses, 0);
  assert.equal(outcome.type, 'terminated');
  assert.equal(closed.failure, null);
  assert.equal(run.child._closed, true);
  await sleep(Math.max(0, run.startedAt + run.delayMs + 300 - Date.now()));
  const content = fs.readFileSync(run.marker, 'utf8');
  assert.equal(content, 'BEFORE\n', 'cancelled native command must not append its delayed marker');
  const identity = await run.child.jobReady;
  results.push({ label, marker: run.marker, content, descendant: run.descendant, checkedAt: new Date().toISOString(),
    identity: { jobId: identity.jobId, rootPid: identity.rootPid, wrapperPid: identity.wrapperPid }, outcome,
    wrapperClosed: true, wrapperExitCode: closed.code });
  fs.writeFileSync(path.join(scratch, 'result.json'), `${JSON.stringify({ results, positiveControls }, null, 2)}\n`);
}
async function main() {
  for (const [action, mode] of [['request', 'fast'], ['request-descendant', 'strict'], ['disconnect', 'strict'], ['revoke', 'fast'], ['control-revoke', 'strict'], ['host-close', 'fast']]) {
    const { host, token } = makeHost(mode);
    currentHost = host;
    await host.listen();
    const first = await session(host, `${action}-a`);
    const other = await session(host, `${action}-b`);
    const run = await start(first, `${action}-target`, 5000, action === 'request-descendant');
    const unaffected = action === 'host-close' ? null : await start(other, `${action}-other`, 1000);
    if (action.startsWith('request')) {
      // The connection has its own lifetime signal. This still must find and
      // cancel the request-specific controller rather than silently ignoring it.
      first.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: run.id } });
      const answer = await until(() => first.messages.find(message => message.id === run.id), 'cancel response');
      assert.equal(answer.result.isError, true, 'MCP must report cancellation rather than completing the stopped command');
      assert.equal(answer.result.structuredContent.error.code, 'ABORT_ERR');
      assert.equal(answer.result.structuredContent.error.taxonomy.code, 'OPERATION_CANCELLED');
      assert.equal(run.child._closed, true, 'MCP cancellation answers only after wrapper closure');
    } else if (action === 'disconnect') {
      first.socket.destroy();
    } else if (action === 'revoke') {
      const revoked = await bounded(host.revokeSession({ ...first.principal, credential: first.credential }), 'direct revoke');
      assert.equal(revoked.revoked, true);
      assert.equal(run.child._closed, true, 'session closure cannot precede native cleanup');
    } else if (action === 'control-revoke') {
      const control = await connect(host.pipeName);
      control.write({ type: 'revoke-session', token: token.toString('base64url'), sessionId: first.principal.sessionId, credential: first.credential });
      await until(() => control.messages.find(message => message.type === 'session-revoked'), 'control revoke');
      assert.equal(run.child._closed, true, 'control acknowledgement cannot precede native cleanup');
      control.socket.destroy();
    } else {
      await bounded(host.close(), 'host close');
      assert.equal(run.child._closed, true, 'host close cannot precede native cleanup');
    }
    await proveCancelled(run, `${mode}:${action}`);
    if (unaffected) {
      const answer = await until(() => other.messages.find(message => message.id === unaffected.id), 'unaffected result');
      assert.equal(answer.result.structuredContent.ok, true);
      assert.equal(fs.readFileSync(unaffected.marker, 'utf8'), 'BEFORE\nAFTER\n');
      const outcome = await unaffected.child.jobOutcome;
      assert.equal(outcome.activeProcesses, 0);
      assert.equal(outcome.exitCode, 0);
      assert.equal((await unaffected.child.jobClosed).failure, null);
      positiveControls.push({ label: `${mode}:${action}:other`, marker: unaffected.marker,
        content: fs.readFileSync(unaffected.marker, 'utf8'), outcome, wrapperClosed: unaffected.child._closed });
    }
    first.socket.destroy();
    other.socket.destroy();
    await host.close();
    currentHost = null;
    fs.writeFileSync(path.join(scratch, 'result.json'), `${JSON.stringify({ results, positiveControls }, null, 2)}\n`);
    console.log(`PASS ${mode}:${action}: no delayed write, empty owned Job, wrapper closed${unaffected ? ', other session completed' : ''}`);
  }
  console.log(`Native host.exec cancellation passed (${results.length} paths). Evidence: ${path.join(scratch, 'result.json')}`);
}
main().catch(async error => {
  console.error(error);
  process.exitCode = 1;
  const cleanup = [];
  for (const row of children) {
    try {
      const receipt = await bounded(row.child.terminateJob(), 'fixture exact Job cleanup');
      const closed = await bounded(row.child.jobClosed, 'fixture wrapper cleanup');
      cleanup.push({ sequence: row.sequence, receipt, wrapperClosed: row.child._closed, failure: closed.failure?.code || null });
    } catch (cleanupError) { cleanup.push({ sequence: row.sequence, unproved: cleanupError.code || cleanupError.message }); }
  }
  try { if (currentHost) await bounded(currentHost.close(), 'fixture owner host close'); }
  catch (cleanupError) { cleanup.push({ ownerHost: cleanupError.code || cleanupError.message }); }
  fs.writeFileSync(path.join(scratch, 'result.json'), `${JSON.stringify({ results, positiveControls, failure: error.message, cleanup }, null, 2)}\n`);
});
