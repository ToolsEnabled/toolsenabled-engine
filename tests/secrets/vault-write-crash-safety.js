'use strict';

// THE VAULT MUST SURVIVE A CRASH MID-WRITE, ON BOTH HALVES THAT CAN WRITE IT.
//
// tools/secrets.ps1 Write-Vault was made crash-safe on 2026-09-02 (commit
// 9a6c79c, "make the vault and session config writes crash-safe"): a hard
// power loss on the owner's machine, caught mid-write, had already left
// vault/secrets.json as 4,352 bytes of NUL. The temp file's data pages were
// never flushed to disk before the write-through rename replaced the real
// vault with them -- MOVEFILE_WRITE_THROUGH (used by Move-VaultFileAtomically,
// tools/lib/vault-acl.ps1) only makes the RENAME durable; it says nothing
// about the bytes already sitting in the file being renamed. The fix was
// FileStream.Write + Flush($true) (FlushFileBuffers) before that rename.
//
// That fix touched exactly one of the two scripts that write this same vault
// file (verified against the commit itself: `git show --stat 9a6c79c` touches
// tools/secrets.ps1 and nothing under tools/secrets-manager.ps1).
// tools/secrets-manager.ps1 -- the lifecycle half: add, replace, rotate,
// remove -- still called [System.IO.File]::WriteAllText with no flush at all
// before the identical Move-VaultFileAtomically rename. Every lifecycle
// mutation carried the exact defect the sibling script had already measured
// and fixed: a crash between the WriteAllText and the rename can leave the
// vault as the same truncated/all-NUL file, which is unrecoverable -- every
// later read of it fails closed (SECRET_STORE_INVALID / vault unreadable),
// taking every credential in the vault down with it.
//
// TWO MEASUREMENTS.
//   (a) SOURCE FENCE. Neither script's Write-Vault may write the vault's temp
//       file through a bare WriteAllText/WriteAllBytes with no flush; both
//       must flush the file to disk (.Flush($true)) before the atomic rename
//       that follows. Proven RED against the pre-fix secrets-manager.ps1
//       source and GREEN after.
//   (b) FUNCTIONAL ROUND-TRIP. Proves the fix does not just satisfy the
//       fence: a value added through secrets-manager.ps1 is exactly what
//       secrets.ps1 reads back from the SAME vault file, the vault bytes on
//       disk are complete valid JSON with no embedded NUL, and
//       inventory/remove still work end to end.
//
// THE VAULT UNDER TEST IS THE ISOLATED SCRATCH VAULT (see tests/lib/isolated-
// environment), never the owner's real one. The value written is a synthetic
// marker, not a credential.

const isolated = require('../lib/isolated-environment').activate('vault-write-crash-safety');

const path = require('node:path');
process.env.TOOLSENABLED_STATE_ROOT = path.join(isolated.root, 'state-root');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_SCRIPT = path.join(ROOT, 'tools', 'secrets.ps1');
const MANAGER_SCRIPT = path.join(ROOT, 'tools', 'secrets-manager.ps1');
const VAULT_FILE = process.env.TOOLSENABLED_VAULT_PATH;

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

// Quiet-desktop rule: every spawn here is windowsHide + shell:false, so no
// console ever flashes and nothing opens a dialog (neither script's verbs
// used below -- add/remove/inventory/get -- can open one anyway).
function run(script, args, options = {}) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, ...args
  ], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    spawnError: result.error ? result.error.message : null
  };
}

// ---------------------------------------------------------------------------
// (a) SOURCE FENCE: both Write-Vault functions must flush before they rename.
// ---------------------------------------------------------------------------

