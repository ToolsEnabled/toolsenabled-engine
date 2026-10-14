'use strict';
const { activate } = require('./lib/isolated-environment');
const isolated = activate('legacy-signin-cleanup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { cleanupLegacySignIns } = require('../src/lib/legacy-signin-cleanup');
const { createOwnerHost } = require('../src/owner-host');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(isolated.root, 'cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const servicesRoot = path.join(root, 'services');
  const session = path.join(servicesRoot, 'agent-home', '@agents', 'worker-one', '@sessions', 'a'.repeat(64));
  const home = (provider = 'codex') => path.join(session, provider, 'standard', '@default');
  const put = (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'synthetic fixture'); return file; };
  const run = options => cleanupLegacySignIns({ servicesRoot, ...options });
  return { root, servicesRoot, session, home, put, run };
}

test('removes all three sign-in copies and the historical credential temporary names', async t => {
  const f = fixture(t);
  const files = [
    path.join(f.home(), 'auth.json'),
    path.join(f.home(), 'auth.json.123.1700000000000.refresh'),
    path.join(f.home('claude'), '.credentials.json'),
    path.join(f.home('claude'), '.credentials.json.123.1700000000000.refresh'),
    path.join(f.home('gemini'), '.gemini', 'oauth_creds.json'),
    path.join(f.home('gemini'), '.gemini', 'oauth_creds.toolsenabled-' + 'b'.repeat(32) + '.tmp'),
  ].map(f.put);
  const result = await f.run();
  assert.equal(result.complete, true);
  assert.equal(result.removedCount, files.length);
  assert.deepEqual([...result.removed].sort(), files.map(file => path.relative(f.servicesRoot, file)).sort());
  for (const file of files) assert.equal(fs.existsSync(file), false);
  assert.equal(JSON.stringify(result).includes('synthetic fixture'), false);
});

test('unlinks hard links, symbolic links and dangling sign-in links without touching the target', async t => {
  const f = fixture(t);
  const outside = f.put(path.join(f.root, 'person', 'auth.json'));
  fs.mkdirSync(f.home(), { recursive: true });
  const hard = path.join(f.home(), 'auth.json');
  fs.linkSync(outside, hard);
  const symbolic = path.join(f.home(), 'auth.json.1.2.refresh');
  const dangling = path.join(f.home(), 'auth.json.3.4.refresh');
  try { fs.symlinkSync(outside, symbolic, 'file'); fs.symlinkSync(path.join(f.root, 'absent'), dangling, 'file'); }
  catch (error) { assert.fail('File symlink fixture unavailable: ' + error.code); }
  const before = fs.statSync(outside);
  const result = await f.run();
  assert.equal(result.removedCount, 3);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic fixture');
  assert.equal(fs.statSync(outside).ino, before.ino);
  assert.equal(fs.statSync(outside).nlink, 1);
  assert.throws(() => fs.lstatSync(symbolic), { code: 'ENOENT' });
  assert.throws(() => fs.lstatSync(dangling), { code: 'ENOENT' });
});

test('keeps logs, lookalikes, other providers, non-session homes, personal and registry homes', async t => {
  const f = fixture(t);
  const files = [
    path.join(f.home(), 'sessions', 'auth.json'),
    path.join(f.home(), 'session.jsonl'),
    path.join(f.home(), 'config.toml'),
    path.join(f.home(), 'auth.json.bak-person-2020'),
    path.join(f.home(), 'auth.json.tmp'),
    path.join(f.home(), 'auth.json.1.bad.refresh'),
    path.join(f.home(), '.credentials.json'),
    path.join(f.home('grok'), 'auth.json'),
    path.join(f.servicesRoot, 'agent-home', '@agents', 'invalid agent', '@sessions', 'a'.repeat(64), 'codex', 'standard', '@default', 'auth.json'),
    path.join(f.servicesRoot, 'agent-home', '@agents', 'worker-one', 'other', 'a'.repeat(64), 'codex', 'standard', '@default', 'auth.json'),
    path.join(f.servicesRoot, 'agent-home', '@agents', 'worker-one', '@sessions', 'not-a-session', 'codex', 'standard', '@default', 'auth.json'),
    path.join(f.session, 'codex', 'unknown-tier', '@default', 'auth.json'),
    path.join(f.servicesRoot, 'agent-home', 'standard', 'auth.json'),
    path.join(f.servicesRoot, 'agent-home', '@agents', 'worker-one', 'codex', 'standard', '@default', 'auth.json'),
    path.join(f.root, 'capability', 'codex-homes', 'personal', 'auth.json'),
    path.join(f.root, 'capability', 'claude-homes', 'personal', '.credentials.json'),
    path.join(f.root, 'capability', 'gemini-homes', 'personal', '.gemini', 'oauth_creds.json'),
    path.join(f.root, 'person', '.codex', 'auth.json'),
    path.join(f.root, 'person', '.claude', '.credentials.json'),
    path.join(f.root, 'person', '.gemini', 'oauth_creds.json'),
  ].map(f.put);
  assert.equal((await f.run()).complete, true);
  for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic fixture', file);
});

