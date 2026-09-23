'use strict';

// Single resolver for cross-machine and local ToolsEnabled service
// endpoints. A caller asks BY ROLE ("shared-agent-bus", "peer-tool-bridge")
// and gets back a resolved {host, port, url, ...} or a fail-closed refusal
// carrying a specific, named reason. It never invents a default and never
// falls back to a plausible-looking localhost guess.
//
// WHY THIS EXISTS. On a real two-machine deployment, a literal http URL for
// the shared bus was once hardcoded -- and it turned out to be the LOCAL
// machine's own address, not the peer's. Hours were then spent concluding, in
// writing, that the peer machine was silent. It was not: the bus service runs
// on BOTH machines, each bound to its own address, as two independent,
// non-federated logs -- and only one machine's copy is the canonical shared
// bus. A port answering is not evidence it is the RIGHT listener.
//
// Data lives in config/service-registry.json; that file's header comment
// documents the four resolution kinds (fixed/peer/self/loopback) and why
// there are four instead of two (collapsing 'self' and 'loopback' into one
// "local" mode was tried while writing this module and produces a real bug:
// the link-bus diagnostic entry needs this machine's own direct-link
// address, not 127.0.0.1, because that listener does not bind loopback).
//
// Contract:
//   - resolveService() does no network I/O. It is pure identity/config
//     resolution and is safe to call from any code path, including hot
//     ones, with no side effects.
//   - it never calls getSecret or reads any vault material. A registry
//     entry's "tokenVaultKey" is a KEY NAME -- the same kind of constant
//     already public in source -- never a credential value. This module
//     has no code path that could emit one.
//   - every failure is Object.freeze({ok:false, service, code, reason}).
//     SERVICE_UNKNOWN means the role does not exist. SERVICE_*_UNKNOWN for
//     machine identity means "I cannot tell", which is a DIFFERENT fact
//     from "it is down" -- callers must not conflate them.
//   - this module itself does no network I/O at all. The one function that
//     did -- resolveAndProbe(), one bounded read-only GET to a resolved
//     service's declared health path, classified UP / DOWN / UNKNOWN -- now
//     lives in ./service-registry-probe.js; see that file's header for why
//     it was split out. This module starts, stops, restarts, or configures
//     nothing, and now provably cannot reach the network to do so either.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const { rootPath } = require('./runtime');

const RESOLUTIONS = new Set(['fixed', 'peer', 'self', 'loopback']);
const LOOPBACK_ADDRESS = '127.0.0.1';

class ServiceRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceRegistryError';
    this.code = code;
  }
}

function registryPath() {
  return rootPath('config', 'service-registry.json');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function freezeShallowMap(object) {
  return Object.freeze(Object.fromEntries(Object.keys(object).map(key => [key, Object.freeze({ ...object[key] })])));
}

function validateRegistry(value, sourceLabel) {
  if (!isPlainObject(value) || value.schemaVersion !== 1 || !isPlainObject(value.machines) || !isPlainObject(value.services)) {
    throw new ServiceRegistryError('SERVICE_REGISTRY_INVALID', `The service registry (${sourceLabel}) has an unrecognized shape.`);
  }
  const machineIds = Object.keys(value.machines);
  if (machineIds.length === 0) {
    throw new ServiceRegistryError('SERVICE_REGISTRY_EMPTY', `The service registry (${sourceLabel}) declares no machines.`);
  }
  const machineAddresses = new Set();
  for (const machineId of machineIds) {
    const machine = value.machines[machineId];
    if (!isPlainObject(machine) || typeof machine.address !== 'string' || !net.isIPv4(machine.address)) {
      throw new ServiceRegistryError('SERVICE_REGISTRY_INVALID', `Registry machine "${machineId}" (${sourceLabel}) has no valid IPv4 address.`);
    }
    if (machineAddresses.has(machine.address)) {
      throw new ServiceRegistryError('SERVICE_REGISTRY_INVALID', `Registry machine "${machineId}" (${sourceLabel}) duplicates another machine address.`);
    }
    machineAddresses.add(machine.address);
  }
  for (const serviceId of Object.keys(value.services)) {
    const service = value.services[serviceId];
    if (!isPlainObject(service) || !RESOLUTIONS.has(service.resolution) ||
        !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) {
      throw new ServiceRegistryError('SERVICE_REGISTRY_INVALID', `Registry entry "${serviceId}" (${sourceLabel}) is malformed.`);
    }
    if (service.resolution === 'fixed' && !Object.hasOwn(value.machines, service.fixedMachine || '')) {
      throw new ServiceRegistryError('SERVICE_REGISTRY_INVALID',
        `Registry entry "${serviceId}" (${sourceLabel}) declares resolution "fixed" but "fixedMachine" is not a known machine.`);
    }
    if (Object.hasOwn(service, 'healthPort') &&
        (!Number.isInteger(service.healthPort) || service.healthPort < 1 || service.healthPort > 65535)) {
      throw new ServiceRegistryError('SERVICE_REGISTRY_INVALID', `Registry entry "${serviceId}" (${sourceLabel}) has an invalid healthPort.`);
    }
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    machines: freezeShallowMap(value.machines),
    services: freezeShallowMap(value.services)
  });
}

