'use strict';

// agent-coord attestation migration -- dry-run by default, sidecar by design.
//
// WHY A SIDECAR FILE AND NOT A COLUMN. The obvious implementation of "record
// who wrote this entry" is ALTER TABLE memory_entries ADD COLUMN author/mac.
// On this codebase that is a catastrophic change, and the reason is not
// obvious until you read src/lib/state-store.js:
//
//   _open() -> _migrate() -> _validateSchema() runs on EVERY connection, and
//   _validateSchema() does two things that make out-of-band DDL fatal:
//     1. it compares each required table's exact column list, in order,
//        against a hardcoded expectation (REQUIRED_SCHEMA / the table map at
//        the top of state-store.js), and
//     2. it hashes the ENTIRE sqlite_schema DDL into a fingerprint and
//        compares it to expectedSchemaFingerprint(version), which is computed
//        by replaying the migration constants into a fresh :memory: database.
//
//   Either check failing throws STATE_SCHEMA_INVALID. Not a warning -- the
//   connection does not open. Adding a column, or even adding an unrelated
//   TABLE or INDEX, to state/toolsenabled.sqlite3 changes that fingerprint and
//   therefore bricks every reader and writer at once: every agent, the MCP
//   server, the dashboard, the local sidecar, the scheduler. That is the exact "locks out
//   a legitimate reader" failure this migration was required to avoid, and it
//   would be total rather than partial. Recovery would mean hand-editing the
//   live database of a running system.
//
//   So the attestation ledger lives in its OWN database file next to the state
//   store: state/agent-coord-attest.sqlite3. Consequences, all of them good:
//     - state/toolsenabled.sqlite3 keeps a byte-identical schema, so its
//       fingerprint check keeps passing and no existing reader is affected.
//     - rollback is deleting one file. There is no data migration to undo and
//       no window in which the main database is half-migrated.
//     - a reader that cannot see the sidecar degrades to 'unattested' instead
//       of failing, so verification can be a privileged operation without
//       breaking unprivileged readers.
//     - the ACL question is decoupled: the sidecar can be locked down on its
//       own without touching state/ directory permissions, which is what the
//       earlier naive tighten broke (WAL needs directory write access for
//       sandboxed readonly readers).
//
// THIS TOOL NEVER WRITES THE SOURCE DATABASE. Every mode opens it through
// openSource() with readOnly:true -- including `apply`. The only file this
// tool can create or modify is the sidecar. That is enforced structurally, in
// one function, rather than by being careful at each call site.
//
// Live deployment is owner-gated and refused here. `dry-run` and `status` are
// read-only and are allowed against the live path; `apply` and `rollback` are
// not, and say so instead of doing something clever.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const integrity = require('../src/lib/agent-coord-integrity');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIVE_STATE_PATH = path.join(REPO_ROOT, 'state', 'toolsenabled.sqlite3');
const SIDECAR_SUFFIX = 'agent-coord-attest.sqlite3';
const SCHEME_VERSION = 2;
const SIGNER_VERSION = 1;
// A distinct application_id so this file can never be mistaken for -- or
// opened as -- a ToolsEnabled state database. state-store.js fails closed with
// STATE_DATABASE_IDENTITY if it is ever pointed here by accident.
const SIDECAR_APPLICATION_ID = 0x54454143; // "TEAC"
const DEFAULT_NAMESPACE = 'agent-coord';

