'use strict';

// A keyed integrity check for state-store memory_entries (the agent-coord
// backing store), proposed but NOT yet wired into src/lib/state-store.js's
// read/write/migration paths -- see docs/design/SHIPMENT-PLAN.md for the
// deferred wiring decision and why.
//
// WHY THIS EXISTS: memory_entries.value_hash (state-store.js hashText/
// hashInput) is a plain, unkeyed sha256 of the stored content. Anyone with
// raw write access to state/toolsenabled.sqlite3 -- which today includes
// BUILTIN\Users and <MACHINE>\CodexSandboxUsers via an inherited NTFS grant,
// not just the mediated memory.set API -- can rewrite a row's value_json and
// simply recompute value_hash to match. That passes every existing check;
// there is nothing an honest reader could see that would look wrong. A
// content hash proves the row is internally self-consistent; it says
// nothing about who produced it.
//
// This module replaces "self-consistent" with "produced by someone holding
// a specific secret" using the exact HMAC-SHA256 + timing-safe-compare
// pattern already used to authenticate cross-machine agent-comms relay
// messages (src/lib/providers/agent-comms.js: macFor/sealMessage/
// openMessage/timingSafeHex). The intended secret is a NEW, dedicated vault
// entry decryptable only by a process with DPAPI CurrentUser rights as the
// owner (the same protection already verified for custom.link_bus_bridge_token
// et al.) -- i.e. something the owner-host / full MCP server process can
// hold but a sandboxed CodexSandboxUsers principal cannot, even though that
// principal can still write the underlying file at the OS level. A forged
// row can still be written; it can no longer be written *undetected*.
//
// Deliberately NOT done here: no vault secret was minted, no state-store.js
// migration was added, no read path was changed. Wiring this in touches a
// database that many concurrently active agents read and write right now,
// with no separate deploy/staging step in this codebase (a process that
// requires a changed state-store.js immediately runs its migration against
// the live file). That is a live-infrastructure decision, not a "small and
// safe" one, and it is being reported/scoped rather than executed solo.

const crypto = require('node:crypto');

const CONTEXT = 'ToolsEnabled/agent-coord/memory-integrity/v1\0';
// Domain separation: an attestation MAC (v2, covers authorship) and a bare
// record MAC (v1, content only) are computed over different context strings,
// so a v1 signature can never be presented as a v2 attestation or vice versa.
const ATTESTATION_CONTEXT = 'ToolsEnabled/agent-coord/authored-attestation/v2\0';
const KEY_FINGERPRINT_CONTEXT = 'ToolsEnabled/agent-coord/key-fingerprint/v1\0';
const MIN_SECRET_BYTES = 16;
const MAC_RE = /^[a-f0-9]{64}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const DECLARED_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const ATTESTATION_KINDS = Object.freeze(['authored', 'baseline-snapshot']);

class AgentCoordIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentCoordIntegrityError';
  }
}

function assertSecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.length < MIN_SECRET_BYTES) {
    throw new AgentCoordIntegrityError(`Integrity secret must be a Buffer of at least ${MIN_SECRET_BYTES} bytes.`);
  }
}

// The signed payload is exactly the columns a raw UPDATE/INSERT could
// change: namespace + entry_key identify WHICH row, valueJson/note/tagsJson
// are the content, revision binds it to one point in that row's history so
// a captured old (genuine) signature cannot be replayed over a newer edit.
function canonicalRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new AgentCoordIntegrityError('record must be a plain object.');
  }
  const { namespace, key, valueJson, note, tagsJson, revision } = record;
  if (typeof namespace !== 'string' || !namespace) throw new AgentCoordIntegrityError('record.namespace is required.');
  if (typeof key !== 'string' || !key) throw new AgentCoordIntegrityError('record.key is required.');
  if (typeof valueJson !== 'string') throw new AgentCoordIntegrityError('record.valueJson must be a JSON string.');
  if (note !== null && typeof note !== 'string') throw new AgentCoordIntegrityError('record.note must be a string or null.');
  if (typeof tagsJson !== 'string') throw new AgentCoordIntegrityError('record.tagsJson must be a JSON string.');
  if (!Number.isSafeInteger(revision) || revision < 1) throw new AgentCoordIntegrityError('record.revision must be a positive integer.');
  return JSON.stringify({ namespace, key, valueJson, note, tagsJson, revision });
}

