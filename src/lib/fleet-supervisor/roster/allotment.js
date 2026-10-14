'use strict';

// Agent-roster allotment loader (owner request R103, gates 4, 7, 8).
//
// config/agent-allotment.json is the OWNER-EDITABLE ceiling of what the roster
// MAY select from. It is a ceiling, never a target (R103 amendment, verbatim:
// "...just because its allotted doesnt mean it needs to be used, its just
// allowed"). Idle allotment is a correct state, not a defect.
//
// FAIL-DORMANT is the load contract: a missing file, unparseable JSON, a wrong
// schemaVersion, or a forbidden entry all produce an EMPTY allotment
// (enabled:false, nothing allowed) with a clear human-readable reason -- never
// a permissive default, and never an exception thrown into dispatch. A broken
// allotment file can never break dispatch and can never widen selection.
//
// THE FLOOR IS NOT RESTATED HERE. Model authority is config/model-floor.json
// via src/lib/model-floor.js (owner request R95); this loader DROPS any model
// id that is off the floor for its entry's backend, with a logged warning in
// the load result. Selection is always allotment INTERSECT floor INTERSECT
// availability -- an id listed here that the floor refuses is never honored.
//
// SOL EXCLUSION (standing order SPAWN 2): an entry that identifies the Codex
// 'sol' tier refuses the WHOLE file, loudly, so the refusal cannot be missed.
//
// Re-read semantics: loadAllotment() re-reads when the file's mtime or size
// changes, so an owner edit takes effect at the next hook call with no restart
// and no daemon. Shrinking never kills a running lane; it makes the config
// ineligible for the NEXT advice call.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Load floor readers only at the point where a floor is actually needed. Both
// readers load config/model-floor.json at module initialization; requiring them
// here would turn an absent floor into an import-time crash before the loader
// can return its documented fail-dormant result (including when the allotment
// itself is absent).
function getModelFloor() {
  return require('../../model-floor.js');
}

function getLaneModels() {
  return require('../lane-models.js');
}

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const DEFAULT_ALLOTMENT_PATH = path.join(REPO_ROOT, 'config', 'agent-allotment.json');
const RELATIVE_ALLOTMENT_PATH = 'config/agent-allotment.json';

const SCHEMA_VERSION = 'agent-allotment-v1';

const DEFAULT_PARAMETERS = Object.freeze({
  minSamples: 5,
  explorationEveryK: 5,
  suspendDays: 14
});

const KNOWN_ROLES = Object.freeze(['builder', 'reviewer', 'planner']);

// Token match, not substring: 'sol' as its own token in a provider, tier, or
// model id. 'solution'/'console' do not match; 'codex-sol', 'sol', 'sol-2' do.
const SOL_TOKEN = /(^|[^a-z0-9])sol([^a-z0-9]|$)/i;

let cache = null; // { path, mtimeMs, size, result }

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function dormant({ source, reason, allotmentPath, sha256: digest = null, raw = null }) {
  return Object.freeze({
    ok: false,
    enabled: false,
    source,                      // 'missing' | 'invalid'
    path: allotmentPath,
    relativePath: RELATIVE_ALLOTMENT_PATH,
    sha256: digest,
    reason,
    schemaVersion: raw && typeof raw === 'object' ? raw.schemaVersion ?? null : null,
    updatedAt: null,
    updatedBy: null,
    allowed: Object.freeze([]),
    droppedModels: Object.freeze([]),
    warnings: Object.freeze([]),
    budgets: Object.freeze({ maxTotalDispatchesPerDay: null }),
    parameters: DEFAULT_PARAMETERS
  });
}

function entryIdentifiesSol(entry) {
  const fields = [entry.provider, entry.tier, entry.role];
  if (Array.isArray(entry.models)) fields.push(...entry.models);
  return fields.some((value) => typeof value === 'string' && SOL_TOKEN.test(value));
}

function invalid(allotmentPath, digest, raw, message) {
  return dormant({
    source: 'invalid',
    allotmentPath,
    sha256: digest,
    raw,
    reason: `config/agent-allotment.json is INVALID and the whole allotment is dormant (nothing allowed): ${message} `
      + 'Fail-dormant is deliberate: a broken allotment file can never break dispatch and can never widen selection. '
      + 'Fix the file; it takes effect at the next hook call, no restart needed.'
  });
}

