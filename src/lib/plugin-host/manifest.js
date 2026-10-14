'use strict';

// WHAT A PLUGIN IS ALLOWED TO SAY ABOUT ITSELF, AND WHAT SAYING IT DOES NOT BUY.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: UNCLASSIFIED IS A REFUSAL.
//
// An unknown field in a manifest is rejected, not ignored. This product has
// written down the cost of the opposite choice nine separate times under the
// name "absence read as consent": a guard that skips what it does not recognise
// is a guard that a later field walks straight past, and the walk looks like a
// pass. tools/check-payload-boundary.mjs states the same rule for tracked files
// ("UNCLASSIFIED IS A FAILURE, NOT A DEFAULT") and it is the same rule here.
//
// A MANIFEST IS A REQUEST, NOT A GRANT. Everything in `requires` is a thing the
// plugin is ASKING for. Nothing in this file gives it anything: grants.js holds
// what the owner actually agreed to, keyed by the package's content digest. A
// plugin that lists every capability in the vocabulary and is granted none runs
// with none, and every refusal it then meets names the capability it lacks.
//
// WHY THERE IS NO IN-PROCESS PLUGIN CODE.
//
// A plugin cannot ship a module the engine require()s. This is the single
// biggest decision in the host and it is deliberate: a require()d module runs
// with the engine's whole authority -- the vault, the ledger, the state store,
// every provider -- and no manifest field, signature or review can take that
// back afterwards. The owner's position on third-party plugins is that an
// insecure plugin is its author's problem; that is a fair position about the
// PLUGIN, and it stops being fair the moment the plugin's bug is indistinguishable
// from an engine bug because it ran as the engine.
//
// So a plugin's executable surface is declared, not linked: a tool names a
// script inside its own package and an interpreter from a fixed list, and the
// host runs it as a subprocess with the same effect classification, approval
// path and audit trail every core tool has. What a plugin can do is then bounded
// by what a subprocess can do, which is something the owner can reason about.
//
// WHY THE "SKIN" IS TOKENS AND NOT CSS.
//
// The ask was a custom UI skin. Free CSS from an unverified package, loaded into
// the renderer, is not a theme -- it is (a) an exfiltration channel, because
// `background: url(https://...)` on an attribute selector leaks the attribute,
// and (b) a spoofing channel, because it can reposition or hide any chrome the
// product uses to tell the person what is about to happen, including an approval
// prompt. Neither is a hypothetical; both are ordinary CSS.
//
// A bounded token set gets the visual result without either. A plugin names
// colours and a radius from a validated vocabulary, the host writes them into
// custom properties on its own surfaces, and there is no selector, no url() and
// no positioning for a plugin to write. If a plugin genuinely needs more than
// this, the answer is a product feature, not a hole.

const CAPABILITIES = Object.freeze([
  // A durable key/value namespace of its own. Cannot see another plugin's.
  'storage',
  // Named secrets under plugin/<id>/ only. Nothing else in the vault is reachable.
  'secrets',
  // May run the scripts it declares, as subprocesses.
  'subprocess',
  // Its subprocesses may reach the network. The host cannot enforce this from
  // inside the child, so this capability is a DISCLOSURE to the owner rather
  // than a fence -- and it is named that way wherever it is shown.
  'network',
  // May append audit events, under the action prefix plugin.<name>. only.
  'auditLog',
  // May install custom roles.
  'roles',
  // May declare settings rows.
  'settings',
  // May supply skin tokens.
  'skin'
]);

// The effect floor a granted capability puts under EVERY tool the plugin
// defines. A plugin cannot hold a network grant and describe its tools as
// local-read: the classification the rest of the engine reasons about would then
// be a claim by the plugin about itself. Ordered least to most consequential;
// index comparison is the whole rule.
const EFFECT_ORDER = Object.freeze(['local-read', 'local-write', 'external-read', 'external-write']);
const CAPABILITY_EFFECT_FLOOR = Object.freeze({
  storage: 'local-read',
  roles: 'local-read',
  settings: 'local-read',
  skin: 'local-read',
  auditLog: 'local-write',
  subprocess: 'local-write',
  secrets: 'external-write',
  network: 'external-read'
});

