/*
 * Mutations run, one at a time, each landed in src/lib/plugin-host/tool-bridge.js
 * and confirmed present before the run. Baseline and restored: green.
 *   1. containedIn() -> `return candidate.startsWith(root)`, the prefix test ->
 *      red: 'a sibling directory whose name starts with the workspace is outside it'.
 *   2. in argvFor(), the `path` branch pushed `given` instead of the resolved and
 *      checked path -> red: 'a path parameter reaches the child resolved, and only
 *      from inside the workspace'.
 *   3. childEnvironment() spread `...process.env` into the object -> red, 2 of 17
 *      ('the child environment is constructed and never inherited', and the real
 *      child run, which reads the env the child actually got).
 *   4. removed the stdout byte cap from runChild() -> red, 1 of 17 ('a child that
 *      writes without stopping is refused, not truncated into a success').
 * Runs 1 and 2 were red 1 of 17 each, on the named test only. Restored: green,
 * 17 of 17.
 *
 * Item 11 (ELECTRON_RUN_AS_NODE for a `node` tool under Electron), 2026-09-26.
 * Before the fix the four tests below the Electron heading ran red 2 of 21 (the
 * env builder and the real child). With the fix, green 21 of 21, and:
 *   5. reentersElectronBinary() -> `Boolean(process.versions.electron)` alone
 *      (any interpreter) -> red 1 of 21 ('a child on any other interpreter does
 *      not get the Node switch').
 *   6. dropped its process.versions.electron check -> red 2 of 21 (the plain-node
 *      test and the real child run, which sees one key too many).
 *   7. definitionsFor() stopped passing `executable` to childEnvironment() -> red
 *      1 of 21 ('a real node-interpreter tool reaches its child with the Node
 *      switch set').
 * Restored: green, 21 of 21.
 *
 * A stopped call, and a package changed under a running app (release integration,
 * 1.0.49, 2026-09-27). The four tests at the end were red against 4adda18 (4 of
 * 25) and green after. Mutations, one at a time, restored after (25 of 25):
 *   8. the per-call digest check made a no-op -> red, 1 of 25 (the changed package).
 *   9. the abort signal not handed to spawn() -> red, 2 of 25 (the stopped call,
 *      and the same through the real registry).
 *   10. the handler drops the call's context -> red, 4 of 25.
 *   11. executeTool() no longer hands a takesAbortSignal tool its signal -> red,
 *       1 of 25 (the real-registry test).
 *   13. the error taxonomy's exact PLUGIN_CHANGED_SINCE_ALLOWED rule removed ->
 *       red, 1 of 26 (the last test: the refusal reached the agent as an
 *       internal error, found re-checking the real app).
 *   12. the explicit "already stopped" check before spawn() removed -> SURVIVED:
 *       spawn() with an aborted signal also kills the child before its script
 *       runs. Kept, because that is Node's timing and this is a guarantee.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const bridge = require('../src/lib/plugin-host/tool-bridge');
const { parseManifest } = require('../src/lib/plugin-host/manifest');
const { packageIdentity } = require('../src/lib/plugin-host/identity');


/* Shaped like the real PluginGrantStore for the two methods the bridge calls.
   A loose `{ approvalWaived }` stub satisfied the bridge only while permission was
   read from the array captured at activation, so the stub silently encoded the very
   defect the live read exists to remove. definitionsFor() now refuses a store that
   cannot serve dispatch, which is why these are shaped. */
function fakeGrants(granted, { waived = false } = {}) {
  let live = Object.freeze([...granted]);
  let waiving = waived;
  return {
    capabilitiesFor: () => live,
    approvalWaived: () => waiving,
    revokeAll: () => { live = Object.freeze([]); },
    withdraw: (capability) => { live = Object.freeze(live.filter(item => item !== capability)); },
    withdrawWaiver: () => { waiving = false; }
  };
}

const TOOL = parseManifest(JSON.stringify({
  schemaVersion: 1,
  name: 'notes',
  displayName: 'Notes',
  summary: 'Keeps a searchable index of your own notes.',
  requires: ['subprocess'],
  provides: {
    tools: [{
      name: 'reindex',
      summary: 'Rebuild the index.',
      effect: 'local-read',
      run: { interpreter: 'node', script: 'tools/reindex.js', args: ['--json'] },
      params: [
        { name: 'root', type: 'path', description: 'The folder to index.' },
        { name: 'depth', type: 'integer', description: 'How deep.', required: false, default: 3 },
        { name: 'label', type: 'string', description: 'A label.', required: false },
        { name: 'verbose', type: 'boolean', description: 'Say more.', required: false }
      ]
    }]
  }
})).provides.tools[0];

test('containment is by path segment, not by string prefix', () => {
  assert.equal(bridge.containedIn('/srv/ws', '/srv/ws'), true);
  assert.equal(bridge.containedIn('/srv/ws', '/srv/ws/a/b'), true);
  assert.equal(bridge.containedIn('/srv/ws', '/srv/other'), false);
  assert.equal(bridge.containedIn('/srv/ws', '/srv'), false);
});

