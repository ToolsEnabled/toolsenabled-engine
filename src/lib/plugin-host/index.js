'use strict';

// THE PLUGIN HOST. WHAT IT ADMITS, WHAT IT REFUSES, AND WHAT IT NEVER DOES.
//
// A plugin is a directory the owner downloaded and added themselves. There is no
// marketplace, no publisher, no signature and no name registry -- the owner's
// decision, and the right one for a product with no partners yet. So the host's
// whole job is to make what a plugin can do small enough for one person to hold
// in their head, and to make the refusals say which sentence of that description
// was violated.
//
// THREE THINGS THE HOST NEVER DOES. Each is a seam that a plugin system usually
// opens, and each is closed by construction here rather than by review.
//
// 1. IT NEVER require()s PLUGIN CODE. A module loaded into this process runs with
//    the engine's entire authority -- vault, ledger, state store, every provider
//    -- and nothing afterwards can take that back. So a plugin's executable
//    surface is a subprocess it declared in its manifest, run through the same
//    define() as every core tool. manifest.js argues this at length; the test
//    suite asserts that no module under src/lib/plugin-host/ reaches outside
//    itself for a path a plugin controls.
//
// 2. IT NEVER INFERS A GRANT FROM CONTENTS. A package that ships roles does not
//    get the `roles` capability because it ships roles; it gets it when the owner
//    grants it, and until then those roles do not exist. grants.js is the whole
//    answer and its default is an empty list.
//
// 3. IT NEVER CARRIES A DECISION ACROSS A CHANGE OF BYTES. Identity is the
//    package's content digest, so a modified plugin is a different plugin with no
//    grants, and the owner sees the grant screen again for code they have not
//    reviewed. This is the one property that makes "we verify recognised plugins
//    and nothing else" a coherent policy rather than a hope.
//
// ORDERING, WHICH FAILS LOUD. Plugin tools reach the registry through
// src/lib/tool-pack-registry.js, and that module throws if a pack is registered
// after src/lib/tool-registry.js has been built, because TOOL_REGISTRY is frozen
// at module load. So registerActivatedPlugins() must run BEFORE the first
// require() of the tool registry. It is a real constraint and the failure is a
// sentence, not a missing tool.

const fs = require('node:fs');
const path = require('node:path');
const { packageIdentity, PluginIdentityError } = require('./identity');
const {
  parseManifest, PluginManifestError, MANIFEST_FILE, CAPABILITIES, INTERPRETERS,
  effectFloor, atLeast, SKIN_TOKENS
} = require('./manifest');
const { PluginGrantStore, PluginGrantError } = require('./grants');
const toolBridge = require('./tool-bridge');
const toolPacks = require('../tool-pack-registry');
const stateRootModule = require('../runtime-state-root');
const { MAX_PROJECTED_ROLE_ID } = require('../plugin-role-projection');
// The built-in roles. Two of them have a dash in their name (shadow-manager,
// coordinator-assistant), so `<plugin>-<role>` can produce one exactly.
const BUILT_IN_ROLE_IDS = new Set(require('../agent-org').ROLES);

// Where a plugin's own data lives, under the existing `state` runtime directory
// rather than a new top-level one: RUNTIME_STATE_DIRECTORIES is a closed
// vocabulary that the legacy-adoption copier also reads, and a plugin directory
// is not a reason to widen it.
const PLUGIN_DATA_SEGMENT = Object.freeze(['state', 'plugins']);
const PLUGIN_PACKAGES_SEGMENT = Object.freeze(['state', 'plugin-packages']);
// A plugin ROLE id is namespaced under the plugin's name so that a package can
// never name a default role or another plugin's. A plugin name is lowercase and
// dashes; a role id inside a plugin file is lowercase and underscores; so the '-'
// joiner cannot be produced by either half and the derivation is injective.
const PLUGIN_ROLE_ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const MAX_ROLE_TEXT = 6000;

// Absolute interpreter candidates, in order. A manifest names an interpreter and
// never a path (see manifest.js): resolving it here, from a list this repository
// controls, is what stops a package from shipping its own "python3".
const INTERPRETER_CANDIDATES = Object.freeze({
  python3: process.platform === 'win32'
    ? Object.freeze(['\x43:\\Windows\\py.exe'])
    : Object.freeze(['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3']),
  // The engine's own node, which is already running this process and is therefore
  // the one binary whose provenance needs no search at all.
  node: Object.freeze([process.execPath])
});

