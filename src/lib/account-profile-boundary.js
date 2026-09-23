'use strict';

// Dependency-light Windows account boundary shared by state-root resolution
// and agent-session preparation. Keep this module limited to Node built-ins:
// low-level observers import runtime-state-root and must not acquire the tool
// registry, providers, or fleet supervisor merely to validate a path.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class AgentConfinementRefusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentConfinementRefusal';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function isProvablyLocalWindowsHost(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const candidate = value.toLowerCase();
  if (candidate === 'localhost' || candidate === '127.0.0.1' || candidate === '[::1]') return true;
  try {
    return candidate === String(os.hostname() || '').toLowerCase();
  } catch {
    return false;
  }
}

function normalizeWindowsAccountPathAlias(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return Object.freeze({ supported: false, normalized: null, nonFilesystemDevice: false });
  }
  let normalized = path.win32.normalize(value.replace(/\//g, '\\'));
  if (/^\\\\\?\\UNC\\/i.test(normalized)) {
    normalized = normalized.replace(/^\\\\\?\\UNC\\/i, '\\\\');
  } else if (/^\\\\\?\\(?=[a-z]:\\)/i.test(normalized)) {
    normalized = normalized.replace(/^\\\\\?\\/i, '');
  } else if (/^\\\\\.\\(?:pipe|mailslot)(?:\\|$)/i.test(normalized)) {
    return Object.freeze({ supported: false, normalized, nonFilesystemDevice: true });
  } else if (
    /^\\\\[?.]\\/.test(normalized)
    || /^\\\?\?\\/.test(normalized)
    || /^\\\\\?\?\\/.test(normalized)
  ) {
    return Object.freeze({ supported: false, normalized, nonFilesystemDevice: false });
  }

  normalized = path.win32.normalize(normalized);
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(normalized);
  if (normalized.startsWith('\\\\') && !unc) {
    return Object.freeze({ supported: false, normalized, nonFilesystemDevice: false });
  }
  if (unc && /^[a-z]\$$/i.test(unc[2])) {
    const host = unc[1];
    const share = unc[2];
    const tail = unc[3] || '';
    if (isProvablyLocalWindowsHost(host)) {
      const drivePath = tail.length > 0 ? `${share[0]}:\\${tail}` : `${share[0]}:\\`;
      return Object.freeze({
        supported: true,
        normalized: path.win32.normalize(drivePath),
        nonFilesystemDevice: false
      });
    }
    return Object.freeze({ supported: false, normalized, nonFilesystemDevice: false });
  }
  if (unc && (/^users$/i.test(unc[2]) || /^users(?:\\|$)/i.test(unc[3] || ''))) {
    return Object.freeze({ supported: false, normalized, nonFilesystemDevice: false });
  }
  return Object.freeze({ supported: true, normalized, nonFilesystemDevice: false });
}

function windowsProfileRootOf(value) {
  const alias = normalizeWindowsAccountPathAlias(value);
  if (!alias.supported) return null;
  const match = /^([a-z]:\\users\\[^\\]+)(?:\\|$)/i.exec(alias.normalized);
  return match ? match[1] : null;
}

/* A per-user Electron/NSIS installation is rooted below
 * <profile>\AppData\Local\Programs. The prefix is the installed owner even
   * when Windows profiles were redirected away from the default profile parent. This is lexical
 * on purpose: deciding whether the launch token is the installed owner must
 * happen before any path from that token is opened. */
function windowsInstalledProfileRootOf(value) {
  const alias = normalizeWindowsAccountPathAlias(value);
  if (!alias.supported || !path.win32.isAbsolute(alias.normalized)) return null;
  const normalized = path.win32.resolve(alias.normalized);
  if (normalized.startsWith('\\\\')) return null;
  const marker = '\\appdata\\local\\programs\\';
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  const parsed = path.win32.parse(normalized);
  if (markerIndex <= parsed.root.length) return null;
  const profile = normalized.slice(0, markerIndex);
  return profile && !sameWindowsPath(profile, parsed.root)
    ? path.win32.normalize(profile)
    : null;
}

// Query metadata for the OS-owned long profile ONLY. A candidate path never
// becomes an argument, environment value, or filesystem lookup in this helper.
// PowerShell provides the Windows API without adding a native package to this
// dependency-light module. Missing/denied metadata is not alias authority.
function readOwnedProfileShortPath(profileRoot, {
  platform = process.platform,
  userInfo = os.userInfo,
  systemRoot = process.env.SystemRoot,
  execFileSync = require('node:child_process').execFileSync
} = {}) {
  if (platform !== 'win32') return null;
  try {
    const home = userInfo()?.homedir;
    if (!sameWindowsPath(home, profileRoot)) return null;
    const ownerAlias = normalizeWindowsAccountPathAlias(home);
    const owner = ownerAlias.supported ? ownerAlias.normalized : null;
    const windowsAlias = normalizeWindowsAccountPathAlias(systemRoot);
    const windows = windowsAlias.supported ? windowsAlias.normalized : null;
    // Do not search an inherited PATH, execute from a profile, or accept an
    // arbitrary SystemRoot program location. Nonstandard layouts fail closed
    // for optional short-name compatibility; long owner paths still work.
    if (!owner || !/^[a-z]:\\/i.test(owner) || owner.length > 1024
        || !windows || !/^[a-z]:\\windows\\?$/i.test(windows)) return null;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      "Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class ToolsEnabledOwnerShortName { [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint capacity); }'",
      '$buffer = [Text.StringBuilder]::new(32768)',
      '$size = [ToolsEnabledOwnerShortName]::GetShortPathName($env:TOOLSENABLED_PROFILE_ALIAS_QUERY, $buffer, 32768)',
      'if ($size -eq 0 -or $size -ge 32768) { exit 3 }',
      '[Console]::Write($buffer.ToString())'
    ].join('\n');
    const local = path.win32.join(owner, 'AppData', 'Local');
    const output = execFileSync(path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
    ], {
      cwd: windows, windowsHide: true, timeout: 5000, maxBuffer: 8192, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // A closed literal environment, not a merge with ambient credentials or
      // profile/search-path overrides. Add-Type's scratch stays owner-local.
      env: {
        SystemRoot: windows, WINDIR: windows, USERPROFILE: owner,
        APPDATA: path.win32.join(owner, 'AppData', 'Roaming'), LOCALAPPDATA: local,
        TEMP: path.win32.join(local, 'Temp'), TMP: path.win32.join(local, 'Temp'),
        TOOLSENABLED_PROFILE_ALIAS_QUERY: owner
      }
    });
    return normalizedOwnerShortPath(output, owner);
  } catch { return null; }
}

