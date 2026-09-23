'use strict';

// Real Windows kernel containment test.  The second case deliberately lets the
// root process exit while its descendant remains alive: a PID tree walk has
// already lost that descendant at that point, whereas the retained Job Object
// must still terminate it and report zero active processes.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const jobs = require('../src/lib/windows-job-control');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

assert.equal(process.platform, 'win32', 'the shipped engine requires the Windows Job Object contract');

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitUntil(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('timed out waiting for the exact process state');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function closePromise(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function bounded(promise, label, timeoutMs = 8_000) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function nonWindowsFallbackCarriesQuietDesktopContract() {
  const sentinel = Object.freeze({ type: 'portable-child-fixture' });
  let observed = null;
  const result = jobs.spawnInJob('fixture-runtime', ['fixture-argument'], {
    cwd: path.resolve(__dirname, '..'),
    env: { FIXTURE_VISIBLE: '1' }
  }, {
    platform: 'linux',
    safeLaunchEnvironment: environment => ({ ...environment, FIXTURE_SCRUBBED: '1' }),
    spawnImpl(command, args, options) {
      observed = { command, args, options };
      return sentinel;
    }
  });
  assert.equal(result, sentinel);
  assert.equal(observed.command, 'fixture-runtime');
  assert.deepEqual(observed.args, ['fixture-argument']);
  assert.equal(observed.options.windowsHide, true,
    'the portable fallback must retain the quiet-desktop launch contract');
  assert.equal(observed.options.env.FIXTURE_SCRUBBED, '1');
}

async function naturalExit(temp) {
  const recordDirectory = path.join(temp, 'natural-records');
  const child = jobs.spawnInJob(process.execPath, ['-e', 'process.stdout.write("contained-ok\\n")'], {
    cwd: temp,
    env: process.env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  }, { recordDirectory, safeLaunchEnvironment });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const closed = closePromise(child);
  const identity = await child.jobReady;
  assert.equal(identity.wrapperPid, child.pid, 'the public process id is the retained wrapper identity');
  assert.match(identity.wrapperStartTicks, /^[1-9]\d{0,19}$/);
  assert.match(identity.rootStartTicks, /^[1-9]\d{0,19}$/);
  assert.deepEqual(jobs.readIdentity(child.pid, { recordDirectory }), identity,
    'the cross-process termination record is byte-for-byte the ready identity');
  const outcome = await child.jobOutcome;
  const close = await closed;
  assert.equal(close.code, 0);
  assert.deepEqual(outcome, { type: 'exit', exitCode: 0, activeProcesses: 0 });
  assert.equal(output, 'contained-ok\n');
  assert.throws(() => jobs.readIdentity(child.pid, { recordDirectory }),
    error => error && error.code === 'WINDOWS_JOB_NOT_REGISTERED',
    'the exact identity record is removed only after wrapper close');
}

async function deadMiddleTermination(temp) {
  const recordDirectory = path.join(temp, 'dead-middle-records');
  const descendantFile = path.join(temp, 'dead-middle-descendant.js');
  const descendantReady = path.join(temp, 'dead-middle-descendant.ready');
  fs.writeFileSync(descendantFile, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(descendantReady)}, String(process.pid), 'utf8');`,
    'setInterval(() => {}, 1000);',
    ''
  ].join('\n'), 'utf8');
  const rootProgram = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, [${JSON.stringify(descendantFile)}], { detached: true, windowsHide: true, stdio: 'ignore' }); child.unref();`,
    "process.stdout.write(String(child.pid) + '\\n');",
    `const deadline = Date.now() + 5000; const timer = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(descendantReady)})) { clearInterval(timer); process.exit(0); } if (Date.now() >= deadline) process.exit(9); }, 25);`
  ].join('\n');
  const child = jobs.spawnInJob(process.execPath, ['-e', rootProgram], {
    cwd: temp,
    env: process.env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  }, { recordDirectory, safeLaunchEnvironment });
  let line = '';
  child.stdout.on('data', chunk => { line += chunk; });
  const closed = closePromise(child);
  const identity = await child.jobReady;
  let descendantPid = null;
  try {
    await waitUntil(() => /^\d+\r?\n$/.test(line));
    descendantPid = Number(line.trim());
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    await waitUntil(() => fs.existsSync(descendantReady));
    await waitUntil(() => !alive(identity.rootPid));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(child._closed, false,
      'precondition: with the root gone, the wrapper remains open only because the descendant is still an active job member');

    const receipt = await child.terminateJob();
    assert.equal(receipt.type, 'terminated');
    assert.equal(receipt.activeProcesses, 0, 'the kernel receipt proves every job member is gone');
    const outcome = await child.jobOutcome;
    const close = await closed;
    assert.equal(outcome.activeProcesses, 0);
    assert.equal(close.code, 124, 'the wrapper reports the bounded termination exit');
    await waitUntil(() => !alive(descendantPid));
  } finally {
    if (!child._closed) {
      try { await child.terminateJob(); } catch { /* the finite child is still job-contained */ }
      try { await child.jobClosed; } catch {}
    }
  }
}

