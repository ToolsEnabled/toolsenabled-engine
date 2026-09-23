// NOTHING FOUND
//
// testcanfail-tests-secrets-vault-path-agreement-js
//
// MUTATION REPORT (2026-08-26)
//
// No assertion needed strengthening. The two runnable JavaScript contracts
// both failed when their respective production decisions were mutated, and
// both passed again after the production files were restored byte-for-byte.
//
// * Mutation: src/lib/runtime.js::vaultFilePath returned
//   <repo>/mutated-wrong-vault.json. RED output:
//     FAIL runtime.js resolves the vault under the configured state root:
//     runtime.js must resolve <stateRoot>/vault/secrets.json
//     + actual - expected
//     + '/workspace/engine/mutated-wrong-vault.json'
//     - '/tmp/toolsenabled-vault-agreement-Pitmbw/state-root/vault/secrets.json'
// * Mutation: src/lib/secret-store/powershell.js published
//   <repo>/mutated-wrong-vault.json. RED output:
//     FAIL loading the secret store publishes that same path to its child process:
//     the secret store must not name a vault beside the program directory
//     + actual - expected
//     + '/workspace/engine/mutated-wrong-vault.json'
//     - '/tmp/toolsenabled-vault-agreement-YEtRjw/state-root/vault/secrets.json'
//
// Restoration evidence: git hash-object returned the original object IDs
// 98cef3e50dbdea8637732af9a3b815584573a8c2 for runtime.js and
// 4e1ac8ef054c2fd25f028930bfa60e886766938a for powershell.js. On the restored
// files the rerun printed:
//     PASS runtime.js resolves the vault under the configured state root
//     PASS loading the secret store publishes that same path to its child process
//
// UNMET PRECONDITION: powershell.exe is not installed or resolvable in this
// Linux environment. Consequently the three PowerShell integration checks
// could not be mutation-tested or produce a wholly green file-level rerun;
// each spawn returned status null and the existing assert.equal(status, 0)
// correctly failed rather than silently skipping. The exact baseline output
// for each was "null !== 0" and the file summary was "2 passed, 3 failed".
//
// Shape census:
// * EMPTY LOOP / forEach: NOT-FOUND. The fixture-copy loop has a literal,
//   nonempty input and contains no assertion; inventory assertions compare the
//   complete mapped array with an explicit nonempty expected array.
// * EXIT STATUS / truthy return backed only by subject output: NOT-FOUND. Every
//   successful child must have status exactly 0; spawn/load failure status null
//   and nonzero subject failures are rejected. Output is then checked
//   independently where it is contract evidence.
// * SWALLOWING try/catch / optional chain: NOT-FOUND. check() records caught
//   failures and the final failures.length branch exits 1. Optional access is
//   used only while formatting diagnostics.
// * MOCK OF SUBJECT: NOT-FOUND. Tests load repository modules directly and copy
//   the real PowerShell scripts plus their load-time dependencies.
// * SKIP / PRECONDITION GUARD: NOT-FOUND. In particular, missing PowerShell is
//   a loud failure on this platform, as the baseline run demonstrates.
// * EXPECTED VALUE COMPUTED BY SAME CODE: NOT-FOUND. Expected vault paths are
//   independently assembled from the test's fresh scratch root; canary names
//   and booleans are literal expectations.

'use strict';

