'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const view = require('./fleet-read-view');
const { resolveStateRoot } = require('./runtime-state-root');

function cachedSignedHead(inspected, head) {
  if (!head) return null;
  try {
    const store = require('./audit-store');
    const key = inspected.getKey(head.keyId);
    if (!key || key.algorithm !== 'ed25519') return null;
    const checkedKey = store.publicKeyHash(key.publicKeyPem);
    if (checkedKey.hash !== key.publicKeyHash) return null;
    // The full verifier's key-identity rule: a key row claiming the derived id
    // must be that material, or swapped material could sign a forged head.
    if (String(head.keyId).startsWith('audit-ed25519-') && head.keyId !== `audit-ed25519-${checkedKey.hash}`) return null;
    const eventJson = store.canonicalJson(head.event);
    const eventHash = store.sha256(store.eventHashInput({ ...head, eventJson }));
    if (eventHash !== head.eventHash) return null;
    if (!crypto.verify(null, Buffer.from(eventHash, 'hex'), checkedKey.key, Buffer.from(head.signature, 'base64'))) return null;
    return { sequence: head.sequence, eventHash: head.eventHash, keyId: head.keyId,
      signedAtMs: head.createdAtMs };
  } catch { return null; }
}

function projectEvent(event) {
  const body = event.event || {};
  const clipped = Object.fromEntries(['timestamp', 'actor', 'action', 'target', 'outcome'].map(name =>
    [name, view.bounded(body[name] ?? '', name === 'target' ? 500 : 160)]));
  const visible = Object.fromEntries(Object.entries(clipped).map(([name, value]) => [name, value.text]));
  return { sequence: event.sequence, eventId: view.safe(event.eventId, 200),
    occurredAtMs: event.occurredAtMs, keyId: view.safe(event.keyId, 200), eventHash: event.eventHash,
    ...visible, truncated: Object.values(clipped).some(value => value.truncated),
    eventText: JSON.stringify(visible) };
}

