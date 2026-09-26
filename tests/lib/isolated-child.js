'use strict';

const { spawnSync } = require('node:child_process');

// The test owns its complete native descendant lifetime. spawnSync's timeout
// only kills its immediate child: a nested runner (or a detached fixture) can
// otherwise keep writing after the next test starts and its scratch is removed.
async function runIsolatedChild(command, args, options) {
  if (!['linux', 'win32'].includes(process.platform)) return spawnSync(command, args, options);
  const spawnOwned = process.platform === 'win32'
    ? require('../../src/lib/windows-job-control').spawnInJob
    : require('../../src/lib/linux-process-control').spawnLinuxOwned;
  const capture = Array.isArray(options.stdio);
  const stdout = [], stderr = [];
  let bytes = 0, error = null, pid = null;
  const child = spawnOwned(command, args, {
    cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    terminateDescendantsOnRootExit: true
  }, {
    // configure() supplies the isolated fixture environment. Tests deliberately
    // carry hostile environment canaries; production's credential scrub is a
    // subject of these tests and must not pre-empt their inputs here.
    safeLaunchEnvironment: environment => ({ ...environment })
  });
  const cancel = code => {
    error ||= Object.assign(new Error(`Isolated test process: ${code}`), { code });
    void child.terminateJob().catch(cause => { error = cause; });
  };
  const onTerm = () => cancel('EINTR');
  const collect = (chunks, stream) => chunk => {
    if (!capture) { stream.write(chunk); return; }
    const remaining = Math.max(0, (options.maxBuffer || 16 * 1024 * 1024) - bytes);
    chunks.push(chunk.subarray(0, remaining));
    bytes += chunk.length;
    if (chunk.length > remaining) cancel('ENOBUFS');
  };
  child.on('error', cause => { error ||= cause; });
  child.stdout.on('data', collect(stdout, process.stdout));
  child.stderr.on('data', collect(stderr, process.stderr));
  const inputWasFlowing = process.stdin.readableFlowing;
  process.stdin.pipe(child.stdin);
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onTerm);
  const timer = options.timeout == null ? null : setTimeout(() => cancel('ETIMEDOUT'), options.timeout);
  try {
    try { pid = (await child.jobReady).rootPid; } catch (cause) { error ||= cause; }
    const custody = await child.jobOutcome;
    const closed = await child.jobClosed;
    const cleanupConfirmed = closed.failure === null && custody.activeProcesses === 0;
    if (!cleanupConfirmed) error = Object.assign(new Error('Isolated test descendant cleanup is unproven'), {
      code: 'ISOLATED_CHILD_CLEANUP_UNPROVEN'
    });
    const output = chunks => options.encoding ? Buffer.concat(chunks).toString(options.encoding) : Buffer.concat(chunks);
    return { pid, status: custody.exitCode, signal: custody.exitSignal, error,
      stdout: capture ? output(stdout) : null, stderr: capture ? output(stderr) : null,
      custody, cleanupConfirmed };
  } finally {
    process.stdin.unpipe(child.stdin);
    if (!inputWasFlowing) process.stdin.pause();
    clearTimeout(timer);
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onTerm);
  }
}

module.exports = { runIsolatedChild };
