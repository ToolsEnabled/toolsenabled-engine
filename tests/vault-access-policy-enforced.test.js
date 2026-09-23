/* EXECUTABLE CHANGE

Assertion audit (testcanfail-tests-vault-access-policy-enforced-test-js):
- Shape 1 NOT-FOUND: no assertion iterates a collection that could be empty.
  Every case asserts a named code or a literal value directly.
- Shape 2 NOT-FOUND: there are no exit-status or truthy-return assertions. Each
  rejection case asserts the subject error's own `code` AND its own message
  text, so an unrelated throw cannot satisfy it.
- Shape 3 NOT-FOUND: no try/catch swallows an assertion. The helper's finally
  block restores env and cache state only; the two `assert.throws` calls carry
  explicit predicates.
- Shape 4 NOT-FOUND: the seam supplied is the POLICY FILE, which is the real
  artifact the desktop app writes. Assertions inspect what the product's own
  readSecretFromVault / readSecretsFromVault / getOrCreateSecret do, not what
  the seam returns.
- Shape 5 PRESENT AND NAMED: one case skips on Linux, and says why at the skip.
  An earlier revision of this file claimed here that the cases "deliberately need
  no vault and no powershell.exe, which is why they carry no platform guard".
  That was false on Linux and this file was approved 4/10 red there. Two reasons,
  both in the product and both deliberate:
    * The DENY cases genuinely need no vault -- they refuse above it, which is
      the property under test -- and they run and pass on both platforms.
    * The cases that fall THROUGH to the vault do reach real custody. On Linux
      src/linux-vault.py walks the store's directory and refuses any that is not
      an owned 0700 directory holding 0600 regular files, so a fixture built
      with default permissions answered SECRET_VAULT_PATH_UNSAFE instead of
      SECRET_NOT_CONFIGURED. Those cases now point at an ABSENT store on Linux,
      which src/linux-vault.py `read_vault` answers with the record's absence.
    * The value-cache ordering case cannot exist on Linux at all:
      src/lib/runtime.js `vaultContentDigest` returns null there on purpose, and
      `rememberSecretValue` declines a null digest, so there is no cache above
      the vault to order against. That case skips on Linux and names this.
- Shape 6 NOT-FOUND: expected codes and sentences are independent string
  literals spelled out here, not values read back from the product module.
- Mutation (the gate's own check, recorded because this file IS the gate):
  deleting the three `assertVaultReadAllowed(...)` calls in src/lib/runtime.js
  reproduces the pre-change code exactly and produced RED:
  "not ok 1 - a denied role is refused before the vault is opened".
  Restoring them produced GREEN: "# pass 9", "# fail 0".
  Full outputs are quoted in REPORT-LANED-ITEM1-20260919.md.
- Preconditions unmet: none.
*/

'use strict';

/*
 * THE OWNER'S PER-CREDENTIAL SWITCH IS ENFORCED ON THE PATH AN AGENT ACTUALLY
 * TAKES -- which, before the change this file guards, it was not.
 *
 * THE MEASURED DEFECT. The desktop app shipped the whole owner-facing half of
 * this feature: a #/vault page drawing a checkbox per role per credential, a
 * durable policy file, and a consultation of that policy in the app's
 * shell/vault-presence.cjs `vaultRecordValues`. But `vaultRecordValues` has one
 * non-test caller in that repository -- shell/google-signin-config.cjs -- and it
 * passes no principal by design, because it is the installation reading its own
 * credentials. An assistant's credential read never goes near it: it goes
 * through this repository's src/lib/runtime.js `getSecret`. Repository-wide
 * search of this tree found ZERO references to the policy module or its file
 * before this change. So every checkbox on that page governed a code path no
 * agent ever took, while the page's own text promised the opposite.
 *
 * WHAT THESE CASES PIN, and deliberately do not. They assert BEHAVIOUR by
 * calling the product's own read functions with values and reading what comes
 * back. They do not pin where the check is written or what it is called -- a
 * better implementation that refuses the same reads passes unchanged. What is
 * pinned is the part a person loses if it regresses: that a denied identity
 * gets a named refusal, that an allowed one still reads, that the product's own
 * principal-less reads are untouched, and -- the two orderings that are the
 * whole security value -- that the refusal beats BOTH the value cache and the
 * vault itself.
 *
 * NO VAULT AND NO powershell.exe ARE NEEDED, and that is a property under test
 * rather than a convenience. These cases point the state root at an empty
 * temporary directory. If the check ever moved to AFTER the vault read, the
 * denied cases would start reporting a missing-vault error instead of the
 * refusal, and they would go red -- which is exactly the regression worth
 * catching, because a check that runs after the read has already decrypted the
 * value it was supposed to withhold.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* The state root must be chosen BEFORE runtime.js is first required:
   src/lib/runtime-state-root.js resolves it once and memoises the answer, so a
   later assignment would be read by nothing. */
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-access-policy-'));
process.env.TOOLSENABLED_STATE_ROOT = STATE_ROOT;
/* AND THE VAULT ITSELF, which the state root does NOT redirect on its own:
   src/lib/runtime.js `vaultFilePath` honours TOOLSENABLED_VAULT_PATH first, so
   without this a developer machine's real vault answers these reads. Measured
   while writing this file -- an unruled case resolved a real credential and made
   a live API call with it. Pointing it at the empty temporary root is what makes
   "the vault holds nothing" true rather than assumed. */
