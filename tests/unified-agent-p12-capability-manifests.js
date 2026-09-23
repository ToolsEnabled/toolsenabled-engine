'use strict';

// P12 focused adversarial regression.  No browser, provider, vault, or live
// state is used; the durable profile authority is exercised in a temporary
// SQLite database only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const capability = require('../src/lib/capability-manifests');
const provider = require('../src/lib/providers/capability-manifests');
const { createStateStore, StateStoreError, SCHEMA_VERSION } = require('../src/lib/state-store');

// A DATABASE OLDER THAN 23 HAS THE THREE telegram_* TABLES. MIGRATION_V1 created
// them and MIGRATION_V23 (2026-08-23, the Telegram connector removal) drops them.
//
// The migration fixture below stamps user_version = 11 onto a CURRENT database,
// which has already been migrated past 23. Without this it would describe a v11
// database that never existed -- one missing tables every real v11 file had -- and
// _validateSchema is right to refuse it on reopen. Copied byte-for-byte from
// tests/kernel.state/scheduler-state.js, which restores the same three tables for
// the same reason; the CREATE text is byte-identical to SCHEMA_V1's, including the
// two singleton INSERTs its invariants check, because a character of drift changes
// the DDL fingerprint and the reopen fails loudly rather than passing quietly. The
// three DROP IF EXISTS lines make it idempotent -- only they are conditional.
const RESTORE_TELEGRAM_TABLES_V1 = `DROP TABLE IF EXISTS telegram_updates; DROP TABLE IF EXISTS telegram_poll_lease; DROP TABLE IF EXISTS telegram_cursor; CREATE TABLE telegram_cursor ( provider TEXT PRIMARY KEY CHECK(provider = 'telegram'), next_update_id INTEGER NOT NULL CHECK(next_update_id >= 0), updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0) ) STRICT; INSERT INTO telegram_cursor(provider, next_update_id, updated_at_ms) VALUES('telegram', 0, 0); CREATE TABLE telegram_poll_lease ( provider TEXT PRIMARY KEY CHECK(provider = 'telegram'), owner_id TEXT, token TEXT, fence INTEGER NOT NULL CHECK(fence >= 0), expires_at_ms INTEGER, updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0), CHECK((owner_id IS NULL AND token IS NULL AND expires_at_ms IS NULL) OR (owner_id IS NOT NULL AND token IS NOT NULL AND expires_at_ms IS NOT NULL)) ) STRICT; INSERT INTO telegram_poll_lease(provider, owner_id, token, fence, expires_at_ms, updated_at_ms) VALUES('telegram', NULL, NULL, 0, NULL, 0); CREATE TABLE telegram_updates ( update_id INTEGER PRIMARY KEY CHECK(update_id >= 0), received_at_ms INTEGER NOT NULL CHECK(received_at_ms >= 0), payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64) ) STRICT; CREATE INDEX telegram_updates_received_idx ON telegram_updates(received_at_ms, update_id); `;

// V24 renamed these tables/indexes. A fixture stamped v11 must restore their
// actual historical identities too; otherwise production correctly refuses it
// before exercising the additive migrations this test is meant to prove.
const RESTORE_LEGACY_MISSION_NAMES = `
  ALTER TABLE coordinator_missions RENAME TO jarvis_missions;
  ALTER TABLE coordinator_phase_states RENAME TO jarvis_phase_states;
  ALTER TABLE coordinator_workflow_missions RENAME TO jarvis_workflow_missions;
  ALTER TABLE coordinator_broker_verifications RENAME TO jarvis_broker_verifications;
  ALTER TABLE coordinator_workflow_events RENAME TO jarvis_workflow_events;
  ALTER TABLE coordinator_workflow_outbox RENAME TO jarvis_workflow_outbox;
  ALTER TABLE coordinator_workflow_acceptances RENAME TO jarvis_workflow_acceptances;
  DROP INDEX coordinator_missions_updated_idx;
  CREATE INDEX jarvis_missions_updated_idx ON jarvis_missions(updated_at_ms DESC, run_id);
  DROP INDEX coordinator_phase_states_run_idx;
  CREATE INDEX jarvis_phase_states_run_idx ON jarvis_phase_states(run_id, updated_at_ms DESC, actor);
  DROP INDEX coordinator_workflow_missions_task_idx;
  CREATE INDEX jarvis_workflow_missions_task_idx ON jarvis_workflow_missions(task_id, updated_at_ms DESC);
  DROP INDEX coordinator_workflow_outbox_delivery_idx;
  CREATE INDEX jarvis_workflow_outbox_delivery_idx ON jarvis_workflow_outbox(run_id, status, created_at_ms, outbox_id);
`;

