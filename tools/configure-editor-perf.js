#!/usr/bin/env node
'use strict';

// BUILD-QUEUE Q116.5 -- the editor watcher/index fix as PRODUCT BEHAVIOUR,
// not a repo artifact.
//
// THE PROBLEM THIS EXISTS TO KILL. On 2026-08-10 the owner's machine was
// crawling: two VS Code extension-host processes at 24.0% and 17.2% CPU (45.3%
// of the whole machine's load), because the editor had no .vscode/settings.json
// and was watching/indexing logs/ (7,340 files), state/ (7,340), .git/ (1,612),
// .shots/ (393). A committed .vscode/settings.json fixes that -- but ONLY for
// the exact checkout that has that commit checked out. This repo alone has 118
// registered git worktrees and 189 ToolsEnabled-*/wt-* directory copies on disk;
// a customer is exactly as likely to be looking at one of those, or at a fresh
// clone from a branch that predates the fix, as at the one tree that happens to
// carry the commit. The fix already shipped once and did nothing for a day
// because the owner's editor was open on the OTHER tree. A performance fix that
// is not present where the work actually happens is not a fix. This module
// makes the SAME settings a product behaviour that runs wherever ToolsEnabled
// is installed, independent of which commit that checkout happens to have.
//
// CONTRACT (owner, Q116.5):
//   - clearly disclosed, never silent -- every run prints exactly what it is
//     about to add/added, to which file, and how to undo it.
//   - idempotent -- a key already present (ours or the user's own) is never
//     re-added or re-touched; running this twice in a row changes nothing the
//     second time.
//   - non-destructive -- an existing key's VALUE is never overwritten, no
//     matter what it holds. Only missing keys (top-level, or missing entries
//     one level inside an existing object-valued key) are added.
//   - reversible -- `--undo` removes exactly the keys this tool itself added,
//     and only if they still hold the value this tool set (if the user has
//     since customized something we added, undo leaves it alone and says so).
//
// SAFETY VALVE. .vscode/settings.json is a real hand-edited file on customer
// machines and VS Code's own format allows JSONC comments and trailing commas.
// Blindly parsing and re-serializing a commented file would silently delete
// the user's comments -- itself a "silently rewrote your editor config"
// violation. So: a file that round-trips through strict JSON.parse (which
// covers every case this repo itself ever produces, and the common case of a
// customer's plain-JSON settings file) is merged in place. A file that does
// NOT parse as strict JSON (comments, trailing commas, anything hand-tuned
// enough to need them) is left completely untouched and reported, never
// guessed at. Doing nothing safely beats a clever textual splice that is
// wrong once.

const fs = require('node:fs');
const path = require('node:path');

const RELATIVE_TARGET = path.join('.vscode', 'settings.json');
const MARKER_RELATIVE = path.join('.vscode', '.toolsenabled-editor-perf.json');
const MARKER_VERSION = 1;

// Keep in sync with the committed .vscode/settings.json at the repo root --
// that file is this same set of keys, written once, by hand, for this one
// checkout. This is the same set, applied programmatically to whichever
// checkout the installer actually runs in.
const DEFAULT_SETTINGS = Object.freeze({
  'files.watcherExclude': Object.freeze({
    '**/.git/objects/**': true,
    '**/.git/subtree-cache/**': true,
    '**/node_modules/**': true,
    '**/logs/**': true,
    '**/state/**': true,
    '**/.shots/**': true,
    '**/scratch/**': true,
    '**/profiles/**': true,
    '**/artifacts/**': true,
    '**/.worktrees/**': true,
    '**/vault/**': true,
    '**/schemas/generated/**': true,
    '**/__pycache__/**': true,
    '**/*.log': true,
    '**/*.jsonl': true
  }),
  'search.exclude': Object.freeze({
    '**/node_modules': true,
    '**/logs': true,
    '**/state': true,
    '**/.shots': true,
    '**/scratch': true,
    '**/profiles': true,
    '**/artifacts': true,
    '**/.worktrees': true,
    '**/vault': true,
    '**/schemas/generated': true,
    '**/__pycache__': true,
    '**/*.log': true,
    '**/*.jsonl': true
  }),
  'search.followSymlinks': false,
  'search.useIgnoreFiles': true,
  'typescript.tsserver.watchOptions': Object.freeze({
    watchFile: 'useFsEventsOnParentDirectory',
    watchDirectory: 'useFsEvents'
  }),
  'typescript.disableAutomaticTypeAcquisition': true,
  'javascript.suggest.autoImports': false,
  'typescript.suggest.autoImports': false,
  'git.autorefresh': false,
  'git.autofetch': false,
  'git.decorations.enabled': false,
  'git.ignoreLimitWarning': true,
  'scm.diffDecorations': 'none',
  // Deliberately empty: this tool narrows the WATCHER and SEARCH INDEX only.
  // Hiding entries from the Explorer would change what the user sees, which
  // is a styling/behaviour decision that is never this tool's to make.
  'files.exclude': Object.freeze({})
});

