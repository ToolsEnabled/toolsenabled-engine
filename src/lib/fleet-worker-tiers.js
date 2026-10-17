'use strict';

// Worker choices for the Fleet tree, read from the agent descriptors
// (config/agents/*.json, src/lib/agents/registry.js). Each choice names one
// agent and one model it can be asked for. Discovering a worker never starts a
// dispatcher or a provider session.
//
// Only choices whose agent speaks a worker protocol this build can drive are
// offered, so the tree never advertises a worker it cannot start.
const { activeRegistry, workerAgentIds } = require('./agents/registry');

const registry = activeRegistry();
const providers = workerAgentIds(registry);
const tiers = {};
for (const [name, row] of Object.entries(registry.choices)) {
  if (!providers.includes(row.provider)) continue;
  tiers[name] = row;
}

module.exports = Object.freeze(tiers);
