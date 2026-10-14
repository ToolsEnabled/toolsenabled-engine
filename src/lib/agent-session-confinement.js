'use strict';

// Confined Codex sessions use the account's official sign-in home in place.
// ToolsEnabled restrictions travel through -c TOML launch overrides, never a
// copied config or sign-in. Codex 0.161 merges table overrides; the adapter
// therefore checks the effective configuration before admitting a thread.
// Claude's generated tool surface has its separate CLI argument transport.

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const permissionTierPolicy = require('./permission-tier-policy');
const accountProfileBoundary = require('./account-profile-boundary');
const providerIsolation = require('./provider-session-isolation');
// Node built-ins only; a literal require so the capability packer stages it.

// Lazily required: machine-record reaches the tool registry through
// generateMcpConfig, and a caller merely resolving a sandbox word has no reason
// to load every provider in the product.
function machineRecordModule() {
  return require('./setup/machine-record');
}

// ACCOUNT-BOUNDARY PRIMITIVES NOW COME FROM account-profile-boundary.js, NOT
// FROM A SECOND COPY HERE.
//
// This module used to carry its own copies of AgentConfinementRefusal,
// installationProfileRoot, assertAccountProfilePath and every helper beneath
// them (normalizeWindowsAccountPathAlias, windowsProfileRootOf,
// windowsPathInside, pathReferencesForeignProfile, sameWindowsPath,
// isProvablyLocalWindowsHost, expandThroughExistingAncestor,
// ownedOnceExpanded). Two copies of one security check can disagree, and they
// did: this copy's installationProfileRoot() never carried the
// AGENT_CONFINEMENT_WRONG_PRINCIPAL defense that account-profile-boundary.js
// enforces -- it returned windowsProfileRootOf(__dirname) ||
// windowsProfileRootOf(process.execPath) outright, with no cross-check
// against os.userInfo().homedir at all, whereas account-profile-boundary.js
// treats the OS-reported home as authoritative and uses the module/executable
// location only to VALIDATE it, refusing with AGENT_CONFINEMENT_WRONG_PRINCIPAL
// when they disagree. mission-bridge/actions.js
// accountConfinedDispatchEnvironment -- which builds the environment for
// EVERY dispatched Codex and Claude worker -- computed its trust anchor from
// THIS copy's installationProfileRoot(), so the weaker check, not the
// stronger one, was the one actually gating dispatch. Fixed by requiring the
// boundary module instead of re-implementing it. See
// tests/account-boundary-merge.test.js.
const {
  AgentConfinementRefusal,
  installationProfileRoot,
  assertAccountProfilePath,
  normalizeWindowsAccountPathAlias,
  pathReferencesForeignProfile
} = accountProfileBoundary;

// The one mapping from a recorded level to a running agent's own confinement.
//
// `approvalPolicy` is 'never' at EVERY level, and at the confined levels that is
// the strict reading rather than the lax one. 'on-request' would let the model
// ask to step outside its sandbox, and Codex escalates when the request is
// answered yes.
//
// THE REPLY PATH NOW EXISTS, AND THAT IS WHY THIS COMMENT CHANGED. It used to
// say the agent host "exposes no way to answer an approval at all", which read
// as if 'never' were a consequence of that gap rather than a decision. THE
// PREMISE IS FALSE NOW, end to end: the host's answerApproval() reaches the
// adapter's answerApproval() (src/lib/agent-engine/codex-adapter.js), the
// renderer reaches the host through the `mc-agent:approval-answer` channel and
// its preload, and an `approval_request` becomes the activity kind `approval`
// that the tree copy renders as "waiting for you". Anyone reasoning from the old
// sentence would conclude this ceiling is unenforceable-by-accident and "repair"
// it by opening the gate.
//
// SO 'never' IS THE DELIBERATE CEILING, and the half of the old reasoning that
// still holds is the half that matters: the day a reply path is added it becomes
// a ROUTE AROUND THE CEILING -- a level a person chose, negotiated away one
// dialog at a time by the thing it was chosen to bound. That day has arrived, so
// the constant is load-bearing rather than incidental. 'never' means the sandbox
// denial is the final answer, which is what a ceiling is. Changing it is a
// decision about a security boundary and deserves a deliberate review, not a
// quiet fix by whoever next finds the unreachable "waiting for you" state and
// assumes it is a bug.
//
// WHAT THAT COSTS, WRITTEN DOWN SO IT IS NOT REDISCOVERED AS A MYSTERY: a
// confined session's refusal cannot be answered by anybody. MEASURED, driven
// through the packaged product on a scratch profile at `standard`, the
// decision about a security boundary and belongs to the owner, not to whoever
// next finds the unreachable "waiting for you" state and assumes it is a bug.
//
// WHAT THAT COSTS, WRITTEN DOWN SO IT IS NOT REDISCOVERED AS A MYSTERY: a
// confined session's refusal cannot be answered by anybody. MEASURED 2026-08-20,
// driven through the packaged product on a scratch profile at `standard`, the
// whole turn was: request -> `patch rejected: writing is blocked by read-only
// sandbox; rejected by user approval settings` -> finished, in 17 seconds. No
// prompt appeared, because with 'never' no `approval_request` is ever emitted
// for one to appear from.
// `claudePermissionMode` is the same ceiling stated in the other engine's
// vocabulary, for the `claude` lane in src/lib/mission-bridge/actions.js. The
// values are the ones docs/design/INSTALLER-EXPERIENCE.md records as MEASURED
// from `claude --help`: acceptEdits, auto, bypassPermissions, default, dontAsk,
// plan. `plan` is the read-only one and `acceptEdits` is the write-capable one
// that still asks before anything else; `bypassPermissions` is today's
// unrestricted lane, unchanged.
const INSTALL_TIER_AGENT_CONFINEMENT = Object.freeze({
  guided: Object.freeze({ sandbox: 'read-only', approvalPolicy: 'never', claudePermissionMode: 'plan', isolated: true }),
  standard: Object.freeze({ sandbox: 'workspace-write', approvalPolicy: 'never', claudePermissionMode: 'acceptEdits', isolated: true }),
  unrestricted: Object.freeze({ sandbox: 'danger-full-access', approvalPolicy: 'never', claudePermissionMode: 'bypassPermissions', isolated: true })
});

// The level a session runs at when the recorded one cannot be honoured.
//
// This is the fail-closed direction and it is deliberately the FIRST tier, not a
// fourth "safe" mode invented here: a level nobody can select is a level nobody
// tests. An absent record means setup has not run, which is precisely when the
// user has not yet consented to anything.
const FAIL_CLOSED_TIER = 'guided';

/**
 * The confinement a recorded level resolves to.
 *
 * Fail closed: an absent, malformed or unrecognised level RAISES. It never
 * degrades to `danger-full-access`, and it never degrades to "no sandbox word",
 * which Codex reads as the user config's own sandbox_mode -- on the measured
 * installation, danger-full-access. Both of those failures would be
 * indistinguishable from a deliberate grant.
 */
function agentConfinement(tier) {
  const validated = permissionTierPolicy.installTier(tier);
  const confinement = INSTALL_TIER_AGENT_CONFINEMENT[validated];
  /* istanbul ignore next -- installTier already refused anything unmapped; this
   * is the guard that keeps that true if a tier is ever added to one list and
   * not the other. */
  if (!confinement) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_TIER_UNMAPPED',
      'The recorded permission level has no agent confinement, so no session can be started under it.',
      { tier: validated }
    );
  }
  return Object.freeze({ tier: validated, ...confinement });
}

function agentConfinementFromRecord(record) {
  return agentConfinement(permissionTierPolicy.installTierFromRecord(record));
}

/** The confinement used when the recorded one cannot be read at all. */
function failClosedConfinement() {
  return agentConfinement(FAIL_CLOSED_TIER);
}

/* EXHAUSTIVE SUBSTITUTION AUDIT (2026-08-24).
 *
 * There is exactly one path in this module on which a REQUESTED tier can turn
 * into another tier: the catch below around agentConfinementFromRecord(). A
 * record whose tier is malformed, unrecognised, or no longer mapped becomes
 * Guided. That substitution is deliberately observable as `failedClosed: true`
 * plus the refusal code; it is not a silent successful resolution.
 *
 * The earlier read-error and absent-record branches also return Guided, but
 * neither has a readable requested tier to substitute. agentConfinement()
 * itself never substitutes: it either returns the exact validated tier or
 * throws. The plan builders below only carry this resolved object forward and
 * refuse preparation errors; they do not choose a second tier.
 *
 * One silent difference remains OUTSIDE this JavaScript resolver: as measured
 * at the top of this file, Codex on Windows can accept the Standard tier's
 * `workspace-write` request and report `read-only` when `[windows].sandbox` is
 * absent. Keeping that engine-level downgrade named here prevents a search for
 * JavaScript fallbacks from incorrectly declaring requested and effective
 * confinement identical.
 */
/**
 * Read the recorded level and resolve the session it permits, WITHOUT throwing.
 *
 * A first-run screen that crashes on a malformed record is a product that cannot
 * be recovered from its own UI, and an agent host that throws on one is a
 * product whose safest state is unreachable. So every failure resolves to the
 * most restrictive session and reports WHY in a bounded code, rather than
 * refusing to start or -- far worse -- starting unconfined.
 */
function resolveAgentConfinement({ servicesRoot, machineRecord = machineRecordModule() } = {}) {
  let profileRoot = null;
  let root = null;
  try {
    profileRoot = installationProfileRoot();
    root = servicesRoot || machineRecord.resolveServicesRoot({});
    root = assertAccountProfilePath(root, { field: 'services root', profileRoot });
    providerIsolation.isolationContext(process.env, { servicesRoot: root });
  } catch (error) {
    return Object.freeze({
      ...failClosedConfinement(),
      recorded: false,
      failedClosed: true,
      boundaryRefused: true,
      code: (error && error.code) || 'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE',
      record: null,
      servicesRoot: null,
      profileRoot
    });
  }
  let record = null;
  try {
    record = machineRecord.readMachineRecord({ servicesRoot: root });
  } catch (error) {
    return Object.freeze({
      ...failClosedConfinement(),
      recorded: false,
      failedClosed: true,
      boundaryRefused: false,
      code: (error && error.code) || 'AGENT_CONFINEMENT_RECORD_UNREADABLE',
      record: null,
      servicesRoot: root,
      profileRoot
    });
  }
  if (!record) {
    return Object.freeze({
      ...failClosedConfinement(),
      recorded: false,
      failedClosed: true,
      boundaryRefused: false,
      code: 'AGENT_CONFINEMENT_RECORD_ABSENT',
      record: null,
      servicesRoot: root,
      profileRoot
    });
  }
  try {
    for (const workspaceRoot of record.workspaceRoots || []) {
      assertAccountProfilePath(workspaceRoot, { field: 'recorded workspace root', profileRoot });
    }
  } catch (error) {
    return Object.freeze({
      ...failClosedConfinement(),
      recorded: false,
      failedClosed: true,
      boundaryRefused: true,
      code: (error && error.code) || 'AGENT_CONFINEMENT_FOREIGN_PROFILE',
      record: null,
      servicesRoot: root,
      profileRoot
    });
  }
  try {
    return Object.freeze({
      ...agentConfinementFromRecord(record),
      recorded: true,
      failedClosed: false,
      boundaryRefused: false,
      code: 'AGENT_CONFINEMENT_RESOLVED',
      record,
      servicesRoot: root,
      profileRoot
    });
  } catch (error) {
    return Object.freeze({
      ...failClosedConfinement(),
      recorded: false,
      failedClosed: true,
      boundaryRefused: false,
      code: (error && error.code) || 'AGENT_CONFINEMENT_TIER_REFUSED',
      record: null,
      servicesRoot: root,
      profileRoot
    });
  }
}

