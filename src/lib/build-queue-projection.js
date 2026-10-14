'use strict';

// Local, dependency-free projection of BUILD-QUEUE.md.
//
// Q33/Q50's writer used to import parseQueuePhases from the sibling
// AgentActivityVisualizer repository.  That made the writer impossible to
// load on a clean ToolsEnabled checkout and turned a cross-repo path into an
// undocumented runtime dependency.  This module is intentionally a reader
// only: it preserves the phase body and classifies the display status, while
// the strict grammar/CAS checks remain owned by build-queue-writer.js.

const STATUSES = Object.freeze(['DONE', 'BLOCKED', 'IN-PROGRESS', 'PARTIAL', 'OPEN', 'UNKNOWN']);
const STATUS_ORDER = Object.freeze(['IN-PROGRESS', 'BLOCKED', 'PARTIAL', 'DONE', 'OPEN']);
const PHASE_HEADING = /^##\s+(Q\d{1,3})(?:\s+(.+?))?\s*$/;
const STATUS_LINE = /^\*\*Status:\*\*\s*(.*)$/;

function normalizeTitle(value) {
  const title = String(value || '').trim();
  // Accept the canonical em dash, the legacy hyphen, and the mojibake form
  // present in a few historical files.  The projection never rewrites the
  // body; this only keeps the display title stable.
  return title
    .replace(/^(?:[-\u2013\u2014]|â€“|â€”|\u00e2\u0080\u0093|\u00e2\u0080\u0094)\s*/, '')
    .trim();
}

function classifyStatus(value) {
  const text = String(value || '').trim().toUpperCase();
  for (const status of STATUS_ORDER) {
    if (text === status || text.startsWith(`${status} `)
      || text.startsWith(`${status}(`) || text.startsWith(`${status}:`)
      || text.startsWith(`${status}-`) || text.startsWith(`${status}\t`)) {
      return status;
    }
  }
  return 'UNKNOWN';
}

function parseQueuePhases(markdown) {
  if (typeof markdown !== 'string') {
    throw new TypeError('BUILD-QUEUE projection input must be a string.');
  }
  const text = markdown;
  const lines = [];
  const linePattern = /([^\r\n]*)(\r\n|\n|$)/g;
  let lineMatch;
  while ((lineMatch = linePattern.exec(text)) !== null) {
    lines.push({
      text: lineMatch[1],
      start: lineMatch.index,
      end: lineMatch.index + lineMatch[0].length
    });
    if (lineMatch[0].length === 0) break;
  }
  const phases = [];
  let current = null;

  const close = endLine => {
    if (!current) return;
    const end = endLine < lines.length ? lines[endLine].start : text.length;
    const body = text.slice(current.start, end).replace(/(?:\r\n|\n)+$/, '');
    phases.push(Object.freeze({
      id: current.id,
      number: current.number,
      title: current.title,
      status: current.status,
      statusRaw: current.statusRaw,
      body,
      detail: body,
      headingLine: current.headingLine,
      statusLine: current.statusLine
    }));
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].text;
    if (line.startsWith('## ')) {
      close(index);
      const heading = PHASE_HEADING.exec(line);
      if (!heading) continue;
      current = {
        id: heading[1],
        number: Number.parseInt(heading[1].slice(1), 10),
        title: normalizeTitle(heading[2]),
        status: 'UNKNOWN',
        statusRaw: null,
        headingLine: index,
        statusLine: null,
        start: lines[index].start
      };
      continue;
    }
    if (!current || current.statusLine !== null) continue;
    const status = STATUS_LINE.exec(line);
    if (status) {
      current.statusLine = index;
      current.statusRaw = status[1].trim();
      current.status = classifyStatus(status[1]);
    }
  }
  close(lines.length);
  return phases;
}

module.exports = Object.freeze({ STATUSES, classifyStatus, parseQueuePhases });