const ownerShortPaths = new Map();
function cachedOwnedProfileShortPath(profileRoot) {
  const key = path.win32.normalize(profileRoot).toLowerCase();
  if (!ownerShortPaths.has(key)) ownerShortPaths.set(key, readOwnedProfileShortPath(profileRoot));
  return ownerShortPaths.get(key);
}

function possiblyShortOwnerPrefix(candidate, profileRoot) {
  const candidateParts = path.win32.resolve(candidate).split('\\');
  const ownerParts = path.win32.resolve(profileRoot).split('\\');
  if (candidateParts.length < ownerParts.length) return false;
  let shortened = false;
  for (let index = 0; index < ownerParts.length; index += 1) {
    if (candidateParts[index].toLowerCase() === ownerParts[index].toLowerCase()) continue;
    // This is only a cheap reason to query the OWNER's metadata, never proof
    // that the candidate exists or permission to probe a guessed ~N sibling.
    if (index === 0 || !candidateParts[index].includes('~')) return false;
    shortened = true;
  }
  return shortened;
}

function normalizedOwnerShortPath(value, profileRoot) {
  if (typeof value !== 'string' || value.length > 1024 || /[\r\n\0]/.test(value)) return null;
  const alias = normalizeWindowsAccountPathAlias(value);
  if (!alias.supported || !/^[a-z]:\\/i.test(alias.normalized)
      || !sameWindowsPath(path.win32.parse(alias.normalized).root, path.win32.parse(profileRoot).root)
      || path.win32.resolve(alias.normalized).split('\\').length
        !== path.win32.resolve(profileRoot).split('\\').length
      || (!sameWindowsPath(alias.normalized, profileRoot)
        && !possiblyShortOwnerPrefix(alias.normalized, profileRoot))) return null;
  return alias.normalized;
}

