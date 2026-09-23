'use strict';

// LINUX SIDE OF THE SAME CACHE. vault-presence-cache.test.js pins the
// Windows path (mocks node:child_process's execFileSync); it cannot exercise
// the Linux branch of vaultRecordPresence() at all, because that branch
// returns before ever reaching the mocked code -- confirmed by running that
// suite unmodified on this Linux machine: 0/8 checks pass, because the real
// process.platform === 'linux' branch calls the real ./vault-linux instead of
// the mocked child_process, so the fixture's "spawn count" and "cached
// digest" controls never apply. This is one targeted test proving the same
// definite-answer-may-be-remembered contract on the Linux branch specifically
// (mirrors this suite's first three cases: reused PRESENT, reused ABSENT,
// re-probe on a changed digest), not a rewrite of the Windows suite above.

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

if (process.platform !== 'linux') {
  console.log('vault-presence-cache-linux: skipped, not running on linux');
  process.exit(0);
}

const presencePath = path.resolve(__dirname, '..', 'src', 'lib', 'vault-presence.js');
const vaultLinuxPath = path.resolve(__dirname, '..', 'src', 'lib', 'vault-linux.js');
const runtimePath = path.resolve(__dirname, '..', 'src', 'lib', 'runtime.js');

let probes = 0;
let nextAnswer = 'present';   // 'present' | 'absent' | 'no-store'
let digest = 'a'.repeat(64);

const realLoad = Module._load;
Module._load = function mockLinuxPresenceDependencies(request, parent, isMain) {
  const from = parent && parent.filename;
  if ((request === './vault-linux' || request === vaultLinuxPath) && from === presencePath) {
    return { presence() { probes += 1; return nextAnswer; } };
  }
  if ((request === './runtime' || request === runtimePath) && from === presencePath) {
    const real = realLoad(request, parent, isMain);
    return { ...real, vaultContentDigest: () => digest };
  }
  return realLoad(request, parent, isMain);
};

delete require.cache[presencePath];
const { vaultRecordPresence, resetVaultPresenceCache } = require(presencePath);
const KEY = 'toolsenabled_probe_key_v1';

function fresh({ answer = 'present', vaultDigest = 'a'.repeat(64) } = {}) {
  resetVaultPresenceCache();
  probes = 0;
  nextAnswer = answer;
  digest = vaultDigest;
}

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('Linux: a PRESENT answer is reused while the vault digest is unchanged', () => {
  fresh({ answer: 'present' });
  assert.equal(vaultRecordPresence(KEY).present, true);
  assert.equal(probes, 1, 'the first look must really probe vault-linux');
  for (let i = 0; i < 5; i += 1) {
    assert.equal(vaultRecordPresence(KEY).present, true, 'the reused answer must be the same one');
  }
  assert.equal(probes, 1, `five repeats must not probe vault-linux again; saw ${probes}`);
});

check('Linux: an ABSENT answer is definite too, and is also reused', () => {
  fresh({ answer: 'absent' });
  assert.equal(vaultRecordPresence(KEY).present, false);
  assert.equal(vaultRecordPresence(KEY).present, false);
  assert.equal(probes, 1, 'a measured absence is an answer, not a failure to look');
});

check('Linux: a changed vault digest drops what was remembered', () => {
  fresh({ answer: 'present' });
  assert.equal(vaultRecordPresence(KEY).present, true);
  assert.equal(probes, 1);
  digest = 'b'.repeat(64);
  nextAnswer = 'absent';
  assert.equal(vaultRecordPresence(KEY).present, false, 'a rewritten vault must never be answered from the previous bytes');
  assert.equal(probes, 2);
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\nvault-presence-cache-linux: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

Module._load = realLoad;
