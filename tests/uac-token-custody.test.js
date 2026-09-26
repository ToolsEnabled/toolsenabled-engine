'use strict';

require('./lib/isolated-environment').activate('uac-token-custody');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const uac = require('../src/lib/uac-delegation');

test('Windows ownership follows the process token even when SSH environment names a workgroup', () => {
  const previous = { USERDOMAIN: process.env.USERDOMAIN, USERNAME: process.env.USERNAME };
  process.env.USERDOMAIN = 'WORKGROUP';
  process.env.USERNAME = 'wrong-environment-user';
  let queried = 0;
  try {
    const principal = uac.ownerPrincipal({ platform: 'win32', execFileSyncImpl(executable, args, options) {
      queried += 1;
      assert.equal(executable, '\\\\.\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.equal(options.shell, false);
      assert.deepEqual(options.env, {});
      assert.ok(options.timeout > 0 && options.timeout <= 5000);
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.match(script, /WindowsIdentity.*GetCurrent/);
      return 'REALHOST\\Ana María López\r\n';
    } });
    assert.equal(principal, 'REALHOST\\Ana María López');
    assert.equal(queried, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('unavailable or malformed OS identity refuses without trusting ambient account names', () => {
  for (const output of ['', 'not-an-account', 'HOST\\owner\nHOST\\second', 'HOST\\owner:(F)']) {
    assert.throws(() => uac.ownerPrincipal({ platform: 'win32', execFileSyncImpl: () => output }),
      error => error.code === 'UAC_OWNER_PRINCIPAL_INVALID');
  }
  assert.throws(() => uac.ownerPrincipal({ platform: 'win32', execFileSyncImpl() { throw new Error('private process diagnostics'); } }),
    error => error.code === 'UAC_OWNER_PRINCIPAL_INVALID' && !error.message.includes('private process diagnostics'));
});

test('a token is published only after owner ACL succeeds, and a failed replacement preserves prior bytes', t => {
  const file = path.join(path.dirname(uac.TOKEN_FILE), `token-custody-${crypto.randomUUID()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prior = '{"version":1,"bootId":"previous-boot","token":"prior-fixture"}\n';
  fs.writeFileSync(file, prior);
  t.after(() => fs.rmSync(file, { force: true }));
  let attempts = 0;
  const options = { tokenFile: file, platform: 'win32', ownerPrincipal: 'HOST\\owner',
    clock: () => 120000, uptime: () => 60, spawnSyncImpl(executable, args) {
      attempts += 1;
      assert.equal(executable, '\\\\.\\GLOBALROOT\\SystemRoot\\System32\\icacls.exe');
      assert.notEqual(args[0], file, 'ACL applies to an unpublished temporary file');
      assert.equal(fs.readFileSync(file, 'utf8'), prior, 'prior record survives until the new ACL is established');
      assert.ok(fs.existsSync(args[0]));
      return { status: 1 };
    } };
  assert.throws(() => uac.loadOrCreateToken(options), error => error.code === 'UAC_TOKEN_UNAVAILABLE');
  assert.equal(attempts, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), prior);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.startsWith(path.basename(file)+'.')), []);
  options.spawnSyncImpl = (executable, args) => {
    assert.equal(fs.readFileSync(file, 'utf8'), prior);
    assert.notEqual(args[0], file);
    return { status: 0 };
  };
  const token = uac.loadOrCreateToken(options);
  assert.equal(uac.readToken(options).equals(token), true);
});
