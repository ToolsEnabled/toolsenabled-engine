'use strict';

// Saved-value mechanics shared by the settings surface and kernel tuning.
// Callers supply any authority readbacks or domain-specific validation; this
// module never loads machine authority, models, dispatch or settings surfaces.
const fs = require('node:fs');
const SOURCES = new Set(['default', 'installer', 'user']);

function validateSettingValue(entry, raw, { allowEmpty = false } = {}) {
  let valid;
  switch (entry.control) {
    case 'toggle':
      valid = typeof raw === 'boolean';
      break;
    case 'seg':
    case 'select':
      valid = Array.isArray(entry.options) && entry.options.includes(raw);
      break;
    case 'list':
      valid = Array.isArray(raw);
      break;
    case 'duration':
    case 'number':
      valid = typeof raw === 'number' && Number.isFinite(raw);
      break;
    case 'readback':
      valid = typeof raw === 'string';
      break;
    // Chosen from a list this catalogue cannot hold, so the value is checked
    // for being a choice at all rather than against declared options. Blank is
    // refused: an empty model name is not a selection, and storing one would
    // leave a person looking at a chooser that shows nothing chosen while the
    // setting claims to be set. The two role-specific model defaults explicitly
    // use the empty string to mean "inherit the shared model.name" instead.
    case 'pick':
    // Typed rather than chosen, and checked the same way for the same reason:
    // there is no declared list to check against, only whether the person
    // supplied something. What separates it from `pick` is what the window
    // draws, not what counts as valid here.
    case 'text':
      valid = typeof raw === 'string' && (raw.trim() !== '' ||
        (raw === '' && allowEmpty));
      break;
    default:
      valid = false;
  }
  if (valid && ['number', 'duration'].includes(entry.control)) {
    if (entry.minimum !== undefined && raw < entry.minimum || entry.maximum !== undefined && raw > entry.maximum) return `Setting "${entry.id}" must be between ${entry.minimum} and ${entry.maximum}.`;
    if (entry.step !== undefined && Math.abs((raw - (entry.minimum || 0)) / entry.step - Math.round((raw - (entry.minimum || 0)) / entry.step)) > 1e-9) return `Setting "${entry.id}" must use increments of ${entry.step}.`;
  }
  if (valid) return null;
  const expected = entry.control === 'seg' || entry.control === 'select'
    ? `one of the configured ${entry.control} options`
    : `a valid ${entry.control} value`;
  return `Setting "${entry.id}" must be ${expected}.`;
}

function readSettingsDocument(valuesPath, rejected) {
  let document;
  try { document = JSON.parse(fs.readFileSync(valuesPath, 'utf8')); }
  catch (error) {
    if (error && error.code !== 'ENOENT') rejected.push({ id: '*', raw: null,
      reason: `Settings file "${valuesPath}" could not be read: ${error.message}` });
    return { valid: false, document, revision: 0 };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)
      || !document.values || typeof document.values !== 'object' || Array.isArray(document.values)
      || !Number.isFinite(document.revision)) {
    rejected.push({ id: '*', raw: document, reason: `Settings file "${valuesPath}" has an invalid structure.` });
    return { valid: false, document, revision: 0 };
  }
  return { valid: true, document, revision: document.revision };
}

function applyStoredValues({ registry, document, requested, values, provenance, rejected,
  readOnlyReason = entry => entry.control === 'readback' && typeof entry.readOnlyReason === 'string'
    && entry.readOnlyReason.trim() ? `Setting "${entry.id}" is read-only. ${entry.readOnlyReason.trim()}` : null,
  normalize = (entry, raw) => raw, validate = validateSettingValue }) {
  for (const [id, raw] of Object.entries(document.values)) {
    if (requested && !requested.has(id)) continue;
    const entry = registry.byId.get(id);
    if (!entry) {
      rejected.push({ id, raw, reason: `Setting "${id}" is unknown and is not present in the registry.` });
      continue;
    }
    const readOnly = readOnlyReason(entry, id);
    if (readOnly) { rejected.push({ id, raw: null, reason: readOnly }); continue; }
    const value = normalize(entry, raw);
    const reason = validate(entry, value);
    if (reason) { rejected.push({ id, raw, reason }); continue; }
    const recorded = document.provenance && document.provenance[id];
    if (!recorded || !SOURCES.has(recorded.source)) {
      rejected.push({ id, raw, reason: `Setting "${id}" has missing or invalid provenance.` });
      continue;
    }
    values[id] = value;
    provenance[id] = { source: recorded.source, atMs: recorded.atMs, directive: recorded.directive };
  }
}

module.exports = Object.freeze({ validateSettingValue, readSettingsDocument, applyStoredValues });
