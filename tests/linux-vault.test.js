'use strict';

// Real production custody on a private D-Bus and a disposable GNOME keyring.
// The test never inherits the desktop bus or GNOME control socket. No owner
// keyring is opened, unlocked, reset, enumerated, or copied.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

function freshEnvironment(root) {
  const environment = require('../src/lib/providers/subscription-launch-env').safeLaunchEnvironment(
    process.env, { context: 'isolated Linux vault integration' });
  require('./lib/isolated-environment').configure(root, environment);
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'GNOME_KEYRING_CONTROL', 'GNOME_KEYRING_PID',
    'SSH_AUTH_SOCK', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']) delete environment[name];
  for (const [name, directory] of [['XDG_DATA_HOME', 'data'], ['XDG_CONFIG_HOME', 'config'], ['XDG_RUNTIME_DIR', 'runtime']]) {
    environment[name] = path.join(root, directory);
    fs.mkdirSync(environment[name], { mode: 0o700 });
  }
  return environment;
}

function launchWorker(request) {
  const child = spawn(process.execPath, [__filename, '--worker'], {
    env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.end(JSON.stringify(request));
  return once(child, 'close').then(([status]) => {
    assert.equal(status, 0, `isolated worker failed: ${stderr.slice(0, 300)}`);
    return JSON.parse(stdout);
  });
}

async function worker() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const runtime = require('../src/lib/runtime');
  let result;
  if (input.action === 'candidate') {
    const value = runtime.getOrCreateSecret(input.key, input.value);
    result = { digest: crypto.createHash('sha256').update(value).digest('hex') };
  } else if (input.action === 'audit') {
    const audit = require('../src/lib/audit');
    const verified = audit.verify();
    result = { valid: verified.valid, entries: verified.entries };
    audit.resetForTests();
  } else if (input.action === 'read') {
    const value = runtime.getSecret(input.key, { prompt: false });
    result = { digest: crypto.createHash('sha256').update(value).digest('hex') };
  } else if (input.action === 'clear-device-credential') {
    result = runtime.clearDeviceCredential();
  } else throw new Error('Unknown test worker action.');
  process.stdout.write(JSON.stringify(result));
}

function testKeyringAction(action, fields = {}) {
  const result = spawnSync('/usr/bin/python3', ['-I', path.join(__dirname, 'lib', 'linux-keyring-fixture.py')], {
    env: { ...process.env }, input: JSON.stringify({ action, ...fields }),
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000, shell: false
  });
  assert.equal(result.status, 0, 'private keyring fixture operation failed');
}

function noBusHygiene(root) {
  assert.equal(process.env.DBUS_SESSION_BUS_ADDRESS, undefined, 'this proof must have no desktop or private bus');
  const runtime = require('../src/lib/runtime');
  const linux = require('../src/lib/vault-linux');
  const location = require('../src/lib/vault-location');
  const expected = { key: 'payment_card_default', status: 'absent' };
  const file = process.env.TOOLSENABLED_VAULT_PATH;
  const withFile = (next, callback) => {
    process.env.TOOLSENABLED_VAULT_PATH = next;
    location.resetVaultLocationForTests();
    try { return callback(); }
    finally { process.env.TOOLSENABLED_VAULT_PATH = file; location.resetVaultLocationForTests(); }
  };
  assert.equal(linux.status().code, 'SECRET_BACKEND_UNAVAILABLE');
  assert.deepEqual(runtime.scrubPaymentCardSecurityCode(), expected);
  assert.equal(fs.existsSync(file), false, 'absence hygiene must not create a vault');
  const missingDirectory = path.join(root, 'missing-vault-directory');
  withFile(path.join(missingDirectory, 'vault.json'), () => assert.deepEqual(runtime.scrubPaymentCardSecurityCode(), expected));
  assert.equal(fs.existsSync(missingDirectory), false, 'hygiene may not provision an absent store');
  for (const [name, bytes, code] of [
    ['legacy', '{"payment_card_default":"not-a-native-envelope"}', 'SECRET_VAULT_FORMAT_UNSUPPORTED'],
    ['malformed', '{"format":', 'SECRET_VAULT_UNREADABLE'],
    ['empty', '', 'SECRET_VAULT_UNREADABLE']
  ]) {
    const other = path.join(root, `${name}.json`);
    fs.writeFileSync(other, bytes, { mode: 0o600 });
    withFile(other, () => assert.throws(() => runtime.scrubPaymentCardSecurityCode(), error => error.code === code));
    assert.equal(fs.readFileSync(other, 'utf8'), bytes, 'hygiene may not repair or rewrite an unknown store');
  }
  const alias = path.join(root, 'hygiene-alias.json');
  fs.symlinkSync(path.join(root, 'legacy.json'), alias);
  withFile(alias, () => assert.throws(() => runtime.scrubPaymentCardSecurityCode(), error => error.code === 'SECRET_VAULT_PATH_UNSAFE'));
  const unsafe = path.join(root, 'unsafe-hygiene-directory');
  fs.mkdirSync(unsafe, { mode: 0o700 });
  fs.chmodSync(unsafe, 0o777);
  withFile(path.join(unsafe, 'absent.json'), () => assert.throws(
    () => runtime.scrubPaymentCardSecurityCode(), error => error.code === 'SECRET_VAULT_PATH_UNSAFE'));
  const suppliedKey = spawnSync('/usr/bin/python3', ['-I', path.join(__dirname, '../src/linux-vault.py')], {
    input: JSON.stringify({ action: 'check-payment-card-hygiene', file, key: 'custom.other' }),
    env: { ...process.env }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, shell: false
  });
  assert.equal(suppliedKey.status, 1);
  assert.deepEqual(JSON.parse(suppliedKey.stdout), { ok: false, code: 'SECRET_INPUT_INVALID' });
  const helperPath = path.join(__dirname, '../src/linux-vault.py');
  const fifo = target => {
    const result = spawnSync('/usr/bin/mkfifo', ['-m', '600', '--', target], {
      env: {}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000, shell: false
    });
    assert.equal(result.status, 0, 'the isolated FIFO fixture must be created');
  };
  for (const suffix of ['', '.lock', '.access.log']) {
    const target = path.join(root, `fifo-${suffix || 'store'}.json`);
    const special = target + suffix;
    fifo(special);
    const original = fs.lstatSync(special);
    const check = () => {
      const result = spawnSync('/usr/bin/python3', ['-I', helperPath], {
        input: JSON.stringify({ action: 'check-payment-card-hygiene', file: target }),
        env: { ...process.env }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, shell: false
      });
      assert.ifError(result.error, 'a special-file open must not wait for the normal helper deadline');
      assert.equal(result.status, suffix === '.access.log' ? 0 : 1);
      assert.deepEqual(JSON.parse(result.stdout), suffix === '.access.log'
        ? { ok: true, result: expected } : { ok: false, code: 'SECRET_VAULT_PATH_UNSAFE' });
      withFile(target, () => suffix === '.access.log'
        ? assert.deepEqual(runtime.scrubPaymentCardSecurityCode(), expected)
        : assert.throws(() => runtime.scrubPaymentCardSecurityCode(), error => error.code === 'SECRET_VAULT_PATH_UNSAFE'));
    };
    check();
    if (suffix === '.access.log') {
      // Even with a waiting reader, the metadata logger rejects the FIFO
      // before writing bytes. With no reader it simply ignores ENXIO.
      const reader = fs.openSync(special, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try { check(); assert.equal(fs.readSync(reader, Buffer.alloc(1), 0, 1, null), 0); }
      finally { fs.closeSync(reader); }
    }
    const retained = fs.lstatSync(special);
    assert.ok(retained.isFIFO());
    assert.equal(retained.ino, original.ino);
    assert.equal(retained.mode, original.mode);
  }
  const fifoDataRoot = path.join(root, 'fifo-keyring-format');
  fs.mkdirSync(path.join(fifoDataRoot, 'keyrings'), { recursive: true, mode: 0o700 });
  fifo(path.join(fifoDataRoot, 'keyrings/login.keyring'));
  const formatCheck = spawnSync('/usr/bin/python3', ['-I', '-c', [
    'import runpy, sys',
    'helper = runpy.run_path(sys.argv[1])',
    'try:',
    '    helper["encrypted_keyring_file"](sys.argv[2])',
    'except helper["Refusal"] as error:',
    '    sys.exit(0 if error.code == "SECRET_VAULT_PATH_UNSAFE" else 2)',
    'sys.exit(1)'
  ].join('\n'), helperPath, fifoDataRoot], {
    env: {}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000, shell: false
  });
  assert.ifError(formatCheck.error, 'the actual backing-file format checker must not block on a FIFO');
  assert.equal(formatCheck.status, 0);
  assert.equal(fs.existsSync(path.join(process.env.XDG_DATA_HOME, 'keyrings')), false);
  console.log('PASS fixed Linux startup hygiene proves no-store without D-Bus and refuses unknown/unsafe stores or another key');
  console.log('PASS real vault, lock, metadata-log and backing-file FIFOs never block, consume, or rewrite fixture bytes');
}

async function privateRun(root, plaintext, componentArgs = null) {
  assert.equal(path.dirname(process.env.XDG_DATA_HOME), root);
  assert.equal(process.env.TOOLSENABLED_TEST_ROOT, root);
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, 'dbus-run-session must supply a new private bus');
  const control = path.join(root, 'keyring-control');
  fs.mkdirSync(control, { mode: 0o700 });
  // A generated, test-only password goes only over stdin to our new daemon.
  // The daemon treats zero bytes as "no supplied password". A terminating
  // NUL supplies an empty C string, creating its real passwordless format for
  // the negative test; this remains confined to the disposable daemon.
  const fixturePassword = plaintext ? Buffer.from([0]) : crypto.randomBytes(32).toString('hex');
  let daemon;
  let daemonClosed;
  const startDaemon = () => {
    daemon = spawn('/usr/bin/gnome-keyring-daemon', [
      '--foreground', '--components=secrets', '--unlock', `--control-directory=${control}`
    ], { env: { ...process.env }, stdio: ['pipe', 'ignore', 'ignore'], shell: false });
    daemon.stdin.end(fixturePassword);
    daemonClosed = once(daemon, 'close');
  };
  startDaemon();
  const linux = require('../src/lib/vault-linux');
  try {
    let readiness;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      readiness = linux.status();
      if (readiness.available || readiness.code === 'SECRET_BACKEND_UNSAFE') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (plaintext) {
      assert.equal(readiness.available, false);
      assert.equal(readiness.code, 'SECRET_BACKEND_UNSAFE');
      assert.equal(fs.existsSync(process.env.TOOLSENABLED_VAULT_PATH), false);
      console.log('PASS a real passwordless GNOME keyring is refused as unsafe');
      return;
    }
    assert.deepEqual(readiness, { available: true, backend: 'gnome_libsecret', persistent: true });
    console.log('PASS real isolated libsecret backend is available without an application vault');
    if (componentArgs !== null) {
      // Component tests need the same real custody backend as production.
      // Reuse this private bus/keyring lifecycle, never the owner's keyring.
      const result = spawnSync(process.execPath, [path.join(__dirname, 'run-isolated.js'), ...componentArgs], {
        env: { ...process.env }, stdio: 'inherit', shell: false
      });
      assert.ifError(result.error);
      process.exitCode = Number.isInteger(result.status) ? result.status : 1;
      return;
    }
    const helperPids = () => {
      const listed = spawnSync('/usr/bin/ps', ['-o', 'pid=,args=', '--ppid', String(process.pid)], { encoding: 'utf8' });
      assert.equal(listed.status, 0);
      return listed.stdout.split('\n').filter(line => line.includes(path.resolve(__dirname, '../src/linux-vault.py')) && line.trim().endsWith('--serve'))
        .map(line => Number(line.trim().split(/\s+/)[0]));
    };
    const firstHelpers = helperPids();
    assert.equal(firstHelpers.length, 1);
    for (let index = 0; index < 8; index++) assert.equal(linux.status().available, true);
    assert.deepEqual(helperPids(), firstHelpers, 'warm requests must reuse the same actual helper process');
    const oversized = require('../src/lib/linux-vault-host-client').call({
      action: 'clear-device-credential', padding: 'x'.repeat(4 * 1024 * 1024)
    }, {});
    assert.equal(oversized.status, 1);
    assert.deepEqual(JSON.parse(oversized.stdout), {
      ok: false, code: 'SECRET_INPUT_INVALID', mutationOutcome: 'NOT_ATTEMPTED'
    }, 'a rejected oversized request truthfully reports that no mutation was dispatched');
    await require('../src/lib/linux-vault-host-client').close();
    assert.deepEqual(helperPids(), [], 'explicit close must retire and reap the owned helper');
    assert.equal(linux.status().available, true);
    assert.equal(helperPids().length, 1);
    assert.notEqual(helperPids()[0], firstHelpers[0]);
    console.log('PASS one real persistent helper serves warm requests, is reaped on close and restarts cleanly');
    const closingReader = linux.createReader({ stateRoot: process.env.TOOLSENABLED_STATE_ROOT });
    const pendingReads = Array.from({ length: 3 }, () => closingReader.presence('custom.pending_close'));
    const readsFinished = Promise.all(pendingReads);
    await require('../src/lib/audit').close();
    assert.ok((await readsFinished).every(value => ['absent', 'no-store'].includes(value)));
    assert.deepEqual(helperPids(), [], 'audit shutdown must finish queued readers and reap the Linux helper');
    assert.equal(linux.status().available, true, 'a later owner can restart its helper after orderly shutdown');
    console.log('PASS audit shutdown drains queued native readers and confirms helper exit');
    const runtime = require('../src/lib/runtime');
    const presence = require('../src/lib/vault-presence');
    const location = require('../src/lib/vault-location');
    const file = process.env.TOOLSENABLED_VAULT_PATH;
    const marker = `synthetic-linux-vault-${crypto.randomBytes(24).toString('hex')}`;
    const matches = code => error => error.code === code;
    const withFile = (next, callback) => {
      process.env.TOOLSENABLED_VAULT_PATH = next;
      location.resetVaultLocationForTests();
      try { return callback(); }
      finally { process.env.TOOLSENABLED_VAULT_PATH = file; location.resetVaultLocationForTests(); }
    };

    assert.throws(() => runtime.getSecret('custom.missing', { prompt: false }), matches('SECRET_NOT_CONFIGURED'));
    assert.equal(presence.vaultRecordPresence('custom.missing').code, 'VAULT_STORE_ABSENT');
    assert.equal(fs.existsSync(file), false);
    const deviceKey = 'custom.online_fra_device_credential_v1';
    const identityKey = 'custom.online_fra_device_identity_v1';
    assert.deepEqual(runtime.clearDeviceCredential(), { key: deviceKey, status: 'absent', mutationOutcome: 'NOT_ATTEMPTED' });
    assert.equal(fs.existsSync(file), false, 'disconnect must not create an absent vault');
    runtime.setSecret('custom.roundtrip', marker);
    assert.ok(runtime.getSecret('custom.roundtrip', { prompt: false }) === marker);
    assert.equal(runtime.secretExists('custom.roundtrip'), true);
    assert.equal(runtime.secretExists('custom.missing'), false);
    const reopened = await launchWorker({ action: 'read', key: 'custom.roundtrip' });
    assert.equal(reopened.digest, crypto.createHash('sha256').update(marker).digest('hex'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(runtime.vaultContentDigest(), null, 'Linux may not cache across keyring lock or key loss');
    console.log('PASS production runtime persists and reopens encrypted credentials across processes');

    runtime.setSecretPair(deviceKey, 'synthetic-device-token', identityKey, 'synthetic-device-identity');
    const beforeDisconnect = fs.readFileSync(file);
    const damagedCredential = JSON.parse(beforeDisconnect);
    damagedCredential.records[deviceKey] = damagedCredential.records[identityKey];
    fs.writeFileSync(file, JSON.stringify(damagedCredential));
    const damagedBytes = fs.readFileSync(file);
    assert.throws(() => runtime.clearDeviceCredential(), {
      code: 'DEVICE_CREDENTIAL_CLEAR_FAILED', localCause: 'SECRET_VAULT_UNREADABLE', mutationOutcome: 'NOT_ATTEMPTED'
    });
    assert.ok(fs.readFileSync(file).equals(damagedBytes), 'unauthenticated credentials must not be reported cleared');
    fs.writeFileSync(file, beforeDisconnect);
    const suppliedKey = spawnSync('/usr/bin/python3', ['-I', path.join(__dirname, '../src/linux-vault.py')], {
      env: { ...process.env }, input: JSON.stringify({ action: 'clear-device-credential', file, key: identityKey }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, shell: false
    });
    assert.equal(suppliedKey.status, 1);
    assert.deepEqual(JSON.parse(suppliedKey.stdout), { ok: false, code: 'SECRET_INPUT_INVALID', mutationOutcome: 'NOT_ATTEMPTED' });
    assert.ok(fs.readFileSync(file).equals(beforeDisconnect));
    const disconnects = await Promise.all([launchWorker({ action: 'clear-device-credential' }),
      launchWorker({ action: 'clear-device-credential' })]);
    assert.deepEqual(disconnects.map(result => result.status).sort(), ['absent', 'cleared']);
    assert.deepEqual(disconnects.sort((a, b) => a.status.localeCompare(b.status)), [
      { key: deviceKey, status: 'absent', mutationOutcome: 'NOT_ATTEMPTED' },
      { key: deviceKey, status: 'cleared', mutationOutcome: 'REMOVED_SYNCED' }
    ]);
    const expectedRemaining = JSON.parse(beforeDisconnect);
    delete expectedRemaining.records[deviceKey];
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), expectedRemaining,
      'only the account connection record is removed; identity and every other ciphertext remain identical');
    assert.equal(runtime.secretExists(deviceKey), false);
    assert.equal(runtime.getSecret(identityKey, { prompt: false }), 'synthetic-device-identity');
    assert.deepEqual(runtime.clearDeviceCredential(identityKey), { key: deviceKey, status: 'absent', mutationOutcome: 'NOT_ATTEMPTED' });
    console.log('PASS concurrent real disconnects remove exactly one authenticated device credential and preserve machine identity');

    for (const phase of ['before-replace', 'replace-error', 'after-replace', 'lost-receipt']) {
      runtime.setSecret(deviceKey, 'synthetic-disconnect-fault-record');
      const before = JSON.parse(fs.readFileSync(file));
      const fault = spawnSync('/usr/bin/python3', ['-I', path.join(__dirname, 'lib/linux-vault-write-fault.py')], {
        input: JSON.stringify({ file, phase }), env: { ...process.env },
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000, shell: false
      });
      assert.ifError(fault.error, 'the isolated fault helper must have an observed terminal result');
      assert.equal(fault.status, phase === 'lost-receipt' ? 7 : 1);
      assert.equal(fault.stderr, '', 'raw helper diagnostics do not cross the fault boundary');
      const after = JSON.parse(fs.readFileSync(file));
      const replaced = ['after-replace', 'lost-receipt'].includes(phase);
      const expected = structuredClone(before);
      if (replaced) delete expected.records[deviceKey];
      assert.deepEqual(after, expected, 'actual ciphertext inspection preserves identity and every unrelated record');
      if (phase === 'lost-receipt') assert.equal(fault.stdout, '');
      else {
        const receipt = JSON.parse(fault.stdout);
        assert.equal(receipt.ok, false);
        assert.equal(receipt.code, phase === 'before-replace' ? 'SECRET_VAULT_WRITE_FAILED' : 'SECRET_VAULT_WRITE_UNCERTAIN');
        assert.equal(receipt.mutationOutcome, phase === 'before-replace' ? 'NOT_ATTEMPTED' : 'UNCERTAIN');
        assert.deepEqual(receipt.events, phase === 'before-replace' ? ['file-fsync']
          : phase === 'replace-error' ? ['file-fsync', 'replace-attempted']
            : ['file-fsync', 'replace-attempted', 'replace-returned', 'directory-fsync']);
      }
      assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.startsWith('.vault.json.') && name.endsWith('.tmp')), false);
      // A new operation can observe absence, but cannot revise the prior
      // UNCERTAIN/lost receipt or certify power-loss durability retroactively.
      assert.deepEqual(runtime.clearDeviceCredential(), { key: deviceKey,
        status: replaced ? 'absent' : 'cleared', mutationOutcome: replaced ? 'NOT_ATTEMPTED' : 'REMOVED_SYNCED' });
    }
    console.log('PASS native disposable pre/at/post-replace and lost-receipt faults preserve truthful mutation evidence; not power-loss proof');

    const hygieneAbsent = { key: 'payment_card_default', status: 'absent' };
    assert.deepEqual(runtime.scrubPaymentCardSecurityCode(), hygieneAbsent);
    const beforeHygiene = fs.readFileSync(file);
    for (const cardKey of ['payment_card_default', 'PAYMENT_CARD_DEFAULT']) {
      const withProtectedRecord = JSON.parse(beforeHygiene);
      // A structurally valid encrypted record under the protected name must
      // refuse before decryption, even when it was substituted from another
      // record and therefore would fail the card name's authenticated data.
      withProtectedRecord.records[cardKey] = withProtectedRecord.records['custom.roundtrip'];
      const protectedBytes = Buffer.from(JSON.stringify(withProtectedRecord));
      fs.writeFileSync(file, protectedBytes);
      assert.throws(() => runtime.scrubPaymentCardSecurityCode(), matches('SECRET_PAYMENT_CARD_REVIEW_REQUIRED'));
      assert.ok(fs.readFileSync(file).equals(protectedBytes), 'protected hygiene may not rewrite any record');
    }
    fs.writeFileSync(file, beforeHygiene);
    const privateBusAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    try { assert.throws(() => runtime.scrubPaymentCardSecurityCode(), matches('SECRET_BACKEND_UNAVAILABLE')); }
    finally { process.env.DBUS_SESSION_BUS_ADDRESS = privateBusAddress; }
    console.log('PASS existing native vault hygiene requires trusted custody and refuses protected records without decryption');

    const readerRoot = path.join(root, 'desktop-reader');
    const readerFile = path.join(readerRoot, 'vault', 'secrets.json');
    withFile(readerFile, () => runtime.setSecret('custom.desktop', 'desktop-fixture'));
    const environmentBefore = { ...process.env };
    const reader = linux.createReader({ stateRoot: readerRoot, environment: { ...process.env, TOOLSENABLED_VAULT_PATH: '/unrelated/vault.json' } });
    let eventLoopTicked = false;
    const tick = setTimeout(() => { eventLoopTicked = true; }, 0);
    assert.equal(await reader.presence('custom.desktop'), 'present');
    assert.equal(eventLoopTicked, true, 'the desktop reader must leave the event loop responsive');
    clearTimeout(tick);
    assert.deepEqual(await reader.getMany(['custom.desktop', 'custom.missing']), new Map([['custom.desktop', 'desktop-fixture']]));
    assert.ok(JSON.stringify(process.env) === JSON.stringify(environmentBefore), 'reader changed the process environment');
    assert.throws(() => linux.createReader({ stateRoot: 'relative' }), matches('SECRET_INPUT_INVALID'));
    assert.throws(() => linux.createReader({ stateRoot: readerRoot + ' ' }), matches('SECRET_INPUT_INVALID'));
    assert.throws(() => location.vaultReaderContext(readerRoot + ' '), error => error.code === 'VAULT_PATH_NOT_ABSOLUTE');
    await assert.rejects(reader.getMany(['payment_card_default']), matches('SECRET_ACCESS_DENIED'));
    console.log('PASS asynchronous desktop reads bind an explicit state root without blocking or changing process.env');

    runtime.setSecretPair('custom.pair_a', 'fixture-a', 'custom.pair_b', 'fixture-b');
    runtime.setSecretTriple('custom.triple_a', 'fixture-one', 'custom.triple_b', 'fixture-two', 'custom.triple_c', 'fixture-three');
    assert.deepEqual(runtime.readSecretsFromVault(['custom.pair_a', 'custom.pair_b', 'custom.missing']),
      new Map([['custom.pair_a', 'fixture-a'], ['custom.pair_b', 'fixture-b']]));
    const beforePair = fs.readFileSync(file);
    assert.throws(() => runtime.setSecretPair('custom.pair_a', 'new-fixture', 'payment_card_default', 'forbidden-fixture'), matches('SECRET_ACCESS_DENIED'));
    assert.ok(fs.readFileSync(file).equals(beforePair), 'a refused pair writes neither half');
    for (const key of ['payment_card_default', 'owner_legal_identity_v1', 'PAYMENT_CARD_DEFAULT']) {
      for (const call of [() => runtime.getSecret(key, { prompt: false }),
        () => runtime.getOrCreateSecret(key, 'forbidden-fixture'),
        () => runtime.readSecretsFromVault(['custom.roundtrip', key])]) {
        assert.throws(call, matches('SECRET_ACCESS_DENIED'));
      }
    }
    assert.equal(presence.vaultRecordPresence('payment_card_default').present, false);
    assert.ok(!runtime.listSecretKeys().includes('payment_card_default'));
    console.log('PASS coupled writes, definite absence, and oracle refusals use the production backend');

    // Exercise the actual profile provider with this disposable production
    // keyring, not its usual injected test encryption key. No browser/Docker
    // process or real account profile participates in this lifecycle.
    const profileStore = require('../src/lib/state-store').createStateStore({ file: path.join(root, 'profile-state.sqlite3'), ownerId: 'isolated-profile-proof' });
    const profileProvider = require('../src/lib/providers/agent-sandbox').createSandboxProvider({
      state: profileStore, authRoot: path.join(root, 'auth-profile-proof'),
      runDocker() { throw new Error('profile lifecycle must not start Docker'); },
      audit: { requireRecord() { return { durable: true }; }, redact: () => '[redacted]' },
    });
    const authProfile = profileProvider.createAuthProfile({ account: 'synthetic-proof', purpose: 'isolated-test' });
    assert.equal(authProfile.readiness, 'control-plane-only');
    assert.equal(authProfile.ownerSignInSupported, false);
    assert.equal(authProfile.browserSessionAvailable, false);
    const authLease = profileProvider.leaseAuthProfile({ profileId: authProfile.profileId, agent: 'claude', taskKey: 'isolated.profile.first', leaseSeconds: 120 });
    assert.equal(authLease.browserStarted, false);
    assert.throws(() => profileProvider.leaseAuthProfile({ profileId: authProfile.profileId, agent: 'codex', taskKey: 'isolated.profile.other', leaseSeconds: 120 }), matches('SANDBOX_AUTH_PROFILE_LEASED'));
    const renewedAuth = profileProvider.heartbeatAuthProfile({ handle: authLease.handle, leaseSeconds: 120 });
    profileProvider.releaseAuthProfile({ handle: renewedAuth.handle });
    const nextAuth = profileProvider.leaseAuthProfile({ profileId: authProfile.profileId, agent: 'codex', taskKey: 'isolated.profile.next', leaseSeconds: 120 });
    assert.ok(nextAuth.handle.slotFence > authLease.handle.slotFence);
    profileProvider.releaseAuthProfile({ handle: nextAuth.handle });
    assert.equal(profileProvider.authProfileStatus({ profileId: authProfile.profileId }).signInRequired, true);
    profileProvider.revokeAuthProfile({ profileId: authProfile.profileId, confirmProfileId: authProfile.profileId });
    assert.equal(profileProvider.authProfileStatus({ profileId: authProfile.profileId }).exists, false);
    profileProvider.createAuthProfile({ account: 'synthetic-proof', purpose: 'isolated-test' });
    profileStore.close();
    console.log('PASS auth-profile lifecycle uses real isolated Linux custody; authenticated browsing remains unavailable');

    const candidates = Array.from({ length: 6 }, () => crypto.randomBytes(24).toString('hex'));
    const selected = await Promise.all(candidates.map(value => launchWorker({ action: 'candidate', key: 'custom.concurrent', value })));
    assert.equal(new Set(selected.map(entry => entry.digest)).size, 1);
    assert.ok(candidates.some(value => crypto.createHash('sha256').update(value).digest('hex') === selected[0].digest));
    console.log('PASS six real concurrent processes choose exactly one creation candidate');

    // This is a generic monotonic-record test, not an audit anchor fixture.
    const checkpoint = JSON.stringify({ sequence: 9, test: 'monotonic-record' });
    runtime.setMonotonicSecret('custom.test_checkpoint', checkpoint, 9);
    runtime.setMonotonicSecret('custom.test_checkpoint', checkpoint, 9);
    const monotonicBytes = fs.readFileSync(file);
    assert.throws(() => runtime.setMonotonicSecret('custom.test_checkpoint', JSON.stringify({ sequence: 8 }), 8), matches('SECRET_MONOTONIC_CONFLICT'));
    assert.throws(() => runtime.setMonotonicSecret('custom.test_checkpoint', JSON.stringify({ sequence: 9, test: 'fork' }), 9), matches('SECRET_MONOTONIC_CONFLICT'));
    assert.throws(() => runtime.setMonotonicSecret('custom.test_checkpoint', JSON.stringify({ sequence: 10 }), 11), matches('SECRET_INPUT_INVALID'));
    assert.ok(fs.readFileSync(file).equals(monotonicBytes));
    console.log('PASS monotonic writes refuse rollback, forks, and mismatched embedded sequences');

    const holder = spawn('/usr/bin/python3', ['-I', '-c',
      'import fcntl,sys,time; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); time.sleep(30)', file + '.lock'
    ], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    const holderClosed = once(holder, 'close');
    try {
      await once(holder.stdout, 'data');
      process.env.TOOLSENABLED_VAULT_LOCK_TIMEOUT_MS = '100';
      assert.throws(() => runtime.setSecret('custom.lock', 'fixture'), matches('SECRET_VAULT_LOCK_TIMEOUT'));
    } finally {
      delete process.env.TOOLSENABLED_VAULT_LOCK_TIMEOUT_MS;
      holder.kill('SIGKILL');
      await holderClosed;
    }
    runtime.setSecret('custom.lock', 'fixture-after-crash');
    console.log('PASS kernel locking refuses contention and releases after the lock holder dies');

    const original = fs.readFileSync(file);
    const corrupted = JSON.parse(original);
    const blob = Buffer.from(corrupted.records['custom.roundtrip'], 'base64');
    blob[blob.length - 1] ^= 1;
    corrupted.records['custom.roundtrip'] = blob.toString('base64');
    fs.writeFileSync(file, JSON.stringify(corrupted), { mode: 0o600 });
    assert.throws(() => runtime.getSecret('custom.roundtrip', { prompt: false }), matches('SECRET_VAULT_UNREADABLE'));
    fs.writeFileSync(file, original);
    const swapped = JSON.parse(original);
    swapped.records['custom.roundtrip'] = swapped.records['custom.pair_a'];
    fs.writeFileSync(file, JSON.stringify(swapped));
    assert.throws(() => runtime.getSecret('custom.roundtrip', { prompt: false }), matches('SECRET_VAULT_UNREADABLE'));
    fs.writeFileSync(file, original);
    fs.chmodSync(file, 0o644);
    assert.throws(() => runtime.getSecret('custom.roundtrip', { prompt: false }), matches('SECRET_VAULT_PATH_UNSAFE'));
    fs.chmodSync(file, 0o600);
    const alias = path.join(root, 'vault-alias.json');
    fs.symlinkSync(file, alias);
    withFile(alias, () => assert.throws(() => runtime.getSecret('custom.roundtrip', { prompt: false }), matches('SECRET_VAULT_PATH_UNSAFE')));
    const ancestorAlias = path.join(root, 'ancestor-alias');
    fs.symlinkSync(path.dirname(readerFile), ancestorAlias);
    withFile(path.join(ancestorAlias, 'secrets.json'), () => assert.throws(
      () => runtime.setSecret('custom.fixture', 'candidate'), matches('SECRET_VAULT_PATH_UNSAFE')));
    const writableAncestor = path.join(root, 'writable-ancestor');
    fs.mkdirSync(writableAncestor, { mode: 0o700 });
    fs.chmodSync(writableAncestor, 0o777);
    withFile(path.join(writableAncestor, 'uncreated', 'vault.json'), () => assert.throws(
      () => runtime.setSecret('custom.fixture', 'candidate'), matches('SECRET_VAULT_PATH_UNSAFE')));
    assert.equal(fs.existsSync(path.join(writableAncestor, 'uncreated')), false, 'unsafe ancestry must refuse before creation');
    // /var is an existing root-owned directory. Reading its metadata is enough
    // to prove a foreign final directory refuses before a vault can be made.
    withFile('/var/toolsenabled-refused-fixture.json', () => assert.throws(
      () => runtime.setSecret('custom.fixture', 'candidate'), matches('SECRET_VAULT_PATH_UNSAFE')));
    const foreign = path.join(root, 'unsupported-format.json');
    fs.writeFileSync(foreign, '{"custom.fixture":"not-a-linux-envelope"}', { mode: 0o600 });
    const foreignBytes = fs.readFileSync(foreign);
    withFile(foreign, () => assert.throws(() => runtime.setSecret('custom.fixture', 'candidate'), matches('SECRET_VAULT_FORMAT_UNSUPPORTED')));
    assert.ok(fs.readFileSync(foreign).equals(foreignBytes));
    console.log('PASS real ciphertext tampering, record substitution, unsafe files, and foreign formats refuse');

    const audit = require('../src/lib/audit');
    const first = audit.requireRecord('test.linux.audit.intent', 'isolated-libsecret', { phase: 'first' });
    assert.equal(first.durable, true);
    assert.equal(first.anchored, true);
    assert.ok(first.protectedSequence >= first.sequence);
    assert.equal(audit.verify().valid, true);
    audit.resetForTests();
    const cleanDb = fs.readFileSync(process.env.TOOLSENABLED_AUDIT_DB);
    const second = audit.requireRecord('test.linux.audit.intent', 'isolated-libsecret', { phase: 'second' });
    assert.equal(second.anchored, true);
    assert.ok(second.sequence > first.sequence);
    assert.equal(audit.verify().valid, true);
    audit.resetForTests();
    assert.equal((await launchWorker({ action: 'audit' })).valid, true);
    const intactDb = fs.readFileSync(process.env.TOOLSENABLED_AUDIT_DB);
    fs.writeFileSync(process.env.TOOLSENABLED_AUDIT_DB, cleanDb);
    assert.equal(audit.verify().valid, false, 'a real signed protected head detects a rolled-back SQLite ledger');
    assert.throws(() => audit.requireRecord('test.linux.audit.refused', 'isolated-libsecret', {}));
    audit.resetForTests();
    fs.writeFileSync(process.env.TOOLSENABLED_AUDIT_DB, intactDb);
    assert.equal(audit.requireRecord('test.linux.audit.restored', 'isolated-libsecret', {}).anchored, true);
    assert.equal(audit.verify().valid, true);
    console.log('PASS real Ed25519 audit survives restart and refuses a rolled-back ledger');

    audit.resetForTests();
    daemon.kill('SIGTERM');
    await daemonClosed;
    startDaemon();
    let reopenedBackend;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      reopenedBackend = linux.status();
      if (reopenedBackend.available) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(reopenedBackend.available, true, 'the disposable keyring must reopen its real disk store: ' + JSON.stringify({
      backend: reopenedBackend.backend, code: reopenedBackend.code || null,
      daemonExitCode: daemon.exitCode, daemonSignal: daemon.signalCode
    }));
    assert.ok(runtime.getSecret('custom.roundtrip', { prompt: false }) === marker);
    assert.equal(audit.verify().valid, true);
    console.log('PASS vault credentials and signed audit survive a full private GNOME daemon restart');

    const missingKeyFile = path.join(root, 'missing-key.json');
    withFile(missingKeyFile, () => runtime.setSecret('custom.fixture', 'disposable-key-loss-fixture'));
    const missingKeyBytes = fs.readFileSync(missingKeyFile);
    const missingIdentity = JSON.parse(missingKeyBytes).identity;
    testKeyringAction('delete-key', { file: missingKeyFile, identity: missingIdentity });
    withFile(missingKeyFile, () => {
      assert.throws(() => runtime.getSecret('custom.fixture', { prompt: false }), matches('SECRET_BACKEND_KEY_MISSING'));
      assert.throws(() => runtime.getOrCreateSecret('custom.fixture', 'replacement'), matches('SECRET_BACKEND_KEY_MISSING'));
      assert.equal(presence.vaultRecordPresence('custom.fixture').present, null);
      assert.throws(() => runtime.scrubPaymentCardSecurityCode(), matches('SECRET_BACKEND_KEY_MISSING'));
      assert.throws(() => runtime.clearDeviceCredential(), {
        code: 'DEVICE_CREDENTIAL_CLEAR_FAILED', localCause: 'SECRET_BACKEND_KEY_MISSING', mutationOutcome: 'NOT_ATTEMPTED'
      });
    });
    assert.ok(fs.readFileSync(missingKeyFile).equals(missingKeyBytes));
    console.log('PASS a missing service key is unreadable and is never silently replaced');

    function checkNoPlaintext(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) checkNoPlaintext(candidate);
        else if (entry.isFile()) {
          const bytes = fs.readFileSync(candidate);
          assert.equal(bytes.includes(Buffer.from(marker)), false, 'plaintext credential appeared on disk');
          assert.equal(bytes.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')), false, 'audit private key appeared on disk');
        }
      }
    }
    checkNoPlaintext(root);
    const encryptedBeforeLock = fs.readFileSync(file);
    testKeyringAction('lock');
    assert.equal(linux.status().code, 'SECRET_BACKEND_LOCKED');
    assert.throws(() => runtime.getSecret('custom.roundtrip', { prompt: false }), matches('SECRET_BACKEND_LOCKED'));
    assert.throws(() => runtime.getOrCreateSecret('custom.new', 'candidate'), matches('SECRET_BACKEND_LOCKED'));
    assert.throws(() => profileProvider.createAuthProfile({ account: 'synthetic-proof', purpose: 'isolated-test' }), matches('SECRET_BACKEND_LOCKED'));
    assert.throws(() => runtime.scrubPaymentCardSecurityCode(), matches('SECRET_BACKEND_LOCKED'));
    assert.throws(() => runtime.clearDeviceCredential(), {
      code: 'DEVICE_CREDENTIAL_CLEAR_FAILED', localCause: 'SECRET_BACKEND_LOCKED', mutationOutcome: 'NOT_ATTEMPTED'
    });
    assert.equal(presence.vaultRecordPresence('custom.roundtrip').present, null);
    assert.equal(presence.vaultRecordPresence('custom.missing').present, null);
    assert.equal(audit.verify().valid, false, 'a warm signer cannot bypass a locked keyring');
    assert.throws(() => audit.requireRecord('test.linux.lock.refused', 'isolated-libsecret', {}));
    assert.ok(fs.readFileSync(file).equals(encryptedBeforeLock));
    audit.resetForTests();
    console.log('PASS locking the real keyring invalidates warm reads and signed-audit admission; no plaintext reached disk');
  } finally {
    try { await require('../src/lib/audit').close(); }
    finally { daemon.kill('SIGTERM'); await daemonClosed; }
  }
}

