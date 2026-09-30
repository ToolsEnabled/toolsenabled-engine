'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function unsafe(reason) {
  // Never print profile paths, database URLs, config contents or TLS material.
  return Object.assign(new Error(`Uninstall path safety could not be established (${reason}); the runtime was kept.`),
    { code: 'UNINSTALL_PATH_UNSAFE' });
}

function absolute(candidate) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || !path.isAbsolute(candidate)
    || candidate.split(path.sep).some(component => component === '.' || component === '..')) {
    throw unsafe('invalid protected path');
  }
  // Normalizing '..' before resolving a symlink can hide a protected target.
  // Refuse that spelling instead of claiming a lexical path is its target.
  return path.resolve(candidate);
}

// A not-yet-created profile still has a target through its existing ancestors.
// Broken links, inaccessible paths and non-directory ancestors are unknown.
function canonical(candidate) {
  let ancestor = candidate;
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(ancestor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw unsafe('unresolved filesystem path');
      try {
        fs.lstatSync(ancestor);
        throw unsafe('unresolved filesystem link');
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw unsafe('unresolved filesystem path');
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw unsafe('unresolved filesystem root');
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function within(candidate, prefix) {
  const relative = path.relative(prefix, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function protectedPaths(env, homes) {
  const roots = new Set(['/etc/openshell']);
  for (const home of homes) {
    const resolved = absolute(home);
    roots.add(resolved);
    for (const relative of ['.codex', '.claude', '.claude.json', '.config/openshell',
      '.local/state/openshell', '.local/share/openshell']) roots.add(path.join(resolved, relative));
  }
  for (const name of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENSHELL_SYSTEM_GATEWAY_DIR',
    'OPENSHELL_LOCAL_TLS_DIR', 'OPENSHELL_GATEWAY_CONFIG', 'OPENSHELL_TLS_CERT', 'OPENSHELL_TLS_KEY',
    'OPENSHELL_TLS_CLIENT_CA']) {
    if (env[name] !== undefined) roots.add(absolute(env[name]));
  }
  for (const name of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) {
    if (env[name] !== undefined) roots.add(path.join(absolute(env[name]), 'openshell'));
  }
  if (env.OPENSHELL_DB_URL !== undefined) {
    // Upstream's local default is sqlite:/absolute/path. Refuse ambiguous URL
    // encodings, relative paths and other forms instead of overlooking state.
    const match = /^sqlite:(\/(?!\/)[^?#%\0]+)$/.exec(env.OPENSHELL_DB_URL);
    if (!match) throw unsafe('unqualified gateway database location');
    roots.add(absolute(match[1]));
  }
  return roots;
}

function decodeMountPath(encoded) {
  if (/\\(?!040|011|012|134)/.test(encoded)) throw unsafe('malformed mount escapes');
  const decoded = encoded.replace(/\\(040|011|012|134)/g, (_, value) =>
    ({ '040': ' ', '011': '\t', '012': '\n', '134': '\\' })[value]);
  return absolute(decoded);
}

function mountPaths(text) {
  if (typeof text !== 'string' || !text || text.length > 16 * 1024 * 1024 || !text.endsWith('\n') || text.includes('\0')) {
    throw unsafe('unavailable or incomplete mount inventory');
  }
  const mounts = [];
  for (const line of text.slice(0, -1).split('\n')) {
    const halves = line.split(' - ');
    if (halves.length !== 2) throw unsafe('malformed mount inventory');
    const before = halves[0].split(' ');
    const after = halves[1].split(' ');
    if (before.length < 6 || after.length !== 3 || [...before, ...after].some(field => !field || /[\t\r]/.test(field))
      || !/^\d+$/.test(before[0]) || !/^\d+$/.test(before[1]) || !/^\d+:\d+$/.test(before[2])) {
      throw unsafe('malformed mount inventory');
    }
    decodeMountPath(before[3]); // The filesystem root is also an escaped absolute path.
    mounts.push(decodeMountPath(before[4]));
  }
  return mounts;
}

function assertUninstallPrefixSafe(prefix, {
  env = process.env, userHome = os.userInfo().homedir, home = os.homedir(),
  readMountInfo = () => fs.readFileSync('/proc/self/mountinfo', 'utf8')
} = {}) {
  const selected = absolute(prefix);
  const resolved = canonical(selected);
  const insidePrefix = candidate => within(candidate, selected) || within(candidate, resolved)
    || within(canonical(candidate), selected) || within(canonical(candidate), resolved);
  for (const protectedPath of protectedPaths(env, [userHome, home])) {
    if (insidePrefix(protectedPath)) {
      throw unsafe('protected profile, home or OpenShell path within runtime');
    }
  }
  let inventory;
  try { inventory = readMountInfo(); }
  catch { throw unsafe('mount inventory unreadable'); }
  for (const mountedPath of mountPaths(inventory)) {
    if (insidePrefix(mountedPath)) {
      throw unsafe('mounted filesystem within runtime');
    }
  }
  // These are conservative observations, not descriptor-bound traversal or an
  // ownership proof. Call again after external CLI work, just before removal.
}

module.exports = Object.freeze({ assertUninstallPrefixSafe });