// Which capability each kind of `provides` entry needs. A plugin that provides
// roles without requiring 'roles' is refused rather than quietly granted the
// capability its own contents imply -- that inference is how a fence ends up on
// the wrong side of the thing it is fencing.
const PROVIDES_CAPABILITY = Object.freeze({
  roles: 'roles',
  tools: 'subprocess',
  settings: 'settings',
  restrictions: 'settings',
  skin: 'skin'
});

// The interpreter is chosen from this list by name; the manifest never names a
// path to an executable. A manifest-supplied path would let a package point at
// a binary it also shipped, which is in-process plugin code with extra steps.
const INTERPRETERS = Object.freeze(['python3', 'node']);

const PARAM_TYPES = Object.freeze(['string', 'integer', 'number', 'boolean', 'path']);

const SKIN_TOKENS = Object.freeze({
  accent: 'colour',
  accentText: 'colour',
  surface: 'colour',
  surfaceText: 'colour',
  border: 'colour',
  radius: 'length',
  badge: 'word'
});
const COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const LENGTH = /^(?:0|[1-9]\d{0,2})(?:px|rem)$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,23}$/;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_NAME = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const PARAM_NAME = /^[a-z][a-zA-Z0-9]{0,31}$/;
// A relative POSIX path inside the package. No leading slash, no drive letter,
// no '.' or '..' segment anywhere. Checked as a whole rather than by stripping,
// because "strip the bad part and keep going" is how a traversal survives a
// sanitiser.
const PACKAGE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SENTENCE = /^[^\r\n\t\0]{1,240}$/;
const MAX_TOOLS = 32;
const MAX_ROLES = 16;
const MAX_PARAMS = 12;
const SCHEMA_VERSION = 1;
const MANIFEST_FILE = 'plugin.json';

class PluginManifestError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PluginManifestError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new PluginManifestError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

// The closed-world check, used for every object in a manifest. `where` is the
// dotted path so a refusal can name the field and not just the file.
function onlyKeys(value, required, optional, where) {
  if (!plain(value)) {
    fail('PLUGIN_MANIFEST_INVALID', `${where} must be an object.`, { field: where });
  }
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) {
    fail('PLUGIN_MANIFEST_UNKNOWN_FIELD',
      `${where} has ${unknown.length === 1 ? 'a field' : 'fields'} this version does not understand: `
      + `${unknown.join(', ')}. An unrecognised field is refused rather than ignored, because a host that `
      + 'skips what it cannot read cannot tell you what it let through. Remove it, or use a build of '
      + 'ToolsEnabled that declares it.',
      { field: where, unknown });
  }
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (missing.length) {
    fail('PLUGIN_MANIFEST_INVALID', `${where} is missing: ${missing.join(', ')}.`, { field: where, missing });
  }
}

function text(value, where, pattern = SENTENCE) {
  if (typeof value !== 'string' || !pattern.test(value) || value !== value.trim()) {
    fail('PLUGIN_MANIFEST_INVALID',
      `${where} must be trimmed single-line text matching ${pattern}.`, { field: where });
  }
  return value;
}

function normalizeRequires(value) {
  if (!Array.isArray(value)) fail('PLUGIN_MANIFEST_INVALID', 'requires must be an array.', { field: 'requires' });
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || !CAPABILITIES.includes(entry)) {
      fail('PLUGIN_MANIFEST_UNKNOWN_CAPABILITY',
        `requires names ${JSON.stringify(entry)}, which is not a capability this build offers. `
        + `The whole vocabulary is: ${CAPABILITIES.join(', ')}.`,
        { field: 'requires', capability: entry });
    }
    if (seen.has(entry)) {
      fail('PLUGIN_MANIFEST_INVALID', `requires names ${entry} twice.`, { field: 'requires' });
    }
    seen.add(entry);
  }
  // Sorted so the owner's grant screen lists capabilities in one fixed order
  // whatever order the author typed them in.
  return Object.freeze(CAPABILITIES.filter(capability => seen.has(capability)));
}

