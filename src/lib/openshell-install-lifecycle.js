'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');
const { assertUninstallPrefixSafe } = require('./openshell-uninstall-path-safety');

function installedManifest(binDir) {
  const prefix = path.resolve(binDir, '../../..');
  const manifestPath = path.join(prefix, 'manifest.json');
  let manifest;
  try {
    if (fs.lstatSync(prefix).isSymbolicLink()) throw new Error('linked prefix');
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== 'toolsenabled-openshell' || !/^[a-f0-9]{40}$/.test(manifest.source_commit)
      || typeof manifest.version !== 'string' || !fs.statSync(path.join(prefix, 'bin/toolsenabled')).isFile()
      || !fs.statSync(path.join(prefix, 'runtime/engine/bin/toolsenabled-openshell.js')).isFile()) {
      throw new Error('invalid install');
    }
  } catch {
    throw new Error('This command needs an installed ToolsEnabled Fleet for OpenShell runtime.');
  }
  return { prefix, manifest };
}

function version(binDir) {
  const { manifest } = installedManifest(binDir);
  return `ToolsEnabled Fleet ${manifest.version} (${manifest.source_commit})`;
}

async function confirmStateDeletion(paths) {
  if (paths.length === 0) return false;
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await input.question(`Delete ToolsEnabled Fleet state at ${paths.join(' and ')}? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    input.close();
  }
}

// Resolve existing ancestors even when the selected root is not created yet.
// A lexical prefix comparison misses aliases such as /home/link/state where
// link points inside the runtime that uninstall is about to remove.
function canonicalPath(candidate) {
  let ancestor = candidate;
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(ancestor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

function safeStatePath(candidate, prefix) {
  if (!path.isAbsolute(candidate)) throw new Error(`State path must be absolute: ${candidate}`);
  const chosen = path.resolve(candidate);
  const home = path.resolve(os.homedir());
  try { if (fs.lstatSync(chosen).isSymbolicLink()) throw new Error(`State path is a link: ${chosen}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const canonical = canonicalPath(chosen);
  if ([path.parse(chosen).root, home].includes(chosen)
    || [path.parse(canonical).root, canonicalPath(home)].includes(canonical)
    || overlaps(chosen, prefix) || overlaps(canonical, canonicalPath(prefix))) {
    throw new Error(`State path overlaps a protected path; the runtime and state were kept: ${chosen}`);
  }
  return chosen;
}

async function uninstall(binDir, { keepState = false, archive, sha256 } = {}) {
  if (process.platform !== 'linux' || process.env.OPENSHELL_SANDBOX !== '1') throw new Error('Run uninstall inside your Linux OpenShell sandbox.');
  const pins = [];
  if (archive !== undefined || sha256 !== undefined) {
    if (typeof archive !== 'string' || !path.isAbsolute(archive) || /[\x00-\x1f\x7f]/.test(archive)
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw Object.assign(new Error('INTEGRITY: an absolute archive and independently published SHA-256 must be supplied together.'), { code: 'INTEGRITY' });
    }
    pins.push('--archive', archive, '--sha256', sha256);
  }
  const { prefix } = installedManifest(binDir);
  assertUninstallPrefixSafe(prefix);
  const stateRoot = safeStatePath(process.env.TOOLSENABLED_STATE_ROOT || path.join(os.homedir(), '.toolsenabled'), prefix);
  const servicesRoot = require('./setup/machine-record').resolveServicesRoot({});
  const selectedStatePaths = [...new Set([stateRoot, servicesRoot].filter(Boolean).map((item) => safeStatePath(item, prefix)))];
  const statePaths = selectedStatePaths.filter((item) => fs.existsSync(item));
  if (!keepState && await confirmStateDeletion(statePaths)) {
    // Neither manual installs nor setup currently establish exclusive ownership
    // of these directories. A user's yes and a plausible basename cannot make
    // arbitrary shared data safe to recursively delete. Refuse before removing
    // registrations or runtime; a future ownership protocol is separate work.
    throw Object.assign(new Error('Exclusive ownership of the selected state directories is unproven; registrations, runtime and state were kept. Use uninstall --keep-state to retain state.'),
      { code: 'STATE_OWNERSHIP_UNPROVEN' });
  }

  // The Python driver owns the inventory, journal and retained directory handles
  // across both provider calls and deletion. JavaScript never deletes the tree.
  const lock = require('./openshell-lifecycle-lock');
  lock.check();
  const fd = Number(process.env.TOOLSENABLED_FLEET_LOCK_FD);
  const driver = path.join(binDir, '../libexec/fleet_uninstall.py');
  const result = spawnSync('/usr/bin/python3', ['-B', driver, '--prefix', prefix, '--keep-state', ...pins], {
    env: { ...process.env, TOOLSENABLED_FLEET_LOCK_FD: '3' }, stdio: ['inherit', 'inherit', 'inherit', fd],
    windowsHide: true
  });
  if (result.error || result.signal || !Number.isInteger(result.status)) {
    throw Object.assign(new Error('OUTCOME_UNCERTAIN: uninstall did not settle; retain the runtime, archive and reported recovery evidence.'),
      { code: 'OUTCOME_UNCERTAIN' });
  }
  return result.status;
}

function parseUninstallArgs(argv) {
  const options = {}, seen = new Set();
  const usage = () => { throw new Error('Use: toolsenabled uninstall [--keep-state] [--archive ABSOLUTE_ARCHIVE --sha256 RELEASE_SHA256].'); };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) usage();
    seen.add(flag);
    if (flag === '--keep-state') options.keepState = true;
    else if (flag === '--archive' || flag === '--sha256') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) usage();
      options[flag === '--archive' ? 'archive' : 'sha256'] = value;
    } else usage();
  }
  if ((options.archive === undefined) !== (options.sha256 === undefined)) usage();
  return options;
}

module.exports = Object.freeze({ installedManifest, version, uninstall, parseUninstallArgs });
