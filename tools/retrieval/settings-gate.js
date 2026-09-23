'use strict';

// THE GATE. Whether this surface runs at all, and which sources it may read, is
// decided here and nowhere else.
//
// R1248, owner verbatim: "if a user turns on lsp, we arent worried now about
// using their tokens for lsp, so now we just do what we do. But if they dont
// then we need to withhold the system." Retrieval is the same shape. Reading
// the owner's own verbatims out of the request ledger, or the other agents'
// coordination notes, is not something a product should do because it can.
//
// THREE RULES, EACH OF WHICH HAS ITS OWN FAILURE HISTORY IN THIS CODEBASE
// -----------------------------------------------------------------------
// 1. ABSENCE IS WITHHELD, NEVER CONSENT. The test is `value === true`, not a
//    truthiness check and not a destructured default. Nine separate defects in
//    this codebase came from a missing field, an empty string or a falsy check
//    resolving to "allowed"; the permission fence and the licence verifier were
//    two of them. A setting that is absent from the registry, absent from the
//    user's file, null, "", 0, "true" or "yes" all resolve to WITHHELD here.
//
// 2. AN UNCLASSIFIED SOURCE IS WITHHELD. A source registered in
//    sources.js whose settingId has no entry in the settings registry is
//    refused, loudly, by name. This is the "a module added tomorrow is withheld
//    until classified" property: adding a knowledge source without giving the
//    user a control for it cannot silently start reading their data.
//
// 3. A NON-USER DEFAULT CANNOT ENABLE A SYSTEM. owner-directive
//    "control-that-does-not-enforce-is-software-failure", second half: "A
//    control faithfully enforcing an agent-invented value is still a software
//    failure, because the user's setting is not what is in force" --
//    defaultDailySpendUsd:100 traced to an AI-authored baseline commit and was
//    then quoted back at the owner as HIS cap. So an ON value whose provenance
//    is `default` does NOT enable anything here: only `user` and `installer`
//    provenance can turn a source on. Flipping a default in
//    config/settings-registry.json from false to true therefore cannot enable
//    this surface behind the owner's back, and tests/retrieval prove exactly
//    that by doing it.

const { SOURCES } = require('./sources');

const SURFACE_SETTING_ID = 'retrieval.unified_search';
const RERANK_SETTING_ID = 'retrieval.meaning_search';

// Provenance values that represent a real deployment decision by a person.
// `default` is deliberately absent: see rule 3 above.
const CHOOSING_PROVENANCE = Object.freeze(new Set(['user', 'installer']));

const GATE_STATE = Object.freeze({
  ENABLED: 'enabled',
  WITHHELD: 'withheld',
  UNCLASSIFIED: 'unclassified',
  UNMEASURABLE: 'unmeasurable',
});

function provenanceOf(settings, settingId) {
  const recorded = settings && settings.provenance ? settings.provenance[settingId] : null;
  if (!recorded || typeof recorded !== 'object') return { source: 'default', atMs: 0, directive: null };
  return {
    source: typeof recorded.source === 'string' ? recorded.source : 'default',
    atMs: Number.isFinite(recorded.atMs) ? recorded.atMs : 0,
    directive: recorded.directive === undefined ? null : recorded.directive,
  };
}

function classified(settings, settingId) {
  return Boolean(settings && settings.values
    && Object.prototype.hasOwnProperty.call(settings.values, settingId));
}

/**
 * Decide one toggle. Pure, and the only place the answer is computed.
 *
 * Returns { state, settingId, value, provenance, why }. `state` is one of
 * GATE_STATE; anything other than ENABLED means the caller must WITHHOLD and
 * say so, never quietly do the work anyway.
 */
function decideToggle(settings, settingId) {
  const provenance = provenanceOf(settings, settingId);
  if (!classified(settings, settingId)) {
    return {
      settingId,
      state: GATE_STATE.UNCLASSIFIED,
      value: undefined,
      provenance,
      why: `"${settingId}" has no entry in the settings registry, so there is no control a user could have used to allow this. `
        + 'An unclassified system is withheld, not enabled by silence.',
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
          + 'Anything that is not exactly true is withheld.',
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
        + 'until someone actually turns it on.',
    };
  }
  return { settingId, state: GATE_STATE.ENABLED, value, provenance, why: null };
}

