'use strict';

// Saved models join either explicitly enabled tree.
function genericTiers(env = process.env) {
  const enabled = env.TOOLSENABLED_RUNTIME_MODE === 'host' && env.TOOLSENABLED_HOST_WORKERS === '1'
    || env.TOOLSENABLED_OPENSHELL_AGENTS === '1' && require('./openshell-inside').isInsideOpenShellSandbox(env);
  if (!enabled) return {};
  return require('./openshell-model-connections').connectionTiers({ env });
}

// A plugin setup can limit subagents to some agent CLIs; host-runtime serves
// that list as TOOLSENABLED_OPENSHELL_PROVIDERS. Advertise only their tiers.
function hostProviderTiers(entry, env) {
  if (env.TOOLSENABLED_RUNTIME_MODE !== 'host') return entry;
  const words = name => String(env[name] || '').split(',').map(word => word.trim()).filter(Boolean);
  let allowed = words('TOOLSENABLED_OPENSHELL_PROVIDERS');
  let models = words('TOOLSENABLED_OPENSHELL_MODELS');
  // A plugin setup can change while this session runs; list what it allows now.
  const live = env.TOOLSENABLED_HOST_SETUP_KIND === 'plugin' ? require('./host-runtime').currentPluginLimits() : null;
  if (live && live.workers) { allowed = live.providers ? [...live.providers] : []; models = live.models ? [...live.models] : []; }
  if (!allowed.length && !models.length) return entry;
  const tiers = { ...require('./fleet-worker-tiers'), ...genericTiers(env) };
  // A model list limits only the providers it names; others keep every model.
  const limited = new Set(models.filter(name => Object.prototype.hasOwnProperty.call(tiers, name)).map(name => tiers[name].provider));
  const keep = name => Object.prototype.hasOwnProperty.call(tiers, name)
    && (!allowed.length || allowed.includes(tiers[name].provider))
    && (!limited.has(tiers[name].provider) || models.includes(name));
  const note = models.length
    ? `${allowed.length ? `${allowed.join(', ')}; ` : ''}models limited to ${models.filter(keep).join(', ')}`
    : allowed.join(', ');
  const narrow = input => ({ ...input, properties: { ...input.properties,
    tier: { ...input.properties.tier, enum: input.properties.tier.enum.filter(keep),
      description: `${input.properties.tier.description} In this project, subagents can use only: ${note}.` }
  } });
  return { ...entry, inputSchema: narrow(entry.inputSchema), baseInputSchema: narrow(entry.baseInputSchema) };
}

function spawnEntry(entry, env = process.env) {
  if (!entry || entry.name !== 'agent.spawn') return entry;
  const names = Object.keys(genericTiers(env));
  if (!names.length) return hostProviderTiers(entry, env);
  const extend = input => ({ ...input, properties: { ...input.properties,
    tier: { ...input.properties.tier, enum: [...input.properties.tier.enum, ...names],
      description: `${input.properties.tier.description} Saved generic connections: ${names.join(', ')}. These require surface tree and use their configured round, output, aggregate-admission and time limits. Omit optional provider/model confirmations when their names exceed this shared schema's limits.` }
  } });
  return hostProviderTiers({ ...entry, inputSchema: extend(entry.inputSchema), baseInputSchema: extend(entry.baseInputSchema) }, env);
}

module.exports = Object.freeze({ genericTiers, spawnEntry });
