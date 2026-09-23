// EXECUTABLE CHANGE
// Audit report (testcanfail-tests-agent-engine-codex-process-test-js):
// - EMPTY ITERATION: strengthened both invocation-validation tables and the
//   top-level test table with explicit cardinality assertions. Mutation:
//   validateInvocation() temporarily accepted every value. RED: "false !==
//   true" at assertInvocationTypeError; process exit 1.
// - EXIT STATUS / TRUTHY-ONLY: NOT-FOUND. Rejections assert owned error codes,
//   messages, or types; process-liveness booleans are paired with fixture PIDs.
// - SWALLOWED FAILURE: NOT-FOUND. Catches occur only in teardown/product-like
//   fake-agent cleanup; no test assertion is made optional by them.
// - MOCK OF SUBJECT: NOT-FOUND. The fake is the external Codex stdio peer, not
//   codex-process.js, and assertions observe the real transport/session code.
// - SKIP / PRECONDITION: the two Windows resolver checks require win32 and were
//   named by the run as Windows-only; this Linux host cannot meet that
//   precondition. They do not skip the file or its six portable checks.
// - SAME-CODE EXPECTATION: NOT-FOUND. Expected methods, IDs, error metadata,
//   versions, and process state are independent literals/OS observations.
// - RESTORE: src/lib/agent-engine/codex-process.js SHA-256 was
//   e76072597a1fec3f06c82ee2623380d58c79ca8bb5f3892a6ab340964918d205 before
//   mutation and after restoration. GREEN: "Codex process spawn-path tests
//   passed (fake stdio server; no network, auth, cost, or Codex CLI)."

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createCodexProcessTransport,
  detectCodexVersion,
  startCodexSession
} = require('../../src/lib/agent-engine/codex-process');

// These two budgets exist to prove BOUNDEDNESS -- that a failing Codex rejects
// instead of hanging forever -- not to assert a latency figure. They were set
// to 3_000ms, which is BELOW the cost of the thing they measure: every
// session-starting call here spawns Windows processes twice (detectCodexVersion,
// then the app-server transport). Measured on this machine over two full runs,
// the per-call cost was 2_917/2_941/3_107/3_430/4_076ms and
// 2_387/3_181/3_321/3_789/4_102ms -- so the budget was under the real cost and
// the suite went red on whichever check happened to be slowest, against a
// product that was answering correctly. Raised to 30_000ms: ~7x the measured
// 4_102ms worst case, so load no longer forges a failure, while a genuine hang
// (the defect these bounds are here to catch) still fails the run.
const SESSION_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 30_000;
const FAKE_AGENT_MARKER = '--codex-process-test-fake-agent';
const COMMAND_VALIDATION_MESSAGE = 'Codex process command must be a bounded non-empty string';
const ARGS_VALIDATION_MESSAGE = 'Codex process args must be an array of strings';
const ENVIRONMENT_NAMES = [
  'APPDATA',
  'PATH',
  'CODEX_PROCESS_FAKE_CHILD_PID_PATH',
  'CODEX_PROCESS_FAKE_METHODS_PATH',
  'CODEX_PROCESS_FAKE_MODE',
  'CODEX_PROCESS_FAKE_PID_PATH',
  'CODEX_PROCESS_FAKE_VERSION'
];