/**
 * Decide the whole surface: the master toggle, every source, and the optional
 * re-ranking backend.
 *
 * Nothing downstream re-reads settings. If it is not in this object, the query
 * path does not get to do it.
 */
function gate({ settings, sources = SOURCES } = {}) {
  const rejected = (settings && Array.isArray(settings.rejected) ? settings.rejected : [])
    .filter(entry => entry && typeof entry.id === 'string'
      && (entry.id === '*' || entry.id.startsWith('retrieval.')))
    .map(entry => Object.freeze({ id: entry.id, reason: entry.reason }));
  const declaredSettingIds = new Set([
    SURFACE_SETTING_ID,
    RERANK_SETTING_ID,
    ...sources.map(source => source.settingId),
  ]);
  const undeclaredSettingIds = settings && settings.values && typeof settings.values === 'object'
    ? Object.keys(settings.values)
      .filter(settingId => settingId.startsWith('retrieval.') && !declaredSettingIds.has(settingId))
    : [];

  let surface = decideToggle(settings, SURFACE_SETTING_ID);
  if (!Array.isArray(sources) || sources.length === 0) {
    surface = {
      ...surface,
      state: GATE_STATE.UNMEASURABLE,
      why: 'No retrieval sources were enumerated, so the gate has nothing to measure. An empty census is not a pass.',
    };
  } else if (rejected.length > 0) {
    surface = {
      ...surface,
      state: GATE_STATE.UNMEASURABLE,
      why: `Retrieval settings could not be measured: ${rejected.map(entry => entry.id).join(', ')} was rejected.`,
    };
  } else if (undeclaredSettingIds.length > 0) {
    surface = {
      ...surface,
      state: GATE_STATE.UNCLASSIFIED,
      why: `Undeclared retrieval settings were supplied: ${undeclaredSettingIds.join(', ')}. `
        + 'Every retrieval control must be declared by the gate before the surface can run.',
    };
  }
  const rerank = decideToggle(settings, RERANK_SETTING_ID);

  const decided = sources.map(source => {
    const own = decideToggle(settings, source.settingId);
    // The master toggle is a fence, not a hint: with it off, no source is
    // enabled regardless of its own control. A half-running disabled system is
    // worse than either state.
    if (surface.state !== GATE_STATE.ENABLED && own.state === GATE_STATE.ENABLED) {
      return {
        id: source.id,
        kind: source.kind,
        label: source.label,
        settingId: source.settingId,
        state: GATE_STATE.WITHHELD,
        value: own.value,
        provenance: own.provenance,
        why: `"${source.settingId}" is on, but the whole retrieval surface is withheld: ${surface.why}`,
      };
    }
    return {
      id: source.id,
      kind: source.kind,
      label: source.label,
      settingId: source.settingId,
      state: own.state,
      value: own.value,
      provenance: own.provenance,
      why: own.why,
    };
  });

  const enabled = decided.filter(entry => entry.state === GATE_STATE.ENABLED);

  return Object.freeze({
    surface: Object.freeze(surface),
    rerank: Object.freeze(rerank),
    sources: Object.freeze(decided),
    enabledSourceIds: Object.freeze(enabled.map(entry => entry.id)),
    // True when the whole thing is off. Distinct from "on but every source is
    // off", which is a different sentence to say to a user.
    surfaceWithheld: surface.state !== GATE_STATE.ENABLED,
    valuesPath: settings && settings.valuesPath ? settings.valuesPath : null,
    // loadSettings() records every value it refused. A rejected retrieval
    // setting means the user tried to configure this and their file was not
    // accepted -- that has to reach the packet, not be swallowed.
    rejected: Object.freeze(rejected),
    undeclaredSettingIds: Object.freeze(undeclaredSettingIds),
  });
}

module.exports = Object.freeze({
  CHOOSING_PROVENANCE,
  GATE_STATE,
  RERANK_SETTING_ID,
  SURFACE_SETTING_ID,
  decideToggle,
  gate,
});
