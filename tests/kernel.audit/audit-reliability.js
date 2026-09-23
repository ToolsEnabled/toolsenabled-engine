'EXECUTABLE CHANGE';
'use strict';

// Assertion reliability report (testcanfail-tests-kernel-audit-audit-reliability-js):
// - EMPTY-ITERATION: strengthened below. Mutation: removed the `tvly-` product
//   credential pattern; RED: "AssertionError [ERR_ASSERTION]" with actual
//   "tvly-ffffffffffffffffffffffffffffffff" and expected "REDACTED". A
//   separate empty-fixture mutation makes the new cardinality assertion RED
//   with actual 0 and expected 10.
// - EXIT-STATUS/TRUTHY-RETURN: NOT-FOUND. This file spawns no processes and
//   checks result fields and persisted audit evidence rather than bare status.
// - SWALLOWED-FAILURE: NOT-FOUND. Cleanup uses finally; the one explicit catch
//   retains the error and assertions require its type/code/message.
// - MOCK-OF-SUBJECT: NOT-FOUND. Injected stores, sinks, anchors, clocks, and
//   signers are audit boundaries used to force product paths; audit itself is
//   always the real imported module.
// - PLATFORM-SKIP/GUARD: NOT-FOUND. There are no skips or platform guards.
// - SAME-CODE EXPECTATION: NOT-FOUND. Expected states and fixture values are
//   independently literal; canonicalJson is used only to construct valid
//   externally signed fixture envelopes, not to calculate asserted results.
// - PRECONDITION: the default Node 20.20.2 lacks node:sqlite; all executable
//   mutation and green runs therefore used installed Node 22.22.2.
// - RESTORATION: src/lib/secret-patterns.js was restored byte-for-byte (cmp
//   exit 0). Final green: "Audit durability and recovery tests passed."

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const audit = require('../../src/lib/audit');
const { canonicalJson, createAuditStore } = require('../../src/lib/audit-store');

function memoryAnchor() {
  let value = null;
  return {
    get: () => value,
    set(next, sequence) {
      const parsed = JSON.parse(next);
      assert.equal(parsed.sequence, sequence);
      if (value !== null) {
        const current = JSON.parse(value);
        if (sequence < current.sequence) throw new Error('anchor cannot move backward');
        if (sequence === current.sequence && next !== value) throw new Error('anchor conflict');
      }
      value = next;
    }
  };
}

function harness(label, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `te-audit-integration-${label}-`));
  const keys = crypto.generateKeyPairSync('ed25519');
  const store = createAuditStore({ file: path.join(dir, 'audit.sqlite3'), clock: () => 1000 });
  let nextId = 0;
  const reports = [];
  const dependencies = {
    store,
    signer: {
      keyId: 'integration-key-0001',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sign: value => crypto.sign(null, value, keys.privateKey)
    },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(dir, value),
    env: {},
    eventIdFactory: () => `audit-test-${String(++nextId).padStart(8, '0')}`,
    clock: () => 1000 + nextId,
    reportError: message => reports.push(message),
    anchorStore: memoryAnchor(),
    ...overrides
  };
  return {
    dir, store, keys, dependencies, reports,
    close() {
      try { store.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  };
}

function lines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
}

function signedAnchor(event, keys, keyId) {
  const payload = {
    domain: 'toolsenabled.audit.head.v1', version: 1,
    sequence: event.sequence, eventHash: event.eventHash, keyId
  };
  return JSON.stringify({
    ...payload,
    signature: crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), keys.privateKey).toString('base64')
  });
}

function authenticatedSpoolEnvelope(item, spoolKey) {
  return JSON.stringify({
    version: 1,
    domain: 'toolsenabled.audit.spool.v1',
    item,
    mac: crypto.createHmac('sha256', spoolKey).update(canonicalJson(item)).digest('hex')
  });
}

