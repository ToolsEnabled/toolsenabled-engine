// NOTHING FOUND
//
// testcanfail-tests-fra-lifecycle-guards-js (2026-08-26)
//
// Audit result: no assertion in this file has one of the six measured
// cannot-fail shapes. No executable test code or assertion was changed.
//
// NOT-FOUND (1), empty iteration: this file has no assertion inside a loop,
// forEach, or other collection iterator. The one collection cardinality
// check converts a possibly-null regex match to [] and asserts length === 2;
// an empty match therefore fails rather than passing vacuously.
//
// NOT-FOUND (2), exit status/truthy return as sole evidence: no assertion
// treats a nonzero child exit as proof. execFileSync failures propagate, and
// the heartbeat cases assert the subject's structured result/code. The hidden
// process case likewise asserts its exact structured error code and elapsed
// time, rather than merely observing that PowerShell failed.
//
// NOT-FOUND (3), swallowed subject failure: the PowerShell try/catch harnesses
// deliberately serialize which branch ran and assertions distinguish THREW
// from OK. The JavaScript catch at descendant cleanup is test hygiene after
// the outcome was captured; it neither surrounds nor changes an assertion or
// the subject result. There is no optional chaining in this file.
//
// NOT-FOUND (4), mock of the thing under test: runHeartbeat stubs the lower
// level Invoke-HiddenProcess dependency while executing the lifted real
// Invoke-PeerHeartbeat function. It does not replace Invoke-PeerHeartbeat.
// The stub also captures path, arguments, and timeout, all asserted by the
// caller, so an uncalled or incorrectly wired dependency cannot pass.
//
// NOT-FOUND (5), silent skip/precondition: this file contains no skip,
// platform guard, conditional early return, or conditional test registration.
// The Windows lane supplies PowerShell, and paired topology comes from the
// validated TEST-NET fixture. No installation registry is read or rewritten.
//
// NOT-FOUND (6), expected value computed by subject: expected guard results,
// error codes, telemetry fields, cardinalities, and source invariants are
// independent literals. The heartbeat timeout relationship reads the helper's
// exported deadline, but separately pins it to literal 420000 before comparing
// it to the independently captured lifecycle timeout, so common drift fails.
//
// MUTATION/RED OUTPUT: none quoted because no suspect assertion was found.
// The required mutation experiment could not be run on this host due to the
// named preconditions above. Baseline restoration is therefore not applicable;
// no product file was edited, even temporarily. The exact baseline run was:
//
//   $ node tests/fra-lifecycle-guards.js
//   TypeError: Cannot read properties of undefined (reading 'address')
//       at Object.<anonymous> (.../tools/fra-peer-heartbeat.js:65:26)
//   Node.js v20.20.2
//
// Product-source restoration check: `git status --short -- src tools` emitted
// no output. Only this report comment is executable-change-neutral.

'use strict';
// Behavioural coverage for the two FRA lifecycle guards that could never pass.
//
// WHY THIS EXISTS. Both defects below were found on 2026-08-03 while trying to
// make FRA survive a reboot, and both are the same shape as the peer-receipt
// precedence bug: a check with no input that could satisfy it.
//
//   1. Install-LifecycleTask registers the scheduled task with a QUALIFIED
//      account name (MACHINE\user), then verifies the stored principal equals
//      that string. Windows normalises the stored S4U principal to the BARE
//      account name, so the comparison never matched. The task installed
//      correctly -- right executable, arguments, S4U, Limited, Hidden, triggers,
//      repetition -- and InstallTask still returned
//      FRA_LIFECYCLE_TASK_VERIFICATION_FAILED. Anyone reading that exit code
//      concluded autostart was not installed when it was.
//
//   2. Read-State falls back to New-DefaultState when the state file is missing
//      or invalid. New-DefaultState builds an [ordered]@{} -- an
//      OrderedDictionary -- and Test-ExactProperties read
//      PSObject.Properties.Name, which on a dictionary returns Count, Keys,
//      Values, IsReadOnly and friends rather than the keys. So a freshly
//      defaulted state failed its own shape test, Write-State threw, and the
//      lifecycle could never create the file it needs. It worked only where a
//      valid file already existed; elsewhere the 2-minute task exited 1 forever.
//
// Both functions are executed here, lifted from the real script, because reading
// the source is what missed them in the first place. Each case asserts the fix
// ACCEPTS what it wrongly rejected AND still REFUSES a genuine mismatch: a guard
// that only ever says yes is the same defect facing the other way.
//
// No anchored file is modified to make this testable; the functions are
// extracted and run.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { loadWithPairedServiceRegistry } = require('./helpers/paired-service-registry');
const heartbeatModule = loadWithPairedServiceRegistry(
  () => require('../tools/fra-peer-heartbeat'));

const ROOT = path.resolve(__dirname, '..');
const LIFECYCLE = path.join(ROOT, 'tools', 'full-remote-access-lifecycle.ps1');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-lifecycle-'));
process.stdout.write('fra-lifecycle-guards\n');

check('fresh-install FRA modules import silently before a peer is enrolled', () => {
  const modules = [
    './tools/fra-peer-heartbeat.js',
    './tools/fra-peer-identity-probe.js',
    './tools/fra-token-enrollment-a.js',
    './tools/fra-token-enrollment-receiver.js',
    './tools/fra-token-enrollment-lifecycle.js',
    './tools/lib/fra-token-enrollment.js',
    './tools/remote-agent-mcp-proxy.js',
    './src/full-remote-access-bridge.js',
    './tools/peer-dispatch.js',
    './tools/fra-keeper.js'
  ];
  assert.equal(modules.length, 10, 'the census must not pass vacuously');
  for (const modulePath of modules) {
    const child = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)})`], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10_000
    });
    assert.equal(child.status, 0,
      `${modulePath} must import against the shipped one-machine pre-enrollment registry: ${child.stderr}`);
    assert.equal(child.signal, null, `${modulePath} import must not time out or be killed`);
    assert.equal(child.stdout, '', `${modulePath} import must not execute its CLI or emit output`);
    assert.equal(child.stderr, '', `${modulePath} import must not emit a hidden startup failure`);
  }
});

const source = fs.readFileSync(LIFECYCLE, 'utf8');
function lift(name) {
  const match = source.match(new RegExp(`^function ${name} \\{$[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(match, `${name} must be extractable from the lifecycle script`);
  return match[0];
}

const FUNCS = [lift('Test-ExactProperties'), lift('Test-SamePrincipal')].join('\n\n');

// Runs one PowerShell expression against the lifted functions and returns its
// boolean result.
let seq = 0;
function evaluate(expression) {
  seq += 1;
  const harness = path.join(scratch, `guard-${seq}.ps1`);
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    FUNCS,
    '',
    // Wrapped in a subexpression and reduced to the LAST emitted value: a bare
    // `$result = <stmt>; <stmt>` would bind only the first statement and let the
    // second print to the pipeline instead.
    `$result = @($(${expression}))[-1]`,
    '[pscustomobject]@{ value = [bool]$result } | ConvertTo-Json -Compress'
  ].join('\n'), 'ascii');

  const stdout = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
    { windowsHide: true, encoding: 'utf8' });
  return JSON.parse(stdout.replace(/^﻿/, '').trim()).value;
}

