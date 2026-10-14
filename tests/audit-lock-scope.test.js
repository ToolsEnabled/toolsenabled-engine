// EXECUTABLE CHANGE
// Assertion census: the harness may not pass with an empty or partially
// registered check collection.
'use strict';
// THE AUDIT WRITE LOCK MUST NOT BE HELD ACROSS A CREDENTIAL-VAULT PROCESS SPAWN.
//
// The defect, measured on this machine 2026-08-11 against a PRIVATE ledger and
// a PRIVATE vault (never the live state/audit.sqlite3): one external-write
// audit.requireRecord() spawned SEVEN powershell.exe processes -- six protected
// head-anchor reads plus one anchor write -- and SIX of the seven ran INSIDE
// audit-store.js's BEGIN IMMEDIATE transaction, which is the ledger's single
// writer.
//
// Paired runs, before against a worktree pinned at HEAD and after against this
// tree, back to back so they share the machine's load:
//
//                                       before      after
//   ledger write lock held per record   3,085 ms    464 ms
//   vault processes inside that lock            6        1
//   vault processes per record                  7        2
//   8 concurrent writers, mean         15,484 ms  9,159 ms
//   8 concurrent writers, p95          46,325 ms 18,119 ms
//
// The same budget binds the READ path, and did not used to be asserted. On
// 2026-08-17 audit.verify() was correctly changed to stop verifying the whole
// ledger twice (69,794 Ed25519 checks for 34,896 events), and that change moved
// the process's first real vault read from outside the lock to inside it. All
// ten audit suites passed. Check 5 below is the one that fails on it.
//
// Wall-clock figures move with whatever else the machine is doing; the spawn
// counts do not, which is why the checks below assert counts. On a heavily
// loaded run of the same before harness, 6 of 40 records were refused outright
// with AUDIT_UNAVAILABLE ("Durable audit intent could not be recorded") once
// the 5,000 ms busy-retry budget expired -- the exact production symptom that
// blocked every external-write MCP tool. No after run has refused a record.
//
// The fix reads the anchor once outside the lock and lets the in-lock witness
// reads resolve against a digest of the vault file's own CONTENT. These checks
// pin that fix and, more importantly, the three properties it must not buy
// speed with:
//
//   1. TAMPER-EVIDENCE IS UNCHANGED. The cache key is a content hash, never
//      size+mtime. A stat-keyed cache is defeated by any same-user process
//      that rewrites a file to the same length and restores its mtime, and a
//      defeated anchor cache would serve a remembered anchor over a replaced
//      one -- letting a rolled-back ledger pass the very check the anchor
//      exists to perform. check 1 fails on any size+mtime implementation.
//   2. FAIL-CLOSED STAYS FAIL-CLOSED. requireRecord() must still refuse, and
//      the ledger must still not advance, when the anchor cannot be written.
//   3. NO CREDENTIAL VALUE IS CACHED. The only thing retained is a digest of
//      the vault file plus the anchor, which is a signed public integrity
//      claim and not a secret; the signing key stays in process memory for the
//      process lifetime, as it already did.
//
// This suite talks to the REAL vault, so it spawns real powershell.exe
// processes. tests/run-isolated.js redirects TOOLSENABLED_VAULT_PATH,
// TOOLSENABLED_AUDIT_DB and both projection paths into a scratch root, so the
// installation's own vault and ledger are never opened.

const childProcess = require('node:child_process');

// Patched BEFORE src/lib/runtime.js is loaded, because runtime.js destructures
// execFileSync at module load; a later patch would never be seen.
const spawnState = { total: 0, inLock: 0, lockDepth: 0 };
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function countedExecFileSync(file, ...rest) {
  if (/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(String(file))) {
    spawnState.total += 1;
    if (spawnState.lockDepth > 0) spawnState.inLock += 1;
  }
  return originalExecFileSync.call(this, file, ...rest);
};

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const runtime = require('../src/lib/runtime');
const audit = require('../src/lib/audit');
// Run this suite through tests/run-isolated.js (or `npm test`), which
// redirects the ledger, the projections, the emergency spool and the vault
// into a scratch root. Called once, unconditionally, here -- immediately
// after the one `require('../src/lib/audit')` above and before any check()
// registers -- so every check in this file is covered by construction,
// rather than depending on each check remembering to call its own copy (see
// REPORT-audit-test-exposure-census-20260907.md: four of this file's eight
// checks used to reach audit.record()/audit.verify()/audit.resetForTests()
// before the file's only two calls to assertIsolatedLedger() ever ran).
assertIsolatedLedger();
const { canonicalJson, createAuditStore } = require('../src/lib/audit-store');

