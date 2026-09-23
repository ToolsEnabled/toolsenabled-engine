#!/usr/bin/env node
'use strict';

// Owner-session MCP host.
//
// This host lives inside the signed-in application's process by default. Agent
// clients connect through a per-instance local IPC endpoint and present only an
// opaque session credential. Bind/revoke authority stays in the app's memory;
// the public route record carries a pipe generation and no control bearer.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const linuxAuthority = require('./lib/owner-host-linux');
const { validateResearchAccess } = require('./lib/research-access');
const errorTaxonomy = require('./lib/error-taxonomy.js');

const ROOT = path.resolve(__dirname, '..');
const PIPE_PREFIX = '\\\\.\\pipe\\ToolsEnabled.OwnerHost.V2.';
// GLOBALROOT resolves through the kernel's SystemRoot link. It is independent
// of both the drive Windows was installed on and caller-controlled environment
// variables such as SystemRoot/windir.
const WINDOWS_SYSTEM_ROOT = '\\\\.\\GLOBALROOT\\SystemRoot';
const WINDOWS_ICACLS = `${WINDOWS_SYSTEM_ROOT}\\System32\\icacls.exe`;
const WINDOWS_WHOAMI = `${WINDOWS_SYSTEM_ROOT}\\System32\\whoami.exe`;
const CAPABILITY_FILE = require('./lib/runtime-state-root.js')
  .statePath('state', 'owner-host-capability.json');
const CONTROL_CAPABILITY_FILE = require('./lib/runtime-state-root.js')
  .statePath('state', 'owner-host-control.json');
// Where a retirement (see defaultSessionRetirementObserver below) is durably
// recorded. Deliberately NOT src/lib/audit.js's signed ledger: that ledger's
// own record() spools to an emergency file under contention and can still
// throw 'The bounded emergency audit spool is full.' when even the spool is
// exhausted, so routing the one record of "why a session died" through it
// would let the record itself be lost under exactly the kind of load that
// causes sessions to die. A bare append-only file has no witness, lock, or
// anchor to fail; its only failure mode is disk-level, handled below.
const RETIREMENT_LOG_FILE = require('./lib/runtime-state-root.js')
  .statePath('logs', 'owner-host-retirements.jsonl');
const CAPABILITY_VERSION = 2;
const TOKEN_BYTES = 32;
const MAX_HANDSHAKE_BYTES = 4096;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
// EVERY ASSISTANT PROGRAM THIS INSTALLATION CAN START, and nothing else.
// A name missing here is not a narrower permission: it is a start that refuses
// with OWNER_HOST_SESSION_BINDING_INVALID, which the app shows as "This start
// did not carry the exact saved session identity" -- a sentence that names
// neither the cause nor anything the person can do about it. 'grok' was
// missing until 2026-09-11 and every Grok tree start refused that way, while
// src/lib/agent-engine/acp-process.js started it, src/lib/multi-account/
// registry.js knew its home and sign-in file, and src/lib/setup/
// machine-record.js would WRITE it into a generated .mcp.json as the calling
// principal. It belongs here because this list is what READS that principal.
// Local sessions carry their own provider identity; the same declared-seat,
// role-revision and credential checks apply to them as to cloud sessions.
// tests/owner-host-agent-actors.test.js pins this set against the two other
// actor lists, so the next provider cannot land in one and not the other.
const AGENT_ACTORS = new Set(['codex', 'claude', 'gemini', 'grok', 'local']);
const DECLARED_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SESSION_ID_MAX = 128;
const ENCODED_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const WINDOWS_ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,127}\\[A-Za-z0-9][A-Za-z0-9 ._@-]{0,127}$/;
const WINDOWS_SID_PRINCIPAL_RE = /^\*S-\d+(?:-\d+){2,15}$/i;
const WINDOWS_PRINCIPAL_RE = new RegExp(`(?:${WINDOWS_ACCOUNT_RE.source})|(?:${WINDOWS_SID_PRINCIPAL_RE.source})`, 'i');
const OWNER_PERMISSION_SESSION = Object.freeze({ origin: 'local', tier: 'full' });

class OwnerHostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OwnerHostError';
    this.code = code;
  }
}

function fail(code, message) { throw new OwnerHostError(code, message); }

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validatedPrincipals({ execFileSyncImpl = execFileSync, platform = process.platform } = {}) {
  if (platform === 'linux') {
    const { principal } = linuxAuthority.currentIdentity();
    return Object.freeze({ ownerPrincipal: principal, clientPrincipal: principal });
  }
  if (platform !== 'win32') {
    fail('OWNER_HOST_PRINCIPAL_INVALID', 'The owner host requires a supported operating-system principal.');
  }
  let current;
  try {
    const output = String(execFileSyncImpl(WINDOWS_WHOAMI, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: {}
    })).trim();
    const match = output.match(/^"(?:[^"]|"")*","(S-\d+(?:-\d+){2,15})"$/i);
    current = match ? `*${match[1]}` : null;
  } catch {
    fail('OWNER_HOST_PRINCIPAL_INVALID', 'The current Windows principal could not be established from the process token.');
  }
  if (!WINDOWS_PRINCIPAL_RE.test(current)) {
    fail('OWNER_HOST_PRINCIPAL_INVALID', 'The owner host requires a valid current Windows principal.');
  }
  // There is one installation principal. Environment variables cannot name a
  // different owner/client account, and no launcher switches profiles.
  return Object.freeze({ ownerPrincipal: current, clientPrincipal: current });
}

function uniquePipePath() {
  return `${PIPE_PREFIX}${crypto.randomUUID()}`;
}

function canonicalToken(value) {
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : null;
  if (!bytes || bytes.length !== TOKEN_BYTES) {
    if (bytes) bytes.fill(0);
    fail('OWNER_HOST_TOKEN_INVALID', 'The owner-host capability token is invalid.');
  }
  return bytes;
}

function decodedToken(value) {
  if (typeof value !== 'string' || !ENCODED_TOKEN_RE.test(value)) return null;
  let supplied;
  try { supplied = Buffer.from(value, 'base64url'); } catch { return null; }
  if (supplied.length !== TOKEN_BYTES || supplied.toString('base64url') !== value) {
    supplied.fill(0);
    return null;
  }
  return supplied;
}

function validControlToken(value, expectedToken) {
  const supplied = decodedToken(value);
  if (!supplied) return false;
  const canonical = supplied.length === TOKEN_BYTES;
  const equal = canonical && supplied.length === expectedToken.length
    && crypto.timingSafeEqual(supplied, expectedToken);
  supplied.fill(0);
  return equal;
}

function validSessionId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= SESSION_ID_MAX
    && !/[\0\r\n]/.test(value);
}

function validBindSession(value, expectedToken) {
  if (!plain(value)
      || Reflect.ownKeys(value).length !== 8
      || !['type', 'token', 'sessionId', 'agentId', 'provider', 'roleId', 'expectedOrgRevision', 'expectedRoleRevision']
        .every(key => Object.hasOwn(value, key))
      || value.type !== 'bind-session'
      || !validControlToken(value.token, expectedToken)
      || !validSessionId(value.sessionId)
      || !AGENT_ACTORS.has(value.provider)
      || (value.agentId !== null && (typeof value.agentId !== 'string' || !DECLARED_AGENT_ID.test(value.agentId)))
      || (value.agentId === null
        ? value.roleId !== null || value.expectedOrgRevision !== null || value.expectedRoleRevision !== null
        : (typeof value.roleId !== 'string' || !DECLARED_AGENT_ID.test(value.roleId)
          || !Number.isSafeInteger(value.expectedOrgRevision) || value.expectedOrgRevision < 0
          || !Number.isSafeInteger(value.expectedRoleRevision) || value.expectedRoleRevision < 0))) return null;
  return Object.freeze({
    principal: Object.freeze({
      sessionId: value.sessionId,
      agentActor: value.provider,
      agentId: value.agentId,
      roleId: value.roleId,
      expectedOrgRevision: value.expectedOrgRevision,
      expectedRoleRevision: value.expectedRoleRevision
    })
  });
}

function validRevokeSession(value, expectedToken) {
  if (!plain(value)
      || Reflect.ownKeys(value).length !== 4
      || !['type', 'token', 'sessionId', 'credential'].every(key => Object.hasOwn(value, key))
      || value.type !== 'revoke-session'
      || !validControlToken(value.token, expectedToken)
      || !validSessionId(value.sessionId)) return null;
  const credentialBytes = decodedToken(value.credential);
  if (!credentialBytes) return null;
  credentialBytes.fill(0);
  return Object.freeze({ sessionId: value.sessionId, credential: value.credential });
}

function validAuthorize(value, sessionBindings) {
  if (!plain(value)
      || Reflect.ownKeys(value).length !== 2
      || value.type !== 'authorize-session'
      || !Object.hasOwn(value, 'credential')) return null;
  const credentialBytes = decodedToken(value.credential);
  if (!credentialBytes) return null;
  credentialBytes.fill(0);
  const bound = sessionBindings instanceof Map ? sessionBindings.get(value.credential) : null;
  return bound ? bound.principal : null;
}

function validResolveSession(value, expectedToken, sessionBindings) {
  if (!plain(value)
      || Reflect.ownKeys(value).length !== 3
      || !['type', 'token', 'credential'].every(key => Object.hasOwn(value, key))
      || value.type !== 'resolve-session'
      || !validControlToken(value.token, expectedToken)) return null;
  const credentialBytes = decodedToken(value.credential);
  if (!credentialBytes) return null;
  credentialBytes.fill(0);
  const bound = sessionBindings instanceof Map ? sessionBindings.get(value.credential) : null;
  return Object.freeze({
    credential: value.credential,
    principal: bound ? bound.principal : null
  });
}

function validPublicResolveSession(value, sessionBindings) {
  if (!plain(value)
      || Reflect.ownKeys(value).length !== 2
      || !['type', 'credential'].every(key => Object.hasOwn(value, key))
      || value.type !== 'resolve-session') return null;
  const credentialBytes = decodedToken(value.credential);
  if (!credentialBytes) return null;
  credentialBytes.fill(0);
  const bound = sessionBindings instanceof Map ? sessionBindings.get(value.credential) : null;
  return Object.freeze({
    credential: value.credential,
    principal: bound ? bound.principal : null
  });
}

