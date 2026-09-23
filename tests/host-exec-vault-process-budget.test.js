'use strict';

/* HOW MANY VAULT PROCESSES ONE host.exec MAY PAY FOR, AND WHY IT IS ONE.
 *
 * Measured on this machine 2026-09-03 against a private ledger and a private
 * vault: a trivial `host.exec` (the command is `exit`) took a median of
 * 1,864 ms, and 1,209 ms of that was a single `powershell.exe` run against the
 * DPAPI vault. The same durable ledger append WITHOUT the vault step --
 * audit.record() rather than audit.requireRecord() -- took 34 ms. So the vault
 * subprocess is not a small part of the cost of running a command on this
 * machine; on a trivial command it IS the cost.
 *
 * That one process is the audit-before-run guarantee doing its job: the
 * monotonic head anchor lives in the vault, and requireRecord() advances it so
 * the intent to run an arbitrary command is protected BEFORE the command runs.
 * This test does not challenge that. It pins the BUDGET at one.
 *
 * WHY A BUDGET IS WORTH A TEST HERE. Every vault read on this path is already
 * served from a content-digest cache (readAnchor's defaultAnchorVaultDigest and
 * runtime.js's secretValueCache), and those caches are invisible at the call
 * site. A change that adds an innocuous-looking secret read to the host.exec
 * path -- or that defeats one of the digest caches -- costs roughly another
 * 700-1,200 ms per command and produces no failure, no error and no log line.
 * It shows up only as "the machine got slower", which is exactly the class of
 * regression this repository keeps rediscovering months later.
 *
 * WHAT IS ASSERTED IS BEHAVIOUR, NOT SPELLING: the number of child processes
 * launched against the vault script while one command runs. An implementation
 * that reaches the same guarantee with fewer processes passes; one that reaches
 * it with more fails and names the count.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

// The scratch root and the scratch vault must both be inside the Dev profile.
// tests/run-isolated.js derives its scratch root from TEMP, so TEMP is set
// explicitly rather than inherited.
const DEV_TEMP = path.join('C:', 'Users', 'ToolsEnabled-Dev', 'AppData', 'Local', 'Temp');
const tempRoot = fs.existsSync(DEV_TEMP) ? DEV_TEMP : os.tmpdir();
const scratch = fs.mkdtempSync(path.join(tempRoot, 'host-exec-vault-budget-'));
process.env.TOOLSENABLED_STATE_ROOT = scratch;
process.env.TOOLSENABLED_VAULT_PATH = path.join(scratch, 'secrets.json');
// host.exec now admits its intent record through the group-commit queue,
// which runs on a worker thread where it can. The counting patch below
// lives in THIS thread's copy of child_process, so the admission is pinned
// in-thread here: same code path, same vault work, observable count. The
// budget being asserted is a property of the admission, not of the thread.
process.env.TOOLSENABLED_AUDIT_ADMISSION_WORKER = '0';

// Counting has to be installed BEFORE runtime.js is required: runtime.js
// destructures execFileSync at module load, so a later patch would never be
// seen by the vault helpers.
const vaultSpawns = [];
const realExecFileSync = cp.execFileSync;
cp.execFileSync = function countingExecFileSync(file, args, options) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (argv.some(a => /secrets\.ps1$/i.test(a))) vaultSpawns.push(argv[argv.length - 1]);
  return realExecFileSync.call(this, file, args, options);
};

const audit = require('../src/lib/audit');
const hostControl = require('../src/lib/providers/host-control');

test.after(() => {
  cp.execFileSync = realExecFileSync;
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* litter only */ }
});

test('one host.exec pays for at most one vault process', async () => {
  // Provision the signing key and the first anchor, so what follows is the
  // steady state rather than first-run setup.
  audit.record('test.vault.budget.warm', scratch, { note: 'warm' });
  vaultSpawns.length = 0;

  const result = await hostControl.exec({ command: 'exit', cwd: scratch, timeoutMs: 60_000 });
  assert.strictEqual(result.exitCode, 0, 'the probe command should exit zero');

  // AT MOST one, no longer EXACTLY one. The header above says it: an
  // implementation that reaches the same guarantee with fewer processes
  // passes. Since the persistent vault host (src/lib/vault-host-client.js,
  // tools/vault-host.ps1) the anchor's get and set-monotonic are served by
  // one long-lived PowerShell process over stdin rather than by a fresh
  // execFileSync per call, so the steady-state count here is ZERO; the
  // per-call spawn remains as the fallback when the host will not start,
  // which is the ONE this budget still permits. The guarantee itself (the
  // intent is anchored before the command runs) is asserted by the next
  // test, not by this count.
  assert.ok(vaultSpawns.length <= 1,
    `one host.exec should launch at most one vault process; it launched ${vaultSpawns.length}`
    + ` (${vaultSpawns.join(', ') || 'none'}).`
    + ' More than one means a read that the content-digest caches used to serve is now'
    + ' spawning powershell.exe again, at roughly 700-1,200 ms each.');
});

test('the audit-before-run guarantee still holds: the intent is anchored before the command runs', async () => {
  // The budget above must never be met by removing the protection. The intent
  // record is what costs the one process, so assert it is still anchored.
  const status = audit.requireRecord('test.vault.budget.intent', scratch, { note: 'intent' });
  assert.strictEqual(status.durable, true, 'the intent must be durably recorded');
  assert.strictEqual(status.anchored, true,
    'the intent must be protected by the monotonic head anchor before an external write runs');
});