test('a sibling directory whose name starts with the workspace is outside it', () => {
  // The one-character-wide fence. '/srv/ws-other'.startsWith('/srv/ws') is true
  // and the directory is somebody else's.
  assert.equal(bridge.containedIn('/srv/ws', '/srv/ws-other'), false);
  assert.equal(bridge.containedIn('/srv/ws', '/srv/ws2/secret'), false);
});

test('the input schema is closed and matches the declared parameters exactly', () => {
  const schema = bridge.jsonSchemaFor(TOOL);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false, 'the registry requires a closed schema and so does honesty');
  assert.deepEqual(Object.keys(schema.properties).sort(), ['depth', 'label', 'root', 'verbose']);
  assert.deepEqual(schema.required, ['root']);
  assert.equal(schema.properties.root.type, 'string');
  assert.equal(schema.properties.depth.type, 'integer');
  assert.equal(schema.properties.verbose.type, 'boolean');
});

test('a path parameter reaches the child resolved, and only from inside the workspace', () => {
  const workspace = path.join(os.homedir(), '.te-plugin-ws-fixture');
  const argv = bridge.argvFor(TOOL, { root: 'src/lib' }, { workspace });
  assert.deepEqual(argv, ['--json', '--root', path.join(workspace, 'src/lib'), '--depth', '3']);
  // A default is applied for an omitted optional parameter, and an omitted one
  // with no default simply is not passed.
  assert.ok(!argv.includes('--label'));
  assert.ok(!argv.includes('--verbose'));
});

test('a path parameter cannot leave the workspace, and .. is resolved before the check', () => {
  const workspace = path.join(os.homedir(), '.te-plugin-ws-fixture');
  for (const escape of ['../outside', '../../etc/passwd', 'a/../../outside', '/etc/passwd']) {
    assert.throws(() => bridge.argvFor(TOOL, { root: escape }, { workspace }), (error) => {
      assert.equal(error.code, 'PLUGIN_TOOL_PATH_OUTSIDE_WORKSPACE');
      assert.match(error.message, /resolved first and then checked/);
      return true;
    });
  }
});

test('with no workspace designated, a path parameter is refused outright', () => {
  // The absence of a root is not permission to use any root.
  assert.throws(() => bridge.argvFor(TOOL, { root: 'x' }, { workspace: null }), (error) => {
    assert.equal(error.code, 'PLUGIN_TOOL_NO_WORKSPACE');
    assert.match(error.message, /"no root" is not permission to use any root|is not permission to use any root/);
    return true;
  });
});

test('a boolean is a flag, never the text "false"', () => {
  const workspace = path.join(os.homedir(), '.te-plugin-ws-fixture');
  assert.ok(bridge.argvFor(TOOL, { root: '.', verbose: true }, { workspace }).includes('--verbose'));
  assert.ok(!bridge.argvFor(TOOL, { root: '.', verbose: false }, { workspace }).includes('--verbose'));
});

test('a NUL in a string parameter is refused, because argv would truncate at it', () => {
  const workspace = path.join(os.homedir(), '.te-plugin-ws-fixture');
  assert.throws(
    () => bridge.argvFor(TOOL, { root: '.', label: 'safe\u0000--danger' }, { workspace }),
    (error) => {
      assert.equal(error.code, 'PLUGIN_TOOL_ARGUMENT_INVALID');
      assert.match(error.message, /NUL byte/);
      return true;
    }
  );
});

test('a caller value is a separate argv entry, so nothing is interpolated', () => {
  const workspace = path.join(os.homedir(), '.te-plugin-ws-fixture');
  const argv = bridge.argvFor(TOOL, { root: '.', label: '; rm -rf / #' }, { workspace });
  const index = argv.indexOf('--label');
  assert.equal(argv[index + 1], '; rm -rf / #',
    'the shell metacharacters survive as data because there is no shell');
  assert.equal(argv.filter(entry => entry === '--label').length, 1);
});

test('the child environment is constructed and never inherited', () => {
  const env = bridge.childEnvironment({
    identity: { id: 'plugin-abc', sha256: 'a'.repeat(64) },
    workspace: '/srv/ws', storage: '/srv/store', temporary: '/srv/tmp'
  });
  assert.deepEqual(Object.keys(env).sort(), [
    'HOME', 'LANG', 'LC_ALL', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'TEMP', 'TMP', 'TMPDIR',
    'TOOLSENABLED_PLUGIN_ID', 'TOOLSENABLED_PLUGIN_SHA256',
    'TOOLSENABLED_PLUGIN_STORAGE', 'TOOLSENABLED_PLUGIN_WORKSPACE'
  ]);
  assert.equal(env.PATH, bridge.CHILD_PATH);
  // The specific thing this exists to stop: a provider credential reaching a
  // plugin's subprocess because the env was spread from the parent.
  for (const name of Object.keys(env)) {
    assert.ok(!/api[_-]?key|token|secret|credential/i.test(name), `${name} has no business in a plugin's child`);
  }
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH.includes(path.dirname(process.execPath)) && process.env.PATH === env.PATH, false);
});

