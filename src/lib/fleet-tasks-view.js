'use strict';
const crypto = require('node:crypto');
const view = require('./fleet-read-view');
const OPEN = new Set(['queued', 'leased', 'running', 'expired', 'retry_wait', 'uncertain']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const STATUSES = new Set(['queued', 'leased', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled', 'uncertain']);
function validMetadata(row) {
  const integer = value => value === null || Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
  return STATUSES.has(row.status) && ['attempt', 'max_attempts', 'lease_expires_at_ms',
    'checkpoint_revision', 'created_at_ms', 'updated_at_ms', 'completed_at_ms',
    'available_at_ms', 'cancel_requested_at_ms'].every(key => integer(row[key]));
}

function machineView(options = {}) {
  view.validatePage(options);
  const { offset = 0, limit = 50, revision, all = false, id = null } = options;
  if (id !== null && (!ID.test(id) || id.length > 200)) throw view.fail('FLEET_TASK_ID_INVALID', 'Give a valid task id.');
  return view.withStateDb(db => {
    const rows = view.tableExists(db, 'tasks') ? db.prepare(`SELECT id, queue_name, task_type, status, attempt, max_attempts,
      lease_worker_label, lease_expires_at_ms, checkpoint_revision, error_code, error_message,
      created_at_ms, updated_at_ms, completed_at_ms, available_at_ms, cancel_requested_at_ms, cancel_reason
      FROM tasks ORDER BY updated_at_ms DESC, id DESC`).iterate() : [];
    const now = Date.now();
    const reported = row => row.lease_expires_at_ms !== null && row.lease_expires_at_ms <= now
      && (row.status === 'leased' || row.status === 'running')
      ? row.status === 'leased' ? 'expired' : 'uncertain' : row.status;
    const hash = crypto.createHash('sha256');
    const selected = [];
    let total = 0;
    for (const row of rows) {
      if (!validMetadata(row)) throw view.fail('FLEET_TASK_STORE_INVALID', 'A task has invalid status or numeric metadata.');
      hash.update(JSON.stringify([row, reported(row)])).update('\n');
      if (!(all || OPEN.has(reported(row))) || id && id !== row.id) continue;
      if (total >= offset && selected.length < limit) selected.push(row);
      total += 1;
    }
    // A pinned detail page can show payload, result and checkpoint history.
    // Include all of them in the snapshot before accepting a page revision.
    if (db && view.tableExists(db, 'tasks')) for (const row of db.prepare(
      'SELECT id, body_json, result_json, checkpoint_json FROM tasks ORDER BY id').iterate())
      hash.update(JSON.stringify(row)).update('\n');
    if (db && view.tableExists(db, 'task_checkpoints')) for (const row of db.prepare(
      'SELECT task_id, revision, checkpoint_json, created_at_ms FROM task_checkpoints ORDER BY task_id, revision').iterate())
      hash.update(JSON.stringify(row)).update('\n');
    const snapshot = hash.digest('hex');
    view.assertRevision(revision, snapshot);
    const records = selected.map(row => {
      const body = db.prepare('SELECT body_json, result_json, checkpoint_json FROM tasks WHERE id = ?').get(row.id);
      const parsed = JSON.parse(body.body_json);
      const payload = id ? view.bounded(body.body_json, 4000) : null;
      const result = id && body.result_json ? view.bounded(body.result_json, 4000) : null;
      const checkpoint = body.checkpoint_json ? view.bounded(body.checkpoint_json, 4000) : null;
      const history = id && view.tableExists(db, 'task_checkpoints')
        ? db.prepare('SELECT revision, checkpoint_json, created_at_ms FROM task_checkpoints WHERE task_id = ? ORDER BY revision DESC LIMIT 4').all(row.id)
        : [];
      const queue = view.bounded(row.queue_name, 64);
      const claimant = view.bounded(row.lease_worker_label, 100);
      const error = view.bounded(row.error_message, 1000);
      return {
        id: view.safe(row.id, 200), queue: queue.text, queueTruncated: queue.truncated,
        type: view.safe(row.task_type, 64),
        status: reported(row), storedStatus: row.status,
        leaseExpired: reported(row) !== row.status,
        title: typeof parsed.title === 'string' ? view.safe(parsed.title, 160) : null,
        claimant: claimant.text || null, claimantTruncated: claimant.truncated,
        lastActivityAtMs: row.lease_worker_label ? row.updated_at_ms : null,
        ageBasis: row.lease_worker_label ? 'last-task-activity; includes claims and checkpoints' : null,
        leaseExpiresAtMs: row.lease_expires_at_ms, attempt: row.attempt, maxAttempts: row.max_attempts,
        retryAtMs: row.status === 'retry_wait' ? row.available_at_ms : null,
        cancellation: row.cancel_requested_at_ms === null ? null : {
          requestedAtMs: row.cancel_requested_at_ms, reason: view.safe(row.cancel_reason, 1000)
        },
        payloadText: payload ? payload.text : null, payloadTruncated: payload ? payload.truncated : false,
        resultText: result ? result.text : null, resultTruncated: result ? result.truncated : false,
        checkpointRevision: row.checkpoint_revision, checkpoint: id && checkpoint ? checkpoint.text : null,
        checkpointTruncated: id && checkpoint ? checkpoint.truncated : false,
        checkpoints: history.map(item => {
          const text = view.bounded(item.checkpoint_json, 2000);
          return { revision: item.revision, text: text.text, truncated: text.truncated, createdAtMs: item.created_at_ms };
        }),
        checkpointsTruncated: id ? row.checkpoint_revision > history.length : false,
        error: row.error_code ? { code: view.safe(row.error_code, 200), message: error.text, messageTruncated: error.truncated } : null,
        createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms, completedAtMs: row.completed_at_ms
      };
    });
    return { schema: 'ai.toolsenabled/fleet-tasks/v1', revision: snapshot, view: all ? 'all' : 'open',
      records, total, offset, limit,
      nextOffset: offset + records.length < total ? offset + records.length : null,
      grantsAuthority: false };
  });
}
function format(page) {
  const lines = ['ToolsEnabled Fleet — Tasks', ''];
  if (!page.records.length) return [...lines, 'No tasks in this view.'];
  return [...lines, ...page.records.map(row => `${row.id}  ${row.status}  ${row.title || `${row.queue}/${row.type}`}${row.queueTruncated ? ' [truncated queue]' : ''}  ${row.claimant || 'unclaimed'}${row.claimantTruncated ? ' [truncated claimant]' : ''}${row.lastActivityAtMs === null ? '' : `  last activity ${new Date(row.lastActivityAtMs).toISOString()}`}${row.checkpointRevision ? `  checkpoint ${row.checkpointRevision}` : ''}`),
    ...(page.records.length === 1 && page.records[0].checkpoints.length ? [
      '', ...page.records[0].checkpoints.map(item => `Checkpoint ${item.revision}: ${item.text}${item.truncated ? ' [truncated]' : ''}`),
      ...(page.records[0].checkpointsTruncated ? ['Older checkpoints omitted.'] : [])
    ] : []),
    ...(page.records.length === 1 && page.records[0].payloadText ? ['', `Payload: ${page.records[0].payloadText}${page.records[0].payloadTruncated ? ' [truncated]' : ''}`] : []),
    ...(page.records.length === 1 && page.records[0].resultText ? [`Result: ${page.records[0].resultText}${page.records[0].resultTruncated ? ' [truncated]' : ''}`] : []),
    '', `${page.total} task(s)${page.nextOffset === null ? '' : '; more available with --json --offset'}`];
}
module.exports = Object.freeze({ machineView, format });
