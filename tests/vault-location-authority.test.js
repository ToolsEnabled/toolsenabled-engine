// EXECUTABLE CHANGE
'use strict';

/*
 * TEST-CAN-FAIL REPORT (testcanfail-tests-vault-location-authority-test-js)
 *
 * STRENGTHENED: the vaultEnvironment publication assertion formerly compared
 * its result with vaultPath(), another export backed by the same code under
 * test. Mutation: vaultPath() was temporarily changed to return
 * '/tmp/mutated-wrong-vault.json'. Before this change the file stayed green;
 * afterward the assertion went RED with:
 *
 *   not ok 5 - the helper environment publishes the decided path and never mutates the caller
 *   error: |-
 *     a child must receive the independently specified authority input
 *     + actual - expected
 *     + '/tmp/mutated-wrong-vault.json'
 *     - '/tmp/published/secrets.json'
 *   code: 'ERR_ASSERTION'
 *
 * The source mutation was restored byte-for-byte. The restored-source run was:
 *
 *   ok 5 - the helper environment publishes the decided path and never mutates the caller
 *   # tests 5
 *   # pass 5
 *   # fail 0
 *
 * NOT-FOUND (1): empty-capable assertion loops. Both loops use non-empty array
 * literals in this file, so their assertion bodies cannot be skipped.
 * NOT-FOUND (2): exit-status or truthy-return assertions used as sole evidence.
 * NOT-FOUND (3): try/catch or optional chaining that swallows test failures.
 * NOT-FOUND (4): mocks of the vault-location implementation under test.
 * NOT-FOUND (5): skips or platform/precondition guards that make the file inert.
 * NOT-FOUND (6), beyond the assertion strengthened above: expected values
 * computed by the same implementation code that they check.
 * UNMET PRECONDITIONS: none.
 */

/*
 * ONE DECISION ABOUT WHICH FILE IS THE VAULT.
 *
 * Five places used to answer that question independently -- runtime.js,
 * secret-store/powershell.js, secrets.ps1, secrets-manager.ps1, and the
 * fixed-repo credential paths -- and they agreed only while their assumptions
 * agreed. When they stopped agreeing, a presence check returned a TRUE "absent"
 * answer for a credential that did exist, because it had read a different file.
 *
 * The rule this file pins: an override is an INPUT to the authority, never a
 * competing authority. Everything derived from the decision -- the file, its
 * directory, the lock, the prompt lock, the access log -- comes from one frozen
 * record, and nothing may join a root with 'vault' for itself.
 */

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  resolveVaultLocation, assertVaultPath, vaultEnvironment, vaultPath,
  resetVaultLocationForTests
} = require('../src/lib/vault-location');

// NOTE ON WHAT IS NOT TESTED HERE, so nobody reads a gap as coverage: the
// state-root branch takes no injection seam of its own -- resolveVaultLocation
// calls resolveStateRoot directly -- so these checks drive the override and the
// unredirected fallback, and the redirected branch is left to that module's own
// tests rather than faked here.
const PROGRAM = path.join(os.tmpdir(), 'te-vault-program');

test('an absolute override is the whole answer, and every path hangs off it', () => {
  const file = path.join(os.tmpdir(), 'explicit', 'secrets.json');
  const location = resolveVaultLocation({ environment: { TOOLSENABLED_VAULT_PATH: file } });

  assert.equal(location.file, path.resolve(file));
  assert.equal(location.directory, path.dirname(path.resolve(file)));
  assert.equal(location.lock, `${path.resolve(file)}.lock`);
  assert.equal(location.promptLock, `${path.resolve(file)}.prompt.lock`);
  assert.equal(location.accessLog, `${path.resolve(file)}.access.log`);
  assert.ok(Object.isFrozen(location), 'the decision must not be editable after the fact');
});

test('A RELATIVE OVERRIDE IS REFUSED, because it names a different vault from every directory', () => {
  // This is the regression that produced three vaults on one machine. Resolving
  // it against cwd is not a repair; it is the defect wearing a helpful face.
  assert.throws(
    () => resolveVaultLocation({ environment: { TOOLSENABLED_VAULT_PATH: 'relative/secrets.json' } }),
    (error) => {
      assert.equal(error.code, 'VAULT_PATH_NOT_ABSOLUTE');
      return true;
    }
  );

  assert.throws(
    () => resolveVaultLocation({ environment: { TOOLSENABLED_VAULT_PATH: './also/relative.json' } }),
    (error) => (error.code === 'VAULT_PATH_NOT_ABSOLUTE')
  );
});

test('a blank or whitespace override is absent, not a path', () => {
  for (const value of ['', '   ', '\t']) {
    const location = resolveVaultLocation({
      environment: { TOOLSENABLED_VAULT_PATH: value },
      programRoot: PROGRAM
    });
    assert.ok(location.file.startsWith(PROGRAM),
      `a blank override must fall through to the ordinary decision, got ${location.file}`);
  }
});

test('a non-string override is refused rather than treated as absent', () => {
  for (const value of [null, 42, { path: '/vault/secrets.json' }]) {
    assert.throws(
      () => resolveVaultLocation({
        environment: { TOOLSENABLED_VAULT_PATH: value },
        programRoot: PROGRAM
      }),
      (error) => error.code === 'VAULT_PATH_INVALID',
      `${JSON.stringify(value)} must not silently select the default vault`
    );
  }
});

test('assertVaultPath compares against the decision, it does not derive a second one', () => {
  const chosen = path.join(os.tmpdir(), 'chosen', 'secrets.json');
  const location = resolveVaultLocation({ environment: { TOOLSENABLED_VAULT_PATH: chosen } });

  assert.equal(assertVaultPath(chosen, location), location.file,
    'the canonical path comes back so a caller can use the checked value');

  assert.throws(
    () => assertVaultPath(path.join(os.tmpdir(), 'other', 'secrets.json'), location),
    (error) => {
      assert.equal(error.code, 'VAULT_PATH_MISMATCH',
        'a second vault must be refused by name, which is the whole point');
      return true;
    }
  );

  for (const bad of ['', '   ', null, undefined, 42]) {
    assert.throws(() => assertVaultPath(bad, location),
      (error) => (error.code === 'VAULT_PATH_INVALID'),
      `${JSON.stringify(bad)} is not a path and must be refused before any comparison`);
  }
});

test('the helper environment publishes the decided path and never mutates the caller', (t) => {
  const chosen = path.join(os.tmpdir(), 'published', 'secrets.json');
  const previous = process.env.TOOLSENABLED_VAULT_PATH;
  process.env.TOOLSENABLED_VAULT_PATH = chosen;
  t.after(() => {
    if (previous === undefined) delete process.env.TOOLSENABLED_VAULT_PATH;
    else process.env.TOOLSENABLED_VAULT_PATH = previous;
    resetVaultLocationForTests();
  });
  resetVaultLocationForTests();
  const base = Object.freeze({ EXISTING: 'kept' });
  const environment = vaultEnvironment(base);

  assert.equal(environment.TOOLSENABLED_VAULT_PATH, path.resolve(chosen),
    'a child must receive the independently specified authority input');
  assert.ok(path.isAbsolute(environment.TOOLSENABLED_VAULT_PATH),
    'what is handed to a child is always absolute');
  assert.equal(environment.EXISTING, 'kept', 'the rest of the environment survives');
  assert.equal(base.TOOLSENABLED_VAULT_PATH, undefined,
    'the caller object is not written through');
  resetVaultLocationForTests();
});