class PluginHostError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PluginHostError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new PluginHostError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function packagesRoot({ stateRoot = stateRootModule.stateRoot } = {}) {
  return path.join(stateRoot(), ...PLUGIN_PACKAGES_SEGMENT);
}

function dataRoot({ stateRoot = stateRootModule.stateRoot } = {}) {
  return path.join(stateRoot(), ...PLUGIN_DATA_SEGMENT);
}

function resolveInterpreter(name, { fsImpl = fs } = {}) {
  if (!INTERPRETERS.includes(name)) {
    fail('PLUGIN_INTERPRETER_UNKNOWN', `"${name}" is not an interpreter this build offers.`, { interpreter: name });
  }
  for (const candidate of INTERPRETER_CANDIDATES[name]) {
    try { if (fsImpl.statSync(candidate).isFile()) return candidate; }
    catch { /* try the next one */ }
  }
  fail('PLUGIN_INTERPRETER_MISSING',
    `This plugin needs ${name}, and none of the places this build looks for it has it `
    + `(${INTERPRETER_CANDIDATES[name].join(', ')}). Install it, or use a plugin that does not need it. `
    + 'The host does not search PATH for an interpreter, and it will not run one a package supplied.',
    { interpreter: name, looked: INTERPRETER_CANDIDATES[name] });
}

// IDENTITY AND MANIFEST, WITH NO SIDE EFFECTS AND NO GRANT CONSULTED.
//
// This is what the owner's approval screen is drawn from, so it must be safe to
// run against a package nobody has decided about yet. It reads, hashes and
// validates; it creates no directory, registers no tool and starts no process.
function inspect(directory, { fsImpl = fs } = {}) {
  const identity = packageIdentity(directory, { fsImpl });
  const manifestPath = path.join(identity.root, MANIFEST_FILE);
  let source;
  try { source = fsImpl.readFileSync(manifestPath, 'utf8'); }
  catch (error) {
    fail('PLUGIN_MANIFEST_MISSING',
      `${identity.root} has no ${MANIFEST_FILE}. A plugin is a directory with a ${MANIFEST_FILE} at its top level.`,
      { cause: error && error.code });
  }
  const manifest = parseManifest(source, { where: `${packageLabel(identity)}/${MANIFEST_FILE}` });

  // Every path the manifest points at must exist NOW, while the owner is
  // deciding. A manifest naming a script that is not there is a manifest
  // describing something other than this package, and finding that out at first
  // use -- after the grant -- is finding it out too late.
  const declared = [
    ...(manifest.provides.roles || []),
    ...(manifest.provides.tools || []).map(tool => tool.run.script),
    ...(manifest.provides.settings ? [manifest.provides.settings] : []),
    ...(manifest.provides.restrictions ? [manifest.provides.restrictions] : [])
  ];
  const present = new Set(identity.inventory.map(entry => entry.path));
  const absent = declared.filter(entry => !present.has(entry));
  if (absent.length) {
    fail('PLUGIN_DECLARED_FILE_MISSING',
      `${MANIFEST_FILE} names ${absent.length === 1 ? 'a file' : 'files'} this package does not contain: `
      + `${absent.join(', ')}. Every path a manifest declares is checked here, before any decision, because a `
      + 'manifest that describes files it does not ship is describing a different package.',
      { absent });
  }
  return Object.freeze({ identity, manifest });
}

function packageLabel(identity) {
  return path.basename(identity.root);
}

// The capabilities in force: what the owner granted, intersected with what the
// manifest asked for. The intersection is not belt-and-braces -- a grant written
// against an older version of a manifest that asked for more is a grant whose
// extra entries nobody reviewed against THIS package, and the digest binding
// makes that case rare rather than impossible only because a manifest is part of
// the digest. It costs one line, so it is here.
function capabilitiesInForce(identity, manifest, grants) {
  const granted = new Set(grants.capabilitiesFor(identity.sha256));
  const asked = new Set(manifest.requires);
  return Object.freeze(CAPABILITIES.filter(capability => granted.has(capability) && asked.has(capability)));
}

// Prepares the plugin's own directories. Created only for capabilities actually
// in force, so a plugin with no storage grant has no storage directory to find.
function preparePaths(identity, capabilities, { fsImpl = fs, stateRoot = stateRootModule.stateRoot } = {}) {
  const base = path.join(dataRoot({ stateRoot }), identity.id);
  const options = { recursive: true, ...(process.platform === 'linux' ? { mode: 0o700 } : {}) };
  const made = {};
  const ensure = (name) => {
    const target = path.join(base, name);
    fsImpl.mkdirSync(target, options);
    return target;
  };
  // A workspace exists whenever the plugin may run anything: it is the child's
  // cwd and HOME, and the only root a `path` parameter may resolve inside.
  made.workspace = capabilities.includes('subprocess') ? ensure('workspace') : null;
  made.storage = capabilities.includes('storage') ? ensure('storage') : null;
  made.temporary = capabilities.includes('subprocess') ? ensure('tmp') : null;
  return Object.freeze(made);
}

