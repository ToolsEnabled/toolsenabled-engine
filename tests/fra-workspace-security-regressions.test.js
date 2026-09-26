'use strict';

// Regression inputs come from FRA audit 2026-09-23: nested-excluded-paths,
// credential-paths/policy-extra/policy-fuzz, desktop/browser/keepass stores,
// shell-history-registry-policy and root-identity-replacement. No owner data.
require('./lib/isolated-environment').activate('fra-security-regressions');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FraWorkspaceHandleBroker } = require('../src/lib/providers/fra-workspace-handles');
const policy = require('../src/lib/fra-workspace-policy');
const coordination = require('./helpers/fra-workspace-authority-fixture');

const registry = { schemaVersion: 1, machines: {
  a: { address: '203.0.113.1', root: 'C:\\a' },
  b: { address: '203.0.113.2', root: 'C:\\b' }
}, services: {} };
let nextContext = 0;

function fixture(t, names, options = {}) {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-security-owned-'));
  const root = path.join(owned, 'workspace');
  fs.mkdirSync(root);
  for (const name of names) {
    const file = path.join(root, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'inert audit fixture; not a credential\n');
  }
  const descriptors = new Set();
  const fsApi = Object.create(fs);
  fsApi.openSync = (...args) => {
    const fd = fs.openSync(...args);
    descriptors.add(fd);
    return fd;
  };
  fsApi.closeSync = fd => {
    fs.closeSync(fd);
    descriptors.delete(fd);
  };
  const broker = new FraWorkspaceHandleBroker({ root, fsApi, ...options,
    serviceRegistryOptions: { registry },
    authorityFactory: coordination.authorityFactory(path.join(owned, 'coordination')),
    auditApi: { requireRecord: () => ({ durable: true, anchored: true }) }
  });
  const contexts = [];
  const context = () => {
    const result = coordination.context(`security-${++nextContext}`);
    contexts.push(result);
    return result;
  };
  t.after(async () => {
    for (const ctx of contexts) broker.closeSession(ctx);
    await coordination.retire();
    assert.equal(descriptors.size, 0, 'every opened native descriptor must close');
    // Only this run's mkdtemp directory is removed. Evidence lives elsewhere.
    fs.rmSync(owned, { recursive: true, force: true });
    assert.equal(fs.existsSync(owned), false);
    t.diagnostic(JSON.stringify({ fixtureRoot: owned, cleanupAssertedAbsent: true }));
  });
  return { owned, root, broker, context };
}

function descend(broker, context, page, name) {
  const entry = page.entries.find(item => item.name === name);
  assert.ok(entry?.handle, `safe directory ${name} must have a handle`);
  return broker.list({ directoryHandle: entry.handle, expectedVersion: entry.version }, context);
}

function openAndClose(broker, file) {
  const opened = broker._openIdentity(file, 'file');
  broker._close(opened.fd);
}

test('T1608 excludes every nested forbidden segment from listings and direct identity opens', t => {
  const denied = ['.git', 'vault', 'node_modules', 'state', 'logs', 'profiles'];
  const f = fixture(t, ['src/deep/safe.txt', ...denied.flatMap(name => [
    `${name}/canary.txt`, `src/deep/${name}/canary.txt`
  ])]);
  const ctx = f.context();
  const top = f.broker.list({}, ctx);
  assert.deepEqual(top.entries.map(e => e.name), ['src']);
  const deep = descend(f.broker, ctx, descend(f.broker, ctx, top, 'src'), 'deep');
  assert.deepEqual(deep.entries.map(e => e.name), ['safe.txt']);
  for (const name of denied) {
    assert.throws(() => openAndClose(f.broker, path.join(f.root, 'src', 'deep', name, 'canary.txt')),
      { code: 'WORKSPACE_ENTRY_FORBIDDEN' });
  }
});

