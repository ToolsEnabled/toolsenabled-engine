'use strict';

// The runner fences the adversarial review asked for: the http runner refuses
// local and private address literals (encrypted-only is not an internal-network
// control), and envKeys refuses credential-shaped names (the value fence cannot
// see a secret only the name gives away).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { RunnerError, MAX_CAPTURE_BYTES, MAX_HTTP_BODY_BYTES, defaultDispatch, isPrivateHostLiteral, runAgent, runHttp, runProcess, substitute } = require('../src/lib/research/runners');
const { collect } = require('../src/lib/research/collectors');
const { rootPath } = require('../src/lib/runtime');
const { resetStateRootForTests } = require('../src/lib/runtime-state-root');

const HTTP_EXPERIMENT = url => ({
  runnerConfig: { url }, timeoutMs: 5000
});

test('the http runner refuses loopback, private and link-local literals by name', async () => {
  const refused = [
    'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x',
    'https://192.168.1.10/x', 'https://172.16.0.1/x', 'https://169.254.169.254/latest',
    'https://[::1]/x', 'https://app.localhost/x'
  ];
  for (const url of refused) {
    await assert.rejects(runHttp({ experiment: HTTP_EXPERIMENT(url), run: { params: {} } }),
      error => error instanceof RunnerError && error.code === 'RESEARCH_RUNNER_HOST_REFUSED',
      `${url} must be refused as a local or private target`);
  }
  // A substituted host lands in the same check: the param cannot smuggle one in.
  await assert.rejects(runHttp({ experiment: HTTP_EXPERIMENT('https://{host}/x'), run: { params: { host: '127.0.0.1' } } }),
    error => error.code === 'RESEARCH_RUNNER_HOST_REFUSED');
});

// Measured 2026-08-15, with research.runner_http live: the first guard matched
// dotted-quad TEXT, so https://[::ffff:127.0.0.1]/ — which the URL parser
// normalizes to [::ffff:7f00:1], not to a dotted quad — reached loopback, where
// this product's own bridges listen. Alternate IPv4 spellings were already safe
// because the parser folds them; the IPv6 forms are the ones that needed
// expanding. Both directions are pinned: a leak is a hole, an over-refusal
// silently takes a working runner away from a researcher.
test('the host guard sees through IPv4-mapped IPv6 and every alternate spelling', async () => {
  const refused = [
    '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:a00:5]', '[::ffff:c0a8:101]',
    '[::127.0.0.1]', '[0:0:0:0:0:0:0:1]', '[::]', '[fd12:3456::1]', '[fec0::1]',
    '[fe80::1]', '[fc00::1]', '172.31.255.255', 'sub.localhost', '[not:an:address:zz]'
  ];
  for (const host of refused) {
    assert.equal(isPrivateHostLiteral(host), true, `${host} must read as private (an unreadable literal too)`);
  }
  const allowed = [
    'example.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '193.168.1.1',
    '[2606:4700::1111]', '[::ffff:8.8.8.8]', 'localhost.example.com', 'my-localhost.dev'
  ];
  for (const host of allowed) {
    assert.equal(isPrivateHostLiteral(host), false, `${host} is a public target and must still run`);
  }
  // The alternate IPv4 spellings arrive already normalized; pin that assumption
  // rather than trusting it, since the whole guard rests on it.
  for (const raw of ['https://2130706433/', 'https://0x7f000001/', 'https://017700000001/', 'https://127.1/']) {
    assert.equal(new URL(raw).hostname, '127.0.0.1', `${raw} must normalize before the guard sees it`);
  }
  await assert.rejects(runHttp({ experiment: HTTP_EXPERIMENT('https://[::ffff:127.0.0.1]/x'), run: { params: {} } }),
    error => error instanceof RunnerError && error.code === 'RESEARCH_RUNNER_HOST_REFUSED');
  await assert.rejects(runHttp({ experiment: HTTP_EXPERIMENT('https://{host}/x'), run: { params: { host: '[::ffff:10.0.0.5]' } } }),
    error => error.code === 'RESEARCH_RUNNER_HOST_REFUSED');
});

