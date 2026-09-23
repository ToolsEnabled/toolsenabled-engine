'use strict';

// Real registry -> provider -> durable SQLite authority -> disposable file.
// This proves the mediated repo read/patch slice, not native CLI coverage or
// semantic dependency inference. No provider accounts or LIVE state are used.
const isolation = require('./lib/isolated-environment').activate('repo-byte-transport');
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { executeTool } = require('../src/lib/tool-registry');
const repo = require('../src/lib/providers/repo-files');
const contexts = require('../src/lib/file-tool-context');
const mcp = require('../src/mcp-server');
const OWNER = Object.freeze({ origin: 'local', tier: 'full' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t, files) {
  const relative = `tests/.repo-byte-transport-${randomUUID()}`;
  const directory = path.join(repo.ROOT, relative);
  assert.ok(directory.startsWith(path.join(repo.ROOT, 'tests') + path.sep));
  fs.mkdirSync(directory);
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), bytes);
  const scopes = [];
  t.after(async () => {
    await Promise.all(scopes.map(scope => contexts.retireFileToolContext(scope, 'test-finished')));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const scope = (agentId = null) => {
    const value = contexts.createFileToolContext({ scopeKind: 'owner-host-session', agentId, sessionId: randomUUID() });
    scopes.push(value);
    return value;
  };
  return {
    scope,
    file: name => `${relative}/${name}`,
    bytes: name => fs.readFileSync(path.join(directory, name)),
    call: (scope, tool, args) => executeTool(tool, args, { permissionSession: OWNER, fileToolContext: scope })
  };
}

test('private scopes cannot be cloned or forged and do not invent canonical launch evidence', async () => {
  const first = contexts.createFileToolContext({ scopeKind: 'owner-host-session', agentId: 'worker', sessionId: 'one' });
  const second = contexts.createFileToolContext({ scopeKind: 'owner-host-session', agentId: 'worker', sessionId: 'two' });
  try {
    assert.equal(first.binding.principal, 'agent:worker');
    assert.notEqual(first.binding.runtimeScopeId, second.binding.runtimeScopeId);
    for (const field of ['canonicalLaunchId', 'laneId', 'runId', 'rosterRef']) assert.equal(first.binding[field], null);
    for (const fake of [undefined, { ...first }, JSON.parse(JSON.stringify(first))]) {
      assert.throws(() => contexts.requireFileToolContext(fake), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
    }
    assert.throws(() => contexts.createFileToolContext({ scopeKind: 'standalone-mcp', agentId: 'worker' }), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
    assert.throws(() => contexts.createFileToolContext({ scopeKind: 'owner-host-session', agentId: 'NotAValidId', sessionId: 'one' }), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  } finally {
    await contexts.retireFileToolContext(first);
    await contexts.retireFileToolContext(second);
  }
  assert.throws(() => contexts.requireFileToolContext(first), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
});

test('registry read and patch preserve BOM, CRLF, Unicode and exact observed byte hashes', async t => {
  const original = Buffer.from('\uFEFFalpha\r\nβeta\r\n😀tail\r\n');
  const f = fixture(t, { 'text.txt': original });
  const scope = f.scope('worker');
  const read = await f.call(scope, 'repo.read_file', { path: f.file('text.txt') });
  assert.equal(read.content, original.toString('utf8'));
  assert.equal(read.bytes, original.length);
  assert.equal(read.receipt.contentSha256, digest(original));
  assert.equal(read.receipt.fileSha256, digest(original));
  assert.equal(read.receipt.binding.runtimeScopeId, scope.binding.runtimeScopeId);
  assert.ok(Number.isSafeInteger(read.receipt.sequence));
  const result = await f.call(scope, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'βeta', newText: 'δelta!' });
  const expected = Buffer.from('\uFEFFalpha\r\nδelta!\r\n😀tail\r\n');
  assert.deepEqual(f.bytes('text.txt'), expected);
  assert.equal(result.startByte, original.indexOf(Buffer.from('βeta')));
  assert.equal(result.preHash, digest(Buffer.from('βeta')));
  assert.equal(result.postHash, digest(Buffer.from('δelta!')));
  assert.equal(result.receipt.fileSha256, digest(expected));
  assert.equal(result.receipt.outcome, 'committed');
});

test('partial reads expose only their window and disjoint edits survive length-changing rebases', async t => {
  const f = fixture(t, { 'text.txt': 'left|right' });
  const left = f.scope('worker-a');
  const right = f.scope('worker-b');
  const a = await f.call(left, 'repo.read_file', { path: f.file('text.txt'), startByte: 0, endByte: 4 });
  const b = await f.call(right, 'repo.read_file', { path: f.file('text.txt'), startByte: 5, endByte: 10 });
  assert.equal(a.content, 'left');
  assert.equal(b.content, 'right');
  assert.equal(b.receipt.contentSha256, digest(Buffer.from('right')));
  assert.equal(b.receipt.bytes, 5);
  await f.call(left, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'left', newText: 'LEFT-LONG' });
  const patched = await f.call(right, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'right', newText: 'RIGHT' });
  assert.equal(patched.startByte, Buffer.byteLength('LEFT-LONG|'));
  assert.equal(f.bytes('text.txt').toString(), 'LEFT-LONG|RIGHT');
});

test('reading a window does not authorize a write to unread bytes', async t => {
  const f = fixture(t, { 'text.txt': 'left|right' });
  const scope = f.scope();
  await f.call(scope, 'repo.read_file', { path: f.file('text.txt'), startByte: 5, endByte: 10 });
  await assert.rejects(f.call(scope, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'left', newText: 'other' }), { code: 'BYTE_READ_REQUIRED' });
  assert.equal(f.bytes('text.txt').toString(), 'left|right');
});

test('a changed read dependency in another file refuses the patch until reconciled reread', async t => {
  const f = fixture(t, { 'target.txt': 'target=old', 'dependency.txt': 'dependency=old' });
  const writer = f.scope('writer');
  const other = f.scope('other');
  await f.call(writer, 'repo.read_file', { path: f.file('target.txt') });
  await f.call(writer, 'repo.read_file', { path: f.file('dependency.txt') });
  await f.call(other, 'repo.read_file', { path: f.file('dependency.txt') });
  await f.call(other, 'repo.patch_file', { path: f.file('dependency.txt'), oldText: 'old', newText: 'new' });
  await assert.rejects(f.call(writer, 'repo.patch_file', { path: f.file('target.txt'), oldText: 'old', newText: 'new' }), error => {
    assert.equal(error.code, 'BYTE_READ_SET_STALE');
    assert.ok(error.details.repairs.some(repair => repair.resource.endsWith('dependency.txt')));
    return true;
  });
  assert.equal(f.bytes('target.txt').toString(), 'target=old');
  const wire = await mcp.dispatch({ jsonrpc: '2.0', id: 'stale-patch', method: 'tools/call', params: {
    name: 'repo.patch_file', arguments: { path: f.file('target.txt'), oldText: 'old', newText: 'new' }
  } }, { permissionSession: OWNER, fileToolContext: writer });
  assert.equal(wire.isError, true);
  assert.equal(wire.structuredContent.error.taxonomy.code, 'STALE_DATA');
  assert.equal(wire.structuredContent.error.taxonomy.retryable, false);
  assert.equal(wire.structuredContent.error.coordination.repairs[0].path, f.file('dependency.txt'));
  assert.ok(wire.content[0].text.includes(f.file('dependency.txt')), 'text-only clients must receive the repair metadata too');
  assert.equal(JSON.stringify(wire).includes('dependency=new'), false, 'unread changed content must not leak as a repair hint');
  await f.call(writer, 'repo.read_file', { path: f.file('dependency.txt') });
  await f.call(writer, 'repo.patch_file', { path: f.file('target.txt'), oldText: 'old', newText: 'new' });
  assert.equal(f.bytes('target.txt').toString(), 'target=new');
});

test('UTF-8 boundary errors and unmatched surrogates cannot create observations or patches', async t => {
  const f = fixture(t, { 'text.txt': Buffer.from('xéz'), 'invalid.txt': Buffer.from([0x61, 0xff]) });
  const scope = f.scope();
  await assert.rejects(f.call(scope, 'repo.read_file', { path: f.file('text.txt'), startByte: 2, endByte: 3 }), { code: 'REPO_FILE_UTF8_BOUNDARY_INVALID' });
  await assert.rejects(f.call(scope, 'repo.read_file', { path: f.file('invalid.txt') }), { code: 'REPO_FILE_UTF8_BOUNDARY_INVALID' });
  await assert.rejects(f.call(scope, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'é', newText: 'E' }), { code: 'BYTE_READ_REQUIRED' });
  await f.call(scope, 'repo.read_file', { path: f.file('text.txt'), startByte: 1, endByte: 3 });
  await assert.rejects(f.call(scope, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'é', newText: '\ud800' }), { code: 'REPO_FILE_PATCH_INVALID' });
  assert.deepEqual(f.bytes('text.txt'), Buffer.from('xéz'));
});

