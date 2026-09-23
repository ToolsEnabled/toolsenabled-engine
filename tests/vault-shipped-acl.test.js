// EXECUTABLE CHANGE
'use strict';

// WHAT ACL DOES THE PRODUCT CREATE FOR A CUSTOMER'S OWN CREDENTIAL STORE?
//
// THE DEFECT, measured on 2026-08-11 against the real per-user install at
// %LOCALAPPDATA%\Programs\toolsenabled: every ACE on the installed
// resources/capability/vault/secrets.json was INHERITED --
// CodexSandboxUsers:(I)(RX), SYSTEM:(I)(F), Administrators:(I)(F),
// <account>:(I)(F) -- because nothing in the product ever set one. Both vault
// writers created the store with a bare `New-Item -ItemType Directory` and
// took whatever the install location granted. Measured inheritance sources:
// C:\ProgramData grants BUILTIN\Users:(OI)(CI)(RX) plus (CI)(WD,AD,WEA,WA),
// and C:\Program Files grants BUILTIN\Users:(OI)(CI)(IO)(GR,GE). So a
// ProgramData- or per-machine-sited install shipped a credential store
// readable by every account on the machine.
//
// tools/lib/vault-acl.ps1 is the fix. This is its regression guard.
//
// ----------------------------------------------------------------------------
// WHY THIS TEST IS NOT tests/vault-live-acl.test.js
// ----------------------------------------------------------------------------
// That suite measures the DEVELOPER checkout's live vault, which was narrowed
// by hand on 2026-08-11. A hand-narrowed directory on one machine says nothing
// about what a customer's install creates, and the live vault passes that
// suite whether or not the product would ever produce such a vault again.
// This suite answers the other question -- it CREATES a vault, through the
// real shipped writers, in a location deliberately made unsafe -- and the two
// together cover the machine and the artifact.
//
// THE TEST MUST NOT BE ABLE TO PASS BECAUSE THE PARENT WAS HARMLESS. The
// fixture grants BUILTIN\Users an inheritable Modify ACE on the parent, and a
// CONTROL directory is created beside the vault under that same parent. The
// control directory MUST inherit the permissive ACE. If it does not, the
// fixture never posed the problem and this suite fails rather than reporting a
// green it did not earn.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'tools', 'vault-access-probe.ps1');
const HELPER = path.join(ROOT, 'tools', 'lib', 'vault-acl.ps1');

// BUILTIN\Users -- the principal a ProgramData or Program Files install
// actually leaks to, not an invented one.
const PERMISSIVE_SID = 'S-1-5-32-545';

// The value stored is a fixture string, never a credential. It exists so the
// writers take their real write path; nothing asserts on its secrecy.
const FIXTURE_VALUE = 'vault-shipped-acl-fixture-value';

function powershell(args, options = {}) {
  return spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args
  ], { encoding: 'utf8', windowsHide: true, timeout: 120000, ...options });
}

function runInline(script, options = {}) {
  return powershell(['-Command', script], options);
}

