'use strict';

const ORIGINS = Object.freeze(['local', 'remote']);
// 'manifest' is the Full Remote Access tier. Guarded derives its surface from a
// generic effect class; that vocabulary was written for the bounded 8788 lane
// and refuses 14 of the 37 tools that FRA's own reviewed capability manifest
// already authorizes for 8790 (the workstation suite, screen capture, window
// control, playwright, kill-switch activation). The Manifest tier instead derives its surface from
// FRA's own reviewed capability manifest, so the manifest stops being a name
// filter that only one transport knows about and becomes an enforced tier
// inside the shared dispatcher. The two remote surfaces stay distinct rather
// than collapsed: 8788 is Guarded, 8790 is Manifest.
// 'confined' is the local write-capable tier the Standard installation level
// resolves to. It exists because the OS-level sandbox the installer design
// relies on (codex --sandbox workspace-write / claude --permission-mode) bounds
// the AGENT PROCESS and not the MCP server it talks to: a workspace-confined
// agent that can call host.exec reaches the whole machine through a process the
// sandbox never covered. Confined closes that route by refusing exactly the
// tools the reviewed FRA manifest already refuses permanently -- the same
// exclusion set, read from the same module, so there is one notion of "never".
const TIERS = Object.freeze(['full', 'guarded', 'confined', 'manifest']);
// The three levels first-run setup asks about (docs/design/INSTALLER-EXPERIENCE.md
// section 2), in the order the question presents them. They live HERE, next to
// what they permit, rather than only in src/lib/setup/machine-record.js, which
// now re-exports this list. Before this, "which level was recorded" and "what a
// level allows" were two vocabularies in two files with no mapping between them
// -- a second, independently drifting notion of what a tier permits, which is
// exactly the defect a tier system is supposed to prevent.
const INSTALL_TIERS = Object.freeze(['guided', 'standard', 'unrestricted']);
// The one mapping. Guided is the read-only surface; Standard is write-capable
// but cannot reach off the workspace through a tool; Unrestricted is today's
// local owner session, unchanged.
const INSTALL_TIER_SESSIONS = Object.freeze({
  guided: Object.freeze({ origin: 'local', tier: 'confined', profile: 'read-only' }),
  standard: Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' }),
  unrestricted: Object.freeze({ origin: 'local', tier: 'full' })
});
const GUARDED_EFFECTS = Object.freeze(['local-read', 'external-read']);
// Confined's two shapes. Guided is NOT simply the Guarded tier: Guarded is an
// effect filter, and `host.read_file`, `repo.read_file`, `host.list_dir`,
// `repo.list_dir` and `clipboard.read` are all local-read, so a purely
// effect-derived Guided surface carried tools that read any file on the
// machine -- under a level whose own words are "cannot reach anything else on
// this computer". Confined applies the permanent exclusions first and the
// effect narrowing second, so Guided is a strict subset of Standard rather than
// a differently-shaped surface that happens to be smaller.
//
// A null effect list means "any effect", not "no effects"; an unknown profile
// is refused rather than treated as either.
//
// THESE NAME THE MCP TOOL AXIS ONLY, AND SAY NOTHING ABOUT THE FILESYSTEM.
// 'read-only' here means "this level's MCP tool surface carries no write-effect
// tool", because Guided generates the read-only server and nothing else. It
// does NOT mean the agent process may not write files. Those are two different
// boundaries enforced by two different mechanisms, and the design is explicit
// that they differ at this very level: docs/design/INSTALLER-EXPERIENCE.md 2.2
// and T5 give Guided `--sandbox workspace-write --cd <workspace>` with no
// `--add-dir`, and `--permission-mode acceptEdits` -- the beginner assistant is
// MEANT to write inside the one folder it was given, since section 2.1 sells
// that level as "good for writing, organizing files". Reading this word as a
// filesystem mode would produce a Guided install that cannot do the thing its
// own question offers. The filesystem axis is not decided in this file.
const CONFINED_PROFILES = Object.freeze({
  'read-only': GUARDED_EFFECTS,
  workspace: null
});
const DIGEST_RE = /^[a-f0-9]{64}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
// Refusals that mean "this tier does not carry that tool", as opposed to a
// malformed session or unreadable policy metadata, which must never be
// swallowed by a surface enumeration.
const SURFACE_REFUSALS = Object.freeze([
  'PERMISSION_EFFECT_REFUSED',
  'PERMISSION_MANIFEST_TOOL_REFUSED',
  'PERMISSION_MANIFEST_EXCLUSION_REFUSED',
  'PERMISSION_CONFINED_EXCLUSION_REFUSED',
  'PERMISSION_CONFINED_EFFECT_REFUSED',
  // The two deny-by-default refusals. They are surface refusals -- "this tier
  // does not carry that tool" -- and NOT malformed-input errors, so tool-surface
  // enumeration filters them out instead of failing the whole enumeration.
  // Leaving them off this list would make allowedToolNames() throw the first
  // time it met an unclassified tool, which turns a fail-closed refusal into a
  // total outage and is exactly the pressure that gets a security default
  // reverted.
  'PERMISSION_CONFINED_UNCLASSIFIED_REFUSED',
  'PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
  // "This tool works only between connected computers." A local session --
  // Full included -- filters it out of the surface instead of advertising a
  // tool whose every local call must fail; see FRA_ONLY in
  // src/lib/confined-tool-surface.js.
  'PERMISSION_LOCAL_FRA_ONLY_REFUSED'
]);

class PermissionTierRefusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PermissionTierRefusal';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// Required lazily. The manifest module reaches the FRA transport descriptor and
// the service registry, and this policy is loaded by the generic dispatcher on
// every local call; a top-level require would drag the FRA graph into paths
// that have nothing to do with it.
function manifestModule() {
  return require('./fra-capability-manifest');
}

// Required lazily for the same reason: the confined surface table reaches the
// workspace boundary and the filesystem, and a Full-tier or Guarded call has no
// business loading either.
function confinedSurfaceModule() {
  return require('./confined-tool-surface');
}

// The tools no derived tier ever carries, read from the one module that already
// owns that decision instead of copied into a second list here. A copy would be
// a list that silently stops agreeing with the reviewed one; reading it means a
// tool added to the exclusions is excluded everywhere at once.
//
// FAIL CLOSED. If that module cannot be loaded, or answers with something that
// is not a populated exclusion set, this raises rather than returning an empty
// set -- an empty exclusion set would read as "nothing is excluded", which is
// the exact inversion this whole file exists to prevent.
function permanentExclusions() {
  let loaded;
  try { loaded = manifestModule(); }
  catch {
    throw new PermissionTierRefusal('PERMISSION_EXCLUSIONS_UNREADABLE',
      'The permanently excluded tools could not be read, so no tool surface can be granted.');
  }
  const tools = loaded && loaded.REQUIRED_EXCLUDED_TOOLS;
  const namespaces = loaded && loaded.ALWAYS_BLOCKED_NAMESPACES;
  if (!(tools instanceof Set) || tools.size === 0 || !(namespaces instanceof Set) || namespaces.size === 0) {
    throw new PermissionTierRefusal('PERMISSION_EXCLUSIONS_UNREADABLE',
      'The permanently excluded tools are not a readable exclusion set, so no tool surface can be granted.');
  }
  return { tools, namespaces };
}

function toolNamespace(name) {
  const separator = name.indexOf('.');
  return separator < 0 ? name : name.slice(0, separator);
}