test('envKeys refuses credential-shaped names before any value is read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-runners-'));
  const experiment = {
    runnerConfig: { command: process.execPath, args: ['-e', '0'], stdin: 'none', envKeys: ['ANTHROPIC_API_KEY'] },
    timeoutMs: 5000
  };
  await assert.rejects(async () => runProcess({ experiment, run: { runId: 'rr-1', params: {} }, artifactDir: dir }),
    error => error instanceof RunnerError && error.code === 'RESEARCH_RUNNER_ENV_REFUSED');
  const okConfig = {
    runnerConfig: { command: process.execPath, args: ['-e', 'console.log(process.env.RESEARCH_PLAIN_FLAG||"absent")'], stdin: 'none', envKeys: ['RESEARCH_PLAIN_FLAG', 'ELECTRON_RUN_AS_NODE'] },
    timeoutMs: 15000
  };
  process.env.RESEARCH_PLAIN_FLAG = 'carried';
  try {
    const outcome = await runProcess({ experiment: okConfig, run: { runId: 'rr-2', params: {} }, artifactDir: dir });
    assert.equal(outcome.exitCode, 0);
    assert.match(outcome.stdout, /carried/, 'a plain declared name still passes through');
  } finally {
    delete process.env.RESEARCH_PLAIN_FLAG;
  }
});

test('substitution refuses a missing param instead of running a wrong command quietly', () => {
  assert.equal(substitute('run {a}', { a: 'x' }, 'args'), 'run x');
  assert.throws(() => substitute('run {b}', { a: 'x' }, 'args'),
    error => error.code === 'RESEARCH_RUNNER_PARAM_MISSING');
  assert.throws(() => substitute('run {a}', { a: { nested: true } }, 'args'),
    error => error.code === 'RESEARCH_RUNNER_PARAM_NOT_TEXT');
});

