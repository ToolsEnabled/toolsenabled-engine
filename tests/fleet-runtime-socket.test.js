'use strict';
require('./lib/isolated-environment').activate('fleet-runtime-socket');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runtimeSocketPath } = require('../src/lib/fleet-runtime-socket');
const { createTreeLinkServer } = require('../src/lib/openshell-tree-link');

test('a valid XDG runtime dir selects private 0700 directories independent of HOME', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preferred = path.join('/fixture', 'h'.repeat(60), '.toolsenabled', 'tree', 'link.sock');
  const socket = runtimeSocketPath(preferred, { env: { XDG_RUNTIME_DIR: root } });
  assert.ok(socket.startsWith(path.join(root, 'tef') + path.sep));
  assert.ok(Buffer.byteLength(socket) <= 100);
  for (const folder of [path.join(root, 'tef'), path.dirname(socket)]) {
    const stat = fs.lstatSync(folder);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.uid, process.getuid());
    assert.equal(stat.mode & 0o777, 0o700);
  }
});

test('a linked or public runtime child is refused without touching it', t => {
  for (const kind of ['link', 'public']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-runtime-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const child = path.join(root, 'tef');
    if (kind === 'link') fs.symlinkSync(path.join(root, 'elsewhere'), child);
    else { fs.mkdirSync(child); fs.chmodSync(child, 0o755); }
    assert.throws(() => runtimeSocketPath('/fixture/tree/link.sock', { env: { XDG_RUNTIME_DIR: root } }),
      { code: 'FLEET_RUNTIME_SOCKET_UNSAFE' });
    assert.equal(kind === 'link' ? fs.readlinkSync(child) : fs.statSync(child).mode & 0o777,
      kind === 'link' ? path.join(root, 'elsewhere') : 0o755);
  }
});

test('an invalid XDG directory falls back to short per-uid /tmp without following its link', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const linked = path.join(root, 'linked');
  fs.symlinkSync(path.join(root, 'absent'), linked);
  const socket = runtimeSocketPath('/fixture/tree/link.sock', { env: { XDG_RUNTIME_DIR: linked } });
  assert.ok(socket.startsWith(`/tmp/tef-${process.getuid()}/`));
  assert.equal(fs.readlinkSync(linked), path.join(root, 'absent'));
});

test('a private worker server preserves an existing socket candidate', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socket = runtimeSocketPath('/fixture/tree/link.sock', { env: { XDG_RUNTIME_DIR: root } });
  fs.writeFileSync(socket, 'keep');
  const server = createTreeLinkServer({ socketPath: socket, handle: () => null, refuseExisting: true });
  await assert.rejects(server.listen(), { code: 'OPENSHELL_TREE_LINK_IN_USE' });
  assert.equal(fs.readFileSync(socket, 'utf8'), 'keep');
});
