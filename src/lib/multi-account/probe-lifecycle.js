'use strict';

const LIFECYCLES = new Set(['closed', 'not-started', 'unproven']);

// This is an in-process receipt from the provider owner. JSON/cache records
// cannot attest to process closure, even if they contain the same field name.
function probeLifecycleOf(reading) {
  if (!reading || typeof reading !== 'object') return null;
  const descriptor = Object.getOwnPropertyDescriptor(reading, 'probeLifecycle');
  return descriptor && descriptor.enumerable === false && LIFECYCLES.has(descriptor.value)
    ? descriptor.value : null;
}

function withProbeLifecycle(reading, lifecycle) {
  if (!reading || typeof reading !== 'object' || Array.isArray(reading) || !LIFECYCLES.has(lifecycle)) {
    throw new TypeError('A provider lifecycle receipt requires a reading and a known closure state.');
  }
  return Object.freeze(Object.defineProperties({}, {
    ...Object.getOwnPropertyDescriptors(reading),
    probeLifecycle: { value: lifecycle, enumerable: false, configurable: false, writable: false }
  }));
}

module.exports = Object.freeze({ probeLifecycleOf, withProbeLifecycle });
