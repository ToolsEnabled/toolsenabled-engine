'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const launcherPath = require.resolve('../sidecars/native-agent/src/native-agent-launcher.js');
const originalSpawn = childProcess.spawn;
let spawnCalls = 0;
let nativeFixtureScript = null;
let observeNativeFixture = child => child;
childProcess.spawn = (...args) => {
  spawnCalls += 1;
  if (nativeFixtureScript && args[0] === process.execPath && args[1][0] === '--print') {
    return observeNativeFixture(originalSpawn(args[0], [nativeFixtureScript, ...args[1]], args[2]));
  }
  return originalSpawn(...args);
};
delete require.cache[launcherPath];

const {
  NativeAgentLaunchError,
  assertRegistryUsable,
  evaluateAcceptance,
  resolveNativeAgentExecutable,
  runNativeAgent
} = require(launcherPath);

function assertRefusal(action, code) {
  const before = spawnCalls;
  assert.throws(action, error => {
    assert(error instanceof NativeAgentLaunchError);
    assert.equal(error.code, code);
    assert.equal(typeof error.message, 'string');
    assert(error.message.length > 0);
    return true;
  });
  assert.equal(spawnCalls, before, `${code} must refuse before spawning`);
}

function acceptance(outcome, expected) {
  const before = spawnCalls;
  const actual = evaluateAcceptance(outcome);
  assert.deepEqual(actual, expected);
  assert.equal(spawnCalls, before, `${expected.code} must not spawn`);
}

