'use strict';

// Native client adapters and direct model connections share one OpenShell
// catalog. Endpoint aliases are configuration, never a hardcoded vendor list.
const NATIVE_PROVIDERS = require('./agents/registry').workerAgentIds(require('./agents/registry').activeRegistry());

function workerCatalog({ env = process.env } = {}) {
  const installed = require('./fleet-worker-tiers');
  const native = Object.fromEntries(Object.entries(installed)
    .filter(([, row]) => NATIVE_PROVIDERS.includes(row.provider)));
  const connections = require('./openshell-inside').isInsideOpenShellSandbox(env)
    || env.TOOLSENABLED_RUNTIME_MODE === 'host' && env.TOOLSENABLED_HOST_WORKERS === '1'
    ? require('./openshell-model-connections').connectionTiers({ env }) : {};
  const tiers = Object.freeze({ ...native, ...connections });
  const providers = Object.freeze([...new Set([...NATIVE_PROVIDERS,
    ...Object.values(connections).map(row => row.provider)])]);
  return Object.freeze({ tiers, providers });
}

module.exports = Object.freeze({ NATIVE_PROVIDERS, workerCatalog });