// Comments explain; they do not execute. Strip `# ...` and `<# ... #>` before
// scanning for the executable calls that matter, so a comment may still
// describe WriteAllText (as this very fix's own explanation does) without
// tripping the fence that forbids using it.
function withoutComments(text) {
  return text
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .map(line => {
      let inSingle = false;
      let inDouble = false;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === "'" && !inDouble) inSingle = !inSingle;
        else if (char === '"' && !inSingle) inDouble = !inDouble;
        else if (char === '#' && !inSingle && !inDouble && (index === 0 || /\s/.test(line[index - 1]))) {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join('\n');
}

// Extract one top-level PowerShell function's body by brace depth, from its
// `function Name {` line (both scripts always open on that same line) to the
// line that returns depth to zero. Comments are already stripped above, so a
// brace mentioned only in a comment cannot mislead the count; neither script's
// Write-Vault contains a string literal or here-string with an unmatched
// brace character, so counting every `{`/`}` in the remaining text is exact
// for this specific function in both files.
function functionBody(source, name) {
  const lines = source.split('\n');
  const openerPattern = new RegExp(`^\\s*function\\s+${name}\\s*\\{`);
  const openerIndex = lines.findIndex(line => openerPattern.test(line));
  assert.notEqual(openerIndex, -1, `function ${name} not found`);
  let depth = 0;
  const body = [];
  for (let index = openerIndex; index < lines.length; index += 1) {
    const line = lines[index];
    for (const char of line) {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    body.push(line);
    if (depth === 0) break;
  }
  assert.equal(depth, 0, `function ${name} in the scanned source never closed`);
  return body.join('\n');
}

for (const [label, scriptPath] of [
  ['tools/secrets.ps1', SECRETS_SCRIPT],
  ['tools/secrets-manager.ps1', MANAGER_SCRIPT]
]) {
  check(`${label} Write-Vault flushes the temp file to disk before the atomic rename`, () => {
    const source = withoutComments(fs.readFileSync(scriptPath, 'utf8'));
    const body = functionBody(source, 'Write-Vault');
    assert.match(
      body,
      /\.Flush\(\s*\$true\s*\)/,
      'Write-Vault must call .Flush($true) (FlushFileBuffers) on the temp file before ' +
      'Move-VaultFileAtomically/File.Move renames it into place -- MOVEFILE_WRITE_THROUGH on ' +
      'the rename only makes the NAME durable, never the bytes already in the file being renamed.'
    );
    assert.doesNotMatch(
      body,
      /\[System\.IO\.File\]::WriteAll(?:Text|Bytes)\(/,
      'Write-Vault must not write the vault temp file through File.WriteAllText/WriteAllBytes: ' +
      'neither flushes the OS write-back cache, so a crash between the write and the rename can ' +
      'leave the vault as a truncated or all-NUL file (measured 2026-09-02: 4,352 bytes of NUL).'
    );
  });
}

// ---------------------------------------------------------------------------
// (b) FUNCTIONAL ROUND-TRIP: the fix still leaves a working vault behind.
// ---------------------------------------------------------------------------

const KEY = 'crash_safety_smoke_key';
const VALUE = 'crash-safety-smoke-value-' + Date.now();

check('secrets-manager.ps1 add succeeds and reports the new record', () => {
  const result = run(MANAGER_SCRIPT, ['add', '-Name', KEY, '-Reason', 'vault-write-crash-safety test'], { input: VALUE });
  assert.equal(result.spawnError, null, `manager add did not start: ${result.spawnError}`);
  assert.equal(result.status, 0, `manager add exited ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.name, KEY);
  assert.equal(parsed.state, 'present');
});

check('secrets.ps1 get reads back exactly what secrets-manager.ps1 wrote, from the same vault file', () => {
  const result = run(SECRETS_SCRIPT, ['get', KEY]);
  assert.equal(result.spawnError, null, `secrets get did not start: ${result.spawnError}`);
  assert.equal(result.status, 0, `secrets get exited ${result.status}: ${result.stderr}`);
  assert.equal(result.stdout, VALUE);
});

check('secrets-manager.ps1 inventory reports the record ready', () => {
  const result = run(MANAGER_SCRIPT, ['inventory']);
  assert.equal(result.status, 0, `manager inventory exited ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const entry = (parsed.secrets || []).find(item => item.name === KEY);
  assert.ok(entry, `${KEY} missing from inventory: ${result.stdout}`);
  assert.equal(entry.state, 'ready');
  assert.equal(entry.present, true);
  assert.equal(entry.readable, true);
});

check('the vault file on disk is complete, valid JSON with no embedded NUL byte', () => {
  const bytes = fs.readFileSync(VAULT_FILE);
  assert.ok(bytes.length > 0, 'vault file is empty');
  assert.ok(!bytes.includes(0), 'vault file contains a NUL byte -- exactly the corruption the crash-safety fix exists to prevent');
  assert.doesNotThrow(() => JSON.parse(bytes.toString('utf8')), 'vault file is not valid JSON');
});

check('secrets-manager.ps1 remove succeeds and the key is gone from both halves', () => {
  const result = run(MANAGER_SCRIPT, ['remove', '-Name', KEY, '-Reason', 'vault-write-crash-safety cleanup']);
  assert.equal(result.status, 0, `manager remove exited ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.state, 'removed');
  const getAfterRemove = run(SECRETS_SCRIPT, ['get', KEY]);
  assert.notEqual(getAfterRemove.status, 0, 'secrets.ps1 get should fail once the key is removed');
});

console.log(`\nvault-write-crash-safety: ${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAILED: ${failure.name}`);
    console.error(failure.error && failure.error.stack ? failure.error.stack : failure.error);
  }
  process.exitCode = 1;
}
