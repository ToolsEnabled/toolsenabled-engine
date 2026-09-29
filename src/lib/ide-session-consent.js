'use strict';

// IDE session consent: discovered sessions are LISTED, never auto-adopted.
//
// The requirement, paraphrased: customers should be able to keep using VS Code
// agents and other IDEs, but sessions that are not native to this product must
// be imported by explicit choice rather than showing up automatically. Consent
// to display, without giving up the editor they already work in.
//
// WHAT WAS WRONG BEFORE THIS MODULE. `agent-session-observer.js` discovers
// provider sessions on the machine and `agent-attribution-projection.js` feeds
// them straight into the read-only projection the dashboard renders. There was no
// consent step anywhere between discovery and display, so every session the
// scanner could see appeared on the owner's dashboard whether or not it had been
// asked for. For a personal tool that was merely surprising. For a shipped product it
// is not acceptable: a customer's editor sessions are theirs, and a product that
// hoovers them up by default has made a decision that belongs to the customer.
//
// THE UNIT OF CONSENT IS THE SURFACE, NOT THE SESSION. A session id is ephemeral
// -- consenting per session would mean re-consenting every time the editor is
// reopened, which trains people to click yes without reading. The observer already
// derives a stable `surface` slug from the provider's own record (for example
// `claude-vscode`, `codex-vscode`, `codex-desktop`, `sdk-cli`), and that is the
// thing a person actually means when they say "yes, watch my VS Code sessions".
// So consent is granted per surface and persists until withdrawn.
//
// ABSENCE MUST NEVER READ AS EMPTINESS. This repository has now found the same
// defect seven times: a control that is given nothing to work with reports a clean,
// confident, empty result, and the emptiness is mistaken for a finding. Here the
// dangerous misreading is the reverse of the usual one -- "no sessions imported"
// silently rendering as "no sessions exist", which would hide the very list the
// owner has to choose from and make the import feature look broken or, worse, make
// a customer believe nothing was discovered about them.
//
// This module therefore never returns a bare array. Every result carries
// `discoveredTotal` alongside `imported` and `available`, so a caller cannot render
// a count without having been handed the total it came from. A missing consent file
// is a NORMAL first-run state that yields zero imported and EVERY discovered session
// in `available` -- it is never an error and never an empty discovery.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const CONSENT_RELATIVE_PATH = path.join('config', 'ide-session-consent.json');

// Consent states a session can be in. Kept closed and explicit so a renderer must
// handle each one rather than falling through to a default that hides a case.
const CONSENT_STATES = Object.freeze(['imported', 'not-imported']);

// Why a consent set is what it is. `absent` and `empty` are deliberately distinct:
// "you have never made a choice" and "you chose to import nothing" look identical
// in the data but are different things to say to a person.
const CONSENT_SOURCES = Object.freeze(['file', 'absent', 'empty', 'malformed']);
const IMPORT_POLICIES = Object.freeze(['none', 'ask', 'all-detected']);

// Surface slugs are lowercase tokens produced by the observer's own regex gate.
// Re-validating here means a hand-edited config cannot smuggle anything else into
// a comparison, and keeps this module's inputs as narrow as the observer's outputs.
//
// The underscore in the class is load-bearing: Codex reports its editor surface as
// `codex_vscode`. Dropping `_` would reclassify a real, identifiable VS Code
// surface as "surfaceless", making the exact IDE case the owner asked for the one
// case that did not work. The pattern stays case-sensitive because the observer
// lowercases before emitting; accepting mixed case here would let a hand-edited
// config declare `Codex_VSCode` and then never match anything the observer emits.
const SURFACE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function consentFilePath(root) {
  return path.join(root, CONSENT_RELATIVE_PATH);
}

/**
 * Read the owner's/customer's import choices.
 *
 * A missing file is the expected first-run state, not a failure: it means no
 * choice has been made yet. A malformed file IS reported as malformed rather than
 * being silently treated as empty, because "your choices could not be read" and
 * "you chose nothing" must never look the same -- quietly downgrading the first
 * into the second would drop consent the customer had actually granted.
 */
