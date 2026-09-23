// Keep the PowerShell pipe experiment inside one retained native Job. Its
// synthetic root may exit before its detached descendants, so root-exit
// termination is deliberately OFF: the positive case must finish naturally.
// A marker, a PID probe, or a fixed sleep is never scratch-cleanup authority.
// Only the authenticated zero-process receipt AND retained wrapper close
// permit removal. Failure must not be masked by an EBUSY from premature rm.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnInJob } = require('../src/lib/windows-job-control');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
const { assertAccountProfilePath } = require('../src/lib/account-profile-boundary');

const root = path.resolve(__dirname, '..');
const listenerHost = path.join(root, 'tools', 'full-remote-access-listener-host.js');
const controller = path.join(root, 'tools', 'full-remote-access-control.ps1');
const EXPERIMENT_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function write(file, lines) {
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

function runPowerShell(script, args) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let firstOutputMs = null;
    let stdout = '';
    let stderr = '';
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, ...args
    ], {
      cwd: root,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => {
      if (firstOutputMs === null) firstOutputMs = performance.now() - started;
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', code => resolve({
      code,
      stdout,
      stderr,
      firstOutputMs,
      closeMs: performance.now() - started
    }));
  });
}

function lastJson(text) {
  const lines = String(text).trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return predicate();
}

async function experiment(temporary) {
  temporary = checkedScratch(temporary);
  const childScript = path.join(temporary, 'long-lived-child.js');
  const buggyParent = path.join(temporary, 'buggy-parent.ps1');
  const fixedParent = path.join(temporary, 'fixed-parent.ps1');
  const buggyStdout = path.join(temporary, 'buggy.stdout.log');
  const buggyStderr = path.join(temporary, 'buggy.stderr.log');
  const fixedStdout = path.join(temporary, 'fixed.stdout.log');
  const fixedStderr = path.join(temporary, 'fixed.stderr.log');
  const buggyMarker = path.join(temporary, 'buggy.marker');
  const fixedMarker = path.join(temporary, 'fixed.marker');
  const childLifetimeMs = 1800;

  write(childScript, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const delay = Number(process.argv[2]);",
    "const marker = process.argv[3];",
    "fs.appendFileSync(marker, 'started\\n');",
    "process.once('exit', code => fs.appendFileSync(marker, 'exit:' + code + '\\n'));",
    // Deliberately remain alive after the old cleanup's 'finished' marker.
    // The owned Job must observe actual exit, not assume the callback is EOF.
    "setTimeout(() => { fs.appendFileSync(marker, 'finished\\n'); setTimeout(() => {}, 750); }, delay);"
  ]);
  write(buggyParent, [
    'param([string]$Node,[string]$Child,[string]$Root,[string]$Out,[string]$Err,[string]$Marker)',
    '$child = Start-Process -FilePath $Node -ArgumentList @($Child,\'1800\',$Marker) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $Out -RedirectStandardError $Err -PassThru',
    '[Console]::Out.WriteLine(([pscustomobject]@{ ok = $true; pid = [int]$child.Id } | ConvertTo-Json -Compress))'
  ]);
  write(fixedParent, [
    'param([string]$Node,[string]$Child,[string]$Root,[string]$Out,[string]$Err,[string]$Marker)',
    '$child = Start-Process -FilePath $Node -ArgumentList @($Child,\'1800\',$Marker) -WorkingDirectory $Root -WindowStyle Hidden -PassThru',
    '[Console]::Out.WriteLine(([pscustomobject]@{ ok = $true; pid = [int]$child.Id; detached = $true; secretValuesEmitted = $false } | ConvertTo-Json -Compress))'
  ]);

  const buggy = await runPowerShell(buggyParent, [
    process.execPath, childScript, temporary, buggyStdout, buggyStderr, buggyMarker
  ]);
  assert.equal(buggy.code, 0, buggy.stderr);
  const buggyPayload = lastJson(buggy.stdout);
  assert.equal(buggyPayload.ok, true);
  assert.equal(Number.isSafeInteger(buggyPayload.pid), true);
  assert.ok(buggy.closeMs >= childLifetimeMs,
    'the exact Start-Process redirect shape must retain the wrapper pipe until the child exits');
  assert.match(fs.readFileSync(buggyMarker, 'utf8'), /finished/,
    'the buggy wrapper reaches EOF only after the child has finished');

  const fixed = await runPowerShell(fixedParent, [
    process.execPath, childScript, temporary, fixedStdout, fixedStderr, fixedMarker
  ]);
  assert.equal(fixed.code, 0, fixed.stderr);
  const fixedPayload = lastJson(fixed.stdout);
  assert.equal(fixedPayload.ok, true);
  assert.equal(fixedPayload.detached, true);
  assert.equal(fixedPayload.secretValuesEmitted, false);
  // Observe the causal boundary, not a wall-clock fraction of the child's life.
  // This wrapper's own PowerShell startup is scheduled against whatever else the
  // Windows test run is doing, so a correct detachment can still cross half the
  // child lifetime; the marker cannot lie about ordering.
  assert.doesNotMatch(fs.existsSync(fixedMarker) ? fs.readFileSync(fixedMarker, 'utf8') : '', /finished/,
    'the fixed wrapper must reach EOF before its detached child finishes');
  assert.equal(processAlive(fixedPayload.pid), true,
    'the detached child must still be alive after the wrapper reaches EOF');
  assert.equal(await waitFor(() => fs.existsSync(fixedMarker)
    && /finished/.test(fs.readFileSync(fixedMarker, 'utf8')), 5000), true,
  'the detached child must finish normally after its parent pipe closes');

  const source = fs.readFileSync(controller, 'utf8');
  assert.match(source,
    /^\s*\$ListenerHost\s*=\s*Join-Path[^\r\n]+['"]tools\\full-remote-access-listener-host\.js['"]/m,
    'the FRA controller must define the anchored listener host');
  assert.match(source,
    /^\s*\$child\s*=\s*Start-Process[^\r\n]+\$ListenerHost[^\r\n]+-WindowStyle Hidden -PassThru/m,
    'the fixed listener launch must use the non-redirecting Start-Process path');
  assert.doesNotMatch(source,
    /Start-Process[^\r\n]+\$ListenerHost[^\r\n]+RedirectStandard(?:Output|Error)/,
    'the listener host launch must never restore Start-Process stream redirection');
  const hostModule = require(listenerHost);
  const writes = [];
  const fakeStream = { write() { throw new Error('prior stream writer used'); } };
  const fakeFs = {
    mkdirSync() {}, openSync() { return 7; }, closeSync() {},
    writeSync(descriptor, bytes) { writes.push({ descriptor, text: bytes.toString('utf8') }); }
  };
  const redirect = hostModule.installStreamRedirect(fakeStream, path.join(temporary, 'redirect.log'), fakeFs);
  assert.equal(fakeStream.write('redirected'), true);
  assert.deepEqual(writes, [{ descriptor: 7, text: 'redirected' }]);
  redirect.restore();
  redirect.close();

  return {
    buggyFirstOutputMs: Number(buggy.firstOutputMs.toFixed(1)),
    buggyPipeEofMs: Number(buggy.closeMs.toFixed(1)),
    fixedFirstOutputMs: Number(fixed.firstOutputMs.toFixed(1)),
    fixedPipeEofMs: Number(fixed.closeMs.toFixed(1)),
    childLifetimeMs
  };
}