// ACTIVATION. Turns an inspected package plus the owner's grants into the thing
// the rest of the engine consumes. Refuses rather than degrading: a plugin that
// asked for `subprocess`, was granted it, and whose interpreter is missing is a
// plugin that does not activate, because activating it would mean advertising
// tools that cannot run.
function activate(directory, {
  grants = new PluginGrantStore(),
  fsImpl = fs,
  stateRoot = stateRootModule.stateRoot
} = {}) {
  const { identity, manifest } = inspect(directory, { fsImpl });
  const capabilities = capabilitiesInForce(identity, manifest, grants);
  if (!capabilities.length) {
    fail('PLUGIN_NOT_GRANTED',
      `${manifest.displayName} has not been granted anything, so there is nothing to activate. It asked for: `
      + `${manifest.requires.join(', ')}. Nothing is granted by installing a plugin; open its entry in Settings `
      + 'and decide each capability.',
      { plugin: manifest.name, id: identity.id, requested: manifest.requires });
  }
  const interpreters = {};
  if (capabilities.includes('subprocess')) {
    for (const tool of manifest.provides.tools || []) {
      if (!interpreters[tool.run.interpreter]) {
        interpreters[tool.run.interpreter] = resolveInterpreter(tool.run.interpreter, { fsImpl });
      }
    }
  }
  const paths = preparePaths(identity, capabilities, { fsImpl, stateRoot });
  return Object.freeze({
    identity,
    manifest,
    capabilities,
    // The floor every one of this plugin's tool effects is raised to, published
    // so the owner's screen can say "everything this plugin does counts as at
    // least X" without recomputing it.
    effectFloor: effectFloor(capabilities),
    interpreters: Object.freeze(interpreters),
    paths,
    grants
  });
}

// --- WHAT AN ACTIVATED PLUGIN CONTRIBUTES -----------------------------------
//
// Each of these returns EMPTY when the matching capability is not in force. Not
// an error: the plugin is running, it simply does not have that. A caller that
// wants to know why asks the plugin's capability list.

function toolPackFor(plugin) {
  if (!plain(plugin) || !plain(plugin.manifest)) {
    fail('PLUGIN_HOST_INVALID', 'toolPackFor(plugin) needs an activated plugin.');
  }
  return Object.freeze({
    // THE PACK NAME CARRIES THE WHOLE DIGEST, AND THE FIRST VERSION OF THIS LINE
    // TRUNCATED IT TO 12 HEX CHARACTERS.
    //
    // The comment here claimed that two versions of one plugin are two packs and
    // that registering both is "a loud duplicate rather than a silent
    // last-one-wins". That claim was FALSE as written:
    // src/lib/tool-pack-registry.js keeps packs in a Map keyed by name, so two
    // names that agree overwrite silently, and 12 hex characters is 48 bits -- a
    // birthday bound around 2^24. Improbable is not the same as impossible, and a
    // comment that describes a guarantee the code does not give is worse than no
    // comment.
    //
    // The whole digest costs 52 more characters in a string nobody reads and makes
    // the sentence true. It was found by scanning this repository's own source for
    // identity derivations that truncate or concatenate without a delimiter, which is
    // the only reason anybody looked at a line that read as harmless.
    name: `plugin-${plugin.manifest.name}-${plugin.identity.sha256}`,
    definitions: (api) => (
      plugin.capabilities.includes('subprocess') ? toolBridge.definitionsFor(plugin, api) : []
    )
  });
}

// MUST RUN BEFORE THE FIRST require() OF src/lib/tool-registry.js. See the
// ordering note at the top of this file and the argument in tool-pack-registry.js.
function registerActivatedPlugins(plugins) {
  const registered = [];
  for (const plugin of plugins) {
    if (!plugin.capabilities.includes('subprocess')) continue;
    toolPacks.registerToolPack(toolPackFor(plugin));
    registered.push(plugin.identity.id);
  }
  return Object.freeze(registered);
}