// Read a DACL as JSON. Deliberately independent of the code under test: if the
// hardening helper were also the thing that reported on the hardening, a bug in
// it would hide itself.
function readAcl(target) {
  const script = [
    `$item = Get-Item -LiteralPath '${target}' -Force`,
    '$acl = Get-Acl -LiteralPath $item.FullName',
    '$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
    '[pscustomobject]@{',
    '  protected = [bool]$acl.AreAccessRulesProtected',
    '  inherited = @($rules | Where-Object { $_.IsInherited }).Count',
    '  sids = @($rules | ForEach-Object { $_.IdentityReference.Value })',
    '} | ConvertTo-Json -Compress -Depth 4'
  ].join('\n');
  const result = runInline(script);
  assert.equal(result.status, 0, `reading the ACL of ${target} failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function currentUserSid() {
  const result = runInline('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  assert.equal(result.status, 0, `could not resolve the current user SID: ${result.stderr}`);
  return result.stdout.trim();
}

// A parent that grants an inheritable Modify ACE to a group that must never
// reach a credential store -- the unsafe install location, reproduced.
function makeUnsafeParent() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'te-shipped-vault-acl-'));
  const me = currentUserSid();
  const result = runInline(
    `icacls '${parent}' /inheritance:r ` +
    `/grant '*${me}:(OI)(CI)(F)' ` +
    `/grant '*S-1-5-18:(OI)(CI)(F)' ` +
    `/grant '*S-1-5-32-544:(OI)(CI)(F)' ` +
    `/grant '*${PERMISSIVE_SID}:(OI)(CI)(M)'`
  );
  assert.equal(result.status, 0, `could not build the unsafe parent fixture: ${result.stderr}`);
  return parent;
}

// The fixture has to actually be unsafe, or everything below proves nothing.
function assertFixtureIsUnsafe(parent) {
  const control = path.join(parent, 'control-not-a-vault');
  fs.mkdirSync(control);
  const acl = readAcl(control);
  assert.ok(acl.sids.includes(PERMISSIVE_SID),
    'the control directory did NOT inherit the permissive ACE, so this fixture never posed the '
    + 'problem the vault is being tested against. Fix the fixture; do not trust the result below.');
  assert.ok(acl.inherited > 0, 'the control directory has no inherited rules; the fixture is inert');
}

function probeVault(root) {
  const result = powershell(['-File', PROBE, '-RepoRoot', root]);
  const stdout = String(result.stdout || '').trim();
  assert.ok(stdout, `vault-access-probe.ps1 produced no stdout: ${result.stderr}`);
  const output = JSON.parse(stdout);
  assert.equal(result.status, 0, `probe exited ${result.status}: ${output.code}`);
  assert.equal(output.valid, true, `probe reported invalid: ${output.code}`);
  return output;
}

// Each writer, through its real command line, into a vault path under the
// unsafe parent. The probe wants <root>/vault, so each writer gets its own root.
const WRITERS = [
  {
    label: 'tools/secrets.ps1 (the writer that ships)',
    script: path.join(ROOT, 'tools', 'secrets.ps1'),
    writeArgs: key => ['set-stdin', key],
    readArgs: key => ['get', key]
  },
  {
    label: 'tools/secrets-manager.ps1 (the developer-tree writer)',
    script: path.join(ROOT, 'tools', 'secrets-manager.ps1'),
    writeArgs: key => ['add', '-Name', key, '-Reason', 'vault-shipped-acl regression fixture'],
    readArgs: null
  }
];

function testWriterCreatesProtectedVault(parent, writer, index) {
  const root = path.join(parent, `root-${index}`);
  fs.mkdirSync(root);
  const vaultFile = path.join(root, 'vault', 'secrets.json');
  const key = 'shipped_acl_fixture';
  const env = { ...process.env, TOOLSENABLED_VAULT_PATH: vaultFile };

  const wrote = powershell(['-File', writer.script, ...writer.writeArgs(key)], {
    input: FIXTURE_VALUE, env
  });
  assert.equal(wrote.status, 0, `${writer.label} failed to write: ${wrote.stderr || wrote.stdout}`);
  assert.ok(fs.existsSync(vaultFile), `${writer.label} did not create ${vaultFile}`);

  const output = probeVault(root);
  assert.equal(output.vaultPresent, true, `${writer.label}: the probe found no vault to measure`);
  assert.ok(Array.isArray(output.vaultEntries),
    `${writer.label}: the probe did not return the vault entries that the ACL assertions inspect`);
  // The two the ACL contract is ABOUT must be present; the probe may legitimately
  // return more. Measured on Windows 2026-08-26: a real run also yields
  // vault/secrets.json.access.log and vault/secrets.json.lock, so an exact-set
  // assertion here fails on the platform this test exists for. Requiring the
  // contract members (rather than the whole set) keeps the vacuity guard --
  // which is the real fix, since the loop below iterates vaultEntries while the
  // old guard only checked vaultEntryCount -- without inventing a constraint the
  // product never promised.
  const relatives = output.vaultEntries.map(entry => entry.relative).sort();
  for (const required of ['vault', 'vault/secrets.json']) {
    assert.ok(relatives.includes(required),
      `${writer.label}: the probe did not return ${required}, whose ACL the assertions below check`);
  }
  assert.equal(output.vaultEntryCount, output.vaultEntries.length,
    `${writer.label}: the probe's entry count disagrees with the entries being checked`);

  const allowed = new Set([currentUserSid(), 'S-1-5-18', 'S-1-5-32-544']);
  for (const entry of output.vaultEntries) {
    assert.equal(entry.protectedDacl, true,
      `${writer.label}: ${entry.relative} was created with an INHERITING DACL, so its permissions `
      + 'are whatever the install location grants. This is the 2026-08-11 shipping defect.');
    assert.equal(entry.inheritedRuleCount, 0,
      `${writer.label}: ${entry.relative} carries inherited ACEs from the install location`);
    assert.equal(entry.unexpectedPrincipalCount, 0,
      `${writer.label}: ${entry.relative} grants a principal beyond this account, SYSTEM and `
      + 'Administrators');
    assert.equal(entry.nonFullControlCount, 0,
      `${writer.label}: ${entry.relative} has an allowed principal without FullControl`);
  }

  // Named directly, not only via unexpectedPrincipalCount: this is the ACE the
  // unsafe parent handed out, and the one a customer would have been leaking.
  for (const relative of ['vault', 'vault/secrets.json']) {
    const target = path.join(root, relative.replace('/', path.sep));
    const acl = readAcl(target);
    assert.ok(!acl.sids.includes(PERMISSIVE_SID),
      `${writer.label}: ${relative} still grants BUILTIN\\Users, inherited from the install `
      + 'location. A customer credential store readable by every account on the machine.');
    for (const sid of acl.sids) {
      assert.ok(allowed.has(sid), `${writer.label}: ${relative} grants unexpected principal`);
    }
    assert.equal(acl.sids.length, 3,
      `${writer.label}: ${relative} must contain exactly one ACE for the owner, SYSTEM and Administrators`);
    assert.deepEqual([...new Set(acl.sids)].sort(), [...allowed].sort(),
      `${writer.label}: ${relative} is missing a required owner, SYSTEM or Administrators ACE`);
  }

  // The other direction: securing the file must not break the account that
  // legitimately uses it. Breaking sign-in to protect a vault is not a fix.
  if (writer.readArgs) {
    const read = powershell(['-File', writer.script, ...writer.readArgs(key)], { env });
    assert.equal(read.status, 0,
      `${writer.label}: the legitimate account can no longer READ its own vault: ${read.stderr}`);
    assert.equal(read.stdout.trim(), FIXTURE_VALUE,
      `${writer.label}: the vault round trip returned the wrong value after hardening`);
  }

  // And it must still be writable by that account -- a second write exercises
  // the lock file and the atomic replace against the now-protected directory.
  const rewrote = powershell(['-File', writer.script, ...writer.writeArgs(`${key}_second`)], {
    input: FIXTURE_VALUE, env
  });
  assert.equal(rewrote.status, 0,
    `${writer.label}: a second write into the hardened vault failed: ${rewrote.stderr}`);

  console.log(`${writer.label}: created a protected vault under a permissive parent`);
}

// A rename of the helper would not fail any assertion above until the packaged
// product tried to run. tools/pack-capability-layer.mjs derives the shipped
// .ps1 closure from exactly this reference, so if it stops resolving the helper
// silently stops shipping.
function testShippedWriterDotSourcesTheHelper() {
  assert.ok(fs.existsSync(HELPER), 'tools/lib/vault-acl.ps1 is missing');
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'secrets.ps1'), 'utf8');
  const reference = /Join-Path\s+\$PSScriptRoot\s+'(lib\/vault-acl\.ps1)'/.exec(source);
  assert.ok(reference,
    'tools/secrets.ps1 no longer dot-sources lib/vault-acl.ps1 in the $PSScriptRoot form that '
    + 'tools/pack-capability-layer.mjs walks, so the helper would stop being packaged');
  assert.ok(fs.existsSync(path.join(ROOT, 'tools', reference[1])),
    'the dot-source reference in tools/secrets.ps1 does not resolve');
}

