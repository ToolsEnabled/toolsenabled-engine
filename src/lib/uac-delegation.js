'use strict';

// UAC delegation core.
//
// PURPOSE. Windows UAC stays FULLY ON. This module does not weaken any Windows
// security posture. It lets the coordinator run a FIXED, product-declared set of
// elevated operations (config/uac-delegation-allowlist.json) without a UAC
// prompt reaching the owner for each one, by talking to a small elevated helper
// (src/uac-delegation-helper.js) over a local named pipe. The helper is a
// scheduled task registered ONCE (that one registration is the single
// elevation-prompting step the owner performs) and started on demand -- never a
// permanently running admin service, never a visible console window.
//
// WHAT THIS MODULE IS. The pure, dependency-injected decision core:
//   - parse + strictly validate the allowlist (unknown keys rejected),
//   - resolve an operation id to fixed executables/argv (no shell, no caller
//     argv, only the ${OWNER_PRINCIPAL} placeholder resolved from the helper's
//     own operating-system identity),
//   - verify the per-boot token,
//   - check the kill switch,
//   - emit a signed audit event on BOTH accept and refuse (audit.requireRecord,
//     matching src/lib/controller-launch-record.js),
//   - and, only on accept, execute the fixed steps.
//
// WHAT IT IS NOT. It never accepts an arbitrary command, an arbitrary argv, a
// shell string, or an executable off PATH. It grants no authority of its own:
// every operation must be explicitly present in the shipped allowlist.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stateRoot, statePath } = require('./runtime-state-root');
const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_VERSION = 1;

const PIPE_NAME = '\\\\.\\pipe\\ToolsEnabled.UacDelegation.V1';
// The scheduled task that runs the elevated helper on demand. Registered by
// tools/uac-delegation-task.ps1 (which owns the same literal as its -TaskName
// default). Exported so the non-elevated client does not keep a private fourth
// copy of the string.
const HELPER_TASK_NAME = 'ToolsEnabled UAC Delegation Helper';
// The allowlist is a program resource: it ships with the build, is read and
// never written, and belongs beside the program. An empty list is a valid,
// fail-closed product default.
const ALLOWLIST_FILE = path.join(ROOT, 'config', 'uac-delegation-allowlist.json');
// The per-boot token is the opposite: written every boot, owner-ACL'd, and
// per-user. Installed, it goes to the user's state root, because the program's
// own directory is replaced by the next update and is not guaranteed writable.
// See src/lib/runtime-state-root.js.
const TOKEN_FILE = statePath('state', 'uac-delegation-token.json');

const DECISION_ACTION = 'uac.delegation.decision';
const OUTCOME_ACTION = 'uac.delegation.outcome';

const OPERATION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN_BYTES = 32;
const TOKEN_B64URL_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding
// Any letter or digit, not only ASCII: Windows account names are the person's
// own name, and "Ana María López" is as legal an account as "owner". Measured
// 2026-08-19 in a sealed-build foreign run: the ASCII-only predecessor of this
// pattern made ownerPrincipal() throw for that name, and because mission-bridge
// writeRuntimeDiscovery() ACLs its record to the owner at boot, the refusal
// took the whole capability layer down on any machine whose username carries an
// accent. What this pattern is FOR is the argv boundary, and that part is
// unchanged: the principal is spliced into `${principal}:(F)` for icacls and
// into allowlist step arguments, so `:`, parentheses, quotes, pipes, dollar
// signs and control characters stay refused exactly as before.
const OWNER_PRINCIPAL_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._\\-]{0,255}$/u;
const WINDOWS_SYSTEM32 = '\\\\.\\GLOBALROOT\\SystemRoot\\System32';
const OWNER_PRINCIPAL_PLACEHOLDER = '${OWNER_PRINCIPAL}';
const STEP_TIMEOUT_MS = 120_000;

// The ONLY executables the allowlist may name, each resolved to its fixed
// absolute path under %SystemRoot%\System32. Naming anything else is a parse
// error -- even a locally reviewed allowlist cannot point at an arbitrary
// binary, so a tampered PATH cannot redirect an elevated step.
const KNOWN_EXECUTABLES = Object.freeze(['schtasks.exe', 'netsh.exe', 'powershell.exe', 'sc.exe']);

class UacDelegationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'UacDelegationError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) { throw new UacDelegationError(code, message, details); }

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function systemRoot() {
  const configured = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir;
  return configured && configured.trim() ? configured : 'C:\\Windows';
}

function resolveExecutable(name) {
  if (typeof name !== 'string' || !KNOWN_EXECUTABLES.includes(name)) {
    fail('UAC_ALLOWLIST_INVALID', `exec "${name}" is not one of the fixed known executables (${KNOWN_EXECUTABLES.join(', ')}).`);
  }
  const system32 = path.join(systemRoot(), 'System32');
  // Unlike schtasks/netsh/sc, Windows PowerShell is not directly under
  // System32. Resolving it as `System32\\powershell.exe` creates a fixed but
  // nonexistent path, so an otherwise accepted elevated allowlist operation
  // fails with ENOENT before its guarded script can run.
  if (name === 'powershell.exe') {
    return path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  return path.join(system32, name);
}

// --- allowlist parse (strict) -------------------------------------------------

/* THE IDENTITY PROBE IS whoami, IT RETRIES, AND A SLOW ANSWER IS NOT A FAILURE
 * (T454).
 *
 * WHAT THIS COST. The probe below used to be Windows PowerShell alone, with
 * `timeout: 5000`, and every caller treated one slow answer as a permanent
 * refusal. MEASURED on this build machine under full CPU load: the same
 * `[Security.Principal.WindowsIdentity]::GetCurrent().Name` command took
 * 8876 ms, so execFileSync killed it, the catch raised
 * UAC_OWNER_PRINCIPAL_INVALID, mission-bridge's writeRuntimeDiscovery() -- which
 * calls this while ACLing the runtime discovery record to the owner -- turned
 * that into a throw, and the app logged
 * `[capability-layer] not started: CAPABILITY_EXITED ... exited with code 1`.
 * Nothing retried, so a loaded machine had no capability layer at all: no agent
 * session can start without one. The identity had not changed and was never in
 * doubt. Only the clock was.
 *
 * WHY whoami FIRST. Almost none of that 8876 ms was the question. Windows
 * PowerShell has to start a CLR, load its modules and JIT before it can answer,
 * and that start-up is what a loaded box stretches. whoami.exe is a single
 * small binary that reads the process token and prints it, and
 * src/owner-host.js validatedPrincipals() already reads the SAME token the SAME
 * way (`whoami /user /fo csv /nh`) for the SID. This asks the identical
 * question of the identical tool and takes field ONE, the account name, where
 * that one takes field two, the SID.
 *
 * ONE DIFFERENCE, STATED RATHER THAN DISCOVERED LATER: whoami prints the
 * account name lower-cased where PowerShell preserves the registered case. The
 * principal is spliced into `${principal}:(F)` for icacls and into allowlist
 * step arguments; Windows account names are case-insensitive at every one of
 * those boundaries, so the grant is the same grant. The domain-backslash-user
 * SHAPE and the OWNER_PRINCIPAL_RE argv check are unchanged, and both are
 * still applied to whatever a probe returns.
 *
 * POWERSHELL IS STILL HERE, as the second probe: it is the one that shipped and
 * was proved, so if whoami is missing or prints something this cannot parse,
 * the old question is still asked before anything is refused.
 *
 * AND A REFUSAL NOW SEPARATES TWO THINGS THAT ARE NOT ALIKE. A probe that
 * ANSWERED with a name that is not a valid principal is permanent and keeps
 * UAC_OWNER_PRINCIPAL_INVALID. A probe that never answered -- timed out, or
 * could not be spawned -- is UAC_OWNER_PRINCIPAL_UNAVAILABLE, which a caller
 * may retry. Collapsing those two is what let a slow clock read as a broken
 * machine. */
const IDENTITY_PROBE_TIMEOUT_MS = 20_000;
const IDENTITY_PROBE_ATTEMPTS = 3;
/* Nothing to wait for before the first attempt; the later waits are short
   because what is being waited out is scheduler contention on this machine,
   not a remote service. */
const IDENTITY_PROBE_BACKOFF_MS = Object.freeze([0, 250, 1000]);
const WINDOWS_WHOAMI = `${WINDOWS_SYSTEM32}\\whoami.exe`;
/* whoami /user /fo csv /nh prints exactly one row, the account name then its
   SID, both quoted: "DOMAIN\user","S-1-5-21-...". */
const WHOAMI_USER_CSV_RE = /^"((?:[^"]|"")+)","S-\d+(?:-\d+){2,15}"$/i;

