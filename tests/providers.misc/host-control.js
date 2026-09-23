// EXECUTABLE CHANGE
// Report: testcanfail-tests-providers-misc-host-control-js
//
// Strengthened assertion: the failed host.exec check now requires the child
// process's own sentinel output as well as ok=false and exitCode=3. The prior
// two assertions admitted a fabricated failure result and therefore did not
// prove that the requested command loaded and ran.
//
// Mutation attempted: in src/lib/providers/host-control.js, host.exec was
// temporarily changed to return { ok:false, exitCode:3, stdout:'', stderr:'' }
// without launching the child. A focused execution of the strengthened
// assertion against that mutant produced this RED output:
//   AssertionError [ERR_ASSERTION]: The input did not match the regular expression
//   /exec-failure-sentinel/. Input: ''
// The source mutation was restored byte-for-byte (`git diff -- src/lib/providers/host-control.js`
// was empty and its SHA-256 remained 47cc5a896c325fc59e967fb053071765557fb55da8f92b42ea6d0a2c5a949051).
// A full green/red execution could not be observed in this Linux container:
// even with available Node v22.22.2, the Windows audit-signing identity/key is
// unavailable and powershell.exe is absent. Both mutant and restored full runs
// stop before host.exec with this named unmet precondition:
//   AuditRequiredError: Durable audit intent could not be recorded; the external mutation was not started.
//   reason: 'AUDIT_SIGNING_KEY_UNAVAILABLE'
//
// Shape census: (1) NOT-FOUND — all assertion loops use non-empty literals;
// the dynamic processes.every assertion is preceded by count>=1. (2) FOUND
// and strengthened below. (3) NOT-FOUND — code() rethrows assertion failures,
// junction cleanup uses finally, and the kill-switch catch asserts the error.
// (4) NOT-FOUND — audit.requireRecord is mocked only to test host operations'
// audit-admission behavior, not audit.requireRecord itself. (5) NOT-FOUND — no
// platform guard bypasses this file; only the native Windows profile alias
// check is conditional. (6) NOT-FOUND — expected
// values are independent literals rather than host-control-derived values.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hostControl = require('../../src/lib/providers/host-control');
const { activate } = require('../lib/isolated-environment');

function code(fn, expected, label) {
  try { fn(); assert.fail(`${label}: expected ${expected}, got no throw`); }
  catch (error) {
    if (error && error.code === expected) return;
    if (error instanceof assert.AssertionError) throw error;
    assert.fail(`${label}: expected ${expected}, got ${error && error.code}`);
  }
}

// readFile/writeFile/listDir/listProcesses now reach the audit ledger
// through the awaited path host.exec already uses (32faaf7:
// audit-admission.js#requireRecordAsync), so a failure surfaces as a
// rejection, not a synchronous throw. Same contract as code() above --
// calling with values, not matching source text -- just awaited.
async function codeAsync(fn, expected, label) {
  try { await fn(); assert.fail(`${label}: expected ${expected}, got no rejection`); }
  catch (error) {
    if (error && error.code === expected) return;
    if (error instanceof assert.AssertionError) throw error;
    assert.fail(`${label}: expected ${expected}, got ${error && error.code}`);
  }
}

const HOME = process.platform === 'linux' ? os.userInfo().homedir : os.homedir();
const scratch = path.join(HOME, `.host-control-test-${process.pid}-${Date.now()}`);
const isolated = activate('host-control');
const TE = path.join(HOME, `ToolsEnabled-host-control-${process.pid}-${Date.now()}`);
const SYSTEM_ROOT = path.parse(HOME).root;

// The host-control policy protects roots named ToolsEnabled*. This fixture must
// exercise that same policy shape, but it must never use this checkout's
// config/ as a negative-write target.
fs.mkdirSync(path.join(TE, 'config'), { recursive: true });
fs.copyFileSync(
  path.join(__dirname, '..', '..', 'config', 'toolsenabled.policy.json'),
  path.join(TE, 'config', 'toolsenabled.policy.json')
);
fs.writeFileSync(path.join(TE, 'STANDING-ORDERS.md'), 'STANDING ORDERS fixture\n', 'utf8');

