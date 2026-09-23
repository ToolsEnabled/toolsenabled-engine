// EXECUTABLE CHANGE
'use strict';

// Test-can-fail report (testcanfail-tests-unified-agent-p11-audit-js):
// - Strengthened the representative projection assertions. Mutation: changed
//   audit.tail(200) in src/lib/audit.js to return []. Before this assertion was
//   added, the mutated test stayed green: "Unified-agent P11 audit check passed
//   (replay, tamper, canary, bounded-status, and emergency recovery)."
//   With the assertion, RED output is: "AssertionError [ERR_ASSERTION]: the
//   representative ledger projection must contain every canonical event" and
//   "0 !== 11". The production source was then restored byte-for-byte.
// - NOT-FOUND: exit-status/truthy-return-only evidence; swallowed failures;
//   assertions against mocks of their own subject; whole-file skip/precondition
//   guards; expected values computed by the same code being checked.
// - The other loops discriminate independently: fixture writes are checked by
//   fixed entry/head counts, and tamper reorder indexes three seeded rows.
// - Precondition initially unmet: the default Node.js 20 lacks node:sqlite.
//   Mutation and green runs therefore use /root/.nvm/versions/node/v24.15.0/bin/node.

// P11 adversarial regression: semantic coordinator/control events must use the
// existing signed audit ledger, remain value-free, and preserve its recovery
// and tamper-evidence guarantees.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');
const coordinatorAudit = require('../src/lib/coordinator-audit-events');

function memoryAnchor() {
  let value = null;
  return {
    get: () => value,
    set(next, sequence) {
      const parsed = JSON.parse(next);
      assert.equal(parsed.sequence, sequence);
      if (value !== null) {
        const prior = JSON.parse(value);
        if (sequence < prior.sequence) throw new Error('anchor cannot move backward');
        if (sequence === prior.sequence && next !== value) throw new Error('anchor conflict');
      }
      value = next;
    }
  };
}

