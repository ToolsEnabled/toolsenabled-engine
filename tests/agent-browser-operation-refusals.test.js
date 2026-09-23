'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const browser = require('../src/lib/agent-browser-contract');
const operations = require('../src/lib/agent-browser-operations');

const session = browser.createIdentity('session', 'session-refusal');
const windowId = browser.createIdentity('window', 'window-refusal');
const tab = browser.createIdentity('tab', 'tab-refusal');
const leaseId = browser.createIdentity('lease', 'lease-refusal');
const processBinding = browser.createProcessBinding({ startKey: 'process-refusal-001', generation: 3 });
const lease = browser.createLease({
  leaseId,
  agentId: 'agent-refusal',
  sessionId: session,
  generation: 3,
  fence: 'fence-refusal-001'
});
const proof = browser.createOwnershipProof({
  agentId: lease.agentId,
  sessionId: session,
  leaseId,
  generation: 3,
  startKey: processBinding.startKey,
  fence: lease.fence
});
const surface = browser.normalizeSurface({
  session,
  window: windowId,
  tab,
  process: processBinding,
  agentLease: {
    leaseId: lease.lease,
    agentId: lease.agentId,
    sessionId: lease.sessionId,
    generation: 3,
    fence: lease.fence
  },
  title: 'refusal fixture',
  url: 'https://example.test/refusal',
  mediaPlaying: false
});
const snapshot = browser.createSnapshot({ generation: 3, observedAtMs: 1787800000000, surfaces: [surface] });
const target = browser.surfaceKey(surface);

const originalEffects = new Map();
let effectCalls = 0;
for (const [owner, methods] of [
  [fs, ['appendFile', 'appendFileSync', 'createWriteStream', 'writeFile', 'writeFileSync']],
  [childProcess, ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']]
]) {
  for (const method of methods) {
    originalEffects.set(`${owner === fs ? 'fs' : 'child_process'}.${method}`, owner[method]);
    owner[method] = () => {
      effectCalls += 1;
      throw new Error(`refusal attempted forbidden effect: ${method}`);
    };
  }
}

let sequence = 0;
function targetRequest(operation, input) {
  sequence += 1;
  return {
    operation,
    snapshot,
    currentSnapshotRef: snapshot.snapshotRef,
    currentGeneration: 3,
    proof,
    proofs: [proof],
    surfaceKey: target,
    idempotencyKey: `refusal:${operation}:${sequence.toString().padStart(4, '0')}`,
    input
  };
}

function refuses(code, invoke) {
  const callsBefore = effectCalls;
  let error;
  try {
    invoke();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof operations.AgentBrowserOperationError, `${code} must throw AgentBrowserOperationError`);
  assert.equal(error.code, code);
  assert.equal(effectCalls, callsBefore, `${code} must not write or spawn`);
}

try {
  refuses('BROWSER_OPERATION_INVALID', () => operations.createOperation(null));
  refuses('BROWSER_OPERATION_ID_INVALID', () => operations.createOperation(targetRequest('download', {
    downloadId: '../bad', suggestedName: 'safe.txt', sizeBytes: 1
  })));
  refuses('BROWSER_OPERATION_LIMIT_INVALID', () => operations.createOperation(targetRequest('navigate', {
    url: 'https://example.test/next', timeoutMs: 0
  })));
  refuses('BROWSER_OPERATION_MEDIA_ACTION', () => operations.createOperation(targetRequest('media_state', {
    action: 'pause'
  })));
  refuses('BROWSER_OPERATION_MEDIA_REVISION', () => operations.createOperation(targetRequest('media_state', {
    action: 'play', mediaRevision: 0
  })));
  refuses('BROWSER_OPERATION_SELECTOR_EMPTY', () => operations.createOperation(targetRequest('click', {
    selector: { kind: 'css', value: '   ' }
  })));
  refuses('BROWSER_OPERATION_SELECTOR_REQUIRED', () => operations.createOperation(targetRequest('click', {})));
  refuses('BROWSER_OPERATION_TEXT_INVALID', () => operations.createOperation(targetRequest('type', {
    selector: { kind: 'label', value: 'Search' }, text: 'unsafe\0text', contentClass: 'non-secret'
  })));
} finally {
  for (const [qualifiedName, original] of originalEffects) {
    const [ownerName, method] = qualifiedName.split('.');
    (ownerName === 'fs' ? fs : childProcess)[method] = original;
  }
}

assert.equal(effectCalls, 0);
console.log('agent-browser-operation refusal tests passed.');
