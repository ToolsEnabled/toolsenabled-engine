'use strict';

// THE RESEARCH GATE. Whether research jobs run at all, and which kinds of work
// a job may do, is decided here and nowhere else. The provider's submit path,
// the worker's execute path and the runner selection all ask this module; none
// of them re-reads settings on its own.
//
// The three rules are the retrieval gate's (tools/retrieval/settings-gate.js),
// because they answer the same failure histories:
//
// 1. ABSENCE IS WITHHELD, NEVER CONSENT. The test is `value === true`. A
//    setting absent from the registry, absent from the user's file, null, "",
//    0, "true" or "yes" all resolve to WITHHELD.
// 2. AN UNCLASSIFIED RUNNER KIND IS WITHHELD. A runner kind with no settings
//    row is refused by name, so a kind added tomorrow cannot start running
//    work before a user has a control for it.
// 3. A NON-USER DEFAULT CANNOT ENABLE A SYSTEM. Only `user` and `installer`
//    provenance count as a choice; flipping a default in the registry JSON
//    cannot enable research work behind the owner's back.

const PIPELINE_SETTING_ID = 'research.pipeline';

// One settings row per kind of work a job may do. Launching an assistant,
// running a program and calling an outside service are three separate
// decisions, so they are three separate controls.
const RUNNER_SETTING_IDS = Object.freeze({
  agent: 'research.runner_agent',
  process: 'research.runner_process',
  http: 'research.runner_http'
});

const CHOOSING_PROVENANCE = Object.freeze(new Set(['user', 'installer']));

const GATE_STATE = Object.freeze({
  ENABLED: 'enabled',
  WITHHELD: 'withheld',
  UNCLASSIFIED: 'unclassified'
});

function provenanceOf(settings, settingId) {
  const recorded = settings && settings.provenance ? settings.provenance[settingId] : null;
  if (!recorded || typeof recorded !== 'object') return { source: 'default', atMs: 0, directive: null };
  return {
    source: typeof recorded.source === 'string' ? recorded.source : 'default',
    atMs: Number.isFinite(recorded.atMs) ? recorded.atMs : 0,
    directive: recorded.directive === undefined ? null : recorded.directive
  };
}

function classified(settings, settingId) {
  return Boolean(settings && settings.values
    && Object.prototype.hasOwnProperty.call(settings.values, settingId));
}

function decideToggle(settings, settingId) {
  const provenance = provenanceOf(settings, settingId);
  if (!classified(settings, settingId)) {
    return {
      settingId,
      state: GATE_STATE.UNCLASSIFIED,
      value: undefined,
      provenance,
      why: `"${settingId}" has no entry in the settings registry, so there is no control a user could have used to allow this. `
        + 'An unclassified system is withheld, not enabled by silence.'
    };
  }
  const value = settings.values[settingId];
  if (value !== true) {
    return {
      settingId,
      state: GATE_STATE.WITHHELD,
      value,
      provenance,
      why: value === false
        ? `"${settingId}" is off.`
        : `"${settingId}" is set to ${JSON.stringify(value)}, which is not the boolean true this control requires. `
          + 'Anything that is not exactly true is withheld.'
    };
  }
  if (!CHOOSING_PROVENANCE.has(provenance.source)) {
    return {
      settingId,
      state: GATE_STATE.WITHHELD,
      value,
      provenance,
      why: `"${settingId}" reads as on, but its provenance is "${provenance.source}" -- a built-in default, not a choice this `
        + 'user or their installer made. A control enforcing an agent-invented value is a software failure, so this stays withheld '
        + 'until someone actually turns it on.'
    };
  }
  return { settingId, state: GATE_STATE.ENABLED, value, provenance, why: null };
}

/**
 * Decide the whole research surface: the master toggle and every runner kind.
 *
 * `pipeline` is a fence, not a hint: with it off, no runner kind is enabled
 * regardless of its own control, and each carries the master's sentence so the
 * refusal a caller shows names the switch that actually decided.
 */
function gate({ settings } = {}) {
  const pipeline = decideToggle(settings, PIPELINE_SETTING_ID);

  const runners = {};
  for (const [kind, settingId] of Object.entries(RUNNER_SETTING_IDS)) {
    const own = decideToggle(settings, settingId);
    if (pipeline.state !== GATE_STATE.ENABLED && own.state === GATE_STATE.ENABLED) {
      runners[kind] = {
        kind,
        settingId,
        state: GATE_STATE.WITHHELD,
        value: own.value,
        provenance: own.provenance,
        why: `"${settingId}" is on, but the whole research pipeline is withheld: ${pipeline.why}`
      };
    } else {
      runners[kind] = { kind, ...own };
    }
  }

  return Object.freeze({
    pipeline: Object.freeze(pipeline),
    runners: Object.freeze(runners),
    pipelineWithheld: pipeline.state !== GATE_STATE.ENABLED,
    enabledRunnerKinds: Object.freeze(Object.values(runners)
      .filter(entry => entry.state === GATE_STATE.ENABLED)
      .map(entry => entry.kind)),
    valuesPath: settings && settings.valuesPath ? settings.valuesPath : null,
    rejected: Object.freeze((settings && Array.isArray(settings.rejected) ? settings.rejected : [])
      .filter(entry => entry && typeof entry.id === 'string'
        && (entry.id === '*' || entry.id.startsWith('research.')))
      .map(entry => Object.freeze({ id: entry.id, reason: entry.reason })))
  });
}

/** The gate against the live settings files; the pure form is gate(). */
function loadGate(options = {}) {
  const { loadSettings } = require('../settings');
  return gate({ settings: loadSettings(options) });
}

module.exports = Object.freeze({
  CHOOSING_PROVENANCE,
  GATE_STATE,
  PIPELINE_SETTING_ID,
  RUNNER_SETTING_IDS,
  decideToggle,
  gate,
  loadGate
});
