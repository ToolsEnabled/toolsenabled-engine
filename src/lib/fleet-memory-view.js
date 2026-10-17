'use strict';
const crypto = require('node:crypto');
const view = require('./fleet-read-view');

const fold = text => String(text).normalize('NFKC').toUpperCase().toLowerCase();
const UNSAFE_SELECTOR = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u206f]/;
function machineView(options = {}) {
  view.validatePage(options);
  const { offset = 0, limit = 50, revision, namespace = null, query = null, key = null } = options;
  if (namespace !== null && (typeof namespace !== 'string' || !namespace || namespace.length > 100 || UNSAFE_SELECTOR.test(namespace)))
    throw view.fail('FLEET_MEMORY_SELECTOR_INVALID', 'Give a one-line namespace of 1 to 100 characters.');
  if (key !== null && (namespace === null || typeof key !== 'string' || !key || key.length > 200))
    throw view.fail('FLEET_MEMORY_SELECTOR_INVALID', 'A detail read needs a namespace and key.');
  if (query !== null && (typeof query !== 'string' || !query.trim() || query.length > 256 || UNSAFE_SELECTOR.test(query)))
    throw view.fail('FLEET_MEMORY_SELECTOR_INVALID', 'Give a one-line literal search of 1 to 256 characters.');
  return view.withStateDb(db => {
    const rows = view.tableExists(db, 'memory_entries') ? db.prepare(`SELECT namespace, entry_key, value_json, note, tags_json,
      revision, created_at_ms, updated_at_ms FROM memory_entries ORDER BY updated_at_ms DESC, namespace, entry_key`).iterate() : [];
    const sought = query === null ? null : fold(query);
    const hash = crypto.createHash('sha256');
    const counts = new Map();
    const selected = [];
    let total = 0;
    for (const row of rows) {
      if (!['revision', 'created_at_ms', 'updated_at_ms'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0))
        throw view.fail('FLEET_MEMORY_STORE_INVALID', 'A memory entry has invalid numeric metadata.');
      hash.update(JSON.stringify(row)).update('\n');
      counts.set(row.namespace, (counts.get(row.namespace) || 0) + 1);
      if ((namespace !== null && row.namespace !== namespace) || (key !== null && row.entry_key !== key)
        || (sought !== null && ![row.namespace, row.entry_key, row.note, row.tags_json, row.value_json]
          .some(value => fold(value ?? '').includes(sought)))) continue;
      if (total >= offset && selected.length < limit) selected.push(row);
      total += 1;
    }
    // Bind paging to the selected scope as well as the underlying entries.
    // A continuation that drops a namespace or query must fail closed.
    const snapshot = view.digest([hash.digest('hex'), namespace, query, key]);
    view.assertRevision(revision, snapshot);
    const namespacesAll = [...counts].sort(([left], [right]) => left.localeCompare(right));
    const namespaces = namespacesAll.slice(0, 100).map(([name, count]) => ({ name: view.safe(name, 100), count }));
    const records = selected.map(row => {
      const detail = key !== null;
      const value = detail ? view.bounded(row.value_json, 32768) : null;
      const note = detail ? view.bounded(row.note, 8192) : null;
      const tags = JSON.parse(row.tags_json);
      if (!Array.isArray(tags)) throw view.fail('FLEET_MEMORY_STORE_INVALID', 'A memory entry has invalid tags.');
      const tagsVisible = tags.slice(0, 100).map(tag => view.bounded(tag, 100));
      return { namespace: view.safe(row.namespace, 100), key: view.safe(row.entry_key, 200),
        note: detail ? note.text : view.safe(row.note, 240), noteTruncated: detail ? note.truncated : Boolean(row.note && row.note.length > 240),
        tags: tagsVisible.map(item => item.text), tagsTruncated: tags.length > tagsVisible.length || tagsVisible.some(item => item.truncated),
        valueText: detail ? value.text : null, valueTruncated: detail ? value.truncated : false,
        entryRevision: row.revision, createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms };
    });
    return { schema: 'ai.toolsenabled/fleet-memory/v1', revision: snapshot, view: key ? 'detail' : query ? 'search' : 'list',
      namespace: namespace === null ? null : view.safe(namespace, 100), query: query === null ? null : view.safe(query, 256), records, total, offset, limit,
      namespaces, namespacesTotal: namespacesAll.length, namespacesTruncated: namespacesAll.length > namespaces.length,
      nextOffset: offset + records.length < total ? offset + records.length : null, grantsAuthority: false };
  });
}
function format(page) {
  const lines = ['ToolsEnabled Fleet — Memory', ''];
  if (!page.records.length) return [...lines, 'No entries in this view.'];
  return [...lines, ...page.records.flatMap(row => [
    `${row.namespace}/${row.key}  rev ${row.entryRevision}  ${row.note || ''}${row.noteTruncated ? ' [truncated note]' : ''}`,
    ...(page.view === 'detail' ? [`Value: ${row.valueText}${row.valueTruncated ? ' [truncated]' : ''}`] : [])
  ]), '', `${page.total} entr${page.total === 1 ? 'y' : 'ies'}${page.nextOffset === null ? '' : '; more available with --json --offset'}`];
}
module.exports = Object.freeze({ machineView, format });
