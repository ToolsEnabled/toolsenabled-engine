'use strict';

// THE TWO THINGS THE 2026-09-04T04:11:56Z CRASH PAIR DID NOT HAVE.
//
// Two MCP servers of one circle (pids 20204 and 11012, both started 03:56:20Z)
// aborted in the same second and left two minidumps and nothing else. The
// CONTEXT-based stack walk of both dumps
// (REPORT-crash-20260903/evidence/D/walk-*.txt) is identical:
//
//   KERNELBASE!DebugBreak                                    <- EXCEPTION_BREAKPOINT
//   electron.exe!uv_fatal_error                              <- rsi=6, rdi="PostQueuedCompletionStatus"
//   electron.exe!node::NodePlatform::PostDelayedTaskOnWorkerThreadImpl
//   electron.exe!v8::internal::MemoryPool::PostDelayedReleaseTask
//   electron.exe!v8::internal::MemoryPool::ReleasePooledChunksTask::RunInternal
//   electron.exe!node::PlatformWorkerThread
//
// with the MAIN thread already inside node::WorkerThreadsTaskRunner::Shutdown()
// under electron::JavascriptEnvironment::~JavascriptEnvironment(). A clean exit
// racing V8's global memory pool -- not an out-of-memory (committed PRIVATE
// memory in both dumps: 10.9 MB).
//
// So this file pins two things:
//   1. the generated .mcp.json starts run-as-node servers with the V8 flag that
//      removes MemoryPool::ReleasePooledChunksTask, and ONLY when the recorded
//      runtime has been probed to accept it;
//   2. the server writes a last-words file that says whether the JS side
//      finished, so the next dump can be read in seconds instead of hours.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const machineRecord = require('../src/lib/setup/machine-record');
const mcpServer = require('../src/mcp-server');

// SPELT OUT HERE, not imported, so a failure of these tests is a statement about
// the DOCUMENT this generator writes and not about a constant it exports. The
// export is pinned once, separately, below.
const GUARD_FLAGS = ['--no-memory-pool'];

// The probe answer is cached per runtime path. Tests that reuse a path clear it;
// guarded so the red run of a build without the helper still fails on behaviour.
function resetProbeCache() {
  if (typeof machineRecord.resetRuntimeGuardProbeForTests === 'function') {
    machineRecord.resetRuntimeGuardProbeForTests();
  }
}

