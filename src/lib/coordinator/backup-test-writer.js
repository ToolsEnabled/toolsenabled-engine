'use strict';

// Q37's pre-activation writer is a closed test seam. It materializes only
// copied fixture bytes in a module-private memory store; it has no host
// destination, task integration, or production activation path.

const crypto = require('node:crypto');
const { types } = require('node:util');

const SCHEMA_VERSION = 1;
const TEST_STORE_KIND = 'q37-test-only-memory-store';
const MANIFEST_NAME = 'manifest.json';
const ROOT_BINDING = 'toolsenabled-backup-root-v1';
const REQUIRED_ARTIFACTS = Object.freeze(['repo.bundle', 'vault-state.enc']);
const SNAPSHOT_NAME = /^snapshot-\d{8}T\d{6}Z$/;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 1536 * 1024;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOTS = 4;
const MAX_TOTAL_STORES = 16;
const MAX_TOTAL_STORE_BYTES = 2 * 1024 * 1024;
const WRITE_INPUT_KEYS = Object.freeze(['store', 'snapshotName', 'artifacts']);
const VERIFY_INPUT_KEYS = Object.freeze(['store', 'snapshotName']);
const ARTIFACT_KEYS = Object.freeze(['name', 'bytes']);
const COULD_NOT_TELL_CODES = new Set(['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']);
const COULD_NOT_TELL_MESSAGE = 'The machine could not tell; this result is not claiming that the snapshot is absent.';
const storeRecords = new WeakMap();
let totalStores = 0;
let totalStoreBytes = 0;

const RESTORE_VERIFICATION_CONTRACT = Object.freeze({
  kind: 'backup-restore-verification-contract',
  mode: 'test-only',
  verifies: Object.freeze(['manifest-schema', 'artifact-byte-length', 'artifact-sha256']),
  restoreAttempted: false,
  restoreAuthorized: false,
  productionActivation: 'disabled'
});

function snapshotIso(name) {
  if (typeof name !== 'string' || !SNAPSHOT_NAME.test(name)) return null;
  const stamp = name.slice('snapshot-'.length);
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === iso ? iso : null;
}

function frozenHashes(hashes) {
  return Object.freeze(hashes.slice());
}

function result(snapshotName, status, code, manifestSha256 = null, artifactSha256 = []) {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    kind: 'test-only-backup-write',
    status,
    snapshotName: typeof snapshotName === 'string' ? snapshotName : null,
    code,
    manifestSha256,
    artifactSha256: frozenHashes(artifactSha256),
    productionActivation: 'disabled',
    artifactsDeleted: 0
  });
}

function uncommitted(snapshotName, code) {
  return result(snapshotName, 'not-committed', code);
}

function verification(snapshotName, status) {
  return Object.freeze({
    ...RESTORE_VERIFICATION_CONTRACT,
    status,
    snapshotName: typeof snapshotName === 'string' ? snapshotName : null
  });
}

function isCouldNotTell(error) {
  return Boolean(error && typeof error === 'object'
    && (COULD_NOT_TELL_CODES.has(error.code) || error.name === 'TimeoutError'));
}

function rethrowCouldNotTell(error) {
  if (isCouldNotTell(error)) throw error;
}

function indeterminateWrite(snapshotName) {
  return Object.freeze({
    ...result(snapshotName, 'indeterminate', 'Q37_TEST_ONLY_COULD_NOT_TELL'),
    message: COULD_NOT_TELL_MESSAGE
  });
}

function indeterminateVerification(snapshotName) {
  return Object.freeze({
    ...verification(snapshotName, 'indeterminate'),
    code: 'Q37_TEST_ONLY_COULD_NOT_TELL',
    message: COULD_NOT_TELL_MESSAGE
  });
}

function isProxy(value) {
  try {
    return types.isProxy(value);
  } catch (error) {
    rethrowCouldNotTell(error);
    return true;
  }
}

// Read each data descriptor exactly once. The returned object is new and never
// handed back to the caller, so later validation does not revisit caller state.
function snapshotExactDataObject(value, expectedKeys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length) return null;
    for (const key of ownKeys) {
      if (typeof key !== 'string' || !expectedKeys.includes(key)) return null;
    }
    const copy = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      const sampled = descriptor.value;
      Object.defineProperty(copy, key, { value: sampled, enumerable: true });
    }
    return Object.freeze(copy);
  } catch (error) {
    rethrowCouldNotTell(error);
    return null;
  }
}

function snapshotExactArray(value, expectedLength) {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedLength + 1 || ownKeys[ownKeys.length - 1] !== 'length') return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || lengthDescriptor.value !== expectedLength) return null;
    const copy = [];
    for (let index = 0; index < expectedLength; index += 1) {
      const key = String(index);
      if (ownKeys[index] !== key) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      const sampled = descriptor.value;
      Object.defineProperty(copy, index, { value: sampled, enumerable: true, writable: false, configurable: false });
    }
    return Object.freeze(copy);
  } catch (error) {
    rethrowCouldNotTell(error);
    return null;
  }
}

