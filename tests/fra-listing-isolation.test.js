'use strict';

// Focused synthetic coverage for the FRA listing-isolation contract. Every
// fixture is created below one per-run root and removed only by its own
// teardown; no product, profile, or retained audit fixture is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { FraWorkspaceHandleBroker } = require('../src/lib/providers/fra-workspace-handles');
const coordination = require('./helpers/fra-workspace-authority-fixture');

const LAB = Object.freeze({
  registry: {
    schemaVersion: 1,
    machines: {
      left: { address: '203.0.113.1' },
      right: { address: '203.0.113.2' }
    },
    services: {}
  }
});

const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERSION_RE = /^[a-f0-9]{64}$/;
const ENTRY_ID_RE = /^[a-f0-9]{64}$/;
const CHILD_REFUSAL_CODES = new Set([
  'WORKSPACE_ENTRY_INVALID',
  'WORKSPACE_ENTRY_UNAVAILABLE',
  'WORKSPACE_HANDLE_KIND_MISMATCH',
  'WORKSPACE_HANDLE_STALE',
  'WORKSPACE_IDENTITY_INVALID',
  'WORKSPACE_IDENTITY_UNAVAILABLE',
  'WORKSPACE_REPARSE_REFUSED',
  'WORKSPACE_ROOT_ESCAPE'
]);

// An unreadable sibling must really be unreadable on both platforms. Linux
// uses mode 000. Windows ignores POSIX mode bits apart from the read-only
// attribute, so chmod 0o000 there leaves the file readable and the listing
// (correctly) reports an ordinary file. On Windows the fixture instead denies
// the current account FILE_READ_DATA: lstat, realpath and delete still work
// and an open for reading fails, the state chmod 0o000 gives on Linux.
// makeUnreadable returns the function that makes the file readable again.
function windowsSystemTool(name) {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', name);
}

let windowsAccount = null;
function windowsAccountSid() {
  if (!windowsAccount) {
    const row = execFileSync(windowsSystemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
      { encoding: 'utf8', windowsHide: true });
    windowsAccount = (row.match(/"(S-1-[0-9-]+)"/) || [])[1] || null;
    assert.ok(windowsAccount, 'the current Windows account SID must be known');
  }
  return windowsAccount;
}

function makeUnreadable(file) {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o000);
    return () => fs.chmodSync(file, 0o600);
  }
  const icacls = windowsSystemTool('icacls.exe');
  const principal = `*${windowsAccountSid()}`;
  execFileSync(icacls, [file, '/deny', `${principal}:(RD)`], { windowsHide: true, stdio: 'ignore' });
  const makeReadable = () => {
    execFileSync(icacls, [file, '/remove:d', principal], { windowsHide: true, stdio: 'ignore' });
    fs.readFileSync(file);
  };
  try {
    // A process with SeBackupPrivilege ENABLED (an OpenSSH admin session, for
    // example) reads through the deny, because libuv opens with backup
    // semantics; the proof then needs a normal desktop-like token.
    assert.throws(() => fs.readFileSync(file), error => error && error.code === 'EPERM',
      'the Windows unreadable fixture must refuse a read (is SeBackupPrivilege enabled in this process?)');
  } catch (error) {
    makeReadable();
    throw error;
  }
  return makeReadable;
}

function makeRun(label) {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), `fra-listing-isolation-${label}-`));
  const workspace = path.join(runRoot, 'workspace');
  const coordinationRoot = path.join(runRoot, 'coordination');
  const outside = path.join(runRoot, 'outside');
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(coordinationRoot, { mode: 0o700 });
  fs.mkdirSync(outside, { mode: 0o700 });
  return Object.freeze({ runRoot, workspace, coordinationRoot, outside });
}

function context(label) {
  return coordination.context(
    `fra-listing-isolation-${label}-${crypto.randomUUID()}`,
    71
  );
}

function brokerFor(workspace, options = {}) {
  const coordinationRoot = path.join(path.dirname(workspace), 'coordination');
  return new FraWorkspaceHandleBroker({
    root: workspace,
    serviceRegistryOptions: LAB,
    authorityFactory: coordination.authorityFactory(coordinationRoot),
    auditApi: {
      record: () => ({ durable: true, anchored: true })
    },
    ...options
  });
}

function write(workspace, name, contents = 'synthetic listing fixture') {
  const target = path.join(workspace, name);
  fs.writeFileSync(target, contents, { encoding: 'utf8', mode: 0o600 });
  return target;
}

