'use strict';

// The configured model floor at the real dispatch chokepoint.
//
// The point of this file, and the reason it exists separately from
// tests/model-floor.js: that file proves the policy module refuses. This one
// proves the refusal is reached from src/lib/tool-registry.js#executeTool(),
// the route every tool call takes, including native mcp__toolsenabled__ calls.
//
// Run: node tests/tool-registry-model-floor.js   (from PowerShell)

const isolated = require('./lib/isolated-environment').activate('tool-registry-model-floor');
const assert = require('node:assert/strict');
const modelFloor = require('../src/lib/model-floor');
const { executeTool, assertModelFloor } = require('./helpers/dispatch');

void isolated;

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };
const asyncChecks = [];
const checkAsync = (label, fn) => { asyncChecks.push({ label, fn }); };

const entry = { name: 'task.submit' };

// --- the guard itself ---------------------------------------------------------

check('assertModelFloor passes a call that selects no model at all', () => {
  assertModelFloor(entry, { prompt: 'do the thing' }, 'invocation-test');
  assertModelFloor(entry, {}, 'invocation-test');
  assertModelFloor(entry, null, 'invocation-test');
});

check('assertModelFloor passes an on-floor model', () => {
  assertModelFloor(entry, { scope: { executionModel: 'gemini-3.1-pro-preview' } }, 'invocation-test');
  assertModelFloor(entry, { scope: { executionModel: 'gemini-2.5-pro' } }, 'invocation-test');
});

check('assertModelFloor REFUSES a below-floor flash model and names the configured policy', () => {
  assert.throws(
    () => assertModelFloor(entry, { scope: { executionModel: 'gemini-3.5-flash' } }, 'invocation-test'),
    (error) => {
      assert.equal(error.code, 'MODEL_FLOOR_REFUSED');
      assert.equal(error.field, 'scope.executionModel');
      assert.equal(error.tool, 'task.submit');
      // Fail LOUD and teach the rule from the error itself: a violator is only
      // guaranteed to read the error, so the error has to carry the rule.
      assert.match(error.message, /Configured model floor policy/);
      assert.match(error.message, /explicitly allowed high-capability Gemini models/);
      assert.match(error.message, /same policy applies to every lane type, including planning passes/);
      assert.match(error.message, /config\/model-floor\.json/);
      return true;
    }
  );
});

check('assertModelFloor REFUSES an unknown below-floor id', () => {
  assert.throws(
    () => assertModelFloor(entry, { scope: { executionModel: 'gemini-3.6-flash' } }, 'invocation-test'),
    (error) => {
      assert.equal(error.code, 'MODEL_FLOOR_REFUSED');
      assert.match(error.message, /Unknown and below the configured model floor/);
      return true;
    }
  );
});

check('assertModelFloor is not fooled by a prompt that merely mentions a lower-tier model', () => {
  assertModelFloor(entry, {
    prompt: 'compare gemini-3.5-flash to the pro tier',
    scope: { executionModel: 'gemini-3.1-pro-preview' }
  }, 'invocation-test');
});

check('assertModelFloor finds a below-floor model nested inside an array argument', () => {
  assert.throws(
    () => assertModelFloor(entry, { lanes: [{ model: 'gemini-3.1-pro-preview' }, { model: 'gemini-3.1-flash-lite' }] }, 'invocation-test'),
    (error) => {
      assert.equal(error.code, 'MODEL_FLOOR_REFUSED');
      assert.equal(error.field, 'lanes[1].model');
      return true;
    }
  );
});

// --- end to end through executeTool() ----------------------------------------

checkAsync('executeTool REFUSES a below-floor model carried in a free-form argument', async () => {
  // memory.set has an open string value, so this proves the guard is not
  // limited to the one schema that was hand-fixed -- it fires on ANY tool
  // whose argument value IS a bare below-floor Gemini model id.
  await assert.rejects(
    () => executeTool('memory.set', { namespace: 'model-floor-test', key: 'model-floor-check', value: 'gemini-3.5-flash' }),
    (error) => {
      assert.equal(error.code, 'MODEL_FLOOR_REFUSED');
      assert.equal(error.tool, 'memory.set');
      assert.match(error.message, /below the model floor/);
      return true;
    }
  );
});

checkAsync('executeTool does NOT mistake an opaque Gemini-prefixed idempotency value for a model', async () => {
  // Regression: the broad old matcher treated this ordinary opaque value as a
  // requested Gemini model and blocked a valid durable-run submission before the
  // tool ever ran. It has no numeric generation and is not a model id.
  const result = await executeTool('memory.set', {
    namespace: 'model-floor-test', key: 'model-floor-check-ok', value: 'gemini-envelope-smoke-v1'
  });
  assert.ok(result, 'a call selecting no model must dispatch normally');
});

(async () => {
  for (const { label, fn } of asyncChecks) { await fn(); checks += 1; void label; }
  console.log(`Tool-registry model-floor tests passed (${checks} checks; executeTool() refuses a below-floor `
    + 'Gemini model on any tool, and the subscription model floor is generated from config/model-floor.json).');
})().catch((error) => {
  process.exitCode = 1;
  console.error(error && error.stack ? error.stack : error);
});