async function run() {
  // --- containment: outside the owner profile tree is refused ---
  code(() => hostControl.resolveHostPath(path.join(SYSTEM_ROOT, 'system-protected', 'hosts')), 'HOST_PATH_OUTSIDE_PROFILE', 'system dir');
  code(() => hostControl.resolveHostPath(SYSTEM_ROOT), 'HOST_PATH_OUTSIDE_PROFILE', 'filesystem root');
  code(() => hostControl.resolveHostPath(path.join(HOME, '..', 'Public', 'x.txt')), 'HOST_PATH_OUTSIDE_PROFILE', 'traversal out of home');
  code(() => hostControl.resolveHostPath(''), 'HOST_PATH_INVALID', 'empty');
  console.log('OK: paths outside the owner profile tree are refused');

  // --- credential-protected locations stay excluded even inside home ---
  const forbidden = [
    path.join(HOME, 'Desktop', 'ToolsEnabled', 'vault', 'secrets.json'),
    path.join(HOME, '.ssh', 'id_rsa'),
    path.join(HOME, '.aws', 'credentials'),
    path.join(HOME, '.gnupg', 'secring.gpg'),
    path.join(HOME, 'Desktop', 'ToolsEnabled', 'profiles', 'chrome', 'Cookies'),
    path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Protect', 'whatever')
  ];
  for (const target of forbidden) {
    code(() => hostControl.resolveHostPath(target), 'HOST_PATH_FORBIDDEN', target);
  }
  // And through the real entry points, not just the resolver.
  await codeAsync(() => hostControl.readFile({ path: path.join(HOME, 'Desktop', 'ToolsEnabled', 'vault', 'secrets.json') }), 'HOST_PATH_FORBIDDEN', 'readFile vault');
  await codeAsync(() => hostControl.writeFile({ path: path.join(HOME, '.ssh', 'authorized_keys'), content: 'x' }), 'HOST_PATH_FORBIDDEN', 'writeFile .ssh');
  console.log('OK: credential-protected locations are refused through the real entry points');

  // --- integrity anchors are readable but NOT writable ---
  // Regression guard for a real bug: WRITE_EXCLUDED_PATH_PATTERNS was added
  // but resolveHostPath was initially called without {forWrite:true} from
  // writeFile, making the whole protection dead code.
  const writeProtected = [
    path.join(TE, 'config', 'toolsenabled.policy.json'),
    path.join(TE, 'config', 'uac-delegation-allowlist.json'),
    path.join(TE, 'logs', 'anything.log'),
    path.join(TE, 'STANDING-ORDERS.md'),
    path.join(TE, 'CLAUDE.md'),
    path.join(TE, 'AGENTS.md'),
    path.join(TE, 'BUILD-QUEUE.md'),
    path.join(TE, 'package.json'),
    path.join(TE, 'KILLSWITCH'),
    path.join(TE, 'reports', 'OWNER-REQUEST-LEDGER.json'),
    path.join(TE, 'npm-shrinkwrap.json'),
    path.join(TE, 'yarn.lock'),
    path.join(TE, 'pnpm-lock.yaml'),
    path.join(TE, 'bun.lockb'),
    path.join(TE, 'node_modules', 'whatever.js'),
    path.join(TE, 'src', 'generic-staging-target.js'),
    path.join(TE, 'tools', 'generic-staging-target.js'),
    path.join(TE, 'scripts', 'generic-staging-target.js'),
    path.join(TE, 'sidecars', 'generic-staging-target.js'),
    path.join(TE, 'packages', 'generic-staging-target.js'),
    path.join(TE, 'captures', 'generic-staging-target.js'),
    path.join(TE, 'scratch', 'generic-staging-target.js'),
    path.join(TE, 'tmp', 'generic-staging-target.js')
  ];
  for (const target of writeProtected) {
    await codeAsync(() => hostControl.writeFile({ path: target, content: 'x' }), 'HOST_PATH_WRITE_PROTECTED', `write ${target}`);
  }
  // ...but still readable, which is the intended asymmetry for these.
  const readable = await hostControl.readFile({ path: path.join(TE, 'STANDING-ORDERS.md') });
  assert.ok(readable.content.includes('STANDING ORDERS'));
  console.log('OK: integrity anchors (config/, logs/, ledger, standing orders, governance files) are read-only, not writable');

  // --- state/ escalation fix: read AND write both refused now, not just write ---
  // A prior review found state/ readable (though not writable) exposed the
  // elevated UAC helper's per-boot token and the owner-host named-pipe
  // capability -- a direct escalation past this whole module.
  await codeAsync(() => hostControl.readFile({ path: path.join(TE, 'state', 'uac-delegation-token.json') }), 'HOST_PATH_FORBIDDEN', 'read state/');
  await codeAsync(() => hostControl.writeFile({ path: path.join(TE, 'state', 'forged-approval.json'), content: 'x' }), 'HOST_PATH_FORBIDDEN', 'write state/');
  await codeAsync(() => hostControl.listDir({ path: path.join(TE, 'state') }), 'HOST_PATH_FORBIDDEN', 'list state/');
  console.log('OK: state/ is fully unreadable and unwritable (closes the UAC-token/owner-host-capability escalation)');

  // --- credential stores beyond the original vault/browser list ---
  const credentialLeaks = [
    path.join(HOME, '.codex', 'auth.json'),
    path.join(HOME, '.claude', '.credentials.json'),
    path.join(HOME, '.gemini', 'oauth_creds.json'),
    path.join(HOME, '.config', 'whatever'),
    path.join(HOME, 'AppData', 'Roaming', 'gcloud', 'application_default_credentials.json')
  ];
  for (const target of credentialLeaks) {
    await codeAsync(() => hostControl.readFile({ path: target }), 'HOST_PATH_FORBIDDEN', `read ${target}`);
  }
  console.log('OK: AI-CLI/cloud-CLI credential stores (.codex, .claude, .gemini, .config, gcloud) are unreadable');

  // --- ancestor-junction escape: regression test for a real, verified bug ---
  // A coordinator security review (2026-07-30) found resolveHostPath was
  // lexical-only: EXCLUDED_PATH_PATTERNS is a string regex, so spelling an
  // excluded target through a legacy Windows profile junction bypassed every
  // pattern, even though it opens the identical file. Verified live on THIS
  // machine: "Local Settings" canonicalizes to "AppData\Local".
  if (process.platform === 'win32') await codeAsync(
    () => hostControl.readFile({ path: path.join(HOME, 'Local Settings', 'Microsoft', 'Credentials', 'whatever') }),
    'HOST_PATH_FORBIDDEN',
    'read AppData\\Local\\Microsoft\\Credentials spelled through its Local Settings alias'
  );
  // Same bug class with a FRESH junction created for this test, proving the
  // fix generalizes beyond the pre-existing legacy aliases above. The real
  // target's path contains "vault" (matching EXCLUDED_PATH_PATTERNS), but
  // the alias used to reach it does not -- a lexical-only check would see
  // only the alias string and never notice.
  {
    const realVaultLikeDir = path.join(HOME, `.host-control-junction-real-${process.pid}`, 'vault');
    const aliasDir = path.join(HOME, `.host-control-junction-alias-${process.pid}`);
    fs.mkdirSync(realVaultLikeDir, { recursive: true });
    fs.writeFileSync(path.join(realVaultLikeDir, 'token.json'), '{}', 'utf8');
    fs.symlinkSync(realVaultLikeDir, aliasDir, 'junction'); // aliasDir now points AT the "vault" dir, but its own name says nothing of the kind
    try {
      const throughAlias = path.join(aliasDir, 'token.json');
      await codeAsync(() => hostControl.readFile({ path: throughAlias }), 'HOST_PATH_FORBIDDEN', 'read a vault-like target reached only through an innocuously-named fresh junction');
      await codeAsync(() => hostControl.writeFile({ path: path.join(throughAlias, '..', 'new-file.txt'), content: 'x' }), 'HOST_PATH_FORBIDDEN', 'write a not-yet-existing file inside the same junction-reached vault-like dir');
      console.log('OK: a fresh junction whose alias name hides an excluded real target is still refused (read and write)');
    } finally {
      fs.rmSync(aliasDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(realVaultLikeDir), { recursive: true, force: true });
    }
  }
  console.log('OK: ancestor-junction canonicalization closes the verified EXCLUDED_PATH_PATTERNS bypass');

  // --- global git config stays readable; npm auth config is credential-protected ---
  // A crafted diff driver/textconv in ~/.gitconfig runs on the next `git
  // diff`/`git show` ANY local process makes -- not just a purpose-built lane.
  await codeAsync(() => hostControl.writeFile({ path: path.join(HOME, '.gitconfig'), content: '[core]\n pager = evil\n' }), 'HOST_PATH_WRITE_PROTECTED', 'write .gitconfig');
  await codeAsync(() => hostControl.readFile({ path: path.join(HOME, '.npmrc') }), 'HOST_PATH_FORBIDDEN', 'read .npmrc');
  await codeAsync(() => hostControl.writeFile({ path: path.join(HOME, '.npmrc'), content: 'registry=http://evil\n' }), 'HOST_PATH_FORBIDDEN', 'write .npmrc');
  console.log('OK: global git config is write-protected and npm auth config is fully excluded');

  // --- bounded credential/history stores and environment-secret files ---
  const boundedCredentialLeaks = [
    path.join(HOME, '.pypirc'),
    path.join(HOME, 'AppData', 'Roaming', 'NuGet', 'NuGet.Config'),
    path.join(HOME, '.nuget', 'NuGet.Config'),
    path.join(HOME, '.azure', 'azureProfile.json'),
    path.join(HOME, '.azure', 'AzureRmContext.json'),
    path.join(HOME, '.azure', 'accessTokens.json'),
    path.join(HOME, '.azure', 'msal_token_cache.bin'),
    path.join(HOME, '.terraform.d', 'credentials.tfrc.json'),
    path.join(HOME, '.config', 'gh', 'hosts.yml'),
    path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'),
    path.join(HOME, 'Documents', 'WindowsPowerShell', 'PSReadLine', 'ConsoleHost_history.txt'),
    path.join(HOME, 'ConsoleHost_history.txt'),
    path.join(HOME, '.bash_history'),
    path.join(HOME, '.zsh_history'),
    path.join(HOME, 'auth.json'),
    path.join(HOME, 'token-cache.json'),
    path.join(HOME, 'cookies.sqlite'),
    path.join(HOME, 'session.json'),
    path.join(HOME, '.env'),
    path.join(HOME, '.env.local'),
    path.join(HOME, '.env.production')
  ];
  for (const target of boundedCredentialLeaks) {
    code(() => hostControl.resolveHostPath(target), 'HOST_PATH_FORBIDDEN', 'bounded credential/history store ' + target);
  }
  for (const example of ['.env.example', '.env.template', '.env.sample']) {
    assert.doesNotThrow(() => hostControl.resolveHostPath(path.join(HOME, example)), 'example env file remains usable: ' + example);
  }
  assert.doesNotThrow(() => hostControl.resolveHostPath(path.join(HOME, 'ordinary-profile-settings.json')));
  console.log('OK: bounded package/CLI/history/auth stores are excluded while example and ordinary profile files remain addressable');

  // --- read-only host operations fail closed when durable audit admission is unavailable ---
  // Same shape as host.exec's own coverage of this
  // (tests/host-exec-audit-off-thread.test.js, "a refused admission launches
  // nothing and rejects with the refusal"): inject dependencies.requireRecordAsync
  // directly, the same seam host.exec (32faaf7) reads. No ledger, vault or
  // PowerShell is touched by this block.
  const refusal = Object.assign(new Error('test audit unavailable'), { code: 'AUDIT_UNAVAILABLE' });
  const refusedAdmission = { requireRecordAsync: () => Promise.reject(refusal) };
  await codeAsync(() => hostControl.readFile({ path: path.join(TE, 'STANDING-ORDERS.md') }, refusedAdmission), 'AUDIT_UNAVAILABLE', 'readFile audit admission');
  await codeAsync(() => hostControl.writeFile({ path: path.join(TE, 'audit-admission-refusal-target.txt'), content: 'x' }, refusedAdmission), 'AUDIT_UNAVAILABLE', 'writeFile audit admission');
  await codeAsync(() => hostControl.listDir({ path: TE }, refusedAdmission), 'AUDIT_UNAVAILABLE', 'listDir audit admission');
  await codeAsync(() => hostControl.listProcesses({ nameFilter: 'node' }, refusedAdmission), 'AUDIT_UNAVAILABLE', 'listProcesses audit admission');
  assert.equal(fs.existsSync(path.join(TE, 'audit-admission-refusal-target.txt')), false, 'a refused admission must never let the write land');
  console.log('OK: readFile/writeFile/listDir/listProcesses fail closed before their data reads/writes when audit admission is unavailable');

  // --- worktree-anchoring fix: sibling fleet-lane worktrees get the same protection ---
  const fakeLaneWorktree = path.join(HOME, 'Desktop', 'ToolsEnabled-fleet-lane-testfixture12345');
  await codeAsync(() => hostControl.readFile({ path: path.join(fakeLaneWorktree, 'state', 'x.json') }), 'HOST_PATH_FORBIDDEN', 'read lane worktree state/');
  await codeAsync(() => hostControl.writeFile({ path: path.join(fakeLaneWorktree, 'STANDING-ORDERS.md'), content: 'x' }), 'HOST_PATH_WRITE_PROTECTED', 'write lane worktree STANDING-ORDERS.md');
  console.log('OK: ToolsEnabled-fleet-lane-* sibling worktrees get the same protection as the real repo');

  // --- real read/write/list round trip inside the owner tree ---
  fs.mkdirSync(scratch, { recursive: true });
  try {
    const target = path.join(scratch, 'nested', 'note.txt');
    const written = await hostControl.writeFile({ path: target, content: 'host control works\n' });
    assert.equal(written.bytes, 19);
    assert.equal((await hostControl.readFile({ path: target })).content, 'host control works\n');

    const listing = await hostControl.listDir({ path: path.join(scratch, 'nested') });
    assert.equal(listing.entries.length, 1);
    assert.equal(listing.entries[0].name, 'note.txt');
    assert.equal(listing.entries[0].type, 'file');
    assert.equal(listing.entries[0].bytes, 19);

    // A parent listing must not disclose protected store names, while an
    // explicit example template and ordinary file remain visible.
    for (const name of ['.npmrc', '.env', 'auth.json', '.env.example', 'ordinary.txt']) {
      fs.writeFileSync(path.join(scratch, name), 'test\n', 'utf8');
    }
    const historyDir = path.join(scratch, 'PowerShell', 'PSReadLine');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'ConsoleHost_history.txt'), 'history\n', 'utf8');
    const filteredListing = await hostControl.listDir({ path: scratch });
    const filteredNames = filteredListing.entries.map(entry => entry.name);
    assert.ok(filteredNames.includes('.env.example'));
    assert.ok(filteredNames.includes('ordinary.txt'));
    assert.ok(!filteredNames.includes('.npmrc'));
    assert.ok(!filteredNames.includes('.env'));
    assert.ok(!filteredNames.includes('auth.json'));
    assert.ok((await hostControl.listDir({ path: historyDir })).entries.length === 0);

    await codeAsync(() => hostControl.readFile({ path: path.join(scratch, 'missing.txt') }), 'HOST_PATH_NOT_FOUND', 'missing file');
    await codeAsync(() => hostControl.writeFile({ path: target, content: 'x'.repeat(hostControl.MAX_FILE_BYTES + 1) }), 'HOST_FILE_TOO_LARGE', 'oversize write');
    console.log('OK: read/write/list round trip works inside the owner tree');

    // --- exec: real command, real output, bounded ---
    const linux = process.platform === 'linux';
    const echoed = await hostControl.exec({ command: linux ? 'printf "exec-smoke-ok\\n"' : 'Write-Output "exec-smoke-ok"', cwd: scratch });
    assert.equal(echoed.ok, true);
    assert.equal(echoed.exitCode, 0);
    assert.match(echoed.stdout, /exec-smoke-ok/);
    assert.equal(echoed.timedOut, false);

    // A failing command reports honestly rather than as success.
    const failed = await hostControl.exec({ command: linux ? 'printf "exec-failure-sentinel\\n"; exit 3' : 'Write-Output "exec-failure-sentinel"; exit 3', cwd: scratch });
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 3);
    assert.match(failed.stdout, /exec-failure-sentinel/);

    // cwd is genuinely applied.
    const inCwd = await hostControl.exec({ command: linux ? 'pwd' : '(Get-Location).Path', cwd: scratch });
    assert.match(inCwd.stdout.trim().toLowerCase(), new RegExp(scratch.replace(/[\\/]/g, '.').toLowerCase().slice(-30)));

    // Input validation. exec validates synchronously before returning a
    // promise, so these throw rather than reject -- assert on .code.
    code(() => hostControl.exec({ command: '' }), 'HOST_INPUT_INVALID', 'empty command');
    code(() => hostControl.exec({ command: 'x', timeoutMs: 10 }), 'HOST_INPUT_INVALID', 'timeout too low');
    code(() => hostControl.exec({ command: 'x', shell: linux ? 'cmd' : 'bash' }), 'HOST_INPUT_INVALID', 'unsupported shell');
    // exec cwd containment is enforced by the same resolver.
    code(() => hostControl.exec({ command: 'x', cwd: SYSTEM_ROOT }), 'HOST_PATH_OUTSIDE_PROFILE', 'exec cwd outside home');
    console.log('OK: exec runs real commands, reports failure honestly, and validates input');

    // --- process listing ---
    const processes = await hostControl.listProcesses({ nameFilter: 'node' });
    assert.ok(processes.count >= 1, 'this test process itself should appear');
    assert.ok(processes.processes.every(p => p.name.toLowerCase().includes('node')));
    assert.ok(Number.isInteger(processes.processes[0].pid));
    console.log('OK: process listing works and filters');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // --- kill switch: regression test for a real bug, fixed 2026-07-30 ---
  // Every host.* entry point called assertActive(action, {outward:false}),
  // and policy.js's kill-switch check is skipped whenever outward===false --
  // so the kill switch never actually gated any of this module, despite its
  // own header claiming otherwise. This test uses the REAL KILLSWITCH file
  // (shared global state), so it must create it, verify, and remove it in a
  // try/finally no matter what -- leaving it behind would halt every outward
  // operation on the machine.
  const killSwitch = require('../../src/lib/kill-switch');
  assert.equal(killSwitch.status().active, false, 'the kill switch must not already be active before this test touches it');
  killSwitch.activate();
  try {
    hostControl.exec({ command: 'Write-Output hi' });
    assert.fail('host.exec must refuse while the kill switch is active');
  } catch (error) {
    assert.match(error.message, /KILLSWITCH is active/);
  } finally {
    killSwitch.deactivate();
  }
  assert.equal(killSwitch.status().active, false, 'the kill switch must be restored to inactive after this test');
  console.log('OK: the kill switch actually gates host.exec now (it did not before this fix)');
}

run().then(() => console.log('host-control tests passed.')).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TE, { recursive: true, force: true });
});
