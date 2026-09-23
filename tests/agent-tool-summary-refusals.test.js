'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');

const state = {
  settingRejected: false,
  apiRejected: false,
  registryThrows: false,
};

const registry = {
  byId: new Map([
    ['agent.tool_summary', {}],
    ['agent.agent_api', {}],
  ]),
};
const dependencies = {
  './permission-tier-policy': {
    installTier(tier) {
      if (!['guided', 'standard', 'unrestricted'].includes(tier)) {
        const error = new Error('unknown tier');
        error.code = 'PERMISSION_INSTALL_TIER_REFUSED';
        throw error;
      }
      return tier;
    },
    installTierSession(tier) {
      return { profile: tier === 'guided' ? 'read-only' : 'read-write' };
    },
    allowedToolNames(tools) { return new Set(tools.map(tool => tool.name)); },
  },
  './setup/machine-record': { tierToolAllowlist() { return ['memory.get']; } },
  './tool-registry': {
    get TOOL_REGISTRY() {
      if (state.registryThrows) throw new Error('registry unavailable');
      return [{ name: 'memory.get' }];
    },
    registeredTools() {
      if (state.registryThrows) throw new Error('registry unavailable');
      return [{ name: 'memory.get' }];
    },
  },
  './settings-registry': { loadRegistry() { return registry; } },
  './settings': {
    loadSettings() {
      return {
        rejected: state.settingRejected
          ? [{ id: 'agent.tool_summary' }]
          : state.apiRejected ? [{ id: 'agent.agent_api' }] : [],
        values: { 'agent.tool_summary': true, 'agent.agent_api': true },
      };
    },
  },
  './agent-api-policy': { AGENT_API_SETTING_ID: 'agent.agent_api' },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (parent && /agent-tool-summary\.js$/.test(parent.filename)
      && Object.prototype.hasOwnProperty.call(dependencies, request)) {
    return dependencies[request];
  }
  return originalLoad.call(this, request, parent, isMain);
};
const summary = require('../src/lib/agent-tool-summary');

function assertRefusal(code, input, configure = () => {}) {
  state.settingRejected = false;
  state.apiRejected = false;
  state.registryThrows = false;
  configure();

  let writes = 0;
  let spawns = 0;
  const originals = new Map();
  for (const [owner, names, counter] of [
    [fs, ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile'], () => { writes += 1; }],
    [childProcess, ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec'], () => { spawns += 1; }],
  ]) {
    for (const name of names) {
      originals.set(`${owner === fs ? 'fs' : 'cp'}:${name}`, owner[name]);
      owner[name] = counter;
    }
  }

  let result;
  try {
    result = summary.briefToolSummary(input);
  } finally {
    for (const [key, implementation] of originals) {
      const [owner, name] = key.split(':');
      (owner === 'fs' ? fs : childProcess)[name] = implementation;
    }
  }

  assert.deepEqual(result, {
    enabled: false,
    text: null,
    code,
    estimatedTokens: 0,
  });
  assert.equal(writes, 0, `${code} wrote to the filesystem`);
  assert.equal(spawns, 0, `${code} spawned a process`);
}

assertRefusal('TOOL_SUMMARY_SETTING_UNAVAILABLE', { tier: 'standard' }, () => {
  state.settingRejected = true;
});
assertRefusal('TOOL_SUMMARY_DISABLED', { tier: 'standard', enabled: false });
assertRefusal('TOOL_SUMMARY_TIER_UNKNOWN', { tier: 'mystery', enabled: true });
assertRefusal('TOOL_SUMMARY_SURFACE_UNAVAILABLE', { tier: 'standard', enabled: true }, () => {
  state.registryThrows = true;
});
assertRefusal('TOOL_SUMMARY_SURFACE_EMPTY', {
  tier: 'standard', enabled: true, allowedNames: [], totalNames: ['memory.get'],
});
assertRefusal('TOOL_SUMMARY_TOTAL_SURFACE_EMPTY', {
  tier: 'standard', enabled: true, allowedNames: ['memory.get'], totalNames: [],
});
assertRefusal('TOOL_SUMMARY_SURFACE_INVALID', {
  tier: 'standard', enabled: true, allowedNames: [null], totalNames: ['memory.get'],
});
assertRefusal('TOOL_SUMMARY_SURFACE_MISMATCH', {
  tier: 'standard', enabled: true, allowedNames: ['memory.set'], totalNames: ['memory.get'],
});
assertRefusal('TOOL_SUMMARY_AGENT_API_UNAVAILABLE', {
  tier: 'standard', enabled: true, allowedNames: ['memory.get'], totalNames: ['memory.get'],
}, () => {
  state.apiRejected = true;
});

Module._load = originalLoad;
console.log('agent-tool-summary refusal tests passed');