function sign(secret, record) {
  assertSecret(secret);
  return crypto.createHmac('sha256', secret).update(CONTEXT, 'utf8').update(canonicalRecord(record), 'utf8').digest('hex');
}

function verify(secret, record, mac) {
  assertSecret(secret);
  if (typeof mac !== 'string' || !MAC_RE.test(mac)) return false;
  // Do not collapse an uncanonicalizable record (or a crypto failure while
  // computing its MAC) into the definite claim that its signature mismatched.
  // Callers must be able to distinguish "not measured" from "measured false".
  const expected = sign(secret, record);
  const left = Buffer.from(mac, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Deployment must be additive: every row written before this scheme existed
// has no MAC at all, and a migration must not make those rows unreadable or
// flag them as tampered -- they simply predate the guarantee. classify()
// gives a caller a third state instead of a boolean, matching how it would
// actually need to behave wired into state-store.js's read path:
//   'legacy-unsigned' -- no mac column value; genuinely predates this scheme,
//                        not a verification failure. Read normally, note the
//                        limitation, do not alarm on it.
//   'verified'        -- mac present and matches; ordinary signed path.
//   'tamper-suspected' -- mac present but does not match; THIS is the loud
//                        signal a raw-write forgery should produce.
// A rollout can therefore backfill signatures lazily (sign on next write)
// rather than needing a blocking migration that touches every existing row
// up front, and rollback is symmetric: older code that has never heard of
// `mac` simply never reads the new column, so reverting the code change
// requires no data migration either way.
function classify(secret, record, mac) {
  if (mac === null || mac === undefined) return 'legacy-unsigned';
  return verify(secret, record, mac) ? 'verified' : 'tamper-suspected';
}

// ---------------------------------------------------------------------------
// AUTHORSHIP (v2 attestations)
// ---------------------------------------------------------------------------
//
// READ THIS BEFORE TRUSTING AN AUTHOR FIELD. The `author` on an agent-coord
// entry is an AUDITABLE, VISIBLE SIGNAL. It is not proof of identity, and the
// difference is the whole reason this comment is long.
//
// An author record has two halves that carry very different weight:
//
//   author.declared  -- a label the WRITER CHOSE for itself ("comms-integrity-
//                       build", "coordinator-sol"). Any caller that can reach
//                       the signing path can put ANY string here, including
//                       another agent's name. It is exactly as trustworthy as
//                       a From: header on email. It makes honest writes
//                       attributable and casual/accidental impersonation
//                       visible in an audit trail. It STOPS NOTHING on its
//                       own. Never make an authorization decision on it.
//
//   author.observed  -- facts the SIGNER measured about the calling process at
//                       signing time (OS principal, pid, machine, signer
//                       version). A caller going through the mediated API
//                       cannot choose these; the signer overwrites whatever it
//                       was handed. This is what separates "written through
//                       the mediated memory.set path" from "written by raw
//                       file access", which is the distinction that actually
//                       matters against the raw-DB-write forgery this module
//                       exists to catch.
//
// WHAT THE MAC ADDS: both halves are inside the signed payload, together with
// the row identity (namespace/key/revision) and the row's content hash. So a
// party who can write the database file but does NOT hold the secret cannot
// add an author, remove an author, change `declared` from one agent to
// another, or move a genuine attestation onto different content -- every one
// of those edits breaks verification and surfaces as 'tamper-suspected'.
//
// WHAT IT STILL DOES NOT DO: anyone who can obtain the secret can mint a
// perfectly valid attestation naming any `declared` author they like. On this
// machine the signing key is reachable by any process running as the owner
// account, and agent sessions run as the owner account. So this scheme defends
// against a principal that CANNOT read the key (a sandboxed process, a remote
// writer with only file access) and does NOT defend against a compromised
// owner-context process. Do not describe it as agent-to-agent authentication;
// it is tamper-evidence with attributable authorship.
function canonicalAuthor(author) {
  if (!author || typeof author !== 'object' || Array.isArray(author)) {
    throw new AgentCoordIntegrityError('author must be a plain object.');
  }
  const { declared, observed } = author;
  if (typeof declared !== 'string' || !DECLARED_RE.test(declared)) {
    throw new AgentCoordIntegrityError('author.declared must be a short label matching ' + String(DECLARED_RE) + '.');
  }
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) {
    throw new AgentCoordIntegrityError('author.observed must be a plain object.');
  }
  const { principal, pid, machineId, signerVersion } = observed;
  if (typeof principal !== 'string' || !principal || principal.length > 200) {
    throw new AgentCoordIntegrityError('author.observed.principal must be a non-empty string up to 200 chars.');
  }
  if (!Number.isSafeInteger(pid) || pid < 0) throw new AgentCoordIntegrityError('author.observed.pid must be a non-negative integer.');
  if (typeof machineId !== 'string' || !machineId || machineId.length > 100) {
    throw new AgentCoordIntegrityError('author.observed.machineId must be a non-empty string up to 100 chars.');
  }
  if (!Number.isSafeInteger(signerVersion) || signerVersion < 1) {
    throw new AgentCoordIntegrityError('author.observed.signerVersion must be a positive integer.');
  }
  // Fixed key order -- the canonical form must be byte-stable across callers,
  // so it is rebuilt here rather than re-serializing the caller's object.
  return { declared, observed: { principal, pid, machineId, signerVersion } };
}

// An attestation binds WHO (author) to WHICH ROW (namespace/key/revision) to
// WHAT CONTENT (valueHash) at WHEN (signedAtMs). `kind` distinguishes a real
// authorship claim from a migration baseline -- see BASELINE below.
function canonicalAttestation(attestation) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new AgentCoordIntegrityError('attestation must be a plain object.');
  }
  const { kind, namespace, key, revision, valueHash, author, signedAtMs } = attestation;
  if (!ATTESTATION_KINDS.includes(kind)) {
    throw new AgentCoordIntegrityError(`attestation.kind must be one of ${ATTESTATION_KINDS.join(', ')}.`);
  }
  if (typeof namespace !== 'string' || !namespace) throw new AgentCoordIntegrityError('attestation.namespace is required.');
  if (typeof key !== 'string' || !key) throw new AgentCoordIntegrityError('attestation.key is required.');
  if (!Number.isSafeInteger(revision) || revision < 1) throw new AgentCoordIntegrityError('attestation.revision must be a positive integer.');
  if (typeof valueHash !== 'string' || !HASH_RE.test(valueHash)) {
    throw new AgentCoordIntegrityError('attestation.valueHash must be a 64-char lowercase hex sha256.');
  }
  if (!Number.isSafeInteger(signedAtMs) || signedAtMs < 0) throw new AgentCoordIntegrityError('attestation.signedAtMs must be a non-negative integer.');
  return JSON.stringify({
    kind, namespace, key, revision, valueHash, author: canonicalAuthor(author), signedAtMs
  });
}

