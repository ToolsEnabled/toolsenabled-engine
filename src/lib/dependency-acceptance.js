'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_REGISTRY_FILE = path.join(ROOT, 'config', 'dependency-acceptance.json');
const DEFAULT_PACKAGE_FILE = path.join(ROOT, 'package.json');
const SCHEMA_VERSION = 'dependency-acceptance-v1';
const DEPENDENCY_KINDS = Object.freeze(['crypto', 'protocol', 'other']);
const REUSE_TYPES = Object.freeze([
  'generic-primitive',
  'protocol-implementation',
  'product-sdk',
  'hosted-service'
]);
const BLOCKING_EVENTS = Object.freeze(['distribution', 'shipping', 'third-party-interaction']);

function acceptanceError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function nonEmpty(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw acceptanceError('DEPENDENCY_ACCEPTANCE_INVALID', `${field} must be a non-empty single-line string of at most ${max} characters.`, { field });
  }
  return value.trim();
}

function normalizeName(value) {
  const name = nonEmpty(value, 'name');
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw acceptanceError('DEPENDENCY_ACCEPTANCE_INVALID', 'name must be a bare package name without a version or URL.', { field: 'name' });
  }
  return name.toLowerCase();
}

function normalizeRecord(input, capturedAt = new Date().toISOString()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw acceptanceError('DEPENDENCY_ACCEPTANCE_INVALID', 'dependency record must be an object.');
  }
  const name = normalizeName(input.name);
  const kind = nonEmpty(input.kind, 'kind', 40).toLowerCase();
  if (!DEPENDENCY_KINDS.includes(kind)) {
    throw acceptanceError('DEPENDENCY_ACCEPTANCE_INVALID', `kind must be one of: ${DEPENDENCY_KINDS.join(', ')}.`, { field: 'kind' });
  }
  const sensitive = kind === 'crypto' || kind === 'protocol';
  let license = null;
  let reuseType = null;
  if (sensitive) {
    license = nonEmpty(input.license, 'license', 120);
    reuseType = nonEmpty(input.reuseType, 'reuseType', 80).toLowerCase();
    if (!REUSE_TYPES.includes(reuseType)) {
      throw acceptanceError('DEPENDENCY_ACCEPTANCE_INVALID', `reuseType must be one of: ${REUSE_TYPES.join(', ')}.`, { field: 'reuseType' });
    }
  } else if (input.license !== undefined || input.reuseType !== undefined) {
    license = input.license == null ? null : nonEmpty(input.license, 'license', 120);
    reuseType = input.reuseType == null ? null : nonEmpty(input.reuseType, 'reuseType', 80).toLowerCase();
    if (reuseType !== null && !REUSE_TYPES.includes(reuseType)) {
      throw acceptanceError('DEPENDENCY_ACCEPTANCE_INVALID', `reuseType must be one of: ${REUSE_TYPES.join(', ')}.`, { field: 'reuseType' });
    }
  }
  return Object.freeze({
    name,
    kind,
    license,
    reuseType,
    capturedAt: nonEmpty(capturedAt, 'capturedAt', 80)
  });
}

function validateRegistry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== SCHEMA_VERSION
      || !Array.isArray(value.baselineDependencies) || !Array.isArray(value.records)) {
    throw acceptanceError('DEPENDENCY_ACCEPTANCE_REGISTRY_INVALID', `registry must use ${SCHEMA_VERSION}.`);
  }
  const baselineDependencies = value.baselineDependencies.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw acceptanceError('DEPENDENCY_ACCEPTANCE_REGISTRY_INVALID', 'baseline dependency entries must be objects.');
    }
    return Object.freeze({ name: normalizeName(entry.name), reason: nonEmpty(entry.reason, 'reason', 300) });
  });
  const records = value.records.map((entry) => normalizeRecord(entry, entry && entry.capturedAt));
  const names = [...baselineDependencies.map((entry) => entry.name), ...records.map((entry) => entry.name)];
  if (new Set(names).size !== names.length) {
    throw acceptanceError('DEPENDENCY_ACCEPTANCE_REGISTRY_INVALID', 'baseline and captured dependency names must be unique.');
  }
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, baselineDependencies, records });
}