assert.deepEqual(audit.scrub({
  private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
  privateKey: 'private', credential: 'credential', cvv: '123', securityCode: '456',
  security_code: '789', safe: 'retained'
}), {
  private_key: 'REDACTED', privateKey: 'REDACTED', credential: 'REDACTED', cvv: 'REDACTED',
  securityCode: 'REDACTED', security_code: 'REDACTED', safe: 'retained'
});
assert.equal(audit.scrub('Bearer abcdefghijklmnopqrstuvwxyz0123456789'), 'Bearer REDACTED');
assert.equal(audit.scrub(`github_pat_${'a'.repeat(82)}`), 'REDACTED');
const storedCredentialShapes = [
  `sk-ant-${'a'.repeat(32)}`,
  `sk-proj-${'b'.repeat(32)}`,
  `rk_live_${'h'.repeat(32)}`,
  `GOCSPX-${'i'.repeat(32)}`,
  `ya29.${'c'.repeat(24)}`,
  `1//${'d'.repeat(32)}`,
  `dop_v1_${'e'.repeat(64)}`,
  `tvly-${'f'.repeat(32)}`,
  `pdl_${'g'.repeat(32)}`,
  `IGQ${'j'.repeat(32)}`
];
assert.equal(storedCredentialShapes.length, 10,
  'the credential-shape assertions must not pass vacuously with an empty or truncated fixture corpus');
for (const storedShape of storedCredentialShapes) {
  assert.equal(audit.scrub(storedShape), 'REDACTED');
}