function validatePositiveIntOrNull(value, label) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, message: `${label} must be null (no cap) or a positive integer; got ${JSON.stringify(value)}.` };
  }
  return { ok: true, value };
}

/**
 * Load and validate config/agent-allotment.json.
 *
 * NEVER THROWS. Every failure mode returns a dormant (enabled:false, nothing
 * allowed) result with a clear `reason`. Cached per (mtime,size); an owner
 * edit is picked up on the next call.
 *
 * @returns {{ok:boolean, enabled:boolean, source:string, path:string, sha256:string|null,
 *            reason:string|null, allowed:Array, droppedModels:Array, warnings:Array,
 *            budgets:object, parameters:object}}
 */
function loadAllotment({ allotmentPath = DEFAULT_ALLOTMENT_PATH, force = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(allotmentPath);
  } catch (error) {
    // statSync failing does not necessarily establish absence. In particular,
    // EACCES/EIO means the configured ceiling was not measured, so preserve
    // that uncertainty as an invalid/refused load instead of reporting the
    // definite (and misleading) answer "ABSENT".
    if (!error || error.code !== 'ENOENT') {
      const result = invalid(allotmentPath, null, null,
        `cannot inspect the file to establish whether it exists: ${error && error.message
          ? error.message : String(error)}.`);
      cache = null;
      return result;
    }
    const result = dormant({
      source: 'missing',
      allotmentPath,
      reason: `config/agent-allotment.json is ABSENT (looked at ${allotmentPath}): the allotment is EMPTY and `
        + 'nothing is allowed. Absence is fail-dormant, never a permissive default -- the allotment is the '
        + "owner's editable ceiling, and no ceiling means no roster advice at all. Dispatch and review proceed "
        + 'exactly as they did before the roster existed. Create the file (schemaVersion "agent-allotment-v1") '
        + 'to allow anything.'
    });
    cache = { path: allotmentPath, mtimeMs: null, size: null, result };
    return result;
  }

  if (!force && cache && cache.path === allotmentPath
    && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.result;
  }

  let raw;
  let digest = null;
  try {
    raw = fs.readFileSync(allotmentPath, 'utf8');
    digest = sha256(raw);
  } catch (error) {
    const result = invalid(allotmentPath, null, null, `cannot read the file: ${error.message}.`);
    cache = { path: allotmentPath, mtimeMs: stat.mtimeMs, size: stat.size, result };
    return result;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const result = invalid(allotmentPath, digest, null, `not valid JSON (${error.message}).`);
    cache = { path: allotmentPath, mtimeMs: stat.mtimeMs, size: stat.size, result };
    return result;
  }

  const result = validateParsed(parsed, allotmentPath, digest);
  cache = { path: allotmentPath, mtimeMs: stat.mtimeMs, size: stat.size, result };
  return result;
}