test('a retired scope cannot release queued read content', async t => {
  const f = fixture(t, { 'text.txt': 'private observation' });
  const scope = f.scope();
  const pending = f.call(scope, 'repo.read_file', { path: f.file('text.txt') });
  const closing = contexts.retireFileToolContext(scope, 'session-revoked');
  await assert.rejects(pending, { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  await closing;
});

test('a real hard-link alias is refused and publication preserves mixed-case filenames', async t => {
  const f = fixture(t, { 'MixedCase.txt': 'before' });
  const scope = f.scope();
  const original = path.join(repo.ROOT, f.file('MixedCase.txt'));
  const alias = path.join(repo.ROOT, f.file('alias.txt'));
  fs.linkSync(original, alias);
  await assert.rejects(f.call(scope, 'repo.read_file', { path: f.file('MixedCase.txt') }), { code: 'REPO_FILE_PATH_FORBIDDEN' });
  fs.unlinkSync(alias);
  await f.call(scope, 'repo.read_file', { path: f.file('MixedCase.txt') });
  await f.call(scope, 'repo.patch_file', { path: f.file('MixedCase.txt'), oldText: 'before', newText: 'after' });
  assert.deepEqual(fs.readdirSync(path.dirname(original)), ['MixedCase.txt']);
});

test('a refused publication leaves no changed file and known-unapplied recovery permits a fresh retry', async t => {
  const f = fixture(t, { 'text.txt': 'before' });
  const scope = f.scope();
  const audit = require('../src/lib/audit');
  await f.call(scope, 'repo.read_file', { path: f.file('text.txt') });
  const original = audit.requireRecord;
  audit.requireRecord = function (kind, ...args) {
    if (kind === 'repo.patch_file.intent') throw Object.assign(new Error('injected unavailable intent store'), { code: 'FIXTURE_AUDIT_UNAVAILABLE' });
    return original.call(this, kind, ...args);
  };
  try {
    await assert.rejects(f.call(scope, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'before', newText: 'after' }), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  } finally { audit.requireRecord = original; }
  assert.equal(f.bytes('text.txt').toString(), 'before');
  await f.call(scope, 'repo.read_file', { path: f.file('text.txt') });
  await f.call(scope, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'before', newText: 'after' });
  assert.equal(f.bytes('text.txt').toString(), 'after');
});

test('MCP dispatch requires an actual transport scope, not an actor name or a shared anonymous fallback', async t => {
  const f = fixture(t, { 'text.txt': 'observed' });
  const message = { jsonrpc: '2.0', id: 'byte-read', method: 'tools/call', params: { name: 'repo.read_file', arguments: { path: f.file('text.txt') } } };
  const refused = await mcp.dispatch(message, { permissionSession: OWNER, agentActor: 'worker' });
  assert.equal(refused.isError, true);
  assert.ok(JSON.stringify(refused).includes('REPO_FILE_COORDINATION_IDENTITY_REQUIRED'));
  const scope = f.scope('worker');
  const result = await mcp.dispatch(message, { permissionSession: OWNER, fileToolContext: scope });
  assert.notEqual(result.isError, true);
  const returned = JSON.parse(result.content.find(block => block.type === 'text').text);
  assert.equal(returned.content, 'observed');
  assert.equal(returned.receipt.binding.runtimeScopeId, scope.binding.runtimeScopeId);
  const forged = await mcp.dispatch(message, { permissionSession: OWNER, fileToolContext: JSON.parse(JSON.stringify(scope)) });
  assert.equal(forged.isError, true);
});

test('each registry call returns separate current invocation diagnostics, never durable operation attribution', async t => {
  const f = fixture(t, { 'text.txt': 'before' });
  const scope = f.scope('worker');
  const call = async (name, args) => {
    const result = await mcp.dispatch({ jsonrpc: '2.0', id: 'reused-client-correlation', method: 'tools/call', params: { name, arguments: args } }, {
      permissionSession: OWNER, fileToolContext: scope,
      agentSessionId: 'caller-context-is-not-session-authority',
      fileToolInvocation: { invocationId: 'caller-context-is-not-call-authority' }
    });
    assert.notEqual(result.isError, true);
    return JSON.parse(result.content[0].text);
  };
  const read = await call('repo.read_file', { path: f.file('text.txt') });
  const patch = await call('repo.patch_file', { path: f.file('text.txt'), oldText: 'before', newText: 'after' });
  const noOp = await call('repo.write_file', { path: f.file('text.txt'), content: 'after' });
  const calls = [read, patch, noOp];
  assert.equal(new Set(calls.map(result => result.currentToolInvocation?.invocationId)).size, 3);
  for (const [index, result] of calls.entries()) {
    const metadata = result.currentToolInvocation;
    assert.match(metadata.invocationId, /^invocation-[0-9a-f-]{36}$/);
    assert.equal(metadata.toolName, ['repo.read_file', 'repo.patch_file', 'repo.write_file'][index]);
    assert.equal(metadata.runtimeScopeId, scope.binding.runtimeScopeId);
    assert.equal(metadata.sessionAssociation.kind, 'owner-host-accepted-session');
    assert.notEqual(metadata.sessionAssociation.sessionId, 'caller-context-is-not-session-authority');
    assert.equal(Object.hasOwn(result.receipt, 'currentToolInvocation'), false);
    assert.equal(Object.hasOwn(result.receipt.binding, 'sessionAssociation'), false);
    assert.equal(Object.hasOwn(result.receipt.binding, 'sessionId'), false);
  }
  assert.equal(noOp.receipt.noOp, true);
  assert.equal(f.bytes('text.txt').toString(), 'after');
  assert.throws(() => repo.readFile({ path: f.file('text.txt') }, {
    fileToolContext: scope, fileToolInvocation: read.currentToolInvocation
  }), { code: 'REPO_FILE_INVOCATION_INVALID' });
  const legacy = repo.readFile({ path: f.file('text.txt') });
  assert.equal(legacy.content, 'after');
  assert.equal(Object.hasOwn(legacy, 'currentToolInvocation'), false);
  assert.equal(Object.hasOwn(legacy, 'receipt'), false);
});

test('registry owns the invocation capability and retires it after both success and refusal', async t => {
  const f = fixture(t, { 'text.txt': 'before' });
  const scope = f.scope('worker');
  const observed = [];
  const readFile = repo.readFile;
  const patchFile = repo.patchFile;
  const audit = require('../src/lib/audit');
  repo.readFile = (args, options) => { observed.push({ ...options, toolName: 'repo.read_file' }); return readFile(args, options); };
  repo.patchFile = (args, options) => { observed.push({ ...options, toolName: 'repo.patch_file' }); return patchFile(args, options); };
  let read;
  try {
    read = await executeTool('repo.read_file', { path: f.file('text.txt') }, {
      permissionSession: OWNER, fileToolContext: scope,
      fileToolInvocation: { invocationId: 'caller-forged' }, agentSessionId: 'caller-forged-session'
    });
    await assert.rejects(f.call(scope, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'missing', newText: 'after' }), { code: 'REPO_FILE_PATCH_MISMATCH' });
  } finally { repo.readFile = readFile; repo.patchFile = patchFile; }
  assert.equal(observed.length, 2);
  assert.ok(process.env.TOOLSENABLED_AUDIT_DB.startsWith(isolation.root + path.sep));
  const audited = audit.tail(20).filter(event => event.action === 'mcp.tool.succeeded' && event.target === 'repo.read_file')
    .map(event => event.details.invocationId);
  assert.ok(audited.includes(read.currentToolInvocation.invocationId), 'the diagnostic uses the actual registry audit invocation, not another generated ID');
  for (const call of observed) {
    assert.throws(() => contexts.assertFileToolInvocationCurrent(call.fileToolInvocation, scope, call.toolName), { code: 'REPO_FILE_INVOCATION_INVALID' });
  }
  assert.throws(() => repo.readFile({ path: f.file('text.txt') }, { fileToolInvocation: read.currentToolInvocation }), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  assert.equal(contexts.requireFileToolContext(scope), scope.binding);
  await f.call(scope, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'before', newText: 'after' });
  assert.equal(f.bytes('text.txt').toString(), 'after', 'ending prior invocations must not discard their live scope observations');
});