test('runner uncertainty is refused instead of becoming a successful result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-runners-'));
  const circular = {};
  circular.self = circular;
  // An async thunk, not a bare call: runProcess validates before it builds its
  // promise, so this refusal is a synchronous throw. The producing caller
  // awaits, where the two shapes are the same refusal -- the thunk gives this
  // assertion the caller's own view instead of pinning throw timing.
  await assert.rejects(async () => runProcess({
    experiment: {
      runnerConfig: { command: process.execPath, args: ['-e', 'process.exit(0)'], stdin: 'params-json' },
      timeoutMs: 5000
    },
    run: { runId: 'rr-unserializable', params: circular },
    artifactDir: dir
  }), error => error instanceof RunnerError && error.code === 'RESEARCH_RUNNER_PARAMS_NOT_JSON');

  await assert.rejects(runAgent({
    experiment: { runnerConfig: { briefTemplate: 'research {topic}' }, timeoutMs: 5000 },
    run: { runId: 'rr-no-launch-id', params: { topic: 'uncertainty' } },
    project: { name: 'fixture', projectId: 'project-fixture' },
    artifactDir: dir,
    dispatch: async () => ({ ok: true })
  }), error => error instanceof RunnerError && error.code === 'RESEARCH_AGENT_DISPATCH_UNCONFIRMED');

  const originalRead = fs.readFileSync;
  resetStateRootForTests();
  try {
    fs.readFileSync = () => {
      const error = new Error('state-root record cannot be inspected');
      error.code = 'EMFILE';
      throw error;
    };
    await assert.rejects(defaultDispatch({ brief: 'fixture', objectiveRef: 'fixture', timeoutMs: 1000 }), error =>
      error instanceof RunnerError
      && error.code === 'RESEARCH_BRIDGE_STATE_INDETERMINATE'
      && error.details.causeCode === 'EMFILE'
      && /does not claim.*absent/i.test(error.message));
  } finally {
    fs.readFileSync = originalRead;
    resetStateRootForTests();
  }

  // Resolve and fence the state root before replacing bridge-record reads.
  // State-root initialization has its own owner-only adoption record; the
  // remaining stubs control the bridge records specifically.
  rootPath('state');
  let reads = 0;
  try {
    fs.readFileSync = () => {
      reads += 1;
      const error = new Error('file table is temporarily exhausted');
      error.code = 'EMFILE';
      throw error;
    };
    await assert.rejects(defaultDispatch({ brief: 'fixture', objectiveRef: 'fixture', timeoutMs: 1000 }), error =>
      error instanceof RunnerError
      && error.code === 'RESEARCH_BRIDGE_STATE_INDETERMINATE'
      && error.details.causeCode === 'EMFILE'
      && /does not claim.*absent/i.test(error.message));

    // A second attempt must perform the read again: transient uncertainty is
    // neither cached nor latched for the life of this process.
    await assert.rejects(defaultDispatch({ brief: 'fixture', objectiveRef: 'fixture', timeoutMs: 1000 }), error =>
      error.code === 'RESEARCH_BRIDGE_STATE_INDETERMINATE');
    assert.equal(reads, 2);

    // CONTROL: the one read result that genuinely established absence before
    // this change (ENOENT) keeps the original definite answer.
    fs.readFileSync = () => {
      const error = new Error('record does not exist');
      error.code = 'ENOENT';
      throw error;
    };
    await assert.rejects(defaultDispatch({ brief: 'fixture', objectiveRef: 'fixture', timeoutMs: 1000 }), error =>
      error instanceof RunnerError && error.code === 'RESEARCH_BRIDGE_UNAVAILABLE');
  } finally {
    fs.readFileSync = originalRead;
  }

  const originalLoad = Module._load;
  let attemptedLoads = 0;
  const input = {
    experiment: {
      runnerConfig: { command: process.execPath, envProfile: 'codex-account', envProfileAccount: 'fixture' },
      timeoutMs: 1000
    },
    run: { runId: 'rr-profile-load', params: {} },
    artifactDir: os.tmpdir()
  };
  try {
    Module._load = function (request, parent, isMain) {
      if (request === '../multi-account/registry' && parent && /research[/\\]runners\.js$/.test(parent.filename)) {
        attemptedLoads += 1;
        const error = new Error('loader file table is temporarily exhausted');
        error.code = 'EMFILE';
        throw error;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    await assert.rejects(async () => runProcess(input), error =>
      error.code === 'RESEARCH_ENV_PROFILE_INDETERMINATE'
      && error.details.causeCode === 'EMFILE'
      && /does not claim.*absent/i.test(error.message));
    await assert.rejects(async () => runProcess(input), error => error.code === 'RESEARCH_ENV_PROFILE_INDETERMINATE');
    assert.equal(attemptedLoads, 2, 'a failed module load must be retried rather than latched');

    // CONTROL: preserve the established absence result for the requested
    // profile module itself; broad "never answer unavailable" also fails here.
    Module._load = function (request, parent, isMain) {
      if (request === '../multi-account/registry' && parent && /research[/\\]runners\.js$/.test(parent.filename)) {
        const error = new Error("Cannot find module '../multi-account/registry'");
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    await assert.rejects(async () => runProcess(input), error => error.code === 'RESEARCH_ENV_PROFILE_UNAVAILABLE');
  } finally {
    Module._load = originalLoad;
  }
});


test('HTTP runs use the real shared response contract and preserve exact collector input', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const body = ' {"score":3,"label":"€"}\n';
  try {
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(body, { status: 201, headers: { 'content-type': 'application/json' } });
    };
    const outcome = await runHttp({ experiment: { runnerConfig: { url: 'https://example.test/{cell}', method: 'POST', bodyTemplate: '{cell}' }, timeoutMs: 1000 }, run: { params: { cell: 'fixture' } } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.test/fixture');
    assert.equal(calls[0].options.body, 'fixture');
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal(outcome.status, 201);
    assert.equal(outcome.body, body);
    assert.equal(outcome.bodyBytes, Buffer.byteLength(body));
    assert.equal(outcome.truncated, false);
    assert.equal(collect({ collector: { kind: 'stdout-json' }, stdout: outcome.body }).records[0].record.score, 3);

    global.fetch = async () => new Response('{"score":1e999}', { headers: { 'content-type': 'application/json' } });
    const nonFinite = await runHttp({ experiment: HTTP_EXPERIMENT('https://example.test/nonfinite'), run: { params: {} } });
    assert.equal(nonFinite.body, '{"score":1e999}');
    const refused = collect({ collector: { kind: 'stdout-json' }, stdout: nonFinite.body });
    assert.equal(refused.records.length, 0);
    assert.match(refused.refused[0].reason, /finite/);
  } finally { global.fetch = originalFetch; }
});

test('HTTP overflows and redirects cannot turn a successful prefix into accepted results', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => new Response('€'.repeat(Math.ceil((MAX_HTTP_BODY_BYTES + 1) / 3)));
    const overflow = await runHttp({ experiment: HTTP_EXPERIMENT('https://example.test/large'), run: { params: {} } });
    assert.equal(overflow.truncated, true);
    assert.ok(overflow.bodyBytes > MAX_HTTP_BODY_BYTES);
    let calls = 0;
    global.fetch = async (_url, options) => {
      calls += 1;
      assert.equal(options.redirect, 'manual');
      return new Response('not a result', { status: 302, headers: { location: 'https://127.0.0.1/private' } });
    };
    await assert.rejects(runHttp({ experiment: HTTP_EXPERIMENT('https://example.test/redirect'), run: { params: {} } }), error => error.code === 'HTTP_REDIRECT_REFUSED');
    assert.equal(calls, 1, 'a redirect is neither followed nor retried');
    global.fetch = async () => new Response('not a result', { status: 500 });
    await assert.rejects(runHttp({ experiment: { runnerConfig: { url: 'https://example.test/failure', method: 'POST' }, timeoutMs: 1000 }, run: { params: {} } }), /HTTP 500/);
  } finally { global.fetch = originalFetch; }
});

