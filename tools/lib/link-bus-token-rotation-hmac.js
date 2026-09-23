'use strict';

// Signs bounded canonical protocol bytes with the fixed link-bus secret while
// keeping DPAPI plaintext inside a hidden PowerShell process.  Only the
// canonical 32-byte HMAC is returned to Node.

const fs = require('node:fs');
const path = require('node:path');
const {
  TOKEN_VAULT_KEY,
  LinkBusTokenRotationError,
  zero
} = require('./link-bus-token-rotation');
const {
  runHiddenProcess
} = require('./hidden-process');

const MAX_CANONICAL_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024;

function fail(code, message) {
  throw new LinkBusTokenRotationError(code, message);
}

function minimalEnvironment() {
  const selected = {};
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP'
  ]) {
    if (typeof process.env[key] === 'string') selected[key] = process.env[key];
  }
  return selected;
}

function powerShellPath() {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR ||
    'C:\\Windows';
  return path.join(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
}

async function signCanonicalWithDpapiVault({
  repoRoot,
  vaultPath,
  canonical,
  processRunner = runHiddenProcess,
  powershellExecutable = powerShellPath()
}) {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedVault = path.resolve(vaultPath);
  const expectedVaultDirectory = path.join(resolvedRoot, 'vault');
  if (
    !path.isAbsolute(repoRoot) ||
    !path.isAbsolute(vaultPath) ||
    !path.isAbsolute(powershellExecutable) ||
    path.dirname(resolvedVault).toLowerCase() !==
      expectedVaultDirectory.toLowerCase() ||
    !Buffer.isBuffer(canonical) ||
    canonical.byteLength < 1 ||
    canonical.byteLength > MAX_CANONICAL_BYTES
  ) {
    fail('INVALID_CONFIGURATION', 'DPAPI HMAC configuration is invalid');
  }
  const vaultStat = await fs.promises.lstat(resolvedVault);
  if (!vaultStat.isFile() || vaultStat.isSymbolicLink()) {
    fail('INVALID_VAULT_FILE', 'DPAPI HMAC vault is not a regular file');
  }
  const script = path.join(
    resolvedRoot,
    'tools',
    'special-session-offer-auth.ps1'
  );
  const scriptStat = await fs.promises.lstat(script);
  if (!scriptStat.isFile() || scriptStat.isSymbolicLink()) {
    fail('INVALID_CONFIGURATION', 'DPAPI HMAC helper is unavailable');
  }
  let result;
  try {
    result = await processRunner({
      file: powershellExecutable,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-VaultPath',
        resolvedVault,
        '-KeyId',
        TOKEN_VAULT_KEY
      ],
      cwd: resolvedRoot,
      env: minimalEnvironment(),
      stdin: canonical,
      windowsHide: true,
      shell: false,
      timeoutMs: 30000,
      maxOutputBytes: MAX_OUTPUT_BYTES
    });
    const encodedHmac = Buffer.isBuffer(result && result.stdout)
      ? result.stdout.toString('latin1')
      : '';
    if (
      !result ||
      result.code !== 0 ||
      !Buffer.isBuffer(result.stdout) ||
      !Buffer.isBuffer(result.stderr) ||
      result.stderr.length !== 0 ||
      !/^[A-Za-z0-9_-]{43}$/.test(encodedHmac)
    ) {
      fail('DPAPI_HMAC_FAILED', 'DPAPI HMAC helper failed');
    }
    return encodedHmac;
  } catch (error) {
    if (error instanceof LinkBusTokenRotationError) throw error;
    fail('DPAPI_HMAC_FAILED', 'DPAPI HMAC helper failed');
  } finally {
    if (result) {
      zero(result.stdout);
      zero(result.stderr);
    }
  }
}

module.exports = {
  MAX_CANONICAL_BYTES,
  minimalEnvironment,
  powerShellPath,
  signCanonicalWithDpapiVault
};
