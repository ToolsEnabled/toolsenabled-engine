#!/usr/bin/env node
'use strict';

/* THE TOOL SURFACE AS A SHEET AN AGENT CAN PARSE, NOT PROSE IT HAS TO READ.
 *
 * WHY THIS EXISTS. Onboarding an agent by EXPLAINING mechanisms costs thousands
 * of tokens per dispatch and is read unreliably; handing it SYNTAX costs a
 * fraction and is read exactly. Measured on this registry: all 266 tools render
 * as 16,292 characters -- roughly 4,000 tokens for the product's entire
 * capability surface, about what three prose task briefs cost. A sheet scoped to
 * the two or three namespaces a task actually needs is a few hundred.
 *
 * THE SHEET IS DERIVED, NEVER AUTHORED. Every line comes from
 * registeredTools() at run time. Nothing here embeds a tool name, so the sheet
 * cannot drift from the registry the way a hand-written list does -- a hand
 * list is stale the moment somebody adds a tool, and this project has already
 * paid for one capability index that had to REFUSE to build until its
 * vocabulary matched the live catalogue.
 *
 * WHAT A LINE MEANS:
 *
 *     name(arg,arg*,arg?)  effect  !
 *     |    |                |      |
 *     |    |                |      `- destructive: it can lose or send something
 *     |    |                `- local-read | local-write | external-read | external-write
 *     |    `- * required, ? optional, bare = optional
 *     `- call it exactly like this
 *
 * The effect word is the one that decides how careful to be, and it is the
 * registry's own classification rather than a guess from the name: `local-read`
 * is safe to call to find out what is true; `external-write` leaves this
 * machine and may cost money or be seen by somebody.
 *
 * WHAT THIS DOES NOT DO. It does not say whether a tool will SUCCEED. A tool can
 * be present, correct, and still refuse -- because the permission tier excludes
 * it, because a precondition is absent, or because the caller stated no
 * permission session. Those refusals are named and are answers, not failures.
 * An agent handed this sheet still has to read what comes back.
 */

function loadRegistry() {
  /* A STATIC require, not path.join(__dirname, ...). Both resolve to the same
     file, but the pack-time walk that builds the payload cannot follow a
     computed one and refuses the whole layer rather than ship a closure it
     could not verify -- so the ceremony cost the payload this module. */
  const registry = require('../src/lib/tool-registry.js');
  if (typeof registry.registeredTools !== 'function') {
    throw new Error('tool-registry exposes no registeredTools(); the sheet cannot be derived and will not be guessed');
  }
  const tools = registry.registeredTools({});
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('registeredTools() returned no tool catalogue; an empty sheet will not be treated as complete');
  }
  return tools;
}

/* Required-ness comes from the schema's own `required` list where there is one.
 * A schema with no `required` array is not "everything optional" -- it is a
 * schema that did not say, so the marker is omitted rather than invented. */
function renderArgs(tool) {
  const schema = tool.inputSchema || tool.input_schema || null;
  const properties = (schema && schema.properties) || {};
  const names = Object.keys(properties);
  if (!names.length) return '';
  const required = Array.isArray(schema && schema.required) ? new Set(schema.required) : null;
  return names
    .map((name) => {
      if (!required) return name;
      return required.has(name) ? `${name}*` : `${name}?`;
    })
    .join(',');
}

function renderTool(tool) {
  const destructive = tool.annotations && tool.annotations.destructiveHint === true ? ' !' : '';
  const effect = tool.effect || tool.annotations?.effect || '?';
  return `${tool.name}(${renderArgs(tool)}) ${effect}${destructive}`;
}

function namespaceOf(tool) {
  const dot = String(tool.name).indexOf('.');
  return dot === -1 ? String(tool.name) : String(tool.name).slice(0, dot);
}

function parseArguments(argv) {
  const options = { namespaces: [], list: false, effects: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--list') { options.list = true; continue; }
    if (argument === '--ns') {
      const value = argv[index + 1];
      if (!value) throw new Error('--ns needs a comma-separated namespace list');
      options.namespaces = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (!options.namespaces.length) throw new Error('--ns needs at least one non-empty namespace');
      index += 1;
      continue;
    }
    if (argument === '--effect') {
      const value = argv[index + 1];
      if (!value) throw new Error('--effect needs a comma-separated effect list');
      options.effects = new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
      if (!options.effects.size) throw new Error('--effect needs at least one non-empty effect');
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`REFUSED: ${error.message}`);
    console.error('usage: node tools/agent-api-sheet.js [--ns a,b] [--effect local-read,...] [--list]');
    return 2;
  }

  let tools;
  try {
    tools = loadRegistry();
  } catch (error) {
    console.error(`REFUSED: the live registry could not be read, so no sheet was produced: ${error.message}`);
    return 2;
  }

  const byNamespace = new Map();
  for (const tool of tools) {
    const key = namespaceOf(tool);
    if (!byNamespace.has(key)) byNamespace.set(key, []);
    byNamespace.get(key).push(tool);
  }

  if (options.list) {
    for (const key of [...byNamespace.keys()].sort()) {
      console.log(`${key} (${byNamespace.get(key).length})`);
    }
    return 0;
  }

  /* A namespace asked for and absent is REFUSED BY NAME rather than silently
     omitted. Silently returning a shorter sheet would hand an agent a surface it
     believes is complete, which is the failure this file exists to avoid. */
  const unknown = options.namespaces.filter((name) => !byNamespace.has(name));
  if (unknown.length) {
    console.error(`REFUSED: no such namespace: ${unknown.join(', ')}`);
    console.error(`known: ${[...byNamespace.keys()].sort().join(', ')}`);
    return 2;
  }

  const selected = options.namespaces.length ? options.namespaces : [...byNamespace.keys()].sort();
  const lines = [];
  let shown = 0;
  for (const key of selected) {
    const group = byNamespace.get(key)
      .filter((tool) => !options.effects
        || options.effects.has(tool.effect || tool.annotations?.effect || '?'));
    if (!group.length) continue;
    for (const tool of group) { lines.push(renderTool(tool)); shown += 1; }
  }

  if (shown === 0) {
    console.error('REFUSED: the requested filters matched zero tools; an empty sheet will not be treated as complete');
    return 2;
  }

  console.log('# name(arg*=required, arg?=optional)  effect  ! = destructive');
  console.log(lines.join('\n'));
  console.log(`# ${shown} of ${tools.length} tools`
    + (options.namespaces.length ? ` in ${selected.join(',')}` : '')
    + (options.effects ? ` with effect ${[...options.effects].join(',')}` : '')
    + '. A refusal that names itself is an answer, not a failure.');
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { renderTool, renderArgs, namespaceOf, main };
