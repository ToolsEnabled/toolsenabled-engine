'use strict';

// THE ONE PLACE PLUGINS ARE BROUGHT UP, AND IT RUNS BEFORE THE TOOL REGISTRY.
//
// ORDERING IS THE WHOLE REASON THIS IS A FILE. src/lib/tool-pack-registry.js
// freezes at module load, and registering a pack after src/lib/tool-registry.js
// has been built THROWS -- deliberately, because the alternative is a tool that
// silently does not exist and a caller who sees UnknownToolError with nothing to
// explain it. So activate() has to run before the registry is built, and it
// asserts that rather than trusting whoever wired it: a require() ordering mistake
// in this repository is a build error, and a build error must not be discoverable
// only by a person wondering where their plugin went.
//
// IT REFUSES WHAT WOULD BE LOST, NOT THE ORDER ITSELF. The only contribution with
// an ordering rule is a tool pack, and a plugin contributes one only when it holds
// `subprocess`. So a late pass -- the registry already in require.cache -- is
// refused exactly when a package the person granted `subprocess` is present, and
// the refusal names the entrypoint to fix. A late pass with no such package loses
// nothing: roles are read through the projection on every read and skins and
// settings rows are asked for after activation, so it runs as it would have run
// in order. The first version refused every late pass, plugins or not, and that
// made "nothing changes with no plugin installed" false: fourteen engine suites
// and the app's own owner host (whose organisation record loads the registry
// first) failed to start on a machine with no plugin at all.
//
// A BROKEN PLUGIN MUST NOT STOP THE ENGINE, AND MUST NOT BE SILENT EITHER.
// Everything per-plugin is caught and collected. The engine starts; the plugin
// does not; and status() says which one and why, in the sentence the host wrote.
// The two failure modes this avoids are opposite and both real: an engine that
// will not start because a third party's manifest has a typo, and a plugin that
// quietly is not there.
//
// WHAT IT DOES NOT DO. It does not install anything, prompt for anything, or
// grant anything. Every capability it acts on was already granted by the person,
// in the app, against a content digest. With no grants, activate() does nothing
// at all and status() says so -- which is also the shipped state of a fresh
// install, and the suite proves that path rather than assuming it.

const path = require('node:path');
const { PluginGrantStore } = require('./plugin-host/grants');
const { toolNameFor } = require('./plugin-host/tool-bridge');
const toolPacks = require('./tool-pack-registry');
const roleProjection = require('./plugin-role-projection');

const REGISTRY_MODULE = './tool-registry';

let outcome = null;

/* Has src/lib/tool-registry.js already been loaded? Asked of require.cache rather
   than by requiring it, because requiring it here is exactly the thing that would
   make the answer yes. */
function registryAlreadyBuilt() {
  let resolved;
  try { resolved = require.resolve(REGISTRY_MODULE); }
  catch { return false; }
  return Boolean(require.cache[resolved]);
}

/* Called only for a late pass, with the listing in hand and BEFORE any package is
   activated: activation prepares a plugin's directories, and a refused pass must
   leave nothing behind. A package contributes a tool pack exactly when `subprocess`
   is in force (registerActivatedPlugins() in src/lib/plugin-host), and the manifest
   refuses `subprocess` without a `tools` entry, so that is the whole test: its pack
   would be registered after the freeze and throw. The names are the manifests'
   validated lowercase names, never a plugin's free-text display name. */
function assertNothingLost(packages) {
  const losing = packages.filter(described => described.inForce.includes('subprocess'));
  if (!losing.length) return;
  const names = losing.map(described => described.name);
  const error = new Error(
    'Plugin activation ran after src/lib/tool-registry.js was already loaded, and '
    + `${names.join(', ')} ${names.length === 1 ? 'holds a grant' : 'hold grants'} to run tools. TOOL_REGISTRY is `
    + 'frozen at module load, so those tools would be absent from it with nothing to explain why. Move the '
    + 'require of src/lib/plugin-activation.js above the require of the tool registry in whichever entrypoint '
    + 'loaded it -- see the ordering note in src/lib/tool-pack-registry.js.'
  );
  error.code = 'PLUGIN_ACTIVATION_AFTER_REGISTRY';
  error.plugins = Object.freeze(names);
  throw error;
}

