'use strict';

// The single reader the coordinator calls BEFORE dispatching more work,
// answering one question: can this machine take more load right now, and
// how much AI allowance is left? It combines two already-independent
// readings -- machine-load.js's CPU signal and an AI usage source shaped
// like claude-usage-source.js's resolved output -- into one structured
// verdict. It does not invent a third number from the two; it names which
// threshold, if any, was crossed, and it fails closed exactly like its
// inputs.
//
// Two things about this file will mislead anyone who reads it casually:
//
//   1. A MEASURED allowance reading with no unambiguous binding limit is
//      NOT a green light. claude-cached-utilization.js can legitimately
//      return status: MEASURED with bindingLimit: null (zero or more than
//      one active window). That is "we could not identify THE constraining
//      number", not "there is no constraint" -- this module treats it as
//      UNKNOWN for dispatch purposes rather than silently skipping the
//      allowance check, and separately never treats a NOT_APPLICABLE
//      (percent: null) binding limit as 0%.
//   2. Fail-closed here means BOTH inputs must resolve before a DISPATCH_OK
//      or HOLD verdict is issued. If either the load reading or the
//      allowance reading is UNKNOWN, the combined verdict is UNKNOWN too --
//      answering "should I dispatch" using only the half of the picture
//      that happened to resolve would be exactly the kind of confident
//      partial answer this subsystem exists to refuse.

const MEASURED = 'MEASURED';
const UNKNOWN = 'UNKNOWN';

const VERDICT = Object.freeze({
  DISPATCH_OK: 'DISPATCH_OK',
  HOLD: 'HOLD',
  UNKNOWN: 'UNKNOWN'
});

const REASON = Object.freeze({
  CPU_UTILIZATION_ABOVE_THRESHOLD: 'CPU_UTILIZATION_ABOVE_THRESHOLD',
  AI_ALLOWANCE_ABOVE_THRESHOLD: 'AI_ALLOWANCE_ABOVE_THRESHOLD',
  WITHIN_THRESHOLDS: 'WITHIN_THRESHOLDS',
  MACHINE_LOAD_UNKNOWN: 'MACHINE_LOAD_UNKNOWN',
  AI_ALLOWANCE_UNKNOWN: 'AI_ALLOWANCE_UNKNOWN',
  MACHINE_LOAD_SOURCE_THREW: 'MACHINE_LOAD_SOURCE_THREW',
  MACHINE_LOAD_RESPONSE_INVALID: 'MACHINE_LOAD_RESPONSE_INVALID',
  AI_ALLOWANCE_SOURCE_THREW: 'AI_ALLOWANCE_SOURCE_THREW',
  AI_ALLOWANCE_RESPONSE_INVALID: 'AI_ALLOWANCE_RESPONSE_INVALID',
  AI_ALLOWANCE_NO_BINDING_LIMIT: 'AI_ALLOWANCE_NO_BINDING_LIMIT'
});

// Leaves headroom rather than gating exactly at the edge: a machine at 85%
// CPU or 90% of its binding AI window is treated as "do not add more" even
// though neither number has technically reached 100.
const DEFAULT_MAX_CPU_UTILIZATION_PERCENT = 85;
const DEFAULT_MAX_AI_ALLOWANCE_USED_PERCENT = 90;

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finitePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function unknownLoad(reason, detail) {
  return Object.freeze({ dimension: 'load', status: UNKNOWN, reason, detail: detail || null });
}

function unknownAllowance(reason, detail) {
  return Object.freeze({ dimension: 'aiAllowance', status: UNKNOWN, reason, detail: detail || null });
}

// Accepts machine-load.js's own resolved shape: either
// { status: 'MEASURED', utilizationPercent, coreCount, ... } or
// { status: 'UNKNOWN', reason, detail }. Any other shape is a response the
// caller cannot trust, not a load figure to guess at.
async function resolveLoad(readMachineLoad) {
  let result;
  try {
    result = await readMachineLoad();
  } catch (error) {
    return unknownLoad(REASON.MACHINE_LOAD_SOURCE_THREW, error && error.message);
  }
  if (!plain(result) || (result.status !== MEASURED && result.status !== UNKNOWN)) {
    return unknownLoad(REASON.MACHINE_LOAD_RESPONSE_INVALID, 'Machine load source returned an unrecognised shape.');
  }
  if (result.status === UNKNOWN) {
    return unknownLoad(REASON.MACHINE_LOAD_UNKNOWN, typeof result.reason === 'string' ? result.reason : 'unspecified');
  }
  if (!finitePercent(result.utilizationPercent)) {
    return unknownLoad(REASON.MACHINE_LOAD_RESPONSE_INVALID, 'Machine load source reported MEASURED without a usable utilizationPercent.');
  }
  return Object.freeze({
    dimension: 'load',
    status: MEASURED,
    utilizationPercent: result.utilizationPercent,
    coreCount: Number.isSafeInteger(result.coreCount) ? result.coreCount : null,
    observedAtMs: Number.isSafeInteger(result.observedAtMs) ? result.observedAtMs : null,
    raw: result
  });
}

