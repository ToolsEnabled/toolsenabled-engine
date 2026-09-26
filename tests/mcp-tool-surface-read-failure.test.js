'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');

// Keep this focused test independent of the durable-store and Windows process
// providers: neither is involved in deciding what a failed registry read means.
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (parent && /[\\/]src[\\/]lib[\\/]mcp-tool-surface\.js$/.test(parent.filename)) {
    if (request === './state-store') return { getStateStore: () => { throw new Error('state should be injected'); } };
    if (request === './runtime') return { rootPath: (...parts) => path.join('/unused', ...parts) };
    if (request === './providers/durable-worker-runtime') {
      return { windowsStartTicks: () => null, windowsStartTicksMany: () => new Map() };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
let surface;
try {
  surface = require('../src/lib/mcp-tool-surface');
} finally {
  Module._load = originalLoad;
}

const tools = [];
const emptyState = { getMemory: () => null };
const registryBytes = Buffer.from('module.exports = true;\n');

for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
  let reads = 0;
  const readFile = () => {
    reads += 1;
    if (reads === 1) throw Object.assign(new Error(`simulated ${code}`), { code });
    return registryBytes;
  };
  const couldNotTell = surface.status({ state: emptyState, tools, readFile });
  assert.equal(couldNotTell.reason, 'MCP_TOOL_SURFACE_REGISTRY_CHECK_FAILED');
  assert.match(couldNotTell.nextAction, /not claiming.*registry is absent/i);

  const retried = surface.status({ state: emptyState, tools, readFile });
  assert.equal(retried.reason, 'MCP_TOOL_SURFACE_NO_LIVE_RECORD', `${code} must not be cached or latched`);
  assert.equal(reads, 2, `${code} must cause a new read on the next call`);
}

const absent = surface.status({
  state: emptyState,
  tools,
  readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
});
assert.equal(absent.reason, 'MCP_TOOL_SURFACE_REGISTRY_UNAVAILABLE',
  'the definite ENOENT answer must remain unchanged');

// CONTROL: successful per-sweep process data was legitimately cached before
// this fix. Calling the resulting identity repeatedly must not rerun the batch.
let batchReads = 0;
const pid = process.pid;
const ticks = '638890000000000001';
const identity = surface.batchedProcessIdentity([{ pid }], {
  startTicksMany: () => {
    batchReads += 1;
    return new Map([[pid, ticks]]);
  }
});
assert.equal(identity(pid).startTicks, ticks);
assert.equal(identity(pid).startTicks, ticks);
assert.equal(batchReads, 1, 'successful batch process identity must remain cached for its sweep');

process.stdout.write('MCP tool-surface read-failure tests passed.\n');
