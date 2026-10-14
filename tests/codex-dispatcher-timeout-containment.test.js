'use strict';

// A DISPATCH TIMEOUT MUST END THE TREE, NOT THE ROOT.
//
// `codex cloud exec` is not one process. The npm entry point runs under this
// process's own node and the CLI starts children of its own, so the thing the
// dispatcher started is a tree. The timeout path called `child.kill()`, which
// signals the DIRECT CHILD ONLY: the root died, the grandchild was orphaned,
// and it kept running -- the same failure shape hidden-spawn.js records from
// 2026-09-03, an orphaned Git grep walking the development tree for 55 minutes
// at 223% CPU and surviving an app restart.
//
// The fix is the containment this engine already owns: spawnHidden's
// `containProcessTree`, which is a Windows Job Object on win32 and a
// subreaper/pidfd scope on Linux, and its `terminateJob()`, which ends every
// member of the scope it created.
//
// WHAT THIS FILE REFUSES TO DO. No real Codex, no real long-lived tree, no
// signal to any real pid. spawnHidden is injected as a fake and the test
// asserts what the dispatcher ASKED FOR -- containment at spawn, terminateJob
// at timeout, and never a pid-directed signal. A test that proved this by
// orphaning a real grandchild would be the bug it is testing for.

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const dispatcher = require('../src/lib/cloud-agent/codex-dispatcher');

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

/* A stand-in for a contained child: the shape spawnInJob and spawnLinuxOwned
   both return. Note what it does NOT have -- a `kill` method. Neither real
   containment wrapper defines one (windows-job-control.js ContainedChild and
   linux-process-control.js LinuxOwnedChild are both bare EventEmitters), so a
   timeout path that still called child.kill() would throw into an empty catch
   and kill NOTHING AT ALL. That is asserted below. */
function fakeContainedChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242; // a guardian pid on Linux, never a root: not a kill target
  child.terminationRequests = 0;
  child.terminateJob = () => { child.terminationRequests += 1; return Promise.resolve({ type: 'terminated', activeProcesses: 0 }); };
  return child;
}

/* An UNCONTAINED child, for the platforms spawnHidden does not contain
   (anything that is not win32 or linux). There the direct kill is all there
   is, and it must still happen. */
function fakeDirectChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 5252;
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal === undefined ? 'default' : signal); return true; };
  return child;
}

function harness(child) {
  const spawns = [];
  const spawnHidden = (command, args, options) => { spawns.push({ command, args, options }); return child; };
  return { spawns, spawnHidden };
}

/* THE PROCESS-WIDE SIGNAL TRAP. Nothing in a timeout may signal a pid, and
   above all not a parent: RULES for this machine exist because an agent
   signalled an orphan's parent, which was systemd --user, and logged the whole
   desktop out. So process.kill is replaced for the duration and every call is
   recorded as a failure of the test, not of the machine. */
const signalled = [];
const realProcessKill = process.kill;
process.kill = (pid, signal) => { signalled.push({ pid, signal }); return true; };

