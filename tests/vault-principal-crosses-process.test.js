'use strict';

/*
 * The owner's per-credential switch must survive a process boundary.
 *
 * MEASURED against the then-live source: the principal lived only in an
 * AsyncLocalStorage, and assertVaultReadAllowed treated an empty store as
 * "unruled" and therefore allowed. A child process is born with an empty store.
 * So an agent at a permission tier that admits an exec tool never had to defeat
 * the owner's switches at all -- it ran a command, and the command's process
 * read every credential with no rule applied. The switch governed exactly one
 * process, which is not the process the agent's work happens in.
 *
 * A child spawned inside a principal context now carries that context in its
 * environment and is ruled by it. The environment value is built per spawn from
 * the live context rather than stamped on process.env, because agent lanes run
 * concurrently in one process and a mutated global would hand one lane another
 * lane's principal -- or clear it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const runtime = require('../src/lib/runtime');
const policy = require('../src/lib/vault-access-policy');

const KEY = 'custom.provider_api_key';
const ROLE = 'builder';
const OTHER_ROLE = 'reviewer';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-principal-'));
try {
  // The owner has turned this credential OFF for the builder role.
  const stateDirectory = path.join(root, 'state');
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const policyFile = path.join(stateDirectory, 'vault-access-policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({
    version: 1,
    records: { [KEY]: { access: { [ROLE]: false, [OTHER_ROLE]: true } } }
  }), { mode: 0o600 });

  // --- the rule itself, so the rest of the test is about reach, not policy ---
  {
    const read = policy.readPolicy(undefined, { file: policyFile });
    assert.equal(read.readable, true, 'the policy file parses');
    assert.equal(policy.mayRead(read, KEY, [ROLE]).allowed, false, 'the owner turned it off for this role');
    assert.equal(policy.mayRead(read, KEY, [OTHER_ROLE]).allowed, true, 'and left it on for another');
    assert.equal(policy.mayRead(read, KEY, []).allowed, true,
      'a read naming nobody is the installation acting for itself and stays allowed');
  }

  // --- the environment carries the principal, and only when there is one ----
  {
    assert.deepEqual(runtime.currentVaultPrincipals(), [],
      'no principal is active at the top level');
    assert.deepEqual(runtime.vaultPrincipalEnvironment({ PATH: '/usr/bin' }), { PATH: '/usr/bin' },
      'with no principal active the child environment is untouched');

    runtime.withVaultPrincipal([ROLE, 'agent-7'], () => {
      assert.deepEqual(runtime.currentVaultPrincipals(), [ROLE, 'agent-7']);
      const childEnv = runtime.vaultPrincipalEnvironment({ PATH: '/usr/bin' });
      assert.equal(childEnv.PATH, '/usr/bin', 'the rest of the environment survives');
      assert.deepEqual(
        JSON.parse(childEnv[runtime.VAULT_PRINCIPAL_ENV]), [ROLE, 'agent-7'],
        'the child environment names the principal the parent is acting as'
      );
    });

    assert.deepEqual(runtime.currentVaultPrincipals(), [],
      'and the context does not leak past its callback');
  }

  // --- a malformed or absent value is no principal, never a wrong one -------
  for (const raw of [undefined, '', 'not json', '"a string"', '{"role":"builder"}', '[]', '[1,2]']) {
    const environment = raw === undefined ? {} : { [runtime.VAULT_PRINCIPAL_ENV]: raw };
    assert.deepEqual(runtime.inheritedVaultPrincipals(environment), [],
      `${JSON.stringify(raw)} must read as no principal rather than an invented one`);
  }
  assert.deepEqual(
    runtime.inheritedVaultPrincipals({ [runtime.VAULT_PRINCIPAL_ENV]: JSON.stringify([ROLE, 12, '', 'agent-7']) }),
    [ROLE, 'agent-7'],
    'only real non-empty strings count as principals'
  );

  // --- THE CASE THAT MATTERED: a child process is ruled ---------------------
  // Run assertVaultReadAllowed in a genuinely separate process, whose
  // AsyncLocalStorage is empty by construction, and see whether the owner's
  // switch reaches it.
  const child = [
    `const runtime = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lib', 'runtime'))});`,
    'let outcome = "allowed";',
    'try { runtime.assertVaultReadAllowed(process.env.PROBE_KEY); }',
    'catch (error) { outcome = "refused:" + (error && error.code); }',
    'process.stdout.write(outcome);'
  ].join('\n');

  const runChild = extra => execFileSync(process.execPath, ['-e', child], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TOOLSENABLED_STATE_ROOT: root,
      PROBE_KEY: KEY,
      ...extra
    }
  }).trim();

  const ruled = runChild(
    runtime.withVaultPrincipal([ROLE], () => runtime.vaultPrincipalEnvironment({}))
  );
  assert.match(ruled, /^refused:/,
    `a child spawned inside the builder's context must be refused a credential the owner turned off for the builder; it answered ${JSON.stringify(ruled)}`);

  // A principal the owner left switched on is still served.
  const permitted = runChild(
    runtime.withVaultPrincipal([OTHER_ROLE], () => runtime.vaultPrincipalEnvironment({}))
  );
  assert.equal(permitted, 'allowed',
    'a role the owner left switched on still reads the credential in a child');

  // And the installation acting for itself is unchanged.
  const unruled = runChild({});
  assert.equal(unruled, 'allowed',
    'a child with no principal is the installation acting for itself and stays allowed');

  console.log('The owner\'s per-credential switch reaches a child process; a malformed value names nobody.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
