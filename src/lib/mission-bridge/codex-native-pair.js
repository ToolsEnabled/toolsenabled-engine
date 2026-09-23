'use strict';

// Mission Bridge dispatches are security-sensitive app launches. On Windows,
// resolve Codex only from an installed stable npm package and keep the native
// executable paired with the command-runner resource declared by that same
// package. This intentionally does not reuse the provider gateway's VS Code
// extension fallback, whose prerelease bundle has a different reliability
// history and serves unrelated provider-gateway consumers.

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const accountBoundary = require('../account-profile-boundary');

const CODEX_PACKAGE = '@openai/codex';
const STABLE_VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const VERSION_OUTPUT_RE = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)$/;
const VERSION_PROBE_TIMEOUT_MS = 8_000;
const AUTHENTICODE_TIMEOUT_MS = 15_000;
const EXPECTED_SIGNER = 'OpenAI OpCo, LLC';
const MAX_MANIFEST_BYTES = 64 * 1024;
const AUTHENTICODE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$files=@($env:TOOLSENABLED_CODEX_SIGNATURE_FILES -split "`n")',
  '$results=@()',
  'foreach($file in $files){',
  '  $signature=Get-AuthenticodeSignature -LiteralPath $file',
  '  $signer=$null',
  '  if($null -ne $signature.SignerCertificate){',
  '    $signer=$signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)',
  '  }',
  '  $results+=[PSCustomObject]@{status=[string]$signature.Status;signer=$signer}',
  '}',
  '$results|ConvertTo-Json -Compress'
].join('\n');
const WINDOWS_TARGETS = Object.freeze({
  x64: Object.freeze({
    dependency: '@openai/codex-win32-x64',
    packageSuffix: 'win32-x64',
    target: 'x86_64-pc-windows-msvc'
  }),
  arm64: Object.freeze({
    dependency: '@openai/codex-win32-arm64',
    packageSuffix: 'win32-arm64',
    target: 'aarch64-pc-windows-msvc'
  })
});

class MissionCodexNativePairError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'MissionCodexNativePairError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new MissionCodexNativePairError(code, message, details);
}