function bounded(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

function assertCleanupProof(outcome, closed) {
  assert.ok(outcome && ['exit', 'terminated'].includes(outcome.type)
    && Number.isInteger(outcome.exitCode) && outcome.activeProcesses === 0,
  'scratch cleanup requires the authenticated Job zero-process receipt');
  assert.ok(closed && !closed.failure && !closed.signal && closed.code === outcome.exitCode,
    'scratch cleanup requires the retained wrapper close matching that receipt');
}

function checkedScratch(temporary) {
  const accountProfile = os.userInfo().homedir;
  const resolved = assertAccountProfilePath(temporary, {
    profileRoot: accountProfile, requireOwnedProfile: true, field: 'FRA fixture scratch'
  });
  assert.equal(path.dirname(resolved), path.join(accountProfile, 'AppData', 'Local', 'Temp'),
    'FRA cleanup owns only a direct child of the verified account temp root');
  assert.match(path.basename(resolved), /^fra-pipe-handle-[A-Za-z0-9]+$/,
    'FRA cleanup requires this invocation\'s generated scratch directory');
  return resolved;
}

async function runOwnedExperiment(temporary) {
  temporary = checkedScratch(temporary);
  const child = spawnInJob(process.execPath, [__filename, '--contained-fixture', temporary], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    terminateDescendantsOnRootExit: false
  }, {
    safeLaunchEnvironment,
    recordDirectory: path.join(temporary, 'job-records'),
    assemblyCacheDirectory: path.join(temporary, 'assembly-cache'),
    cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
    handshakeTimeoutMs: CLEANUP_TIMEOUT_MS
  });
  let stdout = '';
  let stderr = '';
  let capturedBytes = 0;
  let rejectFailure;
  const failed = new Promise((resolve, reject) => { rejectFailure = reject; });
  child.on('error', rejectFailure);
  const capture = target => chunk => {
    const bytes = Buffer.from(chunk);
    const available = Math.max(0, MAX_OUTPUT_BYTES - capturedBytes);
    const captured = bytes.subarray(0, available).toString('utf8');
    if (target === 'stdout') stdout += captured;
    else stderr += captured;
    capturedBytes += bytes.length;
    if (capturedBytes > MAX_OUTPUT_BYTES) rejectFailure(new Error('FRA experiment output exceeded its bounded capture'));
  };
  child.stdout.on('data', capture('stdout'));
  child.stderr.on('data', capture('stderr'));
  let failure = null;
  let cleanupConfirmed = false;
  let scratchRemoved = false;
  let summary;
  try {
    const [, outcome, closed] = await bounded(Promise.race([
      Promise.all([child.jobReady, child.jobOutcome, child.jobClosed]), failed
    ]), EXPERIMENT_TIMEOUT_MS, 'FRA experiment exceeded its execution deadline');
    assertCleanupProof(outcome, closed);
    cleanupConfirmed = true;
    assert.equal(outcome.type, 'exit', 'the positive experiment must end naturally');
    assert.equal(outcome.exitCode, 0, stderr || stdout || 'FRA experiment failed without diagnostics');
    summary = lastJson(stdout);
    assert.match(fs.readFileSync(path.join(temporary, 'buggy.marker'), 'utf8'), /\nexit:0\n$/,
      'the buggy child must exit naturally before scratch is removed');
    assert.match(fs.readFileSync(path.join(temporary, 'fixed.marker'), 'utf8'), /\nexit:0\n$/,
      'the fixed child must exit naturally after its finished callback, before scratch is removed');
  } catch (error) {
    failure = error;
    if (!cleanupConfirmed) {
      try {
        const [outcome, closed] = await bounded(Promise.all([
          child.terminateJob(), child.jobClosed
        ]), CLEANUP_TIMEOUT_MS, 'FRA owned Job cleanup exceeded its deadline');
        assertCleanupProof(outcome, closed);
        cleanupConfirmed = true;
      } catch (cleanupError) {
        // The exact retained wrapper is the only fallback target. Its forced
        // close does not fabricate the missing authenticated terminal receipt.
        try { await bounded(child.terminateRetainedWrapper(), CLEANUP_TIMEOUT_MS, 'FRA retained wrapper did not close'); }
        catch (wrapperError) { cleanupError = new AggregateError([cleanupError, wrapperError], 'FRA wrapper cleanup unproved'); }
        failure = new AggregateError([failure, cleanupError], `FRA cleanup UNKNOWN; scratch retained at ${temporary}`);
      }
    }
  }
  if (cleanupConfirmed) {
    try {
      fs.rmSync(checkedScratch(temporary), { recursive: true, force: true });
      scratchRemoved = true;
    }
    catch (cleanupError) {
      failure = failure ? new AggregateError([failure, cleanupError], 'FRA assertion and scratch removal both failed') : cleanupError;
    }
  }
  if (failure) {
    if (cleanupConfirmed && scratchRemoved) {
      process.stderr.write('FRA failure cleanup confirmed: native Job empty, retained wrapper closed, owned scratch removed.\n');
    }
    throw failure;
  }
  return { ...summary, cleanup: 'native-job-empty-and-wrapper-closed' };
}

