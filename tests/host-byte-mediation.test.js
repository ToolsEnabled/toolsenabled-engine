'use strict';

// Host byte mediation: real registry -> host provider -> host ByteAuthority
// (its own SQLite store) -> disposable files under the isolated test root.
// The runner places that root under the owner profile's temporary directory,
// so host.* profile containment remains real. No LIVE state, provider accounts
// or network are used.
//
// Proofs (contract bytemed 2026-09-11): 1 A/B clobber, 2 external change,
// 3 creation race, 4 disjoint/overlapping patches, 5 kill switch, 6 existing
// refusals, 7 retention bound, 8 PREPARED->COMMITTED crash recovery,
// 9 per-transport scope through the MCP dispatch path.
const isolation = require('./lib/isolated-environment').activate('host-byte-mediation');
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { executeTool } = require('../src/lib/tool-registry');
const host = require('../src/lib/providers/host-control');
const contexts = require('../src/lib/file-tool-context');
const mcp = require('../src/mcp-server');
const OWNER = Object.freeze({ origin: 'local', tier: 'full' });
const HOME = process.platform === 'linux' ? os.userInfo().homedir : os.homedir();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ENV = 'TOOLSENABLED_HOST_BYTE_MEDIATION';

function fixture(t, files = {}) {
  const directory = path.join(isolation.root, `host-byte-mediation-${process.pid}-${randomUUID()}`);
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
    directory, scope,
    file: name => path.join(directory, name),
    bytes: name => fs.readFileSync(path.join(directory, name)),
    call: (scope, tool, args) => executeTool(tool, args, { permissionSession: OWNER, fileToolContext: scope })
  };
}

function withEnv(value, fn) {
  const before = process.env[ENV];
  if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
  const restore = () => { if (before === undefined) delete process.env[ENV]; else process.env[ENV] = before; };
  let result;
  try { result = fn(); } catch (error) { restore(); throw error; }
  return Promise.resolve(result).finally(restore);
}

const refusesWith = code => error => { assert.equal(error.code, code, `${error.code}: ${error.message}`); return true; };

test('1. two scopes read, B writes, A\'s stale whole-file write refuses instead of clobbering B', async t => {
  const f = fixture(t, { 'shared.txt': 'base line\n' });
  const a = f.scope('worker-a');
  const b = f.scope('worker-b');
  const readA = await f.call(a, 'host.read_file', { path: f.file('shared.txt') });
  const readB = await f.call(b, 'host.read_file', { path: f.file('shared.txt') });
  assert.equal(readA.content, 'base line\n');
  assert.equal(readB.content, 'base line\n');
  await f.call(b, 'host.write_file', { path: f.file('shared.txt'), content: 'B wrote this\n' });
  await assert.rejects(f.call(a, 'host.write_file', { path: f.file('shared.txt'), content: 'A clobbers\n' }), error => {
    assert.equal(error.code, 'HOST_FILE_STALE');
    assert.match(error.message, /Re-read it with host\.read_file/);
    assert.match(error.message, /Nothing was written/);
    return true;
  });
  assert.equal(f.bytes('shared.txt').toString(), 'B wrote this\n', 'B\'s committed write must survive');
  // Reconcile path: A re-reads, then its write lands.
  const reread = await f.call(a, 'host.read_file', { path: f.file('shared.txt') });
  assert.equal(reread.content, 'B wrote this\n');
  const written = await f.call(a, 'host.write_file', { path: f.file('shared.txt'), content: 'B wrote this\nA adds\n' });
  assert.equal(written.bytes, Buffer.byteLength('B wrote this\nA adds\n'));
  assert.equal(f.bytes('shared.txt').toString(), 'B wrote this\nA adds\n');
});