function normalizeParam(value, where) {
  onlyKeys(value, ['name', 'type', 'description'], ['required', 'default'], where);
  const name = text(value.name, `${where}.name`, PARAM_NAME);
  if (!PARAM_TYPES.includes(value.type)) {
    fail('PLUGIN_MANIFEST_INVALID',
      `${where}.type must be one of ${PARAM_TYPES.join(', ')}; got ${JSON.stringify(value.type)}.`,
      { field: `${where}.type` });
  }
  const required = value.required === undefined ? true : value.required === true;
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    fail('PLUGIN_MANIFEST_INVALID', `${where}.required must be true or false.`, { field: `${where}.required` });
  }
  if (Object.hasOwn(value, 'default') && required) {
    fail('PLUGIN_MANIFEST_INVALID',
      `${where} is required and also carries a default. A required parameter has no default: the caller `
      + 'always supplies it. Mark it "required": false, or drop the default.',
      { field: where });
  }
  return Object.freeze({
    name,
    type: value.type,
    description: text(value.description, `${where}.description`),
    required,
    default: Object.hasOwn(value, 'default') ? value.default : undefined
  });
}

function normalizeTool(value, where) {
  onlyKeys(value, ['name', 'summary', 'effect', 'run', 'params'], ['approvalEligible'], where);
  const name = text(value.name, `${where}.name`, TOOL_NAME);
  if (!EFFECT_ORDER.includes(value.effect)) {
    fail('PLUGIN_MANIFEST_INVALID',
      `${where}.effect must be one of ${EFFECT_ORDER.join(', ')}; got ${JSON.stringify(value.effect)}. `
      + 'There is no default: a tool whose effect nobody declared is a tool nothing can classify.',
      { field: `${where}.effect` });
  }
  onlyKeys(value.run, ['interpreter', 'script'], ['args'], `${where}.run`);
  if (!INTERPRETERS.includes(value.run.interpreter)) {
    fail('PLUGIN_MANIFEST_INVALID',
      `${where}.run.interpreter must be one of ${INTERPRETERS.join(', ')}; got ${JSON.stringify(value.run.interpreter)}. `
      + 'A manifest names an interpreter, never a path to one: a path could point at a binary the package '
      + 'also shipped, which is the in-process plugin code this host does not offer.',
      { field: `${where}.run.interpreter` });
  }
  const script = text(value.run.script, `${where}.run.script`, PACKAGE_PATH);
  const args = value.run.args === undefined ? [] : value.run.args;
  if (!Array.isArray(args)) {
    fail('PLUGIN_MANIFEST_INVALID', `${where}.run.args must be an array of fixed strings.`, { field: `${where}.run.args` });
  }
  // Fixed arguments only. A parameter reaches the script through the typed
  // parameter list, one --name value pair per declared parameter, so a value the
  // caller supplied is never spliced into a template a plugin author wrote.
  const fixedArgs = args.map((entry, index) => {
    if (typeof entry !== 'string' || !/^[A-Za-z0-9=_.:/-]{1,64}$/.test(entry)) {
      fail('PLUGIN_MANIFEST_INVALID',
        `${where}.run.args[${index}] must be a short plain string. Caller values are not placed here: `
        + 'they are passed as --name value from the declared params, so nothing interpolates.',
        { field: `${where}.run.args[${index}]` });
    }
    return entry;
  });
  if (!Array.isArray(value.params) || value.params.length > MAX_PARAMS) {
    fail('PLUGIN_MANIFEST_INVALID',
      `${where}.params must be an array of at most ${MAX_PARAMS} parameters.`, { field: `${where}.params` });
  }
  const params = value.params.map((entry, index) => normalizeParam(entry, `${where}.params[${index}]`));
  const names = new Set();
  for (const param of params) {
    if (names.has(param.name)) {
      fail('PLUGIN_MANIFEST_INVALID', `${where}.params declares ${param.name} twice.`, { field: `${where}.params` });
    }
    names.add(param.name);
  }
  if (value.approvalEligible !== undefined && typeof value.approvalEligible !== 'boolean') {
    fail('PLUGIN_MANIFEST_INVALID', `${where}.approvalEligible must be true or false.`, { field: `${where}.approvalEligible` });
  }
  return Object.freeze({
    name,
    summary: text(value.summary, `${where}.summary`),
    effect: value.effect,
    run: Object.freeze({ interpreter: value.run.interpreter, script, args: Object.freeze(fixedArgs) }),
    params: Object.freeze(params),
    // A plugin may ask for its tool not to be approved each time, and that ask
    // is honoured only for a read-class tool. Whether it is honoured at all is
    // decided in grants.js against what the owner granted, not here.
    approvalRequested: value.approvalEligible === undefined ? true : value.approvalEligible
  });
}

