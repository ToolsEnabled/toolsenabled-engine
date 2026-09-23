'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMissionActions, isOutwardMissionBridgeAction } = require('../src/lib/mission-bridge/actions');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

const org = declaredOrg();
const controllerActor = enabledControllerId(org);
const RUN_ID = 'a'.repeat(32);
const PID = 4242;

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
async function rejectsGuard(fn, action) {
  assertions += 1;
  await assert.rejects(fn, error => error?.code === 'BRIDGE_GUARD_REFUSED' && error?.status === 409,
    `${action} must be refused by the active kill switch`);
}

function auditFixture() {
  const events = [];
  const append = (action, target, details, extra = {}) => {
    const sequence = events.length + 1;
    const event = { action, target, details, sequence, ...extra };
    event.eventHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
    events.push(event);
    return event;
  };
  return {
    findEvents({ action, target, limit = 20 } = {}) {
      return events.filter(event => (!action || event.action === action) && (!target || event.target === target)).slice(-limit);
    },
    requireRecord(action, target, details) {
      const event = append(action, target, details);
      return { durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash };
    },
    conditionalRecord({ action, target, eventId, decide }) {
      const outcome = decide({ findEvents: this.findEvents.bind(this) });
      if (outcome.kind === 'refused') return { recorded: false, refusal: outcome.refusal };
      const event = append(action, target, outcome.details, { eventId });
      return { recorded: true, durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash };
    }
  };
}

function killSwitchPolicy(calls) {
  return {
    assertActive(action, options) {
      calls.push({ action, options });
      if (options.outward !== false) throw new Error(`KILLSWITCH is active. '${action}' was not executed.`);
    }
  };
}

function presenceSequence(...registries) {
  let index = 0;
  return {
    readRegistry() { return registries[Math.min(index++, registries.length - 1)]; }
  };
}

async function main() {
  ok(controllerActor, 'organization fixture declares an enabled controller');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-bridge-killswitch-'));
  const reportFile = path.join(root, 'P5-REPORT.md');
  fs.writeFileSync(reportFile, '# Kill-switch report fixture\n', 'utf8');

  const policyCalls = [];
  const audit = auditFixture();
  const running = { agents: { luna: { runId: RUN_ID, pid: PID, status: 'running' } } };
  const terminal = { agents: { luna: { runId: RUN_ID, pid: PID, status: 'finished', exitCode: 0, terminalAt: new Date(0).toISOString() } } };
  const alive = [true, false];
  const actions = createMissionActions({
    roots: { primary: root },
    actor: controllerActor,
    audit,
    policy: killSwitchPolicy(policyCalls),
    executeTool: async (name, input) => {
      if (name === 'host.read_file') {
        const content = fs.readFileSync(input.path, 'utf8');
        return { path: input.path, content, bytes: Buffer.byteLength(content, 'utf8') };
      }
      if (name === 'memory.set') return { namespace: input.namespace, key: input.key, revision: 1 };
      throw new Error(`Unexpected tool call: ${name}`);
    },
    terminateDependencies: {
      presence: presenceSequence(running, running, terminal),
      assertAuthorized: () => {},
      isAlive: () => alive.shift() ?? false,
      terminateProcess: async () => ({ exitCode: 0 }),
      pollMs: 1,
      processGoneTimeoutMs: 2,
      terminalTimeoutMs: 2,
      delay: async () => {}
    }
  });

  try {
    await rejectsGuard(() => actions.dispatch({
      rootId: 'primary', tier: 'luna', objectiveRef: 'kill-switch-dispatch', brief: 'must not run',
      cap: { kind: 'turns', value: 1, capMs: 1_000 }
    }), 'dispatch');
    await rejectsGuard(() => actions.queue({
      rootId: 'primary', expectedHash: 'fixture', phaseId: 'Q1', operation: 'claim'
    }), 'queue');
    await rejectsGuard(() => actions.reply({
      idempotencyKey: 'kill-switch-reply', threadId: 'owner-thread', message: 'must not persist'
    }), 'thread-reply');
    await rejectsGuard(() => actions.decide({
      idempotencyKey: 'kill-switch-decision', target: 'R1162', decision: 'approve', reason: 'must not persist'
    }), 'decision');
    await rejectsGuard(() => actions.ledgerArchive({ operation: 'archive', dryRun: true }), 'ledger-archive');

    const report = await actions.readReport({ rootId: 'primary', relativePath: 'P5-REPORT.md' });
    equal(report.ok, true, 'report-read remains available during a kill event');
    const terminated = await actions.terminate({
      idempotencyKey: 'kill-switch-terminate', agentId: 'luna', expectedRunId: RUN_ID, expectedPid: PID
    });
    equal(terminated.ok, true, 'terminate remains available during a kill event');
    const status = await actions.status();
    equal(status.ok, true, 'status remains available during a kill event');
    /* A kill event is exactly when someone needs to know what the lanes they
     * already started are doing. Refusing this read would leave a person who has
     * just pulled the switch with no way to see whether it worked. */
    const outcome = await actions.launchStatus({ launchId: `launch_${'k'.repeat(32)}` });
    equal(outcome.ok, true, 'launch-status remains available during a kill event');

    const classifications = Object.fromEntries(policyCalls.map(call => [call.action, call.options.outward]));
    equal(classifications['mission.bridge.dispatch'], true, 'dispatch is outward');
    equal(classifications['mission.bridge.queue'], true, 'queue is outward');
    equal(classifications['mission.bridge.thread-reply'], true, 'thread-reply is outward');
    equal(classifications['mission.bridge.decision'], true, 'decision is outward');
    equal(classifications['mission.bridge.ledger-archive'], true, 'ledger-archive is outward');
    equal(classifications['mission.bridge.report-read'], false, 'report-read is non-outward');
    equal(classifications['mission.bridge.launch-status'], false, 'launch-status is non-outward');
    equal(classifications['mission.bridge.terminate'], false, 'terminate is non-outward');
    equal(classifications['mission.bridge.status'], false, 'status is non-outward');

    equal(isOutwardMissionBridgeAction('future-action'), true, 'unknown future action is outward by default');
    assert.throws(
      () => killSwitchPolicy(policyCalls).assertActive('mission.bridge.future-action', { outward: isOutwardMissionBridgeAction('future-action') }),
      /KILLSWITCH is active/,
      'unknown future actions fail closed as outward while the kill switch is active'
    );
    assertions += 1;

    process.stdout.write(`mission bridge kill switch: ${assertions} assertions passed\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error?.code || 'ERROR'}: ${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
