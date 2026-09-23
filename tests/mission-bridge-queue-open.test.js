'use strict';

// /goal's engine half: open a durable queue phase under the existing CAS
// writer. This is deliberately record-only; dispatch remains a separate,
// explicitly bounded action owned by the worker loop.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { sha256 } = require('../src/lib/build-queue-writer');
const { INSTALL_TIER_SESSIONS } = require('../src/lib/permission-tier-policy');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

function fixtureQueue(actor) {
  return [
    '# Build queue',
    '',
    '## Completed',
    '',
    `- **Q1 - Prior work:** closed 2026-08-01 by ${actor} - fixture`,
    '',
    '## Q2 - Existing work',
    '',
    '**Status:** OPEN',
    '',
    '**Authority:** R1000 (directiveId: R1000)',
    '',
    '**Instructions (verbatim):**',
    '<!-- build-queue-writer:v1 bytes=8 -->',
    'existing',
    ''
  ].join('\n');
}

function auditFixture() {
  const events = [];
  return {
    events,
    requireRecord(action, target, details) {
      const event = { action, target, details, sequence: events.length + 1 };
      event.eventHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
      events.push(event);
      return { durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash };
    },
    findEvents() { return []; }
  };
}

async function main() {
  const org = declaredOrg();
  const actor = enabledControllerId(org);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-bridge-queue-open-'));
  const queueFile = path.join(root, 'BUILD-QUEUE.md');
  const audit = auditFixture();
  const policyCalls = [];
  let policyClosed = false;
  let laneCalls = 0;
  try {
    fs.writeFileSync(queueFile, fixtureQueue(actor), 'utf8');
    const actions = createMissionActions({
      roots: { primary: root },
      actor,
      agentOrg: org,
      permissionSession: INSTALL_TIER_SESSIONS.unrestricted,
      audit,
      policy: { assertActive(action, options) {
        policyCalls.push({ action, options, queueHash: sha256(fs.readFileSync(queueFile, 'utf8')) });
        if (policyClosed) throw new Error('fixture policy closed');
      } },
      executeTool: async () => { throw new Error('queue-open must not call a tool provider'); },
      runLane: async () => { laneCalls += 1; throw new Error('queue-open must not dispatch a lane'); },
      researchActions: {},
      machinesActions: {}
    });

    const brief = 'Record this owner goal in the durable queue only. A later worker loop may claim it under its existing ceiling.';
    const observedHash = sha256(fs.readFileSync(queueFile, 'utf8'));
    const result = await actions.queue({
      rootId: 'primary',
      expectedHash: observedHash,
      operation: 'open',
      title: 'Record-only goal',
      authority: 'R1000 (directiveId: R1000)',
      brief
    });

    assert.equal(result.ok, true);
    assert.equal(result.receipt.action, 'queue-open');
    assert.equal(result.receipt.phaseId, 'Q3', 'the writer allocates the collision-free next id');
    assert.equal(result.receipt.previousHash, observedHash, 'the write consumes the caller-observed CAS hash');
    assert.match(result.receipt.nextHash, /^[a-f0-9]{64}$/);
    const persisted = fs.readFileSync(queueFile, 'utf8');
    assert.match(persisted, /## Q3 (?:\u2014|-) Record-only goal/);
    assert.ok(persisted.includes(brief), 'the queue preserves the bounded brief verbatim');
    assert.equal(laneCalls, 0, 'opening a goal cannot dispatch or widen a loop ceiling');
    assert.ok(policyCalls.length > 0, 'queue mutation must consult the policy');
    for (const call of policyCalls) {
      assert.equal(call.action, 'mission.bridge.queue');
      assert.equal(call.options.outward, true);
      assert.equal(call.queueHash, observedHash, 'every admission check precedes the queue write');
    }
    assert.equal(JSON.stringify(result.receipt).includes(brief), false, 'the receipt does not echo the goal brief');
    assert.equal(JSON.stringify(audit.events).includes(brief), false, 'audit stores only goal hashes, not brief text');
    assert.deepEqual(audit.events.map(event => event.action), ['build.queue.open.intent', 'build.queue.open']);

    await assert.rejects(
      () => actions.queue({
        rootId: 'primary', expectedHash: observedHash, operation: 'open',
        title: 'Stale CAS', authority: 'R1000 (directiveId: R1000)', brief: 'This must not be written.'
      }),
      error => error && error.code === 'QUEUE_CONCURRENT_EDIT',
      'a stale observed hash must fail closed rather than overwrite the queue'
    );
    assert.equal(fs.readFileSync(queueFile, 'utf8').includes('This must not be written.'), false);

    policyClosed = true;
    const beforeRefusal = fs.readFileSync(queueFile, 'utf8');
    const auditsBeforeRefusal = audit.events.length;
    await assert.rejects(() => actions.queue({
      rootId: 'primary', expectedHash: sha256(beforeRefusal), operation: 'open',
      title: 'Policy refused', authority: 'R1000', brief: 'No policy, no write.'
    }), error => error?.code === 'BRIDGE_GUARD_REFUSED');
    assert.equal(fs.readFileSync(queueFile, 'utf8'), beforeRefusal, 'policy refusal leaves the entire queue unchanged');
    assert.equal(audit.events.length, auditsBeforeRefusal, 'policy refusal cannot record a write intent or completion');
    assert.equal(laneCalls, 0, 'neither admitted nor refused record-only actions start a lane');

    process.stdout.write('mission bridge queue open: completed policy, CAS, and record-only controls\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error?.code || 'ERROR'}: ${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