async function rootExitTerminatesDescendants(temp, { release = true } = {}) {
  const label = release ? 'released' : 'withheld';
  const recordDirectory = path.join(temp, `root-lifetime-${label}-records`);
  const descendantReady = path.join(temp, `root-lifetime-${label}-descendant.ready`);
  const rootRelease = path.join(temp, `root-lifetime-${label}-parent-release`);
  const rootProgram = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify([
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(descendantReady)}, String(process.pid), 'utf8');`,
      'setInterval(() => {}, 1000);'
    ].join(' '))}], { detached: true, windowsHide: true, stdio: 'ignore' });`,
    'child.unref();',
    // Readiness alone cannot release the root: its correct native cleanup
    // could otherwise beat the parent's independent readiness observation.
    `const deadline = Date.now() + 5000; const timer = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(descendantReady)}) && require('node:fs').existsSync(${JSON.stringify(rootRelease)})) { clearInterval(timer); process.exit(0); } if (Date.now() >= deadline) process.exit(9); }, 25);`
  ].join('\n');
  const child = jobs.spawnInJob(process.execPath, ['-e', rootProgram], {
    cwd: temp,
    env: process.env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore'],
    terminateDescendantsOnRootExit: true
  }, { recordDirectory, safeLaunchEnvironment });
  let descendantPid = null;
  let primaryError = null;
  let nativeError = null;
  child.on('error', error => { nativeError = nativeError || error; });
  try {
    const identity = await bounded(child.jobReady, 'root-authority readiness');
    await waitUntil(() => fs.existsSync(descendantReady));
    descendantPid = Number(fs.readFileSync(descendantReady, 'utf8'));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.equal(alive(identity.rootPid), true, 'the retained root must still be alive before its parent releases it');
    assert.equal(alive(descendantPid), true, 'the fixture descendant must be alive before its root exits');
    assert.equal(fs.existsSync(rootRelease), false);
    if (release) fs.writeFileSync(rootRelease, 'parent observed the live root and descendant\n', { flag: 'wx' });
    const outcome = await bounded(child.jobOutcome, 'root-authority job outcome');
    const close = await bounded(child.jobClosed, 'root-authority wrapper close');
    const expectedCode = release ? 0 : 9;
    assert.deepEqual(outcome, { type: 'exit', exitCode: expectedCode, activeProcesses: 0 });
    assert.equal(close.code, expectedCode, 'the wrapper must preserve the actual root exit code');
    assert.equal(close.failure, null);
    assert.equal(close.signal, null);
    await waitUntil(() => !alive(descendantPid));
    if (!release) assert.equal(fs.existsSync(rootRelease), false, 'withheld permission reaches only the finite nonzero deadline');
  } catch (error) { primaryError = error; }

  const cleanupErrors = [];
  if (!child._closed) {
    try { await bounded(child.terminateJob(), 'root-authority retained cleanup'); }
    catch (error) { cleanupErrors.push(error); }
  }
  try {
    const outcome = await bounded(child.jobOutcome, 'root-authority cleanup receipt');
    const close = await bounded(child.jobClosed, 'root-authority cleanup close');
    assert.ok(!outcome.failure && ['exit', 'terminated'].includes(outcome.type));
    assert.equal(outcome.activeProcesses, 0, 'cleanup still requires the original native zero-member receipt');
    assert.equal(close.failure, null);
    assert.equal(close.signal, null);
    assert.equal(close.code, outcome.exitCode);
  } catch (error) {
    cleanupErrors.push(error);
    if (!child._closed) {
      try {
        await bounded(child.terminateRetainedWrapper(), 'root-authority retained-wrapper fallback');
        await bounded(child.jobClosed, 'root-authority fallback close');
      } catch (fallbackError) { cleanupErrors.push(fallbackError); }
    }
  }
  // Neither a missing PID nor retained-wrapper fallback replaces EMPTY. Keep
  // the original assertion first if cleanup also failed; the outer suite
  // preserves the fixture and remains NONPASS on either failure.
  primaryError = primaryError || nativeError;
  if (cleanupErrors.length) {
    const errors = [...(primaryError ? [primaryError] : []), ...cleanupErrors];
    const details = errors.map(error => `${error.code || error.name}: ${String(error.message).slice(0, 500)}`).join('; ');
    throw new AggregateError(errors, `root-authority ${label} fixture failed or cleanup remains unproved; ${details}`);
  }
  if (primaryError) throw primaryError;
  process.stdout.write(`windows-job-control root release: ${label}; native EXIT ${release ? 0 : 9}, EMPTY and wrapper close verified\n`);
}

