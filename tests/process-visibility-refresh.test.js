// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-process-visibility-refresh-test-js):
// - Strengthened the failed-receipt, argument-refusal, and unknown-receipt CLI
//   assertions to require exactly one write.  Mutating the CLI in a scratch
//   edit to call write('') immediately before its real write left the original
//   suite GREEN ("process-visibility-refresh: 13 checks passed").  With each
//   new assertion enabled, the corresponding mutation went RED:
//     "AssertionError [ERR_ASSERTION]: CLI must emit exactly one receipt
//      2 !== 1" (failed receipt, line 114)
//     "AssertionError [ERR_ASSERTION]: CLI must emit exactly one refusal receipt
//      2 !== 1" (argument refusal, line 251)
//     "AssertionError [ERR_ASSERTION]: CLI must emit exactly one receipt
//      2 !== 1" (unknown receipt, line 266)
// - NOT-FOUND (1): no assertion iterates a possibly empty collection; all four
//   loops use non-empty array literals.  The new write-count checks are scalar.
// - NOT-FOUND (2): exit-status assertions are paired with exact parsed output;
//   none relies on non-zero or truthiness alone.
// - NOT-FOUND (3): no optional chain swallows a failure.  The only try/finally
//   restores require.cache and has no catch.
// - NOT-FOUND (4): dependency fakes drive boundaries, but no assertion compares
//   the subject with a mock implementation of that same subject.
// - NOT-FOUND (5): the file has no skip or platform precondition guard.
// - NOT-FOUND (6): expected receipts and counts are literal, not computed by
//   the production code being checked.
// - Preconditions: none unmet.  Restored tools/process-visibility-refresh.js
//   byte-for-byte (SHA-256 54b426abf3bf2c4409dba2d7ed6b75852cdd99472f974b794026145a361c09ae).
//   The restored run was GREEN: "process-visibility-refresh: 13 checks passed".
'use strict';

const assert = require('node:assert/strict');

const refresh = require('../src/lib/supervision/process-visibility-refresh.js');
const cli = require('../tools/process-visibility-refresh.js');

// Exercise the otherwise real default UAC runner without ever reaching the
// task scheduler or pipe.  This is deliberately scoped to a fresh module
// instance so the production module retains no general-purpose dependency
// injection surface.
async function withDefaultRunner(defaultRunner, fn) {
  const refreshPath = require.resolve('../src/lib/supervision/process-visibility-refresh.js');
  const clientPath = require.resolve('../src/lib/uac-delegation-client.js');
  const savedRefresh = require.cache[refreshPath];
  const savedClient = require.cache[clientPath];
  delete require.cache[refreshPath];
  require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: Object.freeze({ runOperation: defaultRunner })
  };
  let isolated;
  try {
    isolated = require(refreshPath);
    return await fn(isolated);
  } finally {
    delete require.cache[refreshPath];
    if (savedRefresh) require.cache[refreshPath] = savedRefresh;
    if (savedClient) require.cache[clientPath] = savedClient;
  }
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

process.stdout.write('process-visibility-refresh\n');