const SIDECAR_SCHEMA = `
  CREATE TABLE attest_header (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    scheme_version INTEGER NOT NULL CHECK(scheme_version >= 1),
    key_fingerprint TEXT NOT NULL CHECK(length(key_fingerprint) = 16),
    source_path TEXT NOT NULL CHECK(length(source_path) BETWEEN 1 AND 4096),
    namespace TEXT NOT NULL CHECK(length(namespace) BETWEEN 1 AND 100),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
  ) STRICT;
  CREATE TABLE attestations (
    namespace TEXT NOT NULL CHECK(length(namespace) BETWEEN 1 AND 100),
    entry_key TEXT NOT NULL CHECK(length(entry_key) BETWEEN 1 AND 200),
    kind TEXT NOT NULL CHECK(kind IN ('authored','baseline-snapshot')),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    value_hash TEXT NOT NULL CHECK(length(value_hash) = 64 AND value_hash NOT GLOB '*[^0-9a-f]*'),
    author_json TEXT NOT NULL CHECK(json_valid(author_json)),
    signed_at_ms INTEGER NOT NULL CHECK(signed_at_ms >= 0),
    key_fingerprint TEXT NOT NULL CHECK(length(key_fingerprint) = 16),
    mac TEXT NOT NULL CHECK(length(mac) = 64 AND mac NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY(namespace, entry_key)
  ) STRICT;
  PRAGMA user_version = ${SCHEME_VERSION};
`;

class MigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

function sidecarPathFor(sourcePath) {
  return path.join(path.dirname(path.resolve(sourcePath)), SIDECAR_SUFFIX);
}

function isLivePath(sourcePath) {
  // The known live path is forbidden independently of its existence, access
  // permissions or SQLite state. Do not probe it merely to refuse it.
  if (path.resolve(sourcePath).toLowerCase() === LIVE_STATE_PATH.toLowerCase()) return true;
  const resolve = target => {
    try { return fs.realpathSync.native(target); } catch { return path.resolve(target); }
  };
  return resolve(sourcePath).toLowerCase() === resolve(LIVE_STATE_PATH).toLowerCase();
}

// THE ONLY DOOR TO THE SOURCE DATABASE. readOnly is not a parameter, and
// there is no second opener, so no mode of this tool can write the state
// store even by mistake.
function openSource(sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    throw new MigrationError('SOURCE_MISSING', `Source database not found: ${sourcePath}`);
  }
  return new DatabaseSync(sourcePath, { readOnly: true, allowExtension: false });
}

function openSidecar(sidecarPath, { create }) {
  const exists = fs.existsSync(sidecarPath);
  if (!exists && !create) throw new MigrationError('SIDECAR_MISSING', `Attestation sidecar not found: ${sidecarPath}`);
  const db = new DatabaseSync(sidecarPath, { allowExtension: false });
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const applicationId = db.prepare('PRAGMA application_id').get().application_id;
    if (!exists || applicationId === 0) {
      db.exec(SIDECAR_SCHEMA);
      db.exec(`PRAGMA application_id = ${SIDECAR_APPLICATION_ID}`);
    } else if (applicationId !== SIDECAR_APPLICATION_ID) {
      throw new MigrationError('SIDECAR_IDENTITY', `${sidecarPath} is not an agent-coord attestation sidecar.`);
    }
    return db;
  } catch (error) {
    try { db.close(); } catch { /* surface the original failure */ }
    throw error;
  }
}

function readEntries(db, namespace) {
  const sql = `SELECT namespace, entry_key AS key, value_hash AS valueHash, revision
    FROM memory_entries ${namespace ? 'WHERE namespace = ?' : ''} ORDER BY namespace, entry_key`;
  const statement = db.prepare(sql);
  return namespace ? statement.all(namespace) : statement.all();
}

// Composite lookup key for the (namespace, entry_key) pair. Defined once
// because four call sites index the same Map, and a separator that drifted
// between them would silently break attestation matching -- every row would
// look unattested and the migration would re-baseline the entire table.
// NUL is the separator precisely because it cannot occur in either component
// (both are length- and charset-checked TEXT columns), so no pair of distinct
// (namespace, key) values can collide the way they could with a space or a
// slash. It is written as an ESCAPE, never as a literal byte: a raw NUL in the
// source makes git and grep treat this file as binary, throwing away
// reviewability for no benefit. This file did carry the literal byte until a
// grep reported it as binary; that is how the defect was found.
function lookupKey(namespace, entryKey) {
  return `${namespace}\u0000${entryKey}`;
}