async function main() {
  if (process.argv[2] === '--worker') return worker();
  if (process.argv[2] === '--private-bus') return privateRun(process.argv[3], process.argv[4] === 'plaintext',
    process.argv[4] === 'components' ? process.argv.slice(5) : null);
  if (process.argv[2] === '--hygiene-no-bus') return noBusHygiene(process.argv[3]);
  assert.equal(process.platform, 'linux', 'This integration proof requires real Linux; it does not simulate another platform.');
  if (process.argv[2] === '--components') {
    const componentArgs = process.argv.slice(3);
    assert.ok(componentArgs.length, '--components requires tests/run-isolated.js arguments');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-component-libsecret-'));
    try {
      const result = spawnSync('/usr/bin/dbus-run-session', ['--', process.execPath, __filename,
        '--private-bus', root, 'components', ...componentArgs], {
        env: freshEnvironment(root), stdio: 'inherit', shell: false
      });
      assert.ifError(result.error);
      process.exitCode = Number.isInteger(result.status) ? result.status : 1;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false, 'component vault and keyring cleanup must finish');
    }
    return;
  }
  const boundary = spawnSync('/usr/bin/python3', ['-I', path.join(__dirname, 'lib', 'linux-vault-boundary.py')], {
    env: {}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, shell: false
  });
  assert.ifError(boundary.error);
  assert.equal(boundary.status, 0, `vault boundary unit cases failed: ${(boundary.stderr || '').slice(0, 2000)}`);
  console.log('PASS explicit vault boundary unit cases (real Linux custody integration follows)');
  const hygieneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-private-hygiene-'));
  try {
    const result = spawnSync(process.execPath, [__filename, '--hygiene-no-bus', hygieneRoot], {
      env: freshEnvironment(hygieneRoot), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, shell: false
    });
    process.stdout.write(result.stdout || '');
    assert.equal(result.status, 0, `no-bus hygiene test failed: ${(result.stderr || '').slice(0, 2000)}`);
  } finally {
    fs.rmSync(hygieneRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(hygieneRoot), false);
  }
  for (const mode of ['encrypted', 'plaintext']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-private-libsecret-'));
    try {
      const result = spawnSync('/usr/bin/dbus-run-session', ['--', process.execPath, __filename, '--private-bus', root, mode], {
        env: freshEnvironment(root), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, shell: false
      });
      process.stdout.write(result.stdout || '');
      assert.equal(result.status, 0, `private ${mode} keyring test failed: ${(result.stderr || '').slice(0, 2000)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false, 'disposable vault and keyring cleanup must finish');
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
