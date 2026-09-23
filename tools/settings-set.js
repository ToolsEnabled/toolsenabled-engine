#!/usr/bin/env node
'use strict';

// settings-set.js -- the only write path this product has for a user setting.
//
// Owner, 2026-08-13: "make sure users can change the setting though in the app"
// and "anything thats a user setting has to be changeable in the software".
//
// WHY THIS FILE EXISTS AT ALL. src/lib/settings.js exports loadSettings and
// resolveValuesPath and nothing else -- there is no writer anywhere in the
// repo, and tests/settings.test.js pins that export list, so the writer must
// NOT be added to that module. Until this file, the settings document at
// %LOCALAPPDATA%\ToolsEnabled\settings.json could only be produced by hand, and
// a hand-edit almost always omits the provenance block, which loadSettings
// rejects (src/lib/settings.js:165-169) -- so the value is silently discarded
// and the person believes they changed something. This writes the provenance
// with the value, atomically, and then READS IT BACK through loadSettings so
// the exit code reflects what the product will actually see.
//
// THIS IS A HUMAN CHANNEL, MECHANICALLY (R1192: agents must not write
// settings). --source user refuses unless stdin AND stdout are both TTYs. An
// agent's Bash/PowerShell tool call is a pipe, not a TTY, so this is a
// mechanism rather than an instruction. --source installer requires
// TOOLSENABLED_INSTALLER=1 in the environment.
//
// This file deliberately adds NO MCP tool and NO bridge route.
// tests/settings-surface-readonly.test.js locks both of those shut on purpose;
// a CLI a person runs is not the remote-writable surface that test forbids.
//
// DISCOVERY IS PART OF "CHANGEABLE IN THE SOFTWARE". A write path a person
// cannot find is not a write path. --get and the set form both require you to
// already know an exact dotted id, and there are 58 of them; nothing in the
// product printed that list. --list prints every row this product has, its
// current value, where that value came from, and -- the part that matters --
// whether anything in the shipped code actually reads it. loadSettings() already
// computes that last column (its `enforcement` map exists precisely so a surface
// can say "nothing enforces this" instead of drawing a control that changes
// nothing); until now no surface printed it.
//
// Usage:
//   node tools/settings-set.js --list [text]
//   node tools/settings-set.js --get <id>
//   node tools/settings-set.js --reset <id> [--source user|installer]
//   node tools/settings-set.js <id> <value> [--directive R####] [--source user|installer]

const fs = require('node:fs');
const path = require('node:path');

const { loadRegistry } = require('../src/lib/settings-registry');
const { loadSettings, resolveValuesPath } = require('../src/lib/settings');
const { normalizeSettingChange, settingChangesWithCompatibility, TOOL_MODE_SETTING_ID } = require('../src/lib/agent-api-mode');

// WHICH READBACK ROWS ARE READ-ONLY, AND IN WHOSE WORDS.
//
// `readOnlyReason` is a settings-registry field: src/lib/settings-registry.js
// lists it in FIELDS and validates it (readback controls only, never blank),
// and the shipped catalogue carries one on capability.tier and one on
// capability.workspace_roots. Nothing read its VALUE. This file instead kept a
// second, hand-maintained copy of the same fact -- a literal set of those two
// ids -- and refused with "read-only; change it through the named authority
// instead", a sentence that never names the authority, so a person who read it
// still did not know what to change. The catalogue already held the sentence
// that does ("... To change it, run ToolsEnabled setup again yourself; ..."),
// and they never saw it.
//
// The declaration is the rule now: a row that declares a reason is read-only
// here and IS THAT REASON when refused; a readback that declares none stays
// writable, which model.endpoint and model.name need because
// src/lib/providers/customer-model.js reads them out of settings.json.
//
// NOTHING IS LOOSENED BY DROPPING THE LOCAL LIST. The two machine-boundary rows
// are pinned to carry a non-blank readOnlyReason by
// tests/capability-settings-honest.test.js, and src/lib/settings.js resolves
// both from machine.json and rejects any stored value for them -- so a value
// that somehow got past this coercion would still fail the round-trip check at
// the end of main() and exit non-zero.
function readOnlyDeclaration(entry) {
  const reason = entry ? entry.readOnlyReason : undefined;
  return typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null;
}

const USAGE = [
  'usage:',
  '  node tools/settings-set.js --list [text]                 every setting, its value, and whether anything reads it',
  '  node tools/settings-set.js --get <id>                    one setting in full',
  '  node tools/settings-set.js --reset <id> [--source user|installer]  restore its default',
  '  node tools/settings-set.js <id> <value> [--directive R####] [--source user|installer]',
  '',
  'run --list first; the set form needs an exact id and the ids are not guessable.'
].join('\n');