process.env.TOOLSENABLED_VAULT_PATH = path.join(STATE_ROOT, 'vault', 'secrets.json');
fs.mkdirSync(path.join(STATE_ROOT, 'state'), { recursive: true });
const VAULT_FILE = path.join(STATE_ROOT, 'vault', 'secrets.json');

/* THE STORE THESE CASES POINT AT IS EMPTY ON WINDOWS AND ABSENT ON LINUX,
   because the two custody implementations answer "there is nothing here"
   differently and both answers are correct.

   ON WINDOWS, an empty store rather than an absent one is load-bearing twice.
   src/lib/runtime.js `vaultContentDigest` answers null for a file that is not
   there, and `rememberSecretValue` declines to cache against a null digest --
   so with no file at all the cache-ordering case below could not populate the
   cache it exists to test, and would have passed for the wrong reason. An empty
   store also gives every read the vault's own honest answer, the record's
   absence, rather than a missing-store error.

   ON LINUX neither reason survives contact with the real implementation.
   `vaultContentDigest` returns null on linux unconditionally and on purpose, so
   there is no value cache to populate there at all. And custody is stricter
   than a file's contents: src/linux-vault.py `vault_directory` refuses any
   store directory that is not owned and 0700, and `private_file` refuses any
   store file that is not a 0600 regular file -- so a directory made with the
   default umask answers SECRET_VAULT_PATH_UNSAFE, and a `{}` file that clears
   those checks still answers SECRET_VAULT_FORMAT_UNSUPPORTED because it is not
   a Linux vault. Creating NEITHER is what gives the record's absence there:
   `read_vault` returns None for a missing file and the helper refuses `get`
   with SECRET_NOT_CONFIGURED, which is the same answer the empty Windows store
   gives, reached honestly. */
const LINUX = process.platform === 'linux';
if (!LINUX) {
  fs.mkdirSync(path.join(STATE_ROOT, 'vault'), { recursive: true });
  fs.writeFileSync(VAULT_FILE, '{}', 'utf8');
}

const runtime = require('../src/lib/runtime');
const policyModule = require('../src/lib/vault-access-policy');

/* The exact sentences a refused caller receives, spelled out here as
   independent literals. If the product's wording changes, these cases fail and
   a person decides whether the new wording still tells the truth -- that is the
   point of not importing them. */
const DENIED_CODE = 'VAULT_ACCESS_DENIED';
const DENIED_TEXT = 'The owner of this computer turned off your access to this credential.';
const UNREADABLE_CODE = 'VAULT_POLICY_UNREADABLE';
const UNREADABLE_TEXT = 'This computer holds the owner\'s decisions about which credentials may be read '
  + 'and could not read them, so nothing is handed over. That is not the same as having no rules.';

const POLICY_FILE = path.join(STATE_ROOT, 'state', 'vault-access-policy.json');

/** Write the policy file exactly as the desktop app's writer shapes it. */
function writePolicy(records) {
  fs.writeFileSync(POLICY_FILE, JSON.stringify({ version: 1, records }), 'utf8');
}

function writeRawPolicy(text) {
  fs.writeFileSync(POLICY_FILE, text, 'utf8');
}

function clearPolicy() {
  try { fs.unlinkSync(POLICY_FILE); } catch { /* absent is the first-run state */ }
}

test.afterEach(() => {
  runtime.invalidateSecretValueCache();
  clearPolicy();
});

