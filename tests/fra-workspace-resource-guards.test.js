'use strict';

require('./lib/isolated-environment').activate('fra-workspace-resource-guards');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const handles = require('../src/lib/providers/fra-workspace-handles');
const toolRegistry = require('../src/lib/tool-registry');
const coordination = require('./helpers/fra-workspace-authority-fixture');

const registry = { schemaVersion: 1, machines: {
  left: { address: '203.0.113.1', root: 'C:\\left' },
  right: { address: '203.0.113.2', root: 'C:\\right' }
}, services: {} };
let nextContext = 0;

function fixture(t, names = ['alpha.txt', 'beta.txt']) {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-resource-guards-'));
  const root = path.join(owned, 'workspace');
  fs.mkdirSync(root);
  for (const name of names) {
    const target = path.join(root, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'inert FRA audit fixture\n', 'utf8');
  }
  const contexts = [];
  const brokers = [];
  const broker = options => {
    let randomCounter = 7;
    const instance = new handles.FraWorkspaceHandleBroker({
      root,
      authorityFactory: coordination.authorityFactory(path.join(owned, 'coordination')),
      serviceRegistryOptions: { registry },
      auditApi: { record: () => ({ durable: true, anchored: true }) },
      randomBytes: size => {
        const bytes = Buffer.alloc(size);
        bytes.writeUInt32BE(randomCounter++, size - 4);
        return bytes;
      },
      ...options
    });
    brokers.push(instance);
    return instance;
  };
  const context = () => {
    const value = coordination.context(`resource-${++nextContext}`);
    contexts.push(value);
    return value;
  };
  t.after(async () => {
    for (const instance of brokers) {
      for (const value of contexts) instance.closeSession(value);
    }
    await coordination.retire();
    fs.rmSync(owned, { recursive: true, force: true });
    assert.equal(fs.existsSync(owned), false, 'same-run synthetic fixture must be absent after teardown');
    t.diagnostic(JSON.stringify({ fixtureRoot: owned, cleanupAssertedAbsent: true }));
  });
const brokerInstance = broker({});
  return { owned, root, broker: brokerInstance, context, brokerFactory: broker };
}

test('T1611 refuses invalid private cursor capacity configuration', t => {
  const f = fixture(t, []);
  for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new handles.FraWorkspaceHandleBroker({
      root: f.root,
      authorityFactory: coordination.authorityFactory(path.join(f.owned, 'invalid-capacity-coordination')),
      serviceRegistryOptions: { registry },
      auditApi: { record: () => ({ durable: true, anchored: true }) },
      maxCursorsPerSession: value
    }), error => error && error.code === 'WORKSPACE_CURSOR_CAPACITY_INVALID');
  }
});

test('T1611 caps live cursors and reclaims expired cursors on creation', t => {
  const f = fixture(t);
  const ctx = f.context();
  let capRandomCounter = 9;
  const capped = new handles.FraWorkspaceHandleBroker({
    root: f.root,
    authorityFactory: coordination.authorityFactory(path.join(f.owned, 'cap-coordination')),
    serviceRegistryOptions: { registry },
    auditApi: { record: () => ({ durable: true, anchored: true }) },
    randomBytes: size => {
      const bytes = Buffer.alloc(size);
      bytes.writeUInt32BE(capRandomCounter++, size - 4);
      return bytes;
    },
    maxCursorsPerSession: 2
  });
  const first = capped.list({ limit: 1 }, ctx);
  const second = capped.list({ limit: 1 }, ctx);
  assert.match(first.nextCursor, handles.HANDLE_RE);
  assert.match(second.nextCursor, handles.HANDLE_RE);
  assert.equal(capped.sessions.get(ctx.fraWorkspaceContext.sessionContextDigest).cursors.size, 2);
  assert.throws(() => capped.list({ limit: 1 }, ctx), { code: 'WORKSPACE_CURSOR_CAPACITY' });

  let clock = 1000;
  let expiryRandomCounter = 10;
  const expiring = new handles.FraWorkspaceHandleBroker({
    root: f.root,
    authorityFactory: coordination.authorityFactory(path.join(f.owned, 'expiry-coordination')),
    serviceRegistryOptions: { registry },
    auditApi: { record: () => ({ durable: true, anchored: true }) },
    randomBytes: size => {
      const bytes = Buffer.alloc(size);
      bytes.writeUInt32BE(expiryRandomCounter++, size - 4);
      return bytes;
    },
    now: () => clock,
    maxCursorsPerSession: 1
  });
  const expiryContext = f.context();
  const expiringPage = expiring.list({ limit: 1 }, expiryContext);
  clock += handles.CURSOR_TTL_MS + 1;
  const replacement = expiring.list({ limit: 1 }, expiryContext);
  assert.notEqual(replacement.nextCursor, expiringPage.nextCursor);
  assert.equal(expiring.sessions.get(expiryContext.fraWorkspaceContext.sessionContextDigest).cursors.size, 1);
});

