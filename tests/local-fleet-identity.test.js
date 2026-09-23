'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/lib/service-registry');
const { createLocalFleetIdentityReader } = require('../src/lib/local-fleet-identity');
const a = '192.0.2.10', b = '192.0.2.11'; // Reserved documentation addresses; no network IO.
const record = () => ({ schemaVersion: 1, machines: { alpha: { address: a }, beta: { address: b } }, services: {} });
const interfaces = (...addresses) => ({ fixture: addresses.map(address => ({ family: 'IPv4', address })) });
test('exact registered ID is retained, without accepting renderer override or letter mapping', () => {
  const reader = createLocalFleetIdentityReader({ readRegistry: record, networkInterfaces: () => interfaces(a) });
  const result = reader.read({ from: 'beta', computerId: 'machine-a' });
  assert.equal(result.ok, true);
  assert.equal(result.computerId, 'alpha');
  assert.equal(result.registryMachineId, 'alpha');
  assert.match(result.authorityRevision, /^[a-f0-9]{64}$/);
});
test('unknown, unreadable and ambiguous interfaces refuse by name', () => {
  for (const [read, code] of [[() => interfaces(), 'FLEET_LOCAL_MACHINE_UNKNOWN'],
    [() => { throw new Error('inert'); }, 'FLEET_LOCAL_MACHINE_UNKNOWN'],
    [() => interfaces(a, b), 'FLEET_LOCAL_MACHINE_AMBIGUOUS']]) {
    assert.equal(createLocalFleetIdentityReader({ readRegistry: record, networkInterfaces: read }).read().code, code);
  }
});
test('registry failures never become a default local identity', () => {
  for (const readRegistry of [() => null, () => ({ schemaVersion: 1, machines: {}, services: {} })]) {
    assert.equal(createLocalFleetIdentityReader({ readRegistry, networkInterfaces: () => interfaces(a) }).read().ok, false);
  }
  const readRegistry = () => { throw new registry.ServiceRegistryError('SERVICE_REGISTRY_UNAVAILABLE', 'inert'); };
  assert.equal(createLocalFleetIdentityReader({ readRegistry }).read().code, 'SERVICE_REGISTRY_UNAVAILABLE');
});
test('revision is stable across ordering and changes with registry authority; reads are fresh', () => {
  let value = record();
  const reader = createLocalFleetIdentityReader({ readRegistry: () => value, networkInterfaces: () => interfaces(a) });
  const first = reader.read();
  value = { ...value, machines: { beta: value.machines.beta, alpha: value.machines.alpha } };
  assert.equal(reader.read().authorityRevision, first.authorityRevision);
  value = { ...value, machines: { alpha: { address: a }, beta: { address: '192.0.2.12' } } };
  assert.notEqual(reader.read().authorityRevision, first.authorityRevision);
  value = null;
  assert.equal(reader.read().ok, false);
});
test('declared-local reserved ID is never aliased to registered host', () => {
  const readRegistry = () => ({ schemaVersion: 1, machines: { 'this-computer': { address: a } }, services: {} });
  assert.equal(createLocalFleetIdentityReader({ readRegistry, networkInterfaces: () => interfaces(a) }).read().code, 'FLEET_MACHINE_ID_UNSUPPORTED');
});

test('legacy letter IDs and remote IDs stay unbound; exact canonical ID alone matches', () => {
  const { verifyProjectedComputerId } = require('../src/lib/local-fleet-identity');
  const binding = createLocalFleetIdentityReader({ readRegistry: record, networkInterfaces: () => interfaces(a) }).read();
  for (const id of ['machine-a', 'beta', 'this-computer']) {
    assert.equal(verifyProjectedComputerId(id, binding).code, 'FLEET_PROJECTED_ID_UNBOUND');
  }
  assert.equal(verifyProjectedComputerId('alpha', binding), binding);
  const refusal = { ok: false, code: 'FLEET_LOCAL_MACHINE_UNKNOWN' };
  assert.equal(verifyProjectedComputerId('alpha', refusal), refusal);
});
