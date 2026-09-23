'use strict';

// THE LEAK THIS PINS, reproduced against the REAL VAULT SCRIPT this codebase
// actually spawns (tools/secrets.ps1), not a reduced one-liner: a one-liner
// `ConvertTo-SecureString` probe under this same leaking PSModulePath was
// measured (by a peer, on this same lane) to sometimes autoload fine while
// the real script still fails -- reducing the subject is what lies. A parent
// whose PSModulePath was set by PowerShell 7 hands powershell.exe (5.1) a
// value that includes 7's own module roots. One of them -- the Microsoft
// Store package's Modules directory -- has ACLs a 5.1 module-autoload
// enumeration cannot read, which MEASURED breaks autoload of
// Microsoft.PowerShell.Security, including ConvertTo-SecureString, for the
// whole process. tools/secrets.ps1 encrypts/decrypts every vault entry with
// exactly that cmdlet.
//
// NEVER TOUCHES THE REPOSITORY'S OWN VAULT OR THE SHARED AUDIT LEDGER: both
// runs point TOOLSENABLED_STATE_ROOT and LOCALAPPDATA at a scratch directory
// created and removed by this file, per the lane's mandatory isolated-state
// rule for any vault/audit child.
//
// This test asks the real PowerShell 7 on this machine for its own
// PSModulePath rather than hardcoding one, and SKIPS LOUDLY (named, counted,
// and in the final summary line -- never silently) if pwsh is not present or
// this is not win32: a fully-skipped run must never read the same as a real
// pass. Each case prints its own duration_ms; a real case that spawns
// powershell.exe runs for seconds, a silently-bailed one would return in
// milliseconds -- the cheap oracle for "did this actually run."
//
// Behavior only: asserts on the REAL child's exit code/stdout/stderr, never
// on any implementation spelling of the fix.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stripPowerShellSevenModulePathEntries } = require('../../src/lib/owner-prompt-platform.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'secrets.ps1');

const tests = [];
const skips = [];
function test(name, fn) {
  tests.push([name, fn]);
}
function skip(name, reason) {
  skips.push([name, reason]);
  process.stdout.write(`skip - ${name} (${reason})\n`);
}

function findPwsh() {
  const probe = spawnSync('pwsh.exe', ['-NoProfile', '-Command', '$env:PSModulePath'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 20_000
  });
  if (probe.error || probe.status !== 0) return null;
  const value = String(probe.stdout || '').trim();
  return value || null;
}

// Real script, real verb, real stdin-carried value -- exactly the shape
// src/lib/runtime.js::setSecret() spawns. A synthetic key/value, never a real
// credential, written only under the isolated scratch state root below.
function runRealSecretsScript(psModulePath, scratchRoot) {
  const env = {
    ...process.env,
    PSModulePath: psModulePath,
    TOOLSENABLED_STATE_ROOT: scratchRoot,
    LOCALAPPDATA: path.join(scratchRoot, 'local-appdata')
  };
  return spawnSync('powershell.exe', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT, 'set-stdin', 'psmodulepath-vault-autoload-probe-key'
  ], {
    cwd: ROOT, input: 'synthetic-scratch-value-never-real', encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, env
  });
}

if (process.platform !== 'win32') {
  skip('psmodulepath-vault-autoload', 'not win32, no PowerShell 5.1 to protect (R1226 no-op platform)');
} else {
  const pwshOwnPSModulePath = findPwsh();
  if (!pwshOwnPSModulePath) {
    skip('psmodulepath-vault-autoload', 'pwsh.exe (PowerShell 7) not found on this machine, cannot construct the leaking case');
  } else {
    const scriptHash = require('node:crypto').createHash('sha256').update(fs.readFileSync(SCRIPT)).digest('hex');
    process.stdout.write(`tools/secrets.ps1 sha256: ${scriptHash}\n`);
    process.stdout.write(`inherited PSModulePath under test: ${pwshOwnPSModulePath}\n`);
    assert.match(pwshOwnPSModulePath, /WindowsApps[\\/]Microsoft\.PowerShell_/i,
      'positive-control precondition failed: the inherited PSModulePath does not carry a PS7 WindowsApps entry, so this run cannot exercise the leak at all');

    test('RED (predicted): the real tools/secrets.ps1, run with the inherited PS7 PSModulePath, fails to autoload Microsoft.PowerShell.Security', () => {
      const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'w80-scratch-base-'));
      try {
        const result = runRealSecretsScript(pwshOwnPSModulePath, scratchRoot);
        assert.notEqual(result.status, 0, `expected the unfixed PS7 PSModulePath to break the real script; got status ${result.status}, stdout=${JSON.stringify(result.stdout)}`);
        assert.match(String(result.stderr || ''), /CouldNotAutoloadMatchingModule/);
      } finally {
        fs.rmSync(scratchRoot, { recursive: true, force: true });
      }
    });

    test('GREEN (fixed): the same real tools/secrets.ps1, run with stripPowerShellSevenModulePathEntries applied, stores the value', () => {
      const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'w80-scratch-fixed-'));
      try {
        const scrubbed = stripPowerShellSevenModulePathEntries({ PSModulePath: pwshOwnPSModulePath }, {
          platform: 'win32', childExecutable: 'powershell.exe'
        }).PSModulePath;
        assert.doesNotMatch(scrubbed, /WindowsApps[\\/]Microsoft\.PowerShell_/i, 'the fix must have actually removed the WindowsApps entry before this case can be evidence of anything');
        const result = runRealSecretsScript(scrubbed, scratchRoot);
        assert.equal(result.status, 0, `expected the scrubbed PSModulePath to let the real script succeed; got status ${result.status}, stderr=${result.stderr}`);
        assert.match(String(result.stderr || ''), /stored 'psmodulepath-vault-autoload-probe-key'/);
      } finally {
        fs.rmSync(scratchRoot, { recursive: true, force: true });
      }
    });
  }
}

let failures = 0;
for (const [name, fn] of tests) {
  const startedAt = Date.now();
  try {
    fn();
    process.stdout.write(`ok - ${name} (duration_ms: ${Date.now() - startedAt})\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`not ok - ${name} (duration_ms: ${Date.now() - startedAt})\n${error.stack}\n`);
  }
}

// Always prints a summary line, even (especially) when every case was
// skipped -- a run that skipped everything must never look, on this line
// alone, like a run that passed everything.
process.stdout.write(`psmodulepath-vault-autoload: ${tests.length} ran, ${failures} failed, ${skips.length} skipped\n`);
if (failures > 0) process.exitCode = 1;