async function staleCreationIdentityRefuses(temp) {
  const recordDirectory = path.join(temp, 'identity-records');
  const child = jobs.spawnInJob(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: temp,
    env: process.env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore']
  }, { recordDirectory, safeLaunchEnvironment });
  const closed = closePromise(child);
  const identity = await child.jobReady;
  try {
    const wrongTicks = (BigInt(identity.wrapperStartTicks) + 1n).toString();
    await assert.rejects(
      jobs.terminateRegisteredJob(child.pid, { expectedStartTicks: wrongTicks, recordDirectory }),
      error => error && error.code === 'WINDOWS_JOB_IDENTITY_MISMATCH'
    );
    assert.equal(alive(identity.rootPid), true,
      'a stale creation identity must terminate nothing, even when the PID is live');
  } finally {
    await child.terminateJob();
    await closed;
  }
}

async function retainedWrapperFallbackIsIdempotent(temp) {
  const recordDirectory = path.join(temp, 'retained-wrapper-records');
  const child = jobs.spawnInJob(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: temp,
    env: process.env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore']
  }, { recordDirectory, safeLaunchEnvironment });
  child.on('error', () => { /* forced wrapper exit intentionally lacks a protocol receipt */ });
  await child.jobReady;
  const originalKill = child._native.kill.bind(child._native);
  let nativeKills = 0;
  child._native.kill = (...args) => { nativeKills += 1; return originalKill(...args); };
  const first = child.terminateRetainedWrapper();
  const second = child.terminateRetainedWrapper();
  await Promise.all([first, second]);
  assert.equal(nativeKills, 1, 'concurrent fallback calls terminate the already-retained native handle once');
}