(async () => {
  try {
    check(typeof dispatcher.createDefaultSpawn === 'function',
      'the default spawn is reachable with its spawnHidden injected, so its containment and its timeout can be proved without starting a real tree');

    // -----------------------------------------------------------------
    // THE DISPATCHER ASKS FOR CONTAINMENT AT SPAWN TIME. It has to be
    // requested before the first instruction runs; a tree cannot be adopted
    // after the fact, which is exactly why the orphan case is unrecoverable.
    // -----------------------------------------------------------------
    {
      const child = fakeContainedChild();
      const { spawns, spawnHidden } = harness(child);
      const spawn = dispatcher.createDefaultSpawn({ spawnHidden });
      const settled = spawn('node', ['codex.js', 'cloud', 'exec'], { env: { PATH: 'p' }, timeout: 50_000 });
      check(spawns.length === 1, 'the spawn went through spawnHidden, which is the packaged-QA no-provider fence');
      check(spawns[0].options.containProcessTree === true,
        'and it asked for process-tree containment -- a Job Object on Windows, a subreaper scope on Linux');
      check(spawns[0].options.windowsHide === true, 'still hidden, which spawnHidden refuses to have turned off anyway');
      check(spawns[0].options.shell === false, 'and still shell-less, so the prompt is never re-parsed');
      child.emit('close', 0);
      const outcome = await settled;
      check(outcome.status === 0 && !outcome.error, 'a normal close is unchanged by containment');
      check(child.terminationRequests === 0, 'and a child that finished on its own is not terminated afterwards');
    }

    // -----------------------------------------------------------------
    // THE DEFECT. On timeout, the WHOLE SCOPE is ended.
    // -----------------------------------------------------------------
    {
      const child = fakeContainedChild();
      const { spawnHidden } = harness(child);
      const spawn = dispatcher.createDefaultSpawn({ spawnHidden });
      const settled = spawn('node', ['codex.js', 'cloud', 'exec'], { env: { PATH: 'p' }, timeout: 1 });
      const outcome = await settled;
      check(child.terminationRequests === 1,
        'a timeout terminates the contained SCOPE, so a Codex grandchild cannot outlive the dispatch that started it');
      check(signalled.length === 0,
        'and it signals no pid at all -- not the root, not a group, and above all not a parent');
      check(outcome.error && outcome.error.code === 'ETIMEDOUT',
        'the outcome is still a timeout');
      check(!('status' in outcome) || outcome.status === null,
        'with no exit status, because nobody watched it finish');
    }

    // -----------------------------------------------------------------
    // A TIMEOUT IS STILL UNCERTAIN, and killing the tree does not change
    // that. The request may have reached the provider; we stopped listening.
    // Terminating our own processes says nothing about what the provider did.
    // -----------------------------------------------------------------
    {
      const child = fakeContainedChild();
      const { spawnHidden } = harness(child);
      const spawn = dispatcher.createDefaultSpawn({ spawnHidden });
      const dispatch = dispatcher.createCodexDispatcher({
        codexBinary: '\x43:/npm/node_modules/@openai/codex/bin/codex.js',
        accountHome: '\x43:/homes/a',
        environment: 'env-aaa',
        scrubEnvironment: () => ({ PATH: 'p' }),
        spawnImpl: spawn,
        timeoutMs: 1
      });
      let error = null;
      try { await dispatch({ task: { contract: 'a brief' }, index: 3, account: 'cloud-a' }); }
      catch (raised) { error = raised; }
      check(error && error.code === 'CLOUD_DISPATCH_UNCERTAIN',
        'a timed-out dispatch is still UNCERTAIN -- the tree is ours to kill, the provider\'s answer is not ours to assume');
      check(error && error.providerAnswered !== true,
        'and it is never marked as answered, so a resume reconciles it');
      check(child.terminationRequests === 1, 'and the tree was ended exactly once');
    }

    // -----------------------------------------------------------------
    // TERMINATION IS REQUESTED ONCE, not once per event. A second close or
    // error after the timeout must not re-enter the kill path.
    // -----------------------------------------------------------------
    {
      const child = fakeContainedChild();
      const { spawnHidden } = harness(child);
      const spawn = dispatcher.createDefaultSpawn({ spawnHidden });
      await spawn('node', ['codex.js'], { env: {}, timeout: 1 });
      child.emit('close', 1);
      child.emit('error', new Error('late'));
      await new Promise(resolve => setImmediate(resolve));
      check(child.terminationRequests === 1, 'late events after a timeout do not ask for a second termination');
    }

    // -----------------------------------------------------------------
    // A TERMINATION THAT FAILS DOES NOT CRASH THE DISPATCH. The wrapper
    // still owns KILL_ON_JOB_CLOSE; an unhandled rejection here would take
    // down a runner mid-wave.
    // -----------------------------------------------------------------
    {
      const child = fakeContainedChild();
      child.terminateJob = () => { child.terminationRequests += 1; return Promise.reject(new Error('WINDOWS_JOB_CLEANUP_UNPROVEN')); };
      let retained = 0;
      child.terminateRetainedWrapper = () => { retained += 1; return Promise.reject(new Error('still failing')); };
      const { spawnHidden } = harness(child);
      const spawn = dispatcher.createDefaultSpawn({ spawnHidden });
      const outcome = await spawn('node', ['codex.js'], { env: {}, timeout: 1 });
      await new Promise(resolve => setImmediate(resolve));
      check(outcome.error && outcome.error.code === 'ETIMEDOUT', 'the timeout still resolves');
      check(retained === 1,
        'and a failed job termination falls back to the retained wrapper handle, the way codex-process.js does');
      check(signalled.length === 0, 'and still nothing is signalled by pid');
    }

    // -----------------------------------------------------------------
    // THE UNCONTAINED PLATFORM. spawnHidden only contains win32 and linux;
    // anywhere else it returns a plain ChildProcess, and the direct kill is
    // all there is. It must still be used -- and it must be the child's own
    // kill(), never process.kill(pid), which is how a signal reaches
    // something this dispatcher did not start.
    // -----------------------------------------------------------------
    {
      const child = fakeDirectChild();
      const { spawnHidden } = harness(child);
      const spawn = dispatcher.createDefaultSpawn({ spawnHidden });
      const outcome = await spawn('node', ['codex.js'], { env: {}, timeout: 1 });
      check(child.kills.length === 1,
        'a child with no containment is still killed on timeout, through its own handle');
      check(signalled.length === 0, 'and not by pid');
      check(outcome.error && outcome.error.code === 'ETIMEDOUT', 'and the outcome is a timeout');
    }

    // -----------------------------------------------------------------
    // A SPAWN REFUSED BY THE FENCE IS NOT A TIMEOUT AND NOTHING IS KILLED.
    // spawnHidden throws synchronously when TOOLSENABLED_REFUSE_PROVIDER_SPAWN
    // is set; the dispatcher must resolve that as an error, not signal.
    // -----------------------------------------------------------------
    {
      const refusal = Object.assign(new Error('Refusing to start a provider process'), { code: 'HIDDEN_SPAWN_PROVIDER_REFUSED' });
      const spawn = dispatcher.createDefaultSpawn({ spawnHidden: () => { throw refusal; } });
      const outcome = await spawn('node', ['codex.js'], { env: {}, timeout: 5_000 });
      check(outcome.error === refusal, 'a refused spawn resolves with that refusal as the error');
      check(signalled.length === 0, 'and nothing was signalled, because nothing was started');
    }

    console.log(`codex-dispatcher timeout-containment tests passed (${checks} checks: containment requested at spawn so the tree is owned before the first instruction, a timeout ending the whole contained scope exactly once instead of only the direct child, a failed termination falling back to the retained wrapper without crashing the dispatch, the timeout still recorded as UNCERTAIN, an uncontained platform still killed through the child's own handle, and process.kill trapped for the whole file to prove no pid -- and no parent -- is ever signalled).`);
  } finally {
    process.kill = realProcessKill;
  }
})().catch((error) => {
  process.kill = realProcessKill;
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