// --- the isolated Codex home ------------------------------------------------

const CONFINED_HOME_LEAF = 'agent-home';
const ACCOUNT_FENCE_FILE = 'ACCOUNT-FENCE.md';
const CODEX_ACCOUNT_FENCE_FILE = 'AGENTS.md';

// isProvablyLocalWindowsHost, normalizeWindowsAccountPathAlias,
// windowsProfileRootOf, installationProfileRoot, sameWindowsPath,
// windowsPathInside, pathReferencesForeignProfile, assertAccountProfilePath
// and their internal helpers (expandThroughExistingAncestor,
// ownedOnceExpanded) used to be redefined here, as a second copy of
// account-profile-boundary.js. They now come from the destructured
// accountProfileBoundary import above -- see the comment there for why
// keeping two copies of a security check in sync by hand was the bug.

/* Every spawned CLI receives these values after the ambient environment is
 * scrubbed. Pinning both Windows and Unix-style home variables prevents either
 * engine (or a child it starts) from selecting another account's directives,
 * config, cache or temporary directory through inherited process state. */
function accountProfileEnvironment(profileRoot = installationProfileRoot()) {
  const privateProfile = providerIsolation.profileEnvironment(providerIsolation.isolationContext());
  if (privateProfile) return Object.freeze(privateProfile);
  const owned = assertAccountProfilePath(profileRoot, {
    field: 'account profile', profileRoot, requireOwnedProfile: process.platform === 'win32'
  });
  const parsed = path.parse(owned);
  return Object.freeze({
    USERPROFILE: owned,
    HOME: owned,
    HOMEDRIVE: parsed.root.replace(/[\\/]$/, ''),
    HOMEPATH: owned.slice(parsed.root.length - 1),
    APPDATA: path.join(owned, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(owned, 'AppData', 'Local'),
    TEMP: path.join(owned, 'AppData', 'Local', 'Temp'),
    TMP: path.join(owned, 'AppData', 'Local', 'Temp'),
    XDG_CONFIG_HOME: path.join(owned, '.config'),
    XDG_CACHE_HOME: path.join(owned, '.cache'),
    XDG_DATA_HOME: path.join(owned, '.local', 'share')
  });
}

/* The shell owns the FINAL merge with process.env, so it calls this after
 * layering plan.env. Inspect names and path-shaped substrings only; values never
 * leave this function or enter refusal details. This catches foreign homes in
 * compound variables such as PATH as well as in ordinary one-path variables. */
function assertAccountProfileEnvironment(environment, profileRoot = installationProfileRoot()) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_PROFILE_ENVIRONMENT_INVALID',
      'The final agent environment is not a constructed object, so no session was started from it.',
      {}
    );
  }
  providerIsolation.assertProviderSessionEnvironment(environment);
  if (process.platform !== 'win32') return environment;
  // The OS-derived profile root is already the authority. Environment
  // validation is lexical so a hostile sibling reference is refused without
  // opening either the sibling or the owned profile merely to compare them.
  const ownedAlias = normalizeWindowsAccountPathAlias(profileRoot);
  const owned = ownedAlias.supported && path.win32.isAbsolute(ownedAlias.normalized)
    ? path.win32.resolve(ownedAlias.normalized)
    : null;
  if (!owned) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE',
      'The Windows profile that owns this installation could not be established, so the launch environment was refused.',
      {}
    );
  }
  const leaked = [];
  for (const [name, raw] of Object.entries(environment)) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const slashNormalized = raw.replace(/\//g, '\\');
    let unsafe = false;

    /* Device/extended forms must be considered as a whole. Merely finding an
       inner drive-profile spelling would incorrectly bless the same profile
       behind a device prefix this fence deliberately does not interpret. */
    const namespaceReferences = [
      ...(slashNormalized.match(/\\\\(?:[?.]|\?\?)\\[^;"'\r\n]*/g) || []),
      ...(slashNormalized.match(/(?<!\\)\\\?\?\\[^;"'\r\n]*/g) || [])
    ];
    for (const reference of namespaceReferences) {
      const alias = normalizeWindowsAccountPathAlias(reference.trim());
      if (!alias.supported) {
        if (!alias.nonFilesystemDevice) unsafe = true;
        continue;
      }
      if (pathReferencesForeignProfile(alias.normalized, owned)) unsafe = true;
    }

    const drivePaths = slashNormalized.match(/[a-z]:\\[^;"'\r\n]*/ig) || [];
    for (const reference of drivePaths) {
      const alias = normalizeWindowsAccountPathAlias(reference.trim());
      if (!alias.supported || pathReferencesForeignProfile(alias.normalized, owned)) unsafe = true;
    }
    const directDriveProfiles = slashNormalized.match(/[a-z]:\\users\\[^\\;"'\s]+/ig) || [];
    if (directDriveProfiles.some(reference => pathReferencesForeignProfile(reference, owned))) unsafe = true;

    const ordinaryUncPaths = slashNormalized.match(/\\\\(?![?.]\\|\?\?\\)[^\\;"'\r\n]+\\[^\\;"'\r\n]+(?:\\[^;"'\r\n]*)?/g) || [];
    for (const reference of ordinaryUncPaths) {
      const alias = normalizeWindowsAccountPathAlias(reference.trim());
      if (!alias.supported || pathReferencesForeignProfile(alias.normalized, owned)) unsafe = true;
    }

    /* A local admin share can be proven equivalent to its drive spelling. A
       remote admin-share Users tree cannot, even when its final directory has
       the same name as this account, so it is refused without a network read. */
    const adminPaths = slashNormalized.match(/\\\\(?:\?\\UNC\\)?[^\\;"'\r\n]+\\[a-z]\$(?:\\[^;"'\r\n]*)?/ig) || [];
    for (const reference of adminPaths) {
      const alias = normalizeWindowsAccountPathAlias(reference);
      if (!alias.supported || pathReferencesForeignProfile(alias.normalized, owned)) unsafe = true;
    }
    const directAdminProfiles = slashNormalized.match(/\\\\(?:\?\\UNC\\)?[^\\;"'\s]+\\[a-z]\$\\users\\[^\\;"'\s]+/ig) || [];
    for (const reference of directAdminProfiles) {
      const alias = normalizeWindowsAccountPathAlias(reference);
      if (!alias.supported || pathReferencesForeignProfile(alias.normalized, owned)) unsafe = true;
    }

    if (unsafe) {
      leaked.push(name);
    }
  }
  if (leaked.length > 0) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_FOREIGN_PROFILE_ENVIRONMENT',
      'The final agent environment still references another Windows user profile, so the session was refused before launch.',
      { variables: Object.freeze(leaked.sort()) }
    );
  }
  return environment;
}

/* A LOCAL ACCOUNT FENCE FOLLOWS THE ACCOUNT INTO EVERY HOME WE GENERATE.
 *
 * The assistant CLIs deliberately run against product-owned homes rather than
 * the person's ambient ~/.codex or ~/.claude. That isolation also means a
 * profile-root safety boundary would otherwise disappear at the exact launch
 * seam where it matters. ACCOUNT-FENCE.md is the one opt-in exception: when it
 * exists at the CURRENT OS account's home, its exact bytes are refreshed into
 * the engine's global-instruction filename on every successful prepare.
 *
 * No file means the generated instruction target is removed. Preserving it
 * would preserve stale directives from whichever account prepared this reusable
 * home last. A present but unreadable, non-regular, or unwritable fence REFUSES
 * the prepare; silently starting without a boundary that exists would be unsafe.
 * lstat rejects a source link, while removal plus exclusive target creation
 * prevents an existing target link from being followed by the writer. */
function syncAccountFence(home, targetName, accountHome = installationProfileRoot()) {
  if (typeof accountHome !== 'string' || accountHome.length === 0 || !path.isAbsolute(accountHome)) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_ACCOUNT_FENCE_UNAVAILABLE',
      'The current account home could not be established, so its local assistant boundary could not be checked.',
      { operation: 'locate-account-home' }
    );
  }

  const source = path.join(accountHome, ACCOUNT_FENCE_FILE);
  const target = path.join(home, targetName);
  let sourceStat;
  try {
    sourceStat = fs.lstatSync(source);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      try {
        /* Absence is an empty directive surface, not permission to retain an
           older account's bytes in this reusable generated home. rmSync removes
           a link by name and does not follow it. */
        fs.rmSync(target, { force: true });
      } catch (removeError) {
        throw new AgentConfinementRefusal(
          'AGENT_CONFINEMENT_ACCOUNT_FENCE_UNAVAILABLE',
          'No current account fence exists, but stale assistant directives could not be removed, so no session was prepared.',
          { operation: 'remove-stale-target', cause: removeError && removeError.code ? String(removeError.code) : 'unknown' }
        );
      }
      return target;
    }
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_ACCOUNT_FENCE_UNAVAILABLE',
      'The current account fence exists or may exist but could not be inspected, so no confined session was prepared without it.',
      { operation: 'inspect-source', cause: error && error.code ? String(error.code) : 'unknown' }
    );
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_ACCOUNT_FENCE_UNAVAILABLE',
      'The current account fence is not a regular file, so no confined session was prepared from an ambiguous boundary.',
      { operation: 'validate-source' }
    );
  }

  let bytes;
  try {
    bytes = fs.readFileSync(source);
  } catch (error) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_ACCOUNT_FENCE_UNAVAILABLE',
      'The current account fence could not be read, so no confined session was prepared without it.',
      { operation: 'read-source', cause: error && error.code ? String(error.code) : 'unknown' }
    );
  }

  try {
    /* Remove the NAME before exclusive creation. writeFileSync on an existing
       symlink would follow it; rmSync removes the link itself, and `wx` refuses
       if anything recreates the name before the write. */
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    const written = fs.readFileSync(target);
    if (!Buffer.isBuffer(written) || !written.equals(bytes)) {
      const mismatch = new Error('account fence verification mismatch');
      mismatch.code = 'EVERIFY';
      throw mismatch;
    }
  } catch (error) {
    let cleanupCause = null;
    try { fs.rmSync(target, { force: true }); } catch (cleanupError) {
      cleanupCause = cleanupError && cleanupError.code ? String(cleanupError.code) : 'unknown';
    }
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_ACCOUNT_FENCE_UNAVAILABLE',
      'The current account fence could not be synchronized into the confined assistant home, so no session was prepared without it.',
      {
        operation: 'write-target',
        cause: error && error.code ? String(error.code) : 'unknown',
        cleanupCause
      }
    );
  }
  return target;
}

// One path segment, from a name a person typed into a file we do not control.
// Anything that is not a plain name character becomes a dash, and the result is
// bounded, so a name can never climb out of the home it is supposed to sit in.
// An empty result answers null, which means "no account", which means the
// original shared path -- the same fail-closed default as everywhere else here.
function accountSegment(name) {
  if (typeof name !== 'string') return null;
  /* Trailing dots and dashes are stripped AFTER the length cap, because the cap
     can create them. Trailing dots matter on their own: Win32 silently drops
     them when it creates the directory, so `work` and `work.` would resolve to
     ONE home and the second start would re-link a different person's
     credential into a running session's home -- the wrong-identity failure the
     per-account layout exists to make unrepresentable. The name marker written
     at prepare (assertAccountMarker) is the backstop for every other lossy
     collision this slug can produce. */
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '').slice(0, 64).replace(/[.-]+$/, '');
  return cleaned.length > 0 ? cleaned : null;
}

/* An organisation identity is not a provider label. Keep it in its own path
 * segment and generated-server field so two agents using the same provider
 * cannot rewrite one another's authority-bearing MCP document. `@agents` and
 * `@default` are reserved path components: neither can be produced by this
 * declared-id grammar. */
const DECLARED_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AGENT_HOME_NAMESPACE = '@agents';
const SESSION_HOME_NAMESPACE = '@sessions';
const DEFAULT_AGENT_ACCOUNT_LEAF = '@default';

function declaredAgentSegment(agentId) {
  if (agentId === undefined || agentId === null) return null;
  if (typeof agentId !== 'string' || !DECLARED_AGENT_ID.test(agentId)) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_AGENT_ID_INVALID',
      'A generated agent tool surface must name one exact declared agent id or none.',
      {}
    );
  }
  return agentId;
}

