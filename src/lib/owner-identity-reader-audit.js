'use strict';

// This is a deliberately narrow, pure audit projection.  It accepts only an
// injected JSON snapshot of *public* registry metadata; it never opens the
// vault, resolves a tool, reads a task, or discovers anything from disk.  A
// primitive JSON boundary also refuses object, accessor, and Proxy-like input
// before any property can be read from it.
const { classifyOwnerIdentityPurpose } = require('./owner-identity-purpose-gate');

const SCHEMA_VERSION = 'owner-identity-reader-surface/v1';
const MAX_SNAPSHOT_CHARS = 32 * 1024;
const SNAPSHOT_KEYS = Object.freeze(['entries', 'schemaVersion']);
const ENTRY_KEYS = Object.freeze(['actorId', 'capabilityClass', 'identityBinding', 'toolId']);
const BINDING_KEYS = Object.freeze(['purpose', 'vaultKey']);

// These are public route identifiers, not an authority grant.  Keeping the
// combinations fixed means a future registry wiring cannot silently broaden
// this audit's claimed reader surface merely by supplying a new descriptor.
const DECLARED_SURFACES = Object.freeze({
  'owner_identity.profile_status': Object.freeze({
    actorId: 'tool-registry',
    capabilityClass: 'identity-existence-read'
  }),
  'owner_identity.bootstrap_from_publisher_evidence': Object.freeze({
    actorId: 'tool-registry',
    capabilityClass: 'identity-profile-bootstrap'
  })
});

const EMPTY_MAP = Object.freeze(Object.create(null));

function hasExactFrozenDataRecord(value, expectedKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return false;
    const names = Object.getOwnPropertyNames(value).sort();
    const expected = [...expectedKeys].sort();
    if (Object.getOwnPropertySymbols(value).length !== 0
      || names.length !== expected.length
      || names.some((name, index) => name !== expected[index])) return false;
    return expected.every(name => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor
        && Object.hasOwn(descriptor, 'value')
        && descriptor.get === undefined
        && descriptor.set === undefined
        && descriptor.enumerable === true
        && descriptor.configurable === false
        && descriptor.writable === false;
    });
  } catch {
    return false;
  }
}

function hasExactFrozenArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !Object.isFrozen(value)) return false;
    const names = Object.getOwnPropertyNames(value).sort();
    const expected = ['length', ...Array.from({ length: value.length }, (_, index) => String(index))].sort();
    if (Object.getOwnPropertySymbols(value).length !== 0
      || names.length !== expected.length
      || names.some((name, index) => name !== expected[index])) return false;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !Object.hasOwn(length, 'value') || length.get !== undefined || length.set !== undefined
      || length.enumerable !== false || length.configurable !== false || length.writable !== false) return false;
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return descriptor
        && Object.hasOwn(descriptor, 'value')
        && descriptor.get === undefined
        && descriptor.set === undefined
        && descriptor.enumerable === true
        && descriptor.configurable === false
        && descriptor.writable === false;
    }).every(Boolean);
  } catch {
    return false;
  }
}

function freezeParsedSnapshot(value) {
  if (!value || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) freezeParsedSnapshot(value[key]);
  return Object.freeze(value);
}

function parseSnapshot(serializedSnapshot) {
  if (typeof serializedSnapshot !== 'string' || serializedSnapshot.length > MAX_SNAPSHOT_CHARS) return null;
  try {
    return freezeParsedSnapshot(JSON.parse(serializedSnapshot));
  } catch {
    return null;
  }
}

function exactDeclaredSurface(entry) {
  if (!hasExactFrozenDataRecord(entry, ENTRY_KEYS)
    || !hasExactFrozenDataRecord(entry.identityBinding, BINDING_KEYS)) return null;

  if (!Object.hasOwn(DECLARED_SURFACES, entry.toolId)) return null;
  const declared = DECLARED_SURFACES[entry.toolId];
  if (!declared || entry.actorId !== declared.actorId || entry.capabilityClass !== declared.capabilityClass) return null;

  const purpose = classifyOwnerIdentityPurpose(entry.identityBinding);
  return purpose.purposeRecognized ? declared : null;
}

function frozenRedactedMap(entries) {
  const output = Object.create(null);
  for (const entry of [...entries].sort((left, right) => left.toolId.localeCompare(right.toolId))) {
    output[entry.toolId] = Object.freeze({
      actorIds: Object.freeze([entry.actorId]),
      capabilityClasses: Object.freeze([entry.capabilityClass])
    });
  }
  return Object.freeze(output);
}

// Returns an immutable public map keyed by a fixed tool identifier.  Malformed
// or unknown candidate data makes the whole snapshot unavailable rather than
// publishing a potentially incomplete answer to "who can read this key?".
function auditOwnerIdentityReaderSurface(serializedSnapshot) {
  const snapshot = parseSnapshot(serializedSnapshot);
  if (!hasExactFrozenDataRecord(snapshot, SNAPSHOT_KEYS)
    || snapshot.schemaVersion !== SCHEMA_VERSION
    || !hasExactFrozenArray(snapshot.entries)
    || snapshot.entries.length !== Object.keys(DECLARED_SURFACES).length) return EMPTY_MAP;

  const accepted = [];
  const seenToolIds = new Set();
  for (const index of Object.keys(snapshot.entries).filter(key => key !== 'length')) {
    const descriptor = Object.getOwnPropertyDescriptor(snapshot.entries, index);
    const surface = descriptor && Object.hasOwn(descriptor, 'value') ? exactDeclaredSurface(descriptor.value) : null;
    if (!surface || seenToolIds.has(descriptor.value.toolId)) return EMPTY_MAP;
    seenToolIds.add(descriptor.value.toolId);
    accepted.push(Object.freeze({
      toolId: descriptor.value.toolId,
      actorId: surface.actorId,
      capabilityClass: surface.capabilityClass
    }));
  }
  return frozenRedactedMap(accepted);
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  auditOwnerIdentityReaderSurface
});