test('bridge dispatch reads the real parsed receipt instead of a Fetch-only test double', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-dispatch-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'state'));
  fs.writeFileSync(path.join(dir, 'state', 'mission-bridge-runtime.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:43123' }));
  fs.writeFileSync(path.join(dir, 'state', 'mission-bridge-token.json'), JSON.stringify({ token: 'fixture-token-not-an-owner-secret' }));
  const originalFetch = global.fetch;
  const input = { brief: 'fixture brief', objectiveRef: 'fixture-ref', timeoutMs: 1000 };
  const dependencies = { rootPath: (...parts) => path.join(dir, ...parts) };
  try {
    let calls = 0;
    global.fetch = async (url, options) => {
      calls += 1;
      assert.equal(url, 'http://127.0.0.1:43123/v1/actions/dispatch');
      assert.equal(options.redirect, 'manual');
      assert.deepEqual(JSON.parse(options.body), { brief: 'fixture brief', objectiveRef: 'fixture-ref' });
      return new Response('{"ok":true,"receipt":{"launchId":"launch_fixture"}}', { headers: { 'content-type': 'application/json' } });
    };
    assert.deepEqual(await defaultDispatch(input, dependencies), { ok: true, receipt: { launchId: 'launch_fixture' } });
    assert.equal(calls, 1);
    global.fetch = async () => new Response('{"ok":false,"error":{"code":"FIXTURE_BUSY"}}', { headers: { 'content-type': 'application/json' } });
    await assert.rejects(defaultDispatch(input, dependencies), error => error.code === 'RESEARCH_BRIDGE_DISPATCH_FAILED' && error.details.reason === 'FIXTURE_BUSY');
    await assert.rejects(runAgent({ experiment: { runnerConfig: { briefTemplate: 'fixture' }, timeoutMs: 1000 }, run: { runId: 'run-fixture', params: {} }, project: { name: 'fixture', projectId: 'fixture' }, artifactDir: dir, dispatch: async () => ({ launchId: '   ' }) }), error => error.code === 'RESEARCH_AGENT_DISPATCH_UNCONFIRMED');
  } finally { global.fetch = originalFetch; }
});