function sessionAuthoritySegment(sessionId, sessionCredential) {
  if (sessionId === undefined || sessionId === null) {
    if (sessionCredential === undefined || sessionCredential === null) return null;
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_SESSION_CREDENTIAL_INVALID',
      'A generated agent tool surface cannot carry a credential without its session id.',
      {}
    );
  }
  let credentialBytes = null;
  if (typeof sessionCredential === 'string' && /^[A-Za-z0-9_-]{43}$/.test(sessionCredential)) {
    try { credentialBytes = Buffer.from(sessionCredential, 'base64url'); } catch { credentialBytes = null; }
  }
  const credentialValid = sessionCredential === undefined || sessionCredential === null
    || (credentialBytes?.length === 32 && credentialBytes.toString('base64url') === sessionCredential);
  if (credentialBytes) credentialBytes.fill(0);
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 128
      || /[\0\r\n]/.test(sessionId)
      || !credentialValid) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_SESSION_CREDENTIAL_INVALID',
      'The generated agent tool surface carries an invalid session authority.',
      {}
    );
  }
  return crypto.createHash('sha256')
    .update('toolsenabled-agent-session-path-v1\0', 'utf8')
    .update(String(process.pid), 'ascii')
    .update('\0', 'utf8')
    .update(sessionId, 'utf8')
    .digest('hex');
}

/* THE RECORD THE GENERATOR IS GIVEN, WHICH IS NOT THE RECORD ON DISK.
 *
 * TWO FIELDS ARE SUBSTITUTED FROM THE PROCESS DOING THE GENERATING, and neither
 * substitution is written back: `workspace.checkWorkspaceCandidate()` reads the
 * recorded `installRoot` and means something different by it (the whole install
 * directory, which it refuses to let a person choose as a workspace), and the
 * record is the person's own answer about their computer.
 *
 * `installRoot` -> THIS ENGINE'S ROOT. generateMcpConfig() resolves each server
 * as `path.join(record.installRoot, 'src/mcp-server.js')` and OMITS any server
 * whose script is not on disk. In a packaged build the engine is an
 * extraResource under `resources\capability`, so the recorded install directory
 * has no `src\mcp-server.js` in it and ALL THREE servers were skipped -- a
 * confined session with an empty tool table, which is a session that cannot
 * reach the product it is running inside. shell/setup-record.cjs already does
 * exactly this for `.mcp.json`; this is the same substitution for the file the
 * app's OWN sessions read, which never had it.
 *
 * `nodePath` -> THE RUNTIME THAT IS ACTUALLY RUNNING. resolveNodePath() answers
 * `process.execPath` AT SETUP TIME, so the recorded value pins whichever
 * INSTALLATION happened to run setup, forever; generateMcpConfig only checks
 * that the path still exists, never that it is this build. That is why the
 * second window a user reported LOOKED OUTDATED: it was the older installed
 * build, faithfully started from a record written months earlier. A value taken
 * from the generating process is true by construction and cannot go stale.
 *
 * MEASURED on a real installation 2026-08-18, before the change: the confined
 * `config.toml` for every level named
 *   command = '<an-installed-copy>\ToolsEnabled.exe'
 *   args    = ['<a-different-checkout>\src\mcp-server.js']
 * -- one installation's binary, another checkout's scripts, and no
 * ELECTRON_RUN_AS_NODE anywhere in the file. Both paths are placeholders on
 * purpose: a real one here is a builder's own directory leaking into a shipped
 * comment, which the owner-data guard refuses -- and rightly. */
/* THE DIRECTORY THIS INSTALLATION KEEPS ITS OWN RECORDS IN, for the servers the
 * generated document starts.
 *
 * READ FROM THE ENVIRONMENT RATHER THAN DERIVED, and that is the whole point.
 * The application decides this directory (it sets TOOLSENABLED_STATE_ROOT before
 * anything is required, and a relocated profile -- a portable install, a test
 * harness, --user-data-dir -- moves it), so deriving it a second time here is
 * how two halves of one product end up writing to two places. An MCP server
 * inherits nothing from us: it is spawned by the agent CLI out of the generated
 * document, so the value has to travel IN that document or not at all.
 *
 * Absent means null, which stamps nothing and reproduces the file this has
 * always written byte for byte -- a checkout, a test and a CLI are all in that
 * case and none of them should be able to tell this shipped. */
function stateRootForGeneratedServers(env = process.env) {
  const declared = env && typeof env.TOOLSENABLED_STATE_ROOT === 'string' ? env.TOOLSENABLED_STATE_ROOT.trim() : '';
  if (declared.length === 0 || !path.isAbsolute(declared)) return null;
  return assertAccountProfilePath(declared, {
    field: 'generated server state root', profileRoot: installationProfileRoot()
  });
}

function generationRecord(record) {
  return {
    ...record,
    installRoot: path.resolve(__dirname, '..', '..'),
    nodePath: process.execPath
  };
}

/* TOML, for exactly the shapes written below and nothing else.
 *
 * Windows paths are full of backslashes, which a TOML BASIC string (double
 * quotes) would interpret as escapes -- a path beginning `<drive>:\Users\...`
 * contains `\U`, which is a unicode escape, and Codex would refuse the file. A
 * LITERAL string (single quotes) processes no escapes at all, which is exactly
 * right for a path, and
 * cannot itself contain a single quote. So a value that could not be written
 * literally is REFUSED rather than escaped into a basic string: silently
 * switching quoting styles is how a path with one odd character becomes a
 * different path, and this file decides what an agent may reach.
 */
function tomlLiteral(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768) {
    throw new AgentConfinementRefusal('AGENT_CONFINEMENT_HOME_UNWRITABLE',
      `${label} is not a value this installation can write into a Codex configuration.`, { label });
  }
  // eslint-disable-next-line no-control-regex
  if (/['\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new AgentConfinementRefusal('AGENT_CONFINEMENT_HOME_UNWRITABLE',
      `${label} contains a character this installation will not write into a Codex configuration.`, { label });
  }
  return `'${value}'`;
}

function tomlKey(name, label) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
    throw new AgentConfinementRefusal('AGENT_CONFINEMENT_HOME_UNWRITABLE',
      `${label} is not a name this installation can write into a Codex configuration.`, { label, name: typeof name === 'string' ? name.slice(0, 60) : null });
  }
  return name;
}

/* THE SYMMETRIC ASSERTION, shared by BOTH renderings of the one document.
 * confinedCodexConfig() renders the generated document into the TOML Codex
 * reads and prepareClaudeToolSurface() writes the same document as the
 * `.mcp.json` the Claude CLI reads; an entry that would boot the application
 * instead of a server is exactly as fatal in either -- and worse to diagnose
 * than a refusal, because the agent CLI starts the "server", gets no JSON-RPC,
 * and reports a failure while a second copy of the app opens on the desk.
 * MEASURED 2026-08-18: `<app>.exe <engine>\src\mcp-server.js` with no
 * ELECTRON_RUN_AS_NODE answered no `initialize`, advertised 0 tools, and
 * created 5 top-level windows.
 *
 * On documents the product's own generator writes, this is defense in depth
 * rather than a live gate: the generator stamps ELECTRON_RUN_AS_NODE under the
 * same predicate, so this fires only on a generator regression or an injected
 * document -- which is exactly when it must. `machineRecord` is the caller's
 * injected module, never re-required here, so the seam a test injects is the
 * seam this consults. */
function refuseNonNodeRuntime(name, entry, machineRecord = machineRecordModule()) {
  if (!machineRecord.runtimeNeedsNodeMode(entry.command)) return;
  const runAsNode = entry.env && typeof entry.env === 'object' ? entry.env.ELECTRON_RUN_AS_NODE : undefined;
  if (runAsNode !== '1') {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_RUNTIME_NOT_NODE',
      `The "${name}" assistant server would be started by a program that is not a plain Node runtime, and nothing tells it to behave as one. Writing that would start this application again instead of a server, so no confined session can be configured from it.`,
      { server: name }
    );
  }
}

/* WHAT AN ENTRY MUST BE BEFORE EITHER RENDERING WRITES IT, in one place so the
 * two renderings cannot disagree about a malformed shape. Before this existed
 * the Codex side refused bad entries as a SIDE EFFECT of its TOML quoting and
 * the JSON side serialized them verbatim -- an asymmetry that produces
 * advertised-but-broken servers on exactly one engine.
 *
 * The name rule is tighter than "what TOML can write": a name containing `__`
 * is refused because the Claude CLI's permission grammar reads
 * `mcp__<server>__<tool>` -- a server named `a__b` would turn the server-wide
 * rule claudeServerPermissionRule() writes into a grant for TOOL `b` of SERVER
 * `a`, a different principal than the one the plan named. The generator's own
 * catalogue has no such name; a document that does is refused, not repaired.
 *
 * Codes a caller can switch on: AGENT_CONFINEMENT_HOME_UNWRITABLE for a name
 * this installation will not write (the same code the TOML renderer has always
 * used for it), AGENT_CONFINEMENT_SERVER_ENTRY_INVALID for an entry that is
 * not an object, AGENT_CONFINEMENT_SERVER_COMMAND_INVALID for a command that
 * is missing or not a string -- which would otherwise sail PAST the runtime
 * check, because runtimeNeedsNodeMode(undefined) is false -- and
 * AGENT_CONFINEMENT_RUNTIME_NOT_NODE from the runtime check itself. */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

