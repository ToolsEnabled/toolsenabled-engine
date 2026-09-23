'use strict';

// Real encrypted/accepted FRA socket -> MCP -> registry -> handle broker ->
// SQLite byte authority, with a separate local mediated repo writer. The
// installation identity/trust inputs are isolated fixtures, not LIVE proofs.
const isolation = require('./lib/isolated-environment').activate('fra-byte-mediation');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const repo = require('../src/lib/providers/repo-files');
const contexts = require('../src/lib/file-tool-context');
const handlesPath = require.resolve('../src/lib/providers/fra-workspace-handles');
const handles = require(handlesPath);
let broker;
// Only the fixed test root's service declaration is injected. The broker,
// descriptor reads, authority, dispatch, cryptography and sockets are real.
require.cache[handlesPath].exports = Object.freeze({ ...handles,
  list: (...args) => broker.list(...args), read: (...args) => broker.read(...args),
  closeSession: (...args) => broker.closeSession(...args)
});
const mcp = require('../src/mcp-server');
const { executeTool } = require('../src/lib/tool-registry');
const { createFullRemoteAccessBridge } = require('../src/full-remote-access-bridge');
const secure = require('../src/lib/fra-secure-session');
const bindingTools = require('../src/lib/fra-transport-binding');
const { bridgeTrustOptions, bindableCapabilityProfile } = require('./helpers/fra-binding-fixture');
const OWNER = Object.freeze({ origin: 'local', tier: 'full' });
const LAB = Object.freeze({ registry: { schemaVersion: 1,
  machines: { a: { address: '203.0.113.1' }, b: { address: '203.0.113.2' } }, services: {}
} });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const key = file => process.platform === 'win32' ? file.toLowerCase() : file;

