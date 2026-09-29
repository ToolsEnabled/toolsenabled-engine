'use strict';

// Data custody has separate Windows DPAPI and Linux libsecret implementations.
// Windows-only dialogs and lifecycle operations retain their own boundary;
// accepting Linux here never licenses a PowerShell fallback on that platform.

const SUPPORTED_VAULT_PLATFORM = 'win32';
const SUPPORTED_VAULT_PLATFORMS = Object.freeze(['win32', 'linux']);
const VAULT_PLATFORM_UNSUPPORTED = 'SECRET_VAULT_PLATFORM_UNSUPPORTED';
const VAULT_PLATFORM_UNSUPPORTED_MESSAGE = 'The local secret vault is not available on this platform. Whether a record is on file is unknown, and retrying will not help.';
const WINDOWS_VAULT_OPERATION_UNSUPPORTED_MESSAGE = 'This credential management operation requires Windows. The request did not inspect or change a credential.';

class VaultPlatformError extends Error {
  constructor(message = VAULT_PLATFORM_UNSUPPORTED_MESSAGE) {
    super(message);
    this.name = 'VaultPlatformError';
    this.code = VAULT_PLATFORM_UNSUPPORTED;
    this.retryable = false;
  }
}

function vaultPlatformRefusal() {
  return new VaultPlatformError();
}

function assertVaultPlatform(platform) {
  const measuredPlatform = arguments.length === 0 ? process.platform : platform;
  if (!SUPPORTED_VAULT_PLATFORMS.includes(measuredPlatform)) throw vaultPlatformRefusal();
}

function assertWindowsVaultPlatform(platform) {
  const measuredPlatform = arguments.length === 0 ? process.platform : platform;
  if (measuredPlatform !== SUPPORTED_VAULT_PLATFORM) {
    if (SUPPORTED_VAULT_PLATFORMS.includes(measuredPlatform)) {
      throw new VaultPlatformError(WINDOWS_VAULT_OPERATION_UNSUPPORTED_MESSAGE);
    }
    throw vaultPlatformRefusal();
  }
}

function isVaultPlatformRefusal(error) {
  return Boolean(error) && error.code === VAULT_PLATFORM_UNSUPPORTED;
}

module.exports = Object.freeze({
  SUPPORTED_VAULT_PLATFORM,
  SUPPORTED_VAULT_PLATFORMS,
  VAULT_PLATFORM_UNSUPPORTED,
  VAULT_PLATFORM_UNSUPPORTED_MESSAGE,
  WINDOWS_VAULT_OPERATION_UNSUPPORTED_MESSAGE,
  VaultPlatformError,
  assertVaultPlatform,
  assertWindowsVaultPlatform,
  isVaultPlatformRefusal,
  vaultPlatformRefusal
});