function roleText(value, field) {
  if (typeof value !== 'string' || !value || value.length > MAX_ROLE_TEXT || value !== value.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail('PLUGIN_ROLE_INVALID',
      `${field} must be trimmed readable text of at most ${MAX_ROLE_TEXT} characters.`, { field });
  }
  return value;
}

// A plugin's roles, in the shape src/lib/custom-role-store.js createCustomRole()
// takes. The id is namespaced with the plugin's name, so a package cannot name a
// default role, shadow another plugin's, or have its role outlive a rename.
function rolesFor(plugin, { fsImpl = fs } = {}) {
  if (!plugin.capabilities.includes('roles')) return Object.freeze([]);
  const out = [];
  const seen = new Set();
  for (const relative of plugin.manifest.provides.roles || []) {
    const file = path.join(plugin.identity.root, relative);
    let value;
    try { value = JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
    catch (error) {
      fail('PLUGIN_ROLE_UNREADABLE', `${relative} is not readable JSON: ${error && error.message}.`, { file: relative });
    }
    if (!plain(value)) fail('PLUGIN_ROLE_INVALID', `${relative} must hold one role object.`, { file: relative });
    const allowed = new Set(['id', 'displayName', 'summary', 'owns', 'mustNot', 'handoff']);
    const unknown = Object.keys(value).filter(key => !allowed.has(key));
    if (unknown.length) {
      fail('PLUGIN_ROLE_UNKNOWN_FIELD',
        `${relative} has ${unknown.join(', ')}, which a plugin role file does not carry. A role file states who `
        + 'the role is, what it owns, what it must not do, and who it hands off to. Anything else -- a capability, '
        + 'a function policy, an authorization flag -- is a decision the product makes, not the plugin.',
        { file: relative, unknown });
    }
    for (const key of ['id', 'owns', 'mustNot', 'handoff']) {
      if (!Object.hasOwn(value, key)) {
        fail('PLUGIN_ROLE_INVALID', `${relative} is missing ${key}.`, { file: relative, field: key });
      }
    }
    if (typeof value.id !== 'string' || !PLUGIN_ROLE_ID.test(value.id)) {
      fail('PLUGIN_ROLE_INVALID',
        `${relative} id must be lowercase words joined by underscores.`, { file: relative, field: 'id' });
    }
    if (seen.has(value.id)) {
      fail('PLUGIN_ROLE_INVALID', `This plugin declares the role ${value.id} twice.`, { file: relative, field: 'id' });
    }
    seen.add(value.id);
    // The whole id has to fit the role store's own limit, which is also the
    // projection's (src/lib/plugin-role-projection.js). Refused here, against the
    // file, so the Plugins page can name it before anything is allowed -- rather
    // than found at the next start, when the role would quietly not appear.
    const id = `${plugin.manifest.name}-${value.id}`;
    // A plugin named "coordinator" with a role "assistant" would be the built-in
    // "coordinator-assistant". The role library then hides the plugin's role behind
    // the built-in one, and the Plugins page counted it as added (1.0.50 release
    // review F14). Refused against the file instead, which is what the page's box
    // promises: a plugin's role can never be named like a built-in role.
    if (BUILT_IN_ROLE_IDS.has(id)) {
      fail('PLUGIN_ROLE_INVALID',
        `${relative} would be the role "${id}", which is the name of a built-in role. A plugin's role can never `
        + 'take a built-in role\'s name, so the plugin has to name this role differently.',
        { file: relative, field: 'id' });
    }
    if (id.length > MAX_PROJECTED_ROLE_ID) {
      fail('PLUGIN_ROLE_INVALID',
        `${relative} would be the role "${id}", which is longer than ${MAX_PROJECTED_ROLE_ID} characters. A plugin's `
        + 'role is named with the plugin\'s name, a dash and the role\'s own id, and the whole name has to fit.',
        { file: relative, field: 'id' });
    }
    out.push(Object.freeze({
      id,
      rules: Object.freeze({
        owns: roleText(value.owns, `${relative}.owns`),
        mustNot: roleText(value.mustNot, `${relative}.mustNot`),
        handoff: roleText(value.handoff, `${relative}.handoff`)
      })
    }));
  }
  return Object.freeze(out);
}

// The skin, as custom properties. Values were validated against a fixed
// vocabulary at manifest-parse time (manifest.js SKIN_TOKENS), so nothing a
// plugin wrote reaches a stylesheet as a selector, a url() or a position.
function skinFor(plugin) {
  if (!plugin.capabilities.includes('skin')) return Object.freeze({});
  const tokens = plugin.manifest.provides.skin || {};
  const out = {};
  for (const token of Object.keys(SKIN_TOKENS)) {
    if (!Object.hasOwn(tokens, token)) continue;
    out[`--plugin-${token.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`] = tokens[token];
  }
  return Object.freeze(out);
}

// A PLUGIN'S SETTINGS ROWS ARE A SURFACE OF THEIR OWN, NOT ENTRIES IN THE
// PRODUCT'S REGISTRY.
//
// config/settings-registry.json is a shipped file describing what THIS PRODUCT
// does, and its sections are a closed vocabulary about the product's own
// behaviour -- what may be sent out under the person's name, and so on. A plugin
// row does not belong in it, and a plugin that could add one could put its switch
// under a heading the person already trusts. So a plugin's rows are read here,
// validated, and handed back as a separate list for the app to render in the
// plugin's own area. Nothing in this path writes to the registry.
//
// EVERY ROW STATES ITS CAPABILITIES AND ITS RISKS, SEPARATELY. That is the
// product's own rule for its settings (settings-registry.js argues it at length:
// one blended sentence makes the reader do the separating), and it is required
// here rather than optional, because a plugin's switch is the one the owner has
// least context for. A row may honestly say there is no risk; it may not omit the
// field.
const PLUGIN_SETTING_KEY = /^[a-z][a-z0-9_]*$/;
const PLUGIN_SETTING_CONTROLS = Object.freeze(['toggle', 'select', 'number', 'text']);
const MAX_SETTING_ROWS = 24;
const MAX_SETTING_TEXT = 1200;

function settingText(value, field, maximum = MAX_SETTING_TEXT) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail('PLUGIN_SETTING_INVALID',
      `${field} must be readable text of at most ${maximum} characters.`, { field });
  }
  return value.trim();
}

