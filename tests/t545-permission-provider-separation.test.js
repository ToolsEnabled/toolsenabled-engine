'use strict';

// T545 (engine permission integrity): the first-run fail-closed 'guided'
// ceiling and the MCP tool-surface staleness diagnostic are each driven
// against the REAL dispatch seam (src/mcp-server.js#processLine) here, so a
// future change cannot quietly wire either one into refusing an ordinary
// call without this suite going red.
//
// WHY THIS EXISTS. Takeover memory reported MCP_TOOL_SURFACE_INSTANCE_
// UNVERIFIABLE after a restart (12 observed, 0 fresh) as a T545 concern.
// Reading src/lib/mcp-tool-surface.js and src/mcp-server.js#dispatch()
// together showed the diagnostic is produced by mcpToolSurfaceStatus() for
// system.doctor/system.status alone and is never read on the tools/call
// path -- dispatch()'s own comment states it plainly ("THE ADVERTISED
// SURFACE IS NARROWED BY THE TIER; THE CALL PATH IS NOT"). The first test
// below drives a reproduction of the measured "12 observed, 0 fresh" shape
// rather than trusting that source reading to stay true under a later edit.
//
// The second test pins the other T545 claim: a machine record recorded at
// 'standard' (what Settings labels Basic) resolves through the interactive
// resolver to its own workspace session, never to the first-run fail-closed
// 'guided' ceiling that only an ABSENT record produces.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

// This suite proves dispatch/tier behavior, not disk durability. Keep its real
// StateStore in memory to avoid SQLite journal deletion; retain the real machine
// record fixture. Configure directly so no teardown removal is registered.
const isolation = require('./lib/isolated-environment');
const isolated = { root: isolation.configure(fs.mkdtempSync(path.join(isolation.isolatedTemporaryRoot(), 't545-retained-'))) };
process.env.TOOLSENABLED_STATE_PATH = ':memory:';

const mcpServer = require('../src/mcp-server');
const policy = require('../src/lib/permission-tier-policy');
const machineRecord = require('../src/lib/setup/machine-record');
const surface = require('../src/lib/mcp-tool-surface');
const { getStateStore } = require('../src/lib/state-store');

const FAKE_DIGEST = 'a'.repeat(64);

async function callThroughServer(name, args, permissionSession) {
  let response = null;
  await mcpServer.processLine(
    JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
    value => { response = value; },
    { permissionSession }
  );
  assert.ok(response, `${name}: the server produced no response`);
  return response;
}

// Mirrors the proven pattern in tests/install-tier-enforcement.test.js
// serverVerdict(): a tier refusal is not confined to content[0].text (the
// closed error taxonomy may show only a fixed safe sentence there), but
// structuredContent.error.code always carries the real PERMISSION_* code, so
// matching the whole serialized response is what actually distinguishes an
// admitted call from a refused one.
function assertAdmitted(response, label) {
  assert.equal(response.error, undefined, `${label}: unexpected JSON-RPC protocol error ${JSON.stringify(response.error)}`);
  assert.ok(response.result, `${label}: tools/call produced no result`);
  assert.notEqual(response.result.isError, true, `${label}: the call was refused: ${JSON.stringify(response.result)}`);
  return response.result;
}

