'use strict';

// One derivation point for "which machine is this FRA file about".
//
// WHY THIS EXISTS. FRA's capability manifests and runtime anchors used to be
// named after the machine's IP address -- config/fra-capability-manifest.<that
// machine's declared address from config/service-registry.json>.json, and the
// same for fra-runtime-integrity -- because the path was built by
// interpolating the address straight into the filename. But a machine moves
// networks over its life while remaining the same machine, with the same
// role and the same server counterpart. On the new network FRA would look for
// a manifest named after the NEW address, find nothing, and refuse to
// configure: a fail-closed portability defect that no amount of correct
// registry data could fix, because the *filename* was the thing keyed on the
// address.
//
// The address is not the machine. config/service-registry.json already carries
// the stable fact -- a machine id ("machine-a"), a declared role, and a
// declared root -- and the address is one mutable attribute of it. So FRA now
// keys every per-machine file on the machine ID and treats the address purely
// as a way to NAME a machine, resolved through the registry. Moving to a new
// network becomes one edit to service-registry.json; no file is renamed and no
// anchor identity changes.
//
// WHAT THIS MODULE DOES NOT DO. It does not touch key derivation. The signed
// FRA session transcript still binds the two ADDRESSES (assertHostPair in
// fra-secure-session.js) because that is a live wire-protocol invariant with a
// peer, and changing it is a separate design decision. This module governs
// which file on disk describes which machine, nothing more.
//
// SECURITY NOTE -- machine ids become filenames. validateRegistry() in
// service-registry.js checks that every machine has a well-formed IPv4
// address, but says nothing about the shape of the machine ID key. Those keys
// are now path components, so a registry declaring a machine called
// "../../evil" would otherwise steer an anchor read outside config/. Every id
// is therefore matched against MACHINE_ID_RE before it is allowed anywhere
// near a path, and an id that fails is a refusal, not a sanitization.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { machineAddressPolicy, ServiceRegistryError } = require('./service-registry');

// Deliberately narrower than "any string that happens to be path-safe":
// lowercase alphanumerics in dash-separated groups. It matches the ids the
// registry already declares (machine-a, machine-b), cannot contain a dot (so
// an id can never be confused with the dotted-quad legacy names), cannot
// contain a separator, and cannot be a relative-path token.
const MACHINE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MACHINE_ID_MAX_LENGTH = 64;

class FraMachineIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FraMachineIdentityError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new FraMachineIdentityError(code, message);
}

function isFilenameSafeMachineId(machineId) {
  return typeof machineId === 'string'
    && machineId.length > 0
    && machineId.length <= MACHINE_ID_MAX_LENGTH
    && MACHINE_ID_RE.test(machineId)
    && !net.isIPv4(machineId);
}

function assertFilenameSafeMachineId(machineId) {
  if (!isFilenameSafeMachineId(machineId)) {
    fail('FRA_MACHINE_ID_INVALID',
      'A registry machine id used to name an FRA file must be a short lowercase dash-separated token.');
  }
  return machineId;
}

function policyOrFail(serviceRegistryOptions) {
  try {
    return machineAddressPolicy(serviceRegistryOptions);
  } catch (error) {
    if (error instanceof ServiceRegistryError) {
      fail('FRA_MACHINE_REGISTRY_UNAVAILABLE',
        'The service registry could not be read, so no FRA machine identity can be resolved.');
    }
    throw error;
  }
}

function fileExistsOrFail(filePath, fsApi) {
  try {
    fsApi.statSync(filePath);
    return true;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return false;
    }
    fail('FRA_MACHINE_CONFIG_STATUS_UNAVAILABLE',
      'An FRA per-machine config path could not be inspected, so its presence cannot be resolved.');
  }
}

/**
 * Resolve a selector -- either a registry-sanctioned IPv4 address or a
 * registry machine id -- to the stable identity of that machine.
 *
 * Accepting the address keeps every existing caller working unchanged: the
 * bridge, the proxy, the doctor and the lifecycle scripts all still speak
 * addresses. What changes is that the address is now looked UP rather than
 * interpolated into a filename.
 */
function resolveMachineIdentity(selector, serviceRegistryOptions = {}) {
  if (typeof selector !== 'string' || !selector || selector.length > 255) {
    fail('FRA_MACHINE_IDENTITY_INVALID', 'An FRA machine selector must be a non-empty address or machine id.');
  }
  const policy = policyOrFail(serviceRegistryOptions);
  const byAddress = net.isIPv4(selector);
  const machine = byAddress
    ? policy.machineForAddress(selector)
    : policy.entries.find(entry => entry.machineId === selector) || null;
  if (!machine) {
    fail('FRA_MACHINE_IDENTITY_UNSANCTIONED',
      byAddress
        ? 'That address is not declared for any machine in the service registry.'
        : 'That machine id is not declared in the service registry.');
  }
  assertFilenameSafeMachineId(machine.machineId);
  return Object.freeze({
    machineId: machine.machineId,
    address: machine.address,
    role: typeof machine.role === 'string' ? machine.role : null,
    root: typeof machine.root === 'string' ? machine.root : null,
    selectorKind: byAddress ? 'address' : 'machine-id'
  });
}

/**
 * Resolve the on-disk config path for a per-machine FRA file.
 *
 * Returns the identity-keyed path (`<basename>.<machineId>.json`) except when
 * that file is absent AND a legacy address-keyed file for the SAME machine is
 * present -- the migration ramp for the two IP-named files that already exist
 * in deployed trees. The legacy name is only ever reached through the registry
 * entry for that identity, so it can never point at a machine the registry
 * does not sanction, and a write always targets the identity-keyed name so any
 * tree that is written to migrates forward on its own.
 */
function machineConfigPath({
  root,
  basename,
  selector,
  serviceRegistryOptions = {},
  fsApi = fs
} = {}) {
  if (typeof basename !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(basename)) {
    fail('FRA_MACHINE_CONFIG_BASENAME_INVALID', 'An FRA per-machine config basename must be a plain dash-separated token.');
  }
  if (typeof root !== 'string' || root.length === 0) {
    fail('FRA_MACHINE_CONFIG_ROOT_INVALID', 'An FRA per-machine config root must be a non-empty path string.');
  }
  const identity = resolveMachineIdentity(selector, serviceRegistryOptions);
  const configDirectory = path.resolve(root, 'config');
  const identityPath = path.join(configDirectory, `${basename}.${identity.machineId}.json`);
  const legacyPath = path.join(configDirectory, `${basename}.${identity.address}.json`);

  const identityPresent = fileExistsOrFail(identityPath, fsApi);
  let legacyPresent = false;
  if (!identityPresent) {
    legacyPresent = fileExistsOrFail(legacyPath, fsApi);
  }

  return Object.freeze({
    identity,
    // The canonical name, always. A caller that WRITES uses this and never
    // `path`, so writing migrates a legacy tree forward instead of pinning it.
    identityPath,
    legacyPath,
    // What a reader should open right now.
    path: !identityPresent && legacyPresent ? legacyPath : identityPath,
    keying: !identityPresent && legacyPresent ? 'legacy-address' : 'machine-id'
  });
}

module.exports = Object.freeze({
  MACHINE_ID_RE,
  MACHINE_ID_MAX_LENGTH,
  FraMachineIdentityError,
  isFilenameSafeMachineId,
  assertFilenameSafeMachineId,
  resolveMachineIdentity,
  machineConfigPath
});
