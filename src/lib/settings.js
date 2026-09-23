'use strict';

const path = require('node:path');
const { resolveServicesRoot, resolveSettingsValuesPath } = require('./durable-memory-file');

const { validateSettingValue, readSettingsDocument, applyStoredValues } = require('./settings-values');
const CAPABILITY_TIER_ID = 'capability.tier';
const CAPABILITY_WORKSPACE_ROOTS_ID = 'capability.workspace_roots';
const CAPABILITY_READBACK_IDS = Object.freeze([CAPABILITY_TIER_ID, CAPABILITY_WORKSPACE_ROOTS_ID]);

/* Which rows refuse a stored value: the two machine-boundary ids ALWAYS, plus
   any readback the catalogue itself declares read-only.
     The id list stays first and unconditional on purpose. Those two rows are
   read-only by construction -- an ordinary setting must never be able to widen
   the installation boundary -- and that must not become contingent on a
   catalogue field being present, because a registry handed in by a caller (or a
   payload staged from an older build) that omits `readOnlyReason` would then
   silently make settings.json authoritative over machine.json.
     `readOnlyReason` only ADDS rows. It is a registry field the validator
   already restricts to readback controls and already refuses blank, so the
   catalogue can say this for itself and there is no second hand-maintained copy
   of the answer for a new row to be left out of. */
function readOnlyRow(entry, id) {
  if (CAPABILITY_READBACK_IDS.includes(id)) return true;
  return Boolean(entry
    && entry.control === 'readback'
    && typeof entry.readOnlyReason === 'string'
    && entry.readOnlyReason.trim() !== '');
}

class SettingsRegistryUnavailableError extends Error {
  constructor(cause) {
    super('Settings registry is unavailable: could not load ./settings-registry. Pass a pre-loaded registry to loadSettings().', { cause });
    this.name = 'SettingsRegistryUnavailableError';
    this.code = 'SETTINGS_REGISTRY_UNAVAILABLE';
  }
}

class SettingsMachineRecordUnavailableError extends Error {
  constructor(cause) {
    super('Settings could not read the machine record; this is NOT a claim that the machine record is absent.', { cause });
    this.name = 'SettingsMachineRecordUnavailableError';
    this.code = 'SETTINGS_MACHINE_RECORD_UNAVAILABLE';
  }
}

const INDETERMINATE_MACHINE_RECORD_CODES = new Set([
  'EAGAIN',
  'EBUSY',
  'EIO',
  'EMFILE',
  'ETIMEDOUT',
  'SETUP_MACHINE_RECORD_UNREADABLE'
]);

function resolveValuesPath({ env = process.env } = {}) {
  return resolveSettingsValuesPath({ env });
}

function defaultProvenance() {
  return { source: 'default', atMs: 0, directive: null };
}

function validationFailure(entry, raw) {
  if (entry.id === 'fleet.max_declared_agents' && (!Number.isSafeInteger(raw) || raw < 0)) {
    return 'The declared agent limit must be a non-negative whole number; 0 removes the agent-count limit.';
  }
  const reason = validateSettingValue(entry, raw, {
    allowEmpty: ['model.local_agent_name', 'model.tool_name'].includes(entry.id)
  });
  if (reason) return reason;
  if (entry.id === 'capability.elevation_duration' && (raw <= 0 || !Number.isSafeInteger(raw * 60000))) {
    return 'Temporary capability duration must be a positive number of minutes representing an exact, safe number of milliseconds.';
  }
  return require('./local-model-options').invalidSettingValue(entry.id, raw);
}

function loadDefaultRegistry() {
  let registryModule;
  try {
    registryModule = require('./settings-registry');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND'
        && /^Cannot find module ['"]\.\/settings-registry['"]/.test(error.message)) {
      throw new SettingsRegistryUnavailableError(error);
    }
    throw error;
  }
  return registryModule.loadRegistry();
}