const credentialDirectories = [
  '.ssh', '.aws', '.gnupg', '.docker', '.kube', '.gemini', '.config/gcloud',
  '.local/share/keepassxc', '.local/share/keyrings', '.pki/nssdb',
  '.local/share/kwalletd', '.password-store', '.config/1Password',
  '.mozilla/firefox', '.config/chromium'
];
for (const directory of credentialDirectories) {
  test(`T1613 withholds ${directory} at root and beneath an ordinary directory`, t => {
    const names = [directory, `project/${directory}`].map(p => `${p}/canary.txt`);
    const f = fixture(t, ['safe.txt', ...names]);
    for (const name of names) {
      assert.throws(() => openAndClose(f.broker, path.join(f.root, ...name.split('/'))),
        { code: 'WORKSPACE_ENTRY_FORBIDDEN' });
    }
    const ctx = f.context();
    let page = f.broker.list({}, ctx);
    const segments = directory.split('/');
    for (const segment of segments.slice(0, -1)) page = descend(f.broker, ctx, page, segment);
    assert.equal(page.entries.some(e => e.name === segments.at(-1)), false);
  });
}

const forbiddenFiles = [
  'client_secret.json', 'client-secret.json', 'oauth_client_secret.json',
  '.codex/config.toml', '.claude.json', '.claude/settings.json',
  '.config/provider/client_secret.json', '.config/provider/api_key.json',
  'service-account.json', 'application_default_credentials.json', 'credentials',
  'id_rsa', 'id_ed25519', 'private_key.pem', 'tls.key', 'client.p12', 'client.pfx',
  '.netrc', '.pgpass', '.my.cnf', '.git-credentials', '.config/git/credentials',
  '.local/share/fish/fish_history',
  // Existing refusals must remain exact, including separator/case variants.
  '.codex/auth.json', '.cargo/credentials.toml', '.npmrc', '.pypirc',
  '.bash_history', '.zsh_history', '.fish_history', '.env.production',
  '.azure/accessTokens.json', '.config/gh/hosts.yml'
];
for (const file of forbiddenFiles) {
  test(`T1614 classifies credential/history path ${file}`, () => {
    assert.equal(policy.isCredentialOrHistoryPath(file), true, file);
    assert.equal(policy.isCredentialOrHistoryPath(`project/${file}`), true, `nested ${file}`);
    assert.equal(policy.isCredentialOrHistoryPath(file.replaceAll('/', '\\').toUpperCase()), true, `Windows spelling ${file}`);
  });
}

test('T1614 listing removes credential files while ordinary sibling handles remain readable', async t => {
  const f = fixture(t, ['client_secret.json', '.codex/config.toml', '.codex/auth.json',
    '.codex/README.md', '.local/share/fish/fish_history', '.local/share/fish/notes.txt', 'safe.txt']);
  const ctx = f.context();
  const top = f.broker.list({}, ctx);
  assert.equal(top.entries.some(e => e.name === 'client_secret.json'), false);
  const codex = descend(f.broker, ctx, top, '.codex');
  assert.deepEqual(codex.entries.map(e => e.name), ['README.md']);
  const fish = descend(f.broker, ctx,
    descend(f.broker, ctx, descend(f.broker, ctx, top, '.local'), 'share'), 'fish');
  assert.deepEqual(fish.entries.map(e => e.name), ['notes.txt']);
  for (const file of [codex.entries[0], fish.entries[0], top.entries.find(e => e.name === 'safe.txt')]) {
    const read = await coordination.read(f.broker, { fileHandle: file.handle, expectedVersion: file.version }, ctx);
    assert.equal(read.content, 'inert audit fixture; not a credential\n');
  }
});

test('T1614 preserves non-secret names and example files', () => {
  for (const file of ['config.toml', '.codex/README.md', '.config/provider/settings.json',
    '.cargo/config.toml', '.local/share/fish/notes.txt', 'client_config.json',
    'tokenizer.json', 'session-notes.txt', 'public_key.pem', 'certificate.pem',
    '.env.example', '.env.template', '.env.sample']) {
    assert.equal(policy.isCredentialOrHistoryPath(file), false, file);
  }
  assert.equal(policy.isExcludedDirectoryPath('projects/keepassxc/docs'), false,
    'a project sharing the store name is not the credential-store path');
});

for (const listOriginal of [false, true]) {
  test(`T1617 refuses replacement root in fresh session (prior listing=${listOriginal})`, t => {
    const f = fixture(t, ['original.txt']);
    const originalContext = f.context();
    const original = listOriginal ? f.broker.list({}, originalContext) : null;
    fs.renameSync(f.root, path.join(f.owned, 'original-kept'));
    fs.mkdirSync(f.root);
    fs.writeFileSync(path.join(f.root, 'replacement.txt'), 'inert replacement');
    if (original) assert.throws(() => f.broker.list({ directoryHandle: original.directoryHandle,
      expectedVersion: original.version }, originalContext), { code: 'WORKSPACE_HANDLE_STALE' });
    const freshContext = f.context();
    assert.throws(() => f.broker.list({}, freshContext), { code: 'WORKSPACE_HANDLE_STALE' });
    const session = f.broker.sessions.get(freshContext.fraWorkspaceContext.sessionContextDigest);
    assert.equal(session.handles.size, 0, 'no replacement handle registered');
  });
}

