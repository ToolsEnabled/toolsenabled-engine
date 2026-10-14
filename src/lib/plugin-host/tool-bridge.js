'use strict';

// A PLUGIN'S TOOLS, AS SUBPROCESSES, THROUGH THE SAME DOOR AS EVERY CORE TOOL.
//
// src/lib/tool-pack-registry.js already argues the general case: a pack's
// definitions are built with the same define() a core tool uses, so the effect
// classification, the approval default, the MCP annotations and the duplicate
// name check all apply to it unchanged, and a pack "cannot widen the security
// surface". A plugin is a pack whose definitions come from a manifest instead of
// from a module in this repository, and it inherits every one of those checks.
//
// WHAT THIS FILE ADDS ON TOP, AND WHY EACH ONE IS NOT OPTIONAL.
//
// 1. THE EFFECT FLOOR. A plugin declares each tool's effect, and a declaration
//    by the thing being classified is not a classification. So the declared
//    effect is raised to the floor implied by the capabilities the OWNER granted
//    (manifest.js CAPABILITY_EFFECT_FLOOR): a package holding a network grant
//    has no local-read tools, whatever its manifest says. Raised, never lowered
//    -- a plugin that over-declares is taken at its word.
//
// 2. NO SHELL, EVER. The child is spawned with an argv array and shell:false.
//    A caller's value is passed as its own argv entry, never spliced into a
//    string, so there is no quoting rule for a plugin author to get wrong and
//    no metacharacter for a caller to smuggle. The manifest's own `args` are
//    fixed strings for the same reason.
//
// 3. A CONSTRUCTED ENVIRONMENT. The child gets an env built here from literals
//    and the plugin's own scoped paths; it never touches process.env. That is
//    the CONSTRUCTED class in tools/check-spawn-env-scrub.js, which exists
//    because the same leak -- a child inheriting the owner's billing credentials
//    -- was found and point-fixed six separate times. A plugin is the last place
//    to reopen it: the whole reason plugin code is a subprocess rather than a
//    require() is that its authority should be small enough to describe.
//
// 4. PATH PARAMETERS ARE FENCED TO A ROOT THE OWNER NAMED. A `path` parameter
//    resolves inside the plugin's workspace or the call is refused. The check is
//    on the RESOLVED path and it is a containment test, not a substring test:
//    a root of /srv/ws does not contain /srv/ws-other, and '..' is resolved
//    before the comparison rather than stripped out of the input. With no
//    workspace designated, a `path` parameter is refused outright -- the absence
//    of a root is not permission to use any root.
//
// 5. BOUNDED OUTPUT AND TIME. A child that writes forever is a child that fills
//    the disk in the tool result, so stdout and stderr are capped and the cap
//    being hit is reported as a refusal rather than as a truncated success.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { atLeast, effectFloor } = require('./manifest');
const { packageIdentity } = require('./identity');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const MAX_OUTPUT_BYTES = 256 * 1024;
// A literal. Deliberately not derived from process.env.PATH: an interpreter is
// resolved to an absolute path before this is used (see resolveInterpreter in
// index.js), so PATH is here only for a child that shells out to something
// ordinary, and it should be the same short list on every machine rather than
// whatever the person who launched the app happened to have.
const CHILD_PATH = process.platform === 'win32'
  ? '\x43:\\Windows\\system32;\x43:\\Windows'
  : '/usr/local/bin:/usr/bin:/bin';

class PluginToolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PluginToolError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new PluginToolError(code, message, details);
}