test('a stale/unverifiable MCP tool-surface diagnostic does not reach or refuse an ordinary tools/call dispatch', async () => {
  // Reproduce the measured shape: 12 observed instance records, all
  // unverifiable. startTicks: null is classifyInstance()'s own "this
  // process cannot be checked" case (mcp-tool-surface.js), which is a valid,
  // schema-accepted record shape (validRecord() explicitly allows null) and
  // is classified 'unknown' before any process lookup or digest comparison
  // runs -- exactly the class of record a restart leaves behind.
  const instances = Array.from({ length: 12 }, (_, index) => ({
    schemaVersion: 1,
    instanceId: crypto.randomUUID(),
    transport: index % 2 === 0 ? 'stdio-direct' : 'owner-host',
    pid: 1000 + index,
    startTicks: null,
    bootedAtMs: index,
    registryContentSha256: FAKE_DIGEST,
    profileSha256: FAKE_DIGEST,
    surfaceSha256: FAKE_DIGEST,
    toolCount: 0
  }));
  const state = getStateStore();
  state.setMemory({
    namespace: surface.MEMORY_NAMESPACE,
    key: surface.MEMORY_KEY,
    value: { schemaVersion: surface.SCHEMA_VERSION, instances }
  });

  const diagnosed = surface.status({ tools: [] });
  assert.equal(diagnosed.state, 'unknown');
  assert.equal(diagnosed.reason, 'MCP_TOOL_SURFACE_INSTANCE_UNVERIFIABLE');
  assert.deepEqual(diagnosed.counts, { observed: 12, fresh: 0, stale: 0, unknown: 12, deadIgnored: 0 },
    'the fixture must reproduce the measured 12 observed / 0 fresh shape, not merely a nonzero one');

  // The diagnostic now reads exactly as memory reported. Dispatch one
  // ordinary call through the REAL server, on that same durable state, and
  // confirm it is admitted and answers for real -- not merely "no error",
  // which a swallowed exception could also produce.
  const response = await callThroughServer('system.kill_switch_status', {}, policy.installTierSession('standard'));
  const result = assertAdmitted(response, 'system.kill_switch_status while the surface diagnostic is unverifiable');
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(typeof parsed.active, 'boolean', 'the real kill-switch status must answer, not a stub');
  assert.equal(parsed.active, false, 'the isolated fixture carries no kill file');
  assert.doesNotMatch(JSON.stringify(response), /MCP_TOOL_SURFACE/,
    'an unverifiable tool-surface diagnostic must never surface on the call path it does not gate');

  // status() itself must still read the same way after the dispatch: the
  // call path must not have consumed, cleared or otherwise mutated the
  // diagnostic it never touches.
  const diagnosedAfter = surface.status({ tools: [] });
  assert.deepEqual(diagnosedAfter.counts, diagnosed.counts,
    'dispatching an ordinary call must not mutate the tool-surface diagnostic it is architecturally separate from');
});

test('a recorded Basic/standard install resolves through the interactive resolver to its own workspace session, not the first-run guided ceiling', async () => {
  const servicesRootAbsent = path.join(isolated.root, 't545-absent-services');
  const absentSession = mcpServer.resolvePermissionSession({
    machineRecord: { resolveServicesRoot: () => servicesRootAbsent, readMachineRecord: () => null }
  });
  assert.deepEqual(
    { origin: absentSession.origin, tier: absentSession.tier, profile: absentSession.profile },
    { origin: 'local', tier: 'confined', profile: 'read-only' },
    'an install that never ran setup must still fail closed to guided -- this is the ceiling the next case must NOT inherit'
  );

  const servicesRoot = path.join(isolated.root, 't545-standard-services');
  const workspaceRoot = path.join(isolated.root, 't545-standard-workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const record = machineRecord.buildMachineRecord({
    tier: 'standard',
    installRoot: path.resolve(__dirname, '..'),
    servicesRoot,
    nodePath: process.execPath,
    workspaceRoots: [workspaceRoot]
  });
  machineRecord.writeMachineRecord(record, { servicesRoot });

  const standardSession = mcpServer.resolvePermissionSession({
    machineRecord: { resolveServicesRoot: () => servicesRoot, readMachineRecord: machineRecord.readMachineRecord }
  });
  assert.deepEqual(
    { origin: standardSession.origin, tier: standardSession.tier, profile: standardSession.profile },
    { origin: 'local', tier: 'confined', profile: 'workspace' },
    'a machine that recorded Basic (standard) must resolve to its own workspace session, never to the read-only first-run ceiling'
  );

  // "Ordinary work" means an ordinary WRITE is admitted, which is exactly
  // what the read-only ceiling refuses -- see
  // tests/mcp-call-permission-session.test.js: "a fresh unconfigured
  // instance must actually apply its read-only permission session" refuses
  // this same tool with PERMISSION_CONFINED_EFFECT_REFUSED. Dispatched here
  // at the recorded Basic/standard level, it must go through instead.
  const response = await callThroughServer(
    'memory.set',
    { namespace: 't545-fixture', key: 'ordinary-write', value: 'ok' },
    standardSession
  );
  assertAdmitted(response, 'memory.set at the recorded Basic/standard level');
  assert.doesNotMatch(JSON.stringify(response), /PERMISSION_[A-Z_]+/,
    'the recorded Basic/standard level must admit an ordinary write, not refuse it as the first-run guided ceiling would');
});
