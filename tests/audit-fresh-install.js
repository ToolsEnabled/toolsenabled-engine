// EXECUTABLE CHANGE
// Report: testcanfail-tests-audit-fresh-install-js
//
// FOUND (shapes 1 and 6): memoryAnchor.set() contained the only assertion on
// the protected-anchor write, so it never ran when the callback was not called;
// moreover, it compared parsed.sequence with the sequence argument supplied by
// the same callback. The bootstrap case now requires exactly one write and
// independently requires the persisted sequence to be the literal first head.
//
// MUTATION: in a scratch edit of src/lib/audit.js, replaced the sole
// `writer(encoded, anchor.sequence)` call in writeAnchor() with a no-op.
// RED (node v22.22.2):
//   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
//   0 !== 1
//   at Object.<anonymous> (tests/audit-fresh-install.js:94:12)
// The mutation exited 1. The source was restored byte-for-byte: cmp exited 0
// and both pre/post SHA-256 values were
// 0d54120a8f091610c6c769cf6d5a268e31bdf2bb68e965e34c932393611d1c4f.
// GREEN AFTER RESTORE (node v22.22.2):
//   Fresh-install audit verification tests passed (6 cases).
//
// NOT-FOUND shape 2: no exit-status or truthy process-return assertions.
// NOT-FOUND shape 3: no catch or optional chain swallows an expected failure;
// the only try/finally blocks guarantee cleanup and do not catch failures.
// NOT-FOUND shape 4: no assertion substitutes a mock result for audit behavior;
// injected stores/secrets provide inputs, while assertions inspect audit output
// or the newly explicit protected-anchor interaction contract.
// NOT-FOUND shape 5: no skip or platform precondition guard.
// PRECONDITION: the PATH-default Node.js v20.20.2 lacks node:sqlite and cannot
// run this file; the repository-compatible installed Node.js v22.22.2 was used.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

function memoryAnchor() {
  let value = null;
  let setCalls = 0;
  return {
    get: () => value,
    set(next, sequence) {
      setCalls++;
      const parsed = JSON.parse(next);
      assert.equal(parsed.sequence, sequence);
      value = next;
    },
    status: () => ({ setCalls, value })
  };
}

function missingKey() {
  const error = new Error('not configured');
  error.code = 'SECRET_NOT_CONFIGURED';
  throw error;
}

function dependencies(directory, store, overrides = {}) {
  return {
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(directory, value),
    env: {},
    store,
    anchorStore: memoryAnchor(),
    clock: () => 1_700_000_000_000,
    eventIdFactory: () => 'fresh-install-event-0001',
    reportError: () => {},
    ...overrides
  };
}

function newCase(label) {
  return {
    directory: fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-${label}-`)),
    store: createAuditStore({ file: ':memory:' })
  };
}

function closeCase(test) {
  test.store.close();
  fs.rmSync(test.directory, { recursive: true, force: true });
}

// A clean canonical ledger is valid without manufacturing a signing identity.
{
  audit.resetForTests();
  const test = newCase('audit-fresh');
  let createCalls = 0;
  try {
    const result = audit.verify(dependencies(test.directory, test.store, {
      getSecret: missingKey,
      getOrCreateSecret: () => { createCalls++; throw new Error('must not create a key during verify'); }
    }));
    assert.deepEqual(result, { valid: true, entries: 0, reason: 'fresh-install' });
    assert.equal(createCalls, 0);
    assert.equal(test.store.status().headSequence, 0);
  } finally { closeCase(test); }
}

// The first durable event still owns signer bootstrap and makes the ledger verifiable.
{
  audit.resetForTests();
  const test = newCase('audit-bootstrap');
  let createCalls = 0;
  const keys = crypto.generateKeyPairSync('ed25519');
  try {
    const deps = dependencies(test.directory, test.store, {
      getSecret: missingKey,
      getOrCreateSecret: () => {
        createCalls++;
        return keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      }
    });
    assert.equal(audit.record('fresh.install', 'test', {}, deps).durable, true);
    assert.equal(createCalls, 1);
    const verification = audit.verify(deps);
    assert.equal(verification.valid, true);
    assert.equal(verification.entries, 1);
    assert.equal(deps.anchorStore.status().setCalls, 1);
    assert.equal(JSON.parse(deps.anchorStore.status().value).sequence, 1);
  } finally { closeCase(test); }
}

// Missing key remains an invalid identity signal once canonical history exists.
{
  audit.resetForTests();
  const test = newCase('audit-missing-existing');
  const keys = crypto.generateKeyPairSync('ed25519');
  try {
    const bootstrap = dependencies(test.directory, test.store, {
      getSecret: missingKey,
      getOrCreateSecret: () => keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    });
    assert.equal(audit.record('existing.event', 'test', {}, bootstrap).durable, true);
    audit.resetForTests();
    let createCalls = 0;
    const result = audit.verify(dependencies(test.directory, test.store, {
      getSecret: missingKey,
      getOrCreateSecret: () => { createCalls++; throw new Error('must not replace an existing key'); }
    }));
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'audit-unavailable');
    assert.equal(createCalls, 0);
    assert.equal(test.store.status().headSequence, 1);
  } finally { closeCase(test); }
}

// A pending emergency spool proves this is not a clean install.
{
  audit.resetForTests();
  const test = newCase('audit-fresh-emergency');
  try {
    fs.writeFileSync(path.join(test.directory, 'emergency.jsonl'), '{"pending":true}\n', 'utf8');
    const result = audit.verify(dependencies(test.directory, test.store, { getSecret: missingKey }));
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'emergency-backlog');
    assert.notEqual(result.reason, 'fresh-install');
  } finally { closeCase(test); }
}

// A protected anchor or nonempty external projection also disproves freshness.
{
  audit.resetForTests();
  const test = newCase('audit-fresh-external');
  try {
    fs.writeFileSync(path.join(test.directory, 'actions.jsonl'), 'legacy audit material\n', 'utf8');
    const result = audit.verify(dependencies(test.directory, test.store, {
      getSecret: missingKey,
      anchorStore: { get: () => JSON.stringify({
        domain: 'toolsenabled.audit.head.v1', version: 1, sequence: 1,
        eventHash: '0'.repeat(64), keyId: 'audit-ed25519-protected', signature: 'cHJvdGVjdGVk'
      }) }
    }));
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'protected-anchor');
    assert.notEqual(result.reason, 'fresh-install');
  } finally { closeCase(test); }
}

// A nonempty projection with an empty canonical ledger is not fresh either.
{
  audit.resetForTests();
  const test = newCase('audit-fresh-projection');
  try {
    fs.writeFileSync(path.join(test.directory, 'actions.jsonl'), 'legacy audit material\n', 'utf8');
    const result = audit.verify(dependencies(test.directory, test.store, { getSecret: missingKey }));
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'projection-malformed');
    assert.notEqual(result.reason, 'fresh-install');
  } finally { closeCase(test); }
}

console.log('Fresh-install audit verification tests passed (6 cases).');