for (const level of ['services', 'agent-home', '@agents', 'agent', '@sessions', 'session', 'provider', 'tier', 'account', 'gemini-config']) {
  test('refuses directory links at ' + level + ' and never follows them outside', async t => {
    const f = fixture(t);
    const directories = [f.servicesRoot, path.join(f.servicesRoot, 'agent-home'),
      path.join(f.servicesRoot, 'agent-home', '@agents'), path.join(f.servicesRoot, 'agent-home', '@agents', 'worker-one'),
      path.dirname(f.session), f.session, path.join(f.session, 'gemini'),
      path.dirname(f.home('gemini')), f.home('gemini'), path.join(f.home('gemini'), '.gemini')];
    const at = ['services', 'agent-home', '@agents', 'agent', '@sessions', 'session', 'provider', 'tier', 'account', 'gemini-config'].indexOf(level);
    const link = directories[at];
    const target = path.join(f.root, 'outside');
    const relative = path.relative(link, path.join(f.home('gemini'), '.gemini', 'oauth_creds.json'));
    const outside = f.put(path.join(target, relative));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await f.run();
    assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic fixture');
    assert.equal(result.complete, false);
    assert.ok(result.refused.some(row => row.reason === 'directory-link'), JSON.stringify(result));
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  });
}

test('a directory with a sign-in name is refused without deleting its contents', async t => {
  const f = fixture(t);
  const nested = f.put(path.join(f.home(), 'auth.json', 'keep'));
  const result = await f.run();
  assert.equal(fs.readFileSync(nested, 'utf8'), 'synthetic fixture');
  assert.equal(result.complete, false);
  assert.ok(result.refused.some(row => row.reason === 'not-file'));
});

test('second run is idempotent and a later new legacy file is retried', async t => {
  const f = fixture(t);
  const file = f.put(path.join(f.home(), 'auth.json'));
  assert.equal((await f.run()).removedCount, 1);
  assert.deepEqual((await f.run()).removed, []);
  f.put(file);
  assert.equal((await f.run()).removedCount, 1);
});

test('a failed unlink is reported without contents and is retried on the next pass', async t => {
  const f = fixture(t);
  const file = f.put(path.join(f.home(), 'auth.json'));
  if (process.platform === 'win32') fs.chmodSync(file, 0o444);
  const failed = await f.run({ fileSystem: { ...fs, promises: { ...fs.promises, async unlink() { throw Object.assign(new Error('synthetic fixture'), { code: 'EACCES' }); } } } });
  if (process.platform === 'win32') fs.chmodSync(file, 0o600);
  assert.equal(failed.complete, false);
  assert.equal(failed.removedCount, 0);
  assert.ok(failed.refused.some(row => row.reason === (process.platform === 'win32' ? 'WIN32_5' : 'EACCES')));
  assert.equal(JSON.stringify(failed).includes('synthetic fixture'), false);
  assert.equal(fs.existsSync(file), true);
  assert.equal((await f.run()).removedCount, 1);
});

async function hostFixture(t, f, onLegacySignInCleanup = () => {}) {
  const id = randomUUID();
  const host = createOwnerHost({ allowTestPaths: true, platform: 'test',
    pipeName: process.platform === 'win32' ? '\\\\.\\pipe\\LegacyCleanup-' + id : path.join(isolated.root, id + '.sock'),
    capabilityFile: path.join(f.root, 'capability.json'),
    principals: { ownerPrincipal: 'TESTHOST\\legacy', clientPrincipal: 'TESTHOST\\legacy' },
    broker: { MAX_MESSAGE_BYTES: 1024, processLine() {}, resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }) },
    legacySignInServicesRoot: f.servicesRoot,
    onLegacySignInCleanup,
    credentialHygiene() { assert.equal(fs.existsSync(path.join(f.home(), 'auth.json')), false, 'cleanup runs before the existing startup hygiene and listening'); },
  });
  t.after(() => host.close());
  await host.listen();
  return host;
}

