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

function launchEnv(cli) {
  const names = ['HOME', 'PATH', 'USER', 'LANG', 'LC_ALL', 'TERM'];
  if (cli === 'codex') names.push('CODEX_HOME');
  if (cli === 'claude') names.push('CLAUDE_CONFIG_DIR');
  return Object.fromEntries(names.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

function onPath(name) {
  return String(process.env.PATH || '').split(path.delimiter).filter(Boolean).some((directory) => {
    try { fs.accessSync(path.join(directory, name), fs.constants.X_OK); return true; } catch { return false; }
  });
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

async function uninstall(binDir, { keepState = false } = {}) {
  if (process.env.OPENSHELL_SANDBOX !== '1') throw new Error('Run uninstall inside your OpenShell sandbox.');
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

  // Remove both registrations before removing the command that can repair them.
  const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');
  const commands = [
    ['claude', ['mcp', 'remove', '--scope', 'user', 'toolsenabled']],
    ['codex', ['mcp', 'remove', 'toolsenabled']]
  ];
  // An unavailable executable cannot prove that its registration is absent.
  // Check both providers before changing either registration; only sealed setup
  // evidence for this exact engine/profile can establish no setup attempt.
  const available = new Map();
  for (const [cli] of commands) {
    const present = onPath(cli);
    available.set(cli, present);
    if (present) continue;
    const history = require('./setup/machine-record').readOpenShellRegistrationState({
      servicesRoot, provider: cli, installRoot: path.join(prefix, 'runtime/engine'), env: process.env
    });
    if (history !== 'never') {
      throw new Error(`${cli} registration could not be inspected; setup registration history is ${history}. The runtime and state were kept. Make ${cli} available in this profile before retrying.`);
    }
  }
  for (const [cli, args] of commands) {
    if (!available.get(cli)) {
      process.stdout.write(`${cli} is not available; sealed setup history records no registration attempt for this installation and profile.\n`);
      continue;
    }
    const cliEnv = safeLaunchEnvironment({ ...launchEnv(cli), LANG: 'C', LC_ALL: 'C' },
      { context: `OpenShell uninstall: ${cli} mcp remove` });
    const cliCwd = os.homedir();
    const result = spawnSync(cli, args, {
      env: cliEnv, cwd: cliCwd,
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true,
      timeout: 30_000, maxBuffer: 65_536
    });
    if (result.error) throw new Error(`${cli} registration could not be removed: ${result.error.message}; the runtime and state were kept. Manual command: ${[cli, ...args].join(' ')}`);
    if (result.status !== 0 || result.signal) {
      if (!result.signal && Number.isInteger(result.status)) {
        const inspection = require('./openshell-registration-inspection').probe(cli, {
          env: cliEnv, cwd: cliCwd, removalResult: result
        });
        if (inspection.absent) {
          process.stdout.write(`${cli} registration is absent (verified with ${inspection.version}).\n`);
          continue;
        }
      }
      const detail = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
      throw new Error(`${cli} registration could not be removed (${detail}); absence could not be verified. The runtime was kept for retry. State was kept. Earlier CLI removals may already have succeeded. Manual command: ${[cli, ...args].join(' ')}`);
    }
    process.stdout.write(`${cli} registration removed.\n`);
  }
  // Registration commands are external processes. Recheck aliases/overlap before
  // deleting the runtime so --keep-state also holds if their work moved a root.
  for (const item of selectedStatePaths) safeStatePath(item, prefix);
  const currentServicesRoot = require('./setup/machine-record').resolveServicesRoot({});
  if (currentServicesRoot !== servicesRoot) throw new Error('The selected service state location changed; the runtime and state were kept.');
  assertUninstallPrefixSafe(prefix);
  fs.rmSync(prefix, { recursive: true });
  process.stdout.write(`ToolsEnabled Fleet runtime and wrappers removed from ${prefix}.\n`);
  process.stdout.write(`ToolsEnabled Fleet state kept${statePaths.length ? ` at ${statePaths.join(' and ')}` : ''}.\n`);
  return 0;
}

module.exports = Object.freeze({ installedManifest, version, uninstall });