async function main() {
  assert.equal(process.platform, 'win32', 'this executable experiment requires Windows; the suite inventory records other platforms as unexecuted');
  const empty = { type: 'exit', exitCode: 0, activeProcesses: 0 };
  const closed = { code: 0, signal: null, failure: null };
  assertCleanupProof(empty, closed);
  assert.throws(() => assertCleanupProof(null, closed), /authenticated Job zero-process/);
  assert.throws(() => assertCleanupProof({ ...empty, activeProcesses: 1 }, closed), /authenticated Job zero-process/);
  assert.throws(() => assertCleanupProof(empty, null), /retained wrapper close/);
  assert.throws(() => assertCleanupProof(empty, { ...closed, failure: new Error('missing receipt') }), /retained wrapper close/);
  assert.throws(() => assertCleanupProof(empty, { ...closed, code: 1 }), /retained wrapper close/);
  assert.throws(() => assertCleanupProof(empty, { ...closed, signal: 'SIGTERM' }), /retained wrapper close/);
  const accountProfile = os.userInfo().homedir;
  const tempRoot = assertAccountProfilePath(path.join(accountProfile, 'AppData', 'Local', 'Temp'), {
    profileRoot: accountProfile, requireOwnedProfile: true, field: 'FRA fixture scratch'
  });
  const temporary = fs.mkdtempSync(path.join(tempRoot, 'fra-pipe-handle-'));
  let summary;
  try { summary = await runOwnedExperiment(temporary); }
  catch (error) {
    if (fs.existsSync(temporary)) process.stderr.write(`FRA scratch retained at ${temporary}\n`);
    throw error;
  }
  process.stdout.write('FRA listener detached-launch tests passed.\n');
  process.stdout.write(JSON.stringify(summary) + '\n');
}

if (require.main === module) {
  const operation = process.argv[2] === '--contained-fixture'
    ? experiment(process.argv[3]).then(summary => process.stdout.write(JSON.stringify(summary) + '\n'))
    : main();
  operation.catch(error => {
    process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
    if (error instanceof AggregateError) {
      for (const cause of error.errors) process.stderr.write((cause.stack || String(cause)) + '\n');
    }
    process.exitCode = 1;
  });
}

module.exports = { assertCleanupProof, runOwnedExperiment };