/* The probe is synchronous (execFileSync), so its backoff has to be too.
   Atomics.wait on a private buffer parks the thread rather than spinning a
   busy loop, which matters precisely because the machine is already loaded. */
function sleepSync(milliseconds) {
  if (!(milliseconds > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function domainQualified(name) {
  return typeof name === 'string' && name.length > 0
    && OWNER_PRINCIPAL_RE.test(name) && /^[^\\]+\\[^\\]+$/.test(name);
}

function probeOptions() {
  return {
    encoding: 'utf8', windowsHide: true, shell: false,
    timeout: IDENTITY_PROBE_TIMEOUT_MS, maxBuffer: 4096,
    stdio: ['ignore', 'pipe', 'ignore'], env: {}
  };
}

function whoamiIdentity(run) {
  const output = String(run(WINDOWS_WHOAMI, ['/user', '/fo', 'csv', '/nh'], probeOptions())).trim();
  const match = output.match(WHOAMI_USER_CSV_RE);
  /* CSV doubles an embedded quote. No Windows account name may contain one,
     but undoing it here keeps the parse honest rather than lucky. */
  return match ? match[1].split('""').join('"') : null;
}

function powershellIdentity(run) {
  // SSH and service environments can name WORKGROUP rather than the account's
  // actual domain. Read the process token and preserve Unicode; a guessed
  // environment identity must never receive the token's ACL.
  const script = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Security.Principal.WindowsIdentity]::GetCurrent().Name';
  return String(run(
    `${WINDOWS_SYSTEM32}\\WindowsPowerShell\\v1.0\\powershell.exe`,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    probeOptions()
  )).trim();
}

/* Answers { name } on success, or { answered } -- whether ANY probe returned a
   string at all, which is the difference between "this machine told us
   something invalid" and "nothing answered in time". */
function windowsIdentityName(deps = {}) {
  const run = deps.execFileSyncImpl || execFileSync;
  const wait = deps.sleepSyncImpl || sleepSync;
  let answered = false;
  for (let attempt = 0; attempt < IDENTITY_PROBE_ATTEMPTS; attempt += 1) {
    wait(IDENTITY_PROBE_BACKOFF_MS[attempt] ?? IDENTITY_PROBE_BACKOFF_MS[IDENTITY_PROBE_BACKOFF_MS.length - 1]);
    for (const probe of [whoamiIdentity, powershellIdentity]) {
      let name;
      try { name = probe(run); }
      catch { continue; }
      if (typeof name === 'string' && name.length > 0) answered = true;
      if (domainQualified(name)) return { name };
    }
  }
  return { answered };
}

function ownerPrincipal(deps = {}) {
  if (typeof deps.ownerPrincipal === 'string' && deps.ownerPrincipal) {
    if (!OWNER_PRINCIPAL_RE.test(deps.ownerPrincipal)) fail('UAC_OWNER_PRINCIPAL_INVALID', 'The supplied owner principal is not a valid account name.');
    return deps.ownerPrincipal;
  }
  if ((deps.platform || process.platform) === 'win32' && deps.env === undefined) {
    const probed = windowsIdentityName(deps);
    if (probed.name) return probed.name;
    if (probed.answered) {
      fail('UAC_OWNER_PRINCIPAL_INVALID', 'The helper could not establish a valid Windows process identity.');
    }
    fail('UAC_OWNER_PRINCIPAL_UNAVAILABLE',
      'The helper could not read the current Windows process identity yet. This is usually a busy machine, and it can be retried.',
      { attempts: IDENTITY_PROBE_ATTEMPTS, timeoutMs: IDENTITY_PROBE_TIMEOUT_MS });
  }
  const env = deps.env || process.env;
  const domain = (env.USERDOMAIN || '').trim();
  const user = (env.USERNAME || '').trim();
  const principal = domain ? `${domain}\\${user}` : user;
  if (!principal || !OWNER_PRINCIPAL_RE.test(principal)) {
    fail('UAC_OWNER_PRINCIPAL_INVALID', 'The helper could not resolve a valid owner principal from its environment.');
  }
  return principal;
}

function resolveArgs(args, principal) {
  if (!Array.isArray(args) || args.length === 0) fail('UAC_ALLOWLIST_INVALID', 'step.args must be a non-empty array.');
  return Object.freeze(args.map((arg, index) => {
    if (typeof arg !== 'string') fail('UAC_ALLOWLIST_INVALID', `step.args[${index}] must be a string.`);
    const substituted = arg.split(OWNER_PRINCIPAL_PLACEHOLDER).join(principal);
    // After the single permitted substitution, no other ${...} template may
    // remain -- an unknown placeholder is an authoring error, never a caller
    // channel.
    if (/\$\{/.test(substituted)) fail('UAC_ALLOWLIST_INVALID', `step.args[${index}] contains an unsupported placeholder.`);
    return substituted;
  }));
}

function parseStep(step, index, principal) {
  if (!plain(step)) fail('UAC_ALLOWLIST_INVALID', `steps[${index}] must be an object.`);
  const keys = Object.keys(step);
  if (keys.some(key => !['exec', 'args'].includes(key)) || !Object.hasOwn(step, 'exec') || !Object.hasOwn(step, 'args')) {
    fail('UAC_ALLOWLIST_INVALID', `steps[${index}] has unexpected or missing keys; only 'exec' and 'args' are allowed.`);
  }
  return Object.freeze({ executable: resolveExecutable(step.exec), args: resolveArgs(step.args, principal) });
}

function parseOperation(operation, principal) {
  if (!plain(operation)) fail('UAC_ALLOWLIST_INVALID', 'each operation must be an object.');
  const keys = Object.keys(operation);
  if (keys.some(key => !['id', 'description', 'steps'].includes(key)) ||
      !Object.hasOwn(operation, 'id') || !Object.hasOwn(operation, 'steps')) {
    fail('UAC_ALLOWLIST_INVALID', "an operation has unexpected or missing keys; only 'id', 'description', 'steps' are allowed (id, steps required).");
  }
  if (typeof operation.id !== 'string' || !OPERATION_ID_RE.test(operation.id)) fail('UAC_ALLOWLIST_INVALID', `operation id "${operation.id}" is invalid.`);
  if (Object.hasOwn(operation, 'description') && typeof operation.description !== 'string') fail('UAC_ALLOWLIST_INVALID', `operation "${operation.id}" description must be a string.`);
  if (!Array.isArray(operation.steps) || operation.steps.length === 0) fail('UAC_ALLOWLIST_INVALID', `operation "${operation.id}" must have a non-empty steps array.`);
  return Object.freeze({
    id: operation.id,
    description: typeof operation.description === 'string' ? operation.description : '',
    steps: Object.freeze(operation.steps.map((step, index) => parseStep(step, index, principal)))
  });
}

/**
 * Strictly parse an allowlist object into a frozen { schemaVersion, operations:
 * Map<id, resolvedOperation> }. Rejects unknown top-level keys, unknown
 * per-operation keys, unknown per-step keys, unknown executables, and any
 * residual argument placeholder. The owner principal is resolved once here so
 * resolved argv carry no template text.
 */
function parseAllowlist(raw, deps = {}) {
  if (!plain(raw)) fail('UAC_ALLOWLIST_INVALID', 'the allowlist must be a JSON object.');
  const allowedTop = ['$comment', 'schemaVersion', 'operations'];
  const keys = Object.keys(raw);
  if (keys.some(key => !allowedTop.includes(key))) fail('UAC_ALLOWLIST_INVALID', `the allowlist has unknown top-level key(s): ${keys.filter(key => !allowedTop.includes(key)).join(', ')}.`);
  if (raw.schemaVersion !== SCHEMA_VERSION) fail('UAC_ALLOWLIST_INVALID', `allowlist schemaVersion must be ${SCHEMA_VERSION}.`);
  if (!Array.isArray(raw.operations)) fail('UAC_ALLOWLIST_INVALID', 'allowlist.operations must be an array.');
  const principal = raw.operations.length > 0 ? ownerPrincipal(deps) : null;
  const operations = new Map();
  for (const operation of raw.operations) {
    const resolved = parseOperation(operation, principal);
    if (operations.has(resolved.id)) fail('UAC_ALLOWLIST_INVALID', `duplicate operation id "${resolved.id}".`);
    operations.set(resolved.id, resolved);
  }
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, operations });
}

function readAllowlistRaw(file, io = fs) {
  let text;
  try { text = io.readFileSync(file, 'utf8'); }
  catch (error) { fail('UAC_ALLOWLIST_UNAVAILABLE', `the allowlist file could not be read: ${error && error.message}.`); }
  try { return JSON.parse(text); }
  catch { fail('UAC_ALLOWLIST_INVALID', 'the allowlist file is not valid JSON.'); }
  return undefined; // unreachable
}

function loadAllowlist(deps = {}) {
  const raw = deps.allowlistRaw !== undefined ? deps.allowlistRaw : readAllowlistRaw(deps.allowlistFile || ALLOWLIST_FILE, deps.fs || fs);
  return parseAllowlist(raw, deps);
}

function resolveOperation(allowlist, operationId) {
  if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) fail('UAC_NOT_ALLOWED', 'the requested operation id is not a valid identifier.');
  const operation = allowlist.operations.get(operationId);
  if (!operation) fail('UAC_NOT_ALLOWED', `operation "${operationId}" is not in the allowlist.`, { operationId });
  return operation;
}

