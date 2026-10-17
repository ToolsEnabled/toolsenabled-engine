'use strict';
const fs = require('node:fs');
const view = require('./fleet-read-view');

function displayValue(value) {
  const credential = require('./secret-patterns').plaintextCredentialOutsideGeneratedIds;
  const unsafe = (item, depth = 0) => {
    if (depth > 8) return true;
    if (typeof item === 'string') {
      if (credential(item)) return true;
      try {
        const url = new URL(item);
        if (['http:', 'https:'].includes(url.protocol) && (url.username || url.password || url.search || url.hash)) return true;
      } catch { /* ordinary text */ }
      return false;
    }
    if (Array.isArray(item)) return item.some(child => unsafe(child, depth + 1));
    if (item && typeof item === 'object') return Object.entries(item).some(([key, child]) =>
      /(?:secret|token|password|credential|api.?key)/i.test(key) || unsafe(child, depth + 1));
    return false;
  };
  return unsafe(value) ? { text: '[redacted credential-shaped value]', truncated: false, redacted: true }
    : { ...view.bounded(JSON.stringify(value), 8192), redacted: false };
}

function loadReadOnlySettings() {
  const settings = require('./settings');
  const valuesPath = settings.resolveValuesPath();
  view.assertDirectPath(valuesPath);
  let stat;
  try { stat = fs.lstatSync(valuesPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 2 * 1024 * 1024))
    throw view.fail('FLEET_SETTINGS_STORE_INVALID', 'The settings file is not a bounded direct regular file.');
  const record = require('./setup/machine-record');
  const readOnlyRecord = { ...record,
    readMachineRecord: options => record.readMachineRecord({ ...options, adopt: false }) };
  const loaded = settings.loadSettings({ machineRecord: readOnlyRecord, valuesPath });
  if (loaded.rejected.some(item => item.id === '*'))
    throw view.fail('FLEET_SETTINGS_STORE_INVALID', 'The settings file could not be read or parsed.');
  return loaded;
}

function machineView(options = {}) {
  view.validatePage(options);
  const { offset = 0, limit = 50, revision, id = null } = options;
  const reg = require('./settings-registry').loadRegistry();
  if (id !== null && !reg.byId.has(id)) throw view.fail('FLEET_SETTING_UNKNOWN', `There is no setting ${view.safe(id, 100)}.`);
  const loaded = loadReadOnlySettings();
  const all = reg.entries.map(entry => {
    const value = displayValue(loaded.values[entry.id]);
    const provenance = loaded.provenance[entry.id] || { source: 'default', atMs: 0, directive: null };
    return { id: view.safe(entry.id, 100), title: view.safe(reg.titles[entry.id] || entry.id, 240),
      valueText: value.text, valueTruncated: value.truncated, valueRedacted: value.redacted,
      provenance: { source: view.safe(provenance.source, 80), atMs: Number.isSafeInteger(provenance.atMs) && provenance.atMs >= 0 ? provenance.atMs : 0,
        directive: provenance.directive ? '[withheld from pane]' : null,
        migratedFrom: provenance.migratedFrom ? view.safe(provenance.migratedFrom, 100) : null },
      readOnly: Boolean(loaded.readbacks[entry.id] || entry.control === 'readback'),
      enforcementDeclared: loaded.enforcement[entry.id]?.declared === true };
  });
  const rejected = loaded.rejected.slice(0, 20).map(item => ({
    id: /^[a-z0-9_.-]{1,100}$/i.test(item.id) ? item.id : '[invalid id]',
    reason: /[\\/]|(?:secret|token|password|credential|api.?key)|=|:class=/i.test(String(item.reason))
      ? '[withheld from pane]' : view.safe(item.reason, 500)
  }));
  const snapshot = view.digest([loaded.revision, all, rejected, loaded.rejected.length]);
  view.assertRevision(revision, snapshot);
  const filtered = id ? all.filter(row => row.id === id) : all;
  const records = filtered.slice(offset, offset + limit);
  return { schema: 'ai.toolsenabled/fleet-settings/v1', revision: snapshot, settingsRevision: loaded.revision,
    records, total: filtered.length, offset, limit,
    nextOffset: offset + records.length < filtered.length ? offset + records.length : null,
    rejected, rejectedTruncated: loaded.rejected.length > rejected.length,
    grantsAuthority: false };
}
function format(page) {
  return ['ToolsEnabled Fleet — Settings', '',
    ...page.records.map(row => `${row.id} = ${row.valueText}${row.valueTruncated ? ' [truncated]' : ''}  (${row.provenance.source})${row.readOnly ? '  read-only' : ''}`),
    '', `${page.total} setting(s)${page.nextOffset === null ? '' : '; more available with --json --offset'}`];
}
module.exports = Object.freeze({ machineView, format, displayValue, loadReadOnlySettings });