function validateServerEntries(document, machineRecord = machineRecordModule()) {
  const entries = Object.entries((document && document.mcpServers) || {});
  for (const [name, entry] of entries) {
    if (!MCP_SERVER_NAME_RE.test(name) || name.includes('__')) {
      throw new AgentConfinementRefusal(
        'AGENT_CONFINEMENT_HOME_UNWRITABLE',
        `"${String(name).slice(0, 60)}" is not a name this installation can write into an assistant configuration.`,
        { server: String(name).slice(0, 60) }
      );
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AgentConfinementRefusal(
        'AGENT_CONFINEMENT_SERVER_ENTRY_INVALID',
        `The "${name}" assistant server is not described by a readable entry, so no confined session can be configured from it.`,
        { server: name }
      );
    }
    if (typeof entry.command !== 'string' || entry.command.length === 0) {
      throw new AgentConfinementRefusal(
        'AGENT_CONFINEMENT_SERVER_COMMAND_INVALID',
        `The "${name}" assistant server names no program to start, so no confined session can be configured from it.`,
        { server: name }
      );
    }
    const pathValues = [
      ['command', entry.command],
      ['cwd', entry.cwd],
      ...(Array.isArray(entry.args) ? entry.args.map((value, index) => [`args[${index}]`, value]) : []),
      ...(entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
        ? Object.entries(entry.env).map(([key, value]) => [`env.${key}`, value])
        : [])
    ];
    for (const [field, value] of pathValues) {
      if (typeof value === 'string' && path.isAbsolute(value)) {
        assertAccountProfilePath(value, {
          field: `${name}.${field}`,
          profileRoot: installationProfileRoot()
        });
      }
    }
    /* refuseNonNodeRuntime() is deliberately NOT called here: it is shared,
       but each rendering runs it at its own established point -- the TOML
       side after its value-level quoting refusals (whose HOME_UNWRITABLE code
       callers already switch on), the JSON side right after this validator.
       This function owns the SHAPES; the runtime rule owns the runtime. */
  }
  return entries;
}

// Restrictions the official Codex CLI consumes as one-run overrides.
// MCP entries retain generated role/account/workspace boundaries. They are
// checked against effective configuration because -c tables merge.

const CODEX_SCRIPT_CALL_GUIDANCE = 'Run at most 8 ToolsEnabled calls at once per script, since more can stall it; for many Ledger records, pass ids to one ledger.read.';

/* The values confinedCodexConfig() forwards by name: one environment for the Codex process. Two servers that name the
   same key with different values would make the forwarded value ambiguous, so that is refused. */
const FORWARDED_BY_NAME = /CREDENTIAL|SECRET|TOKEN|PASSWORD|API_?KEY/i;
function codexForwardedEnvironment(mcpDocument, machineRecord = machineRecordModule()) {
  const forwarded = {};
  for (const [name, entry] of validateServerEntries(mcpDocument, machineRecord)) {
    for (const [key, value] of Object.entries(entry.env || {})) {
      if (!FORWARDED_BY_NAME.test(key)) continue;
      if (Object.prototype.hasOwnProperty.call(forwarded, key) && forwarded[key] !== value) {
        throw new AgentConfinementRefusal('AGENT_CONFINEMENT_SERVER_ENV_CONFLICT',
          `Two ToolsEnabled tool servers need different values for ${key}, so this session was not started.`, { server: name });
      }
      forwarded[key] = value;
    }
  }
  return forwarded;
}

function confinedCodexConfig(confinement, mcpDocument, machineRecord = machineRecordModule(), sqliteHome = null, roleFunctionsOnly = false) {
  const config = {
    approval_policy: confinement.approvalPolicy,
    sandbox_mode: roleFunctionsOnly ? 'read-only' : confinement.sandbox,
    sandbox_workspace_write: { writable_roots: [], network_access: false,
      exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
    notify: [],
    developer_instructions: '',
    // A generated home never inherited the person's plugins or hooks.
    features: { hooks: false, plugins: false, remote_plugin: false, plugin_sharing: false },
    mcp_servers: {}
  };
  if (providerIsolation.isolationRequested()) config.cli_auth_credentials_store = 'file';
  if (sqliteHome !== null) config.sqlite_home = sqliteHome;
  if (roleFunctionsOnly) {
    if (Object.keys(mcpDocument?.mcpServers || {}).some(name =>
      ['toolsenabled-readonly', 'toolsenabled'].includes(name))) {
      config.developer_instructions = [
        'ToolsEnabled API mode is Only. The read-only filesystem sandbox and restricted network apply to native Codex tools, including apply_patch.',
        'ToolsEnabled MCP tools execute through a separate server-enforced permission boundary. The native sandbox does not make those APIs read-only.',
        'For work authorized by the person, discover and invoke the relevant ToolsEnabled API, including write operations its contract and current permissions allow.',
        'The API still enforces the recorded permission tier, workspace boundary, role functions, direct-user authorization and required approvals. Respect every API refusal; do not bypass it through native tools, another agent or another transport.',
        CODEX_SCRIPT_CALL_GUIDANCE
      ].join(' ');
    }
    config.web_search = 'disabled';
    for (const feature of [
      'shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external',
      'browser_use_full_cdp_access', 'computer_use', 'code_mode',
      'multi_agent', 'multi_agent_v2', 'goals', 'hooks', 'plugins', 'remote_plugin',
      'plugin_sharing', 'image_generation', 'view_image', 'in_app_browser',
      'in_app_chat', 'in_app_local_automation', 'in_app_updates',
      'skill_mcp_dependency_install', 'workspace_dependencies', 'tool_suggest'
    ]) config.features[feature] = false;
    config.features.code_mode_host = true;
    config.features.skip_host_skill_discovery = true;
  }
  for (const [name, entry] of validateServerEntries(mcpDocument, machineRecord)) {
    tomlKey(name, 'MCP server name');
    tomlLiteral(entry.command, `${name}.command`);
    refuseNonNodeRuntime(name, entry, machineRecord);
    const server = { command: entry.command, args: Array.isArray(entry.args) ? entry.args : [], enabled: true };
    server.args.forEach((value, i) => tomlLiteral(value, `${name}.args[${i}]`));
    if (typeof entry.cwd === 'string') {
      tomlLiteral(entry.cwd, `${name}.cwd`);
      server.cwd = entry.cwd;
    }
    if (process.platform === 'linux' && ['toolsenabled', 'toolsenabled-readonly', 'playwright'].includes(name)) {
      server.env_vars = ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY'];
    }
    if (['toolsenabled', 'toolsenabled-readonly'].includes(name)) server.tool_timeout_sec = 900;
    if (roleFunctionsOnly) {
      if (!['toolsenabled-readonly', 'toolsenabled'].includes(name)) {
        throw new AgentConfinementRefusal('AGENT_ROLE_TOOL_SERVER_UNSUPPORTED',
          'Role-scoped sessions may use only the generated ToolsEnabled registry servers.', {});
      }
      server.default_tools_approval_mode = 'approve';
    }
    if (entry.env && Object.keys(entry.env).length) {
      /* SECRETS BY NAME, NEVER ON THE COMMAND LINE. The confined surface reaches Codex as -c overrides on its command
         line, which any local process can read, and a server's environment can hold the agent's session credential.
         A secret-shaped key is forwarded by name (env_vars) with its value in the Codex process environment
         (codexForwardedEnvironment); ordinary per-server settings stay inline, since servers differ in them. */
      for (const [key, value] of Object.entries(entry.env)) {
        tomlKey(key, `${name}.env key`);
        tomlLiteral(value, `${name}.env.${key}`);
        if (FORWARDED_BY_NAME.test(key)) {
          server.env_vars = [...(server.env_vars || [])];
          if (!server.env_vars.includes(key)) server.env_vars.push(key);
        } else {
          server.env = { ...(server.env || {}), [key]: value };
        }
      }
    }
    config.mcp_servers[name] = server;
  }
  return config;
}

// Each top-level table is supplied whole. Codex 0.161 merges these tables;
// launch discovers and disables foreign MCP names, then verifies the surface.
function codexConfigOverrideArgs(config) {
  const value = item => {
    if (typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'boolean' || typeof item === 'number') return String(item);
    if (Array.isArray(item)) return '[' + item.map(value).join(', ') + ']';
    return '{' + Object.entries(item).map(([key, entry]) =>
      JSON.stringify(key) + ' = ' + value(entry)).join(', ') + '}';
  };
  return Object.freeze(Object.entries(config).flatMap(([key, entry]) => ['-c', key + '=' + value(entry)]));
}

// Inspect existence/type only. The official CLI owns reading and refreshing
// the chosen sign-in in place; ToolsEnabled never opens or relocates it.
function assertCodexSignedIn(file) {
  try {
    if (fs.statSync(file).isFile()) return;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) {
      throw new AgentConfinementRefusal('AGENT_CONFINEMENT_SIGN_IN_UNAVAILABLE',
        'The assistant sign-in could not be checked, so this is not claiming that the assistant is signed out.',
        { cause: error?.code || 'unknown' });
    }
  }
  throw new AgentConfinementRefusal('AGENT_CONFINEMENT_SIGNED_OUT',
    'The assistant is not signed in on this computer. Sign in with codex login before starting it.', {});
}

/* WRITE A FILE SO A CRASH LEAVES EITHER THE OLD BYTES OR THE NEW ONES.
 *
 * Measured 2026-09-02 on the installed product: one hard power loss zeroed
 * vault/secrets.json AND a session .mcp.json (3,839 bytes, every byte NUL,
 * mtimes two seconds apart). A plain writeFileSync truncates the name first and
 * relies on the page cache; a crash in between leaves a full-length file of
 * zeros, which then reads as "no MCP servers" and looks like missing tools.
 * Same recipe as durable-memory-file.js: exclusive temp in the same directory,
 * fsync BEFORE rename, rename last. */
function writeFileDurably(target, text) {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}-${process.pid}-${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* closing a failed handle */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* already renamed away */ }
  }
}

/* ONE NAME PER HOME, WRITTEN DOWN AND CHECKED. accountSegment() is lossy by
 * design (case folded, characters collapsed, length capped), so two DIFFERENT
 * account names can share one directory leaf -- and the second start would
 * re-link a different person's credential into a home a session may already be
 * running from. Wrong-identity is the exact failure the per-account layout
 * exists to make unrepresentable, so the home records WHOSE it is on first
 * prepare and every later prepare must agree or is refused by name. Additive:
 * no path changes, and a home from before this existed adopts its first
 * caller's name. */
const ACCOUNT_MARKER_FILE = 'toolsenabled-account.json';