test('T1611 keeps an expired cursor on cleanup long enough to return stale', t => {
  const f = fixture(t, ['alpha.txt', 'beta.txt']);
  let clock = 1000;
  const expiring = new handles.FraWorkspaceHandleBroker({
    root: f.root,
    authorityFactory: coordination.authorityFactory(path.join(f.owned, 'stale-coordination')),
    serviceRegistryOptions: { registry },
    auditApi: { record: () => ({ durable: true, anchored: true }) },
    now: () => clock,
    maxCursorsPerSession: 1
  });
  const context = f.context();
  const page = expiring.list({ limit: 1 }, context);
  clock += handles.CURSOR_TTL_MS + 1;
  assert.throws(() => expiring.list({
    directoryHandle: page.directoryHandle,
    expectedVersion: page.version,
    cursor: page.nextCursor,
    limit: 1
  }, context), { code: 'WORKSPACE_CURSOR_STALE' });
});

test('T1620 refuses an oversized directory after bounded enumeration and closes the enumerator', t => {
  const f = fixture(t, []);
  let reads = 0;
  let closed = false;
  const oversizedFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'opendirSync') {
        return targetPath => {
          if (path.resolve(targetPath) !== path.resolve(f.root)) return target.opendirSync.call(target, targetPath);
          let index = 0;
          return {
            readSync() {
              reads += 1;
              if (index > handles.MAX_DIRECTORY_ENTRIES) return null;
              return {
                name: Buffer.from(`entry-${index++}.txt`, 'utf8'),
                isDirectory: () => false,
                isFile: () => true
              };
            },
            closeSync() { closed = true; }
          };
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const broker = new handles.FraWorkspaceHandleBroker({
    root: f.root,
    fsApi: oversizedFs,
    authorityFactory: coordination.authorityFactory(path.join(f.owned, 'enumeration-coordination')),
    serviceRegistryOptions: { registry },
    auditApi: { record: () => ({ durable: true, anchored: true }) }
  });
  assert.throws(() => broker.list({}, f.context()), { code: 'WORKSPACE_DIRECTORY_TOO_LARGE' });
  assert.equal(reads, handles.MAX_DIRECTORY_ENTRIES + 1);
  assert.equal(closed, true);
});

test('T1620 maps injected enumeration failures without a path and closes readers', t => {
  const f = fixture(t, []);
  const opendirFailureFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'opendirSync') {
        return targetPath => {
          const error = new Error(`synthetic opendir failure at ${targetPath}`);
          error.code = 'EIO';
          throw error;
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const opendirBroker = new handles.FraWorkspaceHandleBroker({
    root: f.root,
    fsApi: opendirFailureFs,
    authorityFactory: coordination.authorityFactory(path.join(f.owned, 'opendir-failure-coordination')),
    serviceRegistryOptions: { registry },
    auditApi: { record: () => ({ durable: true, anchored: true }) }
  });
  assert.throws(() => opendirBroker._boundedDirectoryEntries(f.root), error => (
    error && error.code === 'WORKSPACE_DIRECTORY_UNAVAILABLE'
      && !error.message.includes(f.root)
  ));

  let closed = false;
  const readFailureFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'opendirSync') {
        return () => ({
          readSync() {
            const error = new Error(`synthetic read failure at ${f.root}`);
            error.code = 'EIO';
            throw error;
          },
          closeSync() { closed = true; }
        });
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const readBroker = new handles.FraWorkspaceHandleBroker({
    root: f.root,
    fsApi: readFailureFs,
    authorityFactory: coordination.authorityFactory(path.join(f.owned, 'read-failure-coordination')),
    serviceRegistryOptions: { registry },
    auditApi: { record: () => ({ durable: true, anchored: true }) }
  });
  assert.throws(() => readBroker._boundedDirectoryEntries(f.root), error => (
    error && error.code === 'WORKSPACE_DIRECTORY_UNAVAILABLE'
      && !error.message.includes(f.root)
  ));
  assert.equal(closed, true);
});

test('T1621 refuses a file-to-FIFO swap without blocking the broker', t => {
  const f = fixture(t, ['victim.txt']);
  if (process.platform !== 'linux') {
    t.skip('Linux-only FIFO race proof; Windows native proof is deferred by the current audit lane');
    return;
  }
  const fifo = path.join(f.owned, 'victim.fifo');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 1000 });
  if (made.status !== 0) {
    t.skip(`mkfifo unavailable; refusal reason: ${made.stderr || 'command failed'}`);
    return;
  }
  const child = spawnSync(process.execPath, [
    path.join(__dirname, 'helpers', 'fra-fifo-open-race-child.js'),
    f.root,
    path.join(f.root, 'victim.txt'),
    fifo
  ], { encoding: 'utf8', timeout: 1500 });
  assert.equal(child.signal, null, `FIFO race child timed out: ${child.stderr}`);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'fifo replacement refused');
});