test('T1617 ordinary root-content mutation permits reconnect but keeps old handles stale', t => {
  const f = fixture(t, ['original.txt']);
  const ctx = f.context();
  const original = f.broker.list({}, ctx);
  const identity = fs.statSync(f.root, { bigint: true });
  fs.mkdirSync(path.join(f.root, 'new-directory'));
  const after = fs.statSync(f.root, { bigint: true });
  assert.equal(identity.ino, after.ino);
  assert.throws(() => f.broker.list({ directoryHandle: original.directoryHandle,
    expectedVersion: original.version }, ctx), { code: 'WORKSPACE_HANDLE_STALE' });
  assert.deepEqual(f.broker.list({}, f.context()).entries.map(e => e.name), ['new-directory', 'original.txt']);
});

// An NTFS folder keeps one link and size zero, and its times move in 15.6 ms
// steps, so a child added, removed or renamed inside one step leaves the
// folder's stat identical (T1797; #54 above failed 7 of 15 Windows runs).
// Replay the folder's pre-change stat so that case runs deterministically on
// every platform. Only this entry's stat is replayed (a folder's here, a
// file's below); every entry and byte is real.
function sameTimeStep(f, entry) {
  const frozen = fs.statSync(entry, { bigint: true });
  const replay = stat => (stat.dev !== frozen.dev || stat.ino !== frozen.ino) ? stat
    : Object.defineProperties(Object.create(stat), Object.fromEntries(
      ['nlink', 'size', 'atimeNs', 'mtimeNs', 'ctimeNs'].map(name => [name, { value: frozen[name] }])));
  f.broker.fs.lstatSync = (...args) => replay(fs.lstatSync(...args));
  f.broker.fs.fstatSync = (...args) => replay(fs.fstatSync(...args));
}

for (const [change, apply, expected] of [
  ['a file added', root => fs.writeFileSync(path.join(root, 'added.txt'), 'inert same-step fixture'),
    ['added.txt', 'original.txt', 'second.txt']],
  ['a folder added', root => fs.mkdirSync(path.join(root, 'added-folder')),
    ['added-folder', 'original.txt', 'second.txt']],
  ['a file removed', root => fs.rmSync(path.join(root, 'second.txt')), ['original.txt']],
  ['a file renamed', root => fs.renameSync(path.join(root, 'second.txt'), path.join(root, 'renamed.txt')),
    ['original.txt', 'renamed.txt']]
]) {
  test(`T1797 ${change} within one filesystem time step keeps the old folder handle stale`, t => {
    const f = fixture(t, ['original.txt', 'second.txt']);
    const ctx = f.context();
    const listed = f.broker.list({}, ctx);
    sameTimeStep(f, f.root);
    apply(f.root);
    const stale = () => f.broker.list({ directoryHandle: listed.directoryHandle,
      expectedVersion: listed.version }, ctx);
    assert.throws(stale, { code: 'WORKSPACE_HANDLE_STALE' });
    assert.throws(stale, { code: 'WORKSPACE_HANDLE_STALE' }, 'the old handle stays stale');
    assert.deepEqual(f.broker.list({}, f.context()).entries.map(e => e.name), expected,
      'a fresh connection lists the changed folder');
  });
}