// --- per-boot token -----------------------------------------------------------

// The token is bound to the current boot. os.uptime() drifts by a few seconds
// across reads, so the boot instant is rounded to the minute to give a stable
// id: a token minted this boot stays valid this boot, and a token file left
// over from a previous boot is treated as stale and refused/regenerated.
function currentBootId(deps = {}) {
  const now = (deps.clock || Date.now)();
  const uptime = (deps.uptime || os.uptime)();
  return String(Math.round((now - uptime * 1000) / 60_000));
}

function validTokenRecord(value, bootId) {
  return plain(value) && value.version === SCHEMA_VERSION && value.bootId === bootId
    && typeof value.token === 'string' && TOKEN_B64URL_RE.test(value.token);
}

function readTokenFile(file, io = fs) {
  let text;
  try { text = io.readFileSync(file, 'utf8'); }
  catch (error) {
    // A genuinely absent token may be minted by the helper. Any other read
    // failure is not evidence of absence: in particular, treating EACCES or an
    // I/O fault as "missing" would let loadOrCreateToken replace a credential
    // whose current value could not be established.
    if (error && error.code === 'ENOENT') return null;
    fail('UAC_TOKEN_UNAVAILABLE', `the delegation token file could not be read: ${error && error.message}.`);
  }
  try { return JSON.parse(text); }
  catch { return null; }
}

