'use strict';

const assert = require('node:assert/strict');
const audit = require('../src/lib/owner-identity-reader-audit');

const validEntries = [
  {
    toolId: 'owner_identity.bootstrap_from_publisher_evidence',
    actorId: 'tool-registry',
    capabilityClass: 'identity-profile-bootstrap',
    identityBinding: { vaultKey: 'owner_legal_identity_v1', purpose: 'owner_legal_identity' }
  },
  {
    toolId: 'owner_identity.profile_status',
    actorId: 'tool-registry',
    capabilityClass: 'identity-existence-read',
    identityBinding: { vaultKey: 'owner_legal_identity_v1', purpose: 'owner_legal_identity' }
  }
];

function snapshot(entries = validEntries, extra = {}) {
  return JSON.stringify({ schemaVersion: audit.SCHEMA_VERSION, entries, ...extra });
}

const result = audit.auditOwnerIdentityReaderSurface(snapshot());
assert.equal(Object.getPrototypeOf(result), null);
assert.equal(Object.isFrozen(result), true);
assert.deepEqual(Object.keys(result), [
  'owner_identity.bootstrap_from_publisher_evidence',
  'owner_identity.profile_status'
]);
assert.deepEqual(result['owner_identity.bootstrap_from_publisher_evidence'], {
  actorIds: ['tool-registry'],
  capabilityClasses: ['identity-profile-bootstrap']
});
assert.deepEqual(result['owner_identity.profile_status'], {
  actorIds: ['tool-registry'],
  capabilityClasses: ['identity-existence-read']
});
assert.equal(Object.isFrozen(result['owner_identity.profile_status']), true);
assert.equal(Object.isFrozen(result['owner_identity.profile_status'].actorIds), true);
assert.equal(JSON.stringify(result).includes('owner_legal_identity_v1'), false, 'vault key must not be exposed');
assert.equal(JSON.stringify(result).includes('owner_legal_identity'), false, 'purpose binding must not be exposed');

for (const malformed of [
  '',
  '{',
  JSON.stringify({ schemaVersion: audit.SCHEMA_VERSION, entries: validEntries, unexpected: true }),
  snapshot([{ ...validEntries[0], identityBinding: { vaultKey: 'other', purpose: 'owner_legal_identity' } }]),
  snapshot([{ ...validEntries[0], actorId: 'gemini' }]),
  snapshot([{ ...validEntries[0], capabilityClass: 'identity-value-read' }]),
  snapshot([{ ...validEntries[0], toolId: 'owner_identity.unlisted_reader' }]),
  snapshot([validEntries[0], validEntries[0]])
]) {
  assert.equal(Object.keys(audit.auditOwnerIdentityReaderSurface(malformed)).length, 0, 'unknown or malformed snapshots fail closed');
}

let accessorRead = false;
const accessorInput = {};
Object.defineProperty(accessorInput, 'valueOf', {
  enumerable: true,
  get() { accessorRead = true; throw new Error('must not read accessor input'); }
});
assert.equal(Object.keys(audit.auditOwnerIdentityReaderSurface(accessorInput)).length, 0);
assert.equal(accessorRead, false, 'object inputs are rejected before any property read');

let proxyTrapRead = false;
const proxyInput = new Proxy({}, {
  get() { proxyTrapRead = true; throw new Error('must not read proxy input'); },
  ownKeys() { proxyTrapRead = true; throw new Error('must not enumerate proxy input'); }
});
assert.equal(Object.keys(audit.auditOwnerIdentityReaderSurface(proxyInput)).length, 0);
assert.equal(proxyTrapRead, false, 'proxy-like object inputs are rejected at the primitive boundary');

const tooLarge = 'x'.repeat((32 * 1024) + 1);
assert.equal(Object.keys(audit.auditOwnerIdentityReaderSurface(tooLarge)).length, 0);

process.stdout.write('Owner identity reader audit tests passed.\n');