// The binding a Manifest-tier session must carry: the exact reviewed tool names
// and the digest the manifest pinned over them. The digest is re-derived here,
// at the enforcement point, from the names actually presented -- a widened or
// mutated list therefore fails closed instead of quietly enlarging the tier.
function manifestBinding(input) {
  const declared = input.manifest;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new PermissionTierRefusal('PERMISSION_MANIFEST_BINDING_REFUSED',
      'The Manifest tier requires the reviewed FRA capability manifest binding.');
  }
  const names = declared.allowedToolNames;
  const digest = declared.allowedToolNamesDigest;
  if (!Array.isArray(names)
      || names.length === 0
      || names.some(name => typeof name !== 'string' || !TOOL_NAME_RE.test(name))
      || new Set(names).size !== names.length) {
    throw new PermissionTierRefusal('PERMISSION_MANIFEST_BINDING_REFUSED',
      'The manifest binding must carry a populated set of exact, unique tool names.');
  }
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
    throw new PermissionTierRefusal('PERMISSION_MANIFEST_BINDING_REFUSED',
      'The manifest binding must carry the reviewed capability digest.');
  }
  let computed;
  try { computed = manifestModule().toolNameDigest(names); }
  catch (error) {
    throw new PermissionTierRefusal('PERMISSION_MANIFEST_POLICY_UNREADABLE',
      'The manifest policy could not be read, so the binding could not be checked; this does not claim that the binding is absent or invalid.',
      { causeCode: typeof error?.code === 'string' ? error.code : null });
  }
  if (computed !== digest) {
    throw new PermissionTierRefusal('PERMISSION_MANIFEST_DIGEST_REFUSED',
      'The presented tool names do not match the reviewed manifest digest.');
  }
  return Object.freeze({
    allowedToolNames: Object.freeze([...names]),
    allowedToolNamesDigest: digest,
    allowed: new Set(names)
  });
}

function session(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PermissionTierRefusal('PERMISSION_SESSION_UNREADABLE', 'A readable permission session is required.');
  }
  const origin = input.origin;
  const tier = input.tier;
  if (!ORIGINS.includes(origin)) {
    throw new PermissionTierRefusal('PERMISSION_ORIGIN_REFUSED', 'The caller origin is not recognised.', { origin });
  }
  if (!TIERS.includes(tier)) {
    throw new PermissionTierRefusal('PERMISSION_TIER_REFUSED', 'The permission tier is not recognised.', { tier });
  }
  if (origin === 'remote' && tier === 'full') {
    throw new PermissionTierRefusal('PERMISSION_REMOTE_FULL_REFUSED', 'Remote callers must use the Guarded tier.');
  }
  if (tier === 'confined') {
    // The remote lanes are Guarded (8788) and Manifest (8790). Confined is what
    // a local installation's recorded level resolves to, and letting a remote
    // caller name it would widen a remote surface with a local level's word.
    if (origin !== 'local') {
      throw new PermissionTierRefusal('PERMISSION_CONFINED_ORIGIN_REFUSED',
        'The Confined tier belongs to a local installation; remote callers use Guarded or Manifest.', { origin });
    }
    const profile = input.profile;
    if (typeof profile !== 'string' || !Object.prototype.hasOwnProperty.call(CONFINED_PROFILES, profile)) {
      throw new PermissionTierRefusal('PERMISSION_CONFINED_PROFILE_REFUSED',
        'The Confined tier requires a recognised profile, so an unnamed one cannot borrow the widest of them.',
        { profile: typeof profile === 'string' ? profile.slice(0, 60) : null });
    }
    return Object.freeze({ origin, tier, profile });
  }
  if (tier === 'manifest') {
    // A local owner session has no reviewed manifest standing behind it, so it
    // cannot borrow this tier's name to reach a surface it never earned.
    if (origin !== 'remote') {
      throw new PermissionTierRefusal('PERMISSION_MANIFEST_ORIGIN_REFUSED',
        'The Manifest tier belongs to the Full Remote Access transport.');
    }
    return Object.freeze({ origin, tier, manifest: manifestBinding(input) });
  }
  return Object.freeze({ origin, tier });
}