/* THE GRANT READS GO THROUGH THE PROCESS'S ONE DURABLE-STATE DOOR, getStateStore().
   The grant store's own default is createStateStore(), a SQLite connection of its
   own, and the app's Erase seals and closes only the shared one -- so with any
   folder in plugin-packages the pass kept toolsenabled.sqlite3 open through Erase
   (on Windows, a database the sweep cannot delete). Resolved on each call rather
   than once, so nothing opens on a computer with no plugin, and so a read after
   the seal is refused (STATE_STORE_CLOSED) instead of quietly reopening it. */
function sharedStateStore() {
  const shared = () => require('./state-store').getStateStore();
  return Object.freeze({
    getMemory: input => shared().getMemory(input),
    setMemory: input => shared().setMemory(input),
    searchMemory: input => shared().searchMemory(input)
  });
}

/* Brings up every package that holds a grant. Idempotent: a second call returns
   the first call's outcome rather than registering a pack twice, because two
   entrypoints in one process (the MCP server and the mission bridge both reach
   the registry) must not fight over who activates. */
function activate({
  host = require('./plugin-host'),
  grants = null,
  stateStore = null,
  audit = null,
  now = () => new Date().toISOString()
} = {}) {
  if (outcome) return outcome;
  // Asked before anything is read, so nothing this pass loads can change it.
  const late = registryAlreadyBuilt();

  const started = now();
  const activated = [];
  const refused = [];
  const skipped = [];

  let listing;
  let store;
  try {
    store = grants || new PluginGrantStore({
      stateStore: stateStore || sharedStateStore(),
      ...(audit ? { audit } : {})
    });
    listing = host.listPackages({ grants: store });
  } catch (error) {
    /* THE WHOLE PASS FAILING IS NOT THE SAME AS THERE BEING NO PLUGINS, and the
       difference has to survive into status(). A state store that will not open
       would otherwise read as "nothing is installed", which is the reading that
       makes a person stop looking. */
    outcome = Object.freeze({
      ok: false,
      at: started,
      code: error && error.code ? String(error.code) : 'PLUGIN_ACTIVATION_FAILED',
      reason: error && error.message ? String(error.message) : String(error),
      activated: Object.freeze([]),
      refused: Object.freeze([]),
      skipped: Object.freeze([]),
      registeredPacks: Object.freeze([]),
      plugins: Object.freeze([])
    });
    return outcome;
  }

  // Throws, leaving no outcome and no directory, when a granted plugin's tools
  // would be lost. Otherwise a late pass is the same pass as an early one.
  if (late) assertNothingLost(listing.packages);

  for (const entry of listing.refused) {
    refused.push(Object.freeze({ directory: entry.directory, code: entry.code, message: entry.message }));
  }

  for (const described of listing.packages) {
    if (!described.inForce.length) {
      /* Not a failure. A package the person has not decided about, or has
         withdrawn, is listed as skipped with the reason so that "why is my plugin
         not working" has an answer at the first place anybody looks. */
      skipped.push(Object.freeze({
        id: described.id,
        name: described.name,
        reason: described.revoked
          ? 'its permissions were withdrawn'
          : 'it has not been allowed anything yet'
      }));
      continue;
    }
    let plugin;
    try {
      plugin = host.activate(described.root, { grants: store });
    } catch (error) {
      refused.push(Object.freeze({
        directory: described.name,
        // Which package and which part, so the Plugins page can put the sentence on
        // the right card (1.0.50 release review F6). Every per-package refusal below
        // carries both; a directory the host could not read at all carries neither.
        sha256: described.sha256,
        part: 'package',
        code: error && error.code ? String(error.code) : 'PLUGIN_ACTIVATION_FAILED',
        message: error && error.message ? String(error.message) : String(error)
      }));
      continue;
    }
    let roles = [];
    try {
      roles = host.rolesFor(plugin);
    } catch (error) {
      /* A bad role FILE loses the roles and keeps the tools. Refusing the whole
         package for a typo in one JSON file would be a bigger punishment than the
         mistake, and the tools have already been validated separately. */
      refused.push(Object.freeze({
        directory: `${described.name} (roles)`,
        sha256: described.sha256,
        part: 'roles',
        code: error && error.code ? String(error.code) : 'PLUGIN_ROLE_INVALID',
        message: error && error.message ? String(error.message) : String(error)
      }));
    }
    /* EACH PLUGIN'S ROLES ARE CHECKED ON THEIR OWN, against the projection's own
       rules, before anything is registered. Registration below is one call for
       every plugin, and it refuses its whole list for one bad entry -- so it used
       to be the place a single plugin's role id cost EVERY plugin its roles (1.0.50
       release review F3: one two-word role id, and no plugin role from any plugin
       reached the role library, with the failure only on the console). Checked
       here, a role the projection would refuse costs its own plugin's roles and
       is reported against that plugin, like a bad role file above. */
    let checked = [];
    if (roles.length) {
      try {
        checked = roleProjection.checkProjectedRoles(roles.map(role => ({
          id: role.id, rules: role.rules, plugin: plugin.manifest.name, pluginId: plugin.identity.id
        })));
      } catch (error) {
        refused.push(Object.freeze({
          directory: `${described.name} (roles)`,
          sha256: described.sha256,
          part: 'roles',
          code: error && error.code ? String(error.code) : 'PLUGIN_ROLE_PROJECTION_INVALID',
          message: error && error.message ? String(error.message) : String(error)
        }));
      }
    }
    activated.push({
      // The package's folder, for the one sentence that has to tell two plugins
      // with the same name apart (the tool-name check below).
      folder: path.basename(described.root),
      id: plugin.identity.id,
      sha256: plugin.identity.sha256,
      name: plugin.manifest.name,
      displayName: plugin.manifest.displayName,
      capabilities: plugin.capabilities,
      effectFloor: plugin.effectFloor,
      roles: checked,
      toolCount: (plugin.manifest.provides.tools || []).length,
      plugin
    });
  }

  /* WHAT CAN ONLY BE SEEN ACROSS PLUGINS, decided per role and per plugin rather
     than for the whole list. A role id two activated plugins both project is used
     by neither -- nobody could say which wording is in force -- and both are told;
     their other roles stay. Then the bound: a plugin whose roles would take the
     total past it loses its roles, and the plugins before it keep theirs. */
  const claimants = new Map();
  for (const entry of activated) {
    for (const role of entry.roles) claimants.set(role.id, (claimants.get(role.id) || 0) + 1);
  }
  for (const entry of activated) {
    const contested = entry.roles.filter(role => claimants.get(role.id) > 1).map(role => role.id);
    if (!contested.length) continue;
    entry.roles = entry.roles.filter(role => claimants.get(role.id) === 1);
    refused.push(Object.freeze({
      directory: `${entry.name} (roles)`,
      sha256: entry.sha256,
      part: 'roles',
      code: 'PLUGIN_ROLE_PROJECTION_COLLISION',
      message: `Another plugin you allowed to add roles also adds ${contested.length === 1 ? 'the role' : 'the roles'} `
        + `${contested.map(id => `"${id}"`).join(', ')}. Neither plugin's version is used, because nobody could say `
        + 'which wording is in force. Its other roles are unaffected.'
    }));
  }
  let projectedCount = 0;
  for (const entry of activated) {
    if (projectedCount + entry.roles.length > roleProjection.MAX_PROJECTED_ROLES) {
      refused.push(Object.freeze({
        directory: `${entry.name} (roles)`,
        sha256: entry.sha256,
        part: 'roles',
        code: 'PLUGIN_ROLE_PROJECTION_LIMIT',
        message: `At most ${roleProjection.MAX_PROJECTED_ROLES} roles may come from plugins at once, and this plugin's `
          + `${entry.roles.length} would take the total past that, so none of them is added. Its other permissions are unaffected.`
      }));
      entry.roles = [];
      continue;
    }
    projectedCount += entry.roles.length;
  }
  const projected = activated.flatMap(entry => entry.roles);

  /* Tool packs first, then roles, then the skin -- but only the first of those has
     an ordering rule, and it is the one asserted at the top of this function.

     A TOOL NAME TWO ALLOWED PLUGINS BOTH PROVIDE COSTS THE LATER PLUGIN ITS TOOLS,
     AND NOTHING ELSE (1.0.50 review, high 1). A tool's name is derived from the
     plugin's NAME (toolNameFor()), and grants are keyed by digest, so two packages
     called "notes" -- 1.1 unpacked beside 1.0, or two authors who chose the same
     word -- can both be allowed to run programs. Both packs used to be registered,
     and the clash surfaced only when src/lib/tool-registry.js threw "Duplicate tool
     name" at module load: the owner host did not start, every agent start failed,
     and both cards said running. Checked here instead, per plugin and in listing
     order (folder name, so the answer is the same at every start): the first
     plugin to REGISTER a name keeps it, a later one that would provide any of its
     names is not registered at all, and its card says which folder holds the name
     and what to do. Not "neither", as for a role id: a role is wording an agent is
     given, where nobody could say which version is in force; a tool is a program
     the person allowed, and refusing both would take away one that works.
     Names are claimed only by a pack that registered, so a plugin refused for
     another reason holds nothing. A tool name never collides across DIFFERENT
     plugin names (the derivation is injective, see tool-bridge.js), so a plugin
     that merely shares a tool's short name with another is not affected. */
  const registeredPacks = [];
  const toolHolders = new Map();
  for (const entry of activated) {
    const names = entry.plugin.capabilities.includes('subprocess')
      ? (entry.plugin.manifest.provides.tools || []).map(tool => toolNameFor(entry.name, tool.name))
      : [];
    const taken = names.filter(name => toolHolders.has(name));
    if (taken.length) {
      const holders = [...new Set(taken.map(name => toolHolders.get(name)))].map(folder => `"${folder}"`);
      const one = holders.length === 1;
      refused.push(Object.freeze({
        directory: `${entry.name} (tools)`,
        sha256: entry.sha256,
        part: 'tools',
        code: 'PLUGIN_TOOL_NAME_COLLISION',
        message: `${one ? 'Another plugin' : 'Other plugins'} you allowed to run programs, in the `
          + `${one ? 'folder' : 'folders'} ${holders.join(' and ')}, ${one ? 'is' : 'are'} also named "${entry.name}" `
          + `and already ${one ? 'provides' : 'provide'} ${taken.length === 1 ? 'the tool' : 'the tools'} ${taken.join(', ')}. `
          + `Two tools cannot share a name, so none of this plugin's tools are added. The ${one ? 'other plugin\'s' : 'others\''} `
          + 'tools still work, and so does everything else. To use this one instead, withdraw everything from '
          + `${one ? 'the other plugin' : 'the others'} or remove ${one ? 'its folder' : 'their folders'}; that takes `
          + 'effect the next time you open the app.'
      }));
      continue;
    }
    try {
      registeredPacks.push(...host.registerActivatedPlugins([entry.plugin]));
      for (const name of names) toolHolders.set(name, entry.folder);
    } catch (error) {
      refused.push(Object.freeze({
        directory: `${entry.name} (tools)`,
        sha256: entry.sha256,
        part: 'tools',
        code: error && error.code ? String(error.code) : 'PLUGIN_TOOL_PACK_REFUSED',
        message: error && error.message ? String(error.message) : String(error)
      }));
    }
  }

  try {
    roleProjection.registerProjectedRoles(projected);
    /* Sealed HERE, once, and never by a read: after this point nothing legitimate
       registers a projected role, and an attempt to is a wiring mistake that says
       so rather than quietly replacing the vocabulary mid-run. */
    roleProjection.seal();
  } catch (error) {
    refused.push(Object.freeze({
      directory: '(plugin roles)',
      code: error && error.code ? String(error.code) : 'PLUGIN_ROLE_PROJECTION_INVALID',
      message: error && error.message ? String(error.message) : String(error)
    }));
  }

  outcome = Object.freeze({
    ok: true,
    at: started,
    activated: Object.freeze(activated.map(entry => Object.freeze({
      id: entry.id, sha256: entry.sha256, name: entry.name, displayName: entry.displayName,
      capabilities: entry.capabilities, effectFloor: entry.effectFloor,
      // The roles actually projected for this plugin: after its own check, the
      // cross-plugin collisions and the bound above.
      roleIds: Object.freeze(entry.roles.map(role => role.id)), toolCount: entry.toolCount
    }))),
    refused: Object.freeze(refused),
    skipped: Object.freeze(skipped),
    registeredPacks: Object.freeze(registeredPacks),
    /* The live plugin objects, for the two consumers that need more than a
       summary: the skin (tokens per package) and the settings rows. Kept off the
       frozen summary above so a status reader cannot reach a handler. */
    plugins: Object.freeze(activated.map(entry => entry.plugin))
  });
  return outcome;
}

