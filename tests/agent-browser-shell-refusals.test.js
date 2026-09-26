'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const browser = require('../src/lib/agent-browser-contract');
const shell = require('../src/lib/agent-browser-shell');

const session = browser.createIdentity('session', 'refusal-session');
const surface = browser.normalizeSurface({
  session,
  window: browser.createIdentity('window', 'refusal-window'),
  tab: browser.createIdentity('tab', 'refusal-tab'),
  process: browser.createProcessBinding({ startKey: 'refusal-process', generation: 3 }),
  humanOwned: true
});
const snapshot = browser.createSnapshot({
  generation: 3,
  observedAtMs: 1785620000000,
  surfaces: [surface]
});
const validStatus = browser.projectBrowserStatus({ snapshot, proofs: [] });

function refusesWithoutEffects(input, expectedCode) {
  const calls = [];
  const restorations = [];
  for (const [owner, methods] of [
    [fs, ['appendFile', 'appendFileSync', 'createWriteStream', 'write', 'writeFile', 'writeFileSync']],
    [childProcess, ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']]
  ]) {
    for (const method of methods) {
      const original = owner[method];
      owner[method] = (...args) => {
        calls.push({ method, args });
        return original(...args);
      };
      restorations.push(() => { owner[method] = original; });
    }
  }

  let result;
  try {
    assert.throws(
      () => { result = shell.createShellView(input); },
      error => error instanceof shell.AgentBrowserShellError && error.code === expectedCode,
      `expected ${expectedCode}`
    );
  } finally {
    for (const restore of restorations.reverse()) restore();
  }
  assert.equal(result, undefined, 'a refused shell view must not be returned');
  assert.deepEqual(calls, [], 'a refused shell view must not write or spawn');
}

refusesWithoutEffects({ browserStatus: null }, 'BROWSER_SHELL_INVALID');

refusesWithoutEffects({
  browserStatus: { ...validStatus, snapshotRef: 'not-a-snapshot-reference' }
}, 'BROWSER_SHELL_SNAPSHOT_INVALID');

refusesWithoutEffects({
  browserStatus: {
    ...validStatus,
    surfaces: [{ ...validStatus.surfaces[0], ownership: 'forged-owner' }]
  }
}, 'BROWSER_SHELL_OWNERSHIP_INVALID');

console.log('agent-browser-shell refusal tests passed.');
