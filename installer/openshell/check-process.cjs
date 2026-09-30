'use strict';
const path = require('node:path');
const prefix = process.env.TOOLSENABLED_INSTALL_PREFIX || path.join(process.env.HOME, '.local/toolsenabled');
if (!path.isAbsolute(prefix)) throw new Error('TOOLSENABLED_INSTALL_PREFIX must be absolute');
const runtime = path.join(prefix, 'runtime/engine/src/lib');
const { spawn } = require('node:child_process');
const { processStartTime, sameProcessAlive, terminateProcessTree } = require(path.join(runtime, 'proc/process-group'));
(async () => {
  const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const identity = { pid: child.pid, startTime: processStartTime(child.pid) };
  if (!identity.startTime) throw new Error('Could not identify the test worker');
  try {
    await terminateProcessTree(identity, { graceMs: 1000 });
    if (sameProcessAlive(identity.pid, identity.startTime)) throw new Error('Worker cleanup failed');
  } finally {
    if (sameProcessAlive(identity.pid, identity.startTime)) child.kill('SIGKILL');
  }
  console.log('OpenShell agent process handling passed');
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
