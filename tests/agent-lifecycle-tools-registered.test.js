'use strict';
/* THE FOUR TREE VERBS ARE TOOLS, NOT ONLY A HANDLER.
 *
 * MEASURED 2026-09-04 on live-engine 38ee062: `listTools()` answered 216 names
 * and not one of them began with `agent.`. treeLifecycle() and spawnSubagent()
 * were still defined, the P13 semantic table and the context-aware handler
 * list still named all four verbs, confined-tool-surface still classed them
 * "contained" -- and no assistant could call any of them, because the JARVIS
 * extraction (fe64032) swept the `define('agent.spawn'|'agent.stop'|
 * 'agent.restart'|'agent.remove', ...)` entries out with the jarvis.* block
 * they sat between. A manager on the tree could not spawn, stop, restart or
 * remove a circle under it; every call was an unknown tool.
 *
 * Every other place that names the verbs is a TABLE, and a table stays green
 * when the thing it describes is gone. This suite asks the registry itself.
 *
 *   node tests/agent-lifecycle-tools-registered.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('../src/lib/tool-registry');

const TREE_VERBS = Object.freeze(['agent.spawn', 'agent.stop', 'agent.restart', 'agent.remove']);
const REGISTRY_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'tool-registry.js'), 'utf8');

test('agent.spawn, agent.stop, agent.restart and agent.remove are registered tools', () => {
  const names = new Set(registry.listTools().map(tool => tool.name));
  for (const name of TREE_VERBS) {
    assert.ok(names.has(name), `${name} is not a registered tool`);
  }
});

test('each lifecycle verb names the circle it acts on and is wired to the application errand, not a stub', () => {
  for (const [verb, word] of [['agent.stop', 'stop'], ['agent.restart', 'restart'], ['agent.remove', 'remove']]) {
    const entry = registry.getTool(verb);
    assert.ok(entry, `${verb} is not registered`);
    assert.deepEqual(entry.inputSchema.required, ['nodeId'], `${verb} must require exactly nodeId`);
    assert.ok(entry.inputSchema.properties.treeId, `${verb} must accept an optional treeId`);
    assert.ok(entry.inputSchema.properties.expectedSessionId, `${verb} must accept an optional expectedSessionId`);
    assert.equal(entry.annotations.destructiveHint, true, `${verb} ends or replaces a conversation and must say so`);
    /* The registry hands out descriptors without handlers, and executeTool()
       walks the audit and vault before any handler, so the handler binding is
       pinned in the definition itself: the verb's define() must hand the
       errand to treeLifecycle() with the same word. */
    const definition = REGISTRY_SOURCE.slice(REGISTRY_SOURCE.indexOf(`define('${verb}'`));
    const handlerAt = definition.indexOf(`treeLifecycle('${word}', args, context)`);
    const nextDefineAt = definition.indexOf("define('", 1);
    assert.ok(handlerAt > 0 && (nextDefineAt < 0 || handlerAt < nextDefineAt), `${verb} does not route to treeLifecycle('${word}')`);
  }
});

test('agent.spawn is the contract-validated spawn, reachable by name', () => {
  const entry = registry.getTool('agent.spawn');
  assert.ok(entry, 'agent.spawn is not registered');
  assert.deepEqual(entry.inputSchema.required, ['contract', 'tier']);
  assert.ok(entry.inputSchema.properties.surface, 'agent.spawn must offer the tree surface');
  const definition = REGISTRY_SOURCE.slice(REGISTRY_SOURCE.indexOf("define('agent.spawn'"));
  const handlerAt = definition.indexOf('spawnSubagent(args, context)');
  const nextDefineAt = definition.indexOf("define('", 1);
  assert.ok(handlerAt > 0 && handlerAt < nextDefineAt, 'agent.spawn does not route to spawnSubagent()');
});

test('the tables that already named the four verbs describe registered tools, not ghosts', () => {
  /* The P13 semantic overrides and the context-aware handler list both named
     these tools while the registry did not carry them -- which is the shape
     of the defect: everything that DESCRIBES the verb stayed green. */
  const names = new Set(registry.listTools().map(tool => tool.name));
  const semantic = REGISTRY_SOURCE.slice(REGISTRY_SOURCE.indexOf('const P13_SEMANTIC_OVERRIDES'));
  for (const name of TREE_VERBS) {
    assert.match(semantic.slice(0, semantic.indexOf('});')), new RegExp(`'${name.replace('.', '\\.')}'`));
    assert.ok(names.has(name), `${name} is described by the semantic table and not registered`);
  }
});