function readAttestations(db) {
  const rows = db.prepare('SELECT * FROM attestations').all();
  const byKey = new Map();
  for (const row of rows) byKey.set(lookupKey(row.namespace, row.entry_key), row);
  return byKey;
}

function attestationFromRow(row) {
  return {
    kind: row.kind,
    namespace: row.namespace,
    key: row.entry_key,
    revision: row.revision,
    valueHash: row.value_hash,
    author: JSON.parse(row.author_json),
    signedAtMs: row.signed_at_ms
  };
}

function observedIdentity() {
  let principal = 'unknown';
  try { principal = os.userInfo().username; } catch { /* keep the honest default */ }
  return { principal, pid: process.pid, machineId: os.hostname(), signerVersion: SIGNER_VERSION };
}

// SECRET HANDLING. The value is read into a Buffer and never returned,
// printed, stored, or included in an error message. Only its fingerprint --
// an HMAC output that cannot be reversed -- ever leaves this function.
function loadSecret(options) {
  if (options.secretEnv) {
    const raw = process.env[options.secretEnv];
    if (typeof raw !== 'string' || !raw) {
      throw new MigrationError('SECRET_UNAVAILABLE', `Environment variable ${options.secretEnv} is not set or is empty.`);
    }
    const buffer = /^[a-fA-F0-9]{32,}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'utf8');
    if (buffer.length < integrity.MIN_SECRET_BYTES) {
      throw new MigrationError('SECRET_TOO_SHORT', `The supplied secret is shorter than ${integrity.MIN_SECRET_BYTES} bytes.`);
    }
    return buffer;
  }
  if (options.vaultKey) {
    let value;
    try {
      // Required lazily: the runtime pulls in a large dependency graph and
      // shells out to PowerShell for a vault read. Modes that do not need a
      // secret must not pay that cost or touch the vault at all.
      value = require('../src/lib/runtime').getSecret(options.vaultKey, { prompt: false });
    } catch (error) {
      // Deliberately does not forward the underlying message: vault errors can
      // quote surrounding material.
      throw new MigrationError('SECRET_UNAVAILABLE', `Vault key '${options.vaultKey}' could not be read (${error && error.code ? error.code : 'unavailable'}).`);
    }
    const buffer = Buffer.from(String(value), 'utf8');
    if (buffer.length < integrity.MIN_SECRET_BYTES) {
      throw new MigrationError('SECRET_TOO_SHORT', `Vault key '${options.vaultKey}' is shorter than ${integrity.MIN_SECRET_BYTES} bytes.`);
    }
    return buffer;
  }
  throw new MigrationError('SECRET_REQUIRED', 'This mode needs a signing secret. Pass --secret-env <VAR> or --vault-key <key>.');
}

function fileDigest(target) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// MODES
// ---------------------------------------------------------------------------

function planFor(options) {
  const sourcePath = path.resolve(options.state);
  const sidecarPath = sidecarPathFor(sourcePath);
  const live = isLivePath(sourcePath);
  const db = openSource(sourcePath);
  let entries;
  try { entries = readEntries(db, options.namespace); } finally { db.close(); }

  let existing = new Map();
  const sidecarExists = fs.existsSync(sidecarPath);
  if (sidecarExists) {
    const sidecar = openSidecar(sidecarPath, { create: false });
    try { existing = readAttestations(sidecar); } finally { sidecar.close(); }
  }

  const wouldBaseline = entries.filter(entry => !existing.has(lookupKey(entry.namespace, entry.key)));
  const alreadyAttested = entries.length - wouldBaseline.length;
  return {
    sourcePath,
    sidecarPath,
    live,
    namespace: options.namespace || '(all namespaces)',
    sidecarExists,
    entriesInScope: entries.length,
    wouldWriteBaselineRows: wouldBaseline.length,
    alreadyAttested,
    sampleKeys: wouldBaseline.slice(0, 5).map(entry => `${entry.namespace}/${entry.key}`)
  };
}