test('process capture preserves each exact boundary and stops overflowing output', async t => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-process-capture-'));
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
  const outcome = await runProcess({
    experiment: { runnerConfig: {
      command: process.execPath, args: ['-e', `process.stdout.write(Buffer.alloc(${MAX_CAPTURE_BYTES}, 97));process.stderr.write(Buffer.alloc(${MAX_CAPTURE_BYTES}, 98));`], stdin: 'none', envKeys: ['ELECTRON_RUN_AS_NODE']
    }, timeoutMs: 15000 }, run: { runId: 'capture-fixture', params: {} }, artifactDir
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stdoutBytes, MAX_CAPTURE_BYTES);
  assert.equal(outcome.stderrBytes, MAX_CAPTURE_BYTES);
  assert.equal(outcome.stdoutTruncated, false);
  assert.equal(outcome.stderrTruncated, false, 'the exact byte boundary is not overflow');
  assert.equal(Buffer.byteLength(outcome.stdout), MAX_CAPTURE_BYTES);
  assert.equal(Buffer.byteLength(outcome.stderr), MAX_CAPTURE_BYTES);
  const overflow = await runProcess({
    experiment: { runnerConfig: { command: process.execPath, envKeys: ['ELECTRON_RUN_AS_NODE'],
      args: ['-e', `process.stdout.write(Buffer.alloc(${MAX_CAPTURE_BYTES + 1}, 97)); setInterval(() => {}, 1000);`] }, timeoutMs: 15000 },
    run: { runId: 'capture-overflow', params: {} }, artifactDir
  });
  assert.equal(overflow.failure.code, 'RESEARCH_RUN_OUTPUT_INCOMPLETE');
  assert.equal(overflow.processLifecycle.acceptanceReady, false);
  assert.equal(overflow.stdoutTruncated, true);
  assert.equal(Buffer.byteLength(overflow.stdout), MAX_CAPTURE_BYTES);
  if (process.platform === 'win32') assert.equal(overflow.processLifecycle.cleanupStatus, 'EMPTY');
});

function processInput(artifactDir, config = {}) {
  return { experiment: { runnerConfig: { command: process.execPath, args: ['-e', 'process.exit(0)'], envKeys: ['ELECTRON_RUN_AS_NODE'], ...config }, timeoutMs: 5000 },
    run: { runId: 'lifecycle-fixture', params: {} }, artifactDir };
}

function fakeProcess() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.unref = () => child;
  child.kill = () => { throw new Error('no real PID operation is allowed in the injected fixture'); };
  child.jobIdentity = { jobId: 'fixture-job', wrapperPid: 12345, wrapperStartTicks: '123', rootPid: 12346, rootStartTicks: '124' };
  child.jobReady = Promise.resolve(child.jobIdentity);
  let resolveOutcome;
  child.jobOutcome = new Promise(resolve => { resolveOutcome = resolve; });
  child.terminateJob = () => new Promise(() => {});
  child.terminateRetainedWrapper = () => Promise.resolve({ type: 'wrapper-terminated', activeProcesses: 0 });
  return { child, resolveOutcome };
}

test('process lifecycle checks cancellation and the unpinned claim before creation', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runProcess({ ...processInput(os.tmpdir()), signal: controller.signal }, {
    spawnInJob: () => { calls += 1; throw new Error('must not launch'); }
  }), error => error.code === 'RESEARCH_RUN_ABORTED');
  let checked = false;
  await assert.rejects(runProcess({ ...processInput(os.tmpdir()), beforeLaunch: () => {
    checked = true; throw Object.assign(new Error('claim lost'), { code: 'FIXTURE_LEASE_LOST' });
  } }, { platform: 'win32', spawnInJob: () => { calls += 1; throw new Error('must not launch'); } }),
  error => error.code === 'FIXTURE_LEASE_LOST');
  assert.equal(checked, true, 'unpinned commands must also cross the last claim check');
  assert.equal(calls, 0);
});