const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'native-agent-refusals-'));
try {
  assertRefusal(
    () => resolveNativeAgentExecutable({ env: { NATIVE_AGENT_CLAUDE_EXE: path.join(fixtures, 'missing') } }),
    'NATIVE_AGENT_EXECUTABLE_OVERRIDE_MISSING'
  );

  const unavailableFs = {
    readdirSync() { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    lstatSync() { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
  };
  assertRefusal(
    () => resolveNativeAgentExecutable({ env: {}, homeDirectory: fixtures, fsImpl: unavailableFs }),
    'NATIVE_AGENT_EXECUTABLE_UNAVAILABLE'
  );

  assertRefusal(() => runNativeAgent({ maxTurns: 0 }), 'NATIVE_AGENT_MAX_TURNS_INVALID');

  const cancelled = new AbortController();
  cancelled.abort();
  const savedOverride = process.env.NATIVE_AGENT_CLAUDE_EXE;
  process.env.NATIVE_AGENT_CLAUDE_EXE = path.join(fixtures, 'cancelled-missing-executable');
  try {
    assertRefusal(() => runNativeAgent({ objective: 'Must never launch.', signal: cancelled.signal }),
      'NATIVE_AGENT_CANCELLED');
  } finally {
    if (savedOverride === undefined) delete process.env.NATIVE_AGENT_CLAUDE_EXE;
    else process.env.NATIVE_AGENT_CLAUDE_EXE = savedOverride;
  }

  process.env.NATIVE_AGENT_CLAUDE_EXE = process.execPath;
  try {
    for (const transition of ['cancelled', 'fence-lost']) {
      const controller = new AbortController();
      let configFile;
      let guardCalls = 0;
      const expected = transition === 'cancelled' ? 'NATIVE_AGENT_CANCELLED' : 'NATIVE_AGENT_TEST_FENCE_LOST';
      assertRefusal(() => runNativeAgent({
        objective: 'Must not cross the final launch guard.', signal: controller.signal,
        onEvent(event) {
          if (event.decision !== 'launch') return;
          configFile = event.mcpConfig;
          assert.equal(fs.existsSync(configFile), true, 'exercise the guard after runtime config construction');
          if (transition === 'cancelled') controller.abort();
        },
        beforeLaunch() {
          guardCalls += 1;
          if (transition === 'fence-lost') throw new NativeAgentLaunchError(expected, 'The current durable claim was replaced.');
        }
      }), expected);
      assert.equal(guardCalls, 1);
      assert.equal(fs.existsSync(configFile), false, 'a refused final launch must remove its runtime config');
    }
  } finally {
    if (savedOverride === undefined) delete process.env.NATIVE_AGENT_CLAUDE_EXE;
    else process.env.NATIVE_AGENT_CLAUDE_EXE = savedOverride;
  }

  const unreadable = path.join(fixtures, 'absent.json');
  assertRefusal(() => assertRegistryUsable(unreadable), 'NATIVE_AGENT_MCP_CONFIG_UNREADABLE');

  const invalid = path.join(fixtures, 'invalid.json');
  fs.writeFileSync(invalid, '{}');
  assertRefusal(() => assertRegistryUsable(invalid), 'NATIVE_AGENT_MCP_CONFIG_INVALID');

  const restricted = path.join(fixtures, 'restricted.json');
  fs.writeFileSync(restricted, JSON.stringify({
    mcpServers: { toolsenabled: { command: process.execPath, args: [launcherPath], env: { TOOLSENABLED_TOOL_ALLOWLIST: 'one' } } }
  }));
  assertRefusal(() => assertRegistryUsable(restricted), 'NATIVE_AGENT_MCP_CONFIG_RESTRICTED');

  const missingPath = path.join(fixtures, 'missing-path.json');
  fs.writeFileSync(missingPath, JSON.stringify({
    mcpServers: { toolsenabled: { command: process.execPath, args: [path.join(fixtures, 'not-there.js')] } }
  }));
  assertRefusal(() => assertRegistryUsable(missingPath), 'NATIVE_AGENT_MCP_CONFIG_PATH_MISSING');

  acceptance({}, {
    passed: false,
    code: 'ACCEPTANCE_NO_EVIDENCE',
    detail: 'The agent never invoked mcp__toolsenabled__host_exec, so its tool set is unproven.',
    toolCount: null,
    hostExecPresent: null
  });
  acceptance({ hostExecInvoked: true }, {
    passed: false,
    code: 'ACCEPTANCE_NO_EVIDENCE',
    detail: 'The agent invoked host.exec but no profile evidence reached the transcript.',
    toolCount: null,
    hostExecPresent: null
  });
  acceptance({ evidence: { hostExecPresent: false, toolCount: 297 } }, {
    passed: false,
    code: 'ACCEPTANCE_HOST_EXEC_ABSENT',
    detail: 'The agent profile does not contain host.exec.',
    toolCount: 297,
    hostExecPresent: false
  });
  acceptance({ evidence: { hostExecPresent: true, allowlistPresent: true, toolCount: 297 } }, {
    passed: false,
    code: 'ACCEPTANCE_PROFILE_RESTRICTED',
    detail: 'The agent inherited a narrowed tool allowlist instead of the full local profile.',
    toolCount: 297,
    hostExecPresent: true
  });
  acceptance({ evidence: { hostExecPresent: true, allowlistPresent: false, toolCount: 99 } }, {
    passed: false,
    code: 'ACCEPTANCE_TOOL_COUNT_IMPLAUSIBLE',
    detail: 'The reported tool count is not a full local profile.',
    toolCount: 99,
    hostExecPresent: true
  });
  acceptance({ hostExecInvoked: false, evidence: { hostExecPresent: true, allowlistPresent: false, toolCount: 297 } }, {
    passed: false,
    code: 'ACCEPTANCE_EVIDENCE_UNATTRIBUTED',
    detail: 'Profile evidence appeared without an observed host.exec tool call.',
    toolCount: 297,
    hostExecPresent: true
  });
  acceptance({ hostExecInvoked: true, evidence: { hostExecPresent: true, allowlistPresent: false, toolCount: 297, profile: 'full' } }, {
    passed: true,
    code: 'ACCEPTANCE_PASSED',
    detail: 'The agent proved a full local profile through its own host.exec tool.',
    toolCount: 297,
    hostExecPresent: true,
    profile: 'full'
  });
} finally {
  childProcess.spawn = originalSpawn;
  fs.rmSync(fixtures, { recursive: true, force: true });
}

console.log('native agent launcher refusals: 16 cases driven without an unintended spawn');

async function testNativeRunningLifetimes() {
  if (!['linux', 'win32'].includes(process.platform)) return;
  const { getEventListeners } = require('node:events');
  const { spawnHidden } = require('../src/lib/proc/hidden-spawn');
  const { root } = require('./lib/isolated-environment').activate('native-running-lifetime');
  const directory = fs.mkdtempSync(path.join(root, 'native-lifetime-'));
  const oldExecutable = process.env.NATIVE_AGENT_CLAUDE_EXE;
  const oldCredential = process.env.aNtHrOpIc_ApI_kEy;
  const oldCanary = process.env.NATIVE_LIFETIME_CONTROL;
  const actualSetTimeout = global.setTimeout;
  const sleep = ms => new Promise(resolve => actualSetTimeout(resolve, ms));
  // The timeout starts before native ownership, root, and detached-leaf cold start.
  // Match the proven Windows allowance so Linux reaches the real lifetime contract.
  const limit = 10000;
  const timer = (callback, delay, ...args) => actualSetTimeout(callback, delay === 60000 ? limit : delay, ...args);
  process.env.NATIVE_AGENT_CLAUDE_EXE = process.execPath;
  process.env.aNtHrOpIc_ApI_kEy = 'isolated-native-credential-canary';
  process.env.NATIVE_LIFETIME_CONTROL = 'must-survive';
  global.setTimeout = timer;
  let checks = 0;
  try {
    for (const mode of ['success', 'cancel', 'timeout', 'nonzero']) {
      const marker = path.join(directory, `${mode}.effects`), done = path.join(directory, `${mode}.done`);
      const environmentReceipt = path.join(directory, `${mode}.environment.json`);
      const leaf = path.join(directory, `${mode}.leaf.cjs`);
      nativeFixtureScript = path.join(directory, `${mode}.root.cjs`);
      fs.writeFileSync(leaf, `const fs=require('node:fs');const marker=${JSON.stringify(marker)};
        fs.writeFileSync(marker,'started\\n');const timer=setInterval(()=>fs.appendFileSync(marker,'effect\\n'),20);
        setTimeout(()=>{clearInterval(timer);fs.writeFileSync(${JSON.stringify(done)},'done');},${mode === 'timeout' ? limit + 1000 : 1000});`);
      fs.writeFileSync(nativeFixtureScript, `const fs=require('node:fs');const {spawn}=require('node:child_process');
        fs.writeFileSync(${JSON.stringify(environmentReceipt)},JSON.stringify({credentialNames:Object.keys(process.env).filter(name=>/^anthropic_api_key$/i.test(name)),canary:process.env.NATIVE_LIFETIME_CONTROL}));
        const leaf=spawn(process.execPath,[${JSON.stringify(leaf)}],{detached:true,stdio:'ignore',windowsHide:true});leaf.unref();
        const ready=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(marker)}))return;clearInterval(ready);
          process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'fixture'})+'\\n',()=>{
            ${['success', 'nonzero'].includes(mode) ? `process.exit(${mode === 'nonzero' ? 7 : 0});` : ''}});},5);
        setTimeout(()=>process.exit(0),${limit + 1500});`);
      let child, closed = false, rootClosed, configFile;
      observeNativeFixture = value => {
        child = value;
        rootClosed = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
        child.on('error', () => {});
        return child;
      };
      const controller = new AbortController();
      const events = [];
      try {
        const pending = runNativeAgent({ objective: 'Isolated native lifetime canary.', timeoutMs: 60000,
          signal: controller.signal,
          onEvent(event) { events.push(event); if (event.decision === 'launch') configFile = event.mcpConfig; }
        }, {
          setTimeoutImpl: timer,
          spawnImpl(file, args, options) {
            assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
            assert.equal(args[args.indexOf('--mcp-config') + 1], configFile);
            assert.equal(fs.existsSync(configFile), true);
            return observeNativeFixture(spawnHidden(file, [nativeFixtureScript, ...args], options));
          }
        });
        if (mode === 'cancel') {
          const deadline = Date.now() + 20000;
          while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(10);
          assert.equal(fs.existsSync(marker), true, 'cancel only after a real descendant is running');
          controller.abort();
        }
        const result = await pending;
        assert.equal(fs.existsSync(marker), true, `${mode}: a descendant really ran`);
        assert.deepEqual(JSON.parse(fs.readFileSync(environmentReceipt, 'utf8')), { credentialNames: [], canary: 'must-survive' },
          'the real native process must preserve subscription credential scrubbing');
        const atReturn = fs.readFileSync(marker, 'utf8');
        await sleep(180);
        assert.equal(fs.readFileSync(marker, 'utf8'), atReturn, `${mode}: descendants must stop before terminal outcome`);
        assert.equal(result.cleanupConfirmed, true);
        assert.equal(result.ok, mode === 'success');
        assert.equal(result.code, { success: null, cancel: 'NATIVE_AGENT_CANCELLED',
          timeout: 'NATIVE_AGENT_TIMEOUT', nonzero: 'NATIVE_AGENT_NONZERO_EXIT' }[mode]);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'retire the abort listener with the native scope');
        const eventCount = events.length;
        controller.abort();
        await sleep(10);
        assert.equal(events.length, eventCount, 'a late abort cannot re-enter a terminal launcher');
        assert.equal(fs.existsSync(configFile), false, 'remove the runtime config after cleanup');
        const outcome = await child.jobOutcome;
        assert.equal(outcome.activeProcesses, 0);
        assert.equal((await child.jobClosed).failure, null);
        if (mode === 'nonzero') assert.equal(result.exitCode, 7, 'native root exit is distinct from wrapper exit');
        if (process.platform === 'linux') {
          assert.ok(outcome.observedChildren >= 2);
          assert.equal(outcome.reapedChildren, outcome.observedChildren);
        }
        checks += 1;
      } finally {
        if (child?.jobOutcome) {
          if (!closed) await child.terminateJob().catch(() => {});
          await child.jobClosed;
        } else if (child) {
          const deadline = Date.now() + limit + 2000;
          while (!fs.existsSync(done) && Date.now() < deadline) await sleep(20);
          assert.equal(fs.existsSync(done), true, 'the baseline detached canary must self-terminate');
          await sleep(80);
          if (!closed) child.kill('SIGTERM');
        }
        if (rootClosed) await rootClosed;
      }
    }
    nativeFixtureScript = null;
    for (const transition of ['cancelled', 'fence-lost']) {
      const marker = path.join(directory, `${transition}.forbidden-root`);
      const script = path.join(directory, `${transition}.guard-root.cjs`);
      fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');`);
      const controller = new AbortController();
      const order = [];
      let child, afterWrapperReady = false, configFile;
      try {
        const result = await runNativeAgent({ objective: 'Refuse a claim changed while the native wrapper prepares.',
          timeoutMs: 60000, signal: controller.signal,
          onEvent(event) { if (event.decision === 'launch') configFile = event.mcpConfig; },
          beforeLaunch() {
            order.push(afterWrapperReady ? 'root-guard' : 'initial-guard');
            if (afterWrapperReady && transition === 'fence-lost') {
              throw new NativeAgentLaunchError('NATIVE_AGENT_TEST_FENCE_LOST', 'The claim changed during native wrapper preparation.');
            }
          }
        }, {
          spawnImpl(file, args, options) {
            const admission = options.rootLaunch;
            order.push('wrapper-requested');
            child = spawnHidden(file, [script, ...args], { ...options, rootLaunch: {
              beforeRootSpawn() {
                assert.ok(child, 'the real native wrapper must be retained before its asynchronous readiness callback');
                order.push('wrapper-ready');
                afterWrapperReady = true;
                if (transition === 'cancelled') controller.abort();
                admission?.beforeRootSpawn();
              },
              spawned(retained) { order.push('wrapper-retained'); admission?.spawned(retained); }
            } });
            return child;
          }
        });
        assert.equal(fs.existsSync(marker), false, `${transition}: a changed claim must not launch the root after wrapper preparation`);
        assert.deepEqual(order, ['initial-guard', 'wrapper-requested', 'wrapper-retained', 'wrapper-ready', 'root-guard']);
        assert.equal(result.ok, false);
        assert.equal(result.cleanupConfirmed, process.platform === 'linux',
          'preserve Windows wrapper failure even when admission proves the root never started');
        if (process.platform === 'win32') assert.equal(result.code, 'NATIVE_AGENT_CLEANUP_UNPROVEN');
        assert.equal(fs.existsSync(configFile), false);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        const receipt = await child.jobOutcome;
        assert.equal(receipt.type, 'not-started');
        assert.equal(receipt.activeProcesses, 0);
        const closure = await child.jobClosed;
        if (process.platform === 'linux') {
          assert.equal(closure.failure, null);
          assert.equal(receipt.observedChildren, 0);
        } else {
          assert.equal(closure.failure?.code, 'WINDOWS_JOB_LAUNCH_REFUSED');
        }
        checks += 1;
      } finally {
        if (child) {
          await child.terminateJob().catch(() => {});
          await child.jobClosed;
        }
      }
    }
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const deferred = () => {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      return { promise, resolve, reject };
    };
    for (const kind of ['closure', 'live-descendant', 'control-refused', 'deadline']) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const receipt = deferred(), wrapper = deferred(), control = deferred();
      child.jobOutcome = receipt.promise;
      child.jobClosed = wrapper.promise;
      child.terminateJob = () => control.promise;
      let fallbackCalls = 0;
      child.terminateRetainedWrapper = async () => { fallbackCalls += 1; };
      const controller = new AbortController();
      const events = [], raw = [];
      let answered = false, configFile;
      const pending = runNativeAgent({ objective: 'Bounded native cleanup receipt fixture.', timeoutMs: 60000,
        signal: controller.signal,
        onEvent(event) { events.push(event); if (event.decision === 'launch') configFile = event.mcpConfig; },
        onRawLine: line => raw.push(line)
      }, { spawnImpl: () => child, cleanupTimeoutMs: 50 }).then(result => { answered = true; return result; });
      const empty = { type: 'exit', exitCode: 7, activeProcesses: 0 };
      if (kind === 'deadline') {
        controller.abort();
      } else {
        if (kind === 'control-refused') {
          controller.abort();
          control.reject(Object.assign(new Error('Fixture refusal.'), { code: 'FIXTURE_CONTROL_REFUSED' }));
        }
        receipt.resolve({ ...empty, activeProcesses: kind === 'live-descendant' ? 1 : 0 });
        child.emit('close', 0);
        await sleep(5);
        assert.equal(answered, false, 'native scope observation must still wait for wrapper closure');
        assert.equal(fs.existsSync(configFile), true, 'retain the runtime config until cleanup resolves');
        wrapper.resolve({ failure: null });
      }
      const result = await pending;
      assert.equal(result.cleanupConfirmed, kind === 'closure');
      assert.equal(result.code, kind === 'closure' ? 'NATIVE_AGENT_NONZERO_EXIT' : 'NATIVE_AGENT_CLEANUP_UNPROVEN');
      if (kind === 'closure') assert.equal(result.exitCode, 7);
      if (kind === 'control-refused') assert.equal(result.cleanupFailureCode, 'FIXTURE_CONTROL_REFUSED');
      if (kind === 'deadline') {
        assert.equal(result.cleanupFailureCode, 'NATIVE_AGENT_CLEANUP_DEADLINE');
        control.resolve(empty); receipt.resolve(empty); wrapper.resolve({ failure: null }); child.emit('close', 0);
        await sleep(5);
      }
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      const afterTerminal = events.length;
      controller.abort();
      child.stdout.write(JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'mcp__toolsenabled__host_exec' }] } }) + '\n');
      await sleep(5);
      assert.equal(events.length, afterTerminal, 'late cancellation/output cannot re-enter a terminal run');
      assert.equal(raw.length, 0);
      assert.equal(events.filter(event => event.decision === 'launch_settled').length, 1);
      assert.equal(fs.existsSync(configFile), false);
      if (kind !== 'closure') assert.ok(fallbackCalls > 0, 'unknown custody still attempts retained cleanup');
      checks += 1;
    }
  } finally {
    nativeFixtureScript = null;
    global.setTimeout = actualSetTimeout;
    if (oldExecutable === undefined) delete process.env.NATIVE_AGENT_CLAUDE_EXE;
    else process.env.NATIVE_AGENT_CLAUDE_EXE = oldExecutable;
    if (oldCredential === undefined) delete process.env.aNtHrOpIc_ApI_kEy;
    else process.env.aNtHrOpIc_ApI_kEy = oldCredential;
    if (oldCanary === undefined) delete process.env.NATIVE_LIFETIME_CONTROL;
    else process.env.NATIVE_LIFETIME_CONTROL = oldCanary;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`native agent running lifetimes: ${checks} cases passed (4 real process trees, 2 native admission orderings, 4 cleanup receipt orderings)`);
}

testNativeRunningLifetimes().catch(error => { console.error(error); process.exitCode = 1; });
