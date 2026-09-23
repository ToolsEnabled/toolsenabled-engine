'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {
  OPERATION_ID,
  createProcessVisibilityRefreshControllerRoute,
  sanitizeReceipt
} = require('../src/lib/supervision/process-visibility-controller-route.js');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

// The local-coder HTTP server was retired. These checks cover the retained
// helper, not a deployed POST endpoint. The supported manual CLI has its own
// executable argument/receipt checks in process-visibility-refresh.test.js.
process.stdout.write('process-visibility-controller-route (retained helper; HTTP host retired)\n');

(async () => {
  await check('manual controller action invokes the fixed adapter exactly once with no arguments', async () => {
    const calls = [];
    const route = createProcessVisibilityRefreshControllerRoute({
      refreshProcessVisibility: async (...args) => {
        calls.push(args);
        return {
          operationId: OPERATION_ID,
          status: 'refreshed',
          code: 'PROCESS_VISIBILITY_REFRESHED',
          helperStarted: true,
          helperDiagnostics: 'C:\\vault\\must-not-leak'
        };
      }
    });
    assert.deepEqual(await route.invoke(), {
      operationId: OPERATION_ID,
      status: 'failed',
      code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
    }, 'unexpected upstream fields are rejected rather than stripped');
    assert.deepEqual(calls, [[]]);
  });

  await check('a valid fixed receipt is returned once as the complete sanitized result', async () => {
    let calls = 0;
    const route = createProcessVisibilityRefreshControllerRoute({
      refreshProcessVisibility: async (...args) => {
        calls += 1;
        assert.deepEqual(args, []);
        return Object.freeze({
          operationId: OPERATION_ID,
          status: 'refreshed',
          code: 'PROCESS_VISIBILITY_REFRESHED',
          helperStarted: true
        });
      }
    });
    const result = await route.invoke();
    assert.deepEqual(result, {
      operationId: OPERATION_ID,
      status: 'refreshed',
      code: 'PROCESS_VISIBILITY_REFRESHED',
      helperStarted: true
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(calls, 1);
  });

  await check('arguments and malformed receipts are refused without default or injected UAC execution', async () => {
    let calls = 0;
    const route = createProcessVisibilityRefreshControllerRoute({
      refreshProcessVisibility: async () => { calls += 1; return { unexpected: true }; }
    });
    assert.deepEqual(await route.invoke({ selector: 'anything' }), {
      operationId: OPERATION_ID,
      status: 'refused',
      code: 'PROCESS_VISIBILITY_REFRESH_ARGS_REFUSED'
    });
    assert.equal(calls, 0);
    assert.deepEqual(await route.invoke(), {
      operationId: OPERATION_ID,
      status: 'failed',
      code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
    });
    assert.equal(calls, 1, 'malformed adapter output does not retry the operation');
  });

  await check('hostile receipt accessors are contained and no path or helper data is returned', async () => {
    const hostile = {};
    Object.defineProperty(hostile, 'status', { enumerable: true, get() { throw new Error('C:\\vault\\must-not-leak'); } });
    const result = sanitizeReceipt(hostile);
    assert.deepEqual(result, {
      operationId: OPERATION_ID,
      status: 'failed',
      code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
    });
    assert.doesNotMatch(JSON.stringify(result), /vault|leak/i);
  });

  await check('hidden and symbolic upstream fields cannot widen the browser receipt', async () => {
    const receipt = {
      operationId: OPERATION_ID,
      status: 'refused',
      code: 'PROCESS_VISIBILITY_REFRESH_REFUSED'
    };
    Object.defineProperty(receipt, 'diagnostic', { value: 'C:\\vault\\must-not-leak' });
    assert.deepEqual(sanitizeReceipt(receipt), {
      operationId: OPERATION_ID,
      status: 'failed',
      code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
    });
    const symbolic = {
      operationId: OPERATION_ID,
      status: 'refused',
      code: 'PROCESS_VISIBILITY_REFRESH_REFUSED'
    };
    Object.defineProperty(symbolic, Symbol('diagnostic'), { value: 'must-not-leak' });
    assert.deepEqual(sanitizeReceipt(symbolic), {
      operationId: OPERATION_ID,
      status: 'failed',
      code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
    });
  });

  await check('the retired HTTP host is absent and retained default composition stays lazy and parameter-free', async () => {
    const retiredHost = path.join(__dirname, '..', 'sidecars', 'local-coder', 'bin', 'server.js');
    assert.equal(fs.existsSync(retiredHost), false,
      'a restored HTTP host needs its own integration contract; it is not covered by this helper test');
    const modulePath = require.resolve('../src/lib/supervision/process-visibility-controller-route.js');
    const originalLoad = Module._load;
    const originalCache = require.cache[modulePath];
    const calls = [];
    const receipt = Object.freeze({
      operationId: OPERATION_ID,
      status: 'refreshed',
      code: 'PROCESS_VISIBILITY_REFRESHED',
      helperStarted: true
    });
    let composed;
    // Exercise the actual helper's default dependency branch while keeping the
    // external elevation boundary inert. No mock of the helper itself is used.
    Module._load = function(request, parent, isMain) {
      if (parent?.filename === modulePath && request === './process-visibility-refresh.js') {
        return { OPERATION_ID, refreshProcessVisibility: async (...args) => { calls.push(args); return receipt; } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[modulePath];
    try { composed = require(modulePath); }
    finally {
      Module._load = originalLoad;
      if (originalCache) require.cache[modulePath] = originalCache;
      else delete require.cache[modulePath];
    }
    const route = composed.createProcessVisibilityRefreshControllerRoute();
    assert.deepEqual(calls, [], 'loading/composing the boundary must not start collection');
    assert.equal((await route.invoke({ taskName: 'not-an-input' })).code, 'PROCESS_VISIBILITY_REFRESH_ARGS_REFUSED');
    assert.deepEqual(calls, [], 'argument refusal must precede every default refresh effect');
    assert.deepEqual(await route.invoke(), receipt);
    assert.deepEqual(calls, [[]], 'one explicit invocation must call the default fixed adapter once with no arguments');
  });

  process.stdout.write(`\nprocess-visibility-controller-route: ${passed} checks passed\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