// The wrapper's C# type is compiled by Add-Type -TypeDefinition on every
// launch unless a cache directory is threaded through -- this only checks
// the argv construction (no real process), so it stays synchronous like
// nonWindowsFallbackCarriesQuietDesktopContract above.
function assemblyCacheArgumentIsThreadedThroughArgv(temp) {
  const wrapperScript = path.resolve(__dirname, '..', 'tools', 'windows-job-wrapper.ps1');
  const recordDirectory = path.join(temp, 'argv-fixture-records');
  const fixtureChild = { pid: 4242, stdin: null, stdout: null, stderr: null, stdio: null, once() {} };

  let observedDefault = null;
  jobs.spawnInJob('powershell.exe', ['-Command', 'exit 0'], { cwd: temp, env: process.env }, {
    platform: 'win32', safeLaunchEnvironment, wrapperScript, recordDirectory,
    spawnImpl(command, args) { observedDefault = { command, args }; return fixtureChild; }
  });
  const flagIndex = observedDefault.args.indexOf('-AssemblyCacheDirectoryBase64');
  assert.notEqual(flagIndex, -1, 'an unoverridden launch must thread a cache directory into the wrapper argv');
  const decoded = Buffer.from(observedDefault.args[flagIndex + 1], 'base64').toString('utf8');
  assert.equal(decoded, jobs.defaultAssemblyCacheDirectory(),
    'an unoverridden launch must resolve to the shared default cache directory');

  let observedDisabled = null;
  jobs.spawnInJob('powershell.exe', ['-Command', 'exit 0'], { cwd: temp, env: process.env }, {
    platform: 'win32', safeLaunchEnvironment, wrapperScript, recordDirectory, assemblyCacheDirectory: null,
    spawnImpl(command, args) { observedDisabled = { command, args }; return fixtureChild; }
  });
  assert.equal(observedDisabled.args.indexOf('-AssemblyCacheDirectoryBase64'), -1,
    'an explicitly disabled cache directory must be omitted from the argv entirely, not sent empty');
}

