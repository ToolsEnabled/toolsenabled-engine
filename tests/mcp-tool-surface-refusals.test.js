'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');

// Isolate these refusal tests from the platform process provider. Every path
// supplies its own state and identity dependencies, so touching either default
// would mean the refusal performed work it must not perform.
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (parent && /[\\/]src[\\/]lib[\\/]mcp-tool-surface\.js$/.test(parent.filename)) {
    if (request === './state-store') return { getStateStore: () => { throw new Error('state must be injected'); } };
    if (request === './runtime') return { rootPath: (...parts) => path.join('/unused', ...parts) };
    if (request === './providers/durable-worker-runtime') {
      return {
        windowsStartTicks: () => { throw new Error('process identity must be injected'); },
        windowsStartTicksMany: () => { throw new Error('process identity must be injected'); }
      };
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

const registryBytes = Buffer.from('module.exports = true;\n');
const digest = crypto.createHash('sha256').update(registryBytes).digest('hex');
const ticks = '638890000000000001';
let writes = 0;
let identityChecks = 0;
const mustNotWrite = () => { writes += 1; throw new Error('refusal must not write'); };
const mustNotCheckIdentity = () => { identityChecks += 1; throw new Error('refusal must not inspect or spawn for a process'); };

// An empty store is a normal, driven status input: it must report the absence
// of a live record without writing state or looking up any process.
const empty = surface.status({
  state: { getMemory: () => null, setMemory: mustNotWrite },
  tools: [], readFile: () => registryBytes, processIdentity: mustNotCheckIdentity
});
assert.equal(empty.state, 'unknown');
assert.equal(empty.reason, 'MCP_TOOL_SURFACE_NO_LIVE_RECORD');
assert.deepEqual(empty.counts, { observed: 0, fresh: 0, stale: 0, unknown: 0, deadIgnored: 0 });
assert.equal(writes, 0);
assert.equal(identityChecks, 0);

// A malformed durable envelope is refused by recordStartup itself. It must
// throw the specific storage-integrity code before either a write or sweep.
const invalidState = {
  getMemory: () => ({ revision: 7, value: { schemaVersion: 1, instances: 'not-an-array' } }),
  setMemory: mustNotWrite
};
assert.throws(() => surface.recordStartup({
  state: invalidState, tools: [], readFile: () => registryBytes,
  pid: 1234, startTicks: ticks, bootedAtMs: 1,
  instanceId: '00000000-0000-4000-8000-000000000001',
  processIdentity: mustNotCheckIdentity
}), error => error && error.code === 'MCP_TOOL_SURFACE_RECORD_INVALID');
assert.equal(writes, 0);
assert.equal(identityChecks, 0);

// The status API deliberately translates that thrown record refusal into its
// public unavailable result, again without mutating or sweeping durable data.
const unavailable = surface.status({
  state: invalidState, tools: [], readFile: () => registryBytes,
  processIdentity: mustNotCheckIdentity
});
assert.equal(unavailable.state, 'unavailable');
assert.equal(unavailable.reason, 'MCP_TOOL_SURFACE_STATE_UNAVAILABLE');
assert.deepEqual(unavailable.counts, { observed: 0, fresh: 0, stale: 0, unknown: 0, deadIgnored: 0 });
assert.equal(writes, 0);
assert.equal(identityChecks, 0);

// Fill the bounded envelope with unverifiable records. Unknown records cannot
// safely be evicted, so a different startup must refuse before setMemory.
const instances = Array.from({ length: surface.MAX_INSTANCES }, (_, index) => ({
  schemaVersion: 1,
  instanceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  transport: 'owner-host',
  pid: index + 1,
  startTicks: ticks,
  bootedAtMs: index,
  registryContentSha256: digest,
  profileSha256: digest,
  surfaceSha256: digest,
  toolCount: 0
}));
const fullState = {
  getMemory: () => ({ revision: 9, value: { schemaVersion: 1, instances } }),
  setMemory: mustNotWrite
};
assert.throws(() => surface.recordStartup({
  state: fullState, tools: [], readFile: () => registryBytes,
  pid: 9999, startTicks: ticks, bootedAtMs: 99,
  instanceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  processIdentity: () => { identityChecks += 1; return { state: 'unknown', startTicks: null }; }
}), error => error && error.code === 'MCP_TOOL_SURFACE_CAPACITY_REACHED');
assert.equal(writes, 0);
assert.equal(identityChecks, surface.MAX_INSTANCES, 'capacity check may classify existing records exactly once');

process.stdout.write('MCP tool-surface driven refusal tests passed.\n');