function modeDryRun(options) {
  const before = fileDigest(path.resolve(options.state));
  const plan = planFor(options);
  const after = fileDigest(plan.sourcePath);

  let keyFingerprint = null;
  let secretStatus = 'not supplied (apply would refuse)';
  if (options.secretEnv || options.vaultKey) {
    try {
      const secret = loadSecret(options);
      keyFingerprint = integrity.keyFingerprint(secret);
      secret.fill(0);
      secretStatus = 'available';
    } catch (error) {
      secretStatus = `unavailable: ${error.code}`;
    }
  }

  const lines = [
    '=== agent-coord attestation migration: DRY RUN (no writes performed) ===',
    `source database      : ${plan.sourcePath}`,
    `source is LIVE db    : ${plan.live ? 'YES' : 'no'}`,
    `source opened        : READ-ONLY (this tool cannot write the source in any mode)`,
    `sidecar target       : ${plan.sidecarPath}`,
    `sidecar exists       : ${plan.sidecarExists ? 'yes' : 'no'}`,
    `namespace in scope   : ${plan.namespace}`,
    `signing key          : ${secretStatus}${keyFingerprint ? ` (fingerprint ${keyFingerprint})` : ''}`,
    '',
    'WOULD DO:',
    `  create sidecar database          : ${plan.sidecarExists ? 'no (already present)' : 'yes'}`,
    `  write baseline-snapshot rows     : ${plan.wouldWriteBaselineRows}`,
    `  leave already-attested rows       : ${plan.alreadyAttested}`,
    `  modify source database            : NO - 0 rows, 0 DDL, 0 bytes`,
    `  change state/toolsenabled schema  : NO - schema fingerprint untouched by design`,
    ''
  ];
  if (plan.sampleKeys.length) {
    lines.push('  first keys that would be baselined:');
    for (const key of plan.sampleKeys) lines.push(`    - ${key}`);
    if (plan.wouldWriteBaselineRows > plan.sampleKeys.length) {
      lines.push(`    ... and ${plan.wouldWriteBaselineRows - plan.sampleKeys.length} more`);
    }
  }
  lines.push('');
  lines.push('BASELINE ROWS DO NOT CLAIM AUTHORSHIP. Rows that already exist were');
  lines.push('written before anything signed them; minting an authored attestation over');
  lines.push('them would launder any forgery already present into a "verified" row. They');
  lines.push('are recorded as baseline-snapshot: "at migration time this row held this');
  lines.push('content" -- true, signed, and enough to make a LATER edit detectable.');
  lines.push('');
  lines.push(`source digest before : ${before || '(unreadable)'}`);
  lines.push(`source digest after  : ${after || '(unreadable)'}`);
  const unchanged = before && after && before === after;
  lines.push(`source unchanged     : ${unchanged ? 'yes' : 'DIGEST DIFFERS'}${plan.live && !unchanged ? ' (source is the live db under concurrent writers; this tool held it read-only)' : ''}`);
  if (plan.live) {
    lines.push('');
    lines.push('APPLY IS REFUSED AGAINST THE LIVE DATABASE. Deployment of this scheme is');
    lines.push('an owner decision, not an in-band one. Run apply against a copy.');
  }
  process.stdout.write(lines.join('\n') + '\n');
  return { ok: true, plan };
}

