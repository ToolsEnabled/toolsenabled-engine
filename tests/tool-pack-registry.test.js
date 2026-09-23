/*
 * Mutation: changed `if (!producedNames.has(name))` to `if (false && !producedNames.has(name))`.
 * Landed: yes; the mutated guard was present in src/lib/tool-pack-registry.js.
 * Result: red; this file exited 1 because the expected exception was not thrown.
 */
'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const registry = require('../src/lib/tool-pack-registry');

afterEach(() => registry.resetForTests());

test('registerToolPack exposes names and consumeToolPacks returns pack output', () => {
  const definition = Object.freeze({ name: 'calendar.read' });
  const seenApis = [];
  const api = {
    define: (...args) => ({ name: args[0] }),
    marker: 'registry-api'
  };

  registry.registerToolPack({
    name: 'calendar-tools',
    definitions(receivedApi) {
      seenApis.push(receivedApi);
      return [definition];
    },
    p13SemanticOverrides: {
      'calendar.read': { policyKind: 'local-read' }
    }
  });

  assert.deepEqual(registry.registeredPackNames(), ['calendar-tools']);
  assert.deepEqual(registry.consumeToolPacks(api), {
    definitions: [definition],
    p13SemanticOverrides: {
      'calendar.read': { policyKind: 'local-read' }
    },
    names: ['calendar-tools']
  });
  assert.deepEqual(seenApis, [api]);
});

test('registration snapshots semantic overrides instead of retaining caller mutations', () => {
  const overrides = { 'notes.read': { policyKind: 'local-read' } };
  registry.registerToolPack({
    name: 'notes-tools',
    definitions: () => [{ name: 'notes.read' }],
    p13SemanticOverrides: overrides
  });
  overrides['notes.write'] = { policyKind: 'local-write' };

  const consumed = registry.consumeToolPacks({ define() {} });
  assert.deepEqual(consumed.p13SemanticOverrides, {
    'notes.read': { policyKind: 'local-read' }
  });
});

test('a pack cannot declare semantics for a tool it did not define', () => {
  registry.registerToolPack({
    name: 'safe-pack',
    definitions: () => [{ name: 'safe.read' }],
    p13SemanticOverrides: { 'core.secret': { policyKind: 'tool-dispatch' } }
  });

  assert.throws(
    () => registry.consumeToolPacks({ define() {} }),
    /declares P13 semantics for 'core\.secret'.*only carry semantics for its own tools/
  );
});

test('new packs are rejected after consumption but a consumed pack may be registered again', () => {
  const firstPack = { name: 'first-pack', definitions: () => [] };
  registry.registerToolPack(firstPack);
  registry.consumeToolPacks({ define() {} });

  assert.throws(
    () => registry.registerToolPack({ name: 'late-pack', definitions: () => [] }),
    /registered after src\/lib\/tool-registry\.js was already built/
  );
  assert.doesNotThrow(() => registry.registerToolPack(firstPack));
  assert.deepEqual(registry.registeredPackNames(), ['first-pack']);
});

test('invalid inputs fail with diagnostics and resetForTests restores the empty state', () => {
  assert.throws(() => registry.registerToolPack(null), /must be an object/);
  assert.throws(
    () => registry.registerToolPack({ name: 'Not Valid', definitions: () => [] }),
    /lowercase-dashed name/
  );
  assert.throws(
    () => registry.registerToolPack({ name: 'missing-definitions' }),
    /must expose definitions/
  );
  assert.throws(() => registry.consumeToolPacks({}), /including define\(\)/);

  registry.registerToolPack({ name: 'temporary-pack', definitions: () => [] });
  registry.resetForTests();
  assert.deepEqual(registry.registeredPackNames(), []);
  assert.deepEqual(registry.consumeToolPacks({ define() {} }), {
    definitions: [], p13SemanticOverrides: {}, names: []
  });
});
