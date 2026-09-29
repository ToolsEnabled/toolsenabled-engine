#!/usr/bin/env node
'use strict';

const lane = require('../src/lib/agent-lane');
const windowsJob = require('../src/lib/windows-job-control');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

function laneDependencies() {
  if (process.platform !== 'win32') return Object.freeze({});
  return Object.freeze({
    spawnImpl(command, args, options) {
      return windowsJob.spawnInJob(command, args, options, { safeLaunchEnvironment });
    }
  });
}

async function main() {
  const options = lane.parseArgs(process.argv.slice(2));
  // Wake/respawn starts this durable lane runner after the short-lived wake
  // command exits.  The runner therefore owns the Windows Job Object for the
  // actual CLI: the child is created suspended, contained before its first
  // instruction, and publishes the exact wrapper creation identity through
  // normal lane presence.  App-dispatched lanes already inject the same seam.
  const result = await lane.runLane(options, laneDependencies());
  const ok = result.terminal.status === 'finished'
    && result.terminal.exitCode === 0
    && result.heartbeatFault === null
    && result.progressFault === null;
  process.stdout.write(`${JSON.stringify({
    ok,
    agentId: options.agentId,
    runId: result.runId,
    taskId: result.taskId,
    status: result.terminal.status,
    exitCode: result.terminal.exitCode,
    verdict: result.terminal.lastVerdict,
    heartbeatFault: result.heartbeatFault,
    progressFault: result.progressFault
  })}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch(error => {
  const safe = lane.safeError(error);
  process.stderr.write(`${JSON.stringify({ ok: false, code: safe.code, message: safe.message })}\n`);
  process.exitCode = 1;
});
