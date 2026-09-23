'use strict';

// Regression proof for the 2026-08-10 product-wide external-write outage.
//
// A diagnostic probe copied state/audit.sqlite3 into a scratch directory and
// redirected TOOLSENABLED_AUDIT_DB at the copy, but left TOOLSENABLED_VAULT_PATH
// pointing at the installation vault. The copy therefore signed with the real
// vault key, and -- being one event ahead of the ledger it had been forked from
// -- won the monotonic comparison and advanced the PRODUCTION protected head to
// an event that exists only in the copy. Production's own event already held
// that sequence, so every fresh process afterwards failed validateAnchorEvent
// with AUDIT_ANCHOR_INTEGRITY_ALARM and requireRecord refused every
// external-write tool. A monotonic anchor cannot be moved back, so nothing
// healed on its own.
//
// This suite proves four things that must all stay true together:
//   1. requireRecord works on a healthy ledger (the positive control).
//   2. A ledger redirected away from the installation may not borrow the
//      installation vault -- refused before the signing key is ever read.
//   3. The fork-poisoning sequence really does break requireRecord, so the
//      guard in (2) is protecting against a live failure and not a story.
//   4. A genuinely tampered ledger STILL raises the integrity alarm. A fix
//      that quiets the alarm for the wrong reason is worse than the outage.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

for (const name of [
  'TOOLSENABLED_AUDIT_DB', 'TOOLSENABLED_AUDIT_JSONL_PATH', 'TOOLSENABLED_AUDIT_TEXT_PATH',
  'TOOLSENABLED_AUDIT_EMERGENCY_PATH', 'TOOLSENABLED_VAULT_PATH'
]) {
  if (!path.isAbsolute(process.env[name] || '')) throw new Error(`${name} must be isolated before this test runs.`);
}

const ROOT = path.resolve(__dirname, '..', '..');
const audit = require('../../src/lib/audit');
const { DEFAULT_AUDIT_DB } = require('../../src/lib/audit-store');
const isolatedRoot = path.dirname(process.env.TOOLSENABLED_AUDIT_DB);

function child(source, environment) {
  return spawnSync(process.execPath, ['-e', source], {
    cwd: ROOT, env: environment, encoding: 'utf8', windowsHide: true, timeout: 120_000
  });
}

