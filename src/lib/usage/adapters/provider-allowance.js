'use strict';

const {
  UNKNOWN_REASONS,
  measuredUsageRecord,
  unknownUsageRecord
} = require('../usage-contract');

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// Provider consoles and subscription applications do not share a stable,
// machine-readable allowance API.  An integration may inject a reader backed
// by a documented provider surface; without one this adapter must be UNKNOWN.
function createProviderAllowanceAdapter({ id, readAllowance } = {}) {
  if (typeof id !== 'string' || !id || (readAllowance !== undefined && typeof readAllowance !== 'function')) {
    throw new TypeError('Provider allowance adapter configuration is invalid.');
  }
  return Object.freeze({
    id,
    async read(account, { nowMs }) {
      if (typeof readAllowance !== 'function') {
        return unknownUsageRecord({ ...account, reason: UNKNOWN_REASONS.PROVIDER_ALLOWANCE_NOT_MACHINE_READABLE, observedAt: nowMs });
      }
      let reading;
      try {
        reading = await readAllowance(account);
      } catch {
        return unknownUsageRecord({ ...account, reason: UNKNOWN_REASONS.PROVIDER_SURFACE_UNAVAILABLE, observedAt: nowMs });
      }
      if (reading === null || reading === undefined) {
        return unknownUsageRecord({ ...account, reason: UNKNOWN_REASONS.PROVIDER_ALLOWANCE_NOT_MACHINE_READABLE, observedAt: nowMs });
      }
      if (!plain(reading) || Object.keys(reading).some(key => !['used', 'remaining', 'unit', 'resetsAt', 'observedAt'].includes(key))
        || !['used', 'remaining', 'unit', 'resetsAt', 'observedAt'].every(key => Object.hasOwn(reading, key))) {
        return unknownUsageRecord({ ...account, reason: UNKNOWN_REASONS.PROVIDER_SURFACE_INVALID, observedAt: nowMs });
      }
      try {
        return measuredUsageRecord({ ...account, ...reading });
      } catch {
        return unknownUsageRecord({ ...account, reason: UNKNOWN_REASONS.PROVIDER_SURFACE_INVALID, observedAt: nowMs });
      }
    }
  });
}

module.exports = Object.freeze({ createProviderAllowanceAdapter });