function samePrincipal(left, right) {
  return Boolean(left && right)
    && left.sessionId === right.sessionId
    && left.agentActor === right.agentActor
    && left.agentId === right.agentId
    && left.roleId === right.roleId
    && left.expectedOrgRevision === right.expectedOrgRevision
    && left.expectedRoleRevision === right.expectedRoleRevision;
}

/* The declared-org authority behind authorizeDeclaredAgentBinding, which runs
 * ON EVERY DISPATCHED LINE (see the socket data handler below) and therefore
 * inside the Electron main process, where a synchronous read blocks every
 * session at once.
 *
 * MEASURED 2026-09-03 (node v22, this machine, live-shaped state root: 4,378-byte
 * shipped baseline, 12,572-byte operator overlay):
 *   rebuilding the stores per line ......... 6.34 ms median, 43 synchronous
 *                                            fs calls (36 lstatSync,
 *                                            4 realpathSync.native, 3 readFileSync)
 * Of that, 3.32 ms was resolveServicesRoot() running TWICE -- once for the
 * role-memory file and once for the org overlay -- each time re-walking every
 * segment of LOCALAPPDATA and TOOLSENABLED_STATE_ROOT with lstatSync looking
 * for a reparse point, then realpathSync.native. The remaining 1.7 ms re-read
 * and re-normalised two JSON documents that had not changed.
 *
 * WHY A MEMO AND NOT AN ASYNC REWRITE. This check gates dispatch: the line must
 * not reach the broker until the answer is known, so it cannot become a promise
 * without changing the ordering guarantee it exists to provide. The work is
 * removed instead of moved off the thread.
 *
 * WHY THIS IS THE SAME GUARANTEE, NOT A WEAKER ONE. There is no TTL and no
 * window. Every input that can change the verdict is one of four files -- the
 * shipped baseline, the operator's overlay, and both possible role-memory
 * locations -- or the environment values those paths are derived from. Each
 * call stamps all four files (device, file index, size, and nanosecond
 * mtime/ctime) and compares the
 * environment tuple; ANY difference rebuilds from scratch, walking the account
 * boundary exactly as before, on that very line. A redirect that swapped a file
 * or a parent directory changes that file's device/index pair, so it forces the
 * full walk too. The reuse case is only "nothing observable changed", where a
 * repeated walk cannot reach a different conclusion than the one it just reached.
 *
 * FAIL-SAFE IN BOTH DIRECTIONS. A stat that fails for any reason other than
 * ENOENT abandons the memo and rebuilds. ENOENT is recorded as a real state
 * rather than an error, because deleting the operator's overlay reverts the org
 * to the shipped baseline and must invalidate. The stamps are taken before AND
 * after the read, and the entry is published only if they match -- a file edited
 * mid-read is served fresh and cached not at all, so a stale snapshot can never
 * be paired with a current stamp. */
const AUTHORITY_PATH_ENV = Object.freeze(['TOOLSENABLED_STATE_ROOT', 'LOCALAPPDATA', 'XDG_DATA_HOME']);

let installedOrgAuthorityCache = null;

function authorityEnvironmentKey(env) {
  return AUTHORITY_PATH_ENV
    .map(name => `${name}=${typeof env?.[name] === 'string' ? env[name] : ''}`)
    .join(' ');
}

function authorityFileStamp(file) {
  let stat;
  try {
    stat = fs.statSync(file, { bigint: true });
  } catch (error) {
    // Absent is a state, not a failure: removing the overlay reverts the org.
    if (error && error.code === 'ENOENT') return 'absent';
    throw error;
  }
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function authorityStamps(files) {
  return files.map(file => authorityFileStamp(file));
}

function sameStamps(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function installedOrgAuthority(env = process.env) {
  const baselineFile = path.join(ROOT, 'config', 'agent-org.json');
  const envKey = authorityEnvironmentKey(env);
  const cached = installedOrgAuthorityCache;
  if (cached && cached.envKey === envKey && cached.baselineFile === baselineFile) {
    let current = null;
    try { current = authorityStamps(cached.files); }
    catch { current = null; }
    if (sameStamps(current, cached.stamps)) return cached;
  }

  // Nothing reusable: do exactly what this path did before the memo existed.
  // `env` is forwarded rather than left to the store's own process.env default,
  // so the tuple the key was computed from is the tuple the paths came from.
  installedOrgAuthorityCache = null;
  const stores = require('./lib/agent-org-store')
    .createInstalledAgentOrgStores({ baselineFile, env });
  const files = Object.freeze([
    baselineFile,
    stores.orgStore.overlayFile,
    ...stores.roleMemoryFiles
  ]);
  let before = null;
  try { before = authorityStamps(files); } catch { before = null; }
  const snapshot = stores.read();
  const entry = {
    envKey, baselineFile, files, stamps: before, snapshot, roleStore: stores.roleStore
  };
  let after = null;
  try { after = authorityStamps(files); } catch { after = null; }
  // Only publish a snapshot whose inputs held still while it was being read.
  if (before && sameStamps(before, after)) installedOrgAuthorityCache = entry;
  return entry;
}

/* WHETHER A DECLARED AGENT'S SESSION STILL HOLDS THE AUTHORITY IT WAS BOUND WITH.
 *
 * Two moments ask this, and they are not the same question.
 *
 *   AT BIND (`fresh: true`): the app is starting a session against the org
 *   snapshot it displayed. If the org has moved since, the person chose a role
 *   on a screen that is out of date, and refusing is right -- the same rule
 *   the store applies to its own writes.
 *
 *   ON EVERY LATER LINE (`fresh: false`): the session is already running. Here
 *   the org's revision is NOT compared, and that is the whole point of the
 *   split. The revision moves on every write to the org, and a tree spawn is
 *   one: the new circle's seat is declared before it starts. Measured on the
 *   owner's own tree, 2026-09-03: the overlay went 12 -> 13 at 01:11:12Z when
 *   a Manager circle was drawn, and by 01:11:30Z every socket of the
 *   CONTROLLER that drew it had been destroyed by this check -- "Connection
 *   closed" as the reward for a spawn that worked. It happened three times in
 *   one evening, and a circle whose tools die when its first child is seated
 *   can never build a team.
 *
 * What a running session keeps being held to is everything an org edit can
 * change ABOUT IT: its seat must still exist, be enabled, and carry the role
 * and provider its credential names, and a role of that name must still be
 * defined. The role record's REVISION is not compared on a later line either,
 * and that is the second half of the same lesson. MEASURED on the owner's own
 * tree, 2026-09-19: services/custom-roles.json moved default:controller to
 * rev 10 and default:manager to rev 9 while both were running, and
 * capability/logs/owner-host-retirements.jsonl records six controller and
 * manager sessions retired with reason per-line-recheck between 03:03Z and
 * 03:12Z -- every one of them "MCP server is not connected" from that line
 * on. Editing role text in the Role library is an ordinary owner action and
 * must not end the sessions doing the work. A moved revision REBINDS the
 * running session in place instead (rebindRoleRevision in createOwnerHost):
 * the binding is re-issued against the current revision, the edited
 * definition governs from that line on (boundRoleFunctionPolicy reads the
 * CURRENT record, so a function the person removed stops dispatching at once
 * and one they added becomes callable at once), and the rebind is recorded
 * once. A role that no longer exists under the credential's name still
 * revokes on the next line (tests/entry/mcp-owner-proxy-lifecycle.js proves
 * both). */
function declaredAgentBindingVerdict(principal, options = {}, { fresh = false, issuing = fresh } = {}) {
  if (principal.agentId === null) return true;
  let snapshot;
  let roleRecord;
  if (typeof options.readInstalledOrg === 'function') {
    snapshot = options.readInstalledOrg(principal);
    roleRecord = snapshot?.roleRecord || null;
  } else {
    const stores = installedOrgAuthority();
    snapshot = stores.snapshot;
    roleRecord = stores.roleStore.getRoleRecord(principal.roleId);
  }
  const agent = snapshot?.org?.agents?.find(candidate => candidate.id === principal.agentId) || null;
  /* The role RECORD REVISION is compared only while a binding is being
     ISSUED (`issuing`: a fresh bind, or an admitted one whose account was
     prepared against the role the screen showed), for the same reason the
     org revision is compared at a fresh bind: the screen the person chose
     from must be current. On a later line -- and on an exact retry of a
     binding that already exists -- the role must still exist under the name
     the credential carries; its revision is allowed to have moved, and the
     running session is rebound to it. See the design note above for what it
     cost when the revision was compared on every line. */
  return (!fresh || snapshot?.org?.revision === principal.expectedOrgRevision)
    && agent?.enabled === true
    && agent.role === principal.roleId
    && agent.provider === principal.agentActor
    && roleRecord?.definition?.id === principal.roleId
    && (!issuing || roleRecord.revision === principal.expectedRoleRevision);
}

/* A caller that only wants a plain boolean -- this module's own direct-call
 * tests, or an integrator that has not adopted the three-way verdict below --
 * still gets one, with a read failure folded into `false` exactly as before
 * this split. createOwnerHost's own bind and per-line paths call
 * declaredAgentBindingVerdict directly instead, so that a read which THREW
 * (the org overlay or role-memory store was unreadable, locked, or
 * momentarily replaced) can be told apart from a read that completed and
 * found the seat gone, disabled, or mismatched. Only the completed "no" may
 * retire a binding and destroy its sockets; a threw-and-learned-nothing must
 * not, on pain of an authorized, running session being ended by a disk hiccup
 * instead of an actual revocation. See bindingVerdict in createOwnerHost. */
function authorizeDeclaredAgentBinding(principal, options = {}, mode = {}) {
  try { return declaredAgentBindingVerdict(principal, options, mode); }
  catch { return false; }
}

/* THE ROLE RECORD AS THE LIBRARY HOLDS IT NOW, through the same read the
 * verdict uses. Both the per-line policy and the in-place rebind want the
 * current record, never the one the credential was issued against. */
function currentRoleRecord(principal, options = {}) {
  return typeof options.readInstalledOrg === 'function'
    ? options.readInstalledOrg(principal)?.roleRecord
    : installedOrgAuthority().roleStore.getRoleRecord(principal.roleId);
}

function boundRoleFunctionPolicy(principal, options) {
  if (!principal.agentId) return undefined;
  const record = currentRoleRecord(principal, options);
  /* THE CURRENT DEFINITION, NOT THE ONE THE CREDENTIAL WAS ISSUED AGAINST.
     A role edit takes effect on the running session's next line: functions the
     person removed stop dispatching at once, functions added become callable
     at once, and nothing about the session ends. Only a role that no longer
     exists under this name refuses the line. */
  if (record?.definition?.id !== principal.roleId) {
    fail('OWNER_HOST_ROLE_CHANGED', 'The role this session was started with no longer exists; restart the session under its current role.');
  }
  const policies = require('./lib/role-functions');
  return policies.normalizeFunctionPolicy(record.definition, policies.defaultFunctionPolicy(principal.roleId));
}

function capabilityRecord(pipeName, generation) {
  return Object.freeze({
    version: CAPABILITY_VERSION,
    pipeName,
    generation
  });
}

function controlCapabilityRecord(pipeName, token) {
  return Object.freeze({ version: CAPABILITY_VERSION, pipeName, token: token.toString('base64url') });
}

function systemIcacls() { return WINDOWS_ICACLS; }

function writeCapability({
  file = CAPABILITY_FILE,
  controlFile = CONTROL_CAPABILITY_FILE,
  pipeName,
  generation,
  token,
  principals,
  publishControl = false,
  io = fs,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  environment = process.env,
  allowTestPath = false
} = {}) {
  const capabilityFile = path.resolve(file);
  const controlCapabilityFile = path.resolve(controlFile);
  if (!allowTestPath && (capabilityFile !== path.resolve(CAPABILITY_FILE)
      || controlCapabilityFile !== path.resolve(CONTROL_CAPABILITY_FILE))) {
    fail('OWNER_HOST_CAPABILITY_PATH_REFUSED', 'The production owner-host capability paths are fixed.');
  }
  const linux = platform === 'linux';
  if (!linux && platform !== 'win32' && !allowTestPath) {
    fail('OWNER_HOST_PRINCIPAL_INVALID', 'The owner-host platform is not supported.');
  }
  if (linux) {
    const { principal } = linuxAuthority.currentIdentity();
    if (principals?.ownerPrincipal !== principal || principals?.clientPrincipal !== principal) {
      fail('OWNER_HOST_PRINCIPAL_INVALID', 'The Linux owner host requires the exact current operating-system account.');
    }
    if (!linuxAuthority.validEndpoint(pipeName, generation, { custom: allowTestPath })) {
      fail('OWNER_HOST_CAPABILITY_INVALID', 'The Linux owner-host route is invalid.');
    }
    linuxAuthority.prepareRecordDirectory(capabilityFile);
    linuxAuthority.prepareRecordDirectory(controlCapabilityFile);
    linuxAuthority.assertSocket(pipeName);
  } else if (!principals || !WINDOWS_PRINCIPAL_RE.test(principals.ownerPrincipal)
      || !WINDOWS_PRINCIPAL_RE.test(principals.clientPrincipal)) {
    fail('OWNER_HOST_PRINCIPAL_INVALID', 'The owner host requires a valid current Windows principal.');
  }
  if (!allowTestPath
      && principals.ownerPrincipal.toLowerCase() !== principals.clientPrincipal.toLowerCase()) {
    fail('OWNER_HOST_PRINCIPAL_INVALID', 'The app-owned owner host requires one exact Windows principal.');
  }
  if (typeof pipeName !== 'string' || (!linux && !allowTestPath && !pipeName.startsWith(PIPE_PREFIX))
      || typeof generation !== 'string' || !/^[a-f0-9-]{36}$/.test(generation)) {
    fail('OWNER_HOST_CAPABILITY_INVALID', 'The owner-host route generation is invalid.');
  }
  const secret = canonicalToken(token);
  const record = capabilityRecord(pipeName, generation);
  const controlRecord = controlCapabilityRecord(pipeName, secret);
  const publish = (target, value, clientReadable) => {
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      io.mkdirSync(path.dirname(target), { recursive: true });
      io.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (platform === 'win32' && spawnSyncImpl !== false) {
        const grants = [
          temporary,
          '/inheritance:r',
          '/grant:r',
          `${principals.ownerPrincipal}:(F)`
        ];
        if (clientReadable
            && principals.clientPrincipal.toLowerCase() !== principals.ownerPrincipal.toLowerCase()) {
          grants.push(`${principals.clientPrincipal}:(R)`);
        }
        const acl = spawnSyncImpl(systemIcacls(), grants, {
          encoding: 'utf8',
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
          timeout: 15_000,
          env: {}
        });
        if (acl.error || acl.status !== 0) {
          fail('OWNER_HOST_ACL_UNAVAILABLE', 'The owner-host capability could not be access-controlled.');
        }
      }
      try {
        io.renameSync(temporary, target);
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error && error.code)) throw error;
        io.unlinkSync(target);
        io.renameSync(temporary, target);
      }
      if (linux) linuxAuthority.readPrivateRecord(target);
    } finally {
      try { io.unlinkSync(temporary); } catch { /* renamed or already absent */ }
    }
  };
  try {
    // Production keeps bind/revoke authority in the app's memory.  The legacy
    // control record exists only for explicit test/compatibility hosts.
    if (publishControl) publish(controlCapabilityFile, controlRecord, false);
    else {
      try { io.unlinkSync(controlCapabilityFile); }
      catch (error) {
        if (error?.code !== 'ENOENT') {
          fail('OWNER_HOST_CONTROL_CLEANUP_FAILED', 'The retired owner-host control record could not be removed.');
        }
      }
    }
    publish(capabilityFile, record, true);
    return Object.freeze({
      file: capabilityFile,
      controlFile: publishControl ? controlCapabilityFile : null,
      record,
      controlRecord: publishControl ? controlRecord : null
    });
  } catch (error) {
    // Never remove a route a newer host may have atomically published over us.
    try {
      const current = linux ? linuxAuthority.readPrivateRecord(capabilityFile)
        : JSON.parse(io.readFileSync(capabilityFile, 'utf8'));
      if (plain(current) && current.pipeName === pipeName && current.generation === generation) {
        io.unlinkSync(capabilityFile);
      }
    } catch { /* best effort for our partial publication */ }
    if (publishControl) {
      try { io.unlinkSync(controlCapabilityFile); } catch { /* best effort for partial publication */ }
    }
    if (error instanceof OwnerHostError) throw error;
    fail('OWNER_HOST_CAPABILITY_UNAVAILABLE', 'The owner-host capability could not be published.');
  } finally {
    secret.fill(0);
  }
}

