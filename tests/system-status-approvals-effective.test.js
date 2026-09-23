'use strict';

require('./lib/isolated-environment').activate('system-status-approvals-effective');
const assert = require('node:assert/strict');

const settingsPath = require.resolve('../src/lib/settings');
const originalSettings = require.cache[settingsPath];
const { requiresApproval } = require('../src/lib/policy');
const { approvalState } = require('../src/lib/system-status');

const POLICY = Object.freeze({
  approvals: {
    enabled: true,
    externalWrites: true,
    actions: ['host.exec', 'browser.stop', 'scheduler.create'],
    autoApproveBrowserStart: true,
    allowScheduledActions: true,
    timeoutSeconds: 60
  }
});

function withSettings(settings, run) {
  require.cache[settingsPath] = {
    id: settingsPath,
    filename: settingsPath,
    loaded: true,
    exports: { loadSettings: () => settings },
    children: [],
    paths: []
  };
  try {
    return run();
  } finally {
    if (originalSettings) require.cache[settingsPath] = originalSettings;
    else delete require.cache[settingsPath];
  }
}

function ownerSaid(value, source) {
  return {
    values: { 'agent.tool_approvals': value },
    provenance: { 'agent.tool_approvals': { source, atMs: 1, directive: null } }
  };
}

withSettings({ values: {}, provenance: {} }, () => {
  const state = approvalState(POLICY);
  assert.equal(state.enabled, true);
  assert.equal(state.externalWrites, true);
  assert.deepEqual(state.actions, ['host.exec', 'browser.stop', 'scheduler.create']);
  assert.equal(state.policyFileEnabled, true);
});

withSettings(ownerSaid(false, 'user'), () => {
  const state = approvalState(POLICY);
  assert.equal(state.enabled, false);
  assert.equal(state.externalWrites, false);
  assert.deepEqual(state.actions, []);
  assert.equal(state.policyFileEnabled, true);
  assert.deepEqual(state.declaredActions, ['host.exec', 'browser.stop', 'scheduler.create']);
});

withSettings(ownerSaid(false, 'default'), () => {
  const state = approvalState(POLICY);
  assert.equal(state.enabled, true);
  assert.deepEqual(state.actions, ['host.exec', 'browser.stop', 'scheduler.create']);
});

for (const settings of [{ values: {}, provenance: {} }, ownerSaid(false, 'user')]) {
  withSettings(settings, () => {
    const state = approvalState(POLICY);
    for (const action of POLICY.approvals.actions) {
      assert.equal(
        state.actions.includes(action),
        requiresApproval(action, 'local-write', POLICY),
        `status and the gate disagree about ${action}`
      );
    }
  });
}

console.log('system-status-approvals-effective: ok');
