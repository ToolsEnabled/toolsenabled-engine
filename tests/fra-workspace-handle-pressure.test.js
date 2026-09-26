'use strict';

/*
 * A workspace listing must mint a handle for what it RETURNS, not for what it
 * scanned.
 *
 * MEASURED against the then-live broker: listing a 1,500-entry directory with
 * the default page limit of 100 registered 1,501 session handles -- 36.6% of
 * the 4,096-handle session ceiling for 100 results. Handles are never released
 * and a session lasts 20 minutes, so the third such listing ended the session
 * with WORKSPACE_HANDLE_CAPACITY. A customer browsing an ordinary project
 * folder exhausted their own workspace session, and a paired peer could do it
 * deliberately in three calls.
 *
 * The set digest is computed from name, kind and version, none of which need a
 * handle, so cursor stability is unaffected by minting them per page.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const coordination = require('./helpers/fra-workspace-authority-fixture');
const {
  FraWorkspaceHandleBroker,
  MAX_HANDLES_PER_SESSION,
  MAX_PAGE_ENTRIES
} = require('../src/lib/providers/fra-workspace-handles');

const registry = {
  schemaVersion: 1,
  machines: {
    left: { address: '203.0.113.1', root: 'C:\\left', role: 'development-host' },
    right: { address: '203.0.113.2', root: 'C:\\right', role: 'disconnected-peer' }
  },
  services: {}
};

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

function broker(root) {
  let counter = 7;
  return new FraWorkspaceHandleBroker({
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
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-handle-pressure-'));
  try {
    const ENTRIES = 1500;
    for (let i = 0; i < ENTRIES; i += 1) {
      fs.writeFileSync(path.join(root, `file-${String(i).padStart(5, '0')}.txt`), 'x');
    }

    const instance = broker(root);
    const ctx = coordination.context('handle-pressure');
    const page = instance.list({ limit: MAX_PAGE_ENTRIES }, ctx);
    const session = instance.sessions.get(ctx.fraWorkspaceContext.sessionContextDigest);

    assert.equal(page.entries.length, MAX_PAGE_ENTRIES, 'the page is the size that was asked for');

    // One handle per returned entry, plus the root directory's own handle.
    assert.ok(
      session.handles.size <= MAX_PAGE_ENTRIES + 1,
      `listing ${ENTRIES} entries to return ${MAX_PAGE_ENTRIES} minted ${session.handles.size} handles; `
      + 'a handle belongs to an entry that was returned, not to one that was merely scanned'
    );

    // The real consequence: a customer can keep browsing.
    const ceilingUse = session.handles.size / MAX_HANDLES_PER_SESSION;
    assert.ok(ceilingUse < 0.05,
      `one listing consumed ${(ceilingUse * 100).toFixed(1)}% of the session handle ceiling`);

    // Every returned entry still carries a usable handle and version.
    for (const entry of page.entries) {
      assert.match(entry.handle, /^[A-Za-z0-9_-]{43}$/, `${entry.name} has an opaque handle`);
      assert.match(entry.version, /^[a-f0-9]{64}$/, `${entry.name} has a version`);
      assert.equal(typeof entry.bytes, 'number', `${entry.name} reports its size`);
    }

    // Paging stays coherent: the cursor must still resolve against the same
    // entry set, and the second page must be different entries.
    assert.ok(page.nextCursor, 'a 1500-entry directory pages');
    const second = instance.list(
      { directoryHandle: page.directoryHandle, expectedVersion: page.version, cursor: page.nextCursor },
      ctx
    );
    assert.equal(second.entries.length, MAX_PAGE_ENTRIES, 'the second page is full too');
    const firstNames = new Set(page.entries.map(entry => entry.name));
    assert.equal(second.entries.some(entry => firstNames.has(entry.name)), false,
      'the second page does not repeat the first');

    // Browsing repeatedly must not end the session. Done before the read
    // below: the byte-authority fixture keeps its state under this same root,
    // so a read legitimately changes the directory and stales its handle.
    const beforeRepeats = session.handles.size;
    for (let i = 0; i < 12; i += 1) {
      assert.doesNotThrow(
        () => instance.list({ limit: MAX_PAGE_ENTRIES }, ctx),
        `listing the directory again must not exhaust the session (iteration ${i + 1})`
      );
    }
    // Re-listing the same page must reuse the handles it already minted.
    assert.equal(session.handles.size, beforeRepeats,
      `twelve further listings of the same page grew the table from ${beforeRepeats} to ${session.handles.size}; identical entries must reuse their handles`);
    // Two distinct pages plus the root, and nothing more.
    assert.ok(session.handles.size <= (2 * MAX_PAGE_ENTRIES) + 1,
      `the session holds ${session.handles.size} handles for two pages of ${MAX_PAGE_ENTRIES}`);

    // And the handles are genuinely usable for the thing they exist for.
    const target = page.entries[0];
    const read = await coordination.read(
      instance, { fileHandle: target.handle, expectedVersion: target.version }, ctx
    );
    assert.equal(read.content, 'x', 'a handle from the page reads its file');

  } finally {
    await coordination.retire();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('A workspace listing mints handles for the page it returns, not for every entry it scanned.');
}

main().catch(error => { console.error(error); process.exit(1); });