// Convenience constructor for the one transport that owns this tier, so the
// session shape is validated where the policy lives rather than at the caller.
function manifestSession(binding) {
  return session({ origin: 'remote', tier: 'manifest', manifest: binding });
}

// The manifest is a curated allowlist, but these names are the review decisions
// the manifest loader itself refuses to ever carry. Enforcing them again here
// means a widened, hand-built, or future profile cannot reach host.exec, the
// clipboard, or the raw host/repo file surface through this tier even if its
// own name list says otherwise.
function assertManifestToolAllowed(entry, resolved) {
  const { REQUIRED_EXCLUDED_TOOLS, ALWAYS_BLOCKED_NAMESPACES } = manifestModule();
  const namespace = toolNamespace(entry.name);
  if (entry.name === 'host.exec'
      || REQUIRED_EXCLUDED_TOOLS.has(entry.name)
      || ALWAYS_BLOCKED_NAMESPACES.has(namespace)) {
    throw new PermissionTierRefusal('PERMISSION_MANIFEST_EXCLUSION_REFUSED',
      `The Manifest tier permanently refuses tool '${entry.name}'.`, { tool: entry.name, tier: resolved.tier });
  }
  if (!resolved.manifest.allowed.has(entry.name)) {
    throw new PermissionTierRefusal('PERMISSION_MANIFEST_TOOL_REFUSED',
      `Tool '${entry.name}' is not in the reviewed FRA capability manifest.`, { tool: entry.name, tier: resolved.tier });
  }
  return resolved;
}

// Confined admits a tool only if the reviewed table in
// src/lib/confined-tool-surface.js names it as confinable. DENY BY DEFAULT.
//
// THIS USED TO BE INVERTED, AND THE INVERSION WAS THE DEFECT. The rule was "the
// whole registry EXCEPT the permanent exclusions", which measured on the
// packaged build as 252 tools admitted and 9 refused at Standard -- and meant
// every tool added in future shipped admitted at Standard by silence. The
// comment that stood here described the exclusion set as "the tools that reach
// past whatever folder the agent was pointed at", which was simply not true of
// it: nine names cannot be that set, and `search.index`, `extension.package`
// and `launch.detect` all reached outside the recorded workspace root while it
// was in force.
//
// It is STILL not a plain effect filter, for the original and correct reason: a
// Standard installation is supposed to be able to write, so refusing every write
// effect would make it Guarded under a different name. What changed is that
// "may write" no longer implies "may write anywhere".
//
// The order below is deliberate. Permanent exclusions are checked FIRST so that
// a host/repo/clipboard tool is refused with the permanent code even if the
// table were ever edited to name it; the classification check second; the
// profile's effect narrowing last, so Guided remains a strict subset of
// Standard rather than a differently-shaped surface.
function assertConfinedToolAllowed(entry, resolved) {
  const { tools, namespaces } = permanentExclusions();
  if (entry.name === 'host.exec' || tools.has(entry.name) || namespaces.has(toolNamespace(entry.name))) {
    throw new PermissionTierRefusal('PERMISSION_CONFINED_EXCLUSION_REFUSED',
      `The Confined tier permanently refuses tool '${entry.name}'.`, { tool: entry.name, tier: resolved.tier });
  }
  try {
    confinedSurfaceModule().assertToolConfinable(entry.name, { tier: resolved.tier, profile: resolved.profile });
  } catch (error) {
    // Re-raised as the policy's own refusal type so every caller keeps catching
    // one error class, with the surface module's code and reason preserved.
    throw new PermissionTierRefusal(error.code, error.message, error.details || {});
  }
  const effects = CONFINED_PROFILES[resolved.profile];
  if (effects !== null && !effects.includes(entry.effect)) {
    throw new PermissionTierRefusal('PERMISSION_CONFINED_EFFECT_REFUSED',
      `The '${resolved.profile}' level refuses tool '${entry.name}' with effect '${entry.effect}'.`,
      { tool: entry.name, effect: entry.effect, tier: resolved.tier, profile: resolved.profile });
  }
  return resolved;
}