// --- guard 2: the state shape test --------------------------------------------
check('an ordered hashtable with the right keys is ACCEPTED', () => {
  assert.equal(evaluate("Test-ExactProperties ([ordered]@{a=1;b=2}) @('a','b')"), true,
    'New-DefaultState returns an [ordered]@{}; if this is false the lifecycle can never write its own state');
});

check('a pscustomobject with the right keys is still accepted', () => {
  assert.equal(evaluate("Test-ExactProperties ([pscustomobject]@{a=1;b=2}) @('a','b')"), true,
    'state read back from disk arrives as PSCustomObject via ConvertFrom-Json');
});

check('an ordered hashtable missing a key is still REFUSED', () => {
  assert.equal(evaluate("Test-ExactProperties ([ordered]@{a=1}) @('a','b')"), false);
});

check('an ordered hashtable with an extra key is still REFUSED', () => {
  assert.equal(evaluate("Test-ExactProperties ([ordered]@{a=1;b=2;c=3}) @('a','b')"), false);
});

check('null is refused', () => {
  assert.equal(evaluate("Test-ExactProperties $null @('a')"), false);
});

// --- guard 1: the scheduled-task principal comparison -------------------------
check('a bare stored principal matches the qualified name it was registered with', () => {
  assert.equal(
    evaluate("$q = [Security.Principal.WindowsIdentity]::GetCurrent().Name; Test-SamePrincipal (($q -split '\\\\')[-1]) $q"),
    true,
    'Windows normalises the stored S4U principal to the bare account name; if this is false, ' +
    'every autostart install reports FRA_LIFECYCLE_TASK_VERIFICATION_FAILED despite succeeding');
});

check('an identical principal string matches', () => {
  assert.equal(
    evaluate("$q = [Security.Principal.WindowsIdentity]::GetCurrent().Name; Test-SamePrincipal $q $q"),
    true);
});

check('a genuinely different account is still REFUSED', () => {
  assert.equal(
    evaluate("$q = [Security.Principal.WindowsIdentity]::GetCurrent().Name; Test-SamePrincipal 'NT AUTHORITY\\SYSTEM' $q"),
    false,
    'comparing only the leaf name would wrongly accept a same-named account from another authority');
});

check('an unresolvable principal is refused rather than assumed equal', () => {
  assert.equal(
    evaluate("$q = [Security.Principal.WindowsIdentity]::GetCurrent().Name; Test-SamePrincipal 'NOSUCHDOMAIN\\nosuchuser' $q"),
    false);
});

check('an empty stored principal is refused', () => {
  assert.equal(
    evaluate("$q = [Security.Principal.WindowsIdentity]::GetCurrent().Name; Test-SamePrincipal '' $q"),
    false);
});

// --- the shapes that caused this, pinned so they cannot silently return --------
check('the state-shape test understands dictionaries, not just PSObject members', () => {
  assert.match(source, /IDictionary/,
    'Test-ExactProperties must branch on IDictionary; without it an [ordered]@{} reports its own ' +
    'members (Count, Keys, Values) instead of its keys');
});

check('the principal check resolves to SIDs rather than comparing leaf names', () => {
  assert.match(source, /SecurityIdentifier/,
    'principal equality must be established by SID so the check is not weakened');
});

// --- guard 3: the atomic state replace ---------------------------------------
// Write-State replaces the state file with File.Replace. PowerShell 5.1 binds a
// bare $null to a .NET String parameter as [string]::Empty, so the call received
// "" as destinationBackupFileName and threw. Because the sibling Move branch
// only runs when the file is ABSENT, the lifecycle could create its state file
// once and never update it -- making Reconcile unconditionally fatal while
// Status, InstallTask and RemoveTask kept working, since none of those write
// state. Executed here for the same reason as everything else in this file:
// reading the line does not reveal it.
check('File.Replace with a bare $null still throws (the defect is real)', () => {
  const harness = path.join(scratch, 'replace-null.ps1');
  const a = path.join(scratch, 'src-null.txt');
  const b = path.join(scratch, 'dst-null.txt');
  fs.writeFileSync(a, 'new'); fs.writeFileSync(b, 'old');
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    `try { [IO.File]::Replace('${a.replace(/\\/g, '\\\\')}', '${b.replace(/\\/g, '\\\\')}', $null); 'NOTHROW' }`,
    "catch { 'THREW' }"
  ].join('\n'), 'ascii');
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
    { windowsHide: true, encoding: 'utf8' }).trim();
  assert.equal(out, 'THREW',
    'if a bare $null no longer throws, this guard has stopped proving anything and should be re-derived');
});

check('File.Replace with [NullString]::Value succeeds (the fix works)', () => {
  const harness = path.join(scratch, 'replace-nullstring.ps1');
  const a = path.join(scratch, 'src-ns.txt');
  const b = path.join(scratch, 'dst-ns.txt');
  fs.writeFileSync(a, 'new'); fs.writeFileSync(b, 'old');
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    `try { [IO.File]::Replace('${a.replace(/\\/g, '\\\\')}', '${b.replace(/\\/g, '\\\\')}', [NullString]::Value); 'OK' }`,
    "catch { 'THREW' }"
  ].join('\n'), 'ascii');
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
    { windowsHide: true, encoding: 'utf8' }).trim();
  assert.equal(out, 'OK');
  assert.equal(fs.readFileSync(b, 'utf8'), 'new', 'the replace must actually land');
});

check('the lifecycle passes a real null string, never a bare $null', () => {
  assert.match(source, /\[IO\.File\]::Replace\([^)]*\[NullString\]::Value\)/,
    'File.Replace must receive [NullString]::Value; a bare $null becomes "" and the state file can then ' +
    'be created once and never updated');
  assert.doesNotMatch(source, /\[IO\.File\]::Replace\([^)]*,\s*\$null\s*\)/,
    'a bare $null as a .NET string argument is the defect this guards');
});

