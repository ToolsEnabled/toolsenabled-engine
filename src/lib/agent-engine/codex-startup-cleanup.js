'use strict';

const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

function validateCleanupTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError('Codex startup cleanup timeout must be a positive bounded integer');
  }
}

async function boundedCleanup(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Codex process cleanup did not finish within its deadline');
          error.code = 'CODEX_PROCESS_CLEANUP_TIMEOUT';
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally { clearTimeout(timer); }
}

// Receipts can contain the private pipe token. Keep only the non-secret
// outcome fields in diagnostics; the owned ChildProcess stays in the closure.
function receiptEvidence(receipt) {
  if (!receipt || typeof receipt !== 'object') return null;
  return Object.freeze({
    type: ['terminated', 'exit', 'not-started', 'wrapper-terminated'].includes(receipt.type) ? receipt.type : null,
    activeProcesses: Number.isSafeInteger(receipt.activeProcesses) ? receipt.activeProcesses : null,
    exitCode: Number.isInteger(receipt.exitCode) ? receipt.exitCode : null,
    failed: Boolean(receipt.failure)
  });
}

function provesEmptyJob(receipt) {
  return receipt && ['terminated', 'exit'].includes(receipt.type)
    && receipt.activeProcesses === 0 && !receipt.failed;
}

function createStartupCleanup(child) {
  let closed = false;
  let spawnFailed = false;
  let inFlight = null;
  let closureInFlight = null;
  let observedOutcome = null;
  const confirmedOutcomeWaiters = new Set();
  if (child.jobOutcome && typeof child.jobOutcome.then === 'function') {
    child.jobOutcome.then(receipt => {
      observedOutcome = receiptEvidence(receipt);
      notifyConfirmedOutcome();
    }, () => {});
  }
  const closedPromise = new Promise(resolve => {
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
      notifyConfirmedOutcome();
    });
  });
  child.once('error', () => {
    // Node has no retained process handle when spawn itself failed.
    if (child.pid === undefined) spawnFailed = true;
  });

  function confirmedOutcome() {
    // Only the retained jobOutcome may attest that admission refused before
    // OWNER authorization. The wrapper must actually have closed; a kill
    // request or wrapper-only receipt cannot manufacture a never-created root.
    return provesEmptyJob(observedOutcome) || (closed && observedOutcome?.type === 'not-started'
      && observedOutcome.activeProcesses === 0 && !observedOutcome.failed);
  }

  function notifyConfirmedOutcome() {
    if (confirmedOutcome()) {
      for (const resolve of confirmedOutcomeWaiters) resolve(observedOutcome);
    }
  }

  async function awaitJobCleanup(operation, timeoutMs) {
    if (confirmedOutcome()) return observedOutcome;
    let onConfirmedOutcome;
    const confirmed = new Promise(resolve => {
      onConfirmedOutcome = resolve;
      confirmedOutcomeWaiters.add(resolve);
    });
    try {
      // Retained evidence may finish while a separate request is stalled.
      // A genuine empty-job receipt, or never-started plus actual close, may
      // release it; neither a failed receipt nor wrapper exit alone may do so.
      return await boundedCleanup(() => Promise.race([
        Promise.resolve().then(operation), confirmed
      ]), timeoutMs);
    } finally {
      // Failed retries must not accumulate listeners on a pending outcome.
      confirmedOutcomeWaiters.delete(onConfirmedOutcome);
    }
  }

  async function run(timeoutMs) {
    const errors = [];
    let termination = null;
    let fallback = null;
    if (typeof child.terminateJob === 'function') {
      // terminateJob retains a failed control-request promise. The original
      // authenticated status channel can still later prove an empty job; keep
      // that evidence so retry does not remain stuck on the failed request.
      if (confirmedOutcome()) return observedOutcome;
      try {
        const receipt = await awaitJobCleanup(() => child.terminateJob(), timeoutMs);
        if (confirmedOutcome()) return observedOutcome;
        termination = receiptEvidence(receipt);
        if (!provesEmptyJob(termination)) {
          throw new Error('Codex job cleanup returned no zero-process receipt');
        }
        return termination;
      } catch (error) { errors.push(error); }
      if (confirmedOutcome()) return observedOutcome;

      // Ending the retained wrapper is useful recovery, but is not a measured
      // zero-process receipt. Preserve the failed confirmation even when this
      // fallback succeeds; a later retry may observe a valid job receipt.
      if (typeof child.terminateRetainedWrapper === 'function') {
        try {
          fallback = receiptEvidence(await awaitJobCleanup(() => child.terminateRetainedWrapper(), timeoutMs));
        } catch (error) { errors.push(error); }
      }
      // The retained close/outcome can arrive while the fallback is pending.
      // Accept that separate evidence, never the wrapper-only fallback itself.
      if (confirmedOutcome()) return observedOutcome;
    } else {
      try {
        await boundedCleanup(async () => {
          if (!closed && !spawnFailed) child.kill('SIGKILL');
          await closedPromise;
        }, timeoutMs);
        if (spawnFailed) return Object.freeze({ type: 'not-started', activeProcesses: 0 });
        errors.push(new Error('Only the direct Codex child was confirmed closed; descendant cleanup is unknown'));
      } catch (error) { errors.push(error); }
    }
    const failure = new AggregateError(errors, 'Codex process cleanup could not be confirmed');
    failure.code = 'CODEX_PROCESS_CLEANUP_UNPROVEN';
    failure.cleanup = Object.freeze({ confirmed: false, termination, fallback });
    throw failure;
  }

  function confirm(timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS) {
    validateCleanupTimeout(timeoutMs);
    // Concurrent Close requests share one operation; a failed operation is
    // retryable against this same retained handle, never a rediscovered PID.
    if (!inFlight) inFlight = run(timeoutMs).finally(() => { inFlight = null; });
    return inFlight;
  }

  function confirmClosed(timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS) {
    validateCleanupTimeout(timeoutMs);
    if (!closureInFlight) {
      // Windows can acknowledge an empty Job before its retained wrapper and
      // pipes close. A provider read must not release a subsequent read while
      // those old resources are still live. Require both kinds of evidence,
      // under one deadline; root exit alone never proves descendant cleanup.
      closureInFlight = boundedCleanup(async () => {
        const receipt = await confirm(timeoutMs);
        await closedPromise;
        const status = await child.jobClosed;
        if (status?.failure) throw new Error('Provider process closure reported a custody failure');
        return receipt;
      }, timeoutMs).catch(error => {
        const failure = new AggregateError([error], 'Provider process tree and pipe closure could not be confirmed');
        failure.code = 'CODEX_PROCESS_CLEANUP_UNPROVEN';
        failure.cleanup = Object.freeze({ confirmed: false });
        Object.defineProperty(failure, 'retryCleanup', { value: () => confirmClosed(timeoutMs) });
        throw failure;
      }).finally(() => { closureInFlight = null; });
    }
    return closureInFlight;
  }

  return { get closed() { return closed; }, confirm, confirmClosed };
}

