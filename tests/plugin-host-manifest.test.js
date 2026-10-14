/*
 * Mutation: in manifest.js onlyKeys(), changed the unknown-field refusal from
 * `if (unknown.length) fail(...)` to `if (false && unknown.length) fail(...)`.
 * Landed: yes; the neutralised guard was present in src/lib/plugin-host/manifest.js.
 * Result: red, 2 of 16: 'an unrecognised field is refused, not ignored' and 'a
 * skin is a fixed token set; anything CSS-shaped is refused' both failed, because
 * a manifest carrying an undeclared field -- including a `selector` inside the
 * skin -- parsed cleanly. Restored: green, 16 of 16.
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const manifest = require('../src/lib/plugin-host/manifest');

const MINIMAL = {
  schemaVersion: 1,
  name: 'notes',
  displayName: 'Notes',
  summary: 'Keeps a searchable index of your own notes.',
  requires: ['subprocess'],
  provides: {
    tools: [{
      name: 'reindex',
      summary: 'Rebuild the index for a folder of notes.',
      effect: 'local-read',
      run: { interpreter: 'node', script: 'tools/reindex.js' },
      params: [{ name: 'root', type: 'path', description: 'The folder to index.' }]
    }]
  }
};

function parse(overrides = {}, provides = undefined) {
  const value = { ...MINIMAL, ...overrides };
  if (provides !== undefined) value.provides = provides;
  return manifest.parseManifest(JSON.stringify(value));
}

function refusal(build, code, pattern) {
  assert.throws(build, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test('a minimal manifest parses into a frozen normalized shape', () => {
  const parsed = parse();
  assert.equal(parsed.name, 'notes');
  assert.deepEqual(parsed.requires, ['subprocess']);
  assert.equal(parsed.provides.tools[0].effect, 'local-read');
  assert.equal(parsed.provides.tools[0].params[0].required, true, 'a parameter is required unless it says otherwise');
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.provides) && Object.isFrozen(parsed.provides.tools));
});

test('an unrecognised field is refused, not ignored', () => {
  // THE RULE THIS FILE EXISTS FOR. A host that skips what it cannot read cannot
  // tell the owner what it let through.
  refusal(() => parse({ trustLevel: 'high' }), 'PLUGIN_MANIFEST_UNKNOWN_FIELD', /refused rather than ignored/);
  refusal(
    () => manifest.parseManifest(JSON.stringify({
      ...MINIMAL,
      provides: { ...MINIMAL.provides, inProcessModule: 'lib/hook.js' }
    })),
    'PLUGIN_MANIFEST_UNKNOWN_FIELD',
    /provides/
  );
  refusal(
    () => manifest.parseManifest(JSON.stringify({
      ...MINIMAL,
      provides: { tools: [{ ...MINIMAL.provides.tools[0], sudo: true }] }
    })),
    'PLUGIN_MANIFEST_UNKNOWN_FIELD',
    /provides\.tools\[0\]/
  );
});

test('a manifest from a newer schema is refused rather than read as far as it parses', () => {
  refusal(() => parse({ schemaVersion: 2 }), 'PLUGIN_MANIFEST_VERSION', /refused rather than read as far as it parses/);
  refusal(() => parse({ schemaVersion: '1' }), 'PLUGIN_MANIFEST_VERSION');
});

test('a capability outside the vocabulary is refused and the whole vocabulary is named', () => {
  refusal(() => parse({ requires: ['subprocess', 'rootAccess'] }),
    'PLUGIN_MANIFEST_UNKNOWN_CAPABILITY', /storage, secrets, subprocess, network/);
  refusal(() => parse({ requires: ['subprocess', 'subprocess'] }), 'PLUGIN_MANIFEST_INVALID', /twice/);
});

test('providing something needs the capability by name; the host never infers it', () => {
  refusal(
    () => manifest.parseManifest(JSON.stringify({
      ...MINIMAL,
      requires: ['subprocess'],
      provides: { ...MINIMAL.provides, roles: ['roles/scout.json'] }
    })),
    'PLUGIN_MANIFEST_CAPABILITY_NOT_REQUESTED',
    /will not infer the capability from the contents/
  );
});

test('asking for a capability nothing uses is refused too', () => {
  // An unused entry on the approval screen is one the owner learns to approve
  // without reading, and then the next version of the package uses it.
  refusal(() => parse({ requires: ['subprocess', 'skin'] }), 'PLUGIN_MANIFEST_CAPABILITY_UNUSED',
    /teaches the owner to approve without reading/);
});

test('the effect floor is derived from capabilities and only ever raises', () => {
  assert.equal(manifest.effectFloor([]), 'local-read');
  assert.equal(manifest.effectFloor(['storage', 'roles']), 'local-read');
  assert.equal(manifest.effectFloor(['subprocess']), 'local-write');
  assert.equal(manifest.effectFloor(['subprocess', 'network']), 'external-read');
  assert.equal(manifest.effectFloor(['secrets']), 'external-write');
  // atLeast never lowers a declaration.
  assert.equal(manifest.atLeast('external-write', 'local-read'), 'external-write');
  assert.equal(manifest.atLeast('local-read', 'external-read'), 'external-read');
  assert.equal(manifest.atLeast('local-write', 'local-write'), 'local-write');
});

test('a tool must declare an effect and there is no default', () => {
  // Omitted entirely: caught by the closed-world field check, which names it.
  refusal(
    () => manifest.parseManifest(JSON.stringify({
      ...MINIMAL,
      provides: { tools: [{ ...MINIMAL.provides.tools[0], effect: undefined }] }
    })),
    'PLUGIN_MANIFEST_INVALID',
    /is missing: effect/
  );
  refusal(
    () => manifest.parseManifest(JSON.stringify({
      ...MINIMAL,
      provides: { tools: [{ ...MINIMAL.provides.tools[0], effect: 'harmless' }] }
    })),
    'PLUGIN_MANIFEST_INVALID',
    /no default/
  );
});

test('an interpreter is named from a fixed list, never given as a path', () => {
  const withInterpreter = (interpreter) => manifest.parseManifest(JSON.stringify({
    ...MINIMAL,
    provides: { tools: [{ ...MINIMAL.provides.tools[0], run: { interpreter, script: 'tools/reindex.js' } }] }
  }));
  assert.equal(withInterpreter('python3').provides.tools[0].run.interpreter, 'python3');
  refusal(() => withInterpreter('/usr/bin/python3'), 'PLUGIN_MANIFEST_INVALID', /names an interpreter, never a path/);
  refusal(() => withInterpreter('bash'), 'PLUGIN_MANIFEST_INVALID', /python3, node/);
});

test('a script path cannot leave the package, whatever shape the escape takes', () => {
  const withScript = (script) => manifest.parseManifest(JSON.stringify({
    ...MINIMAL,
    provides: { tools: [{ ...MINIMAL.provides.tools[0], run: { interpreter: 'node', script } }] }
  }));
  assert.equal(withScript('tools/reindex.js').provides.tools[0].run.script, 'tools/reindex.js');
  assert.equal(withScript('a/b/c/d.js').provides.tools[0].run.script, 'a/b/c/d.js');
  for (const bad of [
    '../outside.js', 'tools/../../outside.js', '/etc/passwd', './tools/x.js', 'tools/./x.js',
    'tools//x.js', '\x43:\\windows\\system32\\cmd.exe', 'tools/..', '..', '.', 'tools/x.js\u0000.txt',
    'tools/$(whoami).js', 'tools/x;rm -rf.js'
  ]) {
    refusal(() => withScript(bad), 'PLUGIN_MANIFEST_INVALID', /PACKAGE_PATH|must be trimmed single-line/);
  }
});

test('fixed args are fixed, and a caller value is never interpolated into them', () => {
  const withArgs = (args) => manifest.parseManifest(JSON.stringify({
    ...MINIMAL,
    provides: { tools: [{ ...MINIMAL.provides.tools[0], run: { interpreter: 'node', script: 'tools/x.js', args } }] }
  }));
  assert.deepEqual(withArgs(['--json', 'scan']).provides.tools[0].run.args, ['--json', 'scan']);
  refusal(() => withArgs(['${root}']), 'PLUGIN_MANIFEST_INVALID', /nothing interpolates/);
  refusal(() => withArgs(['a b']), 'PLUGIN_MANIFEST_INVALID');
  refusal(() => withArgs(['`id`']), 'PLUGIN_MANIFEST_INVALID');
});

test('a required parameter cannot also carry a default', () => {
  const withParam = (param) => manifest.parseManifest(JSON.stringify({
    ...MINIMAL,
    provides: { tools: [{ ...MINIMAL.provides.tools[0], params: [param] }] }
  }));
  assert.equal(withParam({ name: 'depth', type: 'integer', description: 'How deep.', required: false, default: 3 })
    .provides.tools[0].params[0].default, 3);
  refusal(() => withParam({ name: 'depth', type: 'integer', description: 'How deep.', default: 3 }),
    'PLUGIN_MANIFEST_INVALID', /has no default/);
});

test('a skin is a fixed token set; anything CSS-shaped is refused', () => {
  const withSkin = (skin) => manifest.parseManifest(JSON.stringify({
    ...MINIMAL,
    requires: ['subprocess', 'skin'],
    provides: { ...MINIMAL.provides, skin }
  }));
  assert.deepEqual(withSkin({ accent: '#0b6', radius: '6px', badge: 'Notes' }).provides.skin,
    { accent: '#0b6', radius: '6px', badge: 'Notes' });
  // The two things free CSS buys an attacker, refused by the vocabulary itself.
  refusal(() => withSkin({ accent: 'url(https://example.test/leak.png)' }), 'PLUGIN_MANIFEST_INVALID', /#rgb or #rrggbb/);
  refusal(() => withSkin({ accent: 'red; position:fixed; top:0' }), 'PLUGIN_MANIFEST_INVALID');
  refusal(() => withSkin({ radius: '9999999px' }), 'PLUGIN_MANIFEST_INVALID', /length in px or rem/);
  refusal(() => withSkin({ selector: '.approval-prompt' }), 'PLUGIN_MANIFEST_UNKNOWN_FIELD');
});

test('a name is a label, not a claim, and its shape is checked', () => {
  assert.equal(parse({ name: 'notes-tools' }).name, 'notes-tools');
  refusal(() => parse({ name: 'Notes' }), 'PLUGIN_MANIFEST_INVALID');
  refusal(() => parse({ name: 'notes_tools' }), 'PLUGIN_MANIFEST_INVALID');
  refusal(() => parse({ name: '../notes' }), 'PLUGIN_MANIFEST_INVALID');
  refusal(() => parse({ name: '' }), 'PLUGIN_MANIFEST_INVALID');
});

test('unparseable JSON says so instead of half-loading', () => {
  refusal(() => manifest.parseManifest('{"schemaVersion":1,'), 'PLUGIN_MANIFEST_UNPARSEABLE');
});

test('two tools cannot share a name inside one plugin', () => {
  refusal(
    () => manifest.parseManifest(JSON.stringify({
      ...MINIMAL,
      provides: { tools: [MINIMAL.provides.tools[0], MINIMAL.provides.tools[0]] }
    })),
    'PLUGIN_MANIFEST_INVALID',
    /twice/
  );
});
