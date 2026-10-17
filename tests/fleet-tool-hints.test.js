'use strict';
// Tool hints say what a repeat call does. Ported from the Claude Code plugin's
// 0e60d01/9fbcef3: neither call below is idempotent, so neither may say so.
require('./lib/isolated-environment').activate('fleet-tool-hints');
const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOL_REGISTRY } = require('../src/lib/tool-registry');

const hints = name => TOOL_REGISTRY.find(entry => entry.name === name).annotations;

test('completing a ledger task and starting a leased task are not marked idempotent', () => {
  // A recurring task logs every completion; a repeated start renews the lease.
  assert.equal(hints('t_ledger.complete').idempotentHint, false);
  assert.equal(hints('task.start').idempotentHint, false);
  assert.match(TOOL_REGISTRY.find(entry => entry.name === 'task.start').description, /renews the lease/);
  // Unchanged neighbours keep their documented hints.
  assert.equal(hints('ledger.read').readOnlyHint, true);
  assert.equal(hints('t_ledger.file').idempotentHint, false);
});
