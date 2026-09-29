'use strict';

// Dependency-light FRA workspace policy. This module is safe to load before
// runtime-integrity verification: it has no provider, registry, audit, vault,
// filesystem, or process side effects.
const crypto = require('node:crypto');
const path = require('node:path');

const MAX_FILE_BYTES = 512 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 2000;
const MAX_PAGE_ENTRIES = 100;
const MAX_HANDLES_PER_SESSION = 4096;

const EXCLUDED_DIR_NAMES = new Set([
  'state', 'vault', 'logs', 'profiles', '.git', 'node_modules',
  '.ssh', '.aws', '.gnupg', '.docker', '.kube', '.gemini', '.password-store',
  /* MEASURED GAP, 2026-09-24. The names below were reachable here. `.gpg`,
     `credentials` and `secrets` matched only as FILE names, so the directory
     itself was refused while `credentials/aws.json` inside it was served --
     the containment bug this whole exclusion exists to prevent. The rest
     (`.azure`, `.gcloud`, `.chef`, `.nuget`, `.terraform.d`,
     `.thunderbird`, `.subversion`, `.credentials`, `.secrets`) matched
     nothing at all. Checked per segment by isExcludedDirectoryPath below, so
     each applies at every depth and to every file beneath it. */
  '.gpg', '.azure', '.gcloud', '.chef', '.nuget', '.terraform.d',
  '.thunderbird', '.subversion',
  'credentials', '.credentials', '.secrets', 'secrets'
]);
// Scope compound stores to their actual directories; ordinary .config and
// provider documentation remain navigable. Every match applies at any depth.
const EXCLUDED_DIRECTORY_PATTERNS = Object.freeze([
  /(?:^|[\\/])\.config[\\/](?:gcloud|chromium|google-chrome|1password|doctl|hub|op)(?:[\\/]|$)/i,
  /(?:^|[\\/])\.local[\\/]share[\\/](?:keyrings|kwalletd|keepassxc)(?:[\\/]|$)/i,
  /(?:^|[\\/])\.pki[\\/]nssdb(?:[\\/]|$)/i,
  /(?:^|[\\/])\.mozilla[\\/]firefox(?:[\\/]|$)/i,
  /(?:^|[\\/])AppData[\\/]Local[\\/](?:Google[\\/]Chrome|Microsoft[\\/]Credentials)(?:[\\/]|$)/i,
  /(?:^|[\\/])AppData[\\/]Roaming[\\/](?:gcloud|Microsoft[\\/](?:Crypto|Protect))(?:[\\/]|$)/i
]);
const EXCLUDED_FILE_PATTERNS = Object.freeze([
  /(?:^|[\\/])(?:client[_-]secret|oauth[_-]client[_-]secret|api[_-]key|service[._-]?account|application[_-]default[_-]credentials)(?:[._-][^\\/]*)?\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf)$/i,
  /(?:^|[\\/])(?:credentials|\.netrc|\.pgpass|\.my\.cnf|\.git-credentials|fish_history)$/i,
  /* The rest of the bare-name credential files a workspace can hold: a vault
     token, an htpasswd, and the cloud CLI configs that carry live keys. The
     rule above already names the common Unix ones; these are the ones a
     deployment or tooling directory adds. */
  /(?:^|[\\/])(?:_netrc|\.dockercfg|\.s3cfg|\.boto|\.rclone\.conf|\.vault-token|\.htpasswd|htpasswd|secrets)$/i,
  /* A ROTATED KEY IS STILL A KEY. `id_(rsa|...)` was anchored to the exact
     basename, so `id_rsa.bak`, `id_rsa_old` and `id_ed25519.bak` were listed
     AND their bodies served -- measured, a full OPENSSH PRIVATE KEY came back
     through the workspace read path. The optional `[._-]<anything>` tail
     refuses every rotated or backed-up copy at any depth. It also fences
     `id_rsa.pub`, which is deliberate and costs a reader nothing.
     `[^\\/]*` rather than `[^\\/]+` before the key extensions so a file named
     exactly `.key` / `.p12` / `.pfx` / `.kdbx` is refused too. */
  /(?:^|[\\/])(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:[._-][^\\/]*)?|private[_-]?key(?:\.(?:pem|key))?|[^\\/]*\.(?:key|p12|pfx|kdbx))$/i,
  /* A PRIVATE KEY BY EXTENSION, WHEREVER IT SITS. The rule above catches
     `private_key.pem` and bare `.key/.p12/.pfx/.kdbx`, but not the ordinary
     `server.pem` / `tls.pem` a deployment directory holds -- PEM is the usual
     on-disk form of a TLS private key, so a workspace listing handed those
     over at any depth. Certificates (.crt/.cer) stay listable: they are
     public by design and refusing them would cost the customer real work. */
  /\.(?:jks|keystore|ppk|asc|gpg|pgp)$/i,
  /* PEM SAYS NOTHING ABOUT SECRECY BY ITSELF -- the same extension carries a
     TLS private key, a certificate and a public key. The name is what tells
     them apart in every layout that ships them together: ACME writes
     `privkey.pem` beside `cert.pem`, `chain.pem` and `fullchain.pem`. So a
     basename that announces itself as public stays listable and everything
     else is withheld. Refusing `certificate.pem` bought no secrecy and cost
     the customer real work (T1614). */
  /(?:^|[\\/])(?!(?:public|cert|certificate|chain|fullchain|ca|ca-bundle|root|intermediate)[^\\/]*\.pem$)[^\\/]*\.pem$/i,
  /(?:^|[\\/])\.codex[\\/]config\.toml$/i,
  /(?:^|[\\/])(?:\.claude\.json|\.claude[\\/]settings(?:\.local)?\.json)$/i,
  /(?:^|[\\/])\.npmrc$/i,
  /(?:^|[\\/])\.pypirc$/i,
  /(?:^|[\\/])NuGet[\\/]NuGet\.Config$/i,
  /(?:^|[\\/])\.nuget[\\/]NuGet\.Config$/i,
  /(?:^|[\\/])\.azure[\\/](?:azureProfile\.json|AzureRmContext\.json|accessTokens\.json|msal_token_cache\.bin)$/i,
  /(?:^|[\\/])\.terraform\.d[\\/]credentials\.tfrc\.json$/i,
  /(?:^|[\\/])\.config[\\/]gh[\\/]hosts\.ya?ml$/i,
  /(?:^|[\\/])(?:WindowsPowerShell|PowerShell)[\\/]PSReadLine[\\/]ConsoleHost_history\.txt$/i,
  /(?:^|[\\/])ConsoleHost_history\.txt$/i,
  /(?:^|[\\/])\.(?:bash_history|zsh_history|fish_history|python_history)$/i
]);
const COMMON_CREDENTIAL_STORE_PATTERN = /(?:^|[\\/])(?:\.(?:auth|token|tokens|cookie|cookies|credential|credentials|secret|secrets|session|sessions)|auth|token|tokens|cookie|cookies|credential|credentials|secret|secrets|session|sessions)(?:[._-][^\\/]*)?\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf|db|sqlite3?)$/i;

