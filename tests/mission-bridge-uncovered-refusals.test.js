'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { activate } = require('./lib/isolated-environment');
const {
  MAX_REASON_BYTES,
  MAX_BRIEF_BYTES,
  authorizedMissionAgent,
  createMissionActions,
  declaredLane
} = require('../src/lib/mission-bridge/actions');
const agentOrg = require('../src/lib/agent-org');
const { INSTALL_TIER_SESSIONS } = require('../src/lib/permission-tier-policy');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

let assertions = 0;
function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}
async function refusal(operation, code) {
  assertions += 1;
  await assert.rejects(operation, error => error?.code === code, `expected ${code}`);
}

const org = declaredOrg();
const actor = enabledControllerId(org);
activate('mission-bridge-uncovered-refusals');
const root = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'mission-bridge-refusals-'));
const effects = { execute: 0, append: 0, transition: 0, spawn: 0, audit: 0 };

function actions(overrides = {}) {
  return createMissionActions({
    roots: { repo: root },
    actor,
    agentOrg: org,
    permissionSession: INSTALL_TIER_SESSIONS.unrestricted,
    policy: { assertActive() {} },
    audit: {
      requireRecord() {
        effects.audit += 1;
        return { durable: true, anchored: true, sequence: 1, eventHash: 'a'.repeat(64) };
      },
      findEvents() { return []; }
    },
    executeTool: async () => { effects.execute += 1; return null; },
    appendQueuePhase: () => { effects.append += 1; return null; },
    transitionQueuePhase: () => { effects.transition += 1; return null; },
    spawn: () => { effects.spawn += 1; throw new Error('spawn must not be reached'); },
    researchActions: {},
    machinesActions: {},
    ...overrides
  });
}

async function main() {
  // The public authority helper must translate an unusable declaration rather
  // than accidentally selecting or authorizing an actor from it.
  await refusal(() => Promise.resolve().then(() => authorizedMissionAgent(actor, { schemaVersion: 1 })),
    'BRIDGE_ACTOR_AUTHORITY_UNAVAILABLE');

  const luna = org.agents.find(agent => agent.id === 'luna');
  const roleOrg = agentOrg.normalizeOrg({
    ...org,
    agents: org.agents.map(agent => agent.id === 'luna' ? { ...agent, role: 'future-role' } : agent)
  }, { knownRoles: [{ id: 'future-role', baseDefaultRole: 'manager' }] });
  equal(declaredLane(roleOrg, 'luna', { readRegistry: () => ({ agents: {} }) }).role, 'future-role',
    'a normalized customer role reaches the generic lane projection without a hard-coded role allowlist');

  const reportingOrg = {
    ...org,
    agents: org.agents.map(agent => ({ ...agent })),
    relationships: org.relationships.filter(relation => !(relation.type === 'manages' && relation.to === luna.id))
  };
  await refusal(() => Promise.resolve().then(() => declaredLane(reportingOrg, 'luna', { readRegistry: () => ({ agents: {} }) })),
    'BRIDGE_AGENT_REPORTING_LINE_MISSING');

  const beforeConstruction = { ...effects };
  await refusal(() => Promise.resolve().then(() => createMissionActions({ roots: {}, agentOrg: org,
    actor, permissionSession: INSTALL_TIER_SESSIONS.unrestricted })), 'BRIDGE_ROOTS_INVALID');
  equal(JSON.stringify(effects), JSON.stringify(beforeConstruction), 'invalid roots must have no side effects');

  const bridge = actions();
  const beforeLarge = { ...effects };
  await refusal(() => bridge.reply({ idempotencyKey: 'reply-1', threadId: 'thread-1', message: 'x'.repeat(MAX_REASON_BYTES + 1) }),
    'BRIDGE_INPUT_TOO_LARGE');
  equal(effects.execute, beforeLarge.execute, 'oversized input must not invoke the tool provider');
  equal(effects.spawn, beforeLarge.spawn, 'oversized input must not spawn');

  const beforeOpen = { ...effects };
  await refusal(() => bridge.queue({
    rootId: 'repo', expectedHash: 'a'.repeat(64), operation: 'open', title: 'Missing authority', brief: 'Record-only goal.'
  }), 'BRIDGE_INPUT_INVALID');
  equal(effects.append, beforeOpen.append, 'a goal open without authority must not reach the queue writer');
  equal(effects.audit, beforeOpen.audit, 'a goal open without provenance must not create an audit intent');

  await refusal(() => bridge.queue({
    rootId: 'repo', expectedHash: 'a'.repeat(64), operation: 'open', title: 'Oversized brief',
    authority: 'R1000 (directiveId: R1000)', brief: 'x'.repeat(MAX_BRIEF_BYTES + 1)
  }), 'BRIDGE_INPUT_TOO_LARGE');
  equal(effects.append, beforeOpen.append, 'an oversized goal brief must not reach the queue writer');

  const beforeReport = { ...effects };
  await refusal(() => bridge.readReport({ rootId: 'repo', relativePath: 'missing-REPORT.md' }), 'BRIDGE_REPORT_NOT_FOUND');
  equal(effects.execute, beforeReport.execute, 'missing reports must not invoke the file reader');
  equal(effects.spawn, beforeReport.spawn, 'missing reports must not spawn');

  const noAudit = actions({ audit: {} });
  const beforeAudit = { ...effects };
  await refusal(() => noAudit.queue({ rootId: 'repo', expectedHash: 'a'.repeat(64), phaseId: 'Q1', operation: 'claim' }),
    'BRIDGE_AUDIT_UNAVAILABLE');
  equal(effects.transition, beforeAudit.transition, 'audit refusal must happen before the queue writer');
  equal(effects.spawn, beforeAudit.spawn, 'audit refusal must not spawn');

  const unknown = actions({ executeTool: async () => { effects.execute += 1; return { namespace: 'wrong' }; } });
  const beforeUnknown = { ...effects };
  await refusal(() => unknown.reply({ idempotencyKey: 'reply-2', threadId: 'thread-2', message: 'hello' }),
    'BRIDGE_DEPENDENCY_UNKNOWN');
  equal(effects.execute, beforeUnknown.execute + 1, 'unknown provider result follows exactly one driven call');
  equal(effects.spawn, beforeUnknown.spawn, 'unknown provider result must not spawn');

  console.log(`mission bridge uncovered refusals: ${assertions} assertions`);
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
