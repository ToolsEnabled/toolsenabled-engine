'use strict';

// FRA's per-machine files used to be named after the machine's IP address. A
// machine that moves to a different network is still the same machine, with the
// same role and the same server counterpart -- but on the new network FRA would
// have looked for a manifest named after the NEW address, found nothing, and
// refused to configure. These tests pin the replacement:
// the file is named after the machine's stable registry identity, an address
// is only ever a way to NAME a machine, and a machine id is validated before
// it is allowed to become a path component.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MACHINE_ID_RE, FraMachineIdentityError, isFilenameSafeMachineId,
  assertFilenameSafeMachineId, resolveMachineIdentity, machineConfigPath
} = require('../src/lib/fra-machine-identity');

function code(fn, expected) {
  assert.throws(fn, error => error instanceof FraMachineIdentityError && error.code === expected);
}

const lab = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '192.0.2.2', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '192.0.2.1', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
};
// The SAME two machines after such a move.
const moved = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.41', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '203.0.113.42', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
};

// --- an address is a way to name a machine, not the machine -----------------
const byAddress = resolveMachineIdentity('192.0.2.2', { registry: lab });
assert.equal(byAddress.machineId, 'machine-a');
assert.equal(byAddress.address, '192.0.2.2');
assert.equal(byAddress.role, 'development-host');
assert.equal(byAddress.root, 'C:\\a');
assert.equal(byAddress.selectorKind, 'address');
const byId = resolveMachineIdentity('machine-a', { registry: lab });
assert.equal(byId.machineId, 'machine-a');
assert.equal(byId.selectorKind, 'machine-id');
assert.equal(byId.address, '192.0.2.2');

// --- refusals are named, never guesses --------------------------------------
code(() => resolveMachineIdentity('192.0.2.99', { registry: lab }), 'FRA_MACHINE_IDENTITY_UNSANCTIONED');
code(() => resolveMachineIdentity('machine-z', { registry: lab }), 'FRA_MACHINE_IDENTITY_UNSANCTIONED');
code(() => resolveMachineIdentity('', { registry: lab }), 'FRA_MACHINE_IDENTITY_INVALID');
code(() => resolveMachineIdentity(null, { registry: lab }), 'FRA_MACHINE_IDENTITY_INVALID');
code(() => resolveMachineIdentity('x'.repeat(300), { registry: lab }), 'FRA_MACHINE_IDENTITY_INVALID');

// --- a machine id becomes a filename, so it is validated, not sanitized ------
assert.equal(MACHINE_ID_RE.test('machine-a'), true);
assert.equal(isFilenameSafeMachineId('machine-a'), true);
for (const hostile of ['../../evil', 'a/b', 'a\\b', 'Machine-A', 'a..b', '', '-lead', 'trail-', '10.0.0.5', 'x'.repeat(65)]) {
  assert.equal(isFilenameSafeMachineId(hostile), false, `${hostile} must never become a path component`);
  code(() => assertFilenameSafeMachineId(hostile), 'FRA_MACHINE_ID_INVALID');
}
const traversal = { schemaVersion: 1, machines: { '../../evil': { address: '10.9.9.9' } }, services: {} };
code(() => resolveMachineIdentity('10.9.9.9', { registry: traversal }), 'FRA_MACHINE_ID_INVALID');
code(() => resolveMachineIdentity('../../evil', { registry: traversal }), 'FRA_MACHINE_ID_INVALID');

// --- the move, without moving -----------------------------------------------
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-machine-identity-'));
try {
  fs.mkdirSync(path.join(directory, 'config'));
  const before = machineConfigPath({
    root: directory, basename: 'fra-capability-manifest', selector: '192.0.2.2', serviceRegistryOptions: { registry: lab }
  });
  const after = machineConfigPath({
    root: directory, basename: 'fra-capability-manifest', selector: '203.0.113.41', serviceRegistryOptions: { registry: moved }
  });
  assert.equal(before.path, after.path, 'a new address for the same machine must resolve to the same file');
  assert.match(before.path, /fra-capability-manifest\.machine-a\.json$/);
  assert.equal(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(before.path), false,
    'no address may survive into a resolved FRA config path');
  assert.equal(before.keying, 'machine-id');

  // --- the migration ramp for the IP-named files that already exist ---------
  const legacy = path.join(directory, 'config', 'fra-capability-manifest.192.0.2.2.json');
  fs.writeFileSync(legacy, '{}\n', 'utf8');
  const ramped = machineConfigPath({
    root: directory, basename: 'fra-capability-manifest', selector: '192.0.2.2', serviceRegistryOptions: { registry: lab }
  });
  assert.equal(ramped.path, legacy, 'an existing legacy address-named file is still read');
  assert.equal(ramped.keying, 'legacy-address');
  assert.equal(ramped.identityPath, before.path,
    'identityPath is the canonical name even while the legacy file is being read, so a write migrates forward');

  // Once the identity-keyed file exists it wins outright, and the legacy one
  // stops being consulted -- the ramp only ever runs one way.
  fs.writeFileSync(before.path, '{}\n', 'utf8');
  const migrated = machineConfigPath({
    root: directory, basename: 'fra-capability-manifest', selector: '192.0.2.2', serviceRegistryOptions: { registry: lab }
  });
  assert.equal(migrated.path, before.path);
  assert.equal(migrated.keying, 'machine-id');

  // A legacy file belonging to the OTHER machine is never reachable through
  // this machine's identity: the legacy name is derived from the registry
  // entry, not from whatever the caller typed.
  const peerLegacy = machineConfigPath({
    root: directory, basename: 'fra-capability-manifest', selector: 'machine-b', serviceRegistryOptions: { registry: lab }
  });
  assert.equal(peerLegacy.legacyPath, path.join(directory, 'config', 'fra-capability-manifest.192.0.2.1.json'));

  code(() => machineConfigPath({
    root: directory, basename: 'fra capability manifest', selector: 'machine-a', serviceRegistryOptions: { registry: lab }
  }), 'FRA_MACHINE_CONFIG_BASENAME_INVALID');
  code(() => machineConfigPath({
    root: directory, basename: '../escape', selector: 'machine-a', serviceRegistryOptions: { registry: lab }
  }), 'FRA_MACHINE_CONFIG_BASENAME_INVALID');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

// --- an unreadable registry is a refusal, never an empty allowlist -----------
code(() => resolveMachineIdentity('machine-a', { registryPath: path.join(os.tmpdir(), 'no-such-service-registry.json') }),
  'FRA_MACHINE_REGISTRY_UNAVAILABLE');
code(() => resolveMachineIdentity('machine-a', { registry: { schemaVersion: 1, machines: {}, services: {} } }),
  'FRA_MACHINE_REGISTRY_UNAVAILABLE');

console.log('FRA machine identity resolves files by machine, not by address.');
