#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'sidecars/local-coder/bin/controller-projection-worker.js');
const AUDIT = path.join(ROOT, 'src/lib/audit.js');

function driveAuditFailure(failingMethod) {
  return new Promise((resolve, reject) => {
    const bootstrap = `
      'use strict';
      const fs = require('node:fs');
      const childProcess = require('node:child_process');
      const { parentPort } = require('node:worker_threads');
      const effects = { writes: [], spawns: [] };
      for (const name of ['appendFile', 'appendFileSync', 'createWriteStream', 'write', 'writeFile', 'writeFileSync']) {
        fs[name] = (...args) => { effects.writes.push(name); };
      }
      for (const name of ['exec', 'execFile', 'fork', 'spawn', 'spawnSync']) {
        childProcess[name] = (...args) => { effects.spawns.push(name); };
      }
      const originalPostMessage = parentPort.postMessage.bind(parentPort);
      parentPort.postMessage = message => originalPostMessage({ message, effects });
      const calls = [];
      const audit = {
        status() { calls.push('status'); if (${JSON.stringify(failingMethod)} === 'status') throw new Error('status unavailable'); return { headSequence: 1 }; },
        verify() { calls.push('verify'); if (${JSON.stringify(failingMethod)} === 'verify') throw new Error('verification unavailable'); return { valid: true }; },
        flush() { calls.push('flush'); throw new Error('unexpected flush'); },
        tailWithReferencedParents() { calls.push('tail'); if (${JSON.stringify(failingMethod)} === 'tail') throw new Error('tail unavailable'); return []; }
      };
      require.cache[${JSON.stringify(AUDIT)}] = { id: ${JSON.stringify(AUDIT)}, filename: ${JSON.stringify(AUDIT)}, loaded: true, exports: audit };
      const postWithCalls = parentPort.postMessage;
      parentPort.postMessage = payload => postWithCalls({ ...payload, calls });
      require(${JSON.stringify(WORKER)});
    `;
    const worker = new Worker(bootstrap, { eval: true });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });
}

(async () => {
  for (const [failure, expectedCalls] of [
    ['status', ['status']],
    ['verify', ['status', 'verify']],
    ['tail', ['status', 'verify', 'tail']]
  ]) {
    const result = await driveAuditFailure(failure);
    assert.deepEqual(result.message, {
      error: { code: 'CONTROLLER_AUDIT_VERIFY_FAILED' },
      calls: expectedCalls
    }, `${failure} failure must return the generic audit refusal and stop`);
    assert.deepEqual(result.effects, { writes: [], spawns: [] }, `${failure} refusal must not write or spawn`);
  }
  console.log('controller projection worker audit refusals: ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
