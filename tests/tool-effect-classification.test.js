'use strict';

// AE-F6 (R1162 security council, Stage 0 item 7, three seats P0): omitted
// effect classification used to default to 'local-read' -- the
// least-restrictive class -- inside src/lib/tool-registry.js's `define()`.
// A future tool registered without saying what it does would silently
// inherit the safest-looking label and escape every outward-effect guard,
// approval-eligibility default, and MCP annotation (readOnlyHint /
// destructiveHint / openWorldHint) that `effect` drives, exactly the shape
// of gap the AUTH-F-01 incident this fix is meant to forestall came from.
//
// This file pins two things directly:
//   1. `defineTool()` (the exported `define()` constructor) now REFUSES an
//      omitted or invalid `effect` -- there is no fallback -- instead of
//      silently classifying to 'local-read'.
//   2. Every entry in the intentional post-provider-removal TOOL_REGISTRY
//      baseline declares an
//      explicit, valid effect (this module already can't load otherwise;
//      the assertion here gives that fact a readable failure message
//      instead of a raw constructor stack trace from deep inside a require
//      chain the next person to touch this file did not expect).
//
// Run: node tests/tool-effect-classification.test.js   (from PowerShell)

const isolated = require('./lib/isolated-environment').activate('tool-effect-classification');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const coreContract = require('./fixtures/tool-core-identities.json');
const toolPacks = require('../src/lib/tool-pack-registry');
const registryPath = require.resolve('../src/lib/tool-registry');
assert.deepEqual(toolPacks.registeredPackNames(), [], 'this test must measure the actual empty-pack core composition');
assert.equal(require.cache[registryPath], undefined, 'a previously composed registry must not supply this test baseline');
const { defineTool, EFFECTS, TOOL_REGISTRY, validateRegistry } = require('../src/lib/tool-registry');

// The historical floor included optional packs and predates the named Jarvis
// retirement. Pin actual core identities instead of rewarding unrelated tools.
const requiredCoreNames = [
  ...coreContract.historicalCoreNames.filter(name => !coreContract.retiredCoreNames.includes(name)),
  ...coreContract.addedCoreNames
].sort();

function assertCoreIdentities(entries, { exact = true } = {}) {
  const actual = entries.map(entry => entry.name).sort();
  const missing = requiredCoreNames.filter(name => !actual.includes(name));
  assert.deepEqual(missing, [], `required core identities missing: ${missing.join(', ')}`);
  if (exact) assert.deepEqual(actual, requiredCoreNames, 'empty-pack core membership requires explicit identity reconciliation');
}
const { assertShippedToolInventory } = require('./lib/shipped-tool-inventory');

void isolated;

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

const noopSchema = { type: 'object', properties: {}, additionalProperties: false };
const noopHandler = () => ({ ok: true });

// --- the enum itself -----------------------------------------------------

check('EFFECTS is exactly the four-member closed set the rest of this file assumes', () => {
  assert.deepEqual([...EFFECTS].sort(), ['external-read', 'external-write', 'local-read', 'local-write']);
});

// --- defineTool() REFUSES a missing/invalid effect, with no fallback -----

check('defineTool REFUSES a call with no options object at all', () => {
  assert.throws(
    () => defineTool('test.no_options', 'desc', noopSchema, noopHandler),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /must declare an explicit effect/);
      assert.match(error.message, /AE-F6/);
      assert.match(error.message, /test\.no_options/);
      return true;
    }
  );
});

check('defineTool REFUSES an options object that omits effect', () => {
  assert.throws(
    () => defineTool('test.omitted_effect', 'desc', noopSchema, noopHandler, { provider: null }),
    (error) => error instanceof TypeError && /must declare an explicit effect/.test(error.message)
  );
});

check('defineTool REFUSES effect: undefined explicitly', () => {
  assert.throws(
    () => defineTool('test.undefined_effect', 'desc', noopSchema, noopHandler, { effect: undefined }),
    (error) => error instanceof TypeError && /must declare an explicit effect/.test(error.message)
  );
});

check('defineTool REFUSES an empty-string effect (falsy, but must not silently pass)', () => {
  assert.throws(
    () => defineTool('test.empty_effect', 'desc', noopSchema, noopHandler, { effect: '' }),
    (error) => error instanceof TypeError && /must declare an explicit effect/.test(error.message)
  );
});

check('defineTool REFUSES a plausible-looking but unrecognized effect string (typo/legacy value)', () => {
  for (const bogus of ['read', 'write', 'local', 'external', 'LOCAL-READ', 'local-read ', 'no-effect']) {
    assert.throws(
      () => defineTool('test.bogus_effect', 'desc', noopSchema, noopHandler, { effect: bogus }),
      (error) => error instanceof TypeError && /must declare an explicit effect/.test(error.message),
      `expected defineTool to refuse effect ${JSON.stringify(bogus)}`
    );
  }
});

check('the refusal message names every valid effect, so a developer sees the fix inline', () => {
  assert.throws(
    () => defineTool('test.helpful_message', 'desc', noopSchema, noopHandler, {}),
    (error) => {
      for (const effect of EFFECTS) assert.match(error.message, new RegExp(effect.replace('-', '\\-')));
      return true;
    }
  );
});

