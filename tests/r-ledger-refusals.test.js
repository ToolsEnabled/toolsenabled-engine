'use strict';

// A refused filing has no side effect: nothing is written, no directory is
// made, nothing is spawned. Proved through the adapter every product caller
// uses, with the filesystem and child_process seams trapped.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const { fileRequest, editRequest, RLedgerError } = require('../src/lib/r-ledger');

const root = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'r-ledger-refusals-'));
const options = { rootPath: (...parts) => path.join(root, ...parts), needsApproval: false };
const effects = [];

function trap(object, method) {
  const original = object[method];
  object[method] = function trapped(...args) {
    effects.push(method);
    return original.apply(this, args);
  };
  return () => { object[method] = original; };
}

function expectRefusal(code, action) {
  const before = effects.length;
  assert.throws(action, error => {
    assert.ok(error instanceof RLedgerError);
    assert.equal(error.code, code);
    return true;
  });
  assert.deepEqual(effects.slice(before), [], `${code} must not write or spawn`);
}

const restores = [
  trap(fs, 'mkdirSync'),
  trap(fs, 'writeFileSync'),
  trap(fs, 'openSync'),
  trap(fs, 'renameSync'),
  trap(fs, 'copyFileSync'),
  trap(childProcess, 'spawn'),
  trap(childProcess, 'spawnSync'),
  trap(childProcess, 'execFileSync')
];

try {
  expectRefusal('R_LEDGER_WORDS_INVALID', () => fileRequest({ scope: 'global', words: 42 }, options));
  expectRefusal('R_LEDGER_WORDS_EMPTY', () => fileRequest({ scope: 'global', words: ' \n ' }, options));
  expectRefusal('R_LEDGER_WORDS_TOO_LONG', () => fileRequest({ scope: 'global', words: 'x'.repeat(16 * 1024 + 1) }, options));
  expectRefusal('R_LEDGER_SCOPE_INVALID', () => fileRequest({ scope: 'planet', words: 'w' }, options));
  expectRefusal('R_LEDGER_KEY_INVALID', () => fileRequest({ scope: 'thread', key: 'a b', words: 'w' }, options));
  expectRefusal('R_LEDGER_FILED_BY_INVALID', () => fileRequest({ scope: 'global', words: 'w', filedBy: 'x'.repeat(81) }, options));
  expectRefusal('R_LEDGER_ID_INVALID', () => editRequest({ id: 'RS1', words: 'w' }, options));
  expectRefusal('R_LEDGER_WORDS_INVALID', () => editRequest({ id: 'R1', words: null }, options));
  assert.equal(fs.existsSync(path.join(root, 'reports')), false, 'no reports directory appeared');
  assert.equal(fs.existsSync(path.join(root, 'state')), false, 'no state directory appeared');
} finally {
  for (const restore of restores.reverse()) restore();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('r-ledger reachable refusal tests passed');
