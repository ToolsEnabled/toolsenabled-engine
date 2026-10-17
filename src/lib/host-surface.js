'use strict';

const { OPENSHELL_TOOLS, OPENSHELL_AGENT_TOOLS } = require('./openshell-surface');

// Fleet's work record and mediated files use the same implementations in both
// editions. Policy-advisor tools and terminal questions belong to OpenShell.
const HOST_TOOLS = Object.freeze(OPENSHELL_TOOLS.filter(name => !name.startsWith('openshell.') && !['system.ask', 'system.notify'].includes(name)));
function hostAllowlist({ workers = false } = {}) {
  return workers ? [...HOST_TOOLS, ...OPENSHELL_AGENT_TOOLS, 'agent.continue'] : [...HOST_TOOLS];
}

module.exports = { HOST_TOOLS, hostAllowlist };