test('storage is absent from the environment when storage was not granted', () => {
  const env = bridge.childEnvironment({
    identity: { id: 'plugin-abc', sha256: 'a'.repeat(64) },
    workspace: '/srv/ws', storage: null, temporary: '/srv/tmp'
  });
  assert.equal(Object.hasOwn(env, 'TOOLSENABLED_PLUGIN_STORAGE'), false);
});

test('definitionsFor builds a registry-shaped, namespaced, floor-raised tool', () => {
  const calls = [];
  const api = {
    define: (name, description, inputSchema, handler, options) => {
      calls.push({ name, description, inputSchema, handler, options });
      return { name, options };
    }
  };
  const plugin = {
    identity: { id: 'plugin-abc', sha256: 'a'.repeat(64), root: '/srv/pkg' },
    manifest: { name: 'notes', displayName: 'Notes', provides: { tools: [TOOL] } },
    // A network grant is in force, so a declared local-read tool is external-read.
    capabilities: ['subprocess', 'network'],
    paths: { workspace: '/srv/ws', storage: null, temporary: '/srv/tmp' },
    interpreters: { node: process.execPath },
    grants: fakeGrants(['subprocess', 'network'])
  };
  bridge.definitionsFor(plugin, api);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.name, 'plugin.notes.reindex');
  assert.match(call.name, /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/, 'the registry only accepts dotted lowercase names');
  assert.equal(call.options.effect, 'external-read',
    'a package holding a network grant has no local-read tools, whatever its manifest says');
  assert.equal(call.options.approvalEligible, true);
  assert.equal(call.options.provider, null, 'provider is a closed vocabulary of real integrations');
  assert.match(call.description, /^Notes: /);
});

test('an over-declared effect is taken at its word and never lowered', () => {
  const api = { define: (name, description, schema, handler, options) => ({ name, options }) };
  const honest = { ...TOOL, effect: 'external-write' };
  const plugin = {
    identity: { id: 'plugin-abc', sha256: 'a'.repeat(64), root: '/srv/pkg' },
    manifest: { name: 'notes', displayName: 'Notes', provides: { tools: [honest] } },
    capabilities: ['subprocess'],
    paths: { workspace: '/srv/ws', storage: null, temporary: '/srv/tmp' },
    interpreters: { node: process.execPath },
    grants: fakeGrants(['subprocess'])
  };
  const [built] = bridge.definitionsFor(plugin, api);
  assert.equal(built.options.effect, 'external-write');
});

test('a plugin with no subprocess grant contributes no tool that can run', async () => {
  const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
  const plugin = {
    identity: { id: 'plugin-abc', sha256: 'a'.repeat(64), root: '/srv/pkg' },
    manifest: { name: 'notes', displayName: 'Notes', provides: { tools: [TOOL] } },
    capabilities: ['storage'],
    paths: { workspace: null, storage: '/srv/store', temporary: null },
    interpreters: {},
    grants: fakeGrants(['storage'])
  };
  const [built] = bridge.definitionsFor(plugin, api);
  await assert.rejects(() => built.handler({ root: '.' }), (error) => {
    assert.equal(error.code, 'PLUGIN_CAPABILITY_DENIED');
    assert.match(error.message, /not currently allowed to run programs/);
    // Worded to separate "never allowed" from "withdrawn since startup": only one of
    // those is the person's own recent decision, and the sentence has to say which.
    assert.match(error.message, /Allow it on the plugins page/);
    return true;
  });
});

// --- AN ACTUAL CHILD PROCESS -------------------------------------------------