// Section names are quoted from the design of record, docs/design/SETTINGS-SURFACE.md
// sections 3.3-3.8, so this list and the settings page name the same things.
const SECTION_NAMES = {
  A: 'Sending things out',
  B: 'Questions and approvals',
  C: 'How much agents decide alone',
  D: 'Your rules',
  E: 'Agents working together',
  F: 'Access and capability'
};

class UsageError extends Error {}

function argumentValue(argv, name) {
  const exactIndex = argv.indexOf(name);
  if (exactIndex !== -1) {
    const next = argv[exactIndex + 1];
    if (typeof next !== 'string' || next.startsWith('--')) throw new UsageError(`${name} requires a value`);
    return next;
  }
  const prefix = `${name}=`;
  const joined = argv.find(value => typeof value === 'string' && value.startsWith(prefix));
  return joined ? joined.slice(prefix.length) : null;
}

function positionals(argv) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (typeof value !== 'string') continue;
    if (value.startsWith('--')) {
      if (!value.includes('=') && ['--directive', '--source', '--get', '--reset'].includes(value)) index += 1;
      continue;
    }
    out.push(value);
  }
  return out;
}

// Coercion mirrors validationFailure() in src/lib/settings.js exactly. If these
// two ever disagree, the loser is the person: the value writes and then gets
// rejected on load. So the round-trip check at the end of main() is not
// belt-and-braces, it is the actual guarantee.
function coerce(entry, text) {
  if (entry.id === 'agent.agent_api' && entry.control === 'seg' && ['true', 'false'].includes(text)) {
    text = text === 'true' ? 'Only' : 'Enabled';
  }
  const localReason = require('../src/lib/local-model-options').invalidSettingValue(entry.id,
    ['number', 'duration'].includes(entry.control) ? Number(text) : text);
  if (localReason) return { ok: false, allowed: localReason };
  switch (entry.control) {
    case 'toggle':
      if (text === 'true') return { ok: true, value: true };
      if (text === 'false') return { ok: true, value: false };
      return { ok: false, allowed: 'true | false' };
    case 'seg':
    case 'select': {
      const options = Array.isArray(entry.options) ? entry.options : [];
      if (options.includes(text)) return { ok: true, value: text };
      return { ok: false, allowed: options.map(option => JSON.stringify(option)).join(' | ') || '(this entry declares no options)' };
    }
    case 'number':
    case 'duration': {
      const parsed = Number(text);
      if (text.trim() !== '' && Number.isFinite(parsed)) return { ok: true, value: parsed };
      return { ok: false, allowed: `a finite ${entry.control} number` };
    }
    case 'list': {
      let parsed;
      try { parsed = JSON.parse(text); } catch { return { ok: false, allowed: 'a JSON array, e.g. ["a","b"]' }; }
      if (Array.isArray(parsed)) return { ok: true, value: parsed };
      return { ok: false, allowed: 'a JSON array, e.g. ["a","b"]' };
    }
    case 'readback': {
      const readOnly = readOnlyDeclaration(entry);
      return readOnly ? { ok: false, allowed: readOnly } : { ok: true, value: text };
    }
    // Chosen from a list discovered at run time, so there is nothing declared
    // here to check the text against - only whether a choice was made at all.
    // It is a case of its own rather than a fold into `readback` because this
    // one is written BY the person, and a class the window writes should not be
    // named for reading.
    case 'pick':
      if (text === '' && ['model.local_agent_name', 'model.tool_name'].includes(entry.id)) return { ok: true, value: '' };
      if (text.trim() !== '') return { ok: true, value: text };
      return { ok: false, allowed: 'the name of a model the endpoint is serving' };
    // Typed by the person. Nothing here checks that the address is reachable:
    // that is the caller's job and it already refuses an address it cannot use,
    // with its own sentence. Storing what was typed is what lets them correct
    // a typo instead of being told their service is down.
    case 'text':
      if (text.trim() !== '') return { ok: true, value: text };
      return { ok: false, allowed: 'a value typed by you, which this row cannot be left empty for' };
    default:
      return { ok: false, allowed: `control "${entry.control}" is not writable by this tool` };
  }
}

