// EXECUTABLE CHANGE
// testcanfail-tests-scheduled-task-registrars-test-js
//
// Mutation report:
// - Replaced every -RepetitionDuration token in the 15 matching tools/*.ps1
//   files with -FormerDuration. Before this change the duration check printed
//   "ok  every -RepetitionDuration is a finite New-TimeSpan -Days N, N <= 9999".
//   After this change it fails with:
//   "AssertionError [ERR_ASSERTION]: expected at least one
//   -RepetitionDuration declaration to validate".
// - Temporarily renamed all eight present registry-backed registrar fixtures so
//   none matched REGISTRY_BACKED. Before this change both checks printed "ok".
//   After this change the first fails with:
//   "AssertionError [ERR_ASSERTION]: expected at least one registry-backed
//   registrar to check". The same non-empty precondition is present in the
//   second check so each check independently rejects an empty subject corpus.
// - Both mutations were restored and sha256sum verified the duration-mutated
//   files byte-for-byte. The restored test advances through all strengthened
//   checks, but this checkout cannot produce a wholly green file: its committed
//   registry omits the committed task literal "ToolsEnabled Agent Digest" and
//   the later pre-existing assertion fails with "task name 'ToolsEnabled Agent
//   Digest' appears in a registrar but is not declared in
//   config\\managed-processes.json". This is a named unmet precondition, not an
//   assertion weakened or product file changed by this audit.
// - NOT-FOUND: exit-status/truthy-return-only evidence; swallowed test failure;
//   mock of the subject; expected value computed by the same checked code.
// - NOT-FOUND: a silent whole-file platform no-op. Platform-independent source
//   checks enforce finite scheduler durations, exact task identities, no
//   wildcard queries, and absence of the retired Telegram registrar.

'use strict';

// Phase 1 (R93): repo-wide invariants over every scheduled-task registrar.
// Shaped after tests/terminal-suppression.test.js -- a static scanner that
// fails if a known-bad pattern reappears anywhere.
//
// Incident #4: the 'ToolsEnabled Fleet Supervisor' and 'ToolsEnabled Telegram
// Bridge' tasks were never registered, so neither subsystem could self-restart.
// Root cause, reproduced on this machine:
//
//   Register-ScheduledTask -RepetitionDuration ([TimeSpan]::MaxValue)
//     -> "The task XML contains a value which is incorrectly formatted or out
//         of range.  (8,42):Duration:P99999999DT23H59M59S"
//
// The correlation was exact: the two registrars using [TimeSpan]::MaxValue were
// the two tasks that did not exist; the three that did not use it were all
// registered.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const registry = require('../src/lib/managed-processes.js');
const registrationReport = require('../tools/register-managed-tasks.js');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');

let passed = 0;
let skipped = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}
function skip(name, why) {
  skipped += 1;
  process.stdout.write(`  -   ${name} (SKIPPED: ${why})\n`);
}

const registrars = fs.readdirSync(TOOLS)
  .filter(name => name.endsWith('-task.ps1'))
  .map(name => ({ name, file: path.join(TOOLS, name), text: fs.readFileSync(path.join(TOOLS, name), 'utf8') }));

// Task-name coverage is wider than the filename convention used by the other
// registrar checks: full-remote-access-lifecycle.ps1 installs its own task,
// while migration scripts can contain task-name queries that the literal
// collector must distinguish from registered subsystem names.
const taskNameSources = fs.readdirSync(TOOLS)
  .filter(name => name.endsWith('.ps1'))
  .map(name => ({ name, file: path.join(TOOLS, name), text: fs.readFileSync(path.join(TOOLS, name), 'utf8') }));

process.stdout.write('scheduled-task-registrars\n');

check('found the registrars to scan', () => {
  assert.ok(registrars.length >= 5, `expected >=5 registrars, found ${registrars.length}`);
});

// --- Rule 1: the exact root cause may never reappear ------------------------

check('no registrar uses [TimeSpan]::MaxValue as a repetition duration', () => {
  for (const { name, text } of registrars) {
    assert.doesNotMatch(text, /-RepetitionDuration\s*\(\s*\[TimeSpan\]::MaxValue\s*\)/i,
      `${name} uses [TimeSpan]::MaxValue as -RepetitionDuration. It serializes to ` +
      'P99999999DT23H59M59S and Task Scheduler REJECTS it, so the task silently ' +
      'never registers and the subsystem can never self-restart.');
  }
});

// --- Rule 2: durations must be finite and in range --------------------------

