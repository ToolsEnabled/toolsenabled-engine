'use strict';

// R38: packaged-QA safety. tools/lane-run.js is a directly-invoked CLI
// ("Wake/respawn starts this durable lane runner after the short-lived wake
// command exits") that calls src/lib/agent-lane.js's runLane()/spawnChild()
// straight through -- never through mission-bridge/actions.js's dispatch(),
// which is the only place TOOLSENABLED_NO_PAID_PROVIDER was previously
// consulted. Neither that switch nor src/lib/proc/hidden-spawn.js's
// TOOLSENABLED_REFUSE_PROVIDER_SPAWN was ever read inside agent-lane.js
// itself, so a lane started this way was ungated on every platform: a real
// `codex` or `claude` resolved off PATH and started unconditionally.
//
// This test drives the REAL production entry point (lane.runLane, which is
// exactly what tools/lane-run.js calls) with a REAL PATH lookup: a fake
// `codex` executable sits first on PATH, and nothing about agent-lane.js's
// own code is mocked or stubbed to make the assertions pass -- only the task
// store, presence file, and onboarding packet builder are pointed at a
// throwaway fixture root, the same substitutions every other agent-lane.js
// test in this suite already makes to stay off real machine state.
//
// ASSERTED, in order:
//   1. With TOOLSENABLED_REFUSE_PROVIDER_SPAWN set, runLane() for a 'codex'
//      lane rejects with AGENT_LANE_PROVIDER_REFUSED and the fake codex's
//      log file is never created -- nothing was started.
//   2. Without the switch, the same lane (fresh run id) actually invokes the
//      fake codex resolved off PATH, and its log records the real argv.
//   3. The free local tier ('test-node') is unaffected by the switch, so a
//      gate that refused everything would be caught here too.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lane = require('../src/lib/agent-lane');
const tasks = require('../src/lib/providers/tasks');
const { createStateStore } = require('../src/lib/state-store');
const { PROVIDER_SPAWN_REFUSAL_VARIABLE } = require('../src/lib/proc/hidden-spawn');

let checks = 0;
function check(value, message) { assert.ok(value, message); checks += 1; }
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }

function optionsFor(root, agentId, command, childArgs, kind) {
  const worktree = path.join(root, `${agentId}-worktree`);
  fs.mkdirSync(worktree, { recursive: true });
  const brief = path.join(worktree, 'brief.md');
  fs.writeFileSync(brief, 'Run only the bounded provider-gate fixture.\n', 'utf8');
  return {
    agentId,
    kind,
    role: 'worker',
    tier: 'fixture',
    reportsTo: 'coordinator-sol',
    dispatcher: 'coordinator-sol',
    lane: 'provider-spawn-gate-fixture',
    territory: 'fixture-only',
    brief,
    worktree,
    consoleLog: path.join(root, 'logs', `${agentId}.log`),
    checkpoint: null,
    heartbeatMs: 60_000,
    leaseSeconds: 120,
    respawnCount: 0,
    command,
    childArgs
  };
}

async function runFixture(root, options, runId, extraDependencies = {}) {
  const state = createStateStore({
    file: path.join(root, `${options.agentId}-tasks.sqlite3`),
    ownerId: `provider-spawn-gate-${options.agentId}`,
    clock: () => Date.UTC(2026, 8, 8, 12, 0, 0)
  });
  const taskDependencies = { state, auditRecord: () => {} };
  try {
    return await lane.runLane(options, {
      stateFile: path.join(root, `${options.agentId}-presence.json`),
      mailboxDir: path.join(root, 'mailbox'),
      launchDir: path.join(root, 'launch'),
      taskDependencies,
      runId,
      buildOnboardingPacket: () => 'TEST PROVIDER-GATE ONBOARDING FIXTURE\n',
      ...extraDependencies
    });
  } finally {
    state.close();
  }
}