function readRegistry(registryFile = DEFAULT_REGISTRY_FILE, fsApi = fs) {
  let parsed;
  try { parsed = JSON.parse(fsApi.readFileSync(registryFile, 'utf8')); }
  catch (error) {
    throw acceptanceError('DEPENDENCY_ACCEPTANCE_REGISTRY_UNAVAILABLE', `cannot read ${registryFile}.`, { cause: error });
  }
  return validateRegistry(parsed);
}

function readPackageDependencyNames(packageFile = DEFAULT_PACKAGE_FILE, fsApi = fs) {
  let parsed;
  try { parsed = JSON.parse(fsApi.readFileSync(packageFile, 'utf8')); }
  catch (error) {
    throw acceptanceError('DEPENDENCY_ACCEPTANCE_PACKAGE_UNAVAILABLE', `cannot read ${packageFile}.`, { cause: error });
  }
  const names = new Set();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const entries = parsed[field];
    if (entries === undefined) continue;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw acceptanceError('DEPENDENCY_ACCEPTANCE_PACKAGE_INVALID', `package.json ${field} must be an object.`);
    }
    for (const name of Object.keys(entries)) names.add(normalizeName(name));
  }
  return [...names].sort();
}

function writeRegistry(value, registryFile = DEFAULT_REGISTRY_FILE, fsApi = fs) {
  const directory = path.dirname(registryFile);
  fsApi.mkdirSync(directory, { recursive: true });
  const temporary = `${registryFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fsApi.writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx' });
    fsApi.renameSync(temporary, registryFile);
  } finally {
    try { fsApi.unlinkSync(temporary); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  }
}

function captureDependency(input, options = {}) {
  const registryFile = options.registryFile || DEFAULT_REGISTRY_FILE;
  const fsApi = options.fsApi || fs;
  const record = normalizeRecord(input, options.capturedAt || new Date().toISOString());
  const registry = readRegistry(registryFile, fsApi);
  if (registry.baselineDependencies.some((entry) => entry.name === record.name)) {
    throw acceptanceError('DEPENDENCY_ACCEPTANCE_BASELINE_CONFLICT', `${record.name} is already recorded in the pre-gate baseline.`);
  }
  const records = registry.records.filter((entry) => entry.name !== record.name).map((entry) => ({ ...entry }));
  records.push({ ...record });
  records.sort((left, right) => left.name.localeCompare(right.name));
  writeRegistry({
    schemaVersion: SCHEMA_VERSION,
    baselineDependencies: registry.baselineDependencies.map((entry) => ({ ...entry })),
    records
  }, registryFile, fsApi);
  return record;
}

function assertEventAllowed(options = {}) {
  const event = nonEmpty(options.event, 'event', 80).toLowerCase();
  if (!BLOCKING_EVENTS.includes(event)) {
    throw acceptanceError('DEPENDENCY_ACCEPTANCE_EVENT_INVALID', `event must be one of: ${BLOCKING_EVENTS.join(', ')}.`, { event });
  }
  const registry = readRegistry(options.registryFile || DEFAULT_REGISTRY_FILE, options.fsApi || fs);
  const dependencies = readPackageDependencyNames(options.packageFile || DEFAULT_PACKAGE_FILE, options.fsApi || fs);
  const covered = new Set([
    ...registry.baselineDependencies.map((entry) => entry.name),
    ...registry.records.map((entry) => entry.name)
  ]);
  const unclassified = dependencies.filter((name) => !covered.has(name));
  if (unclassified.length > 0) {
    throw acceptanceError(
      'DEPENDENCY_ACCEPTANCE_REQUIRED',
      `${event} is blocked until new dependencies are classified through tools/dependency-acceptance.js: ${unclassified.join(', ')}.`,
      { event, unclassified }
    );
  }
  return Object.freeze({
    event,
    dependencyCount: dependencies.length,
    capturedCount: registry.records.length,
    sensitive: registry.records.filter((entry) => entry.kind !== 'other').map((entry) => ({ ...entry }))
  });
}

module.exports = Object.freeze({
  ROOT,
  DEFAULT_REGISTRY_FILE,
  DEFAULT_PACKAGE_FILE,
  SCHEMA_VERSION,
  DEPENDENCY_KINDS,
  REUSE_TYPES,
  BLOCKING_EVENTS,
  normalizeRecord,
  validateRegistry,
  readRegistry,
  readPackageDependencyNames,
  captureDependency,
  assertEventAllowed
});
