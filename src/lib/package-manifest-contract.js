'use strict';

// Q46's manifest contract is deliberately pure.  It validates a parsed JSON
// value only; reading config/packages.json, walking the repository, and
// reporting require() edges belong to the later report-only checker.

const SCHEMA_VERSION = 1;
const SOURCE_CATEGORIES = Object.freeze(['sidecars', 'src', 'tools']);
const PACKAGE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_ID_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PACKAGES = 2_000;
const MAX_FILES_PER_PACKAGE = 20_000;
const MAX_PATH_LENGTH = 512;

class PackageManifestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PackageManifestError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PackageManifestError(code, message, details);
}

function ownDataObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('PACKAGE_MANIFEST_INVALID', `${label} must be an object.`, { field: label });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('PACKAGE_MANIFEST_UNSAFE_OBJECT', `${label} must not inherit a custom prototype.`, { field: label });
  }
  const fields = new Map();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      fail('PACKAGE_MANIFEST_UNSAFE_OBJECT', `${label} must not contain symbol fields.`, { field: label });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      fail('PACKAGE_MANIFEST_UNSAFE_OBJECT', `${label}.${key} must be an enumerable data field.`, { field: `${label}.${key}` });
    }
    fields.set(key, descriptor.value);
  }
  const unsafeKeys = [...fields.keys()].filter(key => RESERVED_ID_SEGMENTS.has(key));
  if (unsafeKeys.length) {
    fail('PACKAGE_MANIFEST_UNSAFE_OBJECT', `${label} contains a reserved object field.`, { field: label, unsafeKeys });
  }
  return fields;
}

function exactObject(value, label, allowed, required) {
  const fields = ownDataObject(value, label);
  const unknown = [...fields.keys()].filter(key => !allowed.includes(key));
  const missing = required.filter(key => !fields.has(key));
  if (unknown.length || missing.length) {
    fail('PACKAGE_MANIFEST_UNKNOWN_FIELD', `${label} has unknown or missing fields.`, { field: label, unknown, missing });
  }
  return fields;
}

function dataArray(value, label, { min = 0, max = MAX_FILES_PER_PACKAGE } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max) {
    fail('PACKAGE_MANIFEST_INVALID', `${label} must be a bounded plain array.`, { field: label });
  }
  const values = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      fail('PACKAGE_MANIFEST_UNSAFE_OBJECT', `${label}[${index}] must be an enumerable data value.`, { field: `${label}[${index}]` });
    }
    values.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length' || (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < value.length)) continue;
    fail('PACKAGE_MANIFEST_UNSAFE_OBJECT', `${label} must not contain extra fields.`, { field: label });
  }
  return values;
}

function normalizePackageId(value, label = 'package id') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) {
    fail('PACKAGE_MANIFEST_INVALID_ID', `${label} must be a lowercase dotted or hyphenated package id.`, { field: label });
  }
  if (value.split(/[.-]/).some(segment => RESERVED_ID_SEGMENTS.has(segment))) {
    fail('PACKAGE_MANIFEST_UNSAFE_OBJECT', `${label} contains a reserved identifier segment.`, { field: label });
  }
  if (!PACKAGE_ID.test(value)) {
    fail('PACKAGE_MANIFEST_INVALID_ID', `${label} must be a lowercase dotted or hyphenated package id.`, { field: label });
  }
  return value;
}

function normalizeRepoRelativePath(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PATH_LENGTH
    || value !== value.trim() || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    fail('PACKAGE_MANIFEST_INVALID_PATH', `${label} must be a safe repository-relative path.`, { field: label });
  }
  const parts = value.split('/');
  if (parts.length < 2 || !SOURCE_CATEGORIES.includes(parts[0]) || !value.endsWith('.js') || parts.some(part => !PATH_SEGMENT.test(part))) {
    fail('PACKAGE_MANIFEST_INVALID_PATH', `${label} must name a JS file under src/, tools/, or sidecars/.`, { field: label });
  }
  return value;
}

function freezePackage(entry) {
  return Object.freeze({ id: entry.id, files: Object.freeze([...entry.files]) });
}

/**
 * Normalize a parsed Q46 package manifest without touching the filesystem.
 *
 * Input shape:
 * { schemaVersion: 1, packages: [{ id: 'kernel.audit', files: ['src/lib/audit.js'] }] }
 */
function normalizePackageManifest(input) {
  const manifest = exactObject(input, 'manifest', ['schemaVersion', 'packages'], ['schemaVersion', 'packages']);
  if (manifest.get('schemaVersion') !== SCHEMA_VERSION) {
    fail('PACKAGE_MANIFEST_INVALID', 'manifest.schemaVersion is unsupported.', { field: 'manifest.schemaVersion' });
  }
  const rawPackages = dataArray(manifest.get('packages'), 'manifest.packages', { min: 1, max: MAX_PACKAGES });
  const packageIds = new Set();
  const fileClaims = new Set();
  const categories = new Set();
  const packages = rawPackages.map((rawPackage, index) => {
    const entry = exactObject(rawPackage, `manifest.packages[${index}]`, ['id', 'files'], ['id', 'files']);
    const id = normalizePackageId(entry.get('id'), `manifest.packages[${index}].id`);
    if (packageIds.has(id)) {
      fail('PACKAGE_MANIFEST_DUPLICATE_PACKAGE', 'Package ids must be unique.', { field: `manifest.packages[${index}].id`, id });
    }
    packageIds.add(id);
    // A protocol-only package may own no JavaScript files.  Its charter and
    // queue slice are still first-class package boundaries, while source
    // ownership remains exhaustive through the separate claims array.
    const files = dataArray(entry.get('files'), `manifest.packages[${index}].files`).map((value, fileIndex) => {
      const file = normalizeRepoRelativePath(value, `manifest.packages[${index}].files[${fileIndex}]`);
      if (fileClaims.has(file)) {
        fail('PACKAGE_MANIFEST_DUPLICATE_CLAIM', 'A source file may belong to exactly one package.', { field: `manifest.packages[${index}].files[${fileIndex}]`, file });
      }
      fileClaims.add(file);
      categories.add(file.split('/', 1)[0]);
      return file;
    }).sort((left, right) => left.localeCompare(right, 'en'));
    return { id, files };
  });
  const missingCategories = SOURCE_CATEGORIES.filter(category => !categories.has(category));
  if (missingCategories.length) {
    fail('PACKAGE_MANIFEST_MISSING_SOURCE_CATEGORY', 'The package manifest must claim src/, tools/, and sidecars/ source files.', { missingCategories });
  }
  const normalizedPackages = packages.sort((left, right) => left.id.localeCompare(right.id, 'en')).map(freezePackage);
  const claims = normalizedPackages.flatMap(entry => entry.files.map(file => Object.freeze({ file, packageId: entry.id })))
    .sort((left, right) => left.file.localeCompare(right.file, 'en'));
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    packages: Object.freeze(normalizedPackages),
    claims: Object.freeze(claims),
    sourceCategories: Object.freeze([...SOURCE_CATEGORIES])
  });
}

module.exports = {
  PACKAGE_MANIFEST_SCHEMA_VERSION: SCHEMA_VERSION,
  PACKAGE_SOURCE_CATEGORIES: SOURCE_CATEGORIES,
  PackageManifestError,
  normalizePackageId,
  normalizeRepoRelativePath,
  normalizePackageManifest
};