test('1b. a scope that never read an existing file cannot replace it; its own write leaves it current', async t => {
  const f = fixture(t, { 'existing.txt': 'someone else\n' });
  const a = f.scope('worker-a');
  await assert.rejects(f.call(a, 'host.write_file', { path: f.file('existing.txt'), content: 'blind\n' }), refusesWith('HOST_FILE_READ_REQUIRED'));
  assert.equal(f.bytes('existing.txt').toString(), 'someone else\n');
  // A byte window is not the whole file: replacing unseen bytes refuses.
  await f.call(a, 'host.read_file', { path: f.file('existing.txt'), startByte: 0, endByte: 4 });
  await assert.rejects(f.call(a, 'host.write_file', { path: f.file('existing.txt'), content: 'blind\n' }), refusesWith('HOST_FILE_READ_REQUIRED'));
  await f.call(a, 'host.read_file', { path: f.file('existing.txt') });
  const first = await f.call(a, 'host.write_file', { path: f.file('existing.txt'), content: 'one\n' });
  assert.equal(first.observation.source, 'own-publication');
  // The writer's knowledge is exact: consecutive writes and patches need no reread.
  await f.call(a, 'host.write_file', { path: f.file('existing.txt'), content: 'two\n' });
  await f.call(a, 'host.patch_file', { path: f.file('existing.txt'), oldText: 'two', newText: 'three' });
  assert.equal(f.bytes('existing.txt').toString(), 'three\n');
});

test('2. an external fs.writeFileSync after A\'s read makes A\'s write and patch refuse', async t => {
  const f = fixture(t, { 'external.txt': 'alpha\nbeta\n' });
  const a = f.scope('worker-a');
  await f.call(a, 'host.read_file', { path: f.file('external.txt') });
  fs.writeFileSync(f.file('external.txt'), 'alpha\nbeta\nexternal\n');
  await assert.rejects(f.call(a, 'host.write_file', { path: f.file('external.txt'), content: 'mine\n' }), error => {
    assert.equal(error.code, 'HOST_FILE_STALE');
    assert.match(error.message, /changed outside mediated tools/);
    return true;
  });
  await assert.rejects(f.call(a, 'host.patch_file', { path: f.file('external.txt'), oldText: 'beta', newText: 'gamma' }), refusesWith('HOST_FILE_STALE'));
  assert.equal(f.bytes('external.txt').toString(), 'alpha\nbeta\nexternal\n');
  // Deletion is a change too; observing the absence lets the scope create again.
  fs.rmSync(f.file('external.txt'));
  await assert.rejects(f.call(a, 'host.write_file', { path: f.file('external.txt'), content: 'recreated\n' }), refusesWith('HOST_FILE_STALE'));
  await assert.rejects(f.call(a, 'host.read_file', { path: f.file('external.txt') }), refusesWith('HOST_PATH_NOT_FOUND'));
  const created = await f.call(a, 'host.write_file', { path: f.file('external.txt'), content: 'recreated\n' });
  assert.equal(created.created, true);
  assert.equal(f.bytes('external.txt').toString(), 'recreated\n');
});

test('3. creation race: exactly one of many concurrent creators wins, the rest refuse', async t => {
  const f = fixture(t);
  const scopes = Array.from({ length: 6 }, (_, index) => f.scope(`creator-${index}`));
  const outcomes = await Promise.allSettled(scopes.map((scope, index) =>
    f.call(scope, 'host.write_file', { path: f.file('nested/new.txt'), content: `creator ${index}\n` })));
  const winners = outcomes.filter(outcome => outcome.status === 'fulfilled');
  const losers = outcomes.filter(outcome => outcome.status === 'rejected');
  assert.equal(winners.length, 1, JSON.stringify(losers.map(loser => loser.reason.code)));
  assert.equal(winners[0].value.created, true);
  for (const loser of losers) assert.ok(['HOST_FILE_READ_REQUIRED', 'HOST_FILE_STALE'].includes(loser.reason.code), loser.reason.code);
  const index = outcomes.findIndex(outcome => outcome.status === 'fulfilled');
  assert.equal(f.bytes('nested/new.txt').toString(), `creator ${index}\n`);
  assert.deepEqual(fs.readdirSync(path.join(f.directory, 'nested')), ['new.txt'], 'no staged creation leaves remain');
});

