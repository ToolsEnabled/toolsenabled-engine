#!/usr/bin/env node
'use strict';

// Finds a Node interpreter with a WORKING node:sqlite DatabaseSync.isOpen,
// then execs the requested script under it.
//
// WHY THIS EXISTS. .claude/settings.json hook commands used to hardcode
// "C:\agent-apps\node-v22.19.0\node.exe" -- an absolute, machine-specific
// path that exists on exactly one computer. On any other machine the hook
// either fails outright (path not found) or someone "fixes" it by switching
// to bare `node`, which resolves whatever happens to be first on that
// machine's PATH and can silently be too old: node:sqlite's DatabaseSync
// did not expose `.isOpen` before Node 22.19.0, and src/lib/state-store.js
// depends on it (_open -> _migrate -> transaction -> _open recurses forever
// without it, which reads like database corruption, not a runtime
// mismatch -- see src/lib/audit-store.js databaseIsOpen() and the
// dashboard-task.ps1 / ServerControl.Common.ps1 header comments for the
// same landmine hit twice already). Neither a fixed absolute path nor bare
// `node` is portable; this script resolves the REQUIREMENT (a Node with a
// working node:sqlite DatabaseSync.isOpen) on whatever machine it runs on,
// and refuses loudly -- never silently -- when no such interpreter exists.
//
// USAGE
//   node tools/resolve-node.js <script.js> [...args]
//   Resolves a qualifying interpreter, spawns it as
//   `<qualifying-node> <script.js> [...args]` with inherited stdio, and
//   exits with that child's exit code. This script's OWN interpreter does
//   not need to qualify -- it never touches node:sqlite itself, only
//   inspects candidates in child processes -- so bare `node` on PATH can
//   safely invoke it even when that PATH node is the very interpreter that
//   does not qualify.
//
// CANDIDATE SEARCH ORDER (first qualifying candidate wins)
//   1. TOOLSENABLED_NODE env var, if set -- an explicit operator override,
//      following the same TOOLSENABLED_* precedence convention used
//      elsewhere in this repo (e.g. TOOLSENABLED_SOURCE in
//      tools/pack-capability-layer.mjs). If set but it does NOT qualify,
//      that is a hard failure, not a silent fall-through to autodetection:
//      an operator who named a specific interpreter should be told it was
//      wrong, not have that instruction quietly ignored.
//   2. Common fixed install locations, including the previously-hardcoded
//      C:\agent-apps\node-v22.19.0\node.exe -- now one candidate among
//      several rather than the only path that exists.
//   3. Every `node`/`node.exe` found by walking PATH.
//
// Every candidate is checked for real: --version is parsed, AND a
// subprocess of that exact candidate is asked to open a node:sqlite
// DatabaseSync and read .isOpen. A version number alone is a proxy, not
// proof; this checks the actual capability the rest of the tree depends on.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const MIN_VERSION = Object.freeze([22, 19, 0]);
const OVERRIDE_ENV_VAR = 'TOOLSENABLED_NODE';
const PROBE_TIMEOUT_MS = 3000;

// Never require('node:sqlite') in THIS process -- this script's own host
// interpreter is not guaranteed to qualify. Every capability check below
// runs inside a spawned subprocess of the CANDIDATE being tested instead.
const SQLITE_PROBE_SCRIPT =
  'try{const{DatabaseSync}=require("node:sqlite");' +
  'const db=new DatabaseSync(":memory:");' +
  'const ok=typeof db.isOpen==="boolean"&&db.isOpen===true;' +
  'db.close();process.exit(ok?0:1);' +
  '}catch(e){process.stderr.write(String((e&&e.message)||e));process.exit(1);}';

function exeName(platform) {
  return platform === 'win32' ? 'node.exe' : 'node';
}

function parseVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionAtLeast(version, min) {
  for (let i = 0; i < min.length; i++) {
    const a = version[i] || 0;
    const b = min[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

/**
 * Check whether one candidate path is a Node interpreter with a working
 * node:sqlite DatabaseSync.isOpen. Every filesystem/process operation is
 * injectable so this can be unit-tested against a simulated machine (real
 * or empty) without touching this machine's actual installed binaries.
 */
function probeCandidate(candidatePath, { exists = fs.existsSync, statSync = fs.statSync, run = spawnSync } = {}) {
  if (typeof candidatePath !== 'string' || candidatePath.trim() === '') {
    return { ok: false, path: null, reason: 'empty path' };
  }
  let resolved;
  try {
    resolved = path.resolve(candidatePath);
  } catch (e) {
    return { ok: false, path: candidatePath, reason: `unresolvable path: ${e.message}` };
  }
  if (!exists(resolved)) {
    // existsSync deliberately suppresses filesystem errors, so `false` cannot
    // distinguish absence from an inaccessible/unmeasurable path.
    return { ok: false, path: resolved, reason: 'does not exist or could not be accessed' };
  }
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) return { ok: false, path: resolved, reason: 'not a file' };
  } catch (e) {
    return { ok: false, path: resolved, reason: `stat failed: ${e.message}` };
  }

  const versionResult = run(resolved, ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
  if (versionResult.error || versionResult.status !== 0) {
    const detail = versionResult.error ? versionResult.error.message : `exited ${versionResult.status}`;
    return { ok: false, path: resolved, reason: `--version failed (${detail})` };
  }
  const version = parseVersion(versionResult.stdout);
  if (!version) {
    return { ok: false, path: resolved, reason: `could not parse a version from "${String(versionResult.stdout).trim()}"` };
  }
  if (!versionAtLeast(version, MIN_VERSION)) {
    return {
      ok: false,
      path: resolved,
      version,
      reason: `version ${version.join('.')} is below the required ${MIN_VERSION.join('.')} (node:sqlite DatabaseSync.isOpen landmine)`
    };
  }

  const sqliteResult = run(resolved, ['-e', SQLITE_PROBE_SCRIPT], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
  if (sqliteResult.error || sqliteResult.status !== 0) {
    const detail = sqliteResult.error
      ? sqliteResult.error.message
      : (sqliteResult.stderr && sqliteResult.stderr.trim()) || `exited ${sqliteResult.status}`;
    return { ok: false, path: resolved, version, reason: `node:sqlite DatabaseSync.isOpen probe failed (${detail})` };
  }

  return { ok: true, path: resolved, version };
}

/**
 * Ordered, deduplicated candidate list for tiers 2 (common fixed install
 * locations) and 3 (PATH). Tier 1 (the explicit env override) is handled
 * separately by the caller because a set-but-failing override must hard
 * stop rather than fall through into this list.
 */
function collectCandidates({ env = process.env, platform = process.platform, homedir = os.homedir } = {}) {
  const exe = exeName(platform);
  const seen = new Set();
  const list = [];

  function add(candidatePath, source) {
    if (!candidatePath) return;
    let resolved;
    try {
      resolved = path.resolve(candidatePath);
    } catch {
      // Do not silently erase a candidate that could not be normalized. Let
      // probeCandidate record the failed measurement in the attempt list.
      list.push({ path: candidatePath, source });
      return;
    }
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ path: resolved, source });
  }

  // Tier 2: common fixed install locations.
  add('C:\\agent-apps\\node-v22.19.0\\node.exe', 'known previously-pinned location');
  add(path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', exe), 'ProgramFiles\\nodejs');
  add(path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', exe), 'ProgramFiles(x86)\\nodejs');
  add(
    path.join(env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Programs', 'node', exe),
    'LOCALAPPDATA\\Programs\\node'
  );
  if (env.NVM_SYMLINK) add(path.join(env.NVM_SYMLINK, exe), 'NVM_SYMLINK (nvm-windows active version)');

  // Tier 3: PATH.
  const pathEnv = env.PATH || env.Path || env.path || '';
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    add(path.join(dir, exe), `PATH (${dir})`);
  }

  return list;
}

/**
 * Resolve a qualifying interpreter. Returns { node, attempts, overrideFailed }.
 * `node` is null and `attempts` lists every candidate checked (with a
 * specific reason each one failed) when nothing qualifies -- the caller
 * turns that into a loud, itemized failure, never a silent one.
 */
function resolveQualifyingNode(opts = {}) {
  const {
    env = process.env,
    platform = process.platform,
    homedir = os.homedir,
    exists = fs.existsSync,
    statSync = fs.statSync,
    run = spawnSync
  } = opts;
  const probeOpts = { exists, statSync, run };
  const attempts = [];

  const override = env[OVERRIDE_ENV_VAR];
  if (typeof override === 'string' && override.trim() !== '') {
    if (!path.isAbsolute(override)) {
      return {
        node: null,
        attempts: [{
          source: `${OVERRIDE_ENV_VAR} (explicit override)`,
          ok: false,
          path: null,
          reason: 'explicit override must be an absolute path'
        }],
        overrideFailed: true
      };
    }
    const probe = probeCandidate(override, probeOpts);
    attempts.push({ source: `${OVERRIDE_ENV_VAR} (explicit override)`, ...probe });
    if (probe.ok) return { node: probe.path, attempts, overrideFailed: false };
    return { node: null, attempts, overrideFailed: true };
  }

  for (const candidate of collectCandidates({ env, platform, homedir })) {
    const probe = probeCandidate(candidate.path, probeOpts);
    attempts.push({ source: candidate.source, ...probe });
    if (probe.ok) return { node: probe.path, attempts, overrideFailed: false };
  }

  return { node: null, attempts, overrideFailed: false };
}

function formatFailure(result) {
  const lines = [];
  lines.push(
    `resolve-node.js: FAILED to find a Node interpreter with a working node:sqlite DatabaseSync.isOpen (requires >= ${MIN_VERSION.join('.')}).`
  );
  if (result.overrideFailed) {
    lines.push(`  ${OVERRIDE_ENV_VAR} was set but does not qualify -- refusing to silently fall back to autodetection.`);
  }
  lines.push('Checked:');
  for (const a of result.attempts) {
    lines.push(`  - [${a.ok ? 'OK' : 'FAIL'}] ${a.source}: ${a.path || '(unresolved)'}${a.reason ? ' -- ' + a.reason : ''}`);
  }
  if (result.attempts.length === 0) {
    lines.push('  (no candidates found to check)');
  }
  lines.push(`Fix: install Node >= ${MIN_VERSION.join('.')} and put it on PATH, or set ${OVERRIDE_ENV_VAR} to its node.exe.`);
  return lines.join('\n') + '\n';
}

function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    platform = process.platform,
    homedir = os.homedir,
    exists = fs.existsSync,
    statSync = fs.statSync,
    run = spawnSync,
    stderr = process.stderr,
    exit = process.exit
  } = {}
) {
  if (argv.length === 0) {
    stderr.write('resolve-node.js: usage: node resolve-node.js <script.js> [...args]\n');
    return exit(2);
  }

  const result = resolveQualifyingNode({ env, platform, homedir, exists, statSync, run });
  if (!result.node) {
    stderr.write(formatFailure(result));
    return exit(1);
  }

  const child = run(result.node, argv, { stdio: 'inherit', windowsHide: true });
  if (child.error) {
    stderr.write(`resolve-node.js: found ${result.node} but failed to launch it: ${child.error.message}\n`);
    return exit(1);
  }
  return exit(child.status === null ? 1 : child.status);
}

module.exports = {
  MIN_VERSION,
  OVERRIDE_ENV_VAR,
  parseVersion,
  versionAtLeast,
  probeCandidate,
  collectCandidates,
  resolveQualifyingNode,
  formatFailure,
  main
};

if (require.main === module) {
  main();
}