// ONE COMPUTER, ONE VAULT -- OR THE CREDENTIAL THE PERSON JUST TYPED IS GONE.
//
// THE FAILURE THIS PINS. src/lib/runtime.js resolves the vault through
// runtime-state-root.js, so on an installed payload it is
// %APPDATA%\ToolsEnabled\capability\vault\secrets.json. tools/secrets.ps1
// agrees, because runtime.js publishes TOOLSENABLED_VAULT_PATH into every spawn
// and because the script carries its own TOOLSENABLED_STATE_ROOT branch as a
// safety net for a hand-run invocation.
//
// tools/secrets-manager.ps1 -- the lifecycle half, behind src/lib/secret-store/
// and `node tools/secret-doctor.js` -- had NEITHER. It read only
// TOOLSENABLED_VAULT_PATH and otherwise fell back to <programDir>/vault/
// secrets.json. And src/lib/secret-store/powershell.js never requires runtime,
// so in a process that loads only the secret store, the publisher that would
// have set TOOLSENABLED_VAULT_PATH never runs. Measured before the fix, with
// TOOLSENABLED_STATE_ROOT set and TOOLSENABLED_VAULT_PATH unset:
//
//   runtime.js        -> <stateRoot>\vault\secrets.json
//   secret-store      -> <programDir>\vault\secrets.json
//
// Two different files. What a person sees is the credential doctor reporting
// every integration "not configured" while the credentials are sitting in the
// vault they just filled in -- the split vault runtime.js documents at length,
// reintroduced through the one door that did not have the seam.
//
// WHY THE FALLBACK IS THE DANGEROUS DIRECTION. It does not fail loudly. It
// silently opens, and DECRYPT-TESTS, whatever vault happens to sit next to the
// program directory. That is why the second half of this suite is hermetic: the
// script under test is copied into a scratch tree, so if the state-root branch
// regresses, the fallback lands on a scratch path and this file fails -- it can
// never reach into a real vault to do it.
//
// NOTHING HERE TOUCHES A REAL VAULT. Every path below is under a fresh mkdtemp
// root, the only value ever stored is the string 'canary-not-a-secret-7412',
// and the repository's own vault/ is never named, read, or written.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const CANARY = 'canary-not-a-secret-7412';
const CANARY_KEY = 'github_token';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error && error.message}`);
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-vault-agreement-'));
function removeScratch() {
  const resolved = path.resolve(scratch);
  const tempRoot = path.resolve(os.tmpdir());
  assert.ok(resolved.startsWith(`${tempRoot}${path.sep}`),
    'refusing to clean a vault-agreement fixture outside the temporary directory');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// This also covers an assertion or child-process failure before normal cleanup.
process.once('exit', removeScratch);

// The state root a packaged install would hand every helper program.
const stateRoot = path.join(scratch, 'state-root');
const stateVault = path.join(stateRoot, 'vault', 'secrets.json');
fs.mkdirSync(path.dirname(stateVault), { recursive: true });

// CANONICAL, NOT A SPELLING.
//
// src/lib/account-profile-boundary.js now expands TOOLSENABLED_STATE_ROOT
// through the filesystem before runtime-state-root.js uses it ("An 8.3 short
// name is the same account, spelled shorter") -- assertAccountProfilePath
// always returns fs.realpathSync.native() of the configured root, never the
// alias it was handed. On a machine where %TEMP% itself is handed out under
// an 8.3 short alias of the owner's profile folder, `stateVault` above -- a
// plain path.join off os.tmpdir() -- names the same file the product resolves
// but does not SPELL it the same way. MEASURED: runtime.js answered the
// expanded (long) form of the path while `stateVault` held the 8.3-alias
// form -- two spellings of one file, asserted equal as strings.
//
// tests/claude-confined-home.test.js and tests/multi-account-rotation.test.js
// were corrected, in the same commit, to compare locations rather than
// spellings for exactly this reason; this file names the vault the same way
// runtime.js does -- state.root, then the literal 'vault' and 'secrets.json'
// segments -- so a divergence here is measured against the real construction,
// not reimplemented.
const stateVaultCanonical = path.join(fs.realpathSync.native(stateRoot), 'vault', 'secrets.json');

// SEAL IT AGAINST ADOPTION FIRST, AND THIS IS NOT OPTIONAL.
//
// runtime-state-root.js migrates a checkout onto a new state root the first
// time one is configured: stateRootRecord() calls adoptLegacyPayloadState(),
// which copies vault/, state/, logs/, reports/, captures/ and profiles/ out of
// the program root. That is exactly right for a person's real upgrade and
// exactly wrong here -- without this, every run of this suite would clone the
// checkout's real vault into a temp directory, and the assertion below would
// then read the copy and "pass" while measuring nothing.
//
// The adoption record is the documented way to say the decision was already
// made: a state root whose record lists every directory has nothing
// outstanding, so the copy is skipped ('already-decided'). Written through the
// module's own constants so a change to either travels here.
const { ADOPTION_RECORD, ADOPTION_RECORD_VERSION, RUNTIME_STATE_DIRECTORIES } =
  require('../../src/lib/runtime-state-root');
fs.writeFileSync(path.join(stateRoot, ADOPTION_RECORD), `${JSON.stringify({
  version: ADOPTION_RECORD_VERSION,
  from: REPO,
  at: new Date().toISOString(),
  adopted: [...RUNTIME_STATE_DIRECTORIES].sort(),
  pending: []
}, null, 2)}\n`, 'utf8');

// STATE_ROOT set, VAULT_PATH deliberately absent: the exact condition in which
// the two halves disagreed.
function stateRootOnlyEnv(extra = {}) {
  const environment = { ...process.env, TOOLSENABLED_STATE_ROOT: stateRoot, ...extra };
  delete environment.TOOLSENABLED_VAULT_PATH;
  return environment;
}

function node(source, environment) {
  const file = path.join(scratch, `probe-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, source);
  const result = spawnSync(process.execPath, [file], {
    cwd: REPO, env: environment, encoding: 'utf8', windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`probe exited ${result.status}: ${String(result.stderr || '').slice(0, 400)}`);
  }
  return String(result.stdout || '').trim();
}

// ---------------------------------------------------------------------------
// 1. The two JavaScript halves must name the same file.
// ---------------------------------------------------------------------------

check('runtime.js resolves the vault under the configured state root', () => {
  const answer = node(
    `console.log(require(${JSON.stringify(path.join(REPO, 'src/lib/runtime.js'))}).vaultFilePath());`,
    stateRootOnlyEnv()
  );
  assert.equal(path.resolve(answer), path.resolve(stateVaultCanonical),
    'runtime.js must resolve <stateRoot>/vault/secrets.json');
});

