'use strict';

// Fail-closed capability manifest for Full Remote Access.  This is deliberately
// an exact-name filter: it never expands a namespace into a runtime wildcard.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TRANSPORT_POLICY_DESCRIPTOR } = require('./fra-transport-binding');
const { machineConfigPath, FraMachineIdentityError } = require('./fra-machine-identity');

const SCHEMA_VERSION = 5;
const MANIFEST_BASENAME = 'fra-capability-manifest';
const NAME_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const ALWAYS_BLOCKED_NAMESPACES = new Set(['clipboard']);
const DESKTOP_NAMESPACES = new Set(['screen', 'ocr']);
const REQUIRED_EXCLUDED_TOOLS = new Set([
  'clipboard.read', 'clipboard.write',
  'host.exec', 'host.list_dir', 'host.patch_file', 'host.read_file', 'host.write_file',
  'repo.list_dir', 'repo.patch_file', 'repo.read_file', 'repo.write_file'
]);

class FraCapabilityManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FraCapabilityManifestError';
    this.code = code;
  }
}

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');

// B26. The manifest is named after the machine's stable registry IDENTITY, not
// its address, so moving this machine to another network is one edit to
// config/service-registry.json and renames nothing. `host` may still be the
// address -- every existing caller passes one -- but it is now looked up
// rather than interpolated into a filename. See fra-machine-identity.js.
function resolveManifestPath(host, serviceRegistryOptions = {}, { root = REPOSITORY_ROOT, fsApi } = {}) {
  try {
    return machineConfigPath({
      root,
      basename: MANIFEST_BASENAME,
      selector: host,
      serviceRegistryOptions,
      ...(fsApi ? { fsApi } : {})
    });
  } catch (error) {
    if (error instanceof FraMachineIdentityError
        && ['FRA_MACHINE_IDENTITY_INVALID', 'FRA_MACHINE_IDENTITY_UNSANCTIONED', 'FRA_MACHINE_ID_INVALID'].includes(error.code)) {
      fail('FRA_MANIFEST_HOST_INVALID', 'manifest host must name one registry-sanctioned machine.');
    }
    throw error;
  }
}

function manifestPathForHost(host, serviceRegistryOptions = {}) {
  return resolveManifestPath(host, serviceRegistryOptions).path;
}

function fail(code, message) {
  throw new FraCapabilityManifestError(code, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function registryNames(registry) {
  if (!Array.isArray(registry)) fail('FRA_MANIFEST_REGISTRY_INVALID', 'registry must be an array of tool definitions.');
  const names = registry.map(entry => entry && entry.name);
  if (names.some(name => typeof name !== 'string' || !NAME_RE.test(name))) {
    fail('FRA_MANIFEST_REGISTRY_INVALID', 'registry contains an invalid tool name.');
  }
  const sorted = [...names].sort();
  if (new Set(sorted).size !== sorted.length) fail('FRA_MANIFEST_REGISTRY_INVALID', 'registry contains duplicate tool names.');
  return sorted;
}

function registryNameDigest(registry) {
  return toolNameDigest(registryNames(registry));
}

function toolNameDigest(names) {
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !NAME_RE.test(name))) {
    fail('FRA_MANIFEST_SCHEMA_INVALID', 'tool names must be a valid array.');
  }
  return crypto.createHash('sha256').update([...names].sort().join('\n'), 'utf8').digest('hex');
}

function assertSortedUnique(values, label, pattern) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !pattern.test(value))) {
    fail('FRA_MANIFEST_SCHEMA_INVALID', `${label} must be an array of valid names.`);
  }
  const sorted = [...values].sort();
  if (sorted.length !== values.length || sorted.some((value, index) => value !== values[index]) || new Set(values).size !== values.length) {
    fail('FRA_MANIFEST_SCHEMA_INVALID', `${label} must be sorted and unique.`);
  }
}