// Prove the cause of the speedup, not a wall-clock difference between two
// separately scheduled PowerShell/native-child launches. The latter includes
// unrelated startup and machine load: a real cache hit can miss that deadline.
// This observer forwards to the REAL Add-Type cmdlet and invokes the unchanged
// shipped wrapper. After seeding, compilation is forbidden in this disposable
// PowerShell process. A warm native launch must still succeed by loading the
// exact seeded DLL. Disabling the cache under the SAME compiler refusal must
// fail before the requested native child starts. No fake job/kernel receipt is
// accepted, and no product cache hook or fallback is modified for this test.
async function assemblyCacheSkipsCompilation(temp) {
  const recordDirectory = path.join(temp, 'cache-proof-records');
  const assemblyCacheDirectory = path.join(temp, 'cache-proof-assembly-cache');
  const observerScript = path.join(temp, 'cache-proof-observer.ps1');
  const eventFile = path.join(temp, 'cache-proof-events.jsonl');
  const compilationRefusedFile = path.join(temp, 'cache-proof-refuse-compilation');
  const wrapperScript = path.resolve(__dirname, '..', 'tools', 'windows-job-wrapper.ps1');
  const psLiteral = value => "'" + value.replace(/'/g, "''") + "'";
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const pathKey = value => path.resolve(value).toLowerCase();
  fs.writeFileSync(observerScript, [
    'param(',
    '  [string]$PipeName, [string]$Token, [string]$CommandBase64, [string]$ArgumentsBase64,',
    '  [string]$WorkingDirectoryBase64, [int]$CleanupTimeoutMs, [int]$HandshakeTimeoutMs,',
    "  [string]$AssemblyCacheDirectoryBase64 = '', [switch]$TerminateDescendantsOnRootExit",
    ')',
    '$ErrorActionPreference = "Stop"',
    'function Write-CacheObservation($Value) {',
    '  $Value.wrapperPid = $PID',
    `  [System.IO.File]::AppendAllText(${psLiteral(eventFile)}, (($Value | ConvertTo-Json -Compress) + [char]10), [System.Text.UTF8Encoding]::new($false))`,
    '}',
    'function Add-Type {',
    '  [CmdletBinding()] param([string]$TypeDefinition, [string[]]$Path, [string]$Language, [string]$OutputAssembly)',
    '  if ($PSBoundParameters.ContainsKey("TypeDefinition")) {',
    '    $sha = [System.Security.Cryptography.SHA256]::Create()',
    '    try { $sourceHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($TypeDefinition))).Replace("-", "").ToLowerInvariant() } finally { $sha.Dispose() }',
    '    Write-CacheObservation @{ kind = "compile-attempt"; sourceHash = $sourceHash }',
    `    if ([System.IO.File]::Exists(${psLiteral(compilationRefusedFile)})) {`,
    '      Write-CacheObservation @{ kind = "compile-blocked"; sourceHash = $sourceHash }',
    '      throw "Fixture source compilation is disabled"',
    '    }',
    '  }',
    '  Microsoft.PowerShell.Utility\\Add-Type @PSBoundParameters',
    '  if ($PSBoundParameters.ContainsKey("TypeDefinition")) {',
    '    Write-CacheObservation @{ kind = "compile-completed"; sourceHash = $sourceHash }',
    '  } else {',
    '    Write-CacheObservation @{ kind = "assembly-loaded"; path = $Path[0]; assemblyLocation = [ToolsEnabledWindowsJobWrapper].Assembly.Location }',
    '  }',
    '}',
    `& ${psLiteral(wrapperScript)} @PSBoundParameters`,
    'exit $LASTEXITCODE',
    ''
  ].join('\n'), { encoding: 'utf8', flag: 'wx' });

  async function launchProbe(label, cacheDirectory, expectedFailure = false) {
    const childMarker = path.join(temp, `cache-proof-${label}-child.json`);
    const program = `require('node:fs').writeFileSync(${JSON.stringify(childMarker)}, JSON.stringify({ pid: process.pid })); process.stdout.write('probe-ok\\n');`;
    const startedAt = performance.now();
    const child = jobs.spawnInJob(process.execPath, ['-e', program], {
      cwd: temp, env: process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']
    }, { recordDirectory, assemblyCacheDirectory: cacheDirectory, wrapperScript: observerScript, safeLaunchEnvironment });
    const errors = [];
    child.on('error', error => errors.push(error.code));
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    try {
      const [ready, outcome, closed] = await bounded(Promise.all([
        child.jobReady.then(identity => ({ identity }), error => ({ error })),
        child.jobOutcome.then(receipt => ({ receipt }), error => ({ error })),
        child.jobClosed
      ]), `cache ${label} native launch`, jobs.DEFAULT_HANDSHAKE_TIMEOUT_MS + jobs.DEFAULT_CLEANUP_TIMEOUT_MS);
      const events = fs.readFileSync(eventFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        .filter(event => event.wrapperPid === child.pid);
      if (expectedFailure) {
        assert.equal(ready.error?.code, 'WINDOWS_JOB_WRAPPER_FAILED', 'without cache or compilation no native child can be admitted');
        assert.equal(outcome.error?.code, 'WINDOWS_JOB_WRAPPER_FAILED');
        assert.equal(closed.code, 250, 'the real wrapper must report its pre-containment failure');
        assert.equal(child.jobIdentity, null, 'the negative control must establish no root-process identity');
        assert.equal(fs.existsSync(childMarker), false, 'the requested native child must not have run');
        assert.equal(output, '');
      } else {
        assert.equal(ready.error, undefined, `cache ${label} launch did not establish containment (${ready.error?.code})`);
        assert.equal(outcome.error, undefined);
        assert.equal(closed.code, 0);
        assert.deepEqual(outcome.receipt, { type: 'exit', exitCode: 0, activeProcesses: 0 });
        assert.equal(ready.identity.wrapperPid, child.pid);
        assert.match(ready.identity.rootStartTicks, /^[1-9]\d{0,19}$/);
        assert.equal(JSON.parse(fs.readFileSync(childMarker, 'utf8')).pid, ready.identity.rootPid,
          'the output marker must come from the native process identified by the real job handshake');
        assert.equal(output, 'probe-ok\n');
        assert.deepEqual(errors, []);
      }
      assert.throws(() => jobs.readIdentity(child.pid, { recordDirectory }), { code: 'WINDOWS_JOB_NOT_REGISTERED' },
        'every completed probe must remove its exact retained identity record');
      return { events, elapsedMs: Math.round(performance.now() - startedAt) };
    } finally {
      if (!child._closed) await bounded(child.terminateRetainedWrapper(), `cache ${label} retained-wrapper termination`,
        jobs.DEFAULT_CLEANUP_TIMEOUT_MS);
      await bounded(child.jobClosed, `cache ${label} wrapper cleanup`);
    }
  }

  assert.equal(fs.existsSync(assemblyCacheDirectory), false, 'the seed must begin with a genuine absent cache');
  const seed = await launchProbe('seed', assemblyCacheDirectory);
  const compiled = seed.events.filter(event => event.kind === 'compile-completed');
  assert.equal(compiled.length, 1, 'the cold launch must really compile the shipped wrapper source');
  const cachedFiles = fs.readdirSync(assemblyCacheDirectory).filter(name => /^wrapper-[0-9a-f]{64}\.dll$/.test(name));
  assert.deepEqual(cachedFiles, [`wrapper-${compiled[0].sourceHash}.dll`],
    'the real compiler input hash must identify the exact seeded cache entry');
  const cachedFile = path.join(assemblyCacheDirectory, cachedFiles[0]);
  const seededDigest = digest(cachedFile);
  const seededStat = fs.statSync(cachedFile, { bigint: true });

  fs.writeFileSync(compilationRefusedFile, 'source compilation disabled for both warm and negative controls\n', { flag: 'wx' });
  const warm = await launchProbe('warm', assemblyCacheDirectory);
  assert.deepEqual(warm.events.map(event => event.kind), ['assembly-loaded'],
    'the warm native launch must not attempt any source compilation');
  assert.equal(pathKey(warm.events[0].path), pathKey(cachedFile));
  assert.equal(pathKey(warm.events[0].assemblyLocation), pathKey(cachedFile),
    'the executing wrapper type must be loaded from the exact seeded DLL, not another assembly');
  const warmStat = fs.statSync(cachedFile, { bigint: true });
  assert.equal(warmStat.ino, seededStat.ino);
  assert.equal(warmStat.mtimeNs, seededStat.mtimeNs);
  assert.equal(digest(cachedFile), seededDigest, 'the warm launch must not replace or rewrite the seeded binary');

  const disabled = await launchProbe('cache-disabled', null, true);
  assert.deepEqual(disabled.events.map(event => event.kind), ['compile-attempt', 'compile-blocked'],
    'with the same compiler refusal, disabling cache must force compilation and prevent native launch');
  assert.equal(disabled.events[0].sourceHash, compiled[0].sourceHash);
  assert.equal(digest(cachedFile), seededDigest, 'the negative control must preserve the positive-control artifact');
  process.stdout.write(`windows-job-control cache proof: cold=${seed.elapsedMs}ms warm=${warm.elapsedMs}ms compiler-blocked-control=${disabled.elapsedMs}ms (diagnostic only; exact DLL reuse and causal refusal verified)\n`);
}

// A cache is a pure speedup; it must never be able to fail the command it
// was only meant to make faster. Point the cache directory at a path that
// already exists AS A FILE, so New-Item -ItemType Directory -Force cannot
// create it, and prove the command still runs correctly regardless.
async function assemblyCacheFailureNeverBreaksExecution(temp) {
  const recordDirectory = path.join(temp, 'cache-failure-records');
  const assemblyCacheDirectory = path.join(temp, 'cache-failure-blocker.txt');
  fs.writeFileSync(assemblyCacheDirectory, 'not a directory', 'utf8');

  const child = jobs.spawnInJob('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', "'probe-ok'"
  ], {
    cwd: temp, env: process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']
  }, { recordDirectory, assemblyCacheDirectory, safeLaunchEnvironment });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const closed = closePromise(child);
  await child.jobReady;
  const outcome = await child.jobOutcome;
  const close = await closed;
  assert.equal(close.code, 0, 'an unusable cache directory must never fail the command it was only meant to speed up');
  assert.deepEqual(outcome, { type: 'exit', exitCode: 0, activeProcesses: 0 });
  assert.equal(output.trim(), 'probe-ok');
  assert.equal(fs.statSync(assemblyCacheDirectory).isFile(), true, 'the blocking file must be left exactly as it was, never clobbered');
}

async function cancellationBeforeOwnerNeverStartsRoot(temp, duringPreparation) {
  const marker = path.join(temp, `must-not-run-${duringPreparation}.txt`);
  let releasePreparation;
  let enteredPreparation;
  const entered = new Promise(resolve => { enteredPreparation = resolve; });
  const preparation = new Promise(resolve => { releasePreparation = resolve; });
  const child = jobs.spawnInJob(process.execPath, ['-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'root ran')`], {
    cwd: temp, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }, { safeLaunchEnvironment, recordDirectory: path.join(temp, 'early-cancel-records'),
    prepareRootSpawn: duringPreparation ? async () => { enteredPreparation(); await preparation; } : undefined });
  child.on('error', () => {});
  child.stdout.resume(); child.stderr.resume();
  try {
    if (duringPreparation) await bounded(entered, 'preparation reached');
    const stopped = await bounded(child.terminateJob(), 'cancel before OWNER');
    assert.equal(stopped.type, 'not-started');
    assert.equal(stopped.activeProcesses, 0);
    assert.equal((await child.jobClosed).failure, null);
    await assert.rejects(child.jobReady, { code: 'WINDOWS_JOB_LAUNCH_CANCELLED' });
    releasePreparation();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(marker), false, 'a resumed preparation must not authorize a cancelled root');
  } finally {
    releasePreparation();
    await child.terminateJob();
    await child.jobClosed;
  }
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-windows-job-'));
  let suitePassed = false;
  try {
    nonWindowsFallbackCarriesQuietDesktopContract();
    await cancellationBeforeOwnerNeverStartsRoot(temp, false);
    await cancellationBeforeOwnerNeverStartsRoot(temp, true);
    await naturalExit(temp);
    await rootExitTerminatesDescendants(temp);
    await rootExitTerminatesDescendants(temp, { release: false });
    await deadMiddleTermination(temp);
    await staleCreationIdentityRefuses(temp);
    await retainedWrapperFallbackIsIdempotent(temp);
    assemblyCacheArgumentIsThreadedThroughArgv(temp);
    await assemblyCacheSkipsCompilation(temp);
    await assemblyCacheFailureNeverBreaksExecution(temp);
    process.stdout.write('windows-job-control: natural exit, root-authority cleanup, dead-middle cleanup, PID-reuse fence, idempotent retained-handle fallback, and wrapper assembly caching passed\n');
    suitePassed = true;
  } finally {
    if (!suitePassed) {
      process.stderr.write(`windows-job-control: failed; retaining temporary evidence at ${temp}; cleanup success is not inferred\n`);
    } else {
      const actualTemp = fs.realpathSync(temp);
      assert.equal(path.dirname(actualTemp).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
      assert.ok(path.basename(actualTemp).startsWith('toolsenabled-windows-job-'));
      fs.rmSync(actualTemp, { recursive: true, force: true });
    }
  }
})().catch(error => {
  process.stdout.write(`windows-job-control failure: ${String(error && (error.stack || error.message || error)).replace(/[\r\n]+/g, ' | ')}\n`);
  process.exitCode = 1;
});