function signAttestation(secret, attestation) {
  assertSecret(secret);
  return crypto.createHmac('sha256', secret)
    .update(ATTESTATION_CONTEXT, 'utf8')
    .update(canonicalAttestation(attestation), 'utf8')
    .digest('hex');
}

function verifyAttestation(secret, attestation, mac) {
  assertSecret(secret);
  if (typeof mac !== 'string' || !MAC_RE.test(mac)) return false;
  // Invalid attestation input and failures while deriving the expected MAC
  // are verification failures to perform, not evidence of a MAC mismatch.
  const expected = signAttestation(secret, attestation);
  const left = Buffer.from(mac, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// BASELINE: rows that already existed when attestation was switched on cannot
// be given an authorship claim -- nobody witnessed who wrote them, and minting
// an 'authored' attestation over them would launder any forgery ALREADY
// sitting in the table into a "verified" row. That would be worse than doing
// nothing. A 'baseline-snapshot' instead records only "at migration time this
// row held this content", which is true, is signed, and makes any LATER edit
// to a pre-existing row detectable -- without ever claiming to know its author.
function baselineAuthor(observed) {
  return canonicalAuthor({ declared: 'baseline-snapshot', observed });
}

// A stable, non-reversible identifier for a secret. Safe to write into a
// ledger header, a report, or a log: it is an HMAC output, so it reveals
// nothing about the key, but two different keys give two different values.
// This exists because the vault file is writable by principals that cannot
// READ it (<MACHINE>\CodexSandboxUsers holds Modify on vault/secrets.json):
// such a principal cannot forge a signature, but it CAN replace the vault wholesale
// with a key it controls. Without a pinned fingerprint the signer would
// happily adopt the attacker's key and re-sign everything. With one, the swap
// is visible as 'key-mismatch' instead of silently succeeding.
function keyFingerprint(secret) {
  assertSecret(secret);
  return crypto.createHmac('sha256', secret).update(KEY_FINGERPRINT_CONTEXT, 'utf8').digest('hex').slice(0, 16);
}

// Compare a LIVE ROW against its stored attestation. This is the function a
// reader actually calls, and its states are deliberately finer-grained than a
// boolean because the responses differ.
//
//   'unattested'   -- no attestation exists for this row. Pre-dates the
//                     scheme, or was written by a path that does not sign.
//                     Benign today; see EXPECT-SIGNED below.
//   'key-mismatch' -- the attestation was produced under a different key than
//                     the verifier holds. Could be a legitimate rotation, or a
//                     vault swap by a principal with write-but-not-read access
//                     to vault/secrets.json. Never silently treated as valid.
//   'tamper-suspected' -- either the attestation record itself fails its MAC,
//                     or the row still sits at the attested revision but its
//                     content hash has changed underneath it. The second case
//                     is precisely the raw-UPDATE-and-recompute-value_hash
//                     forgery this whole module exists to catch.
//   'revision-regressed' -- the row's revision moved BACKWARD. Old-but-genuine
//                     content restored over newer content: a rollback/replay.
//   'changed-since-attestation' -- the row advanced past the attested revision
//                     and the new revision carries no attestation of its own.
//                     READ THE NEXT PARAGRAPH; this state is the honest seam
//                     in the current deployment.
//   'verified'     -- attested revision, matching content, current key.
//
// EXPECT-SIGNED. What 'changed-since-attestation' MEANS depends entirely on
// whether the write path signs. Today it does not: this module is not wired
// into state-store.js, so every ordinary memory.set advances a row without
// producing an attestation, and a forged raw write that also bumps revision
// lands in exactly the same bucket. In that world the state means "unknown,
// probably normal". Once every legitimate write is signed, the same state
// means "something wrote this row outside the signing path" -- i.e. an alarm.
// Callers declare which world they are in with options.expectSigned; the
// function does not guess, and nothing here silently upgrades an unknown into
// a verdict. Full forgery detection for NEW writes requires that wiring; this
// classifier is honest about not having it yet.
function classifyEntry(secret, input = {}) {
  const { row, attestation, mac, expectedKeyFingerprint, attestedKeyFingerprint, expectSigned = false } = input;
  if (!row || typeof row !== 'object') throw new AgentCoordIntegrityError('row is required.');
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) throw new AgentCoordIntegrityError('row.revision must be a positive integer.');
  if (typeof row.valueHash !== 'string' || !HASH_RE.test(row.valueHash)) {
    throw new AgentCoordIntegrityError('row.valueHash must be a 64-char lowercase hex sha256.');
  }
  if (attestation === null || attestation === undefined || mac === null || mac === undefined) {
    return expectSigned ? 'tamper-suspected' : 'unattested';
  }
  if (typeof expectedKeyFingerprint === 'string' && typeof attestedKeyFingerprint === 'string'
      && expectedKeyFingerprint !== attestedKeyFingerprint) {
    return 'key-mismatch';
  }
  // The attestation's own fields are attacker-controlled until the MAC checks
  // out, so nothing below this line may branch on them beforehand.
  if (!verifyAttestation(secret, attestation, mac)) return 'tamper-suspected';
  if (attestation.namespace !== row.namespace || attestation.key !== row.key) return 'tamper-suspected';
  if (row.revision < attestation.revision) return 'revision-regressed';
  if (row.revision > attestation.revision) return expectSigned ? 'tamper-suspected' : 'changed-since-attestation';
  return row.valueHash === attestation.valueHash ? 'verified' : 'tamper-suspected';
}

module.exports = Object.freeze({
  AgentCoordIntegrityError,
  ATTESTATION_CONTEXT,
  ATTESTATION_KINDS,
  CONTEXT,
  KEY_FINGERPRINT_CONTEXT,
  MIN_SECRET_BYTES,
  baselineAuthor,
  canonicalAttestation,
  canonicalAuthor,
  canonicalRecord,
  classify,
  classifyEntry,
  keyFingerprint,
  sign,
  signAttestation,
  verify,
  verifyAttestation
});