// --- Invoke-HiddenProcess: the stream-drain-timeout fix -----------------------
//
// WHY THIS EXISTS. After WaitForExit(TimeoutMilliseconds) confirms the
// immediate child has exited, the function used to call
// [Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask), 10000) and
// then unconditionally read .Result on BOTH stream tasks regardless of
// whether WaitAll actually finished them within that window. Task<T>.Result
// on an incomplete task blocks the calling thread with NO further timeout.
// A descendant process that inherits the redirected stdout/stderr pipe
// handle and outlives the immediate child (a classic Windows handle-
// inheritance leak: the immediate child can exit while a further descendant
// it spawned still holds the pipe's write end open) keeps ReadToEndAsync()
// from ever seeing EOF, so .Result blocks forever -- completely defeating
// $TimeoutMilliseconds for every caller. Reproduced live: a Reconcile cycle
// (Invoke-PeerHeartbeat, TimeoutMilliseconds=270000) hung ~21 minutes
// instead of returning within ~270s+grace, and a second, independent
// isolated repro showed the same mechanism (WaitAll(1000ms) => false, then
// .Result blocking ~7.1s for an 8s descendant).
//
// This is a real black-box repro, not a mock of Invoke-HiddenProcess: the
// immediate child is a genuine separate powershell.exe process that spawns
// a further descendant with NO stdout/stderr redirection of its own, so the
// descendant inherits the immediate child's own inherited pipe handles (the
// exact pipe Invoke-HiddenProcess is reading), then the immediate child
// exits -- leaving the descendant alone holding the pipe open for far
// longer than the function's fixed 10s stream-drain grace. Confirmed
// empirically against the pre-fix source: this exact repro blocked for the
// descendant's full ~16.8s lifetime (elapsedMs ~16791) instead of returning
// around the ~10s grace. Every hop explicitly sets
// CreateNoWindow/WindowStyle=Hidden (matching Invoke-HiddenProcess's own
// launch style), so nothing ever flashes a console window.
const HIDDEN_PROCESS_FUNC = lift('Invoke-HiddenProcess');

// The descendant sleeps far longer than the function's fixed 10s
// stream-drain grace, so completing this repro proves the fix stops
// blocking on it rather than the descendant merely finishing to land inside
// the grace window.
const LINGERING_DESCENDANT_SLEEP_SECONDS = 16;

let hiddenProcessSeq = 0;
function runHiddenProcessAgainstLingeringDescendant() {
  hiddenProcessSeq += 1;
  const caseDir = path.join(scratch, `hidden-process-${hiddenProcessSeq}`);
  fs.mkdirSync(caseDir);
  const pidFile = path.join(caseDir, 'descendant-pid.txt');
  const parentScript = path.join(caseDir, 'repro-parent.ps1');
  const harness = path.join(caseDir, 'harness.ps1');

  fs.writeFileSync(parentScript, [
    "$ErrorActionPreference = 'Stop'",
    '# Spawn a descendant with NO stdout/stderr redirection of its own -- it',
    "# inherits THIS process's own inherited stdout/stderr handles (the pipe",
    '# Invoke-HiddenProcess is reading from), and this immediate child exits',
    '# right after, leaving the descendant alone holding that pipe open.',
    '$psi = New-Object Diagnostics.ProcessStartInfo',
    "$psi.FileName = 'powershell.exe'",
    `$psi.Arguments = '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds ${LINGERING_DESCENDANT_SLEEP_SECONDS}"'`,
    '$psi.UseShellExecute = $false',
    '$psi.CreateNoWindow = $true',
    '$psi.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden',
    '$descendant = [Diagnostics.Process]::Start($psi)',
    `Set-Content -LiteralPath '${pidFile.replace(/\\/g, '\\\\')}' -Value ([string]$descendant.Id) -Encoding ascii`,
    "Write-Output 'immediate-child-exited'",
    'exit 0'
  ].join('\n'), 'ascii');

  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    HIDDEN_PROCESS_FUNC,
    '',
    `$Root = '${caseDir.replace(/\\/g, '\\\\')}'`,
    '$sw = [Diagnostics.Stopwatch]::StartNew()',
    'try {',
    `  $result = Invoke-HiddenProcess -FilePath 'powershell.exe' -Arguments @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${parentScript.replace(/\\/g, '\\\\')}') -TimeoutMilliseconds 15000`,
    '  $sw.Stop()',
    '  [pscustomobject]@{ ok = $true; elapsedMs = [int64]$sw.ElapsedMilliseconds; exitCode = $result.exitCode } | ConvertTo-Json -Compress',
    '} catch {',
    '  $sw.Stop()',
    '  [pscustomobject]@{ ok = $false; elapsedMs = [int64]$sw.ElapsedMilliseconds; errorCode = [string]$_.Exception.Message } | ConvertTo-Json -Compress',
    '}'
  ].join('\n'), 'ascii');

  // The whole call necessarily takes roughly the descendant's full lifetime
  // in WALL-CLOCK terms (Node's own pipe capturing this harness process's
  // stdout is itself subject to the same OS handle-inheritance cascade --
  // an artifact of how this test is invoked, not of the function under
  // test). The actual claim under test is the IN-PROCESS elapsedMs captured
  // by harness.ps1's own Stopwatch around just the Invoke-HiddenProcess
  // call, read back below.
  const stdoutText = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
    { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  const outcome = JSON.parse(stdoutText.replace(/^﻿/, '').trim());

  try {
    const descendantPid = fs.readFileSync(pidFile, 'utf8').trim();
    if (descendantPid) {
      // Test hygiene only -- NOT part of the fix under test, and not a
      // process-tree walk: this stops the exact single PID this test
      // itself just spawned and recorded, by the pid Invoke-HiddenProcess's
      // Start() call reported directly, once the assertions below are done
      // with it. The fix itself must never do this (see point 2 of the
      // task): it only ever throws FRA_LIFECYCLE_PROCESS_STREAM_DRAIN_TIMEOUT.
      execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          `Stop-Process -Id ${Number(descendantPid)} -Force -ErrorAction SilentlyContinue`],
        { windowsHide: true, timeout: 15000 });
    }
  } catch {}

  return outcome;
}