test('real owner-host startup removes legacy files before listening and publishes path-only diagnostics', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  const rows = [];
  await hostFixture(t, f, row => rows.push(row));
  assert.equal(rows.filter(row => row.event === 'removed').length, 1);
  assert.ok(rows.some(row => row.event === 'summary' && /Removed 1/.test(row.sentence)));
  assert.equal(JSON.stringify(rows).includes('synthetic fixture'), false);
});

test('cleanup refusal and diagnostic sink failure never prevent owner-host startup', async t => {
  const f = fixture(t);
  const target = f.put(path.join(f.root, 'person', 'keep'));
  fs.mkdirSync(f.servicesRoot, { recursive: true });
  fs.symlinkSync(path.dirname(target), path.join(f.servicesRoot, 'agent-home'), process.platform === 'win32' ? 'junction' : 'dir');
  const rows = [];
  await hostFixture(t, f, row => { rows.push(row); throw new Error('diagnostics unavailable'); });
  assert.ok(rows.some(row => row.event === 'summary' && /retry/.test(row.sentence)));
  assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic fixture');
});

test('relative roots refuse and absent legacy trees are harmless', async t => {
  const f = fixture(t);
  const invalid = await cleanupLegacySignIns({ servicesRoot: 'relative-services' });
  assert.equal(invalid.complete, false);
  assert.deepEqual(invalid.removed, []);
  assert.ok(invalid.refused.some(row => row.reason === 'invalid-services-root'));
  assert.equal((await f.run()).complete, true);
  assert.equal((await f.run()).removedCount, 0);
});

for (const replacement of ['symlink', 'directory']) {
  test('Linux refuses a directory replaced between metadata inspection and open: ' + replacement, async t => {
    if (process.platform !== 'linux') { t.skip('Linux descriptor-race fixture; Windows pins ancestors with native handles'); return; }
    const f = fixture(t);
    const original = f.put(path.join(f.home(), 'auth.json'));
    const outside = f.put(path.join(f.root, 'outside', 'auth.json'));
    let swapped = false, openedLinkTarget = false;
    const fileSystem = { ...fs, promises: { ...fs.promises, async open(file, ...args) {
      if (!swapped && String(file).endsWith('/@default')) {
        swapped = true;
        fs.renameSync(f.home(), path.join(f.root, 'original-home'));
        if (replacement === 'symlink') fs.symlinkSync(path.dirname(outside), f.home(), 'dir');
        else f.put(original);
      }
      const handle = await fs.promises.open(file, ...args);
      if (swapped && replacement === 'symlink' && String(file).endsWith('/@default')) openedLinkTarget = true;
      return handle;
    } } };
    const result = await f.run({ fileSystem });
    assert.equal(swapped, true);
    assert.equal(openedLinkTarget, false, 'an escaped directory must never even be opened');
    assert.equal(result.complete, false);
    assert.equal(result.removedCount, 0);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic fixture');
    assert.equal(fs.readFileSync(path.join(f.root, 'original-home', 'auth.json'), 'utf8'), 'synthetic fixture');
    if (replacement === 'directory') {
      assert.equal(fs.existsSync(original), true);
      assert.ok(result.refused.some(row => row.reason === 'directory-changed'));
    }
  });
}


test('cleanup yields to the event loop during slow metadata work', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 10);
  t.after(() => clearTimeout(timer));
  let slow = true;
  const fileSystem = { ...fs,
    lstatSync(file, ...args) {
      if (slow) { slow = false; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80); }
      return fs.lstatSync(file, ...args);
    },
    promises: { ...fs.promises, async lstat(file, ...args) {
      if (slow) { slow = false; await new Promise(resolve => setTimeout(resolve, 80)); }
      return fs.promises.lstat(file, ...args);
    } },
  };
  const result = await f.run({ fileSystem });
  assert.equal(timerFired, true, 'Electron timers must run before slow cleanup finishes');
  assert.equal(result.removedCount, 1);
});

