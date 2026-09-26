'use strict';

// Customer-neutral two-machine topology for tests that exercise paired
// services. TEST-NET-1 addresses can never name a customer's real machines,
// and the production loader still validates the exact same registry shape.
// The fixture is injected only while the subject module is loaded; the tracked
// one-machine shipped default is never rewritten, even when suites run in
// parallel.
const Module = require('node:module');
const path = require('node:path');

const serviceRegistryPath = require.resolve('../../src/lib/service-registry');
const serviceRegistry = require(serviceRegistryPath);
const ROOT = path.resolve(__dirname, '..', '..');

const registryInput = Object.freeze({
  schemaVersion: 1,
  machines: Object.freeze({
    'machine-a': Object.freeze({
      address: '192.0.2.10',
      root: ROOT,
      role: 'installation-host'
    }),
    'machine-b': Object.freeze({
      address: '192.0.2.11',
      root: path.join(ROOT, '.test-peer-root'),
      role: 'paired-host'
    })
  }),
  services: Object.freeze({
    dashboard: Object.freeze({ resolution: 'loopback', port: 3889 }),
    'full-remote-access': Object.freeze({ resolution: 'peer', port: 8790 }),
    'peer-tool-bridge': Object.freeze({ resolution: 'peer', port: 8788 }),
    'shared-agent-bus': Object.freeze({ resolution: 'fixed', fixedMachine: 'machine-a', port: 8787 })
  })
});

const registry = serviceRegistry.loadRegistry({ registry: registryInput });

function explicitOrFixture(options) {
  return options && Object.keys(options).length > 0 ? options : { registry: registryInput };
}

const injectedServiceRegistry = Object.freeze({
  ...serviceRegistry,
  loadRegistry: options => serviceRegistry.loadRegistry(explicitOrFixture(options)),
  declaredPort: (serviceId, fallback, options) => serviceRegistry.declaredPort(
    serviceId, fallback, explicitOrFixture(options)),
  machineAddressPolicy: options => serviceRegistry.machineAddressPolicy(explicitOrFixture(options)),
  assertSanctionedMachineAddress: (address, options) => serviceRegistry.assertSanctionedMachineAddress(
    address, explicitOrFixture(options)),
  machineForId: (machineId, options) => serviceRegistry.machineForId(
    machineId, explicitOrFixture(options)),
  directionalMachinePair: options => serviceRegistry.directionalMachinePair(explicitOrFixture(options)),
  peerMachineForAddress: (address, options) => serviceRegistry.peerMachineForAddress(
    address, explicitOrFixture(options)),
  resolveService: (serviceId, options) => serviceRegistry.resolveService(
    serviceId, explicitOrFixture(options)),
  resolveServiceOrThrow: (serviceId, options) => serviceRegistry.resolveServiceOrThrow(
    serviceId, explicitOrFixture(options)),
  listServices: options => serviceRegistry.listServices(explicitOrFixture(options))
});

function loadWithPairedServiceRegistry(load) {
  const originalLoad = Module._load;
  Module._load = function loadWithFixture(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === serviceRegistryPath) return injectedServiceRegistry;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return load({ registry, registryInput, serviceRegistry: injectedServiceRegistry });
  } finally {
    Module._load = originalLoad;
  }
}

module.exports = Object.freeze({
  injectedServiceRegistry,
  loadWithPairedServiceRegistry,
  registry,
  registryInput
});