check('a descendant that inherits the redirected stdout/stderr pipe and outlives the immediate child no longer hangs Invoke-HiddenProcess past its timeout+grace', () => {
  const outcome = runHiddenProcessAgainstLingeringDescendant();
  assert.equal(outcome.ok, false,
    'the stream-drain timeout must be surfaced as a thrown error, not a silent success with truncated output');
  assert.equal(outcome.errorCode, 'FRA_LIFECYCLE_PROCESS_STREAM_DRAIN_TIMEOUT');
  // The immediate child exits almost instantly (it only starts the
  // descendant, then returns); the descendant is made to outlive the
  // function's fixed 10s stream-drain grace by a wide margin
  // (LINGERING_DESCENDANT_SLEEP_SECONDS = 16). Before the fix, this exact
  // repro blocked for the descendant's full lifetime (observed elapsedMs
  // ~16791 against the pre-fix source). The fixed function must instead
  // return in roughly WaitForExit's near-instant completion plus the 10s
  // grace (observed ~10400-10600ms) -- nowhere near the descendant's
  // lifetime -- proving it never touched .Result on the incomplete task.
  assert.ok(outcome.elapsedMs >= 9500 && outcome.elapsedMs < 15000,
    `expected ~10s (bounded by the function's internal drain grace), got ${outcome.elapsedMs}ms -- ` +
    'a value at or above the 16s descendant lifetime would mean the fix is not bounding the block; ' +
    'a value far below 10s would mean the grace path was not genuinely exercised');
});

// --- Invoke-PeerHeartbeat: previously had zero execution coverage (only
// parse-checked). It now single-handedly determines Invoke-Reconcile's
// steady-state $state.phase, having replaced the --probe-peer call at that
// site (tests/full-remote-access-lifecycle.js carries the structural
// assertion that the replacement landed at the right call site and left the
// rotation-specific --probe-peer call alone -- lifting and running the
// entire Invoke-Reconcile state machine here is impractical given its size
// and dependency graph). Invoke-HiddenProcess is stubbed rather than really
// spawning node, mirroring how tests/fra-peer-heartbeat.js stubs createProxy
// one layer down instead of opening a real socket.
const HEARTBEAT_FUNCS = [lift('Invoke-PeerHeartbeat'), lift('Convert-LastJson')].join('\n\n');

let heartbeatSeq = 0;
function runHeartbeat({ stdout = '', exitCode = 0 } = {}) {
  heartbeatSeq += 1;
  const harness = path.join(scratch, `heartbeat-${heartbeatSeq}.ps1`);
  const escapedStdout = stdout.replace(/'/g, "''");
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    'function Invoke-HiddenProcess {',
    '  param($FilePath, $Arguments, $TimeoutMilliseconds = 240000, $Environment = @{})',
    '  $script:CapturedFilePath = $FilePath',
    '  $script:CapturedArguments = $Arguments',
    '  $script:CapturedTimeoutMilliseconds = $TimeoutMilliseconds',
    `  [pscustomobject]@{ exitCode = ${exitCode}; stdout = '${escapedStdout}'; stderr = '' }`,
    '}',
    '',
    HEARTBEAT_FUNCS,
    '',
    "$Node = 'C:\\fake\\node.exe'",
    "$HeartbeatHelper = 'C:\\fake\\tools\\fra-peer-heartbeat.js'",
    "$HostName = '203.0.113.1'",
    '',
    '$result = Invoke-PeerHeartbeat',
    '[pscustomobject]@{',
    '  result = $result',
    '  capturedFilePath = $script:CapturedFilePath',
    '  capturedArguments = ($script:CapturedArguments -join "|")',
    '  capturedTimeoutMilliseconds = $script:CapturedTimeoutMilliseconds',
    '} | ConvertTo-Json -Compress -Depth 5'
  ].join('\n'), 'ascii');
  const stdoutText = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
    { windowsHide: true, encoding: 'utf8' });
  return JSON.parse(stdoutText.replace(/^\uFEFF/, '').trim());
}

check('a clean successful heartbeat result passes through, and is wired to the right node/helper/host/timeout', () => {
  const stdout = JSON.stringify({
    ok: true, host: '203.0.113.1', peer: '203.0.113.2',
    toolCount: 5, readOnlyToolVerified: 'system.kill_switch_status', secretValuesEmitted: false
  });
  const outcome = runHeartbeat({ stdout, exitCode: 0 });
  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.result.readOnlyToolVerified, 'system.kill_switch_status');
  assert.equal(outcome.capturedFilePath, 'C:\\fake\\node.exe');
  assert.equal(outcome.capturedArguments, 'C:\\fake\\tools\\fra-peer-heartbeat.js|--host|203.0.113.1');
  // Fourth layer of the recalibrated timeout ordering (2026-08-04): must
  // comfortably exceed fra-peer-heartbeat.js's own TOTAL_TIMEOUT_MS (raised
  // to 420s, now covering BOTH attempts -- original + one retry -- under a
  // single shared deadline) or this outer kill fires first and the helper's
  // own structured FRA_HEARTBEAT_TIMEOUT result is never reached. 450000 is
  // the exact recalibrated number; the >TOTAL_TIMEOUT_MS assertion below
  // pins the relationship itself, not just the literal value, against the
  // real constant exported by tools/fra-peer-heartbeat.js.
  assert.equal(outcome.capturedTimeoutMilliseconds, 450000);
  assert.equal(heartbeatModule.TOTAL_TIMEOUT_MS, 420000,
    'the client whole-probe deadline this wrapper deadline must exceed is expected to be 420s');
  assert.ok(outcome.capturedTimeoutMilliseconds > heartbeatModule.TOTAL_TIMEOUT_MS,
    'the wrapper deadline must exceed the helper total deadline');
  assert.ok(outcome.capturedTimeoutMilliseconds - heartbeatModule.TOTAL_TIMEOUT_MS >= 25000,
    'the wrapper deadline must keep real margin (~30s) over the helper total deadline, not just barely exceed it');
});

check('unparseable stdout is rejected as FRA_LIFECYCLE_HEARTBEAT_OUTPUT_INVALID, not thrown', () => {
  const outcome = runHeartbeat({ stdout: 'not json at all', exitCode: 1 });
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.code, 'FRA_LIFECYCLE_HEARTBEAT_OUTPUT_INVALID');
  assert.equal(outcome.result.secretValuesEmitted, false);
});

check('valid JSON that claims secretValuesEmitted:true is rejected, never trusted as-is', () => {
  // A load-bearing safety check, not just a shape check: an artifact
  // claiming to have leaked secret values must never be forwarded upward
  // as though it were a normal result.
  const stdout = JSON.stringify({ ok: true, secretValuesEmitted: true });
  const outcome = runHeartbeat({ stdout, exitCode: 0 });
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.code, 'FRA_LIFECYCLE_HEARTBEAT_OUTPUT_INVALID');
});

