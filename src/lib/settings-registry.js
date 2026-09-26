'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, '../../config/settings-registry.json');
const SECTIONS = new Set(['A', 'B', 'C', 'D', 'E', 'F']);
// `pick` is chosen by the person from a list discovered at RUN TIME, which is
// what separates it from `seg` and `select`: those two are validated against
// this catalogue's own static `options` array, and a local model's name is
// whatever the endpoint happens to be serving. Classifying such a row as
// `select` would refuse every model the person owns; classifying it `readback`
// - the class for values the system maintains and shows - is what made the
// model answering on their own computer something they could read and not
// choose. A `pick` row therefore declares no `options` and validates as text.
// `text` is the other half of the same problem `pick` solved. A model name is
// CHOSEN from a list discovered at run time; the address that runtime listens
// on is TYPED, and nothing can enumerate every address a person's own machine
// or network might use. Both declare no `options` and both validate as a
// non-empty string; they are separate classes because they mean different
// things to the window, which draws a chooser for one and a field for the
// other. Left as `readback`, an address is something a person can read and not
// correct, which is why an Ollama on any but the default address could not be
// reached from the settings page at all.
const CONTROLS = new Set(['toggle', 'seg', 'select', 'list', 'duration', 'readback', 'number', 'pick', 'text']);
const ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const FIELDS = new Set([
  'id', 'section', 'depth', 'control', 'options', 'default', 'consequence',
  'derivedFrom', 'enforcedBy', 'warningText',
  'readOnlyReason',
  'capabilities', 'risks', 'externalStep', 'minimum', 'maximum', 'step', 'unit', 'applies', 'platforms',
]);

// --- CAPABILITIES AND RISKS, SEPARATELY (R1529 gate 8) ------------------------
//
// The requirement: every setting must also state, separately, the capabilities
// it grants and the risks it carries. `consequence` already existed and is
// kept, but it is ONE blended sentence: it tells a reader what happens, with
// the gain and the cost dissolved into each other. A person deciding whether to
// move a switch is asking two separate questions -- what does this let happen
// that cannot happen now, and what can go wrong if I do it -- and a blended
// paragraph makes them do the separating themselves, which is exactly the work
// the product is supposed to have done for them.
//
// So `capabilities` and `risks` are two arrays, each item one plain statement.
//
// THE RISK STATEMENTS ARE ALLOWED TO SAY THERE IS NO RISK, and several do. A
// scary sentence attached to a setting that changes a colour is not caution; it
// is the thing that teaches a person to scroll past every risk line in the
// product, including the ones about sending mail as them. An honest "nothing on
// this computer becomes reachable because of this" is worth more than an
// invented hazard, and it is what these say where it is true.
const EXTERNAL_STEP_FIELDS = new Set([
  'whatItDoes', 'capabilitiesGained', 'risks', 'required', 'elevation',
  'neverPerformedForYou', 'steps', 'verify', 'withoutIt',
  'frequency', 'frequencyBecause',
]);
const EXTERNAL_STEP_ITEM_FIELDS = new Set(['do', 'why']);

// --- HOW OFTEN THIS ACTUALLY ASKS SOMETHING OF YOU (R1536) -------------------
//
// The requirement: label each outside step with how often it will actually ask
// the person to do something -- typically, sometimes, rarely -- so they know
// before they commit to it.
//
// Four words, and no fifth. A closed set is what lets a surface show the label
// as a badge rather than as another sentence to read, and it is what stops the
// vocabulary drifting into "occasionally", "may", "in some cases" -- which are
// the words a product reaches for when it would rather not commit.
const FREQUENCIES = new Set(['typically', 'sometimes', 'rarely', 'never']);

