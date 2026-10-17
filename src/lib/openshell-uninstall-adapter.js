'use strict';

// Registration adapter for the descriptor-owning Python uninstall driver.
// No directory deletion, config parsing or connecting Claude inspection here.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const records = require('./setup/machine-record');
const { safeLaunchEnvironment } = require('./supervision/launch-environment');
const { inspect: inspectContext } = require('./openshell-lifecycle-context');

const registration = require('./agents/registration');
const { loadRegistry } = require('./agents/registry');

function providerState(provider, context, env) {
  const available = context.availableProviders.includes(provider);
  const history = available ? null : records.readOpenShellRegistrationState({
    servicesRoot: context.servicesRoot, provider, installRoot: path.join(context.prefix, 'runtime/engine'), env
  });
  if (!available && history !== 'never') {
    // A registration kept in a described file can be checked without its CLI.
    // No Fleet entry there means nothing to remove, whatever the history says.
    const descriptor = loadRegistry({ env }).get(provider);
    if (descriptor?.register.inspection?.kind === 'json-config') {
      let checked = null;
      try { checked = registration.jsonInspection(descriptor, undefined, { env }); } catch { /* refused below */ }
      if (checked?.absent) return { available, history: 'absent' };
    }
    throw new Error(`${provider} registration could not be inspected; setup registration history is ${history}. The runtime and state were kept. Make ${provider} available in this profile before retrying.`);
  }
  return { available, history };
}

function inspect(prefix, env = process.env) {
  const context = inspectContext({ prefix, env });
  const saved = records.readMachineRecord({ servicesRoot: context.servicesRoot, adopt: false });
  for (const id of Object.keys(saved?.openShellRegistrations?.providers || {})) {
    if (!loadRegistry({ env }).has(id)) throw new Error(`The descriptor for previously recorded agent ${id} is missing. The runtime was retained for review.`);
  }
  // Resolve every unavailable-agent history before allowing any removal.
  const providers = Object.fromEntries(loadRegistry({ env }).ids.map(provider => [provider, providerState(provider, context, env)]));
  for (const agent of loadRegistry({ env }).agents) {
    if (providers[agent.id]?.available) assertOwned(agent, context, env);
  }
  return { context, providers };
}

function launchEnv(provider, env) {
  const descriptor = loadRegistry({ env }).get(provider);
  const names = ['HOME', 'PATH', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', descriptor.register.profile?.env].filter(Boolean);
  return safeLaunchEnvironment({ ...Object.fromEntries(names.filter(key => env[key] !== undefined).map(key => [key, env[key]])),
    LANG: 'C', LC_ALL: 'C' }, { context: `OpenShell uninstall: ${provider} mcp remove` });
}

function assertOwned(agent, context, env, launch = spawnSync) {
  const savedRecord = records.readMachineRecord({ servicesRoot: context.servicesRoot, adopt: false });
  const savedEntry = savedRecord?.openShellRegistrations?.providers[agent.id];
  if (savedEntry?.entry?.passEnv !== undefined) {
    const expected = records.openShellRegistrationContext(agent.id, { installRoot: path.join(context.prefix, 'runtime/engine'), env });
    if (Object.entries(expected).every(([key, value]) => savedEntry[key] === value)) {
      if (agent.register.config?.format === 'toml') {
        return require('./openshell-codex-target').assertCodexTarget(context.prefix, { env, cwd: context.home, launch,
          descriptor: agent, entry: savedEntry.entry, registry: loadRegistry({ env }) });
      }
      const checked = registration.jsonInspection(agent, savedEntry.entry, { env });
      if (checked.absent || checked.owned) return { absent: checked.absent, owned: checked.owned, entry: savedEntry.entry };
    }
    throw Object.assign(new Error('The MCP registration differs from Fleet’s recorded entry; it was retained.'), { code: 'REGISTRATION_TARGET_UNPROVEN' });
  }
  if (agent.register.inspection?.kind === 'command-absence' && agent.worker.driver === 'app-server') {
    return require('./openshell-codex-target').assertCodexTarget(context.prefix, { env, cwd: context.home, launch, descriptor: agent });
  }
  // Some agents can only be checked by removing (their read command starts the
  // server). Removal by Fleet's own server name is then the documented route,
  // and absence is verified from the removal result afterwards.
  if (agent.register.inspection?.kind === 'remove-absence') return { absent: false, owned: null };
  const history = records.readOpenShellRegistrationState({ servicesRoot: context.servicesRoot, provider: agent.id,
    installRoot: path.join(context.prefix, 'runtime/engine'), env });
  let entry;
  if (history === 'configured' || history === 'unknown') {
    const saved = records.readMachineRecord({ servicesRoot: context.servicesRoot, adopt: false });
    const row = saved?.openShellRegistrations?.providers[agent.id];
    const expected = records.openShellRegistrationContext(agent.id, { installRoot: path.join(context.prefix, 'runtime/engine'), env });
    if (row && Object.entries(expected).every(([key, value]) => row[key] === value)) entry = row.entry;
  }
  const checked = require('./openshell-registration-inspection').probe(agent.id, { env, cwd: context.home, entry, spawnSync: launch });
  if (checked.absent || checked.owned) return { ...checked, entry };
  throw Object.assign(new Error(`${agent.name} registration ownership cannot be proven without a qualified nonconnecting inspection. The runtime and registration were retained.`), { code: 'REGISTRATION_TARGET_UNPROVEN' });
}

function remove(prefix, provider, { env = process.env, launch = spawnSync } = {}) {
  const descriptor = loadRegistry({ env }).get(provider);
  if (!descriptor) throw new Error('Invalid uninstall provider.');
  // Recheck all availability/history in this process immediately before mutation.
  const { context, providers } = inspect(prefix, env);
  if (!providers[provider].available) return { provider, outcome: providers[provider].history === 'absent' ? 'absent' : 'never', version: null };
  const proof = assertOwned(descriptor, context, env, launch);
  if (proof.absent) return { provider, outcome: 'absent', version: proof.version || null };
  if (descriptor.register.kind === 'opencode-config') {
    return { provider, outcome: registration.writeConfig(descriptor, proof.entry, { env, remove: true }), version: null };
  }
  const args = registration.command(descriptor, 'remove').slice(1);
  const cliEnv = launchEnv(provider, env);
  const result = launch(descriptor.command, args, { env: cliEnv, cwd: context.home,
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
    || (options['--phase'] === 'remove' ? !loadRegistry().has(options['--provider']) : options['--provider'] !== undefined)) {
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