test('ending the actual invocation during materialization releases no content or read authority', async t => {
  const f = fixture(t, { 'text.txt': 'private bytes' });
  const scope = f.scope();
  const target = path.join(repo.ROOT, f.file('text.txt')).toLowerCase();
  const readFile = repo.readFile;
  const open = fs.openSync;
  const read = fs.readSync;
  let capability;
  let targetDescriptor;
  let interrupted = false;
  repo.readFile = (args, options) => { capability = options.fileToolInvocation; return readFile(args, options); };
  fs.openSync = (filename, ...args) => {
    const descriptor = open(filename, ...args);
    if (typeof filename === 'string' && filename.toLowerCase() === target) targetDescriptor = descriptor;
    return descriptor;
  };
  fs.readSync = (descriptor, ...args) => {
    const count = read(descriptor, ...args);
    if (descriptor === targetDescriptor && count > 0 && !interrupted) {
      interrupted = true;
      contexts.endFileToolInvocation(capability);
    }
    return count;
  };
  try { await assert.rejects(f.call(scope, 'repo.read_file', { path: f.file('text.txt') }), { code: 'REPO_FILE_INVOCATION_INVALID' }); }
  finally { repo.readFile = readFile; fs.openSync = open; fs.readSync = read; }
  assert.equal(interrupted, true, 'the actual descriptor delivered bytes before currentness was revoked');
  await assert.rejects(f.call(scope, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'private', newText: 'public' }), { code: 'BYTE_READ_REQUIRED' });
  await f.call(scope, 'repo.read_file', { path: f.file('text.txt') });
  await f.call(scope, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'private', newText: 'public' });
});