function modeApply(options) {
  const refuseLive = () => {
    throw new MigrationError('LIVE_APPLY_REFUSED',
      'Refusing to apply against the live state database. Deployment is owner-gated; run against a copy, or have the owner authorize the rollout out of band.');
  };
  // Planning opens the source and may open an existing sidecar. Refuse the
  // owner-gated path before either access, just as rollback already does.
  if (isLivePath(path.resolve(options.state))) refuseLive();
  const plan = planFor(options);
  // Retain the original check of identity observed by planning. These checks
  // do not claim to eliminate later filesystem swap races.
  if (plan.live) refuseLive();
  const secret = loadSecret(options);
  const fingerprint = integrity.keyFingerprint(secret);
  const observed = observedIdentity();
  const now = Date.now();

  const source = openSource(plan.sourcePath);
  let entries;
  try { entries = readEntries(source, options.namespace); } finally { source.close(); }

  const sidecar = openSidecar(plan.sidecarPath, { create: true });
  let written = 0;
  try {
    const header = sidecar.prepare('SELECT * FROM attest_header WHERE id = 1').get();
    if (!header) {
      sidecar.prepare(`INSERT INTO attest_header(id, scheme_version, key_fingerprint, source_path, namespace, created_at_ms)
        VALUES(1, ?, ?, ?, ?, ?)`).run(SCHEME_VERSION, fingerprint, plan.sourcePath, options.namespace || '*', now);
    } else if (header.key_fingerprint !== fingerprint) {
      // Refuse rather than re-sign: a changed key is either a rotation (which
      // needs an explicit, separate procedure) or a vault swap by a principal
      // with write-but-not-read access to vault/secrets.json. Silently
      // adopting the new key is exactly how that attack succeeds.
      throw new MigrationError('KEY_FINGERPRINT_MISMATCH',
        'The sidecar was created under a different signing key. Refusing to re-sign; investigate the key change before proceeding.');
    }
    const insert = sidecar.prepare(`INSERT OR IGNORE INTO attestations
      (namespace, entry_key, kind, revision, value_hash, author_json, signed_at_ms, key_fingerprint, mac)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const existing = readAttestations(sidecar);
    for (const entry of entries) {
      if (existing.has(lookupKey(entry.namespace, entry.key))) continue;
      const author = integrity.baselineAuthor(observed);
      const attestation = {
        kind: 'baseline-snapshot',
        namespace: entry.namespace,
        key: entry.key,
        revision: entry.revision,
        valueHash: entry.valueHash,
        author,
        signedAtMs: now
      };
      const mac = integrity.signAttestation(secret, attestation);
      insert.run(entry.namespace, entry.key, 'baseline-snapshot', entry.revision, entry.valueHash,
        JSON.stringify(author), now, fingerprint, mac);
      written += 1;
    }
  } finally {
    sidecar.close();
    secret.fill(0);
  }
  process.stdout.write([
    '=== agent-coord attestation migration: APPLIED ===',
    `source (read-only)   : ${plan.sourcePath}`,
    `sidecar written      : ${plan.sidecarPath}`,
    `baseline rows written: ${written}`,
    `key fingerprint      : ${fingerprint}`,
    'source database modified: NO',
    ''
  ].join('\n'));
  return { ok: true, written, fingerprint };
}

// Sign an authored attestation for a row that a caller is writing NOW. This is
// the function a wired-in write path would call. `declared` is caller-supplied
// and is not verified -- see the authorship comment in agent-coord-integrity.js
// for exactly how much that is worth. `observed` is measured here and
// overwrites anything the caller tried to supply.
function attestWrite({ sidecarPath, secret, namespace, key, revision, valueHash, declared, now = Date.now() }) {
  const author = integrity.canonicalAuthor({ declared, observed: observedIdentity() });
  const attestation = { kind: 'authored', namespace, key, revision, valueHash, author, signedAtMs: now };
  const mac = integrity.signAttestation(secret, attestation);
  const fingerprint = integrity.keyFingerprint(secret);
  const sidecar = openSidecar(sidecarPath, { create: true });
  try {
    const header = sidecar.prepare('SELECT * FROM attest_header WHERE id = 1').get();
    if (!header) {
      sidecar.prepare(`INSERT INTO attest_header(id, scheme_version, key_fingerprint, source_path, namespace, created_at_ms)
        VALUES(1, ?, ?, ?, ?, ?)`).run(SCHEME_VERSION, fingerprint, '(runtime)', namespace, now);
    }
    sidecar.prepare(`INSERT INTO attestations
      (namespace, entry_key, kind, revision, value_hash, author_json, signed_at_ms, key_fingerprint, mac)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, entry_key) DO UPDATE SET
        kind = excluded.kind, revision = excluded.revision, value_hash = excluded.value_hash,
        author_json = excluded.author_json, signed_at_ms = excluded.signed_at_ms,
        key_fingerprint = excluded.key_fingerprint, mac = excluded.mac`)
      .run(namespace, key, 'authored', revision, valueHash, JSON.stringify(author), now, fingerprint, mac);
  } finally {
    sidecar.close();
  }
  return { attestation, mac, fingerprint };
}

function modeVerify(options) {
  const sourcePath = path.resolve(options.state);
  const sidecarPath = sidecarPathFor(sourcePath);
  const secret = loadSecret(options);
  const fingerprint = integrity.keyFingerprint(secret);

  const source = openSource(sourcePath);
  let entries;
  try { entries = readEntries(source, options.namespace); } finally { source.close(); }

  const sidecar = openSidecar(sidecarPath, { create: false });
  let attestations;
  try { attestations = readAttestations(sidecar); } finally { sidecar.close(); }

  const counts = new Map();
  const flagged = [];
  for (const entry of entries) {
    const stored = attestations.get(lookupKey(entry.namespace, entry.key));
    const verdict = integrity.classifyEntry(secret, {
      row: { namespace: entry.namespace, key: entry.key, revision: entry.revision, valueHash: entry.valueHash },
      attestation: stored ? attestationFromRow(stored) : null,
      mac: stored ? stored.mac : null,
      expectedKeyFingerprint: fingerprint,
      attestedKeyFingerprint: stored ? stored.key_fingerprint : undefined,
      expectSigned: Boolean(options.expectSigned)
    });
    counts.set(verdict, (counts.get(verdict) || 0) + 1);
    // Report identity only. Entry values are other agents' coordination
    // content and have no business in a verification report.
    if (verdict !== 'verified' && verdict !== 'unattested') flagged.push(`${verdict}  ${entry.namespace}/${entry.key}`);
  }
  secret.fill(0);

  const lines = ['=== agent-coord attestation verification ===',
    `source database  : ${sourcePath}`,
    `sidecar          : ${sidecarPath}`,
    `key fingerprint  : ${fingerprint}`,
    `expect-signed    : ${options.expectSigned ? 'yes (unsigned change = tamper)' : 'no (write path does not sign yet)'}`,
    ''];
  for (const [verdict, count] of [...counts.entries()].sort()) lines.push(`  ${verdict.padEnd(26)} ${count}`);
  if (flagged.length) {
    lines.push('', 'FLAGGED:');
    for (const item of flagged.slice(0, 50)) lines.push(`  ${item}`);
    if (flagged.length > 50) lines.push(`  ... and ${flagged.length - 50} more`);
  }
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
  const bad = (counts.get('tamper-suspected') || 0) + (counts.get('revision-regressed') || 0) + (counts.get('key-mismatch') || 0);
  return { ok: bad === 0, counts: Object.fromEntries(counts), flagged };
}

function modeRollback(options) {
  const sourcePath = path.resolve(options.state);
  if (isLivePath(sourcePath)) {
    throw new MigrationError('LIVE_ROLLBACK_REFUSED',
      'Refusing to operate on the live state database directory. Deployment and rollback are owner-gated.');
  }
  const sidecarPath = sidecarPathFor(sourcePath);
  const removed = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${sidecarPath}${suffix}`;
    if (fs.existsSync(target)) { fs.rmSync(target, { force: true }); removed.push(target); }
  }
  process.stdout.write([
    '=== agent-coord attestation migration: ROLLED BACK ===',
    `removed files       : ${removed.length ? removed.join(', ') : '(nothing to remove)'}`,
    `source database     : ${sourcePath}`,
    'source database modified by rollback: NO',
    'Rollback is complete by construction: the migration only ever created the',
    'sidecar, so deleting it restores the exact pre-migration state.',
    ''
  ].join('\n'));
  return { ok: true, removed };
}