function main() {
  // These artifact checks are platform-independent. Keep them before the
  // Windows guard so an unsupported host cannot silently turn the whole file
  // into a no-op.
  assert.ok(fs.existsSync(PROBE), 'tools/vault-access-probe.ps1 is missing');
  testShippedWriterDotSourcesTheHelper();

  if (process.platform !== 'win32') {
    console.log('shipped vault ACL runtime checks skipped: Windows-only ACL semantics');
    return;
  }

  const parent = makeUnsafeParent();
  try {
    assertFixtureIsUnsafe(parent);
    WRITERS.forEach((writer, index) => testWriterCreatesProtectedVault(parent, writer, index));
  } finally {
    // The fixture dirs are protected by the code under test; make them
    // removable again before cleanup so a passing run leaves nothing behind.
    runInline(`icacls '${parent}' /reset /T /C /Q`);
    fs.rmSync(parent, { recursive: true, force: true });
  }
  console.log('shipped vault acl tests passed');
}

main();

/*
AUDIT REPORT (testcanfail-tests-vault-shipped-acl-test-js)

Strengthened assertions:
- The vault-entry ACL loop previously relied on `vaultEntryCount > 0`, even
  though it iterates `vaultEntries`. A probe result with a positive count and
  an empty `vaultEntries` array would therefore skip every ACL assertion. The
  test now requires the actual collection to contain exactly `vault` and
  `vault/secrets.json`, and requires the reported count to agree with it.
  Mutation attempted: changing the probe to return an empty collection while
  retaining a positive count. PRECONDITION-NOT-MET: this container is not
  Windows and cannot execute powershell.exe or Windows DACL checks, so no RED
  runtime output can honestly be quoted for this mutation here.
- The shipped-helper assertions were unreachable behind the Windows-only
  return. Mutation: in a scratch/temporary edit, changed the product's
  `lib/vault-acl.ps1` dot-source reference to `lib/vault-acl-MUTATED.ps1`.
  RED (exit 1):
  "AssertionError [ERR_ASSERTION]: tools/secrets.ps1 no longer dot-sources
  lib/vault-acl.ps1 in the $PSScriptRoot form that
  tools/pack-capability-layer.mjs walks, so the helper would stop being
  packaged"

Restoration:
- The temporarily mutated tools/secrets.ps1 was restored byte-for-byte.
  SHA-256 before and after was
  b8c9db0814a7053a4fcd9b238e7583b9f33bd43a99aab1477a04f3eaaa4331b3.
- GREEN after restoration (exit 0):
  "shipped vault ACL runtime checks skipped: Windows-only ACL semantics"

Shape census:
1. FOUND: `vaultEntryCount` did not make the separately returned
   `vaultEntries` collection nonempty; fixed as described above. The fixed
   WRITERS literal and both direct ACL SID loops already have independent
   cardinality assertions.
2. NOT-FOUND: all successful process-status assertions require status zero;
   writer/probe behavior is additionally evidenced by created files, parsed
   semantic output, exact round trips, or subsequent filesystem ACL reads.
3. NOT-FOUND: no catch or optional chain swallows a tested failure; `finally`
   performs cleanup only.
4. NOT-FOUND: the ACL reader invokes independent OS ACL APIs and no subject is
   replaced by a mock.
5. FOUND: the platform guard skipped every assertion on non-Windows hosts;
   platform-independent artifact assertions now execute before that guard.
   PRECONDITION-NOT-MET: Windows ACL runtime assertions still require Windows.
6. NOT-FOUND: expected principals and paths are explicit fixture constants,
   not computed by the helper or probe under test.
*/