{
  const test = harness('success');
  try {
    const result = audit.record('provider.commit', 'safe-target', {
      access_token: 'must-not-appear',
      nested: { client_secret: 'also-must-not-appear' },
      safe: 'retained'
    }, test.dependencies);
    assert.equal(result.ok, true);
    assert.equal(result.durable, true);
    assert.equal(result.projected, true);
    assert.deepEqual(result.sinks, { jsonl: true, text: true });
    assert.equal(result.pending, 0);

    const jsonl = lines(path.join(test.dir, 'actions.jsonl'));
    const text = lines(path.join(test.dir, 'actions.log'));
    assert.equal(jsonl.length, 1);
    assert.equal(text.length, 1);
    assert.equal(JSON.parse(jsonl[0]).details.access_token, 'REDACTED');
    assert.equal(JSON.parse(jsonl[0]).details.nested.client_secret, 'REDACTED');
    assert.doesNotMatch(`${jsonl}\n${text}`, /must-not-appear/);
    assert.match(JSON.parse(jsonl[0]).signature, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(audit.verify(test.dependencies).valid, true);
    assert.equal(audit.tail(1, test.dependencies)[0].details.safe, 'retained');
  } finally { test.close(); }
}

{
  let renameAttempts = 0;
  const transientFs = Object.create(fs);
  transientFs.renameSync = (source, target) => {
    renameAttempts += 1;
    if (renameAttempts < 3) {
      const error = new Error('temporary preview lock');
      error.code = 'EPERM';
      throw error;
    }
    return fs.renameSync(source, target);
  };
  const test = harness('projection-rename-retry', { fs: transientFs });
  try {
    fs.writeFileSync(path.join(test.dir, 'actions.jsonl'), 'noncanonical projection\n', 'utf8');
    const result = audit.record('provider.commit', 'safe-target', {}, test.dependencies);
    assert.equal(result.projected, true, 'a bounded transient Windows rename lock must not strand the canonical projection');
    assert.equal(result.pending, 0);
    assert.ok(renameAttempts >= 3, 'the test must exercise the retry path');
    assert.equal(audit.verify(test.dependencies).valid, true);
  } finally { test.close(); }
}

{
  const spoolKey = crypto.randomBytes(32);
  const test = harness('poison-quarantine', { spoolKey });
  try {
    const valid = authenticatedSpoolEnvelope({
      eventId: 'audit-spooled-valid-0001', occurredAtMs: 1200, createdAtMs: 1200,
      event: { timestamp: new Date(1200).toISOString(), action: 'spooled.valid', target: 'safe', details: {} }
    }, spoolKey);
    const poison = `${valid}\n{"eventId":"truncated`;
    fs.writeFileSync(path.join(test.dir, 'emergency.jsonl'), poison, 'utf8');
    const recovered = audit.flush({ force: true }, test.dependencies);
    assert.equal(recovered.projected, true);
    assert.equal(test.store.status().headSequence, 2, 'valid entry plus quarantine diagnostic must be durable');
    const quarantine = fs.readdirSync(test.dir).find(name => name.startsWith('emergency.jsonl.quarantine-'));
    assert.ok(quarantine, 'poisoned emergency source must be preserved in a digest-named quarantine');
    assert.equal(fs.readFileSync(path.join(test.dir, quarantine), 'utf8'), poison);
    assert.equal(audit.status(test.dependencies).quarantinedEmergencyFiles, 1);
    assert.equal(audit.verify(test.dependencies).valid, true);
    assert.equal(audit.record('after.quarantine', 'safe', {}, test.dependencies).durable, true,
      'quarantined input must not permanently poison future writes');
  } finally { test.close(); }
}

{
  let rejectJsonl = true;
  const test = harness('sink-recovery', {
    appendFileSync: (file, content, encoding) => {
      if (rejectJsonl && file.endsWith('.jsonl')) throw new Error('disk rejected api_key=must-not-leak');
      fs.appendFileSync(file, content, encoding);
    }
  });
  try {
    const first = audit.record('provider.commit', 'safe-target', {}, test.dependencies);
    assert.equal(first.durable, true, 'projection failure must not erase the canonical event');
    assert.equal(first.projected, false);
    assert.equal(first.partial, true);
    assert.deepEqual(first.sinks, { jsonl: false, text: true });
    assert.doesNotMatch(JSON.stringify({ first, reports: test.reports }), /must-not-leak/);

    rejectJsonl = false;
    const recovered = audit.flush({ force: true }, test.dependencies);
    assert.equal(recovered.projected, true);
    assert.equal(recovered.pending, 0);
    assert.equal(lines(path.join(test.dir, 'actions.jsonl')).length, 1);
    assert.equal(audit.verify(test.dependencies).valid, true);
  } finally { test.close(); }
}

{
  const test = harness('both-sinks', {
    appendFileSync: () => { throw new Error('projection unavailable password=must-not-leak'); }
  });
  try {
    assert.doesNotThrow(() => {
      const status = audit.record('provider.outcome', 'safe-target', {}, test.dependencies);
      assert.equal(status.durable, true);
      assert.equal(status.projected, false);
      assert.deepEqual(status.sinks, { jsonl: false, text: false });
      assert.doesNotMatch(JSON.stringify(status), /must-not-leak/);
      assert.equal(test.store.verify().valid, true);
    });
  } finally { test.close(); }
}

{
  const test = harness('disabled', {
    loadPolicy: () => ({ audit: { enabled: false } })
  });
  try {
    const status = audit.record('provider.commit', 'safe-target', {}, test.dependencies);
    assert.equal(status.ok, true);
    assert.equal(status.disabled, true);
    assert.equal(status.durable, false);
    assert.throws(() => audit.requireRecord('provider.intent', 'safe-target', {}, test.dependencies),
      error => error instanceof audit.AuditRequiredError && error.code === 'AUDIT_DISABLED');
  } finally { test.close(); }
}

{
  // A command process in a different DPAPI identity or vault context can see
  // the signing key as absent.  It must not manufacture a replacement key for
  // a ledger whose existing events were signed by another trusted key.
  audit.resetForTests();
  const test = harness('missing-key-existing-ledger');
  try {
    assert.equal(audit.record('existing.event', 'safe-target', {}, test.dependencies).durable, true);
    let createCalls = 0;
    const missingKey = () => {
      const error = new Error('not configured');
      error.code = 'SECRET_NOT_CONFIGURED';
      throw error;
    };
    assert.throws(() => audit.status({
      ...test.dependencies,
      signer: undefined,
      getSecret: missingKey,
      getOrCreateSecret: () => {
        createCalls += 1;
        throw new Error('must not create a replacement audit signing key');
      }
    }), error => error && error.code === 'AUDIT_SIGNING_KEY_UNAVAILABLE' &&
      /existing canonical ledger/i.test(error.message));
    assert.equal(createCalls, 0, 'a missing key must not bootstrap a different signer for an existing ledger');
    let unavailableCreateCalls = 0;
    assert.throws(() => audit.status({
      ...test.dependencies,
      signer: undefined,
      getSecret: () => {
        const error = new Error('DPAPI context cannot decrypt the record');
        error.code = 'SECRET_VAULT_UNREADABLE';
        throw error;
      },
      getOrCreateSecret: () => {
        unavailableCreateCalls += 1;
        throw new Error('must not initialize an unreadable vault context');
      }
    }), error => error && error.code === 'AUDIT_SIGNING_KEY_UNAVAILABLE' &&
      /operating-system identity or vault context/i.test(error.message));
    assert.equal(unavailableCreateCalls, 0, 'an unreadable DPAPI context must never bootstrap a replacement signer');
    assert.equal(test.store.status().headSequence, 1, 'the existing canonical event must remain the only event');
    assert.equal(test.store.verify().valid, true, 'the existing canonical chain must remain intact');
  } finally {
    audit.resetForTests();
    test.close();
  }
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-audit-emergency-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const signer = {
    keyId: 'integration-key-0001',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, keys.privateKey)
  };
  let emergencyId = 0;
  const common = {
    signer,
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(dir, value),
    env: {},
    eventIdFactory: () => `audit-emergency-${String(++emergencyId).padStart(4, '0')}`,
    clock: () => 2000,
    reportError: () => {},
    anchorStore: memoryAnchor()
  };
  const failingStore = { registerKey() { throw new Error('canonical unavailable authorization=must-not-leak'); } };
  const failed = audit.record('provider.intent', 'safe-target', { api_key: 'must-not-appear' }, { ...common, store: failingStore });
  assert.equal(failed.durable, false);
  assert.equal(lines(path.join(dir, 'emergency.jsonl')).length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'emergency.jsonl'), 'utf8'), /must-not-appear/);
  assert.throws(() => audit.requireRecord('provider.intent', 'safe-target', {}, { ...common, store: failingStore }),
    error => error instanceof audit.AuditRequiredError && error.code === 'AUDIT_UNAVAILABLE');

  const store = createAuditStore({ file: path.join(dir, 'audit.sqlite3') });
  try {
    const recoveredDependencies = { ...common, store, eventIdFactory: () => 'audit-after-recovery-0001', clock: () => 2001 };
    assert.equal(audit.flush({ force: true }, recoveredDependencies).projected, true);
    assert.equal(store.status().headSequence, 2, 'each failed canonical intent is recovered from the emergency spool');
    assert.equal(audit.verify(recoveredDependencies).valid, true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const test = harness('legacy');
  try {
    const legacy = [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', action: 'old.one', target: 'a', details: { safe: 1 } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', action: 'old.two', target: 'b', details: {
        refresh_token: 'must-not-appear', private_key: '-----BEGIN PRIVATE KEY-----\nmust-not-survive\n-----END PRIVATE KEY-----'
      } })
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(test.dir, 'actions.jsonl'), legacy, 'utf8');
    fs.writeFileSync(path.join(test.dir, 'actions.log'), 'legacy text projection\n', 'utf8');
    const status = audit.status(test.dependencies);
    assert.equal(status.headSequence, 2);
    assert.equal(audit.verify(test.dependencies).valid, true);
    const archive = fs.readdirSync(test.dir).find(name => /^actions\.jsonl\.legacy-/.test(name));
    assert.ok(archive, 'legacy JSONL must be retained in a digest-named archive');
    assert.equal(fs.readFileSync(path.join(test.dir, archive), 'utf8'), legacy);
    assert.doesNotMatch(fs.readFileSync(path.join(test.dir, 'actions.jsonl'), 'utf8'), /must-not-appear|must-not-survive/);
    assert.equal(test.store.getMetadata('legacy-jsonl-import-v1').value.status, 'complete');
  } finally { test.close(); }
}

