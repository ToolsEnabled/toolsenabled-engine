'use strict';
/* WHETHER A VAULT RECORD IS SERVED BY ONE PERSISTENT PROCESS OR A FRESH ONE
 * PER CALL.
 *
 * THE DEFECT, measured 2026-09-04 against a private scratch vault (never the
 * installation's): a per-call `powershell.exe -File tools/secrets.ps1 get
 * <key>`, called through src/lib/runtime.js exactly as every real caller
 * does, cost 727 ms on average across 10 sequential reads (7,274 ms total) --
 * almost all of it powershell.exe's own startup, the same fixed cost
 * RESTART-STATE/CONTROLLER-BRIEF.md measures for host.exec (5.5 s median,
 * ~2.0 s floor). src/lib/vault-host-client.js and tools/vault-host.ps1 keep
 * one such process running and answer requests over its stdin/stdout
 * instead: measured the same way, 10 reads through
 * src/lib/vault-host-client.js totalled 1,137 ms (990 ms paying the one
 * host's own startup, the remaining 9 averaging 16 ms).
 *
 * THIS FILE ASSERTS BEHAVIOUR AND MECHANISM, NOT THE CLOCK, for the reason
 * tests/vault-spawn-cost.test.js's own header already gives: a timing budget
 * on a machine running many agents manufactures failures that have nothing to
 * do with this code. "One process served every request" is instead proved by
 * asking the OS for that process's identity (its PID) across many requests
 * and confirming it never changes and always names a process that is really
 * running -- a claim a fake counter could not fabricate.
 *
 * EVERY SECRECY RULE FROM THE PER-CALL SPAWN CARRIES OVER, and the checks
 * below hold the host to it: a value reaches the host only as base64 inside
 * a JSON line on its stdin, never as an argument to the one spawn that
 * starts the host process itself.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const WINDOWS = process.platform === 'win32';

function freshVault(label) {
  const base = WINDOWS && !/~/.test(os.homedir())
    ? path.join(os.homedir(), 'AppData', 'Local', 'Temp')
    : os.tmpdir();
  const directory = fs.mkdtempSync(path.join(base, `vault-host-${label}-`));
  return { directory, file: path.join(directory, 'secrets.json') };
}

// Each test gets an isolated process.env vault redirect and a clean require
// cache, so one test's host process (and the module-level singleton that
// owns it) never leaks into the next.
async function withIsolatedVault(label, run) {
  const vault = freshVault(label);
  const priorVaultPath = process.env.TOOLSENABLED_VAULT_PATH;
  const priorStateRoot = process.env.TOOLSENABLED_STATE_ROOT;
  const priorHostOverride = process.env.TOOLSENABLED_VAULT_HOST_SCRIPT_OVERRIDE;
  process.env.TOOLSENABLED_VAULT_PATH = vault.file;
  delete process.env.TOOLSENABLED_STATE_ROOT;
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}lib${path.sep}runtime.js`)
      || key.includes(`${path.sep}src${path.sep}lib${path.sep}vault-host-client.js`)) {
      delete require.cache[key];
    }
  }
  const runtime = require(path.join(REPO, 'src', 'lib', 'runtime.js'));
  const client = require(path.join(REPO, 'src', 'lib', 'vault-host-client.js'));
  try {
    return await run({ runtime, client, vault });
  } finally {
    await client.terminateVaultHostForTests();
    if (priorVaultPath === undefined) delete process.env.TOOLSENABLED_VAULT_PATH;
    else process.env.TOOLSENABLED_VAULT_PATH = priorVaultPath;
    if (priorStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
    else process.env.TOOLSENABLED_STATE_ROOT = priorStateRoot;
    if (priorHostOverride === undefined) delete process.env.TOOLSENABLED_VAULT_HOST_SCRIPT_OVERRIDE;
    else process.env.TOOLSENABLED_VAULT_HOST_SCRIPT_OVERRIDE = priorHostOverride;
    fs.rmSync(vault.directory, { recursive: true, force: true });
  }
}

test('reads and monotonic writes through the host answer exactly what the vault holds',
  { skip: !WINDOWS }, async () => {
    await withIsolatedVault('behaviour', ({ runtime }) => {
      runtime.setSecret('github_pat', 'scratch-value-not-real');
      assert.equal(runtime.getSecret('github_pat'), 'scratch-value-not-real',
        'a value stored before the host existed must still read back correctly through it');

      assert.throws(() => runtime.getSecret('never_configured_key'),
        error => error.code === 'SECRET_NOT_CONFIGURED',
        'a genuinely absent key must still be reported as SECRET_NOT_CONFIGURED, not a transport failure');

      const first = runtime.setMonotonicSecret('anchor_key', JSON.stringify({ sequence: 1, x: 'a' }), 1);
      assert.match(first, /^[a-f0-9]{64}$/, 'a successful monotonic write must still report a vault content digest');

      const replay = runtime.setMonotonicSecret('anchor_key', JSON.stringify({ sequence: 1, x: 'a' }), 1);
      assert.equal(replay, first, 'replaying the same sequence with the same value must still succeed and report the same digest');

      assert.throws(() => runtime.setMonotonicSecret('anchor_key', JSON.stringify({ sequence: 0, x: 'a' }), 0),
        /Unable to advance monotonic secret/,
        'a backward sequence move must still be refused');
    });
  });

test('one persistent OS process answers many requests, across both get and set-monotonic-stdin',
  { skip: !WINDOWS }, async () => {
    await withIsolatedVault('pid', ({ runtime, client }) => {
      runtime.setSecret('github_pat', 'scratch-value-not-real');

      const pids = [];
      for (let i = 0; i < 5; i++) {
        assert.equal(runtime.getSecret('github_pat'), 'scratch-value-not-real');
        pids.push(client.diagnosticHostPid());
      }
      runtime.setMonotonicSecret('anchor_key', JSON.stringify({ sequence: 1, x: 'a' }), 1);
      pids.push(client.diagnosticHostPid());

      assert.ok(pids.every(pid => typeof pid === 'number' && pid > 0),
        `every request must be answerable by a real host process, got: ${JSON.stringify(pids)}`);
      assert.ok(pids.every(pid => pid === pids[0]),
        `all six requests must have been served by the SAME process, not a fresh one each time; saw: ${JSON.stringify(pids)}`);
      // Not fabricated: the PID this module reports must name a process that
      // is actually alive right now. process.kill(pid, 0) checks liveness
      // without sending a real signal.
      assert.doesNotThrow(() => process.kill(pids[0], 0),
        `the reported PID ${pids[0]} must be a live process, not a made-up number`);
    });
  });

test('the host restarts after its process exits, and the new one is a different live PID',
  { skip: !WINDOWS }, async () => {
    await withIsolatedVault('restart', async ({ client }) => {
      const before = client.diagnosticHostPid();
      assert.ok(before, 'a host must be reachable before it can be tested exiting');

      await client.terminateVaultHostForTests();

      const after = client.diagnosticHostPid();
      assert.ok(after, 'a request made after the host process died must still be answered -- by a restarted host');
      assert.notEqual(after, before, 'the restarted host must be a genuinely new process, not the dead one reporting stale state');
      assert.doesNotThrow(() => process.kill(after, 0), `the restarted PID ${after} must be a live process`);
    });
  });

test('a vault host that cannot start still lets a read and a monotonic write succeed, by falling back',
  { skip: !WINDOWS }, async () => {
    const priorOverride = process.env.TOOLSENABLED_VAULT_HOST_SCRIPT_OVERRIDE;
    // A path with no file behind it: the worker's own spawn of powershell.exe
    // against this script fails to start the host, which must degrade every
    // call back to today's per-call spawn rather than raising a transport
    // error to the caller.
    process.env.TOOLSENABLED_VAULT_HOST_SCRIPT_OVERRIDE = path.join(os.tmpdir(), 'does-not-exist-vault-host.ps1');
    try {
      await withIsolatedVault('fallback', ({ runtime, client }) => {
        runtime.setSecret('github_pat', 'scratch-value-not-real');
        assert.equal(runtime.getSecret('github_pat'), 'scratch-value-not-real',
          'a read must still succeed through the per-call fallback when the host script is missing');
        const digest = runtime.setMonotonicSecret('anchor_key', JSON.stringify({ sequence: 1, x: 'a' }), 1);
        assert.match(digest, /^[a-f0-9]{64}$/,
          'a monotonic write must still succeed through the per-call fallback when the host script is missing');
        assert.equal(client.diagnosticHostPid(), null,
          'a host that cannot start must report no PID rather than a fabricated one');
      });
    } finally {
      if (priorOverride === undefined) delete process.env.TOOLSENABLED_VAULT_HOST_SCRIPT_OVERRIDE;
      else process.env.TOOLSENABLED_VAULT_HOST_SCRIPT_OVERRIDE = priorOverride;
    }
  });

test('a changed vault binding retires the host and reads the new store', { skip: !WINDOWS }, async () => {
  await withIsolatedVault('binding', ({ runtime, client, vault }) => {
    runtime.setSecret('custom.binding_fixture', 'first-synthetic-value');
    assert.equal(runtime.getSecret('custom.binding_fixture'), 'first-synthetic-value');
    const firstPid = client.diagnosticHostPid();
    const second = path.join(vault.directory, 'second', 'secrets.json');
    process.env.TOOLSENABLED_VAULT_PATH = second;
    require('../src/lib/vault-location').resetVaultLocationForTests();
    runtime.setSecret('custom.binding_fixture', 'second-synthetic-value');
    assert.equal(runtime.getSecret('custom.binding_fixture'), 'second-synthetic-value');
    const secondPid = client.diagnosticHostPid();
    assert.ok(secondPid && secondPid !== firstPid);
    process.env.TOOLSENABLED_VAULT_PATH = vault.file;
    require('../src/lib/vault-location').resetVaultLocationForTests();
    assert.equal(runtime.getSecret('custom.binding_fixture'), 'first-synthetic-value');
    assert.notEqual(client.diagnosticHostPid(), secondPid);
  });
});

test('a lost reply after delivery refuses without repeating the mutation through a fallback', { skip: !WINDOWS }, async () => {
  await withIsolatedVault('uncertain', async ({ runtime, client, vault }) => {
    const fake = path.join(vault.directory, 'lost-reply.ps1');
    const marker = path.join(vault.directory, 'delivered');
    fs.writeFileSync(fake, [
      "[Console]::Error.WriteLine('vault-host-ready')",
      '[Console]::Error.Flush()',
      '$line = [Console]::In.ReadLine()',
      "[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'delivered'), 'delivered')",
      'exit 7'
    ].join('\n'));
    process.env.TOOLSENABLED_VAULT_HOST_SCRIPT_OVERRIDE = fake;
    assert.throws(() => runtime.setMonotonicSecret('custom.uncertain_fixture', JSON.stringify({ sequence: 1 }), 1),
      /Unable to advance monotonic secret/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'delivered');
    assert.equal(fs.existsSync(vault.file), false, 'the one-shot fallback must not create a vault after uncertain delivery');
    await client.terminateVaultHostForTests();
  });
});

test('a secret value never appears as an argument to the one spawn that starts the host process',
  { skip: !WINDOWS }, () => {
    // The host process itself is started with a fixed, literal argument list
    // (see tools/vault-host.ps1's own path and flags below) -- no per-request
    // field, and specifically no secret value, can reach it, because that
    // spawn happens once, before any request exists to smuggle a value into
    // it. Every later request's value travels over the already-open stdin
    // pipe instead. This reads the source rather than fabricating a value and
    // hoping to see it on a command line, because command-line arguments are
    // visible to every local process for the process's whole lifetime --
    // proving a value's absence there has to be structural, not probabilistic.
    const workerSource = fs.readFileSync(
      path.join(REPO, 'src', 'lib', 'vault-host', 'worker.js'), 'utf8'
    );
    const spawnCall = /spawn\('powershell\.exe',\s*\[([\s\S]*?)\]/.exec(workerSource);
    assert.ok(spawnCall, 'worker.js must still start the host with child_process.spawn');
    assert.doesNotMatch(spawnCall[1], /payload|value|env\)/,
      'the host process\'s own argument list must never reference a per-request field');
    assert.match(workerSource, /child\.stdin\.write/,
      'a request must still cross to the host over its stdin, not as a spawn argument');
  });

test('wrapping the dispatch in Invoke-VaultAction did not disable its own -Key/-PromptLabel/-PromptHint guards',
  { skip: !WINDOWS }, () => {
    // THE REGRESSION THIS TEST EXISTS FOR. Moving the verb dispatch into a
    // function (Invoke-VaultAction, so tools/vault-host.ps1 can call it once
    // per request) meant every `$PSBoundParameters.ContainsKey(...)` guard
    // inside it started reading THAT FUNCTION's own bound parameters --
    // always empty, since Invoke-VaultAction takes none -- instead of the
    // script's. Confirmed directly: a script bound with -Key 'x' reports
    // $PSBoundParameters.ContainsKey('Key') as $true at script scope and
    // $false inside a same-file function with no parameter of its own, even
    // though $Key itself still carries 'x' there by ordinary variable
    // scoping. Three guards read $PSBoundParameters from inside that
    // function and so silently stopped firing: 'scrub-payment-card-cvc's
    // own key-binding refusal (caught by
    // tests/secrets/run.js -- 2026-09-04, "scrub accepted a different key"),
    // and the -PromptLabel / -PromptHint argument-smuggling-slot guards
    // below it, which had NO test coverage at all before this one. All three
    // are none of them reachable through the host (see
    // tools/vault-host.ps1's $HostAllowedActions), so this only ever
    // exercises the plain per-call CLI, exactly as a real caller would.
    const vault = freshVault('psbound-guards');
    const script = path.join(REPO, 'tools', 'secrets.ps1');
    const environment = { ...process.env, TOOLSENABLED_VAULT_PATH: vault.file };
    delete environment.TOOLSENABLED_STATE_ROOT;
    function run(args) {
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, ...args
      ], { cwd: REPO, encoding: 'utf8', windowsHide: true, shell: false, env: environment });
      return result;
    }
    try {
      const wrongKey = run(['scrub-payment-card-cvc', 'not_the_card_key']);
      assert.notEqual(wrongKey.status, 0, 'scrub-payment-card-cvc must still refuse a key other than payment_card_default');
      assert.match(wrongKey.stderr, /only ever operates on 'payment_card_default'/,
        'the refusal must still be the scrub verb\'s own wrong-key message');

      const rightKey = run(['scrub-payment-card-cvc', 'payment_card_default']);
      assert.equal(rightKey.status, 0, 'the legitimate key must still be accepted');

      const badPromptLabel = run(['get', 'github_pat', '-PromptLabel', 'not a prompt action']);
      assert.notEqual(badPromptLabel.status, 0, "-PromptLabel must still be refused on an action that is not a prompt");
      assert.match(badPromptLabel.stderr, /-PromptLabel is valid only with action/,
        'the refusal must still be the -PromptLabel guard\'s own message');

      const badPromptHint = run(['get', 'github_pat', '-PromptHint', 'not a prompt action either']);
      assert.notEqual(badPromptHint.status, 0, "-PromptHint must still be refused on an action that is not a prompt");
      assert.match(badPromptHint.stderr, /-PromptHint is valid only with action/,
        'the refusal must still be the -PromptHint guard\'s own message -- an accepted-but-ignored -PromptHint is an argument-smuggling slot');
    } finally {
      fs.rmSync(vault.directory, { recursive: true, force: true });
    }
  });