function assertAccountMarker(home, accountName) {
  if (accountName === null) return;
  const marker = path.join(home, ACCOUNT_MARKER_FILE);
  let recorded = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
    recorded = parsed && typeof parsed.name === 'string' ? parsed.name : null;
    if (recorded === null) {
      throw new AgentConfinementRefusal(
        'AGENT_CONFINEMENT_ACCOUNT_MARKER_UNREADABLE',
        'This assistant home has an account marker whose owner cannot be established, so no session can be started from it.',
        {}
      );
    }
  } catch (error) {
    /* Absence is the one state that means this home has not acquired an owner
       yet. A malformed marker or any other read failure does NOT mean "no
       owner": adopting the requesting account in that case used to overwrite
       the evidence needed to detect a lossy account-name collision. */
    if (!error || error.code !== 'ENOENT') {
      if (error instanceof AgentConfinementRefusal) throw error;
      throw new AgentConfinementRefusal(
        'AGENT_CONFINEMENT_ACCOUNT_MARKER_UNREADABLE',
        'This assistant home\'s account owner could not be read, so no session can be started from it.',
        { cause: error && error.code ? String(error.code) : 'unknown' }
      );
    }
  }
  if (recorded !== null && recorded !== accountName) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_ACCOUNT_COLLISION',
      `This assistant home belongs to the "${recorded}" account, and "${accountName}" resolves to the same folder. Rename one of the two accounts so each has its own home.`,
      { recorded, requested: accountName }
    );
  }
  fs.writeFileSync(marker, `${JSON.stringify({ name: accountName })}\n`, 'utf8');
}



function revokeCredentialLinks(searchRoot, identity, { limit = 20000 } = {}) {
  const removed = [];
  const failures = [];
  if (!searchRoot || !identity || identity.ino === undefined || identity.dev === undefined) {
    return Object.freeze({ removed, failures, scanned: 0, complete: false });
  }

  let wantedDev;
  let wantedIno;
  try { wantedDev = BigInt(identity.dev); wantedIno = BigInt(identity.ino); }
  catch { return Object.freeze({ removed, failures, scanned: 0, complete: false }); }
  let scanned = 0;
  let truncated = false;
  const walk = (directory) => {
    if (truncated) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (cause) {
      if (!cause || cause.code !== 'ENOENT') {
        failures.push(Object.freeze({ operation: 'read', file: directory, cause: cause?.code || 'unknown' }));
      }
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      if ((scanned += 1) > limit) { truncated = true; return; }
      let info;
      try { info = fs.lstatSync(full, { bigint: true }); } catch { continue; }
      if (info.ino !== wantedIno || info.dev !== wantedDev) continue;
      try { fs.rmSync(full, { force: true }); removed.push(full); }
      catch (cause) {
        failures.push(Object.freeze({ operation: 'unlink', file: full, cause: cause?.code || 'unknown' }));
      }
    }
  };
  walk(searchRoot);
  return Object.freeze({
    removed: Object.freeze(removed),
    failures: Object.freeze(failures),
    scanned,
    // Only a scan that finished and removed everything it matched may be read as
    // a completed revocation.
    complete: !truncated && failures.length === 0
  });
}

/* The identity of a credential, captured while it still exists. Taken BEFORE the
 * owner's own copy is deleted, because once the last name is gone there is
 * nothing left to match the other names against. */
function credentialIdentity(file) {
  try {
    // bigint: see revokeCredentialLinks() -- a rounded Windows file id is
    // somebody else's file.
    const info = fs.lstatSync(file, { bigint: true });
    if (!info.isFile()) return null;
    return Object.freeze({ dev: info.dev, ino: info.ino, nlink: Number(info.nlink) });
  } catch { return null; }
}

/* HOW FAR A SIGN-OUT SWEEP LOOKS. revokeCredentialLinks() counts every file it
 * passes, and agent-home also holds each provider's own session logs and state
 * -- the 20,000 default is a fixture's number, and an ordinary well-used
 * agent-home can pass it, after which the sweep stops and reports itself
 * incomplete. This bound only stops a runaway walk; a sign-out is rare and a
 * few hundred thousand lstat calls is the price of reaching every name. */
const CREDENTIAL_REVOCATION_SCAN_LIMIT = 500000;

/* WHERE A FAILED SWEEP IS REPORTED, WITHOUT THE PERSON'S PROFILE PATH. Refusal
 * details travel to the application and its logs; a path inside agent-home is
 * named relative to it. */
function confinedRelativeName(confinedRoot, file) {
  const relative = path.relative(confinedRoot, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? path.join(CONFINED_HOME_LEAF, relative)
    : CONFINED_HOME_LEAF;
}

/* THE SIGN-OUT HALF OF THE FAN-OUT FIX, NOW CALLED (c41e071 wrote it; nothing
 * called it). Every confined name of the credential that was just revoked is
 * removed from the product's own agent-home, not only the one home a prepare
 * happens to be building: those are the names a retired agent or a closed
 * session left behind, and each one is a working sign-in the person believes
 * they revoked. `confinedRoot` is always <services root>/agent-home, never the
 * person's own home or an account home. Returns the failures in the scrub's own
 * shape; a scan that stopped early is a failure too, because "revoked" must not
 * be heard when a name may have survived.
 *
 * TWO WAYS A NAME IS FOUND, BECAUSE A REFRESH SPLITS THE FILE.
 *   - By inode (`identity`): every name that is still the revoked file. This is
 *     the only test for a home prepared before the source marker existed.
 *   - By recorded source (`source`): every home whose CREDENTIAL_SOURCE_MARKER
 *     names the revoked sign-in, whatever its lineage. A provider refresh inside
 *     a confined home renames a NEW file over its name, and the family heal then
 *     deliberately brings its siblings onto that new file -- so after one
 *     refresh the names holding the LIVE token are exactly the ones an inode
 *     match cannot reach. Measured before this: a removed account's receipt said
 *     confinedCopiesRevoked: true while two confined homes still held its live
 *     token, and a sign-out left the refreshed home's token working.
 * Another account's sign-in is a different file AND records a different source,
 * so neither test reaches it. */
function revokeConfinedCopies(confinedRoot, identity, { source = null } = {}) {
  const key = source ? credentialSourceKey(source) : null;
  if (!confinedRoot || (!identity && !key)) return Object.freeze({ removed: 0, failures: Object.freeze([]) });
  const removed = new Set();
  const failures = [];
  let complete = true;
  const take = (sweep) => {
    for (const file of sweep.removed) removed.add(path.resolve(file));
    for (const failure of sweep.failures) {
      failures.push(Object.freeze({
        operation: `revoke-${failure.operation}`,
        file: confinedRelativeName(confinedRoot, failure.file),
        cause: failure.cause
      }));
    }
    if (!sweep.complete) complete = false;
  };
  if (identity) take(revokeCredentialLinks(confinedRoot, identity, { limit: CREDENTIAL_REVOCATION_SCAN_LIMIT }));
  if (key) take(revokeRecordedSourceNames(confinedRoot, key, path.basename(source), { limit: CREDENTIAL_REVOCATION_SCAN_LIMIT }));
  if (!complete && failures.length === 0) {
    failures.push(Object.freeze({ operation: 'revoke-scan', file: CONFINED_HOME_LEAF, cause: 'SCAN_LIMIT' }));
  }
  return Object.freeze({ removed: removed.size, failures: Object.freeze(failures) });
}


function revokeRecordedSourceNames(searchRoot, key, leaf, { limit = 20000 } = {}) {
  const removed = [];
  const failures = [];
  let scanned = 0;
  let truncated = false;
  if (!searchRoot || !key || !leaf) return Object.freeze({ removed, failures, scanned, complete: false });
  const walk = (directory) => {
    if (truncated) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (cause) {
      if (!cause || cause.code !== 'ENOENT') {
        failures.push(Object.freeze({ operation: 'read', file: directory, cause: cause?.code || 'unknown' }));
      }
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      if ((scanned += 1) > limit) { truncated = true; return; }
      if (entry.name !== CREDENTIAL_SOURCE_MARKER) continue;
      const recorded = recordedCredentialFamily(directory);
      if (!recorded || recorded.source !== key) continue;
      const name = path.join(directory, leaf);
      let info;
      try { info = fs.lstatSync(name); } catch { continue; }
      if (!info.isFile()) continue;
      try { fs.rmSync(name, { force: true }); removed.push(name); }
      catch (cause) {
        failures.push(Object.freeze({ operation: 'unlink', file: name, cause: cause?.code || 'unknown' }));
      }
    }
  };
  walk(searchRoot);
  return Object.freeze({
    removed: Object.freeze(removed),
    failures: Object.freeze(failures),
    scanned,
    complete: !truncated && failures.length === 0
  });
}


// Retained only to revoke artifacts from older releases; no new family is recorded.
const CREDENTIAL_SOURCE_MARKER = 'toolsenabled-credential-source.json';
const CREDENTIAL_SOURCE_MARKER_MAX_BYTES = 8192;

/* THE KEY A SIGN-IN IS FILED UNDER, the same on every side that files or finds
 * it: the prepare that records it (the person's or account's own file), the
 * sign-out scrub, and account removal (registry-write and the app store, which
 * name the file as signInFilePath(resolvedHome, spec)). Each side may spell the
 * same folder differently -- a relative or symlinked spelling, or, on Windows,
 * another letter case -- so the folder is resolved and, where it exists, taken
 * through realpath, and the key is case-folded on win32. A folder that cannot be
 * resolved keys by its resolved spelling. */
function credentialSourceKey(file, platform = process.platform) {
  if (typeof file !== 'string' || !file) return null;
  let resolved = path.resolve(file);
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync;
    resolved = path.join(realpath(path.dirname(resolved)), path.basename(resolved));
  } catch { /* keep the resolved spelling */ }
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}