{
  const test = harness('legacy-text-only');
  try {
    const legacyText = '2026-01-01T00:00:00.000Z | old.action | target | safe details\n';
    fs.writeFileSync(path.join(test.dir, 'actions.log'), legacyText, 'utf8');
    assert.equal(audit.status(test.dependencies).headSequence, 1);
    const archive = fs.readdirSync(test.dir).find(name => /^actions\.log\.legacy-/.test(name));
    assert.ok(archive, 'text-only legacy history must be archived');
    assert.equal(fs.readFileSync(path.join(test.dir, archive), 'utf8'), legacyText);
    assert.equal(audit.tail(1, test.dependencies)[0].action, 'legacy.text');
    assert.equal(audit.verify(test.dependencies).valid, true);
  } finally { test.close(); }
}

{
  const test = harness('projection-tamper');
  try {
    audit.record('one', 'target', {}, test.dependencies);
    const jsonlFile = path.join(test.dir, 'actions.jsonl');
    const forged = JSON.parse(lines(jsonlFile)[0]);
    forged.action = 'forged';
    forged.details = { forged: true };
    forged.signature = Buffer.alloc(64, 7).toString('base64');
    fs.writeFileSync(jsonlFile, `${JSON.stringify(forged)}\n`, 'utf8');
    assert.equal(audit.verify(test.dependencies).reason, 'projection-divergence');
    assert.equal(audit.flush({ force: true }, test.dependencies).projected, true);
    assert.equal(audit.verify(test.dependencies).valid, true);
    assert.equal(JSON.parse(lines(jsonlFile)[0]).action, 'one');
    const textFile = path.join(test.dir, 'actions.log');
    fs.writeFileSync(textFile, fs.readFileSync(textFile, 'utf8').replace(' | one | ', ' | forged | '), 'utf8');
    assert.equal(audit.verify(test.dependencies).reason, 'projection-divergence');
    assert.equal(audit.flush({ force: true }, test.dependencies).projected, true);
    assert.match(fs.readFileSync(textFile, 'utf8'), / \| one \| /);
  } finally { test.close(); }
}

