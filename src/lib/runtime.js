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
const { credentialDefinitionForKey } = require('./credential-metadata');
const { programOrStatePath, statePath } = require('./runtime-state-root');

const ROOT = path.resolve(__dirname, '..', '..');
const SECRET_KEY_RE = /^[A-Za-z0-9_.-]+$/;
const PROMPT_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/;
const credentialPromptContext = new AsyncLocalStorage();

/* WHO IS ASKING FOR A SECRET, CARRIED THE ONLY WAY IT CAN BE.
 *
 * Every vault read in this file is reached through provider code that takes no
 * principal and must not learn one -- `d.getSecret(key)` is called from dozens
 * of providers, and threading an identity through each would mean every future
 * provider is one forgotten argument away from an unenforced read. So the
 * identity travels out of band, the same way credentialPromptContext above
 * already carries the owner-prompt attribution: src/lib/tool-registry.js sets
 * it once around the handler call, and the read sites below take it from here.
 *
 * DEFAULT EMPTY MEANS UNRULED, NOT UNRESTRICTED-BY-ACCIDENT. A read with no
 * store is the installation reading its own credentials (startup, audit
 * signing, sign-in), which the owner's per-agent switches are not about. That
 * is the same rule the desktop app's shell/vault-presence.cjs applies to its
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

// WHERE A CUSTOMER'S IDE IMPORT CHOICE LIVES. The ide.consent_* tools and the
// attribution projection used to hand ide-session-consent a bare rootPath(),
// which is the PROGRAM root: with zero parts the state-directory redirect above
// is never consulted, so config/ide-session-consent.json landed inside the
// install directory on a per-machine install (measured 2026-09-02 -- a QA
// sweep left it in a sealed release tree). 'state' is a redirected directory,
// so this resolves under the per-user state root when installed and under the
// checkout when running from source, exactly like every other mutable record.
// The consent module composes config/ide-session-consent.json beneath it; the
// tools adopt a legacy program-root file once (see
// ide-session-consent-writer.adoptLegacyConsent) so an existing choice never
// reads as "first run".
function consentRoot() {
  const root = rootPath('state');
  try {
    require('./ide-session-consent-writer').adoptLegacyConsent({ legacyRoot: ROOT, root });
  } catch {
    // Adoption is best-effort: a lock held by a concurrent writer, or an
    // unreadable legacy file, must not stop the tool from answering. The read
    // side reports its own state honestly either way.
  }
  return root;
}

function safeChildEnvironment(context) {
  // Lazy because subscription-launch-env reaches this module through the
  // provider gateway during startup. At call time that graph is initialized.
  // Every caller of this function spawns powershell.exe (the vault helper,
  // tools/secrets.ps1) -- SEC11: naming that child here also drops the
  // PowerShell 7 entries a PowerShell-7-launched parent would otherwise leak
  // into that 5.1 child. See supervision/launch-environment.js.
  return require('./providers/subscription-launch-env.js')
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

// npm's Windows Firebase launcher is a batch file. Even when a parent asks
// Node to hide the child, the cmd.exe hop can briefly allocate a conhost on
// some desktop builds. Firebase's CLI entry point is a normal Node script,
// so prefer that direct invocation whenever the fixed per-user installation
// is present. This preserves the public command name/arguments while removing
// the avoidable cmd.exe console hop.
function directFirebaseInvocation(executable, args = []) {
  if (process.platform !== 'win32' || !/firebase\.cmd$/i.test(String(executable || ''))) {
    return { executable, args, direct: false };
  }
  const entry = path.join(path.dirname(executable), 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
  if (!fs.existsSync(entry)) return { executable, args, direct: false };
  return { executable: process.execPath, args: [entry, ...args], direct: true };
}

// Google Cloud SDK ships both a gcloud.cmd shim and a normal Python entry
// point. The shim crosses cmd.exe and can briefly allocate a console host for
// every bounded account/status probe. Prefer the bundled Python entry point
// for non-interactive broker work; the explicit environment mirrors the SDK's
// own launcher without changing the selected account or credentials.
function directGcloudInvocation(executable, args = []) {
  if (process.platform !== 'win32' || !/gcloud(?:\.cmd)?$/i.test(path.basename(String(executable || '')))) {
    return { executable, args, direct: false };
  }
  const binDirectory = path.dirname(String(executable));
  const sdkRoot = path.resolve(binDirectory, '..');
  const entry = path.join(sdkRoot, 'lib', 'gcloud.py');
  const bundledPython = path.join(sdkRoot, 'platform', 'bundledpython', 'python.exe');
  if (!fs.existsSync(entry) || !fs.existsSync(bundledPython)) return { executable, args, direct: false };
  return {
    executable: bundledPython,
    args: ['-S', entry, ...args],
    direct: true,
    env: {
      CLOUDSDK_ROOT_DIR: sdkRoot,
      CLOUDSDK_PYTHON: bundledPython,
      CLOUDSDK_PYTHON_ARGS: '-S',
      CLOUDSDK_GSUTIL_PYTHON: bundledPython
    }
  };
}

// WHAT MAY BE REMEMBERED ABOUT A COMMAND LOOKUP, AND WHAT MAY NOT.
//
// Every commandExists() spawns where.exe, and for terraform/firebase it then
// RUNS the resolved binary with a 5,000 ms timeout. system.doctor asks about
// gcloud, terraform, firebase, node and npx across several provider modules on
// every call; measured on the owner's install, that was 6.6 s of process
// spawning per four doctor calls, and system.status pays one on every poll.
//
// Three rules, and the first two are contracts other code already depends on:
//
//   * A MISS IS NEVER REMEMBERED. tests/runtime-command-lookup.test.js pins
//     this deliberately: a command that was absent and has since been
//     installed must be seen on the very next call, because a diagnostic that
//     latches "not installed" is worse than a slow one. Misses re-probe,
//     always.
//   * AN UNKNOWN IS NEVER REMEMBERED. COMMAND_LOOKUP_UNKNOWN means the lookup
//     could not be completed, which is not an answer about the command. It
//     propagates and caches nothing -- the same rule vaultContentDigest()
//     follows for a digest it could not compute.
//   * A HIT IS REMEMBERED ONLY BRIEFLY. An uninstalled command reported as
//     present is a false positive, which is the worse direction for a doctor,
//     so the memory is bounded rather than permanent. The window only has to
//     cover one doctor run and a burst of status polls.
//
// The whole table is dropped if any environment value the resolution reads
// changes, so a PATH change is never served a stale answer.
const COMMAND_PATH_HIT_TTL_MS = 60_000;
const commandPathHits = new Map();
let commandPathEnvKey = null;

function commandPathEnvironment() {
  return [
    process.env.PATH || '', process.env.PATHEXT || '', process.env.LOCALAPPDATA || '',
    process.env.APPDATA || '', process.env.ProgramFiles || ''
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
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  const found = spawnSync(probe, [command], { encoding: 'utf8', windowsHide: true, shell: false });
  if (found.error || found.status === null) {
    const causeCode = found.error && found.error.code
      ? found.error.code
      : (found.signal ? `SIGNAL_${found.signal}` : 'NO_ANSWER');
    const error = new Error(
      `Command lookup for '${command}' could not be completed (${causeCode}), so whether it is installed is unknown; this is not a claim that it is absent.`
    );
    error.code = 'COMMAND_LOOKUP_UNKNOWN';
    error.causeCode = causeCode;
    throw error;
  }
  if (found.status === 0) {
    const candidate = String(found.stdout || '').split(/\r?\n/).find(Boolean) || command;
    if (process.platform === 'win32' && !path.extname(candidate) && fs.existsSync(`${candidate}.cmd`)) return `${candidate}.cmd`;
    return candidate;
  }
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  let terraformCandidates = [];
  // Only Terraform uses this directory. Every other missing command used to
  // synchronously enumerate all WinGet packages before returning its result.
  if (String(command).toLowerCase() === 'terraform') {
    try {
      terraformCandidates = fs.readdirSync(path.join(local, 'Microsoft', 'WinGet', 'Packages'), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith('Hashicorp.Terraform_'))
        .map(entry => path.join(local, 'Microsoft', 'WinGet', 'Packages', entry.name, 'terraform.exe'));
    } catch { /* Winget package directory is optional. */ }
  }
  const known = {
    terraform: [
      ...terraformCandidates
    ],
    gcloud: [
      path.join(local, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
      path.join(process.env.ProgramFiles || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd')
    ],
    // npm's per-user Windows global prefix is often absent from the broker's
    // PATH even though the installed CLI is callable by the signed-in owner.
    // Resolve the fixed launcher without invoking a shell or treating an
    // inaccessible owner config as proof of readiness.
    firebase: [
      path.join(roaming, 'npm', 'firebase.cmd'),
      path.join(local, 'npm', 'firebase.cmd')
    ]
  };
  const candidates = (known[String(command).toLowerCase()] || []).filter(candidate => candidate && fs.existsSync(candidate));
  const candidate = candidates[0] || null;
  if (!candidate) return null;
  // A few Windows package managers leave a protected executable visible to
  // `where`/filesystem probes even though the current desktop token cannot
  // execute it (EPERM/Access Denied).  Treat that as unavailable instead of
  // advertising a false-positive capability and failing later in a provider.
  // The probe is limited to fixed local Terraform/Firebase version checks and
  // has no network or state-changing arguments.
  if (['terraform', 'firebase'].includes(String(command).toLowerCase())) {
    try {
      const probeArgs = String(command).toLowerCase() === 'firebase' ? ['--version'] : ['version'];
      const invocation = directFirebaseInvocation(candidate, probeArgs);
      const probe = spawnSync(invocation.executable, invocation.args, { stdio: 'ignore', timeout: 5000, windowsHide: true, shell: false });
      if (probe.error || probe.status !== 0) return null;
    } catch {
      return null;
    }
  }
  return candidate;
}

function commandExists(command) {
  return Boolean(commandPath(command));
}

function findBrowser() {
  if (process.platform !== 'win32') return commandExists('google-chrome') || commandExists('chromium') || commandExists('microsoft-edge');
  const paths = [
    path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  return paths.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

// Windows cannot execute .cmd/.bat files directly: they must be parsed by
// cmd.exe. That parser expands percent/exclamation variables and recognizes
// command separators even though Node received the values as separate argv
// entries. Reject those constructs before cmd.exe sees provider- or
// model-supplied values. `(default)` is the one intentional parenthesized
// argument used by Firebase's Firestore CLI.
const SAFE_BATCH_LITERALS = new Set(['(default)']);
const UNSAFE_BATCH_ARGUMENT = /[\x00\r\n"&|<>^()%!]/;

function safeBatchArguments(args) {
  if (!Array.isArray(args)) throw new TypeError('Command arguments must be an array.');
  return args.map((argument, index) => {
    const value = String(argument);
    if (!SAFE_BATCH_LITERALS.has(value) && UNSAFE_BATCH_ARGUMENT.test(value)) {
      throw new Error(`Unsafe Windows batch argument at index ${index}; command metacharacters, expansion markers, quotes, and newlines are not allowed.`);
    }
    return value;
  });
}

function run(command, args, options = {}) {
  const reportedExecutable = commandPath(command) || command;
  const firebase = directFirebaseInvocation(reportedExecutable, args);
  const gcloud = directGcloudInvocation(firebase.executable, firebase.args);
  const direct = gcloud.direct ? gcloud : firebase;
  const executable = direct.executable;
  const batch = !direct.direct && process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
  const launched = batch ? (process.env.ComSpec || 'cmd.exe') : executable;
  const normalizedArgs = batch ? safeBatchArguments(args) : (direct.direct ? direct.args : args);
  // `call` lets cmd.exe execute an absolute .cmd path containing spaces. Batch
  // arguments have already passed the conservative parser-boundary check above.
  const launchedArgs = batch ? ['/d', '/v:off', '/s', '/c', 'call', executable, ...normalizedArgs] : normalizedArgs;
  const hideWindow = options.windowsHide !== false;
  const powerShell = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(String(launched));
  const effectiveArgs = hideWindow && powerShell
    && !launchedArgs.some(value => /^-windowstyle$/i.test(String(value)))
    ? ['-WindowStyle', 'Hidden', ...launchedArgs]
    : launchedArgs;
  const result = spawnSync(launched, effectiveArgs, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    timeout: options.timeout || 10 * 60 * 1000,
    env: { ...process.env, ...(firebase.env || {}), ...(direct.env || {}), ...(options.env || {}) },
    // Every broker helper is piped and non-interactive.  On Windows, the
    // default console allocation can still flash a terminal for each short
    // PowerShell/cmd helper invocation; suppress it at this common boundary.
    // Owner-facing WinForms dialogs use their own visible form, not a console.
    windowsHide: hideWindow,
    shell: false
  });
  if (result.error) {
    // A CUT-OFF CHILD IS NOT A NAMELESS ETIMEDOUT (R1534). One of the things
    // that stops a Windows child answering is an administrator approval box
    // raised where nobody can see it -- a 15-minute lockup that surfaces as
    // `spawnSync ETIMEDOUT` and names neither the command nor the cause. The
    // thrown error keeps its own code so existing handlers still work, and
    // carries the two facts a caller needs to say something honest.
    result.error.command = [reportedExecutable, ...args].join(' ');
    result.error.timedOut = result.error.code === 'ETIMEDOUT';
    throw result.error;
  }
  return {
    command: [reportedExecutable, ...args].join(' '),
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    // `signal` is how spawnSync reports a timeout that killed the child rather
    // than erroring. Without it a caller cannot tell "the tests failed" from
    // "the tests never finished", and this codebase reported both as failure.
    timedOut: result.signal === 'SIGTERM' && result.status === null
  };
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
function assertVaultReadAllowed(keys) {
  const principals = vaultPrincipalContext.getStore();
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
  const resolvedVault = rootPath('vault', 'secrets.json');
  if (path.resolve(resolvedVault) === path.join(ROOT, 'vault', 'secrets.json')) return;
  process.env.TOOLSENABLED_VAULT_PATH = resolvedVault;
}());

// TELLING EVERY OTHER HELPER PROGRAM THE SAME THING, ONCE.
//
// The publisher above solves exactly one file's version of this problem. The
// rest of the helper programs have it too: tools/desktop.ps1 resolves captures/,
// tools/browser.ps1 resolves profiles/, tools/owner-prompt-queue.ps1 resolves
// state/ -- each from its OWN location, which packaged is the install directory.
// Node had already redirected those directories, so the two halves named
// different places: measured, the capture helper created captures/ under the
// program and then rejected the per-user path Node passed it, so screen capture
// wrote where it must not AND failed. A per-helper environment variable each
// would be four seams to remember; the state root is the one fact they all need.
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
  const resolvedState = rootPath('state');
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
// the owner's machine as a standing, unexplained CPU cost.
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
// Every read below spawns a full powershell.exe. Measured on the owner's
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
    // T329: the generic prefix stays, the host client's own reason follows it
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
  if (process.platform === 'linux') return require('./vault-linux').get(key);
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
  if (process.platform === 'linux') return require('./vault-linux').getMany(keys);
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
    // REQUIRED LAZILY, NOT AT MODULE TOP. subscription-launch-env reaches
    // runtime.js transitively (via cli-provider-gateway), so a top-level
    // require here is a cycle: runtime.js would receive a half-initialised
    // module and safeLaunchEnvironment could be undefined at call time. By the
    // time this function actually runs, the graph is fully loaded.
    const { safeLaunchEnvironment } = require('./providers/subscription-launch-env.js');
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

function credentialPromptError(code, message) {
  return secretError(code, message);
}

function parseCredentialPromptResult(value, key) {
  let result;
  try {
    result = JSON.parse(String(value || '').trim());
  } catch {
    throw credentialPromptError('CREDENTIAL_CAPTURE_FAILED', 'The local credential prompt returned an invalid result.');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw credentialPromptError('CREDENTIAL_CAPTURE_FAILED', 'The local credential prompt returned an invalid result.');
  }
  if (result.status === 'cancelled') {
    throw credentialPromptError('CREDENTIAL_CAPTURE_CANCELLED', 'Credential entry was cancelled; the local vault was not changed.');
  }
  if (result.status === 'in_progress') {
    if (result.key !== key) {
      throw credentialPromptError('CREDENTIAL_CAPTURE_FAILED', 'The local credential prompt returned an invalid result.');
    }
    throw credentialPromptError(
      'CREDENTIAL_CAPTURE_IN_PROGRESS',
      'Another local credential prompt is already open. Complete it, then retry this operation.'
    );
  }
  if (result.key !== key || !['created', 'updated'].includes(result.status)) {
    throw credentialPromptError('CREDENTIAL_CAPTURE_FAILED', 'The local credential prompt returned an invalid result.');
  }
  return { key, status: result.status };
}

// This invokes a trusted local script with no credential value in argv, stdin,
// stdout, audit data, or the MCP result.  Only a static provider label and the
// safe vault-key name reach the Windows Forms dialog.
function captureCredential(key, suppliedDefinition) {
  assertSecretKey(key);
  const definition = suppliedDefinition || credentialDefinitionForKey(key);
  if (!definition || definition.key !== key || typeof definition.label !== 'string' || !PROMPT_LABEL_RE.test(definition.label)) {
    throw credentialPromptError('CREDENTIAL_CAPTURE_UNSUPPORTED', 'This credential cannot be captured through the local prompt.');
  }
  const script = vaultScript();
  let output;
  try {
    output = execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script,
      'prompt-set', key, '-PromptLabel', definition.label
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (error) {
    const detail = [error && error.stderr, error && error.stdout, error && error.message]
      .filter(value => value !== undefined && value !== null)
      .map(value => String(value))
      .join('\n');
    if (/CREDENTIAL_INTERACTION_REQUIRED/i.test(detail)) {
      throw credentialPromptError('CREDENTIAL_INTERACTION_REQUIRED', 'A local interactive Windows desktop is required to enter this credential.');
    }
    throw credentialPromptError('CREDENTIAL_CAPTURE_FAILED', 'The local credential prompt could not save the credential.');
  }
  return parseCredentialPromptResult(output, key);
}

// Payment-card values use a separate multi-field local dialog so a card number,
// expiration, billing postal code, and cardholder name are never placed in
// argv, stdin, an MCP result, audit data, or a generic one-line credential box.
// The structured record is encrypted as one DPAPI vault value and can be read
// only by a future provider-specific, owner-authorized checkout bridge.
//
// THE CARD SECURITY CODE (CVC / CVV) IS NEVER STORED. NOT HERE, NOT BY THE
// DIALOG, NOT BY ANYONE, ANYWHERE.
//
// The record written by tools/secrets.ps1 (its version 3 shape) holds the
// cardholder, the PAN, the expiry month and year, and the postal code -- and
// nothing else. The dialog has no security-code field and does not ask for
// one; there is no vault key, file, log, audit entry, MCP result or report in
// this product that may hold the code. This is owner ruling Q-O4 (2026-08-14)
// and legal's X3 launch gate (2026-08-18), and it is what PCI DSS Requirement
// 3.2 demands: sensitive authentication data, of which the security code is
// one, may not be retained after authorisation, encrypted or otherwise. Both
// launch documents state "the security code is never stored"; the code has to
// make that sentence true, so it is enforced, not described --
// tests/secrets/payment-card-security-code-never-stored.js fails the build if
// the vault script gains a security-code key in any persisted payload, if any
// argument reaching its Protect-PlainText can be traced to one, or if either
// capture form grows a field that asks for one.
//
// TO A FUTURE AUTHOR OF A SPEND PATH: a checkout that needs the code asks the
// owner for it LIVE, at the moment of spend, in a local owner-facing prompt;
// passes it straight to the provider for that one authorisation; and discards
// it. Do not add it to this record. Do not cache it "for the retry". Do not
// write it to any state store, however briefly. If a design appears to need it
// persisted, the design is wrong, not this comment.
//
// Records captured before this invariant (versions 1 and 2) may still carry
// the field; scrubPaymentCardSecurityCode() below removes it in place, and the
// next successful capture replaces the whole record with a version 3 one.
function capturePaymentCard(key = 'payment_card_default') {
  assertSecretKey(key);
  if (key !== 'payment_card_default') {
    throw credentialPromptError('PAYMENT_METHOD_CAPTURE_UNSUPPORTED', 'This payment method cannot be captured through the local card prompt.');
  }
  if (process.platform === 'linux') {
    const result = require('./vault-linux').capturePaymentCard();
    if (result.status === 'timeout') throw credentialPromptError('CREDENTIAL_INTERACTION_REQUIRED', 'The local payment-method prompt timed out without saving.');
    return parseCredentialPromptResult(JSON.stringify(result), key);
  }
  const script = vaultScript();
  let output;
  try {
    output = execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script,
      'prompt-payment-card', key, '-PromptLabel', 'default payment card'
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (error) {
    const detail = [error && error.stderr, error && error.stdout, error && error.message]
      .filter(value => value !== undefined && value !== null)
      .map(value => String(value))
      .join('\n');
    if (/CREDENTIAL_INTERACTION_REQUIRED/i.test(detail)) {
      throw credentialPromptError('CREDENTIAL_INTERACTION_REQUIRED', 'A local interactive Windows desktop is required to enter a payment method.');
    }
    throw credentialPromptError('PAYMENT_METHOD_CAPTURE_FAILED', 'The local payment-method prompt could not save the payment card.');
  }
  return parseCredentialPromptResult(output, key);
}

// Remove the security code from a card record captured before the invariant
// above existed. Runs tools/secrets.ps1's 'scrub-payment-card-cvc' verb hidden
// and unattended (no window, no stdin, nothing from inside the record ever
// crosses this boundary) and answers with exactly one of
//   { key: 'payment_card_default', status: 'scrubbed' | 'clean' | 'absent' }.
// This is the key-bound seam the owner-session host calls before accepting
// work. It runs against the real vault during startup so records captured by
// the earlier dialogs are actually repaired, rather than leaving the hygiene
// operation as an uncalled helper.
const PAYMENT_CARD_SCRUB_STATUSES = Object.freeze(['scrubbed', 'clean', 'absent']);
function scrubPaymentCardSecurityCode() {
  const key = 'payment_card_default';
  // Linux checks canonical native version3 records inside its private vault
  // helper. Absent/clean metadata returns here; malformed, tampered or old
  // records require local review. No card content enters this process.
  if (process.platform === 'linux') return require('./vault-linux').checkPaymentCardHygiene();
  const script = vaultScript();
  let output;
  try {
    output = execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script,
      'scrub-payment-card-cvc'
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });
  } catch {
    // The reason is deliberately not carried out: a vault diagnostic can quote
    // the file it failed on. The caller learns only that the scrub did not run.
    throw secretError('PAYMENT_CARD_SCRUB_FAILED', 'The local vault could not be scrubbed of a card security code.');
  }
  let result;
  try {
    result = JSON.parse(String(output || '').trim());
  } catch {
    throw secretError('PAYMENT_CARD_SCRUB_FAILED', 'The local vault scrub returned an invalid result.');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.key !== key
      || !PAYMENT_CARD_SCRUB_STATUSES.includes(result.status)) {
    throw secretError('PAYMENT_CARD_SCRUB_FAILED', 'The local vault scrub returned an invalid result.');
  }
  return { key, status: result.status };
}

// DISCONNECT THIS COMPUTER. The one vault record that says "this machine is
// connected to an account" (src/lib/online-fra-device-claim.js keeps it under
// DEVICE_CREDENTIAL_VAULT_KEY -- pairId, deviceId, certificate, the machine's
// own device token) is removed. This is local credential storage only: an
// admitted relay can retain its credential, so the app separately owns remote
// authority shutdown, pending disconnect intent and fresh-connection consent.
//
// KEY-BOUND ON PURPOSE, like scrubPaymentCardSecurityCode() above. This is not
// a generic delete: a "deleteSecret(key)" export would be the first generic
// destructive verb on this module, reachable by anything that can require it,
// and the identity key beside this one (the machine's long-lived Ed25519
// identity, a separate record) must never be removable by a misspelling.
// No record value crosses this boundary. Both platform helpers observe and
// remove the fixed key within their own locked transaction.
//
// Runs the selected platform's fixed-key removal unattended and answers with
// exactly one of
//   { key, status: 'cleared' | 'absent', mutationOutcome }
// A second press answers 'absent' honestly. Windows accepts REMOVED_SYNCED
// only after its helper's existing flushed, write-through replacement returns.
// This is a Windows call-completion receipt, not a power-loss guarantee or a
// claim that it performs Linux directory-fsync. Every failure is typed; the
// reason is deliberately not carried out, because a vault diagnostic can quote
// the file it failed on.
const DEVICE_CREDENTIAL_VAULT_KEY = 'custom.online_fra_device_credential_v1';
function clearDeviceCredential() {
  const key = DEVICE_CREDENTIAL_VAULT_KEY;
  if (process.platform === 'linux') {
    let linux;
    try {
      linux = require('./vault-linux');
      return linux.clearDeviceCredential();
    } catch (error) {
      const refusal = secretError('DEVICE_CREDENTIAL_CLEAR_FAILED', 'The local vault did not confirm this computer\'s account disconnection.');
      const details = require('./device-credential-clear-outcome').failureDetails(linux ? error
        : { code: 'SECRET_HELPER_UNAVAILABLE', mutationOutcome: 'NOT_ATTEMPTED' });
      refusal.mutationOutcome = details.mutationOutcome;
      refusal.localCause = details.localCause;
      throw refusal;
    }
  }
  function refused(mutationOutcome, localCause) {
    const error = secretError('DEVICE_CREDENTIAL_CLEAR_FAILED', 'This computer\'s saved account connection could not be confirmed.');
    error.mutationOutcome = mutationOutcome;
    error.localCause = localCause;
    return error;
  }
  let script;
  try {
    script = vaultScript();
  } catch {
    throw refused('NOT_ATTEMPTED', 'SECRET_HELPER_UNAVAILABLE');
  }
  // Declared WITH its initializer, not as a bare `let` assigned inside a try:
  // tools/check-spawn-env-scrub.js follows exactly one hop from `env: environment`
  // to a `const environment = ...` expression and certifies the scrub helper it
  // finds there; the bare-let shape read as UNRESOLVED (the 1.0.42 union-head red
  // of 2026-09-07) although the child never received an unscrubbed environment.
  // The refusal on any failure -- missing helper module or a scrub that refused --
  // is unchanged: NOT_ATTEMPTED / SECRET_HELPER_UNAVAILABLE, before anything runs.
  const environment = (() => {
    try {
      const { safeLaunchEnvironment } = require('./providers/subscription-launch-env.js');
      const scrubbed = safeLaunchEnvironment(process.env, { context: 'Windows device credential removal' });
      // A one-shot transaction must never inherit the persistent host's flag,
      // which would load definitions and then exit without running the action.
      for (const name of Object.keys(scrubbed)) {
        if (name.toUpperCase() === 'TOOLSENABLED_VAULT_HOST_LIBRARY') delete scrubbed[name];
      }
      return scrubbed;
    } catch {
      throw refused('NOT_ATTEMPTED', 'SECRET_HELPER_UNAVAILABLE');
    }
  })();
  invalidateSecretValueCache();
  let output;
  let status = 0;
  try {
    output = execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script,
      'clear-device-credential'
    ], {
      cwd: ROOT,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      timeout: 35_000,
      maxBuffer: 16 * 1024
    });
  } catch (error) {
    if (error && ['ENOENT', 'EACCES'].includes(error.code) && !Number.isInteger(error.status) && !error.signal) {
      throw refused('NOT_ATTEMPTED', 'SECRET_HELPER_UNAVAILABLE');
    }
    // Only a naturally completed nonzero child can return a pre-write refusal.
    // A timeout, signal or missing completion cannot certify when it stopped.
    if (!error || !Number.isInteger(error.status) || error.status === 0 || error.signal) {
      throw refused('UNCERTAIN', 'SECRET_HELPER_PROTOCOL_INVALID');
    }
    output = error.stdout;
    status = error.status;
  } finally {
    invalidateSecretValueCache();
  }
  let answer;
  try {
    const raw = Buffer.isBuffer(output) ? output.toString('utf8') : output;
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 2048) throw new Error('Invalid receipt.');
    answer = JSON.parse(raw);
    // The fixed helper emits compact ASCII metadata. Duplicate fields must
    // not be accepted through JSON.parse's last-value-wins behavior.
    if (JSON.stringify(answer) !== raw.trim()) throw new Error('Invalid receipt.');
  } catch { throw refused('UNCERTAIN', 'SECRET_HELPER_PROTOCOL_INVALID'); }
  const exact = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...names].sort().join(',');
  if (status === 0 && exact(answer, ['ok', 'result']) && answer.ok === true
      && exact(answer.result, ['key', 'status', 'mutationOutcome']) && answer.result.key === key
      && ((answer.result.status === 'cleared' && answer.result.mutationOutcome === 'REMOVED_SYNCED')
        || (answer.result.status === 'absent' && answer.result.mutationOutcome === 'NOT_ATTEMPTED'))) {
    return { key, status: answer.result.status, mutationOutcome: answer.result.mutationOutcome };
  }
  const beforeWrite = ['SECRET_INPUT_INVALID', 'SECRET_VAULT_UNREADABLE', 'SECRET_VAULT_PATH_UNSAFE', 'SECRET_VAULT_LOCK_TIMEOUT'];
  if (status !== 0 && exact(answer, ['ok', 'code', 'mutationOutcome']) && answer.ok === false
      && ((answer.mutationOutcome === 'NOT_ATTEMPTED' && beforeWrite.includes(answer.code))
        || (answer.mutationOutcome === 'UNCERTAIN' && answer.code === 'SECRET_VAULT_WRITE_UNCERTAIN'))) {
    throw refused(answer.mutationOutcome, answer.code);
  }
  throw refused('UNCERTAIN', 'SECRET_HELPER_PROTOCOL_INVALID');
}