function runFakeCodexAgent() {
  const fs = require('node:fs');
  const readline = require('node:readline');

  if (process.argv.includes('--version')) {
    process.stdout.write(`${process.env.CODEX_PROCESS_FAKE_VERSION || 'codex-cli 0.146.0'}\n`);
    return;
  }

  if (!process.argv.includes('--codex-process-test-fake-agent')) {
    process.stderr.write('Missing fake-agent argv marker.\n');
    process.exitCode = 64;
    return;
  }

  const methodsPath = process.env.CODEX_PROCESS_FAKE_METHODS_PATH;
  const pidPath = process.env.CODEX_PROCESS_FAKE_PID_PATH;
  const mode = process.env.CODEX_PROCESS_FAKE_MODE || 'happy';
  if (pidPath) fs.writeFileSync(pidPath, String(process.pid), 'utf8');

  /* The real codex.exe app-server spawns its own code-mode-host child, and
     nothing in this product waits for or kills it by name -- only whatever
     close() does to the app-server process itself can reach it. Mirror that
     shape when a test asks for it, so close() is exercised against a real
     two-generation process tree instead of a single process pretending to be
     one. Opt-in and unset for every other case in this file, so this changes
     nothing about the tests that came before it.

     `detached: true` is not incidental. MEASURED live 2026-09-03 (Win32
     IsProcessInJob): the real codex-code-mode-host.exe is NOT a member of any
     job, unlike a plain Node-to-Node spawn chain, which Node's own job-object
     bookkeeping reaps on its own regardless of this fix. Only a detached
     grandchild reproduces the job-escaped shape a bare child.kill() actually
     fails against, so only `detached: true` here can tell the fixed close()
     apart from the pre-fix one. */
  const childPidPath = process.env.CODEX_PROCESS_FAKE_CHILD_PID_PATH;
  if (childPidPath) {
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', [
      'require("node:fs").writeFileSync(process.env.CODEX_PROCESS_FAKE_CHILD_PID_PATH, String(process.pid));',
      'setInterval(() => {}, 60000);'
    ].join(' ')], { stdio: 'ignore', detached: true, env: process.env });
    grandchild.unref();
  }

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  function respond(request, payload) {
    process.stdout.write(`${JSON.stringify({ id: request.id, ...payload })}\n`);
  }

  input.on('line', line => {
    if (!line.trim()) return;
    const request = JSON.parse(line);
    if (methodsPath) fs.appendFileSync(methodsPath, `${request.method}\n`, 'utf8');

    if (request.method === 'initialize') {
      respond(request, {
        result: {
          userAgent: 'fake',
          codexHome: '/tmp',
          platformFamily: 'windows',
          platformOs: 'windows'
        }
      });
      return;
    }

    if (request.method === 'initialized') return;
    if (request.method === 'thread/start') {
      if (mode === 'not-initialized') {
        respond(request, { error: { code: -32600, message: 'Not initialized' } });
      } else if (mode === 'thread-start-missing') {
        respond(request, { error: { code: -32601, message: 'Method not found' } });
      } else if (mode === 'thread-start-unknown-variant') {
        // The answer a real Codex app-server gives for a request it does not have.
        respond(request, { error: { code: -32600, message: 'Invalid request: unknown variant `thread/start`, expected one of `initialize`, `thread/resume`' } });
      } else if (mode === 'thread-start-unreadable') {
        respond(request, { result: { thread: { identifier: 'renamed-in-a-later-codex' } } });
      } else {
        respond(request, { result: { thread: { id: 'fake-thread-1' } } });
      }
      return;
    }

    respond(request, { error: { code: -32601, message: 'Method not found' } });
  });
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function snapshotEnvironment(names) {
  return names.map(name => ({
    name,
    present: Object.hasOwn(process.env, name),
    value: process.env[name]
  }));
}

function restoreEnvironment(snapshot) {
  for (const entry of snapshot) {
    if (entry.present) process.env[entry.name] = entry.value;
    else delete process.env[entry.name];
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, label, timeoutMs = SESSION_TIMEOUT_MS) {
  let timeoutHandle;
  const timeout = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'CODEX_PROCESS_TEST_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutHandle));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    if (error && error.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs = EXIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(25);
  }
  return !isProcessAlive(pid);
}

function readPid(pidPath) {
  assert.equal(fs.existsSync(pidPath), true, `Fake agent did not write ${pidPath}`);
  const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
  assert.equal(Number.isInteger(pid) && pid > 0, true, `Invalid fake-agent pid in ${pidPath}`);
  return pid;
}

function readMethods(methodsPath) {
  if (!fs.existsSync(methodsPath)) return [];
  return fs.readFileSync(methodsPath, 'utf8').split(/\r?\n/).filter(Boolean);
}

