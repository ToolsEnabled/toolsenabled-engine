'use strict';

// READ-SIDE VERIFICATION FOR THE agent-coord ATTESTATION SIDECAR.
//
// agent-coord-integrity.js can sign and classify a memory row, and
// tools/agent-coord-attest-migrate.js can write the sidecar that holds the
// signatures. Nothing read them. The module that exists to detect a forged
// memory row was referenced by one standalone migration tool and by no product
// path at all, so in the running product nothing ever checked a MAC.
//
// WHAT THIS DEFENDS. memory_entries.value_hash is a plain unkeyed sha256 of the
// stored content (state-store.js hashText/hashInput), so anyone who can write
// state/toolsenabled.sqlite3 -- which includes BUILTIN\Users and
// <MACHINE>\CodexSandboxUsers through an inherited NTFS grant that Full Remote
// Access requires -- can rewrite value_json and recompute value_hash to match.
// MEASURED on a fixture store: a row written through memory.set, rewritten
// directly in SQLite with a recomputed hash, is returned by getMemory as
// authentic on a freshly opened store. The content hash proves the row is
// internally self-consistent and says nothing about who produced it. Agent
// long-term memory is an instruction channel, so a forgeable one is a
// persistence primitive for prompt injection.
//
// WHY A SIDECAR AND NOT A COLUMN. state-store.js _validateSchema() runs on every
// connection, compares each table's exact column list, and hashes the whole
// sqlite_schema DDL into a fingerprint. Adding a column -- or any table or index
// -- to the state database changes that fingerprint and throws
// STATE_SCHEMA_INVALID, so the connection does not open, for every agent, the
// MCP server, the dashboard, the scheduler, at once. The attestation therefore
// lives in its own file beside the store; see the header of
// tools/agent-coord-attest-migrate.js, which chose this and explains it at
// length. Nothing here writes either database.
//
// THE STRICTNESS DECISION IS THE POINT, and it is why this reads the sidecar
// header rather than only the rows. If the sidecar exists and its header claims
// a namespace, every row in that namespace is expected to carry an attestation,
// so REMOVING one is tamper-suspected rather than a quiet downgrade to
// 'unattested'. Without that, an attacker who cannot forge a MAC would simply
// delete it. Namespaces the sidecar does not claim, and machines with no sidecar
// at all, are unattested and are not refused: a verifier that bricks an install
// which has not been migrated yet is not deployable, and the migration is
// owner-gated by design.

const path = require('node:path');
const integrity = require('./agent-coord-integrity');

const SIDECAR_LEAF = 'agent-coord-attest.sqlite3';

function sidecarPathFor(statePath) {
  return path.join(path.dirname(path.resolve(statePath)), SIDECAR_LEAF);
}

/* Opens the sidecar read-only and reads it once.
 *
 * Returns a STATE, never null, because the three ways this can fail are three
 * different facts and collapsing them loses the only one that matters:
 *   'loaded'     -- header and rows read;
 *   'absent'     -- no sidecar file at all, i.e. an install never migrated;
 *   'unreadable' -- a file IS there but its header or rows could not be read.
 *
 * An earlier version returned null for all three, and classifyMemoryRow turned
 * null into 'unattested' for every row. The row-level strictness below stopped
 * an attacker DELETING ONE attestation, and did nothing about deleting the whole
 * file -- the same defect one level up, and anyone who can write the state
 * folder has exactly that power. Found in review.
 */
function loadAttestations(sidecarPath, { sqlite = require('node:sqlite') } = {}) {
  const fs = require('node:fs');
  let exists = false;
  try { exists = fs.existsSync(sidecarPath); } catch { exists = false; }
  if (!exists) return Object.freeze({ state: 'absent' });
  let database = null;
  try {
    database = new sqlite.DatabaseSync(sidecarPath, { readOnly: true });
    const header = database.prepare('SELECT * FROM attest_header WHERE id = 1').get();
    if (!header || typeof header.namespace !== 'string' || typeof header.key_fingerprint !== 'string') {
      // A sidecar whose header is gone or malformed is NOT an un-migrated
      // install. Deleting just the header would otherwise be the cheapest way
      // to disarm every row at once.
      return Object.freeze({ state: 'unreadable' });
    }
    const rows = database.prepare('SELECT * FROM attestations').all();
    const byKey = new Map();
    for (const row of rows) byKey.set(`${row.namespace}\u0000${row.entry_key}`, row);
    return Object.freeze({
      state: 'loaded',
      namespace: header.namespace,
      keyFingerprint: header.key_fingerprint,
      schemeVersion: header.scheme_version,
      attestations: byKey
    });
  } catch {
    return Object.freeze({ state: 'unreadable' });
  } finally {
    if (database) { try { database.close(); } catch { /* closing a read-only handle */ } }
  }
}