// The registry module owns the canonical predicates (enforcementDeclared /
// provenanceDeclared), but loadSettings must keep working when that module is
// ABSENT and a caller passes a pre-loaded registry -- see
// SettingsRegistryUnavailableError above, which exists for exactly that case.
// So the predicate is resolved through the module when it is there and falls
// back to the same rule when it is not. The rule itself is one line and is
// stated identically in both places: a field that is missing, not a string, or
// whitespace-only DECLARES NOTHING.
function declaredNonEmpty(entry, field) {
  let registryModule = null;
  try {
    registryModule = require('./settings-registry');
  } catch (error) {
    // A genuinely absent optional module is the one case where the local rule
    // is authoritative. Initialization failures (including a missing nested
    // dependency) mean the canonical predicate could not be established and
    // must not be collapsed into a declaration inferred by this fallback.
    if (!(error && error.code === 'MODULE_NOT_FOUND'
        && /^Cannot find module ['"]\.\/settings-registry['"]/.test(error.message))) {
      throw error;
    }
  }
  if (registryModule) {
    if (field === 'enforcedBy' && typeof registryModule.enforcementDeclared === 'function') {
      return registryModule.enforcementDeclared(entry);
    }
    if (field === 'derivedFrom' && typeof registryModule.provenanceDeclared === 'function') {
      return registryModule.provenanceDeclared(entry);
    }
  }
  const value = entry ? entry[field] : undefined;
  return typeof value === 'string' && value.trim() !== '';
}

// These two catalogue rows describe the installation boundary, but the
// authority for that boundary is machine.json, not settings.json. Resolve the
// displayed values from the same authenticated record the dispatch paths use.
// If the record cannot be trusted, show the actual fail-closed state: Guided
// and no usable workspace roots. Never substitute a catalogue default and make
// it look like a recorded grant.
function capabilityBoundaryReadback(loadedRegistry, {
  env,
  machineRecord: injectedMachineRecord,
  servicesRoot: injectedServicesRoot
} = {}) {
  const included = CAPABILITY_READBACK_IDS.filter(id => loadedRegistry.byId.has(id));
  if (included.length === 0) return { values: {}, provenance: {}, readbacks: {} };

  const machineRecord = injectedMachineRecord || require('./setup/machine-record');
  let servicesRoot = injectedServicesRoot;
  let authorityPath = null;
  let record = null;
  let failureCode = null;
  try {
    servicesRoot = servicesRoot || machineRecord.resolveServicesRoot({ env });
    authorityPath = machineRecord.machineRecordPath(servicesRoot);
    record = machineRecord.readMachineRecord({ servicesRoot });
    if (!record) {
      failureCode = 'SETUP_MACHINE_RECORD_ABSENT';
    } else {
      // Use the policy's closed vocabulary instead of trusting a string merely
      // because an injected/test reader returned it.
      require('./permission-tier-policy').installTierFromRecord(record);
      if (!Array.isArray(record.workspaceRoots) || record.workspaceRoots.length === 0) {
        const error = new Error('The machine record has no usable workspace roots.');
        error.code = 'SETUP_MACHINE_RECORD_INVALID';
        throw error;
      }
    }
  } catch (error) {
    if (INDETERMINATE_MACHINE_RECORD_CODES.has(error && error.code)) {
      // A busy or unreadable machine is not evidence that its authority file
      // is absent. Propagate an explicit indeterminate result; in particular,
      // do not put the fail-closed values into a result a caller may retain.
      throw new SettingsMachineRecordUnavailableError(error);
    }
    record = null;
    failureCode = (error && error.code) || 'SETUP_MACHINE_RECORD_UNREADABLE';
  }

  const failedClosed = record === null;
  const tier = failedClosed
    ? require('./agent-session-confinement').FAIL_CLOSED_TIER
    : record.tier;
  const workspaceRoots = failedClosed ? [] : record.workspaceRoots.slice();
  const status = failedClosed ? 'failed-closed' : 'recorded';
  const chosenProvenance = failedClosed
    ? defaultProvenance()
    : { source: 'installer', atMs: Number.isFinite(record.createdAtMs) ? record.createdAtMs : 0, directive: null };

  const values = {};
  const provenance = {};
  const readbacks = {};
  if (included.includes(CAPABILITY_TIER_ID)) {
    values[CAPABILITY_TIER_ID] = tier;
    provenance[CAPABILITY_TIER_ID] = { ...chosenProvenance };
    readbacks[CAPABILITY_TIER_ID] = Object.freeze({
      readOnly: true, authorityPath, status, reason: failureCode
    });
  }
  if (included.includes(CAPABILITY_WORKSPACE_ROOTS_ID)) {
    values[CAPABILITY_WORKSPACE_ROOTS_ID] = workspaceRoots;
    provenance[CAPABILITY_WORKSPACE_ROOTS_ID] = { ...chosenProvenance };
    readbacks[CAPABILITY_WORKSPACE_ROOTS_ID] = Object.freeze({
      readOnly: true, authorityPath, status, reason: failureCode
    });
  }
  return { values, provenance, readbacks };
}

function loadSettings({ registry, valuesPath, env, machineRecord, servicesRoot, ids } = {}) {
  let loadedRegistry = registry || loadDefaultRegistry();
  let requested = null;
  if (ids !== undefined) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !loadedRegistry.byId.has(id))) {
      throw new TypeError('Selected settings must be declared registry ids.');
    }
    requested = new Set(ids);
    const entries = loadedRegistry.entries.filter(entry => requested.has(entry.id));
    loadedRegistry = { ...loadedRegistry, entries, byId: new Map(entries.map(entry => [entry.id, entry])) };
  }
  const resolvedPath = valuesPath === undefined
    ? resolveValuesPath({ env })
    : path.resolve(valuesPath);
  const values = {};
  const provenance = {};
  const rejected = [];
  // WHAT MAKES EACH OF THESE TRUE AT RUNTIME -- reported, never assumed.
  //
  // A resolved settings document used to say what every value IS and where it
  // came from, and nothing at all about whether anything reads it. On the
  // shipped payload measured at base SHA ceae7e7f exactly 3 of these 51 ids
  // appear in any executable file, so a surface rendering this map draws 48
  // controls that change nothing, with no way to tell which. That is a control
  // that does not enforce, and the settings layer was the last place able to
  // notice.
  //
  // `declared` is what the CATALOGUE claims, not proof the enforcer runs. It is
  // the weaker statement on purpose: an empty enforcedBy is a CERTAINTY that
  // nothing is wired, while a non-empty one is only a claim. A surface may
  // safely say "nothing enforces this" from a false; it may not say "this is
  // enforced" from a true.
  const enforcement = {};

  for (const entry of loadedRegistry.entries) {
    values[entry.id] = entry.default;
    provenance[entry.id] = defaultProvenance();
    const enforced = declaredNonEmpty(entry, 'enforcedBy');
    const provenanced = declaredNonEmpty(entry, 'derivedFrom');
    enforcement[entry.id] = Object.freeze({
      declared: enforced,
      enforcedBy: enforced ? entry.enforcedBy.trim() : null,
      provenanceDeclared: provenanced,
      derivedFrom: provenanced ? entry.derivedFrom.trim() : null
    });
  }

  const capabilityReadback = capabilityBoundaryReadback(loadedRegistry, { env, machineRecord, servicesRoot });
  Object.assign(values, capabilityReadback.values);
  Object.assign(provenance, capabilityReadback.provenance);
  const readbacks = capabilityReadback.readbacks;
  const result = revision => {
    // Use this same validated document while its raw boolean/string distinction
    // is still available. Synthesized defaults must never outrank a stored choice.
    if (loadedRegistry.byId.get('agent.agent_api')?.control === 'seg') {
      const { AGENT_API_SETTING_ID: id, AGENT_API_MODES, TOOL_MODE_SETTING_ID: alias,
        TOOL_MODES, agentApiModeFromToolMode } = require('./agent-api-mode');
      const raw = document?.values && typeof document.values === 'object' ? document.values : {};
      const canonicalStored = Object.hasOwn(raw, id);
      const aliasStored = Object.hasOwn(raw, alias);
      const refused = key => rejected.some(item => item.id === key || item.id === '*');
      let mode = values[id];
      let source = id;
      let reason = null;
      if (!refused(id)) {
        if (canonicalStored && AGENT_API_MODES.includes(raw[id])) {
          // A validated stored enum supersedes an obsolete alias, even if the
          // alias is contradictory or malformed. It keeps its own provenance.
          mode = raw[id];
        } else if (aliasStored) {
          const migrated = agentApiModeFromToolMode(raw[alias]);
          if (refused(alias) || !migrated) reason = 'The stored compatibility tool mode is invalid or has invalid provenance.';
          else if (canonicalStored && ((raw[id] === true && migrated !== 'Only')
              || (raw[id] === false && migrated === 'Only'))) {
            reason = 'The stored legacy tool choices conflict. Choose the available tool sets again in Settings.';
          } else { mode = migrated; source = alias; }
        }
        if (reason) rejected.push({ id, raw: null, reason });
        else {
          values[id] = mode;
          if (source !== id) provenance[id] = { ...provenance[source], migratedFrom: source };
          if (loadedRegistry.byId.has(alias)) {
            values[alias] = TOOL_MODES[mode];
            provenance[alias] = { ...provenance[id] };
          }
        }
      }
    }
    // WHO ADDS STANDING RULES, AND ITS OLDER ON/OFF FORM (owner, 2026-09-15:
    // "either manually on the ledger page only, or ledger page and /request,
    // or agent and such like now"). rules.filing_from is the choice a person
    // makes now; rules.capture_spoken is the switch every reader of "may an
    // agent file" was built on (src/lib/r-ledger-agent-gate.js, under its own
    // provenance rule). Neither may contradict the other, so the one the person
    // actually chose decides and the other is derived from it, carrying the
    // chooser's provenance so the gate still reads it as a real choice:
    //   - a chosen rules.filing_from sets rules.capture_spoken (on only for
    //     "Agents too"), whatever an older stored switch said;
    //   - an unchosen rules.filing_from follows a chosen switch (on -> "Agents
    //     too", off -> "Ledger page and /Request", the switch's own old
    //     meaning), so an install that only ever saw the switch keeps working.
    // A row missing from a narrowed registry read (ids) is left alone.
    if (loadedRegistry.byId.has('rules.filing_from') && loadedRegistry.byId.has('rules.capture_spoken')) {
      const chosen = key => ['user', 'installer'].includes(provenance[key]?.source);
      const filingOptions = loadedRegistry.byId.get('rules.filing_from').options || [];
      if (chosen('rules.filing_from') && filingOptions.includes(values['rules.filing_from'])) {
        values['rules.capture_spoken'] = values['rules.filing_from'] === 'Agents too';
        provenance['rules.capture_spoken'] = { ...provenance['rules.filing_from'], migratedFrom: 'rules.filing_from' };
      } else if (!chosen('rules.filing_from') && chosen('rules.capture_spoken') && typeof values['rules.capture_spoken'] === 'boolean') {
        values['rules.filing_from'] = values['rules.capture_spoken'] === true ? 'Agents too' : 'Ledger page and /Request';
        provenance['rules.filing_from'] = { ...provenance['rules.capture_spoken'], migratedFrom: 'rules.capture_spoken' };
      }
    }
    if (loadedRegistry.byId.has('purchases.require_owner_approval') && !['user', 'installer'].includes(provenance['purchases.require_owner_approval']?.source)
        && ['user', 'installer'].includes(provenance['outward.reserved_from_agents']?.source) && Array.isArray(values['outward.reserved_from_agents'])) {
      values['purchases.require_owner_approval'] = values['outward.reserved_from_agents'].includes('Approving any purchase or spending any money');
      provenance['purchases.require_owner_approval'] = { ...provenance['outward.reserved_from_agents'], migratedFrom: 'outward.reserved_from_agents' };
    }
    return { values, provenance, enforcement, readbacks, rejected, revision, valuesPath: resolvedPath };
  };

  let document;
  const stored = readSettingsDocument(resolvedPath, rejected);
  document = stored.document;
  if (!stored.valid) return result(stored.revision);
  applyStoredValues({ registry: loadedRegistry, document, requested, values, provenance, rejected,
    readOnlyReason(entry, id) {
      // Machine-boundary rows remain read-only even if an older catalogue
      // lacks a reason. All read-only refusals redact the supplied raw value.
      if (!readOnlyRow(entry, id)) return null;
      const authority = readbacks[id] && readbacks[id].authorityPath;
      return typeof entry.readOnlyReason === 'string' && entry.readOnlyReason.trim() !== ''
        ? `Setting "${id}" is read-only. ${entry.readOnlyReason.trim()}`
        : `Setting "${id}" is read-only; its displayed value comes from ${authority || 'its named authority'}, not settings.json.`;
    },
    normalize: (entry, raw) => entry.id === 'agent.agent_api' && entry.control === 'seg'
      ? require('./agent-api-mode').normalizeAgentApiMode(raw) ?? raw : raw,
    validate: validationFailure
  });

  return result(document.revision);
}

module.exports = {
  loadSettings,
  resolveValuesPath
};
