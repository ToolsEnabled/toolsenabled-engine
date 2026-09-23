'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  FraWorkspaceHandleBroker,
  HANDLE_RE,
  VERSION_RE,
  WORKSPACE_POLICY_DESCRIPTOR,
  WORKSPACE_POLICY_DIGEST
} = require('../src/lib/providers/fra-workspace-handles');
const workspacePolicy = require('../src/lib/fra-workspace-policy');
const repoFiles = require('../src/lib/providers/repo-files');
const coordination = require('./helpers/fra-workspace-authority-fixture');

// The two hosts below are resolved through the service registry, so the test
// injects this fixture registry instead of reading the machine-local one --
// it no longer depends on the builder's machine or its real LAN addresses.
const lab = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.1', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '203.0.113.2', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
};

function context(seed = 'a') {
  return coordination.context(seed, 7);
}

function find(entries, name) {
  const entry = entries.find(candidate => candidate.name === name);
  assert.ok(entry, `missing workspace entry ${name}`);
  return entry;
}

function codes(fn, code) {
  assert.throws(fn, error => error && error.code === code);
}

function noPaths(value, root) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(root), false);
  assert.equal(/[A-Za-z]:\\/.test(text), false);
}

async function main() {
  assert.deepEqual(WORKSPACE_POLICY_DESCRIPTOR, workspacePolicy.WORKSPACE_POLICY_DESCRIPTOR);
  assert.equal(WORKSPACE_POLICY_DIGEST, workspacePolicy.WORKSPACE_POLICY_DIGEST);
  assert.deepEqual(
    [...workspacePolicy.EXCLUDED_DIR_NAMES].sort(),
    [...repoFiles.EXCLUDED_DIR_NAMES].sort()
  );
  for (const candidate of [
    '.env', '.env.local', '.env.example', '.npmrc',
    '.config/gh/hosts.yml', 'notes.txt', 'auth-session.json'
  ]) {
    assert.equal(
      workspacePolicy.isCredentialOrHistoryPath(candidate),
      repoFiles.isCredentialOrHistoryPath(candidate),
      `workspace policy classifier drifted for ${candidate}`
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-workspace-handles-'));
  const nested = path.join(root, 'src');
  fs.mkdirSync(nested);
  fs.mkdirSync(path.join(root, 'vault'));
  fs.writeFileSync(path.join(root, 'alpha.txt'), 'alpha\nbeta\n', 'utf8');
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0xff, 0x00, 0x7f]));
  fs.writeFileSync(path.join(nested, 'one.js'), 'module.exports = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'vault', 'secrets.json'), 'forbidden', 'utf8');
  const auditRecords = [];
  let counter = 0;
  const broker = new FraWorkspaceHandleBroker({
    root,
    authorityFactory: coordination.authorityFactory(root),
    auditApi: { record: (...args) => {
      auditRecords.push(args);
      return { durable: true, anchored: true };
    } },
    serviceRegistryOptions: { registry: lab },
    randomBytes: size => {
      const value = Buffer.alloc(size);
      value.writeUInt32BE(++counter, size - 4);
      return value;
    }
  });
  const firstContext = context('first');
  const secondContext = context('second');
  try {
    codes(() => broker.list({}, {}), 'WORKSPACE_FRA_CONTEXT_REQUIRED');
    const first = broker.list({ limit: 2 }, firstContext);
    assert.match(first.directoryHandle, HANDLE_RE);
    assert.match(first.version, VERSION_RE);
    assert.equal(first.entries.length, 2);
    assert.match(first.nextCursor, HANDLE_RE);
    noPaths(first, root);

    const second = broker.list({
      directoryHandle: first.directoryHandle,
      expectedVersion: first.version,
      cursor: first.nextCursor,
      limit: 100
    }, firstContext);
    const allEntries = [...first.entries, ...second.entries];
    assert.equal(allEntries.some(entry => entry.name === 'vault'), false);
    assert.equal(second.complete, true);
    codes(() => broker.list({
      directoryHandle: first.directoryHandle,
      expectedVersion: first.version,
      cursor: first.nextCursor
    }, firstContext), 'WORKSPACE_CURSOR_STALE');

    const alpha = find(allEntries, 'alpha.txt');
    assert.equal(alpha.kind, 'file');
    assert.match(alpha.handle, HANDLE_RE);
    const read = await coordination.read(broker, {
      fileHandle: alpha.handle,
      expectedVersion: alpha.version,
      offset: 0,
      length: 6,
      encoding: 'utf8'
    }, firstContext);
    assert.equal(read.content, 'alpha\n');
    assert.equal(read.eof, false);
    assert.match(read.fileSha256, VERSION_RE);
    noPaths(read, root);

    await assert.rejects(coordination.read(broker, {
      fileHandle: alpha.handle,
      expectedVersion: alpha.version
    }, secondContext), { code: 'WORKSPACE_HANDLE_UNKNOWN' });
    await assert.rejects(coordination.read(broker, {
      fileHandle: 'A'.repeat(43),
      expectedVersion: alpha.version
    }, firstContext), { code: 'WORKSPACE_HANDLE_UNKNOWN' });

    const binary = find(allEntries, 'binary.bin');
    await assert.rejects(coordination.read(broker, {
      fileHandle: binary.handle,
      expectedVersion: binary.version,
      encoding: 'utf8'
    }, firstContext), { code: 'WORKSPACE_FILE_NOT_UTF8' });
    const binaryRead = await coordination.read(broker, {
      fileHandle: binary.handle,
      expectedVersion: binary.version,
      encoding: 'base64'
    }, firstContext);
    assert.equal(binaryRead.content, Buffer.from([0xff, 0x00, 0x7f]).toString('base64'));

    const directory = find(allEntries, 'src');
    const nestedList = broker.list({
      directoryHandle: directory.handle,
      expectedVersion: directory.version
    }, firstContext);
    assert.deepEqual(nestedList.entries.map(entry => entry.name), ['one.js']);
    noPaths(nestedList, root);

    fs.appendFileSync(path.join(root, 'alpha.txt'), 'changed\n', 'utf8');
    await assert.rejects(coordination.read(broker, {
      fileHandle: alpha.handle,
      expectedVersion: alpha.version
    }, firstContext), { code: 'WORKSPACE_HANDLE_STALE' });

    assert.equal(broker.closeSession(firstContext), true);
    await assert.rejects(coordination.read(broker, {
      fileHandle: binary.handle,
      expectedVersion: binary.version,
      encoding: 'base64'
    }, firstContext), { code: 'WORKSPACE_HANDLE_UNKNOWN' });
    assert.ok(auditRecords.some(record => record[0] === 'workspace.list'));
    assert.ok(auditRecords.some(record => record[0] === 'workspace.read'));
    assert.equal(JSON.stringify(auditRecords).includes(root), false);

    broker.audit = { record: () => ({ durable: false, anchored: false }) };
    codes(() => broker.list({}, context('audit-status-failure')), 'WORKSPACE_AUDIT_UNAVAILABLE');
    broker.audit = { record: () => { throw new Error('audit offline'); } };
    codes(() => broker.list({}, context('audit-throw')), 'WORKSPACE_AUDIT_UNAVAILABLE');
    process.stdout.write('fra workspace handle tests passed\n');
  } finally {
    await coordination.retire();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
