'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const NAMESPACE = 'agent.continuation.v1';
const MAX_PRUNE_ROWS = 100;
const MAX_SCAN_ROWS = 10000;
const MAX_RETAINED_BACKUPS = 8;
const STATUSES = new Set(['idle', 'ready', 'retry_wait', 'claimed', 'running', 'reconciling', 'uncertain', 'stopped', 'blocked']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function refuse(code, message) { throw Object.assign(new Error(message), { code }); }

// The host must supply ALL saved trees from durable storage. A partial load
// or a selected renderer tree cannot establish that a node no longer exists.
function treeIdentity(snapshot) {
  if (!snapshot || snapshot.complete !== true || snapshot.persistenceFailed !== false
    || typeof snapshot.revision !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.revision)
    || !Array.isArray(snapshot.nodes) || !snapshot.nodes.length
    || !Array.isArray(snapshot.trees) || !snapshot.trees.length) {
    refuse('CONTINUATION_PRUNE_TREES_UNAVAILABLE', 'Pruning requires a complete, readable, nonempty saved tree store.');
  }
  const trees = new Set(snapshot.trees.map(tree => tree?.id));
  const nodes = new Set();
  if (trees.size !== snapshot.trees.length || [...trees].some(id => typeof id !== 'string' || !id)) {
    refuse('CONTINUATION_PRUNE_TREES_UNAVAILABLE', 'The saved tree identities are invalid.');
  }
  for (const node of snapshot.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || !trees.has(node.treeId) || nodes.has(node.id)) {
      refuse('CONTINUATION_PRUNE_TREES_UNAVAILABLE', 'The saved node identities are invalid.');
    }
    nodes.add(node.id);
  }
  return { nodes, digest: hash(JSON.stringify({ revision: snapshot.revision, trees: [...trees].sort(),
    nodes: snapshot.nodes.map(node => [node.id, node.treeId]).sort((a, b) => a[0].localeCompare(b[0])) })) };
}
function rowsFrom(db) {
  const rows = db.prepare('SELECT * FROM memory_entries WHERE namespace = ? ORDER BY entry_key LIMIT ?').all(NAMESPACE, MAX_SCAN_ROWS + 1);
  if (rows.length > MAX_SCAN_ROWS) refuse('CONTINUATION_PRUNE_SCAN_LIMIT', `More than ${MAX_SCAN_ROWS} rows require a separate maintenance plan.`);
  for (const row of rows) {
    if (hash(row.value_json) !== row.value_hash) refuse('CONTINUATION_PRUNE_CORRUPT', 'A continuation failed its integrity check.');
    let value;
    try { value = JSON.parse(row.value_json); } catch { refuse('CONTINUATION_PRUNE_CORRUPT', 'A continuation could not be read.'); }
    if (value?.version !== 1 || !value.descriptor || !STATUSES.has(value.status) || !Number.isSafeInteger(row.revision) || row.revision < 1) {
      refuse('CONTINUATION_PRUNE_CORRUPT', 'A continuation has an unsupported schema.');
    }
    const keys = value.descriptor.requestKeys;
    if (keys != null && (typeof keys.threadId !== 'string' || !keys.threadId || !Array.isArray(keys.treeAnchors)
      || !keys.treeAnchors.length || keys.treeAnchors.length > 16 || keys.treeAnchors.some(id => typeof id !== 'string' || !id)
      || keys.treeAnchors.at(-1) !== keys.threadId)) {
      refuse('CONTINUATION_PRUNE_CORRUPT', 'A continuation has no exact tree identity.');
    }
    if (value.lease != null && (!Number.isSafeInteger(value.lease.untilMs) || value.lease.untilMs < 0)) {
      refuse('CONTINUATION_PRUNE_CORRUPT', 'A continuation lease could not be read.');
    }
  }
  return rows;
}
function planRows(rows, snapshot, { file, limit, now }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PRUNE_ROWS) {
    refuse('CONTINUATION_PRUNE_LIMIT', `Choose between 1 and ${MAX_PRUNE_ROWS} rows per explicit action.`);
  }
  const tree = treeIdentity(snapshot);
  const orphaned = rows.filter(row => {
    const value = JSON.parse(row.value_json);
    return value.descriptor.requestKeys && !tree.nodes.has(value.descriptor.requestKeys.threadId)
      && (value.lease == null || value.lease.untilMs <= now);
  });
  const selected = orphaned.slice(0, limit).map(row => ({ key: row.entry_key, revision: row.revision, hash: row.value_hash }));
  const scopeHash = hash(JSON.stringify({ file, limit, tree: tree.digest, rows, selected }));
  return { scopeHash, scanned: rows.length, eligible: orphaned.length, selected: selected.length,
    remaining: orphaned.length - selected.length, limit, rows: selected };
}

