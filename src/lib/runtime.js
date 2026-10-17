const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const {
  VAULT_PLATFORM_UNSUPPORTED,
  assertVaultPlatform,
  assertWindowsVaultPlatform,
  vaultPlatformRefusal
} = require('./vault-platform');
const { execFileSync, spawnSync } = require('node:child_process');
const { programOrStatePath, statePath, resolveStateRoot } = require('./runtime-state-root');

const ROOT = path.resolve(__dirname, '..', '..');
const SECRET_KEY_RE = /^[A-Za-z0-9_.-]+$/;

/* WHO IS ASKING FOR A SECRET, CARRIED THE ONLY WAY IT CAN BE.
 *
 * Every vault read in this file is reached through provider code that takes no
 * principal and must not learn one -- `d.getSecret(key)` is called from dozens
 * of providers, and threading an identity through each would mean every future
 * provider is one forgotten argument away from an unenforced read. So the
 * identity travels out of band: src/lib/tool-registry.js sets it once around
 * the handler call, and the read sites below take it from here.
 *
 * DEFAULT EMPTY MEANS UNRULED, NOT UNRESTRICTED-BY-ACCIDENT. A read with no
 * store is the installation reading its own credentials (startup, audit
 * signing, sign-in), which the owner's per-agent switches are not about. That
 * is the same rule the host application's shell/vault-presence.cjs applies to its
 * own `principal`-less caller, and it is asserted by test rather than assumed:
 * a tool dispatch that failed to set this would be an unenforced read, so the
 * test that matters is the one driving executeTool, not this module. */
const vaultPrincipalContext = new AsyncLocalStorage();

// ROOT IS WHERE THE PROGRAM IS. IT IS NOT ALWAYS WHERE THE PROGRAM WRITES.
//
// Installed, the program lives in a directory that an update replaces wholesale
// and that a per-machine install makes read-only, so state/, logs/, vault/,
// captures/, profiles/, reports/ and the KILLSWITCH marker resolve to a per-user state root instead.
// src/lib/runtime-state-root.js makes that decision and documents the measured
// defect behind it; every other top-level name still resolves against ROOT.
//
// In a source checkout nothing is redirected and every path this returns is
// byte-identical to what it returned before, which is what let this land under
// a running system.
function rootPath(...parts) {
  return programOrStatePath(ROOT, parts);
}

