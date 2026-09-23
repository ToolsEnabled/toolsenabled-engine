'use strict';

// The fleet's model floor, as its own dependency-free module so both the
// supervisor (which lazily loads lane-runner.js to keep `--status` cheap) and
// lane-runner.js itself read the SAME list without pulling in the provider
// gateway.
//
// Model authority comes exclusively from the current config/model-floor.json
// document through src/lib/model-floor.js. Request numbers, prior installations,
// account history, and provider incidents do not classify a model. Unknown,
// below-floor, and currently non-servable selections are typed refusals rather
// than fallbacks.
const modelFloor = require('../model-floor.js');

const BACKENDS = Object.freeze(['subscription', 'vertex']);
const DEFAULT_BACKEND = 'vertex';

const DEFAULT_LANE_MODEL = modelFloor.defaultFor('subscription');
const DEFAULT_VERTEX_LANE_MODEL = modelFloor.defaultFor('vertex');

// These are immutable views of the current authority, not local declarations.
const ALLOWED_LANE_MODELS = Object.freeze([...modelFloor.allowedFor('subscription')]);

const ALLOWED_VERTEX_LANE_MODELS = Object.freeze([...modelFloor.allowedFor('vertex')]);

// ---------------------------------------------------------------------------
// Models the current configuration marks non-servable on a given backend.
// ---------------------------------------------------------------------------
// This remains distinct from an ordinary floor refusal so callers preserve
// the configured reason. The table is a derived compatibility view only.
const NOT_SERVABLE = Object.freeze(Object.fromEntries(
  Object.entries(modelFloor.loadFloor().backends)
    .map(([backendId, spec]) => [backendId, Object.freeze({ ...(spec.notServable || {}) })])
));

// Why an explicitly-requested model cannot be used, or null when it can.
// Delegated so there is exactly one place this fact lives.
function notServableReason(backend, model) {
  return modelFloor.notServableReason(backend, model);
}

function backendFloor(backend) {
  // Do not let an unknown backend silently collapse to the subscription
  // namespace. In particular, an omitted backend means DEFAULT_BACKEND just
  // as it does everywhere else in this module; a misspelling is a refusal.
  const resolved = assertBackend(backend);
  if (resolved === 'vertex') {
    return { models: ALLOWED_VERTEX_LANE_MODELS, fallback: DEFAULT_VERTEX_LANE_MODEL };
  }
  return { models: ALLOWED_LANE_MODELS, fallback: DEFAULT_LANE_MODEL };
}

function assertBackend(backend) {
  const candidate = backend === undefined || backend === null ? DEFAULT_BACKEND : backend;
  if (!BACKENDS.includes(candidate)) {
    const error = new Error(`Lane backend must be one of: ${BACKENDS.join(', ')}; got ${candidate}`);
    error.code = 'FLEET_BACKEND_INVALID';
    throw error;
  }
  return candidate;
}

// Backend-aware floor check. Same refusal semantics as assertLaneModel: an
// off-floor model throws rather than quietly resolving to something cheaper.
function assertLaneModelFor(backend, model) {
  const resolved = assertBackend(backend);
  const { models, fallback } = backendFloor(resolved);
  const candidate = model === undefined || model === null ? fallback : model;
  // Checked BEFORE the floor message: "this model does not work here" is a
  // different fact from "this model is a downgrade we refuse", and reporting
  // the second when the first is true sends the next debugger the wrong way.
  const unservable = notServableReason(resolved, candidate);
  if (unservable) {
    const error = new Error(unservable);
    error.code = 'FLEET_MODEL_NOT_SERVABLE';
    throw error;
  }
  if (!models.includes(candidate)) {
    const error = new Error(
      `Lane model "${candidate}" is not on the ${resolved} model floor (${models.join(', ')}). ` +
      'A downgrade or unknown model is a refusal, never a fallback under the configured model floor policy.'
    );
    error.code = 'FLEET_MODEL_REFUSED';
    throw error;
  }
  return candidate;
}

// Did the provider actually SERVE at or above the floor? `reportedModels` is
// the CLI's own stats.models key set. Returns null when the CLI said nothing
// (unknown is not the same as compliant, and callers must not treat it as a
// pass). This is the mechanism that catches a silent flash-lite serve.
function servedBelowFloor(backend, reportedModels) {
  if (!Array.isArray(reportedModels) || reportedModels.length === 0) return null;
  const { models } = backendFloor(assertBackend(backend));
  const offFloor = reportedModels.filter(name => !models.includes(name));
  return offFloor.length > 0 ? offFloor : [];
}

// Informational status metadata, derived from the same current authority. It
// deliberately makes no claim about a particular installed CLI or account.
const LANE_MODEL_THINKING = Object.freeze(Object.fromEntries([
  ...Object.entries(modelFloor.loadFloor().backends).flatMap(([backendId, spec]) => (
    spec.allowed.map(model => [model, `provider-managed reasoning (${backendId} configured model floor)`])
  )),
  ...Object.entries(NOT_SERVABLE).flatMap(([backendId, models]) => (
    Object.keys(models).map(model => [model, `NOT SERVABLE on ${backendId} under the current configured model floor`])
  ))
]));

function assertLaneModel(model) {
  const candidate = model === undefined || model === null ? DEFAULT_LANE_MODEL : model;
  if (!ALLOWED_LANE_MODELS.includes(candidate)) {
    const error = new Error(
      `Lane model "${candidate}" is not on the fleet model floor (${ALLOWED_LANE_MODELS.join(', ')}). ` +
      'A downgrade or unknown model is a refusal, never a fallback under the configured model floor policy.'
    );
    error.code = 'FLEET_MODEL_REFUSED';
    throw error;
  }
  return candidate;
}

module.exports = {
  ALLOWED_LANE_MODELS,
  ALLOWED_VERTEX_LANE_MODELS,
  NOT_SERVABLE,
  notServableReason,
  BACKENDS,
  DEFAULT_BACKEND,
  DEFAULT_LANE_MODEL,
  DEFAULT_VERTEX_LANE_MODEL,
  LANE_MODEL_THINKING,
  assertBackend,
  assertLaneModel,
  assertLaneModelFor,
  backendFloor,
  servedBelowFloor
};