test('3b. an unmediated creator inside the publication window wins; the mediated create aborts, never freezes', async t => {
  const f = fixture(t);
  const target = f.file('window.txt');
  const { createByteAuthority } = require('../src/lib/region-holds/byte-authority');
  const seam = host.hostCoordination;
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-byte-window-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const authority = createByteAuthority({
    stateRoot, storeName: host.HOST_BYTE_STORE, maxResourceBytes: host.MAX_FILE_BYTES,
    readSetScope: 'resource', writeRequiresObservation: true, observeOwnWrites: true, pruneCommittedPayloads: true,
    materialize: seam.materialize, prepareCreate: seam.prepareCreate, reconcileCreateStage: seam.reconcileCreateStage,
    publish: publication => {
      fs.writeFileSync(target, 'external creator\n');
      return seam.publish(publication);
    }
  });
  const scope = f.scope('racer');
  const binding = scope.binding;
  await assert.rejects(authority.applyWrite({ binding, resource: target, bytes: Buffer.from('mediated\n'), assertCurrent: () => {} }),
    refusesWith('BYTE_CREATE_CONFLICT'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'external creator\n');
  assert.deepEqual(fs.readdirSync(f.directory), ['window.txt'], 'the operation-owned stage was retired');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(stateRoot, 'state', host.HOST_BYTE_STORE, 'data.sqlite'), { readOnly: true });
  try { assert.deepEqual(db.prepare('SELECT status FROM operations').all().map(row => row.status), ['ABORTED']); }
  finally { db.close(); }
  // Not frozen: the same resource reads and writes normally afterwards.
  const plain = createByteAuthority({ stateRoot, storeName: host.HOST_BYTE_STORE, maxResourceBytes: host.MAX_FILE_BYTES,
    readSetScope: 'resource', writeRequiresObservation: true, observeOwnWrites: true, pruneCommittedPayloads: true,
    materialize: seam.materialize, publish: seam.publish, prepareCreate: seam.prepareCreate, reconcileCreateStage: seam.reconcileCreateStage });
  await plain.observeRead({ binding, resource: target });
  await plain.applyWrite({ binding, resource: target, bytes: Buffer.from('reconciled\n'), assertCurrent: () => {} });
  assert.equal(fs.readFileSync(target, 'utf8'), 'reconciled\n');
});

test('4. byte-disjoint patches from A and B both land rebased; an overlapping stale patch refuses', async t => {
  const original = 'header\nfirst: one\nmiddle\nsecond: two\nfooter\n';
  const f = fixture(t, { 'code.txt': original });
  const a = f.scope('worker-a');
  const b = f.scope('worker-b');
  const c = f.scope('worker-c');
  const bytes = Buffer.from(original);
  const firstStart = bytes.indexOf('first: one');
  const secondStart = bytes.indexOf('second: two');
  await f.call(a, 'host.read_file', { path: f.file('code.txt'), startByte: firstStart, endByte: firstStart + 'first: one'.length });
  await f.call(b, 'host.read_file', { path: f.file('code.txt'), startByte: secondStart, endByte: secondStart + 'second: two'.length });
  await f.call(c, 'host.read_file', { path: f.file('code.txt') });
  const patchA = await f.call(a, 'host.patch_file', { path: f.file('code.txt'), oldText: 'first: one', newText: 'first: ONE (longer)' });
  assert.equal(patchA.startByte, firstStart);
  const patchB = await f.call(b, 'host.patch_file', { path: f.file('code.txt'), oldText: 'second: two', newText: 'second: 2' });
  const shift = 'first: ONE (longer)'.length - 'first: one'.length;
  assert.equal(patchB.startByte, secondStart + shift, 'B\'s observation was rebased past A\'s insertion');
  assert.equal(f.bytes('code.txt').toString(), 'header\nfirst: ONE (longer)\nmiddle\nsecond: 2\nfooter\n');
  // C observed the whole file before both patches: its overlapping edit refuses.
  await assert.rejects(f.call(c, 'host.patch_file', { path: f.file('code.txt'), oldText: 'first: ONE (longer)', newText: 'first: C' }), error => {
    assert.equal(error.code, 'HOST_FILE_STALE');
    assert.match(error.message, /patched by another session/);
    return true;
  });
  assert.equal(f.bytes('code.txt').toString(), 'header\nfirst: ONE (longer)\nmiddle\nsecond: 2\nfooter\n');
  // A patch on a span this scope never read refuses as read-required.
  await assert.rejects(f.call(a, 'host.patch_file', { path: f.file('code.txt'), oldText: 'footer', newText: 'FOOTER' }), refusesWith('HOST_FILE_READ_REQUIRED'));
  // Reconcile only the windows the refusals name, then C's edit lands.
  const current = f.bytes('code.txt');
  const start = current.indexOf('first: ONE (longer)');
  await f.call(c, 'host.read_file', { path: f.file('code.txt'), startByte: start, endByte: start + 'first: ONE (longer)'.length });
  const secondNow = current.indexOf('second: 2');
  await assert.rejects(f.call(c, 'host.patch_file', { path: f.file('code.txt'), oldText: 'first: ONE (longer)', newText: 'first: C' }), error => {
    assert.equal(error.code, 'HOST_FILE_STALE');
    assert.ok(error.message.includes(`bytes ${secondNow}-${secondNow + 'second: 2'.length}`), error.message);
    return true;
  });
  await f.call(c, 'host.read_file', { path: f.file('code.txt'), startByte: secondNow, endByte: secondNow + 'second: 2'.length });
  await f.call(c, 'host.patch_file', { path: f.file('code.txt'), oldText: 'first: ONE (longer)', newText: 'first: C' });
  assert.equal(f.bytes('code.txt').toString(), 'header\nfirst: C\nmiddle\nsecond: 2\nfooter\n');
});