test('T1619 advertises reconnect after a stale snapshot refusal', () => {
  const tool = toolRegistry.getTool('workspace.list');
  assert.match(tool.description, /snapshot-bound/);
  assert.match(tool.description, /reconnect the FRA session/);
  assert.match(tool.description, /existing child handles remain stale/);
});

test('T1620 markers never become readable handles', async t => {
  const f = fixture(t, ['safe.txt', 'blocked.txt']);
  const fsApi = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (targetPath, flags, ...rest) => {
          if (path.resolve(targetPath) === path.resolve(path.join(f.root, 'blocked.txt'))) {
            const error = new Error('synthetic unreadable sibling');
            error.code = 'EACCES';
            throw error;
          }
          return fs.openSync(targetPath, flags, ...rest);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const broker = new handles.FraWorkspaceHandleBroker({
    root: f.root,
    fsApi,
    authorityFactory: coordination.authorityFactory(path.join(f.owned, 'marker-coordination')),
    serviceRegistryOptions: { registry },
    auditApi: { record: () => ({ durable: true, anchored: true }) }
  });
  const ctx = f.context();
  const page = broker.list({}, ctx);
  const marker = page.entries.find(entry => entry.name === 'blocked.txt');
  assert.equal(marker.kind, 'unavailable');
  assert.equal(Object.hasOwn(marker, 'handle'), false);
  assert.equal(Object.hasOwn(marker, 'version'), false);
  assert.equal(Object.hasOwn(marker, 'bytes'), false);
  assert.match(marker.entryId, /^[a-f0-9]{64}$/);
  await assert.rejects(coordination.read(broker, {
    fileHandle: marker.handle,
    expectedVersion: marker.version
  }, ctx), { code: 'WORKSPACE_HANDLE_INVALID' });
});

test('T1611 cursor identity remains session-scoped after a fresh context', t => {
  const f = fixture(t);
  const firstContext = f.context();
  const first = f.broker.list({ limit: 1 }, firstContext);
  const otherContext = f.context();
  assert.throws(() => f.broker.list({
    directoryHandle: first.directoryHandle,
    expectedVersion: first.version,
    cursor: first.nextCursor,
    limit: 1
  }, otherContext), { code: 'WORKSPACE_HANDLE_UNKNOWN' });
});