function fakeWindows(t, f, source, options = {}) {
  const script = path.join(f.root, 'slow-helper.cjs');
  fs.writeFileSync(script, source);
  const calls = [];
  const spawnImpl = (executable, args, spawnOptions) => {
    calls.push({ executable, args });
    const child = require('node:child_process').spawn(process.execPath, [script], {
      ...spawnOptions, env: { ...process.env, ...spawnOptions.env,
        CLEANUP_TEST_FILE: path.join(f.home(), 'auth.json'),
        CLEANUP_TEST_PATH: path.relative(f.servicesRoot, path.join(f.home(), 'auth.json')) },
    });
    options.onSpawn?.(child);
    return child;
  };
  return { calls, run: () => f.run({ platform: 'win32', environment: { SystemRoot: '\x43:\\Windows' },
    spawnImpl, ...options }) };
}

test('slow Windows helper leaves timers responsive and waits for the helper to exit', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  let timer, timerFired = false;
  const helper = fakeWindows(t, f, [
    "setTimeout(() => {",
    " require('node:fs').unlinkSync(process.env.CLEANUP_TEST_FILE);",
    " console.log(JSON.stringify({ event: 'removed', path: process.env.CLEANUP_TEST_PATH }));",
    " console.log(JSON.stringify({ event: 'complete', path: 'agent-home' }));",
    "}, 120);",
  ].join('\n'), { onSpawn(child) {
    timer = setTimeout(() => {
      timerFired = child.exitCode === null && fs.existsSync(path.join(f.home(), 'auth.json'));
    }, 20);
  } });
  t.after(() => clearTimeout(timer));
  const result = await helper.run();
  assert.equal(helper.calls.length, 1);
  assert.equal(timerFired, true, 'a slow helper must not occupy Electron main');
  assert.equal(result.complete, true);
  assert.equal(result.removedCount, 1);
  assert.equal(fs.existsSync(path.join(f.home(), 'auth.json')), false);
});

test('Windows helper timeout retains completed receipts and retries a partial run', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  const helper = fakeWindows(t, f, [
    "console.log(JSON.stringify({ event: 'removed', path: process.env.CLEANUP_TEST_PATH }));",
    "setTimeout(() => process.exit(0), 500);",
  ].join('\n'), { timeoutMs: 100 });
  const started = Date.now();
  const result = await helper.run();
  assert.equal(helper.calls.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.removedCount, 1);
  assert.ok(result.refused.some(row => row.reason === 'ETIMEDOUT'), JSON.stringify(result));
  assert.ok(Date.now() - started < 2000, 'timeout must settle startup promptly');
});

test('Windows preflight skips the helper on absent and credential-free session leaves', async t => {
  const f = fixture(t);
  const helper = fakeWindows(t, f, "throw new Error('helper must not start')");
  assert.equal((await helper.run()).complete, true);
  f.put(path.join(f.home(), 'session.jsonl'));
  assert.equal((await helper.run()).complete, true);
  assert.equal((await helper.run()).removedCount, 0);
  assert.equal(helper.calls.length, 0);
});

test('Windows preflight refuses a linked account without starting the helper or listing its target', async t => {
  const f = fixture(t);
  const target = f.put(path.join(f.root, 'outside', 'auth.json'));
  fs.mkdirSync(path.dirname(f.home()), { recursive: true });
  fs.symlinkSync(path.dirname(target), f.home(), process.platform === 'win32' ? 'junction' : 'dir');
  const helper = fakeWindows(t, f, "throw new Error('helper must not start')");
  const result = await helper.run();
  assert.equal(helper.calls.length, 0);
  assert.equal(result.complete, false);
  assert.ok(result.refused.some(row => row.reason === 'directory-link'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic fixture');
});

test('owner-host listen waits for asynchronous cleanup before publishing or admitting sessions', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  const module = require('../src/lib/legacy-signin-cleanup');
  const realCleanup = module.cleanupLegacySignIns;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered = false;
  module.cleanupLegacySignIns = async options => { entered = true; await gate; return realCleanup(options); };
  t.after(() => { module.cleanupLegacySignIns = realCleanup; release(); });
  const id = randomUUID();
  const host = createOwnerHost({ allowTestPaths: true, platform: 'test',
    pipeName: process.platform === 'win32' ? '\\\\.\\pipe\\LegacyAwait-' + id : path.join(isolated.root, id + '.sock'),
    capabilityFile: path.join(f.root, 'authority.json'),
    principals: { ownerPrincipal: 'TESTHOST\\legacy', clientPrincipal: 'TESTHOST\\legacy' },
    broker: { MAX_MESSAGE_BYTES: 1024, processLine() {}, resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }) },
    legacySignInServicesRoot: f.servicesRoot, onLegacySignInCleanup() {},
  });
  t.after(() => host.close());
  const startup = host.listen();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(entered, true);
  assert.equal(fs.existsSync(path.join(f.root, 'authority.json')), false, 'route must not be published while cleanup waits');
  assert.throws(() => host.admitSession({}), { code: 'OWNER_HOST_NOT_READY' });
  await assert.rejects(host.bindSession({}), { code: 'OWNER_HOST_NOT_READY' });
  release();
  await startup;
  assert.equal(fs.existsSync(path.join(f.home(), 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'authority.json')), true);
});