test('process lifecycle never treats a missing receipt or wrapper fallback as native cleanup proof', async () => {
  const { child } = fakeProcess();
  let fallbacks = 0;
  child.terminateRetainedWrapper = () => { fallbacks += 1; return Promise.resolve({ type: 'wrapper-terminated', activeProcesses: 0 }); };
  const input = processInput(os.tmpdir()); input.experiment.timeoutMs = 20;
  const outcome = await runProcess(input, { platform: 'win32', cleanupMs: 100,
    spawnInJob: () => { queueMicrotask(() => child.emit('spawn')); return child; }
  });
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.exitCode, null);
  assert.equal(outcome.processLifecycle.cleanupStatus, 'UNKNOWN');
  assert.equal(outcome.processLifecycle.acceptanceReady, false);
  assert.equal(outcome.processLifecycle.receipt, null);
  assert.equal(fallbacks, 1);
  assert.ok(outcome.durationMs < 2000, 'cleanup observation is bounded even if every child promise stays pending');
  child.emit('close', 124, null);
});

test('process lifecycle requires wrapper closure and distinguishes termination status from root exit', async () => {
  for (const type of ['exit', 'terminated']) {
    const { child, resolveOutcome } = fakeProcess();
    const outcome = await runProcess(processInput(os.tmpdir()), { platform: 'win32', cleanupMs: 100,
      spawnInJob: () => {
        queueMicrotask(() => { child.emit('spawn'); resolveOutcome({ type, exitCode: type === 'exit' ? 0 : 124, activeProcesses: 0 }); });
        setTimeout(() => child.emit('close', type === 'exit' ? 0 : 124, null), 25);
        return child;
      }
    });
    assert.equal(outcome.processLifecycle.wrapperClosed, true);
    assert.equal(outcome.processLifecycle.cleanupStatus, 'EMPTY');
    assert.equal(outcome.exitCode, type === 'exit' ? 0 : null);
    assert.equal(outcome.processLifecycle.acceptanceReady, type === 'exit');
  }
});

test('process lifecycle refuses native authorization after timeout and fails incomplete stdin delivery', async () => {
  const late = fakeProcess();
  const input = processInput(os.tmpdir()); input.experiment.timeoutMs = 20;
  const neverAuthorized = await runProcess(input, { platform: 'win32', cleanupMs: 100,
    spawnInJob: (_command, _args, _options, dependencies) => {
      setTimeout(() => {
        assert.throws(() => dependencies.beforeRootSpawn(), error => error.code === 'RESEARCH_RUN_TIMEOUT');
        late.child.emit('close', 1, null);
      }, 40);
      return late.child;
    }
  });
  assert.equal(neverAuthorized.timedOut, true);
  assert.equal(neverAuthorized.processLifecycle.started, false);
  assert.equal(neverAuthorized.processLifecycle.cleanupStatus, 'NOT_STARTED');
  assert.equal(neverAuthorized.processLifecycle.acceptanceReady, false);

  const brokenInput = fakeProcess();
  brokenInput.child.stdin.end = () => { throw Object.assign(new Error('fixture closed input'), { code: 'EPIPE' }); };
  brokenInput.child.terminateJob = () => {
    const receipt = { type: 'terminated', exitCode: 124, activeProcesses: 0 };
    brokenInput.resolveOutcome(receipt);
    setImmediate(() => brokenInput.child.emit('close', 124, null));
    return Promise.resolve(receipt);
  };
  const incomplete = await runProcess(processInput(os.tmpdir(), { stdin: 'params-json' }), {
    platform: 'win32', cleanupMs: 100,
    spawnInJob: () => { queueMicrotask(() => brokenInput.child.emit('spawn')); return brokenInput.child; }
  });
  assert.equal(incomplete.failure.code, 'RESEARCH_RUN_STDIN_FAILED');
  assert.equal(incomplete.processLifecycle.cleanupStatus, 'EMPTY');
  assert.equal(incomplete.processLifecycle.acceptanceReady, false);
});