function readDocument(valuesPath) {
  let raw;
  try {
    raw = fs.readFileSync(valuesPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { revision: 0, values: {}, provenance: {} };
    throw new Error(`the settings file "${valuesPath}" exists but could not be read: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    // Fail closed: never clobber a settings file we could not understand. A
    // person can move it aside deliberately; this tool will not do it for them.
    throw new Error(`the settings file "${valuesPath}" is not valid JSON; refusing to overwrite it. Move it aside if you want a fresh one.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`the settings file "${valuesPath}" is not a JSON object; refusing to overwrite it.`);
  }
  if (!Number.isFinite(parsed.revision)) {
    throw new Error(`the settings file "${valuesPath}" has a missing or invalid revision; refusing to overwrite it.`);
  }
  if (!parsed.values || typeof parsed.values !== 'object' || Array.isArray(parsed.values)) {
    throw new Error(`the settings file "${valuesPath}" has missing or invalid values; refusing to overwrite it.`);
  }
  if (!parsed.provenance || typeof parsed.provenance !== 'object' || Array.isArray(parsed.provenance)) {
    throw new Error(`the settings file "${valuesPath}" has missing or invalid provenance; refusing to overwrite it.`);
  }
  return {
    revision: parsed.revision,
    values: parsed.values,
    provenance: parsed.provenance
  };
}

function writeDocumentAtomically(valuesPath, document) {
  fs.mkdirSync(path.dirname(valuesPath), { recursive: true });
  const temporary = `${valuesPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, valuesPath);
}

function describe(resolved, id) {
  const provenance = resolved.provenance[id] || {};
  const enforcement = resolved.enforcement[id] || {};
  const readback = resolved.readbacks && resolved.readbacks[id];
  const location = readback && readback.readOnly
    ? `${readback.authorityPath || 'the named authority'} (read-only, ${readback.status}${readback.reason ? `: ${readback.reason}` : ''})`
    : `${resolved.valuesPath} (revision ${resolved.revision})`;
  const lines = [
    `${id} = ${JSON.stringify(resolved.values[id])}`,
    `  source     ${provenance.source || 'default'}${provenance.directive ? ` (directive ${provenance.directive})` : ''}`,
    `  file       ${location}`,
    `  enforcedBy ${enforcement.declared ? enforcement.enforcedBy : 'nothing enforces this setting'}`
  ];
  const rejected = resolved.rejected.filter(item => item.id === id || item.id === '*');
  for (const item of rejected) lines.push(`  REJECTED   ${item.reason}`);
  return lines.join('\n');
}

// One row per setting. The `enforced` column is the honest one and it is
// deliberately asymmetric, for the reason src/lib/settings.js:116-120 gives: an
// empty enforcedBy is a CERTAINTY that nothing is wired, while a non-empty one is
// only the catalogue's claim. So a false prints the flat statement, and a true
// prints the claimed file rather than the word "enforced".
function listRows(registry, resolved, filter, streams) {
  const needle = String(filter || '').toLowerCase();
  const titles = registry.titles || {};
  const visible = registry.entries.filter(entry => entry.id !== TOOL_MODE_SETTING_ID);
  const matches = visible.filter(entry => !needle
    || entry.id.toLowerCase().includes(needle)
    || String(titles[entry.id] || '').toLowerCase().includes(needle));

  if (matches.length === 0) {
    streams.stdout.write(`no setting matches "${filter}". Run --list with no text to see all ${visible.length}.\n`);
    return 0;
  }

  const idWidth = Math.max(...matches.map(entry => entry.id.length));
  const lines = [];
  let unenforced = 0;
  let chosen = 0;
  let section = null;

  for (const entry of matches) {
    if (entry.section !== section) {
      section = entry.section;
      lines.push('');
      lines.push(`${section} - ${SECTION_NAMES[section] || 'unnamed section'}`);
    }
    const enforcement = resolved.enforcement[entry.id] || {};
    if (!enforcement.declared) unenforced += 1;
    const provenance = resolved.provenance[entry.id] || {};
    const source = provenance.source || 'default';
    if (source !== 'default') chosen += 1;
    lines.push([
      `  d${entry.depth}`,
      entry.id.padEnd(idWidth),
      entry.control.padEnd(8),
      `= ${JSON.stringify(resolved.values[entry.id])}`,
      source === 'default' ? '(default)' : `(${source})`,
      // "claims" and not "enforced by": the catalogue is asserting a file, and
      // four of these assertions name a file that never mentions the id. --get
      // prints the claim in full; this column only has to be honest about what
      // kind of statement it is.
      enforcement.declared
        ? `claims ${enforcement.enforcedBy.length > 58 ? `${enforcement.enforcedBy.slice(0, 58)}...` : enforcement.enforcedBy}`
        : 'NOTHING READS THIS SETTING'
    ].join('  '));
    const title = titles[entry.id];
    if (title) lines.push(`  ${' '.repeat(2)}${title}`);
    if (Array.isArray(entry.options) && entry.options.length) {
      lines.push(`    choices: ${entry.options.map(option => JSON.stringify(option)).join(' | ')}`);
    } else if (entry.control === 'toggle') {
      lines.push('    choices: true | false');
    }
  }

  lines.push('');
  lines.push(`${matches.length} of ${visible.length} settings shown - ${chosen} changed from the default, ${unenforced} declare no enforcer.`);
  lines.push(`values file: ${resolved.valuesPath} (revision ${resolved.revision})`);
  lines.push('change one writable row:  node tools/settings-set.js <id> <value>  (interactive terminal only)');
  lines.push('see one:     node tools/settings-set.js --get <id>');
  lines.push('restore its default: node tools/settings-set.js --reset <id> (interactive terminal only)');
  for (const item of resolved.rejected) lines.push(`REJECTED ${item.id}: ${item.reason}`);

  streams.stdout.write(`${lines.join('\n').replace(/^\n/, '')}\n`);
  return 0;
}

function assertHumanChannel(source, env, streams) {
  if (source === 'installer') {
    if (env.TOOLSENABLED_INSTALLER !== '1') {
      throw new UsageError('--source installer requires TOOLSENABLED_INSTALLER=1 in the environment');
    }
    return;
  }
  if (!(streams.stdin.isTTY && streams.stdout.isTTY)) {
    throw new UsageError('settings are changed by a person, not by an agent: run this in an interactive terminal, or use the app');
  }
}

function main(argv = process.argv.slice(2), env = process.env, streams = process) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    streams.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const registry = loadRegistry();

  if (argv.includes('--list')) {
    // --list takes an OPTIONAL filter, so it must not go through argumentValue,
    // which treats a missing value as a usage error.
    return listRows(registry, loadSettings({ registry, env }), positionals(argv)[0] || '', streams);
  }

  const getId = argumentValue(argv, '--get');
  if (getId) {
    if (!registry.byId.has(getId)) {
      streams.stderr.write(`unknown setting "${getId}"\n`);
      return 1;
    }
    streams.stdout.write(`${describe(loadSettings({ registry, env }), getId)}\n`);
    return 0;
  }

  const resetId = argumentValue(argv, '--reset');
  const rest = positionals(argv);
  if (rest.length !== (resetId ? 0 : 2)) {
    streams.stderr.write(`${USAGE}\n`);
    return 1;
  }
  let [id, text] = resetId ? [resetId, null] : rest;

  const entry = registry.byId.get(id);
  if (!entry) {
    streams.stderr.write(`unknown setting "${id}"\n`);
    return 1;
  }

  const readOnly = readOnlyDeclaration(entry);
  const coerced = resetId
    ? { ok: !readOnly, value: entry.default, allowed: readOnly }
    : coerce(entry, text);
  if (!coerced.ok) {
    // A READ-ONLY ROW'S REFUSAL DOES NOT REPEAT WHAT WAS TYPED. model.api_key
    // declares that the key is kept in the vault and never written into
    // settings; quoting it back into stderr writes it into whatever captured
    // the run -- an install log, a terminal scrollback, a transcript. The row's
    // own sentence already says what to do and needs no example of the value.
    streams.stderr.write(readOnlyDeclaration(entry)
      ? `${id} cannot be set here. ${coerced.allowed}\n`
      : `"${text}" is not a valid value for ${id} (control: ${entry.control}). Allowed: ${coerced.allowed}\n`);
    return 1;
  }

  const source = argumentValue(argv, '--source') || 'user';
  if (source !== 'user' && source !== 'installer') {
    streams.stderr.write('--source must be "user" or "installer"\n');
    return 1;
  }
  const directive = argumentValue(argv, '--directive');

  assertHumanChannel(source, env, streams);
  const normalized = normalizeSettingChange(id, coerced.value);
  id = normalized.id;
  coerced.value = normalized.value;

  // resolveValuesPath is the exported one on purpose: re-deriving the path here
  // would be a second copy that can drift from the reader's.
  const valuesPath = resolveValuesPath({ env });
  const document = readDocument(valuesPath);
  if (resetId) {
    // Remove both canonical and compatibility overrides so a stale alias cannot
    // resurrect a choice when restoring the declared default.
    for (const change of settingChangesWithCompatibility(id, coerced.value)) {
      if (!registry.byId.has(change.id)) continue;
      delete document.values[change.id];
      delete document.provenance[change.id];
    }
  } else {
    const provenance = { source, atMs: Date.now(), directive: directive || null };
    for (const change of settingChangesWithCompatibility(id, coerced.value)) {
      if (!registry.byId.has(change.id)) continue;
      document.values[change.id] = change.value;
      document.provenance[change.id] = { ...provenance };
    }
  }
  document.revision += 1;
  writeDocumentAtomically(valuesPath, document);

  const resolved = loadSettings({ registry, env });
  streams.stdout.write(`${describe(resolved, id)}\n`);
  const survived = JSON.stringify(resolved.values[id]) === JSON.stringify(coerced.value)
    && resolved.provenance[id] && resolved.provenance[id].source === (resetId ? 'default' : source);
  if (!survived) {
    streams.stderr.write(`the value did not survive the round trip: ${id} reads back as ${JSON.stringify(resolved.values[id])}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${(error && error.message) || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, coerce, readDocument, describe, listRows, SECTION_NAMES, USAGE };