test('T1797 an unchanged folder keeps its handle and a rewritten child file does not make it stale', t => {
  const f = fixture(t, ['original.txt', 'second.txt']);
  const ctx = f.context();
  const listed = f.broker.list({}, ctx);
  sameTimeStep(f, f.root);
  const args = { directoryHandle: listed.directoryHandle, expectedVersion: listed.version };
  const again = f.broker.list(args, ctx);
  assert.equal(again.directoryHandle, listed.directoryHandle);
  assert.deepEqual(again.entries, listed.entries, 'an unchanged folder lists the same handles');
  // A POSIX folder's stat does not move when a child's bytes change; neither
  // does the child set. The file's own handle carries that change.
  fs.writeFileSync(path.join(f.root, 'second.txt'), 'rewritten with a different length');
  const rewritten = f.broker.list(args, ctx);
  assert.deepEqual(rewritten.entries.map(e => e.name), ['original.txt', 'second.txt']);
  const before = listed.entries.find(e => e.name === 'second.txt');
  const after = rewritten.entries.find(e => e.name === 'second.txt');
  assert.notEqual(after.version, before.version, 'the rewritten file has a new version');
});

test('T1797 a fresh listing of the parent replaces a folder handle that went stale within one time step', t => {
  const f = fixture(t, ['sub/one.txt']);
  const ctx = f.context();
  const root = f.broker.list({}, ctx);
  const sub = root.entries.find(e => e.name === 'sub');
  const listSub = entry => f.broker.list({ directoryHandle: entry.handle, expectedVersion: entry.version }, ctx);
  assert.deepEqual(listSub(sub).entries.map(e => e.name), ['one.txt']);
  sameTimeStep(f, path.join(f.root, 'sub'));
  fs.writeFileSync(path.join(f.root, 'sub', 'two.txt'), 'inert same-step fixture');
  assert.throws(() => listSub(sub), { code: 'WORKSPACE_HANDLE_STALE' });
  const relisted = f.broker.list({ directoryHandle: root.directoryHandle, expectedVersion: root.version }, ctx);
  const fresh = relisted.entries.find(e => e.name === 'sub');
  assert.notEqual(fresh.handle, sub.handle, 'the parent issues a new handle for the changed folder');
  assert.deepEqual(listSub(fresh).entries.map(e => e.name), ['one.txt', 'two.txt']);
  assert.throws(() => listSub(sub), { code: 'WORKSPACE_HANDLE_STALE' }, 'the old handle stays stale');
});

test('T1797 immediate changes on the real filesystem always leave the listed folder handle stale', t => {
  // No replayed stat and no sleep: on NTFS about half of these changes land in
  // the same time step as the listing (#54's flake); elsewhere they do not.
  // Either way the old handle must be refused.
  const f = fixture(t, ['original.txt']);
  let sameStep = 0;
  const attempts = 40;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctx = f.context();
    const listed = f.broker.list({}, ctx);
    const before = fs.statSync(f.root, { bigint: true });
    fs.writeFileSync(path.join(f.root, `added-${attempt}.txt`), 'inert immediate-change fixture');
    const after = fs.statSync(f.root, { bigint: true });
    if (['nlink', 'size', 'mtimeNs', 'ctimeNs'].every(name => before[name] === after[name])) sameStep += 1;
    assert.throws(() => f.broker.list({ directoryHandle: listed.directoryHandle,
      expectedVersion: listed.version }, ctx), { code: 'WORKSPACE_HANDLE_STALE' }, `attempt ${attempt}`);
    assert.equal(f.broker.closeSession(ctx), true);
  }
  t.diagnostic(JSON.stringify({ platform: process.platform, attempts, sameTimeStepChanges: sameStep }));
});

// The file analogue of T1797: a same-size rewrite inside one time stamp leaves
// a file's stat identical. Measured on Windows before this fix: 17 of 120
// immediate rewrites kept the stat, and in exactly those the OLD handle and
// version returned the NEW bytes. sameTimeStep replays the file's pre-rewrite
// stat so these cases run deterministically on every platform.
const REWRITTEN = 'inert audit fixture; not a credential\n'.toUpperCase();
function readFile(f, entry, ctx) {
  return coordination.read(f.broker, { fileHandle: entry.handle, expectedVersion: entry.version }, ctx);
}
function countListingReads(f) {
  const counted = { calls: 0, bytes: 0 };
  const readSync = f.broker.fs.readSync;
  f.broker.fs.readSync = (...args) => {
    const count = readSync.apply(fs, args);
    counted.calls += 1;
    counted.bytes += count;
    return count;
  };
  return counted;
}