function modeStatus(options) {
  const plan = planFor(options);
  process.stdout.write([
    '=== agent-coord attestation status ===',
    `source database   : ${plan.sourcePath}`,
    `source is LIVE db : ${plan.live ? 'YES' : 'no'}`,
    `sidecar           : ${plan.sidecarPath} (${plan.sidecarExists ? 'present' : 'absent'})`,
    `entries in scope  : ${plan.entriesInScope}`,
    `attested          : ${plan.alreadyAttested}`,
    `unattested        : ${plan.wouldWriteBaselineRows}`,
    ''
  ].join('\n'));
  return { ok: true, plan };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const MODES = { 'dry-run': modeDryRun, apply: modeApply, verify: modeVerify, rollback: modeRollback, status: modeStatus };

function parseArgs(argv) {
  // Default mode is dry-run: an invocation with a typo, or one where the mode
  // was forgotten, must not mutate anything.
  const options = { mode: 'dry-run', state: LIVE_STATE_PATH, namespace: DEFAULT_NAMESPACE, expectSigned: false };
  const rest = [...argv];
  if (rest.length && !rest[0].startsWith('--')) {
    options.mode = rest.shift();
    if (!Object.hasOwn(MODES, options.mode)) {
      throw new MigrationError('UNKNOWN_MODE', `Unknown mode '${options.mode}'. Expected one of: ${Object.keys(MODES).join(', ')}.`);
    }
  }
  while (rest.length) {
    const flag = rest.shift();
    switch (flag) {
      case '--state': options.state = rest.shift(); break;
      case '--namespace': options.namespace = rest.shift(); break;
      case '--all-namespaces': options.namespace = null; break;
      case '--secret-env': options.secretEnv = rest.shift(); break;
      case '--vault-key': options.vaultKey = rest.shift(); break;
      case '--expect-signed': options.expectSigned = true; break;
      case '--help': options.help = true; break;
      default: throw new MigrationError('UNKNOWN_FLAG', `Unknown flag '${flag}'.`);
    }
  }
  if (!options.state) throw new MigrationError('STATE_REQUIRED', '--state requires a path.');
  return options;
}

const USAGE = `agent-coord attestation migration

  node tools/agent-coord-attest-migrate.js [mode] [flags]

Modes (default: dry-run):
  dry-run    Report exactly what apply would do. Writes nothing. Safe on live.
  status     Short attested/unattested summary. Writes nothing. Safe on live.
  apply      Create the sidecar and write baseline snapshots. REFUSED on live.
  verify     Classify every entry against its attestation. Writes nothing.
  rollback   Delete the sidecar. REFUSED on live. Source is never touched.

Flags:
  --state <path>        Source state database. Defaults to the LIVE database
                        (safe: the default mode is read-only dry-run).
  --namespace <name>    Namespace to scope to. Default: agent-coord.
  --all-namespaces      Cover every namespace.
  --secret-env <VAR>    Read the signing secret from an environment variable.
  --vault-key <key>     Read the signing secret from the local DPAPI vault.
  --expect-signed       Treat an unsigned change as tamper. Only correct once
                        the write path actually signs; see classifyEntry().

The source database is opened READ-ONLY in every mode. This tool cannot write
state/toolsenabled.sqlite3, and it never adds DDL to it -- the attestation
ledger is a separate sidecar file, because out-of-band DDL on the state store
fails its schema fingerprint check and locks out every reader.
`;

function main(argv) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { process.stderr.write(`${error.message}\n\n${USAGE}`); return 2; }
  if (options.help) { process.stdout.write(USAGE); return 0; }
  try {
    const result = MODES[options.mode](options);
    return result && result.ok === false ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.code || 'ERROR'}: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  LIVE_STATE_PATH,
  MigrationError,
  SCHEME_VERSION,
  attestWrite,
  isLivePath,
  main,
  modeApply,
  modeDryRun,
  modeRollback,
  modeStatus,
  modeVerify,
  observedIdentity,
  // Exported so the proof suite can assert the read-only guarantee directly on
  // the handle. Without that test, deleting `readOnly: true` silently removes
  // the only structural reason this tool cannot damage the live state store --
  // a mutation run confirmed no other assertion covers it.
  openSource,
  parseArgs,
  planFor,
  sidecarPathFor
};
