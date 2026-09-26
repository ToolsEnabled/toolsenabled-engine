'use strict';
// T58 hand test. Reproduces src/lib/owner-prompt-platform.js `invoke()` exactly:
// the same -STA powershell argument vector, the same windowsHide spawn and the
// same scrubbed environment, so the dialog runs under the real hidden-console
// condition that T58 describes. Takes NO OS input; the prompt is allowed to
// close itself on its own timeout. Reports the child's terminal state only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

// Same expression cleanEnvironment() applies after the scrub.
const LOADER_CARRIERS = /^(?:NODE_OPTIONS|NODE_PATH|PYTHON.*|LD_.*|DYLD_.*|GI_TYPELIB_PATH|GIO_EXTRA_MODULES|GTK_PATH|GTK_MODULES|PSModulePath)$/i;

const script = path.resolve(process.argv[2]);
const timeoutSeconds = Number(process.argv[3] || 25);

const payload = {
  mode: 'start',
  title: 'ToolsEnabled - private owner step',
  label: 'T58 Hand Test',
  message: 'T58 hand test: this window proves the start form is visible. No input is required; it closes itself.',
  key: 'custom.t58-hand-test',
  kind: 'credential',
  count: 1,
  timeoutSeconds,
  vaultFile: path.join(os.tmpdir(), 't58-hand-test-vault-does-not-exist.json'),
};

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't58-owner-form-'));
const file = path.join(directory, 'public-request.json');
fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });

// Mirror cleanEnvironment() in src/lib/owner-prompt-platform.js by CALLING the
// same scrub it calls, then applying the same loader-carrier filter. A
// hand-rolled delete list is the defect tools/check-spawn-env-scrub.js exists
// to catch: this harness spawns a real powershell.exe child, so an ambient
// provider or billing credential would ride into it.
const env = safeLaunchEnvironment(process.env, { context: 't58 native ui hand test' });
for (const key of Object.keys(env)) {
  if (LOADER_CARRIERS.test(key)) delete env[key];
}
env.TOOLSENABLED_VAULT_PATH = payload.vaultFile;

const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script,
  'native-ui', '-InputFile', file, '-ParentPid', String(process.pid)];

console.log(JSON.stringify({ stage: 'launching', script, command, timeoutSeconds, parentPid: process.pid }));

const started = Date.now();
const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
console.log(JSON.stringify({ stage: 'spawned', childPid: child.pid }));

let stdout = '';
let stderr = '';
child.stdout.on('data', d => { stdout += d; });
child.stderr.on('data', d => { stderr += d; });
child.on('close', (code, signal) => {
  console.log(JSON.stringify({
    stage: 'closed', code, signal, elapsedMs: Date.now() - started,
    stdout: stdout.trim().slice(0, 400), stderr: stderr.trim().slice(0, 400),
  }));
  fs.rmSync(directory, { recursive: true, force: true });
});