function recordedCredentialFamily(home) {
  const marker = path.join(home, CREDENTIAL_SOURCE_MARKER);
  try {
    const info = fs.lstatSync(marker);
    if (!info.isFile() || info.size > CREDENTIAL_SOURCE_MARKER_MAX_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (!parsed || typeof parsed.source !== 'string') return null;
    return Object.freeze({ source: parsed.source, lineage: typeof parsed.lineage === 'string' ? parsed.lineage : null });
  } catch { return null; }
}

function scrubStartableHome(home, { error, artifacts }) {
  const failures = [];
  for (const file of artifacts) {
    try { fs.rmSync(path.join(home, file), { force: true }); } catch (cause) {
      failures.push({ operation: 'remove-artifact', file, cause: cause?.code || 'unknown' });
    }
  }
  if (failures.length) {
    throw new AgentConfinementRefusal('AGENT_CONFINEMENT_HOME_SCRUB_INCOMPLETE',
      'The assistant home was refused, but whether its startable artifacts were removed could not be established.',
      { refusal: error?.code || 'unknown', failures });
  }
}

// Keep the existing private-account, profile and generated-artifact identity
// checks even though CODEX_HOME now selects the original account home.
function requirePrivateAccount(provider, home, name, servicesRoot, machineRecord) {
  if (!providerIsolation.isolationRequested()) return null;
  const context = providerIsolation.isolationContext(process.env, {
    servicesRoot: servicesRoot || machineRecord.resolveServicesRoot({})
  });
  if (typeof name !== 'string' || !name.trim() || typeof home !== 'string' || !home.trim()) {
    throw new AgentConfinementRefusal('AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED',
      'Select a private named provider account before starting this session.', {});
  }
  providerIsolation.assertIsolatedPath(home, context, { field: `${provider} account home` });
  const registry = require('./multi-account/registry');
  providerIsolation.assertIsolatedCredential(registry.signInFilePath(home, registry.providerSpec(provider)), context);
  return context;
}

function prepareConfinedCodexHome(confinement, {
  record,
  servicesRoot,
  accountHome = installationProfileRoot(),
  userCodexHome = null,
  accountName = null,
  agentId = null,
  sessionId = null,
  sessionCredential = null,
  roleFunctionsOnly = false,
  agentApiMode = 'Enabled',
  machineRecord = machineRecordModule(),
  generate = null
} = {}) {
  if (!confinement || confinement.isolated !== true) {
    throw new AgentConfinementRefusal('AGENT_CONFINEMENT_NOT_ISOLATED',
      'Only a confined permission level has an isolated assistant home.', {});
  }
  const privateContext = requirePrivateAccount('codex', userCodexHome, accountName, servicesRoot, machineRecord);
  const profileRoot = installationProfileRoot();
  const boundaryHome = assertAccountProfilePath(accountHome, {
    field: 'account home', profileRoot, requireOwnedProfile: process.platform === 'win32'
  });
  const sourceHome = assertAccountProfilePath(
    userCodexHome || path.join(boundaryHome, '.codex'),
    { field: 'Codex sign-in home', profileRoot }
  );
  const root = assertAccountProfilePath(
    servicesRoot || machineRecord.resolveServicesRoot({}),
    { field: 'services root', profileRoot }
  );
  const leaf = accountSegment(accountName);
  const agent = declaredAgentSegment(agentId);
  const session = sessionAuthoritySegment(sessionId, sessionCredential);
  const home = assertAccountProfilePath(session
    ? path.join(
        root,
        CONFINED_HOME_LEAF,
        ...(agent ? [AGENT_HOME_NAMESPACE, agent] : []),
        SESSION_HOME_NAMESPACE,
        session,
        'codex',
        confinement.tier,
        leaf || DEFAULT_AGENT_ACCOUNT_LEAF
      )
    : agent
    ? path.join(root, CONFINED_HOME_LEAF, AGENT_HOME_NAMESPACE, agent, 'codex', confinement.tier, leaf || DEFAULT_AGENT_ACCOUNT_LEAF)
    : leaf
      ? path.join(root, CONFINED_HOME_LEAF, confinement.tier, leaf)
      : path.join(root, CONFINED_HOME_LEAF, confinement.tier),
  { field: 'generated Codex home', profileRoot });
  providerIsolation.assertIsolatedPath(home, privateContext);
  // Runtime history now belongs to the official account home as well.
  // Keep its state path stable across fresh ToolsEnabled session authorities
  // so native resume can find a paginated thread. Windows SQLite still needs
  // a compact path when the selected account home itself exceeds its budget.
  const sqliteHome = process.platform === 'win32' && sourceHome.length > 220
    ? assertAccountProfilePath(path.join(root, 'agent-db',
      crypto.createHash('sha256').update(sourceHome, 'utf8').digest('base64url')),
    { field: 'generated Codex database home', profileRoot })
    : sourceHome;
  if (process.platform === 'win32' && sqliteHome.length > 220) {
    throw new AgentConfinementRefusal('AGENT_CONFINEMENT_STATE_PATH_TOO_LONG',
      'The assistant state directory is too long for Windows SQLite. Choose a shorter application data location.', {});
  }
  fs.mkdirSync(home, { recursive: true });
  const signInFile = require('./multi-account/registry').providerSpec('codex').signInFile;
  let accountFenceTarget = null;

  try {
    assertAccountMarker(home, leaf ? accountName : null);
    if (sqliteHome !== sourceHome) fs.mkdirSync(sqliteHome, { recursive: true });

    // The tool surface this level may carry, from the ONE generator the rest of
    // the product already writes `.mcp.json` from. Rendering the same document
    // into the two formats two engines read is the point: a tool refused in
    // `.mcp.json` and admitted here would be two answers to one question.
    let document = { mcpServers: {} };
    if (record && agentApiMode !== 'Disabled') {
      const generator = generate || machineRecord.generateMcpConfig;
      /* `agentActor` is constant here and that is a property of the directory, not
         a simplification: this home is only ever a Codex home. A per-SESSION value
         would be a genuine race -- the file is rewritten on every start and the
         home is shared by tier and account, so session B's start would rewrite it
         while Codex A was still reading it. Session identity is resolved
         elsewhere, deliberately. */
      /* `stateRoot` is the application's OWN record directory, read from the
         environment of the process planning this session -- the app sets
         TOOLSENABLED_STATE_ROOT before anything is required. Absent (a checkout, a
         test, a CLI), it is null and nothing is stamped, which is byte-for-byte
         the file this has always written. See the note at the stamp itself for
         the two-node drive that found the split. */
      document = generator(generationRecord(record), {
        agentActor: 'codex',
        agentApiMode,
        agentId: agent,
        sessionCredential,
        stateRoot: stateRootForGeneratedServers(),
        ...(roleFunctionsOnly ? { browserTools: false } : {})
      }).document;
    }

    accountFenceTarget = syncAccountFence(home, CODEX_ACCOUNT_FENCE_FILE, boundaryHome);
    providerIsolation.assertIsolatedPath(path.join(sourceHome, signInFile), privateContext);
    assertCodexSignedIn(path.join(sourceHome, signInFile));
    const codexConfig = confinedCodexConfig(confinement, document, machineRecord, sqliteHome, roleFunctionsOnly);
    if (fs.existsSync(accountFenceTarget)) {
      codexConfig.developer_instructions = [fs.readFileSync(accountFenceTarget, 'utf8'),
        codexConfig.developer_instructions].filter(Boolean).join('\n\n');
    }
    const codexArgs = codexConfigOverrideArgs(codexConfig);

    return Object.freeze({
      codexHome: sourceHome,
      agentHome: home,
      codexArgs,
      codexConfig: Object.freeze(codexConfig),
      account: leaf ? accountName : null,
      servers: Object.freeze(Object.keys(document.mcpServers || {})),
      env: Object.freeze({ ...codexForwardedEnvironment(document, machineRecord), ...accountProfileEnvironment(profileRoot), CODEX_HOME: sourceHome })
    });
  } catch (error) {
    // Only product-generated artifacts are scrubbed. Authentication stays
    // under official-client custody, even when preparation is refused.
    scrubStartableHome(home, {
      error,
      artifacts: ['config.toml', ...(accountFenceTarget ? [CODEX_ACCOUNT_FENCE_FILE] : [])]
    });
    throw error;
  }
}

// --- the tool surface, without relocating sign-in --------------------------

const CLAUDE_TOOLS_LEAF = 'agent-tools';

/* WHO GETS THE THIRD PROCESS.
 *
 * Every generated surface starts a browser gateway beside the two tool servers,
 * so an assistant costs THREE electron processes. This computer resumed nine
 * assistants between 21:15:50 and 21:24:31 local on 2026-09-03 and died at
 * 21:26:20 with the CPU pegged.
 *
 * MEASURED the same evening, three consecutive runs of the exact command the
 * generated document spells (REPORT-crash-20260903/evidence/C/
 * playwright-gateway-lifetime.txt): with no ToolsEnabled-owned browser running,
 * src/playwright-gateway.js writes "The ToolsEnabled-owned browser could not be
 * revalidated" and EXITS 2 after 835-1170 ms. It advertises no tool and answers
 * no call. So for an assistant started while no browser is owned -- which is
 * every assistant on a machine where nobody has run browser.start -- that third
 * process is a start cost and a failed server in the client's log, and nothing
 * else.
 *
 * THE RULE, and it is deliberately narrow: a DECLARED AGENT -- a circle the
 * application spawned and bound to an organisation id -- is generated without
 * it. THE PERSON'S OWN SESSION IS NOT TOUCHED (`agent` is null there), because
 * the owner's rule is that the person is never quietly given less. An explicit
 * `browserTools` on the call wins over both, so a caller that knows this circle
 * has browser work says so and gets it.
 */
function browserToolsForSurface(agent, stated) {
  if (typeof stated === 'boolean') return stated;
  return !agent;
}

/* Concurrent starts at one tier write these two files with identical bytes, so
   the race is benign in content but not in READING: a half-written document is
   a session with no tools and a refusal that names the wrong thing. Written
   through a temporary name and renamed, so a reader sees the old file or the
   new one and never a partial. */
function writeAtomic(file, contents) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, 'utf8');
  fs.renameSync(temporary, file);
}

/**
 * The tool document and the grant that makes it callable, for ONE recorded
 * level, plus an explicit pointer to the existing in-profile configuration
 * directory. It never reads, copies or links that directory's credential.
 *
 * Returns the two paths the engine passes as arguments. RAISES rather than
 * returning a partial surface: a session that cannot be given the level's
 * tools is refused, not started with someone else's.
 */
