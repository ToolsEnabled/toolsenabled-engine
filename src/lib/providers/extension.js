'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, ensureDir, commandExists, run } = require('../runtime');
const { assertActive } = require('../policy');
// logs/ is per-user runtime data; installed it is not the program directory.
// See src/lib/runtime-state-root.js.
const { statePath } = require('../runtime-state-root');
const { record } = require('../audit');

const IGNORED_SCAN_DIRECTORIES = new Set(['.git', 'node_modules']);

// GNU tar does not produce ZIP archives. Linux uses the system Python already
// required by the native vault, with isolated imports and no shell. fwalk and
// O_NOFOLLOW keep source file opens tied to the walked directory descriptor.
const LINUX_ZIP_SCRIPT = String.raw`
import os, shutil, stat, sys, zipfile
source, destination = sys.argv[1:]
owned = None
try:
    with open(destination, 'xb') as output:
        owned = os.fstat(output.fileno())
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for directory, dirs, files, directory_fd in os.fwalk(source, follow_symlinks=False):
                dirs[:] = sorted(name for name in dirs if name not in ('.git', 'node_modules'))
                for name in dirs:
                    if not stat.S_ISDIR(os.stat(name, dir_fd=directory_fd, follow_symlinks=False).st_mode):
                        raise ValueError('A source directory became a symbolic link.')
                for name in sorted(files):
                    if name in ('.git', 'node_modules') or name.lower().endswith('.map'):
                        continue
                    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                    with os.fdopen(descriptor, 'rb') as content:
                        before = os.fstat(content.fileno())
                        if not stat.S_ISREG(before.st_mode):
                            raise ValueError('A package entry is not a regular file.')
                        relative = os.path.relpath(os.path.join(directory, name), source)
                        entry = zipfile.ZipInfo(relative)
                        entry.file_size = before.st_size
                        entry.compress_type = zipfile.ZIP_DEFLATED
                        with archive.open(entry, 'w') as target:
                            shutil.copyfileobj(content, target, 128 * 1024)
                        after = os.fstat(content.fileno())
                        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                            raise ValueError('A source file changed during packaging.')
        output.flush()
        os.fsync(output.fileno())
except BaseException:
    if owned is not None:
        try:
            current = os.stat(destination, follow_symlinks=False)
            if (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
                os.unlink(destination)
        except FileNotFoundError:
            pass
    raise
`;

function validVersion(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return parts.length >= 1 && parts.length <= 4
    && parts.every(part => /^(?:0|[1-9]\d*)$/.test(part) && Number(part) <= 65535)
    && parts.some(part => Number(part) !== 0);
}

function referencedFile(target, candidate, label, errors) {
  if (typeof candidate !== 'string' || !candidate) { errors.push(`${label} must be a non-empty relative file path.`); return; }
  const normalized = candidate.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    errors.push(`${label} must stay inside the extension directory: ${candidate}`);
    return;
  }
  const resolved = path.resolve(target, normalized);
  const relative = path.relative(target, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    errors.push(`${label} must reference a file inside the extension directory: ${candidate}`);
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) errors.push(`${label} does not exist: ${candidate}`);
}

function manifestReferences(manifest) {
  const references = [];
  const add = (value, label) => { if (value !== undefined) references.push([value, label]); };
  const icons = manifest.icons && typeof manifest.icons === 'object' && !Array.isArray(manifest.icons) ? manifest.icons : {};
  for (const [size, icon] of Object.entries(icons)) add(icon, `manifest.icons.${size}`);
  const actionIcon = manifest.action && manifest.action.default_icon;
  if (typeof actionIcon === 'string') add(actionIcon, 'manifest.action.default_icon');
  else for (const [size, icon] of Object.entries(actionIcon || {})) add(icon, `manifest.action.default_icon.${size}`);
  add(manifest.action && manifest.action.default_popup, 'manifest.action.default_popup');
  add(manifest.background && manifest.background.service_worker, 'manifest.background.service_worker');
  add(manifest.options_page, 'manifest.options_page');
  add(manifest.options_ui && manifest.options_ui.page, 'manifest.options_ui.page');
  add(manifest.side_panel && manifest.side_panel.default_path, 'manifest.side_panel.default_path');
  add(manifest.devtools_page, 'manifest.devtools_page');
  for (const [name, file] of Object.entries(manifest.chrome_url_overrides || {})) add(file, `manifest.chrome_url_overrides.${name}`);
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  for (const [index, entry] of contentScripts.entries()) {
    const scripts = entry && Array.isArray(entry.js) ? entry.js : [];
    const styles = entry && Array.isArray(entry.css) ? entry.css : [];
    for (const [scriptIndex, file] of scripts.entries()) add(file, `manifest.content_scripts[${index}].js[${scriptIndex}]`);
    for (const [styleIndex, file] of styles.entries()) add(file, `manifest.content_scripts[${index}].css[${styleIndex}]`);
  }
  const rules = manifest.declarative_net_request && Array.isArray(manifest.declarative_net_request.rule_resources)
    ? manifest.declarative_net_request.rule_resources : [];
  for (const [index, entry] of rules.entries()) {
    add(entry.path, `manifest.declarative_net_request.rule_resources[${index}].path`);
  }
  const sandboxPages = manifest.sandbox && Array.isArray(manifest.sandbox.pages) ? manifest.sandbox.pages : [];
  for (const [index, file] of sandboxPages.entries()) add(file, `manifest.sandbox.pages[${index}]`);
  return references;
}