// THE LABEL HAS TO BE DERIVED, AND THE DERIVATION HAS TO BE WRITTEN DOWN.
// `frequencyBecause` is required alongside it so a future reader can CHALLENGE
// the claim instead of inheriting it. This is not ceremony: the finding this
// whole lane exists to correct was "no ToolsEnabled app setting requires UAC
// elevation", which was true of one machine whose UAC consent prompt is turned
// off, and it went unchallenged because nobody had written down what it rested
// on. A label reasoned from "it never asked me here" is the same error wearing
// a badge, and the sentence it has to write makes that visible.
function validateFrequency(step, errors) {
  const hasFrequency = Object.prototype.hasOwnProperty.call(step, 'frequency');
  const hasBecause = Object.prototype.hasOwnProperty.call(step, 'frequencyBecause');

  if (hasFrequency && !FREQUENCIES.has(step.frequency)) {
    errors.push(`externalStep.frequency must be one of: ${[...FREQUENCIES].join(', ')}`);
  }
  if (hasBecause && (typeof step.frequencyBecause !== 'string' || step.frequencyBecause.trim() === '')) {
    errors.push('externalStep.frequencyBecause must be non-empty text');
  }
  if (hasFrequency && !hasBecause) {
    errors.push('externalStep.frequency requires frequencyBecause: a label nobody has to justify is a label nobody can argue with');
  }
  // Presence is enforced only where the requirement demands it -- the steps
  // that need an administrator. A non-elevated outside step may carry a label
  // and is not made to.
  if (step.elevation === true && !hasFrequency) {
    errors.push('externalStep.frequency is required when elevation is true: every step that can need an administrator must say how often it asks something of you');
  }
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.trim() !== '');
}

// --- THE STEP THIS PRODUCT WALKS YOU THROUGH AND NEVER TAKES FOR YOU ----------
//
// The R1529 requirement: when a setting a person changes needs a UAC-elevated
// step outside this product, the product walks them through that step rather
// than performing it, tells them the pros and cons, and makes clear the
// setting saves and turns on without the step -- it just may not work fully
// until the step is done.
//
// Three properties are encoded as DATA rather than left to the wording of a
// paragraph, because a paragraph can be edited into something else and a
// required literal cannot:
//
//   required: false             the setting turns on without this step. Any
//                               other value is a load error, so no future entry
//                               can quietly make an outside step a precondition.
//   neverPerformedForYou: true  this product prints the step; it does not run
//                               it. Encoded on every declaration for the same
//                               reason -- a lane that ever wanted to perform one
//                               would have to delete this line to do it, and
//                               deleting it is a visible act in a diff.
//   withoutIt                   what actually happens if the person declines:
//                               the honest partial-function sentence, which is
//                               neither a silent failure nor a refusal to save.
function validateExternalStep(step) {
  const errors = [];
  if (!step || typeof step !== 'object' || Array.isArray(step)) return ['externalStep must be an object'];

  for (const field of Object.keys(step)) {
    if (!EXTERNAL_STEP_FIELDS.has(field)) errors.push(`externalStep.${field} is not a recognized field`);
  }
  if (typeof step.whatItDoes !== 'string' || step.whatItDoes.trim() === '') errors.push('externalStep.whatItDoes must be non-empty text');
  if (!nonEmptyStringArray(step.capabilitiesGained)) errors.push('externalStep.capabilitiesGained must be a non-empty array of text');
  if (!nonEmptyStringArray(step.risks)) errors.push('externalStep.risks must be a non-empty array of text');
  if (step.required !== false) errors.push('externalStep.required must be literally false: an outside step may never be a precondition for saving the setting');
  if (step.neverPerformedForYou !== true) errors.push('externalStep.neverPerformedForYou must be literally true: this product prints the step and never performs it');
  if (Object.prototype.hasOwnProperty.call(step, 'elevation') && typeof step.elevation !== 'boolean') errors.push('externalStep.elevation must be a boolean when present');
  validateFrequency(step, errors);
  if (typeof step.verify !== 'string' || step.verify.trim() === '') errors.push('externalStep.verify must say how the person knows it worked');
  if (typeof step.withoutIt !== 'string' || step.withoutIt.trim() === '') errors.push('externalStep.withoutIt must say what still works and what does not without the step');

  if (!Array.isArray(step.steps) || step.steps.length === 0) {
    errors.push('externalStep.steps must be a non-empty array');
  } else {
    for (const [index, item] of step.steps.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`externalStep.steps[${index}] must be an object`);
        continue;
      }
      for (const field of Object.keys(item)) {
        if (!EXTERNAL_STEP_ITEM_FIELDS.has(field)) errors.push(`externalStep.steps[${index}].${field} is not a recognized field`);
      }
      if (typeof item.do !== 'string' || item.do.trim() === '') errors.push(`externalStep.steps[${index}].do must be non-empty text`);
      if (Object.prototype.hasOwnProperty.call(item, 'why') && (typeof item.why !== 'string' || item.why.trim() === '')) {
        errors.push(`externalStep.steps[${index}].why must be non-empty text when present`);
      }
    }
  }
  return errors;
}