function bounded(promise, label, ms = 10000) {
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' exceeded its finite deadline')), ms);
  })]).finally(() => clearTimeout(timer));
}
function frames(socket) {
  let buffer = '';
  let closed = false;
  const queue = [];
  const waiters = [];
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const value = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value); else queue.push(value);
    }
  });
  socket.on('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('owned FRA socket closed'));
  });
  return () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (closed) return Promise.reject(new Error('owned FRA socket closed'));
    return bounded(new Promise((resolve, reject) => waiters.push({ resolve, reject })), 'FRA frame');
  };
}
function rows(sql, ...args) {
  const authority = repo.coordinationAuthority();
  if (!fs.existsSync(authority.dataFile)) return [];
  const db = new DatabaseSync(authority.dataFile, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

async function fixture(t, contents = { 'Text.txt': 'left|right' }) {
  const leaf = '.fra-byte-' + crypto.randomUUID();
  const directory = path.join(repo.ROOT, leaf);
  assert.equal(path.dirname(directory), repo.ROOT);
  fs.mkdirSync(directory);
  for (const [name, bytes] of Object.entries(contents)) fs.writeFileSync(path.join(directory, name), bytes);
  broker = new handles.FraWorkspaceHandleBroker({ root: repo.ROOT, serviceRegistryOptions: LAB });
  const ownedBroker = broker;
  const scopes = [];
  const sockets = [];
  const seen = new Map();
  const masterKey = secure.deriveMasterKey('offline-fra-byte-mediation-fixture-key');
  const profile = bindableCapabilityProfile({ allowedTools: ['workspace.list', 'workspace.read'] });
  const server = createFullRemoteAccessBridge({
    ...bridgeTrustOptions(), host: '203.0.113.2', masterKey,
    serviceRegistryOptions: LAB, allowedRemoteRe: /^127\.0\.0\.1$/,
    capabilityProfile: profile, reloadToken: null,
    logFile: path.join(isolation.root, leaf + '.log'),
    inboundReceiptWriter() {}, inboundLivenessWriter() {},
    auditApi: { requireRecord: () => ({ durable: true, anchored: true }), record: () => ({ durable: true, anchored: true }) },
    workspaceHandles: ownedBroker,
    dispatchLine: (line, respond, options) => {
      seen.set(options.fraWorkspaceContext.sessionContextDigest, options);
      return mcp.processLine(line, respond, options);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.destroySessions('fixture-finished');
    for (const socket of sockets) socket.destroy();
    await bounded(new Promise(resolve => server.close(resolve)), 'FRA listener close');
    await bounded(server.waitForFileScopeRetirements(), 'FRA byte retirement');
    await Promise.all(scopes.map(scope => contexts.retireFileToolContext(scope, 'fixture-finished')));
    assert.equal(fs.realpathSync(directory), directory);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const connect = async () => {
    const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
    sockets.push(socket);
    const next = frames(socket);
    await bounded(new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }), 'FRA connect');
    const handshake = secure.beginClientHandshake({ masterKey, challenge: await next(),
      serverHost: '203.0.113.2', clientHost: '203.0.113.1', serviceRegistryOptions: LAB });
    socket.write(JSON.stringify(handshake.response) + '\n');
    const session = handshake.complete(await next());
    const binding = JSON.parse(session.open(await next()));
    assert.equal(binding.sessionId, session.sessionId);
    socket.write(JSON.stringify(session.seal(JSON.stringify(bindingTools.createBindingAcceptance(binding)))) + '\n');
    assert.equal(JSON.parse(session.open(await next())).type, 'fra.authorization-audited');
    const call = async (name, args, id = crypto.randomUUID()) => {
      const request = bindingTools.createBoundRequest({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, binding.contextDigest);
      socket.write(JSON.stringify(session.seal(JSON.stringify(request))) + '\n');
      const envelope = JSON.parse(session.open(await next()));
      return bindingTools.validateBoundResponse(envelope, { requestEnvelope: request, allowedTools: profile.allowedTools }).response;
    };
    const files = async () => {
      const root = await call('workspace.list', { limit: 100 });
      assert.notEqual(root.result?.isError, true, JSON.stringify(root));
      const selected = root.result.structuredContent.entries.find(item => item.name === leaf);
      assert.ok(selected, 'the fixture directory must be listed by its real root handle');
      const listing = await call('workspace.list', { directoryHandle: selected.handle, expectedVersion: selected.version, limit: 100 });
      assert.notEqual(listing.result?.isError, true, JSON.stringify(listing));
      return listing.result.structuredContent.entries;
    };
    return { socket, session, binding, call, files,
      context: () => seen.get(binding.contextDigest),
      read: (file, options = {}, id) => call('workspace.read', { fileHandle: file.handle, expectedVersion: file.version, ...options }, id)
    };
  };
  const local = () => {
    const scope = contexts.createFileToolContext({ scopeKind: 'owner-host-session', sessionId: crypto.randomUUID() });
    scopes.push(scope);
    return (tool, args) => executeTool(tool, args, { permissionSession: OWNER, fileToolContext: scope });
  };
  return { connect, local, server, broker: ownedBroker, directory,
    file: name => `${leaf}/${name}`, resource: name => key(fs.realpathSync(path.join(directory, name))) };
}

test('accepted FRA read and local repo writer share actual authority and exact byte coordinates', async t => {
  const f = await fixture(t);
  const remote = await f.connect();
  const file = (await remote.files()).find(item => item.name === 'Text.txt');
  const response = await remote.read(file, { offset: 5, length: 5 }, 'repeated-id');
  assert.notEqual(response.result?.isError, true, JSON.stringify(response));
  assert.equal(response.result.structuredContent.content, 'right');
  const scope = remote.context().fileToolContext;
  const resource = f.resource('Text.txt');
  const first = rows('SELECT * FROM reads WHERE scope_id=? AND resource=?', scope.binding.runtimeScopeId, resource);
  assert.equal(first.length, 1);
  assert.equal(first[0].start_byte, 5); assert.equal(first[0].end_byte, 10);
  assert.deepEqual(Buffer.from(first[0].observed), Buffer.from('right'));
  const receipt = JSON.parse(rows('SELECT receipt_json FROM receipts WHERE ref=?', first[0].receipt_ref)[0].receipt_json);
  assert.equal(receipt.fileSha256, hash(Buffer.from('left|right')));
  assert.equal(receipt.contentSha256, response.result.structuredContent.contentSha256);
  assert.equal(receipt.binding.scopeKind, 'paired-desktop');
  for (const field of ['canonicalLaunchId', 'laneId', 'runId', 'rosterRef']) assert.equal(receipt.binding[field], null);
  const writer = f.local();
  await writer('repo.read_file', { path: f.file('Text.txt') });
  await writer('repo.patch_file', { path: f.file('Text.txt'), oldText: 'left', newText: 'LEFT-LONG' });
  const rebased = rows('SELECT * FROM reads WHERE scope_id=? AND resource=?', scope.binding.runtimeScopeId, resource)[0];
  assert.equal(rebased.start_byte, 10); assert.equal(rebased.end_byte, 15);
  assert.equal(rebased.stale_reason, null); assert.deepEqual(Buffer.from(rebased.observed), Buffer.from('right'));
  await writer('repo.patch_file', { path: f.file('Text.txt'), oldText: 'right', newText: 'RIGHT' });
  assert.equal(rows('SELECT * FROM reads WHERE scope_id=? AND resource=?', scope.binding.runtimeScopeId, resource)[0].stale_reason, 'MEDIATED_WRITE');
  const stale = await remote.read(file);
  assert.equal(stale.result.isError, true); assert.ok(JSON.stringify(stale).includes('WORKSPACE_HANDLE_STALE'));
  assert.equal(JSON.stringify(response).includes(repo.ROOT), false);
  assert.equal(JSON.stringify(stale).includes(f.directory), false);
  const denied = await remote.call('repo.write_file', { path: f.file('Text.txt'), content: 'forbidden' });
  assert.ok(denied.error || denied.result?.isError, 'mediation must not widen the FRA manifest');
});

test('UTF-8, BOM, Base64, empty files and offsets beyond EOF receipt only the exact returned window', async t => {
  const unicode = Buffer.from('\uFEFFéz');
  const binary = Buffer.from([0xff, 0, 0x7f]);
  const f = await fixture(t, { 'Unicode.txt': unicode, 'Binary.bin': binary, 'Empty.txt': '' });
  const remote = await f.connect();
  const files = await remote.files();
  const named = name => files.find(value => value.name === name);
  const scopeId = remote.context().fileToolContext.binding.runtimeScopeId;
  const invalid = await remote.read(named('Unicode.txt'), { offset: 4, length: 1 });
  assert.equal(invalid.result.isError, true);
  assert.ok(JSON.stringify(invalid).includes('WORKSPACE_FILE_NOT_UTF8'));
  assert.equal(rows('SELECT ref FROM receipts WHERE scope_id=?', scopeId).length, 0);
  const text = (await remote.read(named('Unicode.txt'))).result.structuredContent;
  assert.equal(text.content, 'éz', 'preserve FRA TextDecoder BOM behavior, not repo text decoding');
  assert.equal(text.bytes, unicode.length); assert.equal(text.contentSha256, hash(unicode));
  const decoded = (await remote.read(named('Binary.bin'), { encoding: 'base64' })).result.structuredContent;
  assert.deepEqual(Buffer.from(decoded.content, 'base64'), binary);
  const empty = (await remote.read(named('Empty.txt'), { offset: 7 })).result.structuredContent;
  assert.equal(empty.offset, 7); assert.equal(empty.bytes, 0); assert.equal(empty.eof, true);
  const eof = (await remote.read(named('Unicode.txt'), { offset: 100 })).result.structuredContent;
  assert.equal(eof.offset, 100); assert.equal(eof.content, ''); assert.equal(eof.eof, true);
  const emptyReceipt = JSON.parse(rows('SELECT receipt_json FROM receipts WHERE scope_id=? AND resource=?', scopeId, f.resource('Empty.txt'))[0].receipt_json);
  assert.equal(emptyReceipt.startByte, 0); assert.equal(emptyReceipt.endByte, 0);
  const eofRows = rows('SELECT receipt_json FROM receipts WHERE scope_id=? AND resource=? ORDER BY rowid DESC', scopeId, f.resource('Unicode.txt'));
  assert.equal(JSON.parse(eofRows[0].receipt_json).startByte, unicode.length);
  assert.equal(rows('SELECT schema_version FROM meta')[0].schema_version, 2, 'this adapter does not migrate the byte store');
});

test('an unanchored audit cannot release content or create a byte receipt', async t => {
  const f = await fixture(t);
  const remote = await f.connect();
  const file = (await remote.files())[0];
  const scopeId = remote.context().fileToolContext.binding.runtimeScopeId;
  let required = 0;
  f.broker.audit = {
    requireRecord() { required += 1; return { durable: true, anchored: false }; },
    record() { throw new Error('ordinary record must not substitute for required anchoring'); }
  };
  const result = await remote.read(file);
  assert.equal(result.result.isError, true);
  assert.equal(required, 1);
  assert.ok(JSON.stringify(result).includes('WORKSPACE_AUDIT_UNAVAILABLE'));
  assert.equal(JSON.stringify(result).includes('left|right'), false);
  assert.equal(rows('SELECT ref FROM receipts WHERE scope_id=?', scopeId).length, 0);
});

test('same-byte replacement and hard-link aliases fail closed without false observations', async t => {
  const f = await fixture(t);
  const remote = await f.connect();
  let file = (await remote.files())[0];
  const original = path.join(f.directory, 'Text.txt');
  const replacement = path.join(f.directory, 'replacement.tmp');
  fs.writeFileSync(replacement, 'left|right');
  fs.renameSync(replacement, original);
  const stale = await remote.read(file);
  assert.equal(stale.result.isError, true); assert.ok(JSON.stringify(stale).includes('WORKSPACE_HANDLE_STALE'));
  file = (await remote.files()).find(value => value.name === 'Text.txt');
  const alias = path.join(f.directory, 'alias.txt');
  fs.linkSync(original, alias);
  try {
    const refused = await remote.read(file);
    assert.equal(refused.result.isError, true); assert.ok(JSON.stringify(refused).includes('WORKSPACE_IDENTITY_INVALID'));
    const writer = f.local();
    await assert.rejects(writer('repo.read_file', { path: f.file('Text.txt') }), { code: 'REPO_FILE_PATH_FORBIDDEN' });
  } finally { fs.unlinkSync(alias); }
  const scopeId = remote.context().fileToolContext.binding.runtimeScopeId;
  assert.equal(rows('SELECT ref FROM receipts WHERE scope_id=?', scopeId).length, 0);
});

test('generation retirement while the real authority lock is held cannot release queued bytes', async t => {
  const f = await fixture(t);
  const remote = await f.connect();
  const file = (await remote.files())[0];
  const scope = remote.context().fileToolContext;
  const writer = f.local();
  await writer('repo.read_file', { path: f.file('Text.txt') });
  const authority = repo.coordinationAuthority();
  const lock = new DatabaseSync(authority.lockFile);
  lock.exec('BEGIN IMMEDIATE');
  let attempted;
  const entered = new Promise(resolve => { attempted = resolve; });
  const observe = authority.observeRead;
  authority.observeRead = function (options) { attempted(); return observe.call(this, options); };
  const pending = remote.read(file).then(value => ({ value }), error => ({ error }));
  try {
    await bounded(entered, 'queued observation reached actual authority');
    f.server.rotateBaseToken('replacement-offline-FRA-fixture-key-only');
    assert.throws(() => contexts.requireFileToolContext(scope), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  } finally {
    authority.observeRead = observe;
    lock.exec('ROLLBACK'); lock.close();
  }
  assert.ok((await pending).error, 'the retired encrypted connection must not receive file content');
  await bounded(f.server.waitForFileScopeRetirements(), 'retirement after authority release');
  assert.equal(rows('SELECT ref FROM receipts WHERE scope_id=?', scope.binding.runtimeScopeId).length, 0);
  assert.equal(rows('SELECT closed FROM scopes WHERE scope_id=?', scope.binding.runtimeScopeId)[0].closed, 1);
});

test('revocation after receipt commit withholds wire content without inventing receipt rollback', async t => {
  const f = await fixture(t);
  const remote = await f.connect();
  const file = (await remote.files())[0];
  const scopeId = remote.context().fileToolContext.binding.runtimeScopeId;
  const authority = repo.coordinationAuthority();
  const observe = authority.observeRead;
  authority.observeRead = async function (options) {
    const result = await observe.call(this, options);
    f.server.destroySessions('fixture-after-observation-commit');
    return result;
  };
  try { await assert.rejects(remote.read(file), /socket closed/); }
  finally { authority.observeRead = observe; }
  await f.server.waitForFileScopeRetirements();
  assert.equal(rows('SELECT ref FROM receipts WHERE scope_id=?', scopeId).length, 1);
  assert.equal(rows('SELECT closed FROM scopes WHERE scope_id=?', scopeId)[0].closed, 1);
});

test('publication cannot interleave between handle snapshot validation and durable observation', async t => {
  const f = await fixture(t);
  const remote = await f.connect();
  const file = (await remote.files())[0];
  const writer = f.local();
  await writer('repo.read_file', { path: f.file('Text.txt') });
  const authority = repo.coordinationAuthority();
  const observe = authority.observeRead;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let observed;
  const atValidation = new Promise(resolve => { observed = resolve; });
  authority.observeRead = function (options) {
    return observe.call(this, { ...options, validateRead: async value => {
      await options.validateRead(value); observed(); await barrier;
    } });
  };
  const reading = remote.read(file, { offset: 5, length: 5 });
  await bounded(atValidation, 'snapshot validation');
  const probe = new DatabaseSync(authority.lockFile);
  try { assert.throws(() => probe.exec('BEGIN IMMEDIATE'), /locked|busy/i); }
  finally { probe.close(); }
  let settled = false;
  const writing = writer('repo.patch_file', { path: f.file('Text.txt'), oldText: 'left', newText: 'long-left' })
    .finally(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(fs.readFileSync(path.join(f.directory, 'Text.txt'), 'utf8'), 'left|right');
  } finally { release(); authority.observeRead = observe; }
  const result = await reading;
  assert.equal(result.result.structuredContent.content, 'right');
  assert.equal(result.result.structuredContent.fileSha256, hash(Buffer.from('left|right')));
  await writing;
  const scopeId = remote.context().fileToolContext.binding.runtimeScopeId;
  assert.equal(rows('SELECT start_byte FROM reads WHERE scope_id=?', scopeId)[0].start_byte, 10);
});

test('long handle paths remain readable while the public repo path-input bound stays unchanged', async t => {
  const f = await fixture(t);
  const segments = Array.from({ length: 5 }, (_, index) => 'segment' + index + '-'.repeat(78));
  const nested = path.join(f.directory, ...segments);
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'long.txt'), 'long handle bytes');
  const remote = await f.connect();
  let entries = await remote.files();
  for (const segment of segments) {
    const directory = entries.find(value => value.name === segment);
    assert.ok(directory);
    const result = await remote.call('workspace.list', { directoryHandle: directory.handle, expectedVersion: directory.version });
    assert.notEqual(result.result?.isError, true, JSON.stringify(result));
    entries = result.result.structuredContent.entries;
  }
  const file = entries.find(value => value.name === 'long.txt');
  const result = await remote.read(file);
  assert.notEqual(result.result?.isError, true, JSON.stringify(result));
  assert.equal(result.result.structuredContent.content, 'long handle bytes');
  const relative = f.file([...segments, 'long.txt'].join('/'));
  assert.ok(relative.length > repo.MAX_PATH_LENGTH);
  await assert.rejects(f.local()('repo.read_file', { path: relative }), { code: 'REPO_FILE_PATH_INVALID' });
  const materialized = repo.coordinationAuthority().materialize(f.resource([...segments, 'long.txt'].join('/')));
  assert.deepEqual(materialized.bytes, Buffer.from('long handle bytes'), 'the common dependency/recovery adapter also preserves this domain');
});

test('public context copies, other private scopes and echoed invocation metadata cannot authorize FRA reads', async t => {
  const f = await fixture(t);
  const one = await f.connect();
  const two = await f.connect();
  const file = (await one.files())[0];
  await two.files();
  const second = await two.read(file);
  assert.equal(second.result.isError, true);
  const args = { fileHandle: file.handle, expectedVersion: file.version };
  for (const context of [
    { ...one.context(), fileToolContext: JSON.parse(JSON.stringify(one.context().fileToolContext)) },
    { ...one.context(), fraWorkspaceContext: { ...one.context().fraWorkspaceContext } },
    { ...one.context(), fileToolContext: two.context().fileToolContext },
    { ...one.context(), fileToolContext: undefined }
  ]) {
    await assert.rejects(executeTool('workspace.read', args, context), error => /CONTEXT_REQUIRED|IDENTITY_REQUIRED/.test(error.code));
  }
  const invocationIds = [];
  const begin = contexts.beginFileToolInvocation;
  contexts.beginFileToolInvocation = (scope, options) => { invocationIds.push(options.invocationId); return begin(scope, options); };
  try {
    for (let index = 0; index < 2; index++) {
      const result = await one.read(file, { offset: index, length: 1 }, 'same-correlation');
      assert.notEqual(result.result?.isError, true);
    }
  } finally { contexts.beginFileToolInvocation = begin; }
  assert.equal(new Set(invocationIds).size, 2);
  const forged = await one.read(file, { currentToolInvocation: { invocationId: invocationIds[0] } });
  assert.equal(forged.error.code, -32602);
});

test('final bound response checks retirement after the provider returned and strict MCP audit recorded success', async t => {
  const f = await fixture(t);
  const remote = await f.connect();
  const file = (await remote.files())[0];
  const scope = remote.context().fileToolContext;
  const audit = require('../src/lib/audit');
  const record = audit.record;
  const throughput = require('../src/lib/throughput-mode');
  let closing;
  let reached = false;
  const retireAfterSuccess = (action, target) => {
    if (!reached && action === 'mcp.tool.succeeded' && target === 'workspace.read') {
      reached = true;
      closing = contexts.retireFileToolContext(scope, 'fixture-during-final-dispatch-audit');
    }
  };
  audit.record = function (action, target, ...args) {
    const result = record.call(this, action, target, ...args);
    retireAfterSuccess(action, target);
    return result;
  };
  // Select the real strict audit path so this synchronous hook is after its
  // actual append, not a fake queue status or a provider-return surrogate.
  // The other transport tests run with the default grouped admission path.
  throughput.setThroughputModeForTests('strict');
  try {
    const outcome = await remote.read(file).then(value => ({ value }), error => ({ error }));
    assert.equal(reached, true, 'this race is after the real provider completed, not before admission');
    assert.equal(outcome.value?.result?.structuredContent?.content, undefined,
      'retired final response must not expose file bytes');
    assert.match(outcome.error?.message || '', /socket closed/);
  } finally { audit.record = record; throughput.setThroughputModeForTests(null); await closing; }
  assert.equal(rows('SELECT ref FROM receipts WHERE scope_id=?', scope.binding.runtimeScopeId).length, 1);
});

test('shared pending-write recovery precedes the requested handle snapshot and unrelated UNKNOWN stays scoped', async t => {
  const f = await fixture(t, { 'Text.txt': 'left|right', 'Other.txt': 'other-before' });
  const remote = await f.connect();
  const files = await remote.files();
  const file = files.find(value => value.name === 'Text.txt');
  const other = files.find(value => value.name === 'Other.txt');
  const writer = f.local();
  const audit = require('../src/lib/audit');
  const required = audit.requireRecord;
  const operationFor = name => rows('SELECT status,operation_json FROM operations')
    .find(row => JSON.parse(row.operation_json).resource === f.resource(name));
  const failedPatch = async (name, oldText) => {
    await writer('repo.read_file', { path: f.file(name) });
    audit.requireRecord = function (action, ...args) {
      if (action === 'repo.patch_file.intent') throw Object.assign(new Error('fixture refuses publication audit'), { code: 'FIXTURE_AUDIT_REFUSED' });
      return required.call(this, action, ...args);
    };
    try {
      await assert.rejects(writer('repo.patch_file', { path: f.file(name), oldText, newText: 'intended-after' }), error => {
        assert.equal(error.code, 'BYTE_PUBLICATION_UNCONFIRMED');
        assert.equal(error.cause.code, 'FIXTURE_AUDIT_REFUSED');
        return true;
      });
    }
    finally { audit.requireRecord = required; }
  };
  await failedPatch('Text.txt', 'left');
  assert.equal(operationFor('Text.txt').status, 'PREPARED');
  const read = await remote.read(file);
  assert.equal(read.result.structuredContent.content, 'left|right');
  assert.equal(operationFor('Text.txt').status, 'ABORTED');
  await failedPatch('Other.txt', 'other-before');
  fs.writeFileSync(path.join(f.directory, 'Other.txt'), 'unexpected-third-image');
  await assert.rejects(repo.coordinationAuthority().recoverPending({ resources: [f.resource('Other.txt')] }), { code: 'BYTE_RECOVERY_UNRESOLVED' });
  assert.equal(operationFor('Other.txt').status, 'UNKNOWN');
  const unrelated = await remote.read(file);
  assert.equal(unrelated.result.structuredContent.content, 'left|right');
  const refused = await remote.read(other);
  assert.equal(refused.result.isError, true);
  assert.ok(JSON.stringify(refused).includes('WORKSPACE_COORDINATION_UNAVAILABLE'));
  for (const secret of [f.directory, 'unexpected-third-image', 'intended-after']) assert.equal(JSON.stringify(refused).includes(secret), false);
});

test('an ancestor junction cannot move an existing handle outside the fixed repository root', async t => {
  const f = await fixture(t);
  const directory = path.join(f.directory, 'nested');
  const saved = path.join(f.directory, 'saved');
  const outside = path.join(isolation.root, 'outside-' + crypto.randomUUID());
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'inside.txt'), 'inside');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'inside.txt'), 'outside-not-exposed');
  const remote = await f.connect();
  const selected = (await remote.files()).find(value => value.name === 'nested');
  const result = await remote.call('workspace.list', { directoryHandle: selected.handle, expectedVersion: selected.version });
  const file = result.result.structuredContent.entries[0];
  fs.renameSync(directory, saved);
  fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const refused = await remote.read(file);
    assert.equal(refused.result.isError, true);
    assert.ok(['WORKSPACE_ROOT_ESCAPE', 'WORKSPACE_COORDINATION_UNAVAILABLE'].includes(refused.result.structuredContent.error.code), JSON.stringify(refused));
    assert.equal(JSON.stringify(refused).includes('outside-not-exposed'), false);
    assert.equal(rows('SELECT ref FROM receipts WHERE scope_id=?', remote.context().fileToolContext.binding.runtimeScopeId).length, 0);
  } finally {
    assert.equal(fs.readlinkSync(directory).replace(/\\+$/, '').toLowerCase(), outside.toLowerCase());
    fs.unlinkSync(directory);
    fs.renameSync(saved, directory);
    assert.equal(fs.realpathSync(outside), outside);
    fs.rmSync(outside, { recursive: true, force: true });
  }
  const restored = await remote.read(file);
  assert.equal(restored.result.structuredContent.content, 'inside', 'restoring the exact handle target removes the path refusal');
});