/**
 * The ARGUMENT half of a confined decision, for the dispatch chokepoint.
 *
 * assertToolAllowed above answers "may this level carry this tool at all", which
 * is the only question tool-surface enumeration can ask, because enumeration has
 * no arguments. A tool whose reach depends on a path it is GIVEN cannot be
 * judged by name, so the fence over those arguments runs here, at dispatch,
 * where the values exist.
 *
 * Non-confined tiers pass through untouched: Full is the owner's own session and
 * Guarded/Manifest are remote surfaces bounded by their own reviewed lists.
 */
function assertConfinedArgumentsAllowed(entry, input, argumentsValue, workspaceRoots) {
  const resolved = session(input);
  if (resolved.tier !== 'confined') return resolved;
  if (!entry || typeof entry.name !== 'string') {
    throw new PermissionTierRefusal('PERMISSION_POLICY_UNREADABLE', 'Tool policy metadata is unreadable.');
  }
  try {
    confinedSurfaceModule().assertArgumentsConfined(entry.name, argumentsValue, workspaceRoots,
      { tier: resolved.tier, profile: resolved.profile });
  } catch (error) {
    throw new PermissionTierRefusal(error.code, error.message, error.details || {});
  }
  return resolved;
}

// The Full tier is the local owner session, and it is still LOCAL. A tool
// whose only working context is the Full Remote Access transport ('fra-only'
// in the reviewed confined surface table) answers every local call with a
// refusal, so advertising it at Full sells a capability this session cannot
// have -- measured on the 2026-08-19 sweep, where workspace.list and
// workspace.read were offered at every local level and worked at none. The
// FRA transport itself resolves through the Manifest tier above and is not
// narrowed by this rule. An unreadable table PROPAGATES (the code is not a
// surface refusal), the same honest-outage direction tierNarrowed() already
// takes, rather than silently widening or narrowing the owner's surface.
function assertLocalFullToolAllowed(entry, resolved) {
  let decided = null;
  try { decided = confinedSurfaceModule().classify(entry.name); }
  catch {
    throw new PermissionTierRefusal('PERMISSION_POLICY_UNREADABLE',
      'The reviewed confinement table could not be read, so the local surface cannot be decided.');
  }
  if (decided === 'fra-only') {
    throw new PermissionTierRefusal('PERMISSION_LOCAL_FRA_ONLY_REFUSED',
      `Tool '${entry.name}' works between connected computers; this computer has none connected, so a local session refuses it.`,
      { tool: entry.name, tier: resolved.tier });
  }
  return resolved;
}

function assertToolAllowed(entry, input) {
  const resolved = session(input);
  if (!entry || typeof entry.name !== 'string' || typeof entry.effect !== 'string') {
    throw new PermissionTierRefusal('PERMISSION_POLICY_UNREADABLE', 'Tool policy metadata is unreadable.');
  }
  if (resolved.tier === 'manifest') return assertManifestToolAllowed(entry, resolved);
  if (resolved.tier === 'confined') return assertConfinedToolAllowed(entry, resolved);
  if (resolved.tier === 'full') return assertLocalFullToolAllowed(entry, resolved);
  if (!GUARDED_EFFECTS.includes(entry.effect)) {
    throw new PermissionTierRefusal('PERMISSION_EFFECT_REFUSED', `Guarded tier refuses tool '${entry.name}' with effect '${entry.effect}'.`, {
      tool: entry.name, effect: entry.effect, tier: resolved.tier
    });
  }
  return resolved;
}

function assertUnrestrictedSpawn(input) {
  const resolved = session(input);
  if (resolved.origin !== 'local' || resolved.tier !== 'full') {
    throw new PermissionTierRefusal('PERMISSION_UNRESTRICTED_SPAWN_REFUSED', 'Unrestricted agent flags require a local Full owner session.');
  }
  return resolved;
}