test('ending the actual write invocation after staging still refuses before atomic replacement', async t => {
  const f = fixture(t, { 'text.txt': 'before' });
  const scope = f.scope();
  const directory = path.dirname(path.join(repo.ROOT, f.file('text.txt'))).toLowerCase();
  const writeFile = repo.writeFile;
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  let capability;
  let stagingDescriptor;
  let interrupted = false;
  repo.writeFile = (args, options) => { capability = options.fileToolInvocation; return writeFile(args, options); };
  fs.openSync = (filename, ...args) => {
    const descriptor = open(filename, ...args);
    if (typeof filename === 'string' && path.dirname(filename).toLowerCase() === directory
        && path.basename(filename).startsWith('.te-replace-')) stagingDescriptor = descriptor;
    return descriptor;
  };
  fs.fsyncSync = descriptor => {
    const result = sync(descriptor);
    if (descriptor === stagingDescriptor && !interrupted) {
      interrupted = true;
      contexts.endFileToolInvocation(capability);
    }
    return result;
  };
  try { await assert.rejects(f.call(scope, 'repo.write_file', { path: f.file('text.txt'), content: 'after' }), { code: 'REPO_FILE_INVOCATION_INVALID' }); }
  finally { repo.writeFile = writeFile; fs.openSync = open; fs.fsyncSync = sync; }
  assert.equal(interrupted, true, 'the real staged file was flushed before revocation');
  assert.equal(f.bytes('text.txt').toString(), 'before');
  const fresh = await f.call(scope, 'repo.read_file', { path: f.file('text.txt') });
  assert.equal(fresh.content, 'before', 'known-unapplied recovery must leave the scope usable');
  await f.call(scope, 'repo.write_file', { path: f.file('text.txt'), content: 'after' });
});

test('ending a call after publication preserves the committed-effect warning', async t => {
  const f = fixture(t, { 'text.txt': 'before' });
  const scope = f.scope();
  const target = path.join(repo.ROOT, f.file('text.txt'));
  const writeFile = repo.writeFile;
  const rename = fs.renameSync;
  let capability;
  let published = false;
  repo.writeFile = (args, options) => { capability = options.fileToolInvocation; return writeFile(args, options); };
  fs.renameSync = (source, destination) => {
    const result = rename(source, destination);
    if (destination === target) {
      published = true;
      contexts.endFileToolInvocation(capability);
    }
    return result;
  };
  try {
    await assert.rejects(f.call(scope, 'repo.write_file', { path: f.file('text.txt'), content: 'after' }), error => {
      assert.equal(error.code, 'BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED');
      assert.equal(error.details.publicationCommitted, true);
      assert.equal(error.details.causeCode, 'REPO_FILE_INVOCATION_INVALID');
      assert.match(error.details.operationId, /^operation-/);
      return true;
    });
  } finally { repo.writeFile = writeFile; fs.renameSync = rename; }
  assert.equal(published, true);
  assert.equal(f.bytes('text.txt').toString(), 'after');
  assert.equal((await f.call(scope, 'repo.read_file', { path: f.file('text.txt') })).content, 'after');
});

