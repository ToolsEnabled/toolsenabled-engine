'use strict';

// The Settings page for a person working in a terminal inside an OpenShell
// sandbox. The engine only reads settings; on the desktop the app writes them.
// This writes the same document the app writes ({ revision, values,
// provenance } at settings.resolveValuesPath()), validated by the engine's own
// registry and validator, with the person as the source.
//
// Inside one sandbox this is a product rule, not a boundary: agents could run
// the same command. The person is told so.

const fs = require('node:fs');
const path = require('node:path');

const NOT_A_BOUNDARY = 'Inside one sandbox, agents could run this command too; it records you as the source but cannot prove it was you.';
const LOCK_WAIT_MS = 5000;

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

function registry() {
  return require('./settings-registry').loadRegistry();
}

/** Command-line text to a setting value: JSON when it parses (true, 3, ["a"]), else the text itself. */
function parseValue(text) {
  if (typeof text !== 'string') throw refuse('SETTINGS_PAGE_VALUE_REQUIRED', 'Give a value.');
  try { return JSON.parse(text); } catch { return text; }
}

function list({ ids = null } = {}, { load = () => require('./settings').loadSettings(), reg = registry() } = {}) {
  const loaded = load();
  const wanted = ids ? new Set(ids) : null;
  return reg.entries
    .filter((entry) => !wanted || wanted.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      title: reg.titles[entry.id] || entry.id,
      value: Object.hasOwn(loaded.values || {}, entry.id) ? loaded.values[entry.id] : entry.default,
      source: (loaded.provenance && loaded.provenance[entry.id] && loaded.provenance[entry.id].source) || 'default',
      options: entry.options || null,
      readOnly: entry.control === 'readback'
    }));
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(file, mutate) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle;
  for (;;) {
    try { handle = fs.openSync(lock, 'wx', 0o600); break; } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() > deadline) throw refuse('SETTINGS_PAGE_BUSY', 'The settings file is busy; try again.');
      sleepMs(20);
    }
  }
  try { return mutate(); } finally { fs.closeSync(handle); fs.rmSync(lock, { force: true }); }
}

function readDocument(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { revision: 0, values: {}, provenance: {} };
    throw refuse('SETTINGS_PAGE_UNREADABLE', `The settings file could not be read: ${error.message}`);
  }
  const document = JSON.parse(raw);
  if (!document || typeof document.values !== 'object' || !Number.isFinite(document.revision)) {
    throw refuse('SETTINGS_PAGE_UNREADABLE', 'The settings file has an invalid structure; nothing was changed.');
  }
  return { ...document, provenance: document.provenance || {} };
}

/** Set several settings at once, all or nothing. `changes` is [[id, value], ...]. */
function set(changes, { reg = registry(), file = require('./settings').resolveValuesPath(), now = Date.now() } = {}) {
  const { validateSettingValue } = require('./settings-values');
  for (const [id, value] of changes) {
    const entry = reg.byId.get(id);
    if (!entry) throw refuse('SETTINGS_PAGE_UNKNOWN', `There is no setting "${id}".`);
    if (entry.control === 'readback') throw refuse('SETTINGS_PAGE_READ_ONLY', `"${id}" is read-only here.`);
    const reason = validateSettingValue(entry, value);
    if (reason) throw refuse('SETTINGS_PAGE_INVALID', reason);
  }
  if (process.env.TOOLSENABLED_FLEET_LOCK_FD !== undefined) require('./openshell-lifecycle-lock').markMutation();
  return withLock(file, () => {
    const document = readDocument(file);
    for (const [id, value] of changes) {
      document.values[id] = value;
      document.provenance[id] = { source: 'user', atMs: now, directive: null };
    }
    document.revision += 1;
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return { revision: document.revision, changed: changes.map(([id]) => id) };
  });
}

function format(rows) {
  return [
    'ToolsEnabled Fleet — Settings',
    '',
    ...rows.map((row) => `${row.id} = ${JSON.stringify(row.value)}${row.source === 'default' ? '' : `  (${row.source})`}${row.readOnly ? '  read-only' : ''}${row.options ? `  [${row.options.join(' | ')}]` : ''}`),
    '',
    NOT_A_BOUNDARY
  ];
}

module.exports = Object.freeze({ list, set, parseValue, format, NOT_A_BOUNDARY });
