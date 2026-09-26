'use strict';

require('./lib/isolated-environment').activate('fra-workspace-security-socket');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers/fra-private-workspace-socket');

async function page(call, entry) {
  const response = await call('workspace.list', entry
    ? { directoryHandle: entry.handle, expectedVersion: entry.version, limit: 100 } : { limit: 100 });
  assert.notEqual(response.result?.isError, true, JSON.stringify(response));
  assert.ok(response.result?.structuredContent?.entries);
  return response.result.structuredContent;
}
async function childPage(call, parent, name) {
  const entry = parent.entries.find(value => value.name === name);
  assert.ok(entry?.handle, `safe directory ${name} remains available`);
  return page(call, entry);
}
async function read(call, entry, content) {
  assert.ok(entry?.handle);
  const response = await call('workspace.read', { fileHandle: entry.handle, expectedVersion: entry.version });
  assert.notEqual(response.result?.isError, true, JSON.stringify(response));
  assert.equal(response.result.structuredContent.content, content);
}

test('T1608 encrypted workspace dispatch withholds nested excluded directories', async t => {
  const names = ['.git', 'vault', 'node_modules'];
  const files = { 'src/safe.txt': 'safe nested sibling' };
  for (const name of names) files[`src/${name}/canary.txt`] = 'invalid synthetic audit canary';
  const f = await fixture(t, files);
  const call = await f.connect();
  const src = await childPage(call, await page(call), 'src');
  assert.deepEqual(src.entries.map(value => value.name), ['safe.txt']);
  await read(call, src.entries[0], files['src/safe.txt']);
});

test('T1613 encrypted workspace dispatch hides credential stores without marker leaks', async t => {
  const names = ['.ssh', '.aws', '.gnupg', '.docker', '.kube'];
  const files = { 'safe.txt': 'safe root sibling', '.local/share/notes.txt': 'safe store sibling',
    '.local/share/keepassxc/Personal.kdbx': 'invalid synthetic database' };
  for (const name of names) files[`${name}/canary.txt`] = 'invalid synthetic audit canary';
  const f = await fixture(t, files);
  const call = await f.connect();
  const top = await page(call);
  for (const name of names) assert.equal(top.entries.some(value => value.name === name), false, name);
  const share = await childPage(call, await childPage(call, top, '.local'), 'share');
  assert.deepEqual(share.entries.map(value => value.name), ['notes.txt']);
  await read(call, share.entries[0], files['.local/share/notes.txt']);
  await read(call, top.entries.find(value => value.name === 'safe.txt'), files['safe.txt']);
});

test('T1614 encrypted workspace dispatch hides client secrets, provider config and fish history', async t => {
  const f = await fixture(t, { 'client_secret.json': 'invalid synthetic secret',
    '.codex/config.toml': 'invalid synthetic config', '.codex/auth.json': 'invalid synthetic auth',
    '.codex/README.md': 'safe provider documentation', '.local/share/fish/fish_history': 'invalid synthetic history',
    '.local/share/fish/notes.txt': 'safe fish documentation' });
  const call = await f.connect();
  const top = await page(call);
  assert.equal(top.entries.some(value => value.name === 'client_secret.json'), false);
  const codex = await childPage(call, top, '.codex');
  assert.deepEqual(codex.entries.map(value => value.name), ['README.md']);
  const fish = await childPage(call, await childPage(call, await childPage(call, top, '.local'), 'share'), 'fish');
  assert.deepEqual(fish.entries.map(value => value.name), ['notes.txt']);
  await read(call, codex.entries[0], 'safe provider documentation');
  await read(call, fish.entries[0], 'safe fish documentation');
});

test('T1617 new encrypted session refuses a replacement of the captured workspace root', async t => {
  const f = await fixture(t, { 'original.txt': 'safe original content' });
  const originalCall = await f.connect();
  const original = await page(originalCall);
  await read(originalCall, original.entries[0], 'safe original content');
  fs.renameSync(f.root, path.join(f.owned, 'retained-original'));
  fs.mkdirSync(f.root);
  fs.writeFileSync(path.join(f.root, 'replacement.txt'), 'inert replacement content');
  const oldResponse = await originalCall('workspace.list', {});
  assert.equal(oldResponse.result?.isError, true);
  assert.match(JSON.stringify(oldResponse), /WORKSPACE_HANDLE_STALE/);
  const freshCall = await f.connect();
  const freshResponse = await freshCall('workspace.list', {});
  assert.equal(freshResponse.result?.isError, true);
  assert.match(JSON.stringify(freshResponse), /WORKSPACE_HANDLE_STALE/);
});