(async () => {
  await check('invokes only the fixed collector exactly once and returns a frozen safe success receipt', async () => {
    const calls = [];
    const receipt = await refresh.refreshProcessVisibility({
      runOperation: async (...args) => {
        calls.push(args);
        return { ok: true, decision: 'accept', helperStarted: true, outcome: { steps: [{ executable: 'leak.exe', error: 'secret' }] } };
      }
    });
    assert.deepEqual(calls, [[refresh.OPERATION_ID]]);
    assert.deepEqual(receipt, {
      operationId: 'collect-process-visibility',
      status: 'refreshed',
      code: 'PROCESS_VISIBILITY_REFRESHED',
      helperStarted: true
    });
    assert.equal(Object.isFrozen(receipt), true);
  });

  await check('refusal is terminal, sanitized, and is not retried', async () => {
    let calls = 0;
    const receipt = await refresh.refreshProcessVisibility({
      runOperation: async () => { calls += 1; return { ok: false, decision: 'refuse', reason: 'token', outcome: { error: 'do not expose' } }; }
    });
    assert.equal(calls, 1);
    assert.deepEqual(receipt, {
      operationId: 'collect-process-visibility',
      status: 'refused',
      code: 'PROCESS_VISIBILITY_REFRESH_REFUSED'
    });
    assert.equal(JSON.stringify(receipt).includes('token'), false);
  });

  await check('accepted failed outcome is terminal and does not expose helper diagnostics', async () => {
    const receipt = await refresh.refreshProcessVisibility({
      runOperation: async () => ({ ok: false, decision: 'accept', outcome: { error: 'C:\\secret\\state.json' } })
    });
    assert.deepEqual(receipt, {
      operationId: 'collect-process-visibility',
      status: 'failed',
      code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
    });
    assert.equal(JSON.stringify(receipt).includes('state.json'), false);
  });

  await check('ok result without a started helper fails closed once and cannot produce a CLI success exit', async () => {
    let calls = 0;
    let receipt;
    for (const helperStarted of [undefined, false, 1, 'true', null]) {
      receipt = await refresh.refreshProcessVisibility({
        runOperation: async () => {
          calls += 1;
          return { ok: true, helperStarted };
        }
      });
      assert.deepEqual(receipt, {
        operationId: 'collect-process-visibility',
        status: 'failed',
        code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
      });
    }
    assert.equal(calls, 5);

    const output = [];
    const code = await cli.main([], {
      refreshProcessVisibility: async () => receipt,
      write: value => output.push(value)
    });
    assert.equal(code, 1);
    assert.equal(output.length, 1, 'CLI must emit exactly one receipt');
    assert.deepEqual(JSON.parse(output.join('')), receipt);
  });

  await check('timeout remains unknown and is never retried', async () => {
    let calls = 0;
    const timeout = Object.assign(new Error('must not leak'), { outcomeUnknown: true, code: 'UAC_CLIENT_TIMEOUT' });
    const receipt = await refresh.refreshProcessVisibility({
      runOperation: async () => { calls += 1; throw timeout; }
    });
    assert.equal(calls, 1);
    assert.deepEqual(receipt, {
      operationId: 'collect-process-visibility',
      status: 'unknown',
      code: 'PROCESS_VISIBILITY_REFRESH_UNKNOWN',
      outcomeUnknown: true
    });
  });

  await check('ordinary client failure is sanitized and cannot expose error text', async () => {
    const receipt = await refresh.refreshProcessVisibility({
      runOperation: async () => { throw new Error('C:\\vault\\must-not-appear'); }
    });
    assert.deepEqual(receipt, {
      operationId: 'collect-process-visibility',
      status: 'failed',
      code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
    });
  });

  await check('null and non-client public inputs produce a typed sanitized failure without invoking collection', async () => {
    for (const input of [null, 'not-an-options-object', 7, [], new Date()]) {
      const receipt = await refresh.refreshProcessVisibility(input);
      assert.deepEqual(receipt, {
        operationId: 'collect-process-visibility',
        status: 'failed',
        code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
      });
    }
  });

  await check('fulfilled hostile result getters preserve uncertainty inside the sanitizing boundary', async () => {
    const hostile = new Proxy({}, {
      // Promise resolution reads `then` before it can fulfil with an object.
      // Let that one protocol probe through so the hostile getter is exercised
      // by refreshProcessVisibility's result-classification boundary rather
      // than turning this into an ordinary rejected-runner case.
      get(_target, property) {
        if (property === 'then') return undefined;
        throw new Error('C:\\vault\\must-not-appear');
      }
    });
    const receipt = await refresh.refreshProcessVisibility({ runOperation: async () => hostile });
    assert.deepEqual(receipt, {
      operationId: 'collect-process-visibility',
      status: 'unknown',
      code: 'PROCESS_VISIBILITY_REFRESH_UNKNOWN',
      outcomeUnknown: true
    });
    assert.equal(JSON.stringify(receipt).includes('vault'), false);
  });

  await check('hostile rejection metadata cannot collapse an unmeasured outcome into failure', async () => {
    const hostile = new Proxy(new Error('must not leak'), {
      get(target, property, receiver) {
        if (property === 'outcomeUnknown') throw new Error('C:\\vault\\must-not-appear');
        return Reflect.get(target, property, receiver);
      }
    });
    const receipt = await refresh.refreshProcessVisibility({
      runOperation: async () => { throw hostile; }
    });
    assert.deepEqual(receipt, {
      operationId: 'collect-process-visibility',
      status: 'unknown',
      code: 'PROCESS_VISIBILITY_REFRESH_UNKNOWN',
      outcomeUnknown: true
    });
    assert.equal(JSON.stringify(receipt).includes('vault'), false);
  });

  await check('the test-only options seam rejects unknown selectors and getters without collection', async () => {
    let calls = 0;
    const runner = async () => { calls += 1; return { ok: true }; };
    for (const input of [
      { runOperation: runner, retry: 1 },
      { runOperation: runner, snapshot: 'C:\\vault\\state.json' },
      Object.defineProperty({}, 'runOperation', { enumerable: true, get() { throw new Error('C:\\vault\\getter'); } })
    ]) {
      const receipt = await refresh.refreshProcessVisibility(input);
      assert.deepEqual(receipt, {
        operationId: 'collect-process-visibility',
        status: 'failed',
        code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
      });
    }
    assert.equal(calls, 0);
  });

  await check('hidden and symbolic own properties cannot select the default UAC client or invoke accessors', async () => {
    let defaultCalls = 0;
    let getterCalls = 0;
    await withDefaultRunner(async () => {
      defaultCalls += 1;
      return { ok: true, helperStarted: true };
    }, async isolated => {
      const runner = async () => { throw new Error('must not run'); };
      const hiddenRetry = Object.defineProperty({ runOperation: runner }, 'retry', {
        value: 1, enumerable: false
      });
      const hiddenAccessor = Object.defineProperty({}, 'runOperation', {
        get() { getterCalls += 1; throw new Error('C:\\vault\\getter'); }
      });
      const hiddenDataRunner = Object.defineProperty({}, 'runOperation', {
        value: runner, enumerable: false
      });
      const symbolicSelector = Object.defineProperty({ runOperation: runner }, Symbol('retry'), {
        value: 1, enumerable: false
      });
      for (const input of [hiddenRetry, hiddenAccessor, hiddenDataRunner, symbolicSelector]) {
        assert.deepEqual(await isolated.refreshProcessVisibility(input), {
          operationId: 'collect-process-visibility',
          status: 'failed',
          code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
        });
      }
    });
    assert.equal(defaultCalls, 0, 'hidden fields must not fall through to the default UAC runner');
    assert.equal(getterCalls, 0, 'untrusted runOperation accessors must never execute');
  });

  await check('own-key and descriptor traps fail closed without invoking the default UAC client', async () => {
    let defaultCalls = 0;
    await withDefaultRunner(async () => {
      defaultCalls += 1;
      return { ok: true };
    }, async isolated => {
      const ownKeysTrap = new Proxy({}, {
        ownKeys() { throw new Error('C:\\vault\\own-keys'); }
      });
      const descriptorTrap = new Proxy({}, {
        ownKeys() { return ['runOperation']; },
        getOwnPropertyDescriptor() { throw new Error('C:\\vault\\descriptor'); }
      });
      for (const input of [ownKeysTrap, descriptorTrap]) {
        assert.deepEqual(await isolated.refreshProcessVisibility(input), {
          operationId: 'collect-process-visibility',
          status: 'failed',
          code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
        });
      }
    });
    assert.equal(defaultCalls, 0);
  });

  await check('CLI refuses every argument before attempting collection', async () => {
    let called = false;
    const output = [];
    const code = await cli.main(['other-operation'], {
      refreshProcessVisibility: async () => { called = true; return { status: 'refreshed' }; },
      write: value => output.push(value)
    });
    assert.equal(code, 1);
    assert.equal(called, false);
    assert.equal(output.length, 1, 'CLI must emit exactly one refusal receipt');
    assert.deepEqual(JSON.parse(output.join('')), {
      status: 'refused',
      code: 'PROCESS_VISIBILITY_REFRESH_ARGS_REFUSED',
      operationId: 'collect-process-visibility'
    });
  });

  await check('CLI maps only the sanitized receipt status to its exit code', async () => {
    const output = [];
    const code = await cli.main([], {
      refreshProcessVisibility: async () => Object.freeze({ operationId: refresh.OPERATION_ID, status: 'unknown', code: 'PROCESS_VISIBILITY_REFRESH_UNKNOWN', outcomeUnknown: true }),
      write: value => output.push(value)
    });
    assert.equal(code, 2);
    assert.equal(output.length, 1, 'CLI must emit exactly one receipt');
    assert.deepEqual(JSON.parse(output.join('')), {
      operationId: 'collect-process-visibility',
      status: 'unknown',
      code: 'PROCESS_VISIBILITY_REFRESH_UNKNOWN',
      outcomeUnknown: true
    });
  });

  process.stdout.write(`\nprocess-visibility-refresh: ${passed} checks passed\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