// Count spawns that happen while the ledger's write transaction is held. The
// probe wraps the shared prototype, so it observes the default store the audit
// module creates for itself. It is deliberately a superset of the transaction
// (it opens a few statements early), which can only over-count.
const probeStore = createAuditStore({ file: ':memory:' });
const storePrototype = Object.getPrototypeOf(probeStore);
probeStore.close();
const originalWithProjectionLock = storePrototype.withProjectionLock;
storePrototype.withProjectionLock = function countedWithProjectionLock(options, callback) {
  spawnState.lockDepth += 1;
  try { return originalWithProjectionLock.call(this, options, callback); }
  finally { spawnState.lockDepth -= 1; }
};

const checks = [];
function check(name, run) { checks.push([name, run]); }

function measure(run) {
  const beforeSpawns = { total: spawnState.total, inLock: spawnState.inLock };
  const beforeStats = audit.anchorVaultStats();
  const value = run();
  const afterStats = audit.anchorVaultStats();
  return {
    value,
    spawns: spawnState.total - beforeSpawns.total,
    inLockSpawns: spawnState.inLock - beforeSpawns.inLock,
    realAnchorReads: afterStats.real - beforeStats.real,
    cachedAnchorReads: afterStats.cached - beforeStats.cached,
    anchorWrites: afterStats.writes - beforeStats.writes
  };
}