function createFakeAgent(testTempDir, { name = 'fake-codex-agent', prependMarker = false } = {}) {
  const scriptPath = path.join(testTempDir, `${name}.js`);
  fs.writeFileSync(
    scriptPath,
    `'use strict';\n(${runFakeCodexAgent.toString()})();\n`,
    'utf8'
  );

  if (process.platform === 'win32') {
    const commandPath = path.join(testTempDir, `${name}.cmd`);
    const nodePath = process.execPath.replace(/"/g, '""');
    const escapedScriptPath = scriptPath.replace(/"/g, '""');
    const markerArgument = prependMarker ? ` ${FAKE_AGENT_MARKER}` : '';
    fs.writeFileSync(
      commandPath,
      `@echo off\r\n"${nodePath}" "${escapedScriptPath}"${markerArgument} %*\r\n`,
      'utf8'
    );
    return commandPath;
  }

  const commandPath = path.join(testTempDir, name);
  const markerArgument = prependMarker ? ` ${shellQuote(FAKE_AGENT_MARKER)}` : '';
  fs.writeFileSync(
    commandPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)}${markerArgument} "$@"\n`,
    'utf8'
  );
  fs.chmodSync(commandPath, 0o700);
  return commandPath;
}

function createFixture() {
  const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-codex-process-test-'));
  const environment = snapshotEnvironment(ENVIRONMENT_NAMES);
  const command = createFakeAgent(testTempDir);
  createFakeAgent(testTempDir, { name: 'codex', prependMarker: true });
  const sessions = new Set();
  const pidPaths = new Set();
  let caseIndex = 0;

  // A broken command passthrough must fail safely instead of finding an installed Codex CLI.
  process.env.APPDATA = testTempDir;
  process.env.PATH = testTempDir;

  function rememberSession(promise) {
    return promise.then(session => {
      sessions.add(session);
      return session;
    });
  }

  function nextCase({ mode = 'happy', version = 'codex-cli 0.146.0' } = {}) {
    caseIndex += 1;
    const methodsPath = path.join(testTempDir, `methods-${caseIndex}.txt`);
    const pidPath = path.join(testTempDir, `pid-${caseIndex}.txt`);
    process.env.CODEX_PROCESS_FAKE_METHODS_PATH = methodsPath;
    process.env.CODEX_PROCESS_FAKE_PID_PATH = pidPath;
    process.env.CODEX_PROCESS_FAKE_VERSION = version;
    process.env.CODEX_PROCESS_FAKE_MODE = mode;
    pidPaths.add(pidPath);

    return {
      methodsPath,
      pidPath,
      start() {
        return rememberSession(startCodexSession({
          cwd: process.cwd(),
          command,
          args: ['app-server', FAKE_AGENT_MARKER]
        }));
      },
      startDefault() {
        return rememberSession(startCodexSession({ cwd: process.cwd() }));
      }
    };
  }

  async function terminateFromPidPath(pidPath) {
    if (!fs.existsSync(pidPath)) return;
    const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
    if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return;
    try { process.kill(pid); } catch (error) {
      if (!error || error.code !== 'ESRCH') throw error;
    }
    await waitForProcessExit(pid);
  }

  async function cleanup() {
    for (const session of sessions) {
      try { session.close(); } catch { /* Test teardown must continue. */ }
    }
    for (const pidPath of pidPaths) {
      try { await terminateFromPidPath(pidPath); } catch { /* Test teardown must continue. */ }
    }
    restoreEnvironment(environment);
    try { fs.rmSync(testTempDir, { recursive: true, force: true }); } catch { /* Best effort. */ }
  }

  return { command, nextCase, terminateFromPidPath, cleanup };
}

function assertInvocationTypeError(error, expectedMessage) {
  assert.equal(error instanceof TypeError, true);
  assert.equal(error.message, expectedMessage);
  return true;
}

async function testInvocationValidation(fixture) {
  const invalidCommands = [
    ['non-string command', 42],
    ['empty-string command', ''],
    ['over-long command', 'x'.repeat(32_769)]
  ];
  const invalidArgs = [
    ['non-array args', 'app-server'],
    ['args containing a non-string', ['app-server', 42]]
  ];

  assert.ok(invalidCommands.length > 0, 'command-validation cases must not be empty');
  assert.ok(invalidArgs.length > 0, 'args-validation cases must not be empty');

  for (const [label, command] of invalidCommands) {
    assert.throws(
      () => createCodexProcessTransport({ command, args: ['app-server', FAKE_AGENT_MARKER] }),
      error => assertInvocationTypeError(error, COMMAND_VALIDATION_MESSAGE),
      `createCodexProcessTransport must reject a ${label}`
    );
    await assert.rejects(
      withTimeout(
        detectCodexVersion({ command, args: ['--version'] }),
        `detectCodexVersion ${label}`
      ),
      error => assertInvocationTypeError(error, COMMAND_VALIDATION_MESSAGE)
    );
    await assert.rejects(
      withTimeout(
        startCodexSession({
          cwd: process.cwd(),
          command,
          args: ['app-server', FAKE_AGENT_MARKER]
        }),
        `startCodexSession ${label}`
      ),
      error => assertInvocationTypeError(error, COMMAND_VALIDATION_MESSAGE)
    );
  }

  for (const [label, args] of invalidArgs) {
    assert.throws(
      () => createCodexProcessTransport({ command: fixture.command, args }),
      error => assertInvocationTypeError(error, ARGS_VALIDATION_MESSAGE),
      `createCodexProcessTransport must reject ${label}`
    );
    await assert.rejects(
      withTimeout(
        detectCodexVersion({ command: fixture.command, args }),
        `detectCodexVersion ${label}`
      ),
      error => assertInvocationTypeError(error, ARGS_VALIDATION_MESSAGE)
    );
    await assert.rejects(
      withTimeout(
        startCodexSession({ cwd: process.cwd(), command: fixture.command, args }),
        `startCodexSession ${label}`
      ),
      error => assertInvocationTypeError(error, ARGS_VALIDATION_MESSAGE)
    );
  }
}

async function testDefaultInvocation(fixture) {
  const testCase = fixture.nextCase();
  const session = await withTimeout(testCase.startDefault(), 'Default startCodexSession');
  assert.equal(session.threadId, 'fake-thread-1');
  assert.equal(session.nativeModeSettings, null);
  assert.equal(session.nativeModeUnavailableReason, 'CODEX_MODE_CONFIG_UNAVAILABLE');
  assert.deepEqual(
    readMethods(testCase.methodsPath),
    ['initialize', 'initialized', 'config/read', 'thread/start'],
    'startCodexSession defaults must still launch codex with app-server'
  );
  session.close();
}

async function testInitializePrecedesThreadStart(fixture) {
  const testCase = fixture.nextCase();
  const session = await withTimeout(testCase.start(), 'Happy-path startCodexSession');
  assert.equal(session.threadId, 'fake-thread-1');
  assert.deepEqual(
    readMethods(testCase.methodsPath),
    ['initialize', 'initialized', 'config/read', 'thread/start'],
    'startCodexSession must initialize the real process transport before starting a thread'
  );
  session.close();
}

async function testNotInitializedRejectsWithinBound(fixture) {
  const testCase = fixture.nextCase({ mode: 'not-initialized' });
  await assert.rejects(
    withTimeout(testCase.start(), 'Not initialized failure'),
    error => {
      assert.notEqual(error && error.code, 'CODEX_PROCESS_TEST_TIMEOUT');
      assert.equal(error instanceof Error, true);
      assert.match(error.message, /thread\/start failed with JSON-RPC code -32600/);
      return true;
    }
  );
  await fixture.terminateFromPidPath(testCase.pidPath);
}

async function testDetectedVersionReachesAdapter(fixture) {
  const incompatible = fixture.nextCase({ version: 'not-codex' });
  await assert.rejects(
    withTimeout(incompatible.start(), 'Incompatible-version startCodexSession'),
    error => {
      assert.equal(error && error.code, 'CODEX_PROTOCOL_VERSION_MISMATCH');
      return true;
    }
  );

  const compatible = fixture.nextCase({ version: 'codex-cli 0.154.0' });
  const session = await withTimeout(compatible.start(), 'Compatible-version startCodexSession');
  assert.equal(session.threadId, 'fake-thread-1');
  session.close();
}

/* A CODEX THIS SESSION CANNOT USE IS NAMED AS THE CAUSE, WITH THE COMMAND.
   No version is pinned (the version below is one this suite has never seen),
   so the only refusal is a real incompatibility at the start of a session:
   a request the session needs is missing, or its answer cannot be read. Both
   used to arrive as a generic protocol failure that blamed "the agent
   connection" and named nothing to do. */
async function testIncompatibleCodexIsNamedWithTheUpdateCommand(fixture) {
  for (const [mode, kind] of [['thread-start-unknown-variant', 'missing-request'], ['thread-start-missing', 'missing-request'], ['thread-start-unreadable', 'unreadable-answer']]) {
    const testCase = fixture.nextCase({ mode, version: 'codex-cli 0.199.0' });
    await assert.rejects(
      withTimeout(testCase.start(), `Incompatible Codex (${mode})`),
      error => {
        assert.equal(error && error.code, 'CODEX_CLI_INCOMPATIBLE', `${mode} must be named as an incompatible Codex, not ${error && error.code}`);
        assert.equal(error.codexVersion, '0.199.0');
        assert.equal(error.incompatibility, kind);
        assert.match(error.message, /Run "codex update"/);
        assert.ok(error.cause, 'the original protocol failure is kept as the cause');
        return true;
      }
    );
    assert.equal(await waitForProcessExit(readPid(testCase.pidPath)), true, `${mode} left the fake Codex running`);
  }
  /* A newer, unknown version that answers correctly still starts: nothing is
     refused for its number. */
  const newer = fixture.nextCase({ version: 'codex-cli 0.199.0' });
  const session = await withTimeout(newer.start(), 'Newer compatible Codex');
  assert.equal(session.threadId, 'fake-thread-1');
  session.close();
}

async function testNoOrphanChild(fixture) {
  const failing = fixture.nextCase({ mode: 'not-initialized' });
  await assert.rejects(
    withTimeout(failing.start(), 'Failure-path child cleanup'),
    /thread\/start failed with JSON-RPC code -32600/
  );
  const failedPid = readPid(failing.pidPath);
  assert.equal(
    await waitForProcessExit(failedPid),
    true,
    `Failure path left fake Codex child ${failedPid} alive`
  );

  const normal = fixture.nextCase();
  const session = await withTimeout(normal.start(), 'Normal-close child cleanup');
  const normalPid = readPid(normal.pidPath);
  assert.equal(isProcessAlive(normalPid), true, 'Fake Codex child exited before close() was exercised');
  session.close();
  assert.equal(
    await waitForProcessExit(normalPid),
    true,
    `close() left fake Codex child ${normalPid} alive`
  );
}

/* CLOSE() MUST REACH THE GRANDCHILD, NOT JUST THE APP-SERVER.
 *
 * MEASURED live 2026-09-03: codex.exe app-server spawns its own
 * codex-code-mode-host.exe, and a session close reached only the app-server.
 * Process census fell 24 -> 12 across twelve ended sessions; every survivor
 * was a former pair's other half, ~110 MB apiece, held by work that had
 * already finished. On Windows, ChildProcess#kill() is TerminateProcess on
 * the direct child alone -- it does not walk what that child spawned, so the
 * fake agent's own child here stands in for the code-mode host: something
 * the tracked process started and nothing here otherwise waits for or kills.
 *
 * testNoOrphanChild above proves the DIRECT child exits; it was already
 * green before this fix; a bare child.kill() was always enough to end the one
 * process it addresses. This proves the same for the one process further out,
 * which a bare child.kill() cannot reach on Windows -- see codex-process.js's
 * require of kill-tree.js.
 */
async function testCloseReapsGrandchild(fixture) {
  if (process.platform !== 'win32') {
    console.log('SKIP codex-process: close() reaps a grandchild (Windows-only process-tree defect)');
    return;
  }
  const testCase = fixture.nextCase();
  const childPidPath = path.join(
    os.tmpdir(),
    `toolsenabled-codex-process-grandchild-${process.pid}-${Date.now()}.txt`
  );
  process.env.CODEX_PROCESS_FAKE_CHILD_PID_PATH = childPidPath;

  // kill-tree.js spawns `taskkill` bare, resolved against THIS test runner's
  // own PATH (it inherits process.env like any spawn given no explicit env,
  // and that spawn happens inside close() below, in this process -- it is
  // not the env threaded through to the fake agent). The fixture replaces
  // process.env.PATH with the scratch dir on purpose, for the codex-resolution
  // tests elsewhere in this file, and that same replacement made taskkill
  // itself unresolvable here (ENOENT), which would silently defeat this test
  // for a reason that has nothing to do with the fix under test. Restore just
  // enough PATH for the duration of the close() call below.
  const originalPath = process.env.PATH;
  try {
    const session = await withTimeout(testCase.start(), 'Grandchild-cleanup startCodexSession');

    // The grandchild is spawned before the fake agent's readline interface
    // even exists, but starting a real process still takes real time; wait
    // for its own pid file rather than racing it.
    const deadline = Date.now() + SESSION_TIMEOUT_MS;
    while (!fs.existsSync(childPidPath) && Date.now() < deadline) await delay(25);
    const grandchildPid = readPid(childPidPath);
    assert.equal(isProcessAlive(grandchildPid), true, 'fake grandchild process did not start');

    process.env.PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    session.close();
    process.env.PATH = originalPath;

    assert.equal(
      await waitForProcessExit(grandchildPid),
      true,
      `close() left the fake app-server's own child ${grandchildPid} running -- `
        + 'a bare child.kill() reaches only the direct child on Windows, so the '
        + "app-server's own tool-execution child outlives the session that owned it"
    );
  } finally {
    process.env.PATH = originalPath;
    delete process.env.CODEX_PROCESS_FAKE_CHILD_PID_PATH;
    // Best-effort even when the assertion above already failed the test: a
    // red assertion must not also leak a real process out of this run.
    await fixture.terminateFromPidPath(childPidPath);
    try { fs.rmSync(childPidPath, { force: true }); } catch { /* best effort */ }
  }
}