function withCredentialPrompt(callback, requestMetadata = {}) {
  if (typeof callback !== 'function') throw new TypeError('Credential prompt callback must be a function.');
  // Agent and scheduled callers can defer owner-only credential entry. The
  // handler still runs, but a missing vault value remains a typed
  // SECRET_NOT_CONFIGURED failure instead of creating a queued owner request.
  // Interactive callers never open a surprise credential window: they queue
  // a durable request and receive a typed resumable result instead.
  if (process.env.TOOLSENABLED_DEFER_CREDENTIAL_PROMPTS === '1') {
    return credentialPromptContext.run(Object.freeze({ enabled: false }), callback);
  }
  const promptContext = { enabled: true };
  if (requestMetadata && typeof requestMetadata === 'object' && !Array.isArray(requestMetadata) &&
      requestMetadata.requestContext && typeof requestMetadata.requestContext === 'object' &&
      typeof requestMetadata.requester === 'string') {
    promptContext.requestContext = Object.freeze({ ...requestMetadata.requestContext });
    promptContext.requester = requestMetadata.requester;
  }
  return credentialPromptContext.run(Object.freeze(promptContext), callback);
}

// Codes the durable owner-prompt queue itself raises. Each is paired in that
// module with a fixed literal message, so re-surfacing the pair leaks nothing a
// caller could not already read from the queue's own API. An unrecognised code
// is treated as an unexpected internal failure and stays generic.
const OWNER_PROMPT_QUEUE_CODES = new Set([
  'OWNER_PROMPT_ATTRIBUTION_REQUIRED', 'OWNER_PROMPT_DIFFERENT_ACTIVE', 'OWNER_PROMPT_EVENTS_INVALID',
  'OWNER_PROMPT_INVALID', 'OWNER_PROMPT_IN_PROGRESS', 'OWNER_PROMPT_NOT_FOUND', 'OWNER_PROMPT_QUEUE_BUSY',
  'OWNER_PROMPT_QUEUE_FULL', 'OWNER_PROMPT_QUEUE_INVALID', 'OWNER_PROMPT_QUEUE_UNAVAILABLE',
  'OWNER_PROMPT_RUNNER_UNAVAILABLE'
]);
// Plain prose only: no paths, no quotes, no vault values could survive this.
const OWNER_PROMPT_QUEUE_MESSAGE_RE = /^[A-Za-z0-9][A-Za-z0-9 ,.;:'()-]{0,199}$/;
const OWNER_PROMPT_BLOCKER_KEY_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const OWNER_PROMPT_BLOCKER_ID_RE = /^owner-prompt-[a-f0-9-]{36}$/;
const OWNER_PROMPT_LAUNCH_MESSAGES = Object.freeze({
  OWNER_PROMPT_PLATFORM_UNSUPPORTED: 'This owner form is unavailable on this platform. The request remains queued and can be cancelled with owner_prompts.cancel.',
  OWNER_PROMPT_RUNNER_UNAVAILABLE: 'Owner credential input is queued, but the form runner could not start. Retry owner_prompts.start or cancel with owner_prompts.cancel.',
  OWNER_PROMPT_RUNNER_LOOKUP_UNAVAILABLE: 'Owner credential input is queued, but the form runner could not be checked. Retry owner_prompts.start or cancel with owner_prompts.cancel.'
});

function surfacedOwnerPromptQueueError(queueError) {
  const code = queueError && typeof queueError.code === 'string' ? queueError.code : '';
  const message = queueError && typeof queueError.message === 'string' ? queueError.message : '';
  if (!OWNER_PROMPT_QUEUE_CODES.has(code) || !OWNER_PROMPT_QUEUE_MESSAGE_RE.test(message)) {
    return credentialPromptError('OWNER_PROMPT_QUEUE_FAILED', 'The owner credential request could not be queued.');
  }
  const surfaced = credentialPromptError(code, message);
  // A blocked request is only actionable if the blocker can be named. These are
  // a request id and a vault key NAME; no vault value is ever carried here.
  if (OWNER_PROMPT_BLOCKER_ID_RE.test(String(queueError.blockingRequestId || ''))) {
    surfaced.blockingRequestId = queueError.blockingRequestId;
  }
  if (OWNER_PROMPT_BLOCKER_KEY_RE.test(String(queueError.blockingVaultKey || ''))) {
    surfaced.blockingVaultKey = queueError.blockingVaultKey;
  }
  return surfaced;
}

function promptDefinitionForSecret(key, options = {}) {
  if (options && options.prompt === false) return null;
  if (options && options.prompt === true) return credentialDefinitionForKey(key);
  const context = credentialPromptContext.getStore();
  return context && context.enabled === true ? credentialDefinitionForKey(key) : null;
}

function getSecret(key, options = {}) {
  try {
    return readSecretFromVault(key);
  } catch (error) {
    if (!error || error.code !== 'SECRET_NOT_CONFIGURED') throw error;
    const definition = promptDefinitionForSecret(key, options);
    if (!definition) throw error;
    const promptRequestContext = credentialPromptContext.getStore();
    if (!promptRequestContext || !promptRequestContext.requestContext || !promptRequestContext.requester) {
      throw credentialPromptError(
        'CREDENTIAL_PROMPT_CONTEXT_REQUIRED',
        'Credential entry requires a supported attributed provider or local-workflow context.'
      );
    }
    let queued;
    try {
      // Loaded lazily to keep the low-level runtime independent at startup.
      // Tool execution supplies bounded public attribution for the owner UI.
      // Direct runtime callers without that metadata fail above and never
      // create an owner-facing request.
      const request = {
        kind: 'credential', vaultKey: key, label: definition.label
      };
      request.requestContext = promptRequestContext.requestContext;
      request.requester = promptRequestContext.requester;
      queued = require('./providers/owner-prompt-queue').enqueue(request);
    } catch (queueError) {
      // The queue's own refusals are already caller-safe typed errors built by
      // provider-safety with fixed literal prose, and they are the only thing
      // that says WHY the owner could not be asked — another prompt is already
      // active, the queue file is busy, the desktop runner is unavailable.
      // Collapsing every one of them into a single generic sentence made every
      // missing credential unactionable for the owner and for the next agent.
      throw surfacedOwnerPromptQueueError(queueError);
    }
    // Enqueue can persist successfully while its native form cannot launch.
    // Keep the durable id and the known prerequisite together; waiting for an
    // owner event from an unavailable form cannot resolve this operation.
    const launchCode = Object.hasOwn(OWNER_PROMPT_LAUNCH_MESSAGES, queued.launchFailure)
      ? queued.launchFailure : null;
    const queuedError = credentialPromptError(launchCode || 'OWNER_PROMPT_QUEUED', launchCode
      ? OWNER_PROMPT_LAUNCH_MESSAGES[launchCode]
      : queued.launchFailure
        ? 'Owner credential input is queued, but its form could not open. Use owner_prompts.start to retry the form or owner_prompts.cancel to cancel.'
        : 'Owner credential input is queued. Wait for the durable owner-prompt event before retrying this operation.');
    queuedError.requestId = queued.requestId;
    throw queuedError;
  }
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

   SAME SEAM, TWO HALVES: `vaultSetterFailure` on branch
   m8/vault-setter-stderr-and-scrub-20260916 (60825a3c) is this same function
   for the three setters, which are not in these bytes -- 60825a3c is not an
   ancestor of this tree. When the two land together they should be collapsed
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
// T329: the two hosted catch blocks (readSecretFromVaultHost and
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
  if (process.platform === 'linux') return require('./vault-linux').list();
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
  if (process.platform === 'linux') return require('./vault-linux').setMany([{ key, value }]);
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
  if (process.platform === 'linux') return require('./vault-linux').setMany([
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
  if (process.platform === 'linux') return require('./vault-linux').setMany([
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
  if (process.platform === 'linux') return require('./vault-linux').getOrCreate(key, candidate);
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
// REASON and, when the host client attached one, its `code` (T329, via
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
  if (process.platform === 'linux') return require('./vault-linux').setMonotonic(key, value, sequence);
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
  ROOT, rootPath, consentRoot, ensureDir, readJson, writeJsonAtomic, commandPath, commandExists, resetCommandPathCache, findBrowser,
  run, getSecret, readSecretsFromVault, listSecretKeys, setSecret, setSecretPair, setSecretTriple, getOrCreateSecret, setMonotonicSecret, secretExists,
  captureCredential, capturePaymentCard, clearDeviceCredential, withCredentialPrompt,
  run, getSecret, listSecretKeys, setSecret, setSecretPair, setSecretTriple, getOrCreateSecret, setMonotonicSecret, secretExists,
  captureCredential, capturePaymentCard, scrubPaymentCardSecurityCode, clearDeviceCredential, withCredentialPrompt,
  withVaultPrincipal, assertVaultReadAllowed,
  vaultFilePath, vaultFingerprint, vaultContentDigest,
  // Exported for tests only: the rules that decide when a decrypted value may
  // be served without asking the vault again. Testing them here means the
  // security-relevant half is asserted without spawning a process.
  invalidateSecretValueCache, rememberSecretValue, rememberedSecretValue, SECRET_CACHE_TTL_MS
};
