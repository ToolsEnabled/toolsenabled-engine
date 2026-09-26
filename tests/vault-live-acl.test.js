'EXECUTABLE CHANGE';
'use strict';

// TEST-CAN-FAIL REPORT (testcanfail-tests-vault-live-acl-test-js)
//
// The Windows precondition formerly returned before the platform-independent
// rescue-fence assertions ran, making the entire file green without executing
// an assertion on non-Windows hosts. The executable change below confines that
// precondition to the live-DACL check and always exercises the rescue fence.
//
// Mutation: in a scratch copy only, credentialMaterialReason() was changed to
// return null for every path. After this change, the strengthened test was RED:
//   AssertionError [ERR_ASSERTION]: the rescue copied credential material: vault/secrets.json
//   true !== false
// The scratch mutation was removed. The restored checkout then printed:
//   vault live ACL test skipped: Windows-only ACL semantics
//   rescue fence: 10 credential paths refused
//   vault live acl tests passed
//
// NOT-FOUND: an empty assertion loop (both fixed lists are non-empty, and the
// live probe explicitly asserts its dynamic collections are populated).
// NOT-FOUND: exit-status/truthy-return-only evidence.
// NOT-FOUND: swallowed failures through try/catch or optional chaining.
// NOT-FOUND: an assertion against a mock of the credential classifier under test
// (fsImpl only prevents the behavioural test from writing outside the checkout).
// NOT-FOUND after this change: a whole-file skip or silent precondition guard.
// NOT-FOUND: an expected value computed by the same code being checked.
// PRECONDITIONS NOT MET: Windows and powershell.exe are unavailable on this
// Linux host, so the live Windows DACL branch could not be mutation-tested here;
// BUILD-QUEUE.md is absent from this checkout, so the Windows-only positive-copy
// fixtures also cannot run on this host (their existing assertion is preserved).

// Regression guard for two things that had none, both measured on 2026-08-11.
//
// (1) THE PRODUCT VAULT DACL. vault/ and its children were narrowed that night so
//     the Codex sandbox accounts can no longer read, replace or delete the
//     credential store. Nothing checked that it stays that way:
//     tools/secret-doctor.js checks inventory and decryptability only, and
//     every vault-hardening suite points TOOLSENABLED_VAULT_PATH at an mkdtemp
//     directory (tests/kernel.audit/vault-hardening.js:14). This test supplies
//     the real ACL hardener and probe with a disposable repository fixture that
//     has both sides of the contract. It never reads an operator vault.
//
// (2) THE FLEET RESCUE FENCE. src/lib/fleet-supervisor/worktree.js
//     #copyRepoFileIntoWorktree used to copy any repo-relative file a phase
//     named in backticks into a lane worktree, with no credential check --
//     measured, it copied vault/secrets.json and the 2.9 MB plaintext
//     vault/secrets.json.access.log. Lane worktrees are siblings of the repo
//     root under a directory carrying CodexSandboxUsers:(OI)(CI)(M), so that
//     relocated the credential store somewhere the sandbox group can modify.
//     This is asserted BEHAVIOURALLY -- the real function is called and the
//     refusal observed -- because an assertion that a guard exists in the
//     source cannot see a caller that stopped routing through it.
//
// ----------------------------------------------------------------------------
// THE REPO ROOT IS SUPPOSED TO BE LOOSER THAN THE VAULT. DO NOT "FIX" IT.
// ----------------------------------------------------------------------------
// tools/fra-root-access-control.ps1 DELIBERATELY grants CodexSandboxUsers
// Modify on the REPOSITORY ROOT with (OI)(CI), and tools/fra-root-access-
// probe.ps1 REQUIRES it there with an exact rule count. Removing that ACE from
// the root breaks Full Remote Access. Only vault/ was narrowed.
//
// So this test asserts BOTH directions on purpose: the sandbox ACE must be
// ABSENT from vault/ and PRESENT on the root. A test that only checked the
// vault could be "satisfied" by someone tightening the root, which would take
// FRA down while the suite stayed green.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'tools', 'vault-access-probe.ps1');
const VAULT_ACL = path.join(ROOT, 'tools', 'lib', 'vault-acl.ps1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function runProbe(repoRoot) {
  const result = spawnSync(POWERSHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', PROBE, '-RepoRoot', repoRoot
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const stdout = String(result.stdout || '').trim();
  assert.ok(stdout, `vault-access-probe.ps1 produced no stdout: ${result.stderr}`);
  // The raw string is kept, not just the parsed object: the only way to check
  // what the probe EMITTED is to look at what it emitted.
  return { status: result.status, raw: stdout, output: JSON.parse(stdout), stderr: result.stderr };
}

function createVaultAclFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-acl-product-fixture-'));
  const vaultDir = path.join(repoRoot, 'vault');
  const vaultFile = path.join(vaultDir, 'secrets.json');
  const setupScript = path.join(repoRoot, 'configure-fixture-acl.ps1');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(vaultFile, JSON.stringify({
    fixtureCiphertext: 'fixture-ciphertext-never-emit-8a5e3cd08bff4dc8'
  }), 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'secrets.json.access.log'), 'fixture access record\n', 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'secrets.json.lock'), '', 'utf8');
  fs.writeFileSync(setupScript, [
    '[CmdletBinding()]',
    'param([Parameter(Mandatory=$true)][string]$RepoRoot, [Parameter(Mandatory=$true)][string]$VaultAclScript)',
    "$ErrorActionPreference = 'Stop'",
    'Set-StrictMode -Version Latest',
    '$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
    "$sandboxSid = (New-Object Security.Principal.NTAccount($env:COMPUTERNAME, 'CodexSandboxUsers')).Translate([Security.Principal.SecurityIdentifier])",
    '$rootAcl = New-Object Security.AccessControl.DirectorySecurity',
    '$rootAcl.SetOwner($currentSid)',
    '$rootAcl.SetAccessRuleProtection($true, $false)',
    '$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit',
    '$none = [Security.AccessControl.PropagationFlags]::None',
    '$allow = [Security.AccessControl.AccessControlType]::Allow',
    "foreach ($sidValue in @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {",
    '  $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)',
    '  $rootAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $none, $allow)))',
    '}',
    '$rootAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sandboxSid, [Security.AccessControl.FileSystemRights]::Modify, $inheritance, $none, $allow)))',
    '[IO.Directory]::SetAccessControl($RepoRoot, $rootAcl)',
    '. $VaultAclScript',
    'Initialize-ProtectedVaultStore -Path (Join-Path $RepoRoot "vault")'
  ].join('\r\n'), 'utf8');
  const setup = spawnSync(POWERSHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', setupScript, '-RepoRoot', repoRoot, '-VaultAclScript', VAULT_ACL
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(setup.error, undefined, setup.error && setup.error.message);
  assert.equal(setup.status, 0, `could not configure disposable vault ACL fixture: ${setup.stderr}`);
  return { repoRoot, vaultFile };
}