function validateEntry(entry) {
  const errors = [];
  const required = ['id', 'section', 'depth', 'control', 'default', 'consequence', 'derivedFrom', 'enforcedBy'];

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, errors: ['entry must be an object'] };
  }

  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(entry, field)) errors.push(`${field} is required`);
  }
  for (const field of Object.keys(entry)) {
    if (!FIELDS.has(field)) errors.push(`${field} is not a recognized field`);
  }
  if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) errors.push('id must be dotted lowercase text');
  if (typeof entry.section !== 'string' || !SECTIONS.has(entry.section)) errors.push('section must be one of A through F');
  if (!Number.isInteger(entry.depth) || entry.depth < 1 || entry.depth > 4) errors.push('depth must be an integer from 1 through 4');
  if (typeof entry.control !== 'string' || !CONTROLS.has(entry.control)) errors.push('control is not supported');
  if (typeof entry.consequence !== 'string' || entry.consequence.trim() === '') errors.push('consequence must be non-empty text');
  if (typeof entry.derivedFrom !== 'string') errors.push('derivedFrom must be a string');
  if (typeof entry.enforcedBy !== 'string') errors.push('enforcedBy must be a string');

  if (entry.control === 'seg' || entry.control === 'select') {
    if (!Array.isArray(entry.options) || entry.options.length === 0 ||
        entry.options.some((option) => typeof option !== 'string' || option.trim() === '')) {
      errors.push('options must be a non-empty array for seg and select controls');
    } else if (!entry.options.includes(entry.default)) {
      errors.push('default must be one of the control options');
    }
  } else if (Object.prototype.hasOwnProperty.call(entry, 'options')) {
    errors.push('options must be omitted for this control');
  }

  for (const field of ['minimum', 'maximum', 'step']) {
    if (entry[field] !== undefined && (!['number', 'duration'].includes(entry.control) || !Number.isFinite(entry[field]) || (field === 'step' && entry[field] <= 0))) errors.push(`${field} must be a finite numeric bound`);
  }
  if (entry.minimum !== undefined && entry.maximum !== undefined && entry.minimum > entry.maximum) errors.push('minimum cannot exceed maximum');
  if (entry.minimum !== undefined && entry.default < entry.minimum || entry.maximum !== undefined && entry.default > entry.maximum) errors.push('default must be inside numeric bounds');
  if (entry.unit !== undefined && typeof entry.unit !== 'string') errors.push('unit must be text');
  if (entry.applies !== undefined && !['next-call', 'next-session', 'restart'].includes(entry.applies)) errors.push('applies must name a supported change boundary');
  if (entry.platforms !== undefined && (!Array.isArray(entry.platforms) || entry.platforms.some(value => !['linux', 'win32', 'darwin'].includes(value)))) errors.push('platforms must name supported systems');

  if (entry.control === 'toggle' && typeof entry.default !== 'boolean') errors.push('toggle default must be boolean');
  if (entry.control === 'list' && !Array.isArray(entry.default)) errors.push('list default must be an array');
  if ((entry.control === 'duration' || entry.control === 'number') &&
      (typeof entry.default !== 'number' || !Number.isFinite(entry.default))) {
    errors.push(`${entry.control} default must be a finite number`);
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'readOnlyReason')) {
    if (entry.control !== 'readback') errors.push('readOnlyReason is only valid for readback controls');
    if (typeof entry.readOnlyReason !== 'string' || entry.readOnlyReason.trim() === '') {
      errors.push('readOnlyReason must be non-empty text');
    }
  }
  if (entry.depth === 4) {
    if (typeof entry.warningText !== 'string' || entry.warningText.trim() === '') errors.push('depth-4 entries require warningText');
  } else if (Object.prototype.hasOwnProperty.call(entry, 'warningText')) {
    errors.push('warningText must be omitted below depth 4');
  }

  // SHAPE IS ENFORCED HERE; PRESENCE IS ENFORCED BY THE RATCHET BELOW.
  // Same division this file already makes for enforcedBy, and for the same
  // reason: a missing explanation must not be able to take the whole settings
  // surface down at load time, but it must not be able to arrive unnoticed
  // either. See unexplainedIds().
  if (Object.prototype.hasOwnProperty.call(entry, 'capabilities') && !nonEmptyStringArray(entry.capabilities)) {
    errors.push('capabilities must be a non-empty array of non-empty text');
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'risks') && !nonEmptyStringArray(entry.risks)) {
    errors.push('risks must be a non-empty array of non-empty text');
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'externalStep')) {
    errors.push(...validateExternalStep(entry.externalStep));
  }

  return { ok: errors.length === 0, errors };
}