function removeCapability({
  file = CAPABILITY_FILE,
  controlFile = CONTROL_CAPABILITY_FILE,
  token = null,
  pipeName,
  generation,
  publishedControl = false,
  io = fs,
  platform = process.platform
} = {}) {
  const readRecord = file => platform === 'linux'
    ? linuxAuthority.readPrivateRecord(file)
    : JSON.parse(io.readFileSync(file, 'utf8'));
  try {
    if (publishedControl) {
      if (!Buffer.isBuffer(token) || token.length !== TOKEN_BYTES) return false;
      const current = readRecord(controlFile);
      if (!plain(current) || current.version !== CAPABILITY_VERSION
          || current.pipeName !== pipeName || typeof current.token !== 'string') return false;
      let found;
      try { found = Buffer.from(current.token, 'base64url'); } catch { return false; }
      const matches = found.length === token.length
        && found.toString('base64url') === current.token
        && crypto.timingSafeEqual(found, token);
      found.fill(0);
      if (!matches) return false;
      try { io.unlinkSync(controlFile); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    const route = readRecord(file);
    if (!plain(route) || route.version !== CAPABILITY_VERSION
        || route.pipeName !== pipeName || route.generation !== generation) return false;
    io.unlinkSync(file);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw new OwnerHostError('OWNER_HOST_CAPABILITY_CLEANUP_FAILED',
      'The owner-host capability could not be cleaned up.');
  }
}

function validResponseId(value) {
  return value === null || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function requestId(line) {
  try {
    const request = JSON.parse(line);
    if (plain(request) && Object.hasOwn(request, 'id') && validResponseId(request.id)) return request.id;
  } catch {}
  return null;
}

function internalError(line) {
  return { jsonrpc: '2.0', id: requestId(line), error: { code: -32603, message: 'Internal error.' } };
}

// A code that names its own refusal, in the shape the taxonomy's own ladder
// reads: uppercase, underscore-separated, no punctuation, bounded. Anything
// else -- a message pressed into `code`, an errno, a peer-supplied string --
// is not forwarded, so this seam can never become a channel for arbitrary
// text (see the socket-error comment on the dispatch catches below: no peer
// data leaves this host).
const REFUSAL_CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,79}$/;

// Distinct from internalError: dispatch rejected, and the rejection NAMES its
// own refusal. Before this, both dispatch seams caught with a zero-argument
// `.catch(() => respond(internalError(line)))`, so the rejection was never
// bound and every refusal -- however precisely the tool had already worked it
// out -- reached the calling agent as "Internal error.".
//
// That is why 24e60a96 (registering the MC_TREE_COMMAND_* refusal family in
// src/lib/error-taxonomy.js) could not do what it exists for: reclassifying a
// code cannot help at a seam that never looks at the error.
//
// What crosses the socket is the CODE and the taxonomy's sentence for it, and
// nothing else. Never `error.message`: it is the one field that can carry
// peer data, paths or tool arguments. An error the taxonomy still classifies
// INTERNAL_ERROR is not a named refusal and falls back unchanged, so a crash
// keeps looking like a crash.
function namedRefusalError(line, error) {
  if (!error || typeof error !== 'object') return null;
  const code = error.code;
  if (typeof code !== 'string' || !REFUSAL_CODE_SHAPE.test(code)) return null;
  let failure;
  // The taxonomy is a pure classifier, but it is still foreign code on a
  // failure path: if it throws, the caller must get the plain internal error
  // rather than a second failure inside the first one's handler.
  try { failure = errorTaxonomy.publicFailure({ code }); }
  catch { return null; }
  if (!failure || failure.code === 'INTERNAL_ERROR') return null;
  return {
    jsonrpc: '2.0',
    id: requestId(line),
    error: {
      code: -32600,
      message: failure.safeSummary,
      data: { code, classification: failure.classification, retryable: failure.retryable }
    }
  };
}

// The single answer for a rejected dispatch line, used by BOTH seams so they
// cannot drift apart again.
function dispatchFailure(line, error) {
  return namedRefusalError(line, error) || internalError(line);
}

// Distinct from internalError: this line was refused because the per-line
// re-check could not confirm authorization (the org/role read threw), not
// because dispatch itself failed. Merging the two would hide that the
// session is still bound and the next line may succeed once the read does.
function authorizationUnknownError(line) {
  return {
    jsonrpc: '2.0',
    id: requestId(line),
    error: { code: -32001, message: 'Session authorization could not be verified.' }
  };
}

// Called before a session's sockets are destroyed, naming which caller
// retired it (bind-session refusal, socket bind refusal, revoke, resolve,
// authorize, per-line re-check) or timed it out, and the sessionId. Never
// the credential value, never a tool argument. Defaulted so production
// still records even when nothing overrides it; a caller may inject
// options.sessionRetirementObserver (e.g. to route into an audit sink)
// without owner-host.js needing to know what that sink is.
//
// The default's PRIMARY sink is a plain append-only file (see
// RETIREMENT_LOG_FILE above for why it is not the signed audit ledger), so
// the record survives in a packaged Electron build even though stderr
// commonly is not captured there (no console attached to a GUI subprocess,
// and nothing guarantees a parent process pipes or logs it). stderr is kept
// as a SECONDARY mirror, purely for interactive/dev visibility -- a
// terminal running `npm run mcp` or a test harness watching stdio -- and is
// not load-bearing: a build where it goes nowhere still has the file.
function createDefaultSessionRetirementObserver(logFile) {
  // `event` defaults to the historical, accurate label for every retireBinding
  // call site: those six all genuinely end a session. The idle-timeout path
  // (see armIdleTimeout) passes its own `event` explicitly, because on its
  // survive branch nothing is retired -- a record that called that
  // "owner-host-session-retired" would tell a reader a session ended when it
  // did not.
  return ({ event = 'owner-host-session-retired', reason, sessionId, detail }) => {
    const line = `${JSON.stringify({
      event,
      reason,
      sessionId,
      // Bounded, caller-shaped facts about the event (a rebind's from/to
      // revisions). Never a credential, never a tool argument.
      ...(plain(detail) ? { detail } : {}),
      atMs: Date.now()
    })}\n`;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, line, 'utf8');
    } catch { /* best-effort: a log write must never block retirement */ }
    try { process.stderr.write(line); } catch { /* best-effort */ }
  };
}

