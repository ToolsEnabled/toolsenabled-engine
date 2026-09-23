#!/usr/bin/env node
'use strict';

// Which declared subsystems have NO scheduled task, and the exact elevated
// command to give each one (R100).
//
// THE BLOCKER THIS TOOL MAKES VISIBLE, verified 2026-07-29 on this machine:
//
//   Get-ScheduledTask | ? TaskName -like 'ToolsEnabled*'
//     ToolsEnabled Agent Digest           Running
//     ToolsEnabled Dashboard              Running
//     ToolsEnabled UAC Delegation Helper  Ready
//
// A declared task can be absent even when its registrar script is correct. The
// common reason is that every registrar throws unless it is running as
// Administrator (tools/fleet-supervisor-task.ps1:110-115 and its siblings), and
// nobody ever ran them elevated. A blocker that only exists as a thrown
// exception inside a script nobody runs is indistinguishable from no blocker
// at all, which is why this stayed invisible for a day.
//
// THIS TOOL CANNOT AND WILL NOT SELF-ELEVATE. It reports and it prints
// commands. Registration stays a deliberate human (or uac-delegation-helper)
// action, because silently acquiring Administrator to install an autostarting
// task is not a thing an agent should be able to do quietly.
//
// REGISTRATION IS A DURABILITY FACT, NOT A LIVENESS FACT. A process may be
// alive and unregistered; this tool reports only the task definition.

const fs = require('node:fs');
const path = require('node:path');

const managedProcesses = require('../src/lib/managed-processes.js');
const observer = require('../src/lib/supervision/observer.js');

const ROOT = managedProcesses.ROOT;

const DURABILITY = Object.freeze({
  REGISTERED: 'REGISTERED',
  NOT_REGISTERED: 'NOT_REGISTERED',
  UNKNOWN: 'UNKNOWN',                    // could not read the task list
  NOT_APPLICABLE: 'NOT_APPLICABLE'       // declares taskName: null on purpose
});

function pathExistsOrRefuse(file) {
  try {
    fs.statSync(file);
    return true;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    const detail = error && error.message ? `: ${error.message}` : '';
    throw new Error(`could not establish whether registrar script exists at ${file}${detail}`, { cause: error });
  }
}

/**
 * The exact elevated command that registers a subsystem's task.
 *
 * Verified against every registrar's param block rather than assumed: all six
 * accept -Register. dashboard-task.ps1 registers only `dashboard`.
 */
function registrarCommandFor(id, { registryFile, root = ROOT } = {}) {
  const entry = managedProcesses.getProcess(id, registryFile);

  if (!entry.taskName) {
    return {
      id,
      taskName: null,
      registrar: entry.registrar || null,
      available: false,
      command: null,
      note: entry.ownerLaunched
        ? `${id} is launched by the signed-in owner on purpose and declares no scheduled task`
        : `${id} declares no taskName, so there is nothing to register`
    };
  }
  if (!entry.registrar) {
    return {
      id,
      taskName: entry.taskName,
      registrar: null,
      available: false,
      command: null,
      note: `${id} declares taskName '${entry.taskName}' but no registrar script, so no command can be given`
    };
  }

  const registrarPath = path.resolve(root, entry.registrar);
  // existsSync collapses access and other I/O failures into `false`, which
  // would falsely label an unreadable path MISSING and provide a definite
  // answer about registration availability. Only a definite absence is false.
  const exists = pathExistsOrRefuse(registrarPath);
  const covers = managedProcesses.listProcesses(registryFile)
    .filter(other => other.registrar === entry.registrar && other.taskName)
    .map(other => other.id);

  return {
    id,
    taskName: entry.taskName,
    registrar: entry.registrar,
    registrarPath,
    available: exists,
    // Printed with forward-slash-free Windows quoting because it is meant to be
    // pasted into an elevated PowerShell verbatim.
    command: exists
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${registrarPath}" -Register`
      : null,
    note: exists
      ? (covers.length > 1
        ? `NOTE: ${entry.registrar} registers ${covers.join(' and ')} together -- one run covers all of them`
        : null)
      : `registrar script is MISSING at ${registrarPath}; nothing can be registered until it exists`
  };
}

/**
 * Report every declared subsystem's registration state.
 *
 * @param {object} [options]
 * @param {Map|undefined} [options.tasks] pre-collected task map (id -> {state,...}).
 *        `undefined` means the task list could not be read -> UNKNOWN for all.
 */