/* The verdict for one memory row. `secret` is the MAC key, which only a process
 * with owner DPAPI/keyring rights can decrypt; a sandboxed principal gets null
 * and therefore 'unattested', which is the honest answer for a reader that
 * cannot check rather than a claim that the row is good. */
function classifyMemoryRow(loaded, secret, row) {
  /* NO KEY MEANS THIS READER CANNOT CHECK, which is an honest 'unattested'
     rather than a claim about the row. A sandboxed principal cannot decrypt the
     MAC secret, and it is expected to read memory. */
  if (!secret) return 'unattested';
  if (!row || typeof row.namespace !== 'string' || typeof row.key !== 'string') return 'unattested';

  /* HOLDING THE KEY IS WHAT MAKES A MISSING SIDECAR A FINDING.
     The secret is a vault entry only an owner-rights process can decrypt, so a
     reader that has it is a reader this install intends to verify with. From
     there, "the evidence is not here" is not the same statement as "this row was
     never attested", and only the second one is safe to shrug at. Reported
     separately so an operator can tell a corrupt sidecar from an un-migrated
     install -- and note the deliberate consequence: between minting the key and
     running the backfill, rows read as attestation-missing. That window is
     owner-operated, and fail-closed is the right side to be on. */
  const state = loaded && typeof loaded === 'object' ? loaded.state : 'absent';
  if (state === 'absent') return 'attestation-missing';
  if (state !== 'loaded') return 'attestation-unreadable';

  const stored = loaded.attestations.get(`${row.namespace}\u0000${row.key}`);
  // Only namespaces this sidecar claims are held to the stricter rule. A row
  // outside them was never migrated, so its missing attestation is expected.
  const expectSigned = loaded.namespace === row.namespace;
  try {
    return integrity.classifyEntry(secret, {
      row: { namespace: row.namespace, key: row.key, revision: row.revision, valueHash: row.valueHash },
      attestation: stored ? {
        namespace: stored.namespace,
        key: stored.entry_key,
        kind: stored.kind,
        revision: stored.revision,
        valueHash: stored.value_hash,
        author: JSON.parse(stored.author_json),
        signedAtMs: stored.signed_at_ms
      } : null,
      mac: stored ? stored.mac : null,
      /* The fingerprint of the key THIS READER holds, not the one recorded in
         the sidecar header. Comparing the header against itself is vacuous: it
         always matches, and a sidecar signed under a different key then falls
         through to the MAC check and reports 'tamper-suspected' -- a frightening
         verdict for what is actually a key rotation or a copied sidecar.
         tools/agent-coord-attest-migrate.js modeVerify passes the reader's own
         fingerprint for exactly this reason. */
      expectedKeyFingerprint: integrity.keyFingerprint(secret),
      attestedKeyFingerprint: stored ? stored.key_fingerprint : undefined,
      expectSigned
    });
  } catch {
    // An unclassifiable row is not a verified one. Never collapse "could not
    // measure" into "measured good" -- that is the defect this whole path exists
    // to remove.
    return 'unverifiable';
  }
}

/* Verdicts that mean the stored row disagrees with what was signed. These are
 * the ones a caller must refuse rather than annotate: every one of them requires
 * someone to have written the database outside the mediated API. */
const TAMPER_VERDICTS = Object.freeze(new Set(['tamper-suspected', 'revision-regressed', 'key-mismatch',
  'attestation-missing', 'attestation-unreadable', 'unverifiable']));

function isTamper(verdict) { return TAMPER_VERDICTS.has(verdict); }

module.exports = Object.freeze({
  SIDECAR_LEAF,
  TAMPER_VERDICTS,
  classifyMemoryRow,
  isTamper,
  loadAttestations,
  sidecarPathFor
});