function copyBytes(value) {
  try {
    if (value === null || typeof value !== 'object' || isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    const isBuffer = Buffer.isBuffer(value) && prototype === Buffer.prototype;
    const isUint8Array = value instanceof Uint8Array && prototype === Uint8Array.prototype;
    if (!isBuffer && !isUint8Array) return null;
    const declaredBytes = value.byteLength;
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > MAX_ARTIFACT_BYTES) return null;
    const copied = Buffer.from(value);
    return copied.byteLength === declaredBytes ? copied : null;
  } catch (error) {
    rethrowCouldNotTell(error);
    return null;
  }
}

function snapshotArtifacts(value) {
  const supplied = snapshotExactArray(value, REQUIRED_ARTIFACTS.length);
  if (supplied === null) return null;
  const artifacts = [];
  let totalBytes = 0;
  for (let index = 0; index < REQUIRED_ARTIFACTS.length; index += 1) {
    const suppliedArtifact = snapshotExactDataObject(supplied[index], ARTIFACT_KEYS);
    if (suppliedArtifact === null || suppliedArtifact.name !== REQUIRED_ARTIFACTS[index]) return null;
    const bytes = copyBytes(suppliedArtifact.bytes);
    if (bytes === null || totalBytes > MAX_SNAPSHOT_BYTES - bytes.byteLength) return null;
    totalBytes += bytes.byteLength;
    artifacts.push(Object.freeze({ name: suppliedArtifact.name, bytes }));
  }
  return Object.freeze({ artifacts: Object.freeze(artifacts), totalBytes });
}

function canonicalSnapshot(snapshotName) {
  try {
    if (typeof snapshotName !== 'string') return null;
    const createdAt = snapshotIso(snapshotName);
    if (createdAt === null || Date.parse(createdAt) > Date.now()) return null;
    return Object.freeze({ snapshotName, createdAt });
  } catch (error) {
    rethrowCouldNotTell(error);
    return null;
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalManifest(snapshot, artifacts) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'backup-manifest',
    mode: 'test-only',
    rootBinding: ROOT_BINDING,
    snapshotName: snapshot.snapshotName,
    createdAt: snapshot.createdAt,
    artifacts: artifacts.map(artifact => ({
      name: artifact.name,
      bytes: artifact.bytes.byteLength,
      sha256: sha256(artifact.bytes)
    }))
  };
}

function prepareRecord(snapshot, copiedArtifacts) {
  try {
    const manifest = canonicalManifest(snapshot, copiedArtifacts.artifacts);
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const artifacts = Object.freeze(copiedArtifacts.artifacts.map((artifact, index) => Object.freeze({
      name: artifact.name,
      encodedBytes: artifact.bytes.toString('base64'),
      byteLength: artifact.bytes.byteLength,
      sha256: manifest.artifacts[index].sha256
    })));
    const artifactSha256 = Object.freeze(manifest.artifacts.map(artifact => artifact.sha256));
    const totalBytes = copiedArtifacts.totalBytes + manifestBytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_STORE_BYTES) return null;
    return Object.freeze({
      snapshotName: snapshot.snapshotName,
      createdAt: snapshot.createdAt,
      artifacts,
      artifactSha256,
      encodedManifest: manifestBytes.toString('base64'),
      manifestSha256: sha256(manifestBytes),
      totalBytes
    });
  } catch (error) {
    rethrowCouldNotTell(error);
    return null;
  }
}

function verifiesPreparedRecord(record) {
  try {
    if (!record || typeof record !== 'object' || record.artifacts.length !== REQUIRED_ARTIFACTS.length) return false;
    const snapshot = canonicalSnapshot(record.snapshotName);
    if (snapshot === null || snapshot.createdAt !== record.createdAt) return false;
    const artifactIntent = [];
    let artifactBytes = 0;
    for (let index = 0; index < REQUIRED_ARTIFACTS.length; index += 1) {
      const artifact = record.artifacts[index];
      if (!artifact || artifact.name !== REQUIRED_ARTIFACTS[index] || typeof artifact.encodedBytes !== 'string'
        || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0 || artifact.byteLength > MAX_ARTIFACT_BYTES
        || artifactBytes > MAX_SNAPSHOT_BYTES - artifact.byteLength) return false;
      const bytes = Buffer.from(artifact.encodedBytes, 'base64');
      if (bytes.byteLength !== artifact.byteLength || bytes.toString('base64') !== artifact.encodedBytes) return false;
      artifactBytes += artifact.byteLength;
      const hash = sha256(bytes);
      if (hash !== artifact.sha256 || hash !== record.artifactSha256[index]) return false;
      artifactIntent.push(Object.freeze({ name: artifact.name, bytes: artifact.byteLength, sha256: hash }));
    }
    const intendedManifest = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'backup-manifest',
      mode: 'test-only',
      rootBinding: ROOT_BINDING,
      snapshotName: snapshot.snapshotName,
      createdAt: snapshot.createdAt,
      artifacts: artifactIntent
    };
    const intendedBytes = Buffer.from(JSON.stringify(intendedManifest), 'utf8');
    const intendedHash = sha256(intendedBytes);
    return typeof record.encodedManifest === 'string'
      && intendedBytes.toString('base64') === record.encodedManifest
      && intendedHash === record.manifestSha256
      && record.totalBytes === artifactBytes + intendedBytes.byteLength
      && record.totalBytes <= MAX_STORE_BYTES;
  } catch (error) {
    rethrowCouldNotTell(error);
    return false;
  }
}