/* Which projected roles a person's own stored roles hide. Answered AFTER the role
   store has been read once, because the stored ids are what decides it -- so this
   is a separate call rather than part of activate(). */
function shadowedRoles(storedRoleIds) {
  return roleProjection.shadowedBy(Array.isArray(storedRoleIds) ? storedRoleIds : []);
}

/* The skin tokens for every activated plugin that was allowed one, keyed by plugin
   id. Empty for a plugin without the grant, which is what skinFor() already
   returns -- so a caller never has to check the capability itself. */
function skins({ host = require('./plugin-host') } = {}) {
  if (!outcome || !outcome.ok) return Object.freeze({});
  const out = {};
  for (const plugin of outcome.plugins) {
    const tokens = host.skinFor(plugin);
    if (Object.keys(tokens).length) out[plugin.identity.id] = tokens;
  }
  return Object.freeze(out);
}

/* The settings rows for every activated plugin that was allowed some. A bad rows
   file loses that plugin's rows and nothing else. */
function settings({ host = require('./plugin-host') } = {}) {
  if (!outcome || !outcome.ok) return Object.freeze([]);
  const out = [];
  for (const plugin of outcome.plugins) {
    try {
      for (const row of host.settingsFor(plugin)) {
        out.push(Object.freeze({ ...row, plugin: plugin.manifest.name, pluginId: plugin.identity.id }));
      }
    } catch (error) {
      out.push(Object.freeze({
        plugin: plugin.manifest.name,
        pluginId: plugin.identity.id,
        refused: error && error.code ? String(error.code) : 'PLUGIN_SETTING_INVALID',
        reason: error && error.message ? String(error.message) : String(error)
      }));
    }
  }
  return Object.freeze(out);
}

/* Never activates as a side effect of being asked. A caller that wants the
   outcome before activation ran gets null, which is a different answer from "no
   plugins" and is meant to be. */
function status() {
  if (!outcome) return null;
  return Object.freeze({
    ok: outcome.ok,
    at: outcome.at,
    ...(outcome.ok ? {} : { code: outcome.code, reason: outcome.reason }),
    activated: outcome.activated,
    refused: outcome.refused,
    skipped: outcome.skipped,
    registeredPacks: outcome.registeredPacks
  });
}

function resetForTests() {
  outcome = null;
  roleProjection.resetForTests();
  toolPacks.resetForTests();
}

module.exports = Object.freeze({ activate, status, skins, settings, shadowedRoles, resetForTests });
