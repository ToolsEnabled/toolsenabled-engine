'use strict';

// Controller-owned, manual boundary for Q39's fixed elevated collector.  This
// does not read a snapshot, select a task, schedule a retry, or retain state.
// The only permitted effect is one call to the existing no-argument refresh
// adapter after the HTTP layer has rejected every request parameter.

const refresh = require('./process-visibility-refresh.js');

const OPERATION_ID = refresh.OPERATION_ID;
const RECEIPTS = Object.freeze({
  refreshed: Object.freeze({ code: 'PROCESS_VISIBILITY_REFRESHED', optional: 'helperStarted' }),
  refused: Object.freeze({ code: 'PROCESS_VISIBILITY_REFRESH_REFUSED' }),
  failed: Object.freeze({ code: 'PROCESS_VISIBILITY_REFRESH_FAILED' }),
  unknown: Object.freeze({ code: 'PROCESS_VISIBILITY_REFRESH_UNKNOWN', optional: 'outcomeUnknown' })
});

function failed() {
  return Object.freeze({
    operationId: OPERATION_ID,
    status: 'failed',
    code: 'PROCESS_VISIBILITY_REFRESH_FAILED'
  });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// This is a projection boundary: do not spread an upstream receipt.  It is
// deliberately strict so a future helper diagnostic cannot become a browser
// data channel through the control-plane action.
function sanitizeReceipt(value) {
  try {
    if (!plain(value)) return failed();
    const status = value.status;
    const specification = RECEIPTS[status];
    if (!specification || value.operationId !== OPERATION_ID || value.code !== specification.code) return failed();

    const expected = ['operationId', 'status', 'code'];
    if (specification.optional) expected.push(specification.optional);
    // Reflect.ownKeys sees hidden and symbolic fields that Object.keys would
    // silently omit. A hidden source diagnostic must fail the projection, not
    // be tolerated just because it is non-enumerable.
    const actual = Reflect.ownKeys(value);
    if (actual.length !== expected.length || actual.some(key => typeof key !== 'string' || !expected.includes(key))) return failed();
    const descriptors = {};
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return failed();
      descriptors[key] = descriptor;
    }
    if (status === 'refreshed' && specification.optional && typeof descriptors.helperStarted.value !== 'boolean') return failed();
    if (status === 'unknown' && descriptors.outcomeUnknown.value !== true) return failed();

    const receipt = { operationId: OPERATION_ID, status, code: specification.code };
    if (status === 'refreshed' && descriptors.helperStarted) receipt.helperStarted = descriptors.helperStarted.value;
    if (status === 'unknown') receipt.outcomeUnknown = true;
    return Object.freeze(receipt);
  } catch {
    return failed();
  }
}

function argumentsRefused() {
  return Object.freeze({
    operationId: OPERATION_ID,
    status: 'refused',
    code: 'PROCESS_VISIBILITY_REFRESH_ARGS_REFUSED'
  });
}

function createProcessVisibilityRefreshControllerRoute({ refreshProcessVisibility } = {}) {
  // The injected function is a closed test seam.  The production default is
  // resolved only at action time and receives no argument, option, selector,
  // path, snapshot, or retry directive.
  const invokeRefresh = typeof refreshProcessVisibility === 'function'
    ? refreshProcessVisibility
    : () => refresh.refreshProcessVisibility();

  return Object.freeze({
    async invoke(...args) {
      if (args.length !== 0) return argumentsRefused();
      try {
        return sanitizeReceipt(await invokeRefresh());
      } catch {
        return failed();
      }
    }
  });
}

module.exports = Object.freeze({
  OPERATION_ID,
  argumentsRefused,
  createProcessVisibilityRefreshControllerRoute,
  failed,
  sanitizeReceipt
});