function writeTokenFile({ file, token, bootId, principal, io = fs, spawnSyncImpl, platform = process.platform }) {
  /* Named tokenDirectory, not stateRoot: the imported stateRoot() is the
     product's state root and this is the one directory inside it that holds
     this file. The two were briefly the same identifier, and the local const
     shadowed the import so completely that the guard below read
     `"C:\\...\\state"()` and the bridge failed to start with "stateRoot is not
     a function". Nothing in the source LOOKED wrong; it was found by running
     the packaged app. */
  const tokenDirectory = path.dirname(file);
  /* CONTAINMENT, RETARGETED -- NOT RELAXED. This guard exists so a caller
     cannot talk writeTokenFile() into minting an owner-ACL'd credential at a
     path of its choosing, and it still refuses exactly that. What changed is
     WHERE the product's own state legitimately lives: installed, it is the
     per-user state root rather than the program directory, which an update
     replaces and a per-machine install makes read-only. In a source checkout
     the two are the same directory and this check is byte-identical to what it
     was. See src/lib/runtime-state-root.js. */
  if (!inside(stateRoot(), file)) fail('UAC_TOKEN_UNAVAILABLE', 'the token path is outside the state root.');
  io.mkdirSync(tokenDirectory, { recursive: true, ...(platform === 'linux' ? { mode: 0o700 } : {}) });
  const record = { version: SCHEMA_VERSION, bootId, token: token.toString('base64url'), createdAt: new Date().toISOString() };
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    io.writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (platform === 'win32' && spawnSyncImpl !== false) {
      const runSpawn = spawnSyncImpl || require('node:child_process').spawnSync;
      const acl = runSpawn(`${WINDOWS_SYSTEM32}\\icacls.exe`, [path.toNamespacedPath(temp), '/inheritance:r', '/grant:r', `${principal}:(F)`], {
        encoding: 'utf8', stdio: 'ignore', windowsHide: true, shell: false, timeout: 15_000
      });
      if (acl.error || acl.status !== 0) fail('UAC_TOKEN_UNAVAILABLE', 'the token file could not be access-controlled to the owner only.');
    }
    io.renameSync(temp, file);
  } catch (error) {
    // A failed preparation must retain the prior token, not delete it. The
    // new record becomes visible only after its owner ACL is established.
    if (error instanceof UacDelegationError) throw error;
    fail('UAC_TOKEN_UNAVAILABLE', `the token file could not be written: ${error && error.message}.`);
  } finally {
    try { io.unlinkSync(temp); } catch { /* best effort */ }
  }
}