const DISCLOSURE_HEADER = [
  'EDITOR PERFORMANCE ONLY. Nothing here changes styling, formatting, theming,',
  'or any visible layout -- these keys only stop the editor from WATCHING and',
  'SEARCHING files that no human edits (logs, state, vault, node_modules, git',
  'internals, and disposable worktree copies). Added by',
  'tools/configure-editor-perf.js (BUILD-QUEUE Q116.5). Undo with:',
  '  node tools/configure-editor-perf.js --undo',
  'Skip this on a future install with: install.ps1 -SkipEditorPerfConfig'
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

/** Read a target file's raw text, or null if it does not exist / is empty. */
function readExisting(targetPath) {
  let raw;
  try { raw = fs.readFileSync(targetPath, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  return raw.trim() === '' ? null : raw;
}

/**
 * Parse strictly. Returns { ok: true, value } or { ok: false }. Never throws;
 * a file this cannot parse strictly is reported and left alone, never guessed
 * at (see the module header's safety-valve note).
 */
function parseStrict(raw) {
  try {
    const value = JSON.parse(raw);
    return { ok: true, value };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * Compute what would change without touching disk. Pure function so it is
 * directly testable.
 *
 * status:
 *   'create'        -- no existing file (or empty file); write fresh.
 *   'merge'         -- existing file is strict JSON; safe to merge in place.
 *   'already-applied' -- existing file is strict JSON and already has every
 *                        default key/entry; nothing to do.
 *   'unparseable'   -- existing file is not strict JSON (comments, trailing
 *                      commas, or invalid). Left untouched.
 *   'not-an-object' -- existing file is valid strict JSON but not an object
 *                      (e.g. an array). Left untouched.
 */
function planApply(raw) {
  if (raw === null) {
    return { status: 'create', addTopLevel: { ...DEFAULT_SETTINGS }, addNested: {} };
  }
  const parsed = parseStrict(raw);
  if (!parsed.ok) return { status: 'unparseable' };
  if (!isPlainObject(parsed.value)) return { status: 'not-an-object' };

  const existing = parsed.value;
  const addTopLevel = {};
  const addNested = {};
  for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
    if (!Object.prototype.hasOwnProperty.call(existing, key)) {
      addTopLevel[key] = defaultValue;
      continue;
    }
    const currentValue = existing[key];
    if (isPlainObject(currentValue) && isPlainObject(defaultValue)) {
      const missing = {};
      for (const [subKey, subValue] of Object.entries(defaultValue)) {
        if (!Object.prototype.hasOwnProperty.call(currentValue, subKey)) missing[subKey] = subValue;
      }
      if (Object.keys(missing).length > 0) addNested[key] = missing;
    }
    // Any other existing key (right type but complete, or a different type
    // entirely such as a scalar/array where we expected an object) is the
    // user's own and is never touched.
  }
  const changed = Object.keys(addTopLevel).length > 0 || Object.keys(addNested).length > 0;
  return { status: changed ? 'merge' : 'already-applied', existing, addTopLevel, addNested };
}

function buildMergedValue(existing, addTopLevel, addNested) {
  const merged = { ...(existing || {}), ...addTopLevel };
  for (const [key, missing] of Object.entries(addNested)) {
    merged[key] = { ...merged[key], ...missing };
  }
  return merged;
}

function serialize(valueObject, { withDisclosure }) {
  const body = withDisclosure ? { '//': DISCLOSURE_HEADER, ...valueObject } : valueObject;
  return `${JSON.stringify(body, null, 2)}\n`;
}

function readMarker(markerPath) {
  let raw;
  try {
    raw = fs.readFileSync(markerPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    throw new Error(`Cannot safely use invalid editor-performance marker ${markerPath}`, { cause: error });
  }
  if (!isPlainObject(parsed)
      || parsed.version !== MARKER_VERSION
      || !isPlainObject(parsed.addedTopLevelKeys)
      || !isPlainObject(parsed.addedNestedEntries)
      || typeof parsed.createdFile !== 'boolean') {
    throw new Error(`Cannot safely use malformed or unsupported editor-performance marker ${markerPath}`);
  }
  return parsed;
}

function unlinkIfExists(filePath) {
  try { fs.unlinkSync(filePath); }
  catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function mergeMarker(previous, addTopLevel, addNested, { createdFile }) {
  const marker = previous && Number.isInteger(previous.version)
    ? previous
    : { version: MARKER_VERSION, addedTopLevelKeys: {}, addedNestedEntries: {}, createdFile: false };
  for (const [key, value] of Object.entries(addTopLevel)) marker.addedTopLevelKeys[key] = value;
  for (const [key, subEntries] of Object.entries(addNested)) {
    marker.addedNestedEntries[key] = { ...(marker.addedNestedEntries[key] || {}), ...subEntries };
  }
  // Sticky true: once this tool has created the file from nothing, that stays
  // true across later merge runs on the same target (there is nothing "more
  // created" than everything).
  marker.createdFile = Boolean(marker.createdFile) || Boolean(createdFile);
  marker.updatedAtIso = new Date().toISOString();
  return marker;
}

/**
 * Apply the plan to disk. Returns a report object; never throws for the
 * "nothing safe to do" statuses -- only genuine I/O failures propagate.
 */
function apply(targetDir, { log = () => {} } = {}) {
  const targetPath = path.join(targetDir, RELATIVE_TARGET);
  const markerPath = path.join(targetDir, MARKER_RELATIVE);
  const raw = readExisting(targetPath);
  const plan = planApply(raw);
  // Establish that any existing ownership record is usable before changing
  // settings. A corrupt or unreadable marker must not be treated as absent.
  const previousMarker = readMarker(markerPath);

  if (plan.status === 'unparseable') {
    log(`SKIPPED: ${RELATIVE_TARGET} exists but is not strict JSON (comments or trailing commas). `
      + 'Left completely untouched -- see docs for the same keys to add by hand if desired.');
    return { ...plan, changed: false };
  }
  if (plan.status === 'not-an-object') {
    log(`SKIPPED: ${RELATIVE_TARGET} exists but its top level is not a JSON object. Left untouched.`);
    return { ...plan, changed: false };
  }
  if (plan.status === 'already-applied') {
    log(`OK: ${RELATIVE_TARGET} already has every editor-performance key this tool would add. Nothing to do.`);
    return { ...plan, changed: false };
  }

  const merged = plan.status === 'create'
    ? { ...DEFAULT_SETTINGS }
    : buildMergedValue(plan.existing, plan.addTopLevel, plan.addNested);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, serialize(merged, { withDisclosure: plan.status === 'create' }), 'utf8');

  const marker = mergeMarker(previousMarker, plan.addTopLevel, plan.addNested, { createdFile: plan.status === 'create' });
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

  const addedTopKeys = Object.keys(plan.addTopLevel);
  const addedNestedSummary = Object.entries(plan.addNested)
    .map(([key, subEntries]) => `${key} (+${Object.keys(subEntries).length} entr${Object.keys(subEntries).length === 1 ? 'y' : 'ies'})`);
  log(`${plan.status === 'create' ? 'CREATED' : 'MERGED'}: ${RELATIVE_TARGET}`);
  log('  Disclosure: watcher/search excludes only (see module header); no styling, no hidden files, no behaviour change.');
  if (addedTopKeys.length > 0) log(`  Added top-level keys: ${addedTopKeys.join(', ')}`);
  if (addedNestedSummary.length > 0) log(`  Filled in missing entries on: ${addedNestedSummary.join(', ')}`);
  log(`  Undo: node tools/configure-editor-perf.js --undo${targetDir === process.cwd() ? '' : ` --path "${targetDir}"`}`);

  return { ...plan, changed: true, targetPath, markerPath };
}

/**
 * Reverse exactly what this tool has ever recorded adding to this target,
 * and ONLY where the current value still deep-equals what was set (a value
 * the user has since edited is left alone, and reported as such).
 */
function undo(targetDir, { log = () => {} } = {}) {
  const targetPath = path.join(targetDir, RELATIVE_TARGET);
  const markerPath = path.join(targetDir, MARKER_RELATIVE);
  const marker = readMarker(markerPath);
  if (!marker) {
    log(`NOTHING TO UNDO: no ${MARKER_RELATIVE} marker found for this directory (this tool never applied here, `
      + 'or the marker was already removed).');
    return { changed: false };
  }

  const raw = readExisting(targetPath);
  const parsed = raw === null ? { ok: true, value: {} } : parseStrict(raw);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    log(`SKIPPED: ${RELATIVE_TARGET} is not strict-JSON-parseable right now, so undo cannot safely edit it. `
      + 'The marker is left in place; remove the keys listed there by hand if desired.');
    return { changed: false };
  }

  const current = { ...parsed.value };
  const removedTop = [];
  const keptTop = [];
  // The disclosure "//" key is only ever written on a fresh create (see
  // serialize()) and is not part of DEFAULT_SETTINGS, so it is not in
  // addedTopLevelKeys; it gets the exact same "only if unchanged" treatment
  // as everything else this tool added.
  if (marker.createdFile === true && Object.prototype.hasOwnProperty.call(current, '//')
      && deepEqual(current['//'], DISCLOSURE_HEADER)) {
    delete current['//'];
    removedTop.push('//');
  } else if (marker.createdFile === true && Object.prototype.hasOwnProperty.call(current, '//')) {
    keptTop.push('//');
  }
  for (const [key, valueWeSet] of Object.entries(marker.addedTopLevelKeys || {})) {
    if (Object.prototype.hasOwnProperty.call(current, key) && deepEqual(current[key], valueWeSet)) {
      delete current[key];
      removedTop.push(key);
    } else if (Object.prototype.hasOwnProperty.call(current, key)) {
      keptTop.push(key);
    }
  }
  const removedNested = [];
  const keptNested = [];
  for (const [key, subEntriesWeSet] of Object.entries(marker.addedNestedEntries || {})) {
    if (!isPlainObject(current[key])) continue;
    for (const [subKey, subValueWeSet] of Object.entries(subEntriesWeSet)) {
      if (Object.prototype.hasOwnProperty.call(current[key], subKey) && deepEqual(current[key][subKey], subValueWeSet)) {
        delete current[key][subKey];
        removedNested.push(`${key}.${subKey}`);
      } else if (Object.prototype.hasOwnProperty.call(current[key], subKey)) {
        keptNested.push(`${key}.${subKey}`);
      }
    }
  }

  // This tool created the file from nothing and nothing else has since been
  // added to it: fully reverse that, including the file itself, rather than
  // leaving a bare "{}" where no file existed before. Anything short of
  // "truly empty" means the user (or something else) added content since, so
  // the file stays and only the keys we own are gone.
  const fullyReversedCreation = marker.createdFile === true && Object.keys(current).length === 0;
  if (fullyReversedCreation) {
    unlinkIfExists(targetPath);
    try {
      const dir = path.dirname(targetPath);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch (error) {
      // A concurrent writer making the directory non-empty needs no cleanup;
      // unreadable directories and other failures must remain failures.
      if (!error || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  } else {
    fs.writeFileSync(targetPath, serialize(current, { withDisclosure: false }), 'utf8');
  }
  unlinkIfExists(markerPath);

  log(fullyReversedCreation ? `UNDONE: ${RELATIVE_TARGET} removed (this tool had created it from nothing)` : `UNDONE: ${RELATIVE_TARGET}`);
  if (removedTop.length > 0) log(`  Removed top-level keys: ${removedTop.join(', ')}`);
  if (removedNested.length > 0) log(`  Removed entries: ${removedNested.join(', ')}`);
  if (keptTop.length > 0 || keptNested.length > 0) {
    log(`  Left alone (value changed since this tool set it): ${[...keptTop, ...keptNested].join(', ')}`);
  }
  if (removedTop.length === 0 && removedNested.length === 0) log('  Nothing matched the recorded values; no changes made.');

  return { changed: removedTop.length > 0 || removedNested.length > 0, removedTop, removedNested, keptTop, keptNested };
}

function main(argv) {
  const undoRequested = argv.includes('--undo');
  const pathIndex = argv.indexOf('--path');
  const targetDir = pathIndex >= 0 && argv[pathIndex + 1] ? path.resolve(argv[pathIndex + 1]) : process.cwd();
  const log = line => process.stdout.write(`${line}\n`);

  log(`ToolsEnabled editor performance config (Q116.5) -- target: ${path.join(targetDir, RELATIVE_TARGET)}`);
  const result = undoRequested ? undo(targetDir, { log }) : apply(targetDir, { log });
  process.exitCode = 0;
  return result;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  DEFAULT_SETTINGS, DISCLOSURE_HEADER, RELATIVE_TARGET, MARKER_RELATIVE,
  planApply, apply, undo, buildMergedValue, deepEqual, isPlainObject, main
};
