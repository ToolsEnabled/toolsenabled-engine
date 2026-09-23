'use strict';

// Q50 fixture-only contract.  This module validates the package-id and
// queue/<package-id>.md relationship without reading configuration or the
// queue and without creating a slice.  The live manifest, BUILD-QUEUE.md, and
// every consumer remain controller-owned until the migration is accepted.

const SCHEMA_VERSION = 1;
const QUEUE_DIRECTORY = 'queue';
const PACKAGE_ID_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const PHASE_ID_RE = /^Q[1-9]\d{0,2}$/;
const MANIFEST_KEYS = Object.freeze(['schemaVersion', 'packages']);
const PACKAGE_KEYS = Object.freeze(['id', 'files']);
const SLICE_KEYS = Object.freeze(['packageId', 'path', 'phaseIds']);

class QueuePackageContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QueuePackageContractError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function isPlainDataObject(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
  });
}

function isSafeRelativeFile(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..' && !/[\u0000-\u001f]/.test(part));
}

function assertPackageId(value) {
  if (typeof value !== 'string' || !PACKAGE_ID_RE.test(value)) {
    throw new QueuePackageContractError('QUEUE_PACKAGE_ID_INVALID', 'packageId must be a lowercase dotted or hyphenated identifier.', { packageId: value });
  }
  return value;
}

function queueSlicePath(packageId) {
  return `${QUEUE_DIRECTORY}/${assertPackageId(packageId)}.md`;
}

function normalizePhaseIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || !PHASE_ID_RE.test(id))) {
    throw new QueuePackageContractError('QUEUE_PACKAGE_PHASE_IDS_INVALID', 'phaseIds must be a non-empty list of Q1 through Q999 identifiers.');
  }
  if (new Set(value).size !== value.length) {
    throw new QueuePackageContractError('QUEUE_PACKAGE_PHASE_IDS_DUPLICATE', 'phaseIds must not repeat within a package slice.');
  }
  return [...value].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

function validatePackageManifest(input) {
  const errors = [];
  if (!isPlainDataObject(input, MANIFEST_KEYS)) return deepFreeze({ valid: false, errors: Object.freeze(['manifest must contain exactly schemaVersion and packages']), manifest: null });
  if (input.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!Array.isArray(input.packages) || input.packages.length === 0) {
    errors.push('packages must be a non-empty array');
  } else {
    const packageIds = new Set();
    const files = new Set();
    for (const entry of input.packages) {
      if (!isPlainDataObject(entry, PACKAGE_KEYS)) {
        errors.push('every package entry must contain exactly id and files');
        continue;
      }
      if (typeof entry.id !== 'string' || !PACKAGE_ID_RE.test(entry.id)) errors.push(`invalid package id: ${String(entry.id)}`);
      if (packageIds.has(entry.id)) errors.push(`duplicate package id: ${entry.id}`);
      packageIds.add(entry.id);
      if (!Array.isArray(entry.files)) {
        errors.push(`package ${entry.id} must have a files array`);
        continue;
      }
      const localFiles = new Set();
      for (const file of entry.files) {
        if (!isSafeRelativeFile(file)) errors.push(`package ${entry.id} contains an unsafe relative file path`);
        if (localFiles.has(file)) errors.push(`package ${entry.id} repeats file ${file}`);
        if (files.has(file)) errors.push(`file ${file} is assigned to more than one package`);
        localFiles.add(file);
        files.add(file);
      }
    }
  }
  if (errors.length) return deepFreeze({ valid: false, errors: Object.freeze(errors), manifest: null });
  const packages = input.packages.map(entry => ({ id: entry.id, files: Object.freeze([...entry.files]) }));
  return deepFreeze({ valid: true, errors: Object.freeze([]), manifest: { schemaVersion: SCHEMA_VERSION, packages } });
}

function packageMap(manifest) {
  const verdict = validatePackageManifest(manifest);
  if (!verdict.valid) throw new QueuePackageContractError('QUEUE_PACKAGE_MANIFEST_INVALID', 'package manifest is invalid.', { errors: verdict.errors });
  return { verdict, byId: new Map(verdict.manifest.packages.map(entry => [entry.id, entry])) };
}

