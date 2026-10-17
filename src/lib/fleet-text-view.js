'use strict';
// One bounded, terminal-safe projection of the versioned read-only pages.
// Hook adapters and the CLI use this instead of re-reading private state.
const { safe } = require('./fleet-read-view');
const NAMES = new Set(['ledger', 'tasks', 'memory', 'audit', 'settings', 'status']);
const HOOK_SURFACES = new Set(['codex-hook', 'gemini-hook', 'cursor-hook', 'dsh', 'opencode']);

function options({ width = 100, surface = 'plain' } = {}) {
  const size = Number(width);
  if (!Number.isSafeInteger(size) || size < 40 || size > 240) throw new Error('--width must be from 40 to 240.');
  if (!['codex-hook', 'gemini-hook', 'cursor-hook', 'dsh', 'opencode', 'console', 'plain'].includes(surface))
    throw new Error('Unknown Fleet text surface.');
  return { width: size, surface };
}
function line(value, width) {
  const clean = safe(value, 8192).replace(/[\r\n\t]/g, ' ');
  const chars = Array.from(clean);
  return chars.length <= width ? clean : chars.slice(0, width - 1).join('') + '…';
}
function rowText(name, row) {
  if (name === 'ledger') return `${row.id}  ${row.status}  ${row.title}`;
  if (name === 'tasks') return `${row.id}  ${row.status}  ${row.title || `${row.queue}/${row.type}`}`;
  if (name === 'memory') return `${row.namespace}/${row.key}  ${row.note || ''}`;
  if (name === 'audit') return `${row.sequence}  ${row.action}  ${row.eventId}  ${row.eventText}`;
  if (name === 'settings') return `${row.id} = ${row.valueText}  (${row.provenance?.source || 'unknown'})`;
  throw new Error('Unknown Fleet row type.');
}
function quoteFilter(value, surface) {
  const text = safe(value, 256);
  if (surface === 'plain') return `'${text.replace(/'/g, "'\\''")}'`;
  return JSON.stringify(text);
}
function nextCommand(name, page, surface) {
  if (page.nextOffset === null || page.nextOffset === undefined) return null;
  if (surface === 'console') return 'n for next page';
  const stem = surface === 'codex-hook' ? `/fleet/${name}`
    : surface === 'gemini-hook' || surface === 'dsh' || surface === 'opencode' || surface === 'cursor-hook'
      ? `/fleet ${name}` : `toolsenabled ${name} --text`;
  const selectors = [];
  if (Number.isSafeInteger(page.limit)) selectors.push('--limit', String(page.limit));
  if (page.view === 'all' && (name === 'ledger' || name === 'tasks')) selectors.push('--all');
  if (name === 'memory') {
    if (page.namespace !== null && page.namespace !== undefined) selectors.push('--namespace', quoteFilter(page.namespace, surface));
    if (page.query !== null && page.query !== undefined) selectors.push('--query', quoteFilter(page.query, surface));
  }
  selectors.push('--offset', String(page.nextOffset));
  if (page.revision !== undefined) selectors.push('--revision', String(page.revision));
  return `more: ${stem} ${selectors.join(' ')}`;
}
function continuationLines(more, width) {
  const clean = safe(more, 8192).replace(/[\r\n\t]/g, ' ');
  if (Array.from(clean).length <= width) return [clean];
  const chars = Array.from(clean);
  const wrapped = ['Join wrapped parts exactly:'];
  let first = true;
  while (chars.length) {
    const prefix = first ? '' : '  ';
    wrapped.push(prefix + chars.splice(0, width - prefix.length).join(''));
    first = false;
  }
  return wrapped;
}
function render(name, page, requested = {}) {
  if (!NAMES.has(name) || !page || page.schema !== `ai.toolsenabled/fleet-${name}/v1`)
    throw new Error('Fleet text needs the matching versioned page.');
  const { width, surface } = options(requested);
  const records = Array.isArray(page.records) ? page.records : [];
  if (HOOK_SURFACES.has(surface) && records.length > 20) throw new Error('Hook text is limited to 20 rows.');
  const total = Number.isSafeInteger(page.total) ? page.total : 1;
  const offset = Number.isSafeInteger(page.offset) ? page.offset : 0;
  const count = name === 'status' ? 1 : records.length;
  const pages = Math.max(1, Math.ceil(total / Math.max(1, page.limit || 20)));
  const current = Math.min(pages, Math.floor(offset / Math.max(1, page.limit || 20)) + 1);
  // Every audit title carries its state unless a full verification passed.
  const auditState = name !== 'audit' || page.verification?.valid === true ? ''
    : page.verification?.valid === false ? ' (verification FAILED)'
      : page.verification?.reason === 'signed-head-invalid' ? ' (head signature invalid)' : ' (unverified)';
  const title = `Fleet · ${name[0].toUpperCase()}${name.slice(1)}${auditState} · ${count} shown of ${total} · page ${current}/${pages}`;
  // A verify page has no rows; its verdict is the result and is always shown.
  const verifyPage = name === 'audit' && page.action === 'verify';
  const projected = name === 'status'
    ? require('./fleet-status-view').format(page).slice(2)
    : verifyPage ? [`Verify: ${require('./fleet-audit-view').verdict(page)}`,
      ...(page.archive ? [`Archive: ${require('./fleet-audit-view').archiveVerdict(page)}`] : [])]
      : records.map(row => rowText(name, row));
  // Keep MCP/agent/last-error summaries if a full denial list would push the
  // otherwise finite status card past a hook surface's twenty-row budget.
  const rows = HOOK_SURFACES.has(surface) && projected.length > 20
    ? [...projected.slice(0, 17), ...projected.slice(-3)] : projected;
  const more = nextCommand(name, page, surface);
  const lines = [title, ...rows.length ? rows : ['Nothing in this view.'],
    `Snapshot ${page.revision === undefined ? 'unknown' : page.revision}`];
  return { title: line(title, width), text: [...lines.map(item => line(item, width)),
    ...(more ? continuationLines(more, width) : [])].join('\n'), more };
}
module.exports = Object.freeze({ render, options, HOOK_SURFACES });
