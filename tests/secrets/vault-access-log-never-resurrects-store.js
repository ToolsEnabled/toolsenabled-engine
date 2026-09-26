'use strict';

// THE LOG MUST NEVER BRING THE VAULT BACK.
//
// Measured 2026-09-02 by uninstall-reset-packaged-qa: after the product's own
// local-data reset deleted capability/vault/, exactly one planted file came
// back -- secrets.json.access.log -- and the planted secrets.json beside it did
// not. That asymmetry is the signature of tools/secrets.ps1's
// Write-VaultAccessLog, which called Initialize-ProtectedVaultStore before
// appending its metadata line and so RECREATED the owner-ACL'd vault directory
// as a side effect of logging. Every vault verb runs as a synchronous
// powershell.exe child of the capability layer; the reset kills the parent
// while it is blocked in that call, the orphaned child finishes its verb, and
// the trailing log write lands on a tree the sweep has already certified empty.
//
// This suite pins the fix from both sides:
//   * with the store directory GONE, every read-side verb leaves it gone --
//     no directory, no log file -- even though each verb still logs when the
//     store exists;
//   * with the store directory gone, a MUTATING verb still creates it (store
//     creation stays on Write-Vault, where it is the intent), and logs again.
//
// Same isolation as every other file here: tests/lib/isolated-environment
// points TOOLSENABLED_VAULT_PATH at a scratch file. Nothing touches the real
// vault.

require('../lib/isolated-environment').activate('vault-access-log-never-resurrects-store');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SECRETS_SCRIPT = path.resolve(__dirname, '..', '..', 'tools', 'secrets.ps1');
const VAULT_FILE = process.env.TOOLSENABLED_VAULT_PATH;
const VAULT_DIR = path.dirname(VAULT_FILE);
const ACCESS_LOG = `${VAULT_FILE}.access.log`;
const KEY = 'resurrection_probe';

let passed = 0;
const failures = [];
function check(name, fn) {
  const started = Date.now();
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error && error.message}`);
  }
}

function vault(args, options = {}) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', SECRETS_SCRIPT, ...args
  ], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: environment
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', spawnError: result.error ? result.error.message : null };
}

function removeStore() {
  fs.rmSync(VAULT_DIR, { recursive: true, force: true });
  assert.equal(fs.existsSync(VAULT_DIR), false, 'test setup: the store directory must be gone before the verb runs');
}

function accessLogLines() {
  if (!fs.existsSync(ACCESS_LOG)) return [];
  return fs.readFileSync(ACCESS_LOG, 'utf8').split(/\r?\n/).filter(Boolean);
}

/* ---------------------------------------------------------------------------
   0. Positive control: with a store present, the read verbs DO log. Without
      this, the checks below could pass because logging was broken entirely.
   --------------------------------------------------------------------------- */

check('with the store present, a read verb writes an access-log line (logging itself works)', () => {
  const written = vault(['set-stdin', KEY], { input: 'probe-value' });
  assert.equal(written.status, 0, `set-stdin failed: ${written.stderr || written.spawnError}`);
  assert.equal(fs.existsSync(VAULT_DIR), true, 'set-stdin must create the store');
  const before = accessLogLines().length;
  const read = vault(['exists', KEY]);
  assert.ok(read.spawnError === null, `exists could not spawn: ${read.spawnError}`);
  const after = accessLogLines().length;
  assert.ok(after > before, `exists must append to the access log when the store exists (before ${before}, after ${after})`);
});

/* ---------------------------------------------------------------------------
   1. The defect: read verbs against a DELETED store must leave it deleted.
   --------------------------------------------------------------------------- */

for (const verb of [['get', KEY], ['exists', KEY], ['present', KEY], ['list']]) {
  check(`'${verb.join(' ')}' against a deleted store does not recreate the directory or the log`, () => {
    removeStore();
    const result = vault(verb);
    assert.equal(result.spawnError, null, `${verb[0]} could not spawn: ${result.spawnError}`);
    assert.equal(fs.existsSync(VAULT_DIR), false,
      `${verb[0]} resurrected the vault directory -- the access-log path is creating the store again`);
    assert.equal(fs.existsSync(ACCESS_LOG), false, `${verb[0]} recreated the access log beside a vault that no longer exists`);
  });
}

/* ---------------------------------------------------------------------------
   2. The other side: a mutation still creates the store, and logs again.
   --------------------------------------------------------------------------- */

check('a mutating verb against a deleted store still creates it and resumes logging', () => {
  removeStore();
  const result = vault(['set-stdin', KEY], { input: 'probe-value-2' });
  assert.equal(result.status, 0, `set-stdin failed: ${result.stderr || result.spawnError}`);
  assert.equal(fs.existsSync(VAULT_DIR), true, 'Write-Vault must still create the store; only the LOG path lost that right');
  const lines = accessLogLines().filter(line => line.includes(`"action":"set-stdin"`) && line.includes(`"key":"${KEY}"`));
  assert.equal(lines.length, 1, `expected exactly one set-stdin line after the store was recreated, got ${lines.length}`);
});

/* ---------------------------------------------------------------------------
   3. Source fence: the log function must not name the store initializer.
   --------------------------------------------------------------------------- */

check('Write-VaultAccessLog no longer calls Initialize-ProtectedVaultStore', () => {
  const source = fs.readFileSync(SECRETS_SCRIPT, 'utf8');
  const start = source.indexOf('function Write-VaultAccessLog');
  const end = source.indexOf('function Assert-Key');
  assert.ok(start !== -1 && end > start, 'could not locate Write-VaultAccessLog in tools/secrets.ps1');
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /Initialize-ProtectedVaultStore/, 'the log path must never initialize the store');
  assert.match(body, /Test-Path -LiteralPath \$VaultDir -PathType Container/, 'the log path must check the store exists before appending');
});

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error && failure.error.stack}`);
  process.exitCode = 1;
}
