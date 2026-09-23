'use strict';

// Per-call model receipt adjudication for Gemini fleet work (Q57).
//
// A lane-level `stats.models` aggregate is not evidence of which call made an
// artifact. This module deliberately has no provider, state, or filesystem
// side effects beyond model-floor's authoritative configuration read. It turns
// one call's evidence into an explicit accept / quarantine / refuse verdict.
// The caller is responsible for persisting the returned plain JSON receipt.

const modelFloor = require('../model-floor.js');

const CALL_ROLES = Object.freeze([
  'primary', 'router', 'summarizer', 'subagent', 'compaction', 'judge'
]);
const TRANSPORTS = Object.freeze(['direct-vertex', 'gemini-cli']);
const EVIDENCE_KINDS = Object.freeze(['vertex-modelVersion', 'cli-event', 'inferred', 'absent']);
const VERDICTS = Object.freeze(['accepted', 'quarantined', 'refused']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function arrayOfModels(value) {
  if (!Array.isArray(value)) return null;
  const values = value.map(nonEmptyString);
  return values.every(Boolean) ? values : null;
}

function verdict(verdictName, code, reason) {
  return { verdict: verdictName, code, reason };
}

function closed(reason, code = 'INVALID_MODEL_RECEIPT') {
  return verdict('quarantined', code, reason);
}

/**
 * Normalize raw CLI aggregate model keys.
 *
 * `stats.models` belongs to the whole CLI invocation, not a particular
 * producing call inside it.  Even one key is therefore not per-call evidence:
 * a future internal call may have produced the artifact while another call
 * populated the aggregate.  Keep the names for diagnostics, but never select
 * one as the served model for a receipt.
 */
function observedModelFromReportedModels(reportedModels) {
  if (reportedModels === null || reportedModels === undefined) {
    return { servedModel: null, modelEvidence: 'absent', ambiguity: null };
  }
  const values = arrayOfModels(reportedModels);
  if (!values || values.length === 0) {
    return { servedModel: null, modelEvidence: 'absent', ambiguity: null };
  }
  const unique = [...new Set(values)];
  return {
    servedModel: null,
    modelEvidence: 'absent',
    ambiguity: `CLI stats.models is invocation-level aggregate evidence, not a producing-call receipt: ${unique.join(', ')}`,
    evidenceCode: 'AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE'
  };
}

/**
 * Build an adjudicated receipt from one Gemini CLI call's JSON stats.models
 * keys. This is intentionally separate from assessModelReceipt(): callers
 * with raw CLI output cannot quietly choose one name from an aggregate.
 */
function assessCliModelReceipt(input = {}) {
  const observed = observedModelFromReportedModels(input.reportedModels);
  return assessModelReceipt({
    ...input,
    servedModel: observed.servedModel,
    modelEvidence: observed.modelEvidence,
    servedModelAmbiguity: observed.ambiguity,
    servedModelEvidenceCode: observed.evidenceCode || null
  });
}

function roleVerdict({ callRole, servedAllowed, artifactProduced, materialOutputUsed }) {
  if (servedAllowed) return verdict('accepted', null, null);
  if (callRole === 'primary') {
    return verdict('refused', 'SERVED_MODEL_BELOW_FLOOR',
      'The artifact-producing primary call was served below its configured model floor.');
  }
  if (callRole === 'subagent') {
    if (materialOutputUsed === true) {
      return verdict('refused', 'SUBAGENT_SERVED_MODEL_BELOW_FLOOR',
        'A materially used subagent call was served below its configured model floor.');
    }
    return closed('A subagent was served below floor, but whether its output was materially used is not established.',
      'SUBAGENT_MATERIALITY_UNKNOWN');
  }
  // No auxiliary-tier policy currently exists in config/model-floor.json.
  // Do not infer permission from a role name or from an aggregate lane record.
  return closed(
    `${callRole} was served below floor; no explicit auxiliary-tier policy authorizes that role.`,
    'AUXILIARY_MODEL_POLICY_ABSENT'
  );
}

/**
 * Assess exactly one call. `configuredModel` is the floor-derived declared
 * default, `actualRequestModel` is what the transport was asked for, and
 * `servedModel` is what the provider observed. They are intentionally separate
 * fields; equality is not assumed and inferred evidence is never observed.
 */
function assessModelReceipt(input = {}) {
  const backend = nonEmptyString(input.backend);
  let declaredModel = null;
  try {
    declaredModel = backend ? modelFloor.defaultFor(backend) : null;
  } catch (error) {
    return {
      laneId: nonEmptyString(input.laneId), callId: nonEmptyString(input.callId),
      callRole: nonEmptyString(input.callRole), backend: backend || null,
      declaredModel: null, configuredModel: nonEmptyString(input.configuredModel),
      requestedModel: nonEmptyString(input.actualRequestModel), servedModel: nonEmptyString(input.servedModel),
      modelEvidence: nonEmptyString(input.modelEvidence) || 'absent', observed: false,
      ...closed(error.message, error.code || 'MODEL_BACKEND_UNKNOWN')
    };
  }

  const configuredModel = nonEmptyString(input.configuredModel) || declaredModel;
  const requestedModel = nonEmptyString(input.actualRequestModel) || configuredModel;
  const servedModel = nonEmptyString(input.servedModel);
  const modelEvidence = nonEmptyString(input.modelEvidence) || 'absent';
  const base = {
    laneId: nonEmptyString(input.laneId),
    callId: nonEmptyString(input.callId),
    callRole: nonEmptyString(input.callRole),
    transport: nonEmptyString(input.transport),
    backend,
    // These three distinguish policy declaration, the sent request, and the
    // provider's response rather than displaying one as if it established all.
    declaredModel,
    configuredModel,
    requestedModel,
    servedModel,
    modelEvidence,
    observed: modelEvidence === 'vertex-modelVersion' || modelEvidence === 'cli-event',
    responseId: nonEmptyString(input.responseId),
    attemptNumber: Number.isSafeInteger(input.attemptNumber) && input.attemptNumber >= 1 ? input.attemptNumber : null,
    fallbackFrom: nonEmptyString(input.fallbackFrom),
    fallbackReason: nonEmptyString(input.fallbackReason),
    artifactProduced: input.artifactProduced === true
      ? true
      : (input.artifactProduced === false ? false : null),
    materialOutputUsed: input.materialOutputUsed === true ? true : (input.materialOutputUsed === false ? false : null)
  };

  if (!base.laneId || !base.callId || !CALL_ROLES.includes(base.callRole) || !TRANSPORTS.includes(base.transport)) {
    return { ...base, ...closed('Receipt requires a laneId, callId, recognized callRole, and recognized transport.') };
  }
  if (!EVIDENCE_KINDS.includes(modelEvidence)) {
    return { ...base, ...closed(`Unknown model evidence kind "${modelEvidence}".`, 'MODEL_EVIDENCE_UNKNOWN') };
  }
  const configured = modelFloor.evaluateModel({ backend, model: configuredModel, purpose: 'lane' });
  if (!configured.allowed) return { ...base, ...verdict('refused', configured.code, configured.reason) };
  const requested = modelFloor.evaluateModel({ backend, model: requestedModel, purpose: 'lane' });
  if (!requested.allowed) return { ...base, ...verdict('refused', requested.code, requested.reason) };
  if (configuredModel !== declaredModel) {
    return { ...base, ...verdict('refused', 'DECLARED_MODEL_MISMATCH',
      `Configured model "${configuredModel}" differs from the ${backend} floor declaration "${declaredModel}".`) };
  }
  if (modelEvidence === 'absent' || !servedModel) {
    if (nonEmptyString(input.servedModelAmbiguity)) {
      return {
        ...base,
        ...closed(input.servedModelAmbiguity,
          nonEmptyString(input.servedModelEvidenceCode) || 'AMBIGUOUS_SERVED_MODEL_EVIDENCE')
      };
    }
    return { ...base, ...closed('No observed served-model evidence exists for this call.', 'MISSING_MODEL_EVIDENCE') };
  }
  if (modelEvidence === 'inferred') {
    return { ...base, observed: false, ...closed('The served model is inferred rather than provider-observed.', 'INFERRED_MODEL_EVIDENCE') };
  }
  const served = modelFloor.evaluateModel({ backend, model: servedModel, purpose: 'lane' });
  if (!served.allowed) return { ...base, ...roleVerdict({
    callRole: base.callRole, servedAllowed: false,
    artifactProduced: base.artifactProduced, materialOutputUsed: base.materialOutputUsed
  }) };
  return { ...base, ...roleVerdict({ callRole: base.callRole, servedAllowed: true,
    artifactProduced: base.artifactProduced, materialOutputUsed: base.materialOutputUsed }) };
}

module.exports = {
  CALL_ROLES,
  TRANSPORTS,
  EVIDENCE_KINDS,
  VERDICTS,
  observedModelFromReportedModels,
  assessCliModelReceipt,
  assessModelReceipt
};