function createTestOnlyStore() {
  if (arguments.length !== 0 || totalStores >= MAX_TOTAL_STORES) return null;
  const capability = Object.freeze(Object.create(null));
  storeRecords.set(capability, { snapshots: new Map(), totalBytes: 0 });
  totalStores += 1;
  return capability;
}

function isStore(value) {
  try {
    return value !== null && typeof value === 'object' && !isProxy(value) && storeRecords.has(value);
  } catch (error) {
    rethrowCouldNotTell(error);
    return false;
  }
}

function writeTestOnlyBackup(input) {
  try {
    const request = snapshotExactDataObject(input, WRITE_INPUT_KEYS);
    if (request === null || !isStore(request.store)) return uncommitted(null, 'Q37_TEST_ONLY_INPUT_REFUSED');
    const snapshot = canonicalSnapshot(request.snapshotName);
    if (snapshot === null) return uncommitted(null, 'Q37_TEST_ONLY_INPUT_REFUSED');
    const copiedArtifacts = snapshotArtifacts(request.artifacts);
    if (copiedArtifacts === null) return uncommitted(snapshot.snapshotName, 'Q37_TEST_ONLY_INPUT_REFUSED');
    const record = prepareRecord(snapshot, copiedArtifacts);
    if (record === null) return uncommitted(snapshot.snapshotName, 'Q37_LIMIT_REFUSED');
    const state = storeRecords.get(request.store);
    if (!state || state.snapshots.has(snapshot.snapshotName)) return uncommitted(snapshot.snapshotName, 'Q37_DUPLICATE_REFUSED');
    if (state.snapshots.size >= MAX_SNAPSHOTS || state.totalBytes > MAX_STORE_BYTES - record.totalBytes) {
      return uncommitted(snapshot.snapshotName, 'Q37_LIMIT_REFUSED');
    }
    if (totalStoreBytes > MAX_TOTAL_STORE_BYTES - record.totalBytes) {
      return uncommitted(snapshot.snapshotName, 'Q37_LIMIT_REFUSED');
    }
    if (!verifiesPreparedRecord(record)) return uncommitted(snapshot.snapshotName, 'Q37_VERIFICATION_REFUSED');

    // This is the sole commit operation. It is synchronous and private; no
    // caller-controlled callback, destination, or intermediate state participates.
    state.snapshots.set(snapshot.snapshotName, record);
    state.totalBytes += record.totalBytes;
    totalStoreBytes += record.totalBytes;
    return result(snapshot.snapshotName, 'committed', 'Q37_TEST_ONLY_COMMITTED', record.manifestSha256, record.artifactSha256);
  } catch (error) {
    if (isCouldNotTell(error)) return indeterminateWrite(null);
    return uncommitted(null, 'Q37_TEST_ONLY_INPUT_REFUSED');
  }
}

function verifyTestOnlyRestoreContract(input) {
  try {
    const request = snapshotExactDataObject(input, VERIFY_INPUT_KEYS);
    if (request === null || !isStore(request.store)) return verification(null, 'unavailable');
    const snapshot = canonicalSnapshot(request.snapshotName);
    if (snapshot === null) return verification(null, 'unavailable');
    const state = storeRecords.get(request.store);
    const record = state && state.snapshots.get(snapshot.snapshotName);
    return verifiesPreparedRecord(record)
      ? verification(snapshot.snapshotName, 'verified')
      : verification(snapshot.snapshotName, 'unavailable');
  } catch (error) {
    if (isCouldNotTell(error)) return indeterminateVerification(null);
    return verification(null, 'unavailable');
  }
}

function refuseRetentionDeletion() {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    kind: 'backup-retention',
    status: 'refused',
    code: 'Q37_DELETION_REFUSED',
    artifactsDeleted: 0,
    productionActivation: 'disabled'
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  TEST_STORE_KIND,
  MANIFEST_NAME,
  MAX_ARTIFACT_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_STORE_BYTES,
  MAX_SNAPSHOTS,
  MAX_TOTAL_STORES,
  MAX_TOTAL_STORE_BYTES,
  RESTORE_VERIFICATION_CONTRACT,
  createTestOnlyStore,
  verifyTestOnlyRestoreContract,
  writeTestOnlyBackup,
  refuseRetentionDeletion
});
