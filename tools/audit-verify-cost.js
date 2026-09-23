#!/usr/bin/env node
'use strict';

// Measure what a cold audit-chain verification costs, and how that cost grows.
//
// Why this exists: `audit.verify()` walks EVERY row of the canonical chain and
// checks every Ed25519 signature. `prepare()` -> `reconcileAnchor()` ->
// `store.verifyWithEvents()` puts that walk on the audit WRITE path, and the
// verification cache is per-process and in-memory -- so the full walk is paid
// again in every fresh process, and again whenever the cache cannot be advanced
// (`appendEvent()` invalidates it on every append; the "verification inputs
// changed" retry forces `uncached: true`). The product sells running many
// agents, so the ledger grows with success and this cost grows with it.
//
// Two lanes escalated the growth and neither owned it, in part because the
// number was inherited rather than read off a run. This tool makes it cheap to
// read off a run, on synthetic ledgers, at whatever scale you want to argue
// about.
//
//   node tools/audit-verify-cost.js                      # 1k, 5k, 10k
//   node tools/audit-verify-cost.js --scales 10000,50000 # pick your scales
//   node tools/audit-verify-cost.js --window 1000        # bounded-cost model
//   node tools/audit-verify-cost.js --json
//
// SAFETY. This never opens the canonical ledger, the projections, or the vault.
// It builds throwaway ledgers under the OS temp directory with a throwaway
// signing key and deletes them afterwards. Pointing it at the real ledger is
// refused, not honoured -- see assertNotCanonical(). It is a measurement tool:
// it changes no verification behaviour and grants no authority.
//
// The `--window` figure is a MODEL, not a shipped feature. It answers "what
// would a cold verification cost if it only had to re-check the last N entries
// instead of all of them", by verifying the chain suffix rooted at an earlier
// row's hash. Nothing in the product does that today. Making it real needs a
// durable, monotonic, tamper-evident record that the earlier prefix once
// verified -- which is a security-relevant mechanism adjacent to the
// deliberately-unbuilt re-anchor capability, and must not be bolted on from a
// benchmark. See docs/design/AUDIT-REANCHOR-PROCEDURE.md section 3.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createAuditStore, canonicalJson, eventHashInput, sha256, DEFAULT_AUDIT_DB
} = require('../src/lib/audit-store');

const DEFAULT_SCALES = [1000, 5000, 10000];
const DEFAULT_WINDOW = 1000;

const USAGE = `Measure cold audit-chain verification cost on throwaway ledgers.

  node tools/audit-verify-cost.js [--scales 1000,5000] [--window 1000] [--json]

  --scales <list>  comma-separated entry counts >= 2 (default: ${DEFAULT_SCALES.join(',')})
  --window <n>     bounded-cost model window      (default: ${DEFAULT_WINDOW})
  --keep           do not delete the built ledgers
  --json           machine-readable output
  --help

Building a ledger signs and verifies every entry, so large scales are slow:
budget roughly four seconds per thousand entries to build.

This never opens the canonical ledger, the projections, or the vault.
`;

function parseArgs(argv) {
  const options = { scales: DEFAULT_SCALES, window: DEFAULT_WINDOW, json: false, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { options.help = true; continue; }
    if (token === '--json') { options.json = true; continue; }
    if (token === '--keep') { options.keep = true; continue; }
    const value = argv[index + 1];
    if (token === '--scales') {
      if (!value) throw new Error('--scales needs a value');
      options.scales = value.split(',').map(part => {
        const parsed = Number(part.trim());
        if (!Number.isSafeInteger(parsed) || parsed < 2) throw new Error(`--scales entry "${part}" must be an integer of at least 2`);
        return parsed;
      });
      index += 1; continue;
    }
    if (token === '--window') {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('--window must be a positive integer');
      options.window = parsed; index += 1; continue;
    }
    throw new Error(`unknown argument "${token}"`);
  }
  return options;
}

