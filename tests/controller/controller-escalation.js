'use strict';

require('../lib/isolated-environment').activate('controller-escalation');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ControllerEscalationStore, PACKET_VERSION } = require('../../src/lib/controller-escalation');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-escalation-'));
const stateFile = path.join(root, 'escalation.json');
let now = Date.parse('2026-07-28T20:00:00.000Z');
const hash = seed => crypto.createHash('sha256').update(seed).digest('hex');
const fence = (seed = 'head') => ({ headSequence: 42, headHash: hash(seed), headKeyId: 'audit-ed25519-test-01' });
const packet = {
  schemaVersion: 1, escalationId: `esc_${'A'.repeat(16)}`, delegationId: `dlg_${'B'.repeat(16)}`,
  disputedDecisionCode: 'verification-conflict', verifiedFactRefs: ['evidence.receipt-01'], failedCriteria: ['tests-green'],
  evidenceBundleHash: hash('evidence'), requestedDecision: 'resolve_evidence'
};
const store = new ControllerEscalationStore({ stateFile, clock: () => now, freshnessMs: 300_000 });

assert.equal(store.preview(fence()).state, 'unavailable');
const staged = store.stage({ packet, auditFence: fence(), observedAtMs: now });
assert.equal(staged.state, 'available');
assert.equal(staged.packetVersion, PACKET_VERSION);
assert.equal(staged.lifecycleState, 'UNACCEPTED');
assert.equal(staged.packet.contractHash, undefined);
assert.ok(Object.isFrozen(staged), 'capability projection is immutable');
assert.ok(Object.isFrozen(staged.packet), 'packet projection is deeply immutable');
assert.ok(Object.isFrozen(staged.packet.verifiedFactRefs), 'packet references are deeply immutable');
assert.throws(() => { staged.packet.requestedDecision = 'route_to_owner'; }, TypeError);

const request = store.request({ packetVersion: PACKET_VERSION, packet: staged.packet, requestedDecision: 'resolve_evidence', auditFence: fence() });
assert.deepEqual(request, { accepted: false, requestRecorded: true, handoffRef: staged.handoffRef, lifecycleState: 'UNACCEPTED', requestState: 'UNACCEPTED', packetVersion: PACKET_VERSION });
assert.ok(Object.isFrozen(request), 'recorded request cannot masquerade as mutable state');
assert.deepEqual(store.status({ handoffRef: staged.handoffRef, auditFence: fence() }), { handoffRef: staged.handoffRef, lifecycleState: 'UNACCEPTED', freshness: 'fresh', requestState: 'UNACCEPTED' });
const beforeIdempotent = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
assert.deepEqual(store.request({ packetVersion: PACKET_VERSION, packet: staged.packet, requestedDecision: 'resolve_evidence', auditFence: fence() }), request, 'same request is idempotent');
const afterIdempotent = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
assert.equal(afterIdempotent.requests.length, beforeIdempotent.requests.length, 'idempotent request does not append duplicate history');

assert.throws(() => store.request({ packetVersion: PACKET_VERSION, packet: { ...staged.packet, rawPrompt: 'Bearer secret-token' }, requestedDecision: 'resolve_evidence', auditFence: fence() }), error => error.code === 'CONTROLLER_ESCALATION_INVALID');
assert.throws(() => store.request({ packetVersion: PACKET_VERSION, packet: staged.packet, requestedDecision: 'route_to_owner', auditFence: fence() }), error => error.code === 'CONTROLLER_ESCALATION_INVALID');
assert.throws(() => store.request({ packetVersion: PACKET_VERSION, packet: staged.packet, requestedDecision: 'resolve_evidence', auditFence: fence('different') }), error => error.code === 'CONTROLLER_ESCALATION_STALE_PACKET');

now += 300_001;
assert.equal(store.preview(fence()).freshness, 'expired');
assert.deepEqual(store.status({ handoffRef: staged.handoffRef, auditFence: fence() }), { handoffRef: staged.handoffRef, lifecycleState: null, freshness: 'unavailable', requestState: null }, 'expired records do not fabricate a lifecycle state');
assert.deepEqual(store.status({ handoffRef: `hnd_${'C'.repeat(16)}`, auditFence: fence() }), { handoffRef: `hnd_${'C'.repeat(16)}`, lifecycleState: null, freshness: 'unavailable', requestState: null }, 'unknown opaque references do not become UNACCEPTED');

const tamperedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
tamperedState.staged.packet.rawPrompt = 'unexpected-field';
fs.writeFileSync(stateFile, JSON.stringify(tamperedState));
assert.throws(() => store.preview(fence()), error => error.code === 'CONTROLLER_ESCALATION_STATE_INVALID');
process.stdout.write('Controller escalation contract tests passed.\n');