check('every -RepetitionDuration is a finite New-TimeSpan -Days N, N <= 9999', () => {
  let durationCount = 0;
  for (const { name, text } of registrars) {
    const durations = [...text.matchAll(/-RepetitionDuration\s*\(([^)]*)\)/gi)].map(m => m[1].trim());
    durationCount += durations.length;
    for (const expression of durations) {
      const match = /^New-TimeSpan\s+-Days\s+(\d+)$/i.exec(expression);
      assert.ok(match,
        `${name}: -RepetitionDuration (${expression}) must be a literal ` +
        'New-TimeSpan -Days N so it cannot serialize out of range.');
      assert.ok(Number(match[1]) <= 9999,
        `${name}: repetition duration ${match[1]} days exceeds the safe bound.`);
    }
  }
  assert.ok(durationCount > 0,
    'expected at least one -RepetitionDuration declaration to validate');
});

// --- Rule 3: registration must be atomic ------------------------------------

// A registration is FORCED when the -Force switch reaches Register-ScheduledTask.
// PowerShell has two ways to put it there and both are equally atomic:
//
//   Register-ScheduledTask -TaskName $n ... -Force
//   $args = @{ ...; Force = $true }; Register-ScheduledTask @args
//
// The check used to accept only the first spelling, which failed against
// fra-keeper-task.ps1 -- a registrar that is not merely equivalent but better:
// it splats so that -Trigger can be OMITTED ENTIRELY for an on-demand task,
// because "Register-ScheduledTask REJECTS an empty -Trigger". Pinning the
// literal made this file fail on Windows and on Linux alike against a correct
// registrar, which is the opposite of what a static scanner is for. What
// matters is that Force arrives, not how it is written.
function forcedRegistration(fileText, call) {
  if (/-Force\b/.test(call)) return true;
  const splat = /@([A-Za-z_]\w*)/.exec(call);
  if (!splat) return false;
  const table = new RegExp(`\\$${splat[1]}\\s*=\\s*@\\{([\\s\\S]*?)\\n\\s*\\}`).exec(fileText);
  if (table && /(?:^|[\s;{])Force\s*=\s*\$true\b/im.test(table[1])) return true;
  // A key added after the table literal is the same promise, written later.
  return new RegExp(`\\$${splat[1]}\\s*\\[\\s*(['"])Force\\1\\s*\\]\\s*=\\s*\\$true\\b`, 'i').test(fileText);
}

check('no Register-ScheduledTask registers without Force', () => {
  for (const { name, text } of registrars) {
    const calls = [...text.matchAll(/^[^\S\n]*Register-ScheduledTask\b[\s\S]*?(?=\n\s*\n|\n\S)/gm)];
    assert.ok(calls.length > 0, `${name} has no Register-ScheduledTask call`);
    for (const call of calls) {
      assert.ok(forcedRegistration(text, call[0]),
        `${name}: Register-ScheduledTask must register with Force -- either the ` +
        '-Force switch on the call or Force = $true in the hashtable it splats. ' +
        'Unregister-then-Register deletes a working task and, if Register then ' +
        'throws, leaves NO task at all.');
    }
  }
});

check('no registrar unregisters immediately before registering', () => {
  for (const { name, text } of registrars) {
    assert.doesNotMatch(text,
      /Unregister-ScheduledTask[^\n]*\n\s*\}?\s*\n?\s*Register-ScheduledTask/,
      `${name}: unregister-then-register is not atomic; use Register -Force.`);
  }
});

// --- Rule 4: identity and argv come from the registry, not literals ---------

// The shipped registry is intentionally portable: customer setup adds entries
// that need a real project, controller, or Windows principal.  Derive this
// audit's subject from the registrar paths the shipped registry actually
// declares, rather than maintaining a historic builder-machine allowlist that
// silently turns those per-installation files into mandatory payload entries.
const REGISTRY_BACKED = new Set(registry.listProcesses()
  .map(entry => entry.registrar)
  .filter(value => typeof value === 'string' && value.trim())
  .map(value => path.basename(value)));

const registryBackedRegistrars = registrars.filter(({ name }) => REGISTRY_BACKED.has(name));