/**
 * Call `read` and return the code it refused with, or null if it returned.
 *
 * WHY "OR NULL" RATHER THAN ASSERTING IT THROWS. The property under test in the
 * allow cases is "the owner's policy did not refuse this", and that is true
 * whether the vault then answered or reported the record absent. Requiring a
 * throw would pin the CONTENTS of the machine's vault instead: the case would
 * pass on a machine holding no such record and fail on one that holds it, while
 * the product behaved identically on both. That is a false red waiting to
 * happen, and it is not what anybody loses if this regresses.
 */
function refusalCodeOf(read) {
  try {
    read();
    return null;
  } catch (error) {
    return error && error.code;
  }
}

test('a denied role is refused before the vault is opened', () => {
  writePolicy({ stripe_secret_key: { access: { builder: false } } });
  assert.throws(
    () => runtime.withVaultPrincipal(['builder'], () => runtime.getSecret('stripe_secret_key')),
    error => {
      /* The code AND the sentence, because a refusal that names itself is the
         requirement -- a bare throw would satisfy a looser predicate. */
      assert.strictEqual(error.code, DENIED_CODE);
      assert.strictEqual(error.message, DENIED_TEXT);
      return true;
    }
  );
  /* The store this read was pointed at holds no such record, so no value for it
     existed anywhere to be handed over. Reaching the owner's refusal rather than
     the vault's own "not configured" -- which is what the unruled cases below
     get from this same empty store -- is what shows the decision was made
     before the store was opened. */
  assert.strictEqual(
    /* On Linux there is no store file at all (see the note at the top), which
       holds the record even more strongly than an empty one does. */
    LINUX ? fs.existsSync(VAULT_FILE)
      : Object.hasOwn(JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')), 'stripe_secret_key'),
    false
  );
});

test('a remembered value is not served to a denied caller', { skip: LINUX
  && 'src/lib/runtime.js vaultContentDigest returns null on linux by design, so '
  + 'rememberSecretValue declines every digest and there is no value cache above '
  + 'the vault for a refusal to have to beat. This orders two things that cannot '
  + 'both exist on this platform; it is not that the ordering went unchecked.' }, () => {
  /* THE ORDERING THAT MATTERS MOST. The value cache sits above the vault, so a
     check placed below it would hand a denied caller a decrypted value it had
     already been given once for somebody else. */
  const digest = runtime.vaultContentDigest();
  runtime.rememberSecretValue('github_token', digest, 'remembered-value-under-test');
  assert.strictEqual(
    runtime.rememberedSecretValue('github_token', digest), 'remembered-value-under-test',
    'the cache must really hold the value, or this case proves nothing'
  );
  writePolicy({ github_token: { access: { builder: false } } });
  assert.throws(
    () => runtime.withVaultPrincipal(['builder'], () => runtime.getSecret('github_token')),
    error => {
      assert.strictEqual(error.code, DENIED_CODE);
      assert.strictEqual(error.message, DENIED_TEXT);
      return true;
    }
  );
});

test('a rule may name one agent rather than a whole role', () => {
  writePolicy({ stripe_secret_key: { access: { 'node-22-740cd4ee': false } } });
  assert.throws(
    () => runtime.withVaultPrincipal(['builder', 'node-22-740cd4ee'], () => runtime.getSecret('stripe_secret_key')),
    error => error.code === DENIED_CODE
  );
});

test('naming the agent does not escape a deny set on its role', () => {
  /* Denying the role and allowing the agent must still refuse: the most
     specific rule does NOT win, because that would make a role-wide switch
     escapable by the very identity it was meant to cover. */
  writePolicy({ stripe_secret_key: { access: { builder: false, 'node-22-740cd4ee': true } } });
  assert.throws(
    () => runtime.withVaultPrincipal(['builder', 'node-22-740cd4ee'], () => runtime.getSecret('stripe_secret_key')),
    error => error.code === DENIED_CODE
  );
});

test('a role the owner has not ruled on still reads', () => {
  writePolicy({ stripe_secret_key: { access: { builder: false } } });
  /* A deny set for one role must not close the record for another. Anything
     else would mean this change closed a credential nobody closed. */
  const code = refusalCodeOf(() => runtime.withVaultPrincipal(['reviewer'], () => runtime.getSecret('stripe_secret_key')));
  assert.notStrictEqual(code, DENIED_CODE, 'a role the owner never closed was refused');
  assert.notStrictEqual(code, UNREADABLE_CODE, 'a readable policy was reported unreadable');
  /* And the vault really was consulted: with the store redirected to an empty
     directory, its own answer is the record's absence. */
  assert.strictEqual(code, 'SECRET_NOT_CONFIGURED');
});

test('the installation reading its own credentials is never ruled on', () => {
  /* THE OUTAGE THIS PREVENTS. Sign-in, audit signing and startup all read the
     vault with no principal. If the opt-out policy reached them, promoting this
     change over an existing install would lock the product out of its own
     credentials. */
  writePolicy({ stripe_secret_key: { access: { builder: false } } });
  const code = refusalCodeOf(() => runtime.getSecret('stripe_secret_key'));
  assert.notStrictEqual(code, DENIED_CODE, 'the product was refused its own credential');
  assert.strictEqual(code, 'SECRET_NOT_CONFIGURED');
});

test('a policy that exists and cannot be read refuses, and is not treated as no rules', () => {
  /* A corrupted byte must not silently re-open every credential the owner
     closed. Absent means "no decisions yet"; unreadable means "the decisions
     are on disk and unavailable", and the two get different answers. */
  writeRawPolicy('{ this is not json');
  assert.throws(
    () => runtime.withVaultPrincipal(['builder'], () => runtime.getSecret('stripe_secret_key')),
    error => {
      assert.strictEqual(error.code, UNREADABLE_CODE);
      assert.strictEqual(error.message, UNREADABLE_TEXT);
      return true;
    }
  );
});

test('an unreadable policy still does not reach the installation own reads', () => {
  /* A corrupted policy file must not be able to stop this product signing
     itself in. Fail-closed applies to a read that NAMES a principal, and only
     to that. */
  writeRawPolicy('{ this is not json');
  const code = refusalCodeOf(() => runtime.getSecret('stripe_secret_key'));
  assert.notStrictEqual(code, UNREADABLE_CODE);
  assert.notStrictEqual(code, DENIED_CODE);
  assert.strictEqual(code, 'SECRET_NOT_CONFIGURED');
});

test('one denied key refuses a whole batched read', () => {
  /* Returning the allowed subset silently is how a caller ends up using a
     credential it was not given while believing it got everything it asked
     for. readSecretsFromVault does not route through readSecretFromVault, so
     it carries the decision in its own right. */
  writePolicy({ github_token: { access: { builder: false } } });
  assert.throws(
    () => runtime.withVaultPrincipal(['builder'],
      () => runtime.readSecretsFromVault(['stripe_secret_key', 'github_token'])),
    error => {
      assert.strictEqual(error.code, DENIED_CODE);
      assert.strictEqual(error.message, DENIED_TEXT);
      return true;
    }
  );
});

test('the policy file this engine reads is the one the desktop app writes', () => {
  /* The two repositories never share a module, only this path and these bytes.
     A change to either side that moved the file or renamed a field would leave
     the owner's switches silently unenforced again, which is the exact defect
     this whole file exists to close -- so the shared shape is pinned from here
     as well as from the app's own suite. */
  assert.strictEqual(
    policyModule.policyFilePath('C:\\root'),
    path.join('C:\\root', 'state', 'vault-access-policy.json')
  );
  const read = policyModule.readPolicy(STATE_ROOT, { file: POLICY_FILE });
  assert.strictEqual(read.readable, true);
  assert.strictEqual(read.code, 'VAULT_POLICY_ABSENT');
  writePolicy({ stripe_secret_key: { access: { builder: false } } });
  const ruled = policyModule.readPolicy(STATE_ROOT, { file: POLICY_FILE });
  assert.strictEqual(ruled.readable, true);
  assert.strictEqual(policyModule.mayRead(ruled, 'stripe_secret_key', ['builder']).allowed, false);
  assert.strictEqual(policyModule.mayRead(ruled, 'stripe_secret_key', ['reviewer']).allowed, true);
  /* A non-boolean in the decision position is a malformed file, and reading it
     as consent would invent a decision the owner never made. */
  writePolicy({ stripe_secret_key: { access: { builder: 'false' } } });
  const malformed = policyModule.readPolicy(STATE_ROOT, { file: POLICY_FILE });
  assert.strictEqual(malformed.readable, true);
  assert.strictEqual(malformed.policy.records.stripe_secret_key.access.builder, undefined);
});