// --- defineTool() ACCEPTS every real effect class, unchanged behavior ----

for (const effect of EFFECTS) {
  check(`defineTool accepts an explicit effect: '${effect}' and preserves it on the entry`, () => {
    const entry = defineTool(`test.${effect.replace('-', '_')}_ok`, 'desc', noopSchema, noopHandler, { effect });
    assert.equal(entry.effect, effect);
    assert.ok(Object.isFrozen(entry), 'a defined tool entry must remain frozen, same as before this fix');
  });
}

check('defineTool derived annotations from an explicit effect are unchanged from before this fix', () => {
  const entry = defineTool('test.annotation_derivation', 'desc', noopSchema, noopHandler, { effect: 'external-write' });
  assert.equal(entry.annotations.destructiveHint, true);
  assert.equal(entry.annotations.readOnlyHint, false);
  assert.equal(entry.annotations.openWorldHint, true);
});

// --- a hand-built registry array reproduces the real fail-closed failure mode ---

check('building a TOOL_REGISTRY-shaped array with one entry missing effect throws before any entry is usable', () => {
  assert.throws(() => Object.freeze([
    defineTool('test.array_ok', 'desc', noopSchema, noopHandler, { effect: 'local-read' }),
    defineTool('test.array_missing_effect', 'desc', noopSchema, noopHandler, { provider: null })
  ]), (error) => error instanceof TypeError && /test\.array_missing_effect/.test(error.message));
});

check('the equivalent array with every entry declaring effect builds without throwing', () => {
  // Deliberately does NOT run this toy array through validateRegistry():
  // that function also cross-checks config/toolsenabled.policy.json's real
  // standingAuthorizations against the passed-in registry, and those grants
  // name real production tools (e.g. gcloud.services_enable) that a toy
  // array never contains -- an unrelated, expected failure this test must
  // not conflate with AE-F6's effect-classification guard.
  let registry;
  assert.doesNotThrow(() => {
    registry = Object.freeze([
      defineTool('test.array_ok_a', 'desc', noopSchema, noopHandler, { effect: 'local-read' }),
      defineTool('test.array_ok_b', 'desc', noopSchema, noopHandler, { effect: 'external-write', destructiveHint: false })
    ]);
  });
  assert.deepEqual(registry.map((entry) => entry.effect), ['local-read', 'external-write']);
});

// --- the real, shipped registry: every retained tool is explicit ----------

check('the reviewed historical identity snapshot and explicit membership changes remain consistent', () => {
  assert.equal(coreContract.schemaVersion, 1);
  assert.equal(createHash('sha256').update(JSON.stringify(coreContract.historicalCoreNames)).digest('hex'),
    'de763c78b364c87a038df2e568775dafc70cb8d376cfe81dd74e4e7844c006c8');
  for (const list of [coreContract.historicalCoreNames, coreContract.retiredCoreNames, coreContract.addedCoreNames, requiredCoreNames]) {
    assert.deepEqual(list, [...new Set(list)].sort(), 'identity lists must be unique and sorted');
  }
  assert.ok(coreContract.retiredCoreNames.every(name => name.startsWith('jarvis.') && coreContract.historicalCoreNames.includes(name)),
    'only named retired Jarvis identities are removed from the historical core');
  assert.ok(coreContract.addedCoreNames.every(name => !coreContract.historicalCoreNames.includes(name)),
    'added identities must actually be new');
});

check('the actual empty-pack core retains every required identity, with no unexplained membership changes', () => {
  assertCoreIdentities(TOOL_REGISTRY);
});