function isProtectedEnvironmentPath(relativePath) {
  const basename = path.posix.basename(String(relativePath).replace(/\\/g, '/')).toLowerCase();
  if (basename === '.env') return true;
  if (!basename.startsWith('.env.')) return false;
  return !['.env.example', '.env.template', '.env.sample'].includes(basename);
}

function isCredentialOrHistoryPath(relativePath) {
  return EXCLUDED_FILE_PATTERNS.some(pattern => pattern.test(relativePath))
    || COMMON_CREDENTIAL_STORE_PATTERN.test(relativePath)
    || isProtectedEnvironmentPath(relativePath);
}

function isExcludedDirectoryPath(relativePath) {
  return String(relativePath).split(/[\\/]/).some(segment => EXCLUDED_DIR_NAMES.has(segment.toLowerCase()))
    || EXCLUDED_DIRECTORY_PATTERNS.some(pattern => pattern.test(relativePath));
}

const WORKSPACE_POLICY_DESCRIPTOR = Object.freeze({
  schemaVersion: 1,
  pathInputs: false,
  sessionScopedHandles: true,
  nativeHandleIdentity: true,
  staleIdentityRefused: true,
  reparsesRefused: true,
  hardLinksRefused: true,
  excludedDirectories: Object.freeze([...EXCLUDED_DIR_NAMES].sort()),
  excludedDirectoryPatterns: Object.freeze(EXCLUDED_DIRECTORY_PATTERNS.map(String)),
  excludedFilePatterns: Object.freeze([...EXCLUDED_FILE_PATTERNS, COMMON_CREDENTIAL_STORE_PATTERN].map(String)),
  maxFileBytes: MAX_FILE_BYTES,
  maxReadBytes: MAX_READ_BYTES,
  maxDirectoryEntries: MAX_DIRECTORY_ENTRIES,
  maxPageEntries: MAX_PAGE_ENTRIES,
  maxHandlesPerSession: MAX_HANDLES_PER_SESSION
});
const WORKSPACE_POLICY_DIGEST = crypto.createHash('sha256')
  .update('ToolsEnabled/FRA/workspace-policy/v1', 'utf8').update('\0', 'utf8')
  .update(JSON.stringify(WORKSPACE_POLICY_DESCRIPTOR), 'utf8')
  .digest('hex');

module.exports = Object.freeze({
  EXCLUDED_DIR_NAMES,
  EXCLUDED_DIRECTORY_PATTERNS,
  EXCLUDED_FILE_PATTERNS,
  MAX_DIRECTORY_ENTRIES,
  MAX_FILE_BYTES,
  MAX_HANDLES_PER_SESSION,
  MAX_PAGE_ENTRIES,
  MAX_READ_BYTES,
  WORKSPACE_POLICY_DESCRIPTOR,
  WORKSPACE_POLICY_DIGEST,
  isCredentialOrHistoryPath,
  isExcludedDirectoryPath,
  isProtectedEnvironmentPath
});