function machineView(options = {}) {
  view.validatePage(options);
  const { offset = 0, limit = 50, revision, verify = false, includeArchive = false } = options;
  const selected = process.env.TOOLSENABLED_AUDIT_DB || path.join(resolveStateRoot().root, 'state', 'audit.sqlite3');
  if (!path.isAbsolute(selected)) throw view.fail('FLEET_AUDIT_PATH_INVALID', 'The audit database path must be absolute.');
  view.assertDirectPath(selected);
  let stat;
  try { stat = fs.lstatSync(selected); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const emptyRevision = view.digest([]);
    view.assertRevision(revision, emptyRevision);
    return { schema: 'ai.toolsenabled/fleet-audit/v1', revision: emptyRevision, action: verify ? 'verify' : 'tail',
      records: [], total: 0, offset, limit, nextOffset: null,
      verification: { valid: null, reason: 'not-initialized', entries: 0,
        scope: includeArchive ? 'read-only-ledger-projections-and-archive' : 'read-only-ledger-and-projections',
        anchorChecked: false, fresh: false }, archive: null, grantsAuthority: false };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw view.fail('FLEET_AUDIT_STORE_INVALID', 'The audit database is not a non-empty direct regular file.');
  const { withReadOnlyLedger } = require('./audit-store');
  const readLedger = callback => {
    try { return withReadOnlyLedger(selected, callback, { scratchRoot: os.tmpdir(), maxCopyBytes: 64 * 1024 * 1024 }); }
    catch (error) { throw error && error.code === 'AUDIT_VIEW_COPY_TOO_LARGE' ? view.tooLarge('The Fleet audit log', '64 MiB') : error; }
  };
  return readLedger(inspected => {
    if (!verify) {
      const tail = inspected.tailPage({ offset, limit });
      const cachedHead = cachedSignedHead(inspected, tail.head);
      const snapshot = view.digest([tail.total, tail.head?.sequence || 0, tail.head?.eventHash || null,
        tail.head?.signature || null, cachedHead]);
      view.assertRevision(revision, snapshot);
      return { schema: 'ai.toolsenabled/fleet-audit/v1', revision: snapshot, action: 'tail',
        records: tail.events.map(projectEvent), total: tail.total, offset, limit,
        nextOffset: offset + tail.events.length < tail.total ? offset + tail.events.length : null,
        verification: { valid: null, reason: tail.head && !cachedHead ? 'signed-head-invalid' : 'not-verified', entries: null,
          scope: 'signed-head-only;full-chain-not-checked', anchorChecked: false, fresh: false,
          cachedHead },
        archive: null, grantsAuthority: false };
    }
    const root = resolveStateRoot().root;
    const audit = require('./audit');
    const rawBoundary = inspected.getMetadata(audit.ARCHIVE_BOUNDARY_METADATA_KEY)?.value || null;
    const signer = rawBoundary?.keyId ? inspected.getKey(rawBoundary.keyId) : null;
    const boundary = rawBoundary ? audit.verifiedArchiveBoundary(rawBoundary, signer) : null;
    const boundaryInvalid = Boolean(rawBoundary && !boundary);
    const checked = inspected.verify(boundary);
    const all = checked.verification.valid && !boundaryInvalid ? checked.events : [];
    const file = (name, fallback) => {
      const override = process.env[name];
      if (override && !path.isAbsolute(override)) throw view.fail('FLEET_AUDIT_PATH_INVALID', `${name} must be absolute.`);
      return override || path.join(root, fallback);
    };
    let projectionsValid = false;
    let projectionReason = 'projection-divergence';
    if (checked.verification.valid) {
      try {
        projectionsValid = audit.verifyReadOnlyProjections(all, {
          jsonl: file('TOOLSENABLED_AUDIT_JSONL_PATH', 'logs/actions.jsonl'),
          text: file('TOOLSENABLED_AUDIT_TEXT_PATH', 'logs/actions.log'),
          emergency: file('TOOLSENABLED_AUDIT_EMERGENCY_PATH', 'logs/audit-emergency.jsonl')
        });
      } catch { projectionReason = 'projection-unreadable'; }
    }
    let archive = null;
    if (includeArchive) {
      const archiveFile = path.join(root, 'state', audit.ARCHIVE_FILE_NAME);
      let archiveStat;
      try { archiveStat = fs.lstatSync(archiveFile); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (archiveStat && (!archiveStat.isFile() || archiveStat.isSymbolicLink()))
        archive = { valid: false, reason: 'archive-not-regular', entries: 0, boundaryMatches: false };
      else if (archiveStat && archiveStat.size > 16 * 1024 * 1024)
        archive = { valid: null, reason: 'not-checked-size-limit', entries: null, boundaryMatches: null };
      else {
        try {
          const verified = audit.verifyArchiveSegment(archiveFile, inspected.listKeys());
          const boundaryMatches = verified.valid && (boundary
            ? verified.tailHash === boundary.eventHash && verified.tailSequence === boundary.archivedThroughSequence
            : verified.tailSequence === 0);
          archive = { valid: verified.valid && boundaryMatches, reason: !verified.valid ? verified.reason : boundaryMatches ? null : 'archive-boundary-mismatch',
            entries: verified.entries, boundaryMatches };
        } catch { archive = { valid: false, reason: 'archive-unreadable', entries: 0, boundaryMatches: false }; }
      }
    }
    const snapshot = view.digest([all.map(event => [event.sequence, event.eventHash]),
      checked.verification, boundaryInvalid, projectionsValid, projectionReason, archive]);
    view.assertRevision(revision, snapshot);
    const recent = all.slice().reverse();
    const records = verify ? [] : recent.slice(offset, offset + limit).map(projectEvent);
    const total = verify ? 0 : recent.length;
    return { schema: 'ai.toolsenabled/fleet-audit/v1', revision: snapshot, action: verify ? 'verify' : 'tail',
      records, total, offset, limit, nextOffset: offset + records.length < total ? offset + records.length : null,
      archive,
      verification: {
        valid: checked.verification.valid && !boundaryInvalid && projectionsValid && (!archive || archive.valid !== false),
        scope: includeArchive && archive?.valid === null ? 'read-only-ledger-and-projections;archive-not-checked'
          : includeArchive ? 'read-only-ledger-projections-and-archive' : 'read-only-ledger-and-projections', anchorChecked: false,
        fresh: true,
        reason: view.safe(checked.verification.reason || (boundaryInvalid ? 'archive-boundary-invalid' : null)
          || (projectionsValid ? null : projectionReason) || (archive?.valid === false ? archive.reason : null), 160) || null,
        entries: checked.verification.entries, headSequence: checked.verification.headSequence || 0,
        signaturesValid: checked.verification.signaturesValid === true
      }, grantsAuthority: false };
  });
}
// One verdict wording for the human page and every text surface.
function verdict(page) {
  const verification = page.verification || {};
  return verification.valid === true ? 'ledger and projections valid (anchor not checked)'
    : verification.valid === false ? `FAILED (${verification.reason || 'unknown'})`
      : verification.cachedHead
        ? `cached signed head ${verification.cachedHead.sequence}; full chain not checked (run audit verify)`
        : verification.reason === 'signed-head-invalid' ? 'head signature INVALID; full chain not checked (run audit verify)'
          : verification.reason === 'not-verified' || !verification.reason ? 'not run; use audit verify' : verification.reason;
}
function archiveVerdict(page) {
  if (!page.archive) return 'not checked';
  return page.archive.valid === null ? 'not checked (size limit)' : page.archive.valid ? 'valid' : `FAILED (${page.archive.reason})`;
}
function format(page) {
  const lines = ['ToolsEnabled Fleet — Audit', '',
    `Verify: ${verdict(page)}`,
    `Scope: ${page.verification.scope || 'not initialized'}; archive ${archiveVerdict(page)}`];
  if (page.action === 'verify') return lines;
  if (!page.records.length) return [...lines, '', 'No audit events in this view.'];
  return [...lines, '', ...page.records.map(row => `${row.sequence}  ${row.action}  ${row.eventId}  ${row.eventText}${row.truncated ? ' [truncated]' : ''}`),
    // A cached signed head is not a chain check; only a full verification may say "verified".
    '', page.verification.valid === true ? `${page.total} verified event(s)` : `${page.total} event(s), not verified`];
}
module.exports = Object.freeze({ machineView, format, projectEvent, verdict, archiveVerdict });