function cleanupFailure(code, original, errors, retryCleanup) {
  const message = original instanceof Error ? original.message : 'Codex startup failed';
  const failure = new AggregateError(errors, `${message}; Codex startup cleanup could not be confirmed`, { cause: original });
  failure.code = code;
  Object.defineProperty(failure, 'retryCleanup', { value: retryCleanup });
  return failure;
}

// This callable retains the operation's actual child custody. A successful
// cleanup still needs to reach the host after start rejects; an error code or
// a boolean on its own cannot establish that no child remains.
function withOwnedStartupCleanup(original, retryCleanup) {
  try {
    Object.defineProperty(original, 'retryCleanup', { value: retryCleanup, configurable: true });
    return original;
  } catch {
    const failure = new Error(original instanceof Error ? original.message : 'Provider startup failed', { cause: original });
    if (original && typeof original === 'object') {
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(original))) {
        if (!['retryCleanup', 'cause', 'stack', 'name'].includes(key)) Object.defineProperty(failure, key, descriptor);
      }
      if (typeof original.name === 'string') Object.defineProperty(failure, 'name', { value: original.name, configurable: true });
    }
    Object.defineProperty(failure, 'retryCleanup', { value: retryCleanup });
    return failure;
  }
}

module.exports = { DEFAULT_CLEANUP_TIMEOUT_MS, createStartupCleanup, cleanupFailure, validateCleanupTimeout, withOwnedStartupCleanup };
