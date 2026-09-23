'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REGISTRAR = path.join(ROOT, 'tools', 'agent-sweep-task.ps1');

let assertions = 0;
function check(value, message) {
  assert.ok(value, message);
  assertions += 1;
}

function main() {
  if (process.platform !== 'win32') {
    process.stdout.write('agent sweep task: SKIPPED (Windows Task Scheduler is unavailable)\n');
    return;
  }
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', REGISTRAR, '-DryRun'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  check(result.status === 0, `agent sweep DryRun failed: ${output.trim()}`);
  check(/DRY RUN - no scheduled task was created, changed, started, or removed\./.test(output),
    'DryRun must not mutate Task Scheduler');
  check(/SWEEP_COMMAND=.*agent-sweep\.js.*--auto-wake checkpointed(?:\r?\n|$)/.test(output),
    'DryRun must print the exact Node sweep command; runtime resolves the current role-defined root');
  check(!/--from\b/.test(output),
    'registration must not freeze a role holder id that can change in the installed organisation');
  check(!/shadow-manager/i.test(output),
    'the durable sweep must not resurrect Shadow Manager as a privileged service identity');
  check(/TASK_ACTION=.*-WindowStyle Hidden.*-RunService/.test(output),
    'DryRun must print the hidden scheduled action');
  check(/TASK_PRINCIPAL=.*LogonType=Interactive RunLevel=Limited/.test(output),
    'DryRun must prove the interactive limited principal required for Codex children');
  check(/TASK_SETTINGS=Hidden=True MultipleInstances=IgnoreNew RestartCount=3 RestartInterval=PT1M ExecutionTimeLimit=PT0S/.test(output),
    'DryRun must prove hidden restart-safe task settings');
  check(/<AtLogOn,PT10M>/.test(output), 'DryRun must prove the ten-minute durable cadence');
  process.stdout.write(`agent sweep task: ${assertions} assertions passed\n`);
}

main();
