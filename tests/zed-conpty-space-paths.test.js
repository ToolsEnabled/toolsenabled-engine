'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const profileFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-task-profile-'));
const tasksPath = path.join(profileFixture, '.zed', 'tasks.json');
fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
fs.writeFileSync(tasksPath, JSON.stringify([
  {
    label: 'Claude Code (native full access)',
    command: path.join(root, 'tools', 'zed-conpty-relay.exe'),
    args: ['--command', 'claude.exe'],
    use_new_terminal: false,
    hide: 'never'
  },
  {
    label: 'Codex (native full access)',
    command: path.join(root, 'tools', 'zed-conpty-relay.exe'),
    args: ['--command', 'codex.exe'],
    use_new_terminal: false,
    hide: 'never'
  }
], null, 2), 'utf8');
process.once('exit', () => {
  try { fs.rmSync(profileFixture, { recursive: true, force: true }); } catch { /* disposable fixture */ }
});

assertZedTasks();

if (process.platform !== 'win32') {
  console.log('Zed ConPTY runtime space/path regression skipped outside Windows; Zed task assertions passed.');
  process.exit(0);
}

const relaySource = path.join(root, 'tools', 'zed-conpty-relay', 'Program.cs');
const compilers = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
];
const compiler = compilers.find(candidate => fs.existsSync(candidate));
assert.ok(compiler, 'Windows C# compiler is required for the ConPTY space/path test');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zed conpty spaces-'));
const childCwd = path.join(fixtureRoot, 'child working directory with multiple spaces');
const logDirectory = path.join(fixtureRoot, 'raw log directory with multiple spaces');
const childDirectory = path.join(fixtureRoot, 'child executable directory with multiple spaces');
const relayExecutable = path.join(fixtureRoot, 'relay executable with multiple spaces.exe');
const childSource = path.join(fixtureRoot, 'child source with multiple spaces.cs');
const childExecutable = path.join(childDirectory, 'child executable with multiple spaces.exe');
const rawLog = path.join(logDirectory, 'relay raw log with multiple spaces.log');

fs.mkdirSync(childCwd, { recursive: true });
fs.mkdirSync(logDirectory, { recursive: true });
fs.mkdirSync(childDirectory, { recursive: true });

const expectedArgs = [
  '',
  'plain',
  'value with multiple spaces',
  'quoted "value" with spaces',
  'trailing backslashes ' + '\\\\',
  'Unicode 東京 🚀 café',
  'Files\\Git\\usr\\bin\\winpty.exe',
  'combined path with spaces\\and\\quotes "and"' + '\\'
];

const probeSourceText = [
  'using System;',
  'using System.Diagnostics;',
  'using System.Text;',
  '',
  'internal static class ArgProbe',
  '{',
  '    private static string B64(string value)',
  '    {',
  '        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? string.Empty));',
  '    }',
  '',
  '    public static void Main(string[] args)',
  '    {',
  '        Console.WriteLine("PROBE_PID=" + Process.GetCurrentProcess().Id);',
  '        Console.WriteLine("PROBE_CWD_B64=" + B64(Environment.CurrentDirectory));',
  '        Console.WriteLine("PROBE_ARG_COUNT=" + args.Length);',
  '        for (var index = 0; index < args.Length; index += 1)',
  '        {',
  '            Console.WriteLine("PROBE_ARG_" + index + "_B64=" + B64(args[index]));',
  '        }',
  '        Console.WriteLine("PROBE_READY");',
  '        Console.Out.Flush();',
  '',
  '        string line;',
  '        while ((line = Console.ReadLine()) != null)',
  '        {',
  '            if (line == "interactive input with spaces")',
  '            {',
  '                Console.WriteLine("PROBE_STDIN_OK");',
  '                Console.Out.Flush();',
  '                return;',
  '            }',
  '        }',
  '    }',
  '}',
  ''
].join('\r\n');

function assertZedTasks() {
  const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  assert.ok(Array.isArray(tasks), '.zed/tasks.json must contain a task array');

  const requiredLabels = [
    'Claude Code (native full access)',
    'Codex (native full access)'
  ];
  for (const label of requiredLabels) {
    const task = tasks.find(candidate => candidate && candidate.label === label);
    assert.ok(task, `missing project task ${label}`);
    assert.equal(typeof task.command, 'string', `${label} command must be one JSON string`);
    assert.ok(task.command.trim(), `${label} command path must not be empty`);
    assert.doesNotMatch(task.command, /(?:^|\s)(?:cmd|powershell)(?:\.exe)?\s/i,
      `${label} command must not be a shell-composed command`);
    assert.ok(Array.isArray(task.args), `${label} args must be an array`);
    assert.ok(task.args.every(argument => typeof argument === 'string'),
      `${label} args must contain strings`);
    assert.equal(task.use_new_terminal, false, `${label} must reuse the terminal`);
    assert.equal(task.hide, 'never', `${label} must keep terminal output visible`);

    const commandFlag = task.args.indexOf('--command');
    assert.ok(commandFlag >= 0, `${label} must pass the agent command as an argument`);
    assert.equal(typeof task.args[commandFlag + 1], 'string',
      `${label} agent command path must remain one JSON string`);
    assert.ok(task.args[commandFlag + 1].trim(),
      `${label} agent command path must not be empty`);
  }
}