test('Windows preflight uses reparse dirent evidence even when lstat describes an ordinary directory', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  let listedAccount = false, checkedAccount = false;
  const io = { ...fs.promises, async lstat(file) {
    if (file === f.home()) checkedAccount = true;
    return fs.promises.lstat(file);
  }, async readdir(file, options) {
    if (file === f.home()) listedAccount = true;
    const entries = await fs.promises.readdir(file, options);
    if (file === path.dirname(f.home())) return entries.map(entry => entry.name === '@default'
      ? { name: entry.name, isSymbolicLink: () => true, isDirectory: () => true } : entry);
    return entries;
  } };
  const helper = fakeWindows(t, f, "throw new Error('helper must not start')", { fileSystem: { ...fs, promises: io } });
  const result = await helper.run();
  assert.equal(helper.calls.length, 0);
  assert.equal(checkedAccount, false, 'a known reparse must not reach lstat, which can follow unrecognized Windows tags');
  assert.equal(listedAccount, false, 'a reparse entry must be refused before listing it');
  assert.equal(result.complete, false);
  assert.ok(result.refused.some(row => row.reason === 'directory-link'));
});

test('Windows preflight rechecks a directory swapped for a junction before enumeration', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  const outside = f.put(path.join(f.root, 'outside', 'auth.json'));
  let swapped = false, listedAccount = false;
  const io = { ...fs.promises,
    async lstat(file) {
      const stat = await fs.promises.lstat(file);
      if (!swapped && file === f.home()) {
        swapped = true;
        fs.renameSync(f.home(), path.join(f.root, 'old-home'));
        fs.symlinkSync(path.dirname(outside), f.home(), process.platform === 'win32' ? 'junction' : 'dir');
      }
      return stat;
    },
    async readdir(file, options) {
      if (file === f.home()) listedAccount = true;
      return fs.promises.readdir(file, options);
    },
  };
  const helper = fakeWindows(t, f, "throw new Error('helper must not start')", { fileSystem: { ...fs, promises: io } });
  const result = await helper.run();
  assert.equal(helper.calls.length, 0);
  assert.equal(swapped, true);
  assert.equal(listedAccount, false);
  assert.equal(result.complete, false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic fixture');
});

test('a successful Windows cleanup skips subsequent clean runs and notices a reintroduced file', async t => {
  const f = fixture(t);
  const file = f.put(path.join(f.home(), 'auth.json'));
  const helper = fakeWindows(t, f,
    "require('node:fs').unlinkSync(process.env.CLEANUP_TEST_FILE); console.log(JSON.stringify({event:'removed',path:process.env.CLEANUP_TEST_PATH})); console.log(JSON.stringify({event:'complete'}));");
  assert.equal((await helper.run()).removedCount, 1);
  assert.equal(helper.calls.length, 1);
  assert.equal((await helper.run()).complete, true);
  assert.equal((await helper.run()).removedCount, 0);
  assert.equal(helper.calls.length, 1);
  f.put(file);
  assert.equal((await helper.run()).removedCount, 1);
  assert.equal(helper.calls.length, 2);
});