test('non-Linux POSIX fallback preserves normal execution and never signals a group after root exit', async () => {
  const child = fakeProcess().child;
  let groupSignals = 0;
  const result = await runProcess(processInput(os.tmpdir()), { platform: 'darwin', cleanupMs: 100,
    killProcessGroup: () => { groupSignals += 1; },
    spawn: (_command, _args, options) => {
      assert.equal(options.detached, true);
      queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0, null); child.emit('close', 0, null); });
      return child;
    }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.processLifecycle.acceptanceReady, true);
  assert.equal(result.processLifecycle.cleanupStatus, 'ROOT_CLOSED');
  assert.equal(result.processLifecycle.receipt, null);
  assert.equal(groupSignals, 0);
  const second = fakeProcess().child;
  const controller = new AbortController();
  const stopped = await runProcess({ ...processInput(os.tmpdir()), signal: controller.signal }, { platform: 'darwin', cleanupMs: 100,
    killProcessGroup: () => { groupSignals += 1; },
    spawn: () => { queueMicrotask(() => { second.emit('spawn'); second.emit('exit', 0, null); controller.abort(); }); return second; }
  });
  assert.equal(stopped.processLifecycle.cleanupStatus, 'UNKNOWN');
  assert.equal(stopped.processLifecycle.acceptanceReady, false);
  assert.equal(groupSignals, 0, 'the exited root cannot authorize a later numeric group signal');
  second.emit('close', 0, null);

  const active = fakeProcess().child;
  const activeController = new AbortController();
  const killed = await runProcess({ ...processInput(os.tmpdir()), signal: activeController.signal }, {
    platform: 'darwin', cleanupMs: 100,
    killProcessGroup: (pid, signal) => {
      groupSignals += 1;
      assert.equal(pid, -active.pid);
      assert.equal(signal, 'SIGKILL');
      setImmediate(() => { active.emit('exit', null, 'SIGKILL'); active.emit('close', null, 'SIGKILL'); });
    },
    spawn: () => { queueMicrotask(() => { active.emit('spawn'); activeController.abort(); }); return active; }
  });
  assert.equal(groupSignals, 1);
  assert.equal(killed.processLifecycle.cleanupStatus, 'UNKNOWN', 'requesting a group signal is not a process-membership proof');
  assert.equal(killed.processLifecycle.acceptanceReady, false);
});

test('process lifecycle cleans real native descendants on root exit, cancellation and timeout', { skip: process.platform !== 'win32' }, async t => {
  for (const mode of ['root-exit', 'cancel', 'timeout']) await t.test(mode, async t => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-native-lifecycle-'));
    t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
    const ready = path.join(artifactDir, 'leaf.ready');
    const leaf = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => {}, 10000);`;
    const program = `const fs=require('node:fs'); const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,windowsHide:true,stdio:'ignore'}); c.unref(); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer); ${mode === 'root-exit' ? "process.stdout.write('complete\\n');process.exit(0);" : 'setTimeout(()=>{},10000);'}}},10);`;
    const controller = new AbortController();
    let abortTimer;
    if (mode === 'cancel') abortTimer = setInterval(() => { if (fs.existsSync(ready)) { clearInterval(abortTimer); controller.abort(); } }, 10);
    t.after(() => clearInterval(abortTimer));
    const input = processInput(artifactDir, { args: ['-e', program] });
    if (mode === 'timeout') input.experiment.timeoutMs = 3000;
    const outcome = await runProcess({ ...input, signal: controller.signal });
    assert.equal(fs.existsSync(ready), true, 'a real descendant must start before testing cleanup');
    const leafPid = Number(fs.readFileSync(ready, 'utf8'));
    assert.throws(() => process.kill(leafPid, 0), error => error.code === 'ESRCH', 'the actual descendant must already be absent');
    assert.equal(outcome.processLifecycle.cleanupStatus, 'EMPTY');
    assert.equal(outcome.processLifecycle.wrapperClosed, true);
    assert.equal(outcome.processLifecycle.receipt.activeProcesses, 0);
    assert.equal(outcome.processLifecycle.acceptanceReady, mode === 'root-exit');
    if (mode === 'root-exit') { assert.equal(outcome.exitCode, 0); assert.equal(outcome.stdout, 'complete\n'); }
    else {
      assert.equal(outcome.cancelled, mode === 'cancel');
      assert.equal(outcome.timedOut, mode === 'timeout');
      assert.equal(outcome.exitCode, null);
    }
  });
});