function compile(output, input, target) {
  const result = spawnSync(compiler, [
    '/nologo',
    `/target:${target}`,
    `/out:${output}`,
    input
  ], {
    cwd: fixtureRoot,
    windowsHide: true,
    encoding: 'utf8'
  });
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  assert.ok(fs.existsSync(output), `compiler did not create ${output}`);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForOutput(readOutput, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readOutput().includes(marker)) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(marker)}; output tail: ${JSON.stringify(readOutput().slice(-1200))}`);
}

function terminateTree(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill(); } catch { /* the process may already be closing */ }
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore'
  });
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateTree(child);
      reject(new Error(`relay did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function decodeMarker(output, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`${escaped}=([A-Za-z0-9+/]*={0,2})`));
  assert.ok(match, `missing ${marker} in output`);
  return Buffer.from(match[1], 'base64').toString('utf8');
}

function markerNumber(output, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`${escaped}=(\\d+)`));
  assert.ok(match, `missing ${marker} in output`);
  return Number(match[1]);
}

function isProcessRunning(pid) {
  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], {
    windowsHide: true,
    encoding: 'utf8'
  });
  return result.status === 0 && new RegExp(`\\b${pid}\\b`).test(result.stdout || '');
}

function assertProbeOutput(output, label) {
  assert.match(output, /PROBE_READY/, `${label} did not contain the ready marker`);
  assert.match(output, /PROBE_STDIN_OK/, `${label} did not contain the stdin marker`);
  assert.equal(markerNumber(output, 'PROBE_ARG_COUNT'), expectedArgs.length,
    `${label} argument count changed`);
  assert.equal(decodeMarker(output, 'PROBE_CWD_B64'), childCwd,
    `${label} child cwd changed`);
  for (let index = 0; index < expectedArgs.length; index += 1) {
    assert.equal(decodeMarker(output, `PROBE_ARG_${index}_B64`), expectedArgs[index],
      `${label} argv[${index}] changed`);
  }
}

async function main() {
  fs.writeFileSync(childSource, probeSourceText, 'utf8');

  compile(relayExecutable, relaySource, 'winexe');
  compile(childExecutable, childSource, 'exe');
  assert.ok(childExecutable.includes(' '), 'child executable path must contain spaces');
  assert.ok(childCwd.includes(' '), 'child cwd must contain spaces');
  assert.ok(rawLog.includes(' '), 'raw log path must contain spaces');

  const relayArguments = [
    '--log', rawLog,
    '--cwd', childCwd,
    '--cols', '400',
    '--rows', '30',
    '--', childExecutable,
    ...expectedArgs
  ];
  const relay = spawn(relayExecutable, relayArguments, {
    cwd: fixtureRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const closePromise = waitForClose(relay, 7000);
  let preview = '';
  let stderr = '';
  relay.stdout.on('data', chunk => { preview += chunk.toString('utf8'); });
  relay.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  relay.stdin.on('error', () => { /* the relay may already be closing */ });

  try {
    await waitForOutput(() => preview, 'PROBE_READY', 7000);
    relay.stdin.write('interactive input with spaces\r');
    await waitForOutput(() => preview, 'PROBE_STDIN_OK', 7000);
    relay.stdin.end();

    let result;
    try {
      result = await closePromise;
    } catch (error) {
      const childPidMatch = preview.match(/PROBE_PID=(\d+)/);
      const childPid = childPidMatch ? Number(childPidMatch[1]) : null;
      error.message += `; stderr=${JSON.stringify(stderr)}; relayPid=${relay.pid}; relayExitCode=${relay.exitCode}; childPid=${childPid || 'unknown'}; childRunning=${childPid ? isProcessRunning(childPid) : 'unknown'}; previewTail=${JSON.stringify(preview.slice(-1200))}`;
      throw error;
    }
    assert.equal(result.signal, null, `relay ended from signal ${result.signal}`);
    assert.equal(result.code, 0, stderr);
    assert.equal(stderr, '', `hidden relay/child stderr was not empty: ${stderr}`);

    assert.ok(fs.existsSync(rawLog), 'raw log was not created at its spaced path');
    const raw = fs.readFileSync(rawLog, 'utf8');
    assertProbeOutput(preview, 'preview');
    assertProbeOutput(raw, 'raw log');

    const childPidMatch = preview.match(/PROBE_PID=(\d+)/);
    assert.ok(childPidMatch, 'preview did not expose the probe pid');
    assert.equal(isProcessRunning(Number(childPidMatch[1])), false,
      'child process remained after clean relay exit');

    console.log(`Zed ConPTY space/path regression passed: tasks=2 argv=${expectedArgs.length} ` +
      `cwd/log/child-spaces=true exit=0 hidden=true`);
  } finally {
    terminateTree(relay);
    try {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    } catch (error) {
      console.error(`could not remove space/path fixture: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