function prepareGeneratedToolSurface(confinement, {
  provider = 'claude',
  client = null,
  record,
  servicesRoot,
  accountHome = installationProfileRoot(),
  configDir = null,
  accountName = null,
  homeCreatedByApp = false,
  agentId = null,
  sessionId = null,
  sessionCredential = null,
  roleFunctionsOnly = false,
  agentApiMode = 'Enabled',
  /* Stated by a caller that knows this assistant has browser work; otherwise
     decided by browserToolsForSurface() above. `null` means "not stated". */
  browserTools = null,
  machineRecord = machineRecordModule(),
  generate = null
} = {}) {
  if (!['claude', 'gemini', 'grok', 'local'].includes(provider)) {
    throw new AgentConfinementRefusal('AGENT_CONFINEMENT_PROVIDER_INVALID', 'This assistant program is not supported.', {});
  }
  if (browserTools !== null && typeof browserTools !== 'boolean') {
    throw new AgentConfinementRefusal('AGENT_CONFINEMENT_BROWSER_TOOLS_INVALID',
      'Whether this assistant has browser work must be stated as true or false, or left unstated.', {});
  }
  if (!confinement || confinement.isolated !== true) {
    throw new AgentConfinementRefusal('AGENT_CONFINEMENT_NOT_ISOLATED',
      'Only a confined permission level has a generated tool surface.', {});
  }
  // Local inference has no provider sign-in. It still uses the same private
  // services/profile boundary and generated, session-bound tool document.
  const privateContext = provider === 'local'
    ? providerIsolation.isolationContext(process.env, { servicesRoot: servicesRoot || machineRecord.resolveServicesRoot({}) })
    : requirePrivateAccount(provider, configDir, accountName, servicesRoot, machineRecord);
  const profileRoot = installationProfileRoot();
  const boundaryHome = assertAccountProfilePath(accountHome, {
    field: 'account home', profileRoot, requireOwnedProfile: process.platform === 'win32'
  });
  const nativeClaudeHome = provider === 'claude' && !configDir
    ? process.platform === 'win32'
      ? Object.entries(process.env).find(([name]) => name.toUpperCase() === 'CLAUDE_CONFIG_DIR')?.[1]
      : process.env.CLAUDE_CONFIG_DIR
    : null;
  const selectedConfigDir = provider === 'local' ? null : assertAccountProfilePath(
    configDir || nativeClaudeHome || (provider === 'gemini' ? boundaryHome : path.join(boundaryHome, `.${provider}`)),
    { field: 'Claude configuration home', profileRoot }
  );
  const root = assertAccountProfilePath(
    servicesRoot || machineRecord.resolveServicesRoot({}),
    { field: 'services root', profileRoot }
  );
  const agent = declaredAgentSegment(agentId);
  const session = sessionAuthoritySegment(sessionId, sessionCredential);
  const directory = assertAccountProfilePath(
    path.join(
      root,
      CLAUDE_TOOLS_LEAF,
      provider,
      ...(agent ? [AGENT_HOME_NAMESPACE, agent] : []),
      ...(session ? [SESSION_HOME_NAMESPACE, session] : []),
      confinement.tier
    ),
    { field: 'generated Claude tool surface', profileRoot }
  );
  providerIsolation.assertIsolatedPath(directory, privateContext);
  fs.mkdirSync(directory, { recursive: true });

  const mcpConfig = path.join(directory, '.mcp.json');
  const settings = path.join(directory, 'settings.json');
  try {
    // The ONE generator every other surface reads, stamped with the calling
    // principal exactly as both home builders stamp theirs.
    let document = { mcpServers: {} };
    if (record && agentApiMode !== 'Disabled') {
      const generator = generate || machineRecord.generateMcpConfig;
      document = generator(generationRecord(record), {
        agentActor: provider,
        agentApiMode,
        agentId: agent,
        sessionCredential,
        stateRoot: stateRootForGeneratedServers(),
        browserTools: roleFunctionsOnly ? false : browserToolsForSurface(agent, browserTools)
      }).document;
    }
    const entries = validateServerEntries(document, machineRecord);
    for (const [name, entry] of entries) refuseNonNodeRuntime(name, entry, machineRecord);
    const servers = entries.map(([name]) => name);

    if (provider === 'local') {
      writeAtomic(mcpConfig, `${JSON.stringify(document, null, 2)}\n`);
      return Object.freeze({ mcpConfig, env: accountProfileEnvironment(profileRoot), account: null, servers: Object.freeze(servers) });
    }

    if (provider === 'gemini' && client === 'antigravity') {
      return require('./agent-engine/antigravity-confinement').prepareAntigravitySurface({
        directory, configDir: selectedConfigDir, entries, env: accountProfileEnvironment(profileRoot),
        account: accountName, homeCreatedByApp, agentApiMode, writeAtomic
      });
    }
    if (provider !== 'claude') {
      return require('./agent-engine/acp-confinement').prepareAcpSurface({
        provider, directory, configDir: selectedConfigDir, entries, servers,
        env: accountProfileEnvironment(profileRoot), account: accountName,
        agentApiMode, writeAtomic
      });
    }

    writeAtomic(mcpConfig, `${JSON.stringify(document, null, 2)}\n`);

    // THE GRANT, and why it is not optional. MEASURED off claude 2.1.186:
    // without it the servers CONNECT and every call comes back
    // permission-not-granted, because a --print session has no one to ask --
    // tools advertised that can never run. `defaultMode` records the tier's own
    // mode in the same file the argv names, so the file bounds what the argv
    // bounds. The allow list names the plan's SERVERS only; which TOOLS each
    // server advertises is already narrowed per tier, server-side, by the
    // generator (TOOLSENABLED_TOOL_ALLOWLIST).
    const { claudeServerPermissionRule } = require('./agent-engine/claude-cli-adapter');
    writeAtomic(settings, `${JSON.stringify({
      ...(roleFunctionsOnly ? { disableAllHooks: true, enabledPlugins: {} } : {}),
      permissions: {
        defaultMode: confinement.claudePermissionMode,
        allow: servers.map(claudeServerPermissionRule)
      }
    }, null, 2)}\n`);

    return Object.freeze({
      mcpConfig,
      settings,
      configDir: selectedConfigDir,
      env: accountProfileEnvironment(profileRoot),
      account: accountName,
      servers: Object.freeze(servers)
    });
  } catch (error) {
    /* No credential is ever linked here, so there is nothing authenticated to
       scrub -- only the product's own generated pair, which must not be left
       half-written for the next start to read. */
    scrubStartableHome(directory, { error, artifacts: ['.mcp.json', 'settings.json'] });
    throw error;
  }
}

function prepareClaudeToolSurface(confinement, options = {}) {
  if (options.provider !== undefined && !['claude', 'gemini', 'grok'].includes(options.provider)) {
    throw new AgentConfinementRefusal('AGENT_CONFINEMENT_PROVIDER_INVALID', 'This assistant program is not supported.', {});
  }
  return prepareGeneratedToolSurface(confinement, options);
}

// --- one plan builder, three engines ------------------------------------------
//
// The success, refusal and pass-through shapes used to be six hand-spelled
// frozen literals across two near-identical functions, and they had already
// drifted once (a comment lost in the copy; a TypeError in one prepare
// surfacing differently than in the other). One builder means one answer to
// every shared question -- what a refusal carries, what an account must look
// like, which values a caller may override -- and each engine contributes only
// its SURFACE: the fields its own engine consumes.

const EMPTY_SERVERS = Object.freeze([]);

function acpPlanEngine(provider) {
  return Object.freeze({
    acp: true,
    passThroughNonIsolated: false,
    prepare: (resolved, options) => prepareClaudeToolSurface(resolved, { ...options, provider }),
    accountOverrides: account => ({ accountName: account.name, configDir: account.resolvedHome }),
    emptySurface: () => ({ env: null, configDir: null, acp: null, servers: EMPTY_SERVERS }),
    surfaceOf: surface => ({ env: surface.env, configDir: surface.configDir, acp: surface.acp, servers: surface.servers })
  });
}

const PLAN_ENGINES = Object.freeze({
  local: Object.freeze({
    requiresProviderAccount: false,
    passThroughNonIsolated: false,
    prepare: (resolved, options) => prepareGeneratedToolSurface(resolved, { ...options, provider: 'local', configDir: null, accountName: null }),
    emptySurface: () => ({ env: null, mcpConfig: null, servers: EMPTY_SERVERS }),
    surfaceOf: surface => ({ env: surface.env, mcpConfig: surface.mcpConfig, servers: surface.servers })
  }),
  antigravity: Object.freeze({
    acp: true, passThroughNonIsolated: false,
    prepare: (resolved, options) => prepareClaudeToolSurface(resolved, { ...options, provider: 'gemini', client: 'antigravity' }),
    accountOverrides: account => {
      if (account.client !== 'antigravity') throw new AgentConfinementRefusal('ACCOUNT_CLIENT_UNAVAILABLE', 'Select an Antigravity account.');
      return { accountName: account.name, configDir: account.resolvedHome, homeCreatedByApp: account.homeCreatedByApp === true };
    },
    emptySurface: () => ({ env: null, configDir: null, antigravity: null, servers: EMPTY_SERVERS }),
    surfaceOf: surface => ({ env: surface.env, configDir: surface.configDir, antigravity: surface.antigravity, servers: surface.servers })
  }),
  gemini: acpPlanEngine('gemini'),
  grok: acpPlanEngine('grok'),
  codex: Object.freeze({
    /* The codex plan keeps its documented pass-through for a non-isolated
       tier. No such tier exists today; the branch is shape, not behaviour. */
    passThroughNonIsolated: true,
    prepare: (resolved, prepareOptions) => prepareConfinedCodexHome(resolved, prepareOptions),
    accountOverrides: account => ({ userCodexHome: account.resolvedHome, accountName: account.name }),
    // The official sign-in stays in place; restrictions travel on argv.
    emptySurface: () => ({ env: null, codexHome: null, agentHome: null, codexArgs: null, codexConfig: null, servers: EMPTY_SERVERS }),
    surfaceOf: home => ({ env: home.env, codexHome: home.codexHome, agentHome: home.agentHome,
      codexArgs: home.codexArgs, codexConfig: home.codexConfig, servers: home.servers })
  }),
  /* THE SHIPPED CLAUDE PATH. Tools by argument, no copied home or credential -- see
     the note above prepareClaudeToolSurface() for why this is the half that
     ships. `configDir` explicitly pins the existing configuration directory
     inside this installation's Windows account; no ambient home lookup remains. */
  claudeTools: Object.freeze({
    /* No pass-through: a non-isolated level has no generated surface, and a
       plan that quietly succeeded with nothing in it would be a session with
       no tools wearing a success code -- the defect this path exists to end. */
    passThroughNonIsolated: false,
    prepare: (resolved, prepareOptions) => prepareClaudeToolSurface(resolved, prepareOptions),
    /* The selected account directory is pointed to, never copied or opened. */
    accountOverrides: account => ({ accountName: account.name, configDir: account.resolvedHome }),
    emptySurface: resolved => ({
      env: null, configDir: null, mcpConfig: null, settings: null,
      claudePermissionMode: resolved.claudePermissionMode || null, servers: EMPTY_SERVERS
    }),
    surfaceOf: (surface, resolved) => ({
      env: surface.env, configDir: surface.configDir, mcpConfig: surface.mcpConfig, settings: surface.settings,
      claudePermissionMode: resolved.claudePermissionMode || null, servers: surface.servers
    })
  }),

});