// These already shipped desktop additions belong to the empty-pack core.
// Review their identities and effects explicitly; do not rebuild the baseline
// from whatever happens to be registered or change the historical snapshot.
const desktopCoreEffects = Object.freeze({
  'accessibility.inspect': 'local-read',
  'accessibility.propose': 'local-write',
  'accessibility.status': 'local-read',
  'app.context': 'local-read',
  'app.navigate': 'local-write'
});
check('desktop context and accessibility tools retain their reviewed effect and annotation boundaries', () => {
  for (const [name, effect] of Object.entries(desktopCoreEffects)) {
    assert.ok(coreContract.addedCoreNames.includes(name), `${name} must remain an explicit core addition`);
    const entry = TOOL_REGISTRY.find(tool => tool.name === name);
    assert.equal(entry?.effect, effect, `${name} must keep its reviewed effect`);
    assert.equal(entry.annotations.readOnlyHint, effect === 'local-read', `${name} read-only annotation`);
    assert.equal(entry.annotations.openWorldHint, false, `${name} remains a local effect`);
  }
});
check('each desktop core identity is required even when an unrelated tool preserves the count', () => {
  for (const name of Object.keys(desktopCoreEffects)) {
    const substituted = TOOL_REGISTRY.map(entry => entry.name === name ? { ...entry, name: 'boundary.unreviewed_tool' } : entry);
    assert.throws(() => assertCoreIdentities(substituted),
      error => error.code === 'ERR_ASSERTION' && error.message.includes(`required core identities missing: ${name}`));
  }
});
const reviewedSlotAndRecallEffects = Object.freeze({
  'capability.find': 'local-read',
  'agent.set_account': 'local-write', 'agent.set_effort': 'local-write',
  'agent.set_model': 'local-write', 'agent.set_provider': 'local-write', 'agent.set_role': 'local-write'
});
check('session recall and opt-in slot controls retain exact public membership and effects', () => {
  for (const [name, effect] of Object.entries(reviewedSlotAndRecallEffects)) {
    assert.ok(coreContract.addedCoreNames.includes(name), name + ' requires an explicit identity addition');
    assert.equal(TOOL_REGISTRY.find(entry => entry.name === name)?.effect, effect);
    for (const changed of [
      TOOL_REGISTRY.filter(entry => entry.name !== name),
      TOOL_REGISTRY.map(entry => entry.name === name ? { ...entry, name: 'boundary.unreviewed_tool' } : entry)
    ]) {
      assert.throws(() => assertCoreIdentities(changed),
        error => error.code === 'ERR_ASSERTION' && error.message.includes('required core identities missing: ' + name));
      assert.throws(() => assertShippedToolInventory(changed.map(entry => entry.name)), { code: 'ERR_ASSERTION' });
    }
  }
});
check('an extra empty-pack identity requires review even when every known core tool is present', () => {
  assert.throws(() => assertCoreIdentities([...TOOL_REGISTRY, { name: 'boundary.unreviewed_tool' }]),
    error => error.code === 'ERR_ASSERTION' && /empty-pack core membership/.test(error.message));
});

check('every real TOOL_REGISTRY entry declares an explicit, valid effect (AE-F6 fix coverage)', () => {
  assertShippedToolInventory(TOOL_REGISTRY.map(entry => entry.name));
  const withoutValidEffect = TOOL_REGISTRY.filter((entry) => !EFFECTS.includes(entry.effect));
  assert.deepEqual(
    withoutValidEffect.map((entry) => entry.name),
    [],
    'every shipped tool must declare one of the EFFECTS values; AE-F6 forbids a silent default'
  );
});

check('reviewed app and accessibility identities retain their explicit read/write boundaries', () => {
  const expected = {
    'accessibility.inspect': 'local-read',
    'accessibility.propose': 'local-write',
    'accessibility.status': 'local-read',
    'app.context': 'local-read',
    'app.navigate': 'local-write'
  };
  for (const [name, effect] of Object.entries(expected)) {
    const entry = TOOL_REGISTRY.find(tool => tool.name === name);
    assert.ok(entry, `reviewed generic function must exist: ${name}`);
    assert.equal(entry.effect, effect, `${name} must not silently cross its reviewed effect boundary`);
  }
});

check('the inventory rejects a lost agent-spawn tool even when a replacement preserves the count', () => {
  const names = TOOL_REGISTRY.map(entry => entry.name);
  assert.ok(names.includes('agent.spawn'));
  assert.throws(() => assertShippedToolInventory(names.map(name => name === 'agent.spawn' ? 'boundary.unreviewed_tool' : name)),
    error => error.code === 'ERR_ASSERTION' && /agent\.spawn/.test(error.message));
});

check('the inventory rejects an unreviewed addition to the shipped surface', () => {
  assert.throws(() => assertShippedToolInventory([...TOOL_REGISTRY.map(entry => entry.name), 'boundary.unreviewed_tool']),
    error => error.code === 'ERR_ASSERTION' && /boundary\.unreviewed_tool/.test(error.message));
});

check('validateRegistry() still accepts the real, shipped TOOL_REGISTRY unchanged', () => {
  assert.doesNotThrow(() => validateRegistry());
});

check('real optional-pack composition cannot hide a missing core identity behind a larger count', () => {
  toolPacks.resetForTests();
  delete require.cache[registryPath];
  try {
    toolPacks.registerToolPack({
      name: 'identity-negative-control',
      definitions: ({ define }) => Array.from({ length: 20 }, (_, i) =>
        define(`identity_fixture.padding_${i}`, 'Unrelated fixture tool', noopSchema, noopHandler, { effect: 'local-read' }))
    });
    const composed = require('../src/lib/tool-registry');
    assert.doesNotThrow(() => composed.validateRegistry());
    assertCoreIdentities(composed.TOOL_REGISTRY, { exact: false });
    const missingHost = composed.TOOL_REGISTRY.filter(entry => entry.name !== 'host.exec');
    assert.ok(missingHost.length >= 240, 'negative control must clear the obsolete count floor');
    assert.throws(() => assertCoreIdentities(missingHost, { exact: false }), /required core identities missing: host\.exec/);
  } finally {
    toolPacks.resetForTests();
    delete require.cache[registryPath];
    assertCoreIdentities(require('../src/lib/tool-registry').TOOL_REGISTRY);
  }
});

console.log(`Tool effect classification (AE-F6) tests passed (${checks} checks; defineTool() fails closed on `
  + 'omitted/invalid effect and every real TOOL_REGISTRY entry is explicit).');