function normalizeSkin(value, where) {
  onlyKeys(value, [], Object.keys(SKIN_TOKENS), where);
  const tokens = {};
  for (const [token, kind] of Object.entries(SKIN_TOKENS)) {
    if (!Object.hasOwn(value, token)) continue;
    const pattern = kind === 'colour' ? COLOUR : kind === 'length' ? LENGTH : WORD;
    if (typeof value[token] !== 'string' || !pattern.test(value[token])) {
      fail('PLUGIN_MANIFEST_INVALID',
        `${where}.${token} must be ${kind === 'colour' ? 'a #rgb or #rrggbb colour'
          : kind === 'length' ? 'a length in px or rem' : 'a short plain word'}; `
        + `got ${JSON.stringify(value[token])}. A skin is a fixed set of tokens, not CSS: there is no `
        + 'selector, url() or positioning for a plugin to write, so a skin cannot leak what it can see '
        + 'or move what the product uses to tell you what is about to happen.',
        { field: `${where}.${token}` });
    }
    tokens[token] = value[token];
  }
  return Object.freeze(tokens);
}

function normalizeProvides(value, requires) {
  onlyKeys(value, [], Object.keys(PROVIDES_CAPABILITY), 'provides');
  const provides = {};

  if (Object.hasOwn(value, 'roles')) {
    if (!Array.isArray(value.roles) || value.roles.length > MAX_ROLES) {
      fail('PLUGIN_MANIFEST_INVALID', `provides.roles must be an array of at most ${MAX_ROLES} paths.`, { field: 'provides.roles' });
    }
    provides.roles = Object.freeze(value.roles.map((entry, index) => text(entry, `provides.roles[${index}]`, PACKAGE_PATH)));
  }
  if (Object.hasOwn(value, 'tools')) {
    if (!Array.isArray(value.tools) || value.tools.length > MAX_TOOLS) {
      fail('PLUGIN_MANIFEST_INVALID', `provides.tools must be an array of at most ${MAX_TOOLS} tools.`, { field: 'provides.tools' });
    }
    const tools = value.tools.map((entry, index) => normalizeTool(entry, `provides.tools[${index}]`));
    const seen = new Set();
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        fail('PLUGIN_MANIFEST_INVALID', `provides.tools declares ${tool.name} twice.`, { field: 'provides.tools' });
      }
      seen.add(tool.name);
    }
    provides.tools = Object.freeze(tools);
  }
  if (Object.hasOwn(value, 'settings')) {
    provides.settings = text(value.settings, 'provides.settings', PACKAGE_PATH);
  }
  if (Object.hasOwn(value, 'restrictions')) {
    provides.restrictions = text(value.restrictions, 'provides.restrictions', PACKAGE_PATH);
  }
  if (Object.hasOwn(value, 'skin')) {
    provides.skin = normalizeSkin(value.skin, 'provides.skin');
  }

  // Coverage, both ways. Providing something needs the capability, and asking
  // for a capability the plugin does not use is refused too: an unused grant on
  // an owner's screen is a grant they will approve without reading, and the next
  // version of the package uses it.
  for (const [kind, capability] of Object.entries(PROVIDES_CAPABILITY)) {
    if (Object.hasOwn(provides, kind) && !requires.includes(capability)) {
      fail('PLUGIN_MANIFEST_CAPABILITY_NOT_REQUESTED',
        `This plugin provides ${kind} but does not list "${capability}" in requires. A plugin has to ask for `
        + 'what it needs by name. The host will not infer the capability from the contents, because an '
        + 'inferred grant is one the owner was never shown.',
        { field: `provides.${kind}`, capability });
    }
  }
  const used = new Set(Object.keys(provides).map(kind => PROVIDES_CAPABILITY[kind]));
  // These four are about how a tool behaves at run time rather than about a
  // `provides` entry, so their use cannot be read off the manifest's contents.
  for (const capability of ['storage', 'secrets', 'network', 'auditLog']) used.add(capability);
  const unused = requires.filter(capability => !used.has(capability));
  if (unused.length) {
    fail('PLUGIN_MANIFEST_CAPABILITY_UNUSED',
      `requires names ${unused.join(', ')}, but this plugin provides nothing that uses `
      + `${unused.length === 1 ? 'it' : 'them'}. Drop the request. A capability on the approval screen that `
      + 'the plugin does not use teaches the owner to approve without reading.',
      { field: 'requires', unused });
  }
  return Object.freeze(provides);
}