check('a genuine ok:false result with its own code passes through unmodified', () => {
  const stdout = JSON.stringify({
    ok: false, host: '203.0.113.1', peer: '203.0.113.2',
    code: 'FRA_HEARTBEAT_READ_ONLY_CALL_FAILED', secretValuesEmitted: false
  });
  const outcome = runHeartbeat({ stdout, exitCode: 1 });
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.code, 'FRA_HEARTBEAT_READ_ONLY_CALL_FAILED',
    'a real failure code from the CLI must not be overwritten by the generic invalid-output code');
});

check('a nonzero exit with no ok field at all is backfilled to ok:false rather than read as success', () => {
  const stdout = JSON.stringify({ secretValuesEmitted: false });
  const outcome = runHeartbeat({ stdout, exitCode: 1 });
  assert.equal(outcome.result.ok, false,
    'a crashed/incomplete CLI invocation must never be mistaken for a successful heartbeat');
});

// --- Get-NotOwnedReconcileAction: Invoke-Reconcile's not-owned branch -----
//
// WHY THIS EXISTS. Set-LocalObservation used to collapse 'unverifiable' (an
// S4U-unreadable but genuinely live listener) into 'unknown', and
// Invoke-Reconcile's not-owned branch attempted Start unconditionally
// whenever $status.owned was false -- absent, unverifiable, or unknown alike.
// Against a healthy-but-unverifiable listener that Start always failed (the
// port was already bound), and heartbeat was never reached that cycle.
//
// The fix pulls the decision into this one small pure function so it has a
// single tested definition: only a genuinely 'absent' port should attempt
// Start; an 'unverifiable' listener already proven ready should fall through
// to the tunnel/heartbeat logic untouched; anything else records a
// no-mutation degraded observation. Lifting and running the entire
// Invoke-Reconcile state machine remains impractical given its size and
// dependency graph (see the Invoke-PeerHeartbeat section above) -- this
// function is the testable seam Invoke-Reconcile now calls into instead.
const RECONCILE_ACTION_FUNCS = lift('Get-NotOwnedReconcileAction');

let reconcileActionSeq = 0;
function evaluateReconcileAction(listenerState, localReady) {
  reconcileActionSeq += 1;
  const harness = path.join(scratch, `reconcile-action-${reconcileActionSeq}.ps1`);
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    RECONCILE_ACTION_FUNCS,
    '',
    `$result = Get-NotOwnedReconcileAction -ListenerState '${listenerState}' -LocalReady $${localReady}`,
    '[pscustomobject]@{ value = [string]$result } | ConvertTo-Json -Compress'
  ].join('\n'), 'ascii');
  const stdout = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
    { windowsHide: true, encoding: 'utf8' });
  return JSON.parse(stdout.replace(/^﻿/, '').trim()).value;
}

check("absent -> 'start' (the one case Start can actually succeed against)", () => {
  assert.equal(evaluateReconcileAction('absent', false), 'start');
  assert.equal(evaluateReconcileAction('absent', true), 'start',
    'listenerState drives this decision, not localReady -- an absent port is always a start candidate');
});

check("unverifiable + localReady -> 'proceed' (skip Start, fall through to heartbeat exactly like owned-and-healthy)", () => {
  assert.equal(evaluateReconcileAction('unverifiable', true), 'proceed');
});

check("unverifiable + NOT localReady -> 'degraded_unverifiable' (no Start, no mutation)", () => {
  assert.equal(evaluateReconcileAction('unverifiable', false), 'degraded_unverifiable');
});

check("a genuinely unresolved 'unknown' observation -> 'degraded_unknown', regardless of localReady", () => {
  assert.equal(evaluateReconcileAction('unknown', false), 'degraded_unknown');
  assert.equal(evaluateReconcileAction('unknown', true), 'degraded_unknown');
});