function writeRaw(workspace, rawName, contents = 'synthetic raw-name fixture') {
  const target = Buffer.concat([Buffer.from(workspace), Buffer.from(path.sep), rawName]);
  fs.writeFileSync(target, contents, { encoding: 'utf8', mode: 0o600 });
  return target;
}

function listAll(broker, boundContext, limit = 100) {
  const pages = [];
  let page = broker.list({ limit }, boundContext);
  pages.push(page);
  while (!page.complete) {
    page = broker.list({
      directoryHandle: page.directoryHandle,
      expectedVersion: page.version,
      cursor: page.nextCursor,
      limit
    }, boundContext);
    pages.push(page);
  }
  return {
    pages,
    entries: pages.flatMap(value => value.entries),
    directoryHandle: pages[0].directoryHandle,
    version: pages[0].version
  };
}

function fileEntry(entries, name) {
  const entry = entries.find(value => value.name === name);
  assert.ok(entry, `safe sibling ${JSON.stringify(name)} must remain listed`);
  assert.equal(entry.kind, 'file');
  assert.match(entry.handle, HANDLE_RE);
  assert.match(entry.version, VERSION_RE);
  assert.equal(typeof entry.bytes, 'number');
  return entry;
}

function directoryEntry(entries, name) {
  const entry = entries.find(value => value.name === name);
  assert.ok(entry, `directory ${JSON.stringify(name)} must remain listed`);
  assert.equal(entry.kind, 'directory');
  assert.match(entry.handle, HANDLE_RE);
  assert.match(entry.version, VERSION_RE);
  return entry;
}

function refusalEntry(entries, { name, codes = CHILD_REFUSAL_CODES } = {}) {
  const candidates = entries.filter(value => value.kind === 'unavailable');
  const entry = name === undefined
    ? candidates[0]
    : candidates.find(value => value.name === name);
  assert.ok(entry, `typed refusal marker missing for ${JSON.stringify(name)}`);
  assert.equal(entry.kind, 'unavailable');
  if (name !== undefined) assert.equal(entry.name, name);
  assert.ok(codes.has(entry.code), `unexpected child refusal code ${entry.code}`);
  assert.match(entry.entryId, ENTRY_ID_RE);
  for (const forbidden of ['handle', 'version', 'bytes', 'content']) {
    assert.equal(Object.hasOwn(entry, forbidden), false,
      `refusal marker must not expose ${forbidden}`);
  }
  return entry;
}

function assertMarkerCannotRead(broker, boundContext, marker) {
  assert.throws(() => broker.read({
    fileHandle: marker.handle,
    expectedVersion: marker.version,
    offset: 0,
    length: 1
  }, boundContext), error => error && error.code === 'WORKSPACE_HANDLE_INVALID');
}

async function withRun(label, callback) {
  const fixture = makeRun(label);
  try {
    return await callback(fixture);
  } finally {
    await coordination.retire();
    fs.rmSync(fixture.runRoot, { recursive: true, force: true });
    const absent = !fs.existsSync(fixture.runRoot);
    process.stdout.write('# fixture-root=' + JSON.stringify(fixture.runRoot)
      + ' absent=' + absent + '\n');
    assert.equal(absent, true,
      `same-run synthetic root must be absent after ${label}`);
  }
}

test('unreadable child is a typed marker while its readable sibling remains usable', async () => {
  await withRun('unreadable', ({ workspace }) => {
    write(workspace, 'a-readable.txt', 'synthetic readable sibling');
    const unreadable = write(workspace, 'z-unreadable.txt', 'synthetic unreadable sibling');
    const makeReadable = makeUnreadable(unreadable);
    try {
      const broker = brokerFor(workspace);
      const boundContext = context('unreadable');
      const result = listAll(broker, boundContext);
      fileEntry(result.entries, 'a-readable.txt');
      const marker = refusalEntry(result.entries, {
        name: 'z-unreadable.txt',
        codes: new Set(['WORKSPACE_ENTRY_UNAVAILABLE'])
      });
      assertMarkerCannotRead(broker, boundContext, marker);
    } finally {
      makeReadable();
    }
  });
});