test('5. kill switch off restores the exact legacy pair and host.patch_file refuses', async t => {
  const f = fixture(t, { 'legacy.txt': 'legacy base\n' });
  const a = f.scope('worker-a');
  const b = f.scope('worker-b');
  await withEnv('off', async () => {
    assert.equal(host.hostByteMediationEnabled(), false);
    const readA = await f.call(a, 'host.read_file', { path: f.file('legacy.txt') });
    assert.deepEqual(readA, { path: f.file('legacy.txt'), content: 'legacy base\n', bytes: 12 });
    const direct = await host.readFile({ path: f.file('legacy.txt') });
    assert.deepEqual(readA, direct, 'registry result equals the direct legacy provider result');
    await f.call(b, 'host.write_file', { path: f.file('legacy.txt'), content: 'B\n' });
    const clobber = await f.call(a, 'host.write_file', { path: f.file('legacy.txt'), content: 'A clobbers (legacy)\n' });
    assert.deepEqual(clobber, { path: f.file('legacy.txt'), bytes: 20 });
    assert.equal(f.bytes('legacy.txt').toString(), 'A clobbers (legacy)\n');
    await assert.rejects(f.call(a, 'host.patch_file', { path: f.file('legacy.txt'), oldText: 'A', newText: 'Z' }), error => {
      assert.equal(error.code, 'HOST_BYTE_MEDIATION_OFF');
      assert.match(error.message, /TOOLSENABLED_HOST_BYTE_MEDIATION=off/);
      return true;
    });
    await assert.rejects(f.call(a, 'host.read_file', { path: f.file('legacy.txt'), startByte: 0 }), refusesWith('HOST_BYTE_MEDIATION_OFF'));
  });
  for (const value of ['OFF', '0', 'false', 'no', 'disabled']) {
    await withEnv(value, () => assert.equal(host.hostByteMediationEnabled(), false, value));
  }
  for (const value of [undefined, 'on', '1', '']) {
    await withEnv(value, () => assert.equal(host.hostByteMediationEnabled(), true, String(value)));
  }
  // A caller without a transport file scope keeps the legacy result shape.
  const unscoped = await executeTool('host.read_file', { path: f.file('legacy.txt') }, { permissionSession: OWNER });
  assert.deepEqual(Object.keys(unscoped).sort(), ['bytes', 'content', 'path']);
  await assert.rejects(executeTool('host.patch_file', { path: f.file('legacy.txt'), oldText: 'A', newText: 'Z' }, { permissionSession: OWNER }),
    refusesWith('HOST_FILE_SCOPE_REQUIRED'));
});