function createOwnerHost(options = {}) {
  const platform = options.platform || process.platform;
  const customPath = Object.hasOwn(options, 'pipeName')
    || Object.hasOwn(options, 'capabilityFile')
    || Object.hasOwn(options, 'controlCapabilityFile')
    || Object.hasOwn(options, 'sessionRetirementLogFile');
  if (customPath && options.allowTestPaths !== true) {
    fail('OWNER_HOST_TEST_PATH_REFUSED', 'Custom owner-host paths are test-only.');
  }
  if (options.publishControlCapability === true && options.allowTestPaths !== true) {
    fail('OWNER_HOST_CONTROL_PUBLICATION_REFUSED', 'Production bind/revoke authority must remain in app memory.');
  }
  if ((Object.hasOwn(options, 'principals') || Object.hasOwn(options, 'execFileSyncImpl')
      || platform !== process.platform)
      && options.allowTestPaths !== true) {
    fail('OWNER_HOST_PRINCIPAL_OVERRIDE_REFUSED', 'Owner-host principal overrides are test-only.');
  }
  const generation = options.generation || crypto.randomUUID();
  const pipeName = options.pipeName || (platform === 'linux'
    ? linuxAuthority.socketPath(generation)
    : `${PIPE_PREFIX}${generation}`);
  const capabilityFile = path.resolve(options.capabilityFile || CAPABILITY_FILE);
  const controlCapabilityFile = path.resolve(options.controlCapabilityFile
    || (options.capabilityFile
      ? path.join(path.dirname(capabilityFile), 'owner-host-control.json')
      : CONTROL_CAPABILITY_FILE));
  if (typeof pipeName !== 'string' || pipeName.length < 1 || /[\r\n]/.test(pipeName)) {
    fail('OWNER_HOST_PIPE_INVALID', 'The owner-host pipe path is invalid.');
  }
  const principals = options.principals || validatedPrincipals({
    execFileSyncImpl: options.execFileSyncImpl || execFileSync,
    platform
  });
  const token = canonicalToken(options.token || crypto.randomBytes(TOKEN_BYTES));
  const broker = options.broker || require('./mcp-server.js');
  // One scheduler for the whole host, one lane per bound session: an agent's
  // writes stay in order, different agents run side by side, reads never
  // wait behind a spawn. A caller that injects its own dispatchLine keeps
  // the per-socket chain it was written against.
  const scheduledDispatch = !options.dispatchLine && typeof broker.createLineDispatcher === 'function'
    ? broker.createLineDispatcher(options.lineDispatcher || {})
    : null;
  const dispatchLine = options.dispatchLine || broker.processLine;
  const resolvePermissionSession = options.resolvePermissionSession || broker.resolvePermissionSession;
  const resolveWorkspaceRoots = options.resolveWorkspaceRoots || (() => {
    const recordApi = require('./lib/setup/machine-record');
    const record = recordApi.readMachineRecord({ servicesRoot: recordApi.resolveServicesRoot({}) });
    return record === null ? [] : record.workspaceRoots;
  });
  if (typeof resolveWorkspaceRoots !== 'function') {
    fail('OWNER_HOST_PERMISSION_UNAVAILABLE', 'The workspace boundary could not be verified.');
  }
  function captureSessionScope(workspaceRoot = undefined, researchAccess = undefined) {
    const permissionSession = require('./lib/permission-tier-policy').session(resolvePermissionSession());
    let workspaceCeiling = permissionSession.tier === 'confined'
      ? require('./lib/session-workspace-ceiling').captureWorkspaceCeiling(resolveWorkspaceRoots())
      : null;
    if (workspaceRoot !== undefined && workspaceCeiling !== null) {
      const boundary = require('./lib/session-workspace-ceiling');
      const selected = boundary.captureWorkspaceCeiling([workspaceRoot]);
      const permitted = boundary.intersectWorkspaceCeiling(workspaceCeiling, [workspaceRoot]);
      if (!permitted.includes(selected[0].canonical)) {
        fail('OWNER_HOST_PERMISSION_UNAVAILABLE', 'The selected workspace is outside this session boundary.');
      }
      workspaceCeiling = selected;
    }
    return { permissionSession, workspaceCeiling, researchAccess };
  }
  function currentSessionScope(binding) {
    const policy = require('./lib/permission-tier-policy');
    const current = policy.session(resolvePermissionSession());
    const original = binding.permissionSession;
    const rank = value => value.origin === 'local' && value.tier === 'full' ? 2
      : value.origin === 'local' && value.tier === 'confined'
        ? value.profile === 'workspace' ? 1 : value.profile === 'read-only' ? 0 : -1
        : -1;
    if (rank(current) < 0 || rank(original) < 0) {
      fail('OWNER_HOST_PERMISSION_UNAVAILABLE', 'The local session boundary could not be verified.');
    }
    const permissionSession = rank(current) < rank(original) ? current : original;
    if (permissionSession.tier !== 'confined') return {
      permissionSession,
      ...(binding.researchAccess === undefined ? {} : { researchAccess: binding.researchAccess })
    };
    const ceiling = require('./lib/session-workspace-ceiling');
    const roots = resolveWorkspaceRoots();
    if (original.tier === 'confined' && !binding.workspaceCeiling) {
      fail('OWNER_HOST_PERMISSION_UNAVAILABLE', 'The original workspace boundary is unavailable.');
    }
    const snapshot = binding.workspaceCeiling || ceiling.captureWorkspaceCeiling(roots);
    return {
      permissionSession,
      workspaceRoots: ceiling.intersectWorkspaceCeiling(snapshot, roots),
      ...(binding.researchAccess === undefined ? {} : { researchAccess: binding.researchAccess })
    };
  }
  if (typeof resolvePermissionSession !== 'function') {
    fail('OWNER_HOST_PERMISSION_UNAVAILABLE',
      'The owner host cannot derive an authoritative permission session for agent calls.');
  }
  const maxMessageBytes = options.maxMessageBytes || broker.MAX_MESSAGE_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs || IDLE_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs || HANDSHAKE_TIMEOUT_MS;
  const credentialHygiene = Object.hasOwn(options, 'credentialHygiene')
    ? options.credentialHygiene
    : (options.allowTestPaths === true
      ? () => undefined
      : () => require('./lib/runtime').scrubPaymentCardSecurityCode());
  if (typeof credentialHygiene !== 'function') {
    fail('OWNER_HOST_CREDENTIAL_HYGIENE_INVALID', 'The owner-host credential hygiene hook is invalid.');
  }
  const sessionRetirementLogFile = path.resolve(options.sessionRetirementLogFile || RETIREMENT_LOG_FILE);
  const observeSessionRetired = Object.hasOwn(options, 'sessionRetirementObserver')
    ? options.sessionRetirementObserver
    : createDefaultSessionRetirementObserver(sessionRetirementLogFile);
  if (typeof observeSessionRetired !== 'function') {
    fail('OWNER_HOST_RETIREMENT_OBSERVER_INVALID', 'The owner-host session retirement observer is invalid.');
  }
  const server = (options.createServer || net.createServer)();
  const sockets = new Set();
  const socketControllers = new WeakMap();
  const sessionBindings = new Map();
  const credentialBySessionId = new Map();
  const retiringBindings = new Map();
  const authorizeBinding = options.authorizeAgentBinding
    || ((principal, mode) => declaredAgentBindingVerdict(principal, options, mode));
  /* `mode.fresh` is true only when a NEW binding is being issued; see
     declaredAgentBindingVerdict for why a running session is held to a
     narrower question than a session being started.

     bindingVerdict tells a completed "no" apart from a read that never
     finished: 'denied' means the org/role stores were read and the seat is
     gone, disabled, or no longer matches; 'unknown' means authorizeBinding
     THREW and nothing was actually learned (a store that is unreadable,
     locked, or momentarily replaced by a rewrite lands here too, since
     declaredAgentBindingVerdict does not catch its own reads). Only
     'denied' may retire a binding and destroy its sockets -- an 'unknown'
     refuses the one request that asked and leaves the session running, so a
     transient read failure does not read as "Connection closed" to every
     MCP client attached to an otherwise-authorized session. */
  const bindingVerdict = (principal, mode = {}) => {
    try { return authorizeBinding(principal, mode) === true ? 'authorized' : 'denied'; }
    catch { return 'unknown'; }
  };
  const bindingIsAuthorized = (principal, mode = {}) => bindingVerdict(principal, mode) === 'authorized';
  let published = null;
  let listening = false;
  let closed = false;
  let closePromise = null;
  let hygieneComplete = false;

  const retireBinding = (credential, reason) => {
    const existing = sessionBindings.get(credential);
    if (!existing) return retiringBindings.get(credential)?.settled || Promise.resolve();
    const fileScopeClosure = require('./lib/file-tool-context').retireFileToolContext(existing.fileToolContext, reason);
    sessionBindings.delete(credential);
    if (credentialBySessionId.get(existing.principal.sessionId) === credential) {
      credentialBySessionId.delete(existing.principal.sessionId);
    }
    try { observeSessionRetired({ reason, sessionId: existing.principal.sessionId }); }
    catch { /* an observer failure must not block retirement or leave sockets bound */ }
    for (const boundSocket of existing.sockets) {
      socketControllers.get(boundSocket)?.abort();
      boundSocket.destroy();
    }
    existing.sockets.clear();
    // host.exec Jobs belong to the owner host, not the provider process being
    // stopped. Revoking its credential alone cannot stop those native commands.
    // Retain the exact binding's drain, including a failed cleanup, for retries.
    const settled = Promise.allSettled([fileScopeClosure, ...existing.pendingExecs]).then(() => {
      if (existing.execCleanupFailure) throw existing.execCleanupFailure;
      retiringBindings.delete(credential);
    });
    retiringBindings.set(credential, { principal: existing.principal, settled });
    // Rechecks retire synchronously; explicit revoke/close below await the same
    // promise. A background retirement must not create an unhandled rejection.
    settled.catch(() => {});
    return settled;
  };

  /* A ROLE EDIT REBINDS THE RUNNING SESSION IN PLACE; IT DOES NOT END IT.
     The person saves a role in the Role library and its revision moves. The
     session that holds that role keeps its credential and its sockets: the
     binding is re-issued against the current revision, the edited definition
     governs from this line on (boundRoleFunctionPolicy reads the current
     record), and the rebind is recorded once per moved revision, never once
     per line. A read that throws learns nothing and changes nothing -- the
     line's own policy read refuses it by name. A record that names another
     role, or none, is not a rebind either: the verdict before this call is
     what decides that, and it decides revoke. Nothing here is a credential:
     the binding keeps the exact bytes the agent process was launched with,
     because that process cannot be told a new one. */
  const rebindRoleRevision = binding => {
    let record;
    try { record = currentRoleRecord(binding.principal, options); } catch { return false; }
    if (record?.definition?.id !== binding.principal.roleId
        || !Number.isSafeInteger(record.revision) || record.revision < 0
        || record.revision === binding.principal.expectedRoleRevision) return false;
    const from = binding.principal.expectedRoleRevision;
    binding.principal = Object.freeze({ ...binding.principal, expectedRoleRevision: record.revision });
    try {
      observeSessionRetired({
        event: 'owner-host-session-rebound',
        reason: 'role-revision-changed',
        sessionId: binding.principal.sessionId,
        detail: { roleId: binding.principal.roleId, fromRoleRevision: from, toRoleRevision: record.revision }
      });
    } catch { /* an observer failure must not undo or block the rebind */ }
    return true;
  };

  /* WHAT THE APP MAY NAME A RUNNING BINDING BY. The app retains the principal
     it bound with and hands it back to revoke, hold, resume and validate. A
     rebind moved the binding's own revision, so the retained (issued) principal
     must still match, or the app could no longer stop the very session it
     started. Either exact spelling is the same session; nothing else is. */
  const boundPrincipalMatches = (existing, principal) => samePrincipal(existing.principal, principal)
    || samePrincipal(existing.issuedPrincipal, principal);

  /* EVERY DISPATCHED CALL'S OWN CANCELLATION HANDLE, held against its session.
     The socket's controller can only be aborted once and never un-aborted, so
     cancelling one turn's work through it would end tool access for the whole
     connection. Registering the per-call controller here is what lets this
     session's in-flight work be stopped while the session stays usable.

     ADMISSION IS ALSO WHERE A STOPPED SESSION IS REFUSED. A provider's own
     cancel does not wait: the ACP adapter writes session/cancel and returns,
     so the model can submit another command immediately, and a line already
     queued behind a running one reaches this point later. Aborting what was
     in flight cannot cover either. The latch is read here, synchronously, on
     the one path every line takes. Only the app lifts it, through
     resumeSessionWork; an agent seeing this refusal must not retry by
     itself. */
  /* WHICH CALL OWNS A NATIVE COMMAND, in both spellings that reach this seam.
     Grok 1.0.25 does not discover dotted tool names, so mcp-server advertises
     that one actor a mechanical host.exec -> host_exec alias and canonicalizes
     it AFTER this barrier runs (grokWireAliases). Matching the dotted name
     alone is why the actual failing provider's command was aborted but never
     awaited and its termination failure never retained: the signal fired and
     nothing proved the child dead. The actor is the binding's own, re-checked
     against the socket principal on every line, never a request field, and no
     other tool name widens into an exec barrier. */
  const nativeExecCall = (binding, message) => {
    if (message?.method !== 'tools/call') return false;
    const name = message.params?.name;
    if (name === 'host.exec') return true;
    return binding.principal.agentActor === 'grok' && name === 'host_exec';
  };

  function dispatchWithCleanup(binding, line, respond, dispatch, callController = null) {
    if (binding.workHeld) {
      return Promise.reject(new OwnerHostError('OWNER_HOST_SESSION_WORK_REFUSED',
        'This session\'s tool work is stopped until the app resumes it.'));
    }
    if (callController) binding.liveCalls.add(callController);
    const releaseCall = () => { if (callController) binding.liveCalls.delete(callController); };
    let message;
    try { message = JSON.parse(line); } catch { /* normal dispatcher refusal */ }
    if (!nativeExecCall(binding, message)) {
      return Promise.resolve().then(() => dispatch(respond)).finally(releaseCall);
    }
    const rememberFailure = code => {
      if (code === 'HOST_EXEC_TERMINATION_FAILED') {
        binding.execCleanupFailure = Object.assign(new Error('A session command could not prove cleanup.'), {
          code: 'OWNER_HOST_SESSION_CLEANUP_FAILED'
        });
      }
    };
    // Register before entering the handler: a synchronous close/revoke must
    // already see this command. Other tools may themselves close their session,
    // so this native-command barrier must not wait on those self-closing calls.
    const pending = Promise.resolve().then(() => dispatch(value => {
      const output = value?.result?.structuredContent;
      rememberFailure(output?.terminationFailure ? 'HOST_EXEC_TERMINATION_FAILED' : output?.error?.code);
      respond(value);
    })).catch(error => {
      rememberFailure(error?.code);
      throw error;
    }).finally(() => { binding.pendingExecs.delete(pending); releaseCall(); });
    binding.pendingExecs.add(pending);
    return pending;
  }

  function directPrincipal(value, { credential = false } = {}) {
    const keys = ['sessionId', 'agentId', 'provider', 'roleId', 'expectedOrgRevision', 'expectedRoleRevision'];
    if (!plain(value) || Reflect.ownKeys(value).length !== keys.length + (credential ? 1 : 0)
        || !keys.every(key => Object.hasOwn(value, key))
        || (credential && !Object.hasOwn(value, 'credential'))) {
      fail('OWNER_HOST_SESSION_BINDING_INVALID', 'The exact agent-session binding is invalid.');
    }
    const parsed = validBindSession({
      type: 'bind-session',
      token: token.toString('base64url'),
      ...Object.fromEntries(keys.map(key => [key, value[key]]))
    }, token);
    if (!parsed) fail('OWNER_HOST_SESSION_BINDING_INVALID', 'The exact agent-session binding is invalid.');
    if (credential) {
      const bytes = decodedToken(value.credential);
      if (!bytes) fail('OWNER_HOST_SESSION_BINDING_INVALID', 'The session credential is invalid.');
      bytes.fill(0);
    }
    return Object.freeze({ principal: parsed.principal, credential: credential ? value.credential : null });
  }

  // An app start validates the displayed revision before account lookup can
  // yield to a sibling's seat write. This opaque, single-use admission grants
  // no credential or tools. Binding later still verifies this exact seat/role.
  const sessionAdmissions = new WeakMap();
  function admitSession(value) {
    if (closed || !listening || !server.listening) fail('OWNER_HOST_NOT_READY', 'The app-owned session authority is not ready.');
    const binding = directPrincipal(value);
    if (binding.principal.agentId === null || credentialBySessionId.has(binding.principal.sessionId)) {
      fail('OWNER_HOST_SESSION_BINDING_INVALID', 'A new declared session is required for admission.');
    }
    const verdict = bindingVerdict(binding.principal, { fresh: true });
    if (verdict !== 'authorized') {
      fail(verdict === 'unknown' ? 'OWNER_HOST_SESSION_UNKNOWN' : 'OWNER_HOST_SESSION_REFUSED',
        verdict === 'unknown' ? 'The declared agent assignment could not be verified right now.'
          : 'The declared agent assignment or role revision is no longer current.');
    }
    const admission = Object.freeze(Object.create(null));
    sessionAdmissions.set(admission, binding.principal);
    return admission;
  }

  async function bindSession(value, scopeOptions = {}, admission = undefined) {
    if (closed || !listening) fail('OWNER_HOST_NOT_READY', 'The app-owned session authority is not ready.');
    if (!plain(scopeOptions) || Reflect.ownKeys(scopeOptions).some(key => !['workspaceRoot', 'agentApiMode', 'researchAccess'].includes(key))
        || (Object.hasOwn(scopeOptions, 'workspaceRoot')
          && (typeof scopeOptions.workspaceRoot !== 'string' || !path.isAbsolute(scopeOptions.workspaceRoot)))) {
      fail('OWNER_HOST_PERMISSION_UNAVAILABLE', 'The selected session workspace is invalid.');
    }
    const modePolicy = require('./lib/agent-api-mode');
    let researchAccess;
    try {
      researchAccess = Object.hasOwn(scopeOptions, 'researchAccess')
        ? validateResearchAccess(scopeOptions.researchAccess) : undefined;
      if (researchAccess === null) researchAccess = undefined;
    } catch (error) { fail(error.code || 'OWNER_HOST_PERMISSION_UNAVAILABLE', error.message); }
    if (researchAccess && scopeOptions.agentApiMode !== 'Only') {
      fail('AGENT_TOOL_MODE_REQUIRED', 'Research access requires agentApiMode Only.');
    }
    if (Object.hasOwn(scopeOptions, 'agentApiMode') && !modePolicy.AGENT_API_MODES.includes(scopeOptions.agentApiMode)) {
      fail('AGENT_TOOL_MODE_INVALID', 'The captured session tool mode is invalid.');
    }
    const binding = directPrincipal(value);
    const admittedPrincipal = admission === undefined ? null : sessionAdmissions.get(admission);
    if (admission !== undefined) {
      sessionAdmissions.delete(admission);
      if (!admittedPrincipal || !samePrincipal(admittedPrincipal, binding.principal)
          || credentialBySessionId.has(binding.principal.sessionId)) {
        fail('OWNER_HOST_SESSION_BINDING_INVALID', 'The session admission is not an unused admission for this exact session.');
      }
    }
    if (binding.principal.agentId === null) {
      return Object.freeze({ bound: false, mode: 'in-process', credential: null });
    }
    const existingCredential = credentialBySessionId.get(binding.principal.sessionId);
    const existing = existingCredential ? sessionBindings.get(existingCredential) : null;
    const agentApiMode = scopeOptions.agentApiMode ?? existing?.agentApiMode ?? require('./lib/agent-api-policy').agentApiMode();
    if (existing && agentApiMode !== existing.agentApiMode) {
      fail('OWNER_HOST_SESSION_COLLISION', 'The existing session tool mode cannot be changed by rebinding.');
    }
    if (existing && researchAccess !== undefined
        && JSON.stringify(researchAccess) !== JSON.stringify(existing.researchAccess)) {
      fail('OWNER_HOST_SESSION_COLLISION', 'The existing session research access cannot be changed by rebinding.');
    }
    if (existing && scopeOptions.workspaceRoot !== undefined
        && scopeOptions.workspaceRoot !== existing.selectedWorkspaceRoot) {
      fail('OWNER_HOST_SESSION_COLLISION', 'The existing session workspace cannot be changed by rebinding.');
    }
    if (existing && !boundPrincipalMatches(existing, binding.principal)) {
      fail('OWNER_HOST_SESSION_COLLISION', 'That session id is already bound to a different exact principal.');
    }
    /* Socket/ordinary first binds still require the displayed org revision.
       An app admission already checked that revision before preparation; both
       it and an exact retry must still match their own current seat and role. */
    const verdict = bindingVerdict(binding.principal, { fresh: !existing && !admittedPrincipal, issuing: !existing });
    if (verdict !== 'authorized') {
      // A completed, negative read retires the incumbent exactly as before.
      // A read that could not complete leaves it running: only this bind
      // attempt is refused, not the session it collided with.
      if (verdict === 'denied' && existing) retireBinding(existingCredential, 'bind-session-refusal');
      fail(verdict === 'unknown' ? 'OWNER_HOST_SESSION_UNKNOWN' : 'OWNER_HOST_SESSION_REFUSED',
        verdict === 'unknown'
          ? 'The declared agent assignment could not be verified right now.'
          : 'The declared agent assignment or role revision is no longer current.');
    }
    if (!existing) {
      let scope;
      try {
        scope = captureSessionScope(scopeOptions.workspaceRoot, researchAccess);
      } catch {
        fail('OWNER_HOST_PERMISSION_UNAVAILABLE', 'The current permission level could not be verified.');
      }
      let credential;
      do { credential = crypto.randomBytes(TOKEN_BYTES).toString('base64url'); }
      while (sessionBindings.has(credential));
      sessionBindings.set(credential, {
        principal: binding.principal,
        // The exact principal this credential was issued against; `principal`
        // above moves with a role revision rebind, this never does.
        issuedPrincipal: binding.principal,
        agentApiMode,
        toolMode: modePolicy.TOOL_MODES[agentApiMode],
        fileToolContext: require('./lib/file-tool-context').createFileToolContext({
          scopeKind: 'owner-host-session', agentId: binding.principal.agentId,
          sessionId: binding.principal.sessionId
        }),
        ...scope,
        selectedWorkspaceRoot: scopeOptions.workspaceRoot,
        ...(researchAccess === undefined ? {} : { researchAccess }),
        pendingExecs: new Set(),
        liveCalls: new Set(),
        workHeld: null,
        execCleanupFailure: null,
        sockets: new Set()
      });
      credentialBySessionId.set(binding.principal.sessionId, credential);
    }
    return Object.freeze({
      bound: true,
      mode: 'app-owned-owner-host',
      credential: credentialBySessionId.get(binding.principal.sessionId)
    });
  }

  async function revokeSession(value) {
    if (!listening && !closed) fail('OWNER_HOST_NOT_READY', 'The app-owned session authority is not ready.');
    const binding = directPrincipal(value, { credential: true });
    const existing = sessionBindings.get(binding.credential) || retiringBindings.get(binding.credential);
    if (existing && (!boundPrincipalMatches(existing, binding.principal)
        || existing.principal.sessionId !== binding.principal.sessionId)) {
      fail('OWNER_HOST_SESSION_REFUSED', 'The credential is not bound to that exact session principal.');
    }
    if (existing) await retireBinding(binding.credential, 'revoke');
    return Object.freeze({ revoked: true, mode: 'app-owned-owner-host' });
  }

  /* STOP THIS SESSION'S WORK WITHOUT ENDING THE SESSION.
   *
   * MEASURED on the native build (evidence grok-final-stop-report.json): a
   * provider Stop cancelled the model turn while the host.exec child it had
   * asked for -- an owned sixty-second command, pid 874779 -- REMAINED ALIVE
   * until root killed that exact pid by hand. Nothing here could have stopped
   * it: cancellation authority lives on the connection, and the only verbs
   * that reached it were revokeSession and close(), both of which retire the
   * binding. A Stop that had to revoke the credential would take the
   * session's tools away for good, so the turn stopped and the command did
   * not.
   *
   * THE LATCH IS THE HALF ABORTING CANNOT DO. The provider's own cancel does
   * not wait for anything: the ACP adapter writes session/cancel and returns,
   * so the model may submit another command while this is still draining, and
   * a line queued behind a running one is admitted later. So the latch is set
   * synchronously, before the first await, and every line admitted afterwards
   * is refused at dispatch until the APP resumes this session's work.
   *
   * RETRY, HONESTLY. An unproven termination cannot be retried at this layer:
   * the handle that could kill the child again lives inside the exec call that
   * already returned, and nothing here can reach it. The failure is therefore
   * retained on the binding and keeps refusing -- this cancel, a later cancel,
   * a resume, revoke and close all report it -- and the session is never
   * called reusable while it stands. Only the app's own recovery, or the owner
   * killing that process, can settle it.
   *
   * The connection is deliberately left alone on a successful stop: revoking
   * it here is what would let a stale completion race the next call. */
  function heldSessionBinding(value) {
    if (!listening && !closed) fail('OWNER_HOST_NOT_READY', 'The app-owned session authority is not ready.');
    const binding = directPrincipal(value, { credential: true });
    const existing = sessionBindings.get(binding.credential);
    if (!existing || credentialBySessionId.get(binding.principal.sessionId) !== binding.credential
        || !boundPrincipalMatches(existing, binding.principal)
        || existing.principal.sessionId !== binding.principal.sessionId) {
      fail('OWNER_HOST_SESSION_REFUSED', 'The credential is not bound to that exact session principal.');
    }
    return { binding, existing };
  }

  async function cancelSessionWork(value) {
    const { binding, existing } = heldSessionBinding(value);
    // Synchronous, before any await: a command submitted in the meantime is
    // refused at admission rather than started behind the stop.
    existing.workHeld = { reason: 'stop', at: Date.now() };
    const aborted = new Set();
    const drained = new Set();
    // Bounded: the latch admits nothing new, so each round either settles a
    // native command or leaves only calls with no child left to prove dead.
    for (let round = 0; round < 64; round += 1) {
      for (const controller of existing.liveCalls) {
        if (aborted.has(controller)) continue;
        aborted.add(controller);
        controller.abort();
      }
      const draining = [...existing.pendingExecs];
      if (!draining.length) break;
      for (const pending of draining) drained.add(pending);
      await Promise.allSettled(draining);
    }
    if (existing.execCleanupFailure) throw existing.execCleanupFailure;
    return Object.freeze({
      cancelled: aborted.size,
      awaited: drained.size,
      held: true,
      reusable: sessionBindings.has(binding.credential),
      mode: 'app-owned-owner-host'
    });
  }

  /* THE APP PUTTING THIS SESSION BACK TO WORK, and the only thing that can.
     Called before the next admitted send. It waits for anything the stop left
     draining, refuses while an unproven cleanup stands so a resume can never
     hide it, and otherwise lifts the latch. */
  async function resumeSessionWork(value) {
    const { existing } = heldSessionBinding(value);
    if (existing.pendingExecs.size) await Promise.allSettled([...existing.pendingExecs]);
    if (existing.execCleanupFailure) throw existing.execCleanupFailure;
    existing.workHeld = null;
    return Object.freeze({ resumed: true, mode: 'app-owned-owner-host' });
  }

  // Private app-memory assertion at the last provider-root boundary. This is
  // deliberately NOT bindSession(): verification must never mint a credential
  // or rebind one that was revoked while an asynchronous launcher prepared.
  // It is synchronous so the caller can check and spawn without yielding.
  function assertSession(value) {
    if (closed || !listening || !server.listening) fail('OWNER_HOST_NOT_READY', 'The app-owned session authority is not ready.');
    if (value?.agentId === null) {
      if (!plain(value) || Reflect.ownKeys(value).length !== 7 || value.credential !== null) {
        fail('OWNER_HOST_SESSION_BINDING_INVALID', 'The exact anonymous session binding is invalid.');
      }
      const { credential, ...principal } = value;
      directPrincipal(principal);
      return Object.freeze({ valid: true, mode: 'in-process' });
    }
    const binding = directPrincipal(value, { credential: true });
    const existing = sessionBindings.get(binding.credential);
    if (!existing || credentialBySessionId.get(binding.principal.sessionId) !== binding.credential
        || !boundPrincipalMatches(existing, binding.principal)) {
      fail('OWNER_HOST_SESSION_REFUSED', 'The retained credential no longer belongs to that exact session.');
    }
    const verdict = bindingVerdict(existing.principal);
    if (verdict !== 'authorized') {
      fail(verdict === 'unknown' ? 'OWNER_HOST_SESSION_UNKNOWN' : 'OWNER_HOST_SESSION_REFUSED',
        verdict === 'unknown' ? 'The declared agent assignment could not be verified right now.'
          : 'The declared agent assignment or role revision is no longer current.');
    }
    return Object.freeze({ valid: true, mode: 'app-owned-owner-host' });
  }

  // Private main-process query only: no new control socket operation or
  // caller-supplied workspace authority. Used by tree delegation admission.
  function readSessionScope(value) {
    assertSession(value);
    const binding = sessionBindings.get(value.credential);
    if (!binding) fail('OWNER_HOST_SESSION_REFUSED', 'A declared live session is required.');
    return Object.freeze(currentSessionScope(binding));
  }

  server.on('connection', socket => {
    // Pause before attaching the line handler: no handshake, public resolve,
    // or control operation may run until the kernel has identified the peer.
    let peerVerified = platform !== 'linux';
    if (!peerVerified) socket.pause();
    sockets.add(socket);
    const socketController = new AbortController();
    socketControllers.set(socket, socketController);
    socket.once('close', () => {
      socketController.abort();
      sockets.delete(socket);
      if (principal?.credential) sessionBindings.get(principal.credential)?.sockets.delete(socket);
    });
    socket.setEncoding('utf8');
    /* Reaps a socket that never completes the handshake. Named, not inline,
       because Socket#setTimeout(msecs, callback) does `this.once('timeout',
       callback)` -- it ADDS a 'timeout' listener, it does not replace
       whatever is already registered. A later socket.setTimeout(idleTimeoutMs,
       ...) call (armIdleTimeout, below) therefore leaves this exact listener
       attached: without removing it by this same reference once the socket
       is authorized, BOTH listeners fire on every future 'timeout' event, so
       an idle window that armIdleTimeout correctly decided to survive was
       still ended by this stale handshake listener destroying the socket in
       the same tick. MEASURED by Manager 5: a fresh net.Socket given two
       setTimeout calls carries listenerCount('timeout') === 2, and a 31
       minute and, injected, a 4-second idle-survival run both died with the
       proxy reporting "ToolsEnabled ended this session's tool access" until
       this listener was removed on authorize (see below). */
    function destroyForHandshakeTimeout() { socket.destroy(); }
    socket.setTimeout(handshakeTimeoutMs, destroyForHandshakeTimeout);
    let buffer = '';
    let principal = null;
    let serial = Promise.resolve();
    const respond = value => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
    };
    /* The liveness bound on an AUTHORIZED data socket, armed once per idle
       window rather than once per connection. Node's socket idle timer fires
       once and does not repeat on its own, so re-arming here is what keeps
       the bound checking every subsequent window instead of only the first.

       WHY sessionBindings.has(principal.credential) IS CHECKED HERE, AND WHY
       IT IS NOT DEAD CODE. Every path in this file that removes a credential
       from sessionBindings (retireBinding) also destroys every socket that
       credential's binding held, including this one -- so under this file's
       own invariants, a socket whose timer is still able to fire always
       still has its credential in sessionBindings. That is exactly what this
       check enforces rather than assumes: an authorized session that has
       simply been thinking or working for one idle window, with its binding
       still live, is recorded and re-armed, never destroyed -- destroying it
       is the defect Manager 5's M1 measures ("a bound session surviving
       thirty minutes"). Only a socket whose binding is ALREADY gone -- a
       state that should be unreachable given the invariant above, but which
       this still guards rather than trusts -- is destroyed here. Keep the
       check even though the "already gone" branch may never fire in
       practice: it is the thing standing between "the invariant holds" and
       "a future change to sessionBindings quietly reintroduces the kill". */
    function armIdleTimeout() {
      socket.setTimeout(idleTimeoutMs, () => {
        if (socket.destroyed) return;
        if (sessionBindings.has(principal.credential)) {
          try {
            observeSessionRetired({
              event: 'owner-host-session-idle-timeout',
              reason: 'idle-timeout-survived',
              sessionId: principal.sessionId
            });
          } catch { /* an observer failure must not block re-arming */ }
          armIdleTimeout();
          return;
        }
        // Nothing is being retired here -- the binding already left
        // sessionBindings by some other path, and this is only a leftover
        // transport being reaped, not a session ending.
        try {
          observeSessionRetired({
            event: 'owner-host-session-idle-timeout',
            reason: 'idle-timeout-orphan-reaped',
            sessionId: principal.sessionId
          });
        } catch { /* an observer failure must not block the liveness bound */ }
        socket.destroy();
      });
    }
    socket.on('data', chunk => {
      if (!peerVerified) { socket.destroy(); return; }
      buffer += chunk;
      const ceiling = principal ? maxMessageBytes + 1 : MAX_HANDSHAKE_BYTES;
      if (Buffer.byteLength(buffer, 'utf8') > ceiling) {
        socket.destroy();
        return;
      }
      while (!socket.destroyed) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (!principal) {
          let request;
          try { request = JSON.parse(line); } catch { socket.destroy(); return; }
          const binding = validBindSession(request, token);
          if (binding) {
            const existingCredential = credentialBySessionId.get(binding.principal.sessionId);
            const existing = existingCredential ? sessionBindings.get(existingCredential) : null;
            /* A first bind is held to the org snapshot the app displayed; an
               exact retry of an existing binding is a running session and is
               held only to its own seat and role. */
            const bindingVerdictResult = bindingVerdict(binding.principal, { fresh: !existing, issuing: !existing });
            /* THE SAME MATCH THE IN-PROCESS bindSession USES, and it has to be
               the same one. This is the control-plane door the app reaches
               through agent-session-credential's bindAgentSessionCredential,
               and after a role edit rebound the session the app still holds
               only the principal it BOUND with. Comparing that against the
               binding's moved principal alone made an exact retry read as
               another agent's session and destroyed the control socket --
               the role edit ending the running session by a second door. */
            if (existing && !boundPrincipalMatches(existing, binding.principal)) {
              // The session id is already owned by a different exact
              // principal.  Refuse the collision without touching the valid
              // incumbent binding: otherwise a caller that only knows a
              // session id could revoke another agent by presenting a
              // different provider/agent tuple.
              socket.destroy();
              return;
            }
            if (bindingVerdictResult !== 'authorized') {
              // A role edit, or an edit to this agent's own seat, invalidates
              // an already-issued session on the next control-plane touch,
              // and retiring it here also closes every live data socket
              // rather than merely refusing this retry -- but only once the
              // read actually SAW that. A read that threw learned nothing
              // about the incumbent, so this bind attempt alone is refused.
              if (bindingVerdictResult === 'denied' && existing) {
                retireBinding(existingCredential, 'socket-bind-refusal');
              }
              socket.destroy();
              return;
            }
            if (!existing) {
              let scope;
              let agentApiMode;
              try {
                scope = captureSessionScope();
                agentApiMode = require('./lib/agent-api-policy').agentApiMode();
              } catch {
                socket.destroy();
                return;
              }
              let credential;
              do { credential = crypto.randomBytes(TOKEN_BYTES).toString('base64url'); }
              while (sessionBindings.has(credential));
              sessionBindings.set(credential, {
                principal: binding.principal,
                // Recorded on BOTH bind doors or the rebind is half-built: a
                // binding created here with no issuedPrincipal would, after a
                // role edit moved `principal`, match neither name the app can
                // present.
                issuedPrincipal: binding.principal,
                agentApiMode,
                toolMode: require('./lib/agent-api-mode').TOOL_MODES[agentApiMode],
                fileToolContext: require('./lib/file-tool-context').createFileToolContext({
                  scopeKind: 'owner-host-session', agentId: binding.principal.agentId,
                  sessionId: binding.principal.sessionId
                }),
                ...scope,
                pendingExecs: new Set(),
                liveCalls: new Set(),
                workHeld: null,
                execCleanupFailure: null,
                sockets: new Set()
              });
              credentialBySessionId.set(binding.principal.sessionId, credential);
            }
            respond({
              type: 'session-bound',
              protocolVersion: CAPABILITY_VERSION,
              credential: credentialBySessionId.get(binding.principal.sessionId)
            });
            socket.end();
            return;
          }
          const revocation = validRevokeSession(request, token);
          if (revocation) {
            const existing = sessionBindings.get(revocation.credential) || retiringBindings.get(revocation.credential);
            if (existing && existing.principal.sessionId !== revocation.sessionId) {
              socket.destroy();
              return;
            }
            // A success acknowledgement is a cleanup barrier, not just a
            // credential deletion acknowledgement. A failed drain closes the
            // control channel without falsely acknowledging session-revoked.
            socket.pause();
            retireBinding(revocation.credential, 'revoke').then(() => {
              respond({ type: 'session-revoked', protocolVersion: CAPABILITY_VERSION });
              socket.end();
            }, () => socket.destroy());
            return;
          }
          const resolved = validPublicResolveSession(request, sessionBindings)
            || validResolveSession(request, token, sessionBindings);
          if (resolved) {
            const resolveVerdict = resolved.principal ? bindingVerdict(resolved.principal) : null;
            // A moved role revision is rebound here too, so the principal a
            // loopback caller (the mission bridge) is handed names the same
            // revision the next socket line will dispatch under.
            const resolvedBinding = resolveVerdict === 'authorized' ? sessionBindings.get(resolved.credential) : null;
            if (resolvedBinding) rebindRoleRevision(resolvedBinding);
            // A completed "no longer current" retires the binding. A read
            // that threw answers only this resolve call "refused" without
            // touching the binding -- the next resolve gets a fresh read.
            if (resolved.principal && resolveVerdict === 'denied') {
              retireBinding(resolved.credential, 'resolve');
            }
            respond(resolveVerdict === 'authorized'
              ? {
                type: 'session-resolved',
                protocolVersion: CAPABILITY_VERSION,
                principal: (resolvedBinding || resolved).principal
              }
              : { type: 'session-refused', protocolVersion: CAPABILITY_VERSION });
            socket.end();
            return;
          }
          const authorized = validAuthorize(request, sessionBindings);
          const authorizedBinding = authorized ? sessionBindings.get(request.credential) : null;
          const authorizeVerdict = authorized ? bindingVerdict(authorized) : null;
          if (!authorized || !authorizedBinding || authorizeVerdict !== 'authorized') {
            // A completed "no" retires the binding along with this attempt.
            // A read that threw learned nothing, so only this connection
            // attempt is refused; the binding and its other sockets stand.
            if (authorizedBinding && authorizeVerdict === 'denied') {
              retireBinding(request.credential, 'authorize');
            }
            socket.destroy();
            return;
          }
          principal = Object.freeze({ ...authorized, credential: request.credential });
          sessionBindings.get(request.credential).sockets.add(socket);
          // The handshake bound's job ends here: this socket is now
          // authorized, so its own listener must stop applying, by the
          // exact reference it was registered with, or it keeps firing
          // alongside armIdleTimeout's listener forever (see the comment on
          // destroyForHandshakeTimeout above for the measured failure this
          // caused). off(), not setTimeout(0, ...), so the removal itself
          // does not depend on Socket#setTimeout's less-obvious msecs===0
          // special case.
          socket.off('timeout', destroyForHandshakeTimeout);
          armIdleTimeout();
          respond({ type: 'authorized', protocolVersion: CAPABILITY_VERSION });
          continue;
        }
        const currentBinding = sessionBindings.get(principal.credential);
        const identityMismatch = !currentBinding
          || currentBinding.principal.sessionId !== principal.sessionId
          || currentBinding.principal.agentActor !== principal.agentActor
          || currentBinding.principal.agentId !== principal.agentId;
        if (identityMismatch) {
          if (currentBinding) retireBinding(principal.credential, 'per-line-recheck');
          socket.destroy();
          return;
        }
        const lineVerdict = bindingVerdict(currentBinding.principal);
        if (lineVerdict === 'denied') {
          retireBinding(principal.credential, 'per-line-recheck');
          socket.destroy();
          return;
        }
        if (lineVerdict === 'unknown') {
          // The org/role read threw -- nothing was learned about this
          // session. Refuse only this one line; the socket and binding stay
          // up so the next line gets a fresh read instead of a dead MCP
          // transport for an agent that is still authorized.
          respond(authorizationUnknownError(line));
          continue;
        }
        if (Buffer.byteLength(line, 'utf8') > maxMessageBytes) {
          socket.destroy();
          return;
        }
        // The seat and role were just confirmed. A role whose revision moved
        // is rebound in place before this line's policy is read, so the line
        // dispatches under the edited definition and the session lives on.
        rebindRoleRevision(currentBinding);
        let agentRole;
        try { agentRole = boundRoleFunctionPolicy(principal, options); }
        catch { respond(authorizationUnknownError(line)); continue; }
        let scope;
        try { scope = currentSessionScope(currentBinding); }
        catch { respond(authorizationUnknownError(line)); continue; }
        /* One controller per call, composed with the connection's. The session
           cancel below aborts only these, so a stopped turn never costs the
           connection its tool access. */
        const callController = new AbortController();
        const callOptions = {
          signal: AbortSignal.any([socketController.signal, callController.signal]),
          toolMode: currentBinding.toolMode,
          agentApiMode: currentBinding.agentApiMode,
          ...(agentRole === undefined ? {} : { agentRole }),
          agentActor: principal.agentActor,
          fileToolContext: currentBinding.fileToolContext,
          ...(principal.agentId ? { agentId: principal.agentId } : {}),
          agentSessionId: principal.sessionId,
          ...(principal.agentId ? {
            // From the BINDING, not this socket's authorize-time snapshot: a
            // rebind moved the binding's role revision and the dispatched
            // principal has to name the revision the line is served under.
            agentPrincipal: Object.freeze({
              kind: 'agent-session',
              sessionId: currentBinding.principal.sessionId,
              agentId: currentBinding.principal.agentId,
              provider: currentBinding.principal.agentActor,
              roleId: currentBinding.principal.roleId,
              expectedOrgRevision: currentBinding.principal.expectedOrgRevision,
              expectedRoleRevision: currentBinding.principal.expectedRoleRevision
            })
          } : {}),
          ...scope
        };
        const resolveDispatchContext = () => {
          if (closed || sessionBindings.get(principal.credential) !== currentBinding) {
            respond(authorizationUnknownError(line));
            return null;
          }
          const verdict = bindingVerdict(currentBinding.principal);
          if (verdict === 'denied') {
            retireBinding(principal.credential, 'queued-dispatch-recheck');
            return null;
          }
          if (verdict !== 'authorized') {
            respond(authorizationUnknownError(line));
            return null;
          }
          try {
            return { ...callOptions,
              agentRole: boundRoleFunctionPolicy(principal, options),
              ...currentSessionScope(currentBinding) };
          } catch {
            respond(authorizationUnknownError(line));
            return null;
          }
        };
        if (scheduledDispatch) {
          dispatchWithCleanup(currentBinding, line, respond, write =>
            scheduledDispatch(line, write, { ...callOptions, resolveDispatchContext }, principal.sessionId),
          callController)
            .catch(error => respond(dispatchFailure(line, error)));
          continue;
        }
        serial = serial
          .then(() => {
            const refreshed = resolveDispatchContext();
            return refreshed === null ? undefined : dispatchWithCleanup(currentBinding, line, respond,
              write => dispatchLine(line, write, refreshed), callController);
          })
          .catch(error => respond(dispatchFailure(line, error)));
      }
    });
    socket.on('error', () => { /* close owns cleanup; never expose peer data */ });
    if (!peerVerified) {
      linuxAuthority.assertPeer(socket).then(() => {
        if (socket.destroyed || closed) return;
        peerVerified = true;
        socket.resume();
      }, () => socket.destroy());
    }
  });

  async function listen() {
    if (closed) fail('OWNER_HOST_CLOSED', 'The owner host is already closed.');
    if (listening) return api;
    if (platform === 'linux') {
      await linuxAuthority.checkPrerequisite();
      linuxAuthority.prepareSocketDirectory(pipeName);
    }
    if (!hygieneComplete) {
      try { await credentialHygiene(); }
      catch {
        fail('OWNER_HOST_CREDENTIAL_HYGIENE_FAILED', 'Credential hygiene failed, so the owner host was not started.');
      }
      hygieneComplete = true;
    }
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      // The app, owner host, and its agent children share the installation's
      // exact Windows principal. Keep the pipe at Node's same-principal
      // default; a random route plus an opaque session credential is not a
      // reason to make the transport reachable across Windows accounts.
      // Linux binds inside a verified 0700 directory, then narrows the socket
      // to 0600 before publishing its route; each connection also proves UID.
      server.listen({ path: pipeName });
    });
    try {
      if (platform === 'linux') linuxAuthority.protectSocket(pipeName);
      published = writeCapability({
        file: capabilityFile,
        controlFile: controlCapabilityFile,
        pipeName,
        generation,
        token,
        principals,
        publishControl: options.publishControlCapability === true,
        io: options.fs || fs,
        platform,
        spawnSyncImpl: Object.hasOwn(options, 'spawnSyncImpl') ? options.spawnSyncImpl : spawnSync,
        environment: options.environment || process.env,
        allowTestPath: options.allowTestPaths === true
      });
    } catch (error) {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      throw error;
    }
    listening = true;
    // Stamp WHICH app instance this surface belongs to. Without it, a
    // previous instance's still-live broker reads as a fresh surface in
    // system.status while every session bound to it has no tools (T159).
    try { broker.recordMcpSurface?.({ transport: 'owner-host', ownerHostGeneration: generation }); } catch {}
    return api;
  }

  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    const sessionClosures = [...sessionBindings.keys()].map(credential => retireBinding(credential, 'owner-host-closed'));
    for (const retired of retiringBindings.values()) sessionClosures.push(retired.settled);
    for (const socket of sockets) {
      socketControllers.get(socket)?.abort();
      socket.destroy();
    }
    if (published) removeCapability({
      file: capabilityFile,
      controlFile: controlCapabilityFile,
      token,
      pipeName,
      generation,
      publishedControl: options.publishControlCapability === true,
      io: options.fs || fs,
      platform
    });
    // Unpublish synchronously before awaiting server teardown so app shutdown
    // cannot leave a live-looking route behind. Exact generation matching
    // prevents this old host from removing a newer route.
    closePromise = (async () => {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      const outcomes = await Promise.allSettled(sessionClosures);
      token.fill(0);
      const failure = outcomes.find(outcome => outcome.status === 'rejected');
      if (failure) throw failure.reason;
    })();
    return closePromise;
  }

  const api = Object.freeze({
    server,
    sockets,
    pipeName,
    generation,
    capabilityFile,
    controlCapabilityFile,
    sessionBindings,
    admissionVersion: 1,
    admitSession,
    bindSession,
    revokeSession,
    cancelVersion: 2,
    cancelSessionWork,
    resumeSessionWork,
    assertSession,
    scopeVersion: 1,
    researchAccessVersion: 1,
    toolModeVersion: 1,
    readSessionScope,
    listen,
    close,
    isListening: () => listening && server.listening,
    capabilityPublished: () => Boolean(published)
  });
  return api;
}