try {
  // ---------------------------------------------------------------- 1. control
  // requireRecord must actually work when the ledger and its anchor agree.
  const intent = audit.requireRecord('probe.binding.control', 'binding-control', { phase: 'control' });
  assert.equal(intent.durable, true, 'a healthy ledger must record a durable intent');
  assert.equal(intent.anchored, true, 'a healthy ledger must protect the intent with the monotonic head');
  assert.ok(intent.sequence >= 1);
  assert.ok(intent.protectedSequence >= intent.sequence,
    'the protected head must cover the intent requireRecord just admitted');

  // ------------------------------------------------------------------ 2. guard
  // The rule is purely mechanical, so it is checked directly with synthetic
  // inputs: no real vault is involved in any branch below.
  assert.throws(
    () => audit.assertLedgerVaultBinding(
      { file: path.join(isolatedRoot, 'forked-copy.sqlite3') },
      { env: { TOOLSENABLED_AUDIT_DB: path.join(isolatedRoot, 'forked-copy.sqlite3') } }),
    error => error.code === 'AUDIT_LEDGER_VAULT_MISMATCH',
    'a redirected ledger with the installation vault must be refused');

  assert.throws(
    () => audit.assertLedgerVaultBinding({ file: ':memory:' }, { env: {} }),
    error => error.code === 'AUDIT_LEDGER_VAULT_MISMATCH',
    'an in-memory ledger is still not this installation, and must be refused too');

  // Blank is absent, matching how every other TOOLSENABLED_* path is resolved.
  assert.throws(
    () => audit.assertLedgerVaultBinding(
      { file: path.join(isolatedRoot, 'forked-copy.sqlite3') }, { env: { TOOLSENABLED_VAULT_PATH: '   ' } }),
    error => error.code === 'AUDIT_LEDGER_VAULT_MISMATCH',
    'a blank vault override must not read as an isolated vault');

  // Allowed: the vault moved with the ledger (every isolated test run).
  audit.assertLedgerVaultBinding(
    { file: path.join(isolatedRoot, 'forked-copy.sqlite3') },
    { env: { TOOLSENABLED_VAULT_PATH: path.join(isolatedRoot, 'vault.json') } });
  // Allowed: this installation's own ledger, named explicitly rather than by default.
  audit.assertLedgerVaultBinding({ file: DEFAULT_AUDIT_DB }, { env: {} });
  // Allowed: an injected secret plane is not the installation vault by construction.
  audit.assertLedgerVaultBinding({ file: path.join(isolatedRoot, 'forked-copy.sqlite3') },
    { env: {}, getSecret: () => null });
  audit.assertLedgerVaultBinding({ file: path.join(isolatedRoot, 'forked-copy.sqlite3') },
    { env: {}, anchorStore: { get: () => null, set: () => {} } });

  // Integration: prepare() must apply the guard, and must apply it BEFORE any
  // vault access. The child below points every audit path at a throwaway
  // directory and unsets only TOOLSENABLED_VAULT_PATH -- the exact asymmetry
  // that caused the outage. Its ledger is empty, so even a regressed guard
  // could not dominate a real anchor; the assertion is that it never gets far
  // enough to try.
  const guardRoot = path.join(isolatedRoot, 'guard-child');
  fs.mkdirSync(guardRoot, { recursive: true, mode: 0o700 });
  const guardEnvironment = { ...process.env };
  delete guardEnvironment.TOOLSENABLED_VAULT_PATH;
  guardEnvironment.TOOLSENABLED_AUDIT_DB = path.join(guardRoot, 'audit.sqlite3');
  guardEnvironment.TOOLSENABLED_AUDIT_JSONL_PATH = path.join(guardRoot, 'actions.jsonl');
  guardEnvironment.TOOLSENABLED_AUDIT_TEXT_PATH = path.join(guardRoot, 'actions.log');
  guardEnvironment.TOOLSENABLED_AUDIT_EMERGENCY_PATH = path.join(guardRoot, 'audit-emergency.jsonl');
  const guarded = child(`
    const audit = require(${JSON.stringify(path.join(ROOT, 'src', 'lib', 'audit.js'))});
    try { audit.status(); console.log('NO_GUARD'); }
    catch (error) { console.log(String(error && error.code)); }
  `, guardEnvironment);
  assert.equal(guarded.status, 0, guarded.stderr || guarded.stdout);
  assert.match(guarded.stdout, /AUDIT_LEDGER_VAULT_MISMATCH/,
    'prepare() must refuse a redirected ledger that is still pointed at the installation vault');
  assert.ok(!fs.existsSync(guardEnvironment.TOOLSENABLED_AUDIT_DB),
    'the refusal must happen before the redirected ledger is even created');

  // ------------------------------------------------------- 3. the outage itself
  // Reproduce the incident inside this isolated root, where both ledgers
  // legitimately share one isolated vault. This is what the guard above stops
  // from ever reaching the installation vault.
  audit.flush();
  const before = audit.status();
  assert.equal(before.headSequence, before.anchor.sequence,
    'the fork must be taken from a ledger whose anchor is already caught up');
  // Close first so the write-ahead log is checkpointed into the file being
  // copied; a bare copy of a live WAL database is a partial snapshot, which is
  // a different failure than the one under test.
  audit.resetForTests();
  const forkFile = path.join(isolatedRoot, 'forked-copy.sqlite3');
  const forkJsonl = path.join(isolatedRoot, 'fork-actions.jsonl');
  const forkText = path.join(isolatedRoot, 'fork-actions.log');
  fs.copyFileSync(process.env.TOOLSENABLED_AUDIT_DB, forkFile);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(process.env.TOOLSENABLED_AUDIT_DB + suffix)) {
      fs.copyFileSync(process.env.TOOLSENABLED_AUDIT_DB + suffix, forkFile + suffix);
    }
  }
  // The projections travel with the ledger, exactly as the real probe's scratch
  // directory carried its own actions.jsonl and actions.log beside the copy.
  fs.copyFileSync(process.env.TOOLSENABLED_AUDIT_JSONL_PATH, forkJsonl);
  fs.copyFileSync(process.env.TOOLSENABLED_AUDIT_TEXT_PATH, forkText);

  // The original ledger moves on with an ordinary record(), which deliberately
  // does NOT checkpoint the anchor on every append. That lag is what made the
  // real incident possible: the anchor still described sequence N while the
  // ledger already held N + 1, leaving the sequence unclaimed in the vault.
  const original = audit.record('probe.binding.original', 'binding-original', { phase: 'original' });
  assert.equal(original.durable, true, original.errors.map(entry => entry.message).join('; '));
  assert.equal(original.sequence, before.headSequence + 1);
  assert.equal(original.anchored, false,
    'an ordinary record() must leave the protected head lagging, as it did during the incident');
  audit.resetForTests();

  // The fork claims that same sequence with a different event, using the same
  // vault -- and wins the monotonic comparison because it is equally far ahead.
  const forkEnvironment = { ...process.env, TOOLSENABLED_AUDIT_DB: forkFile };
  forkEnvironment.TOOLSENABLED_AUDIT_JSONL_PATH = forkJsonl;
  forkEnvironment.TOOLSENABLED_AUDIT_TEXT_PATH = forkText;
  forkEnvironment.TOOLSENABLED_AUDIT_EMERGENCY_PATH = path.join(isolatedRoot, 'fork-audit-emergency.jsonl');
  const forked = child(`
    const audit = require(${JSON.stringify(path.join(ROOT, 'src', 'lib', 'audit.js'))});
    const status = audit.requireRecord('probe.binding.fork', 'binding-fork', { phase: 'fork' });
    console.log(JSON.stringify({ sequence: status.sequence, protectedSequence: status.protectedSequence }));
  `, forkEnvironment);
  assert.equal(forked.status, 0, forked.stderr || forked.stdout);
  const forkResult = JSON.parse(forked.stdout.trim().split(/\r?\n/).pop());
  assert.equal(forkResult.sequence, before.headSequence + 1,
    'the fork must claim the same sequence the original ledger just claimed');

  // The original ledger's protected head now describes an event it does not
  // contain. Both the status surface and the write path must fail closed.
  assert.throws(() => audit.status(),
    error => error.code === 'AUDIT_ANCHOR_INTEGRITY_ALARM'
      && /does not match the canonical ledger/.test(error.message),
    'a protected head pointing at a foreign event must raise the integrity alarm');
  // The refusal must SAY it is an integrity alarm. Wrapping it as a generic
  // "the audit ledger rejected a transaction" is what sent three separate
  // investigations after SQLITE_BUSY contention that was never happening.
  assert.throws(() => audit.requireRecord('probe.binding.after', 'binding-after', {}),
    error => error instanceof audit.AuditRequiredError && error.code === 'AUDIT_UNAVAILABLE'
      && (error.details.errors || []).some(entry => /protected audit head/i.test(entry.message))
      && !(error.details.errors || []).some(entry => /rejected a transaction/i.test(entry.message)),
    'requireRecord must refuse the external mutation and report WHY, not as a generic transaction failure');
  audit.resetForTests();

  // ------------------------------------------------------------ 4. still alarms
  // Independent of the fork case: truncate an anchored ledger and confirm the
  // alarm has not been weakened into silence by anything above.
  const tamperRoot = path.join(isolatedRoot, 'tamper');
  fs.mkdirSync(tamperRoot, { recursive: true, mode: 0o700 });
  const tamperEnvironment = { ...process.env };
  tamperEnvironment.TOOLSENABLED_AUDIT_DB = path.join(tamperRoot, 'audit.sqlite3');
  tamperEnvironment.TOOLSENABLED_AUDIT_JSONL_PATH = path.join(tamperRoot, 'actions.jsonl');
  tamperEnvironment.TOOLSENABLED_AUDIT_TEXT_PATH = path.join(tamperRoot, 'actions.log');
  tamperEnvironment.TOOLSENABLED_AUDIT_EMERGENCY_PATH = path.join(tamperRoot, 'audit-emergency.jsonl');
  tamperEnvironment.TOOLSENABLED_VAULT_PATH = path.join(tamperRoot, 'vault.json');

  const seeded = child(`
    const audit = require(${JSON.stringify(path.join(ROOT, 'src', 'lib', 'audit.js'))});
    audit.requireRecord('probe.tamper.seed', 'tamper-seed', {});
    const status = audit.requireRecord('probe.tamper.head', 'tamper-head', {});
    console.log(JSON.stringify({ sequence: status.sequence, protectedSequence: status.protectedSequence }));
  `, tamperEnvironment);
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
  const seedResult = JSON.parse(seeded.stdout.trim().split(/\r?\n/).pop());
  assert.ok(seedResult.protectedSequence >= seedResult.sequence,
    'the tamper fixture must be anchored at its head before it is damaged');

  // Erase the ledger behind its protected head and tidy up after the erasure
  // the way an attacker would: sink cursors reset, projections blanked, so the
  // remaining chain verifies as internally consistent. The ONLY thing left
  // that can tell what happened is the protected head in the vault -- which is
  // exactly the evidence this mechanism exists to preserve.
  const database = new DatabaseSync(tamperEnvironment.TOOLSENABLED_AUDIT_DB);
  try {
    database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE; DELETE FROM audit_events;');
    database.prepare(`UPDATE audit_sink_state SET last_sequence = 0, last_hash = ?, failure_count = 0,
      retry_at_ms = NULL, last_error = NULL`).run('0'.repeat(64));
    database.exec('COMMIT;');
  } finally { database.close(); }
  fs.writeFileSync(tamperEnvironment.TOOLSENABLED_AUDIT_JSONL_PATH, '', 'utf8');
  fs.writeFileSync(tamperEnvironment.TOOLSENABLED_AUDIT_TEXT_PATH, '', 'utf8');

  const alarmed = child(`
    const audit = require(${JSON.stringify(path.join(ROOT, 'src', 'lib', 'audit.js'))});
    try { audit.status(); console.log('SILENT'); }
    catch (error) { console.log(String(error && error.code)); }
  `, tamperEnvironment);
  assert.equal(alarmed.status, 0, alarmed.stderr || alarmed.stdout);
  assert.match(alarmed.stdout, /AUDIT_ANCHOR_INTEGRITY_ALARM/,
    'a truncated ledger must still raise the integrity alarm, guard or no guard');

  const refused = child(`
    const audit = require(${JSON.stringify(path.join(ROOT, 'src', 'lib', 'audit.js'))});
    try { audit.requireRecord('probe.tamper.after', 'tamper-after', {}); console.log('ADMITTED'); }
    catch (error) { console.log(String(error && error.code)); }
  `, tamperEnvironment);
  assert.equal(refused.status, 0, refused.stderr || refused.stdout);
  assert.match(refused.stdout, /AUDIT_UNAVAILABLE/,
    'a truncated ledger must still refuse external mutations');

  console.log('Audit ledger/vault binding test passed (control, guard, fork outage, tamper alarm).');
} finally {
  audit.resetForTests();
}
