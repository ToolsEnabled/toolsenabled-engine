'use strict';

/* host.exec WITH SHELL `cmd` HANDS cmd.exe THE COMMAND EXACTLY AS WRITTEN
 * (platform review 1.0.50 E2).
 *
 * host.exec ran `cmd.exe /d /s /c <command>` through the Windows job wrapper,
 * whose QuoteArgument wraps an argument containing a space or a quote and
 * writes each inner `"` as `\"` -- the C runtime's escaping. cmd.exe does not
 * read `\"`, so `"C:\Program Files\Git\bin\git.exe" status` failed with "The
 * filename, directory name, or volume label syntax is incorrect." and
 * `echo "hi"` printed the backslashes.
 *
 * The fix is Node's own spelling of a cmd.exe command line (what
 * `shell: true` builds): `cmd.exe /d /s /c "<command>"`, passed verbatim. /s
 * strips exactly the outer pair of quotes and runs the rest as written. The
 * job wrapper gains a verbatim mode for that, requested with Node's option
 * name, windowsVerbatimArguments.
 *
 * Checked here without Windows:
 *   - host.exec builds that argv and asks for verbatim arguments, for `cmd`
 *     only; PowerShell is unchanged;
 *   - spawnInJob carries the request to the wrapper as -VerbatimArguments and
 *     never applies it to the wrapper's own PowerShell command line;
 *   - the wrapper's C# command-line builder, compiled from the shipped
 *     tools/windows-job-wrapper.ps1 by PowerShell 7 when this machine has it,
 *     produces the line cmd.exe needs in verbatim mode and the old line
 *     otherwise. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const host = require('../src/lib/providers/host-control');
const jobs = require('../src/lib/windows-job-control');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(ROOT, 'tools', 'windows-job-wrapper.ps1');
const CMD = '\\\\.\\GLOBALROOT\\SystemRoot\\System32\\cmd.exe';
const QUOTED_COMMAND = '"\x43:\\Program Files\\Git\\bin\\git.exe" status';

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

async function launchOn(shell, command) {
  const child = fakeChild();
  const launches = [];
  const pending = host.exec({ command, shell, timeoutMs: 5000 }, {
    platform: 'win32',
    requireRecordAsync: async () => ({ ok: true, durable: true, anchored: true }),
    recordAsync: async () => ({ ok: true, durable: true }),
    spawnInJobImpl(file, argv, options) {
      launches.push({ file, argv, options });
      setImmediate(() => child.emit('close', 0));
      return child;
    }
  });
  const result = await pending;
  assert.equal(launches.length, 1);
  return { launch: launches[0], result };
}

test('host.exec cmd passes the command to cmd.exe verbatim inside one pair of quotes', async () => {
  const { launch, result } = await launchOn('cmd', QUOTED_COMMAND);
  assert.equal(launch.file, CMD);
  assert.deepEqual(launch.argv, ['/d', '/s', '/c', `"${QUOTED_COMMAND}"`]);
  assert.equal(launch.options.windowsVerbatimArguments, true, 'cmd.exe must receive the line without C runtime escaping');
  assert.equal(launch.options.shell, false);
  assert.equal(result.command, QUOTED_COMMAND, 'the reported command is the one the person wrote');
});

test('host.exec powershell is unchanged and never verbatim', async () => {
  const { launch } = await launchOn('powershell', 'Write-Output "hi"');
  assert.match(launch.file, /powershell\.exe$/);
  assert.deepEqual(launch.argv.slice(-2), ['-Command', 'Write-Output "hi"']);
  assert.equal(Object.hasOwn(launch.options, 'windowsVerbatimArguments'), false);
});

test('spawnInJob carries verbatim mode to the wrapper only', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'job-verbatim-'));
  try {
    const observed = [];
    const fixtureChild = { pid: 4242, stdin: null, stdout: null, stderr: null, stdio: null, once() {}, on() {} };
    const launch = options => jobs.spawnInJob(CMD, ['/d', '/s', '/c', `"${QUOTED_COMMAND}"`], { cwd: temp, env: process.env, ...options }, {
      platform: 'win32', safeLaunchEnvironment, wrapperScript: WRAPPER, recordDirectory: path.join(temp, 'records'),
      assemblyCacheDirectory: null,
      spawnImpl(command, args, spawnOptions) { observed.push({ command, args, spawnOptions }); return fixtureChild; }
    });
    launch({ windowsVerbatimArguments: true });
    launch({});
    const [verbatim, plain] = observed;
    assert.ok(verbatim.args.includes('-VerbatimArguments'), 'the wrapper must be told to pass the arguments verbatim');
    assert.equal(plain.args.includes('-VerbatimArguments'), false, 'without the request the wrapper quotes as before');
    for (const { spawnOptions } of observed) {
      assert.equal(Object.hasOwn(spawnOptions, 'windowsVerbatimArguments'), false,
        "the wrapper's own PowerShell command line is never verbatim");
    }
    const decoded = JSON.parse(Buffer.from(verbatim.args[verbatim.args.indexOf('-ArgumentsBase64') + 1], 'base64').toString('utf8'));
    assert.deepEqual(decoded, ['/d', '/s', '/c', `"${QUOTED_COMMAND}"`], 'the arguments reach the wrapper unchanged');
    assert.throws(() => launch({ windowsVerbatimArguments: 'yes' }), error => error.code === 'WINDOWS_JOB_INPUT_INVALID');

    const measured = jobs.jobWrapperInvocation(CMD, ['/c', 'x'], { cwd: temp, windowsVerbatimArguments: true }, { assemblyCacheDirectory: null });
    assert.ok(measured.args.includes('-VerbatimArguments'), 'the measured wrapper line matches the launched one');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('the shipped wrapper sets verbatim mode from its switch before launching', () => {
  const code = fs.readFileSync(WRAPPER, 'utf8');
  assert.match(code, /\[Parameter\(Mandatory = \$false\)\]\[switch\]\$VerbatimArguments/);
  assert.match(code, /\[ToolsEnabledWindowsJobWrapper\]::VerbatimArguments = \[bool\]\$VerbatimArguments\s*\r?\n\s*\$result = \[ToolsEnabledWindowsJobWrapper\]::Run\(/);
});

function pwshAvailable() {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000
  });
  return !probe.error && probe.status === 0;
}

test("the wrapper's C# builds the line cmd.exe needs (PowerShell 7 compiles the shipped source)", t => {
  if (!pwshAvailable()) {
    t.skip('SKIP: PowerShell 7 (pwsh) is not on this machine');
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'job-verbatim-pwsh-'));
  try {
    const script = path.join(temp, 'command-line.ps1');
    fs.writeFileSync(script, [
      'param([string]$WrapperPath, [string]$Command, [string]$ArgumentsJson)',
      '$ErrorActionPreference = "Stop"',
      '$text = [System.IO.File]::ReadAllText($WrapperPath)',
      "$match = [regex]::Match($text, '(?s)\\$source = @''\\r?\\n(.*?)\\r?\\n''@')",
      'if (-not $match.Success) { throw "wrapper source not found" }',
      'Add-Type -TypeDefinition $match.Groups[1].Value',
      '$type = [ToolsEnabledWindowsJobWrapper]',
      '$builder = $type.GetMethod("CommandLine", [System.Reflection.BindingFlags]"NonPublic,Static")',
      '[string[]]$arguments = @(ConvertFrom-Json -InputObject $ArgumentsJson | ForEach-Object { [string]$_ })',
      '$type::VerbatimArguments = $false',
      '$plain = $builder.Invoke($null, @($Command, $arguments)).ToString()',
      '$type::VerbatimArguments = $true',
      '$verbatim = $builder.Invoke($null, @($Command, $arguments)).ToString()',
      '[Console]::Out.Write((@{ plain = $plain; verbatim = $verbatim } | ConvertTo-Json -Compress))'
    ].join('\n'));
    const argv = ['/d', '/s', '/c', `"${QUOTED_COMMAND}"`];
    const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script,
      '-WrapperPath', WRAPPER, '-Command', CMD, '-ArgumentsJson', JSON.stringify(argv)], {
      encoding: 'utf8', windowsHide: true, timeout: 300_000
    });
    assert.equal(run.status, 0, `pwsh failed: ${run.stderr}`);
    const lines = JSON.parse(run.stdout);
    assert.equal(lines.verbatim, `${CMD} /d /s /c ""\x43:\\Program Files\\Git\\bin\\git.exe" status"`,
      'verbatim: cmd.exe /s strips the outer pair and runs the command as written');
    assert.equal(lines.plain, `${CMD} /d /s /c "\\"\\"\x43:\\Program Files\\Git\\bin\\git.exe\\" status\\""`,
      'without verbatim mode the wrapper keeps its C runtime quoting for every other caller');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
