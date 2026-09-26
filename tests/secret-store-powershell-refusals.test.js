'use strict';

require('./lib/isolated-environment').activate('secret-store-powershell-refusals');

const assert = require('node:assert/strict');
const Module = require('node:module');

const TARGET = require.resolve('../src/lib/secret-store/powershell');

function loadStore({ accessError, spawnResult } = {}) {
  const calls = { access: [], spawn: [], writes: 0 };
  const fakeFs = {
    constants: { F_OK: 0 },
    accessSync(...args) {
      calls.access.push(args);
      if (accessError) throw accessError;
    },
    writeFileSync() { calls.writes += 1; },
    appendFileSync() { calls.writes += 1; }
  };
  const fakeChildProcess = {
    spawnSync(...args) {
      calls.spawn.push(args);
      return spawnResult || { status: 0, stdout: '{}', stderr: '' };
    }
  };
  const originalLoad = Module._load;
  Module._load = function loadWithSecretManagerFakes(request, parent, isMain) {
    if (parent && parent.filename === TARGET) {
      if (request === 'node:fs') return fakeFs;
      if (request === 'node:child_process') return fakeChildProcess;
      if (request === '../vault-platform') return { assertWindowsVaultPlatform() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[TARGET];
  try {
    return { store: require(TARGET), calls };
  } finally {
    Module._load = originalLoad;
  }
}

function assertRefusal(code, invoke) {
  assert.throws(invoke, (error) => {
    assert.equal(error && error.name, 'SecretStoreError');
    assert.equal(error && error.code, code);
    return true;
  });
}

{
  const { store, calls } = loadStore();
  assertRefusal('SECRET_OPERATION_INVALID', () => store.mutate('rename', 'api_key', 'never-written'));
  assert.deepEqual(calls, { access: [], spawn: [], writes: 0 });
}

{
  const missing = Object.assign(new Error('missing manager'), { code: 'ENOENT' });
  const { store, calls } = loadStore({ accessError: missing });
  assertRefusal('SECRET_MANAGER_NOT_INSTALLED', () => store.inventory());
  assert.equal(calls.access.length, 1);
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.writes, 0);
}

{
  const denied = Object.assign(new Error('manager cannot be inspected'), { code: 'EACCES' });
  const { store, calls } = loadStore({ accessError: denied });
  assertRefusal('SECRET_MANAGER_UNAVAILABLE', () => store.inventory());
  assert.equal(calls.access.length, 1);
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.writes, 0);
}

{
  const { store, calls } = loadStore({
    spawnResult: { status: 0, stdout: 'not-json', stderr: '' }
  });
  assertRefusal('SECRET_MANAGER_PROTOCOL_INVALID', () => store.run('inventory'));
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0][0], 'powershell.exe');
  assert.equal(calls.spawn[0][2].input, undefined);
  assert.equal(calls.writes, 0);
}

{
  const { store, calls } = loadStore({
    spawnResult: { status: 23, stdout: '', stderr: 'not-json' }
  });
  assertRefusal('SECRET_MANAGER_FAILED', () => store.run('inventory'));
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0][2].input, undefined);
  assert.equal(calls.writes, 0);
}

{
  /* A VAULT PATH THAT WAS SUPPLIED BUT CANNOT BE USED IS REFUSED, NOT IGNORED.
   *
   * This line used to read `if (options.vaultPath)`. A caller that passed an
   * empty string -- or any falsy value it had computed -- got NO override
   * installed in the child environment, and the manager then resolved the vault
   * from the ambient environment: a secret read from, or written to, A DIFFERENT
   * VAULT than the caller named, silently. This machine carries four vault roots
   * and the confusion between them has already cost this project days.
   *
   * The lockTimeoutMs override four lines below always distinguished supplied
   * from absent, so the two overrides in one function disagreed about what
   * "supplied" means. */
  for (const unusable of ['', '   ', 42, null, {}]) {
    const { store, calls } = loadStore();
    assertRefusal('SECRET_VAULT_PATH_INVALID', () => store.run('inventory', { vaultPath: unusable }));
    assert.equal(calls.spawn.length, 0,
      'a call with an unusable vault path reached the secret manager anyway -- it would have used whichever vault the environment names');
    assert.equal(calls.writes, 0);
  }

  /* THE TWO CONTROLS. Without them, "refuse every vaultPath" and "refuse every
     call" both satisfy the loop above while breaking the override entirely. */
  {
    const { store, calls } = loadStore();
    store.run('inventory', { vaultPath: 'C:/vaults/chosen' });
    assert.equal(calls.spawn.length, 1, 'a real vault path stopped working');
    const environment = calls.spawn[0][2].env;
    assert.ok(String(environment.TOOLSENABLED_VAULT_PATH).includes('chosen'),
      'the override was not installed in the child environment, which is the whole point of the option');
  }
  {
    const { store, calls } = loadStore();
    store.run('inventory');
    assert.equal(calls.spawn.length, 1, 'omitting vaultPath entirely must still work -- absent is not the same as unusable');
  }
}

console.log('PASS drove five PowerShell secret-manager refusals and their no-write/spawn boundaries');