test('T1797 a recently written file rewritten within one time stamp leaves the old file handle stale', async t => {
  const f = fixture(t, ['note.txt']);
  const file = path.join(f.root, 'note.txt');
  assert.equal(REWRITTEN.length, fs.readFileSync(file, 'utf8').length, 'the rewrite keeps the size');
  const ctx = f.context();
  const listed = f.broker.list({}, ctx).entries.find(e => e.name === 'note.txt');
  sameTimeStep(f, file);
  fs.writeFileSync(file, REWRITTEN);
  await assert.rejects(readFile(f, listed, ctx), { code: 'WORKSPACE_HANDLE_STALE' },
    'the old handle must not return the new bytes under the old version');
  await assert.rejects(readFile(f, listed, ctx), { code: 'WORKSPACE_HANDLE_STALE' }, 'the old handle stays stale');
  const relisted = f.broker.list({}, ctx).entries.find(e => e.name === 'note.txt');
  assert.equal(relisted.version, listed.version, 'the stat version cannot see this rewrite');
  assert.notEqual(relisted.handle, listed.handle, 'a fresh listing issues a new handle for the new bytes');
  assert.equal((await readFile(f, relisted, ctx)).content, REWRITTEN);
  await assert.rejects(readFile(f, listed, ctx), { code: 'WORKSPACE_HANDLE_STALE' });
});

test('T1797 a file listed long after its last change is bound by its first read, without a listing read', async t => {
  const f = fixture(t, ['note.txt'], { now: () => Date.now() + 60 * 60 * 1000 });
  const file = path.join(f.root, 'note.txt');
  const ctx = f.context();
  const counted = countListingReads(f);
  const listed = f.broker.list({}, ctx).entries.find(e => e.name === 'note.txt');
  assert.deepEqual(counted, { calls: 0, bytes: 0 }, 'a listing reads no bytes of a file older than one time stamp');
  const original = (await readFile(f, listed, ctx)).content;
  sameTimeStep(f, file);
  fs.writeFileSync(file, REWRITTEN);
  await assert.rejects(readFile(f, listed, ctx), { code: 'WORKSPACE_HANDLE_STALE' },
    'a second read must not return different bytes under the same handle and version');
  const relisted = f.broker.list({}, ctx).entries.find(e => e.name === 'note.txt');
  assert.notEqual(relisted.handle, listed.handle);
  assert.notEqual(original, REWRITTEN);
  assert.equal((await readFile(f, relisted, ctx)).content, REWRITTEN);
});

test('T1797 a listing reads recently written files only within its byte budget', async t => {
  const size = Buffer.byteLength('inert audit fixture; not a credential\n');
  const f = fixture(t, ['a.txt', 'b.txt', 'c.txt'], { listingContentBudgetBytes: size + size - 1 });
  const ctx = f.context();
  const counted = countListingReads(f);
  const listed = f.broker.list({}, ctx).entries;
  assert.equal(counted.bytes, size, 'one whole file fits the budget; the next two do not');
  assert.ok(counted.bytes <= size + size - 1);
  // Past the budget a file is bound by its first read.
  const c = listed.find(e => e.name === 'c.txt');
  await readFile(f, c, ctx);
  sameTimeStep(f, path.join(f.root, 'c.txt'));
  fs.writeFileSync(path.join(f.root, 'c.txt'), REWRITTEN);
  await assert.rejects(readFile(f, c, ctx), { code: 'WORKSPACE_HANDLE_STALE' });
});

test('T1797 an unchanged recently written file keeps its handle across listings and reads', async t => {
  const f = fixture(t, ['note.txt']);
  const ctx = f.context();
  const listed = f.broker.list({}, ctx).entries.find(e => e.name === 'note.txt');
  sameTimeStep(f, path.join(f.root, 'note.txt'));
  const first = await readFile(f, listed, ctx);
  const again = f.broker.list({}, ctx).entries.find(e => e.name === 'note.txt');
  assert.equal(again.handle, listed.handle, 'unchanged bytes keep the handle');
  const second = await readFile(f, again, ctx);
  assert.equal(second.content, first.content);
  assert.equal(second.fileSha256, first.fileSha256);
});