// A real, executable stand-in for the codex/claude CLI: it appends its own
// argv to a log file and exits 0. Written as a POSIX shell script rather than
// spawned via a Node shim, so PATH resolution finds and executes a REAL
// external program the same way it would find a real roaming npm install --
// nothing about the resolution or exec step is Node-specific or mocked.
function writeFakeProviderBinary(binDir, name, logFile) {
  const target = path.join(binDir, name);
  // `cat >/dev/null` drains the prompt the real lane writes to stdin before
  // exiting. Without it the parent's `child.stdin.end(prompt)` can race an
  // early exit and fail with EPIPE -- a real provider CLI reads its stdin
  // too, so this keeps the fixture's process contract honest rather than
  // papering over the race with a delay.
  fs.writeFileSync(target, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\nexit 0\n`, { mode: 0o755 });
  return target;
}

async function main() {
  if (process.platform === 'win32') {
    // The fake binaries above are POSIX shell scripts; a Windows-shaped
    // equivalent (.cmd) would be a second fixture to maintain in a suite that
    // otherwise runs everywhere. The gate itself (agent-lane.js's spawnChild)
    // is platform-independent code, already covered on this platform by
    // tests/agent-lane.test.js and tests/mission-bridge-agent-lane.test.js;
    // this file adds the PATH-resolution proof specifically, on the platform
    // where it can run without a second binary format.
    process.stdout.write('agent-lane provider spawn gate: skipped (POSIX-only fixture binaries), platform=win32\n');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lane-provider-gate-'));
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const codexLog = path.join(root, 'codex-invocations.log');
  writeFakeProviderBinary(binDir, 'codex', codexLog);

  const priorPath = process.env.PATH;
  const priorSwitch = process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE];
  process.env.PATH = `${binDir}${path.delimiter}${priorPath || ''}`;
  try {
    // ---- 1. Switch ON: the real fake codex is never reached. -------------
    process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE] = '1';
    let refused = null;
    try {
      await runFixture(
        root,
        optionsFor(root, 'codex-refused', 'codex', ['exec'], 'codex'),
        '77777777-7777-4777-8777-777777777777'
      );
    } catch (error) {
      refused = error;
    }
    check(refused !== null, 'runLane must reject the codex lane while the switch is set');
    equal(refused && refused.code, 'AGENT_LANE_PROVIDER_REFUSED', 'the rejection names itself AGENT_LANE_PROVIDER_REFUSED');
    check(!fs.existsSync(codexLog), 'the fake codex binary was never started -- its log file does not exist');

    // ---- 2. Switch OFF: the real fake codex, resolved off PATH, runs. ----
    delete process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE];
    const started = await runFixture(
      root,
      optionsFor(root, 'codex-control', 'codex', ['exec'], 'codex'),
      '88888888-8888-4888-8888-888888888888'
    );
    equal(started.terminal.status, 'finished', 'without the switch the lane really starts and finishes');
    equal(started.terminal.exitCode, 0, 'the fake codex binary exits 0 as scripted');
    check(fs.existsSync(codexLog), 'the fake codex binary was actually invoked -- its log file was created');
    const invocation = fs.readFileSync(codexLog, 'utf8');
    check(invocation.includes('exec'), 'the real argv (codex exec ... -) reached the resolved binary');
    check(invocation.trim().endsWith('-'), 'the lane appended its scripted trailing "-" to the real invocation');

    // ---- 3. Control: the free local tier is unaffected by the switch. ----
    process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE] = '1';
    const localFixture = path.join(root, 'local-fixture.js');
    fs.writeFileSync(localFixture, "console.log('## VERDICT');console.log('local fixture ran');\n", 'utf8');
    const priorTestMode = process.env.TOOLSENABLED_LANE_RUN_TEST;
    process.env.TOOLSENABLED_LANE_RUN_TEST = '1';
    try {
      const localRun = await runFixture(
        root,
        optionsFor(root, 'local-unaffected', process.execPath, [localFixture], 'test-node'),
        '99999999-9999-4999-8999-999999999999'
      );
      equal(localRun.terminal.status, 'finished', 'the switch does not refuse the provider-free local lane kind');
    } finally {
      if (priorTestMode === undefined) delete process.env.TOOLSENABLED_LANE_RUN_TEST;
      else process.env.TOOLSENABLED_LANE_RUN_TEST = priorTestMode;
    }

    process.stdout.write(`agent-lane provider spawn gate: ${checks} checks passed (refused with an empty fake-codex log, invoked it for real once the switch was off, local lane unaffected)\n`);
  } finally {
    process.env.PATH = priorPath;
    if (priorSwitch === undefined) delete process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE];
    else process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE] = priorSwitch;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${(error && error.stack) || error}\n`);
  process.exitCode = 1;
});