test('a failed Windows helper start is reported and retried without rejecting cleanup', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  let calls = 0;
  const result = await f.run({ platform: 'win32', environment: { SystemRoot: '\x43:\\Windows' },
    spawnImpl() { calls++; throw Object.assign(new Error('synthetic fixture'), { code: 'ENOENT' }); } });
  assert.equal(calls, 1);
  assert.equal(result.complete, false);
  assert.ok(result.refused.some(row => row.reason === 'ENOENT'));
  assert.equal(JSON.stringify(result).includes('synthetic fixture'), false);
  assert.equal(fs.existsSync(path.join(f.home(), 'auth.json')), true);
});

test('helper output is bounded, keeps earlier receipts, and never logs raw compiler output', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  const helper = fakeWindows(t, f,
    "console.log(JSON.stringify({event:'removed',path:process.env.CLEANUP_TEST_PATH})); setTimeout(() => process.stderr.write('synthetic fixture'.repeat(200)),20); setTimeout(() => process.exit(0),500);",
    { maxOutputBytes: 1024, timeoutMs: 1000 });
  const result = await helper.run();
  assert.equal(result.complete, false);
  assert.equal(result.removedCount, 1);
  assert.ok(result.refused.some(row => row.reason === 'ENOBUFS'));
  assert.equal(JSON.stringify(result).includes('synthetic fixture'), false);
});

test('a timed-out helper cannot extend startup by leaving a compiler descendant holding its pipes', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  const helper = fakeWindows(t, f, [
    "const code = 'setTimeout(() => {}, 1500)';",
    "const child = require('node:child_process').spawn(process.execPath, ['-e', code], {stdio:['ignore',1,2]});",
    "child.unref();",
    "setTimeout(() => process.exit(0), 2000);",
  ].join('\n'), { timeoutMs: 150 });
  const started = Date.now();
  const result = await helper.run();
  assert.equal(result.complete, false);
  assert.ok(result.refused.some(row => row.reason === 'ETIMEDOUT'));
  assert.ok(Date.now() - started < 1000, 'owned helper exit must settle timeout without waiting for inherited compiler pipes');
});

test('closing the owner host while cleanup waits cannot publish a late session route', async t => {
  const f = fixture(t);
  const module = require('../src/lib/legacy-signin-cleanup');
  const realCleanup = module.cleanupLegacySignIns;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  module.cleanupLegacySignIns = async () => { entered(); await gate; return { complete: true }; };
  t.after(() => { module.cleanupLegacySignIns = realCleanup; release(); });
  const id = randomUUID();
  const host = createOwnerHost({ allowTestPaths: true, platform: 'test',
    pipeName: process.platform === 'win32' ? '\\\\.\\pipe\\LegacyClose-' + id : path.join(isolated.root, id + '.sock'),
    capabilityFile: path.join(f.root, 'authority.json'),
    principals: { ownerPrincipal: 'TESTHOST\\legacy', clientPrincipal: 'TESTHOST\\legacy' },
    broker: { MAX_MESSAGE_BYTES: 1024, processLine() {}, resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }) },
    legacySignInServicesRoot: f.servicesRoot, onLegacySignInCleanup() {},
  });
  t.after(async () => {
    await host.close();
    // A mutation can reopen the already-closed host; still reap this exact
    // test server so the assertion failure does not strand the test runner.
    if (host.server.listening) await new Promise(resolve => host.server.close(resolve));
  });
  const startup = host.listen();
  const rejected = assert.rejects(startup, { code: 'OWNER_HOST_CLOSED' });
  await started;
  await host.close();
  release();
  await rejected;
  assert.equal(host.server.listening, false);
  assert.equal(fs.existsSync(path.join(f.root, 'authority.json')), false);
});