{
  const test = harness('protected-tail-rollback');
  try {
    audit.requireRecord('first.intent', 'safe', {}, test.dependencies);
    audit.requireRecord('second.intent', 'safe', {}, test.dependencies);
    const first = test.store.getEvent({ sequence: 1 });
    test.store.close();
    const db = new DatabaseSync(path.join(test.dir, 'audit.sqlite3'));
    try {
      db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
      db.prepare('DELETE FROM audit_events WHERE sequence = 2').run();
      db.prepare('UPDATE audit_sink_state SET last_sequence = 1, last_hash = ?, failure_count = 0, retry_at_ms = NULL, last_error = NULL').run(first.eventHash);
      db.exec('COMMIT;');
    } finally { db.close(); }
    for (const name of ['actions.jsonl', 'actions.log']) {
      const file = path.join(test.dir, name);
      fs.writeFileSync(file, `${lines(file)[0]}\n`, 'utf8');
    }
    const verification = audit.verify(test.dependencies);
    assert.equal(verification.valid, false);
    // Post-R1162/anchor-lag this specific fixture (the anchor's own protected
    // sequence deleted out from under it) is reported by the more precise
    // "rolled back behind its protected head" wording rather than the generic
    // "does not match" one -- still unambiguously an alarm, still a real
    // detection, just a more accurate description of exactly what happened.
    assert.match(verification.error || '', /protected audit head|canonical ledger|rolled back/i);
  } finally { test.close(); }
}

{
  const test = harness('anchor-dominated-order');
  try {
    let protectedValue = null;
    let injected = false;
    test.dependencies.anchorStore = {
      get: () => protectedValue,
      set(value, sequence) {
        if (sequence === 1 && !injected) {
          injected = true;
          const concurrent = test.store.appendEvent({
            eventId: 'audit-concurrent-00000002', occurredAtMs: 2000, createdAtMs: 2000,
            event: { timestamp: new Date(2000).toISOString(), action: 'concurrent', target: 'safe', details: {} }
          }, test.dependencies.signer).event;
          protectedValue = signedAnchor(concurrent, test.keys, test.dependencies.signer.keyId);
          throw new Error('lower monotonic update arrived after sequence 2');
        }
        protectedValue = value;
      }
    };
    const status = audit.requireRecord('first.intent', 'safe', {}, test.dependencies);
    assert.equal(status.anchored, true);
    assert.equal(status.protectedSequence, 2, 'a valid higher concurrent anchor must dominate the delayed lower update');
    assert.equal(audit.verify(test.dependencies).valid, true);
  } finally { test.close(); }
}

{
  const test = harness('anchor-snapshot-refresh');
  try {
    audit.requireRecord('first.intent', 'safe', {}, test.dependencies);
    const firstAnchor = test.dependencies.anchorStore.get();
    let advancedAnchor = firstAnchor;
    let injected = false;
    test.dependencies.anchorStore = {
      get() {
        if (!injected) {
          injected = true;
          const concurrent = test.store.appendEvent({
            eventId: 'audit-concurrent-00000003', occurredAtMs: 3000, createdAtMs: 3000,
            event: { timestamp: new Date(3000).toISOString(), action: 'concurrent', target: 'safe', details: {} }
          }, test.dependencies.signer).event;
          advancedAnchor = signedAnchor(concurrent, test.keys, test.dependencies.signer.keyId);
        }
        return advancedAnchor;
      },
      set: value => { advancedAnchor = value; }
    };
    const current = audit.status(test.dependencies);
    assert.equal(current.anchor.sequence, 2,
      'a protected head advanced after the first DB snapshot must trigger a fresh snapshot, not a rollback false positive');
    assert.equal(audit.flush({ force: true }, test.dependencies).projected, true);
    assert.equal(audit.verify(test.dependencies).valid, true);
  } finally { test.close(); }
}

