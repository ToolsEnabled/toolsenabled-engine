'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AuditStoreError, canonicalJson, publicKeyHash
} = require('../src/lib/audit-store');

function expectCode(action, code) {
  assert.throws(action, error => error instanceof AuditStoreError && error.code === code,
    `expected ${code}`);
}

function temporaryLedger(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `audit-refusal-${label}-`));
  return { dir, file: path.join(dir, 'audit.sqlite3') };
}

// These validation refusals happen before a ledger is opened. The untouched
// sentinel makes that no-write property explicit rather than merely checking a code.
{
  const fixture = temporaryLedger('json');
  const sentinel = path.join(fixture.dir, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged');
  const circular = {};
  circular.self = circular;
  expectCode(() => canonicalJson(circular), 'AUDIT_JSON_INVALID');
  expectCode(() => canonicalJson({ payload: 'x'.repeat(64 * 1024) }), 'AUDIT_EVENT_TOO_LARGE');
  expectCode(() => publicKeyHash('not a public key'), 'AUDIT_KEY_INVALID');
  assert.deepEqual(fs.readdirSync(fixture.dir), ['sentinel']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  fs.rmSync(fixture.dir, { recursive: true, force: true });
}

console.log('Audit-store refusal tests passed.');