/** A benchmark must never be the thing that touches the canonical ledger. */
function assertNotCanonical(file) {
  const resolved = path.resolve(file);
  if (resolved === path.resolve(DEFAULT_AUDIT_DB)) {
    throw new Error('refusing to operate on the canonical audit ledger');
  }
  if (process.env.TOOLSENABLED_AUDIT_DB && resolved === path.resolve(process.env.TOOLSENABLED_AUDIT_DB)) {
    throw new Error('refusing to operate on the configured audit ledger');
  }
  return resolved;
}

function throwawaySigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyId: `audit-ed25519-${crypto.createHash('sha256').update(spkiDer).digest('hex')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

function buildLedger(file, count, signer) {
  assertNotCanonical(file);
  const store = createAuditStore({ file });
  store.registerKey({
    keyId: signer.keyId, publicKeyPem: signer.publicKeyPem,
    algorithm: 'ed25519', createdAtMs: 1_700_000_000_000
  });
  let now = 1_700_000_000_000;
  for (let index = 1; index <= count; index += 1) {
    now += 1000;
    store.appendEvent({
      eventId: `audit-${crypto.randomUUID()}`, occurredAtMs: now, createdAtMs: now,
      event: {
        timestamp: new Date(now).toISOString(),
        action: 'controller.launch.record',
        target: `launch_${index.toString(16).padStart(12, '0')}`,
        details: `requestingActor=claude targetAgentId=luna tier=cheap model=unknown objectiveRef=Q27 seq=${index}`
      }
    }, signer);
  }
  store.close();
}

/**
 * Cost of verifying only the chain suffix after `witness`, rooted at the hash
 * that row already had. Mirrors the row checks AuditStore._verifySnapshot()
 * performs, so the two timings are comparable.
 */
function verifySuffix(db, witness) {
  const keyObjects = new Map(db.prepare('SELECT * FROM audit_keys').all()
    .map(row => [row.key_id, crypto.createPublicKey(row.public_key_pem)]));
  const anchorRow = db.prepare('SELECT event_hash FROM audit_events WHERE sequence = ?').get(witness.sequence);
  if (!anchorRow) return { valid: false, reason: 'witness-row-missing' };
  if (anchorRow.event_hash !== witness.eventHash) return { valid: false, reason: 'witness-hash-mismatch' };

  const rows = db.prepare('SELECT * FROM audit_events WHERE sequence > ? ORDER BY sequence').all(witness.sequence);
  if (rows.length === 0) return { valid: false, reason: 'empty-suffix', verifiedRows: 0 };
  let previousHash = witness.eventHash;
  let expectedSequence = witness.sequence + 1;
  for (const row of rows) {
    if (row.sequence !== expectedSequence) return { valid: false, reason: 'sequence-gap' };
    if (row.previous_hash !== previousHash) return { valid: false, reason: 'previous-hash' };
    if (canonicalJson(JSON.parse(row.event_json)) !== row.event_json) return { valid: false, reason: 'event-json-canonical' };
    const expectedHash = sha256(eventHashInput({
      sequence: row.sequence, eventId: row.event_id, occurredAtMs: row.occurred_at_ms,
      eventJson: row.event_json, previousHash: row.previous_hash, keyId: row.key_id, createdAtMs: row.created_at_ms
    }));
    if (row.event_hash !== expectedHash) return { valid: false, reason: 'event-hash' };
    if (!crypto.verify(null, Buffer.from(row.event_hash, 'hex'), keyObjects.get(row.key_id), Buffer.from(row.signature, 'base64'))) {
      return { valid: false, reason: 'signature' };
    }
    previousHash = row.event_hash;
    expectedSequence += 1;
  }
  return { valid: true, verifiedRows: rows.length };
}

function millisecondsSince(start) {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
}

function measure(file, window) {
  const store = createAuditStore({ file: assertNotCanonical(file), readonly: true });
  try {
    const coldStart = process.hrtime.bigint();
    const full = store.verify();
    const fullMs = millisecondsSince(coldStart);
    if (!full.valid || full.signaturesValid !== true) {
      throw new Error('full audit verification did not establish a valid signed chain');
    }
    if (!Number.isSafeInteger(full.entries) || full.entries < 1) {
      throw new Error('full audit verification scanned no entries');
    }

    const db = store._open();
    const head = db.prepare('SELECT sequence, event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1').get();
    const witnessSequence = Math.max(1, head.sequence - window);
    const witnessRow = db.prepare('SELECT sequence, event_hash FROM audit_events WHERE sequence = ?').get(witnessSequence);
    const witness = { sequence: witnessRow.sequence, eventHash: witnessRow.event_hash };

    const boundedStart = process.hrtime.bigint();
    const suffix = verifySuffix(db, witness);
    const boundedMs = millisecondsSince(boundedStart);
    if (!suffix.valid) {
      throw new Error(`bounded audit verification failed: ${suffix.reason || 'unknown reason'}`);
    }
    if (!Number.isSafeInteger(suffix.verifiedRows) || suffix.verifiedRows < 1) {
      throw new Error('bounded audit verification scanned no entries');
    }

    return {
      entries: full.entries, valid: full.valid, signaturesValid: full.signaturesValid === true,
      fullVerifyMs: fullMs, microsecondsPerEntry: Math.round((fullMs * 1000) / full.entries),
      boundedWindow: window, boundedVerifyMs: boundedMs,
      boundedRows: suffix.verifiedRows, boundedValid: suffix.valid,
      speedup: boundedMs > 0 ? Math.round((fullMs / boundedMs) * 10) / 10 : null
    };
  } finally {
    store.close();
  }
}

function render(rows, window) {
  const lines = [
    'Cold audit-chain verification cost (throwaway ledgers, fresh store, uncached)',
    '',
    '  entries   full verify   us/entry   ' + `bounded(${window})`.padEnd(16) + 'speedup',
    '  ' + '-'.repeat(68)
  ];
  for (const row of rows) {
    lines.push('  ' + [
      String(row.entries).padStart(7),
      `${row.fullVerifyMs} ms`.padStart(13),
      String(row.microsecondsPerEntry).padStart(10),
      `${row.boundedVerifyMs} ms`.padStart(14),
      `${row.speedup === null ? 'n/a' : `${row.speedup}x`}`.padStart(11)
    ].join('  '));
  }
  lines.push('');
  lines.push('  full verify grows with TOTAL history and is paid cold in every fresh');
  lines.push('  process, on the audit write path. The bounded column is a model of what');
  lines.push('  a windowed check would cost -- it is not what the product does today.');
  return lines.join('\n');
}

function main(argv) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { process.stderr.write(`${error.message}\n\n${USAGE}`); return 2; }
  if (options.help) { process.stdout.write(USAGE); return 0; }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-verify-cost-'));
  const signer = throwawaySigner();
  const rows = [];
  try {
    for (const scale of options.scales) {
      const file = path.join(directory, `ledger-${scale}.sqlite3`);
      if (!options.json) process.stderr.write(`building ${scale} entries...\n`);
      buildLedger(file, scale, signer);
      rows.push(measure(file, Math.min(options.window, scale - 1 > 0 ? scale - 1 : 1)));
    }
  } catch (error) {
    process.stderr.write(`audit-verify-cost: ${error && error.message ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (!options.keep) fs.rmSync(directory, { recursive: true, force: true });
    else process.stderr.write(`kept: ${directory}\n`);
  }

  if (options.json) process.stdout.write(`${JSON.stringify({ window: options.window, scales: rows }, null, 2)}\n`);
  else process.stdout.write(`${render(rows, options.window)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs, measure, buildLedger, verifySuffix, assertNotCanonical };