function scratchDirectory(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-${name}-`));
  return dir;
}

function recordFor(installRoot, nodePath) {
  return machineRecord.buildMachineRecord({
    tier: 'unrestricted',
    installRoot,
    servicesRoot: installRoot,
    nodePath,
    workspaceRoots: [installRoot],
    machineId: 'test-machine',
    machineLabel: 'Test machine'
  });
}

// generateMcpConfig() checks that each server script exists before emitting it.
function installTreeWithServers(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const leaf of ['mcp-server.js', 'playwright-gateway.js']) {
    fs.writeFileSync(path.join(dir, 'src', leaf), '// test stub\n');
  }
  return dir;
}

test('a run-as-node MCP server is started with the V8 flag that removes the task both 04:11:56Z dumps aborted inside', () => {
  resetProbeCache();
  const install = installTreeWithServers(scratchDirectory('guard-accepted'));
  const runtime = path.join(install, 'ToolsEnabled.exe');
  fs.writeFileSync(runtime, 'not really an executable\n');

  const probes = [];
  const { document } = machineRecord.generateMcpConfig(recordFor(install, runtime), {
    runtimeProbe: (command, args) => {
      probes.push({ command, args });
      return { status: 0, error: null };
    }
  });

  // The runtime was asked, once, whether it accepts the flag -- and asked with
  // the flag itself, not with a name somebody could rename out from under it.
  assert.equal(probes.length, 1, 'the runtime must be probed exactly once per document');
  assert.equal(probes[0].command, runtime);
  assert.deepEqual(probes[0].args.slice(0, GUARD_FLAGS.length), GUARD_FLAGS);

  const names = Object.keys(document.mcpServers);
  assert.ok(names.includes('toolsenabled'), 'the write server must be generated');
  assert.ok(names.includes('toolsenabled-readonly'), 'the read-only server must be generated');
  assert.ok(names.includes('playwright'), 'the browser server must be generated');

  for (const [name, entry] of Object.entries(document.mcpServers)) {
    assert.deepEqual(
      entry.args.slice(0, GUARD_FLAGS.length),
      GUARD_FLAGS,
      `${name} must carry the guard flags before its script`
    );
    // THE FLAG MUST NOT DISPLACE AN ARGUMENT THE SERVER READS. Under
    // ELECTRON_RUN_AS_NODE the runtime consumes its own flags, so the script is
    // still process.argv[1] and playwright-gateway.js still finds its pinned
    // package spec at process.argv[2]; the generated array must keep that order.
    const rest = entry.args.slice(GUARD_FLAGS.length);
    assert.ok(path.isAbsolute(rest[0]), `${name}: the script must follow the flags`);
    assert.ok(rest[0].endsWith('.js'), `${name}: the script must follow the flags`);
    if (name === 'playwright') {
      assert.match(rest[1], /^@playwright\/mcp@\d+\.\d+\.\d+$/,
        'the pinned package spec must still be the argument after the script');
    } else {
      assert.equal(rest.length, 1, `${name}: nothing may follow the script`);
    }
  }
});

test('a runtime that refuses the flag gets no flag, because an unrecognised V8 flag kills the process at spawn', () => {
  resetProbeCache();
  const install = installTreeWithServers(scratchDirectory('guard-refused'));
  const runtime = path.join(install, 'ToolsEnabled.exe');
  fs.writeFileSync(runtime, 'not really an executable\n');

  // MEASURED 2026-09-04: `node.exe` v22.14.0 answers `--no-memory-pool` with
  // "bad option: --no-memory-pool" and exit 9. A generator that wrote the flag
  // anyway would take the whole tool surface down rather than harden it.
  for (const refusal of [
    { status: 9, error: null },
    { status: null, error: new Error('spawn ENOENT') },
    { status: null, error: null },
    undefined
  ]) {
    resetProbeCache();
    const { document } = machineRecord.generateMcpConfig(recordFor(install, runtime), {
      runtimeProbe: () => refusal
    });
    for (const [name, entry] of Object.entries(document.mcpServers)) {
      assert.ok(path.isAbsolute(entry.args[0]),
        `${name}: a refused probe must produce the argument list this generator has always produced`);
      assert.ok(!entry.args.some(argument => argument.startsWith('--')),
        `${name}: no flag may survive a probe that did not cleanly succeed`);
    }
  }
});

test('a plain node runtime is never probed and never flagged', () => {
  resetProbeCache();
  const install = installTreeWithServers(scratchDirectory('guard-node'));
  const runtime = path.join(install, 'node.exe');
  fs.writeFileSync(runtime, 'not really an executable\n');

  let probed = 0;
  const { document } = machineRecord.generateMcpConfig(recordFor(install, runtime), {
    runtimeProbe: () => { probed += 1; return { status: 0, error: null }; }
  });
  assert.equal(probed, 0, 'node does not run the Electron teardown and refuses the flag; do not spawn it to find out');
  for (const entry of Object.values(document.mcpServers)) {
    assert.ok(path.isAbsolute(entry.args[0]));
  }
  assert.equal(machineRecord.runtimeGuardFlags(runtime).length, 0);
});

test('the guard flag list the generator exports is the one the dumps name', () => {
  assert.deepEqual([...machineRecord.RUNTIME_GUARD_FLAGS], GUARD_FLAGS);
});

test('the server leaves a last-words file that says it was still running', () => {
  const dir = scratchDirectory('last-words-running');
  const file = path.join(dir, 'mcp-server-probe.json');
  try {
    assert.equal(mcpServer.openLastWords({ stateFile: file }), file);
    const started = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.equal(started.pid, process.pid);
    assert.equal(started.exit.reason, 'running',
      'a file written at start must not claim the process finished');
    assert.equal(started.requests, 0);
    assert.equal(started.lastRequest, null);
    assert.equal(started.stdinClosedAt, null);
    assert.ok(Number.isFinite(started.memory.rss) && started.memory.rss > 0);
    assert.ok(Number.isFinite(started.memory.heapUsed) && started.memory.heapUsed > 0);
    // The number that would have settled the OOM question in one look.
    assert.ok(Number.isFinite(started.memory.heapSizeLimit) && started.memory.heapSizeLimit > 0,
      'the heap ceiling must be recorded so heap exhaustion can be ruled in or out');
    assert.equal(typeof started.runAsNode, 'boolean');
    assert.ok(Array.isArray(started.execArgv));
    assert.equal(typeof started.versions.v8, 'string');

    // A request updates the in-memory record; the NAME is kept, the arguments
    // are not, and a line that is not JSON must not throw.
    mcpServer.noteLastWordsRequest(JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'host.exec', arguments: { command: 'SECRET-ARGUMENT-VALUE' } }
    }));
    mcpServer.noteLastWordsRequest('{not json at all');
    assert.ok(mcpServer.writeLastWords());
    const raw = fs.readFileSync(file, 'utf8');
    const after = JSON.parse(raw);
    assert.equal(after.requests, 2, 'every line read must be counted, parseable or not');
    assert.equal(after.lastRequest.method, null, 'an unparseable line must record no method');
    assert.ok(!raw.includes('SECRET-ARGUMENT-VALUE'),
      'tool arguments must never reach the breadcrumb file');
    assert.ok(raw.endsWith('\n'), 'the file must end with a newline');
  } finally {
    mcpServer.closeLastWordsForTests();
  }
});

test('the exit stamp is what tells a teardown abort apart from a death mid-call', () => {
  const dir = scratchDirectory('last-words-exit');
  const file = path.join(dir, 'mcp-server-probe.json');
  try {
    mcpServer.openLastWords({ stateFile: file });
    mcpServer.noteLastWordsRequest(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cloud.account_list' }
    }));
    mcpServer.writeLastWords();
    const midCall = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(midCall.exit.reason, 'running');
    assert.equal(midCall.lastRequest.tool, 'cloud.account_list',
      'the tool name is the one thing a reader needs and the dumps did not have');

    // process.on('exit') cannot catch a V8/libuv abort -- but the 04:11:56Z abort
    // happened AFTER the JS exit hooks ran, in the native destructor chain. So
    // this stamp is exactly the discriminator that was missing. Emitting the
    // event directly is how a unit test observes the hook the server installs.
    process.emit('exit', 0);
    const stamped = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stamped.exit.reason, 'clean');
    assert.equal(stamped.exit.code, 0);
    assert.equal(typeof stamped.exit.at, 'string');
    assert.equal(stamped.lastRequest.tool, 'cloud.account_list',
      'the exit stamp must not erase what the process was last asked to do');
  } finally {
    mcpServer.closeLastWordsForTests();
  }
});

test('a breadcrumb that cannot be written never breaks the transport', () => {
  try {
    // A path whose parent cannot be created. openLastWords() must swallow it and
    // every later call must be a no-op rather than a throw on the read loop.
    const impossible = path.join(scratchDirectory('last-words-refused'), 'a-file');
    fs.writeFileSync(impossible, 'this is a file, not a directory\n');
    assert.equal(mcpServer.openLastWords({ stateFile: path.join(impossible, 'nested.json') }), null);
    assert.doesNotThrow(() => mcpServer.noteLastWordsRequest('{"method":"tools/list"}'));
    assert.equal(mcpServer.writeLastWords(), false);
    assert.doesNotThrow(() => process.emit('exit', 0));
  } finally {
    mcpServer.closeLastWordsForTests();
  }
});
