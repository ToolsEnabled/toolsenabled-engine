'use strict';

// A VERIFIED QUEUE WRITE IS ANSWERED AS WRITTEN, EVEN WHEN ITS LOCK WILL NOT LET GO.
//
// build-queue-writer released its lock in a bare `finally`, so an unlock fault
// replaced whatever the write had already become. process-claim-lock rethrows
// the quarantine rename's EPERM/EBUSY (a Windows scanner or a second writer
// reading the holder file is enough). Measured through the real bridge with the
// real writer: a claim that was written AND verified came back as
// "EPERM 409 operation not permitted", the ledger kept only its intent, and the
// caller's retry met QUEUE_CONCURRENT_EDIT on a queue that already said it was
// claimed. The same finally also swapped the writer's own refusal for the
// unlock error. Every fault here is injected at the one fs call the real
// release makes, and nothing else is faked.

require('./lib/isolated-environment').activate('mission-bridge-queue-lock-release');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const writer = require('../src/lib/build-queue-writer');
const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { INSTALL_TIER_SESSIONS } = require('../src/lib/permission-tier-policy');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

const org = declaredOrg();
const actor = enabledControllerId(org);
// This suite asserts the completion receipt beside the intent, so it chooses
// auditing (a6c70ac6 made it an owner opt-in); the choice is injected, never written.
const auditChosen = () => ({ values: { 'audit.enabled': true }, provenance: { 'audit.enabled': { source: 'user' } }, rejected: [] });

function queueText() {
  return ['# Build queue', '', '## Completed', '', `- **Q1 - Prior work:** closed 2026-08-01 by ${actor} - fixture`, '',
    '## Q2 - Existing work', '', '**Status:** OPEN', '', '**Authority:** R1000 (directiveId: R1000)', '',
    '**Instructions (verbatim):**', '<!-- build-queue-writer:v1 bytes=8 -->', 'existing', ''].join('\n');
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-lock-release-'));
  const file = path.join(root, 'BUILD-QUEUE.md');
  fs.writeFileSync(file, queueText(), 'utf8');
  const realRename = fs.renameSync;
  const stderr = [];
  const realWrite = process.stderr.write;
  let releaseRenames = 0;
  fs.renameSync = function renameSync(from, to) {
    if (String(to).includes('.lock.release.')) {
      releaseRenames += 1;
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM', syscall: 'rename' });
    }
    return realRename.apply(this, arguments);
  };
  process.stderr.write = function write(chunk, ...rest) {
    if (String(chunk).includes('queue lock')) { stderr.push(String(chunk)); return true; }
    return realWrite.call(this, chunk, ...rest);
  };
  t.after(() => {
    fs.renameSync = realRename;
    process.stderr.write = realWrite;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file, stderr, releaseRenames: () => releaseRenames };
}

test('a verified claim is returned as written when the lock release fails', t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  const result = writer.transitionQueuePhase({ queueFile: f.file, expectedHash: writer.sha256(before), phaseId: 'Q2',
    action: 'claim', actor, reason: '', at: '2026-09-23T12:00:00.000Z' });
  assert.equal(f.releaseRenames(), 1, 'the real release path was driven into its fault');
  assert.equal(result.phaseId, 'Q2');
  assert.equal(result.previousHash, writer.sha256(before));
  assert.equal(result.nextHash, writer.sha256(fs.readFileSync(f.file, 'utf8')), 'the answer names the bytes now on disk');
  assert.match(fs.readFileSync(f.file, 'utf8'), /\*\*Status:\*\* IN-PROGRESS 2026-09-23 \(claimed by /);
  assert.equal(f.stderr.length, 1, 'the unlock fault is still reported, separately from the write');
  assert.match(f.stderr[0], /EPERM/);
});

test('a verified append is returned as written when the lock release fails', t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  const result = writer.appendQueuePhase({ queueFile: f.file, expectedHash: writer.sha256(before),
    phase: { title: 'Appended goal', authority: 'R1000 (directiveId: R1000)', instructions: 'Record only.' } });
  assert.equal(f.releaseRenames(), 1, 'the real release path was driven into its fault');
  assert.equal(result.phaseId, 'Q3');
  assert.equal(result.nextHash, writer.sha256(fs.readFileSync(f.file, 'utf8')));
  assert.match(fs.readFileSync(f.file, 'utf8'), /## Q3 (?:—|-) Appended goal/);
});

test('a refused write keeps its own refusal, not the unlock fault', t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => writer.transitionQueuePhase({ queueFile: f.file, expectedHash: 'f'.repeat(64), phaseId: 'Q2',
    action: 'claim', actor, reason: '', at: '2026-09-23T12:00:00.000Z' }), { code: 'QUEUE_CONCURRENT_EDIT' });
  assert.equal(f.releaseRenames(), 1, 'the release fault happened on the refusal path too');
  assert.equal(fs.readFileSync(f.file, 'utf8'), before, 'a refused claim changed nothing');
});

test('the bridge reports the landed claim and writes its completion receipt', async t => {
  const f = fixture(t);
  const events = [];
  const audit = {
    requireRecord(action, target, details) {
      events.push({ action, target, details });
      return { durable: true, anchored: true, sequence: events.length, eventHash: crypto.randomBytes(32).toString('hex') };
    },
    findEvents() { return []; }
  };
  const actions = createMissionActions({ roots: { primary: f.root }, actor, agentOrg: org,
    permissionSession: INSTALL_TIER_SESSIONS.unrestricted, audit, loadSettings: auditChosen,
    policy: { assertActive() {} }, researchActions: {}, machinesActions: {} });
  const before = fs.readFileSync(f.file, 'utf8');
  const reply = await actions.queue({ rootId: 'primary', expectedHash: writer.sha256(before), phaseId: 'Q2', operation: 'claim' });
  assert.equal(reply.ok, true);
  assert.equal(reply.receipt.action, 'queue-claim');
  assert.equal(reply.receipt.nextHash, writer.sha256(fs.readFileSync(f.file, 'utf8')));
  assert.deepEqual(events.map(event => event.action), ['build.queue.claim.intent', 'build.queue.claim'],
    'the ledger holds the outcome of the claim the queue shows, not only its intent');
  assert.equal(events[1].details.nextHash, reply.receipt.nextHash);
});