function harness(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-p11-${label}-`));
  const keys = crypto.generateKeyPairSync('ed25519');
  const store = createAuditStore({ file: path.join(directory, 'audit.sqlite3') });
  const dependencies = {
    store,
    signer: {
      keyId: 'p11-audit-key-0001',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sign: value => crypto.sign(null, value, keys.privateKey)
    },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(directory, value),
    env: {},
    reportError: () => {},
    anchorStore: memoryAnchor()
  };
  return {
    directory, store, dependencies,
    close() {
      try { store.close(); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
  };
}

function write(event, test, required = true) {
  return coordinatorAudit.write(event, { required, auditDependencies: test.dependencies });
}

function profile() {
  return [
    { name: 'task.submit', effect: 'local-write', approvalEligible: false },
    { name: 'memory.set', effect: 'local-write', approvalEligible: false },
    { name: 'billing.checkout_create', effect: 'external-write', approvalEligible: true }
  ];
}

function fixtureEvents(profileHash) {
  const sha = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  return [
    coordinatorAudit.policyDecision({
      action: 'task.submit', effect: 'local-write', approvalRequired: false,
      profileHash, occurredAtMs: 1001
    }),
    coordinatorAudit.approvalDecision({
      action: 'billing.checkout_create', approvalId: 'approval-0001', outcome: 'approved',
      expiresAtMs: 2000, profileHash, occurredAtMs: 1002
    }),
    coordinatorAudit.observeCapabilityProfile({
      profileId: 'runtime-mcp-profile', capabilities: profile(), occurredAtMs: 1003
    }),
    coordinatorAudit.providerOperation({
      provider: 'codex', operation: 'start', outcome: 'started', durationMs: 11,
      promptBytes: 0, occurredAtMs: 1004
    }),
    coordinatorAudit.taskTransition({
      taskId: 'task-replay-0001', operation: 'submit', status: 'queued', attempt: 0,
      fence: 0, revision: 0, replayed: false, occurredAtMs: 1005
    }),
    coordinatorAudit.memoryMutation({
      namespace: 'coordinator.control', key: 'mission/0001', valueHash: sha('safe-memory-value'),
      revision: 1, created: true, replayed: false, occurredAtMs: 1006
    }),
    coordinatorAudit.createEvent({
      kind: 'resource.decision', subjectType: 'resource', subjectReference: 'resource-0001',
      outcome: 'allowed', summary: { operation: 'allocate', code: 'resource-gated', count: 1 },
      hashes: { resource: sha('resource-0001') },
      evidence: [{ reference: 'evidence-0001', contentHash: sha('evidence-content-0001') }],
      occurredAtMs: 1007
    }),
    coordinatorAudit.createEvent({
      kind: 'toolforge.decision', subjectType: 'toolforge', subjectReference: 'toolforge-0001',
      outcome: 'approved', summary: { operation: 'review', code: 'toolforge-gated' },
      hashes: { tool: sha('tool-package-0001') }, occurredAtMs: 1008
    }),
    coordinatorAudit.createEvent({
      kind: 'tool.promotion', subjectType: 'tool-package', subjectReference: 'package-0001',
      outcome: 'promoted', summary: { operation: 'promote', code: 'promotion-approved' },
      hashes: { tool: sha('tool-package-0001'), artifact: sha('artifact-0001') }, occurredAtMs: 1009
    }),
    coordinatorAudit.createEvent({
      kind: 'order.submission', subjectType: 'order', subjectReference: 'order-0001',
      outcome: 'submitted', summary: { operation: 'submit', code: 'order-approved' },
      hashes: { order: sha('order-0001'), request: sha('order-request-0001') }, occurredAtMs: 1010
    })
  ];
}

function seed(test, count = 3) {
  const profileHash = coordinatorAudit.capabilityProfileHash(profile());
  const events = fixtureEvents(profileHash).slice(0, count);
  for (const event of events) write(event, test);
  assert.equal(audit.verify(test.dependencies).valid, true);
  return events;
}

function tamper(label, mutation, expectedReason) {
  const test = harness(label);
  try {
    seed(test);
    test.store.close();
    const database = new DatabaseSync(path.join(test.directory, 'audit.sqlite3'));
    try { mutation(database); } finally { database.close(); }
    const direct = test.store.verify();
    assert.equal(direct.valid, false, `${label} must fail the canonical chain verifier`);
    assert.equal(direct.reason, expectedReason, `${label} returned an unexpected chain reason`);
    const verification = audit.verify(test.dependencies);
    assert.equal(verification.valid, false, `${label} must invalidate the canonical ledger`);
    assert.ok(['audit-unavailable', expectedReason].includes(verification.reason), `${label} must not verify through the public audit path`);
  } finally { test.close(); }
}

{
  const test = harness('representative-replay');
  try {
    const profileHash = coordinatorAudit.capabilityProfileHash(profile());
    for (const event of fixtureEvents(profileHash)) {
      const status = write(event, test);
      assert.equal(status.durable, true);
      assert.equal(status.anchored, true);
    }

    const replay = coordinatorAudit.taskTransition({
      taskId: 'task-replay-0002', operation: 'complete', status: 'succeeded', attempt: 1,
      fence: 3, revision: 2, replayed: true, occurredAtMs: 1011
    });
    const first = write(replay, test);
    const second = write(replay, test);
    assert.equal(second.sequence, first.sequence, 'an exact task replay must reuse its canonical event');
    assert.equal(test.store.status().headSequence, 11, 'P11 must append to, not duplicate, the canonical ledger');

    const verification = audit.verify(test.dependencies);
    assert.equal(verification.valid, true);
    assert.equal(verification.entries, 11);

    const bounded = coordinatorAudit.boundedStatus({ auditDependencies: test.dependencies });
    assert.equal(bounded.valid, true);
    assert.equal(bounded.headSequence, 11);
    assert.equal(Object.hasOwn(bounded, 'path'), false, 'P11 status must not expose a ledger path');
    assert.equal(Object.hasOwn(bounded, 'keys'), false, 'P11 status must not expose signing-key records');
    assert.equal(Object.hasOwn(bounded, 'events'), false, 'P11 status must not become a ledger reader');

    const stored = `${fs.readFileSync(path.join(test.directory, 'actions.jsonl'), 'utf8')}\n${fs.readFileSync(path.join(test.directory, 'actions.log'), 'utf8')}`;
    assert.doesNotMatch(stored, /task-replay-000[12]|mission\/0001|approval-0001/,
      'raw task, memory, and approval references must be opaque in projections');
    assert.doesNotMatch(stored, /TOOLSENABLED_CANARY_|OWNER_PRIVATE_FIXTURE|private@example\.invalid/);
    const projectedRows = audit.tail(200, test.dependencies);
    assert.equal(projectedRows.length, 11,
      'the representative ledger projection must contain every canonical event');
    for (const row of projectedRows) {
      assert.match(row.action, /^coordinator\.audit\./);
      assert.deepEqual(Object.keys(row.details).sort(), ['evidence', 'hashes', 'kind', 'outcome', 'schemaVersion', 'subject', 'summary']);
      assert.match(row.target, /^[a-f0-9]{64}$/);
    }

    // Existing control callers still pass a broad audit-details object.
    // The production bridge must retain only an existing digest and must never
    // turn actor or prompt-like fields into semantic audit metadata.
    const missionHash = crypto.createHash('sha256').update('bridge-mission', 'utf8').digest('hex');
    const bridged = coordinatorAudit.legacyAuditRecord('coordinator.workflow.configure', 'run-bridge-0001', {
      actor: 'TOOLSENABLED_CANARY_SECRET_7429', missionHash, prompt: 'never retain this body'
    }, { auditDependencies: test.dependencies });
    assert.equal(bridged.durable, true);
    const bridgeRow = audit.tail(1, test.dependencies)[0];
    assert.equal(bridgeRow.details.kind, 'resource.decision');
    assert.equal(bridgeRow.details.hashes.resource, missionHash);
    assert.equal(Object.hasOwn(bridgeRow.details, 'actor'), false);
    assert.doesNotMatch(JSON.stringify(bridgeRow), /TOOLSENABLED_CANARY_|never retain this body/);
    assert.equal(audit.verify(test.dependencies).valid, true);
  } finally { test.close(); }
}

// The public event builder accepts no bodies, prompts, model output, PII, or
// credential-shaped values.  A P09 canary is rejected before the canonical
// audit writer is reached.
assert.throws(() => coordinatorAudit.createEvent({
  kind: 'task.transition', subjectType: 'task', subjectReference: 'TOOLSENABLED_CANARY_SECRET_7429',
  outcome: 'queued', summary: { operation: 'submit', code: 'task-transition' }
}), error => error instanceof coordinatorAudit.CoordinatorAuditEventError && error.code === 'COORDINATOR_AUDIT_EVENT_SENSITIVE');
assert.throws(() => coordinatorAudit.createEvent({
  kind: 'task.transition', subjectType: 'task', subjectReference: 'task-0001',
  outcome: 'queued', summary: { operation: 'submit', code: 'task-transition', prompt: 'never audit this prompt' }
}), error => error instanceof coordinatorAudit.CoordinatorAuditEventError && error.code === 'COORDINATOR_AUDIT_EVENT_INVALID');
assert.throws(() => coordinatorAudit.createEvent({
  kind: 'provider.operation', subjectType: 'provider', subjectReference: 'codex',
  outcome: 'sk_live_aaaaaaaaaaaaaaaaaa', summary: { operation: 'complete', code: 'provider-operation' }
}), error => error instanceof coordinatorAudit.CoordinatorAuditEventError && error.code === 'COORDINATOR_AUDIT_EVENT_SENSITIVE');

// Regression: providerOperation() previously accepted no outputBytes field at
// all, and legacyEvent()'s coordinator.provider.* bridge never read
// details.outputBytes, so the P11 wrap silently dropped real measurement data
// (cli-provider-gateway.js's auditProvider() has always set details.outputBytes
// for an observed successful response). Both the direct builder and the legacy
// bridge must now preserve it as transport metadata, never as a token/cost figure.
{
  const direct = coordinatorAudit.providerOperation({
    provider: 'codex', operation: 'complete', outcome: 'success', durationMs: 12,
    promptBytes: 40, outputBytes: 2048, occurredAtMs: 5001
  });
  assert.equal(direct.summary.outputBytes, 2048, 'providerOperation() must preserve outputBytes in its summary');
  assert.equal(direct.summary.promptBytes, 40, 'providerOperation() must still preserve promptBytes alongside outputBytes');

  const omittedZero = coordinatorAudit.providerOperation({
    provider: 'codex', operation: 'complete', outcome: 'blocked', durationMs: 3,
    promptBytes: 0, occurredAtMs: 5002
  });
  assert.equal(Object.hasOwn(omittedZero.summary, 'outputBytes'), false,
    'outputBytes must stay absent (not fabricated as 0) when the caller never observed a response');

  const test = harness('output-bytes-survives-wrap');
  try {
    // This mirrors the exact call shape cli-provider-gateway.js's auditProvider()
    // makes today: a broad legacy details object including outputBytes, routed
    // through the same coordinator.provider.* bridge used in production.
    const bridged = coordinatorAudit.legacyAuditRecord('coordinator.provider.complete', 'codex', {
      outcome: 'success', durationMs: 87, promptBytes: 512, outputBytes: 4096, model: 'claude-sonnet'
    }, { auditDependencies: test.dependencies });
    assert.equal(bridged.durable, true);
    const row = audit.tail(1, test.dependencies)[0];
    assert.equal(row.details.kind, 'provider.operation');
    assert.equal(row.details.summary.outputBytes, 4096,
      'the P11 wrap must not drop outputBytes for the mcp.provider.complete legacy bridge');
    assert.equal(row.details.summary.promptBytes, 512);
    assert.equal(row.details.summary.durationMs, 87);
    assert.equal(audit.verify(test.dependencies).valid, true);
  } finally { test.close(); }
}

tamper('modify', database => {
  database.prepare("UPDATE audit_events SET event_json = '{\"forged\":true}' WHERE sequence = 2").run();
}, 'event-hash');

tamper('remove', database => {
  database.prepare('DELETE FROM audit_events WHERE sequence = 2').run();
}, 'sequence-gap');

tamper('reorder', database => {
  const rows = database.prepare('SELECT * FROM audit_events ORDER BY sequence').all();
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.prepare('DELETE FROM audit_events').run();
    const insert = database.prepare(`INSERT INTO audit_events(sequence, event_id, occurred_at_ms, event_json, previous_hash,
      event_hash, key_id, signature, created_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // Reordering requires changing the predecessor fields to satisfy SQLite's
    // local CHECK constraint; the signed hash then fails, as it must.
    insert.run(1, rows[1].event_id, rows[1].occurred_at_ms, rows[1].event_json, '0'.repeat(64), rows[1].event_hash, rows[1].key_id, rows[1].signature, rows[1].created_at_ms);
    insert.run(2, rows[0].event_id, rows[0].occurred_at_ms, rows[0].event_json, rows[1].event_hash, rows[0].event_hash, rows[0].key_id, rows[0].signature, rows[0].created_at_ms);
    insert.run(3, rows[2].event_id, rows[2].occurred_at_ms, rows[2].event_json, rows[0].event_hash, rows[2].event_hash, rows[2].key_id, rows[2].signature, rows[2].created_at_ms);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}, 'event-hash');