function validateDeclaration(manifest) {
  if (!isPlainObject(manifest)) fail('FRA_MANIFEST_SCHEMA_INVALID', 'manifest must be a plain object.');
  const keys = Object.keys(manifest).sort();
  const expected = ['allowedToolCount', 'allowedToolNamesDigest', 'allowedTools', 'desktopCapabilities', 'excludedTools', 'registryNameDigest', 'schemaVersion', 'transportPolicy'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail('FRA_MANIFEST_SCHEMA_INVALID', 'manifest has unsupported or missing fields.');
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) fail('FRA_MANIFEST_VERSION_INVALID', 'manifest schema version is unsupported.');
  if (typeof manifest.registryNameDigest !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.registryNameDigest)) {
    fail('FRA_MANIFEST_SCHEMA_INVALID', 'registryNameDigest must be a SHA-256 hex digest.');
  }
  if (typeof manifest.allowedToolNamesDigest !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.allowedToolNamesDigest)) {
    fail('FRA_MANIFEST_SCHEMA_INVALID', 'allowedToolNamesDigest must be a SHA-256 hex digest.');
  }
  if (!Number.isSafeInteger(manifest.allowedToolCount) || manifest.allowedToolCount < 1 || manifest.allowedToolCount > 10000) {
    fail('FRA_MANIFEST_SCHEMA_INVALID', 'allowedToolCount must be a bounded positive integer.');
  }
  assertSortedUnique(manifest.allowedTools, 'allowedTools', NAME_RE);
  assertSortedUnique(manifest.excludedTools, 'excludedTools', NAME_RE);
  if (!isPlainObject(manifest.desktopCapabilities)
      || Object.keys(manifest.desktopCapabilities).sort().join(',') !== 'clipboard,ocr,screenCapture'
      || typeof manifest.desktopCapabilities.screenCapture !== 'boolean'
      || typeof manifest.desktopCapabilities.ocr !== 'boolean'
      || manifest.desktopCapabilities.clipboard !== false) {
    fail('FRA_MANIFEST_SCHEMA_INVALID', 'desktopCapabilities must be one exact signed per-machine desktop policy.');
  }
  const transportKeys = Object.keys(TRANSPORT_POLICY_DESCRIPTOR).sort();
  if (!isPlainObject(manifest.transportPolicy)
      || Object.keys(manifest.transportPolicy).sort().join(',') !== transportKeys.join(',')
      || transportKeys.some(key => manifest.transportPolicy[key] !== TRANSPORT_POLICY_DESCRIPTOR[key])) {
    fail('FRA_MANIFEST_SCHEMA_INVALID', 'transportPolicy must match the closed FRA transport boundary.');
  }
  if (manifest.allowedTools.some(name => ALWAYS_BLOCKED_NAMESPACES.has(name.slice(0, name.indexOf('.'))))) {
    fail('FRA_MANIFEST_SAFETY_INVALID', 'clipboard is never allowed through FRA.');
  }
  const hasScreen = manifest.allowedTools.some(name => name.startsWith('screen.'));
  const hasOcr = manifest.allowedTools.includes('ocr.read');
  if (hasScreen !== manifest.desktopCapabilities.screenCapture
      || hasOcr !== manifest.desktopCapabilities.ocr) {
    fail('FRA_MANIFEST_SAFETY_INVALID', 'desktop namespaces must exactly match desktopCapabilities.');
  }
  for (const required of REQUIRED_EXCLUDED_TOOLS) {
    if (!manifest.excludedTools.includes(required)) {
      fail('FRA_MANIFEST_SAFETY_INVALID', `${required} must be explicitly excluded from FRA.`);
    }
  }
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    registryNameDigest: manifest.registryNameDigest,
    allowedToolNamesDigest: manifest.allowedToolNamesDigest,
    allowedToolCount: manifest.allowedToolCount,
    allowedTools: Object.freeze([...manifest.allowedTools]),
    excludedTools: Object.freeze([...manifest.excludedTools]),
    desktopCapabilities: Object.freeze({ ...manifest.desktopCapabilities }),
    transportPolicy: Object.freeze({ ...manifest.transportPolicy })
  });
}

function validateManifest(manifest, { registry } = {}) {
  const declaration = validateDeclaration(manifest);

  const names = registryNames(registry);
  const nameSet = new Set(names);
  if (declaration.allowedTools.some(name => !nameSet.has(name))) {
    fail('FRA_MANIFEST_SCHEMA_INVALID', 'allowedTools must name current registry tools only.');
  }
  if (declaration.excludedTools.some(name => !nameSet.has(name))) {
    fail('FRA_MANIFEST_SCHEMA_INVALID', 'excludedTools must name current registry tools only.');
  }
  if (declaration.allowedTools.some(name => declaration.excludedTools.includes(name))) {
    fail('FRA_MANIFEST_SAFETY_INVALID', 'allowedTools and excludedTools must be disjoint.');
  }
  if (registryNameDigest(registry) !== declaration.registryNameDigest) {
    fail('FRA_MANIFEST_DIGEST_MISMATCH', 'registry tool names do not match the pinned FRA manifest.');
  }

  const allowed = [...declaration.allowedTools];
  if (allowed.some(name => name === 'host.exec' || ALWAYS_BLOCKED_NAMESPACES.has(name.slice(0, name.indexOf('.'))))) {
    fail('FRA_MANIFEST_SAFETY_INVALID', 'FRA computed an unsafe tool capability.');
  }
  if (allowed.some(name => DESKTOP_NAMESPACES.has(name.slice(0, name.indexOf('.'))))
      && !(declaration.desktopCapabilities.screenCapture && declaration.desktopCapabilities.ocr)) {
    fail('FRA_MANIFEST_SAFETY_INVALID', 'FRA desktop tools require the exact owner-authorized desktop policy.');
  }
  if (allowed.length !== declaration.allowedToolCount || toolNameDigest(allowed) !== declaration.allowedToolNamesDigest) {
    fail('FRA_MANIFEST_CAPABILITY_MISMATCH', 'computed FRA tools do not match the pinned capability set.');
  }
  return Object.freeze({
    ...declaration,
    allowedToolNames: Object.freeze(allowed)
  });
}

function readManifest({
  host,
  serviceRegistryOptions = {},
  manifestPath = host ? manifestPathForHost(host, serviceRegistryOptions) : '',
  readFile = fs.readFileSync
} = {}) {
  if (typeof manifestPath !== 'string' || !manifestPath) fail('FRA_MANIFEST_PATH_INVALID', 'manifestPath must be a non-empty path.');
  let parsed;
  try {
    parsed = JSON.parse(readFile(manifestPath, 'utf8'));
  } catch (error) {
    fail('FRA_MANIFEST_LOAD_FAILED', `FRA manifest could not be loaded: ${error && error.code === 'ENOENT' ? 'not found' : 'invalid JSON'}.`);
  }
  return parsed;
}

function loadManifest({ registry, ...options } = {}) {
  return validateManifest(readManifest(options), { registry });
}

function loadManifestDeclaration(options = {}) {
  return validateDeclaration(readManifest(options));
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  TRANSPORT_POLICY_DESCRIPTOR,
  MANIFEST_BASENAME,
  ALWAYS_BLOCKED_NAMESPACES,
  DESKTOP_NAMESPACES,
  REQUIRED_EXCLUDED_TOOLS,
  FraCapabilityManifestError,
  resolveManifestPath,
  manifestPathForHost,
  registryNameDigest,
  toolNameDigest,
  validateDeclaration,
  validateManifest,
  loadManifest,
  loadManifestDeclaration
});