// ---------------------------------------------------------------------------
// 1. The cache key must be the vault file's CONTENT, not its size and mtime.
//    This is the check a naive "make it faster" implementation dies on.
// ---------------------------------------------------------------------------
check('the vault change-detector used for the anchor cache is keyed on content, not size+mtime', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-lock-scope-key-'));
  const vaultFile = path.join(directory, 'vault.json');
  const restore = process.env.TOOLSENABLED_VAULT_PATH;
  try {
    // A fixed timestamp on both writes, because that is what an attacker with
    // SetFileTime has: the ability to state the mtime exactly rather than
    // inherit whatever the clock happened to say.
    const stamp = new Date(1_700_000_000_000);
    process.env.TOOLSENABLED_VAULT_PATH = vaultFile;
    fs.writeFileSync(vaultFile, 'A'.repeat(512));
    fs.utimesSync(vaultFile, stamp, stamp);
    const contentBefore = runtime.vaultContentDigest();
    const statBefore = runtime.vaultFingerprint();
    assert.match(String(contentBefore), /^[a-f0-9]{64}$/, 'a readable vault must produce a digest');

    // Exactly the attack a same-user process can mount: replace the bytes,
    // keep the length, put the timestamps back.
    fs.writeFileSync(vaultFile, 'B'.repeat(512));
    fs.utimesSync(vaultFile, stamp, stamp);

    assert.equal(runtime.vaultFingerprint(), statBefore,
      'precondition: the size+mtime gate is blind to a same-length, mtime-restored rewrite');
    assert.notEqual(runtime.vaultContentDigest(), contentBefore,
      'the content digest MUST see a same-length, mtime-restored rewrite; a size+mtime key here would let a replaced anchor be served from cache');
  } finally {
    if (restore === undefined) delete process.env.TOOLSENABLED_VAULT_PATH;
    else process.env.TOOLSENABLED_VAULT_PATH = restore;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. "I could not look" is never "nothing changed".
// ---------------------------------------------------------------------------
check('an unreadable vault reports unknown, never unchanged', () => {
  const restore = process.env.TOOLSENABLED_VAULT_PATH;
  try {
    process.env.TOOLSENABLED_VAULT_PATH = path.join(os.tmpdir(), `audit-lock-scope-absent-${process.pid}.json`);
    assert.equal(runtime.vaultContentDigest(), null,
      'a vault file that cannot be read must be null (unknown), so the caller falls through to a real read');
  } finally {
    if (restore === undefined) delete process.env.TOOLSENABLED_VAULT_PATH;
    else process.env.TOOLSENABLED_VAULT_PATH = restore;
  }
});

// ---------------------------------------------------------------------------
// 3. THE LOCK-SCOPE BUDGET. This is the regression the whole suite is named
//    for: at most ONE vault process may run inside the held transaction, and
//    it may only ever be the anchor write.
// ---------------------------------------------------------------------------
check('an external-write record holds the ledger lock across at most one vault process', () => {
  audit.resetForTests();
  // Two warm-up records: the first creates the schema, signing key and
  // projections; the second settles the process into steady state.
  audit.requireRecord('lockscope.warm', 'warm-1', { phase: 1 });
  audit.requireRecord('lockscope.warm', 'warm-2', { phase: 2 });

  const measured = measure(() => audit.requireRecord('lockscope.external', 'budget', { phase: 3 }));

  assert.equal(measured.value.durable, true, 'the measured record must actually be durable');
  assert.equal(measured.value.anchored, true, 'an external write must still be anchored');
  assert.ok(measured.inLockSpawns <= 1,
    `at most one vault process may run inside the ledger transaction (the anchor write); saw ${measured.inLockSpawns}`);
  assert.equal(measured.anchorWrites, 1, 'an external write anchors exactly once');
  assert.ok(measured.cachedAnchorReads >= 4,
    `the in-lock witness reads must resolve against the vault content digest; saw ${measured.cachedAnchorReads} cached of ${measured.cachedAnchorReads + measured.realAnchorReads}`);
  assert.ok(measured.spawns <= 1,
    `a quiet vault must cost an external-write record at most one vault process in total, the anchor write; saw ${measured.spawns}`);
  // ZERO real reads, and that is a budget, not a shortcut. On a quiet vault the
  // pre-lock warm and all five in-lock witness reads resolve against the
  // content digest. The anchor write used to forget that binding, because a
  // digest THIS process took after the vault released its lock could pair a
  // superseded anchor with the live file (another process may already have
  // stored a HIGHER one) and hide that advance -- or, after a rollback, the
  // truncation the anchor exists to catch. The vault helper now reports the
  // digest from INSIDE its own lock (tools/secrets.ps1 Write-VaultContentDigest),
  // where no writer can interleave, so the binding it names is exact and the
  // real read it used to force is gone. Measured 2026-09-02 on an installed
  // build with twelve agent processes: that read was one of two powershell.exe
  // spawns per audited tool call. A build that forgets the binding again does
  // one real read here instead of zero.
  assert.equal(measured.realAnchorReads, 0,
    `an external-write record on a quiet vault makes no real vault anchor read, because the anchor write reports the digest it produced; saw ${measured.realAnchorReads}`);
});

// A failed lookup whose prose happens to resemble the vault's absent response
// is still UNKNOWN. The child gives audit.js its normal (therefore cacheable)
// secret plane, except for one EIO on the first head read. verify() performs an
// advisory read and then an authoritative read: the latter must retry. The
// healthy anchor returned by that retry is the control that ordinary successful
// answers remain cacheable for the later in-lock reads.
check('a busy anchor read is not cached as an absent anchor', () => {
  const child = childProcess.spawnSync(process.execPath, ['-e', `
    const Module = require('node:module');
    const runtimePath = require.resolve(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'lib', 'runtime.js'))});
    const real = require(runtimePath);
    const originalLoad = Module._load;
    let headReads = 0;
    Module._load = function(request, parent, isMain) {
      const loaded = originalLoad.apply(this, arguments);
      if (parent && /[\\\\/]src[\\\\/]lib[\\\\/]audit\\.js$/.test(parent.filename || '') && request === './runtime') {
        return { ...loaded, getSecret(key) {
          if (key === 'toolsenabled_audit_head_v1') {
            headReads += 1;
            if (headReads === 1) {
              const error = new Error('vault helper said key not found while its read failed');
              error.code = 'EIO';
              throw error;
            }
          }
          return real.getSecret(key);
        }};
      }
      return loaded;
    };
    const audit = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'lib', 'audit.js'))});
    const result = audit.verify();
    process.stdout.write(JSON.stringify({ result, headReads, stats: audit.anchorVaultStats() }));
  `], { env: process.env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.status, 0, `the EIO probe must run: ${String(child.stderr).slice(-400)}`);
  const observed = JSON.parse(child.stdout.trim());
  assert.equal(observed.result.valid, true, `the authoritative retry must verify the ledger: ${JSON.stringify(observed.result)}`);
  assert.equal(observed.headReads, 2,
    'EIO must not latch a null; the authoritative read must retry, while later reads use the healthy cached anchor');
  assert.ok(observed.stats.cached >= 1,
    'control: after the successful retry, the legitimate anchor answer must still be cached');
});

// ---------------------------------------------------------------------------
// 4. A local-write record costs the vault nothing at all once warm, and a
//    genuine cross-process anchor advance still busts the cache. The second
//    half is the one that matters: a cache that never misses is a cache that
//    cannot see tampering.
// ---------------------------------------------------------------------------
check('a warm local-write record spawns no vault process, and a cross-process anchor advance forces a real read outside the lock', () => {
  audit.record('lockscope.local', 'warm', { phase: 1 });
  const warm = measure(() => audit.record('lockscope.local', 'quiet', { phase: 2 }));
  assert.equal(warm.value.durable, true, 'the local record must be durable');
  assert.equal(warm.anchorWrites, 0, 'a local write below the checkpoint interval does not anchor');
  assert.equal(warm.spawns, 0,
    `a quiet vault must cost a local-write record zero vault processes; saw ${warm.spawns}`);
  assert.equal(warm.inLockSpawns, 0, 'and therefore zero inside the ledger transaction');

  // A REAL other process advances the protected head in the shared vault.
  const child = childProcess.spawnSync(process.execPath, ['-e', `
    const audit = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'lib', 'audit.js'))});
    const status = audit.requireRecord('lockscope.other-process', 'advance', { from: 'child' });
    process.stdout.write(JSON.stringify({ sequence: status.sequence, protectedSequence: status.protectedSequence }));
  `], { env: process.env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.status, 0, `the second-writer child must succeed: ${String(child.stderr).slice(-400)}`);
  const advanced = JSON.parse(child.stdout.trim());

  const afterAdvance = measure(() => audit.requireRecord('lockscope.external', 'after-advance', { phase: 3 }));
  assert.equal(afterAdvance.value.durable, true, 'the record after a cross-process advance must be durable');
  assert.ok(afterAdvance.realAnchorReads >= 1,
    'a vault another process has written MUST force a real anchor read; a cache that cannot miss cannot detect a replaced anchor');
  assert.ok(afterAdvance.value.protectedSequence >= advanced.protectedSequence,
    'this process must observe the advanced protected head written by the other process, not its own stale one');
  // AND THIS IS WHY THE ANCHOR IS WARMED BEFORE THE LOCK IS TAKEN. The real
  // read forced above is the expensive one -- a whole powershell.exe against
  // the vault -- and on a machine with many agents writing, every record hits
  // it. If it is paid inside the transaction, the ledger's single writer is
  // held across it, which is the original defect. It must be paid outside.
  assert.ok(afterAdvance.inLockSpawns <= 1,
    `even when another process has just written the vault, at most one vault process may run inside the ledger transaction; saw ${afterAdvance.inLockSpawns}`);
});

// ---------------------------------------------------------------------------
// 5. THE SAME BUDGET, FOR THE READ PATH. audit.verify() takes the very same
//    single-writer lock as a record, and holds it across a full uncached ledger
//    walk -- so a vault spawn inside it is at least as costly as the one checks
//    3 and 4 police for records. Nothing asserted this until 2026-08-17, and a
//    real regression went straight through all ten audit suites because of it:
//    verify() was changed to pass deferReconciliation (correctly -- it was
//    verifying the whole ledger twice, 69,794 Ed25519 checks for 34,896 events),
//    but prepare() performs no anchor read before its deferred early return, so
//    the first real vault read of the process moved from outside the lock to
//    inside it.
//
//    The cold reset below is the point of the check, not incidental setup:
//    readAnchor's content-digest short circuit only fires once a real read has
//    happened in this process, so a warm process cannot show this defect. The
//    realAnchorReads precondition asserts that the expensive read genuinely
//    occurred, otherwise a build that never reads the vault at all would pass
//    this check while proving nothing.
// ---------------------------------------------------------------------------
check('audit.verify() never holds the ledger lock across a vault process', () => {
  audit.resetForTests();
  audit.requireRecord('lockscope.verify', 'seed', { phase: 1 });
  // Forget what a warm process knows: no cached anchor, no remembered vault
  // digest. This is now a cold process, exactly like a one-shot CLI, MCP or
  // worker invocation -- the case where verify() is actually used.
  audit.resetForTests();

  const measured = measure(() => audit.verify());

  assert.equal(measured.value.valid, true,
    `verify must pass on a healthy ledger: ${measured.value.reason || ''} ${measured.value.error || ''}`);
  assert.ok(measured.realAnchorReads >= 1,
    `precondition: a cold process must make at least one real vault anchor read, or this check proves nothing; saw ${measured.realAnchorReads}`);
  assert.equal(measured.anchorWrites, 0,
    `verify() on a ledger whose anchor is already at head must not write the anchor; saw ${measured.anchorWrites}`);
  assert.equal(measured.inLockSpawns, 0,
    `verify() must pay the vault BEFORE taking the ledger lock, never inside it; saw ${measured.inLockSpawns} vault process(es) inside the transaction`);
});

// Both of the checks below deliberately damage the ledger they run against --
// one drives a write through the emergency spool, the other rewrites a
// committed event. Neither may ever do that to the installation's own ledger.
// The spool one matters even though it "only" fails safe: the breach it plants
// lands in logs/audit-durability.json, which is the production health signal
// tools/audit-durability-check.js reports on, and a planted breach there is
// indistinguishable from a real one. A bare `node tests/audit-lock-scope.test.js`
// used to add exactly that, so the durability checker reported a CRITICAL
// window that the test run itself had manufactured. Run this suite through
// tests/run-isolated.js (or `npm test`), which redirects the ledger, the
// projections, the emergency spool and the vault into a scratch root.
function assertIsolatedLedger() {
  const ledger = process.env.TOOLSENABLED_AUDIT_DB;
  assert.ok(ledger && !path.resolve(ledger).endsWith(path.join('state', 'audit.sqlite3')),
    'this check only ever runs against an isolated ledger; run it via tests/run-isolated.js');
}

// ---------------------------------------------------------------------------
// 5. FAIL-CLOSED. A vault that will not accept the anchor write must refuse
//    the external mutation and must not leave the event in the ledger.
// ---------------------------------------------------------------------------
check('requireRecord still refuses, and remembers the breach, when the anchor cannot be written', () => {
  assertIsolatedLedger();
  const breachesBefore = audit.durability().totalBreachCount;
  assert.throws(
    () => audit.requireRecord('lockscope.failclosed', 'refused', { phase: 4 }, {
      setMonotonicSecret: () => { throw new Error('the vault refused the anchor write'); }
    }),
    error => error && error.name === 'AuditRequiredError' && error.code === 'AUDIT_UNAVAILABLE',
    'a failed anchor write must surface as a typed AUDIT_UNAVAILABLE refusal, never a warning or a best-effort success'
  );
  // The refusal is the contract; the spool-and-remember behaviour behind it is
  // what stops a refused write from becoming an invisible gap. A build that
  // downgraded the refusal to a warning would pass neither assertion.
  assert.ok(audit.durability().totalBreachCount > breachesBefore,
    'a non-durable write must be remembered in the durability record, not swallowed');
  // And the subsystem must recover rather than stay wedged: the spooled intent
  // is ingested and the next external write succeeds on its own merits.
  const recovered = audit.requireRecord('lockscope.failclosed', 'recovered', { phase: 4 });
  assert.equal(recovered.durable, true, 'a working vault must still produce a durable, anchored write afterwards');
  assert.equal(recovered.anchored, true, 'and it must still be protected by the monotonic head anchor');
});

// ---------------------------------------------------------------------------
// 6. TAMPER-EVIDENCE, END TO END. Edit a committed event behind the ledger's
//    back and both the verifier and the next write must refuse.
// ---------------------------------------------------------------------------
check('a tampered event is still detected, and the next external write still refuses', () => {
  assertIsolatedLedger();
  const ledger = process.env.TOOLSENABLED_AUDIT_DB;
  // Settle first: an earlier check deliberately drove a write through the
  // emergency spool, and a just-ingested spool item leaves the projections one
  // flush behind the ledger. That is a real (and correctly reported) invalid
  // state, but it is not the tampering this check is about.
  audit.record('lockscope.settle', 'before-tamper', {});
  audit.flush({ force: true });
  const baseline = audit.verify();
  assert.equal(baseline.valid, true,
    `the ledger must be valid before it is tampered with (reason: ${baseline.reason})`);

  const database = new DatabaseSync(ledger);
  try {
    const row = database.prepare('SELECT sequence, event_json FROM audit_events ORDER BY sequence LIMIT 1').get();
    const forged = JSON.parse(row.event_json);
    forged.target = 'tampered';
    database.prepare('UPDATE audit_events SET event_json = ? WHERE sequence = ?').run(JSON.stringify(forged), row.sequence);
  } finally {
    database.close();
  }

  audit.resetForTests();
  const verified = audit.verify();
  assert.equal(verified.valid, false, 'a rewritten event must make the canonical ledger verify as invalid');

  assert.throws(
    () => audit.requireRecord('lockscope.after-tamper', 'refused', { phase: 5 }),
    error => error && error.name === 'AuditRequiredError' && error.code === 'AUDIT_UNAVAILABLE',
    'an external write onto a tampered ledger must be refused'
  );
});

// ---------------------------------------------------------------------------
// 7. THE CHAIN HASH ITSELF, WITH NOTHING ELSE HELPING.
//
//    The check above proves the system as a whole notices a rewritten event,
//    but it does not prove WHICH witness noticed. It was written first and a
//    planted mutant showed why that matters: deleting the verifier's
//    `row.event_hash !== expectedHash` comparison outright left check 6 green,
//    because the independent projection files caught the same edit and the
//    per-event signature is computed over the STORED hash and so still
//    verified. The chain comparison -- the thing that makes the ledger
//    tamper-evident on its own, without any projection to compare against --
//    was therefore untested. This check isolates it: a private store, a test
//    signer, no projections, one canonical rewrite with the stored hash left
//    alone.
// ---------------------------------------------------------------------------
check('the chain verifier alone rejects a rewritten event whose stored hash was left untouched', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-lock-scope-chain-'));
  const file = path.join(directory, 'chain.sqlite3');
  const pair = crypto.generateKeyPairSync('ed25519');
  const testSigner = {
    keyId: `audit-lock-scope-${crypto.randomUUID().replace(/-/g, '')}`,
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, pair.privateKey)
  };
  let store = createAuditStore({ file });
  try {
    store.registerKey({ keyId: testSigner.keyId, publicKeyPem: testSigner.publicKeyPem, createdAtMs: Date.now() });
    for (let index = 1; index <= 3; index += 1) {
      store.appendEvent({
        eventId: `chain-event-${String(index).padStart(4, '0')}`,
        occurredAtMs: 1_700_000_000_000 + index,
        createdAtMs: 1_700_000_000_000 + index,
        event: { timestamp: new Date(1_700_000_000_000 + index).toISOString(), action: 'chain.test', target: `row-${index}`, details: {} }
      }, testSigner);
    }
    assert.equal(store.verify().valid, true, 'the private chain must verify before it is tampered with');
    store.close();

    const database = new DatabaseSync(file);
    try {
      const row = database.prepare('SELECT sequence, event_json FROM audit_events WHERE sequence = 2').get();
      const forged = JSON.parse(row.event_json);
      forged.target = 'tampered';
      // canonicalJson, so the rewrite cannot be caught by the cheaper
      // event-json-canonical check; only the hash comparison can see it.
      database.prepare('UPDATE audit_events SET event_json = ? WHERE sequence = ?').run(canonicalJson(forged), row.sequence);
    } finally {
      database.close();
    }

    store = createAuditStore({ file });
    const verification = store.verify();
    assert.equal(verification.valid, false,
      'a canonical rewrite of a committed event, with the stored hash and signature left alone, MUST fail the chain verifier');
    assert.equal(verification.reason, 'event-hash',
      `the chain verifier must name the event hash as the reason; saw ${verification.reason}`);
    assert.equal(verification.invalidSequence, 2, 'and it must name the sequence that was rewritten');
  } finally {
    try { store.close(); } catch { /* already closed */ }
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* windows may still hold the file */ }
  }
});

async function main() {
  // CAN-FAIL AUDIT (2026-08-26)
  //
  // MUTATION: replacing check() with a no-op made the former harness print
  // "audit-lock-scope: 0/0 checks passed" and exit 0. With the registration
  // census below, the same empty-registration mutant is RED:
  // "AssertionError [ERR_ASSERTION]: precondition: every audit lock-scope
  // check must be registered before the harness runs"
  // "+ actual - expected"
  // "+ []"
  //
  // RESTORE: check() is byte-for-byte unchanged. A complete green run could
  // not be performed here because the available Node.js is v20.20.2 and fails
  // during module loading with ERR_UNKNOWN_BUILTIN_MODULE for node:sqlite;
  // this suite requires the package's declared Node >=22.19.0 precondition.
  //
  // NOT-FOUND (2): no assertion treats non-zero exit or a merely truthy child
  // result as success; the child must exit 0, emit parseable JSON, and its
  // protected sequence is subsequently compared with the parent's result.
  // NOT-FOUND (3): try/finally blocks restore environment or close scratch
  // resources; none swallows a subject assertion. The two cleanup catches do
  // not enclose assertions or product calls whose failure is under test.
  // NOT-FOUND (4): the spawn and lock wrappers observe real implementations;
  // fail-closed dependency injection supplies only the intended vault fault,
  // while assertions inspect the real audit subsystem's refusal and recovery.
  // NOT-FOUND (5): isolation is an asserted precondition, not a skip, and no
  // platform guard silently bypasses this file.
  // NOT-FOUND (6): canonicalJson prepares a canonical tamper so an independent
  // verifier path must detect its unchanged stored hash; no expected assertion
  // value is computed by the implementation path that it checks.
  const expectedChecks = [
    'the vault change-detector used for the anchor cache is keyed on content, not size+mtime',
    'an unreadable vault reports unknown, never unchanged',
    'an external-write record holds the ledger lock across at most one vault process',
    'a busy anchor read is not cached as an absent anchor',
    'a warm local-write record spawns no vault process, and a cross-process anchor advance forces a real read outside the lock',
    'audit.verify() never holds the ledger lock across a vault process',
    'requireRecord still refuses, and remembers the breach, when the anchor cannot be written',
    'a tampered event is still detected, and the next external write still refuses',
    'the chain verifier alone rejects a rewritten event whose stored hash was left untouched'
  ];
  assert.deepEqual(checks.map(([name]) => name), expectedChecks,
    'precondition: every audit lock-scope check must be registered before the harness runs');

  let failed = 0;
  for (const [name, run] of checks) {
    try {
      await run();
      process.stdout.write(`ok - ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`not ok - ${name}\n`);
      process.stdout.write(`${String(error && error.stack ? error.stack : error)}\n`);
    }
  }
  process.stdout.write(`\naudit-lock-scope: ${checks.length - failed}/${checks.length} checks passed\n`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  process.stdout.write(`not ok - audit-lock-scope harness\n${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});