function loadSessionConsent(root, dependencies = {}) {
  const io = dependencies.fs || fs;
  const file = consentFilePath(root);

  let raw;
  try {
    raw = io.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return Object.freeze({
        ok: true,
        source: 'absent',
        importedSurfaces: Object.freeze([]),
        excludedSurfaces: Object.freeze([]),
        importPolicy: 'none',
        reason: 'no import choices have been made yet on this machine',
        file
      });
    }
    return Object.freeze({
      ok: false,
      source: 'malformed',
      importedSurfaces: Object.freeze([]),
      reason: `import choices exist but could not be read: ${error && error.message}`,
      file
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return Object.freeze({
      ok: false,
      source: 'malformed',
      importedSurfaces: Object.freeze([]),
      reason: `import choices are not valid JSON: ${error && error.message}`,
      file
    });
  }

  const declared = parsed && Array.isArray(parsed.importedSurfaces) ? parsed.importedSurfaces : null;
  if (declared === null) {
    return Object.freeze({
      ok: false,
      source: 'malformed',
      importedSurfaces: Object.freeze([]),
      reason: 'import choices are missing the importedSurfaces array',
      file
    });
  }

  const importPolicy = parsed.importPolicy === undefined ? 'ask' : parsed.importPolicy;
  const excluded = parsed.excludedSurfaces === undefined ? [] : parsed.excludedSurfaces;
  if (!IMPORT_POLICIES.includes(importPolicy) || !Array.isArray(excluded)
      || excluded.some(surface => typeof surface !== 'string' || !SURFACE_RE.test(surface))) {
    return Object.freeze({ ok: false, source: 'malformed', importedSurfaces: Object.freeze([]),
      excludedSurfaces: Object.freeze([]), importPolicy: 'none', reason: 'import policy or excluded surfaces are invalid', file });
  }

  // Drop anything that is not a well-formed surface slug rather than comparing
  // against it. A value that cannot be a surface cannot grant consent to one.
  const accepted = [];
  const rejected = [];
  for (const entry of declared) {
    if (typeof entry === 'string' && SURFACE_RE.test(entry)) accepted.push(entry);
    else rejected.push(entry);
  }

  return Object.freeze({
    ok: true,
    source: accepted.length === 0 ? 'empty' : 'file',
    importedSurfaces: Object.freeze([...new Set(accepted)]),
    excludedSurfaces: Object.freeze([...new Set(excluded)].filter(surface => !accepted.includes(surface))),
    importPolicy,
    rejectedEntries: Object.freeze(rejected),
    reason: accepted.length === 0
      ? 'import choices exist but list no surfaces'
      : 'import choices read from config',
    file
  });
}

/**
 * Split discovered sessions into the ones the user imported and the ones merely
 * offered. Pure: takes sessions and a consent record, touches no disk.
 *
 * Returns counts alongside the lists on purpose. A caller that wants to say "you
 * have N sessions" is forced to have `discoveredTotal` in hand, so it cannot
 * render an unimported machine as a machine with nothing on it.
 */
function consentKeyFor(session) {
  const surface = session && typeof session.surface === 'string' && SURFACE_RE.test(session.surface)
    ? session.surface
    : null;
  if (surface !== null) return surface;
  // A session whose surface the observer could not determine still has to be
  // OFFERABLE. Leaving it keyless would make it permanently unimportable: never
  // adopted, but also never presentable as a choice, so it would vanish from the
  // product with no way for anyone to opt in. That is the same defect as
  // auto-adoption wearing the opposite mask -- invisible instead of invasive, and
  // it was found by wiring this gate into the projection rather than by reading it.
  //
  // So group it under a synthetic per-provider key. It stays fail-closed (an
  // explicit choice is still required) while remaining something a person can
  // actually choose.
  const provider = session && typeof session.provider === 'string' && SURFACE_RE.test(session.provider)
    ? session.provider
    : 'unknown';
  return `${provider}.unidentified`;
}

function partitionObservedSessions(sessions, consent) {
  // A non-array does not establish that discovery found no sessions. Treating a
  // missing, failed, or malformed observation as [] would manufacture a
  // confident discoveredTotal of zero and let callers report "nothing found"
  // even though discovery was never measured.
  if (!Array.isArray(sessions)) {
    throw new TypeError('sessions must be an array produced by a successful discovery');
  }
  const list = sessions;
  const importedSurfaces = new Set(
    consent && Array.isArray(consent.importedSurfaces) ? consent.importedSurfaces : []
  );
  const excludedSurfaces = new Set(consent?.excludedSurfaces || []);
  const importPolicy = IMPORT_POLICIES.includes(consent?.importPolicy) ? consent.importPolicy : 'ask';

  const imported = [];
  const available = [];
  const keyCounts = new Map();

  for (const session of list) {
    const key = consentKeyFor(session);
    const synthetic = key.endsWith('.unidentified');
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    const explicit = importedSurfaces.has(key);
    const isImported = explicit || (consent?.ok === true && importPolicy === 'all-detected' && !excludedSurfaces.has(key));
    const decorated = Object.freeze({
      ...session,
      consentKey: key,
      consentState: isImported ? 'imported' : 'not-imported',
      consentReason: isImported
        ? (explicit ? `${key} was imported by the user` : `${key} is included by the saved automatic import policy`)
        : (synthetic
          ? `this session reports no identifiable surface; it is offered as ${key} and has not been imported`
          : `surface ${key} has not been imported`)
    });
    if (isImported) imported.push(decorated);
    else available.push(decorated);
  }

  // Every consent key present on the machine, each marked with whether it is
  // imported. This is the list a settings screen renders as choices: it must
  // include the ones the user has NOT chosen, or there is nothing to choose from.
  const offeredSurfaces = [...keyCounts.keys()].sort().map(surface => Object.freeze({
    surface,
    imported: importedSurfaces.has(surface) || (consent?.ok === true && importPolicy === 'all-detected' && !excludedSurfaces.has(surface)),
    synthetic: surface.endsWith('.unidentified'),
    sessionCount: keyCounts.get(surface)
  }));

  // Consent naming a surface that is not present is not an error: the editor may
  // simply not be running. Surfacing it prevents a settings screen from silently
  // forgetting a choice the user made.
  const importedButNotPresent = [...importedSurfaces]
    .filter(surface => !keyCounts.has(surface))
    .sort();

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    discoveredTotal: list.length,
    importedCount: imported.length,
    availableCount: available.length,
    consentSource: consent && typeof consent.source === 'string' ? consent.source : 'absent',
    consentOk: Boolean(consent && consent.ok),
    importPolicy,
    offeringEnabled: importPolicy !== 'none',
    imported: Object.freeze(imported),
    available: Object.freeze(available),
    offeredSurfaces: Object.freeze(offeredSurfaces),
    importedButNotPresent: Object.freeze(importedButNotPresent)
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  CONSENT_RELATIVE_PATH,
  CONSENT_STATES,
  CONSENT_SOURCES,
  IMPORT_POLICIES,
  SURFACE_RE,
  consentFilePath,
  loadSessionConsent,
  partitionObservedSessions
});