test('6. every existing refusal still holds on the mediated path; audit admission precedes any byte', async t => {
  const f = fixture(t, { 'ok.txt': 'fine\n', 'big.txt': Buffer.alloc(host.MAX_FILE_BYTES + 1, 0x61) });
  fs.symlinkSync(f.file('ok.txt'), f.file('link.txt'));
  fs.mkdirSync(f.file('dir'));
  const a = f.scope('worker-a');
  await assert.rejects(f.call(a, 'host.read_file', { path: path.join(HOME, '.ssh', 'id_ed25519') }), refusesWith('HOST_PATH_FORBIDDEN'));
  await assert.rejects(f.call(a, 'host.read_file', { path: path.join(f.directory, 'vault', 'secrets.json') }), refusesWith('HOST_PATH_FORBIDDEN'));
  await assert.rejects(f.call(a, 'host.read_file', { path: path.join(f.directory, 'credentials.json') }), refusesWith('HOST_PATH_FORBIDDEN'));
  await assert.rejects(f.call(a, 'host.read_file', { path: f.file('link.txt') }), refusesWith('HOST_PATH_FORBIDDEN'));
  await assert.rejects(f.call(a, 'host.read_file', { path: f.file('dir') }), refusesWith('HOST_PATH_INVALID'));
  await assert.rejects(f.call(a, 'host.read_file', { path: f.file('big.txt') }), refusesWith('HOST_FILE_TOO_LARGE'));
  await assert.rejects(f.call(a, 'host.read_file', { path: f.file('missing.txt') }), refusesWith('HOST_PATH_NOT_FOUND'));
  await assert.rejects(f.call(a, 'host.read_file', { path: path.join(path.parse(HOME).root, 'etc', 'hostname') }), refusesWith('HOST_PATH_OUTSIDE_PROFILE'));
  await assert.rejects(f.call(a, 'host.write_file', { path: f.file('link.txt'), content: 'x' }), refusesWith('HOST_PATH_FORBIDDEN'));
  await assert.rejects(f.call(a, 'host.write_file', { path: path.join(HOME, '.gitconfig'), content: 'x' }), refusesWith('HOST_PATH_WRITE_PROTECTED'));
  await assert.rejects(f.call(a, 'host.write_file', { path: f.file('huge.txt'), content: 'a'.repeat(host.MAX_FILE_BYTES + 1) }), refusesWith('HOST_FILE_TOO_LARGE'));
  await assert.rejects(f.call(a, 'host.patch_file', { path: f.file('link.txt'), oldText: 'fine', newText: 'x' }), refusesWith('HOST_PATH_FORBIDDEN'));
  await assert.rejects(f.call(a, 'host.patch_file', { path: path.join(HOME, '.gitconfig'), oldText: 'a', newText: 'b' }), refusesWith('HOST_PATH_WRITE_PROTECTED'));
  // Product-tree anchors stay write-protected (a disposable ToolsEnabled tree).
  fs.mkdirSync(f.file('tree/config'), { recursive: true });
  fs.writeFileSync(f.file('tree/config/payload-boundary.json'), '{}\n');
  await assert.rejects(f.call(a, 'host.write_file', { path: f.file('tree/config/policy.json'), content: '{}' }), refusesWith('HOST_PATH_WRITE_PROTECTED'));
  // Audit admission is first: a refused admission releases nothing and writes nothing.
  const begin = tool => contexts.beginFileToolInvocation(a, { invocationId: `invocation-${randomUUID()}`, toolName: tool });
  const deny = () => Promise.reject(Object.assign(new Error('audit unavailable'), { code: 'AUDIT_REQUIRED_FAILED' }));
  const readInvocation = begin('host.read_file');
  await assert.rejects(host.readFile({ path: f.file('ok.txt') }, { fileToolContext: a, fileToolInvocation: readInvocation, requireRecordAsync: deny }), refusesWith('AUDIT_REQUIRED_FAILED'));
  contexts.endFileToolInvocation(readInvocation);
  await assert.rejects(f.call(a, 'host.write_file', { path: f.file('ok.txt'), content: 'x' }), refusesWith('HOST_FILE_READ_REQUIRED'),
    'the refused-admission read created no observation');
  await f.call(a, 'host.read_file', { path: f.file('ok.txt') });
  const writeInvocation = begin('host.write_file');
  await assert.rejects(host.writeFile({ path: f.file('ok.txt'), content: 'x' }, { fileToolContext: a, fileToolInvocation: writeInvocation, requireRecordAsync: deny }), refusesWith('AUDIT_REQUIRED_FAILED'));
  contexts.endFileToolInvocation(writeInvocation);
  assert.equal(f.bytes('ok.txt').toString(), 'fine\n');
  // A window must be character-aligned.
  fs.writeFileSync(f.file('utf8.txt'), 'é');
  await assert.rejects(f.call(a, 'host.read_file', { path: f.file('utf8.txt'), startByte: 1 }), refusesWith('HOST_FILE_UTF8_BOUNDARY_INVALID'));
  // A whole file with invalid UTF-8 still reads as the legacy reader did.
  fs.writeFileSync(f.file('latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  const lossy = await f.call(a, 'host.read_file', { path: f.file('latin1.txt') });
  assert.equal(lossy.content, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]).toString('utf8'));
  assert.equal(lossy.bytes, 5);
});

