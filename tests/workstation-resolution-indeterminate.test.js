'use strict';

const assert = require('node:assert/strict');
const workstation = require('../src/lib/providers/workstation');

const safeProbe = () => ({ status: 0 });

// A failed PATH lookup is not evidence that Node is absent. Each machine-busy
// error gets the could-not-tell result rather than the definite fallback.
for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
  assert.throws(() => workstation.resolvePinnedNode({
    env: {},
    resolveCommand: () => { throw Object.assign(new Error(code), { code }); },
    spawnProbe: safeProbe
  }), error => error && error.code === 'WORKSTATION_NODE_RESOLUTION_INDETERMINATE'
    && /does NOT claim that Node\.js is absent/.test(error.message));
}

// The child-process version of could-not-tell has the same result, including
// a child that returns no status at all.
for (const result of [
  { error: Object.assign(new Error('busy'), { code: 'EAGAIN' }), status: null },
  { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), status: null },
  { status: null }
]) {
  assert.throws(() => workstation.resolvePinnedNode({
    env: {}, resolveCommand: () => 'C:\\node.exe', spawnProbe: () => result
  }), error => error && error.code === 'WORKSTATION_NODE_RESOLUTION_INDETERMINATE'
    && /does NOT claim that Node\.js is absent/.test(error.message));
}

// ENOENT is the one genuine absent result and retains the established fallback.
assert.equal(workstation.resolvePinnedNode({
  env: {},
  resolveCommand: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
  spawnProbe: safeProbe
}), workstation.LEGACY_PINNED_NODE);

// An indeterminate result must not latch. The retry succeeds; then the control
// proves that successful answers are still cached rather than re-probed.
workstation.resetPinnedNodeCache();
let lookups = 0;
const options = {
  env: {},
  resolveCommand: () => {
    lookups += 1;
    if (lookups === 1) throw Object.assign(new Error('busy'), { code: 'EMFILE' });
    return 'C:\\good-node.exe';
  },
  spawnProbe: safeProbe
};
assert.throws(() => workstation.pinnedNode(options),
  error => error && error.code === 'WORKSTATION_NODE_RESOLUTION_INDETERMINATE');
assert.equal(workstation.pinnedNode(options), 'C:\\good-node.exe');
assert.equal(lookups, 2, 'the could-not-tell result must be retried');
assert.equal(workstation.pinnedNode({
  env: {}, resolveCommand: () => { lookups += 1; return 'C:\\other-node.exe'; }, spawnProbe: safeProbe
}), 'C:\\good-node.exe');
assert.equal(lookups, 2, 'a successful answer must remain cached');
workstation.resetPinnedNodeCache();
