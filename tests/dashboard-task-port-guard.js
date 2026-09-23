'use strict';

// The scheduled wrapper must use the same netstat-backed probe as the restart
// controller. Get-NetTCPConnection alone can hide a listener owned by a full
// administrator token, which turns a failed reap into a false "port closed".
//
// PREVIOUSLY THIS FILE WAS TEXT-ONLY: every assertion below regex-matched
// tools/dashboard-task.ps1's SOURCE, never executed it. That is precisely the
// failure mode this project has been closing elsewhere -- a guard that checks
// source "looks right" reports health it never verified. Concretely, on
// 2026-08-09 two commits (47e090f5, 95d6b261) broke dashboard-task.ps1 so
// badly that EVERY invocation -- -DryRun, -Status, -Register, the real
// Task-Scheduler -RunComponent entrypoint, all of it -- threw before a single
// line of the script body ran: (1) a param() default referencing
// $PSScriptRoot under [CmdletBinding()], which is empty while defaults are
// evaluated, and (2) five later references to $managedRegistry, a variable
// the commit message claimed was "already loaded" but that was never
// assigned anywhere in the file. The second commit's own message claimed
// "Verified live (not just parsed)" and cited this file, all green, as part
// of that evidence. It could not have been: this file never ran the script.
// Both bugs are now fixed in tools/dashboard-task.ps1; the section below
// proves it by actually executing the functions it guards against a real
// disposable listener, so a regression like either one goes red here instead
// of passing silently again.
//
// WHAT STAYS TEXT-ONLY, AND WHY (residual risk, stated plainly): the
// Register/Unregister path (New-ScheduledTaskTrigger/-Settings, the RunLevel
// /LogonType/RestartCount literals) is deliberately not executed here. It
// requires SeBatchLogonRight (an elevated session) and mutates real Windows
// Task Scheduler state for the durable dashboard task that other tooling
// depends on; a unit-style guard test must not do that as a side effect of
// `node tools/test-run.js --all`. Those specific literals remain source
// assertions. Residual risk: a change to trigger/settings construction that
// is syntactically present but semantically wrong (e.g. a duration Task
// Scheduler silently rejects) will not be caught until an actual elevated
// -Register run or tests/scheduled-task-registrars.test.js, which checks
// registrar argv construction more broadly.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'tools', 'dashboard-task.ps1');
const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
const POWERSHELL = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function body(name, nextName) {
  const start = source.indexOf(`function ${name} {`);
  const end = nextName ? source.indexOf(`function ${nextName} {`, start) : source.length;
  assert.ok(start >= 0 && end > start, `${name} must remain a distinct function`);
  return source.slice(start, end);
}

// --- Structural facts about the canonical probe delegation and the
// Register-path literals that are not safe to execute here (see header). ---
assert.match(source, /\$portProbeScript\s*=\s*Join-Path\s+\$repoRoot\s+'tools\\port-listener-probe\.ps1'/,
  'the scheduled wrapper must use the canonical netstat-backed listener probe');
assert.match(body('Get-PortListeners', 'Wait-PortOpen'), /-File\s+\$portProbeScript\s+-Port\s+\$Port/,
  'Get-PortListeners must execute the canonical probe for its exact port');
assert.doesNotMatch(source, /Get-NetTCPConnection\s+-/,
  'the scheduled wrapper must not treat an incomplete Get-NetTCPConnection result as authoritative');
assert.doesNotMatch(body('Wait-PortClosed', 'Write-ChildStandardError'), /catch\s*\{\s*return\s+\$true\s*\}/,
  'a probe error must never be reported as a released port');
assert.match(source, /RepetitionInterval \(New-TimeSpan -Minutes 1\)/,
  'the dashboard task must have a durable one-minute recovery trigger');
assert.match(source, /RepetitionDuration \(New-TimeSpan -Days 3650\)/,
  'the durable recovery trigger must use a finite Task Scheduler duration');
assert.match(source, /FAILED liveness check: PID/,
  'the wrapper must notice a child that remains alive after losing its listener');

const statusStart = source.indexOf('function Show-Status {');
const statusEnd = source.indexOf('if ($DryRun) {', statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart, 'Show-Status must end before the command dispatch');
assert.doesNotMatch(source.slice(statusStart, statusEnd), /is not registered\."\s*\r?\n\s*Write-Output ''\s*\r?\n\s*continue/,
  'an unregistered task must still report whether an orphan holds its port');