test('MCP repair projection is bounded, strips unread bytes, and preserves committed-vs-unknown outcomes', async t => {
  const { ByteCoordinationRefusal } = require('../src/lib/region-holds/byte-authority');
  const f = fixture(t, { 'text.txt': 'before' });
  const resource = path.join(repo.ROOT, f.file('text.txt'));
  const stale = new ByteCoordinationRefusal('BYTE_READ_SET_STALE', 'Reread the changed regions.', {
    repairs: Array.from({ length: 35 }, () => ({ resource, reason: 'MEDIATED_WRITE', startByte: 0, endByte: 6,
      currentBytes: Buffer.from('unreleased sentinel'), privateProviderDetails: 'unreleased sentinel' }))
  });
  const wire = mcp.toolError(stale);
  assert.equal(wire.structuredContent.error.coordination.repairs.length, 32);
  assert.equal(wire.structuredContent.error.coordination.omittedRepairs, 3);
  assert.equal(JSON.stringify(wire).includes('unreleased sentinel'), false);
  const ordinary = Object.assign(new Error('Ordinary source'), { code: stale.code, details: stale.details });
  assert.equal(mcp.toolError(ordinary).structuredContent.error.coordination, undefined, 'an arbitrary Error cannot publish its details by copying a code');
  for (const [code, committed] of [
    ['BYTE_PUBLICATION_UNCONFIRMED', 'unknown'], ['BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED', true]
  ]) {
    const outcome = mcp.toolError(new ByteCoordinationRefusal(code, 'Inspect before retrying.', {
      publicationCommitted: true, operationId: 'operation-fixture', resource, noOp: false
    }));
    assert.equal(outcome.structuredContent.error.taxonomy.code, 'EXTERNAL_CHANGE');
    assert.equal(outcome.structuredContent.error.taxonomy.retryable, false);
    assert.equal(outcome.structuredContent.error.coordination.publicationCommitted, committed);
    assert.ok(outcome.content[0].text.includes('inspect-before-retrying'));
  }
  for (const code of ['BYTE_STATE_CORRUPT', 'BYTE_STATE_MISSING']) {
    const refused = mcp.toolError(new ByteCoordinationRefusal(code, 'private diagnostic', { resource }));
    assert.equal(refused.structuredContent.error.taxonomy.code, 'VERIFICATION_FAILED');
    assert.equal(JSON.stringify(refused).includes('private diagnostic'), false);
    assert.equal(refused.structuredContent.error.coordination, undefined);
  }
});

test('legacy whole-file writes remain explicitly unmediated and invalidate a prior coordinated read', async t => {
  const f = fixture(t, { 'text.txt': 'before' });
  const scope = f.scope();
  await f.call(scope, 'repo.read_file', { path: f.file('text.txt') });
  const written = repo.writeFile({ path: f.file('text.txt'), content: 'external' });
  assert.equal(Object.hasOwn(written, 'receipt'), false, 'compatibility writes must not advertise a coordinated receipt');
  await assert.rejects(f.call(scope, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'external', newText: 'lost' }), { code: 'BYTE_READ_SET_STALE' });
  assert.equal(f.bytes('text.txt').toString(), 'external');
});

