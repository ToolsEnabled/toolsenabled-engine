// EXECUTABLE CHANGE
// Assertion audit (testcanfail-tests-launch-terminal-race-js):
// - SAME-CODE EXPECTATION: mutating launch-outcome's TERMINAL_ACTION to
//   "controller.agent.launch.terminal.MUTANT" left the original test GREEN because
//   its receipt query used that same exported constant. The query below now uses
//   the independently specified contract value. Under that mutation it is RED:
//   "AssertionError [ERR_ASSERTION]: the signed ledger contains one terminal receipt after the race"
//   "0 !== 1"
// - NOT-FOUND empty loop/forEach assertions; exit-status/truthy-only assertions;
//   swallowed failures; subject mocks; platform skips/precondition guards.
// - RESTORE: src/lib/launch-outcome.js was restored byte-for-byte (SHA-256
//   c0d6d941aeabbf56cd0d3703fdc86ca8a2c6be12250130720d55f219f0aeb880), then
//   this test was GREEN: "OK: two independent terminal writers serialize to one receipt and one conflict."

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const audit = require('../src/lib/audit');
const launch = require('../src/lib/controller-launch-record');
const outcome = require('../src/lib/launch-outcome');
const agentOrg = require('../src/lib/agent-org');
const { createAuditStore } = require('../src/lib/audit-store');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-launch-terminal-race-'));
  return { dir, file: path.join(dir, 'audit.sqlite3') };
}

function child(args) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, [path.join(__dirname, 'launch-terminal-race-worker.js'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let stdout = '', stderr = '';
    childProcess.stdout.on('data', value => { stdout += value; });
    childProcess.stderr.on('data', value => { stderr += value; });
    childProcess.on('error', reject);
    childProcess.on('close', code => {
      if (code !== 0) return reject(new Error(`terminal race worker exited ${code}: ${stderr}`));
      try { return resolve(JSON.parse(stdout.trim())); }
      catch (error) { return reject(new Error(`terminal race worker emitted invalid JSON: ${stdout}\n${error.message}`)); }
    });
  });
}

function dependencies(store, keys, root) {
  return {
    store,
    signer: { keyId: keys.keyId, publicKeyPem: keys.publicPem, sign: value => crypto.sign(null, value, keys.privateKey) },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(root, value),
    env: {},
    reportError: () => {},
    anchorStore: { get: () => null, set: () => {} }
  };
}

(async () => {
  const test = fixture();
  const pair = crypto.generateKeyPairSync('ed25519');
  const keys = {
    privateKey: pair.privateKey,
    privateDer: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyId: 'terminal-race-key-0001'
  };
  const org = agentOrg.normalizeOrg({
    revision: 1,
    agents: [
      { id: 'codex', displayName: 'Codex', role: 'controller', provider: 'codex', enabled: true },
      { id: 'terra', displayName: 'Terra', role: 'reviewer', provider: 'codex', enabled: true, phasePriority: [] }
    ],
    relationships: [{ from: 'codex', to: 'terra', type: 'manages' }]
  });
  let store = createAuditStore({ file: test.file, busyTimeoutMs: 30_000 });
  try {
    store.registerKey({ keyId: keys.keyId, publicKeyPem: keys.publicPem, createdAtMs: 1 });
    const deps = dependencies(store, keys, test.dir);
    const auditApi = {
      requireRecord: (action, target, details) => audit.requireRecord(action, target, details, deps),
      findEvents: query => audit.findEvents(query, deps),
      conditionalRecord: request => audit.conditionalRecord(request, deps)
    };
    const parent = launch.createLaunch({
      requestingActor: 'codex', targetAgentId: 'terra', tier: 'cheap', model: 'race-test',
      objectiveRef: 'terminal race', cap: { kind: 'turns', value: 1, capMs: 60_000 }, parentLaunchId: null
    }, { org, audit: auditApi, clock: () => 1_700_000_000_000 });
    store.close();
    store = null;

    const common = [
      test.file,
      test.dir,
      keys.privateDer,
      Buffer.from(keys.publicPem, 'utf8').toString('base64'),
      keys.keyId,
      parent.launchId
    ];
    const [completed, failed] = await Promise.all([
      child([...common, 'completed']),
      child([...common, 'failed'])
    ]);
    const results = [completed, failed];
    assert.equal(results.filter(result => result.ok).length, 1, 'exactly one concurrent terminal writer succeeds');
    assert.equal(results.filter(result => !result.ok && result.code === 'LAUNCH_TERMINAL_CONFLICT').length, 1,
      'the losing writer is refused as a conflict instead of appending a second receipt');

    store = createAuditStore({ file: test.file, busyTimeoutMs: 30_000 });
    const receipts = store.findEvents({
      action: 'controller.agent.launch.terminal', target: parent.launchId, limit: 10
    });
    assert.equal(receipts.length, 1, 'the signed ledger contains one terminal receipt after the race');
    assert.equal(store.verify().valid, true, 'the race leaves a valid signed ledger');
    console.log('OK: two independent terminal writers serialize to one receipt and one conflict.');
  } finally {
    audit.resetForTests();
    if (store) store.close();
    fs.rmSync(test.dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