// --- Behavioral proof: dot-source the real script (default params only --
// this hits the read-only Show-Status branch and returns before Register/
// Unregister/-RunComponent logic, see tools/dashboard-task.ps1's own
// dispatch order) and drive its actual listener-guard functions against a
// real, disposable loopback listener. No scheduled task is started, stopped,
// or touched. ---
async function startListener() {
  const child = spawn(process.execPath, ['-e', [
    "const net=require('node:net');",
    "const server=net.createServer();",
    "server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port,pid:process.pid})+'\\n'));",
    "process.on('SIGTERM',()=>server.close(()=>process.exit(0)));"
  ].join('')], {
    cwd: ROOT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  let text = '';
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('listener did not report a port within 10 seconds')), 10_000);
    child.stdout.on('data', chunk => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(text.slice(0, newline))); } catch (error) { reject(error); }
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`listener exited before ready (${code})`)));
  });
  return { child, ready };
}

function runPowerShellJson(script) {
  const stdout = execFileSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const marker = 'RESULT_JSON:';
  const line = stdout.split(/\r?\n/).find(candidate => candidate.startsWith(marker));
  assert.ok(line, `dashboard-task.ps1 probe did not print a result line; full output:\n${stdout}`);
  return JSON.parse(line.slice(marker.length));
}

(async () => {
  const { child, ready } = await startListener();
  try {
    const listener = await ready;

    // Phase 1: the listener is alive. Dot-source the real script and call its
    // real functions -- not a mock, not a re-implementation -- against it.
    const alive = runPowerShellJson([
      "$ErrorActionPreference = 'Stop'",
      `$null = . '${SCRIPT_PATH.replace(/'/g, "''")}'`,
      `$port = ${listener.port}`,
      `$truePid = ${listener.pid}`,
      '$result = [ordered]@{}',
      '$listeners = @(Get-PortListeners -Port $port)',
      '$result.listenerFoundByPid = @($listeners | Where-Object { [int]$_.pid -eq $truePid }).Count -gt 0',
      '$result.waitOpenTruePid = Wait-PortOpen -Port $port -OwningProcessId $truePid -TimeoutSeconds 5',
      // A wrong PID must never be reported as "open": this is the exact
      // 2026-07-28 false-positive class documented above Get-PortListeners
      // in tools/dashboard-task.ps1 (an orphan answering for a dead child).
      '$result.waitOpenWrongPidIsFalse = -not (Wait-PortOpen -Port $port -OwningProcessId 999999 -TimeoutSeconds 2)',
      '$result.ownerSummary = Get-PortOwnerSummary -Port $port',
      "$result.ownedByCorrectIdentity = [bool](Test-PortOwnedByDeclaredComponent -Port $port -Arguments @('node.exe'))",
      "$result.ownedByWrongIdentityIsFalse = -not (Test-PortOwnedByDeclaredComponent -Port $port -Arguments @('totally-not-a-real-binary.exe'))",
      'Write-Output "RESULT_JSON:$(ConvertTo-Json -Compress $result)"'
    ].join('; '));

    assert.equal(alive.listenerFoundByPid, true,
      `Get-PortListeners must find the real disposable listener PID ${listener.pid}; got ${JSON.stringify(alive)}`);
    assert.equal(alive.waitOpenTruePid, true, 'Wait-PortOpen must recognize the port as owned by its real PID');
    assert.equal(alive.waitOpenWrongPidIsFalse, true,
      'Wait-PortOpen must NOT report success for a PID that does not own the port (the orphan false-positive class)');
    assert.match(alive.ownerSummary, new RegExp(`PID ${listener.pid}`),
      `Get-PortOwnerSummary must name the real owning PID; got "${alive.ownerSummary}"`);
    assert.equal(alive.ownedByCorrectIdentity, true,
      'Test-PortOwnedByDeclaredComponent must recognize the real node.exe command line');
    assert.equal(alive.ownedByWrongIdentityIsFalse, true,
      'Test-PortOwnedByDeclaredComponent must not match an unrelated declared identity');

    console.log(`Dashboard task listener-guard behavioral checks passed against real PID ${listener.pid} on port ${listener.port}.`);

    // Phase 2: kill the real listener, then prove Wait-PortClosed observes
    // the real release -- not just that it returns some value.
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 250));

    const closed = runPowerShellJson([
      "$ErrorActionPreference = 'Stop'",
      `$null = . '${SCRIPT_PATH.replace(/'/g, "''")}'`,
      `$port = ${listener.port}`,
      '$result = @{ closed = (Wait-PortClosed -Port $port -TimeoutSeconds 8) }',
      'Write-Output "RESULT_JSON:$(ConvertTo-Json -Compress $result)"'
    ].join('; '));
    assert.equal(closed.closed, true, 'Wait-PortClosed must observe the real port release after the listener exits');

    console.log('Dashboard task listener-guard tests passed (structural + real listener execution).');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