function listUnregistered({ tasks, registryFile, root = ROOT, collect = observer.collectScheduledTasks } = {}) {
  const entries = managedProcesses.listProcesses(registryFile);
  if (entries.length === 0) {
    throw new Error('managed-process inventory contained zero entries; refusing to report that every declared task is registered');
  }
  const names = entries.map(entry => entry.taskName).filter(Boolean);

  const table = tasks === undefined && typeof collect === 'function' ? collect(names) : tasks;
  const readable = table !== undefined;

  const rows = entries.map(entry => {
    if (!entry.taskName) {
      return {
        id: entry.id,
        displayName: entry.displayName,
        taskName: null,
        durability: DURABILITY.NOT_APPLICABLE,
        taskState: null,
        reason: entry.ownerLaunched
          ? 'owner-launched by design; a scheduled task would defeat the DPAPI boundary'
          : 'declares no taskName'
      };
    }
    if (!readable) {
      return {
        id: entry.id,
        displayName: entry.displayName,
        taskName: entry.taskName,
        durability: DURABILITY.UNKNOWN,
        taskState: null,
        reason: 'the scheduled-task list could not be read, so registration is unknown. This says NOTHING about whether the process is running.'
      };
    }
    const task = table.get(entry.taskName) || null;
    return {
      id: entry.id,
      displayName: entry.displayName,
      taskName: entry.taskName,
      durability: task ? DURABILITY.REGISTERED : DURABILITY.NOT_REGISTERED,
      taskState: task ? task.state : null,
      reason: task
        ? `scheduled task '${entry.taskName}' exists (state ${task.state})`
        : `scheduled task '${entry.taskName}' does NOT exist, so ${entry.id} cannot self-restart after a crash or reboot`
    };
  });

  const missing = rows.filter(row => row.durability === DURABILITY.NOT_REGISTERED);

  return {
    observedAtMs: Date.now(),
    taskListReadable: readable,
    rows,
    unregistered: missing.map(row => row.id),
    unknown: rows.filter(row => row.durability === DURABILITY.UNKNOWN).map(row => row.id),
    commands: missing.map(row => registrarCommandFor(row.id, { registryFile, root }))
  };
}

function isElevated() {
  // Best-effort and non-authoritative: a false here must never be reported as
  // "you are not admin", only as "this tool is not going to try".
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false });
    return String(out).trim().toLowerCase() === 'true';
  } catch {
    return null;                                        // honest unknown
  }
}

function render(report, elevated) {
  const lines = [];
  lines.push('Managed scheduled-task registration');
  lines.push('');
  if (!report.taskListReadable) {
    lines.push('  THE TASK LIST COULD NOT BE READ. Every row below is UNKNOWN.');
    lines.push('  This is not a claim that anything is unregistered, and not a claim that anything is down.');
    lines.push('');
  }
  const width = Math.max(...report.rows.map(row => row.id.length), 4);
  for (const row of report.rows) {
    const state = row.taskState ? ` (${row.taskState})` : '';
    lines.push(`  ${row.id.padEnd(width)}  ${row.durability}${state}`);
  }
  lines.push('');

  if (report.unregistered.length === 0) {
    lines.push(report.taskListReadable
      ? '  Every declared task is registered. Nothing to do.'
      : '  Nothing can be concluded until the task list is readable.');
  } else {
    lines.push(`  ${report.unregistered.length} declared task(s) are NOT registered, so those subsystems`);
    lines.push('  cannot self-restart after a crash or a reboot.');
    lines.push('');
    lines.push('  REGISTRATION REQUIRES AN ELEVATED PowerShell. Every registrar throws');
    lines.push('  without Administrator (S4U needs SeBatchLogonRight), and this tool does');
    lines.push('  not self-elevate. Run these from an Administrator prompt:');
    lines.push('');
    const seen = new Set();
    for (const command of report.commands) {
      if (!command.command) {
        lines.push(`    ${command.id}: NO COMMAND -- ${command.note}`);
        continue;
      }
      if (seen.has(command.command)) continue;         // shared registrar: print once
      seen.add(command.command);
      lines.push(`    # ${command.id}${command.note ? ` -- ${command.note}` : ''}`);
      lines.push(`    ${command.command}`);
    }
    lines.push('');
    lines.push('  Then confirm with:  Get-ScheduledTask | Where-Object TaskName -like "ToolsEnabled*"');
  }

  lines.push('');
  lines.push(`  This session is elevated: ${elevated === null ? 'UNKNOWN (could not check)' : String(elevated)}`);
  lines.push('  Registration state is a DURABILITY fact and nothing above is a liveness');
  lines.push('  claim. REGISTERED and dead, and NOT_REGISTERED and running, are both real');
  lines.push('  states this machine has been in. Liveness comes from the pid-lock / port /');
  lines.push('  heartbeat rungs, never from this table.');
  return lines.join('\n');
}

function run(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const check = argv.includes('--check');
  const report = listUnregistered();
  const elevated = json ? undefined : isElevated();

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(report, elevated)}\n`);
  }
  // --check makes this usable as a gate. Default stays 0: a report that fails
  // its caller by default gets wrapped in `|| true` and stops being read.
  if (check && report.unregistered.length > 0) return 1;
  if (check && !report.taskListReadable) return 2;
  return 0;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write([
      'Report which declared scheduled tasks are missing and how to register them.',
      '',
      '  --json     machine-readable report',
      '  --check    exit 1 if anything is unregistered, 2 if the task list is unreadable',
      '',
      'This tool NEVER registers anything and NEVER elevates. It prints the exact',
      'elevated command for a human to run.',
      ''
    ].join('\n'));
    return 0;
  }
  return run(argv);
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${String((error && error.stack) || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { DURABILITY, ROOT, listUnregistered, main, registrarCommandFor, run };
