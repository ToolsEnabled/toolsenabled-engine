/*
 * Mutation check: in src/lib/dependency-graph.js, replaced the
 * isLocalSpecifier return expression with `return false;`.
 * The edit landed: yes. This isolated test went red: yes (exit 1).
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const graph = require('../src/lib/dependency-graph');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-graph-'));

function write(relativeFile, contents) {
  const file = path.join(scratch, relativeFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

try {
  const entry = write('app.js', [
    "require('./shared')",
    "require('node:fs')",
    "// require('./commented-out')",
    "function onDemand() { require('./lazy') }",
    'function plugin(name) { require(name) }'
  ].join('\n'));
  const secondEntry = write('worker.js', "require('./shared.js')\n");
  const shared = write('shared.js', "require('./nested/data.json')\n");
  const lazy = write('lazy/index.js', 'module.exports = true;\n');
  const data = write('nested/data.json', '{"ready":true}\n');

  assert.equal(graph.isLocalSpecifier('./shared'), true);
  assert.equal(graph.isLocalSpecifier('node:fs'), false);
  assert.equal(graph.resolveLocal(entry, './shared'), shared);
  assert.equal(graph.resolveLocal(entry, './lazy'), lazy);

  const requirements = graph.readRequires(entry);
  assert.deepEqual(requirements.specifiers, ['./shared', 'node:fs', './lazy']);
  assert.deepEqual(requirements.eager, ['./shared', 'node:fs']);
  assert.deepEqual(requirements.lazy, ['./lazy']);
  assert.equal(requirements.dynamicCount, 1);

  const completeWalk = graph.walk(entry);
  assert.deepEqual(new Set(completeWalk.visited), new Set([entry, shared, lazy, data]));
  assert.deepEqual(completeWalk.unresolved, []);
  assert.deepEqual(completeWalk.dynamic, [{ file: entry, count: 1 }]);

  const eagerWalk = graph.walk(entry, { eagerOnly: true });
  assert.deepEqual(new Set(eagerWalk.visited), new Set([entry, shared, data]));

  const built = graph.buildGraph([
    { id: 'app', entryPoint: 'app.js' },
    { id: 'worker', entryPoint: 'worker.js' },
    { id: 'missing', entryPoint: 'missing.js' }
  ], { root: scratch });
  assert.deepEqual(graph.subsystemsAffectedBy('shared.js', built), ['app', 'worker']);
  assert.deepEqual(graph.blastRadiusObject(built), {
    'nested/data.json': ['app', 'worker'],
    'shared.js': ['app', 'worker']
  });
  assert.equal(built.subsystems.missing.present, false);
  assert.deepEqual(built.problems, [{
    subsystem: 'missing',
    from: null,
    specifier: 'missing.js',
    reason: 'entry point does not exist'
  }]);

  console.log('dependency-graph behaviour tests passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