let cache = null; // { path, registry } -- only populated for the real on-disk registry.

function loadRegistry(options = {}) {
  if (Object.hasOwn(options, 'registry')) return validateRegistry(options.registry, '<injected>');
  const path = options.registryPath || registryPath();
  if (!options.noCache && cache && cache.path === path) return cache.registry;
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (error) {
    throw new ServiceRegistryError('SERVICE_REGISTRY_UNAVAILABLE',
      `The service registry could not be read at ${path}: ${(error && error.code) || 'unknown error'}.`);
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new ServiceRegistryError('SERVICE_REGISTRY_INVALID', `The service registry at ${path} is not valid JSON.`); }
  const registry = validateRegistry(parsed, path);
  if (!options.noCache) cache = { path, registry };
  return registry;
}

function resetRegistryCache() { cache = null; }

// THE DECLARED PORT FOR A SERVICE, FOR BOTH ENDS OF A CONNECTION.
//
// A port that only the LISTENER reads is not configurable -- it is a way to
// break the pair. peerMachineForAddress() already resolves the peer's address
// from this registry while every dialler took its port from its own module
// constant, so moving a port moved the listener and nothing else, and the two
// ends simply never met with nothing naming the cause. This lives here, beside
// the address resolution, so both halves read the same declaration.
//
// `fallback` is the caller's shipped default and is returned when the registry
// declares no port for the service -- an older or hand-trimmed registry must not
// leave a lane portless.
//
// An unavailable or malformed registry throws. "I could not look" is not
// "this service has no declaration", and neither case may quietly start a
// listener on the default while the operator believes they moved it.
function declaredPort(serviceId, fallback, options = {}) {
  const registry = loadRegistry(options);
  const declared = registry.services && registry.services[serviceId] && registry.services[serviceId].port;
  return declared === undefined ? fallback : declared;
}

// --- sanctioned machine addresses ----------------------------------------
//
// This is the one derivation point for every JavaScript caller that needs to
// decide whether an address may represent this machine or its peer. The
// matcher is built only from a fully validated registry, so an unavailable,
// malformed, empty, or ambiguous registry cannot degrade into an empty check
// that a caller accidentally interprets as permissive.

function buildMachineAddressPolicy(registry) {
  const entries = Object.freeze(Object.entries(registry.machines).map(([machineId, machine]) => Object.freeze({
    machineId,
    address: machine.address,
    ...(typeof machine.root === 'string' ? { root: machine.root } : {}),
    ...(typeof machine.role === 'string' ? { role: machine.role } : {})
  })));
  const byAddress = new Map(entries.map(entry => [entry.address, entry]));
  return Object.freeze({
    entries,
    addresses: Object.freeze(entries.map(entry => entry.address)),
    has(address) {
      return typeof address === 'string' && net.isIPv4(address) && byAddress.has(address);
    },
    machineForAddress(address) {
      return typeof address === 'string' && net.isIPv4(address)
        ? byAddress.get(address) || null
        : null;
    }
  });
}

