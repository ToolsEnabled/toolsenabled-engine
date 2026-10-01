'use strict';

// Registration adapter for the descriptor-owning Python uninstall driver.
// No directory deletion, config parsing or connecting Claude inspection here.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const records = require('./setup/machine-record');
const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');
const { inspect: inspectContext } = require('./openshell-lifecycle-context');

const COMMANDS = Object.freeze({
  claude: ['mcp', 'remove', '--scope', 'user', 'toolsenabled'],
  codex: ['mcp', 'remove', 'toolsenabled']
});

function providerState(provider, context, env) {
  const available = context.availableProviders.includes(provider);
  const history = available ? null : records.readOpenShellRegistrationState({
    servicesRoot: context.servicesRoot, provider, installRoot: path.join(context.prefix, 'runtime/engine'), env
  });
  if (!available && history !== 'never') {
    throw new Error(`${provider} registration could not be inspected; setup registration history is ${history}. The runtime and state were kept. Make ${provider} available in this profile before retrying.`);
  }
  return { available, history };
}

function inspect(prefix, env = process.env) {
  const context = inspectContext({ prefix, env });
  // Resolve both unavailable-provider histories before allowing either removal.
  const providers = Object.fromEntries(Object.keys(COMMANDS).map(provider => [provider, providerState(provider, context, env)]));
  if (providers.codex.available) {
    require('./openshell-codex-target').assertCodexTarget(context.prefix, { env, cwd: context.home });
  }
  return { context, providers };
}

function launchEnv(provider, env) {
  const names = ['HOME', 'PATH', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR',
    provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'];
  return safeLaunchEnvironment({ ...Object.fromEntries(names.filter(key => env[key] !== undefined).map(key => [key, env[key]])),
    LANG: 'C', LC_ALL: 'C' }, { context: `OpenShell uninstall: ${provider} mcp remove` });
}

function remove(prefix, provider, { env = process.env, launch = spawnSync } = {}) {
  if (!Object.hasOwn(COMMANDS, provider)) throw new Error('Invalid uninstall provider.');
  // Recheck all availability/history in this process immediately before mutation.
  const { context, providers } = inspect(prefix, env);
  if (!providers[provider].available) return { provider, outcome: 'never', version: null };
  const args = COMMANDS[provider];
  const cliEnv = launchEnv(provider, env);
  const result = launch(provider, args, { env: cliEnv, cwd: context.home,
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 30_000, maxBuffer: 65_536 });
  if (result.error) throw new Error(`${provider} registration could not be removed: ${result.error.message}; the runtime and state were kept. Manual command: ${[provider, ...args].join(' ')}`);
  if (result.status !== 0 || result.signal) {
    if (!result.signal && Number.isInteger(result.status)) {
      const inspection = require('./openshell-registration-inspection').probe(provider, {
        env: cliEnv, cwd: context.home, removalResult: result, spawnSync: launch
      });
      if (inspection.absent) return { provider, outcome: 'absent', version: inspection.version };
    }
    const detail = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    throw new Error(`${provider} registration could not be removed (${detail}); absence could not be verified. The runtime was kept for retry. State was kept. Earlier CLI removals may already have succeeded. Manual command: ${[provider, ...args].join(' ')}`);
  }
  return { provider, outcome: 'removed', version: null };
}

function main(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!['--prefix', '--phase', '--provider'].includes(key) || Object.hasOwn(options, key)
      || typeof value !== 'string' || !value || value.startsWith('-')) throw new Error('Invalid uninstall adapter arguments.');
    options[key] = value;
  }
  if (!path.isAbsolute(options['--prefix'] || '') || !['inspect', 'remove'].includes(options['--phase'])
    || (options['--phase'] === 'remove' ? !Object.hasOwn(COMMANDS, options['--provider']) : options['--provider'] !== undefined)) {
    throw new Error('Invalid uninstall adapter operation.');
  }
  require('./openshell-lifecycle-lock').check();
  return options['--phase'] === 'inspect' ? inspect(options['--prefix']) : remove(options['--prefix'], options['--provider']);
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = Object.freeze({ inspect, remove, main });