function safeChildEnvironment(context) {
  // Lazy because launch-environment reaches this module through the
  // provider gateway during startup. At call time that graph is initialized.
  // Every caller of this function spawns powershell.exe (the vault helper,
  // tools/secrets.ps1) -- SEC11: naming that child here also drops the
  // PowerShell 7 entries a PowerShell-7-launched parent would otherwise leak
  // into that 5.1 child. See supervision/launch-environment.js.
  return require('./supervision/launch-environment.js')
    .safeLaunchEnvironment(process.env, { context, childExecutable: 'powershell.exe' });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Unable to read JSON ${file}: ${error.message}`);
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

// Cache only successful executable lookups. A miss or an unavailable helper is
// rechecked on the next status call, and environment changes invalidate hits.
const COMMAND_PATH_HIT_TTL_MS = 60_000;
const commandPathHits = new Map();
let commandPathEnvKey = null;

function commandPathEnvironment() {
  return [
    process.env.PATH || '', process.env.PATHEXT || '',
    // POSIX PATH entries and slash paths may be relative. An unset PATH also
    // uses the process launcher's default, whereas an empty PATH means cwd.
    process.platform === 'win32' ? '' : process.cwd(),
    process.platform === 'win32' ? '' : typeof process.env.PATH
  ].join('\u0000');
}

function commandPath(command) {
  const envKey = commandPathEnvironment();
  if (envKey !== commandPathEnvKey) {
    commandPathHits.clear();
    commandPathEnvKey = envKey;
  }
  const key = String(command);
  const remembered = commandPathHits.get(key);
  if (remembered && Date.now() - remembered.atMs < COMMAND_PATH_HIT_TTL_MS) return remembered.value;
  if (remembered) commandPathHits.delete(key);
  // A throw leaves the table untouched: unknown is not an answer.
  const resolved = resolveCommandPath(command);
  if (resolved) commandPathHits.set(key, { value: resolved, atMs: Date.now() });
  return resolved;
}

// Exists so a suite can drive the same process through a changed filesystem
// without waiting out the TTL. Not part of the capability surface.
function resetCommandPathCache() {
  commandPathHits.clear();
  commandPathEnvKey = null;
}

function resolveCommandPath(command) {
  function unknown(causeCode) {
    const error = new Error(
      `Command lookup for '${command}' could not be completed (${causeCode}), so whether it is installed is unknown; this is not a claim that it is absent.`
    );
    error.code = 'COMMAND_LOOKUP_UNKNOWN';
    error.causeCode = causeCode;
    return error;
  }
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  const found = spawnSync(probe, [command], { encoding: 'utf8', windowsHide: true, shell: false });
  // Minimal OpenShell installations need not contain the optional `which`
  // utility. Only its absence permits a direct lookup; a refused, timed out,
  // or otherwise failed helper still means that readiness is unknown.
  if (process.platform !== 'win32' && found.error?.code === 'ENOENT') {
    const name = String(command);
    if (!name) return null;
    const searchPath = process.env.PATH === undefined ? '/usr/bin:/bin' : process.env.PATH;
    const candidates = name.includes('/') ? [path.resolve(name)]
      : searchPath.split(path.delimiter).map(directory => path.resolve(directory || '.', name));
    for (const candidate of candidates) {
      try {
        if (!fs.statSync(candidate).isFile()) continue;
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
        throw unknown(error.code || 'FILESYSTEM_STAT');
      }
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) continue;
        throw unknown(error.code || 'FILESYSTEM_ACCESS');
      }
    }
    return null;
  }
  if (found.error || found.status === null) {
    const causeCode = found.error && found.error.code
      ? found.error.code
      : (found.signal ? `SIGNAL_${found.signal}` : 'NO_ANSWER');
    throw unknown(causeCode);
  }
  if (found.status === 0) {
    const candidate = String(found.stdout || '').split(/\r?\n/).find(Boolean) || command;
    if (process.platform === 'win32' && !path.extname(candidate) && fs.existsSync(`${candidate}.cmd`)) return `${candidate}.cmd`;
    return candidate;
  }
  return null;
}

function commandExists(command) {
  return Boolean(commandPath(command));
}

function assertSecretKey(key) {
  if (typeof key !== 'string' || !SECRET_KEY_RE.test(key)) throw new Error('Invalid secret key.');
  return key;
}

function secretError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Run `callback` with this dispatch attributed to `principals`.
 *
 * Called by src/lib/tool-registry.js around every tool handler. The identities
 * are the authenticated ones from the session binding -- the role id and the
 * agent id -- never a caller-supplied string, because a principal an agent can
 * choose is a switch an agent can turn off.
 */
function withVaultPrincipal(principals, callback) {
  if (typeof callback !== 'function') throw new TypeError('Vault principal callback must be a function.');
  const named = (Array.isArray(principals) ? principals : [principals])
    .filter(value => typeof value === 'string' && value !== '');
  if (named.length === 0) return callback();
  return vaultPrincipalContext.run(Object.freeze(named.slice()), callback);
}

/* THE OWNER'S SWITCH, ENFORCED BEFORE THE VAULT IS OPENED.
 *
 * WHERE THIS IS CALLED FROM AND WHY EXACTLY THERE. Every function below that
 * can yield a decrypted value calls this FIRST -- before the in-process value
 * cache, before the persistent vault host, before the Linux reader, before
 * powershell.exe exists. A refused read therefore never starts a vault process
 * and never holds a value it must then discard: there is no moment at which a
 * denied credential exists in this process. A check placed after the cache would
 * be skipped on a cache hit, which is the failure this ordering exists to avoid.
 *
 * ONE DENIED KEY REFUSES THE WHOLE BATCH. Returning the allowed subset silently
 * is how a caller ends up using a credential it was not given while believing it
 * received everything it asked for.
 *
 * THE REFUSAL IS AUDITED, AND THE AUDIT IS NOT ALLOWED TO WEAKEN IT. The record
 * is written best-effort with audit.record rather than audit.requireRecord: a
 * denial is already the safe outcome, and making it depend on a durable append
 * would mean an unavailable ledger could only ever turn a refusal into a
 * different refusal -- extra failure modes for no extra safety. The row names
 * the record and the principals and never the value.
 *
 * audit.js IS REQUIRED LAZILY, AND THAT IS LOAD-BEARING. It reads its own
 * signing key through this file, so a top-level require here is a cycle that
 * would hand audit.js a half-initialised runtime. The audit call is also made
 * with the principal context CLEARED: the ledger writing a row about a denial
 * is the product acting, not the agent, and a denial that could not record
 * itself because its own audit read was denied would be unrecoverable.
 */
/* THE PRINCIPAL HAS TO SURVIVE A PROCESS BOUNDARY.
 *
 * The store is an AsyncLocalStorage, and a child process is born with an empty
 * one -- which assertVaultReadAllowed read as "unruled" and therefore allowed.
 * So an agent at a tier that admits an exec tool never had to defeat the
 * owner's switches: it ran a command, and the command's process read every
 * credential with no rule applied. The switch governed one process.
 *
 * A child that was spawned inside a principal context now carries that context
 * in its environment and is ruled by it. The value is built per spawn from the
 * live context rather than stamped on process.env, because two agent lanes run
 * concurrently in one process and a mutated global would hand one lane the
 * other's principal -- or clear it.
 *
 * This does not make an unruled read impossible; a caller that builds a child
 * environment by hand still produces one. It removes the case that mattered:
 * the ordinary exec path, where the agent never had to do anything clever. */
const VAULT_PRINCIPAL_ENV = 'TOOLSENABLED_VAULT_PRINCIPALS';

function currentVaultPrincipals() {
  const principals = vaultPrincipalContext.getStore();
  return Array.isArray(principals) && principals.length ? principals.slice() : [];
}

function inheritedVaultPrincipals(environment = process.env) {
  const raw = environment && environment[VAULT_PRINCIPAL_ENV];
  if (typeof raw !== 'string' || raw === '') return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  return Array.isArray(parsed)
    ? parsed.filter(value => typeof value === 'string' && value !== '')
    : [];
}

/* Stamp the current principal onto a child environment. Callers that spawn
   anything an agent chose the command for build the child's environment
   through this. */
function vaultPrincipalEnvironment(environment = {}) {
  const principals = currentVaultPrincipals();
  if (!principals.length) return environment;
  return { ...environment, [VAULT_PRINCIPAL_ENV]: JSON.stringify(principals) };
}

function assertVaultReadAllowed(keys) {
  const inProcess = vaultPrincipalContext.getStore();
  const principals = Array.isArray(inProcess) && inProcess.length
    ? inProcess
    : inheritedVaultPrincipals();
  if (!principals || principals.length === 0) return;
  const policy = require('./vault-access-policy');
  const read = policy.readPolicy(undefined, { file: rootPath('state', 'vault-access-policy.json') });
  const wanted = Array.isArray(keys) ? keys : [keys];
  for (const key of wanted) {
    const verdict = policy.mayRead(read, key, principals);
    if (verdict.allowed) continue;
    try {
      vaultPrincipalContext.run(undefined, () => {
        require('./audit').record('vault.read_refused', `vault:${key}`, {
          principals: principals.slice(), code: verdict.code, policyCode: read.code
        });
      });
    } catch { /* The refusal below is the outcome that matters; it stands either way. */ }
    throw secretError(verdict.code, verdict.detail);
  }
}

function vaultScript() {
  assertWindowsVaultPlatform();
  const script = rootPath('tools', 'secrets.ps1');
  if (!fs.existsSync(script)) throw new Error('Secret vault is not installed. Run install.ps1 -Phase 2.');
  return script;
}

// WHERE THE VAULT FILE IS. This mirrors tools/secrets.ps1's own resolution
// (its $configuredVault / $VaultFile block): the TOOLSENABLED_VAULT_PATH
// environment variable if set, else <repo>/vault/secrets.json. The duplication
// is unavoidable -- JavaScript cannot ask the PowerShell script where it keeps
// its file without paying the very process spawn this exists to avoid -- so it
// is written once, here, next to the other vault code rather than copied into
// each caller. If secrets.ps1's path rule ever changes, this changes with it.
function vaultFilePath() {
  const configured = process.env.TOOLSENABLED_VAULT_PATH;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return path.resolve(configured.trim());
  }
  return rootPath('vault', 'secrets.json');
}

// TELLING THE POWERSHELL HALF WHERE THE VAULT MOVED, WITHOUT ASKING IT TO
// REDERIVE THE ANSWER.
//
// rootPath('vault', ...) above now redirects to the per-user state root on an
// installed payload. tools/secrets.ps1 is a separate program that resolves its
// own $VaultFile, so unless it is told, Node reads one file and the script
// writes another -- a split vault, which presents as "the credential I just
// entered is not configured" and is far worse than either location alone.
//
// The script already has exactly the seam needed: TOOLSENABLED_VAULT_PATH wins
// over everything. So the decision stays in JavaScript, in one place, and is
// COMMUNICATED to the script rather than reimplemented in PowerShell. Every
// vault spawn below inherits process.env, so publishing it once here covers all
// of them, plus any grandchild and any other helper that reads the variable.
//
// It is deliberately inert in a source checkout: nothing is redirected there,
// so the branch never runs and the environment is untouched. And it never
// overrides a value an operator set on purpose.
(function publishVaultPathForHelperPrograms() {
  const alreadySet = typeof process.env.TOOLSENABLED_VAULT_PATH === 'string'
    && process.env.TOOLSENABLED_VAULT_PATH.trim() !== '';
  if (alreadySet) return;
  const selected = resolveStateRoot();
  const resolvedVault = path.join(selected.redirected ? selected.root : ROOT, 'vault', 'secrets.json');
  if (path.resolve(resolvedVault) === path.join(ROOT, 'vault', 'secrets.json')) return;
  process.env.TOOLSENABLED_VAULT_PATH = resolvedVault;
}());

// TELLING EVERY OTHER HELPER PROGRAM THE SAME THING, ONCE.
//
// The publisher above solves exactly one file's version of this problem. The
// rest of the helper programs use the same state root rather than writing
// mutable files beneath the installed program directory.
//
// It matters most where nothing else can say it: an MCP client starting
// src/mcp-server.js straight out of an install has no Electron shell, and the
// root is derived from the PAYLOAD.json marker inside this process alone.
// Without this line a helper spawned from there cannot learn the answer.
//
// Inert in a source checkout -- nothing is redirected, so the branch never runs
// -- and it never overrides a value an operator set on purpose.
(function publishStateRootForHelperPrograms() {
  const alreadySet = typeof process.env.TOOLSENABLED_STATE_ROOT === 'string'
    && process.env.TOOLSENABLED_STATE_ROOT.trim() !== '';
  if (alreadySet) return;
  const selected = resolveStateRoot();
  const resolvedState = path.join(selected.redirected ? selected.root : ROOT, 'state');
  if (path.resolve(resolvedState) === path.join(ROOT, 'state')) return;
  process.env.TOOLSENABLED_STATE_ROOT = path.dirname(resolvedState);
}());

// A CHEAP CHANGE-DETECTOR FOR POLLING CALLERS, and the reason it exists.
//
// Every real vault read spawns a full powershell.exe (readSecretFromVault
// above, via execFileSync). That is correct for a one-off read and ruinous on
// a timer: src/full-remote-access-bridge.js polls its token every 2 seconds
// for as long as the bridge lives, which is ~43,000 process creations per day
// on a service that is idle almost all of that time. Measured 2026-08-09 on
// a development machine as a standing, unexplained CPU cost.
//
// A secret cannot change without the vault file changing, so a stat is a sound
// gate in front of the expensive read. It returns null when the file cannot be
// stat'd, and callers MUST treat null as "unknown, read for real" -- never as
// "unchanged". This value says only that nothing has changed since the last
// look; it is never evidence that a secret is present, valid, or authorized.
function vaultFingerprint() {
  try {
    const stats = fs.statSync(vaultFilePath());
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return null;
  }
}

// THE SAME GATE, BUT SOUND ENOUGH TO PUT IN FRONT OF AN INTEGRITY DECISION.
//
// vaultFingerprint() above is mtime:size. That is the right key for a polling
// caller that only wants to skip redundant work: if it is ever fooled, the
// poller re-reads a tick later and nothing was decided on the stale value.
// It is the WRONG key for a value a verifier will act on. Both halves are
// attacker-controllable by an ordinary same-user process -- a rewrite that
// preserves length plus SetFileTime restores both -- so a cache keyed on it
// can be made to serve a remembered answer over bytes that have since
// changed. shell/spawn-record.cjs reached the same conclusion for its
// verdictCache and keys on file CONTENT for exactly this reason.
//
// This is the content-hash form: two identical digests mean the vault file's
// bytes are identical, so every value inside it -- including the protected
// audit head anchor -- is identical too. Every vault write re-encrypts the
// whole file under DPAPI, so a changed secret can never leave the bytes
// unchanged.
//
// Returns null when the file cannot be read. Callers MUST treat null as
// "unknown, read for real", never as "unchanged"; this value is never
// evidence that a secret is present, valid, or authorized.
// Inside a person's OpenShell sandbox there is no desktop keyring, so the
// vault is the sandbox vault (src/lib/vault-openshell.js); the ToolsEnabled
// host that serves sandboxes from outside uses the same state-file vault under
// its own root. Everywhere else it is the Linux keyring vault. Checked per
// call, like process.platform below.
function linuxVault() {
  return require('./openshell-inside').usesStateFileVault() ? require('./vault-openshell') : require('./vault-linux');
}

function vaultContentDigest() {
  // Linux key availability can change while its ciphertext does not (a locked
  // keyring, or a removed master key). Never let a file digest cache authorize
  // a Linux read or an audit anchor without consulting its secure backend.
  if (process.platform === 'linux') return null;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(vaultFilePath())).digest('hex');
  } catch {
    return null;
  }
}


// A DECRYPTED VAULT VALUE MAY BE REMEMBERED WHILE THE VAULT FILE'S BYTES ARE
// UNCHANGED, FOR A BOUNDED TIME. AN UNCERTAIN ANSWER MAY NOT.
//
// Every read below spawns a full powershell.exe. Measured on a development
// machine 2026-09-03: ~220 ms of that is interpreter start and ~130 ms is
// parsing tools/secrets.ps1, before any decryption happens. The pathology is
// bursts: readSecretsFromVault's own header records that oauthKeysFor() asks
// twice per call and list() once per registered account, so one cloud tool
// call pays several back to back for an answer that cannot have changed in
// between. Measured the same day: cloud.account_list had a median of 3.6
// seconds, almost all of it these spawns.
//
// THE EVIDENCE THAT LETS A READ BE SKIPPED is the one readAnchor() and
// vaultRecordPresence() already rely on, and the argument is theirs: a vault
// value cannot change without the vault FILE changing, because every write
// re-encrypts the whole file under DPAPI. Identical bytes therefore mean an
// identical answer.
//
// Four rules, each load-bearing, and the first three are copied deliberately
// from the two caches that came before this one:
//   * The key is the file's CONTENT hash, never size+mtime. Both halves of a
//     stat are attacker-controllable by an ordinary same-user process.
//   * A digest that cannot be computed is UNKNOWN, never 'unchanged': null
//     skips the cache in both directions and reads for real.
//   * The digest is captured BEFORE the read, so a remembered pair can only
//     ever be (older-or-equal digest, this-or-newer value).
//   * ONLY DEFINITE ANSWERS ARE REMEMBERED: a value the vault returned, or
//     the vault's own mechanical 'not configured'. A read that FAILED is not
//     an answer about the record, and caching one would turn a transient
//     failure into a durable claim.
//
// AND ONE RULE THE OTHERS DO NOT HAVE. Those two remember a boolean and an
// anchor; this remembers decrypted secrets, so holding them for the life of a
// long-running process would leave plaintext credentials resident far longer
// than reading them on demand does. The window is therefore short and fixed:
// long enough to collapse the burst that is the actual cost, too short to
// become storage. It is not a security control -- the digest rule is what
// makes the answer correct -- it is a limit on how long plaintext sits in a
// heap for a saving nobody needs after a minute.
const SECRET_CACHE_TTL_MS = 60_000;
const SECRET_CACHE_MAX_ENTRIES = 32;
const secretValueCache = new Map();

// Called by every write path in this file. A write by THIS process changes the
// bytes, so every remembered pairing is stale by construction; a write by any
// other process is caught by the digest instead.
function invalidateSecretValueCache() {
  secretValueCache.clear();
}

function rememberSecretValue(key, digest, value) {
  if (digest === null) return value;
  if (secretValueCache.size >= SECRET_CACHE_MAX_ENTRIES) secretValueCache.clear();
  secretValueCache.set(key, { digest, value, atMs: Date.now() });
  return value;
}

// The remembered answer for this key, or undefined for 'ask the vault'.
function rememberedSecretValue(key, digest) {
  if (digest === null) return undefined;
  const entry = secretValueCache.get(key);
  if (!entry || entry.digest !== digest) return undefined;
  if (Date.now() - entry.atMs > SECRET_CACHE_TTL_MS) { secretValueCache.delete(key); return undefined; }
  return entry.value;
}
// THE PERSISTENT VAULT HOST, TRIED FIRST -- NEVER THE ONLY PATH.
//
// src/lib/vault-host-client.js talks to one long-lived
// `powershell.exe -File tools/vault-host.ps1` process instead of spawning a
// fresh one for this call. It returns null, never throws, when that host
// could not be started or stopped answering -- meaning "fall back to the
// per-call spawn below", not "the secret is missing" -- so a host that will
// not start degrades this back to today's behaviour instead of failing reads
// outright. A response IS a real answer from the vault (found, not found, or
// denied) and is classified exactly as the per-call spawn's stderr already
// was, so a caller cannot tell which path served it.
function readSecretFromVaultHost(key, observedDigest) {
  let hostClient;
  try {
    hostClient = require('./vault-host-client');
  } catch {
    // The module itself is missing or broken -- a transport problem, not a
    // vault answer. Fall back exactly as an unresponsive host would.
    return undefined;
  }
  let response;
  try {
    response = hostClient.callVaultHost('get', { key });
  } catch (error) {
    const detail = String((error && error.message) || '');
    if (/key not found/i.test(detail)) {
      rememberSecretValue(key, observedDigest, null);
      throw secretError('SECRET_NOT_CONFIGURED', `Secret '${key}' is not configured.`);
    }
    // the generic prefix stays, the host client's own reason follows it
    // and its code travels with the error (see relayHostedVaultFailure). The
    // reason is the host's error text, never the secret: on a get the value is
    // the response's OUTPUT, which this catch never sees.
    throw relayHostedVaultFailure(`Secret '${key}' could not be read from the local vault.`, error);
  }
  if (response === null) return undefined;
  return rememberSecretValue(key, observedDigest, response.output.trim());
}

function readSecretFromVault(key) {
  assertSecretKey(key);
  // Before the Linux reader and before the cache below, so neither can serve a
  // value the owner has closed. See assertVaultReadAllowed for why this line's
  // position is the whole guarantee.
  assertVaultReadAllowed(key);
  if (process.platform === 'linux') return linuxVault().get(key);
  // Captured before the read below, so a remembered pairing can never bind a
  // superseded value to a current digest.
  const observedDigest = vaultContentDigest();
  const remembered = rememberedSecretValue(key, observedDigest);
  if (remembered !== undefined) {
    if (remembered === null) throw secretError('SECRET_NOT_CONFIGURED', `Secret '${key}' is not configured.`);
    return remembered;
  }
  assertVaultPlatform();
  const hosted = readSecretFromVaultHost(key, observedDigest);
  if (hosted !== undefined) return hosted;
  const script = vaultScript();
  try {
    return rememberSecretValue(key, observedDigest, execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, 'get', key
    ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }).trim());
  } catch (error) {
    if (error && error.code === 'SECRET_NOT_CONFIGURED') throw error;
    const detail = error.stderr ? error.stderr.toString() : '';
    if (/key not found/i.test(detail)) {
      // The vault's own mechanical absence classification: a definite answer.
      rememberSecretValue(key, observedDigest, null);
      throw secretError('SECRET_NOT_CONFIGURED', `Secret '${key}' is not configured.`);
    }
    // Anything else is a failure to LOOK, which is not an answer about the
    // record and is never remembered.
    throw new Error(`Secret '${key}' could not be read from the local vault.`);
  }
}

// ONE VAULT PROCESS FOR SEVERAL SECRETS, OR TODAY'S BEHAVIOUR. NEVER WORSE.
//
// The cost of a vault read is almost entirely powershell.exe startup, not DPAPI
// decryption -- measured 2026-08-18: 648 ms for the audit signing key and
// 515 ms for the protected head anchor, 1,163 ms for the pair. Reading them in
// one process halves that, on every short-lived process, ~110 an hour on a
// full install.
//
// Returns a Map of key -> value for keys that exist, omitting keys the vault
// does not hold, so the caller keeps the same "configured / not configured"
// distinction readSecretFromVault gives. Returns null -- never throws, never a
// partial guess -- if a batch attempt on a supported platform cannot be
// completed, so the caller falls back to individual reads and the worst case is
// exactly the behaviour that shipped before this existed. An unsupported
// platform is refused before an attempt and must not be presented as a
// retryable batch failure.
//
// An access-denied refusal is the one case that is NOT swallowed: a denylisted
// key must surface as a refusal rather than quietly degrade into N individual
// reads that would each be refused anyway.
function readSecretsFromVault(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return null;
  for (const key of keys) assertSecretKey(key);
  // This function does NOT route through readSecretFromVault, so it needs the
  // owner's decision in its own right. Without this line a denied credential
  // stays readable to anything that asks for it in a batch.
  assertVaultReadAllowed(keys);
  if (process.platform === 'linux') return linuxVault().getMany(keys);
  const script = vaultScript();
  let raw;
  try {
    // SCRUB THE CHILD ENVIRONMENT. powershell.exe is a general interpreter, so
    // whatever it runs inherits whatever it is handed -- which is why
    // tools/spawn-env-scrub-allowlist.json states an interpreter is NEVER
    // exempt. Without an `env` option node passes the FULL process.env,
    // provider credentials included, and tools/check-spawn-env-scrub.js
    // flags exactly that (it caught this call site on the first run).
    //
    // safeLaunchEnvironment keeps what the vault script actually needs --
    // PATH, and TOOLSENABLED_VAULT_PATH, which is how a redirected vault is
    // located -- while removing the billing credentials that have no business
    // crossing into a secret read.
    //
    // REQUIRED LAZILY, NOT AT MODULE TOP. launch-environment reaches
    // runtime.js transitively (via cli-provider-gateway), so a top-level
    // require here is a cycle: runtime.js would receive a half-initialised
    // module and safeLaunchEnvironment could be undefined at call time. By the
    // time this function actually runs, the graph is fully loaded.
    const { safeLaunchEnvironment } = require('./supervision/launch-environment.js');
    raw = execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script,
      'get-many', '-Keys', keys.join(',')
    ], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      env: safeLaunchEnvironment(process.env, { context: 'vault:get-many' })
    });
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString() : '';
    if (/ACCESS_DENIED_ORACLE_SCOPE/.test(detail)) {
      throw secretError('SECRET_ACCESS_DENIED', 'That secret is not available through the generic vault read.');
    }
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(String(raw).trim()); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const found = new Map();
  for (const key of keys) {
    const entry = parsed[key];
    // A shape this does not recognise is treated as "batch failed", not as
    // "key absent" -- guessing absence could make a configured secret look
    // unconfigured, which upstream treats as permission to create a new one.
    if (!entry || typeof entry !== 'object') return null;
    if (entry.found === true) {
      if (typeof entry.value !== 'string') return null;
      found.set(key, entry.value.trim());
    } else if (entry.found !== false) {
      return null;
    }
  }
  return found;
}

function getSecret(key) {
  return readSecretFromVault(key);
}

/* WHY THESE VAULT SPAWNS RELAY THE CHILD'S stderr, AND WHY ONLY stderr.

   MEASURED, the 1.0.45 cut of 2026-09-16: a settings batch failed with thirty
   identical AUDIT_UNAVAILABLE entries whose only diagnostic was audit.js's own
   fixed sentence. Fixing audit.js to carry its cause moved the answer exactly
   one frame: it then read "Unable to get or create secret '<key>'." -- this
   file's fixed prose -- because `getOrCreateSecret` spawns the vault script
   with stderr PIPED and then discards it in a bare `catch {`. Run the same
   product with PSModulePath pointing at a PowerShell 7 Modules directory only
   and the child says precisely what is wrong: Windows PowerShell 5.1 cannot
   autoload Microsoft.PowerShell.Security, so ConvertTo-SecureString is not
   there. That sentence was captured, in hand, and thrown away.

   SAFE TO SURFACE, and the boundary is not a matter of taste. tools/secrets.ps1
   never echoes a secret value, and a secret value never crosses as a process
   argument -- every accessor here sends it over stdin, which is why the spawn's
   own error text cannot contain one. stderr is diagnostics.

   STDOUT IS NOT, AND IS NEVER READ HERE. On `get` and `get-or-create` the
   child's stdout IS the key material. `error.stdout` is therefore off limits
   in this helper by construction, not by discipline: it is not referenced.

   The text is clamped, and it is not appended when node has already folded it
   into `message` -- execFileSync does exactly that whenever stderr is piped,
   so an unconditional append prints the whole PowerShell error twice.

   SAME SEAM, TWO HALVES: `vaultSetterFailure`, on a separate branch that is
   not an ancestor of this tree, is this same function for the three setters,
   which are not in these bytes. When the two land together they should be collapsed
   into one function; two spellings of one rule is how a seam starts
   disagreeing with itself. Reading stderr is already established practice in
   this file: the `get-many` path above binds its catch and tests
   `error.stderr` for ACCESS_DENIED_ORACLE_SCOPE. */
const MAX_VAULT_CHILD_REASON = 2000;

function vaultChildFailure(error) {
  // THE SAME RULE AS signingKeyReason IN src/lib/audit.js, and for the same
  // reason: there is no String(error) fallback, because String() is the
  // IDENTITY FUNCTION for a thrown primitive. `throw '<value>'` here would put
  // that value into a refusal message verbatim. execFileSync always throws an
  // Error, so no path in this tree does that today -- but this helper exists to
  // relay a child's diagnostics, and the first caller that hands a raw string
  // or Buffer through would leak content on its first run. Only a string
  // `message` and the child's diagnostic stream are relayed; anything else is
  // described by TYPE.
  //
  // Each property is read EXACTLY ONCE. They can be getters, and a getter that
  // throws must not replace the refusal with a TypeError raised inside the
  // handler.
  let rawMessage;
  let rawDetail;
  try { rawMessage = error === undefined || error === null ? undefined : error.message; }
  catch { rawMessage = undefined; }
  // error.stdout is NOT read, here or anywhere in this function: on a get and a
  // get-or-create the child's stdout IS the key material.
  try { rawDetail = error === undefined || error === null ? undefined : error.stderr; }
  catch { rawDetail = undefined; }
  const base = (typeof rawMessage === 'string' ? rawMessage : '').replace(/\s+/g, ' ').trim();
  let detail = '';
  if (typeof rawDetail === 'string' || Buffer.isBuffer(rawDetail)) {
    detail = String(rawDetail).replace(/\s+/g, ' ').trim().slice(0, MAX_VAULT_CHILD_REASON);
  }
  if (!base && !detail) {
    return `the vault helper failed without a readable reason (${error === null ? 'null' : typeof error} thrown)`;
  }
  if (!base) return detail;
  if (!detail || base.includes(detail)) return base;
  return `${base}: ${detail}`;
}

// THE HOSTED PATHS RELAY THE CHILD'S REASON TOO, AND CARRY ITS CODE.
//
// The two hosted catch blocks (readSecretFromVaultHost and
// setMonotonicSecretViaHost) used to throw the bare generic sentence, discarding
// both the host client's message and its `code`. A caller therefore could not
// tell "the sequence moved backward" (a custody defect) from "Timed out waiting
// for exclusive access to the secret vault" (a lock wait) from
// SECRET_VAULT_HOST_UNCERTAIN (a lost reply that was deliberately not repeated)
// -- and a test that retried on the generic sentence retried on all three,
// which is how an intermittent anchor regression was measured going green.
//
// Same relay rule as the per-call spawn path, through vaultChildFailure: only a
// string message and a diagnostic stream are relayed, anything else is described
// by type, and stdout is never read. The code is copied only when it is a
// non-empty string, so a hosted failure keeps the same `code` contract
// src/lib/vault-host-client.js already publishes for its own throws.
function relayHostedVaultFailure(prefix, error) {
  const relayed = new Error(`${prefix} ${vaultChildFailure(error)}`);
  let code;
  try { code = error === undefined || error === null ? undefined : error.code; }
  catch { code = undefined; }
  if (typeof code === 'string' && code) relayed.code = code;
  return relayed;
}

function listSecretKeys() {
  assertVaultPlatform();
  if (process.platform === 'linux') return linuxVault().list();
  const script = rootPath('tools', 'secrets.ps1');
  // A missing helper says nothing about how many keys the vault contains.
  // Returning an empty list here used to turn an installation failure into a
  // confident "no configured secrets" answer, allowing every check over the
  // result to pass vacuously. Keep absence distinct by refusing the listing.
  if (!fs.existsSync(script)) {
    throw new Error('Secret keys could not be listed because the local vault helper is not installed.');
  }
  try {
    return execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, 'list'
    ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
      .split(/\r?\n/)
      .map(key => key.trim())
      .filter(key => /^[A-Za-z0-9_.-]+$/.test(key));
  } catch (error) {
    throw new Error(`Secret keys could not be listed from the local vault. ${vaultChildFailure(error)}`);
  }
}

/* WHY THE VAULT SETTERS CAPTURE stderr, AND WHY IT IS SAFE TO SURFACE.

   Until 2026-09-16 the three setters below ran powershell with
   `stdio: ['pipe', 'ignore', 'ignore']`, so the script's own message was
   discarded and every failure reached the caller as execFileSync's generic
   "Command failed: powershell.exe ...". The 1.0.45 cut of that date turned 15
   native-custody cases red and not one of them could say why -- the cause was
   in hand, one frame from the surface, and thrown away. `getOrCreateSecret`
   already captured it; these did not, which is the whole of the difference.

   SAFE TO SURFACE: tools/secrets.ps1 never echoes a secret value. Its stdin
   decoder deliberately refuses to relay input bytes ("Secret stdin must be
   valid UTF-8" rather than the bytes), and 'set-stdin' states the value is
   "never touched, measured, hashed or described". The text is still clamped:
   an error message that grows without bound is its own defect, and a clamp is
   cheaper than trusting every future line of that script.

   The environment is scrubbed for the same reason `getOrCreateSecret` scrubs
   it -- powershell.exe is a general interpreter, so without an `env` option
   node hands the child the FULL process.env, provider credentials included,
   which is exactly what tools/check-spawn-env-scrub.js classifies as
   INHERITS_AMBIENT. */
function vaultSetterFailure(error) {
  // A thrown value is not a diagnostic. Read each field once, contain accessors,
  // and never let arbitrary coercion replace the setter's original refusal.
  let message;
  let stderr;
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    try {
      const value = error.message;
      if (typeof value === 'string') message = value;
    } catch { /* The helper's reason could not be read. */ }
    try {
      const value = error.stderr;
      if (typeof value === 'string') stderr = value;
      else if (Buffer.isBuffer(value)) {
        // Decode the byte view without calling a supplied toString/valueOf hook.
        stderr = new (require('node:util').TextDecoder)('utf-8').decode(value);
      }
    } catch { /* An unreadable diagnostic must not escape this error boundary. */ }
  }
  if (!message && !stderr) {
    return `the vault helper failed without a readable reason (${error === null ? 'null' : typeof error} thrown)`;
  }
  // Share the reader's bounded diagnostic formatting and duplicate suppression.
  // The snapshot contains only strings; the thrown object's stdout is never read.
  return vaultChildFailure({ message, stderr });
}

function setSecret(key, value) {
  invalidateSecretValueCache();
  assertSecretKey(key);
  if (typeof value !== 'string' || !value) throw new Error('Secret value must be a non-empty string.');
  assertVaultPlatform();
  if (process.platform === 'linux') return linuxVault().setMany([{ key, value }]);
  const script = rootPath('tools', 'secrets.ps1');
  try {
    // Secret values travel over stdin, never process arguments where another
    // local process could read them from the command line.
    execFileSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, 'set-stdin', key], {
      cwd: ROOT, input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      env: safeChildEnvironment('vault:set-stdin')
    });
  } catch (error) {
    throw new Error(`Unable to store refreshed secret '${key}': ${vaultSetterFailure(error)}`);
  }
}

// Store two related credentials in a single DPAPI-vault generation.  The
// payload is supplied only on stdin, so neither secret is visible in argv,
// stdout, errors, or audit data.  `Write-Vault` replaces the encrypted vault
// atomically while holding its cross-process lock.
function setSecretPair(firstKey, firstValue, secondKey, secondValue) {
  invalidateSecretValueCache();
  assertSecretKey(firstKey); assertSecretKey(secondKey);
  if (firstKey === secondKey) throw new Error('Secret pair keys must be distinct.');
  if (typeof firstValue !== 'string' || !firstValue || typeof secondValue !== 'string' || !secondValue) {
    throw new Error('Secret pair values must be non-empty strings.');
  }
  assertVaultPlatform();
  if (process.platform === 'linux') return linuxVault().setMany([
    { key: firstKey, value: firstValue }, { key: secondKey, value: secondValue }
  ]);
  const payload = JSON.stringify({
    first: { key: firstKey, value: firstValue },
    second: { key: secondKey, value: secondValue }
  });
  const script = rootPath('tools', 'secrets.ps1');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, 'set-pair-stdin'], {
      cwd: ROOT, input: payload, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      env: safeChildEnvironment('vault:set-pair-stdin')
    });
  } catch (error) {
    throw new Error(`Unable to store refreshed credential pair: ${vaultSetterFailure(error)}`);
  }
}

// Store three coupled credentials in one DPAPI-vault generation. This is used
// when one OAuth client ID, client secret, and provider identity must never be
// observed in a partially refreshed state.
function setSecretTriple(firstKey, firstValue, secondKey, secondValue, thirdKey, thirdValue) {
  invalidateSecretValueCache();
  assertSecretKey(firstKey); assertSecretKey(secondKey); assertSecretKey(thirdKey);
  if (new Set([firstKey, secondKey, thirdKey]).size !== 3) throw new Error('Secret triple keys must be distinct.');
  if ([firstValue, secondValue, thirdValue].some(value => typeof value !== 'string' || !value)) {
    throw new Error('Secret triple values must be non-empty strings.');
  }
  assertVaultPlatform();
  if (process.platform === 'linux') return linuxVault().setMany([
    { key: firstKey, value: firstValue }, { key: secondKey, value: secondValue }, { key: thirdKey, value: thirdValue }
  ]);
  const payload = JSON.stringify({
    first: { key: firstKey, value: firstValue },
    second: { key: secondKey, value: secondValue },
    third: { key: thirdKey, value: thirdValue }
  });
  const script = rootPath('tools', 'secrets.ps1');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, 'set-triple-stdin'], {
      cwd: ROOT, input: payload, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      env: safeChildEnvironment('vault:set-triple-stdin')
    });
  } catch (error) {
    throw new Error(`Unable to store refreshed credential triple: ${vaultSetterFailure(error)}`);
  }
}

function getOrCreateSecret(key, candidate) {
  invalidateSecretValueCache();
  assertSecretKey(key);
  // This RETURNS the record's value when one already exists, so it is a read
  // for the owner's purposes whatever its name says, and it too bypasses
  // readSecretFromVault.
  assertVaultReadAllowed(key);
  if (typeof candidate !== 'string' || !candidate) throw new Error('Secret candidate must be a non-empty string.');
  assertVaultPlatform();
  if (process.platform === 'linux') return linuxVault().getOrCreate(key, candidate);
  const script = rootPath('tools', 'secrets.ps1');
  try {
    // The candidate is never a process argument. The vault's cross-process lock
    // chooses exactly one candidate when multiple agents initialize concurrently.
    return execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, 'get-or-create-stdin', key
    ], {
      cwd: ROOT, input: candidate, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      env: safeChildEnvironment('vault get-or-create')
    }).trim();
  } catch (error) {
    throw new Error(`Unable to get or create secret '${key}'. ${vaultChildFailure(error)}`);
  }
}

// Tried first, same posture as readSecretFromVaultHost above: null means
// "the host is unavailable, fall back to the per-call spawn", and a thrown
// error is a real vault-level refusal or failure. It carries the same generic
// prefix the per-call spawn's catch block throws, FOLLOWED BY THE HOST'S OWN
// REASON and, when the host client attached one, its `code` (via
// relayHostedVaultFailure). The prefix alone still does not distinguish
// "sequence moved backward" from "lock timed out" -- that is exactly why the
// reason is relayed rather than collapsed: a caller that must tell a custody
// defect from a timing wait reads the relayed reason and the code, never the
// prefix. Only the non-secret sequence and key are ever request fields
// alongside the value; the value itself still never crosses as a process
// argument -- here it is base64 inside the JSON request line, sent over the
// host's stdin -- and it is not part of any relayed reason.
function setMonotonicSecretViaHost(key, value, sequence) {
  let hostClient;
  try {
    hostClient = require('./vault-host-client');
  } catch {
    // The module itself is missing or broken -- a transport problem, not a
    // vault answer. Fall back exactly as an unresponsive host would.
    return undefined;
  }
  let response;
  try {
    response = hostClient.callVaultHost('set-monotonic-stdin', {
      key, sequence, valueBase64: Buffer.from(value, 'utf8').toString('base64')
    });
  } catch (error) {
    throw relayHostedVaultFailure(`Unable to advance monotonic secret '${key}' to sequence ${sequence}.`, error);
  }
  if (response === null) return undefined;
  const reported = /(?:^|\r?\n)vault-sha256=([a-f0-9]{64})(?:\r?\n|$)/.exec(response.output || '');
  return reported ? reported[1] : null;
}

function setMonotonicSecret(key, value, sequence) {
  invalidateSecretValueCache();
  assertSecretKey(key);
  if (typeof value !== 'string' || !value) throw new Error('Secret value must be a non-empty string.');
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('Monotonic secret sequence must be a non-negative safe integer.');
  }
  assertVaultPlatform();
  if (process.platform === 'linux') return linuxVault().setMonotonic(key, value, sequence);
  const hosted = setMonotonicSecretViaHost(key, value, sequence);
  if (hosted !== undefined) return hosted;
  const script = rootPath('tools', 'secrets.ps1');
  let stdout;
  try {
    // Only the non-secret sequence and key are arguments; the signed anchor
    // value itself crosses the process boundary over stdin.
    stdout = execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script,
      'set-monotonic-stdin', key, '-Sequence', String(sequence)
    ], {
      cwd: ROOT, input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      env: safeChildEnvironment('vault monotonic write')
    });
  } catch (error) {
    throw new Error(`Unable to advance monotonic secret '${key}' to sequence ${sequence}. ${vaultChildFailure(error)}`);
  }
  // The helper reports the vault's content digest from inside its lock (see
  // tools/secrets.ps1 Write-VaultContentDigest). Absent or malformed means
  // "unknown", which callers must treat exactly as they did before this line
  // existed: null, read for real next time. Never a secret value.
  const reported = /(?:^|\r?\n)vault-sha256=([a-f0-9]{64})(?:\r?\n|$)/.exec(String(stdout || ''));
  return reported ? reported[1] : null;
}

// PRESENCE, WITH THE THIRD ANSWER KEPT -- and the misdiagnosis it removes.
//
// The old body answered by FETCHING the value (readSecretFromVault -> the vault
// `get` action) and returning Boolean of it under `catch { return false }`. That
// collapsed three different facts into one `false`:
//   1. the record is genuinely not on file            -> false is correct
//   2. the vault could not be read at all              -> false is a LIE
//   3. the record is on the oracle denylist, so `get`  -> false is a LIE
//      refuses it (owner_legal_identity_v1, payment_card_default)
// Case 2 is the Google-auth incident in miniature: an unreadable vault reported
// as "not configured" is indistinguishable from a revoked credential, and sent
// a whole investigation after dead tokens that were never dead. Case 3 made the
// owner-identity staged-check read "absent" while the record sat in the vault.
//
// This now asks the `present` action through vault-presence: it reads no value,
// decrypts nothing, is not subject to the denylist, and separates ABSENT from
// UNREADABLE. A genuinely-absent record -- or a machine with no vault store yet
// -- is a definite `false`. An UNREADABLE vault THROWS a typed error instead of
// masquerading as "not configured", so a permissions error or a half-written
// file can never again be read as an authorization fact. An UNSUPPORTED
// platform throws its own non-retryable refusal and remains unknown about
// record presence. Presence must never open a prompt as a side effect, and this
// path never can: nothing below calls getSecret or the credential prompt.
//
// vault-presence is required lazily so the two modules' mutual dependency
// (vault-presence needs rootPath from here) resolves at call time, by which
// point both are fully loaded.
function secretExists(key) {
  const answer = require('./vault-presence').vaultRecordPresence(key);
  if (answer.code === VAULT_PLATFORM_UNSUPPORTED) throw vaultPlatformRefusal();
  if (answer.readable === false) {
    throw secretError(
      'SECRET_VAULT_UNREADABLE',
      'The local secret vault exists but could not be read, so whether this secret is configured is unknown. This is not the same as it being absent.'
    );
  }
  return answer.present === true;
}

module.exports = {
  VAULT_PRINCIPAL_ENV, currentVaultPrincipals, inheritedVaultPrincipals, vaultPrincipalEnvironment,
  ROOT, rootPath, ensureDir, readJson, writeJsonAtomic, commandPath, commandExists, resetCommandPathCache,
  getSecret, readSecretsFromVault, listSecretKeys, setSecret, setSecretPair, setSecretTriple, getOrCreateSecret, setMonotonicSecret, secretExists,
  withVaultPrincipal, assertVaultReadAllowed,
  vaultFilePath, vaultFingerprint, vaultContentDigest,
  // Exported for tests only: the rules that decide when a decrypted value may
  // be served without asking the vault again. Testing them here means the
  // security-relevant half is asserted without spawning a process.
  invalidateSecretValueCache, rememberSecretValue, rememberedSecretValue, SECRET_CACHE_TTL_MS
};