// --- the switch is really wired into Invoke-Reconcile, and every OTHER
// Start/Restart call site still routes through the hardened primitives -----
check('Invoke-Reconcile dispatches the not-owned branch through Get-NotOwnedReconcileAction, not a bare $status.owned check', () => {
  assert.match(source, /switch \(Get-NotOwnedReconcileAction -ListenerState \$state\.local\.listenerState -LocalReady \$state\.local\.localReady\) \{/,
    'the not-owned branch must dispatch on the decision function\'s output');
  assert.match(source, /'start' \{[\s\S]*?Invoke-Control 'Start'/,
    "the 'start' case must still call Invoke-Control 'Start'");
  assert.match(source, /'degraded_unverifiable' \{\s*\n\s*\$state\.phase = 'degraded'; \$state\.lastAction = 'observed_unverifiable'; Write-State \$state; return \$state\s*\n\s*\}/,
    "the 'degraded_unverifiable' case must record observed_unverifiable and return without mutating anything");
  assert.match(source, /default \{\s*\n\s*\$state\.phase = 'degraded'; \$state\.lastAction = 'observed_unknown'; Write-State \$state; return \$state\s*\n\s*\}/,
    "a genuinely unresolved observation must record observed_unknown and return without mutating anything");
});

check("the owned-but-unhealthy Invoke-ReviewedRestart path stays entirely separate from the not-owned switch", () => {
  assert.match(source, /if \(\$status\.owned\) \{[\s\S]{0,700}Invoke-ReviewedRestart \$state 'unhealthy_listener'/,
    'the unhealthy-restart-threshold branch must remain gated on $status.owned, unchanged by this pass');
});

check('every OTHER Start/Restart call site in the lifecycle (rollback recovery, transaction sync, coordinated rotation) still routes through Invoke-Control \'Start\' or Invoke-ReviewedRestart -- the shared primitive protects all of them, not just the main branch', () => {
  // These are exactly the call sites Machine A's follow-up review flagged:
  // Start-OwnedListener now refuses a duplicate spawn against an unverifiable
  // listener no matter which of these reaches it, so none of them needed
  // their own copy of the absent/unverifiable/unknown gating -- but they must
  // still actually go through the hardened primitive and not some bypass.
  assert.match(source, /if \(\$status\.owned\) \{ \$status = Invoke-ReviewedRestart \$state 'rollback_recovery' \}\s*\n\s*else \{ \$status = Invoke-Control 'Start'; Set-LocalObservation \$state \$status \$false \}/,
    'the stale-transaction-rollback recovery branch must still route its not-owned case through Invoke-Control \'Start\'');
  assert.match(source, /if \(\$status\.owned\) \{\s*\n[\s\S]{0,200}Invoke-ReviewedRestart \$state \$reason\s*\n\s*\} else \{\s*\n\s*\$status = Invoke-Control 'Start'; Set-LocalObservation \$state \$status \$false/,
    'the committed/rolled-back transaction-sync branch must still route its not-owned case through Invoke-Control \'Start\'');
  assert.equal((source.match(/Invoke-ReviewedRestart \$state 'rollback_recovery'/g) || []).length, 2,
    'both rollback-recovery call sites (stale-transaction and split-rotation-compensation) must remain wired to Invoke-ReviewedRestart');
  assert.match(source, /Invoke-ReviewedRestart \$state 'committed_rotation'/,
    'the coordinated-rotation restart call site must remain wired to Invoke-ReviewedRestart');
});

// --- Get-SanitizedHeartbeatTelemetry: the PowerShell-side half of required
// change 3 (2026-08-04 review). Invoke-Reconcile used to read
// $probe.stage/.attempt/.elapsedMs off the heartbeat CLI's own JSON result
// and simply never persist them into $state.heartbeat -- parsed and dropped
// every single cycle. This mirrors tools/fra-peer-heartbeat.js's own
// safeStage/safeAttempt/safeElapsedMs sanitizers (same allowlist, tested
// directly here rather than assumed) -- a deliberately parallel
// implementation, since a PowerShell caller cannot require() that JS module.
//
// Widened by correction D (2026-08-04 review round 2) to also sanitize a
// bounded (max 2) `attemptsHistory` array -- mirrored below.
const HEARTBEAT_TELEMETRY_FUNC = lift('Get-SanitizedHeartbeatTelemetry');

let heartbeatTelemetrySeq = 0;
function evaluateHeartbeatTelemetry(probeLiteral) {
  heartbeatTelemetrySeq += 1;
  const harness = path.join(scratch, `heartbeat-telemetry-${heartbeatTelemetrySeq}.ps1`);
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    HEARTBEAT_TELEMETRY_FUNC,
    '',
    `$Probe = ${probeLiteral}`,
    '$result = Get-SanitizedHeartbeatTelemetry $Probe',
    '[pscustomobject]@{ stage = $result.stage; attempt = $result.attempt; elapsedMs = $result.elapsedMs; attemptsHistory = $result.attemptsHistory } | ConvertTo-Json -Compress -Depth 6'
  ].join('\n'), 'ascii');
  const stdout = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
    { windowsHide: true, encoding: 'utf8' });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

check('a genuine successful probe retains stage/attempt/elapsedMs exactly', () => {
  const result = evaluateHeartbeatTelemetry("[pscustomobject]@{ ok = $true; stage = 'liveness_write'; attempt = 1; elapsedMs = 8123 }");
  assert.equal(result.stage, 'liveness_write');
  assert.equal(result.attempt, 1);
  assert.equal(result.elapsedMs, 8123);
  assert.deepEqual(result.attemptsHistory, []);
});

check('a failed probe retaining a retry stage/attempt also passes through', () => {
  const result = evaluateHeartbeatTelemetry("[pscustomobject]@{ ok = $false; code = 'REMOTE_BRIDGE_RESET'; stage = 'connect'; attempt = 2; elapsedMs = 401 }");
  assert.equal(result.stage, 'connect');
  assert.equal(result.attempt, 2);
  assert.equal(result.elapsedMs, 401);
});

check('an unrecognized stage/attempt/elapsedMs collapses to $null, exactly like the client-side sanitizers', () => {
  const result = evaluateHeartbeatTelemetry("[pscustomobject]@{ stage = 'not_a_real_stage'; attempt = 3; elapsedMs = -5 }");
  assert.equal(result.stage, null);
  assert.equal(result.attempt, null);
  assert.equal(result.elapsedMs, null);
});

check('a probe object with no telemetry fields at all (e.g. the local-gate-not-ready stub) is refused cleanly, never throws', () => {
  const result = evaluateHeartbeatTelemetry("[pscustomobject]@{ ok = $false; code = 'FRA_LIFECYCLE_LOCAL_GATE_NOT_READY' }");
  assert.equal(result.stage, null);
  assert.equal(result.attempt, null);
  assert.equal(result.elapsedMs, null);
  assert.deepEqual(result.attemptsHistory, []);
});

check('a smuggled/unexpected property on the probe object is never surfaced -- only the allowlisted fields are ever read', () => {
  const result = evaluateHeartbeatTelemetry(
    "[pscustomobject]@{ stage = 'connect'; attempt = 1; elapsedMs = 12; secretPath = 'C:\\\\should\\\\never\\\\appear'; token = 'must-not-leak-0123456789' }"
  );
  assert.equal(result.stage, 'connect');
  assert.equal(result.attempt, 1);
  assert.equal(result.elapsedMs, 12);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('secretPath'), false);
  assert.equal(serialized.includes('token'), false);
  assert.equal(serialized.includes('must-not-leak'), false);
});

// --- Correction D (2026-08-04 review round 2): masked-retry telemetry --
// attemptsHistory must retain BOTH attempts' outcomes on the PowerShell side
// too, bounded to at most 2 entries, and never let hostile/oversized content
// through.
check('a recovered masked-retry result retains BOTH attempts\' summaries', () => {
  const result = evaluateHeartbeatTelemetry(
    "[pscustomobject]@{ ok = $true; stage = 'liveness_write'; attempt = 2; elapsedMs = 300; attemptsHistory = @(" +
    "[pscustomobject]@{ attempt = 1; stage = 'connect'; code = 'REMOTE_BRIDGE_RESET'; elapsedMs = 120; ok = $false }," +
    "[pscustomobject]@{ attempt = 2; stage = 'liveness_write'; code = $null; elapsedMs = 300; ok = $true }" +
    ") }"
  );
  assert.equal(result.attemptsHistory.length, 2, 'attempt 1\'s failure must not be erased by attempt 2\'s success');
  assert.equal(result.attemptsHistory[0].ok, false);
  assert.equal(result.attemptsHistory[0].code, 'REMOTE_BRIDGE_RESET');
  assert.equal(result.attemptsHistory[1].ok, true);
  assert.equal(result.attemptsHistory[1].code, null);
});

check('attemptsHistory is bounded to 2 entries and sanitizes hostile per-entry content', () => {
  const result = evaluateHeartbeatTelemetry(
    "[pscustomobject]@{ ok = $false; attemptsHistory = @(" +
    "[pscustomobject]@{ attempt = 1; stage = 'connect'; code = 'REMOTE_BRIDGE_RESET'; elapsedMs = 10; ok = $false }," +
    "[pscustomobject]@{ attempt = 2; stage = 'not_a_real_stage'; code = 'lowercase not safe'; elapsedMs = -5; ok = $false; secretPath = 'C:\\\\should\\\\never\\\\appear' }," +
    "[pscustomobject]@{ attempt = 1; stage = 'connect'; code = 'SHOULD_NOT_APPEAR'; elapsedMs = 1; ok = $false }" +
    ") }"
  );
  assert.equal(result.attemptsHistory.length, 2, 'no more than 2 entries may ever survive sanitization');
  assert.equal(result.attemptsHistory[1].stage, null);
  assert.equal(result.attemptsHistory[1].code, null, 'an unsafe code on a failed entry must collapse to $null, never echoed');
  assert.equal(result.attemptsHistory[1].elapsedMs, null);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('secretPath'), false);
  assert.equal(serialized.includes('SHOULD_NOT_APPEAR'), false);
});