check('loading the secret store publishes that same path to its child process', () => {
  // The seam that removes the ambiguity entirely, and the one that was missing.
  // The decision stays in JavaScript, in one place, and is COMMUNICATED to the
  // script rather than rederived by it -- exactly the rule src/lib/runtime.js
  // already follows for tools/secrets.ps1. Asserted on the environment the
  // secret store actually leaves behind, not on a rule restated here, because a
  // test that reimplements the resolution proves only its own arithmetic.
  const answer = node(
    `require(${JSON.stringify(path.join(REPO, 'src/lib/secret-store/index.js'))});`
    + `console.log(process.env.TOOLSENABLED_VAULT_PATH || '<unset>');`,
    stateRootOnlyEnv()
  );
  assert.notEqual(answer, '<unset>',
    'requiring the secret store must publish TOOLSENABLED_VAULT_PATH, as runtime.js does');
  assert.equal(path.resolve(answer), path.resolve(stateVaultCanonical),
    'the secret store must not name a vault beside the program directory');
});

// ---------------------------------------------------------------------------
// 2. The PowerShell half, hermetically. The script is copied into a scratch
//    tree, so its <repoRoot>/vault fallback -- if the state-root branch is
//    ever removed again -- lands on a scratch path and fails this test rather
//    than opening a real vault to pass it.
// ---------------------------------------------------------------------------

const fakeRepo = path.join(scratch, 'program-dir');
fs.mkdirSync(path.join(fakeRepo, 'tools', 'lib'), { recursive: true });
for (const relative of [
  path.join('tools', 'secrets.ps1'),
  path.join('tools', 'secrets-manager.ps1'),
  path.join('tools', 'lib', 'vault-acl.ps1'),
  // Dot-sourced by secrets.ps1 for the interactive prompts, and since
  // 2026-09-03 only for the two verbs that can open a window -- loading a GUI
  // stack cost every read verb ~275 ms. None of the verbs exercised here reach
  // it, but the copy stays complete so that a regression which restores the
  // unconditional load fails on the thing it broke rather than on a missing
  // file, which would look like the path bug this suite exists to measure.
  path.join('tools', 'owner-prompt-theme.ps1')
]) {
  fs.copyFileSync(path.join(REPO, relative), path.join(fakeRepo, relative));
}

function powershell(script, args, environment, input) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(fakeRepo, 'tools', script), ...args
  ], { env: environment, input, encoding: 'utf8', windowsHide: true, shell: false });
}

check('the canary lands in the state-root vault, not beside the program', () => {
  const stored = powershell('secrets.ps1', ['set-stdin', CANARY_KEY], stateRootOnlyEnv(), CANARY);
  assert.equal(stored.status, 0, `set-stdin failed: ${String(stored.stderr || '').slice(0, 300)}`);
  assert.ok(fs.existsSync(stateVault), 'the state-root vault file must exist after a write');
  assert.ok(!fs.existsSync(path.join(fakeRepo, 'vault', 'secrets.json')),
    'nothing may be written beside the program directory when a state root is configured');
});

check('the lifecycle half reads the very vault the write half wrote', () => {
  const result = powershell('secrets-manager.ps1', ['inventory'], stateRootOnlyEnv());
  assert.equal(result.status, 0, `inventory failed: ${String(result.stderr || '').slice(0, 300)}`);
  const payload = JSON.parse(result.stdout);
  const names = payload.secrets.map(entry => entry.name);
  assert.deepEqual(names, [CANARY_KEY],
    `the lifecycle half must see exactly the state-root vault; it saw ${JSON.stringify(names)}`);
  const entry = payload.secrets[0];
  assert.equal(entry.present, true);
  assert.equal(entry.readable, true, 'the record written moments ago must decrypt');
});

check('an explicit vault path still wins over the state root', () => {
  // The precedence tools/secrets.ps1 documents must survive the new branch:
  // TOOLSENABLED_VAULT_PATH first, state root only as the net beneath it.
  const explicit = path.join(scratch, 'explicit', 'secrets.json');
  fs.mkdirSync(path.dirname(explicit), { recursive: true });
  const environment = stateRootOnlyEnv();
  environment.TOOLSENABLED_VAULT_PATH = explicit;
  const stored = powershell('secrets.ps1', ['set-stdin', 'canary_explicit'], environment, CANARY);
  assert.equal(stored.status, 0, `set-stdin failed: ${String(stored.stderr || '').slice(0, 300)}`);
  const result = powershell('secrets-manager.ps1', ['inventory'], environment);
  assert.equal(result.status, 0);
  const names = JSON.parse(result.stdout).secrets.map(entry => entry.name);
  assert.deepEqual(names, ['canary_explicit'],
    'an explicitly configured vault path must take precedence over the state root');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error && failure.error.message}`);
  process.exit(1);
}

removeScratch();
process.removeListener('exit', removeScratch);