function validateParsed(parsed, allotmentPath, digest) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalid(allotmentPath, digest, parsed, 'root must be a JSON object.');
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return invalid(allotmentPath, digest, parsed,
      `unsupported schemaVersion ${JSON.stringify(parsed.schemaVersion)}; this loader understands "${SCHEMA_VERSION}".`);
  }
  if (typeof parsed.enabled !== 'boolean') {
    return invalid(allotmentPath, digest, parsed, '"enabled" must be a boolean.');
  }
  if (!Array.isArray(parsed.allowed)) {
    return invalid(allotmentPath, digest, parsed, '"allowed" must be an array (it may be empty).');
  }

  // SOL EXCLUSION: refuse the whole file, loudly, before anything else is
  // honored -- a partial acceptance would make the refusal easy to miss.
  for (const [index, entry] of parsed.allowed.entries()) {
    if (entry && typeof entry === 'object' && entryIdentifiesSol(entry)) {
      return invalid(allotmentPath, digest, parsed,
        `allowed[${index}] identifies the Codex 'sol' tier, which standing order SPAWN 2 forbids. The loader `
        + 'refuses the WHOLE file so this refusal is loud, not silent -- remove that entry to restore the rest.');
    }
  }

  const budgetsIn = parsed.budgets && typeof parsed.budgets === 'object' && !Array.isArray(parsed.budgets)
    ? parsed.budgets : {};
  const totalBudget = validatePositiveIntOrNull(budgetsIn.maxTotalDispatchesPerDay, 'budgets.maxTotalDispatchesPerDay');
  if (!totalBudget.ok) return invalid(allotmentPath, digest, parsed, totalBudget.message);

  const parametersIn = parsed.parameters && typeof parsed.parameters === 'object' && !Array.isArray(parsed.parameters)
    ? parsed.parameters : {};
  const parameters = { ...DEFAULT_PARAMETERS };
  for (const key of Object.keys(DEFAULT_PARAMETERS)) {
    if (parametersIn[key] === undefined) continue;
    if (!Number.isInteger(parametersIn[key]) || parametersIn[key] <= 0) {
      return invalid(allotmentPath, digest, parsed,
        `parameters.${key} must be a positive integer; got ${JSON.stringify(parametersIn[key])}.`);
    }
    parameters[key] = parametersIn[key];
  }

  const warnings = [];
  const droppedModels = [];
  const normalized = [];

  let floorBackends;
  try {
    const modelFloor = getModelFloor();
    floorBackends = modelFloor.backendIds();
  } catch (error) {
    return invalid(allotmentPath, digest, parsed,
      `the model floor could not be read (${error.message}); without the floor no allotment entry can be `
      + 'validated, and an unvalidated ceiling is refused rather than trusted.');
  }

  for (const [index, entry] of parsed.allowed.entries()) {
    const label = `allowed[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return invalid(allotmentPath, digest, parsed, `${label} must be an object.`);
    }
    if (typeof entry.role !== 'string' || !entry.role) {
      return invalid(allotmentPath, digest, parsed, `${label}.role must be a non-empty string.`);
    }
    if (!KNOWN_ROLES.includes(entry.role)) {
      warnings.push(`${label}.role "${entry.role}" is not a known role (${KNOWN_ROLES.join(', ')}); the entry is `
        + 'kept (it can only ever narrow, never widen) but v1 advice will not match it.');
    }
    if (entry.provider !== null && entry.provider !== undefined && typeof entry.provider !== 'string') {
      return invalid(allotmentPath, digest, parsed, `${label}.provider must be a string or null.`);
    }
    if (entry.backend !== null && entry.backend !== undefined && typeof entry.backend !== 'string') {
      return invalid(allotmentPath, digest, parsed, `${label}.backend must be a string or null.`);
    }
    const perDay = validatePositiveIntOrNull(entry.maxDispatchesPerDay, `${label}.maxDispatchesPerDay`);
    if (!perDay.ok) return invalid(allotmentPath, digest, parsed, perDay.message);

    let models = null;
    if (entry.models !== null && entry.models !== undefined) {
      if (!Array.isArray(entry.models) || entry.models.some((m) => typeof m !== 'string' || !m)) {
        return invalid(allotmentPath, digest, parsed, `${label}.models must be null or an array of non-empty strings.`);
      }
      models = [...entry.models];
    }
    if (entry.role === 'builder' && (!models || models.length === 0)) {
      return invalid(allotmentPath, digest, parsed,
        `${label} (role builder) must pin an explicit non-empty models[] list; a builder entry with no models `
        + 'would be an implicit "anything", and the allotment never widens by omission.');
    }

    // FLOOR FILTERING (gate 4): drop -- never honor -- any model id the floor
    // refuses. config/model-floor.json is the authority; this file never
    // restates it.
    if (models) {
      const modelFloor = getModelFloor();
      const kept = [];
      for (const model of models) {
        let verdictReason = null;
        if (entry.backend && floorBackends.includes(entry.backend)) {
          const verdict = modelFloor.evaluateModel({ backend: entry.backend, model });
          if (!verdict.allowed) verdictReason = verdict.reason;
        } else if (/^gemini-/.test(model)) {
          const union = modelFloor.allowedUnion();
          if (!union.includes(model)) {
            verdictReason = modelFloor.refusedReason(model)
              || `"${model}" is on no backend floor in config/model-floor.json.`;
          }
        }
        if (verdictReason) {
          droppedModels.push({ entry: index, model, reason: verdictReason });
          warnings.push(`${label}: model "${model}" DROPPED at load -- ${verdictReason}`);
        } else {
          kept.push(model);
        }
      }
      models = kept;
      if (models.length === 0) {
        warnings.push(`${label}: every listed model was dropped by the floor; the entry allows nothing until the `
          + 'owner lists an on-floor model (see config/model-floor.json).');
      }
    }

    normalized.push(Object.freeze({
      role: entry.role,
      provider: entry.provider ?? null,
      backend: entry.backend ?? null,
      models: models ? Object.freeze(models) : null,
      maxDispatchesPerDay: perDay.value
    }));
  }

  const enabled = parsed.enabled === true;
  return Object.freeze({
    ok: true,
    enabled,
    source: 'file',
    path: allotmentPath,
    relativePath: RELATIVE_ALLOTMENT_PATH,
    sha256: digest,
    reason: enabled ? null
      : 'enabled:false -- the owner disabled the roster; nothing is allowed and dispatch behaves exactly as '
      + 'before the roster existed. Set "enabled": true to re-allow.',
    schemaVersion: parsed.schemaVersion,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : null,
    allowed: Object.freeze(normalized),
    droppedModels: Object.freeze(droppedModels),
    warnings: Object.freeze(warnings),
    budgets: Object.freeze({ maxTotalDispatchesPerDay: totalBudget.value }),
    parameters: Object.freeze(parameters)
  });
}

/**
 * Allotment-only eligibility of a {role, provider, model, backend} selection.
 * The floor and availability are separate bounds (see checkSelection); this
 * answers only "does the owner's ceiling include this triple?".
 */
function isAllowed(allotment, { role = 'builder', provider = null, model = null, backend = null } = {}) {
  if (!allotment || typeof allotment !== 'object') {
    return { allowed: false, entry: null, reason: 'no allotment was provided to isAllowed().' };
  }
  if (!allotment.enabled) {
    return {
      allowed: false,
      entry: null,
      reason: allotment.reason
        || 'the allotment is dormant (enabled:false or missing/invalid file); nothing is allowed.'
    };
  }
  for (const entry of allotment.allowed) {
    if (entry.role !== role) continue;
    if (entry.provider !== null && entry.provider !== provider) continue;
    if (entry.backend !== null && entry.backend !== backend) continue;
    if (entry.models !== null) {
      if (typeof model !== 'string' || !entry.models.includes(model)) continue;
    }
    return { allowed: true, entry, reason: null };
  }
  return {
    allowed: false,
    entry: null,
    reason: `no allowed[] entry in ${RELATIVE_ALLOTMENT_PATH} matches `
      + `{role:${JSON.stringify(role)}, provider:${JSON.stringify(provider)}, model:${JSON.stringify(model)}, `
      + `backend:${JSON.stringify(backend)}}. The allotment is a ceiling: what is not listed is not allowed.`
  };
}

/**
 * allotment INTERSECT floor for one selection (gate 4 bounds a and b).
 * Availability (bound c: a running supervisor's backend and, for vertex, a
 * non-null laneProject) is knowable only inside the supervisor and is reported
 * as 'unknown-here' rather than guessed.
 *
 * Never throws.
 */
function checkSelection({ role = 'builder', provider = null, model = null, backend = null } = {}, { allotment } = {}) {
  const resolved = allotment || loadAllotment();
  const gate = isAllowed(resolved, { role, provider, model, backend });
  if (!gate.allowed) {
    return { eligible: false, stage: 'allotment', reason: gate.reason, entry: null };
  }
  try {
    const laneModels = getLaneModels();
    const modelFloor = getModelFloor();
    if (backend !== null && laneModels.BACKENDS.includes(backend)) {
      laneModels.assertLaneModelFor(backend, model);
    } else if (typeof model === 'string' && /^gemini-/.test(model)) {
      modelFloor.assertOnSomeFloor(model);
    }
  } catch (error) {
    return { eligible: false, stage: 'floor', reason: error.message, entry: gate.entry };
  }
  return { eligible: true, stage: null, reason: null, entry: gate.entry, availability: 'unknown-here' };
}

/** The scoreboard's allotmentSnapshot: what decisions were computed against. */
function snapshotOf(allotment) {
  const resolved = allotment || loadAllotment();
  return {
    path: RELATIVE_ALLOTMENT_PATH,
    sha256: resolved.sha256,
    enabled: resolved.enabled
  };
}

function clearCache() {
  cache = null;
}

module.exports = {
  DEFAULT_ALLOTMENT_PATH,
  RELATIVE_ALLOTMENT_PATH,
  SCHEMA_VERSION,
  DEFAULT_PARAMETERS,
  loadAllotment,
  isAllowed,
  checkSelection,
  snapshotOf,
  clearCache
};