async function start(options = {}) {
  const host = createOwnerHost(options);
  await host.listen();
  if (options.installSignalHandlers !== false) {
    const shutdown = () => host.close()
      .then(() => { process.exitCode = 0; })
      .catch(() => { process.exitCode = 1; });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
  return host;
}

if (require.main === module) {
  process.stderr.write('ToolsEnabled owner host is app-owned. Close and reopen ToolsEnabled normally.\n');
  process.exitCode = 1;
}

module.exports = Object.freeze({
  AGENT_ACTORS,
  CAPABILITY_FILE,
  CONTROL_CAPABILITY_FILE,
  RETIREMENT_LOG_FILE,
  CAPABILITY_VERSION,
  HANDSHAKE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  OWNER_PERMISSION_SESSION,
  OwnerHostError,
  PIPE_PREFIX,
  TOKEN_BYTES,
  WINDOWS_ICACLS,
  WINDOWS_PRINCIPAL_RE,
  WINDOWS_SYSTEM_ROOT,
  WINDOWS_WHOAMI,
  capabilityRecord,
  controlCapabilityRecord,
  createOwnerHost,
  authorizationUnknownError,
  internalError,
  removeCapability,
  start,
  systemIcacls,
  validAuthorize,
  validBindSession,
  validResolveSession,
  validRevokeSession,
  authorizeDeclaredAgentBinding,
  validatedPrincipals,
  writeCapability
});
