'use strict';

const { spawn } = require('node:child_process');

const MAX_OUTPUT_BYTES = 256 * 1024;
const [timeoutText, program, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutText);

if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || program !== 'node') {
  process.stderr.write('Invalid bounded execution request.\n');
  process.exit(125);
}

let totalBytes = 0;
let terminating = false;
let terminationCode = 124;
// SPAWN-ALLOWLIST: this script only ever runs inside the Linux
// agent-sandbox container (paths above are container-absolute: /workspace,
// /home/sandbox, /opt/toolsenabled). `windowsHide` is a Windows-only
// libuv flag with no effect on Linux, and there is no console subsystem
// to flash inside the container, so it is intentionally omitted here.
const child = spawn(process.execPath, args, {
  cwd: '/workspace',
  env: {
    HOME: '/home/sandbox',
    NODE_ENV: 'test',
    NODE_PATH: '/opt/toolsenabled/node_modules',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    SANDBOX_FIXTURE_URL: process.env.SANDBOX_FIXTURE_URL || ''
  },
  detached: true,
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe']
});

function killProcessGroup() {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function terminate(message, exitCode) {
  if (terminating) return;
  terminating = true;
  terminationCode = exitCode;
  if (message) process.stderr.write(message);
  killProcessGroup();
  setTimeout(() => process.exit(exitCode), 250);
}

function forward(stream, target) {
  stream.on('data', chunk => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_OUTPUT_BYTES) {
      terminate(`Sandbox output exceeded ${MAX_OUTPUT_BYTES} bytes.\n`, 124);
      return;
    }
    target.write(chunk);
  });
}

forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

const timer = setTimeout(() => {
  terminate(`Sandbox command exceeded ${timeoutMs} ms.\n`, 124);
}, timeoutMs);

child.on('error', error => {
  clearTimeout(timer);
  process.stderr.write(`Sandbox command failed to start: ${error.code || 'UNKNOWN'}.\n`);
  process.exit(126);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (terminating) process.exit(terminationCode);
  if (signal) {
    process.stderr.write(`Sandbox command ended by ${signal}.\n`);
    process.exit(128);
  }
  process.exit(Number.isInteger(code) ? code : 127);
});