/** Helper-side: return the current-boot token, creating and owner-locking it if
 * absent or stale. Used by the elevated helper on startup. */
function loadOrCreateToken(deps = {}) {
  const file = deps.tokenFile || TOKEN_FILE;
  const io = deps.fs || fs;
  const bootId = currentBootId(deps);
  const existing = readTokenFile(file, io);
  if (validTokenRecord(existing, bootId)) return Buffer.from(existing.token, 'base64url');
  const token = deps.token || crypto.randomBytes(TOKEN_BYTES);
  // The mission bridge shares this per-boot credential storage on Linux, but
  // it does not use Windows ACLs or a Windows account-name argv. Requiring
  // USERNAME here made a real fresh Linux bridge fail before it could listen.
  // Keep ownerPrincipal's Windows validation and all elevated allowlist policy
  // unchanged; on Linux new directories/files use native 0700/0600 modes.
  const platform = deps.platform || process.platform;
  const principal = platform === 'linux' ? null : ownerPrincipal(deps);
  writeTokenFile({ file, token, bootId, principal, io, platform, spawnSyncImpl: deps.spawnSyncImpl });
  return token;
}

/** Client-side: read the current-boot token. Throws if it is missing or stale
 * -- the caller must start the elevated helper (which mints it) first. */
function readToken(deps = {}) {
  const file = deps.tokenFile || TOKEN_FILE;
  const bootId = currentBootId(deps);
  const existing = readTokenFile(file, deps.fs || fs);
  if (!validTokenRecord(existing, bootId)) fail('UAC_TOKEN_UNAVAILABLE', 'no current-boot delegation token is available; start the elevated helper first.');
  return Buffer.from(existing.token, 'base64url');
}

function verifyToken(supplied, expected) {
  if (!Buffer.isBuffer(supplied) || !Buffer.isBuffer(expected) || supplied.length !== expected.length || supplied.length === 0) return false;
  try { return crypto.timingSafeEqual(supplied, expected); } catch { return false; }
}

// --- execution ----------------------------------------------------------------