function findUnsafeEntry(target, relative = '') {
  const folder = path.join(target, relative);
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (IGNORED_SCAN_DIRECTORIES.has(entry.name)) continue;
    const childRelative = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) return { path: childRelative, reason: 'symbolic links are not allowed in extension packages' };
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() === 'vault') return { path: childRelative, reason: 'vault directories are not allowed in extension packages' };
      const nested = findUnsafeEntry(target, childRelative);
      if (nested) return nested;
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example')
      || /^(?:secrets?|credentials?)\.json$/i.test(entry.name) || /\.(?:pem|key|p12|pfx)$/i.test(entry.name)) {
      return { path: childRelative, reason: 'credential-like files are not allowed in extension packages' };
    }
  }
  return null;
}

function projectDir(cwd) {
  const target = path.resolve(cwd || ROOT);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`Extension directory does not exist: ${target}`);
  return target;
}

function manifestFor(cwd) {
  const target = projectDir(cwd);
  const manifestPath = path.join(target, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    // Measured on the 2026-08-19 sweep: extension.validate and
    // extension.package both surfaced this sentence with no machine code.
    const error = new Error(`manifest.json was not found in ${target}`);
    error.code = 'EXTENSION_MANIFEST_NOT_FOUND';
    throw error;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest root must be a JSON object');
    return { cwd: target, manifestPath, manifest };
  }
  catch (error) { throw new Error(`Unable to parse ${manifestPath}: ${error.message}`); }
}

function validation({ cwd = ROOT }) {
  const { manifest, manifestPath, cwd: target } = manifestFor(cwd);
  const errors = []; const warnings = [];
  if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3 for new Chrome Web Store submissions.');
  for (const field of ['name', 'version', 'description']) if (typeof manifest[field] !== 'string' || !manifest[field].trim()) errors.push(`manifest.${field} must be a non-empty string.`);
  if (typeof manifest.name === 'string' && manifest.name.length > 75) errors.push('manifest.name must be at most 75 characters.');
  if (typeof manifest.description === 'string' && manifest.description.length > 132) errors.push('manifest.description must be at most 132 characters.');
  if (!validVersion(manifest.version)) errors.push('manifest.version must contain 1-4 integers from 0-65535, without leading zeros, and cannot be all zero.');
  if (!manifest.icons || typeof manifest.icons !== 'object' || Array.isArray(manifest.icons) || !Object.keys(manifest.icons).length) errors.push('manifest.icons must contain at least one store icon.');
  for (const [file, label] of manifestReferences(manifest)) referencedFile(target, file, label, errors);
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (permissions.includes('<all_urls>') || (Array.isArray(manifest.host_permissions) && manifest.host_permissions.includes('<all_urls>'))) warnings.push('The extension requests <all_urls>; Chrome Web Store review may require a strong justification.');
  return { valid: errors.length === 0, cwd: target, manifestPath, manifest: { name: manifest.name, version: manifest.version, manifestVersion: manifest.manifest_version }, errors, warnings };
}

function packageExtension({ cwd = ROOT, outputPath = '' }) {
  assertActive('extension.package');
  const checked = validation({ cwd });
  if (!checked.valid) throw new Error(`Extension validation failed: ${checked.errors.join(' ')}`);
  const packager = process.platform === 'linux' ? '/usr/bin/python3' : 'tar.exe';
  if (!commandExists(packager)) {
    throw Object.assign(new Error(process.platform === 'linux'
      ? 'System Python 3 is required to package an extension on Linux.'
      : 'Windows tar.exe is required to package an extension.'), { code: 'EXTENSION_PACKAGER_UNAVAILABLE' });
  }
  const destination = outputPath ? path.resolve(outputPath) : statePath('logs', 'packages', `${path.basename(checked.cwd)}-${checked.manifest.version}-${Date.now()}.zip`);
  if (path.extname(destination).toLowerCase() !== '.zip') throw new Error('outputPath must end in .zip.');
  const relativeDestination = path.relative(checked.cwd, destination);
  if (relativeDestination && !relativeDestination.startsWith('..') && !path.isAbsolute(relativeDestination)) {
    throw new Error('outputPath must be outside the extension source directory.');
  }
  const unsafe = findUnsafeEntry(checked.cwd);
  if (unsafe) throw new Error(`Refusing to package '${unsafe.path}': ${unsafe.reason}.`);
  ensureDir(path.dirname(destination));
  if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite an existing extension package: ${destination}`);
  const entries = fs.readdirSync(checked.cwd, { withFileTypes: true })
    .filter(entry => !IGNORED_SCAN_DIRECTORIES.has(entry.name))
    .filter(entry => !(entry.isFile() && entry.name.toLowerCase().endsWith('.map')))
    .map(entry => entry.name)
    .sort();
  const packagerArguments = process.platform === 'linux'
    ? ['-I', '-c', LINUX_ZIP_SCRIPT, checked.cwd, destination]
    : [
    '-a', '-c', '-f', path.basename(destination),
    '--exclude=.git', '--exclude=node_modules', '--exclude=*.map',
    '-C', checked.cwd, '--', ...entries
  ];
  const result = run(packager, packagerArguments, { cwd: path.dirname(destination), timeout: 10 * 60 * 1000 });
  if (result.status !== 0 || !fs.existsSync(destination)) throw new Error(result.stderr || result.stdout || 'Extension packaging failed.');
  const bytes = fs.statSync(destination).size;
  record('extension.package', destination, { cwd: checked.cwd, bytes, warnings: checked.warnings });
  return { ...checked, packagePath: destination, bytes };
}

module.exports = { findUnsafeEntry, manifestReferences, packageExtension, validVersion, validation };