test('NFC and NFD names remain distinct and only the invalid form is marked', async () => {
  await withRun('unicode-nfd', ({ workspace }) => {
    const nfc = 'caf\u00e9.txt';
    const nfd = 'cafe\u0301.txt';
    write(workspace, nfc, 'synthetic NFC sibling');
    write(workspace, nfd, 'synthetic NFD refusal');
    const broker = brokerFor(workspace);
    const boundContext = context('unicode-nfd');
    const result = listAll(broker, boundContext);
    fileEntry(result.entries, nfc);
    const marker = refusalEntry(result.entries, {
      name: nfd,
      codes: new Set(['WORKSPACE_ENTRY_INVALID'])
    });
    assert.notEqual(marker.entryId, fileEntry(result.entries, nfc).entryId);
    assertMarkerCannotRead(broker, boundContext, marker);
  });
});

test('the same raw basename in different directories gets different entry ids', async () => {
  await withRun('entry-id-parent', ({ workspace }) => {
    const left = path.join(workspace, 'left');
    const right = path.join(workspace, 'right');
    fs.mkdirSync(left, { mode: 0o700 });
    fs.mkdirSync(right, { mode: 0o700 });
    const nfd = 'cafe\u0301.txt';
    write(left, nfd, 'synthetic left refusal');
    write(right, nfd, 'synthetic right refusal');
    const broker = brokerFor(workspace);
    const boundContext = context('entry-id-parent');
    const root = listAll(broker, boundContext);
    const leftEntry = directoryEntry(root.entries, 'left');
    const rightEntry = directoryEntry(root.entries, 'right');
    const leftList = broker.list({
      directoryHandle: leftEntry.handle,
      expectedVersion: leftEntry.version,
      limit: 10
    }, boundContext);
    const rightList = broker.list({
      directoryHandle: rightEntry.handle,
      expectedVersion: rightEntry.version,
      limit: 10
    }, boundContext);
    const leftMarker = refusalEntry(leftList.entries, { name: nfd });
    const rightMarker = refusalEntry(rightList.entries, { name: nfd });
    assert.notEqual(leftMarker.entryId, rightMarker.entryId,
      'entry ids must include parent identity and cannot replay across directories');
    assertMarkerCannotRead(broker, boundContext, leftMarker);
    assertMarkerCannotRead(broker, boundContext, rightMarker);
  });
});

test('a literal backslash child is marked without suppressing the ordinary sibling', async t => {
  if (process.platform !== 'linux') return t.skip('literal backslash fixture is Linux-only');
  await withRun('backslash', ({ workspace }) => {
    write(workspace, 'a-readable.txt', 'synthetic readable sibling');
    const invalid = 'z\\synthetic-canary.txt';
    write(workspace, invalid, 'synthetic backslash refusal');
    const broker = brokerFor(workspace);
    const boundContext = context('backslash');
    const result = listAll(broker, boundContext);
    fileEntry(result.entries, 'a-readable.txt');
    const marker = refusalEntry(result.entries, {
      name: invalid,
      codes: new Set(['WORKSPACE_ENTRY_INVALID'])
    });
    assertMarkerCannotRead(broker, boundContext, marker);
  });
});

test('raw invalid-byte names get distinct stable entry ids and no replacement alias', async t => {
  if (process.platform !== 'linux') return t.skip('raw invalid-byte fixture is Linux-only');
  await withRun('nonutf8', ({ workspace }) => {
    write(workspace, 'a-readable.txt', 'synthetic readable sibling');
    const firstRaw = Buffer.from([0x7a, 0x2d, 0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0x2d, 0xff, 0x2e, 0x74, 0x78, 0x74]);
    const secondRaw = Buffer.from([0x7a, 0x2d, 0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0x2d, 0xfe, 0x2e, 0x74, 0x78, 0x74]);
    writeRaw(workspace, firstRaw);
    writeRaw(workspace, secondRaw);
    const broker = brokerFor(workspace);
    const boundContext = context('nonutf8');
    const first = listAll(broker, boundContext);
    fileEntry(first.entries, 'a-readable.txt');
    const markers = first.entries.filter(value => value.kind === 'unavailable');
    assert.equal(markers.length, 2, 'both raw invalid-byte children must remain visible as markers');
    assert.equal(new Set(markers.map(value => value.entryId)).size, 2,
      'raw byte-distinct names must not collapse to one replacement-character identity');
    for (const marker of markers) {
      refusalEntry([marker]);
      assertMarkerCannotRead(broker, boundContext, marker);
    }
    const second = listAll(broker, boundContext);
    assert.deepEqual(
      second.entries.filter(value => value.kind === 'unavailable').map(value => value.entryId).sort(),
      markers.map(value => value.entryId).sort(),
      'raw-name entry ids must be stable across repeated listings'
    );
  });
});

