'use strict';

/*
 * T1608 / T1613 / T1614 regression, at the broker rather than the classifier.
 *
 * MEASURED against the then-live source (workspace broker and policy
 * byte-identical to the running Linux and Windows runtimes): an authorized FRA peer walked an ordinary granted
 * workspace and listed AND read 15 planted secrets, because the exclusion
 * rule tested `relative.split('/')[0]` only. `vault/master.key` was refused;
 * `server/vault/master.key`, `sub/.git/config` (a remote URL carrying a live
 * token), `.ssh/id_rsa` and `.aws/credentials` were served in full.
 *
 * This test walks the tree the way that peer did -- list the root, recurse
 * into every directory handle returned, then read every file handle returned
 * -- and asserts that nothing carrying secret material comes back while an
 * ordinary project file still does. It fails if the rule ever narrows again.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const coordination = require('./helpers/fra-workspace-authority-fixture');
const { FraWorkspaceHandleBroker } = require('../src/lib/providers/fra-workspace-handles');

const registry = {
  schemaVersion: 1,
  machines: {
    left: { address: '203.0.113.1', root: 'C:\\left', role: 'development-host' },
    right: { address: '203.0.113.2', root: 'C:\\right', role: 'disconnected-peer' }
  },
  services: {}
};

// Planted secrets carry a marker; every one of these leaked before the fix.
const SECRET = 'SECRET-MARKER';
const PLANT = {
  'README.md': 'an ordinary project file',
  'server/index.js': 'an ordinary nested source file',
  'vault/master.key': `top-level ${SECRET}-00`,
  'server/vault/master.key': `nested vault ${SECRET}-01`,
  'a/b/c/vault/deep.key': `deeply nested vault ${SECRET}-02`,
  'server/state/session-store.bin': `nested state ${SECRET}-03`,
  'server/logs/audit.log': `nested logs ${SECRET}-04`,
  'sub/.git/config': `[remote "origin"]\n url = https://x:${SECRET}-05@github.com/o/r`,
  'sub/node_modules/.package-lock.json': `nested modules ${SECRET}-06`,
  '.ssh/id_rsa': `${SECRET}-07`,
  '.aws/credentials': `aws_secret_access_key = ${SECRET}-08`,
  '.kube/config': `client-key-data: ${SECRET}-09`,
  '.docker/config.json': `{"auths":{"r":{"auth":"${SECRET}-10"}}}`,
  '.gnupg/secring.gpg': `${SECRET}-11`,
  '.netrc': `machine api.example.com password ${SECRET}-12`,
  '.git-credentials': `https://user:${SECRET}-13@github.com`,
  'deploy/id_ed25519': `${SECRET}-14`,
  'deploy/server.pem': `${SECRET}-15`,
  'deploy/secrets.yaml': `stripe_live_key: ${SECRET}-16`,
  'deploy/service-account.json': `{"private_key":"${SECRET}-17"}`,
  'home/.config/gcloud/credentials.db': `${SECRET}-18`
};
// Names that merely look like an excluded one must stay reachable.
const REACHABLE = ['README.md', 'server/index.js'];

function statView(stat, changes = {}) {
  return new Proxy(stat, {
    get(target, property) {
      if (Object.hasOwn(changes, property)) return changes[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function normalFs() {
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'lstatSync') return (t, o) => statView(fs.lstatSync(t, o), { nlink: 1n });
      if (property === 'fstatSync') return (fd, o) => statView(fs.fstatSync(fd, o), { nlink: 1n });
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

// Walk every directory handle the broker hands back, exactly as a peer would.
function walk(instance, ctx) {
  const files = [];
  const seen = new Set();
  const descend = (handle, version, prefix) => {
    let cursor;
    let directoryHandle = handle;
    let directoryVersion = version;
    do {
      const args = directoryHandle === null
        ? {}
        : {
          directoryHandle,
          expectedVersion: directoryVersion,
          ...(cursor ? { cursor } : {})
        };
      const page = instance.list(args, ctx);
      cursor = page.nextCursor;
      directoryHandle = page.directoryHandle;
      directoryVersion = page.version;
      for (const entry of page.entries) {
        const child = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (seen.has(child)) continue;
        seen.add(child);
        if (entry.kind === 'directory') descend(entry.handle, entry.version, child);
        else files.push({ path: child, handle: entry.handle, version: entry.version });
      }
    } while (cursor);
  };
  descend(null, null, '');
  return files;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-nested-exclusion-'));
  try {
    for (const [relative, body] of Object.entries(PLANT)) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }

    let counter = 7;
    const instance = new FraWorkspaceHandleBroker({
      root,
      authorityFactory: coordination.authorityFactory(root),
      fsApi: normalFs(),
      serviceRegistryOptions: { registry },
      randomBytes: size => {
        const bytes = Buffer.alloc(size);
        bytes.writeUInt32BE(counter++, size - 4);
        return bytes;
      },
      auditApi: { record: () => ({ durable: true, anchored: true }) }
    });
    const ctx = coordination.context('nested-exclusion');

    const listed = walk(instance, ctx);
    const listedPaths = listed.map(entry => entry.path).sort();

    // Nothing secret may even be named in a listing.
    for (const candidate of Object.keys(PLANT)) {
      if (REACHABLE.includes(candidate)) continue;
      assert.equal(
        listedPaths.includes(candidate), false,
        `workspace.list exposed an excluded path: ${candidate}`
      );
    }
    assert.deepEqual(listedPaths, [...REACHABLE].sort(),
      'workspace.list exposed exactly the reachable ordinary files');

    // And nothing secret may be read, even with a handle in hand.
    for (const entry of listed) {
      const result = await coordination.read(
        instance, { fileHandle: entry.handle, expectedVersion: entry.version }, ctx
      );
      assert.equal(
        result.content.includes(SECRET), false,
        `workspace.read returned secret material from ${entry.path}`
      );
    }

    // The ordinary files must genuinely still be readable: a policy that
    // refuses everything would pass the assertions above for the wrong reason.
    assert.equal(listed.length, REACHABLE.length);
    for (const entry of listed) {
      const result = await coordination.read(
        instance, { fileHandle: entry.handle, expectedVersion: entry.version }, ctx
      );
      assert.equal(result.content, PLANT[entry.path], entry.path);
    }
  } finally {
    await coordination.retire();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('FRA workspace handles refuse excluded directories and credential stores at every depth.');
}

main().catch(error => { console.error(error); process.exit(1); });
