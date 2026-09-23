'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const coordination = require('./helpers/fra-workspace-authority-fixture');
const {
  FraWorkspaceHandleBroker,
  MAX_DIRECTORY_ENTRIES,
  MAX_FILE_BYTES,
  identityOf
} = require('../src/lib/providers/fra-workspace-handles');

const registry = {
  schemaVersion: 1,
  machines: {
    left: { address: '203.0.113.1', root: 'C:\\left', role: 'development-host' },
    right: { address: '203.0.113.2', root: 'C:\\right', role: 'disconnected-peer' }
  },
  services: {}
};

function context(seed) {
  return coordination.context(seed);
}

function statView(stat, changes = {}) {
  return new Proxy(stat, {
    get(target, property) {
      if (Object.hasOwn(changes, property)) return changes[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function fsView(overrides = {}) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function normalFs(overrides = {}) {
  return fsView({
    lstatSync(target, options) {
      return statView(fs.lstatSync(target, options), { nlink: 1n });
    },
    fstatSync(fd, options) {
      return statView(fs.fstatSync(fd, options), { nlink: 1n });
    },
    ...overrides
  });
}

function broker(root, fsApi = normalFs(), options = {}) {
  let audits = 0;
  let randomCounter = options.randomByte || 7;
  const instance = new FraWorkspaceHandleBroker({
    root,
    authorityFactory: coordination.authorityFactory(root),
    fsApi,
    serviceRegistryOptions: { registry },
    randomBytes: size => {
      const bytes = Buffer.alloc(size);
      bytes.writeUInt32BE(randomCounter++, size - 4);
      return bytes;
    },
    auditApi: { record: () => {
      audits += 1;
      return { durable: true, anchored: true };
    } },
    ...options
  });
  return { instance, audits: () => audits };
}

async function refuses(call, code, audits) {
  const before = audits();
  await assert.rejects(async () => call(), error => error && error.code === code, code);
  assert.equal(audits(), before, `${code} must not audit a refused operation`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-workspace-refusals-'));
  const file = path.join(root, 'file.txt');
  fs.writeFileSync(file, 'contents', 'utf8');
  try {
    // Real native stats, not normalFs's synthetic NTFS-style link count.
    // A POSIX parent with a child has multiple legitimate directory links.
    const child = path.join(root, 'child');
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(child, 'nested.txt'), 'nested');
    const native = broker(root, fs);
    const nativeContext = context('native-directory-links');
    const nativeRoot = native.instance.list({}, nativeContext);
    const nativeChild = nativeRoot.entries.find(entry => entry.name === 'child');
    assert.ok(nativeChild, 'a real directory with a child must be exposed');
    const nativeListing = native.instance.list({ directoryHandle: nativeChild.handle,
      expectedVersion: nativeChild.version }, nativeContext);
    assert.ok(nativeListing.entries.some(entry => entry.name === 'nested.txt'));
    assert.equal(identityOf(fs.lstatSync(root, { bigint: true })).nlink,
      fs.lstatSync(root, { bigint: true }).nlink, 'directory identity retains its exact link count');

    const nativeFile = nativeRoot.entries.find(entry => entry.name === 'file.txt');
    const alias = path.join(root, 'linked.txt');
    fs.linkSync(file, alias);
    assert.throws(() => identityOf(fs.lstatSync(file, { bigint: true })),
      { code: 'WORKSPACE_IDENTITY_INVALID' }, 'real regular-file hard links remain forbidden');
    await refuses(() => coordination.read(native.instance, {
      fileHandle: nativeFile.handle, expectedVersion: nativeFile.version
    }, nativeContext), 'WORKSPACE_IDENTITY_INVALID', native.audits);
    fs.unlinkSync(alias);

    const basic = broker(root);
    await refuses(() => basic.instance.list([], context('args')), 'WORKSPACE_ARGUMENTS_INVALID', basic.audits);
    await refuses(() => basic.instance.list({ limit: 0 }, context('limit')), 'WORKSPACE_LIMIT_INVALID', basic.audits);
    const cursorRoot = basic.instance.list({}, context('cursor'));
    await refuses(() => basic.instance.list({ directoryHandle: cursorRoot.directoryHandle,
      expectedVersion: cursorRoot.version, cursor: 'bad' }, context('cursor')),
    'WORKSPACE_CURSOR_INVALID', basic.audits);
    await refuses(() => coordination.read(basic.instance, { fileHandle: 'bad', expectedVersion: 'bad' }, context('handle')),
      'WORKSPACE_HANDLE_INVALID', basic.audits);

    const capacity = broker(root, normalFs(), { maxHandlesPerSession: 0, randomByte: 8 });
    await refuses(() => capacity.instance.list({}, context('capacity')),
      'WORKSPACE_HANDLE_CAPACITY', capacity.audits);

    const oversizedDirectoryFs = normalFs({
      readdirSync(target, options) {
        if (path.resolve(target) === path.resolve(root)) {
          return { length: MAX_DIRECTORY_ENTRIES + 1 };
        }
        return fs.readdirSync(target, options);
      }
    });
    const oversizedDirectory = broker(root, oversizedDirectoryFs, { randomByte: 9 });
    await refuses(() => oversizedDirectory.instance.list({}, context('large-directory')),
      'WORKSPACE_DIRECTORY_TOO_LARGE', oversizedDirectory.audits);

    function listedFile(subject, seed) {
      const listing = subject.instance.list({}, context(seed));
      return listing.entries.find(entry => entry.name === 'file.txt');
    }

    let makeUnavailable = false;
    const unavailableFs = normalFs({
      lstatSync(target, options) {
        if (makeUnavailable && path.resolve(target) === path.resolve(file)) {
          const error = new Error('denied');
          error.code = 'EACCES';
          throw error;
        }
        return statView(fs.lstatSync(target, options), { nlink: 1n });
      }
    });
    const unavailable = broker(root, unavailableFs, { randomByte: 10 });
    const unavailableFile = listedFile(unavailable, 'unavailable');
    makeUnavailable = true;
    await refuses(() => coordination.read(unavailable.instance, { fileHandle: unavailableFile.handle,
      expectedVersion: unavailableFile.version }, context('unavailable')),
    'WORKSPACE_ENTRY_UNAVAILABLE', unavailable.audits);

    let wrongKind = false;
    const kindFs = normalFs({
      lstatSync(target, options) {
        const stat = fs.lstatSync(target, options);
        if (wrongKind && path.resolve(target) === path.resolve(file)) {
          return statView(stat, { nlink: 1n, isFile: () => false, isDirectory: () => true });
        }
        return statView(stat, { nlink: 1n });
      }
    });
    const kind = broker(root, kindFs, { randomByte: 11 });
    const kindFile = listedFile(kind, 'kind');
    wrongKind = true;
    await refuses(() => coordination.read(kind.instance, { fileHandle: kindFile.handle,
      expectedVersion: kindFile.version }, context('kind')),
    'WORKSPACE_HANDLE_KIND_MISMATCH', kind.audits);

    let reportHuge = false;
    const hugeFs = normalFs({
      lstatSync(target, options) {
        const stat = fs.lstatSync(target, options);
        return statView(stat, {
          nlink: 1n,
          ...(reportHuge && path.resolve(target) === path.resolve(file)
            ? { size: BigInt(MAX_FILE_BYTES + 1) } : {})
        });
      },
      fstatSync(fd, options) {
        const stat = fs.fstatSync(fd, options);
        return statView(stat, { nlink: 1n, ...(reportHuge ? { size: BigInt(MAX_FILE_BYTES + 1) } : {}) });
      }
    });
    const huge = broker(root, hugeFs, { randomByte: 12 });
    const hugeFile = listedFile(huge, 'huge');
    reportHuge = true;
    // Preserve the registered identity so opening reaches the explicit size bound.
    const hugeRecord = huge.instance.sessions.get(context('huge').fraWorkspaceContext.sessionContextDigest)
      .handles.get(hugeFile.handle);
    huge.instance.sessions.get(context('huge').fraWorkspaceContext.sessionContextDigest)
      .handles.set(hugeFile.handle, Object.freeze({ ...hugeRecord,
        version: require('../src/lib/providers/fra-workspace-handles').identityVersion('file',
          identityOf(hugeFs.lstatSync(file, { bigint: true }))) }));
    const updatedHuge = huge.instance.sessions.get(context('huge').fraWorkspaceContext.sessionContextDigest)
      .handles.get(hugeFile.handle);
    await refuses(() => coordination.read(huge.instance, { fileHandle: hugeFile.handle,
      expectedVersion: updatedHuge.version }, context('huge')),
    'WORKSPACE_FILE_TOO_LARGE', huge.audits);

    let shortRead = false;
    const changedFs = normalFs({
      readSync(...args) { return shortRead ? 0 : fs.readSync(...args); }
    });
    const changed = broker(root, changedFs, { randomByte: 13 });
    const changedFile = listedFile(changed, 'changed');
    shortRead = true;
    await refuses(() => coordination.read(changed.instance, { fileHandle: changedFile.handle,
      expectedVersion: changedFile.version }, context('changed')),
    'WORKSPACE_FILE_CHANGED', changed.audits);

    assert.throws(() => identityOf({}), error => error.code === 'WORKSPACE_IDENTITY_UNAVAILABLE');
    const invalidIdentity = Object.fromEntries(
      ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, 1n])
    );
    invalidIdentity.dev = 0n;
    assert.throws(() => identityOf(invalidIdentity), error => error.code === 'WORKSPACE_IDENTITY_INVALID');
    process.stdout.write('fra workspace refusal tests passed\n');
  } finally {
    await coordination.retire();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