function ownedAliasAsLongPath(candidate, profileRoot, resolveProfileShortPath) {
  if (windowsPathInside(candidate, profileRoot)) return candidate;
  if (!possiblyShortOwnerPrefix(candidate, profileRoot)) return null;
  let short;
  try { short = resolveProfileShortPath(profileRoot); } catch { return null; }
  const shortProfile = normalizedOwnerShortPath(short, profileRoot);
  if (shortProfile === null || !windowsPathInside(candidate, shortProfile)) return null;
  // Use the trusted long name from here onward. Even a later alias reassignment
  // cannot redirect a subsequent filesystem access to a sibling profile.
  return path.win32.join(profileRoot, path.win32.relative(shortProfile, candidate));
}

function installationProfileRoot({
  platform = process.platform,
  moduleDirectory = __dirname,
  executablePath = process.execPath,
  userInfo = os.userInfo,
  resolveProfileShortPath = cachedOwnedProfileShortPath
} = {}) {
  let home = null;
  try {
    const user = userInfo();
    home = user && user.homedir;
  } catch (error) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE',
      'The operating-system account that owns this installation could not be established, so no agent session was prepared.',
      { cause: error && error.code ? String(error.code) : 'unknown' }
    );
  }
  if (platform !== 'win32') {
    if (typeof home !== 'string' || home.length === 0 || !path.isAbsolute(home)) {
      throw new AgentConfinementRefusal(
        'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE',
        'The operating-system account that owns this installation has no absolute profile path, so no agent session was prepared.',
        {}
      );
    }
    return path.resolve(home);
  }

  const homeAlias = normalizeWindowsAccountPathAlias(home);
  if (!homeAlias.supported || !path.win32.isAbsolute(homeAlias.normalized)) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE',
      'The operating-system account that owns this installation has no absolute profile path, so no agent session was prepared.',
      {}
    );
  }
  const operatingSystemProfile = path.win32.resolve(homeAlias.normalized);
  const installedModuleProfile = windowsInstalledProfileRootOf(moduleDirectory);
  const installedExecutableProfile = windowsInstalledProfileRootOf(executablePath);
  const wrongOwner = [installedModuleProfile, installedExecutableProfile]
    .filter(Boolean)
    .find(profile => !sameWindowsPath(profile, operatingSystemProfile)
      && !sameWindowsPath(ownedAliasAsLongPath(profile, operatingSystemProfile, resolveProfileShortPath), operatingSystemProfile));
  if (wrongOwner) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_WRONG_PRINCIPAL',
      'The running Windows principal does not own this ToolsEnabled installation, so no agent session was prepared.',
      {}
    );
  }
  if (installedModuleProfile) {
    return operatingSystemProfile;
  }

  /* An executable inside the account is not provenance for an arbitrary
   * module it was asked to load. In particular, a user-installed node.exe
   * must not make a Program Files or foreign source tree look account-owned. */
  const moduleAlias = normalizeWindowsAccountPathAlias(moduleDirectory);
  const moduleAsWritten = moduleAlias.supported && path.win32.isAbsolute(moduleAlias.normalized)
    ? path.win32.normalize(path.win32.resolve(moduleAlias.normalized))
    : null;
  // Module candidates are never opened to establish ownership. A short prefix
  // may be translated only from metadata queried on the trusted OS owner.
  const sourceOrScratchOwned = moduleAsWritten !== null
    && ownedAliasAsLongPath(moduleAsWritten, operatingSystemProfile, resolveProfileShortPath) !== null;
  if (!sourceOrScratchOwned) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE',
      'This ToolsEnabled program location is not bound to the running Windows account, so no agent session was prepared.',
      {}
    );
  }
  return operatingSystemProfile;
}

function sameWindowsPath(left, right) {
  const leftAlias = normalizeWindowsAccountPathAlias(left);
  const rightAlias = normalizeWindowsAccountPathAlias(right);
  return leftAlias.supported
    && rightAlias.supported
    && path.win32.resolve(leftAlias.normalized).toLowerCase()
      === path.win32.resolve(rightAlias.normalized).toLowerCase();
}

/* THE ONE RULE FOR TURNING A WRITTEN PATH INTO THE PATH IT REALLY IS.
 *
 * Private to the post-admission canonical check. Never call this to decide
 * whether a lexically foreign candidate is safe to open.
 *
 * A PATH THAT DOES NOT EXIST YET STILL HAS A REAL LOCATION. A confined home is
 * created on first use, so realpath cannot answer for it. The deepest ancestor
 * that DOES exist is expanded and the remaining segments -- directories this
 * product is about to create -- are re-appended. They cannot leave the profile
 * on their own, and the reparse walk still refuses the path if any of them
 * turns out to be a link.
 *
 * Returns null when the question cannot be asked at all, which every caller
 * reads as "no evidence", never as "permitted". */
