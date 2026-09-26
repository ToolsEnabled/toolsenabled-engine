'use strict';

// The research surface of the mission bridge: ten POST actions, each a thin
// authenticated shim over ResearchControl. Kept in its own file so actions.js
// does not grow another domain; the provider owns validation, gating and
// audit, and this layer owns only the HTTP error shape.

const { MissionBridgeError } = require('./errors');

const STATUS_BY_CODE = Object.freeze({
  RESEARCH_INPUT_INVALID: 400,
  RESEARCH_SENSITIVE_CONTENT: 400,
  RESEARCH_PIPELINE_DISABLED: 409,
  RESEARCH_RUNNER_DISABLED: 409,
  RESEARCH_PROJECT_DISABLED: 409,
  RESEARCH_PROJECT_NOT_FOUND: 404,
  RESEARCH_EXPERIMENT_NOT_FOUND: 404,
  RESEARCH_FINDING_NOT_FOUND: 404,
  RESEARCH_ASSIGNMENT_NOT_FOUND: 404,
  RESEARCH_PROJECT_NAME_TAKEN: 409,
  RESEARCH_EXPERIMENT_NAME_TAKEN: 409,
  RESEARCH_EXPERIMENT_IMMUTABLE: 409,
  RESEARCH_EXPERIMENT_ARCHIVED: 409,
  RESEARCH_FINDING_UNDISCIPLINED: 400,
  RESEARCH_RUNTIME_UNAVAILABLE: 503,
  RESEARCH_AUDIT_REQUIRED: 500,
  STATE_INVALID_ARGUMENT: 400,
  TASK_QUEUE_FULL: 409,
  TASK_IDEMPOTENCY_CONFLICT: 409
});

function bridgeError(error) {
  if (error instanceof MissionBridgeError) return error;
  const code = error && typeof error.code === 'string' ? error.code : 'RESEARCH_ACTION_FAILED';
  const status = STATUS_BY_CODE[code] || (code.startsWith('RESEARCH_') ? 409 : 500);
  return new MissionBridgeError(code, String(error && error.message || 'The research action failed.').slice(0, 500), { status });
}

async function receiptOf(work) {
  try {
    return { ok: true, receipt: await work() };
  } catch (error) {
    throw bridgeError(error);
  }
}

function createResearchActions(options = {}) {
  const policyApi = options.policy || require('../policy');
  let control = options.control || null;
  const getControl = () => control || (control = (() => {
    const { ResearchControl } = require('../providers/research');
    const { ResearchRunsWorkerRuntime } = require('../providers/research-runs-runtime');
    return new ResearchControl({ runtime: new ResearchRunsWorkerRuntime() });
  })());

  // The bridge's caller is the app acting for the owner; the provider's
  // closed actor vocabulary records that as 'human'. The literal comes LAST so
  // a body carrying its own actor cannot spoof the audit attribution — spread
  // order was exactly the hole the adversarial review found here.
  const asHuman = input => ({ ...(input && typeof input === 'object' && !Array.isArray(input) ? input : {}), actor: 'human' });

  function writeReceipt(action, work) {
    return receiptOf(() => {
      try { policyApi.assertActive(`mission.bridge.${action}`, { outward: true }); }
      catch (error) {
        throw new MissionBridgeError(
          'BRIDGE_GUARD_REFUSED',
          String(error?.message || 'The local policy refused the action.').slice(0, 300),
          { status: 409 }
        );
      }
      return work();
    });
  }

  return Object.freeze({
    researchSnapshot: async () => receiptOf(() => getControl().snapshot()),
    researchRuns: async input => receiptOf(() => getControl().runs(input || {})),
    researchResults: async input => receiptOf(() => getControl().results(input || {})),
    researchFindings: async input => receiptOf(() => getControl().findings(input || {})),
    researchProjectSave: async input => writeReceipt('researchProjectSave', () => getControl().projectSave(asHuman(input))),
    researchExperimentSave: async input => writeReceipt('researchExperimentSave', () => getControl().experimentSave(asHuman(input))),
    researchRunSubmit: async input => writeReceipt('researchRunSubmit', () => getControl().runSubmit(asHuman(input))),
    researchSessionAssign: async input => writeReceipt('researchSessionAssign', () => getControl().sessionAssign(asHuman(input))),
    researchFindingSave: async input => writeReceipt('researchFindingSave', () => getControl().findingSave(asHuman(input))),
    researchLifecycle: async input => writeReceipt('researchLifecycle', () => getControl().lifecycle(asHuman(input)))
  });
}

module.exports = Object.freeze({ createResearchActions });