// Constructed by the native owner-action host, never by a load/migration hook.
// Tokens stay in this process and bind the completed backup and exact state.
function createContinuationPruner({ file, readTreeSnapshot, now = Date.now } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof readTreeSnapshot !== 'function') {
    refuse('CONTINUATION_PRUNE_CONFIGURATION', 'An explicit store and complete durable tree reader are required.');
  }
  const pending = new Map();
  let preparing = false;
  const tokenLifetimeMs = 10 * 60 * 1000;
  function open(readOnly) {
    if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
      refuse('CONTINUATION_PRUNE_FILE', 'The continuation database must be an existing regular file.');
    }
    const db = new DatabaseSync(file, { readOnly });
    db.exec('PRAGMA busy_timeout = 2000');
    return db;
  }
  function preview({ limit = MAX_PRUNE_ROWS } = {}) {
    const db = open(true);
    try { return planRows(rowsFrom(db), readTreeSnapshot(), { file, limit, now: now() }); }
    finally { db.close(); }
  }
  function sameState(scopeHash, limit) {
    if (typeof scopeHash !== 'string' || scopeHash !== preview({ limit }).scopeHash) {
      refuse('CONTINUATION_PRUNE_CHANGED', 'Saved state changed; review a new prune preview. Nothing was removed.');
    }
  }
  function verifyCopy(destination, scopeHash, limit) {
    let copied;
    try {
      copied = new DatabaseSync(destination, { readOnly: true });
      if (copied.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
        || planRows(rowsFrom(copied), readTreeSnapshot(), { file, limit, now: now() }).scopeHash !== scopeHash) {
        refuse('CONTINUATION_PRUNE_BACKUP_UNVERIFIED', 'The dated copy could not be verified. Nothing was removed.');
      }
    } catch (error) {
      if (String(error?.code || '').startsWith('CONTINUATION_PRUNE_')) throw error;
      refuse('CONTINUATION_PRUNE_BACKUP_UNVERIFIED', 'The dated copy could not be read or verified. Nothing was removed.');
    } finally { copied?.close(); }
  }
  async function prepare(options = {}) {
    if (preparing) refuse('CONTINUATION_PRUNE_PREVIEW_BUSY', 'Another dated-copy preview is in progress.');
    preparing = true;
    try { return await prepareCopy(options); } finally { preparing = false; }
  }
  async function prepareCopy({ limit = MAX_PRUNE_ROWS, scopeHash } = {}) {
    for (const [token, value] of pending) if (value.expires <= now()) pending.delete(token);
    if (pending.size >= 4) refuse('CONTINUATION_PRUNE_PREVIEW_LIMIT', 'Finish an existing preview or wait ten minutes before making another copy.');
    const planned = preview({ limit });
    if (scopeHash !== undefined && scopeHash !== planned.scopeHash) {
      refuse('CONTINUATION_PRUNE_CHANGED', 'Saved state changed; review a new prune preview.');
    }
    if (!planned.selected) return { ok: true, selected: 0, reason: 'no_eligible_orphans', remaining: 0 };
    // Copies are intentionally retained, including cancelled/expired previews.
    // Never silently prune backups. A finite disk budget survives app restarts.
    const prefix = path.basename(file) + '.before-prune-';
    const copies = fs.readdirSync(path.dirname(file)).filter(name => name.startsWith(prefix) && name.endsWith('.sqlite3'));
    if (copies.length >= MAX_RETAINED_BACKUPS) {
      refuse('CONTINUATION_PRUNE_BACKUP_LIMIT', `All ${MAX_RETAINED_BACKUPS} retained-copy slots are used. Review the saved copies before another preview; nothing was removed.`);
    }
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const destination = `${file}.before-prune-${stamp}-${crypto.randomUUID()}.sqlite3`;
    const source = open(true);
    try {
      if (planRows(rowsFrom(source), readTreeSnapshot(), { file, limit, now: now() }).scopeHash !== planned.scopeHash) {
        refuse('CONTINUATION_PRUNE_CHANGED', 'State changed before the dated copy. Nothing was removed.');
      }
      const fd = fs.openSync(destination, 'wx', 0o600);
      fs.closeSync(fd);
      // A SQLite backup includes committed WAL content; a raw file copy does not.
      await backup(source, destination);
    } finally { source.close(); }
    verifyCopy(destination, planned.scopeHash, limit);
    const fd = fs.openSync(destination, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    sameState(planned.scopeHash, limit);
    const token = crypto.randomBytes(32).toString('base64url');
    pending.set(token, { ...planned, backup: destination, expires: now() + tokenLifetimeMs });
    return { ok: true, token, scopeHash: planned.scopeHash, backup: destination,
      selected: planned.selected, remaining: planned.remaining, scanned: planned.scanned, limit };
  }
  async function confirm({ token } = {}, confirmOwner) {
    const planned = typeof token === 'string' ? pending.get(token) : null;
    if (!planned || planned.expires <= now()) {
      refuse('CONTINUATION_PRUNE_PREVIEW_REQUIRED', 'The preview is missing, used or expired. Nothing was removed.');
    }
    // Consume before awaiting the native dialog: concurrent confirmations must
    // not reuse it. Cancellation/failure requires a fresh preview and copy.
    pending.delete(token);
    if (typeof confirmOwner !== 'function') {
      refuse('CONTINUATION_PRUNE_CONFIRMATION_REQUIRED', 'Native owner confirmation is unavailable. Nothing was removed.');
    }
    const { scopeHash, limit, backup: destination } = planned;
    sameState(scopeHash, limit);
    verifyCopy(destination, scopeHash, limit);
    if (await confirmOwner(Object.freeze({ scopeHash, backup: destination, selected: planned.selected,
      remaining: planned.remaining, limit })) !== true) {
      refuse('CONTINUATION_PRUNE_CANCELLED', 'The owner did not confirm this removal. Nothing was removed.');
    }
    sameState(scopeHash, limit);
    verifyCopy(destination, scopeHash, limit);
    const db = open(false);
    try {
      db.exec('BEGIN IMMEDIATE');
      const current = planRows(rowsFrom(db), readTreeSnapshot(), { file, limit, now: now() });
      if (current.scopeHash !== scopeHash) refuse('CONTINUATION_PRUNE_CHANGED', 'State changed after confirmation. Nothing was removed.');
      const remove = db.prepare('DELETE FROM memory_entries WHERE namespace = ? AND entry_key = ? AND revision = ? AND value_hash = ?');
      for (const row of current.rows) {
        if (remove.run(NAMESPACE, row.key, row.revision, row.hash).changes !== 1) {
          refuse('CONTINUATION_PRUNE_CHANGED', 'A selected row changed. The prune was rolled back.');
        }
      }
      const after = rowsFrom(db);
      if (after.length !== current.scanned - current.selected
        || current.rows.some(row => after.some(value => value.entry_key === row.key))) {
        refuse('CONTINUATION_PRUNE_VERIFY_FAILED', 'Removal verification failed. The prune was rolled back.');
      }
      db.exec('COMMIT');
      return { ok: true, removed: current.selected, remaining: current.remaining, backup: destination };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Retain the original refusal. */ }
      throw error;
    } finally { db.close(); }
  }
  return Object.freeze({ preview, prepare, confirm });
}
module.exports = { createContinuationPruner, treeIdentity, planRows, MAX_PRUNE_ROWS, MAX_SCAN_ROWS, MAX_RETAINED_BACKUPS };
