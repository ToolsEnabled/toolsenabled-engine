'use strict';

// A lane cap is a process-tree guarantee. On Windows the production launch
// creates the real CLI suspended, assigns it to a KILL_ON_JOB_CLOSE Job Object,
// and only then resumes it. These tests pin the adapter to that retained
// kernel identity rather than taskkill's mutable PID/parent snapshot.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  killLaneTree,
  startAgentLane
} = require('../src/lib/mission-bridge/agent-lane-dispatch');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }

function fakeChild({ contained = true, failure = null } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = { end() {} };
  child.directKills = 0;
  child.terminations = 0;
  child.kill = () => { child.directKills += 1; return true; };
  if (contained) {
    child.terminateJob = async () => {
      child.terminations += 1;
      if (failure) throw failure;
      return Object.freeze({ type: 'terminated', exitCode: 124, activeProcesses: 0 });
    };
  }
  return child;
}

async function capUsesRetainedJob() {
  const child = fakeChild();
  const receipt = await killLaneTree(child, { platform: 'win32' });
  equal(receipt.activeProcesses, 0, 'the Job Object receipt must prove zero active processes');
  equal(child.terminations, 1, 'the retained Job Object is terminated exactly once');
  equal(child.directKills, 0, 'a contained child is never re-addressed through its mutable PID');
}

async function containmentFailureIsNotHiddenByPidFallback() {
  const failure = Object.assign(new Error('control receipt unavailable'), { code: 'WINDOWS_JOB_CLEANUP_UNPROVEN' });
  const child = fakeChild({ failure });
  assertions += 1;
  await assert.rejects(killLaneTree(child, { platform: 'win32' }), error => error === failure);
  equal(child.directKills, 0, 'a failed exact termination must not be replaced by an unsafe PID claim');
}

function rawFallbackRemainsBoundedToTheHeldProcess() {
  const child = fakeChild({ contained: false });
  equal(killLaneTree(child, { platform: 'win32' }), true,
    'an injected legacy child can still be stopped through its retained Node process handle');
  equal(child.directKills, 1, 'the fallback addresses only the process handle already held by the caller');
}

async function capTimerUsesContainedLaunchEndToEnd() {
  let capCallback = null;
  let capDelay = null;
  let launch = null;
  const child = fakeChild();
  const runLane = (laneOptions, laneDependencies) => {
    laneDependencies.spawnImpl('codex.exe', ['exec', '-'], { env: {}, cwd: 'C:\\fixture' });
    return Promise.resolve({ terminal: { status: 'finished', exitCode: 0 } });
  };

  const execution = startAgentLane({ agentId: 'luna' }, {
    runLane,
    presence: { heartbeat: () => ({ status: 'running' }) },
    spawnImpl() { throw new Error('the raw Windows spawn seam must stay behind the Job Object launcher'); },
    spawnInJobImpl(command, args, options, dependencies) {
      launch = { command, args, options, dependencies };
      return child;
    },
    platform: 'win32',
    capMs: 60_000,
    setTimeoutImpl(fn, ms) { capCallback = fn; capDelay = ms; return { unref() {} }; },
    clearTimeoutImpl() {}
  });

  equal(launch.command, 'codex.exe', 'the real lane command crosses the Job Object launch seam');
  equal(launch.dependencies.platform, 'win32', 'the containment seam is explicitly Windows-bound');
  equal(launch.options.shell, false, 'the contained lane never passes through a shell');
  equal(capDelay, 60_000, 'the cap timer retains the configured bound');
  ok(typeof capCallback === 'function', 'the cap timer arms at launch');
  equal(child.terminations, 0, 'nothing is terminated before the cap elapses');

  capCallback();
  equal(child.terminations, 1, 'the elapsed cap terminates the exact retained job');
  equal(child.directKills, 0, 'the integration path never performs a PID tree walk');
  equal(execution.timedOut, true, 'the elapsed cap is visible in the dispatch result');
  await execution.completion;
}

(async () => {
  await capUsesRetainedJob();
  await containmentFailureIsNotHiddenByPidFallback();
  rawFallbackRemainsBoundedToTheHeldProcess();
  await capTimerUsesContainedLaunchEndToEnd();
  process.stdout.write(`lane-cap-tree-kill: ${assertions} assertions over 4 cases\n`);
})().catch(error => {
  process.stderr.write(`${error && (error.stack || error.message || String(error))}\n`);
  process.exitCode = 1;
});
