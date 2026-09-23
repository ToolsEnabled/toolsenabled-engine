'use strict';

const isolated = require('../lib/isolated-environment').activate('audit-intent');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const audit = require('../../src/lib/audit');
const { createAuditStore } = require('../../src/lib/audit-store');
const killSwitch = require('../../src/lib/kill-switch');
const { executeTool } = require('../helpers/dispatch');
const { blockedResult } = require('../../src/playwright-gateway');
const admission = require('../../src/lib/audit-admission');
const { setThroughputModeForTests } = require('../../src/lib/throughput-mode');
const browserOwner = require('../../src/lib/browser-owner');

function memoryAnchor() {
  let value = null;
  return {
    get: () => value,
    set(next, sequence) {
      const parsed = JSON.parse(next);
      assert.equal(parsed.sequence, sequence);
      if (value !== null) {
        const prior = JSON.parse(value);
        if (sequence < prior.sequence) throw new Error('anchor cannot move backward');
        if (sequence === prior.sequence && next !== value) throw new Error('anchor conflict');
      }
      value = next;
    }
  };
}

function auditOutage(throughput, label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-${label}-${throughput}-`));
  const keys = crypto.generateKeyPairSync('ed25519');
  let nextId = 0;
  const dependencies = {
    signer: {
      keyId: 'p11-outage-key-0001',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sign: value => crypto.sign(null, value, keys.privateKey)
    },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(directory, value),
    env: {},
    eventIdFactory: () => `p11-outage-${String(++nextId).padStart(6, '0')}`,
    clock: () => 1_700_000_000_000 + nextId,
    reportError: () => {},
    anchorStore: memoryAnchor()
  };
  const failingStore = {
    registerKey() { throw new Error('canonical outage'); }
  };
  const originals = { requireRecord: audit.requireRecord, record: audit.record, recordBatch: audit.recordBatch };
  const oldWorker = process.env.TOOLSENABLED_AUDIT_ADMISSION_WORKER;
  const attempts = [];
  // Run the real grouped queue in this process so its real batch writer
  // receives the same injected storage outage as the strict record writer.
  // A sync requireRecord stub alone never intercepted the fast path.
  admission.resetAdmissionQueueForTests();
  process.env.TOOLSENABLED_AUDIT_ADMISSION_WORKER = '0';
  setThroughputModeForTests(throughput);
  const failedDependencies = extra => ({ ...extra, ...dependencies, store: failingStore });
  audit.requireRecord = (action, target, details, extra = {}) => {
    attempts.push({ action, target, details, required: true });
    return originals.requireRecord(action, target, details, failedDependencies(extra));
  };
  audit.record = (action, target, details, extra = {}) => {
    attempts.push({ action, target, details, required: false });
    return originals.record(action, target, details, failedDependencies(extra));
  };
  audit.recordBatch = (items, extra = {}) => {
    attempts.push(...items.map(item => ({
      action: item.action, target: item.target, details: item.details, required: item.anchorRequired === true
    })));
    return originals.recordBatch(items, failedDependencies(extra));
  };
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    admission.resetAdmissionQueueForTests();
    Object.assign(audit, originals);
    if (oldWorker === undefined) delete process.env.TOOLSENABLED_AUDIT_ADMISSION_WORKER;
    else process.env.TOOLSENABLED_AUDIT_ADMISSION_WORKER = oldWorker;
    setThroughputModeForTests(null);
  };
  return {
    directory, dependencies, attempts, restore,
    close() { restore(); fs.rmSync(directory, { recursive: true, force: true }); }
  };
}

(async () => {
  assert.equal(killSwitch.status().active, false);
  assert.equal(path.dirname(killSwitch.status().path), isolated.root,
    'intent tests must never inspect or mutate the repository KILLSWITCH');
  for (const throughput of ['fast', 'strict']) {
    const outage = auditOutage(throughput, 'external-intent-outage');
    const originalStart = browserOwner.start;
    let browserEffects = 0;
    browserOwner.start = () => {
      browserEffects += 1;
      throw new Error('the browser effect must not be reached during an audit outage');
    };
    try {
      let refusal;
      await assert.rejects(
        executeTool('browser.start', { url: 'https://example.test/' }, { requestId: 'audit-intent-test' }),
        error => {
          refusal = error;
          return error instanceof audit.AuditRequiredError && error.code === 'AUDIT_UNAVAILABLE';
        }
      );
      await admission.defaultAdmissionQueue().flush();
      assert.equal(browserEffects, 0, `${throughput}: failed intent must precede every browser effect`);
      const required = outage.attempts.filter(item => item.required);
      assert.equal(required.length, 1, `${throughput}: external-write dispatch must await one required intent`);
      assert.equal(required[0].action, 'mcp.tool.intent');
      assert.equal(required[0].target, 'browser.start');
      if (throughput === 'fast') {
        assert.equal(admission.defaultAdmissionQueue().stats().submitted, 2,
          'fast mode must submit the refused intent and failed outcome through the actual admission queue');
      }
      const outcomes = outage.attempts.filter(item => !item.required);
      assert.deepEqual(outcomes.map(item => item.action), ['mcp.tool.outward_ungated', 'mcp.tool.failed']);
      assert.equal(outcomes[0].target, 'browser.start');
      assert.equal(outcomes[0].details.requestId, 'audit-intent-test');
      assert.equal(outcomes[1].target, 'browser.start');
      assert.match(outcomes[1].details.invocationId, /^invocation-/);
      const blocked = blockedResult(1, refusal);
      assert.equal(blocked.result.isError, true);
      assert.equal(blocked.result.structuredContent.error.code, 'AUDIT_UNAVAILABLE');
      console.log(`${throughput}: real audit storage outage refuses browser dispatch before its effect`);
    } finally {
      browserOwner.start = originalStart;
      outage.close();
    }
  }

  // Local changes must survive the same real storage outage, with value-free
  // observations recoverable from the emergency spool in either audit mode.
  for (const throughput of ['fast', 'strict']) {
    const outage = auditOutage(throughput, 'p11-local-outage');
    const { directory, dependencies } = outage;
    try {
      const saved = await executeTool('memory.set', {
        namespace: `p11.outage.${throughput}`, key: 'memory-0001', value: { retained: 'local state' }
      });
      assert.equal(saved.key, 'memory-0001');
      assert.equal(saved.created, true);

      const submitted = await executeTool('task.submit', {
        queue: `p11-outage-${throughput}`, type: 'recoverable-local-transition', idempotencyKey: `p11-outage-task-${throughput}`,
        payload: { title: 'P11 outage task', objective: 'State must survive audit recovery.', context: 'Untrusted local fixture.' },
        expiryPolicy: 'uncertain', maxAttempts: 1
      });
      assert.equal(submitted.status, 'queued');
      assert.equal(submitted.replayed, false);
      await admission.defaultAdmissionQueue().flush();
      assert.deepEqual(outage.attempts.filter(item => item.required), [],
        'local memory/task changes must not acquire a durable external-write audit requirement');
      outage.restore();

      const emergencyFile = path.join(directory, 'emergency.jsonl');
      const emergency = fs.readFileSync(emergencyFile, 'utf8');
      assert.match(emergency, /coordinator\.audit\.policy\.decision/);
      assert.match(emergency, /coordinator\.audit\.memory\.mutation/);
      assert.match(emergency, /coordinator\.audit\.task\.transition/);
      assert.doesNotMatch(emergency, /P11 outage task|State must survive audit recovery|retained.*local state/);

      const recoveredStore = createAuditStore({ file: path.join(directory, 'audit.sqlite3') });
      try {
        const recovered = { ...dependencies, store: recoveredStore };
        assert.equal(audit.flush({ force: true }, recovered).projected, true);
        assert.equal(audit.status(recovered).pendingEmergency, 0);
        assert.equal(audit.verify(recovered).valid, true, 'spooled local P11 events must recover into the canonical signed ledger');
        assert.equal(recoveredStore.status().headSequence, 6, 'two local operations retain policy, semantic, and invocation audit events');
      } finally {
        recoveredStore.close();
      }
      console.log(`${throughput}: local memory/task changes survive and all six audit events recover`);
    } finally {
      outage.close();
    }
  }
  console.log('Durable external-intent gating tests passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