test('reparse and outside-root hardlink children remain refused markers, not handles', async t => {
  if (process.platform !== 'linux') return t.skip('Linux identity fixtures are not portable to this proof');
  await withRun('identity', ({ workspace, outside }) => {
    write(workspace, 'a-readable.txt', 'synthetic readable sibling');
    const outsideFile = write(outside, 'outside-target.txt', 'synthetic outside target');
    fs.linkSync(outsideFile, path.join(workspace, 'z-outside-hardlink.txt'));
    fs.symlinkSync(outsideFile, path.join(workspace, 'y-reparse-link.txt'));
    const broker = brokerFor(workspace);
    const boundContext = context('identity');
    const result = listAll(broker, boundContext);
    fileEntry(result.entries, 'a-readable.txt');
    const reparse = refusalEntry(result.entries, {
      name: 'y-reparse-link.txt',
      codes: new Set(['WORKSPACE_REPARSE_REFUSED'])
    });
    const hardlink = refusalEntry(result.entries, {
      name: 'z-outside-hardlink.txt',
      codes: new Set(['WORKSPACE_ROOT_ESCAPE', 'WORKSPACE_IDENTITY_INVALID'])
    });
    assertMarkerCannotRead(broker, boundContext, reparse);
    assertMarkerCannotRead(broker, boundContext, hardlink);
  });
});

test('cursor continuation includes typed markers and stale-detects a changed child set', async () => {
  await withRun('cursor-digest', ({ workspace }) => {
    write(workspace, 'a-readable.txt', 'synthetic readable sibling');
    write(workspace, 'b-readable.txt', 'synthetic second readable sibling');
    const unreadable = write(workspace, 'z-unreadable.txt', 'synthetic unreadable sibling');
    const makeReadable = makeUnreadable(unreadable);
    const broker = brokerFor(workspace);
    const boundContext = context('cursor-digest');
    let first;
    try {
      first = broker.list({ limit: 1 }, boundContext);
      assert.equal(first.complete, false);
      assert.equal(first.entries.length, 2,
        'one usable page and its marker page must share the cursor');
      fileEntry(first.entries, 'a-readable.txt');
      refusalEntry(first.entries, {
        name: 'z-unreadable.txt',
        codes: new Set(['WORKSPACE_ENTRY_UNAVAILABLE'])
      });
    } finally {
      makeReadable();
    }
    assert.throws(() => broker.list({
      directoryHandle: first.directoryHandle,
      expectedVersion: first.version,
      cursor: first.nextCursor,
      limit: 1
    }, boundContext), error => error && error.code === 'WORKSPACE_CURSOR_STALE');
  });
});

test('fatal parent, context, capacity and audit failures still abort the listing', async () => {
  await withRun('fatal-guards', ({ workspace }) => {
    write(workspace, 'a-readable.txt', 'synthetic readable sibling');
    assert.throws(
      () => brokerFor(workspace).list({ limit: 10 }, {}),
      error => error && error.code === 'WORKSPACE_FRA_CONTEXT_REQUIRED'
    );
    assert.throws(
      () => brokerFor(workspace, { maxHandlesPerSession: 1 }).list({ limit: 10 }, context('capacity')),
      error => error && error.code === 'WORKSPACE_HANDLE_CAPACITY'
    );
    assert.throws(
      () => brokerFor(workspace, {
        auditApi: { record: () => ({ durable: false, anchored: false }) }
      }).list({ limit: 10 }, context('audit')),
      error => error && error.code === 'WORKSPACE_AUDIT_UNAVAILABLE'
    );
  });
});

test('Windows trailing-space identity remains exact through listing and read', async t => {
  if (process.platform !== 'win32') return t.skip('Windows trailing-space proof is deferred while the bridge is offline');
  await withRun('windows-trailing-space', async ({ workspace }) => {
    write(workspace, 'space.txt', 'synthetic ordinary basename');
    const trailing = path.join(workspace, 'space.txt ');
    fs.writeFileSync(path.toNamespacedPath(trailing), 'synthetic trailing-space basename', {
      encoding: 'utf8', mode: 0o600
    });
    const broker = brokerFor(workspace);
    const boundContext = context('windows-trailing-space');
    const result = listAll(broker, boundContext);
    fileEntry(result.entries, 'space.txt');
    const trailingEntry = fileEntry(result.entries, 'space.txt ');
    const read = await coordination.read(broker, {
      fileHandle: trailingEntry.handle,
      expectedVersion: trailingEntry.version,
      encoding: 'utf8'
    }, boundContext);
    assert.equal(read.content, 'synthetic trailing-space basename');
  });
});