// The floor every tool's effect is raised to, given a set of capabilities.
function effectFloor(capabilities) {
  let floor = 0;
  for (const capability of capabilities) {
    const index = EFFECT_ORDER.indexOf(CAPABILITY_EFFECT_FLOOR[capability]);
    if (index > floor) floor = index;
  }
  return EFFECT_ORDER[floor];
}

function atLeast(effect, floor) {
  return EFFECT_ORDER[Math.max(EFFECT_ORDER.indexOf(effect), EFFECT_ORDER.indexOf(floor))];
}

// Parses manifest TEXT. Kept separate from any disk read so a suite can drive
// every refusal without a fixture directory, and so the caller decides where the
// bytes came from.
function parseManifest(source, { where = MANIFEST_FILE } = {}) {
  let value;
  try { value = JSON.parse(source); }
  catch (error) {
    fail('PLUGIN_MANIFEST_UNPARSEABLE',
      `${where} is not valid JSON: ${error && error.message}.`, { field: where });
  }
  onlyKeys(value, ['schemaVersion', 'name', 'displayName', 'summary', 'requires', 'provides'], [], where);
  if (value.schemaVersion !== SCHEMA_VERSION) {
    fail('PLUGIN_MANIFEST_VERSION',
      `${where} declares schemaVersion ${JSON.stringify(value.schemaVersion)}; this build reads ${SCHEMA_VERSION}. `
      + 'A manifest from a newer build is refused rather than read as far as it parses, because the fields '
      + 'this build would skip are exactly the ones it cannot tell you about.',
      { field: 'schemaVersion' });
  }
  const requires = normalizeRequires(value.requires);
  const provides = normalizeProvides(value.provides, requires);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    // The name is a label. It is not identity and it grants nothing: identity is
    // the package's content digest (see identity.js), so two plugins may carry
    // the same name and remain two plugins.
    name: text(value.name, 'name', NAME),
    displayName: text(value.displayName, 'displayName', WORD),
    summary: text(value.summary, 'summary'),
    requires,
    provides
  });
}

module.exports = Object.freeze({
  PluginManifestError,
  parseManifest,
  effectFloor,
  atLeast,
  CAPABILITIES,
  CAPABILITY_EFFECT_FLOOR,
  PROVIDES_CAPABILITY,
  EFFECT_ORDER,
  INTERPRETERS,
  PARAM_TYPES,
  SKIN_TOKENS,
  SCHEMA_VERSION,
  MANIFEST_FILE,
  MAX_TOOLS,
  MAX_ROLES,
  MAX_PARAMS,
  PACKAGE_PATH
});