// --- WHO ACTUALLY ENFORCES THIS SETTING? -------------------------------------
//
// `derivedFrom` (where the value came from) and `enforcedBy` (what makes it true
// at runtime) are REQUIRED fields, but validateEntry only ever checked
// `typeof === 'string'`, and the empty string is a string. So an entry that
// declares NO enforcer and NO provenance validates exactly like one that names
// both, and tests/settings-registry.test.js asserted the same `typeof`, which
// means that test can never go red for the thing the two fields exist to
// guarantee. Measured on the shipped catalogue as this landed: 41 of 51
// entries carry `enforcedBy: ""` and 11 carry `derivedFrom: ""`.
//
// These predicates make the absence NAMEABLE rather than merely present, so a
// surface can be honest that a row it is drawing is not wired to anything, and
// so a ratchet can stop the 52nd unenforced setting from being added in silence.
// They deliberately do NOT reject the existing 41 -- turning them into a load
// failure would take the whole settings surface down. Paying that debt down is a
// separate backlog item; refusing to let it GROW is this file's job.
function enforcementDeclared(entry) {
  return typeof entry?.enforcedBy === 'string' && entry.enforcedBy.trim() !== '';
}

function provenanceDeclared(entry) {
  return typeof entry?.derivedFrom === 'string' && entry.derivedFrom.trim() !== '';
}

function requireEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('settings registry entries must be an array');
  }
  return entries;
}

/** Ids whose entry names nothing that enforces them, sorted for stable diffing. */
function unenforcedIds(entries) {
  return requireEntries(entries).filter(entry => !enforcementDeclared(entry)).map(entry => entry.id).sort();
}

/** Ids whose entry names no origin for its value, sorted for stable diffing. */
function unprovenancedIds(entries) {
  return requireEntries(entries).filter(entry => !provenanceDeclared(entry)).map(entry => entry.id).sort();
}