function safeMessage(value) {
  return String(value && value.message ? value.message : value).replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function defaultRunOperation(resolved, deps = {}) {
  const run = deps.execFileSync || execFileSync;
  const steps = [];
  for (const step of resolved.steps) {
    try {
      run(step.executable, step.args, {
        cwd: deps.cwd || ROOT, encoding: 'utf8', timeout: STEP_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
        env: safeLaunchEnvironment(process.env, { context: 'uac delegation operation' })
      });
      steps.push({ executable: step.executable, ok: true, exitCode: 0 });
    } catch (error) {
      steps.push({ executable: step.executable, ok: false, exitCode: Number.isInteger(error && error.status) ? error.status : null, error: safeMessage(error) });
      return { ok: false, steps };
    }
  }
  return { ok: true, steps };
}

// --- the decision + audit + execute path -------------------------------------

/**
 * Evaluate and act on one delegation request. Order: token, then kill switch,
 * then allowlist -- and a signed audit event is written for the decision on
 * BOTH accept and refuse before any external effect. On accept, the fixed steps
 * run and a best-effort outcome audit follows.
 *
 * deps: { expectedToken: Buffer, allowlist?, allowlistRaw?/allowlistFile?,
 *         audit?, killSwitch?, runOperation?, auditDeps?, ownerPrincipal? }
 */
function handleRequest(request, deps = {}) {
  const audit = deps.audit || require('./audit');
  const killSwitch = deps.killSwitch || require('./kill-switch');
  const suppliedToken = request && Buffer.isBuffer(request.suppliedToken) ? request.suppliedToken : null;
  const rawOperationId = request && typeof request.operationId === 'string' ? request.operationId : null;
  const auditTarget = rawOperationId && OPERATION_ID_RE.test(rawOperationId) ? rawOperationId : '<invalid>';

  let decision = 'refuse';
  let reason = null;
  let resolved = null;

  if (!verifyToken(suppliedToken, deps.expectedToken)) {
    reason = 'token';
  } else if (killSwitch.status().active) {
    reason = 'killswitch';
  } else {
    try {
      const allowlist = deps.allowlist || loadAllowlist(deps);
      resolved = resolveOperation(allowlist, rawOperationId);
      decision = 'accept';
      reason = 'allowed';
    } catch (error) {
      reason = error instanceof UacDelegationError && error.code === 'UAC_NOT_ALLOWED' ? 'not-allowlisted' : 'allowlist-error';
    }
  }

  // Signed decision audit -- required on both accept and refuse. Fails closed:
  // if the intent cannot be durably recorded, the operation does not run.
  audit.requireRecord(DECISION_ACTION, auditTarget, {
    schemaVersion: SCHEMA_VERSION, decision, reason, tokenPresented: Boolean(suppliedToken)
  }, deps.auditDeps);

  if (decision !== 'accept') {
    return Object.freeze({ decision, reason, operationId: auditTarget });
  }

  const runOperation = deps.runOperation || defaultRunOperation;
  let outcome;
  try { outcome = runOperation(resolved, deps); }
  catch (error) { outcome = { ok: false, steps: [], error: safeMessage(error) }; }

  // Best-effort outcome audit: the effect already happened, so a failure to
  // record the outcome must not throw back over it.
  let outcomeAudit;
  try {
    audit.record(OUTCOME_ACTION, auditTarget, {
      schemaVersion: SCHEMA_VERSION, ok: Boolean(outcome && outcome.ok), steps: (outcome && outcome.steps) || []
    }, deps.auditDeps);
    outcomeAudit = Object.freeze({ recorded: true });
  } catch (error) {
    // The effect must still be returned, but do not turn an unestablished audit
    // write into the definite claim that the outcome was recorded.
    outcomeAudit = Object.freeze({ recorded: false, error: safeMessage(error) });
  }

  return Object.freeze({ decision, reason, operationId: auditTarget, outcome, outcomeAudit });
}

// --- Full UAC Bypass integration point --------------------------------------
//
// "Full UAC Bypass" is Windows' OWN on/off switch (the EnableLUA policy
// value) -- a separate, far more permissive posture than the fixed-allowlist
// actuator above, and deliberately kept OFF that actuator's rails. It is
// never added to config/uac-delegation-allowlist.json. A standing allowlist entry would
// let any future agent flip Windows' own UAC posture through the named-pipe
// helper without the account owner ever seeing a prompt. The toggle state is
// therefore an owner-side control, not delegated agent authority.
//
// The only actuator for this posture is tools/uac-tray-controller.ps1, which
// asks Windows for a FRESH `Start-Process -Verb RunAs` native consent dialog
// on every single toggle. Only the owner's own physical click on that OS
// dialog can approve it; this module, the delegation helper, and its named
// pipe are never in that loop, so the toggle can never become agent-writable
// no matter what compromises this process. This module's role is narrow and
// additive: the SAME kill switch every other elevated path in this file
// already respects, and the SAME tamper-evident audit trail (src/lib/audit.js)
// already used above, so "was Full UAC Bypass ever toggled, when, and was the
// kill switch checked immediately before" lives in the one ledger instead of
// a second one. Nothing here reads, writes, or even knows the actual Windows
// registry value -- that stays entirely inside the elevated PowerShell
// helper, the only process that ever runs with the token to change it.

const FULL_BYPASS_DECISION_ACTION = 'uac.full-bypass.decision';
const FULL_BYPASS_OUTCOME_ACTION = 'uac.full-bypass.outcome';
const FULL_BYPASS_TARGET = 'full-uac-bypass';
const FULL_BYPASS_STATE_FILE = statePath('state', 'uac-full-bypass-state.json');
const FULL_BYPASS_STATES = Object.freeze(['on', 'off']);

/**
 * Throws UAC_FULL_BYPASS_BLOCKED when the global kill switch is active.
 * Called by the elevated tray helper immediately before it touches the
 * registry -- same ordering as handleRequest() above: gate, then audit, then
 * (only on accept) the effect. Called again right before every write so a
 * kill switch engaged while the owner was still looking at the native UAC
 * dialog is still honored (no cached decision survives that gap).
 */
function checkFullBypassAllowed(deps = {}) {
  const killSwitch = deps.killSwitch || require('./kill-switch');
  if (killSwitch.status().active) {
    fail('UAC_FULL_BYPASS_BLOCKED', 'the kill switch is active; Full UAC Bypass cannot be toggled while it is engaged.');
  }
}

/**
 * Required (fail-closed) decision audit for one Full UAC Bypass toggle
 * attempt, mirroring DECISION_ACTION above: if the intent cannot be durably
 * recorded, the caller must not touch the registry -- audit.requireRecord
 * throws in that case, and the caller is expected to let that throw abort
 * the toggle before any registry write.
 */
function auditFullBypassDecision({ requestedState, decision, reason, principal } = {}, deps = {}) {
  if (!FULL_BYPASS_STATES.includes(requestedState)) {
    fail('UAC_FULL_BYPASS_INVALID', `requestedState must be one of ${FULL_BYPASS_STATES.join(', ')}.`);
  }
  const audit = deps.audit || require('./audit');
  audit.requireRecord(FULL_BYPASS_DECISION_ACTION, FULL_BYPASS_TARGET, {
    schemaVersion: SCHEMA_VERSION, requestedState, decision, reason: reason || null, principal: principal || null
  }, deps.auditDeps);
}

/**
 * Best-effort outcome audit after the registry write attempt, mirroring
 * OUTCOME_ACTION above: the effect (or its failure) already happened, so a
 * failure to record it must not throw back over it.
 */
function auditFullBypassOutcome({ requestedState, ok, appliedEnableLua, error } = {}, deps = {}) {
  const audit = deps.audit || require('./audit');
  try {
    audit.record(FULL_BYPASS_OUTCOME_ACTION, FULL_BYPASS_TARGET, {
      schemaVersion: SCHEMA_VERSION, requestedState, ok: Boolean(ok),
      appliedEnableLua: Number.isInteger(appliedEnableLua) ? appliedEnableLua : null,
      error: error ? safeMessage(error) : null
    }, deps.auditDeps);
    return Object.freeze({ recorded: true });
  } catch (auditError) {
    // Best effort means the completed registry attempt is not rolled back or
    // rethrown; it does not mean callers must mistake an unreadable ledger for
    // proof that the outcome record exists.
    return Object.freeze({ recorded: false, error: safeMessage(auditError) });
  }
}

module.exports = Object.freeze({
  UacDelegationError,
  SCHEMA_VERSION, PIPE_NAME, HELPER_TASK_NAME, ALLOWLIST_FILE, TOKEN_FILE, KNOWN_EXECUTABLES,
  DECISION_ACTION, OUTCOME_ACTION, OPERATION_ID_RE, TOKEN_BYTES,
  parseAllowlist, loadAllowlist, resolveOperation, ownerPrincipal,
  currentBootId, loadOrCreateToken, readToken, verifyToken,
  defaultRunOperation, handleRequest,
  FULL_BYPASS_DECISION_ACTION, FULL_BYPASS_OUTCOME_ACTION, FULL_BYPASS_TARGET,
  FULL_BYPASS_STATE_FILE, FULL_BYPASS_STATES,
  checkFullBypassAllowed, auditFullBypassDecision, auditFullBypassOutcome
});