{
  const test = harness('emergency-recovery');
  try {
    const event = coordinatorAudit.taskTransition({
      taskId: 'task-emergency-0001', operation: 'submit', status: 'queued', occurredAtMs: 2001
    });
    const failingStore = { registerKey() { throw new Error('canonical unavailable token=TOOLSENABLED_CANARY_SECRET_7429'); } };
    const status = coordinatorAudit.write(event, {
      required: false,
      auditDependencies: { ...test.dependencies, store: failingStore }
    });
    assert.equal(status.durable, false);
    const emergency = fs.readFileSync(path.join(test.directory, 'emergency.jsonl'), 'utf8');
    assert.doesNotMatch(emergency, /TOOLSENABLED_CANARY_|task-emergency-0001/);
    assert.doesNotMatch(JSON.stringify(status), /TOOLSENABLED_CANARY_/);
    assert.equal(audit.flush({ force: true }, test.dependencies).projected, true);
    assert.equal(audit.verify(test.dependencies).valid, true, 'existing emergency recovery must remain sound for P11 events');
  } finally { test.close(); }
}

const adapterSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'coordinator-audit-events.js'), 'utf8');
assert.doesNotMatch(adapterSource, /createAuditStore|audit\.sqlite3|DatabaseSync/,
  'P11 must adapt to the canonical ledger, never create a second ledger');

console.log('Unified-agent P11 audit check passed (replay, tamper, canary, bounded-status, and emergency recovery).');
