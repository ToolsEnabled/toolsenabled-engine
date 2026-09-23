'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const surface = require('../src/lib/confined-tool-surface');

function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'confined-path-refusal-'));
  const observed = { writes: 0, spawns: 0 };
  const originals = new Map();

  const intercept = (owner, name, counter) => {
    if (typeof owner[name] !== 'function') return;
    originals.set(`${counter}:${name}`, [owner, name, owner[name]]);
    owner[name] = function unexpectedSideEffect() {
      observed[counter] += 1;
      throw new Error(`unexpected ${counter} through ${name}`);
    };
  };

  try {
    for (const name of ['writeFileSync', 'appendFileSync', 'createWriteStream']) {
      intercept(fs, name, 'writes');
    }
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      intercept(childProcess, name, 'spawns');
    }

    let refusal = null;
    try {
      surface.assertArgumentsConfined(
        'search.index',
        { root: '\\\\server\\share\\secrets' },
        [workspace],
        { tier: 'confined', profile: 'workspace' }
      );
    } catch (error) {
      refusal = error;
    }

    assert.ok(refusal, 'a UNC path must throw rather than return success');
    assert.equal(refusal.name, 'ConfinedSurfaceRefusal');
    assert.equal(refusal.code, 'PERMISSION_CONFINED_WORKSPACE_REFUSED');
    assert.match(refusal.message, /UNC or device path/);
    assert.deepEqual(refusal.details, {
      tool: 'search.index',
      argument: 'root',
      tier: 'confined',
      profile: 'workspace',
      boundaryCode: 'WORKSPACE_PATH_REFUSED'
    });
    assert.equal(Object.isFrozen(refusal.details), true, 'refusal metadata must be immutable');
    assert.deepEqual(observed, { writes: 0, spawns: 0 },
      'the confined surface must refuse before any write or process launch');
  } finally {
    for (const [, [owner, name, original]] of originals) owner[name] = original;
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  console.log('PASS confined surface preserves WORKSPACE_PATH_REFUSED without side effects');
}

main();