test('whole-file tool writes require a private scope and do not manufacture read observations', async t => {
  const f = fixture(t, { 'MixedCase.txt': 'before' });
  await assert.rejects(executeTool('repo.write_file', { path: f.file('MixedCase.txt'), content: 'forged' }, { permissionSession: OWNER }),
    { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  const scope = f.scope();
  const result = await f.call(scope, 'repo.write_file', { path: f.file('MixedCase.txt'), content: '\uFEFFafter\r\n' });
  assert.equal(result.created, false);
  assert.equal(result.receipt.outcome, 'committed');
  assert.equal(result.receipt.binding.runtimeScopeId, scope.binding.runtimeScopeId);
  assert.equal(result.receipt.fileSha256, digest(Buffer.from('\uFEFFafter\r\n')));
  assert.equal(f.bytes('MixedCase.txt').toString('utf8'), '\uFEFFafter\r\n');
  assert.deepEqual(fs.readdirSync(path.dirname(path.join(repo.ROOT, f.file('MixedCase.txt')))), ['MixedCase.txt']);
  await assert.rejects(f.call(scope, 'repo.patch_file', { path: f.file('MixedCase.txt'), oldText: 'after', newText: 'lost' }), { code: 'BYTE_READ_REQUIRED' });
});

test('whole-file tool creation preserves case, creates parents, and treats empty creation as an effect', async t => {
  const f = fixture(t, {});
  const scope = f.scope();
  const result = await f.call(scope, 'repo.write_file', { path: f.file('NewParent/EmptyFile.txt'), content: '' });
  assert.equal(result.created, true);
  assert.equal(result.bytes, 0);
  assert.equal(result.receipt.noOp, false);
  assert.equal(result.receipt.outcome, 'committed');
  assert.equal(f.bytes('NewParent/EmptyFile.txt').length, 0);
  const parent = path.join(repo.ROOT, f.file('NewParent'));
  assert.deepEqual(fs.readdirSync(parent), ['EmptyFile.txt']);
  assert.equal(fs.lstatSync(path.join(parent, 'EmptyFile.txt')).nlink, 1);
  const read = await f.call(scope, 'repo.read_file', { path: f.file('NewParent/EmptyFile.txt') });
  assert.equal(read.content, '');
});

test('whole-file writes validate dependencies, invalidate observations, and reject lossy text', async t => {
  const f = fixture(t, { 'target.txt': 'before', 'dependency.txt': 'old' });
  const writer = f.scope();
  const other = f.scope();
  await f.call(writer, 'repo.read_file', { path: f.file('dependency.txt') });
  await f.call(other, 'repo.write_file', { path: f.file('dependency.txt'), content: 'new' });
  await assert.rejects(f.call(writer, 'repo.write_file', { path: f.file('target.txt'), content: 'after' }), { code: 'BYTE_READ_SET_STALE' });
  assert.equal(f.bytes('target.txt').toString(), 'before');
  await f.call(writer, 'repo.read_file', { path: f.file('dependency.txt') });
  await f.call(writer, 'repo.read_file', { path: f.file('target.txt') });
  await f.call(writer, 'repo.write_file', { path: f.file('target.txt'), content: 'after' });
  await assert.rejects(f.call(writer, 'repo.patch_file', { path: f.file('target.txt'), oldText: 'after', newText: 'lost' }), { code: 'BYTE_READ_SET_STALE' });
  await assert.rejects(f.call(other, 'repo.write_file', { path: f.file('target.txt'), content: '\ud800' }), { code: 'REPO_FILE_CONTENT_INVALID' });
  assert.equal(f.bytes('target.txt').toString(), 'after');
});

test('a valid long filename is not amplified into an invalid creation or replacement stage', async t => {
  const f = fixture(t, {});
  const scope = f.scope();
  const name = 'Long' + 'x'.repeat(216) + '.txt';
  assert.equal(Buffer.byteLength(name), 224);
  await f.call(scope, 'repo.write_file', { path: f.file(name), content: 'created' });
  await f.call(scope, 'repo.write_file', { path: f.file(name), content: 'replaced' });
  await f.call(scope, 'repo.read_file', { path: f.file(name) });
  await f.call(scope, 'repo.patch_file', { path: f.file(name), oldText: 'replaced', newText: 'patched' });
  assert.equal(f.bytes(name).toString(), 'patched');
  assert.deepEqual(fs.readdirSync(path.join(repo.ROOT, f.file('.'))), [name]);
});

test('creation interrupted after atomic link is recovered before the ordinary hard-link refusal', async t => {
  const f = fixture(t, {});
  const scope = f.scope();
  const target = path.join(repo.ROOT, f.file('RecoverMe.txt'));
  const link = fs.linkSync;
  let stage;
  fs.linkSync = (source, destination) => {
    const result = link(source, destination);
    if (destination === target) {
      stage = source;
      throw Object.assign(new Error('injected interruption after publication'), { code: 'FIXTURE_POST_LINK' });
    }
    return result;
  };
  try { await assert.rejects(f.call(scope, 'repo.write_file', { path: f.file('RecoverMe.txt'), content: 'recoverable' }), { code: 'BYTE_PUBLICATION_UNCONFIRMED' }); }
  finally { fs.linkSync = link; }
  assert.ok(stage);
  assert.equal(fs.lstatSync(target).nlink, 2);
  const { DatabaseSync } = require('node:sqlite');
  const dataFile = path.join(require('../src/lib/runtime-state-root').statePath(), 'state', 'byte-coordination', 'data.sqlite');
  assert.ok(dataFile.startsWith(isolation.root + path.sep), 'journal inspection stays in the isolated test state');
  const operation = () => {
    const db = new DatabaseSync(dataFile, { readOnly: true });
    try { return db.prepare('SELECT * FROM operations WHERE json_extract(operation_json,\'$.resource\')=?').get(process.platform === 'win32' ? target.toLowerCase() : target); }
    finally { db.close(); }
  };
  const beforeRecovery = operation();
  assert.equal(beforeRecovery.status, 'PREPARED');
  const recoverer = f.scope();
  const read = await f.call(recoverer, 'repo.read_file', { path: f.file('RecoverMe.txt') });
  assert.equal(read.content, 'recoverable');
  assert.equal(read.currentToolInvocation.runtimeScopeId, recoverer.binding.runtimeScopeId);
  const afterRecovery = operation();
  assert.equal(afterRecovery.status, 'COMMITTED');
  assert.equal(afterRecovery.operation_json, beforeRecovery.operation_json, 'recovery must not rewrite the durable origin or checksum');
  const recoveredReceipt = JSON.parse(afterRecovery.receipt_json);
  assert.equal(recoveredReceipt.binding.runtimeScopeId, scope.binding.runtimeScopeId);
  assert.equal(Object.hasOwn(recoveredReceipt, 'currentToolInvocation'), false);
  assert.equal(Object.hasOwn(recoveredReceipt.binding, 'sessionAssociation'), false);
  assert.equal(afterRecovery.operation_json.includes(read.currentToolInvocation.invocationId), false);
  assert.equal(afterRecovery.receipt_json.includes(read.currentToolInvocation.invocationId), false);
  assert.equal(fs.existsSync(stage), false);
  assert.equal(fs.lstatSync(target).nlink, 1);
  await f.call(recoverer, 'repo.patch_file', { path: f.file('RecoverMe.txt'), oldText: 'recoverable', newText: 'recovered' });
  assert.equal(f.bytes('RecoverMe.txt').toString(), 'recovered');
});

test('atomic creation does not clobber an intervening file and unknown identity preserves both leaves', async t => {
  const f = fixture(t, {});
  const scope = f.scope();
  const target = path.join(repo.ROOT, f.file('Collision.txt'));
  const link = fs.linkSync;
  let stage;
  fs.linkSync = (source, destination) => {
    if (destination === target) {
      stage = source;
      fs.writeFileSync(destination, 'intervening editor', { flag: 'wx' });
    }
    return link(source, destination);
  };
  try { await assert.rejects(f.call(scope, 'repo.write_file', { path: f.file('Collision.txt'), content: 'our intended content' }), { code: 'BYTE_PUBLICATION_UNCONFIRMED' }); }
  finally { fs.linkSync = link; }
  assert.equal(f.bytes('Collision.txt').toString(), 'intervening editor');
  await assert.rejects(f.call(scope, 'repo.read_file', { path: f.file('Collision.txt') }), { code: 'BYTE_RECOVERY_UNRESOLVED' });
  assert.equal(fs.readFileSync(stage, 'utf8'), 'our intended content');
  assert.equal(f.bytes('Collision.txt').toString(), 'intervening editor');
});

test('same-byte replacement is not recovered as our creation when the staged link is absent', async t => {
  const f = fixture(t, { 'replacement.txt': 'same bytes' });
  const scope = f.scope();
  const target = path.join(repo.ROOT, f.file('Created.txt'));
  const replacement = path.join(repo.ROOT, f.file('replacement.txt'));
  const replacementIdentity = fs.lstatSync(replacement, { bigint: true }).ino;
  const link = fs.linkSync;
  fs.linkSync = (source, destination) => {
    const result = link(source, destination);
    if (destination === target) {
      assert.notEqual(fs.lstatSync(source, { bigint: true }).ino, replacementIdentity);
      fs.unlinkSync(source);
      fs.renameSync(replacement, destination);
      throw Object.assign(new Error('injected replacement after published link'), { code: 'FIXTURE_REPLACED' });
    }
    return result;
  };
  try { await assert.rejects(f.call(scope, 'repo.write_file', { path: f.file('Created.txt'), content: 'same bytes' }), { code: 'BYTE_PUBLICATION_UNCONFIRMED' }); }
  finally { fs.linkSync = link; }
  await assert.rejects(f.call(scope, 'repo.read_file', { path: f.file('Created.txt') }), { code: 'BYTE_RECOVERY_UNRESOLVED' });
  assert.equal(fs.lstatSync(target, { bigint: true }).ino, replacementIdentity);
  assert.equal(f.bytes('Created.txt').toString(), 'same bytes');
});

test('whole-file creation requires durable audit before creating parents or a staged leaf', async t => {
  const f = fixture(t, {});
  const scope = f.scope();
  const audit = require('../src/lib/audit');
  const original = audit.requireRecord;
  audit.requireRecord = function (kind, ...args) {
    if (kind === 'repo.write_file.intent') throw Object.assign(new Error('injected unavailable audit'), { code: 'FIXTURE_AUDIT_UNAVAILABLE' });
    return original.call(this, kind, ...args);
  };
  try { await assert.rejects(f.call(scope, 'repo.write_file', { path: f.file('NotCreated/file.txt'), content: 'after' }), { code: 'FIXTURE_AUDIT_UNAVAILABLE' }); }
  finally { audit.requireRecord = original; }
  assert.deepEqual(fs.readdirSync(path.join(repo.ROOT, f.file('.'))), []);
  await f.call(scope, 'repo.write_file', { path: f.file('NotCreated/file.txt'), content: 'after' });
  assert.equal(f.bytes('NotCreated/file.txt').toString(), 'after');
});

test('scope retirement after whole-file replacement reports committed effect instead of an unapplied refusal', async t => {
  const f = fixture(t, { 'text.txt': 'before' });
  const scope = f.scope();
  const target = path.join(repo.ROOT, f.file('text.txt'));
  const rename = fs.renameSync;
  let closing;
  fs.renameSync = (source, destination) => {
    const result = rename(source, destination);
    if (destination === target) closing = contexts.retireFileToolContext(scope, 'fixture-post-publication');
    return result;
  };
  try {
    await assert.rejects(f.call(scope, 'repo.write_file', { path: f.file('text.txt'), content: 'after' }), error => {
      assert.equal(error.code, 'BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED');
      assert.equal(error.details.publicationCommitted, true);
      assert.equal(typeof error.details.operationId, 'string');
      return true;
    });
  } finally { fs.renameSync = rename; await closing; }
  assert.equal(f.bytes('text.txt').toString(), 'after');
});

test('real owner-host sessions carry separate private scopes through MCP and revoke them immediately', async t => {
  const net = require('node:net');
  const { createOwnerHost } = require('../src/owner-host');
  const f = fixture(t, { 'text.txt': 'owner-host bytes' });
  const seenScopes = new Map();
  const sockets = [];
  const pipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\ToolsEnabledByteScope-${process.pid}-${randomUUID()}`
    : path.join(isolation.root, `byte-scope-${randomUUID()}.sock`);
  const capabilityFile = path.join(isolation.root, `byte-owner-${randomUUID()}.json`);
  const host = createOwnerHost({
    allowTestPaths: true, platform: 'test', pipeName, capabilityFile,
    controlCapabilityFile: `${capabilityFile}.control`,
    principals: { ownerPrincipal: 'TESTHOST\\byte-fixture', clientPrincipal: 'TESTHOST\\byte-fixture' },
    credentialHygiene() {}, sessionRetirementObserver() {},
    readInstalledOrg: principal => ({
      org: { revision: 1, agents: [{ id: 'agent-a', role: 'worker', provider: 'claude', enabled: true }] },
      roleRecord: { definition: { id: principal.roleId }, revision: 1 }
    }),
    // Identity lookup and ACL publication are isolated dependencies here;
    // the transport, binding, dispatcher, registry, provider and DB are real.
    broker: { ...mcp, recordMcpSurface() {}, resolvePermissionSession: () => OWNER,
      createLineDispatcher: options => {
        const dispatch = mcp.createLineDispatcher(options);
        return (line, respond, callOptions, connectionKey) => {
          seenScopes.set(callOptions.agentSessionId, callOptions.fileToolContext);
          return dispatch(line, respond, callOptions, connectionKey);
        };
      }
    }
  });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await host.close(); });
  await host.listen();
  const exchange = (socket, request) => new Promise((resolve, reject) => {
    let pending = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('owner-host response deadline')); }, 10000);
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => onError(new Error('owner-host socket closed before response'));
    const onData = chunk => {
      pending += chunk;
      const end = pending.indexOf('\n');
      if (end < 0) return;
      cleanup();
      try { resolve(JSON.parse(pending.slice(0, end))); } catch (error) { reject(error); }
    };
    socket.setEncoding('utf8');
    socket.on('data', onData); socket.once('error', onError); socket.once('close', onClose);
    socket.write(`${JSON.stringify(request)}\n`);
  });
  const bindingFor = sessionId => ({ sessionId, agentId: 'agent-a', provider: 'claude', roleId: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 });
  const connect = async sessionId => {
    const binding = bindingFor(sessionId);
    const bound = await host.bindSession(binding);
    const socket = net.connect({ path: pipeName });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    assert.equal((await exchange(socket, { type: 'authorize-session', credential: bound.credential })).type, 'authorized');
    return { socket, binding, credential: bound.credential };
  };
  const one = await connect('byte-session-one');
  const two = await connect('byte-session-two');
  const call = (connection, name, args, requestId = randomUUID()) => exchange(connection.socket, { jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } });
  const first = await call(one, 'repo.read_file', { path: f.file('text.txt') }, 'repeated-correlation');
  assert.notEqual(first.result.isError, true);
  const read = JSON.parse(first.result.content[0].text);
  assert.equal(read.content, 'owner-host bytes');
  assert.equal(read.receipt.binding.principal, 'agent:agent-a');
  assert.equal(read.receipt.binding.scopeKind, 'owner-host-session');
  assert.deepEqual(read.currentToolInvocation.sessionAssociation, { kind: 'owner-host-accepted-session', sessionId: 'byte-session-one' });
  const patched = await call(one, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'bytes', newText: 'changed' }, 'repeated-correlation');
  assert.notEqual(patched.result.isError, true);
  const patch = JSON.parse(patched.result.content[0].text);
  assert.notEqual(patch.currentToolInvocation.invocationId, read.currentToolInvocation.invocationId);
  assert.equal(patch.currentToolInvocation.toolName, 'repo.patch_file');
  const written = await call(one, 'repo.write_file', { path: f.file('text.txt'), content: 'whole file' }, 'repeated-correlation');
  assert.notEqual(written.result.isError, true);
  const write = JSON.parse(written.result.content[0].text);
  assert.equal(new Set([read, patch, write].map(value => value.currentToolInvocation.invocationId)).size, 3);
  assert.deepEqual(write.currentToolInvocation.sessionAssociation, read.currentToolInvocation.sessionAssociation);
  const forged = await call(one, 'repo.write_file', { path: f.file('text.txt'), content: 'forged write', currentToolInvocation: read.currentToolInvocation });
  assert.equal(forged.error?.code, -32602, 'caller-injected metadata must be rejected by the actual argument schema');
  assert.equal(f.bytes('text.txt').toString(), 'whole file');
  const second = await call(two, 'repo.patch_file', { path: f.file('text.txt'), oldText: 'bytes', newText: 'changed' });
  assert.equal(second.result.isError, true);
  assert.ok(JSON.stringify(second.result).includes('BYTE_READ_REQUIRED'), 'the other same-agent session cannot borrow its read');
  const firstScope = seenScopes.get('byte-session-one');
  const secondScope = seenScopes.get('byte-session-two');
  assert.notEqual(firstScope.binding.runtimeScopeId, secondScope.binding.runtimeScopeId);
  await host.revokeSession({ ...one.binding, credential: one.credential });
  assert.throws(() => contexts.requireFileToolContext(firstScope), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
  assert.equal(contexts.requireFileToolContext(secondScope).principal, 'agent:agent-a');
  await host.close();
  assert.throws(() => contexts.requireFileToolContext(secondScope), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
});