test('T1797 immediate same-size rewrites on the real filesystem always leave the listed file handle stale', async t => {
  // No replayed stat and no sleep: on NTFS some of these rewrites land in the
  // same time stamp as the listed write; elsewhere they do not. Either way the
  // old handle must never return the new bytes.
  const f = fixture(t, []);
  let sameStamp = 0;
  const attempts = 40;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const file = path.join(f.root, `rewrite-${attempt}.txt`);
    fs.writeFileSync(file, 'AAAAAAAA');
    const ctx = f.context();
    const listed = f.broker.list({}, ctx).entries.find(e => e.name === `rewrite-${attempt}.txt`);
    const before = fs.statSync(file, { bigint: true });
    fs.writeFileSync(file, 'BBBBBBBB');
    const after = fs.statSync(file, { bigint: true });
    if (['ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(name => before[name] === after[name])) sameStamp += 1;
    await assert.rejects(readFile(f, listed, ctx), { code: 'WORKSPACE_HANDLE_STALE' }, `attempt ${attempt}`);
    assert.equal(f.broker.closeSession(ctx), true);
  }
  t.diagnostic(JSON.stringify({ platform: process.platform, attempts, sameStampRewrites: sameStamp }));
});

test('T1617 refuses a replacement root even when the filesystem recycles its inode number', t => {
  const f = fixture(t, ['original.txt']);
  const original = fs.statSync(f.root, { bigint: true });
  fs.renameSync(f.root, path.join(f.owned, 'retained-original'));
  fs.mkdirSync(f.root);
  fs.writeFileSync(path.join(f.root, 'replacement.txt'), 'inert recycled-inode fixture');
  const replacement = fs.statSync(f.root, { bigint: true });
  // Reproduce the filesystem identity reuse deterministically. Metadata and
  // bytes remain those of the replacement; only the recycled object number is
  // injected, with a distinct creation identity as real inode reuse supplies.
  const recycled = stat => {
    if (stat.dev !== replacement.dev || stat.ino !== replacement.ino) return stat;
    return Object.defineProperties(Object.create(stat), {
      ino: { value: original.ino }, birthtimeNs: { value: original.birthtimeNs + 1n }
    });
  };
  f.broker.fs.lstatSync = (...args) => recycled(fs.lstatSync(...args));
  f.broker.fs.fstatSync = (...args) => recycled(fs.fstatSync(...args));
  assert.throws(() => f.broker.list({}, f.context()), { code: 'WORKSPACE_HANDLE_STALE' });
});

test('T1617 refuses unavailable root creation identity and closes the opened descriptor', t => {
  const f = fixture(t, ['safe.txt']);
  f.broker.fs.fstatSync = (...args) => Object.defineProperty(
    Object.create(fs.fstatSync(...args)), 'birthtimeNs', { value: 0n });
  assert.throws(() => new FraWorkspaceHandleBroker({ root: f.root, fsApi: f.broker.fs }),
    { code: 'WORKSPACE_ROOT_IDENTITY_UNAVAILABLE' });
  assert.throws(() => f.broker.list({}, f.context()), { code: 'WORKSPACE_ROOT_IDENTITY_UNAVAILABLE' });
});

for (const explicit of [false, true]) {
  test(`T1617 rechecks creation identity for ${explicit ? 'explicit' : 'cached implicit'} session roots`, t => {
    const f = fixture(t, ['original.txt']);
    const context = f.context();
    const listed = f.broker.list({}, context);
    const original = fs.statSync(f.root, { bigint: true });
    fs.renameSync(f.root, path.join(f.owned, 'retained-original'));
    fs.mkdirSync(f.root);
    fs.writeFileSync(path.join(f.root, 'replacement.txt'), 'inert replacement fixture');
    const replacement = fs.statSync(f.root, { bigint: true });
    // Force the full legacy stat tuple to repeat while creation identity
    // changes. This isolates the cached-handle admission seam deterministically.
    const replayLegacyIdentity = stat => {
      if (stat.dev !== replacement.dev || stat.ino !== replacement.ino) return stat;
      const fields = Object.fromEntries(['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
        .map(name => [name, { value: original[name] }]));
      fields.birthtimeNs = { value: original.birthtimeNs + 1n };
      return Object.defineProperties(Object.create(stat), fields);
    };
    f.broker.fs.lstatSync = (...args) => replayLegacyIdentity(fs.lstatSync(...args));
    f.broker.fs.fstatSync = (...args) => replayLegacyIdentity(fs.fstatSync(...args));
    const args = explicit ? {
      directoryHandle: listed.directoryHandle,
      expectedVersion: listed.version
    } : {};
    assert.throws(() => f.broker.list(args, context), { code: 'WORKSPACE_HANDLE_STALE' });
  });
}