/* A CODEX THAT IS NOT AN NPM INSTALL MUST STILL BE FOUND.
 *
 * The Windows branch of resolveInvocation() used to answer the bare string
 * `codex.cmd` whenever the npm layout was absent -- and `.cmd` is the shim npm
 * itself writes, so the fallback for "not installed by npm" named the one
 * filename only npm creates. A winget, scoop or portable install lays down
 * codex.exe and no .cmd at all, so cmd.exe answered 9009, detectCodexVersion()
 * classified 9009 as missing, and the product told a person with a working
 * Codex to go install Codex. Measured on the owner's machine 2026-08-23.
 *
 * `.bat` stands in for `.exe` here on purpose: it is a real PATHEXT entry that
 * the old code could not resolve for exactly the same reason, and unlike a
 * native executable a test can create one. What is under test is that the
 * WHOLE extension list is searched, not that one particular extension is. */
async function testNonNpmInstallOnPathResolves() {
  if (process.platform !== 'win32') {
    console.log('SKIP codex-process: non-npm PATH install resolves (Windows-only branch)');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-codex-pathext-'));
  const commandDir = path.join(root, 'Links');
  const appData = path.join(root, 'AppData');
  fs.mkdirSync(commandDir);
  fs.mkdirSync(appData);
  // No %APPDATA%\npm\node_modules\@openai\codex here: this is the machine shape
  // the fallback exists for, and the branch above it must not fire.
  fs.writeFileSync(
    path.join(commandDir, 'codex.bat'),
    '@echo off\r\necho codex-cli 0.146.0\r\n',
    'utf8'
  );
  const env = {
    PATH: commandDir,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    APPDATA: appData,
    SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    ComSpec: process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  };
  try {
    const version = await withTimeout(
      detectCodexVersion({ command: 'codex', env }),
      'Non-npm PATH install detectCodexVersion'
    );
    assert.equal(version, 'codex-cli 0.146.0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* THE REFUSAL A GENUINELY EMPTY MACHINE GETS IS UNCHANGED. The search widening
 * above must not turn "no Codex anywhere" into some other error: that refusal
 * carries the install instructions, and the code is what the shell's copy table
 * translates. */
async function testAbsentCodexStillReportsNotFound() {
  if (process.platform !== 'win32') {
    console.log('SKIP codex-process: absent Codex still reports CODEX_CLI_NOT_FOUND (Windows-only branch)');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-codex-absent-'));
  const env = {
    PATH: root,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    APPDATA: root,
    SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    ComSpec: process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  };
  try {
    await assert.rejects(
      withTimeout(detectCodexVersion({ command: 'codex', env }), 'Absent-Codex detectCodexVersion'),
      error => {
        assert.equal(error && error.code, 'CODEX_CLI_NOT_FOUND');
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* ABSENT IS AN ANSWER; UNREADABLE IS NOT. The PATH resolver used to swallow
 * every stat failure and eventually return null. detectCodexVersion() then ran
 * the missing-command fallback and could report CODEX_CLI_NOT_FOUND even
 * though access failure meant it had never established that the candidate was
 * absent. Exercise that distinction without requiring a Windows host by
 * entering only the resolver's platform branch and failing before spawn. */
async function testUnreadablePathCandidateIsUnknownNotAbsent() {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalStatSync = fs.statSync;
  const accessError = Object.assign(new Error('PATH candidate cannot be read'), { code: 'EACCES' });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  fs.statSync = () => { throw accessError; };
  try {
    await assert.rejects(
      detectCodexVersion({
        command: 'codex',
        env: { APPDATA: path.join(os.tmpdir(), 'no-npm-layout'), PATH: os.tmpdir(), PATHEXT: '.EXE' }
      }),
      error => {
        assert.equal(error, accessError, 'an unreadable candidate must remain unknown, not become absent');
        assert.notEqual(error.code, 'CODEX_CLI_NOT_FOUND');
        return true;
      }
    );
  } finally {
    fs.statSync = originalStatSync;
    Object.defineProperty(process, 'platform', platform);
  }
}

async function main() {
  const fixture = createFixture();
  const tests = [
    ['all public spawn entry points validate command and args', testInvocationValidation],
    ['valid command and args defaults still work', testDefaultInvocation],
    ['initialize precedes thread/start', testInitializePrecedesThreadStart],
    ['Not initialized rejects within a bounded time', testNotInitializedRejectsWithinBound],
    ['detected version reaches the adapter', testDetectedVersionReachesAdapter],
    ['an incompatible Codex is named, with the update command', testIncompatibleCodexIsNamedWithTheUpdateCommand],
    ['failure and close leave no orphan child', testNoOrphanChild],
    ['close reaps a child the app-server itself spawned', testCloseReapsGrandchild],
    ['a non-npm Codex on PATH resolves', testNonNpmInstallOnPathResolves],
    ['an absent Codex still reports CODEX_CLI_NOT_FOUND', testAbsentCodexStillReportsNotFound],
    ['an unreadable PATH candidate is unknown, not absent', testUnreadablePathCandidateIsUnknownNotAbsent]
  ];

  assert.ok(tests.length > 0, 'codex-process test table must not be empty');

  try {
    for (const [name, test] of tests) {
      await test(fixture);
      console.log(`PASS codex-process: ${name}`);
    }
    console.log('Codex process spawn-path tests passed (fake stdio server; no network, auth, cost, or Codex CLI).');
  } finally {
    await fixture.cleanup();
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