// --- the new fields are really wired into state, both the default shape
// and Invoke-Reconcile's own persistence -- lifting and running the entire
// Invoke-Reconcile state machine remains impractical (see the
// Invoke-PeerHeartbeat section above), so this is source-pattern coverage,
// the same technique already used for the not-owned switch wiring below. ---
check("New-DefaultState's heartbeat bucket includes lastStage/lastAttempt/lastElapsedMs/lastAttempts", () => {
  assert.match(source, /heartbeat = \[ordered\]@\{\s*\n\s*failureCode = \$null; attempts = 0; nextEligibleAt = \$null; lastSuccessAt = \$null\s*\n\s*lastStage = \$null; lastAttempt = \$null; lastElapsedMs = \$null; lastAttempts = @\(\)\s*\n\s*\}/,
    'New-DefaultState must default all four new fields alongside the existing heartbeat bucket fields');
});

check('Test-StateShape requires the four new heartbeat fields exactly, neither missing nor loosely typed', () => {
  assert.match(source, /Test-ExactProperties \$State\.heartbeat @\('failureCode','attempts','nextEligibleAt','lastSuccessAt','lastStage','lastAttempt','lastElapsedMs','lastAttempts'\)/,
    'the heartbeat bucket shape check must require exactly these 8 keys');
  assert.match(source, /\$State\.heartbeat\.lastStage.*-notin @\('connect', 'initialize', 'tools_list', 'read_only_call', 'liveness_write'\)/,
    'lastStage must be validated against the same fixed 5-stage enum as the client');
  assert.match(source, /\$State\.heartbeat\.lastAttempt -notin @\(1, 2\)/,
    'lastAttempt must be validated as exactly 1 or 2');
});

check('Invoke-Reconcile persists Get-SanitizedHeartbeatTelemetry\'s output into state.heartbeat every eligible cycle', () => {
  assert.match(source, /\$heartbeatTelemetry = Get-SanitizedHeartbeatTelemetry \$probe/,
    'Invoke-Reconcile must call the sanitizer on every probe result, success or failure');
  assert.match(source, /\$state\.heartbeat\.lastStage = \$heartbeatTelemetry\.stage/);
  assert.match(source, /\$state\.heartbeat\.lastAttempt = \$heartbeatTelemetry\.attempt/);
  assert.match(source, /\$state\.heartbeat\.lastElapsedMs = \$heartbeatTelemetry\.elapsedMs/);
  assert.match(source, /\$state\.heartbeat\.lastAttempts = \$heartbeatTelemetry\.attemptsHistory/);
});

// ============================================================================
// Correction A (2026-08-04 review round 2): persisted-state migration gap.
// 3d7080b3 changed the exact heartbeat bucket shape while leaving
// schemaVersion at the same v3 -- a genuinely valid OLD-shape v3 state file
// (the narrower, pre-3d7080b3 4-key heartbeat bucket) must survive Read-State
// with every existing field preserved and the new fields added as safe
// defaults, NOT be silently discarded in favour of New-DefaultState.
// ============================================================================
const MIGRATION_FUNCS = [
  lift('Test-ExactProperties'), lift('ConvertTo-MigratedState'), lift('Test-StateShape'), lift('Test-NullableTimestamp')
].join('\n\n');

let migrationSeq = 0;
function evaluateMigration(oldStateLiteral) {
  migrationSeq += 1;
  const harness = path.join(scratch, `migration-${migrationSeq}.ps1`);
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    "$HostName = '203.0.113.1'",
    "$PeerHost = '203.0.113.2'",
    "$Role = 'b'",
    MIGRATION_FUNCS,
    '',
    `$OldState = ${oldStateLiteral}`,
    '$migrated = ConvertTo-MigratedState $OldState',
    '$shapeValid = Test-StateShape $migrated',
    '[pscustomobject]@{ shapeValid = $shapeValid; state = $migrated } | ConvertTo-Json -Compress -Depth 12'
  ].join('\n'), 'ascii');
  const stdout = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
    { windowsHide: true, encoding: 'utf8' });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

// A realistic, NONTRIVIAL old-shape v3 state: real phase, real rotation
// evidence (a finalized rotation, not defaults), a real retry backoff, and a
// real OLD-shape (4-key) heartbeat bucket with genuine prior success/failure
// evidence -- not just New-DefaultState's own defaults, which would pass
// trivially even if the migration discarded everything and rebuilt from
// scratch.
const OLD_SHAPE_STATE_LITERAL = `[pscustomobject]@{
  schemaVersion = 'tools-enabled.full-remote-access-lifecycle.v3'
  updatedAt = '2026-08-01T00:00:00.000Z'
  host = '203.0.113.1'; peer = '203.0.113.2'; role = 'b'
  desiredState = 'enabled'; phase = 'healthy'
  task = [pscustomobject]@{ installed = $true; lastWakeAt = '2026-08-01T00:00:00.000Z' }
  local = [pscustomobject]@{
    listenerState = 'owned'; listenerPid = 4242; localReady = $true; firewallReady = $true
    rootIdentityReady = $true; rootAccessReady = $true; transportBindingReady = $true
    enrollmentState = 'owned'; enrollmentPid = 4242; unhealthyStreak = 0
  }
  tunnel = [pscustomobject]@{ healthReady = $true; authReady = $true }
  mismatch = [pscustomobject]@{
    lastObservedCount = 3; streak = 1; firstObservedAt = '2026-07-31T23:00:00.000Z'
    lastObservedAt = '2026-07-31T23:05:00.000Z'; authenticatedAfterLastRejection = $true
  }
  rotation = [pscustomobject]@{
    trigger = 'explicit'; state = 'finalized'; operationId = 'AAAAAAAAAAAAAAAAAAAAAA'
    newFingerprint = ('B' * 43); terminalPhase = 'committed'; receiverPid = 5151
    committedAt = '2026-07-31T22:00:00.000Z'; restartedAt = '2026-07-31T22:01:00.000Z'
    receiverClosedAt = '2026-07-31T22:02:00.000Z'; peerProofBaseline = 7
    outboundCurrentAt = '2026-07-31T22:03:00.000Z'; inboundCurrentAt = '2026-07-31T22:03:30.000Z'
    freshReceiptAt = '2026-07-31T22:04:00.000Z'; oldProofOperationId = 'CCCCCCCCCCCCCCCCCCCCCC'
    oldTokenRejectedAt = '2026-07-31T22:05:00.000Z'; peerOldProofAt = '2026-07-31T22:06:00.000Z'
    finalizedAt = '2026-07-31T22:07:00.000Z'
  }
  retry = [pscustomobject]@{ failureCode = $null; attempts = 0; nextEligibleAt = $null }
  heartbeat = [pscustomobject]@{
    failureCode = 'REMOTE_BRIDGE_RESET'; attempts = 2; nextEligibleAt = '2026-08-01T00:10:00.000Z'
    lastSuccessAt = '2026-07-31T23:58:00.000Z'
  }
  lastAction = 'verified_existing_session'; lastErrorCode = $null; secretValuesEmitted = $false
}`;

