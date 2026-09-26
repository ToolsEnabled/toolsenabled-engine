/*
 * Mutation: changed the provider's explicit-enabled check from === true to !== true.
 * Landed: yes; the mutated source line was found after the edit.
 * Went red: yes; the featureEnabled true-case assertion failed (false !== true).
 * Restore: confirmed against the module's original SHA-256 before the green run.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const capability = require('../src/lib/capability-manifests');
const provider = require('../src/lib/providers/capability-manifests');
const { createStateStore } = require('../src/lib/state-store');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-manifest-provider-'));
const nowMs = Date.UTC(2026, 7, 27, 12, 0, 0);
const state = createStateStore({
  file: path.join(directory, 'state.sqlite3'),
  clock: () => nowMs,
  idFactory: prefix => `${prefix}-provider-test-00000001`
});

try {
  const task = state.submitTask({
    queue: 'test',
    type: 'capability-provider',
    idempotencyKey: 'capability-provider-behaviour',
    payload: { title: 'Capability provider test', objective: 'Exercise the provider exports.' }
  }).task;
  const catalog = {
    tools: [{
      name: 'fixture.read',
      effect: 'local-read',
      approvalEligible: false,
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
    }],
    roots: [], domains: [], httpMethods: [], commandIds: [], secretHandles: [], externalActions: []
  };
  const configuration = capability.normalizeConfiguration({
    schemaVersion: 1,
    profiles: [{
      id: 'fixture-readonly',
      tools: ['fixture.read'], roots: [], domains: [], httpMethods: [], commandIds: [],
      secretHandles: [], externalActions: [], approvalRequiredActions: [], deniedTools: [],
      completionCriteria: ['read-complete'], maxTtlMs: 300_000
    }]
  }, capability.normalizeCatalog(catalog));
  const auditEvents = [];
  const dependencies = {
    state,
    catalog,
    configuration,
    enabled: true,
    now: () => nowMs,
    loadSettings: () => ({
      values: {
        'capability.elevation_duration': 1,
        'capability.elevation_survives_restart': true
      },
      rejected: []
    }),
    auditWrite: (event, options) => {
      auditEvents.push({ event, options });
      return { durable: true };
    }
  };

  assert.equal(provider.featureEnabled({ enabled: true }), true);
  assert.equal(provider.featureEnabled({ enabled: false }), false);

  const compiled = provider.compile({
    profileId: 'provider.behaviour',
    version: 1,
    taskId: task.id,
    baseProfileId: 'fixture-readonly',
    requested: {
      tools: ['fixture.read'], roots: [], domains: [], httpMethods: [], commandIds: [],
      secretHandles: [], externalActions: [], approvalRequiredActions: [],
      completionCriteria: ['read-complete'], expiresAtMs: nowMs + 240_000
    }
  }, dependencies);
  assert.equal(compiled.profile.expiresAtMs, nowMs + 60_000,
    'compile must cap a requested expiry to the configured elevation duration');
  assert.equal(provider.profile({ profileId: 'provider.behaviour', version: 1 }, dependencies).profileId,
    'provider.behaviour');

  const expansion = provider.requestExpansion({
    requestId: 'expansion-request-1',
    profileId: 'provider.behaviour',
    version: 1,
    reason: 'Need another read selector.',
    requested: { tools: ['fixture.read'] },
    evidenceReference: 'test:evidence',
    expectedAction: 'Review the requested selector.'
  }, dependencies);
  assert.equal(expansion.grantsAuthority, false, 'an expansion request must never grant authority');

  const authorized = provider.authorizeBoundRequest({
    requestId: 'tool-request-1',
    requestKind: 'tool',
    profileId: 'provider.behaviour',
    version: 1,
    request: { taskId: task.id, tool: 'fixture.read' }
  }, dependencies);
  assert.equal(authorized.boundRequest.tool, 'fixture.read');
  assert.equal(authorized.grantsAuthority, false);

  const revoked = provider.revoke({
    profileId: 'provider.behaviour', version: 1, reasonCode: 'test-complete'
  }, dependencies);
  assert.equal(revoked.replayed, false);
  assert.equal(provider.profile({ profileId: 'provider.behaviour', version: 1 }, dependencies).status,
    'revoked');
  assert.deepEqual(auditEvents.map(item => item.event.outcome),
    ['compiled', 'requested', 'authorized', 'revoked']);

  console.log('capability-manifests provider behaviour passed');
} finally {
  state.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
