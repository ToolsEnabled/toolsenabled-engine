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
  'state', 'vault', 'logs', 'profiles', '.git', 'node_modules'
]);
const EXCLUDED_FILE_PATTERNS = Object.freeze([
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
const COMMON_CREDENTIAL_STORE_PATTERN = /(?:^|[\\/])(?:\.(?:auth|token|tokens|cookie|cookies|credential|credentials|session|sessions)|auth|token|tokens|cookie|cookies|credential|credentials|session|sessions)(?:[._-][^\\/]*)?\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf|db|sqlite3?)$/i;

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

const WORKSPACE_POLICY_DESCRIPTOR = Object.freeze({
  schemaVersion: 1,
  pathInputs: false,
  sessionScopedHandles: true,
  nativeHandleIdentity: true,
  staleIdentityRefused: true,
  reparsesRefused: true,
  hardLinksRefused: true,
  excludedDirectories: Object.freeze([...EXCLUDED_DIR_NAMES].sort()),
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
  EXCLUDED_FILE_PATTERNS,
  MAX_DIRECTORY_ENTRIES,
  MAX_FILE_BYTES,
  MAX_HANDLES_PER_SESSION,
  MAX_PAGE_ENTRIES,
  MAX_READ_BYTES,
  WORKSPACE_POLICY_DESCRIPTOR,
  WORKSPACE_POLICY_DIGEST,
  isCredentialOrHistoryPath,
  isProtectedEnvironmentPath
});
