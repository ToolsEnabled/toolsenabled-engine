// EXECUTABLE CHANGE
//
// Test-can-fail report (testcanfail-tests-kernel-state-agent-coord-attest-migrate-js):
// - STRENGTHENED: the forged value-hash assertion used hashInput both to write
//   and to compute its expected value. Mutation: hashInput returned 64 zeroes.
//   Before this independent oracle was added, execution passed this assertion.
//   With it, the mutation is RED:
//     AssertionError [ERR_ASSERTION]: the forged hash matches the independently calculated SHA-256
//     + actual - expected
//     + '0000000000000000000000000000000000000000000000000000000000000000'
//     - '5bb792c27d8b17695bb75bc1150f60e8f182588ddce52f0309626b73fcd41348'
// - NOT-FOUND (1): no assertion is confined to a possibly-empty loop. The only
//   unbounded loop is best-effort fixture cleanup and contains no assertion.
// - NOT-FOUND (2): this in-process test makes no exit-status assertion.
// - NOT-FOUND (3): no tested failure is swallowed. finally blocks restore
//   stdout/close handles; the cleanup catch is unrelated to a product claim.
// - NOT-FOUND (4): no mock substitutes for the migration or integrity subject.
// - NOT-FOUND (5): there is no skip or platform precondition guard.
// - NOT-FOUND (6), otherwise: all other computed expectations either use fixed
//   literals or independently observable state; no other same-code oracle found.
// - PRECONDITION NOT MET: this checkout has no live state database, so the
//   existing LIVE APPLY assertion fails with SOURCE_MISSING before both the
//   baseline and restored full-file runs can finish. It was not weakened.
//   Restored-source run output:
//     AssertionError [ERR_ASSERTION]: apply refuses the live database
//     at tests/kernel.state/agent-coord-attest-migrate.js:363:12
// - RESTORATION: src/lib/state-store.js SHA-256 before and after mutation was
//   b615db5aafd92de72b350cbff129ff3a28076cf7a325a220fbce740caf364064.

'use strict';

// End-to-end proof for tools/agent-coord-attest-migrate.js.
//
// Everything here runs against throwaway temp databases built by
// createStateStore -- schema-identical to state/toolsenabled.sqlite3 but
// containing only synthetic content. The live database is never opened, and
// the test asserts that fact structurally (see LIVE REFUSAL below) rather than
// just avoiding it by convention.
//
// The attacker modelled throughout is the one that actually exists on a
// machine like this one: a principal with raw write access to the database
// FILE (on the machine this was written on, BUILTIN\Users and a local sandbox
// group both hold Modify -- the exact principal names are per-machine and not
// load-bearing here) who does NOT hold the signing secret. Every forgery below
// is performed the way that attacker would perform it -- a direct SQL UPDATE
// that bypasses the mediated memory.set path entirely, recomputing whatever
// unkeyed hashes it needs.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createStateStore, hashInput } = require('../../src/lib/state-store');
const integrity = require('../../src/lib/agent-coord-integrity');
const migrate = require('../../tools/agent-coord-attest-migrate');