// Containment, on resolved paths, by path segment. Not a prefix test on strings:
// '/srv/ws'.startsWith is satisfied by '/srv/ws-other', which is a different
// directory, and that mistake is how a fence ends up one character wide.
function containedIn(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function jsonSchemaFor(tool) {
  const properties = {};
  const required = [];
  for (const param of tool.params) {
    const property = { description: param.description };
    if (param.type === 'string' || param.type === 'path') {
      property.type = 'string';
      property.maxLength = param.type === 'path' ? 1024 : 4096;
      if (param.type === 'path') {
        property.description += ' A path inside this plugin\'s workspace.';
      }
    } else if (param.type === 'integer') {
      property.type = 'integer';
    } else if (param.type === 'number') {
      property.type = 'number';
    } else {
      property.type = 'boolean';
    }
    if (param.default !== undefined) property.default = param.default;
    properties[param.name] = property;
    if (param.required) required.push(param.name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    // A plugin tool takes exactly the parameters it declared. An extra key is a
    // caller and a manifest disagreeing about what this tool is, and the useful
    // thing to do with a disagreement is say so.
    additionalProperties: false
  };
}

// Turns a validated argument object into an argv array: the manifest's fixed
// args first, then --name value per declared parameter, in the manifest's own
// order so a script sees a stable shape.
function argvFor(tool, argumentsValue, { workspace }) {
  const argv = [...tool.run.args];
  for (const param of tool.params) {
    const given = Object.hasOwn(argumentsValue, param.name) ? argumentsValue[param.name] : param.default;
    if (given === undefined) {
      if (param.required) {
        fail('PLUGIN_TOOL_ARGUMENT_MISSING', `${tool.name} needs ${param.name}.`, { tool: tool.name, param: param.name });
      }
      continue;
    }
    if (param.type === 'boolean') {
      if (typeof given !== 'boolean') {
        fail('PLUGIN_TOOL_ARGUMENT_INVALID', `${tool.name}: ${param.name} must be true or false.`, { tool: tool.name, param: param.name });
      }
      // A boolean is a flag's presence, not the text "false": a script reading
      // `--verbose false` as truthy is a bug waiting in every plugin that does
      // the obvious thing.
      if (given) argv.push(`--${param.name}`);
      continue;
    }
    if (param.type === 'path') {
      if (typeof given !== 'string' || !given) {
        fail('PLUGIN_TOOL_ARGUMENT_INVALID', `${tool.name}: ${param.name} must be a path.`, { tool: tool.name, param: param.name });
      }
      if (!workspace) {
        fail('PLUGIN_TOOL_NO_WORKSPACE',
          `${tool.name} takes a path, but this plugin has no workspace. Designate one before running it: with no `
          + 'root named, a path parameter has nothing to be inside, and "no root" is not permission to use any root.',
          { tool: tool.name, param: param.name });
      }
      const resolved = path.resolve(workspace, given);
      if (!containedIn(workspace, resolved)) {
        fail('PLUGIN_TOOL_PATH_OUTSIDE_WORKSPACE',
          `${tool.name}: ${param.name} resolves to ${resolved}, which is outside this plugin's workspace `
          + `(${workspace}). The path is resolved first and then checked, so '..' does not get you out and `
          + 'nothing is stripped from what you passed.',
          { tool: tool.name, param: param.name, resolved, workspace });
      }
      argv.push(`--${param.name}`, resolved);
      continue;
    }
    if (param.type === 'string') {
      if (typeof given !== 'string') {
        fail('PLUGIN_TOOL_ARGUMENT_INVALID', `${tool.name}: ${param.name} must be text.`, { tool: tool.name, param: param.name });
      }
      // An argv entry cannot carry a NUL: execve truncates at it, so a value
      // containing one would reach the child as a DIFFERENT value than the one
      // that was checked and approved.
      if (given.includes('\u0000')) {
        fail('PLUGIN_TOOL_ARGUMENT_INVALID',
          `${tool.name}: ${param.name} contains a NUL byte, which a command line cannot carry intact.`,
          { tool: tool.name, param: param.name });
      }
      argv.push(`--${param.name}`, given);
      continue;
    }
    if (typeof given !== 'number' || !Number.isFinite(given)
      || (param.type === 'integer' && !Number.isInteger(given))) {
      fail('PLUGIN_TOOL_ARGUMENT_INVALID',
        `${tool.name}: ${param.name} must be ${param.type === 'integer' ? 'a whole number' : 'a number'}.`,
        { tool: tool.name, param: param.name });
    }
    argv.push(`--${param.name}`, String(given));
  }
  return argv;
}

// UNDER ELECTRON, `node` IS THIS APP'S OWN BINARY. The `node` interpreter
// resolves to process.execPath (index.js INTERPRETER_CANDIDATES). In the app's
// main process and in the mission-bridge child that is the Electron binary, which
// does not run a script as Node unless ELECTRON_RUN_AS_NODE is set: it starts as
// a browser, ignores the script and, on Linux with no display, dies on SIGTRAP
// (exit 133). So a child that re-enters this process's own binary under Electron
// gets that one literal -- the same rule owner-prompt-platform.js and
// agent-engine/claude-process.js apply -- and no other child does: not python3,
// and not node's own binary under plain node. Read at call time, not at load.
function reentersElectronBinary(executable) {
  return Boolean(process.versions.electron) && typeof executable === 'string' && executable === process.execPath;
}

function childEnvironment({ identity, workspace, storage, temporary, executable }) {
  // CONSTRUCTED, per tools/check-spawn-env-scrub.js: every value below is a
  // literal or a path this host computed. process.env is not read.
  const env = {
    PATH: CHILD_PATH,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    // Python must not write its bytecode cache beside the plugin's scripts. Every
    // file in a package is part of its identity (identity.js), so a __pycache__
    // written by the first run would make the plugin a different one, refused at
    // its next call -- and before every file counted, a cached .pyc was code that
    // could change under an old grant. A literal, like everything here.
    PYTHONDONTWRITEBYTECODE: '1',
    TOOLSENABLED_PLUGIN_ID: identity.id,
    TOOLSENABLED_PLUGIN_SHA256: identity.sha256
  };
  if (workspace) env.TOOLSENABLED_PLUGIN_WORKSPACE = workspace;
  if (storage) env.TOOLSENABLED_PLUGIN_STORAGE = storage;
  if (temporary) { env.TMPDIR = temporary; env.TEMP = temporary; env.TMP = temporary; }
  if (workspace) env.HOME = workspace;
  if (reentersElectronBinary(executable)) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

/* A STOPPED CALL ENDS THE PROGRAM. The dispatch's abort signal (a stopped
   session, the owner host closing for Erase or quit) is handed to spawn(), which
   kills the child with SIGKILL -- for the reason the timeout below uses it -- and
   the call answers PLUGIN_TOOL_ABORTED. Before this, the registry handed a plugin
   tool no signal at all, so a child outlived every one of those, and after quit
   it outlived its own time limit too, because that timer died with the app. */
const ABORTED_BEFORE = 'The call was stopped before the tool started, so nothing ran.';
const ABORTED_DURING = 'The call was stopped, and the tool\'s program was ended.';

function runChild(executable, argv, { cwd, env, timeoutMs, stdin, signal: abortSignal }) {
  return new Promise((resolve) => {
    if (abortSignal && abortSignal.aborted) {
      resolve({ ok: false, code: 'PLUGIN_TOOL_ABORTED', message: ABORTED_BEFORE, stdout: '', stderr: '' });
      return;
    }
    let child;
    try {
      child = spawn(executable, argv, {
        cwd,
        env,
        ...(abortSignal ? { signal: abortSignal, killSignal: 'SIGKILL' } : {}),
        // shell:false is the default and is stated anyway: this is the line that
        // makes every value above an argv entry rather than shell text.
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      resolve({ ok: false, code: 'PLUGIN_TOOL_SPAWN_FAILED', message: error && error.message, stdout: '', stderr: '' });
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflowed = false;
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    const timer = setTimeout(() => {
      // SIGKILL rather than SIGTERM: a plugin script that ignores SIGTERM would
      // otherwise hold the timeout open forever, which is the failure this
      // timeout exists to prevent.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, code: 'PLUGIN_TOOL_TIMEOUT', message: `No result within ${timeoutMs} ms.`, stdout: out.join(''), stderr: err.join('') });
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outBytes += Buffer.byteLength(chunk, 'utf8');
      if (outBytes > MAX_OUTPUT_BYTES) { overflowed = true; try { child.kill('SIGKILL'); } catch { /* gone */ } return; }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errBytes += Buffer.byteLength(chunk, 'utf8');
      if (errBytes > MAX_OUTPUT_BYTES) { overflowed = true; try { child.kill('SIGKILL'); } catch { /* gone */ } return; }
      err.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (error && error.name === 'AbortError') {
        finish({ ok: false, code: 'PLUGIN_TOOL_ABORTED', message: ABORTED_DURING, stdout: '', stderr: '' });
        return;
      }
      finish({ ok: false, code: 'PLUGIN_TOOL_SPAWN_FAILED', message: error && error.message, stdout: out.join(''), stderr: err.join('') });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (abortSignal && abortSignal.aborted) {
        finish({ ok: false, code: 'PLUGIN_TOOL_ABORTED', message: ABORTED_DURING, stdout: '', stderr: '' });
        return;
      }
      if (overflowed) {
        finish({
          ok: false,
          code: 'PLUGIN_TOOL_OUTPUT_TOO_LARGE',
          message: `The tool wrote more than ${MAX_OUTPUT_BYTES} bytes. Its output is not returned: a truncated `
            + 'result that reads as a complete one is worse than a refusal.',
          stdout: '', stderr: ''
        });
        return;
      }
      finish({
        ok: code === 0,
        exitCode: code, signal: signal || null,
        stdout: out.join(''), stderr: err.join(''),
        ...(code === 0 ? {} : { code: 'PLUGIN_TOOL_FAILED', message: `Exited with ${signal ? `signal ${signal}` : `status ${code}`}.` })
      });
    });
    if (stdin !== undefined && stdin !== null) { try { child.stdin.end(String(stdin)); } catch { /* child already gone */ } }
    else { try { child.stdin.end(); } catch { /* child already gone */ } }
  });
}

/* A DECISION IS NEVER CARRIED ACROSS CHANGED BYTES, INCLUDING INSIDE ONE RUN.
 *
 * The grant was made against the package's content digest, and activation
 * checked it at start. The script, though, is read from disk each time a tool
 * runs, so a package edited while the app was open used to run its NEW bytes
 * under the OLD grant until the next restart -- while the plugins page, which
 * digests the folder afresh, said the plugin was allowed nothing (found in the
 * real app, 1.0.49 plugins walk, HP-36). So each call re-digests the package
 * first and refuses on any difference. What this does not close is an edit that
 * lands between this check and the program reading its own file; a package the
 * person can edit is a package they are trusted with, and the window is the
 * length of one spawn. */
function assertUnchangedSinceAllowed(identity, manifest) {
  let current = null;
  try { current = packageIdentity(identity.root).sha256; }
  catch { current = null; }
  if (current === identity.sha256) return;
  fail('PLUGIN_CHANGED_SINCE_ALLOWED',
    `${manifest.displayName} has changed on this computer since you allowed it, so its tools do not run. What you `
    + 'allowed was the version you were shown. Open the plugins page to decide about the version that is there '
    + 'now; your answer takes effect the next time you open the app.',
    { plugin: manifest.name });
}

// The name a plugin's tool is reachable by. One function, because the name is an
// identity and three places need it: the definitions below, the owner's screen
// (index.js describe()) and activation, which refuses a plugin whose tool names
// another allowed plugin already holds (src/lib/plugin-activation.js).
function toolNameFor(pluginName, toolName) {
  return `plugin.${pluginName.replaceAll('-', '_')}.${toolName}`;
}

// Builds the define()-ready descriptors for one activated plugin. `api` is the
// registry helper bundle a tool pack receives; `plugin` is what index.js
// assembled (identity, manifest, granted capabilities and resolved paths).
function definitionsFor(plugin, api) {
  if (!api || typeof api.define !== 'function') {
    fail('PLUGIN_TOOL_INVALID', 'definitionsFor(plugin, api) needs the registry helper bundle, including define().');
  }
  const { identity, manifest, capabilities, paths, interpreters, grants } = plugin;
  // Checked HERE, at definition time, because permission is read at every call
  // below: a store missing capabilitiesFor() would otherwise throw on the first
  // dispatch, at the one moment there is nothing useful to do about it.
  for (const method of ['capabilitiesFor', 'approvalWaived']) {
    if (!grants || typeof grants[method] !== 'function') {
      fail('PLUGIN_TOOL_INVALID',
        `definitionsFor() needs a grant store exposing ${method}(); permission is read at every call, `
        + 'not captured at activation.',
        { plugin: manifest.name, method });
    }
  }
  const floor = effectFloor(capabilities);
  const tools = manifest.provides.tools || [];

  return tools.map((tool) => {
    // The name a plugin's tool is reachable by is always namespaced under
    // `plugin.`, in the dotted shape validateRegistry() requires. A plugin
    // cannot choose to be called `filesystem.write` -- the duplicate check would
    // reject it -- but a plugin tool that merely READS like a core one in a
    // transcript is its own kind of problem, and the prefix ends it.
    //
    // The derivation is injective, which matters because the name is an
    // identity. A plugin name is lowercase-and-dashes and a tool name is
    // lowercase-and-underscores (manifest.js NAME / TOOL_NAME), so mapping the
    // dashes to underscores cannot collide with a name that already held one,
    // and '.' occurs in neither part, so the two boundaries cannot move. Two
    // DIFFERENT packages that chose the same `name`, however, do produce the same
    // tool names. This comment used to say that fails the registry's duplicate
    // check "loudly at activation". It failed it at REGISTRY LOAD, which is the
    // owner host starting: every agent start was refused while both plugins' cards
    // said running (1.0.50 review, high 1). Activation now refuses the later
    // plugin's tools before its pack is registered, and says so on its card, so
    // neither shadows the other and the registry never sees the clash.
    const name = toolNameFor(manifest.name, tool.name);
    const effect = atLeast(tool.effect, floor);
    const waived = grants.approvalWaived(identity.sha256, tool.name, effect);
    const executable = interpreters[tool.run.interpreter];
    const script = path.join(identity.root, tool.run.script);

    return api.define(
      name,
      `${manifest.displayName}: ${tool.summary}`,
      jsonSchemaFor(tool),
      async (argumentsValue, context) => {
        /* THE TOOL SET IS FROZEN AT STARTUP; PERMISSION IS READ NOW. Those are
           deliberately different and the split is the whole answer to "when does a
           plugin take effect".

           The SET must be frozen: TOOL_REGISTRY is built once and P13 derives its
           action catalogue from that snapshot, so a tool appearing mid-session would
           be dispatchable while policy had never evaluated it. tool-pack-registry.js
           enforces that and throws on a late pack.

           PERMISSION is the opposite case, and this read the array captured at
           activate(). MEASURED against that version: the grant store returned [] and
           the tool still ran. A revocation that waits for a restart is not a
           revocation, it is a note to self. One lookup per call makes "withdraw" mean
           it, and it costs nothing next to spawning a child.

           What canNOT be live is the effect CLASS: it is baked into the frozen
           descriptor because policy evaluated that exact value. So a withdrawn plugin
           REFUSES rather than quietly reclassifying itself mid-session. */
        let live;
        try {
          live = grants.capabilitiesFor(identity.sha256);
        } catch (error) {
          // An unreadable store is not permission. "Not measured" must never collapse
          // into "allowed" in a place where the collapse reads as safe.
          fail('PLUGIN_CAPABILITY_UNREADABLE',
            `${manifest.displayName} cannot run: its permissions could not be read `
            + `(${error && error.code ? error.code : 'unknown'}), and an unreadable grant is not a grant.`,
            { plugin: manifest.name });
        }
        if (!live.includes('subprocess')) {
          fail('PLUGIN_CAPABILITY_DENIED',
            `${manifest.displayName} is not currently allowed to run programs, so its tools cannot run. `
            + (capabilities.includes('subprocess')
              ? 'It was allowed to when the app started, so this permission has been withdrawn since.'
              : 'Allow it on the plugins page, or remove the plugin.'),
            { plugin: manifest.name, capability: 'subprocess' });
        }
        /* A WITHDRAWN WAIVER REFUSES, because it cannot make the tool ask again.
           `approvalEligible` is in the frozen descriptor and the approval machinery
           reads it there, so a tool defined as waived cannot begin asking mid-session
           -- and that freeze is right for the same reason the effect class is frozen.
           But an owner withdrawing a waiver plainly means "ask me again", and silently
           continuing not to ask is the widest reading of their action rather than the
           narrowest. Refusing is the honest middle. */
        if (waived && !grants.approvalWaived(identity.sha256, tool.name, effect)) {
          fail('PLUGIN_APPROVAL_WAIVER_WITHDRAWN',
            `${manifest.displayName} / ${tool.name} no longer has approval waived, and a tool that started `
            + 'the session waived cannot begin asking mid-session. Restart to have it ask again.',
            { plugin: manifest.name, tool: tool.name });
        }
        assertUnchangedSinceAllowed(identity, manifest);
        const argv = [script, ...argvFor(tool, argumentsValue || {}, { workspace: paths.workspace })];
        const result = await runChild(executable, argv, {
          cwd: paths.workspace || identity.root,
          env: childEnvironment({
            identity,
            workspace: paths.workspace,
            // LIVE, for the same reason as the subprocess check: withdrawing
            // `storage` while the child is still handed its storage path is a
            // partial revocation that revokes nothing. Measured before this read
            // the store: storage was still handed over.
            storage: live.includes('storage') ? paths.storage : null,
            temporary: paths.temporary,
            executable
          }),
          timeoutMs: DEFAULT_TIMEOUT_MS,
          signal: context && context.signal ? context.signal : undefined
        });
        if (!result.ok) {
          fail(result.code || 'PLUGIN_TOOL_FAILED',
            `${manifest.displayName} / ${tool.name}: ${result.message || 'failed'}`
            + (result.stderr ? `\n${result.stderr.slice(0, 4000)}` : ''),
            { plugin: manifest.name, tool: tool.name, exitCode: result.exitCode ?? null });
        }
        return {
          plugin: manifest.name,
          pluginId: identity.id,
          tool: tool.name,
          stdout: result.stdout,
          ...(result.stderr ? { stderr: result.stderr } : {})
        };
      },
      {
        effect,
        // A plugin tool asks each time unless the OWNER waived it for that tool
        // by name AND the raised effect is a read class AND the package holds no
        // secrets grant (grants.approvalWaived enforces all three). The plugin's
        // own `approvalEligible: false` is only ever a request.
        approvalEligible: !waived,
        // `provider` is a CLOSED vocabulary of the external services this product
        // integrates with, and validateRegistry() checks membership. A plugin is
        // not one of those, and widening that list so a plugin could name itself
        // there would put plugin-supplied strings into a field the per-provider
        // policy gate and the kill switch reason about. So: null, and the
        // plugin's origin is carried where it cannot be mistaken for a core
        // integration -- in the `plugin.<name>.` prefix on the tool's own name
        // and in its description.
        provider: null,
        // The call's abort signal reaches the handler above, so a stopped call
        // ends the child. The registry hands a pack tool that signal and nothing
        // else from the dispatch context.
        takesAbortSignal: true
      }
    );
  });
}

module.exports = Object.freeze({
  PluginToolError,
  definitionsFor,
  toolNameFor,
  jsonSchemaFor,
  argvFor,
  childEnvironment,
  containedIn,
  CHILD_PATH,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_OUTPUT_BYTES
});
