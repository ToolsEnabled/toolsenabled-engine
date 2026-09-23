'use strict';

// One-shot, non-observing trigger for Q39's already allowlisted elevated
// collector.  This adapter deliberately does not read the resulting snapshot:
// the consumer remains the only freshness/validity authority.  Consequently a
// timeout, refusal, or failure cannot overwrite, reinterpret, or otherwise
// disturb the last known snapshot.

const uacClient = require('../uac-delegation-client.js');

const OPERATION_ID = 'collect-process-visibility';

// --- KNOWN GAP, DELIBERATELY NOT CLOSED HERE (R1534) -------------------------
//
// This is the ONE elevated operation in the product that fires with no human in
// the loop (tools/health-observer.js calls it when the process snapshot is
// unusable). Every distinct failure -- the elevated helper task was never
// registered, the kill switch refused it, the pipe is broken, it timed out --
// collapses into PROCESS_VISIBILITY_REFRESH_FAILED, so the observer log cannot
// tell an operator which one thing to fix, and the sweep then reports every
// subsystem UNKNOWN.
//
// THAT OPACITY IS INTENTIONAL AND IS LEFT ALONE ON PURPOSE. The projection
// exists so helper diagnostics cannot become a secondary data channel, and
// tests/process-visibility-refresh.test.js pins the exact receipt shape to keep
// it that way. A closed enum of this codebase's own error literals would add
// the missing signal without opening a channel -- the output alphabet stays
// finite and carries no helper-supplied text -- but changing a receipt that a
// security test pins deliberately is a decision for whoever owns supervision,
// not a side effect of an elevation audit. It is recorded in
// Desktop/ELEVATION-SURFACE.md as a named recommendation instead.
//
// Nothing here is a user-facing elevation refusal: there is no person present
// to read "what would enable it", which is why this was the right one to leave.

function outcome(fields) {
  return Object.freeze({ operationId: OPERATION_ID, ...fields });
}

function unknownOutcome() {
  return outcome({
    status: 'unknown',
    code: 'PROCESS_VISIBILITY_REFRESH_UNKNOWN',
    outcomeUnknown: true
  });
}

// This is deliberately a closed test seam rather than a general-purpose
// options bag.  Keeping the public shape exact prevents an accidental retry,
// selector, or state/snapshot channel from being smuggled into this adapter.
// Read only own *data* properties: a getter (including one supplied by a
// Proxy) is executable untrusted input, not configuration.
function fixedRunner(input) {
  if (input === undefined) return uacClient.runOperation;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;

  // Object.keys() is not a boundary: it ignores symbols and non-enumerable
  // properties.  A hidden accessor used to make this look like an empty
  // options object and accidentally select the real UAC client below.  Inspect
  // every own key and its descriptor instead.  Descriptor reads do not invoke
  // a user getter; Proxy traps are contained by refreshProcessVisibility().
  const keys = Reflect.ownKeys(input);
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'runOperation')) return null;
  if (keys.length === 0) return uacClient.runOperation;

  const descriptor = Object.getOwnPropertyDescriptor(input, 'runOperation');
  return descriptor
    && descriptor.enumerable === true
    && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && typeof descriptor.value === 'function'
    ? descriptor.value
    : null;
}

/**
 * Request exactly one fixed elevated collection attempt.
 *
 * This accepts no operation, argv, path, PID, snapshot, or retry option.  The
 * injected runner is test-only plumbing for the fixed operation contract; it
 * is always invoked once with precisely OPERATION_ID.  Returned values and
 * errors are deliberately projected to a small, stable receipt so helper
 * diagnostics and raw step output never become a secondary data channel.
 */
async function refreshProcessVisibility(input) {
  let runOperation;
  try {
    runOperation = fixedRunner(input);
  } catch {
    // A hostile Proxy must never turn this no-observation adapter into an
    // error-text channel.
    return outcome({ status: 'failed', code: 'PROCESS_VISIBILITY_REFRESH_FAILED' });
  }
  if (!runOperation) return outcome({ status: 'failed', code: 'PROCESS_VISIBILITY_REFRESH_FAILED' });

  let result;
  try {
    result = await runOperation(OPERATION_ID);
  } catch (error) {
    try {
      if (error && error.outcomeUnknown === true) {
        return unknownOutcome();
      }
    } catch {
      // The operation rejected, but an untrusted getter prevented us from
      // establishing whether its outcome is unknown.  Do not turn that failed
      // measurement into the definite assertion that the operation failed.
      return unknownOutcome();
    }
    return outcome({ status: 'failed', code: 'PROCESS_VISIBILITY_REFRESH_FAILED' });
  }

  try {
    if (result && result.ok === true && result.helperStarted === true) {
      return outcome({
        status: 'refreshed',
        code: 'PROCESS_VISIBILITY_REFRESHED',
        helperStarted: true
      });
    }

    if (result && result.decision === 'refuse') {
      return outcome({ status: 'refused', code: 'PROCESS_VISIBILITY_REFRESH_REFUSED' });
    }
  } catch {
    // Keep every property read and projection behind this boundary.  In
    // particular, a fulfilled Proxy must not leak a filesystem path through
    // a thrown getter.  Because the receipt could not be classified, preserve
    // that uncertainty rather than reporting a definite operation failure.
    return unknownOutcome();
  }

  return outcome({ status: 'failed', code: 'PROCESS_VISIBILITY_REFRESH_FAILED' });
}

module.exports = Object.freeze({
  OPERATION_ID,
  refreshProcessVisibility
});
