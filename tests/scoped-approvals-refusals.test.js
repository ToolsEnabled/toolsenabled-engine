#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const scopedPath = require.resolve('../src/lib/scoped-approvals');
const desktopPath = require.resolve('../src/lib/desktop');
const stateStorePath = require.resolve('../src/lib/state-store');
const saved = new Map([
  [scopedPath, require.cache[scopedPath]],
  [desktopPath, require.cache[desktopPath]],
  [stateStorePath, require.cache[stateStorePath]]
]);

let promptCalls = 0;
let stateCalls = 0;
let hashCalls = 0;

function cache(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
    children: [],
    paths: [path.dirname(filename)]
  };
}

try {
  cache(desktopPath, Object.freeze({
    ask() {
      promptCalls += 1;
      throw new Error('the refusal must happen before prompting');
    }
  }));
  cache(stateStorePath, Object.freeze({
    getStateStore() {
      stateCalls += 1;
      throw new Error('the refusal must happen before state access');
    },
    hashInput() {
      hashCalls += 1;
      throw new Error('the refusal must happen before hashing or dispatch');
    }
  }));
  delete require.cache[scopedPath];
  const scopedApprovals = require(scopedPath);

  let refusal;
  try {
    scopedApprovals.consumeForDispatch({
      authorizationId: 'authorization-1',
      toolName: 'filesystem.write',
      arguments: {},
      approvalToken: 'A'.repeat(43),
      unexpected: 'caller-controlled field'
    });
  } catch (error) {
    refusal = error;
  }

  assert.ok(refusal, 'an inexact dispatch-consumption request must be refused');
  assert.equal(refusal.name, 'ScopedApprovalError');
  assert.equal(refusal.code, 'SCOPED_APPROVAL_INVALID');
  assert.match(refusal.message, /unsupported or missing fields/);
  assert.equal(promptCalls, 0, 'invalid input must not open a prompt');
  assert.equal(stateCalls, 0, 'invalid input must not read or write durable state');
  assert.equal(hashCalls, 0, 'invalid input must not hash arguments or reach dispatch consumption');
  process.stdout.write('ok - invalid scoped approval dispatch is refused before effects\n');
} finally {
  for (const [filename, entry] of saved) {
    if (entry === undefined) delete require.cache[filename];
    else require.cache[filename] = entry;
  }
}