function machineAddressPolicy(options = {}) {
  // Address authorization is a live security boundary, not a convenience
  // lookup. Never reuse the general service-resolution cache here: if the
  // registry is removed or becomes malformed after an earlier valid read,
  // the next authorization must refuse rather than trust stale addresses.
  const currentOptions = Object.hasOwn(options, 'registry')
    ? options
    : { ...options, noCache: true };
  return buildMachineAddressPolicy(loadRegistry(currentOptions));
}

function assertSanctionedMachineAddress(address, options = {}) {
  if (typeof address !== 'string' || !net.isIPv4(address)) {
    throw new ServiceRegistryError('SERVICE_MACHINE_ADDRESS_INVALID', 'Machine address must be a well-formed IPv4 address.');
  }
  const policy = machineAddressPolicy(options);
  const machine = policy.machineForAddress(address);
  if (!machine) {
    throw new ServiceRegistryError('SERVICE_MACHINE_ADDRESS_UNSANCTIONED', `Address "${address}" is not declared for a known machine.`);
  }
  return machine;
}

function machineForId(machineId, options = {}) {
  if (typeof machineId !== 'string' || !machineId) {
    throw new ServiceRegistryError('SERVICE_MACHINE_ID_INVALID', 'Machine id must be a non-empty string.');
  }
  const policy = machineAddressPolicy(options);
  const machine = policy.entries.find(entry => entry.machineId === machineId);
  if (!machine) {
    throw new ServiceRegistryError('SERVICE_MACHINE_UNKNOWN', `Machine "${machineId}" is not declared in the service registry.`);
  }
  return machine;
}

function ipv4Ordinal(address) {
  if (typeof address !== 'string' || !net.isIPv4(address)) {
    throw new ServiceRegistryError('SERVICE_MACHINE_ADDRESS_INVALID', 'Machine address must be a well-formed IPv4 address.');
  }
  return address.split('.').reduce((value, octet) => (value * 256) + Number(octet), 0);
}

// FRA and direct-link enrollment need stable wire direction without assigning
// product meaning to a customer's machine names. Preserve the established
// mechanical rule: the lower IPv4 address coordinates/minters; the higher
// address receives. Exactly two validated registry machines are required.
function directionalMachinePair(options = {}) {
  const policy = machineAddressPolicy(options);
  if (policy.entries.length !== 2) {
    throw new ServiceRegistryError('SERVICE_PEER_UNDETERMINED',
      `Expected exactly two direct-link machines; found ${policy.entries.length}.`);
  }
  const ordered = [...policy.entries].sort((left, right) => ipv4Ordinal(left.address) - ipv4Ordinal(right.address));
  return Object.freeze({
    coordinatorMachine: ordered[0],
    recipientMachine: ordered[1]
  });
}

function peerMachineForAddress(address, options = {}) {
  const policy = machineAddressPolicy(options);
  if (typeof address !== 'string' || !net.isIPv4(address)) {
    throw new ServiceRegistryError('SERVICE_MACHINE_ADDRESS_INVALID', 'Machine address must be a well-formed IPv4 address.');
  }
  const local = policy.machineForAddress(address);
  if (!local) {
    throw new ServiceRegistryError('SERVICE_MACHINE_ADDRESS_UNSANCTIONED', `Address "${address}" is not declared for a known machine.`);
  }
  const peers = policy.entries.filter(entry => entry.machineId !== local.machineId);
  if (peers.length !== 1) {
    throw new ServiceRegistryError('SERVICE_PEER_UNDETERMINED',
      `Expected exactly one peer machine besides "${local.machineId}"; found ${peers.length}.`);
  }
  return peers[0];
}