function buildConfinedSessionPlan(options, engine, prepare = true) {
  const resolved = resolveAgentConfinement(options);
  let apiMode = 'Only';
  let apiModeError = null;
  if (!resolved.boundaryRefused) {
    try {
      const policy = require('./agent-api-policy');
      apiMode = options.agentApiMode === undefined
        ? policy.agentApiMode()
        : policy.normalizeAgentApiMode(options.agentApiMode);
      if (!apiMode) throw new Error('Unknown agent API mode.');
    } catch (error) { apiModeError = error; }
  }
  const roleFunctionsOnly = options?.roleFunctionsOnly === true || apiMode === 'Only';
  const threadOptions = Object.freeze({
    sandbox: roleFunctionsOnly ? 'read-only' : resolved.sandbox,
    approvalPolicy: resolved.approvalPolicy
  });
  const refusal = (code, accountName) => Object.freeze({
    ok: false, tier: resolved.tier, failedClosed: true, isolated: true, code,
    threadOptions, ...engine.emptySurface(resolved), account: accountName,
    agentApiMode: apiModeError || resolved.boundaryRefused ? null : apiMode,
    ...(roleFunctionsOnly ? { roleFunctionsOnly: true } : {})
  });
  if (resolved.boundaryRefused === true) return refusal(resolved.code, null);
  if (apiModeError) return refusal('AGENT_API_MODE_UNAVAILABLE', null);
  // Resolve the same provider capability matrix exposed by Settings using
  // the actual planner transport. No renderer-selected provider is trusted.
  if (apiMode === 'Optimized') {
    const provider = engine === PLAN_ENGINES.claudeTools ? 'claude'
      : engine === PLAN_ENGINES.codex ? 'codex'
      : engine === PLAN_ENGINES.gemini || engine === PLAN_ENGINES.antigravity ? 'gemini'
      : engine === PLAN_ENGINES.grok ? 'grok' : engine === PLAN_ENGINES.local ? 'local' : null;
    const support = require('./agent-api-policy').optimizedToolSupport({
      provider, roleFunctionsOnly
    });
    if (support.status !== 'supported') return refusal('AGENT_OPTIMIZED_TOOLS_UNSUPPORTED', null);
  }
  // New ACP engines expose only the scoped, app-owned tool servers. They must
  // never silently promise native tools or inherit the provider's own servers.
  if (engine.acp && apiMode !== 'Only') return refusal('AGENT_ACP_REQUIRES_APP_TOOLS', null);
  const selectedToolMode = require('./agent-api-mode').TOOL_MODES[apiMode];
  if (options?.roleFunctionsOnly !== undefined && typeof options.roleFunctionsOnly !== 'boolean') {
    return refusal('AGENT_ROLE_TOOL_RESTRICTION_INVALID', null);
  }
  if (options.roleFunctionsOnly === true && apiMode === 'Disabled') {
    return refusal('AGENT_TOOL_MODE_ROLE_CONFLICT', null);
  }

  /* THE ACCOUNT IS VALIDATED HERE, ONCE, FOR BOTH ENGINES, and silently
   * "helping" is exactly what is refused. An account passed as a bare string
   * used to be DISCARDED, running the session from the owner's default home
   * under a log line that named nobody; an account object with no usable
   * `resolvedHome` used to spread `undefined` into the prepare, fire its
   * destructuring default, and hard-link the OWNER'S credential into a home
   * labelled with somebody else's name. Both end as a session running as the
   * wrong identity while every visible signal says it succeeded. */
  const rawAccount = options && options.account !== undefined && options.account !== null
    ? options.account
    : null;
  if (rawAccount !== null && (typeof rawAccount !== 'object' || Array.isArray(rawAccount))) {
    return refusal('AGENT_CONFINEMENT_ACCOUNT_INVALID', null);
  }
  const account = rawAccount;
  if (engine.requiresProviderAccount === false && account !== null) {
    return refusal('AGENT_CONFINEMENT_ACCOUNT_INVALID', null);
  }
  if (prepare && engine.requiresProviderAccount !== false && account === null && providerIsolation.isolationRequested()) {
    return refusal('AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED', null);
  }
  if (account !== null && (
    typeof account.name !== 'string' || account.name.trim().length === 0
    || typeof account.resolvedHome !== 'string' || account.resolvedHome.trim().length === 0
  )) {
    return refusal(
      'AGENT_CONFINEMENT_ACCOUNT_UNRESOLVED',
      typeof account.name === 'string' && account.name.length > 0 ? account.name : null
    );
  }
  if (account !== null) {
    try {
      providerIsolation.assertIsolatedPath(account.resolvedHome, providerIsolation.isolationContext(), { field: 'selected account home' });
      assertAccountProfilePath(account.resolvedHome, {
        field: 'selected account home', profileRoot: resolved.profileRoot
      });
    } catch (error) {
      return refusal((error && error.code) || 'AGENT_CONFINEMENT_FOREIGN_PROFILE', account.name);
    }
  }

  if (!prepare) {
    try {
      // Validate the same identity/path inputs without opening a default
      // credential or publishing a startable home before account selection.
      declaredAgentSegment(options.agentId);
      sessionAuthoritySegment(options.sessionId, options.sessionCredential);
      accountSegment(account ? account.name : null);
      return Object.freeze({
        ok: true, prepared: false, preflightVersion: 1,
        tier: resolved.tier, code: resolved.code, failedClosed: resolved.failedClosed,
        isolated: resolved.isolated, threadOptions, ...engine.emptySurface(resolved),
        env: { ...accountProfileEnvironment(resolved.profileRoot), TOOLSENABLED_AGENT_TOOL_MODE: selectedToolMode }, account: account ? account.name : null,
        agentApiMode: apiMode,
        ...(roleFunctionsOnly ? { roleFunctionsOnly: true } : {})
      });
    } catch (error) {
      return refusal(error?.code || 'AGENT_CONFINEMENT_UNAVAILABLE', account ? account.name : null);
    }
  }

  if (engine.passThroughNonIsolated && resolved.isolated !== true && apiMode === 'Enabled'
    && !providerIsolation.isolationRequested()) {
    return Object.freeze({
      ok: true, tier: resolved.tier, code: resolved.code, failedClosed: resolved.failedClosed,
      isolated: false, threadOptions, ...engine.emptySurface(resolved),
      env: { ...accountProfileEnvironment(resolved.profileRoot), TOOLSENABLED_AGENT_TOOL_MODE: selectedToolMode },
      account: account ? account.name : null, agentApiMode: apiMode
    });
  }
  try {
    /* `...options` FIRST, resolved values LAST, and the order is the security
       property: the record and services root a plan builds from are the ones
       resolveAgentConfinement() read off this machine, never a caller-supplied
       substitute -- a hostile or stale `record` key would otherwise write one
       tier's tool width into another tier's home, because the resolver ignores
       it while the generator would not. The account override sits after both,
       so a caller cannot pass a home that disagrees with the account it also
       passed. */
    const home = engine.prepare(resolved, {
      ...options,
       agentApiMode: apiMode,
       roleFunctionsOnly,
       record: resolved.record,
       servicesRoot: resolved.servicesRoot,
       accountHome: resolved.profileRoot,
       ...(account ? engine.accountOverrides(account) : {})
    });
    return Object.freeze({
      ok: true, tier: resolved.tier, code: resolved.code, failedClosed: resolved.failedClosed,
      isolated: true, threadOptions, ...engine.surfaceOf(home, resolved), account: home.account,
      env: Object.freeze({ ...home.env, TOOLSENABLED_AGENT_TOOL_MODE: selectedToolMode }),
      agentApiMode: apiMode,
      ...(roleFunctionsOnly ? { roleFunctionsOnly: true } : {})
    });
  } catch (error) {
    // The process confinement still stands -- threadOptions is what the OS
    // enforces, and it is already resolved. What could not be built is the
    // narrower surface, so the session is REFUSED rather than started with
    // the user's own servers -- or the owner's own home -- under a level that
    // does not permit them.
    return refusal(
      (error && error.code) || 'AGENT_CONFINEMENT_HOME_UNAVAILABLE',
      account ? account.name : null
    );
  }
}

/**
 * THE PLAN THE PRODUCT SHIPS. Everything the agent host needs to start ONE
 * Claude session at the recorded level, as ARGUMENTS the session reads --
 * `mcpConfig` (--mcp-config with --strict-mcp-config), `settings` (--settings,
 * the grant without which every configured tool answers
 * permission-not-granted) and `claudePermissionMode` (--permission-mode) --
 * travelling on ONE object so they cannot be recombined from different plans.
 *
 * `configDir` explicitly names the owning profile's existing `.claude` directory
 * (or the selected account directory). No credential is copied or linked, so
 * the official client keeps managing the sign-in in place; the explicit path
 * prevents stale ambient home variables from selecting another profile's
 * CLAUDE.md. See the note above prepareClaudeToolSurface().
 *
 * A SURFACE THAT CANNOT BE BUILT REFUSES THE START (`ok: false`) rather than
 * falling back to no tools, which is the defect this path exists to end.
 */
function claudeToolsSessionPlan(options = {}) {
  return buildConfinedSessionPlan(options, PLAN_ENGINES.claudeTools);
}

function localSessionPlan(options = {}) {
  return buildConfinedSessionPlan(options, PLAN_ENGINES.local);
}

/**
 * Everything desktop-app/shell/agent-host.cjs needs to start ONE session at
 * the recorded level: the thread options that confine the process and the
 * environment that bounds what it can reach around the process.
 *
 * Never throws. The agent host's job is to start the safest session it can, and
 * a host that throws when the record is unreadable is a host whose safe path is
 * the one that does not run.
 */
// The selected account names the official Codex sign-in home. Null selects
// the owning profile's default home; neither case relocates authentication.
function confinedSessionPlan(options = {}) {
  return buildConfinedSessionPlan(options, PLAN_ENGINES.codex);
}

// This is not a runnable plan. A recognizing host must select the account and
// call the ordinary plan builder before binding or starting a provider.
function preflightSessionPlan(options = {}) {
  const engine = options.provider === 'gemini' && options.client === 'antigravity' ? PLAN_ENGINES.antigravity
    : options.provider === 'codex' ? PLAN_ENGINES.codex
    : options.provider === 'claude' ? PLAN_ENGINES.claudeTools
      : ['gemini', 'grok'].includes(options.provider) ? PLAN_ENGINES[options.provider] : null;
  if (!engine) return Object.freeze({ ok: false, code: 'AGENT_CONFINEMENT_PROVIDER_INVALID' });
  return buildConfinedSessionPlan(options, engine, false);
}

function antigravitySessionPlan(options = {}) {
  if (options.provider !== 'gemini' || options.client !== 'antigravity' || !options.account) return Object.freeze({ ok: false, code: 'ACCOUNT_CLIENT_UNAVAILABLE' });
  return buildConfinedSessionPlan(options, PLAN_ENGINES.antigravity);
}

function acpSessionPlan(options = {}) {
  if (!['gemini', 'grok'].includes(options.provider)) return Object.freeze({ ok: false, code: 'AGENT_CONFINEMENT_PROVIDER_INVALID' });
  return buildConfinedSessionPlan(options, PLAN_ENGINES[options.provider]);
}

// Kept behind this already-shipped host module so the desktop shell loads the
// session authority from the exact same payload root as its confinement plan.
// The implementation is a sibling module to keep named-pipe protocol code out
// of the filesystem planner above; the payload walker follows this require.
function mintAgentSessionCredential() {
  return require('./agent-session-credential').mintAgentSessionCredential();
}

function bindAgentSessionCredential(binding, options) {
  return require('./agent-session-credential').bindAgentSessionCredential(binding, options);
}

function revokeAgentSessionCredential(binding, options) {
  return require('./agent-session-credential').revokeAgentSessionCredential(binding, options);
}

module.exports = Object.freeze({
  localSessionPlan,
  acpSessionPlan,
  antigravitySessionPlan,
  PROVIDER_SESSION_ISOLATION_VERSION: providerIsolation.PROVIDER_SESSION_ISOLATION_VERSION,
  ACCOUNT_SELECTION_PREFLIGHT_VERSION: 1,
  preflightSessionPlan,
  accountSegment,
  INSTALL_TIER_AGENT_CONFINEMENT,
  FAIL_CLOSED_TIER,
  CONFINED_HOME_LEAF,
  revokeCredentialLinks,
  credentialIdentity,
  revokeConfinedCopies,
  credentialSourceKey,
  CREDENTIAL_SOURCE_MARKER,
  AgentConfinementRefusal,
  installationProfileRoot,
  assertAccountProfilePath,
  accountProfileEnvironment,
  assertAccountProfileEnvironment,
  agentConfinement,
  agentConfinementFromRecord,
  failClosedConfinement,
  resolveAgentConfinement,
  mintAgentSessionCredential,
  bindAgentSessionCredential,
  revokeAgentSessionCredential,
  confinedCodexConfig,
  codexConfigOverrideArgs,
  generationRecord,
  stateRootForGeneratedServers,
  // The shared server-entry rules, also run by mission-bridge on its lane document.
  validateServerEntries,
  refuseNonNodeRuntime,
  prepareConfinedCodexHome,
  confinedSessionPlan,
  prepareClaudeToolSurface,
  claudeToolsSessionPlan
});
