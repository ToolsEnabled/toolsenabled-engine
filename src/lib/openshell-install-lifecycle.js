'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');

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
    throw new Error('This command needs an installed ToolsEnabled OpenShell runtime.');
  }
  return { prefix, manifest };
}

function version(binDir) {
  const { manifest } = installedManifest(binDir);
  return `ToolsEnabled ${manifest.version} (${manifest.source_commit})`;
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
    const answer = await input.question(`Delete ToolsEnabled state at ${paths.join(' and ')}? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    input.close();
  }
}

function safeStatePath(candidate, prefix) {
  if (!path.isAbsolute(candidate)) throw new Error(`State path must be absolute: ${candidate}`);
  const chosen = path.resolve(candidate);
  const home = path.resolve(os.homedir());
  if ([path.parse(chosen).root, home, prefix].includes(chosen) || chosen.startsWith(`${prefix}${path.sep}`)) {
    throw new Error(`State path is unsafe to delete: ${chosen}`);
  }
  try { if (fs.lstatSync(chosen).isSymbolicLink()) throw new Error(`State path is a link: ${chosen}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return chosen;
}

async function uninstall(binDir, { keepState = false } = {}) {
  if (process.env.OPENSHELL_SANDBOX !== '1') throw new Error('Run uninstall inside your OpenShell sandbox.');
  const { prefix } = installedManifest(binDir);
  const stateRoot = safeStatePath(process.env.TOOLSENABLED_STATE_ROOT || path.join(os.homedir(), '.toolsenabled'), prefix);
  const servicesRoot = require('./setup/machine-record').resolveServicesRoot({});
  const statePaths = [...new Set([stateRoot, servicesRoot].filter(Boolean).map((item) => safeStatePath(item, prefix)))].filter((item) => fs.existsSync(item));
  const deleteState = !keepState && await confirmStateDeletion(statePaths);

  // Remove both registrations before removing the command that can repair them.
  const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');
  const commands = [
    ['claude', ['mcp', 'remove', '--scope', 'user', 'toolsenabled']],
    ['codex', ['mcp', 'remove', 'toolsenabled']]
  ];
  for (const [cli, args] of commands) {
    if (!onPath(cli)) continue;
    const result = spawnSync(cli, args, {
      env: safeLaunchEnvironment(launchEnv(cli), { context: `OpenShell uninstall: ${cli} mcp remove` }),
      stdio: 'pipe', encoding: 'utf8', windowsHide: true
    });
    if (result.error) throw new Error(`${cli} registration could not be removed: ${result.error.message}`);
    if (result.status !== 0) {
      const message = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (!/not found|does not exist|not configured|no MCP server|no server named|not registered/i.test(message)) {
        throw new Error(`${cli} registration could not be removed (exit ${result.status}); the runtime was kept for retry.`);
      }
      process.stdout.write(`${cli} registration was already absent.\n`);
    } else process.stdout.write(`${cli} registration removed.\n`);
  }
  fs.rmSync(prefix, { recursive: true });
  process.stdout.write(`ToolsEnabled runtime and wrappers removed from ${prefix}.\n`);
  if (deleteState) {
    for (const item of statePaths) fs.rmSync(item, { recursive: true });
    process.stdout.write('ToolsEnabled state removed.\n');
  } else {
    process.stdout.write(`ToolsEnabled state kept${statePaths.length ? ` at ${statePaths.join(' and ')}` : ''}.\n`);
  }
  return 0;
}

module.exports = Object.freeze({ installedManifest, version, uninstall });