function assertAssignments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new QueuePackageContractError('QUEUE_PACKAGE_ASSIGNMENTS_INVALID', 'assignments must be a plain object.');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new QueuePackageContractError('QUEUE_PACKAGE_ASSIGNMENTS_INVALID', 'assignment keys must be strings.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new QueuePackageContractError('QUEUE_PACKAGE_ASSIGNMENTS_INVALID', 'assignment entries must be data properties.');
    }
  }
}

function buildQueueSliceIndex({ manifest, assignments }) {
  const { byId } = packageMap(manifest);
  assertAssignments(assignments);
  const assigned = new Set();
  const slices = [];
  for (const packageId of Object.keys(assignments).sort()) {
    assertPackageId(packageId);
    if (!byId.has(packageId)) throw new QueuePackageContractError('QUEUE_PACKAGE_UNKNOWN', `assignment names unknown package ${packageId}.`);
    const phaseIds = normalizePhaseIds(assignments[packageId]);
    for (const phaseId of phaseIds) {
      if (assigned.has(phaseId)) throw new QueuePackageContractError('QUEUE_PACKAGE_PHASE_COLLISION', `${phaseId} is assigned to more than one package.`);
      assigned.add(phaseId);
    }
    slices.push({ packageId, path: queueSlicePath(packageId), phaseIds });
  }
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    queueDirectory: QUEUE_DIRECTORY,
    slices
  });
}

function validateQueueSliceIndex({ manifest, index }) {
  const { byId } = packageMap(manifest);
  if (!isPlainDataObject(index, ['schemaVersion', 'queueDirectory', 'slices'])) {
    throw new QueuePackageContractError('QUEUE_PACKAGE_INDEX_INVALID', 'queue slice index has an invalid exact schema.');
  }
  if (index.schemaVersion !== SCHEMA_VERSION || index.queueDirectory !== QUEUE_DIRECTORY || !Array.isArray(index.slices)) {
    throw new QueuePackageContractError('QUEUE_PACKAGE_INDEX_INVALID', 'queue slice index version or directory is invalid.');
  }
  const packages = new Set();
  const phases = new Set();
  const slices = [];
  for (const slice of index.slices) {
    if (!isPlainDataObject(slice, SLICE_KEYS)) throw new QueuePackageContractError('QUEUE_PACKAGE_INDEX_INVALID', 'slice entries must contain exactly packageId, path, and phaseIds.');
    assertPackageId(slice.packageId);
    if (!byId.has(slice.packageId)) throw new QueuePackageContractError('QUEUE_PACKAGE_UNKNOWN', `slice names unknown package ${slice.packageId}.`);
    if (packages.has(slice.packageId)) throw new QueuePackageContractError('QUEUE_PACKAGE_SLICE_DUPLICATE', `package ${slice.packageId} appears more than once.`);
    if (slice.path !== queueSlicePath(slice.packageId)) throw new QueuePackageContractError('QUEUE_PACKAGE_SLICE_PATH_INVALID', `slice path for ${slice.packageId} is not canonical.`);
    const phaseIds = normalizePhaseIds(slice.phaseIds);
    for (const phaseId of phaseIds) {
      if (phases.has(phaseId)) throw new QueuePackageContractError('QUEUE_PACKAGE_PHASE_COLLISION', `${phaseId} appears in more than one slice.`);
      phases.add(phaseId);
    }
    packages.add(slice.packageId);
    slices.push({ packageId: slice.packageId, path: slice.path, phaseIds });
  }
  return deepFreeze({ schemaVersion: SCHEMA_VERSION, queueDirectory: QUEUE_DIRECTORY, slices });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  QUEUE_DIRECTORY,
  PACKAGE_ID_RE,
  PHASE_ID_RE,
  QueuePackageContractError,
  assertPackageId,
  buildQueueSliceIndex,
  queueSlicePath,
  validatePackageManifest,
  validateQueueSliceIndex
});