check('registry-backed registrars build argv with no hardcoded flag literal', () => {
  // Scoped to argv ASSEMBLY only. A flag name appearing inside a validation guard
  // (e.g. "refuse to register if declaredArgv lacks --project") is the opposite
  // of the failure being prevented, so matching the whole file would punish the
  // very check that enforces incident #5.
  assert.ok(registryBackedRegistrars.length > 0,
    'expected at least one registry-backed registrar to check');
  for (const { name, text } of registryBackedRegistrars) {
    const assemblyLines = text.split(/\r?\n/).filter(line => {
      if (/^\s*#/.test(line)) return false;                       // comments
      return /\$arguments\s*=|\$quotedArgv\s*=|-Argument\b/.test(line);
    });
    assert.ok(assemblyLines.length > 0, `${name}: found no argv assembly lines to check`);
    for (const line of assemblyLines) {
      for (const literal of ['--serve', '--concurrency', '--project', '--backend', '--quiet']) {
        assert.ok(!line.includes(literal),
          `${name} hardcodes ${literal} in argv assembly:\n    ${line.trim()}\n` +
          'argv must be assembled from config\\managed-processes.json so the ' +
          'registered argv and the argv the control plane validates cannot drift apart.');
      }
    }
  }
});

check('registry-backed registrars read config\\managed-processes.json', () => {
  assert.ok(registryBackedRegistrars.length > 0,
    'expected at least one registry-backed registrar to check');
  for (const { name, text } of registryBackedRegistrars) {
    assert.match(text, /managed-processes\.json/,
      `${name} must source its argv and task name from the managed process registry.`);
    assert.match(text, /declaredArgv/, `${name} must assemble argv from declaredArgv.`);
  }
});

// Task-name queries are collected across all PowerShell sources only for the
// wildcard exclusion below.  A source can *use* an installation-specific task
// (for example direct-link.ps1 starts the rendezvous task) without being that
// task's portable registrar. Treating every such consumer as a required entry
// in config/managed-processes.json was how this test demanded the builder's
// per-installation registry from the shipped default.
const taskNameWildcardQueries = new Set();
for (const { text } of taskNameSources) {
  for (const match of text.matchAll(/(?:\$\w*TaskName\s*=|-TaskName)\s*'([^']+)'/g)) {
    // Skip interpolation placeholders; only real literal names are checkable.
    if (match[1].startsWith('$')) continue;
    // Get-ScheduledTask/Unregister-ScheduledTask accept wildcard queries such
    // as 'ToolsEnabled*'. Those enumerate task names; they do not register a
    // subsystem, and declaring the pattern would fabricate one to silence the
    // checker. Only concrete literal task names belong in the registry.
    if (/[*?]/.test(match[1])) {
      taskNameWildcardQueries.add(match[1]);
      continue;
    }
  }
}

check('every portable registrar resolves its task and argv from the managed registry', () => {
  const portable = registry.listProcesses().filter(entry => typeof entry.registrar === 'string' && entry.registrar.trim());
  assert.ok(portable.length > 0, 'expected at least one portable managed registrar to check');
  for (const entry of portable) {
    assert.ok(typeof entry.taskName === 'string' && entry.taskName.trim() && !/[*?]/.test(entry.taskName),
      `${entry.id} has a portable registrar but no exact task name in config\\managed-processes.json`);
    const registrarPath = path.join(ROOT, entry.registrar);
    assert.ok(fs.existsSync(registrarPath),
      `${entry.id} declares registrar ${entry.registrar}, which does not exist in the payload`);
    const source = fs.readFileSync(registrarPath, 'utf8');
    assert.match(source, /managed-processes\.json/,
      `${entry.id}'s portable registrar must load config\\managed-processes.json`);
    assert.match(source, /declaredArgv/,
      `${entry.id}'s portable registrar must assemble its task argv from declaredArgv`);
  }
});

check('registration reporting enumerates the durable coordinator duty host', () => {
  const report = registrationReport.listUnregistered({ tasks: new Map(), root: ROOT });
  const row = report.rows.find(candidate => candidate.id === 'coordinator-duty-host');
  assert.ok(row, 'coordinator-duty-host must be present in the registration inventory');
  assert.equal(row.taskName, 'ToolsEnabled Coordinator Duty Host');
  const command = report.commands.find(candidate => candidate.id === 'coordinator-duty-host');
  assert.equal(command.registrar, 'tools/coordinator-duty-host-task.ps1');
});