function fixturePlugin() {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.te-plugin-child-'));
  fs.mkdirSync(path.join(root, 'pkg', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg', 'tools', 'echo.js'),
    'const a = process.argv.slice(2);\n'
    + 'process.stdout.write(JSON.stringify({ argv: a, env: Object.keys(process.env).sort(), cwd: process.cwd() }));\n');
  return root;
}

/* The package's REAL identity, taken after the test has written its scripts: a
   tool runs only while its package still has the digest it was allowed under. */
function childPlugin(root, tool) {
  const identity = packageIdentity(path.join(root, 'pkg'));
  return {
    identity: { id: identity.id, sha256: identity.sha256, root: identity.root },
    manifest: { name: 'fixture', displayName: 'Fixture', provides: { tools: [tool] } },
    capabilities: ['subprocess'],
    paths: { workspace: path.join(root, 'ws'), storage: null, temporary: path.join(root, 'ws') },
    interpreters: { node: process.execPath },
    grants: fakeGrants(['subprocess'])
  };
}

test('a real child receives the declared argv and only the constructed environment', async () => {
  const root = fixturePlugin();
  try {
    const tool = parseManifest(JSON.stringify({
      schemaVersion: 1, name: 'fixture', displayName: 'Fixture', summary: 'An echo.',
      requires: ['subprocess'],
      provides: {
        tools: [{
          name: 'echo', summary: 'Echo argv.', effect: 'local-read',
          run: { interpreter: 'node', script: 'tools/echo.js' },
          params: [{ name: 'label', type: 'string', description: 'A label.' }]
        }]
      }
    })).provides.tools[0];
    const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
    const [built] = bridge.definitionsFor(childPlugin(root, tool), api);
    const result = await built.handler({ label: 'hello; whoami' });
    const seen = JSON.parse(result.stdout);
    assert.deepEqual(seen.argv, ['--label', 'hello; whoami'],
      'the metacharacters arrived as one argv value, unexecuted');
    assert.ok(!seen.env.includes('ANTHROPIC_API_KEY'));
    assert.deepEqual(seen.env, [
      'HOME', 'LANG', 'LC_ALL', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'TEMP', 'TMP', 'TMPDIR',
      'TOOLSENABLED_PLUGIN_ID', 'TOOLSENABLED_PLUGIN_SHA256', 'TOOLSENABLED_PLUGIN_WORKSPACE'
    ], 'exactly the constructed set reached the child');
    assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(path.join(root, 'ws')));
    assert.equal(result.plugin, 'fixture');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- UNDER ELECTRON, THE `node` INTERPRETER IS THE APP'S OWN BINARY ----------
//
// The `node` interpreter resolves to process.execPath. In the app process and in
// the mission-bridge child that is the Electron binary, which without
// ELECTRON_RUN_AS_NODE starts as a browser, ignores the script and, on Linux with
// no display, dies on SIGTRAP (exit 133) -- measured under Electron 43.3.0 in both
// shapes before the fix. These tests stand in for Electron by giving
// process.versions an `electron` entry for their duration, then restore it.

async function withElectronVersion(version, run) {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  if (version === null) delete process.versions.electron;
  else Object.defineProperty(process.versions, 'electron', { value: version, configurable: true, enumerable: true });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(process.versions, 'electron', original);
    else delete process.versions.electron;
  }
}

const IDENTITY = { id: 'plugin-abc', sha256: 'a'.repeat(64) };

test('under Electron, a child re-entering this process\'s own binary is told to run as Node', async () => {
  await withElectronVersion('43.3.0', () => {
    const env = bridge.childEnvironment({
      identity: IDENTITY, workspace: '/srv/ws', storage: null, temporary: '/srv/tmp', executable: process.execPath
    });
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
    assert.deepEqual(Object.keys(env).sort(), [
      'ELECTRON_RUN_AS_NODE', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'TEMP', 'TMP', 'TMPDIR',
      'TOOLSENABLED_PLUGIN_ID', 'TOOLSENABLED_PLUGIN_SHA256', 'TOOLSENABLED_PLUGIN_WORKSPACE'
    ], 'one literal is added and nothing is inherited');
  });
});

test('under Electron, a child on any other interpreter does not get the Node switch', async () => {
  await withElectronVersion('43.3.0', () => {
    const env = bridge.childEnvironment({
      identity: IDENTITY, workspace: '/srv/ws', storage: null, temporary: '/srv/tmp', executable: '/usr/bin/python3'
    });
    assert.equal(Object.hasOwn(env, 'ELECTRON_RUN_AS_NODE'), false,
      'the switch is for re-entering our own binary; a python3 child has no use for it');
  });
});

test('under plain node, the Node switch is absent even for this process\'s own binary', async () => {
  await withElectronVersion(null, () => {
    const env = bridge.childEnvironment({
      identity: IDENTITY, workspace: '/srv/ws', storage: null, temporary: '/srv/tmp', executable: process.execPath
    });
    assert.equal(Object.hasOwn(env, 'ELECTRON_RUN_AS_NODE'), false);
  });
});

test('under Electron, a real node-interpreter tool reaches its child with the Node switch set', async () => {
  const root = fixturePlugin();
  try {
    fs.writeFileSync(path.join(root, 'pkg', 'tools', 'mode.js'),
      'process.stdout.write(JSON.stringify({ env: Object.keys(process.env).sort(), '
      + 'runAsNode: process.env.ELECTRON_RUN_AS_NODE || null }));\n');
    const tool = parseManifest(JSON.stringify({
      schemaVersion: 1, name: 'fixture', displayName: 'Fixture', summary: 'Reports its mode.',
      requires: ['subprocess'],
      provides: {
        tools: [{
          name: 'mode', summary: 'Report the mode.', effect: 'local-read',
          run: { interpreter: 'node', script: 'tools/mode.js' }, params: []
        }]
      }
    })).provides.tools[0];
    const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
    const [built] = bridge.definitionsFor(childPlugin(root, tool), api);
    const result = await withElectronVersion('43.3.0', () => built.handler({}));
    const seen = JSON.parse(result.stdout);
    assert.equal(seen.runAsNode, '1', 'definitionsFor hands the resolved interpreter to the env builder');
    assert.deepEqual(seen.env, [
      'ELECTRON_RUN_AS_NODE', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'TEMP', 'TMP', 'TMPDIR',
      'TOOLSENABLED_PLUGIN_ID', 'TOOLSENABLED_PLUGIN_SHA256', 'TOOLSENABLED_PLUGIN_WORKSPACE'
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a child that fails is reported as a refusal carrying its stderr', async () => {
  const root = fixturePlugin();
  try {
    fs.writeFileSync(path.join(root, 'pkg', 'tools', 'fail.js'),
      'process.stderr.write("the index is locked by another run\\n"); process.exit(3);\n');
    const tool = parseManifest(JSON.stringify({
      schemaVersion: 1, name: 'fixture', displayName: 'Fixture', summary: 'A failure.',
      requires: ['subprocess'],
      provides: {
        tools: [{
          name: 'fail', summary: 'Fail.', effect: 'local-read',
          run: { interpreter: 'node', script: 'tools/fail.js' }, params: []
        }]
      }
    })).provides.tools[0];
    const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
    const [built] = bridge.definitionsFor(childPlugin(root, tool), api);
    await assert.rejects(() => built.handler({}), (error) => {
      assert.equal(error.code, 'PLUGIN_TOOL_FAILED');
      assert.match(error.message, /status 3/);
      assert.match(error.message, /the index is locked by another run/);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a child that writes without stopping is refused, not truncated into a success', async () => {
  const root = fixturePlugin();
  try {
    fs.writeFileSync(path.join(root, 'pkg', 'tools', 'flood.js'),
      'const chunk = "x".repeat(64 * 1024);\n'
      + 'for (let i = 0; i < 64; i += 1) process.stdout.write(chunk);\n');
    const tool = parseManifest(JSON.stringify({
      schemaVersion: 1, name: 'fixture', displayName: 'Fixture', summary: 'A flood.',
      requires: ['subprocess'],
      provides: {
        tools: [{
          name: 'flood', summary: 'Flood.', effect: 'local-read',
          run: { interpreter: 'node', script: 'tools/flood.js' }, params: []
        }]
      }
    })).provides.tools[0];
    const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
    const [built] = bridge.definitionsFor(childPlugin(root, tool), api);
    await assert.rejects(() => built.handler({}), (error) => {
      assert.equal(error.code, 'PLUGIN_TOOL_OUTPUT_TOO_LARGE');
      assert.match(error.message, /truncated result that reads as a complete one is worse than a refusal/);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- A CALL THAT IS STOPPED, AND A PACKAGE THAT CHANGED UNDER A RUNNING APP --

/* A tool that marks it started, waits, then writes a file into its workspace. */
function slowWriter(root) {
  fs.writeFileSync(path.join(root, 'pkg', 'tools', 'slow.js'),
    'const fs = require("node:fs"); const path = require("node:path");\n'
    + 'fs.writeFileSync(path.join(process.env.TOOLSENABLED_PLUGIN_WORKSPACE, "started"), "");\n'
    + 'setTimeout(() => { fs.writeFileSync(path.join(process.env.TOOLSENABLED_PLUGIN_WORKSPACE, "wrote"), "late"); }, 1500);\n');
  return parseManifest(JSON.stringify({
    schemaVersion: 1, name: 'fixture', displayName: 'Fixture', summary: 'Writes late.',
    requires: ['subprocess'],
    provides: {
      tools: [{
        name: 'slow', summary: 'Write after a pause.', effect: 'local-write',
        run: { interpreter: 'node', script: 'tools/slow.js' }, params: []
      }]
    }
  })).provides.tools[0];
}

const settle = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('a stopped call ends the tool\'s program, which writes nothing afterwards', async () => {
  // Found by review, 2026-09-27: the registry handed a plugin tool no context and
  // the bridge ignored any abort signal, so a stopped session, Erase or quit left
  // the child running -- after quit with no time limit at all, because the
  // 120-second timer died with the app. Measured: with the signal already fired,
  // the child still wrote into its workspace 1.55 seconds later.
  const root = fixturePlugin();
  try {
    const tool = slowWriter(root);
    const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
    const [built] = bridge.definitionsFor(childPlugin(root, tool), api);
    const controller = new AbortController();
    const call = built.handler({}, { signal: controller.signal });
    const started = path.join(root, 'ws', 'started');
    for (let waited = 0; !fs.existsSync(started) && waited < 5000; waited += 20) await settle(20);
    assert.ok(fs.existsSync(started), 'the program was running when the call was stopped');
    controller.abort();
    await assert.rejects(call, (error) => {
      assert.equal(error.code, 'PLUGIN_TOOL_ABORTED');
      assert.match(error.message, /stopped/);
      return true;
    });
    await settle(2000);
    assert.equal(fs.existsSync(path.join(root, 'ws', 'wrote')), false, 'the program was ended, not left to finish');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a call already stopped starts nothing', async () => {
  const root = fixturePlugin();
  try {
    const tool = slowWriter(root);
    const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
    const [built] = bridge.definitionsFor(childPlugin(root, tool), api);
    await assert.rejects(built.handler({}, { signal: AbortSignal.abort() }), (error) => {
      assert.equal(error.code, 'PLUGIN_TOOL_ABORTED');
      return true;
    });
    await settle(300);
    assert.equal(fs.existsSync(path.join(root, 'ws', 'started')), false, 'no program was started');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a tool whose package changed after it was allowed does not run until the person decides again', async () => {
  // Found in the real app (1.0.49 plugins walk, HP-36): one byte of a granted
  // plugin's script edited while the app ran, and the next call ran the edited
  // script under the old grant -- while the plugins page, reading the new digest,
  // said the plugin was allowed nothing. A decision is never carried across
  // changed bytes, including inside one run of the app.
  const root = fixturePlugin();
  try {
    const tool = slowWriter(root);
    const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
    const [built] = bridge.definitionsFor(childPlugin(root, tool), api);
    fs.appendFileSync(path.join(root, 'pkg', 'tools', 'slow.js'), '// one more line\n');
    await assert.rejects(built.handler({}), (error) => {
      assert.equal(error.code, 'PLUGIN_CHANGED_SINCE_ALLOWED');
      assert.match(error.message, /changed on this computer since/);
      assert.match(error.message, /plugins page/);
      return true;
    });
    await settle(300);
    assert.equal(fs.existsSync(path.join(root, 'ws', 'started')), false, 'the changed script was not run');
    // Putting the byte back restores the package the person allowed, and it runs.
    const script = path.join(root, 'pkg', 'tools', 'slow.js');
    fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('// one more line\n', ''));
    const controller = new AbortController();
    const call = built.handler({}, { signal: controller.signal });
    const started = path.join(root, 'ws', 'started');
    for (let waited = 0; !fs.existsSync(started) && waited < 5000; waited += 20) await settle(20);
    assert.ok(fs.existsSync(started), 'the restored package runs');
    controller.abort();
    await assert.rejects(call, (error) => error.code === 'PLUGIN_TOOL_ABORTED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('through the real registry, a stopped call reaches the plugin tool and ends its program', async () => {
  // The bridge half above is not enough on its own: executeTool() decides what a
  // handler is called with, and it called every pack tool with (args) alone. Run
  // in a child, because a pack has to be registered before the registry loads and
  // the registry cannot be unloaded.
  const { execFile } = require('node:child_process');
  const root = fixturePlugin();
  try {
    const tool = slowWriter(root);
    const program = `
      require(${JSON.stringify(require.resolve('./lib/isolated-environment'))}).activate('plugin-tool-abort');
      const path = require('node:path');
      const fs = require('node:fs');
      const bridge = require(${JSON.stringify(require.resolve('../src/lib/plugin-host/tool-bridge'))});
      const { packageIdentity } = require(${JSON.stringify(require.resolve('../src/lib/plugin-host/identity'))});
      const packs = require(${JSON.stringify(require.resolve('../src/lib/tool-pack-registry'))});
      const root = ${JSON.stringify(root)};
      const identity = packageIdentity(path.join(root, 'pkg'));
      const plugin = {
        identity: { id: identity.id, sha256: identity.sha256, root: identity.root },
        manifest: { name: 'fixture', displayName: 'Fixture', provides: { tools: [${JSON.stringify(tool)}] } },
        capabilities: ['subprocess'],
        paths: { workspace: path.join(root, 'ws'), storage: null, temporary: path.join(root, 'ws') },
        interpreters: { node: process.execPath },
        // Inlined rather than calling fakeGrants: this object literal is written into a
        // child script, where the helper from this file does not exist.
        grants: { capabilitiesFor: () => ['subprocess'], approvalWaived: () => true }
      };
      packs.registerToolPack({ name: 'plugin-fixture', definitions: (api) => bridge.definitionsFor(plugin, api) });
      const { executeTool } = require(${JSON.stringify(require.resolve('../src/lib/tool-registry'))});
      (async () => {
        const controller = new AbortController();
        const call = executeTool('plugin.fixture.slow', {}, { permissionSession: { origin: 'local', tier: 'full' }, signal: controller.signal });
        const started = path.join(root, 'ws', 'started');
        for (let waited = 0; !fs.existsSync(started) && waited < 5000; waited += 20) await new Promise(r => setTimeout(r, 20));
        const running = fs.existsSync(started);
        controller.abort();
        let code = null;
        try { await call; } catch (error) { code = error.code; }
        await new Promise(r => setTimeout(r, 2000));
        process.stdout.write(JSON.stringify({ running, code, wrote: fs.existsSync(path.join(root, 'ws', 'wrote')) }));
        process.exit(0);
      })();
    `;
    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, ['-e', program], { encoding: 'utf8', env: process.env, timeout: 60000 },
        (error, out, err) => (error ? reject(Object.assign(error, { stderr: err })) : resolve(out)));
    });
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').pop()), { running: true, code: 'PLUGIN_TOOL_ABORTED', wrote: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a plugin tool\'s own refusals reach the agent as what they are, never as an internal error', () => {
  // Found re-checking the real app: the changed-package refusal reached the
  // caller as "The operation stopped safely because of an internal error.",
  // because the closed error taxonomy had no rule for its code. It is a
  // permission decision, and the sentence says how to make it again.
  const taxonomy = require('../src/lib/error-taxonomy');
  assert.equal(taxonomy.publicFailure({ code: 'PLUGIN_CHANGED_SINCE_ALLOWED' }).code, 'POLICY_DENIED');
  assert.equal(taxonomy.publicFailure({ code: 'PLUGIN_TOOL_ABORTED' }).code, 'OPERATION_CANCELLED');
  const { toolError } = require('../src/mcp-server');
  const changed = Object.assign(new Error('Field Notes has changed on this computer since you allowed it, so its tools do not run.'),
    { code: 'PLUGIN_CHANGED_SINCE_ALLOWED' });
  const text = JSON.stringify(toolError(changed));
  assert.match(text, /has changed on this computer since you allowed it/);
  assert.doesNotMatch(text, /internal error/);
});

test('revoking a grant stops a tool that is already registered', async () => {
  // The tool SET is frozen at startup on purpose. Permission is not, and this is why:
  // measured against the captured-array version, the grant store returned [] and the
  // tool still ran. A revocation that waits for a restart is a note to self.
  const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-revoke-'));
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools/reindex.js'), 'process.stdout.write("ran");\n');
  const grants = fakeGrants(['subprocess']);
  const plugin = {
    identity: packageIdentity(root),
    manifest: { name: 'notes', displayName: 'Notes', provides: { tools: [TOOL] } },
    capabilities: ['subprocess'],
    paths: { workspace: root, storage: path.join(root, 'store'), temporary: null },
    interpreters: { node: process.execPath },
    grants
  };
  const [built] = bridge.definitionsFor(plugin, api);
  assert.match(JSON.stringify(await built.handler({ root })), /ran/);
  grants.revokeAll();
  await assert.rejects(() => built.handler({ root }), (error) => {
    assert.equal(error.code, 'PLUGIN_CAPABILITY_DENIED');
    assert.match(error.message, /withdrawn since/);
    return true;
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('withdrawing storage stops the child being handed its storage path', async () => {
  // A PARTIAL withdrawal has to bite too. Before the environment read the store, the
  // child still got TOOLSENABLED_PLUGIN_STORAGE after the owner withdrew storage and
  // kept subprocess -- half a grant revoked, nothing revoked.
  const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-storage-'));
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools/reindex.js'),
    'process.stdout.write(process.env.TOOLSENABLED_PLUGIN_STORAGE || "none");\n');
  const grants = fakeGrants(['subprocess', 'storage']);
  const plugin = {
    identity: packageIdentity(root),
    manifest: { name: 'notes', displayName: 'Notes', provides: { tools: [TOOL] } },
    capabilities: ['subprocess', 'storage'],
    paths: { workspace: root, storage: path.join(root, 'store'), temporary: null },
    interpreters: { node: process.execPath },
    grants
  };
  const [built] = bridge.definitionsFor(plugin, api);
  assert.match((await built.handler({ root })).stdout, /store/);
  grants.withdraw('storage');
  assert.equal((await built.handler({ root })).stdout, 'none',
    'the path is gone from the child environment, not merely unused');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a tool whose approval waiver is withdrawn refuses rather than running unasked', async () => {
  // approvalEligible lives in the frozen descriptor, so a tool defined as waived
  // cannot start asking mid-session. Withdrawing the waiver plainly means "ask me
  // again"; continuing not to ask is the widest reading of that.
  const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-waiver-'));
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools/reindex.js'), 'process.stdout.write("ran");\n');
  const grants = fakeGrants(['subprocess'], { waived: true });
  const plugin = {
    identity: packageIdentity(root),
    manifest: { name: 'notes', displayName: 'Notes', provides: { tools: [TOOL] } },
    capabilities: ['subprocess'],
    paths: { workspace: root, storage: path.join(root, 'store'), temporary: null },
    interpreters: { node: process.execPath },
    grants
  };
  const [built] = bridge.definitionsFor(plugin, api);
  assert.equal(built.options.approvalEligible, false, 'defined as waived, so it will not ask');
  assert.match((await built.handler({ root })).stdout, /ran/);
  grants.withdrawWaiver();
  await assert.rejects(() => built.handler({ root }), (error) => {
    assert.equal(error.code, 'PLUGIN_APPROVAL_WAIVER_WITHDRAWN');
    assert.match(error.message, /Restart to have it ask again/);
    return true;
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('a grant store that cannot be read is not permission', async () => {
  const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
  const plugin = {
    identity: { id: 'plugin-abc', sha256: 'a'.repeat(64), root: '/srv/pkg' },
    manifest: { name: 'notes', displayName: 'Notes', provides: { tools: [TOOL] } },
    capabilities: ['subprocess'],
    paths: { workspace: '/srv/ws', storage: '/srv/store', temporary: null },
    interpreters: { node: process.execPath },
    grants: {
      capabilitiesFor: () => { const e = new Error('store gone'); e.code = 'PLUGIN_GRANT_CORRUPT'; throw e; },
      approvalWaived: () => false
    }
  };
  const [built] = bridge.definitionsFor(plugin, api);
  await assert.rejects(() => built.handler({ root: '/srv/ws' }), (error) => {
    assert.equal(error.code, 'PLUGIN_CAPABILITY_UNREADABLE');
    return true;
  });
});

test('definitionsFor refuses a grant store missing the methods dispatch needs', () => {
  assert.throws(() => bridge.definitionsFor({
    identity: { id: 'plugin-abc', sha256: 'a'.repeat(64), root: '/srv/pkg' },
    manifest: { name: 'notes', displayName: 'Notes', provides: { tools: [TOOL] } },
    capabilities: ['subprocess'],
    paths: { workspace: null, storage: '/srv/store', temporary: null },
    interpreters: {},
    grants: { approvalWaived: () => false }
  }, { define: () => ({}) }), /capabilitiesFor/);
});

/* WHAT A TOOL LOADS WITHOUT NAMING IT IS PART OF WHAT WAS ALLOWED (1.0.50 release
 * review F2). The review's probe: a node tool requiring a dependency from its own
 * node_modules ran a changed copy of that dependency under the old grant, because
 * node_modules was left out of the digest. Both tests below were red before the
 * fix -- the second call ran 'dep-v2', and the Python run left a __pycache__
 * beside its script -- and green after. */
test('a dependency changed after the plugin was allowed is refused, like a changed script', async () => {
  const root = fixturePlugin();
  try {
    fs.mkdirSync(path.join(root, 'pkg', 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pkg', 'node_modules', 'dep', 'index.js'), 'module.exports = "dep-v1";\n');
    fs.writeFileSync(path.join(root, 'pkg', 'tools', 'uses-dep.js'), 'process.stdout.write(require("dep"));\n');
    const tool = parseManifest(JSON.stringify({
      schemaVersion: 1, name: 'fixture', displayName: 'Fixture', summary: 'Uses a dependency.',
      requires: ['subprocess'],
      provides: { tools: [{ name: 'uses_dep', summary: 'Print the dependency.', effect: 'local-read',
        run: { interpreter: 'node', script: 'tools/uses-dep.js' }, params: [] }] }
    })).provides.tools[0];
    const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
    const [built] = bridge.definitionsFor(childPlugin(root, tool), api);
    assert.equal((await built.handler({})).stdout, 'dep-v1');
    fs.writeFileSync(path.join(root, 'pkg', 'node_modules', 'dep', 'index.js'), 'module.exports = "dep-v2";\n');
    await assert.rejects(built.handler({}), (error) => {
      assert.equal(error.code, 'PLUGIN_CHANGED_SINCE_ALLOWED', 'the changed dependency must not run under the old grant');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Python tool leaves no bytecode cache in its package, so running it does not change it',
  { skip: (process.platform !== 'linux' || !fs.existsSync('/usr/bin/python3')) && 'needs /usr/bin/python3' }, async () => {
    const root = fixturePlugin();
    try {
      fs.writeFileSync(path.join(root, 'pkg', 'tools', 'helper.py'), 'VALUE = "from-helper"\n');
      fs.writeFileSync(path.join(root, 'pkg', 'tools', 'main.py'), 'import helper\nprint(helper.VALUE, end="")\n');
      const tool = parseManifest(JSON.stringify({
        schemaVersion: 1, name: 'fixture', displayName: 'Fixture', summary: 'Imports a sibling module.',
        requires: ['subprocess'],
        provides: { tools: [{ name: 'main', summary: 'Print the helper value.', effect: 'local-read',
          run: { interpreter: 'python3', script: 'tools/main.py' }, params: [] }] }
      })).provides.tools[0];
      const plugin = childPlugin(root, tool);
      plugin.interpreters = { python3: '/usr/bin/python3' };
      const api = { define: (name, description, schema, handler, options) => ({ name, handler, options }) };
      const [built] = bridge.definitionsFor(plugin, api);
      assert.equal((await built.handler({})).stdout, 'from-helper');
      assert.equal(fs.existsSync(path.join(root, 'pkg', 'tools', '__pycache__')), false,
        'the first run wrote a cache into the package, which now changes its identity');
      assert.equal((await built.handler({})).stdout, 'from-helper', 'and the second call still runs');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