// --- A DECLARED ENFORCER THAT NEVER READS THE ROW ----------------------------
//
// `enforcementDeclared` above answers "did the catalogue write anything here",
// which was the whole guarantee until now, and it is not the guarantee the
// field exists for. tools/settings-set.js has said so in a comment since it was
// written -- "the catalogue is asserting a file, and four of these assertions
// name a file that never mentions the id" -- and nothing acted on it, so the
// four rows kept printing a claimed enforcer while doing nothing. A comment
// naming a defect is the disabled button with an excuse; this is the check.
//
// MEASURED 2026-09-03 on this tree, by opening every .js/.mjs/.cjs/.ps1 outside
// node_modules and asking which contain each row's id: four of the 71 rows
// declared an enforcer that no file mentions, and the other 34 declarations
// each named at least one file carrying the id. The four are listed, with what
// each one would take to wire, in tests/settings-rows-inert.test.js -- and NOT
// here, because that suite also asks whether a row's id appears anywhere in the
// tree outside tests, and a list of dead ids sitting in a scanned source file
// is a mention. A check whose own evidence satisfies it is the guard that
// cannot fail, one more time.
//
// WHAT IS CHECKABLE IN PROSE. `enforcedBy` is a sentence, deliberately: several
// rows describe a chain across four files. The repo-relative PATHS inside that
// sentence are the part a machine can open, so they are pulled out and opened.
// A sentence naming no path is `unsited` -- a claim this check cannot judge,
// which is its own answer and not a pass.
//
// AND "COULD NOT LOOK" IS NOT "NOT THERE". A named file that cannot be read
// yields `unlooked`, never `absent`. Reporting an unreadable file as a missing
// reader would retire a real enforcer on the strength of a permissions error,
// which is the failure this repo keeps re-finding in the other direction.
const ENFORCEMENT_SITE_PATTERN =
  /(?:^|[\s(",;`])((?:src|tools|shell|config|packages|adapters|sidecars|bin|scripts)\/[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*\.(?:mjs|cjs|json|js|ps1))(?![A-Za-z0-9_])/g;

/** The repo-relative files an `enforcedBy` sentence names, in order, deduplicated. */
function enforcementSites(entry) {
  if (!enforcementDeclared(entry)) return [];
  const seen = [];
  for (const match of entry.enforcedBy.matchAll(ENFORCEMENT_SITE_PATTERN)) {
    if (!seen.includes(match[1])) seen.push(match[1]);
  }
  return seen;
}

function defaultSourceReader(relativePath) {
  const absolute = path.resolve(__dirname, '..', '..', ...relativePath.split('/'));
  try {
    return { ok: true, text: fs.readFileSync(absolute, 'utf8') };
  } catch (error) {
    return { ok: false, reason: (error && error.code) || 'UNREADABLE' };
  }
}

/**
 * Is this row's declared enforcer a file that actually mentions the row?
 *
 *   'undeclared'  the row names no enforcer at all (unenforcedIds owns that)
 *   'unsited'     it names one in prose that contains no repo-relative path
 *   'verified'    a named file was read and carries the id
 *   'unlooked'    no named file carrying the id was READABLE -- could not look
 *   'absent'      every named file was read and none carries the id
 *
 * `readSource(relativePath)` returns { ok: true, text } or { ok: false, reason }.
 */
function enforcementVerdict(entry, { readSource } = {}) {
  const sites = enforcementSites(entry);
  const id = entry && typeof entry.id === 'string' ? entry.id : null;
  if (!enforcementDeclared(entry)) return { id, verdict: 'undeclared', sites: [], carrying: [], unreadable: [] };
  if (sites.length === 0) return { id, verdict: 'unsited', sites: [], carrying: [], unreadable: [] };

  const read = typeof readSource === 'function' ? readSource : defaultSourceReader;
  const carrying = [];
  const unreadable = [];
  for (const site of sites) {
    const answer = read(site);
    if (!answer || answer.ok !== true) {
      unreadable.push({ site, reason: (answer && answer.reason) || 'UNREADABLE' });
      continue;
    }
    if (id !== null && String(answer.text).includes(id)) carrying.push(site);
  }
  if (carrying.length > 0) return { id, verdict: 'verified', sites, carrying, unreadable };
  if (unreadable.length > 0) return { id, verdict: 'unlooked', sites, carrying, unreadable };
  return { id, verdict: 'absent', sites, carrying, unreadable };
}

/** Ids that declare an enforcer every named file was read and found not to mention. */
function unverifiedEnforcementIds(entries, dependencies) {
  return requireEntries(entries)
    .filter(entry => enforcementVerdict(entry, dependencies).verdict === 'absent')
    .map(entry => entry.id).sort();
}

/** Ids whose declared enforcer could not be looked at -- a different answer. */
function unlookedEnforcementIds(entries, dependencies) {
  return requireEntries(entries)
    .filter(entry => enforcementVerdict(entry, dependencies).verdict === 'unlooked')
    .map(entry => entry.id).sort();
}

/** Does this entry state, separately, what it grants and what it costs? */
function explanationDeclared(entry) {
  return nonEmptyStringArray(entry?.capabilities) && nonEmptyStringArray(entry?.risks);
}

/** Ids that state no capabilities or no risks, sorted for stable diffing. */
function unexplainedIds(entries) {
  return requireEntries(entries).filter((entry) => !explanationDeclared(entry)).map((entry) => entry.id).sort();
}

/** Ids whose full function depends on a step outside this product's control. */
function externalStepIds(entries) {
  return requireEntries(entries).filter((entry) => entry && entry.externalStep).map((entry) => entry.id).sort();
}

/** Ids whose outside step can need an administrator, sorted for stable diffing. */
function elevationStepIds(entries) {
  return requireEntries(entries)
    .filter((entry) => entry && entry.externalStep && entry.externalStep.elevation === true)
    .map((entry) => entry.id).sort();
}

/**
 * The guided step for one setting, or null.
 *
 * Returns null rather than a placeholder for an id that has no declaration, so
 * a surface has to decide what to say about an absence instead of being handed
 * an empty walkthrough that renders as though a step existed.
 */
function externalStepFor(entry) {
  return entry && entry.externalStep ? entry.externalStep : null;
}

// The catalogue is read on hot synchronous paths (the tree-slot settings IPC,
// runtimePolicy() on every ledger operation). Parse and validate one file state
// once: the cache is keyed by the file's identity, size and both timestamps,
// so any rewrite or replacement is read again. Cached entries are deep-frozen
// and every caller receives its own containers, so no caller can alter what
// another one reads. A file whose state cannot be observed is never cached.
const REGISTRY_CACHE_LIMIT = 8;
const registryCache = new Map();

function registryStamp(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile()) return null;
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
  } catch { return null; }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function registryView(registry) {
  return { entries: registry.entries.slice(), byId: new Map(registry.byId), titles: { ...registry.titles } };
}

function loadRegistry({ registryPath = DEFAULT_REGISTRY_PATH } = {}) {
  const file = path.resolve(registryPath);
  const stamp = registryStamp(file);
  const known = stamp === null ? null : registryCache.get(file);
  if (known && known.stamp === stamp) return registryView(known.registry);
  const registry = readRegistry(file);
  // Keep only a state that was stable across the read.
  if (stamp !== null && registryStamp(file) === stamp) {
    registryCache.delete(file);
    registryCache.set(file, { stamp, registry: deepFreeze(registry) });
    while (registryCache.size > REGISTRY_CACHE_LIMIT) registryCache.delete(registryCache.keys().next().value);
    return registryView(registry);
  }
  registryCache.delete(file);
  return registry;
}

function readRegistry(registryPath) {
  const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed && parsed.entries;
  if (!Array.isArray(entries)) throw new TypeError('settings registry must contain an entries array');

  const byId = new Map();
  for (const [index, entry] of entries.entries()) {
    const validation = validateEntry(entry);
    if (!validation.ok) throw new TypeError(`invalid settings registry entry at index ${index}: ${validation.errors.join('; ')}`);
    if (byId.has(entry.id)) throw new TypeError(`duplicate settings registry id: ${entry.id}`);
    byId.set(entry.id, entry);
  }

  // The registry file has always carried a `titles` map -- the short human name
  // for each id, the thing a person reads on a settings row. Until now this
  // loader parsed it and threw it away, so every surface that wanted to SHOW a
  // setting to a human had two bad options: re-read config/settings-registry.json
  // behind the loader's back, or print the raw id. Returning it here is what lets
  // a surface name a setting without re-deriving the registry path. An absent
  // map stays empty, but a present malformed map is refused rather than being
  // reported as though the registry definitely declared no titles.
  if (parsed && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'titles') &&
      (!parsed.titles || typeof parsed.titles !== 'object' || Array.isArray(parsed.titles))) {
    throw new TypeError('settings registry titles must be an object when present');
  }
  const titles = parsed && !Array.isArray(parsed) && parsed.titles
    && typeof parsed.titles === 'object' && !Array.isArray(parsed.titles)
    ? parsed.titles
    : {};

  return { entries, byId, titles };
}

module.exports = {
  loadRegistry, validateEntry, validateExternalStep,
  enforcementDeclared, provenanceDeclared, unenforcedIds, unprovenancedIds,
  enforcementSites, enforcementVerdict, unverifiedEnforcementIds, unlookedEnforcementIds,
  explanationDeclared, unexplainedIds, externalStepIds, externalStepFor,
  elevationStepIds, FREQUENCIES
};