test('an asynchronous cleanup rejection reports retry and still allows host startup', async t => {
  const f = fixture(t);
  const module = require('../src/lib/legacy-signin-cleanup');
  const realCleanup = module.cleanupLegacySignIns;
  module.cleanupLegacySignIns = async () => { await new Promise(resolve => setTimeout(resolve, 10)); throw new Error('synthetic fixture'); };
  t.after(() => { module.cleanupLegacySignIns = realCleanup; });
  const receipts = [];
  const id = randomUUID();
  const host = createOwnerHost({ allowTestPaths: true, platform: 'test',
    pipeName: process.platform === 'win32' ? '\\\\.\\pipe\\LegacyFailure-' + id : path.join(isolated.root, id + '.sock'),
    capabilityFile: path.join(f.root, 'authority.json'),
    principals: { ownerPrincipal: 'TESTHOST\\legacy', clientPrincipal: 'TESTHOST\\legacy' },
    broker: { MAX_MESSAGE_BYTES: 1024, processLine() {}, resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }) },
    legacySignInServicesRoot: f.servicesRoot, onLegacySignInCleanup: row => receipts.push(row),
  });
  t.after(() => host.close());
  await host.listen();
  assert.equal(fs.existsSync(path.join(f.root, 'authority.json')), true);
  assert.ok(receipts.some(row => row.complete === false && /retry next start/.test(row.sentence)));
  assert.equal(JSON.stringify(receipts).includes('synthetic fixture'), false);
});

test('invalid helper bounds refuse before spawning and preserve sign-in names for retry', async t => {
  for (const options of [{ timeoutMs: 0 }, { maxOutputBytes: 0 }, { timeoutMs: 1.5 }, { maxOutputBytes: Infinity }]) {
    const f = fixture(t);
    f.put(path.join(f.home(), 'auth.json'));
    const helper = fakeWindows(t, f, "throw new Error('helper must not start')", options);
    const result = await helper.run();
    assert.equal(helper.calls.length, 0);
    assert.equal(result.complete, false);
    assert.ok(result.refused.some(row => row.reason === 'invalid-helper-bounds'));
    assert.equal(fs.existsSync(path.join(f.home(), 'auth.json')), true);
  }
});

test('untrusted error codes cannot put raw helper or filesystem text into diagnostics', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  const result = await f.run({ platform: 'win32', environment: { SystemRoot: '\x43:\\Windows' },
    spawnImpl() { throw { code: 'synthetic fixture', message: 'synthetic fixture' }; } });
  assert.equal(result.complete, false);
  assert.ok(result.refused.some(row => row.reason === 'cleanup-unavailable'));
  assert.equal(JSON.stringify(result).includes('synthetic fixture'), false);
});

test('a helper completion receipt does not finish cleanup before its process exits', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  const helper = fakeWindows(t, f,
    "console.log(JSON.stringify({event:'complete'})); setTimeout(() => require('node:fs').unlinkSync(process.env.CLEANUP_TEST_FILE), 200);");
  let settled = false;
  const startup = helper.run().then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  assert.equal(fs.existsSync(path.join(f.home(), 'auth.json')), true);
  assert.equal((await startup).complete, true);
  assert.equal(fs.existsSync(path.join(f.home(), 'auth.json')), false);
});

test('malformed helper output remains a partial run even after a completion receipt', async t => {
  const f = fixture(t);
  f.put(path.join(f.home(), 'auth.json'));
  const helper = fakeWindows(t, f,
    "console.log('synthetic fixture'); console.log(JSON.stringify({event:'complete'}));");
  const result = await helper.run();
  assert.equal(result.complete, false);
  assert.ok(result.refused.some(row => row.reason === 'EPROTO'));
  assert.equal(JSON.stringify(result).includes('synthetic fixture'), false);
});

test('Windows no-op scan ignores provider homes and noncanonical session layouts', async t => {
  const f = fixture(t);
  const valid = f.home();
  const others = [
    path.join(f.servicesRoot, 'codex', 'auth.json'),
    path.join(f.servicesRoot, 'accounts', 'codex', 'auth.json'),
    path.join(f.servicesRoot, 'agent-home', 'auth.json'),
    path.join(valid.replace('a'.repeat(64), 'not-a-session'), 'auth.json'),
    path.join(valid.replace(path.sep + 'codex' + path.sep, path.sep + 'other' + path.sep), 'auth.json'),
    path.join(valid.replace(path.sep + 'standard' + path.sep, path.sep + 'not-a-tier' + path.sep), 'auth.json'),
    path.join(valid, 'logs', 'auth.json'),
    path.join(valid, 'auth.json.backup'),
    path.join(valid, '.credentials.json'),
  ];
  for (const file of others) f.put(file);
  const helper = fakeWindows(t, f, "throw new Error('helper must not start')");
  const result = await helper.run();
  assert.equal(helper.calls.length, 0);
  assert.equal(result.complete, true);
  assert.equal(result.removedCount, 0);
  for (const file of others) assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic fixture');
});
