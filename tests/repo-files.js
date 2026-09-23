'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repoFiles = require('../src/lib/providers/repo-files');

function code(fn, expectedCode) {
  try { fn(); assert.fail('expected to throw'); }
  catch (error) { assert.equal(error.code, expectedCode); }
}

// Use a real disposable test subdirectory INSIDE the repo (not the protected
// scratch/ runtime staging root and not the OS temp dir) so path.relative(ROOT,
// ...) genuinely lands inside the tree being tested.
const scratchRel = `tests/.repo-files-test-${process.pid}-${Date.now()}`;
const scratchAbs = path.join(repoFiles.ROOT, scratchRel);

function run() {
  // --- path traversal / absolute path rejection ---
  code(() => repoFiles.resolveInsideRepo('../outside.txt'), 'REPO_FILE_PATH_INVALID');
  code(() => repoFiles.resolveInsideRepo('a/../../outside.txt'), 'REPO_FILE_PATH_INVALID');
  code(() => repoFiles.resolveInsideRepo('C:\\Windows\\System32\\drivers\\etc\\hosts'), 'REPO_FILE_PATH_INVALID');
  code(() => repoFiles.resolveInsideRepo('/etc/passwd'), 'REPO_FILE_PATH_INVALID');
  code(() => repoFiles.resolveInsideRepo(''), 'REPO_FILE_PATH_INVALID');
  console.log('repo-files path-traversal rejection tests passed.');

  // --- excluded directories ---
  code(() => repoFiles.readFile({ path: 'state/toolsenabled.sqlite3' }), 'REPO_FILE_PATH_FORBIDDEN');
  code(() => repoFiles.readFile({ path: 'vault/secrets.json' }), 'REPO_FILE_PATH_FORBIDDEN');
  code(() => repoFiles.writeFile({ path: 'logs/whatever.log', content: 'x' }), 'REPO_FILE_PATH_FORBIDDEN');
  code(() => repoFiles.listDir({ path: '.git' }), 'REPO_FILE_PATH_FORBIDDEN');
  console.log('repo-files excluded-directory tests passed.');

  // --- write-protected files ---
  code(() => repoFiles.writeFile({ path: 'STANDING-ORDERS.md', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'package.json', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'reports/OWNER-REQUEST-LEDGER.json', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: '.claude/settings.json', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'tools/standing-orders-hook.js', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  assert.equal(repoFiles.WRITE_PROTECTED_FILES.has('.claude/settings.json'), true);
  assert.equal(repoFiles.WRITE_PROTECTED_FILES.has('tools/standing-orders-hook.js'), true);
  assert.deepEqual(
    [...repoFiles.WRITE_GUARD_CONTROL_FILES].sort(),
    ['.claude/settings.json', 'tools/standing-orders-hook.js'],
    'self-protection metadata is declared once beside the protected-file authority'
  );
  // Reading a write-protected shipped file is still fine -- only writes are
  // blocked. package.json is customer-neutral repository source; an optional
  // customer's STANDING-ORDERS.md must never be a release-test prerequisite.
  const packageManifest = repoFiles.readFile({ path: 'package.json' });
  assert.equal(JSON.parse(packageManifest.content).name, 'toolsenabled');
  console.log('repo-files write-protection tests passed.');

  // --- regression coverage for the 2026-07-30 adversarial review ---
  // config/ is write-protected as a WHOLE DIRECTORY now, not an enumerated
  // file list -- the review's headline finding was that
  // config/toolsenabled.policy.json specifically (kill-switch path,
  // approvals, http.vaultKeys) was writable because only 3 sibling files
  // were named.
  code(() => repoFiles.writeFile({ path: 'config/toolsenabled.policy.json', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'config/agent-org.json', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'config/managed-processes.json', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  // ...but config/ stays readable, same asymmetry as before.
  const policyRead = repoFiles.readFile({ path: 'config/toolsenabled.policy.json' });
  assert.ok(policyRead.content.length > 0);

  // Governance files an agent is judged by must not be self-editable.
  code(() => repoFiles.writeFile({ path: 'CLAUDE.md', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'BUILD-QUEUE.md', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'docs/ROLE-OPERATIONS.md', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'KILLSWITCH', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');

  // Scheduled/elevated entry points -- writing these is delayed code
  // execution as the owner via the next restart or scheduled trigger, no
  // host.exec required.
  code(() => repoFiles.writeFile({ path: 'tools/secrets.ps1', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'sidecars/local-coder/bin/overnight-advisory-worker.js', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'sidecars/local-coder/bin/controller-projection-worker.js', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'src/remote-agent-bridge.js', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'tools/fleet-supervisor.js', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  code(() => repoFiles.writeFile({ path: 'tools/some-random-registrar.ps1', content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  for (const root of ['src', 'tools', 'scripts', 'sidecars', 'packages', 'config', 'captures', 'scratch', 'tmp']) {
    code(() => repoFiles.writeFile({ path: path.posix.join(root, 'generic-staging-target.js'), content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  }
  for (const packageFile of ['npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']) {
    code(() => repoFiles.writeFile({ path: packageFile, content: 'nope' }), 'REPO_FILE_WRITE_PROTECTED');
  }
  console.log('repo-files 2026-07-30 review regression tests passed (config/ dir, governance files, scheduled entry points).');

  // --- bounded credential/history stores are excluded from read/list/write ---
  const protectedStores = [
    '.npmrc',
    '.pypirc',
    'NuGet/NuGet.Config',
    '.nuget/NuGet.Config',
    '.azure/azureProfile.json',
    '.azure/accessTokens.json',
    '.terraform.d/credentials.tfrc.json',
    '.config/gh/hosts.yml',
    'PowerShell/PSReadLine/ConsoleHost_history.txt',
    'ConsoleHost_history.txt',
    '.bash_history',
    '.zsh_history',
    'auth.json',
    'token-cache.json',
    'cookies.sqlite',
    'session.json',
    '.env',
    '.env.local'
  ];
  for (const protectedPath of protectedStores) {
    code(() => repoFiles.resolveInsideRepo(protectedPath), 'REPO_FILE_PATH_FORBIDDEN');
    code(() => repoFiles.readFile({ path: protectedPath }), 'REPO_FILE_PATH_FORBIDDEN');
    code(() => repoFiles.writeFile({ path: protectedPath, content: 'nope' }), 'REPO_FILE_PATH_FORBIDDEN');
  }
  for (const example of ['.env.example', '.env.template', '.env.sample', 'ordinary-profile-settings.json']) {
    assert.doesNotThrow(() => repoFiles.resolveInsideRepo(example));
  }
  console.log('repo-files bounded credential/history and environment-secret exclusion tests passed.');

  const listProbeRel = 'tests/.repo-files-list-filter-' + process.pid + '-' + Date.now();
  const listProbeAbs = path.join(repoFiles.ROOT, listProbeRel);
  fs.mkdirSync(path.join(listProbeAbs, 'PowerShell', 'PSReadLine'), { recursive: true });
  for (const name of ['.npmrc', '.env', 'auth.json', '.env.example', 'ordinary.txt']) {
    fs.writeFileSync(path.join(listProbeAbs, name), 'test\n', 'utf8');
  }
  fs.writeFileSync(path.join(listProbeAbs, 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'), 'history\n', 'utf8');
  try {
    const rootListing = repoFiles.listDir({ path: listProbeRel });
    const rootNames = rootListing.entries.map(entry => entry.name);
    assert.deepEqual(rootNames.sort(), ['.env.example', 'PowerShell', 'ordinary.txt'].sort());
    const historyListing = repoFiles.listDir({ path: path.posix.join(listProbeRel, 'PowerShell', 'PSReadLine') });
    assert.deepEqual(historyListing.entries, []);
  } finally {
    fs.rmSync(listProbeAbs, { recursive: true, force: true });
  }
  console.log('repo-files list filtering hides credential and shell-history names.');

  // --- real read/write/list round trip inside a scratch scratch subdir ---
  fs.mkdirSync(scratchAbs, { recursive: true });
  try {
    const nested = `${scratchRel}/nested/hello.txt`;
    const written = repoFiles.writeFile({ path: nested, content: 'hello from the bridge\n' });
    assert.equal(written.path, nested);
    const read = repoFiles.readFile({ path: nested });
    assert.equal(read.content, 'hello from the bridge\n');

    const listing = repoFiles.listDir({ path: `${scratchRel}/nested` });
    assert.deepEqual(listing.entries, [{ name: 'hello.txt', type: 'file' }]);

    // Overwrite must replace, not append.
    repoFiles.writeFile({ path: nested, content: 'overwritten\n' });
    assert.equal(repoFiles.readFile({ path: nested }).content, 'overwritten\n');

    const patched = repoFiles.patchFile({ path: nested, oldText: 'overwritten', newText: 'precisely patched' });
    assert.deepEqual(patched, { path: nested, bytes: 18, replacements: 1 });
    assert.equal(repoFiles.readFile({ path: nested }).content, 'precisely patched\n');
    code(() => repoFiles.patchFile({ path: nested, oldText: 'stale text', newText: 'nope' }), 'REPO_FILE_PATCH_MISMATCH');
    repoFiles.writeFile({ path: nested, content: 'same same\n' });
    code(() => repoFiles.patchFile({ path: nested, oldText: 'same', newText: 'different' }), 'REPO_FILE_PATCH_AMBIGUOUS');
    code(() => repoFiles.patchFile({ path: nested, oldText: '', newText: 'nope' }), 'REPO_FILE_PATCH_INVALID');
    code(() => repoFiles.patchFile({ path: 'STANDING-ORDERS.md', oldText: 'a', newText: 'b' }), 'REPO_FILE_WRITE_PROTECTED');

    code(() => repoFiles.readFile({ path: `${scratchRel}/does-not-exist.txt` }), 'REPO_FILE_NOT_FOUND');

    const tooLarge = 'x'.repeat(repoFiles.MAX_FILE_BYTES + 1);
    code(() => repoFiles.writeFile({ path: `${scratchRel}/too-large.txt`, content: tooLarge }), 'REPO_FILE_TOO_LARGE');
  } finally {
    fs.rmSync(scratchAbs, { recursive: true, force: true });
  }
  console.log('repo-files read/write/list round-trip tests passed.');

  // --- kill switch: this module had NO assertActive call at all before the
  // 2026-07-30 review; every other consequential tool checks it. Uses the
  // REAL shared KILLSWITCH file, so create/verify/remove in a try/finally.
  const killSwitch = require('../src/lib/kill-switch');
  assert.equal(killSwitch.status().active, false, 'the kill switch must not already be active before this test touches it');
  killSwitch.activate();
  try {
    repoFiles.readFile({ path: 'package.json' });
    assert.fail('repo.read_file must refuse while the kill switch is active');
  } catch (error) {
    assert.match(error.message, /KILLSWITCH is active/);
  } finally {
    killSwitch.deactivate();
  }
  assert.equal(killSwitch.status().active, false, 'the kill switch must be restored to inactive after this test');
  console.log('repo-files kill-switch regression test passed (repo.* had no kill-switch check at all before this fix).');

  // --- ancestor-junction escape: regression test for a real, verified bug ---
  // A coordinator security review (2026-07-30) found the companion
  // host-control.js module's lexical-only path checks defeated by a Windows
  // reparse point; this module has the identical shape (EXCLUDED_DIR_NAMES
  // is checked against the string path, not what the OS actually opens), so
  // it needed the same fix. EXCLUDED_DIR_NAMES only fires on the FIRST path
  // segment under ROOT. Use a disposable child of the excluded logs/ directory
  // as the target: a fresh top-level junction with an innocuous name must still
  // be refused once canonicalized, without touching installation log content.
  {
    const aliasName = `repo-files-junction-test-alias-${process.pid}`;
    const aliasAbs = path.join(repoFiles.ROOT, aliasName);
    const excludedTarget = path.join(repoFiles.ROOT, 'logs', `.repo-files-junction-target-${process.pid}-${Date.now()}`);
    fs.mkdirSync(excludedTarget, { recursive: true });
    fs.writeFileSync(path.join(excludedTarget, 'fixture-secret.json'), '{"fixture":true}\n', 'utf8');
    fs.symlinkSync(excludedTarget, aliasAbs, 'junction');
    try {
      code(() => repoFiles.readFile({ path: `${aliasName}/fixture-secret.json` }), 'REPO_FILE_PATH_FORBIDDEN');
      code(() => repoFiles.listDir({ path: aliasName }), 'REPO_FILE_PATH_FORBIDDEN');
      code(() => repoFiles.writeFile({ path: `${aliasName}/new-file-that-must-not-be-creatable.json`, content: 'x' }), 'REPO_FILE_PATH_FORBIDDEN');
    } finally {
      fs.unlinkSync(aliasAbs);
      fs.rmSync(excludedTarget, { recursive: true, force: true });
    }
  }
  console.log('repo-files ancestor-junction canonicalization test passed (an innocuously-named alias to a disposable excluded target is refused).');
}

run();
process.stdout.write('repo-files tests passed.\n');
