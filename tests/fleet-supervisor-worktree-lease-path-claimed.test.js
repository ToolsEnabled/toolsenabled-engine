'use strict';

// Drive the path-collision refusal with a deliberately colliding path
// derivation dependency. On POSIX, the production derivation is injective for
// valid lane IDs; dependency injection makes the platform-sensitive collision
// deterministic without pretending that two ordinary POSIX lane IDs collide.

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');

const worktreeModulePath = require.resolve('../src/lib/fleet-supervisor/worktree.js');
const leaseModulePath = require.resolve('../src/lib/fleet-supervisor/worktree-lease.js');
const originalWorktreeCache = require.cache[worktreeModulePath];
const originalLeaseCache = require.cache[leaseModulePath];
const originalWriteFileSync = fs.writeFileSync;
const originalAppendFileSync = fs.appendFileSync;
const originalSpawnSync = childProcess.spawnSync;
const originalExecFileSync = childProcess.execFileSync;

let derivations = 0;
let writes = 0;
let spawns = 0;

fs.writeFileSync = (...args) => { writes += 1; return originalWriteFileSync(...args); };
fs.appendFileSync = (...args) => { writes += 1; return originalAppendFileSync(...args); };
childProcess.spawnSync = (...args) => { spawns += 1; return originalSpawnSync(...args); };
childProcess.execFileSync = (...args) => { spawns += 1; return originalExecFileSync(...args); };

try {
  require.cache[worktreeModulePath] = {
    id: worktreeModulePath,
    filename: worktreeModulePath,
    loaded: true,
    exports: {
      WorktreeRefused: class WorktreeRefused extends Error {},
      worktreePathFor(laneId, repoRoot) {
        derivations += 1;
        assert.match(laneId, /^lane-[ab]$/);
        return path.join(path.dirname(repoRoot), 'same-derived-worktree');
      }
    }
  };
  delete require.cache[leaseModulePath];
  const { allocateWorktreeLease, WorktreeLeaseRefused } = require(leaseModulePath);
  const repoRoot = path.join(process.cwd(), 'path-claimed-fixture');
  const noReturn = Symbol('allocator did not return');
  let returned = noReturn;

  assert.throws(
    () => {
      returned = allocateWorktreeLease(
        { phaseId: 'Phase-B', laneId: 'lane-b', ownedPaths: ['src/b.js'] },
        {
          repoRoot,
          activeLeases: [
            { schemaVersion: 1, phaseId: 'Phase-A', laneId: 'lane-a', ownedPaths: ['src/a.js'] }
          ]
        }
      );
    },
    error => {
      assert.equal(error instanceof WorktreeLeaseRefused, true);
      assert.equal(error.code, 'WORKTREE_LEASE_PATH_CLAIMED');
      assert.equal(
        error.detail,
        `${path.join(path.dirname(repoRoot), 'same-derived-worktree')} is already leased by Phase-A.lane-a`
      );
      return true;
    },
    'distinct phase and lane IDs with the same derived worktree path must be refused'
  );

  assert.equal(returned, noReturn, 'the refusing allocator must not return a registry value');
  assert.equal(derivations, 2, 'both the proposal and active lease were derived through the injected dependency');
  assert.equal(writes, 0, 'path refusal must not write files');
  assert.equal(spawns, 0, 'path refusal must not spawn or execute a process');
} finally {
  fs.writeFileSync = originalWriteFileSync;
  fs.appendFileSync = originalAppendFileSync;
  childProcess.spawnSync = originalSpawnSync;
  childProcess.execFileSync = originalExecFileSync;
  if (originalWorktreeCache) require.cache[worktreeModulePath] = originalWorktreeCache;
  else delete require.cache[worktreeModulePath];
  if (originalLeaseCache) require.cache[leaseModulePath] = originalLeaseCache;
  else delete require.cache[leaseModulePath];
}

console.log('fleet-supervisor worktree lease path-claimed refusal passed');
