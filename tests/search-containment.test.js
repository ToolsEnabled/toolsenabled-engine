'use strict';

/*
 * Containment for search.js's TWO independent `root` arguments -- indexPath's
 * (path.resolve(String(args.root || '.'))) and query's
 * (path.resolve(String(args.root))) -- see src/lib/code-file-containment.js,
 * mirroring the same fix in src/lib/providers/code-intel.js#resolveFilePath.
 * Before this fix neither had any containment call (measured at b7149aeb:
 * zero hits for assertInsideRoots, workspaceRoots, realpath or OUTSIDE in
 * search.js), the exact escape src/lib/workspace-boundary.js's own header
 * names as unpatched: "search.index root -> a secrets dir outside it
 * READ+INDEXED". query's own root is in scope too: it is how a caller reaches
 * previously indexed chunks by scope, so leaving it ungated would let a root
 * indexed before this fix shipped (or before a workspace root was
 * de-recorded) stay queryable forever even once it could no longer be
 * indexed.
 *
 * Run directly: node tests/search-containment.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');

require('./lib/isolated-environment').activate('search-containment');

const REPO_ROOT = path.resolve(__dirname, '..');
// Use an explicit recorded-workspace grant at the dependency seam. The real
// containment and filesystem checks still execute, and no fixture is written
// into a shipped or read-only checkout.
const IN_ROOT_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'te-search-workspace-'));
const registry = require('../src/lib/tool-registry');
const originalWorkspaceRoots = registry.confinedWorkspaceRoots;
registry.confinedWorkspaceRoots = () => [IN_ROOT_SCRATCH];
test.after(() => { registry.confinedWorkspaceRoots = originalWorkspaceRoots; });
process.env.TOOLSENABLED_SEARCH_DB = path.join(IN_ROOT_SCRATCH, 'index.sqlite');

const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');
// Containment tests still write and verify the real signed SQLite audit ledger.
// Its disposable signer and anchor replace OS vault custody, which has its own
// platform tests and must not make a Linux containment fixture need Windows.
const keys = crypto.generateKeyPairSync('ed25519');
const auditStore = createAuditStore({ file: path.join(IN_ROOT_SCRATCH, 'audit.sqlite') });
let anchor = null;
const auditDependencies = {
  store: auditStore,
  signer: { keyId: `search-fixture-${crypto.randomUUID()}`,
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, keys.privateKey) },
  anchorStore: { get: () => anchor, set: value => { anchor = value; } },
  env: { TOOLSENABLED_AUDIT_JSONL_PATH: path.join(IN_ROOT_SCRATCH, 'audit.jsonl'),
    TOOLSENABLED_AUDIT_TEXT_PATH: path.join(IN_ROOT_SCRATCH, 'audit.log'),
    TOOLSENABLED_AUDIT_EMERGENCY_PATH: path.join(IN_ROOT_SCRATCH, 'emergency.jsonl') },
  rootPath: value => path.join(IN_ROOT_SCRATCH, value),
};
const originalRecord = audit.record, originalTail = audit.tail;
audit.record = (action, target, details) => originalRecord(action, target, details, auditDependencies);
audit.tail = limit => originalTail(limit, auditDependencies);
const search = require('../src/lib/search');

test.after(() => {
  try { search.close(); } catch { /* preserve the original test outcome */ }
  try { assert.equal(audit.verify(auditDependencies).valid, true, 'the fixture audit chain must verify'); }
  finally { audit.record = originalRecord; audit.tail = originalTail; auditStore.close(); }
  fs.rmSync(IN_ROOT_SCRATCH, { recursive: true, force: true });
});

test('a root outside every allowed root is refused before any walk or read', async () => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'te-c3-search-escape-'));
  fs.writeFileSync(path.join(outsideRoot, 'secret.md'), 'this must never be walked or read');
  try {
    await assert.rejects(
      () => search.indexPath({ root: outsideRoot, embedder: 'lexical' }),
      error => {
        assert.equal(error.code, 'SEARCH_ROOT_OUTSIDE_ROOT',
          'search.js has no typed-error class, so error.code must still be an own property a caller can match');
        assert.match(error.message, /^SEARCH_ROOT_OUTSIDE_ROOT: /, 'and the code stays readable in the message too');
        assert.match(error.message, /outside the ToolsEnabled root and every recorded workspace root/);
        return true;
      },
      'a root outside every allowed root must be refused'
    );
    const recent = audit.tail(50);
    const auditedRefusal = recent.find(event => event.action === 'search.index_root_outside_root_refused'
      && event.target === outsideRoot);
    assert.ok(auditedRefusal, 'the refusal must land a durable audit entry naming the refused root');
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('an in-root path still indexes normally', async () => {
  const inRoot = fs.mkdtempSync(path.join(IN_ROOT_SCRATCH, 'in-root-'));
  try {
    fs.writeFileSync(path.join(inRoot, 'note.md'), 'plants turn sunlight into energy through leaves');
    const result = await search.indexPath({ root: inRoot, embedder: 'lexical' });
    assert.equal(result.filesIndexed, 1, 'an in-root path must still index normally');
    const recent = audit.tail(50);
    const auditedSuccess = recent.find(event => event.action === 'search.index_completed' && event.target === inRoot);
    assert.ok(auditedSuccess, 'a successful index run must land its own durable audit entry, not just the tool-name-level one');
  } finally {
    fs.rmSync(inRoot, { recursive: true, force: true });
  }
});

test('a query root outside every allowed root is refused, not just filtered to empty', async () => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'te-c3-search-query-escape-'));
  try {
    await assert.rejects(
      () => search.query({ query: 'anything', root: outsideRoot }),
      error => {
        assert.equal(error.code, 'SEARCH_ROOT_OUTSIDE_ROOT');
        assert.match(error.message, /^SEARCH_ROOT_OUTSIDE_ROOT: /);
        assert.match(error.message, /outside the ToolsEnabled root and every recorded workspace root/);
        return true;
      },
      'a query root outside every allowed root must be refused, never silently answered as empty'
    );
    const recent = audit.tail(50);
    const auditedRefusal = recent.find(event => event.action === 'search.query_root_outside_root_refused'
      && event.target === outsideRoot);
    assert.ok(auditedRefusal, 'the refusal must land a durable audit entry naming the refused root');
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('a query root inside an allowed root still queries normally', async () => {
  const inRoot = fs.mkdtempSync(path.join(IN_ROOT_SCRATCH, 'in-root-query-'));
  try {
    fs.writeFileSync(path.join(inRoot, 'note.md'), 'plants turn sunlight into energy through leaves');
    await search.indexPath({ root: inRoot, embedder: 'lexical' });
    const result = await search.query({ query: 'plants turn sunlight into energy', root: inRoot, k: 3 });
    assert.ok(result.matches.length > 0, 'an in-root query root must still return matches');
    const recent = audit.tail(50);
    const auditedSuccess = recent.find(event => event.action === 'search.query_completed' && event.target === inRoot);
    assert.ok(auditedSuccess, 'a successful query must land its own durable audit entry, not just the tool-name-level one');
  } finally {
    fs.rmSync(inRoot, { recursive: true, force: true });
  }
});
