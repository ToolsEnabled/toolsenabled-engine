'use strict';

// Test-only source custody. The production registry reader stays engine-local.
// Root/ref/index/materialization checks follow tools/qa/task-assignment-paired.cjs
// in the application; this audit consumes its own explicit descriptor.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SELECTORS = {
  app: ['IMAGE_APP_ROOT', 'TOOLSENABLED_TEST_APP_ROOT', 'T1139_B6_APP_ROOT'],
  engine: ['IMAGE_ENGINE_ROOT', 'T1630_ENGINE_ROOT', 'TOOLSENABLED_TEST_ENGINE_ROOT', 'MC_CANONICAL_ROOT']
};
const fail = message => { throw new Error(`Settings source pair refused: ${message}`); };
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function selectorMatchesRoot(value, root) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) return false;
  const resolved = path.resolve(value);
  if (!same(resolved, root)) return false;
  try { return same(fs.realpathSync.native(resolved), resolved); } catch { return false; }
}

function ordinaryRoot(root, label) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || /[\x00-\x1f]/.test(root)) {
    fail(`${label} must be an ordinary absolute root`);
  }
  let real;
  try { real = fs.realpathSync.native(root); } catch { fail(`${label} root is missing or unreadable`); }
  if (!same(real, root) || !fs.lstatSync(root).isDirectory()) fail(`${label} root is an alias or not a directory`);
  return root;
}

function git(root, args, encoding = 'utf8') {
  const windows = process.platform === 'win32';
  const empty = windows ? 'NUL' : '/dev/null';
  return execFileSync(windows ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git',
    ['--no-replace-objects', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false', '-c', 'core.pager=', '-c', 'diff.external=',
      '-c', `core.attributesFile=${empty}`, '-c', `core.excludesFile=${empty}`,
      '-c', 'core.ignoreStat=false', '-c', 'core.trustctime=true', '-C', root, ...args],
    { encoding, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: windows ? 'C:\\Windows\\System32' : '/nonexistent', LANG: 'C', LC_ALL: 'C',
        GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' } });
}

function regularBytes(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || path.posix.normalize(relative) !== relative
      || relative.startsWith('../') || path.posix.isAbsolute(relative) || /[\x00-\x1f]/.test(relative)) fail('invalid source path');
  let cursor = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      fail(`source is not an ordinary file: ${relative}`);
    }
  }
  return fs.readFileSync(cursor);
}

function blobId(bytes) {
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function repository(root, ref, label) {
  ordinaryRoot(root, label);
  if (!same(git(root, ['rev-parse', '--show-toplevel']).trim(), root)) fail(`${label} Git root differs`);
  if (git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== ref) fail(`${label} HEAD differs from pinned ref`);
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none']).trim()) fail(`${label} tracked source is dirty`);
  const tree = new Map(git(root, ['ls-tree', '-r', '--full-tree', '-z', ref]).split('\0').filter(Boolean).map(line => {
    const row = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    return row ? [row[3], { mode: row[1], blob: row[2] }] : [line, null];
  }));
  const flags = new Map(git(root, ['ls-files', '-v', '-z']).split('\0').filter(Boolean).map(line => [line.slice(2), line[0]]));
  if ([...flags.values()].some(flag => /[a-z]/.test(flag))) fail(`${label} contains assume-unchanged source`);
  const rows = git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  for (const line of rows) {
    const row = /^(\d+) ([a-f0-9]{40}) (\d+)\t(.+)$/.exec(line);
    if (!row || row[3] !== '0') fail(`${label} has an unresolved index stage`);
    const expected = tree.get(row[4]);
    if (!expected || expected.mode !== row[1] || expected.blob !== row[2]) fail(`${label} index differs from pinned ref`);
    let bytes;
    try { bytes = regularBytes(root, row[4]); }
    catch (error) {
      if (error.code === 'ENOENT' && flags.get(row[4]) === 'S') continue;
      throw error;
    }
    if (blobId(bytes) !== row[2]) fail(`${label} materialized bytes differ: ${row[4]}`);
  }
  if (rows.length !== tree.size) fail(`${label} index omits pinned paths`);
  return { root, ref, tree };
}

function pinnedBytes(repo, relative) {
  const expected = repo.tree.get(relative);
  if (!expected || !['100644', '100755'].includes(expected.mode)) fail(`no ordinary pinned source: ${relative}`);
  const bytes = regularBytes(repo.root, relative);
  if (blobId(bytes) !== expected.blob) fail(`source changed after binding: ${relative}`);
  return bytes;
}

function executableSource(relative) {
  return /^(?:src|shell|tools|packages|adapters|sidecars|bin|scripts)\//.test(relative)
    && /\.(?:js|mjs|cjs|ps1)$/.test(relative)
    && !relative.split('/').some(part => /^(?:tests?|fixtures?|evidence|reports|node_modules|release|builds?|dist|coverage|scratch|state)$/.test(part))
    && !/\.(?:test|spec)\.[^.]+$/.test(relative);
}

function validateSettingsSourcePair(descriptor, { expectedEngineRoot, env = process.env } = {}) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
      || Object.keys(descriptor).sort().join(',') !== 'appRef,appRoot,engineRef,engineRoot'
      || !/^[a-f0-9]{40}$/.test(descriptor.appRef) || !/^[a-f0-9]{40}$/.test(descriptor.engineRef)) {
    fail('one complete appRoot/appRef/engineRoot/engineRef descriptor is required');
  }
  if (typeof expectedEngineRoot !== 'string' || !same(descriptor.engineRoot, expectedEngineRoot)) fail('foreign engine root for this audit');
  if (same(descriptor.appRoot, descriptor.engineRoot)) fail('app and engine roots must be distinct');
  for (const [kind, names] of Object.entries(SELECTORS)) {
    for (const name of names) if (env[name] !== undefined && !selectorMatchesRoot(env[name], descriptor[`${kind}Root`])) fail(`foreign ambient selector ${name}`);
  }
  const app = repository(descriptor.appRoot, descriptor.appRef, 'app');
  const engine = repository(descriptor.engineRoot, descriptor.engineRef, 'engine');
  pinnedBytes(app, 'shell/product-settings.cjs');
  pinnedBytes(app, 'shell/tree-slot-policy.mjs');
  pinnedBytes(engine, 'src/lib/settings-registry.js');
  const readSource = relative => {
    const repo = relative.startsWith('shell/') ? app : engine;
    try {
      if (relative === 'config/settings-registry.json') fail('catalogue prose cannot attest its own enforcer');
      return { ok: true, text: pinnedBytes(repo, relative).toString('utf8'), root: repo.root };
    }
    catch (error) { return { ok: false, reason: error.code || error.message }; }
  };
  const sourceBodies = () => [app, engine].flatMap(repo => [...repo.tree.keys()].filter(executableSource).sort().map(relative => ({
    root: repo.root, relative, text: pinnedBytes(repo, relative).toString('utf8')
  })));
  return Object.freeze({ app: Object.freeze({ root: app.root, ref: app.ref }),
    engine: Object.freeze({ root: engine.root, ref: engine.ref }), readSource, sourceBodies });
}

function readSettingsSourcePair(descriptorPath, options) {
  if (typeof descriptorPath !== 'string' || !path.isAbsolute(descriptorPath)) fail('explicit descriptor path is required');
  const bytes = regularBytes(path.parse(descriptorPath).root, path.relative(path.parse(descriptorPath).root, descriptorPath).split(path.sep).join('/'));
  return validateSettingsSourcePair(JSON.parse(bytes), options);
}

module.exports = { validateSettingsSourcePair, readSettingsSourcePair };