function expandThroughExistingAncestor(normalized, fileSystem) {
  try {
    const realpath = fileSystem.realpathSync
      && (fileSystem.realpathSync.native || fileSystem.realpathSync);
    if (typeof realpath !== 'function') return null;
    let head = normalized;
    const tail = [];
    for (;;) {
      try { realpath.call(fileSystem.realpathSync, head); break; } catch (error) {
        if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) return null;
      }
      const parent = path.win32.dirname(head);
      if (!parent || parent === head) return null;
      tail.unshift(path.win32.basename(head));
      head = parent;
    }
    const expandedHead = path.win32.normalize(realpath.call(fileSystem.realpathSync, head));
    return tail.length
      ? path.win32.normalize(path.win32.join(expandedHead, ...tail))
      : expandedHead;
  } catch {
    return null;
  }
}

function windowsPathInside(candidate, root) {
  const candidateAlias = normalizeWindowsAccountPathAlias(candidate);
  const rootAlias = normalizeWindowsAccountPathAlias(root);
  if (!candidateAlias.supported || !rootAlias.supported) return false;
  const normalizedCandidate = path.win32.resolve(candidateAlias.normalized).toLowerCase();
  const normalizedRoot = path.win32.resolve(rootAlias.normalized).toLowerCase();
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot.replace(/\\+$/, '')}\\`);
}

/* The OS-derived profile path is the authority. Its parent identifies sibling
 * profiles on redirected layouts such as D:\\Profiles\\Alice without listing or
 * opening those siblings. The conventional \\Users\\ shape remains a hostile
 * spelling even when this installation's profile was redirected elsewhere. */
function pathReferencesForeignProfile(candidate, ownedProfile) {
  const candidateAlias = normalizeWindowsAccountPathAlias(candidate);
  const ownedAlias = normalizeWindowsAccountPathAlias(ownedProfile);
  if (!candidateAlias.supported || !ownedAlias.supported) return false;
  const normalizedCandidate = path.win32.resolve(candidateAlias.normalized);
  const normalizedOwned = path.win32.resolve(ownedAlias.normalized);
  if (windowsPathInside(normalizedCandidate, normalizedOwned)) return false;
  const ownedParent = path.win32.dirname(normalizedOwned);
  if (ownedParent !== path.win32.parse(normalizedOwned).root
      && windowsPathInside(normalizedCandidate, ownedParent)) return true;
  const ownedRoot = path.win32.parse(normalizedOwned).root;
  const peerParent = path.win32.join(
    path.win32.parse(normalizedCandidate).root,
    path.win32.relative(ownedRoot, ownedParent)
  );
  if (peerParent !== path.win32.parse(normalizedCandidate).root
      && windowsPathInside(normalizedCandidate, peerParent)) return true;
  const conventionalProfile = windowsProfileRootOf(normalizedCandidate);
  return Boolean(conventionalProfile && !windowsPathInside(conventionalProfile, normalizedOwned));
}

function assertAccountProfilePath(value, {
  field = 'path',
  profileRoot = installationProfileRoot(),
  requireOwnedProfile = false,
  fileSystem = fs,
  resolveProfileShortPath = cachedOwnedProfileShortPath
} = {}) {
  const absolute = typeof value === 'string'
    && (process.platform === 'win32' ? path.win32.isAbsolute(value.trim()) : path.isAbsolute(value.trim()));
  if (typeof value !== 'string' || value.trim().length === 0 || !absolute) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_PROFILE_PATH_INVALID',
      `The ${field} path is not an absolute path, so no agent session was prepared from it.`,
      { field }
    );
  }
  if (process.platform !== 'win32') return path.resolve(value.trim());

  const ownedAlias = normalizeWindowsAccountPathAlias(profileRoot);
  const ownedProfile = ownedAlias.supported && path.win32.isAbsolute(ownedAlias.normalized)
    ? path.win32.resolve(ownedAlias.normalized)
    : null;
  if (!ownedProfile) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE',
      'The Windows profile that owns this installation could not be established, so no agent session was prepared.',
      { field }
    );
  }
  const candidateAlias = normalizeWindowsAccountPathAlias(value.trim());
  if (!candidateAlias.supported) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_FOREIGN_PROFILE',
      `The ${field} path uses a Windows alias whose account boundary cannot be established, so it was refused before access.`,
      { field }
    );
  }
  const resolved = path.win32.resolve(candidateAlias.normalized);
  let normalized = path.win32.normalize(resolved);
  // A foreign spelling is not permission to inspect it. Obtain an optional
  // exact alias from the OWNER only, then rewrite to the long owned prefix.
  const outsideAsWritten = (requireOwnedProfile && !windowsPathInside(normalized, ownedProfile))
    || pathReferencesForeignProfile(normalized, ownedProfile);
  const ownedSpelling = outsideAsWritten
    ? ownedAliasAsLongPath(normalized, ownedProfile, resolveProfileShortPath)
    : normalized;
  if (ownedSpelling === null) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_FOREIGN_PROFILE',
      `The ${field} path is outside the Windows account that owns this installation, so it was refused before access.`,
      { field }
    );
  }
  normalized = ownedSpelling;

  // Remote ordinary UNC paths cannot resolve into this machine's C:\\Users
  // tree. Avoid contacting an offline share merely to validate an environment
  // value; local/admin and Users-shaped aliases were handled above.
  if (normalized.startsWith('\\\\')) {
    const host = normalized.slice(2).split('\\', 1)[0];
    if (!isProvablyLocalWindowsHost(host)) return normalized;
  }

  const parsed = path.win32.parse(normalized);
  let cursor = parsed.root;
  const segments = normalized.slice(parsed.root.length).split(path.win32.sep).filter(Boolean);
  for (const segment of ['', ...segments]) {
    if (segment) cursor = path.win32.join(cursor, segment);
    try {
      const stat = fileSystem.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new AgentConfinementRefusal(
          'AGENT_CONFINEMENT_PROFILE_REPARSE_POINT',
          `The ${field} path crosses a reparse point, so it was refused before traversal.`,
          { field }
        );
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') break;
      if (error instanceof AgentConfinementRefusal) throw error;
      throw new AgentConfinementRefusal(
        'AGENT_CONFINEMENT_PROFILE_PATH_UNAVAILABLE',
        `The ${field} path could not be checked without crossing an ambiguous account boundary, so no agent session was prepared.`,
        { field, cause: error && error.code ? String(error.code) : 'unknown' }
      );
    }
  }

  let canonical = normalized;
  try {
    const realpath = fileSystem.realpathSync
      && (fileSystem.realpathSync.native || fileSystem.realpathSync);
    if (typeof realpath !== 'function') {
      throw Object.assign(new Error('realpath unavailable'), { code: 'ENOSYS' });
    }
    canonical = path.win32.normalize(realpath.call(fileSystem.realpathSync, normalized));
  }
  catch (error) {
    if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
      throw new AgentConfinementRefusal(
        'AGENT_CONFINEMENT_PROFILE_PATH_UNAVAILABLE',
        `The ${field} path could not be rebound to its final location, so no agent session was prepared.`,
        { field, cause: error && error.code ? String(error.code) : 'unknown' }
      );
    }
    // This path has already passed lexical admission and the reparse walk.
    // Resolve an existing ancestor only for that admitted long spelling.
    const throughAncestor = expandThroughExistingAncestor(normalized, fileSystem);
    if (throughAncestor !== null) canonical = throughAncestor;
  }
  if ((requireOwnedProfile && !windowsPathInside(canonical, ownedProfile))
      || pathReferencesForeignProfile(canonical, ownedProfile)) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_FOREIGN_PROFILE',
      `The ${field} path resolves outside the Windows account that owns this installation, so it was refused before access.`,
      { field }
    );
  }
  return canonical;
}

function valueReferencesForeignProfile(value, ownedProfile) {
  if (typeof value !== 'string' || process.platform !== 'win32') return false;
  const slashNormalized = value.replace(/\//g, '\\');
  /* Evaluate every absolute-path start independently. A single greedy match
   * can swallow a foreign second path into an allowed first path when callers
   * use spaces, commas, or tabs instead of PATH's semicolon. `X:\\` and the
   * leading `\\\\` of a UNC spelling are unambiguous new absolute-path starts;
   * spaces and commas themselves are not delimiters because both are legal in
   * ordinary Windows path segments. */
  const absoluteStarts = new Set();
  for (const match of slashNormalized.matchAll(/[a-z]:\\/ig)) {
    absoluteStarts.add(match.index);
  }
  for (let index = 0; index < slashNormalized.length - 1; index += 1) {
    if (slashNormalized[index] === '\\'
        && slashNormalized[index + 1] === '\\'
        && (index === 0 || slashNormalized[index - 1] !== '\\')) {
      absoluteStarts.add(index);
    }
  }
  const starts = [...absoluteStarts].sort((left, right) => left - right);
  const references = starts.map((start, index) => {
    const end = starts[index + 1] ?? slashNormalized.length;
    return slashNormalized.slice(start, end).split(/[;"'\r\n]/, 1)[0];
  });
  return references.some(reference => {
    const alias = normalizeWindowsAccountPathAlias(reference.trim());
    return alias.supported && pathReferencesForeignProfile(alias.normalized, ownedProfile);
  });
}

function accountConfinedEnvironment(baseEnvironment = process.env, {
  profileRoot = installationProfileRoot()
} = {}) {
  if (!baseEnvironment || typeof baseEnvironment !== 'object' || Array.isArray(baseEnvironment)) {
    throw new AgentConfinementRefusal(
      'AGENT_CONFINEMENT_PROFILE_ENVIRONMENT_INVALID',
      'The agent environment is not a constructed object.',
      {}
    );
  }
  if (process.platform !== 'win32') return { ...baseEnvironment };
  const owned = assertAccountProfilePath(profileRoot, {
    field: 'account profile', profileRoot, requireOwnedProfile: true
  });
  const output = {};
  const pathEntries = [];
  for (const [name, raw] of Object.entries(baseEnvironment)) {
    if (typeof raw !== 'string') { output[name] = raw; continue; }
    if (name.toLowerCase() === 'path') {
      for (const entry of raw.split(path.delimiter)) {
        const candidate = entry.trim();
        if (!candidate || valueReferencesForeignProfile(candidate, owned)) continue;
        pathEntries.push(candidate);
      }
      continue;
    }
    if (valueReferencesForeignProfile(raw, owned)) continue;
    output[name] = raw;
  }
  const pinnedNames = new Set([
    'userprofile', 'home', 'homedrive', 'homepath', 'appdata', 'localappdata',
    'temp', 'tmp', 'xdg_config_home', 'xdg_cache_home', 'xdg_data_home', 'path'
  ]);
  for (const name of Object.keys(output)) {
    if (pinnedNames.has(name.toLowerCase())) delete output[name];
  }
  const parsed = path.win32.parse(owned);
  const ownerNpm = path.win32.join(owned, 'AppData', 'Roaming', 'npm');
  const searchPath = [...pathEntries, ownerNpm]
    .filter((entry, index, all) => all.findIndex(other => other.toLowerCase() === entry.toLowerCase()) === index)
    .join(path.delimiter);
  return {
    ...output,
    USERPROFILE: owned,
    HOME: owned,
    HOMEDRIVE: parsed.root.replace(/[\\/]$/, ''),
    HOMEPATH: owned.slice(parsed.root.length - 1),
    APPDATA: path.win32.join(owned, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.win32.join(owned, 'AppData', 'Local'),
    TEMP: path.win32.join(owned, 'AppData', 'Local', 'Temp'),
    TMP: path.win32.join(owned, 'AppData', 'Local', 'Temp'),
    XDG_CONFIG_HOME: path.win32.join(owned, '.config'),
    XDG_CACHE_HOME: path.win32.join(owned, '.cache'),
    XDG_DATA_HOME: path.win32.join(owned, '.local', 'share'),
    PATH: searchPath
  };
}

module.exports = Object.freeze({
  AgentConfinementRefusal,
  installationProfileRoot,
  assertAccountProfilePath,
  accountConfinedEnvironment,
  normalizeWindowsAccountPathAlias,
  windowsProfileRootOf,
  windowsInstalledProfileRootOf,
  sameWindowsPath,
  windowsPathInside,
  pathReferencesForeignProfile,
  valueReferencesForeignProfile,
  readOwnedProfileShortPath
});