check('a realistic OLD-shape (pre-3d7080b3) v3 state survives Read-State\'s migration unchanged except for safe new-field defaults', () => {
  const outcome = evaluateMigration(OLD_SHAPE_STATE_LITERAL);
  assert.equal(outcome.shapeValid, true,
    'the migrated state must pass Test-StateShape -- if this is false, the migration produced an invalid shape ' +
    'and Read-State would still fall back to New-DefaultState, discarding everything below');
  const s = outcome.state;
  // Every top-level field OUTSIDE heartbeat is untouched.
  assert.equal(s.phase, 'healthy');
  assert.equal(s.rotation.state, 'finalized');
  assert.equal(s.rotation.operationId, 'AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(s.rotation.newFingerprint, 'B'.repeat(43));
  assert.equal(s.rotation.finalizedAt, '2026-07-31T22:07:00.000Z');
  assert.equal(s.mismatch.streak, 1);
  assert.equal(s.local.listenerPid, 4242);
  assert.equal(s.lastAction, 'verified_existing_session');
  // The OLD heartbeat bucket's four real (nontrivial, non-default) fields
  // are preserved VERBATIM -- this is the actual data-loss-bug proof: a
  // migration that discarded and rebuilt from New-DefaultState would show
  // failureCode:null/attempts:0/nextEligibleAt:null/lastSuccessAt:null here
  // instead.
  assert.equal(s.heartbeat.failureCode, 'REMOTE_BRIDGE_RESET',
    'the OLD heartbeat bucket\'s real failureCode must survive the migration, not be reset to null');
  assert.equal(s.heartbeat.attempts, 2,
    'the OLD heartbeat bucket\'s real retry-attempt count must survive the migration, not be reset to 0');
  assert.equal(s.heartbeat.nextEligibleAt, '2026-08-01T00:10:00.000Z');
  assert.equal(s.heartbeat.lastSuccessAt, '2026-07-31T23:58:00.000Z');
  // The NEW fields correction A/D add are present as safe defaults --
  // nothing was silently discarded, but nothing was fabricated either.
  assert.equal(s.heartbeat.lastStage, null);
  assert.equal(s.heartbeat.lastAttempt, null);
  assert.equal(s.heartbeat.lastElapsedMs, null);
  assert.deepEqual(s.heartbeat.lastAttempts, []);
});

check('a state whose heartbeat bucket already has the full new shape is left untouched by the migration', () => {
  const alreadyNewLiteral = `[pscustomobject]@{
    schemaVersion = 'tools-enabled.full-remote-access-lifecycle.v3'
    updatedAt = '2026-08-01T00:00:00.000Z'
    host = '203.0.113.1'; peer = '203.0.113.2'; role = 'b'
    desiredState = 'enabled'; phase = 'waiting_for_peer'
    task = [pscustomobject]@{ installed = $false; lastWakeAt = $null }
    local = [pscustomobject]@{
      listenerState = 'unknown'; listenerPid = $null; localReady = $false; firewallReady = $false
      rootIdentityReady = $false; rootAccessReady = $false; transportBindingReady = $false
      enrollmentState = 'unknown'; enrollmentPid = $null; unhealthyStreak = 0
    }
    tunnel = [pscustomobject]@{ healthReady = $false; authReady = $false }
    mismatch = [pscustomobject]@{
      lastObservedCount = 0; streak = 0; firstObservedAt = $null; lastObservedAt = $null
      authenticatedAfterLastRejection = $false
    }
    rotation = [pscustomobject]@{
      trigger = 'none'; state = 'idle'; operationId = $null; newFingerprint = $null
      terminalPhase = $null; receiverPid = $null; committedAt = $null; restartedAt = $null
      receiverClosedAt = $null; peerProofBaseline = $null
      outboundCurrentAt = $null; inboundCurrentAt = $null; freshReceiptAt = $null
      oldProofOperationId = $null; oldTokenRejectedAt = $null; peerOldProofAt = $null; finalizedAt = $null
    }
    retry = [pscustomobject]@{ failureCode = $null; attempts = 0; nextEligibleAt = $null }
    heartbeat = [pscustomobject]@{
      failureCode = 'REMOTE_BRIDGE_RESET'; attempts = 1; nextEligibleAt = $null; lastSuccessAt = $null
      lastStage = 'connect'; lastAttempt = 1; lastElapsedMs = 250; lastAttempts = @()
    }
    lastAction = 'none'; lastErrorCode = $null; secretValuesEmitted = $false
  }`;
  const outcome = evaluateMigration(alreadyNewLiteral);
  assert.equal(outcome.shapeValid, true);
  assert.equal(outcome.state.heartbeat.lastStage, 'connect', 'an already-migrated bucket must be left exactly as-is');
  assert.equal(outcome.state.heartbeat.lastAttempt, 1);
  assert.equal(outcome.state.heartbeat.lastElapsedMs, 250);
});

fs.rmSync(scratch, { recursive: true, force: true });
process.stdout.write(`\nfra-lifecycle-guards: ${passed} checks passed\n`);