function settingStatements(value, field) {
  if (!Array.isArray(value) || !value.length) {
    fail('PLUGIN_SETTING_INVALID',
      `${field} must be a non-empty array of plain statements. A row that states no ${field.split('.').pop()} `
      + 'is a row the owner has to work out for themselves, which is the work the product is supposed to have '
      + 'done. Saying there is none is allowed; leaving it out is not.',
      { field });
  }
  return Object.freeze(value.map((entry, index) => settingText(entry, `${field}[${index}]`)));
}

function settingsFor(plugin, { fsImpl = fs } = {}) {
  if (!plugin.capabilities.includes('settings')) return Object.freeze([]);
  const relative = plugin.manifest.provides.settings;
  if (!relative) return Object.freeze([]);
  const file = path.join(plugin.identity.root, relative);
  let value;
  try { value = JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
  catch (error) {
    fail('PLUGIN_SETTING_UNREADABLE', `${relative} is not readable JSON: ${error && error.message}.`, { file: relative });
  }
  if (!plain(value) || !Array.isArray(value.rows)) {
    fail('PLUGIN_SETTING_INVALID', `${relative} must be an object with a rows array.`, { file: relative });
  }
  if (value.rows.length > MAX_SETTING_ROWS) {
    fail('PLUGIN_SETTING_INVALID', `${relative} may declare at most ${MAX_SETTING_ROWS} rows.`, { file: relative });
  }
  const unknownTop = Object.keys(value).filter(key => key !== 'rows' && key !== 'note');
  if (unknownTop.length) {
    fail('PLUGIN_SETTING_UNKNOWN_FIELD', `${relative} has ${unknownTop.join(', ')}, which a settings file does not carry.`,
      { file: relative, unknown: unknownTop });
  }
  const seen = new Set();
  const rows = value.rows.map((row, index) => {
    const where = `${relative}.rows[${index}]`;
    const allowed = new Set(['key', 'label', 'control', 'default', 'consequence', 'capabilities', 'risks', 'options', 'minimum', 'maximum', 'unit']);
    const unknown = Object.keys(row || {}).filter(key => !allowed.has(key));
    if (unknown.length) {
      fail('PLUGIN_SETTING_UNKNOWN_FIELD',
        `${where} has ${unknown.join(', ')}. In particular a plugin row cannot name a section, a depth, an `
        + '`enforcedBy` or a `derivedFrom`: those say where a setting sits in the product\'s own account of '
        + 'itself, and a plugin does not get to place its switch under a heading the person already trusts.',
        { field: where, unknown });
    }
    if (!plain(row)) fail('PLUGIN_SETTING_INVALID', `${where} must be an object.`, { field: where });
    const key = row.key;
    if (typeof key !== 'string' || !PLUGIN_SETTING_KEY.test(key)) {
      fail('PLUGIN_SETTING_INVALID', `${where}.key must be a lowercase word, optionally with underscores.`, { field: `${where}.key` });
    }
    if (seen.has(key)) fail('PLUGIN_SETTING_INVALID', `${relative} declares ${key} twice.`, { field: `${where}.key` });
    seen.add(key);
    if (!PLUGIN_SETTING_CONTROLS.includes(row.control)) {
      fail('PLUGIN_SETTING_INVALID',
        `${where}.control must be one of ${PLUGIN_SETTING_CONTROLS.join(', ')}; got ${JSON.stringify(row.control)}. `
        + 'The product\'s other control classes describe values it maintains or discovers at run time, which is '
        + 'not something a plugin manifest can declare.',
        { field: `${where}.control` });
    }
    if (!Object.hasOwn(row, 'default')) {
      fail('PLUGIN_SETTING_INVALID', `${where} needs a default.`, { field: `${where}.default` });
    }
    let options;
    if (row.control === 'select') {
      if (!Array.isArray(row.options) || row.options.length < 2) {
        fail('PLUGIN_SETTING_INVALID', `${where} is a select and needs at least two options.`, { field: `${where}.options` });
      }
      options = Object.freeze(row.options.map((entry, at) => settingText(entry, `${where}.options[${at}]`, 120)));
      if (!options.includes(row.default)) {
        fail('PLUGIN_SETTING_INVALID', `${where}.default is not one of its own options.`, { field: `${where}.default` });
      }
    } else if (Object.hasOwn(row, 'options')) {
      fail('PLUGIN_SETTING_INVALID', `${where} is not a select, so it declares no options.`, { field: `${where}.options` });
    }
    if (row.control === 'toggle' && typeof row.default !== 'boolean') {
      fail('PLUGIN_SETTING_INVALID', `${where} is a toggle, so its default must be true or false.`, { field: `${where}.default` });
    }
    if (row.control === 'number' && (typeof row.default !== 'number' || !Number.isFinite(row.default))) {
      fail('PLUGIN_SETTING_INVALID', `${where} is a number, so its default must be one.`, { field: `${where}.default` });
    }
    return Object.freeze({
      // Namespaced, and injective: a plugin name carries no dot and a key carries
      // neither a dot nor a dash, so neither boundary in this id can move.
      id: `plugin.${plugin.manifest.name.replaceAll('-', '_')}.${key}`,
      key,
      label: settingText(row.label === undefined ? key : row.label, `${where}.label`, 120),
      control: row.control,
      default: row.default,
      consequence: settingText(row.consequence, `${where}.consequence`),
      capabilities: settingStatements(row.capabilities, `${where}.capabilities`),
      risks: settingStatements(row.risks, `${where}.risks`),
      ...(options ? { options } : {}),
      ...(Object.hasOwn(row, 'minimum') ? { minimum: row.minimum } : {}),
      ...(Object.hasOwn(row, 'maximum') ? { maximum: row.maximum } : {}),
      ...(Object.hasOwn(row, 'unit') ? { unit: settingText(row.unit, `${where}.unit`, 32) } : {})
    });
  });
  return Object.freeze(rows);
}

// A plugin's restrictions file. It may only ever NARROW: the shape permits a
// deny-by-default tool surface and a list of things that always need a human, and
// it has no field that widens anything. A plugin asking for MORE tool surface than
// it was granted would be asking the wrong component -- what it may reach is
// decided by its grants and by the engine's own confined surface, not by a file it
// ships. So this is read as the plugin's own self-imposed floor, and it is shown
// to the owner as such.
function restrictionsFor(plugin, { fsImpl = fs } = {}) {
  if (!plugin.capabilities.includes('settings')) return null;
  const relative = plugin.manifest.provides.restrictions;
  if (!relative) return null;
  const file = path.join(plugin.identity.root, relative);
  let value;
  try { value = JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
  catch (error) {
    fail('PLUGIN_RESTRICTION_UNREADABLE', `${relative} is not readable JSON: ${error && error.message}.`, { file: relative });
  }
  if (!plain(value)) fail('PLUGIN_RESTRICTION_INVALID', `${relative} must be an object.`, { file: relative });
  const allowed = new Set(['note', 'hardBlocks', 'requiresHumanApproval']);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) {
    fail('PLUGIN_RESTRICTION_UNKNOWN_FIELD',
      `${relative} has ${unknown.join(', ')}. A restrictions file may only narrow, so it carries no tool surface `
      + 'and no egress allowlist: what this plugin may reach is decided by the capabilities the owner granted and '
      + 'by the engine\'s own confined surface, never by a file the plugin ships. State a hard block or a thing '
      + 'that always needs a person, and nothing else.',
      { file: relative, unknown });
  }
  const blocks = Array.isArray(value.hardBlocks) ? value.hardBlocks : [];
  const approvals = Array.isArray(value.requiresHumanApproval) ? value.requiresHumanApproval : [];
  return Object.freeze({
    note: value.note === undefined ? null : settingText(value.note, `${relative}.note`),
    hardBlocks: Object.freeze(blocks.map((entry, index) => {
      const where = `${relative}.hardBlocks[${index}]`;
      if (!plain(entry) || Object.keys(entry).some(key => key !== 'rule' && key !== 'why')) {
        fail('PLUGIN_RESTRICTION_INVALID', `${where} must be { rule, why }.`, { field: where });
      }
      return Object.freeze({
        rule: settingText(entry.rule, `${where}.rule`, 200),
        why: settingText(entry.why, `${where}.why`)
      });
    })),
    requiresHumanApproval: Object.freeze(approvals.map((entry, index) =>
      settingText(entry, `${relative}.requiresHumanApproval[${index}]`, 200)))
  });
}

// What the owner's screen shows, for one package, whether or not it is activated.
// Deliberately includes the DIFFERENCE between what was asked and what is in
// force: "this plugin asked for the network and does not have it" is the sentence
// a person needs, and it is not derivable from either list alone.
function describe(directory, { grants = new PluginGrantStore(), fsImpl = fs } = {}) {
  const { identity, manifest } = inspect(directory, { fsImpl });
  const granted = grants.capabilitiesFor(identity.sha256);
  const record = grants.record(identity.sha256);
  const inForce = capabilitiesInForce(identity, manifest, grants);
  return Object.freeze({
    id: identity.id,
    sha256: identity.sha256,
    root: identity.root,
    fileCount: identity.fileCount,
    name: manifest.name,
    displayName: manifest.displayName,
    summary: manifest.summary,
    requested: manifest.requires,
    granted,
    inForce,
    withheld: Object.freeze(manifest.requires.filter(capability => !granted.includes(capability))),
    effectFloor: effectFloor(inForce),
    tools: Object.freeze((manifest.provides.tools || []).map(tool => Object.freeze({
      name: toolBridge.toolNameFor(manifest.name, tool.name),
      summary: tool.summary,
      declaredEffect: tool.effect,
      effect: atLeast(tool.effect, effectFloor(inForce)),
      approvalRequested: tool.approvalRequested,
      approvalWaived: inForce.length
        ? grants.approvalWaived(identity.sha256, tool.name, atLeast(tool.effect, effectFloor(inForce)))
        : false
    }))),
    roleCount: (manifest.provides.roles || []).length,
    // Whether rows are DECLARED, not how many are valid: counting them means
    // reading and validating the file, and describe() is what the owner's screen
    // is drawn from for a package nobody has decided about yet. settingsFor() on
    // an activated plugin is where the rows are actually read.
    declaresSettings: Boolean(manifest.provides.settings),
    declaresRestrictions: Boolean(manifest.provides.restrictions),
    hasSkin: Boolean(manifest.provides.skin),
    grantedAt: record ? record.grantedAt : null,
    grantedBy: record ? record.grantedBy : null,
    revoked: record && record.revoked ? Object.freeze({ ...record.revoked }) : null
  });
}

// WHAT A PACKAGE CONTRIBUTES, READ WITHOUT ACTIVATING IT.
//
// WHY THIS EXISTS SEPARATELY FROM activate(). The app's consent screen runs in the
// shell process; activation runs in the engine's. The screen needs to show the
// settings rows and the colours a package contributes, and it must not activate
// anything to do it -- activation prepares directories, resolves interpreters and
// registers tool packs, none of which is a screen's business and the last of which
// would throw in a process whose tool registry is already built.
//
// Everything below needs only the manifest, the package root and the capabilities
// in force. So this reads, validates, and returns; it creates nothing and
// registers nothing. A contribution whose file is malformed is reported as a
// refusal beside the others rather than taking the whole package down, because a
// typo in a rows file should not cost somebody their plugin's tools.
function contributions(directory, { grants = new PluginGrantStore(), fsImpl = fs } = {}) {
  const { identity, manifest } = inspect(directory, { fsImpl });
  const capabilities = capabilitiesInForce(identity, manifest, grants);
  // The shape activate() produces, minus the parts only a running engine needs.
  // rolesFor/settingsFor/skinFor read exactly these three fields and nothing else,
  // which is what makes this safe rather than a second implementation.
  const readOnly = Object.freeze({ identity, manifest, capabilities });
  const refused = [];
  const read = (what, work) => {
    try { return work(); }
    catch (error) {
      refused.push(Object.freeze({
        what,
        code: error && error.code ? String(error.code) : 'PLUGIN_CONTRIBUTION_INVALID',
        message: error && error.message ? String(error.message) : String(error)
      }));
      return null;
    }
  };
  return Object.freeze({
    id: identity.id,
    sha256: identity.sha256,
    name: manifest.name,
    capabilities,
    roles: Object.freeze((read('roles', () => rolesFor(readOnly, { fsImpl })) || []).map(role => Object.freeze({
      id: role.id,
      // The wording is deliberately NOT returned to a window. A role's three texts
      // are long, they are a stranger's prose, and a screen that wanted to show
      // them would be a second place they have to be escaped. The id and the count
      // are what a consent screen needs.
      plugin: manifest.name
    }))),
    settings: Object.freeze(read('settings', () => settingsFor(readOnly, { fsImpl })) || []),
    restrictions: read('restrictions', () => restrictionsFor(readOnly, { fsImpl })),
    skin: Object.freeze(read('skin', () => skinFor(readOnly)) || {}),
    refused: Object.freeze(refused)
  });
}

// Every package the owner has added. A directory that fails to inspect is
// REPORTED, not skipped: a plugin that silently vanishes from this list because
// its manifest has a typo is a plugin the owner thinks is running.
//
// A MISSING FOLDER IS "NO PLUGINS"; AN UNREADABLE ONE IS NOT (1.0.50 release review
// F13). Every readdir error used to be an empty listing, so a folder that could not
// be read, or a file with the folder's name, was drawn as "No plugins added". Only
// ENOENT is empty now; anything else is refused with the folder and the reason. And
// the page names this folder as where a plugin goes, so `create` (the page's read)
// makes it, private to this user, when it is missing. Activation never creates it:
// with no plugin, starting the engine writes nothing.
function listPackages({ root = null, fsImpl = fs, stateRoot = stateRootModule.stateRoot, grants = new PluginGrantStore(), create = false } = {}) {
  const base = root || packagesRoot({ stateRoot });
  let entries;
  try { entries = fsImpl.readdirSync(base, { withFileTypes: true }); }
  catch (error) {
    if (!error || error.code !== 'ENOENT') {
      fail('PLUGIN_PACKAGES_UNREADABLE',
        `The plugin folder ${base} could not be read (${error && error.code ? error.code : 'unknown'}). Plugins are `
        + 'read from that folder, so none can be listed until it is a folder this account can open.',
        { root: base, cause: error && error.code });
    }
    if (create) {
      try { fsImpl.mkdirSync(base, { recursive: true, ...(process.platform === 'win32' ? {} : { mode: 0o700 }) }); }
      catch { /* the listing is still empty; the page names the folder either way */ }
    }
    return Object.freeze({ root: base, packages: Object.freeze([]), refused: Object.freeze([]) });
  }
  const packages = [];
  const refused = [];
  for (const entry of entries.slice().sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = path.join(base, entry.name);
    try { packages.push(describe(directory, { grants, fsImpl })); }
    catch (error) {
      refused.push(Object.freeze({
        directory: entry.name,
        code: error && error.code ? error.code : 'PLUGIN_UNREADABLE',
        message: error && error.message ? error.message : String(error)
      }));
    }
  }
  return Object.freeze({ root: base, packages: Object.freeze(packages), refused: Object.freeze(refused) });
}

module.exports = Object.freeze({
  PluginHostError,
  PluginIdentityError,
  PluginManifestError,
  PluginGrantError,
  PluginGrantStore,
  inspect,
  describe,
  activate,
  listPackages,
  capabilitiesInForce,
  preparePaths,
  resolveInterpreter,
  toolPackFor,
  registerActivatedPlugins,
  rolesFor,
  skinFor,
  settingsFor,
  restrictionsFor,
  contributions,
  packagesRoot,
  dataRoot,
  INTERPRETER_CANDIDATES,
  PLUGIN_DATA_SEGMENT,
  PLUGIN_PACKAGES_SEGMENT,
  PLUGIN_ROLE_ID
});