test('7. retention: committed payloads are pruned and the store stays bounded', async t => {
  const f = fixture(t, { 'churn.txt': 'x'.repeat(100 * 1024) });
  const a = f.scope('writer');
  const count = 40;
  await f.call(a, 'host.read_file', { path: f.file('churn.txt') });
  for (let index = 0; index < count; index += 1) {
    await f.call(a, 'host.write_file', { path: f.file('churn.txt'), content: String(index % 10).repeat(100 * 1024) });
  }
  const store = path.join(require('../src/lib/runtime-state-root').statePath(), 'state', host.HOST_BYTE_STORE);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(store, 'data.sqlite'), { readOnly: true });
  try {
    const operations = db.prepare("SELECT status, length(operation_json) AS size, json_extract(operation_json,'$.replacementBase64') AS payload FROM operations").all();
    assert.ok(operations.length >= count);
    for (const row of operations) {
      assert.equal(row.status, 'COMMITTED');
      assert.equal(row.payload, null, 'a committed operation keeps no replacement payload');
      assert.ok(row.size < 4096, `pruned operation record is small (${row.size})`);
    }
    const prepared = db.prepare("SELECT length(payload_json) AS size, json_extract(payload_json,'$.replacementBase64') AS payload FROM events WHERE kind LIKE '%.prepared'").all();
    for (const row of prepared) assert.equal(row.payload, null);
    const bulky = db.prepare('SELECT COUNT(*) AS n FROM reads WHERE length(observed) > 1024').get().n;
    assert.ok(bulky <= 1, `only the current observation carries bytes (${bulky})`);
  } finally { db.close(); }
  const size = fs.readdirSync(store).reduce((sum, name) => sum + fs.statSync(path.join(store, name)).size, 0);
  // Unpruned this would exceed count x 2 x 136 KB (~11 MB). Pruned: one live
  // observation plus a few KB of hashes and receipts per operation.
  assert.ok(size < 2 * 1024 * 1024, `store is bounded (${size} bytes after ${count} writes of 100 KB)`);
});

test('8. a crash between PREPARED and COMMITTED recovers through the authority hooks', async t => {
  const f = fixture(t, { 'crash.txt': 'before crash\n' });
  const { createByteAuthority } = require('../src/lib/region-holds/byte-authority');
  const seam = host.hostCoordination;
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-byte-crash-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const options = { stateRoot, storeName: host.HOST_BYTE_STORE, maxResourceBytes: host.MAX_FILE_BYTES,
    readSetScope: 'resource', writeRequiresObservation: true, observeOwnWrites: true, pruneCommittedPayloads: true,
    materialize: seam.materialize, prepareCreate: seam.prepareCreate, reconcileCreateStage: seam.reconcileCreateStage };
  const crashAfterPublish = createByteAuthority({ ...options, publish: publication => {
    seam.publish(publication);
    throw new Error('simulated crash after publication, before COMMITTED');
  } });
  const scope = f.scope('crasher');
  const binding = scope.binding;
  const target = f.file('crash.txt');
  await crashAfterPublish.observeRead({ binding, resource: target });
  await assert.rejects(crashAfterPublish.applyWrite({ binding, resource: target, bytes: Buffer.from('after crash\n'), assertCurrent: () => {} }),
    refusesWith('BYTE_PUBLICATION_UNCONFIRMED'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'after crash\n');
  const restarted = createByteAuthority({ ...options, publish: seam.publish });
  const recovered = await restarted.recoverPending();
  assert.equal(recovered.recovered.length, 1);
  assert.equal(recovered.recovered[0].outcome, 'recovered-materialized');
  assert.equal(recovered.recovered[0].receipt.recovered, true);
  // Crash before publication: recovery proves it unapplied.
  const crashBeforePublish = createByteAuthority({ ...options, publish: () => { throw new Error('simulated crash before publication'); } });
  await crashBeforePublish.observeRead({ binding, resource: target });
  await assert.rejects(crashBeforePublish.applyWrite({ binding, resource: target, bytes: Buffer.from('never\n'), assertCurrent: () => {} }),
    refusesWith('BYTE_PUBLICATION_UNCONFIRMED'));
  assert.equal((await restarted.recoverPending()).recovered[0].outcome, 'unapplied');
  // Creation crash after staging, before the no-replace link: stage retired, unapplied.
  const created = f.file('created.txt');
  const crashCreate = createByteAuthority({ ...options, publish: () => { throw new Error('simulated crash before link'); } });
  await assert.rejects(crashCreate.applyWrite({ binding, resource: created, bytes: Buffer.from('staged\n'), assertCurrent: () => {} }),
    refusesWith('BYTE_PUBLICATION_UNCONFIRMED'));
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.create.tmp')), true);
  assert.equal((await restarted.recoverPending()).recovered[0].outcome, 'unapplied');
  assert.equal(fs.existsSync(created), false);
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.create.tmp')), false);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(stateRoot, 'state', host.HOST_BYTE_STORE, 'data.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare("SELECT status, json_extract(operation_json,'$.replacementBase64') AS payload FROM operations ORDER BY rowid").all();
    assert.deepEqual(rows.map(row => row.status), ['COMMITTED', 'ABORTED', 'ABORTED']);
    assert.equal(rows[0].payload, null, 'recovered commits are pruned too');
  } finally { db.close(); }
});