// --- local machine identity ----------------------------------------------
//
// "peer" and "self" both need to know which of the two registered
// direct-link machines this process is running on. Detection is by matching
// this host's own IPv4 interface addresses against the registry -- the same
// technique already used independently in
// src/lib/providers/agent-comms.js#detectLocalMachine, kept here rather than
// imported to avoid pulling that provider's broker/fabric/state-store
// dependency chain into a pure resolver. Both fail closed identically:
// zero matches or more than one match is SERVICE_LOCAL_MACHINE_UNKNOWN, not
// a guess.

function detectLocalMachineId(registry, options = {}) {
  if (typeof options.from === 'string' && options.from) {
    if (!Object.hasOwn(registry.machines, options.from)) {
      return { ok: false, code: 'SERVICE_MACHINE_UNKNOWN', reason: `"${options.from}" is not a machine in the service registry.` };
    }
    return { ok: true, machineId: options.from };
  }
  const networkInterfaces = options.networkInterfaces || os.networkInterfaces;
  const policy = buildMachineAddressPolicy(registry);
  let interfaceMap;
  try { interfaceMap = networkInterfaces() || {}; }
  catch (error) {
    return {
      ok: false, code: 'SERVICE_LOCAL_MACHINE_UNKNOWN',
      reason: `Local network interfaces could not be read (${(error && error.message) || 'unknown error'}); this is "cannot see", not "not running".`
    };
  }
  const matches = new Set();
  for (const entries of Object.values(interfaceMap)) {
    for (const entry of entries || []) {
      if (entry && entry.family === 'IPv4') {
        const machine = policy.machineForAddress(entry.address);
        if (machine) matches.add(machine.machineId);
      }
    }
  }
  if (matches.size === 0) {
    return {
      ok: false, code: 'SERVICE_LOCAL_MACHINE_UNKNOWN',
      reason: 'No configured direct-link machine address is visible on this host. This is "cannot see", not "not running": neither registered machine could be confirmed.'
    };
  }
  if (matches.size > 1) {
    return { ok: false, code: 'SERVICE_LOCAL_MACHINE_UNKNOWN', reason: 'More than one configured direct-link machine address is visible on this host; local machine identity is ambiguous.' };
  }
  return { ok: true, machineId: [...matches][0] };
}

// --- resolution ------------------------------------------------------------

function serviceUrl(transport, address, port) {
  return transport === 'http' ? `http://${address}:${port}` : `${address}:${port}`;
}

function buildResolution({ serviceId, service, machineId, address }) {
  return Object.freeze({
    ok: true,
    service: serviceId,
    displayName: service.displayName || serviceId,
    purpose: service.purpose || null,
    transport: service.transport,
    resolution: service.resolution,
    // ownerMachineId is null only for 'loopback': that role names no
    // registry machine at all, deliberately, because it is always this
    // process's own host regardless of which machine that is.
    ownerMachineId: machineId,
    host: address,
    port: service.port,
    url: serviceUrl(service.transport, address, service.port),
    peerReachable: service.peerReachable === true,
    ...(Object.hasOwn(service, 'healthPath') ? { healthPath: service.healthPath } : {}),
    ...(Object.hasOwn(service, 'healthPort') ? { healthPort: service.healthPort } : {}),
    ...(Object.hasOwn(service, 'messagesPath') ? { messagesPath: service.messagesPath } : {}),
    // A vault KEY NAME, never a value. See module header.
    ...(Object.hasOwn(service, 'tokenVaultKey') ? { tokenVaultKey: service.tokenVaultKey } : {})
  });
}

function refuse(serviceId, code, reason) {
  return Object.freeze({ ok: false, service: serviceId, code, reason });
}

/**
 * Resolve a service role to a concrete endpoint. Never throws for an
 * ordinary "don't know" outcome -- check `.ok`. Does no network I/O.
 */
