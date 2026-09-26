'use strict';
// Host-owned reader; never expose its dependency injection or accept renderer selectors.
const os = require('node:os');
const crypto = require('node:crypto');
const serviceRegistry = require('./service-registry');
const refuse = (code, reason) => Object.freeze({ ok: false, code, reason });
function createLocalFleetIdentityReader({
  readRegistry = () => serviceRegistry.loadRegistry({ noCache: true }),
  networkInterfaces = () => os.networkInterfaces(),
} = {}) {
  if (typeof readRegistry !== 'function' || typeof networkInterfaces !== 'function') throw new TypeError('Host readers required');
  return Object.freeze({
    read() {
      let registry;
      try { registry = serviceRegistry.loadRegistry({ registry: readRegistry() }); }
      catch (error) { return refuse(error?.code === 'SERVICE_REGISTRY_UNAVAILABLE' ? error.code : 'SERVICE_REGISTRY_INVALID', 'The local machine registry could not be validated.'); }
      let interfaces;
      try {
        const raw = networkInterfaces();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Missing interfaces');
        interfaces = Object.fromEntries(Object.entries(raw).map(([key, entries]) => [key,
          Array.isArray(entries) ? entries.map(entry => ({ family: entry?.family, address: entry?.address })) : []]));
      } catch { return refuse('FLEET_LOCAL_MACHINE_UNKNOWN', 'Local network interfaces could not be read.'); }
      const detected = serviceRegistry.detectLocalMachineId(registry, { networkInterfaces: () => interfaces });
      if (!detected.ok) {
        const present = new Set(Object.values(interfaces).flat().filter(entry => entry.family === 'IPv4').map(entry => entry.address));
        const matches = Object.values(registry.machines).filter(machine => present.has(machine.address)).length;
        return refuse(matches > 1 ? 'FLEET_LOCAL_MACHINE_AMBIGUOUS' : 'FLEET_LOCAL_MACHINE_UNKNOWN',
          matches > 1 ? 'More than one registered machine matches this host.' : 'No registered machine could be confirmed on this host.');
      }
      const id = detected.machineId;
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id) || id === 'this-computer') {
        return refuse('FLEET_MACHINE_ID_UNSUPPORTED', 'The registered machine ID cannot represent a distinct fleet host.');
      }
      const mapping = Object.keys(registry.machines).sort().map(key => [key, registry.machines[key].address]);
      const authorityRevision = crypto.createHash('sha256').update(JSON.stringify(['local-fleet-identity/v1', id, mapping])).digest('hex');
      return Object.freeze({ ok: true, computerId: id, registryMachineId: id, authorityRevision });
    }
  });
}
// Compares identifiers; never migrates saved conversation/history keys.
function verifyProjectedComputerId(computerId, binding) {
  if (!binding?.ok) return binding || refuse('FLEET_LOCAL_MACHINE_UNKNOWN', 'Local identity is unavailable.');
  if (computerId !== binding.computerId) return refuse('FLEET_PROJECTED_ID_UNBOUND', 'This projected ID has no verified local-host binding; preserve its history under its existing ID.');
  return binding;
}
module.exports = Object.freeze({ createLocalFleetIdentityReader, verifyProjectedComputerId });