function testDisposableVaultDacl() {
  assert.ok(fs.existsSync(PROBE), 'tools/vault-access-probe.ps1 is missing');
  assert.ok(fs.existsSync(VAULT_ACL), 'tools/lib/vault-acl.ps1 is missing');
  const fixture = createVaultAclFixture();
  try {
    const { status, raw, output } = runProbe(fixture.repoRoot);
    assert.equal(status, 0, `probe exited ${status}: ${output.code}`);
    assert.equal(output.valid, true, `probe reported invalid: ${output.code}`);

  /* `secretValuesEmitted` IS A LITERAL THE PROBE WRITES ABOUT ITSELF.
   *
   * The probe sets `secretValuesEmitted = $false` unconditionally, so asserting
   * it is `assert.equal(K, K)` -- inert under every possible change to what the
   * probe actually puts on stdout. MEASURED: adding a `leakedSecretSample` field
   * to the probe's output object left this suite green, with the extra field
   * riding out on the same stdout and the probe still declaring it had emitted no
   * secret values. runProbe() also threw the raw string away, so the payload was
   * not even reachable from the assertion site.
   *
   * Keep the self-declaration -- it is cheap -- but stop treating it as evidence.
   * Pin the SHAPE, so any field the probe did not have before fails here; then
   * pin the PAYLOAD against the fixture vault's own stored values. */
    assert.equal(output.secretValuesEmitted, false);
    assert.deepEqual(Object.keys(output).sort(), [
    'rootProtectedDacl', 'rootSandboxAceCount', 'sandboxGroup', 'sandboxGroupResolved',
    'schemaVersion', 'secretValuesEmitted', 'valid', 'vaultEntries', 'vaultEntryCount', 'vaultPresent'
  ], 'the probe emitted a top-level field this test has never seen; a new field is how secret material leaves');
    for (const entry of output.vaultEntries) {
      assert.deepEqual(Object.keys(entry).sort(), [
      'container', 'descriptorDigest', 'inheritedRuleCount', 'nonFullControlCount',
      'protectedDacl', 'relative', 'ruleCount', 'sandboxAceCount', 'unexpectedPrincipalCount'
    ], `vaultEntries[${entry.relative}] carries a field this test has never seen`);
  }

  /* The payload itself. Line 52 already established `raw` is non-empty, which is
   * the positive assertion on the same subject this negative stands on.
   * `values.length > 0` is not decorative: without it the loop below is itself
   * vacuous the moment the vault has no string entries, which is the same
   * absence-as-emptiness error one level down. No value is ever put in an
   * assertion message. */
    if (fs.existsSync(fixture.vaultFile)) {
      const stored = JSON.parse(fs.readFileSync(fixture.vaultFile, 'utf8'));
    const values = Object.values(stored).filter(value => typeof value === 'string' && value.length >= 16);
    assert.ok(values.length > 0, 'the vault holds no string entries, so the containment checks below prove nothing');
    for (const value of values) {
      assert.ok(!raw.includes(value), 'the probe emitted a stored vault value on stdout');
      assert.ok(!raw.includes(value.slice(0, 32)), 'the probe emitted a prefix of a stored vault value on stdout');
    }
  }

  // A guard that validates nothing passes for the wrong reason and looks
  // identical to one that is protecting something. Refuse to be that.
    assert.equal(output.sandboxGroupResolved, true,
    'the CodexSandboxUsers group did not resolve, so nothing was actually fenced against');
    assert.equal(output.vaultPresent, true, 'vault/ is absent from the disposable fixture');
  // 2026-08-23: the no-backup atomic replacement path deliberately removed
  // the fifth `.bak` artifact because it retained a complete encrypted copy of
  // the pre-removal vault. Pin the four durable paths by NAME instead of
  // weakening a stale count: four arbitrary entries must not satisfy this.
  const requiredVaultEntries = [
    'vault', 'vault/secrets.json', 'vault/secrets.json.access.log', 'vault/secrets.json.lock'
  ];
  const observedVaultEntries = new Set(output.vaultEntries.map(entry => entry.relative));
  for (const relative of requiredVaultEntries) {
      assert.ok(observedVaultEntries.has(relative), `the ACL probe did not check required path ${relative}`);
  }
  assert.ok(output.vaultEntryCount >= requiredVaultEntries.length,
    `expected at least ${requiredVaultEntries.length} durable vault paths, checked ${output.vaultEntryCount}`);

  // tools/vault-access-probe.ps1 (invoked above) already derives this same
  // principal from $env:COMPUTERNAME rather than a hardcoded machine name
  // (see its line 99); the remediation hint below now matches that so the
  // suggested command is the one that actually works on whichever machine
  // this test is running on, not just the original builder's.
  const sandboxPrincipal = `${process.env.COMPUTERNAME || '<COMPUTERNAME>'}\\CodexSandboxUsers`;
  for (const entry of output.vaultEntries) {
    assert.equal(entry.sandboxAceCount, 0,
      `a CodexSandboxUsers ACE has reappeared on ${entry.relative} -- the 2026-08-11 vault `
      + `hardening has regressed. Remove it with: icacls <path> /remove:g "${sandboxPrincipal}"`);
    assert.equal(entry.protectedDacl, true,
      `${entry.relative} no longer has a protected DACL, so it can inherit a sandbox ACE from the root`);
    assert.equal(entry.inheritedRuleCount, 0,
      `${entry.relative} has inherited ACEs; the vault must not inherit from the repo root`);
    assert.equal(entry.unexpectedPrincipalCount, 0,
      `${entry.relative} grants a principal other than SYSTEM, Administrators and the owner`);
    assert.equal(entry.nonFullControlCount, 0,
      `${entry.relative} has an allowed principal without FullControl`);
  }

  // The other half of the distinction. See the header: FRA needs this ACE.
  assert.equal(output.rootSandboxAceCount, 1,
    'the repository root has LOST its CodexSandboxUsers ACE. That ACE is deliberate -- '
    + 'tools/fra-root-access-probe.ps1 requires it and Full Remote Access breaks without it. '
    + 'Only vault/ is meant to be narrowed. Restore it with tools/fra-root-access-control.ps1.');

    console.log(`vault disposable ACL: ${output.vaultEntryCount} paths clean, root ACE intact`);
  } finally {
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
}

// Behavioural: call the real rescue and observe the refusal. The fsImpl is
// intercepted so that a REGRESSION in the fence cannot cause this test to
// actually relocate the credential store while proving that it did.
function testRescueFenceRefusesCredentialMaterial({ checkAllowances = true } = {}) {
  const worktrees = require('../src/lib/fleet-supervisor/worktree.js');
  const attempted = [];
  const fsImpl = {
    lstatSync: p => fs.lstatSync(p),
    statSync: p => fs.statSync(p),
    existsSync: p => fs.existsSync(p),
    mkdirSync: () => undefined,
    copyFileSync: (src, dest) => { attempted.push({ src, dest }); }
  };
  const worktree = path.join(path.dirname(ROOT), 'ToolsEnabled-fleet-lane-acltest');

  const mustRefuse = [
    'vault/secrets.json',
    'vault/secrets.json.access.log',
    'vault/secrets.json.lock',
    'state/mission-bridge-token.json',
    '.env',
    'config/id_rsa',
    'certs/server.pem',
    // Case and traversal must not get around it: on Windows these open the
    // very same files as the entries above.
    'VAULT/SECRETS.JSON',
    'docs/../vault/secrets.json',
    'vault\\secrets.json'
  ];
  for (const relative of mustRefuse) {
    attempted.length = 0;
    const result = worktrees.copyRepoFileIntoWorktree(relative, {
      repoRoot: ROOT, worktree, fsImpl
    });
    assert.equal(result.copied, false, `the rescue copied credential material: ${relative}`);
    assert.equal(result.fenced, true, `${relative} was refused, but not by the credential fence`);
    assert.match(result.reason, /^credential-material-fenced: /);
    assert.equal(attempted.length, 0, `copyFileSync was invoked for ${relative}`);
  }

  if (!checkAllowances) {
    console.log(`rescue fence: ${mustRefuse.length} credential paths refused`);
    return;
  }

  // The fence must not swallow the rescue's actual purpose. These are ordinary
  // files -- including source and tests ABOUT credentials, which are not
  // credential material -- and a lane may legitimately be briefed on them.
  //
  // EVERY ROW MUST BE A TRACKED PATH. The first row used to name BUILD-QUEUE.md,
  // an untracked local working file: `git log --all -- BUILD-QUEUE.md` is empty,
  // so it has never been in this repository and was absent from every checkout,
  // including the author's own once it was cleaned up. The existsSync below is a
  // hard throw inside this loop, so from the row's first day it aborted the whole
  // function -- measured 2026-08-25 on a clean checkout: the ten mustRefuse paths
  // pass, then `fixture missing: BUILD-QUEUE.md` kills the run before a single
  // positive case executes and before the three credentialMaterialReason
  // assertions below. This suite is the sixth entry in tests/suites/root-suite.txt,
  // the first --from list of the root `npm test` chain, so the whole chain stopped
  // there too. Present-on-one-machine is not a fixture; only tracked is.
  const mustStillCopy = [
    'README.md',
    'tests/kernel.audit/vault-hardening.js',
    'tools/vault-access-probe.ps1',
    'src/lib/fra-workspace-policy.js',
    'package.json'
  ];
  for (const relative of mustStillCopy) {
    assert.ok(fs.existsSync(path.join(ROOT, relative)), `fixture missing: ${relative}`);
    attempted.length = 0;
    const result = worktrees.copyRepoFileIntoWorktree(relative, {
      repoRoot: ROOT, worktree, fsImpl
    });
    assert.equal(result.copied, true,
      `the fence broke a legitimate rescue: ${relative} (${result.reason})`);
    assert.equal(attempted.length, 1);
  }

  // .env.example is documentation, not a credential. fra-workspace-policy
  // allows it and the fence must inherit that allowance rather than
  // reimplement a stricter ".env*" rule.
  assert.equal(worktrees.credentialMaterialReason('.env.example', ROOT), null);
  assert.equal(worktrees.credentialMaterialReason('docs/.env.template', ROOT), null);
  assert.ok(worktrees.credentialMaterialReason('.env.production', ROOT));

  console.log(`rescue fence: ${mustRefuse.length} refused, ${mustStillCopy.length} still copied`);
}

function main() {
  if (process.platform !== 'win32') {
    console.log('vault ACL subprocess test skipped: Windows-only ACL semantics');
    testRescueFenceRefusesCredentialMaterial({ checkAllowances: false });
  } else {
    testDisposableVaultDacl();
    testRescueFenceRefusesCredentialMaterial();
  }
  console.log('vault ACL tests passed');
}

main();