const roots = [];
function temporary(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-p12-${label}-`));
  roots.push(directory);
  return directory;
}

function expectCode(callback, code) {
  assert.throws(callback, error => {
    assert.equal(error.code, code, error && error.stack);
    return true;
  });
}

function fixture(label) {
  const directory = temporary(label);
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  let now = Date.UTC(2026, 6, 26, 12, 0, 0);
  let id = 0;
  const state = createStateStore({
    file: path.join(directory, 'state.sqlite3'),
    clock: () => now,
    idFactory: prefix => `${prefix}-fixture-${String(++id).padStart(8, '0')}`
  });
  const task = state.submitTask({
    queue: 'p12', type: 'capability', idempotencyKey: `p12-fixture-${label}`,
    payload: { title: 'P12 fixture', objective: 'Verify capability profiles.' }
  }).task;
  const catalog = {
    tools: [
      { name: 'task.get', effect: 'local-read', approvalEligible: false, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
      { name: 'web.search', effect: 'external-read', approvalEligible: false, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
      { name: 'github.issue_create', effect: 'external-write', approvalEligible: true, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }
    ],
    roots: [{ id: 'fixture-project', path: project }],
    domains: ['api.example.test'],
    httpMethods: ['GET', 'POST'],
    commandIds: ['test.unit'],
    secretHandles: ['fixture_vault_handle'],
    externalActions: ['github.issue_create']
  };
  const configuration = {
    schemaVersion: 1,
    profiles: [{
      id: 'fixture-base',
      tools: ['task.get', 'web.search', 'github.issue_create'],
      roots: ['fixture-project'],
      domains: ['api.example.test'],
      httpMethods: ['GET', 'POST'],
      commandIds: ['test.unit'],
      secretHandles: ['fixture_vault_handle'],
      externalActions: ['github.issue_create'],
      approvalRequiredActions: ['github.issue_create'],
      deniedTools: [],
      completionCriteria: ['verified'],
      maxTtlMs: 60_000
    }]
  };
  return {
    directory, project, state, catalog, configuration, taskId: task.id,
    now: () => now, advance: milliseconds => { now += milliseconds; },
    close() { state.close(); }
  };
}

function compile(test, overrides = {}) {
  return capability.compileManifest({
    profileId: 'fixture.profile', version: 1, taskId: test.taskId,
    baseProfileId: 'fixture-base',
    requested: {
      tools: ['task.get', 'web.search', 'github.issue_create'],
      roots: ['fixture-project'], domains: ['api.example.test'], httpMethods: ['GET'],
      commandIds: ['test.unit'], secretHandles: ['fixture_vault_handle'],
      externalActions: ['github.issue_create'], approvalRequiredActions: ['github.issue_create'],
      completionCriteria: ['verified'], expiresAtMs: test.now() + 30_000
    },
    ...overrides
  }, { catalog: test.catalog, configuration: test.configuration, now: test.now });
}

try {
  {
    // Metadata is consumed as JSON by both MCP and the immutable capability
    // catalog. Do not silently drop non-JSON fields just to make hashing pass.
    const { TOOL_REGISTRY } = require('../src/lib/tool-registry');
    const descriptor = TOOL_REGISTRY.find(tool => tool.name === 'system.resource_advice');
    assert.ok(descriptor, 'the resource-advice tool must be present');
    const catalog = { tools: [{
      name: descriptor.name, effect: descriptor.effect,
      approvalEligible: descriptor.approvalEligible, inputSchema: descriptor.baseInputSchema
    }] };
    const normalized = capability.normalizeCatalog(catalog);
    assert.match(normalized.tools.get(descriptor.name).inputSchemaHash, /^[a-f0-9]{64}$/);
    for (const field of ['provider', 'decision']) {
      assert.equal(typeof descriptor.baseInputSchema.properties[field].description, 'string', field);
      const malformed = structuredClone(catalog);
      malformed.tools[0].inputSchema.properties[field].description = undefined;
      expectCode(() => capability.normalizeCatalog(malformed), 'CAPABILITY_MANIFEST_INVALID');
    }
    const changed = structuredClone(catalog);
    changed.tools[0].inputSchema.properties.decision.enum = ['hold'];
    assert.notEqual(capability.normalizeCatalog(changed).hash, normalized.hash,
      'the actual allowed decisions are bound into catalog identity');
  }

  {
    const test = fixture('canonical');
    try {
      const first = compile(test);
      const reordered = capability.compileManifest({
        profileId: 'fixture.profile', version: 1, taskId: test.taskId, baseProfileId: 'fixture-base',
        requested: {
          tools: ['github.issue_create', 'task.get', 'web.search'], roots: ['fixture-project'],
          domains: ['api.example.test'], httpMethods: ['GET'], commandIds: ['test.unit'],
          secretHandles: ['fixture_vault_handle'], externalActions: ['github.issue_create'],
          approvalRequiredActions: ['github.issue_create'], completionCriteria: ['verified'], expiresAtMs: test.now() + 30_000
        }
      }, { catalog: test.catalog, configuration: test.configuration, now: test.now });
      assert.equal(first.manifestHash, reordered.manifestHash, 'canonical ordering must not change a manifest hash');
      const modified = compile(test, {
        requested: {
          tools: ['task.get'], roots: ['fixture-project'], domains: ['api.example.test'], httpMethods: ['GET'],
          commandIds: ['test.unit'], secretHandles: ['fixture_vault_handle'], externalActions: [],
          approvalRequiredActions: [], completionCriteria: ['verified'], expiresAtMs: test.now() + 20_000
        }
      });
      assert.notEqual(first.manifestHash, modified.manifestHash, 'a material manifest change must change the hash');
      assert.equal(first.manifest.grants.secretHandles[0], 'fixture_vault_handle');
      assert.doesNotMatch(JSON.stringify(first.manifest), /TOOLSENABLED_CANARY_|Bearer |PRIVATE KEY/);
    } finally { test.close(); }
  }

  {
    const test = fixture('scope');
    try {
      const compiled = compile(test);
      const stored = test.state.createCapabilityProfile({ manifest: compiled.manifest });
      assert.equal(stored.replayed, false);
      assert.equal(test.state.createCapabilityProfile({ manifest: compiled.manifest }).replayed, true, 'exact immutable profile replay is safe');
      const profile = test.state.getCapabilityProfile({ profileId: 'fixture.profile', version: 1 });
      assert.equal(profile.manifestHash, compiled.manifestHash);
      const constrainedRequest = {
        taskId: test.taskId, tool: 'github.issue_create', rootId: 'fixture-project', domain: 'api.example.test', httpMethod: 'GET',
        commandId: 'test.unit', secretHandle: 'fixture_vault_handle', externalAction: 'github.issue_create'
      };
      const authorized = capability.authorize(profile.manifest, profile.status, constrainedRequest, { now: test.now() });
      assert.match(authorized.requestHash, /^[a-f0-9]{64}$/);
      for (const selector of ['rootId', 'domain', 'httpMethod', 'commandId', 'secretHandle', 'externalAction']) {
        const omitted = { ...constrainedRequest };
        delete omitted[selector];
        expectCode(() => capability.authorize(profile.manifest, profile.status, omitted, { now: test.now() }), 'CAPABILITY_MANIFEST_SELECTOR_REQUIRED');
      }
      const inside = path.join(test.project, 'inside.txt');
      fs.writeFileSync(inside, 'fixture', 'utf8');
      const targetAuthorized = capability.authorize(profile.manifest, profile.status, {
        ...constrainedRequest, tool: 'task.get', targetPath: inside
      }, { now: test.now() });
      assert.match(targetAuthorized.request.targetPathHash, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(targetAuthorized), /inside\.txt/);
      expectCode(() => capability.authorize(profile.manifest, profile.status, {
        taskId: test.taskId, tool: 'task.get', domain: 'api.example.test', httpMethod: 'GET', commandId: 'test.unit', secretHandle: 'fixture_vault_handle', externalAction: 'github.issue_create', targetPath: inside
      }, { now: test.now() }), 'CAPABILITY_MANIFEST_SELECTOR_REQUIRED');
      expectCode(() => capability.authorize(profile.manifest, profile.status, {
        ...constrainedRequest, tool: 'task.get', targetPath: test.directory
      }, { now: test.now() }), 'CAPABILITY_MANIFEST_SCOPE_DENIED');
      expectCode(() => capability.authorize(profile.manifest, profile.status, {
        ...constrainedRequest, domain: 'persuasive-evil.example.test'
      }, { now: test.now() }), 'CAPABILITY_MANIFEST_SCOPE_DENIED');
      expectCode(() => capability.authorize(profile.manifest, profile.status, {
        taskId: 'other-task-0001', tool: 'task.get'
      }, { now: test.now() }), 'CAPABILITY_MANIFEST_BINDING_MISMATCH');
      expectCode(() => capability.authorize(profile.manifest, profile.status, {
        taskId: test.taskId, tool: 'github.issue_create'
      }, { now: test.now() }), 'CAPABILITY_MANIFEST_SELECTOR_REQUIRED');
      expectCode(() => capability.compileManifest({
        profileId: 'denied.scope', version: 1, taskId: test.taskId, baseProfileId: 'fixture-base',
        requested: { tools: ['github.issue_create'], domains: ['persuasive-evil.example.test'], expiresAtMs: test.now() + 1_000 }
      }, { catalog: test.catalog, configuration: test.configuration, now: test.now }), 'CAPABILITY_MANIFEST_SCOPE_DENIED');
      const inspection = capability.inspect(profile.manifest, profile.status);
      assert.equal(inspection.grants.secretHandles[0].value, '[VAULT-HANDLE]');
      assert.doesNotMatch(JSON.stringify(inspection), /TOOLSENABLED_CANARY_|fixture-secret-value/);

      const web = compile(test, {
        profileId: 'web.profile',
        requested: { tools: ['web.search'], roots: [], domains: ['api.example.test'], httpMethods: ['GET'], commandIds: [], secretHandles: [], externalActions: [], approvalRequiredActions: [], completionCriteria: ['verified'], expiresAtMs: test.now() + 20_000 }
      });
      test.state.createCapabilityProfile({ manifest: web.manifest });
      const webProfile = test.state.getCapabilityProfile({ profileId: 'web.profile', version: 1 });
      expectCode(() => capability.authorize(webProfile.manifest, webProfile.status, { taskId: test.taskId, tool: 'web.search', httpMethod: 'GET' }, { now: test.now() }), 'CAPABILITY_MANIFEST_SELECTOR_REQUIRED');
      expectCode(() => capability.authorize(webProfile.manifest, webProfile.status, { taskId: test.taskId, tool: 'web.search', domain: 'api.example.test' }, { now: test.now() }), 'CAPABILITY_MANIFEST_SELECTOR_REQUIRED');
      assert.match(capability.authorize(webProfile.manifest, webProfile.status, { taskId: test.taskId, tool: 'web.search', domain: 'api.example.test', httpMethod: 'GET' }, { now: test.now() }).requestHash, /^[a-f0-9]{64}$/);
      const unconstrained = compile(test, {
        profileId: 'unconstrained.profile',
        requested: { tools: ['task.get'], roots: [], domains: [], httpMethods: [], commandIds: [], secretHandles: [], externalActions: [], approvalRequiredActions: [], completionCriteria: ['verified'], expiresAtMs: test.now() + 20_000 }
      });
      test.state.createCapabilityProfile({ manifest: unconstrained.manifest });
      assert.match(capability.authorize(unconstrained.manifest, { revoked: false }, { taskId: test.taskId, tool: 'task.get' }, { now: test.now() }).requestHash, /^[a-f0-9]{64}$/);
    } finally { test.close(); }
  }

  {
    const test = fixture('versions');
    try {
      const first = compile(test);
      test.state.createCapabilityProfile({ manifest: first.manifest });
      const second = capability.compileManifest({
        profileId: 'fixture.profile', version: 2, taskId: test.taskId, baseProfileId: 'fixture-base', parentHash: first.manifestHash,
        requested: { tools: ['task.get'], roots: [], domains: [], httpMethods: [], commandIds: [], secretHandles: [], externalActions: [], approvalRequiredActions: [], completionCriteria: ['verified'], expiresAtMs: test.now() + 10_000 }
      }, { catalog: test.catalog, configuration: test.configuration, now: test.now });
      test.state.createCapabilityProfile({ manifest: second.manifest });
      assert.notEqual(first.manifestHash, second.manifestHash);
      expectCode(() => test.state.createCapabilityProfile({ manifest: { ...second.manifest, grants: { ...second.manifest.grants, domains: ['api.example.test'] } } }), 'CAPABILITY_MANIFEST_VERSION_CONFLICT');
      const expansion = capability.expansionRequest(second.manifest, {
        reason: 'Need a new bounded read target.', requested: { domains: ['new.example.test'] }, expectedAction: 'read one documented endpoint'
      });
      assert.equal(expansion.grantsAuthority, false);
      assert.match(expansion.requestHash, /^[a-f0-9]{64}$/);
      expectCode(() => capability.authorize(second.manifest, { revoked: false }, { taskId: test.taskId, tool: 'web.search' }, { now: test.now() }), 'CAPABILITY_MANIFEST_SCOPE_DENIED');
    } finally { test.close(); }
  }

  {
    const test = fixture('expiry-revoke');
    try {
      const compiled = compile(test);
      test.state.createCapabilityProfile({ manifest: compiled.manifest });
      test.advance(30_000);
      const expired = test.state.getCapabilityProfile({ profileId: 'fixture.profile', version: 1 });
      expectCode(() => capability.authorize(expired.manifest, expired.status, { taskId: test.taskId, tool: 'task.get' }, { now: test.now() }), 'CAPABILITY_MANIFEST_EXPIRED');
      const boundary = compile(test, {
        profileId: 'expiry.boundary',
        requested: { tools: ['task.get'], roots: [], domains: [], httpMethods: [], commandIds: [], secretHandles: [], externalActions: [], approvalRequiredActions: [], completionCriteria: ['verified'], expiresAtMs: test.now() + 1 }
      });
      test.state.createCapabilityProfile({ manifest: boundary.manifest });
      const boundaryProfile = test.state.getCapabilityProfile({ profileId: 'expiry.boundary', version: 1 });
      const pureAuthorization = capability.authorize(boundaryProfile.manifest, boundaryProfile.status, { taskId: test.taskId, tool: 'task.get' }, { now: test.now() });
      const transaction = test.state.transaction;
      let advancedAtBegin = false;
      test.state.transaction = function advanceClockAfterBegin(callback) {
        return transaction.call(this, db => {
          if (!advancedAtBegin) {
            advancedAtBegin = true;
            test.advance(1);
          }
          return callback(db);
        });
      };
      try {
        expectCode(() => test.state.authorizeCapabilityProfileRequest({
          requestId: 'boundary-tool-0001', taskId: test.taskId, bindingKind: 'tool', profileId: 'expiry.boundary', profileVersion: 1,
          profileHash: pureAuthorization.profileHash, requestHash: pureAuthorization.requestHash, request: pureAuthorization
        }), 'CAPABILITY_MANIFEST_EXPIRED');
      } finally {
        test.state.transaction = transaction;
      }
      assert.equal(advancedAtBegin, true, 'the clock must advance only after BEGIN IMMEDIATE');
      expectCode(() => test.state.bindCapabilityProfile({
        taskId: test.taskId, bindingKind: 'tool', bindingId: 'boundary-bind-0001', profileId: 'expiry.boundary', profileVersion: 1,
        profileHash: pureAuthorization.profileHash
      }), 'CAPABILITY_MANIFEST_EXPIRED');
      expectCode(() => test.state.recordCapabilityProfileRequest({
        requestId: 'boundary-record-0001', taskId: test.taskId, requestKind: 'tool', profileId: 'expiry.boundary', profileVersion: 1,
        profileHash: pureAuthorization.profileHash, requestHash: pureAuthorization.requestHash, request: pureAuthorization, status: 'authorized'
      }), 'CAPABILITY_MANIFEST_EXPIRED');
      const active = compile(test, { profileId: 'active.profile' });
      test.state.createCapabilityProfile({ manifest: active.manifest });
      const revoked = test.state.revokeCapabilityProfile({ profileId: 'active.profile', version: 1, profileHash: active.manifestHash, reasonCode: 'owner-stop' });
      assert.equal(revoked.replayed, false);
      const revokedProfile = test.state.getCapabilityProfile({ profileId: 'active.profile', version: 1 });
      expectCode(() => capability.authorize(revokedProfile.manifest, revokedProfile.status, { taskId: test.taskId, tool: 'task.get' }, { now: test.now() }), 'CAPABILITY_MANIFEST_REVOKED');
      assert.equal(test.state.revokeCapabilityProfile({ profileId: 'active.profile', version: 1, profileHash: active.manifestHash, reasonCode: 'owner-stop' }).replayed, true);
    } finally { test.close(); }
  }

  {
    const test = fixture('provider');
    try {
      const auditEvents = [];
      const dependencies = {
        state: test.state, catalog: test.catalog, configuration: capability.normalizeConfiguration(test.configuration, capability.normalizeCatalog(test.catalog)),
        now: test.now, enabled: true, auditWrite: (event, options) => { auditEvents.push({ event, options }); return { durable: true }; }
      };
      const compiled = provider.compile({
        profileId: 'provider.profile', version: 1, taskId: test.taskId, baseProfileId: 'fixture-base',
        requested: { tools: ['task.get'], roots: [], domains: [], httpMethods: [], commandIds: [], secretHandles: [], externalActions: [], approvalRequiredActions: [], completionCriteria: ['verified'], expiresAtMs: test.now() + 10_000 }
      }, dependencies);
      assert.match(compiled.manifestHash, /^[a-f0-9]{64}$/);
      const request = provider.authorizeBoundRequest({
        requestId: 'tool-request-0001', requestKind: 'tool', profileId: 'provider.profile', version: 1,
        request: { taskId: test.taskId, tool: 'task.get' }
      }, dependencies);
      assert.match(request.requestHash, /^[a-f0-9]{64}$/);
      const listed = test.state.listCapabilityProfiles({ taskId: test.taskId });
      assert.equal(listed.length, 1, 'a reviewer can reconstruct every profile recorded for a task');
      const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'capability-profile.js'), 'list', '--task-id', test.taskId], {
        encoding: 'utf8', env: { ...process.env, TOOLSENABLED_STATE_PATH: path.join(test.directory, 'state.sqlite3') }
      });
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stdout, /provider\.profile/);
      assert.match(cli.stdout, /\[VAULT-HANDLE\]|"secretHandles": \[\]/);
      assert.equal(auditEvents.length, 2, 'compile and request emit P11-safe hash-only events');
      for (const item of auditEvents) {
        assert.equal(item.event.kind, 'capability.profile');
        assert.doesNotMatch(JSON.stringify(item.event), /fixture-secret-value|TOOLSENABLED_CANARY_/);
      }
      expectCode(() => provider.authorizeBoundRequest({
        requestId: 'tool-request-0002', requestKind: 'tool', profileId: 'provider.profile', version: 1,
        request: { taskId: test.taskId, tool: 'task.get' }
      }, { ...dependencies, enabled: false }), 'CAPABILITY_MANIFESTS_DISABLED');
      const peer = createStateStore({ file: path.join(test.directory, 'state.sqlite3'), clock: test.now, idFactory: prefix => `${prefix}-peer-00000001` });
      try {
        const providerProfile = peer.getCapabilityProfile({ profileId: 'provider.profile', version: 1 });
        const authorizedRaw = capability.authorize(providerProfile.manifest, providerProfile.status, { taskId: test.taskId, tool: 'task.get' }, { now: test.now() });
        assert.equal(peer.authorizeCapabilityProfileRequest({
          requestId: 'tool-request-0001', taskId: test.taskId, bindingKind: 'tool', profileId: 'provider.profile', profileVersion: 1,
          profileHash: authorizedRaw.profileHash, requestHash: authorizedRaw.requestHash, request: authorizedRaw
        }).replayed, true, 'a same-ID concurrent retry converges on the immutable request record');
        provider.revoke({ profileId: 'provider.profile', version: 1, reasonCode: 'owner-stop' }, dependencies);
        expectCode(() => peer.authorizeCapabilityProfileRequest({
          requestId: 'tool-request-0003', taskId: test.taskId, bindingKind: 'tool', profileId: 'provider.profile', profileVersion: 1,
          profileHash: authorizedRaw.profileHash, requestHash: authorizedRaw.requestHash, request: authorizedRaw
        }), 'CAPABILITY_MANIFEST_REVOKED');
      } finally { peer.close(); }
      const configured = provider.compile({
        profileId: 'configured.profile', version: 1, taskId: test.taskId, baseProfileId: 'p12-readonly',
        requested: { tools: ['task.get'], roots: [], domains: [], httpMethods: [], commandIds: [], secretHandles: [], externalActions: [], approvalRequiredActions: [], completionCriteria: ['evidence-reviewed'], expiresAtMs: test.now() + 10_000 }
      }, { state: test.state, now: test.now, auditWrite: dependencies.auditWrite });
      assert.equal(configured.profile.baseProfileId, 'p12-readonly', 'the checked-in named base profile compiles against the live registry metadata');
    } finally { test.close(); }
  }

  {
    const test = fixture('provider-audit-failure');
    try {
      expectCode(() => provider.compile({
        profileId: 'audit.failure.profile', version: 1, taskId: test.taskId, baseProfileId: 'fixture-base',
        requested: { tools: ['task.get'], roots: [], domains: [], httpMethods: [], commandIds: [], secretHandles: [], externalActions: [], approvalRequiredActions: [], completionCriteria: ['verified'], expiresAtMs: test.now() + 10_000 }
      }, {
        state: test.state, catalog: test.catalog,
        configuration: capability.normalizeConfiguration(test.configuration, capability.normalizeCatalog(test.catalog)),
        now: test.now, auditWrite: () => ({ durable: false, errors: [{ sink: 'canonical' }] })
      }), 'CAPABILITY_MANIFEST_AUDIT_UNAVAILABLE');
    } finally { test.close(); }
  }

  {
    const test = fixture('immutability');
    try {
      const compiled = compile(test);
      test.state.createCapabilityProfile({ manifest: compiled.manifest });
      expectCode(() => test.state.transaction(db => db.prepare(`UPDATE capability_profile_versions SET expires_at_ms = expires_at_ms + 1 WHERE profile_id = 'fixture.profile'`).run()), 'STATE_CONSTRAINT');
      expectCode(() => test.state.transaction(db => db.prepare(`DELETE FROM capability_profile_versions WHERE profile_id = 'fixture.profile'`).run()), 'STATE_CONSTRAINT');
      const file = path.join(test.directory, 'state.sqlite3');
      test.state.transaction(db => db.exec(`DROP TABLE scoped_approval_events; DROP TABLE scoped_approval_grants; DROP TABLE scoped_approval_actions; DROP TABLE scoped_approval_provenance; DROP TABLE policy_dispatch_consumptions; DROP TABLE policy_dispatch_authorizations; DROP TABLE capability_profile_revocations; DROP TABLE capability_profile_requests; DROP TABLE capability_profile_bindings; DROP TABLE capability_profile_versions; DROP TABLE research_findings; DROP TABLE research_results; DROP TABLE research_runs; DROP TABLE research_experiments; DROP TABLE research_project_sessions; DROP TABLE research_projects; ${RESTORE_TELEGRAM_TABLES_V1}${RESTORE_LEGACY_MISSION_NAMES}PRAGMA user_version = 11;`));
      test.state.close();
      const reopened = createStateStore({ file, clock: test.now, idFactory: prefix => `${prefix}-reopen-00000001` });
      assert.equal(reopened.health().schemaVersion, SCHEMA_VERSION, 'schema 11 state must migrate additively through P12, P13, and P14 approval binding');
      reopened.close();
    } finally { try { test.close(); } catch { /* already closed */ } }
  }

  console.log('Unified-agent P12 capability-manifest check passed (canonical profiles, scope, expiry, revocation, immutability, migration, and P11-safe audit binding).');
} finally {
  for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
}