function resolveService(serviceId, options = {}) {
  if (typeof serviceId !== 'string' || !serviceId) {
    return refuse(String(serviceId || ''), 'SERVICE_ID_INVALID', 'A service id must be a non-empty string.');
  }
  let registry;
  try { registry = loadRegistry(options); }
  catch (error) {
    if (error instanceof ServiceRegistryError) return refuse(serviceId, error.code, error.message);
    return refuse(serviceId, 'SERVICE_REGISTRY_UNAVAILABLE', (error && error.message) || 'The service registry could not be loaded.');
  }

  const service = registry.services[serviceId];
  if (!service) {
    return refuse(serviceId, 'SERVICE_UNKNOWN',
      `"${serviceId}" is not a registered service. Known services: ${Object.keys(registry.services).sort().join(', ')}.`);
  }

  if (service.resolution === 'loopback') {
    return buildResolution({ serviceId, service, machineId: null, address: LOOPBACK_ADDRESS });
  }

  if (service.resolution === 'fixed') {
    const machineId = service.fixedMachine;
    const machine = registry.machines[machineId];
    if (!machine) return refuse(serviceId, 'SERVICE_MACHINE_UNKNOWN', `Registry entry "${serviceId}" names an unknown fixed machine "${machineId}".`);
    return buildResolution({ serviceId, service, machineId, address: machine.address });
  }

  if (service.resolution === 'self') {
    const detected = detectLocalMachineId(registry, options);
    if (!detected.ok) return refuse(serviceId, detected.code, detected.reason);
    return buildResolution({ serviceId, service, machineId: detected.machineId, address: registry.machines[detected.machineId].address });
  }

  if (service.resolution === 'peer') {
    const detected = detectLocalMachineId(registry, options);
    if (!detected.ok) return refuse(serviceId, detected.code, detected.reason);
    const peerIds = Object.keys(registry.machines).filter(id => id !== detected.machineId);
    if (peerIds.length !== 1) {
      return refuse(serviceId, 'SERVICE_PEER_UNDETERMINED',
        `Expected exactly one peer machine for "${serviceId}" besides "${detected.machineId}"; found ${peerIds.length}.`);
    }
    return buildResolution({ serviceId, service, machineId: peerIds[0], address: registry.machines[peerIds[0]].address });
  }

  // Unreachable given validateRegistry's RESOLUTIONS check, kept as a named
  // refusal rather than an assertion so a future resolution kind added to
  // the data file without a matching branch here fails closed, not silently.
  return refuse(serviceId, 'SERVICE_RESOLUTION_UNSUPPORTED', `Registry entry "${serviceId}" declares an unsupported resolution mode "${service.resolution}".`);
}

/** Same as resolveService, but throws ServiceRegistryError on refusal. */
function resolveServiceOrThrow(serviceId, options = {}) {
  const result = resolveService(serviceId, options);
  if (!result.ok) throw new ServiceRegistryError(result.code, `${serviceId}: ${result.reason}`);
  return result;
}

function listServices(options = {}) {
  const registry = loadRegistry(options);
  return Object.freeze(Object.keys(registry.services).sort());
}

// The only network I/O built on top of this module -- resolveAndProbe() and
// its defaultHttpProbe() -- lives in ./service-registry-probe.js, not here.
// See that file's header for why: this module must stay reachable from
// tools/health-observer.js's dependency graph with zero networking capability
// anywhere in its own source text, a real invariant that file's own test
// enforces textually -- even a reference to the http module's name written
// only in a comment, as an example, is enough to trip it, which is exactly
// what an earlier draft of this sentence did. Require './service-registry-probe'
// only from a caller that actually wants the network probe.

module.exports = Object.freeze({
  ServiceRegistryError,
  registryPath,
  loadRegistry,
  resetRegistryCache,
  declaredPort,
  machineAddressPolicy,
  assertSanctionedMachineAddress,
  machineForId,
  directionalMachinePair,
  peerMachineForAddress,
  detectLocalMachineId,
  resolveService,
  resolveServiceOrThrow,
  listServices
});
