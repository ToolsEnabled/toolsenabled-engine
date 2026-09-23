'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

if (process.argv.includes('--unresponsive-version-fixture')) {
  fs.writeFileSync(process.argv[process.argv.length - 1], String(process.pid));
  setInterval(() => {}, 60_000);
} else if (process.argv.includes('--responding-version-fixture')) {
  process.stdout.write('codex-cli 0.153.0\n');
} else {
  main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function bounded(promise, label, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Test watchdog: ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function until(predicate, label) {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Test watchdog: ${label}`);
    await delay(10);
  }
}

async function realVersionCancellation() {
  const { detectCodexVersion } = require('../../src/lib/agent-engine/codex-process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-startup-cancellation-'));
  const pids = [];
  try {
    for (const mode of ['abort', 'timeout']) {
      const pidFile = path.join(root, `${mode}.pid`);
      const controller = new AbortController();
      const pending = detectCodexVersion({
        command: process.execPath,
        args: [__filename, '--unresponsive-version-fixture', pidFile],
        signal: controller.signal,
        timeoutMs: mode === 'timeout' ? 5_000 : 60_000,
        containProcessTree: true
      });
      // Attach the rejection observer before waiting for the child to boot.
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      await until(() => fs.existsSync(pidFile), `${mode} version child ready`);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      pids.push(pid);
      assert.equal(alive(pid), true, 'the real version child must be running');
      const stoppedAt = performance.now();
      if (mode === 'abort') controller.abort(new Error('fixture closed its session'));
      // Timeout mode first spends its 5s operation deadline, then must await
      // the retained scope's cleanup receipt. Its watchdog covers both phases.
      const { error } = await bounded(outcome, `${mode} releases version caller`, mode === 'timeout' ? 10_000 : 5_000);
      const reasonCode = mode === 'abort' ? 'CODEX_VERSION_DETECTION_ABORTED' : 'CODEX_VERSION_DETECTION_TIMEOUT';
      const contained = process.platform === 'win32' || process.platform === 'linux';
      assert.equal(error && error.code, contained ? reasonCode : 'CODEX_VERSION_CLEANUP_UNPROVEN');
      if (!contained) assert.equal(error.cause.code, reasonCode);
      else if (mode === 'abort') assert.equal(error.name, 'AbortError');
      assert.equal(alive(pid), false, 'the version operation must settle only after its child is stopped');
      process.stdout.write(`ok - real version ${mode}: caller and child stopped in ${(performance.now() - stoppedAt).toFixed(1)}ms\n`);
    }
  } finally {
    // Only PIDs reported by these directly launched fixtures are addressed.
    for (const pid of pids) if (alive(pid)) process.kill(pid);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withProtocolPeer() {
  const modulePath = require.resolve('../../src/lib/agent-engine/codex-process');
  const originalLoad = Module._load;
  const observations = {
    children: [], methods: [], requests: [], stopped: null, ready: null, cleanupError: null, resumeError: null,
    terminate: null, fallback: null, cleanupStarted: null
  };

  function spawnHidden(command, args, options) {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.killCount = 0;
    child.jobTerminations = 0;
    child.wrapperTerminations = 0;
    child.fixtureOutcome = Promise.withResolvers();
    child.jobOutcome = child.fixtureOutcome.promise;
    const finish = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
      child.emit('close', null, 'SIGTERM');
    };
    child.kill = () => { child.killCount += 1; finish(); return true; };
    child.finish = finish;
    child.terminateJob = () => {
      child.jobTerminations += 1;
      if (observations.cleanupStarted) observations.cleanupStarted.resolve(child);
      if (observations.terminate) return observations.terminate(child);
      if (observations.cleanupError) throw observations.cleanupError;
      finish();
      return Promise.resolve({ type: 'terminated', activeProcesses: 0, exitCode: 0 });
    };
    child.terminateRetainedWrapper = () => {
      child.wrapperTerminations += 1;
      if (observations.fallback) return observations.fallback(child);
      finish();
      return Promise.resolve({ type: 'wrapper-terminated', activeProcesses: 0 });
    };
    if (!options.containProcessTree) {
      delete child.terminateJob;
      delete child.terminateRetainedWrapper;
    }
    for (const name of ['stdin', 'stdout', 'stderr']) {
      child[name] = new EventEmitter();
      child[name].setEncoding = () => {};
      child[name].writable = true;
      child[name].destroy = () => { child[name].destroyed = true; };
    }
    child.stdin.write = line => {
      const request = JSON.parse(line);
      observations.methods.push(request.method);
      observations.requests.push(request);
      // initialized is a notification. A peer response without an id is an
      // invalid packet, not a lifecycle cancellation or valid ready session.
      if (request.method === 'initialized') return true;
      if (request.method === observations.stopped) {
        observations.ready.resolve(child);
        return true;
      }
      if (request.method === 'thread/resume' && observations.resumeError) {
        queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: request.id, error: observations.resumeError })}\n`));
        return true;
      }
      // The 0.153.0 peer advertises the modern wire catalog; the adapter normalizes it to models.
      const result = request.method === 'initialize' ? { userAgent: 'offline-fixture' }
        : request.method === 'config/read' ? { config: { developer_instructions: 'Retained protocol fixture policy' } }
        : request.method === 'model/list' ? { data: [], nextCursor: null }
          : { thread: { id: request.method === 'thread/resume' ? request.params.threadId : 'created-thread', turns: [] }, model: 'actual-protocol-model', reasoningEffort: 'high' };
      queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: request.id, result })}\n`));
      return true;
    };
    observations.children.push(child);
    if (args.includes('--version')) {
      if (observations.stopped === 'version') observations.ready.resolve(child);
      else queueMicrotask(() => {
        child.stdout.emit('data', 'codex-cli 0.153.0\n');
        child.exitCode = 0;
        child.emit('close', 0);
      });
    }
    return child;
  }

  Module._load = function(request, parent, isMain) {
    if (parent && parent.filename === modulePath && request === '../proc/hidden-spawn') {
      return { spawnHidden, resolveHiddenInvocation: (command, args) => ({ command, args }) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  let api;
  try { api = require(modulePath); }
  finally { Module._load = originalLoad; delete require.cache[modulePath]; }
  return { api, observations };
}

async function protocolStartupCancellation() {
  const { api, observations } = withProtocolPeer();
  const sessions = new Set();
  const invocation = { command: 'offline-protocol-peer', cwd: process.cwd(), startupTimeoutMs: 2_000 };
  try {
    for (const method of ['startCodexSession', 'resumeCodexSession']) {
      const cancelled = new AbortController();
      cancelled.abort();
      const before = observations.children.length;
      await assert.rejects(api[method]({ ...invocation, threadId: 'saved-thread', signal: cancelled.signal }),
        error => error.code === 'CODEX_START_ABORTED' && error.name === 'AbortError');
      assert.equal(observations.children.length, before, 'pre-cancelled startup must not spawn');

      for (const phase of ['version', 'initialize', ...(method === 'startCodexSession' ? ['config/read', 'thread/start'] : ['thread/resume'])]) {
        for (const mode of ['abort', 'timeout']) {
          observations.stopped = phase;
          observations.ready = Promise.withResolvers();
          observations.methods = [];
          const controller = new AbortController();
          const pending = api[method]({
            ...invocation, threadId: 'saved-thread', signal: controller.signal,
            ...(method === 'resumeCodexSession' ? { threadOptions: { developerInstructions: 'Captured explicit resume policy' } } : {}),
            startupTimeoutMs: mode === 'timeout' ? 50 : 2_000
          });
          const rejection = assert.rejects(bounded(pending, `${method} ${phase} ${mode}`),
            error => error.code === (mode === 'abort' ? 'CODEX_START_ABORTED' : 'CODEX_START_TIMEOUT'));
          const child = await bounded(observations.ready.promise, `${phase} reached`);
          if (mode === 'abort') controller.abort();
          await rejection;
          // Closing a startup closes the real adapter and process transport;
          // the external peer alone is fake. No late protocol reply can spawn
          // a thread after the caller has been told startup was cancelled.
          assert.equal(child.jobTerminations, 1);
          const methodsBeforeLateReply = observations.methods.slice();
          child.stdout.emit('data', '{"id":1,"result":{"userAgent":"late-peer"}}\n');
          await delay(0);
          assert.deepEqual(observations.methods, methodsBeforeLateReply);
          process.stdout.write(`ok - ${method} ${mode} during ${phase} releases and closes startup\n`);
        }
      }

      observations.stopped = null;
      const controller = new AbortController();
      const session = await bounded(api[method]({ ...invocation, threadId: 'saved-thread', signal: controller.signal }), `${method} success`);
      sessions.add(session);
      assert.equal(session.threadId, method === 'startCodexSession' ? 'created-thread' : 'saved-thread');
      if (method === 'startCodexSession') {
        assert.deepEqual(session.nativeModeSettings, { model: 'actual-protocol-model', effort: 'high', developerInstructions: 'Retained protocol fixture policy' });
        assert.equal(session.nativeModeUnavailableReason, null);
      } else {
        assert.equal(session.nativeModeSettings, null);
        assert.equal(session.nativeModeUnavailableReason, 'CODEX_MODE_RESUMED_SETTINGS_UNAVAILABLE');
      }
      controller.abort();
      assert.deepEqual(await session.adapter.listModels(), { models: [] }, 'startup cancellation no longer owns a ready session');
      session.close();
      sessions.delete(session);
      process.stdout.write(`ok - ${method} releases its cancellation listener after success\n`);
    }

    for (const fromPath of [false, true]) {
      const before = observations.methods.length;
      const session = await api.resumeCodexSession({ ...invocation, threadId: 'saved-thread',
        threadOptions: { developerInstructions: 'Captured explicit resume policy' },
        ...(fromPath ? { resumeSourcePath: path.resolve('owned-resume.jsonl'), env: { CODEX_HOME: path.resolve('inert-resume-home') }, assertSource() {} } : {}) });
      sessions.add(session);
      assert.deepEqual(session.nativeModeSettings, { model: 'actual-protocol-model', effort: 'high', developerInstructions: 'Captured explicit resume policy' });
      assert.equal(session.nativeModeUnavailableReason, null);
      assert.equal(observations.methods.slice(before).includes('config/read'), false);
      assert.equal(observations.requests.findLast(request => request.method === 'thread/resume').params.developerInstructions, 'Captured explicit resume policy');
      session.close(); sessions.delete(session);
      process.stdout.write(`ok - explicit ${fromPath ? 'path' : 'id'} resume retains admitted instructions and actual settings\n`);
    }
    observations.resumeError = { code: -32602, message: 'Explicit restore refused' };
    await assert.rejects(api.resumeCodexSession({ ...invocation, threadId: 'saved-thread',
      threadOptions: { developerInstructions: 'Captured explicit resume policy' } }), { code: 'CODEX_APP_SERVER_ERROR' });
    observations.resumeError = null;
    assert.ok(observations.children.every(child => child.exitCode !== null || child.signalCode !== null));
    process.stdout.write('ok - explicit resume provider refusal closes the owned startup before returning\n');

    observations.stopped = 'initialize';
    observations.ready = Promise.withResolvers();
    observations.cleanupError = new Error('fixture could not close its process tree');
    const controller = new AbortController();
    const pending = api.startCodexSession({ ...invocation, signal: controller.signal });
    const rejection = assert.rejects(pending, error => error.code === 'CODEX_START_CLEANUP_UNPROVEN'
      && error.errors[0].errors.includes(observations.cleanupError));
    await bounded(observations.ready.promise, 'cleanup failure initialization');
    controller.abort();
    await rejection;
    process.stdout.write('ok - startup cancellation preserves a synchronous cleanup failure\n');
  } finally {
    for (const session of sessions) session.close();
  }
}

function includesError(root, target, seen = new Set()) {
  if (root === target) return true;
  if (!root || typeof root !== 'object' || seen.has(root)) return false;
  seen.add(root);
  return includesError(root.cause, target, seen)
    || (Array.isArray(root.errors) && root.errors.some(error => includesError(error, target, seen)));
}

async function cleanupConfirmation() {
  for (const method of ['startCodexSession', 'resumeCodexSession']) {
    for (const phase of ['initialize', 'version']) {
      for (const mode of ['deferred', 'rejected', 'timeout', 'nonzero', 'wrapper-only']) {
        const { api, observations } = withProtocolPeer();
        observations.stopped = phase;
        observations.ready = Promise.withResolvers();
        observations.cleanupStarted = Promise.withResolvers();
        const controller = new AbortController();
        const termination = Promise.withResolvers();
        const injectedError = new Error('fixture lost its authenticated cleanup receipt');
        observations.terminate = child => termination.promise.then(receipt => { child.finish(); return receipt; });
        if (mode === 'timeout') observations.fallback = () => new Promise(() => {});
        const pending = api[method]({
          command: 'offline-protocol-peer', cwd: process.cwd(), threadId: 'saved-thread',
          signal: controller.signal, startupTimeoutMs: 2_000, cleanupTimeoutMs: mode === 'timeout' ? 30 : 1_000
        });
        let settled = false;
        const outcome = pending.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
        const child = await bounded(observations.ready.promise, `${method} ${phase} reached`);
        controller.abort();
        await bounded(observations.cleanupStarted.promise, `${method} ${phase} cleanup requested`);
        await delay(10);
        assert.equal(settled, false, `${method} must retain ${phase} until asynchronous cleanup is known`);
        if (mode === 'deferred') termination.resolve({ type: 'terminated', activeProcesses: 0, exitCode: 0 });
        if (mode === 'rejected') termination.reject(injectedError);
        if (mode === 'nonzero') termination.resolve({ type: 'terminated', activeProcesses: 1, exitCode: 0 });
        if (mode === 'wrapper-only') termination.resolve({ type: 'wrapper-terminated', activeProcesses: 0, exitCode: 0 });
        const { error } = await bounded(outcome, `${method} ${phase} bounded cleanup`);
        if (mode === 'deferred') {
          assert.equal(error.code, 'CODEX_START_ABORTED');
          assert.equal(child.wrapperTerminations, 0);
        } else {
          assert.equal(error.code, 'CODEX_START_CLEANUP_UNPROVEN');
          assert.notEqual(error.name, 'AbortError');
          assert.equal(error.cause.code, 'CODEX_START_ABORTED');
          assert.equal(typeof error.retryCleanup, 'function');
          assert.equal(Object.keys(error).includes('retryCleanup'), false, 'the owned cleanup handle is private');
          assert.equal(child.wrapperTerminations, 1, 'fallback is attempted without being counted as tree proof');
          if (mode === 'rejected') assert.equal(includesError(error, injectedError), true);
          if (mode !== 'timeout') {
            const spawnCount = observations.children.length;
            await assert.rejects(error.retryCleanup(), retryError => retryError.code === 'CODEX_START_CLEANUP_UNPROVEN');
            assert.equal(observations.children.length, spawnCount, 'retry must use the retained handle');
            child.fixtureOutcome.resolve({ type: 'exit', activeProcesses: 0, exitCode: 0 });
            await bounded(error.retryCleanup(), 'retained cleanup retry succeeds after a valid receipt');
          }
        }
        assert.equal(observations.children.length, phase === 'version' ? 1 : 2, 'cancelled version must never advance to app-server');
        process.stdout.write(`ok - ${method} ${phase} cleanup ${mode} preserves its owned outcome\n`);
      }
    }
  }

  const { api, observations } = withProtocolPeer();
  observations.stopped = 'version';
  observations.ready = Promise.withResolvers();
  const controller = new AbortController();
  const pending = api.detectCodexVersion({ command: 'offline-protocol-peer', signal: controller.signal });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  const child = await observations.ready.promise;
  controller.abort();
  const { error } = await bounded(outcome, 'standalone uncontained cleanup');
  assert.equal(error.code, 'CODEX_VERSION_CLEANUP_UNPROVEN');
  assert.equal(child.killCount, 1, 'the direct child is ended through its retained handle');
  assert.equal(typeof error.retryCleanup, 'function');
  await assert.rejects(error.retryCleanup(), retryError => retryError.code === 'CODEX_PROCESS_CLEANUP_UNPROVEN');
  process.stdout.write('ok - standalone uncontained version cleanup never claims descendant proof\n');
  await neverStartedReceiptConfirmation();
  await neverStartedOutcomeDuringWait();
}

async function neverStartedReceiptConfirmation() {
  const { createStartupCleanup } = require('../../src/lib/agent-engine/codex-startup-cleanup');
  function fixture(receipt, { terminationOnly = false, closeDuringFallback = false } = {}) {
    const child = new EventEmitter();
    const outcome = Promise.withResolvers();
    child.jobOutcome = outcome.promise;
    child.terminateJob = async () => {
      if (terminationOnly) return receipt;
      throw new Error('the pre-OWNER admission refusal is not a termination receipt');
    };
    child.terminateRetainedWrapper = async () => {
      if (closeDuringFallback) child.emit('close', 1, null);
      return { type: 'wrapper-terminated', activeProcesses: 0 };
    };
    const cleanup = createStartupCleanup(child);
    if (!terminationOnly) outcome.resolve(receipt);
    return { child, cleanup };
  }

  const neverStarted = { type: 'not-started', activeProcesses: 0, exitCode: 1 };
  const pending = fixture(neverStarted);
  await assert.rejects(pending.cleanup.confirm(100), { code: 'CODEX_PROCESS_CLEANUP_UNPROVEN' },
    'a claimed never-started outcome cannot prove cleanup before actual close');
  pending.child.emit('close', 1, null);
  assert.equal((await pending.cleanup.confirm(100)).type, 'not-started',
    'the same retained outcome is sufficient after actual close');

  const duringFallback = fixture(neverStarted, { closeDuringFallback: true });
  assert.equal((await duringFallback.cleanup.confirm(100)).type, 'not-started',
    'a retained close arriving during fallback is not lost or confused with fallback proof');

  for (const [label, receipt, options] of [
    ['nonzero', { ...neverStarted, activeProcesses: 1 }],
    ['failed', { ...neverStarted, failure: new Error('fixture outcome is uncertain') }],
    ['termination-only', neverStarted, { terminationOnly: true }]
  ]) {
    const refused = fixture(receipt, options);
    refused.child.emit('close', 1, null);
    await assert.rejects(refused.cleanup.confirm(100), { code: 'CODEX_PROCESS_CLEANUP_UNPROVEN' },
      `${label} cannot substitute for a valid retained never-started outcome`);
  }
  process.stdout.write('ok - never-started cleanup requires retained zero-process evidence and actual close; nonzero, failure and wrong-channel claims refuse\n');
}

async function neverStartedOutcomeDuringWait() {
  const { createStartupCleanup } = require('../../src/lib/agent-engine/codex-startup-cleanup');
  for (const stage of ['termination', 'fallback']) {
    for (const order of ['outcome-first', 'close-first']) {
      const child = new EventEmitter();
      const retainedOutcome = Promise.withResolvers();
      const termination = Promise.withResolvers();
      const fallback = Promise.withResolvers();
      const requested = Promise.withResolvers();
      child.jobOutcome = retainedOutcome.promise;
      child.terminateJob = () => {
        if (stage === 'fallback') return Promise.reject(new Error('fixture control request failed'));
        requested.resolve();
        return termination.promise;
      };
      child.terminateRetainedWrapper = () => { requested.resolve(); return fallback.promise; };
      const cleanup = createStartupCleanup(child);
      let settled = false;
      const outcome = cleanup.confirm(2_000).then(
        receipt => { settled = true; return { receipt }; },
        error => { settled = true; return { error }; }
      );
      const record = () => retainedOutcome.resolve({ type: 'not-started', activeProcesses: 0, exitCode: 1 });
      const close = () => child.emit('close', 1, null);
      try {
        await bounded(requested.promise, 'never-started cleanup request pending');
        (order === 'outcome-first' ? record : close)();
        await delay(0);
        assert.equal(settled, false, `${order} alone cannot prove the refused root was never created`);
        (order === 'outcome-first' ? close : record)();
        const result = await bounded(outcome, `never-started evidence releases pending ${stage} (${order})`, 400);
        assert.equal(result.error, undefined);
        assert.equal(result.receipt.type, 'not-started');
        assert.equal(result.receipt.activeProcesses, 0);
      } finally {
        termination.resolve({ type: 'terminated', activeProcesses: 0 });
        fallback.resolve({ type: 'wrapper-terminated', activeProcesses: 0 });
        await bounded(outcome, 'never-started fixture cleanup');
      }
    }
  }
  process.stdout.write('ok - retained never-started outcome and actual close jointly release stalled requests in either event order\n');
}

async function cleanupOutcomeDuringWait() {
  for (const method of ['startCodexSession', 'resumeCodexSession']) {
    for (const phase of ['initialize', 'version']) {
      for (const stage of ['termination', 'fallback']) {
        const { api, observations } = withProtocolPeer();
        observations.stopped = phase;
        observations.ready = Promise.withResolvers();
        observations.cleanupStarted = Promise.withResolvers();
        const termination = Promise.withResolvers();
        const fallback = Promise.withResolvers();
        const fallbackStarted = Promise.withResolvers();
        observations.terminate = () => termination.promise;
        observations.fallback = () => { fallbackStarted.resolve(); return fallback.promise; };
        const controller = new AbortController();
        const pending = api[method]({
          command: 'offline-protocol-peer', cwd: process.cwd(), threadId: 'saved-thread',
          signal: controller.signal, startupTimeoutMs: 2_000, cleanupTimeoutMs: 2_000
        });
        let settled = false;
        const outcome = pending.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
        try {
          const child = await bounded(observations.ready.promise, `${method} ${phase} reached`);
          controller.abort();
          await bounded(observations.cleanupStarted.promise, 'termination requested');
          if (stage === 'fallback') {
            termination.reject(new Error('fixture control request failed'));
            await bounded(fallbackStarted.promise, 'fallback requested');
          }
          await delay(0);
          assert.equal(settled, false, 'a pending request alone cannot prove cleanup');
          child.finish();
          const startedAt = performance.now();
          child.fixtureOutcome.resolve({ type: 'exit', activeProcesses: 0, exitCode: 0 });
          const { error } = await bounded(outcome, 'the observed empty job releases startup before the request deadline', 400);
          assert.equal(error.code, 'CODEX_START_ABORTED');
          assert.equal(child.wrapperTerminations, stage === 'fallback' ? 1 : 0);
          process.stdout.write(`ok - ${method} ${phase}: empty job releases pending ${stage} in ${(performance.now() - startedAt).toFixed(1)}ms\n`);
        } finally {
          termination.resolve({ type: 'terminated', activeProcesses: 0, exitCode: 0 });
          fallback.resolve({ type: 'wrapper-terminated', activeProcesses: 0 });
          for (const child of observations.children) child.finish();
          await bounded(outcome, 'protocol fixture cleanup');
        }
      }
    }
  }

  const { createStartupCleanup } = require('../../src/lib/agent-engine/codex-startup-cleanup');
  for (const receipt of [
    { type: 'exit', activeProcesses: 1 },
    { type: 'wrapper-terminated', activeProcesses: 0 },
    { type: 'terminated', activeProcesses: 0, failure: new Error('unproven') },
    { type: 'exit' },
    null
  ]) {
    const child = new EventEmitter();
    child.jobOutcome = Promise.resolve(receipt);
    child.terminateJob = () => Promise.reject(new Error('fixture control request failed'));
    child.terminateRetainedWrapper = () => Promise.resolve({ type: 'wrapper-terminated', activeProcesses: 0 });
    await assert.rejects(createStartupCleanup(child).confirm(100), error => error.code === 'CODEX_PROCESS_CLEANUP_UNPROVEN');
  }
  process.stdout.write('ok - incomplete, failed, and wrapper-only status outcomes never prove an empty job\n');
}

async function realCleanupOutcome() {
  if (process.platform !== 'win32') {
    process.stdout.write('skip - real cleanup-outcome receipt requires Windows Jobs\n');
    return;
  }
  const { spawnInJob } = require('../../src/lib/windows-job-control');
  const { safeLaunchEnvironment } = require('../../src/lib/providers/subscription-launch-env');
  const { createStartupCleanup } = require('../../src/lib/agent-engine/codex-startup-cleanup');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cleanup-outcome-')));
  const pidFile = path.join(root, 'child.pid');
  const child = spawnInJob(process.execPath, [__filename, '--unresponsive-version-fixture', pidFile], {
    cwd: root, stdio: 'pipe', terminateDescendantsOnRootExit: true,
    env: {
      SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive,
      PATH: path.dirname(process.execPath), TEMP: root, TMP: root,
      USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root
    }
  }, { safeLaunchEnvironment, recordDirectory: path.join(root, 'jobs'), assemblyCacheDirectory: '' });
  child.on('error', () => {}); // The owned outcome/close promises carry any failure.
  const terminate = child.terminateJob.bind(child);
  const cleanup = createStartupCleanup(child);
  try {
    await bounded(child.jobReady, 'native job ready');
    await until(() => fs.existsSync(pidFile), 'native child running');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.equal(alive(pid), true);
    // Lose only the control-request completion. The real job is terminated
    // through its retained handle and its original status pipe is untouched.
    child.terminateJob = () => {
      terminate().catch(() => {});
      return new Promise(() => {});
    };
    const startedAt = performance.now();
    const receipt = await bounded(cleanup.confirm(5_000), 'native empty-job outcome releases cleanup', 1_000);
    const actual = await child.jobOutcome;
    assert.ok(['exit', 'terminated'].includes(actual.type));
    assert.equal(actual.activeProcesses, 0);
    assert.equal(receipt.type, actual.type);
    assert.equal(receipt.activeProcesses, actual.activeProcesses);
    assert.equal(alive(pid), false);
    process.stdout.write(`ok - real Windows Job status releases a stalled control completion in ${(performance.now() - startedAt).toFixed(1)}ms\n`);
  } finally {
    await bounded(terminate(), 'native fixture termination');
    const receipt = await bounded(child.jobOutcome, 'native fixture zero-process receipt');
    const closed = await bounded(child.jobClosed, 'native fixture wrapper closed');
    assert.ok(['exit', 'terminated'].includes(receipt.type) && receipt.activeProcesses === 0 && !receipt.failure);
    assert.equal(closed.failure, null);
    assert.equal(fs.realpathSync(root), root, 'remove only the same owned fixture directory');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function measureVersionContainment() {
  const { detectCodexVersion } = require('../../src/lib/agent-engine/codex-process');
  for (const contained of [false, true]) {
    const times = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = performance.now();
      assert.equal(await detectCodexVersion({
        command: process.execPath, args: [__filename, '--responding-version-fixture'], containProcessTree: contained
      }), 'codex-cli 0.153.0');
      times.push(Number((performance.now() - startedAt).toFixed(1)));
    }
    process.stdout.write(`version startup measurement (${contained ? 'contained' : 'direct'}): ${JSON.stringify(times)}ms\n`);
  }
}

async function editorForkImportCleanup() {
  for (const persistent of [false, true]) {
    const { api, observations } = withProtocolPeer();
    const failure = Object.assign(new Error('fixture source import removal failed'), { code: 'EDITOR_FORK_IMPORT_CLEANUP_FAILED' });
    const codexHome = path.join(process.cwd(), 'fixture-confined-home');
    let cleanups = 0, stillFails = true;
    const pending = api.forkCodexSession({
      command: 'offline-protocol-peer', cwd: process.cwd(), threadId: 'source-thread',
      sourcePath: path.join(process.cwd(), 'original-source.jsonl'),
      env: { CODEX_HOME: codexHome }, assertSource() {},
      stageSource() {
        const cleanup = () => { cleanups += 1; if (stillFails && (persistent || cleanups === 1)) throw failure; };
        cleanup.sourcePath = path.join(codexHome, 'sessions', 'selected.jsonl');
        return cleanup;
      }
    });
    const outcome = await pending.then(value => ({ value }), error => ({ error }));
    assert.ok(observations.methods.includes('thread/fork'), 'the provider fork must succeed before the injected cleanup failure');
    assert.equal(outcome.value, undefined, 'a cleanup refusal must not return a ready session');
    const child = observations.children.at(-1);
    assert.equal(child.jobTerminations, 1, 'failed startup closes the newly created provider tree');
    assert.equal(child.signalCode, 'SIGTERM', 'the peer is actually closed before rejection');
    if (persistent) {
      assert.equal(outcome.error.code, 'CODEX_START_CLEANUP_UNPROVEN');
      assert.ok(outcome.error.errors.includes(failure), 'import uncertainty is retained with the child cleanup gate');
      stillFails = false;
      await outcome.error.retryCleanup();
      assert.equal(cleanups, 3, 'retained Close retries the same import cleanup');
    } else {
      assert.equal(outcome.error, failure);
      assert.equal(cleanups, 2, 'the failed-start gate retries removal before refusing the start');
    }
  }
  process.stdout.write('ok - successful fork followed by import cleanup failure closes its provider and retains cleanup uncertainty\n');
}

async function main() {
  if (process.argv.includes('--protocol-startup-only')) return protocolStartupCancellation();
  if (process.argv.includes('--editor-fork-cleanup-only')) return editorForkImportCleanup();
  if (process.argv.includes('--cleanup-outcome-only')) return cleanupOutcomeDuringWait();
  if (process.argv.includes('--real-cleanup-outcome-only')) return realCleanupOutcome();
  if (process.argv.includes('--cleanup-confirmation-only')) return cleanupConfirmation();
  if (process.argv.includes('--measure-version-containment')) return measureVersionContainment();
  await realVersionCancellation();
  await protocolStartupCancellation();
  await editorForkImportCleanup();
  await cleanupConfirmation();
  await cleanupOutcomeDuringWait();
  await realCleanupOutcome();
}