function lookupFailed(error, subject) {
  if (error?.code === 'ENOENT') return false;
  fail('CODEX_NATIVE_PAIR_LOOKUP_INDETERMINATE',
    `The ${subject} could not be checked; this does NOT claim that Codex is absent.`,
    { causeCode: typeof error?.code === 'string' ? error.code : 'UNKNOWN' });
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function environmentValue(environment, name) {
  const key = Object.keys(environment || {}).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? environment[key] : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function defaultNpmRoots({
  environment = process.env,
  globalPaths = Module.globalPaths,
  execPath = process.execPath
} = {}) {
  const candidates = [];
  const add = value => {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return;
    candidates.push(path.resolve(value.trim()));
  };
  const prefix = environmentValue(environment, 'npm_config_prefix');
  if (prefix) add(path.join(prefix, 'node_modules'));
  const appData = environmentValue(environment, 'APPDATA');
  if (appData) add(path.join(appData, 'npm', 'node_modules'));
  const searchPath = environmentValue(environment, 'PATH');
  if (searchPath) {
    for (const entry of searchPath.split(path.delimiter)) {
      if (!entry.trim()) continue;
      add(path.join(entry.trim(), 'node_modules'));
      if (path.basename(entry.trim()).toLowerCase() === 'node_modules') add(entry.trim());
    }
  }
  for (const entry of Array.isArray(globalPaths) ? globalPaths : []) add(entry);
  if (typeof execPath === 'string' && execPath.trim()) add(path.join(path.dirname(execPath), 'node_modules'));
  return Object.freeze([...new Set(candidates.map(candidate => candidate.toLowerCase()))]
    .map(lower => candidates.find(candidate => candidate.toLowerCase() === lower)));
}

function realpath(fsImpl, target) {
  const implementation = fsImpl.realpathSync;
  if (typeof implementation !== 'function') fail('CODEX_NATIVE_PAIR_INVALID', 'The npm installation path cannot be verified.');
  return typeof implementation.native === 'function' ? implementation.native(target) : implementation(target);
}

function regularFile(fsImpl, root, target, label, { pe = false } = {}) {
  let stat;
  let canonical;
  try {
    stat = fsImpl.lstatSync(target);
    canonical = realpath(fsImpl, target);
  } catch (error) {
    lookupFailed(error, `installed Codex ${label}`);
    fail('CODEX_NATIVE_PAIR_FILE_MISSING', `The installed Codex ${label} is missing.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < (pe ? 2 : 1) || !inside(root, canonical)) {
    fail('CODEX_NATIVE_PAIR_FILE_INVALID', `The installed Codex ${label} is not a contained regular file.`);
  }
  if (pe) {
    let handle;
    try {
      const header = Buffer.alloc(2);
      handle = fsImpl.openSync(target, 'r');
      const bytes = fsImpl.readSync(handle, header, 0, 2, 0);
      if (bytes !== 2 || header[0] !== 0x4d || header[1] !== 0x5a) {
        fail('CODEX_NATIVE_PAIR_PE_INVALID', `The installed Codex ${label} is not a Windows PE executable.`);
      }
    } finally {
      if (handle !== undefined) fsImpl.closeSync(handle);
    }
  }
  return canonical;
}

function readManifest(fsImpl, root, file, label) {
  const canonical = regularFile(fsImpl, root, file, label);
  let stat;
  let parsed;
  try {
    stat = fsImpl.statSync(canonical);
    if (stat.size > MAX_MANIFEST_BYTES) fail('CODEX_NATIVE_PAIR_MANIFEST_INVALID', `The installed Codex ${label} is too large.`);
    parsed = fsImpl.readFileSync(canonical, 'utf8');
  } catch (error) {
    if (error instanceof MissionCodexNativePairError) throw error;
    lookupFailed(error, `installed Codex ${label}`);
  }
  try {
    parsed = JSON.parse(parsed);
  } catch {
    fail('CODEX_NATIVE_PAIR_MANIFEST_INVALID', `The installed Codex ${label} is invalid.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('CODEX_NATIVE_PAIR_MANIFEST_INVALID', `The installed Codex ${label} must be an object.`);
  }
  return parsed;
}

function safeRelative(value, expected, label) {
  if (typeof value !== 'string' || value !== expected || path.isAbsolute(value)
      || value.split(/[\\/]/).some(segment => !segment || segment === '.' || segment === '..')) {
    fail('CODEX_NATIVE_PAIR_LAYOUT_MISMATCH', `The installed Codex ${label} does not match its package layout.`);
  }
  return value;
}

function compareStableVersions(left, right) {
  const a = left.split('.').map(value => BigInt(value));
  const b = right.split('.').map(value => BigInt(value));
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function verifyAuthenticode(files, {
  environment = process.env,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
  timeoutMs = AUTHENTICODE_TIMEOUT_MS
} = {}) {
  if (!Array.isArray(files) || files.length !== 3
      || files.some(file => typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file))) {
    fail('CODEX_NATIVE_PAIR_SIGNATURE_INVALID', 'The installed Codex signature target set is invalid.');
  }
  const windowsRoot = environmentValue(environment, 'SystemRoot') || environmentValue(environment, 'windir');
  if (!windowsRoot) fail('CODEX_NATIVE_PAIR_SIGNATURE_UNAVAILABLE', 'The Windows signature verifier could not be resolved.');
  const powershell = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let stat;
  try { stat = fsImpl.lstatSync(powershell); }
  catch (error) {
    if (error?.code !== 'ENOENT') lookupFailed(error, 'Windows signature verifier');
    fail('CODEX_NATIVE_PAIR_SIGNATURE_UNAVAILABLE', 'The Windows signature verifier is unavailable.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('CODEX_NATIVE_PAIR_SIGNATURE_UNAVAILABLE', 'The Windows signature verifier is not a regular executable.');
  }
  let result;
  try {
    result = spawnSyncImpl(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', AUTHENTICODE_SCRIPT
    ], {
      env: { ...environment, TOOLSENABLED_CODEX_SIGNATURE_FILES: files.join('\n') },
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024
    });
  } catch (error) {
    lookupFailed(error, 'Windows signature verifier');
  }
  if (result?.error || result?.signal) lookupFailed(result.error || { code: `SIGNAL_${result.signal}` }, 'Windows signature verifier');
  let signatures;
  try { signatures = JSON.parse(String(result?.stdout || '').trim()); }
  catch { fail('CODEX_NATIVE_PAIR_SIGNATURE_INVALID', 'The installed Codex signature result is invalid.'); }
  if (result?.status !== 0 || !Array.isArray(signatures)
      || signatures.length !== files.length
      || signatures.some(signature => signature?.status !== 'Valid' || signature?.signer !== EXPECTED_SIGNER)) {
    fail('CODEX_NATIVE_PAIR_SIGNATURE_INVALID', 'The installed Codex native pair does not have valid OpenAI signatures.');
  }
  return Object.freeze(signatures.map(signature => Object.freeze({ status: signature.status, signer: signature.signer })));
}

function inspectNpmRoot(npmRoot, {
  arch,
  environment,
  fsImpl,
  spawnSyncImpl,
  versionProbeTimeoutMs,
  verifySignaturesImpl
}) {
  const target = WINDOWS_TARGETS[arch];
  if (!target) fail('CODEX_NATIVE_PAIR_PLATFORM_UNSUPPORTED', `Windows architecture ${arch} is not supported.`);
  let canonicalNpmRoot;
  try { canonicalNpmRoot = realpath(fsImpl, npmRoot); }
  catch (error) {
    if (error?.code !== 'ENOENT') lookupFailed(error, 'discovered npm root');
    fail('CODEX_NATIVE_PAIR_NPM_ROOT_INVALID', 'A discovered npm root is unavailable.');
  }

  const packageRoot = path.join(canonicalNpmRoot, '@openai', 'codex');
  const packageManifest = readManifest(fsImpl, canonicalNpmRoot, path.join(packageRoot, 'package.json'), 'package manifest');
  if (packageManifest.name !== CODEX_PACKAGE || typeof packageManifest.version !== 'string'
      || !STABLE_VERSION_RE.test(packageManifest.version)) {
    fail('CODEX_NATIVE_PAIR_UNSTABLE', 'The discovered Codex npm package is not a stable release.');
  }
  const version = packageManifest.version;
  const expectedDependency = `npm:${CODEX_PACKAGE}@${version}-${target.packageSuffix}`;
  if (packageManifest.optionalDependencies?.[target.dependency] !== expectedDependency) {
    fail('CODEX_NATIVE_PAIR_DEPENDENCY_MISMATCH', 'The Codex platform dependency does not match the stable package version.');
  }

  const nativeRoots = [
    path.join(packageRoot, 'node_modules', ...target.dependency.split('/')),
    path.join(canonicalNpmRoot, ...target.dependency.split('/'))
  ];
  let lastFailure = null;
  let informativeFailure = null;
  for (const nativeRoot of nativeRoots) {
    try {
      const nativeManifest = readManifest(fsImpl, canonicalNpmRoot, path.join(nativeRoot, 'package.json'), 'native package manifest');
      if (nativeManifest.name !== CODEX_PACKAGE || nativeManifest.version !== `${version}-${target.packageSuffix}`
          || !Array.isArray(nativeManifest.os) || !nativeManifest.os.includes('win32')
          || !Array.isArray(nativeManifest.cpu) || !nativeManifest.cpu.includes(arch)) {
        fail('CODEX_NATIVE_PAIR_DEPENDENCY_MISMATCH', 'The Codex native package metadata does not match the stable package version and platform.');
      }
      const vendorRoot = path.join(nativeRoot, 'vendor', target.target);
      const layout = readManifest(fsImpl, canonicalNpmRoot, path.join(vendorRoot, 'codex-package.json'), 'native layout manifest');
      if (layout.layoutVersion !== 1 || layout.version !== version || layout.target !== target.target || layout.variant !== 'codex') {
        fail('CODEX_NATIVE_PAIR_LAYOUT_MISMATCH', 'The Codex native layout metadata does not match the stable package.');
      }
      safeRelative(layout.entrypoint, 'bin/codex.exe', 'entrypoint');
      safeRelative(layout.resourcesDir, 'codex-resources', 'resources directory');
      const command = regularFile(fsImpl, canonicalNpmRoot, path.join(vendorRoot, 'bin', 'codex.exe'), 'native executable', { pe: true });
      const commandRunner = regularFile(fsImpl, canonicalNpmRoot,
        path.join(vendorRoot, 'codex-resources', 'codex-command-runner.exe'), 'command runner', { pe: true });
      const sandboxSetup = regularFile(fsImpl, canonicalNpmRoot,
        path.join(vendorRoot, 'codex-resources', 'codex-windows-sandbox-setup.exe'), 'sandbox setup helper', { pe: true });
      verifySignaturesImpl([command, commandRunner, sandboxSetup], {
        environment,
        fsImpl,
        spawnSyncImpl
      });
      let probe;
      try {
        probe = spawnSyncImpl(command, ['--version'], {
          cwd: vendorRoot,
          env: environment,
          windowsHide: true,
          shell: false,
          encoding: 'utf8',
          timeout: versionProbeTimeoutMs,
          maxBuffer: 64 * 1024
        });
      } catch (error) {
        lookupFailed(error, 'Codex native executable version');
      }
      const versionMatch = VERSION_OUTPUT_RE.exec(String(probe?.stdout || '').trim());
      if (probe?.error || probe?.signal) lookupFailed(probe.error || { code: `SIGNAL_${probe.signal}` }, 'Codex native executable version');
      if (probe?.status !== 0 || !versionMatch || versionMatch[1] !== version) {
        fail('CODEX_NATIVE_PAIR_VERSION_MISMATCH', 'The Codex native executable did not report the stable package version.');
      }
      return Object.freeze({
        command,
        prefixArgs: Object.freeze([]),
        commandRunner,
        sandboxSetup,
        version,
        target: target.target,
        packageRoot: realpath(fsImpl, packageRoot)
      });
    } catch (error) {
      if (!(error instanceof MissionCodexNativePairError)) lookupFailed(error, 'Codex native package');
      lastFailure = error;
      if (error?.code !== 'CODEX_NATIVE_PAIR_FILE_MISSING') informativeFailure = informativeFailure || error;
    }
  }
  throw informativeFailure || lastFailure
    || new MissionCodexNativePairError('CODEX_NATIVE_PAIR_FILE_MISSING', 'The stable Codex native package is missing.');
}

function resolveMissionCodexNativePair({
  platform = process.platform,
  arch = process.arch,
  environment = process.env,
  npmRoots,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
  verifySignaturesImpl = verifyAuthenticode,
  fencePathImpl = accountBoundary.assertAccountProfilePath,
  profileRoot = accountBoundary.installationProfileRoot(),
  versionProbeTimeoutMs = VERSION_PROBE_TIMEOUT_MS
} = {}) {
  if (platform !== 'win32') {
    fail('CODEX_NATIVE_PAIR_PLATFORM_UNSUPPORTED', 'The mission Codex native-pair resolver is Windows-only.');
  }
  const roots = npmRoots === undefined ? defaultNpmRoots({ environment }) : npmRoots;
  if (!Array.isArray(roots)) fail('CODEX_NATIVE_PAIR_INVALID', 'npmRoots must be an array when supplied.');
  const candidates = [];
  const rejected = [];
  let indeterminateFailure = null;
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) {
      rejected.push('CODEX_NATIVE_PAIR_NPM_ROOT_INVALID');
      continue;
    }
    let fencedRoot;
    try {
      // Apply the lexical foreign-profile refusal before inspectNpmRoot can
      // lstat or read a candidate inherited from PATH/Module.globalPaths.
      fencedRoot = fencePathImpl(path.resolve(root), {
        field: 'mission Codex npm root',
        profileRoot
      });
    } catch (error) {
      rejected.push(typeof error?.code === 'string' ? error.code : 'CODEX_NATIVE_PAIR_NPM_ROOT_REFUSED');
      continue;
    }
    try {
      candidates.push(inspectNpmRoot(fencedRoot, {
        arch, environment, fsImpl, spawnSyncImpl, versionProbeTimeoutMs, verifySignaturesImpl
      }));
    } catch (error) {
      if (!(error instanceof MissionCodexNativePairError)) lookupFailed(error, 'Codex npm root');
      if (error?.code === 'CODEX_NATIVE_PAIR_LOOKUP_INDETERMINATE') {
        indeterminateFailure = indeterminateFailure || error;
        continue;
      }
      rejected.push(typeof error?.code === 'string' ? error.code : 'CODEX_NATIVE_PAIR_INVALID');
    }
  }
  if (candidates.length === 0) {
    if (indeterminateFailure) throw indeterminateFailure;
    fail('CODEX_NATIVE_PAIR_UNAVAILABLE', 'No valid installed stable npm Codex native executable and matched command runner are available.', {
      rejected: Object.freeze([...new Set(rejected)].slice(0, 16))
    });
  }
  candidates.sort((left, right) => compareStableVersions(right.version, left.version)
    || left.command.localeCompare(right.command));
  return candidates[0];
}

module.exports = Object.freeze({
  AUTHENTICODE_TIMEOUT_MS,
  CODEX_PACKAGE,
  EXPECTED_SIGNER,
  MAX_MANIFEST_BYTES,
  MissionCodexNativePairError,
  STABLE_VERSION_RE,
  VERSION_PROBE_TIMEOUT_MS,
  WINDOWS_TARGETS,
  compareStableVersions,
  defaultNpmRoots,
  resolveMissionCodexNativePair,
  verifyAuthenticode
});