function assertConfinedTreeSpawn(input) {
  const resolved = session(input);
  if (resolved.origin !== 'local' || resolved.tier !== 'confined' || resolved.profile !== 'workspace'
      || !require('./tree-host-registry').supportsConfinedTreeSpawn()) {
    throw new PermissionTierRefusal('TREE_DELEGATION_REFUSED',
      'Tree delegation requires a local Standard session and a compatible application.');
  }
  return resolved;
}

function allowedToolNames(toolRegistry, input) {
  const resolved = session(input);
  if (!Array.isArray(toolRegistry)) {
    throw new PermissionTierRefusal('PERMISSION_POLICY_UNREADABLE', 'The tool registry is unreadable.');
  }
  return Object.freeze(toolRegistry.filter(entry => {
    try { assertToolAllowed(entry, resolved); return true; }
    catch (error) { if (SURFACE_REFUSALS.includes(error.code)) return false; throw error; }
  }).map(entry => entry.name));
}

// --- the recorded installation level ----------------------------------------
//
// FAIL CLOSED IS THE WHOLE POINT OF THESE FOUR FUNCTIONS. A level that cannot be
// read, is absent, or is a word this program does not know raises a refusal. It
// never falls back to Unrestricted, and it never falls back to "no allowlist" --
// which src/lib/tool-registry.js reads as the FULL surface, so an unnoticed
// widening here would be indistinguishable from a deliberate one.

function installTier(value) {
  if (typeof value !== 'string' || !INSTALL_TIERS.includes(value)) {
    throw new PermissionTierRefusal('PERMISSION_INSTALL_TIER_REFUSED',
      'The recorded permission level is missing or is not one this program recognises, so no tool surface can be granted.',
      { tier: typeof value === 'string' ? value.slice(0, 60) : null });
  }
  return value;
}

function installTierSession(value) {
  return session(INSTALL_TIER_SESSIONS[installTier(value)]);
}

function installTierFromRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new PermissionTierRefusal('PERMISSION_INSTALL_TIER_UNREADABLE',
      'The machine record could not be read, so the permission level it holds cannot be honoured.');
  }
  return installTier(record.tier);
}

function installTierSessionFromRecord(record) {
  return installTierSession(installTierFromRecord(record));
}

function installTierToolNames(toolRegistry, value) {
  return allowedToolNames(toolRegistry, installTierSession(value));
}

function guardedToolNames(toolRegistry) {
  const resolved = session({ origin: 'remote', tier: 'guarded' });
  if (!Array.isArray(toolRegistry)) throw new PermissionTierRefusal('PERMISSION_POLICY_UNREADABLE', 'The tool registry is unreadable.');
  return Object.freeze(toolRegistry.filter(entry => {
    if (!entry || typeof entry.name !== 'string' || typeof entry.effect !== 'string') {
      throw new PermissionTierRefusal('PERMISSION_POLICY_UNREADABLE', 'Tool policy metadata is unreadable.');
    }
    try { assertToolAllowed(entry, resolved); return true; }
    catch (error) { if (error.code === 'PERMISSION_EFFECT_REFUSED') return false; throw error; }
  }).map(entry => entry.name));
}

module.exports = Object.freeze({
  ORIGINS, TIERS, INSTALL_TIERS, INSTALL_TIER_SESSIONS, CONFINED_PROFILES,
  GUARDED_EFFECTS, SURFACE_REFUSALS, PermissionTierRefusal,
  session, manifestSession, assertToolAllowed, assertConfinedArgumentsAllowed, assertConfinedTreeSpawn,
  assertUnrestrictedSpawn, allowedToolNames, guardedToolNames,
  installTier, installTierSession, installTierFromRecord, installTierSessionFromRecord, installTierToolNames
});