test('9. the scope binding comes from the MCP call context, end to end through mcp.dispatch', async t => {
  const f = fixture(t, { 'wire.txt': 'wire base\n' });
  const a = f.scope('worker-a');
  const b = f.scope('worker-b');
  const call = (scope, name, args, id = randomUUID()) => mcp.dispatch({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    { permissionSession: OWNER, fileToolContext: scope });
  const parse = result => JSON.parse(result.content.find(block => block.type === 'text').text);
  const readA = await call(a, 'host.read_file', { path: f.file('wire.txt') });
  assert.notEqual(readA.isError, true);
  assert.equal(parse(readA).receipt.binding.runtimeScopeId, a.binding.runtimeScopeId);
  assert.equal(parse(readA).receipt.binding.principal, 'agent:worker-a');
  const readB = await call(b, 'host.read_file', { path: f.file('wire.txt') });
  assert.equal(parse(readB).receipt.binding.runtimeScopeId, b.binding.runtimeScopeId);
  const writeB = await call(b, 'host.write_file', { path: f.file('wire.txt'), content: 'B over the wire\n' });
  assert.notEqual(writeB.isError, true);
  const staleA = await call(a, 'host.write_file', { path: f.file('wire.txt'), content: 'A clobber over the wire\n' });
  assert.equal(staleA.isError, true);
  assert.equal(staleA.structuredContent.error.code, 'HOST_FILE_STALE');
  assert.equal(staleA.structuredContent.error.taxonomy.retryable, false);
  assert.match(staleA.content[0].text, /Re-read it with host\.read_file/);
  assert.equal(f.bytes('wire.txt').toString(), 'B over the wire\n');
  // A forged (cloned) scope is refused; it never falls back to the legacy path.
  const forged = await mcp.dispatch({ jsonrpc: '2.0', id: 'forged', method: 'tools/call', params: { name: 'host.write_file', arguments: { path: f.file('wire.txt'), content: 'forged\n' } } },
    { permissionSession: OWNER, fileToolContext: JSON.parse(JSON.stringify(a)) });
  assert.equal(forged.isError, true);
  assert.equal(f.bytes('wire.txt').toString(), 'B over the wire\n');
  // A retired transport scope is refused too.
  await contexts.retireFileToolContext(b, 'transport-closed');
  const retired = await call(b, 'host.write_file', { path: f.file('wire.txt'), content: 'retired\n' });
  assert.equal(retired.isError, true);
  assert.equal(f.bytes('wire.txt').toString(), 'B over the wire\n');
  // The patch tool is advertised to a full-tier session.
  const listed = await mcp.dispatch({ jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} }, { permissionSession: OWNER, fileToolContext: a });
  const tools = (listed.result || listed).tools || [];
  assert.ok(tools.some(tool => tool.name === 'host.patch_file'), 'host.patch_file is listed');
});