// R1162/anchor-lag: reconcileAnchor() used to call validateAnchor's event-hash
// check BEFORE its own "anchor ahead of this snapshot" recovery loop, so a
// verification-cache read that had not yet observed a concurrent writer's
// just-protected anchor reported a benign, resolvable race as
// "The protected audit head does not match the canonical ledger" -- tamper
// wording for a condition a retry would show was fine. This reproduces that
// exact staleness window deterministically (no real concurrency / no
// flakiness): the anchor is advanced to sequence 2 exactly as a concurrent
// writer would, but the FIRST verifyWithEvents() call this reconcile performs
// is truncated to only sequence 1, modelling a snapshot that has not caught
// up yet even though sequence 2 is genuinely already committed underneath it.
{
  const test = harness('anchor-ahead-of-stale-snapshot');
  try {
    // Registers the signing key and anchors sequence 1 (requireRecord forces
    // an immediate anchor -- same setup convention as anchor-dominated-order
    // and anchor-snapshot-refresh above).
    audit.requireRecord('first.intent', 'safe', {}, test.dependencies);
    const event2 = test.store.appendEvent({
      eventId: 'audit-ahead-00000002', occurredAtMs: 6000, createdAtMs: 6000,
      event: { timestamp: new Date(6000).toISOString(), action: 'concurrent', target: 'safe', details: {} }
    }, test.dependencies.signer).event;
    // A concurrent process already committed event 2 AND protected it with a
    // freshly signed anchor -- both real, both already true in the store.
    test.dependencies.anchorStore.set(signedAnchor(event2, test.keys, test.dependencies.signer.keyId), 2);

    const realVerifyWithEvents = test.store.verifyWithEvents.bind(test.store);
    let calls = 0;
    test.store.verifyWithEvents = (...args) => {
      calls += 1;
      const real = realVerifyWithEvents(...args);
      // Only the very first read is stale; every retry sees the truth, exactly
      // like a verification cache that catches up once invalidated/refreshed.
      return calls === 1 && real.events.length > 0 ? { ...real, events: real.events.slice(0, -1) } : real;
    };

    const status = audit.status(test.dependencies);
    assert.equal(calls > 1, true, 'the ahead-of-head recovery path must actually re-verify, not just accept the stale snapshot');
    assert.equal(status.anchor.sequence, 2,
      'an anchor advanced by a concurrent writer, ahead of this read\'s own stale verification snapshot, must resolve via retry -- not report ledger tampering (R1162/anchor-lag)');
    assert.equal(status.anchor.reconciled, false);
    // event2 was appended directly (modelling a concurrent writer's own
    // transaction), so its projection rows were never flushed by this
    // process -- same as the existing anchor-snapshot-refresh test above,
    // force a flush before asking verify() to compare projection rows.
    assert.equal(audit.flush({ force: true }, test.dependencies).projected, true);
    assert.equal(audit.verify(test.dependencies).valid, true);
  } finally { test.close(); }
}

// The same reorder must NOT weaken real tamper detection: once the anchor's
// sequence is genuinely within the checked snapshot, a real hash mismatch at
// that exact sequence must still alarm, loudly, every time -- this is the
// non-benign counterpart to the test above.
{
  const test = harness('anchor-genuine-mismatch-still-alarms');
  try {
    // Registers the signing key and anchors sequence 1.
    audit.requireRecord('first.intent', 'safe', {}, test.dependencies);
    // Forge a signed anchor for sequence 1 that names a hash the real event 1
    // does not have -- a genuine mismatch, not a snapshot race: the anchor's
    // own sequence is already at the ledger's head, so no retry can resolve it.
    // Bypass memoryAnchor()'s own same-sequence-conflict guard (correct for a
    // well-behaved writer, but this is deliberately simulating the opposite).
    const forged = signedAnchor({ sequence: 1, eventHash: '1'.repeat(64) }, test.keys, test.dependencies.signer.keyId);
    test.dependencies.anchorStore = { get: () => forged, set: () => { throw new Error('unexpected anchor write'); } };
    let threw = null;
    try { audit.status(test.dependencies); } catch (error) { threw = error; }
    assert.notEqual(threw, null, 'a genuine anchor/ledger hash mismatch must still throw');
    assert.equal(threw.code, 'AUDIT_ANCHOR_INTEGRITY_ALARM');
    assert.match(threw.message, /protected audit head|canonical ledger/i);
    const verification = audit.verify(test.dependencies);
    assert.equal(verification.valid, false);
    assert.match(verification.error || '', /protected audit head|canonical ledger/i);
  } finally { test.close(); }
}

console.log('Audit durability and recovery tests passed.');