// Accepts a reading shaped like claude-usage-source.js's resolved output:
// { status: 'MEASURED', bindingLimit: { percent, ... } | null, ... } or
// { status: 'UNKNOWN', reason, detail }. Any AI usage source that resolves
// to this same shape -- Claude's ordered resolver today, another provider's
// tomorrow -- can be plugged in without this module changing.
async function resolveAiAllowance(readAiAllowance) {
  let result;
  try {
    result = await readAiAllowance();
  } catch (error) {
    return unknownAllowance(REASON.AI_ALLOWANCE_SOURCE_THREW, error && error.message);
  }
  if (!plain(result) || (result.status !== MEASURED && result.status !== UNKNOWN)) {
    return unknownAllowance(REASON.AI_ALLOWANCE_RESPONSE_INVALID, 'AI allowance source returned an unrecognised shape.');
  }
  if (result.status === UNKNOWN) {
    return unknownAllowance(REASON.AI_ALLOWANCE_UNKNOWN, typeof result.reason === 'string' ? result.reason : 'unspecified');
  }
  // MEASURED but no single active window identified, or the active window is
  // itself NOT_APPLICABLE (percent: null): a real state, never a 0%.
  const bindingLimit = result.bindingLimit;
  if (!plain(bindingLimit) || !finitePercent(bindingLimit.percent)) {
    return unknownAllowance(
      REASON.AI_ALLOWANCE_NO_BINDING_LIMIT,
      'AI allowance source reported MEASURED without one unambiguous binding limit.'
    );
  }
  return Object.freeze({
    dimension: 'aiAllowance',
    status: MEASURED,
    usedPercent: bindingLimit.percent,
    remainingPercent: 100 - bindingLimit.percent,
    bindingLimitKind: typeof bindingLimit.kind === 'string' ? bindingLimit.kind : null,
    raw: result
  });
}

function normalizeThresholds(thresholds) {
  const maxCpuUtilizationPercent = thresholds && thresholds.maxCpuUtilizationPercent !== undefined
    ? thresholds.maxCpuUtilizationPercent : DEFAULT_MAX_CPU_UTILIZATION_PERCENT;
  const maxAiAllowanceUsedPercent = thresholds && thresholds.maxAiAllowanceUsedPercent !== undefined
    ? thresholds.maxAiAllowanceUsedPercent : DEFAULT_MAX_AI_ALLOWANCE_USED_PERCENT;
  if (!finitePercent(maxCpuUtilizationPercent) || !finitePercent(maxAiAllowanceUsedPercent)) {
    throw new TypeError('thresholds.maxCpuUtilizationPercent and maxAiAllowanceUsedPercent must be numbers from 0 through 100.');
  }
  return Object.freeze({ maxCpuUtilizationPercent, maxAiAllowanceUsedPercent });
}

function createDispatchReadinessReader({
  readMachineLoad,
  readAiAllowance,
  thresholds,
  now = () => Date.now()
} = {}) {
  if (typeof readMachineLoad !== 'function' || typeof readAiAllowance !== 'function') {
    throw new TypeError('createDispatchReadinessReader requires readMachineLoad and readAiAllowance functions.');
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function.');
  }
  const normalizedThresholds = normalizeThresholds(thresholds);

  return async function readDispatchReadiness() {
    const [load, aiAllowance] = await Promise.all([
      resolveLoad(readMachineLoad),
      resolveAiAllowance(readAiAllowance)
    ]);

    if (load.status === UNKNOWN || aiAllowance.status === UNKNOWN) {
      const reasons = [];
      if (load.status === UNKNOWN) reasons.push(load.reason);
      if (aiAllowance.status === UNKNOWN) reasons.push(aiAllowance.reason);
      return Object.freeze({
        schemaVersion: 1,
        verdict: VERDICT.UNKNOWN,
        reasons: Object.freeze(reasons),
        load,
        aiAllowance,
        thresholds: normalizedThresholds,
        observedAtMs: now()
      });
    }

    const reasons = [];
    if (load.utilizationPercent >= normalizedThresholds.maxCpuUtilizationPercent) {
      reasons.push(REASON.CPU_UTILIZATION_ABOVE_THRESHOLD);
    }
    if (aiAllowance.usedPercent >= normalizedThresholds.maxAiAllowanceUsedPercent) {
      reasons.push(REASON.AI_ALLOWANCE_ABOVE_THRESHOLD);
    }

    return Object.freeze({
      schemaVersion: 1,
      verdict: reasons.length > 0 ? VERDICT.HOLD : VERDICT.DISPATCH_OK,
      reasons: Object.freeze(reasons.length > 0 ? reasons : [REASON.WITHIN_THRESHOLDS]),
      load,
      aiAllowance,
      thresholds: normalizedThresholds,
      observedAtMs: now()
    });
  };
}

module.exports = Object.freeze({
  DEFAULT_MAX_AI_ALLOWANCE_USED_PERCENT,
  DEFAULT_MAX_CPU_UTILIZATION_PERCENT,
  REASON,
  VERDICT,
  createDispatchReadinessReader
});