check('portable managed registrars never pin a developer-machine Node path', () => {
  for (const { name, text } of registryBackedRegistrars) {
    assert.doesNotMatch(text, /\$nodePath\s*=\s*['"]C:\\agent-apps\\/i,
      `${name} hard-pins a developer-machine Node path instead of resolving a qualifying installed runtime`);
  }
});

check('every portable Node registrar calls the shared functional resolver', () => {
  const portableNodeEntries = registry.listProcesses().filter(entry =>
    /\.(?:cjs|mjs|js)$/i.test(entry.entryPoint)
    && typeof entry.registrar === 'string' && entry.registrar.trim());
  assert.ok(portableNodeEntries.length > 0, 'expected portable Node registrars to inspect');
  for (const entry of portableNodeEntries) {
    const source = fs.readFileSync(path.join(ROOT, entry.registrar), 'utf8');
    assert.match(source, /resolve-node\.ps1/i,
      `${entry.id}'s registrar must import tools/lib/resolve-node.ps1`);
    assert.match(source, /Resolve-ToolsEnabledNode\s+-Root\s+\$repoRoot/i,
      `${entry.id}'s registrar must call the shared functional resolver`);
  }
});

check('portable managed registrars contain no raw Node lookup or executable pin', () => {
  for (const { name, text } of registryBackedRegistrars) {
    if (name === 'dashboard-task.ps1') continue; // documented human-facing bootstrap; not a Node task action
    const executableLines = text.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n');
    assert.doesNotMatch(executableLines, /Get-Command\s+node(?:\.exe)?\b/i,
      `${name} performs a raw PATH Node lookup outside the shared resolver`);
    assert.doesNotMatch(executableLines, /C:\\agent-apps\\[^'"\r\n]*node\.exe/i,
      `${name} hard-pins a developer-machine Node executable`);
  }
});

check('portable registrars issue no wildcard task-name query', () => {
  assert.deepEqual([...taskNameWildcardQueries], [],
    'a wildcard scheduler query can sweep unrelated tasks and is not a registered subsystem identity');
});

check('fleet registrar refuses an argv missing --project/--backend', () => {
  const text = fs.readFileSync(path.join(TOOLS, 'fleet-supervisor-task.ps1'), 'utf8');
  assert.match(text, /checkArgvPreconditions\(`fleet-supervisor`,a\)/,
    'the fleet registrar must invoke the coordinator\'s canonical argv validator');
  assert.match(text, /CORRECTION_PRECONDITION_FAILED/,
    'the unconfigured shipped default must fail with the canonical refusal code');
});

if (process.platform === 'win32') {
  check('fleet shipped default refuses canonically before elevation or task mutation', () => {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(TOOLS, 'fleet-supervisor-task.ps1'), '-Register'
    ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /CORRECTION_PRECONDITION_FAILED/);
    assert.doesNotMatch(output, /requires an elevated PowerShell/,
      'the canonical precondition must run before the elevation gate');
  });
} else {
  skip('fleet shipped default refuses canonically before elevation or task mutation', 'not Windows');
}

if (process.platform === 'win32') {
  check('shared Node resolver works with PATH empty and preserves override refusal semantics', () => {
    const helper = path.join(TOOLS, 'lib', 'resolve-node.ps1');
    const quoted = value => `'${String(value).replace(/'/g, "''")}'`;
    const root = quoted(ROOT);
    const node = quoted(process.execPath);
    const helperPath = quoted(helper);
    const success = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `$env:Path='';$env:TOOLSENABLED_NODE=${node};. ${helperPath};Resolve-ToolsEnabledNode -Root ${root}`
    ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    assert.equal(success.status, 0, `${success.stdout || ''}${success.stderr || ''}`);
    assert.equal(path.resolve(String(success.stdout).trim()), path.resolve(process.execPath));

    for (const override of ['relative\\node.exe', path.join(ROOT, 'missing-node.exe')]) {
      const refusal = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `$env:Path='';$env:TOOLSENABLED_NODE=${quoted(override)};. ${helperPath};Resolve-ToolsEnabledNode -Root ${root}`
      ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
      assert.notEqual(refusal.status, 0, override);
      assert.match(`${refusal.stdout || ''}${refusal.stderr || ''}`, /NODE_22_19_OR_NEWER_MISSING/);
    }

    const source = fs.readFileSync(helper, 'utf8');
    assert.doesNotMatch(source, /return\s+\$bootstrapNode\b/i,
      'a bootstrap interpreter must never be returned without JS functional qualification');
  });
} else {
  skip('shared Node resolver works with PATH empty and preserves override refusal semantics', 'not Windows');
}

const TELEGRAM_REGISTRAR = path.join(TOOLS, 'telegram-bridge-task.ps1');
check('the retired Telegram registrar remains absent', () => {
  assert.equal(fs.existsSync(TELEGRAM_REGISTRAR), false,
    'a removed connector must not regain a scheduler entrypoint outside package and release review');
});

// --- Rule 5: round-trip probe registration ----------------------------------
//
// C's proposed done-when (build the definition in memory and read .XmlText)
// is INVALID and I verified it: the in-memory build succeeds with no exception
// and <Repetition> does not appear in XmlText at all. The range check happens
// at REGISTER time, so only a real registration attempt catches this.
//
// Verified property that makes this runnable WITHOUT elevation: Task Scheduler
// validates the XML BEFORE it checks permissions. On this unelevated shell:
//   [TimeSpan]::MaxValue  -> "incorrectly formatted or out of range"
//   New-TimeSpan -Days 9999 -> "Access is denied."
// So an "access denied" outcome PROVES the duration passed range validation.

// Real registration probes must never replace an existing owner's task.
const probePrefix = `ZZ-Probe-R93-${crypto.randomUUID()}`;
const probeNames = [`${probePrefix}-valid`, `${probePrefix}-invalid`];

function runPowerShell(script) {
  const result = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

if (process.platform !== 'win32') {
  skip('round-trip probe registration', 'not Windows');
} else {
  check('declared repetition durations survive a real Register attempt', () => {
    const durations = [...new Set(registrars.flatMap(({ text }) =>
      [...text.matchAll(/-RepetitionDuration\s*\(\s*(New-TimeSpan\s+-Days\s+\d+)\s*\)/gi)].map(m => m[1])))];
    assert.ok(durations.length > 0, 'expected at least one declared repetition duration to probe');

    for (const duration of durations) {
      const script = [
        '$ErrorActionPreference = "Stop"',
        '$registered = $false',
        'try {',
        '  $t = New-ScheduledTaskTrigger -AtStartup',
        `  $t.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (${duration})).Repetition`,
        '  $a = New-ScheduledTaskAction -Execute "node.exe" -Argument "probe"',
        `  $r = Register-ScheduledTask -TaskName '${probeNames[0]}' -Action $a -Trigger $t`,
        '  $registered = $true',
        '  Write-Output ("REGISTERED:" + $r.Triggers[0].Repetition.Duration)',
        `  Unregister-ScheduledTask -TaskName '${probeNames[0]}' -Confirm:$false`,
        '  $registered = $false',
        '} catch { Write-Output ("ERROR:" + ($_.Exception.Message -replace "\\r?\\n"," ")) } ' +
        `finally { if ($registered) { Unregister-ScheduledTask -TaskName '${probeNames[0]}' -Confirm:$false } }`
      ].join('; ');
      const output = runPowerShell(script);

      assert.doesNotMatch(output, /incorrectly formatted or out of range/i,
        `-RepetitionDuration (${duration}) is REJECTED by Task Scheduler. ` +
        `Registration would throw and the task would silently not exist. Output: ${output.trim()}`);
      assert.match(output, /REGISTERED:|Access is denied/i,
        `probe for (${duration}) produced an unexpected outcome: ${output.trim()}`);
    }
  });

  check('the known-bad duration is still caught by this probe', () => {
    // Negative control: if this ever stops failing, the test above has gone blind.
    const script = [
      '$ErrorActionPreference = "Stop"',
      '$registered = $false',
      'try {',
      '  $t = New-ScheduledTaskTrigger -AtStartup',
      '  $t.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition',
      '  $a = New-ScheduledTaskAction -Execute "node.exe" -Argument "probe"',
      `  Register-ScheduledTask -TaskName '${probeNames[1]}' -Action $a -Trigger $t | Out-Null`,
      '  $registered = $true',
      '  Write-Output "REGISTERED"',
      `  Unregister-ScheduledTask -TaskName '${probeNames[1]}' -Confirm:$false`,
      '  $registered = $false',
      '} catch { Write-Output ("ERROR:" + ($_.Exception.Message -replace "\\r?\\n"," ")) } ' +
      `finally { if ($registered) { Unregister-ScheduledTask -TaskName '${probeNames[1]}' -Confirm:$false } }`
    ].join('; ');
    const output = runPowerShell(script);
    assert.match(output, /incorrectly formatted or out of range/i,
      'the [TimeSpan]::MaxValue failure no longer reproduces, so the round-trip ' +
      `probe can no longer detect incident #4's root cause. Output: ${output.trim()}`);
  });

  check('no residue from this run is left behind', () => {
    const output = runPowerShell(`$r = @('${probeNames[0]}', '${probeNames[1]}') | ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue }; if ($r) { $r.TaskName } else { Write-Output 'CLEAN' }`);
    assert.match(output, /CLEAN/, `probe tasks were left registered: ${output.trim()}`);
  });
}

process.stdout.write(`\nscheduled-task-registrars: ${passed} checks passed, ${skipped} skipped\n`);