const temporaryRoots = [];
function fixtureDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-attest-${name}-`));
  temporaryRoots.push(dir);
  return dir;
}

// PROVING "THE SOURCE WAS NOT MODIFIED" TAKES TWO ASSERTIONS, NOT ONE.
//
// The first version of this helper hashed the main file plus -wal plus -shm
// and demanded all three be identical. That failed, and the failure was
// informative rather than a test bug: opening a SQLite database READ-ONLY is
// not a zero-footprint filesystem operation. It creates a 0-byte -wal and a
// 32 KB -shm (measured on node 22.19 / this machine) because WAL mode needs
// shared-memory coordination even for readers. That is precisely why the
// earlier naive ACL tighten broke sandboxed readonly MCP reads: a reader needs
// WRITE access to the DIRECTORY even though it never writes the database.
//
// So the honest pair of properties is:
//   dataDigest()      -- the main database file is byte-for-byte identical.
//   journaledBytes()  -- the -wal is empty, i.e. no transaction was journaled.
// Checking only the first would be unsound under WAL, since a committed write
// can live in the -wal with the main file untouched. Checking both is tight.
function dataDigest(statePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(statePath)).digest('hex');
}

function journaledBytes(statePath) {
  const wal = `${statePath}-wal`;
  return fs.existsSync(wal) ? fs.statSync(wal).size : 0;
}

function assertSourceUntouched(statePath, baseline, label) {
  assert.equal(dataDigest(statePath), baseline, `${label}: the source database file must be byte-identical`);
  assert.equal(journaledBytes(statePath), 0, `${label}: the source WAL must contain no journaled transaction`);
}

function seedStore(dir, entries) {
  const statePath = path.join(dir, 'toolsenabled.sqlite3');
  const store = createStateStore({ file: statePath });
  for (const entry of entries) store.setMemory({ namespace: 'agent-coord', key: entry.key, value: entry.value });
  store.close();
  return statePath;
}

function rawRow(statePath, key) {
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    return db.prepare(`SELECT namespace, entry_key AS key, value_hash AS valueHash, revision
      FROM memory_entries WHERE namespace = 'agent-coord' AND entry_key = ?`).get(key);
  } finally { db.close(); }
}

// The forgery. Bypasses memory.set, writes value_json directly, and recomputes
// the plain unkeyed value_hash so the row stays internally self-consistent --
// which is exactly why the pre-existing sha256 proves nothing.
function forgeRow(statePath, key, forgedValue, { bumpRevision }) {
  const db = new DatabaseSync(statePath);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.prepare(`UPDATE memory_entries SET value_json = ?, value_hash = ?, revision = revision + ?
      WHERE namespace = 'agent-coord' AND entry_key = ?`)
      .run(JSON.stringify(forgedValue), hashInput(forgedValue), bumpRevision ? 1 : 0, key);
  } finally { db.close(); }
}

function readAttestation(sidecarPath, key) {
  const db = new DatabaseSync(sidecarPath, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM attestations WHERE namespace = 'agent-coord' AND entry_key = ?").get(key);
  } finally { db.close(); }
}

function writeAttestationField(sidecarPath, key, column, value) {
  const db = new DatabaseSync(sidecarPath);
  try {
    db.prepare(`UPDATE attestations SET ${column} = ? WHERE namespace = 'agent-coord' AND entry_key = ?`).run(value, key);
  } finally { db.close(); }
}

function verdictFor(secret, statePath, sidecarPath, key, options = {}) {
  const row = rawRow(statePath, key);
  const stored = fs.existsSync(sidecarPath) ? readAttestation(sidecarPath, key) : null;
  return integrity.classifyEntry(secret, {
    row,
    attestation: stored ? {
      kind: stored.kind, namespace: stored.namespace, key: stored.entry_key, revision: stored.revision,
      valueHash: stored.value_hash, author: JSON.parse(stored.author_json), signedAtMs: stored.signed_at_ms
    } : null,
    mac: stored ? stored.mac : null,
    expectedKeyFingerprint: integrity.keyFingerprint(secret),
    attestedKeyFingerprint: stored ? stored.key_fingerprint : undefined,
    ...options
  });
}

// Silence the tool's own stdout so the proof output stays readable; failures
// still surface through assertions and the returned result objects.
function quietly(fn) {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = original; }
}

(async () => {
  try {
    const secret = crypto.randomBytes(32);
    const secretEnv = 'TOOLSENABLED_TEST_ATTEST_SECRET';
    process.env[secretEnv] = secret.toString('hex');

    // ---------------------------------------------------------------------
    // 1. DRY RUN CHANGES NOTHING.
    // ---------------------------------------------------------------------
    const dir = fixtureDir('main');
    const statePath = seedStore(dir, [
      { key: 'genuine-instruction', value: { msg: 'lane A: hold the release until the audit lands' } },
      { key: 'second-entry', value: { msg: 'lane B: bridge status is green' } },
      { key: 'third-entry', value: { msg: 'lane C: nothing to report' } }
    ]);
    const sidecarPath = migrate.sidecarPathFor(statePath);

    const digestBeforeDryRun = dataDigest(statePath);
    const dryRun = quietly(() => migrate.modeDryRun({ state: statePath, namespace: 'agent-coord', secretEnv }));
    assert.equal(dryRun.plan.wouldWriteBaselineRows, 3, 'dry run reports the exact number of rows it would baseline');
    assert.equal(dryRun.plan.sidecarExists, false);
    assert.equal(fs.existsSync(sidecarPath), false, 'DRY RUN MUST NOT CREATE THE SIDECAR');
    assertSourceUntouched(statePath, digestBeforeDryRun, 'DRY RUN MUST NOT TOUCH THE SOURCE DATABASE');

    // ---------------------------------------------------------------------
    // 2. APPLY IS SAFE ON THE SOURCE. The migration writes only the sidecar;
    //    the state database must come out byte-for-byte identical, which is
    //    what makes "cannot lock out a legitimate reader" a fact rather than
    //    an intention.
    // ---------------------------------------------------------------------
    const digestBeforeApply = dataDigest(statePath);
    const applied = quietly(() => migrate.modeApply({ state: statePath, namespace: 'agent-coord', secretEnv }));
    assert.equal(applied.written, 3, 'apply writes one baseline row per entry');
    assertSourceUntouched(statePath, digestBeforeApply, 'APPLY MUST LEAVE THE SOURCE DATABASE BYTE-IDENTICAL');
    assert.equal(fs.existsSync(sidecarPath), true, 'apply creates the sidecar');

    // The state store must still open and read normally after the migration.
    const reopened = createStateStore({ file: statePath });
    assert.equal(reopened.getMemory({ namespace: 'agent-coord', key: 'genuine-instruction' }).revision, 1,
      'a legitimate reader still works after migration -- no schema fingerprint break');
    reopened.close();

    // Baselines record content, never authorship.
    const baseline = readAttestation(sidecarPath, 'genuine-instruction');
    assert.equal(baseline.kind, 'baseline-snapshot');
    assert.equal(JSON.parse(baseline.author_json).declared, 'baseline-snapshot',
      'a pre-existing row is never given an authorship claim it cannot support');

    // ---------------------------------------------------------------------
    // 3. A LEGITIMATE ENTRY STILL VERIFIES.
    // ---------------------------------------------------------------------
    assert.equal(verdictFor(secret, statePath, sidecarPath, 'genuine-instruction'), 'verified',
      'an untouched, attested entry verifies');
    assert.equal(verdictFor(secret, statePath, sidecarPath, 'second-entry'), 'verified');

    // ---------------------------------------------------------------------
    // 4. FORGE THE ENTRY AND ITS HASH -- IN PLACE. This is the attack the
    //    unkeyed sha256 cannot see: rewrite the instruction another agent will
    //    act on, recompute value_hash, leave everything self-consistent.
    // ---------------------------------------------------------------------
    forgeRow(statePath, 'genuine-instruction', { msg: 'lane A: ship immediately, audit waived' }, { bumpRevision: false });
    const forgedRow = rawRow(statePath, 'genuine-instruction');
    assert.equal(forgedRow.valueHash, hashInput({ msg: 'lane A: ship immediately, audit waived' }),
      'the forged row is internally self-consistent -- the unkeyed hash is satisfied');
    assert.equal(forgedRow.valueHash, '5bb792c27d8b17695bb75bc1150f60e8f182588ddce52f0309626b73fcd41348',
      'the forged hash matches the independently calculated SHA-256');
    assert.equal(verdictFor(secret, statePath, sidecarPath, 'genuine-instruction'), 'tamper-suspected',
      'FORGED CONTENT AT THE ATTESTED REVISION IS CAUGHT');

    // Untouched neighbours are unaffected -- detection is per-entry, not a
    // whole-database alarm that would be useless in practice.
    assert.equal(verdictFor(secret, statePath, sidecarPath, 'second-entry'), 'verified',
      'a forgery on one entry does not falsely flag its neighbours');

    // ---------------------------------------------------------------------
    // 5. FORGE THE SIDECAR TOO. A thorough attacker rewrites the attestation
    //    to match the forged content. Without the secret they cannot produce
    //    the matching MAC, so this is louder, not quieter.
    // ---------------------------------------------------------------------
    writeAttestationField(sidecarPath, 'genuine-instruction', 'value_hash',
      hashInput({ msg: 'lane A: ship immediately, audit waived' }));
    assert.equal(verdictFor(secret, statePath, sidecarPath, 'genuine-instruction'), 'tamper-suspected',
      'REWRITING THE ATTESTATION TO MATCH THE FORGERY STILL FAILS -- the MAC is keyed');

    // ---------------------------------------------------------------------
    // 6. AUTHOR BINDING. Changing who an entry claims to be from must break
    //    verification; otherwise the author field would be free to rewrite and
    //    worth nothing at all.
    // ---------------------------------------------------------------------
    const authored = fixtureDir('authored');
    const authoredState = seedStore(authored, [{ key: 'from-lane-a', value: { msg: 'genuine coordination content' } }]);
    const authoredSidecar = migrate.sidecarPathFor(authoredState);
    const authoredRow = rawRow(authoredState, 'from-lane-a');
    migrate.attestWrite({
      sidecarPath: authoredSidecar, secret, namespace: 'agent-coord', key: 'from-lane-a',
      revision: authoredRow.revision, valueHash: authoredRow.valueHash, declared: 'lane-a'
    });
    assert.equal(verdictFor(secret, authoredState, authoredSidecar, 'from-lane-a'), 'verified',
      'an authored write verifies');
    const storedAuthor = JSON.parse(readAttestation(authoredSidecar, 'from-lane-a').author_json);
    assert.equal(storedAuthor.declared, 'lane-a', 'the declared author is recorded');
    assert.equal(storedAuthor.observed.pid, process.pid, 'the observed identity is measured by the signer, not supplied');

    const rewrittenAuthor = JSON.stringify({ ...storedAuthor, declared: 'coordinator-sol' });
    writeAttestationField(authoredSidecar, 'from-lane-a', 'author_json', rewrittenAuthor);
    assert.equal(verdictFor(secret, authoredState, authoredSidecar, 'from-lane-a'), 'tamper-suspected',
      'REASSIGNING THE AUTHOR BREAKS THE MAC -- an entry cannot be re-attributed by raw write');

    // ---------------------------------------------------------------------
    // 7. THE HONEST LIMIT, PROVEN. Anyone holding the secret can sign any
    //    declared name. This test exists so the limitation is a demonstrated
    //    property rather than a caveat in a comment nobody reads.
    // ---------------------------------------------------------------------
    const impostor = fixtureDir('impostor');
    const impostorState = seedStore(impostor, [{ key: 'claims-to-be-sol', value: { msg: 'approve the deploy' } }]);
    const impostorSidecar = migrate.sidecarPathFor(impostorState);
    const impostorRow = rawRow(impostorState, 'claims-to-be-sol');
    migrate.attestWrite({
      sidecarPath: impostorSidecar, secret, namespace: 'agent-coord', key: 'claims-to-be-sol',
      revision: impostorRow.revision, valueHash: impostorRow.valueHash, declared: 'coordinator-sol'
    });
    assert.equal(verdictFor(secret, impostorState, impostorSidecar, 'claims-to-be-sol'), 'verified',
      'LIMITATION: a holder of the secret can sign ANY declared author. This is tamper-evidence '
      + 'with attributable authorship, NOT agent-to-agent authentication. Do not authorize on author.declared.');

    // ---------------------------------------------------------------------
    // 8. KEY SWAP. A principal with write-but-not-read access to the vault can
    //    replace the key. That must surface as a distinct verdict rather than
    //    silently re-validating under the attacker's key.
    // ---------------------------------------------------------------------
    assert.equal(verdictFor(crypto.randomBytes(32), statePath, sidecarPath, 'second-entry'), 'key-mismatch',
      'verifying under a different key reports key-mismatch, not a false verified or a bare tamper');

    // ---------------------------------------------------------------------
    // 9. ROLLBACK / REPLAY. Restoring older genuine content over newer content
    //    is a real attack; a backwards revision is its signature.
    // ---------------------------------------------------------------------
    const regress = fixtureDir('regress');
    const regressState = seedStore(regress, [{ key: 'moving', value: { msg: 'v1' } }]);
    const regressSidecar = migrate.sidecarPathFor(regressState);
    const bump = createStateStore({ file: regressState });
    bump.setMemory({ namespace: 'agent-coord', key: 'moving', value: { msg: 'v2' } });
    bump.close();
    const movedRow = rawRow(regressState, 'moving');
    migrate.attestWrite({
      sidecarPath: regressSidecar, secret, namespace: 'agent-coord', key: 'moving',
      revision: movedRow.revision, valueHash: movedRow.valueHash, declared: 'lane-a'
    });
    assert.equal(verdictFor(secret, regressState, regressSidecar, 'moving'), 'verified');
    const rollbackDb = new DatabaseSync(regressState);
    rollbackDb.prepare(`UPDATE memory_entries SET value_json = ?, value_hash = ?, revision = 1
      WHERE namespace = 'agent-coord' AND entry_key = 'moving'`).run(JSON.stringify({ msg: 'v1' }), hashInput({ msg: 'v1' }));
    rollbackDb.close();
    assert.equal(verdictFor(secret, regressState, regressSidecar, 'moving'), 'revision-regressed',
      'restoring older content over newer content is caught as a rollback, not mistaken for normal');

    // ---------------------------------------------------------------------
    // 10. THE SEAM, EXPLICITLY. A row that advances past its attestation is
    //     'changed-since-attestation' while the write path does not sign, and
    //     tamper once it does. The classifier must never guess which world it
    //     is in.
    // ---------------------------------------------------------------------
    forgeRow(statePath, 'third-entry', { msg: 'forged: revision bumped to look natural' }, { bumpRevision: true });
    assert.equal(verdictFor(secret, statePath, sidecarPath, 'third-entry'), 'changed-since-attestation',
      'pre-wiring: an advanced revision is indistinguishable from a legitimate write -- reported as unknown, not as verified');
    assert.equal(verdictFor(secret, statePath, sidecarPath, 'third-entry', { expectSigned: true }), 'tamper-suspected',
      'post-wiring (expectSigned): the same row is an alarm, because every legitimate write would have been signed');

    // ---------------------------------------------------------------------
    // 11. AGGREGATE VERIFY through the tool's own CLI surface.
    // ---------------------------------------------------------------------
    const verified = quietly(() => migrate.modeVerify({ state: statePath, namespace: 'agent-coord', secretEnv }));
    assert.equal(verified.ok, false, 'verify fails overall while a tampered entry is present');
    assert.equal(verified.counts['tamper-suspected'], 1, 'exactly the forged entry is flagged as tamper');
    assert.equal(verified.counts.verified, 1, 'the untouched entry still verifies');

    // ---------------------------------------------------------------------
    // 12. ROLLBACK OF THE MIGRATION ITSELF. Reversibility is total because the
    //     migration only ever created a file.
    // ---------------------------------------------------------------------
    const clean = fixtureDir('rollback');
    const cleanState = seedStore(clean, [{ key: 'entry', value: { msg: 'content' } }]);
    const cleanSidecar = migrate.sidecarPathFor(cleanState);
    const beforeMigration = dataDigest(cleanState);
    quietly(() => migrate.modeApply({ state: cleanState, namespace: 'agent-coord', secretEnv }));
    assert.equal(fs.existsSync(cleanSidecar), true);
    quietly(() => migrate.modeRollback({ state: cleanState }));
    assert.equal(fs.existsSync(cleanSidecar), false, 'rollback removes the sidecar');
    assertSourceUntouched(cleanState, beforeMigration,
      'ROLLBACK RESTORES THE EXACT PRE-MIGRATION STATE -- the source was never modified in the first place');
    const afterRollback = createStateStore({ file: cleanState });
    assert.equal(afterRollback.getMemory({ namespace: 'agent-coord', key: 'entry' }).value.msg, 'content',
      'the store reads normally after rollback');
    afterRollback.close();

    // ---------------------------------------------------------------------
    // 13. LIVE REFUSAL. Mutating modes must refuse the live database by path,
    //     not by the caller remembering to pass a copy.
    // ---------------------------------------------------------------------
    // Path-only refusal must precede even existence checks or canonicalization
    // of the known live path. A missing/locked/corrupt live database must not
    // change the refusal or make this control depend on owner state.
    const livePathKey = path.resolve(migrate.LIVE_STATE_PATH).toLowerCase();
    const liveProbes = [];
    const originalExists = fs.existsSync;
    const originalRealpath = fs.realpathSync.native;
    const rejectLiveProbe = target => {
      if (typeof target === 'string' && path.resolve(target).toLowerCase() === livePathKey) {
        liveProbes.push(target);
        throw Object.assign(new Error('The known live database must not be probed'), { code: 'TEST_LIVE_PROBE' });
      }
    };
    fs.existsSync = (target, ...args) => { rejectLiveProbe(target); return originalExists(target, ...args); };
    fs.realpathSync.native = (target, ...args) => { rejectLiveProbe(target); return originalRealpath(target, ...args); };
    try {
      const liveSpellings = [migrate.LIVE_STATE_PATH,
        `${path.dirname(migrate.LIVE_STATE_PATH)}${path.sep}unused${path.sep}..${path.sep}${path.basename(migrate.LIVE_STATE_PATH)}`];
      assert.notEqual(liveSpellings[0], liveSpellings[1], 'the normalized-path control uses a distinct input spelling');
      if (process.platform === 'win32') liveSpellings.push(migrate.LIVE_STATE_PATH.toUpperCase());
      for (const livePath of liveSpellings) {
        assert.throws(() => migrate.modeApply({ state: livePath, namespace: 'agent-coord', secretEnv }),
          error => error.code === 'LIVE_APPLY_REFUSED', 'apply refuses the live database before reading it');
        assert.throws(() => migrate.modeRollback({ state: livePath }),
          error => error.code === 'LIVE_ROLLBACK_REFUSED', 'rollback refuses the live database before reading it');
        assert.equal(migrate.isLivePath(livePath), true);
      }
      assert.deepEqual(liveProbes, [], 'known live-path refusals make zero filesystem probes');
    } finally {
      fs.existsSync = originalExists;
      fs.realpathSync.native = originalRealpath;
    }
    assert.equal(migrate.isLivePath(statePath), false);
    const missingCopy = path.join(fixtureDir('missing-copy'), 'toolsenabled.sqlite3');
    assert.throws(() => migrate.modeApply({ state: missingCopy, namespace: 'agent-coord', secretEnv }),
      error => error.code === 'SOURCE_MISSING', 'a missing non-live copy still reports the missing source');
    assert.equal(fs.existsSync(migrate.sidecarPathFor(missingCopy)), false, 'a missing copy creates no sidecar');

    // Default mode is the harmless one: a forgotten mode argument must not mutate.
    assert.equal(migrate.parseArgs([]).mode, 'dry-run', 'the default mode is dry-run');
    assert.equal(migrate.parseArgs([]).state, migrate.LIVE_STATE_PATH);

    // THE READ-ONLY HANDLE ITSELF. Every claim this tool makes about being
    // unable to damage the state store rests on one flag in one function. A
    // mutation run proved that deleting `readOnly: true` did NOT turn any
    // other assertion red -- the digest checks above cannot see it, because
    // merely holding a writable handle changes no bytes. So assert the
    // capability directly: a write through the source handle must be refused
    // by SQLite, not merely declined by this tool's good manners.
    const sourceHandle = migrate.openSource(statePath);
    try {
      assert.throws(
        () => sourceHandle.exec("UPDATE memory_entries SET value_json = '{\"x\":1}' WHERE namespace = 'agent-coord'"),
        error => /attempt to write a readonly database/i.test(error.message),
        'THE SOURCE HANDLE MUST BE READ-ONLY -- this is the structural guarantee that no mode can write the state store'
      );
    } finally { sourceHandle.close(); }

    // ---------------------------------------------------------------------
    // 14. NO SECRET LEAKS. The secret must never appear in tool output.
    // ---------------------------------------------------------------------
    let captured = '';
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = chunk => { captured += String(chunk); return true; };
    try { migrate.modeVerify({ state: statePath, namespace: 'agent-coord', secretEnv }); }
    finally { process.stdout.write = original; }
    assert.equal(captured.includes(secret.toString('hex')), false, 'the raw secret never reaches stdout');
    assert.equal(captured.includes(integrity.keyFingerprint(secret)), true, 'only the non-reversible fingerprint is printed');
    assert.equal(captured.includes('ship immediately'), false, 'entry CONTENT is never printed in a verification report');

    delete process.env[secretEnv];
    process.stdout.write('agent-coord-attest-migrate proof passed\n');
  } finally {
    for (const dir of temporaryRoots) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); }
      catch (error) { console.error(`(non-fatal) temp cleanup failed for ${dir}: ${error.message}`); }
    }
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
