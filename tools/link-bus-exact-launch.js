#!/usr/bin/env node
'use strict';

// Exact coordinator launcher used only by the fenced 8787 token-rotation
// restart.  The coordinator address comes from the customer's validated
// two-machine registry, and the interpreter is the exact Node runtime already
// executing this launcher.  It accepts no executable, script, address, port,
// state directory, environment, or shell input from the operator.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { directionalMachinePair } = require('../src/lib/service-registry');

const LINK_BUS_PORT = '8787';

function linkBusHost(serviceRegistryOptions = {}) {
  return directionalMachinePair(serviceRegistryOptions).coordinatorMachine.address;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizedAbsolute(value, label) {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    !path.isAbsolute(value)
  ) {
    fail('INVALID_ARGUMENT', `${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function childEnvironment(stateDir, { serviceRegistryOptions = {} } = {}) {
  const resolvedState = normalizedAbsolute(stateDir, 'stateDir');
  const windowsRoot = 'C:\\Windows';
  return Object.freeze({
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    ComSpec: path.join(windowsRoot, 'System32', 'cmd.exe'),
    PATH: [
      path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      path.join(windowsRoot, 'System32'),
      windowsRoot
    ].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    LINK_BUS_HOST: linkBusHost(serviceRegistryOptions),
    LINK_BUS_PORT,
    LINK_BUS_STATE_DIR: resolvedState
  });
}

function requireRegularFile(fsImpl, target, label) {
  let stat;
  try {
    stat = fsImpl.statSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fail('REQUIRED_FILE_MISSING', `${label} is missing`);
    }
    fail(
      'REQUIRED_FILE_INSPECTION_FAILED',
      `${label} could not be inspected`
    );
  }
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
    fail('REQUIRED_FILE_INVALID', `${label} is not a regular file`);
  }
}

function launchExact({
  repoRoot,
  fsImpl = fs,
  spawnImpl = spawn,
  nodePath = process.execPath,
  serviceRegistryOptions = {}
}) {
  const resolvedRoot = normalizedAbsolute(repoRoot, 'repoRoot');
  const resolvedNode = normalizedAbsolute(nodePath, 'nodePath');
  const serverPath = path.join(
    resolvedRoot,
    'sidecars',
    'link-bus',
    'server.js'
  );
  const stateDir = path.join(
    resolvedRoot,
    'sidecars',
    'link-bus',
    'state'
  );
  const stdoutPath = path.join(stateDir, 'link-bus.stdout.log');
  const stderrPath = path.join(stateDir, 'link-bus.stderr.log');

  requireRegularFile(fsImpl, resolvedNode, 'current Node executable');
  requireRegularFile(fsImpl, serverPath, 'fixed link-bus entry point');
  fsImpl.mkdirSync(stateDir, { recursive: true });

  let stdoutDescriptor;
  let stderrDescriptor;
  let child;
  try {
    stdoutDescriptor = fsImpl.openSync(stdoutPath, 'a');
    stderrDescriptor = fsImpl.openSync(stderrPath, 'a');
    child = spawnImpl(resolvedNode, [serverPath], {
      cwd: resolvedRoot,
      detached: true,
      windowsHide: true,
      shell: false,
      env: childEnvironment(stateDir, { serviceRegistryOptions }),
      stdio: ['ignore', stdoutDescriptor, stderrDescriptor]
    });
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
      fail('EXACT_LAUNCH_FAILED', 'fixed link-bus launch returned no PID');
    }
    child.unref();
  } catch (error) {
    if (error && error.code) throw error;
    fail('EXACT_LAUNCH_FAILED', 'fixed link-bus launch failed');
  } finally {
    if (stdoutDescriptor !== undefined) {
      try { fsImpl.closeSync(stdoutDescriptor); } catch {}
    }
    if (stderrDescriptor !== undefined) {
      try { fsImpl.closeSync(stderrDescriptor); } catch {}
    }
  }

  return Object.freeze({
    status: 'launched',
    pid: child.pid,
    host: linkBusHost(serviceRegistryOptions),
    port: Number(LINK_BUS_PORT)
  });
}

function parseCli(argv) {
  let execute = false;
  let repoRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--execute-exact-link-bus-launch') {
      if (execute) fail('INVALID_ARGUMENT', 'execution flag was repeated');
      execute = true;
      continue;
    }
    if (
      flag !== '--repo-root' ||
      repoRoot !== undefined ||
      index + 1 >= argv.length
    ) {
      fail('INVALID_ARGUMENT', 'exact launch arguments are invalid');
    }
    repoRoot = argv[index + 1];
    index += 1;
  }
  if (!execute || repoRoot === undefined) {
    fail(
      'EXECUTION_CONFIRMATION_REQUIRED',
      'explicit exact link-bus launch confirmation is required'
    );
  }
  return { repoRoot: normalizedAbsolute(repoRoot, 'repoRoot') };
}

function main() {
  try {
    const result = launchExact(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      code: error && error.code || 'EXACT_LAUNCH_FAILED'
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  get LINK_BUS_HOST() { return linkBusHost(); },
  LINK_BUS_PORT,
  get NODE_PATH() { return process.execPath; },
  childEnvironment,
  linkBusHost,
  launchExact,
  parseCli
};
