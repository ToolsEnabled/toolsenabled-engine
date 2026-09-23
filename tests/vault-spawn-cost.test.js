'use strict';
/* WHAT A VAULT SPAWN IS ALLOWED TO DO BEFORE IT ANSWERS.
 *
 * THE DEFECT, measured on the owner's machine 2026-09-03 against a PRIVATE
 * scratch vault (never the installation's). One
 * `powershell.exe -File tools/secrets.ps1 get <key>` had a median of 881 ms,
 * and two things it did not need accounted for a third of it:
 *
 *   tools/secrets.ps1 dot-sourced tools/owner-prompt-theme.ps1 at script
 *   scope, on every verb. That file loads System.Windows.Forms and
 *   System.Drawing, compiles a SetProcessDPIAware P/Invoke with `Add-Type
 *   -MemberDefinition`, and calls it. Dot-sourcing it: 258.9 / 283.6 /
 *   292.3 ms. A `get` opens no window.
 *
 *   tools/lib/vault-acl.ps1 ran `Add-Type -TypeDefinition` for
 *   ToolsEnabledVaultAtomicFile at dot-source scope, on every verb. That
 *   invokes the C# compiler in-process: 208.5 / 213.8 / 252.7 ms. The type is
 *   used by exactly one function, Move-VaultFileAtomically, which is called by
 *   exactly one caller, Write-Vault. No read verb can reach it.
 *
 * Both are now loaded where they are used. Paired, interleaved A/B against the
 * same scratch vault, nine rounds each, arms alternating so neither always ran
 * first:
 *
 *                    before      after
 *   get              881.1 ms   543.6 ms   -38.3%
 *   get-many         920.8 ms   558.9 ms   -39.3%
 *   present          830.0 ms   550.5 ms   -33.7%
 *   list             790.5 ms   490.1 ms   -38.0%
 *   set-stdin       1100.3 ms  1049.2 ms    -4.6%
 *
 * The write barely moves, and that is the expected shape rather than a
 * disappointment: a write still compiles the atomic-replacement type, and it
 * used to get that compile cheaply because the theme's Add-Type had already
 * warmed the compiler. What it stops paying for is the GUI stack.
 *
 * WALL CLOCK IS NOT WHAT THIS FILE ASSERTS. A timing budget on a machine
 * running twelve agents manufactures kills, which is why tests/audit-lock-scope
 * asserts spawn COUNTS. The same reasoning applies one level down: the checks
 * below assert what a spawn LOADS, by asking the process itself, so they are
 * indifferent to load and fail on the mechanism rather than on the weather.
 *
 * AND THEY MUST NOT BE PASSABLE BY DELETION. Check 2 requires that a write
 * still compiles the atomic-replacement primitive and can still call it, so
 * "make the read fast by removing the no-backup replacement" fails here rather
 * than shipping. Check 4 requires that the access log for a full verb sequence
 * is exactly what it was, so no future speed-up can buy time by dropping a line
 * from the record of what was read.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const SECRETS = path.join(REPO, 'tools', 'secrets.ps1');
const VAULT_ACL = path.join(REPO, 'tools', 'lib', 'vault-acl.ps1');
const WINDOWS = process.platform === 'win32';

// The probe: run one verb, then ask the process that ran it what it loaded.
//
// THE VERB'S OUTPUT NEVER LEAVES THE PROBE PROCESS. `get` prints a decrypted
// secret, and it prints it with [Console]::Out.Write, which goes to the console
// handle and is NOT caught by PowerShell's `*>` redirection -- the first draft
// of this file learned that by finding a scratch secret in the assertion
// message. So the console writer itself is swapped for TextWriter.Null across
// the call and restored afterwards. What crosses back to the test is four
// booleans and nothing else.
const PROBE = [
  '$ErrorActionPreference = "Continue"',
  '$script = $env:TOOLSENABLED_SPAWN_PROBE_SCRIPT',
  '$verb = $env:TOOLSENABLED_SPAWN_PROBE_VERB',
  '$arg = $env:TOOLSENABLED_SPAWN_PROBE_ARG',
  '$realOut = [Console]::Out',
  '[Console]::SetOut([System.IO.TextWriter]::Null)',
  'try { if ($arg) { & $script $verb $arg *> $null } else { & $script $verb *> $null } } catch { } finally { [Console]::SetOut($realOut) }',
  '$loaded = @([AppDomain]::CurrentDomain.GetAssemblies() | ForEach-Object { $_.GetName().Name })',
  '$answer = [ordered]@{}',
  '$answer.winForms = [bool]($loaded -contains "System.Windows.Forms")',
  '$answer.drawing = [bool]($loaded -contains "System.Drawing")',
  '$answer.atomicType = ($null -ne ("ToolsEnabledVaultAtomicFile" -as [type]))',
  '$answer.atomicLocation = if ($answer.atomicType) { [string]([ToolsEnabledVaultAtomicFile].Assembly.Location) } else { "" }',
  '$answer.dpiType = ($null -ne ("ToolsEnabled.DpiAwareness" -as [type]))',
  '[Console]::Out.Write(($answer | ConvertTo-Json -Compress))'
].join('; ');

function scratchVault(label) {
  // Never os.tmpdir() blindly: on this platform it can be an 8.3 short path,
  // which the state-root account fence refuses. Home-relative Temp is the same
  // directory the isolated test environment uses.
  const base = WINDOWS && !/~/.test(os.homedir())
    ? path.join(os.homedir(), 'AppData', 'Local', 'Temp')
    : os.tmpdir();
  const directory = fs.mkdtempSync(path.join(base, `vault-spawn-${label}-`));
  return { directory, file: path.join(directory, 'secrets.json') };
}

function vaultEnvironment(vaultFile, stateRoot) {
  const environment = { ...process.env, TOOLSENABLED_VAULT_PATH: vaultFile };
  // The script prefers TOOLSENABLED_VAULT_PATH, but leaving a state root set
  // would let a failure to honour it land somewhere else and pass quietly.
  delete environment.TOOLSENABLED_STATE_ROOT;
  // A test that names a state root is asking where the write keeps the
  // compiled replacement type; the vault path above still wins for the vault.
  if (stateRoot) environment.TOOLSENABLED_STATE_ROOT = stateRoot;
  return environment;
}

function runVerb(vaultFile, args, input, stateRoot) {
  const options = {
    cwd: REPO, encoding: 'utf8', windowsHide: true, shell: false, env: vaultEnvironment(vaultFile, stateRoot),
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']
  };
  if (input !== undefined) options.input = input;
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', SECRETS, ...args
    ], options);
    return 'ok';
  } catch (error) {
    return `exit ${error.status}`;
  }
}

// Runs one verb under the probe and returns what the process ended up holding.
// Verbs that call `exit` are unusable here (the probe never gets to speak), so
// the read side is exercised with 'get' and 'list', which fall through.
function probe(vaultFile, verb, argument, input, stateRoot) {
  const environment = vaultEnvironment(vaultFile, stateRoot);
  environment.TOOLSENABLED_SPAWN_PROBE_SCRIPT = SECRETS;
  environment.TOOLSENABLED_SPAWN_PROBE_VERB = verb;
  environment.TOOLSENABLED_SPAWN_PROBE_ARG = argument || '';
  const options = {
    cwd: REPO, encoding: 'utf8', windowsHide: true, shell: false, env: environment,
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']
  };
  if (input !== undefined) options.input = input;
  const stdout = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-Command', PROBE
  ], options);
  return JSON.parse(String(stdout).trim());
}

const PROBE_SECRET = 'scratch-value-that-is-not-a-real-secret';

test('a vault READ loads no GUI stack and compiles no write primitive', { skip: !WINDOWS }, () => {
  const vault = scratchVault('read');
  try {
    assert.equal(runVerb(vault.file, ['set-stdin', 'github_pat'], PROBE_SECRET), 'ok',
      'precondition: the scratch vault must hold a key to read');

    for (const [verb, argument] of [['get', 'github_pat'], ['list', null]]) {
      const held = probe(vault.file, verb, argument);
      assert.equal(held.winForms, false,
        `'${verb}' loaded System.Windows.Forms. A read verb opens no window; loading the GUI stack `
        + 'cost 259-292 ms on every read, including the two-second bridge poll.');
      assert.equal(held.dpiType, false,
        `'${verb}' compiled the SetProcessDPIAware P/Invoke. Nothing a read verb does can create a window.`);
      assert.equal(held.atomicType, false,
        `'${verb}' compiled ToolsEnabledVaultAtomicFile. Only Write-Vault replaces the vault file, and `
        + 'no read verb calls it; the C# compiler cost 208-253 ms for a type the verb cannot use.');
    }
  } finally {
    fs.rmSync(vault.directory, { recursive: true, force: true });
  }
});

test('a vault WRITE still has the atomic no-backup replacement, and still needs no GUI stack',
  { skip: !WINDOWS }, () => {
    const vault = scratchVault('write');
    try {
      // The FIRST write creates the file and takes File.Move, which needs no
      // native helper. The atomic no-backup replacement is what happens to a
      // vault that already exists, so seed one and measure the second write.
      assert.equal(runVerb(vault.file, ['set-stdin', 'github_pat'], PROBE_SECRET), 'ok',
        'precondition: the scratch vault must already exist, so the write REPLACES it');
      const held = probe(vault.file, 'set-stdin', 'github_pat', PROBE_SECRET);
      // THE MUTATION GUARD. Making the read fast by deleting the replacement
      // primitive would pass the check above and fail this one.
      assert.equal(held.atomicType, true,
        'a write no longer compiles ToolsEnabledVaultAtomicFile. The vault must still be replaced through '
        + 'MoveFileEx with REPLACE_EXISTING | WRITE_THROUGH and no backup file: File.Replace leaves a '
        + 'complete encrypted copy of the pre-mutation vault behind.');
      assert.equal(held.winForms, false, 'a write verb opens no window either');
      assert.equal(fs.existsSync(vault.file), true, 'the write must actually have produced a vault file');

      // ...and the primitive must still WORK, not merely exist.
      const source = path.join(vault.directory, 'replace-source.txt');
      const destination = path.join(vault.directory, 'replace-destination.txt');
      fs.writeFileSync(source, 'after');
      fs.writeFileSync(destination, 'before');
      const script = [
        '$ErrorActionPreference = "Stop"',
        '. $env:TOOLSENABLED_SPAWN_PROBE_ACL',
        'Move-VaultFileAtomically -Source $env:TOOLSENABLED_SPAWN_PROBE_SRC -Destination $env:TOOLSENABLED_SPAWN_PROBE_DST'
      ].join('; ');
      execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script
      ], {
        cwd: REPO, encoding: 'utf8', windowsHide: true, shell: false,
        env: {
          ...process.env,
          TOOLSENABLED_SPAWN_PROBE_ACL: VAULT_ACL,
          TOOLSENABLED_SPAWN_PROBE_SRC: source,
          TOOLSENABLED_SPAWN_PROBE_DST: destination
        }
      });
      assert.equal(fs.readFileSync(destination, 'utf8'), 'after',
        'Move-VaultFileAtomically must still replace the destination');
      assert.equal(fs.existsSync(source), false, 'the staged file must be gone after the replacement');
      assert.deepEqual(
        fs.readdirSync(vault.directory).filter(name => /\.bak$/i.test(name)), [],
        'the replacement must leave no backup: a backup of a vault is a complete encrypted copy of it');
    } finally {
      fs.rmSync(vault.directory, { recursive: true, force: true });
    }
  });

test('the owner-prompt theme is still loaded for every verb that can open a window',
  { skip: !WINDOWS }, () => {
    const source = fs.readFileSync(SECRETS, 'utf8');
    // The dot-source may no longer stand at column 0: an unconditional load is
    // exactly the cost this change removed.
    assert.equal(/^\. \(Join-Path \$PSScriptRoot 'owner-prompt-theme\.ps1'\)/m.test(source), false,
      'owner-prompt-theme.ps1 is dot-sourced unconditionally again; every read verb pays ~275 ms for a GUI stack');
    const gate = /if \(\$Action -eq '([a-z-]+)' -or \$Action -eq '([a-z-]+)'\) \{\n {4}\. \(Join-Path \$PSScriptRoot 'owner-prompt-theme\.ps1'\)\n\}/
      .exec(source);
    assert.ok(gate, 'the theme must be loaded behind an $Action gate naming the verbs that can open a window');
    // Both, and it matters which. 'prompt-payment-card' is the only reader of
    // the theme tokens; 'prompt-set' reads none of them but builds a
    // System.Windows.Forms.Form, and the SetProcessDPIAware call this file
    // makes has to happen before any window exists in the process or Windows
    // virtualizes it and the dialog paints letterboxed inside its own frame.
    assert.deepEqual([gate[1], gate[2]].sort(), ['prompt-payment-card', 'prompt-set'],
      'the gate must name both dialog verbs; dropping prompt-set silently loses its DPI awareness');
    // Every branch that puts a form on screen must be behind that gate.
    for (const dialog of ['Invoke-CredentialPrompt', 'Invoke-PaymentCardPrompt']) {
      const calls = source.split('\n').filter(line => new RegExp(`^\\s{4,}${dialog} `).test(line));
      assert.ok(calls.length >= 1, `${dialog} is no longer called from an action branch`);
    }
  });

test('the access log records the same lines it always did', { skip: !WINDOWS }, () => {
  const vault = scratchVault('log');
  try {
    const sequence = [
      [['set-stdin', 'github_pat'], 'scratch-alpha'],
      [['set-stdin', 'github_pat'], 'scratch-beta'],
      [['get', 'github_pat'], undefined],
      [['get-many', '-Keys', 'github_pat,absent_key'], undefined],
      [['list'], undefined],
      [['exists', 'github_pat'], undefined],
      [['get', 'payment_card_default'], undefined],
      [['del', '-Key', 'github_pat'], undefined]
    ];
    for (const [args, input] of sequence) runVerb(vault.file, args, input);

    const logFile = `${vault.file}.access.log`;
    assert.ok(fs.existsSync(logFile), 'the access log must exist beside the vault');
    const entries = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
      const parsed = JSON.parse(line);
      assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/, 'every line carries a timestamp');
      assert.equal(typeof parsed.pid, 'number', 'every line carries the process that asked');
      delete parsed.ts;
      delete parsed.pid;
      return parsed;
    });
    // Exactly this, in exactly this order. Reads are logged, the replacement of
    // an existing record is distinguished from the creation of one, the
    // denylist refusal is recorded as a refusal, and the removal is recorded
    // with what was on file at the moment it was taken away.
    assert.deepEqual(entries, [
      { action: 'set-stdin', key: 'github_pat', replaced: false },
      { action: 'set-stdin', key: 'github_pat', replaced: true },
      { action: 'get', key: 'github_pat' },
      { action: 'get-many', key: 'github_pat' },
      { action: 'get-many', key: 'absent_key' },
      { action: 'list', resultCount: 1 },
      { action: 'exists', key: 'github_pat', present: true },
      { action: 'get', key: 'payment_card_default', denied: true },
      { action: 'del', key: 'github_pat', present: true }
    ], 'the access log is the record of what was read; no speed-up may shorten it');
  } finally {
    fs.rmSync(vault.directory, { recursive: true, force: true });
  }
});

test('the atomic-replacement type is compiled where it is used, not on every spawn',
  { skip: !WINDOWS }, () => {
    const source = fs.readFileSync(VAULT_ACL, 'utf8');
    const functionStart = source.indexOf('function Move-VaultFileAtomically');
    assert.ok(functionStart > 0, 'Move-VaultFileAtomically is no longer in vault-acl.ps1');
    // Every place the compiler is actually invoked -- prose in a comment does
    // not count -- has to sit inside that function.
    const compiles = [...source.matchAll(/^[ \t]*Add-Type -TypeDefinition/gm)].map(match => match.index);
    assert.ok(compiles.length >= 1, 'the atomic-replacement type is no longer compiled at all');
    for (const at of compiles) {
      assert.ok(at > functionStart,
        'a C# compile runs at dot-source scope in vault-acl.ps1 again, so every read verb pays 208-253 ms for it');
    }
    // The guard is what keeps it once per process now that the call site runs
    // per replacement rather than once at dot-source.
    assert.match(source.slice(functionStart),
      /if \(\$null -eq \('ToolsEnabledVaultAtomicFile' -as \[type\]\)\) \{\n\s+Install-VaultAtomicFileType/,
      'the install must stay guarded by the type check, or a busy writer reinstalls it per call');
    assert.match(source, /MoveFileReplaceExisting \| MoveFileWriteThrough/,
      'the replacement must stay REPLACE_EXISTING | WRITE_THROUGH');
    // Actual native exception codes and preserved destination state are
    // exercised by vault-atomic-sharing.test.js. Do not require GetLastWin32Error
    // to be inline in a throw: bounded retries must capture it before waiting.
  });

// THE COMPILE ITSELF, ONCE PER MACHINE RATHER THAN ONCE PER WRITE.
//
// "Once per process" for a vault write meant "once per write": every verb is a
// fresh powershell.exe, so every `set-monotonic-stdin` -- the audit head-anchor
// advance behind every external-write tool call -- spawned csc.exe again for
// the same 20 lines of C#, inside the vault lock. Measured 2026-09-03 with an
// in-script phase trace against a private scratch vault, paired runs alternating
// with the unfixed script: the Move-VaultFileAtomically step was 295 / 339 /
// 314 / 327 ms unfixed and 63 / 68 / 67 / 68 ms with the compiled type kept on
// disk, of a ~1.0-1.5 s script body.
//
// WHAT IS ASSERTED IS THE MECHANISM, NOT THE CLOCK, for the reason the file
// header gives. The probe reports the assembly LOCATION of the type the write
// used: an in-process compile has none, a cache load names the file. So the
// first check fails exactly when the cache stops being consulted, or stops
// being seeded, whichever way the code breaks; and the second fails if an
// unusable cache directory is ever allowed to fail the write it only exists
// to speed up.
function scratchStateRoot(label) {
  const base = WINDOWS && !/~/.test(os.homedir())
    ? path.join(os.homedir(), 'AppData', 'Local', 'Temp')
    : os.tmpdir();
  return fs.mkdtempSync(path.join(base, `vault-cache-${label}-`));
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

test('a vault WRITE keeps the compiled replacement type beside the state root and loads it from there',
  { skip: !WINDOWS }, () => {
    const vault = scratchVault('cache');
    const stateRoot = scratchStateRoot('root');
    const cacheDirectory = path.join(stateRoot, 'state', 'vault-atomic-file-cache');
    try {
      assert.equal(fs.existsSync(cacheDirectory), false, 'precondition: the cache starts absent');
      // The first write creates the vault with File.Move and needs no native
      // helper; the SECOND replaces it, which is the write that compiles.
      assert.equal(runVerb(vault.file, ['set-stdin', 'github_pat'], PROBE_SECRET, stateRoot), 'ok');
      assert.equal(runVerb(vault.file, ['set-stdin', 'github_pat'], PROBE_SECRET, stateRoot), 'ok');

      const seeded = fs.existsSync(cacheDirectory) ? fs.readdirSync(cacheDirectory) : [];
      const entries = seeded.filter(name => /^atomic-[0-9a-f]{32}\.dll$/.test(name));
      assert.equal(entries.length, 1,
        `the replacing write must seed exactly one content-addressed entry, found: ${JSON.stringify(seeded)}`);
      assert.deepEqual(seeded, entries,
        'the staged temp copy must not survive the seed; a leftover is a failed rename nobody will see');
      assert.deepEqual(fs.readdirSync(vault.directory).filter(name => /\.dll$/i.test(name)), [],
        'nothing is ever cached inside the vault directory: a mapped DLL would pin it against the local-data reset');

      const held = probe(vault.file, 'set-stdin', 'github_pat', PROBE_SECRET, stateRoot);
      assert.equal(held.atomicType, true, 'the write must still install the replacement type');
      assert.ok(samePath(held.atomicLocation, path.join(cacheDirectory, entries[0])),
        `a later write must load the type from the cache entry, not compile it again; loaded from: '${held.atomicLocation}'`);
      assert.equal(fs.existsSync(vault.file), true, 'the cached write must still have produced a vault file');
    } finally {
      fs.rmSync(vault.directory, { recursive: true, force: true });
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

test('an unusable cache directory costs a vault WRITE nothing but the compile it always paid',
  { skip: !WINDOWS }, () => {
    const vault = scratchVault('nocache');
    const stateRoot = scratchStateRoot('blocked');
    const blocker = path.join(stateRoot, 'state', 'vault-atomic-file-cache');
    fs.mkdirSync(path.dirname(blocker), { recursive: true });
    fs.writeFileSync(blocker, 'not a directory', 'utf8');
    try {
      assert.equal(runVerb(vault.file, ['set-stdin', 'github_pat'], PROBE_SECRET, stateRoot), 'ok');
      assert.equal(runVerb(vault.file, ['set-stdin', 'github_pat'], PROBE_SECRET, stateRoot), 'ok',
        'a cache directory that is a file must never fail the write it was only meant to speed up');
      const held = probe(vault.file, 'set-stdin', 'github_pat', PROBE_SECRET, stateRoot);
      assert.equal(held.atomicType, true, 'the write still installs the replacement type without a cache');
      assert.equal(held.atomicLocation, '',
        'with no usable cache the type is compiled in-process, exactly as before the cache existed');
      assert.equal(fs.readFileSync(blocker, 'utf8'), 'not a directory',
        'the blocking file is left exactly as it was, never clobbered into a directory');
    } finally {
      fs.rmSync(vault.directory, { recursive: true, force: true });
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });
